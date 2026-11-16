// プロンプト作成支援（添付資料を読み取って動画生成プロンプト／ストーリーボードを作る）
import { fileToPart, generateText } from './gemini.js';
import { getSettings, isDemo } from './config.js';
import { mockPrompt } from './mock.js';

const INLINE_BUDGET = 15 * 1024 * 1024;

/** 添付ファイルを generateContent 用の parts に変換 */
export async function attachmentsToParts(attachments) {
  const parts = [];
  let inlineBytes = 0;
  for (const [i, a] of attachments.entries()) {
    const label = `【添付${i + 1}: ${a.name}${a.role ? `（用途: ${a.roleLabel || a.role}）` : ''}${a.note ? ` メモ: ${a.note}` : ''}】`;
    if (['text', 'docx', 'pptx'].includes(a.kind)) {
      parts.push({ text: `${label}\n${a.text || '（内容なし）'}` });
    } else if (['image', 'video', 'audio', 'pdf'].includes(a.kind)) {
      parts.push({ text: label });
      const remaining = Math.max(0, INLINE_BUDGET - inlineBytes);
      const part = await fileToPart(a.path, a.mimeType, a.name, { inlineLimit: Math.min(remaining, 14 * 1024 * 1024) });
      if (part.inlineData) inlineBytes += Math.ceil((part.inlineData.data.length * 3) / 4);
      parts.push(part);
    } else {
      parts.push({ text: `${label}（この形式は読み取れません）` });
    }
  }
  return parts;
}

const SYSTEM = `あなたは映像ディレクター兼、AI動画生成モデル（Google Veo / Gemini Omni）向けのプロンプトエンジニアです。
ユーザーの指示と添付資料（文書・画像・動画・音声・PDF など）を読み取り、意図に沿った高品質な動画を生成するための具体的なプロンプトを作ります。
良いプロンプトの要素: 被写体と動作、シーン/背景、カメラ（ショットサイズ・アングル・動き）、光と色調、スタイル（実写/アニメ/質感）、雰囲気、音（効果音・環境音・台詞が必要なら引用符で）。
1本の動画は短い（数秒〜10秒程度）ので、1シーンに1つの明確なアクションを描写してください。
添付画像が「参照」「最初のフレーム」などとしてモデルに直接渡される場合は、プロンプト内で「添付画像の人物」「参照画像のスタイル」などと言及して構いません。
著作権のあるキャラクターや実在人物の模倣は避け、オリジナルの描写にしてください。`;

const SINGLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: '短いタイトル' },
    prompt: { type: 'STRING', description: '動画生成用プロンプト' },
    negativePrompt: { type: 'STRING', description: '避けたい要素（任意）' },
  },
  required: ['title', 'prompt'],
};

const STORYBOARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'シーン名' },
          prompt: { type: 'STRING', description: 'このシーンの動画生成用プロンプト' },
          duration: { type: 'NUMBER', description: '秒数' },
          narration: { type: 'STRING', description: 'このシーンのナレーション原稿（不要なら空）' },
        },
        required: ['title', 'prompt', 'duration'],
      },
    },
  },
  required: ['title', 'scenes'],
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AIの応答を解析できませんでした');
  }
}

/**
 * @param {{instruction:string, attachments:Array, mode:'single'|'storyboard', sceneCount?:number, duration?:number,
 *          aspectRatio?:string, promptLanguage?:'en'|'ja', narrationLanguage?:string, withNarration?:boolean, model?:string, videoModel?:string}} p
 */
export async function createPrompt(p) {
  if (isDemo()) return mockPrompt(p);
  const model = p.model || getSettings().textModel;
  const langLine = p.promptLanguage === 'ja' ? 'プロンプトは日本語で書いてください。' : 'プロンプト本文は英語で書いてください（動画モデルは英語の指示が最も安定します）。台詞を入れる場合は台詞部分のみ指定言語で。';
  const parts = await attachmentsToParts(p.attachments || []);
  let task;
  if (p.mode === 'storyboard') {
    const n = Math.max(2, Math.min(12, Number(p.sceneCount) || 4));
    task = `以下の指示と添付資料をもとに、${n} シーン構成のストーリーボードを作ってください。
各シーンは約 ${p.duration || 8} 秒（3〜${p.maxDuration || 10}秒の範囲）、アスペクト比 ${p.aspectRatio || '16:9'}。シーン間で登場人物・世界観・色調の一貫性を保つため、共通する特徴は各プロンプトに毎回具体的に書いてください。
${p.withNarration ? `各シーンに、その秒数で読み切れる長さ（日本語なら1秒あたり約6文字）のナレーション原稿を ${p.narrationLanguage === 'en' ? '英語' : '日本語'} で付けてください。` : 'narration は空文字にしてください。'}
${langLine}`;
  } else {
    task = `以下の指示と添付資料をもとに、${p.duration || 8} 秒・アスペクト比 ${p.aspectRatio || '16:9'} の動画を1本生成するためのプロンプトを作ってください。
${langLine}`;
  }
  parts.unshift({ text: `${task}\n\n# ユーザーの指示\n${p.instruction || '（指示なし。添付資料の内容から最適な動画を考えてください）'}` });
  const text = await generateText({
    model,
    parts,
    system: SYSTEM,
    json: true,
    schema: p.mode === 'storyboard' ? STORYBOARD_SCHEMA : SINGLE_SCHEMA,
  });
  const j = parseJson(text);
  if (p.mode === 'storyboard') {
    j.scenes = (j.scenes || []).map((s) => ({ ...s, duration: Math.max(3, Math.min(Number(p.maxDuration) || 10, Math.round(Number(s.duration) || p.duration || 8))) }));
  }
  return j;
}

/**
 * 生成時の自動補強: モデルに直接渡せない添付（PDF・音声・文書など）を読み取り、プロンプトに反映する
 */
export async function enrichPrompt({ prompt, assistAttachments, directSummary, model, duration, aspectRatio }) {
  if (isDemo()) return `${prompt}\n[デモ: 添付 ${assistAttachments.length} 件を反映]`;
  const parts = await attachmentsToParts(assistAttachments);
  parts.unshift({
    text: `ユーザーが動画生成モデルに送ろうとしているプロンプトと、モデルに直接は渡せない添付資料があります。
資料の内容（登場するもの、雰囲気、色、ストーリー、伝えたい情報など）を読み取り、ユーザーの意図を保ったまま、${duration || 8} 秒・${aspectRatio || '16:9'} の動画用の1つのプロンプトに統合してください。
${directSummary ? `なお、次の素材はモデルに直接渡されます: ${directSummary}\n` : ''}出力はプロンプト本文のみ（前置き・説明・引用符なし）。元のプロンプトと同じ言語で書いてください。

# 元のプロンプト
${prompt || '（空。資料から最適な映像を考えてください）'}`,
  });
  const text = await generateText({ model: model || getSettings().textModel, parts, system: SYSTEM, temperature: 0.6 });
  return text.trim();
}
