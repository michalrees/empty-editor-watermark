/**
 * 注入器（纯函数，不依赖 vscode 模块 —— 便于单测）
 *
 * 背景：VS Code **没有**任何公开 API 能给工作台注入 CSS（1.138 自带的 vscode.d.ts
 * 里搜不到 css/inject/workbench 相关 API）。所有做背景图/水印效果的方式都一样：
 * 直接往安装目录里的 workbench.html 写一段 <style>。本扩展自己干这件事，
 * 于是不再需要 be5invis.vscode-custom-css，也不需要把 CSS 文件复制到别处。
 */

/** 注入块的开始/结束标记；重复注入时靠它做替换，不会越注越多 */
export const MARK_BEGIN = '<!-- EMPTY-EDITOR-WATERMARK:START -->';
export const MARK_END = '<!-- EMPTY-EDITOR-WATERMARK:END -->';

export type ImageFit = 'cover' | 'contain';
export type WatermarkPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';

export interface WatermarkOptions {
  /** 已经是 vscode-file://vscode-app/ 形式的 URL（见 toVscodeFileUrl） */
  imageUrl: string;
  imageFit: ImageFit;
  opacity: number;
  position: WatermarkPosition;
  scale: number;
  hideLogo: boolean;
  hideCommands: boolean;
  panelWidth: number;
  panelFontSize: number;
  frostedPanel: boolean;
}

/**
 * 把本机绝对路径转成 workbench 里能加载的 URL。
 *
 * VS Code 1.51.1 起渲染进程对 file 协议有访问限制：写 file:/// 会被**静默拦掉**
 * （图片不显示也不报错）。可用的是 vscode-file://vscode-app/：
 *   E:\Windows\Picture\Picture\linux.jpg
 *     → vscode-file://vscode-app/e%3A/Windows/Picture/Picture/linux.jpg
 * 规则：盘符小写、冒号写 %3A、其余用正斜杠（空格等按 URI 组件编码）。
 */
export function toVscodeFileUrl(fsPath: string): string {
  const p = String(fsPath ?? '').replace(/\\/g, '/');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (!m) {
    // UNC / POSIX 路径：没有盘符，退化成整体编码（是否能加载取决于 VS Code 版本）
    return 'vscode-file://vscode-app/' + p.split('/').map(encodeURIComponent).join('/');
  }
  const drive = m[1].toLowerCase() + '%3A';
  const rest = m[2] ?? '';
  return 'vscode-file://vscode-app/' + drive + rest.split('/').map(encodeURIComponent).join('/');
}

/** 位置 → 绝对定位的四条边 + transform-origin */
function placement(position: WatermarkPosition): { edges: string; origin: string; centered: boolean } {
  switch (position) {
    case 'top-left':
      return { edges: 'left: 0;\n    top: 0;\n    right: auto;\n    bottom: auto;', origin: '0% 0%', centered: false };
    case 'bottom-right':
      return { edges: 'right: 0;\n    bottom: 0;\n    left: auto;\n    top: auto;', origin: '100% 100%', centered: false };
    case 'bottom-left':
      return { edges: 'left: 0;\n    bottom: 0;\n    right: auto;\n    top: auto;', origin: '0% 100%', centered: false };
    case 'center':
      return { edges: '', origin: '50% 50%', centered: true };
    case 'top-right':
    default:
      return { edges: 'right: 0;\n    top: 0;\n    left: auto;\n    bottom: auto;', origin: '100% 0%', centered: false };
  }
}

/** 生成注入用的 CSS。数值全部来自配置，改配置后重新注入即可改效果。 */
export function buildCss(o: WatermarkOptions): string {
  const p = placement(o.position);
  const fit = o.imageFit === 'contain' ? 'contain' : 'cover';
  const opacity = Number.isFinite(o.opacity) ? Math.min(1, Math.max(0, o.opacity)) : 0.9;
  const scale = Number.isFinite(o.scale) && o.scale > 0 ? o.scale : 0.48;
  const width = Number.isFinite(o.panelWidth) && o.panelWidth > 0 ? o.panelWidth : 261;
  const fontSize = Number.isFinite(o.panelFontSize) && o.panelFontSize > 0 ? o.panelFontSize : 19;

  const parts: string[] = [];

  parts.push(`/* Empty Editor Watermark — 由扩展生成，请勿手改本段（改设置或卸载即可） */`);

  // 1) 图片层：独立伪元素，透明度只作用于图片本身，不影响上方文字
  parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper {
    position: relative;
    isolation: isolate;   /* 让 ::before 的 z-index:-1 留在本容器内 */
}

.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("${o.imageUrl}");
    background-repeat: no-repeat;
    background-position: center center;
    background-size: ${fit};
    opacity: ${opacity};
    pointer-events: none;   /* 不拦鼠标，命令仍可点 */
    z-index: -1;            /* 必须为负，否则被上层不透明面板盖住 */
}`);

  // 2) 内容层提到图片之上
  parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper > .editor-group-watermark,
.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper > .editor-group-watermark-toolbar-container {
    position: relative;
    z-index: 1;
}`);

  // 3) 按需隐藏 VS logo / 快捷键命令列表（只保留底图时两个都开）
  if (o.hideLogo) {
    parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper
.editor-group-watermark .letterpress {
    display: none !important;   /* VS logo */
}`);
  }
  if (o.hideCommands) {
    parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper
.editor-group-watermark .shortcuts {
    display: none !important;   /* 快捷键命令列表 */
}`);
  }

  // 4) 整块位置与缩放（logo/命令恢复显示时才有视觉意义）
  const posRule = p.centered
    ? `    position: static;
    margin: auto;
    transform: none;`
    : `    position: absolute;
    ${p.edges}
    height: auto;               /* 必须收缩到内容高度，否则垂直方向仍是居中 */
    transform-origin: ${p.origin};
    transform: scale(${scale});
    width: ${width}px;
    max-width: ${width}px;
    box-sizing: border-box;`;

  parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper > .editor-group-watermark {
${posRule}
}`);

  // 5) 窄窗口保护：退回居中，避免压到别的内容
  if (!p.centered) {
    parts.push(`@media (max-width: 900px) {
    .monaco-workbench .part.editor > .content
    .editor-group-container > .editor-group-watermark-wrapper > .editor-group-watermark {
        position: static;
        margin: auto;
        transform: none;
    }
}`);
  }

  // 6) 命令面板容器：字号/内边距/（可选）磨砂底
  const panelExtra = o.frostedPanel
    ? `    background-color: rgba(250, 249, 246, 0.55);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    border-radius: 10px;
`
    : '';
  parts.push(`.monaco-workbench .part.editor > .content
.editor-group-container > .editor-group-watermark-wrapper
> .editor-group-watermark > .watermark-container {
${panelExtra}    font-size: ${fontSize}px;
    padding: 14px 22px;
    max-height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
}`);

  return parts.join('\n\n') + '\n';
}

/** 把 CSS 包成带标记的注入块 */
export function buildBlock(css: string): string {
  return `${MARK_BEGIN}\n<style>\n${css}</style>\n${MARK_END}`;
}

/** 当前 HTML 里是否已有本扩展的注入块 */
export function hasBlock(html: string): boolean {
  return html.indexOf(MARK_BEGIN) >= 0 && html.indexOf(MARK_END) > html.indexOf(MARK_BEGIN);
}

/** 取出已注入的块内容（没有则返回 null） */
export function extractBlock(html: string): string | null {
  const s = html.indexOf(MARK_BEGIN);
  if (s < 0) {
    return null;
  }
  const e = html.indexOf(MARK_END, s);
  if (e < 0) {
    return null;
  }
  return html.slice(s, e + MARK_END.length);
}

/**
 * 写入/更新注入块。
 * 已有标记 → 原地替换（反复注入不会累积）；否则插到 </html> 之前
 * （文档顺序最后 = 同等特异性下压过其它注入的样式，迁移期不与 be5invis 打架）。
 */
export function patchHtml(html: string, block: string): { html: string; changed: boolean } {
  const s = html.indexOf(MARK_BEGIN);
  if (s >= 0) {
    const e = html.indexOf(MARK_END, s);
    if (e >= 0) {
      const next = html.slice(0, s) + block + html.slice(e + MARK_END.length);
      return { html: next, changed: next !== html };
    }
  }
  const idx = html.lastIndexOf('</html>');
  const next = idx >= 0 ? `${html.slice(0, idx)}${block}\n${html.slice(idx)}` : `${html}\n${block}\n`;
  return { html: next, changed: next !== html };
}

/** 移除注入块（连同它前后的空行），其余注入（be5invis 等）保持原样 */
export function stripBlock(html: string): { html: string; removed: boolean } {
  const s = html.indexOf(MARK_BEGIN);
  if (s < 0) {
    return { html, removed: false };
  }
  const e = html.indexOf(MARK_END, s);
  if (e < 0) {
    return { html, removed: false };
  }
  let start = s;
  while (start > 0 && (html[start - 1] === '\n' || html[start - 1] === '\r')) {
    start--;
  }
  const next = html.slice(0, start) + html.slice(e + MARK_END.length);
  return { html: next, removed: true };
}
