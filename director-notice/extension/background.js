// 重要通知ポップアップ - バックグラウンド処理
//   1分ごとに起動し、(1) 一定間隔でサーバーから通知定義を取得、(2) 表示時刻が来た通知をポップアップ表示する。
import { latestOccurrence } from './schedule.js';

const ALARM = 'tick';
const DEFAULT_POLL_MIN = 5;
const VERSION = chrome.runtime.getManifest().version;

// ---- 設定 -----------------------------------------------------------------

/** 管理コンソール配布の設定を優先し、なければ動作確認用の手動設定を使う */
async function getConfig() {
  let managed = {};
  try { managed = await chrome.storage.managed.get(null); } catch { /* ポリシーなし */ }
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  const isManaged = Boolean(managed.apiUrl);
  const cfg = isManaged ? managed : localConfig;

  let email = '';
  try {
    email = (await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })).email || '';
  } catch { /* 取得不可 */ }
  if (!email && !isManaged) email = localConfig.testEmail || '';

  return {
    isManaged,
    apiUrl: (cfg.apiUrl || '').trim(),
    apiKey: (cfg.apiKey || '').trim(),
    pollMinutes: Math.max(1, Number(cfg.pollMinutes) || DEFAULT_POLL_MIN),
    useGoogleLogin: Boolean(cfg.useGoogleLogin),
    email: email.toLowerCase(),
  };
}

// ---- サーバー通信 ---------------------------------------------------------

async function callApi(cfg, init, params) {
  const url = new URL(cfg.apiUrl);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    credentials: cfg.useGoogleLogin ? 'include' : 'omit',
  });
  if (!res.ok) throw new Error(`サーバーエラー (HTTP ${res.status})`);
  let data;
  try { data = await res.json(); } catch {
    throw new Error('サーバーの応答を読み取れません（URL・公開設定・Googleログイン状態を確認してください）');
  }
  if (!data.ok) throw new Error(data.error || 'サーバーエラー');
  return data;
}

async function sync(cfg) {
  const status = { at: Date.now(), ok: false, error: '', user: null, count: 0 };
  try {
    if (!cfg.apiUrl || !cfg.apiKey) throw new Error('通知サーバーが未設定です（管理者による配布設定が必要です）');
    if (!cfg.email && !cfg.useGoogleLogin) throw new Error('ChromeにGoogleアカウントでログインしていません');
    await flushAcks(cfg);
    const data = await callApi(cfg, { method: 'GET' },
      { action: 'list', key: cfg.apiKey, email: cfg.email, v: VERSION });
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const { state = {} } = await chrome.storage.local.get('state');
    const ids = new Set(notices.map((n) => n.id));
    for (const id of Object.keys(state)) if (!ids.has(id)) delete state[id];
    await chrome.storage.local.set({ notices, state });
    Object.assign(status, { ok: true, user: data.user || null, count: notices.length });
  } catch (e) {
    status.error = String(e.message || e);
  }
  await chrome.storage.local.set({ lastSync: status });
}

/** 未送信の「確認しました」をサーバーへ送る（失敗分は次回再送） */
async function flushAcks(cfg) {
  const { pendingAcks = [] } = await chrome.storage.local.get('pendingAcks');
  if (!pendingAcks.length || !cfg.apiUrl) return;
  const failed = [];
  for (const ack of pendingAcks) {
    try {
      await callApi(cfg, {
        method: 'POST',
        body: JSON.stringify({ action: 'ack', key: cfg.apiKey, email: cfg.email, ...ack }),
      });
    } catch {
      failed.push(ack);
    }
  }
  // 送信中に追加された分を消さないよう、読み直してから書き戻す
  const { pendingAcks: current = [] } = await chrome.storage.local.get('pendingAcks');
  await chrome.storage.local.set({ pendingAcks: [...failed, ...current.slice(pendingAcks.length)] });
}

// ---- ポップアップ表示 -----------------------------------------------------

async function getWinMap() {
  const { winMap = {} } = await chrome.storage.session.get('winMap');
  for (const winId of Object.keys(winMap)) {
    try { await chrome.windows.get(Number(winId)); } catch { delete winMap[winId]; }
  }
  return winMap;
}

async function showPopup(notice, winMap) {
  const open = Object.keys(winMap).find((w) => winMap[w] === notice.id);
  if (open) {
    await chrome.windows.update(Number(open), { focused: true, drawAttention: true });
    return;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html?id=${encodeURIComponent(notice.id)}`),
    type: 'popup', width: 560, height: 460, focused: true,
  });
  winMap[win.id] = notice.id;
  await chrome.storage.session.set({ winMap });
}

async function evaluate() {
  const { notices = [], state = {} } = await chrome.storage.local.get(['notices', 'state']);
  const now = Date.now();
  const winMap = await getWinMap();
  for (const n of notices) {
    const occ = latestOccurrence(n, now);
    if (occ === null) continue;
    let st = state[n.id];
    if (!st || st.occ !== occ) st = { occ, acked: false, shownAt: 0 };
    if (!st.acked) {
      const isOpen = Object.values(winMap).includes(n.id);
      const remindDue = n.remindMin > 0 && !isOpen && now >= st.shownAt + n.remindMin * 60e3;
      if (!st.shownAt || remindDue) {
        await showPopup(n, winMap);
        st.shownAt = now;
      }
    }
    state[n.id] = st;
  }
  await chrome.storage.local.set({ state });
}

// ---- メインループ ---------------------------------------------------------

let chain = Promise.resolve();
function run(forceSync = false) {
  chain = chain.then(async () => {
    const cfg = await getConfig();
    const { lastSync } = await chrome.storage.local.get('lastSync');
    if (forceSync || !lastSync || Date.now() - lastSync.at >= cfg.pollMinutes * 60e3 - 5e3) {
      await sync(cfg);
    }
    await evaluate();
  }).catch((e) => console.error(e));
  return chain;
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); run(true); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); run(true); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'local' && changes.localConfig)) run(true);
});

// 「確認しました」を押さずに閉じた場合、再表示の起点を「閉じた時刻」にする
chrome.windows.onRemoved.addListener((winId) => {
  chain = chain.then(async () => {
    const { winMap = {} } = await chrome.storage.session.get('winMap');
    const id = winMap[winId];
    if (!id) return;
    delete winMap[winId];
    await chrome.storage.session.set({ winMap });
    const { state = {} } = await chrome.storage.local.get('state');
    if (state[id] && !state[id].acked) {
      state[id].shownAt = Date.now();
      await chrome.storage.local.set({ state });
    }
  }).catch((e) => console.error(e));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ack') {
    chain = chain.then(async () => {
      const { state = {}, pendingAcks = [] } = await chrome.storage.local.get(['state', 'pendingAcks']);
      const st = state[msg.id];
      if (st && !st.acked) {
        st.acked = true;
        pendingAcks.push({ id: msg.id, occurrence: st.occ });
        await chrome.storage.local.set({ state, pendingAcks });
      }
      await flushAcks(await getConfig());
    }).catch((e) => console.error(e)).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'status') {
    (async () => {
      const cfg = await getConfig();
      const { lastSync = null, pendingAcks = [] } = await chrome.storage.local.get(['lastSync', 'pendingAcks']);
      sendResponse({
        version: VERSION, isManaged: cfg.isManaged, email: cfg.email,
        configured: Boolean(cfg.apiUrl && cfg.apiKey), lastSync, pendingAcks: pendingAcks.length,
      });
    })();
    return true;
  }
  if (msg?.type === 'syncNow') {
    run(true).then(() => sendResponse({ ok: true }));
    return true;
  }
});
