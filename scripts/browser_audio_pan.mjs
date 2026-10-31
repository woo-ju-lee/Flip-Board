// Test-only spatial audio checks against the production app and native panners.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAudioProbe } from './audio_probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.KORAIL_ARTIFACT_DIR ? resolve(process.env.KORAIL_ARTIFACT_DIR)
  : resolve(root, 'artifacts/audio-continuity/regressions');
await mkdir(out, { recursive: true });
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const scenarios = [];
const errors = [];
const settled = () => [...document.querySelectorAll('.rows .flap')].length > 0
  && [...document.querySelectorAll('.rows .flap')].every(cell => cell.dataset.flipping === 'false'
    && (cell.classList.contains('flap-panel')
      ? cell.querySelector(':scope > .flap-top').innerHTML === cell.querySelector(':scope > .flap-bottom').innerHTML
        && (!cell.dataset.value || Boolean(cell.querySelector(':scope > .flap-top .train-logo-art')))
      : cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value));

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on('pageerror', error => errors.push(error.message));
  await installAudioProbe(page);
  await page.goto(`${base}/?source=archive&renderer=optimized`);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(settled, undefined, { timeout: 22000 });
  const snapshot = await (await page.request.get(`${base}/api/trains?source=archive&archive=141536`)).json();
  const train = snapshot.trains.find(train => train.number === '35');
  assert.equal(train.delay_minutes, 3);
  await page.route('**/api/trains?**', route => route.fulfill({ json: snapshot }));
  const digit = page.getByRole('row', { name: / 35,/ }).locator('.delay-cell .flap').nth(1);
  await digit.evaluate(element => { __flapAudioProbe.panReference = element; });
  await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
  await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();

  const geometry = () => digit.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, width: rect.width, viewportWidth: innerWidth, scrollX,
      fullscreen: Boolean(document.fullscreenElement),
      expectedPan: Math.max(-.85, Math.min(.85, (rect.left + rect.width / 2) / Math.max(1, innerWidth) * 2 - 1)) };
  });
  const run = async (name, mutate = async () => {}, beforeOverride) => {
    const before = beforeOverride || await geometry();
    await mutate();
    train.delay_minutes++;
    await page.evaluate(() => {
      __flapAudioProbe.starts = [];
      __flapAudioProbe.beginAnimationAudit();
      document.querySelector('[aria-label="서버 캐시 다시 조회"]').click();
    });
    await page.waitForFunction(value => {
      const cell = __flapAudioProbe.panReference;
      return cell.dataset.value === String(value) && cell.dataset.flipping === 'false'
        && cell.querySelector(':scope > .flap-top > span').textContent === String(value)
        && cell.querySelector(':scope > .flap-bottom > span').textContent === String(value)
        && __flapAudioProbe.starts.length > 0;
    }, train.delay_minutes);
    await page.waitForTimeout(180);
    const { voices, audit } = await page.evaluate(() => ({ voices: __flapAudioProbe.starts,
      audit: __flapAudioProbe.animationAudit }));
    const result = { name, from: train.delay_minutes - 1, to: train.delay_minutes, before, voices, audit };
    scenarios.push(result);
    await writeFile(`${out}/audio-pan-progress.json`, JSON.stringify({ status: 'running', scenarios }, null, 2));
    assert.equal(voices.length, 1, `${name}: one digit must produce one native source`);
    const voice = voices[0];
    assert.equal(typeof voice.pan, 'number', 'Probe must find the actual connected StereoPannerNode');
    assert.ok(Math.abs(voice.pan - voice.panReference.expectedPan) <= 1e-6, JSON.stringify(result));
    if (name !== 'baseline') {
      const changed = Math.abs(voice.panReference.left - before.left) > 1
        || Math.abs(voice.panReference.width - before.width) > 1
        || voice.panReference.viewportWidth !== before.viewportWidth;
      assert.ok(changed, `${name} must exercise changed cell geometry`);
    }
    assert.ok(audit.firstNativeSource && audit.firstAnimation, JSON.stringify(result));
    assert.ok(audit.firstNativeSource.at <= audit.firstAnimation.at
      && audit.firstAnimation.nativeSourcesBeforeAnimation === 1, JSON.stringify(result));
    assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
    console.log(JSON.stringify({ name, pan: voice.pan, expectedPan: voice.panReference.expectedPan,
      beforePan: before.expectedPan, geometry: voice.panReference }));
  };

  await run('baseline');
  await run('viewport-resize', () => page.setViewportSize({ width: 1360, height: 1080 }));
  await run('fullscreen', async () => {
    await page.getByRole('button', { name: '전체 화면', exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
  });
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await run('ancestor-transform', () => page.evaluate(() => {
    document.querySelector('.app-shell').style.transform = 'translateX(-96px)';
  }));

  // Force a real horizontal scroll while keeping the changed digit in view.
  await page.evaluate(() => { document.body.style.minWidth = '1800px'; });
  await page.waitForTimeout(50);
  await run('horizontal-scroll', async () => {
    await page.evaluate(() => window.scrollTo({ left: 440, top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => scrollX > 100);
  });

  // A delayed font changes a ch-based transform without changing attributes or
  // observed box sizes after it loads. This exercises the font completion event.
  const fontBytes = await readFile(resolve(root, 'frontend/src/assets/fonts/IBMPlexSansKR-Regular.woff2'));
  let pendingFontRoute;
  await page.route('**/__pan_test_font.woff2', route => { pendingFontRoute = route; });
  await page.evaluate(() => {
    window.__panFontEvents = 0;
    document.fonts.addEventListener('loadingdone', () => { window.__panFontEvents++; });
    const font = new FontFace('PanProbeFont', 'url(/__pan_test_font.woff2)', { display: 'swap' });
    document.fonts.add(font);
    const container = document.querySelector('.app-shell');
    container.style.fontFamily = 'PanProbeFont, monospace';
    container.style.transform = 'translateX(-100ch)';
    window.__panFontLoaded = document.fonts.load('14px PanProbeFont');
  });
  await page.waitForTimeout(100); // Cache the fallback-font geometry before loading completes.
  assert.ok(pendingFontRoute, 'The font must actually request and wait for bytes');
  const beforeFont = await geometry();
  await run('font-completion', async () => {
    await pendingFontRoute.fulfill({ body: fontBytes, contentType: 'font/woff2' });
    await page.evaluate(async () => { await window.__panFontLoaded; await document.fonts.ready; });
    assert.ok(await page.evaluate(() => window.__panFontEvents > 0), 'Exercise a real FontFaceSet loadingdone event');
  }, beforeFont);
  assert.deepEqual(errors, []);
  const report = { status: 'passed', browser: await browser.version(), base,
    reference: 'Actual connected StereoPannerNode.pan at native source.start versus changed leaf bounds read after the engine assigned its pan; clamp±0.85, tolerance1e-6 for Float32 AudioParam rounding',
    checks: ['One impact for each single-digit update', 'Native booking precedes first WAAPI',
      'Viewport, fullscreen, ancestor transform, horizontal scroll, and actual font completion invalidate cached spatial geometry'],
    scenarios, pageErrors: errors };
  await writeFile(`${out}/audio-pan-validation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: `${out}/audio-pan-validation.json`, scenarios: scenarios.length }));
} catch (error) {
  await writeFile(`${out}/audio-pan-progress.json`, JSON.stringify({ status: 'failed', error: String(error), scenarios, pageErrors: errors }, null, 2));
  throw error;
} finally { await browser.close(); }
