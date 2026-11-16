// アプリ全体の状態・プロジェクト編集操作・元に戻す/やり直す
import { api } from './api.js';
import { debounce, toast, uid } from './ui.js';
import { clipLength, layoutProject, newProject } from './shared/timeline-core.js';

const listeners = new Map();

export const store = {
  status: null,
  settings: {},
  models: { video: [], text: [], tts: [] },
  library: [],
  itemsById: {},
  project: newProject(),
  selection: null, // { type: 'video'|'audio', id }
  time: 0,
  history: [],
  future: [],

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit(evt, data) {
    for (const fn of listeners.get(evt) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  },

  // ---------------- ライブラリ ----------------
  setLibrary(items) {
    this.library = items;
    this.itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
    this.emit('library');
  },
  async refreshLibrary() {
    const r = await api.get('/api/library');
    this.setLibrary(r.items);
  },
  upsertItems(items) {
    const map = { ...this.itemsById };
    for (const i of items) map[i.id] = i;
    const ids = new Set(items.map((i) => i.id));
    this.setLibrary([...items, ...this.library.filter((i) => !ids.has(i.id))]);
  },

  layout() {
    return layoutProject(this.project, this.itemsById);
  },

  // ---------------- 履歴 ----------------
  snapshot() {
    return JSON.stringify(this.project);
  },
  pushHistory(snap = this.snapshot()) {
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.emit('history');
  },
  /** プロジェクトを変更する（1操作 = 1履歴） */
  mutate(fn, { record = true } = {}) {
    const before = this.snapshot();
    fn(this.project);
    if (record && before !== this.snapshot()) this.pushHistory(before);
    this.changed();
  },
  /** ドラッグ操作など: 開始時に begin、終了時に end */
  beginGesture() {
    this._gesture = this.snapshot();
  },
  endGesture() {
    if (this._gesture && this._gesture !== this.snapshot()) this.pushHistory(this._gesture);
    this._gesture = null;
    this.changed();
  },
  changed() {
    this.emit('project');
    saveProject();
  },
  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot());
    this.project = JSON.parse(this.history.pop());
    this.validateSelection();
    this.emit('history');
    this.changed();
  },
  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot());
    this.project = JSON.parse(this.future.pop());
    this.validateSelection();
    this.emit('history');
    this.changed();
  },
  setProject(p, { resetHistory = true } = {}) {
    const base = newProject();
    this.project = { ...base, ...p, audioTracks: p.audioTracks?.length ? p.audioTracks : base.audioTracks, videoClips: p.videoClips || [] };
    if (resetHistory) {
      this.history = [];
      this.future = [];
    }
    this.selection = null;
    this.emit('history');
    this.emit('selection');
    this.emit('project');
  },

  // ---------------- 選択 ----------------
  select(sel) {
    this.selection = sel;
    this.emit('selection');
  },
  validateSelection() {
    if (this.selection && !this.findClip(this.selection)) {
      this.selection = null;
      this.emit('selection');
    }
  },
  findClip(sel = this.selection) {
    if (!sel) return null;
    if (sel.type === 'video') {
      const clip = this.project.videoClips.find((c) => c.id === sel.id);
      return clip ? { clip, track: null } : null;
    }
    for (const track of this.project.audioTracks) {
      const clip = track.clips.find((c) => c.id === sel.id);
      if (clip) return { clip, track };
    }
    return null;
  },

  setTime(t) {
    this.time = t;
    this.emit('time', t);
  },

  // ---------------- 編集操作 ----------------
  addVideoClip(item, { index, select = true } = {}) {
    if (!item || !['video', 'image'].includes(item.kind)) return null;
    const clip = {
      id: uid('c_'),
      itemId: item.id,
      in: 0,
      out: item.kind === 'image' ? 5 : Math.max(0.1, item.duration || 5),
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
    };
    this.mutate((p) => {
      const i = index === undefined ? p.videoClips.length : Math.max(0, Math.min(index, p.videoClips.length));
      p.videoClips.splice(i, 0, clip);
    });
    if (select) this.select({ type: 'video', id: clip.id });
    return clip;
  },

  addAudioClip(item, { trackId, start = 0, anchorClipId = null, offset = 0, select = true, out } = {}) {
    if (!item || !item.hasAudio) {
      toast('この素材には音声がありません', 'warn');
      return null;
    }
    const clip = {
      id: uid('a_'),
      itemId: item.id,
      start: Math.max(0, start),
      in: 0,
      out: Math.max(0.1, Math.min(out ?? item.duration ?? 1, item.duration || 1)),
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      ...(anchorClipId ? { anchorClipId, offset } : {}),
    };
    this.mutate((p) => {
      let track = p.audioTracks.find((t) => t.id === trackId);
      if (!track) track = p.audioTracks.find((t) => t.kind === (item.source === 'narration' ? 'narration' : 'audio')) || p.audioTracks[0];
      if (!track) {
        track = { id: uid('t_'), name: '音声', kind: 'audio', muted: false, volume: 1, clips: [] };
        p.audioTracks.push(track);
      }
      track.clips.push(clip);
    });
    if (select) this.select({ type: 'audio', id: clip.id });
    return clip;
  },

  deleteSelected() {
    const sel = this.selection;
    const found = this.findClip(sel);
    if (!found) return;
    this.mutate((p) => {
      if (sel.type === 'video') {
        const lay = layoutProject(p, this.itemsById);
        const seg = lay.video.find((v) => v.clip.id === sel.id);
        // このクリップに紐づいた音声は絶対位置に変換して残す
        for (const tr of p.audioTracks)
          for (const c of tr.clips)
            if (c.anchorClipId === sel.id) {
              c.start = (seg?.start || 0) + (c.offset || 0);
              delete c.anchorClipId;
              delete c.offset;
            }
        p.videoClips = p.videoClips.filter((c) => c.id !== sel.id);
      } else {
        for (const tr of p.audioTracks) tr.clips = tr.clips.filter((c) => c.id !== sel.id);
      }
    });
    this.select(null);
  },

  duplicateSelected() {
    const sel = this.selection;
    const found = this.findClip(sel);
    if (!found) return;
    const copy = { ...JSON.parse(JSON.stringify(found.clip)), id: uid(sel.type === 'video' ? 'c_' : 'a_') };
    this.mutate((p) => {
      if (sel.type === 'video') {
        const i = p.videoClips.findIndex((c) => c.id === sel.id);
        p.videoClips.splice(i + 1, 0, copy);
      } else {
        const lay = layoutProject(p, this.itemsById);
        const seg = lay.audio.find((a) => a.clip.id === sel.id);
        delete copy.anchorClipId;
        delete copy.offset;
        copy.start = seg ? seg.end : copy.start;
        const tr = p.audioTracks.find((t) => t.clips.some((c) => c.id === sel.id));
        tr.clips.push(copy);
      }
    });
    this.select({ type: sel.type, id: copy.id });
  },

  /** 再生ヘッド位置で分割 */
  splitAt(t = this.time) {
    const lay = this.layout();
    // 選択中のクリップを優先、なければ再生ヘッド下の動画クリップ
    let target = null;
    if (this.selection?.type === 'audio') {
      const a = lay.audio.find((x) => x.clip.id === this.selection.id);
      if (a && t > a.start + 0.05 && t < a.end - 0.05) target = { type: 'audio', seg: a };
    }
    if (!target) {
      const v = lay.video.find((x) => t > x.start + 0.05 && t < x.end - 0.05);
      if (v) target = { type: 'video', seg: v };
    }
    if (!target) {
      toast('再生ヘッドをクリップの途中に置いてから分割してください', 'warn');
      return;
    }
    const { seg } = target;
    const cut = seg.clip.in + (t - seg.start);
    const right = { ...JSON.parse(JSON.stringify(seg.clip)), id: uid(target.type === 'video' ? 'c_' : 'a_'), in: cut, fadeIn: 0 };
    this.mutate((p) => {
      if (target.type === 'video') {
        const i = p.videoClips.findIndex((c) => c.id === seg.clip.id);
        const left = p.videoClips[i];
        left.out = cut;
        left.fadeOut = 0;
        if (this.itemsById[left.itemId]?.kind === 'image') {
          right.in = 0;
          right.out = seg.end - t;
          left.out = t - seg.start;
        }
        p.videoClips.splice(i + 1, 0, right);
      } else {
        const tr = p.audioTracks.find((x) => x.clips.some((c) => c.id === seg.clip.id));
        const left = tr.clips.find((c) => c.id === seg.clip.id);
        left.out = cut;
        left.fadeOut = 0;
        delete right.anchorClipId;
        delete right.offset;
        right.start = t;
        tr.clips.push(right);
      }
    });
    this.select({ type: target.type, id: right.id });
  },

  /** ナレーションを追加（クリップへの紐づけ・元音声のミュートを 1 操作で） */
  addNarration(item, { anchorClipId = null, start = 0, muteClipIds = [], trackId } = {}) {
    const clip = {
      id: uid('a_'),
      itemId: item.id,
      start: Math.max(0, start),
      in: 0,
      out: item.duration || 1,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      ...(anchorClipId ? { anchorClipId, offset: 0 } : {}),
    };
    this.mutate((p) => {
      let track = p.audioTracks.find((t) => t.id === trackId) || p.audioTracks.find((t) => t.kind === 'narration');
      if (!track) {
        track = { id: uid('t_'), name: 'ナレーション', kind: 'narration', muted: false, volume: 1, clips: [] };
        p.audioTracks.unshift(track);
      }
      track.clips.push(clip);
      for (const c of p.videoClips) if (muteClipIds.includes(c.id)) c.muted = true;
    });
    return clip;
  },

  addAudioTrack() {
    this.mutate((p) => {
      p.audioTracks.push({ id: uid('t_'), name: `音声 ${p.audioTracks.length + 1}`, kind: 'audio', muted: false, volume: 1, clips: [] });
    });
  },
};

/** ライブラリから消えた素材を使っているクリップ数 */
export function missingCount() {
  let n = 0;
  for (const c of store.project.videoClips) if (!store.itemsById[c.itemId]) n++;
  for (const t of store.project.audioTracks) for (const c of t.clips) if (!store.itemsById[c.itemId]) n++;
  return n;
}

export { clipLength };

const saveProject = debounce(async () => {
  try {
    await api.put('/api/project', { project: store.project });
  } catch (e) {
    toast(`プロジェクトの保存に失敗しました: ${e.message}`, 'err');
  }
}, 600);
