import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {generate,translate,translateAndVerify,thinkingConfigFor} from './ai.js';
import {UserError,errorResponse} from './http.js';
import {GEMINI_ERROR_CODES} from './gemini-errors.js';
import {listStudyModels} from './gemini-models.js';

const env={GEMINI_API_KEY:'student-key-long-enough-123',GEMINI_MODEL:'gemini-2.5-flash-lite'};
// Gemini's RESOURCE_EXHAUSTED answer: QuotaFailure names the quota, RetryInfo (when present) says when to retry.
const quota=(quotaId,retryDelay,headers={})=>()=>Response.json({error:{code:429,message:'You exceeded your current quota, please check your plan and billing details.',status:'RESOURCE_EXHAUSTED',details:[
 {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/generate_content_free_tier_requests',quotaId,quotaDimensions:{location:'global',model:'gemini-2.5-flash-lite'},quotaValue:'15'}]},
 {'@type':'type.googleapis.com/google.rpc.Help',links:[{description:'Learn more about Gemini API quotas',url:'https://ai.google.dev/gemini-api/docs/rate-limits'}]},
 ...(retryDelay===undefined?[]:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay}])]}},{status:429,headers});
const failure=(status,error)=>()=>Response.json({error:{code:status,...error}},{status});
const answer=(value,{finishReason='STOP',usage={promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}}={})=>()=>Response.json({candidates:[{finishReason,content:{parts:[{text:typeof value==='string'?value:JSON.stringify(value)}]}}],usageMetadata:usage});
// Each call gets the next answer (the last one repeats); waits are recorded instead of slept.
function gemini(t,answers){
 const calls=[],delays=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return answers[Math.min(calls.length,answers.length)-1]();});
 t.mock.method(globalThis,'setTimeout',(callback,ms)=>{delays.push(ms);queueMicrotask(callback);return 0;});
 return {calls,delays};
}
const rejected=async promise=>{try{await promise;}catch(error){return error;}assert.fail('expected a rejection');};
const translation=text=>({translation:text,contextUpdate:'',glossaryUpdates:{}});

test('A per-minute quota with a long retry delay goes straight back to the browser with its code and wait',async t=>{
 const {calls,delays}=gemini(t,[quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier','37.3s')]);
 const error=await rejected(generate(env,[{text:'你好'}],'Translate'));
 assert.ok(error instanceof UserError);assert.deepEqual([error.status,error.code,error.retryAfter],[429,'quota_minute',38]);
 assert.match(error.message,/mỗi phút.*khoảng 38 giây/u);assert.equal(calls.length,1);assert.deepEqual(delays,[]);
 const response=errorResponse(error);assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'38');
 assert.deepEqual(await response.json(),{error:error.message,code:'quota_minute',retryAfter:38});
 // Input tokens per minute are a per-minute quota too.
 gemini(t,[quota('GenerateContentInputTokensPerModelPerMinute-FreeTier','45s')]);assert.equal((await rejected(generate(env,[{text:'x'}],'i'))).code,'quota_minute');
});

test('A short per-minute wait is spent inside the request, and only answered attempts are billed',async t=>{
 const {calls,delays}=gemini(t,[quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier','2.4s'),answer({ok:true})]);
 const result=await generate(env,[{text:'你好'}],'Translate');
 assert.deepEqual(result,{ok:true});assert.deepEqual(delays,[3000]);assert.equal(calls.length,2);
 assert.deepEqual(result.__usage,{prompt:10,output:5,thinking:0,total:15,requests:1,cacheHits:0});
 // RetryInfo in its object form, and a Retry-After header when the body says nothing.
 let waits=gemini(t,[quota('GenerateRequestsPerMinutePerProjectPerModel',{seconds:'3',nanos:500000000}),answer({ok:1})]).delays;await generate(env,[{text:'x'}],'i');assert.deepEqual(waits,[4000]);
 waits=gemini(t,[quota('',undefined,{'Retry-After':'5'}),answer({ok:1})]).delays;await generate(env,[{text:'x'}],'i');assert.deepEqual(waits,[5000]);
});

test('A daily quota fails at once and says when it resets in Vietnam time',async t=>{
 const {calls,delays}=gemini(t,[quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]);
 const error=await rejected(generate(env,[{text:'你好'}],'Translate'));
 assert.deepEqual([error.status,error.code],[429,'quota_day']);assert.equal(calls.length,1);assert.deepEqual(delays,[]);
 // Pacific midnight is 14:00 or 15:00 in Vietnam; retryAfter counts down to it.
 assert.ok(error.retryAfter>=1&&error.retryAfter<=86400,String(error.retryAfter));
 assert.match(error.message,/hết hạn mức yêu cầu trong ngày.*đến 1[45]:00 \(giờ Việt Nam\)/u);
 gemini(t,[quota('GenerateRequestsPerDayPerProjectPerModel','3600s')]);assert.equal((await rejected(generate(env,[{text:'x'}],'i'))).retryAfter,3600);
});

test('A quota error without details is retried twice with backoff, then reported with an unknown wait',async t=>{
 const {calls,delays}=gemini(t,[failure(429,{message:'Resource has been exhausted (e.g. check quota).',status:'RESOURCE_EXHAUSTED'})]);
 const error=await rejected(generate(env,[{text:'你好'}],'Translate'));
 assert.deepEqual([error.status,error.code,error.retryAfter],[429,'quota',null]);assert.equal(calls.length,3);assert.deepEqual(delays,[1000,2000]);
 const response=errorResponse(error);assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),null);
 assert.deepEqual(await response.json(),{error:error.message,code:'quota',retryAfter:null});
});

test('Gemini overloaded or out of reach after the retries here is a 503 the browser may try again, with its wait',async t=>{
 const {calls,delays}=gemini(t,[failure(503,{message:'The model is overloaded. Please try again later.',status:'UNAVAILABLE'})]);
 let error=await rejected(generate(env,[{text:'你好'}],'Translate'));
 assert.ok(error instanceof UserError);assert.deepEqual([error.status,error.code,error.retryAfter],[503,'gemini_unavailable',30]);
 assert.equal(calls.length,3);assert.deepEqual(delays,[1000,2000]);assert.match(error.message,/^Gemini đang quá tải hoặc tạm thời không phản hồi \(mã 503\)/u);
 const response=errorResponse(error);assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'30');
 assert.deepEqual(await response.json(),{error:error.message,code:'gemini_unavailable',retryAfter:30});
 // Gemini's own Retry-After is kept; a 500, a timeout and a lost connection are the same case.
 gemini(t,[()=>new Response('busy',{status:500,headers:{'Retry-After':'45'}})]);error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.deepEqual([error.status,error.code,error.retryAfter],[503,'gemini_unavailable',45]);
 gemini(t,[failure(408,{message:'Request timed out.'})]);assert.equal((await rejected(generate(env,[{text:'x'}],'i'))).code,'gemini_unavailable');
 const lost=gemini(t,[()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});}]);error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.deepEqual([error.status,error.code],[503,'gemini_unavailable']);assert.match(error.message,/ECONNRESET/u);assert.equal(lost.calls.length,3);
 // Through the Worker the block route answers 503 with the code, and a failed attempt's tokens still ride along.
 const DB={prepare(){return {bind(){return this;},async first(){return {id:'student',name:'Lan',email:'lan@example.test'};},async run(){return {meta:{changes:1}};}};}};
 gemini(t,[failure(503,{message:'overloaded',status:'UNAVAILABLE'})]);
 const route=await worker.fetch(new Request('https://example.test/api/my/study/translate-blocks',{method:'POST',headers:{Cookie:'cat_hien_session=token','Content-Type':'application/json'},body:JSON.stringify({apiKey:'student-key-long-enough-123',mode:'economy',blocks:[{id:'p1-b0',source:'你好。'}]})}),{DB},{});
 assert.equal(route.status,503);assert.equal(route.headers.get('Retry-After'),'30');assert.equal((await route.json()).code,'gemini_unavailable');
 gemini(t,[answer('not json'),failure(503,{message:'overloaded'})]);error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.equal(error.code,'gemini_unavailable');assert.deepEqual(error.usage,{prompt:10,output:5,thinking:0,total:15,requests:1,cacheHits:0});
});

test('Key problems are code gemini_key, request problems are not, and Google\'s own text never reaches the student',async t=>{
 const cases=[
  [failure(400,{message:'API key not valid. Please pass a valid API key.',status:'INVALID_ARGUMENT',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_INVALID',domain:'googleapis.com'}]}),400,/\(400\): khóa Gemini API không hợp lệ/u],
  [failure(400,{message:'API key expired. Please renew the API key.',status:'INVALID_ARGUMENT'}),400,/\(400\): khóa Gemini API không hợp lệ hoặc đã hết hạn/u],
  [failure(401,{message:'Request had invalid authentication credentials.',status:'UNAUTHENTICATED'}),400,/\(401\): khóa Gemini API không hợp lệ/u],
  [failure(403,{message:"Permission denied: Consumer 'api_key:AIzaSyLEAKEDKEY0000' has been suspended.",status:'PERMISSION_DENIED',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'CONSUMER_SUSPENDED'}]}),403,/\(403\): khóa Gemini API đang bị chặn/u],
  [failure(403,{message:'Your API key was reported as leaked. Please use another API key.',status:'PERMISSION_DENIED'}),403,/đang bị chặn/u],
  [failure(400,{message:'User location is not supported for the API use without a billing account linked.',status:'FAILED_PRECONDITION'}),403,/chưa dùng được Gemini API khi chưa bật Billing/u]
 ];
 for(const [reply,status,message] of cases){
  const {calls}=gemini(t,[reply]),error=await rejected(generate(env,[{text:'x'}],'i'));
  assert.ok(error instanceof UserError,String(message));assert.deepEqual([error.status,error.code],[status,'gemini_key']);assert.match(error.message,message);assert.equal(calls.length,1,'a key problem is never retried');
  assert.doesNotMatch(error.message,/AIza|Permission denied|API key not valid|location/u);
  assert.deepEqual(await errorResponse(error).json(),{error:error.message,code:'gemini_key'});
 }
 gemini(t,[failure(400,{message:'Request payload size exceeds the limit: 20971520 bytes.',status:'INVALID_ARGUMENT'})]);
 const request=await rejected(generate(env,[{text:'x'}],'i'));
 assert.ok(request instanceof UserError);assert.equal(request.code,'gemini_request');assert.match(request.message,/Gemini không nhận yêu cầu này \(400\): dữ liệu gửi đi không hợp lệ hoặc quá lớn/u);
 // Browsers released before the codes forget the key on these words: a request problem must not say them.
 assert.doesNotMatch(request.message,/Gemini từ chối|Khóa Gemini/u);
 const response=errorResponse(request);assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:request.message,code:'gemini_request'});
});

test('A place Gemini does not serve is gemini_location: a 503 to retry, never a key problem, on translation and model listing',async t=>{
 const where=failure(400,{message:'User location is not supported for the API use.',status:'FAILED_PRECONDITION'});
 let {calls}=gemini(t,[where]);const error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.ok(error instanceof UserError);assert.deepEqual([error.status,error.code,error.retryAfter],[503,'gemini_location',60]);assert.equal(calls.length,1,'not retried inside the request');
 assert.doesNotMatch(error.message,/Gemini từ chối|Khóa Gemini|location/u);assert.match(error.message,/Khóa của bạn vẫn dùng được/u);
 const response=errorResponse(error);assert.equal(response.headers.get('Retry-After'),'60');assert.deepEqual(await response.json(),{error:error.message,code:'gemini_location',retryAfter:60});
 // The model list a student's first step asks for answers the same.
 let listed=0;t.mock.method(globalThis,'fetch',async()=>{listed++;return where();});const listing=await rejected(listStudyModels('student-key-long-enough-123'));
 assert.deepEqual([listing.status,listing.code],[503,'gemini_location']);assert.equal(listed,1);
 // Through the Worker: the study route answers 503 with the code, the key stays in the tab.
 const DB={prepare(){return {bind(){return this;},async first(){return {id:'student',name:'Lan',email:'lan@example.test'};},async run(){return {meta:{changes:1}};}};}};
 gemini(t,[where]);
 const route=await worker.fetch(new Request('https://example.test/api/my/study/translate',{method:'POST',headers:{Cookie:'cat_hien_session=token','Content-Type':'application/json'},body:JSON.stringify({apiKey:'student-key-long-enough-123',mode:'economy',source:'你好。'})}),{DB},{});
 assert.equal(route.status,503);assert.equal((await route.json()).code,'gemini_location');
});

test('A refusal or a cut-off answer has its own code and wording, which never blames the key',async t=>{
 for(const [finishReason,code,pattern] of [['RECITATION','gemini_refused',/trùng khớp nguyên văn/u],['SAFETY','gemini_refused',/bộ lọc an toàn/u],['OTHER','gemini_refused',/không trả kết quả/u],['MAX_TOKENS','gemini_truncated',/vượt giới hạn độ dài/u]]){
  gemini(t,[answer('',{finishReason})]);const error=await rejected(generate(env,[{text:'x'}],'i'));
  assert.deepEqual([error.status,error.code,error.finishReason],[400,code,finishReason]);assert.match(error.message,pattern);assert.doesNotMatch(error.message,/Gemini từ chối|Khóa Gemini/u);
 }
 assert.deepEqual(GEMINI_ERROR_CODES.filter(code=>code==='gemini_key'),['gemini_key'],'one code only means the key');
});

test('Every model id of a thinking family gets the bound: dated, preview and -001 ids included',()=>{
 for(const id of ['gemini-2.5-flash','gemini-2.5-flash-001','gemini-2.5-flash-preview-05-20','gemini-2.5-flash-preview-09-2025','gemini-2.5-flash-lite','gemini-2.5-flash-lite-preview-09-2025'])assert.deepEqual(thinkingConfigFor(id,'minimal'),{thinkingBudget:0},id);
 for(const id of ['gemini-3-flash','gemini-3-flash-preview','gemini-3.6-flash','gemini-3.1-flash-lite'])assert.deepEqual(thinkingConfigFor(id,'low'),{thinkingLevel:'low'},id);
 assert.equal(thinkingConfigFor('gemini-2.0-flash','minimal'),null);assert.equal(thinkingConfigFor('gemini-3.6-flash','default'),null);assert.equal(thinkingConfigFor('gemini-30-flash','minimal'),null);
});

test('Every billed attempt counts: a malformed answer retried, a blocked or cut-off answer, and failed repairs',async t=>{
 let {calls}=gemini(t,[answer('not json at all'),answer({ok:true})]);
 assert.deepEqual((await generate(env,[{text:'x'}],'i')).__usage,{prompt:20,output:10,thinking:0,total:30,requests:2,cacheHits:0});assert.equal(calls.length,2);
 gemini(t,[answer('{broken')]);let error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.match(error.message,/sai định dạng sau 3 lần thử/u);assert.deepEqual(error.usage,{prompt:30,output:15,thinking:0,total:45,requests:3,cacheHits:0});
 gemini(t,[answer('',{finishReason:'SAFETY',usage:{promptTokenCount:50,totalTokenCount:50}})]);error=await rejected(generate(env,[{text:'x'}],'i'));
 assert.equal(error.finishReason,'SAFETY');assert.deepEqual(error.usage,{prompt:50,output:0,thinking:0,total:50,requests:1,cacheHits:0});
 // A section cut off at the output limit was billed in full before its two halves.
 ({calls}=gemini(t,[answer('',{finishReason:'MAX_TOKENS',usage:{promptTokenCount:1000,candidatesTokenCount:8000,totalTokenCount:9000}}),answer(translation('Nửa đầu.')),answer(translation('Nửa sau.'))]));
 const split=await translate(env,'甲'.repeat(1000)+'。\n'+'乙'.repeat(1000)+'。',{genre:'',glossary:'{}'});
 assert.equal(calls.length,3);assert.deepEqual(split.usage,{prompt:1020,output:8010,thinking:0,total:9030,requests:3,cacheHits:0});
 // A later section failing still reports the sections already translated.
 gemini(t,[answer(translation('Phần một.')),answer('',{finishReason:'SAFETY',usage:{promptTokenCount:50,totalTokenCount:50}})]);
 error=await rejected(translate(env,'甲'.repeat(9000)+'。\n'+'乙'.repeat(3000)+'。',{genre:'',glossary:'{}'}));
 assert.equal(error.finishReason,'SAFETY');assert.deepEqual(error.usage,{prompt:60,output:5,thinking:0,total:65,requests:2,cacheHits:0});
 // A repair that comes back empty keeps the first translation, and its tokens.
 const source='第一段的内容比较长，包含很多文字和说明。\n\n第二段[12]。';
 gemini(t,[answer(translation('Đoạn một có nội dung khá dài.\n\nĐoạn hai.')),answer({translation:''})]);
 const repaired=await translateAndVerify(env,source,{genre:'',glossary:'{}'});
 assert.equal(repaired.repairScope,'partial');assert.match(repaired.warnings.join(' '),/không hiệu đính được/u);assert.deepEqual(repaired.usage,{prompt:20,output:10,thinking:0,total:30,requests:2,cacheHits:0});
 // A full retry that fails reports the first translation's tokens and its own.
 gemini(t,[answer(translation('Sử liệu ghi chép.')),answer('',{finishReason:'RECITATION',usage:{promptTokenCount:40,totalTokenCount:40}})]);
 error=await rejected(translateAndVerify(env,'史料记载[12]。',{genre:'',glossary:'{}'}));
 assert.equal(error.finishReason,'RECITATION');assert.deepEqual(error.usage,{prompt:50,output:5,thinking:0,total:55,requests:2,cacheHits:0});
 assert.deepEqual((await errorResponse(error).json()).usage,error.usage,'the browser receives what was spent');
});

test('A successful call is unchanged: one request, the same payload and the usage of that answer only',async t=>{
 const {calls,delays}=gemini(t,[answer({translation:'Xin chào.',contextUpdate:'',glossaryUpdates:{}},{usage:{promptTokenCount:12,candidatesTokenCount:4,thoughtsTokenCount:3,totalTokenCount:19}})]);
 const result=await generate({...env,GEMINI_THINKING:'minimal'},[{text:'你好'}],'Translate',true,{schema:{type:'object'}});
 assert.deepEqual(result,{translation:'Xin chào.',contextUpdate:'',glossaryUpdates:{}});assert.deepEqual(result.__usage,{prompt:12,output:4,thinking:3,total:19,requests:1,cacheHits:0});assert.equal(result.__model,'gemini-2.5-flash-lite');
 assert.equal(calls.length,1);assert.deepEqual(delays,[]);
 assert.deepEqual(calls[0].body,{systemInstruction:{parts:[{text:'Translate'}]},contents:[{role:'user',parts:[{text:'你好'}]}],generationConfig:{temperature:0.1,maxOutputTokens:32768,thinkingConfig:{thinkingBudget:0},responseMimeType:'application/json',responseJsonSchema:{type:'object'}}});
});

// Through the Worker, as the study workspace calls it: quota and key errors keep their status, code and wait, and a
// failure after billed attempts carries their tokens.
test('Study routes answer Gemini quota and key errors with the browser contract',async t=>{
 const DB={prepare(){return {bind(){return this;},async first(){return {id:'student',name:'Lan',email:'lan@example.test'};},async run(){return {meta:{changes:1}};}};}};
 const call=(path,body)=>worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:{Cookie:'cat_hien_session=token','Content-Type':'application/json'},body:JSON.stringify({apiKey:'student-key-long-enough-123',mode:'economy',...body})}),{DB},{});
 gemini(t,[quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier','42s')]);
 let response=await call('/api/my/study/translate',{source:'你好。'});
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'42');let body=await response.json();assert.deepEqual([body.code,body.retryAfter],['quota_minute',42]);assert.match(body.error,/khoảng 42 giây/u);
 gemini(t,[quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]);
 body=await (response=await call('/api/my/study/translate-blocks',{blocks:[{id:'p1-b0',source:'你好。'}]})).json();assert.equal(response.status,429);assert.equal(body.code,'quota_day');assert.ok(body.retryAfter>0);
 gemini(t,[failure(400,{message:'API key not valid.',status:'INVALID_ARGUMENT',details:[{reason:'API_KEY_INVALID'}]})]);
 body=await (response=await call('/api/my/study/translate',{source:'你好。'})).json();assert.equal(response.status,400);assert.deepEqual(Object.keys(body).sort(),['code','error']);assert.equal(body.code,'gemini_key');
 gemini(t,[answer('',{finishReason:'SAFETY',usage:{promptTokenCount:70,totalTokenCount:70}})]);
 body=await (response=await call('/api/my/study/translate-blocks',{blocks:[{id:'p1-b0',source:'你好。'}]})).json();assert.equal(response.status,400);assert.match(body.error,/bộ lọc an toàn/u);assert.deepEqual(body.usage,{prompt:70,output:0,thinking:0,total:70,requests:1,cacheHits:0});
});
