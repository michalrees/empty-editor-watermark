/**
 * 页面文案 —— 纯函数，不 import 'vscode'（自检脚本可直接 require）。
 *
 * VS Code 没给扩展读本地化字符串的公开 API（`vscode.l10n` 需要 bundle 语言包，
 * 对这么点文案不划算），所以这里按界面语言挑一套内置文案。
 */
import { WatermarkStrings } from './page';

export function isChineseLanguage(language: string): boolean {
  return String(language ?? '')
    .toLowerCase()
    .startsWith('zh');
}

/** 页面里显示的快捷键（按平台给符号；克隆仓库这条 VS Code 内置水印也不标快捷键） */
export function platformKeys(platform: string): WatermarkStrings['keys'] {
  const mac = String(platform ?? '').toLowerCase() === 'darwin';
  return {
    showCommands: mac ? '⇧⌘P' : 'Ctrl+Shift+P',
    openFile: mac ? '⌘O' : 'Ctrl+O',
    cloneRepo: ''
  };
}

export function getStrings(language: string, platform: string = process.platform): WatermarkStrings {
  const keys = platformKeys(platform);
  if (isChineseLanguage(language)) {
    return {
      panelTitle: '水印',
      logo: 'Visual Studio Code',
      commands: {
        showCommands: '显示所有命令',
        openFile: '打开文件…',
        cloneRepo: '克隆 Git 仓库…'
      },
      keys
    };
  }
  return {
    panelTitle: 'Watermark',
    logo: 'Visual Studio Code',
    commands: {
      showCommands: 'Show All Commands',
      openFile: 'Open File…',
      cloneRepo: 'Clone Git Repository…'
    },
    keys
  };
}
