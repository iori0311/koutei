// エージェント用の操作（agent-ops.js）と、ファイルの変更の取り込み（mergeFromFile）を確かめる
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const src = fileURLToPath(new URL('../src', import.meta.url));
const S = await import(pathToFileURL(src + '/store.js').href);
const A = await import(pathToFileURL(src + '/agent-ops.js').href);
const sample = JSON.parse(await readFile(src + '/sample-data.json', 'utf8'));
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('NG', m); } };
const err = (fn, re, m) => { n++; try { fn(); bad++; console.log('NG（エラーにならない）', m); } catch (e) { if (!(e instanceof A.AgentError) || (re && !re.test(e.message))) { bad++; console.log('NG', m, '→', e.message); } } };
const fresh = () => S.deserialize(JSON.parse(JSON.stringify(sample)));
const run = (st, name, args) => A.runAgentTool(st, name, args).result;

// ---- 読む ----
let st = fresh();
let r = run(st, 'list_sites', {});
ok(r.total === 2 && r.sites[0].contractors.length === 2, '現場の一覧・施工業者は 1 行 1 社');
ok(run(st, 'list_sites', { query: 'さんぷる工業' }).total === 1, 'ひらがなで施工業者を探せる（カタカナの名前に当たる）');
const site1 = r.sites[0];
r = run(st, 'list_events', { site: site1.name });
ok(r.total === site1.events && r.events.every((e) => e.site_id === site1.id), '現場名で予定を絞れる');
const all = run(st, 'list_events', {}).total;
r = run(st, 'list_events', { from: '2026-11-01', to: '2026-11-30' });
ok(r.total > 0 && r.total < all && r.events.every((e) => e.end >= '2026-11-01' && e.start <= '2026-11-30'), '期間で絞れる');
r = run(st, 'list_categories', {});
ok(r.categories.length === 10 && r.categories.find((c) => c.no_color).name === '色なし', '種別の一覧');

// ---- 入力の確かめ ----
err(() => run(st, 'add_site', { name: site1.name }), /もうあります/, '同じ現場名は足さない');
err(() => run(st, 'add_site', { name: '   ' }), /入れてください/, '空の現場名');
err(() => run(st, 'add_site', { name: 'A', status: '進行中' }), /決まっていない項目/, '知らない項目は受け取らない');
err(() => run(st, 'add_event', { site: site1.id, start: '2026/11/01' }), /YYYY-MM-DD/, '日付の形');
err(() => run(st, 'add_event', { site: site1.id, start: '2026-02-30' }), /正しい日付/, 'ない日付');
err(() => run(st, 'add_event', { site: site1.id, start: '2026-11-05', end: '2026-11-04' }), /終了日/, '終了日が前');
err(() => run(st, 'add_event', { site: site1.id, start: '2026-11-05', category: '存在しない' }), /使える種別/, '知らない種別');
err(() => run(st, 'add_event', { site: 'どこにもない現場', start: '2026-11-05' }), /見つかりません/, '知らない現場');
err(() => run(st, 'nope', {}), /ありません/, '知らないツール');

// ---- 書く ----
st = fresh();
r = run(st, 'add_site', { name: '（仮称）テスト\n新築工事', contractor: ['テスト建設', '  テスト工業 ', ''] });
ok(r.site.name === '（仮称）テスト\n新築工事' && r.site.contractors.join('|') === 'テスト建設|テスト工業', '現場を追加（改行・1 行 1 社）');
ok(st.contractors[0] === 'テスト建設\nテスト工業', '施工業者の候補の先頭に入る（画面と同じ）');
const pid = r.site.id;
r = run(st, 'add_event', { site: pid, start: '2026-11-10', label: '  サッシ\n搬入 ' });
ok(r.event.category === '色なし' && r.event.end === '2026-11-10' && r.event.label === 'サッシ 搬入', '予定を追加（色なし・1 日・内容は 1 行）');
const eid = r.event.id;
r = run(st, 'update_event', { id: eid, end: '2026-11-12' });
ok(r.event.start === '2026-11-10' && r.event.end === '2026-11-12', '終了日だけ変える');
r = run(st, 'update_event', { id: eid, start: '2026-11-20' });
ok(r.event.start === '2026-11-20' && r.event.end === '2026-11-22', '開始日だけ渡すと日数そのままで動く');
r = run(st, 'update_event', { id: eid, category: 'サッシ搬入', label: 'サッシ搬入（2階）' });
ok(r.event.category === 'サッシ搬入' && r.event.label === 'サッシ搬入（2階）', '種別と内容');
// ピン
st.events.get(eid).pinned = true;
err(() => run(st, 'update_event', { id: eid, start: '2026-11-25' }), /ピン/, 'ピンの予定は動かせない');
err(() => run(st, 'update_event', { id: eid, end: '2026-11-25' }), /ピン/, 'ピンの予定は伸ばせない');
ok(run(st, 'update_event', { id: eid, label: 'ピンでも内容は変えられる' }).event.label === 'ピンでも内容は変えられる', 'ピンでも内容は変えられる');
err(() => run(st, 'delete_event', { id: eid }), /ピン/, 'ピンの予定は消せない');
err(() => run(st, 'delete_site', { site: pid }), /ピン/, 'ピンの予定がある現場は消せない');
st.events.get(eid).pinned = false;
ok(run(st, 'delete_event', { id: eid }).deleted.id === eid && !st.events.has(eid), '予定を削除');
const before = st.events.size, s1 = run(st, 'list_sites', {}).sites[0];
for (const e of st.events.values()) if (e.pid === s1.id) e.pinned = false;   // サンプルにはピンの予定があるので外してから
ok(run(st, 'delete_site', { site: s1.id }) && !st.properties.has(s1.id) && st.events.size === before - s1.events, '現場と予定を削除');
// 書いたものを画面が読めるか
const again = S.deserialize(JSON.parse(JSON.stringify(S.serialize(st))));
ok(again.properties.size === st.properties.size && again.events.size === st.events.size, '保存し直しても読める');

// ---- まとめて追加（add_events） ----
{
  const st2 = fresh();
  const sid = [...st2.properties.keys()][1];
  const before2 = st2.events.size;
  const r2 = run(st2, 'add_events', { site: sid, events: [{ start: '2026-12-01' }, { start: '2026-12-02', end: '2026-12-03', category: 'サッシ搬入', label: '  2階 ' }, { start: '2026-12-05', category: 'c-kensa' }] });
  ok(r2.count === 3 && st2.events.size === before2 + 3 && r2.events[1].label === '2階' && r2.events[1].category === 'サッシ搬入' && r2.events[0].category === '色なし', 'まとめて追加（3 件）');
  err(() => run(st2, 'add_events', { site: sid, events: [{ start: '2026-12-01' }, { start: '2026-13-01' }] }), /2 件目/, '1 件でもおかしければエラー（何件目か）');
  ok(st2.events.size === before2 + 3, 'エラーのときは 1 件も足さない');
  err(() => run(st2, 'add_events', { site: sid, events: Array.from({ length: 101 }, () => ({ start: '2026-12-01' })) }), /100 件まで/, '101 件はエラー');
  err(() => run(st2, 'add_events', { site: sid, events: [{ start: '2026-12-01', 担当: '山田' }] }), /決まっていない項目/, '予定の中の知らない項目も断る');
  err(() => run(st2, 'add_events', { site: sid, events: [] }), /1 件以上/, '空はエラー');
}

// ---- ファイルの変更の取り込み（mergeFromFile） ----
const base = fresh();
const ids = [...base.events.keys()];
const theirs = fresh(), ours = fresh();
const pidA = [...base.properties.keys()][0];
run(theirs, 'add_event', { site: pidA, start: '2026-12-01', label: 'エージェントが足した' });
run(theirs, 'update_event', { id: ids[0], label: 'エージェントが直した' });
ours.events.set(ids[1], { ...ours.events.get(ids[1]), label: '画面で直した' });
// 並び順だけ違うもの（同じ中身）は変更にしない
const e2 = ours.events.get(ids[2]); ours.events.set(ids[2], Object.fromEntries(Object.entries(e2).reverse()));
let m = S.mergeFromFile(base, theirs, ours);
ok(m.conflicts === 0 && m.changes.length === 2 && m.changes.some((c) => c.id === ids[0]) && m.changes.some((c) => !c.before), 'ファイルの側の追加と変更だけを取り込む');
const t2 = fresh(), o2 = fresh();
run(t2, 'update_event', { id: ids[3], label: 'エージェント' });
o2.events.set(ids[3], { ...o2.events.get(ids[3]), label: '画面' });
m = S.mergeFromFile(base, t2, o2);
ok(m.conflicts === 1 && m.changes.length === 0, '同じ予定を両方で変えたら画面を残す');
const t3 = fresh(), o3 = fresh();
for (const e of t3.events.values()) if (e.pid === pidA) e.pinned = false;
run(t3, 'delete_site', { site: pidA });
o3.events.set('e-new', { id: 'e-new', pid: pidA, cat: 'c-memo', label: '画面で足した', start: 20800, end: 20800 });
m = S.mergeFromFile(base, t3, o3);
ok(m.changes.some((c) => c.kind === 'property' && c.id === pidA && !c.after) && m.changes.some((c) => c.id === 'e-new' && !c.after), '消された現場に画面で足した予定も消す');
// sameSavedData
const a = JSON.stringify(S.serialize(base));
const b = JSON.stringify({ ...JSON.parse(a), savedAt: '2000-01-01T00:00:00.000Z' });
ok(S.sameSavedData(a, b) && !S.sameSavedData(a, JSON.stringify(S.serialize(theirs))), '保存時刻の違いは同じ中身とみなす');

console.log('agent: ' + (bad ? bad + ' / ' + n + ' 件 NG' : 'すべて OK（' + n + ' 件）'));
process.exitCode = bad ? 1 : 0;
