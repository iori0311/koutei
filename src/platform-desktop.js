// デスクトップ版（Tauri）：保存・開く・印刷をアプリで行い、右に AI のパネルを付ける（build.mjs で platform.js の代わりに入る）
import { installDesktopFiles } from './desktop-files.js';
import { aiButton, initAiPanel } from './ai-panel.js';

export function platformButtons() { return aiButton(); }
export function initPlatform() {
  installDesktopFiles();
  initAiPanel();
}
