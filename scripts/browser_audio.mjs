// Real AudioContext/MP3/output checks against the production build, not mocks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const checks = [];
let singleCharacter;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await installAudioProbe(page);
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/audio/')) requests.push(r.url()); });
  const state = () => page.evaluate(() => ({ starts: __flapAudioProbe.starts.length, active: __flapAudioProbe.active.size,
    maxActive: __flapAudioProbe.maxActive, peak: __flapAudioProbe.peak() }));
  const quiet = async () => {
    await page.waitForTimeout(180);
    const result = await state();
    assert.equal(result.active, 0);
    assert.ok(result.peak < .00001, `output did not become silent: ${result.peak}`);
    return result.starts;
  };
  await page.goto(`${base}/?source=archive`);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.waitForTimeout(2300);
  assert.equal(await page.evaluate(() => __flapAudioProbe.contexts.length), 0);
  assert.deepEqual(requests, []);
  checks.push('Muted startup creates no audio context and fetches no sound');

  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  assert.equal(requests.filter(url => url.endsWith('vestaboard-flip.mp3')).length, 1);
  await page.getByRole('button', { name: '소리 끄기' }).click();
  await page.getByLabel('사운드 설정', { exact: true }).click();
  await page.evaluate(() => __flapAudioProbe.startRecording());
  await page.getByRole('button', { name: '소리 미리듣기' }).click();
  await page.getByRole('button', { name: '미리듣기 정지' }).waitFor();
  await page.waitForTimeout(500);
  const playing = await state();
  assert.ok(playing.starts > 0 && playing.peak > .0001);
  await page.getByRole('button', { name: '소리 미리듣기' }).waitFor();
  await quiet();
  const preview = await page.evaluate(() => __flapAudioProbe.stopRecording());
  await writeFile(`${out}/flap-preview.webm`, Buffer.from(preview));
  assert.equal(await page.getByRole('button', { name: '소리 켜기' }).getAttribute('aria-pressed'), 'false');
  checks.push('Actual bundled MP3 decodes and produces recorded preview output while the board remains muted');

  // A test-only change to one delay digit in the archived response. No upstream writes.
  const response = await page.request.get(`${base}/api/trains?source=archive&archive=141536`);
  const singleChange = await response.json();
  const train = singleChange.trains.find(train => train.number === '35');
  assert.equal(train.delay_minutes, 3);
  train.delay_minutes = 4;
  const oneDigitRoute = route => route.fulfill({ json: singleChange });
  await page.route('**/api/trains?**', oneDigitRoute);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  const digit = page.getByRole('row', { name: / 35,/ }).locator('.delay-cell .flap').nth(1);
  await digit.evaluate(element => {
    __flapAudioProbe.starts = [];
    const observer = new MutationObserver(() => {
      if (element.dataset.value === '4' && element.dataset.flipping === 'false') {
        window.__singleLanding = __flapAudioProbe.contexts[0].currentTime;
        observer.disconnect();
      }
    });
    observer.observe(element, { attributes: true, attributeFilter: ['data-flipping'] });
  });
  await page.getByRole('button', { name: '서버 캐시 다시 조회' }).click();
  await page.waitForFunction(() => typeof window.__singleLanding === 'number');
  await quiet();
  singleCharacter = await page.evaluate(() => {
    const last = __flapAudioProbe.starts.at(-1);
    return { leaves: __flapAudioProbe.starts.length,
      strikeErrorMs: (last.when + .02929705215419501 / last.rate - __singleLanding) * 1000,
      tailAfterLandingMs: (last.when + last.duration / last.rate - __singleLanding) * 1000 };
  });
  assert.equal(singleCharacter.leaves, 1);
  assert.ok(Math.abs(singleCharacter.strikeErrorMs) < 45);
  await page.unroute('**/api/trains?**', oneDigitRoute);
  await page.getByRole('button', { name: '소리 끄기' }).click();
  await page.getByLabel('사운드 설정', { exact: true }).click();
  checks.push('Delay digit 3 → 4 plays one recorded impact and its strike aligns with DOM landing within 45 ms');

  await page.getByRole('slider', { name: '효과음 음량' }).fill('0');
  assert.equal(await page.getByRole('button', { name: '소리 미리듣기' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  const atZero = (await state()).starts;
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(2300);
  assert.equal((await state()).starts, atZero);
  checks.push('Zero volume produces no scheduled sources during a real page transition');
  await page.getByLabel('사운드 설정', { exact: true }).click();
  await page.getByRole('slider', { name: '효과음 음량' }).fill('30');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(350);
  assert.ok((await state()).active > 0);
  await page.getByRole('button', { name: '소리 끄기' }).click();
  const mutedAt = await quiet();
  await page.waitForTimeout(2000);
  assert.equal((await state()).starts, mutedAt);
  checks.push('Mute cancels playing and future sources during an active multi-row transition');

  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText('145 TRAINS', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .flap')].every(cell =>
    cell.dataset.flipping === 'false' && cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value),
    undefined, { timeout: 20000 });
  await quiet();
  const settled = await page.locator('.flap').evaluateAll(cells => cells.every(cell => cell.dataset.flipping === 'false'
    && cell.querySelector('.flap-top > span').textContent === cell.dataset.value
    && cell.querySelector('.flap-bottom > span').textContent === cell.dataset.value));
  assert.ok(settled);
  assert.ok((await state()).maxActive <= 24);
  const beforeRefresh = (await state()).starts;
  await page.getByRole('button', { name: '서버 캐시 다시 조회' }).click();
  await page.waitForTimeout(600);
  assert.equal((await state()).starts, beforeRefresh);
  checks.push('Rapid page/snapshot changes settle to current glyphs, finish audio, stay within 24 voices, and identical refresh stays silent');

  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenAt = await quiet();
  await page.waitForTimeout(2300);
  assert.equal((await state()).starts, hiddenAt);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  checks.push('Visibility-change handling silences actual Web Audio output and cancels queued sounds');

  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(300);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedAt = await quiet();
  await page.waitForTimeout(2300);
  assert.equal((await state()).starts, reducedAt);
  assert.equal(await page.locator('[data-flipping="true"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '소리 켜기' }).isDisabled(), true);
  checks.push('Changing reduced-motion preference cancels existing movement and sound');

  const failure = await browser.newPage();
  await failure.route('**/audio/vestaboard-flip.mp3', route => route.abort());
  await failure.goto(`${base}/?source=archive`);
  await failure.getByRole('button', { name: '소리 켜기' }).click();
  await failure.getByText(/플랩 음원 파일을 불러오지 못했습니다/).waitFor();
  assert.equal(await failure.getByRole('button', { name: '소리 켜기' }).getAttribute('aria-pressed'), 'false');
  await failure.close();
  checks.push('Failed audio download reports an error without enabling sound');
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), checks, singleCharacter, pageErrors: errors, ...await state() };
  await writeFile(`${out}/audio-validation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
