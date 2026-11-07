// デスクトップ版の AI パネル：ChatGPT でログインした Codex に、現場・予定の確認や追加・変更を頼める
//   ・Codex はアプリ（Rust）が起動する。ここからは Tauri のコマンドで頼み、途中の文字・道具の呼び出しを受け取る
//   ・Codex が使える道具は、エージェント用と同じ 9 つ（agent-ops.js）。このページの今のデータにかけるので、
//     変えたものはすぐ画面に出て、「元に戻す」で取り消せる。ピンの予定は動かせない
//   ・パネルはカレンダーの上に重ねて出す（開いても、カレンダーの幅は変えない）
//   ・ファイル（Excel・CSV・画像）を添付できる。Excel・CSV はこのページで読み、AI は道具（attachment_sites など）で中身を取りに来る。
//     画像はそのまま AI に渡す。今まで Excel で管理していた工程表を、こちらへ移すときに使う
import { store, serialize, deserialize, mergeFromFile } from './store.js';
import { AGENT_TOOLS, AgentError, runAgentTool } from './agent-ops.js';
import { ATTACH_TOOLS, readAttachment, attachmentOverview, runAttachTool, setAttachments } from './attach.js';
import { h, svgIcon, toast } from './ui.js';
import { dn, iso, todayDn, WD_JA, dow, fmtMDW } from './dates.js';
import { overviewRange } from './gantt-web.js';

const aiState = {
  open: false, el: null, log: null, input: null, sendBtn: null, statusEl: null, loginBox: null, filesEl: null, fileInput: null,
  conn: null,            // { connected, authenticated, email, message }
  connecting: false, waitingLogin: false, running: false,
  files: [],             // 添付 [{ key, name, state: 'loading'|'ready'|'error', att, error, sent }]
};
const AI_OPEN_KEY = 'koutei-gantt/ai-open';
const AI_EXAMPLES = ['来週の予定を一覧にして', '11月の検査の予定を教えて', 'サッシ搬入の予定を、全部 2 日後ろにずらして'];
const AI_READING = { list_sites: '現場の一覧を見ています', list_events: '予定を確かめています', list_categories: '種別を確かめています', attachment_sites: '添付の現場と予定を読んでいます', attachment_cells: '添付のセルを読んでいます' };
const AI_ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.png,.jpg,.jpeg,.webp,.gif';

function aiCore() { return window.__TAURI__.core; }

// ---- 上のボタン ----
export function aiButton() {
  return h('button', {
    class: 'btn ai-toggle' + (aiState.open ? ' on' : ''), type: 'button', 'aria-pressed': aiState.open ? 'true' : 'false',
    title: 'AI に頼む（ChatGPT でログインした Codex）', onclick: () => setAiOpen(!aiState.open),
  }, svgIcon('spark'), 'AI');
}

export function initAiPanel() {
  const statusEl = h('span', { class: 'ai-status' });
  const log = h('div', { class: 'ai-log', 'aria-live': 'polite' });
  const input = h('textarea', {
    class: 'ai-input', rows: 2, placeholder: '例）（現場名）に 11/20 の玄関ドア搬入を入れて', 'aria-label': 'AI に頼むこと',
    oninput: () => { aiGrow(); aiSendState(); }, onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!aiState.running) sendAi(); }
    },
  });
  const sendBtn = h('button', { class: 'btn primary ai-send', type: 'button', onclick: () => (aiState.running ? stopAi() : sendAi()) });
  const loginBox = h('div', { class: 'ai-login' });
  const filesEl = h('div', { class: 'ai-files', hidden: true });
  const fileInput = h('input', { type: 'file', multiple: true, accept: AI_ACCEPT, hidden: true, onchange: (e) => { aiAddFiles([...e.target.files]); e.target.value = ''; } });
  const clipBtn = h('button', { class: 'icon-btn ai-clip', type: 'button', title: 'ファイルを添付（Excel・CSV・画像）', 'aria-label': 'ファイルを添付', onclick: () => fileInput.click() }, svgIcon('clip', 17));
  const el = h('aside', { class: 'ai-pane', 'aria-label': 'AI に頼む', hidden: true },
    h('div', { class: 'ai-head' },
      h('div', { class: 'ai-title' }, svgIcon('spark', 15), h('b', null, 'AI に頼む'), statusEl),
      h('div', { class: 'ai-head-btns' },
        h('button', { class: 'icon-btn', type: 'button', title: '新しい会話', 'aria-label': '新しい会話', onclick: newAiChat }, svgIcon('plus')),
        h('button', { class: 'icon-btn', type: 'button', title: '閉じる', 'aria-label': '閉じる', onclick: () => setAiOpen(false) }, svgIcon('x')))),
    log, loginBox, filesEl,
    h('div', { class: 'ai-compose' }, clipBtn, input, sendBtn, fileInput));
  Object.assign(aiState, { el, log, input, sendBtn, statusEl, loginBox, filesEl, fileInput });
  // パネルにファイルを落としても添付できる
  el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); aiAddFiles([...(e.dataTransfer?.files || [])]); });
  // パネルの外に落としたファイルは受け取らない（画面がそのファイルの表示に切り替わってしまわないように）
  window.addEventListener('dragover', (e) => { if (!el.contains(e.target) && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  window.addEventListener('drop', (e) => { if (!el.contains(e.target)) e.preventDefault(); });
  document.body.append(el);
  aiWelcome();
  renderAiChrome();
  let wasOpen = false;
  try { wasOpen = localStorage.getItem(AI_OPEN_KEY) === '1'; } catch (e) { /* 覚えられなくてもよい */ }
  if (wasOpen) setAiOpen(true);
}

function setAiOpen(open) {
  aiState.open = open;
  aiState.el.hidden = !open;
  try { localStorage.setItem(AI_OPEN_KEY, open ? '1' : '0'); } catch (e) { /* 覚えられなくてもよい */ }
  if (open) {
    aiConnect();
    requestAnimationFrame(() => aiState.input.focus());
  }
  store.emit('select');   // 上の「AI」ボタンの見た目を合わせる
}

// ---- つなぐ・ログイン ----
async function aiConnect() {
  if (aiState.connecting || (aiState.conn && aiState.conn.connected)) return aiState.conn;
  aiState.connecting = true;
  renderAiChrome();
  try { aiState.conn = await aiCore().invoke('ai_connect'); }
  catch (e) { aiState.conn = null; aiError(String(e)); }
  finally { aiState.connecting = false; renderAiChrome(); }
  return aiState.conn;
}
async function aiLogin() {
  try {
    await aiCore().invoke('ai_login');
    aiState.waitingLogin = true;
    renderAiChrome();
    aiPollLogin(Date.now() + 15 * 60 * 1000);
  } catch (e) { aiError(String(e)); }
}
// ブラウザでのログインが終わったら、自動で気づく（2 秒ごと・15 分まで）
async function aiPollLogin(deadline) {
  if (!aiState.waitingLogin) return;
  try {
    const c = await aiCore().invoke('ai_connect');
    aiState.conn = c;
    if (c.authenticated) { aiState.waitingLogin = false; renderAiChrome(); return; }
  } catch (e) { /* 次でまた確かめる */ }
  if (Date.now() > deadline) {
    aiState.waitingLogin = false;
    renderAiChrome();
    aiError('ログインが終わっていません。もう一度「ChatGPT でログイン」を押してください。');
    return;
  }
  setTimeout(() => aiPollLogin(deadline), 2000);
}
async function aiLogout() {
  try {
    await aiCore().invoke('ai_logout');
    aiState.conn = null;
    await aiConnect();
    toast('ログアウトしました');
  } catch (e) { aiError(String(e)); }
}

// パネルの上（ログインの状態）・ログインの欄・送る欄を、今の状態に合わせる
function renderAiChrome() {
  const c = aiState.conn;
  const ready = !!(c && c.authenticated);
  aiState.statusEl.replaceChildren(
    aiState.connecting ? 'つないでいます…'
      : ready ? h('span', null, c.email || 'ログイン中', h('button', { class: 'ai-link', type: 'button', onclick: aiLogout }, 'ログアウト'))
        : c ? 'ログインしていません' : '');
  aiState.loginBox.replaceChildren();
  if (c && !ready && !aiState.connecting) {
    aiState.loginBox.append(
      h('p', null, 'ChatGPT のアカウントでログインすると、現場や予定のことを頼めます。'),
      aiState.waitingLogin
        ? h('p', { class: 'ai-wait' }, 'ブラウザでログインしてください。終わると、ここが自動で切り替わります。')
        : h('button', { class: 'btn primary', type: 'button', onclick: aiLogin }, 'ChatGPT でログイン'));
  }
  aiState.loginBox.hidden = !aiState.loginBox.childNodes.length;
  aiState.input.disabled = !ready;
  aiSendState();
}
// 送るボタン：アイコンだけ。回答を作っている間は、同じ場所が「止める」（■）になる。送るものがないときは押せない
function aiSendState() {
  const c = aiState.conn, ready = !!(c && c.authenticated);
  const loading = aiState.files.some((f) => f.state === 'loading');
  const something = !!aiState.input.value.trim() || aiState.files.some((f) => f.state === 'ready' && !f.sent);
  const b = aiState.sendBtn;
  b.disabled = aiState.running ? false : !ready || loading || !something;
  b.replaceChildren(svgIcon(aiState.running ? 'stop' : 'send', 16));
  b.title = aiState.running ? '止める' : '送る（Enter）';
  b.setAttribute('aria-label', aiState.running ? '止める' : '送る');
  b.classList.toggle('stop', aiState.running);
}

// ---- 会話 ----
function aiWelcome() {
  aiState.log.replaceChildren(h('div', { class: 'ai-welcome' },
    h('p', null, '工程表のことを、ふだんの言葉で頼めます。変えたものはすぐ画面に出て、「元に戻す」で取り消せます。'),
    h('div', { class: 'ai-examples' }, AI_EXAMPLES.map((t) => h('button', {
      class: 'ai-example', type: 'button', onclick: () => { aiState.input.value = t; aiGrow(); aiSendState(); aiState.input.focus(); },
    }, t)))));
}
async function newAiChat() {
  if (aiState.running) { toast('回答が終わるか、止めてから始め直してください'); return; }
  try { await aiCore().invoke('ai_reset'); } catch (e) { aiError(String(e)); return; }
  aiState.files = [];
  aiFilesChanged();
  aiWelcome();
  aiState.input.focus();
}

// ---- 添付 ----
// 読むのはこのページの中（ファイルをどこかへ送るのは、頼みを送ったときだけ）
async function aiAddFiles(list) {
  for (const file of list) {
    if (aiState.files.length >= 6) { toast('添付は 6 つまでです'); break; }
    if (file.size > 50 * 1024 * 1024) { toast('「' + file.name + '」は大きすぎます（50MB まで）'); continue; }
    const f = { key: Math.random().toString(36).slice(2), name: file.name, state: 'loading', att: null, error: '', sent: false };
    aiState.files.push(f);
    aiFilesChanged();
    try { f.att = await readAttachment(file); f.state = 'ready'; }
    catch (e) { f.state = 'error'; f.error = (e && e.message) || String(e); }
    aiFilesChanged();
  }
}
function aiFilesChanged() {
  setAttachments(aiState.files.filter((f) => f.state === 'ready').map((f) => f.att));
  aiState.filesEl.replaceChildren(...aiState.files.map((f) => {
    const g = f.att && f.att.sheets ? f.att.sheets.find((x) => x.gantt) : null;
    const note = f.state === 'loading' ? '読み込んでいます…'
      : f.state === 'error' ? f.error
        : f.att.kind === 'image' ? '画像'
          : g ? '現場 ' + f.att.sheets.reduce((n, x) => n + (x.gantt ? x.gantt.sites.length : 0), 0) + ' 件を読めました'
            : 'シート ' + f.att.sheets.length + ' 枚';
    return h('div', { class: 'ai-file ' + f.state + (f.sent ? ' sent' : ''), title: f.error || f.name },
      svgIcon(f.state === 'error' ? 'x' : 'file', 14),
      h('span', { class: 'ai-file-name' }, f.name),
      h('span', { class: 'ai-file-note' }, note),
      h('button', { class: 'ai-file-x', type: 'button', title: '添付を外す', 'aria-label': f.name + ' の添付を外す', onclick: () => { aiState.files = aiState.files.filter((x) => x !== f); aiFilesChanged(); } }, svgIcon('x', 12)));
  }));
  aiState.filesEl.hidden = !aiState.files.length;
  renderAiChrome();
}
function aiScroll() { aiState.log.scrollTop = aiState.log.scrollHeight; }
function aiGrow() {
  const t = aiState.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}
function aiAdd(el) {
  const w = aiState.log.querySelector('.ai-welcome');
  if (w) w.remove();
  aiState.log.append(el);
  aiScroll();
  return el;
}
function aiError(text) { aiAdd(h('div', { class: 'ai-err', role: 'alert' }, text)); }
function aiAct(kind, text) { aiAdd(h('div', { class: 'ai-act ' + kind }, svgIcon(kind === 'write' ? 'edit' : kind === 'err' ? 'x' : 'spark', 12), h('span', null, text))); }

// 頼みの最初に、今日の日付と画面の状態を付ける（「来週」「今月」などがわかるように）
function aiContext() {
  const t = todayDn(), [from, to] = overviewRange(), v = store.activeView();
  return '［画面の今の状態］今日：' + iso(t) + '（' + WD_JA[dow(t)] + '）／開いているビュー：' + (v ? v.name : 'すべての現場') + '／表示している期間：' + iso(from) + '〜' + iso(to);
}

async function sendAi() {
  const fresh = aiState.files.filter((f) => f.state === 'ready' && !f.sent);
  const text = aiState.input.value.trim() || (fresh.length ? '添付したファイルの中身を見て、工程表に移せるか教えて' : '');
  if (!text || aiState.running) return;
  if (aiState.files.some((f) => f.state === 'loading')) { toast('添付を読み込んでいるところです'); return; }
  const c = await aiConnect();
  if (!c || !c.authenticated) { aiError('先に ChatGPT でログインしてください。'); return; }
  // まだ送っていない添付：説明を頼みに添え、画像はそのまま渡す
  const overview = fresh.length ? '\n\n' + attachmentOverview(fresh.map((f) => f.att)) : '';
  const images = fresh.filter((f) => f.att.kind === 'image').map((f) => f.att.image);
  aiAdd(h('div', { class: 'ai-msg user' }, text, fresh.length ? h('div', { class: 'ai-msg-files' }, fresh.map((f) => h('span', null, svgIcon('file', 12), f.name))) : null));
  for (const f of fresh) f.sent = true;
  aiFilesChanged();
  aiState.input.value = '';
  aiGrow();
  aiState.running = true;
  aiSendState();
  renderAiChrome();
  const bot = aiAdd(h('div', { class: 'ai-msg bot' }, h('span', { class: 'ai-dots' }, '考えています…')));
  const turn = { entries: [] };
  const ch = new (aiCore().Channel)();
  ch.onmessage = (ev) => {
    if (ev.type === 'delta') { aiMarkdown(bot, ev.text || ''); aiScroll(); }
    else if (ev.type === 'tool') aiRunTool(ev.request || {}, turn);
    else if (ev.type === 'error') aiError(ev.text || '回答を作れませんでした。');
    else if (ev.type === 'complete' && ev.status === 'interrupted') aiAct('read', '止めました');
  };
  try { await aiCore().invoke('ai_send', { input: aiContext() + '\n［頼み］\n' + text + overview, images, onEvent: ch }); }
  catch (e) { aiError(String(e)); }
  finally {
    aiState.running = false;
    renderAiChrome();
    if (bot.querySelector('.ai-dots')) bot.remove();
    if (turn.entries.length) aiUndoChip(turn.entries);
    aiScroll();
  }
}
async function stopAi() {
  try { await aiCore().invoke('ai_stop'); } catch (e) { aiError(String(e)); }
}

// ---- 道具：このページの今のデータにかける ----
//   読む道具は写しにかける。変える道具は写しにかけてから、変わったところを 1 つの「元に戻す」にまとめて画面に取り込む
function aiCloneState() { return deserialize(JSON.parse(JSON.stringify(serialize(store.state)))); }
async function aiRunTool(req, turn) {
  let result;
  try {
    const out = aiApplyTool(req.tool, req.arguments, turn);
    result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(out) }] };
  } catch (e) {
    const msg = e instanceof AgentError ? e.message : '道具を動かせませんでした（' + ((e && e.message) || e) + '）';
    aiAct('err', msg);
    result = { success: false, contentItems: [{ type: 'inputText', text: msg }] };
  }
  try { await aiCore().invoke('ai_resolve_tool', { id: req.id, result }); } catch (e) { console.warn(e); }
}
function aiApplyTool(name, args, turn) {
  if (ATTACH_TOOLS.some((t) => t.name === name)) {
    aiAct('read', AI_READING[name] || name);
    return runAttachTool(name, args);
  }
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new AgentError('道具「' + name + '」はありません');
  if (tool.readOnly) {
    aiAct('read', AI_READING[name] || name);
    return runAgentTool(aiCloneState(), name, args).result;
  }
  const base = aiCloneState(), work = aiCloneState();
  const { result } = runAgentTool(work, name, args);
  const { changes } = mergeFromFile(base, work, base);
  if (changes.length) {
    const top = store.history[store.history.length - 1];
    store.commit('AI：' + tool.title, changes);
    const now = store.history[store.history.length - 1];
    if (now && now !== top) turn.entries.push(now);
  }
  aiAct('write', aiDescribe(name, result));
  return result;
}
function aiSpan(e) { return e.start === e.end ? fmtMDW(dn(e.start)) : fmtMDW(dn(e.start)) + '〜' + fmtMDW(dn(e.end)); }
function aiEventText(e) { return e.site + '　' + aiSpan(e) + '　' + e.category + (e.label ? '「' + e.label + '」' : ''); }
function aiDescribe(name, r) {
  const site = (s) => String(s || '').replace(/\s*\n\s*/g, ' ');
  if (name === 'add_event') return '予定を追加：' + aiEventText({ ...r.event, site: site(r.event.site) });
  if (name === 'add_events') return '予定を ' + r.count + ' 件追加：' + site(r.site);
  if (name === 'update_event') return '予定を変更：' + aiEventText({ ...r.event, site: site(r.event.site) });
  if (name === 'delete_event') return '予定を削除：' + aiEventText({ ...r.deleted, site: site(r.deleted.site) });
  if (name === 'add_site') return '現場を追加：' + site(r.site.name);
  if (name === 'update_site') return '現場を変更：' + site(r.site.name);
  if (name === 'delete_site') return '現場を削除：' + site(r.deleted.name) + '（予定 ' + r.deleted.events + ' 件も）';
  return r.message || name;
}
// この回答で変えたものを、まとめて元に戻す（あとから手で変えたものがあれば、そこまで）
function aiUndoChip(entries) {
  const btn = h('button', { class: 'ai-undo', type: 'button' }, svgIcon('undo', 13), 'この回答の変更 ' + entries.length + ' 件を元に戻す');
  btn.addEventListener('click', () => {
    let n = 0;
    while (store.history.length && entries.includes(store.history[store.history.length - 1])) { store.undo(); n++; }
    btn.disabled = true;
    btn.replaceChildren(n ? 'この回答の変更を元に戻しました' : '元に戻せませんでした');
    if (n < entries.length) toast('あとから変えたところがあるので、残りは「元に戻す」で 1 つずつ戻してください', { ms: 6000 });
  });
  aiAdd(btn);
}

// ---- 回答の文：見出し・箇条書き・太字・コードだけを、安全に（HTML として読まずに）組み立てる ----
function aiMarkdown(el, text) {
  el.replaceChildren();
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = /^\s*(?:[-*・•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) {
      if (!list) { list = h('ul'); el.append(list); }
      list.append(h('li', null, aiInline(m[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const hd = /^#{1,4}\s+(.*)$/.exec(line);
    el.append(hd ? h('p', { class: 'ai-h' }, aiInline(hd[1])) : h('p', null, aiInline(line)));
  }
}
function aiInline(s) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? h('strong', null, t.slice(2, -2)) : h('code', null, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
