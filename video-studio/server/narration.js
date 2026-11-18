// ナレーション: 原稿作成（映像を解析）→ 音声合成（Gemini TTS）→ 動画の長さに合わせる
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, getSettings, isDemo } from './config.js';
import { client, collectContent, fileToPart, generateText, rest } from './gemini.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { addMedia, getItem, mediaPath } from './media.js';
import { mockScript, mockTts } from './mock.js';
import { newId, sleep } from './util.js';

const RATE = { ja: { unit: '文字', perSec: 6 }, en: { unit: 'words', perSec: 2.6 }, other: { unit: '文字', perSec: 6 } };

function rateFor(language) {
  return RATE[language] || RATE.other;
}

export function measureText(text, language) {
  return language === 'en' ? String(text).trim().split(/\s+/).filter(Boolean).length : [...String(text).replace(/\s/g, '')].length;
}

function budget(duration, language) {
  const r = rateFor(language);
  return Math.max(5, Math.floor(duration * r.perSec * 0.92));
}

const LANG_NAME = { ja: '日本語', en: '英語', zh: '中国語', ko: '韓国語', es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語' };

function cleanScript(text) {
  return String(text)
    .replace(/^```[a-z]*\n?|```$/g, '')
    .replace(/^(ナレーション|原稿|Narration)\s*[:：]\s*/i, '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim();
}

/** 映像の一部を解析用の軽量動画にする */
async function makeProxyClip(srcFile, start, duration) {
  const out = path.join(DIRS.tmp, `${newId('proxy_')}.mp4`);
  await runFfmpeg([
    '-ss', String(Math.max(0, start)), '-t', String(duration), '-i', srcFile,
    '-vf', 'scale=-2:360,fps=12', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', out,
  ]);
  return out;
}

/**
 * ナレーション原稿を作る
 * @param {{duration:number, language?:string, style?:string, instruction?:string, model?:string,
 *          videoFile?:string, clipItemId?:string, clipIn?:number, renderTimeline?:()=>Promise<string>}} p
 */
export async function writeScript(p) {
  const language = p.language || 'ja';
  const duration = Number(p.duration) || 8;
  if (isDemo()) return mockScript(duration, language);
  const n = budget(duration, language);
  const r = rateFor(language);
  const parts = [];
  let proxy = null;
  try {
    if (p.clipItemId) {
      const item = getItem(p.clipItemId);
      if (item && item.kind === 'video') {
        proxy = await makeProxyClip(mediaPath(item), Number(p.clipIn) || 0, duration);
      } else if (item && item.kind === 'image') {
        parts.push(await fileToPart(mediaPath(item), item.mimeType, item.name));
      }
    } else if (p.renderTimeline) {
      proxy = await p.renderTimeline();
    }
    if (proxy) parts.push(await fileToPart(proxy, 'video/mp4', 'narration-proxy.mp4'));
    parts.unshift({
      text: `${parts.length ? `この映像（${duration.toFixed(1)}秒）に重ねる` : `${duration.toFixed(1)}秒の動画に重ねる`}ナレーション原稿を${LANG_NAME[language] || language}で書いてください。
- 普通の速さで読み上げて約${duration.toFixed(1)}秒で終わる長さにする（目安: ${n}${r.unit}以内）
- ${parts.length ? '映像の流れ・映っている内容に沿って、場面が変わるタイミングに合わせた構成にする' : '指定のテーマに沿う'}
- 出力は読み上げる原稿の本文のみ。タイトル、話者名、ト書き、括弧書き、絵文字、記号の箇条書きは入れない
${p.style ? `- 雰囲気・口調: ${p.style}\n` : ''}${p.instruction ? `- 追加の指示・伝えたい内容: ${p.instruction}\n` : ''}`,
    });
    const text = await generateText({ model: p.model || getSettings().textModel, parts, temperature: 0.7 });
    return cleanScript(text);
  } finally {
    if (proxy) fs.rm(proxy, { force: true }, () => {});
  }
}

async function rewriteToLength(script, targetCount, language, model) {
  const r = rateFor(language);
  const text = await generateText({
    model: model || getSettings().textModel,
    parts: [{ text: `次のナレーション原稿を、内容と口調を保ったまま約${targetCount}${r.unit}に${measureText(script, language) > targetCount ? '短く' : '少し長く'}書き直してください。出力は原稿の本文のみ。\n\n${script}` }],
    temperature: 0.4,
  });
  return cleanScript(text);
}

// ---- 音声合成 ----
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function writeAudio(b64data, mime = '', sampleRate, channels) {
  const buf = Buffer.from(b64data, 'base64');
  const m = mime.toLowerCase();
  let ext = '.wav';
  let data = buf;
  if (m.includes('mp3') || m.includes('mpeg')) ext = '.mp3';
  else if (m.includes('ogg') || m.includes('opus')) ext = '.ogg';
  else if (m.includes('wav') && buf.slice(0, 4).toString() === 'RIFF') ext = '.wav';
  else {
    // audio/L16;codec=pcm;rate=24000 など生PCM
    const rate = Number(/rate=(\d+)/.exec(m)?.[1]) || sampleRate || 24000;
    data = pcmToWav(buf, rate, channels || 1);
  }
  const out = path.join(DIRS.tmp, `${newId('tts_')}${ext}`);
  fs.writeFileSync(out, data);
  return out;
}

function ttsPrompt(text, style, language) {
  if (!style) return text;
  return language === 'en' ? `Read the following aloud in a ${style} tone:\n${text}` : `次の文章を「${style}」の雰囲気で読み上げてください:\n${text}`;
}

/** コピー・デザインした声（Voices API の ID）かどうか */
export function isCustomVoice(voice) {
  return /^(voice_|voicekey_)/.test(String(voice || ''));
}

/** TTS モデルのバージョン（例: gemini-3.8-flash-tts → 3.8）。不明なら新しいものとみなす */
function ttsVersion(model) {
  const m = /gemini-(\d+)\.(\d+)/.exec(String(model || ''));
  return m ? Number(m[1]) + Number(m[2]) / 10 : 99;
}

/** コピーした声は Gemini 3.8 TTS 以降でしか使えないので、必要ならモデルを切り替える */
export function resolveTtsModel(model, voice, warnings = []) {
  if (isCustomVoice(voice) && ttsVersion(model) < 3.8) {
    warnings.push(`コピー・デザインした声は Gemini 3.8 TTS 以降で使えるため、音声合成モデルを ${model} → gemini-3.8-flash-tts に切り替えました`);
    return 'gemini-3.8-flash-tts';
  }
  return model;
}

/**
 * 音声合成。
 * Gemini 3.8 TTS 以降は「本文はそのまま読み上げ、話し方は speechMetadata.style で指定」する方式。
 * それより前のモデルは本文の前に話し方の指示を書く方式。
 */
export async function synthesize({ text, model, voice, style, language }) {
  if (isDemo()) return mockTts(text);
  const ai = client();
  const modern = ttsVersion(model) >= 3.8;
  const voiceConfig = isCustomVoice(voice) ? { voice } : { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } };
  const call = (withStyle) =>
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [modern ? { text, ...(withStyle && style ? { speechMetadata: { style } } : {}) } : { text: ttsPrompt(text, style, language) }] }],
      config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig } },
    });
  try {
    let res;
    try {
      res = await call(true);
    } catch (e) {
      // speechMetadata を受け付けない場合は話し方の指定なしで再試行
      if (!(modern && style && /speech_?metadata|style/i.test(e?.message || ''))) throw e;
      res = await call(false);
    }
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error(`音声が返されませんでした${res.candidates?.[0]?.finishReason ? ` (${res.candidates[0].finishReason})` : ''}`);
    return writeAudio(part.inlineData.data, part.inlineData.mimeType);
  } catch (e) {
    if (!/interactions api/i.test(e?.message || '')) throw e;
    // Interactions API 専用の音声モデル
    let it = await rest('POST', 'interactions', {
      model,
      input: modern ? text : ttsPrompt(text, style, language),
      response_modalities: ['audio'],
      generation_config: { speech_config: [{ voice: voice || 'Kore', ...(language ? { language } : {}) }] },
    });
    for (let i = 0; i < 120 && ['in_progress', 'queued'].includes(it.status); i++) {
      await sleep(2000);
      it = await rest('GET', `interactions/${encodeURIComponent(it.id)}`);
    }
    const audio = collectContent(it).find((c) => c.type === 'audio' && c.data);
    if (!audio) throw new Error('音声が返されませんでした');
    return writeAudio(audio.data, audio.mime_type, audio.sample_rate, audio.channels);
  }
}

async function durationOf(file) {
  const info = await probe(file);
  return info.duration || 0;
}

/**
 * ナレーション音声を作って動画の長さに合わせ、ライブラリに追加する
 */
export async function generateNarration(p) {
  const settings = getSettings();
  const language = p.language || 'ja';
  const target = Number(p.targetDuration) || 0;
  const voice = p.voice || 'Kore';
  let script = String(p.script || '').trim();
  if (!script) throw new Error('ナレーション原稿が空です');
  const warnings = [];
  const model = resolveTtsModel(p.ttsModel || settings.ttsModel, voice, warnings);
  const tmp = [];
  let rewrites = 0;

  let file = await synthesize({ text: script, model, voice, style: p.style, language });
  tmp.push(file);
  let dur = await durationOf(file);

  if (target > 0 && p.autoRewrite !== false && !isDemo()) {
    for (let i = 0; i < 2; i++) {
      const ratio = dur / target;
      if (ratio <= 1.12 && ratio >= 0.6) break;
      const count = measureText(script, language);
      const nextCount = Math.max(5, Math.round(count * (target / dur) * (ratio > 1 ? 0.95 : 0.9)));
      script = await rewriteToLength(script, nextCount, language, p.textModel);
      rewrites++;
      file = await synthesize({ text: script, model, voice, style: p.style, language });
      tmp.push(file);
      dur = await durationOf(file);
    }
  }

  const rawDuration = dur;
  let tempo = 1;
  const out = path.join(DIRS.tmp, `${newId('narr_')}.wav`);
  const filters = [];
  if (target > 0 && p.fit !== 'none') {
    tempo = Math.min(2, Math.max(0.85, dur / target));
    if (Math.abs(tempo - 1) > 0.01) filters.push(`atempo=${tempo.toFixed(4)}`);
    if (dur / tempo > target + 0.05) {
      filters.push(`atrim=0:${target.toFixed(3)}`, `afade=t=out:st=${Math.max(0, target - 0.25).toFixed(3)}:d=0.25`);
      warnings.push('原稿が長すぎるため、末尾を少しカットしました。原稿を短くすると自然になります。');
    }
  }
  await runFfmpeg(['-i', file, ...(filters.length ? ['-af', filters.join(',')] : []), '-ar', '48000', '-ac', '2', out]);
  for (const f of tmp) fs.rm(f, { force: true }, () => {});
  if (tempo > 1.35) warnings.push(`読み上げ速度を ${tempo.toFixed(2)} 倍にしています。早口に感じる場合は原稿を短くしてください。`);

  const item = await addMedia(out, {
    name: `ナレーション_${script.slice(0, 16)}.wav`,
    source: 'narration',
    move: true,
    meta: { script, voice, voiceName: p.voiceName || voice, model, style: p.style || '', language, targetDuration: target, rawDuration, tempo, rewrites },
  });
  return { item, script, rawDuration, finalDuration: item.duration, tempo, rewrites, warnings };
}

/** クリップの元の音声を文字起こしする（話している内容だけ書き換えたいとき用） */
export async function transcribe({ itemId, start = 0, duration, language, model }) {
  if (isDemo()) return '（デモ）これは元の動画で話している内容の文字起こしです。ここを書き換えてナレーションにできます。';
  const item = getItem(itemId);
  if (!item) throw new Error('素材が見つかりません');
  if (!item.hasAudio) throw new Error('この素材には音声がありません');
  const out = path.join(DIRS.tmp, `${newId('stt_')}.mp3`);
  try {
    await runFfmpeg(['-ss', String(Math.max(0, Number(start) || 0)), ...(duration ? ['-t', String(duration)] : []), '-i', mediaPath(item), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
    const parts = [
      { text: `この音声で人が話している内容を、話した通りにそのまま文字起こししてください。${language && language !== 'ja' ? `（言語: ${LANG_NAME[language] || language}）` : ''}
- 出力は話した言葉だけ。話者名・時刻・効果音や BGM の説明・注釈は書かない
- 聞き取れない部分は推測せず省略する
- 人の声が無い場合は「（発話なし）」とだけ出力する` },
      await fileToPart(out, 'audio/mpeg', 'speech.mp3'),
    ];
    const text = await generateText({ model: model || getSettings().textModel, parts, temperature: 0 });
    return cleanScript(text);
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}
