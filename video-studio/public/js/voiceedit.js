// 声の部分差し替え: 動画の一部分だけ、話している内容を別のセリフに置き換える
import { api } from './api.js';
import { store } from './store.js';
import { h, add, clear, modal, toast, select, segmented } from './ui.js';
import { TTS_VOICES } from './shared/capabilities.js';
import { formatTime } from './shared/timeline-core.js';
import { consentRecorder, loadVoices, postForm } from './voices.js';
import { EMOTIONS, SPEEDS, INTONATIONS, composeStyle, getNarrDraft } from './panels/narration.js';

/**
 * @param {object} item ライブラリの動画
 * @param {{ clipId?: string, start?: number, end?: number }} opts タイムラインから開いた場合はクリップ ID
 */
export function openVoiceEdit(item, opts = {}) {
  if (!item || item.kind !== 'video') return toast('動画を選んでください', 'warn');
  const dur = item.duration || 0;
  const isAI = item.source === 'generated';
  const nd = getNarrDraft();
  const st = {
    start: Math.max(0, Math.min(dur - 0.5, opts.start ?? 0)),
    end: Math.min(dur, opts.end ?? Math.min(dur, (opts.start ?? 0) + 3)),
    original: '',
    script: '',
    mode: (store.voices || []).length && !isAI ? 'existing' : isAI ? 'design' : 'copy',
    voice: nd.voice || 'Kore',
    loopTo: 30,
    consent: null,
    consentLang: 'en-US',
    emotion: nd.emotion || '',
    speed: nd.speed || '',
    intonation: nd.intonation || '',
    style: nd.style || '',
    fit: true,
    autoRewrite: false,
    keepVolume: 0,
    replaceClip: Boolean(opts.clipId),
  };

  // ---------------------------------------------------------------- 範囲の選択
  const video = h('video', { src: item.url, controls: true, playsinline: true, class: 'preview-video', style: { maxHeight: '40vh' } });
  const bar = h('div', { class: 'range-bar', style: item.waveUrl ? { backgroundImage: `url("${item.waveUrl}")` } : {}, title: 'ドラッグして差し替える範囲を選ぶ' });
  const sel = h('div', { class: 'range-sel' });
  const head = h('div', { class: 'range-head' });
  bar.append(sel, head);
  const startIn = h('input', { type: 'number', step: 0.1, min: 0, max: dur });
  const endIn = h('input', { type: 'number', step: 0.1, min: 0, max: dur });
  const rangeLabel = h('span', { class: 'small' });
  const syncRange = () => {
    st.start = Math.max(0, Math.min(st.start, dur));
    st.end = Math.max(st.start, Math.min(st.end, dur));
    sel.style.left = `${(st.start / dur) * 100}%`;
    sel.style.width = `${((st.end - st.start) / dur) * 100}%`;
    startIn.value = st.start.toFixed(1);
    endIn.value = st.end.toFixed(1);
    rangeLabel.textContent = `${formatTime(st.start)} 〜 ${formatTime(st.end)}（${(st.end - st.start).toFixed(1)} 秒）`;
    updateNote();
  };
  startIn.addEventListener('change', () => { st.start = Number(startIn.value) || 0; syncRange(); });
  endIn.addEventListener('change', () => { st.end = Number(endIn.value) || 0; syncRange(); });
  bar.addEventListener('pointerdown', (e) => {
    const rect = bar.getBoundingClientRect();
    const tAt = (ev) => Math.max(0, Math.min(dur, ((ev.clientX - rect.left) / rect.width) * dur));
    const t0 = tAt(e);
    st.start = t0;
    st.end = t0;
    syncRange();
    const move = (ev) => {
      const t = tAt(ev);
      st.start = Math.min(t0, t);
      st.end = Math.max(t0, t);
      syncRange();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (st.end - st.start < 0.3) st.end = Math.min(dur, st.start + 2);
      syncRange();
      video.currentTime = st.start;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  let stopAt = null;
  video.addEventListener('timeupdate', () => {
    head.style.left = `${(video.currentTime / dur) * 100}%`;
    if (stopAt !== null && video.currentTime >= stopAt) {
      video.pause();
      stopAt = null;
    }
  });

  // ---------------------------------------------------------------- セリフ
  const scriptTa = h('textarea', { rows: 3, placeholder: '差し替える新しいセリフ。「この範囲を文字起こし」で元のセリフを入れてから書き換えると簡単です。' });
  scriptTa.addEventListener('input', () => { st.script = scriptTa.value; updateNote(); });
  const origEl = h('div', { class: 'tiny' });
  const sttBtn = h('button', { class: 'btn sm' }, '📝 この範囲を文字起こし');
  sttBtn.addEventListener('click', async () => {
    if (!item.hasAudio) return toast('この動画には音声がありません', 'warn');
    sttBtn.disabled = true;
    sttBtn.textContent = '文字起こし中…';
    try {
      const r = await api.post('/api/narration/transcribe', { itemId: item.id, start: st.start, duration: st.end - st.start, model: store.settings.textModel });
      st.original = r.text;
      origEl.textContent = `元のセリフ: ${r.text}`;
      if (!st.script.trim()) {
        st.script = r.text;
        scriptTa.value = r.text;
      }
      updateNote();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      sttBtn.disabled = false;
      sttBtn.textContent = '📝 この範囲を文字起こし';
    }
  });
  const note = h('div', { class: 'tiny' });
  function updateNote() {
    const chars = [...String(st.script || '').replace(/\s/g, '')].length;
    const est = chars / 6;
    const len = st.end - st.start;
    note.className = `tiny ${est > len * 1.4 ? 'warn-text' : ''}`;
    note.textContent = st.script.trim() ? `${chars} 文字 ≈ 読み上げ約 ${est.toFixed(1)} 秒 / 範囲 ${len.toFixed(1)} 秒${est > len * 1.4 ? '（長すぎます。早口になるか末尾が切れます）' : ''}` : `範囲 ${len.toFixed(1)} 秒 ≈ ${Math.round(len * 6)} 文字くらいが目安`;
  }

  // ---------------------------------------------------------------- 声
  const voiceBox = h('div', { class: 'stack' });
  const renderVoice = () => {
    clear(voiceBox);
    const myVoices = store.voices || [];
    const modes = [
      ...(isAI ? [] : [{ value: 'copy', label: 'この部分の声をコピー' }]),
      { value: 'design', label: 'この部分の声に似た声を作る' },
      { value: 'existing', label: '作成済み・標準の声を使う' },
    ];
    if (!modes.some((m) => m.value === st.mode)) st.mode = modes[0].value;
    add(voiceBox, segmented(modes, st.mode, (v) => { st.mode = v; renderVoice(); }));
    if (isAI) add(voiceBox, h('div', { class: 'tiny' }, 'AI が生成した動画の声は、本人の同意の録音ができないためコピーできません（Google の決まり）。代わりに、似た声を作って差し替えます。'));
    if (st.mode === 'copy' || st.mode === 'design') {
      add(voiceBox,
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, '声のサンプルの長さ', select([10, 20, 30].map((n) => ({ value: String(n), label: `${n} 秒` })), String(st.loopTo), (v) => (st.loopTo = Number(v)))),
          h('div', { class: 'tiny', style: { alignSelf: 'end' } }, '選んだ範囲がこれより短いときは、その部分をくり返しつなげてこの長さにします。'),
        ),
        h('div', { class: 'tiny' }, '同じ部分のくり返しでは声の情報は増えないため、選べるなら長め（5 秒以上）の範囲のほうが似やすくなります。'),
      );
    }
    if (st.mode === 'copy') add(voiceBox, h('div', { class: 'section-title' }, '本人の同意の録音'), consentRecorder(st));
    if (st.mode === 'existing') {
      const opts = [
        ...(myVoices.length ? [{ group: 'マイボイス', options: myVoices.map((v) => ({ value: v.id, label: `🎤 ${v.name}` })) }] : []),
        { group: '標準の声', options: TTS_VOICES.map(([v, d]) => ({ value: v, label: `${v}（${d}）` })) },
      ];
      add(voiceBox, h('label', { class: 'field' }, 'ボイス', select(opts, st.voice, (v) => (st.voice = v))));
    }
  };
  renderVoice();

  // ---------------------------------------------------------------- 話し方・オプション
  const keepOut = h('span', {}, '0%');
  const keepRange = h('input', { type: 'range', min: 0, max: 0.5, step: 0.05, value: 0 });
  keepRange.addEventListener('input', () => { st.keepVolume = Number(keepRange.value); keepOut.textContent = `${Math.round(st.keepVolume * 100)}%`; });
  const usedClips = store.project.videoClips.filter((c) => c.itemId === item.id);

  const status = h('div', { class: 'small' });
  const resultBox = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'hint' }, '動画の一部分だけ、話している内容を新しいセリフに置き換えます。選んだ範囲の元の音声はミュートされ、新しいセリフの音声が重なります（口の動きは元のままです）。'),
    video,
    bar,
    h('div', { class: 'row wrap' },
      h('label', { class: 'inline' }, '開始', startIn), h('label', { class: 'inline' }, '終了', endIn),
      h('button', { class: 'btn sm', onclick: () => { st.start = video.currentTime; if (st.end <= st.start) st.end = Math.min(dur, st.start + 2); syncRange(); } }, '[ 再生位置を開始に'),
      h('button', { class: 'btn sm', onclick: () => { st.end = video.currentTime; if (st.end <= st.start) st.start = Math.max(0, st.end - 2); syncRange(); } }, '再生位置を終了に ]'),
      h('button', { class: 'btn sm', onclick: () => { video.currentTime = st.start; stopAt = st.end; video.play(); } }, '▶ 範囲を再生'),
      rangeLabel,
    ),
    h('div', { class: 'section-title' }, '① 新しいセリフ'),
    h('div', { class: 'row' }, sttBtn),
    origEl,
    scriptTa,
    note,
    h('div', { class: 'section-title' }, '② 声'),
    voiceBox,
    h('div', { class: 'section-title' }, '③ 話し方'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, '感情', select(EMOTIONS.map((e) => ({ value: e, label: e || 'なし（自然に）' })), st.emotion, (v) => (st.emotion = v))),
      h('label', { class: 'field' }, '話す速さ', select(Object.entries(SPEEDS).map(([value, label]) => ({ value, label })), st.speed, (v) => (st.speed = v))),
    ),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, '抑揚', select(Object.entries(INTONATIONS).map(([value, label]) => ({ value, label })), st.intonation, (v) => (st.intonation = v))),
      h('label', { class: 'field' }, '演技の指示（自由入力）', h('input', { value: st.style, placeholder: '例: 驚いたあとに笑うように', oninput: (e) => (st.style = e.target.value) })),
    ),
    h('div', { class: 'section-title' }, '④ 仕上げ'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.fit, onchange: (e) => (st.fit = e.target.checked) }), '読む速さを自動調整して、選んだ範囲の長さに合わせる'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.autoRewrite, onchange: (e) => (st.autoRewrite = e.target.checked) }), '長さが大きく合わないときは、AI が言い回しを少し変えてよい'),
    h('label', { class: 'field' }, '範囲内に元の音（BGM など）を残す音量', h('div', { class: 'slider-row' }, keepRange, keepOut)),
    usedClips.length
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (st.replaceClip = e.target.checked) }), `タイムラインでこの動画を使っている ${usedClips.length} 個のクリップを、差し替え版に置き換える`)
      : null,
    status,
    resultBox,
  );
  st.replaceClip = usedClips.length > 0;

  const runBtn = h('button', { class: 'btn primary' }, '🎙 差し替え版を作る');
  const m = modal({ title: `🎙 声の部分差し替え — ${item.name}`, body, wide: true, actions: [h('button', { class: 'btn', onclick: () => m.close() }, '閉じる'), runBtn] });
  syncRange();
  setTimeout(() => (video.currentTime = st.start), 300);

  runBtn.addEventListener('click', async () => {
    try {
      if (st.end - st.start < 0.3) throw new Error('差し替える範囲を選んでください（バーをドラッグ）');
      if (!st.script.trim()) throw new Error('新しいセリフを入力してください');
      runBtn.disabled = true;
      status.className = 'small';
      let voice = st.voice;
      let voiceName = voice;

      // 1) 声を用意する
      if (st.mode === 'copy' || st.mode === 'design') {
        const fd = new FormData();
        fd.append('sourceItemId', item.id);
        fd.append('start', String(st.start));
        fd.append('duration', String(st.end - st.start));
        fd.append('loopTo', String(st.loopTo));
        if (st.mode === 'copy') {
          if (!st.consent) throw new Error('本人の同意の録音がありません');
          status.textContent = '① この部分の声をコピーしています…';
          fd.append('consent', st.consent, st.consent.name || 'consent.webm');
          fd.append('name', `${item.name} の声`);
          fd.append('language', 'ja-JP');
          const r = await postForm('/api/voices/replicate', fd);
          voice = r.voice.id;
          voiceName = r.voice.name;
        } else {
          status.textContent = '① この部分の声の特徴を聞き取っています…';
          const d = await postForm('/api/voices/describe', fd);
          status.textContent = '① 似た声を作っています…';
          const r = await api.post('/api/voices/design', { name: `${item.name} に似た声`, description: d.description });
          voice = r.voice.id;
          voiceName = r.voice.name;
        }
        await loadVoices();
        // 次回はこの声をそのまま使う
        st.mode = 'existing';
        st.voice = voice;
        renderVoice();
      } else {
        voiceName = (store.voices || []).find((v) => v.id === voice)?.name || voice;
      }

      // 2) セリフを読み上げて、範囲だけ差し替えた動画を作る
      status.textContent = '② 新しいセリフを読み上げて、動画に合成しています…';
      const r = await api.post('/api/voice-edit/apply', {
        itemId: item.id,
        start: st.start,
        end: st.end,
        script: st.script,
        voice,
        voiceName,
        ttsModel: getNarrDraft().ttsModel || store.settings.ttsModel,
        textModel: store.settings.textModel,
        style: composeStyle(st),
        fit: st.fit,
        autoRewrite: st.autoRewrite,
        keepVolume: st.keepVolume,
      });
      await store.refreshLibrary();
      const newItem = store.itemsById[r.item.id] || r.item;
      if (st.replaceClip && usedClips.length) {
        store.mutate((p) => {
          for (const c of p.videoClips) if (c.itemId === item.id) c.itemId = newItem.id;
        });
      }
      status.className = 'small ok-text';
      status.textContent = `✅ 差し替え版を作りました（${voiceName} の声${Math.abs((r.tempo || 1) - 1) > 0.01 ? `・速さ ×${r.tempo.toFixed(2)}` : ''}）${st.replaceClip && usedClips.length ? '。タイムラインのクリップも置き換えました。' : ''}`;
      for (const w of r.warnings || []) toast(w, 'warn');
      clear(resultBox);
      add(resultBox,
        h('video', { src: newItem.url, controls: true, autoplay: true, class: 'preview-video', style: { maxHeight: '36vh' } }),
        h('div', { class: 'row wrap' },
          !(st.replaceClip && usedClips.length) ? h('button', { class: 'btn primary', onclick: () => { store.addVideoClip(newItem); toast('タイムラインに追加しました', 'ok'); } }, '＋ タイムラインに追加') : null,
          h('span', { class: 'tiny' }, '差し替え版はライブラリに保存されました（元の動画も残っています）。セリフや範囲を変えて、もう一度作ることもできます。'),
        ),
      );
    } catch (e) {
      status.className = 'err-text small';
      status.textContent = e.message;
    } finally {
      runBtn.disabled = false;
    }
  });
  return m;
}
