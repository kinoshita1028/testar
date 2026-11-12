// Meet Stage サイドパネル
// 「投影ウィンドウ」(相手・HDMI先に見せる窓)を1つ用意し、
// そこでアクティブにするタブをサイドパネルから切り替える。

const STANDBY_URL = chrome.runtime.getURL('standby.html');
const MEET_URL = 'https://meet.google.com/';
const $ = (id) => document.getElementById(id);

// ---------- 投影ウィンドウ ----------

async function getStage() {
  const { stageWindowId } = await chrome.storage.session.get('stageWindowId');
  if (stageWindowId == null) return null;
  try {
    return await chrome.windows.get(stageWindowId, { populate: true });
  } catch {
    await chrome.storage.session.remove(['stageWindowId', 'origins']);
    return null;
  }
}

async function openStage() {
  const existing = await getStage();
  if (existing) return existing;

  // 外部ディスプレイ(HDMI等)があればそちらに全画面で、なければ通常ウィンドウで開く
  const displays = await chrome.system.display.getInfo();
  const external = displays.find((d) => !d.isPrimary);
  const opts = { url: STANDBY_URL, type: 'normal', focused: false };
  if (external) {
    const a = external.workArea;
    Object.assign(opts, { left: a.left, top: a.top, width: a.width, height: a.height });
  } else {
    Object.assign(opts, { width: 1280, height: 720 });
  }
  const win = await chrome.windows.create(opts);
  await chrome.storage.session.set({ stageWindowId: win.id, origins: {} });
  if (external) await chrome.windows.update(win.id, { state: 'fullscreen' });
  return chrome.windows.get(win.id, { populate: true });
}

async function closeStage() {
  const stage = await getStage();
  if (!stage) return;
  // 投影していたタブは閉じずに元のウィンドウへ戻す
  for (const tab of stage.tabs) {
    if (tab.url !== STANDBY_URL) await returnTab(tab.id, { skipStandby: true });
  }
  await chrome.windows.remove(stage.id).catch(() => {});
  await chrome.storage.session.remove(['stageWindowId', 'origins']);
}

async function toggleFullscreen() {
  const stage = await getStage();
  if (!stage) return;
  await chrome.windows.update(stage.id, { state: stage.state === 'fullscreen' ? 'normal' : 'fullscreen' });
}

async function showStandby() {
  const stage = await openStage();
  const standby = stage.tabs.find((t) => t.url === STANDBY_URL);
  if (standby) await chrome.tabs.update(standby.id, { active: true });
  else await chrome.tabs.create({ windowId: stage.id, url: STANDBY_URL, active: true });
}

// ---------- タブの投影 / 戻す ----------

async function projectTab(tabId) {
  const stage = await openStage();
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== stage.id) {
    const { origins = {} } = await chrome.storage.session.get('origins');
    origins[tabId] = { windowId: tab.windowId, index: tab.index };
    await chrome.storage.session.set({ origins });
    // 最後の1枚を動かすと元ウィンドウ(とこのサイドパネル)が閉じてしまうので、空タブを残す
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    if (siblings.length === 1) await chrome.tabs.create({ windowId: tab.windowId, active: true });
    await chrome.tabs.move(tabId, { windowId: stage.id, index: -1 });
  }
  await chrome.tabs.update(tabId, { active: true });
}

async function returnTab(tabId, { skipStandby = false } = {}) {
  const stage = await getStage();
  const tab = await chrome.tabs.get(tabId);
  if (!stage || tab.windowId !== stage.id) return;
  // 映っているタブを戻すときは、隣のタブが勝手に映らないよう先に待機画面へ
  if (tab.active && !skipStandby) await showStandby();

  const { origins = {} } = await chrome.storage.session.get('origins');
  const origin = origins[tabId];
  delete origins[tabId];
  await chrome.storage.session.set({ origins });

  let target = null;
  if (origin) target = await chrome.windows.get(origin.windowId).catch(() => null);
  if (!target || target.type !== 'normal') {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    target = wins.find((w) => w.id !== stage.id) ?? null;
  }
  if (target) {
    await chrome.tabs.move(tabId, { windowId: target.id, index: origin?.windowId === target.id ? origin.index : -1 });
  } else {
    await chrome.windows.create({ tabId });
  }
}

// ---------- Google Meet ----------

async function sendToMeet(tabId, type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    // 拡張機能を入れる前から開いていたMeetタブにはスクリプトが無いので注入して再送
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type });
  }
}

async function startShare(meetTab) {
  await openStage();
  // 共有先の選択ダイアログはMeetのタブに出るので、前面に出してから押す
  await chrome.tabs.update(meetTab.id, { active: true });
  await chrome.windows.update(meetTab.windowId, { focused: true });
  const res = await sendToMeet(meetTab.id, 'meet-stage:present');
  if (!res?.ok) throw new Error(res?.error ?? 'Meetを操作できませんでした');
  toast('選択ダイアログで「ウィンドウ」→「Meet Stage 投影ウィンドウ」を選んでください');
}

async function stopShare(meetTab) {
  const res = await sendToMeet(meetTab.id, 'meet-stage:stop');
  if (!res?.ok) throw new Error(res?.error ?? 'Meetを操作できませんでした');
  toast('共有を停止しました');
}

// ---------- 描画 ----------

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ボタン操作の共通ラッパー: 失敗は必ず画面に出す
function run(fn) {
  return async () => {
    try { await fn(); } catch (e) { console.error(e); toast(`エラー: ${e.message}`); }
    render();
  };
}

function tabRow(tab, { onClick, active = false, onReturn = null }) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'tab' + (active ? ' active' : '');
  btn.title = tab.title || tab.url || '';
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    img.onerror = () => img.remove();
    btn.append(img);
  }
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = tab.url === STANDBY_URL ? '待機画面(黒)' : tab.title || tab.url || '(無題)';
  btn.append(title);
  if (active) {
    const live = document.createElement('span');
    live.className = 'live';
    live.textContent = '● 投影中';
    btn.append(live);
  }
  btn.addEventListener('click', run(onClick));
  li.append(btn);
  if (onReturn) {
    const back = document.createElement('button');
    back.className = 'icon-btn';
    back.textContent = '戻す';
    back.title = '投影ウィンドウから外して元のウィンドウへ戻す';
    back.addEventListener('click', run(onReturn));
    li.append(back);
  }
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

async function render() {
  const stage = await getStage();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });

  // 投影ウィンドウの状態
  $('stage-badge').textContent = stage ? '投影ウィンドウ 起動中' : '投影ウィンドウなし';
  $('stage-badge').className = 'badge ' + (stage ? 'on' : 'off');
  $('open-stage').hidden = Boolean(stage);
  $('stage-hint').hidden = Boolean(stage);
  for (const id of ['standby', 'fullscreen', 'close-stage']) $(id).hidden = !stage;

  // Meet
  const meetTabs = windows.flatMap((w) => w.tabs).filter((t) => t.url?.startsWith(MEET_URL));
  const meetList = $('meet-list');
  meetList.replaceChildren();
  if (!meetTabs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Meetのタブが開かれていません。';
    meetList.append(p);
  }
  for (const tab of meetTabs) {
    const box = document.createElement('div');
    box.className = 'meet';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = tab.title || 'Google Meet';
    const row = document.createElement('div');
    row.className = 'row';
    const start = document.createElement('button');
    start.className = 'primary';
    start.textContent = '画面共有を開始';
    start.addEventListener('click', run(() => startShare(tab)));
    const stop = document.createElement('button');
    stop.textContent = '共有を停止';
    stop.addEventListener('click', run(() => stopShare(tab)));
    row.append(start, stop);
    box.append(name, row);
    meetList.append(box);
  }

  // 投影ウィンドウ内のタブ
  const stageList = $('stage-tabs');
  stageList.replaceChildren();
  if (stage) {
    for (const tab of stage.tabs) {
      const isStandby = tab.url === STANDBY_URL;
      stageList.append(tabRow(tab, {
        active: tab.active,
        onClick: () => chrome.tabs.update(tab.id, { active: true }),
        onReturn: isStandby ? null : () => returnTab(tab.id),
      }));
    }
  } else {
    stageList.append(emptyRow('まだ何も投影していません。'));
  }

  // その他のタブ(Meet自身は映すと合わせ鏡になるので除外)
  const otherList = $('other-tabs');
  otherList.replaceChildren();
  const others = windows
    .filter((w) => w.id !== stage?.id)
    .flatMap((w) => w.tabs)
    .filter((t) => !t.url?.startsWith(MEET_URL));
  for (const tab of others) otherList.append(tabRow(tab, { onClick: () => projectTab(tab.id) }));
  if (!others.length) otherList.append(emptyRow('投影できるタブがありません。'));
}

// ---------- イベント ----------

$('open-stage').addEventListener('click', run(openStage));
$('standby').addEventListener('click', run(showStandby));
$('fullscreen').addEventListener('click', run(toggleFullscreen));
$('close-stage').addEventListener('click', run(closeStage));

let renderTimer;
const scheduleRender = () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 80);
};
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onAttached', 'onDetached']) {
  chrome.tabs[ev].addListener(scheduleRender);
}
chrome.windows.onRemoved.addListener(scheduleRender);
chrome.windows.onCreated.addListener(scheduleRender);

render();
