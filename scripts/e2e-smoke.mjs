// End-to-end smoke test against the running dev server (npm run dev), real GPU.
// Loads the experience, enters explore mode, drags the parcel with real mouse
// events onto the safe drop zone and asserts the geometry engine's verdict flips
// from obstructed to clear.
//   node scripts/e2e-smoke.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => window.__THRESHOLD__?.useThreshold.getState().sceneReady, undefined, { timeout: 120000, polling: 100 });
console.log('✓ scene ready');

await page.evaluate(async () => {
  const { runtime, useThreshold } = window.__THRESHOLD__;
  runtime.director.enterExplore();
  useThreshold.setState({ shot: 'plan', cameraMode: 'manual' });
  await runtime.exp.flyTo('plan', 0.01);
});
await page.waitForTimeout(1500);

const state = () =>
  page.evaluate(() => {
    const s = window.__THRESHOLD__.useThreshold.getState();
    return {
      status: s.analysis?.status,
      door: s.analysis ? Math.round((s.analysis.door.maxOpening * 180) / Math.PI) : null,
      clearance: s.analysis?.clearance.width ?? null,
      route: s.analysis?.path.found ?? null,
      source: s.placement.source,
    };
  });
const project = (x, y, z) =>
  page.evaluate(
    async ([x, y, z]) => {
      const { runtime } = window.__THRESHOLD__;
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const v = new THREE.Vector3(x, y, z).project(runtime.exp.camera);
      const r = runtime.exp.canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    [x, y, z],
  );

const before = await state();
if (before.status !== 'obstructed' || before.route !== false) fail(`expected scenario A to start obstructed, got ${JSON.stringify(before)}`);
else console.log(`✓ scenario A obstructed: door ${before.door}°, clearance ${before.clearance.toFixed(2)} m`);

const from = await project(0.12, 0.46, 0.55);
const to = await project(-1.22, 0.46, 0.62);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 24; i++) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / 24, from.y + ((to.y - from.y) * i) / 24);
  await page.waitForTimeout(25);
}
await page.mouse.up();
await page.waitForTimeout(800);

const after = await state();
if (after.status !== 'clear' || !after.route || after.door !== 90) fail(`expected clear after drag, got ${JSON.stringify(after)}`);
else console.log(`✓ dragged to safe zone → clear: door ${after.door}°, clearance ${after.clearance.toFixed(2)} m, source ${after.source}`);
if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
if (!process.exitCode) console.log('✓ e2e smoke passed');
