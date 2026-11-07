// エージェント（MCP サーバー）から使う操作。保存データ（JSON）を読み込んだ状態に、決まった操作だけを行う（画面には依存しない）
//   ・入力を確かめる：日付の形、現場・種別・予定が本当にあるか、文字の長さ。決まっていない項目は受け取らない
//   ・ピンで固定した予定は、日付を変えたり消したりしない（ピンは画面で付け外しする）
//   ・データの形（項目）は変えない。種別（凡例）とビューは読むだけ
import { uid, nameKey, whoNames } from './store.js';
import { dn, iso, validDn } from './dates.js';

// 入力がおかしいときのエラー（エージェントにそのまま伝える）
export class AgentError extends Error {}
function fail(msg) { throw new AgentError(msg); }

const MAX_NAME = 200, MAX_LABEL = 200, MAX_WHO = 100, MAX_WHO_LINES = 20, MAX_EVENTS_OUT = 500;

function sitesSorted(st) {
  return [...st.properties.values()].sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'ja'));
}
function eventsOfSite(st, pid) { return [...st.events.values()].filter((e) => e.pid === pid); }
function memoCategory(st) { return st.categories.find((c) => c.memo) || st.categories[0]; }

// ---- 入力 ----
// 文字。multiline なら 1 行ずつ前後の空白を取って空の行は捨てる。そうでなければ改行は空白にする
function textArg(v, label, max, { required = false, multiline = false } = {}) {
  if (v === undefined || v === null) { if (required) fail(label + 'を入れてください'); return null; }
  if (typeof v !== 'string') fail(label + 'は文字で指定してください');
  const s = multiline
    ? v.replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join('\n')
    : v.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (required && !s) fail(label + 'を入れてください');
  if (s.length > max) fail(label + 'が長すぎます（' + max + ' 文字まで）');
  return s;
}
// 施工業者：1 行に 1 社（改行で区切った文字でも、配列でもよい）
function whoArg(v) {
  if (v === undefined || v === null) return null;
  let lines;
  if (Array.isArray(v)) lines = v;
  else if (typeof v === 'string') lines = v.split(/\r\n?|\n/);
  else fail('施工業者は文字か、文字の配列で指定してください');
  const out = [];
  for (const x of lines) {
    if (typeof x !== 'string') fail('施工業者は文字で指定してください');
    const t = x.trim();
    if (!t) continue;
    if (t.length > MAX_WHO) fail('施工業者「' + t.slice(0, 20) + '…」が長すぎます（1 社 ' + MAX_WHO + ' 文字まで）');
    out.push(t);
  }
  if (out.length > MAX_WHO_LINES) fail('施工業者が多すぎます（' + MAX_WHO_LINES + ' 社まで）');
  return out.join('\n');
}
function dateArg(v, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(label + 'は YYYY-MM-DD の形で指定してください（例: 2026-11-07）');
  const n = dn(s);
  if (!validDn(n) || iso(n) !== s) fail(label + '「' + s + '」は正しい日付ではありません（2000〜2099 年の日付）');
  return n;
}
function findSite(st, ref) {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) fail('現場を指定してください（list_sites で出る id か、現場名）');
  if (st.properties.has(r)) return st.properties.get(r);
  const k = nameKey(r);
  const hits = sitesSorted(st).filter((p) => nameKey(p.name) === k);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail('現場名が「' + r + '」の現場が ' + hits.length + ' 件あります。id で指定してください（' + hits.map((p) => p.id).join(', ') + '）');
  fail('現場「' + r + '」が見つかりません。list_sites で id か現場名を確かめてください');
}
function findCategory(st, ref) {
  if (ref === undefined || ref === null || ref === '') return memoCategory(st);
  if (typeof ref !== 'string') fail('種別は文字で指定してください');
  const r = ref.trim();
  const hit = st.categories.find((c) => c.id === r) || st.categories.find((c) => nameKey(c.name) === nameKey(r));
  if (!hit) fail('種別「' + r + '」はありません。使える種別: ' + st.categories.map((c) => c.name).join('、'));
  return hit;
}
function findEvent(st, id) {
  const e = typeof id === 'string' ? st.events.get(id.trim()) : null;
  if (!e) fail('予定「' + id + '」が見つかりません。list_events で id を確かめてください');
  return e;
}
function sameNameSite(st, name, exceptId) {
  const k = nameKey(name);
  return [...st.properties.values()].find((p) => p.id !== exceptId && nameKey(p.name) === k) || null;
}
// 施工業者を候補の先頭に入れる（画面で入れたときと同じ）
function rememberWho(st, who) {
  if (!who) return;
  const k = nameKey(who, true);
  st.contractors = [who, ...st.contractors.filter((x) => nameKey(x, true) !== k)];
}

// ---- 返す形 ----
function siteOut(st, p) {
  const evs = eventsOfSite(st, p.id);
  return {
    id: p.id, name: p.name, contractors: whoNames(p.contractor), events: evs.length,
    first_date: evs.length ? iso(Math.min(...evs.map((e) => e.start))) : null,
    last_date: evs.length ? iso(Math.max(...evs.map((e) => e.end))) : null,
  };
}
function eventOut(st, e) {
  const p = st.properties.get(e.pid);
  const c = st.categories.find((x) => x.id === e.cat) || memoCategory(st);
  return { id: e.id, site_id: e.pid, site: p ? p.name : null, category: c ? c.name : null, label: e.label || '', start: iso(e.start), end: iso(e.end), pinned: !!e.pinned };
}

// ---- ツール ----
const SITE = { type: 'string', description: '現場：list_sites で出る id か、現場名（そのまま）' };
const DATE = (what) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: what + '（YYYY-MM-DD）' });
const WHO = {
  description: '施工業者。1 行に 1 社（改行で区切った文字か、文字の配列）。空にすると施工業者なし',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
};
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const AGENT_TOOLS = [
  {
    name: 'list_sites', title: '現場の一覧', readOnly: true,
    description: '取り付け工程表の現場の一覧。各現場の id・現場名・施工業者（1 行に 1 社）・予定の数・最初と最後の予定日を返す。query を渡すと、現場名か施工業者にその文字を含む現場だけ（全角・半角、ひらがな・カタカナの違いは無視）。',
    inputSchema: schema({ query: { type: 'string', description: '絞り込む文字（任意）' } }),
    run(st, a) {
      const q = a.query == null ? '' : nameKey(textArg(a.query, 'query', 100));
      const sites = sitesSorted(st).filter((p) => !q || nameKey(p.name).includes(q) || nameKey(p.contractor).includes(q));
      return { sites: sites.map((p) => siteOut(st, p)), total: sites.length };
    },
  },
  {
    name: 'list_events', title: '予定の一覧', readOnly: true,
    description: '予定の一覧を開始日の順に返す。各予定の id・現場・種別・内容・開始日・終了日・ピン（pinned）。site・from・to・category で絞り込める（from〜to にかかる予定）。pinned が true の予定は、日付の変更も削除もできない。',
    inputSchema: schema({ site: SITE, from: DATE('この日以降にかかる予定'), to: DATE('この日以前にかかる予定'), category: { type: 'string', description: '種別の名前か id（任意）' } }),
    run(st, a) {
      const p = a.site == null ? null : findSite(st, a.site);
      const from = a.from == null ? null : dateArg(a.from, 'from');
      const to = a.to == null ? null : dateArg(a.to, 'to');
      if (from != null && to != null && to < from) fail('to は from より後の日付にしてください');
      const c = a.category == null ? null : findCategory(st, a.category);
      const order = new Map(sitesSorted(st).map((x, i) => [x.id, i]));
      const evs = [...st.events.values()]
        .filter((e) => (!p || e.pid === p.id) && (from == null || e.end >= from) && (to == null || e.start <= to) && (!c || e.cat === c.id) && st.properties.has(e.pid))
        .sort((x, y) => x.start - y.start || (order.get(x.pid) ?? 0) - (order.get(y.pid) ?? 0) || x.end - y.end);
      return { events: evs.slice(0, MAX_EVENTS_OUT).map((e) => eventOut(st, e)), total: evs.length, truncated: evs.length > MAX_EVENTS_OUT };
    },
  },
  {
    name: 'list_categories', title: '種別（凡例）の一覧', readOnly: true,
    description: '予定の種別（凡例の色）の一覧。add_event・update_event の category には、ここの名前か id を使う。「色なし」は色を付けない種別。種別の追加・変更は画面で行う。',
    inputSchema: schema({}),
    run(st) {
      return { categories: st.categories.map((c) => ({ id: c.id, name: c.name, color: c.memo ? null : '#' + c.color, no_color: !!c.memo })) };
    },
  },
  {
    name: 'add_site', title: '現場を追加',
    description: '現場を 1 件追加する。name は現場名（改行で好きな位置で折り返せる）。contractor は施工業者（1 行に 1 社）。同じ現場名の現場がもうあるときは追加しない（update_site で直す）。',
    inputSchema: schema({ name: { type: 'string', description: '現場名' }, contractor: WHO }, ['name']),
    annotations: { destructiveHint: false },
    run(st, a) {
      const name = textArg(a.name, '現場名', MAX_NAME, { required: true, multiline: true });
      const dup = sameNameSite(st, name, null);
      if (dup) fail('現場名が同じ現場がもうあります（id: ' + dup.id + '）。直すときは update_site を使ってください');
      const contractor = whoArg(a.contractor) || '';
      const order = Math.max(0, ...[...st.properties.values()].map((p) => p.order || 0)) + 1;
      const p = { id: uid('p'), name, contractor, order };
      st.properties.set(p.id, p);
      rememberWho(st, contractor);
      return { message: '現場を追加しました', site: siteOut(st, p) };
    },
  },
  {
    name: 'update_site', title: '現場を直す',
    description: '現場の現場名・施工業者を直す。渡した項目だけを変える。',
    inputSchema: schema({ site: SITE, name: { type: 'string', description: '新しい現場名（任意）' }, contractor: WHO }, ['site']),
    annotations: { destructiveHint: true, idempotentHint: true },
    run(st, a) {
      const p = findSite(st, a.site);
      if (a.name == null && a.contractor == null) fail('name か contractor のどちらかを指定してください');
      const next = { ...p };
      if (a.name != null) {
        next.name = textArg(a.name, '現場名', MAX_NAME, { required: true, multiline: true });
        const dup = sameNameSite(st, next.name, p.id);
        if (dup) fail('現場名が同じ現場がもうあります（id: ' + dup.id + '）');
      }
      if (a.contractor != null) next.contractor = whoArg(a.contractor) || '';
      st.properties.set(p.id, next);
      if (a.contractor != null) rememberWho(st, next.contractor);
      return { message: '現場を直しました', before: siteOut(st, p), site: siteOut(st, next) };
    },
  },
  {
    name: 'delete_site', title: '現場を削除',
    description: '現場と、その現場の予定をすべて削除する。ピンで固定した予定がある現場は削除できない。',
    inputSchema: schema({ site: SITE }, ['site']),
    annotations: { destructiveHint: true },
    run(st, a) {
      const p = findSite(st, a.site);
      const evs = eventsOfSite(st, p.id);
      const pinned = evs.filter((e) => e.pinned);
      if (pinned.length) fail('この現場にはピンで固定した予定が ' + pinned.length + ' 件あるので削除できません（ピンは画面で外せます）');
      const out = siteOut(st, p);
      for (const e of evs) st.events.delete(e.id);
      st.properties.delete(p.id);
      return { message: '現場と予定 ' + evs.length + ' 件を削除しました', deleted: out };
    },
  },
  {
    name: 'add_event', title: '予定を追加',
    description: '現場に予定を 1 件追加する。start は開始日、end は終了日（省略すると 1 日だけ）。category は種別の名前か id（省略すると「色なし」）。label は内容（ガントの棒の中か横に出る文字）。',
    inputSchema: schema({ site: SITE, start: DATE('開始日'), end: DATE('終了日（任意）'), category: { type: 'string', description: '種別の名前か id（任意）' }, label: { type: 'string', description: '内容（任意）' } }, ['site', 'start']),
    annotations: { destructiveHint: false },
    run(st, a) {
      const p = findSite(st, a.site);
      const start = dateArg(a.start, '開始日');
      const end = a.end == null ? start : dateArg(a.end, '終了日');
      if (end < start) fail('終了日は開始日と同じか、それより後にしてください');
      const c = findCategory(st, a.category);
      const label = textArg(a.label, '内容', MAX_LABEL) || '';
      const e = { id: uid('e'), pid: p.id, cat: c.id, label, start, end };
      st.events.set(e.id, e);
      return { message: '予定を追加しました', event: eventOut(st, e) };
    },
  },
  {
    name: 'add_events', title: '予定をまとめて追加',
    description: '1 つの現場に、予定をまとめて追加する（1 回に 100 件まで）。events の各項目は start（必須）・end・category・label で、意味は add_event と同じ。1 件でもおかしいものがあれば、どれも追加しない。Excel などから移すときに使う。',
    inputSchema: schema({
      site: SITE,
      events: {
        type: 'array', maxItems: 100, description: '追加する予定（1 回に 100 件まで）',
        items: schema({ start: DATE('開始日'), end: DATE('終了日（任意）'), category: { type: 'string', description: '種別の名前か id（任意）' }, label: { type: 'string', description: '内容（任意）' } }, ['start']),
      },
    }, ['site', 'events']),
    annotations: { destructiveHint: false },
    run(st, a) {
      const p = findSite(st, a.site);
      if (!Array.isArray(a.events) || !a.events.length) fail('events に予定を 1 件以上入れてください');
      if (a.events.length > 100) fail('一度に追加できるのは 100 件までです（' + a.events.length + ' 件）');
      const made = a.events.map((x, i) => {
        const where = (i + 1) + ' 件目：';
        if (!x || typeof x !== 'object' || Array.isArray(x)) fail(where + '予定はオブジェクトで指定してください');
        const extra = Object.keys(x).filter((k) => !['start', 'end', 'category', 'label'].includes(k));
        if (extra.length) fail(where + '決まっていない項目は受け取れません: ' + extra.join(', '));
        try {
          const start = dateArg(x.start, '開始日');
          const end = x.end == null ? start : dateArg(x.end, '終了日');
          if (end < start) fail('終了日は開始日と同じか、それより後にしてください');
          return { id: uid('e'), pid: p.id, cat: findCategory(st, x.category).id, label: textArg(x.label, '内容', MAX_LABEL) || '', start, end };
        } catch (e) {
          if (e instanceof AgentError) fail(where + e.message);
          throw e;
        }
      });
      for (const e of made) st.events.set(e.id, e);
      return { message: '予定を ' + made.length + ' 件追加しました', site: p.name, count: made.length, events: made.map((e) => eventOut(st, e)) };
    },
  },
  {
    name: 'update_event', title: '予定を直す',
    description: '予定の開始日・終了日・種別・内容を直す。渡した項目だけを変える。start だけを渡すと、日数はそのままで予定を動かす。ピンで固定した予定（pinned: true）は日付を変えられない（種別と内容は変えられる）。',
    inputSchema: schema({ id: { type: 'string', description: '予定の id（list_events で出る）' }, start: DATE('新しい開始日（任意）'), end: DATE('新しい終了日（任意）'), category: { type: 'string', description: '新しい種別の名前か id（任意）' }, label: { type: 'string', description: '新しい内容（任意）' } }, ['id']),
    annotations: { destructiveHint: true, idempotentHint: true },
    run(st, a) {
      const e = findEvent(st, a.id);
      if (a.start == null && a.end == null && a.category == null && a.label == null) fail('start・end・category・label のどれかを指定してください');
      const next = { ...e };
      if (a.start != null || a.end != null) {
        if (e.pinned) fail('この予定はピンで固定されているので、日付は変えられません（ピンは画面で外せます）');
        if (a.start != null) {
          next.start = dateArg(a.start, '開始日');
          next.end = a.end != null ? dateArg(a.end, '終了日') : next.start + (e.end - e.start);
        } else next.end = dateArg(a.end, '終了日');
        if (next.end < next.start) fail('終了日は開始日と同じか、それより後にしてください');
        if (!validDn(next.end)) fail('終了日が 2099 年より後になります');
      }
      if (a.category != null) next.cat = findCategory(st, a.category).id;
      if (a.label != null) next.label = textArg(a.label, '内容', MAX_LABEL) || '';
      st.events.set(e.id, next);
      return { message: '予定を直しました', before: eventOut(st, e), event: eventOut(st, next) };
    },
  },
  {
    name: 'delete_event', title: '予定を削除',
    description: '予定を 1 件削除する。ピンで固定した予定は削除できない。',
    inputSchema: schema({ id: { type: 'string', description: '予定の id（list_events で出る）' } }, ['id']),
    annotations: { destructiveHint: true },
    run(st, a) {
      const e = findEvent(st, a.id);
      if (e.pinned) fail('この予定はピンで固定されているので削除できません（ピンは画面で外せます）');
      const out = eventOut(st, e);
      st.events.delete(e.id);
      return { message: '予定を削除しました', deleted: out };
    },
  },
];

// ツールを 1 つ動かす。決まっていない項目が入っていたら受け取らない。state は書き換わる（書き込みのツールのとき）
export function runAgentTool(st, name, args) {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) fail('ツール「' + name + '」はありません');
  const a = args == null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) fail('引数はオブジェクトで指定してください');
  const known = Object.keys(tool.inputSchema.properties);
  const extra = Object.keys(a).filter((k) => !known.includes(k));
  if (extra.length) fail('決まっていない項目は受け取れません: ' + extra.join(', ') + '（使える項目: ' + (known.join(', ') || 'なし') + '）');
  return { tool, result: tool.run(st, a) };
}
