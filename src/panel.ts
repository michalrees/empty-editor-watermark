/**
 * 水印页的生命周期管理（Webview 面板）。
 *
 * 行为对齐 VS Code 内置的那个"空编辑器水印"：
 *   - 编辑器区域空了（没有别的标签页）→ 自动打开水印页
 *   - 打开文件时 → 自动关闭（可用 closeWhenEditorOpens 关掉这个行为）
 *   - 用户自己关掉标签页后 → 不再立刻重新打开（否则会和用户较劲），
 *     等编辑器区域重新变成"有内容 → 又空了"或者执行一次"显示水印"命令
 *
 * 全程只操作自己的 Webview，不读写 VS Code 安装目录。
 */

import * as vscode from 'vscode';
import { buildPageHtml, WatermarkOptions } from './page';

export const VIEW_TYPE = 'emptyEditorWatermark';

/** 面板需要的三件事：标题、能加载哪些本地资源、页面内容 */
export interface WatermarkSource {
  title(): string;
  /** localResourceRoots：只放开"扩展自带 media 目录 + 当前背景图所在目录" */
  roots(): vscode.Uri[];
  /** 需要 webview 才能把本地图片转成 webview URI（asWebviewUri） */
  render(webview: vscode.Webview): WatermarkOptions;
}

export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** 这个标签页是不是本扩展的水印页 */
export function isOwnTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  if (!(input instanceof vscode.TabInputWebview)) {
    return false;
  }
  return String(input.viewType ?? '').toLowerCase().indexOf(VIEW_TYPE.toLowerCase()) >= 0;
}

/** 编辑器区域是否"空的"（只算非本扩展的标签页） */
export function editorAreaEmpty(): boolean {
  const groups = vscode.window.tabGroups?.all ?? [];
  if (groups.length === 0) {
    return true;
  }
  return groups.every((group) => group.tabs.every((tab) => isOwnTab(tab)));
}

export class WatermarkPanelController {
  private panel: vscode.WebviewPanel | undefined;
  /**
   * 正在被我们自己 dispose 的那个面板。
   * onDidDispose 里拿它做**对象身份**比对来区分"程序关闭"和"用户点 ×"——
   * 不能用时间戳近似（比如"1 秒内算自关闭"）：用户完全可能在我们刚关掉面板后
   * 立刻自己关一次，那样就被误判成程序关闭，然后面板又被硬弹回来。
   */
  private closingSelf: vscode.WebviewPanel | undefined;
  /** 用户主动关掉后，别马上又弹出来 */
  private suppressAutoOpen = false;
  private lastHtml: string | undefined;

  constructor(
    private readonly source: WatermarkSource,
    private readonly out?: vscode.OutputChannel
  ) {}

  public get isOpen(): boolean {
    return !!this.panel;
  }

  /** 最近一次渲染出来的页面源码（"查看水印页源码"用） */
  public snapshot(): string | undefined {
    return this.lastHtml;
  }

  private log(line: string): void {
    this.out?.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  /** 打开（或前置）水印页 */
  public show(column: vscode.ViewColumn = vscode.ViewColumn.Active): void {
    this.suppressAutoOpen = false;

    if (this.panel) {
      this.panel.reveal(column);
      this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, this.source.title(), column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.source.roots()
    });

    this.panel = panel;
    panel.onDidDispose(() => {
      const wasSelf = this.closingSelf === panel;
      if (wasSelf) {
        this.closingSelf = undefined;
      }
      this.panel = undefined;
      this.lastHtml = undefined;
      if (!wasSelf) {
        // 用户自己关的标签页：尊重一下，别立刻重开
        this.suppressAutoOpen = true;
        this.log('用户关闭了水印页');
      }
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });

    this.refresh();
  }

  /** 关掉水印页（命令触发；关掉后不会自动重开，直到编辑器区域重新被打开过） */
  public hide(): void {
    this.suppressAutoOpen = true;
    this.closeSelf();
  }

  /** 重新渲染当前面板（改设置后用；不重开面板，所以不会闪） */
  public refresh(): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: this.source.roots()
      };
      const options = this.source.render(panel.webview);
      panel.title = this.source.title();
      const html = buildPageHtml(options, {
        cspSource: panel.webview.cspSource,
        nonce: createNonce()
      });
      panel.webview.html = html;
      this.lastHtml = html;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log('渲染水印页失败：' + detail);
      void vscode.window.showErrorMessage('Empty Editor Watermark：渲染水印页失败 —— ' + detail);
    }
  }

  /**
   * 自动开关的总调度。调用方（extension.ts）在标签页变化/启动时调用。
   * @param autoOpen 配置开关：空编辑器时是否自动打开
   * @param empty    编辑器区域是否为空
   * @param closeWhenEditorOpens 打开文件后是否自动关闭
   */
  public syncAutoOpen(autoOpen: boolean, empty: boolean, closeWhenEditorOpens: boolean): void {
    if (!empty) {
      // 编辑器区域有内容了：解除"用户关过"的抑制，下一次变空时还能自动回来
      this.suppressAutoOpen = false;
      if (closeWhenEditorOpens) {
        this.closeSelf();
      }
      return;
    }
    if (autoOpen && !this.panel && !this.suppressAutoOpen) {
      this.show();
    }
  }

  /** 程序性关闭：不算"用户关的"，不置抑制位 */
  private closeSelf(): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    this.closingSelf = panel;
    panel.dispose();
  }

  private async onMessage(message: unknown): Promise<void> {
    const msg = message as { command?: string; id?: string } | undefined;
    if (!msg || msg.command !== 'run' || typeof msg.id !== 'string') {
      return;
    }
    try {
      await vscode.commands.executeCommand(msg.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`执行命令 ${msg.id} 失败：${detail}`);
      void vscode.window.showWarningMessage(`Empty Editor Watermark：执行 ${msg.id} 失败 —— ${detail}`);
    }
  }
}
