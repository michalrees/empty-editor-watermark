#!/usr/bin/env node
/*
 * 水印页自检 —— out/page.js 与 out/i18n.js 都是纯函数（不 import vscode），可直接 require。
 *
 * 覆盖：
 *   1. 数值/枚举兜底：fit、position、opacity、scale、宽度、字号越界或坏值时退回默认
 *   2. 转义：路径里的引号/反斜杠/尖括号不能把 CSS 或 HTML 打断
 *   3. CSS 生成：图片 URL、铺法、透明度、位置、缩放、磨砂底都真的写进去了
 *   4. HTML 生成：CSP + nonce、默认只留底图（hideLogo/hideCommands 默认 true）、
 *      打开文字块时三条命令与 data-command 都在
 *   5. 页面里**不能出现**任何安装目录相关信息（这是 0.2.0 的核心承诺）
 *   6. i18n：中英文案与 mac/win 快捷键
 *
 * 用法：node tools/check-page.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const outDir = path.join(__dirname, '..', 'out');
const pagePath = path.join(outDir, 'page.js');
const i18nPath = path.join(outDir, 'i18n.js');
for (const p of [pagePath, i18nPath]) {
  if (!fs.existsSync(p)) {
    console.error('✗ 找不到编译产物：' + p + '\n  先跑 npm run compile（或 npm run check）。');
    process.exit(1);
  }
}

const page = require(pagePath);
const i18n = require(i18nPath);

let fails = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fails++;
    console.log('  ✗ ' + name + '\n      期望 ' + e + '\n      实际 ' + a);
  } else {
    console.log('  ✓ ' + name);
  }
};
const ok = (name, cond) => check(name, !!cond, true);

const strings = i18n.getStrings('en', 'win32');
const base = {
  imageUri: 'vscode-webview://x/media/default-bg.svg',
  imageFit: 'cover',
  opacity: 0.9,
  position: 'top-right',
  scale: 0.48,
  hideLogo: true,
  hideCommands: true,
  panelWidth: 261,
  panelFontSize: 19,
  frostedPanel: false,
  strings
};
const security = { cspSource: 'vscode-webview://x', nonce: 'NONCE123' };

console.log('检查文件：' + pagePath + '\n          ' + i18nPath);

// ── 1. 兜底 ────────────────────────────────────────────────────
console.log('\n== 枚举与数值兜底 ==');
check('fit 合法值原样返回', page.normalizeFit('contain'), 'contain');
check('fit 坏值 → cover', page.normalizeFit('fill'), 'cover');
check('position 合法值原样返回', page.normalizePosition('bottom-left'), 'bottom-left');
check('position 坏值 → top-right', page.normalizePosition('middle'), 'top-right');
check('数字越界被夹住', page.clampNumber(5, 0.9, 0, 1), 1);
check('数字为 NaN → 默认', page.clampNumber('abc', 0.9, 0, 1), 0.9);
check('数字为 undefined → 默认', page.clampNumber(undefined, 0.48, 0.05, 4), 0.48);

// ── 2. 转义 ────────────────────────────────────────────────────
console.log('\n== 转义 ==');
check('HTML 转义', page.escapeHtml('<div class="x">&</div>'), '&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
check('属性转义（不动单引号，CSP 里的 nonce 才读得清）', page.escapeAttr('a\'b"c<d&e'), 'a\'b&quot;c&lt;d&amp;e');
check('CSS 字符串转义', page.escapeCssString('a"b\\c\nd'), 'a\\"b\\\\cd');

const evilCss = page.buildPageCss({ ...base, imageUri: 'x"y\\z' });
ok('带引号的图片地址被转义（url("x\\"y\\\\z")）', evilCss.includes('url("x\\"y\\\\z")'));
const evilHtml = page.buildPageHtml(
  { ...base, hideLogo: false, strings: { ...strings, logo: '<script>bad()</script>' } },
  security
);
ok('文案里的标签被转义，不会变成真脚本', evilHtml.includes('&lt;script&gt;bad()&lt;/script&gt;') && !evilHtml.includes('<script>bad()</script>'));

// ── 3. CSS ─────────────────────────────────────────────────────
console.log('\n== buildPageCss ==');
const css = page.buildPageCss(base);
ok('写入图片 URL', css.includes('background-image: url("vscode-webview://x/media/default-bg.svg")'));
ok('background-size: cover', css.includes('background-size: cover'));
ok('opacity 来自配置', css.includes('opacity: 0.9'));
ok('图片层不拦鼠标', css.includes('pointer-events: none;'));
ok('右上角定位', css.includes('right: 0;') && css.includes('top: 0;'));
ok('transform-origin 100% 0%（右上）', css.includes('transform-origin: 100% 0%'));
ok('scale 来自配置', css.includes('transform: scale(0.48)'));
ok('宽度锁定', css.includes('max-width: 261px'));
ok('字号来自配置', css.includes('font-size: 19px'));
ok('默认不加磨砂', !css.includes('backdrop-filter'));
ok('窄窗口有回退规则', css.includes('@media (max-width: 900px)'));

const alt = page.buildPageCss({
  ...base,
  imageFit: 'contain',
  opacity: 0.5,
  position: 'bottom-left',
  frostedPanel: true,
  panelFontSize: 14,
  panelWidth: 300,
  scale: 0.8
});
ok('contain 生效', alt.includes('background-size: contain'));
ok('opacity 0.5 生效', alt.includes('opacity: 0.5'));
ok('左下角定位', alt.includes('left: 0;') && alt.includes('bottom: 0;'));
ok('左下 transform-origin 0% 100%', alt.includes('transform-origin: 0% 100%'));
ok('磨砂底生效（主题变量 + 回退）', alt.includes('backdrop-filter: blur(6px)') && alt.includes('--vscode-editorWidget-background'));
ok('字号/宽度跟着配置', alt.includes('font-size: 14px') && alt.includes('max-width: 300px'));
ok('scale 0.8 生效', alt.includes('transform: scale(0.8)'));

const centered = page.buildPageCss({ ...base, position: 'center' });
ok('center → static + margin auto + 不缩放', centered.includes('position: static;') && centered.includes('margin: auto;') && centered.includes('transform: none;'));
ok('center → 不生成窄窗口媒体查询', !centered.includes('@media'));

// ── 4. HTML ────────────────────────────────────────────────────
console.log('\n== buildPageHtml ==');
const html = page.buildPageHtml(base, security);
ok('是完整 HTML', html.trimStart().startsWith('<!DOCTYPE html>') && html.includes('</html>'));
ok('CSP 里带上 cspSource', html.includes("img-src vscode-webview://x data: https:"));
ok('CSP 里带上 nonce', html.includes("script-src 'nonce-NONCE123'"));
ok('script 带 nonce', html.includes('<script nonce="NONCE123">'));
ok('页面不加载任何外部脚本/样式文件', !/<script[^>]+src=/.test(html) && !/<link[^>]+rel="stylesheet"/.test(html));
ok('有图片层', html.includes('class="wm-image"'));
ok('默认不渲染文字块（hideLogo/hideCommands 都为 true）', !html.includes('class="wm-panel"'));

const full = page.buildPageHtml({ ...base, hideLogo: false, hideCommands: false, frostedPanel: true }, security);
ok('显示文字块时带磨砂类', full.includes('class="wm-panel wm-frosted"'));
ok('标识文字出现', full.includes('Visual Studio Code'));
ok('三条命令都在', full.includes('Show All Commands') && full.includes('Open File') && full.includes('Clone Git Repository'));
ok('命令 id 写进 data-command', full.includes('data-command="workbench.action.showCommands"') && full.includes('data-command="workbench.action.files.openFile"') && full.includes('data-command="git.clone"'));
ok('win 快捷键显示为 Ctrl+Shift+P', full.includes('Ctrl+Shift+P'));

// ── 5. 不碰安装目录（核心承诺）──────────────────────────────────
console.log('\n== 页面里不得出现安装目录相关字样 ==');
for (const needle of ['vscode-file://vscode-app', 'workbench.html', 'appRoot', 'product.json', 'checksums']) {
  ok('不含 ' + needle, !html.includes(needle) && !full.includes(needle) && !css.includes(needle));
}

// ── 6. i18n ───────────────────────────────────────────────────
console.log('\n== i18n ==');
const zh = i18n.getStrings('zh-cn', 'win32');
check('中文标题', zh.panelTitle, '水印');
check('中文命令', zh.commands.showCommands, '显示所有命令');
check('中文快捷键（win）', zh.keys.showCommands, 'Ctrl+Shift+P');
const zhMac = i18n.getStrings('zh-tw', 'darwin');
check('中文快捷键（mac）', zhMac.keys.showCommands, '⇧⌘P');
check('mac 打开文件快捷键', zhMac.keys.openFile, '⌘O');
check('克隆仓库不标快捷键', zhMac.keys.cloneRepo, '');
check('英文兜底', i18n.getStrings('de', 'win32').panelTitle, 'Watermark');
ok('zh 判定', i18n.isChineseLanguage('zh-cn') && i18n.isChineseLanguage('ZH-TW') && !i18n.isChineseLanguage('en'));

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项不通过`);
process.exit(fails === 0 ? 0 : 1);
