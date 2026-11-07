// 起動・画面の組み立て・キーボード操作
import { store, STORAGE_KEY, edition, deserialize } from './store.js';
import { h, svgIcon, toast, isModalOpen, confirmDialog, fill, openMenu } from './ui.js';
import { ui, renderOverview, renderInspector, panelKind, closePanel } from './gantt-web.js';
import { openPrintPreview, isPrintPreviewOpen, installPrintHandlers, closePrintPreview } from './print.js';
import { sitePopPid, closeSitePop, syncSitePop } from './site-pop.js';
import { viewTabs, viewEditorOpen, closeViewEditor, syncViewEditor } from './views.js';
import { saveJson, openJson, pickJson, resetAllData } from './data-io.js';
import { initFileLink, fileLink, reconnectFile, detachFile, attachFile } from './file-sync.js';
import { platformButtons, initPlatform } from './platform.js';

const els = {};

function logo() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="1" y="1" width="22" height="22" rx="5" fill="#1d5fa6"/><rect x="5" y="6" width="9" height="3" rx="1.2" fill="#fff"/><rect x="8" y="10.5" width="11" height="3" rx="1.2" fill="#ffd54a"/><rect x="5" y="15" width="7" height="3" rx="1.2" fill="#fff" opacity=".85"/>';
  return svg;
}
function iconBtn(icon, title, onclick, disabled) {
  return h('button', { class: 'icon-btn', title, 'aria-label': title, onclick, disabled: !!disabled }, svgIcon(icon));
}

function buildShell() {
  els.top = h('header', { class: 'topbar' });
  els.main = h('main', { class: 'main' });
  // 予定を直すパネルは、押した棒のそばに浮かせて出す（カレンダーの幅を変えないよう、画面の並びには入れない）
  els.inspector = h('aside', { class: 'inspector', role: 'dialog', 'aria-label': '予定の編集', hidden: true });
  els.layout = h('div', { class: 'layout' }, els.main);
  document.body.append(h('div', { class: 'app' }, els.top, els.layout), els.inspector);
}

function renderTop() {
  const empty = store.isEmpty();
  fill(els.top,
    h('div', { class: 'brand' }, logo(), h('span', null, '取り付け工程表'),
      edition().label ? h('span', { class: 'edition-badge', title: 'サンプル用のファイルです。ここでの変更は、本番のファイルとは別に保存されます' }, edition().label) : null),
    viewTabs(),
    h('div', { class: 'top-actions' },
      h('span', { class: 'save-state', id: 'save-state' }),
      fileButton(),
      iconBtn('undo', '元に戻す (Ctrl+Z)', doUndo, !store.history.length),
      iconBtn('redo', 'やり直す (Ctrl+Shift+Z)', doRedo, !store.future.length),
      h('span', { class: 'sep' }),
      empty ? null : h('button', { class: 'btn', onclick: () => saveData(false), title: 'データをファイルに保存 (Ctrl+S)' }, svgIcon('save'), '保存'),
      h('button', { class: 'btn', 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget, dataMenuItems(empty)), title: '保存したデータを開く・別名で保存など' }, svgIcon('folder'), 'データ', svgIcon('menu', 14)),
      empty ? null : h('button', { class: 'btn primary', onclick: openPrint }, svgIcon('print'), '印刷'),
      platformButtons()));
  updateSaveState();
}

// つないでいたファイルに、つなぎ直すボタン（ブラウザの許可が要るとき・読み書きできなくなったとき）
function fileButton() {
  const f = fileLink();
  if (f.state !== 'ask' && f.state !== 'error') return null;
  return h('button', { class: 'btn file-btn' + (f.state === 'error' ? ' err' : ''), title: f.error || 'このファイルにも自動保存し、ほかで書き換えられたら読み込みます', onclick: () => reconnectFile() },
    svgIcon('folder'), '「' + f.name + '」とつなぎ直す');
}

function openPrint() {
  closeSitePop();
  closeViewEditor();
  if (panelKind()) closePanel();
  openPrintPreview();
}

function dataMenuItems(empty) {
  const items = [{ label: '開く', hint: '保存したデータ（.json）を読み込む', icon: 'folder', onClick: openData }];
  if (!empty) items.push({ label: '名前を付けて保存', hint: '別のファイルに保存する（以後そのファイルとつなぐ）', icon: 'save', onClick: () => saveData(true) });
  if (fileLink().state !== 'off') items.push({ label: 'ファイルとのつながりを外す', hint: '「' + fileLink().name + '」への自動保存と読み込みをやめる（ファイルは残る）', icon: 'x', onClick: async () => { await detachFile(); toast('ファイルとのつながりを外しました'); } });
  if (edition().sample) items.push('-', { label: 'サンプルを最初の状態に戻す', hint: 'このファイルで変えた内容を消して、配ったときの状態にする', icon: 'undo', onClick: resetSample });
  else if (!empty) items.push('-', { label: '最初の状態に戻す', hint: 'すべての現場・予定を消して、何もない状態から始める', icon: 'trash', onClick: () => resetAllData() });
  return items;
}

async function resetSample() {
  const ok = await confirmDialog('サンプルを最初の状態に戻します。このファイルで変更した内容は消えます（本番のファイルのデータには影響しません）。', { ok: '戻す' });
  if (!ok) return;
  ui.sel = null;
  closeSitePop(false);
  closeViewEditor(false);
  await detachFile();
  store.replace(deserialize(edition().sample));
  toast('サンプルを最初の状態に戻しました');
}

function updateSaveState() {
  const el = document.getElementById('save-state');
  if (!el) return;
  if (store.saveError) { el.textContent = 'ブラウザに保存できませんでした。「保存」でファイルに書き出してください'; el.className = 'save-state err'; return; }
  const f = fileLink();
  el.className = 'save-state' + (f.error ? ' err' : '');
  el.title = f.error || '';
  if (f.state === 'on') el.textContent = f.error ? '「' + f.name + '」の中身が読めません' : '「' + f.name + '」に自動保存';
  else if (f.state === 'off') el.textContent = store.lastSavedAt ? '自動保存済み' : '';
  else el.textContent = '';
}

let raf = 0;
// マウスを押している間に画面を作り直すと、その後のクリックが消えてしまう（入力欄から別のボタンへ移ったときなど）。
// 押している間は描き直しを待って、離したあとにまとめて描き直す
let pointerDown = false, renderWaiting = false, waitTimer = 0;
function scheduleRender() {
  if (pointerDown) {
    renderWaiting = true;
    clearTimeout(waitTimer);
    waitTimer = setTimeout(releasePointer, 3000);
    return;
  }
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderAll(); });
}
function releasePointer() {
  pointerDown = false;
  clearTimeout(waitTimer);
  if (renderWaiting) { renderWaiting = false; setTimeout(scheduleRender, 0); }
}
function renderAll() {
  // 描き直しの前にフォーカスのあった操作部品（data-fk）へ、描き直した後もフォーカスを戻す
  const fa = document.activeElement;
  const fk = fa && fa.dataset ? fa.dataset.fk : null;
  renderTop();
  renderOverview(els.main);
  renderInspector(els.inspector);
  syncSitePop();
  syncViewEditor();
  if (fk) {
    const el = document.querySelector('[data-fk="' + fk + '"]');
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
  }
}

function doUndo() { const l = store.undo(); if (l) toast('元に戻しました：' + l, { ms: 2200 }); }
function doRedo() { const l = store.redo(); if (l) toast('やり直しました：' + l, { ms: 2200 }); }

async function saveData(saveAs) {
  const name = await saveJson(!!saveAs);
  if (name) { toast('保存しました：' + name); updateSaveState(); }
}
async function openData() {
  const r = await pickJson();
  if (!r) return;
  try {
    if (!store.isEmpty()) {
      const ok = await confirmDialog('今のデータを「' + r.file.name + '」の内容に置き換えます。よろしいですか？', { ok: '開く' });
      if (!ok) return;
    }
    const { st, text } = await openJson(r.file);
    ui.sel = null;
    closeSitePop(false);
    closeViewEditor(false);
    // 前につないでいたファイルには書かない。開いたファイルとつなぐ（以後そこに自動保存し、ほかで書き換えられたら読み込む）
    await detachFile();
    store.replace(st);
    if (r.handle) await attachFile(r.handle, text);
    toast('「' + r.file.name + '」を開きました');
  } catch (e) {
    toast('開けませんでした：' + e.message, { type: 'err', ms: 6000 });
  }
}

function installKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (isPrintPreviewOpen()) {
      if (mod && k === 'p') { e.preventDefault(); window.print(); }
      else if (e.key === 'Escape' && !isModalOpen()) { e.preventDefault(); closePrintPreview(); }
      return;
    }
    if (isModalOpen()) return;
    // Ctrl+P・Ctrl+S は、ブラウザの印刷・保存ではなくこのツールの印刷・保存にする
    if (mod && k === 'p') { e.preventDefault(); if (!store.isEmpty()) openPrint(); return; }
    if (mod && k === 's') { e.preventDefault(); if (!store.isEmpty()) saveData(false); return; }
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
    if (e.key === 'Escape') {
      if (viewEditorOpen()) closeViewEditor();
      else if (sitePopPid()) closeSitePop();
      else if (panelKind()) closePanel();
    }
  });
}

function boot() {
  buildShell();
  initPlatform();
  // サンプル版は、まだ何も保存されていなければサンプルのデータで始める
  if (!store.load() && edition().sample) {
    try { store.state = deserialize(edition().sample); store.saveNow(); } catch (e) { console.warn(e); }
  }
  store.subscribe((reason) => { if (reason === 'saved') updateSaveState(); else scheduleRender(); });
  installKeys();
  installPrintHandlers();
  window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  window.addEventListener('blur', releasePointer);
  // 閉じる直前・別のタブに切り替えたときは、自動保存を待たずに保存する
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush(); });
  // 同じファイルを別のタブ・ウィンドウでも開いていて、そちらで保存されたら知らせる
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    toast('別のタブ（ウィンドウ）でデータが変更されました。こちらで編集を続けると上書きされます', { action: { label: '最新を読み込む', fn: () => location.reload() }, ms: 15000 });
  });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!isPrintPreviewOpen()) scheduleRender(); }, 150); });
  renderAll();
  initFileLink();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
