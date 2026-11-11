// 拡張機能の結合テスト: 模擬サーバーを立て、ポップアップ表示→確認→ログ送信→再表示までを確認する
//   実行: node tests/e2e.mjs
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const ext = path.resolve(new URL('../extension', import.meta.url).pathname);
const now = Date.now();
const notices = [
  { id: 'N1', title: '避難訓練の実施について', body: '本日10時より実施します。\n職員は園庭に集合してください。', url: 'https://example.com/doc',
    startAt: now - 60e3, endAt: null, unit: 'none', interval: 1, weekdays: [], remindMin: 0 },
  { id: 'N2', title: '未来の通知', body: '', url: '', startAt: now + 3600e3, endAt: null, unit: 'none', interval: 1, weekdays: [], remindMin: 0 },
];
const requests = [];
const acks = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { acks.push(JSON.parse(body)); return res.end('{"ok":true}'); }
    requests.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get('key') !== 'secret') return res.end('{"ok":false,"error":"APIキーが正しくありません"}');
    res.end(JSON.stringify({ ok: true, user: { email: url.searchParams.get('email'), name: '山田', schools: ['ひまわり保育園'] }, notices }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}/exec`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const waitPopup = () => ctx.waitForEvent('page', { predicate: (p) => p.url().includes('popup.html'), timeout: 15000 });

  // 1) 誤ったAPIキー → エラー表示
  const status = await ctx.newPage();
  await status.goto(`chrome-extension://${extId}/status.html`);
  await status.locator('summary').click();
  await status.fill('#apiUrl', apiUrl);
  await status.fill('#apiKey', 'wrong');
  await status.fill('#testEmail', 'Encho@Example.com');
  await status.click('#save');
  await status.waitForFunction(() => document.getElementById('state').textContent.includes('APIキー'));

  // 2) 正しい設定 → 到来済みの通知だけポップアップ
  const popupP = waitPopup();
  await status.fill('#apiKey', 'secret');
  await status.click('#save');
  const popup = await popupP;
  await popup.waitForSelector('#title:not(:empty)');
  assert.equal(await popup.textContent('#title'), '避難訓練の実施について');
  assert.match(await popup.textContent('#body'), /園庭に集合/);
  assert.equal(await popup.getAttribute('#link', 'href'), 'https://example.com/doc');
  assert.equal(requests.at(-1).email, 'encho@example.com');
  await status.waitForFunction(() => document.getElementById('state').textContent.includes('正常'));
  assert.match(await status.textContent('#school'), /ひまわり保育園/);
  await popup.screenshot({ path: path.join(profile, 'popup.png') });
  console.log('screenshot:', path.join(profile, 'popup.png'));
  assert.equal(ctx.pages().filter((p) => p.url().includes('popup.html')).length, 1, '未来の通知は表示しない');

  // 3) 再同期しても同じ通知は二重表示しない
  await status.click('#sync');
  await status.waitForFunction(() => document.getElementById('state').textContent.includes('正常'));
  assert.equal(ctx.pages().filter((p) => p.url().includes('popup.html')).length, 1);

  // 4) 「確認しました」→ ウィンドウが閉じ、確認ログが送信される
  const closed = popup.waitForEvent('close');
  await popup.click('#ack');
  await closed;
  await assertEventually(() => acks.length === 1);
  assert.deepEqual({ ...acks[0] }, { action: 'ack', key: 'secret', email: 'encho@example.com', id: 'N1', occurrence: notices[0].startAt });
  await status.click('#sync');
  await status.waitForFunction(() => document.getElementById('state').textContent.includes('正常'));
  assert.equal(ctx.pages().filter((p) => p.url().includes('popup.html')).length, 0, '確認済みは再表示しない');

  // 5) 本部が日時を変更（＝再配信）→ もう一度表示。未確認で閉じ、再表示設定があれば再度表示
  notices[0] = { ...notices[0], startAt: Date.now() - 1000, remindMin: 1 };
  const again = waitPopup();
  await status.click('#sync');
  const p2 = await again;
  await p2.close();
  await assertEventuallyAsync(() => sw.evaluate(async () =>
    Object.keys((await chrome.storage.session.get('winMap')).winMap || {}).length === 0));
  await sw.evaluate(async () => { // 1分経過を模擬
    const { state } = await chrome.storage.local.get('state');
    state.N1.shownAt -= 61e3;
    await chrome.storage.local.set({ state });
  });
  const reminded = waitPopup();
  await status.click('#sync');
  await reminded;
  assert.equal(acks.length, 1);
  console.log('E2E OK');
} finally {
  await ctx.close();
  server.close();
}

async function assertEventually(fn, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout: ' + fn);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function assertEventuallyAsync(fn, ms = 5000) {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout: ' + fn);
    await new Promise((r) => setTimeout(r, 100));
  }
}
