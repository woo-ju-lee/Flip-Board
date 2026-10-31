// Record the frozen before/after production demos sequentially, including each
// board's real mixer output. Never play both soundtracks at the same time.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installAudioProbe } from './audio_probe.mjs';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const out = process.env.KORAIL_VIDEO_OUTPUT_DIR
  ? resolve(process.env.KORAIL_VIDEO_OUTPUT_DIR) : fileURLToPath(new URL('../artifacts/', import.meta.url));
const scenario = process.env.KORAIL_VIDEO_SCENARIO || 'normal';
assert.ok(['normal', 'stall'].includes(scenario), 'KORAIL_VIDEO_SCENARIO must be normal or stall');
const stallMs = 400;
const prefix = `transition-${scenario}`;
const ffmpeg = process.env.KORAIL_FFMPEG_EXECUTABLE || 'ffmpeg';
const sources = [
  { label: 'before', base: process.env.KORAIL_BEFORE_URL || 'http://127.0.0.1:4173' },
  { label: 'after', base: process.env.KORAIL_AFTER_URL || 'http://127.0.0.1:4174' },
];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'],
});
const clips = [];
const escapePath = value => value.replaceAll("'", "'\\''");
try {
  for (const { label, base } of sources) {
    const framesDir = await mkdtemp(join(tmpdir(), `flap-${label}-`));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'no-preference' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await installAudioProbe(page);
      await page.goto(`${base}/?demo=performance&renderer=optimized`);
      await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const settled = () => [...document.querySelectorAll('.rows .flap')].every(cell => cell.dataset.flipping === 'false'
        && (cell.classList.contains('flap-panel')
          ? cell.querySelector(':scope > .flap-top').innerHTML === cell.querySelector(':scope > .flap-bottom').innerHTML
            && (!cell.dataset.value || cell.querySelector(':scope > .flap-top .train-logo-art'))
          : cell.querySelector(':scope > .flap-top > span').textContent === cell.dataset.value
            && cell.querySelector(':scope > .flap-bottom > span').textContent === cell.dataset.value));
      await page.waitForFunction(settled, undefined, { timeout: 20000 });
      await page.getByRole('button', { name: '소리 켜기', exact: true }).click();
      await page.getByRole('button', { name: '소리 끄기', exact: true }).waitFor();
      const session = await context.newCDPSession(page);
      const frames = [], writes = [], actions = [];
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
      await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 1080, everyNthFrame: 1 });
      await started;
      const action = async (name, callback) => {
        const time = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
        const details = await callback();
        actions.push({ name, secondsFromRecording: time - audioStart, ...details });
      };
      await page.waitForTimeout(250);
      await action('next page', () => page.getByRole('button', { name: '다음 페이지', exact: true }).click());
      if (scenario === 'stall') {
        await page.waitForTimeout(600);
        await action(`${stallMs}ms main-thread stall`, () => page.evaluate(milliseconds => {
          const started = performance.now();
          while (performance.now() - started < milliseconds) { /* Deliberately reproduce a busy UI. */ }
          return { startedWallTime: (performance.timeOrigin + started) / 1000,
            endedWallTime: (performance.timeOrigin + performance.now()) / 1000 };
        }, stallMs));
      }
      await page.waitForFunction(settled, undefined, { timeout: 20000 });
      await page.waitForTimeout(500);
      const end = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
      await session.send('Page.stopScreencast');
      const recording = await page.evaluate(() => __flapAudioProbe.stopRecording());
      const audioFile = `${out}/${prefix}-${label}-audio.webm`;
      await writeFile(audioFile, Buffer.from(recording));
      await Promise.all(writes);
      assert.ok(frames.length > 0);
      assert.deepEqual(errors, []);
      const offset = frames[0].time - audioStart;
      assert.ok(Math.abs(offset) < 1, `Capture clocks differ: ${offset}`);
      const list = ['ffconcat version 1.0'];
      frames.forEach((frame, i) => list.push(`file '${escapePath(frame.file)}'`, 'option framerate 60',
        `duration ${Math.max(.001, (frames[i + 1]?.time ?? end) - frame.time)}`));
      list.push(`file '${escapePath(frames.at(-1).file)}'`, 'option framerate 60');
      const concat = join(framesDir, 'frames.txt');
      await writeFile(concat, list.join('\n'));
      const audioFilter = offset >= 0 ? `atrim=start=${offset},asetpts=PTS-STARTPTS` : `adelay=${-offset * 1000}:all=1`;
      const output = `${out}/${prefix}-${label}.mp4`;
      const caption = `${label.toUpperCase()} - ${scenario === 'normal' ? 'Normal page transition' : `${stallMs}ms forced UI stall`}`;
      const stall = actions.find(action => action.startedWallTime !== undefined);
      const stallOverlay = stall
        ? `,drawtext=text='INJECTED UI STALL ${stallMs}ms':fontcolor=yellow:fontsize=28:box=1:boxcolor=black@0.9:x=20:y=h-60:enable='between(t,${stall.startedWallTime - frames[0].time},${stall.endedWallTime - frames[0].time})'`
        : '';
      execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
        '-i', audioFile, '-filter_complex',
        `[0:v]fps=30,drawtext=text='${caption}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.8:x=20:y=20${stallOverlay}[video];[1:a]${audioFilter}[audio]`,
        '-map', '[video]', '-map', '[audio]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', output]);
      clips.push({ label, base, output, duration: end - frames[0].time, audioTrimSeconds: offset, frames: frames.length, actions });
      console.log(JSON.stringify(clips.at(-1)));
    } finally {
      await context.close();
      await rm(framesDir, { recursive: true, force: true });
    }
  }
  const concat = `${out}/${prefix}-comparison.ffconcat`;
  await writeFile(concat, ['ffconcat version 1.0', ...clips.map(clip => `file '${escapePath(clip.output)}'`)].join('\n'));
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-c', 'copy', '-movflags', '+faststart', `${out}/${prefix}-comparison.mp4`]);
  await writeFile(`${out}/${prefix}-comparison.json`, JSON.stringify({ browser: await browser.version(), scenario,
    injectedStallMs: scenario === 'stall' ? stallMs : 0, clips,
    audio: 'Actual app mixer at default 30% volume; sequential before then after, not simultaneous mixing',
    caveats: 'Screen recording adds overhead. This is a visual/audio demonstration, not the performance benchmark or a physical speaker measurement.',
  }, null, 2));
} finally { await browser.close(); }
