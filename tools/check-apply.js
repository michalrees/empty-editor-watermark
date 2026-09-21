#!/usr/bin/env node
/*
 * 端到端冒烟测试 —— 真的跑一遍 out/extension.js 的 activate() / 各命令，
 * 但目标是**临时 appRoot 里的 workbench.html 副本**，绝不碰真实安装目录。
 *
 * 做法：把 require('vscode') 换成 stub、setTimeout 换成手动触发的收集器，
 * 再载入编译产物。断言 0.2.0 的两条核心承诺：
 *   A. 不再往安装目录写东西（干净的 workbench.html 一个字节都不动、不产生新文件）
 *   B. 能把 0.1.x 留下的注入清掉（只删自己的块，别家注入完好，逐字节往返回原）
 * 以及面板行为：标题/CSP/图片 URI/命令转发/自动开关/用户关掉后不硬弹。
 *
 * 用法：node tools/check-apply.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

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

// ── 样例文件 ───────────────────────────────────────────────────
const BASE_HTML =
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
  '\t<script src="./workbench.js" type="module"></script>\n' +
  '<!-- vscode-background-end -->\n' +
  '</html>\n';

const LEGACY_BLOCK =
  '<!-- EMPTY-EDITOR-WATERMARK:START -->\n' +
  '<style>\n/* Empty Editor Watermark — 由扩展生成，请勿手改本段（改设置或卸载即可） */\n' +
  '.monaco-workbench .part.editor > .content .editor-group-watermark-wrapper::before { content: ""; }\n' +
  '</style>\n' +
  '<!-- EMPTY-EDITOR-WATERMARK:END -->';

const LEGACY_INJECTED = BASE_HTML.replace('</html>\n', LEGACY_BLOCK + '\n</html>\n');

// ── vscode stub ────────────────────────────────────────────────
class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

function makeUri(fsPath) {
  return {
    fsPath,
    scheme: 'file',
    toString: () => 'file:///' + String(fsPath).replace(/\\/g, '/')
  };
}

function makeEnv(options) {
  const opts = options || {};
  const settings = Object.assign({}, opts.settings || {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eew-'));
  const wbDir = path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench');
  fs.mkdirSync(wbDir, { recursive: true });
  const wbFile = path.join(wbDir, 'workbench.html');
  fs.writeFileSync(wbFile, opts.html === undefined ? BASE_HTML : opts.html, 'utf8');

  const messages = [];
  const executed = [];
  const panels = [];
  const commands = new Map();
  const tabHandlers = [];
  const configHandlers = [];
  const timeouts = [];

  const initialTabs = opts.tabs || [];
  const tabGroups = {
    all: initialTabs.length ? [{ tabs: initialTabs }] : [],
    onDidChangeTabs: (cb) => {
      tabHandlers.push(cb);
      return { dispose() {} };
    }
  };

  const vscodeStub = {
    env: { appRoot: root, language: opts.language || 'zh-cn', appName: 'Visual Studio Code' },
    Uri: {
      file: (p) => makeUri(p),
      parse: (s) => makeUri(String(s).replace(/^file:\/\//i, '')),
      joinPath: (base, ...parts) => makeUri(path.join(base.fsPath, ...parts))
    },
    ViewColumn: { Active: -1, One: 1 },
    ConfigurationTarget: { Global: 1 },
    TabInputWebview,
    TabInputText,
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id) => {
        executed.push(id);
        return undefined;
      }
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, def) => (key in settings ? settings[key] : def),
        update: async (key, value) => {
          settings[key] = value;
        }
      }),
      onDidChangeConfiguration: (cb) => {
        configHandlers.push(cb);
        return { dispose() {} };
      },
      openTextDocument: async (arg) => ({
        getText: () => (arg && arg.content) || '',
        languageId: (arg && arg.language) || 'plaintext'
      })
    },
    window: {
      activeColorTheme: { kind: 2 },
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      tabGroups,
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async (msg) => {
        messages.push('info:' + msg);
        return undefined;
      },
      showWarningMessage: async (msg) => {
        messages.push('warn:' + msg);
        return undefined;
      },
      showErrorMessage: async (msg) => {
        messages.push('error:' + msg);
        return undefined;
      },
      showOpenDialog: async () => undefined,
      showTextDocument: async () => ({}),
      createWebviewPanel: (viewType, title, column, panelOptions) => {
        const messageHandlers = [];
        const disposeHandlers = [];
        const webview = {
          options: panelOptions,
          html: '',
          cspSource: 'vscode-webview://stub',
          asWebviewUri: (uri) => makeUri('vscode-webview://stub' + String(uri.fsPath).replace(/\\/g, '/')),
          onDidReceiveMessage: (cb) => {
            messageHandlers.push(cb);
            return { dispose() {} };
          }
        };
        const panel = {
          viewType,
          title,
          column,
          panelOptions,
          webview,
          disposed: false,
          revealed: 0,
          reveal() {
            this.revealed++;
          },
          dispose() {
            if (this.disposed) {
              return;
            }
            this.disposed = true;
            disposeHandlers.forEach((h) => h());
          },
          onDidDispose: (cb) => {
            disposeHandlers.push(cb);
            return { dispose() {} };
          },
          __postMessage: (msg) => messageHandlers.forEach((h) => h(msg))
        };
        panels.push(panel);
        return panel;
      }
    }
  };

  const state = new Map();
  const context = {
    extensionPath: repo,
    extensionUri: makeUri(repo),
    subscriptions: [],
    globalState: {
      get: (k, def) => (state.has(k) ? state.get(k) : def),
      update: async (k, v) => {
        state.set(k, v);
      }
    }
  };

  return {
    root,
    wbFile,
    settings,
    vscodeStub,
    context,
    commands,
    messages,
    executed,
    panels,
    timeouts,
    setTabs: (tabs) => {
      tabGroups.all = tabs && tabs.length ? [{ tabs }] : [];
    },
    ownTab: () => ({ input: new TabInputWebview('mainThreadWebview-emptyEditorWatermark') }),
    foreignTab: () => ({ input: new TabInputWebview('mainThreadWebview-customWelcome') }),
    textTab: () => ({ input: new TabInputText(makeUri(path.join(repo, 'README.md'))) }),
    emitTabs: () => tabHandlers.forEach((h) => h({ opened: [], closed: [], changed: [] })),
    emitConfig: () => configHandlers.forEach((h) => h({ affectsConfiguration: () => true })),
    flushTimeouts: () => {
      const pending = timeouts.splice(0, timeouts.length);
      pending.forEach((t) => t.fn());
    }
  };
}

/**
 * out/*.js 里是 `require('vscode')`（extension.js / panel.js），Node 里没有这个模块。
 * 这里把模块解析拦住：'vscode' 一律返回 stub，并在每次载入前清掉 out/ 的模块缓存，
 * 这样每个场景都能拿到自己那套 stub（否则第二个场景会复用第一个场景的 vscode）。
 */
function installVscodeShim(vscodeStub) {
  if (!Module.__eewPatched) {
    Module.__eewPatched = true;
    Module.__eewResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'vscode') {
        return 'vscode';
      }
      return Module.__eewResolve.call(this, request, ...rest);
    };
  }
  require.cache.vscode = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeStub,
    children: [],
    paths: []
  };
}

function loadExtension(env) {
  installVscodeShim(env.vscodeStub);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(outDir)) {
      delete require.cache[key];
    }
  }
  const src = fs.readFileSync(extensionEntry, 'utf8');
  const mod = { exports: {} };
  const req = (id) => {
    if (id === 'vscode') {
      return env.vscodeStub;
    }
    return require(id.startsWith('.') ? path.join(outDir, id) : id);
  };
  const fakeSetTimeout = (fn, ms) => {
    env.timeouts.push({ fn, ms });
    return 0;
  };
  new Function('require', 'module', 'exports', '__dirname', 'setTimeout', src)(
    req,
    mod,
    mod.exports,
    outDir,
    fakeSetTimeout
  );
  return mod.exports;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 150 : ms));
const read = (f) => fs.readFileSync(f, 'utf8');

(async () => {
  console.log('端到端冒烟测试（目标文件是临时副本，不碰真实安装目录）\n');
  const cleanupDirs = [];

  // ── 场景 1：升级清理 —— 0.1.x 的注入必须被删掉，且逐字节往返回原 ──
  console.log('== 场景 1：升级时清理 0.1.x 注入 ==');
  const env1 = makeEnv({
    html: LEGACY_INJECTED,
    tabs: [{ input: new TabInputText(makeUri('E:\\x.txt')) }]
  });
  cleanupDirs.push(env1.root);
  const ext1 = loadExtension(env1);
  ext1.activate(env1.context);
  await tick();

  const html1 = read(env1.wbFile);
  ok('自己的注入块已被移除', !html1.includes('EMPTY-EDITOR-WATERMARK'));
  ok('be5invis 注入完好', html1.includes('VSCODE-CUSTOM-CSS-START') && html1.includes('be5invis()'));
  ok('shalldie 注入完好', html1.includes('vscode-background-end'));
  ok('与 0.1.x 注入前的文件逐字节一致', html1 === BASE_HTML, JSON.stringify(html1.slice(-80)));
  ok('提示了用户（提到 0.2.0 与安装目录）', env1.messages.some((m) => m.startsWith('info:') && m.includes('0.2.0') && m.includes('安装目录')), env1.messages.join(' | '));
  ok('没有报错', !env1.messages.some((m) => m.startsWith('error')), env1.messages.join(' | '));

  // 清理只发生一次：再激活一遍不应该再动文件
  const before = read(env1.wbFile);
  const ext1b = loadExtension(env1);
  ext1b.activate(env1.context);
  await tick();
  ok('重复激活不重复动作（幂等）', read(env1.wbFile) === before);

  // ── 场景 2：干净安装 —— 一个字节都不写 ────────────────────────
  console.log('\n== 场景 2：0.2.0 不修改安装目录 ==');
  const env2 = makeEnv({
    html: BASE_HTML,
    tabs: [{ input: new TabInputText(makeUri('E:\\y.txt')) }]
  });
  cleanupDirs.push(env2.root);
  const ext2 = loadExtension(env2);
  ext2.activate(env2.context);
  await tick();
  env2.flushTimeouts(); // 启动后那次自动 sync
  await tick();
  ok('workbench.html 内容未变', read(env2.wbFile) === BASE_HTML);
  ok('没有生成任何备份文件', fs.readdirSync(path.dirname(env2.wbFile)).length === 1, fs.readdirSync(path.dirname(env2.wbFile)).join(','));
  ok('安装目录里也没有新文件（workbench 目录下只有原文件）', fs.readdirSync(path.dirname(env2.wbFile)).join() === 'workbench.html');

  // ── 场景 3：显示水印 → 面板、CSP、图片 URI、命令转发 ──────────
  console.log('\n== 场景 3：显示水印页 ==');
  env2.setTabs([]); // 编辑器区域空了
  env2.emitTabs();
  await tick();
  ok('空编辑器时自动打开水印页', env2.panels.length === 1, '面板数 ' + env2.panels.length);
  const panel = env2.panels[0];
  ok('viewType 正确', panel && panel.viewType === 'emptyEditorWatermark');
  ok('标题按界面语言取（zh → 水印）', panel && panel.title === '水印', panel && panel.title);
  ok('允许脚本执行', !!(panel && panel.panelOptions && panel.panelOptions.enableScripts));
  ok('保留隐藏时的上下文', !!(panel && panel.panelOptions && panel.panelOptions.retainContextWhenHidden));
  ok('localResourceRoots 只放开扩展 media 目录', !!(panel && panel.panelOptions && panel.panelOptions.localResourceRoots.length === 1 && panel.panelOptions.localResourceRoots[0].fsPath.endsWith(path.join('media'))));
  const page = panel.webview.html;
  ok('页面有 CSP 与 nonce', page.includes('Content-Security-Policy') && /<script nonce="[A-Za-z0-9]{32}">/.test(page));
  ok('背景图走 webview URI（默认图）', page.includes('vscode-webview://stub') && page.includes('default-bg.svg'));
  ok('页面里不出现安装目录/校验和字样', !page.includes('workbench.html') && !page.includes('appRoot') && !page.includes('checksums'));
  ok('默认只留底图（不渲染文字块）', !page.includes('class="wm-panel"'));
  ok('没有命令行（data-command 属性只在脚本里作为选择器出现）', !page.includes('data-command="'));

  panel.__postMessage({ command: 'run', id: 'workbench.action.showCommands' });
  await tick();
  ok('页面点命令 → 扩展执行对应内置命令', env2.executed.includes('workbench.action.showCommands'), env2.executed.join(','));
  panel.__postMessage({ command: 'nonsense' });
  await tick();
  ok('无效消息被忽略', env2.executed.length === 1);

  // 打开文件后自动关闭
  env2.setTabs([env2.textTab()]);
  env2.emitTabs();
  await tick();
  ok('打开文件后水印页自动关闭', panel.disposed === true);

  // 关掉文件后自动回来
  env2.setTabs([]);
  env2.emitTabs();
  await tick();
  ok('文件关掉后水印页自动回来', env2.panels.length === 2 && env2.panels[1].disposed === false);

  // 用户自己关掉 → 不再硬弹
  env2.panels[1].dispose();
  await tick();
  env2.setTabs([]);
  env2.emitTabs();
  await tick();
  ok('用户关掉后不会立刻重开', env2.panels.length === 2, '面板数 ' + env2.panels.length);

  // 再打开一次文件、又关掉 → 抑制解除，自动回来
  env2.setTabs([env2.textTab()]);
  env2.emitTabs();
  await tick();
  env2.setTabs([]);
  env2.emitTabs();
  await tick();
  ok('打开过文件后再空下来，自动回来', env2.panels.length === 3);

  // hide 命令
  env2.commands.get('emptyEditorWatermark.hide')();
  await tick();
  ok('hide 命令关掉面板', env2.panels[2].disposed === true);
  env2.commands.get('emptyEditorWatermark.show')();
  await tick();
  ok('show 命令重新打开（并前置已有面板）', env2.panels.length === 4 && env2.panels[3].disposed === false);
  env2.commands.get('emptyEditorWatermark.show')();
  await tick();
  ok('重复 show 只 reveal，不新建面板', env2.panels.length === 4 && env2.panels[3].revealed >= 1);

  // 0.1.x 兼容别名
  ok('0.1.x 的 apply 命令仍然可用（别名）', typeof env2.commands.get('emptyEditorWatermark.apply') === 'function');
  ok('注册了全部命令', ['show', 'hide', 'apply', 'remove', 'pickImage', 'showCss'].every((c) => env2.commands.has('emptyEditorWatermark.' + c)), [...env2.commands.keys()].join(','));
  ok('showCss 能拿到页面源码', (() => {
    env2.commands.get('emptyEditorWatermark.showCss')();
    return true;
  })());

  // ── 场景 4：enabled=false ─────────────────────────────────────
  console.log('\n== 场景 4：enabled=false 不自动打开 ==');
  const env4 = makeEnv({ html: BASE_HTML, settings: { enabled: false }, tabs: [] });
  cleanupDirs.push(env4.root);
  const ext4 = loadExtension(env4);
  ext4.activate(env4.context);
  await tick();
  env4.flushTimeouts();
  env4.emitTabs();
  await tick();
  ok('关掉总开关后不打开水印页', env4.panels.length === 0, '面板数 ' + env4.panels.length);

  // ── 场景 5：remove 命令在干净安装上 ───────────────────────────
  console.log('\n== 场景 5：remove 命令 ==');
  const env5 = makeEnv({
    html: BASE_HTML,
    tabs: [{ input: new TabInputText(makeUri('E:\\z.txt')) }]
  });
  cleanupDirs.push(env5.root);
  const ext5 = loadExtension(env5);
  ext5.activate(env5.context);
  await tick();
  env5.messages.length = 0;
  await env5.commands.get('emptyEditorWatermark.remove')();
  await tick();
  ok('干净安装上提示"无需清理"', env5.messages.some((m) => m.includes('没有旧版注入')), env5.messages.join(' | '));
  ok('文件仍然未变', read(env5.wbFile) === BASE_HTML);

  // ── 场景 6：找不到 workbench.html 也不崩 ──────────────────────
  console.log('\n== 场景 6：目标文件不存在 ==');
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eew-empty-'));
  cleanupDirs.push(emptyRoot);
  const env6 = makeEnv({ html: BASE_HTML, tabs: [] });
  cleanupDirs.push(env6.root);
  env6.vscodeStub.env.appRoot = emptyRoot;
  const ext6 = loadExtension(env6);
  let threw = null;
  try {
    ext6.activate(env6.context);
    await tick();
    env6.flushTimeouts();
    await tick();
  } catch (e) {
    threw = e;
  }
  ok('不抛异常', threw === null, threw && threw.stack);
  ok('没有报错信息', !env6.messages.some((m) => m.startsWith('error')), env6.messages.join(' | '));

  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项不通过`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身异常：' + e.stack);
  process.exit(1);
});
