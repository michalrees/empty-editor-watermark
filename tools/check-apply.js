#!/usr/bin/env node
/*
 * 集成冒烟测试 —— 真的跑一遍 out/extension.js 的 apply()/remove()，
 * 但目标是一个**临时 appRoot 里的 workbench.html 副本**，绝不碰真实安装目录。
 *
 * 做法：把 require('vscode') 换成 stub，再载入编译产物，然后调 activate()。
 * 断言：
 *   1. 注入标记写入副本，且排在别家注入（be5invis）之后
 *   2. 首次改动留下备份 workbench.html.bak-empty-editor-watermark
 *   3. 重复 activate 幂等（文件字节不变）
 *   4. 改设置（opacity）后再 activate 会更新已有块，标记仍只有一份
 *   5. remove() 只删自己的块，别家注入完好、</html> 仍在结尾
 *   6. 找不到 workbench.html 时不会抛异常
 *
 * 用法：node tools/check-apply.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.join(__dirname, '..');
const outDir = path.join(repo, 'out');
const extensionEntry = path.join(outDir, 'extension.js');

if (!fs.existsSync(extensionEntry)) {
  console.error('✗ 找不到编译产物：' + extensionEntry + '\n  先跑 npm run compile（或 npm run check）。');
  process.exit(1);
}

let fails = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    fails++;
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  }
};

const SAMPLE = [
  '<!-- Copyright (C) Microsoft Corporation. All rights reserved. -->',
  '<!DOCTYPE html>',
  '<html>',
  '\t<head>',
  '\t\t<meta charset="utf-8" />',
  '\t\t<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">',
  '\t<!-- !! VSCODE-CUSTOM-CSS-START !! -->',
  '\t<style>.be5invis-marker { color: red; }</style>',
  '\t<!-- !! VSCODE-CUSTOM-CSS-END !! -->',
  '\t</head>',
  '\t<body aria-label="Empty Editor Watermark test">',
  '\t</body>',
  '<!-- vscode-background-end -->',
  '</html>',
  ''
].join('\n');

/** 造一套临时环境：appRoot 目录 + 配置 + 记录调用的 stub */
function makeEnv(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eew-'));
  const wbDir = path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench');
  fs.mkdirSync(wbDir, { recursive: true });
  const wbFile = path.join(wbDir, 'workbench.html');
  fs.writeFileSync(wbFile, SAMPLE, 'utf8');

  const messages = [];
  const commands = new Map();
  const vscodeStub = {
    env: { appRoot: root },
    Uri: {
      file: (p) => ({ fsPath: p }),
      parse: (s) => ({ fsPath: String(s).replace(/^file:\/\/\//i, '').replace(/\//g, '\\') })
    },
    workspace: {
      getConfiguration: () => ({ get: (key, def) => (key in settings ? settings[key] : def), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      openTextDocument: async () => ({})
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async (_msg, ...items) => items[0],
      showWarningMessage: async (msg) => {
        messages.push('warn:' + msg);
        return undefined;
      },
      showErrorMessage: async (msg) => {
        messages.push('error:' + msg);
        return undefined;
      },
      showOpenDialog: async () => undefined,
      showTextDocument: async () => ({})
    },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async () => undefined
    }
  };

  const state = new Map();
  const context = {
    extensionPath: repo,
    subscriptions: [],
    globalState: {
      get: (k, def) => (state.has(k) ? state.get(k) : def),
      update: async (k, v) => {
        state.set(k, v);
      }
    }
  };

  return { root, wbFile, vscodeStub, context, commands, messages };
}

function loadExtension(vscodeStub) {
  const src = fs.readFileSync(extensionEntry, 'utf8');
  const mod = { exports: {} };
  const req = (id) => (id === 'vscode' ? vscodeStub : require(id.startsWith('.') ? path.join(outDir, id) : id));
  new Function('require', 'module', 'exports', '__dirname', src)(req, mod, mod.exports, outDir);
  return mod.exports;
}

const tick = () => new Promise((r) => setTimeout(r, 120));
const read = (f) => fs.readFileSync(f, 'utf8');

(async () => {
  console.log('集成冒烟测试（目标文件是临时副本，不碰真实安装目录）\n');

  // ── 场景 1：首次运行（会先征求同意 → stub 自动选"应用水印"）──────────
  console.log('== 首次运行：自动接受提示并注入 ==');
  const env1 = makeEnv({});
  const ext1 = loadExtension(env1.vscodeStub);
  ext1.activate(env1.context);
  await tick();

  const html1 = read(env1.wbFile);
  ok('写入注入标记', html1.includes('EMPTY-EDITOR-WATERMARK:START') && html1.includes('EMPTY-EDITOR-WATERMARK:END'));
  ok('排在 be5invis 注入之后', html1.indexOf('EMPTY-EDITOR-WATERMARK:START') > html1.indexOf('VSCODE-CUSTOM-CSS-START'));
  ok('别家注入未被破坏', html1.includes('.be5invis-marker') && html1.includes('vscode-background-end'));
  ok('</html> 仍在结尾', html1.trimEnd().endsWith('</html>'));
  ok('用了扩展自带的默认底图', html1.includes('default-bg.svg'));
  ok('默认隐藏 logo 与命令列表', html1.includes('.letterpress') && html1.includes('.shortcuts'));
  ok('默认透明度 0.9', html1.includes('opacity: 0.9'));
  ok('留下备份', fs.existsSync(env1.wbFile + '.bak-empty-editor-watermark'));
  ok('备份内容 = 注入前的原样', read(env1.wbFile + '.bak-empty-editor-watermark') === SAMPLE);

  // ── 场景 2：重复激活幂等 ────────────────────────────────────────────
  console.log('\n== 再次激活：幂等，不重复注入 ==');
  const ext2 = loadExtension(env1.vscodeStub);
  ext2.activate(env1.context);
  await tick();
  const html2 = read(env1.wbFile);
  const marks = html2.split('EMPTY-EDITOR-WATERMARK:START').length - 1;
  ok('标记仍只有一份', marks === 1, '实际 ' + marks + ' 份');
  ok('文件字节未变', html2 === html1);

  // ── 场景 3：改设置后自动更新 ────────────────────────────────────────
  console.log('\n== 改设置（opacity 0.35 + 自定义图片 + 显示 logo）后自动更新 ==');
  const imgPath = path.join(env1.root, 'my pic.png');
  fs.writeFileSync(imgPath, 'x');
  const env3 = makeEnv({});
  // 复用同一个 appRoot，但换一份配置
  env3.vscodeStub.env.appRoot = env1.root;
  env3.wbFile = env1.wbFile;
  const ext3 = loadExtension({
    ...env3.vscodeStub,
    workspace: {
      getConfiguration: () => ({
        get: (key, def) =>
          ({
            opacity: 0.35,
            imagePath: imgPath,
            hideLogo: false,
            position: 'bottom-left'
          }[key] ?? def),
        update: async () => {}
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      openTextDocument: async () => ({})
    }
  });
  const state3 = new Map();
  ext3.activate({ ...env3.context, globalState: { get: (k, d) => (state3.has(k) ? state3.get(k) : d), update: async (k, v) => state3.set(k, v) } });
  await tick();
  const html3 = read(env1.wbFile);
  ok('标记仍只有一份', html3.split('EMPTY-EDITOR-WATERMARK:START').length - 1 === 1);
  ok('透明度和位置已更新', html3.includes('opacity: 0.35') && html3.includes('transform-origin: 0% 100%'));
  ok('自定义图片转为 vscode-file URL 且空格被编码', html3.includes('my%20pic.png') && html3.includes('vscode-file://vscode-app/'));
  ok('hideLogo=false 后不再隐藏 .letterpress', !/\.letterpress\s*\{/.test(html3));
  ok('hideCommands 缺省仍为 true → 仍隐藏 .shortcuts', /\.shortcuts\s*\{/.test(html3));

  // ── 场景 4：remove 只删自己那段 ─────────────────────────────────────
  console.log('\n== 移除水印 ==');
  const env4 = makeEnv({});
  const ext4 = loadExtension(env4.vscodeStub);
  ext4.activate(env4.context);
  await tick();
  const removeCmd = env4.commands.get('emptyEditorWatermark.remove');
  ok('注册了 remove 命令', typeof removeCmd === 'function');
  await removeCmd();
  await tick();
  const html4 = read(env4.wbFile);
  ok('自己的标记已消失', !html4.includes('EMPTY-EDITOR-WATERMARK'));
  ok('别家注入完好', html4.includes('VSCODE-CUSTOM-CSS-START') && html4.includes('.be5invis-marker'));
  ok('内容与原始样例完全一致（往返还原）', html4 === SAMPLE, JSON.stringify(html4.slice(-60)));
  ok('没有报错信息', !env4.messages.some((m) => m.startsWith('error')), env4.messages.join(' | '));

  // ── 场景 5：找不到 workbench.html 时报错而不崩 ───────────────────────
  console.log('\n== 目标文件不存在 ==');
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eew-empty-'));
  const env5 = makeEnv({});
  env5.vscodeStub.env.appRoot = emptyRoot;
  const ext5 = loadExtension(env5.vscodeStub);
  let threw = null;
  try {
    ext5.activate(env5.context);
    await tick();
  } catch (e) {
    threw = e;
  }
  ok('不抛异常', threw === null, threw && threw.stack);

  // 清理
  for (const dir of [env1.root, env4.root, env5.root, emptyRoot]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项不通过`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身异常：' + e.stack);
  process.exit(1);
});
