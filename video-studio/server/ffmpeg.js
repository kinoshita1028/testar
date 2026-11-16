// ffmpeg / ffprobe の検出と実行ヘルパー
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

async function resolveBinary(envName, pkgName, pick, fallback) {
  const candidates = [];
  if (process.env[envName]) candidates.push(process.env[envName]);
  try {
    const mod = await import(pkgName);
    const p = pick(mod.default ?? mod);
    if (p) candidates.push(p);
  } catch {
    /* optional dependency が無い */
  }
  candidates.push(fallback);
  for (const c of candidates) {
    try {
      if (c !== fallback && !fs.existsSync(c)) continue;
      const r = spawnSync(c, ['-version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return { path: c, version: (r.stdout || '').split('\n')[0] };
    } catch {
      /* 次の候補へ */
    }
  }
  return { path: null, version: null };
}

export const FFMPEG = await resolveBinary('FFMPEG_PATH', 'ffmpeg-static', (m) => (typeof m === 'string' ? m : m?.path), 'ffmpeg');
export const FFPROBE = await resolveBinary('FFPROBE_PATH', 'ffprobe-static', (m) => m?.path, 'ffprobe');

export function ffmpegStatus() {
  return { ok: Boolean(FFMPEG.path && FFPROBE.path), ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

function requireBin(bin, name) {
  if (!bin.path) throw new Error(`${name} が見つかりません。ffmpeg をインストールするか、.env で ${name.toUpperCase()}_PATH を指定してください。`);
  return bin.path;
}

/**
 * ffmpeg を実行する。
 * @param {string[]} args
 * @param {{ duration?: number, onProgress?: (ratio:number)=>void, signal?: AbortSignal }} opts
 */
export function runFfmpeg(args, opts = {}) {
  const bin = requireBin(FFMPEG, 'ffmpeg');
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args];
    const child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && opts.duration && opts.onProgress) {
          const sec = Number(m[1]) / 1e6;
          opts.onProgress(Math.max(0, Math.min(1, sec / opts.duration)));
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stderr });
      else {
        const tail = stderr.split('\n').filter(Boolean).slice(-12).join('\n');
        const err = new Error(`ffmpeg が失敗しました (code ${code})\n${tail}`);
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export function probe(file) {
  const bin = requireBin(FFPROBE, 'ffprobe');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 失敗: ${err.trim()}`));
      try {
        const j = JSON.parse(out);
        const streams = j.streams || [];
        const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const a = streams.find((s) => s.codec_type === 'audio');
        let duration = Number(j.format?.duration);
        if (!Number.isFinite(duration)) duration = Number(v?.duration ?? a?.duration);
        let fps = null;
        if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
          const [n, d] = v.avg_frame_rate.split('/').map(Number);
          if (d) fps = n / d;
        }
        let width = v?.width ?? null;
        let height = v?.height ?? null;
        const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0);
        if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
        resolve({
          duration: Number.isFinite(duration) ? duration : null,
          width,
          height,
          fps,
          hasVideo: Boolean(v),
          hasAudio: Boolean(a),
          videoCodec: v?.codec_name ?? null,
          audioCodec: a?.codec_name ?? null,
          formatName: j.format?.format_name ?? null,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}
