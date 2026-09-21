# Empty Editor Watermark

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/YuHaoran251.empty-editor-watermark?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=YuHaoran251.empty-editor-watermark)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/YuHaoran251.empty-editor-watermark)](https://marketplace.visualstudio.com/items?itemName=YuHaoran251.empty-editor-watermark)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给**空编辑器**（那个显示 VS logo 与快捷键提示的"水印"区域）铺一张自定义背景图，并可选择隐藏 logo 与快捷键提示——**自带注入器，不需要 `be5invis.vscode-custom-css`，也不用把 CSS 复制到别处、不用手写 `vscode_custom_css.imports`**；并顺手把 VS Code 因为这次注入而弹出的**「安装似乎损坏，请重新安装」通知隐藏掉**（纯 CSS，不改 CSP、不改校验逻辑）。

```bash
code --install-extension YuHaoran251.empty-editor-watermark
```

## 它做什么

- 空编辑器背景图：`cover` / `contain`、透明度、任意图片路径（含 `~` 与 `file:///` 写法）
- 隐藏 VS Code logo（`.letterpress`）与快捷键提示列表（`.shortcuts`），只留底图
- 水印文字块的位置（右上/左上/右下/左下/居中）、缩放、宽度、字号，可选磨砂底
- **隐藏「安装似乎损坏」通知**（默认开，`hideCorruptNotice`）——见下一节，这是"改过安装目录"必然带来的副作用的对治
- **VS Code 更新后自动重注入**：更新会换掉安装目录里的哈希子目录，注入必然丢失；本扩展启动时检测到注入缺失/过期就自动补齐并提示重载
- 只处理自己那两段注入：与其它注入类扩展（`be5invis.vscode-custom-css`、`shalldie.background`）互不破坏

## 为什么必须写 `workbench.html`

VS Code **没有**任何公开 API 能给工作台注入 CSS —— 1.138 自带的 `vscode.d.ts`（763 KB，权威 API 面）里搜不到 css / inject / workbench 相关 API。所有做背景图、改水印外观的扩展（包括 `be5invis.vscode-custom-css`、`shalldie.background`、`subframe7536/vscode-custom-ui-style`）走的都是同一条路：**直接往安装目录的 `workbench.html` 里写一段 `<style>`**。

因此本扩展会：

1. 用 `vscode.env.appRoot` 定位 `<安装目录>/<哈希>/resources/app/out/vs/code/electron-browser/workbench/workbench.html`（同时处理 `workbench.esm.html`，存在才动）
2. 首次改动前把原文件备份成 `workbench.html.bak-empty-editor-watermark`
3. 把样式包在自己的标记之间插到 `</html>` 之前（反复注入原地替换，不会累积；文档顺序靠后 → 同等特异性下压过别的注入）：
   - 底图：`<!-- EMPTY-EDITOR-WATERMARK:START --> … END -->`
   - 通知隐藏：`<!-- EMPTY-EDITOR-WATERMARK-NOTICE:START --> … END -->`
4. `移除水印` 把这两段都删掉，别家注入原样保留

**首次运行会先问一次**是否允许修改安装目录（之后一直自动，含 VS Code 更新后）。

> CSP 说明：上游 1.138 的 `workbench.html` 里 `style-src 'self' 'unsafe-inline'`（内联 `<style>` 允许），而 `script-src 'self' 'unsafe-eval' blob:`（**没有** `unsafe-inline`，内联脚本会被拦）。所以本扩展只注入 CSS，**不需要像 be5invis 那样把整行 CSP 删掉**。

## 「安装似乎损坏」是怎么回事，以及本扩展怎么处理

VS Code 1.9x 起，workbench 的 `IntegrityService` 会在启动时读 `product.json` 的 `checksums`，把列出的核心文件逐个做 SHA256 校验（`vs/code/electron-browser/workbench/workbench.html` 就在列表里），**只要有一个对不上**，就写日志 `*** Installation has been modified on disk ***` 并弹出：

> 你的 Code 安装似乎损坏。请重新安装。  （按钮：更多信息 / 不再显示）

而本扩展的工作方式就是改这个文件，所以这条提示**必然**出现——它不是"Code 坏了"，VS Code 功能完全正常，只是它没法再自证文件未被改动。点「不再显示」也只对当前版本有效：那条抑制记录带着 commit（`{dontShowPrompt, commit}`），VS Code 一更新就失效、又弹。

既然文件是**按你明确意图**改的，这条提示就没有可用信息，于是本扩展往 `workbench.html` 注入一段纯 CSS 把它隐藏：

- 覆盖 **toast**（`.notification-toast-container` / `.notification-toast`）与**通知中心列表**（`.notifications-list-container` 里的 `.notification-list-item` / `.monaco-list-row`）——只盖 toast 是不够的，从铃铛里点开还能看到
- 匹配依据是通知元素上的 `aria-label`（本地化后的消息文本），内置 **15 种语言**（含中英日韩俄德法西意葡波捷土 + 伪本地化构建），见 `src/injector.ts` 的 `CORRUPT_NOTICE_TEXTS`
- 只做显示层隐藏：**不改 CSP、不改 `product.json`、不碰校验逻辑**，也不动 `workbench.desktop.main.js`

已知边界（写在这里以免踩坑）：

- VS Code 改这段文案或通知 DOM 结构后，隐藏可能失效 —— 届时在 `CORRUPT_NOTICE_TEXTS` 里补字符串、或按新类名改 `NOTICE_TARGETS` 即可（`npm run check` 会提示当前覆盖项）
- 状态栏铃铛的**未读计数**由 VS Code 的模型决定（不是 DOM），隐藏条目后计数仍可能 +1；点开列表里那条已经被隐藏
- 不想隐藏就把 `emptyEditorWatermark.hideCorruptNotice` 置 `false`（会移除通知隐藏块，其余效果不变）
- 说白了这是**把一个完整性告警盖掉**：它同时也盖住了"别人改过你的安装目录"这种情况。你要的是"自己按需美化 + 别被吓到"，这个取舍由你决定

## 安装与使用

1. 安装扩展（或本地 `.vsix` 安装），重载窗口
2. 首次会弹出提示 → 选 **应用水印**
3. 若写入失败报 `EPERM/EACCES`：**以管理员身份重启 VS Code** 再执行一次命令（Program Files 下的安装目录默认不给普通用户写权限）
4. 之后改任何设置都会自动重注入，**需要重载窗口生效**（扩展会给出「立即重载窗口」按钮）

### 命令（命令面板搜 `Watermark`）

| 命令 | 作用 |
|---|---|
| `Watermark: 应用/更新水印` | 写入/刷新注入（底图块 + 通知隐藏块） |
| `Watermark: 移除水印（还原 workbench.html）` | 只删本扩展那两段注入 |
| `Watermark: 选择背景图…` | 选图 → 写入 `imagePath` → 立即应用 |
| `Watermark: 查看生成的水印 CSS` | 把当前会生成的全部 CSS（含通知隐藏规则）开成只读文档，便于核对/排查 |

### 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `emptyEditorWatermark.enabled` | `true` | 总开关；关闭会移除已写入的样式 |
| `emptyEditorWatermark.hideCorruptNotice` | `true` | 隐藏「安装似乎损坏」通知（见上一节） |
| `emptyEditorWatermark.imagePath` | `""` | 背景图绝对路径；留空用扩展自带的自制默认图 |
| `emptyEditorWatermark.imageFit` | `cover` | `cover` 铺满裁切 / `contain` 完整留白 |
| `emptyEditorWatermark.opacity` | `0.9` | 图片透明度，只作用于图片 |
| `emptyEditorWatermark.position` | `top-right` | 水印文字块位置（隐藏 logo+命令时无视觉影响） |
| `emptyEditorWatermark.scale` | `0.48` | 文字块缩放 |
| `emptyEditorWatermark.hideLogo` | `true` | 隐藏 VS logo |
| `emptyEditorWatermark.hideCommands` | `true` | 隐藏快捷键提示列表 |
| `emptyEditorWatermark.panelWidth` | `261` | 文字块宽度（px） |
| `emptyEditorWatermark.panelFontSize` | `19` | 文字块基准字号（px） |
| `emptyEditorWatermark.frostedPanel` | `false` | 给文字块加半透明磨砂底 |

## 从 `be5invis.vscode-custom-css` 迁移

你可以在两者共存的情况下平滑切换（本扩展的注入在文档顺序上更靠后，同特异性下生效）：

1. 装本扩展 → 首次提示选 **应用水印** → 重载窗口，确认效果与之前一致（底图、隐藏 logo/命令、透明度）
2. 确认无误后，从 `settings.json` 的 `vscode_custom_css.imports` 里**删掉指向 `welcome.css` 的那一行**（动画那行 `updateHandler.js` 想留着就留着）
3. 命令面板 → `Disable Custom CSS and JS`（`extension.uninstallCustomCSS`）移除 be5invis 的注入，或执行 `Reload Custom CSS and JS` 只刷新
4. 重载窗口。此时安装目录里只剩本扩展的注入

> ⚠️ 顺序别反：先让本扩展生效、确认效果，再去掉 be5invis 那一路。中途如果两边都不生效，`workbench.html.bak-empty-editor-watermark` 和 be5invis 的 `.bak-custom-css` 都还在，可以手动还原。

## 卸载 / 还原

- 想干净还原：先执行 `Watermark: 移除水印`，再卸载扩展
- 忘记执行就卸载了：把 `workbench.html.bak-empty-editor-watermark` 覆盖回 `workbench.html`（注意这份备份是**首次注入前的原样**，若期间 be5invis 又注入过，用它覆盖会把那边一起清掉 —— 更稳的做法是手动删掉 `EMPTY-EDITOR-WATERMARK` 与 `EMPTY-EDITOR-WATERMARK-NOTICE` 两组标记之间的内容）
- 卸载扩展**不会**自动改回安装目录（改安装目录属于显式动作，交给用户决定）

## 已知限制

- **改设置后要重载窗口**才生效：样式是内联写进 `workbench.html` 的，没法不重载热更（同类扩展的通病）
- 通知隐藏靠文案/DOM 匹配，VS Code 改版后可能失效（见上文「已知边界」）
- 窄窗口（≤900px）时文字块自动退回居中，避免压到别的内容
- 图片是**就地读取**的：移动/删除原图后需要重新应用（会退回扩展自带默认图并提示）
- 只支持桌面版 VS Code（需要能写安装目录）；Web / vscode.dev 不适用

## 版本沿革（为什么 0.2.0 又退回 0.1.x 的实现）

| 版本 | 实现 | 备注 |
|---|---|---|
| 0.1.0 | 注入 `<style>` 铺空编辑器底图 | 会触发 VS Code 的「安装似乎损坏」通知 |
| 0.2.0 | 改为独立 Webview 页（不碰安装目录） | 提示不再出现，但形态从"空编辑器里的底图"变成"一个标签页"，观感变了 |
| **0.2.1** | **回到注入实现（空编辑器底图），并新增隐藏「安装似乎损坏」通知的纯 CSS** | 观感与 0.1.x 一致；用 0.2.0 的用户升级即可回到原形态 |

## 开发

```bash
npm install
npm run compile      # 编译到 out/
npm run watch        # 增量编译
npm run check        # compile + 两套自检
npm run package      # 生成 .vsix
```

调试：用 VS Code 打开本目录按 `F5` 起扩展开发宿主；或直接把工程目录做成扩展目录的 junction 联调：

```powershell
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\yuhaoran251.empty-editor-watermark" "<你的工程目录>"
```

> 两套自检（`npm run check` 会依次跑）：
>
> - `tools/check-injector.js` —— 纯函数单测：URL 转换、底图 CSS 生成、`patchHtml` 幂等、`stripBlock` 只删自己、往返回原，
>   以及**通知隐藏**：15 种文案都在、`:is()/:has()` 折叠成一条规则、纯 CSS 无脚本、`applyBlocks` 开关某一块时字节稳定
> - `tools/check-apply.js` —— 端到端冒烟：stub 掉 `vscode` 后真跑一遍 `activate()` / 各命令，目标是一个**临时 appRoot 里的 workbench.html 副本**，
>   断言两段注入的位置、备份、幂等、设置更新（含 `hideCorruptNotice` 开关）、移除后逐字节还原、目标缺失不崩。**绝不碰真实安装目录**
>
> **改注入逻辑或写文件逻辑后请先跑 `npm run check`。**

## 许可

MIT。`media/default-bg.svg`（默认底图）与 `media/icon.png` 均为本扩展作者自制，随 MIT 一并授权。
