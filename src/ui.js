// 小さな DOM ヘルパーと共通 UI（モーダル・確認・トースト・ファイル入出力）

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate', 'multiple']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
// null / false / 配列を含む子要素をまとめて入れ替える・追加する
export function fill(el, ...children) { el.replaceChildren(); append(el, children); return el; }
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function svgIcon(name, size = 16) {
  const paths = {
    print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
    plus: 'M12 5v14M5 12h14',
    save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
    folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    redo: 'm15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h3',
    x: 'M6 6l12 12M18 6 6 18',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    chevL: 'm15 6-6 6 6 6', chevR: 'm9 6 6 6-6 6',
    menu: 'M6 9l6 6 6-6',
    pin: 'M8.5 3h7M9.5 3h5v6l3 4h-11l3-4zM12 13v8',
    edit: 'M4 20h4L18.5 9.5l-4-4L4 16zM13.5 6.5l4 4',
    spark: 'M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6zM18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z',
    send: 'M12 19V5M6 11l6-6 6 6',
    stop: 'M7 7h10v10H7z',
    clip: 'M16.5 6.5l-7.8 7.8a2 2 0 0 0 2.8 2.8l8-8a4 4 0 0 0-5.7-5.7l-8 8a6 6 0 0 0 8.5 8.5l6.2-6.2',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', paths[name] || '');
  svg.append(p);
  return svg;
}

// 欄の中で改行する（Shift+Enter、または Excel のセルと同じ Alt+Enter）。改行のキーなら true を返す
export function softBreak(e) {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || !(e.shiftKey || e.altKey)) return false;
  if (e.altKey) {
    // Alt+Enter は textarea が改行を入れないので、ここで入れる（元に戻すも効くように insertText で）
    e.preventDefault();
    const t = e.target;
    if (!document.execCommand('insertText', false, '\n')) {
      t.setRangeText('\n', t.selectionStart, t.selectionEnd, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  return true;
}

// ---- モーダル ----
const modalStack = [];
export function openModal({ title, body, footer, onClose, className }) {
  const close = () => {
    const i = modalStack.indexOf(api);
    if (i >= 0) modalStack.splice(i, 1);
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === api) { e.stopPropagation(); e.preventDefault(); close(); }
  };
  const prevFocus = document.activeElement;
  const box = h('div', { class: 'modal' + (className ? ' ' + className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', title: '閉じる', 'aria-label': '閉じる', onclick: () => close() }, svgIcon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  const api = { el: box, close };
  modalStack.push(api);
  requestAnimationFrame(() => {
    const f = box.querySelector('[autofocus]') || box.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, .modal-foot .btn.primary');
    if (f) f.focus();
  });
  return api;
}
export function isModalOpen() { return modalStack.length > 0; }

export function confirmDialog(message, { title = '確認', ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = openModal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(false) }, cancel),
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => finish(true) }, ok),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

// 選択肢が 3 つ以上ある確認。choices: [{ key, label, primary?, danger? }] → 選んだ key（やめたら null）
export function choiceDialog(message, { title = '確認', choices = [], cancel = 'キャンセル' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = openModal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(null) }, cancel),
        ...choices.map((c) => h('button', { class: 'btn' + (c.primary ? ' primary' : '') + (c.danger ? ' danger' : ''), onclick: () => finish(c.key) }, c.label)),
      ],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
  });
}

// ---- メニュー（ボタンの下に出る小さな一覧） ----
let menuEl = null;
function onMenuDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); } }
export function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('pointerdown', onMenuDocDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
// items: [{ label, hint?, icon?, onClick }] または '-'（区切り線）
export function openMenu(anchor, items) {
  if (menuEl) { closeMenu(); return; }
  const r = anchor.getBoundingClientRect();
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.map((it) => it === '-' ? h('div', { class: 'menu-sep', role: 'separator' })
    : h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closeMenu(); it.onClick(); } },
      it.icon ? svgIcon(it.icon) : h('span', { class: 'menu-ico' }), h('span', null, it.label, it.hint ? h('small', null, it.hint) : null))));
  document.body.append(menuEl);
  const mw = menuEl.offsetWidth;
  menuEl.style.top = r.bottom + 4 + 'px';
  menuEl.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }, 0);
  const first = menuEl.querySelector('.menu-item');
  if (first) first.focus();
}

// ---- トースト ----
let toastEl = null, toastTimer = 0;
export function toast(message, { action, ms = 3800, type = '' } = {}) {
  if (!toastEl) { toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(toastEl); }
  toastEl.className = 'toast show ' + type;
  toastEl.replaceChildren(h('span', null, message));
  if (action) toastEl.append(h('button', { class: 'toast-act', onclick: () => { hideToast(); action.fn(); } }, action.label));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { if (toastEl) toastEl.className = 'toast'; }

// ---- ファイル ----
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: 'display:none' });
    inp.addEventListener('change', () => { resolve(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
