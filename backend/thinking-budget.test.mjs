import test from 'node:test';
import assert from 'node:assert/strict';
import {generate,withThinking} from './ai.js';
import {processJob} from './worker.js';

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

test('admin book translation runs without a reasoning budget and shows reasoning tokens in progress',async()=>{
 const calls=mockGemini(JSON.stringify({translation:'Xin chào thế giới.',contextUpdate:'',glossaryUpdates:{}}));
 const {env,updates}=memoryEnv({id:'j1',story_id:'s1',source:'你好世界。',warnings:'[]',mime:'text/plain'},{id:'s1',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}',context:''});
 await processJob('j1',env);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].body.generationConfig.thinkingConfig,{thinkingLevel:'minimal'});
 const progress=updates.find(u=>u.sql.startsWith('UPDATE jobs SET source='));assert.ok(progress,'job progress was saved');
 assert.match(progress.args[6],/7 suy luận/u);
});

test('GEMINI_THINKING=default restores the model default thinking for admin translation',async()=>{
 const calls=mockGemini(JSON.stringify({translation:'Xin chào.',contextUpdate:'',glossaryUpdates:{}}));
 const {env}=memoryEnv({id:'j2',story_id:'s2',source:'你好。',warnings:'[]',mime:'text/plain'},{id:'s2',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}',context:''},{GEMINI_THINKING:'default'});
 await processJob('j2',env);
 assert.equal(calls[0].body.generationConfig.thinkingConfig,undefined);
});
