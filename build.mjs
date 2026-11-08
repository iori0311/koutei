// src/ のファイルをまとめる。依存パッケージなし。
//   node build.mjs
// 1) 取り付け工程表.html … 本番用（何も入っていない状態から始める）
// 2) 取り付け工程表_サンプル.html … サンプル入り
// 3) 取り付け工程表_mcp.mjs … エージェント用の MCP サーバー（Node.js で動かす。保存データの JSON だけを読み書きする）
// 4) desktop/dist/ … デスクトップ版（Tauri）の画面。AI のパネル付き。あわせて Codex に渡す道具の一覧（desktop/src-tauri/koutei-tools.json）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const ORDER = [
  'dates.js', 'store.js', 'ui.js', 'layout.js', 'month-range.js', 'file-sync.js',
  'data-io.js', 'edit-dialogs.js', 'site-pop.js', 'views.js', 'days-off.js', 'gantt-web.js', 'print.js', 'platform.js', 'main.js',
];
// デスクトップ版：platform.js の代わりに、AI のパネルとアプリでのファイル・印刷を入れる
const DESKTOP_ORDER = ORDER.flatMap((f) => (f === 'platform.js' ? ['agent-ops.js', 'xlsx-read.js', 'attach.js', 'desktop-files.js', 'ai-panel.js', 'desktop-update.js', 'platform-desktop.js'] : [f]));
const MCP_ORDER = ['dates.js', 'store.js', 'agent-ops.js', 'mcp-server.js'];

// ファイルをつなげる。ほかのファイルからの import と export は外す（Node.js の組み込み（node:）の import は先頭に集める）
async function join_(files) {
  const seen = new Map();
  const nodeImports = [];
  let js = '';
  for (const f of files) {
    const src = await readFile(join(root, 'src', f), 'utf8');
    const out = [];
    for (const line of src.split('\n')) {
      if (/^import\s.+from\s+['"]node:[^'"]+['"];?\s*$/.test(line)) { nodeImports.push(line); continue; }
      if (/^import\s.+from\s+['"].+['"];?\s*$/.test(line)) continue;
      if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue;
      const m = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let|var|class)\s+(\w+))/.exec(line);
      if (m) {
        const name = m[1] || m[2];
        if (seen.has(name)) throw new Error('トップレベルの名前が重複しています: ' + name + '（' + seen.get(name) + ' と ' + f + '）');
        seen.set(name, f);
      }
      out.push(line.replace(/^export\s+/, ''));
    }
    js += '\n// ---- ' + f + ' ----\n' + out.join('\n');
  }
  return { js, nodeImports };
}

const { js, nodeImports } = await join_(ORDER);
if (nodeImports.length) throw new Error('HTML に Node.js の import が入っています: ' + nodeImports.join(' / '));
const bundle = '(() => {\n\'use strict\';\n' + js + '\n})();\n';
const css = await readFile(join(root, 'src', 'app.css'), 'utf8');
const tpl = await readFile(join(root, 'src', 'index.html'), 'utf8');
const html = tpl
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => bundle.replace(/<\/script/gi, '<\\/script'));
// 1) 本番用（何も入っていない状態から始める）
await writeFile(join(root, '取り付け工程表.html'), html);
console.log('取り付け工程表.html を作成しました (' + Math.round(html.length / 1024) + ' KB)');

// 2) サンプル入り（src/sample-data.json を埋め込み、本番とは別の保存場所を使う）
const sample = JSON.parse(await readFile(join(root, 'src', 'sample-data.json'), 'utf8'));
const editionJs = 'window.__KG_EDITION__ = ' + JSON.stringify({ key: 'koutei-gantt/sample/v1', label: 'サンプル', sample }).replace(/</g, '\\u003c') + ';';
const sampleHtml = html.replace('<noscript>', () => '<script>' + editionJs + '</script>\n<noscript>');
await writeFile(join(root, '取り付け工程表_サンプル.html'), sampleHtml);
console.log('取り付け工程表_サンプル.html を作成しました (' + Math.round(sampleHtml.length / 1024) + ' KB)');

// 3) エージェント用の MCP サーバー
const mcp = await join_(MCP_ORDER);
const mcpJs = '#!/usr/bin/env node\n// 取り付け工程表：エージェント用の MCP サーバー（build.mjs で作ったファイル。直さずに src/ を直して作り直す）\n'
  + '//   node 取り付け工程表_mcp.mjs <保存データの .json>\n'
  + [...new Set(mcp.nodeImports)].join('\n') + '\n' + mcp.js + '\n';
await writeFile(join(root, '取り付け工程表_mcp.mjs'), mcpJs);
console.log('取り付け工程表_mcp.mjs を作成しました (' + Math.round(mcpJs.length / 1024) + ' KB)');

// 4) デスクトップ版の画面（スクリプトと CSS は別のファイルにする。アプリの CSP で、ほかから読み込めないようにするため）
const desk = await join_(DESKTOP_ORDER);
if (desk.nodeImports.length) throw new Error('デスクトップ版の画面に Node.js の import が入っています');
const deskDir = join(root, 'desktop', 'dist');
await mkdir(deskDir, { recursive: true });
await writeFile(join(deskDir, 'app.js'), '(() => {\n\'use strict\';\n' + desk.js + '\n})();\n');
await writeFile(join(deskDir, 'app.css'), css);
await writeFile(join(deskDir, 'index.html'), '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>取り付け工程表</title>\n<link rel="stylesheet" href="app.css">\n</head>\n<body>\n<script src="app.js"></script>\n</body>\n</html>\n');
// Codex に渡す道具の一覧（MCP サーバーと同じ定義＋添付を読む道具から作る。Codex の道具の形に合わせて、文字か配列かの選択と pattern は外す）
const { AGENT_TOOLS } = await import(pathToFileURL(join(root, 'src', 'agent-ops.js')).href);
const { ATTACH_TOOLS } = await import(pathToFileURL(join(root, 'src', 'attach.js')).href);
const simplify = (s) => {
  if (!s || typeof s !== 'object') return s;
  if (s.anyOf) { delete s.anyOf; s.type = 'string'; s.description = '施工業者。1 行に 1 社（改行で区切る）。空にすると施工業者なし'; }
  delete s.pattern;
  for (const v of Object.values(s.properties || {})) simplify(v);
  if (s.items) simplify(s.items);
  return s;
};
const codexTools = [...AGENT_TOOLS, ...ATTACH_TOOLS].map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: simplify(JSON.parse(JSON.stringify(t.inputSchema))) }));
await writeFile(join(root, 'desktop', 'src-tauri', 'koutei-tools.json'), JSON.stringify(codexTools, null, 1) + '\n');
console.log('desktop/dist（デスクトップ版の画面）と koutei-tools.json（道具 ' + codexTools.length + ' 個）を作成しました');
