// アプリの起動・レイアウト・ショートカット
import { api } from './api.js';
import { store } from './store.js';
import { toast, isTyping } from './ui.js';
import { Player, timecodeText } from './player.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { GeneratePanel } from './panels/generate.js';
import { LibraryPanel } from './panels/library.js';
import { NarrationPanel } from './panels/narration.js';
import { openExport, openSettings } from './dialogs.js';

const $ = (id) => document.getElementById(id);

async function init() {
  let status, models, lib, proj;
  try {
    [status, models, lib, proj] = await Promise.all([api.get('/api/status'), api.get('/api/models'), api.get('/api/library'), api.get('/api/project')]);
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px">サーバーに接続できません: ${e.message}<br>ターミナルで <code>npm start</code> を実行してください。</div>`;
    return;
  }
  store.status = status;
  store.settings = status.settings;
  store.models = models;
  store.setLibrary(lib.items);

  const player = new Player($('stage'), $('stageEmpty'));
  const timeline = new Timeline($('timeline'), player);
  store.setProject(proj.project);
  new Inspector($('inspector'), player);
  new GeneratePanel($('tab-generate'));
  new LibraryPanel($('tab-library'));
  new NarrationPanel($('tab-narration'));
  window.__studio = { store, player, timeline };

  // タブ
  const switchTab = (tab) => {
    for (const b of $('leftTabs').children) b.classList.toggle('active', b.dataset.tab === tab);
    for (const t of ['generate', 'library', 'narration']) $(`tab-${t}`).classList.toggle('hidden', t !== tab);
  };
  $('leftTabs').addEventListener('click', (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));
  store.on('ui:tab', switchTab);
  store.on('ui:settings', openSettings);

  // ヘッダー
  const nameInput = $('projectName');
  nameInput.addEventListener('change', () => store.mutate((p) => (p.name = nameInput.value.trim() || '無題のプロジェクト')));
  $('undoBtn').addEventListener('click', () => store.undo());
  $('redoBtn').addEventListener('click', () => store.redo());
  $('settingsBtn').addEventListener('click', openSettings);
  $('exportBtn').addEventListener('click', openExport);
  $('aspectSelect').addEventListener('change', (e) => store.mutate((p) => (p.aspectRatio = e.target.value)));
  const updateHistoryBtns = () => {
    $('undoBtn').disabled = !store.history.length;
    $('redoBtn').disabled = !store.future.length;
  };
  store.on('history', updateHistoryBtns);
  updateHistoryBtns();

  const renderStatus = () => {
    const chip = $('apiStatus');
    const s = store.status;
    chip.className = 'chip click';
    if (s.demo || s.settings.demoMode) {
      chip.classList.add('warn');
      chip.textContent = '● デモモード（API未使用）';
    } else if (s.settings.hasApiKey) {
      chip.classList.add(store.models.error ? 'warn' : 'ok');
      chip.textContent = store.models.error ? '● APIキー設定済み（モデル一覧取得エラー）' : '● Gemini API 接続済み';
      chip.title = store.models.error || '';
    } else {
      chip.classList.add('err');
      chip.textContent = '● APIキー未設定';
    }
    if (!s.ffmpeg?.ok) toast('ffmpeg が見つかりません。書き出しやサムネイル作成ができません。README を参照してください。', 'err');
  };
  $('apiStatus').addEventListener('click', openSettings);
  store.on('status', renderStatus);
  store.on('models', renderStatus);
  renderStatus();

  // プレビュー領域のサイズ（縦横比を保って最大化）
  const fitStage = () => {
    const area = $('stageArea');
    const [aw, ah] = (store.project.aspectRatio || '16:9').split(':').map(Number);
    const W = area.clientWidth - 28;
    const H = area.clientHeight - 28;
    let w = W;
    let hh = (W * ah) / aw;
    if (hh > H) {
      hh = H;
      w = (H * aw) / ah;
    }
    $('stage').style.width = `${Math.max(0, w)}px`;
    $('stage').style.height = `${Math.max(0, hh)}px`;
  };
  new ResizeObserver(fitStage).observe($('stageArea'));
  const onProject = () => {
    if (document.activeElement !== nameInput) nameInput.value = store.project.name;
    $('aspectSelect').value = store.project.aspectRatio;
    fitStage();
    $('timecode').textContent = timecodeText(store.time, player.duration);
  };
  store.on('project', onProject);
  onProject();

  // 再生操作
  $('playBtn').addEventListener('click', () => player.toggle());
  $('toStartBtn').addEventListener('click', () => player.seek(0));
  $('toEndBtn').addEventListener('click', () => player.seek(player.duration));
  store.on('time', (t) => ($('timecode').textContent = timecodeText(t, player.duration)));
  store.on('playstate', (p) => ($('playBtn').textContent = p ? '❚❚' : '▶'));

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    if (isTyping(e) || document.querySelector('.modal-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      store.duplicateSelected();
    } else if (!mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      store.splitAt();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      store.deleteSelected();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 1 / (store.project.fps || 30);
      player.seek(store.time + (e.key === 'ArrowLeft' ? -step : step));
    } else if (e.key === 'Home') player.seek(0);
    else if (e.key === 'End') player.seek(player.duration);
    else if (e.key === 'Escape') store.select(null);
  });

  timeline.render();
  setTimeout(() => timeline.fit(), 50);
  if (!status.settings.hasApiKey && !status.demo) {
    toast('はじめに右上の「⚙ 設定」で Gemini API キーを入力してください（お試しはデモモードで可能）', 'warn', 9000);
  }
}

init();
