// Produce an offline, double-clickable demo from the same React components and audio engine.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
const require = createRequire(join(frontend, 'package.json'));
const { build } = require('esbuild');
const result = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import RotorDemo from './src/RotorDemo';
    createRoot(document.getElementById('root')).render(<React.StrictMode><div className="board-theme monochrome-board"><RotorDemo /></div></React.StrictMode>);`,
    loader: 'tsx', resolveDir: frontend },
  bundle: true, write: false, format: 'iife', minify: true, jsx: 'automatic',
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
});
const html = await readFile(join(frontend, 'dist/index.html'), 'utf8');
const cssAsset = html.match(/href="(\/assets\/[^"\s]+\.css)"/)?.[1];
if (!cssAsset) throw new Error('Run npm run build in frontend first');
let css = await readFile(join(frontend, 'dist', cssAsset), 'utf8');
const fontAssets = [...new Set([...css.matchAll(/url\((\/assets\/[^)]+)\)/g)].map(match => match[1]))];
for (const asset of fontAssets) {
  const bytes = await readFile(join(frontend, 'dist', asset));
  const mime = asset.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
  css = css.replaceAll(asset, `data:${mime};base64,${bytes.toString('base64')}`);
}
const manifest = await readFile(join(frontend, 'public/audio/split-flap.json'), 'utf8');
const mp3 = await readFile(join(frontend, 'public/audio/vestaboard-flip.mp3'));
const license = await readFile(join(frontend, 'public/audio/LICENSE.txt'), 'utf8');
const fontLicenses = await Promise.all(['Noto-Sans-KR-OFL.txt', 'IBM-Plex-Sans-KR-OFL.txt']
  .map(name => readFile(join(frontend, 'public/licenses', name), 'utf8')));
const bootstrap = `const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = String(input);
    if (url === '/audio/split-flap.json') return Promise.resolve(new Response(${JSON.stringify(manifest)}, {headers:{'Content-Type':'application/json'}}));
    if (url === '/audio/vestaboard-flip.mp3') return Promise.resolve(new Response(Uint8Array.from(atob('${mp3.toString('base64')}'), c => c.charCodeAt(0)), {headers:{'Content-Type':'audio/mpeg'}}));
    return nativeFetch(input, options);
  };`;
const script = (bootstrap + result.outputFiles[0].text).replaceAll('</script', '<\\/script');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'rotor-demo-character-layout.html'), `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>순차 회전 · 스플릿 플랩 데모</title>
  <style>${css}</style></head><body><div id="root"></div><script>${script}</script>
  <!-- Bundled sound license: ${license} -->
  ${fontLicenses.map(license => `<!-- Bundled font license: ${license} -->`).join('\n')}
  </body></html>`);
console.log(`Offline demo: ${join(out, 'rotor-demo-character-layout.html')}`);
