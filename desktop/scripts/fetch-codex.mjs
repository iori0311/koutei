// 同梱する Codex を、openai/codex の GitHub Releases から取ってきて src-tauri/binaries/ に置く。
// 版とハッシュは src-tauri/codex.json に固定している（取ってきたアーカイブと、その中の実行ファイルの両方を確かめる）。
//   node scripts/fetch-codex.mjs                     … この PC の分
//   node scripts/fetch-codex.mjs --target <triple>  … 指定した分（aarch64-apple-darwin・x86_64-apple-darwin・x86_64-pc-windows-msvc）
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const pins = JSON.parse(await readFile(join(dir, 'codex.json'), 'utf8'));
const HOST = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc' };
const at = process.argv.indexOf('--target');
const target = at > 0 ? process.argv[at + 1] : HOST[process.platform + '-' + process.arch];
const pin = pins.targets[target];
if (!pin) throw new Error('この対象の Codex は codex.json にありません：' + target + '（あるのは ' + Object.keys(pins.targets).join('・') + '）');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const out = join(dir, 'binaries', target.includes('windows') ? 'codex.exe' : 'codex');
try {
  if (sha256(await readFile(out)) === pin.sha256) { console.log('Codex ' + pins.version + '（' + target + '）はもう置いてあります'); process.exit(0); }
} catch { /* まだない */ }

const url = 'https://github.com/openai/codex/releases/download/' + pins.tag + '/' + pin.asset;
console.log('取ってきます：' + url);
const res = await fetch(url);
if (!res.ok) throw new Error('Codex を取ってこられませんでした（' + res.status + '）：' + url);
const archive = Buffer.from(await res.arrayBuffer());
if (sha256(archive) !== pin.assetSha256) throw new Error('取ってきた ' + pin.asset + ' のハッシュが codex.json と違います');

// tar.gz の中から実行ファイルを 1 つ取り出す（ustar の見出しだけを読む）
const tar = gunzipSync(archive);
const text = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
let bin = null;
for (let off = 0; off + 512 <= tar.length;) {
  const head = tar.subarray(off, off + 512);
  if (head.every((b) => b === 0)) break;
  const size = parseInt(text(head.subarray(124, 136)).trim() || '0', 8);
  const prefix = text(head.subarray(345, 500));
  const name = (prefix ? prefix + '/' : '') + text(head.subarray(0, 100));
  const type = head[156] === 0 ? '0' : String.fromCharCode(head[156]);
  if (type === '0' && name.replace(/^\.\//, '') === pin.file) { bin = tar.subarray(off + 512, off + 512 + size); break; }
  off += 512 + Math.ceil(size / 512) * 512;
}
if (!bin) throw new Error(pin.asset + ' の中に ' + pin.file + ' がありません');
if (sha256(bin) !== pin.sha256) throw new Error(pin.file + ' のハッシュが codex.json と違います');

await mkdir(dirname(out), { recursive: true });
await writeFile(out + '.part', bin);
await chmod(out + '.part', 0o755);
await rename(out + '.part', out);
console.log('Codex ' + pins.version + '（' + target + '）を ' + out + ' に置きました');
