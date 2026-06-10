'use strict';
/* Visual smoke test: drives the game in headless chromium and captures
 * screenshots at each phase. Run: node test/screenshots.js [outDir]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = process.argv[2] || path.join(__dirname, '..', '.shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '1-world.png') });

  // pick two adjacent nations via the game's own API
  const picked = await page.evaluate(() => {
    const g = window.__game;
    const b = g.state.world.borders.find(x => x.a >= 0 && x.b >= 0
      && g.state.world.countries[x.a].cellCount > 60
      && g.state.world.countries[x.b].cellCount > 60)
      || g.state.world.borders.find(x => x.a >= 0 && x.b >= 0);
    g.toggleAlleg(b.a);
    g.toggleAlleg(b.b); g.toggleAlleg(b.b);
    return {
      a: g.state.world.countries[b.a].name,
      b: g.state.world.countries[b.b].name,
      ok: g.canStartWar().ok,
    };
  });
  console.log('picked:', JSON.stringify(picked));
  if (!picked.ok) throw new Error('cannot start war in browser');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '2-sides-picked.png') });

  await page.click('#btn-war');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '3-war-early.png') });

  // close-ups of the fluctuating front, a few seconds apart
  const clip = await page.evaluate(() => {
    const g = window.__game;
    const canvas = document.getElementById('map');
    const r = canvas.getBoundingClientRect();
    const scale = r.width / g.W;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const b of g.state.war.fronts) {
      for (const vi of b.verts) {
        const v = g.state.world.verts[vi];
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
    }
    const pad = 60;
    return {
      x: r.left + Math.max(0, (minX - pad)) * scale,
      y: r.top + Math.max(0, (minY - pad)) * scale,
      width: Math.min(g.W, maxX - minX + 2 * pad) * scale,
      height: Math.min(g.H, maxY - minY + 2 * pad) * scale,
    };
  });
  for (let i = 0; i < 3; i++) {
    await page.screenshot({ path: path.join(OUT, `front-closeup-${i}.png`), clip });
    await page.waitForTimeout(2500);
  }

  // crank speed to 8x and let the war develop
  await page.click('#speeds .spd[data-speed="8"]');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, '4-war-mid.png') });

  // wait for the war to end (max 90s at 8x = ~1440 days >> armistice)
  await page.waitForFunction(() => !window.__game.state.war, null, { timeout: 90000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '5-postwar.png') });

  const result = await page.evaluate(() => ({
    result: window.__game.state.lastWar.result,
    day: Math.floor(window.__game.state.lastWar.day),
    logTop: document.querySelector('#log li') && document.querySelector('#log li').textContent,
  }));
  console.log('war result:', JSON.stringify(result));

  if (errors.length) {
    console.error('PAGE ERRORS:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('no page errors. screenshots in ' + OUT);
  }
  await browser.close();
})();
