// タイムラインを ffmpeg で 1 本の動画に書き出す
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { FFMPEG, runFfmpeg } from './ffmpeg.js';
import { listLibrary, mediaPath } from './media.js';
import { createJob, logJob, runJob, updateJob } from './jobs.js';
import { newId, safeName } from './util.js';
import { layoutProject } from '../public/js/shared/timeline-core.js';
import { outputSize } from '../public/js/shared/capabilities.js';

export const FORMATS = {
  mp4: { ext: 'mp4', label: 'MP4 (H.264 / AAC)', mime: 'video/mp4' },
  mov: { ext: 'mov', label: 'MOV (H.264 / AAC)', mime: 'video/quicktime' },
  webm: { ext: 'webm', label: 'WebM (VP9 / Opus)', mime: 'video/webm' },
  gif: { ext: 'gif', label: 'GIF アニメーション', mime: 'image/gif' },
};

const QUALITY = {
  high: { crf264: 18, crfvp9: 28, preset: 'slow', abr: '256k' },
  standard: { crf264: 21, crfvp9: 32, preset: 'medium', abr: '192k' },
  light: { crf264: 26, crfvp9: 38, preset: 'fast', abr: '128k' },
  proxy: { crf264: 32, crfvp9: 40, preset: 'veryfast', abr: '64k' },
};

const f3 = (n) => Number(n).toFixed(3);
const ffmpegMajor = () => Number(/version\s+n?(\d+)/.exec(FFMPEG.version || '')?.[1]) || 6;

function audioFades(clip, d) {
  const out = [];
  const fi = Math.min(Number(clip.fadeIn) || 0, d);
  const fo = Math.min(Number(clip.fadeOut) || 0, d);
  if (fi > 0) out.push(`afade=t=in:st=0:d=${f3(fi)}`);
  if (fo > 0) out.push(`afade=t=out:st=${f3(Math.max(0, d - fo))}:d=${f3(fo)}`);
  return out;
}

/** ffmpeg の引数を組み立てる（テストしやすいよう純粋関数） */
export function buildFfmpegArgs(project, items, opts) {
  const itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
  const { video, audio, duration } = layoutProject(project, itemsById);
  if (!video.length || duration <= 0.05) throw new Error('タイムラインに動画クリップがありません');
  const format = FORMATS[opts.format] ? opts.format : 'mp4';
  const q = QUALITY[opts.quality] || QUALITY.standard;
  let [W, H] = outputSize(project.aspectRatio || '16:9', opts.resolution || project.resolution || '1080p');
  const fps = Math.max(1, Math.min(60, Number(opts.fps) || Number(project.fps) || 30));
  const withAudio = format !== 'gif';

  const args = [];
  const filters = [];
  let n = 0;

  video.forEach((seg, i) => {
    const { clip, item } = seg;
    if (!item) throw new Error(`素材が見つからないクリップがあります（${i + 1}番目）。ライブラリから削除された可能性があります。`);
    const d = seg.duration;
    if (item.kind === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', f3(d + 0.5), '-i', mediaPath(item));
    else args.push('-ss', f3(clip.in || 0), '-t', f3(d + 0.25), '-i', mediaPath(item));
    const idx = n++;
    let vf =
      `[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=2,trim=duration=${f3(d)},setpts=PTS-STARTPTS`;
    const fi = Math.min(Number(clip.fadeIn) || 0, d / 2);
    const fo = Math.min(Number(clip.fadeOut) || 0, d / 2);
    if (fi > 0) vf += `,fade=t=in:st=0:d=${f3(fi)}`;
    if (fo > 0) vf += `,fade=t=out:st=${f3(d - fo)}:d=${f3(fo)}`;
    filters.push(`${vf}[v${i}]`);
    if (withAudio) {
      const vol = clip.muted ? 0 : Number(clip.volume ?? 1);
      if (item.kind === 'video' && item.hasAudio && vol > 0) {
        const af = [
          `[${idx}:a]aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'apad',
          `atrim=duration=${f3(d)}`, 'asetpts=PTS-STARTPTS', `volume=${vol.toFixed(3)}`, ...audioFades(clip, d),
        ];
        filters.push(`${af.join(',')}[a${i}]`);
      } else {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(d)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
  });

  const concatIn = video.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  filters.push(`${concatIn}concat=n=${video.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? '[vcat][acat]' : '[vcat]'}`);

  if (withAudio) {
    const mix = ['[acat]'];
    audio.forEach((seg, k) => {
      if (seg.track.muted || seg.clip.muted || !seg.item) return;
      if (seg.start >= duration - 0.01) return;
      const d = Math.min(seg.duration, duration - seg.start);
      if (d <= 0.02) return;
      const vol = Number(seg.clip.volume ?? 1) * Number(seg.track.volume ?? 1);
      if (vol <= 0) return;
      args.push('-ss', f3(seg.clip.in || 0), '-t', f3(d), '-i', mediaPath(seg.item));
      const idx = n++;
      const delay = Math.round(seg.start * 1000);
      const af = [
        `[${idx}:a]aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `atrim=duration=${f3(d)}`, 'asetpts=PTS-STARTPTS', `volume=${vol.toFixed(3)}`, ...audioFades(seg.clip, d),
        `adelay=${delay}|${delay}`,
      ];
      filters.push(`${af.join(',')}[ax${k}]`);
      mix.push(`[ax${k}]`);
    });
    if (mix.length > 1) {
      filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=disabled[aout]`);
    } else {
      filters.push('[acat]anull[aout]');
    }
  }

  let vout = '[vcat]';
  if (format === 'gif') {
    const gw = Math.min(W, Number(opts.gifWidth) || 640);
    const gfps = Math.min(fps, 15);
    filters.push(`[vcat]fps=${gfps},scale=${gw}:-2:flags=lanczos,split[g0][g1];[g0]palettegen=stats_mode=diff[pal];[g1][pal]paletteuse=dither=bayer:bayer_scale=4[gif]`);
    vout = '[gif]';
    W = gw;
  }

  const graph = filters.join(';\n');
  const enc = [];
  if (format === 'mp4' || format === 'mov') {
    enc.push('-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf264), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', q.abr);
    if (format === 'mp4') enc.push('-movflags', '+faststart');
  } else if (format === 'webm') {
    enc.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(q.crfvp9), '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', q.abr);
  } else if (format === 'gif') {
    enc.push('-loop', '0');
  }
  const maps = ['-map', vout, ...(withAudio ? ['-map', '[aout]'] : [])];
  return { inputArgs: args, graph, maps, enc, duration, width: W, height: H, fps, format };
}

/**
 * @returns {Promise<{file:string, duration:number}>}
 */
export async function renderTimeline(project, opts = {}, onProgress) {
  const plan = buildFfmpegArgs(project, listLibrary(), opts);
  const fmt = FORMATS[plan.format];
  const out = opts.outPath || path.join(DIRS.exports, `${safeName(project.name || 'export')}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${newId().slice(0, 4)}.${fmt.ext}`);
  let graphArgs = ['-filter_complex', plan.graph];
  let scriptFile = null;
  if (plan.graph.length > 6000) {
    scriptFile = path.join(DIRS.tmp, `${newId('graph_')}.txt`);
    fs.writeFileSync(scriptFile, plan.graph);
    graphArgs = ffmpegMajor() >= 7 ? ['-/filter_complex', scriptFile] : ['-filter_complex_script', scriptFile];
  }
  try {
    await runFfmpeg([...plan.inputArgs, ...graphArgs, ...plan.maps, ...plan.enc, '-r', String(plan.fps), '-t', f3(plan.duration), out], {
      duration: plan.duration,
      onProgress,
    });
  } finally {
    if (scriptFile) fs.rm(scriptFile, { force: true }, () => {});
  }
  return { file: out, duration: plan.duration, width: plan.width, height: plan.height };
}

export function startExport(project, opts) {
  const fmt = FORMATS[opts.format] || FORMATS.mp4;
  // 事前チェック（エラーなら即座に返す）
  buildFfmpegArgs(project, listLibrary(), opts);
  const job = createJob('export', { format: opts.format, label: fmt.label, projectName: project.name });
  return runJob(job, async () => {
    logJob(job, '書き出し中…');
    const r = await renderTimeline(project, opts, (p) => updateJob(job, { progress: p, message: `書き出し中… ${Math.round(p * 100)}%` }));
    const size = fs.statSync(r.file).size;
    return { file: path.basename(r.file), url: `/exports/${encodeURIComponent(path.basename(r.file))}`, size, mime: fmt.mime, duration: r.duration, width: r.width, height: r.height };
  });
}

/** ナレーション原稿作成用に、タイムライン全体を軽量動画にする */
export async function renderProxy(project) {
  const out = path.join(DIRS.tmp, `${newId('tlproxy_')}.mp4`);
  await renderTimeline(project, { format: 'mp4', quality: 'proxy', resolution: '480p', fps: 12, outPath: out });
  return out;
}
