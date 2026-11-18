// マイボイス: 声のコピー（Voices API の replicated）と声のデザイン（prompted）
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, getSettings, isDemo } from './config.js';
import { fileToPart, generateText, rest } from './gemini.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { getItem, mediaPath } from './media.js';
import { newId, readJson, writeJson, HttpError } from './util.js';

const VOICE_DIR = path.join(DIRS.data, 'voices');
fs.mkdirSync(VOICE_DIR, { recursive: true });
const FILE = path.join(DIRS.data, 'voices.json');
let voices = readJson(FILE, []);
const save = () => writeJson(FILE, voices);

/**
 * 同意文。声の持ち主本人が、この文をそのまま読み上げた録音が必要。
 * 英語版は Google の公開資料で確認できた文。日本語版は公式の文と一字一句同じかを確認できていない。
 */
export const CONSENT_STATEMENTS = {
  'en-US': { label: '英語（確認済みの文）', text: 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.' },
  'ja-JP': { label: '日本語（公式の文と同一か未確認）', text: '私はこの音声の所有者であり、Google がこの音声を使用して音声合成モデルを作成することに同意します。' },
};

export function listVoices() {
  return voices;
}

export function getVoice(id) {
  return voices.find((v) => v.id === id) || null;
}

/** 音声を API 推奨の WAV（24kHz・モノラル・16bit）に変換 */
async function toWav(src, out, { start = 0, duration, denoise = false } = {}) {
  const info = await probe(src);
  if (!info.hasAudio) throw new HttpError(400, 'このファイルには音声が入っていません');
  const filters = denoise ? ['-af', 'highpass=f=80,lowpass=f=9000,afftdn=nf=-25'] : [];
  await runFfmpeg([
    ...(start ? ['-ss', String(start)] : []),
    ...(duration ? ['-t', String(duration)] : []),
    '-i', src, '-vn', ...filters, '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', out,
  ]);
  const len = (await probe(out)).duration || 0;
  return len;
}

/** 元の声（アップロード or ライブラリ）を切り出して WAV にする */
async function prepareSource({ sourceFile, sourceItemId, start, duration, denoise }) {
  let src = sourceFile?.path;
  let label = sourceFile ? Buffer.from(sourceFile.originalname, 'latin1').toString('utf8') : null;
  if (!src && sourceItemId) {
    const item = getItem(sourceItemId);
    if (!item) throw new HttpError(400, 'ライブラリの素材が見つかりません');
    src = mediaPath(item);
    label = item.name;
  }
  if (!src) throw new HttpError(400, '元になる声（動画か音声）を選んでください');
  const out = path.join(DIRS.tmp, `${newId('vsrc_')}.wav`);
  const len = await toWav(src, out, { start: Number(start) || 0, duration: Math.min(30, Math.max(3, Number(duration) || 20)), denoise });
  if (len < 3) throw new HttpError(400, `元の声が短すぎます（${len.toFixed(1)} 秒）。10〜30 秒くらい選んでください。`);
  return { wav: out, seconds: len, label };
}

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

function keepSample(id, wav) {
  const file = `${id}_sample.wav`;
  fs.copyFileSync(wav, path.join(VOICE_DIR, file));
  return `/voices/${file}`;
}

/**
 * 声をコピーする（本人の同意の録音が必須）
 */
export async function replicateVoice({ name, language = 'ja-JP', sourceFile, sourceItemId, start, duration, denoise, consentFile }) {
  if (!consentFile) throw new HttpError(400, '本人の同意の録音がありません');
  const tmp = [];
  try {
    const src = await prepareSource({ sourceFile, sourceItemId, start, duration, denoise });
    tmp.push(src.wav);
    const consentWav = path.join(DIRS.tmp, `${newId('vcon_')}.wav`);
    tmp.push(consentWav);
    const consentLen = await toWav(consentFile.path, consentWav, { duration: 60 });
    if (consentLen < 2) throw new HttpError(400, '同意の録音が短すぎます。同意文を最後まで読み上げて録音してください。');

    let created;
    if (isDemo()) {
      created = { id: `voice_demo${newId()}`, display_name: name };
    } else {
      created = await rest('POST', 'voices', {
        store: true,
        voice: {
          type: 'replicated',
          display_name: String(name || '').slice(0, 60) || 'マイボイス',
          ...(language ? { language_code: language } : {}),
          replicated: {
            source_audio: { data: b64(src.wav), mime_type: 'audio/wav' },
            consent_audio: { data: b64(consentWav), mime_type: 'audio/wav' },
          },
        },
      });
    }
    const id = created.id || created.key;
    if (!id) throw new Error('声の ID が返されませんでした');
    const voice = {
      id,
      name: name || created.display_name || 'マイボイス',
      type: 'replicated',
      language,
      sampleUrl: keepSample(id.replace(/[^\w-]/g, '_'), src.wav),
      source: { label: src.label, start: Number(start) || 0, seconds: src.seconds },
      expireTime: created.expire_time || null,
      createdAt: new Date().toISOString(),
    };
    voices.unshift(voice);
    save();
    return voice;
  } catch (e) {
    throw explainVoiceError(e);
  } finally {
    for (const f of tmp) fs.rm(f, { force: true }, () => {});
    for (const f of [sourceFile?.path, consentFile?.path]) if (f) fs.rm(f, { force: true }, () => {});
  }
}

/** 声の特徴を AI が文章にする（声のデザイン用） */
export async function describeVoice({ sourceFile, sourceItemId, start, duration, denoise }) {
  if (isDemo()) return '（デモ）30代の落ち着いた声。やや低めで、やわらかく、ゆっくりはっきり話す。';
  const src = await prepareSource({ sourceFile, sourceItemId, start, duration, denoise });
  try {
    const text = await generateText({
      model: getSettings().textModel,
      parts: [
        {
          text: `この音声で話している人の「声の特徴」を、音声合成の声づくり（Voice design）に使う説明文として書いてください。
- 性別の印象、年代、声の高さ、声質（明るい・低い・かすれ・やわらかい等）、話す速さ、抑揚、雰囲気・感情、なまりの有無を含める
- 実在の人物名や話している内容は書かない
- 日本語で 2〜3 文。説明文だけを出力`,
        },
        await fileToPart(src.wav, 'audio/wav', 'voice.wav'),
      ],
      temperature: 0.3,
    });
    return text.trim();
  } finally {
    fs.rm(src.wav, { force: true }, () => {});
    if (sourceFile?.path) fs.rm(sourceFile.path, { force: true }, () => {});
  }
}

/** 説明文から声を作る（声のデザイン） */
export async function designVoice({ name, description, baseVoice }) {
  if (!String(description || '').trim()) throw new HttpError(400, '声の説明を入力してください');
  let created;
  try {
    if (isDemo()) {
      created = { id: `voice_demo${newId()}`, display_name: name };
    } else {
      created = await rest('POST', 'voices', {
        store: true,
        voice: {
          type: 'prompted',
          display_name: String(name || '').slice(0, 60) || 'デザインした声',
          prompted: { input: description, ...(baseVoice ? { base_voice: baseVoice } : {}) },
        },
      });
    }
  } catch (e) {
    throw explainVoiceError(e);
  }
  const id = created.id;
  if (!id) throw new Error('声の ID が返されませんでした');
  let sampleUrl = null;
  if (created.sample_audio?.data) {
    const ext = String(created.sample_audio.mime_type || '').includes('mpeg') ? 'mp3' : 'wav';
    const file = `${id.replace(/[^\w-]/g, '_')}_sample.${ext}`;
    fs.writeFileSync(path.join(VOICE_DIR, file), Buffer.from(created.sample_audio.data, 'base64'));
    sampleUrl = `/voices/${file}`;
  }
  const voice = {
    id,
    name: name || created.display_name || 'デザインした声',
    type: 'prompted',
    description,
    sampleUrl,
    expireTime: created.expire_time || null,
    createdAt: new Date().toISOString(),
  };
  voices.unshift(voice);
  save();
  return voice;
}

export function renameVoice(id, name) {
  const v = getVoice(id);
  if (!v) throw new HttpError(404, '声が見つかりません');
  v.name = String(name || '').slice(0, 60) || v.name;
  save();
  return v;
}

export async function deleteVoice(id) {
  const v = getVoice(id);
  if (!isDemo() && /^voice_/.test(id) && !id.startsWith('voice_demo')) {
    try {
      await rest('DELETE', `voices/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status !== 404) throw explainVoiceError(e);
    }
  }
  voices = voices.filter((x) => x.id !== id);
  save();
  if (v?.sampleUrl) fs.rm(path.join(VOICE_DIR, path.basename(v.sampleUrl)), { force: true }, () => {});
  return true;
}

/** Google 側に保存されている声を取り込む（別の PC で作った声など） */
export async function syncVoices() {
  if (isDemo()) return voices;
  for (const type of ['replicated', 'prompted']) {
    let token = '';
    for (let page = 0; page < 10; page++) {
      const j = await rest('GET', `voices?type=${type}&page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
      for (const v of j.voices || []) {
        if (!v.id || getVoice(v.id)) continue;
        voices.push({ id: v.id, name: v.display_name || v.id, type: v.type || type, description: v.prompted?.input || v.description || '', sampleUrl: null, expireTime: v.expire_time || null, createdAt: new Date().toISOString(), imported: true });
      }
      if (!j.next_page_token && !j.nextPageToken) break;
      token = j.next_page_token || j.nextPageToken;
    }
  }
  save();
  return voices;
}

function explainVoiceError(e) {
  if (e instanceof HttpError) return e;
  const msg = e?.message || String(e);
  let hint = '';
  if (/consent/i.test(msg)) hint = '同意の録音が同意文と一致しないか、元の声と同じ人の声と判定されませんでした。本人が同意文をはっきり読み上げて録音し直してください。英語の同意文のほうが確実です。';
  else if (/region|location|country|not available|unsupported/i.test(msg)) hint = 'お使いの地域・アカウントでは声のコピーが使えない可能性があります。';
  else if (e?.status === 400) hint = '元の声の音質や長さが条件を満たしていない可能性があります。1 人だけが話している、BGM の少ない部分を 10〜30 秒選んでください。';
  else if (e?.status === 403) hint = 'API キーにこの機能の利用権限がありません（課金設定・利用規約を確認してください）。';
  else if (e?.status === 429) hint = '保存できる声の数や利用回数の上限に達した可能性があります。不要な声を削除するか、時間をおいてください。';
  else if (e?.status >= 500) hint = 'Google 側の一時的なエラーの可能性があります。少し時間をおいて再試行してください。';
  const err = new Error(`${hint ? `${hint}\n` : ''}API の応答: ${msg}`);
  err.status = e?.status && e.status < 500 ? e.status : 500;
  return err;
}
