import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';

// The study page's states in Microsoft Edge: the real study.html, study.css and study.js, with /api answered here and
// every other host blocked. Signed out, the start-up requests, a history that fails to load, saves that keep failing, an
// expired session. Skipped when Edge is missing.
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
async function openStudy({api=()=>undefined,viewport={width:1280,height:900}}={}){
 const context=await browser.newContext({viewport}),page=await context.newPage(),requests=[],errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
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
});

test('Local OCR gives up on an engine that never reports progress, and lets a working one through',async()=>{
 const {stallGuard}=await import('../frontend/local-ocr.js');
 await assert.rejects(stallGuard(new Promise(()=>{}),60,'Tesseract cục bộ không phản hồi.'),error=>error.code==='ocr_stalled'&&/không phản hồi/u.test(error.message));
 assert.equal(await stallGuard(new Promise(resolve=>setTimeout(()=>resolve('ok'),20)),500),'ok');
 await assert.rejects(stallGuard(Promise.reject(new Error('wasm hỏng')),500),/wasm hỏng/u);
});
