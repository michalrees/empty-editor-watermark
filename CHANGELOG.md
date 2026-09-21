# Changelog

本文件记录 `YuHaoran251.empty-editor-watermark` 的对外变更。

## 0.2.0 — 2026-09-21

**主题：不再修改 VS Code 安装目录。** 这一版是修 0.1.0 带出去的那个坑——
所有装了本扩展的用户启动 VS Code 时都会看到「Your Code installation appears to be corrupt. Please reinstall.」。

### 根因

VS Code 1.9x 起，workbench 的 `IntegrityService` 会在启动时读 `product.json` 的 `checksums`，
把列出的核心文件逐个做 SHA256 校验（`vs/code/electron-browser/workbench/workbench.html` 就在列表里），
任一对不上就记 `*** Installation has been modified on disk ***` 并弹「安装似乎损坏，请重新安装」。
0.1.x 为了注入样式必然改写这个文件，于是**每个用户都会中招**；点「Don't Show Again」也没用，
它的抑制记录带 commit，VS Code 一更新就失效、又弹。

本机 1.138.0（commit `7debcd0e`）实测：10 个受校验文件里 9 个一致，**唯一不一致的就是 `workbench.html`**。

### 变更

- **破坏性（实现方式）**：水印改为**独立 Webview 页** —— 编辑器区域为空时自动打开，打开文件时自动关闭。
  安装目录一个字节都不碰，校验和永远通过。代价是它成了标签页，而不是"长在空编辑器里"。
- **自动清理旧版注入**：激活时（幂等）删掉 `<!-- EMPTY-EDITOR-WATERMARK:START --> … END -->` 那一段，
  `be5invis.vscode-custom-css` / `shalldie.background` 等别家注入原样保留；清完提示重载窗口，提示即消失。
  权限不足（Program Files 下的 `EPERM`）会给出"以管理员身份重启"的指引。
- 新增命令：`显示水印`、`关闭水印`、`查看水印页源码`；`显示/刷新水印（0.1.x 兼容别名）` 保留旧 id `emptyEditorWatermark.apply`。
- `清理旧版注入` 取代了原来的 `移除水印（还原 workbench.html）`（命令 id `emptyEditorWatermark.remove` 不变）。
- 新增设置：`autoOpen`、`closeWhenEditorOpens`、`panelTitle`。
- 改设置**立刻生效**（Webview 重渲染），不再需要重载窗口。
- 页面文案按界面语言自动选中/英，快捷键按平台显示（`Ctrl+Shift+P` / `⇧⌘P`）。
- 安全：页面用 CSP + nonce，禁用外部资源；图片 URI 与文案均做转义。
- 自检从两套换成三套（`check-page` / `check-legacy` / `check-apply`），其中端到端冒烟新增断言：
  **干净的安装目录不得被写入任何字节、不得产生新文件**。

### 升级注意

- 装 0.2.0 后请按提示重载一次窗口（清理旧注入后需要重载，「安装似乎损坏」才会消失）。
- 0.1.x 的备份文件 `workbench.html.bak-empty-editor-watermark` 不参与校验，可自行删除。
- 旧设置项名字与默认值保持兼容，无需改 `settings.json`。

## 0.1.0 — 2026-09-16

- 首发：自带注入器，把 `<style>` 写进安装目录的 `workbench.html`，给空编辑器铺背景图、
  隐藏内置 logo 与快捷键列表；支持 `cover`/`contain`、透明度、位置、缩放、磨砂底。
- 已知问题（0.2.0 修复）：触发 VS Code 完整性校验，用户会看到「安装似乎损坏，请重新安装」。
