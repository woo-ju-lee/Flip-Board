// Exercise the production layout against the existing local HTTP backend.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modulePath = process.env.KORAIL_BROWSER_MODULE || new URL('../frontend/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(modulePath);
const base = process.env.KORAIL_TEST_URL || 'http://127.0.0.1:8000';
const out = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(out, { recursive:true });
const browser = await chromium.launch({ headless:true,
  ...(process.env.KORAIL_BROWSER_EXECUTABLE ? { executablePath:process.env.KORAIL_BROWSER_EXECUTABLE } : {}),
  args:['--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1440,height:900}, reducedMotion:'reduce' });
const errors=[], layouts=[], checks=[];
try {
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.request.get(`${base}/api/trains?source=archive&archive=141536`);
  assert.equal((await response.json()).count,148);
  await page.goto(`${base}/?source=archive`);
  await page.getByRole('row',{name:/^KTX 31,/}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('.rows .board-row').count(),10);
  assert.equal(await page.locator('.board-columns > [role=columnheader]').count(),5);
  assert.equal(await page.locator('.logo-leaf[data-value="KTX-청룡"] .flap-top img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
  const characterLeaves=page.locator('.rows .flap:not(.flap-panel)');
  assert.equal(await characterLeaves.evaluateAll(leaves=>leaves.every(el=>
    getComputedStyle(el).fontWeight==='400'&&getComputedStyle(el).fontFamily.startsWith('"IBM Plex Sans KR"'))),true);
  // Inspect the font actually used for both a Hangul glyph and a digit, not only CSS.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const {root}=await cdp.send('DOM.getDocument');
  const actualFonts=[];
  for(const selector of ['.origin-cell .flap-top > span','.train-cell .flap:not(.flap-panel) .flap-top > span']) {
    const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
    const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
    assert.ok(fonts.some(font=>font.familyName==='IBM Plex Sans KR'&&font.isCustomFont&&font.glyphCount>0),JSON.stringify(fonts));
    actualFonts.push({selector,fonts});
  }
  await cdp.detach();
  const normalHeight=(await page.locator('.rows .board-row').first().boundingBox()).height;
  await page.screenshot({path:`${out}/layout-desktop.png`,fullPage:true});
  await page.getByRole('button',{name:'전체 화면',exact:true}).click();
  await page.waitForFunction(()=>document.fullscreenElement?.classList.contains('board-housing'));
  for (const [width,height] of [[1920,1080],[1440,900],[2560,1440],[3840,2160],[2560,1080],[1366,768],[1024,768],[768,1024],[390,844],[360,640],[667,375],[844,390]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(150);
    const result=await page.evaluate(()=>{
      const board=document.querySelector('.board-housing');
      const rows=[...board.querySelectorAll('.rows .board-row')];
      return {width:innerWidth,height:innerHeight,rows:rows.length,
        background:getComputedStyle(board).backgroundColor,
        titleHidden:getComputedStyle(board.querySelector('.board-title')).display==='none',
        metadataHidden:getComputedStyle(board.querySelector('.update-label')).display==='none',
        horizontalOverflow:board.scrollWidth>board.clientWidth,verticalOverflow:board.scrollHeight>board.clientHeight,
        positionLetters:rows[0].querySelectorAll('.position-cell .flap').length,
        bottom:rows.at(-1).getBoundingClientRect().bottom,
        badFaces:[...board.querySelectorAll('.flap-half')].filter(e=>getComputedStyle(e).backgroundColor!=='rgb(33, 33, 33)'||getComputedStyle(e).backgroundImage!=='none').length,
        rowBorders:rows.filter(e=>getComputedStyle(e).borderBottomWidth!=='0px').length,
        clipped:[...board.querySelectorAll('.board-row > span,.flap-half > span,.train-logo-art')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),
        misaligned:[...board.querySelectorAll('.flap')].filter(e=>{
          const top=e.querySelector(':scope > .flap-top > span').getBoundingClientRect();
          const bottom=e.querySelector(':scope > .flap-bottom > span').getBoundingClientRect();
          return ['x','y','width','height'].some(k=>Math.abs(top[k]-bottom[k])>.1);
        }).map(e=>e.dataset.value)};
    });
    layouts.push(result);
    assert.equal(result.rows,10); assert.equal(result.positionLetters,13);
    assert.ok(result.titleHidden&&result.metadataHidden);
    assert.equal(result.background,'rgb(0, 0, 0)');
    assert.equal(result.horizontalOverflow,false); assert.equal(result.verticalOverflow,false);
    assert.equal(result.badFaces,0); assert.equal(result.rowBorders,0);
    assert.deepEqual(result.clipped,[],JSON.stringify(result)); assert.deepEqual(result.misaligned,[],JSON.stringify(result));
    assert.ok(result.bottom<=height);
    if ([1920,390].includes(width)) await page.screenshot({path:`${out}/layout-fullscreen-${width}.png`});
  }
  checks.push('Real backend archive supplies ten rows, white train logos and locally bundled IBM Plex Sans KR 400 for Hangul and digits');
  checks.push('Fullscreen targets only the board, hides title/count/receipt and fits twelve desktop/tablet/phone dimensions without overflow or misaligned halves');
  await page.setViewportSize({width:390,height:844});
  const next=page.getByRole('button',{name:'다음 페이지',exact:true});
  const kinds=new Set();
  for(let index=0;index<15;index++) {
    const logos=await page.locator('.train-logo').evaluateAll(elements=>elements.map(e=>({kind:e.title,
      clipped:[...e.querySelectorAll('.train-logo-art,.train-logo-label,.train-logo-subtitle')].some(el=>el.scrollWidth>el.clientWidth+1),
      broken:[...e.querySelectorAll('img')].some(img=>!img.complete||!img.naturalWidth),
      aligned:e.querySelector('.flap-top').innerHTML===e.querySelector('.flap-bottom').innerHTML})));
    logos.forEach(logo=>{if(logo.kind)kinds.add(logo.kind);});
    assert.ok(logos.every(logo=>!logo.clipped&&!logo.broken&&logo.aligned),JSON.stringify(logos));
    if(index<14)await next.click();
  }
  assert.equal(kinds.size,10);
  assert.equal(await next.isDisabled(),true);
  assert.equal(await page.locator('.rows .empty-row').count(),2);
  assert.equal(await page.locator('.empty-row img').count(),0);
  assert.match(await page.locator('.pagination strong').innerText(),/15\s*\/\s*15/);
  await page.locator('.rows .board-row:not(.empty-row)').first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'상세 닫기',exact:true}).click();
  await page.locator('.sound-settings summary').click();
  const panel=await page.locator('.sound-panel').boundingBox();
  assert.ok(panel.x>=0&&panel.y>=0&&panel.x+panel.width<=390&&panel.y+panel.height<=844);
  await page.locator('.sound-settings summary').click();
  await page.getByRole('button',{name:'전체 화면 종료',exact:true}).click();
  await page.waitForFunction(()=>!document.fullscreenElement);
  assert.ok(await page.locator('.board-title').isVisible());
  assert.ok(await page.locator('.controls').isVisible());
  await page.waitForFunction(()=>document.querySelector('.position-cell').querySelectorAll('.flap').length===9);
  await page.setViewportSize({width:1440,height:900});
  assert.equal((await page.locator('.rows .board-row').first().boundingBox()).height,normalHeight);
  checks.push('All ten train kinds fit; 148 records give fifteen pages with two blank final rows; fullscreen details, audio settings and exit work');
  const demoApi=[];
  const listener=request=>{if(new URL(request.url()).pathname.startsWith('/api/'))demoApi.push(request.url());};
  page.on('request',listener);
  await page.goto(`${base}/?demo=rotors`);
  await page.getByRole('row',{name:/^KTX 31,/}).waitFor();
  assert.equal(await page.locator('.rows .board-row').count(),10);
  assert.equal(await page.locator('.board-theme.monochrome-board').count(),1);
  assert.deepEqual(demoApi,[]);
  page.off('request',listener);
  checks.push('Existing explicit rotor demo route is retained and uses the same layout');
  assert.deepEqual(errors,[]);
  const report={checks,layouts,actualFonts,pageErrors:errors};
  await writeFile(`${out}/layout-validation.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks,screenSizes:layouts.length,pageErrors:errors},null,2));
} catch(error) {
  await page.screenshot({path:`${out}/layout-failure.png`,fullPage:true});
  throw error;
} finally {await browser.close();}
