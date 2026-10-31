import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
// A manifest the extractor of this code made carries its stamp (an older one is offered "Cập nhật bố cục").
import {LAYOUT_VERSION} from '../frontend/translation-modes.js';
// The words of the download dialog inside an app come from in-app-browser.js (the app's name, the browser, its menu).
import {openInBrowserHelp} from '../frontend/in-app-browser.js';

// Xưởng dịch in Microsoft Edge, for what reaches the student's device and browser: the notice an old browser gets, the
// downloads (inside Zalo, Messenger… first the way to Chrome or Safari; an address that outlives a slow download), the
// PDF view once every block is translated, and a history longer than a page. The real study.html, study.css and
// study.js; /api answered here, every other host blocked; no Gemini. Skipped when Edge is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url));
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

const ORIGIN='http://localhost:4179',ASSET='0b0e4c1e-2f7a-4d55-9a51-6c1f9f0d2a11';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const ZALO_IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/24.07.01';
// A finished text session of three parts, and a finished one-block layout session whose PDF was not exported yet.
const TEXT_ID='5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',PARTS=['第一段：学而时习之。','第二段：有朋自远方来。','第三段：人不知而不愠。'],DONE=['Đoạn một.','Đoạn hai.','Đoạn ba.'];
const textItem=(over={})=>({id:TEXT_ID,title:'Luận ngữ',filename:'',domain:'history',mode:'economy',status:'complete',translated_parts:3,total_parts:3,library_story_id:null,library_chapter_id:null,created_at:'2026-10-20 07:00:00',updated_at:'2026-10-20 08:00:00',page_start:null,page_end:null,source_total_pages:null,source_sha256:null,revision:2,...over});
const textState={source:PARTS.join('\n\n'),parts:PARTS,translationParts:DONE,done:3,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:''};
const MANIFEST={version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:1,pages:[{number:1,width:400,height:560,original:PNG,background:PNG,blocks:[{id:'p1-b1',text:'第一段的内容。',source:'第一段的内容。',box:[40,60,260,92],fontSize:12}],images:[],drawings:[],ocr:false,protectedRegions:[],extractionVersion:LAYOUT_VERSION}],warnings:[]};
const LAYOUT_ITEM={id:'5d7c1f7e-1111-4c2b-9d1e-2a2f0c9b7a10',title:'Bài thử giữ bố cục',filename:'bai-thu.pdf',domain:'general',mode:'economy',status:'complete',translated_parts:1,total_parts:1,library_story_id:null,library_chapter_id:null,updated_at:'2026-10-20 08:00:00',page_start:1,page_end:1,source_total_pages:1,revision:2};

const defaults=(path,method)=>path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/config'?{economy:'gemini-test',balanced:'gemini-test',quality:'gemini-test',pdf:'gemini-test'}:path==='/api/my/study/library-match'?{match:null}:path==='/api/my/study/pdf-layout/font'?{css:''}:undefined;
// api(path,method,json,url) -> a body, {fakeStatus,json,headers} or undefined (the defaults above).
async function openStudy({api=()=>undefined,viewport={width:1280,height:900},init=null,options={}}={}){
 const context=await browser.newContext({viewport,...options}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));if(init)await context.addInitScript(init);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();
  if(path.startsWith('/api/')){
   let json=null;try{json=JSON.parse(request.postData()||'null');}catch{}
   let body=await api(path,method,json,url);if(body===undefined)body=defaults(path,method);
   if(body===undefined)return route.fulfill({status:404,json:{error:`fake: ${method} ${path}`}});
   if(body?.fakeBody)return route.fulfill({status:200,headers:{'Content-Type':body.contentType},body:body.fakeBody});
   if(body?.fakeStatus)return route.fulfill({status:body.fakeStatus,json:body.json,headers:body.headers||{}});
   return route.fulfill({json:body});
  }
  const file=normalize(join(root,path==='/study'?'study.html':path));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);if(!data)return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,headers:{'Content-Type':TYPES[extname(file)]||'application/octet-stream'},body:data});
 });
 await page.goto(`${ORIGIN}/study`);await page.waitForFunction(()=>document.body.dataset.session!=='checking');
 return {context,page,errors};
}
const historyLoaded=page=>page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
const waitProgress=(page,pattern,timeout=30000)=>page.waitForFunction(source=>new RegExp(source,'u').test(document.querySelector('#progress').textContent),pattern.source,{timeout});
async function openHistoryItem(page,id){if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');await page.click(`[data-history-open="${id}"]`);}
const textSession=(path,method)=>path==='/api/my/study/history'&&method==='GET'?[textItem()]:path===`/api/my/study/history/${TEXT_ID}`&&method==='GET'?{...textItem(),state:textState}:undefined;
// Every blob address handed to a download link, and every address revoked, with the time since the page started.
const DOWNLOAD_LOG=()=>{window.__downloads=[];window.__revoked=[];const click=HTMLAnchorElement.prototype.click,revoke=URL.revokeObjectURL;HTMLAnchorElement.prototype.click=function(){if(this.download)window.__downloads.push(this.href);return click.call(this);};URL.revokeObjectURL=url=>{window.__revoked.push(url);return revoke.call(URL,url);};};

describe('Xưởng dịch on the student\'s device, in Edge',{concurrency:4},()=>{
test('A browser older than iOS/Safari 15.4 gets a notice on Xưởng dịch instead of a page that cannot work; a current one does not',{skip,timeout:60000},async()=>{
 // The notice is browser-check.js (a classic deferred script, as on the home page), loaded before the page's module.
 const html=readFileSync(new URL('../frontend/study.html',import.meta.url),'utf8'),check=html.indexOf('<script src="/browser-check.js" defer></script>'),module=html.indexOf('<script type="module" src="/study.js"></script>');
 assert.ok(check>0&&check<module,'browser-check.js comes before study.js');
 let {context,page,errors}=await openStudy({init:()=>{delete Object.hasOwn;}});
 try{
  await page.waitForSelector('#browser-notice',{timeout:15000});
  const notice=await page.evaluate(()=>{const box=document.querySelector('#browser-notice');return {parent:box.parentElement.tagName,first:document.body.firstElementChild===box,role:box.getAttribute('role'),title:box.querySelector('h1').textContent,text:box.querySelector('p').textContent,button:Boolean(box.querySelector('button')),styled:getComputedStyle(box).borderLeftStyle};});
  assert.deepEqual({...notice,text:undefined},{parent:'BODY',first:true,role:'alert',title:'Trình duyệt này quá cũ để mở Hoa Trí',text:undefined,button:false,styled:'solid'});assert.match(notice.text,/iOS 15\.4 trở lên/u);
 }finally{await context.close();}
 ({context,page,errors}=await openStudy());
 try{
  await historyLoaded(page);await page.waitForFunction(()=>document.readyState==='complete');await page.waitForTimeout(100);
  assert.equal(await page.$('#browser-notice'),null);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Inside Zalo a download first says how to open the page in Safari, with the address to copy; "Vẫn tải ở đây" downloads all the same',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy({api:textSession,options:{userAgent:ZALO_IPHONE}});let downloads=0;page.on('download',()=>{downloads++;});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,/Bản dịch đã hoàn tất/u);
  await page.click('#download');await page.waitForSelector('#book-dialog[open]');
  const dialog=await page.evaluate(()=>({title:document.querySelector('#book-dialog-title').textContent,body:document.querySelector('#book-dialog-body p').textContent,address:document.querySelector('#in-app-address').value,submit:document.querySelector('#book-dialog-submit').textContent,focused:document.activeElement.id}));
  assert.equal(dialog.title,'Mở bằng Safari để tải tệp về máy');assert.equal(dialog.address,`${ORIGIN}/study`);assert.equal(dialog.submit,'Vẫn tải ở đây');assert.equal(dialog.focused,'book-dialog-title');
  // One sentence of what happens there and the way out (the app's menu, as on the sign-in dialog), then that the
  // translation is saved.
  const {menu}=openInBrowserHelp({name:'Zalo',ios:true,android:false});
  assert.equal(menu,'Bấm ⋯ → “Mở trong Safari”');
  assert.equal(dialog.body,`Zalo thường không lưu được tệp tải về. ${menu}, hoặc sao chép địa chỉ rồi dán vào Safari; bản dịch đã lưu, có thể tải lại từ Lịch sử dịch.`);
  await page.click('#book-dialog-body .in-app-copy button');await page.waitForFunction(()=>document.querySelector('#book-dialog-body .in-app-copy [role="status"]').textContent);
  assert.match(await page.textContent('#book-dialog-body .in-app-copy [role="status"]'),/^(?:Đã sao chép\. Mở Safari rồi dán vào thanh địa chỉ\.|Không sao chép tự động được\. Địa chỉ đã được chọn)/u);
  assert.equal(downloads,0,'nothing is downloaded before the student chooses');
  const download=page.waitForEvent('download');await page.click('#book-dialog-submit');
  // read to its end before the context can close: Edge 155 crashes the shared browser on a context closed mid-download
  const file=await download;assert.equal(file.suggestedFilename(),'Luận ngữ.vi.txt');assert.ok(await file.path());await page.waitForFunction(()=>!document.querySelector('#book-dialog').open);
  // Hủy downloads nothing.
  await page.click('#download');await page.waitForSelector('#book-dialog[open]');await page.click('#book-dialog-cancel');await page.waitForTimeout(300);
  assert.equal(downloads,1);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A download outside such apps starts at once, and its address stays valid until the page is left, not one second',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy({api:textSession,init:DOWNLOAD_LOG});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,/Bản dịch đã hoàn tất/u);
  const download=page.waitForEvent('download');await page.click('#download');const file=await download;assert.equal(file.suggestedFilename(),'Luận ngữ.vi.txt');assert.ok(await file.path());
  assert.equal(await page.$('#book-dialog[open]'),null,'no dialog in an ordinary browser');
  await page.waitForTimeout(2500);
  const [url]=await page.evaluate(()=>window.__downloads);assert.match(url,/^blob:/u);
  assert.equal((await page.evaluate(()=>window.__revoked)).includes(url),false,'still valid 2.5 s later (a browser inside an app may read it late)');
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
  assert.equal((await page.evaluate(()=>window.__revoked)).filter(item=>item===url).length,1,'freed when the page is left');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The PDF view counts the blocks translated beside "Tiếng Việt" and keeps its notice for problems; the original\'s header says how to look a character up',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [LAYOUT_ITEM];
  if(path===`/api/my/study/history/${LAYOUT_ITEM.id}`)return {...LAYOUT_ITEM,state:{source:'第一段的内容。',parts:['第一段的内容。'],translationParts:['Nội dung đoạn một.'],done:1,context:'',glossary:{},manualGlossary:{},pdfLayout:{assetId:ASSET}}};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return MANIFEST;
 }});
 try{
  await historyLoaded(page);await openHistoryItem(page,LAYOUT_ITEM.id);
  await page.waitForFunction(()=>document.querySelector('#pdf-dual-viewer [data-pdf-render-state]')?.textContent==='1/1 đoạn');
  assert.equal(await page.textContent('#pdf-dual-viewer [data-pdf-notice]'),'','nothing is wrong, so nothing is said');assert.equal(await page.isHidden('#pdf-dual-viewer [data-pdf-notice]'),true);
  // A tooltip never shows on a touch screen: the way into Tra chữ Hán is written in the original's header (S57).
  assert.equal(await page.textContent('#pdf-dual-viewer [data-pdf-side="original"] h3 small'),'Chạm đoạn chữ để tra chữ Hán');
  assert.equal(await page.$('#pdf-dual-viewer .pdf-viewer-toolbar strong'),null,'no title above the pages');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
// S55 (components D and E): the three export buttons are one group: the format this session makes best is the main button
// (the view's one primary once nothing is left to run), the others are in its ▾ menu, and a format the session can never
// make is not shown. The menu is plain buttons in tab order: Escape closes it and gives the focus back, a tap outside
// closes it, and an item closes it.
const pdfFile=async()=>{const {PDFDocument}=require('@cantoo/pdf-lib'),pdf=await PDFDocument.create();pdf.addPage([400,560]);return Buffer.from(await pdf.save());};
test('The export group shows only what the session can make: Tải .txt alone for text, Tải PDF or Xuất PDF tiếng Việt with Văn bản (.txt) in ▾ for a kept layout; the menu works with the keyboard',{skip,timeout:90000},async()=>{
 const BOOK={library_story_id:'book-1',library_chapter_id:'chapter-1'},EXPORTED='6e7f8a9b-1111-4c2b-9d1e-2a2f0c9b7a11',layoutState=pdfLayout=>({source:'第一段的内容。',parts:['第一段的内容。'],translationParts:['Nội dung đoạn một.'],done:1,context:'',glossary:{},manualGlossary:{},pdfLayout});
 const bytes=await pdfFile();
 const {context,page,errors}=await openStudy({init:DOWNLOAD_LOG,api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [textItem(),{...LAYOUT_ITEM,...BOOK},{...LAYOUT_ITEM,...BOOK,id:EXPORTED,title:'Bài đã xuất'}];
  if(path===`/api/my/study/history/${TEXT_ID}`)return {...textItem(),state:textState};
  if(path===`/api/my/study/history/${LAYOUT_ITEM.id}`)return {...LAYOUT_ITEM,...BOOK,state:layoutState({assetId:ASSET})};
  if(path===`/api/my/study/history/${EXPORTED}`)return {...LAYOUT_ITEM,...BOOK,id:EXPORTED,title:'Bài đã xuất',state:layoutState({assetId:ASSET,exported:true,renderVersion:3})};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return MANIFEST;
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/translated`)return {fakeBody:bytes,contentType:'application/pdf'};
 }});
 const group=()=>page.evaluate(()=>{const root=document.querySelector('.result-actions'),visible=node=>Boolean(node&&!node.hidden&&node.getClientRects().length);return {shown:visible(root),main:[...root.querySelectorAll('.export-main>button')].map(button=>[button.id,button.textContent,button.className]),menu:visible(root.querySelector('.export-more')),items:[...root.querySelectorAll('.menu-list>button')].filter(button=>!button.hidden).map(button=>[button.id,button.textContent])};});
 try{
  await historyLoaded(page);
  // Nothing to download yet: no group, and the result section is not drawn at all.
  assert.deepEqual(await group(),{shown:false,main:[],menu:false,items:[]});assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.result')).display),'none');
  // Text without pictures: the text is the main download and there is no menu; nothing is left to run, so it is primary.
  await openHistoryItem(page,TEXT_ID);await waitProgress(page,/Bản dịch đã hoàn tất/u);
  assert.deepEqual(await group(),{shown:true,main:[['download','Tải .txt','primary']],menu:false,items:[]});assert.equal(await page.isHidden('#translate'),true);
  // A kept layout not exported yet: Xuất PDF tiếng Việt, the text in the menu; the page with pictures is never offered.
  await openHistoryItem(page,LAYOUT_ITEM.id);await page.waitForFunction(()=>/Xuất PDF tiếng Việt/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.deepEqual(await group(),{shown:true,main:[['download-pdf','Xuất PDF tiếng Việt','primary']],menu:true,items:[['download','Văn bản (.txt)']]});
  assert.equal(await page.isHidden('#download-rich'),true,'a kept layout never makes the page with pictures');
  assert.equal(await page.getAttribute('.export-more > summary','aria-label'),'Tải định dạng khác');
  // Keyboard: Enter opens, Tab reaches the item, Escape closes and gives the focus back to ▾.
  await page.focus('.export-more > summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('.export-more',menu=>menu.open),true);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'download');
  await page.keyboard.press('Escape');assert.deepEqual(await page.evaluate(()=>[document.querySelector('.export-more').open,document.activeElement===document.querySelector('.export-more > summary')]),[false,true]);
  // Tab past its last item closes it too: the open list never covers what the focus moved on to.
  await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.press('Tab');
  assert.deepEqual(await page.evaluate(()=>[document.querySelector('.export-more').open,Boolean(document.activeElement?.closest('.export-more')),document.activeElement!==document.body]),[false,false,true]);
  // A tap outside closes it.
  await page.click('.export-more > summary');assert.equal(await page.$eval('.export-more',menu=>menu.open),true);
  await page.mouse.click(5,300);assert.equal(await page.$eval('.export-more',menu=>menu.open),false);
  // An item closes the menu, leaves the focus on ▾ and downloads.
  await page.click('.export-more > summary');const download=page.waitForEvent('download');await page.click('#download');const file=await download;assert.equal(file.suggestedFilename(),'Bài thử giữ bố cục.vi.txt');assert.ok(await file.path());
  assert.deepEqual(await page.evaluate(()=>[document.querySelector('.export-more').open,document.activeElement===document.querySelector('.export-more > summary')]),[false,true]);
  // Exported already: the main button downloads the saved PDF (Tải PDF).
  await openHistoryItem(page,EXPORTED);await page.waitForFunction(()=>document.querySelector('#pdf-dual-viewer [data-pdf-render-state]')?.textContent==='PDF đã xuất',null,{timeout:30000});
  assert.deepEqual((await group()).main,[['download-pdf','Tải PDF','primary']]);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// Component J (critic): a row's open ⋯ menu stays above the rows after it, so its last item takes the tap; one menu is
// open at a time; its button is named after the row.
test('A row\'s ⋯ menu opens above the rows after it: the last item of a row that is not the last takes the click; one menu is open at a time',{skip,timeout:60000},async()=>{
 const ids=['7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f01','7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f02','7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f03'];
 const rows=ids.map((id,i)=>textItem({id,title:`Bài ${i+1}`,library_story_id:`book-${i+1}`,library_chapter_id:`chapter-${i+1}`}));
 const books=rows.map((row,i)=>({id:`book-${i+1}`,title:row.title,cover:{image:false,page:null,sha256:null},parts:[{id:`chapter-${i+1}`,title:row.title,position:1,mime:'text/plain',sessionId:row.id,filename:'',pageStart:null,pageEnd:null,totalPages:null,sha256:null,pages:null}]}));
 const {context,page,errors}=await openStudy({api:(path,method)=>path==='/api/my/study/history'&&method==='GET'?rows:path==='/api/my/study/books'?books:undefined});
 const open=()=>page.$$eval('#study-history-list details.menu',menus=>menus.map(menu=>menu.open));
 try{
  await historyLoaded(page);await page.click('#study-history > summary');
  assert.equal(await page.getAttribute(`#study-history-list .row:first-child details.menu > summary`,'aria-label'),'Thao tác cho “Bài 1”');
  await page.click('#study-history-list .row:nth-child(2) details.menu > summary');await page.click('#study-history-list .row:first-child details.menu > summary');
  assert.deepEqual(await open(),[true,false,false],'opening a menu closes the other');
  // Its items: the private library, the merge into another book, and Xóa… last, after a line.
  assert.deepEqual(await page.$$eval('#study-history-list .row:first-child .menu-list>:is(a,button)',items=>items.map(item=>[item.textContent,item.getAttribute('href')])),[['Đọc trong Thư viện riêng','/?read=book-1'],['Gộp vào sách…',null],['Xóa…',null]]);
  // The last item lies over the second row's ⋯ button: the click reaches the item (Playwright checks what is hit).
  await page.click(`#study-history-list [data-history-delete="${ids[0]}"]`);await page.waitForSelector('#book-dialog[open]');
  assert.equal(await page.textContent('#book-dialog-title'),'Xóa bản dịch?');assert.match(await page.textContent('#book-dialog-body'),/^“Bài 1” sẽ bị xóa vĩnh viễn khỏi lịch sử và Thư viện riêng/u);
  assert.deepEqual(await page.$eval('#book-dialog-submit',button=>[button.textContent,button.className]),['Xóa vĩnh viễn','primary danger']);
  await page.click('#book-dialog-cancel');assert.deepEqual(await open(),[false,false,false]);
  // The focus came back to the menu's button when the dialog closed.
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#study-history-list .row:first-child details.menu > summary')),true);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

});
