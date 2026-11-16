// タイムラインのプレビュー再生エンジン（2つの video 要素を切り替えて途切れなく再生）
import { store } from './store.js';
import { fadeGain, formatTime, segmentAt } from './shared/timeline-core.js';

export class Player {
  constructor(stage, emptyEl) {
    this.stage = stage;
    this.emptyEl = emptyEl;
    const [vA, vB] = stage.querySelectorAll('video');
    this.img = stage.querySelector('img');
    this.active = vA;
    this.standby = vB;
    this.keys = new Map([[vA, null], [vB, null]]);
    this.audioEls = new Map();
    this.layout = { video: [], audio: [], duration: 0 };
    this.t = 0;
    this.playing = false;
    this.ctx = null;
    this.gains = new WeakMap();
    for (const v of [vA, vB]) {
      v.muted = false;
      v.addEventListener('error', () => console.warn('video error', v.src));
    }
  }

  get duration() {
    return this.layout.duration;
  }

  setLayout(layout) {
    this.layout = layout;
    const ids = new Set(layout.audio.map((a) => a.clip.id));
    for (const [id, el] of this.audioEls) {
      if (!ids.has(id)) {
        el.pause();
        el.removeAttribute('src');
        el.load();
        this.audioEls.delete(id);
      }
    }
    if (this.t > layout.duration) this.t = layout.duration;
    this.render(true);
  }

  ensureAudioContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ctx = null;
    }
  }

  /** 音量（0〜2）を設定。1 を超える分は WebAudio のゲインで増幅 */
  setVolume(el, vol) {
    vol = Math.max(0, vol);
    if (this.ctx && vol > 1) {
      let g = this.gains.get(el);
      if (!g) {
        try {
          const src = this.ctx.createMediaElementSource(el);
          g = this.ctx.createGain();
          src.connect(g).connect(this.ctx.destination);
          this.gains.set(el, g);
        } catch {
          g = null;
        }
      }
      if (g) {
        el.volume = 1;
        g.gain.value = vol;
        return;
      }
    }
    const g = this.gains.get(el);
    if (g) g.gain.value = 1;
    el.volume = Math.min(1, vol);
  }

  play() {
    if (!this.layout.duration) return;
    if (this.t >= this.layout.duration - 0.05) this.t = 0;
    this.ensureAudioContext();
    this.playing = true;
    this.last = performance.now();
    this.render(true);
    store.emit('playstate', true);
    const loop = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      if (!this.stalled()) this.t += dt;
      if (this.t >= this.layout.duration) {
        this.t = this.layout.duration;
        this.pause();
        return;
      }
      this.render(false);
      store.setTime(this.t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const v of [this.active, this.standby]) v.pause();
    for (const a of this.audioEls.values()) a.pause();
    this.render(true);
    store.setTime(this.t);
    store.emit('playstate', false);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    this.t = Math.max(0, Math.min(t, this.layout.duration || 0));
    this.last = performance.now();
    this.render(true);
    store.setTime(this.t);
  }

  stalled() {
    const i = segmentAt(this.layout.video, this.t);
    const seg = this.layout.video[i];
    if (!seg || seg.item?.kind !== 'video') return false;
    return this.active.seeking || this.active.readyState < 3;
  }

  keyFor(seg) {
    return seg.item ? seg.item.url : null;
  }

  loadInto(el, seg) {
    const key = this.keyFor(seg);
    if (this.keys.get(el) !== key) {
      el.src = key;
      this.keys.set(el, key);
    }
  }

  render(force) {
    const { video, audio, duration } = this.layout;
    this.emptyEl.classList.toggle('hidden', video.length > 0);
    const idx = video.length ? (this.t >= duration ? video.length - 1 : segmentAt(video, this.t)) : -1;
    const seg = idx >= 0 ? video[idx] : null;
    const t = Math.min(this.t, Math.max(0, duration - 0.001));

    if (!seg || !seg.item) {
      for (const v of [this.active, this.standby]) {
        v.classList.remove('show');
        v.pause();
      }
      this.img.classList.remove('show');
    } else {
      const local = t - seg.start;
      const opacity = fadeGain(local, seg.duration, seg.clip.fadeIn, seg.clip.fadeOut);
      if (seg.item.kind === 'image') {
        if (this.img.getAttribute('src') !== seg.item.url) this.img.src = seg.item.url;
        this.img.classList.add('show');
        this.img.style.opacity = opacity;
        for (const v of [this.active, this.standby]) {
          v.classList.remove('show');
          v.pause();
        }
      } else {
        this.img.classList.remove('show');
        const key = this.keyFor(seg);
        // 次のクリップを standby に読み込み済みなら入れ替える
        if (this.keys.get(this.active) !== key && this.keys.get(this.standby) === key) {
          [this.active, this.standby] = [this.standby, this.active];
        }
        this.loadInto(this.active, seg);
        const target = seg.clip.in + local;
        const tol = this.playing ? 0.3 : 0.03;
        if (force || Math.abs(this.active.currentTime - target) > tol) {
          if (!this.active.seeking || force) {
            try {
              this.active.currentTime = target;
            } catch {
              /* メタデータ未読込 */
            }
          }
        }
        const vol = seg.clip.muted ? 0 : (seg.clip.volume ?? 1) * fadeGain(local, seg.duration, seg.clip.fadeIn, seg.clip.fadeOut);
        this.setVolume(this.active, vol);
        this.active.style.opacity = opacity;
        this.active.classList.add('show');
        this.standby.classList.remove('show');
        this.standby.pause();
        if (this.playing && this.active.paused) this.active.play().catch(() => {});
        if (!this.playing && !this.active.paused) this.active.pause();
        // 次のクリップを先読み
        const next = video[idx + 1];
        if (next?.item?.kind === 'video' && this.keyFor(next) !== key) {
          this.loadInto(this.standby, next);
          if (force || Math.abs(this.standby.currentTime - next.clip.in) > 0.05) {
            try {
              this.standby.currentTime = next.clip.in;
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    // 音声トラック
    for (const a of audio) {
      if (!a.item) continue;
      let el = this.audioEls.get(a.clip.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        el.src = a.item.url;
        this.audioEls.set(a.clip.id, el);
      } else if (!el.src.endsWith(a.item.url)) el.src = a.item.url;
      const on = this.playing && this.t >= a.start && this.t < Math.min(a.end, duration) && !a.track.muted && !a.clip.muted;
      if (on) {
        const local = this.t - a.start;
        const target = a.clip.in + local;
        if (Math.abs(el.currentTime - target) > 0.3) {
          try {
            el.currentTime = target;
          } catch {
            /* ignore */
          }
        }
        this.setVolume(el, (a.clip.volume ?? 1) * (a.track.volume ?? 1) * fadeGain(local, a.duration, a.clip.fadeIn, a.clip.fadeOut));
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }
}

export function timecodeText(t, d) {
  return `${formatTime(t)} / ${formatTime(d)}`;
}
