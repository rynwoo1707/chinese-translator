import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {overflowMessage,blockLabel} from '../services/pdf-layout/engine.mjs';
import {serviceFailure} from './pdf-layout.js';

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
 return {version:1,extractionVersion:3,engine:'pymupdf',totalPages:1,pages:[{number:1,width:400,height:560,original:PNG,background:PNG,blocks,images:[],drawings:[],ocr:scanned,protectedRegions:[],extractionVersion:3}],warnings:[]};
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
  assert.match(warnings,/Trang 1 · đoạn 2: Block p1-b2 thiếu số hoặc dẫn chứng: 2019\. Đã dùng bản dịch này của Gemini; hãy đối chiếu với nguyên tác và sửa trong “Chỉnh bản dịch từng đoạn”\./u);
  assert.match(warnings,/Trang 1 · đoạn 3: giữ nguyên chữ gốc\. Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền\. Bấm Bắt đầu dịch để thử dịch lại/u);
  assert.match(await progress(page),/^PDF tiếng Việt đã được lưu vào Thư viện riêng\. Cần xem lại: 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được, 1 đoạn dùng bản dịch còn thiếu số hoặc dẫn chứng/u);
  assert.equal(await page.inputValue('#api-key'),'');assert.equal(await page.textContent('#key-status'),'Đã nạp khóa Gemini cho phiên này.');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // Another tab opens the part from the history: the block still in Chinese is named again; Bắt đầu dịch sends only it,
 // and the part is exported anew.
 const again=await openStudy(account.api);
 try{
  await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${SESSION}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);await idle(again.page);
  assert.equal(await again.page.textContent('#warnings'),'Trang 1 · đoạn 3: vẫn là chữ gốc vì Gemini chưa dịch được đoạn này. Bấm Bắt đầu dịch để thử dịch lại, hoặc dịch tay trong “Chỉnh bản dịch từng đoạn”.\n');
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

// What the Worker answers when the PDF service finds translations longer than their boxes: the service's message
// (services/pdf-layout/engine.mjs overflowMessage, "Đoạn k" as the viewer numbers a page's blocks), mapped and checked by
// backend/pdf-layout.js serviceFailure, sent by the render route as 422 {error, code, blocks}.
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
  const message=overflowAnswer(document,refusals[0]).json.error;assert.match(message,/^Trang 2: bản dịch của [Đđ]oạn 1 và [Đđ]oạn 2 dài hơn khung chữ/u);
  assert.equal(await progress(page),message);assert.equal(await page.getAttribute('#progress','class'),'error');
  await page.waitForFunction(()=>document.querySelectorAll('#pdf-dual-viewer .is-overflow').length===2);
  let state=await viewerState(page);
  assert.deepEqual({page:state.page,open:state.open,block:state.block,text:state.text,outlined:state.outlined,focused:state.focused},{page:'Trang 2 · 2/2',open:true,block:'p2-b1',text:translated('p2-b1'),outlined:['p2-b1','p2-b2'],focused:true});
  assert.deepEqual(state.options.map(text=>text.replace(/ · .*?(?= · |$)/u,'')),['Đoạn 1 · Dài hơn khung chữ','Đoạn 2 · Dài hơn khung chữ'],'the editor names the blocks as the message does');
  // In a sentence a block is "Trang N · đoạn k", as in the warnings; "Đoạn k" is the editor's own list.
  assert.match(state.notice,/^Khi xuất PDF, bản dịch của Trang 2 · đoạn 1 và Trang 2 · đoạn 2 dài hơn khung chữ \(viền đỏ\)\./u);
  // Shortened and saved: its mark goes; the other block keeps its own.
  await page.fill('[data-pdf-edit-text]','Ngắn.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đã lưu đoạn sửa\./u);
  assert.equal(account.session.translationParts[2],'Ngắn.');
  await page.waitForFunction(()=>document.querySelectorAll('#pdf-dual-viewer .is-overflow').length===1);state=await viewerState(page);
  assert.deepEqual(state.outlined,['p2-b2']);assert.doesNotMatch(state.options[0],/Dài hơn khung chữ/u);assert.match(state.options[1],/Dài hơn khung chữ$/u);
  // Exported again: the one still too long is opened in turn; once it is shortened too, the PDF is exported and downloaded.
  await page.click('#download-pdf');await waitProgress(page,/^Trang 2: bản dịch của [Đđ]oạn 2 dài hơn khung chữ/u);await idle(page);
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

test('A scanned block Gemini could not read again keeps its machine text: named in the warnings and the Hanzi panel, never read again, and named again with the session',{skip,timeout:120000},async()=>{
 const NOTE=`Trang 1 · đoạn 2: ${OCR_REFUSED}. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.`,REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.';
 // Gemini then also refuses to translate that block once: it keeps its Chinese until Bắt đầu dịch asks again.
 const account=fakeAccount(manifest(3,{scanned:true}),{ocrKept:{'p1-b2':'refused'},translate:(json,call)=>call===1?{blocks:json.blocks.filter(b=>b.id!=='p1-b2').map(b=>({id:b.id,translation:translated(b.id)})),failedBlocks:[{id:'p1-b2',code:'gemini_refused',message:REFUSED}],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'}:null});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  let warnings=await page.textContent('#warnings');assert.ok(warnings.includes(NOTE),warnings);assert.match(warnings,/Trang 1 · đoạn 2: giữ nguyên chữ gốc\./u);
  assert.equal(account.session.parts[1],'（扫描）第2段','the machine text is what is translated');
  // Bắt đầu dịch asks Gemini again only for the block still in Chinese: its OCR note stays, its image is not read again.
  await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.equal(account.calls.ocr,1);assert.deepEqual(account.translateBodies.at(-1).blocks.map(b=>b.id),['p1-b2']);
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
  assert.ok((await again.page.textContent('#warnings')).includes(NOTE));assert.equal(account.calls.ocr,1);assert.deepEqual(again.errors,[]);
 }finally{await again.context.close();}
});

test('A scanned block kept with its machine text is never paid for again, even when the server leaves it unmarked as read',{skip,timeout:120000},async()=>{
 const account=fakeAccount(manifest(2,{scanned:true}),{ocrKept:{'p1-b1':'unread'},keptUnmarked:true});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  assert.equal(account.calls.ocr,1);assert.equal(account.document.ocrCorrectedVersion,0);
  await page.click('#translate');await idle(page);
  assert.equal(account.calls.refresh,0,'the scan is not extracted and read again');assert.equal(account.calls.ocr,1,'nor read again');assert.equal(account.calls.extract,1);
  assert.match(await progress(page),/^Đã dịch đủ các đoạn\./u);assert.deepEqual(errors,[]);
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

test('The block editor names a formula box it lost, or holds twice, in its own words ("Đoạn k", "[Công thức n]"), and saves nothing',{skip,timeout:120000},async()=>{
 const document=manifest(2),block=document.pages[0].blocks[0];
 Object.assign(block,{text:'设 x 为实数。',source:'设@@PDF_INLINE_1@@为实数。',inlines:[{token:'@@PDF_INLINE_1@@',image:PNG,width:10,height:12,text:'x'}]});
 const account=fakeAccount(document,{translate:json=>({blocks:json.blocks.map(b=>({id:b.id,translation:b.id==='p1-b1'?'Đặt @@PDF_INLINE_1@@ là số thực.':translated(b.id)})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:200,total:800,requests:1},warnings:[],model:'gemini-test'})});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u);await idle(page);
  await page.click('#pdf-dual-viewer .pdf-block-editor > summary');await page.selectOption('[data-pdf-edit-select]','p1-b1');
  assert.equal(await page.inputValue('[data-pdf-edit-text]'),'Đặt [Công thức 1] là số thực.');
  const saves=account.saves.length;
  await page.fill('[data-pdf-edit-text]','Đặt là số thực.');await page.click('[data-pdf-edit-save]');await waitProgress(page,/^Đoạn 1:/u);
  assert.equal(await progress(page),'Đoạn 1: bản sửa làm mất [Công thức 1]; hãy giữ nguyên ô này.');assert.equal(await page.getAttribute('#progress','class'),'error');
  await page.fill('[data-pdf-edit-text]','Đặt [Công thức 1] và [Công thức 1].');await page.click('[data-pdf-edit-save]');await waitProgress(page,/hơn một lần/u);
  assert.equal(await progress(page),'Đoạn 1: bản sửa có [Công thức 1] hơn một lần; hãy giữ đúng một ô này.');
  assert.equal(account.saves.length,saves,'nothing is saved');assert.equal(account.session.translationParts[0],'Đặt @@PDF_INLINE_1@@ là số thực.');assert.deepEqual(errors,[]);
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
  assert.match(await progress(first.page),/^Trang 1: bản dịch của [Đđ]oạn 1 dài hơn khung chữ/u);assert.deepEqual(first.errors,[]);
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
});
