import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extname,normalize,join} from 'node:path';
// A manifest the extractor of this code made carries its stamp (an older one is offered "Cập nhật bố cục").
import {LAYOUT_VERSION} from '../frontend/translation-modes.js';
import {overflowMessage,blockLabel} from '../services/pdf-layout/engine.mjs';
import {serviceFailure} from './pdf-layout.js';

// "Dịch cả quyển" in Microsoft Edge: the real study.html, study.js and whole-book.js against a fake Hoa Trí that keeps
// jobs, history, books and the stored original as the Worker does. The Gemini-backed routes (translate-blocks,
// ocr-blocks, models) and the PDF service (extract, render) are answered by the fake; every other host is blocked.
// Skipped without Edge or without frontend/vendor (npm run prepare:vendor).
const require=createRequire(import.meta.url),{PDFDocument,StandardFonts,rgb}=require('@cantoo/pdf-lib');
const root=fileURLToPath(new URL('../frontend/',import.meta.url));
const vendorReady=['vendor/pdf.mjs','vendor/pdf.worker.mjs','vendor/pdf-lib.esm.min.js'].every(file=>existsSync(join(root,file)));
let browser=null;if(vendorReady)try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=!vendorReady?'frontend/vendor is not built here (npm run prepare:vendor)':browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.wasm':'application/wasm','.jpg':'image/jpeg','.png':'image/png','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
const KEY='AIzaSy'+'x'.repeat(33),TOTAL=26,BLANK=7,SCANNED=3;
const sqlTime=()=>new Date().toISOString().replace('T',' ').slice(0,19);

// A 26-page book: a full-colour cover, a blank page 7, every page a different width so a chunk shows which pages it holds.
async function bookPdf(){
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let number=1;number<=TOTAL;number++){
  const page=pdf.addPage([400+number,560]);
  if(number===1){page.drawRectangle({x:0,y:0,width:401,height:560,color:rgb(.16,.36,.6)});page.drawText('SACH THU',{x:70,y:320,size:46,font,color:rgb(1,.88,.3)});}
  else if(number!==BLANK)for(let line=0;line<24;line++)page.drawText(`Trang ${number}, dong ${line+1}: noi dung mau de kiem tra bo cuc`,{x:36,y:520-line*20,size:10,font});
 }
 return Buffer.from(await pdf.save());
}

// blocksPerPage/blockChars: long blocks go to Gemini one per request, so a stop can land in the middle of a page.
function fakeHoaTri({blocksPerPage=1,blockChars=0}={}){
 const state={log:[],sources:new Map(),jobs:[],history:new Map(),books:[],manifests:new Map(),chunks:[],translations:[],usage:0,translateCalls:0,translateHook:null,translateGate:null,ocrSlim:[]};
 const send=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(body===undefined?'':JSON.stringify(body));};
 const read=req=>new Promise((resolve,reject)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
 const job=id=>state.jobs.find(entry=>entry.id===id);
 // As backend/book-jobs.js shows a job: the run holding it (runnerId, until leaseUntil) and the token reports it counted stay inside.
 const held=found=>Boolean(found.runnerId)&&found.leaseUntil>Date.now();
 const view=({runnerId,leaseUntil,counted,...found})=>({...found,runner:held({runnerId,leaseUntil})?runnerId:null,leaseSeconds:held({runnerId,leaseUntil})?Math.ceil((leaseUntil-Date.now())/1000):0});
 const partOf=(row,manifest)=>({id:row.library_chapter_id,title:row.title,position:null,mime:row.exported?'application/pdf':'text/plain',sessionId:row.id,filename:row.filename,pageStart:row.page_start,pageEnd:row.page_end,totalPages:row.source_total_pages,sha256:row.source_sha256,pages:manifest.pages.map(page=>page.number),updatedAt:row.updated_at,translatedAt:row.updated_at});
 // As backend/study-history.js: a first save may name its session (body.id); a save naming an older revision is refused.
 // state.saveHook(id,body): an answer instead of the save (id is the session a PUT names, null for a first save).
 function saveHistory(id,body){
  const hooked=state.saveHook?.(id,body);if(hooked)return hooked;
  id||=body.id&&state.history.has(body.id)?body.id:null;
  const prior=id?state.history.get(id):null,sessionId=id||body.id||randomUUID(),stateBody=body.state,manifest=state.manifests.get(stateBody.pdfLayout?.assetId),complete=stateBody.done===stateBody.parts.length&&stateBody.translationParts.every(text=>text?.trim());
  if(prior&&body.revision!==undefined&&body.revision!==prior.row.revision)return [409,{error:'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác.',code:'history_conflict',revision:prior.row.revision}];
  const pages=manifest?manifest.pages.map(page=>page.number):[];
  const row={...(prior?.row||{created_at:sqlTime()}),id:sessionId,title:body.title,filename:body.filename,domain:body.domain,mode:body.mode,status:complete?'complete':stateBody.done?'translating':'draft',translated_parts:stateBody.done,total_parts:stateBody.parts.length,page_start:pages.length?Math.min(...pages):null,page_end:pages.length?Math.max(...pages):null,source_total_pages:manifest?.totalPages??null,source_sha256:manifest?.sourceSha256||body.sha256||null,updated_at:sqlTime(),revision:(prior?.row.revision||0)+1};
  row.library_story_id=prior?.row.library_story_id||(Object.hasOwn(body,'bookId')?body.bookId||null:null);row.library_chapter_id=prior?.row.library_chapter_id||null;
  if(complete&&!row.library_chapter_id){
   let book=state.books.find(entry=>entry.id===row.library_story_id);
   if(!book){book={id:randomUUID(),title:body.title,cover:{image:false,page:null,sha256:null},parts:[]};state.books.push(book);}
   row.library_story_id=book.id;row.library_chapter_id=randomUUID();
   book.parts.push(partOf(row,manifest));book.parts.sort((a,b)=>a.pageStart-b.pageStart);
   for(const part of book.parts)if(book.parts.length>1&&part.title===book.title)part.title=part.pageStart===part.pageEnd?`Trang ${part.pageStart}`:`Trang ${part.pageStart}–${part.pageEnd}`;
  }
  state.history.set(sessionId,{row,state:{...stateBody,pdfLayout:{...stateBody.pdfLayout,...(prior?.state.pdfLayout?.exported?{exported:true,renderVersion:3}:{})}}});
  return [prior?200:201,{id:sessionId,status:row.status,libraryStoryId:row.library_story_id,libraryChapterId:row.library_chapter_id,updatedAt:new Date().toISOString(),revision:row.revision}];
 }
 async function extract(form){
  const file=form.get('file'),offset=Number(form.get('pageOffset')),sha=form.get('sourceSha256'),stored=state.sources.get(sha);
  if(!stored)return [404,{error:'Tài khoản chưa lưu tệp gốc này.',code:'source_missing'}];
  const chunk=await PDFDocument.load(new Uint8Array(await file.arrayBuffer())),widths=chunk.getPages().map(page=>page.getWidth());
  state.chunks.push({offset,pages:form.get('pages'),count:chunk.getPageCount(),widths,mode:form.get('mode')});
  const pages=widths.map((width,index)=>{
   const number=offset+index+1,scanned=number===SCANNED;
   const text=k=>`第${number}页第${k+1}段的内容。`.padEnd(blockChars,'内容'),blocks=number===BLANK?[]:Array.from({length:blocksPerPage},(_,k)=>({id:`p${number}-b${k+1}`,text:text(k),source:scanned?`第${number}页（扫描）第${k+1}段`:text(k),box:[40,60+k*48,260,92+k*48],fontSize:12,...(scanned?{image:PNG}:{})}));
   return {number,width,height:560,original:PNG,background:PNG,blocks,images:[],drawings:[],ocr:scanned,protectedRegions:[],extractionVersion:LAYOUT_VERSION};
  });
  if(!pages.some(page=>page.blocks.length))return [422,{error:'Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.',code:'no_text',pages:pages.map(page=>page.number)}];
  const assetId=randomUUID(),document={version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:stored.pages,sourceSha256:sha,pages,warnings:[]};
  state.manifests.set(assetId,document);return [201,{assetId,document,originalUrl:`/api/my/study/pdf-layout/assets/${assetId}/original`}];
 }
 async function api(req,res,path,body){
  const method=req.method,json=()=>JSON.parse(body.toString('utf8')||'{}');let match;
  if(path==='/api/me')return send(res,200,{authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}});
  if(path==='/api/my/study/pdf-layout/config')return send(res,200,{configured:true,maxBytes:25*1024*1024,maxPages:20});
  if(path==='/api/my/study/pdf-layout/font')return send(res,200,{css:''});
  if(path==='/api/my/study/library-match')return send(res,200,{match:null});
  if(path==='/api/my/study/models')return send(res,200,{models:[{id:'gemini-2.5-flash-lite',name:'Gemini 2.5 Flash-Lite'}],requested:'gemini-2.5-flash-lite',selected:'gemini-2.5-flash-lite'});
  if((match=path.match(/^\/api\/my\/study\/sources\/([a-f\d]{64})$/u))){
   const sha=match[1],stored=state.sources.get(sha);
   if(method==='HEAD')return stored?(res.writeHead(200,{'X-PDF-Pages':String(stored.pages)}),res.end()):(res.writeHead(404),res.end());
   if(method==='PUT'){if(createHash('sha256').update(body).digest('hex')!==sha)return send(res,400,{error:'Nội dung tệp không khớp mã kiểm tra.',code:'checksum_mismatch'});state.sources.set(sha,{bytes:body,pages:Number(req.headers['x-pdf-pages']),filename:decodeURIComponent(req.headers['x-source-filename']||'')});return send(res,201,{sha256:sha,pages:Number(req.headers['x-pdf-pages']),stored:true});}
   if(!stored)return send(res,404,{error:'Tài khoản chưa lưu PDF gốc này.'});res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':String(stored.bytes.length)});return res.end(stored.bytes);
  }
  if(path==='/api/my/study/book-jobs'&&method==='GET')return send(res,200,{jobs:state.jobs.map(view)});
  if(path==='/api/my/study/book-jobs'&&method==='POST'){
   const input=json(),stored=state.sources.get(input.sourceSha256);if(!stored)return send(res,404,{error:'Tài khoản chưa lưu tệp gốc này.',code:'source_missing'});
   const open=state.jobs.find(entry=>entry.sourceSha256===input.sourceSha256&&entry.status!=='done');if(open)return send(res,409,{error:'Đã có lượt dịch.',code:'job_exists',job:view(open)});
   const states='.'.repeat(input.totalPages).split('');if(input.coverPage)states[input.coverPage-1]='c';
   const now=new Date().toISOString(),created={id:randomUUID(),sourceSha256:input.sourceSha256,filename:input.filename,title:input.title,storyId:input.storyId||null,totalPages:input.totalPages,pageStates:states.join(''),chunkSize:input.chunkSize,domain:input.domain,mode:input.mode,model:null,status:'ready',pauseReason:null,usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{...input.glossary},createdAt:now,updatedAt:now,runnerId:null,leaseUntil:0,counted:[]};
   state.jobs.push(created);return send(res,201,{job:view(created)});
  }
  if((match=path.match(/^\/api\/my\/study\/book-jobs\/([\w-]+)$/u))){
   const found=job(match[1]);if(!found)return send(res,404,{error:'Không tìm thấy lượt dịch cả quyển.',code:'not_found'});
   if(method==='DELETE'){state.jobs=state.jobs.filter(entry=>entry!==found);return send(res,200,{ok:true});}
   if(method==='GET')return send(res,200,{job:view(found)});
   const input=json(),codes={pending:'.',done:'d',blank:'b',cover:'c',skipped:'s',failed:'f'},chars=[...found.pageStates],now=Date.now(),mine=held(found)&&input.runner===found.runnerId;(state.runners??=new Set()).add(input.runner??null);
   // state.modeDelay(n): how long the n-th change of Cách dịch takes to arrive (a slow network); state.modeSaves: each
   // change with the times it was sent and answered.
   if(input.mode!==undefined){const save={mode:input.mode,sent:Date.now()};(state.modeSaves??=[]).push(save);const wait=state.modeDelay?.(state.modeSaves.length);if(wait)await new Promise(resolve=>setTimeout(resolve,wait));save.answered=Date.now();}
   // As backend/book-jobs.js: another device's run is refused while the job is held (tokens are always counted, once).
   if(held(found)&&!mine&&['pages','status','pauseReason','model','storyId','glossary','mode'].some(key=>input[key]!==undefined)){state.refused=(state.refused||0)+1;const retryAfter=Math.ceil((found.leaseUntil-now)/1000);return send(res,409,{error:'Quyển này đang được dịch ở một thiết bị khác (hoặc một trình duyệt khác).',code:'job_busy',retryAfter,job:view(found)},{'Retry-After':String(retryAfter)});}
   // A translated page never goes back to pending or failed.
   for(const [page,name] of Object.entries(input.pages||{})){const code=codes[name];if(chars[page-1]==='d'&&(code==='.'||code==='f'))continue;chars[page-1]=code;}
   found.pageStates=chars.join('');for(const report of input.reports||[])if(!found.counted.includes(report.id)){found.counted.push(report.id);for(const key of Object.keys(found.usage))found.usage[key]+=report.usage?.[key]||0;}
   if(input.status)found.status=input.status;if(input.pauseReason!==undefined)found.pauseReason=input.pauseReason;else if(input.status&&input.status!=='paused')found.pauseReason=null;
   if(input.storyId!==undefined)found.storyId=input.storyId;if(input.model)found.model=input.model;if(input.mode)found.mode=input.mode;found.glossary={...found.glossary,...input.glossary};found.updatedAt=new Date().toISOString();
   if(input.runner&&(!held(found)||mine))Object.assign(found,found.status==='running'?{runnerId:input.runner,leaseUntil:now+600000}:{runnerId:null,leaseUntil:0});
   state.patches=(state.patches||0)+1;return send(res,200,{job:view(found)});
  }
  // The newest 100, as backend/study-history.js lists them.
  if(path==='/api/my/study/history'&&method==='GET')return send(res,200,[...state.history.values()].map(entry=>entry.row).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,100));
  if(path==='/api/my/study/history'&&method==='POST')return send(res,...saveHistory(null,json()));
  if((match=path.match(/^\/api\/my\/study\/history\/([\w-]+)$/u))){
   const entry=state.history.get(match[1]);if(!entry)return send(res,404,{error:'Không tìm thấy lịch sử dịch.'});
   if(method==='GET')return send(res,200,{...entry.row,state:entry.state});
   if(method==='PUT')return send(res,...saveHistory(match[1],json()));
   if(method==='DELETE'){
    state.history.delete(match[1]);const book=state.books.find(item=>item.id===entry.row.library_story_id);let removedBookId=null;
    if(book){book.parts=book.parts.filter(part=>part.sessionId!==entry.row.id);if(!book.parts.length){state.books=state.books.filter(item=>item!==book);removedBookId=book.id;}}
    return send(res,200,{ok:true,removedBookId});
   }
  }
  if(path==='/api/my/study/books'&&method==='GET')return send(res,200,state.books);
  if((match=path.match(/^\/api\/my\/study\/books\/([\w-]+)\/cover$/u))){const book=state.books.find(item=>item.id===match[1]);if(method==='POST')book.cover={image:true,page:1,sha256:null};state.coverUploads=(state.coverUploads||0)+(method==='POST'?1:0);return send(res,200,{id:book.id,cover:book.cover});}
  if((match=path.match(/^\/api\/my\/study\/pdf-layout\/assets\/([\w-]+)\/manifest$/u)))return send(res,200,state.manifests.get(match[1]));
  // An exported part (render), as the viewer and a download fetch it: a page per page of its chunk.
  if((match=path.match(/^\/api\/my\/study\/pdf-layout\/assets\/([\w-]+)\/translated$/u))){const manifest=state.manifests.get(match[1]);if(!manifest)return send(res,404,{error:'Không tìm thấy PDF.'});const doc=await PDFDocument.create();for(const entry of manifest.pages)doc.addPage([entry.width,entry.height]);const bytes=Buffer.from(await doc.save());res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':String(bytes.length)});return res.end(bytes);}
  if(path==='/api/my/study/pdf-layout/extract'){const form=await new Request('http://fake/extract',{method:'POST',headers:{'content-type':req.headers['content-type']},body}).formData(),[status,result]=await extract(form);return send(res,status,result);}
  if(path==='/api/my/study/pdf-layout/ocr-blocks'){
   const input=json(),document=state.manifests.get(input.assetId),warnings=[];assert.equal(input.apiKey,KEY);
   // state.ocrKept {id: code}: a block Gemini could not read again keeps its machine text, stored as read with its mark
   // and named in a warning (backend/pdf-block-ocr.js).
   for(const page of document.pages)for(const [index,block] of page.blocks.entries())if(input.blockIds.includes(block.id)){block.ocrCorrected=true;if(state.ocrKept?.[block.id]){block.ocrKept=state.ocrKept[block.id];warnings.push(`Trang ${page.number} · đoạn ${index+1}: Gemini không trả bản đọc vì trùng khớp nguyên văn với nội dung có bản quyền. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.`);}else block.source=block.text;}
   document.ocrCorrectedVersion=1;document.ocrWarnings=[...(document.ocrWarnings||[]),...warnings];state.usage+=1500;state.ocrSlim.push(input.slim===true);const usage={prompt:1200,output:300,thinking:0,total:1500,requests:1};
   // slim (backend/pdf-layout.js ocrBlockFields): only the blocks read, never the manifest with its images.
   if(input.slim===true)return send(res,200,{blocks:document.pages.flatMap(page=>page.blocks).filter(block=>input.blockIds.includes(block.id)).map(({id,source,text,ocrCorrected,ocrKept})=>({id,source,text,ocrCorrected,...(ocrKept?{ocrKept}:{})})),ocrCorrectedVersion:1,ocrWarnings:document.ocrWarnings,usage,warnings,model:input.model});
   return send(res,200,{document,usage,warnings,model:input.model});
  }
  if(path==='/api/my/study/translate-blocks'){
   const input=json(),call=++state.translateCalls;assert.equal(input.apiKey,KEY);state.translations.push(input);
   const hooked=await state.translateHook?.(input,call);if(hooked)return send(res,hooked[0],hooked[1]);if(state.translateGate)await state.translateGate;
   state.usage+=867;
   return send(res,200,{blocks:input.blocks.map(block=>({id:block.id,translation:`Bản dịch ${block.id.split('-')[0].replace('p','trang ')}.`})),...(input.partial?{failedBlocks:[]}:{}),context:'Sách thử.',glossary:{...input.glossary,[`术语${call}`]:`thuật ngữ ${call}`},usage:{prompt:600,output:267,thinking:0,total:867,requests:1},warnings:[],model:'gemini-2.5-flash-lite'});
  }
  if(path==='/api/my/study/pdf-layout/render'){const input=json(),entry=state.history.get(input.historyId),hooked=state.renderHook?.(input,state.manifests.get(input.assetId));if(hooked)return send(res,hooked[0],hooked[1]);entry.row.exported=true;entry.state.pdfLayout={...entry.state.pdfLayout,exported:true,renderVersion:3};for(const book of state.books)for(const part of book.parts)if(part.sessionId===entry.row.id)part.mime='application/pdf';state.renders=(state.renders||0)+1;return send(res,200,{url:`/api/my/study/pdf-layout/assets/${input.assetId}/translated`,renderVersion:3});}
  return send(res,404,{error:`fake: ${method} ${path}`});
 }
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://fake'),path=decodeURIComponent(url.pathname),body=['GET','HEAD'].includes(req.method)?Buffer.alloc(0):await read(req);
   if(path.startsWith('/api/')){state.log.push(`${req.method} ${path.replace(/[a-f\d]{64}/u,'<sha>').replace(/[a-f\d-]{36}/gu,'<id>')}`);return await api(req,res,path,body);}
   const file=normalize(join(root,path==='/'?'study.html':path));if(!file.startsWith(normalize(root)))return send(res,403,{error:'forbidden'});
   const data=await readFile(file).catch(()=>null);if(!data)return send(res,404,{error:'missing'});
   res.writeHead(200,{'Content-Type':TYPES[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  }catch(error){if(!res.headersSent)send(res,500,{error:String(error?.message||error)});state.failures=[...(state.failures||[]),String(error?.stack||error)];}
 });
 return {state,listen:()=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`))),close:()=>new Promise(resolve=>server.close(resolve))};
}
async function openStudy(base,viewport={width:1280,height:900}){
 const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 page.on('pageerror',error=>errors.push(String(error)));
 // Every text the whole-book status line shows, to check the countdown and pause messages afterwards.
 await page.addInitScript(()=>{window.__statuses=[];addEventListener('DOMContentLoaded',()=>{const line=document.querySelector('#whole-book-status');new MutationObserver(()=>window.__statuses.push(line.textContent)).observe(line,{childList:true,characterData:true,subtree:true});});});
 await page.goto(`${base}/study.html`);await page.waitForSelector('#study-history:not([hidden])');await page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
 return {context,page,errors};
}
// D2: the text on a detected cover is translated like any page ("Dịch chữ trên bìa" starts ticked; its original stays the
// book's cover image). These runs keep it as printed, the student's own untick, unless translateCover says otherwise.
// resume: the file's run exists already, and keeps the cover it started with (its page state).
async function pickBook(page,pdf,{translateCover=false,resume=false}={}){
 await page.setInputFiles('#source-file',{name:'sach-thu.pdf',mimeType:'application/pdf',buffer:pdf});
 await page.waitForSelector('#book-mode:not([hidden])');await page.click('#book-mode label:has(input[value="book"])');
 await page.waitForSelector('#whole-book:not([hidden])');
 await page.waitForFunction(total=>document.querySelectorAll('#page-grid .page-cell').length===total,TOTAL);
 if(resume){await page.waitForFunction(()=>document.querySelector('#page-grid .page-cell')?.dataset.state==='cover',null,{timeout:20000});return;}
 await page.waitForFunction(()=>document.querySelector('#cover-label').textContent==='Bìa: trang 1',null,{timeout:20000});
 assert.equal(await page.$eval('#cover-translate',node=>node.checked),true,'the cover\'s text is translated by default');
 assert.equal(await page.$eval('#page-grid .page-cell',cell=>cell.dataset.state),'pending');assert.match(await page.$eval('#whole-book-summary',node=>node.textContent),/bìa: trang 1 \(dịch chữ trên bìa\)/u);
 assert.match(await page.$eval('#cover-note',node=>node.textContent),/Chữ trên bìa được dịch như các trang khác; ảnh gốc của trang bìa vẫn là ảnh bìa sách/u);
 if(translateCover)return;
 await page.uncheck('#cover-translate');
 await page.waitForFunction(()=>document.querySelector('#page-grid .page-cell')?.dataset.state==='cover',null,{timeout:20000});
}
const statusText=page=>page.$eval('#whole-book-status',node=>node.textContent);

// Each scenario has its own fake server and browser context, so they run side by side.
// At most four pages at a time, like study-ui-layout: every run here draws PDFs with pdf.js, and too many at once can
// make Edge close mid-run on a machine short of memory.
describe('Dịch cả quyển in Edge',{concurrency:4},()=>{
test('Dịch cả quyển: upload once, chunks of at most 20 pages with their offset, blank and cover pages free, quota wait, grouped history',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf(),sha=createHash('sha256').update(pdf).digest('hex');
 // The first Gemini call hits the per-minute quota: the run must wait and go on by itself.
 fake.state.translateHook=(input,call)=>call===1?[429,{error:'Gemini đang giới hạn số yêu cầu mỗi phút của khóa này.',code:'quota_minute',retryAfter:1}]:null;
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);
  const estimate=await page.$eval('#whole-book-estimate',node=>node.textContent);
  assert.match(estimate,/Ước tính token Gemini/u);assert.match(estimate,/chỉ là ước tính/u);assert.match(estimate,/× [\d.]+–[\d.]+ token/u);assert.match(estimate,/Số token thật tùy lượng chữ/u);assert.doesNotMatch(estimate,/Số đo thật|867/u);assert.match(estimate,/Bìa giữ nguyên, trang trống và trang bỏ qua: 0 token/u);
  assert.match(await page.$eval('#whole-book-summary',node=>node.textContent),/26 trang .* bìa: trang 1/u);
  assert.equal(await page.$eval('#translate',node=>node.textContent.trim()),'Dịch cả quyển →');assert.equal(await page.$eval('#stop',node=>node.textContent),'Dừng sau trang hiện tại');
  await page.fill('#content-title','Sách thử nghiệm');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const state=fake.state,[job]=state.jobs;
  assert.deepEqual(state.failures,undefined);assert.deepEqual(errors,[]);
  // The original went up once, after a HEAD, and before the job was created.
  const log=state.log.filter(line=>/^(?:HEAD|PUT) \/api\/my\/study\/sources\/|^POST \/api\/my\/study\/book-jobs$/u.test(line));
  assert.deepEqual(log.slice(0,3),['HEAD /api/my/study/sources/<sha>','PUT /api/my/study/sources/<sha>','POST /api/my/study/book-jobs']);
  assert.equal(state.log.filter(line=>line.startsWith('PUT /api/my/study/sources')).length,1);assert.equal(state.sources.get(sha).pages,TOTAL);assert.equal(state.sources.get(sha).filename,'sach-thu.pdf');
  // Chunks: pages 2–21 then 22–26, cut from the original page for page (the widths say which pages), the cover never sent.
  assert.deepEqual(state.chunks.map(({offset,count,pages})=>[offset,count,pages]),[[1,20,'1-20'],[21,5,'1-5']]);
  assert.deepEqual(state.chunks.flatMap(chunk=>chunk.widths),Array.from({length:25},(_,i)=>402+i));
  // Cách dịch (Tiết kiệm here) goes with the job, every chunk's extraction and every translation.
  assert.equal(job.mode,'economy');assert.deepEqual(state.chunks.map(chunk=>chunk.mode),['economy','economy']);assert.ok(state.translations.every(input=>input.mode==='economy'));
  assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));assert.equal(job.status,'done');assert.equal(job.title,'Sách thử nghiệm');
  // Tokens: the scanned page's reading and every translation; the refused call cost nothing.
  assert.equal(job.usage.total,state.usage);assert.equal(job.usage.total,1500+867*2);assert.equal(job.model,'gemini-2.5-flash-lite');
  // The book's glossary goes with every chunk: the term chunk 1 learned is in chunk 2's request.
  assert.ok(Object.hasOwn(job.glossary,'术语2'));assert.equal(state.translations.at(-1).glossary['术语2'],'thuật ngữ 2');
  assert.equal(state.translateCalls,3);
  // The scanned page was read with slim answers: the manifest with its images never came back for a reading.
  assert.ok(state.ocrSlim.length&&state.ocrSlim.every(Boolean),JSON.stringify(state.ocrSlim));
  assert.ok(state.translations.every(input=>input.partial===true),'every block batch asks for what passed and what failed');
  const statuses=await page.evaluate(()=>window.__statuses);
  assert.ok(statuses.some(text=>/giới hạn số yêu cầu mỗi phút .*Tự tiếp tục sau \d+ giây/u.test(text)),statuses.join('\n'));
  // Both parts joined one book, were exported, and the book got its cover image.
  assert.equal(state.books.length,1);assert.equal(state.books[0].parts.length,2);assert.equal(job.storyId,state.books[0].id);assert.equal(state.renders,2);assert.equal(state.coverUploads,1);
  assert.deepEqual(await page.$$eval('#page-grid .page-cell',cells=>cells.map(cell=>cell.dataset.state[0]).join('')),'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));
  assert.equal(await page.$eval('#whole-book-count',node=>node.textContent),'Đã dịch 24/24 trang');
  assert.match(await page.$eval('#whole-book-tokens',node=>node.textContent),/Quyển này đã dùng 3\.234 token Gemini/u);
  assert.equal(await page.$eval('#translate',node=>node.disabled),true);
  // History: the two chunk sessions sit under their book, not as two cards.
  const row=await page.$eval('#study-books-list .book-job',node=>node.textContent);
  assert.match(row,/Dịch cả quyển · Đã dịch 24\/24 trang · Hoàn tất · 3\.234 token · bìa giữ nguyên · 1 trang trống/u);assert.match(row,/Các phần đã lưu \(2\)/u);
  assert.equal(await page.$$eval('#study-history-list .history-card',cards=>cards.length),0);
  // Deleting one part from the book row asks first, then removes it.
  await page.click('#study-history > summary');await page.click('#study-books-list .book-job-parts summary');await page.click('#study-books-list .book-job-parts li:last-child .history-delete');
  await page.waitForSelector('#book-dialog[open]');assert.match(await page.$eval('#book-dialog-body',node=>node.textContent),/khỏi lịch sử và Thư viện riêng\? .*xóa vĩnh viễn/u);
  await page.click('#book-dialog-submit');await page.waitForFunction(()=>document.querySelector('#progress').textContent==='Đã xóa bản dịch.');
  assert.equal(state.history.size,1);assert.match(await page.$eval('#study-books-list .book-job',node=>node.textContent),/Các phần đã lưu \(1\)/u);
  // Phone width: the panel and its grid stay inside the screen.
  await page.setViewportSize({width:390,height:844});
  const phone=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:innerWidth,panel:document.querySelector('#whole-book').getBoundingClientRect().right,grid:document.querySelector('#page-grid').getBoundingClientRect().right}));
  assert.ok(phone.scroll<=phone.inner&&phone.panel<=phone.inner&&phone.grid<=phone.inner,JSON.stringify(phone));
 }finally{await context.close();await fake.close();}
});

// D2: the cover's text translated (the default): its page goes with the first chunk like any other page, and the book
// still gets the original page as its cover image.
test('Dịch cả quyển: with "Dịch chữ trên bìa" ticked, as it starts, the cover page is translated with the first chunk and its original is the book\'s cover image',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf(),{context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf,{translateCover:true});await page.fill('#book-pages','1-3');await page.fill('#content-title','Sách dịch cả bìa');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const state=fake.state,[job]=state.jobs;
  assert.deepEqual(state.chunks.map(({offset,count})=>[offset,count]),[[0,3]],'the cover goes with the first chunk');assert.equal(job.pageStates.slice(0,3),'ddd');assert.equal(state.coverUploads,1,'the original page is the book cover');
  assert.match(await page.$eval('#whole-book-summary',node=>node.textContent),/bìa: trang 1 \(dịch chữ trên bìa\)/u);assert.deepEqual(errors,[]);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a day quota pauses with the reset time; after a reload the run continues from the stored original',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let dayQuota=true;
 // The first answer is refused by the server's checks but billed: it is tried once more and its tokens still count.
 fake.state.translateHook=(input,call)=>call===1?[400,{error:'Block p2-b1 không bảo toàn công thức @@PDF_INLINE_1@@.',usage:{prompt:400,output:100,thinking:0,total:500,requests:1}}]:dayQuota&&input.blocks[0].id==='p22-b1'?[429,{error:'Gemini báo khóa này đã dùng hết hạn mức trong ngày.',code:'quota_day',retryAfter:null}]:null;
 let {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách tạm dừng');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/hết hạn mức trong ngày/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const paused=await statusText(page);assert.match(paused,/Dán khóa khác rồi bấm Tiếp tục dịch cả quyển, hoặc đợi hạn mức đặt lại lúc khoảng \d\d:\d\d (hôm nay|ngày mai) \(giờ Việt Nam\)/u);
  const [job]=fake.state.jobs;assert.equal(job.status,'paused');assert.equal(job.pauseReason,'quota_day');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(21-BLANK)+'.....');
  // Chunk 1: the scanned page's reading, the refused answer and the accepted one.
  assert.equal(job.usage.total,1500+500+867);assert.equal(job.usage.requests,3);
  assert.equal(await page.$eval('#translate',node=>node.textContent.trim()),'Tiếp tục dịch cả quyển →');assert.deepEqual(errors,[]);
  // Reload: the key and the picked file are gone; the history offers to continue.
  await context.close();({context,page,errors}=await openStudy(base));
  // An unfinished book opens the history by itself after a reload.
  await page.waitForFunction(()=>document.querySelector('#study-history').open);
  const row=await page.$eval('#study-books-list .book-job',node=>node.textContent);assert.match(row,/Đã dịch 19\/24 trang · Tạm dừng · hết hạn mức ngày/u);
  dayQuota=false;await page.fill('#api-key',KEY);await page.click('#study-books-list [data-book-resume]');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const log=fake.state.log;
  // No second upload, the original came back from the account, and the paused chunk was continued, not extracted again.
  assert.equal(log.filter(line=>line.startsWith('PUT /api/my/study/sources')).length,1);assert.equal(log.filter(line=>line==='GET /api/my/study/sources/<sha>').length,1);
  assert.equal(fake.state.chunks.length,2);assert.equal(fake.state.history.size,2);
  assert.equal(job.status,'done');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));
  assert.match(await page.$eval('#whole-book-summary',node=>node.textContent),/sach-thu\.pdf · 26 trang · bìa: trang 1 · bản gốc lấy từ tài khoản/u);
  // Deleting the run's progress keeps every translation: its parts go back to the plain history list.
  if(!await page.$eval('#study-history',node=>node.open))await page.click('#study-history > summary');
  await page.click('#study-books-list [data-book-delete]');await page.waitForSelector('#book-dialog[open]');
  assert.match(await page.$eval('#book-dialog-body',node=>node.textContent),/Các phần đã dịch vẫn nằm trong Lịch sử dịch và Thư viện riêng/u);
  await page.click('#book-dialog-submit');await page.waitForFunction(()=>document.querySelector('#progress').textContent==='Đã xóa tiến độ dịch cả quyển.');
  assert.equal(fake.state.jobs.length,0);assert.equal(fake.state.history.size,2);
  assert.equal(await page.$$eval('#study-history-list .history-card',cards=>cards.length),2);assert.equal(await page.$$eval('#study-books-list .book-job',rows=>rows.length),0);
  assert.deepEqual(fake.state.failures,undefined);assert.deepEqual(errors,[]);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a Cách dịch chosen while the book waits is saved with it; after a reload the chunk begun before goes on in it too, shown in the field',{skip,timeout:240000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let dayQuota=true;const seen=[];
 let {context,page,errors}=await openStudy(base);
 // Each translation call: its first block, the mode it is sent in and what the field shows meanwhile. The key's day quota
 // stops the first run at its first translation, inside chunk 1.
 fake.state.translateHook=async input=>{seen.push([input.blocks[0].id,input.mode,await page.inputValue('#mode')]);return dayQuota?[429,{error:'Gemini báo khóa này đã dùng hết hạn mức trong ngày.',code:'quota_day',retryAfter:null}]:null;};
 try{
  await pickBook(page,pdf);await page.selectOption('#mode','premium');await page.fill('#content-title','Sách đổi cách dịch');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/hết hạn mức trong ngày/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.mode,'premium');assert.equal(job.status,'paused');
  // The book waits: Tiết kiệm chosen now goes with the job at once, for this device after a reload and for any other.
  await page.selectOption('#mode','economy');
  await page.waitForFunction(()=>/^Đã lưu Cách dịch Tiết kiệm cho quyển này/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:30000});
  assert.equal(job.mode,'economy');assert.deepEqual(errors,[]);
  await context.close();({context,page,errors}=await openStudy(base));await page.waitForFunction(()=>document.querySelector('#study-history').open);
  await page.click('#study-books-list [data-book-resume]');await page.waitForFunction(()=>/Dán khóa Gemini rồi bấm Tiếp tục dịch cả quyển/u.test(document.querySelector('#progress').textContent),null,{timeout:30000});
  assert.equal(await page.inputValue('#mode'),'economy','the book comes back in the mode saved with it');
  dayQuota=false;await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  // Chunk 1 was begun (extracted and read) in Kỹ nhất: what is left of it is translated in Tiết kiệm, as promised, in one
  // call of that mode's batch rather than two of Kỹ nhất's, and saved in it; chunk 2 is extracted and translated in
  // Tiết kiệm too. The field shows it throughout.
  assert.deepEqual(fake.state.chunks.map(chunk=>chunk.mode),['premium','economy']);
  assert.deepEqual(seen,[['p2-b1','premium','premium'],['p2-b1','economy','economy'],['p22-b1','economy','economy']]);
  assert.equal([...fake.state.history.values()].find(entry=>entry.row.page_start===2).row.mode,'economy');
  assert.equal(await page.inputValue('#mode'),'economy');assert.equal(job.mode,'economy');assert.equal(job.status,'done');
  // A mode the server cannot keep (another device runs the book now) is said to apply only to a run started here.
  Object.assign(job,{runnerId:'other-device-0000-4000-8000-000000000009',leaseUntil:Date.now()+600000});
  await page.selectOption('#mode','quality');
  await page.waitForFunction(()=>/^Chưa lưu được Cách dịch Kỹ hơn cho quyển này: Quyển này đang được dịch ở một thiết bị khác/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:30000});
  assert.match(await statusText(page),/Cách dịch này chỉ áp dụng cho lượt dịch bạn bắt đầu ở đây; quyển vẫn giữ Cách dịch Tiết kiệm\.$/u);assert.equal(job.mode,'economy');
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: Cách dịch stepped through with the arrow keys while the book waits is saved one change at a time and ends on the last one chosen; Tiếp tục in the same tab goes on in it',{skip,timeout:240000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let dayQuota=true;const seen=[];
 const {context,page,errors}=await openStudy(base);
 fake.state.translateHook=async input=>{seen.push([input.blocks[0].id,input.mode]);return dayQuota?[429,{error:'Gemini báo khóa này đã dùng hết hạn mức trong ngày.',code:'quota_day',retryAfter:null}]:null;};
 try{
  await pickBook(page,pdf);await page.selectOption('#mode','economy');await page.fill('#content-title','Sách đổi cách dịch bằng phím');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/hết hạn mức trong ngày/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.mode,'economy');
  // Each arrow key on the closed field is a change (Edge and Chrome on Windows), and the first save is slow to arrive:
  // the later ones wait for it and send the field as it is by then, so none lands after the student's last choice.
  fake.state.modeDelay=n=>n===1?1500:0;
  await page.focus('#mode');for(let step=0;step<3;step++){await page.keyboard.press('ArrowDown');await page.waitForTimeout(150);}
  assert.equal(await page.inputValue('#mode'),'premium');
  for(let waited=0;waited<100&&!(fake.state.modeSaves?.length&&fake.state.modeSaves.every(save=>save.answered));waited++)await page.waitForTimeout(100);
  await page.waitForTimeout(300);const saves=fake.state.modeSaves;
  assert.ok(saves.every((save,index)=>save.answered&&(!index||save.sent>=saves[index-1].answered)),`one save at a time: ${JSON.stringify(saves)}`);
  assert.equal(saves.at(-1).mode,'premium');assert.equal(job.mode,'premium');
  await page.waitForFunction(()=>/^Đã lưu Cách dịch Kỹ nhất cho quyển này/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:10000});
  // Tiếp tục in this tab: what is left of chunk 1, begun in Tiết kiệm, is translated in Kỹ nhất (two calls of its batch),
  // and chunk 2 is extracted and translated in it.
  dayQuota=false;await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  assert.deepEqual(fake.state.chunks.map(chunk=>chunk.mode),['economy','premium']);
  assert.deepEqual(seen,[['p2-b1','economy'],['p2-b1','premium'],['p19-b1','premium'],['p22-b1','premium']]);
  assert.equal(await page.inputValue('#mode'),'premium');assert.equal(job.mode,'premium');assert.equal(job.status,'done');
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a chosen page range, and "Dừng sau trang hiện tại" stops at a page boundary; Tiếp tục goes on in the same tab',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri({blocksPerPage:2,blockChars:2600}),base=await fake.listen(),pdf=await bookPdf();let release;fake.state.translateGate=new Promise(resolve=>{release=resolve;});
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#book-pages','2-8');
  assert.match(await page.$eval('#whole-book-note',node=>node.textContent),/bỏ qua 18 trang/u);
  // Kỹ nhất: its long blocks still go one per call (each is longer than its calls take).
  await page.selectOption('#mode','premium');await page.fill('#content-title','Sách dừng giữa chừng');await page.fill('#api-key',KEY);await page.click('#translate');
  while(fake.state.translateCalls<1)await new Promise(resolve=>setTimeout(resolve,50));
  // Stop while page 2's first block is with Gemini: its second block is still translated, page 3 is not started.
  await page.click('#stop');fake.state.translateGate=null;release();
  await page.waitForFunction(()=>/Đã dừng theo yêu cầu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:60000});
  assert.deepEqual(fake.state.translations.map(input=>input.blocks.map(block=>block.id).join()),['p2-b1','p2-b2']);
  const [job]=fake.state.jobs;assert.equal(job.status,'paused');assert.equal(job.pauseReason,'stopped');assert.equal(job.pageStates,'c'+'.'.repeat(7)+'s'.repeat(18));
  assert.equal(await page.$eval('#translate',node=>node.textContent.trim()),'Tiếp tục dịch cả quyển →');
  await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  // The same chunk went on: one extraction, one session, every block sent to Gemini exactly once.
  assert.equal(fake.state.chunks.length,1);assert.equal(fake.state.chunks[0].count,7);assert.equal(fake.state.history.size,1);
  const sent=fake.state.translations.flatMap(input=>input.blocks.map(block=>block.id));assert.equal(sent.length,12);assert.equal(new Set(sent).size,12);
  assert.equal(job.mode,'premium');assert.deepEqual(fake.state.chunks.map(chunk=>chunk.mode),['premium']);assert.ok(fake.state.translations.every(input=>input.mode==='premium'));
  assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(8-BLANK)+'s'.repeat(TOTAL-8));
  assert.equal(await page.$eval('#whole-book-count',node=>node.textContent),'Đã dịch 6/6 trang');
  // The offline dictionary (no Gemini, no /api) looks up the Chinese source of the chunk.
  const calls=fake.state.log.length;assert.equal(await page.$eval('#source-lookup',node=>node.disabled),false);
  await page.click('#source-lookup');await page.waitForSelector('#hanzi-panel:not([hidden])');assert.equal(fake.state.log.length,calls);
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: the pages chosen for a run survive a reload; Tiếp tục from the history never brings back the pages left out',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let dayQuota=true;
 fake.state.translateHook=()=>dayQuota?[429,{error:'Gemini báo khóa này đã dùng hết hạn mức trong ngày.',code:'quota_day',retryAfter:null}]:null;
 let {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#book-pages','2-8');await page.fill('#content-title','Sách chọn trang');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/hết hạn mức trong ngày/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.pageStates,'c'+'.'.repeat(7)+'s'.repeat(TOTAL-8));
  // Reload: the key, the picked file and the typed range are gone; the run continues from the history.
  await context.close();({context,page,errors}=await openStudy(base));await page.waitForFunction(()=>document.querySelector('#study-history').open);
  dayQuota=false;await page.fill('#api-key',KEY);await page.click('#study-books-list [data-book-resume]');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  // Pages 9-26 stay left out: nothing past page 8 was extracted, translated or paid for.
  assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(8-BLANK)+'s'.repeat(TOTAL-8));
  assert.deepEqual(fake.state.chunks.map(({offset,count})=>[offset,count]),[[1,7]]);
  assert.ok(fake.state.translations.flatMap(input=>input.blocks.map(block=>Number(/^p(\d+)-/u.exec(block.id)[1]))).every(number=>number>=2&&number<=8));
  // The page field names the pages the run translates; the panel counts only those.
  assert.equal(await page.$eval('#book-pages',node=>node.value),'2-8');assert.equal(await page.$eval('#whole-book-count',node=>node.textContent),'Đã dịch 6/6 trang');
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a second device never runs the book another device is translating; it can wait, and then finds the book done',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let release;fake.state.translateGate=new Promise(resolve=>{release=resolve;});
 const laptop=await openStudy(base);let phone=null;
 try{
  await pickBook(laptop.page,pdf);await laptop.page.fill('#content-title','Sách hai thiết bị');await laptop.page.fill('#api-key',KEY);await laptop.page.click('#translate');
  while(fake.state.translateCalls<1)await new Promise(resolve=>setTimeout(resolve,50));
  // The phone is another browser (its own storage, so its own run id); it opens the history while the laptop translates.
  phone=await openStudy(base);const [job]=fake.state.jobs,holder=job.runnerId;assert.ok(holder);
  await phone.page.waitForFunction(()=>document.querySelector('#study-history').open);
  assert.match(await phone.page.$eval('#study-books-list .book-job',node=>node.textContent),/Đang dịch ở thiết bị khác/u);
  const spent=()=>({chunks:fake.state.chunks.length,translations:fake.state.translateCalls,downloads:fake.state.log.filter(line=>line==='GET /api/my/study/sources/<sha>').length}),before=spent();
  await phone.page.fill('#api-key',KEY);await phone.page.click('#study-books-list [data-book-resume]');
  await phone.page.waitForFunction(()=>/^Quyển này đang được dịch ở một thiết bị khác/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:60000});
  assert.match(await phone.page.$eval('#progress',node=>node.textContent),/Bấm Chờ rồi dịch tiếp/u);
  assert.equal(await phone.page.$eval('#translate',node=>node.textContent.trim()),'Chờ rồi dịch tiếp →');
  // Nothing was downloaded, extracted or translated by the phone, and the book is still the laptop's.
  assert.deepEqual(spent(),before);assert.equal(job.runnerId,holder);assert.equal(job.status,'running');
  // The phone waits; the laptop finishes the book; the phone then finds nothing left and spends nothing.
  await phone.page.click('#translate');
  await phone.page.waitForFunction(()=>/Đang chờ thiết bị đó dừng/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:30000});
  fake.state.translateGate=null;release();
  await laptop.page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  await phone.page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:60000});
  assert.deepEqual(spent(),{chunks:2,translations:2,downloads:0});assert.equal(fake.state.history.size,2);
  assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));assert.equal(job.status,'done');assert.equal(job.usage.total,1500+867*2);
  assert.deepEqual([...fake.state.runners],[holder],'every report came from the laptop');
  assert.deepEqual(laptop.errors,[]);assert.deepEqual(phone.errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await laptop.context.close();await phone?.context.close();await fake.close();}
});

test('Dịch cả quyển: a tab opened before the chunk was saved, with over 100 newer sessions since, continues the paused chunk from the server by its id; nothing is extracted or paid twice',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri({blocksPerPage:2,blockChars:2600}),base=await fake.listen(),pdf=await bookPdf();let dayQuota=true;
 // Chunk 1 (pages 2–21): page 2's two blocks are translated, then the key's day quota stops the run inside the chunk.
 fake.state.translateHook=(input,call)=>dayQuota&&call===3?[429,{error:'Gemini báo khóa này đã dùng hết hạn mức trong ngày.',code:'quota_day',retryAfter:null}]:null;
 // This tab opens now, before the book is started anywhere, and keeps the history list it loaded.
 const stale=await openStudy(base),other=await openStudy(base);
 try{
  await pickBook(other.page,pdf);await other.page.fill('#content-title','Sách hai thẻ');await other.page.fill('#api-key',KEY);await other.page.click('#translate');
  await other.page.waitForFunction(()=>/hết hạn mức trong ngày/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs,[paused]=[...fake.state.history.values()];assert.equal(job.status,'paused');assert.equal(paused.state.done,2);assert.equal(fake.state.chunks.length,1);
  // 101 sessions of other documents are saved after it: the newest 100 the history lists no longer hold the paused chunk.
  for(let i=0;i<101;i++){const id=`9a0b1c2d-3e4f-4a5b-8c6d-${String(i).padStart(12,'0')}`;fake.state.history.set(id,{row:{id,title:`Bài khác ${i+1}`,filename:'khac.txt',domain:'general',mode:'economy',status:'complete',translated_parts:1,total_parts:1,library_story_id:null,library_chapter_id:null,page_start:null,page_end:null,source_total_pages:null,source_sha256:null,created_at:'2099-01-01 00:00:00',updated_at:`2099-01-01 0${Math.floor(i/60)}:${String(i%60).padStart(2,'0')}:00`,revision:1},state:{}});}
  await other.context.close();
  // The old tab picks the same file: the run goes on in the paused chunk instead of extracting it again.
  dayQuota=false;await pickBook(stale.page,pdf,{resume:true});await stale.page.fill('#api-key',KEY);
  await stale.page.waitForFunction(()=>document.querySelector('#translate').textContent.trim()==='Tiếp tục dịch cả quyển →');await stale.page.click('#translate');
  await stale.page.waitForFunction(()=>/Đã dịch xong cả quyển/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  assert.equal(fake.state.chunks.length,2,'chunk 1 extracted once, chunk 2 once');
  const paid=fake.state.translations.flatMap(input=>input.blocks.map(block=>block.id));
  assert.equal(paid.filter(id=>id==='p2-b1').length,1,'the blocks translated before the pause are not paid again');assert.equal(paid.filter(id=>id==='p2-b2').length,1);
  assert.equal(job.status,'done');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));
  assert.equal([...fake.state.history.values()].filter(entry=>entry.row.source_sha256===job.sourceSha256).length,2,'one session per chunk');
  assert.deepEqual(stale.errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await stale.context.close();await fake.close();}
});

test('Dịch cả quyển: a block Gemini will not translate is asked for once more before its chunk is exported, then keeps its Chinese with a note that stays, counted in the chunk\'s and the book\'s Cần xem lại; the book goes on and is finished',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();
 const REFUSED='Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền.';
 fake.state.translateHook=input=>{
  if(!input.blocks.some(block=>block.id==='p5-b1'))return null;
  if(!input.partial)return [400,{error:REFUSED,code:'gemini_refused'}];
  return [200,{blocks:input.blocks.filter(block=>block.id!=='p5-b1').map(block=>({id:block.id,translation:`Bản dịch ${block.id}.`})),failedBlocks:[{id:'p5-b1',code:'gemini_refused',message:REFUSED}],context:'',glossary:{},usage:{prompt:900,output:300,thinking:0,total:1200,requests:2},warnings:[],model:'gemini-2.5-flash-lite'}];
 };
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách có đoạn bị từ chối');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển|Tạm dừng|Tiến độ đã lưu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.status,'done');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));
  const chunk=[...fake.state.history.values()].find(entry=>entry.row.page_start===2),index=chunk.state.parts.findIndex(text=>text.startsWith('第5页'));
  assert.equal(chunk.state.translationParts[index],chunk.state.parts[index],'the refused block keeps its Chinese, so the part is complete and exported');assert.equal(chunk.row.status,'complete');
  // Asked for once more on its own before the chunk was exported, and never again.
  assert.deepEqual(fake.state.translations.filter(input=>input.blocks.some(block=>block.id==='p5-b1')).map(input=>input.blocks.length>1),[true,false]);
  // The note is kept past the chunk, once: it is still there once the book is finished, with the chunk's count.
  const warnings=await page.$eval('#warnings',node=>node.textContent);
  assert.equal(warnings.match(/Trang 5 · đoạn 1: giữ nguyên chữ gốc\. Gemini không trả kết quả vì đoạn này trùng khớp nguyên văn với nội dung có bản quyền\. Có thể dịch tay đoạn này trong “Chỉnh bản dịch từng đoạn”\./gu)?.length,1,warnings);
  assert.match(warnings,/Trang 2–\d+: cần xem lại 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được/u);
  assert.match(await statusText(page),/^Đã dịch xong cả quyển: [^;]*; cần xem lại 1 đoạn giữ nguyên chữ gốc vì Gemini không dịch được \(chi tiết trong phần cảnh báo\)\./u);
  assert.equal(fake.state.renders,2);assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a scanned block Gemini could not read keeps its machine text after one more reading, is never read again, and its note stays to the end of the book',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();fake.state.ocrKept={'p3-b1':'refused'};
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách có trang scan khó đọc');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển|Tạm dừng|Tiến độ đã lưu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.status,'done');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));
  assert.equal(fake.state.ocrSlim.length,2,'the scanned page is read, and the block it could not read once more');
  const chunk=[...fake.state.history.values()].find(entry=>entry.row.page_start===2);assert.ok(chunk.state.parts.includes(`第${SCANNED}页（扫描）第1段`),'its machine text is translated');
  // The note is kept past the chunk: it is still there once the book is finished.
  assert.match(await page.$eval('#warnings',node=>node.textContent),/Trang 3 · đoạn 1: Gemini không trả bản đọc vì trùng khớp nguyên văn với nội dung có bản quyền\. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc\./u);
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a chunk whose export finds translations longer than their boxes gets a short note naming them; the book goes on, is finished, and is not called downloadable until that part has its PDF, also after a reload',{skip,timeout:240000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();let refused=0;
 // Gemini's translation of page 5's block is far longer than its box; the first chunk's export finds it so, as the Worker
 // answers it (backend/pdf-layout.js).
 // Long enough not to fit even grown over the blank page around it at the smallest size.
 const LONG='Bản dịch rất dài của đoạn này, dài hơn khung chữ của nó rất nhiều. '.repeat(250);
 fake.state.translateHook=input=>input.blocks.some(block=>block.id==='p5-b1')?[200,{blocks:input.blocks.map(block=>({id:block.id,translation:block.id==='p5-b1'?LONG:`Bản dịch ${block.id}.`})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:267,thinking:0,total:867,requests:1},warnings:[],model:'gemini-2.5-flash-lite'}]:null;
 fake.state.renderHook=(input,document)=>{
  if(refused++)return null;const page=document.pages.find(entry=>entry.number===5),entries=[{page:5,id:'p5-b1',label:blockLabel(page,'p5-b1')}];
  const failure=serviceFailure(422,{error:overflowMessage(entries),code:'overflow',blocks:entries.map(({page,id})=>({page,id}))});return [failure.status,{error:failure.message,code:failure.code,blocks:failure.blocks}];
 };
 let {context,page,errors}=await openStudy(base);
 const MISSING='Trang 2–21 chưa có PDF tiếng Việt, nên “Tải cả quyển (PDF)” còn giữ các trang đó như bản gốc. Mở phần đó trong Sách của tôi (Lịch sử dịch) để xem cần sửa gì, rồi bấm Xuất PDF tiếng Việt; không tốn token.';
 const bookRow=()=>page.$eval('#study-books-list .book-job',node=>node.textContent);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách có đoạn dài');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển|Tạm dừng|Tiến độ đã lưu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.status,'done');assert.equal(job.pageStates,'c'+'d'.repeat(BLANK-2)+'b'+'d'.repeat(TOTAL-BLANK));assert.equal(fake.state.renders,1,'the second chunk is exported');
  const warnings=await page.$eval('#warnings',node=>node.textContent);
  assert.match(warnings,/^Trang 2–21: chưa xuất được PDF tiếng Việt vì bản dịch của Trang 5 · đoạn 1 dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức\. Mở phần này trong Lịch sử dịch, viết ngắn lại đoạn đó trong “Chỉnh bản dịch từng đoạn”, bấm “Lưu đoạn đã sửa” rồi bấm Xuất PDF tiếng Việt; không tốn token\.$/mu);
  assert.doesNotMatch(warnings,/Ở phần “Đối chiếu kết quả”/u,'the service\'s long advice is for an open part, not for a note in the middle of a book');
  // Finished, but not ready to download: the part without its PDF is named, in the message, the book's row and the grid.
  assert.equal(await statusText(page),`Đã dịch xong cả quyển: 24/24 trang. ${MISSING}`);assert.equal(await page.textContent('#progress'),`Đã dịch xong cả quyển: 24/24 trang. ${MISSING}`);
  assert.match(await bookRow(),/Dịch cả quyển · Đã dịch 24\/24 trang · Còn phần chưa có PDF tiếng Việt/u);
  assert.equal(await page.$eval('#study-books-list .book-job-parts',node=>node.open),true,'the parts open by themselves');
  assert.deepEqual(await page.$$eval('#study-books-list .book-job-parts [data-history-open]',buttons=>buttons.map(button=>button.textContent)),['Trang 2–21 · Hoàn tất · chưa có PDF tiếng Việt','Trang 22–26 · Hoàn tất']);
  assert.equal(await page.$$eval('#page-grid .page-cell',cells=>cells.map(cell=>cell.dataset.state[0]).join('')),'c'+'n'.repeat(BLANK-2)+'b'+'n'.repeat(21-BLANK)+'d'.repeat(TOTAL-21));
  assert.equal(await page.$eval('.page-legend [data-state="nopdf"]',node=>node.hidden),false);
  assert.deepEqual(errors,[]);
  // A reload knows it too, from the account: the history opens on it, and the part opened marks the block too long.
  await context.close();({context,page,errors}=await openStudy(base));
  await page.waitForFunction(()=>document.querySelector('#study-history').open);
  assert.match(await bookRow(),/Còn phần chưa có PDF tiếng Việt/u);
  await page.click('#study-books-list .book-job-parts [data-history-open]');
  await page.waitForFunction(()=>/^Phần này chưa có PDF tiếng Việt vì bản dịch của Trang 5 · đoạn 1 dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức\./u.test(document.querySelector('#progress').textContent),null,{timeout:60000});
  await page.waitForFunction(()=>!document.querySelector('#translate').disabled,null,{timeout:60000});
  const viewer=await page.evaluate(()=>{const root=document.querySelector('#pdf-dual-viewer');return {page:root.querySelector('[data-pdf-page]').textContent,open:root.querySelector('.pdf-block-editor').open,block:root.querySelector('[data-pdf-edit-select]').value,outlined:[...root.querySelectorAll('.is-overflow')].map(node=>node.dataset.blockId)};});
  assert.deepEqual(viewer,{page:'Trang 5 · 4/20',open:true,block:'p5-b1',outlined:['p5-b1']});assert.equal(fake.state.renders,1,'opening the part asks nothing of the PDF service');
  // Shortened, saved and exported: the book is complete again.
  await page.fill('[data-pdf-edit-text]','Bản dịch ngắn.');await page.click('[data-pdf-edit-save]');await page.waitForFunction(()=>/^Đã lưu đoạn sửa\./u.test(document.querySelector('#progress').textContent));
  const download=page.waitForEvent('download');await page.click('#download-pdf');const file=await download;assert.ok(await file.path());
  await page.waitForFunction(()=>/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u.test(document.querySelector('#progress').textContent),null,{timeout:60000});
  await page.waitForFunction(()=>/Dịch cả quyển · Đã dịch 24\/24 trang · Hoàn tất/u.test(document.querySelector('#study-books-list .book-job').textContent),null,{timeout:30000});
  assert.equal(fake.state.renders,2);assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a book of one part whose export is refused is finished, but never called ready to read or download as a PDF, nor pointed to a download it does not have',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();
 // Every export of the part is refused: page 5's block is longer than its box.
 fake.state.renderHook=(input,document)=>{const page=document.pages.find(entry=>entry.number===5),entries=[{page:5,id:'p5-b1',label:blockLabel(page,'p5-b1')}];const failure=serviceFailure(422,{error:overflowMessage(entries),code:'overflow',blocks:entries.map(({page,id})=>({page,id}))});return [failure.status,{error:failure.message,code:failure.code,blocks:failure.blocks}];};
 // The reader offers “Tải cả quyển (PDF)” only beside a part that has its PDF (frontend/app.js wholeBookPdf): this book
 // has none, so it is not named.
 const MISSING='Trang 2–6 chưa có PDF tiếng Việt, nên chưa tải được cả quyển dạng PDF; bản dịch dạng chữ vẫn đọc được trong Thư viện riêng. Mở phần đó trong Sách của tôi (Lịch sử dịch) để xem cần sửa gì, rồi bấm Xuất PDF tiếng Việt; không tốn token.';
 let {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#book-pages','2-6');await page.fill('#content-title','Sách một phần');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển|Tạm dừng|Tiến độ đã lưu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  const [job]=fake.state.jobs;assert.equal(job.status,'done');assert.equal(fake.state.renders||0,0);
  assert.deepEqual(fake.state.books.map(book=>book.parts.map(part=>part.mime)),[['text/plain']]);
  assert.equal(await statusText(page),`Đã dịch xong cả quyển: 5/5 trang. ${MISSING}`);
  assert.match(await page.$eval('#study-books-list .book-job',node=>node.textContent),/Đã dịch 5\/5 trang · Còn phần chưa có PDF tiếng Việt/u);
  assert.deepEqual(errors,[]);
  // The same file picked again, in another tab: the finished run it binds says the same.
  await context.close();({context,page,errors}=await openStudy(base));
  await pickBook(page,pdf,{resume:true});await page.waitForFunction(()=>/^Quyển này đã dịch xong\./u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:30000});
  assert.equal(await statusText(page),`Quyển này đã dịch xong. ${MISSING}`);
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a save the server refuses pauses the book with the server\'s own words and the book\'s instruction, not a range run\'s sentence',{skip,timeout:180000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();
 const FULL='Lịch sử dịch của tài khoản đã dùng 500 MB, mức tối đa cho mỗi tài khoản. Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.';
 // The chunk's first save goes through; the save before its first Gemini call is refused for want of room.
 fake.state.saveHook=id=>id?[413,{error:FULL,code:'history_full'}]:null;
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách hết chỗ');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(()=>/Tiến độ của quyển đã lưu/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:120000});
  assert.equal(await statusText(page),`${FULL} Tiến độ của quyển đã lưu; dọn bớt xong, bấm Tiếp tục dịch cả quyển.`);
  const [job]=fake.state.jobs;assert.equal(job.status,'paused');assert.equal(job.pauseReason,'history_full');assert.equal(fake.state.translateCalls,0,'nothing is sent to Gemini that could not be saved');
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});

test('Dịch cả quyển: a save refused after Gemini translated part of a chunk says that part is only in this tab (do not close it), never that the progress is saved; going on in that tab pays for nothing twice',{skip,timeout:240000},async()=>{
 const fake=fakeHoaTri(),base=await fake.listen(),pdf=await bookPdf();
 const FULL='Lịch sử dịch của tài khoản đã dùng 500 MB, mức tối đa cho mỗi tài khoản. Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.';
 // The chunk's first saves go through; the one that keeps Gemini's first batch is refused for want of room.
 fake.state.saveHook=(id,body)=>id&&body.state.translationParts.some(text=>text?.trim())?[413,{error:FULL,code:'history_full'}]:null;
 const sent=id=>fake.state.translations.reduce((count,input)=>count+input.blocks.filter(block=>block.id===id).length,0);
 const {context,page,errors}=await openStudy(base);
 try{
  await pickBook(page,pdf);await page.fill('#content-title','Sách hết chỗ');await page.fill('#api-key',KEY);await page.click('#translate');
  await page.waitForFunction(full=>document.querySelector('#whole-book-status').textContent.startsWith(full),FULL,{timeout:120000});
  const PAUSE=`${FULL} Phần đã dịch vẫn hiện trong tab này: đừng đóng tab. Các trang đã xong trước đó đã lưu; dọn bớt xong, bấm Tiếp tục dịch cả quyển ở tab này.`;
  assert.equal(await statusText(page),PAUSE);assert.equal(await page.textContent('#progress'),PAUSE);
  const [job]=fake.state.jobs;assert.equal(job.status,'paused');assert.equal(job.pauseReason,'history_full');assert.equal(fake.state.translateCalls,1);assert.equal(sent('p2-b1'),1);
  // Room made, the same tab goes on: the chunk it holds is saved first, so no block is sent to Gemini again.
  fake.state.saveHook=null;
  await page.waitForFunction(()=>/Tiếp tục dịch cả quyển/u.test(document.querySelector('#translate').textContent)&&!document.querySelector('#translate').disabled,null,{timeout:30000});
  await page.click('#translate');
  await page.waitForFunction(()=>/Đã dịch xong cả quyển|Tạm dừng/u.test(document.querySelector('#whole-book-status').textContent),null,{timeout:180000});
  assert.match(await statusText(page),/^Đã dịch xong cả quyển: 24\/24 trang\./u);
  assert.deepEqual([sent('p2-b1'),sent('p21-b1'),sent('p22-b1')],[1,1,1],'each block is paid for once');
  assert.deepEqual(errors,[]);assert.deepEqual(fake.state.failures,undefined);
 }finally{await context.close();await fake.close();}
});
});
