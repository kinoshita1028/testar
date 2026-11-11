// コピー履歴 & 保管庫 - バックグラウンド(Service Worker)
// ・offscreen ドキュメントでPCのクリップボードを監視(Chrome以外のアプリでのコピーも拾う)
// ・content script からの copy/cut イベントも受け取る
// ・履歴は直近 HISTORY_LIMIT 件だけ保持。保管庫は無制限。

const HISTORY_LIMIT = 100;
const OFFSCREEN_URL = 'offscreen.html';

// ストレージ更新を直列化して、同時書き込みでの取りこぼしを防ぐ
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addToHistory(text) {
  if (typeof text !== 'string' || text.trim() === '') return;
  const { history = [], paused = false } = await chrome.storage.local.get(['history', 'paused']);
  if (paused) return;
  if (history.length && history[0].text === text) return; // 直前と同じなら何もしない
  // 同じテキストが過去にあれば先頭に移動(重複させない)
  const next = history.filter((item) => item.text !== text);
  next.unshift({ id: newId(), text, time: Date.now() });
  if (next.length > HISTORY_LIMIT) next.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ history: next });
}

async function addToVault(text) {
  if (typeof text !== 'string' || text === '') return { ok: false };
  const { vault = [] } = await chrome.storage.local.get('vault');
  if (vault.some((item) => item.text === text)) return { ok: true, duplicate: true };
  vault.unshift({ id: newId(), text, time: Date.now() });
  await chrome.storage.local.set({ vault });
  return { ok: true };
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['CLIPBOARD'],
        justification: 'コピーしたテキストを履歴に記録するためにクリップボードを読み取ります。',
      })
      .catch((e) => console.warn('offscreen 作成失敗', e))
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function init() {
  ensureOffscreen();
  // offscreen ドキュメントが閉じられていた場合に復旧するための定期チェック
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') ensureOffscreen();
});
ensureOffscreen();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;
  if (msg.type === 'clip') {
    enqueue(() => addToHistory(msg.text));
    return;
  }
  if (msg.type === 'saveToVault') {
    enqueue(() => addToVault(msg.text)).then(sendResponse, () => sendResponse({ ok: false }));
    return true; // 非同期で応答
  }
});
