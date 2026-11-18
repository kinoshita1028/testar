// マイボイス: 声のコピー（本人の同意が必要）・声のデザイン・保存した声の管理
import { api } from './api.js';
import { store } from './store.js';
import { h, add, clear, modal, toast, select, segmented, confirmDialog } from './ui.js';

export async function loadVoices() {
  try {
    const r = await api.get('/api/voices');
    store.voices = r.voices || [];
    store.consent = r.consent || {};
    store.emit('voices');
  } catch {
    store.voices = store.voices || [];
  }
}

export async function postForm(url, fd) {
  const res = await fetch(url, { method: 'POST', body: fd });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 空 */
  }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

const TYPE_LABEL = { replicated: 'コピーした声', prompted: 'デザインした声' };

// ------------------------------------------------------------------ 一覧
export function openVoiceManager() {
  const listBox = h('div', { class: 'stack' });
  const render = () => {
    clear(listBox);
    const voices = store.voices || [];
    if (!voices.length) {
      listBox.append(h('div', { class: 'empty-note' }, 'まだ声がありません。下のボタンから作成できます。'));
      return;
    }
    for (const v of voices) {
      const nameInput = h('input', { value: v.name, style: { flex: 1, minWidth: '120px' } });
      nameInput.addEventListener('change', async () => {
        try {
          await api.patch(`/api/voices/${encodeURIComponent(v.id)}`, { name: nameInput.value });
          await loadVoices();
        } catch (e) {
          toast(e.message, 'err');
        }
      });
      add(listBox,
        h('div', { class: 'card stack' },
          h('div', { class: 'row wrap' },
            h('span', { class: `badge ${v.type === 'replicated' ? 'narr' : 'ai'}` }, TYPE_LABEL[v.type] || v.type),
            nameInput,
            h('button', { class: 'btn sm', onclick: () => previewVoice(v.id) }, '▶ 試聴'),
            h('button', { class: 'btn sm primary', onclick: () => { store.emit('narr:voice', v.id); m.close(); toast(`ナレーションの声を「${v.name}」にしました`, 'ok'); } }, 'この声を使う'),
            h('button', {
              class: 'btn sm danger',
              onclick: async () => {
                if (!(await confirmDialog(`「${v.name}」を削除しますか？\nGoogle に保存されている声も削除され、元に戻せません。`, '削除', true))) return;
                try {
                  await api.del(`/api/voices/${encodeURIComponent(v.id)}`);
                  await loadVoices();
                  toast('削除しました', 'ok');
                } catch (e) {
                  toast(e.message, 'err');
                }
              },
            }, '🗑'),
          ),
          v.sampleUrl ? h('div', { class: 'row' }, h('span', { class: 'tiny' }, v.type === 'replicated' ? '元の声:' : 'サンプル:'), h('audio', { src: v.sampleUrl, controls: true, style: { height: '32px', flex: 1 } })) : null,
          v.description ? h('div', { class: 'tiny' }, `声の説明: ${v.description}`) : null,
          h('div', { class: 'tiny' }, `作成: ${new Date(v.createdAt).toLocaleString('ja-JP')}${v.expireTime ? ` ・ 期限: ${new Date(v.expireTime).toLocaleDateString('ja-JP')}（使うと延長）` : ''}${v.imported ? ' ・ Google から取り込み' : ''}`),
        ),
      );
    }
  };
  const off = store.on('voices', render);
  render();
  const m = modal({
    title: '🎤 マイボイス',
    wide: true,
    onClose: off,
    body: h('div', { class: 'stack' },
      h('div', { class: 'hint' }, '作った声は Google に保存され、ナレーションの「ボイス」から選べます。1 年間使わないと自動で削除されます（使うたびに期限が延びます）。'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => openCopyVoice() }, '＋ 声をコピーする（本人の声）'),
        h('button', { class: 'btn', onclick: () => openDesignVoice() }, '＋ 声をデザインする（説明・似た声）'),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn sm ghost',
          title: '別の PC で作った声など、Google に保存されている声を取り込みます',
          onclick: async () => {
            try {
              const r = await api.post('/api/voices/sync');
              store.voices = r.voices;
              store.emit('voices');
              toast('Google に保存されている声を取り込みました', 'ok');
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        }, '↻ Google と同期'),
      ),
      listBox,
    ),
  });
  return m;
}

// ------------------------------------------------------------------ 試聴
let previewAudio = null;
export async function previewVoice(voice, { style, model } = {}) {
  toast('試聴用の音声を作っています…', 'info', 2500);
  try {
    const r = await api.post('/api/tts/preview', { voice, style, model: model || store.settings.ttsModel });
    for (const w of r.warnings || []) toast(w, 'warn');
    previewAudio?.pause();
    previewAudio = new Audio(r.url);
    previewAudio.play().catch(() => {});
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ------------------------------------------------------------------ 元の声の選択（ファイル or ライブラリ）
function sourcePicker(st, onChange) {
  const box = h('div', { class: 'stack' });
  const audio = h('audio', { controls: true, style: { width: '100%' } });
  const render = () => {
    clear(box);
    const libItems = store.library.filter((i) => i.hasAudio && (i.kind === 'video' || i.kind === 'audio'));
    const fileInput = h('input', { type: 'file', accept: 'video/*,audio/*' });
    fileInput.addEventListener('change', () => {
      st.file = fileInput.files[0] || null;
      st.itemId = '';
      if (st.file) audio.src = URL.createObjectURL(st.file);
      onChange?.();
    });
    const libSel = select(
      [{ value: '', label: '— 動画・音声を選ぶ —' }, ...libItems.map((i) => ({ value: i.id, label: `${i.source === 'generated' ? '[AI生成] ' : i.source === 'narration' ? '[ナレーション] ' : ''}${i.name}（${(i.duration || 0).toFixed(0)}秒）` }))],
      st.itemId,
      (v) => {
        st.itemId = v;
        st.file = null;
        const it = store.itemsById[v];
        if (it) audio.src = it.url;
        onChange?.();
      },
      { style: { width: '100%' } },
    );
    const startInput = h('input', { type: 'number', min: 0, step: 0.5, value: st.start, oninput: (e) => (st.start = Number(e.target.value) || 0) });
    const durInput = h('input', { type: 'number', min: 5, max: 30, step: 1, value: st.duration, oninput: (e) => (st.duration = Number(e.target.value) || 20) });
    add(box,
      segmented([{ value: 'file', label: 'ファイルから' }, { value: 'library', label: 'ライブラリから（生成済み動画など）' }], st.mode, (v) => {
        st.mode = v;
        render();
        onChange?.();
      }),
      st.mode === 'file' ? fileInput : libSel,
      audio,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '使う部分の開始（秒）', startInput),
        h('label', { class: 'field' }, '長さ（秒・10〜30 がおすすめ）', durInput),
      ),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: () => { st.start = Math.floor(audio.currentTime * 10) / 10; startInput.value = st.start; } }, '⏱ いまの再生位置を開始にする'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.denoise, onchange: (e) => (st.denoise = e.target.checked) }), '雑音を軽くする'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.isolate, onchange: (e) => (st.isolate = e.target.checked) }), 'BGM・効果音を取り除いて声だけを使う（AI で分離）'),
      ),
      h('div', { class: 'tiny' }, '1 人だけが話していて、BGM や効果音が少ない部分を選ぶと、きれいにコピーできます。'),
    );
  };
  render();
  return box;
}

function appendSource(fd, st) {
  if (st.mode === 'file') {
    if (!st.file) throw new Error('元になる声のファイルを選んでください');
    fd.append('source', st.file, st.file.name);
  } else {
    if (!st.itemId) throw new Error('ライブラリから動画・音声を選んでください');
    fd.append('sourceItemId', st.itemId);
  }
  fd.append('start', String(st.start || 0));
  fd.append('duration', String(st.duration || 20));
  fd.append('denoise', st.denoise ? '1' : '0');
  if (st.isolate) fd.append('isolate', '1');
}

// ------------------------------------------------------------------ 同意の録音
export function consentRecorder(st) {
  const box = h('div', { class: 'stack' });
  const statements = store.consent || {};
  const textEl = h('div', { class: 'card', style: { fontSize: '15px', lineHeight: '1.7', background: 'var(--bg)' } });
  const audio = h('audio', { controls: true, style: { width: '100%', display: 'none' } });
  const status = h('span', { class: 'tiny' });
  const showText = () => (textEl.textContent = statements[st.consentLang]?.text || '');
  let rec = null;
  let stream = null;
  const recBtn = h('button', { class: 'btn primary' }, '🎙 録音開始');
  recBtn.addEventListener('click', async () => {
    if (rec && rec.state === 'recording') {
      rec.stop();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('マイクを使えませんでした。ブラウザのマイク許可を確認するか、録音ファイルを選んでください。', 'err');
      return;
    }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = rec.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      st.consent = new File([blob], `consent.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type });
      audio.src = URL.createObjectURL(blob);
      audio.style.display = '';
      recBtn.textContent = '🎙 録音し直す';
      status.textContent = '✔ 録音できました。再生して確認してください。';
    };
    rec.start();
    recBtn.textContent = '■ 録音を止める';
    status.textContent = '● 録音中… 上の文を読み上げたら止めてください';
  });
  const fileInput = h('input', { type: 'file', accept: 'audio/*,video/*' });
  fileInput.addEventListener('change', () => {
    st.consent = fileInput.files[0] || null;
    if (st.consent) {
      audio.src = URL.createObjectURL(st.consent);
      audio.style.display = '';
      status.textContent = '✔ ファイルを選びました';
    }
  });
  add(box,
    h('div', { class: 'hint' }, '声の持ち主本人が、次の文をそのまま読み上げて録音してください（Google の決まりで必須です）。'),
    h('label', { class: 'field' }, '同意文の言語', select(Object.entries(statements).map(([value, s]) => ({ value, label: s.label })), st.consentLang, (v) => { st.consentLang = v; showText(); })),
    textEl,
    h('div', { class: 'row wrap' }, recBtn, h('span', { class: 'tiny' }, 'または'), fileInput),
    status,
    audio,
  );
  showText();
  return box;
}

// ------------------------------------------------------------------ 声をコピー
export function openCopyVoice(prefillItemId) {
  const st = { mode: prefillItemId ? 'library' : 'file', file: null, itemId: prefillItemId || '', start: 0, duration: 20, denoise: false, consent: null, consentLang: 'en-US', language: 'ja-JP', name: '' };
  const aiWarn = h('div');
  const updateWarn = () => {
    clear(aiWarn);
    const it = st.mode === 'library' && store.itemsById[st.itemId];
    if (it && it.source === 'generated') {
      add(aiWarn, h('div', { class: 'banner warn' },
        h('div', {}, '⚠ AI が生成した動画の声は、本人の同意の録音ができないためコピーできません（Google の決まり）。代わりに「声をデザイン」で、この声に似た声を作れます。'),
        h('button', { class: 'btn sm', onclick: () => { m.close(); openDesignVoice({ itemId: st.itemId, start: st.start, duration: st.duration }); } }, '似た声を作る'),
      ));
    }
  };
  const status = h('div', { class: 'tiny' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'section-title' }, '① 元になる声'),
    sourcePicker(st, updateWarn),
    aiWarn,
    h('div', { class: 'section-title' }, '② 本人の同意の録音'),
    consentRecorder(st),
    h('div', { class: 'section-title' }, '③ 名前'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, '声の名前', h('input', { placeholder: '例: 自分の声 / 〇〇さんの声', oninput: (e) => (st.name = e.target.value) })),
      h('label', { class: 'field' }, '主に話す言語', select([{ value: 'ja-JP', label: '日本語' }, { value: 'en-US', label: '英語' }, { value: 'zh-CN', label: '中国語' }, { value: 'ko-KR', label: '韓国語' }], st.language, (v) => (st.language = v))),
    ),
    h('div', { class: 'hint' }, '自分の声、または声の持ち主から使う許可をもらった声だけをコピーしてください。EU・イギリス・スイス・インド・米国の一部の州では使えません。'),
    status,
  );
  const createBtn = h('button', { class: 'btn primary' }, '🎤 声を作成する');
  const m = modal({ title: '🎤 声をコピーする', body, wide: true, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), createBtn] });
  updateWarn();
  createBtn.addEventListener('click', async () => {
    try {
      if (!st.consent) throw new Error('本人の同意の録音がありません（② で録音するか、ファイルを選んでください）');
      const fd = new FormData();
      appendSource(fd, st);
      fd.append('consent', st.consent, st.consent.name || 'consent.webm');
      fd.append('name', st.name || '');
      fd.append('language', st.language);
      createBtn.disabled = true;
      status.textContent = '作成中…（数十秒かかることがあります）';
      const r = await postForm('/api/voices/replicate', fd);
      await loadVoices();
      store.emit('narr:voice', r.voice.id);
      toast(`声「${r.voice.name}」を作成しました。ナレーションの声に設定しました。`, 'ok');
      m.close();
    } catch (e) {
      status.textContent = '';
      status.className = 'err-text small';
      status.textContent = e.message;
    } finally {
      createBtn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ 声をデザイン
export function openDesignVoice(prefill = {}) {
  const st = { mode: prefill.itemId ? 'library' : 'file', file: null, itemId: prefill.itemId || '', start: prefill.start || 0, duration: prefill.duration || 20, denoise: false, name: '', description: '' };
  const desc = h('textarea', { rows: 4, placeholder: '例: 30代の落ち着いた男性の声。低めでやわらかく、ゆっくりはっきり話す。親しみやすい雰囲気。' });
  desc.addEventListener('input', () => (st.description = desc.value));
  const status = h('div', { class: 'tiny' });
  const descBtn = h('button', { class: 'btn' }, '✨ この声の特徴を AI に書き出してもらう');
  descBtn.addEventListener('click', async () => {
    try {
      const fd = new FormData();
      appendSource(fd, st);
      descBtn.disabled = true;
      status.textContent = '声の特徴を聞き取っています…';
      const r = await postForm('/api/voices/describe', fd);
      desc.value = r.description;
      st.description = r.description;
      status.textContent = '✔ 書き出しました。必要なら書き直してから「声を作る」を押してください。';
    } catch (e) {
      status.textContent = e.message;
    } finally {
      descBtn.disabled = false;
    }
  });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'hint' }, '文章で説明した声を AI が作ります。同意の録音は不要です。AI が生成した動画の声に似せたいときも、こちらを使います（完全に同じ声にはなりません）。'),
    h('details', { open: Boolean(prefill.itemId) },
      h('summary', {}, '似せたい声がある場合（動画・音声から特徴を書き出す）'),
      h('div', { class: 'stack' }, sourcePicker(st), descBtn),
    ),
    h('label', { class: 'field' }, '声の説明', desc),
    h('label', { class: 'field' }, '声の名前', h('input', { placeholder: '例: 落ち着いた男性ナレーター', oninput: (e) => (st.name = e.target.value) })),
    status,
  );
  const createBtn = h('button', { class: 'btn primary' }, '🎨 声を作る');
  const m = modal({ title: '🎨 声をデザインする', body, wide: true, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), createBtn] });
  createBtn.addEventListener('click', async () => {
    try {
      if (!st.description.trim()) throw new Error('声の説明を入力してください');
      createBtn.disabled = true;
      status.textContent = '作成中…';
      const r = await api.post('/api/voices/design', { name: st.name, description: st.description });
      await loadVoices();
      store.emit('narr:voice', r.voice.id);
      toast(`声「${r.voice.name}」を作成しました。ナレーションの声に設定しました。`, 'ok');
      m.close();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      createBtn.disabled = false;
    }
  });
}
