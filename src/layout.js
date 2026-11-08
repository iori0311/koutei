// 画面と印刷で共通のレイアウト計算（文字幅・網掛けする日・月の区切り・予定の段組み）
import { dow, jpHoliday, ymd, fromYMD, daysInMonth } from './dates.js';

export const FONT_STACK = '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", system-ui, sans-serif';

let measureCtx = null;
const widthCache = new Map();
export function textW(text, px, weight = 400) {
  if (!text) return 0;
  const key = px + '|' + weight + '|' + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = weight + ' ' + px + 'px ' + FONT_STACK;
    w = measureCtx.measureText(text).width;
    if (widthCache.size > 30000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

// 網掛けする日: 'off'（休み。土日・祝日・社内休暇。どれもうすいオレンジ）/ ''（出社する日）
// days: { offDays: 社内休暇 [{ name, start, end }]、workDays: 出社日 [日付] }（ストアの state をそのまま渡せる）。
// 出社日は、土日・祝日・社内休暇でも休みにしない。name はカーソルを乗せたときに出す説明
export function makeDayInfo(days = {}) {
  const off = new Map();
  for (const o of days.offDays || []) {
    for (let d = o.start; d <= Math.min(o.end, o.start + 400); d++) if (!off.has(d)) off.set(d, o.name || '');
  }
  const work = new Set(days.workDays || []);
  const cache = new Map();
  return (d) => {
    let v = cache.get(d);
    if (!v) {
      const w = dow(d);
      const jp = jpHoliday(d);
      const co = off.get(d);
      const isWork = work.has(d);
      const rest = !isWork && (w === 0 || w === 6 || !!jp || co !== undefined);
      const name = [jp, co === undefined ? '' : '社内休暇' + (co ? '（' + co + '）' : ''), isWork ? '出社日' : ''].filter(Boolean).join('・');
      v = { w, kind: rest ? 'off' : '', name };
      cache.set(d, v);
    }
    return v;
  };
}

export function monthSegments(from, to) {
  const out = [];
  let { y, m } = ymd(from);
  let s = from;
  while (s <= to) {
    const e = Math.min(to, fromYMD(y, m, daysInMonth(y, m)));
    out.push({ start: s, end: e, y, m });
    s = e + 1;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ---- 予定の段組み：1 つの行の中で、棒と内容の文字がどれも重ならないように段に分ける（画面と印刷で共通） ----
// items: [{ b0, b1, lw }] … 棒の左端・右端と、内容の文字の幅（内容がなければ 0）
// W: カレンダーの幅、pad: 棒と自分の文字のすき間、gap: 文字とほかの予定のあいだ（どの棒の文字か見分けられるように pad より広く）
// 各 item に lane（上から何段目か）と pl（文字の置き場所）を入れて、段の数を返す
//   pl.mode: 'none'（内容なし）/ 'inside'（棒の中）/ 'right'（棒の右）/ 'left'（棒の左）/ 'clip'（左右どちらにも入りきらず右で切る）
// 決め方
//   ・文字が棒に入るなら棒の中、入らなければ棒の右
//   ・ただし右に置くと後ろの予定の棒にかかり、左なら同じ段に置けるときは左に置く（段を増やさない）
//   ・棒どうしは、隣の日なら同じ段に並べてよい（今までの工程表で色のセルが横に並んでいたのと同じ）
export function layoutRow(items, W, pad, gap) {
  const cands = (it) => {
    const { b0, b1, lw } = it;
    if (!lw) return [{ mode: 'none', x0: b0, x1: b1 }];
    if (b1 - b0 >= lw + pad * 2) return [{ mode: 'inside', lx: b0 + pad, lw, x0: b0, x1: b1 }];
    const out = [];
    if (b1 + pad + lw <= W) out.push({ mode: 'right', lx: b1 + pad, lw, x0: b0, x1: b1 + pad + lw });
    if (b0 - pad - lw >= 0) out.push({ mode: 'left', lx: b0 - pad - lw, lw, x0: b0 - pad - lw, x1: b1 });
    if (!out.length) out.push({ mode: 'clip', lx: b1 + pad, lw: Math.max(0, W - b1 - pad), x0: b0, x1: W });
    return out;
  };
  const labR = (c) => c.mode === 'right' || c.mode === 'clip';   // 右端が文字
  const labL = (c) => c.mode === 'left';                          // 左端が文字
  // その段に置けるか。文字が接する側だけ gap を空ける
  const fits = (lane, c) => lane.every((p) =>
    c.x1 + (labR(c) || labL(p) ? gap : 0) <= p.x0 || p.x1 + (labR(p) || labL(c) ? gap : 0) <= c.x0);
  const order = [...items].sort((a, b) => a.b0 - b.b0 || b.b1 - a.b1);
  const lanes = [];
  order.forEach((it, k) => {
    const cs = cands(it);
    const right = cs.find((c) => c.mode === 'right');
    const left = cs.find((c) => c.mode === 'left');
    // 右に置くと、後ろの予定の棒にかかるか
    const blocks = !!right && order.slice(k + 1).some((o) => o.b0 < right.x1 + gap && o.b1 > it.b1);
    let li = 0, pick = null;
    for (; li < lanes.length; li++) {
      if (right && left) {
        const r = fits(lanes[li], right), l = fits(lanes[li], left);
        pick = r && !(blocks && l) ? right : l ? left : null;
      } else {
        pick = cs.find((c) => fits(lanes[li], c)) || null;
      }
      if (pick) break;
    }
    if (!pick) {
      pick = blocks && left ? left : cs[0];
      lanes.push([]);
      li = lanes.length - 1;
    }
    lanes[li].push(pick);
    it.lane = li;
    it.pl = pick;
  });
  return lanes.length;
}
