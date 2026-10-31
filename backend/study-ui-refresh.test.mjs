import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {LAYOUT_VERSION,blockTokens} from '../frontend/translation-modes.js';

// "Cập nhật bố cục" in Xưởng dịch, in Microsoft Edge: a part an older extractor read (Thư viện riêng links it with
// /study?history=<id>&refresh=1) is offered a refresh and nothing else happens until it is pressed; the refresh keeps every
// block it finds again with its translation (by the saved id, never by the renumbered one), says how many blocks are new
// and about what they cost, and Bắt đầu dịch then reads and translates only those, and exports the part to replace the old
// one in its book. "Xuất PDF tiếng Việt" on the old layout offers the refresh first. The real study.html, study.css and
// study.js; /api, Gemini and the PDF service answered here, every other host blocked. Skipped when Edge or frontend/vendor
// (pdf.js, which shows the exported PDF) is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url)),{PDFDocument,StandardFonts}=require('@cantoo/pdf-lib');
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const vendor=await readFile(join(root,'vendor/pdf.mjs')).then(()=>true,()=>false);
const skip=!vendor?'frontend/vendor is not built here (npm run prepare:vendor)':browser?false:'Microsoft Edge is not available to playwright-core here';
const pdfBytes=async count=>{const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);for(let number=1;number<=count;number++)pdf.addPage([400,560]).drawText(`Trang ${number}`,{x:36,y:500,size:12,font});return Buffer.from(await pdf.save());};
test.after(()=>browser?.close());

const ORIGIN='http://localhost:4181',KEY='AIzaSy'+'x'.repeat(33),OLD='6a1b2c3d-1111-4a2b-8c3d-4e5f6a7b8c90',OLD_ASSET='7b2c3d4e-2222-4b3c-9d4e-5f6a7b8c9d01',NEW_ASSET='8c3d4e5f-3333-4c4d-8e5f-6a7b8c9d0e12',DRAFT='9d4e5f6a-4444-4d5e-9f6a-7b8c9d0e1f23';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const page=(number,ocr,blocks,extra={})=>({number,width:400,height:560,original:PNG,background:PNG,blocks,images:[],drawings:[],ocr,protectedRegions:[],...extra});
const block=(id,source,box,extra={})=>({id,source,text:source,box,fontSize:12,...extra});
const inline=token=>({token,text:'a+b',box:[120,94,150,106],image:PNG,width:30,height:12,axis:100});
// The saved part (extractor 2): a scanned page 4 (a heading, a formula row, a block whose reading kept the machine text)
// and a text-layer page 5. Its translations: the formula token is the older extractor's (from 0).
const OLD_MANIFEST={version:1,extractionVersion:2,engine:'pymupdf',totalPages:10,warnings:[],ocrCorrectedVersion:1,pages:[
 page(4,true,[block('p4-b1','第一节 向量',[40,40,300,64],{ocrCorrected:true,kind:'heading',bold:true}),block('p4-b2','若 @@PDF_INLINE_0@@，则成立。',[40,90,360,110],{ocrCorrected:true,inlines:[inline('@@PDF_INLINE_0@@')]}),block('p4-b3','（扫描）机器读的正文。',[40,300,360,340],{ocrCorrected:true,ocrKept:'refused'})]),
 page(5,false,[block('p5-b1','第二节 平面',[40,40,300,64]),block('p5-b2','正文一行。',[40,90,360,110])])
]};
const OLD_PARTS=['Mục 1. Vectơ','Nếu @@PDF_INLINE_0@@ thì đúng.','Đoạn đọc máy.','Mục 2. Mặt phẳng','Một dòng.'];
// What the Worker answers for the refresh (extractor LAYOUT_VERSION): blocks found again name their saved id (known) and
// carry the saved reading (the formula under its new token); new ones are numbered among them, on a sheet of their own.
const NEW_MANIFEST={version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:10,warnings:['Trang 4: dùng OCR; hãy đối chiếu công thức với ảnh gốc.'],ocrCorrectedVersion:0,pages:[
 page(4,true,[block('p4-b1','第一节 向量',[40,40,300,64],{known:'p4-b1',ocrCorrected:true,kind:'heading',bold:true}),block('p4-b2','若 @@PDF_INLINE_1@@，则成立。',[40,90,360,110],{known:'p4-b2',ocrCorrected:true,inlines:[inline('@@PDF_INLINE_1@@')]}),
  block('p4-b3','（扫描）探究',[40,150,200,170],{ocrSheet:'p4-s1',ocrLabel:'#1'}),block('p4-b4','（扫描）机器读的正文。',[40,300,360,342],{ocrSheet:'p4-s1',ocrLabel:'#2'})],
  {extractionVersion:LAYOUT_VERSION,ocrSheets:[{id:'p4-s1',image:PNG,strips:[{blockId:'p4-b3',label:'#1',box:[0,0,200,30]},{blockId:'p4-b4',label:'#2',box:[0,34,320,80]}]}]}),
 page(5,false,[block('p5-b1','第二节 平面',[40,40,300,64],{known:'p5-b1'}),block('p5-b2','正文一行。',[40,90,360,110],{known:'p5-b2'}),block('p5-b3','第一章 空间向量 5',[40,520,360,540])],{extractionVersion:LAYOUT_VERSION})
]};
const now=()=>new Date().toISOString();
const oldItem=()=>({id:OLD,title:'Vectơ trang 4–5',filename:'toan.pdf',domain:'math',mode:'economy',status:'complete',translated_parts:5,total_parts:5,library_story_id:'book-1',library_chapter_id:'chapter-1',created_at:'2026-10-15 08:00:00',updated_at:'2026-10-15 08:00:00',page_start:4,page_end:5,source_total_pages:10,source_sha256:null,revision:3,layout_version:null,replaces_chapter_id:null});

// The account: the old session, the refresh, OCR, translate-blocks, render and the saves, each call recorded.
// busy: how many refreshes first find the account's other PDF call holding the service (429 pdf_busy). finishedCopy: the
// old session is a draft (in no book yet) whose refreshed copy, naming its layout (refreshed_from), is finished in the book.
function fakeAccount({draft=false,busy=0,finishedCopy=false}={}){
 const account={calls:{refresh:0,ocr:0,translate:0,render:0},refreshBodies:[],ocrBodies:[],translateBodies:[],renderBodies:[],saves:[],session:null,revision:0,document:structuredClone(NEW_MANIFEST)};
 const draftItem={id:DRAFT,title:'Vectơ trang 4–5',filename:'toan.pdf',domain:'math',mode:'economy',status:'translating',translated_parts:4,total_parts:7,library_story_id:'book-1',library_chapter_id:null,created_at:'2026-10-29 08:00:00',updated_at:'2026-10-29 08:00:00',page_start:4,page_end:5,source_total_pages:10,source_sha256:null,revision:1,layout_version:LAYOUT_VERSION,replaces_chapter_id:'chapter-1'};
 account.api=async(path,method,json)=>{
  const old=()=>finishedCopy?{...oldItem(),status:'translating',translated_parts:4,library_story_id:null,library_chapter_id:null}:oldItem(),copied={...draftItem,status:'complete',translated_parts:7,library_chapter_id:'chapter-2',replaces_chapter_id:null,refreshed_from:OLD_ASSET};
  if(path==='/api/my/study/history'&&method==='GET')return finishedCopy?[copied,old()]:draft?[draftItem,old()]:[old()];
  if(path===`/api/my/study/history/${OLD}`&&method==='GET')return {...old(),state:{source:OLD_MANIFEST.pages.flatMap(p=>p.blocks).map(b=>b.source).join('\n\n'),parts:OLD_MANIFEST.pages.flatMap(p=>p.blocks).map(b=>b.source),translationParts:finishedCopy?[...OLD_PARTS.slice(0,4),'']:OLD_PARTS,done:finishedCopy?4:5,context:'',glossary:{向量:'vectơ'},manualGlossary:{},previousSource:'',previousTranslation:'',complete:!finishedCopy,pdfLayout:finishedCopy?{assetId:OLD_ASSET}:{assetId:OLD_ASSET,exported:true,renderVersion:2}}};
  // The refreshed session as the history opens it again: its saved state, the part it takes over.
  if(account.session&&path===`/api/my/study/history/${account.session.id}`&&method==='GET'){const {state}=account.session,complete=state.done===state.parts.length;return {id:account.session.id,title:account.session.title,filename:account.session.filename,domain:'math',mode:'economy',status:complete?'complete':'translating',translated_parts:state.done,total_parts:state.parts.length,library_story_id:'book-1',library_chapter_id:complete?'chapter-1':null,replaces_chapter_id:complete?null:'chapter-1',created_at:'2026-10-30 01:00:00',updated_at:'2026-10-30 01:00:00',page_start:4,page_end:5,source_total_pages:10,revision:account.revision,layout_version:LAYOUT_VERSION,state:{...state,complete}};}
  if(path===`/api/my/study/pdf-layout/assets/${OLD_ASSET}/manifest`)return OLD_MANIFEST;
  if(path===`/api/my/study/pdf-layout/assets/${NEW_ASSET}/manifest`)return account.document;
  if(path==='/api/my/study/pdf-layout/refresh'){account.calls.refresh++;account.refreshBodies.push(json);if(account.calls.refresh<=busy)return {fakeStatus:429,json:{error:'Tài khoản của bạn đang có một lượt xử lý PDF khác.',code:'pdf_busy',retryAfter:5}};return {fakeStatus:201,json:{assetId:NEW_ASSET,document:account.document,originalUrl:`/api/my/study/pdf-layout/assets/${NEW_ASSET}/original`}};}
  if(path==='/api/my/study/history'&&method==='POST'||/^\/api\/my\/study\/history\/[a-f\d-]{36}$/u.test(path)&&method==='PUT'){
   if(path.endsWith(OLD))throw new Error('the old session is never saved over');
   account.revision++;account.saves.push(structuredClone(json));const complete=json.state.done===json.state.parts.length;account.session={id:json.id||path.split('/').pop(),...json};
   return {id:account.session.id,status:complete?'complete':json.state.done?'translating':'draft',libraryStoryId:'book-1',libraryChapterId:complete?'chapter-1':null,updatedAt:now(),revision:account.revision};
  }
  if(path==='/api/my/study/pdf-layout/ocr-blocks'){
   account.calls.ocr++;account.ocrBodies.push(json);const blocks=account.document.pages[0].blocks.filter(b=>json.blockIds.includes(b.id));
   for(const b of blocks){b.source=b.text=b.source.replace('（扫描）','');b.ocrCorrected=true;}
   account.document.ocrCorrectedVersion=account.document.pages[0].blocks.every(b=>b.ocrCorrected)?1:0;
   return {blocks:blocks.map(({id,source,text})=>({id,source,text,ocrCorrected:true})),ocrCorrectedVersion:account.document.ocrCorrectedVersion,ocrWarnings:[],usage:{prompt:1100,output:120,total:1220,requests:1},warnings:[],model:json.model};
  }
  if(path==='/api/my/study/translate-blocks'){account.calls.translate++;account.translateBodies.push(json);return {blocks:json.blocks.map(b=>({id:b.id,translation:`Bản dịch mới ${b.id}.`})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'};}
  if(path==='/api/my/study/pdf-layout/render'){account.calls.render++;account.renderBodies.push(json);return {url:`/api/my/study/pdf-layout/assets/${json.assetId}/translated`,renderVersion:3};}
  if(/^\/api\/my\/study\/pdf-layout\/assets\/[a-f\d-]{36}\/translated$/u.test(path))return {fakeBody:await pdfBytes(2),contentType:'application/pdf'};
 };
 return account;
}
const defaults=(path,method)=>path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/config'?{economy:'gemini-test',balanced:'gemini-test',quality:'gemini-test',pdf:'gemini-test'}:path==='/api/my/study/library-match'?{match:null}:path==='/api/my/study/models'?{models:[{id:'gemini-test'}],requested:'gemini-test',selected:'gemini-test'}:path==='/api/my/study/pdf-layout/font'?{css:''}:undefined;
async function openStudy(api,address='/study'){
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();
  if(path.startsWith('/api/')){
   let json=null;try{json=JSON.parse(request.postData()||'null');}catch{}
   let body;try{body=await api(path,method,json,url);}catch(error){return route.fulfill({status:500,json:{error:error.message}});}
   if(body===undefined)body=defaults(path,method);
   if(body===undefined)return route.fulfill({status:404,json:{error:`fake: ${method} ${path}`}});
   if(body?.fakeBody)return route.fulfill({status:200,headers:{'Content-Type':body.contentType},body:body.fakeBody});
   if(body?.fakeStatus)return route.fulfill({status:body.fakeStatus,json:body.json,headers:body.headers||{}});
   return route.fulfill({json:body});
  }
  const file=normalize(join(root,path==='/study'?'study.html':path));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);if(!data)return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,headers:{'Content-Type':TYPES[extname(file)]||'application/octet-stream'},body:data});
 });
 await page.goto(`${ORIGIN}${address}`);await page.waitForFunction(()=>document.body.dataset.session==='in');
 return {context,page,errors};
}
const waitProgress=(page,pattern,timeout=60000)=>page.waitForFunction(source=>new RegExp(source,'u').test(document.querySelector('#progress').textContent),pattern.source,{timeout});
const notice=page=>page.evaluate(()=>{const box=document.querySelector('#layout-refresh');return box&&!box.hidden?{text:box.querySelector('p').textContent,button:box.querySelector('button')?.textContent||null,focused:document.activeElement===box.querySelector('button')}:null;});
const idle=page=>page.waitForFunction(()=>!document.querySelector('#translate').disabled,null,{timeout:60000});

describe('Cập nhật bố cục of a part an older extractor read, in Edge',{concurrency:3},()=>{
test('Opened from Thư viện riêng, the part is offered the refresh and nothing is paid; the refresh keeps every block found again with its translation, says what is new and about its cost; Bắt đầu dịch then reads and translates only that and exports over the old part',{skip,timeout:120000},async()=>{
 const account=fakeAccount(),{context,page,errors}=await openStudy(account.api,`/study?history=${OLD}&refresh=1`);
 try{
  await page.waitForFunction(()=>!document.querySelector('#layout-refresh')?.hidden,null,{timeout:30000});
  const offered=await notice(page);
  assert.equal(offered.button,'Cập nhật bố cục');assert.equal(offered.focused,true,'the link\'s refresh=1 points at the button');assert.equal(offered.text,'Phần này dùng bố cục cũ: tiêu đề hoặc chú thích ngoài các đoạn có thể còn chữ Trung. Cập nhật bố cục không tốn token; Hoa Trí báo số đoạn và token trước khi dịch.','no internal extractor number');
  assert.equal(await page.textContent('#progress'),'','the note says it once');
  assert.equal(await page.evaluate(()=>location.search),'','the address drops its query, so a reload does not open it again');
  assert.deepEqual(account.calls,{refresh:0,ocr:0,translate:0,render:0},'nothing is extracted or paid before the button');assert.equal(await page.textContent('#usage-total'),'0');
  await page.click('#layout-refresh button');
  // Extracted again (no Gemini); the saved part is untouched until the new one is exported.
  const cost=blockTokens({sheets:1,characters:['（扫描）探究','（扫描）机器读的正文。','第一章 空间向量 5'].join('').length,requests:2},'economy'),shown=new Intl.NumberFormat('vi-VN').format(Math.round(cost/100)*100);
  // Of the 5 blocks translated, 4 are found again as they were; the one whose text region grew is read and translated again.
  const summary=`Còn 3 đoạn cần đọc và dịch (1 đoạn đổi vùng chữ khi tách lại), khoảng ${shown} token; giữ bản dịch của 4/5 đoạn.`;
  await waitProgress(page,/^Đã cập nhật bố cục\./u);
  assert.equal(await page.textContent('#progress'),'Đã cập nhật bố cục. Bấm Dịch tiếp để đọc và dịch các đoạn mới.');assert.equal(await page.textContent('#translate'),'Dịch tiếp');
  assert.deepEqual(account.refreshBodies,[{assetId:OLD_ASSET,forceClone:true,mode:'economy'}]);assert.deepEqual({...account.calls,refresh:undefined},{refresh:undefined,ocr:0,translate:0,render:0});
  assert.equal((await notice(page)).text,`${summary} Phần cũ vẫn ở Thư viện riêng tới khi PDF mới xuất xong.`);
  // The new session takes the old part over in its book; the translations go with the blocks found again, never by id:
  // the new p4-b3 is a heading the old layout did not have, the old p4-b3 is the new p4-b4 (grown, read again).
  const first=account.saves[0];assert.equal(first.bookId,'book-1');assert.equal(first.replaceChapterId,'chapter-1');assert.equal(first.state.pdfLayout.assetId,NEW_ASSET);
  assert.deepEqual(first.state.translationParts,['Mục 1. Vectơ','Nếu @@PDF_INLINE_1@@ thì đúng.','','','Mục 2. Mặt phẳng','Một dòng.','']);assert.equal(first.state.done,4);
  assert.deepEqual(first.state.glossary,{向量:'vectơ'},'the session keeps its terms');
  // The old part opened again points at the refreshed copy instead of offering a second refresh; that copy, opened anew
  // (as after a reload), still reads only its new blocks.
  if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
  await page.click(`[data-history-open="${OLD}"]`);await page.waitForFunction(()=>document.querySelector('#layout-refresh button')?.textContent==='Mở bản cập nhật bố cục');
  await page.click('#layout-refresh button');await page.waitForFunction(id=>document.querySelector(`[data-history-open="${id}"]`)?.closest('.history-card')?.classList.contains('is-active'),account.session.id);
  assert.equal(account.calls.refresh,1,'no second refresh');
  // Bắt đầu dịch: one sheet read (the new blocks only), the three new blocks translated, the part exported.
  await page.fill('#api-key',KEY);await page.click('#translate');
  await waitProgress(page,/^Xong · PDF đã lưu vào Thư viện riêng/u);
  assert.deepEqual(account.ocrBodies.map(body=>body.blockIds),[['p4-b3','p4-b4']]);
  assert.deepEqual(account.translateBodies.flatMap(body=>body.blocks.map(b=>b.id)),['p4-b3','p4-b4','p5-b3']);
  assert.deepEqual(account.renderBodies.map(body=>body.assetId),[NEW_ASSET]);
  const last=account.saves.at(-1);assert.equal(last.state.done,7);assert.deepEqual(last.state.translationParts,['Mục 1. Vectơ','Nếu @@PDF_INLINE_1@@ thì đúng.','Bản dịch mới p4-b3.','Bản dịch mới p4-b4.','Mục 2. Mặt phẳng','Một dòng.','Bản dịch mới p5-b3.']);
  assert.equal(await notice(page),null,'nothing left to offer');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Xuất PDF tiếng Việt on the old layout offers the refresh first; "Vẫn xuất bản cũ" draws the old layout again without extracting anything',{skip,timeout:120000},async()=>{
 const account=fakeAccount(),{context,page,errors}=await openStudy(account.api);
 try{
  await page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
  if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
  await page.click(`[data-history-open="${OLD}"]`);await page.waitForFunction(()=>!document.querySelector('#download-pdf').disabled);
  await page.click('#download-pdf');await page.waitForFunction(()=>document.querySelector('#book-dialog').open);
  assert.equal(await page.textContent('#book-dialog-title'),'Bố cục của phần này đã cũ');assert.equal(await page.textContent('#book-dialog-submit'),'Cập nhật bố cục');
  assert.equal(await page.textContent('#book-dialog-body'),'Xuất lại sẽ giữ bố cục cũ (tiêu đề, chú thích ngoài các đoạn vẫn là chữ Trung). Cập nhật bố cục không tốn token và báo trước số token cho phần mới.');
  assert.deepEqual(await page.$$eval('#book-dialog .book-dialog-actions button',buttons=>buttons.map(button=>[button.textContent,button.className])),[['Hủy','secondary'],['Vẫn xuất bản cũ','secondary'],['Cập nhật bố cục','primary']]);
  assert.equal(account.calls.render,0,'not exported before the student chooses');
  // The export is downloaded as before (and the download finished before the page closes, which the shared browser needs).
  const downloaded=page.waitForEvent('download');
  await page.click('#book-dialog [data-dialog-extra]');await page.waitForFunction(()=>!document.querySelector('#book-dialog').open);
  const download=await downloaded;assert.equal(download.suggestedFilename(),'Vectơ trang 4–5.vi.pdf');await download.delete();
  await waitProgress(page,/^Xong · PDF đã lưu vào Thư viện riêng/u);
  assert.deepEqual(account.renderBodies,[{assetId:OLD_ASSET,historyId:OLD}]);assert.equal(account.calls.refresh,0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A part this extractor read is offered nothing: no notice, and Xuất PDF tiếng Việt exports at once',{skip,timeout:120000},async()=>{
 const account=fakeAccount(),current={...OLD_MANIFEST,extractionVersion:LAYOUT_VERSION},api=(path,method,json)=>path===`/api/my/study/pdf-layout/assets/${OLD_ASSET}/manifest`?current:account.api(path,method,json);
 const {context,page,errors}=await openStudy(api,`/study?history=${OLD}&refresh=1`);
 try{
  await page.waitForFunction(()=>!document.querySelector('#download-pdf').disabled);assert.equal(await notice(page),null);
  const downloaded=page.waitForEvent('download');await page.click('#download-pdf');const download=await downloaded;await download.delete();
  await waitProgress(page,/^Xong · PDF đã lưu vào Thư viện riêng/u);
  assert.deepEqual(account.renderBodies,[{assetId:OLD_ASSET,historyId:OLD}]);assert.equal(account.calls.refresh,0,'no refresh asked when the stamps match');
  assert.equal(await page.evaluate(()=>document.querySelector('#book-dialog').open),false);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// Bắt đầu dịch would translate on the old layout: a stop while the refresh waits names the button that asks again.
test('Dừng while Cập nhật bố cục waits for the PDF service says to press Cập nhật bố cục again',{skip,timeout:120000},async()=>{
 const account=fakeAccount({busy:5}),{context,page,errors}=await openStudy(account.api,`/study?history=${OLD}&refresh=1`);
 try{
  await page.waitForFunction(()=>!document.querySelector('#layout-refresh')?.hidden,null,{timeout:30000});await page.click('#layout-refresh button');
  await waitProgress(page,/Tự thử lại sau \d+ giây… Bấm Dừng để thôi chờ\.$/u);await page.click('#stop');
  await waitProgress(page,/^Tài khoản của bạn đang có một lượt xử lý PDF khác \(ở tab hoặc thiết bị khác\)\. Đã thôi chờ; bấm Cập nhật bố cục khi muốn thử lại\.$/u);
  assert.equal(account.calls.refresh,1);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// A draft whose refreshed copy is finished in the book (it named this draft's layout) is neither refreshed again nor
// translated on: finished too, it would give the book the same pages twice. It points at that copy instead.
test('A draft whose refreshed copy is finished points at that copy: no second refresh, and Bắt đầu dịch translates nothing',{skip,timeout:120000},async()=>{
 const account=fakeAccount({finishedCopy:true}),{context,page,errors}=await openStudy(account.api,`/study?history=${OLD}`);
 try{
  await page.waitForFunction(()=>!document.querySelector('#layout-refresh')?.hidden,null,{timeout:30000});
  const offered=await notice(page);assert.equal(offered.button,'Mở bản cập nhật bố cục');assert.match(offered.text,/^Bố cục của phần này đã được cập nhật trong một bản dịch đã xong; bản này không cần dịch tiếp\./u);
  await page.fill('#api-key',KEY);await page.click('#translate');
  await waitProgress(page,/^Bố cục của phần này đã được cập nhật trong một bản dịch đã xong, nên bản này không dịch tiếp/u);
  assert.deepEqual(account.calls,{refresh:0,ocr:0,translate:0,render:0});assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A part whose refreshed copy was begun already (here or on another device) offers that copy, not a second refresh',{skip,timeout:120000},async()=>{
 const account=fakeAccount({draft:true}),{context,page,errors}=await openStudy(account.api,`/study?history=${OLD}&refresh=1`);
 try{
  await page.waitForFunction(()=>!document.querySelector('#layout-refresh')?.hidden,null,{timeout:30000});
  const offered=await notice(page);assert.equal(offered.button,'Mở bản cập nhật bố cục');assert.match(offered.text,/còn 3 đoạn chưa dịch/u);
  assert.equal(account.calls.refresh,0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
});
