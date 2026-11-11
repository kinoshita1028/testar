const $ = (id) => document.getElementById(id);
const listEl = $('list');

let mode = 'history'; // 'history' | 'vault'
let state = { history: [], vault: [], paused: false };
let toastTimer;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今日 ${hm}`;
  const y = d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${y}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('コピーしました');
}

async function saveToVault(text) {
  const res = await chrome.runtime.sendMessage({ type: 'saveToVault', text });
  if (res && res.ok) toast(res.duplicate ? 'すでに保管庫にあります' : '保管庫に保存しました');
  else toast('保存できませんでした');
}

async function removeItem(key, id) {
  const data = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (data[key] || []).filter((item) => item.id !== id) });
}

function render() {
  $('tab-history').classList.toggle('active', mode === 'history');
  $('tab-vault').classList.toggle('active', mode === 'vault');
  $('tab-history').setAttribute('aria-selected', mode === 'history');
  $('tab-vault').setAttribute('aria-selected', mode === 'vault');
  $('count-history').textContent = `${state.history.length}/100`;
  $('count-vault').textContent = `${state.vault.length}`;
  $('paused').checked = state.paused;
  $('clear').style.visibility = mode === 'history' ? 'visible' : 'hidden';

  const query = $('search').value.trim().toLowerCase();
  const all = state[mode];
  const items = query ? all.filter((item) => item.text.toLowerCase().includes(query)) : all;
  const inVault = new Set(state.vault.map((item) => item.text));

  listEl.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query
      ? '一致する項目がありません'
      : mode === 'history'
        ? 'まだ履歴がありません。テキストをコピーするとここに並びます。'
        : '保管庫は空です。履歴の「★ 保管」ボタンで、ずっと残したいテキストを保存できます。';
    listEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';

    const body = document.createElement('button');
    body.className = 'body';
    body.title = 'クリックでコピー';
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = item.text.length > 600 ? item.text.slice(0, 600) + '…' : item.text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${formatTime(item.time)}・${item.text.length}文字`;
    body.append(text, meta);
    body.addEventListener('click', () => copyText(item.text));

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (mode === 'history') {
      const save = document.createElement('button');
      const saved = inVault.has(item.text);
      save.className = saved ? 'save saved' : 'save';
      save.textContent = saved ? '保管済' : '★ 保管';
      save.title = '保管庫に保存(ずっと残ります)';
      save.addEventListener('click', () => saveToVault(item.text));
      actions.appendChild(save);
    }
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (mode === 'vault' && !confirm('保管庫からこの項目を削除しますか?')) return;
      removeItem(mode, item.id);
    });
    actions.appendChild(del);

    row.append(body, actions);
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

function setMode(next) {
  mode = next;
  listEl.scrollTop = 0;
  chrome.storage.local.set({ lastTab: next });
  render();
}

$('tab-history').addEventListener('click', () => setMode('history'));
$('tab-vault').addEventListener('click', () => setMode('vault'));
$('search').addEventListener('input', render);
$('paused').addEventListener('change', (e) => chrome.storage.local.set({ paused: e.target.checked }));
$('clear').addEventListener('click', () => {
  if (!state.history.length) return;
  if (confirm('履歴をすべて削除しますか?(保管庫は消えません)')) chrome.storage.local.set({ history: [] });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['history', 'vault', 'paused']) {
    if (changes[key]) state[key] = changes[key].newValue ?? (key === 'paused' ? false : []);
  }
  render();
});

chrome.storage.local.get(['history', 'vault', 'paused', 'lastTab']).then((data) => {
  state = { history: data.history || [], vault: data.vault || [], paused: !!data.paused };
  if (data.lastTab === 'vault') mode = 'vault';
  render();
});
