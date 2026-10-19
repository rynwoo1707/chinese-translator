import test from 'node:test';
import assert from 'node:assert/strict';
import {translatePdfBlocks} from './pdf-block-translation.js';
import {studyRoute} from './study-translation.js';
import {errorResponse} from './http.js';

const env={GEMINI_API_KEY:'student-key-long-enough',GEMINI_MODEL:'gemini-2.5-flash',GEMINI_THINKING:'minimal'};
const blocks=[{id:'p4-b0',source:'定义向量。'},{id:'p4-b1',source:'两个向量相同。'}];
const result=(translated=blocks.map(b=>({id:b.id,translation:b.id==='p4-b0'?'Định nghĩa vectơ.':'Hai vectơ giống nhau.'})))=>({blocks:translated,contextUpdate:'',glossaryUpdates:{}});
const gemini=value=>Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});

test('Gemini block translation sends stable IDs, filtered terms and an explicit JSON schema',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return gemini(result());});
 const response=await translatePdfBlocks(env,{blocks,domain:'math',context:'x'.repeat(1000),glossary:{向量:'vectơ tùy chọn',unused:'do not send'}});
 assert.equal(calls.length,1);assert.match(calls[0].url,/gemini-2\.5-flash/);assert.equal(calls[0].options.headers['x-goog-api-key'],env.GEMINI_API_KEY);
 const payload=JSON.parse(calls[0].body.contents[0].parts[0].text);assert.deepEqual(payload.blocks,blocks);assert.equal(payload.context.length,900);assert.equal(payload.glossary.向量,'vectơ tùy chọn');assert.equal(payload.glossary.unused,undefined);
 const config=calls[0].body.generationConfig;assert.equal(config.responseMimeType,'application/json');assert.equal(config.thinkingConfig.thinkingBudget,0);
 assert.deepEqual(config.responseJsonSchema.required,['blocks','contextUpdate','glossaryUpdates']);assert.deepEqual(config.responseJsonSchema.properties.blocks.items.required,['id','translation']);
 assert.deepEqual(response.blocks,result().blocks);assert.equal(response.usage.total,30);assert.doesNotMatch(JSON.stringify(response),/student-key/);
});

test('Gemini block IDs may arrive in a different order while output follows the original order',async t=>{
 t.mock.method(globalThis,'fetch',async()=>gemini(result(result().blocks.toReversed())));
 assert.deepEqual((await translatePdfBlocks(env,{blocks})).blocks,result().blocks);
});

test('Gemini unknown, missing and duplicate block IDs fail before assembling a translated document',async t=>{
 let value;t.mock.method(globalThis,'fetch',async()=>gemini(value));
 for(const output of [result().blocks.slice(0,1),[result().blocks[0],{id:'p99-b0',translation:'Unknown block'}],[result().blocks[0],result().blocks[0]]]){
  value=result(output);await assert.rejects(()=>translatePdfBlocks(env,{blocks}),/block|ID/);
 }
 value=result([{id:'p4-b0',translation:''},result().blocks[1]]);await assert.rejects(()=>translatePdfBlocks(env,{blocks}),/không có bản dịch/);
});

test('Gemini input rejects duplicate IDs, malformed IDs and excessive block limits without making requests',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Gemini must not be called');});
 for(const invalid of [[],Array.from({length:49},(_,i)=>({id:`p1-b${i}`,source:'原文'})),[blocks[0],blocks[0]],[{id:'arbitrary-id',source:'原文'}],[{id:'p1-b0',source:' '}],[{id:'p1-b0',source:'文'.repeat(8001)}],[{id:'p1-b0',source:'文'.repeat(4500)},{id:'p1-b1',source:'文'.repeat(4500)}]]){
  await assert.rejects(()=>translatePdfBlocks(env,{blocks:invalid}),/block|Block|ID|8\.000/);
 }
 assert.equal(calls,0);
});

test('Block translation preserves inline images and restores protected LaTeX formulas',async t=>{
 const source='公式 @@PDF_INLINE_0@@ 与 \\(a=b\\)。';let payload;
 t.mock.method(globalThis,'fetch',async(url,options)=>{payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);return gemini(result([{id:'p1-b0',translation:'Công thức @@PDF_INLINE_0@@ và @@MATH_0001@@.'}]));});
 const response=await translatePdfBlocks(env,{blocks:[{id:'p1-b0',source}],domain:'math'});
 assert.equal(payload.blocks[0].source,'公式 @@PDF_INLINE_0@@ 与 @@MATH_0001@@。');assert.equal(response.blocks[0].translation,'Công thức @@PDF_INLINE_0@@ và \\(a=b\\).');
});

test('Inline formula tokens cannot be dropped, duplicated or invented',async t=>{
 let translation;t.mock.method(globalThis,'fetch',async()=>gemini(result([{id:'p1-b0',translation}])));
 for(const value of ['Công thức bị mất.','Công thức @@PDF_INLINE_0@@ @@PDF_INLINE_0@@.','Công thức @@PDF_INLINE_0@@ và @@PDF_INLINE_1@@.']){
  translation=value;await assert.rejects(()=>translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:'公式 @@PDF_INLINE_0@@。'}]}),/ký hiệu toán|mã toán/);
 }
});

test('Protected LaTeX tokens cannot be dropped, duplicated or invented',async t=>{
 let translation;t.mock.method(globalThis,'fetch',async()=>gemini(result([{id:'p1-b0',translation}])));
 for(const value of ['Công thức bị mất.','@@MATH_0001@@ @@MATH_0001@@','@@MATH_0001@@ và @@MATH_0002@@']){
  translation=value;await assert.rejects(()=>translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:'公式 \\(a=b\\)。'}]}),/công thức/);
 }
});

test('Block translation shields bare and delimited LaTeX from OCR and restores both verbatim beside formula images',async t=>{
 // p7-b10 OCR saved before bare commands were delimited, a merged expression with a real minus, and bare \sqrt/\overline.
 const source=[String.raw`(2) @@PDF_INLINE_2@@ \frac{1}{2} (@@PDF_INLINE_3@@`,String.raw`(3) \(\overrightarrow{AF}−\frac{1}{2}\) @@PDF_INLINE_4@@`,String.raw`5. 已知 x=\sqrt{2}，求 \overline{AB}.`].join('\n');
 let payload;t.mock.method(globalThis,'fetch',async(url,options)=>{payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);return gemini(result([{id:'p7-b10',translation:'(2) @@PDF_INLINE_2@@ @@MATH_0002@@ (@@PDF_INLINE_3@@\n(3) @@MATH_0001@@ @@PDF_INLINE_4@@\n5. Cho x=@@MATH_0003@@, tìm @@MATH_0004@@.'}]));});
 const response=await translatePdfBlocks(env,{blocks:[{id:'p7-b10',source}],domain:'math'});
 assert.equal(payload.blocks[0].source,'(2) @@PDF_INLINE_2@@ @@MATH_0002@@ (@@PDF_INLINE_3@@\n(3) @@MATH_0001@@ @@PDF_INLINE_4@@\n5. 已知 x=@@MATH_0003@@，求 @@MATH_0004@@.');
 assert.doesNotMatch(payload.blocks[0].source,/\\/u);
 assert.equal(response.blocks[0].translation,[String.raw`(2) @@PDF_INLINE_2@@ \frac{1}{2} (@@PDF_INLINE_3@@`,String.raw`(3) \(\overrightarrow{AF}−\frac{1}{2}\) @@PDF_INLINE_4@@`,String.raw`5. Cho x=\sqrt{2}, tìm \overline{AB}.`].join('\n'));
});

test('A bare command around delimited math keeps the inner token restorable',async t=>{
 let payload;t.mock.method(globalThis,'fetch',async(url,options)=>{payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);return gemini(result([{id:'p1-b0',translation:String.raw`Cho \frac{@@MATH_0001@@}{2}.`}]));});
 const response=await translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:String.raw`已知 \frac{\(a\)}{2}。`}]});
 assert.equal(payload.blocks[0].source,String.raw`已知 \frac{@@MATH_0001@@}{2}。`);assert.equal(response.blocks[0].translation,String.raw`Cho \frac{\(a\)}{2}.`);
});

test('A dropped bare LaTeX formula is retried once and then rejected, never assembled',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return gemini(result([{id:'p1-b0',translation:'Cho x bằng căn hai.'}]));});
 await assert.rejects(()=>translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:String.raw`已知 x=\sqrt{2}。`}]}),/công thức/);assert.equal(calls,2);
});

test('Block translation asks for single punctuation and the source line structure but never deletes punctuation itself',async t=>{
 // Saved p7-b2 case: the crop already ends in "k." and the model added "."; only crop evidence (renderer/extraction) may remove it.
 const source='在四条射线上分别取点 E，F，G，H，使 @@PDF_INLINE_1@@ 求证：E，F，G，H 四点共面.',translation='trên bốn tia lần lượt lấy các điểm E, F, G, H sao cho @@PDF_INLINE_1@@. Chứng minh rằng bốn điểm E, F, G, H đồng phẳng.';
 let instruction;t.mock.method(globalThis,'fetch',async(url,options)=>{instruction=JSON.parse(options.body).systemInstruction.parts[0].text;return gemini(result([{id:'p7-b2',translation}]));});
 const response=await translatePdfBlocks(env,{blocks:[{id:'p7-b2',source}],domain:'math'});
 assert.equal(response.blocks[0].translation,translation);
 assert.match(instruction,/keep marks next to tokens as in the source, never doubled; add one right after a token only if Vietnamese word order moves sentence punctuation there/u);
 assert.match(instruction,/source line that starts a paragraph, list item, verse line or displayed formula as one output line, in order and unsplit/u);
 assert.ok(instruction.length<=1500,`${instruction.length} characters are sent with every translation call`);
});

test('Block translation refuses missing years or citations',async t=>{
 t.mock.method(globalThis,'fetch',async()=>gemini(result([{id:'p1-b0',translation:'Nghiên cứu được ghi chép.'}])));
 await assert.rejects(()=>translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:'2024年研究记载[12]。'}]}),/thiếu số hoặc dẫn chứng/);
});

test('A refused answer still reports every billed call: a number dropped twice, a wrong ID, a retry that fails',async t=>{
 const usage=calls=>({prompt:20*calls,output:10*calls,thinking:0,total:30*calls,requests:calls,cacheHits:0}),source=[{id:'p3-b1',source:'今年是2026年。'}];
 let calls=0,answers=[];t.mock.method(globalThis,'fetch',async()=>{const answer=answers[Math.min(calls,answers.length-1)];calls++;return typeof answer==='function'?answer():gemini(answer);});
 const refused=async(body={blocks:source})=>{try{await translatePdfBlocks(env,body);}catch(error){return error;}assert.fail('expected a refusal');};
 // The year is dropped by the first answer and by the retry of that block: both answers were billed.
 answers=[result([{id:'p3-b1',translation:'Năm nay là năm tốt.'}])];let error=await refused();
 assert.equal(calls,2);assert.match(error.message,/thiếu số hoặc dẫn chứng: 2026/u);assert.deepEqual(error.usage,usage(2));
 assert.deepEqual((await errorResponse(error).json()).usage,usage(2),'the browser receives what was spent');
 // A wrong or repeated ID fails the first answer at once.
 for(const blocks of [[{id:'p3-b9',translation:'Năm 2026.'}],[{id:'p3-b1',translation:'Năm 2026.'},{id:'p3-b1',translation:'Năm 2026.'}]]){calls=0;answers=[result(blocks)];error=await refused();assert.equal(calls,1);assert.deepEqual(error.usage,usage(1));}
 // The retry comes back with a wrong ID, or is blocked: the block's own problem is reported with both calls.
 calls=0;answers=[result([{id:'p3-b1',translation:'Năm nay.'}]),result([{id:'p3-b7',translation:'x'}])];error=await refused();
 assert.equal(calls,2);assert.match(error.message,/2026/u);assert.deepEqual(error.usage,usage(2));
 calls=0;answers=[result([{id:'p3-b1',translation:'Năm nay.'}]),()=>Response.json({candidates:[{finishReason:'SAFETY',content:{parts:[]}}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30}})];
 error=await refused();assert.equal(calls,2);assert.equal(error.finishReason,'SAFETY');assert.deepEqual(error.usage,usage(2));
 // An accepted retry reports both calls with the translation, as before.
 calls=0;answers=[result([{id:'p3-b1',translation:'Năm nay.'}]),result([{id:'p3-b1',translation:'Năm 2026.'}])];
 assert.deepEqual((await translatePdfBlocks(env,{blocks:source})).usage,usage(2));
});

test('Block translation composes Vietnamese Unicode and repairs detached tones',async t=>{
 t.mock.method(globalThis,'fetch',async()=>gemini({...result([{id:'p1-b0',translation:'Cùng giố`ng nhau, độ dài bằ`ng 1 và điểm đâ`u A. Hình học.'.normalize('NFD')}]),contextUpdate:'giố`ng nhau'}));
 const response=await translatePdfBlocks(env,{blocks:[{id:'p1-b0',source:'两个向量相同，长度为1，起点为A。'}]});
 assert.equal(response.blocks[0].translation,'Cùng giống nhau, độ dài bằng 1 và điểm đầu A. Hình học.');assert.equal(response.context,'giống nhau');
 assert.equal(response.blocks[0].translation,response.blocks[0].translation.normalize('NFC'));
});

test('Student block endpoint inherits the main Gemini model when the PDF override is absent or empty',async t=>{
 const path='/api/my/study/translate-blocks',url=new URL('https://example.test'+path),requests=[];let storageCalls=0;
 const scoped={GEMINI_API_KEY:'server-key-must-never-be-used',GEMINI_MODEL:'gemini-3.6-flash',DB:{prepare(){return {bind(){return this;},async first(){return {id:'student-1'};}};}},FILES:{async get(){storageCalls++;throw new Error('Block text must not be cached');},async put(){storageCalls++;throw new Error('Block text must not be cached');}}};
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{requests.push({endpoint,options,body:JSON.parse(options.body)});return gemini(result());});
 for(const override of [{},{GEMINI_PDF_BLOCK_MODEL:''}]){
  const request=new Request(url,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({blocks,apiKey:'student-key-long-enough',mode:'economy'})});
  const response=await studyRoute(request,{...scoped,...override},url,path),data=await response.json(),call=requests.at(-1);
  assert.equal(response.status,200);assert.equal(data.model,'gemini-3.6-flash');assert.match(call.endpoint,/\/models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(call.options.headers['x-goog-api-key'],'student-key-long-enough');assert.doesNotMatch(JSON.stringify(data),/student-key|server-key/);
  const config=call.body.generationConfig;assert.equal(config.responseMimeType,'application/json');assert.deepEqual(config.thinkingConfig,{thinkingLevel:'minimal'});
  assert.deepEqual(config.responseJsonSchema.required,['blocks','contextUpdate','glossaryUpdates']);assert.deepEqual(config.responseJsonSchema.properties.blocks.items.required,['id','translation']);
 }
 assert.equal(requests.length,2);assert.equal(storageCalls,0);
});

test('Student block endpoint respects an explicit PDF model and uses only the tab key without persistent cache',async t=>{
 const path='/api/my/study/translate-blocks',url=new URL('https://example.test'+path),requests=[];let storageCalls=0;
 const scoped={GEMINI_API_KEY:'server-key-must-never-be-used',GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PDF_BLOCK_MODEL:'gemini-2.5-flash',DB:{prepare(){return {bind(){return this;},async first(){return {id:'student-1'};}};}},FILES:{async get(){storageCalls++;throw new Error('Block text must not be cached');},async put(){storageCalls++;throw new Error('Block text must not be cached');}}};
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{requests.push({endpoint,options});return gemini(result());});
 const request=body=>new Request(url,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await studyRoute(request({blocks,apiKey:'student-key-long-enough',mode:'economy'}),scoped,url,path),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.model,'gemini-2.5-flash');assert.equal(requests.length,1);assert.equal(requests[0].options.headers['x-goog-api-key'],'student-key-long-enough');assert.equal(storageCalls,0);
 assert.doesNotMatch(JSON.stringify(data),/student-key|server-key/);
 await assert.rejects(()=>studyRoute(request({blocks}),scoped,url,path),/Khóa Gemini API không hợp lệ/);assert.equal(requests.length,1);
});
