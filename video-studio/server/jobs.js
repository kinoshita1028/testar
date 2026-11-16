// 非同期ジョブ（動画生成・書き出し）の管理
import path from 'node:path';
import { DIRS } from './config.js';
import { newId, readJson, writeJson } from './util.js';

const FILE = path.join(DIRS.data, 'jobs.json');
const jobs = new Map();

for (const j of readJson(FILE, [])) {
  if (j.status === 'running' || j.status === 'queued') {
    j.status = 'error';
    j.error = 'サーバーの再起動により中断されました';
  }
  jobs.set(j.id, j);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...jobs.values()].filter((j) => j.type === 'generate').slice(-200);
    writeJson(FILE, list);
  }, 500);
}

export function createJob(type, data = {}) {
  const job = {
    id: newId('j_'),
    type,
    status: 'queued',
    progress: 0,
    message: '待機中',
    logs: [],
    createdAt: new Date().toISOString(),
    ...data,
  };
  jobs.set(job.id, job);
  scheduleSave();
  return job;
}

export function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  scheduleSave();
  return job;
}

export function logJob(job, message) {
  job.logs.push({ t: new Date().toISOString(), message });
  if (job.logs.length > 100) job.logs.shift();
  job.message = message;
  scheduleSave();
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(type) {
  return [...jobs.values()].filter((j) => !type || j.type === type).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteJob(id) {
  const ok = jobs.delete(id);
  scheduleSave();
  return ok;
}

/** ジョブを非同期に実行する */
export function runJob(job, fn) {
  updateJob(job, { status: 'running', startedAt: new Date().toISOString() });
  Promise.resolve()
    .then(() => fn(job))
    .then((result) => updateJob(job, { status: 'done', progress: 1, message: '完了', finishedAt: new Date().toISOString(), ...(result || {}) }))
    .catch((e) => {
      console.error(`[job ${job.id}]`, e);
      updateJob(job, { status: 'error', error: e?.userMessage || e?.message || String(e), finishedAt: new Date().toISOString() });
    });
  return job;
}
