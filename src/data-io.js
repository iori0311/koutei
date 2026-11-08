// 保存データ（JSON）の読み書きと、最初の状態に戻す処理（画面に依存しない部分）
import { store, serialize, deserialize, defaultCategories } from './store.js';
import { download, pickFile, choiceDialog, toast } from './ui.js';
import { attachFile, detachFile, fileLink, reconnectFile, saveLinkedNow } from './file-sync.js';

export function stamp() {
  const t = new Date();
  return t.getFullYear() + String(t.getMonth() + 1).padStart(2, '0') + String(t.getDate()).padStart(2, '0');
}

// ================= JSON（このツールの保存データ） =================
// 保存：つないでいるファイルがあれば、そこへすぐ書く。なければ（または「名前を付けて保存」なら）保存先を選んで書き、
// そのファイルとつなぐ（以後そのファイルにも自動保存し、ほかで書き換えられたら読み込む。file-sync.js）
export async function saveJson(saveAs = false) {
  const cur = fileLink();
  if (!saveAs && cur.state === 'ask') await reconnectFile();
  if (!saveAs && fileLink().state === 'on') { await saveLinkedNow(); return fileLink().state === 'on' ? cur.name : null; }
  const text = JSON.stringify(serialize(store.state));
  const name = '工程データ_' + stamp() + '.json';
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '取り付け工程表のデータ', accept: { 'application/json': ['.json'] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      await attachFile(handle, text);
      return handle.name;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      console.warn(e);
    }
  }
  download(new Blob([text], { type: 'application/json' }), name);
  return name;
}

// 開く：中身（state）と、読んだ JSON の文字（text）を返す
export async function openJson(file) {
  const text = await file.text();
  return { st: deserialize(JSON.parse(text)), text };
}

// すべての現場・予定を消して、最初の状態（何も入っていない状態）に戻す。直後なら「元に戻す」で復元できる
export async function resetAllData() {
  const st = store.state;
  const choice = await choiceDialog(
    '今ある現場 ' + st.properties.size + ' 件・予定 ' + st.events.size + ' 件をすべて消して、最初の状態（何も入っていない状態）に戻します。種別（色）・施工業者の候補・ビューも最初の状態に戻ります。\n\n念のため、消す前に控えをファイルに保存しておくこともできます。',
    { title: '最初の状態に戻す', choices: [{ key: 'save', label: '控えを保存してから消す' }, { key: 'clear', label: '保存せずに消す', primary: true, danger: true }] });
  if (!choice) return false;
  if (choice === 'save') {
    const name = await saveJson(true);
    if (!name) return false;
  }
  // 控えのファイル（つないでいたファイル）に、このあと入れる新しいデータを上書きしないようにする
  await detachFile();
  const changes = [];
  for (const e of st.events.values()) changes.push({ kind: 'event', id: e.id, before: e, after: null });
  for (const p of st.properties.values()) changes.push({ kind: 'property', id: p.id, before: p, after: null });
  changes.push({ kind: 'categories', id: 'categories', before: st.categories, after: defaultCategories() });
  changes.push({ kind: 'contractors', id: 'contractors', before: st.contractors, after: [] });
  changes.push({ kind: 'views', id: 'views', before: st.views, after: [] });
  changes.push({ kind: 'offDays', id: 'offDays', before: st.offDays, after: [] });
  changes.push({ kind: 'workDays', id: 'workDays', before: st.workDays, after: [] });
  st.prefs.view = null;
  st.prefs.periods = {};
  store.commit('最初の状態に戻す', changes);
  toast('すべて消して、最初の状態に戻しました', { action: { label: '元に戻す', fn: () => store.undo() }, ms: 12000 });
  return true;
}

export async function pickJson() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: '取り付け工程表のデータ', accept: { 'application/json': ['.json'] } }] });
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
    }
  }
  const file = await pickFile('.json,application/json');
  return file ? { file, handle: null } : null;
}
