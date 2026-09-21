import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getStrings } from './i18n';
import { LEGACY_BAK_SUFFIX, hasBlock, stripBlock, workbenchHtmlPaths } from './legacy';
import { clampNumber, normalizeFit, normalizePosition, WatermarkOptions } from './page';
import { WatermarkPanelController, WatermarkSource, editorAreaEmpty } from './panel';

const SECTION = 'emptyEditorWatermark';
/** 0.2.0 的形态变更只提示一次 */
const MIGRATION_NOTICE_KEY = 'emptyEditorWatermark.webviewMigrationNotified';
/** 扩展自带的默认底图（相对 extensionUri） */
const DEFAULT_IMAGE = ['media', 'default-bg.svg'];

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

interface ResolvedImage {
  /** 本机绝对路径（用 https 远程图时为空） */
  file?: string;
  /** https:// 之类的远程地址 */
  remote?: string;
  dir?: string;
  isDefault: boolean;
  problem?: string;
}

/** 把设置里的路径规范化：容忍引号、file:/// URI、~ 前缀、http(s) 地址 */
function normalizeUserPath(input: string): { file?: string; remote?: string; problem?: string } {
  let raw = String(input ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!raw) {
    return {};
  }
  if (/^https?:\/\//i.test(raw)) {
    return { remote: raw };
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = vscode.Uri.parse(raw).fsPath;
    } catch {
      return { problem: '看不懂这个 file:// 路径：' + input };
    }
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) {
      return { problem: '路径里的 ~ 展不开（读不到 USERPROFILE / HOME）' };
    }
    raw = path.join(home, raw.slice(1));
  }
  if (!path.isAbsolute(raw)) {
    return { problem: '必须是绝对路径或 http(s) 地址（现在填的是：' + input + '）' };
  }
  return { file: path.normalize(raw) };
}

class EmptyEditorWatermark implements WatermarkSource {
  private readonly out: vscode.OutputChannel;
  private readonly panel: WatermarkPanelController;
  private warnedProblem = '';
  private lastEnabled: boolean;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.out = vscode.window.createOutputChannel('Empty Editor Watermark');
    this.panel = new WatermarkPanelController(this, this.out);
    this.lastEnabled = cfg().get<boolean>('enabled', true);
  }

  // ── WatermarkSource ────────────────────────────────────────────────
  public title(): string {
    const custom = String(cfg().get<string>('panelTitle', '') ?? '').trim();
    return custom || getStrings(vscode.env.language).panelTitle;
  }

  public roots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    const image = this.resolveImage(false);
    if (image.dir) {
      roots.push(vscode.Uri.file(image.dir));
    }
    return roots;
  }

  public render(webview: vscode.Webview): WatermarkOptions {
    const image = this.resolveImage(true);
    const c = cfg();
    this.log(`背景图：${image.file ?? image.remote ?? '(扩展自带默认图)'}`);
    return {
      imageUri: this.toWebviewUri(webview, image),
      imageFit: normalizeFit(c.get('imageFit', 'cover')),
      opacity: clampNumber(c.get('opacity', 0.9), 0.9, 0, 1),
      position: normalizePosition(c.get('position', 'top-right')),
      scale: clampNumber(c.get('scale', 0.48), 0.48, 0.05, 4),
      hideLogo: c.get<boolean>('hideLogo', true),
      hideCommands: c.get<boolean>('hideCommands', true),
      panelWidth: clampNumber(c.get('panelWidth', 261), 261, 80, 4000),
      panelFontSize: clampNumber(c.get('panelFontSize', 19), 19, 8, 96),
      frostedPanel: c.get<boolean>('frostedPanel', false),
      strings: getStrings(vscode.env.language)
    };
  }

  // ── 入口 ───────────────────────────────────────────────────────────
  public start(): void {
    this.context.subscriptions.push(this.out);
    this.registerCommands();
    this.registerListeners();
    void this.cleanupLegacy(false);
    // 等窗口加载完再判断"编辑器区域是不是空的"，否则启动瞬间拿到的状态不可靠
    setTimeout(() => this.sync(), 800);
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('emptyEditorWatermark.show', () => this.panel.show()),
      vscode.commands.registerCommand('emptyEditorWatermark.hide', () => this.panel.hide()),
      // 0.1.x 的命令名留作别名，老用户的快捷键/肌肉记忆不至于失灵
      vscode.commands.registerCommand('emptyEditorWatermark.apply', () => this.panel.show()),
      vscode.commands.registerCommand('emptyEditorWatermark.remove', () => this.cleanupLegacy(true)),
      vscode.commands.registerCommand('emptyEditorWatermark.pickImage', () => this.pickImage()),
      vscode.commands.registerCommand('emptyEditorWatermark.showCss', () => this.showSource())
    );
  }

  private registerListeners(): void {
    this.context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.sync()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(SECTION)) {
          return;
        }
        const enabled = cfg().get<boolean>('enabled', true);
        const wasEnabled = this.lastEnabled;
        this.lastEnabled = enabled;

        if (!enabled) {
          this.panel.hide();
          return;
        }
        if (this.panel.isOpen) {
          this.panel.refresh();
          return;
        }
        if (!wasEnabled && editorAreaEmpty()) {
          this.panel.show();
          return;
        }
        this.sync();
      })
    );
  }

  /** 空编辑器时自动开、打开文件时自动关 */
  private sync(): void {
    const c = cfg();
    const enabled = c.get<boolean>('enabled', true);
    const autoOpen = c.get<boolean>('autoOpen', true);
    const closeWhenEditorOpens = c.get<boolean>('closeWhenEditorOpens', true);
    this.panel.syncAutoOpen(enabled && autoOpen, editorAreaEmpty(), closeWhenEditorOpens);
  }

  // ── 旧版注入清理（0.1.x 遗留）───────────────────────────────────────
  /**
   * 0.1.x 会把 <style> 写进安装目录的 workbench.html，那是"安装似乎损坏"的来源。
   * 这里把老版本留下的块删掉，安装目录回到原样，校验和重新对得上。
   * 只删自己的块：be5invis / shalldie 等别家的注入原样不动。
   */
  private async cleanupLegacy(interactive: boolean): Promise<void> {
    const cleaned: string[] = [];
    const failures: Array<{ file: string; error: string }> = [];
    const backups: string[] = [];

    for (const file of workbenchHtmlPaths(vscode.env.appRoot)) {
      try {
        if (!fs.existsSync(file)) {
          continue;
        }
        const backup = file + LEGACY_BAK_SUFFIX;
        if (fs.existsSync(backup)) {
          backups.push(backup);
        }
        const html = fs.readFileSync(file, 'utf8');
        if (!hasBlock(html)) {
          continue;
        }
        const { html: next, removed } = stripBlock(html);
        if (!removed) {
          continue;
        }
        fs.writeFileSync(file, next, 'utf8');
        cleaned.push(file);
        this.log('已移除旧版注入：' + file);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push({ file, error: detail });
        this.log(`清理旧版注入失败：${file} —— ${detail}`);
      }
    }

    if (backups.length > 0) {
      this.log(
        '旧版留下的备份文件（不影响 VS Code 校验，可自行删除）：\n  ' + backups.join('\n  ')
      );
    }

    if (interactive) {
      if (failures.length > 0) {
        void vscode.window.showWarningMessage(
          `Empty Editor Watermark：清理失败（${failures[0].error}）。安装目录通常需要管理员权限，请以管理员身份重启 VS Code 后再试。`
        );
        return;
      }
      if (cleaned.length === 0) {
        void vscode.window.showInformationMessage(
          'Empty Editor Watermark：安装目录里没有旧版注入需要清理（0.2.0 起本扩展不再修改任何 VS Code 文件）。'
        );
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        'Empty Editor Watermark：旧版注入已移除，重载窗口后「安装似乎损坏」提示即消失。',
        '立即重载窗口',
        '稍后'
      );
      if (pick === '立即重载窗口') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }

    await this.notifyMigration(cleaned, failures);
  }

  private async notifyMigration(
    cleaned: string[],
    failures: Array<{ file: string; error: string }>
  ): Promise<void> {
    if (cleaned.length > 0) {
      await this.context.globalState.update(MIGRATION_NOTICE_KEY, true);
      const pick = await vscode.window.showInformationMessage(
        'Empty Editor Watermark 0.2.0：已移除旧版写进 VS Code 安装目录的样式（那正是「安装似乎损坏」提示的来源）。水印改为独立 Webview 页，不再修改任何 VS Code 文件。',
        '立即重载窗口',
        '稍后'
      );
      if (pick === '立即重载窗口') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }

    if (failures.length > 0) {
      void vscode.window.showWarningMessage(
        `Empty Editor Watermark：检测到旧版注入但没能清理（${failures[0].error}）。以管理员身份重启 VS Code 后执行命令「Watermark: 清理旧版注入」即可。`
      );
      return;
    }

    if (this.context.globalState.get<boolean>(MIGRATION_NOTICE_KEY, false)) {
      return;
    }
    await this.context.globalState.update(MIGRATION_NOTICE_KEY, true);
    const pick = await vscode.window.showInformationMessage(
      'Empty Editor Watermark 0.2.0：为避免触发 VS Code 的「安装似乎损坏」校验，水印改为独立 Webview 页（空编辑器时自动打开），不再修改 VS Code 安装目录。',
      '打开水印',
      '知道了'
    );
    if (pick === '打开水印') {
      this.panel.show();
    }
  }

  // ── 命令实现 ───────────────────────────────────────────────────────
  private async pickImage(): Promise<void> {
    const current = this.resolveImage(false);
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '用作水印背景图',
      title: '选择空编辑器水印背景图',
      defaultUri: current.file ? vscode.Uri.file(path.dirname(current.file)) : undefined,
      filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'], 所有文件: ['*'] }
    });
    if (!picked || picked.length === 0) {
      return;
    }
    await cfg().update('imagePath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await cfg().update('enabled', true, vscode.ConfigurationTarget.Global);
    this.panel.show();
  }

  /** 把当前渲染出来的页面源码开成只读文档，便于核对/排查 */
  private async showSource(): Promise<void> {
    if (!this.panel.isOpen) {
      this.panel.show();
    }
    const html = this.panel.snapshot();
    if (!html) {
      void vscode.window.showWarningMessage('Empty Editor Watermark：水印页还没渲染完成，稍后再试。');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: html, language: 'html' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  // ── 杂项 ───────────────────────────────────────────────────────────
  private resolveImage(warn: boolean): ResolvedImage {
    const raw = String(cfg().get<string>('imagePath', '') ?? '');
    const norm = normalizeUserPath(raw);
    let result: ResolvedImage;

    if (norm.problem) {
      result = { isDefault: true, problem: norm.problem };
    } else if (norm.remote) {
      result = { remote: norm.remote, isDefault: false };
    } else if (!norm.file) {
      result = { isDefault: true };
    } else if (!fs.existsSync(norm.file)) {
      result = { isDefault: true, problem: '找不到背景图：' + norm.file + '（已退回扩展自带的默认图）' };
    } else {
      result = { file: norm.file, dir: path.dirname(norm.file), isDefault: false };
    }

    if (warn && result.problem) {
      this.reportProblem(result.problem);
    }
    return result;
  }

  private toWebviewUri(webview: vscode.Webview, image: ResolvedImage): string {
    if (image.remote) {
      return image.remote;
    }
    // 默认图走 extensionUri（远程/Web 场景下它不一定是 file: 协议，别拼字符串）
    const uri = image.file
      ? vscode.Uri.file(image.file)
      : vscode.Uri.joinPath(this.context.extensionUri, ...DEFAULT_IMAGE);
    return webview.asWebviewUri(uri).toString();
  }

  private reportProblem(problem: string): void {
    if (problem === this.warnedProblem) {
      return;
    }
    this.warnedProblem = problem;
    this.log('警告：' + problem);
    void vscode.window.showWarningMessage('Empty Editor Watermark：' + problem);
  }

  private log(line: string): void {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  new EmptyEditorWatermark(context).start();
}

export function deactivate(): void {
  /* 面板随窗口一起销毁；本扩展不修改任何 VS Code 文件，无需清理 */
}
