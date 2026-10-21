import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import pdfLibrary from './pdf.cjs';

// "Đọc song ngữ" in a real browser engine: the original page beside its Vietnamese page, drawn by the vendored pdf.js,
// with the real stylesheet. Files are served from memory and the repo; every other request is aborted, so nothing
// reaches /api or the network. Skipped when Microsoft Edge or the vendored pdf.js (npm run prepare:vendor) is missing.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://hoatri.test';
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
let browser=null;
if(existsSync(new URL('vendor/pdf.mjs',frontend)))try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge or frontend/vendor/pdf.mjs is not available here';
test.after(()=>browser?.close());

async function pdf(label,pages){
 const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);
 for(const number of pages){const page=doc.addPage([420,595]);page.drawText(`${label} ${number}`,{x:40,y:520,size:24,font});page.drawRectangle({x:40,y:80,width:340,height:360,borderColor:pdfLibrary.rgb(.3,.4,.2),borderWidth:2});}
 return Buffer.from(await doc.save());
}
const files={'/original.pdf':await pdf('Original page',[1,2,3,4,5,6]),'/part.pdf':await pdf('Ban dich trang',[3,4])};
const css=readFileSync(new URL('style.css',frontend),'utf8').replace(/^@import[^;]*;/gmu,'');
const PAGE=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="public-content read-mode"><article class="reader paper"><div class="bilingual-root" id="root"></div></article></main></body></html>`;

async function open(width,{original='/original.pdf'}={}){
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:PAGE});
  if(files[url.pathname])return route.fulfill({contentType:'application/pdf',body:files[url.pathname]});
  const path=new URL(`.${url.pathname}`,frontend);
  if(/^\/(bilingual-reader\.js|vendor\/)/u.test(url.pathname)&&existsSync(path))return route.fulfill({contentType:TYPES[url.pathname.match(/\.[a-z]+$/u)?.[0]]||'application/octet-stream',body:readFileSync(path)});
  return route.fulfill({status:404,contentType:'application/json',body:'{"error":"Không tìm thấy."}'});
 });
 await page.goto(ORIGIN+'/');
 await page.evaluate(async original=>{const {mountBilingual}=await import('/bilingual-reader.js');globalThis.viewer=mountBilingual(document.querySelector('#root'),{originalUrl:original,translatedUrl:'/part.pdf',pages:[3,4]});},original);
 return {context,page,errors};
}
const frames=page=>page.evaluate(()=>[...document.querySelectorAll('.bilingual-page')].map(frame=>{const box=frame.getBoundingClientRect();return {width:Math.round(box.width),height:Math.round(box.height),top:Math.round(box.top),text:frame.querySelector('.textLayer')?.textContent.replace(/\s+/gu,' ').trim()};}));
const position=page=>page.locator('[data-bi="position"]').textContent();

for(const width of [390,1280])test(`Đọc song ngữ at ${width} px: both pages drawn, turned and zoomed together, keyboard included`,{skip},async()=>{
 const {context,page,errors}=await open(width);
 const both=(test,arg)=>page.waitForFunction(test,arg,{timeout:30000});
 await both(()=>[...document.querySelectorAll('.bilingual-page .textLayer')].filter(layer=>layer.querySelector('span')).length===2);
 assert.equal(await position(page),'Trang 3 · 1/2');
 let shown=await frames(page);
 assert.deepEqual(shown.map(frame=>frame.text),['Original page 3','Ban dich trang 3']);
 assert.equal(shown[0].width,shown[1].width);assert.equal(shown[0].height,shown[1].height);
 // DOM order is original, translation; a phone stacks them with the Vietnamese page on top.
 if(width<760)assert.ok(shown[0].top>=shown[1].top+shown[1].height,'stacked on a phone, the translation first');else assert.equal(shown[0].top,shown[1].top,'side by side');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways page scroll');
 assert.equal(await page.locator('[data-bi="prev"]').first().isDisabled(),true);
 await page.locator('[data-bi="next"]').first().click();
 await both(()=>{const texts=[...document.querySelectorAll('.bilingual-page .textLayer')].map(layer=>layer.textContent);return texts.length===2&&texts.every(text=>text.trim().endsWith(' 4'));});
 assert.equal(await position(page),'Trang 4 · 2/2');assert.deepEqual((await frames(page)).map(frame=>frame.text),['Original page 4','Ban dich trang 4']);
 assert.equal(await page.locator('[data-bi="announce"]').textContent(),'Đã chuyển đến trang 4, 2 trên 2','the new page is announced politely');assert.equal(await page.locator('[data-bi="announce"]').getAttribute('aria-live'),'polite');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.bi),'prev','focus moves to the other page button when this one is disabled');
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('[data-bi="position"]').textContent==='Trang 3 · 1/2');
 await page.keyboard.press('+');await page.waitForFunction(()=>document.querySelector('[data-bi="zoom"]').textContent==='125%');
 await both(width=>{const frames=[...document.querySelectorAll('.bilingual-page')];return frames.length===2&&frames.every(frame=>frame.getBoundingClientRect().width>width);},shown[0].width);
 shown=await frames(page);assert.equal(shown[0].width,shown[1].width,'one zoom for both pages');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'a zoomed page scrolls inside its own box');
 await page.keyboard.press('0');await page.waitForFunction(()=>document.querySelector('[data-bi="zoom"]').textContent==='100%');
 assert.equal(await page.evaluate(()=>globalThis.viewer.index),0);
 assert.deepEqual(errors,[]);
 await context.close();
});

test('Đọc song ngữ: a missing original keeps the Vietnamese page and offers to retry',{skip},async()=>{
 const {context,page,errors}=await open(1280,{original:'/missing.pdf'});
 await page.waitForFunction(()=>document.querySelector('[data-bi="translated"] canvas')&&document.querySelector('[data-bi="status"] button'),null,{timeout:30000});
 assert.match(await page.locator('[data-bi="status"]').textContent(),/Không mở được PDF gốc\. Hãy kiểm tra mạng rồi bấm Thử lại\./u);
 assert.match(await page.locator('[data-bi="original"]').textContent(),/Không mở được PDF gốc/u);
 assert.deepEqual(errors,[]);
 await context.close();
});
