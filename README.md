# Empty Editor Watermark

给**空编辑器**（那个显示 VS logo 与快捷键提示的"水印"区域）铺一张自定义背景图，并可选择隐藏 logo 与快捷键提示——**自带注入器，不需要 `be5invis.vscode-custom-css`，也不用把 CSS 复制到别处、不用手写 `vscode_custom_css.imports`**。

## 它做什么

- 空编辑器背景图：`cover` / `contain`、透明度、任意图片路径（含 `~` 与 `file:///` 写法）
- 隐藏 VS Code logo（`.letterpress`）与快捷键提示列表（`.shortcuts`），只留底图
- 水印文字块的位置（右上/左上/右下/左下/居中）、缩放、宽度、字号，可选磨砂底
- **VS Code 更新后自动重注入**：更新会换掉安装目录里的哈希子目录，注入必然丢失；本扩展启动时检测到注入缺失/过期就自动补齐并提示重载
- 只处理自己那段注入：与其它注入类扩展（`be5invis.vscode-custom-css`、`shalldie.background`）互不破坏

## 为什么必须写 `workbench.html`

VS Code **没有**任何公开 API 能给工作台注入 CSS —— 本机 1.138 自带的 `vscode.d.ts`（763 KB，权威 API 面）里搜不到 css / inject / workbench 相关 API。所有做背景图、改水印外观的扩展（包括 `be5invis.vscode-custom-css`、`shalldie.background`）走的都是同一条路：**直接往安装目录的 `workbench.html` 里写一段 `<style>`**。

因此本扩展会：

1. 用 `vscode.env.appRoot` 定位 `<安装目录>/<哈希>/resources/app/out/vs/code/electron-browser/workbench/workbench.html`（同时处理 `workbench.esm.html`，存在才动）
2. 首次改动前把原文件备份成 `workbench.html.bak-empty-editor-watermark`
3. 把样式包在 `<!-- EMPTY-EDITOR-WATERMARK:START --> … END -->` 之间插到 `</html>` 之前（反复注入原地替换，不会累积；文档顺序靠后 → 同等特异性下压过别的注入）
4. `移除水印` 只删自己那一段，别家注入原样保留

**首次运行会先问一次**是否允许修改安装目录（之后一直自动，含 VS Code 更新后）。

## 安装与使用

1. 安装扩展（或本地 `.vsix` 安装），重载窗口
2. 首次会弹出提示 → 选 **应用水印**
3. 若写入失败报 `EPERM/EACCES`：**以管理员身份重启 VS Code** 再执行一次命令（Program Files 下的安装目录默认不给普通用户写权限）
4. 之后改任何设置都会自动重注入，**需要重载窗口生效**（扩展会给出「立即重载窗口」按钮）

### 命令（命令面板搜 `Watermark`）

| 命令 | 作用 |
|---|---|
| `Watermark: 应用/更新水印` | 写入/刷新注入 |
| `Watermark: 移除水印（还原 workbench.html）` | 只删本扩展那段注入 |
| `Watermark: 选择背景图…` | 选图 → 写入 `imagePath` → 立即应用 |
| `Watermark: 查看生成的水印 CSS` | 把当前会生成的 CSS 开成只读文档，便于核对/排查 |

### 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `emptyEditorWatermark.enabled` | `true` | 总开关；关闭会移除已写入的样式 |
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
4. 重载窗口。此时安装目录里只剩本扩展一段注入

> ⚠️ 顺序别反：先让本扩展生效、确认效果，再去掉 be5invis 那一路。中途如果两边都不生效，`workbench.html.bak-empty-editor-watermark` 和 be5invis 的 `.bak-custom-css` 都还在，可以手动还原。

## 卸载 / 还原

- 想干净还原：先执行 `Watermark: 移除水印`，再卸载扩展
- 忘记执行就卸载了：把 `workbench.html.bak-empty-editor-watermark` 覆盖回 `workbench.html`（注意这份备份是**首次注入前的原样**，若期间 be5invis 又注入过，用它覆盖会把那边一起清掉 —— 更稳的做法是手动删掉 `EMPTY-EDITOR-WATERMARK:START/END` 之间的内容）
- 卸载扩展**不会**自动改回安装目录（改安装目录属于显式动作，交给用户决定）

## 已知限制

- **改设置后要重载窗口**才生效：样式是内联写进 `workbench.html` 的，没法在不重载的情况下热更（这也是所有同类扩展的通病）
- VS Code 仍会提示「安装已修改」（`*** Installation has been modified on disk ***`）—— 这是注入类扩展的必然结果，点 Don't show again 即可；本扩展不做 checksum 修补
- 窄窗口（≤900px）时文字块自动退回居中，避免压到别的内容
- 图片是**就地读取**的：移动/删除原图后需要重新应用（会退回扩展自带默认图并提示）
- 只支持桌面版 VS Code（需要能写安装目录）；Web / vscode.dev 不适用

## 开发

```bash
npm install
npm run compile      # 编译到 out/
npm run watch        # 增量编译
npm run check        # compile + 两套自检（注入器单测 + 端到端冒烟）
npm run package      # 生成 .vsix
```

调试：用 VS Code 打开本目录按 `F5` 起扩展开发宿主；或直接把工程目录做成扩展目录的 junction 联调：

```powershell
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\yuhaoran251.empty-editor-watermark" "<你的工程目录>"
```

> 两套自检（`npm run check` 会依次跑）：
>
> - `tools/check-injector.js` —— 纯函数单测：URL 转换、CSS 生成、patch 幂等、strip 只删自己、patch→strip 往返还原。注入器被刻意写成不 import `vscode` 的纯函数，就是为了能直接 require 编译产物来测
> - `tools/check-apply.js` —— 端到端冒烟：stub 掉 `vscode` 后真跑一遍 `activate()` / `apply()` / `remove()`，目标是一个**临时 appRoot 里的 workbench.html 副本**，断言注入位置、备份、幂等、设置更新、移除后逐字节还原、目标缺失不崩。**绝不碰真实安装目录**
>
> **改注入逻辑或写文件逻辑后请先跑 `npm run check`。**

## 许可

MIT。`media/default-bg.svg`（默认底图）与 `media/icon.png` 均为本扩展作者自制，随 MIT 一并授权。
