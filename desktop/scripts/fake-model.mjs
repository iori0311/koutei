// アプリ（デバッグ版）と cargo test を、ログインなしで確かめるための偽のモデル（Responses API の形）。127.0.0.1 だけで待ち受ける。
//   node scripts/fake-model.mjs 8799  →  KOUTEI_CODEX_PROBE=http://127.0.0.1:8799/v1 で、アプリ（tauri dev）や cargo test がここにつなぐ
// 1 回目：add_site を呼ぶ → 2 回目：add_event を呼ぶ → 3 回目：まとめの文。道具の結果の数で、今どこかを決める
import { createServer } from 'node:http';
const port = Number(process.argv[2] || 8799);
let n = 0;
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
  const outputs = (body.input || []).filter((x) => x.type === 'function_call_output');
  const step = outputs.length;
  n++;
  process.stderr.write(`[fake-model] request ${n} step ${step} tools=${(body.tools || []).map((t) => t.name || t.type).join(',')}\n`);
  if (outputs.length) process.stderr.write(`[fake-model] last tool output: ${String(outputs[outputs.length - 1].output).slice(0, 200)}\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (events) => { for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n'); res.end(); };
  const call = (name, args) => {
    const item = { type: 'function_call', id: 'f' + n, call_id: 'call_' + n, name, arguments: JSON.stringify(args) };
    send([{ type: 'response.created', response: { id: 'r' + n } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r' + n, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  };
  if (step === 0) return call('add_site', { name: '（仮称）テスト現場', contractor: 'テスト建設\nテスト工業' });
  if (step === 1) return call('add_event', { site: '（仮称）テスト現場', start: '2026-11-20', end: '2026-11-21', category: '玄関ドア搬入', label: '玄関ドア搬入（2〜6階）' });
  const text = '次のとおり入れました。\n- **（仮称）テスト現場** を追加（施工業者：テスト建設・テスト工業）\n- 11/20(金)〜11/21(土) 玄関ドア搬入「玄関ドア搬入（2〜6階）」';
  const item = { id: 'a' + n, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
  send([{ type: 'response.created', response: { id: 'r' + n } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r' + n, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
}).listen(port, '127.0.0.1', () => process.stderr.write(`[fake-model] listening on 127.0.0.1:${port}\n`));
