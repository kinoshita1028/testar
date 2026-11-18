// Gemini API 共通処理（クライアント・REST・モデル一覧・Files API）
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GoogleGenAI } from '@google/genai';
import { getApiKey } from './config.js';
import { sleep } from './util.js';
import { DEFAULT_TEXT_MODELS, DEFAULT_TTS_MODELS, DEFAULT_VIDEO_MODELS } from '../public/js/shared/capabilities.js';

export const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function requireKey() {
  const key = getApiKey();
  if (!key) throw new ApiError(401, 'Gemini API キーが設定されていません。右上の「設定」から入力してください（またはデモモードを有効にしてください）。');
  return key;
}

let cachedClient = null;
let cachedKey = null;
export function client() {
  const key = requireKey();
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new GoogleGenAI({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

/** SDK / REST のエラーを日本語の分かりやすいメッセージにする */
export function friendlyError(e) {
  const status = e?.status ?? e?.code ?? e?.response?.status;
  let msg = e?.message || String(e);
  try {
    const j = JSON.parse(msg.replace(/^[^{]*/, ''));
    if (j?.error?.message) msg = j.error.message;
  } catch {
    /* JSON ではない */
  }
  const hints = {
    400: 'リクエスト内容がモデルに受け付けられませんでした',
    401: 'APIキーが無効です',
    403: 'APIキーにこのモデルの利用権限がありません（課金設定や利用規約の同意を確認してください）',
    404: 'モデルが見つかりません（モデルIDを確認してください）',
    429: '利用上限（レート制限/クォータ）に達しました。しばらく待ってから再試行してください',
    500: 'Gemini API 側でエラーが発生しました',
    503: 'Gemini API が混雑しています。しばらく待ってから再試行してください',
  };
  const hint = hints[status];
  return hint ? `${hint}: ${msg}` : msg;
}

export async function rest(method, pathOrUrl, body, { signal } = {}) {
  const key = requireKey();
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : `${API_BASE}/${pathOrUrl.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method,
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* JSON 以外 */
  }
  if (!res.ok) {
    const message = json?.error?.message || text.slice(0, 800) || res.statusText;
    throw new ApiError(res.status, message, json);
  }
  return json;
}

// ---- モデル一覧 ----
function versionScore(id) {
  const m = id.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2] || 0);
}

function sortModels(list, preferred = []) {
  return list.sort((a, b) => {
    const pa = preferred.findIndex((p) => a.id.includes(p));
    const pb = preferred.findIndex((p) => b.id.includes(p));
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    const latestA = a.id.includes('latest') ? 1 : 0;
    const latestB = b.id.includes('latest') ? 1 : 0;
    if (latestA !== latestB) return latestB - latestA;
    return versionScore(b.id) - versionScore(a.id) || a.id.localeCompare(b.id);
  });
}

let modelCache = null;

export async function listModels({ refresh = false } = {}) {
  const defaults = {
    video: DEFAULT_VIDEO_MODELS.map((m) => ({ ...m, protocol: m.id.includes('veo') ? 'veo' : 'interactions' })),
    text: DEFAULT_TEXT_MODELS,
    tts: DEFAULT_TTS_MODELS,
    source: 'default',
  };
  if (!getApiKey()) return { ...defaults, error: 'APIキー未設定のため既定の候補を表示しています' };
  if (modelCache && !refresh) return modelCache;
  try {
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const j = await rest('GET', `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      all.push(...(j.models || []));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    const video = [];
    const text = [];
    const tts = [];
    for (const m of all) {
      const id = String(m.name || '').replace(/^models\//, '');
      const lower = id.toLowerCase();
      const methods = m.supportedGenerationMethods || [];
      const entry = { id, label: m.displayName || id, description: m.description || '' };
      if (lower.includes('veo') || lower.includes('omni')) {
        video.push({ ...entry, protocol: lower.includes('veo') ? 'veo' : 'interactions' });
      } else if (lower.includes('tts')) {
        tts.push(entry);
      } else if (
        methods.includes('generateContent') &&
        !/(image|embedding|aqa|imagen|lyria|robotics|live|native-audio|transcribe|learnlm|gemma|computer-use|banana|nano)/.test(lower)
      ) {
        text.push(entry);
      }
    }
    modelCache = {
      video: video.length ? sortModels(video, ['omni', 'veo-3.1', 'veo']) : defaults.video,
      text: text.length ? sortModels(text, ['flash-latest', 'pro-latest']) : defaults.text,
      tts: tts.length ? sortModels(tts) : defaults.tts,
      source: 'api',
      fetchedAt: new Date().toISOString(),
    };
    return modelCache;
  } catch (e) {
    return { ...defaults, error: `モデル一覧を取得できませんでした: ${friendlyError(e)}` };
  }
}

// ---- Files API ----
const uploadCache = new Map(); // `${path}:${mtime}` -> { uri, mimeType, expires }

/** ローカルファイルを Files API にアップロードし、処理完了（ACTIVE）まで待つ */
export async function uploadFile(localPath, mimeType, displayName) {
  const st = fs.statSync(localPath);
  const cacheKey = `${localPath}:${st.mtimeMs}:${st.size}`;
  const hit = uploadCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit;
  const ai = client();
  let file = await ai.files.upload({ file: localPath, config: { mimeType, displayName: (displayName || 'upload').slice(0, 100) } });
  const started = Date.now();
  while (file.state && String(file.state).toUpperCase() === 'PROCESSING') {
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('Files API の処理がタイムアウトしました');
    await sleep(3000);
    file = await ai.files.get({ name: file.name });
  }
  if (String(file.state).toUpperCase() === 'FAILED') throw new Error(`Files API でファイル処理に失敗しました: ${displayName}`);
  const out = { uri: file.uri, mimeType: file.mimeType || mimeType, name: file.name, expires: Date.now() + 40 * 3600 * 1000 };
  uploadCache.set(cacheKey, out);
  return out;
}

/** files/xxx 形式の URI を ACTIVE になるまで待つ */
async function waitFileActive(uri) {
  const m = /\/?(files\/[^/:?]+)/.exec(uri);
  if (!m) return;
  for (let i = 0; i < 200; i++) {
    let meta;
    try {
      meta = await rest('GET', m[1]);
    } catch {
      return;
    }
    const state = String(meta.state || '').toUpperCase();
    if (!state || state === 'ACTIVE') return;
    if (state === 'FAILED') throw new Error('生成ファイルの処理に失敗しました');
    await sleep(3000);
  }
}

/** Gemini の files URI からダウンロード */
export async function downloadUri(uri, dest) {
  const key = requireKey();
  let url = uri;
  if (!/^https?:/.test(url)) url = `${API_BASE}/${url.replace(/^\//, '')}`;
  if (/\/files\/[^/:?]+$/.test(url)) {
    await waitFileActive(url);
    url += ':download?alt=media';
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'x-goog-api-key': key }, redirect: 'follow' });
    if (res.ok && res.body) {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return dest;
    }
    lastErr = new ApiError(res.status, `動画のダウンロードに失敗しました (${res.status}) ${(await res.text()).slice(0, 300)}`);
    if (res.status === 404 || res.status === 409 || res.status >= 500) {
      await sleep(4000);
      continue;
    }
    break;
  }
  throw lastErr;
}

/** generateContent 用に添付ファイルを Part にする（小さいものはインライン、大きいものは Files API） */
export async function fileToPart(localPath, mimeType, name, { inlineLimit = 14 * 1024 * 1024 } = {}) {
  const size = fs.statSync(localPath).size;
  if (size <= inlineLimit) {
    return { inlineData: { mimeType, data: fs.readFileSync(localPath).toString('base64') } };
  }
  const f = await uploadFile(localPath, mimeType, name);
  return { fileData: { fileUri: f.uri, mimeType: f.mimeType } };
}

/** テキストモデル呼び出し（generateContent。Interactions 専用モデルなら Interactions にフォールバック） */
export async function generateText({ model, parts, system, json = false, schema, temperature = 0.8 }) {
  const ai = client();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: system,
        temperature,
        ...(json ? { responseMimeType: 'application/json', ...(schema ? { responseSchema: schema } : {}) } : {}),
      },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
    if (!text) {
      const reason = res.promptFeedback?.blockReason || res.candidates?.[0]?.finishReason;
      throw new Error(`テキストが返されませんでした${reason ? ` (${reason})` : ''}`);
    }
    return text;
  } catch (e) {
    if (!/interactions api/i.test(e?.message || '')) throw e;
    // Interactions API のみ対応のモデル
    const input = parts.map((p) =>
      p.text !== undefined
        ? { type: 'text', text: p.text }
        : p.inlineData
          ? { type: kindFromMime(p.inlineData.mimeType), data: p.inlineData.data, mime_type: p.inlineData.mimeType }
          : { type: kindFromMime(p.fileData.mimeType), uri: p.fileData.fileUri, mime_type: p.fileData.mimeType },
    );
    const body = { model, input, ...(system ? { system_instruction: system } : {}), generation_config: { temperature } };
    if (json) body.response_format = { type: 'text', mime_type: 'application/json', ...(schema ? { schema: toJsonSchema(schema) } : {}) };
    const r = await rest('POST', 'interactions', body);
    const texts = collectContent(r).filter((c) => c.type === 'text').map((c) => c.text);
    if (!texts.length) throw new Error('テキストが返されませんでした');
    return texts.join('');
  }
}

export function kindFromMime(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  return 'document';
}

function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') out.type = String(v).toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

/** Interaction レスポンスから model_output のコンテンツを全部集める（steps / outputs の両形式に対応） */
export function collectContent(interaction) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || typeof c !== 'object') return;
    const k = `${c.type}:${c.uri || ''}:${(c.data || '').slice(0, 64)}:${(c.text || '').slice(0, 64)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const step of interaction?.steps || []) {
    if (step.type === 'model_output') for (const c of step.content || []) push(c);
  }
  for (const c of interaction?.outputs || []) push(c);
  for (const k of ['output_video', 'output_audio', 'output_image']) if (interaction?.[k]) push(interaction[k]);
  return out;
}
