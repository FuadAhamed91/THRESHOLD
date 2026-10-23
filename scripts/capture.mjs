// Headless capture of the THRESHOLD experience (README screenshots and visual QA).
//
//   node scripts/capture.mjs --url "http://localhost:5173/?autostart=1" --out docs/screens --every 3 --count 12
//   node scripts/capture.mjs --explore --shots hero,analysis,cutaway,plan --out docs/screens
//
// Uses Playwright's Chromium with the real GPU. The dev server must be running
// (npm run dev); it relies on the dev-only window.__THRESHOLD__ debug hook.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const url = opt('url', 'http://localhost:5173/?autostart=1');
const out = opt('out', 'docs/screens');
const every = Number(opt('every', '3'));
const count = Number(opt('count', '10'));
const prefix = opt('prefix', 'tour');
const width = Number(opt('width', '1440'));
const height = Number(opt('height', '900'));
const setup = opt('setup', '');
const ext = opt('format', 'png') === 'jpg' ? 'jpg' : 'png';
const shot = (path) => page.screenshot({ path, timeout: 60000, ...(ext === 'jpg' ? { quality: 84 } : {}) });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('502')) console.log('[console:error]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => {
    const t = window.__THRESHOLD__;
    if (!t) return false;
    const s = t.useThreshold.getState();
    return s.sceneReady || !!s.webglError;
  },
  undefined,
  { timeout: 90000, polling: 250 },
);
const t0 = Date.now();
await page.evaluate(() => {
  const { useThreshold } = window.__THRESHOLD__;
  const start = performance.now();
  window.__phaseLog = [`0.0s ${useThreshold.getState().phase}`];
  useThreshold.subscribe(
    (s) => s.phase,
    (p) => window.__phaseLog.push(`${((performance.now() - start) / 1000).toFixed(1)}s ${p}`),
  );
});
if (setup) await page.evaluate(setup);

const state = () =>
  page.evaluate(() => {
    const s = window.__THRESHOLD__.useThreshold.getState();
    return { phase: s.phase, status: s.analysis?.status, clearance: s.analysis?.clearance.width, error: s.webglError };
  });

if (flag('explore')) {
  const shots = opt('shots', 'hero,delivery,analysis,cutaway,plan,resolution').split(',');
  await page.evaluate(() => window.__THRESHOLD__.runtime.director.enterExplore());
  await page.waitForTimeout(2500);
  for (const id of shots) {
    await page.evaluate(async (id) => {
      const { runtime, useThreshold } = window.__THRESHOLD__;
      useThreshold.setState({ shot: id, cameraMode: 'manual' });
      await runtime.exp.flyTo(id, 0.01);
    }, id);
    await page.waitForTimeout(1500);
    const file = join(out, `${prefix}-${id}.${ext}`);
    await shot(file);
    console.log(file, JSON.stringify(await state()));
  }
} else {
  for (let i = 0; i < count; i++) {
    const due = t0 + (i + 1) * every * 1000;
    await page.waitForTimeout(Math.max(0, due - Date.now()));
    const file = join(out, `${prefix}-${String(i).padStart(2, '0')}.${ext}`);
    await shot(file);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, file, JSON.stringify(await state()));
  }
}
console.log('phase log:', await page.evaluate(() => window.__phaseLog));
await browser.close();
