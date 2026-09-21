#!/usr/bin/env node
/*
 * 旧版注入清理自检 —— out/legacy.js 是纯函数（不 import vscode），可直接 require。
 *
 * 0.2.0 不再往安装目录写任何东西，但必须能准确认出并删掉 0.1.x 留下的注入块：
 * 那一段正是 VS Code 报「安装似乎损坏」的原因。这里覆盖：
 *   1. 标记常量与 0.1.x 完全一致（改了就认不出老用户的块）
 *   2. hasBlock / extractBlock 的判定
 *   3. stripBlock：只删自己的块，别家的注入（be5invis / shalldie）原样保留
 *   4. 往返回原：0.1.x 注入过的文件，stripped 后与注入前逐字节一致
 *   5. 幂等、未注入不报错、`</html>` 前没有换行的形态
 *
 * 用法：node tools/check-legacy.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const target = process.argv[2] || path.join(__dirname, '..', 'out', 'legacy.js');
if (!fs.existsSync(target)) {
  console.error('✗ 找不到编译产物：' + target + '\n  先跑 npm run compile（或 npm run check）。');
  process.exit(1);
}

const legacy = require(target);
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

// ── 1. 标记常量 ────────────────────────────────────────────────
console.log('\n== 标记常量（必须与 0.1.x 一致）==');
check('MARK_BEGIN', legacy.MARK_BEGIN, '<!-- EMPTY-EDITOR-WATERMARK:START -->');
check('MARK_END', legacy.MARK_END, '<!-- EMPTY-EDITOR-WATERMARK:END -->');
check('备份后缀', legacy.LEGACY_BAK_SUFFIX, '.bak-empty-editor-watermark');

// ── 2. 路径定位 ────────────────────────────────────────────────
console.log('\n== workbenchHtmlPaths ==');
const paths = legacy.workbenchHtmlPaths('D:\\app\\resources\\app');
check('返回两个候选文件', paths.length, 2);
ok('指向 out/vs/code/electron-browser/workbench/workbench.html', paths[0].endsWith(path.join('out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html')));
ok('同时覆盖 workbench.esm.html', paths[1].endsWith('workbench.esm.html'));
ok('都相对 appRoot', paths.every((p) => p.startsWith('D:\\app\\resources\\app')));

// ── 3/4/5. hasBlock / extractBlock / stripBlock ────────────────
console.log('\n== hasBlock / extractBlock / stripBlock ==');

// 模拟 0.1.x 的注入块（当时是插到 </html> 之前）
const BLOCK = `${legacy.MARK_BEGIN}\n<style>\n/* Empty Editor Watermark */\n.wm { opacity: 0.9; }\n</style>\n${legacy.MARK_END}`;

const original =
  '<!-- Copyright (C) Microsoft Corporation. All rights reserved. -->\n' +
  '<!DOCTYPE html>\n' +
  '<html>\n' +
  '\t<head>\n' +
  '\t\t<meta charset="utf-8" />\n' +
  '<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n' +
  '<script>be5invis()</script>\n' +
  '<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n' +
  '\t</head>\n' +
  '\t<body aria-label="">\n' +
  '\t</body>\n' +
  '<!-- vscode-background-end -->\n' +
  '</html>\n';

// 完整复刻 shalldie.background 的注入块（用来验证"别家的东西不能动"）
const BACKGROUND_BLOCK = '<!-- vscode-background-start background.ver.3.1.0 -->\n<script>background()</script>\n<!-- vscode-background-end -->';
const withOthers = original.replace(
  '\t</body>\n',
  '\t</body>\n' + BACKGROUND_BLOCK + '\n'
);
const injected = withOthers.replace('</html>\n', BLOCK + '\n</html>\n');

ok('未注入时 hasBlock=false', !legacy.hasBlock(original));
ok('未注入时 extractBlock=null', legacy.extractBlock(original) === null);

const s0 = legacy.stripBlock(original);
ok('未注入时 strip：removed=false', s0.removed === false);
ok('未注入时 strip：内容不变', s0.html === original);

ok('注入后 hasBlock=true', legacy.hasBlock(injected));
check('extractBlock 取出整块', legacy.extractBlock(injected), BLOCK);

const s1 = legacy.stripBlock(injected);
ok('strip：removed=true', s1.removed === true);
ok('strip：自己的标记没了', !s1.html.includes('EMPTY-EDITOR-WATERMARK'));
ok('strip：be5invis 注入完好', s1.html.includes('VSCODE-CUSTOM-CSS-START') && s1.html.includes('be5invis()'));
ok('strip：shalldie 注入完好', s1.html.includes('vscode-background-start') && s1.html.includes('background()'));
ok('strip：</html> 仍是结尾', s1.html.trimEnd().endsWith('</html>'));
ok('strip：与注入前逐字节一致（往返回原）', s1.html === withOthers);

const s2 = legacy.stripBlock(s1.html);
ok('strip 幂等：第二次 removed=false', s2.removed === false && s2.html === s1.html);

// 0.1.x 也有过"</html> 前没换行"的形态（文件末尾没有换行符）
const tight = withOthers.replace('</html>\n', '</html>');
const tightInjected = tight.replace('</html>', BLOCK + '</html>');
const s3 = legacy.stripBlock(tightInjected);
ok('无换行形态：标记被清掉', !s3.html.includes('EMPTY-EDITOR-WATERMARK'));
ok('无换行形态：</html> 仍在', s3.html.includes('</html>'));

// 只有 START 没有 END（文件被写坏）→ 不动作，避免误删
const broken = original.replace('</html>\n', legacy.MARK_BEGIN + '\n</html>\n');
ok('只有 START 没有 END 时不动文件', (() => { const r = legacy.stripBlock(broken); return r.removed === false && r.html === broken; })());
ok('hasBlock 在只有 START 时为 false', !legacy.hasBlock(broken));

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项不通过`);
process.exit(fails === 0 ? 0 : 1);
