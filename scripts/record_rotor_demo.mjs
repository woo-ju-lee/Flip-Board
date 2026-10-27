// Record the existing board layout with indexed digit/station drums and actual archived data.
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
const stationNames = JSON.parse(await readFile(new URL('../frontend/src/stationRotor.json', import.meta.url), 'utf8'));
const characterRotor = [' ', ...new Set(stationNames.flatMap(name => Array.from(name.normalize('NFC'))))].sort();
const prefix = 'rotor-demo-character-layout';
await mkdir(out, { recursive: true });
const framesDir = await mkdtemp(join(tmpdir(), 'flip-transition-'));
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  await installAudioProbe(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?demo=rotors`);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.waitForTimeout(2300);
  assert.equal(await page.locator('.rows .board-row').count(), 7);
  assert.equal(await page.locator('.flap-station').count(), 0);
  assert.equal(await page.locator('.board-row .origin-cell .flap, .board-row .destination-cell .flap').count(), 70);
  assert.equal(await page.locator('[data-flipping="true"]').count(), 0);
  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
  await page.evaluate(() => {
    window.__rotorTrace = { digits: [], originFirst: [], originSecond: [], stationaryFlips: 0 };
    window.__initialStationLeaf = document.querySelector('.board-row .origin-cell .flap');
    const last = new Map();
    new MutationObserver(() => {
      for (const [key, selector] of [
        ['digits', '.board-row:nth-child(2) .train-cell .flap:nth-child(2)'],
        ['originFirst', '.board-row:nth-child(2) .origin-cell .flap:nth-child(1)'],
        ['originSecond', '.board-row:nth-child(2) .origin-cell .flap:nth-child(2)'],
      ]) {
        const leaf = document.querySelector(selector);
        const value = leaf.querySelector('.flap-in > span')?.textContent;
        if (value && last.get(key) !== value) { __rotorTrace[key].push(value); last.set(key, value); }
      }
      if (document.querySelector('.board-row:first-child .origin-cell [data-flipping="true"], .board-row:first-child .destination-cell [data-flipping="true"]')) __rotorTrace.stationaryFlips++;
    }).observe(document.querySelector('.rows'), { subtree: true, childList: true, attributes: true });
  });
  const session = await context.newCDPSession(page);
  const frames = [], writes = [];
  let firstFrame;
  const started = new Promise(resolve => { firstFrame = resolve; });
  session.on('Page.screencastFrame', frame => {
    const file = join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, time: frame.metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(frame.data, 'base64')));
    writes.push(session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }));
    firstFrame();
  });
  const audioStart = await page.evaluate(() => __flapAudioProbe.startRecording());
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 1080, everyNthFrame: 1 });
  await started;
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  assert.equal(await page.evaluate(() => __initialStationLeaf === document.querySelector('.board-row .origin-cell .flap')), true);
  await page.waitForTimeout(750);
  await page.screenshot({ path: `${out}/${prefix}-turning.png`, fullPage: true });
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .flap')].every(leaf =>
    leaf.dataset.flipping === 'false' && leaf.querySelector(':scope > .flap-top > span').textContent === leaf.dataset.value), undefined, { timeout: 20000 });
  await page.waitForTimeout(200);
  const trace = await page.evaluate(() => __rotorTrace);
  assert.deepEqual(trace.digits, ['4', '5', '6', '7', '8', '9', '0']);
  const expected = (from, to) => {
    const start = characterRotor.indexOf(from);
    const count = (characterRotor.indexOf(to) - start + characterRotor.length) % characterRotor.length;
    return Array.from({ length: count }, (_, i) => characterRotor[(start + i + 1) % characterRotor.length]);
  };
  assert.deepEqual(trace.originFirst, expected('서', '부'));
  assert.deepEqual(trace.originSecond, expected('울', '산'));
  assert.equal(trace.stationaryFlips, 0);
  const firstSoundCount = await page.evaluate(() => __flapAudioProbe.starts.length);
  assert.ok(firstSoundCount > 0);
  await page.getByRole('button', { name: '서버 캐시 다시 조회', exact: true }).click();
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => __flapAudioProbe.starts.length), firstSoundCount);
  assert.equal(await page.evaluate(() => __flapAudioProbe.active.size), 0);
  assert.equal(await page.locator('[data-flipping="true"]').count(), 0);
  assert.deepEqual(errors, []);
  const end = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
  await session.send('Page.stopScreencast');
  const recording = await page.evaluate(() => __flapAudioProbe.stopRecording());
  await writeFile(`${out}/${prefix}-audio.webm`, Buffer.from(recording));
  await Promise.all(writes);
  const offset = frames[0].time - audioStart;
  assert.ok(Math.abs(offset) < 1, `Capture clocks differ: ${offset}`);
  const escapePath = value => value.replaceAll("'", "'\\''");
  const list = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => {
    list.push(`file '${escapePath(frame.file)}'`, 'option framerate 60',
      `duration ${Math.max(.001, (frames[i + 1]?.time ?? end) - frame.time)}`);
  });
  list.push(`file '${escapePath(frames.at(-1).file)}'`, 'option framerate 60');
  const concat = join(framesDir, 'frames.txt');
  await writeFile(concat, list.join('\n'));
  const audioFilter = offset >= 0 ? `atrim=start=${offset},asetpts=PTS-STARTPTS` : `adelay=${-offset * 1000}:all=1`;
  execFileSync(process.env.KORAIL_FFMPEG_EXECUTABLE || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concat, '-i', `${out}/${prefix}-audio.webm`,
    '-filter_complex', `[1:a]${audioFilter}[audio]`, '-map', '0:v', '-map', '[audio]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', `${out}/${prefix}-with-audio.mp4`]);
  const report = { source: 'Original board component; real 2026-10-26 archived API responses, page 1 → 2', audio: 'Bundled Robin Yang Vestaboard recording, actual app mixer at 30%',
    frames: frames.length, duration: end - frames[0].time, audioTrimSeconds: offset,
    sequence: ['manual next page in the existing layout', 'individual station characters finish at different times', 'same cached response stays still and silent'],
    checks: ['digit 3 → 4 → 5 → 6 → 7 → 8 → 9 → 0', '서 → 부 (93 leaves) and 울 → 산 (72 leaves) use a shared unique-character drum', 'five original character modules per station are retained across pages', 'unchanged first-row stations stay still', 'identical cache produces no audio', 'all leaves settle with no remaining sounds'], firstSoundCount, trace, pageErrors: errors,
    peakConcurrentVoices: await page.evaluate(() => __flapAudioProbe.maxActive) };
  await writeFile(`${out}/${prefix}-video-validation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await rm(framesDir, { recursive: true, force: true }); }
