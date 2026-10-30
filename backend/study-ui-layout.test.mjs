import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
// A manifest the extractor of this code made carries its stamp (an older one is offered "Cập nhật bố cục").
import {LAYOUT_VERSION,modeProfile} from '../frontend/translation-modes.js';
import {overflowMessage,blockLabel} from '../services/pdf-layout/engine.mjs';
import {serviceFailure} from './pdf-layout.js';
import {translatePdfBlocks} from './pdf-block-translation.js';

// "Giữ bố cục PDF" for a range picked by hand, in Microsoft Edge: Dừng while a scan is read, the slim OCR answer, blocks
// Gemini will not translate (translate-blocks partial), a quota part-way, a busy or overloaded PDF service, scanned
// blocks Gemini could not read again, and an export refused for translations longer than their boxes. The real
// study.html, study.css and study.js; /api, Gemini and the PDF service answered here, every other host blocked.
// Skipped when Edge or frontend/vendor (pdf.js) is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url)),{PDFDocument,StandardFonts}=require('@cantoo/pdf-lib');
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const vendor=await readFile(join(root,'vendor/pdf.mjs')).then(()=>true,()=>false);
const skip=!vendor?'frontend/vendor is not built here (npm run prepare:vendor)':browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

const ORIGIN='http://localhost:4179',KEY='AIzaSy'+'x'.repeat(33),ASSET='3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',SESSION='4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.wasm':'application/wasm'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const now=()=>new Date().toISOString();
// A one-page manifest: count blocks, scanned (each block an image Gemini reads) or with a text layer.
function manifest(count,{scanned=false}={}){
 const blocks=Array.from({length:count},(_,i)=>{const source=scanned?`（扫描）第${i+1}段`:`第${i+1}段：学而时习之，不亦说乎。`;return {id:`p1-b${i+1}`,text:source,source,box:[40,40+i*36,360,68+i*36],fontSize:12,...(scanned?{image:PNG}:{})};});
 return {version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:1,pages:[{number:1,width:400,height:560,original:PNG,background:PNG,blocks,images:[],drawings:[],ocr:scanned,protectedRegions:[],extractionVersion:LAYOUT_VERSION}],warnings:[]};
}
// Ordinary text pages (not a cover), so the picked range starts at page 1 itself.
const pdfBytes=async(count=1)=>{const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);for(let number=1;number<=count;number++){const page=pdf.addPage([400,560]);for(let line=0;line<20;line++)page.drawText(`Trang ${number}, dong ${line+1}: noi dung mau de kiem tra bo cuc`,{x:36,y:520-line*20,size:10,font});}return Buffer.from(await pdf.save());};
// Two pages of text blocks (p1-b1… and p2-b1…), each page like manifest(count).
function twoPages(count){const document=manifest(count),second=structuredClone(document.pages[0]);second.number=2;second.blocks=second.blocks.map((b,i)=>({...b,id:`p2-b${i+1}`,text:`第二页第${i+1}段：温故而知新。`,source:`第二页第${i+1}段：温故而知新。`}));document.pages.push(second);document.totalPages=2;return document;}
const translated=id=>`Bản dịch ${id}.`;
const OCR_REFUSED='Gemini không trả bản đọc vì trùng khớp nguyên văn với nội dung có bản quyền';

// The account as the Worker keeps one layout session: extract, history (saves checked against the revision), OCR,
// translate-blocks and render. hooks may answer instead: extract(call), ocr(json,call), translate(json,call),
// render(json,call). ocrKept: {id: code} for blocks Gemini could not read again (backend/pdf-block-ocr.js): each keeps
// its machine text, is stored as read with its mark and named in a warning; keptUnmarked leaves those not marked read.
function fakeAccount(document,hooks={}){
 const account={document:structuredClone(document),session:null,revision:0,calls:{extract:0,ocr:0,translate:0,render:0,refresh:0},ocrBodies:[],translateBodies:[],renderBodies:[],saves:[]};
 account.api=async(path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/extract'){const call=++account.calls.extract,hooked=await hooks.extract?.(call,json);if(hooked)return hooked;return {assetId:ASSET,document:account.document,originalUrl:`/api/my/study/pdf-layout/assets/${ASSET}/original`};}
  if(path==='/api/my/study/history'&&method==='POST'||path===`/api/my/study/history/${SESSION}`&&method==='PUT'){
   if(json.revision!==undefined&&json.revision!==account.revision)return {fakeStatus:409,json:{error:'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác.',code:'history_conflict',revision:account.revision}};
   account.revision++;account.session=structuredClone(json.state);account.saves.push(structuredClone(json.state));const complete=json.state.done===json.state.parts.length;
   return {id:SESSION,status:complete?'complete':json.state.done?'translating':'draft',libraryStoryId:complete?'book-1':null,libraryChapterId:complete?'chapter-1':null,updatedAt:now(),revision:account.revision};
  }
  // The session as the history lists it and opens it again (a new tab or a reload).
  const row=()=>{const done=account.session.done,complete=done===account.session.parts.length;return {id:SESSION,title:'Bài giữ bố cục',filename:'bai-scan.pdf',domain:'general',mode:'economy',status:complete?'complete':done?'translating':'draft',translated_parts:done,total_parts:account.session.parts.length,library_story_id:complete?'book-1':null,library_chapter_id:complete?'chapter-1':null,created_at:'2026-10-22 01:00:00',updated_at:'2026-10-22 01:00:00',page_start:1,page_end:1,source_total_pages:1,source_sha256:null,revision:account.revision};};
  if(path==='/api/my/study/history'&&method==='GET')return account.session?[row()]:[];
  if(path===`/api/my/study/history/${SESSION}`&&method==='GET')return {...row(),state:account.session};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return account.document;
  if(path==='/api/my/study/pdf-layout/ocr-blocks'){
   const call=++account.calls.ocr;account.ocrBodies.push(json);const hooked=await hooks.ocr?.(json,call);if(hooked)return hooked;
   const blocks=account.document.pages[0].blocks,kept=hooks.ocrKept||{},warnings=[];
   for(const block of blocks)if(json.blockIds.includes(block.id)){
    if(kept[block.id]){block.ocrKept=kept[block.id];block.ocrCorrected=!hooks.keptUnmarked;warnings.push(`Trang 1 · đoạn ${blocks.indexOf(block)+1}: ${OCR_REFUSED}. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.`);}
    else{block.source=block.text=block.source.replace('（扫描）','');block.ocrCorrected=true;delete block.ocrKept;}
   }
   account.document.ocrCorrectedVersion=blocks.every(block=>block.ocrCorrected)?1:0;account.document.ocrWarnings=[...(account.document.ocrWarnings||[]),...warnings];const usage={prompt:1000,output:200,total:1200,requests:1};
   return json.slim===true?{blocks:blocks.filter(block=>json.blockIds.includes(block.id)).map(({id,source,text,ocrCorrected,ocrKept})=>({id,source,text,ocrCorrected,...(ocrKept?{ocrKept}:{})})),ocrCorrectedVersion:account.document.ocrCorrectedVersion,ocrWarnings:account.document.ocrWarnings,usage,warnings,model:json.model}:{document:account.document,usage,warnings,model:json.model};
  }
  if(path==='/api/my/study/translate-blocks'){
   const call=++account.calls.translate;account.translateBodies.push(json);const hooked=await hooks.translate?.(json,call);if(hooked)return hooked;
   return {blocks:json.blocks.map(block=>({id:block.id,translation:translated(block.id)})),...(json.partial?{failedBlocks:[]}:{}),context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'};
  }
  if(path==='/api/my/study/pdf-layout/render'){const call=++account.calls.render;account.renderBodies.push(json);const hooked=await hooks.render?.(json,call);if(hooked)return hooked;return {url:`/api/my/study/pdf-layout/assets/${ASSET}/translated`,renderVersion:3};}
  if(path==='/api/my/study/pdf-layout/refresh'){account.calls.refresh++;return {fakeStatus:500,json:{error:'fake: a refresh extracts and reads the scan again, paid again'}};}
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/translated`)return {fakeBody:await pdfBytes(account.document.pages.length),contentType:'application/pdf'};
 };
 return account;
}
const defaults=(path,method)=>path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/config'?{economy:'gemini-test',balanced:'gemini-test',quality:'gemini-test',pdf:'gemini-test'}:path==='/api/my/study/library-match'?{match:null}:path==='/api/my/study/models'?{models:[{id:'gemini-test'}],requested:'gemini-test',selected:'gemini-test'}:path==='/api/my/study/pdf-layout/font'?{css:''}:undefined;
async function openStudy(api){
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 // Every line the progress box shows, to check a countdown afterwards.
 await context.addInitScript(()=>{window.__statuses=[];addEventListener('DOMContentLoaded',()=>{const line=document.querySelector('#progress');new MutationObserver(()=>window.__statuses.push(line.textContent)).observe(line,{childList:true,characterData:true,subtree:true});});});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();
  if(path.startsWith('/api/')){
   // A form (an upload) is handed over parsed, a JSON body as its value.
   let json=null;const type=request.headers()['content-type']||'';
   if(type.startsWith('multipart/form-data'))json=await new Request('http://fake/',{method:'POST',headers:{'content-type':type},body:request.postDataBuffer()}).formData();else try{json=JSON.parse(request.postData()||'null');}catch{}
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
 await page.goto(`${ORIGIN}/study`);await page.waitForFunction(()=>document.body.dataset.session==='in');
 await page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent)&&document.querySelector('#pdf-layout-enabled').checked);
 return {context,page,errors};
}
// Picks a one-page PDF with "Giữ bố cục" on and waits until its page is counted.
async function pickPdf(page){
 await page.setInputFiles('#source-file',{name:'bai-scan.pdf',mimeType:'application/pdf',buffer:await pdfBytes()});
 await page.waitForFunction(()=>/^1 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
 await page.fill('#content-title','Bài giữ bố cục');await page.fill('#api-key',KEY);
}
const progress=page=>page.textContent('#progress');
const waitProgress=(page,pattern,timeout=60000)=>page.waitForFunction(source=>new RegExp(source,'u').test(document.querySelector('#progress').textContent),pattern.source,{timeout});
const waitProgressText=(page,text,timeout=60000)=>page.waitForFunction(expected=>document.querySelector('#progress').textContent===expected,text,{timeout});
const idle=page=>page.waitForFunction(()=>!document.querySelector('#translate').disabled,null,{timeout:60000});
// Waits until check() holds (on this side: a fake's counters); false when it never did within ms.
const until=async(check,ms=30000)=>{for(const end=Date.now()+ms;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,50)))if(await check())return true;return false;};

// Three pages at a time: all eight at once (pdf.js and its workers in each) made Edge close mid-run on a machine
// short of memory, failing whichever tests were still running.
describe('Giữ bố cục PDF, a range picked by hand, in Edge',{concurrency:3},()=>{
test('Dừng while a scan is read stops before the next paid OCR batch; Bắt đầu dịch reads on from there with slim answers',{skip,timeout:120000},async()=>{
 let release=null;const gate=new Promise(resolve=>{release=resolve;});
 const account=fakeAccount(manifest(13,{scanned:true}),{ocr:async(json,call)=>{if(call===1)await gate;return null;}});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');
  while(account.calls.ocr<1)await new Promise(resolve=>setTimeout(resolve,50));
  await page.click('#stop');release();
  await idle(page);
  assert.equal(account.calls.ocr,1,'no OCR batch is paid after Dừng');assert.equal(account.calls.translate,0);
  assert.match(await progress(page),/^Đã dừng khi đang đọc lại chữ trong ảnh \(đã đọc 6\/13 đoạn\)\. Phần đã đọc được giữ lại; bấm Bắt đầu dịch để đọc tiếp và dịch\.$/u);
  // The OCR answers carry only the blocks read, never the whole manifest.
  assert.ok(account.ocrBodies.every(body=>body.slim===true));
  await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  assert.equal(account.calls.ocr,3,'the batch read before Dừng is not read again');assert.equal(account.calls.extract,1);
  assert.deepEqual(account.ocrBodies.map(body=>body.blockIds.length),[6,6,1]);
  // The readings reached the translation: the sources sent are the OCR texts of the slim answers.
  const sent=account.translateBodies.flatMap(body=>body.blocks);assert.equal(sent.length,13);assert.ok(sent.every(block=>!block.source.includes('（扫描）')),JSON.stringify(sent[0]));
  assert.equal(account.calls.render,1);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Blocks Gemini will not translate keep a stand-in (its draft, or the Chinese) with a note; the others are kept and exported; Bắt đầu dịch asks again only for the Chinese one',{skip,timeout:120000},async()=>{
 const source=index=>manifest(4).pages[0].blocks[index].source;
 const account=fakeAccount(manifest(4),{translate:json=>{
  if(!json.partial)return {fakeStatus:400,json:{error:'Block p1-b2 thiếu số hoặc dẫn chứng: 2019.',usage:{prompt:600,output:200,total:800,requests:1}}};
  if(json.blocks.length===1)return null;
  return {blocks:[{id:'p1-b1',translation:translated('p1-b1')},{id:'p1-b4',translation:translated('p1-b4')}],failedBlocks:[{id:'p1-b2',code:'block_check',message:'Block p1-b2 thiếu số hoặc dẫn chứng: 2019.',draft:'Bản nháp đoạn hai, thiếu năm.'},{id:'p1-b3',code:'gemini_refused',message:'Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.'}],context:'',glossary:{},usage:{prompt:1800,output:600,total:2400,requests:3},warnings:[],model:'gemini-test'};
 }});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await idle(page);
  assert.deepEqual(account.session.translationParts,[translated('p1-b1'),'Bản nháp đoạn hai, thiếu năm.',source(2),translated('p1-b4')],'what passed is kept; the failed blocks have their stand-ins');
  assert.equal(account.calls.render,1,'the part is complete and exported');
  const warnings=await page.textContent('#warnings');
  assert.match(warnings,/Trang 1 · đoạn 2: thiếu số hoặc dẫn chứng: 2019\. Đã dùng bản dịch này của Gemini; hãy đối chiếu với nguyên tác và sửa trong “Chỉnh bản dịch từng đoạn”\./u);
  assert.match(warnings,/Trang 1 · đoạn 3: giữ nguyên chữ gốc\. Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền\. Bấm Bắt đầu dịch để thử dịch lại/u);
  assert.match(await progress(page),/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được, 1 đoạn dùng bản dịch còn thiếu số hoặc dẫn chứng/u);
  assert.equal(await page.inputValue('#api-key'),'');assert.equal(await page.textContent('#key-status'),'Đã nạp khóa Gemini cho phiên này.');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // Another tab opens the part from the history: the block still in Chinese and the draft kept with its problem (saved
 // with the session: pdfLayout.review) are named again; Bắt đầu dịch sends only the Chinese one, and the part is exported
 // anew.
 const again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.equal(await again.page.textContent('#warnings'),'Trang 1 · đoạn 2: bản dịch có thể thiếu số hoặc dẫn chứng của nguyên tác; hãy đối chiếu và sửa trong “Chỉnh bản dịch từng đoạn”.\nTrang 1 · đoạn 3: vẫn là chữ gốc vì Gemini chưa dịch được đoạn này. Bấm Bắt đầu dịch để thử dịch lại, hoặc dịch tay trong “Chỉnh bản dịch từng đoạn”.\n');
  await again.page.fill('#api-key',KEY);await again.page.click('#translate');await waitProgress(again.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  assert.deepEqual(account.translateBodies.at(-1).blocks.map(block=>block.id),['p1-b3']);assert.equal(account.session.translationParts[2],translated('p1-b3'));
  assert.equal(account.calls.render,2);assert.doesNotMatch(await again.page.textContent('#warnings'),/đoạn 3:/u);
  assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('A quota part-way keeps the blocks that passed and stops with its own message; the key stays; Bắt đầu dịch asks only for the rest',{skip,timeout:120000},async()=>{
 const QUOTA='Gemini đang giới hạn số yêu cầu mỗi phút của khóa này. Hãy đợi khoảng 30 giây rồi thử lại.';
 const account=fakeAccount(manifest(3),{translate:(json,call)=>{
  if(call>1)return null;
  if(!json.partial)return {fakeStatus:429,json:{error:QUOTA,code:'quota_minute',retryAfter:30},headers:{'Retry-After':'30'}};
  return {blocks:[{id:'p1-b1',translation:translated('p1-b1')}],failedBlocks:[{id:'p1-b2',code:'quota_minute',message:QUOTA,retryAfter:30},{id:'p1-b3',code:'quota_minute',message:QUOTA,retryAfter:30}],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:2},warnings:[],model:'gemini-test'};
 }});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await idle(page);
  assert.deepEqual(account.session.translationParts.slice(0,1),[translated('p1-b1')],'the block that passed is saved');assert.equal(account.session.done,1);
  assert.equal(await progress(page),QUOTA);assert.equal(await page.textContent('#key-status'),'Đã nạp khóa Gemini cho phiên này.');
  await page.click('#translate');await idle(page);
  assert.deepEqual(account.translateBodies.at(-1).blocks.map(block=>block.id),['p1-b2','p1-b3']);
  assert.deepEqual(account.session.translationParts,['p1-b1','p1-b2','p1-b3'].map(translated));assert.equal(account.calls.render,1);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Photos of pages picked together become one PDF made on the device, a page each, read like a scan; a photo and a document together are refused',{skip,timeout:120000},async()=>{
 let sent=null;
 const account=fakeAccount(manifest(2,{scanned:true}),{extract:async(call,form)=>{const file=form.get('file'),pdf=await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));sent={name:file.name,pages:pdf.getPages().map(page=>[Math.round(page.getWidth()),Math.round(page.getHeight())]),range:form.get('pages')};return null;}});
 const {context,page,errors}=await openStudy(account.api);
 try{
  // A portrait and a landscape photo, drawn here as a phone camera would save them.
  const photos=await page.evaluate(()=>[[1240,1754],[1754,1240]].map(([width,height],index)=>{const canvas=document.createElement('canvas'),g=canvas.getContext('2d');canvas.width=width;canvas.height=height;g.fillStyle='#fff';g.fillRect(0,0,width,height);g.fillStyle='#111';g.font='48px sans-serif';g.fillText(`Trang ${index+1}`,100,200);return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);}));
  const files=photos.map((data,index)=>({name:`trang-${index+1}.png`,mimeType:'image/png',buffer:Buffer.from(data,'base64')}));
  await page.setInputFiles('#source-file',[...files,{name:'bai.txt',mimeType:'text/plain',buffer:Buffer.from('子曰','utf8')}]);
  await page.waitForSelector('#progress.error');assert.match(await progress(page),/^Chỉ chọn nhiều tệp cùng lúc khi tất cả là ảnh chụp trang/u);
  await page.setInputFiles('#source-file',files);await page.waitForFunction(()=>/^2 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  await page.fill('#content-title','Ảnh chụp sách');await page.fill('#api-key',KEY);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  assert.deepEqual(sent,{name:'trang-1.pdf',pages:[[595,842],[842,595]],range:'1-2'},'one PDF, a page per photo, each as wide as A4 in its own direction');
  assert.equal(account.calls.ocr,1,'the photos are read as a scan');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A busy PDF service is waited out with a countdown before the student is told; too heavy says to pick fewer pages; Dừng stops the wait',{skip,timeout:120000},async()=>{
 const BUSY='Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.';
 const busy={fakeStatus:503,json:{error:BUSY,code:'pdf_service_busy',retryAfter:1},headers:{'Retry-After':'1'}};
 const account=fakeAccount(manifest(2),{extract:call=>call===1||call===3?busy:call===2?{fakeStatus:413,json:{error:'Không đủ bộ nhớ để xử lý PDF này.',code:'pdf_memory'}}:null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await idle(page);
  assert.equal(account.calls.extract,2,'the busy answer is tried again by itself');
  const statuses=await page.evaluate(()=>window.__statuses);assert.ok(statuses.some(line=>/^Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc\. Tự thử lại sau \d+ giây… Bấm Dừng để thôi chờ\.$/u.test(line)),statuses.join(' | '));
  assert.equal(await progress(page),'Không đủ bộ nhớ để xử lý PDF này. Hãy chọn ít trang hơn cho lượt này (ví dụ 3–5 trang) rồi bấm Bắt đầu dịch.');
  // Busy again: Dừng during the countdown ends the wait, as a stop rather than an error.
  await page.click('#translate');await waitProgress(page,/Tự thử lại sau \d+ giây/u);await page.click('#stop');await idle(page);
  assert.equal(await progress(page),'Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Đã thôi chờ; bấm Bắt đầu dịch khi muốn thử lại.');
  assert.equal(await page.getAttribute('#progress','class'),'');assert.equal(account.calls.extract,3);assert.equal(account.calls.translate,0);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The PDF service of the machine running Hoa Trí that does not answer is waited for briefly, then named with start.cmd; started meanwhile, the run goes on',{skip,timeout:120000},async()=>{
 // backend/pdf-layout.js's answer for a loopback service that does not answer (Retry-After 1: the page's shortest wait, 5 s).
 const OFF='Dịch vụ PDF trên máy này chưa chạy: hãy tắt Hoa Trí rồi khởi động lại bằng start.cmd (hoặc npm start). Nếu đã khởi động như vậy, xem các dòng [PDF] trong cửa sổ đó.';
 const account=fakeAccount(manifest(2),{extract:call=>call<=5?{fakeStatus:503,json:{error:OFF,code:'pdf_local_off',retryAfter:1},headers:{'Retry-After':'1'}}:null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  // Never started (npm run dev): three waits, then the server's words; nothing blames the network.
  await pickPdf(page);await page.click('#translate');await idle(page);
  assert.equal(account.calls.extract,4);assert.equal(await progress(page),OFF);assert.equal(account.calls.translate,0);
  const statuses=await page.evaluate(()=>window.__statuses);
  assert.ok(statuses.some(line=>/^Dịch vụ PDF trên máy này chưa trả lời \(có thể còn đang khởi động\)\. Tự thử lại sau \d+ giây… Bấm Dừng để thôi chờ\.$/u.test(line)),statuses.join(' | '));
  assert.ok(statuses.every(line=>!/[Kk]iểm tra mạng|Mất kết nối/u.test(line)),statuses.join(' | '));
  // Still starting: it answers after one wait and the part is translated.
  await page.click('#translate');assert.ok(await until(()=>account.calls.translate>0,60000),'translated once the service answers');await idle(page);
  assert.equal(account.calls.extract,6);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// What the Worker answers when the PDF service finds translations longer than their boxes: the service's message
// (services/pdf-layout/engine.mjs overflowMessage: each block named in a sentence as Xưởng dịch names it, "Trang N ·
// đoạn k", and "Đoạn k" only as the editor's option to pick), mapped and checked by backend/pdf-layout.js
// serviceFailure, sent by the render route as 422 {error, code, blocks}.
function overflowAnswer(document,ids){
 const entries=ids.map(id=>{const page=document.pages.find(entry=>entry.blocks.some(b=>b.id===id));return {page:page.number,id,label:blockLabel(page,id)};});
 const failure=serviceFailure(422,{error:overflowMessage(entries),code:'overflow',blocks:entries.map(({page,id})=>({page,id}))});
 return {fakeStatus:failure.status,json:{error:failure.message,code:failure.code,blocks:failure.blocks}};
}
const viewerState=page=>page.evaluate(()=>{const root=document.querySelector('#pdf-dual-viewer'),select=root.querySelector('[data-pdf-edit-select]');return {page:root.querySelector('[data-pdf-page]').textContent,open:root.querySelector('.pdf-block-editor').open,block:select.value,text:root.querySelector('[data-pdf-edit-text]').value,options:[...select.options].map(option=>option.textContent),outlined:[...root.querySelectorAll('.is-overflow')].map(node=>node.dataset.blockId),notice:root.querySelector('[data-pdf-notice]').textContent,focused:document.activeElement===select};});

test('An export refused for translations longer than their boxes says so in the service\'s words and opens the first such block in the editor, on its page, each marked; shortened and saved, the part exports',{skip,timeout:120000},async()=>{
 const document=twoPages(2),refusals=[['p2-b1','p2-b2'],['p2-b2']];
 const account=fakeAccount(document,{render:(json,call)=>refusals[call-1]?overflowAnswer(document,refusals[call-1]):null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await page.setInputFiles('#source-file',{name:'bai-hai-trang.pdf',mimeType:'application/pdf',buffer:await pdfBytes(2)});
  await page.waitForFunction(()=>/^2 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  await page.fill('#content-title','Bài giữ bố cục');await page.fill('#api-key',KEY);await page.click('#translate');await idle(page);
  // The student reads the service's words; the editor is already where they lead: Trang 2, Đoạn 1, every such block marked.
  const message=overflowAnswer(document,refusals[0]).json.error;
  assert.equal(await progress(page),message);assert.equal(await page.getAttribute('#progress','class'),'error');
  await page.waitForFunction(()=>document.querySelectorAll('#pdf-dual-viewer .is-overflow').length===2);
  let state=await viewerState(page);
  assert.deepEqual({page:state.page,open:state.open,block:state.block,text:state.text,outlined:state.outlined,focused:state.focused},{page:'Trang 2 · 2/2',open:true,block:'p2-b1',text:translated('p2-b1'),outlined:['p2-b1','p2-b2'],focused:true});
  assert.deepEqual(state.options.map(text=>text.replace(/ · .*?(?= · |$)/u,'')),['Đoạn 1 · Dài hơn khung chữ','Đoạn 2 · Dài hơn khung chữ'],'the editor lists the blocks as "Đoạn k", the option a message tells to pick');
  // In a sentence a block is "Trang N · đoạn k", as in the warnings; "Đoạn k" is the editor's own list. The service's
  // message, right above the viewer's notice, names the same blocks the same way.
  assert.match(state.notice,/^Khi xuất PDF, bản dịch của Trang 2 · đoạn 1 và Trang 2 · đoạn 2 dài hơn khung chữ \(viền đỏ\)\./u);
  const named=text=>[...text.matchAll(/Trang \d+ · đoạn \d+/gu)].map(match=>match[0]);
  assert.deepEqual(named(message),named(state.notice),message);assert.doesNotMatch(message.replaceAll(/chọn Đoạn \d+/gu,''),/Đoạn \d/u,message);
  // Shortened and saved: its mark goes; the other block keeps its own.
  await page.fill('[data-pdf-edit-text]','Ngắn.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đã lưu đoạn sửa\./u);
  assert.equal(account.session.translationParts[2],'Ngắn.');
  await page.waitForFunction(()=>document.querySelectorAll('#pdf-dual-viewer .is-overflow').length===1);state=await viewerState(page);
  assert.deepEqual(state.outlined,['p2-b2']);assert.doesNotMatch(state.options[0],/Dài hơn khung chữ/u);assert.match(state.options[1],/Dài hơn khung chữ$/u);
  // Exported again: the one still too long is opened in turn; once it is shortened too, the PDF is exported and downloaded.
  await page.click('#download-pdf');await waitProgressText(page,overflowAnswer(document,refusals[1]).json.error);await idle(page);
  await page.waitForFunction(()=>document.querySelector('#pdf-dual-viewer [data-pdf-edit-select]').value==='p2-b2');
  assert.equal((await viewerState(page)).text,translated('p2-b2'));
  await page.fill('[data-pdf-edit-text]','Cũng ngắn.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đã lưu đoạn sửa\./u);
  const download=page.waitForEvent('download');await page.click('#download-pdf');
  // The file is read to its end before the context closes: Edge 155 crashes (0xC0000005), taking every other page of the
  // shared browser with it, when a context is closed while its download is still being written.
  const file=await download;assert.equal(file.suggestedFilename(),'Bài giữ bố cục.vi.pdf');assert.ok(await file.path());
  await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  assert.equal(account.calls.render,3);assert.ok(account.renderBodies.every(body=>body.assetId===ASSET&&body.historyId===SESSION));
  assert.deepEqual(account.session.translationParts,[translated('p1-b1'),translated('p1-b2'),'Ngắn.','Cũng ngắn.']);assert.equal(account.calls.translate,1,'no Gemini call to fix the layout');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A scanned block Gemini could not read keeps its machine text after one more reading (Tiết kiệm too): named in the warnings and the Hanzi panel, never read again, and named again with the session',{skip,timeout:120000},async()=>{
 const NOTE=`Trang 1 · đoạn 2: ${OCR_REFUSED}. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.`,REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.';
 // Gemini then also refuses to translate that block once: it keeps its Chinese until Bắt đầu dịch asks again.
 const account=fakeAccount(manifest(3,{scanned:true}),{ocrKept:{'p1-b2':'refused'},translate:(json,call)=>call===1?{blocks:json.blocks.filter(b=>b.id!=='p1-b2').map(b=>({id:b.id,translation:translated(b.id)})),failedBlocks:[{id:'p1-b2',code:'gemini_refused',message:REFUSED}],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'}:null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  let warnings=await page.textContent('#warnings');assert.ok(warnings.includes(NOTE),warnings);assert.match(warnings,/Trang 1 · đoạn 2: giữ nguyên chữ gốc\./u);
  assert.equal(account.session.parts[1],'（扫描）第2段','the machine text is what is translated');
  // The economy mode read that block once more, alone, before translating; it was refused again.
  assert.equal(account.calls.ocr,2);assert.deepEqual([account.ocrBodies[1].reread,account.ocrBodies[1].rereadIds,account.ocrBodies[1].mode],[true,['p1-b2'],'economy']);
  // Bắt đầu dịch asks Gemini again only for the block still in Chinese: its OCR note stays, its image is not read again.
  await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.equal(account.calls.ocr,2);assert.deepEqual(account.translateBodies.at(-1).blocks.map(b=>b.id),['p1-b2']);
  warnings=await page.textContent('#warnings');assert.ok(warnings.includes(NOTE),`the OCR note stays when the translation is asked for again: ${warnings}`);assert.doesNotMatch(warnings,/giữ nguyên chữ gốc/u);
  // The Hanzi panel of the original says the text is the machine's.
  await page.click('[data-source-block="p1-b2"]');await page.waitForSelector('#hanzi-panel:not([hidden])');
  assert.match(await page.textContent('#hanzi-panel .hz-note'),/^Gemini chưa đọc lại được đoạn này nên đoạn này giữ chữ nhận dạng máy \(OCR\); chữ có thể sai/u);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // Another tab opens the session again: the note comes back with it; nothing is read or paid for again.
 const again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.ok((await again.page.textContent('#warnings')).includes(NOTE));assert.equal(account.calls.ocr,2);assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('A scanned block kept with its machine text is read once more, then never paid for again, even when the server leaves it unmarked as read',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(2,{scanned:true}),{ocrKept:{'p1-b1':'unread'},keptUnmarked:true});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.equal(account.calls.ocr,2,'read, and read once more');assert.equal(account.document.ocrCorrectedVersion,0);
  await page.click('#translate');await idle(page);
  assert.equal(account.calls.refresh,0,'the scan is not extracted and read again');assert.equal(account.calls.ocr,2,'nor read again');assert.equal(account.calls.extract,1);
  // Nothing is left to send, and what the student still has to look at is said (D5).
  assert.match(await progress(page),/^Đã dịch đủ các đoạn; cần xem lại: 1 đoạn chữ trong ảnh có thể đọc sai \(chi tiết trong phần cảnh báo\)\./u);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Photos picked again become the same PDF, so the unfinished whole-book run made from them goes on instead of starting over',{skip,timeout:120000},async()=>{
 const shas=[];let jobs=[];const account=fakeAccount(manifest(1));
 const {context,page,errors}=await openStudy((path,method,json,url)=>{
  if(path==='/api/my/study/library-match'){shas.push(url.searchParams.get('sha256'));return {match:null};}
  if(path==='/api/my/study/book-jobs'&&method==='GET')return {jobs};
  return account.api(path,method,json);
 });
 try{
  const photos=await page.evaluate(()=>[[620,877],[877,620]].map(([width,height],index)=>{const canvas=document.createElement('canvas'),g=canvas.getContext('2d');canvas.width=width;canvas.height=height;g.fillStyle='#fff';g.fillRect(0,0,width,height);g.fillStyle='#111';g.font='40px sans-serif';g.fillText(`Trang ${index+1}`,60,120);return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);}));
  const files=photos.map((data,index)=>({name:`trang-${index+1}.png`,mimeType:'image/png',buffer:Buffer.from(data,'base64')}));
  const pick=async count=>{await page.evaluate(()=>{document.querySelector('#source-file').value='';});await page.setInputFiles('#source-file',files);await page.waitForFunction(()=>/^2 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});assert.ok(await until(()=>shas.length>=count),'the PDF made of the photos is hashed');};
  await pick(1);
  // The run a closed tab left behind: page 1 translated, page 2 not yet.
  jobs=[{id:'6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',sourceSha256:shas[0],filename:'trang-1.pdf',title:'Ảnh chụp sách',storyId:null,totalPages:2,pageStates:'d.',chunkSize:20,domain:'general',mode:'economy',model:null,status:'paused',pauseReason:'network',usage:{prompt:600,output:267,thinking:0,total:867,requests:1},glossary:{},createdAt:now(),updatedAt:now(),runner:null,leaseSeconds:0}];
  // More than a second later (a PDF date counts whole seconds), the same photos again.
  await page.waitForTimeout(1100);await pick(2);
  assert.equal(shas[1],shas[0],'the same photos give the same bytes, hence the same SHA-256');
  await page.waitForFunction(()=>document.querySelector('#translate').textContent.trim()==='Tiếp tục dịch cả quyển →',null,{timeout:30000});
  assert.match(await page.textContent('#whole-book-status'),/^Quyển này đã có tiến độ: Đã dịch 1\/2 trang\. Bấm Tiếp tục dịch cả quyển/u);
  assert.equal(account.calls.extract,0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('While the PDF service is busy the file is not uploaded again to find out: after each wait Xưởng dịch asks for a free place, Dừng still ends the wait, and the file goes up once a place is free',{skip,timeout:120000},async()=>{
 const BUSY='Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.',uploads=[];let place='full',asked=0;
 const account=fakeAccount(manifest(2),{extract:(call,form)=>{uploads.push(form.get('file').size);return call<=2?{fakeStatus:503,json:{error:BUSY,code:'pdf_service_busy',retryAfter:1},headers:{'Retry-After':'1'}}:null;}});
 const {context,page,errors}=await openStudy((path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/capacity'&&method==='GET'){asked++;return place==='full'?{busy:true,free:0,slots:2,retryAfter:1}:{busy:false,free:1,slots:2,retryAfter:null};}
  return account.api(path,method,json);
 });
 try{
  await pickPdf(page);await page.click('#translate');
  // Two waits while every place is taken: the file went up once, and the countdown and Dừng stay.
  assert.ok(await until(()=>asked>=2,40000),'the service is asked for a free place after each wait');assert.equal(uploads.length,1);
  assert.match(await progress(page),/^Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc\. Tự thử lại sau \d+ giây… Bấm Dừng để thôi chờ\.$/u);
  await page.click('#stop');await idle(page);
  assert.equal(await progress(page),'Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Đã thôi chờ; bấm Bắt đầu dịch khi muốn thử lại.');assert.equal(uploads.length,1);
  // Busy once more, then a place is free: the file goes up again only then.
  place='open';await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  assert.equal(uploads.length,3,'one refused upload per run, and the one sent once a place was free');assert.ok(uploads.every(size=>size===uploads[0]));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Blocks asked for again after a refusal are named, not counted as a range over blocks not sent; their notes go once they are translated, also after the extraction\'s own notes',{skip,timeout:120000},async()=>{
 const document=manifest(30),REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.',OCR='Trang 1: dùng OCR; hãy đối chiếu công thức với PDF gốc.';
 document.pages[0].blocks.forEach((b,i)=>{b.box=[40,20+i*17,360,34+i*17];});document.warnings=[OCR];
 const account=fakeAccount(document,{translate:(json,call)=>call===1?{blocks:json.blocks.filter(b=>!['p1-b3','p1-b25'].includes(b.id)).map(b=>({id:b.id,translation:translated(b.id)})),failedBlocks:['p1-b3','p1-b25'].map(id=>({id,code:'gemini_refused',message:REFUSED})),context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'}:null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 2 đoạn giữ nguyên chữ gốc/u);await idle(page);
  const before=await page.textContent('#warnings');assert.ok(before.startsWith(`${OCR}\nTrang 1 · đoạn 3: giữ nguyên chữ gốc.`),before);
  await page.evaluate(()=>{window.__statuses=[];});await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.deepEqual(account.translateBodies.at(-1).blocks.map(b=>b.id),['p1-b3','p1-b25']);
  const statuses=await page.evaluate(()=>window.__statuses);
  assert.ok(statuses.includes('Đang dịch lại 2 đoạn còn chữ gốc (Trang 1 · đoạn 3, Trang 1 · đoạn 25)…'),statuses.join(' | '));assert.ok(!statuses.some(line=>/Đang dịch đoạn 3–25/u.test(line)),statuses.join(' | '));
  assert.equal(await page.textContent('#warnings'),`${OCR}\n`);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The block editor names a formula box it lost or holds twice, and a block emptied or too long, in its own words ("Đoạn k", "[Công thức n]"), and saves nothing',{skip,timeout:120000},async()=>{
 const document=manifest(2),block=document.pages[0].blocks[0];
 // The formula's machine text holds $-patterns (OCR reads S as $): the translation text keeps them as written.
 Object.assign(block,{text:"设 $'x$$ 为实数。",source:'设@@PDF_INLINE_1@@为实数。',inlines:[{token:'@@PDF_INLINE_1@@',image:PNG,width:10,height:12,text:"$'x$$"}]});
 const account=fakeAccount(document,{translate:json=>({blocks:json.blocks.map(b=>({id:b.id,translation:b.id==='p1-b1'?'Đặt @@PDF_INLINE_1@@ là số thực.':translated(b.id)})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'})});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.equal((await page.inputValue('#translation')).split('\n\n')[0],"Đặt $'x$$ là số thực.");
  await page.click('#pdf-dual-viewer .pdf-block-editor > summary');await page.selectOption('[data-pdf-edit-select]','p1-b1');
  assert.equal(await page.inputValue('[data-pdf-edit-text]'),'Đặt [Công thức 1] là số thực.');
  const saves=account.saves.length;
  await page.fill('[data-pdf-edit-text]','Đặt là số thực.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đoạn 1:/u);
  assert.equal(await progress(page),'Đoạn 1: bản sửa làm mất [Công thức 1]; hãy giữ nguyên ô này.');assert.equal(await page.getAttribute('#progress','class'),'error');
  await page.fill('[data-pdf-edit-text]','Đặt [Công thức 1] và [Công thức 1].');await page.click('[data-pdf-edit-save]');await waitProgress(page,/hơn một lần/u);
  assert.equal(await progress(page),'Đoạn 1: bản sửa có [Công thức 1] hơn một lần; hãy giữ đúng một ô này.');
  // Emptied, or longer than one block may be (pdf-box-layout.js validateBlockTranslations): never its "ID block" words.
  await page.selectOption('[data-pdf-edit-select]','p1-b2');
  await page.fill('[data-pdf-edit-text]','   ');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đoạn 2:/u,15000);
  assert.equal(await progress(page),'Đoạn 2: bản sửa đang trống; hãy viết bản dịch rồi bấm “Lưu đoạn đã sửa”.');assert.equal(await page.getAttribute('#progress','class'),'error');
  await page.fill('[data-pdf-edit-text]','Rất dài. '.repeat(2223));await page.click('[data-pdf-edit-save]');await waitProgress(page,/20\.000 ký tự/u,15000);
  assert.equal(await progress(page),'Đoạn 2: bản sửa dài hơn 20.000 ký tự, mức tối đa của một đoạn; hãy viết ngắn lại rồi bấm “Lưu đoạn đã sửa”.');
  assert.equal(account.saves.length,saves,'nothing is saved');assert.equal(account.session.translationParts[0],'Đặt @@PDF_INLINE_1@@ là số thực.');assert.equal(account.session.translationParts[1],translated('p1-b2'));assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A finished part whose export was refused says so in the history, and opened again elsewhere it finds and opens the block too long for its box; once exported the history stops saying so',{skip,timeout:150000},async()=>{
 const document=manifest(2),LONG='Bản dịch rất dài của đoạn một, không thể nào vừa khung chữ. '.repeat(60);
 const account=fakeAccount(document,{translate:json=>({blocks:json.blocks.map(b=>({id:b.id,translation:b.id==='p1-b1'?LONG:translated(b.id)})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'}),render:(json,call)=>call===1?overflowAnswer(document,['p1-b1']):null});
 // The books as GET /api/my/study/books lists them: the part's chapter stays text until an export succeeds.
 const books=()=>account.session?.done===2?[{id:'book-1',title:'Bài giữ bố cục',cover:{image:false,page:null,sha256:null},parts:[{id:'chapter-1',title:'Bài giữ bố cục',position:1,mime:account.calls.render>=2?'application/pdf':'text/plain',sessionId:SESSION,filename:'bai-scan.pdf',pageStart:1,pageEnd:1,totalPages:1,sha256:null,pages:[1],updatedAt:now(),translatedAt:now()}]}]:[];
 const api=(path,method,json)=>path==='/api/my/study/books'&&method==='GET'?books():account.api(path,method,json);
 const first=await openStudy(api);
 try{
  await pickPdf(first.page);await first.page.click('#translate');await idle(first.page);
  assert.equal(await progress(first.page),overflowAnswer(document,['p1-b1']).json.error);assert.deepEqual(first.errors,[]);
 }finally{await first.context.close();}
 const again=await openStudy(api),{page}=again;
 try{
  await page.click('#study-history > summary');
  await page.waitForFunction(()=>/chưa có PDF tiếng Việt/u.test(document.querySelector('#study-history-list').textContent));
  assert.match(await page.textContent(`[data-history-open="${SESSION}"]`),/Hoàn tất · trang 1 · chưa có PDF tiếng Việt/u);
  await page.click(`[data-history-open="${SESSION}"]`);
  await waitProgress(page,/^Phần này chưa có PDF tiếng Việt vì bản dịch của Trang 1 · đoạn 1 dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức\./u);await idle(page);
  const state=await viewerState(page);assert.deepEqual({open:state.open,block:state.block,outlined:state.outlined},{open:true,block:'p1-b1',outlined:['p1-b1']});
  assert.equal(account.calls.render,1,'opening the part asks nothing of the PDF service');
  // Shortened, saved and exported: the history stops saying the part lacks its PDF.
  await page.fill('[data-pdf-edit-text]','Ngắn.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đã lưu đoạn sửa\./u);
  const download=page.waitForEvent('download');await page.click('#download-pdf');const file=await download;assert.ok(await file.path());
  await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);
  await page.waitForFunction(()=>!/chưa có PDF tiếng Việt/u.test(document.querySelector('#study-history-list').textContent));
  assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('Bắt đầu dịch translating again a block left in Chinese takes the part\'s PDF away: the history says the part lacks it in this tab at once, when the new export is refused and when Dừng ends its wait',{skip,timeout:150000},async()=>{
 const document=manifest(3),REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.',BUSY='Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.';
 // Gemini first leaves p1-b2 and p1-b3 in Chinese, then translates p1-b2 (p1-b3 left again), then p1-b3.
 const refused=(call,id)=>call===1&&id!=='p1-b1'||call===2&&id==='p1-b3';
 const account=fakeAccount(document,{
  translate:(json,call)=>({blocks:json.blocks.filter(b=>!refused(call,b.id)).map(b=>({id:b.id,translation:translated(b.id)})),failedBlocks:json.blocks.filter(b=>refused(call,b.id)).map(b=>({id:b.id,code:'gemini_refused',message:REFUSED})),context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'}),
  // The first and third exports go through; the second is refused, the fourth finds the service busy.
  render:(json,call)=>call===2?overflowAnswer(document,['p1-b2']):call===4?{fakeStatus:503,json:{error:BUSY,code:'pdf_service_busy',retryAfter:20},headers:{'Retry-After':'20'}}:null
 });
 // The part's chapter as GET books lists it: a PDF once exported (backend/pdf-layout.js), text again once a save of the
 // finished session no longer marked exported lands (backend/study-history.js).
 let pdf=false;
 const api=async(path,method,json)=>{
  if(path==='/api/my/study/books'&&method==='GET')return account.session?.done===3?[{id:'book-1',title:'Bài giữ bố cục',cover:{image:false,page:null,sha256:null},parts:[{id:'chapter-1',title:'Bài giữ bố cục',position:1,mime:pdf?'application/pdf':'text/plain',sessionId:SESSION,filename:'bai-scan.pdf',pageStart:1,pageEnd:1,totalPages:1,sha256:null,pages:[1],updatedAt:now(),translatedAt:now()}]}]:[];
  const answer=await account.api(path,method,json),saved=path==='/api/my/study/history'&&method==='POST'||path===`/api/my/study/history/${SESSION}`&&method==='PUT';
  if(!answer?.fakeStatus&&saved&&!json.state.pdfLayout?.exported)pdf=false;if(!answer?.fakeStatus&&path==='/api/my/study/pdf-layout/render')pdf=true;
  return answer;
 };
 const {context,page,errors}=await openStudy(api);
 const waitCard=pattern=>page.waitForFunction(([id,source])=>new RegExp(source,'u').test(document.querySelector(`#study-history-list [data-history-open="${id}"] span`)?.textContent??''),[SESSION,pattern.source],{timeout:15000});
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  await waitCard(/^Hoàn tất · trang 1$/u);assert.equal(pdf,true);
  // Asked again for the blocks still in Chinese: p1-b2 is translated, so the save drops the PDF; the new export is refused.
  await page.click('#translate');await waitProgressText(page,overflowAnswer(document,['p1-b2']).json.error);await idle(page);
  assert.equal(pdf,false);await waitCard(/^Hoàn tất · trang 1 · chưa có PDF tiếng Việt$/u);
  // Exported as it is, the part has its PDF again.
  const download=page.waitForEvent('download');await page.click('#download-pdf');const file=await download;assert.ok(await file.path());
  await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);await waitCard(/^Hoàn tất · trang 1$/u);
  // Asked again for p1-b3: the save drops the PDF; the new export waits for a busy service, and Dừng ends that wait.
  await page.click('#translate');await waitProgress(page,/^Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc\. Tự thử lại sau \d+ giây… Bấm Dừng để thôi chờ\.$/u);
  await page.click('#stop');await idle(page);
  assert.equal(await progress(page),'Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Đã thôi chờ; bấm Bắt đầu dịch khi muốn thử lại.');
  assert.equal(pdf,false);await waitCard(/^Hoàn tất · trang 1 · chưa có PDF tiếng Việt$/u);
  assert.deepEqual(account.translateBodies.map(body=>body.blocks.map(b=>b.id)),[['p1-b1','p1-b2','p1-b3'],['p1-b2','p1-b3'],['p1-b3']]);assert.equal(account.calls.render,4);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A finished part that no longer belongs to a book (its book deleted, or its part taken over by a redone range) says so when opened: never said to lack its PDF nor offered the export the Worker refuses; a PDF it had is still shown',{skip,timeout:120000},async()=>{
 const document=manifest(2),blocks=document.pages[0].blocks,account=fakeAccount(document),TEXT='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
 // As the history keeps such sessions: finished, their library ids cleared (database/migrations/0013 ON DELETE SET NULL,
 // or backend/study-history.js when a redone range takes the part over). One kept layout, never exported; one text.
 account.session={source:blocks.map(b=>b.source).join('\n\n'),parts:blocks.map(b=>b.source),translationParts:blocks.map(b=>translated(b.id)),done:2,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:'',pdfLayout:{assetId:ASSET,exported:false}};account.revision=1;
 const text={id:TEXT,title:'Bài chữ',filename:'',domain:'general',mode:'economy',status:'complete',translated_parts:1,total_parts:1,library_story_id:null,library_chapter_id:null,created_at:'2026-10-22 01:00:00',updated_at:'2026-10-22 01:00:00',page_start:null,page_end:null,source_total_pages:null,source_sha256:null,revision:1};
 const detached=row=>({...row,library_story_id:null,library_chapter_id:null});
 const api=async(path,method,json)=>{
  if(path==='/api/my/study/history'&&method==='GET')return [...(await account.api(path,method,json)).map(detached),text];
  if(path===`/api/my/study/history/${SESSION}`&&method==='GET')return detached(await account.api(path,method,json));
  if(path===`/api/my/study/history/${TEXT}`&&method==='GET')return {...text,state:{source:'学而时习之。',parts:['学而时习之。'],translationParts:['Học mà thường ôn tập.'],done:1,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:''}};
  // backend/pdf-layout.js: only a part of a book is exported.
  if(path==='/api/my/study/pdf-layout/render'){account.calls.render++;return {fakeStatus:409,json:{error:'Hãy dịch và lưu đủ các block trước khi xuất PDF.'}};}
  return account.api(path,method,json);
 };
 const {context,page,errors}=await openStudy(api);
 const DETACHED='Bản dịch đã hoàn tất nhưng không còn nằm trong sách nào của Thư viện riêng (có thể sách đã bị xóa, hoặc phần này đã được thay bằng bản dịch mới hơn)';
 const card=()=>page.$eval(`#study-history-list [data-history-open="${SESSION}"] span`,node=>node.textContent);
 try{
  await page.click('#study-history > summary');await page.click(`[data-history-open="${SESSION}"]`);
  await waitProgressText(page,`${DETACHED}, nên không còn xuất được PDF tiếng Việt; bản dịch vẫn xem được ở đây.`,15000);await idle(page);
  assert.equal(await page.isDisabled('#download-pdf'),true,'no export is offered');assert.equal(await card(),'Hoàn tất · trang 1');assert.equal(account.calls.render,0);
  // Exported before it left its book: that PDF is still shown, and downloaded as it is, with no export.
  account.session.pdfLayout={assetId:ASSET,exported:true,renderVersion:3};
  await page.click(`[data-history-open="${SESSION}"]`);await waitProgressText(page,`${DETACHED}. PDF tiếng Việt đã xuất trước đó vẫn xem và tải được ở đây.`,15000);await idle(page);
  await page.waitForFunction(()=>document.querySelector('#pdf-dual-viewer [data-pdf-render-state]').textContent==='PDF đã xuất');
  const download=page.waitForEvent('download');await page.click('#download-pdf');const file=await download;assert.ok(await file.path());await idle(page);assert.equal(account.calls.render,0);
  // A text translation outside any book is not said to be in Thư viện riêng either.
  await page.click(`[data-history-open="${TEXT}"]`);await waitProgressText(page,`${DETACHED}; bản dịch vẫn xem được ở đây.`,15000);await idle(page);
  assert.equal(await card(),'Hoàn tất · trang 1');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
// What every Cách dịch does about a translation still in Chinese (a draft the server's retry could not mend), blocks a
// request did not reach and a block with nothing to use: what the server answers is played here; the checks behind it are
// backend/pdf-block-translation.js's own (pdf-block-translation.test.mjs).
const STRIP_REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.',NOT_REACHED='Gemini chưa dịch tới đoạn này trong lượt này (các đoạn bên cạnh bị từ chối nên phải tách nhỏ).';
const answerWith=(ids,failedBlocks)=>({blocks:ids.map(id=>({id,translation:translated(id)})),failedBlocks,context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'});
test('Chinese left in a translation after the server\'s retry comes back as a draft: used, named "Trang N · đoạn k" and counted in Cần xem lại; opened again it is named again and Bắt đầu dịch asks for it',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(3),{translate:(json,call)=>call===1?answerWith(['p1-b1','p1-b3'],[{id:'p1-b2',code:'block_check',message:'Block p1-b2 còn chữ Hán chưa dịch: 探究.',draft:'Khám phá 探究',problems:['han']}]):null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn còn chữ Hán chưa dịch \(chi tiết trong phần cảnh báo\)/u);await idle(page);
  assert.equal(account.session.translationParts[1],'Khám phá 探究','the draft is used');assert.equal(account.calls.render,1);
  assert.equal(await page.textContent('#warnings'),'Trang 1 · đoạn 2: còn chữ Hán chưa dịch: 探究. Đã dùng bản dịch này của Gemini; hãy đối chiếu với nguyên tác và sửa trong “Chỉnh bản dịch từng đoạn”.\n');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 const again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.equal(await again.page.textContent('#warnings'),'Trang 1 · đoạn 2: bản dịch vẫn còn chữ Hán chưa dịch: 探究. Bấm Bắt đầu dịch để thử dịch lại, hoặc sửa trong “Chỉnh bản dịch từng đoạn”.\n');
  await again.page.fill('#api-key',KEY);await again.page.click('#translate');await waitProgress(again.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(again.page);
  assert.deepEqual(account.translateBodies.at(-1).blocks.map(block=>block.id),['p1-b2']);assert.equal(account.session.translationParts[1],translated('p1-b2'));
  assert.doesNotMatch(await again.page.textContent('#warnings'),/đoạn 2:/u);assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

// A translation the student wrote may keep Chinese on purpose (a character discussed, a name written first): it is the
// student's, so no run asks Gemini for it again and no note says to.
test('A block translated by hand that keeps Chinese stays as written: Bắt đầu dịch never sends it again, opened again no note asks for it',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(3),{translate:(json,call)=>call===1?answerWith(['p1-b1','p1-b3'],[{id:'p1-b2',code:'block_check',message:'Block p1-b2 còn chữ Hán chưa dịch: 探究.',draft:'Khám phá 探究',problems:['han']}]):null});
 const {context,page,errors}=await openStudy(account.api),own='Chữ 探究 có nghĩa là tìm tòi, khám phá.';
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  await page.click('#pdf-dual-viewer .pdf-block-editor > summary');await page.selectOption('[data-pdf-edit-select]','p1-b2');
  await page.fill('[data-pdf-edit-text]',own);await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đã lưu đoạn sửa\./u);await idle(page);
  assert.equal(account.session.translationParts[1],own);assert.deepEqual(account.session.pdfLayout.edited,['p1-b2']);
  const calls=account.calls.translate;await page.click('#translate');await waitProgress(page,/^Đã dịch đủ các đoạn\. Bấm Xuất PDF tiếng Việt/u);await idle(page);
  assert.equal(account.calls.translate,calls,'nothing is sent to Gemini');assert.equal(account.session.translationParts[1],own);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 const again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.doesNotMatch(await again.page.textContent('#warnings'),/đoạn 2:/u);
  const calls=account.calls.translate;await again.page.fill('#api-key',KEY);await again.page.click('#translate');await waitProgress(again.page,/^Đã dịch đủ các đoạn\. Bấm Xuất PDF tiếng Việt/u);await idle(again.page);
  assert.equal(account.calls.translate,calls,'opened again, the hand translation is still never sent');assert.equal(account.session.translationParts[1],own);assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('Blocks a request did not reach go again at once in a request of their own, in the groups the server left them in and without the block Gemini refused, at most twice; a block with nothing to use goes once more on its own',{skip,timeout:180000},async()=>{
 const first=()=>answerWith(['p1-b4'],[{id:'p1-b1',code:'gemini_refused',message:STRIP_REFUSED},{id:'p1-b2',code:'not_reached',message:NOT_REACHED},{id:'p1-b3',code:'block_check',message:'Block p1-b3 không bảo toàn ký hiệu toán.'}]);
 const account=fakeAccount(manifest(4),{translate:(json,call)=>call===1?first():null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được/u);await idle(page);
  assert.deepEqual(account.translateBodies.map(body=>body.blocks.map(block=>block.id)),[['p1-b1','p1-b2','p1-b3','p1-b4'],['p1-b3'],['p1-b2']],'the block with nothing to use alone, then the one not reached; never the refused one');
  assert.deepEqual(account.session.translationParts,[manifest(4).pages[0].blocks[0].source,...['p1-b2','p1-b3','p1-b4'].map(translated)]);
  const warnings=await page.textContent('#warnings');assert.match(warnings,/^Trang 1 · đoạn 1: giữ nguyên chữ gốc\. Gemini không trả kết quả vì đoạn này trùng khớp/u);assert.doesNotMatch(warnings,/đoạn [234]:/u);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // A block never reached is sent again while the requests sending it make headway (another block translated), twice at
 // most, then keeps its Chinese with a note; one failing alone again keeps it too. (A resend that translates nothing ends
 // it at once: a batch Gemini refuses whole is not asked for again and again.)
 const stubborn=fakeAccount(manifest(5),{translate:(json,call)=>{
  const ids=json.blocks.map(block=>block.id);if(call===1)return answerWith(['p1-b4'],[{id:'p1-b1',code:'gemini_refused',message:STRIP_REFUSED},{id:'p1-b2',code:'not_reached',message:NOT_REACHED},{id:'p1-b3',code:'block_check',message:'Block p1-b3 không bảo toàn ký hiệu toán.'},{id:'p1-b5',code:'not_reached',message:NOT_REACHED}]);
  return ids.includes('p1-b2')?answerWith(ids.filter(id=>id!=='p1-b2'),[{id:'p1-b2',code:'not_reached',message:NOT_REACHED}]):answerWith([],[{id:'p1-b3',code:'block_check',message:'Block p1-b3 không bảo toàn ký hiệu toán.'}]);
 }});
 const second=await openStudy(stubborn.api);
 try{
  await pickPdf(second.page);await second.page.click('#translate');await waitProgress(second.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 3 đoạn giữ nguyên chữ gốc vì Gemini không dịch được/u);await idle(second.page);
  assert.deepEqual(stubborn.translateBodies.map(body=>body.blocks.map(block=>block.id)),[['p1-b1','p1-b2','p1-b3','p1-b4','p1-b5'],['p1-b3'],['p1-b2','p1-b5'],['p1-b2']]);
  const warnings=await second.page.textContent('#warnings');
  assert.match(warnings,/Trang 1 · đoạn 2: giữ nguyên chữ gốc\. Gemini chưa dịch tới đoạn này trong lượt này/u);assert.match(warnings,/Trang 1 · đoạn 3: giữ nguyên chữ gốc\. Không bảo toàn ký hiệu toán\./u);
  assert.deepEqual(second.errors,[]);
 }finally{await second.context.close();}
 // A run longer than one request (Kỹ nhất sends 16 blocks at a time): the blocks not reached go before the blocks not sent
 // yet and never with them, naming the groups the server left them in.
 const document=manifest(8);for(const number of [2,3]){const added=structuredClone(document.pages[0]);added.number=number;added.blocks=added.blocks.map((b,i)=>({...b,id:`p${number}-b${i+1}`,text:`第${number}页第${i+1}段：温故而知新。`,source:`第${number}页第${i+1}段：温故而知新。`}));document.pages.push(added);}document.totalPages=3;
 const left=['p1-b2','p1-b5','p2-b3'],ids=page=>Array.from({length:8},(_,i)=>`p${page}-b${i+1}`);
 const long=fakeAccount(document,{translate:(json,call)=>call===1?answerWith(json.blocks.map(b=>b.id).filter(id=>!left.includes(id)),left.map((id,i)=>({id,code:'not_reached',message:NOT_REACHED,group:Math.min(i,1)}))):null});
 const third=await openStudy(long.api);
 try{
  await third.page.setInputFiles('#source-file',{name:'ba-trang.pdf',mimeType:'application/pdf',buffer:await pdfBytes(3)});
  await third.page.waitForFunction(()=>/^3 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  await third.page.fill('#content-title','Bài giữ bố cục');await third.page.fill('#api-key',KEY);await third.page.selectOption('#mode','premium');
  await third.page.click('#translate');await waitProgress(third.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(third.page);
  assert.deepEqual(long.translateBodies.map(body=>[body.blocks.map(b=>b.id),body.groups??null]),[[[...ids(1),...ids(2)],null],[left,[['p1-b2'],['p1-b5','p2-b3']]],[ids(3),null]]);
  assert.deepEqual(long.session.translationParts,[...ids(1),...ids(2),...ids(3)].map(translated));assert.equal(await third.page.textContent('#warnings'),'');
  assert.deepEqual(third.errors,[]);
 }finally{await third.context.close();}
});

// The Worker's own translate-blocks (backend/pdf-block-translation.js) behind the fake account, Gemini answered here by
// answer(blocks, again) ('REFUSE': refused as recitation): what a run costs the student's key, call by call. Each test's
// Gemini is told apart by the key it is given, so tests running side by side never answer each other's calls.
const geminiTests=new Map(),passFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{const answer=geminiTests.get(options?.headers?.['x-goog-api-key']);return answer?answer(url,options):passFetch(url,options);};
function realGemini(t,answer){
 const calls=[],key=`student-key-${geminiTests.size+1}-${Math.random().toString(36).slice(2)}`,env={GEMINI_API_KEY:key,GEMINI_MODEL:'gemini-2.5-flash',GEMINI_THINKING:'minimal'};
 geminiTests.set(key,async(url,options)=>{
  assert.match(String(url),/generativelanguage\.googleapis\.com/u);
  const body=JSON.parse(options.body),payload=JSON.parse(body.contents[0].parts[0].text),again=/asked for again/u.test(body.systemInstruction.parts[0].text),value=answer(payload.blocks,again);calls.push({ids:payload.blocks.map(b=>b.id),again});
  if(value==='REFUSE')return Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:0,totalTokenCount:20},candidates:[{finishReason:'RECITATION',content:{parts:[]}}]});
  return Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({blocks:value,contextUpdate:'',glossaryUpdates:{}})}]}}]});
 });
 t.after(()=>geminiTests.delete(key));
 return {calls,translate:json=>translatePdfBlocks(env,json,{strict:modeProfile(json.mode).strict}).then(result=>({...result,model:'gemini-test'}))};
}
// D5, Tiết kiệm included: a block a request leaves with nothing to use (a formula token lost) costs the server's retry and
// one request on its own, which the server asks once (again): three calls a press. A press that changes nothing keeps the
// exported PDF. Translations that keep characters on purpose (a word list) or join short sentences (a primary reader)
// cost one call and are named nowhere.
test('A block left with nothing to use costs three Gemini calls a press, the last marked as its one more try; a press that changes nothing keeps the PDF; a word list and a primary reader cost one call',{skip,timeout:120000},async t=>{
 const sources=['第一段：学而时习之，不亦说乎。','公式 @@PDF_INLINE_0@@ 成立。','生词：山 shān，水 shuǐ','小猫来了。小狗来了。小鸡也来了。'];
 const said={'p1-b1':'Đoạn một: học mà thường ôn luyện, chẳng phải là vui sao.','p1-b2':'Công thức bị mất.','p1-b3':'Từ mới: 山 (sơn – núi), 水 (thủy – nước)','p1-b4':'Mèo con đến, chó con đến, gà con cũng đến.'};
 const gemini=realGemini(t,blocks=>blocks.map(b=>({id:b.id,translation:said[b.id]}))),document=manifest(4);document.pages[0].blocks.forEach((b,i)=>{b.source=b.text=sources[i];});
 const account=fakeAccount(document,{translate:json=>gemini.translate(json)}),{context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được \(/u);await idle(page);
  assert.deepEqual(gemini.calls,[{ids:['p1-b1','p1-b2','p1-b3','p1-b4'],again:false},{ids:['p1-b2'],again:true},{ids:['p1-b2'],again:true}]);
  assert.deepEqual(account.translateBodies.map(body=>[body.blocks.map(b=>b.id),body.again??false]),[[['p1-b1','p1-b2','p1-b3','p1-b4'],false],[['p1-b2'],true]]);
  assert.deepEqual(account.session.translationParts,[said['p1-b1'],sources[1],said['p1-b3'],said['p1-b4']]);assert.equal(account.calls.render,1);
  const warnings=await page.textContent('#warnings');assert.match(warnings,/^Trang 1 · đoạn 2: giữ nguyên chữ gốc\. Không bảo toàn ký hiệu toán\./mu);assert.doesNotMatch(warnings,/đoạn [34]:/u);
  // Pressed again, as the status asks: the stand-in costs the same three calls; nothing changed, so the PDF stays.
  gemini.calls.length=0;await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên chữ gốc/u);await idle(page);
  assert.equal(gemini.calls.length,3);assert.equal(account.calls.render,1,'the exported PDF is kept');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// A batch Gemini refuses whole (every block of a famous text) costs one request's calls (MAX_CALLS) and translates
// nothing: it is never sent again and again. Tiết kiệm sends the 48 blocks in one request; Kỹ nhất (16 a request) stops
// the range run after the first, keeping the other blocks for a later press.
test('A batch Gemini refuses whole costs one request, at most 12 calls, and is not sent again; a range run stops there',{skip,timeout:180000},async t=>{
 const gemini=realGemini(t,()=>'REFUSE'),document=manifest(48);document.pages[0].blocks.forEach((b,i)=>{b.box=[40,10+i*11,360,19+i*11];b.fontSize=8;});
 for(const [mode,sent,done] of [['economy',48,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 48 đoạn giữ nguyên chữ gốc/u],['premium',16,/^Gemini từ chối dịch cả lượt 16 đoạn \(Trang 1 · đoạn 1, .* và 11 đoạn khác\), nên Hoa Trí dừng lại để không tốn thêm token; các đoạn đó giữ nguyên chữ gốc\. Còn 32 đoạn chưa dịch/u]]){
  gemini.calls.length=0;const account=fakeAccount(document,{translate:json=>gemini.translate(json)}),{context,page,errors}=await openStudy(account.api);
  try{
   await pickPdf(page);await page.selectOption('#mode',mode);await page.click('#translate');await waitProgress(page,done);await idle(page);
   assert.ok(gemini.calls.length<=12,`${mode}: ${gemini.calls.length} calls`);assert.deepEqual(account.translateBodies.map(body=>body.blocks.length),[sent],mode);
   assert.equal(account.session.translationParts.filter((text,i)=>text===document.pages[0].blocks[i].source).length,sent);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
});

// A session saved before hand edits were recorded (no pdfLayout.edited) may hold one that keeps Chinese on purpose: opened,
// such a block is recorded as possibly the student's (legacy) and never sent again; its note says how to have Gemini
// translate it again: its own Chinese saved in the editor gives it back, and the next press sends it.
test('A translation saved before hand edits were recorded that keeps Chinese is never sent again; saving its own Chinese gives it back to Gemini',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(3)),first=await openStudy(account.api);
 try{await pickPdf(first.page);await first.page.click('#translate');await waitProgress(first.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(first.page);}finally{await first.context.close();}
 const own='Từ 探究 (thám cứu) nghĩa là tìm tòi.';account.session.translationParts[1]=own;delete account.session.pdfLayout.edited;
 const calls=account.calls.translate,again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.match(await again.page.textContent('#warnings'),/^Trang 1 · đoạn 2: bản dịch còn chữ Hán \(探究\), có thể là bản dịch tay trước đây nên không gửi lại cho Gemini\. /mu);
  await again.page.fill('#api-key',KEY);await again.page.click('#translate');await waitProgress(again.page,/^Đã dịch đủ các đoạn; cần xem lại: 1 đoạn còn chữ Hán chưa dịch/u);await idle(again.page);
  assert.equal(account.calls.translate,calls,'nothing is sent');assert.equal(account.session.translationParts[1],own);assert.deepEqual([account.session.pdfLayout.edited,account.session.pdfLayout.legacy],[[],['p1-b2']]);
  await again.page.click('#pdf-dual-viewer .pdf-block-editor > summary');await again.page.selectOption('[data-pdf-edit-select]','p1-b2');
  await again.page.fill('[data-pdf-edit-text]',manifest(3).pages[0].blocks[1].source);await again.page.click('[data-pdf-edit-save]');await waitProgress(again.page,/^Đã lưu: đoạn này giữ chữ gốc\./u);await idle(again.page);
  assert.deepEqual([account.session.pdfLayout.edited,account.session.pdfLayout.legacy],[[],[]]);
  await again.page.click('#translate');await waitProgress(again.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(again.page);
  assert.deepEqual(account.translateBodies.at(-1).blocks.map(b=>b.id),['p1-b2']);assert.equal(account.session.translationParts[1],translated('p1-b2'));assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

// The problems of a draft live with the session (pdfLayout.review): opened again, a draft that may lack a line is still
// named and counted in Cần xem lại, and no later press sends it.
test('A draft that may lack a line is named and counted again when the session is opened again, and never sent again',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(3),{translate:(json,call)=>call===1?answerWith(['p1-b1','p1-b3'],[{id:'p1-b2',code:'block_check',message:'Block p1-b2 bản dịch có thể thiếu dòng so với nguyên tác.',draft:'Đoạn hai, thiếu một dòng.',problems:['rows']}]):null});
 const first=await openStudy(account.api);
 try{await pickPdf(first.page);await first.page.click('#translate');await waitProgress(first.page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn có thể thiếu dòng/u);await idle(first.page);assert.deepEqual(account.session.pdfLayout.review,{'p1-b2':['rows']});}
 finally{await first.context.close();}
 const calls=account.calls.translate,again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.equal(await again.page.textContent('#warnings'),'Trang 1 · đoạn 2: bản dịch có thể thiếu dòng so với nguyên tác; hãy đối chiếu và sửa trong “Chỉnh bản dịch từng đoạn”.\n');
  await again.page.fill('#api-key',KEY);await again.page.click('#translate');await waitProgress(again.page,/^Đã dịch đủ các đoạn; cần xem lại: 1 đoạn có thể thiếu dòng/u);await idle(again.page);
  assert.equal(account.calls.translate,calls,'the draft is not sent again');assert.deepEqual(account.session.pdfLayout.review,{'p1-b2':['rows']});assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('A block of the same text as one translated in the session takes that translation, however its spaces were read: a running footer on every page is asked for once, and reads the same on each',{skip,timeout:120000},async()=>{
 const document=twoPages(2);document.pages[0].blocks[1].source=document.pages[0].blocks[1].text='第一章　空间向量与立体几何';document.pages[1].blocks[1].source=document.pages[1].blocks[1].text=' 第一章空间向量与 立体几何';
 const account=fakeAccount(document),{context,page,errors}=await openStudy(account.api);
 try{
  await page.setInputFiles('#source-file',{name:'bai-hai-trang.pdf',mimeType:'application/pdf',buffer:await pdfBytes(2)});
  await page.waitForFunction(()=>/^2 trang · /u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  await page.fill('#content-title','Bài giữ bố cục');await page.fill('#api-key',KEY);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.deepEqual(account.translateBodies.flatMap(body=>body.blocks.map(block=>block.id)),['p1-b1','p1-b2','p2-b1'],'the second footer is not sent');
  assert.deepEqual(account.session.translationParts,[translated('p1-b1'),translated('p1-b2'),translated('p2-b1'),translated('p1-b2')]);
  assert.equal(await page.textContent('#warnings'),'');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A scanned block whose reading holds nothing to translate keeps the page\'s pixels: read once more, never sent for translation, named and counted in Cần xem lại',{skip,timeout:120000},async()=>{
 const unread={source:'[□]',text:'[□]',ocrCorrected:true,ocrKept:'empty',keepPixels:true},usage={prompt:1000,output:200,total:1200,requests:1};
 const account=fakeAccount(manifest(3,{scanned:true}),{ocr:json=>({blocks:json.blockIds.map(id=>id==='p1-b2'?{id,...unread}:{id,source:`第${id.slice(-1)}段`,text:`第${id.slice(-1)}段`,ocrCorrected:true}),ocrCorrectedVersion:1,ocrWarnings:[],usage,warnings:[],model:json.model})});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên hình gốc vì Gemini không đọc được chữ trong ảnh/u);await idle(page);
  assert.deepEqual(account.ocrBodies.map(body=>[body.blockIds,body.rereadIds??null]),[[['p1-b1','p1-b2','p1-b3'],null],[['p1-b2'],['p1-b2']]],'read, then read once more');
  assert.deepEqual(account.translateBodies.flatMap(body=>body.blocks.map(block=>block.id)),['p1-b1','p1-b3'],'nothing to translate is never sent');
  assert.equal(account.session.translationParts[1],'[□]');
  assert.match(await page.textContent('#warnings'),/Trang 1 · đoạn 2: Gemini không đọc được chữ trong ảnh của đoạn này nên trang giữ nguyên hình gốc ở đây, không dịch/u);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
});
