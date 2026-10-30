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

// What the browser sends with each page (frontend/pdf-client.js analyzePdf): a text layer it cleaned from each line's
// place (cleaned), a page's note, and, with a page image Gemini reads, the page's own text layer (hint).
test('A mixed PDF keeps the text layer the browser cleaned, weighs Gemini\'s reading against the layer sent along, and keeps each page\'s note',async t=>{
 const objects=new Map(),job={id:'hinted',story_id:'story',mime:'application/pdf',source:'',file_key:'original',warnings:'[]'};
 const env={ADMIN_TOKEN:'admin-token-0123456789abcdef-0123',GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM jobs')?job:{context:'',glossary:'{}',genre:'Khác'};},async run(){return {};}};}},FILES:{async get(key){const value=objects.get(key);return value===undefined?null:{size:new Blob([value]).size,json:async()=>JSON.parse(value),text:async()=>new Blob([value]).text(),arrayBuffer:async()=>new Blob([value]).arrayBuffer()};},async put(key,value){objects.set(key,value);}}};
 const layer='第三页的正文写在这里，内容完整无缺，共有十几个汉字。\n第二行正文也在这里，同样完整无缺。',key=page=>`split/hinted/page-${page}`;
 const part=(page,extra)=>({index:page-1,startPage:page,endPage:page,key:key(page),mime:'text/plain; charset=utf-8',kind:'text',cleaned:true,...extra});
 for(const [page,text] of [[1,'练习\n1. 求下列函数的值。'],[2,'练习\n2. 求函数的定义域'],[4,'练习\n4. 画出函数的图像。']])objects.set(key(page),text);
 objects.set(key(3),new Uint8Array([255,216,255,1,2,3]));objects.set(key(3)+'.hint',JSON.stringify({text:layer,reason:'hidden'}));
 objects.set('split/hinted/manifest.json',JSON.stringify({version:3,kind:'mixed-pages',totalPages:4,pagesPerPart:1,complete:true,parts:[part(1),part(2,{note:'Trang 2: khoảng 5 chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên chưa dịch; hãy đối chiếu với PDF gốc.'}),{index:2,startPage:3,endPage:3,key:key(3),mime:'image/jpeg',kind:'scan',hint:key(3)+'.hint'},part(4)]}));
 // Gemini reads the third page far more poorly than its PDF's own OCR layer.
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'第三页。',warnings:[]})}]}}]});});
 for(let step=0;step<4;step++)await processJob(job.id,env);
 const checkpoint=JSON.parse(objects.get('processing/hinted.json'));assert.equal(calls,1);assert.equal(checkpoint.ocrDone,true);
 assert.equal(checkpoint.source,`练习\n1. 求下列函数的值。\n\n练习\n2. 求函数的定义域\n\n${layer}\n\n练习\n4. 画出函数的图像。`,'the heading that opens three pages stays on each; the layer stays for the poor reading');
 assert.deepEqual(checkpoint.warnings,['Trang 2: khoảng 5 chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên chưa dịch; hãy đối chiếu với PDF gốc.','Trang 3: chưa nhận dạng được ảnh trang nên giữ lớp chữ có sẵn của PDF; hãy đối chiếu với PDF gốc.']);
});

// The same fields through the upload route Xưởng dịch posts each page to (frontend/app.js uploadJob, backend/pdf-page-upload.js):
// a page the browser cleaned (cleaned=1), a page's note, and a page image sent with its PDF's own text layer (hint), which
// processJob weighs Gemini's reading against.
test('Pages posted with cleaned, note and hint are stored as processJob reads them: the lines, the note and the layer stay',async t=>{
 const objects=new Map(),job={id:'route',story_id:'story',mime:'application/pdf',source:'',file_key:'original',warnings:'[]'};
 const env={ADMIN_TOKEN:'admin-token-0123456789abcdef-0123',GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM jobs')?job:{context:'',glossary:'{}',genre:'Khác'};},async run(){return {};}};}},FILES:{async get(key){const value=objects.get(key);return value===undefined?null:{size:new Blob([value]).size,json:async()=>JSON.parse(value),text:async()=>new Blob([value]).text(),arrayBuffer:async()=>new Blob([value]).arrayBuffer()};},async put(key,value){objects.set(key,value);}}};
 const post=async fields=>{const form=new FormData();for(const [name,value] of Object.entries(fields))form.set(name,value);const response=await worker.fetch(new Request('https://test/api/jobs/route/pdf-page',{method:'POST',headers:{Authorization:'Bearer admin-token-0123456789abcdef-0123'},body:form}),env,{});assert.equal(response.status,200,await response.clone().text());};
 const layer='图层里的正文写在这里，内容完整无缺，共有十几个汉字。';
 await post({page:'1',total:'3',text:'练习\n1. 求下列函数的值。',cleaned:'1'});
 await post({page:'2',total:'3',text:'练习\n2. 求函数的定义域',cleaned:'1',note:'Trang 2: một ghi chú.'});
 await post({page:'3',total:'3',image:new File([new Uint8Array([255,216,255,1,2,3])],'p3.jpg',{type:'image/jpeg'}),hint:JSON.stringify({text:layer,reason:'pictured'})});
 const manifest=JSON.parse(objects.get('split/route/manifest.json'));
 assert.deepEqual(manifest.parts.map(({kind,cleaned,note,hint})=>({kind,cleaned,note,hint})),[{kind:'text',cleaned:true,note:undefined,hint:undefined},{kind:'text',cleaned:true,note:'Trang 2: một ghi chú.',hint:undefined},{kind:'scan',cleaned:undefined,note:undefined,hint:'split/route/page-00003.jpg.hint.json'}]);
 assert.deepEqual(JSON.parse(objects.get('split/route/page-00003.jpg.hint.json')),{text:layer,reason:'pictured'});
 // Gemini reads the third page with a title the layer lacks: the reading wins where it holds the layer and more.
 t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:`第四章 水的循环\n${layer}`,warnings:[]})}]}}]}));
 for(let step=0;step<3;step++)await processJob(job.id,env);
 const checkpoint=JSON.parse(objects.get('processing/route.json'));
 assert.equal(checkpoint.source,`练习\n1. 求下列函数的值。\n\n练习\n2. 求函数的定义域\n\n第四章 水的循环\n${layer}`,'the heading that opens two cleaned pages stays on both');
 assert.deepEqual(checkpoint.warnings,['Trang 2: một ghi chú.']);
});
