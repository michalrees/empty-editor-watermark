# Changelog

本文件记录 `YuHaoran251.empty-editor-watermark` 的对外变更。

## 0.2.1 — 2026-09-21

**主题：回到 0.1.x 的注入实现（空编辑器里的底图），并顺手把「安装似乎损坏」通知隐藏掉。**

### 为什么回退 0.2.0 的 Webview 实现

0.2.0 用独立 Webview 页替代注入，确实让「安装似乎损坏」提示不再出现，但观感也变了：
空编辑器里那块底图变成了一个**标签页**，不再是"长在空编辑器里"的水印。0.2.1 恢复原形态，
改为正面处理那条提示——它是"改过安装目录"的必然结果，而文件是用户按自己意图改的。

### 变更

- **恢复注入实现**：`src/injector.ts` + `src/extension.ts` 回到 0.1.x 的路子
  （`vscode.env.appRoot` 定位 `workbench.html`、首次改动留 `.bak-empty-editor-watermark`、
  `EMPTY-EDITOR-WATERMARK:START/END` 之间原地替换、移除时只删自己那段）
- **新增 `emptyEditorWatermark.hideCorruptNotice`（默认 `true`）**：注入第二段纯 CSS
  （`EMPTY-EDITOR-WATERMARK-NOTICE:START/END`），隐藏 VS Code 的
  「{0} 安装似乎损坏，请重新安装」通知
  - 覆盖 toast 与**通知中心列表**（`.notification-toast-container`、`.notification-toast`、
    `.notifications-list-container` 里的 `.notification-list-item` / `.monaco-list-row`）——
    shalldie.background 只盖了 toast，从铃铛里点开仍能看到，这次一并盖上
  - 按通知上的 `aria-label`（本地化文案）匹配，内置 **15 种语言**（中英日韩俄德法西意葡波捷土 + 伪本地化）
  - 折叠成一条规则（`:is()` + `:has()`），不是每种语言一条；纯 CSS，**不改 CSP、不改 product.json、不碰校验逻辑**
- 新增 `applyBlocks()`：先剥掉本扩展所有注入块、再按启用项插回，使「开关任一块」只需一次写盘，
  且反复调用**字节稳定**（不会每次启动都改写文件）
- `查看生成的水印 CSS` 现在把通知隐藏规则一起展示；`移除水印` 两段都删
- 自检新增：通知文案/选择器/单规则/纯 CSS 断言、`applyBlocks` 幂等与开关往返、端到端冒烟里的 `hideCorruptNotice` 开关场景

### 升级注意

- 从 0.1.0 / 0.2.0 升上来都要**重载一次窗口**（注入只在窗口加载时生效）。
- 用 0.2.0 的用户：升级后会恢复"空编辑器里的底图"形态，同时安装目录重新出现本扩展的两段注入。
- 通知隐藏失效时（VS Code 改文案或通知 DOM）：在 `src/injector.ts` 的 `CORRUPT_NOTICE_TEXTS`
  补字符串、或按新类名改 `NOTICE_TARGETS`。

## 0.2.0 — 2026-09-21（已被 0.2.1 取代）

- 改为独立 Webview 水印页：不修改 VS Code 安装目录，「安装似乎损坏」提示不再出现，
  但空编辑器水印变成标签页形态；新增 `autoOpen` / `closeWhenEditorOpens` / `panelTitle`，
  改设置立即生效。
- 该实现已在 0.2.1 中撤销（见上）。

## 0.1.0 — 2026-09-16

- 首发：自带注入器，把 `<style>` 写进安装目录的 `workbench.html`，给空编辑器铺背景图、
  隐藏内置 logo 与快捷键列表；支持 `cover`/`contain`、透明度、位置、缩放、磨砂底。
- 已知问题：触发 VS Code 的完整性校验，用户会看到「安装似乎损坏，请重新安装」
  （0.2.1 起由 `hideCorruptNotice` 隐藏）。