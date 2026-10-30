import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import {hashToken} from './reader-auth.js';
import {bodyLimit} from './http.js';
import {sourceKey} from './study-history.js';
import {deleteAccount} from './account.js';
import {SUBJECT_IDS} from './subject-glossaries.js';
import * as wholeBook from '../frontend/whole-book.js';

const origin='https://example.test',lan={id:'student-lan',name:'Lan'},minh={id:'student-minh',name:'Minh'},MB=1024*1024;
const png='data:image/png;base64,AA==',encoder=new TextEncoder();
const hex=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const pdfBytes=label=>encoder.encode(`%PDF-1.7\n${label}\n%%EOF`);
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
// R2 as the Worker sees it: put reads streams to the end and refuses bytes that do not match a given sha256 (code 10037).
class MemoryR2{
 constructor(){this.values=new Map();this.puts=[];}
 async put(key,value,options={}){
  const streamed=value instanceof ReadableStream,bytes=streamed?new Uint8Array(await new Response(value).arrayBuffer()):typeof value==='string'?encoder.encode(value):value instanceof Blob?new Uint8Array(await value.arrayBuffer()):new Uint8Array(value);
  this.puts.push({key,streamed,options});
  if(options.sha256){const actual=await hex(bytes);if(actual!==String(options.sha256))throw new Error(`put: The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: ${options.sha256}\nActual SHA-256 was: ${actual} (10037)`);}
  this.values.set(key,{bytes,options});return {key,size:bytes.length};
 }
 async head(key){const item=this.values.get(key);return item?{key,size:item.bytes.length,customMetadata:item.options.customMetadata||{},httpMetadata:item.options.httpMetadata||{}}:null;}
 async get(key,{range}={}){
  const item=this.values.get(key);if(!item)return null;const size=item.bytes.length;let {bytes}=item;const text=()=>new TextDecoder().decode(bytes);
  if(range){const start=range.suffix!==undefined?Math.max(0,size-range.suffix):range.offset??0,length=range.suffix!==undefined?Math.min(range.suffix,size):range.length??size-start;if(start>=size||length<=0)throw new Error('get: The requested range is not satisfiable (10039)');bytes=bytes.slice(start,start+length);}
  return {key,size,customMetadata:item.options.customMetadata||{},httpMetadata:item.options.httpMetadata||{},get body(){return new Response(bytes.slice()).body;},arrayBuffer:async()=>bytes.slice().buffer,text:async()=>text(),json:async()=>JSON.parse(text())};
 }
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix='',cursor=''}={}){const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)&&key>cursor).sort();return {objects:keys.map(key=>({key})),truncated:false};}
}
async function environment(t,extra={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 const cookies={};
 for(const user of [lan,minh]){
  sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(user.id,`sub-${user.id}`,`${user.id}@example.test`,user.name);
  sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(`token-${user.id}`),user.id,Date.now()+3600000);
  cookies[user.id]=`cat_hien_session=token-${user.id}`;
 }
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,FILES:new MemoryR2(),PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test/v1/',PDF_LAYOUT_SERVICE_TOKEN:'service-secret',...extra};
 const call=(path,init={},user=lan)=>worker.fetch(new Request(origin+path,{...init,headers:{Cookie:cookies[user.id],...init.headers}}),env,{});
 const send=async(path,init={},user=lan)=>{const response=await call(path,init,user);return {status:response.status,headers:response.headers,body:response.status===204||init.method==='HEAD'?null:await response.json()};};
 const json=(path,method,body,user=lan)=>send(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},user);
 return {sqlite,env,call,send,json};
}
// The browser's upload: raw bytes, its own hash in the path, the page count and the URI-encoded name in headers.
function upload(ctx,bytes,sha,{pages=12,filename='Vật lý 10.pdf',headers={},user=lan}={}){
 return ctx.send(`/api/my/study/sources/${sha}`,{method:'PUT',headers:{'Content-Type':'application/pdf','Content-Length':String(bytes.length),'X-PDF-Pages':String(pages),'X-Source-Filename':encodeURIComponent(filename),...headers},body:bytes},user);
}
const sourceObjects=(env,user=lan)=>[...env.FILES.values.keys()].filter(key=>key.startsWith(`study/${user.id}/sources/`));
const jobBody=(sha,extra={})=>({sourceSha256:sha,totalPages:12,filename:'Vật lý 10.pdf',title:'Vật lý 10',domain:'physics',mode:'economy',chunkSize:10,...extra});
const JOB_KEYS=['id','sourceSha256','filename','title','storyId','totalPages','pageStates','chunkSize','domain','mode','model','status','pauseReason','usage','glossary','createdAt','updatedAt','runner','leaseSeconds'];

test('A whole original is streamed once into its owner\'s folder, checked against its hash and found again with HEAD',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('whole physics book'),sha=await hex(bytes),path=`/api/my/study/sources/${sha}`;
 const before=await ctx.send(path,{method:'HEAD'});assert.equal(before.status,404);assert.equal(before.headers.get('X-PDF-Pages'),null);
 const stored=await upload(ctx,bytes,sha);
 assert.equal(stored.status,201);assert.deepEqual(stored.body,{sha256:sha,pages:12,filename:'Vật lý 10.pdf',stored:true});
 const put=ctx.env.FILES.puts.at(-1);assert.equal(put.key,sourceKey(lan.id,sha));assert.equal(put.streamed,true,'the body reaches storage as a stream, never as a buffer');
 assert.equal(put.options.sha256,sha);assert.deepEqual(put.options.customMetadata,{filename:'Vật lý 10.pdf',pages:'12'});assert.equal(put.options.httpMetadata.contentType,'application/pdf');
 const head=await ctx.call(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('X-PDF-Pages'),'12');assert.equal(await head.text(),'');
 assert.equal((await ctx.call(path,{method:'HEAD'},minh)).status,404,'another student never sees it');
 const download=await ctx.call(path);assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);assert.match(download.headers.get('Content-Disposition'),/V%E1%BA%ADt%20l%C3%BD%2010\.pdf/u);
 const again=await upload(ctx,bytes,sha,{pages:99,filename:'khác.pdf'});
 assert.equal(again.status,200);assert.deepEqual(again.body,{sha256:sha,pages:12,filename:'Vật lý 10.pdf',stored:false});assert.equal(ctx.env.FILES.puts.length,1,'nothing is uploaded twice');
 assert.equal((await upload(ctx,bytes,sha,{user:minh})).status,201);assert.equal(sourceObjects(ctx.env,minh).length,1,'each student keeps an own copy');
 const long=pdfBytes('long name'),longSha=await hex(long);assert.equal((await upload(ctx,long,longSha,{filename:'Đ'.repeat(300)+'.pdf'})).body.filename,'Đ'.repeat(240));
});

test('Uploads with a wrong hash, non-PDF bytes, bad headers or no length are refused and store nothing',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('textbook'),sha=await hex(bytes);
 for(const bad of ['C'.repeat(64),'c'.repeat(63),'c'.repeat(64)+'.pdf']){const result=await upload(ctx,bytes,bad);assert.equal(result.status,400,bad);assert.equal(result.body.code,'bad_hash');}
 const mismatch=await upload(ctx,bytes,'a'.repeat(64));assert.equal(mismatch.status,400);assert.equal(mismatch.body.code,'checksum_mismatch');assert.match(mismatch.body.error,/không khớp mã kiểm tra/u);
 const text=encoder.encode('plain text, not a PDF'),notPdf=await upload(ctx,text,await hex(text));assert.equal(notPdf.status,400);assert.equal(notPdf.body.code,'not_pdf');
 for(const pages of ['','0','10001','12abc','-3']){const result=await upload(ctx,bytes,sha,{pages});assert.equal(result.status,400,pages);assert.equal(result.body.code,'bad_pages');}
 const badName=await upload(ctx,bytes,sha,{headers:{'X-Source-Filename':'%E0%A4%A'}});assert.equal(badName.status,400);assert.equal(badName.body.code,'bad_filename');
 // A chunked body (no Content-Length) cannot be streamed to R2, which needs the length up front.
 const chunked=await ctx.send(`/api/my/study/sources/${sha}`,{method:'PUT',headers:{'X-PDF-Pages':'12'},body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),duplex:'half'});
 assert.equal(chunked.status,411);assert.equal(chunked.body.code,'length_required');
 assert.equal((await ctx.send(`/api/my/study/sources/${sha}`,{method:'DELETE'})).status,405);
 // Only the upload R2 received in full and refused for its hash counts; refusals before the file is read do not.
 assert.deepEqual(sourceObjects(ctx.env),[]);assert.equal(ctx.sqlite.prepare("SELECT count FROM rate_limits WHERE key=?").get('pdf-source:'+lan.id).count,1);
});

test('Only the source upload may send 100 MiB, refused before any byte is read; every other limit stays',async t=>{
 const ctx=await environment(t),sha='b'.repeat(64);let read=false;
 const body=new ReadableStream({pull(){read=true;throw new Error('the body must not be read');}},{highWaterMark:0});
 const response=await ctx.send(`/api/my/study/sources/${sha}`,{method:'PUT',headers:{'Content-Length':String(100*MB+1),'X-PDF-Pages':'5'},body,duplex:'half'});
 assert.equal(response.status,413);assert.equal(response.body.code,'too_large');assert.match(response.body.error,/tối đa 100 MB/u);assert.equal(read,false);
 assert.equal(bodyLimit(`/api/my/study/sources/${sha}`,'PUT'),100*MB);
 assert.deepEqual([bodyLimit(`/api/my/study/sources/${sha}`),bodyLimit(`/api/my/study/sources/${sha}`,'POST'),bodyLimit('/api/my/study/pdf-layout/extract','POST'),bodyLimit('/api/my/study/history','PUT'),bodyLimit('/api/my/study/book-jobs','POST'),bodyLimit('/api/me','DELETE')],[8*MB,8*MB,26*MB,32*MB,8*MB,64*1024]);
});

test('Source uploads have a per-minute and a daily limit, and a kept copy without a page count gets one',async t=>{
 const refusing=await environment(t,{HEAVY_LIMITER:{limit:async()=>({success:false})}}),bytes=pdfBytes('limited'),sha=await hex(bytes);
 const fast=await upload(refusing,bytes,sha);assert.equal(fast.status,429);assert.equal(fast.body.code,'rate_limited');assert.equal(fast.headers.get('Retry-After'),'60');assert.deepEqual(sourceObjects(refusing.env),[]);
 const daily=await environment(t,{DAILY_SOURCE_UPLOADS_PER_USER:'1'}),other=pdfBytes('second book');
 assert.equal((await upload(daily,bytes,sha)).status,201);
 const second=await upload(daily,other,await hex(other));assert.equal(second.status,429);assert.match(second.body.error,/1 lượt tải tệp PDF gốc/u);
 // Kept by an older range extraction without its page count: the next upload fills it in instead of storing again.
 const ctx=await environment(t),old=pdfBytes('kept earlier'),oldSha=await hex(old);
 await ctx.env.FILES.put(sourceKey(lan.id,oldSha),old,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:'cũ.pdf',pages:''}});
 assert.equal((await ctx.call(`/api/my/study/sources/${oldSha}`,{method:'HEAD'})).status,404,'a copy without pages needs one PUT');
 const fixed=await upload(ctx,old,oldSha,{pages:7});assert.equal(fixed.status,200);assert.deepEqual(fixed.body,{sha256:oldSha,pages:7,filename:'cũ.pdf',stored:false});
 assert.equal((await ctx.call(`/api/my/study/sources/${oldSha}`,{method:'HEAD'})).headers.get('X-PDF-Pages'),'7');
 assert.deepEqual(ctx.env.FILES.values.get(sourceKey(lan.id,oldSha)).bytes,old);
});

test('A whole-book run needs the stored original, checks every field and records each page',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('book'),sha=await hex(bytes),base='/api/my/study/book-jobs';
 const missing=await ctx.json(base,'POST',jobBody(sha));assert.equal(missing.status,404);assert.equal(missing.body.code,'source_missing');
 await upload(ctx,bytes,sha);
 const minhBook=crypto.randomUUID();ctx.sqlite.prepare("INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,'private')").run(minhBook,'Sách của Minh','Toán học · STEM',`study-book:${minhBook}`,minh.id);
 for(const [extra,code] of [[{sourceSha256:'X'.repeat(64)},'bad_hash'],[{totalPages:13},'pages_mismatch'],[{totalPages:0},'bad_pages'],[{chunkSize:0},'bad_chunk'],[{chunkSize:21},'bad_chunk'],[{domain:'art'},'bad_domain'],[{mode:'turbo'},'bad_mode'],[{coverPage:13},'bad_cover'],[{title:'x'.repeat(201)},'bad_title'],[{filename:'a\nb.pdf'},'bad_filename']]){
  const result=await ctx.json(base,'POST',jobBody(sha,extra));assert.equal(result.status,400,JSON.stringify(extra));assert.equal(result.body.code,code);
 }
 // Every subject of the workspace is a valid domain: each gets past the field checks to the stored page count.
 for(const domain of SUBJECT_IDS)assert.equal((await ctx.json(base,'POST',jobBody(sha,{domain,totalPages:13}))).body.code,'pages_mismatch',domain);
 assert.deepEqual([...SUBJECT_IDS].sort(),['biology','chemistry','general','history','informatics','math','physics']);
 const foreign=await ctx.json(base,'POST',jobBody(sha,{storyId:minhBook}));assert.equal(foreign.status,404);assert.equal(foreign.body.code,'book_missing');
 const created=await ctx.json(base,'POST',jobBody(sha,{title:'',filename:'',coverPage:1,glossary:{'力':'lực','x':7}}));
 assert.equal(created.status,201);const job=created.body.job;
 assert.deepEqual(Object.keys(job),JOB_KEYS);
 assert.deepEqual({...job,id:undefined,createdAt:undefined,updatedAt:undefined},{id:undefined,sourceSha256:sha,filename:'Vật lý 10.pdf',title:'Vật lý 10',storyId:null,totalPages:12,pageStates:'c...........',chunkSize:10,domain:'physics',mode:'economy',model:null,status:'ready',pauseReason:null,usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{'力':'lực'},createdAt:undefined,updatedAt:undefined,runner:null,leaseSeconds:0});
 assert.match(job.id,/^[a-f\d-]{36}$/u);assert.ok(!Number.isNaN(Date.parse(job.createdAt)));
 const twice=await ctx.json(base,'POST',jobBody(sha));assert.equal(twice.status,409);assert.equal(twice.body.code,'job_exists');assert.equal(twice.body.job.id,job.id);
 assert.deepEqual((await ctx.send(base)).body.jobs.map(item=>item.id),[job.id]);assert.deepEqual((await ctx.send(base,{},minh)).body,{jobs:[]});
 assert.deepEqual((await ctx.send(`${base}/${job.id}`)).body.job,job);
 assert.equal((await ctx.send(`${base}/${job.id}`,{},minh)).status,404);assert.equal((await ctx.send(`${base}/not-a-job`)).status,400);
 assert.equal((await ctx.send(base,{method:'DELETE'})).status,405);
 // A finished run no longer blocks a new one over the same file.
 ctx.sqlite.prepare("UPDATE book_jobs SET status='done' WHERE id=?").run(job.id);assert.equal((await ctx.json(base,'POST',jobBody(sha))).status,201);
});

test('A whole-book run may take any "Cách dịch", Kỹ nhất included, and keeps it as it is; a run stored with another reads back unchanged; the student may change it while no other device runs the book',async t=>{
 const ctx=await environment(t),base='/api/my/study/book-jobs';
 for(const mode of ['economy','balanced','quality','premium']){
  const bytes=pdfBytes(`book ${mode}`),sha=await hex(bytes);await upload(ctx,bytes,sha);
  const created=await ctx.json(base,'POST',jobBody(sha,{mode}));assert.equal(created.status,201,mode);assert.equal(created.body.job.mode,mode);
  assert.equal(ctx.sqlite.prepare('SELECT mode FROM book_jobs WHERE id=?').get(created.body.job.id).mode,mode);
 }
 const bytes=pdfBytes('unknown mode'),sha=await hex(bytes);await upload(ctx,bytes,sha);
 for(const mode of [undefined,null,'','turbo','Premium','__proto__',3])assert.equal((await ctx.json(base,'POST',jobBody(sha,{mode}))).body.code,'bad_mode',String(mode));
 // A row an older build wrote is listed as it was stored.
 const now=new Date().toISOString(),old=`${base}/00000000-0000-4000-8000-0000000000aa`;ctx.sqlite.prepare("INSERT INTO book_jobs(id,user_id,source_sha256,title,total_pages,page_states,chunk_size,domain,mode,created_at,updated_at) VALUES(?,?,?,'Cũ',3,'...',10,'general','faithful',?,?)").run('00000000-0000-4000-8000-0000000000aa',lan.id,sha,now,now);
 assert.equal((await ctx.send(old)).body.job.mode,'faithful');
 // The student changes the book's Cách dịch while no run holds it (Xưởng dịch saves it so); only a mode it knows.
 for(const mode of [null,'','turbo','Premium',3]){const refused=await ctx.json(old,'PATCH',{mode});assert.equal(refused.status,400,String(mode));assert.equal(refused.body.code,'bad_mode');}
 assert.equal(ctx.sqlite.prepare('SELECT mode FROM book_jobs WHERE id=?').get('00000000-0000-4000-8000-0000000000aa').mode,'faithful');
 const changed=await ctx.json(old,'PATCH',{mode:'premium'});assert.equal(changed.status,200);assert.equal(changed.body.job.mode,'premium');assert.equal((await ctx.send(old)).body.job.mode,'premium');
 // Another device's run holding the job keeps its mode: the change waits like any other.
 const phone='phone-0000-4000-8000-000000000002';assert.equal((await ctx.json(old,'PATCH',{runner:phone,status:'running'})).status,200);
 const busy=await ctx.json(old,'PATCH',{mode:'economy'});assert.equal(busy.status,409);assert.equal(busy.body.code,'job_busy');assert.equal(busy.body.job.mode,'premium');
});

test('Progress reports merge: translated pages stay translated, tokens add up, terms merge, and concurrent reports all count',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('progress'),sha=await hex(bytes);await upload(ctx,bytes,sha);
 const {job}=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha))).body,path=`/api/my/study/book-jobs/${job.id}`;
 const usage={prompt:900,output:300,thinking:12,total:1212,requests:2};
 let result=await ctx.json(path,'PATCH',{pages:{'2':'done','3':'blank','4':'failed','5':'c'},addUsage:usage,glossary:{'加速度':' gia tốc ','速度':'vận tốc',['__proto__']:'x',['长'.repeat(101)]:'dài',bad:7},model:'gemini-3.1-flash-lite',status:'running'});
 assert.equal(result.status,200);assert.equal(result.body.job.pageStates,'.dbfc.......');assert.deepEqual(result.body.job.usage,usage);assert.equal(result.body.job.status,'running');assert.equal(result.body.job.model,'gemini-3.1-flash-lite');
 assert.deepEqual(result.body.job.glossary,{'加速度':'gia tốc','速度':'vận tốc'});
 // A stale tab or a failed retry cannot undo a translated page; other changes apply.
 // A term a chunk learned keeping Chinese bare, or repeating its term, would keep that Chinese for the rest of the book:
 // left out. A name given its Hán-Việt reading with the Chinese in parentheses (D9) is learned, as text mode learns it.
 result=await ctx.json(path,'PATCH',{pages:{'2':'pending','4':'done','6':'f'},addUsage:{prompt:100,total:100,requests:1},glossary:{'速度':'tốc độ','质量':'khối lượng','探究':'探究','张三':'Trương Tam (张三)','史景迁':'史景迁 (Sử Cảnh Khiên)','DNA':'DNA'}});
 assert.equal(result.body.job.pageStates,'.dbdcf......');assert.deepEqual(result.body.job.usage,{prompt:1000,output:300,thinking:12,total:1312,requests:3});
 assert.deepEqual(result.body.job.glossary,{'加速度':'gia tốc','速度':'tốc độ','质量':'khối lượng','张三':'Trương Tam (张三)'});
 result=await ctx.json(path,'PATCH',{pages:{'4':'f','2':'skipped'}});assert.equal(result.body.job.pageStates,'.sbdcf......','failed never replaces done; the student may still skip a page');
 // A page with no block to translate that still shows Chinese outside every block is kept apart from a blank one.
 result=await ctx.json(path,'PATCH',{pages:{'7':'untranslated','8':'u'}});assert.equal(result.body.job.pageStates,'.sbdcfuu....');
 result=await ctx.json(path,'PATCH',{pages:{'7':'pending','8':'pending'}});assert.equal(result.body.job.pageStates,'.sbdcf......');
 result=await ctx.json(path,'PATCH',{status:'paused',pauseReason:'quota_minute'});assert.deepEqual([result.body.job.status,result.body.job.pauseReason],['paused','quota_minute']);
 result=await ctx.json(path,'PATCH',{status:'running'});assert.deepEqual([result.body.job.status,result.body.job.pauseReason],['running',null]);
 for(const [body,code] of [[{pages:{'0':'done'}},'bad_pages'],[{pages:{'13':'done'}},'bad_pages'],[{pages:{'1':'x'}},'bad_pages'],[{pages:['done']},'bad_pages'],[{addUsage:{prompt:-1}},'bad_usage'],[{addUsage:{total:1.5}},'bad_usage'],[{model:'gpt-4o'},'bad_model'],[{status:'stopped'},'bad_status'],[{pauseReason:'x'.repeat(201)},'bad_reason'],[{glossary:['x']},'bad_glossary'],[{},'no_change'],[{title:'renamed'},'no_change']]){
  const refused=await ctx.json(path,'PATCH',body);assert.equal(refused.status,400,JSON.stringify(body));assert.equal(refused.body.code,code);
 }
 // The run's book: one of the student's own study books, or none.
 const book=crypto.randomUUID(),minhBook=crypto.randomUUID();
 for(const [id,owner] of [[book,lan],[minhBook,minh]])ctx.sqlite.prepare("INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,'private')").run(id,'Sách','Chuyên khảo · Nghiên cứu',`study-book:${id}`,owner.id);
 assert.equal((await ctx.json(path,'PATCH',{storyId:book})).body.job.storyId,book);
 assert.equal((await ctx.json(path,'PATCH',{storyId:minhBook})).status,404);
 assert.equal((await ctx.json(path,'PATCH',{storyId:null})).body.job.storyId,null);
 assert.equal((await ctx.json(path,'PATCH',{pages:{'1':'done'}},minh)).status,404,'only the owner reports progress');
 // Another tab reports between this report's read and its write: the write misses, is redone on the newer row, and both count.
 const prepare=ctx.env.DB.prepare;let updates=0;
 ctx.env.DB.prepare=sql=>{if(sql.startsWith('UPDATE book_jobs SET page_states')&&++updates===1)ctx.sqlite.prepare("UPDATE book_jobs SET page_states=substr(page_states,1,10)||'d'||substr(page_states,12),total_tokens=total_tokens+1000,version=version+1 WHERE id=?").run(job.id);return prepare(sql);};
 result=await ctx.json(path,'PATCH',{pages:{'12':'blank'},addUsage:{total:7}});ctx.env.DB.prepare=prepare;
 assert.equal(updates,2);assert.equal(result.body.job.pageStates,'.sbdcf....db');assert.equal(result.body.job.usage.total,1312+1007);
 ctx.sqlite.prepare("UPDATE book_jobs SET page_states=substr(page_states,1,10)||'..',total_tokens=total_tokens-1007 WHERE id=?").run(job.id);
 // Four chunks finishing at once: every page and every token is kept.
 const reports=[7,8,9,10].map(page=>ctx.json(path,'PATCH',{pages:{[page]:'done'},addUsage:{prompt:10,output:5,total:15,requests:1}}));
 for(const report of await Promise.all(reports))assert.equal(report.status,200);
 const final=(await ctx.send(path)).body.job;assert.equal(final.pageStates,'.sbdcfdddd..');assert.deepEqual(final.usage,{prompt:1040,output:320,thinking:12,total:1372,requests:7});
 assert.equal(ctx.sqlite.prepare('SELECT version FROM book_jobs WHERE id=?').get(job.id).version,15);
});

test('The book glossary stays bounded, keeps the terms in use and fits the translate-blocks glossary',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('terms'),sha=await hex(bytes);await upload(ctx,bytes,sha);
 const {job}=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha))).body,path=`/api/my/study/book-jobs/${job.id}`;
 const terms=Object.fromEntries(Array.from({length:2100},(_,i)=>[`术语${i}`,`thuật ngữ ${i}`]));
 let glossary=(await ctx.json(path,'PATCH',{glossary:terms})).body.job.glossary;
 assert.equal(Object.keys(glossary).length,2000);assert.equal(glossary['术语0'],'thuật ngữ 0');assert.equal(glossary['术语2050'],undefined);
 glossary=(await ctx.json(path,'PATCH',{glossary:{'术语0':'thuật ngữ mới','新词':'từ mới'}})).body.job.glossary;
 assert.equal(glossary['术语0'],'thuật ngữ mới','a full glossary still takes corrections');assert.equal(glossary['新词'],undefined);
 // Long terms reach the byte bound before the term count.
 const big=await environment(t);await upload(big,bytes,sha);const bigJob=(await big.json('/api/my/study/book-jobs','POST',jobBody(sha))).body.job;
 const long=Object.fromEntries(Array.from({length:1500},(_,i)=>[`${'长'.repeat(95)}${i}`,`${'đ'.repeat(95)}${i}`]));
 const stored=(await big.json(`/api/my/study/book-jobs/${bigJob.id}`,'PATCH',{glossary:long})).body.job.glossary;
 assert.ok(encoder.encode(JSON.stringify(stored)).length<=256*1024);assert.ok(Object.keys(stored).length>100);
 for(const [key,value] of Object.entries(stored))assert.ok(key.length<=100&&value.length<=100&&value===value.normalize('NFC'));
});

test('Deleting a run removes it and its original unless the original is still used or kept on purpose',async t=>{
 const ctx=await environment(t),base='/api/my/study/book-jobs';
 const create=async label=>{const bytes=pdfBytes(label),sha=await hex(bytes);await upload(ctx,bytes,sha);return {sha,job:(await ctx.json(base,'POST',jobBody(sha))).body.job};};
 const one=await create('first');
 assert.equal((await ctx.send(`${base}/${one.job.id}`,{method:'DELETE'},minh)).status,404);
 assert.deepEqual((await ctx.send(`${base}/${one.job.id}`,{method:'DELETE'})).body,{ok:true,removedSource:true});
 assert.equal((await ctx.send(`${base}/${one.job.id}`)).status,404);assert.equal(ctx.env.FILES.values.has(sourceKey(lan.id,one.sha)),false);
 const two=await create('second');
 assert.deepEqual((await ctx.send(`${base}/${two.job.id}?keepSource=1`,{method:'DELETE'})).body,{ok:true,removedSource:false});assert.ok(ctx.env.FILES.values.has(sourceKey(lan.id,two.sha)),'starting over keeps the upload');
 const three=await create('third');ctx.sqlite.prepare("INSERT INTO study_sessions(id,user_id,title,state_key,source_sha256) VALUES(?,?,?,?,?)").run(crypto.randomUUID(),lan.id,'Phần 1','study/x/state.json',three.sha);
 assert.deepEqual((await ctx.send(`${base}/${three.job.id}`,{method:'DELETE'})).body,{ok:true,removedSource:false});assert.ok(ctx.env.FILES.values.has(sourceKey(lan.id,three.sha)),'a translated part still comes from it');
});

// The layout service as the Worker calls it: the chunk arrives as raw PDF with its own page list.
function layoutService(t,{pages=[1,2],warnings=[],empty=false,error=null}={}){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),pages:decodeURIComponent(options.headers['X-PDF-Pages']||''),body:new Uint8Array(await new Response(options.body).arrayBuffer())});
  if(error)return Response.json({error},{status:422});
  return Response.json({document:{version:1,extractionVersion:2,totalPages:pages.length,warnings,pages:pages.map(number=>({number,width:600,height:800,original:png,background:png,blocks:empty?[]:[{id:`p${number}-b0`,source:`第${number}页内容。`,box:[20,20,200,80],fontSize:12}]}))},originalPdfBase64:btoa('%PDF-1.7 selected chunk pages')});
 });
 return calls;
}
const chunkForm=(fields,bytes=pdfBytes('chunk of pages 21-22'))=>{const form=new FormData();form.set('file',new File([bytes],'chunk.pdf',{type:'application/pdf'}));for(const [key,value] of Object.entries(fields))form.set(key,String(value));return form;};
const extract=(ctx,fields,user=lan)=>ctx.send('/api/my/study/pdf-layout/extract',{method:'POST',body:chunkForm(fields)},user);

test('A chunk cut from a stored original is extracted as pages of that original and joins its book like a range',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('forty page book'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:40,filename:'Sinh học 11.pdf'});
 const calls=layoutService(t,{warnings:['Trang 2: dùng OCR; hãy đối chiếu công thức với PDF gốc.','Lượt này xử lý 2/3 trang đã chọn (trang 1–2) vì ảnh của các trang vượt giới hạn dung lượng của một lượt. Hãy dịch tiếp trang 3 ở lượt sau.']});
 const result=await extract(ctx,{pages:'1-3',sha256:'f'.repeat(64),sourceSha256:sha,pageOffset:20});
 assert.equal(result.status,201);const {document,assetId}=result.body;
 assert.equal(calls.length,1);assert.equal(calls[0].pages,'1-3','the service gets the chunk and its own page list');assert.deepEqual(calls[0].body,pdfBytes('chunk of pages 21-22'));
 assert.deepEqual(document.pages.map(page=>page.number),[21,22]);assert.deepEqual(document.pages.flatMap(page=>page.blocks.map(block=>block.id)),['p21-b0','p22-b0']);
 assert.equal(document.totalPages,40);assert.equal(document.sourceSha256,sha);
 assert.deepEqual(document.warnings,['Trang 22: dùng OCR; hãy đối chiếu công thức với PDF gốc.','Lượt này xử lý 2/3 trang đã chọn (trang 21–22) vì ảnh của các trang vượt giới hạn dung lượng của một lượt. Hãy dịch tiếp trang 23 ở lượt sau.']);
 assert.deepEqual(sourceObjects(ctx.env),[sourceKey(lan.id,sha)],'the chunk is not kept as another original');
 const folder=`study/${lan.id}/pdf-layout/${assetId}/`;assert.deepEqual(JSON.parse(new TextDecoder().decode(ctx.env.FILES.values.get(folder+'manifest.json').bytes)),document);
 assert.equal(ctx.env.FILES.values.get(folder+'original.pdf').options.customMetadata.filename,'Sinh học 11.pdf');
 // Saved to history, the chunk is a range of the original: pages 21-22 of 40, the same file as the book's other parts.
 const parts=document.pages.map(page=>page.blocks[0].source);
 const saved=await ctx.json('/api/my/study/history','POST',{title:'Sinh học 11',filename:'Sinh học 11.pdf',domain:'general',state:{source:parts.join('\n\n'),parts,translationParts:['Nội dung trang 21.','Nội dung trang 22.'],done:2,pdfLayout:{assetId}}});
 assert.equal(saved.status,201);
 assert.deepEqual({...ctx.sqlite.prepare('SELECT page_start,page_end,source_total_pages,source_sha256,source_pages FROM study_sessions WHERE id=?').get(saved.body.id)},{page_start:21,page_end:22,source_total_pages:40,source_sha256:sha,source_pages:'[21,22]'});
 const assembly=(await ctx.send(`/api/my/study/books/${saved.body.libraryStoryId}/assembly`)).body;assert.deepEqual(assembly.storedSources,[{sha256:sha,pages:40,url:`/api/my/study/sources/${sha}`}]);
});

test('Chunk extraction checks the stored original, the offset and the page list before calling the service',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('ten pages'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:10});
 const calls=layoutService(t);
 for(const [fields,status,code] of [[{pages:'1-2',sourceSha256:sha,pageOffset:9},400,'bad_pages'],[{pages:'1-2',sourceSha256:'d'.repeat(64),pageOffset:0},404,'source_missing'],[{pages:'1-2',pageOffset:4},400,'bad_hash'],[{pages:'1-2',sourceSha256:'ABC',pageOffset:4},400,'bad_hash'],[{pages:'abc',sourceSha256:sha,pageOffset:0},400,'bad_pages'],[{pages:'',sourceSha256:sha,pageOffset:0},400,'bad_pages'],[{pages:'3-1',sourceSha256:sha,pageOffset:0},400,'bad_pages'],[{pages:'1',sourceSha256:sha,pageOffset:'-1'},400,'bad_offset'],[{pages:'1',sourceSha256:sha,pageOffset:'2.5'},400,'bad_offset']]){
  const result=await extract(ctx,fields);assert.equal(result.status,status,JSON.stringify(fields));assert.equal(result.body.code,code,JSON.stringify(fields));
 }
 assert.equal((await extract(ctx,{pages:'1-2',sourceSha256:sha,pageOffset:0},minh)).body.code,'source_missing','another student\'s original is never found');
 assert.equal(calls.length,0);
 // The last page of the file is allowed, an offset alone defaults to 0, and spaces in the list are ignored.
 assert.equal((await extract(ctx,{pages:'1, 2',sourceSha256:sha,pageOffset:8})).status,201);assert.equal((await extract(ctx,{pages:'1-2',sourceSha256:sha})).status,201);
});

test('A chunk with nothing to translate names its pages, and service messages name pages of the original',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('blank pages'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:30});
 layoutService(t,{pages:[1],empty:true});
 const blank=await extract(ctx,{pages:'1-3',sourceSha256:sha,pageOffset:10});
 assert.equal(blank.status,422);assert.equal(blank.body.code,'no_text');assert.deepEqual(blank.body.pages,[11],'only the pages the service looked at');
 t.mock.restoreAll();layoutService(t,{error:'Trang 2 quá lớn để render an toàn (2000×3000 pt). Hãy bỏ trang này khỏi phạm vi hoặc giảm kích thước trang.'});
 const failed=await extract(ctx,{pages:'1-3',sourceSha256:sha,pageOffset:10});
 assert.equal(failed.status,400);assert.equal(failed.body.error,'Trang 12 quá lớn để render an toàn (2000×3000 pt). Hãy bỏ trang này khỏi phạm vi hoặc giảm kích thước trang.');
 assert.equal([...ctx.env.FILES.values.keys()].filter(key=>key.includes('/pdf-layout/')).length,0);
});

test('A stored original is served in byte ranges so the bilingual reader fetches only the pages it shows',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('ranged original'),sha=await hex(bytes),path=`/api/my/study/sources/${sha}`;await upload(ctx,bytes,sha);
 const part=await ctx.call(path,{headers:{Range:'bytes=0-9'}});
 assert.equal(part.status,206);assert.equal(part.headers.get('Content-Range'),`bytes 0-9/${bytes.length}`);assert.equal(part.headers.get('Accept-Ranges'),'bytes');
 assert.deepEqual(new Uint8Array(await part.arrayBuffer()),bytes.slice(0,10));
 const whole=await ctx.call(path);assert.equal(whole.status,200);assert.equal((await whole.arrayBuffer()).byteLength,bytes.length);
 assert.equal((await ctx.call(path,{headers:{Range:`bytes=${bytes.length+5}-`}})).status,416);
 assert.equal((await ctx.call(path,{headers:{Range:'bytes=0-9'}},minh)).status,404,'another student never reads it');
});

test('Deleting a translated range gives its pages back to the whole-book run unless another range still covers them',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('release pages'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:40});
 layoutService(t);
 const save=async offset=>{
  const {assetId,document}=(await extract(ctx,{pages:'1-2',sourceSha256:sha,pageOffset:offset})).body,parts=document.pages.map(page=>page.blocks[0].source);
  return (await ctx.json('/api/my/study/history','POST',{title:'Sinh học',filename:'Sinh học.pdf',domain:'biology',state:{source:parts.join('\n\n'),parts,translationParts:parts.map((_,i)=>`Trang ${i}.`),done:parts.length,pdfLayout:{assetId}}})).body;
 };
 const first=await save(0),second=await save(2),job=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha,{totalPages:40,storyId:first.libraryStoryId}))).body.job;
 const pages=(await ctx.json(`/api/my/study/book-jobs/${job.id}`,'PATCH',{pages:{1:'done',2:'done',3:'done',4:'done'},status:'done'})).body.job;
 assert.equal(pages.pageStates.slice(0,4),'dddd');
 await ctx.send(`/api/my/study/history/${first.id}`,{method:'DELETE'});
 const after=(await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job;
 assert.equal(after.pageStates.slice(0,4),'..dd');assert.equal(after.status,'paused');
 // A page another saved range covers stays translated.
 await ctx.send(`/api/my/study/history/${second.id}`,{method:'DELETE'});
 assert.equal((await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job.pageStates.slice(0,4),'....');
});

test('History and account changes keep whole-book runs coherent: originals stay while a run needs them, runs follow their book',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('history book'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:40});
 layoutService(t);
 const save=async(offset,extra={})=>{
  const {assetId,document}=(await extract(ctx,{pages:'1-2',sourceSha256:sha,pageOffset:offset})).body,parts=document.pages.map(page=>page.blocks[0].source);
  return (await ctx.json('/api/my/study/history','POST',{title:'Hóa học',filename:'Hóa học.pdf',domain:'general',...extra,state:{source:parts.join('\n\n'),parts,translationParts:parts.map((_,i)=>`Trang ${i}.`),done:parts.length,pdfLayout:{assetId}}})).body;
 };
 const first=await save(0),job=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha,{totalPages:40,storyId:first.libraryStoryId}))).body.job;
 assert.equal(job.storyId,first.libraryStoryId);
 // Deleting the only translated part empties the book: the run loses its book but the original stays for its next chunks.
 const removed=(await ctx.send(`/api/my/study/history/${first.id}`,{method:'DELETE'})).body;assert.equal(removed.removedBookId,first.libraryStoryId);
 assert.equal((await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job.storyId,null);assert.ok(ctx.env.FILES.values.has(sourceKey(lan.id,sha)));
 // Merging the run's book into another book: the run adds its next chunks to the merged book.
 const second=await save(2),other=await save(4);await ctx.json(`/api/my/study/book-jobs/${job.id}`,'PATCH',{storyId:second.libraryStoryId});
 const moved=await ctx.json(`/api/my/study/history/${second.id}`,'PATCH',{bookId:other.libraryStoryId});assert.equal(moved.body.removedBookId,second.libraryStoryId);
 assert.equal((await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job.storyId,other.libraryStoryId);
 // Deleting the account removes the runs with everything else.
 assert.equal(await deleteAccount(ctx.env,lan.id),'deleted');
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM book_jobs').get().n,0);assert.deepEqual(ctx.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.deepEqual([...ctx.env.FILES.values.keys()].filter(key=>key.startsWith(`study/${lan.id}/`)),[]);
});

test('One run at a time: a runner holds the job while it reports, another device is refused until the lease ends or is let go',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('lease'),sha=await hex(bytes);await upload(ctx,bytes,sha);
 const {job}=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha))).body,path=`/api/my/study/book-jobs/${job.id}`;
 const laptop='11111111-aaaa-4aaa-8aaa-111111111111',phone='22222222-bbbb-4bbb-8bbb-222222222222';
 const lease=()=>ctx.sqlite.prepare('SELECT runner_id,lease_until,version FROM book_jobs WHERE id=?').get(job.id);
 let result=await ctx.json(path,'PATCH',{runner:laptop,status:'running',pauseReason:null});
 assert.equal(result.status,200);assert.equal(result.body.job.runner,laptop);assert.ok(result.body.job.leaseSeconds>500&&result.body.job.leaseSeconds<=600,String(result.body.job.leaseSeconds));
 // The phone's run is refused before it changes anything; it learns how long the lease lasts and sees the progress.
 const before=lease().version;
 result=await ctx.json(path,'PATCH',{runner:phone,status:'running',pauseReason:null,pages:{5:'pending'}});
 assert.equal(result.status,409);assert.equal(result.body.code,'job_busy');assert.match(result.body.error,/^Quyển này đang được dịch ở một thiết bị khác/u);
 assert.ok(result.body.retryAfter>500);assert.equal(result.headers.get('Retry-After'),String(result.body.retryAfter));assert.equal(result.body.job.runner,laptop);assert.equal(lease().version,before);
 // Changes without a runner wait as well; tokens the phone already spent are always counted.
 assert.equal((await ctx.json(path,'PATCH',{pages:{2:'skipped'}})).status,409);
 result=await ctx.json(path,'PATCH',{runner:phone,reports:[{id:'33333333-cccc-4ccc-8ccc-333333333333',usage:{prompt:40,output:10,total:50,requests:1}}]});
 assert.equal(result.status,200);assert.equal(result.body.job.usage.total,50);assert.equal(lease().runner_id,laptop);
 // Every report of the laptop renews its lease, a bare heartbeat too.
 ctx.sqlite.prepare('UPDATE book_jobs SET lease_until=? WHERE id=?').run(Date.now()+1000,job.id);
 assert.equal((await ctx.json(path,'PATCH',{runner:laptop,pages:{2:'done'}})).status,200);assert.ok(lease().lease_until>Date.now()+500000);
 ctx.sqlite.prepare('UPDATE book_jobs SET lease_until=? WHERE id=?').run(Date.now()+1000,job.id);
 assert.equal((await ctx.json(path,'PATCH',{runner:laptop})).status,200);assert.ok(lease().lease_until>Date.now()+500000);
 // The laptop goes silent: once its lease has ended the phone takes over, and the laptop's late report is refused.
 ctx.sqlite.prepare('UPDATE book_jobs SET lease_until=? WHERE id=?').run(Date.now()-1,job.id);
 const ended=(await ctx.send(path)).body.job;assert.deepEqual([ended.runner,ended.leaseSeconds],[null,0],'an ended lease is no lease');
 result=await ctx.json(path,'PATCH',{runner:phone,status:'running',pauseReason:null});assert.equal(result.status,200);assert.equal(result.body.job.runner,phone);
 result=await ctx.json(path,'PATCH',{runner:laptop,pages:{3:'done'}});assert.equal(result.status,409);assert.equal(result.body.job.pageStates[2],'.');
 // Pausing lets the job go at once: the laptop goes on without waiting, and finishing lets it go too.
 result=await ctx.json(path,'PATCH',{runner:phone,status:'paused',pauseReason:'quota_day'});assert.deepEqual([result.body.job.runner,result.body.job.leaseSeconds,result.body.job.status],[null,0,'paused']);
 assert.equal((await ctx.json(path,'PATCH',{runner:laptop,status:'running',pauseReason:null})).body.job.runner,laptop);
 await ctx.json(path,'PATCH',{runner:laptop,status:'done',pauseReason:null});assert.deepEqual([lease().runner_id,lease().lease_until],[null,0]);
 for(const runner of ['short','x'.repeat(65),'bad id with spaces',42])assert.equal((await ctx.json(path,'PATCH',{runner,status:'running'})).body.code,'bad_runner',String(runner));
});

test('Token reports count once: a report sent again after a lost answer adds nothing, a new one in the same request still counts',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('reports'),sha=await hex(bytes);await upload(ctx,bytes,sha);
 const {job}=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha))).body,path=`/api/my/study/book-jobs/${job.id}`;
 const first={id:'44444444-dddd-4ddd-8ddd-444444444444',usage:{prompt:600,output:267,thinking:0,total:867,requests:1}},second={id:'55555555-eeee-4eee-8eee-555555555555',usage:{prompt:100,output:20,total:120,requests:1}};
 let result=await ctx.json(path,'PATCH',{pages:{3:'done'},reports:[first]});assert.equal(result.status,200);assert.deepEqual(result.body.job.usage,first.usage);
 // The same chunk report again (its answer was lost), now with the tokens spent since.
 result=await ctx.json(path,'PATCH',{pages:{3:'done'},reports:[first,second]});
 assert.equal(result.status,200);assert.deepEqual(result.body.job.usage,{prompt:700,output:287,thinking:0,total:987,requests:2});
 assert.equal((await ctx.json(path,'PATCH',{reports:[second]})).body.job.usage.total,987);
 for(const reports of [[{id:'short',usage:{total:1}}],[{id:first.id,usage:{total:-1}}],[{id:first.id}],[first,first],{0:first},Array.from({length:21},(_,i)=>({id:`66666666-ffff-4fff-8fff-${String(i).padStart(12,'0')}`,usage:{total:1}}))])
  assert.equal((await ctx.json(path,'PATCH',{reports})).body.code,'bad_usage',JSON.stringify(reports).slice(0,60));
 // The job remembers its last 100 reports, more than a device can still be holding.
 for(let i=0;i<105;i++)await ctx.json(path,'PATCH',{reports:[{id:`77777777-0000-4000-8000-${String(i).padStart(12,'0')}`,usage:{total:1,requests:1}}]});
 assert.equal(JSON.parse(ctx.sqlite.prepare('SELECT usage_reports FROM book_jobs WHERE id=?').get(job.id).usage_reports).length,100);
 assert.equal((await ctx.send(path)).body.job.usage.total,987+105);
});

// Rows as the history keeps them: a session with its book and chapter, and a run, written directly.
function partRows(ctx,sha){
 const book=()=>{const id=crypto.randomUUID();ctx.sqlite.prepare("INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,'private')").run(id,'Sách','Chuyên khảo · Nghiên cứu',`study-book:${id}`,lan.id);return id;};
 const session=(status,pages,story=null)=>{
  const id=crypto.randomUUID(),chapter=story&&status==='complete'?crypto.randomUUID():null;
  if(chapter)ctx.sqlite.prepare('INSERT INTO chapters(id,story_id,title,content,mime,position) VALUES(?,?,?,?,?,?)').run(chapter,story,`Trang ${pages[0]}`,'x','text/plain',pages[0]);
  ctx.sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,status,state_key,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,source_pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,lan.id,'Sách',status,`study/${lan.id}/${id}/state.json`,story,chapter,Math.min(...pages),Math.max(...pages),18,sha,JSON.stringify(pages));
  return id;
 };
 const job=(story,states,status='paused')=>{const id=crypto.randomUUID(),now=new Date().toISOString();ctx.sqlite.prepare("INSERT INTO book_jobs(id,user_id,source_sha256,title,story_id,total_pages,page_states,chunk_size,domain,mode,status,created_at,updated_at) VALUES(?,?,?,'Sách',?,?,?,20,'general','economy',?,?,?)").run(id,lan.id,sha,story,states.length,states,status,now,now);return id;};
 return {book,session,job};
}

test('Deleting a whole-book part gives its pages back unless a finished part of the run\'s own book still holds them',async t=>{
 const ctx=await environment(t),rows=partRows(ctx,'a'.repeat(64)),jobState=id=>({...ctx.sqlite.prepare('SELECT page_states,status FROM book_jobs WHERE id=?').get(id)});
 // An unfinished range tried first on pages 1-3, a finished range of pages 4-5 in another book, the run's only part 1-6.
 const book=rows.book();rows.session('translating',[1,2,3]);rows.session('complete',[4,5],rows.book());const part=rows.session('complete',[1,2,3,4,5,6],book);
 const job=rows.job(book,'dddddd'+'.'.repeat(12));
 const removed=await ctx.send(`/api/my/study/history/${part}`,{method:'DELETE'});assert.equal(removed.status,200);assert.equal(removed.body.removedBookId,book);
 assert.deepEqual(jobState(job),{page_states:'.'.repeat(18),status:'paused'},'neither the draft nor the other book holds a translation of the run');
 // A finished part of the run's own book still holds its pages; a finished run becomes paused.
 const other=partRows(ctx,'b'.repeat(64)),own=other.book(),whole=other.session('complete',[1,2,3,4,5,6],own);other.session('complete',[4,5,6],own);
 const done=other.job(own,'d'.repeat(18),'done');
 await ctx.send(`/api/my/study/history/${whole}`,{method:'DELETE'});
 assert.deepEqual(jobState(done),{page_states:'...'+'d'.repeat(15),status:'paused'});
});

test('Giving pages back keeps a progress report that lands at the same moment',async t=>{
 const ctx=await environment(t),rows=partRows(ctx,'c'.repeat(64)),book=rows.book();rows.session('complete',[7,8],book);
 const part=rows.session('complete',[1,2,3,4,5,6],book),job=rows.job(book,'dddddddd'+'.'.repeat(10),'running');
 // The other device's chunk report (pages 9-12, its tokens) commits between the release's read and its write.
 const prepare=ctx.env.DB.prepare;let injected=false;
 ctx.env.DB.prepare=sql=>{if(!injected&&sql.startsWith('UPDATE book_jobs SET page_states=?,status=CASE')){injected=true;ctx.sqlite.prepare("UPDATE book_jobs SET page_states=substr(page_states,1,8)||'dddd'||substr(page_states,13),total_tokens=total_tokens+867,version=version+1 WHERE id=?").run(job);}return prepare(sql);};
 try{assert.equal((await ctx.send(`/api/my/study/history/${part}`,{method:'DELETE'})).status,200);}finally{ctx.env.DB.prepare=prepare;}
 assert.ok(injected);
 const after=(await ctx.send(`/api/my/study/book-jobs/${job}`)).body.job;
 assert.equal(after.pageStates,'......dddddd......');assert.equal(after.usage.total,867);
});

// The browser's run (frontend/whole-book.js) against the real job API: study.js's api() reduced to its contract, the PDF
// service and the chunk steps faked. lose(path,body): the server applies the request but its answer never arrives.
function browserRun(ctx,{steps={},lose=()=>false,offline=()=>false}={}){
 const extracts=[];
 const api=async(path,options={})=>{
  const body=typeof options.body==='string'?JSON.parse(options.body):null;
  if(offline(path,body))throw Object.assign(new Error('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.'),{status:0});
  if(path==='pdf-layout/extract'){const form=options.body,offset=Number(form.get('pageOffset')),count=Number(form.get('pages').split('-')[1]);extracts.push(offset);return {assetId:crypto.randomUUID(),document:{pages:Array.from({length:count},(_,i)=>({number:offset+i+1,blocks:[{id:`p${offset+i+1}-b1`}]}))}};}
  const response=await ctx.call('/api/my/study/'+path,options),data=await response.json();
  if(lose(path,body))throw Object.assign(new Error('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.'),{status:0});
  if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status,data,retryAfter:Number(response.headers.get('Retry-After'))||null});
  return data;
 };
 const run=(runner,{reports=wholeBook.reportStore(),...options}={})=>{
  let current;
  const chunkSteps={open:async()=>null,start:async()=>{},translate:async()=>{current.recordUsage({prompt:600,output:267,thinking:0,total:867,requests:1});return {complete:true,model:'gemini-2.5-flash-lite'};},finish:async()=>({}),...steps};
  current=wholeBook.createBookRun({api,steps:chunkSteps,source:{cut:async pages=>new Uint8Array(pages.length)},sleep:async(seconds,{stopped})=>stopped(),runner,reports,...options});
  return current;
 };
 return {api,run,extracts};
}

test('The browser run reports its tokens once to the job API, after a lost answer and after a pause that could not be sent',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('browser run'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:5});
 const created=async()=>(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha,{totalPages:5}))).body.job;
 // The chunk report reaches the server but its answer is lost: it is sent again and counted once.
 let lost=false,job=await created();
 const once=browserRun(ctx,{lose:(path,body)=>!lost&&Boolean(body?.pages)&&(lost=true)});
 assert.equal((await once.run('aaaaaaaa-0000-4000-8000-000000000001').run(job)).status,'done');assert.ok(lost);
 job=(await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job;
 assert.deepEqual([job.usage.total,job.usage.requests,job.pageStates,job.status,job.runner],[867,1,'ddddd','done',null]);
 // The connection drops mid-chunk and stays down: the run pauses, but its pause cannot be sent. The next run, with
 // the reports kept on the device, sends the tokens of the interrupted chunk once.
 ctx.sqlite.prepare('DELETE FROM book_jobs').run();job=await created();
 let down=false,interrupted;const reports=wholeBook.reportStore();
 const broken=browserRun(ctx,{offline:()=>down,steps:{translate:async()=>{if(!down)interrupted.recordUsage({prompt:5000,output:3000,total:8000,requests:4});down=true;throw Object.assign(new Error('Không kết nối được máy chủ.'),{status:0});}}});
 interrupted=broken.run('aaaaaaaa-0000-4000-8000-000000000002',{reports});
 const paused=await interrupted.run(job);assert.deepEqual([paused.status,paused.reason],['paused','network']);
 assert.equal((await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job.usage.total,0);assert.equal(interrupted.usage.total,8000,'the tokens wait on the device');
 down=false;
 const resumed=browserRun(ctx).run('aaaaaaaa-0000-4000-8000-000000000002',{reports});assert.equal((await resumed.run(job)).status,'done');
 job=(await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job;assert.deepEqual([job.usage.total,job.usage.requests],[8000+867,5]);
 assert.deepEqual(reports.load(job.id),[]);
});

test('A second device never runs a job another device is running; it takes over only once that run stops reporting',async t=>{
 const ctx=await environment(t),bytes=pdfBytes('two devices'),sha=await hex(bytes);await upload(ctx,bytes,sha,{pages:30});
 const {job}=(await ctx.json('/api/my/study/book-jobs','POST',jobBody(sha,{totalPages:30,chunkSize:20}))).body,current=async()=>(await ctx.send(`/api/my/study/book-jobs/${job.id}`)).body.job;
 const laptop='aaaaaaaa-1111-4111-8111-000000000001',phone='bbbbbbbb-2222-4222-8222-000000000002';
 let phoneOutcome=null,laptopRun;
 const phoneSide=browserRun(ctx),laptopSide=browserRun(ctx,{steps:{translate:async()=>{
  // While the laptop works on its first chunk, the phone tries the same job.
  if(!phoneOutcome)phoneOutcome=await phoneSide.run(phone).run(await current());
  laptopRun.recordUsage({total:867,requests:1});return {complete:true,model:'gemini-2.5-flash-lite'};
 }}});
 laptopRun=laptopSide.run(laptop);
 assert.equal((await laptopRun.run(job)).status,'done');
 assert.deepEqual([phoneOutcome.status,phoneOutcome.reason],['paused','busy']);assert.match(phoneOutcome.message,/^Quyển này đang được dịch ở một thiết bị khác/u);
 assert.deepEqual(phoneSide.extracts,[],'the phone extracted and paid for nothing');assert.deepEqual(laptopSide.extracts,[0,20]);
 let final=await current();assert.deepEqual([final.pageStates,final.status,final.usage.total],['d'.repeat(30),'done',867*2]);
 // The laptop is closed mid-chunk: its lease runs out, the phone takes over, and the laptop's late report is refused.
 ctx.sqlite.prepare("UPDATE book_jobs SET page_states=?,status='running',runner_id=?,lease_until=? WHERE id=?").run('d'.repeat(20)+'.'.repeat(10),laptop,Date.now()-1,job.id);
 let late=null;
 const takeover=browserRun(ctx,{steps:{translate:async()=>{
  // The laptop wakes up and reports the chunk it was working on.
  if(!late)late=await browserRun(ctx).run(laptop).run({...final,pageStates:'d'.repeat(20)+'.'.repeat(10),status:'running'});
  return {complete:true,model:'gemini-2.5-flash-lite'};
 }}});
 assert.equal((await takeover.run(phone).run(await current())).status,'done');
 assert.deepEqual([late.status,late.reason],['paused','busy']);
 final=await current();assert.deepEqual([final.pageStates,final.status,final.runner],['d'.repeat(30),'done',null]);
});
