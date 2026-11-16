// ダイアログ: 素材プレビュー・設定・エクスポート
import { api } from './api.js';
import { store, missingCount } from './store.js';
import { h, modal, toast, select, segmented, fmtBytes, lsGet, lsSet } from './ui.js';
import { formatTime } from './shared/timeline-core.js';
import { outputSize } from './shared/capabilities.js';

// ------------------------------------------------------------------ 素材プレビュー
export function openPreview(item) {
  const media =
    item.kind === 'video'
      ? h('video', { src: item.url, controls: true, autoplay: true, playsinline: true, class: 'preview-video' })
      : item.kind === 'audio'
        ? h('div', { class: 'stack' }, item.waveUrl ? h('img', { src: item.waveUrl, style: { width: '100%', height: '90px', objectFit: 'fill', background: '#10151d', borderRadius: '8px' } }) : null, h('audio', { src: item.url, controls: true, autoplay: true, style: { width: '100%' } }))
        : h('img', { src: item.url, class: 'preview-video', style: { objectFit: 'contain' } });
  const meta = item.meta || {};
  const nameInput = h('input', { value: item.name, style: { width: '100%' } });
  nameInput.addEventListener('change', async () => {
    try {
      const r = await api.patch(`/api/library/${item.id}`, { name: nameInput.value });
      store.upsertItems([r.item]);
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  const rows = [
    ['種類', { video: '動画', audio: '音声', image: '画像' }[item.kind]],
    item.duration ? ['長さ', `${item.duration.toFixed(2)} 秒`] : null,
    item.width ? ['サイズ', `${item.width} × ${item.height}`] : null,
    ['ファイル', `${fmtBytes(item.size)}${item.hasAudio ? '（音声あり）' : item.kind === 'video' ? '（音声なし）' : ''}`],
    meta.model ? ['モデル', meta.model] : null,
    meta.resolution ? ['生成設定', `${meta.aspectRatio || ''} · ${meta.resolution || ''} · ${meta.duration || ''}秒`] : null,
    meta.voice ? ['ボイス', `${meta.voice}${meta.style ? ` / ${meta.style}` : ''}`] : null,
  ].filter(Boolean);
  const body = h('div', { class: 'stack' },
    media,
    h('label', { class: 'field' }, '名前', nameInput),
    h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)])),
    meta.prompt ? h('details', { open: true }, h('summary', {}, 'プロンプト'), h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, meta.prompt)) : null,
    meta.modelText ? h('details', {}, h('summary', {}, 'モデルからのテキスト応答'), h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap' } }, meta.modelText)) : null,
    meta.script ? h('details', { open: true }, h('summary', {}, 'ナレーション原稿'), h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, meta.script)) : null,
    meta.narration ? h('details', {}, h('summary', {}, 'シーンのナレーション原稿'), h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, meta.narration)) : null,
  );
  const m = modal({
    title: `${{ video: '🎞', audio: '🎵', image: '🖼' }[item.kind]} プレビュー`,
    body,
    wide: item.kind !== 'audio',
    actions: [
      h('button', { class: 'btn danger', onclick: async () => { const { deleteLibraryItem } = await import('./panels/library.js'); if (await deleteLibraryItem(item)) m.close(); } }, '🗑 削除'),
      h('a', { class: 'btn', href: item.url, download: `${item.name}${item.file.slice(item.file.lastIndexOf('.'))}` }, '⬇ ダウンロード'),
      h('button', { class: 'btn', onclick: () => { store.emit('gen:attach-item', item); m.close(); } }, '📎 生成の参考に添付'),
      meta.protocol === 'interactions' ? h('button', { class: 'btn', onclick: () => { store.emit('gen:edit', item); m.close(); } }, '✎ 指示で修正') : null,
      meta.protocol === 'veo' || meta.protocol === 'interactions' ? h('button', { class: 'btn', onclick: () => { store.emit('gen:extend', item); m.close(); } }, '⇥ 延長') : null,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const { addItemToTimeline } = await import('./panels/library.js');
          addItemToTimeline(item);
          m.close();
        },
      }, '＋ タイムラインに追加'),
    ].filter(Boolean),
  });
  return m;
}

// ------------------------------------------------------------------ 設定
export function openSettings() {
  const s = { ...store.settings };
  const st = store.status || {};
  const keyInput = h('input', { type: 'password', placeholder: s.hasApiKey ? `設定済み（${s.apiKeyPreview}）— 変更する場合のみ入力` : 'AIza... で始まるキー', autocomplete: 'off', style: { flex: 1 } });
  const modelSel = (list, value, key) => {
    const opts = (list || []).map((m) => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} · ${m.id}` }));
    if (value && !opts.some((o) => o.value === value)) opts.unshift({ value, label: value });
    return select(opts, value, (v) => (s[key] = v));
  };
  const num = (key, min, max) => h('input', { type: 'number', min, max, value: s[key], oninput: (e) => (s[key] = Number(e.target.value)) });
  const ff = st.ffmpeg || {};
  const body = h('div', { class: 'stack' },
    h('div', { class: 'section-title' }, 'Gemini API キー'),
    h('div', { class: 'row' }, keyInput, h('button', { class: 'btn sm', onclick: () => (keyInput.type = keyInput.type === 'password' ? 'text' : 'password') }, '表示')),
    h('div', { class: 'hint' }, 'キーは Google AI Studio（aistudio.google.com/apikey）で取得できます。このPCの data/settings.json に保存され、Google の API への送信にだけ使われます。.env の GEMINI_API_KEY でも設定できます。Veo / Omni の動画生成は有料プランが必要です。'),
    s.apiKeySource === 'settings' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => (s.clearApiKey = e.target.checked) }), '保存済みのキーを削除する') : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.demoMode, onchange: (e) => (s.demoMode = e.target.checked) }), 'デモモード（API を呼ばずにテスト用の動画・音声で動作確認する。料金はかかりません）'),
    h('div', { class: 'section-title' }, '既定のモデル'),
    h('label', { class: 'field' }, '動画生成', modelSel(store.models.video, s.videoModel, 'videoModel')),
    h('label', { class: 'field' }, 'テキスト（プロンプト作成・ナレーション原稿・資料の読み取り）', modelSel(store.models.text, s.textModel, 'textModel')),
    h('label', { class: 'field' }, '音声合成（ナレーション）', modelSel(store.models.tts, s.ttsModel, 'ttsModel')),
    h('div', { class: 'hint' }, '一覧にないモデルは「AI生成」タブのモデル選択で「モデルIDを直接入力」を選ぶと使えます。'),
    h('div', { class: 'section-title' }, '添付の上限（API の仕様変更に合わせて調整できます）'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'Omni: 画像の最大枚数', num('omniMaxImages', 1, 50)),
      h('label', { class: 'field' }, 'Omni: 動画の最大本数', num('omniMaxVideos', 0, 10)),
      h('label', { class: 'field' }, 'Veo: 参照画像の最大枚数', num('veoMaxReferenceImages', 0, 10)),
      h('label', { class: 'field' }, '生成のタイムアウト（分）', num('generationTimeoutMin', 1, 120)),
    ),
    h('div', { class: 'section-title' }, 'ffmpeg（書き出し・サムネイル）'),
    h('div', { class: `small ${ff.ok ? 'ok-text' : 'err-text'}` }, ff.ok ? `✔ ${ff.ffmpeg?.version?.split(' ').slice(0, 3).join(' ')}` : '✖ ffmpeg が見つかりません。npm install をやり直すか、ffmpeg をインストールしてください。'),
  );
  modal({
    title: '⚙ 設定',
    body,
    actions: [
      { label: 'キャンセル', onClick: (close) => close() },
      {
        label: '保存',
        class: 'primary',
        onClick: async (close) => {
          try {
            const patch = { ...s, apiKey: keyInput.value.trim() };
            const r = await api.put('/api/settings', patch);
            store.settings = r;
            store.status = await api.get('/api/status');
            store.models = await api.get('/api/models?refresh=1');
            store.emit('settings');
            store.emit('models');
            store.emit('status');
            toast('設定を保存しました', 'ok');
            if (store.models.error && r.hasApiKey && !r.demoMode) toast(store.models.error, 'warn');
            close();
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ エクスポート
export function openExport() {
  const lay = store.layout();
  if (!lay.video.length) {
    toast('タイムラインに動画クリップがありません', 'warn');
    return;
  }
  const o = { format: 'mp4', resolution: store.project.resolution || '1080p', fps: store.project.fps || 30, quality: 'standard', ...lsGet('exportOpts', {}) };
  const sizeEl = h('span');
  const updateSize = () => {
    const [w, hh] = outputSize(store.project.aspectRatio, o.resolution);
    sizeEl.textContent = o.format === 'gif' ? `幅 ${Math.min(w, 640)}px（GIF）` : `${w} × ${hh}`;
    lsSet('exportOpts', o);
  };
  const missing = missingCount();
  const status = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'kv' },
      h('span', {}, 'プロジェクト'), h('span', {}, store.project.name),
      h('span', {}, '長さ'), h('span', {}, formatTime(lay.duration)),
      h('span', {}, 'クリップ'), h('span', {}, `動画 ${lay.video.length} · 音声 ${lay.audio.length}`),
      h('span', {}, '出力サイズ'), sizeEl,
    ),
    h('label', { class: 'field' }, '形式', segmented([{ value: 'mp4', label: 'MP4' }, { value: 'mov', label: 'MOV' }, { value: 'webm', label: 'WebM' }, { value: 'gif', label: 'GIF' }], o.format, (v) => { o.format = v; updateSize(); })),
    h('label', { class: 'field' }, '解像度', segmented([{ value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }], o.resolution, (v) => { o.resolution = v; updateSize(); })),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'フレームレート', segmented([24, 30, 60].map((f) => ({ value: f, label: `${f}fps` })), o.fps, (v) => { o.fps = Number(v); updateSize(); })),
      h('label', { class: 'field' }, '画質', segmented([{ value: 'high', label: '高画質' }, { value: 'standard', label: '標準' }, { value: 'light', label: '軽量' }], o.quality, (v) => { o.quality = v; updateSize(); })),
    ),
    h('div', { class: 'hint' }, 'MP4 (H.264/AAC) はほぼすべての環境・SNS で再生できます。縦横比はプレビュー下の「比率」で変更できます（はみ出す部分は黒帯になります）。'),
    missing ? h('div', { class: 'banner warn' }, `⚠ 素材が見つからないクリップが ${missing} 個あります。削除してから書き出してください。`) : null,
    status,
  );
  updateSize();
  const startBtn = h('button', { class: 'btn primary', disabled: Boolean(missing) }, '⬇ 書き出す');
  const m = modal({ title: '⬇ エクスポート', body, actions: [h('button', { class: 'btn', onclick: () => m.close() }, '閉じる'), startBtn] });
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    const bar = h('div', { style: { width: '0%' } });
    const msg = h('div', { class: 'tiny' }, '開始しています…');
    status.replaceChildren(h('div', { class: 'progress' }, bar), msg);
    try {
      const { job } = await api.post('/api/export', { project: store.project, options: o });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const { job: j } = await api.get(`/api/jobs/${job.id}`);
        if (!j) throw new Error('ジョブが見つかりません');
        bar.style.width = `${Math.round((j.progress || 0) * 100)}%`;
        msg.textContent = j.message || '';
        if (j.status === 'done') {
          const preview = o.format === 'gif' ? h('img', { src: j.url, class: 'preview-video', style: { objectFit: 'contain' } }) : h('video', { src: j.url, controls: true, class: 'preview-video' });
          status.replaceChildren(
            h('div', { class: 'ok-text' }, `✅ 書き出し完了: ${j.file}（${fmtBytes(j.size)}・${j.width}×${j.height}・${formatTime(j.duration)}）`),
            preview,
            h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `${j.url}?download=1`, download: j.file }, '⬇ ファイルをダウンロード'), h('span', { class: 'tiny' }, 'ファイルは data/exports フォルダにも保存されています')),
          );
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
    } catch (e) {
      status.replaceChildren(h('div', { class: 'err-text small' }, `書き出しに失敗しました: ${e.message}`));
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = '⬇ もう一度書き出す';
    }
  });
}
