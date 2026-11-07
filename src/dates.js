// 日付ユーティリティ。日付は内部的に「1970-01-01 からの日数」(day number) で扱う。

export const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_MS = 86400000;

export function fromYMD(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d); // Date.UTC は 0〜99 年を 1900 年代にしてしまうので使わない
  return Math.round(t.getTime() / DAY_MS);
}
export function dn(iso) {
  if (typeof iso === 'number') return iso;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(iso || '');
  return m ? fromYMD(+m[1], +m[2], +m[3]) : NaN;
}
export function ymd(n) { const d = new Date(n * DAY_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
export function iso(n) { const { y, m, d } = ymd(n); return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
// 画面で入力された日付として妥当か（2000〜2099 年）
export function validDn(n) { if (!Number.isFinite(n)) return false; const y = ymd(n).y; return y >= 2000 && y <= 2099; }
export function dow(n) { return ((n % 7) + 7 + 4) % 7; } // 1970-01-01 は木曜
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function todayDn() { const t = new Date(); return fromYMD(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
export function monthStart(n) { const { y, m } = ymd(n); return fromYMD(y, m, 1); }
export function addMonths(n, k) { const { y, m } = ymd(n); const t = (y * 12 + m - 1) + k; return fromYMD(Math.floor(t / 12), (t % 12) + 1, 1); }
export function monthEnd(n) { return addMonths(n, 1) - 1; }

export function fmtMD(n) { const { m, d } = ymd(n); return m + '/' + d; }
export function fmtMDW(n) { return fmtMD(n) + '(' + WD_JA[dow(n)] + ')'; }
export function fmtYMD(n) { const { y, m, d } = ymd(n); return y + '/' + m + '/' + d; }

// ---- 日本の祝日（2000〜2099 年） ----
const holidayCache = new Map();
function nthMonday(y, m, nth) {
  const first = fromYMD(y, m, 1);
  const off = (8 - dow(first)) % 7; // 最初の月曜まで
  return first + off + (nth - 1) * 7;
}
function buildYear(y) {
  const h = new Map();
  const add = (m, d, name) => h.set(fromYMD(y, m, d), name);
  add(1, 1, '元日');
  h.set(nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  const shunbun = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  add(3, shunbun, '春分の日');
  add(4, 29, y >= 2007 ? '昭和の日' : 'みどりの日');
  add(5, 3, '憲法記念日');
  if (y >= 2007) add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  if (y === 2020) { add(7, 23, '海の日'); add(7, 24, 'スポーツの日'); add(8, 10, '山の日'); }
  else if (y === 2021) { add(7, 22, '海の日'); add(7, 23, 'スポーツの日'); add(8, 8, '山の日'); }
  else {
    h.set(nthMonday(y, 7, 3), '海の日');
    if (y >= 2016) add(8, 11, '山の日');
    h.set(nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  }
  h.set(nthMonday(y, 9, 3), '敬老の日');
  const shubun = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  add(9, shubun, '秋分の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y <= 2018) add(12, 23, '天皇誕生日');
  if (y === 2019) { add(5, 1, '即位の日'); add(10, 22, '即位礼正殿の儀'); }
  // 国民の休日（祝日に挟まれた平日）
  const keys = [...h.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    if (h.has(k + 2) && !h.has(k + 1) && dow(k + 1) !== 0) h.set(k + 1, '国民の休日');
  }
  // 振替休日
  for (const k of [...h.keys()].sort((a, b) => a - b)) {
    if (dow(k) === 0) {
      let n = k + 1;
      while (h.has(n)) n++;
      h.set(n, '振替休日');
    }
  }
  return h;
}
export function jpHoliday(n) {
  const { y } = ymd(n);
  if (y < 2000 || y > 2099) return null;
  let map = holidayCache.get(y);
  if (!map) { map = buildYear(y); holidayCache.set(y, map); }
  return map.get(n) || null;
}
