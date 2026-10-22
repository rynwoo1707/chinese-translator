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
