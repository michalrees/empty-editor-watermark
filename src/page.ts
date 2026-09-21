/**
 * 水印页（Webview）—— 纯函数生成 HTML / CSS。
 *
 * 为什么是 Webview 而不是"往安装目录写 CSS"：
 *   VS Code 没有任何公开 API 能给工作台注入 CSS（本机 1.138 的 vscode.d.ts 里
 *   搜不到 css / inject / workbench 相关 API），所以 0.1.x 走的是所有同类扩展
 *   （be5invis.vscode-custom-css、shalldie.background、subframe7536/vscode-custom-ui-style）
 *   都在走的那条路：直接改安装目录里的 workbench.html。
 *
 *   代价是躲不掉的：VS Code 1.9x 起，workbench 里的 IntegrityService 会在启动时读
 *   product.json 的 `checksums`，逐个文件做 SHA256 校验，只要有一个对不上就记
 *   "*** Installation has been modified on disk ***" 并弹
 *   "Your Code installation appears to be corrupt. Please reinstall."。
 *   于是**所有**装了该扩展的用户都会看到"Code 安装损坏"。
 *
 *   0.2.0 起改成：空编辑器时打开一个属于本扩展的 Webview 页，铺上背景图。
 *   全程不碰安装目录，校验和永远对得上，也不会再有人看到那条提示。
 *
 * 本文件刻意写成不 import 'vscode' 的纯函数，方便 tools/check-page.js 直接
 * require 编译产物做单测。
 */

export type ImageFit = 'cover' | 'contain';
export type WatermarkPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';

/** 页面文案（按 VS Code 界面语言挑，见 i18n.ts） */
export interface WatermarkStrings {
  /** 标签页标题（配置 panelTitle 留空时用它） */
  panelTitle: string;
  /** 文字块里的标识文字（hideLogo=false 时显示） */
  logo: string;
  commands: {
    showCommands: string;
    openFile: string;
    cloneRepo: string;
  };
  keys: {
    showCommands: string;
    openFile: string;
    cloneRepo: string;
  };
}

export interface WatermarkOptions {
  /** 已经过 webview.asWebviewUri() 的图片地址（或 https:// 地址） */
  imageUri: string;
  imageFit: ImageFit;
  opacity: number;
  position: WatermarkPosition;
  scale: number;
  hideLogo: boolean;
  hideCommands: boolean;
  panelWidth: number;
  panelFontSize: number;
  frostedPanel: boolean;
  strings: WatermarkStrings;
}

/** CSP / nonce，由调用方从 Webview 上取 */
export interface PageSecurity {
  cspSource: string;
  nonce: string;
}

/** 页面上那三条命令对应的内置命令 id */
export const COMMAND_IDS = {
  showCommands: 'workbench.action.showCommands',
  openFile: 'workbench.action.files.openFile',
  cloneRepo: 'git.clone'
} as const;

const FIT_VALUES: readonly ImageFit[] = ['cover', 'contain'];
const POSITION_VALUES: readonly WatermarkPosition[] = [
  'top-right',
  'top-left',
  'bottom-right',
  'bottom-left',
  'center'
];

export function normalizeFit(value: unknown): ImageFit {
  return FIT_VALUES.indexOf(value as ImageFit) >= 0 ? (value as ImageFit) : 'cover';
}

export function normalizePosition(value: unknown): WatermarkPosition {
  return POSITION_VALUES.indexOf(value as WatermarkPosition) >= 0
    ? (value as WatermarkPosition)
    : 'top-right';
}

/** 配置里的数字一律过一遍，坏值/越界都退回默认，避免生成出无效 CSS */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/** 写进 HTML 文本/属性前的转义 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 写进 HTML 属性前的转义。
 * 与 escapeHtml 的区别：**不动单引号** —— CSP 里的 'nonce-xxx' 得原样保留，
 * 转成 &#39; 虽然浏览器也认，但会让"查看水印页源码"读起来很难核对。
 */
export function escapeAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 写进 CSS url("…") 前的转义（路径里出现引号/反斜杠时不能把样式打断） */
export function escapeCssString(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, '');
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

/**
 * 生成整页 CSS。图片铺满视图（独立图层，透明度只作用于图片本身），
 * 文字块（logo + 命令列表）按 position/scale/字号摆位。
 */
export function buildPageCss(options: WatermarkOptions): string {
  const fit = normalizeFit(options.imageFit);
  const position = normalizePosition(options.position);
  const opacity = clampNumber(options.opacity, 0.9, 0, 1);
  const scale = clampNumber(options.scale, 0.48, 0.05, 4);
  const width = Math.round(clampNumber(options.panelWidth, 261, 80, 4000));
  const fontSize = clampNumber(options.panelFontSize, 19, 8, 96);
  const image = escapeCssString(options.imageUri);
  const p = placement(position);

  const parts: string[] = [];

  // 0) 基础：铺满视图、透明底（跟随 VS Code 主题背景）
  parts.push(`html, body {
    width: 100%;
    height: 100%;
}

body {
    margin: 0;
    padding: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
    font-size: var(--vscode-font-size, 13px);
}`);

  // 1) 图片层：独立图层，透明度只作用于图片，不影响文字
  parts.push(`.wm-image {
    position: absolute;
    inset: 0;
    background-image: url("${image}");
    background-repeat: no-repeat;
    background-position: center center;
    background-size: ${fit};
    opacity: ${opacity};
    pointer-events: none;   /* 不拦鼠标 */
    z-index: 0;
}`);

  // 2) 文字块定位
  const panelRules = p.centered
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
  parts.push(`.wm-panel {
    z-index: 1;
    padding: 14px 18px;
${panelRules}
}`);

  // 3) 窄窗口保护：退回居中，避免压到别的内容
  if (!p.centered) {
    parts.push(`@media (max-width: 900px) {
    .wm-panel {
        position: static;
        margin: auto;
        transform: none;
    }
}`);
  }

  // 4) 文字块内容（logo + 命令列表）
  parts.push(`.wm-logo {
    font-size: ${fontSize}px;
    opacity: 0.75;
    margin: 0 0 10px 6px;
    white-space: nowrap;
}

.wm-commands {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: ${fontSize}px;
}

.wm-command {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
}

.wm-command:hover,
.wm-command:focus-visible {
    background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.31));
    outline: none;
}

.wm-label {
    flex: 1 1 auto;
}

.wm-key {
    flex: 0 0 auto;
    opacity: 0.7;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    white-space: nowrap;
}`);

  // 5) 可选磨砂底
  if (options.frostedPanel) {
    parts.push(`.wm-panel {
    background-color: var(--vscode-editorWidget-background, rgba(37, 37, 38, 0.74));
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-radius: 10px;
}`);
  }

  return parts.join('\n\n') + '\n';
}

function commandRow(label: string, key: string, commandId: string): string {
  const keyHtml = key ? `<span class="wm-key">${escapeHtml(key)}</span>` : '';
  return (
    `<li class="wm-command" role="button" tabindex="0" data-command="${escapeHtml(commandId)}">` +
    `<span class="wm-label">${escapeHtml(label)}</span>${keyHtml}</li>`
  );
}

/** 生成完整页面（含 CSP 与 nonce；除了内联样式和那段 nonce 脚本，页面不加载任何外部资源） */
export function buildPageHtml(options: WatermarkOptions, security: PageSecurity): string {
  const s = options.strings;
  const cspSource = String(security.cspSource ?? '');
  const nonce = String(security.nonce ?? '');
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data: https:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  const rows: string[] = [];
  if (!options.hideLogo) {
    rows.push(`<div class="wm-logo">${escapeHtml(s.logo)}</div>`);
  }
  if (!options.hideCommands) {
    rows.push(
      `<ul class="wm-commands">` +
        commandRow(s.commands.showCommands, s.keys.showCommands, COMMAND_IDS.showCommands) +
        commandRow(s.commands.openFile, s.keys.openFile, COMMAND_IDS.openFile) +
        commandRow(s.commands.cloneRepo, s.keys.cloneRepo, COMMAND_IDS.cloneRepo) +
        `</ul>`
    );
  }

  const panelClass = options.frostedPanel ? 'wm-panel wm-frosted' : 'wm-panel';
  const panel = rows.length > 0 ? `<div class="${panelClass}">${rows.join('')}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(s.panelTitle)}</title>
<style>
${buildPageCss(options)}</style>
</head>
<body>
<div class="wm-image" role="presentation"></div>
${panel}
<script nonce="${escapeAttr(nonce)}">
(function () {
    var vscode = acquireVsCodeApi();
    function run(id) {
        if (id) {
            vscode.postMessage({ command: 'run', id: id });
        }
    }
    var items = document.querySelectorAll('[data-command]');
    for (var i = 0; i < items.length; i++) {
        (function (el) {
            el.addEventListener('click', function () { run(el.getAttribute('data-command')); });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    run(el.getAttribute('data-command'));
                }
            });
        })(items[i]);
    }
})();
</script>
</body>
</html>
`;
}
