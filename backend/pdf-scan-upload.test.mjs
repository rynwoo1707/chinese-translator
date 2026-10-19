import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {processJob} from './worker.js';

test('Optimized scan pages are validated and checkpointed in reading order',async()=>{
 const objects=new Map(),job={id:'job',mime:'application/pdf'};
 const env={ADMIN_TOKEN:'admin-token-0123456789abcdef-0123',DB:{prepare(){return {bind(){return this;},async first(){return job;}};}},FILES:{async get(key){const value=objects.get(key);return value?{json:async()=>JSON.parse(value)}:null;},async put(key,value){objects.set(key,value);}}};
 const jpeg=new Uint8Array([255,216,255,1,2,3]);
 async function page(number){const form=new FormData();form.set('page',String(number));form.set('total','2');form.set('image',new File([jpeg],`${number}.jpg`,{type:'image/jpeg'}));return worker.fetch(new Request('https://test/api/jobs/job/pdf-page',{method:'POST',headers:{Authorization:'Bearer admin-token-0123456789abcdef-0123'},body:form}),env,{});}
 assert.equal((await page(2)).status,200);let manifest=JSON.parse(objects.get('split/job/manifest.json'));assert.equal(manifest.complete,false);
 assert.equal((await page(1)).status,200);manifest=JSON.parse(objects.get('split/job/manifest.json'));assert.equal(manifest.complete,true);assert.deepEqual(manifest.parts.map(part=>part.startPage),[1,2]);assert.equal(manifest.parts[0].mime,'image/jpeg');
});

test('Mixed PDF reads text pages without a Gemini OCR request and resumes scan pages',async t=>{
 const objects=new Map(),job={id:'mixed',story_id:'story',mime:'application/pdf',source:'',file_key:'original',warnings:'[]'};
 const env={ADMIN_TOKEN:'admin-token-0123456789abcdef-0123',GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM jobs')?job:{context:'',glossary:'{}',genre:'Khác'};},async run(){return {};}};}},FILES:{async get(key){const value=objects.get(key);return value===undefined?null:{...new Blob([value]),size:new Blob([value]).size,json:async()=>JSON.parse(value),text:async()=>new Blob([value]).text(),arrayBuffer:async()=>new Blob([value]).arrayBuffer()};},async put(key,value){objects.set(key,value);}}};
 async function upload(page,content){const form=new FormData();form.set('page',String(page));form.set('total','2');if(typeof content==='string')form.set('text',content);else form.set('image',new File([content],'scan.jpg',{type:'image/jpeg'}));return worker.fetch(new Request('https://test/api/jobs/mixed/pdf-page',{method:'POST',headers:{Authorization:'Bearer admin-token-0123456789abcdef-0123'},body:form}),env,{});}
 assert.equal((await upload(1,'第一章，這是一頁可直接擷取的中文文字。')).status,200);
 const second=await upload(2,new Uint8Array([255,216,255,1,2,3]));assert.equal(second.status,200,await second.text());
 const manifest=JSON.parse(objects.get('split/mixed/manifest.json'));assert.equal(manifest.complete,true);assert.deepEqual(manifest.parts.map(part=>part.kind),['text','scan']);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'第二頁掃描文字。',warnings:[]})}]}}]});});
 await processJob(job.id,env);assert.equal(calls,0);let checkpoint=JSON.parse(objects.get('processing/mixed.json'));assert.equal(checkpoint.page,1);assert.match(checkpoint.source,/第一章/);
 await processJob(job.id,env);assert.equal(calls,1);checkpoint=JSON.parse(objects.get('processing/mixed.json'));assert.equal(checkpoint.page,2);assert.match(checkpoint.source,/第二頁/);
});
