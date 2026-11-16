// 設定とデータディレクトリの管理
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env を読み込む（存在する場合のみ）
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  /* .env が無い場合は無視 */
}

export const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
export const DIRS = {
  data: DATA_DIR,
  media: path.join(DATA_DIR, 'media'),
  uploads: path.join(DATA_DIR, 'uploads'),
  exports: path.join(DATA_DIR, 'exports'),
  tmp: path.join(DATA_DIR, 'tmp'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  apiKey: '',
  demoMode: false,
  // 既定モデル（画面のモデル一覧から変更可能）
  videoModel: 'gemini-omni-1.2-flash',
  textModel: 'gemini-flash-latest',
  ttsModel: 'gemini-3.8-flash-tts',
  // 添付の上限（APIの仕様変更に合わせて画面から変更可能）
  omniMaxImages: 10,
  omniMaxVideos: 3,
  veoMaxReferenceImages: 3,
  // Omni の 1 回あたりの最大秒数（0 = モデルに合わせて自動）
  omniMaxDuration: 0,
  // 生成ジョブのタイムアウト（分）
  generationTimeoutMin: 20,
};

let settings = { ...DEFAULT_SETTINGS };
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {
  /* 初回起動 */
}

if (process.argv.includes('--demo') || process.env.DEMO_MODE === '1') settings.demoMode = true;

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  const next = { ...settings };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k === 'apiKey' && (v === undefined || v === null || v === '__keep__')) continue;
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n) && (n > 0 || (n === 0 && k === 'omniMaxDuration'))) next[k] = n;
    } else if (typeof def === 'boolean') {
      next[k] = Boolean(v);
    } else {
      next[k] = String(v ?? '').trim();
    }
  }
  settings = next;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

export function getApiKey() {
  return settings.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function isDemo() {
  return Boolean(settings.demoMode);
}

export function publicSettings() {
  const key = getApiKey();
  return {
    ...settings,
    apiKey: '',
    hasApiKey: Boolean(key),
    apiKeySource: settings.apiKey ? 'settings' : key ? 'env' : 'none',
    apiKeyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
  };
}
