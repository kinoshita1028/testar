// タイムライン（動画トラック＋音声トラック）。並べ替え・トリム・移動・分割・ドロップ
import { store } from './store.js';
import { h, clear, toast, confirmDialog, lsGet, lsSet, add } from './ui.js';
import { formatTime } from './shared/timeline-core.js';

const HEAD_W = 150;
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export class Timeline {
  constructor(root, player) {
    this.root = root;
    this.player = player;
    this.zoom = lsGet('tlZoom', 40); // 1秒あたりのピクセル
    this.snap = lsGet('tlSnap', true);
    this.dragging = false;
    this.elById = new Map();
    this.build();
    store.on('project', () => !this.dragging && this.render());
    store.on('library', () => !this.dragging && this.render());
    store.on('selection', () => this.updateSelection());
    store.on('time', (t) => this.updatePlayhead(t, true));
    const h0 = lsGet('tlHeight', null);
    if (h0) document.documentElement.style.setProperty('--tl-h', `${h0}px`);
  }

  build() {
    const r = this.root;
    clear(r);
    this.resizer = h('div', { class: 'tl-resizer', title: 'ドラッグで高さを変更' });
    this.resizer.addEventListener('pointerdown', (e) => this.startResize(e));
    this.zoomInput = h('input', { type: 'range', class: 'zoom', min: 0, max: 100, step: 1, title: 'ズーム (Ctrl+ホイール)' });
    this.zoomInput.value = this.zoomToSlider(this.zoom);
    this.zoomInput.addEventListener('input', () => this.setZoom(this.sliderToZoom(Number(this.zoomInput.value)), true));
    this.snapBtn = h('button', { class: `btn sm ${this.snap ? '' : 'ghost'}`, title: '再生ヘッドやクリップ端に吸着', onclick: () => this.toggleSnap() }, `🧲 スナップ${this.snap ? 'ON' : 'OFF'}`);
    this.info = h('span', { class: 'tiny' });
    add(r, 
      this.resizer,
      h('div', { class: 'tl-toolbar' },
        h('button', { class: 'btn sm', title: '再生ヘッド位置で分割 (S)', onclick: () => store.splitAt() }, '✂ 分割'),
        h('button', { class: 'btn sm', title: '複製 (Ctrl+D)', onclick: () => store.duplicateSelected() }, '⧉ 複製'),
        h('button', { class: 'btn sm', title: '削除 (Delete)', onclick: () => store.deleteSelected() }, '🗑 削除'),
        h('span', { class: 'tiny', style: { margin: '0 4px' } }, '|'),
        h('button', { class: 'icon-btn', title: '縮小', onclick: () => this.setZoom(this.zoom / 1.4, true) }, '−'),
        this.zoomInput,
        h('button', { class: 'icon-btn', title: '拡大', onclick: () => this.setZoom(this.zoom * 1.4, true) }, '+'),
        h('button', { class: 'btn sm ghost', onclick: () => this.fit() }, '全体表示'),
        this.snapBtn,
        h('button', { class: 'btn sm ghost', onclick: () => store.addAudioTrack() }, '＋ 音声トラック'),
        h('div', { class: 'spacer' }),
        this.info,
      ),
    );
    this.scroll = h('div', { class: 'tl-scroll' });
    this.content = h('div', { class: 'tl-content' });
    this.scroll.append(this.content);
    r.append(this.scroll);
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = this.scroll.getBoundingClientRect();
      const x = e.clientX - rect.left - HEAD_W + this.scroll.scrollLeft;
      const t = x / this.zoom;
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), true);
      this.scroll.scrollLeft = t * this.zoom - (e.clientX - rect.left - HEAD_W);
    }, { passive: false });
    new ResizeObserver(() => this.render()).observe(this.scroll);
  }

  zoomToSlider(z) {
    return Math.round((Math.log(z / 4) / Math.log(400 / 4)) * 100);
  }
  sliderToZoom(v) {
    return 4 * Math.pow(400 / 4, v / 100);
  }
  setZoom(z, byUser = false) {
    if (byUser) this.userZoomed = true;
    this.zoom = Math.max(4, Math.min(400, z));
    this.zoomInput.value = this.zoomToSlider(this.zoom);
    lsSet('tlZoom', this.zoom);
    this.render();
  }
  fit() {
    const lay = store.layout();
    const end = Math.max(lay.duration, ...lay.audio.map((a) => a.end), 5);
    const w = this.scroll.clientWidth - HEAD_W - 40;
    this.userZoomed = false;
    this.setZoom(w / end);
    this.scroll.scrollLeft = 0;
  }
  toggleSnap() {
    this.snap = !this.snap;
    lsSet('tlSnap', this.snap);
    this.snapBtn.textContent = `🧲 スナップ${this.snap ? 'ON' : 'OFF'}`;
    this.snapBtn.classList.toggle('ghost', !this.snap);
  }

  startResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = this.root.getBoundingClientRect().height;
    const move = (ev) => {
      const nh = Math.max(170, Math.min(window.innerHeight * 0.7, startH - (ev.clientY - startY)));
      document.documentElement.style.setProperty('--tl-h', `${nh}px`);
      lsSet('tlHeight', nh);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------- 描画
  render() {
    const lay = store.layout();
    this.lay = lay;
    const end = Math.max(lay.duration, ...lay.audio.map((a) => a.end), 0);
    // ユーザーがズームを触るまでは、内容がはみ出したら自動で全体表示
    const avail = this.scroll.clientWidth - HEAD_W - 40;
    if (!this.userZoomed && avail > 100 && end > 0 && (end * this.zoom > avail || !this.lastEnd)) {
      this.zoom = Math.max(4, Math.min(400, avail / Math.max(end, 5)));
      this.zoomInput.value = this.zoomToSlider(this.zoom);
    }
    this.lastEnd = end;
    const viewSec = Math.max(0, (this.scroll.clientWidth - HEAD_W) / this.zoom);
    const total = Math.max(end + 20, viewSec);
    this.totalSec = total;
    const width = total * this.zoom;
    clear(this.content);
    this.elById.clear();
    this.content.style.width = `${HEAD_W + width}px`;

    // ルーラー
    const ruler = h('div', { class: 'ruler' });
    const step = STEPS.find((s) => s * this.zoom >= 70) || 300;
    const minor = step / 5;
    for (let t = 0; t <= total + 0.0001; t += minor) {
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ruler.append(h('div', { class: `tick ${isMajor ? '' : 'minor'}`, style: { left: `${t * this.zoom}px` } }, isMajor ? (step < 1 ? formatTime(t) : formatTime(t, false)) : ''));
    }
    ruler.addEventListener('pointerdown', (e) => this.scrubStart(e, ruler));
    add(this.content, h('div', { class: 'tl-row ruler-row' }, h('div', { class: 'tl-head' }, h('span', { class: 'tiny' }, 'トラック')), ruler));

    // 動画トラック
    const vlane = h('div', { class: 'tl-lane', dataset: { lane: 'video' } });
    this.vlane = vlane;
    this.setupLane(vlane);
    if (lay.duration > 0) vlane.append(h('div', { class: 'tl-end', style: { left: `${lay.duration * this.zoom}px`, right: 0 } }));
    if (!lay.video.length) vlane.append(h('div', { class: 'tl-empty-hint' }, 'ここに動画をドラッグ＆ドロップ、または生成結果の「＋ 追加」'));
    for (const seg of lay.video) vlane.append(this.videoClipEl(seg));
    add(this.content, 
      h('div', { class: 'tl-row video-row' },
        h('div', { class: 'tl-head' }, h('div', { class: 'tname' }, h('span', { class: 'dot', style: { background: 'var(--video)' } }), '🎞 動画'), h('div', { class: 'tiny' }, `${lay.video.length} クリップ`)),
        vlane,
      ),
    );

    // 音声トラック
    for (const track of store.project.audioTracks) {
      const lane = h('div', { class: 'tl-lane', dataset: { lane: 'audio', track: track.id } });
      this.setupLane(lane);
      for (const seg of lay.audio.filter((a) => a.track.id === track.id)) lane.append(this.audioClipEl(seg));
      const nameInput = h('input', { value: track.name, title: 'トラック名', onchange: (e) => store.mutate(() => (track.name = e.target.value || track.name)) });
      const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: track.volume ?? 1, title: 'トラック音量' });
      vol.addEventListener('pointerdown', () => store.beginGesture());
      vol.addEventListener('input', () => {
        track.volume = Number(vol.value);
        this.player.setLayout(store.layout());
      });
      vol.addEventListener('change', () => store.endGesture());
      add(this.content, 
        h('div', { class: 'tl-row' },
          h('div', { class: 'tl-head' },
            h('div', { class: 'tname' }, h('span', { class: 'dot', style: { background: track.kind === 'narration' ? 'var(--narr)' : 'var(--audio)' } }), nameInput),
            h('div', { class: 'tacts' },
              h('button', { class: 'icon-btn', title: track.muted ? 'ミュート解除' : 'ミュート', onclick: () => store.mutate(() => (track.muted = !track.muted)) }, track.muted ? '🔇' : '🔊'),
              vol,
              h('button', {
                class: 'icon-btn', title: 'トラックを削除',
                onclick: async () => {
                  if (track.clips.length && !(await confirmDialog(`「${track.name}」と中の ${track.clips.length} 個のクリップを削除しますか？`, '削除', true))) return;
                  store.mutate((p) => (p.audioTracks = p.audioTracks.filter((t) => t.id !== track.id)));
                },
              }, '✕'),
            ),
          ),
          lane,
        ),
      );
    }

    this.playheadEl = h('div', { class: 'playhead' });
    add(this.content, this.playheadEl);
    this.updatePlayhead(store.time);
    this.updateSelection();
    this.info.textContent = `合計 ${formatTime(lay.duration)}`;
    this.player.setLayout(lay);
  }

  clipBg(el, seg, kind) {
    const z = this.zoom;
    const item = seg.item;
    if (!item) return;
    if (kind === 'audio') {
      if (item.waveUrl) {
        el.style.backgroundImage = `url("${item.waveUrl}")`;
        el.style.backgroundSize = `${(item.duration || seg.duration) * z}px 70%`;
        el.style.backgroundPosition = `${-(seg.clip.in || 0) * z}px 70%`;
      }
    } else if (item.thumbUrl) {
      el.style.backgroundImage = `url("${item.thumbUrl}")`;
    }
  }

  videoClipEl(seg) {
    const { clip, item } = seg;
    const kind = item?.kind === 'image' ? 'image' : 'video';
    const el = h('div', { class: `clip ${kind} ${item ? '' : 'missing'}`, dataset: { id: clip.id, type: 'video' } });
    this.placeEl(el, seg);
    this.clipBg(el, seg, 'video');
    const muted = clip.muted || (clip.volume ?? 1) === 0;
    add(el, 
      h('div', { class: 'clabel' }, `${kind === 'image' ? '🖼 ' : ''}${muted && item?.hasAudio ? '🔇 ' : ''}${item ? item.name : '（素材が見つかりません）'}`),
      h('div', { class: 'cdur' }, `${seg.duration.toFixed(1)}s`),
      clip.fadeIn ? h('div', { class: 'fade in', style: { width: `${clip.fadeIn * this.zoom}px` } }) : null,
      clip.fadeOut ? h('div', { class: 'fade out', style: { width: `${clip.fadeOut * this.zoom}px` } }) : null,
    );
    this.attachClipHandlers(el, { type: 'video', id: clip.id });
    this.elById.set(clip.id, el);
    return el;
  }

  audioClipEl(seg) {
    const { clip, item, track } = seg;
    const el = h('div', { class: `clip audio ${track.kind === 'narration' ? 'narration' : ''} ${item ? '' : 'missing'}`, dataset: { id: clip.id, type: 'audio' } });
    this.placeEl(el, seg);
    this.clipBg(el, seg, 'audio');
    add(el, 
      h('div', { class: 'clabel' }, `${seg.anchored ? '🔗 ' : ''}${clip.muted ? '🔇 ' : ''}${item ? item.name : '（素材が見つかりません）'}`),
      h('div', { class: 'cdur' }, `${seg.duration.toFixed(1)}s`),
      clip.fadeIn ? h('div', { class: 'fade in', style: { width: `${clip.fadeIn * this.zoom}px` } }) : null,
      clip.fadeOut ? h('div', { class: 'fade out', style: { width: `${clip.fadeOut * this.zoom}px` } }) : null,
    );
    this.attachClipHandlers(el, { type: 'audio', id: clip.id });
    this.elById.set(clip.id, el);
    return el;
  }

  placeEl(el, seg) {
    el.style.left = `${seg.start * this.zoom}px`;
    el.style.width = `${Math.max(4, seg.duration * this.zoom)}px`;
  }

  /** ドラッグ中: DOM を作り直さず位置だけ更新 */
  positionAll() {
    const lay = store.layout();
    this.lay = lay;
    for (const seg of [...lay.video, ...lay.audio]) {
      const el = this.elById.get(seg.clip.id);
      if (!el) continue;
      this.placeEl(el, seg);
      this.clipBg(el, seg, seg.track ? 'audio' : 'video');
      const d = el.querySelector('.cdur');
      if (d) d.textContent = `${seg.duration.toFixed(1)}s`;
    }
    this.info.textContent = `合計 ${formatTime(lay.duration)}`;
    this.player.setLayout(lay);
  }

  updateSelection() {
    const id = store.selection?.id;
    for (const [cid, el] of this.elById) el.classList.toggle('selected', cid === id);
  }

  updatePlayhead(t, follow = false) {
    if (!this.playheadEl) return;
    const x = HEAD_W + t * this.zoom;
    this.playheadEl.style.left = `${x}px`;
    if (follow && this.player.playing) {
      const sl = this.scroll.scrollLeft;
      const w = this.scroll.clientWidth;
      if (x > sl + w - 40 || x < sl + HEAD_W) this.scroll.scrollLeft = x - HEAD_W - 40;
    }
  }

  // ------------------------------------------------------------- 操作
  timeFromEvent(e, lane) {
    const rect = lane.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left) / this.zoom);
  }

  scrubStart(e, ruler) {
    e.preventDefault();
    const wasPlaying = this.player.playing;
    if (wasPlaying) this.player.pause();
    const seek = (ev) => this.player.seek(Math.min(this.timeFromEvent(ev, ruler), this.lay.duration));
    seek(e);
    const up = () => {
      window.removeEventListener('pointermove', seek);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', seek);
    window.addEventListener('pointerup', up);
  }

  setupLane(lane) {
    lane.addEventListener('pointerdown', (e) => {
      if (e.target !== lane && !e.target.classList.contains('tl-end') && !e.target.classList.contains('tl-empty-hint')) return;
      store.select(null);
      this.player.seek(Math.min(this.timeFromEvent(e, lane), this.lay.duration));
    });
    lane.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-item-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop-ok');
      if (lane.dataset.lane === 'video') this.showInsertMarker(this.insertIndexAt(this.timeFromEvent(e, lane)));
    });
    lane.addEventListener('dragleave', () => {
      lane.classList.remove('drop-ok');
      this.hideInsertMarker();
    });
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('drop-ok');
      this.hideInsertMarker();
      const item = store.itemsById[e.dataTransfer.getData('text/x-item-id')];
      if (!item) return;
      const t = this.timeFromEvent(e, lane);
      if (lane.dataset.lane === 'video') {
        if (item.kind === 'audio') return toast('音声は下の音声トラックにドロップしてください', 'warn');
        store.addVideoClip(item, { index: this.insertIndexAt(t) });
      } else {
        store.addAudioClip(item, { trackId: lane.dataset.track, start: t });
      }
    });
  }

  insertIndexAt(t, excludeId) {
    let idx = 0;
    for (const seg of this.lay.video) {
      if (seg.clip.id === excludeId) continue;
      if (t > seg.start + seg.duration / 2) idx++;
    }
    return idx;
  }

  showInsertMarker(index, excludeId) {
    const segs = this.lay.video.filter((s) => s.clip.id !== excludeId);
    let x = 0;
    for (let i = 0; i < index && i < segs.length; i++) x += segs[i].duration;
    // 除外クリップより後ろの位置は実際の表示位置に合わせる
    let t = x;
    if (excludeId) {
      const idxEx = this.lay.video.findIndex((s) => s.clip.id === excludeId);
      const ex = this.lay.video[idxEx];
      if (ex && index >= idxEx) t = x + ex.duration;
    }
    if (!this.marker) this.marker = h('div', { class: 'insert-marker' });
    this.marker.style.left = `${t * this.zoom - 1}px`;
    if (this.marker.parentNode !== this.vlane) this.vlane.append(this.marker);
  }

  hideInsertMarker() {
    this.marker?.remove();
  }

  showSnap(t) {
    if (!this.snapEl) this.snapEl = h('div', { class: 'snap-line' });
    if (t === null) return this.snapEl.remove();
    this.snapEl.style.left = `${HEAD_W + t * this.zoom}px`;
    if (!this.snapEl.parentNode) add(this.content, this.snapEl);
  }

  snapPoints(excludeId) {
    const pts = [0, store.time];
    for (const s of this.lay.video) pts.push(s.start, s.end);
    for (const a of this.lay.audio) if (a.clip.id !== excludeId) pts.push(a.start, a.end);
    return pts;
  }

  attachClipHandlers(el, sel) {
    el.addEventListener('dblclick', () => {
      const seg = [...this.lay.video, ...this.lay.audio].find((s) => s.clip.id === sel.id);
      if (seg) this.player.seek(seg.start);
    });
    const lHandle = h('div', { class: 'handle l', title: 'ドラッグで開始位置をトリム' });
    const rHandle = h('div', { class: 'handle r', title: 'ドラッグで終了位置をトリム' });
    el.append(lHandle, rHandle);
    lHandle.addEventListener('pointerdown', (e) => this.dragClip(e, el, sel, 'trimL'));
    rHandle.addEventListener('pointerdown', (e) => this.dragClip(e, el, sel, 'trimR'));
    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('handle')) return;
      this.dragClip(e, el, sel, 'move');
    });
  }

  dragClip(e, el, sel, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (store.selection?.id !== sel.id) store.select(sel);
    const found = store.findClip(sel);
    if (!found) return;
    const clip = found.clip;
    const orig = JSON.parse(JSON.stringify(clip));
    const item = store.itemsById[clip.itemId];
    const segs = sel.type === 'video' ? this.lay.video : this.lay.audio;
    const seg0 = segs.find((s) => s.clip.id === sel.id);
    const anchorStart = seg0 && seg0.anchored ? seg0.start - (orig.offset || 0) : 0;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let insertIdx = null;
    const wasPlaying = this.player.playing;
    el.setPointerCapture(e.pointerId);

    const snapT = (t, dur) => {
      if (!this.snap) return { t, line: null };
      const thr = 8 / this.zoom;
      let best = null;
      for (const p of this.snapPoints(sel.id)) {
        if (Math.abs(p - t) < thr && (!best || Math.abs(p - t) < Math.abs(best.d))) best = { t: p, line: p, d: p - t };
        if (dur !== undefined && Math.abs(p - (t + dur)) < thr && (!best || Math.abs(p - (t + dur)) < Math.abs(best.d))) best = { t: p - dur, line: p, d: p - (t + dur) };
      }
      return best ? { t: best.t, line: best.line } : { t, line: null };
    };

    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        started = true;
        this.dragging = true;
        if (wasPlaying) this.player.pause();
        store.beginGesture();
        el.classList.add('dragging');
      }
      const dt = dx / this.zoom;
      const maxDur = item ? (item.kind === 'image' ? 3600 : item.duration || orig.out) : orig.out;

      if (sel.type === 'video') {
        if (mode === 'move') {
          el.style.transform = `translateX(${dx}px)`;
          const center = seg0.start + seg0.duration / 2 + dt;
          insertIdx = this.insertIndexAt(center, sel.id);
          this.showInsertMarker(insertIdx, sel.id);
          return;
        }
        if (mode === 'trimL') {
          if (item?.kind === 'image') clip.out = Math.max(0.2, Math.min(3600, orig.out - dt));
          else clip.in = Math.max(0, Math.min(orig.out - 0.1, orig.in + dt));
        } else {
          clip.out = Math.max(orig.in + 0.1, Math.min(maxDur, orig.out + dt));
        }
      } else {
        if (mode === 'move') {
          const dur = orig.out - orig.in;
          const raw = Math.max(0, seg0.start + dt);
          const s = snapT(raw, dur);
          const newStart = Math.max(0, s.t);
          this.showSnap(s.line);
          if (clip.anchorClipId) clip.offset = newStart - anchorStart;
          else clip.start = newStart;
          // 別の音声トラックへ移動
          const laneEl = document.elementsFromPoint(ev.clientX, ev.clientY).find((x) => x.dataset?.lane === 'audio');
          if (laneEl && laneEl.dataset.track !== store.project.audioTracks.find((t) => t.clips.includes(clip))?.id) {
            const from = store.project.audioTracks.find((t) => t.clips.includes(clip));
            const to = store.project.audioTracks.find((t) => t.id === laneEl.dataset.track);
            if (from && to) {
              from.clips = from.clips.filter((c) => c !== clip);
              to.clips.push(clip);
              laneEl.append(el);
            }
          }
        } else if (mode === 'trimL') {
          let newIn = Math.max(0, Math.min(orig.out - 0.1, orig.in + dt));
          const minIn = orig.in - seg0.start; // 開始が 0 秒より前にならないように
          newIn = Math.max(newIn, minIn);
          const delta = newIn - orig.in;
          clip.in = newIn;
          if (clip.anchorClipId) clip.offset = (orig.offset || 0) + delta;
          else clip.start = orig.start + delta;
        } else {
          const raw = Math.max(orig.in + 0.1, Math.min(maxDur, orig.out + dt));
          const s = snapT(seg0.start + (raw - orig.in));
          clip.out = Math.max(orig.in + 0.1, Math.min(maxDur, s.t - seg0.start + orig.in));
          this.showSnap(s.line);
        }
      }
      this.positionAll();
      if (sel.type === 'video' && mode === 'trimL') {
        const s = this.lay.video.find((v) => v.clip.id === sel.id);
        if (s) this.player.seek(s.start);
      } else if (sel.type === 'video' && mode === 'trimR') {
        const s = this.lay.video.find((v) => v.clip.id === sel.id);
        if (s) this.player.seek(Math.max(s.start, s.end - 0.04));
      }
    };

    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!started) return;
      this.dragging = false;
      el.classList.remove('dragging');
      el.style.transform = '';
      this.hideInsertMarker();
      this.showSnap(null);
      if (sel.type === 'video' && mode === 'move' && insertIdx !== null) {
        const arr = store.project.videoClips;
        const from = arr.findIndex((c) => c.id === sel.id);
        const [c] = arr.splice(from, 1);
        arr.splice(insertIdx, 0, c);
      }
      store.endGesture();
      store.emit('selection');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
