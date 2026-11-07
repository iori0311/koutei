// 保存データのファイル（JSON）と画面をつなぐ（Chrome・Edge）。つないでいる間は：
//   ・画面で変えた内容を、そのファイルにも自動で保存する
//   ・ファイルがほか（エージェント用の MCP サーバーなど）で書き換えられたら、2 秒ほどで読み込む。読み込んだ変更は「元に戻す」で取り消せる
//   ・次にこの HTML を開いたときも、同じファイルにつなぎ直す（ブラウザが許可を求めたら、上のボタンから許可する）
// 「保存」でファイルに書き出したとき・「データ」→「開く」でファイルを開いたときに、そのファイルとつながる
import { store, serialize, deserialize, mergeFromFile, sameSavedData, STORAGE_KEY } from './store.js';
import { toast } from './ui.js';

const link = {
  handle: null,       // つないでいるファイル（FileSystemFileHandle）
  base: null,         // 前に読み書きしたときのファイルの中身（deserialize したもの）
  baseText: '',       // その JSON
  stamp: '',          // そのときのファイルの更新時刻と大きさ
  state: 'off',       // 'off' つないでいない／'on' つないでいる／'ask' つなぎ直すのに許可が要る／'error' 読み書きできない
  error: '',
  unreadable: false,  // ファイルの中身が読めない（書きかけ・壊れている）。読めるようになるまで、こちらからは書かない
};
let linkQueue = Promise.resolve();
let linkWriteTimer = 0, linkPollTimer = 0;
// 覚えておいたファイルの参照を、使える形に戻す（デスクトップ版は desktop-files.js が差し替える）
let reviveHandle = (handle) => handle;
export function setHandleReviver(fn) { reviveHandle = fn; }

export function fileLink() { return { state: link.state, name: link.handle ? link.handle.name : '', error: link.error }; }

// 読み込みと書き込みが重ならないように、1 つずつ順に動かす
function linkRun(fn) {
  linkQueue = linkQueue.then(fn).catch(linkFailed);
  return linkQueue;
}
function linkFailed(e) {
  console.warn(e);
  link.state = 'error';
  link.error = e && e.name === 'NotFoundError' ? 'ファイルが見つかりません（動かすか消すかした？）'
    : e && e.name === 'NotAllowedError' ? 'ファイルの読み書きが許可されていません'
      : 'ファイルを読み書きできません（' + (e && e.message || e) + '）';
  stopLinkPolling();
  store.emit('file');
}
function fileStamp(f) { return f.lastModified + ':' + f.size; }

// ---- つなぐ・外す ----
// text：そのとき読み書きしたファイルの中身
export async function attachFile(handle, text) {
  stopLinkTimers();
  await linkQueue;
  link.handle = handle;
  link.baseText = text;
  link.base = deserialize(JSON.parse(text));
  link.stamp = fileStamp(await handle.getFile());
  link.state = 'on';
  link.error = '';
  link.unreadable = false;
  await rememberLink();
  startLinkPolling();
  store.emit('file');
}
// つなぐのをやめる（ファイルはそのまま残る）
export async function detachFile() {
  stopLinkTimers();
  await linkQueue;
  if (!link.handle && link.state === 'off') return;
  Object.assign(link, { handle: null, base: null, baseText: '', stamp: '', state: 'off', error: '', unreadable: false });
  await forgetLink();
  store.emit('file');
}
// 「つなぎ直す」ボタン（ブラウザが許可を求める）
export async function reconnectFile() {
  if (!link.handle) return;
  let perm = 'denied';
  try { perm = await link.handle.requestPermission({ mode: 'readwrite' }); } catch (e) { console.warn(e); }
  if (perm !== 'granted') { toast('ファイルの読み書きが許可されませんでした', { type: 'err' }); return; }
  link.state = 'on';
  link.error = '';
  startLinkPolling();
  store.emit('file');
  await linkRun(pullLinked);
  scheduleFileWrite();
}

// ---- 書く ----
// 画面の自動保存のたびに、少し待ってからファイルにも書く
function scheduleFileWrite() {
  if (link.state !== 'on') return;
  clearTimeout(linkWriteTimer);
  linkWriteTimer = setTimeout(() => linkRun(writeLinked), 500);
}
// 今すぐ書く（「保存」ボタン）
export function saveLinkedNow() {
  clearTimeout(linkWriteTimer);
  return linkRun(writeLinked);
}
async function writeLinked() {
  if (link.state !== 'on') return;
  await pullLinked();   // ほかで書き換えられていたら、先に取り込んでから書く
  if (link.state !== 'on' || link.unreadable) return;
  const text = JSON.stringify(serialize(store.state));
  if (sameSavedData(text, link.baseText)) return;
  const w = await link.handle.createWritable();
  await w.write(text);
  await w.close();
  link.baseText = text;
  link.base = deserialize(JSON.parse(text));
  link.stamp = fileStamp(await link.handle.getFile());
  await rememberLink();
}

// ---- 読む：ほかで書き換えられていたら取り込む ----
async function pullLinked() {
  if (link.state !== 'on') return;
  const f = await link.handle.getFile();
  const stamp = fileStamp(f);
  if (stamp === link.stamp) return;
  const text = await f.text();
  if (sameSavedData(text, link.baseText)) { link.stamp = stamp; return; }
  let theirs;
  try { theirs = deserialize(JSON.parse(text)); } catch (e) {
    if (!link.unreadable) { link.unreadable = true; link.error = 'ファイルの中身が読めません（' + e.message + '）'; store.emit('file'); }
    return;
  }
  if (link.unreadable) { link.unreadable = false; link.error = ''; store.emit('file'); }
  const { changes, conflicts } = mergeFromFile(link.base, theirs, store.state);
  link.base = theirs;
  link.baseText = text;
  link.stamp = stamp;
  await rememberLink();
  if (changes.length) {
    store.commit('ファイルの変更を読み込む', changes);
    toast(pullSummary(changes, conflicts), { action: { label: '元に戻す', fn: () => store.undo() }, ms: 9000 });
  } else if (conflicts) {
    toast('「' + link.handle.name + '」の変更のうち ' + conflicts + ' 件は、画面でも同じところを変えていたので、画面の内容を残しました', { ms: 9000 });
  }
}
function pullSummary(changes, conflicts) {
  const n = (kind) => changes.filter((c) => c.kind === kind).length;
  const parts = [];
  if (n('property')) parts.push('現場 ' + n('property') + ' 件');
  if (n('event')) parts.push('予定 ' + n('event') + ' 件');
  if (changes.some((c) => c.kind === 'categories' || c.kind === 'views')) parts.push('種別・ビュー');
  if (!parts.length) parts.push('施工業者の候補');
  return '「' + link.handle.name + '」の変更を読み込みました（' + parts.join('・') + '）'
    + (conflicts ? '。画面でも変えていた ' + conflicts + ' 件は、画面の内容を残しました' : '');
}

// ---- 2 秒ごとにファイルを見る（画面が見えている間だけ。棒をドラッグしている間は待つ） ----
function startLinkPolling() {
  stopLinkPolling();
  linkPollTimer = setInterval(() => {
    if (link.state !== 'on' || document.visibilityState !== 'visible') return;
    const b = document.body.classList;
    if (b.contains('drag-move') || b.contains('drag-resize')) return;
    linkRun(pullLinked);
  }, 2000);
}
function stopLinkPolling() { clearInterval(linkPollTimer); linkPollTimer = 0; }
function stopLinkTimers() { stopLinkPolling(); clearTimeout(linkWriteTimer); }

// ---- つないだファイルを覚えておく（ブラウザの IndexedDB。ファイルそのものではなく、ファイルへの参照） ----
function linkDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('koutei-gantt-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('links');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function linkDbDo(mode, fn) {
  const db = await linkDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('links', mode);
      const req = fn(tx.objectStore('links'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function rememberLink() {
  try { await linkDbDo('readwrite', (s) => s.put({ handle: link.handle, baseText: link.baseText, stamp: link.stamp }, STORAGE_KEY)); }
  catch (e) { console.warn('つないだファイルを覚えられませんでした', e); }
}
async function forgetLink() {
  try { await linkDbDo('readwrite', (s) => s.delete(STORAGE_KEY)); } catch (e) { console.warn(e); }
}

// 起動したとき：前につないでいたファイルがあれば、つなぎ直す（許可が要るときは 'ask' にして、上のボタンで頼む）
export async function initFileLink() {
  store.subscribe((reason) => { if (reason === 'saved') scheduleFileWrite(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && link.state === 'on') linkRun(pullLinked); });
  if (typeof indexedDB === 'undefined') return;
  let rec = null;
  try { rec = await linkDbDo('readonly', (s) => s.get(STORAGE_KEY)); } catch (e) { return; }
  const handle = rec && reviveHandle(rec.handle);
  if (!handle || typeof handle.getFile !== 'function') return;
  try { link.base = deserialize(JSON.parse(rec.baseText)); } catch (e) { await forgetLink(); return; }
  link.handle = handle;
  link.baseText = rec.baseText;
  link.stamp = rec.stamp || '';
  let perm = 'denied';
  try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { console.warn(e); }
  if (perm === 'granted') {
    link.state = 'on';
    startLinkPolling();
    linkRun(pullLinked).then(scheduleFileWrite);
  } else {
    link.state = 'ask';
  }
  store.emit('file');
}
