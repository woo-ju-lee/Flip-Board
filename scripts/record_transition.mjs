// Captures the actual browser frames and mixer output on a shared wall clock.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
await mkdir(out, { recursive: true });
const framesDir = await mkdtemp(join(tmpdir(), 'flip-transition-'));
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  await installAudioProbe(page);
  await page.goto(`${base}/?source=archive`);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.waitForTimeout(2300);
  await page.getByRole('button', { name: '소리 켜기' }).click();
  await page.getByRole('button', { name: '소리 끄기' }).waitFor();
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
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.waitForTimeout(2500);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141536');
  await page.waitForTimeout(2700);
  const end = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
  await session.send('Page.stopScreencast');
  const recording = await page.evaluate(() => __flapAudioProbe.stopRecording());
  await writeFile(`${out}/transition-audio.webm`, Buffer.from(recording));
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
    '-f', 'concat', '-safe', '0', '-i', concat, '-i', `${out}/transition-audio.webm`,
    '-filter_complex', `[1:a]${audioFilter}[audio]`, '-map', '0:v', '-map', '[audio]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', `${out}/transition-with-audio.mp4`]);
  const report = { source: 'Actual archived train snapshots', audio: 'Bundled Robin Yang Vestaboard recording, actual app mixer at 30%',
    frames: frames.length, duration: end - frames[0].time, audioTrimSeconds: offset,
    sequence: ['manual next page', 'previous page interrupted by snapshot change', 'latest snapshot settles'],
    peakConcurrentVoices: await page.evaluate(() => __flapAudioProbe.maxActive) };
  await writeFile(`${out}/transition-notes.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await rm(framesDir, { recursive: true, force: true }); }
