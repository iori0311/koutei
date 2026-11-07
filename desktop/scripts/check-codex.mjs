// 同梱の Codex App Server を、アプリ（codex.rs）と同じ設定で起動して確かめる（先に scripts/fetch-codex.mjs で置いておく）。
// モデルは 127.0.0.1 の偽物（ログイン・外への通信なし）。偽のモデルに add_event を呼ばせて、道具の呼び出しが画面側へ回ること、
// 結果がモデルに戻って回答が終わること、Web 検索・シェルなどの道具がモデルに見えていないことを確かめる。
//   node scripts/check-codex.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const binary = join(dir, 'binaries', process.platform === 'win32' ? 'codex.exe' : 'codex');
const pins = JSON.parse(await readFile(join(dir, 'codex.json'), 'utf8'));
const target = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc' }[process.platform + '-' + process.arch];
assert.ok(pins.targets[target], 'codex.json にこの PC（' + process.platform + '-' + process.arch + '）の Codex がある');
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), pins.targets[target].sha256, '同梱の Codex のハッシュ');
const rust = await readFile(join(dir, 'src/codex.rs'), 'utf8');
const list = (name) => [...rust.match(new RegExp('pub const ' + name + ': &\\[&str\\] = &\\[([^\\]]*)\\]', 's'))[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replaceAll('\\"', '"'));
const config = list('CONFIG'), disabled = list('DISABLED');
assert.ok(config.includes('web_search="disabled"') && disabled.includes('shell_tool'), 'codex.rs の設定を読めた');
const tools = JSON.parse(await readFile(join(dir, 'koutei-tools.json'), 'utf8'));
const policy = await readFile(join(dir, 'koutei-policy.txt'), 'utf8');
const model = JSON.parse(await readFile(join(dir, 'koutei-models.json'), 'utf8')).models[0].slug;
assert.equal(model, 'gpt-6-astra');

const answer = '北加賀屋に 11/20 の玄関ドア搬入を入れました。';
const toolArgs = { site: 'p-test', start: '2026-11-20', category: '玄関ドア搬入', label: '玄関ドア搬入（2〜6階）' };
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (events) => { for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n'); res.end(); };
  if (requests.length === 1) {
    const item = { type: 'function_call', id: 'f1', call_id: 'call_add', name: 'add_event', arguments: JSON.stringify(toolArgs) };
    return send([{ type: 'response.created', response: { id: 'r0' } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r0', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  }
  const item = { id: 'a1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] };
  send([{ type: 'response.created', response: { id: 'r1' } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.output_text.delta', item_id: 'a1', output_index: 0, content_index: 0, delta: answer }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r1', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const home = await mkdtemp(join(tmpdir(), 'koutei-check-'));
const catalog = join(home, 'models.json');
await writeFile(catalog, await readFile(join(dir, 'koutei-models.json')));
const args = ['app-server', '--stdio', ...config.flatMap((c) => ['-c', c]), ...disabled.flatMap((f) => ['-c', `features.${f}=false`]),
  '-c', `model_catalog_json=${JSON.stringify(catalog)}`, '-c', 'model_provider="probe"',
  '-c', `model_providers.probe={name="Probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`];
let child;
const pending = new Map();
let seq = 0, toolCall = null, complete;
const done = new Promise((r) => { complete = r; });
const notes = [];
try {
  // アプリ（codex.rs）と同じく、OS が動くのに要る環境変数だけを渡す
  const keep = ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH'];
  const env = Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
  child = spawn(binary, args, { env: { ...env, CODEX_HOME: home }, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const rpc = (method, params) => { const id = ++seq; child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return new Promise((r, j) => pending.set(id, { r, j })); };
  createInterface({ input: child.stdout }).on('line', (line) => {
    const v = JSON.parse(line);
    if (v.method === 'item/tool/call') {
      toolCall = v.params;
      child.stdin.write(JSON.stringify({ id: v.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ message: '予定を追加しました', event: { id: 'e-new', ...toolArgs } }) }] } }) + '\n');
      return;
    }
    if (v.id && pending.has(v.id)) { const p = pending.get(v.id); pending.delete(v.id); v.error ? p.j(new Error(JSON.stringify(v.error))) : p.r(v.result); return; }
    if (v.id && v.method) { child.stdin.write(JSON.stringify({ id: v.id, error: { code: -32601, message: 'not available' } }) + '\n'); notes.push({ method: 'server-request:' + v.method }); return; }
    notes.push(v);
    if (v.method === 'turn/completed') complete();
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', () => { for (const p of pending.values()) p.j(new Error('App Server が終わりました')); pending.clear(); complete(); });
  const timer = setTimeout(() => { console.error('時間切れ：', notes.map((n) => n.method)); child.kill(); complete(); }, 30000);

  await rpc('initialize', { clientInfo: { name: 'koutei_check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const thread = await rpc('thread/start', { ephemeral: true, model, baseInstructions: policy, developerInstructions: '確かめ', dynamicTools: tools, sandbox: 'read-only', approvalPolicy: 'never', cwd: home });
  assert.equal(thread.sandbox.type, 'readOnly', '読むだけのサンドボックス');
  assert.equal(thread.sandbox.networkAccess, false, 'サンドボックスからの通信なし');
  assert.equal(thread.approvalPolicy, 'never', '承認を求めない');
  await rpc('turn/start', { threadId: thread.thread.id, model, effort: 'medium', input: [{ type: 'text', text: '［画面の今の状態］今日：2026-11-07（土）\n［頼み］\n北加賀屋に 11/20 の玄関ドア搬入を入れて' }] });
  await done;
  clearTimeout(timer);

  assert.ok(requests.length >= 1, '偽のモデルに届いた');
  const first = requests[0];
  assert.equal(first.model, model);
  assert.equal(first.reasoning.effort, 'medium');
  const names = first.tools.map((t) => t.name || t.type).sort();
  const ours = tools.map((t) => t.name).sort();
  assert.deepEqual(names.filter((n) => n !== 'request_user_input'), ours, 'モデルに見える道具は、工程表の道具だけ（' + names.join(', ') + '）');
  assert.ok(!names.includes('web_search'), 'Web 検索は切ってある');
  assert.ok(String(first.instructions || '').includes('取り付け工程表'), 'アプリの指示（baseInstructions）が使われている');
  assert.ok(toolCall && toolCall.tool === 'add_event' && JSON.stringify(toolCall.arguments) === JSON.stringify(toolArgs), '道具の呼び出しが、そのまま画面側へ回る');
  assert.equal(requests.length, 2, '道具の結果のあとに、もう一度モデルへ');
  assert.ok(JSON.stringify(requests[1].input).includes('予定を追加しました'), '道具の結果がモデルに戻る');
  assert.ok(notes.some((v) => v.method === 'item/agentMessage/delta'), '回答の文が少しずつ届く');
  assert.ok(notes.some((v) => v.method === 'turn/completed' && v.params.turn.status === 'completed'), '回答が終わる');
  assert.ok(!notes.some((v) => String(v.method).startsWith('server-request:')), 'ほかの承認・入力の催促は来ない');
  console.log('OK：同梱の Codex（' + (await new Promise((r) => { const p = spawn(binary, ['--version']); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('exit', () => r(o.trim())); })) + '）・読むだけ・承認なし・道具は工程表の ' + ours.length + ' 個だけ（Web 検索なし）・道具の呼び出しと結果・回答の文・回答の終わり');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited; }
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
}
