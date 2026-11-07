// 現場を追加するダイアログと、施工業者の入力欄（前に入れた施工業者から探せる）
import { store, uid, nameKey } from './store.js';
import { h, svgIcon, openModal, toast, softBreak } from './ui.js';

function dlgField(label, control) {
  return h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, label), control);
}

// 現場を 1 件作る（「すべての現場」から）。作った現場の ID を返す。施工業者は候補にもたまる
export function createProperty(f) {
  const st = store.state;
  const pid = uid('p');
  const order = Math.max(0, ...[...st.properties.values()].map((p) => p.order || 0)) + 1;
  const prop = { id: pid, name: f.name.trim(), contractor: (f.contractor || '').trim(), order };
  store.commit('現場を追加', [{ kind: 'property', id: pid, before: null, after: prop }, store.contractorChange(prop.contractor)].filter(Boolean));
  return pid;
}

export function openPropertyDialog() {
  const f = { name: '', contractor: '' };
  const submit = () => {
    if (!f.name.trim()) { nameInput.focus(); toast('現場名を入れてください', { type: 'err' }); return; }
    createProperty(f);
    m.close();
  };
  // 現場名・施工業者は、Shift+Enter（または Alt+Enter）で好きな位置で改行できる。Enter だけなら作成
  const nameInput = h('textarea', { rows: 2, placeholder: '例）（仮称）○○区△△新築工事', autofocus: true, oninput: (e) => { f.name = e.target.value; },
    onkeydown: (e) => { if (softBreak(e)) return; if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } } });
  const body = h('div', { class: 'pdlg' },
    dlgField('現場名（必須）', nameInput),
    dlgField('施工業者', contractorInput({ placeholder: '例）○○建設\n△△工業', onInput: (v) => { f.contractor = v; }, onEnter: submit })));
  const m = openModal({
    title: '現場を追加',
    body,
    footer: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'),
      h('button', { class: 'btn primary', onclick: submit }, '作成する'),
    ],
  });
  return m;
}

// ---------- 施工業者の入力欄：候補（自動でたまった施工業者）から探して選べる ----------
// 打った文字を含むものを、先頭が合うもの → 最近使ったものの順に並べる
function suggestContractors(q) {
  const list = store.state.contractors;
  const nq = nameKey(q);
  if (!nq) return list.slice();
  const hits = [];
  list.forEach((name, i) => {
    const at = nameKey(name).indexOf(nq);
    if (at >= 0) hits.push({ name, i, head: at === 0 });
  });
  hits.sort((a, b) => b.head - a.head || a.i - b.i);
  return hits.map((x) => x.name);
}
// 候補の中の、打った文字と同じところを目立たせる
function markMatch(name, q) {
  const t = q.trim();
  const at = t ? name.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (at < 0) return h('span', null, name);
  return h('span', null, name.slice(0, at), h('mark', null, name.slice(at, at + t.length)), name.slice(at + t.length));
}
function forgetContractor(name) {
  const cur = store.state.contractors;
  store.commit('施工業者の候補から外す', [{ kind: 'contractors', id: 'contractors', before: cur, after: cur.filter((x) => x !== name) }]);
}

// onInput(値): 打つたび・選んだとき／onCommit(値): 確定したとき（選んだ・欄を離れた）／onEnter(入力欄): 候補を選ばずに Enter
// 施工業者は複数行にできる（Shift+Enter・Alt+Enter で改行）ので、入力欄は textarea
export function contractorInput({ value = '', name, placeholder, onInput, onCommit, onEnter } = {}) {
  const input = h('textarea', { value, name, placeholder, rows: 2, autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list', 'aria-multiline': 'true', 'aria-expanded': 'false' });
  const list = h('div', { class: 'combo-list', role: 'listbox' });
  // typed: 欄に入ってから文字を打ったか。打つまでは、今入っている名前に関係なく候補を全部見せる
  let items = [], active = -1, open = false, typed = false;
  // 一覧は画面の一番上に出す（ダイアログやパネルの端で切れないように）
  const place = () => {
    if (!input.isConnected) { close(); return; }
    const r = input.getBoundingClientRect();
    list.style.left = r.left + 'px';
    list.style.top = r.bottom + 4 + 'px';
    list.style.width = r.width + 'px';
  };
  const close = () => {
    if (!open) return;
    open = false;
    list.remove();
    input.setAttribute('aria-expanded', 'false');
    window.removeEventListener('keydown', onKeyCapture, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  };
  const pick = (v) => {
    input.value = v;
    close();
    if (onInput) onInput(v);
    if (onCommit) onCommit(v);
  };
  const render = () => {
    items = typed ? suggestContractors(input.value) : store.state.contractors.slice();
    // 出すものが無い・打った名前そのものしか無いときは閉じる
    if (!items.length || (typed && items.length === 1 && items[0] === input.value.trim())) { close(); return; }
    if (active >= items.length) active = items.length - 1;
    list.replaceChildren(...items.map((v, i) => h('div', {
      class: 'combo-opt' + (i === active ? ' on' : ''), role: 'option', 'aria-selected': i === active ? 'true' : 'false',
      onpointerdown: (e) => { e.preventDefault(); if (!e.target.closest('.combo-del')) pick(v); },
    }, markMatch(v, input.value),
    h('button', { class: 'combo-del', type: 'button', tabindex: -1, title: '候補から外す', 'aria-label': v + 'を候補から外す',
      onpointerdown: (e) => { e.preventDefault(); e.stopPropagation(); forgetContractor(v); render(); } }, svgIcon('x', 11)))));
    if (!open) {
      open = true;
      document.body.append(list);
      input.setAttribute('aria-expanded', 'true');
      window.addEventListener('keydown', onKeyCapture, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }
    place();
    const on = list.querySelector('.combo-opt.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  // 一覧が開いている間の ↑↓・Enter・Esc（ダイアログの Esc より先に受け取る）
  function onKeyCapture(e) {
    if (document.activeElement !== input || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(-1, active - 1); render(); }
    else if (e.key === 'Enter' && active >= 0 && !e.shiftKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); pick(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  input.addEventListener('focus', () => { active = -1; typed = false; render(); });
  input.addEventListener('input', () => { active = -1; typed = true; if (onInput) onInput(input.value); render(); });
  input.addEventListener('blur', close);
  input.addEventListener('change', () => { if (onCommit) onCommit(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (softBreak(e)) return;
    // ↓ で候補を開く（下にまだ行があるときは、ふつうに下の行へ移る）
    if (e.key === 'ArrowDown' && !open && !input.value.slice(input.selectionEnd).includes('\n')) { e.preventDefault(); active = 0; render(); }
    else if (e.key === 'Enter' && onEnter) { e.preventDefault(); close(); onEnter(input); }
  });
  return h('div', { class: 'combo' }, input, h('span', { class: 'combo-caret' }, svgIcon('menu', 14)));
}
