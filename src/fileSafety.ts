import * as fs from 'fs';
import * as path from 'path';
import { ALL_MARKERS } from './injector';

/** 拒绝不完整的 HTML 和残缺/重复的注入标记，避免继续破坏已有内容。 */
export function validateHtml(html: string): void {
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error('目标文件不是完整的 HTML，已保留原文件。');
  }
  for (const { begin, end } of ALL_MARKERS) {
    const starts = html.split(begin).length - 1;
    const ends = html.split(end).length - 1;
    if (starts !== ends || starts > 1 || (starts === 1 && html.indexOf(begin) > html.indexOf(end))) {
      throw new Error('注入标记残缺或重复，已保留原文件。请先运行一键诊断。');
    }
  }
}

/** 同目录暂存、刷盘并校验后替换；失败时原文件保持原样，不使用截断覆盖兜底。 */
export function writeHtmlSafely(file: string, original: string, next: string): void {
  validateHtml(original);
  validateHtml(next);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1) {
    throw new Error('目标不是普通文件或存在硬链接，已保留原文件。');
  }
  let temporary: string | undefined;
  try {
    temporary = fs.mkdtempSync(path.join(path.dirname(file), '.empty-editor-watermark-'));
    const staged = path.join(temporary, 'workbench.html');
    const fd = fs.openSync(staged, 'wx', stat.mode & 0o777);
    try {
      fs.writeFileSync(fd, next, 'utf8');
      fs.fchmodSync(fd, stat.mode & 0o777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.readFileSync(staged, 'utf8') !== next) {
      throw new Error('暂存文件校验失败，已保留原文件。');
    }
    // 其他窗口/扩展可能在准备期间更新同一个文件，避免覆盖它们的修改。
    if (fs.readFileSync(file, 'utf8') !== original) {
      throw new Error('目标文件已被其他操作修改，请重新应用。');
    }
    fs.renameSync(staged, file);
  } finally {
    if (temporary) { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}
