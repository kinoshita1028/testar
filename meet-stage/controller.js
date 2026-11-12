// Meet Stage 操作用ウィンドウ
const TAG = 'meet-stage';
const MEET_MATCH = 'https://meet.google.com/*';
const $ = (id) => document.getElementById(id);

let meetTab = null;   // 接続中のMeetタブ
let port = null;
let state = { presenting: false, liveId: null, sources: [] };
const thumbs = new Map(); // id -> dataURL

// ---------- Meetタブとの接続 ----------

async function connect() {
  if (port) return;
  const tabs = await chrome.tabs.query({ url: MEET_MATCH });
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab) { meetTab = null; render(); return; }
  try {
    // 拡張機能を入れる前から開いていたMeetタブにはスクリプトが無いので入れる(二重実行は各スクリプトが防ぐ)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    console.warn(e);
    return;
  }
  meetTab = tab;
  port = chrome.tabs.connect(tab.id, { name: TAG });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'state') {
      state = msg;
      for (const id of thumbs.keys()) if (!state.sources.some((s) => s.id === id)) thumbs.delete(id);
      render();
    } else if (msg.type === 'thumb') {
      thumbs.set(msg.id, msg.url);
      const img = document.querySelector(`[data-thumb="${msg.id}"]`);
      if (img) img.src = msg.url;
    }
  });
  port.onDisconnect.addListener(() => {
    // Meetタブが閉じられた / 再読み込みされた(登録したソースはページと一緒に消える)
    port = null;
    meetTab = null;
    state = { presenting: false, liveId: null, sources: [] };
    thumbs.clear();
    render();
  });
  render();
}
setInterval(connect, 2000);
connect();

async function send(msg) {
  if (!meetTab) throw new Error('Meetのタブが見つかりません');
  const res = await chrome.tabs.sendMessage(meetTab.id, { [TAG]: true, ...msg });
  if (!res?.ok && res?.error !== 'cancelled') throw new Error(res?.error ?? 'Meetを操作できませんでした');
  return res;
}

// ---------- 操作 ----------

async function addSource() {
  // 選択ダイアログはMeetのタブに出るので、前面に出してから呼ぶ
  await chrome.tabs.update(meetTab.id, { active: true });
  await chrome.windows.update(meetTab.windowId, { focused: true });
  await send({ type: 'add' });
  // 選び終わったらこのウィンドウに戻る
  const me = await chrome.windows.getCurrent();
  await chrome.windows.update(me.id, { focused: true });
}

async function show(id) {
  const res = await send({ type: 'show', id });
  if (res.manual) {
    // 自動で共有を始められなかったので、Meetを前面に出して利用者に押してもらう
    await chrome.tabs.update(meetTab.id, { active: true });
    await chrome.windows.update(meetTab.windowId, { focused: true });
    toast('Meetの「画面を共有」ボタンを30秒以内に押してください。選択ダイアログは出ず、選んだ画面が共有されます。');
  }
}

// ---------- 描画 ----------

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

const run = (fn) => async () => {
  try { await fn(); } catch (e) { console.error(e); toast(`エラー: ${e.message}`); }
};

let listSignature = '';
function render() {
  const live = state.sources.find((s) => s.id === state.liveId);
  const status = $('status');
  if (!meetTab) {
    status.textContent = 'Meet未接続';
    status.className = 'status off';
  } else if (state.presenting) {
    status.textContent = live ? `共有中: ${live.name}` : '共有中(ソースなし)';
    status.className = 'status live';
  } else {
    status.textContent = '共有していません';
    status.className = 'status off';
  }
  $('stop').hidden = !state.presenting;
  $('diag').hidden = !state.presenting;
  $('diag').textContent = `送出フレーム数: ${state.frames ?? 0}`;
  $('no-meet').hidden = Boolean(meetTab);
  $('main').hidden = !meetTab;
  $('empty').hidden = state.sources.length > 0;

  // 一覧は内容が変わったときだけ作り直す(定期更新のたびに作り直すとクリックを取りこぼす)
  const signature = JSON.stringify([state.presenting, state.liveId, state.sources]);
  if (signature === listSignature) return;
  listSignature = signature;
  const list = $('sources');
  list.replaceChildren();
  for (const src of state.sources) {
    const isLive = state.presenting && src.id === state.liveId;
    const li = document.createElement('li');

    const btn = document.createElement('button');
    btn.className = 'source' + (isLive ? ' live' : '');
    btn.title = isLive ? 'お客様に表示中' : 'クリックでお客様に見せる';
    const img = document.createElement('img');
    img.dataset.thumb = src.id;
    img.alt = '';
    if (thumbs.has(src.id)) img.src = thumbs.get(src.id);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = src.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = isLive ? '● お客様に表示中' : src.kind;
    meta.append(name, sub);
    btn.append(img, meta);
    btn.addEventListener('click', run(() => show(src.id)));

    const tools = document.createElement('div');
    tools.className = 'tools';
    const rename = document.createElement('button');
    rename.textContent = '名前';
    rename.title = '名前を変更';
    rename.addEventListener('click', run(async () => {
      const next = prompt('名前を変更', src.name)?.trim();
      if (next) await send({ type: 'rename', id: src.id, name: next });
    }));
    const remove = document.createElement('button');
    remove.textContent = '削除';
    remove.title = 'このソースの登録を解除';
    remove.addEventListener('click', run(() => send({ type: 'remove', id: src.id })));
    tools.append(rename, remove);

    li.append(btn, tools);
    list.append(li);
  }
}

$('add').addEventListener('click', run(addSource));
$('stop').addEventListener('click', run(() => send({ type: 'stop' })));
render();
