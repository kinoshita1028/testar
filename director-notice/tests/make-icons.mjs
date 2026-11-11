// アイコンPNGを生成する（開発時のみ使用）: node tests/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#c5221f"/><path fill="#fff" d="M64 22c-4 0-7 3-7 7v3c-14 3-23 15-23 30v20l-8 9v5h76v-5l-8-9V62c0-15-9-27-23-30v-3c0-4-3-7-7-7zm-11 80a11 11 0 0 0 22 0z"/></svg>`;
const browser = await chromium.launch();
for (const size of [16, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body>`);
  await page.screenshot({ path: new URL(`../extension/icons/icon${size}.png`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
