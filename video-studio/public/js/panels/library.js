// 「ライブラリ」パネル: 生成動画・読み込んだ素材・ナレーション音声
import { api } from '../api.js';
import { store } from '../store.js';
import { h, clear, toast, segmented, confirmDialog, lsGet, lsSet, add } from '../ui.js';
import { openPreview } from '../dialogs.js';
import { formatTime } from '../shared/timeline-core.js';

const SRC_LABEL = { generated: ['AI', 'ai'], narration: ['ナレ', 'narr'], upload: ['読込', ''] };

export async function deleteLibraryItem(item) {
  const used = store.project.videoClips.some((c) => c.itemId === item.id) || store.project.audioTracks.some((t) => t.clips.some((c) => c.itemId === item.id));
  if (!(await confirmDialog(`「${item.name}」をライブラリから削除しますか？${used ? '\n\n⚠ タイムラインで使用中です。削除するとそのクリップは書き出せなくなります。' : ''}`, '削除', true))) return false;
  try {
    await api.del(`/api/library/${item.id}`);
    await store.refreshLibrary();
    toast('削除しました', 'ok');
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

export function addItemToTimeline(item) {
  if (item.kind === 'audio') {
    store.addAudioClip(item, { start: store.time });
    toast(`「${item.name}」を音声トラックの再生ヘッド位置に追加しました`, 'ok');
  } else {
    store.addVideoClip(item);
    toast(`「${item.name}」をタイムラインに追加しました`, 'ok');
  }
}

export class LibraryPanel {
  constructor(root) {
    this.root = root;
    this.filter = lsGet('libFilter', 'all');
    store.on('library', () => this.renderGrid());
    this.render();
  }

  render() {
    clear(this.root);
    const input = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', class: 'hidden', onchange: (e) => this.import([...e.target.files]) });
    const dz = h('div', { class: 'dropzone', onclick: () => input.click() }, '⬆ 自分の動画・音声（BGM）・画像を読み込む', h('div', { class: 'tiny' }, 'クリック または ドラッグ＆ドロップ'));
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      if (e.dataTransfer.files.length) this.import([...e.dataTransfer.files]);
    });
    this.progress = h('div', { class: 'progress hidden' }, h('div', { style: { width: '0%' } }));
    this.grid = h('div', { class: 'lib-grid' });
    add(this.root, 
      dz, input, this.progress,
      h('div', { class: 'row' },
        segmented([{ value: 'all', label: 'すべて' }, { value: 'generated', label: 'AI生成' }, { value: 'video', label: '動画' }, { value: 'audio', label: '音声' }, { value: 'image', label: '画像' }], this.filter, (v) => {
          this.filter = v;
          lsSet('libFilter', v);
          this.renderGrid();
        }),
      ),
      h('div', { class: 'hint' }, 'カードをタイムラインへドラッグ、または ＋ で追加。📎 で生成の参考素材として添付できます。'),
      this.grid,
    );
    this.renderGrid();
  }

  renderGrid() {
    if (!this.grid) return;
    clear(this.grid);
    const items = store.library.filter((i) => {
      if (this.filter === 'all') return true;
      if (this.filter === 'generated') return i.source === 'generated';
      return i.kind === this.filter;
    });
    if (!items.length) {
      this.grid.append(h('div', { class: 'empty-note', style: { gridColumn: '1 / -1' } }, 'まだ素材がありません'));
      return;
    }
    for (const item of items) {
      const [srcLabel, srcCls] = SRC_LABEL[item.source] || ['', ''];
      const pic =
        item.kind === 'audio'
          ? h('div', { class: 'pic wave', style: item.waveUrl ? { backgroundImage: `url("${item.waveUrl}")` } : {} }, item.waveUrl ? '' : '🎵')
          : h('div', { class: 'pic', style: item.thumbUrl ? { backgroundImage: `url("${item.thumbUrl}")` } : {} }, item.thumbUrl ? '' : '🎞');
      const card = h('div', { class: 'lib-item', draggable: 'true', title: item.meta?.prompt || item.meta?.script || item.name },
        pic,
        item.duration ? h('span', { class: 'dur' }, formatTime(item.duration)) : null,
        srcLabel ? h('span', { class: `badge src ${srcCls}` }, srcLabel) : null,
        h('div', { class: 'hover-acts' },
          h('button', { title: 'タイムラインに追加', onclick: (e) => { e.stopPropagation(); addItemToTimeline(item); } }, '＋'),
          h('button', { title: '生成の参考として添付', onclick: (e) => { e.stopPropagation(); store.emit('gen:attach-item', item); } }, '📎'),
          h('button', { title: '削除', onclick: (e) => { e.stopPropagation(); deleteLibraryItem(item); } }, '🗑'),
        ),
        h('div', { class: 'cap' }, h('div', { class: 'n' }, item.name), h('div', { class: 'tiny' }, item.kind === 'image' ? `${item.width}×${item.height}` : item.width ? `${item.width}×${item.height}` : '音声')),
      );
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-item-id', item.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('click', () => openPreview(item));
      this.grid.append(card);
    }
  }

  async import(files) {
    if (!files.length) return;
    this.progress.classList.remove('hidden');
    try {
      const r = await api.upload('/api/library/import', files, (p) => (this.progress.firstChild.style.width = `${Math.round(p * 100)}%`));
      if (r.items.length) {
        store.upsertItems(r.items);
        toast(`${r.items.length} 件を読み込みました`, 'ok');
      }
      for (const e of r.errors || []) toast(e, 'err');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      this.progress.classList.add('hidden');
    }
  }
}
