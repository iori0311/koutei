// Excel（.xlsx）を読む（追加の部品なし）。ZIP はブラウザの展開機能（DecompressionStream）で開き、XML は必要なところだけ読む。
// 読むもの：シートの名前・セルの値（共有文字列・日付）・塗りつぶしの色（テーマ色・色の濃淡・番号の色も RGB に直す）・結合セル・隠れた行と列
// （ふりがな＝<rPh> は読まない）
import { fromYMD, iso } from './dates.js';

// ---- ZIP ----
async function xlInflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function xlUnzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Excel（.xlsx）のファイルではありません');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map(), dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Excel のファイルが壊れています');
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    entries.set(dec.decode(u8.subarray(off + 46, off + 46 + nlen)), { method, csize, lho });
    off += 46 + nlen + xlen + clen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(data);
      if (e.method === 8) return dec.decode(await xlInflate(data));
      throw new Error('この Excel の圧縮のしかたには対応していません');
    },
  };
}

// ---- XML の小道具（大きなシートでも軽く読めるように、正規表現で必要な要素だけを拾う） ----
function xlUnescape(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'"
      : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
}
function xlAttr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
  return m ? xlUnescape(m[1]) : null;
}
// 文字の部分：<t> を集める（ふりがなの <rPh> は外す）
function xlRichText(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ? xlUnescape(m[1]) : '';
  return out;
}
export function colName(n) { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
export function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }

// ---- 色 ----
const XL_INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];
function xlTint(hex, tint) {
  if (!tint) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (s === 0) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function xlColor(attrs, theme) {
  if (!attrs) return null;
  const rgb = xlAttr(attrs, 'rgb'), th = xlAttr(attrs, 'theme'), ix = xlAttr(attrs, 'indexed'), tint = Number(xlAttr(attrs, 'tint') || 0);
  let hex = null;
  if (rgb) hex = rgb.slice(-6).toUpperCase();
  else if (th != null) hex = theme[Number(th)] || null;
  else if (ix != null) hex = XL_INDEXED[Number(ix)] || null;
  return hex ? xlTint(hex, tint) : null;
}

// ---- 本を開く ----
// 返すもの：{ sheets: [{ name, cell(r, c), maxRow, maxCol, rowHidden(r), colHidden(c), merges: [{ r0, c0, r1, c1 }] }] }
// cell は { v: 値（文字・数・日付の 'YYYY-MM-DD'）, fill: 'RRGGBB' | null }
export async function readXlsx(buf) {
  const zip = xlUnzip(buf);
  const wb = await zip.text('xl/workbook.xml');
  if (!wb) throw new Error('Excel（.xlsx）のファイルではありません');
  const date1904 = /date1904="(1|true)"/.test(wb);
  const rels = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
  const relMap = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [xlAttr(m[1], 'Id'), xlAttr(m[1], 'Target')]));
  // テーマの色（0: 背景 1 … の順に、Excel の決まりで並べ替える）
  const themeXml = (await zip.text('xl/theme/theme1.xml')) || '';
  const scheme = {};
  for (const m of themeXml.matchAll(/<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g)) {
    const c = /srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[2]) || /lastClr="([0-9A-Fa-f]{6})"/.exec(m[2]);
    if (c) scheme[m[1]] = c[1].toUpperCase();
  }
  const theme = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((k) => scheme[k] || null);
  // 共有文字列
  const sst = (await zip.text('xl/sharedStrings.xml')) || '';
  const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xlRichText(m[1]));
  // スタイル：セルの書式 → 塗りつぶしの色・日付かどうか
  const sty = (await zip.text('xl/styles.xml')) || '';
  const sec = (tag) => { const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(sty); return m ? m[1] : ''; };
  const numFmts = new Map([...sec('numFmts').matchAll(/<numFmt\b([^>]*)\/>/g)].map((m) => [Number(xlAttr(m[1], 'numFmtId')), xlAttr(m[1], 'formatCode') || '']));
  const fills = [...sec('fills').matchAll(/<fill>([\s\S]*?)<\/fill>|<fill\/>/g)].map((m) => {
    const body = m[1] || '';
    const pf = /<patternFill\b([^>]*)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(body);
    if (!pf || xlAttr(pf[1], 'patternType') !== 'solid') return null;
    const fg = /<fgColor\b([^>]*)\/>/.exec(pf[2] || '');
    const hex = xlColor(fg && fg[1], theme);
    return hex && hex !== 'FFFFFF' ? hex : null;
  });
  const isDateFmt = (id) => {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
    const code = (numFmts.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[ymdge]/i.test(code) && !/^[#0.,%\s]*$/.test(code);
  };
  const xfs = [...sec('cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map((m) => ({ fill: fills[Number(xlAttr(m[1], 'fillId') || 0)] || null, date: isDateFmt(Number(xlAttr(m[1], 'numFmtId') || 0)) }));
  const serialToIso = (n) => iso(fromYMD(date1904 ? 1904 : 1899, date1904 ? 1 : 12, date1904 ? 1 : 30) + Math.floor(n));

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = xlAttr(m[1], 'name') || 'シート';
    const rid = xlAttr(m[1], 'r:id');
    let target = relMap.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = await zip.text(target);
    if (!xml) continue;
    const rows = new Map(), hiddenRows = new Set(), hiddenCols = new Set();
    let maxRow = 0, maxCol = 0;
    for (const cm of (/<cols>([\s\S]*?)<\/cols>/.exec(xml) || ['', ''])[1].matchAll(/<col\b([^>]*)\/>/g)) {
      if (xlAttr(cm[1], 'hidden') === '1' || xlAttr(cm[1], 'hidden') === 'true') {
        for (let c = Number(xlAttr(cm[1], 'min')); c <= Number(xlAttr(cm[1], 'max')); c++) hiddenCols.add(c);
      }
    }
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(xlAttr(rm[1], 'r'));
      if (!r) continue;
      if (xlAttr(rm[1], 'hidden') === '1' || xlAttr(rm[1], 'hidden') === 'true') hiddenRows.add(r);
      if (!rm[2]) continue;
      const cells = new Map();
      for (const c of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)(\d+)"/.exec(c[1]);
        if (!ref) continue;
        const col = colNum(ref[1]);
        const xf = xfs[Number(xlAttr(c[1], 's') || 0)] || { fill: null, date: false };
        const t = xlAttr(c[1], 't') || 'n';
        const body = c[2] || '';
        let v = null;
        if (t === 'inlineStr') v = xlRichText((/<is>([\s\S]*?)<\/is>/.exec(body) || ['', ''])[1]);
        else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          if (vm) {
            const raw = xlUnescape(vm[1]);
            if (t === 's') v = strings[Number(raw)] ?? '';
            else if (t === 'n') { const n = Number(raw); v = Number.isFinite(n) ? (xf.date && n > 0 && n < 2958466 ? serialToIso(n) : n) : raw; }
            else if (t === 'b') v = raw === '1';
            else v = raw;
          }
        }
        if ((v === null || v === '') && !xf.fill) continue;
        cells.set(col, { v: v === '' ? null : v, fill: xf.fill });
        if (col > maxCol) maxCol = col;
      }
      if (cells.size) { rows.set(r, cells); if (r > maxRow) maxRow = r; }
    }
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)].map((mm) => ({ c0: colNum(mm[1]), r0: Number(mm[2]), c1: colNum(mm[3]), r1: Number(mm[4]) }));
    sheets.push({
      name, maxRow, maxCol, merges,
      cell: (r, c) => (rows.get(r) && rows.get(r).get(c)) || null,
      rowCells: (r) => rows.get(r) || new Map(),
      rowHidden: (r) => hiddenRows.has(r),
      colHidden: (c) => hiddenCols.has(c),
      hiddenRowCount: hiddenRows.size,
    });
  }
  if (!sheets.length) throw new Error('シートが見つかりませんでした');
  return { sheets };
}

// ---- CSV ----（1 行目から、"…" でくくった値・中の改行にも対応）
export function readCsv(text) {
  const rows = new Map();
  let r = 1, c = 1, cur = '', q = false, maxCol = 0;
  const put = () => {
    if (cur !== '') { if (!rows.has(r)) rows.set(r, new Map()); rows.get(r).set(c, { v: /^-?\d+(\.\d+)?$/.test(cur) ? Number(cur) : cur, fill: null }); if (c > maxCol) maxCol = c; }
    cur = '';
  };
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { put(); c++; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; put(); r++; c = 1; }
    else cur += ch;
  }
  put();
  const maxRow = Math.max(0, ...rows.keys());
  return { sheets: [{ name: 'CSV', maxRow, maxCol, merges: [], cell: (rr, cc) => (rows.get(rr) && rows.get(rr).get(cc)) || null, rowCells: (rr) => rows.get(rr) || new Map(), rowHidden: () => false, colHidden: () => false, hiddenRowCount: 0 }] };
}
