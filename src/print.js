// 印刷プレビューと印刷用レイアウト（実寸 mm で組み、行の高さを測ってページ分割する）
import { store, textOn, edgeOf, MEMO_COLOR } from './store.js';
import { h, svgIcon, fill } from './ui.js';
import { ymd, WD_JA } from './dates.js';
import { textW, makeDayInfo, monthSegments, layoutRow } from './layout.js';
import { monthRange } from './month-range.js';
import { overviewRange } from './gantt-web.js';

const PX_PER_MM = 96 / 25.4;
const PAPER = { A4: [297, 210], A3: [420, 297], B4: [364, 257] };
const PT = 8;   // 文字の大きさ（pt）
const mm = (v) => (Math.round(v * 1000) / 1000) + 'mm';

let overlay = null;
let pagesEl = null;
let measureEl = null;
let infoEl = null;
let topEl = null;
let openedByPrintEvent = false;

export function isPrintPreviewOpen() { return !!overlay; }

// 期間は画面と同じ（ここで変えると画面の期間も変わる）
export function openPrintPreview() {
  if (!overlay) buildOverlay();
  renderSettings();
  renderPages();
}

export function closePrintPreview() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.body.classList.remove('pp-open');
  const ps = document.getElementById('page-size-style');
  if (ps) ps.remove();
}

// ブラウザのメニューから直接印刷されたときも、印刷用ページで出力する
export function installPrintHandlers() {
  window.addEventListener('resize', fitZoom);
  window.addEventListener('beforeprint', () => {
    if (overlay) return;
    if (store.isEmpty()) return;
    openedByPrintEvent = true;
    openPrintPreview();
  });
  window.addEventListener('afterprint', () => {
    if (openedByPrintEvent) { openedByPrintEvent = false; closePrintPreview(); }
  });
}

function buildOverlay() {
  overlay = h('div', { class: 'pp-overlay', role: 'dialog', 'aria-label': '印刷プレビュー' });
  const side = h('div', { class: 'pp-side' });
  const view = h('div', { class: 'pp-view' });
  topEl = h('div', { class: 'pp-top' });
  pagesEl = h('div', { class: 'pp-pages' });
  measureEl = h('div', { class: 'pp-measure', 'aria-hidden': 'true' });
  view.append(topEl, pagesEl);
  overlay.append(side, view, measureEl);
  document.body.append(overlay);
  document.body.classList.add('pp-open');
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePrintPreview(); } });
}

function fitZoom() {
  if (!overlay || !pagesEl.firstElementChild) return;
  const view = pagesEl.parentElement;
  const pw = pagesEl.firstElementChild.offsetWidth;
  const z = Math.min(1, (view.clientWidth - 56) / pw);
  pagesEl.style.zoom = String(Math.max(0.2, z));
}

// ---------- 設定パネル ----------
function renderSettings() {
  const cfg = store.state.prefs.print;
  const side = overlay.querySelector('.pp-side');
  const set = (patch) => { store.setPrintPrefs(patch); renderSettings(); renderPages(); };
  const radio = (name, value, label, cur, onPick) => h('label', { class: 'pp-radio' + (cur === value ? ' on' : '') },
    h('input', { type: 'radio', name, value, checked: cur === value, onchange: () => onPick(value) }), label);

  // 期間：ページの上の月の帯（画面と同じもの。ここで変えると画面の期間も変わる）
  const [from, to] = overviewRange();
  const months = (ymd(to).y - ymd(from).y) * 12 + ymd(to).m - ymd(from).m + 1;
  const viewW = topEl.parentElement.clientWidth || 900;
  fill(topEl, h('span', { class: 'pp-top-l' }, '期間'),
    monthRange({ id: 'print', from, months, cellW: 36, count: Math.max(12, Math.min(18, Math.floor((viewW - 140) / 36))), onChange: (f, n) => {
      store.setPeriod(f, n);
      renderSettings();
      renderPages();
    } }));

  const paperBlock = h('fieldset', { class: 'pp-fs' }, h('legend', null, '用紙'),
    h('div', { class: 'pp-seg' }, ['A4', 'A3', 'B4'].map((v) => radio('ppaper', v, v, cfg.paper, (x) => set({ paper: x })))),
    h('div', { class: 'pp-seg' }, radio('porient', 'landscape', '横', cfg.orient, (v) => set({ orient: v })), radio('porient', 'portrait', '縦', cfg.orient, (v) => set({ orient: v }))));

  infoEl = h('p', { class: 'pp-info' });
  fill(side,
    h('div', { class: 'pp-side-head' }, h('h2', null, '印刷プレビュー'), h('button', { class: 'icon-btn', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: closePrintPreview }, svgIcon('x'))),
    // 印刷するのは、開いているビュー（出す現場・期間）そのまま
    h('div', { class: 'pp-viewname' }, h('span', { class: 'vtab on' }, store.activeView() ? store.activeView().name : 'すべての現場'), h('span', { class: 'pp-count' }, store.viewProperties().length + ' 現場')),
    paperBlock,
    h('div', { class: 'pp-actions' },
      infoEl,
      h('button', { class: 'btn primary block', onclick: () => window.print() }, svgIcon('print'), '印刷する'),
      h('p', { class: 'pp-tip' }, 'PDF にしたいときは、印刷画面の送信先で「PDF に保存」を選んでください。倍率は「デフォルト（100%）」のままにしてください。')));
}

// ---------- ページ生成 ----------
function paperDims(cfg) {
  const [a, b] = PAPER[cfg.paper] || PAPER.A3;
  return cfg.orient === 'portrait' ? [b, a] : [a, b];
}

function setPageStyle(w, hgt) {
  let st = document.getElementById('page-size-style');
  if (!st) { st = h('style', { id: 'page-size-style' }); document.head.append(st); }
  st.textContent = '@page { size: ' + w + 'mm ' + hgt + 'mm; margin: 0; }';
}

function renderPages() {
  const cfg = store.state.prefs.print;
  const [pw, ph] = paperDims(cfg);
  setPageStyle(pw, ph);
  pagesEl.replaceChildren();
  const pages = overviewPages(cfg, pw, ph);
  pagesEl.append(...pages);
  if (infoEl) infoEl.textContent = cfg.paper + (cfg.orient === 'portrait' ? ' 縦' : ' 横') + '・' + pages.length + 'ページ';
  requestAnimationFrame(fitZoom);
  fitZoom();
}

function scaleMode(dayW) {
  if (dayW >= 4.0) return 'day';
  if (dayW >= 2.75) return 'num';
  if (dayW >= 1.0) return 'week';
  return 'month';
}

function printScale(from, to, dayW, info) {
  const mode = scaleMode(dayW);
  const W = (to - from + 1) * dayW;
  const sc = h('div', { class: 'p-scale ' + mode, style: 'width:' + mm(W) });
  const mrow = h('div', { class: 'p-months' });
  for (const seg of monthSegments(from, to)) {
    const w = (seg.end - seg.start + 1) * dayW;
    const label = w > 22 ? seg.y + '年' + seg.m + '月' : w > 7 ? seg.m + '月' : '';
    mrow.append(h('div', { class: 'p-month', style: 'left:' + mm((seg.start - from) * dayW) + ';width:' + mm(w) }, label));
  }
  sc.append(mrow);
  if (mode === 'month') return sc;
  const drow = h('div', { class: 'p-days' });
  const wrow = mode === 'day' ? h('div', { class: 'p-wds' }) : null;
  for (let d = from; d <= to; d++) {
    const inf = info(d);
    const x = (d - from) * dayW;
    const { d: dd } = ymd(d);
    const cls = (inf.kind ? ' ' + inf.kind : '') + (inf.w === 0 || inf.kind === 'sun' ? ' red' : inf.w === 6 ? ' blue' : '');
    if (mode === 'week') {
      if (inf.w === 1) drow.append(h('div', { class: 'p-wk', style: 'left:' + mm(x) }, dd));
      continue;
    }
    drow.append(h('div', { class: 'p-day' + cls, style: 'left:' + mm(x) + ';width:' + mm(dayW) }, dd));
    if (wrow) wrow.append(h('div', { class: 'p-day' + cls, style: 'left:' + mm(x) + ';width:' + mm(dayW) }, WD_JA[inf.w]));
  }
  sc.append(drow);
  if (wrow) sc.append(wrow);
  return sc;
}

function printBg(from, to, dayW, info) {
  const mode = scaleMode(dayW);
  const bg = h('div', { class: 'p-bg' });
  for (let d = from; d <= to; d++) {
    const inf = info(d);
    const x = (d - from) * dayW;
    if (inf.kind && mode !== 'month') bg.append(h('div', { class: 'p-shade ' + inf.kind, style: 'left:' + mm(x) + ';width:' + mm(dayW) }));
    if (ymd(d).d === 1 && d > from) bg.append(h('div', { class: 'p-vl m', style: 'left:' + mm(x) }));
    else if (mode === 'day' || mode === 'num' ? d > from : inf.w === 1) bg.append(h('div', { class: 'p-vl', style: 'left:' + mm(x) }));
  }
  return bg;
}

// 棒の位置と幅（mm）。日の幅が狭いときも最低 1.5mm は確保して、その日を中心に置く
function barBox(s, e, from, dayW) {
  const x0 = (s - from) * dayW + 0.15;
  const w = (e - s + 1) * dayW - 0.3;
  if (w >= 1.5) return [x0, w];
  const c = (s - from + (e - s + 1) / 2) * dayW;
  return [c - 0.75, 1.5];
}

function barStyle(c) {
  const col = c.memo ? MEMO_COLOR : c.color;
  return 'background:#' + col + ';border-color:#' + edgeOf(col) + ';color:' + textOn(col);
}

// 凡例（今までの取付工程表と同じく、種別をすべて並べる）
function legendEl() {
  const cats = store.state.categories.filter((c) => !c.memo);
  if (!cats.length) return null;
  return h('div', { class: 'p-legend' }, cats.map((c) => h('span', null, h('i', { class: 'p-chip', style: 'background:#' + c.color + ';border-color:#' + edgeOf(c.color) }), c.name)));
}

function nowStamp() {
  const t = new Date();
  return t.getFullYear() + '/' + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
}

// 行を測ってページに振り分ける。factory(i, n) → { page, body }
function paginate(factory, rows) {
  // 試し組み（ページ番号「1 / 2」も入れて、実際のページと同じ高さにする）
  const probe = factory(0, 2);
  measureEl.replaceChildren(probe.page);
  const avail = probe.body.getBoundingClientRect().height - 1.5;
  const heights = rows.map((r) => { probe.body.append(r); return r.getBoundingClientRect().height; });
  measureEl.replaceChildren();
  const groups = [];
  let cur = [], used = 0;
  rows.forEach((r, i) => {
    if (cur.length && used + heights[i] > avail + 0.5) { groups.push(cur); cur = []; used = 0; }
    cur.push(r);
    used += heights[i];
  });
  if (cur.length || !groups.length) groups.push(cur);
  return groups.map((g, i) => {
    const pg = factory(i, groups.length);
    pg.body.append(...g);
    return pg.page;
  });
}

// ---------- 全体工程のページ ----------
function periodLabel(from, to) {
  const a = ymd(from), b = ymd(to);
  return a.y + '年' + a.m + '月〜' + (b.y !== a.y ? b.y + '年' : '') + b.m + '月';
}

function overviewPages(cfg, pw, ph) {
  const [from, to] = overviewRange();
  const props = store.viewProperties();
  const view = store.activeView();
  const info = makeDayInfo();
  const padX = 8, padY = 7;
  const innerW = pw - padX * 2;
  const nameW = Math.min(52, Math.max(34, innerW * 0.12));
  const whoW = Math.min(34, Math.max(24, innerW * 0.075));
  const leftW = nameW + whoW;
  const tlW = innerW - leftW - 0.8;
  const dayW = tlW / (to - from + 1);
  const lblPt = PT - 0.5;
  const lblPx = lblPt * 96 / 72;
  const lblMm = lblPt * 0.3528;
  const laneH = lblMm * 1.5;
  const barH = Math.min(laneH * 0.78, lblMm * 1.25);
  const padV = 0.7;

  const rows = props.map((p) => {
    // 棒と内容の文字が重ならないように段を決める（画面と同じ決め方）
    const items = store.eventsOf(p.id).filter((e) => e.end >= from && e.start <= to).map((e) => {
      const [bl, bw] = barBox(Math.max(e.start, from), Math.min(e.end, to), from, dayW);
      const label = (e.label || '').trim();
      return { e, c: store.category(e.cat), label, b0: bl, b1: bl + bw, lw: label ? textW(label, lblPx) / PX_PER_MM * 1.04 + 0.6 : 0 };
    });
    const lanes = layoutRow(items, tlW, 0.7, 1.8);
    const trackH = Math.max(1, lanes) * laneH + padV * 2;
    const track = h('div', { class: 'p-otr', style: 'width:' + mm(tlW) + ';min-height:' + mm(trackH) });
    for (const it of items) {
      const top = padV + it.lane * laneH;
      const bar = h('div', {
        class: 'p-bar' + (it.e.start < from ? ' cut-l' : '') + (it.e.end > to ? ' cut-r' : '') + (it.c.memo ? ' memo' : ''),
        style: 'left:' + mm(it.b0) + ';width:' + mm(it.b1 - it.b0) + ';top:' + mm(top + (laneH - barH) / 2) + ';height:' + mm(barH) + ';' + barStyle(it.c),
      }, it.pl.mode === 'inside' ? h('span', { class: 'p-in', style: 'font-size:' + lblPt + 'pt;line-height:' + mm(barH) }, it.label) : null);
      track.append(bar);
      if (it.pl.mode === 'right' || it.pl.mode === 'left' || it.pl.mode === 'clip') {
        // 棒の左に置く文字は、右端を棒にそろえる
        const pos = it.pl.mode === 'left' ? 'right:' + mm(tlW - it.pl.lx - it.pl.lw) : 'left:' + mm(it.pl.lx);
        track.append(h('div', {
          class: 'p-olbl' + (it.pl.mode === 'clip' ? ' clip' : ''),
          style: pos + ';top:' + mm(top) + ';height:' + mm(laneH) + ';line-height:' + mm(laneH) + ';font-size:' + lblPt + 'pt' + (it.pl.mode === 'clip' ? ';width:' + mm(it.pl.lw) : ''),
        }, it.label));
      }
    }
    return h('div', { class: 'p-orow' },
      h('div', { class: 'p-l', style: 'width:' + mm(leftW) },
        h('span', { class: 'p-oname', style: 'width:' + mm(nameW) }, p.name),
        h('span', { class: 'p-owho', style: 'width:' + mm(whoW) }, p.contractor || '')),
      track);
  });

  const periodText = periodLabel(from, to);
  const factory = (i, n) => {
    const page = h('section', { class: 'page ov', style: 'width:' + mm(pw) + ';height:' + mm(ph) + ';font-size:' + PT + 'pt;padding:' + mm(padY) + ' ' + mm(padX) });
    const head = h('header', { class: 'p-head' },
      h('div', { class: 'p-hl' }, h('div', { class: 'p-name' }, '取り付け工程表'),
        h('div', { class: 'p-meta' }, view ? h('span', null, h('em', null, 'ビュー'), view.name) : null, h('span', null, h('em', null, '期間'), periodText))),
      h('div', { class: 'p-hlegend' }, legendEl()),
      h('div', { class: 'p-hr' }, h('div', null, h('em', null, '作成'), nowStamp())));
    const thead = h('div', { class: 'p-thead' },
      h('div', { class: 'p-l', style: 'width:' + mm(leftW) },
        h('span', { class: 'p-oname', style: 'width:' + mm(nameW) }, '現場名'),
        h('span', { class: 'p-owho', style: 'width:' + mm(whoW) }, '施工業者')),
      printScale(from, to, dayW, info));
    const body = h('div', { class: 'p-tbody' });
    const bg = printBg(from, to, dayW, info);
    bg.style.left = mm(leftW);
    bg.style.width = mm(tlW);
    body.append(bg);
    const foot = h('footer', { class: 'p-foot' }, h('span'), h('span', { class: 'p-pg' }, n > 1 ? (i + 1) + ' / ' + n : ''));
    page.append(head, h('div', { class: 'p-table' }, thead, body), foot);
    if (!rows.length && i === 0) body.append(h('div', { class: 'p-empty' }, '現場がありません'));
    return { page, body };
  };
  return paginate(factory, rows);
}
