import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import worker from './worker.js';
import {hashToken} from './reader-auth.js';
import {bookSources,planBook,assembleBook,hasTranslatedPdf} from '../frontend/book-assembly.js';

// The CommonJS build: the package's ES build imports JSON without import attributes, which Node refuses.
const PDFLib=createRequire(import.meta.url)('@cantoo/pdf-lib');
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const standardFontDataUrl=new URL('../node_modules/pdfjs-dist/standard_fonts/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1');

class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
class D1Database{
 constructor(database){this.database=database;}
 prepare(sql){return new D1Statement(this.database,sql);}
 async batch(statements){this.database.exec('BEGIN');try{const results=statements.map(s=>s.execute());this.database.exec('COMMIT');return results;}catch(error){this.database.exec('ROLLBACK');throw error;}}
}
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
// R2 as the Worker sees it: a put checked against its sha256, ranged reads, and listings two keys a page (so every
// caller has to follow the cursor).
class MemoryR2{
 constructor(){this.values=new Map();}
 async put(key,value,options={}){
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice():new Uint8Array(await new Response(value).arrayBuffer());
  if(options.sha256&&hex(bytes)!==String(options.sha256))throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
  this.values.set(key,{bytes,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});
 }
 async get(key,{range}={}){
  const item=this.values.get(key);if(!item)return null;const size=item.bytes.length;let bytes=item.bytes;
  if(range){
   const start=range.suffix!==undefined?Math.max(0,size-range.suffix):range.offset??0,length=range.suffix!==undefined?Math.min(range.suffix,size):range.length??size-start;
   if(range.suffix===0||start>=size||length<=0)throw new Error('get: The requested range is not satisfiable (10039)');
   bytes=bytes.slice(start,start+length);
  }
  return {body:bytes,size,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,arrayBuffer:async()=>bytes.slice().buffer,text:async()=>new TextDecoder().decode(bytes),json:async()=>JSON.parse(new TextDecoder().decode(bytes))};
 }
 async head(key){const item=this.values.get(key);return item?{size:item.bytes.length,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata}:null;}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 // The cursor names the last key returned, as R2's does, so deleting a page while listing skips nothing.
 async list({prefix='',cursor=''}={}){
  const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)&&key>cursor).sort(),page=keys.slice(0,2);
  return {objects:page.map(key=>({key,size:this.values.get(key).bytes.length,customMetadata:this.values.get(key).customMetadata})),truncated:keys.length>2,cursor:page.at(-1)};
 }
 keys(prefix=''){return [...this.values.keys()].filter(key=>key.startsWith(prefix));}
}
const ADMIN='admin-token-for-library-books-tests-0123',STUDENT='student-session-for-library-books',ORIGIN='https://school.test';
async function environment(t,{upTo='9999'}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const dir=new URL('../database/migrations/',import.meta.url);
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')&&n.slice(0,4)<=upTo).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('student-1','sub-1','hs@example.test','Học sinh');
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(STUDENT),'student-1',Date.now()+3600000);
 const env={DB:new D1Database(sqlite),FILES:new MemoryR2(),ADMIN_TOKEN:ADMIN};
 const call=(path,{method='GET',body,headers={},admin=false,student=false}={})=>worker.fetch(new Request(ORIGIN+path,{method,body,headers:{...headers,...(admin?{Authorization:`Bearer ${ADMIN}`}:{}),...(student?{Cookie:`cat_hien_session=${STUDENT}`}:{}),...(typeof body==='string'?{'Content-Type':'application/json'}:{})}}),env,{});
 const data=async(path,options)=>{const response=await call(path,options);return {status:response.status,body:await response.json()};};
 return {sqlite,env,call,data};
}
async function pdfOf(labels){const doc=await PDFLib.PDFDocument.create(),font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);for(const label of labels)doc.addPage([595,842]).drawText(label,{x:60,y:700,size:20,font});return new Uint8Array(await doc.save());}
const original=count=>pdfOf(Array.from({length:count},(_,i)=>`Original page ${i+1}`));
async function createSample(data,{slug='toan-a1',author='NXB Giáo dục Việt Nam',genre='Toán học · STEM'}={}){
 const created=await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Toán A1 (Ví dụ mẫu)',genre,visibility:'private',sample:slug,author})});
 assert.equal(created.status,201,JSON.stringify(created.body));return created.body.id;
}
const putSource=(call,storyId,bytes,{sha256=hex(bytes),pages=6,filename='Toán A1 – trích đoạn.pdf',length=true}={})=>call(`/api/stories/${storyId}/sources/${sha256}`,{method:'PUT',admin:true,body:bytes,headers:{'Content-Type':'application/pdf','X-PDF-Pages':String(pages),'X-Source-Filename':encodeURIComponent(filename),...(length?{'Content-Length':String(bytes.length)}:{})}});
async function addPart(call,storyId,{title='Trang 2–3',file,name='c01.vi.pdf',sha256,pages,position}={}){
 const form=new FormData();form.set('confirmed','true');form.set('title',title);form.set('file',new File([file],name,{type:name.endsWith('.pdf')?'application/pdf':'text/plain'}));
 if(sha256!==undefined)form.set('source_sha256',sha256);if(pages!==undefined)form.set('source_pages',typeof pages==='string'?pages:JSON.stringify(pages));if(position!==undefined)form.set('position',String(position));
 const response=await call(`/api/stories/${storyId}/chapters`,{method:'POST',admin:true,body:form});return {status:response.status,body:await response.json()};
}
const studyBook=sqlite=>{sqlite.prepare("INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility,author) VALUES('book-1','Sách của học sinh','Chuyên khảo · Nghiên cứu','study-book:book-1','student-1','private','Bản dịch cá nhân')").run();return 'book-1';};

test('a sample is a library draft keyed by its slug: one book per slug, never a student\'s, author kept',async t=>{
 const {sqlite,data}=await environment(t),id=await createSample(data);
 assert.deepEqual({...sqlite.prepare('SELECT source_url,author,visibility,owner_user_id FROM stories WHERE id=?').get(id)},{source_url:'sample:toan-a1',author:'NXB Giáo dục Việt Nam',visibility:'private',owner_user_id:null});
 assert.deepEqual(await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Lần hai',genre:'Toán học · STEM',sample:'toan-a1'})}),{status:409,body:{error:'Đã có ví dụ mẫu “toan-a1”.',id}});
 for(const [body,pattern] of [[{sample:'Toan_A1'},/Mã ví dụ mẫu/u],[{sample:'-ab'},/Mã ví dụ mẫu/u],[{sample:'ab',owner_user_id:'student-1'},/không gắn với tài khoản/u],[{author:'x'.repeat(201)},/tác giả/u],[{author:'Hai\ndòng'},/tác giả/u]]){
  const refused=await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Sách',genre:'Toán học · STEM',...body})});
  assert.equal(refused.status,400,JSON.stringify(body));assert.match(refused.body.error,pattern);
 }
 const plain=await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Sách thường',genre:'Giáo dục'})});
 assert.deepEqual({...sqlite.prepare('SELECT source_url,author,visibility FROM stories WHERE id=?').get(plain.body.id)},{source_url:null,author:'Chưa cập nhật',visibility:'public'});
 assert.equal((await data('/api/stories',{method:'POST',body:JSON.stringify({title:'x',genre:'Giáo dục',sample:'x1'})})).status,401);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM stories').get().n,2);
});

test('a draft sample stays hidden until it has a part; visibility and author never change a student\'s book',async t=>{
 const {sqlite,call,data}=await environment(t),id=await createSample(data);
 assert.deepEqual((await data('/api/library')).body,[]);
 assert.equal((await call(`/api/read/${id}`)).status,404);assert.equal((await call(`/api/library/${id}/assembly`)).status,404);
 assert.equal((await call(`/api/read/${id}`,{admin:true})).status,200);assert.equal((await call(`/api/library/${id}/assembly`,{admin:true})).status,200);
 assert.deepEqual(await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})}),{status:409,body:{error:'Ví dụ mẫu chưa có phần nào.'}});
 assert.equal((await addPart(call,id,{file:await pdfOf(['Ban dich'])})).status,201);
 assert.deepEqual(await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})}),{status:200,body:{ok:true,visibility:'public'}});
 const [row]=(await data('/api/library')).body;assert.deepEqual([row.id,row.sample,row.author],[id,1,'NXB Giáo dục Việt Nam']);
 assert.equal((await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'private'})})).status,200);
 assert.deepEqual((await data('/api/library')).body,[]);
 assert.equal((await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'hidden'})})).status,400);
 // Students' books: their own study books and the books of their requests keep the visibility and author they have.
 const book=studyBook(sqlite);sqlite.prepare("INSERT INTO stories(id,title,genre,owner_user_id,visibility) VALUES('request-book','Yêu cầu','Giáo dục','student-1','public')").run();
 for(const [target,visibility] of [[book,'public'],['request-book','private']])assert.deepEqual(await data(`/api/stories/${target}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility})}),{status:404,body:{error:'Chỉ đổi được chế độ hiển thị của sách trong kho Hoa Trí.'}});
 assert.deepEqual(sqlite.prepare("SELECT id,visibility FROM stories WHERE owner_user_id IS NOT NULL ORDER BY id").all().map(r=>[r.id,r.visibility]),[['book-1','private'],['request-book','public']]);
 assert.equal((await data(`/api/stories/${book}`,{method:'PATCH',admin:true,body:JSON.stringify({author:'Ai đó'})})).status,404);
 assert.equal(sqlite.prepare('SELECT author FROM stories WHERE id=?').get(book).author,'Bản dịch cá nhân');
 assert.deepEqual(await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({author:'  '})}),{status:200,body:{ok:true,author:'Chưa cập nhật'}});
 assert.deepEqual(await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({author:'Nhóm tác giả SGK'})}),{status:200,body:{ok:true,author:'Nhóm tác giả SGK'}});
 assert.equal((await data(`/api/stories/${id}`,{method:'PATCH',body:JSON.stringify({visibility:'public'})})).status,401);
});

test('the original is stored once under library/<book>/sources/, checked against its hash and as a PDF',async t=>{
 const {env,call,data,sqlite}=await environment(t),id=await createSample(data),bytes=await original(6),sha256=hex(bytes),key=`library/${id}/sources/${sha256}.pdf`;
 const stored=await putSource(call,id,bytes);
 assert.equal(stored.status,201);assert.deepEqual(await stored.json(),{sha256,pages:6,filename:'Toán A1 – trích đoạn.pdf',stored:true});
 assert.deepEqual(env.FILES.values.get(key).customMetadata,{filename:'Toán A1 – trích đoạn.pdf',pages:'6'});assert.deepEqual(env.FILES.values.get(key).bytes,bytes);
 // Without a declared length the body is read first; the same file is not stored twice.
 const again=await putSource(call,id,bytes,{length:false});assert.equal(again.status,200);assert.equal((await again.json()).stored,false);
 const head=await call(`/api/stories/${id}/sources/${sha256}`,{method:'HEAD',admin:true});assert.equal(head.status,200);assert.equal(head.headers.get('X-PDF-Pages'),'6');assert.equal(decodeURIComponent(head.headers.get('X-Source-Filename')),'Toán A1 – trích đoạn.pdf');
 assert.equal((await call(`/api/stories/${id}/sources/${'b'.repeat(64)}`,{method:'HEAD',admin:true})).status,404);
 const other=await original(3);
 for(const [response,status,pattern] of [
  [await putSource(call,id,other,{sha256:'c'.repeat(64)}),400,/không khớp/u],
  [await putSource(call,id,other,{sha256:'c'.repeat(64),length:false}),400,/không khớp/u],
  [await putSource(call,id,new TextEncoder().encode('<html>not a pdf</html>'),{}),400,/không phải PDF/u],
  [await putSource(call,id,other,{pages:0}),400,/X-PDF-Pages/u],
  [await putSource(call,id,other,{filename:'a\u0001b.pdf'}),400,/Tên tệp gốc/u],
  [await call(`/api/stories/${id}/sources/XYZ`,{method:'PUT',admin:true,body:other,headers:{'X-PDF-Pages':'3'}}),400,/SHA-256/u],
  [await call(`/api/stories/${id}/sources/${hex(other)}`,{method:'PUT',admin:true,body:other,headers:{'X-PDF-Pages':'3','Content-Length':String(101*1024*1024)}}),413,/quá lớn|tối đa/u]
 ]){assert.equal(response.status,status);assert.match((await response.json()).error,pattern);}
 assert.deepEqual(env.FILES.keys('library/'),[key],'nothing else was stored');
 assert.equal((await putSource(call,studyBook(sqlite),bytes)).status,404,'a student\'s book keeps no library original');
 assert.equal((await putSource(call,id,bytes,{})).status,200);
 assert.equal((await call(`/api/stories/${id}/sources/${sha256}`,{method:'PUT',body:bytes,headers:{'X-PDF-Pages':'6'}})).status,401);
 await putSource(call,id,other,{pages:3,filename:''});
 assert.deepEqual((await data(`/api/stories/${id}/sources`,{admin:true})).body.sources.map(s=>[s.sha256,s.pages,s.filename,s.size]).sort(),[[sha256,6,'Toán A1 – trích đoạn.pdf',bytes.length],[hex(other),3,'nguyen-tac.pdf',other.length]].sort());
 // A part still on an original keeps it; a cover taken from it forgets its page when it goes.
 assert.equal((await addPart(call,id,{file:await pdfOf(['A','B']),sha256,pages:[2,3]})).status,201);
 assert.deepEqual(await data(`/api/stories/${id}/sources/${sha256}`,{method:'DELETE',admin:true}),{status:409,body:{error:'Còn phần sách dùng PDF gốc này; hãy xóa phần đó trước.'}});
 sqlite.prepare('UPDATE stories SET cover_page=1,cover_source_sha256=? WHERE id=?').run(hex(other),id);
 assert.deepEqual(await data(`/api/stories/${id}/sources/${hex(other)}`,{method:'DELETE',admin:true}),{status:200,body:{ok:true}});
 assert.deepEqual({...sqlite.prepare('SELECT cover_page,cover_source_sha256 FROM stories WHERE id=?').get(id)},{cover_page:null,cover_source_sha256:null});
 assert.deepEqual(env.FILES.keys('library/'),[key]);
});

test('a PDF part maps to pages of the stored original; bad mappings, text parts and students\' books are refused',async t=>{
 const {sqlite,call,data,env}=await environment(t),id=await createSample(data),bytes=await original(6),sha256=hex(bytes),part=await pdfOf(['Ban dich 2','Ban dich 3']);
 assert.deepEqual(await addPart(call,id,{file:part,sha256,pages:[2,3]}),{status:409,body:{error:'Hãy tải PDF gốc của sách lên trước.'}});
 await putSource(call,id,bytes);
 for(const [options,pattern] of [[{pages:[0,1]},/Danh sách trang/u],[{pages:[2,7]},/từ 1 đến 6/u],[{pages:[2,2]},/Danh sách trang/u],[{pages:[]},/Danh sách trang/u],[{pages:'2-3'},/Danh sách trang/u],[{pages:[2.5]},/Danh sách trang/u],[{sha256:'zz',pages:[2]},/SHA-256/u],[{sha256:''},/Danh sách trang|SHA-256/u],[{position:0},/Vị trí/u],[{position:'x'},/Vị trí/u],[{file:'văn bản',name:'c01.txt',pages:[2]},/Chỉ phần PDF/u]]){
  const refused=await addPart(call,id,{file:part,sha256,pages:[2,3],...options});assert.equal(refused.status,400,JSON.stringify(options));assert.match(refused.body.error,pattern);
 }
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM chapters').get().n,0);assert.deepEqual(env.FILES.keys('reader/'),[],'a refused part stores no file');
 const book=studyBook(sqlite);
 assert.match((await addPart(call,book,{file:part,sha256,pages:[2,3]})).body.error,/kho Hoa Trí/u);
 // Positions order the parts whatever order they arrive in; an upload without the new fields is the row of before.
 const second=await addPart(call,id,{title:'Trang 5',file:await pdfOf(['Ban dich 5']),sha256,pages:[5],position:2});
 const first=await addPart(call,id,{title:'Trang 2–3',file:part,sha256:sha256.toUpperCase(),pages:'[2,3]',position:1});
 const plain=await addPart(call,id,{title:'Phụ lục',file:await pdfOf(['Phu luc'])});
 assert.deepEqual([first.status,second.status,plain.status],[201,201,201]);
 assert.deepEqual(sqlite.prepare('SELECT title,position,source_sha256,source_pages,source_total_pages,source_filename FROM chapters ORDER BY position IS NULL,position').all().map(r=>({...r})),[
  {title:'Trang 2–3',position:1,source_sha256:sha256,source_pages:'[2,3]',source_total_pages:6,source_filename:'Toán A1 – trích đoạn.pdf'},
  {title:'Trang 5',position:2,source_sha256:sha256,source_pages:'[5]',source_total_pages:6,source_filename:'Toán A1 – trích đoạn.pdf'},
  {title:'Phụ lục',position:null,source_sha256:null,source_pages:null,source_total_pages:null,source_filename:null}]);
 const read=(await data(`/api/read/${id}`,{admin:true})).body;
 assert.deepEqual(read.map(c=>[c.title,c.position,c.sample,c.source_sha256,c.source_pages,c.source_total_pages]),[['Trang 2–3',1,1,sha256,[2,3],6],['Trang 5',2,1,sha256,[5],6],['Phụ lục',null,1,null,null,null]]);
});

test('the public assembly has the shape of a student\'s book; drafts and students\' books are not in it',async t=>{
 const {sqlite,call,data}=await environment(t),id=await createSample(data),bytes=await original(6),sha256=hex(bytes);
 await putSource(call,id,bytes);
 await addPart(call,id,{title:'Trang 2–3',file:await pdfOf(['A','B']),sha256,pages:[2,3],position:1});
 const text=new FormData();text.set('confirmed','true');text.set('title','Lời nói đầu');text.set('position','2');text.set('file',new File(['Lời nói đầu của sách.'],'loi-noi-dau.txt'));
 assert.equal((await call(`/api/stories/${id}/chapters`,{method:'POST',admin:true,body:text})).status,201);
 await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})});
 const assembly=(await data(`/api/library/${id}/assembly`)).body;
 assert.deepEqual(Object.keys(assembly),['id','title','sample','cover','parts','storedSources']);assert.equal(assembly.sample,true);
 assert.deepEqual(Object.keys(assembly.parts[0]),['id','title','position','mime','sessionId','filename','pageStart','pageEnd','totalPages','sha256','pages','updatedAt','translatedAt','layout','file']);
 assert.deepEqual(assembly.parts.map(p=>[p.title,p.mime,p.filename,p.pageStart,p.pageEnd,p.totalPages,p.sha256,p.pages,p.layout,Boolean(p.file)]),[['Trang 2–3','application/pdf','Toán A1 – trích đoạn.pdf',2,3,6,sha256,[2,3],true,true],['Lời nói đầu','text/plain','',null,null,null,null,null,false,false]]);
 assert.deepEqual(assembly.storedSources,[{sha256,pages:6,url:`/api/library/${id}/sources/${sha256}`}]);
 assert.deepEqual(assembly.cover,{image:false,page:null,sha256:null});
 // The same answer for a student's book as for one that does not exist, even to its owner.
 const book=studyBook(sqlite);
 for(const [path,options] of [[`/api/library/${book}/assembly`,{student:true}],[`/api/library/${book}/assembly`,{admin:true}],['/api/library/no-such-book/assembly',{}]])assert.equal((await call(path,options)).status,404,path);
 assert.equal((await call(`/api/library/${id}/assembly`,{method:'POST'})).status,405);
});

test('the original is public with its book and served by byte ranges; another book\'s hash or a draft is not found',async t=>{
 const {call,data}=await environment(t),id=await createSample(data),bytes=await original(6),sha256=hex(bytes),url=`/api/library/${id}/sources/${sha256}`;
 await putSource(call,id,bytes);await addPart(call,id,{file:await pdfOf(['A']),sha256,pages:[2]});
 assert.equal((await call(url)).status,404,'a draft');assert.equal((await call(url,{admin:true})).status,200);
 await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})});
 const whole=await call(url);
 assert.equal(whole.status,200);assert.equal(whole.headers.get('Content-Type'),'application/pdf');assert.equal(whole.headers.get('Accept-Ranges'),'bytes');assert.ok(whole.headers.get('Content-Disposition').startsWith(`inline; filename="nguyen-tac.pdf"; filename*=UTF-8''${encodeURIComponent('Toán A1 – trích đoạn.pdf')}`));
 assert.deepEqual(new Uint8Array(await whole.arrayBuffer()),bytes);
 const first=await call(url,{headers:{Range:'bytes=0-99'}});assert.equal(first.status,206);assert.equal(first.headers.get('Content-Range'),`bytes 0-99/${bytes.length}`);assert.deepEqual(new Uint8Array(await first.arrayBuffer()),bytes.slice(0,100));
 const tail=await call(url,{headers:{Range:'bytes=-50'}});assert.equal(tail.status,206);assert.equal(tail.headers.get('Content-Range'),`bytes ${bytes.length-50}-${bytes.length-1}/${bytes.length}`);assert.deepEqual(new Uint8Array(await tail.arrayBuffer()),bytes.slice(-50));
 const open=await call(url,{headers:{Range:`bytes=${bytes.length-10}-`}});assert.equal(open.status,206);assert.equal((await open.arrayBuffer()).byteLength,10);
 assert.equal((await call(url,{headers:{Range:`bytes=${bytes.length}-`}})).status,416);
 assert.equal((await call(url,{headers:{Range:'bytes=5-1'}})).status,200,'a range that makes no sense is ignored');
 const otherBook=await createSample(data,{slug:'ly-10'}),other=await original(2);await putSource(call,otherBook,other,{pages:2});
 assert.equal((await call(`/api/library/${id}/sources/${hex(other)}`)).status,404,'a hash of another book');
 assert.equal((await call(`/api/library/${id}/sources/ABC`)).status,400);
});

test('a cover records its page of the original, and a new cover replaces the old image',async t=>{
 const {sqlite,env,call,data}=await environment(t),id=await createSample(data),sha256='d'.repeat(64);
 const jpeg=n=>new File([new Uint8Array([0xff,0xd8,0xff,0xe0,n,1,2,3])],'cover.jpg',{type:'image/jpeg'});
 const upload=fields=>{const form=new FormData();for(const [key,value] of Object.entries(fields))form.set(key,value);return call(`/api/stories/${id}/cover`,{method:'POST',admin:true,body:form});};
 assert.equal((await upload({cover:jpeg(1),page:'1',sha256})).status,200);
 assert.deepEqual({...sqlite.prepare('SELECT cover_page,cover_source_sha256 FROM stories WHERE id=?').get(id)},{cover_page:1,cover_source_sha256:sha256});
 const firstKey=sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(id).cover_key;
 for(const fields of [{cover:jpeg(2),page:'0'},{cover:jpeg(2),page:'x'},{cover:jpeg(2),page:'1',sha256:'nope'}])assert.equal((await upload(fields)).status,400);
 assert.deepEqual(env.FILES.keys('covers/'),[firstKey],'a refused cover stores nothing');
 assert.equal((await upload({cover:jpeg(3)})).status,200);
 const secondKey=sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(id).cover_key;
 assert.deepEqual(env.FILES.keys('covers/'),[secondKey]);assert.notEqual(secondKey,firstKey);
 assert.deepEqual({...sqlite.prepare('SELECT cover_page,cover_source_sha256 FROM stories WHERE id=?').get(id)},{cover_page:null,cover_source_sha256:null});
 assert.deepEqual((await data(`/api/library/${id}/assembly`,{admin:true})).body.cover,{image:true,page:null,sha256:null});
});

test('deleting a library book removes its parts, covers and originals, page after page of the listing',async t=>{
 const {sqlite,env,call,data}=await environment(t),id=await createSample(data);
 for(const count of [2,3,4])await putSource(call,id,await original(count),{pages:count});
 const bytes=await original(5);await putSource(call,id,bytes,{pages:5});await addPart(call,id,{file:await pdfOf(['A']),sha256:hex(bytes),pages:[1]});
 const keep=await createSample(data,{slug:'giu-lai'}),kept=await original(1);await putSource(call,keep,kept,{pages:1});
 assert.equal(env.FILES.keys(`library/${id}/`).length,4);
 assert.equal((await call(`/api/stories/${id}`,{method:'DELETE',admin:true})).status,200);
 assert.deepEqual(env.FILES.keys(`library/${id}/`),[]);assert.deepEqual(env.FILES.keys('reader/'),[]);assert.equal(env.FILES.keys(`library/${keep}/`).length,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM chapters').get().n,0);
});

test('"Tải cả quyển" rebuilds a sample like its original: cover and untranslated pages original, translations in place',async t=>{
 const {call,data}=await environment(t),id=await createSample(data),bytes=await original(6),sha256=hex(bytes);
 await putSource(call,id,bytes);
 await addPart(call,id,{title:'Trang 2–3',file:await pdfOf(['Ban dich trang 2','Ban dich trang 3']),sha256,pages:[2,3],position:1});
 await addPart(call,id,{title:'Trang 5',file:await pdfOf(['Ban dich trang 5']),sha256,pages:[5],position:2});
 await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})});
 // Exactly what the reader does, with nothing but public URLs.
 const info=(await data(`/api/library/${id}/assembly`)).body,{sources,unplaced}=bookSources(info.parts),stored=new Map(info.storedSources.map(item=>[item.sha256,item]));
 assert.equal(unplaced.length,0);assert.equal(sources.length,1);assert.ok(sources[0].parts.every(hasTranslatedPdf));
 assert.deepEqual(planBook(sources,new Map([[sources[0].key,stored.get(sha256).pages]])).entries.map(e=>e.from),['original','translated','translated','original','translated','original']);
 const fetchBytes=async url=>{const response=await call(url);assert.equal(response.status,200,url);return new Uint8Array(await response.arrayBuffer());};
 const result=await assembleBook({PDFLib,pdfjs:null,title:info.title,sources,loadSource:source=>fetchBytes(stored.get(source.sha256).url),loadPart:part=>fetchBytes(part.file),pageCounts:new Map([[sources[0].key,stored.get(sha256).pages]])});
 assert.equal(result.pages,6);
 const pdf=await pdfjs.getDocument({data:result.bytes,standardFontDataUrl,verbosity:0}).promise,texts=[];
 for(let n=1;n<=pdf.numPages;n++)texts.push((await (await pdf.getPage(n)).getTextContent()).items.map(item=>item.str).join(''));
 await pdf.loadingTask.destroy();
 assert.deepEqual(texts,['Original page 1','Ban dich trang 2','Ban dich trang 3','Original page 4','Ban dich trang 5','Original page 6']);
});

test('/api/library lists samples first with sample, mapped_parts and translated_pages; a sample never matches a student\'s file',async t=>{
 const {sqlite,call,data}=await environment(t);
 const plain=(await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Sách đã duyệt',genre:'Lịch sử Trung Hoa'})})).body.id;
 await addPart(call,plain,{title:'Chương 1',file:'Nội dung',name:'chuong-1.txt'});
 sqlite.prepare("UPDATE stories SET created_at='2030-01-01 00:00:00' WHERE id=?").run(plain);
 const id=await createSample(data),bytes=await original(6),sha256=hex(bytes);
 await putSource(call,id,bytes);await addPart(call,id,{file:await pdfOf(['A','B']),sha256,pages:[2,3],position:1});await addPart(call,id,{title:'Trang 5',file:await pdfOf(['C']),sha256,pages:[5],position:2});
 await data(`/api/stories/${id}`,{method:'PATCH',admin:true,body:JSON.stringify({visibility:'public'})});
 const library=(await data('/api/library')).body;
 assert.deepEqual(library.map(row=>[row.id,row.sample,row.chapters,row.mapped_parts,row.translated_pages,row.translation_status]),[[id,1,2,2,3,null],[plain,0,1,0,0,null]]);
 const status=(await data('/api/status',{admin:true})).body;assert.deepEqual(status.samples,{pages:true});
 // No job is ever made for a sample, so the workspace never says a teacher reviewed its translation.
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
 assert.deepEqual((await data(`/api/my/study/library-match?sha256=${sha256}`,{student:true})).body,{match:null});
});

test('a database without migration 0015 still serves the library and the reader, and says so to the sample tool',async t=>{
 const {sqlite,call,data}=await environment(t,{upTo:'0014'});
 const id=(await data('/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Ví dụ cũ',genre:'Giáo dục',sample:'cu'})})).body.id;
 assert.equal((await addPart(call,id,{title:'Phần 1',file:await pdfOf(['A']),position:1})).status,201,'a part without page mapping uses the old columns only');
 const library=(await data('/api/library')).body;assert.deepEqual(library.map(r=>[r.id,r.sample,r.chapters,r.mapped_parts,r.translated_pages]),[[id,1,1,0,0]]);
 const read=(await data(`/api/read/${id}`)).body;assert.deepEqual(read.map(c=>[c.title,c.position,c.sample,c.source_pages]),[['Phần 1',1,1,null]]);
 assert.deepEqual((await data('/api/status',{admin:true})).body.samples,{pages:false});
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM chapters').get().n,1);
});
