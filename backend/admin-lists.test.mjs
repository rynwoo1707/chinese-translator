import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{boundedGlossary} from './worker.js';
import {sqliteEnvironment} from './test-support/sqlite-d1.mjs';

const TOKEN='a'.repeat(64);
function setup(t){
 const {sqlite,env}=sqliteEnvironment(t,{vars:{ADMIN_TOKEN:TOKEN}});
 const call=(path,{method='GET',body,admin=true,origin='https://hoatri.example'}={})=>worker.fetch(new Request(origin+path,{method,headers:{...(admin?{Authorization:`Bearer ${TOKEN}`}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{});
 return {sqlite,env,call};
}
// A big glossary like the ones students' saves can attach to their private books (500 + 500 terms).
const bigGlossary=JSON.stringify(Object.fromEntries(Array.from({length:1000},(_,i)=>[`术语${i}${'字'.repeat(60)}`,'thuật ngữ dài '.repeat(6)])));
function seed(sqlite,{library=3,students=2,booksEach=60,jobs=0}={}){
 for(let i=0;i<library;i++)sqlite.prepare("INSERT INTO stories(id,title,genre,glossary,context,created_at) VALUES(?,?,'Giáo dục',?,?,?)").run(`lib-${i}`,`Sách ${i}`,JSON.stringify({书:'sách'}),'ngữ cảnh',`2026-01-0${i+1} 00:00:00`);
 for(let u=0;u<students;u++){
  sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)').run(`u${u}`,`g${u}`,`hs${u}@example.test`,`Học sinh ${u}`,`2026-02-0${u+1} 00:00:00`);
  for(let b=0;b<booksEach;b++)sqlite.prepare("INSERT INTO stories(id,title,genre,glossary,context,owner_user_id,visibility,source_url,created_at) VALUES(?,?,'Giáo dục',?,?,?,'private',?,?)").run(`u${u}-b${b}`,`Bản dịch ${b}`,bigGlossary,'Ngữ cảnh riêng '.repeat(60),`u${u}`,`study-book:u${u}-b${b}`,`2026-03-01 00:${String(b).padStart(2,'0')}:00`);
 }
 for(let j=0;j<jobs;j++)sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,translation,warnings,created_at) VALUES(?,?,?,?,?,?,?,?)").run(`job-${j}`,'lib-0',`bai-${j}.txt`,j%2?'review':'translating','原文'.repeat(10000),'Bản dịch '.repeat(2200),JSON.stringify(['Cảnh báo một','Cảnh báo hai']),`2026-04-01 00:${String(j).padStart(2,'0')}:00`);
}

test('The story list is a light, paged array: library books first, no student glossary or context in any row',async t=>{
 const {sqlite,call}=setup(t);seed(sqlite);
 let response=await call('/api/stories');assert.equal(response.status,200);
 const text=await response.text(),rows=JSON.parse(text);
 assert.ok(Array.isArray(rows));assert.equal(rows.length,100);assert.equal(response.headers.get('X-Next-Offset'),'100');
 assert.ok(text.length<64*1024,`${text.length} characters for 100 rows (each student glossary alone is ${bigGlossary.length})`);
 assert.deepEqual(rows.slice(0,3).map(row=>row.id),['lib-2','lib-1','lib-0'],'library books first, newest first');
 assert.deepEqual(Object.keys(rows[0]).sort(),['author','chapters','cover_key','cover_page','created_at','genre','glossary','id','owner_email','owner_name','owner_user_id','source_url','title','visibility']);
 assert.equal(rows[0].glossary,JSON.stringify({书:'sách'}),'the glossary editor still reads a library book\'s terms');
 assert.ok(rows.slice(3).every(row=>row.glossary===null&&row.owner_user_id&&!('context' in row)));
 response=await call('/api/stories?offset=100&limit=500');const rest=await response.json();
 assert.equal(rest.length,23);assert.equal(response.headers.get('X-Next-Offset'),null);assert.equal(new Set([...rows,...rest].map(row=>row.id)).size,123);
 assert.equal((await (await call('/api/stories?limit=100000')).json()).length,123,'at most 500 rows a page');
 assert.deepEqual((await (await call('/api/stories?scope=library')).json()).map(row=>row.id),['lib-2','lib-1','lib-0']);
 assert.equal((await (await call('/api/stories?scope=personal&limit=5')).json()).length,5);
 // One book with everything its old list row had.
 const detail=await (await call('/api/stories/u1-b7')).json();
 assert.equal(detail.glossary,bigGlossary);assert.match(detail.context,/Ngữ cảnh riêng/u);assert.equal(detail.owner_email,'hs1@example.test');assert.equal(detail.chapters,0);
 assert.equal((await call('/api/stories/missing')).status,404);
 assert.equal((await call('/api/stories',{admin:false})).status,401);
});

test('Students\' books are paged too, newest account first, one student at a time on request',async t=>{
 const {sqlite,call}=setup(t);seed(sqlite);
 const response=await call('/api/user-library?limit=50'),rows=await response.json();
 assert.equal(rows.length,50);assert.equal(response.headers.get('X-Next-Offset'),'50');assert.ok(rows.every(row=>row.owner_user_id==='u1'),'newest account first');
 assert.ok(rows.every(row=>!('glossary' in row)&&!('context' in row)));assert.equal(rows[0].owner_email,'hs1@example.test');
 const one=await (await call('/api/user-library?user=u0&limit=500')).json();assert.equal(one.length,60);assert.ok(one.every(row=>row.owner_user_id==='u0'));
});

test('The job list leaves the text and warnings to the job\'s own route, and polls a running job by id',async t=>{
 const {sqlite,call}=setup(t);seed(sqlite,{jobs:30,students:0});
 const response=await call('/api/jobs'),text=await response.text(),rows=JSON.parse(text);
 assert.equal(rows.length,30);assert.equal(response.headers.get('X-Next-Offset'),null);assert.ok(text.length<32*1024,`${text.length} characters`);
 for(const field of ['source','translation','warnings'])assert.ok(!(field in rows[0]),field);
 assert.deepEqual([rows[0].id,rows[0].story_title,rows[0].has_translation,rows[0].warning_count],['job-29','Sách 0',1,2]);
 assert.deepEqual((await (await call('/api/jobs?ids=job-3,job-4,nope')).json()).map(row=>row.id),['job-4','job-3']);
 assert.deepEqual(await (await call('/api/jobs?ids=')).json(),[]);
 assert.equal((await (await call('/api/jobs?status=translating')).json()).length,15);
 assert.equal((await (await call('/api/jobs?limit=10&offset=25')).json()).length,5);
 const detail=await (await call('/api/jobs/job-3')).json();
 assert.equal(detail.source,'原文'.repeat(10000));assert.match(detail.translation,/^Bản dịch /u);assert.equal(detail.warnings,JSON.stringify(['Cảnh báo một','Cảnh báo hai']));assert.equal(detail.story_title,'Sách 0');
 assert.equal((await call('/api/jobs/nope')).status,404);
});

test('An admin edit keeps D1 rows small: long text goes to storage, and a glossary is capped',async t=>{
 const {sqlite,env,call}=setup(t);seed(sqlite,{students:0});
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,translation) VALUES('j1','lib-0','bai.txt','uploaded','短文','')").run();
 const source='史'.repeat(500000),translation='Sử '.repeat(300000);
 const response=await call('/api/jobs/j1',{method:'PATCH',body:{source,translation}});assert.equal(response.status,200);assert.equal((await response.json()).long,true);
 const row=sqlite.prepare('SELECT length(source) AS s,length(translation) AS t,source_key,translation_key,status FROM jobs WHERE id=?').get('j1');
 assert.deepEqual([row.s,row.t,row.status],[20000,20000,'review']);
 assert.equal(await (await env.FILES.get(row.source_key)).text(),source);assert.equal(await (await env.FILES.get(row.translation_key)).text(),translation.trim());
 // A short edit stays in the row, as before.
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,translation) VALUES('j2','lib-0','bai.txt','uploaded','短文','')").run();
 assert.equal((await call('/api/jobs/j2',{method:'PATCH',body:{source:'短文。',translation:'Bài ngắn.'}})).status,200);
 assert.deepEqual({...sqlite.prepare('SELECT source,translation,source_key FROM jobs WHERE id=?').get('j2')},{source:'短文。',translation:'Bài ngắn.',source_key:null});
 const many=Object.fromEntries(Array.from({length:5001},(_,i)=>[`词${i}`,`từ ${i}`]));
 const refused=await call('/api/stories/lib-1',{method:'PATCH',body:{glossary:many}});assert.equal(refused.status,413);assert.equal((await refused.json()).code,'glossary_too_large');
 assert.equal((await call('/api/stories/lib-1',{method:'PATCH',body:{glossary:{书:'quyển sách'}}})).status,200);
 // Terms a book learns while it is translated are kept within the same bound, the book's own terms first.
 const learned=Object.fromEntries(Array.from({length:6000},(_,i)=>[`学${i}`,`học ${i}`]));
 const bounded=boundedGlossary({...learned,书:'quyển sách'},JSON.stringify({书:'quyển sách'}));
 assert.equal(Object.keys(bounded).length,5000);assert.equal(Object.keys(bounded)[0],'书');
});

test('Plain http to a public host is sent to https or refused; local development keeps working',async t=>{
 const {call}=setup(t);
 let response=await call('/study?tab=1',{admin:false,origin:'http://hoatri.example'});
 assert.equal(response.status,301);assert.equal(response.headers.get('Location'),'https://hoatri.example/study?tab=1');
 response=await call('/api/health',{admin:false,origin:'http://hoatri.example:8080'});assert.equal(response.headers.get('Location'),'https://hoatri.example/api/health');
 response=await call('/api/auth/login',{method:'POST',body:{email:'lan@example.test',password:'secret'},admin:false,origin:'http://hoatri.example'});
 assert.equal(response.status,403);assert.deepEqual(Object.keys(await response.json()).sort(),['code','error']);
 for(const origin of ['http://127.0.0.1:8787','http://localhost:8787','http://192.168.1.20:8787','http://10.0.0.5:8787','http://[::1]:8787'])assert.notEqual((await call('/api/stories',{origin})).status,301,origin);
 assert.equal((await call('/api/stories')).status,200);
});
