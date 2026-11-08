// データ（現場・予定・種別・施工業者の候補・ビュー）と表示設定の保持、元に戻す/やり直し、自動保存
import { dn, iso, validDn } from './dates.js';

// 配るファイルの種類（サンプル入りなど）。サンプル版はビルド時に window.__KG_EDITION__ が埋め込まれ、
// 本番のデータと混ざらないように別の保存場所（key）を使う
const EDITION = (typeof window !== 'undefined' && window.__KG_EDITION__) || {};
export function edition() { return EDITION; }
export const STORAGE_KEY = EDITION.key || 'koutei-gantt/v1';

// 同じミリ秒に大量に作っても重ならないよう、連番を混ぜる
let uidSeq = 0;
export function uid(prefix) {
  uidSeq = (uidSeq + 1) % 1679616;
  return (prefix || '') + Date.now().toString(36) + uidSeq.toString(36).padStart(4, '0') + Math.random().toString(36).slice(2, 5);
}

// ---- 色 ----
export function hexToRgb(h) { return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
export function rgbToHex(r, g, b) { return [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase(); }
export function luminance(h) {
  const [r, g, b] = hexToRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function textOn(h) { return luminance(h) > 0.2 ? '#1a1a1a' : '#ffffff'; }
export function mix(h, other, k) {
  const a = hexToRgb(h), b = hexToRgb(other);
  return rgbToHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}
export function edgeOf(h) { return luminance(h) > 0.6 ? mix(h, '000000', 0.35) : mix(h, '000000', 0.2); }

export const MEMO_COLOR = 'C9CED6';
export function defaultCategories() {
  return [
    { id: 'c-koji', name: '工事日決定', color: 'FF0000' },
    { id: 'c-sash', name: 'サッシ搬入', color: 'FFFF00' },
    { id: 'c-door', name: '玄関ドア搬入', color: '00B050' },
    { id: 'c-kensa', name: '検査・引渡し・社内検査', color: '7030A0' },
    { id: 'c-hoshu', name: '補修工事', color: '92D050' },
    { id: 'c-jishu', name: '自主検査', color: 'FFC000' },
    { id: 'c-saibo', name: '災防協', color: '002060' },
    { id: 'c-tenaoshi', name: '手直し', color: 'C00000' },
    { id: 'c-ouen', name: '応援', color: '00B0F0' },
    { id: 'c-memo', name: '色なし', color: MEMO_COLOR, memo: true },
  ];
}

// view: 開いているビュー（null なら「すべての現場」）
// periods: ビューごとの期間 { ビューの id（すべての現場は 'all'）: { from: 最初の月の 1 日（null なら今月）, months: 月数 } }。印刷も同じ期間
// print: 印刷の用紙
export function defaultPrefs() {
  return { view: null, periods: {}, print: { paper: 'A3', orient: 'landscape' } };
}
export const MAX_PERIOD_MONTHS = 12;
function clampMonths(n) { return Math.max(1, Math.min(MAX_PERIOD_MONTHS, Math.round(Number(n) || 2))); }

// contractors: 施工業者の候補。現場に入れた施工業者が自動でたまる（最近使ったものほど前）
// views: 自分で作ったビュー [{ id, name, pids, whos }]（「すべての現場」は入れない）
//   Excel のフィルターを「現場」「施工業者」の 2 つの列にかけるのと同じで、両方にチェックが入っている現場を出す。
//   pids … チェックした現場の id／whos … チェックした施工業者（'' は施工業者なし）。
//   null は「すべて」（あとで足した現場・施工業者も出る）、[] は何もチェックしていない（何も出ない）
// offDays: 社内休暇 [{ id, name, start, end }]（お盆・年末年始など。土日・祝日と同じく休み）
// workDays: 出社日 [日付]（土曜出社など。土日・祝日・社内休暇でも休みにしない）
export function emptyState() {
  return { categories: defaultCategories(), properties: new Map(), events: new Map(), contractors: [], views: [], offDays: [], workDays: [], prefs: defaultPrefs() };
}

// 名前を比べるためのキー。全角・半角、ひらがな・カタカナ、大文字・小文字の違いを無視する。
// keepSpace が true なら空白は 1 つにまとめて残し（同じ名前かどうか）、false なら空白も無視する（探すとき）
export function nameKey(s, keepSpace) {
  const t = String(s || '').normalize('NFKC').toLowerCase().replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  return keepSpace ? t.replace(/\s+/g, ' ').trim() : t.replace(/\s+/g, '');
}

// 施工業者の欄は 1 行に 1 社（元の工程表と同じく、欄の中で改行して並べる）
export function whoNames(s) {
  return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
}
// 現場の施工業者を、ビューで比べるための形にする（施工業者が入っていなければ「施工業者なし」の ''）
export function whoKeys(p) {
  const names = whoNames(p.contractor);
  return names.length ? names.map((x) => nameKey(x, true)) : [''];
}
// その現場をビューに出すか：現場と施工業者の両方でチェックが入っている（null は「すべて」）
export function viewMatch(v, p) {
  if (v.pids && !v.pids.includes(p.id)) return false;
  if (v.whos) {
    const want = new Set(v.whos.map((x) => nameKey(x, true)));
    if (!whoKeys(p).some((k) => want.has(k))) return false;
  }
  return true;
}

// ---- 保存形式 ----
export function serialize(st) {
  return {
    app: 'koutei-gantt', v: 1, savedAt: new Date().toISOString(),
    categories: st.categories,
    properties: [...st.properties.values()],
    events: [...st.events.values()].map((e) => ({ ...e, start: iso(e.start), end: iso(e.end) })),
    contractors: st.contractors,
    views: st.views,
    offDays: st.offDays.map((o) => ({ ...o, start: iso(o.start), end: iso(o.end) })),
    workDays: st.workDays.map(iso),
    prefs: st.prefs,
  };
}
export function deserialize(obj) {
  if (!obj || obj.app !== 'koutei-gantt') throw new Error('この取り付け工程表の保存データではありません');
  const st = emptyState();
  if (Array.isArray(obj.categories) && obj.categories.length) st.categories = obj.categories.map((c) => ({ ...c }));
  if (!st.categories.some((c) => c.memo)) st.categories.push({ id: 'c-memo', name: '色なし', color: MEMO_COLOR, memo: true });
  for (const p of obj.properties || []) {
    const q = { contractor: '', order: 0, ...p };
    // 前の版の「元請」「取付業者」は、元の工程表と同じ 1 つの「施工業者」にまとめる（1 行に 1 社）
    if ('installer' in q) { q.contractor = [q.contractor, q.installer].map((s) => (s || '').trim()).filter(Boolean).join('\n'); delete q.installer; }
    st.properties.set(q.id, q);
  }
  for (const e of obj.events || []) {
    const s = dn(e.start), en = dn(e.end);
    if (!Number.isFinite(s)) continue;
    st.events.set(e.id, { label: '', ...e, start: s, end: Number.isFinite(en) && en >= s ? en : s });
  }
  // 施工業者の候補。前の版のデータには無いので、今ある現場から作る（新しい現場ほど前）
  const names = Array.isArray(obj.contractors) ? obj.contractors
    : [...st.properties.values()].sort((a, b) => (b.order || 0) - (a.order || 0)).map((p) => p.contractor);
  const seen = new Set();
  for (const n of names) {
    const v = String(n || '').trim(), k = nameKey(v, true);
    if (v && !seen.has(k)) { seen.add(k); st.contractors.push(v); }
  }
  if (Array.isArray(obj.views)) {
    const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : null);
    st.views = obj.views.filter((v) => v && v.id).map((v) => {
      let pids = strs(v.pids), whos = strs(v.whos);
      // 前の版は「現場で選ぶ」「施工業者で選ぶ」のどちらか一方だけで選んでいた
      if (v.by === 'who') pids = null;
      else if (v.by === 'site') whos = null;
      return { id: String(v.id), name: String(v.name || 'ビュー'), pids, whos };
    });
  }
  // 社内休暇・出社日。前の版のデータには無いので、無いファイルには印を付けておき、
  // ほかで書き換えられたファイルを取り込むときに「全部消された」と取り違えないようにする
  st.offDays = (Array.isArray(obj.offDays) ? obj.offDays : []).map((o) => {
    const s = dn(o && o.start), e = dn(o && o.end);
    if (!validDn(s)) return null;
    return { id: String(o.id || uid('h')), name: String(o.name || '').trim().slice(0, 40), start: s, end: validDn(e) && e >= s ? e : s };
  }).filter(Boolean).sort((a, b) => a.start - b.start || a.end - b.end);
  st.workDays = [...new Set((Array.isArray(obj.workDays) ? obj.workDays : []).map((x) => dn(x)).filter(validDn))].sort((a, b) => a - b);
  if (!('offDays' in obj) && !('workDays' in obj)) Object.defineProperty(st, 'noDaysOff', { value: true });
  const op = obj.prefs || {}, pp = op.print || {};
  if (op.view && st.views.some((v) => v.id === op.view)) st.prefs.view = op.view;
  if (op.periods && typeof op.periods === 'object') {
    for (const [k, p] of Object.entries(op.periods)) {
      if (p && typeof p === 'object') st.prefs.periods[k] = { from: Number.isFinite(p.from) ? p.from : null, months: clampMonths(p.months) };
    }
  }
  // 前の版は「すべての現場」の期間を ovFrom / ovMonths に覚えていた
  if (!st.prefs.periods.all && (Number.isFinite(op.ovFrom) || Number.isFinite(op.ovMonths))) {
    st.prefs.periods.all = { from: Number.isFinite(op.ovFrom) ? op.ovFrom : null, months: clampMonths(op.ovMonths) };
  }
  // 前の版は全体工程の用紙を ovPaper / ovOrient に覚えていた
  const paper = pp.ovPaper || pp.paper, orient = pp.ovOrient || pp.orient;
  if (paper) st.prefs.print.paper = paper;
  if (orient) st.prefs.print.orient = orient;
  return st;
}

// ---- ほか（エージェントなど）が書き換えた保存データを取り込む ----
// 項目の並び順の違いを無視して比べるための文字列
function canon(x) {
  return JSON.stringify(x === undefined ? null : x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, kk) => { o[kk] = v[kk]; return o; }, {}) : v));
}
// 2 つの保存データ（JSON の文字）の中身が同じか（保存した時刻と、項目の並び順の違いは無視する）
export function sameSavedData(a, b) {
  try {
    const x = JSON.parse(a), y = JSON.parse(b);
    delete x.savedAt;
    delete y.savedAt;
    return canon(x) === canon(y);
  } catch (e) { return false; }
}
// base：前に読み書きしたときのファイルの中身、theirs：今のファイルの中身、ours：画面の今の状態（どれも deserialize したもの）。
// ファイルの側だけが変えたものを、元に戻せる変更（store.commit に渡す形）にして返す。
// 同じものを画面の側でも違うように変えていたら、画面の側を残して conflicts に数える。表示の設定（prefs）は取り込まない
export function mergeFromFile(base, theirs, ours) {
  const changes = [];
  let conflicts = 0;
  const eq = (a, b) => canon(a) === canon(b);
  for (const [kind, key] of [['property', 'properties'], ['event', 'events']]) {
    for (const id of new Set([...base[key].keys(), ...theirs[key].keys()])) {
      const b = base[key].get(id) || null, t = theirs[key].get(id) || null, o = ours[key].get(id) || null;
      if (eq(b, t)) continue;
      if (!eq(b, o)) { if (!eq(o, t)) conflicts++; continue; }
      changes.push({ kind, id, before: o, after: t });
    }
  }
  for (const kind of ['categories', 'contractors', 'views', 'offDays', 'workDays']) {
    // 社内休暇・出社日を知らない前の版が書いたファイルなら、そこは変わっていないことにする
    if ((kind === 'offDays' || kind === 'workDays') && theirs.noDaysOff) continue;
    if (eq(base[kind], theirs[kind])) continue;
    if (!eq(base[kind], ours[kind])) { if (!eq(ours[kind], theirs[kind])) conflicts++; continue; }
    changes.push({ kind, id: kind, before: ours[kind], after: theirs[kind] });
  }
  // ファイルの側で消された現場に、画面の側で足した予定が残らないようにする
  const gone = new Set(changes.filter((c) => c.kind === 'property' && !c.after).map((c) => c.id));
  for (const e of ours.events.values()) {
    if (gone.has(e.pid) && !changes.some((c) => c.kind === 'event' && c.id === e.id)) changes.push({ kind: 'event', id: e.id, before: e, after: null });
  }
  return { changes, conflicts };
}

// ---- ストア ----
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

export const store = {
  state: emptyState(),
  history: [],
  future: [],
  listeners: new Set(),
  saveTimer: 0,
  saveError: null,
  lastSavedAt: null,
  _idx: null,

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(reason) { this._idx = null; for (const fn of this.listeners) fn(reason); },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { this.state = deserialize(JSON.parse(raw)); return true; }
    } catch (e) { console.warn('保存データを読めませんでした', e); }
    return false;
  },
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.savePending = true;
    this.saveTimer = setTimeout(() => this.saveNow(), 350);
  },
  flush() { if (this.savePending) this.saveNow(); },
  saveNow() {
    clearTimeout(this.saveTimer);
    this.savePending = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(this.state)));
      this.saveError = null;
      this.lastSavedAt = new Date();
    } catch (e) {
      this.saveError = e;
    }
    for (const fn of this.listeners) fn('saved');
  },

  // changes: [{ kind: 'event'|'property'|'categories'|'contractors'|'views'|'offDays'|'workDays', id, before, after }]
  commit(label, changes) {
    // 同じものへの変更が複数あれば、最初の「前」と最後の「後」にまとめる
    const merged = new Map();
    for (const c of changes) {
      const k = c.kind + '|' + c.id;
      const m = merged.get(k);
      if (m) m.after = c.after; else merged.set(k, { ...c });
    }
    changes = [...merged.values()].filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
    if (!changes.length) return;
    this.apply(changes, 'after');
    this.history.push({ label, changes });
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.scheduleSave();
    this.emit('change');
  },
  apply(changes, side) {
    const st = this.state;
    for (const c of changes) {
      const v = clone(c[side]);
      if (c.kind === 'event') { if (v) st.events.set(c.id, v); else st.events.delete(c.id); }
      else if (c.kind === 'property') { if (v) st.properties.set(c.id, v); else st.properties.delete(c.id); }
      else if (c.kind === 'categories') st.categories = v;
      else if (c.kind === 'contractors') st.contractors = v;
      else if (c.kind === 'views') st.views = v;
      else if (c.kind === 'offDays') st.offDays = v;
      else if (c.kind === 'workDays') st.workDays = v;
    }
  },
  undo() {
    const h = this.history.pop();
    if (!h) return null;
    this.apply([...h.changes].reverse(), 'before');
    this.future.push(h);
    this.scheduleSave();
    this.emit('change');
    return h.label;
  },
  redo() {
    const h = this.future.pop();
    if (!h) return null;
    this.apply(h.changes, 'after');
    this.history.push(h);
    this.scheduleSave();
    this.emit('change');
    return h.label;
  },
  replace(st) {
    this.state = st;
    this.history = [];
    this.future = [];
    this.saveNow();
    this.emit('replace');
  },
  setPrefs(patch) {
    Object.assign(this.state.prefs, patch);
    this.scheduleSave();
    this.emit('prefs');
  },
  // ---- ビュー ----
  // 開いているビュー（「すべての現場」なら null）
  activeView() {
    const id = this.state.prefs.view;
    return (id && this.state.views.find((v) => v.id === id)) || null;
  },
  // 開いているビューに出す現場（並びは全体と同じ）
  viewProperties() {
    const v = this.activeView();
    const all = this.sortedProperties();
    return v ? all.filter((p) => viewMatch(v, p)) : all;
  },
  // 開いているビューの期間 { from（null なら今月）, months }
  period() {
    const v = this.activeView();
    const p = this.state.prefs.periods[v ? v.id : 'all'] || {};
    return { from: Number.isFinite(p.from) ? p.from : null, months: clampMonths(p.months) };
  },
  setPeriod(from, months) {
    const v = this.activeView();
    this.state.prefs.periods[v ? v.id : 'all'] = { from, months: clampMonths(months) };
    this.scheduleSave();
    this.emit('prefs');
  },
  // ビューを開く。period を渡すと、まだ期間を覚えていないビューはその期間から始める
  setView(id, period) {
    this.state.prefs.view = id || null;
    if (id && period && !this.state.prefs.periods[id]) this.state.prefs.periods[id] = { from: period.from, months: clampMonths(period.months) };
    this.scheduleSave();
    this.emit('prefs');
  },

  setPrintPrefs(patch) {
    Object.assign(this.state.prefs.print, patch);
    this.scheduleSave();
  },

  // ---- 参照 ----
  index() {
    if (this._idx) return this._idx;
    const byPid = new Map();
    for (const e of this.state.events.values()) {
      let a = byPid.get(e.pid);
      if (!a) { a = []; byPid.set(e.pid, a); }
      a.push(e);
    }
    for (const a of byPid.values()) a.sort((x, y) => x.start - y.start || x.end - y.end || (x.lane || 0) - (y.lane || 0));
    const cats = new Map(this.state.categories.map((c) => [c.id, c]));
    this._idx = { byPid, cats };
    return this._idx;
  },
  eventsOf(pid) { return this.index().byPid.get(pid) || []; },
  category(id) {
    const cats = this.index().cats;
    return cats.get(id) || this.state.categories.find((c) => c.memo) || this.state.categories[0];
  },
  sortedProperties() {
    return [...this.state.properties.values()].sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'ja'));
  },
  isEmpty() { return this.state.properties.size === 0; },

  // ---- 操作 ----
  addEvent(ev, label = '予定を追加') {
    const e = { label: '', ...ev, id: uid('e') };
    this.commit(label, [{ kind: 'event', id: e.id, before: null, after: e }]);
    return e;
  },
  updateEvent(id, patch, label = '予定を変更') {
    const cur = this.state.events.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    if (next.end < next.start) next.end = next.start;
    this.commit(label, [{ kind: 'event', id, before: cur, after: next }]);
  },
  deleteEvents(ids, label = '予定を削除') {
    this.commit(label, ids.filter((id) => this.state.events.has(id)).map((id) => ({ kind: 'event', id, before: this.state.events.get(id), after: null })));
  },
  updateProperty(id, patch, label = '現場情報を変更', extra = []) {
    const cur = this.state.properties.get(id);
    if (!cur) return;
    this.commit(label, [{ kind: 'property', id, before: cur, after: { ...cur, ...patch } }, ...extra]);
  },
  // 現場の並び順を変える（行のドラッグ）。before の現場のすぐ前へ。before が無ければ after の現場のすぐ後ろへ（どちらも無ければ最後）。
  // ビューで絞り込んでいるときも、見えている前後の現場を渡せば、全体の並びの中でその間に入る。
  // ふつうは動かした現場の order だけを前後の間の値にする（ほかの現場は変えない）。間が詰まっているときだけ全部振り直す
  moveProperty(id, { before = null, after = null } = {}) {
    const cur = this.state.properties.get(id);
    if (!cur) return false;
    const all = this.sortedProperties();
    const rest = all.filter((p) => p.id !== id);
    let i = before ? rest.findIndex((p) => p.id === before) : -1;
    if (i < 0) {
      const j = after ? rest.findIndex((p) => p.id === after) : -1;
      i = j >= 0 ? j + 1 : rest.length;
    }
    if (all.findIndex((p) => p.id === id) === i) return false;   // 今と同じ場所
    const o = (p) => p.order || 0;
    const prev = rest[i - 1], next = rest[i];
    const ord = !prev && !next ? 1 : !prev ? o(next) - 1 : !next ? o(prev) + 1 : (o(prev) + o(next)) / 2;
    const fits = Number.isFinite(ord) && (!prev || o(prev) < ord) && (!next || ord < o(next)) && (!prev || !next || o(next) - o(prev) > 1e-6);
    const changes = fits
      ? [{ kind: 'property', id, before: cur, after: { ...cur, order: ord } }]
      : [...rest.slice(0, i), cur, ...rest.slice(i)].map((p, k) => ({ kind: 'property', id: p.id, before: p, after: { ...p, order: k + 1 } }));
    this.commit('現場の並び順を変更', changes);
    return true;
  },
  // 施工業者を候補の先頭に入れる変更（まだ無ければ足す）。空なら null
  contractorChange(name) {
    const v = (name || '').trim();
    if (!v) return null;
    const k = nameKey(v, true);
    const cur = this.state.contractors;
    return { kind: 'contractors', id: 'contractors', before: cur, after: [v, ...cur.filter((x) => nameKey(x, true) !== k)] };
  },
  deleteProperty(id) {
    const cur = this.state.properties.get(id);
    if (!cur) return;
    const changes = this.eventsOf(id).map((e) => ({ kind: 'event', id: e.id, before: e, after: null }));
    changes.push({ kind: 'property', id, before: cur, after: null });
    this.commit('現場を削除', changes);
  },
};
