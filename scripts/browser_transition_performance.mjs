// Compare immutable BEFORE/AFTER optimized builds, not legacy/optimized renderers.
// Serve a copied production dist, then set KORAIL_PERF_STAGE=baseline|candidate,
// KORAIL_PERF_ROOT=<served directory> and KORAIL_TEST_URL=<server URL>.
// KORAIL_PERF_OUTPUT_DIR selects a separate report directory for each experiment.
// Optional diagnostic filters: KORAIL_PERF_CPU_RATE=1|4 and KORAIL_PERF_SOUND=on|off.
// Diagnostic subsets cannot pass the full-matrix comparison command.
// KORAIL_PERF_STAGE=compare checks the two saved reports without launching a browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(process.env.KORAIL_PERF_OUTPUT_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url)));
const stage = process.env.KORAIL_PERF_STAGE || 'baseline';
assert.ok(['baseline', 'candidate', 'compare'].includes(stage));
const reportPath = name => join(out, `transition-performance-${name}.json`);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summaryKeys = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration',
  'firstFrameLatencyMs', 'frameGapP95Ms', 'frameGapP99Ms', 'maxFrameGapMs', 'framesAbove50Ms',
  'framesAbove50Fraction', 'longTaskCount', 'longTaskTotalMs', 'elementAdditions', 'elementRemovals'];
const summarize = runs => Object.fromEntries(summaryKeys.map(key => [key, median(runs.map(run => run[key]))]));

async function compare() {
  const [baseline, candidate] = await Promise.all(['baseline', 'candidate'].map(async name =>
    JSON.parse(await readFile(reportPath(name), 'utf8'))));
  for (const key of ['browser', 'repeats', 'windowMs', 'instrumentation']) assert.equal(candidate[key], baseline[key], `Different ${key}`);
  assert.deepEqual(candidate.viewport, baseline.viewport);
  assert.notEqual(baseline.partialMatrix, true, 'Baseline acceptance requires the full condition matrix');
  assert.notEqual(candidate.partialMatrix, true, 'Candidate acceptance requires the full condition matrix');
  assert.ok(baseline.repeats >= 3, 'Acceptance requires at least three repeats');
  const comparisons = [];
  for (const cpuRate of [1, 4]) for (const sound of [false, true]) {
    const rows = report => report.runs.filter(run => run.cpuRate === cpuRate && run.sound === sound);
    assert.equal(rows(baseline).length, baseline.repeats);
    assert.equal(rows(candidate).length, candidate.repeats);
    const before = summarize(rows(baseline)), after = summarize(rows(candidate));
    comparisons.push({ cpuRate, sound, before, after,
      scriptReductionPercent: (before.ScriptDuration - after.ScriptDuration) / before.ScriptDuration * 100,
      firstFrameDeltaMs: after.firstFrameLatencyMs - before.firstFrameLatencyMs,
      framesAbove50Delta: after.framesAbove50Ms - before.framesAbove50Ms });
  }
  const target = comparisons.find(row => row.cpuRate === 4 && row.sound);
  const acceptance = {
    condition: 'CPU 4x slowdown, sound enabled, medians of three or more runs; each guarded metric at most 110% of baseline',
    scriptDurationWithinTenPercent: target.after.ScriptDuration <= target.before.ScriptDuration * 1.1,
    firstFrameWithinTenPercent: target.after.firstFrameLatencyMs <= target.before.firstFrameLatencyMs * 1.1,
    framesAbove50WithinTenPercent: target.after.framesAbove50Ms <= target.before.framesAbove50Ms * 1.1,
  };
  const passed = Object.entries(acceptance).filter(([key]) => key !== 'condition').every(([, value]) => value);
  const result = { baseline: { report: reportPath('baseline'), provenance: baseline.provenance, executionNotes: baseline.executionNotes || [] },
    candidate: { report: reportPath('candidate'), provenance: candidate.provenance, executionNotes: candidate.executionNotes || [] },
    browser: baseline.browser, viewport: baseline.viewport, repeats: baseline.repeats, windowMs: baseline.windowMs,
    caveats: baseline.caveats, comparisons, acceptance: { ...acceptance, passed } };
  await writeFile(reportPath('comparison'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ report: reportPath('comparison'), comparisons, acceptance: result.acceptance }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function fingerprint(root) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const data = await readFile(join(root, path));
        files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  await visit();
  return { root, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    treeSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

async function measure() {
  const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:4173';
  assert.ok(process.env.KORAIL_PERF_ROOT, 'KORAIL_PERF_ROOT must identify the immutable build served by the URL');
  const root = resolve(process.env.KORAIL_PERF_ROOT);
  const provenance = { capturedAt: new Date().toISOString(), gitHead: process.env.KORAIL_PERF_GIT_HEAD ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    label: process.env.KORAIL_PERF_LABEL || stage, build: await fingerprint(root) };
  const servedIndex = await fetch(new URL('/index.html', base));
  assert.ok(servedIndex.ok, 'The benchmark server must serve the production index');
  assert.deepEqual(Buffer.from(await servedIndex.arrayBuffer()), await readFile(join(root, 'index.html')),
    'The URL must serve the specified immutable build');
  const repeats = Number(process.env.KORAIL_PERF_RUNS || 3), windowMs = 18000;
  assert.ok(Number.isInteger(repeats) && repeats > 0);
  const cpuRates = process.env.KORAIL_PERF_CPU_RATE ? [Number(process.env.KORAIL_PERF_CPU_RATE)] : [1, 4];
  assert.ok(cpuRates.every(rate => rate === 1 || rate === 4), 'KORAIL_PERF_CPU_RATE must be 1 or 4');
  const soundFilter = process.env.KORAIL_PERF_SOUND;
  assert.ok(soundFilter === undefined || soundFilter === 'on' || soundFilter === 'off', 'KORAIL_PERF_SOUND must be on or off');
  const soundModes = soundFilter === undefined ? [false, true] : [soundFilter === 'on'];
  const partialMatrix = cpuRates.length !== 2 || soundModes.length !== 2;
  const viewport = { width: 1440, height: 1080 };
  const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox'] });
  const results = [];
  const metricsMap = response => Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
  const instrumentation = 'Identical rAF observer, long-task PerformanceObserver, element-only MutationObserver on text flaps, whole-board CDP Performance counters; no audio monkey patches';
  try {
    for (const cpuRate of cpuRates) for (const sound of soundModes) for (let repeat = 0; repeat < repeats; repeat++) {
      const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        await cdp.send('Performance.enable');
        const url = new URL(base);
        url.search = '?demo=performance&renderer=optimized';
        await page.goto(url.href);
        await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => [...document.querySelectorAll('.rows .flap')].length > 0 &&
          [...document.querySelectorAll('.rows .flap')].every(leaf => leaf.dataset.flipping === 'false' &&
            (leaf.classList.contains('flap-panel') ? leaf.querySelector(':scope > .flap-top').innerHTML === leaf.querySelector(':scope > .flap-bottom').innerHTML
              : leaf.querySelector(':scope > .flap-top > span').textContent === leaf.dataset.value)), undefined, { timeout: 20000 });
        assert.ok(await page.locator('.flap-optimized').count() > 0, 'Optimized text renderer must be active in both builds');
        if (sound) {
          await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
          await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
        }
        await page.evaluate(() => {
          const root = document.querySelector('.rows');
          const probe = window.__transitionPerformance = { startedAt: 0, frameGaps: [], longTasks: [], elementAdditions: 0,
            elementRemovals: 0, raf: 0, previousFrame: 0, measuring: false,
            originalElements: [...root.querySelectorAll('.flap:not(.flap-panel), .flap:not(.flap-panel) *')] };
          const count = nodes => [...nodes].reduce((total, node) => total + (node.nodeType === Node.ELEMENT_NODE ? 1 + node.querySelectorAll('*').length : 0), 0);
          probe.mutations = new MutationObserver(records => {
            for (const record of records) { probe.elementAdditions += count(record.addedNodes); probe.elementRemovals += count(record.removedNodes); }
          });
          for (const leaf of root.querySelectorAll('.flap:not(.flap-panel)')) probe.mutations.observe(leaf, { subtree: true, childList: true });
          probe.longTaskObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (entry.startTime >= probe.startedAt && probe.measuring)
              probe.longTasks.push({ start: entry.startTime - probe.startedAt, duration: entry.duration });
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
          const probe = window.__transitionPerformance;
          probe.startedAt = performance.now(); probe.measuring = true;
          probe.raf = requestAnimationFrame(probe.frame);
          document.querySelector('[aria-label="다음 페이지"]').click();
          setTimeout(() => {
            const endedAt = performance.now();
            for (const entry of probe.longTaskObserver.takeRecords()) if (entry.startTime >= probe.startedAt)
              probe.longTasks.push({ start: entry.startTime - probe.startedAt, duration: entry.duration });
            probe.measuring = false; cancelAnimationFrame(probe.raf);
            probe.mutations.disconnect(); probe.longTaskObserver.disconnect();
            const sorted = [...probe.frameGaps].sort((a, b) => a - b);
            const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
            resolve({ elapsedMs: endedAt - probe.startedAt, firstFrameLatencyMs: probe.firstFrameLatencyMs, frames: sorted.length,
              frameGapP50Ms: percentile(.5), frameGapP95Ms: percentile(.95), frameGapP99Ms: percentile(.99), maxFrameGapMs: sorted.at(-1) ?? null,
              framesAbove50Ms: sorted.filter(gap => gap > 50).length, framesAbove50Fraction: sorted.filter(gap => gap > 50).length / sorted.length,
              longTaskCount: probe.longTasks.length, longTaskTotalMs: probe.longTasks.reduce((total, entry) => total + entry.duration, 0), longTasks: probe.longTasks,
              elementAdditions: probe.elementAdditions, elementRemovals: probe.elementRemovals,
              originalElementsStillConnected: probe.originalElements.filter(node => node.isConnected).length, originalElementCount: probe.originalElements.length,
              activeFlaps: document.querySelectorAll('.rows [data-flipping="true"]').length,
              mismatches: [...document.querySelectorAll('.rows .flap:not(.flap-panel)')].filter(leaf => leaf.querySelector(':scope > .flap-top > span').textContent !== leaf.dataset.value).length,
              panelMismatches: [...document.querySelectorAll('.rows .flap-panel')].filter(leaf => leaf.querySelector(':scope > .flap-top').innerHTML !== leaf.querySelector(':scope > .flap-bottom').innerHTML).length,
              activeAnimations: document.getAnimations().filter(animation => animation.playState === 'running' || animation.playState === 'pending').length });
          }, duration);
        }), windowMs);
        const after = metricsMap(await cdp.send('Performance.getMetrics'));
        const counters = Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(name => [name, after[name] - before[name]]));
        const result = { stage, renderer: 'optimized', cpuRate, sound, repeat: repeat + 1, ...observed, ...counters, pageErrors: errors };
        assert.equal(result.activeFlaps, 0, 'All flaps finish in the observation window');
        assert.equal(result.mismatches, 0); assert.equal(result.panelMismatches, 0); assert.deepEqual(errors, []);
        assert.equal(result.elementAdditions, 0); assert.equal(result.elementRemovals, 0);
        assert.equal(result.originalElementsStillConnected, result.originalElementCount); assert.equal(result.activeAnimations, 0);
        results.push(result);
        await writeFile(join(out, `transition-performance-${stage}-runs.json`), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ stage, run: results.length, total: repeats * cpuRates.length * soundModes.length, cpuRate, sound,
          scriptMs: Number((result.ScriptDuration * 1000).toFixed(2)), firstFrameMs: result.firstFrameLatencyMs,
          maxGapMs: result.maxFrameGapMs, framesAbove50Ms: result.framesAbove50Ms }));
      } finally { await context.close(); }
    }
    assert.equal((await fingerprint(root)).treeSha256, provenance.build.treeSha256, 'Served build changed during measurement');
    const report = { stage, browser: await browser.version(), base, viewport, repeats, windowMs, provenance,
      conditions: { cpuRates, soundModes }, partialMatrix,
      executionNotes: process.env.KORAIL_PERF_NOTES ? [process.env.KORAIL_PERF_NOTES] : [],
      scenario: 'Optimized production renderer, archived latest 10-row snapshot, first page to second page, fixed 18-second observation',
      instrumentation,
      caveats: ['Headless Linux Chromium and simulated CPU slowdown do not reproduce Windows GPU/compositor/audio hardware.',
        'rAF gaps measure main-thread callback opportunities, not displayed compositor FPS.',
        'ScriptDuration and other CDP duration counters are seconds; frame/long-task metrics are milliseconds.',
        'Host load and scheduling cause run-to-run noise; compare all repeats and medians.',
        'Baseline and candidate are immutable builds measured sequentially; reported build fingerprints verify provenance.',
        'All 160ms rotor steps and the same 18-second observation window are retained.'],
      runs: results };
    await writeFile(reportPath(stage), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: reportPath(stage), runs: results.length, treeSha256: provenance.build.treeSha256 }));
  } finally { await browser.close(); }
}

await mkdir(out, { recursive: true });
if (stage === 'compare') await compare();
else await measure();
