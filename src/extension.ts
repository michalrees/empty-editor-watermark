import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ALL_MARKERS,
  applyBlocks,
  BlockSpec,
  buildBlock,
  buildCss,
  buildNoticeCss,
  hasBlock,
  NOTICE_MARKERS,
  stripBlock,
  toVscodeFileUrl,
  WATERMARK_MARKERS,
  ImageFit,
  WatermarkOptions,
  WatermarkPosition
} from './injector';

const SECTION = 'emptyEditorWatermark';
const BAK_SUFFIX = '.bak-empty-editor-watermark';
const DEFAULT_IMAGE = path.join('media', 'default-bg.svg');
const CONSENT_KEY = 'emptyEditorWatermark.consentAsked';

interface ImageChoice {
  file: string;
  isDefault: boolean;
  problem?: string;
}

/** 把设置里的路径规范化成绝对路径；容忍引号、file:/// URI、~ 前缀 */
function normalizeUserPath(input: string): { file: string | null; problem?: string } {
  let raw = String(input ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!raw) {
    return { file: null };
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = vscode.Uri.parse(raw).fsPath;
    } catch {
      return { file: null, problem: '看不懂这个 file:// 路径：' + input };
    }
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) {
      return { file: null, problem: '路径里的 ~ 展不开（读不到 USERPROFILE / HOME）' };
    }
    raw = path.join(home, raw.slice(1));
  }
  if (!path.isAbsolute(raw)) {
    return { file: null, problem: '必须是绝对路径（现在填的是：' + input + '）' };
  }
  return { file: path.normalize(raw) };
}

function readImage(context: vscode.ExtensionContext): ImageChoice {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const raw = String(cfg.get<string>('imagePath', '') ?? '');
  const fallback = path.join(context.extensionPath, DEFAULT_IMAGE);
  const norm = normalizeUserPath(raw);
  if (norm.problem) {
    return { file: fallback, isDefault: true, problem: norm.problem };
  }
  if (!norm.file) {
    return { file: fallback, isDefault: true };
  }
  if (!fs.existsSync(norm.file)) {
    return { file: fallback, isDefault: true, problem: '找不到背景图：' + norm.file + '（已退回扩展自带默认图）' };
  }
  return { file: norm.file, isDefault: false };
}

function readOptions(context: vscode.ExtensionContext): { options: WatermarkOptions; image: ImageChoice } {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const image = readImage(context);
  const fit = cfg.get<string>('imageFit', 'cover');
  const position = cfg.get<string>('position', 'top-right');
  const options: WatermarkOptions = {
    imageUrl: toVscodeFileUrl(image.file),
    imageFit: (fit === 'contain' ? 'contain' : 'cover') as ImageFit,
    opacity: cfg.get<number>('opacity', 0.9),
    position: position as WatermarkPosition,
    scale: cfg.get<number>('scale', 0.48),
    hideLogo: cfg.get<boolean>('hideLogo', true),
    hideCommands: cfg.get<boolean>('hideCommands', true),
    panelWidth: cfg.get<number>('panelWidth', 261),
    panelFontSize: cfg.get<number>('panelFontSize', 19),
    frostedPanel: cfg.get<boolean>('frostedPanel', false)
  };
  return { options, image };
}

class WatermarkService {
  private warnedProblem = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly out: vscode.OutputChannel
  ) {}

  /**
   * 待注入的文件。用 vscode.env.appRoot 定位，比翻注册表稳：
   *   <appRoot>/out/vs/code/electron-browser/workbench/workbench.html
   * 同时带上 workbench.esm.html（将来的 ESM 版构建会用它），存在才处理。
   */
  private workbenchFiles(): string[] {
    const dir = path.join(vscode.env.appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
    return ['workbench.html', 'workbench.esm.html']
      .map((n) => path.join(dir, n))
      .filter((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
  }

  private log(line: string): void {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  /** 当前配置下"应该注入哪些块"，顺序就是它们写进文件里的顺序 */
  private desiredBlocks(): BlockSpec[] {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const { options } = readOptions(this.context);
    const blocks: BlockSpec[] = [{ block: buildBlock(buildCss(options)), markers: WATERMARK_MARKERS }];
    if (cfg.get<boolean>('hideCorruptNotice', true)) {
      blocks.push({ block: buildBlock(buildNoticeCss(), NOTICE_MARKERS), markers: NOTICE_MARKERS });
    }
    return blocks;
  }

  /** 文件里是否还有本扩展的任何一块注入 */
  private anyInjected(html: string): boolean {
    return ALL_MARKERS.some((markers) => hasBlock(html, markers));
  }

  /** 首次改动前留一份原样备份，方便手动还原 */
  private backupOnce(file: string, html: string): void {
    const bak = file + BAK_SUFFIX;
    if (fs.existsSync(bak)) {
      return;
    }
    fs.writeFileSync(bak, html, 'utf8');
    this.log(`已备份原文件 → ${bak}`);
  }

  private reportProblem(problem?: string): void {
    if (!problem || problem === this.warnedProblem) {
      return;
    }
    this.warnedProblem = problem;
    this.log('警告：' + problem);
    void vscode.window.showWarningMessage('Empty Editor Watermark：' + problem);
  }

  private async promptReload(message: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(message, '立即重载窗口', '稍后');
    if (pick === '立即重载窗口') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  private describeFailures(failures: Array<{ file: string; err: unknown }>): void {
    const first = failures[0];
    const code = (first.err as NodeJS.ErrnoException)?.code ?? '';
    const detail = first.err instanceof Error ? first.err.message : String(first.err);
    this.log(`写入失败：${first.file} —— ${detail}`);
    const hint =
      code === 'EPERM' || code === 'EACCES'
        ? '没有写权限。请**以管理员身份重启 VS Code** 后再执行一次；或手动给该文件加上当前用户的写权限。'
        : '详见输出面板「Empty Editor Watermark」。';
    void vscode.window.showErrorMessage(`Empty Editor Watermark：写入 ${path.basename(first.file)} 失败（${code || detail}）。${hint}`);
  }

  /** 应用/更新注入。interactive=true 表示用户主动触发（会给出更明确的反馈） */
  public async apply(interactive: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    if (!cfg.get<boolean>('enabled', true)) {
      this.log('enabled=false，改为执行移除');
      await this.remove(interactive);
      return;
    }

    const { image } = readOptions(this.context);
    this.reportProblem(image.problem);
    const blocks = this.desiredBlocks();
    const targets = this.workbenchFiles();
    if (targets.length === 0) {
      void vscode.window.showErrorMessage(`找不到 workbench.html（appRoot=${vscode.env.appRoot}）`);
      return;
    }

    this.log(`背景图：${image.file}${image.isDefault ? '（扩展自带默认图）' : '（来自设置）'}`);
    const updated: string[] = [];
    const failures: Array<{ file: string; err: unknown }> = [];

    for (const file of targets) {
      try {
        const html = fs.readFileSync(file, 'utf8');
        this.backupOnce(file, html);
        const { html: next, changed } = applyBlocks(html, blocks);
        if (changed) {
          fs.writeFileSync(file, next, 'utf8');
          updated.push(path.basename(file));
          this.log(`已写入 ${file}`);
        } else {
          this.log(`${file} 已是最新，跳过`);
        }
      } catch (err) {
        failures.push({ file, err });
      }
    }

    if (failures.length) {
      this.describeFailures(failures);
      return;
    }
    if (updated.length === 0) {
      if (interactive) {
        void vscode.window.showInformationMessage('水印已是最新，无需改动。');
      }
      return;
    }
    this.log('完成，等待重载窗口生效');
    await this.promptReload('水印（与「安装损坏」提示的隐藏规则）已写入 workbench.html，重载窗口后生效。');
  }

  /** 移除注入（只删本扩展那段；be5invis / shalldie 的注入保持原样） */
  public async remove(interactive: boolean): Promise<void> {
    const removed: string[] = [];
    const failures: Array<{ file: string; err: unknown }> = [];

    for (const file of this.workbenchFiles()) {
      try {
        const html = fs.readFileSync(file, 'utf8');
        let next = html;
        for (const markers of ALL_MARKERS) {
          next = stripBlock(next, markers).html;
        }
        const did = next !== html;
        if (did) {
          fs.writeFileSync(file, next, 'utf8');
          removed.push(path.basename(file));
          this.log(`已移除 ${file} 中的注入`);
        }
      } catch (err) {
        failures.push({ file, err });
      }
    }

    if (failures.length) {
      this.describeFailures(failures);
      return;
    }
    if (removed.length === 0) {
      if (interactive) {
        void vscode.window.showInformationMessage('workbench.html 里没有本扩展的注入，无需清理。');
      }
      return;
    }
    if (interactive) {
      await this.promptReload('水印已移除，重载窗口后生效。');
    }
  }

  /**
   * 启动时兜底：设置开着但注入丢了（典型场景：VS Code 刚更新，安装目录换了新的哈希子目录），
   * 或设置改过而注入还是旧的 —— 自动补齐。首次运行会先征求一次同意。
   */
  public async ensureApplied(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    if (!cfg.get<boolean>('enabled', true)) {
      const anyInjected = this.workbenchFiles().some((f) => {
        try {
          return this.anyInjected(fs.readFileSync(f, 'utf8'));
        } catch {
          return false;
        }
      });
      if (anyInjected) {
        await this.remove(false);
      }
      return;
    }

    const blocks = this.desiredBlocks();
    const stale = this.workbenchFiles().some((f) => {
      try {
        const html = fs.readFileSync(f, 'utf8');
        // applyBlocks 是幂等的：算出来的结果与磁盘一致 = 无需写盘
        return applyBlocks(html, blocks).html !== html;
      } catch {
        return false;
      }
    });
    if (!stale) {
      return;
    }

    // 第一次装上就默默改安装目录不合适，先问一次（之后一直自动）
    if (!this.context.globalState.get<boolean>(CONSENT_KEY, false)) {
      await this.context.globalState.update(CONSENT_KEY, true);
      const pick = await vscode.window.showInformationMessage(
        'Empty Editor Watermark 需要往 VS Code 安装目录的 workbench.html 写入一段样式（这是给空编辑器铺背景图/隐藏水印文字的唯一方式，VS Code 没有相关 API）。是否现在应用？',
        '应用水印',
        '以后再说'
      );
      if (pick !== '应用水印') {
        this.log('用户选择稍后；之后可在命令面板执行「Watermark: 应用/更新水印」');
        return;
      }
    }

    this.log('检测到注入缺失或已过期（常见于 VS Code 更新后），自动补齐');
    await this.apply(false);
  }

  /** 选一张背景图并写进设置 */
  public async pickImage(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const current = readImage(this.context);
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '用作水印背景图',
      title: '选择空编辑器水印背景图',
      defaultUri: vscode.Uri.file(path.dirname(current.file)),
      filters: { '图片': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'], '所有文件': ['*'] }
    });
    if (!picked || picked.length === 0) {
      return;
    }
    await cfg.update('imagePath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    await this.apply(true);
  }

  /** 把当前会生成的 CSS 打开成只读文档，方便核对/排查 */
  public async showCss(): Promise<void> {
    const { options, image } = readOptions(this.context);
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const hideNotice = cfg.get<boolean>('hideCorruptNotice', true);
    const header =
      `/* 生成来源：Empty Editor Watermark\n` +
      ` * 背景图  : ${image.file}${image.isDefault ? '（扩展自带默认图）' : ''}\n` +
      ` * URL     : ${options.imageUrl}\n` +
      ` * 目标文件: ${this.workbenchFiles().join('\n *           ') || '(未找到 workbench.html)'}\n` +
      ` * 隐藏损坏提示: ${hideNotice ? '开（emptyEditorWatermark.hideCorruptNotice）' : '关'}\n` +
      ` * 提示    : 本文件是只读快照；改效果请改设置或执行命令。\n */\n\n`;
    const body = hideNotice
      ? buildCss(options) + '\n\n' + buildNoticeCss()
      : buildCss(options);
    const doc = await vscode.workspace.openTextDocument({ content: header + body, language: 'css' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Empty Editor Watermark');
  context.subscriptions.push(out);
  const service = new WatermarkService(context, out);

  context.subscriptions.push(
    vscode.commands.registerCommand('emptyEditorWatermark.apply', () => service.apply(true)),
    vscode.commands.registerCommand('emptyEditorWatermark.remove', () => service.remove(true)),
    vscode.commands.registerCommand('emptyEditorWatermark.pickImage', () => service.pickImage()),
    vscode.commands.registerCommand('emptyEditorWatermark.showCss', () => service.showCss()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        void service.apply(false);
      }
    })
  );

  void service.ensureApplied();
}

export function deactivate(): void {
  /* 不做清理：卸载时是否还原安装目录由用户显式执行 remove 决定 */
}
