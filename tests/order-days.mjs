// 現場の並び替え（行のドラッグ）と、休日（土日・祝日・社内休暇・出社日）を確かめる
import { fileURLToPath, pathToFileURL } from 'node:url';
const src = fileURLToPath(new URL('../src', import.meta.url));
const load = (f) => import(pathToFileURL(src + '/' + f).href);
const { store, emptyState, serialize, deserialize, mergeFromFile } = await load('store.js');
const { makeDayInfo } = await load('layout.js');
const { dn, iso, fiscalYear } = await load('dates.js');
const { shiftOffDaysYear, offDaysInYear, normalizeDaysOff, addOffRange, removeOffRange, addWorkRange, paintDays } = await load('days-off.js');
let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('NG', msg); } };

// ---- 並び替え ----
const setSites = (list) => {
  store.state = emptyState();
  store.history = [];
  store.future = [];
  for (const [id, order] of list) store.state.properties.set(id, { id, name: '現場' + id, contractor: '', order });
};
const ids = () => store.sortedProperties().map((p) => p.id).join('');
setSites([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
ok(store.moveProperty('d', { before: 'a' }) && ids() === 'dabc', '一番上へ ' + ids());
ok(store.history.at(-1).changes.length === 1, '動かした現場だけが変わる');
ok(store.moveProperty('a', { after: 'c' }) && ids() === 'dbca', '一番下へ ' + ids());
ok(store.moveProperty('c', { before: 'b' }) && ids() === 'dcba', 'あいだへ ' + ids());
const h0 = store.history.length;
ok(!store.moveProperty('c', { before: 'b' }) && store.history.length === h0, '同じ場所なら何もしない');
store.undo();
ok(ids() === 'dbca', '元に戻す ' + ids());
// order が同じ現場のあいだに入れるときは、全部を振り直す
setSites([['a', 1], ['b', 5], ['c', 5], ['d', 9]]);
store.moveProperty('d', { before: 'c' });
ok(ids() === 'abdc' && store.sortedProperties().map((p) => p.order).join() === '1,2,3,4', '振り直し ' + ids());
// ビューで b が見えていないとき、c を a の前へ（見えている前後だけで決まる）
setSites([['a', 1], ['b', 2], ['c', 3]]);
store.moveProperty('c', { before: 'a' });
ok(ids() === 'cab', 'ビューで絞り込んでいても ' + ids());

// ---- 休日 ----
const days = { offDays: [{ name: '夏季休暇', start: dn('2026-08-12'), end: dn('2026-08-14') }], workDays: [dn('2026-11-07')] };
const info = makeDayInfo(days);
ok(info(dn('2026-11-08')).kind === 'off', '日曜は休み');
ok(info(dn('2026-11-14')).kind === 'off', '土曜も休み（日曜と同じ色）');
ok(info(dn('2026-11-07')).kind === '' && info(dn('2026-11-07')).name === '出社日', '出社日の土曜は休みにしない');
ok(info(dn('2026-11-03')).kind === 'off' && info(dn('2026-11-03')).name === '文化の日', '祝日');
ok(info(dn('2026-08-13')).kind === 'off' && info(dn('2026-08-13')).name === '社内休暇（夏季休暇）', '社内休暇 ' + info(dn('2026-08-13')).name);
ok(info(dn('2026-08-11')).kind === 'off' && info(dn('2026-08-11')).name === '山の日', '社内休暇の前の日は祝日のまま');
ok(info(dn('2026-08-17')).kind === '', '平日');
ok(makeDayInfo()(dn('2026-11-14')).kind === 'off', '設定がなくても土日は休み');

// 保存と読み込み
const st = emptyState();
st.offDays = [{ id: 'h1', name: '年末年始', start: dn('2026-12-29'), end: dn('2027-01-04') }];
st.workDays = [dn('2026-09-12')];
const back = deserialize(JSON.parse(JSON.stringify(serialize(st))));
ok(JSON.stringify(back.offDays) === JSON.stringify(st.offDays) && back.workDays.join() === st.workDays.join(), '保存して読み込むと同じ');
ok(serialize(st).offDays[0].start === '2026-12-29' && serialize(st).workDays[0] === '2026-09-12', 'ファイルには日付の文字で入る');
const odd = deserialize({ app: 'koutei-gantt', offDays: [{ name: 'x', start: '2026-08-14', end: '2026-08-12' }, { start: 'だめ' }], workDays: ['2026-09-12', '2026-09-12', 'x'] });
ok(odd.offDays.length === 1 && odd.offDays[0].end === odd.offDays[0].start && odd.workDays.length === 1, 'おかしい日付は直すか外す');

// 前の版（社内休暇を知らない）が書いたファイルを取り込んでも、社内休暇は消えない
const ours = deserialize(serialize(st));
const legacy = serialize(st);
delete legacy.offDays;
delete legacy.workDays;
const r1 = mergeFromFile(deserialize(serialize(st)), deserialize(legacy), ours);
ok(!r1.changes.some((c) => c.kind === 'offDays' || c.kind === 'workDays'), '前の版のファイルでは消えない');
const newer = serialize(st);
newer.workDays = ['2026-09-12', '2026-10-10'];
const r2 = mergeFromFile(deserialize(serialize(st)), deserialize(newer), ours);
ok(r2.changes.some((c) => c.kind === 'workDays'), 'ほかで足した出社日は取り込む');

// 年度
ok(fiscalYear(dn('2027-03-31')) === 2026 && fiscalYear(dn('2027-04-01')) === 2027, '年度は 4 月から');
const list = [{ id: 'a', name: '夏', start: dn('2026-08-13'), end: dn('2026-08-16') }, { id: 'b', name: '冬', start: dn('2026-12-29'), end: dn('2027-01-03') }, { id: 'c', name: '翌年', start: dn('2027-05-01'), end: dn('2027-05-01') }];
ok(offDaysInYear(list, 2026).map((o) => o.id).join('') === 'ab', '年度に入る社内休暇（始まりの日で決める）');
const moved = shiftOffDaysYear([{ start: dn('2028-02-29'), end: dn('2028-03-01') }], 1)[0];
ok(iso(moved.start) === '2029-02-28' && iso(moved.end) === '2029-03-01', '前の年度から写す（2/29 は 2/28 に）');
const norm = normalizeDaysOff([{ start: dn('2026-08-14'), end: dn('2026-08-12'), name: '  お盆  ' }], [dn('2026-09-12'), dn('2026-09-12')]);
ok(norm.off[0].end === norm.off[0].start && norm.off[0].name === 'お盆' && norm.work.length === 1, '保存する形にそろえる');

// カレンダーで入れる・消す
const D = (s) => dn('2026-' + s);
const span = (list) => list.map((o) => iso(o.start).slice(5) + '~' + iso(o.end).slice(5) + (o.name ? ':' + o.name : '')).sort().join(' ');
let off = addOffRange([], D('08-13'), D('08-16'));
ok(span(off) === '08-13~08-16', '社内休暇を入れる ' + span(off));
off[0].name = '夏季休暇';
off = addOffRange(off, D('08-16'), D('08-18'));
ok(span(off) === '08-13~08-18:夏季休暇', '重なるところに入れると 1 つにまとまる（名前は残る） ' + span(off));
off = addOffRange(off, D('08-20'), D('08-21'));
ok(span(off) === '08-13~08-18:夏季休暇 08-20~08-21', '離れたところは別に ' + span(off));
off = removeOffRange(off, D('08-15'), D('08-16'));
ok(span(off) === '08-13~08-14:夏季休暇 08-17~08-18:夏季休暇 08-20~08-21', '途中を消すと 2 つに分かれる ' + span(off));
ok(new Set(off.map((o) => o.id)).size === off.length, '分けたものは別の id');
off = removeOffRange(off, D('08-01'), D('08-31'));
ok(off.length === 0, '期間をまとめて消す');
const work = addWorkRange([], [{ start: D('08-12'), end: D('08-12') }], D('08-10'), D('08-16'));
ok(work.map((d) => iso(d).slice(5)).join() === '08-11,08-12,08-15,08-16', '出社日は休みの日だけに入る（祝日・社内休暇・土日） ' + work.map(iso).join());

// カレンダーで塗る（社内休暇 ⇔ 出社日）
const ws = (w) => w.map((d) => iso(d).slice(5)).join(',');
let dd = paintDays({ off: [], work: [] }, 'co', D('08-13'), D('08-18'));
ok(span(dd.off) === '08-13~08-18' && !dd.work.length, '社内休暇で塗る（土日もまとめて 1 つの期間）');
dd = paintDays(dd, 'wk', D('08-15'), D('08-15'));
ok(span(dd.off) === '08-13~08-14 08-16~08-18' && ws(dd.work) === '08-15', '社内休暇の中の土曜を出社日にすると、分かれて出社日が入る ' + span(dd.off) + ' / ' + ws(dd.work));
dd = paintDays(dd, 'wk', D('08-17'), D('08-18'));
ok(span(dd.off) === '08-13~08-14 08-16~08-16' && ws(dd.work) === '08-15', '平日を出社日で塗ると、社内休暇から外れるだけ ' + span(dd.off));
dd = paintDays(dd, 'co', D('08-15'), D('08-15'));
ok(span(dd.off) === '08-13~08-14 08-16~08-16' && !dd.work.length, '土曜だけを社内休暇で塗ると、出社日を外して休みに戻るだけ ' + span(dd.off));

console.log('order-days: ' + (bad ? bad + ' 件 NG（' + n + ' 件中）' : 'すべて OK（' + n + ' 件）'));
process.exitCode = bad ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 0);   // 自動保存のタイマーを待たない
