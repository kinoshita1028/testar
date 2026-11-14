// Settings and transcript persistence (chrome.storage.local = this browser only).

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '',
  transcribeModel: 'auto',
  correctModel: 'auto',
  language: 'ja',
  removeFillers: true,
  glossary: '',
  enableCorrection: true,
  contextBlocks: 6,
  silenceMs: 900,
  sensitivity: 60,
  maxSegmentSec: 20,
  autoCopy: false,
  copySeparator: 'newline',
});

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

const BLOCK_FIELDS = [
  'id', 'createdAt', 'durationMs', 'status', 'raw', 'corrected', 'edited',
  'changes', 'fixCount', 'error', 'copied', 'correctionSkipped',
];

export async function loadBlocks() {
  const { blocks } = await chrome.storage.local.get('blocks');
  return Array.isArray(blocks) ? blocks : [];
}

let saveTimer = null;
let pending = null;

export function saveBlocksSoon(blocks) {
  pending = blocks;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushBlocks, 300);
}

export function flushBlocks() {
  clearTimeout(saveTimer);
  if (!pending) return Promise.resolve();
  const data = pending.map((b) => Object.fromEntries(BLOCK_FIELDS.map((k) => [k, b[k] ?? null])));
  pending = null;
  return chrome.storage.local.set({ blocks: data });
}
