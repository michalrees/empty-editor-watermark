# Empty Editor Watermark

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/YuHaoran251.empty-editor-watermark?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=YuHaoran251.empty-editor-watermark)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/YuHaoran251.empty-editor-watermark)](https://marketplace.visualstudio.com/items?itemName=YuHaoran251.empty-editor-watermark)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给**空编辑器**铺一张自定义背景图：编辑器区域空下来时自动打开一个水印页，打开文件时自动关掉，行为对齐 VS Code 内置的那块水印区域。

```bash
code --install-extension YuHaoran251.empty-editor-watermark
```

> **0.2.0 起不再修改 VS Code 安装目录。** 0.1.x 是往安装目录的 `workbench.html` 里写 `<style>`，那会让 VS Code 的完整性校验失败，用户每次启动都会看到
> **「你的 Code 安装似乎损坏，请重新安装」**。0.2.0 改成独立 Webview 页实现，安装目录一个字节都不碰。
> 升级后本扩展会**自动把旧版注入清掉**（详见下面的「从 0.1.x 升级」）。

## 它做什么

- 编辑器区域为空时自动显示水印页；打开文件后自动关闭（`closeWhenEditorOpens`）
- 背景图：`cover` / `contain`、透明度、任意绝对路径（支持 `~`、`file:///`）或 `http(s)` 地址
- 可选文字块：标识文字 + 三条命令（显示所有命令 / 打开文件 / 克隆 Git 仓库，点一下真的执行），
  位置（右上/左上/右下/左下/居中）、缩放、宽度、字号、磨砂底
- 改设置立刻生效（Webview 直接重渲染），**不需要重载窗口**
- 中英文案按界面语言自动选，快捷键按平台显示（`Ctrl+Shift+P` / `⇧⌘P`）

## 为什么是 Webview：那条「安装似乎损坏」是怎么来的

VS Code **没有**任何公开 API 能给工作台注入 CSS（1.138 自带的 `vscode.d.ts` 里搜不到 css / inject / workbench 相关 API）。
所以做背景图/改水印外观的扩展（`be5invis.vscode-custom-css`、`shalldie.background`、`subframe7536/vscode-custom-ui-style` …）
走的都是同一条路：直接往安装目录的 `workbench.html` 写 `<style>`。

而 VS Code 1.9x 起在 **workbench 的 `IntegrityService`** 里加了自校验：启动时读 `product.json` 的 `checksums`，
把列出的核心文件（其中就有 `vs/code/electron-browser/workbench/workbench.html`）逐个做 SHA256 比对，
只要有一个对不上就写日志 `*** Installation has been modified on disk ***` 并弹出
**「Your Code installation appears to be corrupt. Please reinstall.」**（按钮：More Information / Don't Show Again）。

也就是说：**只要扩展改过 `workbench.html`，所有用户都会看到这条提示**，点「Don't Show Again」也只能压到下个 VS Code 版本——
它的抑制记录带着 commit（`{dontShowPrompt, commit}`），VS Code 一更新就失效，于是又弹。

0.1.x 的实测证据（本机 1.138.0，commit `7debcd0e`）：

| product.json 里 checksums 列出的 10 个文件 | 校验结果 |
|---|---|
| 其余 9 个 | 全部一致 |
| `vs/code/electron-browser/workbench/workbench.html` | **唯一不一致**（被注入改写） |

0.2.0 的解法：**不碰安装目录**，改为打开一个属于本扩展的 Webview 页来铺背景图。
代价是它成了一个真正的标签页，而不是"长在空编辑器里"；换来的是安装目录始终原样、校验永远通过。

## 升级：从 0.1.x 到 0.2.0

装上新版并重载窗口后，扩展会在激活时做一次（幂等的）清理：

1. 找到 `<appRoot>/out/vs/code/electron-browser/workbench/workbench.html`（以及 `workbench.esm.html`，存在才处理）
2. 只删掉 `<!-- EMPTY-EDITOR-WATERMARK:START --> … END -->` 这一段 —— `be5invis` / `shalldie` 等**别家的注入原样保留**
3. 提示「立即重载窗口」；重载后 `workbench.html` 的校验和重新对得上，那条提示消失

> - 清理是**写安装目录**的动作，Program Files 下可能报 `EPERM`：以管理员身份重启 VS Code，再执行命令
>   `Watermark: 清理旧版注入（0.1.x 写进安装目录的样式）`。
> - 0.1.x 留下的备份 `workbench.html.bak-empty-editor-watermark` 不会被自动删除（它只是一份文件，
>   不参与校验，可自行清理）。
> - 如果你同时装了 `be5invis.vscode-custom-css` 或 `shalldie.background`，它们仍然会改 `workbench.html`，
>   于是那条提示还会出现 —— 那是它们造成的，与本扩展无关；解决办法是改用不写安装目录的方案，或点 Don't Show Again。
> - 忘记先升级就卸载了 0.1.x？手动删掉 `workbench.html` 里 `EMPTY-EDITOR-WATERMARK:START/END` 之间的内容即可。

## 命令（命令面板搜 `Watermark`）

| 命令 | 作用 |
|---|---|
| `Watermark: 显示水印` | 打开/前置水印页（也会解除"用户刚关掉"的抑制） |
| `Watermark: 关闭水印` | 关掉水印页 |
| `Watermark: 选择背景图…` | 选图 → 写入 `imagePath` → 立即生效 |
| `Watermark: 查看水印页源码` | 把当前渲染出的 HTML 开成只读文档，便于核对/排查 |
| `Watermark: 清理旧版注入（0.1.x 写进安装目录的样式）` | 手动再清一次（失败时给管理员提示） |
| `Watermark: 显示/刷新水印（0.1.x 兼容别名）` | 老命令名 `emptyEditorWatermark.apply` 的别名 |

## 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `emptyEditorWatermark.enabled` | `true` | 总开关；关闭后不再自动显示，并关掉已打开的水印页 |
| `emptyEditorWatermark.autoOpen` | `true` | 编辑器区域为空时自动打开 |
| `emptyEditorWatermark.closeWhenEditorOpens` | `true` | 打开文件后自动关闭 |
| `emptyEditorWatermark.panelTitle` | `""` | 标签页标题；留空 = 按界面语言（水印 / Watermark） |
| `emptyEditorWatermark.imagePath` | `""` | 背景图绝对路径；留空用扩展自带的自制默认图；支持 `~`、`file:///`、`http(s)` |
| `emptyEditorWatermark.imageFit` | `cover` | `cover` 铺满裁切 / `contain` 完整留白 |
| `emptyEditorWatermark.opacity` | `0.9` | 图片透明度，只作用于图片，不影响文字 |
| `emptyEditorWatermark.position` | `top-right` | 文字块位置（隐藏文字块时无视觉影响） |
| `emptyEditorWatermark.scale` | `0.48` | 文字块缩放 |
| `emptyEditorWatermark.hideLogo` | `true` | 隐藏文字块顶部的标识文字（默认只留底图） |
| `emptyEditorWatermark.hideCommands` | `true` | 隐藏命令列表 |
| `emptyEditorWatermark.panelWidth` | `261` | 文字块宽度（px） |
| `emptyEditorWatermark.panelFontSize` | `19` | 文字块基准字号（px） |
| `emptyEditorWatermark.frostedPanel` | `false` | 给文字块加半透明磨砂底 |

> 0.1.x 的设置项名字全部保留，语义基本不变：`hideLogo` / `hideCommands` 现在作用在**本扩展自己渲染的文字块**上
> （0.1.x 是去隐藏 VS Code 内置的那个文字块）。默认两项都是 `true`，所以默认效果仍然是「只有一张底图」。

## 卸载 / 还原

- 0.2.0 不修改任何 VS Code 文件，**直接卸载即可**，不需要还原步骤
- 从 0.1.x 升级上来且还没清理：卸载前先执行一次 `Watermark: 清理旧版注入…`，或手动删掉标记之间的内容
- 后台若提示「安装已修改」（`*** Installation has been modified on disk ***`），那是 `be5invis` / `shalldie`
  之类仍然在写 `workbench.html` 的扩展造成的

## 已知限制

- 水印是一个**标签页**（Webview 面板），会出现在标签栏里；VS Code 没有"在空编辑器区域里画东西"的公开 API
- `closeWhenEditorOpens` 打开时，最后一个文件一关就会自动回来；不想要就把 `autoOpen` 或 `enabled` 关掉
- 图片是**就地读取**的：移动/删除原图后重启窗口会退回扩展自带默认图并提示
- 桌面版与 vscode.dev 都可以用（不写文件系统），但远程/Web 场景下图必须能被渲染进程访问到

## 开发

```bash
npm install
npm run compile      # 编译到 out/
npm run watch        # 增量编译
npm run check        # compile + 三套自检
npm run package      # 生成 .vsix
```

调试：用 VS Code 打开本目录按 `F5` 起扩展开发宿主；或把工程目录 junction 到扩展目录联调：

```powershell
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\yuhaoran251.empty-editor-watermark" "<你的工程目录>"
```

三套自检（`npm run check` 依次跑）：

- `tools/check-page.js` —— 纯函数单测：枚举/数值兜底、HTML/CSS 转义、生成的页面里**不得出现安装目录相关字样**、
  CSP + nonce、默认只留底图、命令 id、中英文案与平台快捷键
- `tools/check-legacy.js` —— 旧版清理单测：标记常量必须与 0.1.x 一致、只删自己的块、别家注入完好、
  注入 → 清理**逐字节往返回原**、幂等、畸形文件不误删
- `tools/check-apply.js` —— 端到端冒烟：stub 掉 `vscode` 与 `setTimeout` 后真跑 `activate()` 与各命令，
  断言**干净的安装目录一个字节都不动**、旧注入被清掉、面板标题/CSP/图片 URI/命令转发、
  自动开关、用户关掉后不硬弹、`enabled=false`、目标缺失不崩

**改页面生成、文件读写或面板逻辑后，请先跑 `npm run check`。**

## 许可

MIT。`media/default-bg.svg`（默认底图）与 `media/icon.png` 均为本扩展作者自制，随 MIT 一并授权。
