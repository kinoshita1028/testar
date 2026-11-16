// AI Video Studio ローカルサーバー
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { DIRS, ROOT_DIR, getSettings, isDemo, publicSettings, updateSettings } from './config.js';
import { ffmpegStatus } from './ffmpeg.js';
import { friendlyError, listModels } from './gemini.js';
import { addFromLibrary, addUploaded, deleteAttachment, getAttachmentPublic } from './attachments.js';
import { addMedia, deleteItem, getItem, listLibrary, updateItem } from './media.js';
import { deleteJob, getJob, listJobs } from './jobs.js';
import { startGeneration } from './videogen.js';
import { createPrompt } from './assist.js';
import { generateNarration, writeScript } from './narration.js';
import { FORMATS, renderProxy, startExport } from './export.js';
import { readJson, writeJson } from './util.js';
import { newProject } from '../public/js/shared/timeline-core.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

const upload = multer({ dest: DIRS.tmp, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

// 非同期ハンドラのエラーを JSON で返す
const h = (fn) => async (req, res) => {
  try {
    const r = await fn(req, res);
    if (!res.headersSent) res.json(r ?? { ok: true });
  } catch (e) {
    console.error(`[${req.method} ${req.path}]`, e?.message || e);
    if (!res.headersSent) res.status(e.status && e.status < 600 && e.status >= 400 ? e.status : 500).json({ error: friendlyError(e) });
  }
};

// ---- 状態・設定 ----
app.get('/api/status', h(() => ({ settings: publicSettings(), ffmpeg: ffmpegStatus(), demo: isDemo(), formats: FORMATS })));
app.get('/api/settings', h(() => publicSettings()));
app.put(
  '/api/settings',
  h((req) => {
    const patch = { ...req.body };
    if (patch.apiKey === '') delete patch.apiKey; // 空欄なら変更しない
    if (req.body.clearApiKey) patch.apiKey = '';
    updateSettings(patch);
    return publicSettings();
  }),
);
app.get('/api/models', h((req) => listModels({ refresh: req.query.refresh === '1' })));

// ---- 添付ファイル（生成の指示用） ----
app.post(
  '/api/attachments',
  upload.array('files', 50),
  h(async (req) => {
    const out = [];
    for (const f of req.files || []) out.push(await addUploaded(f));
    return { attachments: out };
  }),
);
app.post('/api/attachments/from-library/:itemId', h((req) => ({ attachment: addFromLibrary(req.params.itemId) })));
app.get('/api/attachments/:id', h((req) => getAttachmentPublic(req.params.id) || Promise.reject(Object.assign(new Error('not found'), { status: 404 }))));
app.delete('/api/attachments/:id', h((req) => ({ ok: deleteAttachment(req.params.id) })));

// ---- ライブラリ ----
app.get('/api/library', h(() => ({ items: listLibrary() })));
app.post(
  '/api/library/import',
  upload.array('files', 50),
  h(async (req) => {
    const items = [];
    const errors = [];
    for (const f of req.files || []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        items.push(await addMedia(f.path, { name, source: 'upload', move: true, mimeType: f.mimetype }));
      } catch (e) {
        fs.rm(f.path, { force: true }, () => {});
        errors.push(e.message);
      }
    }
    return { items, errors };
  }),
);
app.patch('/api/library/:id', h((req) => ({ item: updateItem(req.params.id, req.body || {}) })));
app.delete('/api/library/:id', h((req) => ({ ok: deleteItem(req.params.id) })));

// ---- 動画生成 ----
app.post('/api/generate', h((req) => ({ job: startGeneration(req.body || {}) })));
app.get('/api/jobs', h((req) => ({ jobs: listJobs(req.query.type) })));
app.get('/api/jobs/:id', h((req) => ({ job: getJob(req.params.id) })));
app.delete('/api/jobs/:id', h((req) => ({ ok: deleteJob(req.params.id) })));

// ---- プロンプト作成支援 ----
app.post(
  '/api/assist/prompt',
  h(async (req) => {
    const b = req.body || {};
    const { getAttachment } = await import('./attachments.js');
    const attachments = (b.attachments || [])
      .map((r) => {
        const a = getAttachment(r.id);
        return a ? { ...a, role: r.role, roleLabel: r.roleLabel, note: r.note } : null;
      })
      .filter(Boolean);
    return { result: await createPrompt({ ...b, attachments }) };
  }),
);

// ---- ナレーション ----
app.post(
  '/api/narration/script',
  h(async (req) => {
    const b = req.body || {};
    const script = await writeScript({
      duration: b.duration,
      language: b.language,
      style: b.style,
      instruction: b.instruction,
      model: b.model,
      clipItemId: b.analyze && b.target === 'clip' ? b.clipItemId : undefined,
      clipIn: b.clipIn,
      renderTimeline: b.analyze && b.target === 'timeline' && b.project ? () => renderProxy(b.project) : undefined,
    });
    return { script };
  }),
);
app.post('/api/narration/generate', h(async (req) => generateNarration(req.body || {})));

// ---- プロジェクト ----
const PROJECT_FILE = path.join(DIRS.data, 'project.json');
app.get('/api/project', h(() => ({ project: readJson(PROJECT_FILE, null) || newProject() })));
app.put(
  '/api/project',
  h((req) => {
    if (!req.body?.project) throw Object.assign(new Error('project がありません'), { status: 400 });
    writeJson(PROJECT_FILE, req.body.project);
    return { ok: true };
  }),
);

// ---- 書き出し ----
app.post('/api/export', h((req) => ({ job: startExport(req.body.project, req.body.options || {}) })));

// ---- 静的ファイル ----
app.use('/media', express.static(DIRS.media, { maxAge: '1h' }));
app.use('/uploads', express.static(DIRS.uploads, { maxAge: '1h' }));
app.get('/exports/:file', (req, res) => {
  const file = path.join(DIRS.exports, path.basename(req.params.file));
  if (!fs.existsSync(file)) return res.status(404).send('not found');
  if (req.query.download === '1') return res.download(file);
  res.sendFile(file);
});
app.use(express.static(path.join(ROOT_DIR, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: `不明な API: ${req.method} ${req.path}` }));

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const URL_ = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

/** 起動したらブラウザを自動で開く（NO_OPEN=1 で無効） */
function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.argv.includes('--no-open')) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ブラウザを開けない環境 */
  }
}

const server = app.listen(PORT, HOST, () => {
  const ff = ffmpegStatus();
  console.log('');
  console.log('  🎬 AI Video Studio を起動しました');
  console.log(`  → ブラウザで ${URL_} を開いてください（自動で開きます）`);
  console.log(`  ffmpeg: ${ff.ffmpeg.path ? ff.ffmpeg.version : '見つかりません（書き出しには ffmpeg が必要です）'}`);
  console.log(`  APIキー: ${publicSettings().hasApiKey ? '設定済み' : '未設定（画面の「設定」から入力）'}${isDemo() ? ' / デモモード ON' : ''}`);
  console.log(`  既定の動画モデル: ${getSettings().videoModel}`);
  console.log('');
  console.log('  ※ 使っている間はこの画面を閉じないでください。終了するときはこの画面を閉じます。');
  console.log('');
  openBrowser(URL_);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  すでに起動しています（またはポート ${PORT} が使用中です）。ブラウザで ${URL_} を開きます。\n`);
    openBrowser(URL_);
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error(e);
    process.exit(1);
  }
});
