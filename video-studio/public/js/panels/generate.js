// 「AI生成」パネル: モデル選択・プロンプト・添付・生成結果
import { api } from '../api.js';
import { store } from '../store.js';
import { h, clear, toast, modal, select, segmented, fmtBytes, timeAgo, lsGet, lsSet, debounce, confirmDialog, add } from '../ui.js';
import { modelProfile, planAttachments, defaultRole, effectiveMaxDuration, IMAGE_ROLES, VIDEO_ROLES, protocolFor } from '../shared/capabilities.js';
import { openPreview } from '../dialogs.js';
import { narrateClips } from './narration.js';

const KIND_ICON = { image: '🖼', video: '🎞', audio: '🎵', text: '📄', docx: '📝', pptx: '📊', pdf: '📕', other: '📎' };
const KIND_LABEL = { image: '画像', video: '動画', audio: '音声', text: 'テキスト', docx: 'Word', pptx: 'PowerPoint', pdf: 'PDF', other: 'その他' };

const defaults = {
  model: '',
  protocol: 'auto',
  customModel: false,
  prompt: '',
  negativePrompt: '',
  aspectRatio: '16:9',
  resolution: '720p',
  duration: 8,
  count: 1,
  seed: '',
  personGeneration: 'default',
  extraParams: '',
  autoAssist: true,
  attachments: [],
  extendItemId: null,
  editItemId: null,
  storyboard: null,
};

export class GeneratePanel {
  constructor(root) {
    this.root = root;
    this.gen = { ...defaults, ...lsGet('genDraft', {}) };
    this.jobs = [];
    this.jobEls = new Map();
    this.saveDraft = debounce(() => lsSet('genDraft', this.gen), 300);
    store.on('models', () => this.render());
    store.on('settings', () => this.render());
    store.on('library', () => this.renderJobs(true));
    store.on('gen:attach-item', (item) => this.attachFromLibrary(item));
    store.on('gen:edit', (item) => this.setEdit(item));
    store.on('gen:extend', (item) => this.setExtend(item));
    this.render();
    this.loadJobs();
  }

  get profile() {
    return modelProfile(this.modelId(), store.settings, this.gen.protocol);
  }

  modelId() {
    return (this.gen.model || store.settings.videoModel || 'gemini-omni-1.2-flash').trim();
  }

  set(patch, rerender = true) {
    Object.assign(this.gen, patch);
    this.saveDraft();
    if (rerender) this.render();
  }

  // ------------------------------------------------------------------ 描画
  render() {
    const g = this.gen;
    const prof = this.profile;
    const scrollTop = this.root.scrollTop;
    clear(this.root);

    // モデル
    const models = store.models.video || [];
    const omni = models.filter((m) => protocolFor(m.id) === 'interactions');
    const veo = models.filter((m) => protocolFor(m.id) === 'veo');
    const current = this.modelId();
    const inList = models.some((m) => m.id === current);
    const opts = [
      ...(omni.length ? [{ group: 'Gemini Omni（Interactions API）', options: omni.map((m) => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label}  ·  ${m.id}` })) }] : []),
      ...(veo.length ? [{ group: 'Veo', options: veo.map((m) => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label}  ·  ${m.id}` })) }] : []),
      { group: 'その他', options: [...(!inList ? [{ value: current, label: current }] : []), { value: '__custom__', label: 'モデルIDを直接入力…' }] },
    ];
    const modelSel = select(opts, g.customModel ? '__custom__' : current, (v) => {
      if (v === '__custom__') this.set({ customModel: true });
      else this.set({ model: v, customModel: false, protocol: 'auto', ...this.fitParams(v) });
    });
    modelSel.style.flex = '1';
    const capability =
      prof.protocol === 'veo'
        ? `Veo: 最初/最後のフレーム${prof.maxReferenceImages ? `・参照画像 ${prof.maxReferenceImages} 枚` : ''}・長さ ${prof.durations.join('/')} 秒・延長（Veo生成動画）`
        : `Gemini Omni: 画像 最大 ${prof.maxImages} 枚・動画 ${prof.maxVideos} 本・テキスト資料を直接入力／生成結果を会話で修正／${prof.durationRange[0]}〜${prof.durationRange[1]} 秒（最初/最後のフレーム指定時は ${Math.min(prof.frameMaxDuration, prof.durationRange[1])} 秒まで）`;

    add(this.root, 
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '動画モデル'),
        h('div', { class: 'row' }, modelSel, h('button', { class: 'icon-btn', title: 'API からモデル一覧を再取得', onclick: () => this.refreshModels() }, '↻')),
        g.customModel
          ? h('div', { class: 'row' },
              h('input', { placeholder: '例: gemini-omni-1.2-flash', value: g.model, style: { flex: 1 }, onchange: (e) => this.set({ model: e.target.value.trim() }) }),
              select([{ value: 'auto', label: '方式: 自動' }, { value: 'interactions', label: 'Interactions (Omni)' }, { value: 'veo', label: 'Veo (LRO)' }], g.protocol, (v) => this.set({ protocol: v })),
            )
          : null,
        h('div', { class: 'hint' }, capability),
        store.models.error && !store.status?.demo && !store.settings.demoMode ? h('div', { class: 'hint warn-text' }, store.models.error) : null,
      ),
    );

    // 延長・修正モード
    const ext = g.extendItemId && store.itemsById[g.extendItemId];
    const edit = g.editItemId && store.itemsById[g.editItemId];
    if (ext) add(this.root, h('div', { class: 'banner' }, `⇥ 延長元: ${ext.name}`, h('button', { class: 'icon-btn x', onclick: () => this.set({ extendItemId: null }) }, '✕')));
    if (edit) add(this.root, h('div', { class: 'banner' }, `✎ 修正元: ${edit.name}（下に修正内容を書いてください）`, h('button', { class: 'icon-btn x', onclick: () => this.set({ editItemId: null }) }, '✕')));

    // プロンプト
    const ta = h('textarea', {
      placeholder: edit ? '例: 空を夕焼けに変えて、カメラをゆっくり引いて' : ext ? '例: そのまま海へ歩いていく（空欄でも可）' : '作りたい動画を書いてください。例: 雨上がりの東京の路地を、赤い傘をさした猫がゆっくり歩く。シネマティック、浅い被写界深度',
      value: g.prompt,
    });
    ta.addEventListener('input', () => this.set({ prompt: ta.value }, false));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.generate();
    });
    this.promptEl = ta;
    add(this.root, 
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, edit ? '修正の指示' : 'プロンプト'),
        h('div', { class: 'prompt-box' }, ta,
          h('div', { class: 'prompt-actions' },
            h('button', { class: 'btn sm', title: '指示と添付資料から AI が動画用プロンプトを書きます', onclick: () => this.openAssist('single') }, '✨ AIでプロンプト作成'),
            h('button', { class: 'btn sm', title: '資料から複数シーンの構成を作ります', onclick: () => this.openAssist('storyboard') }, '🗂 ストーリーボード'),
            h('div', { class: 'spacer' }),
            h('span', { class: 'tiny' }, 'Ctrl+Enter で生成'),
          ),
        ),
      ),
    );

    // 添付
    add(this.root, this.renderAttachments(prof));

    // 設定（長さはモデルごとの上限まで選べる）
    const maxDur = effectiveMaxDuration(prof, g.attachments);
    if (prof.durationRange && (g.duration > maxDur || g.duration < prof.durationRange[0])) {
      g.duration = Math.max(prof.durationRange[0], Math.min(maxDur, g.duration));
      this.saveDraft();
    }
    const durCtl = prof.durations
      ? segmented(prof.durations.map((d) => ({ value: d, label: `${d}秒` })), g.duration, (v) => this.set({ duration: Number(v) }, false))
      : (() => {
          const out = h('span', { class: 'small', style: { width: '40px', textAlign: 'right' } }, `${g.duration}秒`);
          const r = h('input', { type: 'range', min: prof.durationRange[0], max: maxDur, step: 1, value: g.duration });
          r.addEventListener('input', () => {
            out.textContent = `${r.value}秒`;
            this.set({ duration: Number(r.value) }, false);
          });
          return h('div', { class: 'stack' },
            h('div', { class: 'row' }, r, out),
            h('div', { class: 'tiny' }, maxDur < prof.durationRange[1]
              ? `最初/最後のフレームを指定しているため最大 ${maxDur} 秒です（指定しなければ ${prof.durationRange[1]} 秒まで）`
              : `このモデルは 1 回で ${prof.durationRange[0]}〜${maxDur} 秒。もっと長くしたいときは生成後に「⇥ 延長」で続きを作れます`),
          );
        })();
    add(this.root, 
      h('div', { class: 'stack' },
        h('div', { class: 'section-title' }, '出力設定'),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, 'アスペクト比', segmented(prof.aspectRatios.map((a) => ({ value: a, label: a === '16:9' ? '16:9 横' : '9:16 縦' })), g.aspectRatio, (v) => this.set({ aspectRatio: v }, false))),
          h('label', { class: 'field' }, '生成本数', segmented([1, 2, 3, 4].map((n) => ({ value: n, label: `${n}` })), g.count, (v) => this.set({ count: Number(v) }, false))),
        ),
        h('label', { class: 'field' }, '長さ', durCtl),
        h('label', { class: 'field' }, '解像度', segmented(prof.resolutions.map((r) => ({ value: r, label: r === '4k' ? '4K' : r })), g.resolution, (v) => this.set({ resolution: v }, false))),
        h('details', {},
          h('summary', {}, '詳細設定'),
          h('div', { class: 'stack' },
            prof.supportsNegativePrompt ? h('label', { class: 'field' }, 'ネガティブプロンプト（避けたい要素）', h('input', { value: g.negativePrompt, placeholder: '例: ぼやけ, 文字, 低画質', oninput: (e) => this.set({ negativePrompt: e.target.value }, false) })) : null,
            h('div', { class: 'grid2' },
              h('label', { class: 'field' }, 'シード（任意）', h('input', { type: 'number', value: g.seed, placeholder: 'ランダム', oninput: (e) => this.set({ seed: e.target.value }, false) })),
              prof.supportsPersonGeneration
                ? h('label', { class: 'field' }, '人物の生成', select([{ value: 'default', label: '既定' }, { value: 'allow_all', label: 'すべて許可' }, { value: 'allow_adult', label: '成人のみ' }, { value: 'dont_allow', label: '人物なし' }], g.personGeneration, (v) => this.set({ personGeneration: v }, false)))
                : h('span'),
            ),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g.autoAssist, onchange: (e) => this.set({ autoAssist: e.target.checked }) }), 'モデルに直接渡せない添付（PDF・音声・文書など）は、AI が内容を読み取ってプロンプトに反映する'),
            h('label', { class: 'field' }, '追加パラメータ（JSON・上級者向け）',
              h('textarea', { rows: 2, value: g.extraParams, placeholder: prof.protocol === 'veo' ? '{"enhancePrompt": true}' : '{"generation_config": {"seed": 1}}', oninput: (e) => this.set({ extraParams: e.target.value }, false), style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } }),
              h('span', { class: 'tiny' }, prof.protocol === 'veo' ? 'Veo の config にそのまま追加されます' : 'Interactions API のリクエスト本文にそのまま追加されます'),
            ),
          ),
        ),
      ),
    );

    // 生成ボタン
    this.genBtn = h('button', { class: 'btn primary big block', onclick: () => this.generate() }, edit ? '✎ 修正版を生成' : ext ? '⇥ 延長を生成' : '🎬 動画を生成');
    add(this.root, this.genBtn);

    // ストーリーボード
    if (g.storyboard) add(this.root, this.renderStoryboard());

    // 生成結果
    this.jobsBox = h('div', { class: 'stack' });
    add(this.root, 
      h('div', { class: 'section-title' }, '生成結果', h('div', { class: 'spacer' }), this.jobs.length ? h('button', { class: 'btn sm ghost', onclick: () => this.clearFinished() }, '完了分を一覧から消す') : null),
      this.jobsBox,
    );
    this.jobEls.clear();
    this.renderJobs(true);
    this.root.scrollTop = scrollTop;
  }

  fitParams(modelId) {
    const p = modelProfile(modelId, store.settings, 'auto');
    const out = {};
    if (!p.resolutions.includes(this.gen.resolution)) out.resolution = p.resolutions.includes('720p') ? '720p' : p.resolutions[0];
    if (p.durations && !p.durations.includes(Number(this.gen.duration))) out.duration = p.defaultDuration;
    if (p.durationRange) out.duration = Math.max(p.durationRange[0], Math.min(p.durationRange[1], Number(this.gen.duration) || p.defaultDuration));
    if (!p.aspectRatios.includes(this.gen.aspectRatio)) out.aspectRatio = '16:9';
    return out;
  }

  async refreshModels() {
    try {
      store.models = await api.get('/api/models?refresh=1');
      store.emit('models');
      toast(store.models.error ? store.models.error : `モデル一覧を更新しました（動画 ${store.models.video.length} 件）`, store.models.error ? 'warn' : 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ------------------------------------------------------------------ 添付
  renderAttachments(prof) {
    const g = this.gen;
    const { plan, errors, warnings } = planAttachments(prof, g.attachments);
    const input = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: (e) => this.upload([...e.target.files]) });
    const dz = h('div', { class: 'dropzone', onclick: () => input.click() },
      '📎 ファイルを追加（クリック / ドラッグ＆ドロップ）',
      h('div', { class: 'tiny' }, '画像・動画・音声・テキスト・PDF・Word・PowerPoint など'),
    );
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('over');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      const libId = e.dataTransfer.getData('text/x-item-id');
      if (libId && store.itemsById[libId]) return this.attachFromLibrary(store.itemsById[libId]);
      if (e.dataTransfer.files.length) this.upload([...e.dataTransfer.files]);
    });
    this.dropzone = dz;

    const imgCount = g.attachments.filter((a) => a.kind === 'image' && plan[a.id]?.usage === 'direct').length;
    const list = h('div', { class: 'att-list' });
    for (const a of g.attachments) {
      const p = plan[a.id] || { usage: 'assist', note: '' };
      const roleSel =
        a.kind === 'image'
          ? select(Object.entries(IMAGE_ROLES).map(([value, label]) => ({ value, label })), a.role || defaultRole(a.kind), (v) => this.updateAttachment(a.id, { role: v }))
          : a.kind === 'video'
            ? select(Object.entries(VIDEO_ROLES).map(([value, label]) => ({ value, label })), a.role || defaultRole(a.kind), (v) => this.updateAttachment(a.id, { role: v }))
            : null;
      list.append(
        h('div', { class: 'att' },
          h('div', { class: 'thumb', style: a.thumbUrl ? { backgroundImage: `url("${a.thumbUrl}")` } : {} }, a.thumbUrl ? '' : KIND_ICON[a.kind] || '📎'),
          h('div', { style: { minWidth: 0 } },
            h('div', { class: 'name', title: a.name }, a.name),
            h('div', { class: 'meta' },
              h('span', { class: 'tiny' }, `${KIND_LABEL[a.kind] || a.kind}${a.duration ? ` · ${a.duration.toFixed(1)}秒` : ''}${a.size ? ` · ${fmtBytes(a.size)}` : ''}`),
              h('span', { class: `badge ${p.usage}`, title: p.note }, p.usage === 'direct' ? '直接入力' : 'AI補助'),
            ),
            h('div', { class: 'meta' }, roleSel, h('span', { class: 'tiny' }, p.note)),
            ['image', 'video'].includes(a.kind) && p.usage === 'direct'
              ? h('input', { placeholder: 'メモ（例: 主人公の顔、この服を着せる）', value: a.note || '', style: { marginTop: '4px', width: '100%', fontSize: '11.5px', padding: '3px 7px' }, onchange: (e) => this.updateAttachment(a.id, { note: e.target.value }, false) })
              : null,
          ),
          h('button', { class: 'icon-btn', title: '外す', onclick: () => this.removeAttachment(a.id) }, '✕'),
        ),
      );
    }
    return h('div', { class: 'stack' },
      h('div', { class: 'section-title' }, '添付ファイル', h('span', { class: 'tiny' }, `${g.attachments.length} 件${prof.maxImages ? ` · 画像（直接）${imgCount}/${prof.maxImages}` : ''}`), h('div', { class: 'spacer' }), g.attachments.length ? h('button', { class: 'btn sm ghost', onclick: () => this.clearAttachments() }, 'すべて外す') : null),
      dz, input,
      this.uploadProgress = h('div', { class: 'progress hidden' }, h('div', { style: { width: '0%' } })),
      list,
      ...errors.map((e) => h('div', { class: 'banner warn' }, `⚠ ${e}`)),
      ...warnings.map((w) => h('div', { class: 'hint warn-text' }, w)),
    );
  }

  async upload(files) {
    if (!files.length) return;
    const bar = this.uploadProgress;
    bar.classList.remove('hidden');
    try {
      const r = await api.upload('/api/attachments', files, (p) => (bar.firstChild.style.width = `${Math.round(p * 100)}%`));
      const added = r.attachments.map((a) => ({ ...a, role: defaultRole(a.kind) }));
      this.set({ attachments: [...this.gen.attachments, ...added] });
      toast(`${added.length} 件のファイルを添付しました`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
      bar.classList.add('hidden');
    }
  }

  async attachFromLibrary(item) {
    try {
      const r = await api.post(`/api/attachments/from-library/${item.id}`);
      this.set({ attachments: [...this.gen.attachments, { ...r.attachment, role: defaultRole(r.attachment.kind) }] });
      store.emit('ui:tab', 'generate');
      toast(`「${item.name}」を添付しました`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  updateAttachment(id, patch, rerender = true) {
    this.set({ attachments: this.gen.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }, rerender);
  }

  removeAttachment(id) {
    api.del(`/api/attachments/${id}`).catch(() => {});
    this.set({ attachments: this.gen.attachments.filter((a) => a.id !== id) });
  }

  clearAttachments() {
    for (const a of this.gen.attachments) api.del(`/api/attachments/${a.id}`).catch(() => {});
    this.set({ attachments: [] });
  }

  setEdit(item) {
    const model = item.meta?.protocol === 'interactions' ? item.meta.model : null;
    this.set({ editItemId: item.id, extendItemId: null, prompt: '', ...(model && protocolFor(this.modelId(), this.gen.protocol) !== 'interactions' ? { model, customModel: false, protocol: 'auto' } : {}) });
    store.emit('ui:tab', 'generate');
    this.root.scrollTop = 0;
    this.promptEl?.focus();
  }

  setExtend(item) {
    const isVeo = item.meta?.protocol === 'veo';
    const patch = { extendItemId: item.id, editItemId: null, prompt: '' };
    if (isVeo && protocolFor(this.modelId(), this.gen.protocol) !== 'veo') Object.assign(patch, { model: item.meta.model, customModel: false, protocol: 'auto' });
    if (!isVeo && protocolFor(this.modelId(), this.gen.protocol) === 'veo') {
      const omni = (store.models.video || []).find((m) => protocolFor(m.id) === 'interactions');
      if (omni) Object.assign(patch, { model: omni.id, customModel: false, protocol: 'auto' });
    }
    this.set(patch);
    store.emit('ui:tab', 'generate');
    this.root.scrollTop = 0;
    this.promptEl?.focus();
  }

  // ------------------------------------------------------------------ 生成
  buildRequest(over = {}) {
    const g = this.gen;
    return {
      model: this.modelId(),
      protocol: g.protocol,
      prompt: g.prompt,
      negativePrompt: g.negativePrompt,
      aspectRatio: g.aspectRatio,
      resolution: g.resolution,
      duration: g.duration,
      count: g.count,
      seed: g.seed,
      personGeneration: g.personGeneration,
      extraParams: g.extraParams.trim() || undefined,
      autoAssist: g.autoAssist,
      textModel: store.settings.textModel,
      attachments: g.attachments.map((a) => ({ id: a.id, role: a.role || defaultRole(a.kind), note: a.note })),
      extendItemId: g.extendItemId,
      editItemId: g.editItemId,
      ...over,
    };
  }

  async generate(over = {}) {
    if (!store.status?.settings?.hasApiKey && !store.status?.demo) {
      toast('Gemini API キーが未設定です。右上の「設定」から入力してください。', 'err');
      store.emit('ui:settings');
      return null;
    }
    const req = this.buildRequest(over);
    if (!String(req.prompt || '').trim() && !req.attachments.length && !req.extendItemId) {
      toast('プロンプトを入力してください', 'warn');
      this.promptEl?.focus();
      return null;
    }
    this.genBtn.disabled = true;
    try {
      const r = await api.post('/api/generate', req);
      this.jobs.unshift(r.job);
      if (!over.sceneTitle && (this.gen.editItemId || this.gen.extendItemId)) this.set({ editItemId: null, extendItemId: null });
      else this.renderJobs();
      this.pollSoon();
      toast('生成を開始しました。完了まで数十秒〜数分かかります。', 'ok');
      return r.job;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    } finally {
      this.genBtn.disabled = false;
    }
  }

  async retryJob(j, count) {
    try {
      const r = await api.post(`/api/jobs/${j.id}/retry`, count ? { count } : {});
      this.jobs.unshift(r.job);
      this.renderJobs();
      this.pollSoon();
      toast('もう一度生成しています…', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async loadJobs() {
    try {
      const r = await api.get('/api/jobs?type=generate');
      this.jobs = r.jobs;
      this.renderJobs();
      if (this.jobs.some((j) => j.status === 'running' || j.status === 'queued')) this.pollSoon();
    } catch {
      /* 起動直後 */
    }
  }

  pollSoon() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), 2000);
  }

  async poll() {
    try {
      const r = await api.get('/api/jobs?type=generate');
      const before = new Map(this.jobs.map((j) => [j.id, j.status]));
      this.jobs = r.jobs;
      let newItems = false;
      for (const j of this.jobs) {
        if (before.get(j.id) && before.get(j.id) !== j.status) {
          if (j.status === 'done') {
            newItems = true;
            toast(`✅ 動画ができました（${j.items?.length || 0} 本）${j.params?.sceneTitle ? `: ${j.params.sceneTitle}` : ''}`, 'ok');
          } else if (j.status === 'error') toast(`生成に失敗しました。詳しくは「生成結果」の欄を見てください。`, 'err');
        }
      }
      if (newItems) await store.refreshLibrary();
      this.renderJobs();
      if (this.gen.storyboard) this.updateStoryboardStatus();
    } catch {
      /* 一時的なエラー */
    }
    if (this.jobs.some((j) => j.status === 'running' || j.status === 'queued')) this.pollSoon();
  }

  async clearFinished() {
    for (const j of this.jobs.filter((x) => x.status === 'done' || x.status === 'error')) await api.del(`/api/jobs/${j.id}`).catch(() => {});
    this.jobs = this.jobs.filter((x) => x.status !== 'done' && x.status !== 'error');
    this.render();
  }

  renderJobs(force = false) {
    if (!this.jobsBox) return;
    if (!this.jobs.length) {
      clear(this.jobsBox).append(h('div', { class: 'empty-note' }, 'まだ生成していません。プロンプトを書いて「動画を生成」を押してください。'));
      this.jobEls.clear();
      return;
    }
    const wanted = [];
    for (const j of this.jobs.slice(0, 40)) {
      const sig = `${j.status}|${j.message}|${(j.items || []).map((i) => (store.itemsById[i.id] ? i.id : 'x')).join(',')}|${j.warnings?.length}`;
      let entry = this.jobEls.get(j.id);
      if (!entry || entry.sig !== sig || force) {
        const el = this.jobCard(j);
        entry?.el.replaceWith(el);
        entry = { sig, el };
        this.jobEls.set(j.id, entry);
      }
      wanted.push(entry.el);
    }
    const ids = new Set(this.jobs.slice(0, 40).map((j) => j.id));
    for (const id of [...this.jobEls.keys()]) if (!ids.has(id)) this.jobEls.delete(id);
    clear(this.jobsBox).append(...wanted);
  }

  jobCard(j) {
    const running = j.status === 'running' || j.status === 'queued';
    const elapsed = j.startedAt ? Math.round(((j.finishedAt ? new Date(j.finishedAt) : new Date()) - new Date(j.startedAt)) / 1000) : 0;
    const modeLabel = { extend: '延長', edit: '修正', generate: '生成' }[j.params?.mode] || '生成';
    const card = h('div', { class: 'job' },
      h('div', { class: 'job-head' },
        running ? h('span', { class: 'spinner' }) : h('span', {}, j.status === 'done' ? '✅' : '⚠️'),
        h('span', { class: 'badge ai' }, `${j.family || ''} ${modeLabel}`),
        h('span', { title: j.model }, j.model),
        h('div', { class: 'spacer' }),
        h('span', { class: 'tiny' }, running ? `${elapsed}秒` : timeAgo(j.createdAt)),
        running ? null : h('button', { class: 'icon-btn', title: '一覧から消す（ライブラリの動画は残ります）', style: { width: '22px', height: '22px' }, onclick: async () => {
          await api.del(`/api/jobs/${j.id}`).catch(() => {});
          this.jobs = this.jobs.filter((x) => x.id !== j.id);
          this.renderJobs();
        } }, '✕'),
      ),
      j.params?.sceneTitle ? h('div', { class: 'small', style: { fontWeight: 600 } }, `🗂 ${j.params.sceneTitle}`) : null,
      h('div', { class: 'job-prompt', title: j.prompt }, j.prompt || (j.params?.attachmentNames?.length ? `（添付: ${j.params.attachmentNames.join(', ')}）` : '（プロンプトなし）')),
      j.finalPrompt && j.finalPrompt !== j.prompt ? h('details', {}, h('summary', {}, 'AI が添付資料を反映したプロンプト'), h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap' } }, j.finalPrompt)) : null,
      running ? h('div', { class: 'stack' }, h('div', { class: 'progress indeterminate' }, h('div')), h('div', { class: 'tiny' }, j.message || '処理中…')) : null,
      j.status === 'error'
        ? h('div', { class: 'stack' },
            h('div', { class: 'err-text small' }, j.error),
            h('div', { class: 'row wrap' },
              j.request ? h('button', { class: 'btn sm primary', title: '同じ内容・同じ添付でもう一度生成します', onclick: () => this.retryJob(j) }, '↻ もう一度生成') : null,
              h('button', { class: 'btn sm', onclick: () => { this.set({ prompt: j.prompt }); this.promptEl?.focus(); } }, 'プロンプトを再利用'),
            ),
          )
        : null,
      ...[...new Set(j.warnings || [])].map((w) => h('div', { class: 'tiny warn-text', style: { whiteSpace: 'pre-wrap' } }, `⚠ ${w}`)),
      j.status === 'done' && j.failedCount && j.request
        ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => this.retryJob(j, j.failedCount) }, `↻ 失敗した ${j.failedCount} 本を作り直す`))
        : null,
      j.errorDetail ? h('details', {}, h('summary', {}, '詳細（API の応答）'), h('pre', { class: 'tiny', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto', margin: 0 } }, j.errorDetail)) : null,
    );
    if (j.status === 'done') {
      const grid = h('div', { class: 'job-results' });
      for (const it of j.items || []) {
        const item = store.itemsById[it.id];
        grid.append(item ? this.resultCard(item) : h('div', { class: 'result' }, h('div', { class: 'ph', style: { display: 'grid', placeItems: 'center', color: 'var(--text3)', cursor: 'default' } }, '削除済み')));
      }
      add(card, grid);
    }
    return card;
  }

  resultCard(item) {
    const portrait = item.height > item.width;
    const v = h('video', { src: item.url, poster: item.thumbUrl || undefined, muted: true, loop: true, playsinline: true, preload: 'metadata', title: 'クリックで大きくプレビュー' });
    v.addEventListener('mouseenter', () => v.play().catch(() => {}));
    v.addEventListener('mouseleave', () => v.pause());
    v.addEventListener('click', () => openPreview(item));
    v.draggable = true;
    v.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-item-id', item.id));
    const isOmni = item.meta?.protocol === 'interactions';
    const isVeo = item.meta?.protocol === 'veo';
    return h('div', { class: `result ${portrait ? 'portrait' : ''}` }, v,
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary', title: '編集タイムラインの最後に追加', onclick: () => { store.addVideoClip(item); toast(`「${item.name}」をタイムラインに追加しました`, 'ok'); } }, '＋ 追加'),
        h('button', { class: 'btn', onclick: () => openPreview(item) }, '▶ 見る'),
        isOmni ? h('button', { class: 'btn', title: 'この動画を指示で修正（Omni）', onclick: () => this.setEdit(item) }, '✎ 修正') : null,
        isVeo || isOmni ? h('button', { class: 'btn', title: 'この動画の続きを生成', onclick: () => this.setExtend(item) }, '⇥ 延長') : null,
      ),
    );
  }

  // ------------------------------------------------------------------ プロンプト作成支援
  openAssist(mode) {
    const g = this.gen;
    const st = { mode, sceneCount: 4, promptLanguage: lsGet('assistLang', 'en'), withNarration: true, narrationLanguage: 'ja' };
    const body = h('div', { class: 'stack' },
      h('div', { class: 'hint' }, `いまのプロンプト欄の内容（${g.prompt.trim() ? `${g.prompt.trim().length} 文字` : '空'}）と添付ファイル ${g.attachments.length} 件を AI（${store.settings.textModel}）が読み取り、動画用のプロンプトを作ります。`),
      h('label', { class: 'field' }, '作るもの', segmented([{ value: 'single', label: '1本の動画' }, { value: 'storyboard', label: 'ストーリーボード（複数シーン）' }], st.mode, (v) => { st.mode = v; sbOpts.classList.toggle('hidden', v !== 'storyboard'); })),
      h('label', { class: 'field' }, 'プロンプトの言語', segmented([{ value: 'en', label: '英語（推奨・安定）' }, { value: 'ja', label: '日本語' }], st.promptLanguage, (v) => { st.promptLanguage = v; lsSet('assistLang', v); })),
    );
    const sbOpts = h('div', { class: `stack ${mode === 'storyboard' ? '' : 'hidden'}` },
      h('label', { class: 'field' }, 'シーン数', h('input', { type: 'number', min: 2, max: 12, value: st.sceneCount, oninput: (e) => (st.sceneCount = Number(e.target.value)) })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (st.withNarration = e.target.checked) }), '各シーンのナレーション原稿も作る（日本語）'),
    );
    body.append(sbOpts);
    const status = h('div', { class: 'tiny' });
    body.append(status);
    modal({
      title: '✨ AI でプロンプトを作成',
      body,
      actions: [
        { label: 'キャンセル', onClick: (close) => close() },
        {
          label: '作成する',
          class: 'primary',
          onClick: async (close) => {
            status.textContent = '作成中…（添付の量により数十秒かかります）';
            try {
              const r = await api.post('/api/assist/prompt', {
                instruction: g.prompt,
                attachments: g.attachments.map((a) => ({ id: a.id, role: a.role, roleLabel: IMAGE_ROLES[a.role] || VIDEO_ROLES[a.role], note: a.note })),
                mode: st.mode,
                sceneCount: st.sceneCount,
                duration: g.duration,
                maxDuration: effectiveMaxDuration(this.profile, g.attachments),
                aspectRatio: g.aspectRatio,
                promptLanguage: st.promptLanguage,
                withNarration: st.withNarration,
                narrationLanguage: st.narrationLanguage,
                model: store.settings.textModel,
                videoModel: this.modelId(),
              });
              close();
              if (st.mode === 'storyboard') {
                this.set({ storyboard: { id: `sb_${Date.now().toString(36)}`, title: r.result.title, scenes: r.result.scenes.map((s) => ({ ...s, jobId: null })), withNarration: st.withNarration } });
                toast(`${r.result.scenes.length} シーンのストーリーボードを作りました`, 'ok');
              } else {
                this.set({ prompt: r.result.prompt, ...(r.result.negativePrompt && this.profile.supportsNegativePrompt ? { negativePrompt: r.result.negativePrompt } : {}) });
                toast('プロンプトを作成しました。内容を確認して「動画を生成」を押してください。', 'ok');
              }
            } catch (e) {
              status.textContent = '';
              toast(e.message, 'err');
            }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------ ストーリーボード
  renderStoryboard() {
    const sb = this.gen.storyboard;
    const box = h('div', { class: 'card stack' });
    this.sbBox = box;
    const save = () => this.set({ storyboard: sb }, false);
    add(box, 
      h('div', { class: 'row' }, h('b', {}, `🗂 ${sb.title || 'ストーリーボード'}`), h('span', { class: 'tiny' }, `${sb.scenes.length} シーン · 合計 ${sb.scenes.reduce((s, x) => s + Number(x.duration || 0), 0)} 秒`), h('div', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: '閉じる', onclick: async () => { if (await confirmDialog('ストーリーボードを閉じますか？（生成済みの動画はライブラリに残ります）')) this.set({ storyboard: null }); } }, '✕')),
    );
    sb.scenes.forEach((s, i) => {
      const statusEl = h('span', { class: 'tiny', dataset: { scene: i } });
      add(box, 
        h('div', { class: 'scene' },
          h('div', { class: 'row' },
            h('b', { class: 'small' }, `${i + 1}.`),
            h('input', { value: s.title, style: { flex: 1, fontSize: '12.5px', padding: '3px 7px' }, oninput: (e) => { s.title = e.target.value; save(); } }),
            h('input', { type: 'number', min: 3, max: 10, value: s.duration, title: '秒数', style: { width: '58px', fontSize: '12px', padding: '3px 6px' }, oninput: (e) => { s.duration = Number(e.target.value); save(); } }),
            h('span', { class: 'tiny' }, '秒'),
          ),
          h('textarea', { value: s.prompt, oninput: (e) => { s.prompt = e.target.value; save(); } }),
          sb.withNarration || s.narration ? h('label', { class: 'field' }, '🎙 ナレーション', h('textarea', { rows: 2, value: s.narration || '', style: { minHeight: '44px' }, oninput: (e) => { s.narration = e.target.value; save(); } })) : null,
          h('div', { class: 'row' }, statusEl, h('div', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: () => this.generateScene(i) }, '🎬 このシーンを生成'),
          ),
        ),
      );
    });
    const narrCheck = h('input', { type: 'checkbox', checked: Boolean(sb.withNarration) });
    add(box, 
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => this.generateAllScenes() }, '🎬 すべてのシーンを生成'),
        h('button', { class: 'btn', onclick: () => this.storyboardToTimeline(narrCheck.checked) }, '＋ 生成済みシーンを順番にタイムラインへ'),
      ),
      h('label', { class: 'check' }, narrCheck, 'タイムラインに追加するとき、各シーンのナレーション原稿を音声にして重ねる（元の音声はミュート）'),
    );
    setTimeout(() => this.updateStoryboardStatus(), 0);
    return box;
  }

  sceneItem(i) {
    const sb = this.gen.storyboard;
    return store.library.find((it) => it.meta?.storyboardId === sb.id && it.meta?.sceneIndex === i) || null;
  }

  updateStoryboardStatus() {
    if (!this.sbBox) return;
    for (const el of this.sbBox.querySelectorAll('[data-scene]')) {
      const i = Number(el.dataset.scene);
      const s = this.gen.storyboard?.scenes[i];
      if (!s) continue;
      const job = s.jobId && this.jobs.find((j) => j.id === s.jobId);
      const item = this.sceneItem(i);
      el.textContent = job && (job.status === 'running' || job.status === 'queued') ? '⏳ 生成中…' : item ? '✅ 生成済み' : job?.status === 'error' ? '⚠ 失敗' : '未生成';
    }
  }

  async generateScene(i) {
    const sb = this.gen.storyboard;
    const s = sb.scenes[i];
    const prof = this.profile;
    let duration = Number(s.duration) || this.gen.duration;
    if (prof.durations) duration = prof.durations.reduce((a, b) => (Math.abs(b - duration) < Math.abs(a - duration) ? b : a));
    else duration = Math.max(prof.durationRange[0], Math.min(prof.durationRange[1], duration));
    const job = await this.generate({ prompt: s.prompt, duration, count: 1, sceneTitle: `${i + 1}. ${s.title}`, sceneIndex: i, storyboardId: sb.id, narration: s.narration || null, extendItemId: null, editItemId: null });
    if (job) {
      s.jobId = job.id;
      this.set({ storyboard: sb }, false);
      this.updateStoryboardStatus();
    }
  }

  async generateAllScenes() {
    const sb = this.gen.storyboard;
    if (!(await confirmDialog(`${sb.scenes.length} シーンをすべて生成します（API の利用料金がかかります）。よろしいですか？`, '生成する'))) return;
    for (let i = 0; i < sb.scenes.length; i++) {
      if (this.sceneItem(i)) continue;
      await this.generateScene(i);
    }
  }

  async storyboardToTimeline(withNarration) {
    const sb = this.gen.storyboard;
    const items = sb.scenes.map((_, i) => this.sceneItem(i));
    const ready = items.map((it, i) => ({ it, i })).filter((x) => x.it);
    if (!ready.length) return toast('まだ生成済みのシーンがありません', 'warn');
    const clips = [];
    for (const { it, i } of ready) {
      const clip = store.addVideoClip(it, { select: false });
      if (clip) clips.push({ clip, item: it, narration: sb.scenes[i].narration });
    }
    toast(`${clips.length} シーンをタイムラインに追加しました${ready.length < items.length ? `（未生成 ${items.length - ready.length} シーンは除外）` : ''}`, 'ok');
    if (withNarration) {
      const targets = clips.filter((c) => c.narration?.trim());
      if (targets.length) await narrateClips(targets.map((c) => ({ clipId: c.clip.id, script: c.narration })));
    }
  }
}
