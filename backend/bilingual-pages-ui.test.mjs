import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import pdfLibrary from './pdf.cjs';

// "Đọc song ngữ" on a sample whose original is an excerpt (the cover and the translated pages): the toolbar names the
// printed book's page, not the page's place in the excerpt, while the original side still shows the excerpt's page.
// Real Edge, the vendored pdf.js, files served from memory; skipped without Edge or frontend/vendor/pdf.mjs.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://hoatri.test';
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
let browser=null;
if(existsSync(new URL('vendor/pdf.mjs',frontend)))try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge or frontend/vendor/pdf.mjs is not available here';
test.after(()=>browser?.close());

async function pdf(label,pages){
 const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);
 for(const number of pages)doc.addPage([420,595]).drawText(`${label} ${number}`,{x:40,y:520,size:24,font});
 return Buffer.from(await doc.save());
}
// The excerpt holds the cover (book page 1) and book pages 7-8; the part translates its pages 2 and 3.
const files={'/excerpt.pdf':await pdf('Excerpt page',[1,2,3]),'/part.pdf':await pdf('Ban dich trang',[7,8])};
const PAGE='<!doctype html><html lang="vi"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>';

test('Đọc song ngữ shows the book\'s page number of an excerpt original ("Trang 7"), and the excerpt\'s own page beside it',{skip},async()=>{
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
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
 await page.evaluate(async()=>{
  const {bilingualSource,mountBilingual}=await import('/bilingual-reader.js'),SHA='a'.repeat(64);
  const source=bilingualSource({parts:[{id:'c1',mime:'application/pdf',pages:[2,3],sha256:SHA}],storedSources:[{sha256:SHA,pages:3,url:'/api/excerpt',bookPages:[1,7,8]}]},'c1');
  globalThis.viewer=mountBilingual(document.querySelector('#root'),{originalUrl:'/excerpt.pdf',translatedUrl:'/part.pdf',pages:source.pages,labels:source.labels});
 });
 const texts=()=>page.evaluate(()=>[...document.querySelectorAll('.bilingual-page .textLayer')].map(layer=>layer.textContent.replace(/\s+/gu,' ').trim()));
 const position=()=>page.locator('[data-bi="position"]').textContent();
 await page.waitForFunction(()=>[...document.querySelectorAll('.bilingual-page .textLayer')].filter(layer=>layer.querySelector('span')).length===2,null,{timeout:30000});
 assert.equal(await position(),'Trang 7 · 1/2');assert.deepEqual(await texts(),['Excerpt page 2','Ban dich trang 7']);
 await page.locator('[data-bi="next"]').first().click();
 await page.waitForFunction(()=>document.querySelector('[data-bi="position"]').textContent==='Trang 8 · 2/2',null,{timeout:30000});
 await page.waitForFunction(()=>[...document.querySelectorAll('.bilingual-page .textLayer')].map(layer=>layer.textContent).join('|').includes('Excerpt page 3'),null,{timeout:30000});
 assert.deepEqual(await texts(),['Excerpt page 3','Ban dich trang 8']);
 assert.deepEqual(errors,[]);
 await context.close();
});
