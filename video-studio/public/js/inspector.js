// 右側パネル: 選択中のクリップ／プロジェクトのプロパティ
import { store } from './store.js';
import { h, clear, select, add } from './ui.js';
import { formatTime } from './shared/timeline-core.js';
import { openPreview } from './dialogs.js';

export class Inspector {
  constructor(root, player) {
    this.root = root;
    this.player = player;
    this.interacting = false;
    store.on('selection', () => this.render());
    store.on('project', () => !this.interacting && this.render());
    store.on('library', () => this.render());
    this.render();
  }

  /** スライダー: ドラッグ中は履歴に積まず、離したら 1 回分の履歴にする */
  slider({ min, max, step, value, format, onInput }) {
    const out = h('span', {}, format(value));
    const r = h('input', { type: 'range', min, max, step, value });
    r.addEventListener('pointerdown', () => {
      this.interacting = true;
      store.beginGesture();
    });
    r.addEventListener('input', () => {
      if (!this.interacting) {
        this.interacting = true;
        store.beginGesture();
      }
      const v = Number(r.value);
      out.textContent = format(v);
      onInput(v);
      store.emit('project');
    });
    r.addEventListener('change', () => {
      this.interacting = false;
      store.endGesture();
    });
    return h('div', { class: 'slider-row' }, r, out);
  }

  numInput(value, onChange, attrs = {}) {
    return h('input', {
      type: 'number', step: 0.1, value: Number(value).toFixed(2), ...attrs,
      onchange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) store.mutate(() => onChange(v));
      },
    });
  }

  render() {
    const scroll = this.root.scrollTop;
    clear(this.root);
    const found = store.findClip();
    if (!found) this.renderProject();
    else if (store.selection.type === 'video') this.renderVideo(found.clip);
    else this.renderAudio(found.clip, found.track);
    this.root.scrollTop = scroll;
  }

  renderProject() {
    const p = store.project;
    const lay = store.layout();
    add(this.root, 
      h('div', { class: 'insp-title' }, '📁 プロジェクト'),
      h('label', { class: 'field' }, '名前', h('input', { value: p.name, onchange: (e) => store.mutate((pp) => (pp.name = e.target.value || '無題のプロジェクト')) })),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '縦横比', select([{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: '4:5', label: '4:5' }], p.aspectRatio, (v) => store.mutate((pp) => (pp.aspectRatio = v)))),
        h('label', { class: 'field' }, '書き出し解像度', select([{ value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }], p.resolution, (v) => store.mutate((pp) => (pp.resolution = v)))),
      ),
      h('div', { class: 'kv' },
        h('span', {}, '長さ'), h('span', {}, formatTime(lay.duration)),
        h('span', {}, '動画クリップ'), h('span', {}, `${lay.video.length}`),
        h('span', {}, '音声クリップ'), h('span', {}, `${lay.audio.length}`),
      ),
      h('div', { class: 'hint' }, 'タイムラインのクリップをクリックすると、ここでトリム・音量・フェード・ナレーションを設定できます。'),
      h('div', { class: 'section-title' }, 'ショートカット'),
      h('div', { class: 'shortcuts' },
        h('span', { class: 'kbd' }, 'Space'), h('span', {}, '再生 / 一時停止'),
        h('span', { class: 'kbd' }, 'S'), h('span', {}, '再生ヘッドで分割'),
        h('span', { class: 'kbd' }, 'Delete'), h('span', {}, '選択クリップを削除'),
        h('span', { class: 'kbd' }, 'Ctrl+D'), h('span', {}, '複製'),
        h('span', { class: 'kbd' }, 'Ctrl+Z'), h('span', {}, '元に戻す（Shift でやり直し）'),
        h('span', { class: 'kbd' }, '← →'), h('span', {}, '1フレーム移動（Shift で1秒）'),
        h('span', { class: 'kbd' }, 'Ctrl+ホイール'), h('span', {}, 'タイムラインのズーム'),
        h('span', { class: 'kbd' }, 'ダブルクリック'), h('span', {}, 'クリップの先頭へ移動'),
      ),
    );
  }

  playheadIn(seg) {
    const t = store.time;
    return seg && t >= seg.start && t <= seg.end ? seg.clip.in + (t - seg.start) : null;
  }

  renderVideo(clip) {
    const item = store.itemsById[clip.itemId];
    const seg = store.layout().video.find((v) => v.clip.id === clip.id);
    const isImage = item?.kind === 'image';
    const maxOut = isImage ? 3600 : item?.duration || clip.out;
    add(this.root, 
      h('div', { class: 'insp-title' }, isImage ? '🖼 画像クリップ' : '🎞 動画クリップ'),
      h('div', { class: 'insp-thumb', style: item?.thumbUrl ? { backgroundImage: `url("${item.thumbUrl}")` } : {} }),
      h('div', { class: 'small', style: { wordBreak: 'break-all' } }, item ? item.name : '⚠ 素材がライブラリにありません'),
      h('div', { class: 'kv' },
        h('span', {}, '位置'), h('span', {}, seg ? `${formatTime(seg.start)} 〜 ${formatTime(seg.end)}` : ''),
        !isImage ? h('span', {}, '素材の長さ') : null, !isImage ? h('span', {}, `${(item?.duration || 0).toFixed(2)} 秒`) : null,
      ),
      h('div', { class: 'section-title' }, isImage ? '表示時間' : 'トリム（切り取り）'),
      isImage
        ? h('label', { class: 'field' }, '長さ（秒）', this.numInput(clip.out - clip.in, (v) => { clip.in = 0; clip.out = Math.max(0.2, Math.min(3600, v)); }, { min: 0.2 }))
        : h('div', { class: 'num-row' },
            h('label', { class: 'field' }, '開始（秒）', this.numInput(clip.in, (v) => (clip.in = Math.max(0, Math.min(v, clip.out - 0.1))), { min: 0, max: maxOut })),
            h('label', { class: 'field' }, '終了（秒）', this.numInput(clip.out, (v) => (clip.out = Math.min(maxOut, Math.max(v, clip.in + 0.1))), { min: 0, max: maxOut })),
          ),
      !isImage
        ? h('div', { class: 'row wrap' },
            h('button', { class: 'btn sm', title: '再生ヘッドの位置を開始点にする', onclick: () => { const v = this.playheadIn(seg); if (v !== null) store.mutate(() => (clip.in = Math.min(v, clip.out - 0.1))); } }, '[ ここから'),
            h('button', { class: 'btn sm', title: '再生ヘッドの位置を終了点にする', onclick: () => { const v = this.playheadIn(seg); if (v !== null) store.mutate(() => (clip.out = Math.max(v, clip.in + 0.1))); } }, 'ここまで ]'),
            h('button', { class: 'btn sm ghost', onclick: () => store.mutate(() => { clip.in = 0; clip.out = maxOut; }) }, '元の長さに戻す'),
          )
        : null,
      h('div', { class: 'tiny' }, `クリップの長さ: ${(clip.out - clip.in).toFixed(2)} 秒 · タイムラインの端をドラッグしても調整できます`),
      !isImage ? h('div', { class: 'section-title' }, '元の音声') : null,
      !isImage && item && !item.hasAudio ? h('div', { class: 'tiny' }, 'この動画には音声トラックがありません') : null,
      !isImage && item?.hasAudio
        ? h('div', { class: 'stack' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: clip.muted, onchange: (e) => store.mutate(() => (clip.muted = e.target.checked)) }), 'ミュートする（ナレーションや BGM に置き換えるとき）'),
            h('label', { class: 'field' }, '音量', this.slider({ min: 0, max: 2, step: 0.05, value: clip.volume ?? 1, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (clip.volume = v) })),
          )
        : null,
      h('div', { class: 'section-title' }, 'フェード（黒から/黒へ）'),
      h('label', { class: 'field' }, 'フェードイン', this.slider({ min: 0, max: 3, step: 0.1, value: clip.fadeIn || 0, format: (v) => `${v.toFixed(1)}s`, onInput: (v) => (clip.fadeIn = v) })),
      h('label', { class: 'field' }, 'フェードアウト', this.slider({ min: 0, max: 3, step: 0.1, value: clip.fadeOut || 0, format: (v) => `${v.toFixed(1)}s`, onInput: (v) => (clip.fadeOut = v) })),
      h('div', { class: 'section-title' }, '操作'),
      h('button', { class: 'btn block', onclick: () => store.emit('narr:target', clip.id) || store.emit('ui:tab', 'narration') }, '🎙 このクリップにナレーションを付ける'),
      item?.kind === 'video' && item.hasAudio
        ? h('button', {
            class: 'btn block',
            title: '再生ヘッドの位置の前後を選んで、その部分のセリフだけ差し替えます',
            onclick: async () => {
              const { openVoiceEdit } = await import('./voiceedit.js');
              const at = seg && store.time >= seg.start && store.time <= seg.end ? clip.in + (store.time - seg.start) : clip.in;
              openVoiceEdit(item, { clipId: clip.id, start: Math.max(clip.in, at - 1), end: Math.min(clip.out, at + 2) });
            },
          }, '🎙 一部のセリフを差し替え（その部分の声で）')
        : null,
      h('div', { class: 'grid2' },
        h('button', { class: 'btn', onclick: () => store.splitAt() }, '✂ 分割'),
        h('button', { class: 'btn', onclick: () => store.duplicateSelected() }, '⧉ 複製'),
        item ? h('button', { class: 'btn', onclick: () => openPreview(item) }, '▶ 素材を見る') : h('span'),
        h('button', { class: 'btn danger', onclick: () => store.deleteSelected() }, '🗑 削除'),
      ),
      item?.meta?.prompt ? h('details', {}, h('summary', {}, '生成プロンプト'), h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap' } }, item.meta.prompt)) : null,
    );
  }

  renderAudio(clip, track) {
    const item = store.itemsById[clip.itemId];
    const seg = store.layout().audio.find((a) => a.clip.id === clip.id);
    const maxOut = item?.duration || clip.out;
    const anchorIdx = clip.anchorClipId ? store.project.videoClips.findIndex((c) => c.id === clip.anchorClipId) : -1;
    add(this.root, 
      h('div', { class: 'insp-title' }, track.kind === 'narration' ? '🎙 ナレーション' : '🎵 音声クリップ'),
      item?.waveUrl ? h('img', { src: item.waveUrl, style: { width: '100%', height: '56px', objectFit: 'fill', background: '#10151d', borderRadius: '6px' } }) : null,
      h('div', { class: 'small', style: { wordBreak: 'break-all' } }, item ? item.name : '⚠ 素材がライブラリにありません'),
      h('div', { class: 'kv' },
        h('span', {}, 'トラック'), h('span', {}, track.name),
        h('span', {}, '位置'), h('span', {}, seg ? `${formatTime(seg.start)} 〜 ${formatTime(seg.end)}` : ''),
        h('span', {}, '素材の長さ'), h('span', {}, `${(item?.duration || 0).toFixed(2)} 秒`),
      ),
      anchorIdx >= 0
        ? h('div', { class: 'banner' }, `🔗 動画クリップ ${anchorIdx + 1} に連動（並べ替えても一緒に動きます）`, h('button', { class: 'btn sm x', onclick: () => store.mutate(() => { clip.start = seg.start; delete clip.anchorClipId; delete clip.offset; }) }, '解除'))
        : null,
      h('label', { class: 'field' }, anchorIdx >= 0 ? '連動クリップ先頭からのずれ（秒）' : '開始位置（秒）',
        anchorIdx >= 0 ? this.numInput(clip.offset || 0, (v) => (clip.offset = v)) : this.numInput(clip.start || 0, (v) => (clip.start = Math.max(0, v)), { min: 0 })),
      h('div', { class: 'section-title' }, 'トリム'),
      h('div', { class: 'num-row' },
        h('label', { class: 'field' }, '開始（秒）', this.numInput(clip.in, (v) => (clip.in = Math.max(0, Math.min(v, clip.out - 0.1))), { min: 0 })),
        h('label', { class: 'field' }, '終了（秒）', this.numInput(clip.out, (v) => (clip.out = Math.min(maxOut, Math.max(v, clip.in + 0.1))), { min: 0 })),
      ),
      h('div', { class: 'section-title' }, '音量'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: clip.muted, onchange: (e) => store.mutate(() => (clip.muted = e.target.checked)) }), 'ミュート'),
      this.slider({ min: 0, max: 2, step: 0.05, value: clip.volume ?? 1, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (clip.volume = v) }),
      h('label', { class: 'field' }, 'フェードイン', this.slider({ min: 0, max: 5, step: 0.1, value: clip.fadeIn || 0, format: (v) => `${v.toFixed(1)}s`, onInput: (v) => (clip.fadeIn = v) })),
      h('label', { class: 'field' }, 'フェードアウト', this.slider({ min: 0, max: 5, step: 0.1, value: clip.fadeOut || 0, format: (v) => `${v.toFixed(1)}s`, onInput: (v) => (clip.fadeOut = v) })),
      h('div', { class: 'grid2' },
        h('button', { class: 'btn', onclick: () => store.duplicateSelected() }, '⧉ 複製'),
        h('button', { class: 'btn danger', onclick: () => store.deleteSelected() }, '🗑 削除'),
      ),
      item ? h('button', { class: 'btn block', onclick: () => openPreview(item) }, '▶ 素材を聴く') : null,
      item?.meta?.script ? h('details', { open: true }, h('summary', {}, 'ナレーション原稿'), h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, item.meta.script)) : null,
    );
  }
}
