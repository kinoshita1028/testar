// プレビューを Playwright で開いて、主要な画面と操作を確認する
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'preview');
const url = 'file://' + path.join(root, 'preview', 'index.html');
const browser = await chromium.launch();
const errors = [];
async function page(viewport, scale = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const p = await ctx.newPage();
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.goto(url);
  await p.waitForSelector('table.roster, table.tl, .hq-cards', { timeout: 15000 });
  return p;
}
const shot = async (p, name) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(out, name + '.png') }); };
const p = await page({ width: 1180, height: 820 });
await p.waitForTimeout(400);
await shot(p, '01-month');
await p.click('[data-act=view][data-view=week]'); await p.waitForSelector('table.roster.week'); await p.waitForTimeout(300);
await shot(p, '02-week');
await p.click('[data-act=view][data-view=day]'); await p.waitForSelector('table.tl'); await p.waitForTimeout(300);
await shot(p, '03-day');
// 編集
await p.click('[data-act=view][data-view=month]'); await p.waitForSelector('table.roster.month');
const cell = p.locator('button.cell').nth(40);
await cell.click();
await p.waitForSelector('.modal');
await shot(p, '04-editor');
await p.click('.modal [data-pat="遅番"]');
await p.click('.modal [data-save]');
await p.waitForSelector('.modal-head h2:has-text("入力する人")');
await p.click('.modal [data-name]');
await p.waitForTimeout(800);
await shot(p, '05-after-save');
// 承認依頼 → 承認
await p.click('[data-act=request]'); await p.waitForSelector('.modal [data-ok]');
await shot(p, '06-request');
await p.click('.modal [data-ok]'); await p.waitForTimeout(800);
await p.click('[data-act=approve]'); await p.waitForSelector('.modal .acc');
await p.click('.modal .acc >> nth=0');
for (const k of ['1','1','1','1']) await p.click(`.modal [data-key="${k}"]`);
await shot(p, '07-login');
await p.click('.modal [data-ok]'); await p.waitForSelector('.modal [data-ok]:has-text("承認印")');
await shot(p, '08-approve');
await p.click('.modal [data-ok]'); await p.waitForTimeout(500);
await shot(p, '09-stamped');
await p.waitForTimeout(1200);
// かんたん入力
await p.click('[data-act=quick]'); await p.waitForSelector('.quickbar');
await p.click('.quickbar [data-name="早番"]');
await p.locator('button.cell.empty').first().click();
await p.locator('button.cell').nth(60).click();
await shot(p, '13-quick');
await p.waitForTimeout(1500);
await p.click('.quickbar [data-act=quick]');
// 集計・配置基準
await p.click('[data-act=menu]'); await p.click('.modal [data-m=summary]'); await p.waitForSelector('.modal table.plain');
await shot(p, '14-summary');
await p.click('.modal [data-close]');
await p.click('[data-act=menu]'); await p.click('.modal [data-m=rules]'); await p.waitForSelector('.modal h3');
await shot(p, '15-rules');
await p.click('.modal-foot [data-close]');
await p.click('[data-act=menu]'); await p.click('.modal [data-m=history]'); await p.waitForSelector('.modal table.plain');
await shot(p, '16-history');
await p.click('.modal-foot [data-close]');
// ひまわり保育園の日表示
await p.selectOption('[data-change=facility]', 'E02');
await p.waitForSelector('table.roster.month');
await p.click('[data-act=view][data-view=day]'); await p.waitForSelector('table.tl');
await shot(p, '17-e02-day');
await p.click('[data-act=view][data-view=month]'); await p.waitForSelector('table.roster.month');
// 本部
await p.click('[data-act=page][data-page=hq]'); await p.waitForSelector('.hq-cards'); await p.waitForTimeout(300);
await shot(p, '10-hq-month');
await p.click('[data-act=hqview][data-view=week]'); await p.waitForSelector('table.cmp.week'); await p.waitForTimeout(300);
await shot(p, '11-hq-week');
await p.click('[data-act=hqview][data-view=day]'); await p.waitForSelector('.hq-day'); await p.waitForTimeout(300);
await shot(p, '12-hq-day');
// スマホ・PC
const ph = await page({ width: 390, height: 844 });
await ph.waitForTimeout(300); await shot(ph, '20-phone');
const pc = await page({ width: 1600, height: 1000 });
await pc.waitForTimeout(300); await shot(pc, '21-pc');
const tp = await page({ width: 820, height: 1180 });
await tp.waitForTimeout(300); await shot(tp, '22-tablet-portrait');
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
