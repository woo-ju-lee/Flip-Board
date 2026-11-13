// Exercise the packaged, offline demo against independently checked timetable cases.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const out = process.env.KORAIL_ARTIFACT_DIR ? resolve(process.env.KORAIL_ARTIFACT_DIR) : fileURLToPath(new URL('../artifacts/', import.meta.url));
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.isNavigationRequest() && /^https?:/.test(request.url())) requests.push(request.url()); });
  await page.route('http://127.0.0.1:8000/station-service-demo.html*', async route =>
    route.fulfill({ contentType: 'text/html', body: await readFile(`${out}/station-service-demo.html`) }));
  await page.goto('http://127.0.0.1:8000/station-service-demo.html');
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.context().setOffline(true);
  assert.equal(await page.getByRole('combobox', { name: '역 선택' }).inputValue(), 'ulsan');
  assert.equal(await page.getByRole('row', { name: /^KTX-산천 35,/ }).count(), 0);
  assert.match(await page.getByLabel('정차역 자료 안내').innerText(), /정차역 확인 131대/);
  assert.match(await page.getByLabel('정차역 자료 안내').innerText(), /미확인 17대/);
  await page.getByRole('row', { name: /^KTX 31,/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /서울 → 광명 → 천안아산 → 대전 → 동대구 → 경주 → 울산 → 부산/);
  assert.match(await dialog.getByRole('link').getAttribute('href'), /korail\.com\/file\/.+\.xlsx$/);
  await page.keyboard.press('Escape');
  const layouts = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('.flap:not(.flap-panel)')]
      .every(leaf => leaf.querySelector(':scope > .flap-top > span')?.textContent === leaf.dataset.value));
    await page.screenshot({ path: `${out}/station-service-demo-${width}.png`, fullPage: true });
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(layout.scrollWidth <= width, true);
    layouts.push(layout);
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole('combobox', { name: '역 선택' }).selectOption('서울');
  await page.getByRole('row', { name: /^KTX-산천 35,/ }).waitFor();
  const route = page.getByRole('combobox', { name: '노선 선택' });
  assert.equal(await route.inputValue(), '');
  const stationCount = await page.locator('.count-label').innerText();
  await route.selectOption('service-gyeongbu');
  await page.waitForFunction(before => document.querySelector('.count-label').textContent !== before, stationCount);
  const filteredCount = await page.locator('.count-label').innerText();
  assert.ok(parseInt(filteredCount) < parseInt(stationCount));
  await route.selectOption('');
  await page.getByText(stationCount, { exact: true }).waitFor();
  await page.getByRole('tab', { name: '노선 선택', exact: true }).click();
  await page.getByText('46 TRAINS', { exact: true }).waitFor();
  await page.getByRole('row', { name: /^KTX-산천 35,/ }).waitFor();
  await page.getByRole('tab', { name: '전체 열차', exact: true }).click();
  await page.getByText('148 TRAINS', { exact: true }).waitFor();
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '이전 페이지', exact: true }).isEnabled(), true);
  await page.getByRole('tab', { name: '역 선택', exact: true }).click();
  await page.getByRole('combobox', { name: '역 선택' }).selectOption('ulsan');
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '이전 페이지', exact: true }).isDisabled(), true);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText(/정차역 확인 128대/).waitFor();
  await page.getByRole('button', { name: '실시간', exact: true }).click();
  await page.getByRole('heading', { name: '실시간 수집이 꺼져 있습니다' }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const report = { checks: ['Ulsan includes 31 and excludes passing 35', 'official source and complete stop list in details',
    'station across routes and optional route intersection/reset', 'route includes passing service', 'all view retains 148 records',
    'filter resets pagination', 'both snapshots show their own coverage', 'live mode stays disabled', 'offline with zero network requests'], layouts, pageErrors: errors };
  await writeFile(`${out}/station-service-demo-validation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
