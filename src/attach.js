// AI パネルに添付したファイル（Excel・CSV・画像）を読み、AI が道具で取りに来られる形にする（デスクトップ版）
//   ・Excel の工程表（「現場名」「施工業者」の列と、日の列に色を塗って予定を表す形）は、現場ごとの予定に読み解く。
//     年は書いていないことが多いので、月の見出し・1 日の曜日・月の日数・左から右へ時間が進むことから決める
//   ・色は、凡例（色の四角と名前）と工程表の種別（色）に照らして、どの種別かの見当を付ける。土日・祝日の網掛け（見出しと同じ色）は予定に数えない
//   ・読み解けない形でも、セルの値と色をそのまま見せる（attachment_cells）
import { readXlsx, readCsv, colName, colNum } from './xlsx-read.js';
import { store, nameKey } from './store.js';
import { fromYMD, iso, dn, dow, todayDn, ymd } from './dates.js';
import { AgentError } from './agent-ops.js';

const WEEKDAYS = '日月火水木金土';
const MAX_SITES_OUT = 50, MAX_CELLS_OUT = 1500;

function atFail(msg) { throw new AgentError(msg); }
function atText(v) { return typeof v === 'string' ? v.trim() : ''; }
function atDayNum(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : 0;
}
function atDaysIn(y, m) { return fromYMD(y + (m === 12 ? 1 : 0), m === 12 ? 1 : m + 1, 1) - fromYMD(y, m, 1); }
function atMergeAt(sh, r, c) { return sh.merges.find((m) => m.r0 === r && m.c0 === c) || null; }
function atInMerge(sh, r, c) { return sh.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null; }

// ---- 工程表の形を見つけて、現場ごとの予定に読み解く ----
function readGantt(sh) {
  const top = Math.min(sh.maxRow, 40);
  // 1) 見出しの行：「現場」を含む短い文字。施工業者の列は「業者」「施工」「元請」「会社」を含むもの
  let headerRow = 0, nameCol = 0, whoCol = 0;
  for (let r = 1; r <= top && !headerRow; r++) {
    for (const [c, cell] of sh.rowCells(r)) {
      const t = atText(cell.v).replace(/\s/g, '');
      if (t.length <= 12 && /現場|物件|工事名/.test(t)) { headerRow = r; nameCol = c; break; }
    }
  }
  if (!headerRow) return null;
  for (const [c, cell] of sh.rowCells(headerRow)) {
    const t = atText(cell.v).replace(/\s/g, '');
    if (c !== nameCol && t.length <= 12 && /業者|施工|元請|会社/.test(t)) { whoCol = c; break; }
  }
  const leftEnd = Math.max(nameCol, whoCol);
  // 2) 日の行：見出しの行の前後で、1〜31 の数がいちばん多い行
  let dayRow = 0, best = 0;
  for (let r = Math.max(1, headerRow - 3); r <= Math.min(sh.maxRow, headerRow + 3); r++) {
    let n = 0;
    for (const [c, cell] of sh.rowCells(r)) if (c > leftEnd && atDayNum(cell.v)) n++;
    if (n > best) { best = n; dayRow = r; }
  }
  if (best < 28) return null;
  // 3) 月のかたまり（日が 1 のところから）。月は上の行の「◯月」、曜日は日の行の上下
  const days = [...sh.rowCells(dayRow)].filter(([c, cell]) => c > leftEnd && atDayNum(cell.v)).sort((a, b) => a[0] - b[0]);
  const starts = days.filter(([, cell]) => atDayNum(cell.v) === 1).map(([c]) => c);
  const blocks = [];
  starts.forEach((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] - 1 : days[days.length - 1][0];
    const dayCols = new Map();
    for (const [c, cell] of days) if (c >= s && c <= e && !dayCols.has(atDayNum(cell.v))) dayCols.set(atDayNum(cell.v), c);
    let month = 0, year = 0, wd = -1;
    for (let r = dayRow - 1; r >= Math.max(1, dayRow - 3) && !month; r--) {
      for (let c = s; c <= e && !month; c++) {
        const t = (atText((sh.cell(r, c) || {}).v) || '').normalize('NFKC');
        const mm = /(\d{1,2})\s*月/.exec(t);
        if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) {
          month = Number(mm[1]);
          const yy = /(\d{4})\s*年/.exec(t);
          if (yy) year = Number(yy[1]);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { month = Number(t.slice(5, 7)); year = Number(t.slice(0, 4)); }
      }
    }
    for (const r of [dayRow + 1, dayRow - 1, dayRow + 2, dayRow - 2]) {
      const t = atText((sh.cell(r, s) || {}).v);
      if (t.length === 1 && WEEKDAYS.includes(t)) { wd = WEEKDAYS.indexOf(t); break; }
    }
    blocks.push({ s, e, n: Math.max(...dayCols.keys()), dayCols, month, year, wd });
  });
  const usable = blocks.filter((b) => b.month);
  if (!usable.length) return null;
  // 4) 年：かたまりごとに候補（曜日と日数が合う年）を出し、左から右へ時間が進む（1〜12 か月ずつ）並びのうち、終わりが今に近いものを選ぶ
  const last = usable.length - 1;
  const cands = usable.map((b, i) => {
    if (b.year) return [b.year];
    const out = [];
    for (let y = 2000; y <= 2099; y++) {
      const len = atDaysIn(y, b.month);
      if (i === last ? b.n > len : b.n !== len) continue;
      if (b.wd >= 0 && dow(fromYMD(y, b.month, 1)) !== b.wd) continue;
      out.push(y);
    }
    return out;
  });
  const stepTo = cands.map(() => new Map());   // 年 → [ここまでの間の合計, 前の年]
  for (const y of cands[0]) stepTo[0].set(y, [0, null]);
  for (let i = 1; i < usable.length; i++) {
    for (const y of cands[i]) {
      const cur = y * 12 + usable[i].month;
      for (const [py, [cost]] of stepTo[i - 1]) {
        const gap = cur - (py * 12 + usable[i - 1].month);
        if (gap >= 1 && gap <= 12 && (!stepTo[i].has(y) || cost + gap < stepTo[i].get(y)[0])) stepTo[i].set(y, [cost + gap, py]);
      }
    }
  }
  if (!stepTo[last].size) return null;
  const t = ymd(todayDn()), now = t.y * 12 + t.m;
  let y = [...stepTo[last].keys()].sort((a, b) => Math.abs(a * 12 + usable[last].month - now) - Math.abs(b * 12 + usable[last].month - now))[0];
  for (let i = last; i >= 0; i--) { usable[i].year = y; y = stepTo[i].get(y)[1]; }
  // 5) 列 → 日付。見出しの色（土日・祝日の網掛け）は予定に数えない
  const dateOf = new Map(), bg = new Map();
  for (const b of usable) for (const [d, c] of b.dayCols) if (d <= atDaysIn(b.year, b.month)) dateOf.set(c, fromYMD(b.year, b.month, d));
  const wdRow = [dayRow + 1, dayRow - 1].find((r) => [...sh.rowCells(r)].some(([, cell]) => atText(cell.v).length === 1 && WEEKDAYS.includes(atText(cell.v)))) || 0;
  for (const c of dateOf.keys()) {
    const set = new Set([(sh.cell(dayRow, c) || {}).fill, wdRow ? (sh.cell(wdRow, c) || {}).fill : null].filter(Boolean));
    bg.set(c, set);
  }
  const cols = [...dateOf].sort((a, b) => a[1] - b[1]);
  // 6) 凡例：見出しより上の行で、色の付いたセルのすぐ右（4 列以内）にある文字。月ごとに凡例を書き直していることがあるので、
  //    色ごとにいちばん多く出てくる名前にする（となりの文字のはみ出しや、途中で名前を変えたものに引っぱられないように）
  const legendCount = new Map();
  for (let r = 1; r < Math.min(headerRow, dayRow); r++) {
    for (const [c, cell] of sh.rowCells(r)) {
      if (!cell.fill) continue;
      for (let k = 1; k <= 4; k++) {
        const txt = atText((sh.cell(r, c + k) || {}).v).replace(/\s+/g, ' ');
        if (!txt) continue;
        if (!/^\d{1,2}\s*月$/.test(txt.normalize('NFKC'))) {
          const m = legendCount.get(cell.fill) || new Map();
          m.set(txt, (m.get(txt) || 0) + 1);
          legendCount.set(cell.fill, m);
        }
        break;
      }
    }
  }
  const legend = new Map(), legendAlt = new Map();
  for (const [fill, m] of legendCount) {
    const sorted = [...m].sort((a, b) => b[1] - a[1]);
    legend.set(fill, sorted[0][0]);
    const alt = sorted.slice(1).filter(([, n]) => n >= 5).map(([t]) => t);
    if (alt.length) legendAlt.set(fill, alt);
  }
  // 7) 縦の網掛け：同じ日の列で、データの行の半分以上が同じ色なら背景（祝日など、見出しと違う色で塗った日もある）
  const first = Math.max(headerRow, dayRow, wdRow) + 1;
  const dataRows = Math.max(1, sh.maxRow - first + 1);
  const band = new Map();
  for (let r = first; r <= sh.maxRow; r++) {
    for (const [c, cell] of sh.rowCells(r)) {
      if (!cell.fill || !dateOf.has(c)) continue;
      let m = band.get(c);
      if (!m) { m = new Map(); band.set(c, m); }
      m.set(cell.fill, (m.get(cell.fill) || 0) + 1);
    }
  }
  for (const [c, m] of band) for (const [fill, n] of m) if (n >= Math.max(5, dataRows * 0.5)) bg.get(c).add(fill);
  // 日の見出しで網掛けに使っている色（凡例の色でないもの）は、どこにあっても背景（定休日などを同じ色で塗っていることがある）
  const shade = new Set();
  for (const row of [dayRow, wdRow]) if (row) for (const [c, cell] of sh.rowCells(row)) if (c > leftEnd && cell.fill && !legend.has(cell.fill)) shade.add(cell.fill);
  for (const set of bg.values()) for (const f of shade) set.add(f);
  // 8) 現場：現場名のセル（結合していればその行まで）。現場名のない行は、上の現場のつづき
  const sites = [];
  let cur = null;
  for (let r = first; r <= sh.maxRow; r++) {
    const nameCell = sh.cell(r, nameCol);
    const inPrev = cur && r <= cur.r1;
    const name = atText(nameCell && nameCell.v);
    if (name && !inPrev) {
      const mg = atMergeAt(sh, r, nameCol);
      const who = whoCol ? atText((sh.cell(r, whoCol) || {}).v) : '';
      cur = { r0: r, r1: mg ? mg.r1 : r, name: String(nameCell.v).trim(), contractor: who };
      sites.push(cur);
    } else if (cur && !inPrev && !name && !atInMerge(sh, r, nameCol)) {
      cur.r1 = r;   // 結合していない書き方：現場名のない行は上の現場のつづき
    }
  }
  const unknownColors = new Map();
  for (const site of sites) {
    site.hidden = true;
    for (let r = site.r0; r <= site.r1; r++) if (!sh.rowHidden(r)) { site.hidden = false; break; }
    // 色の付いたセルが続くところを予定にする（段ごと）。文字のセルは、あとで近くの予定の内容にする
    const runs = [], texts = [];
    for (let r = site.r0; r <= site.r1; r++) {
      let run = null;
      for (const [c, d] of cols) {
        const cell = sh.cell(r, c);
        const fill = cell && cell.fill && !bg.get(c).has(cell.fill) ? cell.fill : null;
        if (fill && run && run.color === fill && run.end === d - 1) run.end = d;
        else if (fill) { run = { r, start: d, end: d, color: fill, texts: [] }; runs.push(run); }
        else run = null;
        const txt = cell && typeof cell.v === 'string' ? cell.v.trim() : '';
        if (txt && !(txt.length === 1 && WEEKDAYS.includes(txt))) {
          const mg = atMergeAt(sh, r, c);
          const endD = mg && dateOf.get(mg.c1) ? dateOf.get(mg.c1) : d;
          texts.push({ r, d, endD, txt: txt.replace(/\s*\n\s*/g, ' ') });
        }
      }
    }
    // 文字は、同じ現場の予定のうち、日がいちばん近いもの（重なっていれば 0 日・2 日まで）、次に段がいちばん近いものの内容にする。
    // 近くに予定がなければ「色なし」の予定にする（メモとして書いたもの）
    const colored = runs.slice();
    for (const tx of texts) {
      let target = null, bestScore = Infinity;
      for (const x of colored) {
        const dist = tx.endD < x.start ? x.start - tx.endD : tx.d > x.end ? tx.d - x.end : 0;
        if (dist > 2) continue;
        const score = dist * 100 + Math.abs(x.r - tx.r);
        if (score < bestScore) { bestScore = score; target = x; }
      }
      if (target) target.texts.push(tx.txt);
      else runs.push({ r: tx.r, start: tx.d, end: Math.max(tx.d, tx.endD), color: null, texts: [tx.txt] });
    }
    site.events = runs.map((x) => {
      if (x.color && !legend.has(x.color)) unknownColors.set(x.color, (unknownColors.get(x.color) || 0) + 1);
      return { start: x.start, end: x.end, color: x.color, label: x.texts.join(' ') };
    });
    site.events.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return {
    headerRow, nameCol, whoCol, dayRow,
    from: cols.length ? cols[0][1] : null, to: cols.length ? cols[cols.length - 1][1] : null,
    legend, legendAlt, unknownColors, sites,
    months: usable.map((b) => b.year + '-' + String(b.month).padStart(2, '0')),
  };
}

// 凡例にない色が、凡例の色や工程表の種別の色にとても近いとき、その名前（打ち間違えたような色。最後は人が決める）
function atNearColor(color, legend) {
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(color);
  let best = null, bestD = 48;
  const pool = [...legend].map(([c, label]) => [c, label]).concat(store.state.categories.filter((c) => !c.memo).map((c) => [c.color.toUpperCase(), c.name]));
  for (const [c, label] of pool) {
    const [r2, g2, b2] = rgb(c);
    const d = Math.hypot(r - r2, g - g2, b - b2);
    if (d < bestD) { bestD = d; best = label + '（#' + c + '）'; }
  }
  return best;
}
// 色・凡例の名前から、工程表の種別の見当を付ける（色がそっくり同じか、名前が同じもの）
function atCategoryFor(color, legendName) {
  const cats = store.state.categories;
  if (!color) return (cats.find((c) => c.memo) || {}).name || null;
  const byColor = cats.find((c) => !c.memo && c.color.toUpperCase() === color);
  if (byColor) return byColor.name;
  if (legendName) { const k = nameKey(legendName); const byName = cats.find((c) => nameKey(c.name) === k); if (byName) return byName.name; }
  return null;
}

// ---- 添付を読む ----
let atSeq = 0;
export async function readAttachment(file) {
  const name = file.name || 'ファイル';
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || ['', ''])[1].toLowerCase();
  const att = { id: 'f' + (++atSeq), name, size: file.size, kind: '', sheets: [], image: null };
  if (/^image\//.test(file.type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    att.kind = 'image';
    att.image = await atImageDataUrl(file);
    return att;
  }
  if (ext === 'xls') throw new Error('古い形式の Excel（.xls）は読めません。Excel で「.xlsx」として保存し直してから添付してください');
  if (ext === 'xlsx' || ext === 'xlsm') {
    att.kind = 'xlsx';
    att.book = await readXlsx(await file.arrayBuffer());
  } else if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || file.type === 'text/csv') {
    att.kind = 'csv';
    att.book = readCsv(await file.text());
  } else {
    throw new Error('読めるのは Excel（.xlsx）・CSV・画像（PNG・JPEG など）です');
  }
  att.sheets = att.book.sheets.map((sh) => ({ sh, gantt: att.kind === 'xlsx' ? readGantt(sh) : null }));
  return att;
}
// 画像は長い辺 2000px までに縮め、JPEG にする（重すぎないように）
async function atImageDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('画像を読めませんでした')); i.src = url; });
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

// 添付の説明（頼みに添えて AI に渡す。中身そのものは道具で取りに来てもらう）
export function attachmentOverview(atts) {
  const lines = ['［添付ファイル］'];
  atts.forEach((a, i) => {
    if (a.kind === 'image') { lines.push((i + 1) + '. 画像「' + a.name + '」（この頼みに画像として付いています）'); return; }
    lines.push((i + 1) + '. 「' + a.name + '」（' + (a.kind === 'csv' ? 'CSV' : 'Excel') + '・シート ' + a.sheets.length + ' 枚）');
    for (const { sh, gantt } of a.sheets) {
      if (!gantt) {
        lines.push('  - シート「' + sh.name + '」：' + sh.maxRow + ' 行 × ' + sh.maxCol + ' 列（工程表の形としては読めませんでした。attachment_cells でセルを読んでください）');
        continue;
      }
      const shown = gantt.sites.filter((s) => !s.hidden);
      const evN = gantt.sites.reduce((n, s) => n + s.events.length, 0);
      lines.push('  - シート「' + sh.name + '」：工程表の形として読めました。現場 ' + gantt.sites.length + ' 件（うち非表示の行の現場 ' + (gantt.sites.length - shown.length) + ' 件）、予定 ' + evN + ' 件、日付 ' + iso(gantt.from) + '〜' + iso(gantt.to) + '（年は月の見出し・1 日の曜日・日数から決めました）');
      const leg = [...gantt.legend].map(([c, label]) => '#' + c + '=' + label + (gantt.legendAlt.has(c) ? '（ほかの名前：' + gantt.legendAlt.get(c).join('・') + '）' : '') + ' → 種別「' + (atCategoryFor(c, label) || '合う種別なし') + '」');
      if (leg.length) lines.push('    凡例：' + leg.join(' / '));
      if (gantt.unknownColors.size) {
        lines.push('    凡例にない色：' + [...gantt.unknownColors].sort((a, b) => b[1] - a[1]).map(([c, n]) => {
          const near = atNearColor(c, gantt.legend);
          return '#' + c + '（' + n + ' 件' + (near ? '・' + near + ' に近い' : '') + '）';
        }).join('、') + '（どの種別にするかは、ユーザーに確かめる）');
      }
    }
  });
  if (atts.some((a) => a.kind !== 'image')) lines.push('Excel・CSV の中身は attachment_sites（現場ごとの予定）と attachment_cells（セルの値と色そのまま）で読めます。');
  return lines.join('\n');
}

// ---- AI が使う道具（読むだけ） ----
const AT_FILE = { type: 'string', description: '添付ファイルの名前（添付が 1 つなら省略できる）' };
const AT_SHEET = { type: 'string', description: 'シートの名前（省略するとすべてのシート）' };
const atSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const ATTACH_TOOLS = [
  {
    name: 'attachment_sites', title: '添付の現場と予定',
    description: '添付した Excel の工程表を、現場ごとの予定に読み解いたものを返す（現場名・施工業者・非表示かどうか・予定の開始日・終了日・色・凡例の名前・種別の見当・内容）。from・to を渡すと、その期間にかかる予定だけ（予定のない現場は返さない）。非表示の行の現場は include_hidden が true のときだけ。多いときは offset・limit で少しずつ読む（limit は 50 まで）。',
    inputSchema: atSchema({
      file: AT_FILE, sheet: AT_SHEET,
      from: { type: 'string', description: 'この日以降にかかる予定だけ（YYYY-MM-DD）' }, to: { type: 'string', description: 'この日以前にかかる予定だけ（YYYY-MM-DD）' },
      include_hidden: { type: 'boolean', description: '非表示の行の現場も返す（ふつうは終わった現場）' },
      query: { type: 'string', description: '現場名・施工業者に含まれる文字' },
      offset: { type: 'integer', description: '何件目から（0 から）' }, limit: { type: 'integer', description: '何件まで（50 まで。省略すると 20）' },
    }),
  },
  {
    name: 'attachment_cells', title: '添付のセル',
    description: '添付した Excel・CSV のセルの値と塗りつぶしの色を、範囲を決めてそのまま返す（1 回 1,500 セルまで）。工程表の形として読めなかったときや、読み解き方を確かめたいときに使う。',
    inputSchema: atSchema({ file: AT_FILE, sheet: AT_SHEET, range: { type: 'string', description: 'セルの範囲（例：A1:Z40）' } }, ['range']),
  },
];

let atCurrent = [];   // 今の会話の添付（ai-panel.js が渡す）
export function setAttachments(list) { atCurrent = list; }

function atPickFile(name) {
  const books = atCurrent.filter((a) => a.kind !== 'image');
  if (!books.length) atFail('Excel・CSV の添付がありません');
  if (!name) { if (books.length === 1) return books[0]; atFail('添付が ' + books.length + ' つあります。file で名前を指定してください：' + books.map((a) => a.name).join('、')); }
  return books.find((a) => a.name === name) || books.find((a) => nameKey(a.name).includes(nameKey(name))) || atFail('添付「' + name + '」がありません');
}
function atDateArg(v, label) {
  if (v == null) return null;
  const n = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? dn(v.trim()) : NaN;
  if (!Number.isFinite(n)) atFail(label + 'は YYYY-MM-DD で指定してください');
  return n;
}
export function runAttachTool(name, args) {
  const a = args == null ? {} : args;
  const tool = ATTACH_TOOLS.find((t) => t.name === name);
  if (!tool) atFail('道具「' + name + '」はありません');
  const extra = Object.keys(a).filter((k) => !(k in tool.inputSchema.properties));
  if (extra.length) atFail('決まっていない項目は受け取れません: ' + extra.join(', '));
  const att = atPickFile(a.file);
  const sheets = att.sheets.filter((x) => !a.sheet || x.sh.name === a.sheet);
  if (!sheets.length) atFail('シート「' + a.sheet + '」がありません。シート：' + att.sheets.map((x) => x.sh.name).join('、'));
  if (name === 'attachment_sites') {
    const from = atDateArg(a.from, 'from'), to = atDateArg(a.to, 'to');
    const q = a.query ? nameKey(String(a.query)) : '';
    const offset = Math.max(0, Number.isInteger(a.offset) ? a.offset : 0);
    const limit = Math.min(MAX_SITES_OUT, Math.max(1, Number.isInteger(a.limit) ? a.limit : 20));
    const rows = [];
    for (const { sh, gantt } of sheets) {
      if (!gantt) continue;
      for (const s of gantt.sites) {
        if (s.hidden && !a.include_hidden) continue;
        if (q && !nameKey(s.name).includes(q) && !nameKey(s.contractor).includes(q)) continue;
        const evs = s.events.filter((e) => (from == null || e.end >= from) && (to == null || e.start <= to));
        if ((from != null || to != null) && !evs.length) continue;
        const legend = gantt.legend;
        rows.push({
          sheet: sh.name, rows: s.r0 + '〜' + s.r1, hidden: s.hidden, name: s.name, contractor: s.contractor,
          events: evs.map((e) => {
            const lg = e.color ? legend.get(e.color) || null : null;
            return { start: iso(e.start), end: iso(e.end), color: e.color ? '#' + e.color : null, legend: lg, category: atCategoryFor(e.color, lg), label: e.label };
          }),
        });
      }
    }
    if (!sheets.some((x) => x.gantt)) atFail('このファイルは工程表の形として読めませんでした。attachment_cells でセルを読んでください');
    return { file: att.name, total: rows.length, offset, next_offset: offset + limit < rows.length ? offset + limit : null, sites: rows.slice(offset, offset + limit) };
  }
  // attachment_cells
  const m = /^\s*([A-Za-z]{1,3})(\d{1,7})\s*:\s*([A-Za-z]{1,3})(\d{1,7})\s*$/.exec(String(a.range || ''));
  if (!m) atFail('range は A1:Z40 のように指定してください');
  const sh = sheets[0].sh;
  const c0 = colNum(m[1].toUpperCase()), r0 = Number(m[2]), c1 = colNum(m[3].toUpperCase()), r1 = Number(m[4]);
  if (c1 < c0 || r1 < r0) atFail('range の左上と右下が逆です');
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_OUT) atFail('範囲が広すぎます（1 回 ' + MAX_CELLS_OUT + ' セルまで）');
  const out = [];
  for (let r = r0; r <= r1; r++) {
    const cells = [];
    for (let c = c0; c <= c1; c++) {
      const cell = sh.cell(r, c);
      if (cell) cells.push({ ref: colName(c) + r, v: cell.v, fill: cell.fill ? '#' + cell.fill : null, ...(sh.colHidden(c) ? { col_hidden: true } : {}) });
    }
    if (cells.length || sh.rowHidden(r)) out.push({ row: r, ...(sh.rowHidden(r) ? { hidden: true } : {}), cells });
  }
  return { file: att.name, sheet: sh.name, size: sh.maxRow + ' 行 × ' + sh.maxCol + ' 列', rows: out };
}
