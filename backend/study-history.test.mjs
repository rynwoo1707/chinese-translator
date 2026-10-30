import test from 'node:test';
import assert from 'node:assert/strict';
import {studyHistoryRoute} from './study-history.js';

class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value,options){this.values.set(key,{value:String(value),options});}
 async get(key){const item=this.values.get(key);return item?{json:async()=>JSON.parse(item.value),text:async()=>item.value}:null;}
}

class Statement{
 constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){
  if(this.sql.includes('FROM study_sessions WHERE id=? AND user_id=?')){const row=this.db.sessions.get(this.args[0]);return row?.user_id===this.args[1]?row:null;}
  // The account a save belongs to still exists (a save checks this after writing its files).
  if(/FROM reader_users\b/u.test(this.sql))return {id:this.args[0],active:1};
  if(this.sql.includes('AS parts FROM stories s WHERE s.id=? AND s.owner_user_id=?')){const story=this.db.stories.get(this.args[0]);return story?.owner_user_id===this.args[1]?{title:story.title,parts:[...this.db.chapters.values()].filter(row=>row.story_id===story.id).length}:null;}
  return null;
 }
 async all(){
  if(this.sql.includes('FROM study_sessions WHERE user_id=?'))return {results:[...this.db.sessions.values()].filter(row=>row.user_id===this.args[0]).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))};
  return {results:[]};
 }
}

class MemoryDB{
 constructor(){this.sessions=new Map();this.stories=new Map();this.chapters=new Map();}
 prepare(sql){return new Statement(this,sql);}
 async batch(statements){for(const statement of statements)this.apply(statement);return statements.map(()=>({success:true}));}
 apply({sql,args}){
  const query=sql.trim();
  // The room guard of a new item inserts nothing while the item fits (study-history-limits.test.mjs tests it on SQLite).
  if(query.includes("'history_full'"))return;
  if(query.startsWith('INSERT INTO study_sessions')){
   const [id,user_id,title,filename,domain,subject,mode,engine,status,state_key,source_preview,translation_preview,translated_parts,total_parts,source_characters,translation_characters,storyId,library_chapter_id,page_start,page_end,source_total_pages,source_sha256]=args,previous=this.sessions.get(id),now=new Date().toISOString();
   const library_story_id=previous?.library_chapter_id&&previous.library_chapter_id===library_chapter_id?previous.library_story_id:storyId;
   this.sessions.set(id,{id,user_id,title,filename,domain,subject,mode,engine,status,state_key,source_preview,translation_preview,translated_parts,total_parts,source_characters,translation_characters,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,created_at:previous?.created_at||now,updated_at:now});return;
  }
  if(query.startsWith('INSERT INTO stories')){const [id,title,author,genre,source_url,owner_user_id,glossary]=args;this.stories.set(id,{id,title,author,genre,source_url,owner_user_id,visibility:'private',glossary});return;}
  if(query.startsWith('INSERT INTO chapters')){const [id,story_id,title,content,text_key,mime,position]=args;this.chapters.set(id,{id,story_id,title,content,text_key,mime,position});return;}
  if(query.startsWith('UPDATE study_sessions')){const [title,id,owner]=args,row=this.sessions.get(id);if(row?.user_id===owner)Object.assign(row,{title,updated_at:new Date().toISOString()});return;}
  if(query.startsWith('UPDATE stories SET title=? WHERE')){const [title,id,owner]=args,row=this.stories.get(id);if(row?.owner_user_id===owner)Object.assign(row,{title});return;}
  // Study code addresses one chapter by id (a book holds one chapter per page range), always within the reader's own stories.
  if(query.startsWith('UPDATE chapters SET title=? WHERE id=?')){const [title,chapterId,owner]=args,row=this.chapters.get(chapterId);if(this.stories.get(row?.story_id)?.owner_user_id===owner)row.title=title;return;}
  // The book's terms merged with the range's, unless that passes the size cap (then the book keeps its terms).
  if(query.startsWith('UPDATE stories SET glossary=CASE WHEN length(')){const [patch,genre,id,owner]=args,row=this.stories.get(id);if(row?.owner_user_id===owner){const merged=JSON.stringify({...JSON.parse(row.glossary||'{}'),...JSON.parse(patch)});Object.assign(row,{glossary:new TextEncoder().encode(merged).length<=131072?merged:row.glossary,genre:[...this.chapters.values()].filter(item=>item.story_id===id).length<=1?genre:row.genre});}return;}
  if(query.startsWith('UPDATE chapters SET content=?,text_key=? WHERE id=?')){const [content,text_key,chapterId,owner]=args,row=this.chapters.get(chapterId);if(this.stories.get(row?.story_id)?.owner_user_id===owner)Object.assign(row,{content,text_key});return;}
  throw new Error('Unexpected SQL in study history mock: '+query.slice(0,80));
 }
}

const base='https://example.test/api/my/study/history';
const reader={id:'student-1',name:'Lan'};
const jsonRequest=(url,method,body)=>new Request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const draft={title:'Hình học không gian',filename:'hinh-hoc.pdf',domain:'math',mode:'economy',apiKey:'must-never-be-stored',state:{source:'第一部分\n\n第二部分',parts:['第一部分','第二部分'],translationParts:['Cùng giố`ng nhau.',''],done:1,context:'vectơ trong không gian',glossary:{向量:'vectơ'},manualGlossary:{向量:'vectơ'},apiKey:'must-never-be-stored'}};

test('study history is stored per student without the Gemini key',async()=>{
 const DB=new MemoryDB(),FILES=new MemoryFiles(),env={DB,FILES};
 const response=await studyHistoryRoute(jsonRequest(base,'POST',draft),env,'/api/my/study/history',reader),saved=await response.json();
 assert.equal(response.status,201);assert.equal(saved.status,'translating');assert.ok(saved.id);
 const row=DB.sessions.get(saved.id);assert.equal(row.user_id,reader.id);assert.equal(row.translated_parts,1);assert.equal(row.total_parts,2);assert.equal(row.library_story_id,null);
 const stored=FILES.values.get(row.state_key).value;assert.doesNotMatch(stored,/must-never-be-stored/);assert.equal(JSON.parse(stored).translationParts[0],'Cùng giống nhau.');
 const list=await (await studyHistoryRoute(new Request(base),env,'/api/my/study/history',reader)).json();assert.equal(list.length,1);assert.equal(list[0].title,'Hình học không gian');
 const foreign=await studyHistoryRoute(new Request(`${base}/${saved.id}`),env,`/api/my/study/history/${saved.id}`,{id:'student-2'});assert.equal(foreign.status,404);
});

test('a completed history item creates a private library document and remains updatable',async()=>{
 const DB=new MemoryDB(),FILES=new MemoryFiles(),env={DB,FILES};
 const created=await (await studyHistoryRoute(jsonRequest(base,'POST',draft),env,'/api/my/study/history',reader)).json();
 const complete={...draft,state:{...draft.state,translationParts:['Phần thứ nhất.','Phần thứ hai.'],done:2}};
 const path=`/api/my/study/history/${created.id}`,url=`${base}/${created.id}`;
 const response=await studyHistoryRoute(jsonRequest(url,'PUT',complete),env,path,reader),saved=await response.json();
 assert.equal(response.status,200);assert.equal(saved.status,'complete');assert.ok(saved.libraryStoryId);
 const story=DB.stories.get(saved.libraryStoryId);assert.equal(story.owner_user_id,reader.id);assert.equal(story.visibility,'private');assert.equal(story.source_url,`study-book:${story.id}`);
 const chapter=[...DB.chapters.values()].find(item=>item.story_id===story.id);assert.ok(chapter);assert.equal(chapter.mime,'text/plain');assert.equal(await (await FILES.get(chapter.text_key)).text(),'Phần thứ nhất.\n\nPhần thứ hai.');
 const loaded=await (await studyHistoryRoute(new Request(url),env,path,reader)).json();assert.equal(loaded.state.done,2);assert.equal(loaded.library_story_id,story.id);
 const storyCount=DB.stories.size;complete.title='Hình học không gian — đã sửa';await studyHistoryRoute(jsonRequest(url,'PUT',complete),env,path,reader);assert.equal(DB.stories.size,storyCount);assert.equal(DB.stories.get(story.id).title,complete.title);
});

test('history rejects a state whose source and parts do not match',async()=>{
 const env={DB:new MemoryDB(),FILES:new MemoryFiles()},invalid={...draft,state:{...draft.state,parts:['nội dung khác']}};
 await assert.rejects(()=>studyHistoryRoute(jsonRequest(base,'POST',invalid),env,'/api/my/study/history',reader),/không khớp nguyên tác/);
});

test('renaming completed history changes its private library title without rewriting translation or accepting foreign ownership',async()=>{
 const env={DB:new MemoryDB(),FILES:new MemoryFiles()},complete={...draft,state:{...draft.state,translationParts:['Phần thứ nhất.','Phần thứ hai.'],done:2}},saved=await (await studyHistoryRoute(jsonRequest(base,'POST',complete),env,'/api/my/study/history',reader)).json(),path=`/api/my/study/history/${saved.id}`,url=`${base}/${saved.id}`,before=[...env.FILES.values.entries()].map(([key,item])=>[key,item.value]),title='Vectơ trong không gian – bài 1';
 assert.equal((await studyHistoryRoute(jsonRequest(url,'PATCH',{title,apiKey:'must-never-be-stored'}),env,path,reader)).status,200);
 assert.equal(env.DB.sessions.get(saved.id).title,title);assert.equal(env.DB.stories.get(saved.libraryStoryId).title,title);assert.equal([...env.DB.chapters.values()][0].title,title);assert.deepEqual([...env.FILES.values.entries()].map(([key,item])=>[key,item.value]),before);
 assert.equal((await studyHistoryRoute(jsonRequest(url,'PATCH',{title:'Tên của người khác'}),env,path,{id:'student-2'})).status,404);assert.equal(env.DB.sessions.get(saved.id).title,title);
 assert.equal((await studyHistoryRoute(jsonRequest(url,'PATCH',{title:'   '}),env,path,reader)).status,400);
 await assert.rejects(()=>studyHistoryRoute(jsonRequest(url,'PATCH',{title:'a'.repeat(201)}),env,path,reader),/Tên lịch sử/);
 const restored=await (await studyHistoryRoute(new Request(url),env,path,reader)).json();assert.equal(restored.title,title);assert.equal(restored.state.done,2);assert.doesNotMatch(JSON.stringify(restored),/must-never-be-stored/);
});

// A text session keeps what the checks still found in its parts (notes: "Trang N · đoạn k: …"), so the session opened
// again names them (frontend/study.js): strings only, the last 200, each at most 500 characters.
test('A text session keeps the notes of its parts, bounded; anything else in their place is left out',async()=>{
 const DB=new MemoryDB(),FILES=new MemoryFiles(),env={DB,FILES},stored=id=>JSON.parse(FILES.values.get(DB.sessions.get(id).state_key).value);
 const notes=['Trang 1 · đoạn 2: còn chữ Hán chưa dịch: 归乡',7,'',' ',...Array.from({length:205},(_,i)=>`Phần ${i+1}: ${'x'.repeat(600)}`)];
 const saved=await (await studyHistoryRoute(jsonRequest(base,'POST',{...draft,state:{...draft.state,notes}}),env,'/api/my/study/history',reader)).json(),kept=stored(saved.id).notes;
 assert.equal(kept.length,200);assert.ok(kept.every(note=>typeof note==='string'&&note.length<=500));assert.match(kept[0],/^Phần 6: x/u);assert.match(kept.at(-1),/^Phần 205: x/u);
 const other=await (await studyHistoryRoute(jsonRequest(base,'POST',{...draft,state:{...draft.state,notes:'Trang 1: …'}}),env,'/api/my/study/history',reader)).json();
 assert.equal('notes' in stored(other.id),false);
});
