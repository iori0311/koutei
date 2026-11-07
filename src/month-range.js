// 表示する期間（何月〜何月）を選ぶ月の帯。月が横に並び、選んでいる期間が青い帯になる（画面と印刷プレビューで共通）
//   ・青い帯の真ん中をつかんで左右に動かす … 期間をずらす
//   ・青い帯の両端の取っ手をつかむ … 期間を伸ばす・縮める（1〜12 か月）
//   ・帯の外の月を押す … その月から始まるようにずらす。押したまま横になぞる … なぞった月を選び直す
//   ・◀ ▶ … 1 か月ずつずらす
import { h, svgIcon } from './ui.js';
import { ymd, fromYMD } from './dates.js';

export const MAX_MONTHS = 12;
const monthNo = (d) => { const { y, m } = ymd(d); return y * 12 + m - 1; };   // 月の通し番号
const monthDn = (n) => fromYMD(Math.floor(n / 12), (n % 12) + 1, 1);          // 通し番号 → その月の 1 日
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// 帯ごとに、左端に見せている月を覚えておく（描き直しても帯が勝手に動かないように）
const windows = new Map();

// id: 帯の名前、from: 最初の月の 1 日、months: 月数、onChange(from, months)
// count: 帯に並べる月の数、cellW: 1 か月の幅（px）
export function monthRange({ id, from, months, onChange, count = 15, cellW = 40 }) {
  const s0 = monthNo(from);
  const len0 = clamp(months, 1, MAX_MONTHS);
  const e0 = s0 + len0 - 1;
  // 選んでいる期間の前後が少し見えるように、帯の左端を決める
  const margin = Math.min(2, Math.floor((count - len0) / 2));
  let win = windows.has(id) ? windows.get(id) : s0 - margin;
  if (s0 - win < margin) win = s0 - margin;
  if (win + count - 1 - e0 < margin) win = e0 + margin - (count - 1);
  windows.set(id, win);

  const track = h('div', { class: 'mr-track', style: 'width:' + count * cellW + 'px', role: 'group', 'aria-label': '表示する期間' });
  const hov = h('div', { class: 'mr-hov', style: 'width:' + cellW + 'px' });
  const sel = h('div', { class: 'mr-sel' }, h('i', { class: 'mr-hd l' }), h('i', { class: 'mr-hd r' }));
  track.append(hov, sel);
  const cells = [];
  for (let i = 0; i < count; i++) {
    const n = win + i, y = Math.floor(n / 12), m = (n % 12) + 1;
    const cell = h('div', { class: 'mr-cell' + (m === 1 && i > 0 ? ' jan' : ''), style: 'left:' + i * cellW + 'px;width:' + cellW + 'px' },
      i === 0 || m === 1 ? h('small', null, y + '年') : null,
      h('span', null, m + '月'));
    cells.push(cell);
    track.append(cell);
  }
  const paint = (s, len) => {
    sel.style.left = (s - win) * cellW + 'px';
    sel.style.width = len * cellW + 'px';
    cells.forEach((c, i) => c.classList.toggle('in', win + i >= s && win + i < s + len));
  };
  paint(s0, len0);

  const xOf = (clientX) => clientX - track.getBoundingClientRect().left;
  const idxAt = (clientX) => clamp(Math.floor(xOf(clientX) / cellW), 0, count - 1);
  // 押した場所：取っ手（start / end）・青い帯（move）・帯の外の月（pick）
  const zoneAt = (clientX) => {
    const x = xOf(clientX);
    const L = (s0 - win) * cellW, R = (e0 + 1 - win) * cellW;
    const hz = Math.min(8, cellW / 3);
    if (Math.abs(x - L) <= hz) return 'start';
    if (Math.abs(x - R) <= hz) return 'end';
    if (x > L && x < R) return 'move';
    return 'pick';
  };
  // 乗せたところに合わせてカーソルを変え、帯の外の月は薄く光らせる（押すとそこへ動く）
  track.addEventListener('pointermove', (ev) => {
    if (track.classList.contains('dragging')) return;
    const z = zoneAt(ev.clientX);
    track.dataset.zone = z;
    hov.style.display = z === 'pick' ? 'block' : 'none';
    hov.style.left = idxAt(ev.clientX) * cellW + 'px';
  });
  track.addEventListener('pointerleave', () => { hov.style.display = 'none'; });
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const mode = zoneAt(ev.clientX), i0 = idxAt(ev.clientX), x0 = ev.clientX;
    let s = s0, len = len0, moved = false;
    track.setPointerCapture(ev.pointerId);
    hov.style.display = 'none';
    const onMove = (m) => {
      const dx = m.clientX - x0;
      if (!moved) {
        if (Math.abs(dx) < 4) return;
        moved = true;
        track.classList.add('dragging');
        document.body.classList.add(mode === 'move' ? 'drag-move' : 'drag-resize');
      }
      const d = Math.round(dx / cellW);
      if (mode === 'move') { s = clamp(s0 + d, win, win + count - len0); len = len0; }
      else if (mode === 'start') { s = clamp(s0 + d, Math.max(win, e0 - MAX_MONTHS + 1), e0); len = e0 - s + 1; }
      else if (mode === 'end') { const e = clamp(e0 + d, s0, Math.min(win + count - 1, s0 + MAX_MONTHS - 1)); s = s0; len = e - s0 + 1; }
      else {
        // 押した月から、いま乗っている月までを選ぶ
        const a = win + i0, b = win + idxAt(m.clientX);
        s = Math.min(a, b);
        let e = Math.max(a, b);
        if (e - s + 1 > MAX_MONTHS) { if (b > a) e = s + MAX_MONTHS - 1; else s = e - MAX_MONTHS + 1; }
        len = e - s + 1;
      }
      paint(s, len);
    };
    const finish = (commit) => {
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onCancel);
      if (track.hasPointerCapture(ev.pointerId)) track.releasePointerCapture(ev.pointerId);
      track.classList.remove('dragging');
      document.body.classList.remove('drag-move', 'drag-resize');
      if (!commit) { paint(s0, len0); return; }
      // 帯の外の月を押しただけ：その月から始まるようにずらす（月数はそのまま）
      if (!moved && mode === 'pick') { s = win + i0; len = len0; }
      if (s !== s0 || len !== len0) onChange(monthDn(s), len);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onCancel);
  });

  const step = (k, label, icon) => h('button', { class: 'icon-btn mr-step', type: 'button', title: label, 'aria-label': label, onclick: () => onChange(monthDn(s0 + k), len0) }, svgIcon(icon));
  return h('div', { class: 'mr' }, step(-1, '1か月前へ', 'chevL'), track, step(1, '1か月後へ', 'chevR'));
}
