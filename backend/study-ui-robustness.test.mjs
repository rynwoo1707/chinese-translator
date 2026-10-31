import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {MODES,modeLabel,modeProfile,LAYOUT_VERSION} from '../frontend/translation-modes.js';
import {errorResponse} from './http.js';

// Xưởng dịch in Microsoft Edge, for what a student does to a session after it started: changing Cách dịch or Lĩnh vực,
// a key Gemini refuses or not, saves the server refuses, PDFs that cannot be opened, the phone layout of books, the
// history's cap, and the page's status lines. The real study.html, study.css and study.js; /api answered here, every other
// host blocked; no Gemini. Skipped when Edge is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url));
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

const ORIGIN='http://localhost:4179',KEY='AIzaSy'+'x'.repeat(33),ASSET='0b0e4c1e-2f7a-4d55-9a51-6c1f9f0d2a11';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.wasm':'application/wasm'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const SAME_MODEL={economy:'gemini-test',balanced:'gemini-test',quality:'gemini-test',pdf:'gemini-test',runtimeVersion:'test'};
const now=()=>new Date().toISOString();
// A text session saved with two of its three parts translated (revision 4 on the server).
const PARTS=['第一段：学而时习之，不亦说乎。','第二段：有朋自远方来，不亦乐乎。','第三段：人不知而不愠，不亦君子乎。'],DONE=['Đoạn một đã dịch.','Đoạn hai đã dịch.'];
const TEXT_ID='5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const textItem=(over={})=>({id:TEXT_ID,title:'Luận ngữ',filename:'',domain:'history',mode:'economy',status:'translating',translated_parts:2,total_parts:3,library_story_id:null,library_chapter_id:null,created_at:'2026-10-20 07:00:00',updated_at:'2026-10-20 08:00:00',page_start:null,page_end:null,source_total_pages:null,source_sha256:null,revision:4,...over});
const textState=(translationParts=[...DONE,''],done=2)=>({source:PARTS.join('\n\n'),parts:PARTS,translationParts,done,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:''});
const MANIFEST={version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:1,pages:[{number:1,width:400,height:560,original:PNG,background:PNG,blocks:[{id:'p1-b1',text:'第一段的内容。',source:'第一段的内容。',box:[40,60,260,92],fontSize:12}],images:[],drawings:[],ocr:false,protectedRegions:[],extractionVersion:LAYOUT_VERSION}],warnings:[]};
const LAYOUT_ITEM={id:'5d7c1f7e-1111-4c2b-9d1e-2a2f0c9b7a10',title:'Bài thử giữ bố cục',filename:'bai-thu.pdf',domain:'general',mode:'economy',status:'complete',translated_parts:1,total_parts:1,library_story_id:null,library_chapter_id:null,updated_at:'2026-10-20 08:00:00',page_start:1,page_end:1,source_total_pages:1,revision:2};

const defaults=(path,method)=>path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/config'?SAME_MODEL:path==='/api/my/study/library-match'?{match:null}:path==='/api/my/study/models'?{models:[{id:'gemini-test'}],requested:'gemini-test',selected:'gemini-test'}:undefined;
// api(path,method,json,url) -> a body, {fakeStatus,json,headers}, {fakeAbort:true} (the connection drops) or undefined
// (the defaults above). bodies: every /api request with its JSON body.
async function openStudy({api=()=>undefined,viewport={width:1280,height:900},init=null,options={}}={}){
 const context=await browser.newContext({viewport,...options}),page=await context.newPage(),requests=[],errors=[],bodies=[];
 page.on('pageerror',error=>errors.push(String(error)));if(init)await context.addInitScript(init);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();requests.push(`${method} ${path}`);
  if(path.startsWith('/api/')){
   let json=null;try{json=JSON.parse(request.postData()||'null');}catch{}bodies.push({method,path,json});
   let body=await api(path,method,json,url);if(body===undefined)body=defaults(path,method);
   if(body===undefined)return route.fulfill({status:404,json:{error:`fake: ${method} ${path}`}});
   if(body?.fakeAbort)return route.abort('failed');
   if(body?.fakeStatus)return route.fulfill({status:body.fakeStatus,json:body.json,headers:body.headers||{}});
   return route.fulfill({json:body});
  }
  const file=normalize(join(root,path==='/study'?'study.html':path));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);if(!data)return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,headers:{'Content-Type':TYPES[extname(file)]||'application/octet-stream'},body:data});
 });
 await page.goto(`${ORIGIN}/study`);await page.waitForFunction(()=>document.body.dataset.session!=='checking');
 return {context,page,requests,errors,bodies};
}
const historyLoaded=page=>page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
// The session of TEXT_ID opened with two of its three parts translated.
const RESTORED=/Đã khôi phục 2\/3 (?:phần|đoạn)/u;
const progress=page=>page.textContent('#progress');
const waitProgress=(page,pattern,timeout=30000)=>page.waitForFunction(source=>new RegExp(source,'u').test(document.querySelector('#progress').textContent),pattern.source,{timeout});
async function openHistoryItem(page,id){if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');await page.click(`[data-history-open="${id}"]`);}
// A control in a row's ⋯ menu: the menu's button is pressed first, as a student does.
async function inMenu(page,selector){if(!await page.$eval(selector,node=>node.closest('details.menu').open))await page.$eval(selector,node=>node.closest('details.menu').querySelector(':scope>summary').click());await page.click(selector);}
// Bắt đầu dịch is hidden once nothing is left to run; the run behind it is still pressed here, to show it sends nothing.
async function pressRun(page){assert.equal(await page.isHidden('#translate'),true,'nothing is left to run, so the button is hidden');await page.$eval('#translate',button=>button.click());}
// The server's history of one text session: saves are checked against its revision as backend/study-history.js does.
function textServer({item=textItem(),state=textState()}={}){
 const server={item:{...item},state:structuredClone(state),translateCalls:[],saves:[]};
 server.save=(json,status='translating')=>{if(json.revision!==undefined&&json.revision!==server.item.revision)return {fakeStatus:409,json:{error:'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác. Hãy tải lại bản dịch từ Lịch sử dịch rồi tiếp tục, để không ghi đè phần đã dịch.',code:'history_conflict',revision:server.item.revision,updatedAt:server.item.updated_at}};
  server.item.revision++;server.state=structuredClone(json.state);const complete=json.state.done===json.state.parts.length;Object.assign(server.item,{status:complete?'complete':status,translated_parts:json.state.done,mode:json.mode,domain:json.domain});
  return {id:server.item.id,status:server.item.status,libraryStoryId:null,libraryChapterId:null,updatedAt:now(),revision:server.item.revision};};
 return server;
}

describe('Xưởng dịch: what happens to a session after it started, in Edge',{concurrency:4},()=>{
test('Changing Cách dịch or Lĩnh vực on an opened session translates only the parts left; the saved parts are never sent again or overwritten',{skip,timeout:90000},async()=>{
 const server=textServer();
 const {context,page,bodies,errors}=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [server.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...server.item,state:server.state};
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT')return server.save(json);
  if(path==='/api/my/study/translate'){server.translateCalls.push(json);return {translation:'Đoạn ba đã dịch.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};}
 }});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,RESTORED);
  await page.selectOption('#mode','quality');const said=await progress(page);
  // Looking through the subjects writes nothing into the session's own terms.
  await page.selectOption('#domain','math');const terms=await page.inputValue('#glossary');await page.selectOption('#domain','chemistry');await page.fill('#glossary','');
  await page.fill('#api-key',KEY);await page.click('#translate');await waitProgress(page,/^Xong · \d+ phần/u);
  assert.deepEqual(server.translateCalls.map(call=>[call.source,call.mode,call.domain]),[[PARTS[2],'quality','chemistry']],'only the part left, with the new settings');
  const puts=bodies.filter(entry=>entry.method==='PUT');assert.ok(puts.length>=2,String(puts.length));
  for(const put of puts){assert.deepEqual(put.json.state.translationParts.slice(0,2),DONE);assert.ok(put.json.state.done>=2,'a save never resets the session');}
  assert.equal(puts[0].json.revision,4,'the first save names the revision it was opened at');assert.equal(puts.at(-1).json.state.done,3);assert.equal(puts.at(-1).json.mode,'quality');
  assert.equal(terms,'','no math terms written into an opened session');
  assert.match(said,/^Cách dịch mới áp dụng cho các phần chưa dịch; 2 phần đã dịch được giữ nguyên, không dịch lại\.$/u);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A finished session stays as it is when Cách dịch changes: Bắt đầu dịch calls no Gemini and saves nothing over it',{skip,timeout:60000},async()=>{
 const server=textServer({item:textItem({status:'complete',translated_parts:3}),state:textState([...DONE,'Đoạn ba đã dịch.'],3)});
 const {context,page,bodies,errors}=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [server.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...server.item,state:server.state};
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT')return server.save(json);
  if(path==='/api/my/study/translate'){server.translateCalls.push(json);return {translation:'x',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,/Bản dịch đã hoàn tất/u);
  await page.selectOption('#mode','quality');const said=await progress(page);
  await page.fill('#api-key',KEY);await pressRun(page);await waitProgress(page,/Tài liệu này đã dịch xong trong phiên|^Xong|Đang dịch/u);await page.waitForFunction(()=>!document.querySelector('#translate').disabled);
  assert.equal(server.translateCalls.length,0);assert.deepEqual(bodies.filter(entry=>['PUT','POST'].includes(entry.method)&&entry.path.startsWith('/api/my/study/history')),[]);
  assert.equal(server.state.done,3);assert.match(await progress(page),/^Tài liệu này đã dịch xong trong phiên\. Không gọi Gemini lại\.$/u);
  assert.match(said,/^Bản dịch này đã hoàn tất nên được giữ nguyên\. Cách dịch mới áp dụng cho tài liệu bạn dịch tiếp theo/u);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Another source on a session with translated parts (a new range of a PDF read in the browser) becomes a new session; the saved one is not saved over',{skip,timeout:60000},async()=>{
 const server=textServer(),created='6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';let posts=0;
 const {context,page,bodies,errors}=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [server.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...server.item,state:server.state};
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT')return server.save(json);
  if(path==='/api/my/study/history'&&method==='POST'){posts++;return {id:created,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};}
  if(path===`/api/my/study/history/${created}`&&method==='PUT')return {id:created,status:'complete',libraryStoryId:null,updatedAt:now(),revision:2};
  if(path==='/api/my/study/translate'){server.translateCalls.push(json);return {translation:'Trang mới đã dịch.',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,RESTORED);
  // What reading another range in the browser does: the source box is filled by the page, not typed.
  await page.evaluate(()=>{document.querySelector('#source').value='第四页：温故而知新，可以为师矣。';});
  await page.fill('#api-key',KEY);await page.click('#translate');await waitProgress(page,/^Xong · 1 phần/u);
  assert.equal(posts,1,'a new session');assert.deepEqual(bodies.filter(entry=>entry.method==='PUT'&&entry.path.endsWith(TEXT_ID)),[],'the saved session is not saved over');
  assert.deepEqual(server.state.translationParts,[...DONE,'']);assert.deepEqual(server.translateCalls.map(call=>call.source),['第四页：温故而知新，可以为师矣。']);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Toán học fills its suggested terms only into an empty field before anything is translated, and takes them back with the subject',{skip},async()=>{
 const {context,page,errors}=await openStudy();
 try{
  await historyLoaded(page);
  await page.selectOption('#domain','math');assert.match(await page.inputValue('#glossary'),/^空间向量与立体几何 = Hình học vectơ/u);
  await page.selectOption('#domain','history');assert.equal(await page.inputValue('#glossary'),'','browsing the list leaves no math terms behind');
  await page.fill('#glossary','史料 = sử liệu');await page.selectOption('#domain','math');await page.selectOption('#domain','general');
  assert.equal(await page.inputValue('#glossary'),'史料 = sử liệu','the student\'s own terms are never replaced');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Only a refused key is forgotten: a refused text and Gemini\'s location keep it, whatever their words',{skip,timeout:90000},async()=>{
 const id='6b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';let calls=0;
 const answers=[
  {fakeStatus:400,json:{error:'Gemini từ chối trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.',code:'gemini_refused',usage:{prompt:5,output:0,total:5,requests:1}}},
  {fakeStatus:503,json:{error:'Gemini chưa phục vụ khu vực của máy chủ Hoa Trí vừa gửi yêu cầu, nên lượt dịch này chưa chạy và không tốn token. Khóa của bạn vẫn dùng được, không cần nhập lại; hãy thử lại sau ít phút.',code:'gemini_location',retryAfter:60},headers:{'Retry-After':'60'}},
  {fakeStatus:400,json:{error:'Gemini từ chối yêu cầu (400): khóa Gemini API không hợp lệ hoặc đã hết hạn. Hãy kiểm tra lại khóa trong Google AI Studio.',code:'gemini_key'}}
 ];
 const {context,page,errors}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST')return {id,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};
  if(path===`/api/my/study/history/${id}`&&method==='PUT')return {id,status:'draft',libraryStoryId:null,updatedAt:now(),revision:2};
  if(path==='/api/my/study/translate')return answers[calls++];
 }});
 const keyState=()=>page.evaluate(()=>({status:document.querySelector('#key-status').textContent,invalid:document.querySelector('#api-key').getAttribute('aria-invalid')}));
 try{
  await historyLoaded(page);await page.fill('#content-title','Thử khóa');await page.fill('#api-key',KEY);await page.fill('#source','子曰：学而时习之，不亦说乎？');
  await page.click('#translate');await waitProgress(page,/trùng khớp nguyên văn/u);
  assert.deepEqual(await keyState(),{status:'Đã nạp khóa · chỉ dùng trong tab này, không lưu.',invalid:null},'a refused text keeps the key');
  // The field is empty now (the key lives in the tab's memory): Bắt đầu dịch goes on without asking for it.
  await page.click('#translate');await waitProgress(page,/Khóa của bạn vẫn dùng được/u);
  assert.equal(calls,2);assert.deepEqual(await keyState(),{status:'Đã nạp khóa · chỉ dùng trong tab này, không lưu.',invalid:null},'Gemini\'s location keeps the key');
  await page.click('#translate');await waitProgress(page,/^Chưa dịch: dán khóa khác rồi bấm Bắt đầu dịch\.$/u);
  assert.deepEqual(await keyState(),{status:'Gemini không nhận khóa này · chỉ dùng trong tab này, không lưu.',invalid:'true'},'a refused key is forgotten');
  await page.click('#translate');await waitProgress(page,/^Dán khóa Gemini rồi bấm /u);assert.equal(calls,3);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// S4: a key refused after parts were translated says those parts stay, and names the button that goes on. S2: a lost
// connection names the run button only when a run failed; a history row or an export that loses it says to try again there,
// never a button that is hidden or does something else.
test('A key refused mid-run keeps the parts translated and names Dịch tiếp; a history row or an export that loses the connection says to try again',{skip,timeout:90000},async()=>{
 const server=textServer(),BROKEN='5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c5e',BOOK={library_story_id:'book-1',library_chapter_id:'chapter-1'};let translates=0;
 const layoutState={source:'第一段的内容。',parts:['第一段的内容。'],translationParts:['Nội dung đoạn một.'],done:1,context:'',glossary:{},manualGlossary:{},pdfLayout:{assetId:ASSET}};
 const {context,page,errors}=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [server.item,{...LAYOUT_ITEM,...BOOK},textItem({id:BROKEN,title:'Bài mở không được'})];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...server.item,state:server.state};
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT')return server.save(json);
  if(path===`/api/my/study/history/${BROKEN}`)return {fakeAbort:true};
  if(path===`/api/my/study/history/${LAYOUT_ITEM.id}`&&method==='GET')return {...LAYOUT_ITEM,...BOOK,state:layoutState};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return MANIFEST;
  if(path==='/api/my/study/pdf-layout/render')return {fakeAbort:true};
  if(path==='/api/my/study/translate'){translates++;return {fakeStatus:400,json:{error:'Gemini từ chối yêu cầu (400): khóa Gemini API không hợp lệ hoặc đã hết hạn. Hãy kiểm tra lại khóa trong Google AI Studio.',code:'gemini_key'}};}
 }});
 const view=()=>page.evaluate(()=>({progress:document.querySelector('#progress').textContent,run:document.querySelector('#translate').hidden?'':document.querySelector('#translate').textContent}));
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,RESTORED);
  await page.fill('#api-key',KEY);await page.click('#translate');await waitProgress(page,/^Dán khóa khác/u);
  assert.deepEqual(await view(),{progress:'Dán khóa khác rồi bấm Dịch tiếp; phần đã dịch vẫn còn.',run:'Dịch tiếp'});
  assert.equal(translates,1);assert.deepEqual(server.state.translationParts.slice(0,2),DONE,'the parts translated before are still saved');
  // A history row that cannot be opened is tried again from the row.
  await page.click(`[data-history-open="${BROKEN}"]`);await waitProgress(page,/^Mất kết nối/u);
  assert.equal(await progress(page),'Mất kết nối. Kiểm tra mạng rồi thử lại; phần đã dịch vẫn còn.');
  // A finished kept layout: nothing is left to run (no run button shows), so a lost export says to try again.
  await openHistoryItem(page,LAYOUT_ITEM.id);await waitProgress(page,/^Chưa có PDF tiếng Việt\./u);
  await page.click('#download-pdf');await waitProgress(page,/^Mất kết nối/u);
  assert.deepEqual(await view(),{progress:'Mất kết nối. Kiểm tra mạng rồi thử lại; phần đã dịch vẫn còn.',run:''});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// S5: a PDF refused only for its size as a kept layout is read in the browser once that box is unticked, as the refusal
// says. S6: a pasted-text session opened from the history afterwards hides the box, which no longer does anything.
test('A PDF too large for a kept layout is read in the browser once "Giữ bố cục PDF" is unticked; a text session opened afterwards hides the box',{skip,timeout:90000},async()=>{
 const {PDFDocument}=require('@cantoo/pdf-lib'),made=await PDFDocument.create();made.addPage([400,560]);const bytes=Buffer.from(await made.save());
 // The browser takes the picked file for 120 MB (Blob.size) without such a file being made: the bytes read are a small PDF's.
 const init=()=>{const size=Object.getOwnPropertyDescriptor(Blob.prototype,'size');Object.defineProperty(Blob.prototype,'size',{configurable:true,get(){return this instanceof File&&this.name==='sach-lon.pdf'?120*1024*1024:size.get.call(this);}});};
 const server=textServer();
 const {context,page,errors}=await openStudy({init,api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [server.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...server.item,state:server.state};
 }});
 const option=()=>page.evaluate(()=>!document.querySelector('.pdf-layout-option').hidden);
 try{
  await historyLoaded(page);await page.waitForFunction(()=>document.querySelector('#pdf-layout-enabled').checked);
  await page.setInputFiles('#source-file',{name:'sach-lon.pdf',mimeType:'application/pdf',buffer:bytes});
  await waitProgress(page,/^PDF giữ bố cục tối đa 100 MB\. Bỏ chọn “Giữ bố cục PDF và xuất PDF tiếng Việt” để dịch thành văn bản\.$/u);
  assert.equal(await option(),true,'the box the refusal names is in view');
  await page.uncheck('#pdf-layout-enabled');
  await page.waitForFunction(()=>!document.querySelector('#pdf-range-options').hidden,null,{timeout:30000});
  assert.match(await page.textContent('#file-status'),/^1 trang/u);assert.equal(await progress(page),'','the refusal is gone');
  await openHistoryItem(page,TEXT_ID);await waitProgress(page,RESTORED);
  assert.equal(await option(),false,'no box for a pasted text');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A save the server refuses says why and stops before Gemini: a full history, a copy saved from another tab; a lost answer is not a conflict',{skip,timeout:120000},async()=>{
 const FULL='Lịch sử dịch của tài khoản đã có 300 bản dịch, mức tối đa cho mỗi tài khoản. Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.';
 // 1. The history is full: the first save is refused once (not tried again), with the server's words.
 let posts=0,translations=0;
 const full=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST'){posts++;return {fakeStatus:413,json:{error:FULL,code:'history_full',items:300,maxItems:300,bytes:1,maxBytes:2}};}
  if(path==='/api/my/study/translate'){translations++;return {translation:'x',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(full.page);await full.page.fill('#content-title','Thử lưu');await full.page.fill('#api-key',KEY);await full.page.fill('#source','子曰：学而时习之。');await full.page.click('#translate');
  await waitProgress(full.page,/chưa gửi thêm gì cho Gemini/u);
  assert.equal(translations,0);assert.equal(posts,1);assert.equal(await progress(full.page),'Đã dừng; chưa gửi thêm gì cho Gemini.');
  const warning=await full.page.textContent('#save-warning');assert.ok(warning.includes(FULL),warning);assert.doesNotMatch(warning,/kiểm tra mạng/u);
  assert.deepEqual(full.errors,[]);
 }finally{await full.context.close();}
 // 2. Another tab saved the session since it was opened here: the save names its revision and is refused.
 const elsewhere=textServer({item:textItem({revision:7}),state:textState()});let opened=false;
 const conflict=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [elsewhere.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET'){const answer={...elsewhere.item,state:elsewhere.state};if(!opened){opened=true;elsewhere.item={...elsewhere.item,revision:9};elsewhere.state=textState([...DONE,'Bản của thẻ khác.'],3);}return answer;}
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT')return elsewhere.save(json);
  if(path==='/api/my/study/translate'){elsewhere.translateCalls.push(json);return {translation:'Đoạn ba.',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(conflict.page);await openHistoryItem(conflict.page,TEXT_ID);await waitProgress(conflict.page,RESTORED);
  await conflict.page.fill('#api-key',KEY);await conflict.page.click('#translate');await waitProgress(conflict.page,/chưa gửi thêm gì cho Gemini|^Xong/u);
  assert.equal(elsewhere.translateCalls.length,0,'no Gemini call on a copy that is not the latest');assert.match(await conflict.page.textContent('#save-warning'),/vừa được lưu từ một tab hoặc thiết bị khác/u);assert.deepEqual(elsewhere.state.translationParts,[...DONE,'Bản của thẻ khác.'],'the other tab\'s save is kept');
  assert.equal(conflict.bodies.find(entry=>entry.method==='PUT').json.revision,7);
  assert.match(await conflict.page.textContent('#save-warning'),/^Chưa lưu được: Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác\. Hãy tải lại bản dịch từ Lịch sử dịch/u);
  // One click opens the newest copy (after the usual question about this tab's unsaved part).
  let asked=0;conflict.page.on('dialog',dialog=>{asked++;dialog.accept().catch(()=>{});});
  await conflict.page.click('#save-warning .save-warning-action');await waitProgress(conflict.page,/^Bản dịch đã hoàn tất/u);
  assert.equal(asked,1);assert.match(await conflict.page.inputValue('#translation'),/Bản của thẻ khác\./u);assert.equal(await conflict.page.evaluate(()=>document.querySelector('#save-warning').hidden),true);
  assert.deepEqual(conflict.errors,[]);
 }finally{await conflict.context.close();}
 // 3. A save that reached the server but whose answer was lost is sent again with the revision it was made from: the
 //    stored copy is this tab's own, so the run goes on.
 const lost=textServer({item:textItem({revision:3}),state:textState()});let dropped=false;const revisions=[];
 const retry=await openStudy({api:(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [lost.item];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...lost.item,state:lost.state};
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='PUT'){revisions.push(json.revision);const answer=lost.save(json);if(!dropped&&!answer.fakeStatus){dropped=true;return {fakeAbort:true};}return answer;}
  if(path==='/api/my/study/translate'){lost.translateCalls.push(json);return {translation:'Đoạn ba đã dịch.',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(retry.page);await openHistoryItem(retry.page,TEXT_ID);await waitProgress(retry.page,RESTORED);
  await retry.page.fill('#api-key',KEY);await retry.page.click('#translate');await waitProgress(retry.page,/^Xong · 3 phần/u);
  assert.equal(lost.translateCalls.length,1);assert.equal(lost.state.done,3);assert.equal(await retry.page.evaluate(()=>document.querySelector('#save-warning').hidden),true);
  assert.equal(revisions[0],3);assert.equal(revisions.at(-1),lost.item.revision-1,'the last save names the revision the retried one made');
  assert.deepEqual(retry.errors,[]);
 }finally{await retry.context.close();}
});

test('A database behind the code is named in the server\'s words, start.cmd on this machine: the save is sent once and nothing reaches Gemini',{skip,timeout:90000},async t=>{
 // backend/http.js's own answer to a database without migration 0026, for a page on this machine (loopback).
 t.mock.method(console,'error',()=>{});
 const outdated=async(path,text)=>{const url=new URL(ORIGIN+path),response=errorResponse(new Error(text),{request:new Request(url),url,path});return {fakeStatus:response.status,json:await response.json()};};
 const LOCAL=/^Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start\.cmd \(hoặc npm run db:local rồi khởi động lại\)\. Mã [\w-]+\.$/u;
 // 1. The history list: its card says it, with Thử lại.
 const list=await openStudy({api:(path,method)=>path==='/api/my/study/history'&&method==='GET'?outdated(path,'D1_ERROR: no such column: engine at offset 65: SQLITE_ERROR'):undefined});
 try{
  await historyLoaded(list.page);const card=await list.page.textContent('#study-history-list .load-error');
  assert.match(card,/^Chưa tải được lịch sử dịch\.Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start\.cmd/u);assert.deepEqual(list.errors,[]);
 }finally{await list.context.close();}
 // 2. The first save of a run: refused once (no wait mends it), the run stops before Gemini, and nothing blames the network.
 let posts=0,translations=0;
 const save=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST'){posts++;return outdated(path,'D1_ERROR: table study_sessions has no column named engine: SQLITE_ERROR');}
  if(path==='/api/my/study/translate'){translations++;return {translation:'x',context:'',glossary:{},usage:{},warnings:[]};}
 }});
 try{
  await historyLoaded(save.page);await save.page.fill('#content-title','Thử lưu');await save.page.fill('#api-key',KEY);await save.page.fill('#source','子曰：学而时习之。');await save.page.click('#translate');
  await waitProgress(save.page,/chưa gửi thêm gì cho Gemini/u);
  assert.equal(posts,1);assert.equal(translations,0);
  const said=await progress(save.page),warning=await save.page.textContent('#save-warning'),refusal=warning.replace(/^Chưa lưu được vào tài khoản: /u,'').replace(/ Đừng đóng tab\.$/u,'');
  assert.equal(said,'Đã dừng; chưa gửi thêm gì cho Gemini.');assert.notEqual(refusal,warning,warning);assert.match(refusal,LOCAL);
  assert.match(warning,/^Chưa lưu được vào tài khoản: Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start\.cmd/u);
  for(const text of [said,warning])assert.doesNotMatch(text,/[Kk]iểm tra mạng/u);
  assert.deepEqual(save.errors,[]);
 }finally{await save.context.close();}
});

test('A PDF with a password, or a file that is not a PDF, is explained in Vietnamese and leaves nothing picked; a good PDF then opens',{skip,timeout:90000},async()=>{
 const {PDFDocument}=require('@cantoo/pdf-lib'),make=async(encrypt=false)=>{const pdf=await PDFDocument.create();pdf.addPage([400,560]);if(encrypt)pdf.encrypt({userPassword:'mat-khau',ownerPassword:'chu-so-huu'});return Buffer.from(await pdf.save());};
 const locked=await make(true),good=await make(),broken=Buffer.from('Đây không phải là tệp PDF.','utf8');
 const {context,page,errors}=await openStudy();
 const pick=(name,buffer)=>page.setInputFiles('#source-file',{name,mimeType:'application/pdf',buffer});
 const picked=()=>page.evaluate(()=>({status:document.querySelector('#file-status').textContent,progress:document.querySelector('#progress').textContent,range:document.querySelector('#pdf-range-options').hidden,mode:document.querySelector('#book-mode').hidden,body:document.body.innerText}));
 try{
  await historyLoaded(page);await page.waitForFunction(()=>document.querySelector('#pdf-layout-enabled').checked);
  // Each failed pick ends with the progress line in its error state; the page is then read as it stands.
  const failed=async(name,buffer)=>{await page.evaluate(()=>{document.querySelector('#progress').className='';});await pick(name,buffer);await page.waitForSelector('#progress.error',{timeout:30000});return picked();};
  for(const layout of [true,false]){
   if(!layout)await page.uncheck('#pdf-layout-enabled');
   let state=await failed('khoa.pdf',locked);
   assert.match(state.status,/^Chưa mở được “khoa\.pdf”\. PDF này có mật khẩu mở tệp nên Hoa Trí không đọc được\./u,`layout ${layout}`);
   assert.match(state.progress,/^Chưa mở được tệp “khoa\.pdf”/u);assert.equal(state.range,true);assert.equal(state.mode,true);
   assert.doesNotMatch(state.body,/No password given|Invalid PDF structure|Đang kiểm tra/u);
   state=await failed('hong.pdf',broken);assert.match(state.status,/^Chưa mở được “hong\.pdf”\. Không đọc được tệp PDF này: tệp bị hỏng, chưa tải về đủ hoặc không phải PDF/u,`layout ${layout}`);assert.doesNotMatch(state.body,/Invalid PDF structure/u);
  }
  // The same picker then reads a good PDF, layout on again; the error of the file before leaves the progress line and the
  // floating action bar of phones (which repeats it).
  await page.check('#pdf-layout-enabled');await pick('tot.pdf',good);await page.waitForFunction(()=>/^1 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  assert.equal(await page.evaluate(()=>document.querySelector('#pdf-range-options').hidden),false);
  const lines=()=>page.evaluate(()=>({progress:document.querySelector('#progress').textContent,type:document.querySelector('#progress').className,bar:document.querySelector('#run-bar-status').textContent,barError:document.querySelector('#run-bar-status').classList.contains('error')}));
  assert.deepEqual(await lines(),{progress:'',type:'',bar:'',barError:false});
  // Photos that cannot be read, then a good PDF: the same.
  await page.setInputFiles('#source-file',[{name:'trang-1.jpg',mimeType:'image/jpeg',buffer:Buffer.from('không phải ảnh')},{name:'trang-2.jpg',mimeType:'image/jpeg',buffer:Buffer.from('cũng không phải ảnh')}]);
  await page.waitForSelector('#progress.error',{timeout:30000});assert.match(await page.textContent('#progress'),/^Không đọc được ảnh “trang-1\.jpg”/u);
  await pick('tot.pdf',good);await page.waitForFunction(()=>!document.querySelector('#progress').className,null,{timeout:30000});
  assert.deepEqual(await lines(),{progress:'',type:'',bar:'',barError:false});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Phone: a book with several parts and its whole-book run stay inside 360 and 390 px',{skip,timeout:60000},async()=>{
 const sha='e'.repeat(64),titles=['Sử ký Tư Mã Thiên · trang 1–20','Sử ký Tư Mã Thiên · trang 21–40','Sử ký Tư Mã Thiên · trang 41–60','Sử ký Tư Mã Thiên · trang 61–80'];
 const parts=titles.map((title,i)=>({id:`chapter-${i+1}`,title,position:i+1,mime:'application/pdf',sessionId:`session-${i+1}`,filename:'su-ky.pdf',pageStart:i*20+1,pageEnd:i*20+20,totalPages:120,sha256:sha,pages:null}));
 const job={id:'0b7e2a43-0000-4000-8000-0000000000aa',sourceSha256:sha,filename:'su-ky.pdf',title:'Sử ký Tư Mã Thiên',storyId:'book-1',totalPages:120,pageStates:'c'+'d'.repeat(79)+'.'.repeat(40),chunkSize:20,domain:'history',mode:'economy',model:null,status:'paused',pauseReason:'quota_day',usage:{prompt:0,output:0,thinking:0,total:123456,requests:9},glossary:{},createdAt:'2026-10-19T01:00:00.000Z',updatedAt:'2026-10-20T01:00:00.000Z',runner:null,leaseSeconds:0};
 const sessions=parts.map((part,i)=>({id:part.sessionId,title:part.title,filename:'su-ky.pdf',domain:'history',mode:'economy',status:'complete',translated_parts:40,total_parts:40,library_story_id:'book-1',library_chapter_id:part.id,created_at:`2026-10-19 0${2+i}:00:00`,updated_at:`2026-10-19 0${2+i}:30:00`,page_start:part.pageStart,page_end:part.pageEnd,source_total_pages:120,source_sha256:sha,revision:3}));
 const api=(path,method)=>path==='/api/my/study/books'?[{id:'book-1',title:'Sử ký Tư Mã Thiên',cover:{image:false,page:null,sha256:null},parts}]:path==='/api/my/study/book-jobs'?{jobs:[job]}:path==='/api/my/study/history'&&method==='GET'?sessions:undefined;
 for(const width of [390,360]){
  const {context,page,errors}=await openStudy({api,viewport:{width,height:800}});
  try{
   await historyLoaded(page);if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
   await page.waitForSelector('#study-books-list .book-job');await page.click('#study-books-list .book-job-parts summary');
   const measure=await page.evaluate(()=>{const right=selector=>Math.max(...[...document.querySelectorAll(selector)].map(node=>node.getBoundingClientRect().right));return {scroll:document.documentElement.scrollWidth,inner:innerWidth,rows:right('#study-books-list .study-book'),menus:right('#study-books-list details.menu > summary'),buttons:right('#study-books-list button')};});
   assert.ok(measure.scroll<=measure.inner&&measure.rows<=measure.inner&&measure.menus<=measure.inner&&measure.buttons<=measure.inner,`${width}: ${JSON.stringify(measure)}`);
   // The ⋯ menu opens inside the screen too.
   await page.click('#study-books-list .book-job details.menu > summary');assert.ok(await page.$eval('#study-books-list .book-job .menu-list',list=>{const box=list.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth;}));
   assert.match(await page.textContent('#study-books-list .book-job'),/Các phần đã lưu \(4\)/u);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
});

test('Status lines: reduced motion scrolls at once, the file line is announced, the history list is not re-read on each save',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy({options:{reducedMotion:'reduce'},init:()=>{window.__scrolls=[];const scroll=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(options){window.__scrolls.push(options?.behavior||'');return scroll.call(this,options);};},api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [textItem({status:'complete',translated_parts:3})];
  if(path===`/api/my/study/history/${TEXT_ID}`&&method==='GET')return {...textItem({status:'complete',translated_parts:3}),state:textState([...DONE,'Đoạn ba.'],3)};
 }});
 try{
  await historyLoaded(page);await openHistoryItem(page,TEXT_ID);await waitProgress(page,/Bản dịch đã hoàn tất/u);
  const scrolls=await page.evaluate(()=>window.__scrolls);assert.ok(scrolls.includes('auto')&&!scrolls.includes('smooth'),`no forced smooth scroll for a student who asked for reduced motion: ${scrolls}`);
  assert.deepEqual(await page.evaluate(()=>[document.querySelector('#file-status').getAttribute('role'),document.querySelector('#study-history-list').getAttribute('aria-live'),document.querySelector('#study-history-count').getAttribute('aria-live')]),['status',null,'polite']);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A dialog closed while it works tells its late failure in the progress line, and never closes a dialog opened since',{skip,timeout:60000},async()=>{
 const ids=['7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e01','7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e02'],rows=ids.map((id,i)=>textItem({id,title:`Bài ${i+1}`,status:'complete',translated_parts:3}));
 let release=null,deletes=0;
 const {context,page,errors}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return rows;
  if(ids.some(id=>path===`/api/my/study/history/${id}`)&&method==='DELETE'){deletes++;return new Promise(resolve=>{release=resolve;});}
 }});
 try{
  await historyLoaded(page);await page.click('#study-history > summary');
  // Escape while "Đang xóa…": the dialog is gone, so a refusal arriving later is told in the progress line.
  await inMenu(page,`[data-history-delete="${ids[0]}"]`);await page.click('#book-dialog-submit');await page.waitForFunction(()=>document.querySelector('#book-dialog-status').textContent==='Đang xóa…');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#book-dialog').open);
  release({fakeStatus:500,json:{error:'Máy chủ đang bận, chưa xóa được.'}});await waitProgress(page,/^Máy chủ đang bận, chưa xóa được\.$/u);
  // A later dialog is not closed by an earlier one that ends after it was opened.
  await inMenu(page,`[data-history-delete="${ids[0]}"]`);await page.click('#book-dialog-submit');await page.waitForFunction(n=>document.querySelector('#book-dialog-status').textContent==='Đang xóa…',2);
  await page.keyboard.press('Escape');await inMenu(page,`[data-history-delete="${ids[1]}"]`);await page.waitForFunction(()=>document.querySelector('#book-dialog').open);
  release({ok:true,removedBookId:null});await waitProgress(page,/^Đã xóa bản dịch\.$/u);
  assert.equal(await page.evaluate(()=>document.querySelector('#book-dialog').open),true,'the dialog opened since stays open');assert.match(await page.textContent('#book-dialog-body'),/Bài 2/u);
  assert.equal(deletes,2);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A history longer than a page lists the rest with "Xem thêm bản cũ hơn", a page at a time by the server\'s cursor; a page that fails says so with Thử lại',{skip,timeout:60000},async()=>{
 // 230 sessions, newest first; the server answers 100 at a time and names the next page in X-Next-Before (opaque).
 const rows=Array.from({length:230},(_,i)=>textItem({id:`8d9e0f1a-2b3c-4d4e-8f5a-${String(i).padStart(12,'0')}`,title:`Bài ${i+1}`,status:'complete',translated_parts:3,updated_at:`2026-10-${String(20-Math.floor(i/60)).padStart(2,'0')} 23:${String(59-i%60).padStart(2,'0')}:00`}));
 const pages={'':[0,'trang-2'],'trang-2':[100,'trang-3'],'trang-3':[200,'']},asked=[];let removed=0,failOnce=true;
 const {context,page,errors}=await openStudy({api:(path,method,json,url)=>{
  if(path==='/api/my/study/history'&&method==='GET'){
   const before=url.searchParams.get('before')||'';asked.push(before);
   if(before==='trang-3'&&failOnce){failOnce=false;return {fakeStatus:503,json:{error:'Máy chủ đang bận. Hãy thử lại sau ít phút.'}};}
   const [start,next]=pages[before];return {fakeStatus:200,json:rows.slice(start,start+100),headers:next?{'X-Next-Before':next}:{}};
  }
  if(path===`/api/my/study/history/${rows[0].id}`&&method==='DELETE'){removed++;return {ok:true,removedBookId:null};}
 }});
 const listed=()=>page.$$eval('#study-history-list [data-history-open]',buttons=>buttons.length);
 try{
  await historyLoaded(page);
  assert.equal(await page.textContent('#study-history-count'),'· 100+');assert.equal(await listed(),100);
  assert.equal(await page.textContent('#study-history-list .history-more'),'Xem bản cũ hơn');
  // The next page goes under the cards; keyboard users go on from its first session.
  await page.click('#study-history > summary');await page.click('#study-history-list [data-history-more]');
  await page.waitForSelector(`[data-history-open="${rows[100].id}"]`);
  assert.equal(await page.textContent('#study-history-count'),'· 200+');assert.equal(await listed(),200);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.historyOpen),rows[100].id);
  // A page that fails says why and offers Thử lại; the cards already listed stay.
  await page.click('#study-history-list [data-history-more]');await page.waitForSelector('#study-history-list .history-more-error');
  assert.equal(await page.textContent('#study-history-list .history-more-error'),'Chưa tải được các bản cũ hơn. Máy chủ đang bận. Hãy thử lại sau ít phút.');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Thử lại');assert.equal(await listed(),200);
  await page.click('#study-history-list [data-history-more]');await page.waitForSelector(`[data-history-open="${rows[229].id}"]`);
  assert.equal(await page.textContent('#study-history-count'),'· 230');assert.equal(await page.$('#study-history-list .history-more'),null);
  assert.deepEqual(asked,['','trang-2','trang-3','trang-3']);
  // Deleting one leaves the rest as listed, without loading the list again.
  await inMenu(page,`[data-history-delete="${rows[0].id}"]`);await page.click('#book-dialog-submit');await waitProgress(page,/^Đã xóa bản dịch\.$/u);
  assert.equal(removed,1);assert.equal(await listed(),229);assert.equal(await page.textContent('#study-history-count'),'· 229');assert.equal(asked.length,4);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Phone: a long book title and the line of its parts wrap inside the row, instead of being cut off or widening the page',{skip,timeout:60000},async()=>{
 const sha='f'.repeat(64),title='Tuyển_tập_đề_thi_học_sinh_giỏi_Toán_THPT_toàn_quốc_2015–2024_có_lời_giải_chi_tiết',titles=['Quyển thượng: Đại số và giải tích','Quyển hạ: Hình học và tổ hợp'];
 const parts=titles.map((part,i)=>({id:`chapter-${i+1}`,title:part,position:i+1,mime:'application/pdf',sessionId:`session-${i+1}`,filename:'de-thi.pdf',pageStart:i*20+1,pageEnd:i*20+20,totalPages:40,sha256:sha,pages:null}));
 const {context,page,errors}=await openStudy({viewport:{width:360,height:740},api:path=>path==='/api/my/study/books'?[{id:'book-2',title,cover:{image:false,page:null,sha256:null},parts}]:undefined});
 try{
  await historyLoaded(page);if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
  await page.waitForSelector('#study-books-list .study-book');
  const measure=await page.evaluate(()=>{
   const row=document.querySelector('#study-books-list .study-book'),title=row.querySelector('.row-title'),line=row.querySelector('.row-meta');
   return {scroll:document.documentElement.scrollWidth,inner:innerWidth,row:row.getBoundingClientRect().right,title:title.scrollWidth<=title.clientWidth,line:line.textContent,lineWhole:line.scrollWidth<=line.clientWidth&&line.scrollHeight<=line.clientHeight+1};
  });
  assert.ok(measure.scroll<=measure.inner&&measure.row<=measure.inner,JSON.stringify(measure));
  // One line under the title: how many parts (their names are in Sắp xếp phần).
  assert.equal(measure.title,true,'the unbroken title wraps');assert.equal(measure.line,'2 phần');assert.equal(measure.lineWhole,true);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The library match says the library published the translation, not that a teacher reviewed it',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy({api:(path)=>path==='/api/my/study/library-match'?{match:{id:'story-1',title:'Luận ngữ',chapters:3}}:path==='/api/my/study/extract'?{text:'子曰：学而时习之。'}:undefined});
 try{
  await historyLoaded(page);await page.setInputFiles('#source-file',{name:'luan-ngu.txt',mimeType:'text/plain',buffer:Buffer.from('子曰：学而时习之。','utf8')});
  await page.waitForSelector('#library-match:not([hidden])');const banner=await page.textContent('#library-match');
  assert.doesNotMatch(banner,/giáo viên|duyệt/u);assert.match(banner,/^Thư viện chung đã có bản dịch của tệp này: “Luận ngữ”\./u);assert.equal((await page.textContent('#library-match-open')).trim(),'Đọc ngay (không tốn token)');assert.equal(await page.getAttribute('#library-match-open','href'),'/?read=story-1');
  assert.equal((await page.textContent('#library-match-dismiss')).trim(),'Tự dịch');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The key help gives Google\'s 18+ rule and the free-tier data note with their links; the empty count is in parts',{skip},async()=>{
 const {context,page,errors}=await openStudy();
 try{
  await historyLoaded(page);
  const terms=await page.evaluate(()=>{const note=document.querySelector('.key-help .key-terms');return note&&{text:note.textContent,links:[...note.querySelectorAll('a')].map(link=>link.getAttribute('href'))};});
  assert.ok(terms,'a note on Google\'s terms sits with the key help');
  assert.match(terms.text,/người dùng phải từ 18 tuổi trở lên/u);assert.match(terms.text,/Google có thể dùng nội dung bạn gửi để cải thiện sản phẩm và nhân viên của Google có thể đọc nội dung đó/u);
  assert.deepEqual(terms.links,['https://ai.google.dev/gemini-api/terms','/dieu-khoan#khoa-gemini']);
  assert.equal(await page.textContent('#part-count'),'0 phần dịch');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// Every mode now changes a kept-layout run too (thinking, call sizes, OCR sheets, readings read again), so the field is
// shown there and in "Dịch cả quyển" whatever models the server gives the modes (it was hidden when they shared one).
test('"Cách dịch" is shown in every kind of run (text, a kept-layout session, Dịch cả quyển), with its four modes',{skip,timeout:90000},async()=>{
 const {PDFDocument}=require('@cantoo/pdf-lib'),pdf=await PDFDocument.create();pdf.addPage([400,560]);const bytes=Buffer.from(await pdf.save());
 const {context,page,errors,requests}=await openStudy({api:(path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [LAYOUT_ITEM,textItem()];
  if(path===`/api/my/study/history/${LAYOUT_ITEM.id}`)return {...LAYOUT_ITEM,state:{source:'第一段的内容。',parts:['第一段的内容。'],translationParts:['Nội dung đoạn một.'],done:1,context:'',glossary:{},manualGlossary:{},pdfLayout:{assetId:ASSET}}};
  if(path===`/api/my/study/history/${TEXT_ID}`)return {...textItem(),state:textState()};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return MANIFEST;
  if(path==='/api/my/study/pdf-layout/font')return {css:''};
 }});
 const shown=()=>page.evaluate(()=>{const field=document.querySelector('#mode-field'),hint=document.querySelector('#mode-hint');return !field.hidden&&getComputedStyle(field).display!=='none'&&getComputedStyle(hint).display!=='none'&&hint.getBoundingClientRect().height>0;});
 try{
  await historyLoaded(page);assert.equal(await shown(),true,'text');
  assert.deepEqual(await page.$$eval('#mode option',options=>options.map(option=>[option.value,option.textContent])),MODES.map(id=>[id,modeLabel(id)]));
  await openHistoryItem(page,LAYOUT_ITEM.id);await page.waitForFunction(()=>!document.querySelector('#translate').disabled&&document.querySelector('#part-count').textContent==='1 đoạn');
  assert.equal(await shown(),true,'a kept-layout session');assert.equal(await page.textContent('#mode-hint'),modeProfile('economy').brief);
  await openHistoryItem(page,TEXT_ID);await waitProgress(page,RESTORED);assert.equal(await shown(),true);
  await page.waitForFunction(()=>document.querySelector('#pdf-layout-enabled').checked);
  await page.setInputFiles('#source-file',{name:'sach.pdf',mimeType:'application/pdf',buffer:bytes});await page.waitForSelector('#book-mode:not([hidden])',{timeout:30000});
  await page.click('#book-mode label:has(input[value="book"])');await page.waitForSelector('#whole-book:not([hidden])');
  assert.equal(await shown(),true,'Dịch cả quyển');
  // Nothing asks the server which models the modes use any more to decide it.
  assert.equal(requests.includes('GET /api/my/study/config'),false);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
});
