import { DEFAULT_SETTINGS, loadSettings, saveSettings, loadBlocks, saveBlocksSoon, flushBlocks } from './lib/storage.js';
import { transcribeAudio, correctText, listModels, resolveModel, pickAutoModel } from './lib/gemini.js';
import { SpeechRecorder } from './lib/recorder.js';
import { encodeWav, bytesToBase64 } from './lib/wav.js';
import { diffTokens, countHunks } from './lib/diff.js';
import { copyText } from './lib/clipboard.js';

const $ = (sel, root = document) => root.querySelector(sel);

const ui = {
  app: $('.app'),
  banner: $('#banner'),
  bannerText: $('#bannerText'),
  bannerAction: $('#bannerAction'),
  recordBtn: $('#recordBtn'),
  recordLabel: $('#recordBtn .record-label'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  timer: $('#timer'),
  meterFill: $('#meterFill'),
  meterThreshold: $('#meterThreshold'),
  list: $('#list'),
  empty: $('#empty'),
  emptySettings: $('#emptySettings'),
  liveCard: $('#liveCard'),
  liveTime: $('#liveTime'),
  stats: $('#stats'),
  copyAllBtn: $('#copyAllBtn'),
  clearBtn: $('#clearBtn'),
  settingsBtn: $('#settingsBtn'),
  popoutBtn: $('#popoutBtn'),
  settingsView: $('#settingsView'),
  settingsClose: $('#settingsClose'),
  apiKey: $('#apiKey'),
  toggleKey: $('#toggleKey'),
  saveKey: $('#saveKey'),
  testKey: $('#testKey'),
  keyStatus: $('#keyStatus'),
  modelList: $('#modelList'),
  autoModelInfo: $('#autoModelInfo'),
  toast: $('#toast'),
  tpl: $('#blockTpl'),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  blocks: [],
  recorder: null,
  recording: false,
  startedAt: 0,
  level: null,
  correctionChain: Promise.resolve(),
  micBanner: null,
};

const audioStore = new Map(); // block id -> base64 WAV (memory only, for retries)
const MAX_AUDIO_KEPT = 30;
const blockEls = new Map();
const view = new Map(); // block id -> { showDiff, editing }

const RECORDER_KEYS = ['silenceMs', 'sensitivity', 'maxSegmentSec'];

// ================================================================ helpers

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const pad = (n) => String(n).padStart(2, '0');

function formatClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function finalText(b) {
  return String(b.edited ?? b.corrected ?? b.raw ?? '').trim();
}

function isBusy(b) {
  return b.status === 'transcribing' || b.status === 'correcting';
}

function getView(id) {
  if (!view.has(id)) view.set(id, { showDiff: false, editing: false });
  return view.get(id);
}

function persist() {
  saveBlocksSoon(state.blocks);
}

function isNearBottom() {
  const l = ui.list;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 120;
}

function scrollToBottom() {
  ui.list.scrollTop = ui.list.scrollHeight;
}

let toastTimer = null;
function toast(message, kind = '') {
  ui.toast.textContent = message;
  ui.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.className = `toast ${kind}`;
  }, kind === 'error' ? 3500 : 1800);
}

function errorMessage(err) {
  return err?.message || String(err);
}

// ============================================================ rendering

function renderBlock(b) {
  let el = blockEls.get(b.id);
  if (!el) {
    el = ui.tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = b.id;
    ui.list.insertBefore(el, ui.liveCard);
    blockEls.set(b.id, el);
  }
  const v = getView(b.id);
  el.dataset.status = b.status;

  $('.block-time', el).textContent = formatClock(b.createdAt);
  $('.block-dur', el).textContent = b.durationMs ? `${(b.durationMs / 1000).toFixed(1)}秒` : '';

  // status chip
  const chip = $('.chip', el);
  const [chipText, chipClass] = chipFor(b);
  chip.className = `chip ${chipClass}`;
  $('.chip-text', chip).textContent = chipText;
  if (b.changes?.length) {
    chip.title = b.changes.map((c) => `「${c.before}」→「${c.after}」${c.reason ? `：${c.reason}` : ''}`).join('\n');
  } else {
    chip.removeAttribute('title');
  }

  if (!v.editing) $('.block-body', el).replaceChildren(...bodyNodes(b, v));

  // note line
  const note = $('.block-note', el);
  const [noteText, noteClass] = noteFor(b);
  note.hidden = !noteText;
  note.textContent = noteText;
  note.className = `block-note ${noteClass}`;

  // actions
  const text = finalText(b);
  const corrected = b.corrected != null && b.raw != null && b.corrected !== b.raw;
  const copyBtn = $('[data-action="copy"]', el);
  copyBtn.disabled = !text || b.status === 'transcribing';
  copyBtn.classList.toggle('is-copied', Boolean(b.copied));
  $('span', copyBtn).textContent = b.copied ? 'コピー済み' : 'コピー';

  $('[data-action="edit"]', el).hidden = !b.raw || v.editing || isBusy(b);
  const diffBtn = $('[data-action="diff"]', el);
  diffBtn.hidden = !corrected || v.editing || b.edited != null;
  diffBtn.classList.toggle('is-active', v.showDiff);
  $('[data-action="revert"]', el).hidden = !(v.showDiff && corrected && !v.editing && b.edited == null);
  $('[data-action="retry"]', el).hidden = !b.error || isBusy(b);
}

function chipFor(b) {
  switch (b.status) {
    case 'transcribing':
      return ['文字起こし中', 'is-busy'];
    case 'correcting':
      return ['文脈で校正中', 'is-busy'];
    case 'error':
      return ['エラー', 'is-error'];
    default:
      if (b.edited != null) return ['編集済み', 'is-ok'];
      if (b.error) return ['校正失敗', 'is-warn'];
      if (b.fixCount > 0) return [`${b.fixCount}箇所 修正`, 'is-fixed'];
      if (b.corrected != null) return ['修正なし', 'is-ok'];
      return ['完了', 'is-ok'];
  }
}

function noteFor(b) {
  if (b.error) {
    const prefix = b.error.stage === 'correct' ? '校正できませんでした（文字起こし結果はそのまま使えます）：' : '';
    return [`${prefix}${b.error.message}`, b.error.stage === 'correct' ? 'is-warn' : 'is-error'];
  }
  if (b.correctionSkipped) return ['校正結果が原文から大きく変わったため、原文のままにしました', 'is-warn'];
  return ['', ''];
}

function bodyNodes(b, v) {
  if (b.status === 'transcribing') {
    const sk = document.createElement('div');
    sk.className = 'skeleton';
    sk.append(document.createElement('i'), document.createElement('i'));
    return [sk];
  }
  if (b.raw == null) return [];
  if (b.status === 'correcting') {
    const span = document.createElement('span');
    span.className = 'pending-text';
    span.textContent = b.raw;
    return [span];
  }
  if (b.edited != null) return [document.createTextNode(b.edited)];
  if (b.corrected == null || b.corrected === b.raw) return [document.createTextNode(b.raw)];

  const ops = diffTokens(b.raw, b.corrected);
  const nodes = [];
  let deleted = '';
  for (const op of ops) {
    if (op.type === 'equal') {
      nodes.push(document.createTextNode(op.text));
      deleted = '';
    } else if (op.type === 'delete') {
      if (v.showDiff) {
        const del = document.createElement('del');
        del.textContent = op.text;
        nodes.push(del);
      }
      deleted = op.text;
    } else {
      const node = document.createElement(v.showDiff ? 'ins' : 'mark');
      node.textContent = op.text;
      node.title = deleted ? `元：「${deleted}」${reasonFor(b, op.text)}` : `追加${reasonFor(b, op.text)}`;
      nodes.push(node);
      deleted = '';
    }
  }
  return nodes;
}

function reasonFor(b, insertedText) {
  const hit = (b.changes || []).find((c) => c.after && (c.after.includes(insertedText) || insertedText.includes(c.after)));
  return hit?.reason ? `\n理由：${hit.reason}` : '';
}

function removeBlockEl(id) {
  blockEls.get(id)?.remove();
  blockEls.delete(id);
  view.delete(id);
}

function updateChrome() {
  const count = state.blocks.length;
  ui.empty.hidden = count > 0 || state.recording;
  const chars = state.blocks.reduce((n, b) => n + finalText(b).length, 0);
  const busy = state.blocks.filter(isBusy).length;
  ui.stats.textContent = count
    ? `${count} ブロック · ${chars.toLocaleString()} 文字${busy ? ` · 処理中 ${busy}` : ''}`
    : '';
  ui.copyAllBtn.disabled = !state.blocks.some((b) => finalText(b));
  ui.clearBtn.disabled = count === 0;
}

// ============================================================== pipeline

function handleSegment(seg) {
  const stick = isNearBottom();
  const b = {
    id: uid(),
    createdAt: seg.startedAt || Date.now(),
    durationMs: Math.round(seg.durationMs),
    status: 'transcribing',
    raw: null,
    corrected: null,
    edited: null,
    changes: [],
    fixCount: 0,
    error: null,
    copied: false,
    correctionSkipped: false,
  };
  state.blocks.push(b);
  audioStore.set(b.id, bytesToBase64(encodeWav(seg.samples, seg.sampleRate)));
  while (audioStore.size > MAX_AUDIO_KEPT) audioStore.delete(audioStore.keys().next().value);

  renderBlock(b);
  updateChrome();
  if (stick) scrollToBottom();
  persist();
  runPipeline(b);
}

function runPipeline(b) {
  const transcribed = transcribeBlock(b);
  state.correctionChain = state.correctionChain
    .then(() => transcribed)
    .then((needsCorrection) => (needsCorrection ? correctBlock(b) : null))
    .catch((err) => console.error(err));
}

function alive(b) {
  return state.blocks.includes(b);
}

function previousBlocks(b) {
  const idx = state.blocks.indexOf(b);
  return state.blocks.slice(0, Math.max(0, idx)).filter((x) => finalText(x));
}

async function transcribeBlock(b) {
  const audio = audioStore.get(b.id);
  if (!audio) {
    b.status = 'error';
    b.error = { stage: 'transcribe', message: '音声データが残っていないため再試行できません。' };
    renderBlock(b);
    persist();
    return false;
  }

  b.status = 'transcribing';
  b.error = null;
  renderBlock(b);
  updateChrome();

  const s = state.settings;
  const prev = previousBlocks(b).slice(-1)[0];
  try {
    const text = await transcribeAudio({
      apiKey: s.apiKey,
      model: s.transcribeModel,
      audioBase64: audio,
      language: s.language,
      removeFillers: s.removeFillers,
      glossary: s.glossary,
      prevText: prev ? finalText(prev).slice(-200) : '',
    });
    if (!alive(b)) return false;

    if (!text) {
      // Nothing intelligible (noise, a cough...): drop the block quietly.
      deleteBlock(b, { quiet: true });
      return false;
    }

    b.raw = text;
    b.corrected = null;
    b.changes = [];
    b.fixCount = 0;
    b.correctionSkipped = false;
    if (s.enableCorrection) {
      b.status = 'correcting';
      renderBlock(b);
      updateChrome();
      persist();
      return true;
    }
    finishBlock(b);
    return false;
  } catch (err) {
    if (!alive(b)) return false;
    b.status = 'error';
    b.error = { stage: 'transcribe', message: errorMessage(err) };
    renderBlock(b);
    updateChrome();
    persist();
    return false;
  }
}

async function correctBlock(b) {
  if (!alive(b) || b.raw == null) return;
  const s = state.settings;
  b.status = 'correcting';
  b.error = null;
  renderBlock(b);

  const context = previousBlocks(b)
    .slice(-Math.max(0, Number(s.contextBlocks) || 0))
    .map(finalText)
    .join('\n')
    .slice(-1500);

  try {
    const res = await correctText({
      apiKey: s.apiKey,
      model: s.correctModel,
      text: b.raw,
      context: Number(s.contextBlocks) > 0 ? context : '',
      glossary: s.glossary,
    });
    if (!alive(b)) return;
    b.corrected = res.corrected;
    b.changes = res.changes;
    b.correctionSkipped = res.skipped;
    b.fixCount = countHunks(diffTokens(b.raw, res.corrected));
  } catch (err) {
    if (!alive(b)) return;
    b.corrected = null;
    b.error = { stage: 'correct', message: errorMessage(err) };
  }
  finishBlock(b);
}

function finishBlock(b) {
  b.status = 'done';
  renderBlock(b);
  updateChrome();
  persist();
  if (state.settings.autoCopy && finalText(b)) {
    copyText(finalText(b)).then((ok) => {
      if (!ok || !alive(b)) return;
      b.copied = true;
      renderBlock(b);
      persist();
      toast('自動コピーしました');
    });
  }
}

function retryBlock(b) {
  if (b.error?.stage === 'correct' && b.raw != null) {
    b.error = null;
    b.status = 'correcting';
    renderBlock(b);
    state.correctionChain = state.correctionChain.then(() => correctBlock(b)).catch(console.error);
  } else {
    runPipeline(b);
  }
}

function deleteBlock(b, { quiet = false } = {}) {
  const i = state.blocks.indexOf(b);
  if (i >= 0) state.blocks.splice(i, 1);
  audioStore.delete(b.id);
  removeBlockEl(b.id);
  updateChrome();
  persist();
  if (!quiet) toast('削除しました');
}

// ================================================================ copying

async function copyBlock(b) {
  const ok = await copyText(finalText(b));
  if (!ok) {
    toast('コピーに失敗しました', 'error');
    return;
  }
  b.copied = true;
  renderBlock(b);
  persist();
  toast('コピーしました');
}

const SEPARATORS = { newline: '\n', blank: '\n\n', space: ' ', none: '' };

async function copyAll() {
  const ready = state.blocks.filter((b) => finalText(b) && b.status !== 'transcribing');
  if (!ready.length) return;
  const sep = SEPARATORS[state.settings.copySeparator] ?? '\n';
  const ok = await copyText(ready.map(finalText).join(sep));
  if (!ok) {
    toast('コピーに失敗しました', 'error');
    return;
  }
  for (const b of ready) {
    b.copied = true;
    renderBlock(b);
  }
  persist();
  const busy = state.blocks.some(isBusy);
  toast(busy ? `${ready.length} ブロックをコピー（処理中のものは校正前の内容）` : `${ready.length} ブロックをすべてコピーしました`);
}

let clearArmed = null;
function clearAll() {
  if (!clearArmed) {
    ui.clearBtn.textContent = 'もう一度押して消去';
    ui.clearBtn.classList.add('confirm');
    clearArmed = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  for (const b of state.blocks) removeBlockEl(b.id);
  state.blocks = [];
  audioStore.clear();
  updateChrome();
  persist();
  toast('すべて消去しました');
}

function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  ui.clearBtn.textContent = 'クリア';
  ui.clearBtn.classList.remove('confirm');
}

// ================================================================ editing

function startEdit(b) {
  const v = getView(b.id);
  v.editing = true;
  v.showDiff = false;
  const el = blockEls.get(b.id);
  const body = $('.block-body', el);

  const area = document.createElement('textarea');
  area.className = 'edit-area';
  area.value = finalText(b);
  const bar = document.createElement('div');
  bar.className = 'edit-bar';
  const save = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary small', textContent: '保存' });
  save.dataset.action = 'edit-save';
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'キャンセル' });
  cancel.dataset.action = 'edit-cancel';
  const hint = Object.assign(document.createElement('small'), { textContent: '⌘/Ctrl + Enter で保存' });
  bar.append(save, cancel, hint);
  body.replaceChildren(area, bar);

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finishEdit(b, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishEdit(b, false);
    }
  });
  const fit = () => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  };
  area.addEventListener('input', fit);
  renderBlock(b);
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function finishEdit(b, save) {
  const v = getView(b.id);
  const area = $('.edit-area', blockEls.get(b.id));
  if (save && area) {
    const value = area.value.trim();
    const base = String(b.corrected ?? b.raw ?? '').trim();
    b.edited = value === base ? null : value;
    b.copied = false;
    persist();
  }
  v.editing = false;
  renderBlock(b);
  updateChrome();
}

// ============================================================== recording

async function toggleRecording() {
  if (state.recording) await stopRecording();
  else await startRecording();
}

async function startRecording() {
  if (!state.settings.apiKey) {
    openSettings();
    ui.apiKey.focus();
    toast('まず Gemini API キーを設定してください', 'warn');
    return;
  }

  ui.recordBtn.disabled = true;
  setStatus('', 'マイクを準備中…');
  const s = state.settings;
  const rec = new SpeechRecorder({
    silenceMs: s.silenceMs,
    sensitivity: s.sensitivity,
    maxSegmentSec: s.maxSegmentSec,
    onSegment: handleSegment,
    onLevel: (level) => {
      state.level = level;
    },
    onEnded: () => {
      toast('マイクが切断されました', 'error');
      stopRecording();
    },
  });

  try {
    await rec.start();
  } catch (err) {
    ui.recordBtn.disabled = false;
    setStatus('', '待機中');
    handleMicError(err);
    return;
  }

  state.recorder = rec;
  state.recording = true;
  state.startedAt = Date.now();
  state.micBanner = null;
  ui.recordBtn.disabled = false;
  refreshBanner();
  updateRecordUi();
}

async function stopRecording() {
  const rec = state.recorder;
  state.recorder = null;
  state.recording = false;
  state.level = null;
  if (rec) await rec.stop({ flush: true });
  ui.liveCard.hidden = true;
  updateRecordUi();
}

function updateRecordUi() {
  ui.recordBtn.classList.toggle('is-recording', state.recording);
  ui.recordBtn.setAttribute('aria-pressed', String(state.recording));
  ui.recordLabel.textContent = state.recording ? '停止' : '録音開始';
  ui.app.classList.toggle('is-recording-app', state.recording);
  if (!state.recording) {
    setStatus('', '待機中');
    ui.timer.textContent = '';
    ui.meterFill.style.width = '0%';
    ui.meterFill.classList.remove('is-speaking');
  }
  updateChrome();
}

function setStatus(kind, text) {
  ui.statusDot.className = `status-dot ${kind}`;
  if (ui.statusText.textContent !== text) ui.statusText.textContent = text;
}

const dbPercent = (amp) => {
  const db = 20 * Math.log10(Math.max(amp, 1e-6));
  return Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
};

function meterLoop() {
  const level = state.level;
  if (state.recording && level) {
    ui.meterFill.style.width = `${dbPercent(level.rms)}%`;
    ui.meterThreshold.style.left = `${dbPercent(level.threshold)}%`;
    ui.meterFill.classList.toggle('is-speaking', level.speaking);
    if (level.speaking) {
      if (ui.liveCard.hidden) {
        const stick = isNearBottom();
        ui.liveCard.hidden = false;
        if (stick) scrollToBottom();
      }
      ui.liveTime.textContent = `${(level.segmentMs / 1000).toFixed(1)}秒`;
      setStatus('speaking', '話しています');
    } else {
      ui.liveCard.hidden = true;
      setStatus('listening', '聞き取り中（話すと自動でブロック化）');
    }
    ui.timer.textContent = formatElapsed(Date.now() - state.startedAt);
  }
  requestAnimationFrame(meterLoop);
}

// =========================================================== microphone

function openPermissionPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

function handleMicError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    state.micBanner = { text: 'マイクの使用が許可されていません。新しいタブで許可してください。', action: 'マイクを許可', run: openPermissionPage };
    openPermissionPage();
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    state.micBanner = { text: 'マイクが見つかりません。接続を確認してください。' };
  } else if (name === 'NotReadableError') {
    state.micBanner = { text: 'マイクを使用できません（他のアプリが使用中の可能性があります）。' };
  } else {
    state.micBanner = { text: `録音を開始できませんでした：${errorMessage(err)}` };
  }
  refreshBanner();
}

async function watchMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    status.addEventListener('change', () => {
      if (status.state === 'granted' && state.micBanner) {
        state.micBanner = null;
        refreshBanner();
        toast('マイクが許可されました。録音を開始できます');
      }
    });
  } catch {
    /* permissions API unavailable */
  }
}

function refreshBanner() {
  let b = state.micBanner;
  if (!b && !state.settings.apiKey) {
    b = { text: 'Gemini API キーが未設定です。', action: '設定を開く', run: openSettings };
  }
  ui.banner.hidden = !b;
  if (!b) return;
  ui.bannerText.textContent = b.text;
  ui.bannerAction.hidden = !b.action;
  ui.bannerAction.textContent = b.action || '';
  ui.bannerAction.onclick = b.run || null;
}

// ============================================================== settings

function openSettings() {
  ui.settingsView.hidden = false;
  ui.settingsClose.focus();
}

function closeSettings() {
  ui.settingsView.hidden = true;
}

const RANGE_LABEL = {
  silenceMs: (v) => `${(v / 1000).toFixed(1)} 秒`,
  sensitivity: (v) => `${v}`,
  maxSegmentSec: (v) => `${v} 秒`,
  contextBlocks: (v) => (Number(v) === 0 ? '使わない' : `${v} 個`),
};

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range') return Number(el.value);
  if (el.dataset.setting === 'apiKey') return el.value.trim();
  if (el.dataset.setting?.endsWith('Model')) return el.value.trim() || 'auto';
  return el.value;
}

function writeField(el, value) {
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = value ?? '';
  updateRangeLabel(el);
}

function updateRangeLabel(el) {
  const key = el.dataset.setting;
  const out = document.querySelector(`output[data-for="${key}"]`);
  if (out && RANGE_LABEL[key]) out.textContent = RANGE_LABEL[key](el.value);
}

function bindSettingsForm() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    writeField(el, state.settings[el.dataset.setting]);
    const eventName = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(eventName, () => {
      updateRangeLabel(el);
      updateSetting(el.dataset.setting, readField(el));
    });
  }
}

async function updateSetting(key, value) {
  state.settings[key] = value;
  await saveSettings({ [key]: value });
  if (state.recorder && RECORDER_KEYS.includes(key)) state.recorder.updateOptions({ [key]: value });
  if (key === 'apiKey') {
    ui.keyStatus.textContent = '';
    ui.keyStatus.className = 'key-status';
    refreshBanner();
  }
}

function setKeyStatus(kind, text) {
  ui.keyStatus.className = `key-status ${kind}`;
  ui.keyStatus.textContent = text;
}

async function saveApiKey() {
  const key = ui.apiKey.value.trim();
  ui.apiKey.value = key;
  await updateSetting('apiKey', key);
  setKeyStatus(key ? 'ok' : '', key ? '保存しました' : 'キーを削除しました');
}

async function testConnection() {
  const key = ui.apiKey.value.trim();
  if (!key) {
    setKeyStatus('error', 'API キーを入力してください');
    ui.apiKey.focus();
    return;
  }
  await updateSetting('apiKey', key);
  setKeyStatus('', '確認中…');
  ui.testKey.disabled = true;
  try {
    const models = await listModels(key);
    fillModelList(models);
    const auto = pickAutoModel(models);
    ui.autoModelInfo.textContent = auto ? `現在の auto → ${auto}` : '';
    setKeyStatus('ok', `接続OK（${models.length} モデル利用可）`);
    // Warm the auto-model cache so the first block is fast.
    resolveModel(key, 'auto').catch(() => {});
  } catch (err) {
    setKeyStatus('error', errorMessage(err));
  } finally {
    ui.testKey.disabled = false;
  }
}

function fillModelList(models) {
  const options = [new Option('自動（最新の Flash 系）', 'auto')];
  const sorted = [...models].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
  for (const m of sorted) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.label = m.displayName || m.id;
    options.push(opt);
  }
  ui.modelList.replaceChildren(...options);
}

// ================================================================= popout

async function popOut() {
  if (state.recording) await stopRecording();
  await flushBlocks();
  await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html?mode=window'),
    type: 'popup',
    width: 440,
    height: 780,
  });
  window.close();
}

// ================================================================== init

function bindEvents() {
  ui.recordBtn.addEventListener('click', toggleRecording);
  ui.copyAllBtn.addEventListener('click', copyAll);
  ui.clearBtn.addEventListener('click', clearAll);
  ui.settingsBtn.addEventListener('click', openSettings);
  ui.emptySettings.addEventListener('click', openSettings);
  ui.settingsClose.addEventListener('click', closeSettings);
  ui.popoutBtn.addEventListener('click', popOut);
  ui.saveKey.addEventListener('click', saveApiKey);
  ui.testKey.addEventListener('click', testConnection);
  ui.toggleKey.addEventListener('click', () => {
    ui.apiKey.type = ui.apiKey.type === 'password' ? 'text' : 'password';
  });
  ui.apiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') testConnection();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ui.settingsView.hidden) closeSettings();
  });

  ui.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const el = btn.closest('.block');
    const b = state.blocks.find((x) => x.id === el?.dataset.id);
    if (!b) return;
    const v = getView(b.id);

    switch (btn.dataset.action) {
      case 'copy':
        copyBlock(b);
        break;
      case 'edit':
        startEdit(b);
        break;
      case 'edit-save':
        finishEdit(b, true);
        break;
      case 'edit-cancel':
        finishEdit(b, false);
        break;
      case 'diff':
        v.showDiff = !v.showDiff;
        renderBlock(b);
        break;
      case 'revert':
        b.edited = b.raw;
        b.copied = false;
        v.showDiff = false;
        renderBlock(b);
        updateChrome();
        persist();
        toast('原文に戻しました');
        break;
      case 'retry':
        retryBlock(b);
        break;
      case 'delete':
        deleteBlock(b);
        break;
      default:
        break;
    }
  });

  window.addEventListener('pagehide', () => {
    flushBlocks();
  });
}

async function init() {
  state.settings = await loadSettings();

  const stored = await loadBlocks();
  state.blocks = stored.map((b) => {
    if (b.status !== 'transcribing' && b.status !== 'correcting') return b;
    // The panel was closed mid-request.
    return b.raw
      ? { ...b, status: 'done' }
      : { ...b, status: 'error', error: { stage: 'transcribe', message: '処理中にパネルが閉じられたため中断されました。' } };
  });
  for (const b of state.blocks) renderBlock(b);

  if (new URLSearchParams(location.search).get('mode') === 'window') ui.popoutBtn.hidden = true;

  bindSettingsForm();
  bindEvents();
  refreshBanner();
  updateRecordUi();
  watchMicPermission();
  scrollToBottom();
  requestAnimationFrame(meterLoop);
}

init();
