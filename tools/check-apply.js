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
  let configurationListener = () => {};
  const informationMessages = [];
  const documents = [];
  const vscodeStub = {
    env: { appRoot: root },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    Uri: {
      file: (p) => ({ fsPath: p }),
      parse: (s) => ({ fsPath: String(s).replace(/^file:\/\/\//i, '').replace(/\//g, '\\') })
    },
    workspace: {
      getConfiguration: () => ({ get: (key, def) => (key in settings ? settings[key] : def), inspect: () => undefined, update: async (key, value) => { settings[key] = value; configurationListener({ affectsConfiguration: () => true }); } }),
      onDidChangeConfiguration: (listener) => { configurationListener = listener; return { dispose() {} }; },
      openTextDocument: async (options) => { documents.push(options.content); return {}; }
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async (msg, ...items) => { informationMessages.push(msg); return items[0]; },
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

  return { root, wbFile, settings, vscodeStub, context, commands, messages, documents, informationMessages, changeConfiguration: () => configurationListener({ affectsConfiguration: () => true }) };
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

  const notice1 = /<!-- EMPTY-EDITOR-WATERMARK-NOTICE:START -->([\s\S]*?)<!-- EMPTY-EDITOR-WATERMARK-NOTICE:END -->/.exec(html1);
  ok('默认注入「隐藏损坏提示」块', !!notice1);
  ok('通知块排在底图块之后', html1.indexOf('EMPTY-EDITOR-WATERMARK-NOTICE:START') > html1.indexOf('EMPTY-EDITOR-WATERMARK:START'));
  ok('通知隐藏覆盖 toast 与通知中心', !!notice1 && notice1[1].includes('.notification-toast-container') && notice1[1].includes('.notifications-list-container'));
  ok('通知隐藏是纯 CSS（块内无脚本）', !!notice1 && !notice1[1].includes('<script') && notice1[1].includes('display: none !important'));
  ok('通知隐藏包含中英文文案匹配', !!notice1 && notice1[1].includes('appears to be corrupt') && notice1[1].includes('安装似乎损坏'));

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

  // ── 场景 3.5：hideCorruptNotice 开关 ───────────────────────────────
  console.log('\n== hideCorruptNotice=false → 不注入通知隐藏块；再打开 → 补上 ==');
  const envN = makeEnv({ hideCorruptNotice: false });
  const extN = loadExtension(envN.vscodeStub);
  extN.activate(envN.context);
  await tick();
  const htmlOff = read(envN.wbFile);
  ok('底图块仍在', htmlOff.includes('EMPTY-EDITOR-WATERMARK:START'));
  ok('通知块没有注入', !htmlOff.includes('EMPTY-EDITOR-WATERMARK-NOTICE'));
  ok('别家注入完好', htmlOff.includes('VSCODE-CUSTOM-CSS-START'));

  envN.settings.hideCorruptNotice = true;
  await envN.commands.get('emptyEditorWatermark.apply')();
  await tick();
  const htmlOn = read(envN.wbFile);
  ok('打开开关后通知块出现', htmlOn.includes('EMPTY-EDITOR-WATERMARK-NOTICE:START'));
  ok('底图块仍只有一份', htmlOn.split('EMPTY-EDITOR-WATERMARK:START').length - 1 === 1);
  ok('通知块只有一份', htmlOn.split('EMPTY-EDITOR-WATERMARK-NOTICE:START').length - 1 === 1);

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
  ok('通知隐藏块也被移除', !html4.includes('EMPTY-EDITOR-WATERMARK-NOTICE'));
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

  console.log('\n== 授权、持久移除与合并配置更新 ==');
  const deferred = makeEnv({});
  deferred.vscodeStub.window.showInformationMessage = async () => '以后再说';
  loadExtension(deferred.vscodeStub).activate(deferred.context);
  await tick();
  loadExtension(deferred.vscodeStub).activate(deferred.context);
  await tick();
  ok('推迟后重启仍不注入', read(deferred.wbFile) === SAMPLE);
  ok('推迟不记录授权', !deferred.context.globalState.get('emptyEditorWatermark.consentGranted', false));
  deferred.changeConfiguration();
  await new Promise(r => setTimeout(r, 250));
  ok('推迟后修改配置也不绕过授权', read(deferred.wbFile) === SAMPLE);

  ok('移除命令同时关闭开关', env4.settings.enabled === false);
  loadExtension(env4.vscodeStub).activate(env4.context);
  await tick();
  ok('移除后重启不会恢复注入', read(env4.wbFile) === SAMPLE);

  const beforePrompts = env1.informationMessages.length;
  env1.settings.opacity = 0.22;
  env1.changeConfiguration();
  env1.settings.opacity = 0.24;
  env1.changeConfiguration();
  await new Promise(r => setTimeout(r, 250));
  ok('连续配置变化只提示一次', env1.informationMessages.length === beforePrompts + 1);
  ok('使用最终配置', read(env1.wbFile).includes('opacity: 0.24'));
  const picker = makeEnv({});
  loadExtension(picker.vscodeStub).activate(picker.context);
  await tick();
  const pickerPrompts = picker.informationMessages.length;
  picker.vscodeStub.window.showOpenDialog = async () => [{ fsPath: imgPath }];
  await picker.commands.get('emptyEditorWatermark.pickImage')();
  await new Promise(r => setTimeout(r, 250));
  ok('选图更新两个设置只提示一次', picker.informationMessages.length === pickerPrompts + 1);
  ok('选图正确更新背景', read(picker.wbFile).includes('my%20pic.png'));
  fs.rmSync(picker.root, { recursive: true, force: true });
  fs.rmSync(deferred.root, { recursive: true, force: true });

  console.log('\n== 安全写入与诊断 ==');
  const safe = require('../out/fileSafety');
  const safetyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eew-safe-'));
  const safetyFile = path.join(safetyRoot, 'workbench.html');
  fs.writeFileSync(safetyFile, SAMPLE);
  const replacement = SAMPLE.replace('<head>', '<head><!-- staged -->');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('模拟替换失败'); };
    let rejected = false;
    try { safe.writeHtmlSafely(safetyFile, SAMPLE, replacement); } catch { rejected = true; }
    ok('替换失败时保留原文件', rejected && read(safetyFile) === SAMPLE);
    ok('失败后清理暂存文件', fs.readdirSync(safetyRoot).length === 1);
  } finally { fs.renameSync = rename; }
  let malformedRejected = false;
  try { safe.writeHtmlSafely(safetyFile, SAMPLE, SAMPLE + '<!-- EMPTY-EDITOR-WATERMARK:START -->'); } catch { malformedRejected = true; }
  ok('拒绝残缺标记并保留原文件', malformedRejected && read(safetyFile) === SAMPLE);
  let concurrentRejected = false;
  fs.writeFileSync(safetyFile, replacement);
  try { safe.writeHtmlSafely(safetyFile, SAMPLE, SAMPLE); } catch { concurrentRejected = true; }
  ok('检测到其他操作修改后不覆盖', concurrentRejected && read(safetyFile) === replacement);
  safe.writeHtmlSafely(safetyFile, replacement, SAMPLE);
  ok('正常替换成功', read(safetyFile) === SAMPLE);

  const partial = makeEnv({});
  const brokenFile = path.join(path.dirname(partial.wbFile), 'workbench.esm.html');
  fs.writeFileSync(brokenFile, '<html>broken');
  loadExtension(partial.vscodeStub).activate(partial.context);
  await tick();
  ok('部分成功明确报告两种结果', partial.messages.some(m => m.includes('部分成功') && m.includes('workbench.esm.html')));
  ok('不完整的 HTML 保持原样', read(brokenFile) === '<html>broken');
  const beforeDiagnosis = read(partial.wbFile);
  await partial.commands.get('emptyEditorWatermark.diagnose')();
  const report = partial.documents.at(-1);
  ok('诊断包含图片、权限和注入状态', report.includes('图片文件: 存在且可读') && report.includes('写权限:') && report.includes('水印块: 完整'));
  ok('诊断标出异常 HTML', report.includes('不是完整的 HTML'));
  ok('诊断不修改目标文件', read(partial.wbFile) === beforeDiagnosis);
  const missing = makeEnv({});
  fs.unlinkSync(missing.wbFile);
  loadExtension(missing.vscodeStub).activate(missing.context);
  await tick();
  await missing.commands.get('emptyEditorWatermark.diagnose')();
  ok('诊断明确报告目标缺失', missing.documents.at(-1).includes('目标文件: 未找到'));
  for (const dir of [safetyRoot, partial.root, missing.root, env3.root, envN.root]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
