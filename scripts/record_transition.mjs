// A silent visual review of real archived records; never fabricates source audio.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath: process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 },
    recordVideo: { dir: out, size: { width: 1440, height: 1080 } } });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(`${base}/?source=archive`);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('row', { name: /^KTX 31,/ }).waitFor();
  await page.waitForTimeout(2600);
  await page.getByRole('button', { name: '다음 페이지' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '이전 페이지' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141445');
  await page.waitForTimeout(2500);
  await page.getByRole('combobox', { name: '표본 수신 시각' }).selectOption('141536');
  await page.waitForTimeout(2700);
  await context.close();
  await video.saveAs(`${out}/transition-silent.webm`);
  await video.delete();
  await writeFile(`${out}/transition-notes.json`, JSON.stringify({
    source: 'Actual archived train snapshots, explicitly labeled historical in the UI',
    audio: 'None. Selected Pragotron recording is not yet available.',
    sequence: ['initial seven rows', 'manual next page', 'previous page interrupted by snapshot change', 'latest snapshot settles'],
  }, null, 2));
  console.log(`${out}/transition-silent.webm`);
} finally { await browser.close(); }
