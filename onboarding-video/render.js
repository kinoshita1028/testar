// Renders index.html frame by frame with headless Chromium.
// usage: node render.js <outDir> [fps=24] [scale=1.5] [t0,t1,... to render only those stills]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const out = process.argv[2];
  const fps = +(process.argv[3] || 24), scale = +(process.argv[4] || 1.5);
  const stills = process.argv[5] ? process.argv[5].split(',').map(Number) : null;
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
  await page.goto('file://' + path.join(__dirname, 'index.html') + '?still=1');
  const total = await page.evaluate(() => FILM.total);
  const times = stills || Array.from({ length: Math.round(total * fps) }, (_, i) => i / fps);
  for (let i = 0; i < times.length; i++) {
    await page.evaluate(t => renderAt(t), times[i]);
    await page.screenshot({ path: path.join(out, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
    if (i % 200 === 0) console.log(`${i}/${times.length}`);
  }
  await browser.close();
})();
