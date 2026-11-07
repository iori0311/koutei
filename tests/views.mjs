// ビューの絞り込み（現場 × 施工業者）と、前の版のデータの引き継ぎを確かめる
import { fileURLToPath, pathToFileURL } from 'node:url';
const src = fileURLToPath(new URL('../src', import.meta.url));
const { viewMatch, deserialize } = await import(pathToFileURL(src + '/store.js').href);
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('NG', msg); } };
const A = { id: 'a', contractor: 'サンプル建設\nサンプル工業' };
const B = { id: 'b', contractor: 'サンプル建設\n見本工業' };
const C = { id: 'c', contractor: '' };
const D = { id: 'd', contractor: 'さんぷる建設' };   // ひらがなでも同じ会社
const all = [A, B, C, D];
const run = (v) => all.filter((p) => viewMatch(v, p)).map((p) => p.id).join('');
ok(run({ pids: null, whos: null }) === 'abcd', 'すべて × すべて');
ok(run({ pids: [], whos: null }) === '', '現場なし');
ok(run({ pids: null, whos: [] }) === '', '施工業者なし（チェックなし）');
ok(run({ pids: null, whos: ['サンプル建設'] }) === 'abd', '施工業者だけ（ひらがなも）');
ok(run({ pids: null, whos: ['見本工業'] }) === 'b', '見本工業');
ok(run({ pids: ['a', 'b'], whos: ['見本工業'] }) === 'b', '現場 × 施工業者');
ok(run({ pids: ['a'], whos: ['見本工業'] }) === '', '当てはまらない組み合わせ');
ok(run({ pids: null, whos: [''] }) === 'c', '施工業者なしの現場');
ok(run({ pids: ['a', 'c'], whos: ['サンプル工業', ''] }) === 'ac', '施工業者なしも含めて');
// 前の版のデータ
const base = { app: 'koutei-gantt', v: 1, properties: [], events: [], categories: [] };
const st = deserialize({ ...base, views: [
  { id: 'v1', name: '現場で', by: 'site', pids: ['a'], whos: ['x'] },
  { id: 'v2', name: '業者で', by: 'who', pids: ['a'], whos: ['見本工業'] },
  { id: 'v3', name: 'もっと前', pids: ['b'] },
  { id: 'v4', name: '今の形', pids: null, whos: ['サンプル建設'] },
] });
const s = (v) => JSON.stringify({ pids: v.pids, whos: v.whos });
ok(s(st.views[0]) === '{"pids":["a"],"whos":null}', '現場で選ぶ → 現場だけ ' + s(st.views[0]));
ok(s(st.views[1]) === '{"pids":null,"whos":["見本工業"]}', '施工業者で選ぶ → 施工業者だけ ' + s(st.views[1]));
ok(s(st.views[2]) === '{"pids":["b"],"whos":null}', 'もっと前の形 ' + s(st.views[2]));
ok(s(st.views[3]) === '{"pids":null,"whos":["サンプル建設"]}', '今の形はそのまま ' + s(st.views[3]));
ok(!('by' in st.views[0]), 'by は残さない');
console.log('views: ' + (bad ? bad + ' 件 NG' : 'すべて OK（' + 15 + ' 件）'));
process.exitCode = bad ? 1 : 0;
