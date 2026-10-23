import test from 'node:test';
import assert from 'node:assert/strict';
import {studyHistoryRoute,MAX_PARTS,MAX_BOOK_GLOSSARY} from './study-history.js';
import {sqliteEnvironment} from './test-support/sqlite-d1.mjs';

const reader={id:'student-limits',name:'Lan'},base='/api/my/study/history';
function setup(t,vars={}){
 const {sqlite,env}=sqliteEnvironment(t,{vars});
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(reader.id,'google-limits','lan@example.test','Lan');
 const call=async(body,{id='',method=id?'PUT':'POST'}={})=>{const path=id?`${base}/${id}`:base;try{return await studyHistoryRoute(new Request('https://hoatri.example'+path,{method,headers:{'Content-Type':'application/json'},body:method==='GET'||method==='DELETE'?undefined:JSON.stringify(body)}),env,path,reader);}catch(error){return error;}};
 return {sqlite,env,call};
}
const textState=(parts,translated=parts.length)=>({source:parts.join('\n\n'),parts,translationParts:parts.slice(0,translated).map((_,i)=>`Phần ${i+1}.`),done:translated});
const save=(state,extra={})=>({title:'Bài học',filename:'bai.txt',domain:'general',mode:'economy',state,...extra});

test('A session of up to 3,000 parts saves, as many as one PDF extraction may hold; more is refused with the real reason',async t=>{
 const {call,sqlite}=setup(t),parts=Array.from({length:1200},(_,i)=>`第${i}段。`);
 const response=await call(save(textState(parts,600)));assert.equal(response.status,201,'1,200 parts were refused as "không khớp nguyên tác" before');
 assert.equal(sqlite.prepare('SELECT total_parts,translated_parts FROM study_sessions').get().total_parts,1200);
 const over=await call(save(textState(Array.from({length:MAX_PARTS+1},(_,i)=>`第${i}段。`),0)));
 assert.deepEqual([over.status,over.code],[413,'too_many_parts']);assert.match(over.message,/3\.001 phần, nhiều hơn mức 3\.000 phần/u);
 // More translations than parts were dropped in silence before; now the save says so.
 const state=textState(['第一段。','第二段。']);state.translationParts.push('Thừa.');
 const extra=await call(save(state));assert.deepEqual([extra.status,extra.code],[400,'history_invalid']);
});

test('A save made from an older revision of a session is refused without writing anything; saves without one still work',async t=>{
 const {call,sqlite,env}=setup(t),state=textState(['第一段。','第二段。'],1);
 const first=await (await call(save(state))).json();assert.equal(first.revision,1);
 const second=await call(save({...state,translationParts:['Một.','Hai.'],done:2},{revision:1}),{id:first.id});
 assert.equal(second.status,200);assert.equal((await second.json()).revision,2);
 const key=sqlite.prepare('SELECT state_key FROM study_sessions').get().state_key,before=await (await env.FILES.get(key)).text();
 // The stale tab still believes it is at revision 1 and has done only one part.
 const stale=await call(save(state,{revision:1}),{id:first.id});assert.equal(stale.status,409);
 assert.deepEqual(await stale.json(),{error:'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác. Hãy tải lại bản dịch từ Lịch sử dịch rồi tiếp tục, để không ghi đè phần đã dịch.',code:'history_conflict',revision:2,updatedAt:sqlite.prepare('SELECT updated_at FROM study_sessions').get().updated_at});
 assert.equal(await (await env.FILES.get(key)).text(),before);assert.deepEqual({...sqlite.prepare('SELECT status,translated_parts,revision FROM study_sessions').get()},{status:'complete',translated_parts:2,revision:2});
 // A browser from before revisions sends none and saves as it always did; the list and the session report the revision.
 assert.equal((await call(save({...state,translationParts:['Một.','Hai.'],done:2}),{id:first.id})).status,200);
 const list=await (await call(null,{method:'GET'})).json();assert.equal(list[0].revision,3);
 assert.equal((await (await call(null,{id:first.id,method:'GET'})).json()).revision,3);
 assert.deepEqual([(await call(save(state,{revision:-1}),{id:first.id})).status],[400]);
});

test('An account\'s history is held to a number of items, a size and new items a day; updating within its room always works',async t=>{
 const {call,sqlite}=setup(t,{MAX_HISTORY_PER_USER:'2',DAILY_HISTORY_PER_USER:'0',MAX_HISTORY_MB_PER_USER:'0'}),state=textState(['第一段。']);
 const one=await (await call(save(state))).json();await call(save(state));
 const third=await call(save(state));assert.equal(third.status,413);const body=await third.json();
 assert.equal(body.code,'history_full');assert.match(body.error,/đã có 2 bản dịch.*Hãy xóa trong Lịch sử dịch/u);assert.deepEqual([body.items,body.maxItems],[2,2]);
 assert.equal((await call(save(state),{id:one.id})).status,200,'an existing item still saves');
 assert.equal((await call(null,{id:one.id,method:'DELETE'})).status,200);assert.equal((await call(save(state))).status,201,'deleting frees room');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM study_sessions').get().n,2);
});

test('New items saved at once cannot all pass the room: only those that fit are kept, and the others leave nothing behind',async t=>{
 // Eight complete items of about 0.6 MB (each would start a book) sent together, against 1 MB: one fits.
 const {call,sqlite,env}=setup(t,{MAX_HISTORY_MB_PER_USER:'1',MAX_HISTORY_PER_USER:'0',DAILY_HISTORY_PER_USER:'0'});
 const answers=await Promise.all(Array.from({length:8},(_,n)=>call(save(textState([`${'长'.repeat(95000)}${n}。`])))));
 assert.deepEqual(answers.map(answer=>answer.status).sort(),[201,413,413,413,413,413,413,413]);
 for(const answer of answers.filter(answer=>answer.status===413))assert.equal((await answer.json()).code,'history_full');
 const kept=sqlite.prepare('SELECT id FROM study_sessions').all().map(row=>row.id);assert.equal(kept.length,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM stories').get().n,1,'a refused item starts no book');
 assert.deepEqual([...new Set(env.FILES.keys(`study/${reader.id}/`).map(key=>key.split('/')[2]))],kept,'only the kept item has files');
 // The number of items is held the same way.
 const small=save(textState(['第一段。'])),items=setup(t,{MAX_HISTORY_PER_USER:'2',MAX_HISTORY_MB_PER_USER:'0',DAILY_HISTORY_PER_USER:'0'});
 assert.deepEqual((await Promise.all(Array.from({length:5},()=>items.call(small)))).map(answer=>answer.status).sort(),[201,201,413,413,413]);
 assert.equal(items.sqlite.prepare('SELECT COUNT(*) AS n FROM study_sessions').get().n,2);
 // A first save sent twice at once under its own id (as a whole-book chunk is): the second is an update, not a new item.
 const last=setup(t,{MAX_HISTORY_PER_USER:'1',MAX_HISTORY_MB_PER_USER:'0',DAILY_HISTORY_PER_USER:'0'}),id=crypto.randomUUID();
 assert.deepEqual((await Promise.all([last.call({...small,id}),last.call({...small,id})])).map(answer=>answer.status),[201,201]);
 assert.deepEqual(last.sqlite.prepare('SELECT id,revision FROM study_sessions').all().map(row=>({...row})),[{id,revision:2}]);
});

test('A new item the guard refused answers 413 history_full and leaves no files, also when room is freed before the check after it; a failed new item leaves no files',async t=>{
 for(const [vars,long] of [[{MAX_HISTORY_PER_USER:'2',MAX_HISTORY_MB_PER_USER:'0',DAILY_HISTORY_PER_USER:'0'},''],[{MAX_HISTORY_PER_USER:'0',MAX_HISTORY_MB_PER_USER:'1',DAILY_HISTORY_PER_USER:'0'},'中'.repeat(60000)]]){
  const {call,sqlite,env}=setup(t,vars),item=title=>save(textState([`${title}第一段。${long}`,`${title}第二段。`]),{title});
  const a=await (await call(item('A'))).json();
  // D passes the check before writing and waits at its batch; C, saved from another tab meanwhile, takes the last room;
  // a third tab deletes A right after the guard refused D, before D checks the room again. D answered a raw 500 and
  // left its state.json and translation.txt behind.
  const batch=env.DB.batch.bind(env.DB);let entered,release;const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});let held=false;
  env.DB.batch=async statements=>{
   if(held)return batch(statements);
   held=true;entered();await gate;
   try{return await batch(statements);}
   catch(error){assert.equal((await call(null,{id:a.id,method:'DELETE'})).status,200);throw error;}
  };
  const d=call(item('D'));await waiting;
  assert.equal((await call(item('C'))).status,201);release();
  const refused=await d;assert.equal(refused.status,413,refused.message);const body=await refused.json();
  assert.equal(body.code,'history_full');assert.match(body.error,/vừa đầy lúc lưu bản dịch này.*Hãy xóa trong Lịch sử dịch/u);
  const kept=sqlite.prepare('SELECT id,title FROM study_sessions').all();assert.deepEqual(kept.map(row=>row.title),['C']);
  assert.deepEqual([...new Set(env.FILES.keys(`study/${reader.id}/`).map(key=>key.split('/')[2]))],[kept[0].id],'only the kept item has files');
  env.DB.batch=batch;
 }
 // Any other failure of a new item's batch (the database lost meanwhile) leaves none of its files either.
 const {call,sqlite,env}=setup(t,{MAX_HISTORY_PER_USER:'5',DAILY_HISTORY_PER_USER:'0'});
 env.DB.batch=async()=>{throw new Error('D1_ERROR: Network connection lost.');};
 const failed=await call(save(textState(['第一段。'])));assert.match(failed.message,/Network connection lost/u);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM study_sessions').get().n,0);assert.deepEqual(env.FILES.keys(`study/${reader.id}/`),[]);
});

test('The size limit counts what each item stores and lets an item shrink; the daily limit counts only new items',async t=>{
 const {call,sqlite}=setup(t,{MAX_HISTORY_MB_PER_USER:'1',MAX_HISTORY_PER_USER:'0',DAILY_HISTORY_PER_USER:'2'});
 const big=textState([`${'长'.repeat(150000)}。`]);big.translationParts=['Dài '.repeat(1000)];
 const first=await call(save(big));assert.equal(first.status,201);const {id}=await first.json();
 const stored=sqlite.prepare('SELECT stored_bytes FROM study_sessions WHERE id=?').get(id).stored_bytes;assert.ok(stored>900000&&stored<1048576,String(stored));
 const second=await call(save(big));assert.equal(second.status,413);assert.match((await second.json()).error,/sẽ vượt mức 1,0 MB/u);
 assert.equal((await call(save(textState(['短。'])),{})).status,201);
 // Over the room already, an item may still be saved again smaller (or the same).
 assert.equal((await call(save(textState(['短。'])),{id})).status,200);
 const daily=await call(save(textState(['再一个。'])));assert.equal(daily.status,429);assert.equal((await daily.json()).code,'rate_limited');
 assert.equal((await call(save(textState(['短。'])),{id})).status,200,'saving an existing item is not a new one');
});

test('A book\'s terms stop growing at the cap; the terms it has stay, and a new book keeps the student\'s own terms first',async t=>{
 const {call,sqlite}=setup(t,{MAX_HISTORY_MB_PER_USER:'0'}),state=textState(['第一段。']),bytes=text=>new TextEncoder().encode(text).length;
 const saved=await (await call(save({...state,glossary:{一:'một'}}))).json();
 // A book 30 bytes under the cap (ASCII terms: one byte a character).
 const terms={};for(let i=0;JSON.stringify(terms).length<MAX_BOOK_GLOSSARY-200;i++)terms[`term${i}`]='x'.repeat(90);
 terms.pad='y'.repeat(MAX_BOOK_GLOSSARY-30-JSON.stringify(terms).length-',"pad":""'.length);
 sqlite.prepare('UPDATE stories SET glossary=? WHERE id=?').run(JSON.stringify(terms),saved.libraryStoryId);
 const kept=sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(saved.libraryStoryId).glossary;assert.equal(bytes(kept),MAX_BOOK_GLOSSARY-30);
 const range=await call(save({...state,glossary:{新词:'từ mới'.repeat(10)}},{bookId:saved.libraryStoryId}));assert.equal(range.status,201);
 assert.equal(sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(saved.libraryStoryId).glossary,kept);
 // Long terms of 100 + 100 characters (one save may carry 1,000) start a book within the cap, the student's own first.
 const many=(prefix,count)=>Object.fromEntries(Array.from({length:count},(_,i)=>[`${prefix}${String(i).padStart(3,'0')}${'字'.repeat(95)}`,`nghĩa ${i} `.repeat(10).slice(0,100)]));
 const own=await (await call(save({...state,glossary:many('学',500),manualGlossary:many('师',200)}))).json();
 const book=JSON.parse(sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(own.libraryStoryId).glossary);
 assert.ok(bytes(JSON.stringify(book))<=MAX_BOOK_GLOSSARY);assert.ok(Object.keys(many('师',200)).every(key=>key in book),'every term the student set');assert.ok(Object.keys(book).length<700);
});
