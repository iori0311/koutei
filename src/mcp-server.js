// エージェント用の MCP サーバー（標準入出力でやりとりする。追加パッケージなし）
//   node 取り付け工程表_mcp.mjs <保存データの .json>
// Claude のデスクトップアプリや自前のエージェントから、取り付け工程表の保存データ（JSON）を決まった操作だけで読み書きする。
// アプリ本体（HTML）には触らない。
//   ・書き換えるたびに、前の中身を「<ファイル名>_控え」フォルダに残す（新しいものから 30 個）
//   ・一時ファイルに書いてから置き換えるので、途中で読まれても壊れない
//   ・読んでから書くまでのあいだに画面側が保存していたら、読み直してやり直す
import { readFile, writeFile, rename, stat, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, basename, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { deserialize, serialize } from './store.js';
import { AGENT_TOOLS, AgentError, runAgentTool } from './agent-ops.js';

const SERVER_INFO = { name: 'torituke-koutei', title: '取り付け工程表', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const KEEP_BACKUPS = 30;
const INSTRUCTIONS = [
  '取り付け工程表（現場ごとの取り付けの予定）の保存データを読み書きするツールです。',
  '変える前に list_sites・list_events で今の中身を確かめてください。日付は YYYY-MM-DD です。',
  'ピンで固定した予定（pinned: true）は、日付の変更も削除もできません。種別（凡例）とビューは読むだけです。',
  '施工業者は 1 行に 1 社です。変更は画面（取り付け工程表.html）にすぐ反映され、画面の「元に戻す」で取り消せます。',
].join('\n');

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }

let dataFile = '';
function log(...a) { process.stderr.write('[取り付け工程表 MCP] ' + a.join(' ') + '\n'); }
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

// ---- 保存データの読み書き ----
async function loadData() {
  const raw = await readFile(dataFile, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new AgentError('保存データが JSON として読めません（' + e.message + '）'); }
  let st;
  try { st = deserialize(obj); } catch (e) { throw new AgentError(e.message); }
  const s = await stat(dataFile);
  return { st, raw, stamp: s.mtimeMs + ':' + s.size };
}
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
async function backup(raw) {
  const dir = join(dirname(dataFile), basename(dataFile, extname(dataFile)) + '_控え');
  await mkdir(dir, { recursive: true });
  const t = new Date();
  const name = t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds()) + '-' + pad(t.getMilliseconds(), 3) + '.json';
  await writeFile(join(dir, name), raw);
  const files = (await readdir(dir)).filter((f) => /^\d{8}-\d{6}-\d{3}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) await unlink(join(dir, f)).catch(() => {});
}
async function readTool(name, args) {
  const { st } = await loadData();
  return runAgentTool(st, name, args).result;
}
async function writeTool(name, args) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { st, raw, stamp } = await loadData();
    const { result } = runAgentTool(st, name, args);
    const tmp = join(dirname(dataFile), '.' + basename(dataFile) + '.' + process.pid + '.tmp');
    await writeFile(tmp, JSON.stringify(serialize(st)));
    const s = await stat(dataFile);
    if (s.mtimeMs + ':' + s.size !== stamp) { await unlink(tmp).catch(() => {}); continue; }   // 画面側が保存した：読み直してやり直す
    await backup(raw);
    await rename(tmp, dataFile);
    return result;
  }
  throw new AgentError('画面側から続けて保存されていて、書き込めませんでした。少し待ってから、もう一度試してください');
}

// ---- MCP（JSON-RPC 2.0） ----
function toolInfo(t) {
  const info = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema };
  info.annotations = { title: t.title, readOnlyHint: !!t.readOnly, openWorldHint: false, ...(t.annotations || {}) };
  return info;
}
async function callTool(params) {
  const name = params && params.name;
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, 'Unknown tool: ' + name);
  try {
    const result = tool.readOnly ? await readTool(name, params.arguments) : await writeTool(name, params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (e) {
    if (e instanceof AgentError) return { content: [{ type: 'text', text: e.message }], isError: true };
    log('ツールの実行中にエラー', name, e && e.stack || e);
    return { content: [{ type: 'text', text: '保存データを読み書きできませんでした: ' + (e && e.message || e) }], isError: true };
  }
}
async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const v = params && PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: AGENT_TOOLS.map(toolInfo) };
    case 'tools/call': return callTool(params || {});
    default: throw new RpcError(-32601, 'Method not found: ' + method);
  }
}
async function handle(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;   // こちらからは問い合わせないので、返事は来ない
  if (msg.id === undefined || msg.id === null) return;                              // 通知（notifications/initialized など）は返事をしない
  try {
    send({ jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, msg.params) });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    if (!(e instanceof RpcError)) log('エラー', e && e.stack || e);
    send({ jsonrpc: '2.0', id: msg.id, error: { code, message: String(e && e.message || e) } });
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { log('使い方: node 取り付け工程表_mcp.mjs <保存データの .json>'); process.exit(2); }
  dataFile = resolve(arg);
  // 起動するときにファイルを確かめる（無い・読めないなら、理由を出して終わる）
  try { await loadData(); }
  catch (e) { log('保存データを読めません:', dataFile, '-', e.code === 'ENOENT' ? 'ファイルがありません（画面の「保存」で作ってください）' : e.message); process.exit(1); }
  log('起動しました:', dataFile);
  // 1 行に 1 つのメッセージ。届いた順に 1 つずつ処理する（同じファイルを同時に書かないように）
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(t); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      if (Array.isArray(msg)) { for (const m of msg) await handle(m); } else await handle(msg);
    }).catch((e) => log('エラー', e && e.stack || e));
  });
  rl.on('close', () => { queue.then(() => process.exit(0)); });
}

main();
