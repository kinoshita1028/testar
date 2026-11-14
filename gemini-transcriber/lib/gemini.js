// Minimal Gemini API client (REST, v1beta) for transcription and correction.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NO_SPEECH = '[NO_SPEECH]';

export class GeminiError extends Error {
  constructor(message, status = 0, detail = '') {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyMessage(status, detail) {
  const d = String(detail || '');
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(d)) {
    return 'API キーが無効です。設定のキーを確認してください。';
  }
  if (status === 400) return `リクエストが不正です: ${d}`;
  if (status === 401 || status === 403) return `API キーに権限がありません: ${d}`;
  if (status === 404) return `モデルが見つかりません。設定でモデルを選び直すか「auto」にしてください。（${d}）`;
  if (status === 429) return 'API の利用上限（レート制限／クォータ）に達しました。少し待ってから再試行してください。';
  if (status >= 500) return `Gemini 側のエラーです（${status}）。少し待ってから再試行してください。`;
  return d || `エラー（${status}）`;
}

async function callApi(path, apiKey, { method = 'GET', body, signal, retries = 2 } = {}) {
  if (!apiKey) throw new GeminiError('API キーが設定されていません。', 0);

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < retries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new GeminiError('ネットワークエラー：Gemini API に接続できませんでした。', 0, String(err));
    }

    if (res.ok) return res.json();

    const text = await res.text();
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.message || text;
    } catch {
      /* not JSON */
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new GeminiError(friendlyMessage(res.status, detail), res.status, detail);
  }
}

// ---------------------------------------------------------------- models

export async function listModels(apiKey) {
  const models = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) q.set('pageToken', pageToken);
    const json = await callApi(`models?${q}`, apiKey);
    for (const m of json.models || []) {
      models.push({
        id: String(m.name || '').replace(/^models\//, ''),
        displayName: m.displayName || '',
        methods: m.supportedGenerationMethods || [],
      });
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return models;
}

const EXCLUDED = /(image|tts|live|native-audio|embed|aqa|imagen|veo|computer|robotics|learnlm|gemma|banana|thinking|exp|research|transcribe|nano|cyber|omni|customtools)/i;

/** Pick the newest general-purpose Flash model (stable preferred over preview). */
export function pickAutoModel(models) {
  const ids = models.filter((m) => m.methods.includes('generateContent')).map((m) => m.id);
  const scored = ids
    .filter((id) => /^gemini-\d/.test(id) && /flash/.test(id) && !EXCLUDED.test(id))
    .map((id) => {
      const version = parseFloat(id.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
      let score = version * 100;
      if (!/lite/.test(id)) score += 20;
      if (!/preview/.test(id)) score += 10;
      if (/-\d{2}-\d{4}$|-\d{3}$/.test(id)) score -= 2; // prefer the undated alias
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length) return scored[0].id;
  if (ids.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  return ids.find((id) => id.startsWith('gemini-')) || null;
}

const autoCache = new Map(); // apiKey -> model id

export async function resolveModel(apiKey, setting, { refresh = false } = {}) {
  const wanted = String(setting || '').trim().replace(/^models\//, '');
  if (wanted && wanted.toLowerCase() !== 'auto') return wanted;
  if (!refresh && autoCache.has(apiKey)) return autoCache.get(apiKey);
  const picked = pickAutoModel(await listModels(apiKey));
  if (!picked) throw new GeminiError('利用できる Gemini モデルが見つかりませんでした。', 404);
  autoCache.set(apiKey, picked);
  return picked;
}

// ---------------------------------------------------------- generation

// Per-model thinking settings: keep latency low for a real-time tool.
function thinkingOptions(model) {
  const m = model.toLowerCase();
  if (/gemini-2\.5-flash/.test(m)) return [{ thinkingBudget: 0 }];
  if (/gemini-2\.5-pro/.test(m)) return [{ thinkingBudget: 128 }];
  if (/gemini-(?:[3-9]|\d{2})/.test(m)) {
    return /flash/.test(m) ? [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }] : [{ thinkingLevel: 'low' }];
  }
  return [];
}

// Gemini 3+ recommends the default temperature; older models transcribe best at 0.
function temperatureFor(model) {
  return /gemini-(?:[3-9]|\d{2})|latest/i.test(model) ? undefined : 0;
}

const thinkingFallback = new Map(); // model -> index into thinkingOptions (or length = none)

async function generate(apiKey, model, payload, signal) {
  const options = thinkingOptions(model);
  let idx = thinkingFallback.get(model) ?? 0;

  for (;;) {
    const body = structuredClone(payload);
    body.generationConfig = { ...(body.generationConfig || {}) };
    const temp = temperatureFor(model);
    if (temp !== undefined) body.generationConfig.temperature = temp;
    if (idx < options.length) body.generationConfig.thinkingConfig = options[idx];

    try {
      return await callApi(`models/${model}:generateContent`, apiKey, { method: 'POST', body, signal });
    } catch (err) {
      const thinkingRejected = err.status === 400 && /think/i.test(err.detail || '') && idx < options.length;
      if (!thinkingRejected) throw err;
      idx++;
      thinkingFallback.set(model, idx);
    }
  }
}

function extractText(json) {
  const cand = json?.candidates?.[0];
  if (!cand) {
    const reason = json?.promptFeedback?.blockReason;
    if (reason) throw new GeminiError(`安全フィルタでブロックされました（${reason}）`, 200);
    return '';
  }
  return (cand.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

async function withModel(apiKey, setting, fn) {
  const isAuto = !setting || String(setting).trim().toLowerCase() === 'auto';
  const model = await resolveModel(apiKey, setting);
  try {
    return await fn(model);
  } catch (err) {
    // The auto-picked model may have been retired: pick again once.
    if (isAuto && err.status === 404) {
      const fresh = await resolveModel(apiKey, setting, { refresh: true });
      if (fresh !== model) return fn(fresh);
    }
    throw err;
  }
}

// --------------------------------------------------------- transcription

const LANG_LABEL = { ja: '日本語', en: '英語', auto: '' };
const LANG_CODES = { ja: ['ja-JP'], en: ['en-US'], auto: [] };

export function languageCodesFor(language) {
  return LANG_CODES[language] || [];
}

/** Glossary textarea -> list of vocabulary phrases. */
export function vocabularyFrom(glossary) {
  return [...new Set(String(glossary || '').split(/[\n,、]/).map((w) => w.trim()).filter(Boolean))].slice(0, 100);
}

function transcribePrompt({ language, removeFillers, glossary, prevText }) {
  const target = language === 'auto' ? '話されている言語のまま' : `${LANG_LABEL[language] || '日本語'}で`;
  const lines = [
    `この音声を${target}正確に文字起こししてください。`,
    '',
    '# ルール',
    '- 話された内容だけを書き起こす。要約・翻訳・言い換え・説明・返答は一切しない',
    '- 自然な位置に句読点を付ける',
    removeFillers
      ? '- 「えー」「あのー」「えっと」などのフィラーや、言い直しの断片は省く'
      : '- 「えー」「あのー」などのフィラーも聞こえたとおりに残す',
    '- 数字・英単語は一般的な表記にする',
    `- 話し声が含まれていない、または全く聞き取れない場合は ${NO_SPEECH} とだけ出力する`,
    '- 出力は文字起こし本文のみ（前置き・引用符・注釈は付けない）',
  ];
  if (glossary.trim()) {
    lines.push('', '# 用語ヒント（これらの語が話されたらこの表記を使う）', glossary.trim());
  }
  if (prevText) {
    lines.push('', '# 直前の発言（文脈の参考のみ。出力には絶対に含めない）', prevText);
  }
  return lines.join('\n');
}

function cleanTranscript(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  s = s.split(NO_SPEECH).join('').trim();
  if (/^「[^「」]*」$/.test(s)) s = s.slice(1, -1).trim();
  if (/^"[^"]*"$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}

export async function transcribeAudio({
  apiKey, model, audioBase64, mimeType = 'audio/wav',
  language = 'ja', removeFillers = true, glossary = '', prevText = '', signal,
}) {
  return withModel(apiKey, model, async (m) => {
    const json = await generate(apiKey, m, {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: audioBase64 } },
          { text: transcribePrompt({ language, removeFillers, glossary, prevText }) },
        ],
      }],
      generationConfig: { maxOutputTokens: 4096 },
    }, signal);
    return cleanTranscript(extractText(json));
  });
}

// ------------------------------------- dedicated transcription model

function interactionText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  const texts = [];
  for (const step of Array.isArray(json?.steps) ? json.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const c of step.content || []) if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
  }
  if (!texts.length) {
    for (const o of Array.isArray(json?.outputs) ? json.outputs : []) if (o?.type === 'text' && typeof o.text === 'string') texts.push(o.text);
  }
  return texts.join('');
}

/**
 * Transcribe one block with a dedicated speech-to-text model
 * (gemini-3.5-transcribe) through the Interactions API.
 */
export async function transcribeWithTranscribeModel({
  apiKey, model = 'gemini-3.5-transcribe', audioBase64, mimeType = 'audio/wav',
  language = 'ja', smart = true, glossary = '', signal,
}) {
  const config = { mode: smart ? 'smart' : 'verbatim' };
  const codes = languageCodesFor(language);
  if (codes.length) config.language_codes = codes;
  const vocab = vocabularyFrom(glossary);
  if (vocab.length) config.custom_vocabulary = vocab;

  const json = await callApi('interactions', apiKey, {
    method: 'POST',
    signal,
    body: {
      model: String(model).trim().replace(/^models\//, ''),
      input: [{ type: 'audio', data: audioBase64, mime_type: mimeType }],
      generation_config: { transcription_config: config },
      store: false,
    },
  });
  if (json?.status === 'failed') {
    const detail = json.errors?.[0]?.message || 'failed';
    throw new GeminiError(`文字起こしに失敗しました：${detail}`, 400, detail);
  }
  return cleanTranscript(interactionText(json));
}

// ------------------------------------------------------------ correction

function correctionPrompt({ text, context, glossary }) {
  return [
    'あなたは音声認識（文字起こし）結果の校正者です。',
    '「対象テキスト」は音声認識の出力で、誤認識を含む可能性があります。文脈から判断して、誤認識・誤変換だけを修正してください。',
    '',
    '# 修正するもの',
    '- 同音異義語の誤変換（例：「意外」と「以外」、「機会」と「機械」、「保証」と「保障」）',
    '- 聞き間違いによる、文脈に合わない語',
    '- 用語集にある固有名詞・専門用語の表記ゆれ',
    '- 明らかな誤字・脱字、不自然な句読点',
    '',
    '# 守ること',
    '- 文脈上「多分こうだろう」と十分に確信できる箇所だけ直す。自信がなければ元のまま残す',
    '- 話し言葉の言い回し・語順・文体・敬語レベルは変えない。要約・言い換え・追記・削除はしない',
    '- 「これまでの文脈」は判断材料。出力には対象テキストの修正版だけを入れる',
    '- 修正が不要なら対象テキストをそのまま返す',
    '',
    '# 出力（JSON）',
    '{"corrected": "修正後の対象テキスト全文", "changes": [{"before": "修正前の語句", "after": "修正後の語句", "reason": "短い理由"}]}',
    '',
    ...(glossary.trim() ? ['# 用語集', glossary.trim(), ''] : []),
    '# これまでの文脈（古い順）',
    context || '（なし）',
    '',
    '# 対象テキスト',
    text,
  ].join('\n');
}

const CORRECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    corrected: { type: 'STRING' },
    changes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          before: { type: 'STRING' },
          after: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['before', 'after'],
      },
    },
  },
  required: ['corrected'],
};

function parseCorrection(raw, original) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(s);
    return {
      corrected: typeof obj.corrected === 'string' ? obj.corrected.trim() : original,
      changes: Array.isArray(obj.changes) ? obj.changes : [],
    };
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return parseCorrection(m[0], original);
      } catch {
        /* ignore */
      }
    }
    return { corrected: s || original, changes: [] };
  }
}

/**
 * @returns {Promise<{corrected: string, changes: {before:string, after:string, reason?:string}[], skipped: boolean}>}
 */
export async function correctText({ apiKey, model, text, context = '', glossary = '', signal }) {
  return withModel(apiKey, model, async (m) => {
    const json = await generate(apiKey, m, {
      contents: [{ role: 'user', parts: [{ text: correctionPrompt({ text, context, glossary }) }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: CORRECTION_SCHEMA,
      },
    }, signal);

    const { corrected, changes } = parseCorrection(extractText(json), text);
    const cleanChanges = changes
      .filter((c) => c && typeof c.before === 'string' && typeof c.after === 'string' && c.before !== c.after)
      .map((c) => ({ before: c.before, after: c.after, reason: String(c.reason || '') }));

    // Guard against the model rewriting or summarising instead of correcting.
    const ratio = corrected.length / Math.max(1, text.length);
    if (!corrected || (text.length > 12 && (ratio < 0.5 || ratio > 1.8))) {
      return { corrected: text, changes: [], skipped: true };
    }
    return { corrected, changes: cleanChanges, skipped: false };
  });
}
