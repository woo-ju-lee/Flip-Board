// Validate the downloadable demo with the same ten-row layout as the live app.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
const prefix = 'rotor-demo-character-layout';
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await installAudioProbe(page);
  const errors = [], assets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.isNavigationRequest()) assets.push(request.url()); });
  await page.route(`http://127.0.0.1:8000/${prefix}.html*`, async route =>
    route.fulfill({ contentType: 'text/html', body: await readFile(`${out}/${prefix}.html`) }));
  await page.goto(`http://127.0.0.1:8000/${prefix}.html`);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => [...document.fonts].some(font =>
    font.family.replaceAll('"','') === 'IBM Plex Sans KR' && font.weight === '400' && font.status === 'loaded')), true);
  assert.equal(await page.locator('.origin-cell .flap').first().evaluate(el => getComputedStyle(el).fontWeight), '400');
  await page.waitForTimeout(2300);
  await page.context().setOffline(true);
  assert.equal(await page.locator('.rows .board-row').count(), 10);
  assert.equal(await page.locator('.board-columns > [role=columnheader]').count(), 5);
  assert.equal(await page.locator('.flap-station').count(), 0);
  assert.equal(await page.locator('.board-row .origin-cell .flap, .board-row .destination-cell .flap').count(), 100);
  assert.equal(await page.locator('.board-row .origin-cell .flap, .board-row .destination-cell .flap').evaluateAll(leaves => leaves.every(leaf => Array.from(leaf.dataset.value).length === 1)), true);
  assert.equal(await page.locator('.demo-intro,.demo-distance,.demo-actions').count(), 0);
  assert.equal(await page.evaluate(() => __flapAudioProbe.contexts.length), 0);
  const layouts = [];
  for (const width of [1920, 1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => ({
      width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('.board-row > [role=cell], .flap-half > span')]
        .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent),
      boxes: Object.fromEntries(['.topbar','.controls','.source-notice','.board-housing','.board-titlebar','.board-columns','.board-row','.board-footer','.under-board'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect(); return [selector,{x:r.x,y:r.y,width:r.width,height:r.height}];
      })),
    }));
    assert.equal(result.overflow, false); assert.deepEqual(result.clipped, []);
    layouts.push(result);
    await page.screenshot({ path: `${out}/${prefix}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.waitForTimeout(2300);
  await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
  await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => __flapAudioProbe.starts.length) > 0);
  await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
  await page.waitForTimeout(300);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-flipping=true]').count(), 0);
  assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
  assert.equal(await page.getByRole('button', { name: '소리 켜기', exact: true }).isDisabled(), true);
  const mismatched = await page.locator('.flap:not(.flap-panel)').evaluateAll(leaves => leaves.filter(leaf => leaf.querySelector(':scope > .flap-top > span').textContent !== leaf.dataset.value).map(leaf => leaf.dataset.value));
  assert.deepEqual(mismatched, []);
  await page.getByRole('row', { name: /^KTX 31,/ }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '역 선택', exact: true }).click();
  await page.getByRole('heading', { name: '노선 판별을 준비하고 있습니다' }).waitFor();
  await page.getByRole('tab', { name: '전체 열차', exact: true }).click();
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText('145 TRAINS', { exact: true }).waitFor();
  await page.getByRole('button', { name: '실시간', exact: true }).click();
  await page.getByRole('heading', { name: '실시간 수집이 꺼져 있습니다' }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(assets, []);
  const report = { transport: 'Single HTML with archived API responses, fonts, and audio embedded; browser offline',
    checks: ['five columns and ten rows; five separate letter leaves per station', 'responsive layout fits at 1920/1440/1024/768/390/360 without obsolete pixel-coordinate matching',
      'bundled IBM Plex Sans KR Regular loads without an external font server', 'no separate demo layout or controls', 'real audio plays offline', 'page changes redirect existing modules',
      'reduced motion cancels flips and sound', 'detail/filter/source/snapshot controls work', 'zero extra asset or API requests'],
    layouts, pageErrors: errors, assetRequests: assets };
  await writeFile(`${out}/${prefix}-validation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, widths: layouts.map(x => x.width), pageErrors: errors }, null, 2));
} finally { await browser.close(); }
