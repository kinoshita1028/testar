import { DEFAULT_SETTINGS, loadSettings, saveSettings, loadBlocks, saveBlocksSoon, flushBlocks } from './lib/storage.js';
import {
  transcribeAudio, transcribeWithTranscribeModel, correctText, listModels, resolveModel, pickAutoModel,
  languageCodesFor, vocabularyFrom,
} from './lib/gemini.js';
import { SpeechRecorder } from './lib/recorder.js';
import { LiveTranscriber } from './lib/live.js';
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
  liveText: $('#liveText'),
  generateModelLabel: $('#generateModelLabel'),
  liveModelList: $('#liveModelList'),
  transcribeModelList: $('#transcribeModelList'),
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
  // real-time (Live API) session
  live: null,
  liveStatus: 'off', // off | connecting | ready | reconnecting | failed
  currentTurn: null,
  transcribeModelBroken: '',
};

// One entry per utterance while the Live API works on it.
const turns = new Map(); // turn id -> { id, session, text, block, discarded, failed, pendingFinal, resolve }
const ENGINE_LABEL = { live: 'Live', transcribe: 'Transcribe', generate: 'Flash' };
const LIVE_SETUP_KEYS = ['transcribeEngine', 'liveModel', 'language', 'glossary', 'removeFillers'];

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
  const engineEl = $('.block-engine', el);
  engineEl.textContent = ENGINE_LABEL[b.engine] || '';
  engineEl.title = b.engine === 'live' ? 'リアルタイム文字起こし' : b.engine === 'transcribe' ? '文字起こし専用モデル' : '汎用 Flash モデル';

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
  if (b.info) return [b.info, 'is-info'];
  return ['', ''];
}

function bodyNodes(b, v) {
  if (b.status === 'transcribing' && b.liveText) {
    const span = document.createElement('span');
    span.className = 'pending-text';
    span.textContent = b.liveText;
    return [span];
  }
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

function newBlock(seg) {
  return {
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
    engine: null,
    info: null,
    liveText: '',
  };
}

// Speech started: open a turn on the Live session (if one is ready).
function handleSpeechStart({ startedAt, preRoll }) {
  const turn = { id: uid(), startedAt, session: null, text: '', block: null };
  turns.set(turn.id, turn);
  state.currentTurn = turn;
  const live = state.live;
  if (live && !live.dead && !live.closing) {
    turn.session = live;
    live.startTurn(turn.id);
    live.appendAudio(preRoll);
  }
  setLiveText('');
}

function handleSpeechFrame(frame) {
  const turn = state.currentTurn;
  if (turn?.session && !turn.failed) turn.session.appendAudio(frame);
}

// Speech ended (the speaker paused): this becomes a block.
function handleSegment(seg) {
  const turn = state.currentTurn;
  state.currentTurn = null;
  setLiveText('');
  if (turn?.session) turn.session.endTurn(turn.id);

  if (seg.discarded) {
    if (turn) {
      turn.discarded = true;
      if (!turn.session) turns.delete(turn.id);
    }
    return;
  }

  const stick = isNearBottom();
  const b = newBlock(seg);
  state.blocks.push(b);
  audioStore.set(b.id, bytesToBase64(encodeWav(seg.samples, seg.sampleRate)));
  while (audioStore.size > MAX_AUDIO_KEPT) audioStore.delete(audioStore.keys().next().value);

  if (turn?.session) {
    b.engine = 'live';
    b.liveText = turn.text;
    turn.block = b;
    let resolve;
    const done = new Promise((r) => {
      resolve = r;
    });
    turn.resolve = resolve;
    enqueueCorrection(b, done);
    if (turn.pendingFinal) applyLiveFinal(turn, turn.pendingFinal.text, turn.pendingFinal.info);
    else if (turn.failed) fallbackTurn(turn);
  } else {
    if (turn) turns.delete(turn.id);
    runPipeline(b);
  }

  renderBlock(b);
  updateChrome();
  if (stick) scrollToBottom();
  persist();
}

function enqueueCorrection(b, transcribed) {
  state.correctionChain = state.correctionChain
    .then(() => transcribed)
    .then((needsCorrection) => (needsCorrection ? correctBlock(b) : null))
    .catch((err) => console.error(err));
}

function runPipeline(b) {
  enqueueCorrection(b, transcribeBlock(b));
}

function alive(b) {
  return state.blocks.includes(b);
}

function previousBlocks(b) {
  const idx = state.blocks.indexOf(b);
  return state.blocks.slice(0, Math.max(0, idx)).filter((x) => finalText(x));
}

// A transcript is ready for block b: store it and say whether to correct it next.
function applyTranscript(b, text) {
  if (!alive(b)) return false;
  if (!text) {
    // Nothing intelligible (noise, a cough...): drop the block quietly.
    deleteBlock(b, { quiet: true });
    return false;
  }
  b.raw = text;
  b.liveText = '';
  b.corrected = null;
  b.changes = [];
  b.fixCount = 0;
  b.correctionSkipped = false;
  b.error = null;
  if (state.settings.enableCorrection) {
    b.status = 'correcting';
    renderBlock(b);
    updateChrome();
    persist();
    return true;
  }
  finishBlock(b);
  return false;
}

function isPermanentError(err) {
  return [400, 403, 404].includes(err?.status);
}

// Block-by-block transcription (also the fallback for the real-time engine).
async function transcribeBlock(b, { engine } = {}) {
  const audio = audioStore.get(b.id);
  if (!audio) {
    b.status = 'error';
    b.error = { stage: 'transcribe', message: '音声データが残っていないため再試行できません。' };
    renderBlock(b);
    persist();
    return false;
  }

  const s = state.settings;
  const useEngine = engine || (s.transcribeEngine === 'transcribe' ? 'transcribe' : 'generate');
  b.status = 'transcribing';
  b.error = null;
  renderBlock(b);
  updateChrome();

  const prev = previousBlocks(b).slice(-1)[0];
  const viaFlash = () => transcribeAudio({
    apiKey: s.apiKey,
    model: s.transcribeModel,
    audioBase64: audio,
    language: s.language,
    removeFillers: s.removeFillers,
    glossary: s.glossary,
    prevText: prev ? finalText(prev).slice(-200) : '',
  });

  try {
    let text;
    if (useEngine === 'transcribe' && !state.transcribeModelBroken) {
      try {
        text = await transcribeWithTranscribeModel({
          apiKey: s.apiKey,
          model: s.transcribeBatchModel,
          audioBase64: audio,
          language: s.language,
          smart: s.removeFillers,
          glossary: s.glossary,
        });
        b.engine = 'transcribe';
      } catch (err) {
        if (!isPermanentError(err)) throw err;
        state.transcribeModelBroken = errorMessage(err);
        toast('文字起こし専用モデルが使えないため、汎用 Flash モデルに切り替えました', 'warn');
      }
    }
    if (text === undefined) {
      text = await viaFlash();
      b.engine = 'generate';
      if (useEngine === 'transcribe' && state.transcribeModelBroken) {
        b.info = `専用モデルが使えなかったため汎用 Flash で文字起こし（${state.transcribeModelBroken}）`;
      }
    }
    return applyTranscript(b, text);
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

// ------------------------------------------------------- real-time engine

function setLiveText(text) {
  ui.liveText.textContent = text;
  ui.liveText.hidden = !text;
}

function onLiveInterim(id, text) {
  const turn = turns.get(id);
  if (!turn || turn.discarded) return;
  turn.text = text;
  if (turn.block) {
    if (turn.block.status === 'transcribing' && alive(turn.block)) {
      turn.block.liveText = text;
      renderBlock(turn.block);
    }
  } else if (state.currentTurn === turn) {
    const stick = isNearBottom();
    setLiveText(text);
    if (stick) scrollToBottom();
  }
}

function onLiveFinal(id, text, info) {
  const turn = turns.get(id);
  if (!turn) return;
  if (turn.discarded) {
    turns.delete(id);
    return;
  }
  if (!turn.block) {
    turn.pendingFinal = { text, info };
    return;
  }
  applyLiveFinal(turn, text, info);
}

function applyLiveFinal(turn, text, info) {
  turns.delete(turn.id);
  const b = turn.block;
  if (!alive(b)) {
    turn.resolve(false);
    return;
  }
  if (text) {
    turn.resolve(applyTranscript(b, text));
  } else if (info.hadInterim || turn.text || b.durationMs > 1500) {
    fallbackTurn(turn, info.timedOut ? 'リアルタイムの確定結果が届かなかったため' : 'リアルタイムで結果が得られなかったため');
  } else {
    turn.resolve(applyTranscript(b, ''));
  }
}

function onLiveTurnFailed(id) {
  const turn = turns.get(id);
  if (!turn) return;
  if (turn.discarded) {
    turns.delete(id);
    return;
  }
  if (!turn.block) {
    turn.failed = true; // handled when the speaker pauses
    return;
  }
  fallbackTurn(turn);
}

function fallbackTurn(turn, why = 'リアルタイム接続が切れたため') {
  turns.delete(turn.id);
  const b = turn.block;
  if (!alive(b)) {
    turn.resolve(false);
    return;
  }
  b.info = `${why}、予備モデルで文字起こししました`;
  transcribeBlock(b, { engine: 'generate' }).then(turn.resolve);
}

function startLiveSession() {
  const s = state.settings;
  const session = new LiveTranscriber({
    apiKey: s.apiKey,
    model: (s.liveModel || DEFAULT_SETTINGS.liveModel).trim(),
    languageCodes: languageCodesFor(s.language),
    customVocabulary: vocabularyFrom(s.glossary),
    mode: s.removeFillers ? 'SMART' : 'VERBATIM',
    onInterim: onLiveInterim,
    onFinal: onLiveFinal,
    onTurnFailed: onLiveTurnFailed,
    onStatus: (status, message) => {
      if (state.live !== session) return;
      state.liveStatus = status;
      if (status === 'failed' && state.recording) {
        toast(`リアルタイム接続に失敗：${message || '不明なエラー'}　ブロック単位で続けます`, 'error');
      }
    },
  });
  state.live = session;
  state.liveStatus = 'connecting';
  session.start().catch(() => {
    /* reported through onStatus */
  });
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
    onSpeechStart: handleSpeechStart,
    onSpeechFrame: handleSpeechFrame,
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

  if (s.transcribeEngine === 'live') startLiveSession();
  else state.liveStatus = 'off';
}

async function stopRecording() {
  const rec = state.recorder;
  state.recorder = null;
  state.recording = false;
  state.level = null;
  if (rec) await rec.stop({ flush: true });
  const live = state.live;
  state.live = null;
  state.liveStatus = 'off';
  live?.closeWhenIdle(9000);
  ui.liveCard.hidden = true;
  setLiveText('');
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

function engineStatusText() {
  if (state.settings.transcribeEngine !== 'live') return 'ブロック単位';
  switch (state.liveStatus) {
    case 'ready':
      return 'リアルタイム';
    case 'connecting':
      return 'リアルタイム接続中…';
    case 'reconnecting':
      return 'リアルタイム再接続中…';
    case 'failed':
      return 'ブロック単位（リアルタイム接続失敗）';
    default:
      return 'リアルタイム';
  }
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
      setStatus('listening', `聞き取り中 · ${engineStatusText()}`);
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
  if (el.type === 'radio') return el.value;
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range') return Number(el.value);
  if (el.dataset.setting === 'apiKey') return el.value.trim();
  if (el.dataset.setting?.endsWith('Model')) return el.value.trim() || 'auto';
  return el.value;
}

function writeField(el, value) {
  if (el.type === 'radio') el.checked = el.value === value;
  else if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = value ?? '';
  updateRangeLabel(el);
}

function updateRangeLabel(el) {
  const key = el.dataset.setting;
  const out = document.querySelector(`output[data-for="${key}"]`);
  if (out && RANGE_LABEL[key]) out.textContent = RANGE_LABEL[key](el.value);
}

function bindSettingsForm() {
  updateEngineFields();
  for (const el of document.querySelectorAll('[data-setting]')) {
    writeField(el, state.settings[el.dataset.setting]);
    const eventName = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(eventName, () => {
      updateRangeLabel(el);
      updateSetting(el.dataset.setting, readField(el));
    });
  }
}

function updateEngineFields() {
  const engine = state.settings.transcribeEngine;
  for (const el of document.querySelectorAll('[data-engine]')) el.hidden = el.dataset.engine !== engine;
  ui.generateModelLabel.textContent = engine === 'generate' ? '文字起こし用（汎用 Flash）' : '汎用 Flash（予備・自動切り替え用）';
}

async function updateSetting(key, value) {
  state.settings[key] = value;
  await saveSettings({ [key]: value });
  if (state.recorder && RECORDER_KEYS.includes(key)) state.recorder.updateOptions({ [key]: value });
  if (key === 'transcribeEngine') updateEngineFields();
  if (key === 'transcribeBatchModel') state.transcribeModelBroken = '';
  if (state.recording && LIVE_SETUP_KEYS.includes(key)
      && (key === 'transcribeEngine' || state.settings.transcribeEngine === 'live')) {
    toast('この変更は次に録音を開始したときに反映されます');
  }
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
    const ids = new Set(models.map((m) => m.id));
    const liveModel = (state.settings.liveModel || DEFAULT_SETTINGS.liveModel).trim();
    const batchModel = (state.settings.transcribeBatchModel || DEFAULT_SETTINGS.transcribeBatchModel).trim();
    const mark = (id) => (ids.has(id) ? '✓' : '（一覧に無し・そのまま試せます）');
    ui.autoModelInfo.textContent = [
      auto ? `現在の auto → ${auto}` : '',
      `リアルタイム：${liveModel} ${mark(liveModel)}`,
      `専用：${batchModel} ${mark(batchModel)}`,
    ].filter(Boolean).join(' / ');
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
  const sorted = [...models].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
  const toOptions = (list, first = []) => [
    ...first,
    ...list.map((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.label = m.displayName || m.id;
      return opt;
    }),
  ];
  const isTranscribe = (m) => /transcribe/i.test(m.id);
  const isLive = (m) => m.methods.includes('bidiGenerateContent') || /live/i.test(m.id);
  ui.modelList.replaceChildren(...toOptions(
    sorted.filter((m) => m.methods.includes('generateContent') && !isTranscribe(m)),
    [new Option('自動（最新の Flash 系）', 'auto')],
  ));
  const live = sorted.filter((m) => isLive(m) && isTranscribe(m));
  ui.liveModelList.replaceChildren(...toOptions(live.length ? live : sorted.filter(isLive), live.length ? [] : [new Option('', DEFAULT_SETTINGS.liveModel)]));
  const batch = sorted.filter((m) => isTranscribe(m) && !isLive(m));
  ui.transcribeModelList.replaceChildren(...toOptions(batch, batch.length ? [] : [new Option('', DEFAULT_SETTINGS.transcribeBatchModel)]));
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
