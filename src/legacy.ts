/**
 * 旧版（0.1.x）方案的收尾模块 —— 纯函数，不 import 'vscode'。
 *
 * 0.1.x 的做法是往 VS Code 安装目录的 workbench.html 里写一段 <style>。
 * VS Code 1.9x 起会校验 product.json 的 `checksums`（包含 workbench.html），
 * 于是所有用户启动时都会看到 "Your Code installation appears to be corrupt.
 * Please reinstall."。0.2.0 改成 Webview 页（见 page.ts），安装目录一个字节都不碰。
 *
 * 这里保留的纯函数只干两件事：
 *   1. 升级时把老版本留下的注入块从安装目录里清掉 —— 清完校验和重新对得上，
 *      那条"安装损坏"提示才会消失（**必须重载窗口**才生效）。
 *   2. 自检脚本里做"注入 → 还原"的往返回归测试。
 */

import * as path from 'path';

/** 注入块的开始/结束标记（与 0.1.x 完全一致，不能改，否则老用户的块认不出来） */
export const MARK_BEGIN = '<!-- EMPTY-EDITOR-WATERMARK:START -->';
export const MARK_END = '<!-- EMPTY-EDITOR-WATERMARK:END -->';

/** 0.1.x 首次注入前留下的备份后缀 */
export const LEGACY_BAK_SUFFIX = '.bak-empty-editor-watermark';

/**
 * 0.1.x 会改的文件。用 vscode.env.appRoot 定位：
 *   <appRoot>/out/vs/code/electron-browser/workbench/workbench.html
 * （带版本子目录的新安装布局下，appRoot 指向 <安装目录>/<哈希>/resources/app）
 * workbench.esm.html 是将来 ESM 构建用的，存在才处理。
 */
export function workbenchHtmlPaths(appRoot: string): string[] {
  const dir = path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
  return ['workbench.html', 'workbench.esm.html'].map((name) => path.join(dir, name));
}

/** 当前 HTML 里是否已有 0.1.x 的注入块 */
export function hasBlock(html: string): boolean {
  return html.indexOf(MARK_BEGIN) >= 0 && html.indexOf(MARK_END) > html.indexOf(MARK_BEGIN);
}

/** 取出已注入的块内容（没有则返回 null） */
export function extractBlock(html: string): string | null {
  const start = html.indexOf(MARK_BEGIN);
  if (start < 0) {
    return null;
  }
  const end = html.indexOf(MARK_END, start);
  if (end < 0) {
    return null;
  }
  return html.slice(start, end + MARK_END.length);
}

/**
 * 移除注入块（连同它前面的空行），其余注入（be5invis / shalldie 等）保持原样。
 * 未注入时原样返回（removed=false），保证可以无条件调用。
 */
export function stripBlock(html: string): { html: string; removed: boolean } {
  const start0 = html.indexOf(MARK_BEGIN);
  if (start0 < 0) {
    return { html, removed: false };
  }
  const end = html.indexOf(MARK_END, start0);
  if (end < 0) {
    return { html, removed: false };
  }
  let start = start0;
  while (start > 0 && (html[start - 1] === '\n' || html[start - 1] === '\r')) {
    start--;
  }
  const next = html.slice(0, start) + html.slice(end + MARK_END.length);
  return { html: next, removed: true };
}
