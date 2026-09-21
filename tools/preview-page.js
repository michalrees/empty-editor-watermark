#!/usr/bin/env node
/*
 * 水印页预览 —— 把生成的页面渲染成一张独立 HTML，直接在浏览器里看效果。
 * 不需要起 VS Code，也不写任何 VS Code 文件（纯开发辅助）。
 *
 * 用法：
 *   node tools/preview-page.js                          # 用扩展自带默认图，只留底图
 *   node tools/preview-page.js --panel                  # 连文字块一起渲染
 *   node tools/preview-page.js --image "E:\pic\a.jpg"   # 指定本地图片
 *   node tools/preview-page.js --image "https://.../a.jpg" --fit contain --opacity 0.5
 *   node tools/preview-page.js --out "$env:TEMP\eew.html" && start $env:TEMP\eew.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const page = require(path.join(repo, 'out', 'page.js'));
const i18n = require(path.join(repo, 'out', 'i18n.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.indexOf('--' + name) >= 0;

const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

function toUri(input) {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  const file = path.resolve(input);
  const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,` + fs.readFileSync(file).toString('base64');
}

const imageInput = arg('image', path.join(repo, 'media', 'default-bg.svg'));
const language = arg('lang', 'zh-cn');
const out = path.resolve(arg('out', path.join(process.env.TEMP || '.', 'eew-preview.html')));

const options = {
  imageUri: toUri(imageInput),
  imageFit: arg('fit', 'cover') === 'contain' ? 'contain' : 'cover',
  opacity: Number(arg('opacity', '0.9')),
  position: arg('position', 'top-right'),
  scale: Number(arg('scale', '0.48')),
  hideLogo: !has('panel'),
  hideCommands: !has('panel'),
  panelWidth: Number(arg('width', '261')),
  panelFontSize: Number(arg('font-size', '19')),
  frostedPanel: has('frosted'),
  strings: i18n.getStrings(language, arg('platform', process.platform))
};

const html = page.buildPageHtml(options, {
  cspSource: 'vscode-webview://preview',
  nonce: 'PREVIEWNONCE0000000000000000000000'
});

fs.writeFileSync(out, html, 'utf8');
console.log('已生成：' + out);
console.log('背景图：' + (options.imageUri.length > 80 ? options.imageUri.slice(0, 60) + '…（内联）' : options.imageUri));
console.log('文字块：' + (options.hideCommands ? '不渲染（只留底图）' : `渲染，位置 ${options.position}`));
