// デスクトップ版のファイル：ブラウザの File System Access API と同じ形の窓口を、アプリ（Rust の files.rs）で作る。
// これで data-io.js・file-sync.js はブラウザ版と同じに動く（保存・開いたファイルとつながり、自動保存・外の変更の読み込みもする）。
// 読み書きできるのは、保存・開くのダイアログで選んだファイルだけ（アプリの側で確かめる）
import { setHandleReviver } from './file-sync.js';

function deskCore() { return window.__TAURI__.core; }
// アプリから返るエラー（文字）を、ブラウザと同じ名前のエラーにする（file-sync.js が名前で見分ける）
function deskFileError(e) {
  const msg = String((e && e.message) || e);
  const err = new Error(msg.replace(/^NotFoundError:\s*/, ''));
  if (/^NotFoundError/.test(msg)) err.name = 'NotFoundError';
  return err;
}
function deskAborted() { const e = new Error('canceled'); e.name = 'AbortError'; return e; }

class DesktopFileHandle {
  constructor(path, name) { this.kind = 'file'; this.desktopPath = path; this.name = name; }
  // 更新時刻と大きさだけを先に読み、中身は text() で読む（2 秒ごとの見回りを軽くする）
  async getFile() {
    const path = this.desktopPath;
    let st;
    try { st = await deskCore().invoke('file_stat', { path }); } catch (e) { throw deskFileError(e); }
    return {
      name: this.name, lastModified: st.modified, size: st.size,
      text: async () => { try { return (await deskCore().invoke('file_read', { path })).text; } catch (e) { throw deskFileError(e); } },
    };
  }
  async createWritable() {
    const path = this.desktopPath;
    let buf = '';
    return {
      write: async (t) => { buf += String(t); },
      close: async () => { try { await deskCore().invoke('file_write', { path, text: buf }); } catch (e) { throw deskFileError(e); } },
    };
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}

export function installDesktopFiles() {
  window.showSaveFilePicker = async (opts = {}) => {
    const r = await deskCore().invoke('file_pick_save', { suggested: opts.suggestedName || '工程データ.json' });
    if (!r) throw deskAborted();
    return new DesktopFileHandle(r.path, r.name);
  };
  window.showOpenFilePicker = async () => {
    const r = await deskCore().invoke('file_pick_open');
    if (!r) throw deskAborted();
    return [new DesktopFileHandle(r.path, r.name)];
  };
  // 前につないだファイルの記録（IndexedDB には道具のない形で残る）から、つなぎ直すとき
  setHandleReviver((h) => (h && h.desktopPath ? new DesktopFileHandle(h.desktopPath, h.name) : null));
  // 印刷：アプリの印刷の画面を出す
  window.print = () => { deskCore().invoke('print_page').catch((e) => console.warn(e)); };
}
