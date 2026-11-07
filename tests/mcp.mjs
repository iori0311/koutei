// 作った MCP サーバー（取り付け工程表_mcp.mjs。先に node build.mjs で作る）を起動して、標準入出力で MCP のやりとりをする
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = join(root, '取り付け工程表_mcp.mjs'), sampleJson = join(root, 'src', 'sample-data.json'), work = tmpdir();
const dir = await mkdtemp(join(work, 'mcp-'));
const file = join(dir, '工程データ.json');
await copyFile(sampleJson, file);
// サンプルの保存データは app などが入った形なので、そのまま使える
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('NG', m); } };

function start(args) {
  const p = spawn(process.execPath, [server, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', err = '';
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } else console.log('知らない返事', line);
    }
  });
  p.stderr.on('data', (d) => { err += d; });
  let id = 0;
  const req = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const raw = (line, i) => new Promise((res) => { waiters.set(i, res); p.stdin.write(line + '\n'); });
  const note = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const done = () => new Promise((res) => { p.on('exit', (code) => res({ code, err })); p.stdin.end(); });
  return { p, req, raw, note, done, stderr: () => err };
}
const call = async (s, name, args) => { const r = await s.req('tools/call', { name, arguments: args }); return { r, text: r.result && r.result.content[0].text, json: r.result && !r.result.isError ? JSON.parse(r.result.content[0].text) : null }; };

// 1) 起動と初期化
const s = start([file]);
let r = await s.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
ok(r.result && r.result.protocolVersion === '2025-06-18' && r.result.capabilities.tools && r.result.serverInfo.name === 'torituke-koutei' && /ピン/.test(r.result.instructions), 'initialize');
s.note('notifications/initialized', {});
r = await s.req('initialize', { protocolVersion: '1999-01-01' });
ok(r.result.protocolVersion === '2025-06-18', '知らない版なら、こちらの版を返す');
ok((await s.req('ping', {})).result && true, 'ping');
r = await s.req('tools/list', {});
const tools = r.result.tools;
ok(tools.length === 10 && tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'tools/list（10 個）');
ok(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort().join() === 'list_categories,list_events,list_sites', '読むだけのツールに readOnlyHint');
ok(tools.find((t) => t.name === 'delete_event').annotations.destructiveHint === true, '削除に destructiveHint');

// 2) 読む
let c = await call(s, 'list_sites', {});
ok(c.json && c.json.total === 2, 'list_sites');
const site = c.json.sites[1];
c = await call(s, 'list_events', { site: site.id });
ok(c.json && c.json.total === site.events, 'list_events');
const pinned = (await call(s, 'list_events', {})).json.events.find((e) => e.pinned);
ok(!!pinned, 'サンプルにはピンの予定がある');

// 3) 書く → ファイルが変わり、控えが残る
const before = await readFile(file, 'utf8');
c = await call(s, 'add_event', { site: site.name, start: '2026-11-18', end: '2026-11-19', category: 'サッシ搬入', label: 'MCP から足した' });
ok(c.json && c.json.event.category === 'サッシ搬入', 'add_event');
const after = JSON.parse(await readFile(file, 'utf8'));
ok(after.events.some((e) => e.label === 'MCP から足した' && e.start === '2026-11-18' && e.end === '2026-11-19'), 'ファイルに書かれた');
const backups = await readdir(join(dir, '工程データ_控え'));
ok(backups.length === 1 && (await readFile(join(dir, '工程データ_控え', backups[0]), 'utf8')) === before, '前の中身が控えに残る');
ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')), '一時ファイルが残らない');

// 4) ルールを守る
c = await call(s, 'update_event', { id: pinned.id, start: '2026-12-01' });
ok(c.r.result.isError === true && /ピン/.test(c.text), 'ピンの予定は動かせない（isError）');
c = await call(s, 'add_site', { name: 'X', 担当: '山田' });
ok(c.r.result.isError === true && /決まっていない項目/.test(c.text), '知らない項目は受け取らない');
r = await s.req('tools/call', { name: 'rm_rf', arguments: {} });
ok(r.error && r.error.code === -32602, '知らないツールは JSON-RPC のエラー');
r = await s.req('resources/list', {});
ok(r.error && r.error.code === -32601, '知らないメソッド');
r = await s.raw('{これは JSON ではない', null);
ok(r.error && r.error.code === -32700, '壊れた JSON は Parse error');

// 5) 画面側（ほか）がファイルを書き換えたら、次の呼び出しで読み直している
const obj = JSON.parse(await readFile(file, 'utf8'));
obj.properties.push({ id: 'p-from-app', name: '画面で足した現場', contractor: '', order: 99 });
await writeFile(file, JSON.stringify(obj));
c = await call(s, 'list_sites', { query: '画面で足した' });
ok(c.json && c.json.total === 1, 'ファイルを毎回読み直す');
c = await call(s, 'add_event', { site: '画面で足した現場', start: '2026-11-20' });
const after2 = JSON.parse(await readFile(file, 'utf8'));
ok(after2.properties.some((p) => p.id === 'p-from-app') && after2.events.some((e) => e.pid === 'p-from-app'), '画面側の変更を消さずに書く');

const end = await s.done();
ok(end.code === 0, '入力が閉じたら終わる');

// 6) ファイルがないときは、理由を出して終わる
const s2 = start([join(dir, 'ない.json')]);
const end2 = await new Promise((res) => s2.p.on('exit', (code) => res(code)));
ok(end2 === 1 && /ファイルがありません/.test(s2.stderr()), 'ファイルがないとき');

await rm(dir, { recursive: true, force: true });
console.log('mcp: ' + (bad ? bad + ' / ' + n + ' 件 NG' : 'すべて OK（' + n + ' 件）'));
process.exitCode = bad ? 1 : 0;
