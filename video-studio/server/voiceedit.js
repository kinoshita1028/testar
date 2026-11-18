// 声の部分差し替え: 動画の指定区間だけ元の音声をミュートし、新しいセリフの音声を重ねた動画を作る
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { addMedia, getItem, mediaPath } from './media.js';
import { generateNarration } from './narration.js';
import { newId, HttpError } from './util.js';
import { separateItem } from './stems.js';

const f3 = (n) => Number(n).toFixed(3);

/**
 * @param {{itemId:string, start:number, end:number, script:string, voice:string, voiceName?:string, ttsModel?:string,
 *          textModel?:string, style?:string, language?:string, fit?:boolean, autoRewrite?:boolean, keepVolume?:number}} p
 */
export async function applyVoiceEdit(p) {
  const item = getItem(p.itemId);
  if (!item || item.kind !== 'video') throw new HttpError(400, '差し替える動画が見つかりません');
  const start = Math.max(0, Number(p.start) || 0);
  const end = Math.min(item.duration || 0, Number(p.end) || 0);
  if (!(end - start >= 0.3)) throw new HttpError(400, '差し替える範囲を 0.3 秒以上選んでください');
  if (!String(p.script || '').trim()) throw new HttpError(400, '新しいセリフを入力してください');

  // 1) 新しいセリフを、選んだ声で、範囲の長さに合わせて読み上げる
  const narr = await generateNarration({
    script: p.script,
    targetDuration: end - start,
    voice: p.voice,
    voiceName: p.voiceName,
    ttsModel: p.ttsModel,
    textModel: p.textModel,
    style: p.style,
    language: p.language,
    fit: p.fit === false ? 'none' : 'stretch',
    autoRewrite: Boolean(p.autoRewrite),
  });

  // 2) 範囲内だけ元の音声を下げて（既定は無音）、新しい音声を重ねる
  const keep = Math.max(0, Math.min(1, Number(p.keepVolume) || 0));
  const r = 0.06; // 境目のプツッという音を防ぐための短いフェード
  const vol = `1-(1-${keep})*clip(min((t-(${f3(start)}-${r}))/${r},((${f3(end)}+${r})-t)/${r}),0,1)`;
  const delay = Math.round(start * 1000);
  const speech = mediaPath(narr.item);
  const out = path.join(DIRS.tmp, `${newId('vedit_')}.mp4`);
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const inputs = ['-i', mediaPath(item), '-i', speech];
  let graph;
  if (item.hasAudio && p.keepBackground) {
    // 声と BGM を分けて、範囲内は「声だけ」を消す（BGM・効果音はそのまま）
    const stems = await separateItem(item.id);
    inputs.push('-i', mediaPath(stems.voice), '-i', mediaPath(stems.background));
    graph =
      `[2:a]${fmt},volume='${vol}':eval=frame[v];[3:a]${fmt}[bg];` +
      `[1:a]${fmt},adelay=${delay}|${delay}[s];` +
      '[v][bg][s]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]';
  } else if (item.hasAudio) {
    graph =
      `[0:a]${fmt},volume='${vol}':eval=frame[a0];` +
      `[1:a]${fmt},adelay=${delay}|${delay}[a1];` +
      '[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]';
  } else {
    graph = `[1:a]${fmt},adelay=${delay}|${delay},apad[aout]`;
  }
  const common = [...inputs, '-filter_complex', graph, '-map', '0:v:0', '-map', '[aout]'];
  const tail = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f3(item.duration), out];
  try {
    // 映像はそのままコピー（画質が落ちない・速い）
    await runFfmpeg([...common, '-c:v', 'copy', ...tail]);
  } catch {
    await runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', ...tail]);
  }
  const info = await probe(out);
  if (!info.hasVideo) {
    fs.rm(out, { force: true }, () => {});
    throw new Error('差し替え版の動画を作れませんでした');
  }

  // 3) 差し替え版をライブラリに保存（元の動画は残す）
  const { interactionId, remote, ...baseMeta } = item.meta || {};
  const newItem = await addMedia(out, {
    name: `${item.name}（声差し替え）.mp4`,
    source: item.source,
    move: true,
    meta: {
      ...baseMeta,
      parentItemId: item.id,
      voiceEdit: { start, end, script: narr.script, voice: p.voice, voiceName: p.voiceName || p.voice, style: p.style || '', narrationItemId: narr.item.id, keptBackground: Boolean(p.keepBackground) },
    },
  });
  return { item: newItem, narration: narr.item, script: narr.script, tempo: narr.tempo, rawDuration: narr.rawDuration, finalDuration: narr.finalDuration, warnings: narr.warnings };
}
