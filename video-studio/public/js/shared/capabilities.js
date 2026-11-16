// モデルごとの機能と、添付ファイルの使い道の判定（ブラウザとサーバーで共有）

export const DEFAULT_VIDEO_MODELS = [
  { id: 'gemini-omni-1.2-flash', label: 'Gemini Omni 1.2 Flash' },
  { id: 'gemini-omni-1.1-flash', label: 'Gemini Omni 1.1 Flash' },
  { id: 'gemini-omni-flash-preview', label: 'Gemini Omni Flash (preview)' },
  { id: 'veo-3.1-generate-preview', label: 'Veo 3.1' },
  { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast' },
  { id: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite' },
  { id: 'veo-3.0-generate-001', label: 'Veo 3' },
  { id: 'veo-2.0-generate-001', label: 'Veo 2' },
];

export const DEFAULT_TEXT_MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

export const DEFAULT_TTS_MODELS = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash Lite TTS' },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS' },
  { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS' },
];

export const TTS_VOICES = [
  ['Zephyr', '明るい'], ['Puck', '軽快'], ['Charon', '知的'], ['Kore', 'しっかり'], ['Fenrir', '情熱的'],
  ['Leda', '若々しい'], ['Orus', '落ち着き'], ['Aoede', '爽やか'], ['Callirrhoe', 'おおらか'], ['Autonoe', '明るい'],
  ['Enceladus', '息づかい'], ['Iapetus', 'クリア'], ['Umbriel', 'のんびり'], ['Algieba', 'なめらか'], ['Despina', 'なめらか'],
  ['Erinome', 'クリア'], ['Algenib', 'ハスキー'], ['Rasalgethi', '説明向き'], ['Laomedeia', '快活'], ['Achernar', 'やわらか'],
  ['Alnilam', '力強い'], ['Schedar', '穏やか'], ['Gacrux', '大人っぽい'], ['Pulcherrima', '前向き'], ['Achird', '親しみ'],
  ['Zubenelgenubi', 'カジュアル'], ['Vindemiatrix', '優しい'], ['Sadachbia', '生き生き'], ['Sadaltager', '博識'], ['Sulafat', '温かい'],
];

/** モデルIDから API 方式を判定: 'veo'（predictLongRunning） / 'interactions'（Gemini Omni 等） */
export function protocolFor(modelId, override = 'auto') {
  if (override && override !== 'auto') return override;
  const m = String(modelId || '').toLowerCase();
  if (m.includes('veo')) return 'veo';
  return 'interactions';
}

export function modelProfile(modelId, settings = {}, override = 'auto') {
  const protocol = protocolFor(modelId, override);
  const m = String(modelId || '').toLowerCase();
  if (protocol === 'veo') {
    const isV2 = m.includes('veo-2');
    const isV31 = m.includes('3.1');
    const isLite = m.includes('lite');
    return {
      protocol,
      family: 'Veo',
      aspectRatios: ['16:9', '9:16'],
      durations: isV2 ? [5, 6, 7, 8] : [4, 6, 8],
      defaultDuration: 8,
      resolutions: isV2 ? ['720p'] : isV31 ? ['720p', '1080p', '4k'] : ['720p', '1080p'],
      maxReferenceImages: isV31 && !isLite ? settings.veoMaxReferenceImages || 3 : 0,
      supportsFirstFrame: true,
      supportsLastFrame: isV31 || isV2,
      supportsExtend: isV31 || isV2,
      supportsVideoInput: false,
      supportsEdit: false,
      supportsNegativePrompt: true,
      supportsPersonGeneration: true,
      maxImages: 1 + (isV31 || isV2 ? 1 : 0) + (isV31 && !isLite ? settings.veoMaxReferenceImages || 3 : 0),
      maxVideos: 0,
      acceptsText: false,
    };
  }
  return {
    protocol,
    family: 'Gemini Omni',
    aspectRatios: ['16:9', '9:16'],
    durationRange: [3, 10],
    defaultDuration: 8,
    resolutions: ['360p', '720p', '1080p', '4k'],
    maxReferenceImages: settings.omniMaxImages || 10,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsExtend: true,
    supportsVideoInput: true,
    supportsEdit: true,
    supportsNegativePrompt: false,
    supportsPersonGeneration: false,
    maxImages: settings.omniMaxImages || 10,
    maxVideos: settings.omniMaxVideos || 3,
    acceptsText: true,
  };
}

export const IMAGE_ROLES = {
  reference: '参照（人物・物・スタイル）',
  first: '最初のフレーム',
  last: '最後のフレーム',
  assist: 'プロンプト補助のみ',
};

export const VIDEO_ROLES = {
  source: '編集・延長の元動画',
  reference: '参考動画（動き・雰囲気）',
  assist: 'プロンプト補助のみ',
};

/**
 * 添付ファイルをモデルに直接渡すか、プロンプト補助（AIが読み取って指示文に反映）に回すかを決める。
 * @param {Array<{id,kind,role?,name}>} attachments
 * @returns {{ plan: Record<string,{usage:'direct'|'assist', as?:string, note:string}>, errors: string[], warnings: string[] }}
 */
export function planAttachments(profile, attachments) {
  const plan = {};
  const errors = [];
  const warnings = [];
  const count = { first: 0, last: 0, reference: 0, image: 0, video: 0 };

  for (const a of attachments) {
    const role = a.role || defaultRole(a.kind);
    let entry = { usage: 'assist', note: 'AIが内容を読み取りプロンプトに反映' };

    if (a.kind === 'image') {
      if (role === 'assist') {
        entry = { usage: 'assist', note: 'プロンプト補助のみ' };
      } else if (profile.protocol === 'veo') {
        if (role === 'first' && count.first < 1) {
          count.first++;
          entry = { usage: 'direct', as: 'first', note: '最初のフレームとして使用' };
        } else if (role === 'last' && profile.supportsLastFrame && count.last < 1) {
          count.last++;
          entry = { usage: 'direct', as: 'last', note: '最後のフレームとして使用' };
        } else if (role === 'reference' && count.reference < profile.maxReferenceImages) {
          count.reference++;
          entry = { usage: 'direct', as: 'reference', note: `参照画像 ${count.reference}/${profile.maxReferenceImages}` };
        } else {
          entry = { usage: 'assist', note: role === 'reference' && profile.maxReferenceImages === 0 ? 'このモデルは参照画像非対応 → 補助に使用' : '上限超過 → プロンプト補助に使用' };
        }
      } else {
        if (count.image < profile.maxImages) {
          count.image++;
          if (role === 'first') count.first++;
          if (role === 'last') count.last++;
          entry = { usage: 'direct', as: role, note: `${IMAGE_ROLES[role] || '参照'}（画像 ${count.image}/${profile.maxImages}）` };
        } else {
          entry = { usage: 'assist', note: `画像上限 ${profile.maxImages} 枚を超過 → プロンプト補助に使用` };
        }
      }
    } else if (a.kind === 'video') {
      if (role !== 'assist' && profile.supportsVideoInput && count.video < profile.maxVideos) {
        count.video++;
        entry = { usage: 'direct', as: role, note: role === 'source' ? '編集・延長の元動画（10秒以内推奨）' : '参考動画として使用' };
        if (a.duration && a.duration > 10.5) warnings.push(`「${a.name}」は ${a.duration.toFixed(1)} 秒あります。Omni の動画入力は 10 秒以内が目安です。`);
      } else if (role !== 'assist' && profile.protocol === 'veo') {
        entry = { usage: 'assist', note: 'Veo は任意の動画入力に非対応 → 内容をプロンプトに反映（延長は生成結果の「延長」ボタンから）' };
      } else {
        entry = { usage: 'assist', note: 'AIが内容を読み取りプロンプトに反映' };
      }
    } else if (['text', 'docx', 'pptx'].includes(a.kind)) {
      entry = profile.acceptsText
        ? { usage: 'direct', as: 'text', note: 'テキストとしてモデルに直接渡す' }
        : { usage: 'assist', note: 'AIが内容を読み取りプロンプトに反映' };
    } else if (a.kind === 'pdf' || a.kind === 'audio') {
      entry = { usage: 'assist', note: 'AIが内容を読み取りプロンプトに反映' };
    } else {
      entry = { usage: 'assist', note: '未対応の形式の可能性があります（補助に送信）' };
    }
    plan[a.id] = entry;
  }

  if (profile.protocol === 'veo') {
    if (count.last && !count.first) errors.push('Veo で「最後のフレーム」を使うには「最初のフレーム」も必要です。');
    if (count.reference && (count.first || count.last)) errors.push('Veo では参照画像と最初/最後のフレームを同時に使えません。どちらかに揃えてください。');
  }
  return { plan, errors, warnings };
}

export function defaultRole(kind) {
  if (kind === 'image') return 'reference';
  if (kind === 'video') return 'source';
  return 'assist';
}

export const ASPECT_SIZES = {
  '16:9': { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] },
  '9:16': { '480p': [480, 854], '720p': [720, 1280], '1080p': [1080, 1920], '4k': [2160, 3840] },
  '1:1': { '480p': [480, 480], '720p': [720, 720], '1080p': [1080, 1080], '4k': [2160, 2160] },
  '4:5': { '480p': [480, 600], '720p': [720, 900], '1080p': [1080, 1350], '4k': [2160, 2700] },
};

export function outputSize(aspect, resolution) {
  const a = ASPECT_SIZES[aspect] || ASPECT_SIZES['16:9'];
  return a[resolution] || a['1080p'];
}
