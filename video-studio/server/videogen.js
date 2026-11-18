// 動画生成: Veo（predictLongRunning）と Gemini Omni（Interactions API）
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, getSettings, isDemo } from './config.js';
import { ApiError, client, collectContent, downloadUri, friendlyError, rest, uploadFile } from './gemini.js';
import { enrichPrompt } from './assist.js';
import { getAttachment } from './attachments.js';
import { addMedia, getItem, mediaPath } from './media.js';
import { createJob, logJob, runJob, updateJob } from './jobs.js';
import { mockVideo } from './mock.js';
import { newId, sleep } from './util.js';
import { IMAGE_ROLES, VIDEO_ROLES, effectiveMaxDuration, modelProfile, planAttachments } from '../public/js/shared/capabilities.js';

const INLINE_VIDEO_LIMIT = 14 * 1024 * 1024;

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

function clean(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined || obj[k] === null || obj[k] === '' || Number.isNaN(obj[k])) delete obj[k];
  return obj;
}

function tmpFile(ext = '.mp4') {
  return path.join(DIRS.tmp, `${newId('gen_')}${ext}`);
}

// ------------------------------------------------------------------ Veo
const VEO_OPTIONAL = [
  [/resolution/i, 'resolution'],
  [/duration/i, 'durationSeconds'],
  [/person/i, 'personGeneration'],
  [/negative/i, 'negativePrompt'],
  [/seed/i, 'seed'],
  [/numberOfVideos|sample_?count/i, 'numberOfVideos'],
  [/enhance/i, 'enhancePrompt'],
  [/generate_?audio/i, 'generateAudio'],
];

async function veoGenerate(ctx) {
  const { job, model, prompt, opts, direct, extendItem } = ctx;
  const ai = client();
  const config = clean({
    numberOfVideos: 1,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution,
    durationSeconds: opts.duration ? Number(opts.duration) : undefined,
    negativePrompt: opts.negativePrompt,
    personGeneration: opts.personGeneration && opts.personGeneration !== 'default' ? opts.personGeneration : undefined,
    seed: opts.seed !== undefined && opts.seed !== '' ? Number(opts.seed) + (ctx.index || 0) : undefined,
    ...(opts.extraParams || {}),
  });
  const req = { model, prompt, config };
  const img = (a) => ({ imageBytes: b64(a.path), mimeType: a.mimeType });
  const first = direct.find((d) => d.as === 'first');
  const last = direct.find((d) => d.as === 'last');
  const refs = direct.filter((d) => d.as === 'reference');
  if (first) req.image = img(first);
  if (last) config.lastFrame = img(last);
  if (refs.length) {
    config.referenceImages = refs.map((r) => ({ image: img(r), referenceType: 'asset' }));
    if (config.durationSeconds && config.durationSeconds !== 8) {
      logJob(job, '参照画像を使う場合、Veo の長さは 8 秒固定になります');
      config.durationSeconds = 8;
    }
  }
  if (extendItem) {
    const uri = extendItem.meta?.remote?.uri;
    if (!uri) throw new Error('この動画は Veo で生成されたものではないため延長できません（Veo の延長は Veo 生成動画のみ・生成後2日以内）');
    req.video = { uri, mimeType: 'video/mp4' };
    delete req.image;
    delete config.lastFrame;
    delete config.referenceImages;
    delete config.durationSeconds;
    config.resolution = '720p';
  }

  let op;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      op = await ai.models.generateVideos(req);
      break;
    } catch (e) {
      const status = e?.status ?? e?.code;
      const msg = e?.message || '';
      const hit = status === 400 && VEO_OPTIONAL.find(([re, key]) => re.test(msg) && key in config);
      if (!hit) throw e;
      ctx.warnings.push(`「${hit[1]}」がモデルに受け付けられなかったため省略して再試行しました`);
      logJob(job, `パラメータ ${hit[1]} を省略して再試行`);
      delete config[hit[1]];
    }
  }
  const started = Date.now();
  const deadline = started + (getSettings().generationTimeoutMin || 20) * 60_000;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error('生成がタイムアウトしました');
    await sleep(8000);
    logJob(job, `Veo で生成中…（${Math.round((Date.now() - started) / 1000)} 秒経過）`);
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (op.error) throw new ApiError(op.error.code || 500, op.error.message || JSON.stringify(op.error));
  const vids = op.response?.generatedVideos || [];
  if (!vids.length) {
    const reasons = op.response?.raiMediaFilteredReasons?.join(' / ');
    throw new Error(`動画が返されませんでした${reasons ? `（安全フィルタ: ${reasons}）` : '（安全フィルタでブロックされた可能性があります）'}`);
  }
  const results = [];
  for (const gv of vids) {
    const v = gv.video || {};
    const dest = tmpFile('.mp4');
    if (v.videoBytes) fs.writeFileSync(dest, Buffer.from(v.videoBytes, 'base64'));
    else if (v.uri) {
      try {
        await downloadUri(v.uri, dest);
      } catch {
        await ai.files.download({ file: gv, downloadPath: dest });
      }
    } else throw new Error('動画データが空でした');
    results.push({ path: dest, remote: v.uri ? { uri: v.uri, mimeType: v.mimeType || 'video/mp4', createdAt: new Date().toISOString() } : null });
  }
  return results;
}

// ------------------------------------------------------------------ Gemini Omni (Interactions API)
async function videoContent(file, mimeType, name) {
  const size = fs.statSync(file).size;
  if (size <= INLINE_VIDEO_LIMIT) return { type: 'video', data: b64(file), mime_type: mimeType || 'video/mp4' };
  const f = await uploadFile(file, mimeType || 'video/mp4', name);
  return { type: 'video', uri: f.uri, mime_type: f.mimeType };
}

async function buildOmniInput(ctx, { includeSourceVideo = false } = {}) {
  const { prompt, direct, extendItem, editItem } = ctx;
  const input = [];
  let imgN = 0;
  let vidN = 0;
  for (const a of direct) {
    if (a.kind === 'image') {
      imgN++;
      input.push({ type: 'text', text: `画像${imgN}（${IMAGE_ROLES[a.as] || '参照'}${a.note ? `: ${a.note}` : ''}）` });
      input.push({ type: 'image', data: b64(a.path), mime_type: a.mimeType });
    } else if (a.kind === 'video') {
      vidN++;
      input.push({ type: 'text', text: `動画${vidN}（${VIDEO_ROLES[a.as] || '参考動画'}${a.note ? `: ${a.note}` : ''}）` });
      input.push(await videoContent(a.path, a.mimeType, a.name));
    } else if (a.as === 'text') {
      input.push({ type: 'text', text: `【資料: ${a.name}】\n${String(a.text || '').slice(0, 20000)}` });
    }
  }
  let mainPrompt = prompt;
  if (extendItem) {
    input.push({ type: 'text', text: '延長元の動画:' });
    input.push(await videoContent(mediaPath(extendItem), extendItem.mimeType, extendItem.name));
    mainPrompt = `上の「延長元の動画」の最後から自然につながる続きの映像を生成してください。${prompt ? `\n続きの内容: ${prompt}` : ''}`;
  }
  if (editItem && includeSourceVideo) {
    input.push({ type: 'text', text: '修正元の動画:' });
    input.push(await videoContent(mediaPath(editItem), editItem.mimeType, editItem.name));
    mainPrompt = `上の「修正元の動画」を次の指示に従って修正した動画を生成してください。\n${prompt}`;
  }
  input.push({ type: 'text', text: mainPrompt || 'A short cinematic video.' });
  return input;
}

async function pollInteraction(ctx, it) {
  const { job } = ctx;
  const started = Date.now();
  const deadline = started + (getSettings().generationTimeoutMin || 20) * 60_000;
  const contents = [];
  let hops = 0;
  for (;;) {
    while (['in_progress', 'queued', 'created', 'pending'].includes(it.status)) {
      if (Date.now() > deadline) throw new Error('生成がタイムアウトしました');
      await sleep(5000);
      logJob(job, `Gemini Omni で生成中…（${Math.round((Date.now() - started) / 1000)} 秒経過）`);
      it = await rest('GET', `interactions/${encodeURIComponent(it.id)}`);
    }
    contents.push(...collectContent(it));
    if (it.status === 'requires_continuation' && it.continuation_token && hops < 5) {
      hops++;
      it = await rest('POST', 'interactions', { model: ctx.model, previous_interaction_id: it.id, continuation_token: it.continuation_token, background: true });
      continue;
    }
    break;
  }
  if (it.status && it.status !== 'completed' && !contents.some((c) => c.type === 'video')) {
    throw interactionFailure(it);
  }
  return { it, contents };
}

const RPC_CODES = { 1: 'CANCELLED', 2: 'UNKNOWN', 3: 'INVALID_ARGUMENT', 4: 'DEADLINE_EXCEEDED', 5: 'NOT_FOUND', 7: 'PERMISSION_DENIED', 8: 'RESOURCE_EXHAUSTED', 9: 'FAILED_PRECONDITION', 13: 'INTERNAL', 14: 'UNAVAILABLE', 16: 'UNAUTHENTICATED' };
const TRANSIENT = new Set(['', 'UNKNOWN', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'UNAUTHENTICATED', 'CANCELLED']);

/** base64 の動画データなどを除いた、調査用のレスポンス */
function sanitize(obj) {
  return JSON.stringify(obj, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v), 1).slice(0, 4000);
}

function explainFailure(code, message) {
  if (/safety|blocked|policy|prohibit|responsible|celebrit|harm/i.test(message)) {
    return '安全フィルタ（実在の人物・有名人・ブランド・暴力的な表現など）で止められた可能性があります。表現を言い換えて再試行してください。';
  }
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
      return '入力がモデルに受け付けられませんでした。添付した動画・画像（形式・長さ・枚数）や、長さと解像度の組み合わせを見直してください（例: 添付を減らす、長さを短くする、解像度を 720p にする）。';
    case 'PERMISSION_DENIED':
      return 'API キーにこのモデルの利用権限がありません。課金の設定や、モデルが使える地域・プランかを確認してください。';
    case 'RESOURCE_EXHAUSTED':
      return '利用上限（レート制限・クォータ）に達しました。少し時間をおいてから再試行してください。';
    default:
      return 'Google 側で一時的に処理に失敗したものです。内容に問題がなくても起きることがあり、同じ内容でもう一度生成すると成功することが多いです（失敗した分は課金されません）。';
  }
}

function interactionFailure(it) {
  const errs = [...(it.errors || []), ...(it.steps || []).map((st) => st.error).filter(Boolean)];
  const rawCode = errs.map((e) => e.code ?? e.status).find((c) => c !== undefined && c !== null);
  const code = typeof rawCode === 'number' ? RPC_CODES[rawCode] || String(rawCode) : String(rawCode || '').toUpperCase();
  const message = errs.map((e) => e.message).filter(Boolean).join(' / ');
  console.error('[omni] interaction failed:', sanitize(it));
  const err = new Error(
    `生成に失敗しました（status: ${it.status}${code ? ` / code: ${code}` : ''}）\n原因の目安: ${explainFailure(code, message)}${message ? `\nAPI の応答: ${message}` : ''}`,
  );
  err.userMessage = err.message;
  err.interactionFailed = true;
  err.code = code;
  err.transient = TRANSIENT.has(code) && !/safety|blocked|policy|prohibit/i.test(message);
  err.detail = sanitize({ id: it.id, status: it.status, errors: it.errors, steps: (it.steps || []).filter((st) => st.error || st.type === 'model_output') });
  return err;
}

async function omniGenerate(ctx) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await omniGenerateOnce(ctx, attempt);
    } catch (e) {
      if (e.interactionFailed && e.transient && attempt < 1) {
        logJob(ctx.job, `Google 側の一時的な失敗（${e.code || 'code なし'}）のため、自動でもう一度生成します（失敗分は課金されません）`);
        ctx.warnings.push(`1 回目は Google 側の一時的な失敗（${e.code || 'code なし'}）だったため、自動で再試行しました`);
        await sleep(3000);
        continue;
      }
      if (e.detail) ctx.job.errorDetail = e.detail;
      throw e;
    }
  }
}

async function omniGenerateOnce(ctx, attempt = 0) {
  const { job, model, opts, editItem } = ctx;
  const rf = clean({
    type: 'video',
    aspect_ratio: opts.aspectRatio,
    duration: opts.duration ? `${Number(opts.duration)}s` : undefined,
    resolution: opts.resolution,
    delivery: ['1080p', '4k'].includes(opts.resolution) ? 'uri' : undefined,
  });
  const prevId = editItem?.meta?.interactionId && !String(editItem.meta.interactionId).startsWith('demo_') ? editItem.meta.interactionId : null;
  let input = await buildOmniInput(ctx, { includeSourceVideo: Boolean(editItem && !prevId) });
  const base = { model, input, response_format: rf, background: attempt === 0, ...(prevId ? { previous_interaction_id: prevId } : {}), ...(opts.extraParams || {}) };
  if (!base.background) delete base.background;

  // パラメータ形式が受け付けられなかった場合の段階的フォールバック
  const variants = [
    { label: null, make: (b) => b },
    { label: 'background', make: (b) => { const { background, ...r } = b; return r; } },
    { label: 'duration / resolution / delivery', make: (b) => { const { background, ...r } = b; return { ...r, response_format: clean({ type: 'video', aspect_ratio: rf.aspect_ratio }) }; } },
    { label: 'response_format', make: (b) => { const { background, response_format, ...r } = b; return { ...r, response_modalities: ['video'] }; } },
  ];
  let it;
  let firstErr;
  for (const v of variants) {
    try {
      it = await rest('POST', 'interactions', v.make(base));
      if (v.label) ctx.warnings.push(`API が ${v.label} の指定を受け付けなかったため省略して生成しました`);
      break;
    } catch (e) {
      firstErr ||= e;
      if (!(e instanceof ApiError) || e.status !== 400) break;
      if (prevId && /interaction/i.test(e.message)) {
        // 以前の会話が使えない場合は動画自体を添付して修正
        logJob(job, '前回の生成履歴が使えないため、動画を添付して修正します');
        delete base.previous_interaction_id;
        base.input = await buildOmniInput(ctx, { includeSourceVideo: true });
      }
      logJob(job, `リクエスト形式を変更して再試行: ${e.message.slice(0, 120)}`);
    }
  }
  if (!it) throw firstErr;
  const { it: done, contents } = await pollInteraction(ctx, it);
  const videos = contents.filter((c) => c.type === 'video' || String(c.mime_type || '').startsWith('video/'));
  const text = contents.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
  if (!videos.length) throw new Error(`動画が返されませんでした。${text ? `モデルの応答: ${text.slice(0, 600)}` : '（安全フィルタでブロックされた可能性があります）'}`);
  const results = [];
  for (const v of videos) {
    const dest = tmpFile(String(v.mime_type || '').includes('webm') ? '.webm' : '.mp4');
    if (v.data) fs.writeFileSync(dest, Buffer.from(v.data, 'base64'));
    else if (v.uri) await downloadUri(v.uri, dest);
    else continue;
    results.push({ path: dest, interactionId: done.id, modelText: text });
  }
  if (!results.length) throw new Error('動画データが空でした');
  return results;
}

// ------------------------------------------------------------------ ジョブ
export function startGeneration(params) {
  const settings = getSettings();
  const model = String(params.model || settings.videoModel).trim();
  const profile = modelProfile(model, settings, params.protocol);
  const count = Math.max(1, Math.min(4, Number(params.count) || 1));

  const atts = (params.attachments || []).map((ref) => {
    const a = getAttachment(ref.id);
    if (!a) throw new Error('添付ファイルが見つかりません。もう一度追加してください。');
    return { ...a, role: ref.role, note: ref.note };
  });
  const { plan, errors, warnings } = planAttachments(profile, atts);
  if (errors.length) throw new Error(errors.join('\n'));
  const direct = atts.filter((a) => plan[a.id].usage === 'direct').map((a) => ({ ...a, as: plan[a.id].as }));
  // モデルの上限秒数に収める（Omni で最初/最後のフレームを使うときは 10 秒まで）
  if (profile.durationRange && params.duration) {
    const maxDur = effectiveMaxDuration(profile, direct.map((d) => ({ kind: d.kind, role: d.as })));
    if (Number(params.duration) > maxDur) {
      warnings.push(`このモデル・添付の組み合わせでは最大 ${maxDur} 秒のため、${params.duration} 秒 → ${maxDur} 秒にしました`);
      params = { ...params, duration: maxDur };
    }
  }
  const assistAtts = atts.filter((a) => plan[a.id].usage === 'assist');

  const extendItem = params.extendItemId ? getItem(params.extendItemId) : null;
  const editItem = params.editItemId ? getItem(params.editItemId) : null;
  if (params.extendItemId && !extendItem) throw new Error('延長元の動画がライブラリにありません');
  if (params.editItemId && !editItem) throw new Error('修正元の動画がライブラリにありません');
  if (editItem && profile.protocol !== 'interactions') throw new Error('生成結果の修正は Gemini Omni モデルでのみ使えます');
  if (!params.prompt?.trim() && !direct.length && !assistAtts.length && !extendItem) throw new Error('プロンプトを入力するか、ファイルを添付してください');

  let extra = {};
  if (params.extraParams) {
    try {
      extra = typeof params.extraParams === 'string' ? JSON.parse(params.extraParams) : params.extraParams;
    } catch {
      throw new Error('追加パラメータ(JSON)の形式が正しくありません');
    }
  }

  const job = createJob('generate', {
    model,
    protocol: profile.protocol,
    family: profile.family,
    prompt: params.prompt || '',
    finalPrompt: null,
    params: {
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      duration: params.duration,
      count,
      mode: extendItem ? 'extend' : editItem ? 'edit' : 'generate',
      sceneTitle: params.sceneTitle || null,
      attachmentNames: atts.map((a) => a.name),
    },
    warnings: [...warnings],
    items: [],
    request: { ...params, count },
  });

  return runJob(job, async () => {
    let prompt = String(params.prompt || '').trim();
    if (assistAtts.length && params.autoAssist !== false) {
      logJob(job, `添付資料 ${assistAtts.length} 件を読み取ってプロンプトに反映中…`);
      const directSummary = direct.map((d) => `${d.name}（${plan[d.id].note}）`).join('、');
      prompt = await enrichPrompt({ prompt, assistAttachments: assistAtts, directSummary, model: params.textModel, duration: params.duration, aspectRatio: params.aspectRatio });
    }
    updateJob(job, { finalPrompt: prompt });
    logJob(job, `${profile.family}（${model}）に送信中…`);

    const runOne = async (index) => {
      const ctx = { job, model, prompt, direct, extendItem, editItem, index, warnings: job.warnings, opts: { ...params, extraParams: extra } };
      if (isDemo()) {
        const p = await mockVideo({ duration: Number(params.duration) || 6, aspectRatio: params.aspectRatio, resolution: params.resolution, seed: Date.now() % 1000 + index });
        return [{ path: p, interactionId: profile.protocol === 'interactions' ? `demo_${newId()}` : null, remote: profile.protocol === 'veo' ? { uri: 'demo://video', mimeType: 'video/mp4' } : null }];
      }
      return profile.protocol === 'veo' ? veoGenerate(ctx) : omniGenerate(ctx);
    };

    const settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => runOne(i)));
    const outputs = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
    const failures = settled.filter((s) => s.status === 'rejected').map((s) => s.reason?.userMessage || friendlyError(s.reason));
    if (!outputs.length) throw Object.assign(new Error(failures[0] || '生成に失敗しました'), { userMessage: failures[0] });
    if (failures.length) {
      job.failedCount = failures.length;
      job.warnings.push(`${count} 本中 ${failures.length} 本の生成に失敗しました（成功した分は下に表示）: ${failures[0]}`);
    }

    logJob(job, 'ライブラリに保存中…');
    const baseName = (params.sceneTitle || prompt || 'AI動画').replace(/\s+/g, ' ').slice(0, 40);
    const items = [];
    for (const [i, out] of outputs.entries()) {
      const item = await addMedia(out.path, {
        name: `${baseName}${outputs.length > 1 ? ` #${i + 1}` : ''}.mp4`,
        source: 'generated',
        move: true,
        meta: {
          prompt,
          originalPrompt: params.prompt || '',
          model,
          protocol: profile.protocol,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          duration: params.duration,
          jobId: job.id,
          interactionId: out.interactionId || null,
          remote: out.remote || null,
          modelText: out.modelText || null,
          sceneTitle: params.sceneTitle || null,
          sceneIndex: params.sceneIndex ?? null,
          storyboardId: params.storyboardId || null,
          narration: params.narration || null,
          parentItemId: extendItem?.id || editItem?.id || null,
        },
      });
      items.push(item);
    }
    return { items, itemIds: items.map((i) => i.id), message: '完了' };
  });
}
