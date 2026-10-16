import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker,{sha256Hex} from './worker.js';
import {hashToken} from './reader-auth.js';

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
class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value){this.values.set(key,value instanceof ArrayBuffer?new Uint8Array(value):value);}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async get(key){
  if(!this.values.has(key))return null;const value=this.values.get(key),bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return {body:bytes,arrayBuffer:async()=>bytes.slice().buffer,text:async()=>new TextDecoder().decode(bytes),json:async()=>JSON.parse(new TextDecoder().decode(bytes))};
 }
}
const ADMIN='admin-token-for-library-match-tests',STUDENT_TOKEN='student-session-token';
async function environment(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url));
 for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('student-1','sub-1','hs@example.test','Học sinh');
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(STUDENT_TOKEN),'student-1',Date.now()+3600000);
 return {sqlite,env:{DB:new D1Database(sqlite),FILES:new MemoryFiles(),ADMIN_TOKEN:ADMIN}};
}
const call=(env,path,{method='GET',body,admin=false,student=false}={})=>worker.fetch(new Request('https://school.test'+path,{method,body,headers:{...(admin?{Authorization:`Bearer ${ADMIN}`}:{}),...(student?{Cookie:`cat_hien_session=${STUDENT_TOKEN}`}:{}),...(typeof body==='string'?{'Content-Type':'application/json'}:{})}}),env,{});
const textbook=new TextEncoder().encode('第一章 空间向量\n\n向量是既有大小又有方向的量。');

async function publishTextbook(env,sqlite,visibility='public'){
 const story=await (await call(env,'/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Toán 11 - Vectơ',genre:'Toán học · STEM',visibility})})).json();
 const form=new FormData();form.set('story_id',story.id);form.set('file',new File([textbook],'toan-11.txt',{type:'text/plain'}));
 const job=await (await call(env,'/api/jobs',{method:'POST',admin:true,body:form})).json();
 sqlite.prepare("UPDATE jobs SET status='review',translation=? WHERE id=?").run('Chương 1. Vectơ trong không gian\n\nVectơ là đại lượng có độ lớn và hướng.',job.id);
 const published=await call(env,`/api/jobs/${job.id}/publish`,{method:'POST',admin:true,body:JSON.stringify({title:'Chương 1',confirmed:true})});
 assert.equal(published.status,200);return {storyId:story.id,jobId:job.id};
}

test('a student uploading the same file as a published textbook is pointed to the reviewed translation',async t=>{
 const {sqlite,env}=await environment(t),{storyId,jobId}=await publishTextbook(env,sqlite),sha256=await sha256Hex(textbook);
 assert.equal(sqlite.prepare('SELECT source_sha256 FROM jobs WHERE id=?').get(jobId).source_sha256,sha256);
 const response=await call(env,`/api/my/study/library-match?sha256=${sha256}`,{student:true}),data=await response.json();
 assert.equal(response.status,200);assert.deepEqual({...data.match},{id:storyId,title:'Toán 11 - Vectơ',genre:'Toán học · STEM',chapters:1});
 const other=await (await call(env,`/api/my/study/library-match?sha256=${'0'.repeat(64)}`,{student:true})).json();assert.equal(other.match,null);
});

test('only published public books match, and the lookup needs a signed-in student and a valid hash',async t=>{
 const {sqlite,env}=await environment(t),sha256=await sha256Hex(textbook);
 await publishTextbook(env,sqlite,'private');
 assert.equal((await (await call(env,`/api/my/study/library-match?sha256=${sha256}`,{student:true})).json()).match,null);
 const unpublished=await (await call(env,'/api/stories',{method:'POST',admin:true,body:JSON.stringify({title:'Chưa duyệt',genre:'Toán học · STEM'})})).json();
 const form=new FormData();form.set('story_id',unpublished.id);form.set('file',new File([textbook],'toan-11.txt'));await call(env,'/api/jobs',{method:'POST',admin:true,body:form});
 assert.equal((await (await call(env,`/api/my/study/library-match?sha256=${sha256}`,{student:true})).json()).match,null,'a translation still awaiting review is never suggested');
 assert.equal((await call(env,`/api/my/study/library-match?sha256=${sha256}`)).status,401);
 assert.equal((await call(env,'/api/my/study/library-match?sha256=not-a-hash',{student:true})).status,400);
});

test('jobs uploaded before fingerprints existed receive one when they are published',async t=>{
 const {sqlite,env}=await environment(t),{jobId}=await publishTextbook(env,sqlite);
 sqlite.prepare("UPDATE jobs SET source_sha256=NULL,status='review' WHERE id=?").run(jobId);sqlite.prepare('DELETE FROM chapters WHERE job_id=?').run(jobId);
 assert.equal((await call(env,`/api/jobs/${jobId}/publish`,{method:'POST',admin:true,body:JSON.stringify({title:'Chương 1',confirmed:true})})).status,200);
 assert.equal(sqlite.prepare('SELECT source_sha256 FROM jobs WHERE id=?').get(jobId).source_sha256,await sha256Hex(textbook));
});
