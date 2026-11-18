// 映像と音声を分ける／声と BGM を分ける（結果はライブラリに保存して再利用する）
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { runFfmpeg } from './ffmpeg.js';
import { addMedia, getItem, listLibrary, mediaPath } from './media.js';
import { separateFile } from './separate.js';
import { createJob, logJob, runJob, updateJob } from './jobs.js';
import { newId, HttpError } from './util.js';

function findDerived(itemId, key, value) {
  return listLibrary().find((i) => i.meta?.[key] === itemId && (value === undefined || i.meta?.stem === value)) || null;
}

/** 動画から音声だけを取り出してライブラリに入れる（すでにあれば再利用） */
export async function extractAudio(itemId) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, '素材が見つかりません');
  if (item.kind !== 'video') throw new HttpError(400, '動画を選んでください');
  if (!item.hasAudio) throw new HttpError(400, 'この動画には音声が入っていません');
  const cached = findDerived(item.id, 'audioOf');
  if (cached) return { item: cached, cached: true };
  const out = path.join(DIRS.tmp, `${newId('aud_')}.m4a`);
  await runFfmpeg(['-i', mediaPath(item), '-vn', '-c:a', 'aac', '-b:a', '256k', out]);
  const audio = await addMedia(out, { name: `${item.name}（音声）.m4a`, source: 'separated', move: true, meta: { audioOf: item.id, stem: 'full' } });
  return { item: audio, cached: false };
}

const running = new Map(); // itemId -> Promise（同じ素材を同時に分離しない）

/** 声と BGM を分けてライブラリに入れる（すでにあれば再利用） */
export async function separateItem(itemId, { onProgress, highQuality = false } = {}) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, '素材が見つかりません');
  if (!item.hasAudio) throw new HttpError(400, 'この素材には音声が入っていません');
  const voice = findDerived(item.id, 'separatedFrom', 'voice');
  const background = findDerived(item.id, 'separatedFrom', 'background');
  if (voice && background) return { voice, background, cached: true };
  if (running.has(item.id)) return running.get(item.id);
  const p = (async () => {
    const r = await separateFile(mediaPath(item), { onProgress, highQuality });
    const v = await addMedia(r.voice, { name: `${item.name}（声）.wav`, source: 'separated', move: true, meta: { separatedFrom: item.id, stem: 'voice' } });
    const b = await addMedia(r.background, { name: `${item.name}（BGM・効果音）.wav`, source: 'separated', move: true, meta: { separatedFrom: item.id, stem: 'background' } });
    return { voice: v, background: b, cached: false };
  })();
  running.set(item.id, p);
  try {
    return await p;
  } finally {
    running.delete(item.id);
  }
}

/** 声と BGM の分離をジョブとして実行（画面に進み具合を出すため） */
export function startSeparation(itemId, { highQuality = false } = {}) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, '素材が見つかりません');
  if (!item.hasAudio) throw new HttpError(400, 'この素材には音声が入っていません');
  const job = createJob('separate', { itemId, name: item.name });
  return runJob(job, async () => {
    logJob(job, '準備しています…');
    const r = await separateItem(itemId, { highQuality, onProgress: (p, msg) => updateJob(job, { progress: p, message: msg || job.message }) });
    return { voice: r.voice, background: r.background, cached: r.cached, message: '完了' };
  });
}

/** アップロードされたファイルから声だけを取り出す（声のコピー用・一時ファイル） */
export async function isolateVoiceFile(file, onProgress) {
  const r = await separateFile(file, { onProgress });
  fs.rm(r.background, { force: true }, () => {});
  return r.voice;
}
