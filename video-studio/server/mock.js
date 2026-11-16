// デモモード: API を呼ばずにテスト用の動画・音声・テキストを作る
import path from 'node:path';
import { DIRS } from './config.js';
import { runFfmpeg } from './ffmpeg.js';
import { newId, sleep } from './util.js';
import { outputSize } from '../public/js/shared/capabilities.js';

export async function mockVideo({ duration = 6, aspectRatio = '16:9', resolution = '720p', seed = 0 }) {
  await sleep(1500);
  const [w, h] = outputSize(aspectRatio, resolution === '4k' || resolution === '1080p' ? '720p' : resolution === '360p' ? '480p' : resolution);
  const hue = Math.floor((seed * 67) % 360);
  const freq = 220 + ((seed * 53) % 440);
  const out = path.join(DIRS.tmp, `${newId('mock_')}.mp4`);
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=24:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${duration}`,
    '-vf', `hue=h=${hue},format=yuv420p`,
    '-af', 'volume=0.15',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-shortest', out,
  ]);
  return out;
}

export async function mockTts(text) {
  await sleep(500);
  const chars = [...String(text)].length;
  const duration = Math.max(1, chars / 7);
  const out = path.join(DIRS.tmp, `${newId('mocktts_')}.wav`);
  // 声の代わりに抑揚のあるトーン
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=24000:duration=${duration.toFixed(2)}`,
    '-af', "volume='0.25*(0.6+0.4*sin(2*PI*t*3))':eval=frame", '-ac', '1', out,
  ]);
  return out;
}

export function mockPrompt({ instruction, mode, sceneCount = 3, duration = 8, withNarration }) {
  const base = instruction?.trim() || 'A calm sunrise over a quiet harbor';
  const result = {
    title: base.slice(0, 30),
    prompt: `[デモ] Cinematic shot. ${base}. Soft natural lighting, smooth camera movement, high detail.`,
    negativePrompt: 'blurry, low quality, text artifacts',
    scenes: [],
  };
  if (mode === 'storyboard') {
    for (let i = 0; i < sceneCount; i++) {
      result.scenes.push({
        title: `シーン${i + 1}`,
        prompt: `[デモ] Scene ${i + 1} of ${sceneCount}: ${base}. Shot ${i + 1}, cinematic lighting.`,
        duration,
        narration: withNarration ? `これはシーン${i + 1}のデモ用ナレーションです。` : '',
      });
    }
  }
  return result;
}

export function mockScript(duration, language = 'ja') {
  const unit = language === 'en' ? 'This is a demo narration. ' : 'これはデモ用のナレーションです。';
  const target = language === 'en' ? Math.round(duration * 2.5) : Math.round(duration * 6);
  let s = '';
  while ((language === 'en' ? s.split(' ').length : [...s].length) < target) s += unit;
  return s.trim();
}
