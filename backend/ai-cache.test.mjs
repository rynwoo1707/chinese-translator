import test from 'node:test';
import assert from 'node:assert/strict';
import {translate,translationAnswer,privateStory} from './ai.js';
import {acceptReaderRequest,processJob} from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';

const answer=value=>Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
function gemini(t,answers){const calls=[];t.mock.method(globalThis,'fetch',async()=>{calls.push(1);return answer(answers[Math.min(calls.length,answers.length)-1]);});return calls;}
const cached=env=>env.FILES.keys('ai-cache/');

test('A student\'s private request is translated without leaving its text in the AI cache; a library book still uses it',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{vars:{GEMINI_API_KEY:'server-key',GEMINI_MODEL:'gemini-2.5-flash'}}),reader=await signedIn(sqlite);
 sqlite.prepare("INSERT INTO requests(id,title,user_id,visibility,file_key,filename,mime) VALUES('r1','Ghi chép riêng',?,'private','requests/r1/original','ghi-chep.txt','text/plain')").run(reader.id);
 await env.FILES.put('requests/r1/original','第一章 私人笔记。');
 const calls=gemini(t,[{translation:'BẢN DỊCH RIÊNG TƯ CỦA LAN: Chương một.',contextUpdate:'Ngữ cảnh riêng của Lan.',glossaryUpdates:{}}]);
 const {job_id}=await acceptReaderRequest('r1',env);await processJob(job_id,env);
 assert.equal(calls.length,1);assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(job_id).status,'assembling');
 assert.deepEqual(cached(env),[],'nothing of the private text is cached');
 // A public request still belongs to its student: no cache either.
 assert.equal(privateStory({owner_user_id:reader.id,visibility:'public'}),true);assert.equal(privateStory({owner_user_id:null,visibility:'private'}),true);
 // A library book (no owner, public) keeps the cache, so a re-run of a reviewed job costs nothing.
 const story={genre:'Giáo dục',glossary:'{}',context:''};
 await translate(env,'公开的课文。',story);await translate(env,'公开的课文。',story);
 assert.equal(calls.length,2);assert.equal(cached(env).length,1);
});

test('An answer is stored only once it passes the checks, and a stored answer that fails them is asked for again',async t=>{
 const {env}=sqliteEnvironment(t,{vars:{GEMINI_API_KEY:'server-key',GEMINI_MODEL:'gemini-2.5-flash'}}),story={genre:'Giáo dục',glossary:'{}',context:''};
 let calls=gemini(t,[{translation:'',contextUpdate:'',glossaryUpdates:{}}]);
 await assert.rejects(()=>translate(env,'课文一。',story),error=>error.code==='gemini_malformed'&&error.usage?.requests===1);
 assert.deepEqual(cached(env),[],'the empty answer was not stored');
 calls=gemini(t,[{translation:'Bài một.',contextUpdate:'',glossaryUpdates:{}}]);
 assert.equal((await translate(env,'课文一。',story)).translation,'Bài một.');assert.equal(calls.length,1);
 // A stored answer that no longer passes (kept by an older version, or corrupt) is replaced instead of replayed.
 const [key]=cached(env);await env.FILES.put(key,JSON.stringify({translation:'   '}));
 calls=gemini(t,[{translation:'Bài một (mới).',contextUpdate:'',glossaryUpdates:{}}]);
 assert.equal((await translate(env,'课文一。',story)).translation,'Bài một (mới).');assert.equal(calls.length,1);
 assert.equal(JSON.parse(new TextDecoder().decode(env.FILES.values.get(key).bytes)).translation,'Bài một (mới).');
});

test('Notes outside their limits are trimmed instead of failing a billed translation, so a job never sticks on them',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{vars:{GEMINI_API_KEY:'server-key',GEMINI_MODEL:'gemini-2.5-flash'}});
 const glossaryUpdates={世界:'',[`${'长'.repeat(101)}`]:'quá dài',...Object.fromEntries(Array.from({length:45},(_,i)=>[`术语${i}`,`thuật ngữ ${i}`]))};
 const bad={translation:'Xin chào thế giới.',contextUpdate:'Ngữ cảnh '.repeat(80),glossaryUpdates};
 const result=translationAnswer(bad);
 assert.equal(result.translation,'Xin chào thế giới.');assert.equal(result.contextUpdate.length,500);assert.equal(Object.keys(result.glossaryUpdates).length,30);assert.equal(result.glossaryUpdates.世界,undefined);
 // Through the admin pipeline: the first run used to fail with "sai định dạng" and every rerun replayed the cached answer.
 sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách thư viện','Giáo dục')").run();
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,mime,source) VALUES('j1','s1','bai.txt','text/plain','你好世界。')").run();
 const calls=gemini(t,[bad]);await processJob('j1',env);
 const job=sqlite.prepare('SELECT status,error,translation FROM jobs WHERE id=?').get('j1');
 assert.equal(job.error,null);assert.notEqual(job.status,'failed');assert.match(job.translation,/Xin chào thế giới\./u);assert.equal(calls.length,1);
});
