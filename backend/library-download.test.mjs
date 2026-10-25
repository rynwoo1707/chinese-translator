import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import worker from './worker.js';
import * as assembly from '../frontend/book-assembly.js';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// "Tải cả quyển" of a public library book, end to end: the real Worker on node:sqlite (every migration) with an
// in-memory R2, and app.js as a reader's browser runs it (pdf-lib, pdf.js and book-assembly.js as the page loads them).
const PDFLib=createRequire(import.meta.url)('@cantoo/pdf-lib');
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
class D1Statement{constructor(db,sql){this.statement=db.prepare(sql);this.args=[];}bind(...args){this.args=args;return this;}async first(){return this.statement.get(...this.args)||null;}async all(){return {results:this.statement.all(...this.args),success:true};}execute(){return {success:true,meta:{changes:this.statement.run(...this.args).changes}};}async run(){return this.execute();}}
class D1Database{constructor(db){this.db=db;}prepare(sql){return new D1Statement(this.db,sql);}async batch(statements){this.db.exec('BEGIN');try{const r=statements.map(s=>s.execute());this.db.exec('COMMIT');return r;}catch(error){this.db.exec('ROLLBACK');throw error;}}}
class MemoryR2{
 constructor(){this.values=new Map();}
 async put(key,value,options={}){const bytes=value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice():new Uint8Array(await new Response(value).arrayBuffer());if(options.sha256&&hex(bytes)!==options.sha256)throw new Error('checksum (10037)');this.values.set(key,{bytes,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});}
 async get(key,{range}={}){const item=this.values.get(key);if(!item)return null;let bytes=item.bytes;if(range){const start=range.offset??0;bytes=bytes.slice(start,range.length?start+range.length:undefined);}return {body:bytes,size:item.bytes.length,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,arrayBuffer:async()=>bytes.slice().buffer};}
 async head(key){const item=this.values.get(key);return item?{size:item.bytes.length,customMetadata:item.customMetadata}:null;}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix=''}={}){return {objects:[...this.values.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key,customMetadata:this.values.get(key).customMetadata})),truncated:false};}
}
const ADMIN='admin-token-for-library-download-tests-01',ORIGIN='https://school.test';
async function pdf(lines){const doc=await PDFLib.PDFDocument.create(),font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);for(const line of lines)doc.addPage([595,842]).drawText(line,{x:60,y:700,size:20,font});return new Uint8Array(await doc.save());}
async function texts(bytes){const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0,isEvalSupported:false}).promise;try{const out=[];for(let n=1;n<=doc.numPages;n++)out.push((await (await doc.getPage(n)).getTextContent()).items.map(item=>item.str).join(''));return {texts:out,labels:await doc.getPageLabels()};}finally{await doc.loadingTask.destroy();}}

// A public book as an admin makes it: an original kept as an excerpt (the cover and book pages 7-9), one part on its
// pages, one finished Vietnamese PDF uploaded with "Tải bản đã dịch lên" (no page mapping) and one text part.
async function book(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const dir=new URL('../database/migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
 const env={DB:new D1Database(sqlite),FILES:new MemoryR2(),ADMIN_TOKEN:ADMIN};
 const call=(path,{method='GET',body,headers={}}={})=>worker.fetch(new Request(ORIGIN+path,{method,body,headers:{Authorization:`Bearer ${ADMIN}`,...headers,...(typeof body==='string'?{'Content-Type':'application/json'}:{})}}),env,{});
 const id=(await (await call('/api/stories',{method:'POST',body:JSON.stringify({title:'Sách thư viện',genre:'Giáo dục',visibility:'public'})})).json()).id;
 const original=await pdf(['Original 1','Original 7','Original 8','Original 9']),sha256=hex(original);
 assert.equal((await call(`/api/stories/${id}/sources/${sha256}`,{method:'PUT',body:original,headers:{'Content-Type':'application/pdf','X-PDF-Pages':'4','X-Source-Filename':'goc.pdf','X-Book-Pages':'1,7-9','Content-Length':String(original.length)}})).status,201);
 const part=async(title,file,name,fields={})=>{const form=new FormData();form.set('confirmed','true');form.set('title',title);form.set('file',new File([file],name,{type:name.endsWith('.pdf')?'application/pdf':'text/plain'}));for(const [key,value] of Object.entries(fields))form.set(key,value);const response=await call(`/api/stories/${id}/chapters`,{method:'POST',body:form});assert.equal(response.status,201,title);};
 await part('Trang 7–8',await pdf(['Ban dich 7','Ban dich 8']),'c01.vi.pdf',{source_sha256:sha256,source_pages:'[2,3]',position:'1'});
 await part('Phụ lục (PDF)',await pdf(['Phu luc A','Phu luc B']),'phu-luc.pdf',{position:'2'});
 await part('Lời nói đầu',new TextEncoder().encode('Lời nói đầu của sách.'),'loi-noi-dau.txt',{position:'3'});
 return {env,id};
}
// app.js as the reader's page runs it: imports stripped and given, fetch to the Worker, the PDF it saves kept.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
async function reader(env,{fetch=null}={}){
 const saved=[],root={innerHTML:''};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},releaseBilingual(){},
  location:{pathname:'/',hash:'',search:''},document:{querySelector:selector=>selector==='#app'?root:null,querySelectorAll:()=>[],createElement:()=>({click(){},remove(){}}),body:{append(){}}},localStorage:{getItem:()=>null},window:{addEventListener(){}},
  URL:{createObjectURL:blob=>{saved.push(blob);return 'blob:hoatri';},revokeObjectURL(){}},Blob,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,clearInterval,FormData,console});
 context.fetch=fetch||((url,init={})=>worker.fetch(new Request(new URL(url,ORIGIN),{method:init.method||'GET',headers:init.headers,body:init.body}),env,{}));
 vm.runInContext(source,context);
 const run=code=>vm.runInContext(code,context);run('loadBookLibraries=()=>Promise.resolve(libraries)');
 context.libraries={PDFLib,pdfjs,assembly,covers:{detectCoverInBytes:async()=>({})}};
 await new Promise(done=>setTimeout(done,20));
 return {run,saved};
}

test('"Tải cả quyển" of a public book joins a PDF part without page numbers after the original, and names what is left out in library words',async t=>{
 const {env,id}=await book(t),{run,saved}=await reader(env);
 const library=await (await worker.fetch(new Request(`${ORIGIN}/api/library`),env,{})).json(),row=library.find(item=>item.id===id),chapters=await (await worker.fetch(new Request(`${ORIGIN}/api/read/${id}`),env,{})).json();
 assert.equal(row.mapped_parts,1);
 run(`state.route='reader';state.chapters=${JSON.stringify(chapters)};state.chapter=0;state.readerStory={id:${JSON.stringify(id)},title:'Sách thư viện',cover:false,study:false,sample:false,mappedParts:1,assembly:true};state.bookDownload=null`);
 assert.equal(run('wholeBookPdf()'),true);
 await run('downloadWholeBook()');
 const result=run('state.bookDownload');
 assert.equal(saved.length,1,result.message);
 const file=await texts(await saved[0].arrayBuffer());
 // The original rebuilt (cover and untranslated pages as printed, translations in place), then the unmapped part.
 assert.deepEqual(file.texts,['Original 1','Ban dich 7','Ban dich 8','Original 9','Phu luc A','Phu luc B']);
 assert.match(result.message,/^Đã ghép 6 trang như bản gốc\. Đã dịch 2\/4 trang; các trang còn lại giữ nguyên bản gốc\.$/u);
 assert.deepEqual([...result.notes],[
  'PDF gốc của sách này là bản trích đoạn, chỉ gồm trang 1, 7–9 của sách in.',
  'Phần “Phụ lục (PDF)” không rõ tệp gốc nên được đặt ở cuối sách.',
  'Phần “Lời nói đầu” là bản dịch dạng chữ, không có trang PDF, nên không có trong tệp ghép; phần này vẫn đọc được trong Thư viện.'
 ]);
 assert.doesNotMatch(result.notes.join(' '),/Xưởng dịch|Thư viện riêng/u,'a library reader is never sent to the workspace');
});

// A student's book from "Dịch cả quyển": cover 1, pages 2–3 and 5–6 translated, page 4 blank inside the one part 2–6.
// Xưởng dịch says "Đã dịch xong cả quyển: 4/4 trang"; the reader's download counts the same four pages.
test('"Tải cả quyển" of a whole-book run counts a blank page inside a part as kept, as Xưởng dịch counts it',async()=>{
 const original=await pdf(['Bia','Goc 2','Goc 3','Trang trong','Goc 5','Goc 6']),sha256=hex(original),rendered=await pdf(['Dich 2','Dich 3','Trang trong','Dich 5','Dich 6']);
 const part={id:'c1',title:'Trang 2–6',position:1,mime:'application/pdf',sessionId:'s1',filename:'sach.pdf',pageStart:2,pageEnd:6,totalPages:6,sha256,pages:[2,3,4,5,6],updatedAt:'2026-10-22 08:00:00',translatedAt:'2026-10-22 08:00:00',layout:true,file:'/api/chapter-file/c1'};
 const answers=(jobs)=>({'/api/my/study/books/book-1/assembly':{id:'book-1',title:'Sách học',cover:{image:false,page:0,sha256:null},parts:[part],storedSources:[{sha256,pages:6,url:`/api/my/study/sources/${sha256}`}]},...(jobs?{'/api/my/study/book-jobs':{jobs}}:{}),[`/api/my/study/sources/${sha256}`]:original,'/api/chapter-file/c1':rendered});
 const download=async served=>{
  const asked=[],fetch=async url=>{const path=new URL(url,ORIGIN).pathname,value=served[path];asked.push(path);return value===undefined?Response.json({error:'Không tìm thấy.'},{status:404}):value instanceof Uint8Array?new Response(value,{headers:{'Content-Type':'application/pdf'}}):Response.json(value);};
  const {run,saved}=await reader(null,{fetch});
  run(`state.route='reader';state.chapters=[{id:'c1',title:'Trang 2–6',mime:'application/pdf'}];state.chapter=0;state.readerStory={id:'book-1',title:'Sách học',cover:false,study:true,sample:false,assembly:false};state.bookDownload=null`);
  await run('downloadWholeBook()');return {result:run('state.bookDownload'),saved,asked};
 };
 const {result,saved,asked}=await download(answers([{id:'j1',storyId:'book-1',sourceSha256:sha256,pageStates:'cddbdd',status:'done'},{id:'j2',storyId:'book-2',sourceSha256:sha256,pageStates:'bbbbbb',status:'done'}]));
 assert.equal(saved.length,1,result.message);assert.deepEqual((await texts(await saved[0].arrayBuffer())).texts,['Bia','Dich 2','Dich 3','Trang trong','Dich 5','Dich 6']);
 assert.ok(asked.includes('/api/my/study/book-jobs'));
 assert.equal(result.message,'Đã ghép 6 trang như bản gốc. Đã dịch 4/6 trang; các trang còn lại giữ nguyên bản gốc.');
 // Without the run's page states (its progress deleted, or the list failed), each page of a part counts as before.
 const older=await download(answers(null));assert.equal(older.saved.length,1);assert.equal(older.result.message,'Đã ghép 6 trang như bản gốc. Đã dịch 5/6 trang; các trang còn lại giữ nguyên bản gốc.');
});
