// 生成指示用の添付ファイル（画像・動画・音声・テキスト・PDF・Word・PowerPoint）
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { getItem, mediaPath } from './media.js';
import { newId, readJson, writeJson, safeName, mimeFromName, kindOf } from './util.js';

const FILE = path.join(DIRS.data, 'attachments.json');
let attachments = readJson(FILE, []);
const save = () => writeJson(FILE, attachments);

const MAX_TEXT = 60000;

async function extractText(filePath, kind) {
  try {
    if (kind === 'text') {
      return fs.readFileSync(filePath, 'utf8').slice(0, MAX_TEXT);
    }
    if (kind === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const r = await mammoth.extractRawText({ path: filePath });
      return (r.value || '').slice(0, MAX_TEXT);
    }
    if (kind === 'pptx') {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const slides = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
      const parts = [];
      for (const [i, name] of slides.entries()) {
        const xml = await zip.file(name).async('string');
        const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]));
        // スピーカーノート
        const noteName = name.replace('slides/slide', 'notesSlides/notesSlide');
        let notes = '';
        if (zip.file(noteName)) {
          const nx = await zip.file(noteName).async('string');
          notes = [...nx.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(' ');
        }
        parts.push(`【スライド${i + 1}】${texts.join(' / ')}${notes ? `\n（ノート）${notes}` : ''}`);
      }
      return parts.join('\n').slice(0, MAX_TEXT);
    }
  } catch (e) {
    return `（テキスト抽出に失敗: ${e.message}）`;
  }
  return null;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function publicView(a) {
  const { path: _p, text, ...rest } = a;
  return { ...rest, textPreview: text ? text.slice(0, 300) : null, textLength: text ? text.length : 0 };
}

export async function addUploaded(file) {
  const id = newId('a_');
  const name = safeName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
  const mimeType = mimeFromName(name, file.mimetype);
  const kind = kindOf(mimeType, name);
  const dest = path.join(DIRS.uploads, `${id}${path.extname(name).toLowerCase()}`);
  fs.renameSync(file.path, dest);
  const a = { id, name, mimeType, kind, size: fs.statSync(dest).size, path: dest, origin: 'upload', createdAt: new Date().toISOString() };
  if (['text', 'docx', 'pptx'].includes(kind)) a.text = await extractText(dest, kind);
  if (kind === 'image' || kind === 'video') {
    const thumb = `${id}_thumb.jpg`;
    try {
      await runFfmpeg(['-i', dest, '-vf', 'scale=160:-2', '-frames:v', '1', path.join(DIRS.uploads, thumb)]);
      a.thumbUrl = `/uploads/${thumb}`;
    } catch {
      /* サムネイル無し */
    }
  }
  if (kind === 'video' || kind === 'audio') {
    try {
      const info = await probe(dest);
      a.duration = info.duration;
    } catch {
      /* ignore */
    }
  }
  attachments.push(a);
  save();
  return publicView(a);
}

/** ライブラリの素材を添付として使う（コピーせず参照） */
export function addFromLibrary(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error('ライブラリの素材が見つかりません');
  const a = {
    id: newId('a_'),
    name: item.name,
    mimeType: item.mimeType,
    kind: item.kind,
    size: item.size,
    path: mediaPath(item),
    origin: 'library',
    libraryItemId: item.id,
    duration: item.duration,
    thumbUrl: item.thumbUrl,
    createdAt: new Date().toISOString(),
  };
  attachments.push(a);
  save();
  return publicView(a);
}

export function getAttachment(id) {
  return attachments.find((a) => a.id === id) || null;
}

export function getAttachmentPublic(id) {
  const a = getAttachment(id);
  return a ? publicView(a) : null;
}

export function deleteAttachment(id) {
  const a = getAttachment(id);
  if (!a) return false;
  attachments = attachments.filter((x) => x.id !== id);
  save();
  if (a.origin === 'upload') {
    fs.rm(a.path, { force: true }, () => {});
    if (a.thumbUrl) fs.rm(path.join(DIRS.uploads, path.basename(a.thumbUrl)), { force: true }, () => {});
  }
  return true;
}
