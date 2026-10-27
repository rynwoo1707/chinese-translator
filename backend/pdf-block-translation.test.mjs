import test from 'node:test';
import assert from 'node:assert/strict';
import {translatePdfBlocks,MAX_CALLS,blockTranslationWarnings} from './pdf-block-translation.js';
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

// partial: true. Each fake answer is decided from the blocks the request carries, as Gemini sees them.
function blockGemini(t,decide){
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{const ids=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).blocks.map(b=>b.id);requests.push(ids);return decide(ids,requests.length);});
 return requests;
}
const translations=ids=>gemini(result(ids.map(id=>({id,translation:`Bản dịch ${id}.`}))));
const refusal=reason=>Response.json({candidates:[{finishReason:reason,content:{parts:[]}}],usageMetadata:{promptTokenCount:20,totalTokenCount:20}});
const spent=(answered,refused=0)=>({prompt:20*(answered+refused),output:10*answered,thinking:0,total:30*answered+20*refused,requests:answered+refused,cacheHits:0});
const line=n=>Array.from({length:n},(_,i)=>({id:`p1-b${i}`,source:`第${i}段。`}));

test('Partial answers keep the good blocks when one keeps dropping a year, and report that block with its draft',async t=>{
 const source=[{id:'p1-b1',source:'第一段。'},{id:'p1-b2',source:'1949年成立。'},{id:'p1-b3',source:'第三段。'}];
 const requests=blockGemini(t,ids=>gemini(result(ids.map(id=>({id,translation:id==='p1-b2'?'Được thành lập.':`Đoạn ${id}.`})))));
 const response=await translatePdfBlocks(env,{blocks:source,partial:true});
 assert.deepEqual(requests,[['p1-b1','p1-b2','p1-b3'],['p1-b2']],'only the failing block is asked for again');
 assert.deepEqual(response.blocks,[{id:'p1-b1',translation:'Đoạn p1-b1.'},{id:'p1-b3',translation:'Đoạn p1-b3.'}]);
 assert.deepEqual(response.failedBlocks,[{id:'p1-b2',code:'block_check',message:'Block p1-b2 thiếu số hoặc dẫn chứng: 1949.',draft:'Được thành lập.'}]);
 assert.deepEqual(response.usage,spent(2));
 // Without partial the contract is unchanged: the batch fails after the same two calls.
 await assert.rejects(()=>translatePdfBlocks(env,{blocks:source}),/thiếu số hoặc dẫn chứng: 1949/u);
});

test('A refusal of the batch is narrowed down to its block by halves; every other block is kept and every call counted',async t=>{
 const requests=blockGemini(t,ids=>ids.includes('p1-b3')?refusal('RECITATION'):translations(ids));
 const response=await translatePdfBlocks(env,{blocks:line(4),partial:true});
 assert.deepEqual(requests,[['p1-b0','p1-b1','p1-b2','p1-b3'],['p1-b0','p1-b1'],['p1-b2','p1-b3'],['p1-b2'],['p1-b3']]);
 assert.deepEqual(response.blocks.map(b=>b.id),['p1-b0','p1-b1','p1-b2']);
 assert.deepEqual(response.failedBlocks.map(({id,code})=>({id,code})),[{id:'p1-b3',code:'gemini_refused'}]);assert.match(response.failedBlocks[0].message,/trùng khớp nguyên văn/u);
 assert.deepEqual(response.usage,spent(2,3));
 // A batch of one refused block answers 200 with nothing translated, not an error.
 blockGemini(t,()=>refusal('SAFETY'));
 const alone=await translatePdfBlocks(env,{blocks:line(1),partial:true});assert.deepEqual(alone.blocks,[]);assert.equal(alone.failedBlocks[0].code,'gemini_refused');
});

test('A quota error part-way keeps what was translated; one before anything was translated is thrown as before',async t=>{
 const quota=()=>Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'}]},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'40s'}]}},{status:429});
 blockGemini(t,(ids,n)=>n===1?refusal('RECITATION'):n===2?translations(ids):quota());
 const response=await translatePdfBlocks(env,{blocks:line(4),partial:true});
 assert.deepEqual(response.blocks.map(b=>b.id),['p1-b0','p1-b1']);
 assert.deepEqual(response.failedBlocks.map(({id,code,retryAfter})=>({id,code,retryAfter})),[{id:'p1-b2',code:'quota_minute',retryAfter:40},{id:'p1-b3',code:'quota_minute',retryAfter:40}]);
 blockGemini(t,()=>quota());
 await assert.rejects(()=>translatePdfBlocks(env,{blocks:line(2),partial:true}),error=>error.code==='quota_minute'&&error.retryAfter===40);
});

test('Splitting stops after MAX_CALLS calls, and IDs Gemini repeats, drops or invents fail only their own blocks',async t=>{
 // One refused block among 48 is found within the budget.
 let requests=blockGemini(t,ids=>ids.includes('p1-b47')?refusal('RECITATION'):translations(ids));
 let response=await translatePdfBlocks(env,{blocks:line(48),partial:true});
 assert.equal(requests.length,11);assert.deepEqual(response.failedBlocks.map(b=>b.id),['p1-b47']);assert.equal(response.blocks.length,47);
 // Two of them need more calls than MAX_CALLS: the groups left over are reported, every other block is kept.
 requests=blockGemini(t,ids=>ids.includes('p1-b0')||ids.includes('p1-b47')?refusal('RECITATION'):translations(ids));
 response=await translatePdfBlocks(env,{blocks:line(48),partial:true});
 assert.equal(requests.length,MAX_CALLS);const left=response.failedBlocks.map(b=>b.id);
 assert.ok(left.includes('p1-b0')&&left.includes('p1-b47'));assert.ok(left.length<=12,`${left.length} blocks left`);assert.equal(response.blocks.length+left.length,48);
 assert.ok(response.failedBlocks.every(b=>b.code==='gemini_refused'));
 // p1-b0 twice, p1-b1 missing, p9-b9 unknown; the retry fixes both.
 const fixed=blockGemini(t,(ids,n)=>n===1?gemini(result([{id:'p1-b0',translation:'Một.'},{id:'p1-b0',translation:'Hai.'},{id:'p9-b9',translation:'Lạ.'},{id:'p1-b2',translation:'Ba.'}])):translations(ids));
 const salvaged=await translatePdfBlocks(env,{blocks:line(3),partial:true});
 assert.deepEqual(fixed,[['p1-b0','p1-b1','p1-b2'],['p1-b0','p1-b1']]);
 assert.deepEqual(salvaged.blocks,[{id:'p1-b0',translation:'Bản dịch p1-b0.'},{id:'p1-b1',translation:'Bản dịch p1-b1.'},{id:'p1-b2',translation:'Ba.'}]);assert.deepEqual(salvaged.failedBlocks,[]);
});

test('The study route passes partial through and answers 200 with failedBlocks',async t=>{
 const path='/api/my/study/translate-blocks',url=new URL('https://example.test'+path);
 const scoped={GEMINI_MODEL:'gemini-3.6-flash',DB:{prepare(){return {bind(){return this;},async first(){return {id:'student-1'};}};}}};
 blockGemini(t,ids=>ids.includes('p1-b1')?refusal('SAFETY'):translations(ids));
 const response=await studyRoute(new Request(url,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({blocks:line(2),apiKey:'student-key-long-enough',mode:'economy',partial:true})}),scoped,url,path);
 const data=await response.json();assert.equal(response.status,200);
 assert.deepEqual(data.blocks.map(b=>b.id),['p1-b0']);assert.deepEqual(data.failedBlocks.map(b=>[b.id,b.code]),[['p1-b1','gemini_refused']]);assert.equal(data.usage.requests,3);
});

// Each fake answer is answer(block as sent, call number): a translation may carry the shielded @@MATH token it was sent.
function answered(t,answer){
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{const sent=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).blocks;requests.push(sent.map(b=>b.id));const call=requests.length;return gemini(result(sent.map(b=>({id:b.id,translation:answer(b,call)}))));});
 return requests;
}

test('Checks that cost no tokens warn in every mode: a number missing, a length far off, TeX the page cannot draw, one translation for two sources',async t=>{
 const blocks=[
  {id:'p2-b1',source:'第3章共有12节，约2.5万字，合3000页。'},
  {id:'p2-b2',source:'物体的加速度与合力成正比，与质量成反比，这就是牛顿第二定律的内容。'},
  {id:'p2-b3',source:String.raw`方程组的解为 \begin{tabular}{c}x=1\end{tabular}`},
  {id:'p2-b4',source:'两个向量的方向相同且长度相等，则这两个向量相等。'},
  {id:'p2-b5',source:'两个向量的方向相反且长度相等，则它们互为相反向量。'},
  {id:'p2-b6',source:'两个向量的方向相同且长度相等，则这两个向量相等。'},
  {id:'p2-b7',source:'圆周率约为3.14，第①题中x²+y²=1，共1 000个点。'},
  {id:'p2-b8',source:'习题'},{id:'p2-b9',source:'练习'}
 ];
 const same='Hai vectơ cùng hướng và cùng độ dài thì bằng nhau.',answers={
  // 12 is dropped; 2.5万 may become 25.000 and 3000 may be written 3.000
  'p2-b1':'Chương 3 có các mục, khoảng 25.000 chữ, tương đương 3.000 trang.','p2-b2':'Gia tốc tỉ lệ.',
  'p2-b4':same,'p2-b5':same,'p2-b6':same,'p2-b8':'Bài tập','p2-b9':'Bài tập',
  // decimal comma, circled and superscript digits written plainly, thousands grouped differently: the same numbers
  'p2-b7':'Số pi xấp xỉ 3,14; trong bài (1), x^2 + y^2 = 1, có tất cả 1000 điểm.'
 };
 const requests=answered(t,b=>answers[b.id]??`Nghiệm của hệ là ${b.source.match(/@@MATH_\d{4}@@/u)[0]}`);
 const response=await translatePdfBlocks(env,{blocks});
 assert.equal(requests.length,1,'warnings only: nothing is asked again');
 assert.deepEqual(response.warnings.map(w=>w.split(':')[0]),['Block p2-b1','Block p2-b2','Block p2-b3','Block p2-b5']);
 assert.equal(response.warnings[0],'Block p2-b1: bản dịch thiếu hoặc đổi số của nguyên tác: 12');
 assert.equal(response.warnings[1],'Block p2-b2: bản dịch ngắn bất thường so với nguyên tác, có thể đã sót ý.');
 assert.match(response.warnings[2],/^Block p2-b3: còn mã công thức chưa dựng được: \\begin\{tabular\}/u);
 assert.equal(response.warnings[3],'Block p2-b5: bản dịch giống hệt Block p2-b4 dù nguyên tác khác nhau; có thể đã lẫn đoạn.');
 assert.equal(response.blocks[2].translation,String.raw`Nghiệm của hệ là \begin{tabular}{c}x=1\end{tabular}`);
 // A translation far longer than its source needs (commentary, a repetition) is named too.
 answered(t,()=>'Nội dung này nói về vectơ. '.repeat(12));
 assert.deepEqual((await translatePdfBlocks(env,{blocks:[{id:'p2-b1',source:'两个向量相等。'}]})).warnings,['Block p2-b1: bản dịch dài bất thường so với nguyên tác, có thể có phần thêm hoặc lặp lại.']);
});

test('One translation for two sources is named only when its words outside formulas reach 20 letters: tokens are numbered per block',async t=>{
 const [t1,t2]=['@@PDF_INLINE_1@@','@@PDF_INLINE_2@@'],sum=String.raw`\(S_{n-1}=a_{1}+a_{2}+\cdots+a_{n-1}\quad(n\geq 2)\)`;
 // Steps of a scanned solution: 所以/因此 both read "Do đó", while each block's tokens hold its own formula images; then
 // 24 letters of words given to two sources that say opposite things (相同/相反).
 const blocks=[{id:'p3-b4',source:`所以 ${t1}，${t2}`},{id:'p3-b9',source:`因此 ${t1}，${t2}`},{id:'p3-b5',source:`所以 ${sum}`},{id:'p3-b6',source:`因此 ${sum}`},{id:'p3-b10',source:`由 ${t1} 可知两个向量的方向相同，${t2}`},{id:'p3-b11',source:`由 ${t1} 可知两个向量的方向相反，${t2}`}];
 const sentence=`Từ ${t1} suy ra hai vectơ cùng hướng, ${t2}`,answers={'p3-b4':`Do đó ${t1}, ${t2}`,'p3-b9':`Do đó ${t1}, ${t2}`,'p3-b10':sentence,'p3-b11':sentence};
 for(const [body,options] of [[{blocks},{}],[{blocks,partial:true},{strict:true}]]){
  const requests=answered(t,b=>answers[b.id]??`Do đó ${b.source.match(/@@MATH_\d{4}@@/u)[0]}`),response=await translatePdfBlocks(env,body,options);
  assert.equal(requests.length,1,'warnings only: nothing is asked again');
  assert.deepEqual(response.warnings,['Block p3-b11: bản dịch giống hệt Block p3-b10 dù nguyên tác khác nhau; có thể đã lẫn đoạn.']);
 }
});

test('Strict mode asks once more for a block that keeps Chinese, lacks a number or is far too short, and keeps the better translation with its warnings',async t=>{
 const blocks=[{id:'p3-b1',source:'向量的模是向量的长度。'},{id:'p3-b2',source:'第3节有12道习题。'},{id:'p3-b3',source:'“的”字在这里表示所属关系。'},{id:'p3-b4',source:'物体的加速度与合力成正比，与质量成反比，这就是牛顿第二定律的内容。'},{id:'p3-b5',source:'两个向量相等。'}];
 // By call: Chinese left, then fixed; 12 dropped twice (the first stays); a character the source quotes, which may stay;
 // far too short, then whole.
 const answers={'p3-b1':['Môđun của 向量 là độ dài.','Môđun của vectơ là độ dài của vectơ.'],'p3-b2':['Mục 3 có các bài tập.','Mục có các bài tập.'],'p3-b3':['Chữ “的” ở đây chỉ quan hệ sở hữu.'],
  'p3-b4':['Gia tốc tỉ lệ.','Gia tốc của vật tỉ lệ thuận với hợp lực và tỉ lệ nghịch với khối lượng; đó là nội dung định luật II Newton.'],'p3-b5':['Hai vectơ bằng nhau.']};
 const answer=(b,call)=>answers[b.id][Math.min(call,answers[b.id].length)-1],ids=blocks.map(b=>b.id),again=['p3-b1','p3-b2','p3-b4'];
 const chosen=[answers['p3-b1'][1],answers['p3-b2'][0],answers['p3-b3'][0],answers['p3-b4'][1],answers['p3-b5'][0]];
 let requests=answered(t,answer);const strict=await translatePdfBlocks(env,{blocks},{strict:true});
 assert.deepEqual(requests,[ids,again]);assert.deepEqual(strict.blocks.map(b=>b.translation),chosen);assert.equal(strict.usage.requests,2);
 assert.deepEqual(strict.warnings,['Block p3-b3: còn chữ Hán chưa dịch: 的','Block p3-b2: bản dịch thiếu hoặc đổi số của nguyên tác: 12']);
 // The same with partial answers: nothing fails, the same translations are chosen.
 requests=answered(t,answer);const partial=await translatePdfBlocks(env,{blocks,partial:true},{strict:true});
 assert.deepEqual(requests,[ids,again]);assert.deepEqual(partial.blocks.map(b=>b.translation),chosen);assert.deepEqual(partial.failedBlocks,[]);assert.deepEqual(partial.warnings,strict.warnings);
 // Without strict these are warnings only, after one call.
 requests=answered(t,answer);const loose=await translatePdfBlocks(env,{blocks});
 assert.deepEqual(requests,[ids]);assert.deepEqual(loose.warnings.map(w=>w.split(':')[0]),['Block p3-b1','Block p3-b3','Block p3-b2','Block p3-b4']);
 // A retry refused or unreadable leaves the first translations, never a failed block, and its tokens are counted.
 for(const partialAnswers of [false,true]){
  requests=blockGemini(t,(sent,n)=>n===1?gemini(result(sent.map(id=>({id,translation:answers[id][0]})))):refusal('SAFETY'));
  const kept=await translatePdfBlocks(env,{blocks,partial:partialAnswers},{strict:true});
  assert.deepEqual(kept.blocks.map(b=>b.translation),blocks.map(b=>answers[b.id][0]),String(partialAnswers));assert.equal(kept.usage.requests,2,String(partialAnswers));
  if(partialAnswers)assert.deepEqual(kept.failedBlocks,[]);
 }
});

test('Strict mode asks a block that failed a check and one that fell short of the strict checks again together; only the first can still fail',async t=>{
 const blocks=[{id:'p5-b1',source:'1949年成立。'},{id:'p5-b2',source:'向量的模是向量的长度。'}];
 const requests=answered(t,b=>b.id==='p5-b1'?'Được thành lập.':'Môđun của 向量 là độ dài.');
 await assert.rejects(()=>translatePdfBlocks(env,{blocks},{strict:true}),/thiếu số hoặc dẫn chứng: 1949/u);
 assert.deepEqual(requests,[['p5-b1','p5-b2'],['p5-b1','p5-b2']]);
 answered(t,b=>b.id==='p5-b1'?'Được thành lập.':'Môđun của 向量 là độ dài.');
 const partial=await translatePdfBlocks(env,{blocks,partial:true},{strict:true});
 assert.deepEqual(partial.blocks,[{id:'p5-b2',translation:'Môđun của 向量 là độ dài.'}]);assert.deepEqual(partial.failedBlocks.map(b=>[b.id,b.code]),[['p5-b1','block_check']]);
 assert.deepEqual(partial.warnings,['Block p5-b2: còn chữ Hán chưa dịch: 向量']);
});

test('A translation that leaves a \( or \[ open, or closes one never opened, is named: the page prints the delimiter as written',()=>{
 const R=String.raw,blocks=[{id:'p2-b1',source:R`求 \(x^{2}+1\) 的最小值。`},{id:'p2-b2',source:R`已知 \[S_{n}=n^{2}\]，求 a_{n}。`}];
 const warnings=blockTranslationWarnings(blocks,[{id:'p2-b1',translation:R`Tìm giá trị nhỏ nhất của \(x^{2}+1.`},{id:'p2-b2',translation:R`Biết \[S_{n}=n^{2}\], tìm a_{n}.`}],{});
 assert.deepEqual(warnings.filter(w=>w.includes('mã công thức')),[R`Block p2-b1: còn mã công thức chưa dựng được: \(`]);
});
