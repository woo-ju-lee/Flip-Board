// Verify both downloadable HTML demos, layout parity, rotor paths, and cancellation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive: true });
const stationNames = JSON.parse(await readFile(new URL('../frontend/src/stationRotor.json', import.meta.url), 'utf8'));
const stationRotor = [' ', ...new Set(stationNames.flatMap(name => Array.from(name.normalize('NFC'))))].sort();
const archive = JSON.parse(await readFile(new URL('../frontend/src/rotorDemoArchive.json', import.meta.url), 'utf8'));
const trains = [...archive.latest.trains].sort((a, b) => a.number.localeCompare(b.number, 'ko', { numeric: true }));
const fitted = (text, length) => Array.from(text).concat(Array(length).fill(' ')).slice(0, length);
const forward = (from, to, rotor) => {
  const start = rotor.indexOf(from), target = rotor.indexOf(to);
  if (start < 0 || target < 0) return [];
  return Array.from({ length: (target - start + rotor.length) % rotor.length }, (_, i) => rotor[(start + i + 1) % rotor.length]);
};
const candidates = { digit: [], station: [] };
for (let row = 0; row < 10; row++) for (const [field, column, length, rotor, kind] of [
  ['number', 'train', 4, Array.from('0123456789'), 'digit'],
  ['origin', 'origin', 5, stationRotor, 'station'], ['destination', 'destination', 5, stationRotor, 'station'],
]) {
  const before = fitted(trains[row][field], length), after = fitted(trains[row + 10][field], length);
  for (let index = 0; index < length; index++) {
    const expected = forward(before[index], after[index], rotor);
    if (expected.length) candidates[kind].push({ from: before[index], to: after[index], expected,
      selector: `.board-row:nth-child(${row + 1}) .${column}-cell .flap-word > .flap:nth-child(${index + 1})` });
  }
}
for (const choices of Object.values(candidates)) choices.sort((a, b) => b.expected.length - a.expected.length);
const traceSpecs = [{ key: 'digit', ...candidates.digit[0] },
  ...candidates.station.slice(0, 2).map((candidate, i) => ({ key: `station${i + 1}`, ...candidate }))];
assert.equal(traceSpecs.length, 3);
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const reports = [];
const settled = () => [...document.querySelectorAll('.rows .flap')].length > 0 &&
  [...document.querySelectorAll('.rows .flap:not(.flap-panel)')].every(leaf => leaf.dataset.flipping === 'false' &&
    leaf.querySelector(':scope > .flap-top > span').textContent === leaf.dataset.value);
// React handles resize/fullscreen through effects; a fixed delay can capture
// correct outer CSS geometry while the previous number of character cells remains.
async function waitForLayoutState(page, width, fullscreen = false) {
  const letters = fullscreen ? 13 : width <= 480 ? 9 : width <= 760 ? 11 : 13;
  await page.waitForFunction(({ width, fullscreen, letters }) => {
    const positions = [...document.querySelectorAll('.rows .board-row .position-cell')];
    return innerWidth === width && Boolean(document.fullscreenElement) === fullscreen && positions.length === 10 &&
      positions.every(cell => cell.querySelectorAll('.flap').length === letters) &&
      !document.querySelector('.rows [data-flipping="true"]');
  }, { width, fullscreen, letters });
  await page.waitForFunction(settled);
  // Let paint catch up with React's settled DOM before inspecting or capturing it.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return letters;
}
const getLayout = () => ({
  width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
  positionLetters: [...document.querySelectorAll('.rows .board-row .position-cell')].map(cell => cell.querySelectorAll('.flap').length),
  clipped: [...document.querySelectorAll('.board-row > [role=cell], .flap-half > span')]
    .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent),
  boxes: Object.fromEntries(['.topbar', '.controls', '.source-notice', '.board-housing', '.board-titlebar', '.board-columns', '.board-row', '.board-footer', '.under-board'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  })),
});
const sameBoxes = (actual, expected, label) => {
  for (const [selector, box] of Object.entries(actual)) for (const [axis, value] of Object.entries(box)) {
    assert.ok(Math.abs(value - expected[selector][axis]) < 1,
      `${label}: ${selector} ${axis}: ${value} vs ${expected[selector][axis]}`);
  }
};
try {
  for (const renderer of ['legacy', 'optimized']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await installAudioProbe(page);
      const errors = [], externalRequests = [], checks = [], layouts = [], fullscreenLayouts = [], actualFonts = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url()) && !request.isNavigationRequest()) externalRequests.push(request.url()); });
      await context.setOffline(true);
      const fileUrl = pathToFileURL(`${out}/flap-performance-${renderer}.html`).href;
      let url = fileUrl;
      let transport = 'native file:// navigation';
      let fileNavigationBlocked = false;
      try { await page.goto(url); } catch (error) {
        if (!String(error).includes('ERR_BLOCKED_BY_ADMINISTRATOR')) throw error;
        fileNavigationBlocked = true;
        transport = 'exact HTML bytes via in-memory localhost navigation route; browser remains offline';
        url = `http://127.0.0.1:8000/flap-performance-${renderer}.html`;
        await page.route(`${url}*`, async route => route.fulfill({
          contentType: 'text/html', body: await readFile(`${out}/flap-performance-${renderer}.html`),
        }));
        await page.goto(url);
      }
      await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(settled);
      assert.equal(await page.locator('.rows .board-row').count(), 10);
      assert.equal(await page.locator('.board-columns > [role=columnheader]').count(), 5);
      assert.equal(await page.locator('.board-row .origin-cell .flap, .board-row .destination-cell .flap').count(), 100);
      assert.equal(await page.locator('.demo-intro,.demo-distance,.demo-actions').count(), 0);
      checks.push('Standalone HTML loads offline with latest 10 rows, 5 columns, 100 individual station cells, and no added demo controls');
      assert.equal(await page.locator('.board-theme.monochrome-board').count(), 1);
      assert.equal(await page.locator('.rows .flap:not(.flap-panel)').evaluateAll(leaves => leaves.every(leaf =>
        getComputedStyle(leaf).fontWeight === '400' && getComputedStyle(leaf).fontFamily.startsWith('"IBM Plex Sans KR"'))), true);
      assert.equal(await page.locator('.train-logo img').evaluateAll(images => images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0)), true);
      const fontCdp = await context.newCDPSession(page);
      await fontCdp.send('DOM.enable'); await fontCdp.send('CSS.enable');
      const { root } = await fontCdp.send('DOM.getDocument');
      for (const selector of ['.origin-cell .flap-top > span', '.train-cell .flap:not(.flap-panel) .flap-top > span']) {
        const { nodeId } = await fontCdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const { fonts } = await fontCdp.send('CSS.getPlatformFontsForNode', { nodeId });
        assert.ok(fonts.some(font => font.familyName === 'IBM Plex Sans KR' && font.isCustomFont && font.glyphCount > 0), JSON.stringify(fonts));
        actualFonts.push({ selector, fonts });
      }
      await fontCdp.detach();
      checks.push('Latest monochrome theme, actual bundled IBM Plex Sans KR 400 Hangul/digit rendering, and loaded train logo images are verified offline');

      for (const width of [1920, 1440, 1024, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 1080 });
        const expectedLetters = await waitForLayoutState(page, width);
        const layout = await page.evaluate(getLayout);
        assert.deepEqual(layout.positionLetters, Array(10).fill(expectedLetters), `${renderer}/${width}: position-cell count`);
        assert.equal(layout.overflow, false, `${renderer} overflows at ${width}`);
        assert.deepEqual(layout.clipped, [], `${renderer} clips text at ${width}`);
        if (renderer === 'optimized') {
          const previous = reports[0].layouts.find(item => item.width === width);
          sameBoxes(layout.boxes, previous.boxes, `optimized/${width} vs legacy`);
        }
        layouts.push(layout);
        await page.screenshot({ path: `${out}/flap-performance-${renderer}-${width}.png`, fullPage: true });
      }
      checks.push('Six viewport widths have no overflow/clipping; fresh latest-layout renderer rectangle differences are under 1px');
      await page.getByRole('button', { name: '전체 화면', exact: true }).click();
      await page.waitForFunction(() => document.fullscreenElement?.classList.contains('board-housing'));
      for (const [width, height] of [[1920,1080], [1440,900], [2560,1440], [3840,2160], [2560,1080], [1366,768], [1024,768], [768,1024], [390,844], [360,640], [667,375], [844,390]]) {
        await page.setViewportSize({ width, height });
        await waitForLayoutState(page, width, true);
        const result = await page.evaluate(() => {
          const board = document.querySelector('.board-housing');
          const rows = [...board.querySelectorAll('.rows .board-row')];
          const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          return { width: innerWidth, height: innerHeight, rows: rows.length,
            horizontalOverflow: board.scrollWidth > board.clientWidth, verticalOverflow: board.scrollHeight > board.clientHeight,
            titleHidden: getComputedStyle(board.querySelector('.board-title')).display === 'none',
            metadataHidden: getComputedStyle(board.querySelector('.update-label')).display === 'none',
            background: getComputedStyle(board).backgroundColor,
            positionLetters: rows[0].querySelectorAll('.position-cell .flap').length,
            bottom: rows.at(-1).getBoundingClientRect().bottom,
            badFaces: [...board.querySelectorAll('.flap-half')].filter(leaf => getComputedStyle(leaf).backgroundColor !== 'rgb(33, 33, 33)' || getComputedStyle(leaf).backgroundImage !== 'none').length,
            rowBorders: rows.filter(row => getComputedStyle(row).borderBottomWidth !== '0px').length,
            clipped: [...board.querySelectorAll('.board-row > span,.flap-half > span,.train-logo-art')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className),
            misaligned: [...board.querySelectorAll('.flap')].filter(leaf => {
              const top = box(leaf.querySelector(':scope > .flap-top > span'));
              const bottom = box(leaf.querySelector(':scope > .flap-bottom > span'));
              return ['x', 'y', 'width', 'height'].some(key => Math.abs(top[key] - bottom[key]) > .1);
            }).map(leaf => leaf.dataset.value),
            boxes: { board: box(board), firstRow: box(rows[0]), lastRow: box(rows.at(-1)), firstCell: box(rows[0].querySelector('.origin-cell .flap')) },
          };
        });
        assert.equal(result.rows, 10); assert.equal(result.positionLetters, 13);
        assert.equal(result.horizontalOverflow, false); assert.equal(result.verticalOverflow, false);
        assert.ok(result.titleHidden && result.metadataHidden); assert.equal(result.background, 'rgb(0, 0, 0)');
        assert.equal(result.badFaces, 0); assert.equal(result.rowBorders, 0);
        assert.deepEqual(result.clipped, []); assert.deepEqual(result.misaligned, []); assert.ok(result.bottom <= height);
        if (renderer === 'optimized') sameBoxes(result.boxes, reports[0].fullscreenLayouts.find(item => item.width === width && item.height === height).boxes, `fullscreen ${width}x${height}`);
        fullscreenLayouts.push(result);
        if ([1920, 390].includes(width)) await page.screenshot({ path: `${out}/flap-performance-${renderer}-fullscreen-${width}.png` });
      }
      await page.getByRole('button', { name: '전체 화면 종료', exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
      assert.ok(await page.locator('.board-title').isVisible());
      checks.push('Board-only fullscreen preserves latest 10-row geometry, surfaces, half alignment and 13 position letters across 12 desktop/tablet/phone sizes, and exits correctly');

      await page.setViewportSize({ width: 1440, height: 1080 });
      await waitForLayoutState(page, 1440);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(settled);
      assert.equal(await page.evaluate(() => __flapAudioProbe.contexts.length), 0);
      // Trace with sound off and narrowly scoped observers; audio probes run separately below.
      await page.evaluate(specs => {
        window.__flapCheck = {
          initialCells: [...document.querySelectorAll('.rows .flap:not(.flap-panel)')],
          initialMovingPlanes: [...document.querySelectorAll('.rows .flap-optimized .flap-motion')],
          trace: Object.fromEntries(specs.map(spec => [spec.key, []])), times: Object.fromEntries(specs.map(spec => [spec.key, []])), startedAt: performance.now(), last: new Map(),
        };
        const probe = window.__flapCheck;
        const cells = specs.map(({ key, selector }) => [key, document.querySelector(selector)]);
        probe.observer = new MutationObserver(() => {
          for (const [key, leaf] of cells) {
            if (leaf?.dataset.flipping !== 'true') continue;
            const value = leaf.querySelector('.flap-in > span')?.textContent;
            if (value && probe.last.get(key) !== value) { probe.trace[key].push(value); probe.times[key].push(performance.now() - probe.startedAt); probe.last.set(key, value); }
          }
        });
        for (const [, leaf] of cells) probe.observer.observe(leaf, { subtree: true, childList: true, characterData: true, attributes: true });
        probe.stalls = [];
        let previousFrame;
        const frame = now => {
          if (previousFrame !== undefined && now - previousFrame > 160) probe.stalls.push({ at: now - probe.startedAt, gap: now - previousFrame });
          previousFrame = now;
          probe.raf = requestAnimationFrame(frame);
        };
        probe.raf = requestAnimationFrame(frame);
      }, traceSpecs);
      await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
      await page.waitForFunction(settled, undefined, { timeout: 22000 });
      await page.waitForTimeout(100);
      const observation = await page.evaluate(() => { __flapCheck.observer.disconnect(); cancelAnimationFrame(__flapCheck.raf); return { trace: __flapCheck.trace, times: __flapCheck.times, stalls: __flapCheck.stalls }; });
      const { trace } = observation;
      await writeFile(`${out}/flap-performance-trace-${renderer}.json`, JSON.stringify(observation, null, 2));
      for (const spec of traceSpecs) assert.deepEqual(trace[spec.key], spec.expected, `${renderer}: ${spec.from} → ${spec.to} (${spec.expected.length} leaves)`);
      assert.equal(await page.evaluate(() => __flapCheck.initialCells.every((leaf, i) => leaf === document.querySelectorAll('.rows .flap:not(.flap-panel)')[i])), true);
      if (renderer === 'optimized') {
        assert.ok(await page.evaluate(() => __flapCheck.initialMovingPlanes.length) > 0);
        assert.equal(await page.evaluate(() => __flapCheck.initialMovingPlanes.every((plane, i) => plane === document.querySelectorAll('.rows .flap-optimized .flap-motion')[i])), true);
      }
      assert.equal(await page.evaluate(() => __flapAudioProbe.contexts.length), 0);
      checks.push('With sound off, all digit and long station intermediate leaves are observed; outer cells persist, and optimized moving planes persist');
      await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
      await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
      const soundCount = await page.evaluate(() => __flapAudioProbe.starts.length);
      await page.getByRole('button', { name: '서버 캐시 다시 조회', exact: true }).click();
      await page.waitForTimeout(500);
      assert.equal(await page.locator('[data-flipping=true]').count(), 0);
      assert.equal(await page.evaluate(() => __flapAudioProbe.starts.length), soundCount);
      checks.push('Identical cached update triggers no flips or new sounds');
      await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
      await page.waitForTimeout(500);
      assert.ok(await page.evaluate(() => __flapAudioProbe.starts.length) > 0);
      await page.screenshot({ path: `${out}/flap-performance-${renderer}-turning.png`, fullPage: true });
      await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
      await page.waitForFunction(settled, undefined, { timeout: 22000 });
      await page.waitForTimeout(100);
      await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
      assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
      const audiblePeak = await page.evaluate(() => {
        const edges = __flapAudioProbe.starts.flatMap(voice => {
          const start = Math.max(voice.when, voice.contextTime);
          const end = Math.min(voice.when + voice.duration / voice.rate, voice.stopped ?? Infinity);
          return end > start ? [[start, 1], [end, -1]] : [];
        }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let active = 0, peak = 0;
        for (const [, delta] of edges) { active += delta; peak = Math.max(peak, active); }
        return peak;
      });
      assert.ok(audiblePeak <= 24, `At most 24 simultaneously audible voices, got ${audiblePeak}`);
      checks.push('Offline sound plays with at most 24 voices; rapid previous/next/previous retargeting settles with no remaining sounds');
      await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(settled);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
      assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      checks.push('Synthetic document.hidden + visibilitychange settles immediately and cancels animations and audio');
      await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
      await page.waitForTimeout(300);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(settled);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
      assert.equal(await page.getByRole('button', { name: '소리 켜기', exact: true }).isDisabled(), true);
      checks.push('Reduced-motion preference settles immediately and disables sound');
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
      await page.getByRole('link', { name: 'KORAIL Live 홈', exact: true }).click();
      await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
      assert.equal(new URL(page.url()).pathname, new URL(url).pathname);
      await page.waitForFunction(settled);
      if (renderer === 'optimized') assert.ok(await page.locator('.flap-motion').count() > 0);
      checks.push('Detail, filters, snapshots, source switch, and home link work offline; home preserves the standalone renderer');
      assert.deepEqual(errors, []);
      assert.deepEqual(externalRequests, []);
      checks.push('Zero browser errors and zero extra HTTP(S) requests, including audio and fonts');
      reports.push({ renderer, fileUrl, testedUrl: url, transport, fileNavigationBlocked, checks, layouts, fullscreenLayouts, actualFonts, audiblePeak, traceSpecs, trace, pageErrors: errors, externalRequests });
      console.log(JSON.stringify({ renderer, checks }, null, 2));
    } finally { await context.close(); }
  }
  const report = { browser: await browser.version(), visibilityTest: 'Synthetic visibility event; not an OS background tab test',
    fileProtocolCaveat: reports.some(report => report.fileNavigationBlocked) ? 'Native file:// navigation was blocked by Chromium administrative policy. Policy was not changed. Exact bundled HTML was tested through an in-memory localhost navigation route offline; Windows double-click navigation still needs user confirmation.' : null, reports };
  await writeFile(`${out}/flap-performance-validation.json`, JSON.stringify(report, null, 2));
  console.log(`Validation report: ${out}/flap-performance-validation.json`);
} finally { await browser.close(); }
