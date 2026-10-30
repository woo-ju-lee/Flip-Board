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
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const probe = window.__boardFrames = { pending: new Set(), maxPending: 0, requests: 0 };
    window.requestAnimationFrame = callback => {
      const id = request(now => { probe.pending.delete(id); callback(now); });
      probe.pending.add(id);
      probe.requests++;
      probe.maxPending = Math.max(probe.maxPending, probe.pending.size);
      return id;
    };
    window.cancelAnimationFrame = id => { probe.pending.delete(id); cancel(id); };
  });
  const settled = () => page.waitForFunction(() => [...document.querySelectorAll('.rows .flap')].every(cell =>
    cell.dataset.flipping === 'false' && (cell.classList.contains('flap-panel')
      ? cell.querySelector(':scope > .flap-top').innerHTML === cell.querySelector(':scope > .flap-bottom').innerHTML
      : cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value)),
    // Poll with a timer so the test itself does not add a frame request to the probe.
    undefined, { timeout: 20000, polling: 100 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('heading', { name: '실시간 수집이 꺼져 있습니다' }).waitFor();
  assert.equal(await page.locator('.rows .board-row').count(), 0);
  results.push('Default live mode shows collection disabled, with no archived trains');
  await page.getByRole('button', { name: '기록 표본', exact: true }).click();
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await settled();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.rows .board-row').count(), 10);
  assert.ok(await page.locator('.rows .flap-optimized').count() > 0);
  assert.equal(await page.locator('.rows .flap:not(.flap-panel):not(.flap-optimized)').count(), 0);
  await page.screenshot({ path: `${out}/board-desktop.png`, fullPage: true });
  results.push('Actual archived 148-record response renders with explicit historical label');

  await page.evaluate(() => {
    window.__firstBoardSlot = document.querySelector('.rows .board-row');
    window.__originalFlapNodes = [...document.querySelectorAll('.rows .flap-optimized, .rows .flap-optimized *')];
    window.__flapChildChanges = 0;
    window.__flapObserver = new MutationObserver(records => {
      window.__flapChildChanges += records.reduce((count, record) => count + record.addedNodes.length + record.removedNodes.length, 0);
    });
    for (const leaf of document.querySelectorAll('.rows .flap-optimized')) {
      window.__flapObserver.observe(leaf, { childList: true, subtree: true });
    }
  });
  await page.getByRole('button', { name: '다음 페이지' }).click();
  assert.equal(await page.evaluate(() => window.__firstBoardSlot === document.querySelector('.rows .board-row')), true);
  await settled();
  assert.deepEqual(await page.evaluate(() => {
    window.__flapObserver.disconnect();
    const nodes = [...document.querySelectorAll('.rows .flap-optimized, .rows .flap-optimized *')];
    return { sameNodes: nodes.length === __originalFlapNodes.length && nodes.every((node, index) => node === __originalFlapNodes[index]),
      childChanges: __flapChildChanges, pendingFrames: __boardFrames.pending.size, maxPendingFrames: __boardFrames.maxPending,
      runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length };
  }), { sameNodes: true, childChanges: 0, pendingFrames: 0, maxPendingFrames: 1, runningAnimations: 0 });
  results.push('Default production board uses optimized text flaps, reuses all character nodes, shares one frame request, and stops animation work after landing');
  assert.match(await page.locator('.pagination').innerText(), /02/);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await settled();
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
  results.push('Pagination preserves physical cells until their indexed targets settle; identical cache starts no character flips');
  const idleFrames = await page.evaluate(() => __boardFrames.requests);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => __boardFrames.requests), idleFrames);

  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(180);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(180);
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await settled();
  assert.match(await page.locator('.pagination').innerText(), /02/);
  assert.equal(await page.evaluate(() => __boardFrames.pending.size), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await settled();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  results.push('Rapid next/previous/next changes settle to the last requested page with no pending frame work');
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
  await page.getByLabel('사운드 설정', { exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: '효과음 음량' }).inputValue(), '30');
  await page.getByRole('slider', { name: '효과음 음량' }).fill('0');
  assert.equal(await page.getByRole('button', { name: '소리 미리듣기' }).isDisabled(), true);
  await page.getByRole('slider', { name: '효과음 음량' }).fill('30');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sound-settings').getAttribute('open'), null);
  const bankPresent = await page.evaluate(async () => {
    try { const response = await fetch('/audio/split-flap.json'); return response.ok && (await response.json()).version === 1; }
    catch { return false; }
  });
  await page.getByRole('button', { name: '소리 켜기' }).click();
  assert.equal(bankPresent, true, 'The production build must include the recorded sound');
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  await page.getByRole('button', { name: '소리 끄기' }).click();
  results.push('Bundled Vestaboard recording decodes after user activation and mutes; volume starts at 30%, zero disables preview');
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

  for (const width of [1920, 1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(length => [...document.querySelectorAll('.rows .position-cell')]
      .every(cell => cell.querySelectorAll('.flap').length === length), width <= 480 ? 9 : width <= 760 ? 11 : 13);
    await settled();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    const clipped = await page.locator('.board-row:not(.empty-row) > [role="cell"]').evaluateAll(cells =>
      cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => ({ class: cell.className, width: cell.clientWidth, content: cell.scrollWidth })));
    assert.deepEqual(clipped, [], `cell contents clipped at ${width}px`);
    assert.equal(await page.locator('.rows .board-row').count(), 10);
    await page.screenshot({ path: `${out}/after-${width}.png`, fullPage: true });
    if (width === 390) await page.screenshot({ path: `${out}/board-mobile.png`, fullPage: true });
  }
  results.push('No page overflow or clipped cells at 1920 / 1440 / 1024 / 768 / 390 / 360 pixels; ten rows remain');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.getByText('145 TRAINS', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-flipping="true"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '소리 켜기' }).isDisabled(), true);
  results.push('Reduced-motion mode suppresses flips and disables accompanying sound');

  await page.route('**/api/trains?**', route => route.abort());
  await page.getByRole('button', { name: '서버 캐시 다시 조회' }).click();
  await page.getByText('연결 실패', { exact: true }).waitFor();
  assert.equal(await page.locator('.rows .board-row').count(), 10);
  results.push('Browser connection failure retains last displayed cache and changes status');

  const comparison = await browser.newPage({ reducedMotion: 'reduce' });
  comparison.on('pageerror', error => errors.push(error.message));
  for (const renderer of ['optimized', 'legacy']) {
    await comparison.goto(`${base}/?demo=performance&renderer=${renderer}`);
    await comparison.getByRole('row', { name: /^KTX 31,/ }).waitFor();
    assert.equal(await comparison.locator('.rows .flap-optimized').count() > 0, renderer === 'optimized');
  }
  await comparison.goto(`${base}/?demo=rotors`);
  await comparison.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  assert.ok(await comparison.locator('.rows .flap-optimized').count() > 0);
  await comparison.close();
  const fallback = await browser.newPage({ reducedMotion: 'reduce' });
  fallback.on('pageerror', error => errors.push(error.message));
  await fallback.addInitScript(() => { Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: undefined }); });
  await fallback.goto(`${base}/?source=archive`);
  await fallback.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  assert.equal(await fallback.locator('.rows .flap-optimized').count(), 0);
  await fallback.getByRole('button', { name: '다음 페이지' }).click();
  assert.match(await fallback.locator('.pagination').innerText(), /02/);
  assert.ok(await fallback.locator('.rows .flap:not(.flap-panel)').evaluateAll(cells => cells.length > 0 && cells.every(cell =>
    cell.dataset.flipping === 'false' && cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value)));
  await fallback.close();
  results.push('Demo routes preserve explicit legacy selection and default optimization; browsers without Web Animations can paginate using the legacy renderer');
  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser-validation.json`, JSON.stringify({ browser: await browser.version(), passed: results, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, checks: results, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
