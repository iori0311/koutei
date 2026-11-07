// 現場名・施工業者のセルを押すと、その行のすぐ下に出る小さな編集パネル
import { store } from './store.js';
import { h, svgIcon, confirmDialog, toast, softBreak } from './ui.js';
import { contractorInput } from './edit-dialogs.js';

let pop = null;              // { pid, el, nameEl, whoEl }
let closedByTrack = false;   // 行の空いているところを押してパネルを閉じた（そのクリックで予定を作らない）
let closedSamePid = null;    // 開いていた現場の現場名・施工業者を押して閉じた（そのクリックで開き直さない）

export function sitePopPid() { return pop ? pop.pid : null; }
export function sitePopJustClosed() { return closedByTrack; }
export function sitePopClosedFor(pid) { return closedSamePid === pid; }

function anchorOf(pid) {
  return document.querySelector('.o-row[data-pid="' + CSS.escape(pid) + '"] .g-cells');
}

// 開いたら現場名の欄に入る（文字は選ばずに末尾にカーソル。うっかり打っても名前が消えないように）
export function openSitePop(pid) {
  if (pop && pop.pid !== pid) closeSitePop();
  if (!pop) {
    const p = store.state.properties.get(pid);
    if (!p) return;
    build(p);
  }
  const t = pop.nameEl;
  requestAnimationFrame(() => { if (pop && t.isConnected) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } });
}

function build(p) {
  const pid = p.id;
  const nameEl = h('textarea', {
    name: 'name', rows: 2, value: p.name, 'aria-label': '現場名',
    onchange: () => commitName(),
    // Enter で決めて施工業者へ。Shift+Enter（または Alt+Enter）は好きな位置で改行
    onkeydown: (e) => {
      if (softBreak(e)) return;
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        commitName();
        const w = pop.whoEl;
        w.focus();
        w.setSelectionRange(w.value.length, w.value.length);
      }
    },
  });
  const who = contractorInput({ name: 'contractor', value: p.contractor || '', onCommit: (v) => commitWho(v), onEnter: () => closeSitePop() });
  const el = h('div', { class: 'site-pop', role: 'dialog', 'aria-label': '現場名・施工業者' },
    h('button', { class: 'icon-btn sp-close', type: 'button', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: () => closeSitePop() }, svgIcon('x')),
    h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, '現場名'), nameEl),
    h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, '施工業者'), who),
    h('div', { class: 'sp-foot' }, h('button', { class: 'btn small danger-outline', type: 'button', onclick: removeSite }, svgIcon('trash'), 'この現場を削除')));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeSitePop(); }
  });
  pop = { pid, el, nameEl, whoEl: who.querySelector('textarea') };
  document.body.append(el);
  place();
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  store.emit('select');
}

function commitName() {
  if (!pop) return;
  const cur = store.state.properties.get(pop.pid);
  if (!cur) return;
  const v = pop.nameEl.value.trim();
  if (!v) { pop.nameEl.value = cur.name; return; }
  if (v !== cur.name) store.updateProperty(pop.pid, { name: v }, '現場名を変更');
}
// 施工業者を変えたら、候補にもたまる
function commitWho(val) {
  if (!pop) return;
  const cur = store.state.properties.get(pop.pid);
  const v = String(val ?? pop.whoEl.value).trim();
  if (!cur || v === (cur.contractor || '')) return;
  store.updateProperty(pop.pid, { contractor: v }, '施工業者を変更', [store.contractorChange(v)].filter(Boolean));
}

// commit: 閉じる前に、入れかけの内容を確定する
export function closeSitePop(commit = true) {
  if (!pop) return;
  const { el } = pop;
  if (commit) {
    // 入力欄からフォーカスを外して、候補の一覧も閉じる
    if (el.contains(document.activeElement)) document.activeElement.blur();
    commitName();
    commitWho();
  }
  pop = null;
  el.remove();
  document.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
  store.emit('select');
}

// パネルの外を押したら閉じる（施工業者の候補の一覧・確認ダイアログ・お知らせの中は除く）。
//   開いている現場の現場名・施工業者をもう一度押したときは、閉じるだけ。行の空いているところを押して閉じたときは、予定を作らない
function onDocDown(e) {
  if (!pop) return;
  const t = e.target;
  if (!(t instanceof Element) || pop.el.contains(t) || t.closest('.combo-list, .modal-back, .toast')) return;
  const row = t.closest('.o-row');
  closedSamePid = row && row.dataset.pid === pop.pid && t.closest('.g-cells') ? pop.pid : null;
  closedByTrack = !!t.closest('.o-track') && !t.closest('.bar, .o-label');
  window.addEventListener('pointerup', () => setTimeout(() => { closedByTrack = false; closedSamePid = null; }, 0), { once: true, capture: true });
  closeSitePop();
}

async function removeSite() {
  if (!pop) return;
  const pid = pop.pid;
  const p = store.state.properties.get(pid);
  if (!p) return;
  const n = store.eventsOf(pid).length;
  const ok = await confirmDialog('「' + p.name + '」と予定 ' + n + ' 件を削除します。よろしいですか？', { ok: '削除する', danger: true });
  if (!ok) return;
  closeSitePop(false);
  store.deleteProperty(pid);
  toast('現場を削除しました', { action: { label: '元に戻す', fn: () => store.undo() } });
}

// 行のすぐ下（下に入らなければ上）に出す。行がスクロールで見えなくなったら隠す
function place() {
  if (!pop) return;
  const { el } = pop;
  const a = anchorOf(pop.pid);
  const sc = a && a.closest('.g-scroll');
  if (!a || !sc) { el.style.visibility = 'hidden'; return; }
  const r = a.getBoundingClientRect();
  const hdr = sc.querySelector('.g-header');
  const top0 = hdr ? hdr.getBoundingClientRect().bottom : sc.getBoundingClientRect().top;
  const bot0 = sc.getBoundingClientRect().bottom;
  if (r.bottom < top0 + 4 || r.top > bot0 - 4) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = '';
  const w = el.offsetWidth, ht = el.offsetHeight;
  let top = r.bottom + 8, above = false;
  if (top + ht > window.innerHeight - 8 && r.top - 8 - ht >= 8) { top = r.top - 8 - ht; above = true; }
  el.classList.toggle('above', above);
  el.style.top = top + 'px';
  el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + 6)) + 'px';
}

// 画面を描き直したあと：中身を合わせて、位置を直す（現場が消えていたら閉じる）
export function syncSitePop() {
  if (!pop) return;
  const p = store.state.properties.get(pop.pid);
  if (!p) { closeSitePop(false); return; }
  // 施工業者で選んだビューで施工業者を変えると、その現場がビューから外れることがある
  if (!store.viewProperties().some((x) => x.id === p.id)) { closeSitePop(false); return; }
  const ae = document.activeElement;
  if (ae !== pop.nameEl) pop.nameEl.value = p.name;
  if (ae !== pop.whoEl) pop.whoEl.value = p.contractor || '';
  place();
}
