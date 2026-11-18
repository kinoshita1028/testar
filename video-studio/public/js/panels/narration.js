// 「ナレーション」パネル: 原稿作成（映像を解析）→ 音声合成 → 長さ合わせ → タイムラインに配置
import { api } from '../api.js';
import { store } from '../store.js';
import { h, clear, toast, select, segmented, lsGet, lsSet, debounce, add } from '../ui.js';
import { TTS_VOICES } from '../shared/capabilities.js';
import { openVoiceManager, openCopyVoice, openDesignVoice, previewVoice } from '../voices.js';
import { formatTime } from '../shared/timeline-core.js';

const LANGS = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

const STYLE_PRESETS = ['落ち着いたトーン', '明るく元気に', 'ニュース風にはっきりと', 'やさしく語りかけるように', 'ドキュメンタリー風', 'ワクワクする広告風'];

const defaults = {
  target: 'clip',
  customDuration: 10,
  script: '',
  language: 'ja',
  style: '',
  emotion: '',
  speed: '',
  intonation: '',
  instruction: '',
  analyze: true,
  ttsModel: '',
  voice: 'Kore',
  fit: true,
  autoRewrite: true,
  muteOriginal: true,
};

export const EMOTIONS = ['', '落ち着いて', '優しく', '明るく元気に', '嬉しそうに', '楽しげに', 'ワクワクした様子で', '真剣に', '力強く', '悲しげに', '寂しげに', '怒り気味に', '驚いたように', 'ささやくように'];
export const SPEEDS = { '': 'ふつう', ゆっくり話す: 'ゆっくり', 少しゆっくり話す: '少しゆっくり', 少し速めに話す: '少し速め', 速めに話す: '速め' };
export const INTONATIONS = { '': 'ふつう', 抑揚を抑えて淡々と: '控えめ（淡々と）', 抑揚を大きく表情豊かに: '豊か（表情豊かに）' };

/** 感情・速さ・抑揚・自由入力をまとめて、音声合成に渡す「話し方」の指示にする */
export function composeStyle(d) {
  return [d.emotion, d.speed, d.intonation, String(d.style || '').trim()].filter(Boolean).join('、');
}

/** 旧バージョンの「話し方」プリセットをそのまま使えるようにする */
function migrate(d) {
  if (d.style === '落ち着いたトーン' && d.emotion === undefined) return { ...d, style: '', emotion: '落ち着いて' };
  return d;
}

export function getNarrDraft() {
  return migrate({ ...defaults, ...lsGet('narrDraft', {}) });
}

function estimateSec(text, lang) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return lang === 'en' ? t.split(/\s+/).length / 2.6 : [...t.replace(/\s/g, '')].length / 6;
}

function voiceLabel(id) {
  const v = (store.voices || []).find((x) => x.id === id);
  return v ? v.name : id;
}

/** 複数クリップに一括でナレーションを付ける（ストーリーボードから） */
export async function narrateClips(targets) {
  const d = getNarrDraft();
  let ok = 0;
  for (const [i, t] of targets.entries()) {
    const seg = store.layout().video.find((v) => v.clip.id === t.clipId);
    if (!seg) continue;
    toast(`🎙 ナレーション生成中… (${i + 1}/${targets.length})`, 'info', 2500);
    try {
      const r = await api.post('/api/narration/generate', {
        script: t.script,
        targetDuration: seg.duration,
        voice: d.voice,
        voiceName: voiceLabel(d.voice),
        ttsModel: d.ttsModel || store.settings.ttsModel,
        textModel: store.settings.textModel,
        style: composeStyle(d),
        language: d.language,
        fit: d.fit ? 'stretch' : 'none',
        autoRewrite: d.autoRewrite,
      });
      store.upsertItems([r.item]);
      store.addNarration(r.item, { anchorClipId: seg.clip.id, muteClipIds: [seg.clip.id] });
      ok++;
    } catch (e) {
      toast(`ナレーション生成に失敗: ${e.message}`, 'err');
    }
  }
  if (ok) toast(`${ok} 個のナレーションを追加しました`, 'ok');
}

export class NarrationPanel {
  constructor(root) {
    this.root = root;
    this.d = getNarrDraft();
    this.save = debounce(() => lsSet('narrDraft', this.d), 300);
    this.result = null;
    store.on('selection', () => this.renderTarget());
    store.on('project', () => this.renderTarget());
    store.on('models', () => this.render());
    store.on('settings', () => this.render());
    store.on('voices', () => this.render());
    store.on('narr:voice', (id) => {
      this.set({ voice: id }, true);
      store.emit('ui:tab', 'narration');
    });
    store.on('narr:target', (clipId) => {
      this.d.target = 'clip';
      this.save();
      store.select({ type: 'video', id: clipId });
      this.render();
    });
    this.render();
  }

  set(patch, rerender = false) {
    Object.assign(this.d, patch);
    this.save();
    if (rerender) this.render();
  }

  /** 対象と目標の長さ */
  target() {
    const lay = store.layout();
    if (this.d.target === 'clip') {
      const sel = store.selection;
      const seg = sel?.type === 'video' ? lay.video.find((v) => v.clip.id === sel.id) : null;
      return seg ? { kind: 'clip', seg, duration: seg.duration } : { kind: 'clip', seg: null, duration: 0 };
    }
    if (this.d.target === 'timeline') return { kind: 'timeline', duration: lay.duration };
    return { kind: 'custom', duration: Number(this.d.customDuration) || 0 };
  }

  render() {
    const d = this.d;
    clear(this.root);
    add(this.root, 
      h('div', { class: 'hint' }, '動画の長さに合わせたナレーションを Gemini で作ります。原稿 → 音声合成 → 長さ調整 → タイムラインへの配置まで自動で行います。'),
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '① 対象'),
        segmented([{ value: 'clip', label: '選択中のクリップ' }, { value: 'timeline', label: 'タイムライン全体' }, { value: 'custom', label: '長さを指定' }], d.target, (v) => {
          this.set({ target: v });
          this.renderTarget();
        }),
        (this.targetBox = h('div')),
      ),
    );

    // 原稿
    const ta = h('textarea', { rows: 6, value: d.script, placeholder: '読み上げる原稿。空のまま「AIで原稿を作成」を押すと、映像を見て AI が書きます。' });
    ta.addEventListener('input', () => {
      this.set({ script: ta.value });
      this.updateEstimate();
    });
    this.scriptEl = ta;
    this.estimateEl = h('div', { class: 'tiny' });
    this.writeBtn = h('button', { class: 'btn', onclick: () => this.writeScript() }, '✨ AIで原稿を作成');
    add(this.root, 
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '② 原稿'),
        ta,
        this.estimateEl,
        h('div', { class: 'row wrap' }, this.writeBtn, (this.transcribeBtn = h('button', { class: 'btn', title: '対象のクリップで話している内容を文字にします。言葉だけ書き換えて、同じ声で読み直すときに使います', onclick: () => this.transcribe() }, '📝 元の音声を文字起こし')), (this.sceneBtnBox = h('span'))),
        h('div', { class: 'tiny' }, '原稿の中に <short pause>（短い間）・<breath>（息つぎ）などを書くと、その場所に間や息が入ります（Gemini 3.8 TTS）。'),
        h('details', { open: !d.script },
          h('summary', {}, '原稿作成の設定'),
          h('div', { class: 'stack' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.analyze, onchange: (e) => this.set({ analyze: e.target.checked }) }), '映像を AI に見せて内容に合った原稿にする'),
            h('label', { class: 'field' }, '伝えたい内容・追加の指示（任意）', h('input', { value: d.instruction, placeholder: '例: 新商品の特徴を3つ伝える / 子ども向けにやさしく', oninput: (e) => this.set({ instruction: e.target.value }) })),
            h('label', { class: 'field' }, '言語', select(LANGS, d.language, (v) => { this.set({ language: v }); this.updateEstimate(); })),
          ),
        ),
      ),
    );

    // 声
    const ttsModels = store.models.tts || [];
    const ttsCurrent = d.ttsModel || store.settings.ttsModel;
    const ttsOpts = ttsModels.map((m) => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} · ${m.id}` }));
    if (ttsCurrent && !ttsOpts.some((o) => o.value === ttsCurrent)) ttsOpts.unshift({ value: ttsCurrent, label: ttsCurrent });
    const myVoices = store.voices || [];
    const voiceIds = new Set([...myVoices.map((v) => v.id), ...TTS_VOICES.map(([v]) => v)]);
    if (!voiceIds.has(d.voice)) d.voice = 'Kore';
    const voiceOpts = [
      ...(myVoices.length ? [{ group: 'マイボイス（コピー・デザインした声）', options: myVoices.map((v) => ({ value: v.id, label: `🎤 ${v.name}（${v.type === 'replicated' ? 'コピー' : 'デザイン'}）` })) }] : []),
      { group: '標準の声', options: TTS_VOICES.map(([v, desc]) => ({ value: v, label: `${v}（${desc}）` })) },
    ];
    const isCustom = myVoices.some((v) => v.id === d.voice);
    const emotionSel = select(EMOTIONS.map((e) => ({ value: e, label: e || 'なし（自然に）' })), d.emotion, (v) => this.set({ emotion: v }));
    const speedSel = select(Object.entries(SPEEDS).map(([value, label]) => ({ value, label })), d.speed, (v) => this.set({ speed: v }));
    const intoSel = select(Object.entries(INTONATIONS).map(([value, label]) => ({ value, label })), d.intonation, (v) => this.set({ intonation: v }));
    const styleInput = h('input', { value: d.style, list: 'stylePresets', placeholder: '例: 語尾をやわらかく、親しみやすく / ニュースのように', oninput: (e) => this.set({ style: e.target.value }) });
    add(this.root,
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '③ 声と話し方'),
        h('label', { class: 'field' }, 'ボイス', select(voiceOpts, d.voice, (v) => this.set({ voice: v }, true))),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: () => previewVoice(this.d.voice, { style: composeStyle(this.d), model: this.d.ttsModel || store.settings.ttsModel }) }, '▶ 試聴'),
          h('button', { class: 'btn sm', onclick: () => openCopyVoice(this.target().seg?.item?.hasAudio ? this.target().seg.item.id : undefined) }, '🎤 声をコピー'),
          h('button', { class: 'btn sm', onclick: () => openDesignVoice() }, '🎨 声をデザイン'),
          h('button', { class: 'btn sm ghost', onclick: () => openVoiceManager() }, 'マイボイスの管理'),
        ),
        isCustom ? h('div', { class: 'tiny' }, 'マイボイスは Gemini 3.8 TTS 以降で読み上げます（古いモデルを選んでいても自動で切り替えます）。') : null,
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, '感情', emotionSel),
          h('label', { class: 'field' }, '話す速さ', speedSel),
        ),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, '抑揚', intoSel),
          h('label', { class: 'field' }, '音声合成モデル', select(ttsOpts, ttsCurrent, (v) => this.set({ ttsModel: v }))),
        ),
        h('label', { class: 'field' }, '演技の指示（自由入力）', styleInput, h('datalist', { id: 'stylePresets' }, STYLE_PRESETS.map((x) => h('option', { value: x })))),
        h('div', { class: 'tiny' }, '感情・速さ・抑揚・演技の指示は、まとめて「話し方」として音声合成に渡されます。原稿の文章は、そのまま読み上げられます。'),
      ),
    );

    // オプション
    this.genBtn = h('button', { class: 'btn primary big block', onclick: () => this.generate() }, '🎙 ナレーションを生成して追加');
    add(this.root, 
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '④ 長さ合わせと配置'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.fit, onchange: (e) => this.set({ fit: e.target.checked }) }), '読み上げ速度を自動調整して、ぴったり動画の長さに合わせる'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.autoRewrite, onchange: (e) => this.set({ autoRewrite: e.target.checked }) }), '長さが大きくずれたら、AI が原稿を書き直して再合成する'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.muteOriginal, onchange: (e) => this.set({ muteOriginal: e.target.checked }) }), '対象の動画の元の音声をミュートする'),
        this.genBtn,
        (this.progressEl = h('div', { class: 'hidden stack' }, h('div', { class: 'progress indeterminate' }, h('div')), h('div', { class: 'tiny' }, '音声を合成しています…'))),
        (this.resultBox = h('div')),
      ),
    );
    this.renderTarget();
    this.renderResult();
  }

  renderTarget() {
    if (!this.targetBox) return;
    const t = this.target();
    clear(this.targetBox);
    if (t.kind === 'clip') {
      if (!t.seg) {
        add(this.targetBox, h('div', { class: 'banner warn' }, '下のタイムラインで動画クリップをクリックして選択してください'));
      } else {
        const item = t.seg.item;
        add(this.targetBox, h('div', { class: 'card row' },
          h('div', { style: { width: '64px', height: '36px', borderRadius: '5px', background: `#000 center/cover url("${item?.thumbUrl || ''}")`, flex: 'none' } }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'small', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item?.name || ''), h('div', { class: 'tiny' }, `長さ ${t.duration.toFixed(1)} 秒（${formatTime(t.seg.start)} 〜）`)),
        ));
      }
    } else if (t.kind === 'timeline') {
      add(this.targetBox, h('div', { class: 'card small' }, `タイムライン全体: ${t.duration.toFixed(1)} 秒（${store.project.videoClips.length} クリップ）`));
    } else {
      add(this.targetBox, h('label', { class: 'field' }, '長さ（秒）・再生ヘッドの位置に配置', h('input', { type: 'number', min: 1, step: 0.5, value: this.d.customDuration, oninput: (e) => { this.set({ customDuration: Number(e.target.value) }); this.updateEstimate(); } })));
    }
    // ストーリーボードの原稿があれば使えるようにする
    if (this.sceneBtnBox) {
      clear(this.sceneBtnBox);
      const narr = t.kind === 'clip' && t.seg?.item?.meta?.narration;
      if (narr) this.sceneBtnBox.append(h('button', { class: 'btn sm ghost', onclick: () => { this.scriptEl.value = narr; this.set({ script: narr }); this.updateEstimate(); } }, '🗂 シーンの原稿を使う'));
    }
    this.updateEstimate();
  }

  updateEstimate() {
    if (!this.estimateEl) return;
    const t = this.target();
    const est = estimateSec(this.d.script, this.d.language);
    const n = this.d.language === 'en' ? `${String(this.d.script).trim().split(/\s+/).filter(Boolean).length} words` : `${[...String(this.d.script).replace(/\s/g, '')].length} 文字`;
    const diff = t.duration ? est / t.duration : 0;
    this.estimateEl.className = `tiny ${diff > 1.3 ? 'warn-text' : ''}`;
    this.estimateEl.textContent = this.d.script.trim() ? `${n} · 読み上げ目安 約 ${est.toFixed(1)} 秒${t.duration ? ` / 目標 ${t.duration.toFixed(1)} 秒${diff > 1.3 ? '（長め：速度調整か原稿の自動調整が入ります）' : ''}` : ''}` : t.duration ? `目標 ${t.duration.toFixed(1)} 秒 ≈ ${this.d.language === 'en' ? `${Math.round(t.duration * 2.6)} words` : `${Math.round(t.duration * 6)} 文字`}` : '';
  }

  async transcribe() {
    const t = this.target();
    if (t.kind !== 'clip' || !t.seg) return toast('タイムラインで、話している動画のクリップを選択してください', 'warn');
    if (!t.seg.item?.hasAudio) return toast('このクリップには音声がありません', 'warn');
    this.transcribeBtn.disabled = true;
    this.transcribeBtn.textContent = '文字起こし中…';
    try {
      const r = await api.post('/api/narration/transcribe', { itemId: t.seg.item.id, start: t.seg.clip.in, duration: t.duration, language: this.d.language, model: store.settings.textModel });
      this.scriptEl.value = r.text;
      this.set({ script: r.text });
      this.updateEstimate();
      toast('元の音声を文字にしました。言葉を書き換えてから「ナレーションを生成」を押してください。', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      this.transcribeBtn.disabled = false;
      this.transcribeBtn.textContent = '📝 元の音声を文字起こし';
    }
  }

  async writeScript() {
    const t = this.target();
    if (!t.duration) return toast(t.kind === 'clip' ? 'タイムラインで動画クリップを選択してください' : '長さが 0 秒です', 'warn');
    this.writeBtn.disabled = true;
    this.writeBtn.textContent = '作成中…';
    try {
      const r = await api.post('/api/narration/script', {
        target: t.kind,
        duration: t.duration,
        language: this.d.language,
        style: composeStyle(this.d),
        instruction: this.d.instruction,
        model: store.settings.textModel,
        analyze: this.d.analyze,
        clipItemId: t.seg?.item?.id,
        clipIn: t.seg?.clip.in,
        project: t.kind === 'timeline' ? store.project : undefined,
      });
      this.scriptEl.value = r.script;
      this.set({ script: r.script });
      this.updateEstimate();
      toast('原稿を作成しました。必要なら編集してから音声を生成してください。', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      this.writeBtn.disabled = false;
      this.writeBtn.textContent = '✨ AIで原稿を作成';
    }
  }

  async generate() {
    const t = this.target();
    if (!this.d.script.trim()) return toast('原稿が空です。入力するか「AIで原稿を作成」を押してください。', 'warn');
    if (t.kind === 'clip' && !t.seg) return toast('タイムラインで動画クリップを選択してください', 'warn');
    if (!t.duration) return toast('長さが 0 秒です', 'warn');
    this.genBtn.disabled = true;
    this.progressEl.classList.remove('hidden');
    try {
      const r = await api.post('/api/narration/generate', {
        script: this.d.script,
        targetDuration: t.duration,
        voice: this.d.voice,
        voiceName: voiceLabel(this.d.voice),
        ttsModel: this.d.ttsModel || store.settings.ttsModel,
        textModel: store.settings.textModel,
        style: composeStyle(this.d),
        language: this.d.language,
        fit: this.d.fit ? 'stretch' : 'none',
        autoRewrite: this.d.autoRewrite,
      });
      store.upsertItems([r.item]);
      if (t.kind === 'clip') {
        store.addNarration(r.item, { anchorClipId: t.seg.clip.id, muteClipIds: this.d.muteOriginal ? [t.seg.clip.id] : [] });
      } else if (t.kind === 'timeline') {
        store.addNarration(r.item, { start: 0, muteClipIds: this.d.muteOriginal ? store.project.videoClips.map((c) => c.id) : [] });
      } else {
        store.addNarration(r.item, { start: store.time });
      }
      if (r.script !== this.d.script) {
        this.scriptEl.value = r.script;
        this.set({ script: r.script });
      }
      this.result = r;
      this.renderResult();
      toast('ナレーションをタイムラインに追加しました', 'ok');
      for (const w of r.warnings || []) toast(w, 'warn');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      this.genBtn.disabled = false;
      this.progressEl.classList.add('hidden');
    }
  }

  renderResult() {
    if (!this.resultBox) return;
    clear(this.resultBox);
    const r = this.result;
    if (!r) return;
    const item = store.itemsById[r.item.id] || r.item;
    add(this.resultBox, 
      h('div', { class: 'card stack' },
        h('div', { class: 'small' }, '✅ 直前に作ったナレーション'),
        h('audio', { src: item.url, controls: true, style: { width: '100%' } }),
        h('div', { class: 'kv' },
          h('span', {}, '合成直後'), h('span', {}, `${r.rawDuration?.toFixed(2)} 秒`),
          h('span', {}, '調整後'), h('span', {}, `${r.finalDuration?.toFixed(2)} 秒${Math.abs(r.tempo - 1) > 0.01 ? `（速度 ×${r.tempo.toFixed(2)}）` : ''}`),
          h('span', {}, '原稿の自動調整'), h('span', {}, r.rewrites ? `${r.rewrites} 回` : 'なし'),
        ),
      ),
    );
  }
}
