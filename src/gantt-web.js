// Web 画面：全体工程（現場名・施工業者・カレンダー）と、予定を直すパネル（押した棒の行のすぐ下に浮かせて出す）
import { store, uid, textOn, edgeOf } from './store.js';
import { h, svgIcon, toast } from './ui.js';
import { dn, iso, ymd, dow, WD_JA, todayDn, monthStart, addMonths, monthEnd, fmtMDW, fmtYMD, validDn } from './dates.js';
import { textW, makeDayInfo, monthSegments, layoutRow } from './layout.js';
import { monthRange, MAX_MONTHS } from './month-range.js';
import { openPropertyDialog } from './edit-dialogs.js';
import { openSitePop, sitePopPid, sitePopJustClosed, sitePopClosedFor } from './site-pop.js';
import { openViewEditor } from './views.js';

// 画面上の選択：sel = パネルで直している予定、editCat = 凡例で名前を書き換え中の種別
// draft = パネルで打っている途中の内容（確定する前からガントに出す）
// reveal = パネルで日付を変えた予定（横スクロールの外へ出たら、見えるところまでスクロールする）
export const ui = { sel: null, editCat: null, focusLabel: false, draft: null, reveal: null };

// 1日の幅（px・小数）。選んだ期間がカレンダーの横幅にちょうど収まるように、描くたびに決める。
// ただし日付と曜日が読める幅（MIN_DAY_W）より細くはしない。入りきらない長い期間は横スクロールで見る
let dayW = 24;
const MIN_DAY_W = 18;
// 期間の最初から n 日目の左端（px）。位置は整数にそろえて、線や棒がにじまないようにする
function px(n) { return Math.round(n * dayW); }
const FPX = 12, LANE_H = 22, BAR_H = 16, PAD = 5;   // 文字の大きさ・段の高さ・棒の高さ・行の上下の余白
const LBL_PAD = 4, LBL_GAP = 10;   // 棒と内容の文字のすき間・文字とほかの予定のあいだ（どの棒の文字か分かるように広め）

// パネルに出すもの: 'event'（予定）/ null（パネルを閉じる）
export function panelKind() { return ui.sel && store.state.events.has(ui.sel) ? 'event' : null; }
export function closePanel() {
  ui.sel = null;
  store.emit('select');
}
function select(id, focus) {
  ui.sel = id;
  if (focus) ui.focusLabel = true;
  store.emit('select');
}
export function newSite() { openPropertyDialog(); }

// ---------- 共通 ----------
function fmtSpan(s, e) {
  if (s === e) return fmtMDW(s);
  const a = ymd(s), b = ymd(e);
  return fmtMDW(s) + '〜' + (a.y === b.y && a.m === b.m ? b.d + '(' + WD_JA[dow(e)] + ')' : fmtMDW(e));
}
function chip(c) {
  return h('i', { class: 'chip' + (c.memo ? ' memo' : ''), style: c.memo ? null : 'background:#' + c.color + ';border-color:#' + edgeOf(c.color) });
}

function buildScale(from, to, info) {
  const W = px(to - from + 1);
  const months = h('div', { class: 'sc-months', style: 'width:' + W + 'px' });
  for (const seg of monthSegments(from, to)) {
    const left = px(seg.start - from), width = px(seg.end - from + 1) - left;
    months.append(h('div', { class: 'sc-month', style: 'left:' + left + 'px;width:' + width + 'px' }, h('span', null, width >= 64 ? seg.y + '年' + seg.m + '月' : seg.m + '月')));
  }
  // 日付と曜日（1日は MIN_DAY_W 以上あるので、いつも両方入る）
  const days = h('div', { class: 'sc-days', style: 'width:' + W + 'px' });
  for (let d = from; d <= to; d++) {
    const inf = info(d);
    const cls = 'sc-day ' + inf.kind + (inf.w === 6 ? ' is-sat' : '') + (inf.w === 0 ? ' is-sun' : '') + (ymd(d).d === 1 ? ' m1' : '');
    days.append(h('div', { class: cls, style: 'left:' + px(d - from) + 'px;width:' + (px(d - from + 1) - px(d - from)) + 'px', title: fmtYMD(d) + '(' + WD_JA[inf.w] + ')' + (inf.name ? ' ' + inf.name : '') },
      h('b', null, ymd(d).d), h('i', null, WD_JA[inf.w])));
  }
  return h('div', { class: 'sc' }, months, days);
}

function buildBg(from, to, info) {
  const W = px(to - from + 1);
  const bg = h('div', { class: 'g-bg', style: 'width:' + W + 'px' });
  for (let d = from; d <= to; d++) {
    const k = info(d).kind;
    if (k) bg.append(h('div', { class: 'bg-day ' + k, style: 'left:' + px(d - from) + 'px;width:' + (px(d - from + 1) - px(d - from)) + 'px' }));
  }
  // 1 日ごとの縦の線
  for (let d = from + 1; d <= to; d++) bg.append(h('div', { class: 'bg-line', style: 'left:' + px(d - from) + 'px' }));
  for (const seg of monthSegments(from, to)) if (seg.start > from) bg.append(h('div', { class: 'bg-month', style: 'left:' + px(seg.start - from) + 'px' }));
  return bg;
}

// 棒の左端・右端（表示している期間に切り詰める）。日の境目の線にかからないよう、左右を 1px ずつあける
function screenBarBox(s, e, from, to) {
  const a = Math.max(s, from), b = Math.min(e, to);
  return [px(a - from) + 1, px(b - from + 1) - 1];
}

// 両端の取っ手は、棒の外側へ最大 HD_OUT px はみ出してつかめる（1 日だけの細い棒でも伸ばし縮めしやすい）。
// はみ出す幅（ol・or）は、同じ段のとなりの棒やカレンダーの端にかからない分だけ
const HD_OUT = 8;
function barEl(e, c, label, from, to, ol = 0, or = 0) {
  const [x0, x1] = screenBarBox(e.start, e.end, from, to);
  const col = c.memo ? 'C9CED6' : c.color;
  return h('div', {
    class: 'bar' + (c.memo ? ' memo' : '') + (e.pinned ? ' pinned' : '') + (e.start < from ? ' cut-l' : '') + (e.end > to ? ' cut-r' : '') + (ui.sel === e.id ? ' sel' : ''),
    style: 'left:' + x0 + 'px;width:' + (x1 - x0) + 'px;--c:#' + col + ';--e:#' + edgeOf(col) + ';--t:' + textOn(col) + ';--ol:' + ol + 'px;--or:' + or + 'px',
    dataset: { id: e.id },
    title: (label || c.name) + '\n' + fmtSpan(e.start, e.end),
  },
  h('span', { class: 'hd hd-l' }), h('span', { class: 'hd hd-r' }),
  h('button', { class: 'pin-btn', type: 'button', 'aria-label': e.pinned ? 'ピンを外す' : 'ピンで固定', 'aria-pressed': e.pinned ? 'true' : 'false' }, svgIcon('pin', 11)));
}

// 新しい予定は「色なし」で作り、種別（色）はあとで選ぶ
function createEvent(pid, d) {
  const cats = store.state.categories;
  const cat = (cats.find((c) => c.memo) || cats[0]).id;
  const ev = store.addEvent({ pid, cat, label: '', start: d, end: d });
  select(ev.id, true);
}

function togglePin(id) {
  const e = store.state.events.get(id);
  if (e) store.updateEvent(id, { pinned: !e.pinned }, e.pinned ? 'ピンを外す' : 'ピンで固定');
}

// ---------- 棒のドラッグ（真ん中をつかむと移動、両端をつかむと期間の変更）。ピンで固定した予定は動かない ----------
let suppressClick = false;
function startBarDrag(ev, bar, e, scroll, from, to) {
  ev.preventDefault();
  let mode = ev.target.classList.contains('hd-l') ? 'start' : ev.target.classList.contains('hd-r') ? 'end' : 'move';
  // 表示している期間の外まで続いている側の端は本当の端ではないので、移動として扱う
  if ((mode === 'start' && e.start < from) || (mode === 'end' && e.end > to)) mode = 'move';
  const x0 = ev.clientX;
  const days = scroll.querySelectorAll('.sc-day');
  const label = scroll.querySelector('.o-label[data-for="' + e.id + '"]');
  const band = h('div', { class: 'drop-band' });
  let delta = 0, moved = false;
  bar.setPointerCapture(ev.pointerId);
  const range = () => {
    if (mode === 'move') return [e.start + delta, e.end + delta];
    if (mode === 'start') return [Math.min(e.end, e.start + delta), e.end];
    return [e.start, Math.max(e.start, e.end + delta)];
  };
  // 動かしている間：棒・行き先の日（見出しとカレンダー全体）を光らせる
  const paint = () => {
    const [s, en] = range();
    const [x0, x1] = screenBarBox(s, en, from, to);
    bar.style.left = x0 + 'px';
    bar.style.width = x1 - x0 + 'px';
    const a = Math.max(s, from), b = Math.min(en, to);
    band.style.left = px(a - from) + 'px';
    band.style.width = Math.max(0, px(b - from + 1) - px(a - from)) + 'px';
    days.forEach((el, i) => el.classList.toggle('hl', from + i >= s && from + i <= en));
  };
  const cleanup = () => {
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    if (bar.hasPointerCapture(ev.pointerId)) bar.releasePointerCapture(ev.pointerId);
    bar.classList.remove('dragging');
    document.body.classList.remove('drag-move', 'drag-resize');
    band.remove();
    days.forEach((el) => el.classList.remove('hl'));
    if (label) label.style.visibility = '';
  };
  // 棒を動かしたあとのクリックは「選ぶ」にしない
  const swallowClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); };
  const onMove = (m) => {
    const dx = m.clientX - x0;
    if (!moved) {
      if (Math.abs(dx) < 4) return;
      moved = true;
      if (e.pinned) {
        // ピンで固定されている：動かずに小さく震える
        cleanup();
        swallowClick();
        bar.classList.remove('shake');
        void bar.offsetWidth;
        bar.classList.add('shake');
        return;
      }
      bar.classList.add('dragging');
      document.body.classList.add(mode === 'move' ? 'drag-move' : 'drag-resize');
      scroll.querySelector('.g-bg').append(band);
      if (label) label.style.visibility = 'hidden';
    }
    delta = Math.round(dx / dayW);
    paint();
  };
  const onUp = () => {
    cleanup();
    if (!moved || e.pinned) return;
    swallowClick();
    const [s, en] = range();
    if (s !== e.start || en !== e.end) store.updateEvent(e.id, { start: s, end: en }, mode === 'move' ? '日程を移動' : '期間を変更');
    else store.emit('select');
  };
  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

// ---------- 凡例（種別）：その場で追加・名前と色の変更・削除 ----------
const NEW_COLORS = ['3D7DCA', 'E67E22', '16A085', '8E44AD', 'D35400', '27AE60', '2C3E50', 'C0392B', '7F8C8D', 'F1C40F'];

function setCategories(next, extra, label) {
  store.commit(label, [{ kind: 'categories', id: 'categories', before: store.state.categories, after: next }, ...extra]);
}
function patchCategory(id, patch, label) {
  setCategories(store.state.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)), [], label);
}
function addCategory() {
  const cats = store.state.categories;
  const used = new Set(cats.map((c) => c.color));
  const nc = { id: uid('c'), name: '新しい種別', color: NEW_COLORS.find((x) => !used.has(x)) || NEW_COLORS[cats.length % NEW_COLORS.length] };
  const next = [...cats];
  const mi = next.findIndex((c) => c.memo);
  next.splice(mi < 0 ? next.length : mi, 0, nc);
  ui.editCat = nc.id;
  setCategories(next, [], '種別を追加');
}
// 消した種別の予定は「色なし」にする
function deleteCategory(id) {
  const st = store.state;
  const c = st.categories.find((x) => x.id === id);
  const memo = st.categories.find((x) => x.memo);
  if (!c || c.memo || !memo) return;
  const extra = [];
  for (const e of st.events.values()) if (e.cat === id) extra.push({ kind: 'event', id: e.id, before: e, after: { ...e, cat: memo.id } });
  setCategories(st.categories.filter((x) => x.id !== id), extra, '種別を削除');
  toast('「' + c.name + '」を削除しました', { action: { label: '元に戻す', fn: () => store.undo() } });
}

function legendItem(c) {
  const editing = ui.editCat === c.id;
  let name;
  if (editing) {
    let done = false;
    const finish = (save) => {
      if (done || ui.editCat !== c.id) return;
      done = true;
      ui.editCat = null;
      const v = name.value.trim();
      if (save && v && v !== c.name) patchCategory(c.id, { name: v }, '種別名を変更');
      else store.emit('select');
    };
    name = h('input', {
      class: 'lg-input', value: c.name, 'aria-label': '種別名',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      },
      onblur: () => finish(true),
    });
    requestAnimationFrame(() => { name.focus(); name.select(); });
  } else {
    name = h('button', { class: 'lg-name', type: 'button', title: '名前を変える', onclick: () => { ui.editCat = c.id; store.emit('select'); } }, c.name);
  }
  return h('span', { class: 'lg' + (editing ? ' editing' : '') },
    h('label', { class: 'lg-color', title: '色を変える', style: 'background:#' + c.color + ';border-color:#' + edgeOf(c.color) },
      h('input', { type: 'color', value: '#' + c.color.toLowerCase(), 'aria-label': c.name + 'の色', onchange: (e) => patchCategory(c.id, { color: e.target.value.slice(1).toUpperCase() }, '種別の色を変更') })),
    name,
    h('button', { class: 'lg-del', type: 'button', title: '削除', 'aria-label': c.name + 'を削除', onclick: () => deleteCategory(c.id) }, svgIcon('x', 10)));
}

function legendBar() {
  return h('div', { class: 'legend-bar' }, store.state.categories.filter((c) => !c.memo).map(legendItem),
    h('button', { class: 'lg-add', type: 'button', title: '種別を追加', 'aria-label': '種別を追加', onclick: addCategory }, svgIcon('plus', 14)));
}

// ---------- 全体工程 ----------
let ovMemo = { from: null, left: 0, top: 0 };

// 開いているビューの期間
export function overviewRange() {
  const p = store.period();
  const from = p.from ?? monthStart(todayDn());
  return [from, monthEnd(addMonths(from, p.months - 1))];
}

// 縦スクロールバーの幅（Windows などで、カレンダーの横幅から引く）
let sbw = null;
function scrollbarW() {
  if (sbw === null) {
    const d = h('div', { style: 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll' });
    document.body.append(d);
    sbw = d.offsetWidth - d.clientWidth;
    d.remove();
  }
  return sbw;
}

// ガントに出す内容。パネルで打っている途中なら、その文字を出す
function labelOf(e) { return (ui.draft && ui.draft.id === e.id ? ui.draft.label : e.label || '').trim(); }

// 棒の横に置く内容の文字。左に置くときは右端を棒にそろえる（文字の幅が少し違っても棒にかからない）
function sideLabel(it, top, W, cls) {
  const pl = it.pl;
  const pos = pl.mode === 'left' ? 'right:' + (W - pl.lx - pl.lw) + 'px' : 'left:' + pl.lx + 'px';
  return h('div', {
    class: cls + (pl.mode === 'clip' ? ' clip' : ''), dataset: { for: it.e.id }, title: it.label,
    style: pos + ';top:' + top + 'px;height:' + LANE_H + 'px;line-height:' + LANE_H + 'px' + (pl.mode === 'clip' ? ';width:' + pl.lw + 'px' : ''),
  }, it.label);
}

export function renderOverview(root) {
  const st = store.state;
  const oldScroll = root.querySelector('.g-scroll');
  if (oldScroll) { ovMemo.left = oldScroll.scrollLeft; ovMemo.top = oldScroll.scrollTop; }
  const rootW = root.clientWidth || 1100;
  root.replaceChildren();
  const [from, to] = overviewRange();
  const narrow = rootW < 1000;
  const leftW = narrow ? 200 : 330;
  // 選んだ期間がカレンダーの横幅にちょうど収まる 1 日の幅。日付と曜日が読める幅（MIN_DAY_W）より細くなるなら、
  // MIN_DAY_W にして横スクロールで見る（1px 足りないくらいなら、そのまま収めてわずかな横スクロールは出さない）
  const fit = (rootW - leftW - scrollbarW()) / (to - from + 1);
  dayW = fit >= MIN_DAY_W - 1 ? fit : MIN_DAY_W;
  const W = px(to - from + 1);
  const info = makeDayInfo();
  const view = store.activeView();
  const props = store.viewProperties();
  const editingPid = sitePopPid();

  // 表示する期間：月の帯で「何月〜何月」を選ぶ
  const tb = h('div', { class: 'toolbar' },
    monthRange({
      id: 'screen', from, months: store.period().months, cellW: 40,
      count: Math.max(MAX_MONTHS, Math.min(18, Math.floor((rootW - 110) / 40))),
      onChange: (f, n) => store.setPeriod(f, n),
    }));

  const scroll = h('div', { class: 'g-scroll ov' + (narrow ? ' narrow' : ''), style: '--leftw:' + leftW + 'px' });
  const inner = h('div', { class: 'g-inner', style: 'width:' + (leftW + W) + 'px' });
  inner.append(h('div', { class: 'g-header' },
    h('div', { class: 'g-corner' }, h('div', { class: 'o-name' }, '現場名'), h('div', { class: 'o-who' }, '施工業者')),
    buildScale(from, to, info)));
  const body = h('div', { class: 'g-body' });
  body.append(buildBg(from, to, info));
  for (const p of props) {
    // 棒と内容の文字が重ならないように段を決める（印刷と同じ決め方）
    const items = store.eventsOf(p.id).filter((e) => e.end >= from && e.start <= to).map((e) => {
      const label = labelOf(e);
      return {
        e, c: store.category(e.cat), label,
        lw: label ? Math.ceil(textW(label, FPX)) + 2 : 0,
      };
    });
    for (const it of items) [it.b0, it.b1] = screenBarBox(it.e.start, it.e.end, from, to);
    const lanes = layoutRow(items, W, LBL_PAD, LBL_GAP);
    const rowH = Math.max(48, lanes * LANE_H + PAD * 2);
    // 取っ手が棒の外へはみ出せる幅：同じ段のとなりの棒とは半分ずつ分け、カレンダーの端からは出さない
    const byLane = new Map();
    for (const it of items) { if (!byLane.has(it.lane)) byLane.set(it.lane, []); byLane.get(it.lane).push(it); }
    for (const lane of byLane.values()) {
      lane.sort((a, b) => a.b0 - b.b0);
      lane.forEach((it, k) => {
        const roomL = k > 0 ? (it.b0 - lane[k - 1].b1) / 2 : it.b0;
        const roomR = k < lane.length - 1 ? (lane[k + 1].b0 - it.b1) / 2 : W - it.b1;
        it.ol = Math.max(0, Math.min(HD_OUT, Math.floor(roomL)));
        it.or = Math.max(0, Math.min(HD_OUT, Math.floor(roomR)));
      });
    }
    const track = h('div', { class: 'o-track', dataset: { pid: p.id }, style: 'width:' + W + 'px' });
    for (const it of items) {
      const top = PAD + it.lane * LANE_H;
      const bar = barEl(it.e, it.c, it.label, from, to, it.ol, it.or);
      bar.style.top = top + (LANE_H - BAR_H) / 2 + 'px';
      bar.style.height = BAR_H + 'px';
      if (it.pl.mode === 'inside') bar.append(h('span', { class: 'in-label' }, it.label));
      track.append(bar);
      if (it.pl.mode === 'right' || it.pl.mode === 'left' || it.pl.mode === 'clip') track.append(sideLabel(it, top, W, 'o-label'));
    }
    // 現場名と施工業者はひとかたまりのボタン：どこを押しても、その場で直せる小さなパネルが出る
    const site = h('button', { class: 'o-site', type: 'button', title: '現場名・施工業者を直す' },
      h('span', { class: 'o-name' }, h('span', { class: 'o-tx' }, p.name)),
      h('span', { class: 'o-who' }, h('span', { class: 'o-tx' }, p.contractor || '')),
      h('i', { class: 'o-pen' }, svgIcon('edit', 12)));
    body.append(h('div', { class: 'g-row o-row' + (editingPid === p.id ? ' sel' : ''), dataset: { pid: p.id }, style: 'min-height:' + rowH + 'px' },
      h('div', { class: 'g-cells' }, site),
      track));
  }
  // 一番下の行：「すべての現場」では「現場を追加」（現場がまだないときは目立たせる）。
  // 自分で作ったビューでは現場を作らない。絞り込みで出ていない現場があれば「出す現場を選ぶ」だけを置く（1 つも出ていないときは目立たせる）
  const canPick = !!view && st.properties.size > props.length;
  const addBtn = !view
    ? h('button', { class: 'o-add-btn' + (store.isEmpty() ? ' first' : ''), onclick: () => newSite() }, svgIcon('plus', 14), '現場を追加')
    : canPick
      ? h('button', { class: 'o-add-btn' + (!props.length ? ' first' : ''), onclick: () => openViewEditor(view.id) }, svgIcon('menu', 14), '出す現場を選ぶ')
      : null;
  if (addBtn) body.append(h('div', { class: 'g-row o-add' }, h('div', { class: 'g-cells' }, addBtn), h('div', { class: 'o-add-track', style: 'width:' + W + 'px' })));
  inner.append(body);
  scroll.append(inner);
  root.append(h('div', { class: 'ovv' }, tb, legendBar(), h('div', { class: 'gantt' }, scroll)));
  // 描き直しても見ていた場所のまま（最初の月を変えたときだけ左端に戻る）
  scroll.scrollTop = ovMemo.top;
  if (ovMemo.from === from) scroll.scrollLeft = ovMemo.left;
  ovMemo.from = from;
  // パネルで日付を変えた予定が、横スクロールで見えていないところへ動いたら、見えるところまでスクロールする
  if (ui.reveal) {
    const b = inner.querySelector('.bar[data-id="' + CSS.escape(ui.reveal) + '"]');
    ui.reveal = null;
    if (b) {
      const x0 = parseFloat(b.style.left), x1 = x0 + parseFloat(b.style.width);
      const viewW = scroll.clientWidth - leftW;
      if (x0 < scroll.scrollLeft || x1 > scroll.scrollLeft + viewW) scroll.scrollLeft = Math.max(0, x0 - Math.max(24, (viewW - (x1 - x0)) / 2));
    }
  }

  // 棒をつかむ → 移動・期間の変更
  scroll.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.pin-btn')) return;
    const bar = ev.target.closest('.bar');
    const e = bar && st.events.get(bar.dataset.id);
    if (e) startBarDrag(ev, bar, e, scroll, from, to);
  });
  // 現場名・施工業者 → その場で直す／ピン → 固定・解除／棒・文字 → その予定を編集／行の空いているところ → その日に予定を追加
  scroll.addEventListener('click', (ev) => {
    if (suppressClick) return;
    const siteBtn = ev.target.closest('.o-site');
    if (siteBtn) {
      const pid = siteBtn.closest('.o-row').dataset.pid;
      if (sitePopClosedFor(pid)) return;   // 開いていた現場をもう一度押した：閉じるだけ
      ui.sel = null;
      openSitePop(pid);
      store.emit('select');
      return;
    }
    const pin = ev.target.closest('.pin-btn');
    if (pin) { togglePin(pin.closest('.bar').dataset.id); return; }
    const hit = ev.target.closest('.bar, .o-label');
    if (hit) {
      const id = hit.dataset.id || hit.dataset.for;
      if (inspClosed.id === id) return;   // 開いていた棒をもう一度押した：閉じるだけ
      select(id);
      return;
    }
    const track = ev.target.closest('.o-track');
    if (!track) return;
    // パネルを閉じるためのクリックでは、予定を作らない
    if (sitePopJustClosed() || inspClosed.track) return;
    if (panelKind()) { closePanel(); return; }
    const r = track.getBoundingClientRect();
    createEvent(track.dataset.pid, Math.min(to, from + Math.floor((ev.clientX - r.left) / dayW)));
  });
  // 行の空いているところにカーソルを乗せると、その日に「＋」の枠を出す（クリックで予定ができる場所）
  const ghost = h('div', { class: 'add-ghost' }, svgIcon('plus', 14));
  scroll.addEventListener('pointermove', (ev) => {
    const track = panelKind() || sitePopPid() || document.body.classList.contains('drag-move') || document.body.classList.contains('drag-resize') || ev.target.closest('.bar, .o-label')
      ? null : ev.target.closest('.o-track');
    if (!track) { ghost.remove(); return; }
    const r = track.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left) / dayW);
    ghost.style.left = px(i) + 1 + 'px';
    ghost.style.width = px(i + 1) - px(i) - 2 + 'px';
    if (ghost.parentElement !== track) track.append(ghost);
  });
  scroll.addEventListener('pointerleave', () => ghost.remove());
}

// ---------- 予定を直すパネル：押した棒の行のすぐ下（入らなければ上、それも無理なら棒の横）に浮かせて出す。カレンダーの幅は変えない ----------
let insp = null;        // パネルの外枠（main.js が作る）
let inspClosed = { track: false, id: null };   // パネルの外を押して閉じたところ（そのクリックで予定を作ったり、開き直したりしない）
let inspPlaced = false; // 一度でも棒のそばに置いたか（日付を変えて棒が今の期間の外へ出ても、そのまま同じ場所に出しておく）

function setupInspector(root) {
  insp = root;
  // Esc：打ちかけの内容・日付を確定してから閉じる
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (root.contains(document.activeElement)) document.activeElement.blur();
    closePanel();
  });
  // パネルの外を押したら閉じる（カレンダーの空いているところ・日付の見出し・凡例・AI のパネルも外）。お知らせ・確認ダイアログでは閉じない。
  //   行の空いているところを押して閉じたときは、そのクリックで予定を作らない。開いている棒をもう一度押したときは、閉じるだけ
  document.addEventListener('pointerdown', (e) => {
    if (!panelKind()) return;
    const t = e.target;
    if (!(t instanceof Element) || root.contains(t) || t.closest('.toast, .modal-back')) return;
    const hit = t.closest('.bar, .o-label');
    inspClosed = { track: !hit && !!t.closest('.o-track'), id: hit && (hit.dataset.id || hit.dataset.for) === ui.sel ? ui.sel : null };
    window.addEventListener('pointerup', () => setTimeout(() => { inspClosed = { track: false, id: null }; }, 0), { once: true, capture: true });
    closePanel();
  }, true);
  window.addEventListener('scroll', placeInspector, true);
  window.addEventListener('resize', placeInspector);
}

// 棒のそばに置く。棒がスクロールで見えないところにあるときは隠す
function placeInspector() {
  if (!insp || insp.hidden) return;
  // いまパネルに出している予定の棒に合わせる（別の棒を押した直後、描き直す前に古い中身が新しい棒のそばへ動かないように）
  const key = insp.dataset.key || '';
  const id = key.startsWith('event:') ? key.slice(6) : null;
  const bar = id && document.querySelector('.g-scroll .bar[data-id="' + CSS.escape(id) + '"]');
  const sc = bar && bar.closest('.g-scroll');
  if (!bar || !sc) {
    // 日付を変えて棒が今の期間の外へ出た：さっきの場所にそのまま出しておく（はじめてなら右上）
    insp.style.visibility = '';
    if (!inspPlaced) { insp.classList.add('side'); insp.style.top = '120px'; insp.style.left = Math.max(8, window.innerWidth - insp.offsetWidth - 24) + 'px'; }
    return;
  }
  const r = bar.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  const hdr = sc.querySelector('.g-header');
  const top0 = hdr ? hdr.getBoundingClientRect().bottom : sr.top, bot0 = sr.top + sc.clientHeight;
  const left0 = sr.left + (parseFloat(sc.style.getPropertyValue('--leftw')) || 0), right0 = sr.left + sc.clientWidth;
  if (r.bottom < top0 + 2 || r.top > bot0 - 2 || r.right < left0 + 2 || r.left > right0 - 2) { insp.style.visibility = 'hidden'; return; }
  insp.style.visibility = '';
  const w = insp.offsetWidth, ht = insp.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, GAP = 10;
  // 棒の見えている部分
  const ax0 = Math.max(r.left, left0), ax1 = Math.min(r.right, right0);
  // 上下に出すときは、その行の下（上）に出す。同じ行のほかの段の棒や、打っている内容の文字を隠さないように
  const rr = (bar.closest('.o-row') || bar).getBoundingClientRect();
  const y0 = Math.max(rr.top, top0), y1 = Math.min(rr.bottom, bot0);
  let top, left, where;
  if (y1 + GAP + ht <= vh - 8) { where = 'below'; top = y1 + GAP; }
  else if (y0 - GAP - ht >= 8) { where = 'above'; top = y0 - GAP - ht; }
  else { where = 'side'; top = Math.max(8, Math.min(vh - 8 - ht, r.top - 40)); }
  if (where === 'side') {
    // 上にも下にも入らない：棒の右（入らなければ左）に、棒にかからないように置く
    left = ax1 + GAP + w <= vw - 8 ? ax1 + GAP : ax0 - GAP - w >= 8 ? ax0 - GAP - w : Math.max(8, Math.min(vw - w - 8, ax0 - 16));
  } else {
    left = Math.max(8, Math.min(vw - w - 8, ax0 - 16));
  }
  insp.classList.toggle('above', where === 'above');
  insp.classList.toggle('side', where === 'side');
  insp.style.top = Math.round(top) + 'px';
  insp.style.left = Math.round(left) + 'px';
  // 矢印は、棒の見えている部分の真ん中を指す
  insp.style.setProperty('--ax', Math.round(Math.max(12, Math.min(w - 24, (ax0 + ax1) / 2 - left - 6))) + 'px');
  inspPlaced = true;
}

export function renderInspector(root) {
  if (insp !== root) setupInspector(root);
  const st = store.state;
  const kind = panelKind();
  if (ui.sel && !kind) ui.sel = null;
  const obj = kind ? st.events.get(ui.sel) : null;
  const key = obj ? 'event:' + obj.id : 'none';
  const ae = document.activeElement;
  // 入力欄で入力中なら作り直さずに値だけ合わせる（打っている文字が消えないように）
  if (root.dataset.key === key && ae && root.contains(ae) && ae.matches('input, textarea, select')) {
    syncFields(root, obj);
    placeInspector();
    return;
  }
  // 別の予定に切り替わったら、置き場所も決め直す
  if (root.dataset.key !== key) inspPlaced = false;
  root.dataset.key = key;
  root.replaceChildren();
  root.hidden = !obj;
  if (obj) root.append(eventEditor(obj));
  placeInspector();
  if (ui.focusLabel) {
    ui.focusLabel = false;
    const t = root.querySelector('[name=label]');
    if (t) requestAnimationFrame(() => { t.focus(); t.select(); });
  }
}

function syncFields(root, obj) {
  if (!obj) return;
  for (const el of root.querySelectorAll('[name]')) {
    if (el === document.activeElement) continue;
    const n = el.name;
    if (n === 'start' || n === 'end') { el.value = iso(obj[n]); el.disabled = !!obj.pinned; }
    else if (n in obj) el.value = obj[n] ?? '';
  }
  const pin = root.querySelector('.pin-toggle');
  if (pin) { pin.classList.toggle('on', !!obj.pinned); pin.setAttribute('aria-pressed', obj.pinned ? 'true' : 'false'); }
  const grid = root.querySelector('.cat-grid');
  if (grid && obj.cat !== undefined && grid.dataset.sig !== catSig()) grid.replaceWith(catGrid(obj));
  for (const b of root.querySelectorAll('.cat-btn')) b.classList.toggle('on', b.dataset.id === obj.cat);
}

function field(label, control) {
  return h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, label), control);
}

// 種別ボタンの一覧。種別が変わったら（凡例で追加したときなど）作り直せるよう、中身の目印を持たせる
function catSig() { return store.state.categories.map((c) => c.id + ':' + c.name + ':' + c.color).join('|'); }
function catGrid(e) {
  return h('div', { class: 'cat-grid', dataset: { sig: catSig() } }, store.state.categories.map((c) => h('button', {
    class: 'cat-btn' + (c.id === e.cat ? ' on' : ''), dataset: { id: c.id }, title: c.name,
    onclick: () => { ui.sel = e.id; store.updateEvent(e.id, { cat: c.id }, '種別を変更'); },
  }, chip(c), h('span', null, c.name))));
}

function eventEditor(e) {
  const st = store.state;
  const p = st.properties.get(e.pid);
  const upd = (patch, label) => { ui.sel = e.id; store.updateEvent(e.id, patch, label); };
  const cur = () => st.events.get(e.id) || e;
  const site = p ? p.name.replace(/\s*\n\s*/g, ' ') : '予定';
  return h('div', { class: 'ins' },
    h('div', { class: 'ins-head' }, h('h3', { title: site }, site),
      h('div', { class: 'ins-head-btns' },
        h('button', { class: 'icon-btn pin-toggle' + (e.pinned ? ' on' : ''), title: e.pinned ? 'ピンを外す' : 'ピンで固定', 'aria-label': 'ピンで固定', 'aria-pressed': e.pinned ? 'true' : 'false', onclick: () => togglePin(e.id) }, svgIcon('pin')),
        h('button', { class: 'icon-btn', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: closePanel }, svgIcon('x')))),
    h('div', { class: 'fld' }, h('span', { class: 'fld-l' }, '種別'), catGrid(e)),
    field('内容', h('input', {
      name: 'label', value: e.label || '', autocomplete: 'off',
      // 打っている途中から、ガントにも内容を出す（重ならない並べ方もその場で決め直す）
      oninput: (ev) => { ui.draft = { id: e.id, label: ev.target.value }; store.emit('draft'); },
      onchange: (ev) => { ui.draft = null; upd({ label: ev.target.value.trim() }, '内容を変更'); },
      onblur: () => { if (ui.draft) { ui.draft = null; store.emit('draft'); } },
      onkeydown: (ev) => { if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { const t = ev.target; setTimeout(() => t.blur(), 0); } },
    })),
    // ピンで固定した予定は、日付も変えられない
    h('div', { class: 'fld-row' },
      field('開始日', h('input', { type: 'date', name: 'start', min: '2000-01-01', max: '2099-12-31', value: iso(e.start), disabled: !!e.pinned, onchange: (ev) => {
        const s = dn(ev.target.value);
        if (!validDn(s)) { ev.target.value = iso(cur().start); toast('日付が正しくありません（2000〜2099年）', { type: 'err' }); return; }
        const c = cur();
        ui.reveal = e.id;
        upd({ start: s, end: s + (c.end - c.start) }, '日程を変更');
      } })),
      field('終了日', h('input', { type: 'date', name: 'end', min: '2000-01-01', max: '2099-12-31', value: iso(e.end), disabled: !!e.pinned, onchange: (ev) => {
        const x = dn(ev.target.value);
        if (!validDn(x)) { ev.target.value = iso(cur().end); toast('日付が正しくありません（2000〜2099年）', { type: 'err' }); return; }
        ui.reveal = e.id;
        upd({ end: Math.max(cur().start, x) }, '終了日を変更');
      } }))),
    h('div', { class: 'ins-actions' },
      h('button', { class: 'btn danger-outline', onclick: () => {
        ui.sel = null;
        store.deleteEvents([e.id]);
        toast('予定を削除しました', { action: { label: '元に戻す', fn: () => store.undo() } });
      } }, svgIcon('trash'), '削除')));
}
