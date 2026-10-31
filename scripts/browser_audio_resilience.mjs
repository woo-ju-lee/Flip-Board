// Production-browser audio regression checks. No application test hooks or
// mocked AudioContext: stalls block JS while a parallel AudioWorklet meters PCM.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:4174';
const out = process.env.KORAIL_ARTIFACT_DIR ? resolve(process.env.KORAIL_ARTIFACT_DIR)
  : fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const settled = () => [...document.querySelectorAll('.rows .flap')].length > 0
  && [...document.querySelectorAll('.rows .flap')].every(cell => cell.dataset.flipping === 'false'
    && (cell.classList.contains('flap-panel')
      ? cell.querySelector(':scope > .flap-top').innerHTML === cell.querySelector(':scope > .flap-bottom').innerHTML
      : cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value));
const summarize = (voices, cueImpact) => {
  const intervals = voices.map(voice => ({
    start: Math.max(voice.when, voice.contextTime),
    end: Math.min(voice.when + voice.duration / voice.rate, voice.stopped ?? Infinity),
    impact: voice.when + cueImpact / voice.rate,
  }));
  const edges = intervals.filter(voice => voice.end > voice.start)
    .flatMap(voice => [[voice.start, 1], [voice.end, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, maxAudibleVoices = 0;
  for (const [, delta] of edges) { active += delta; maxAudibleVoices = Math.max(active, maxAudibleVoices); }
  const impacts = intervals.filter(voice => voice.impact >= voice.start && voice.impact < voice.end)
    .map(voice => voice.impact).sort((a, b) => a - b);
  const gaps = impacts.slice(1).map((impact, i) => (impact - impacts[i]) * 1000);
  return { sources: voices.length, audibleImpacts: impacts.length, maxAudibleVoices,
    minImpactGapMs: gaps.length ? Math.min(...gaps) : null,
    worstPastStartMs: Math.max(0, ...voices.map(voice => (voice.contextTime - voice.when) * 1000)) };
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'no-preference' });
  await installAudioProbe(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?demo=performance&renderer=optimized`);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(settled, undefined, { timeout: 22000 });
  const manifest = await (await page.request.get(`${base}/audio/split-flap.json`)).json();
  const cueImpact = manifest.cues.find(cue => cue.kind === 'flip').impact;
  assert.equal(typeof cueImpact, 'number');
  await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
  await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
  await page.evaluate(() => __flapAudioProbe.preparePcmMeter());
  // Let the native worklet and audio clock finish startup before capture.
  await page.waitForTimeout(250);
  const scenarios = [];
  for (const volume of [30, 100]) {
    await page.getByLabel('사운드 설정', { exact: true }).click();
    await page.getByRole('slider', { name: '효과음 음량' }).fill(String(volume));
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      __flapAudioProbe.starts = [];
      await __flapAudioProbe.startPcmCapture({ windows: true });
      __flapAudioProbe.startRecording();
    });
    await page.getByRole('button', { name: volume === 30 ? '다음 페이지' : '이전 페이지', exact: true }).click();
    const stalls = [];
    for (const duration of [100, 200, 300, 400]) {
      await page.waitForTimeout(250);
      stalls.push(await page.evaluate(milliseconds => {
        const start = performance.now();
        const contextStart = __flapAudioProbe.contexts[0].currentTime;
        while (performance.now() - start < milliseconds) { /* Deliberate test-only JS stall. */ }
        return { requestedMs: milliseconds, actualMs: performance.now() - start,
          contextAdvanceMs: (__flapAudioProbe.contexts[0].currentTime - contextStart) * 1000,
          endedWallTime: (performance.timeOrigin + performance.now()) / 1000 };
      }, duration));
    }
    await page.waitForFunction(settled, undefined, { timeout: 22000 });
    await page.waitForTimeout(200);
    const pcm = await page.evaluate(() => __flapAudioProbe.stopPcmCapture());
    await writeFile(`${out}/audio-resilience-pcm-${volume}.json`, JSON.stringify(pcm));
    const { rmsWindows, renderFrameDiscontinuities, ...pcmSummary } = pcm;
    const maxForwardRenderFrameGap = Math.max(0, ...renderFrameDiscontinuities.map(block => block.actual - block.expected));
    const maxStaleRenderFrames = Math.max(0, ...renderFrameDiscontinuities.map(block => block.expected - block.actual));
    const endFrameCountError = Math.abs((pcm.reportedCaptureEndTime - pcm.captureEndTime) * pcm.sampleRate);
    const recording = await page.evaluate(() => __flapAudioProbe.stopRecording());
    const voices = await page.evaluate(() => __flapAudioProbe.starts);
    const metrics = summarize(voices, cueImpact);
    assert.ok(metrics.audibleImpacts > 10, 'The transition must actually produce sound');
    assert.ok(voices.filter(voice => voice.wallTime > stalls.at(-1).endedWallTime).length > 10,
      'Valid future impacts must resume after the final stall');
    assert.ok(metrics.maxAudibleVoices <= 8, JSON.stringify(metrics));
    assert.ok(metrics.minImpactGapMs >= 25 - .001, JSON.stringify(metrics));
    // currentTime is sampled on the main thread and quantized to audio blocks.
    // Allow at most one block at the native-call boundary, never an overdue burst.
    const quantumMs = 128 / pcm.sampleRate * 1000;
    assert.ok(metrics.worstPastStartMs <= quantumMs + .001, JSON.stringify(metrics));
    assert.ok(pcm.samples > pcm.sampleRate && pcm.nonzeroSamples > 1000, JSON.stringify(pcm));
    assert.equal(pcm.clippedSamples, 0, JSON.stringify(pcm));
    assert.equal(pcm.nonFiniteSamples, 0, JSON.stringify(pcmSummary));
    assert.equal(maxForwardRenderFrameGap, 0, 'PCM capture must not have unmeasured forward gaps');
    assert.ok(maxStaleRenderFrames <= pcm.sampleRate * .020, 'PCM metadata staleness must remain bounded');
    assert.ok(endFrameCountError <= 128 + .001, 'Captured frames must span the reported capture interval');
    assert.ok(pcm.peak > .0001 && pcm.peak < 1, JSON.stringify(pcm));
    assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
    await writeFile(`${out}/audio-resilience-${volume}.webm`, Buffer.from(recording));
    scenarios.push({ volume, stalls, ...metrics,
      pcm: { ...pcmSummary, rms: Math.sqrt(pcm.sumSquares / pcm.samples),
        rmsWindowCount: rmsWindows.length, renderFrameDiscontinuityCount: renderFrameDiscontinuities.length,
        maxForwardRenderFrameGap, maxStaleRenderFrames, endFrameCountError, rawWindows: `audio-resilience-pcm-${volume}.json` },
      recording: `audio-resilience-${volume}.webm` });
    await writeFile(`${out}/audio-resilience-progress.json`, JSON.stringify({
      status: 'running', completedVolumeScenarios: scenarios,
    }, null, 2));
  }

  // Retarget repeatedly while samples are active, then cancel all output. Keep
  // requested stop times so the 8 ms fade remains part of the overlap count.
  await page.evaluate(() => { __flapAudioProbe.starts = []; });
  for (const direction of ['다음 페이지', '이전 페이지', '다음 페이지']) {
    await page.getByRole('button', { name: direction, exact: true }).click();
    await page.waitForTimeout(230);
  }
  await page.waitForFunction(() => {
    const now = __flapAudioProbe.contexts[0].currentTime;
    const playing = __flapAudioProbe.starts.some(voice => voice.when <= now
      && Math.min(voice.when + voice.duration / voice.rate, voice.stopped ?? Infinity) > now + .012);
    const future = __flapAudioProbe.starts.some(voice => voice.when > now + .015
      && (voice.stopped ?? Infinity) > voice.when && !voice.ended);
    // Cancel in this same browser task. A round trip to Playwright could let
    // the future source start before the click, losing coverage of this branch.
    if (playing && future) {
      document.querySelector('[aria-label="소리 끄기"]').click();
      return true;
    }
    return false;
  }, undefined, { timeout: 5000, polling: 5 });
  const mutedStarts = await page.evaluate(() => __flapAudioProbe.starts.length);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
  assert.ok(await page.evaluate(() => __flapAudioProbe.peak()) < .00001);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => __flapAudioProbe.starts.length), mutedStarts);
  const cancelled = await page.evaluate(() => __flapAudioProbe.starts);
  const fades = cancelled.flatMap(voice => voice.stopRequests
    .filter(stop => voice.when <= stop.calledAt && voice.when + voice.duration / voice.rate > stop.calledAt)
    .map(stop => (stop.effectiveAt - stop.calledAt) * 1000));
  assert.ok(fades.some(duration => duration > 7 && duration <= 8.001), `No 8ms active fade observed: ${fades}`);
  assert.ok(fades.every(duration => duration >= 0 && duration <= 8.001), JSON.stringify(fades));
  const futureStops = cancelled.flatMap(voice => voice.stopRequests.filter(stop => voice.when > stop.calledAt));
  assert.ok(futureStops.length > 0, 'Retargeting must exercise future-source cancellation');
  assert.ok(futureStops.every(stop => stop.effectiveAt === stop.calledAt));
  const cancellation = { ...summarize(cancelled, cueImpact), fadesMs: fades, futureCancellations: futureStops.length };
  assert.ok(cancellation.maxAudibleVoices <= 8, JSON.stringify(cancellation));

  await page.waitForFunction(settled, undefined, { timeout: 22000 });
  await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
  await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenStarts = await page.evaluate(() => __flapAudioProbe.starts.length);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
  assert.ok(await page.evaluate(() => __flapAudioProbe.peak()) < .00001);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => __flapAudioProbe.starts.length), hiddenStarts);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(settled, undefined, { timeout: 3000 });
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), base, viewport: { width: 1440, height: 1080 },
    instrumentation: 'Real bundled MP3 and live AudioContext; all output PCM counted by a silent parallel AudioWorklet tap; requested/effective source stop times include fade tails',
    caveats: ['Headless Linux Chromium; no physical Windows device or speaker/headphone measurement.',
      'Source timestamps verify scheduled impacts. PCM peak/clipping is measured before hardware output.',
      'Native start deadline assertion permits one 128-sample rendering quantum at the call boundary; impact spacing permits only 0.001ms floating-point tolerance.'],
    scenarios, cancellation, checks: ['100/200/300/400ms main-thread stalls do not bunch impact starts',
      '30% and 100% output have zero clipped PCM samples', 'Retargeting and mute cancel futures immediately and fade active sources within 8ms',
      'Hidden tab cancels sound and pending movement without replay on return'], pageErrors: errors };
  await writeFile(`${out}/audio-resilience-validation.json`, JSON.stringify(report, null, 2));
  await writeFile(`${out}/audio-resilience-progress.json`, JSON.stringify({
    status: 'passed', completedVolumeScenarios: scenarios,
  }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
