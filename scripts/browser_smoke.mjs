// Runs only against this application's local server; never calls KORAIL.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'],
});
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('heading', { name: '실시간 수집을 기다리고 있습니다' }).waitFor();
  assert.equal(await page.locator('.rows .board-row').count(), 0);
  results.push('Default live mode shows collection disabled, with no archived trains');
  await page.getByRole('button', { name: '기록 표본', exact: true }).click();
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.rows .board-row').count(), 7);
  await page.screenshot({ path: `${out}/board-desktop.png`, fullPage: true });
  results.push('Actual archived 148-record response renders with explicit historical label');

  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(500);
  assert.match(await page.locator('.pagination').innerText(), /02/);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(500);
  const animations = await page.evaluate(async () => {
    let flips = 0;
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) if (m.attributeName === 'data-flipping' && m.target.getAttribute('data-flipping') === 'true') flips++;
    });
    observer.observe(document.querySelector('.rows'), { subtree: true, attributes: true, attributeFilter: ['data-flipping'] });
    document.querySelector('[aria-label="서버 캐시 다시 조회"]').click();
    await new Promise(resolve => setTimeout(resolve, 700));
    observer.disconnect();
    return flips;
  });
  assert.equal(animations, 0);
  results.push('Pagination works; re-reading identical cache starts no character flips');
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText('145 TRAINS', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141536');
  await page.getByText('148 TRAINS', { exact: true }).waitFor();

  await page.getByRole('row', { name: /^KTX 31,/ }).click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /129\./);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  results.push('Full position detail, native dialog focus, Escape close');
  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  await page.getByRole('button', { name: '소리 끄기' }).click();
  results.push('AudioContext user activation and mute toggle (not an acoustic listening test)');
  await page.getByRole('button', { name: '전체 화면', exact: true }).click();
  await page.getByRole('button', { name: '전체 화면 종료' }).waitFor();
  assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), true);
  await page.getByRole('button', { name: '전체 화면 종료' }).click();
  results.push('Fullscreen enters and exits');

  await page.getByRole('tab', { name: '역 선택' }).click();
  await page.getByRole('heading', { name: '노선 판별을 준비하고 있습니다' }).waitFor();
  assert.match(await page.locator('.linked-line').innerText(), /경부고속선/);
  assert.equal(await page.locator('.rows .board-row').count(), 0);
  await page.screenshot({ path: `${out}/board-ulsan-unavailable.png`, fullPage: true });
  await page.getByRole('tab', { name: '노선 선택' }).click();
  await page.getByRole('combobox', { name: '노선 선택' }).selectOption('honam-hsr');
  await page.getByRole('heading', { name: /호남고속선/ }).waitFor();
  await page.getByRole('tab', { name: '전체 열차' }).click();
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  results.push('Ulsan resolves to Gyeongbu; unsupported line geometry is explicit and excludes records');

  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    if (width === 390) await page.screenshot({ path: `${out}/board-mobile.png`, fullPage: true });
  }
  results.push('No horizontal overflow at 1440 / 1024 / 768 / 390 / 360 pixels');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText('145 TRAINS', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-flipping="true"]').count(), 0);
  results.push('Reduced-motion mode suppresses flips');

  await page.route('**/api/trains?**', route => route.abort());
  await page.getByRole('button', { name: '서버 캐시 다시 조회' }).click();
  await page.getByText('연결 실패', { exact: true }).waitFor();
  assert.equal(await page.locator('.rows .board-row').count(), 7);
  results.push('Browser connection failure retains last displayed cache and changes status');
  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser-validation.json`, JSON.stringify({ browser: await browser.version(), passed: results, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, checks: results, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
