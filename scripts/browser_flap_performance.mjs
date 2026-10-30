// Compare the two production demo renderers without overlapping browser workloads.
// npm run build && npm run preview; then KORAIL_TEST_URL=http://127.0.0.1:4173 node scripts/browser_flap_performance.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:5173';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
const repeats = Number(process.env.KORAIL_PERF_RUNS || 3);
const windowMs = 18000;
assert.ok(Number.isInteger(repeats) && repeats > 0);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const results = [];
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const metricsMap = response => Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
const settles = () => [...document.querySelectorAll('.rows .flap')].length > 0 &&
  [...document.querySelectorAll('.rows .flap:not(.flap-panel)')].every(leaf => leaf.dataset.flipping === 'false' &&
    leaf.querySelector(':scope > .flap-top > span').textContent === leaf.dataset.value);
try {
  for (const cpuRate of [1, 4]) for (const sound of [false, true]) for (let repeat = 0; repeat < repeats; repeat++) {
    // Alternate which renderer runs first to reduce order-related host load bias.
    const order = repeat % 2 === 0 ? ['legacy', 'optimized'] : ['optimized', 'legacy'];
    for (const renderer of order) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'no-preference' });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        await cdp.send('Performance.enable');
        const url = new URL(base);
        url.search = `?demo=performance&renderer=${renderer}`;
        await page.goto(url.href);
        await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(settles, undefined, { timeout: 20000 });
        assert.equal(await page.locator('.flap-optimized').count() > 0, renderer === 'optimized', 'Requested renderer must actually be active');
        if (sound) {
          await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
          await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
        }
        // Install light, identical instrumentation. Text node updates are not DOM element churn.
        await page.evaluate(() => {
          const root = document.querySelector('.rows');
          const probe = window.__flapPerformance = {
            startedAt: 0, endedAt: 0, frameGaps: [], longTasks: [], elementAdditions: 0,
            elementRemovals: 0, raf: 0, previousFrame: 0, measuring: false,
            originalElements: [...root.querySelectorAll('.flap:not(.flap-panel), .flap:not(.flap-panel) *')],
          };
          const count = nodes => [...nodes].reduce((total, node) => total + (node.nodeType === Node.ELEMENT_NODE ? 1 + node.querySelectorAll('*').length : 0), 0);
          probe.mutations = new MutationObserver(records => {
            for (const record of records) {
              probe.elementAdditions += count(record.addedNodes);
              probe.elementRemovals += count(record.removedNodes);
            }
          });
          for (const leaf of root.querySelectorAll('.flap:not(.flap-panel)')) probe.mutations.observe(leaf, { subtree: true, childList: true });
          probe.longTaskObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (entry.startTime >= probe.startedAt && probe.measuring) {
              probe.longTasks.push({ start: entry.startTime - probe.startedAt, duration: entry.duration });
            }
          });
          probe.longTaskObserver.observe({ type: 'longtask' });
          probe.frame = now => {
            if (!probe.measuring) return;
            if (probe.previousFrame) probe.frameGaps.push(now - probe.previousFrame);
            if (!probe.previousFrame) probe.firstFrameLatencyMs = performance.now() - probe.startedAt;
            probe.previousFrame = now;
            probe.raf = requestAnimationFrame(probe.frame);
          };
        });
        const before = metricsMap(await cdp.send('Performance.getMetrics'));
        const observed = await page.evaluate(duration => new Promise(resolve => {
          const probe = window.__flapPerformance;
          probe.startedAt = performance.now();
          probe.measuring = true;
          probe.raf = requestAnimationFrame(probe.frame);
          document.querySelector('[aria-label="다음 페이지"]').click();
          setTimeout(() => {
            probe.endedAt = performance.now();
            for (const entry of probe.longTaskObserver.takeRecords()) if (entry.startTime >= probe.startedAt) {
              probe.longTasks.push({ start: entry.startTime - probe.startedAt, duration: entry.duration });
            }
            probe.measuring = false;
            cancelAnimationFrame(probe.raf);
            probe.mutations.disconnect();
            probe.longTaskObserver.disconnect();
            const sorted = [...probe.frameGaps].sort((a, b) => a - b);
            const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
            resolve({
              elapsedMs: probe.endedAt - probe.startedAt,
              firstFrameLatencyMs: probe.firstFrameLatencyMs,
              frames: sorted.length,
              frameGapP50Ms: percentile(.5), frameGapP95Ms: percentile(.95), frameGapP99Ms: percentile(.99),
              maxFrameGapMs: sorted.at(-1) ?? null,
              framesAbove50Ms: sorted.filter(gap => gap > 50).length,
              framesAbove50Fraction: sorted.length ? sorted.filter(gap => gap > 50).length / sorted.length : 0,
              framesAbove33Ms: sorted.filter(gap => gap > 33.34).length,
              longTaskCount: probe.longTasks.length,
              longTaskTotalMs: probe.longTasks.reduce((total, entry) => total + entry.duration, 0),
              longTasks: probe.longTasks,
              elementAdditions: probe.elementAdditions, elementRemovals: probe.elementRemovals,
              originalElementsStillConnected: probe.originalElements.filter(node => node.isConnected).length,
              originalElementCount: probe.originalElements.length,
              activeFlaps: document.querySelectorAll('.rows [data-flipping="true"]').length,
              mismatches: [...document.querySelectorAll('.rows .flap:not(.flap-panel)')].filter(leaf => leaf.querySelector(':scope > .flap-top > span').textContent !== leaf.dataset.value).length,
              activeAnimations: document.getAnimations().filter(animation => animation.playState === 'running' || animation.playState === 'pending').length,
            });
          }, duration);
        }), windowMs);
        const after = metricsMap(await cdp.send('Performance.getMetrics'));
        const counters = Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(name => [name, after[name] - before[name]]));
        const result = { renderer, cpuRate, sound, repeat: repeat + 1, ...observed, ...counters, pageErrors: errors };
        assert.equal(result.activeFlaps, 0, `${renderer}: unfinished flaps after ${windowMs}ms`);
        assert.equal(result.mismatches, 0, `${renderer}: incorrect final characters`);
        assert.deepEqual(errors, []);
        if (renderer === 'optimized') {
          assert.equal(result.elementAdditions, 0, 'Optimized renderer adds no elements during a transition');
          assert.equal(result.elementRemovals, 0, 'Optimized renderer removes no elements during a transition');
          assert.equal(result.originalElementsStillConnected, result.originalElementCount);
          assert.equal(result.activeAnimations, 0);
        }
        results.push(result);
        await writeFile(`${out}/flap-performance-runs.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ run: results.length, total: repeats * 8, renderer, cpuRate, sound,
          scriptMs: Number((result.ScriptDuration * 1000).toFixed(2)), p95Ms: result.frameGapP95Ms,
          framesAbove50Ms: result.framesAbove50Ms, elementAdditions: result.elementAdditions }));
      } finally { await context.close(); }
    }
  }
  const comparisons = [];
  for (const cpuRate of [1, 4]) for (const sound of [false, true]) {
    const summarize = renderer => {
      const rows = results.filter(row => row.renderer === renderer && row.cpuRate === cpuRate && row.sound === sound);
      return Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'frameGapP95Ms', 'frameGapP99Ms',
        'framesAbove50Ms', 'framesAbove50Fraction', 'framesAbove33Ms', 'longTaskCount', 'longTaskTotalMs', 'elementAdditions', 'elementRemovals'].map(key => [key, median(rows.map(row => row[key]))]));
    };
    const legacy = summarize('legacy'), optimized = summarize('optimized');
    comparisons.push({ cpuRate, sound, median: { legacy, optimized },
      scriptReductionPercent: (legacy.ScriptDuration - optimized.ScriptDuration) / legacy.ScriptDuration * 100,
      p95DeltaMs: optimized.frameGapP95Ms - legacy.frameGapP95Ms,
      framesAbove50Delta: optimized.framesAbove50Ms - legacy.framesAbove50Ms,
      framesAbove50FractionDelta: optimized.framesAbove50Fraction - legacy.framesAbove50Fraction });
  }
  const report = {
    browser: await browser.version(), base, viewport: { width: 1440, height: 1080 }, repeats, windowMs,
    scenario: 'Latest 10-row monochrome layout, production build, archived latest snapshot, first page to second page, fixed 18s window, sequential alternating renderers',
    instrumentation: 'Identical rAF observer, PerformanceObserver long tasks, element-only MutationObserver scoped to text flaps (logo panels remain unchanged), whole-board CDP Performance metrics; no audio monkey patches',
    caveats: ['Headless Linux Chromium and CPU throttling do not reproduce Windows GPU/compositor behavior.',
      'rAF gaps measure main-thread callback opportunities, not displayed compositor frames.',
      'TaskDuration includes other browser main-thread work; ScriptDuration is seconds.',
      'Host load and browser scheduling cause run-to-run noise; compare all repeats and medians.',
      'Benchmarks measure a fixed 18s observation window, not shorter rotor duration; all 160ms steps are retained.'],
    comparisons, runs: results,
  };
  await writeFile(`${out}/flap-performance-benchmark.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: `${out}/flap-performance-benchmark.json`, comparisons }, null, 2));
} finally { await browser.close(); }
