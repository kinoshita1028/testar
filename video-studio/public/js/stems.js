// 映像と音声を分ける／声と BGM を分ける（画面側）
import { api } from './api.js';
import { store } from './store.js';
import { h, modal, toast, uid } from './ui.js';

let statusCache = null;
export async function separationStatus(refresh = false) {
  if (!statusCache || refresh) {
    try {
      statusCache = await api.get('/api/separate/status');
    } catch {
      statusCache = { available: false };
    }
  }
  return statusCache;
}

/** 名前の音声トラックを探す（なければ作る）。mutate の中で使う */
function trackFor(p, name) {
  let t = p.audioTracks.find((x) => x.name === name);
  if (!t) {
    t = { id: uid('t_'), name, kind: 'audio', muted: false, volume: 1, clips: [] };
    p.audioTracks.push(t);
  }
  return t;
}

function anchoredClip(itemId, clip, volume = 1) {
  return { id: uid('a_'), itemId, start: 0, in: clip.in, out: clip.out, volume, fadeIn: 0, fadeOut: 0, anchorClipId: clip.id, offset: 0 };
}

/** タイムラインの動画クリップの音声を、別の音声クリップとして切り離す */
export async function detachAudio(clip) {
  const item = store.itemsById[clip.itemId];
  if (!item?.hasAudio) return toast('この動画には音声がありません', 'warn');
  try {
    const r = await api.post(`/api/media/${item.id}/extract-audio`);
    store.upsertItems([r.item]);
    store.mutate((p) => {
      trackFor(p, '元の音声').clips.push(anchoredClip(r.item.id, clip, clip.muted ? 1 : clip.volume ?? 1));
      const c = p.videoClips.find((x) => x.id === clip.id);
      if (c) c.muted = true;
    });
    toast('映像と音声を分けました。音声は「元の音声」トラックで、位置・音量・トリムを別々に調整できます（映像に連動して動きます）。', 'ok', 6000);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 動画から音声だけを取り出してライブラリに入れる */
export async function extractAudioToLibrary(item) {
  try {
    const r = await api.post(`/api/media/${item.id}/extract-audio`);
    store.upsertItems([r.item]);
    toast(`音声を取り出してライブラリに入れました: ${r.item.name}`, 'ok');
    return r.item;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

/** 声と BGM を分ける（進み具合を表示）。結果 {voice, background} を返す */
export async function separateWithProgress(item, { highQuality = false } = {}) {
  const st = await separationStatus(true);
  if (!st.available) {
    toast('声と BGM を分ける部品（onnxruntime-node）が入っていません。ツールのフォルダで npm install をもう一度実行してください。', 'err');
    return null;
  }
  const bar = h('div', { style: { width: '0%' } });
  const msg = h('div', { class: 'tiny' }, '準備しています…');
  let cancelled = false;
  const m = modal({
    title: '🎚 声と BGM を分けています',
    body: h('div', { class: 'stack' },
      h('div', { class: 'small' }, item.name),
      h('div', { class: 'progress' }, bar),
      msg,
      h('div', { class: 'hint' }, `この PC の中の AI で処理します（料金はかかりません）。${st.modelDownloaded ? '' : `初回だけ分離 AI のデータ（約 ${st.modelSizeMB}MB）をダウンロードします。`}1 分の音声で 1 分前後かかります。`),
    ),
    onClose: () => (cancelled = true),
  });
  try {
    const { job } = await api.post(`/api/media/${item.id}/separate`, { highQuality });
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const { job: j } = await api.get(`/api/jobs/${job.id}`);
      bar.style.width = `${Math.round((j.progress || 0) * 100)}%`;
      msg.textContent = j.message || '';
      if (j.status === 'done') {
        store.upsertItems([j.voice, j.background]);
        statusCache = null;
        if (!cancelled) m.close();
        return { voice: j.voice, background: j.background };
      }
      if (j.status === 'error') throw new Error(j.error);
    }
  } catch (e) {
    if (!cancelled) m.close();
    toast(`声と BGM を分けられませんでした: ${e.message}`, 'err');
    return null;
  }
}

/** タイムラインの動画クリップを「映像」「声」「BGM・効果音」に分ける */
export async function separateClip(clip) {
  const item = store.itemsById[clip.itemId];
  if (!item?.hasAudio) return toast('この動画には音声がありません', 'warn');
  const r = await separateWithProgress(item);
  if (!r) return;
  const vol = clip.muted ? 1 : clip.volume ?? 1;
  store.mutate((p) => {
    trackFor(p, '声（分離）').clips.push(anchoredClip(r.voice.id, clip, vol));
    trackFor(p, 'BGM・効果音（分離）').clips.push(anchoredClip(r.background.id, clip, vol));
    const c = p.videoClips.find((x) => x.id === clip.id);
    if (c) c.muted = true;
  });
  toast('声と BGM・効果音を分けました。「声（分離）」「BGM・効果音（分離）」トラックで、別々にミュート・音量調整・削除ができます。', 'ok', 7000);
}

/** ライブラリの素材を分けて、2 つの音声として保存する */
export async function separateToLibrary(item) {
  const r = await separateWithProgress(item);
  if (r) toast(`分けました: 「${r.voice.name}」と「${r.background.name}」をライブラリに入れました`, 'ok', 6000);
  return r;
}
