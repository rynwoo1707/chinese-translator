import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import worker from './worker.js';
import {RANGE_OPTIONS,bilingualSource} from '../frontend/bilingual-reader.js';

// "Đọc song ngữ" over a real network: pdf.js (the version the reader vendors, which uses the same fetch stream in node)
// opens an original and a translated part served by the Worker's own routes through a local HTTP server on a free port.
// A whole-file answer goes out a piece at a time like over a slow line, so what a reader stops listening to is never
// sent. Nothing leaves this machine.
const PDFLib=createRequire(import.meta.url)('@cantoo/pdf-lib');
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');

class D1Statement{constructor(db,sql){this.statement=db.prepare(sql);this.args=[];}bind(...args){this.args=args;return this;}async first(){return this.statement.get(...this.args)||null;}async all(){return {results:this.statement.all(...this.args),success:true};}execute(){return {success:true,meta:{changes:this.statement.run(...this.args).changes}};}async run(){return this.execute();}}
class D1Database{constructor(db){this.db=db;}prepare(sql){return new D1Statement(this.db,sql);}async batch(statements){this.db.exec('BEGIN');try{const r=statements.map(s=>s.execute());this.db.exec('COMMIT');return r;}catch(error){this.db.exec('ROLLBACK');throw error;}}}
// R2 as the Worker sees it, ranged reads included.
class MemoryR2{
 constructor(){this.values=new Map();}
 async put(key,value,options={}){const bytes=value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice():new Uint8Array(await new Response(value).arrayBuffer());if(options.sha256&&hex(bytes)!==options.sha256)throw new Error('checksum (10037)');this.values.set(key,{bytes,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});}
 async get(key,{range}={}){
  const item=this.values.get(key);if(!item)return null;const size=item.bytes.length;let bytes=item.bytes;
  if(range){const start=range.suffix!==undefined?Math.max(0,size-range.suffix):range.offset??0,length=range.suffix!==undefined?Math.min(range.suffix,size):range.length??size-start;if(start>=size||length<=0)throw new Error('range not satisfiable (10039)');bytes=bytes.slice(start,start+length);}
  return {body:bytes,size,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,arrayBuffer:async()=>bytes.slice().buffer};
 }
 async head(key){const item=this.values.get(key);return item?{size:item.bytes.length,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata}:null;}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix=''}={}){return {objects:[...this.values].filter(([key])=>key.startsWith(prefix)).map(([key,item])=>({key,size:item.bytes.length,customMetadata:item.customMetadata})),truncated:false};}
}
const ADMIN='admin-token-for-bilingual-range-tests-0123',ORIGIN='https://school.test';

// Pages with a line of text each and 240 KB of incompressible data, so most of the file is not needed to show a page.
async function heavyPdf(label,count){
 const doc=await PDFLib.PDFDocument.create(),font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);
 for(let n=1;n<=count;n++){const page=doc.addPage([595,842]);page.drawText(`${label} ${n}`,{x:60,y:700,size:20,font});page.node.set(PDFLib.PDFName.of('Junk'),doc.context.register(doc.context.stream(randomBytes(240*1024),{})));}
 return new Uint8Array(await doc.save({useObjectStreams:false}));
}
async function library(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const dir=new URL('../database/migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
 const env={DB:new D1Database(sqlite),FILES:new MemoryR2(),ADMIN_TOKEN:ADMIN};
 const call=(path,{method='GET',body,headers={}}={})=>worker.fetch(new Request(ORIGIN+path,{method,body,headers:{Authorization:`Bearer ${ADMIN}`,...headers,...(typeof body==='string'?{'Content-Type':'application/json'}:{})}}),env,{});
 const id=(await (await call('/api/stories',{method:'POST',body:JSON.stringify({title:'Sách mẫu',genre:'Giáo dục',visibility:'private',sample:'sach-mau'})})).json()).id;
 const original=await heavyPdf('Original page',16),sha256=hex(original);
 assert.equal((await call(`/api/stories/${id}/sources/${sha256}`,{method:'PUT',body:original,headers:{'Content-Type':'application/pdf','X-PDF-Pages':'16','X-Source-Filename':'goc.pdf','X-Book-Pages':'1,7-21','Content-Length':String(original.length)}})).status,201);
 const translated=await heavyPdf('Ban dich trang',8),form=new FormData();
 form.set('confirmed','true');form.set('title','Trang 7–14');form.set('position','1');form.set('source_sha256',sha256);form.set('source_pages',JSON.stringify([2,3,4,5,6,7,8,9]));form.set('file',new File([translated],'c01.vi.pdf',{type:'application/pdf'}));
 const part=(await (await call(`/api/stories/${id}/chapters`,{method:'POST',body:form})).json()).id;
 assert.equal((await call(`/api/stories/${id}`,{method:'PATCH',body:JSON.stringify({visibility:'public'})})).status,200);
 return {env,id,part,sha256,original,translated};
}
// The Worker behind a local HTTP server: a ranged answer goes out at once, a whole file 64 KB at a time with a pause
// between pieces. idle() waits until every whole file has either been sent to its end or dropped by the reader, so what
// was sent does not depend on how fast this machine is.
async function serve(env){
 const sent=new Map();let streaming=0;
 const server=http.createServer(async(request,response)=>{
  const answer=await worker.fetch(new Request(ORIGIN+request.url,{headers:request.headers.range?{Range:request.headers.range}:{}}),env,{}),body=new Uint8Array(await answer.arrayBuffer());
  const headers=Object.fromEntries(answer.headers);headers['content-length']=String(body.length);response.writeHead(answer.status,headers);
  const count=bytes=>sent.set(request.url,(sent.get(request.url)||0)+bytes);
  if(answer.status!==200){count(body.length);response.end(body);return;}
  let done=false,offset=0;streaming++;const finish=()=>{if(!done){done=true;streaming--;}};response.on('close',finish);
  const pump=()=>{if(done)return;if(offset>=body.length){response.end();finish();return;}const piece=body.subarray(offset,offset+65536);offset+=piece.length;count(piece.length);response.write(piece);setTimeout(pump,5);};pump();
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const idle=async()=>{for(let waited=0;streaming&&waited<20000;waited+=25)await new Promise(done=>setTimeout(done,25));};
 return {url:path=>`http://127.0.0.1:${server.address().port}${path}`,sent:path=>sent.get(path)||0,idle,close:()=>{server.closeAllConnections();return new Promise(done=>server.close(done));}};
}
// Opens a file as the reader does, shows one page, waits for anything still arriving, and says what the server sent.
async function show(site,path,page){
 const task=pdfjs.getDocument({url:site.url(path),...RANGE_OPTIONS,isEvalSupported:false,verbosity:0}),doc=await task.promise;
 try{const text=(await (await doc.getPage(page)).getTextContent()).items.map(item=>item.str).join('');await site.idle();return {text,pages:doc.numPages,sent:site.sent(path)};}
 finally{await task.destroy();}
}

test('Đọc song ngữ: pdf.js fetches only the byte ranges of the page shown, from the original and from the translated part',async t=>{
 assert.deepEqual({...RANGE_OPTIONS},{disableAutoFetch:true,disableStream:true});
 const {env,id,part,sha256,original,translated}=await library(t),site=await serve(env);t.after(()=>site.close());
 const shown=await show(site,`/api/library/${id}/sources/${sha256}`,3);
 assert.deepEqual([shown.text,shown.pages],['Original page 3',16]);
 assert.ok(shown.sent<original.length*.5,`original: ${shown.sent} of ${original.length} bytes sent for one page`);
 const side=await show(site,`/api/chapter-file/${part}`,2);
 assert.deepEqual([side.text,side.pages],['Ban dich trang 2',8]);
 assert.ok(side.sent<translated.length*.5,`translated part: ${side.sent} of ${translated.length} bytes sent for one page`);
 t.diagnostic(`one page shown: original ${Math.round(shown.sent/original.length*100)}% of ${original.length} bytes, translated part ${Math.round(side.sent/translated.length*100)}% of ${translated.length} bytes`);
});

test('A translated part answers byte ranges like an original; a whole download is unchanged',async t=>{
 const {env,part,translated}=await library(t),get=headers=>worker.fetch(new Request(`${ORIGIN}/api/chapter-file/${part}`,{headers}),env,{});
 const whole=await get({});assert.equal(whole.status,200);assert.equal(whole.headers.get('Accept-Ranges'),'bytes');assert.equal(whole.headers.get('Content-Type'),'application/pdf');
 assert.equal(whole.headers.get('Content-Disposition'),`inline; filename="hoa-tri.pdf"; filename*=UTF-8''${encodeURIComponent('Trang 7–14.vi.pdf')}`);
 assert.deepEqual(new Uint8Array(await whole.arrayBuffer()),translated);
 const range=await get({Range:'bytes=100-199'});assert.equal(range.status,206);assert.equal(range.headers.get('Content-Range'),`bytes 100-199/${translated.length}`);assert.deepEqual(new Uint8Array(await range.arrayBuffer()),translated.slice(100,200));
 assert.equal((await get({Range:`bytes=${translated.length}-`})).status,416);
 assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/chapter-file/no-such-part`),env,{})).status,404);
});

test('Đọc song ngữ names the book\'s pages when the original is an excerpt that records them',async t=>{
 const {env,id,part}=await library(t),assembly=await (await worker.fetch(new Request(`${ORIGIN}/api/library/${id}/assembly`),env,{})).json();
 assert.deepEqual(assembly.storedSources[0].bookPages,[1,...Array.from({length:15},(_,i)=>7+i)]);
 const source=bilingualSource(assembly,part);
 assert.deepEqual([source.pages,source.labels],[[2,3,4,5,6,7,8,9],[7,8,9,10,11,12,13,14]]);
 // From the stored file alone, from the part alone, and none when they do not fit.
 const SHA='a'.repeat(64),base={parts:[{id:'c1',mime:'application/pdf',pages:[2,3],sha256:SHA}],storedSources:[{sha256:SHA,pages:5,url:`/api/library/b/sources/${SHA}`,bookPages:[1,7,8,9,10]}]};
 assert.deepEqual(bilingualSource(base,'c1').labels,[7,8]);
 assert.deepEqual(bilingualSource({...base,parts:[{...base.parts[0],bookPages:[17,18]}]},'c1').labels,[17,18]);
 for(const storedSources of [[{...base.storedSources[0],bookPages:[1,7]}],[{...base.storedSources[0],bookPages:'1,7-10'}],[{...base.storedSources[0],bookPages:[1,0,8,9,10]}],[{...base.storedSources[0],bookPages:undefined}]])assert.equal('labels' in bilingualSource({...base,storedSources},'c1'),false,JSON.stringify(storedSources));
 // A server keeps book pages only as runs it can read back, one per page of the file.
 const put=(pages,book)=>worker.fetch(new Request(`${ORIGIN}/api/stories/${id}/sources/${'c'.repeat(64)}`,{method:'PUT',body:new Uint8Array([37,80,68,70,45]),headers:{Authorization:`Bearer ${ADMIN}`,'X-PDF-Pages':String(pages),'X-Book-Pages':book}}),env,{});
 for(const [pages,book] of [[2,'1'],[2,'3-1'],[2,'0,1'],[2,'1,1'],[2,'a,b'],[2,`1,${'9'.repeat(1001)}`]]){const refused=await put(pages,book);assert.equal(refused.status,400,book);assert.match((await refused.json()).error,/X-Book-Pages/u);}
});
