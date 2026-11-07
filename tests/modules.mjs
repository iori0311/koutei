// src/ のファイルどうしの import・export が合っているかを確かめる（build.mjs はつなげるだけなので、ここで見る）
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../src', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const exportsOf = {}, importsOf = {};
for (const f of files) {
  const s = readFileSync(join(dir, f), 'utf8');
  exportsOf[f] = new Set([...s.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)(\w+)/gm)].map((m) => m[1]));
  importsOf[f] = [...s.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+)['"]/gm)].map((m) => ({ names: m[1].split(',').map((x) => x.trim()).filter(Boolean), from: m[2] }));
}
let bad = 0;
const used = new Set();
for (const f of files) for (const imp of importsOf[f]) {
  if (!exportsOf[imp.from]) { console.log(`${f}: imports from missing ${imp.from}`); bad++; continue; }
  for (const n of imp.names) {
    used.add(imp.from + ':' + n);
    if (!exportsOf[imp.from].has(n)) { console.log(`${f}: ${n} is not exported by ${imp.from}`); bad++; }
    // 読み込んだのに使っていない名前
    const s = readFileSync(join(dir, f), 'utf8').replace(/^import.*$/gm, '');
    if (!new RegExp('\\b' + n + '\\b').test(s)) console.log(`${f}: imports ${n} but never uses it`);
  }
}
// platform-desktop.js は、デスクトップ版で platform.js の代わりに入る（main.js が platform.js から読む名前と同じ）
for (const f of files) for (const n of exportsOf[f]) {
  if (f === 'platform-desktop.js') continue;
  const s = readFileSync(join(dir, f), 'utf8').replace(/^export\s+/gm, '');
  const internal = (s.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length > 1;
  if (!used.has(f + ':' + n) && !internal) console.log(`unused export: ${f} ${n}`);
}
console.log('modules: ' + (bad ? `NG ${bad}` : 'imports OK'));
process.exitCode = bad ? 1 : 0;
