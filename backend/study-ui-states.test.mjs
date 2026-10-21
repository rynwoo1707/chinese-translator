import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';

// The study page's states in Microsoft Edge: the real study.html, study.css and study.js, with /api answered here and
// every other host blocked. Signed out, the start-up requests, a history that fails to load, saves that keep failing, an
// expired session, a scan read in the browser without PaddleOCR. Skipped when Edge is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url));
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

// localhost is a secure context (crypto.subtle), as the deployed HTTPS site is; every request is answered here.
const ORIGIN='http://localhost:4179',KEY='AIzaSy'+'x'.repeat(33),ASSET='0b0e4c1e-2f7a-4d55-9a51-6c1f9f0d2a11';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const MANIFEST={version:1,extractionVersion:3,engine:'pymupdf',totalPages:1,pages:[{number:1,width:400,height:560,original:PNG,background:PNG,blocks:[{id:'p1-b1',text:'第一段的内容。',source:'第一段的内容。',box:[40,60,260,92],fontSize:12}],images:[],drawings:[],ocr:false,protectedRegions:[],extractionVersion:3}],warnings:[]};
const LAYOUT_ITEM={id:'5d7c1f7e-1111-4c2b-9d1e-2a2f0c9b7a10',title:'Bài thử giữ bố cục',filename:'bai-thu.pdf',domain:'general',mode:'economy',status:'complete',translated_parts:1,total_parts:1,library_story_id:null,library_chapter_id:null,updated_at:'2026-10-20 08:00:00',page_start:1,page_end:1,source_total_pages:1};

// api(path,method) -> body | {status,json} | undefined (the defaults of a signed-in student with nothing saved).
// init: a script run in the page before its own (context.addInitScript).
async function openStudy({api=()=>undefined,viewport={width:1280,height:900},init=null}={}){
 const context=await browser.newContext({viewport}),page=await context.newPage(),requests=[],errors=[];
 page.on('pageerror',error=>errors.push(String(error)));if(init)await context.addInitScript(init);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();requests.push(`${method} ${path}`);
  if(path.startsWith('/api/')){
   let body=await api(path,method,request);
   if(body===undefined)body=path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/models'?{models:[{id:'gemini-test'}],requested:'gemini-test',selected:'gemini-test'}:undefined;
   if(body===undefined)return route.fulfill({status:404,json:{error:`fake: ${method} ${path}`}});
   if(body?.fakeStatus)return route.fulfill({status:body.fakeStatus,json:body.json});
   return route.fulfill({json:body});
  }
  const file=normalize(join(root,path==='/study'?'study.html':path));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);if(!data)return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,headers:{'Content-Type':TYPES[extname(file)]||'application/octet-stream'},body:data});
 });
 await page.goto(`${ORIGIN}/study`);await page.waitForFunction(()=>document.body.dataset.session!=='checking');
 return {context,page,requests,errors};
}
const historyLoaded=page=>page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
const leaveListener=page=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});dispatchEvent(event);return event.defaultPrevented;});
// A one-page scan made here from invented sentences: Edge draws them with its own Chinese font, and pdf-lib wraps the
// picture in a PDF without a text layer.
async function scannedPdf(page){
 const png=await page.evaluate(()=>{
  const canvas=document.createElement('canvas'),g=canvas.getContext('2d');canvas.width=1240;canvas.height=1754;
  g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);g.fillStyle='#111';g.font='44px "Microsoft YaHei","SimHei","Noto Sans CJK SC",sans-serif';
  ['第一课 空间向量的概念','今天我们学习平面方程和直线方程。','老师在黑板上画了一个立体图形。','同学们一起讨论两个平面的夹角。'].forEach((line,index)=>g.fillText(line,120,240+index*120));
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
 });
 const {PDFDocument}=require('@cantoo/pdf-lib'),pdf=await PDFDocument.create(),image=await pdf.embedPng(Buffer.from(png,'base64'));
 pdf.addPage([595.2,842]).drawImage(image,{x:0,y:0,width:595.2,height:842});return Buffer.from(await pdf.save());
}
// A signed-in student without the PDF layout service, so a picked PDF is read in the browser; counts: Gemini calls.
const scanApi=(id,counts)=>(path,method)=>{
 if(path==='/api/my/study/pdf-layout/config')return {configured:false};
 if(path==='/api/my/study/history'&&method==='POST')return {id,status:'draft',libraryStoryId:null,updatedAt:new Date().toISOString()};
 if(path===`/api/my/study/history/${id}`&&method==='PUT')return {id,status:'complete',libraryStoryId:null,updatedAt:new Date().toISOString()};
 if(path==='/api/my/study/ocr'){counts.ocr++;return {text:'第一课 空间向量的概念',usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};}
 if(path==='/api/my/study/translate'){counts.translate++;return {translation:'Bài 1: khái niệm vectơ trong không gian.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};}
};
// Answers /vendor/paddle/** as an install without PaddleOCR does (404 with the site's page), or, with workerFound, as
// one whose worker.js is listed but does not load. Returns the requests it answered, with the time of each.
async function paddleMissing(context,{workerFound=false}={}){
 const answered=[];
 await context.route('**/vendor/paddle/**',route=>{
  const method=route.request().method(),path=new URL(route.request().url()).pathname;answered.push({line:`${method} ${path}`,at:Date.now()});
  if(workerFound&&method==='HEAD'&&path==='/vendor/paddle/worker.js')return route.fulfill({status:200,headers:{'Content-Type':'text/javascript'},body:''});
  return route.fulfill({status:404,headers:{'Content-Type':'text/html; charset=utf-8'},body:'<!doctype html><title>Không tìm thấy trang này</title>'});
 });
 return answered;
}
async function pickScan(page,pdf,name){
 await page.setInputFiles('#source-file',{name,mimeType:'application/pdf',buffer:pdf});
 await page.waitForFunction(()=>/trang scan/u.test(document.querySelector('#file-status').textContent)&&!document.querySelector('#warnings').textContent,null,{timeout:30000});
}
const tesseractRequested=page=>page.waitForRequest(request=>new URL(request.url()).pathname==='/vendor/tesseract.esm.min.js',{timeout:30000});
const runFinished=page=>page.waitForFunction(()=>/^Hoàn tất/u.test(document.querySelector('#progress').textContent),null,{timeout:120000});

describe('Xưởng dịch states in Edge',{concurrency:true},()=>{
test('Signed out: a sign-in card replaces the form, and the PDF service is not asked (no 401)',{skip},async()=>{
 const {context,page,requests,errors}=await openStudy({api:path=>path==='/api/me'?{authenticated:false}:undefined});
 try{
  assert.equal(await page.evaluate(()=>document.body.dataset.session),'out');
  assert.match(await page.textContent('#session-card'),/Đăng nhập để dùng Xưởng dịch/u);
  assert.equal(await page.getAttribute('#session-card a.primary','href'),'/#account?sau=xuong-dich','signing in comes back to Xưởng dịch');
  assert.deepEqual(await page.evaluate(()=>['.workspace','.result','.workflow'].map(selector=>getComputedStyle(document.querySelector(selector)).display)),['none','none','none']);
  assert.deepEqual(requests.filter(line=>line.includes('/api/my/')),[]);
  // Contract 6: Yêu cầu dịch links to the library's dialog; signed out, the account link says Đăng nhập.
  assert.equal(await page.getAttribute('.site-header-actions .header-request','href'),'/#yeu-cau');
  assert.equal((await page.textContent('.site-header-actions .header-login')).trim(),'Đăng nhập');
  assert.equal(await page.getAttribute('.site-nav a[aria-current="page"]','href'),'/study');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Start-up loads neither the PDF tools nor the preview font; the viewer fetches the font once, when it draws a page',{skip},async()=>{
 const {context,page,requests,errors}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [LAYOUT_ITEM];
  if(path===`/api/my/study/history/${LAYOUT_ITEM.id}`)return {...LAYOUT_ITEM,state:{source:'第一段的内容。',parts:['第一段的内容。'],translationParts:['Nội dung đoạn một.'],done:1,context:'',glossary:{},manualGlossary:{},pdfLayout:{assetId:ASSET}}};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return MANIFEST;
  if(path==='/api/my/study/pdf-layout/font')return {css:'@font-face{font-family:HoaTriPDF;src:local("Times New Roman")}'};
 }});
 try{
  await historyLoaded(page);
  const lazy=/\/(?:whole-book|cover-detect|pdf-box-layout|pdf-dual-viewer)\.js$|pdf-layout\/font$/u;
  assert.deepEqual(requests.filter(line=>lazy.test(line)),[]);
  assert.ok(requests.includes('GET /api/my/study/pdf-layout/config'));
  await page.click('#study-history > summary');await page.click(`[data-history-open="${LAYOUT_ITEM.id}"]`);
  await page.waitForFunction(()=>/Đã dịch 1\/1 đoạn|Bản xem trước/u.test(document.querySelector('#pdf-dual-viewer').textContent));
  // The font request follows the first drawn page; with several pages open at once it can trail the text by a moment.
  for(const end=Date.now()+10000;!requests.includes('GET /api/my/study/pdf-layout/font')&&Date.now()<end;)await new Promise(done=>setTimeout(done,50));
  assert.equal(requests.filter(line=>line==='GET /api/my/study/pdf-layout/font').length,1);
  assert.ok(requests.includes('GET /pdf-dual-viewer.js')&&requests.includes('GET /pdf-box-layout.js'));
  // Plain words: blocks are "đoạn", and the history card names the pages instead of counting blocks as parts.
  assert.match(await page.textContent('#part-count'),/^1 đoạn$/u);
  await page.click(`[data-history-open="${LAYOUT_ITEM.id}"]`);await page.waitForFunction(()=>!document.querySelector('#translate').disabled);
  assert.equal(requests.filter(line=>line==='GET /api/my/study/pdf-layout/font').length,1,'the font is fetched once per page load');
  assert.match(await page.textContent('#study-history-list'),/Hoàn tất · trang 1/u);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A history that fails to load says so in place, with Thử lại',{skip},async()=>{
 let calls=0;
 const {context,page,errors}=await openStudy({api:(path,method)=>path==='/api/my/study/history'&&method==='GET'?++calls===1?{fakeStatus:500,json:{error:'Máy chủ đang bận. Hãy thử lại sau ít phút.'}}:[]:undefined});
 try{
  await historyLoaded(page);
  assert.equal(await page.textContent('#study-history-count'),'· chưa tải được');assert.equal(await page.evaluate(()=>document.querySelector('#study-history').open),true);
  assert.match(await page.textContent('#study-history-list .load-error'),/Chưa tải được lịch sử dịch\.Máy chủ đang bận/u);
  assert.equal(await page.textContent('#warnings'),'');
  await page.click('#study-history-list .load-error-action');await page.waitForFunction(()=>document.querySelector('#study-history-count').textContent==='· chưa có');
  assert.equal(await page.$('#study-history-list .load-error'),null);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Saves that keep failing stop the run before the next Gemini call; Dừng shows only during a run and its message is truthful',{skip,timeout:120000},async()=>{
 let saves='fail',translations=0,putAttempts=0;const id='2e9d6a52-3c1b-4f0e-8a77-5b1c2d3e4f50';
 const {context,page,errors}=await openStudy({viewport:{width:390,height:844},api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST')return saves==='fail'?{fakeStatus:503,json:{error:'Máy chủ đang bận.'}}:{id,status:'draft',libraryStoryId:null,updatedAt:new Date().toISOString()};
  if(path===`/api/my/study/history/${id}`&&method==='PUT'){putAttempts++;return saves==='ok'?{id,status:'translating',libraryStoryId:null,updatedAt:new Date().toISOString()}:{fakeStatus:503,json:{error:'Máy chủ đang bận.'}};}
  if(path==='/api/my/study/translate'){translations++;return new Promise(resolve=>setTimeout(()=>resolve({translation:`Bản dịch phần ${translations}.`,context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]}),400));}
 }});
 try{
  await historyLoaded(page);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#stop')).display),'none');
  await page.fill('#content-title','Thử lưu');await page.fill('#api-key',KEY);
  await page.fill('#source',Array.from({length:3},(_,i)=>`第${i+1}段。`+'学而时习之不亦说乎'.repeat(600)).join('\n\n'));
  // On a phone the action floats at the bottom once there is a source, full width.
  assert.deepEqual(await page.evaluate(()=>{const bar=document.querySelector('#run-bar'),box=bar.getBoundingClientRect();return [getComputedStyle(bar).position,Math.round(box.bottom),Math.round(document.querySelector('#translate').getBoundingClientRect().width)];}),['fixed',844,358]);
  // The first save fails (three tries): nothing is sent to Gemini.
  await page.click('#translate');
  await page.waitForFunction(()=>/không gửi thêm yêu cầu tới Gemini/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(translations,0);assert.equal(await page.evaluate(()=>document.querySelector('#save-warning').hidden),false);assert.equal(await leaveListener(page),true);
  // The session is created, part 1 is translated, its save fails: the run stops before part 2.
  saves='put-fails';await page.click('#translate');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#stop')).display!=='none');
  await page.waitForFunction(()=>/không gửi thêm yêu cầu tới Gemini/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(translations,1);assert.equal(putAttempts,3);assert.match(await page.textContent('#progress'),/Phần đã dịch vẫn hiện trong tab này/u);
  // Saving works again: the run goes on; Dừng ends it with progress saved, and leaving no longer asks.
  saves='ok';await page.click('#translate');await page.waitForFunction(n=>document.querySelectorAll('.translation-part.done').length>n,1);await page.click('#stop');
  await page.waitForFunction(()=>/^Đã dừng sau|^Hoàn tất/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.match(await page.textContent('#progress'),/Tiến độ đã lưu vào tài khoản|Hoàn tất/u);
  assert.equal(await page.evaluate(()=>document.querySelector('#save-warning').hidden),true);assert.equal(await leaveListener(page),false);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#stop')).display),'none');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('An expired session during a run offers a link to sign in',{skip},async()=>{
 const {context,page,errors}=await openStudy({api:path=>path==='/api/my/study/models'?{fakeStatus:401,json:{error:'Bạn cần đăng nhập.'}}:undefined});
 try{
  await historyLoaded(page);await page.fill('#content-title','Thử');await page.fill('#api-key',KEY);await page.fill('#source','子曰：学而时习之。');await page.click('#translate');
  await page.waitForSelector('#progress a');
  assert.match(await page.textContent('#progress'),/Phiên đăng nhập đã hết hạn/u);assert.equal(await page.getAttribute('#progress a','href'),'/#account');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A finished translation whose last save failed: replacing it asks first, and Bắt đầu dịch saves it without Gemini',{skip,timeout:120000},async()=>{
 let saves='ok',translations=0,opened=0;const id='7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
 const {context,page,errors}=await openStudy({viewport:{width:390,height:844},api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST')return {id,status:'draft',libraryStoryId:null,updatedAt:new Date().toISOString()};
  if(path===`/api/my/study/history/${id}`&&method==='PUT')return saves==='ok'?{id,status:'complete',libraryStoryId:null,updatedAt:new Date().toISOString()}:{fakeStatus:503,json:{error:'Máy chủ đang bận.'}};
  if(path===`/api/my/study/history/${id}`&&method==='GET'){opened++;return undefined;}
  if(path==='/api/my/study/translate'){translations++;saves='fail';return {translation:'Bản dịch một phần.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};}
 }});
 try{
  await historyLoaded(page);await page.fill('#content-title','Lưu sau cùng');await page.fill('#api-key',KEY);await page.fill('#source','子曰：学而时习之，不亦说乎？');
  await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong nhưng chưa lưu được bản dịch/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(translations,1);assert.equal(await page.evaluate(()=>document.querySelector('#save-warning').hidden),false);assert.equal(await leaveListener(page),true);
  // The warning says it all in the floating bar: the repeated progress line steps aside; the page still ends above the bar.
  assert.deepEqual(await page.evaluate(()=>{const bar=document.querySelector('#run-bar').getBoundingClientRect();scrollTo(0,document.documentElement.scrollHeight);const last=[...document.querySelectorAll('.site-footer a')].at(-1).getBoundingClientRect();return [getComputedStyle(document.querySelector('#run-bar-status')).display,last.bottom<=bar.top];}),['none',true]);
  // Opening the saved session again or editing the source would drop the unsaved part: both ask, and "Hủy" keeps it.
  let asked=0;page.on('dialog',dialog=>{asked++;dialog.dismiss().catch(()=>{});});
  if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
  await page.click(`[data-history-open="${id}"]`);await page.locator('#source').press('End');await page.keyboard.type('x');
  assert.equal(asked,2);assert.equal(opened,0);assert.equal(await page.inputValue('#source'),'子曰：学而时习之，不亦说乎？');
  assert.equal(await page.evaluate(()=>document.querySelector('#save-warning').hidden),false);
  // The server is back: Bắt đầu dịch saves the finished part, calls no model, and leaving no longer asks.
  saves='ok';await page.click('#translate');
  await page.waitForFunction(()=>/^Đã lưu bản dịch/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(translations,1);assert.equal(await page.evaluate(()=>document.querySelector('#save-warning').hidden),true);assert.equal(await leaveListener(page),false);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A failed session check says so neutrally; Thử lại brings the form back with Bắt đầu dịch enabled',{skip},async()=>{
 let checks=0;
 const {context,page,errors}=await openStudy({api:path=>path==='/api/me'&&++checks===1?{fakeStatus:503,json:{error:'Máy chủ đang bận.'}}:undefined});
 try{
  assert.equal(await page.evaluate(()=>document.body.dataset.session),'error');
  assert.match(await page.textContent('#session-card'),/Mạng đang chập chờn hoặc máy chủ tạm thời chưa trả lời/u);
  await page.click('#session-card .primary');await page.waitForFunction(()=>document.body.dataset.session==='in');
  assert.equal(await page.evaluate(()=>document.querySelector('#translate').disabled),false);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Phone: without a key the key field takes the focus above the floating bar, which repeats the progress line',{skip},async()=>{
 const {context,page,errors}=await openStudy({viewport:{width:390,height:844}});
 try{
  await historyLoaded(page);await page.fill('#content-title','Thử');await page.fill('#source','子曰：学而时习之。');
  await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.focus('#translate');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.id==='api-key');
  assert.deepEqual(await page.evaluate(()=>{const key=document.querySelector('#api-key').getBoundingClientRect(),bar=document.querySelector('#run-bar').getBoundingClientRect(),mirror=document.querySelector('#run-bar-status');return {above:key.bottom<=bar.top,onScreen:key.top>=0,disabled:document.querySelector('#api-key').disabled,mirror:mirror.textContent,shown:getComputedStyle(mirror).display!=='none'&&mirror.getBoundingClientRect().height>0};}),
   {above:true,onScreen:true,disabled:false,mirror:'Chưa có khóa Gemini. Hãy nhập khóa API riêng cho phiên này rồi bấm Bắt đầu dịch.',shown:true});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Keyboard: during a run the focus waits on Dừng, and comes back to Bắt đầu dịch when the run ends',{skip,timeout:60000},async()=>{
 const id='9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
 const {context,page,errors}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST')return {id,status:'draft',libraryStoryId:null,updatedAt:new Date().toISOString()};
  if(path===`/api/my/study/history/${id}`&&method==='PUT')return {id,status:'complete',libraryStoryId:null,updatedAt:new Date().toISOString()};
  if(path==='/api/my/study/translate')return new Promise(resolve=>setTimeout(()=>resolve({translation:'Bản dịch.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]}),600));
 }});
 try{
  await historyLoaded(page);await page.fill('#content-title','Bàn phím');await page.fill('#api-key',KEY);await page.fill('#source','子曰：学而时习之。');
  await page.focus('#translate');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#stop').hidden);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'stop');
  await page.waitForFunction(()=>/^Hoàn tất/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'translate');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// The incident of 2026-10: an install without the PaddleOCR models has no /vendor/paddle/worker.js. Browser OCR must
// still read scans, with Tesseract, at once, and say so truthfully (engine, reason, size of the download).
test('Without PaddleOCR a scan goes straight to Tesseract: Save-Data asks for its 9 MB, the download shows progress, each document says why',{skip,timeout:180000},async()=>{
 const id='3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f',counts={ocr:0,translate:0};
 const {context,page,requests,errors}=await openStudy({api:scanApi(id,counts),init:()=>{
  // Save-Data is on; every line of the progress box is kept.
  Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:true,effectiveType:'4g'}});
  window.__statuses=[];addEventListener('DOMContentLoaded',()=>{const line=document.querySelector('#progress');new MutationObserver(()=>window.__statuses.push(line.textContent)).observe(line,{childList:true,characterData:true,subtree:true});});
 }});
 const paddle=await paddleMissing(context),paddleLines=()=>paddle.map(entry=>entry.line);
 const notice='Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR. Bản cài Hoa Trí này chưa có PaddleOCR.';
 try{
  await historyLoaded(page);await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
  assert.equal(await page.isChecked('#pdf-layout-enabled'),false,'without the layout service the browser reads the scan');
  await page.fill('#content-title','Bài scan thử');await page.fill('#api-key',KEY);
  const pdf=await scannedPdf(page);await pickScan(page,pdf,'bai-scan.pdf');
  await page.click('#translate');await page.waitForSelector('#ocr-download:not([hidden])',{timeout:30000});
  // The question names the size of the engine this install uses; PaddleOCR was only looked up, never started.
  assert.equal((await page.textContent('#ocr-download-title')).trim(),'Tải bộ nhận dạng chữ về máy (khoảng 9 MB)?');
  assert.match(await page.textContent('#ocr-download-text'),/lần đầu cần tải khoảng 9 MB trong khi trình duyệt đang bật chế độ tiết kiệm dữ liệu/u);
  assert.equal(await page.getAttribute('#ocr-download','aria-labelledby'),'ocr-download-title');assert.equal(await page.getAttribute('#ocr-download','role'),'group');
  assert.deepEqual(paddleLines(),['HEAD /vendor/paddle/worker.js']);
  // "Để sau" stops before any download and names the same size; Bắt đầu dịch asks again.
  await page.click('#ocr-download-no');await page.waitForFunction(()=>/bạn chọn để sau/u.test(document.querySelector('#progress').textContent));
  assert.match(await page.textContent('#progress'),/tải bộ nhận dạng chữ \(khoảng 9 MB, một lần\)/u);assert.ok(!requests.some(line=>/tesseract|tessdata/u.test(line)));
  await page.click('#translate');await page.waitForSelector('#ocr-download:not([hidden])',{timeout:30000});
  const tesseract=tesseractRequested(page),chosen=Date.now();await page.click('#ocr-download-yes');await tesseract;
  const waited=Date.now()-chosen;assert.ok(waited<5000,`Tesseract started ${waited} ms after the choice`);
  await page.waitForFunction(text=>document.querySelector('#warnings').textContent.includes(text),notice,{timeout:90000});await runFinished(page);
  const warnings=await page.textContent('#warnings');
  assert.equal(warnings.split(notice).length,2,'said once in the document');assert.doesNotMatch(warnings,/\.\)\.|Trình duyệt không khởi chạy/u);
  const statuses=await page.evaluate(()=>window.__statuses),downloads=statuses.filter(line=>line.startsWith('Đang tải'));
  assert.ok(statuses.includes('Nhận dạng chữ bằng Tesseract trên thiết bị, thay cho PaddleOCR…'));
  assert.ok(downloads.length>=3&&downloads.every(line=>/^Đang tải Tesseract \(khoảng 9 MB lần đầu\)… \d{1,3}%$/u.test(line)),downloads.join(' | '));
  assert.equal(downloads.at(-1),'Đang tải Tesseract (khoảng 9 MB lần đầu)… 100%');
  assert.ok(requests.includes('GET /vendor/tessdata/chi_sim.traineddata.gz')&&requests.includes('GET /vendor/tessdata/eng.traineddata.gz'));
  assert.deepEqual(paddleLines(),['HEAD /vendor/paddle/worker.js'],'no PaddleOCR worker, no model request');
  // tesseract.js kept its data where local-ocr.js looks for it (IndexedDB "keyval-store"): nothing large is left to fetch.
  assert.deepEqual(await page.evaluate(async()=>(await import('/local-ocr.js')).ocrDownload()),{engine:'Tesseract',mb:9,cached:true});
  // The next document in this tab: Tesseract only starts (no download claimed), and the reason is said again.
  const before=await page.evaluate(()=>window.__statuses.length);
  await pickScan(page,pdf,'bai-scan-2.pdf');await page.click('#translate');
  await page.waitForFunction(text=>document.querySelector('#warnings').textContent.includes(text),notice,{timeout:90000});await runFinished(page);
  const next=(await page.evaluate(()=>window.__statuses)).slice(before);
  assert.ok(next.includes('Đang khởi động bộ nhận dạng chữ…')&&next.includes('Nhận dạng chữ bằng Tesseract trên thiết bị, thay cho PaddleOCR…'),next.join(' | '));
  assert.ok(!next.some(line=>line.startsWith('Đang tải')),'nothing is downloaded again');assert.equal(await page.isHidden('#ocr-download'),true);
  assert.deepEqual(paddleLines(),['HEAD /vendor/paddle/worker.js'],'PaddleOCR is looked up once per tab');
  assert.equal(counts.translate,2);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A PaddleOCR worker that does not load gives way to Tesseract within seconds; the warning blames neither browser nor network',{skip,timeout:120000},async()=>{
 const id='6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',counts={ocr:0,translate:0};
 const {context,page,errors}=await openStudy({api:scanApi(id,counts),init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}})});
 const paddle=await paddleMissing(context,{workerFound:true});
 try{
  await historyLoaded(page);await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
  await page.fill('#content-title','Bài scan thử');await page.fill('#api-key',KEY);await pickScan(page,await scannedPdf(page),'bai-scan.pdf');
  const tesseract=tesseractRequested(page);await page.click('#translate');await tesseract;
  const started=paddle.find(entry=>entry.line==='GET /vendor/paddle/worker.js')?.at,waited=Date.now()-started;
  assert.ok(started&&waited<5000,`Tesseract started ${waited} ms after the PaddleOCR worker was asked for (the per-page backstop is 180 s)`);
  const notice='Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR. Không mở được PaddleOCR (/vendor/paddle/worker.js); bản cài này có thể thiếu PaddleOCR.';
  await page.waitForFunction(text=>document.querySelector('#warnings').textContent.includes(text),notice,{timeout:90000});await runFinished(page);
  assert.deepEqual(paddle.map(entry=>entry.line),['HEAD /vendor/paddle/worker.js','GET /vendor/paddle/worker.js'],'one worker, no model request');
  assert.equal(await page.isHidden('#ocr-download'),true,'no Save-Data, no question');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
});

test('Local OCR gives up on an engine that never reports progress, and lets a working one through',async()=>{
 const {stallGuard}=await import('../frontend/local-ocr.js');
 await assert.rejects(stallGuard(new Promise(()=>{}),60,'Tesseract cục bộ không phản hồi.'),error=>error.code==='ocr_stalled'&&/không phản hồi/u.test(error.message));
 assert.equal(await stallGuard(new Promise(resolve=>setTimeout(()=>resolve('ok'),20)),500),'ok');
 await assert.rejects(stallGuard(Promise.reject(new Error('wasm hỏng')),500),/wasm hỏng/u);
});
