import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {studyHistoryRoute} from './study-history.js';
import {studyBookRoute,keepSource,sourceKey} from './study-books.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {studyRoute} from './study-translation.js';
import {adminContent} from './admin-content.js';
import {bookSources,planBook,missingPdfNote} from '../frontend/book-assembly.js';

const reader={id:'student-books',name:'Lan'},other={id:'student-other',name:'Minh'},origin='https://example.test';
const png='data:image/png;base64,AA==',JPEG=new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1]);
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
const byteSize=value=>typeof value==='string'?new TextEncoder().encode(value).length:value instanceof Blob?value.size:value?.byteLength??0;
class MemoryFiles{
 constructor(){this.values=new Map();this.writes=[];this.deletes=[];this.failOn=null;this.failDelete=null;}
 // A streamed upload is read to the end, as R2 does; uploaded is when the object was stored.
 async put(key,value,options){if(this.failOn?.(key))throw new Error('R2 unavailable');if(value instanceof ReadableStream)value=new Uint8Array(await new Response(value).arrayBuffer());this.values.set(key,{value,options,uploaded:new Date()});this.writes.push(key);}
 // R2 deletes one key or a list of keys (the admin cleanup sends lists).
 async delete(keys){for(const key of [keys].flat()){if(this.failDelete?.(key))throw new Error('R2 unavailable');this.deletes.push(key);this.values.delete(key);}}
 async list({prefix=''}={}){return {objects:[...this.values.entries()].filter(([key])=>key.startsWith(prefix)).map(([key,item])=>({key,size:byteSize(item.value),uploaded:item.uploaded})),truncated:false};}
 async head(key){const item=this.values.get(key);return item?{customMetadata:item.options?.customMetadata||{},httpMetadata:item.options?.httpMetadata||{}}:null;}
 async get(key){
  const item=this.values.get(key);if(!item)return null;const bytes=async()=>typeof item.value==='string'?new TextEncoder().encode(item.value):item.value instanceof Blob?new Uint8Array(await item.value.arrayBuffer()):new Uint8Array(item.value);
  return {get body(){return new ReadableStream({async start(controller){controller.enqueue(await bytes());controller.close();}});},customMetadata:item.options?.customMetadata||{},httpMetadata:item.options?.httpMetadata||{},arrayBuffer:async()=>(await bytes()).slice().buffer,json:async()=>JSON.parse(new TextDecoder().decode(await bytes())),text:async()=>new TextDecoder().decode(await bytes())};
 }
}
function environment(t,vars={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 for(const user of [reader,other])sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(user.id,`sub-${user.id}`,`${user.id}@example.test`,user.name);
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,env:{DB,FILES:new MemoryFiles(),PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test',PDF_LAYOUT_SERVICE_TOKEN:'service-secret',...vars}};
}
const hex=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const json=(path,body,method='POST')=>new Request(origin+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
let assetCounter=0;
async function range(env,pages,{owner=reader,sha256='a'.repeat(64),totalPages=10,filename='toan.pdf'}={}){
 const assetId=`33333333-3333-4333-8333-${String(++assetCounter).padStart(12,'0')}`;
 const manifest={version:1,totalPages,sourceSha256:sha256,pages:pages.map(number=>({number,width:595.2,height:842,original:png,background:png,blocks:[{id:`p${number}-b0`,source:`第${number}页`,box:[20,20,200,80],fontSize:12}]}))};
 await env.FILES.put(`study/${owner.id}/pdf-layout/${assetId}/manifest.json`,JSON.stringify(manifest));
 const parts=manifest.pages.map(page=>page.blocks[0].source);
 return {assetId,body:(extra={},{edit=''}={})=>({title:'Toán 1',filename,domain:'math',...extra,state:{source:parts.join('\n\n'),parts,translationParts:parts.map((_,i)=>`Trang ${pages[i]}.${edit}`),done:parts.length,pdfLayout:{assetId}}})};
}
// A range translated in the browser (no layout mode): its pages come from the client and it has no manifest.
const textBody=(title,filename,extra={})=>{const parts=['第一段','第二段'];return {title,filename,domain:'general',...extra,state:{source:parts.join('\n\n'),parts,translationParts:['Đoạn một.','Đoạn hai.'],done:2}};};
const coverKeys=env=>[...env.FILES.values.keys()].filter(key=>key.startsWith('covers/'));
async function save(env,body,owner=reader){const response=await studyHistoryRoute(json('/api/my/study/history',body),env,'/api/my/study/history',owner);return {...await response.json(),http:response.status};}
const route=async(env,path,init={},owner=reader)=>{const response=await studyBookRoute(new Request(origin+path,init),env,path,owner);return response;};
const coverForm=(bytes,fields={})=>{const form=new FormData();if(bytes)form.set('cover',new File([bytes],'cover.jpg',{type:'image/jpeg'}));for(const [key,value] of Object.entries(fields))form.set(key,String(value));return {method:'POST',body:form};};

test('Extraction keeps the whole uploaded PDF once per student and file, named by the hash the Worker computed',async t=>{
 const {env}=environment(t),pdf='%PDF-1.7\nwhole textbook, ten pages';let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({document:{version:1,totalPages:10,pages:[{number:4,width:595,height:842,original:png,background:png,blocks:[{id:'p4-b0',source:'定义向量。',box:[20,20,200,80],fontSize:12}]}]},originalPdfBase64:btoa('%PDF-1.7\npage 4')});});
 const extract=async(owner,content=pdf,sha256='f'.repeat(64))=>{const form=new FormData();form.set('file',new File([content],'Toán 1.pdf',{type:'application/pdf'}));form.set('pages','4');form.set('sha256',sha256);const response=await pdfLayoutRoute(new Request(origin+'/api/my/study/pdf-layout/extract',{method:'POST',body:form}),env,'/api/my/study/pdf-layout/extract',owner);assert.equal(response.status,201);return (await response.json()).document;};
 const sha=await hex(new TextEncoder().encode(pdf)),key=sourceKey(reader.id,sha);
 const first=await extract(reader);assert.equal(first.sourceSha256,sha);
 const kept=env.FILES.values.get(key);assert.equal(await kept.value.text(),pdf);assert.deepEqual(kept.options.customMetadata,{filename:'Toán 1.pdf',pages:'10'});assert.equal(kept.options.httpMetadata.contentType,'application/pdf');
 await extract(reader);await extract(reader);assert.equal(env.FILES.writes.filter(write=>write===key).length,1,'the same file is stored once');
 await extract(other);assert.ok(env.FILES.values.has(sourceKey(other.id,sha)),'each student keeps their own copy');
 await extract(reader,'%PDF-1.7\nanother book');assert.equal([...env.FILES.values.keys()].filter(item=>item.startsWith(`study/${reader.id}/sources/`)).length,2);assert.equal(calls,5);
 // Storage trouble never blocks translating: the student is told the book download will ask for the file instead.
 env.FILES.failOn=item=>item.includes('/sources/');const warned=await extract(reader,'%PDF-1.7\nthird book');assert.match(warned.warnings.join('\n'),/Chưa lưu được bản PDF gốc/);
});

test('A kept original is served only to its owner, by its exact hash',async t=>{
 const {env}=environment(t),sha='c'.repeat(64);await keepSource(env,reader.id,sha,new Blob(['%PDF-1.7\nmine']),{filename:'Toán 1.pdf',pages:10});
 const own=await route(env,`/api/my/study/sources/${sha}`);assert.equal(own.status,200);assert.equal(own.headers.get('Content-Type'),'application/pdf');assert.equal(own.headers.get('Cache-Control'),'no-store');assert.match(own.headers.get('Content-Disposition'),/To%C3%A1n%201\.pdf/);assert.equal(await own.text(),'%PDF-1.7\nmine');
 assert.equal((await route(env,`/api/my/study/sources/${sha}`,{},other)).status,404);
 for(const bad of ['C'.repeat(64),'c'.repeat(63),'..%2F'+'c'.repeat(62),'','c'.repeat(64)+'.pdf'])assert.equal((await route(env,`/api/my/study/sources/${bad}`)).status,400,bad);
 assert.equal((await route(env,`/api/my/study/sources/${sha}`,{method:'DELETE'})).status,405);
 assert.equal(await keepSource(env,reader.id,'not-a-hash',new Blob(['x'])),false);assert.equal(await keepSource(env,reader.id,sha,new Blob(['other bytes'])),false);
 const path=`/api/my/study/sources/${sha}`,url=new URL(origin+path),anonymous={...env,DB:{prepare(){return {bind(){return this;},async first(){return null;}};}}};
 assert.equal((await studyRoute(new Request(url),anonymous,url,path)).status,401);
});

test('Students set covers only on their own study books, with real images, never replacing one unasked',async t=>{
 const {sqlite,env}=environment(t),book=(await save(env,(await range(env,[2,3,4])).body())).libraryStoryId,path=`/api/my/study/books/${book}/cover`,sha='a'.repeat(64);
 const story=()=>sqlite.prepare('SELECT cover_key,cover_page,cover_source_sha256 FROM stories WHERE id=?').get(book);
 const first=await route(env,path,coverForm(JPEG,{page:1,sha256:sha}));assert.equal(first.status,200);assert.deepEqual((await first.json()).cover,{image:true,page:1,sha256:sha});
 const key=story().cover_key;assert.match(key,new RegExp(`^covers/${book}/`));assert.equal(story().cover_page,1);assert.equal(story().cover_source_sha256,sha);assert.equal(env.FILES.values.get(key).options.httpMetadata.contentType,'image/jpeg');
 // The book already has a cover: a second upload is refused unless the student confirmed replacing it.
 const writes=env.FILES.writes.length,refused=await route(env,path,coverForm(JPEG,{page:2}));assert.equal(refused.status,409);assert.equal((await refused.json()).hasCover,true);assert.equal(story().cover_key,key);assert.equal(env.FILES.writes.length,writes);
 const replaced=await route(env,path,coverForm(JPEG,{page:2,sha256:sha,replace:1}));assert.equal(replaced.status,200);assert.notEqual(story().cover_key,key);assert.equal(story().cover_page,2);assert.equal(env.FILES.values.has(key),false);assert.deepEqual(env.FILES.deletes.filter(item=>item.startsWith('covers/')),[key]);
 // Only real JPEG/PNG/WebP within 5 MB, with a valid page and hash; nothing is stored or changed otherwise.
 const current=story().cover_key,count=env.FILES.values.size;
 await assert.rejects(()=>route(env,path,coverForm(new TextEncoder().encode('<svg onload="alert(1)"></svg>'),{replace:1})),/JPG, PNG hoặc WebP/);
 await assert.rejects(()=>route(env,path,coverForm(new Uint8Array(5*1024*1024+1),{replace:1})),/5 MB/);
 await assert.rejects(()=>route(env,path,coverForm(null,{replace:1})),/5 MB/);
 for(const fields of [{page:'abc'},{page:0},{page:-3},{sha256:'zz'}])assert.equal((await route(env,path,coverForm(JPEG,{...fields,replace:1}))).status,400,JSON.stringify(fields));
 assert.equal(story().cover_key,current);assert.equal(env.FILES.values.size,count);
 // Another student's book, a library book that is not a study book, and malformed ids are all "not found".
 assert.equal((await route(env,path,coverForm(JPEG),other)).status,404);
 sqlite.prepare("INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES('44444444-4444-4444-8444-444444444444','Sách web','Toán học · STEM','https://example.test/book',?,'private')").run(reader.id);
 assert.equal((await route(env,'/api/my/study/books/44444444-4444-4444-8444-444444444444/cover',coverForm(JPEG))).status,404);assert.equal((await route(env,'/api/my/study/books/not-a-uuid/cover',coverForm(JPEG))).status,404);
 // "No cover" is remembered without touching the image; only 0..N pages and real hashes are accepted.
 const none=await route(env,path,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:0,sha256:sha})});assert.equal(none.status,200);assert.deepEqual((await none.json()).cover,{image:true,page:0,sha256:sha});assert.equal(story().cover_key,current);assert.equal(story().cover_page,0);
 for(const body of [{page:-1},{page:'x'},{},{page:1,sha256:'bad'}])assert.equal((await route(env,path,{method:'PATCH',body:JSON.stringify(body)})).status,400,JSON.stringify(body));
 assert.equal((await route(env,path,{method:'PATCH',body:JSON.stringify({page:0})},other)).status,404);assert.equal((await route(env,path,{method:'GET'})).status,405);
 // The books list tells the workspace which page of which file is this book's cover.
 const listed=await (await studyHistoryRoute(new Request(origin+'/api/my/study/books'),env,'/api/my/study/books',reader)).json();assert.deepEqual(listed.find(item=>item.id===book).cover,{image:true,page:0,sha256:sha});
});

test('A cover whose database write fails leaves no image behind, and a saved replacement never fails over its old image',async t=>{
 const {sqlite,env}=environment(t),book=(await save(env,(await range(env,[2,3])).body())).libraryStoryId,path=`/api/my/study/books/${book}/cover`,stored=()=>sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(book).cover_key;
 // D1 refusing the write (a trigger stands in for "Network connection lost"): the error reaches the student, and the
 // image already put in storage is removed again, so retries cannot pile up images nothing points to.
 sqlite.exec("CREATE TRIGGER cover_write_fails BEFORE UPDATE OF cover_key ON stories BEGIN SELECT RAISE(ABORT,'D1_ERROR: Network connection lost.'); END");
 await assert.rejects(()=>route(env,path,coverForm(JPEG,{page:1})),/Network connection lost/);await assert.rejects(()=>route(env,path,coverForm(JPEG,{page:1})),/Network connection lost/);
 assert.deepEqual(coverKeys(env),[]);assert.equal(stored(),null);
 sqlite.exec('DROP TRIGGER cover_write_fails');
 assert.equal((await route(env,path,coverForm(JPEG,{page:1}))).status,200);const first=stored();assert.deepEqual(coverKeys(env),[first]);
 // The replacement is committed; storage refusing to delete the old image right now must not turn it into an error.
 env.FILES.failDelete=key=>key===first;
 const replaced=await route(env,path,coverForm(JPEG,{page:2,replace:1}));assert.equal(replaced.status,200);assert.notEqual(stored(),first);assert.equal((await replaced.json()).cover.page,2);
});

test('Assembly info lists every part with its exact pages (read back once for older ranges) and which originals are kept',async t=>{
 const {sqlite,env}=environment(t),sha='a'.repeat(64),a=await save(env,(await range(env,[4,5,6])).body()),bookId=a.libraryStoryId,b=await save(env,(await range(env,[8,7])).body({bookId}));
 sqlite.prepare("UPDATE chapters SET mime='application/pdf',file_key='study/x/translated.pdf' WHERE story_id=?").run(bookId);
 assert.deepEqual(JSON.parse(sqlite.prepare('SELECT source_pages FROM study_sessions WHERE id=?').get(b.id).source_pages),[8,7],'pages keep the manifest order, which is the rendered PDF order');
 // A range saved before page lists existed has none; the assembly reads it back from the manifest and stores it.
 sqlite.prepare('UPDATE study_sessions SET source_pages=NULL,page_start=NULL,page_end=NULL WHERE id=?').run(a.id);
 let response=await route(env,`/api/my/study/books/${bookId}/assembly`),info=await response.json();assert.equal(response.status,200);
 assert.deepEqual(info.parts.map(part=>[part.id,part.pages,part.pageStart,part.pageEnd,part.totalPages,part.sha256,part.file]),[[a.libraryChapterId,[4,5,6],4,6,10,sha,`/api/chapter-file/${a.libraryChapterId}`],[b.libraryChapterId,[8,7],7,8,10,sha,`/api/chapter-file/${b.libraryChapterId}`]]);
 assert.ok(info.parts.every(part=>part.updatedAt&&part.sessionId&&!('stateKey' in part)));assert.deepEqual(info.storedSources,[]);assert.deepEqual(info.cover,{image:false,page:null,sha256:null});
 assert.equal(sqlite.prepare('SELECT source_pages FROM study_sessions WHERE id=?').get(a.id).source_pages,'[4,5,6]');
 await keepSource(env,reader.id,sha,new Blob(['%PDF-1.7']),{filename:'toan.pdf',pages:10});
 info=await (await route(env,`/api/my/study/books/${bookId}/assembly`)).json();assert.deepEqual(info.storedSources,[{sha256:sha,pages:10,url:`/api/my/study/sources/${sha}`}]);
 assert.equal((await route(env,`/api/my/study/books/${bookId}/assembly`,{},other)).status,404);assert.equal((await route(env,`/api/my/study/books/${bookId}/assembly`,{method:'POST'})).status,405);
 assert.equal(await studyBookRoute(new Request(origin+'/api/my/study/books'),env,'/api/my/study/books',reader),null,'other book routes stay with the history module');
});

test('A one-part book merged into another hands over its cover, stored again under that book, or its image is removed',async t=>{
 const {sqlite,env}=environment(t),cover=async id=>{await route(env,`/api/my/study/books/${id}/cover`,coverForm(JPEG,{page:1,sha256:'a'.repeat(64)}));return sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(id).cover_key;};
 const target=await save(env,(await range(env,[2,3])).body()),donor=await save(env,(await range(env,[4,5])).body({title:'Phần lẻ'})),donorKey=await cover(donor.libraryStoryId);
 const move=async(session,bookId)=>(await studyHistoryRoute(json(`/api/my/study/history/${session}`,{bookId},'PATCH'),env,`/api/my/study/history/${session}`,reader)).json();
 assert.equal((await move(donor.id,target.libraryStoryId)).removedBookId,donor.libraryStoryId);
 // A book's cover lives under covers/<its id>/, the folder an admin deleting it clears: the donor's image is copied
 // there, with its type, and the copy under the deleted book's id is gone.
 const adopted=sqlite.prepare('SELECT cover_key,cover_page,cover_source_sha256 FROM stories WHERE id=?').get(target.libraryStoryId);
 assert.match(adopted.cover_key,new RegExp(`^covers/${target.libraryStoryId}/`));assert.deepEqual([adopted.cover_page,adopted.cover_source_sha256],[1,'a'.repeat(64)]);
 assert.equal(env.FILES.values.has(donorKey),false);assert.deepEqual(new Uint8Array(await (await env.FILES.get(adopted.cover_key)).arrayBuffer()),JPEG);assert.equal(env.FILES.values.get(adopted.cover_key).options.httpMetadata.contentType,'image/jpeg');
 const another=await save(env,(await range(env,[6])).body({title:'Phần lẻ 2'})),anotherKey=await cover(another.libraryStoryId);
 assert.equal((await move(another.id,target.libraryStoryId)).removedBookId,another.libraryStoryId);
 assert.equal(sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(target.libraryStoryId).cover_key,adopted.cover_key);assert.equal(env.FILES.values.has(anotherKey),false);
 assert.deepEqual(coverKeys(env),[adopted.cover_key]);assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 // An admin deleting the merged book ("Người học & thư viện riêng") removes its cover with it: nothing is left behind.
 const removed=await adminContent(new Request(origin+`/api/stories/${target.libraryStoryId}`,{method:'DELETE'}),env,`/api/stories/${target.libraryStoryId}`);
 assert.equal(removed.status,200);assert.deepEqual(coverKeys(env),[]);
 // Storage failing during a hand-over costs the cover at most: the move itself still succeeds.
 const book=await save(env,(await range(env,[7])).body({title:'Sách khác'})),lone=await save(env,(await range(env,[8])).body({title:'Phần lẻ 3'}));await cover(lone.libraryStoryId);
 env.FILES.failOn=key=>key.startsWith(`covers/${book.libraryStoryId}/`);
 assert.equal((await move(lone.id,book.libraryStoryId)).removedBookId,lone.libraryStoryId);assert.equal(sqlite.prepare('SELECT cover_key FROM stories WHERE id=?').get(book.libraryStoryId).cover_key,null);assert.deepEqual(coverKeys(env),[]);
});

test('Assembly info tells layout ranges (they export Vietnamese PDF pages) from text translations, which have none',async t=>{
 const {sqlite,env}=environment(t),sha='a'.repeat(64),layout=await save(env,(await range(env,[4,5])).body()),bookId=layout.libraryStoryId;
 // A PDF range read in the browser, a DOCX chapter, and two parts saved before page lists existed: a layout range
 // (known only from its manifest) and a browser-read range (no manifest to find).
 const browser=await save(env,textBody('Mục lục (đọc tại trình duyệt)','toan.pdf',{bookId,sha256:sha,pageRange:{start:2,end:3,total:10}}));
 const docx=await save(env,textBody('Bài đọc thêm','bai-doc.docx',{bookId}));
 const older=await save(env,(await range(env,[8])).body({title:'Trang 8',bookId})),olderText=await save(env,textBody('Trang 9 (cũ)','toan.pdf',{bookId}));
 sqlite.prepare('UPDATE study_sessions SET source_pages=NULL,page_start=NULL,page_end=NULL WHERE id IN (?,?)').run(older.id,olderText.id);
 const info=await (await route(env,`/api/my/study/books/${bookId}/assembly`)).json(),part=session=>info.parts.find(item=>item.sessionId===session.id);
 assert.deepEqual([layout,browser,docx,older,olderText].map(session=>part(session).layout),[true,false,false,true,false]);
 assert.deepEqual(part(older).pages,[8],'the older layout range read its pages back from the manifest');
 // The reader is told to export a layout range, never a text translation (its export button is disabled).
 assert.match(missingPdfNote(part(layout)),/bấm Xuất PDF tiếng Việt/u);
 for(const session of [browser,docx,olderText])assert.match(missingPdfNote(part(session),{inBook:false}),/là bản dịch dạng chữ, không có trang PDF/u);
 assert.match(missingPdfNote(part(browser)),/dịch lại chúng với tùy chọn “Giữ bố cục PDF và xuất bản tiếng Việt”/u);assert.doesNotMatch(missingPdfNote(part(docx),{inBook:false}),/Giữ bố cục/u);
});

test('The newer translation of a page wins the whole book; renaming, moving or re-saving the older part does not change that',async t=>{
 const {sqlite,env}=environment(t),first=await range(env,[4,5,6]),old=await save(env,first.body({title:'Trang 4–6'})),bookId=old.libraryStoryId;
 const redo=await save(env,(await range(env,[5,6])).body({title:'Trang 5–6 (dịch lại)',bookId}));
 const rendered=()=>sqlite.prepare("UPDATE chapters SET mime='application/pdf',file_key='study/x/translated.pdf' WHERE story_id=?").run(bookId);rendered();
 const times=session=>({...sqlite.prepare('SELECT translated_at,updated_at FROM study_sessions WHERE id=?').get(session.id)});
 // SQLite stores CURRENT_TIMESTAMP to the second, so the test sets when each range was translated.
 const set=(session,time)=>sqlite.prepare('UPDATE study_sessions SET translated_at=?,updated_at=? WHERE id=?').run(time,time,session.id);set(old,'2026-10-15 10:00:00');set(redo,'2026-10-15 11:00:00');
 const winners=async()=>{const info=await (await route(env,`/api/my/study/books/${bookId}/assembly`)).json();return planBook(bookSources(info.parts).sources).entries.filter(entry=>entry.from==='translated').map(entry=>`${entry.page}:${entry.part.title}`);};
 assert.deepEqual(await winners(),['4:Trang 4–6','5:Trang 5–6 (dịch lại)','6:Trang 5–6 (dịch lại)']);
 const patch=async(session,body)=>(await studyHistoryRoute(json(`/api/my/study/history/${session.id}`,body,'PATCH'),env,`/api/my/study/history/${session.id}`,reader)).json();
 // Renaming the older part moves its updated_at past the redo's; its translation time stays.
 await patch(old,{title:'Trang 4–6 · Vectơ'});assert.equal(times(old).translated_at,'2026-10-15 10:00:00');assert.ok(times(old).updated_at>'2026-10-15 11:00:00');
 assert.deepEqual(await winners(),['4:Trang 4–6 · Vectơ','5:Trang 5–6 (dịch lại)','6:Trang 5–6 (dịch lại)']);
 // Moving a part between books is not a new translation either.
 const loose=await save(env,(await range(env,[9])).body({title:'Trang 9'}));set(loose,'2026-10-15 09:00:00');await patch(loose,{bookId});assert.equal(times(loose).translated_at,'2026-10-15 09:00:00');assert.ok(times(loose).updated_at>'2026-10-15 09:00:00');
 // Saving the older range again unchanged keeps its time; editing its translation makes it the newer one.
 const put=async body=>(await studyHistoryRoute(json(`/api/my/study/history/${old.id}`,body,'PUT'),env,`/api/my/study/history/${old.id}`,reader)).status;
 assert.equal(await put(first.body({title:'Trang 4–6 · Vectơ'})),200);assert.equal(times(old).translated_at,'2026-10-15 10:00:00');
 assert.equal(await put(first.body({title:'Trang 4–6 · Vectơ'},{edit:' (sửa)'})),200);assert.ok(times(old).translated_at>'2026-10-15 11:00:00',times(old).translated_at);rendered();
 assert.deepEqual(await winners(),['4:Trang 4–6 · Vectơ','5:Trang 4–6 · Vectơ','6:Trang 4–6 · Vectơ','9:Trang 9']);
});

test('Migration 0013 adds the page list, translation time and cover choice columns',async t=>{
 const {sqlite}=environment(t),columns=table=>sqlite.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name);
 assert.ok(['library_chapter_id','page_start','page_end','source_total_pages','source_sha256','source_pages','translated_at'].every(name=>columns('study_sessions').includes(name)));
 assert.ok(['cover_key','cover_page','cover_source_sha256'].every(name=>columns('stories').includes(name)));
 // Ranges saved before the migration take their last save as their translation time.
 const old=new DatabaseSync(':memory:');t.after(()=>old.close());const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url)),files=readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort();
 for(const name of files.filter(name=>name<'0013'))old.exec(readFileSync(migrations+name,'utf8'));
 old.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('u','sub-u','u@example.test','U');
 old.prepare("INSERT INTO study_sessions(id,user_id,title,state_key,updated_at) VALUES('s','u','Cũ','study/u/s/state.json','2026-09-01 08:00:00')").run();
 for(const name of files.filter(name=>name>='0013'))old.exec(readFileSync(migrations+name,'utf8'));
 assert.equal(old.prepare("SELECT translated_at FROM study_sessions WHERE id='s'").get().translated_at,'2026-09-01 08:00:00');
});

// An original as the browser uploads it for a whole-book run: raw bytes (size bytes in all), its hash in the path.
const original=(label,size=0)=>{const head=new TextEncoder().encode(`%PDF-1.7\n${label}\n`),bytes=new Uint8Array(Math.max(head.length,size));bytes.set(head);return bytes;};
async function upload(env,bytes,owner=reader){const sha=await hex(bytes),response=await route(env,`/api/my/study/sources/${sha}`,{method:'PUT',headers:{'Content-Type':'application/pdf','Content-Length':String(bytes.length),'X-PDF-Pages':'3','X-Source-Filename':'sach.pdf'},body:bytes},owner);return {sha,status:response.status,body:await response.json()};}
const ROOM='Hãy xóa trong Lịch sử dịch những bản dịch hoặc lượt dịch cả quyển không cần nữa (tệp gốc không còn phần nào dùng sẽ được xóa theo) rồi thử lại.';
const kept=(env,owner=reader)=>[...env.FILES.values.keys()].filter(key=>key.startsWith(`study/${owner.id}/sources/`)).sort();

test('An account keeps a bounded number of originals; unused ones kept over a day make room, used and recent ones never',async t=>{
 const {sqlite,env}=environment(t,{MAX_SOURCES_PER_USER:'2'}),a=await upload(env,original('A')),b=await upload(env,original('B'));
 assert.deepEqual([a.status,b.status],[201,201]);
 const c=await upload(env,original('C'));assert.equal(c.status,429);
 assert.deepEqual(c.body,{error:`Tài khoản đã lưu 2 tệp PDF gốc, mức tối đa cho mỗi tài khoản. ${ROOM}`,code:'sources_full'});
 assert.deepEqual(kept(env),[sourceKey(reader.id,a.sha),sourceKey(reader.id,b.sha)].sort());assert.equal(sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get(`pdf-source:${reader.id}`).count,2,'a refusal is not counted');
 assert.equal((await upload(env,original('C'),other)).status,201,'each account has its own room');
 // A and B were stored two days ago; A is still used by a translated part, B by nothing: B makes room for C.
 for(const item of [a,b])env.FILES.values.get(sourceKey(reader.id,item.sha)).uploaded=new Date(Date.now()-2*86400000);
 sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,state_key,source_sha256) VALUES(?,?,?,?,?)').run('part-a',reader.id,'Phần A','study/x/state.json',a.sha);
 assert.equal((await upload(env,original('C'))).status,201);assert.deepEqual(kept(env),[sourceKey(reader.id,a.sha),sourceKey(reader.id,c.sha)].sort());
 // C was stored just now (its run may not have started yet) and A is in use: nothing can make room for D.
 assert.equal((await upload(env,original('D'))).status,429);assert.equal(kept(env).length,2);
 // An extraction still works at the limit; the student is told why the original was not kept.
 t.mock.method(globalThis,'fetch',async()=>Response.json({document:{version:1,totalPages:3,pages:[{number:1,width:595,height:842,original:png,background:png,blocks:[{id:'p1-b0',source:'定义向量。',box:[20,20,200,80],fontSize:12}]}]},originalPdfBase64:btoa('%PDF-1.7\npage 1')}));
 const form=new FormData();form.set('file',new File([original('E')],'E.pdf',{type:'application/pdf'}));form.set('pages','1');
 const extracted=await pdfLayoutRoute(new Request(origin+'/api/my/study/pdf-layout/extract',{method:'POST',body:form}),env,'/api/my/study/pdf-layout/extract',reader);
 assert.equal(extracted.status,201);assert.deepEqual((await extracted.json()).document.warnings,[`Chưa lưu được bản PDF gốc đầy đủ vì tài khoản đã lưu 2 tệp PDF gốc, mức tối đa cho mỗi tài khoản; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc. ${ROOM}`]);
 assert.equal(kept(env).length,2);
});

test('An account keeps a bounded total size of originals, checked from the declared length before the file is stored',async t=>{
 const {env}=environment(t,{MAX_SOURCE_MB_PER_USER:'1'}),first=await upload(env,original('A',614400));assert.equal(first.status,201);
 const second=await upload(env,original('B',512000));assert.equal(second.status,413);
 assert.deepEqual(second.body,{error:`Các tệp PDF gốc của tài khoản đã chiếm 0,6 MB, thêm tệp này (0,5 MB) sẽ vượt mức 1,0 MB cho mỗi tài khoản. ${ROOM}`,code:'sources_full'});
 assert.deepEqual(kept(env),[sourceKey(reader.id,first.sha)]);
 const third=await upload(env,original('C',300000));assert.equal(third.status,201,'what still fits is stored');
 // The first original is now unused and two days old. A file that would not fit even without it is refused, and
 // nothing is removed; one that fits once it is gone takes its place, and only it goes.
 env.FILES.values.get(sourceKey(reader.id,first.sha)).uploaded=new Date(Date.now()-2*86400000);
 assert.equal((await upload(env,original('D',1200000))).status,413);assert.deepEqual(kept(env),[sourceKey(reader.id,first.sha),sourceKey(reader.id,third.sha)].sort());
 const fourth=await upload(env,original('E',500000));assert.equal(fourth.status,201);assert.deepEqual(kept(env),[sourceKey(reader.id,third.sha),sourceKey(reader.id,fourth.sha)].sort());
});
