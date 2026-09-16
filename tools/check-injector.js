#!/usr/bin/env node
/*
 * 注入器自检 —— out/injector.js 是纯函数（不 import vscode），可以直接 require 来测。
 *
 * 覆盖：
 *   1. 路径 → vscode-file://vscode-app/ URL（盘符小写、冒号 %3A、空格编码）
 *   2. CSS 生成（图片/透明度/尺寸/位置/隐藏开关/缩放都真的写进去了）
 *   3. patchHtml：插入位置、幂等（重复注入不累积）、原地更新
 *   4. stripBlock：只删自己的块，别家注入（be5invis 等）原样保留
 *   5. 往返：patch → strip 回到原文件（含 </html> 前有换行的情况）
 *
 * 用法：node tools/check-injector.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const target = process.argv[2] || path.join(__dirname, '..', 'out', 'injector.js');
if (!fs.existsSync(target)) {
  console.error('✗ 找不到编译产物：' + target + '\n  先跑 npm run compile（或 npm run check）。');
  process.exit(1);
}

const inj = require(target);
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

console.log('检查文件：' + target);

// ── 1. URL 转换 ────────────────────────────────────────────────
console.log('\n== toVscodeFileUrl ==');
check('盘符小写 + %3A', inj.toVscodeFileUrl('E:\\Windows\\Picture\\Picture\\linux.jpg'),
  'vscode-file://vscode-app/e%3A/Windows/Picture/Picture/linux.jpg');
check('空格编码', inj.toVscodeFileUrl('C:\\My Pictures\\a b.png'),
  'vscode-file://vscode-app/c%3A/My%20Pictures/a%20b.png');
check('正斜杠输入同样处理', inj.toVscodeFileUrl('D:/x/y.jpg'),
  'vscode-file://vscode-app/d%3A/x/y.jpg');

// ── 2. CSS 生成 ────────────────────────────────────────────────
console.log('\n== buildCss ==');
const base = {
  imageUrl: 'vscode-file://vscode-app/e%3A/a.jpg',
  imageFit: 'cover',
  opacity: 0.9,
  position: 'top-right',
  scale: 0.48,
  hideLogo: true,
  hideCommands: true,
  panelWidth: 261,
  panelFontSize: 19,
  frostedPanel: false
};
const css = inj.buildCss(base);
ok('写入图片 URL', css.includes('background-image: url("vscode-file://vscode-app/e%3A/a.jpg")'));
ok('background-size: cover', css.includes('background-size: cover'));
ok('opacity 来自配置', css.includes('opacity: 0.9'));
ok('右上角定位', css.includes('right: 0;') && css.includes('top: 0;'));
ok('transform-origin 100% 0%（右上）', css.includes('transform-origin: 100% 0%'));
ok('scale 来自配置', css.includes('transform: scale(0.48)'));
ok('宽度锁定', css.includes('max-width: 261px'));
ok('字号来自配置', css.includes('font-size: 19px'));
ok('hideLogo → 隐藏 .letterpress', css.includes('.letterpress') && css.includes('display: none !important'));
ok('hideCommands → 隐藏 .shortcuts', css.includes('.shortcuts'));
ok('默认不加磨砂', !css.includes('backdrop-filter'));

const noHide = inj.buildCss({ ...base, hideLogo: false, hideCommands: false, frostedPanel: true, position: 'bottom-left', imageFit: 'contain', opacity: 0.5 });
ok('hideLogo=false → 不再隐藏 .letterpress', !noHide.includes('.letterpress'));
ok('hideCommands=false → 不再隐藏 .shortcuts', !noHide.includes('.shortcuts'));
ok('frostedPanel=true → 加磨砂', noHide.includes('backdrop-filter: blur(3px)'));
ok('左下角定位', noHide.includes('left: 0;') && noHide.includes('bottom: 0;'));
ok('左下 transform-origin 0% 100%', noHide.includes('transform-origin: 0% 100%'));
ok('contain 生效', noHide.includes('background-size: contain'));
ok('opacity 0.5 生效', noHide.includes('opacity: 0.5'));

const centered = inj.buildCss({ ...base, position: 'center' });
ok('center → static + margin auto + 不缩放', centered.includes('position: static;') && centered.includes('margin: auto;') && centered.includes('transform: none;'));
ok('center → 不再生成窄窗口媒体查询', !centered.includes('@media'));

// ── 3/4/5. patchHtml / stripBlock ──────────────────────────────
console.log('\n== patchHtml / stripBlock ==');
const block = inj.buildBlock(css);
const original = '<!-- Copyright -->\n<!DOCTYPE html>\n<html>\n<head></head>\n<body>\n<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n<style>.x{}</style>\n<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n</body>\n</html>\n';

const p1 = inj.patchHtml(original, block);
ok('首次注入：标记出现一次', (p1.html.match(new RegExp(inj.MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1);
ok('首次注入：块在 </html> 之前', p1.html.indexOf(inj.MARK_BEGIN) < p1.html.lastIndexOf('</html>'));
ok('首次注入：排在 be5invis 之后（文档顺序最后）', p1.html.indexOf(inj.MARK_BEGIN) > p1.html.indexOf('VSCODE-CUSTOM-CSS-START'));
ok('首次注入：changed=true', p1.changed === true);

const p2 = inj.patchHtml(p1.html, block);
ok('重复注入同一 block：changed=false（幂等）', p2.changed === false);
ok('重复注入：内容不变', p2.html === p1.html);

const other = inj.buildBlock(inj.buildCss({ ...base, opacity: 0.11 }));
const p3 = inj.patchHtml(p1.html, other);
ok('换内容再注入：原地替换', p3.changed === true && p3.html.includes('opacity: 0.11'));
ok('换内容再注入：标记仍只有一份', (p3.html.match(new RegExp(inj.MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1);
ok('换内容再注入：没把 </html> 挤丢', p3.html.trimEnd().endsWith('</html>'));

const s1 = inj.stripBlock(p3.html);
ok('strip：removed=true', s1.removed === true);
ok('strip：自己的块没了', !s1.html.includes(inj.MARK_BEGIN) && !s1.html.includes('EMPTY-EDITOR-WATERMARK'));
ok('strip：别家注入完好', s1.html.includes('VSCODE-CUSTOM-CSS-START') && s1.html.includes('.x{}'));
ok('strip → patch 往返还原（</html> 前有换行的常见情形）', s1.html === original);

const noNl = original.replace('</body>\n</html>\n', '</body></html>\n');
const s2 = inj.stripBlock(inj.patchHtml(noNl, block).html);
ok('无换行场景：strip 后不再有标记', !s2.html.includes(inj.MARK_BEGIN));
ok('无换行场景：</html> 仍是结尾', s2.html.trimEnd().endsWith('</html>'));

ok('strip 未注入的文件：removed=false 且内容不变', (() => { const r = inj.stripBlock(original); return r.removed === false && r.html === original; })());
ok('hasBlock/extractBlock 在未注入时为 false/null', !inj.hasBlock(original) && inj.extractBlock(original) === null);
ok('hasBlock/extractBlock 在注入后为 true/块内容', inj.hasBlock(p1.html) && inj.extractBlock(p1.html) === block);

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项不通过`);
process.exit(fails === 0 ? 0 : 1);
