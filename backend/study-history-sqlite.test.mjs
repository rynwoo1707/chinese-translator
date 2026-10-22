import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {studyHistoryRoute,placeBookPart} from './study-history.js';
import {pdfLayoutRoute} from './pdf-layout.js';

const reader={id:'student-sqlite',name:'Lan'},historyBase='/api/my/study/history';
const assetId='11111111-1111-4111-8111-111111111111';
const request=(path,body,method='POST')=>new Request('https://example.test'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

class D1Statement{
 constructor(database,sql){this.database=database;this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes,last_row_id:result.lastInsertRowid}};}
 async run(){return this.execute();}
}
class D1Database{
 constructor(database){this.database=database;}
 prepare(sql){return new D1Statement(this.database,sql);}
 async batch(statements){
  this.database.exec('BEGIN');
  try{const results=statements.map(statement=>statement.execute());this.database.exec('COMMIT');return results;}
  catch(error){this.database.exec('ROLLBACK');throw error;}
 }
}
class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value,options){this.values.set(key,{value,options});}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async get(key){
  const item=this.values.get(key);if(!item)return null;
  const text=()=>typeof item.value==='string'?item.value:new TextDecoder().decode(item.value);
  return {body:typeof item.value==='string'?new TextEncoder().encode(item.value):item.value,json:async()=>JSON.parse(text()),text:async()=>text()};
 }
}
const migrationFiles=()=>readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
const applyMigration=(sqlite,filename)=>sqlite.exec(readFileSync(new URL('../database/migrations/'+filename,import.meta.url),'utf8'));
function environment(t,{before=null}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const filename of migrationFiles().filter(name=>!before||name<before))applyMigration(sqlite,filename);
 assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(reader.id,'test-google-sub','lan@example.test',reader.name);
 return {sqlite,env:{DB:new D1Database(sqlite),FILES:new MemoryFiles(),PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test',PDF_LAYOUT_SERVICE_TOKEN:'service-secret'}};
}

test('Completed study history creates its private library entry with real SQLite foreign keys enabled',async t=>{
 const {sqlite,env}=environment(t),body={title:'Hình học không gian',filename:'lesson.txt',domain:'math',mode:'economy',state:{source:'第一部分\n\n第二部分',parts:['第一部分','第二部分'],translationParts:['Phần thứ nhất.','Phần thứ hai.'],done:2}};
 const response=await studyHistoryRoute(request(historyBase,body),env,historyBase,reader),saved=await response.json();
 assert.equal(response.status,201);assert.equal(saved.status,'complete');assert.ok(saved.libraryStoryId);
 const session=sqlite.prepare('SELECT * FROM study_sessions WHERE id=?').get(saved.id),story=sqlite.prepare('SELECT * FROM stories WHERE id=?').get(saved.libraryStoryId),chapter=sqlite.prepare('SELECT * FROM chapters WHERE story_id=?').get(saved.libraryStoryId);
 assert.equal(session.library_story_id,story.id);assert.equal(session.library_chapter_id,chapter.id);assert.equal(saved.libraryChapterId,chapter.id);assert.equal(session.user_id,reader.id);assert.equal(story.owner_user_id,reader.id);assert.equal(story.visibility,'private');assert.equal(story.source_url,`study-book:${story.id}`);
 assert.equal(chapter.mime,'text/plain');assert.equal(chapter.position,1);assert.equal(await (await env.FILES.get(chapter.text_key)).text(),'Phần thứ nhất.\n\nPhần thứ hai.');assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 const path=historyBase+'/'+saved.id;body.title='Hình học đã sửa';
 assert.equal((await studyHistoryRoute(request(path,body,'PUT'),env,path,reader)).status,200);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stories').get().count,1);assert.equal(sqlite.prepare('SELECT title FROM stories WHERE id=?').get(story.id).title,body.title);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Real SQLite PDF history moves between saved text and rendered PDF without broken library references',async t=>{
 const {sqlite,env}=environment(t),png='data:image/png;base64,AA==',source='公式 @@PDF_INLINE_0@@。',manifest={version:1,pages:[{number:4,width:600,height:800,original:png,background:png,blocks:[{id:'p4-b0',source,box:[20,20,200,80],fontSize:12,inlines:[{token:'@@PDF_INLINE_0@@',image:png,width:24,height:12,text:'a = b'}]}]}]};
 await env.FILES.put(`study/${reader.id}/pdf-layout/${assetId}/manifest.json`,JSON.stringify(manifest));
 const body={title:'Bản dịch PDF',filename:'lesson.pdf',domain:'math',state:{source,parts:[source],translationParts:['Công thức @@PDF_INLINE_0@@.'],done:1,pdfLayout:{assetId}}};
 const created=await studyHistoryRoute(request(historyBase,body),env,historyBase,reader),saved=await created.json();assert.equal(created.status,201);
 const chapter=()=>sqlite.prepare('SELECT * FROM chapters WHERE story_id=?').get(saved.libraryStoryId);
 assert.equal(chapter().mime,'text/plain');assert.equal(chapter().file_key,null);assert.equal(await (await env.FILES.get(chapter().text_key)).text(),'Công thức a = b.');
 const renderPath='/api/my/study/pdf-layout/render',historyPath=historyBase+'/'+saved.id;let renderCalls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{renderCalls++;assert.equal(new URL(url).pathname,'/render');assert.equal(JSON.parse(await new Response(options.body).text()).translations[0].translation,body.state.translationParts[0]);return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]});});
 assert.equal((await pdfLayoutRoute(request(renderPath,{assetId,historyId:saved.id}),env,renderPath,reader)).status,200);
 const translatedKey=`study/${reader.id}/pdf-layout/${assetId}/translated.pdf`;assert.equal(chapter().file_key,translatedKey);assert.equal(chapter().mime,'application/pdf');
 const stateKey=`study/${reader.id}/${saved.id}/state.json`,stateBeforeRename=await (await env.FILES.get(stateKey)).text();body.title='Vectơ trong không gian – bài 1';
 assert.equal((await studyHistoryRoute(request(historyPath,{title:body.title},'PATCH'),env,historyPath,reader)).status,200);
 assert.equal(sqlite.prepare('SELECT title FROM study_sessions WHERE id=?').get(saved.id).title,body.title);assert.equal(sqlite.prepare('SELECT title FROM stories WHERE id=?').get(saved.libraryStoryId).title,body.title);assert.equal(chapter().title,body.title);assert.equal(chapter().file_key,translatedKey);assert.equal(chapter().mime,'application/pdf');assert.equal(await (await env.FILES.get(stateKey)).text(),stateBeforeRename);assert.equal(renderCalls,1);
 assert.equal((await studyHistoryRoute(request(historyPath,body,'PUT'),env,historyPath,reader)).status,200);assert.equal(chapter().file_key,translatedKey);assert.equal(chapter().mime,'application/pdf');
 body.state.translationParts=['Công thức đã sửa @@PDF_INLINE_0@@.'];
 assert.equal((await studyHistoryRoute(request(historyPath,body,'PUT'),env,historyPath,reader)).status,200);assert.equal(chapter().file_key,null);assert.equal(chapter().mime,'text/plain');assert.equal(env.FILES.values.has(translatedKey),false);
 assert.equal((await pdfLayoutRoute(request(renderPath,{assetId,historyId:saved.id}),env,renderPath,reader)).status,200);assert.equal(renderCalls,2);assert.equal(chapter().file_key,translatedKey);assert.equal(chapter().mime,'application/pdf');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stories').get().count,1);assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

// Books: every page range of a textbook is its own study session and its own chapter of one private story.
const other={id:'student-other',name:'Minh'},png='data:image/png;base64,AA==',SHA_A='a'.repeat(64),SHA_B='b'.repeat(64);
let assetCounter=0;
const addReader=(sqlite,user)=>sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(user.id,`sub-${user.id}`,`${user.id}@example.test`,user.name);
async function pdfRange(env,pages,{owner=reader,sha256=SHA_A,totalPages=40,filename='toan-tap-1.pdf'}={}){
 const assetId=`22222222-2222-4222-8222-${String(++assetCounter).padStart(12,'0')}`;
 const manifest={version:1,totalPages,sourceSha256:sha256,pages:pages.map(number=>({number,width:600,height:800,original:png,background:png,blocks:[{id:`p${number}-b0`,source:`第${number}页：向量的概念。`,box:[20,20,200,80],fontSize:12}]}))};
 await env.FILES.put(`study/${owner.id}/pdf-layout/${assetId}/manifest.json`,JSON.stringify(manifest));
 const parts=manifest.pages.map(page=>page.blocks[0].source);
 return {assetId,body:(extra={})=>({title:'Toán 1',filename,domain:'math',...extra,state:{source:parts.join('\n\n'),parts,translationParts:parts.map((_,i)=>`Trang ${pages[i]}: khái niệm vectơ.`),done:parts.length,glossary:{},manualGlossary:{},...extra.state,pdfLayout:{assetId}}})};
}
async function save(env,body,{owner=reader,id=null}={}){
 const path=id?`${historyBase}/${id}`:historyBase,response=await studyHistoryRoute(request(path,body,id?'PUT':'POST'),env,path,owner);
 return {...await response.json(),http:response.status};
}
const patch=async(env,path,body,owner=reader)=>{const response=await studyHistoryRoute(request(path,body,'PATCH'),env,path,owner);return {...await response.json(),http:response.status};};
const chaptersOf=(sqlite,storyId)=>sqlite.prepare('SELECT * FROM chapters WHERE story_id=? ORDER BY position,created_at,id').all(storyId);
const sessionRow=(sqlite,id)=>sqlite.prepare('SELECT * FROM study_sessions WHERE id=?').get(id);
const books=async(env,owner=reader)=>(await studyHistoryRoute(new Request('https://example.test/api/my/study/books'),env,'/api/my/study/books',owner)).json();

test('Two ranges of one file added to a book become two chapters in page order with merged terms',async t=>{
 const {sqlite,env}=environment(t),later=await pdfRange(env,[4,5]),earlier=await pdfRange(env,[1,2,3]),otherFile=await pdfRange(env,[1],{sha256:SHA_B,filename:'toan-tap-2.pdf'});
 const first=await save(env,later.body({state:{glossary:{向量:'vectơ'}}}));assert.equal(first.http,201);
 const bookId=first.libraryStoryId;assert.equal(sqlite.prepare('SELECT title FROM chapters WHERE id=?').get(first.libraryChapterId).title,'Toán 1');
 // Completed second, but its pages come first: the book is ordered by page within one file, not by completion time.
 const second=await save(env,earlier.body({bookId,state:{glossary:{平面:'mặt phẳng'}}}));
 assert.equal(second.http,201);assert.equal(second.libraryStoryId,bookId);assert.notEqual(second.libraryChapterId,first.libraryChapterId);
 let chapters=chaptersOf(sqlite,bookId);
 assert.deepEqual(chapters.map(c=>[c.id,c.title,c.position]),[[second.libraryChapterId,'Trang 1–3',1],[first.libraryChapterId,'Trang 4–5',2]]);
 assert.equal(await (await env.FILES.get(chapters[0].text_key)).text(),'Trang 1: khái niệm vectơ.\n\nTrang 2: khái niệm vectơ.\n\nTrang 3: khái niệm vectơ.');
 const glossary=()=>JSON.parse(sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(bookId).glossary);assert.deepEqual(glossary(),{向量:'vectơ',平面:'mặt phẳng'});
 const session=sessionRow(sqlite,second.id);assert.deepEqual([session.library_story_id,session.library_chapter_id,session.page_start,session.page_end,session.source_total_pages,session.source_sha256],[bookId,second.libraryChapterId,1,3,40,SHA_A]);
 // Pages restart in every split file: a range of another file goes to the end, where the student can move it.
 const third=await save(env,otherFile.body({bookId,title:'Chương 2',state:{manualGlossary:{向量:'véc-tơ'}}}));chapters=chaptersOf(sqlite,bookId);assert.deepEqual(glossary(),{向量:'véc-tơ',平面:'mặt phẳng'});
 assert.deepEqual(chapters.map(c=>[c.id,c.title,c.position]),[[second.libraryChapterId,'Trang 1–3',1],[first.libraryChapterId,'Trang 4–5',2],[third.libraryChapterId,'Chương 2',3]]);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stories WHERE owner_user_id=?').get(reader.id).count,1);
 const listed=await books(env);assert.equal(listed.length,1);assert.deepEqual(listed[0].parts.map(p=>[p.id,p.sessionId,p.pageStart,p.pageEnd,p.totalPages,p.sha256]),[[second.libraryChapterId,second.id,1,3,40,SHA_A],[first.libraryChapterId,first.id,4,5,40,SHA_A],[third.libraryChapterId,third.id,1,1,40,SHA_B]]);
 assert.doesNotMatch(JSON.stringify(listed),/state\.json|stateKey/);assert.deepEqual(await books(env,other),[]);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Rendering, editing or renaming one range of a book never touches another range',async t=>{
 const {sqlite,env}=environment(t),one=await pdfRange(env,[1,2]),two=await pdfRange(env,[3,4]);
 const first=await save(env,one.body()),second=await save(env,two.body({bookId:first.libraryStoryId})),bookId=first.libraryStoryId,renderPath='/api/my/study/pdf-layout/render';
 t.mock.method(globalThis,'fetch',async()=>Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]}));
 const chapter=id=>sqlite.prepare('SELECT * FROM chapters WHERE id=?').get(id),key=asset=>`study/${reader.id}/pdf-layout/${asset}/translated.pdf`;
 assert.equal((await pdfLayoutRoute(request(renderPath,{assetId:one.assetId,historyId:first.id}),env,renderPath,reader)).status,200);
 assert.equal(chapter(first.libraryChapterId).file_key,key(one.assetId));assert.equal(chapter(second.libraryChapterId).file_key,null);assert.equal(chapter(second.libraryChapterId).mime,'text/plain');
 assert.equal((await pdfLayoutRoute(request(renderPath,{assetId:two.assetId,historyId:second.id}),env,renderPath,reader)).status,200);
 assert.equal(chapter(first.libraryChapterId).file_key,key(one.assetId));assert.equal(chapter(second.libraryChapterId).file_key,key(two.assetId));assert.equal(chapter(second.libraryChapterId).mime,'application/pdf');
 const before=chapter(first.libraryChapterId),edited=two.body({bookId});edited.state.translationParts[0]='Trang 3: định nghĩa vectơ.';
 assert.equal((await save(env,edited,{id:second.id})).http,200);
 assert.equal(chapter(second.libraryChapterId).file_key,null);assert.match(await (await env.FILES.get(chapter(second.libraryChapterId).text_key)).text(),/định nghĩa vectơ/);assert.deepEqual(chapter(first.libraryChapterId),before);
 assert.equal(env.FILES.values.has(key(one.assetId)),true);
 // In a book of several ranges a rename names that range only; the book keeps its own title.
 assert.equal((await patch(env,`${historyBase}/${second.id}`,{title:'Bài 2 · Tích vô hướng'})).http,200);
 assert.equal(chapter(second.libraryChapterId).title,'Bài 2 · Tích vô hướng');assert.deepEqual(chapter(first.libraryChapterId),before);assert.equal(sqlite.prepare('SELECT title FROM stories WHERE id=?').get(bookId).title,'Toán 1');
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Moving a finished range into another book deletes the empty one-part book, keeps its files and merges its terms',async t=>{
 const {sqlite,env}=environment(t);addReader(sqlite,other);
 const rangeA=await pdfRange(env,[4,5,6]),rangeB=await pdfRange(env,[7,8]);
 const a=await save(env,rangeA.body({title:'tesst',state:{glossary:{向量:'vectơ'}}})),b=await save(env,rangeB.body({title:'tesst',state:{glossary:{平面:'mặt phẳng'}}}));
 assert.notEqual(a.libraryStoryId,b.libraryStoryId);
 // Rows saved before migration 0013 have no page range; the move reads it back from the saved manifest.
 sqlite.prepare('UPDATE study_sessions SET page_start=NULL,page_end=NULL,source_total_pages=NULL,source_sha256=NULL').run();
 const textKey=sqlite.prepare('SELECT text_key FROM chapters WHERE id=?').get(b.libraryChapterId).text_key,path=`${historyBase}/${b.id}`;
 assert.equal((await patch(env,path,{bookId:a.libraryStoryId},other)).http,404);
 assert.equal((await patch(env,`${historyBase}/${a.id}`,{bookId:'33333333-3333-4333-8333-333333333333'})).http,404);
 const moved=await patch(env,path,{bookId:a.libraryStoryId});
 assert.equal(moved.http,200);assert.equal(moved.libraryStoryId,a.libraryStoryId);assert.equal(moved.libraryChapterId,b.libraryChapterId);assert.equal(moved.removedBookId,b.libraryStoryId);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stories WHERE id=?').get(b.libraryStoryId).count,0);
 assert.deepEqual(chaptersOf(sqlite,a.libraryStoryId).map(c=>[c.id,c.title,c.position]),[[a.libraryChapterId,'Trang 4–6',1],[b.libraryChapterId,'Trang 7–8',2]]);
 assert.deepEqual(JSON.parse(sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(a.libraryStoryId).glossary),{向量:'vectơ',平面:'mặt phẳng'});
 const session=sessionRow(sqlite,b.id);assert.deepEqual([session.library_story_id,session.library_chapter_id,session.page_start,session.page_end,session.source_total_pages],[a.libraryStoryId,b.libraryChapterId,7,8,40]);
 assert.equal(sessionRow(sqlite,a.id).page_start,4);assert.ok(env.FILES.values.has(textKey));
 // Moving into the same book changes nothing; drafts and books that are not the student's own study books are refused.
 assert.equal((await patch(env,path,{bookId:a.libraryStoryId})).removedBookId,null);
 const draft=await save(env,(await pdfRange(env,[9])).body({state:{done:0,translationParts:[]}}));assert.equal(draft.http,201);
 assert.equal((await patch(env,`${historyBase}/${draft.id}`,{bookId:a.libraryStoryId})).http,409);
 sqlite.prepare('INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,?)').run('44444444-4444-4444-8444-444444444444','Sách thư viện','Toán học · STEM',null,reader.id,'private');
 assert.equal((await patch(env,path,{bookId:'44444444-4444-4444-8444-444444444444'})).http,404);
 const foreign=await save(env,(await pdfRange(env,[1],{owner:other})).body(),{owner:other});
 assert.equal((await patch(env,path,{bookId:foreign.libraryStoryId})).http,404);assert.equal(chaptersOf(sqlite,foreign.libraryStoryId).length,1);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Students reorder and rename only their own study books, naming every part exactly once',async t=>{
 const {sqlite,env}=environment(t);addReader(sqlite,other);
 const first=await save(env,(await pdfRange(env,[1])).body()),bookId=first.libraryStoryId,booksPath=`/api/my/study/books/${bookId}`;
 const second=await save(env,(await pdfRange(env,[2])).body({bookId})),third=await save(env,(await pdfRange(env,[1],{sha256:SHA_B})).body({bookId}));
 const reorder=(body,owner=reader,path=booksPath)=>studyHistoryRoute(request(path,body,'PATCH'),env,path,owner);
 const order=[third.libraryChapterId,first.libraryChapterId,second.libraryChapterId],response=await reorder({order,title:'Toán 1 · trọn bộ'});
 assert.equal(response.status,200);const updated=await response.json();assert.deepEqual(updated.parts.map(p=>p.id),order);assert.equal(updated.title,'Toán 1 · trọn bộ');
 assert.deepEqual(chaptersOf(sqlite,bookId).map(c=>[c.id,c.position]),order.map((id,index)=>[id,index+1]));
 for(const invalid of [order.slice(1),[order[0],order[0],order[1]],[...order.slice(1),'55555555-5555-4555-8555-555555555555']])assert.equal((await reorder({order:invalid})).status,400);
 assert.equal((await reorder({order},other)).status,404);assert.equal((await reorder({title:'   '})).status,400);
 sqlite.prepare('INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,?)').run('44444444-4444-4444-8444-444444444444','Sách web','Toán học · STEM','https://example.test/book',reader.id,'private');
 assert.equal((await reorder({title:'x'},reader,'/api/my/study/books/44444444-4444-4444-8444-444444444444')).status,404);
 assert.deepEqual(chaptersOf(sqlite,bookId).map(c=>c.id),order);
});

test('A redone range replaces its old part, and a draft keeps the book it was started for',async t=>{
 const {sqlite,env}=environment(t);addReader(sqlite,other);
 const original=await save(env,(await pdfRange(env,[1,2])).body()),bookId=original.libraryStoryId,next=await save(env,(await pdfRange(env,[3])).body({bookId}));
 // A draft records its book at once, so resuming it from history later still finishes inside that book.
 const redo=await pdfRange(env,[1,2]),draft=await save(env,redo.body({bookId,replaceChapterId:original.libraryChapterId,state:{done:1,translationParts:['Trang 1: bản dịch mới.','']}}));
 assert.equal(draft.http,201);assert.deepEqual([sessionRow(sqlite,draft.id).library_story_id,sessionRow(sqlite,draft.id).library_chapter_id],[bookId,null]);
 const done=await save(env,redo.body({replaceChapterId:original.libraryChapterId,state:{translationParts:['Trang 1: bản dịch mới.','Trang 2: bản dịch mới.']}}),{id:draft.id});
 assert.equal(done.http,200);assert.equal(done.libraryChapterId,original.libraryChapterId);
 const chapters=chaptersOf(sqlite,bookId);assert.deepEqual(chapters.map(c=>c.id),[original.libraryChapterId,next.libraryChapterId]);
 assert.match(await (await env.FILES.get(chapters[0].text_key)).text(),/bản dịch mới/);
 assert.deepEqual([sessionRow(sqlite,original.id).library_story_id,sessionRow(sqlite,original.id).library_chapter_id],[null,null]);
 const stray=await save(env,(await pdfRange(env,[5])).body({bookId,replaceChapterId:'55555555-5555-4555-8555-555555555555'}));assert.equal(stray.http,400);
 const foreignBook=(await save(env,(await pdfRange(env,[1],{owner:other})).body(),{owner:other})).libraryStoryId,sessions=sqlite.prepare('SELECT COUNT(*) AS count FROM study_sessions').get().count;
 assert.equal((await save(env,(await pdfRange(env,[6])).body({bookId:foreignBook}))).http,404);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM study_sessions').get().count,sessions);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('A first save sent again with its own id updates that session instead of making a second one',async t=>{
 const {sqlite,env}=environment(t);addReader(sqlite,other);
 const id='88888888-8888-4888-8888-888888888888',range=await pdfRange(env,[21,22]),draft=range.body({state:{done:0,translationParts:[]}});
 const first=await save(env,{...draft,id});assert.equal(first.http,201);assert.equal(first.id,id);assert.equal(first.status,'draft');
 // Its answer was lost and the whole-book chunk saves again: still one session, now holding what the retry sent.
 const again=await save(env,{...draft,id,title:'Toán 1 · lưu lại'});assert.equal(again.http,200);assert.equal(again.id,id);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM study_sessions').get().count,1);assert.equal(sessionRow(sqlite,id).title,'Toán 1 · lưu lại');
 const done=await save(env,{...range.body(),id});assert.deepEqual([done.http,done.id,done.status],[200,id,'complete']);assert.ok(done.libraryChapterId);
 // An id another student's session has is refused, a malformed one too; without an id the server makes one as before.
 const theirs='99999999-9999-4999-8999-999999999999';assert.equal((await save(env,{...(await pdfRange(env,[1],{owner:other})).body(),id:theirs},{owner:other})).http,201);
 assert.equal((await save(env,{...draft,id:theirs})).http,409);assert.equal(sessionRow(sqlite,theirs).user_id,other.id);
 for(const bad of ['../x','x'.repeat(36),42])assert.equal((await save(env,{...draft,id:bad})).http,400,String(bad));
 const plain=await save(env,draft);assert.equal(plain.http,201);assert.notEqual(plain.id,id);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM study_sessions WHERE user_id=?').get(reader.id).count,2);
});

test('A save that lands after its account was deleted keeps none of the files it wrote',async t=>{
 const {sqlite,env}=environment(t),range=await pdfRange(env,[1,2]),put=env.FILES.put.bind(env.FILES);
 // The account is deleted while this save is on its way: its rows are gone by the time the save writes its files.
 env.FILES.put=async(key,value,options)=>{await put(key,value,options);if(key.endsWith('/state.json'))sqlite.prepare('DELETE FROM reader_users WHERE id=?').run(reader.id);};
 const saved=await save(env,range.body());
 assert.equal(saved.http,410);assert.equal(saved.code,'account_deleted');
 assert.deepEqual([...env.FILES.values.keys()].filter(key=>key.startsWith(`study/${reader.id}/`)&&!key.includes('/pdf-layout/')),[]);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM study_sessions').get().count,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stories').get().count,0);
});

test('Migration 0013 links every existing one-chapter study story to its session chapter',async t=>{
 const {sqlite}=environment(t,{before:'0013'}),story='66666666-6666-4666-8666-666666666666',chapter='77777777-7777-4777-8777-777777777777';
 sqlite.prepare("INSERT INTO stories(id,title,author,genre,source_url,owner_user_id,visibility,glossary) VALUES(?,?,?,?,?,?, 'private','{}')").run(story,'tesst','Bản dịch cá nhân','Toán học · STEM','study:old-session',reader.id);
 sqlite.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,position) VALUES(?,?,?,?,?,?,1)').run(chapter,story,'tesst','Nội dung','study/key','application/pdf');
 sqlite.prepare("INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id) VALUES('old-session',?,?,?,'complete',?)").run(reader.id,'tesst','study/state',story);
 sqlite.prepare("INSERT INTO study_sessions(id,user_id,title,state_key) VALUES('old-draft',?,?,?)").run(reader.id,'nháp','study/draft');
 applyMigration(sqlite,migrationFiles().find(name=>name.startsWith('0013')));
 assert.equal(sessionRow(sqlite,'old-session').library_chapter_id,chapter);assert.equal(sessionRow(sqlite,'old-draft').library_chapter_id,null);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Book placement keeps page order inside one file and puts another file at the end',()=>{
 const part=(id,pageStart,sha256=SHA_A,extra={})=>({id,pageStart,pageEnd:pageStart+1,sha256,filename:'a.pdf',totalPages:40,...extra});
 const ids=list=>list.map(item=>item.id);
 assert.deepEqual(ids(placeBookPart([part('p1',1),part('p5',5)],part('p3',3))),['p1','p3','p5']);
 assert.deepEqual(ids(placeBookPart([part('p5',5),part('p9',9)],part('p1',1))),['p1','p5','p9']);
 assert.deepEqual(ids(placeBookPart([part('a1',1),part('b1',1,SHA_B)],part('a3',3))),['a1','a3','b1']);
 assert.deepEqual(ids(placeBookPart([part('a1',1),part('b1',1,SHA_B)],part('b3',3,SHA_B))),['a1','b1','b3']);
 assert.deepEqual(ids(placeBookPart([part('a1',1),part('t',null)],part('c1',1,SHA_B))),['a1','t','c1']);
 // Rows saved before file hashes existed fall back to the file name and page count.
 assert.deepEqual(ids(placeBookPart([part('o4',4,null),part('x',1,SHA_B,{filename:'b.pdf'})],part('o1',1,null))),['o1','o4','x']);
 assert.deepEqual(ids(placeBookPart([part('a1',1),part('a5',5)],part('a5',3))),['a1','a5']);
});
