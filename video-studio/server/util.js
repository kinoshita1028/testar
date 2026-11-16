import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function safeName(name, fallback = 'file') {
  const base = String(name || fallback)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || fallback).slice(0, 120);
}

const EXT_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/opus', '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.xml': 'text/xml', '.srt': 'text/plain', '.vtt': 'text/vtt',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.rtf': 'text/rtf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeFromName(name, given) {
  const ext = path.extname(name || '').toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  return given || 'application/octet-stream';
}

/** 添付ファイルの種類を判定 */
export function kindOf(mime, name = '') {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime)) return 'text';
  return 'other';
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
