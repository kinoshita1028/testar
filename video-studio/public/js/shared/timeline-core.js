// タイムラインの配置計算（ブラウザのプレビューとサーバーの書き出しで共通）

export function newProject() {
  return {
    version: 1,
    name: '無題のプロジェクト',
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    videoClips: [],
    audioTracks: [
      { id: 'track_narration', name: 'ナレーション', kind: 'narration', muted: false, volume: 1, clips: [] },
      { id: 'track_audio', name: '音声・BGM', kind: 'audio', muted: false, volume: 1, clips: [] },
    ],
  };
}

export const clipLength = (c) => Math.max(0, (c.out ?? 0) - (c.in ?? 0));

/**
 * @param {object} project
 * @param {Record<string, object>} itemsById ライブラリ素材
 * @returns {{ video: Array, audio: Array, duration: number }}
 */
export function layoutProject(project, itemsById = {}) {
  let t = 0;
  const video = [];
  for (const clip of project.videoClips || []) {
    const d = clipLength(clip);
    video.push({ clip, item: itemsById[clip.itemId] || null, start: t, end: t + d, duration: d });
    t += d;
  }
  const byClip = Object.fromEntries(video.map((v) => [v.clip.id, v]));
  const audio = [];
  for (const track of project.audioTracks || []) {
    for (const clip of track.clips || []) {
      const anchor = clip.anchorClipId ? byClip[clip.anchorClipId] : null;
      const start = Math.max(0, anchor ? anchor.start + (clip.offset || 0) : clip.start || 0);
      const d = clipLength(clip);
      audio.push({ clip, track, item: itemsById[clip.itemId] || null, start, end: start + d, duration: d, anchored: Boolean(anchor) });
    }
  }
  return { video, audio, duration: t };
}

export function segmentAt(video, t) {
  for (let i = 0; i < video.length; i++) {
    const s = video[i];
    if (t >= s.start && t < s.end) return i;
  }
  return video.length ? (t >= video[video.length - 1].end ? -1 : 0) : -1;
}

/** クリップ内の音量（フェード込み） 0..n */
export function fadeGain(localT, duration, fadeIn = 0, fadeOut = 0) {
  let g = 1;
  if (fadeIn > 0 && localT < fadeIn) g = Math.min(g, Math.max(0, localT / fadeIn));
  if (fadeOut > 0 && localT > duration - fadeOut) g = Math.min(g, Math.max(0, (duration - localT) / fadeOut));
  return g;
}

export function formatTime(sec, withMs = true) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (!withMs) return `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
