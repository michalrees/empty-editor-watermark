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

/** 「安装似乎损坏」提示的隐藏块；与底图块分开，便于单独开关 */
export const NOTICE_MARK_BEGIN = '<!-- EMPTY-EDITOR-WATERMARK-NOTICE:START -->';
export const NOTICE_MARK_END = '<!-- EMPTY-EDITOR-WATERMARK-NOTICE:END -->';

/** 一组标记 */
export interface Markers {
  begin: string;
  end: string;
}

export const WATERMARK_MARKERS: Markers = { begin: MARK_BEGIN, end: MARK_END };
export const NOTICE_MARKERS: Markers = { begin: NOTICE_MARK_BEGIN, end: NOTICE_MARK_END };
/** 清理时按这个顺序把两块都剥掉 */
export const ALL_MARKERS: readonly Markers[] = [WATERMARK_MARKERS, NOTICE_MARKERS];

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
export function buildBlock(css: string, markers: Markers = WATERMARK_MARKERS): string {
  return `${markers.begin}\n<style>\n${css}</style>\n${markers.end}`;
}

/** 当前 HTML 里是否已有指定标记的注入块 */
export function hasBlock(html: string, markers: Markers = WATERMARK_MARKERS): boolean {
  return html.indexOf(markers.begin) >= 0 && html.indexOf(markers.end) > html.indexOf(markers.begin);
}

/** 取出已注入的块内容（没有则返回 null） */
export function extractBlock(html: string, markers: Markers = WATERMARK_MARKERS): string | null {
  const s = html.indexOf(markers.begin);
  if (s < 0) {
    return null;
  }
  const e = html.indexOf(markers.end, s);
  if (e < 0) {
    return null;
  }
  return html.slice(s, e + markers.end.length);
}

function insertBeforeHtmlEnd(html: string, block: string): string {
  const idx = html.lastIndexOf('</html>');
  return idx >= 0 ? `${html.slice(0, idx)}${block}\n${html.slice(idx)}` : `${html}\n${block}\n`;
}

/**
 * 写入/更新注入块。
 * 已有标记 → 原地替换（反复注入不会累积）；否则插到 </html> 之前
 * （文档顺序最后 = 同等特异性下压过其它注入的样式，迁移期不与 be5invis 打架）。
 */
export function patchHtml(
  html: string,
  block: string,
  markers: Markers = WATERMARK_MARKERS
): { html: string; changed: boolean } {
  const s = html.indexOf(markers.begin);
  if (s >= 0) {
    const e = html.indexOf(markers.end, s);
    if (e >= 0) {
      const next = html.slice(0, s) + block + html.slice(e + markers.end.length);
      return { html: next, changed: next !== html };
    }
  }
  return { html: insertBeforeHtmlEnd(html, block), changed: true };
}

/** 移除注入块（连同它前面被我们插进去的换行），其余注入（be5invis 等）保持原样 */
export function stripBlock(html: string, markers: Markers = WATERMARK_MARKERS): { html: string; removed: boolean } {
  const s = html.indexOf(markers.begin);
  if (s < 0) {
    return { html, removed: false };
  }
  const e = html.indexOf(markers.end, s);
  if (e < 0) {
    return { html, removed: false };
  }
  let start = s;
  while (start > 0 && (html[start - 1] === '\n' || html[start - 1] === '\r')) {
    start--;
  }
  const next = html.slice(0, start) + html.slice(e + markers.end.length);
  return { html: next, removed: true };
}

export interface BlockSpec {
  block: string;
  markers: Markers;
}

/**
 * 把 HTML 变成"它应该是的样子"：先剥掉所有属于本扩展的块，再把启用的块按顺序插回 `</html>` 之前。
 *
 * 这样"开关任意一块"（包括 hideCorruptNotice 的切换）都只需要一次写盘，
 * 而且反复调用是**字节稳定**的：同一个输入永远得到同一个输出，不会每次启动都改写文件。
 */
export function applyBlocks(html: string, blocks: readonly BlockSpec[]): { html: string; changed: boolean } {
  let next = html;
  for (const markers of ALL_MARKERS) {
    next = stripBlock(next, markers).html;
  }
  for (const spec of blocks) {
    next = insertBeforeHtmlEnd(next, spec.block);
  }
  return { html: next, changed: next !== html };
}

/**
 * 「安装似乎损坏」提示的文案。
 *
 * 为什么会有这条提示：VS Code 1.9x 起，workbench 的 IntegrityService 会在启动时读
 * product.json 的 `checksums`，把列出的核心文件逐个做 SHA256 校验
 * （`vs/code/electron-browser/workbench/workbench.html` 就在列表里），只要有一个对不上就弹
 * 「Your Code installation appears to be corrupt. Please reinstall.」。
 * 而本扩展的工作方式就是改这个文件，所以**必然**会触发它。
 *
 * 我们是按用户明确意图改的文件，这条提示只会让人以为 VS Code 坏了，所以直接隐藏掉。
 * 匹配方式：通知元素上的 aria-label 就是本地化后的消息文本，只能按子串匹配
 * （提示里的「More Information」按钮是 `run()` 动作、不是链接，URL 不会出现在 DOM 里）。
 * 目前覆盖 15 种语言/伪本地化；VS Code 改文案时按需补充即可。
 */
export const CORRUPT_NOTICE_TEXTS: readonly string[] = [
  // English
  'installation appears to be corrupt. Please reinstall.',
  // 简体中文
  '安装似乎损坏。请重新安装。',
  // 繁體中文
  '安裝似乎已損毀。請重新安裝。',
  // 日本語
  'インストールが壊れている可能性があります。再インストールしてください。',
  // 한국어
  '설치가 손상된 것 같습니다. 다시 설치하세요.',
  // Deutsch
  'Installation ist offenbar beschädigt. Führen Sie eine Neuinstallation durch.',
  // Français
  'semble être endommagée. Effectuez une réinstallation.',
  // Español
  'parece estar dañada. Vuelva a instalar.',
  // Italiano
  'sembra danneggiata. Reinstallare.',
  // Português (Brasil)
  'parece estar corrompida. Reinstale-o.',
  // Русский
  'повреждена. Повторите установку.',
  // Polski
  'prawdopodobnie jest uszkodzona. Spróbuj zainstalować ponownie.',
  // Čeština
  'je pravděpodobně poškozená. Proveďte prosím přeinstalaci.',
  // Türkçe
  'yüklemeniz bozuk gibi görünüyor. Lütfen yeniden yükleyin.',
  // 伪本地化（VS Code 的 pseudo-localization 构建）
  'ïñstællætïøñ æppëærs tø þë çørrµpt. Plëæsë rëïñstæll.'
];

/** 可能承载通知/通知列表项的容器（toast 与通知中心都盖上，避免从铃铛里漏出来） */
const NOTICE_TARGETS = [
  '.notification-toast-container',
  '.notification-toast',
  '.notifications-list-container .notification-list-item',
  '.notifications-list-container .monaco-list-row'
].join(',');

/** 生成隐藏「安装似乎损坏」提示的 CSS（纯 CSS，不需要动 CSP；script-src 才是被限制的那个） */
export function buildNoticeCss(): string {
  const attributes = CORRUPT_NOTICE_TEXTS.map(
    (text) => `[aria-label*='${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
  ).join(',');
  return [
    '/* Empty Editor Watermark — 隐藏 VS Code 的「安装似乎损坏，请重新安装」通知。',
    '   成因：本扩展按用户意图修改了 workbench.html，VS Code 的完整性校验（product.json 的',
    '   checksums）因此对不上。提示本身对用户没有可用信息，故隐藏。',
    '   匹配依据是通知上的 aria-label（本地化文案），VS Code 改文案后需要补充字符串；',
    `   未覆盖的语言可在 CORRUPT_NOTICE_TEXTS 里加。 */`,
    `:is(${NOTICE_TARGETS}):is(${attributes}),`,
    `:is(${NOTICE_TARGETS}):has(${attributes}) {`,
    '    display: none !important;',
    '}',
    ''
  ].join('\n');
}
