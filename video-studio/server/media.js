// メディアライブラリ（生成動画・読み込んだ素材・ナレーション音声）
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { newId, readJson, writeJson, safeName, mimeFromName, kindOf } from './util.js';

const LIB_FILE = path.join(DIRS.data, 'library.json');
let library = readJson(LIB_FILE, []);

function save() {
  writeJson(LIB_FILE, library);
}

export function listLibrary() {
  return library;
}

export function getItem(id) {
  return library.find((i) => i.id === id) || null;
}

export function mediaPath(item) {
  return path.join(DIRS.media, item.file);
}

export function updateItem(id, patch) {
  const item = getItem(id);
  if (!item) return null;
  const allowed = ['name', 'meta'];
  for (const k of allowed) if (k in patch) item[k] = k === 'meta' ? { ...item.meta, ...patch.meta } : String(patch[k]).slice(0, 200);
  save();
  return item;
}

export function deleteItem(id) {
  const item = getItem(id);
  if (!item) return false;
  library = library.filter((i) => i.id !== id);
  save();
  for (const f of [item.file, item.thumb, item.wave]) {
    if (!f) continue;
    fs.rm(path.join(DIRS.media, f), { force: true }, () => {});
  }
  return true;
}

async function makeThumb(src, id, info, kind) {
  const thumb = `${id}_thumb.jpg`;
  const out = path.join(DIRS.media, thumb);
  try {
    if (kind === 'image') {
      await runFfmpeg(['-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', out]);
    } else {
      const t = info.duration ? Math.min(1, info.duration / 3) : 0;
      await runFfmpeg(['-ss', String(t), '-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', out]);
    }
    return thumb;
  } catch {
    return null;
  }
}

async function makeWave(src, id) {
  const wave = `${id}_wave.png`;
  try {
    await runFfmpeg([
      '-i', src,
      '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=#9ad0ff:scale=sqrt',
      '-frames:v', '1', path.join(DIRS.media, wave),
    ]);
    return wave;
  } catch {
    return null;
  }
}

/**
 * ファイルをライブラリに登録する（ファイルは media ディレクトリへ移動/コピー）
 * @param {string} srcPath
 * @param {{name?:string, source:string, meta?:object, move?:boolean, mimeType?:string}} opts
 */
export async function addMedia(srcPath, opts) {
  const id = newId('m_');
  const origName = opts.name || path.basename(srcPath);
  const mime = mimeFromName(origName, opts.mimeType);
  let kind = kindOf(mime, origName);
  if (!['video', 'audio', 'image'].includes(kind)) throw new Error(`タイムラインで使えない形式です: ${origName}`);
  const ext = path.extname(origName).toLowerCase() || (kind === 'video' ? '.mp4' : kind === 'audio' ? '.wav' : '.png');
  const file = `${id}${ext}`;
  const dest = path.join(DIRS.media, file);
  if (opts.move) {
    try {
      fs.renameSync(srcPath, dest);
    } catch {
      fs.copyFileSync(srcPath, dest);
      fs.rmSync(srcPath, { force: true });
    }
  } else {
    fs.copyFileSync(srcPath, dest);
  }

  let info;
  try {
    info = await probe(dest);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw new Error(`メディアを読み込めませんでした (${origName}): ${e.message}`);
  }
  // 動画コンテナでも映像が無いものは音声扱い
  if (kind === 'video' && !info.hasVideo && info.hasAudio) kind = 'audio';
  if (kind === 'video' && !info.hasVideo) {
    fs.rmSync(dest, { force: true });
    throw new Error(`映像トラックが見つかりません: ${origName}`);
  }

  const item = {
    id,
    kind,
    name: safeName(path.parse(origName).name, kind),
    file,
    url: `/media/${file}`,
    mimeType: mime,
    size: fs.statSync(dest).size,
    duration: kind === 'image' ? null : info.duration,
    width: info.width,
    height: info.height,
    hasAudio: kind === 'image' ? false : info.hasAudio,
    source: opts.source || 'upload',
    meta: opts.meta || {},
    createdAt: new Date().toISOString(),
  };
  if (kind !== 'audio') {
    const thumb = await makeThumb(dest, id, info, kind);
    if (thumb) {
      item.thumb = thumb;
      item.thumbUrl = `/media/${thumb}`;
    }
  }
  if (item.hasAudio) {
    const wave = await makeWave(dest, id);
    if (wave) {
      item.wave = wave;
      item.waveUrl = `/media/${wave}`;
    }
  }
  library.unshift(item);
  save();
  return item;
}
