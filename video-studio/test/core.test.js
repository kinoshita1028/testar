// node --test test/  （ffmpeg を使った書き出しと、添付ルールのテスト）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vstudio-test-'));
const { runFfmpeg, probe } = await import('../server/ffmpeg.js');
const { addMedia } = await import('../server/media.js');
const { renderTimeline } = await import('../server/export.js');
const { planAttachments, modelProfile } = await import('../public/js/shared/capabilities.js');
const { layoutProject } = await import('../public/js/shared/timeline-core.js');

async function makeClip(name, seconds, withAudio = true) {
  const out = path.join(process.env.DATA_DIR, name);
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []), out);
  await runFfmpeg(args);
  return addMedia(out, { source: 'upload', move: true });
}

test('タイムラインを MP4 に書き出せる（トリム・無音クリップ・ナレーション重ね）', async () => {
  const a = await makeClip('a.mp4', 4);
  const b = await makeClip('b.mp4', 3, false);
  const n = await makeClip('n.mp4', 2);
  const project = {
    name: 'test', aspectRatio: '9:16', resolution: '480p', fps: 24,
    videoClips: [
      { id: 'c1', itemId: a.id, in: 1, out: 3.5, volume: 1, fadeIn: 0.5 },
      { id: 'c2', itemId: b.id, in: 0, out: 3, muted: true },
    ],
    audioTracks: [{ id: 't', name: 'n', kind: 'narration', clips: [{ id: 'x', itemId: n.id, in: 0, out: 2, start: 0, anchorClipId: 'c2', offset: 0.5 }] }],
  };
  const lay = layoutProject(project, { [a.id]: a, [b.id]: b, [n.id]: n });
  assert.equal(lay.duration, 5.5);
  assert.equal(lay.audio[0].start, 3);
  const r = await renderTimeline(project, { format: 'mp4', quality: 'light' });
  const info = await probe(r.file);
  assert.ok(Math.abs(info.duration - 5.5) < 0.15, `duration ${info.duration}`);
  assert.equal(info.width, 480);
  assert.equal(info.height, 854);
  assert.ok(info.hasAudio);
});

test('Veo: 参照画像と最初のフレームは同時に使えない', () => {
  const prof = modelProfile('veo-3.1-generate-preview');
  const { errors } = planAttachments(prof, [
    { id: '1', kind: 'image', role: 'first', name: 'a' },
    { id: '2', kind: 'image', role: 'reference', name: 'b' },
  ]);
  assert.equal(errors.length, 1);
});

test('Omni: 上限を超えた画像・PDF・音声はプロンプト補助に回る', () => {
  const prof = modelProfile('gemini-omni-1.2-flash', { omniMaxImages: 2 });
  const atts = [1, 2, 3].map((i) => ({ id: `i${i}`, kind: 'image', role: 'reference', name: `${i}` }));
  atts.push({ id: 'p', kind: 'pdf', name: 'doc' }, { id: 's', kind: 'audio', name: 'bgm' }, { id: 't', kind: 'text', name: 'memo' });
  const { plan } = planAttachments(prof, atts);
  assert.equal(plan.i1.usage, 'direct');
  assert.equal(plan.i2.usage, 'direct');
  assert.equal(plan.i3.usage, 'assist');
  assert.equal(plan.p.usage, 'assist');
  assert.equal(plan.s.usage, 'assist');
  assert.equal(plan.t.usage, 'direct');
});
