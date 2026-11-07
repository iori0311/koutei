// ビュー：出す現場と期間をまとめて覚えておき、上のタブで切り替える。印刷は開いているビューをそのまま出す
//   ・「すべての現場」はいつもある。＋ で自分のビューを作り、開いているタブをもう一度押すと名前・出す現場を変えられる
//   ・現場を作るのは「すべての現場」だけ。ビューは、作ってある現場を絞り込んで出すだけ
//   ・絞り込みは Excel のフィルターと同じ：「現場」と「施工業者」の 2 つの一覧で、両方にチェックが入っている現場を出す
import { store, uid, nameKey, whoNames, whoKeys, viewMatch } from './store.js';
import { h, svgIcon, toast } from './ui.js';

let ed = null;   // 開いている編集パネル { id, el, nameEl, siteList, whoList, countEl }

// 上のタブ
export function viewTabs() {
  const cur = store.activeView();
  const tab = (v) => {
    const on = v ? !!cur && cur.id === v.id : !cur;
    return h('button', {
      class: 'vtab' + (on ? ' on' : ''), type: 'button', dataset: { vid: v ? v.id : '' }, 'aria-pressed': on ? 'true' : 'false',
      title: v ? (on ? 'このビューの名前・出す現場を変える' : v.name) : 'すべての現場',
      onclick: () => {
        if (on && v) { if (ed && ed.id === v.id) closeViewEditor(); else openViewEditor(v.id); }
        else { closeViewEditor(); store.setView(v ? v.id : null, store.period()); }
      },
    }, h('span', { class: 'vtab-name' }, v ? v.name : 'すべての現場'), on && v ? svgIcon('menu', 12) : null);
  };
  return h('nav', { class: 'views', 'aria-label': 'ビュー' },
    tab(null),
    store.state.views.map(tab),
    // 現場が 1 つもないうちは出さない（ビューに出す現場を選べないので）
    store.isEmpty() ? null : h('button', { class: 'vtab vtab-add', type: 'button', title: 'ビューを作る', 'aria-label': 'ビューを作る', onclick: createView }, svgIcon('plus', 14)));
}

// 新しいビュー：今見ている期間・すべての現場から始めて、すぐに名前と絞り込みを決められるようにする
function createView() {
  const st = store.state;
  const period = store.period();
  const v = { id: uid('v'), name: 'ビュー' + (st.views.length + 1), pids: null, whos: null };
  closeViewEditor();
  store.commit('ビューを作る', [{ kind: 'views', id: 'views', before: st.views, after: [...st.views, v] }]);
  store.setView(v.id, period);
  openViewEditor(v.id, true);
}

function viewOf(id) { return store.state.views.find((v) => v.id === id) || null; }
function setViews(next, label) { store.commit(label, [{ kind: 'views', id: 'views', before: store.state.views, after: next }]); }
function patchView(v, patch, label) { setViews(store.state.views.map((x) => (x.id === v.id ? { ...x, ...patch } : x)), label); }

// 開いているビューの、名前と絞り込み（現場 × 施工業者）を変えるパネル（タブのすぐ下に出る）
export function openViewEditor(id, focusName) {
  closeViewEditor();
  const v = viewOf(id);
  if (!v) return;
  const nameEl = h('input', {
    value: v.name, 'aria-label': 'ビューの名前',
    onchange: () => rename(),
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); rename(); e.target.blur(); } },
  });
  const siteList = h('div', { class: 've-list', role: 'group', 'aria-label': '現場' });
  const whoList = h('div', { class: 've-list', role: 'group', 'aria-label': '施工業者' });
  const countEl = h('span', { class: 've-count' });
  const el = h('div', { class: 'view-pop', role: 'dialog', 'aria-label': 'ビューの設定' },
    h('button', { class: 'icon-btn sp-close', type: 'button', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: () => closeViewEditor() }, svgIcon('x')),
    h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, 'ビューの名前'), nameEl),
    h('div', { class: 've-grid' },
      h('div', { class: 'fld' }, h('span', { class: 'fld-l' }, '現場'), siteList),
      h('div', { class: 'fld' }, h('span', { class: 'fld-l' }, '施工業者'), whoList)),
    h('div', { class: 'sp-foot ve-foot' }, h('button', { class: 'btn small danger-outline', type: 'button', onclick: removeView }, svgIcon('trash'), 'このビューを削除'), countEl));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeViewEditor(); }
  });
  ed = { id, el, nameEl, siteList, whoList, countEl };
  renderLists();
  document.body.append(el);
  placeViewEditor();
  document.addEventListener('pointerdown', onViewDocDown, true);
  window.addEventListener('resize', placeViewEditor);
  if (focusName) requestAnimationFrame(() => { if (ed && nameEl.isConnected) { nameEl.focus(); nameEl.select(); } });
}

export function viewEditorOpen() { return !!ed; }

export function closeViewEditor(commit = true) {
  if (!ed) return;
  if (commit) rename();
  const { el } = ed;
  ed = null;
  el.remove();
  document.removeEventListener('pointerdown', onViewDocDown, true);
  window.removeEventListener('resize', placeViewEditor);
}

function rename() {
  if (!ed) return;
  const v = viewOf(ed.id);
  const name = ed.nameEl.value.trim();
  if (!v) return;
  if (!name) { ed.nameEl.value = v.name; return; }
  if (name !== v.name) patchView(v, { name }, 'ビューの名前を変更');
}

// 施工業者の一覧（現場の並び順で、はじめて出てきた順）。施工業者の入っていない現場があれば、最後に「施工業者なし」
function whoGroups(props) {
  const groups = new Map();
  for (const p of props) {
    const names = whoNames(p.contractor);
    if (!names.length) continue;
    for (const name of names) {
      const key = nameKey(name, true);
      if (!groups.has(key)) groups.set(key, { key, name });
    }
  }
  const list = [...groups.values()];
  if (props.some((p) => !whoNames(p.contractor).length)) list.push({ key: '', name: '' });
  return list;
}

// 2 つの一覧を作る。チェックが入っているものだけを出す（一番上の「すべて」で全部の付け外し）。
// もう一方の一覧で外れていて出ない現場・施工業者は薄くする。施工業者の横の数は、現場の一覧で残っている現場のうちの数
function renderLists() {
  if (!ed) return;
  const v = viewOf(ed.id);
  if (!v) return;
  const all = store.sortedProperties();
  const groups = whoGroups(all);
  const pidOn = (id) => !v.pids || v.pids.includes(id);
  const whoSet = v.whos && new Set(v.whos.map((x) => nameKey(x, true)));
  const bySite = all.filter((p) => pidOn(p.id));
  fillList(ed.siteList, 'site',
    all.map((p) => ({ key: p.id, label: p.name.replace(/\s*\n\s*/g, ' '), on: pidOn(p.id), dim: !viewMatch({ pids: null, whos: v.whos }, p) })),
    (allOn) => patchView(v, { pids: allOn ? [] : null }, allOn ? 'ビューの現場をすべて外す' : 'ビューの現場をすべて出す'),
    (key, on) => toggleIn(v, 'pids', all.map((p) => ({ key: p.id, value: p.id })), key, on, on ? 'ビューに現場を出す' : 'ビューから現場を外す'));
  fillList(ed.whoList, 'who',
    groups.map((g) => {
      const n = bySite.filter((p) => whoKeys(p).includes(g.key)).length;
      return { key: g.key, label: g.key ? g.name : '（施工業者なし）', on: !whoSet || whoSet.has(g.key), dim: n === 0, count: n + ' 現場' };
    }),
    (allOn) => patchView(v, { whos: allOn ? [] : null }, allOn ? 'ビューの施工業者をすべて外す' : 'ビューの施工業者をすべて出す'),
    (key, on) => toggleIn(v, 'whos', groups.map((g) => ({ key: g.key, value: g.name })), key, on, on ? 'ビューに施工業者を出す' : 'ビューから施工業者を外す'));
  ed.countEl.textContent = all.filter((p) => viewMatch(v, p)).length + ' 現場を表示';
}

// 一覧の中身：一番上に「すべて」（全部チェック／一部だけ／なし）、その下に 1 つずつ
function fillList(list, kind, items, onAll, onItem) {
  const nOn = items.filter((x) => x.on).length;
  const allOn = items.length > 0 && nOn === items.length;
  const allBox = h('input', { type: 'checkbox', checked: allOn, dataset: { k: kind + ':*' }, onchange: () => onAll(allOn) });
  allBox.indeterminate = nOn > 0 && nOn < items.length;
  list.replaceChildren(
    h('label', { class: 've-item ve-all' }, allBox, h('span', { class: 've-tx' }, 'すべて')),
    ...items.map((x) => h('label', { class: 've-item' + (x.on ? ' on' : '') + (x.dim ? ' dim' : '') },
      h('input', { type: 'checkbox', checked: x.on, dataset: { k: kind + ':' + x.key }, onchange: (e) => onItem(x.key, e.target.checked) }),
      h('span', { class: 've-tx' }, x.label),
      x.count ? h('span', { class: 've-n' }, x.count) : null)));
  if (!items.length) list.append(h('p', { class: 've-empty' }, kind === 'site' ? '現場がまだありません' : '施工業者の入った現場がまだありません'));
}

// 1 つ付け外しする。今ある全部にチェックが入ったら「すべて」（あとで足したものも出る）に戻す
//   items: 今ある全部 [{ key: 目印, value: 覚えておく値（現場は id、施工業者は名前） }]
function toggleIn(v, field, items, key, on, label) {
  const keyOf = field === 'whos' ? (x) => nameKey(x, true) : (x) => x;
  const cur = v[field] === null ? items.map((x) => x.value) : v[field].slice();
  const rest = cur.filter((x) => keyOf(x) !== key);
  let next = on ? [...rest, (items.find((x) => x.key === key) || { value: key }).value] : rest;
  const have = new Set(next.map(keyOf));
  if (items.every((x) => have.has(x.key))) next = null;
  patchView(v, { [field]: next }, label);
}

function removeView() {
  const v = ed && viewOf(ed.id);
  if (!v) return;
  closeViewEditor(false);
  setViews(store.state.views.filter((x) => x.id !== v.id), 'ビューを削除');
  store.setView(null);
  toast('「' + v.name + '」を削除しました', { action: { label: '元に戻す', fn: () => { store.undo(); store.setView(v.id); } } });
}

// パネルの外を押したら閉じる（開いているタブを押したときは、タブの側で閉じる）
function onViewDocDown(e) {
  if (!ed) return;
  const t = e.target;
  if (!(t instanceof Element) || ed.el.contains(t) || t.closest('.modal-back, .toast')) return;
  if (t.closest('.vtab.on')) return;
  closeViewEditor();
}

// 開いているタブのすぐ下に出す
function placeViewEditor() {
  if (!ed) return;
  const tab = document.querySelector('.vtab[data-vid="' + CSS.escape(ed.id) + '"]');
  if (!tab) { ed.el.style.visibility = 'hidden'; return; }
  ed.el.style.visibility = '';
  const r = tab.getBoundingClientRect();
  const w = ed.el.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  ed.el.style.top = r.bottom + 8 + 'px';
  ed.el.style.left = left + 'px';
  // 矢印はタブを指す
  ed.el.style.setProperty('--ax', Math.round(Math.max(14, Math.min(w - 26, r.left + Math.min(28, r.width / 2) - left - 6))) + 'px');
}

// 画面を描き直したあと：ビューが消えていたら閉じる。一覧と位置を合わせる（押していたチェックにフォーカスを戻す）
export function syncViewEditor() {
  if (!ed) return;
  const v = viewOf(ed.id);
  if (!v || !store.activeView() || store.activeView().id !== ed.id) { closeViewEditor(false); return; }
  if (document.activeElement !== ed.nameEl) ed.nameEl.value = v.name;
  const ae = document.activeElement;
  const focusKey = ae instanceof HTMLElement && ed.el.contains(ae) ? ae.dataset.k : null;
  renderLists();
  if (focusKey) { const b = ed.el.querySelector('[data-k="' + CSS.escape(focusKey) + '"]'); if (b) b.focus({ preventScroll: true }); }
  placeViewEditor();
}
