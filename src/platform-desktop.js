// デスクトップ版（Tauri）：保存・開く・印刷をアプリで行い、右に AI のパネルを付ける。新しい版があれば、アプリの中から更新できる（build.mjs で platform.js の代わりに入る）
import { installDesktopFiles } from './desktop-files.js';
import { aiButton, initAiPanel } from './ai-panel.js';
import { updateButton, initUpdates } from './desktop-update.js';

export function platformButtons() { return [updateButton(), aiButton()]; }
export function initPlatform() {
  installDesktopFiles();
  initAiPanel();
  initUpdates();
}
