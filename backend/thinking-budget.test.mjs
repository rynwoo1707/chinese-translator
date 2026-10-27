import test from 'node:test';
import assert from 'node:assert/strict';
import {generate,withThinking} from './ai.js';
import worker,{processJob} from './worker.js';
import {modeProfile,modeLabel} from '../frontend/translation-modes.js';
import {sqliteEnvironment} from './test-support/sqlite-d1.mjs';

function mockGemini(text='{"ok":true}',usageMetadata={promptTokenCount:10,candidatesTokenCount:5,thoughtsTokenCount:7,totalTokenCount:22}){
 const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],usageMetadata});};
 return calls;
}
const thinkingFor=async(model,level)=>{const calls=mockGemini();await generate({GEMINI_API_KEY:'key',GEMINI_MODEL:model,GEMINI_THINKING:level},[{text:'x'}],'instruction');return calls[0].body.generationConfig.thinkingConfig;};

test('thinking levels map to a bounded config per model family and default leaves the model unconstrained',async()=>{
 assert.deepEqual(await thinkingFor('gemini-3.6-flash','minimal'),{thinkingLevel:'minimal'});
 assert.deepEqual(await thinkingFor('gemini-3.6-flash','low'),{thinkingLevel:'low'});
 assert.deepEqual(await thinkingFor('gemini-2.5-flash','minimal'),{thinkingBudget:0});
 assert.deepEqual(await thinkingFor('gemini-2.5-flash-lite','low'),{thinkingBudget:1024});
 assert.equal(await thinkingFor('gemini-3.6-flash',undefined),undefined);
 assert.equal(await thinkingFor('gemini-3.6-flash','default'),undefined);
});

test('reasoning tokens are reported separately from visible output',async()=>{
 mockGemini();
 const result=await generate(withThinking({GEMINI_API_KEY:'key',GEMINI_MODEL:'gemini-3.6-flash'},'low'),[{text:'x'}],'instruction');
 assert.deepEqual(result.__usage,{prompt:10,output:5,thinking:7,total:22,requests:1,cacheHits:0});
});

function memoryEnv(job,story,extra={}){
 const files=new Map(),updates=[];
 const DB={prepare(sql){return {bind(...args){return {first:async()=>sql.startsWith('SELECT * FROM jobs')?job:sql.startsWith('SELECT * FROM stories')?story:null,run:async()=>{updates.push({sql,args});return {meta:{changes:1}};}};}};}};
 const FILES={get:async key=>files.has(key)?{json:async()=>JSON.parse(files.get(key)),text:async()=>files.get(key)}:null,put:async(key,value)=>{files.set(key,typeof value==='string'?value:JSON.stringify(value));},delete:async()=>{}};
 return {env:{DB,FILES,GEMINI_API_KEY:'key',GEMINI_MODEL:'gemini-3.6-flash',...extra},updates};
}

// One step of an admin job ("Cách dịch" from the job, else ADMIN_TRANSLATION_MODE, else premium): the Gemini calls made and
// the row it saved, with the value bound to one of its columns.
async function adminStep(job={},extra={}){
 const calls=mockGemini(JSON.stringify({translation:'Xin chào thế giới.',contextUpdate:'',glossaryUpdates:{}}));
 const {env,updates}=memoryEnv({id:'j1',story_id:'s1',source:'你好世界。',warnings:'[]',mime:'text/plain',...job},{id:'s1',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}',context:''},extra);
 await processJob('j1',env);
 const saved=updates.find(u=>u.sql.startsWith('UPDATE jobs SET source='));assert.ok(saved,'job progress was saved');
 return {calls,progress:saved.args[6],column:name=>saved.args[(saved.sql.slice(0,saved.sql.indexOf(`,${name}=?`)).match(/\?/gu)||[]).length]};
}
const payloadOf=call=>JSON.parse(call.body.contents[0].parts[0].text);
// C2: the 2.5 Flash family takes a budget per level, and a call that thinks more gets room for it in its output cap.
const BUDGET={minimal:0,low:1024,medium:4096,high:12288},HEADROOM={minimal:0,low:2048,medium:8192,high:16384};

test('admin book translation thinks as the job\'s "Cách dịch" asks, premium by default, and shows reasoning tokens and the mode',async()=>{
 const premium=await adminStep(),level=modeProfile('premium').translateThinking;
 assert.equal(premium.calls.length,1);assert.deepEqual(premium.calls[0].body.generationConfig.thinkingConfig,{thinkingLevel:level});
 assert.match(premium.progress,/7 suy luận/u);assert.match(premium.progress,/ · Cách dịch: Kỹ nhất(?: · |$)/u);
 // The reasoning tokens and the mode the step used are kept with the job (migration 0025).
 assert.equal(premium.column('thinking_tokens'),7);assert.equal(premium.column('mode'),'premium');
 // A job's own mode wins; without one ADMIN_TRANSLATION_MODE does, and a value that is no mode is ignored.
 for(const [job,extra,mode] of [[{mode:'economy'},{},'economy'],[{},{ADMIN_TRANSLATION_MODE:'quality'},'quality'],[{mode:'balanced'},{ADMIN_TRANSLATION_MODE:'quality'},'balanced'],[{},{ADMIN_TRANSLATION_MODE:'turbo'},'premium'],[{mode:'turbo'},{},'premium']]){
  const step=await adminStep(job,extra),label=modeLabel(mode).replace(/\s*\([^()]*\)$/u,'');
  assert.deepEqual(step.calls[0].body.generationConfig.thinkingConfig,{thinkingLevel:modeProfile(mode).translateThinking},mode);
  assert.equal(step.column('mode'),mode);assert.ok(label&&!label.includes('('),label);assert.ok(step.progress.includes(` · Cách dịch: ${label}`),`${mode}: ${step.progress}`);
 }
 // The 2.5 Flash family gets the level's budget and the room for it.
 const flash=await adminStep({},{GEMINI_MODEL:'gemini-2.5-flash'});
 assert.deepEqual(flash.calls[0].body.generationConfig.thinkingConfig,{thinkingBudget:BUDGET[level]});assert.equal(flash.calls[0].body.generationConfig.maxOutputTokens,32768+HEADROOM[level]);
 // GEMINI_THINKING still decides every step when it is set.
 assert.deepEqual((await adminStep({},{GEMINI_THINKING:'minimal'})).calls[0].body.generationConfig.thinkingConfig,{thinkingLevel:'minimal'});
});

test('GEMINI_THINKING counts only as a level: a typo leaves each step to the job\'s mode, never to unbounded thinking',async()=>{
 for(const mode of ['premium','economy']){
  const level=modeProfile(mode).translateThinking;
  for(const [model,config] of [['gemini-3.6-flash',{thinkingLevel:level}],['gemini-2.5-flash',{thinkingBudget:BUDGET[level]}]])for(const value of ['Medium','hgih','max',' ']){
   const sent=(await adminStep({mode},{GEMINI_MODEL:model,GEMINI_THINKING:value})).calls[0].body.generationConfig;
   assert.deepEqual(sent.thinkingConfig,config,`${mode} ${model} ${JSON.stringify(value)}`);assert.equal(sent.maxOutputTokens,32768+HEADROOM[level]);
  }
 }
 // A level with spaces around it is that level; 'default' is the model's own thinking, as documented.
 assert.deepEqual((await adminStep({},{GEMINI_THINKING:' low '})).calls[0].body.generationConfig.thinkingConfig,{thinkingLevel:'low'});
 assert.equal((await adminStep({},{GEMINI_THINKING:'default '})).calls[0].body.generationConfig.thinkingConfig,undefined);
});

// A scanned page of an admin job read by Gemini, then translated, on SQLite with every migration: each step's tokens,
// those of a call that failed or gave an unusable answer included (they are billed), reach the job's columns and its
// checkpoint, so the steps after it count on from there, and its progress line once a page is read.
test('an admin job counts what its OCR step spent on Gemini, a cut-off, unusable or refused answer included',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{vars:{GEMINI_API_KEY:'key',GEMINI_MODEL:'gemini-3.6-flash'}});
 sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách','Giáo dục')").run();
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,file_key,mime,source,warnings) VALUES('j1','s1','trang.jpg','uploads/j1','image/jpeg','','[]')").run();
 await env.FILES.put('uploads/j1',new Uint8Array([255,216,255,1,2,3]));
 // Every call bills 2,300 tokens, 900 of them thinking: an answer cut off, one with no text, a page read, a translation
 // refused, then one given.
 const answers=[['{"text":"你好','MAX_TOKENS'],[JSON.stringify({text:'  ',warnings:[]})],[JSON.stringify({text:'你好世界。',warnings:[]})],['','SAFETY'],[JSON.stringify({translation:'Xin chào thế giới.',contextUpdate:'',glossaryUpdates:{}})]],calls=[];
 globalThis.fetch=async(url,options)=>{const [text,finishReason='STOP']=answers[calls.length];calls.push(JSON.parse(options.body));return Response.json({candidates:[{finishReason,content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:1100,candidatesTokenCount:300,thoughtsTokenCount:900,totalTokenCount:2300}});};
 const format=value=>new Intl.NumberFormat('vi-VN').format(value),checkpoint=async()=>(await env.FILES.get('processing/j1.json')).json();
 const step=async(count,status)=>{
  await processJob('j1',env);const saved={...sqlite.prepare('SELECT status,error,progress,prompt_tokens,output_tokens,thinking_tokens,total_tokens,ai_requests,model,mode FROM jobs WHERE id=?').get('j1')};
  assert.deepEqual([saved.status,saved.prompt_tokens,saved.output_tokens,saved.thinking_tokens,saved.total_tokens,saved.ai_requests,saved.model,saved.mode],[status,1100*count,300*count,900*count,2300*count,count,'gemini-3.6-flash','premium'],`after ${count} calls: ${JSON.stringify(saved)}`);
  assert.equal((await checkpoint()).usage.total,2300*count);return saved;
 };
 const line=count=>` · ${format(2300*count)} token Gemini (${format(900*count)} suy luận) · Cách dịch: Kỹ nhất`;
 // Cut off, then unusable: the job fails each time and nothing is read yet, but both calls count. Its line stays as it
 // was (empty), so its editor stays open (next test).
 assert.equal((await step(1,'failed')).progress,'');assert.deepEqual(calls[0].generationConfig.thinkingConfig,{thinkingLevel:modeProfile('premium').ocrThinking});
 const unusable=await step(2,'failed');assert.equal(unusable.error,'Kết quả OCR không hợp lệ.');assert.equal(unusable.progress,'');assert.deepEqual((({page,ocrDone,source})=>[page,ocrDone,source])(await checkpoint()),[0,false,'']);
 const read=await step(3,'ocr');assert.match(read.progress,/^Đã đọc 1\/1 trang · /u);assert.ok(read.progress.includes(line(3)),read.progress);
 // A refused translation counts as well, on the line too; the part is still to be translated.
 const refused=await step(4,'failed');assert.ok(refused.progress.includes(line(4)),refused.progress);assert.equal((await checkpoint()).part,0);
 const translated=await step(5,'assembling');assert.match(translated.progress,/^Đã đọc 1\/1 trang · Đã dịch 1 phần · 100% văn bản · /u);assert.ok(translated.progress.includes(line(5)),translated.progress);assert.equal(calls.length,5);
});

// What a refused first call was billed is kept, in the job's columns and checkpoint, without making the job look
// half-done: its line stays as it was and an admin may still type its translation (PATCH /api/jobs/:id), as before
// these tokens were counted. The console locks a failed job's editor once it shows a line (frontend/app.js); the server
// once its checkpoint holds work, a page read or a part translated, which a hand edit would throw away.
test('a billed failure before any work leaves the job editable by hand; after a step it is locked as before',async t=>{
 const TOKEN='a'.repeat(64),{sqlite,env}=sqliteEnvironment(t,{vars:{ADMIN_TOKEN:TOKEN,GEMINI_API_KEY:'key',GEMINI_MODEL:'gemini-3.6-flash'}});
 const edit=id=>worker.fetch(new Request(`https://hoatri.example/api/jobs/${id}`,{method:'PATCH',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({source:'床前明月光。',translation:'Đầu giường ánh trăng soi.'})}),env,{});
 const row=id=>({...sqlite.prepare('SELECT status,progress,total_tokens,thinking_tokens,ai_requests FROM jobs WHERE id=?').get(id)}),checkpoint=async id=>(await env.FILES.get(`processing/${id}.json`))?.json();
 const answers=[];globalThis.fetch=async()=>{const [text,finishReason='STOP']=answers.shift();return Response.json({candidates:[{finishReason,content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:1100,candidatesTokenCount:300,thoughtsTokenCount:900,totalTokenCount:2300}});};
 sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách','Cổ văn · Hán Nôm')").run();
 for(const id of ['photo','read'])await env.FILES.put(`uploads/${id}`,new Uint8Array([255,216,255,1,2,3]));
 // Pasted text refused (and refused again when tried again), cut off or recited; a part of a book, whose line was
 // written when it was split; a photo read with no text.
 for(const [id,mime,source,progress,answer,tries=1] of [['refused',null,'床前明月光，疑是地上霜。','',['','SAFETY'],2],['cut',null,'举头望明月，低头思故乡。','',['{"translation":"Ngẩng đầu','MAX_TOKENS']],['recited',null,'学而时习之，不亦说乎？','',['','RECITATION']],['part','application/epub+zip','有朋自远方来，不亦乐乎？','Phần 1/2 · sẵn sàng dịch',['','SAFETY']],['photo','image/jpeg','','',[JSON.stringify({text:' ',warnings:[]})]]]){
  sqlite.prepare("INSERT INTO jobs(id,story_id,filename,file_key,mime,source,warnings,progress) VALUES(?,'s1',?,?,?,?,'[]',?)").run(id,id,id==='photo'?'uploads/photo':null,mime,source,progress);
  for(let n=0;n<tries;n++){answers.push(answer);await processJob(id,env);}
  assert.deepEqual(row(id),{status:'failed',progress,total_tokens:2300*tries,thinking_tokens:900*tries,ai_requests:tries},id);
  const kept=await checkpoint(id);assert.deepEqual([kept.page,kept.part,kept.usage.total],[0,0,2300*tries],id);
  const response=await edit(id);assert.equal(response.status,200,`${id}: ${await response.clone().text()}`);
  assert.equal(row(id).status,'review',id);assert.equal(await checkpoint(id),undefined,`${id}: the edit drops the checkpoint`);
 }
 // Once a page is read, a refused translation shows on the job's line and the job is locked, as a half-done one is.
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,file_key,mime,source,warnings) VALUES('read','s1','trang.jpg','uploads/read','image/jpeg','','[]')").run();
 answers.push([JSON.stringify({text:'你好世界。',warnings:[]})],['','SAFETY']);await processJob('read',env);await processJob('read',env);
 const locked=row('read');assert.deepEqual([locked.status,locked.total_tokens,locked.ai_requests],['failed',4600,2]);
 assert.ok(locked.progress.startsWith(`Đã đọc 1/1 trang · Đã dịch 0 phần · 0% văn bản · ${new Intl.NumberFormat('vi-VN').format(4600)} token Gemini`),locked.progress);
 const refused=await edit('read');assert.equal(refused.status,400);assert.equal((await refused.json()).error,'Không thể sửa bản dịch ở trạng thái hiện tại.');
 assert.equal((await checkpoint('read')).page,1);assert.equal(row('read').status,'failed');
 // A checkpoint that cannot be read counts as work.
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,warnings) VALUES('unread','s1','bai.txt','failed','短文。','[]')").run();
 await env.FILES.put('processing/unread.json','{"page":');const unread=await edit('unread');
 assert.deepEqual([unread.status,(await unread.json()).error],[400,'Không thể sửa bản dịch ở trạng thái hiện tại.']);
});

test('an admin job takes steps of its mode\'s size, and a dropped marker is asked again with the mode\'s retry thinking',async()=>{
 const source='今天是新的一天。'.repeat(2500),sizes={};
 for(const mode of ['economy','premium']){const step=await adminStep({mode,source});sizes[mode]=payloadOf(step.calls[0]).source.length;assert.ok(sizes[mode]<=modeProfile(mode).textChunk,`${mode}: ${sizes[mode]}`);}
 if(modeProfile('premium').textChunk<modeProfile('economy').textChunk)assert.ok(sizes.premium<sizes.economy,'premium reads smaller steps');
 // The answer leaves out [12]: the short part is translated again, thinking as the mode's retry says.
 for(const mode of ['economy','premium']){
  const step=await adminStep({mode,source:'原文[12]。'});
  assert.equal(step.calls.length,2,mode);assert.deepEqual(step.calls[1].body.generationConfig.thinkingConfig,{thinkingLevel:modeProfile(mode).retryThinking},mode);
 }
});

test('GEMINI_THINKING=default restores the model default thinking for admin translation',async()=>{
 const calls=mockGemini(JSON.stringify({translation:'Xin chào.',contextUpdate:'',glossaryUpdates:{}}));
 const {env}=memoryEnv({id:'j2',story_id:'s2',source:'你好。',warnings:'[]',mime:'text/plain'},{id:'s2',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}',context:''},{GEMINI_THINKING:'default'});
 await processJob('j2',env);
 assert.equal(calls[0].body.generationConfig.thinkingConfig,undefined);
});
