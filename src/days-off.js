// 休日の設定（年度ごと）：社内休暇（お盆・年末年始など）と、出社日（土曜出社など）。
// 土日・祝日・社内休暇は休み（画面と印刷で同じうすいオレンジの網掛け）。出社日は、土日・祝日・社内休暇でも休みにしない。
// 年度の 12 か月をカレンダーで並べ、日付を押す・ドラッグすると、その期間を「社内休暇」（休みにする）か「出社日」（出社にする）にする。
// 下の一覧では、名前と日付を直接入れて直せる
import { store, uid } from './store.js';
import { h, openModal, svgIcon, toast } from './ui.js';
import { dn, iso, ymd, fromYMD, daysInMonth, dow, todayDn, validDn, fiscalYear, fiscalRange, fmtYMD, jpHoliday, WD_JA } from './dates.js';

const OFF_NAME_MAX = 40;
const OFF_MAX_DAYS = 366;

// 前の年度の社内休暇を、1 年後の同じ月日にずらしたもの（2/29 は 2/28 に）
export function shiftOffDaysYear(list, years) {
  const shift = (n) => {
    const { y, m, d } = ymd(n);
    return fromYMD(y + years, m, Math.min(d, daysInMonth(y + years, m)));
  };
  return list.map((o) => ({ ...o, start: shift(o.start), end: Math.max(shift(o.start), shift(o.end)) }));
}

// 年度に入る社内休暇（始まりの日で決める）
export function offDaysInYear(list, fy) {
  const [a, b] = fiscalRange(fy);
  return list.filter((o) => o.start >= a && o.start <= b);
}

// 保存する形にそろえる（日付の向き・長さ・名前の長さ・重なった出社日）
export function normalizeDaysOff(offDays, workDays) {
  const off = offDays
    .filter((o) => validDn(o.start))
    .map((o) => {
      const s = o.start, e = validDn(o.end) && o.end >= s ? Math.min(o.end, s + OFF_MAX_DAYS - 1) : s;
      return { id: o.id || uid('h'), name: String(o.name || '').trim().slice(0, OFF_NAME_MAX), start: s, end: e };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const work = [...new Set(workDays.filter(validDn))].sort((a, b) => a - b);
  return { off, work };
}

// ---- カレンダーで入れる・消す（期間 a〜b） ----
// 社内休暇を入れる：重なる社内休暇があれば 1 つにまとめる（名前は、名前のある最初のものを残す）
export function addOffRange(off, a, b) {
  const hit = off.filter((o) => o.end >= a && o.start <= b);
  if (!hit.length) return [...off, { id: uid('h'), name: '', start: a, end: b }];
  const keep = hit.find((o) => o.name) || hit[0];
  const merged = { ...keep, start: Math.min(a, ...hit.map((o) => o.start)), end: Math.max(b, ...hit.map((o) => o.end)) };
  return [...off.filter((o) => !hit.includes(o)), merged];
}
// 社内休暇から a〜b を外す（途中を外したら 2 つに分ける）
export function removeOffRange(off, a, b) {
  const out = [];
  for (const o of off) {
    if (o.end < a || o.start > b) { out.push(o); continue; }
    if (o.start < a) out.push({ ...o, end: a - 1 });
    if (o.end > b) out.push({ ...o, id: o.start < a ? uid('h') : o.id, start: b + 1 });
  }
  return out;
}
// 休みの日（土日・祝日・社内休暇）か。出社日かどうかは見ない
function restingDay(d, off) {
  const w = dow(d);
  return w === 0 || w === 6 || !!jpHoliday(d) || off.some((o) => d >= o.start && d <= o.end);
}
// 出社日を入れる：休みの日だけ（平日はもともと出社なので入れない）
export function addWorkRange(work, off, a, b) {
  const set = new Set(work);
  for (let d = a; d <= b; d++) if (restingDay(d, off)) set.add(d);
  return [...set].sort((x, y) => x - y);
}
// カレンダーで a〜b を塗る。'co'（社内休暇）は休みに、'wk'（出社日）は出社にする（どちらも、もう片方を外す）。
//   社内休暇：出社日を外し、平日が入っていれば社内休暇にする（土日・祝日だけなら、出社日を外すだけ）
//   出社日：社内休暇を外し、それでも休みの日（土日・祝日）を出社日にする
export function paintDays({ off, work }, tool, a, b) {
  if (tool === 'co') {
    let weekday = false;
    for (let d = a; d <= b && !weekday; d++) weekday = dow(d) !== 0 && dow(d) !== 6 && !jpHoliday(d);
    return { off: weekday ? addOffRange(off, a, b) : off, work: work.filter((d) => d < a || d > b) };
  }
  const rest = removeOffRange(off, a, b);
  return { off: rest, work: addWorkRange(work, rest, a, b) };
}

// 年度の 12 か月のカレンダー。押す・ドラッグで期間を選ぶと onRange(a, b)
function yearCalendar(fy, draft, tool, onRange) {
  const co = new Map();
  for (const o of draft.off) for (let d = o.start; d <= Math.min(o.end, o.start + OFF_MAX_DAYS); d++) if (!co.has(d)) co.set(d, o);
  const work = new Set(draft.work);
  const today = todayDn();
  const cal = h('div', { class: 'doff-cal ' + tool });
  for (let k = 0; k < 12; k++) {
    const y = fy + (k >= 9 ? 1 : 0), m = ((k + 3) % 12) + 1;   // 4 月〜12 月、1 月〜3 月
    const first = fromYMD(y, m, 1);
    const grid = h('div', { class: 'doff-mgrid' }, WD_JA.map((w, i) => h('span', { class: 'doff-wd' + (i === 0 || i === 6 ? ' we' : '') }, w)));
    for (let i = 0; i < dow(first); i++) grid.append(h('span'));
    for (let d = first; d < first + daysInMonth(y, m); d++) {
      const w = dow(d), jp = jpHoliday(d), c = co.get(d), isWork = work.has(d);
      const cls = isWork ? 'wk' : c ? 'co' : w === 0 || w === 6 || jp ? 'off' : '';
      const title = [fmtYMD(d) + '（' + WD_JA[w] + '）', jp, c ? '社内休暇' + (c.name ? '（' + c.name + '）' : '') : '', isWork ? '出社日' : ''].filter(Boolean).join(' ');
      grid.append(h('span', { class: 'doff-d ' + cls + (d === today ? ' today' : ''), dataset: { d: String(d) }, title }, ymd(d).d));
    }
    cal.append(h('div', { class: 'doff-month' }, h('div', { class: 'doff-mh' }, h('b', null, m + '月'), h('span', null, y + '年')), grid));
  }
  // 押したところから離したところまでを選ぶ（月をまたいでもよい）
  let from = null, to = null;
  const mark = () => {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    for (const el of cal.querySelectorAll('.doff-d')) { const d = +el.dataset.d; el.classList.toggle('sel', from !== null && d >= lo && d <= hi); }
  };
  const finish = (ok) => {
    if (from === null) return;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    from = to = null;
    cal.classList.remove('painting');
    if (ok) onRange(lo, hi); else mark();
  };
  cal.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.doff-d');
    if (!el || e.button !== 0) return;
    e.preventDefault();
    from = to = +el.dataset.d;
    cal.setPointerCapture(e.pointerId);
    cal.classList.add('painting');
    mark();
  });
  cal.addEventListener('pointermove', (e) => {
    if (from === null) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const el = hit && hit.closest && hit.closest('.doff-d');
    if (el && cal.contains(el) && +el.dataset.d !== to) { to = +el.dataset.d; mark(); }
  });
  cal.addEventListener('pointerup', () => finish(true));
  cal.addEventListener('pointercancel', () => finish(false));
  return cal;
}

const TOOLS = [['co', '社内休暇'], ['wk', '出社日']];

export function openDaysOffDialog() {
  const st = store.state;
  const draft = { off: st.offDays.map((o) => ({ ...o })), work: [...st.workDays] };
  let fy = fiscalYear(todayDn());
  let tool = 'co';
  const body = h('div', { class: 'doff' });

  // 新しく足すときの日付：今日がその年度なら今日から、ほかの年度ならその年度の始まりから
  const startOf = () => {
    const [a, b] = fiscalRange(fy), t = todayDn();
    return t >= a && t <= b ? t : a;
  };
  const dateInput = (value, min, max, onchange, label) => h('input', {
    type: 'date', class: 'doff-date', value: iso(value), min: iso(min), max: iso(max), 'aria-label': label, required: true,
    onchange: (e) => { const v = dn(e.target.value); if (validDn(v)) onchange(v); else e.target.value = iso(value); },
  });
  // カレンダーで選んだ期間を、選んでいる方（社内休暇・出社日）にする
  const onRange = (a, b) => {
    Object.assign(draft, paintDays(draft, tool, a, b));
    render();
  };

  const render = () => {
    const [a, b] = fiscalRange(fy);
    const offs = offDaysInYear(draft.off, fy).sort((x, y) => x.start - y.start);
    const works = draft.work.filter((d) => d >= a && d <= b);
    const copies = shiftOffDaysYear(offDaysInYear(draft.off, fy - 1), 1).filter((c) => !draft.off.some((o) => o.start === c.start && o.end === c.end));

    const offRows = offs.map((o) => h('div', { class: 'doff-row' },
      h('i', { class: 'doff-chip co' }),
      h('input', { class: 'doff-name', value: o.name, maxlength: OFF_NAME_MAX, placeholder: '名前（例：夏季休暇）', 'aria-label': '社内休暇の名前', oninput: (e) => { o.name = e.target.value; } }),
      dateInput(o.start, a, b, (v) => { o.start = v; if (o.end < v) o.end = v; render(); }, '始まりの日'),
      h('span', { class: 'doff-sep' }, '〜'),
      dateInput(o.end, o.start, o.start + OFF_MAX_DAYS - 1, (v) => { o.end = v; render(); }, '終わりの日'),
      h('span', { class: 'doff-n' }, (o.end - o.start + 1) + ' 日間'),
      h('button', { class: 'icon-btn', type: 'button', title: 'この社内休暇を消す', 'aria-label': 'この社内休暇を消す', onclick: () => { draft.off = draft.off.filter((x) => x !== o); render(); } }, svgIcon('x', 14))));
    const workRows = works.map((d) => h('div', { class: 'doff-row' },
      h('i', { class: 'doff-chip wk' }),
      dateInput(d, a, b, (v) => { draft.work = [...new Set(draft.work.map((x) => (x === d ? v : x)))]; render(); }, '出社日'),
      h('span', { class: 'doff-n' }, '（' + WD_JA[dow(d)] + '）'),
      h('button', { class: 'icon-btn', type: 'button', title: 'この出社日を消す', 'aria-label': 'この出社日を消す', onclick: () => { draft.work = draft.work.filter((x) => x !== d); render(); } }, svgIcon('x', 14))));

    body.replaceChildren(
      h('div', { class: 'doff-year' },
        h('button', { class: 'icon-btn', type: 'button', title: '前の年度', 'aria-label': '前の年度', disabled: fy <= 2000, onclick: () => { fy--; render(); } }, svgIcon('chevL', 16)),
        h('b', null, fy + '年度'), h('span', { class: 'doff-range' }, fy + '年4月〜' + (fy + 1) + '年3月'),
        h('button', { class: 'icon-btn', type: 'button', title: '次の年度', 'aria-label': '次の年度', disabled: fy >= 2098, onclick: () => { fy++; render(); } }, svgIcon('chevR', 16))),
      h('div', { class: 'doff-tools', role: 'group', 'aria-label': 'カレンダーで入れるもの' },
        TOOLS.map(([k, label]) => h('button', {
          class: 'doff-tool' + (tool === k ? ' on' : ''), type: 'button', 'aria-pressed': String(tool === k),
          onclick: () => { tool = k; render(); },
        }, h('i', { class: 'doff-chip ' + k }), label)),
        h('span', { class: 'doff-hint' }, '日付を押すかドラッグすると、その期間に入ります')),
      yearCalendar(fy, draft, tool, onRange),
      h('div', { class: 'doff-legend' },
        h('span', null, h('i', { class: 'doff-chip off' }), '土日・祝日'),
        h('span', null, h('i', { class: 'doff-chip co' }), '社内休暇'),
        h('span', null, h('i', { class: 'doff-chip wk' }), '出社日')),
      h('section', { class: 'doff-sec' },
        h('h3', null, '社内休暇'),
        offRows.length ? h('div', { class: 'doff-list' }, offRows) : h('p', { class: 'doff-empty' }, 'この年度の社内休暇はまだありません'),
        h('div', { class: 'doff-acts' },
          h('button', { class: 'btn', type: 'button', onclick: () => { const s = startOf(); draft.off.push({ id: uid('h'), name: '', start: s, end: s }); render(); } }, svgIcon('plus', 14), '日付で足す'),
          h('button', { class: 'btn', type: 'button', disabled: !copies.length, title: (fy - 1) + '年度の社内休暇を、1 年後の同じ日付で足す', onclick: () => {
            draft.off.push(...copies.map((c) => ({ ...c, id: uid('h') })));
            render();
          } }, (fy - 1) + '年度から写す' + (copies.length ? '（' + copies.length + ' 件）' : '')))),
      h('section', { class: 'doff-sec' },
        h('h3', null, '出社日', h('small', null, '土曜出社など')),
        workRows.length ? h('div', { class: 'doff-list' }, workRows) : h('p', { class: 'doff-empty' }, 'この年度の出社日はありません'),
        h('div', { class: 'doff-acts' },
          h('button', { class: 'btn', type: 'button', onclick: () => {
            // 次の土曜（もう出社日にしている日は飛ばす）
            let d = startOf();
            while ((dow(d) !== 6 || draft.work.includes(d)) && d < b) d++;
            if (!draft.work.includes(d)) draft.work.push(d);
            render();
          } }, svgIcon('plus', 14), '日付で足す'))));
  };

  const save = () => {
    const { off, work } = normalizeDaysOff(draft.off, draft.work);
    store.commit('休日の設定を変更', [
      { kind: 'offDays', id: 'offDays', before: st.offDays, after: off },
      { kind: 'workDays', id: 'workDays', before: st.workDays, after: work },
    ]);
    modal.close();
    toast('休日の設定を保存しました', { action: { label: '元に戻す', fn: () => store.undo() } });
  };
  render();
  const modal = openModal({
    title: '休日の設定', body, className: 'doff-modal',
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'キャンセル'), h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存')],
  });
  return modal;
}

// 凡例の右に置く「休日」のボタン（網掛けの色の説明を兼ねる）
export function daysOffButton() {
  const n = store.state.offDays.length + store.state.workDays.length;
  return h('button', {
    class: 'lg-off', type: 'button',
    title: '土日・祝日・社内休暇の網掛け。押すと、年度ごとに社内休暇と出社日（土曜出社など）を決められます',
    onclick: () => openDaysOffDialog(),
  }, h('i', { class: 'lg-off-chip' }), '休日', n ? h('small', null, '社内休暇・出社日 ' + n + ' 件') : null);
}
