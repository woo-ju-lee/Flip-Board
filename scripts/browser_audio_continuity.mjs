// Real Web Audio continuity test with fixed input, independent of train-page
// density. Fixture bundles are test-only and never enter the production app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAudioProbe } from './audio_probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.KORAIL_ARTIFACT_DIR ? resolve(process.env.KORAIL_ARTIFACT_DIR)
  : join(root, 'artifacts/audio-continuity');
const fixtures = join(out, 'continuity-fixtures');
const raw = join(out, 'continuity-raw');
await Promise.all([mkdir(fixtures, { recursive: true }), mkdir(raw, { recursive: true })]);
const baselineArchive = process.env.KORAIL_AUDIO_BASELINE_SOURCE
  || join(root, 'artifacts/audio-continuity/baseline-source.tar.gz');
const baselineSource = join(fixtures, 'baseline-source');
await mkdir(baselineSource, { recursive: true });
execFileSync('tar', ['-xzf', baselineArchive, '-C', baselineSource,
  'frontend/src/audio.ts', 'frontend/src/audioPolicy.ts', 'frontend/src/flapMotion.ts']);
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
const provenance = [];
for (const [label, engine] of [
  ['baseline', join(baselineSource, 'frontend/src/audio.ts')],
  ['candidate', join(root, 'frontend/src/audio.ts')],
]) {
  const contents = await readFile(engine, 'utf8');
  const lookaheadMs = Number(contents.match(/const LOOKAHEAD_MS = (\d+)/)?.[1]);
  assert.equal(lookaheadMs, label === 'baseline' ? 90 : 500, 'Use the actual frozen90ms and candidate500ms engines');
  const sourceHashes = {};
  for (const name of ['audio.ts', 'audioPolicy.ts', 'flapMotion.ts']) {
    sourceHashes[name] = createHash('sha256').update(await readFile(join(dirname(engine), name))).digest('hex');
  }
  provenance.push({ label, lookaheadMs, sourceHashes });
  await build({ entryPoints: [join(root, 'scripts/fixtures/audio_continuity.ts')],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    outfile: join(fixtures, `${label}.js`), define: { 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'actual-audio-engine', setup(builder) {
      builder.onResolve({ filter: /^__AUDIO_ENGINE__$/ }, () => ({ path: engine }));
    } }], logLevel: 'silent' });
  await writeFile(join(fixtures, `${label}.html`),
    `<!doctype html><meta charset="utf-8"><title>Audio continuity fixture — ${label}</title><button id="enable">Enable test audio</button><script type="module" src="/${label}.js"></script>`);
}
const manifest = JSON.parse(await readFile(join(root, 'frontend/public/audio/split-flap.json'), 'utf8'));
const cueImpact = manifest.cues.find(cue => cue.kind === 'flip').impact;
assert.equal(typeof cueImpact, 'number');
const allowed = new Map([
  ...['baseline', 'candidate'].flatMap(label => ['html', 'js'].map(extension =>
    [`/${label}.${extension}`, join(fixtures, `${label}.${extension}`)])),
  ['/audio/split-flap.json', join(root, 'frontend/public/audio/split-flap.json')],
  [`/audio/${manifest.file}`, join(root, 'frontend/public/audio', manifest.file)],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const path = allowed.get(pathname);
  if (!path) { response.writeHead(404).end(); return; }
  try {
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.html') ? 'text/html'
      : path.endsWith('.json') ? 'application/json' : 'audio/mpeg';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(await readFile(path));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureBase = `http://127.0.0.1:${server.address().port}`;
const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const scenarios = [];
const audits = [];
const QUIET_THRESHOLD_DBFS = -55;
const CONTEXT_WARMUP_MS = 250;
const quietThreshold = 10 ** (QUIET_THRESHOLD_DBFS / 20);

function analyze(voices, pcm, plan, label) {
  const intervals = voices.map(voice => ({
    start: Math.max(voice.when, voice.contextTime),
    end: Math.min(voice.when + voice.duration / voice.rate, voice.stopped ?? Infinity),
    impact: voice.when + cueImpact / voice.rate,
    originalClockImpact: voice.performanceTime + (voice.when + cueImpact / voice.rate - voice.contextTime) * 1000,
  }));
  const impacts = intervals.filter(voice => voice.impact >= voice.start && voice.impact < voice.end)
    .map(voice => voice.impact).sort((a, b) => a - b);
  const edges = intervals.filter(voice => voice.end > voice.start)
    .flatMap(voice => [[voice.start, 1], [voice.end, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, maxAudibleVoices = 0;
  for (const [, change] of edges) { active += change; maxAudibleVoices = Math.max(active, maxAudibleVoices); }
  const gaps = impacts.slice(1).map((impact, index) => (impact - impacts[index]) * 1000);
  const expected = plan.targets;
  const played = intervals.filter(voice => voice.impact >= voice.start && voice.impact < voice.end);
  const wallMatches = played.map(voice => {
    const index = Math.round((voice.originalClockImpact - expected[0]) / plan.spacingMs) || 0;
    return { index, errorMs: index >= 0 && index < expected.length ? voice.originalClockImpact - expected[index] : Infinity };
  });
  const firstIndex = label === 'candidate' && plan.phase === 'prefilled' ? 0 : wallMatches[0].index;
  const nativeOrigin = played[0].impact;
  const nativeMatches = played.map(voice => {
    const index = firstIndex + Math.round((voice.impact - nativeOrigin) * 1000 / plan.spacingMs);
    return { index, errorMs: index >= 0 && index < expected.length
      ? (voice.impact - nativeOrigin) * 1000 - (expected[index] - expected[firstIndex]) : Infinity };
  });
  const matches = label === 'candidate' ? nativeMatches : wallMatches;
  // The candidate keeps a stable native timeline. Baseline diagnostics use
  // each booking's contemporaneous clock pair, including its old clock jitter,
  // and edge bookings' pairs for the intended activity boundaries.
  const clockOffset = voice => voice.contextTime - voice.performanceTime / 1000;
  const activityStart = label === 'candidate' ? nativeOrigin + (expected[0] - expected[firstIndex]) / 1000
    : expected[0] / 1000 + clockOffset(voices[0]);
  const activityEnd = label === 'candidate' ? nativeOrigin + (expected.at(-1) - expected[firstIndex]) / 1000
    : expected.at(-1) / 1000 + clockOffset(voices.at(-1));
  // Only intentional canceled intervals are excluded; ordinary scheduler gaps
  // remain in the measurement. Fixed fixtures do not cancel during this range.
  const cancelled = voices.flatMap(voice => (voice.stopRequests || [])
    .filter(stop => stop.effectiveAt < voice.when + voice.duration / voice.rate)
    .map(stop => ({ start: stop.calledAt, end: voice.when + voice.duration / voice.rate })));
  const windows = pcm.rmsWindows.filter(window => window.at >= activityStart
    && window.at + window.duration <= activityEnd
    && !cancelled.some(interval => window.at < interval.end && window.at + window.duration > interval.start))
    .slice(1, -1); // Exclude the first/last complete windows at the activity boundary.
  let quiet = 0, longestQuietMs = 0, previousEnd = null;
  let coveredMs = 0, maxWindowGapMs = 0;
  for (const window of windows) {
    coveredMs += window.duration * 1000;
    if (previousEnd !== null) maxWindowGapMs = Math.max(maxWindowGapMs, (window.at - previousEnd) * 1000);
    if (previousEnd !== null && window.at - previousEnd > 1.5 / pcm.sampleRate) quiet = 0;
    quiet = window.rms < quietThreshold ? quiet + window.duration * 1000 : 0;
    longestQuietMs = Math.max(longestQuietMs, quiet);
    previousEnd = window.at + window.duration;
  }
  return { sources: voices.length, impacts: impacts.length, nativePrefillSources: plan.prefill.nativeSources,
    missingTargets: label === 'baseline' ? expected.length - impacts.length : expected.length - new Set(matches.map(match => match.index)).size,
    missingTargetsMethod: label === 'baseline' ? 'original count minus actual audible native impacts' : 'unique fixed-native-timeline target indices',
    minImpactGapMs: gaps.length ? Math.min(...gaps) : null,
    maxImpactGapMs: gaps.length ? Math.max(...gaps) : null,
    originalTimestampReference: label === 'candidate' ? 'fixed native timeline from first valid booking' : 'old per-tick performance/audio mapping',
    firstValidTargetIndex: firstIndex,
    firstBookingNearestWallTargetIndex: wallMatches[0].index,
    firstBookingWallClockErrorMs: wallMatches[0].errorMs,
    maxWallClockTargetErrorMs: Math.max(...wallMatches.map(match => Math.abs(match.errorMs))),
    maxNativeTimelineErrorMs: Math.max(...nativeMatches.map(match => Math.abs(match.errorMs))),
    uniqueOriginalTargets: new Set(matches.map(match => match.index)).size === matches.length,
    firstImpactDelayFromPlanMs: played[0].originalClockImpact - expected[0],
    worstPastStartMs: Math.max(0, ...voices.map(voice => (voice.contextTime - voice.when) * 1000)),
    maxAudibleVoices, longestQuietMs, analyzedRmsWindows: windows.length,
    rmsCoverageMs: coveredMs, activityDurationMs: (activityEnd - activityStart) * 1000, maxRmsWindowGapMs: maxWindowGapMs,
    quietThresholdDbfs: QUIET_THRESHOLD_DBFS, windowMs: 10,
    pcmPeak: pcm.peak, clippedSamples: pcm.clippedSamples, nonFiniteSamples: pcm.nonFiniteSamples,
    maxForwardRenderFrameGap: Math.max(0, ...pcm.renderFrameDiscontinuities.map(block => block.actual - block.expected)),
    maxStaleRenderFrames: Math.max(0, ...pcm.renderFrameDiscontinuities.map(block => block.expected - block.actual)),
    endFrameCountError: Math.abs((pcm.reportedCaptureEndTime - pcm.captureEndTime) * pcm.sampleRate),
    exclusion: { activityStart, activityEnd,
      firstAndLastCompleteWindow: true, cancelledIntervals: cancelled },
  };
}

function validateFixedScenario({ name, pcm, plan, metrics, result, quantumMs, originalTimestampToleranceMs, label, volume, stallMs, phase }) {
  assert.ok(pcm.samples > pcm.sampleRate && pcm.nonzeroSamples > 1000, name);
  assert.equal(pcm.clippedSamples, 0, name);
  assert.equal(pcm.nonFiniteSamples, 0, name);
  assert.equal(metrics.exclusion.cancelledIntervals.length, 0, 'Fixed fixtures must not hide discontinuities behind cancellation exclusions');
  assert.ok(metrics.analyzedRmsWindows > 0, JSON.stringify(result));
  assert.ok(metrics.rmsCoverageMs >= metrics.activityDurationMs - 40 - .001, JSON.stringify(result));
  assert.ok(metrics.maxRmsWindowGapMs <= 1.5 / pcm.sampleRate * 1000, JSON.stringify(result));
  assert.equal(metrics.maxForwardRenderFrameGap, 0, 'Forward render-frame gaps leave unmeasured audio: ' + JSON.stringify(result));
  assert.ok(metrics.maxStaleRenderFrames <= result.allowedStaleRenderFrames, JSON.stringify(result));
  assert.ok(metrics.endFrameCountError <= 128 + .001, JSON.stringify(result));
  assert.ok(metrics.maxAudibleVoices <= 8, JSON.stringify(result));
  assert.ok(metrics.minImpactGapMs >= 25 - .001, JSON.stringify(result));
  assert.ok(Math.abs(result.audioClockShortfallMs) <= 20, 'Audio clock must advance during the wall-clock stall: ' + JSON.stringify(result));
  if (label === 'candidate') {
    assert.ok(metrics.uniqueOriginalTargets, JSON.stringify(result));
    assert.ok(metrics.maxNativeTimelineErrorMs <= .001, JSON.stringify(result));
    assert.ok(Math.abs(metrics.firstBookingWallClockErrorMs) <= originalTimestampToleranceMs, JSON.stringify(result));
    if (phase === 'prefilled') {
      assert.equal(metrics.firstBookingNearestWallTargetIndex, 0, 'The first native impact must be original target0, not a shifted dense sequence');
      assert.ok(Math.abs(metrics.firstImpactDelayFromPlanMs) <= originalTimestampToleranceMs, JSON.stringify(result));
    }
  } else {
    // The old per-tick clock transform is the measured defect. Preserve this
    // diagnostic without requiring baseline to pass candidate correctness.
    result.wallClockMappingWithinCalibration = metrics.maxWallClockTargetErrorMs <= originalTimestampToleranceMs;
    result.reconstructedTargetIndicesAmbiguous = !metrics.uniqueOriginalTargets
      || metrics.maxWallClockTargetErrorMs >= plan.spacingMs / 2;
  }
  assert.ok(metrics.worstPastStartMs <= quantumMs + .001, JSON.stringify(result));
  if (phase === 'prefilled') assert.ok(plan.prefill.nativeSources > 0, 'Stall must begin after native booking');
  else assert.equal(plan.prefill.nativeSources, 0, 'Limitation case must block before the engine flush');
  if (label === 'candidate' && phase === 'prefilled' && stallMs <= 400) {
    assert.equal(metrics.missingTargets, 0, JSON.stringify(result));
    assert.ok(metrics.maxImpactGapMs <= 50, JSON.stringify(result));
    const control = scenarios.find(row => row.label === label && row.volume === volume && row.stallMs === 0);
    result.quietIncreaseVsControlMs = metrics.longestQuietMs - control.longestQuietMs;
    assert.ok(result.quietIncreaseVsControlMs <= 50, JSON.stringify(result));
  }
  if (label === 'candidate' && (stallMs === 800 || phase === 'before-microtask')) {
    assert.ok(metrics.missingTargets > 0, 'Oversized/pre-booking stall must report its audible limitation');
    result.expectedGracefulLoss = true;
  }
}

async function fixedScenario(label, volume, stallMs, phase) {
  const page = await browser.newPage();
  const name = `${label}-${volume}-${phase}-${stallMs}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await installAudioProbe(page);
    await page.goto(`${fixtureBase}/${label}.html`);
    await page.getByRole('button', { name: 'Enable test audio' }).click();
    await page.waitForFunction(() => __audioFixture.enabled || __audioFixture.error);
    assert.equal(await page.evaluate(() => __audioFixture.error), null);
    await page.evaluate(() => __flapAudioProbe.preparePcmMeter());
    let clockCalibration, observedStepMs;
    const calibrationAttempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      clockCalibration = await page.evaluate(duration => {
        const context = __flapAudioProbe.contexts[0];
        const started = performance.now();
        let previous = context.currentTime;
        const reads = [{ performanceTime: started, audioTime: previous }];
        // Directly sample publications while the audio thread runs. Timer
        // polling can skip publications and mistake its own delay for a large
        // native clock step. This warmup ends before capture or event planning.
        while (performance.now() - started < duration) {
          const current = context.currentTime;
          if (current !== previous) {
            reads.push({ performanceTime: performance.now(), audioTime: current });
            previous = current;
          }
        }
        return { method: '250ms direct sampling; record changed currentTime values only',
          warmupMs: performance.now() - started, baseLatency: context.baseLatency,
          outputLatency: context.outputLatency ?? null, sampleRate: context.sampleRate, reads };
      }, CONTEXT_WARMUP_MS);
      observedStepMs = Math.max(...clockCalibration.reads.slice(1).map((read, index) =>
        (read.audioTime - clockCalibration.reads[index].audioTime) * 1000));
      calibrationAttempts.push({ ...clockCalibration, observedStepMs });
      if (clockCalibration.reads.length >= 10 && observedStepMs > 0 && observedStepMs <= 20) break;
    }
    await writeFile(join(raw, `${name}-clock-calibration.json`), JSON.stringify(calibrationAttempts, null, 2));
    const quantumMs = 128 / clockCalibration.sampleRate * 1000;
    assert.ok(clockCalibration.reads.length >= 10 && observedStepMs > 0 && observedStepMs <= 20,
      `Clock calibration is too coarse to verify original30ms targets: ${observedStepMs}ms`);
    // currentTime may be published in multi-quantum driver batches (observed
    // 3x128 samples), not in single128-sample increments. This tolerance only
    // relates the tick and source-call clock samples; native gap bounds stay exact.
    const originalTimestampToleranceMs = Math.max(quantumMs, observedStepMs) + .25;
    await page.evaluate(async () => {
      __flapAudioProbe.starts = [];
      await __flapAudioProbe.startPcmCapture({ windows: true });
    });
    const plan = await page.evaluate(options => __audioFixture.run(options), { volume, stallMs, phase });
    const pcm = await page.evaluate(() => __flapAudioProbe.stopPcmCapture());
    const voices = await page.evaluate(() => __flapAudioProbe.starts);
    const metrics = analyze(voices, pcm, plan, label);
    const audioClockAdvanceMs = (plan.stall.audioEnd - plan.stall.audioStart) * 1000;
    await writeFile(join(raw, `${name}.json`), JSON.stringify({ label, volume, stallMs, phase,
      clockCalibration, originalTimestampToleranceMs, plan, voices, pcm, metrics }, null, 2));
    const result = { label, volume, stallMs, phase, ...metrics, observedClockStepMs: observedStepMs,
      originalTimestampToleranceMs, allowedStaleRenderFrames: Math.ceil(observedStepMs / 1000 * pcm.sampleRate - 1e-6), audioClockAdvanceMs,
      audioClockShortfallMs: plan.stall.actualMs - audioClockAdvanceMs,
      raw: `continuity-raw/${name}.json` };
    scenarios.push(result);
    await writeFile(join(out, 'audio-continuity-progress.json'), JSON.stringify({ status: 'running', provenance, scenarios }, null, 2));
    assert.deepEqual(errors, []);
    validateFixedScenario({ name, pcm, plan, metrics, result, quantumMs, originalTimestampToleranceMs, label, volume, stallMs, phase });
    console.log(JSON.stringify({ label, volume, stallMs, phase, maxGapMs: metrics.maxImpactGapMs,
      quietMs: metrics.longestQuietMs, nativePrefill: plan.prefill.nativeSources,
      missedTargets: metrics.missingTargets, peak: pcm.peak }));
  } finally { await page.close(); }
}

async function productionAudit(label, base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await installAudioProbe(page);
    await page.goto(`${base}/?demo=performance&renderer=optimized`);
    await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelectorAll('.rows .flap').length > 0
      && [...document.querySelectorAll('.rows .flap')].every(cell => cell.dataset.flipping === 'false'
        && (cell.classList.contains('flap-panel')
          ? cell.querySelector(':scope > .flap-top').innerHTML === cell.querySelector(':scope > .flap-bottom').innerHTML
            && (!cell.dataset.value || Boolean(cell.querySelector(':scope > .flap-top .train-logo-art')))
          : cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value)),
    undefined, { timeout: 22000 });
    await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
    await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
    await page.evaluate(() => { __flapAudioProbe.starts = []; __flapAudioProbe.beginAnimationAudit(); });
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
    await page.waitForFunction(() => __flapAudioProbe.animationAudit.firstAnimation
      && __flapAudioProbe.animationAudit.firstNativeSource, undefined, { timeout: 5000 });
    const audit = await page.evaluate(() => __flapAudioProbe.animationAudit);
    const result = { label, base, ...audit, nativeBeforeFirstAnimation:
      audit.firstNativeSource.at <= audit.firstAnimation.at && audit.firstAnimation.nativeSourcesBeforeAnimation > 0 };
    audits.push(result);
    await writeFile(join(out, 'audio-continuity-animation-audit.json'), JSON.stringify(audits, null, 2));
    if (label === 'candidate') assert.ok(result.nativeBeforeFirstAnimation, JSON.stringify(result));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

try {
  const resumeCandidate = process.argv.includes('--resume-candidate');
  const auditOnly = process.argv.includes('--audit-only');
  if (resumeCandidate || auditOnly) {
    // Revalidate raw samples, native starts, and source hashes instead of rerunning
    // already-passing candidate cases when a baseline-only observation failed.
    const previous = JSON.parse(await readFile(join(out, auditOnly ? 'audio-continuity-validation.json' : 'audio-continuity-progress.json'), 'utf8'));
    assert.deepEqual(previous.provenance, provenance, 'Resume requires exactly the same engine source hashes');
    const saved = previous.scenarios.filter(row => auditOnly || row.label === 'candidate');
    assert.equal(saved.length, auditOnly ? 28 : 14, 'Resume requires every completed fixture for its requested labels');
    const keys = new Set();
    for (const row of saved) {
      const name = `${row.label}-${row.volume}-${row.phase}-${row.stallMs}`;
      assert.ok(!keys.has(name)); keys.add(name);
      const evidence = JSON.parse(await readFile(join(out, row.raw), 'utf8'));
      const metrics = analyze(evidence.voices, evidence.pcm, evidence.plan, row.label);
      const result = { ...row, ...metrics, reusedValidatedRawEvidence: true };
      scenarios.push(result);
      validateFixedScenario({ name, pcm: evidence.pcm, plan: evidence.plan, metrics, result,
        quantumMs: 128 / evidence.pcm.sampleRate * 1000,
        originalTimestampToleranceMs: evidence.originalTimestampToleranceMs,
        label: row.label, volume: row.volume, stallMs: row.stallMs, phase: row.phase });
    }
    for (const label of auditOnly ? ['candidate', 'baseline'] : ['candidate']) for (const volume of [30, 100]) {
      for (const stallMs of [0, 100, 200, 300, 400, 800]) assert.ok(keys.has(`${label}-${volume}-prefilled-${stallMs}`));
      assert.ok(keys.has(`${label}-${volume}-before-microtask-400`));
    }
    console.log(`Revalidated all ${saved.length} saved fixtures against unchanged engine source hashes.`);
  }
  for (const label of auditOnly ? [] : resumeCandidate ? ['baseline'] : ['candidate', 'baseline']) for (const volume of [30, 100]) {
    for (const stallMs of [0, 100, 200, 300, 400, 800]) await fixedScenario(label, volume, stallMs, 'prefilled');
    await fixedScenario(label, volume, 400, 'before-microtask');
  }
  await productionAudit('baseline', process.env.KORAIL_BASELINE_URL || 'http://127.0.0.1:4173');
  await productionAudit('candidate', process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000');
  const comparisons = scenarios.filter(row => row.label === 'candidate').map(candidate => {
    const baseline = scenarios.find(row => row.label === 'baseline' && row.volume === candidate.volume
      && row.stallMs === candidate.stallMs && row.phase === candidate.phase);
    return { volume: candidate.volume, stallMs: candidate.stallMs, phase: candidate.phase,
      baseline: { maxImpactGapMs: baseline.maxImpactGapMs, longestQuietMs: baseline.longestQuietMs, missingTargets: baseline.missingTargets },
      candidate: { maxImpactGapMs: candidate.maxImpactGapMs, longestQuietMs: candidate.longestQuietMs, missingTargets: candidate.missingTargets } };
  });
  const report = { status: 'passed', browser: await browser.version(), provenance, contextWarmupMs: CONTEXT_WARMUP_MS,
    fixture: '67 original impact timestamps, first+70ms then every30ms; rate1.0; bundled Vestaboard recording; native AudioContext and source bookings',
    continuity: 'Candidate0–400ms post-prefill stalls preserve every fixed-input impact, maxgap<=50ms, and longestquiet increase<=50ms vs unstalled same-volume control',
    pcm: 'Every rendered sample; sample-cursor10ms RMS windows;quiet below−55dBFS;first/last complete activity windows and explicitly canceled intervals excluded',
    limitations: ['800ms stalls exceed the500ms prefill and deliberately lose expired impacts instead of backfilling them.',
      'A stall before the first preparation/audio microtask prevents native booking; it is measured separately and is not claimed to be protected.',
      'Headless Linux Chromium and pre-device PCM do not establish physical Windows device continuity.',
      'Candidate native target differences use one first-booking anchor and0.001ms floating-point tolerance. First-booking wall-time alignment separately allows the measured currentTime step plus0.25ms; calibrations coarser than20ms fail. Baseline uses its old per-tick wall/audio mapping diagnostically; missing counts use actual audible native impacts and ambiguous reconstructed indices are flagged.',
      'AudioContext time must advance within20ms of the real wall-clock stall duration; a frozen audio clock is never classified as continuous.'],
    pcmClockMetadata: 'Raw per-block currentFrame offsets are retained. Negative-only metadata lag is bounded by the independently calibrated currentTime publication step (hard20ms ceiling); forward/unaccounted render-frame gaps fail, and final sample count must match reported capture time within128samples.',
    scenarios, comparisons, productionAnimationAudits: audits };
  await writeFile(join(out, 'audio-continuity-validation.json'), JSON.stringify(report, null, 2));
  await writeFile(join(out, 'audio-continuity-progress.json'), JSON.stringify({ status: 'passed', scenarios }, null, 2));
  console.log(JSON.stringify({ report: join(out, 'audio-continuity-validation.json'), comparisons, audits }, null, 2));
} catch (error) {
  await writeFile(join(out, 'audio-continuity-progress.json'), JSON.stringify({ status: 'failed',
    error: String(error), provenance, scenarios, audits }, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
