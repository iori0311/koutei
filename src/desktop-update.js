// デスクトップ版だけ：アプリの中からアップデートする。
// 起動して少ししてから（そのあとは 6 時間ごとに）公開した新しい版があるかを見て、あれば右上に「アップデート」のボタンを出す。
// 押すと、ダウンロードして、保存を済ませてからインストールし、アプリが開き直す（データとログインはそのまま）
import { store } from './store.js';
import { h, svgIcon, toast, confirmDialog } from './ui.js';
import { saveLinkedNow } from './file-sync.js';

const upd = { info: null, busy: false, label: '' };
function updInvoke(cmd, args) { return window.__TAURI__.core.invoke(cmd, args); }
function updMessage(e) { return String(e && e.message || e || '').trim() || 'わからないエラー'; }

async function checkForUpdate() {
  if (upd.busy) return;
  try {
    upd.info = await updInvoke('update_check');
  } catch (e) {
    console.warn(updMessage(e));   // ネットにつながっていないときなど。次の確認まで何も出さない
  }
  store.emit('update');
}

async function installUpdate() {
  const v = upd.info && upd.info.version;
  if (!v || upd.busy) return;
  const ok = await confirmDialog('バージョン ' + v + ' にアップデートします。終わると、アプリが自動で開き直します。入力した内容とログインは、そのまま残ります。', { title: 'アップデート', ok: 'アップデートする' });
  if (!ok) return;
  upd.busy = true;
  upd.label = 'ダウンロード中…';
  store.emit('update');
  try {
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = ([got, total]) => {
      upd.label = total ? 'ダウンロード中 ' + Math.min(100, Math.floor(got / total * 100)) + '%' : 'ダウンロード中…';
      const el = document.querySelector('.update-btn .update-label');
      if (el) el.textContent = upd.label;
    };
    await updInvoke('update_download', { onProgress: ch });
    // 開き直す前に、自動保存を待たずに保存しておく（つないでいるファイルにも）
    upd.label = 'インストール中…';
    store.emit('update');
    store.flush();
    await saveLinkedNow();
    await updInvoke('update_apply');
  } catch (e) {
    upd.busy = false;
    store.emit('update');
    toast('アップデートできませんでした（' + updMessage(e) + '）', { type: 'err', ms: 9000 });
  }
}

// 右上に出す「アップデート」のボタン（新しい版がないときは出さない）
export function updateButton() {
  if (!upd.info) return null;
  return h('button', {
    class: 'btn update-btn', disabled: upd.busy,
    title: 'バージョン ' + upd.info.version + ' にアップデートします（いまは ' + upd.info.current + '）',
    onclick: installUpdate,
  }, svgIcon('download'), h('span', { class: 'update-label' }, upd.busy ? upd.label : 'アップデート'));
}

export function initUpdates() {
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
}
