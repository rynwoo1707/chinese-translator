import test from 'node:test';
import assert from 'node:assert/strict';
import {localTranslationReview,studyRoute} from './study-translation.js';

const path='/api/my/study/translate',url=new URL('https://example.test'+path);
function environment(){let writes=0;return {env:{DB:{prepare(){return {bind(){return this;},async first(){return {id:'student',name:'Lan'};}};}},FILES:{async put(){writes++;},async get(){throw new Error('Student text must not reach R2');}}},writes:()=>writes};}
const request=(body,origin='https://example.test')=>new Request(url,{method:'POST',headers:{Cookie:'cat_hien_session=temporary','Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});

test('Student translation uses a session key, economical model and no persistent cache',async t=>{
 const {env,writes}=environment(),calls=[];
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{calls.push({endpoint,options,body:JSON.parse(options.body)});return Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Năm 2024, nhà nghiên cứu ghi chép [1].',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const response=await studyRoute(request({apiKey:'student-key-long-enough',source:'2024年，研究者記錄[1]。',mode:'economy'}),env,url,path),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.usage.total,30);assert.equal(data.model,'gemini-2.5-flash-lite');assert.equal(calls.length,1);
 assert.match(calls[0].endpoint,/gemini-2\.5-flash-lite/);assert.equal(calls[0].options.headers['x-goog-api-key'],'student-key-long-enough');assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget,0);assert.equal(writes(),0);
 assert.deepEqual(calls[0].body.generationConfig.responseJsonSchema.required,['translation','contextUpdate','glossaryUpdates']);
 assert.doesNotMatch(JSON.stringify(data),/student-key/);
});

test('Student endpoint repairs detached Vietnamese tones before rendering',async t=>{
 const {env}=environment();
 t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Cùng giố`ng nhau, độ dài bằ`ng 1 và điểm đâ`u A.',contextUpdate:'',glossaryUpdates:{}})}]}}]}));
 const response=await studyRoute(request({apiKey:'student-key-long-enough',source:'两个向量相同，长度为1，起点为A。',mode:'economy',domain:'math'}),env,url,path),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.translation,'Cùng giống nhau, độ dài bằng 1 và điểm đầu A.');
});

test('Study modes follow the server configured Gemini model when provided',async t=>{
 const {env}=environment();env.GEMINI_MODEL='gemini-3.6-flash';let endpoint,config;
 t.mock.method(globalThis,'fetch',async(url,options)=>{endpoint=url;config=JSON.parse(options.body).generationConfig;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch Toán',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const response=await studyRoute(request({apiKey:'student-key-long-enough',source:'数学',mode:'economy',domain:'math'}),env,url,path),data=await response.json();
 assert.equal(response.status,200);assert.match(endpoint,/gemini-3\.6-flash/);assert.equal(config.thinkingConfig.thinkingLevel,'minimal');assert.equal(data.model,'gemini-3.6-flash');
});

test('Missing citation marker triggers a stronger retry only for that passage',async t=>{
 const {env}=environment(),models=[],configs=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{models.push(endpoint);configs.push(JSON.parse(options.body).generationConfig);const translation=models.length===1?'Bản dịch thiếu dẫn chứng.':'Bản dịch có dẫn chứng [12].';return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation,contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:'原文[12]。',mode:'balanced'}),env,url,path)).json();
 assert.equal(models.length,2);assert.match(models[0],/gemini-3\.1-flash-lite/);assert.equal(configs[0].thinkingConfig.thinkingLevel,'minimal');assert.match(models[1],/gemini-2\.5-flash/);assert.match(data.translation,/\[12\]/);assert.equal(data.usage.total,36);
 // The full retry keeps a bounded reasoning budget: unbounded default thinking on 2.5 Flash would bill hidden tokens.
 assert.deepEqual(configs[1].thinkingConfig,{thinkingBudget:1024});
});

test('Missing marker in an aligned paragraph repairs only that paragraph',async t=>{
 const {env,writes}=environment(),calls=[];
 const firstSource='甲'.repeat(160),secondSource='史料记载[12]。';
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{
  const body=JSON.parse(options.body),payload=JSON.parse(body.contents[0].parts[0].text);calls.push({endpoint,body,payload});
  const value=calls.length===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{translation:'Sử liệu ghi chép [12].'};
  return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
 });
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:`${firstSource}\n\n${secondSource}`,mode:'economy'}),env,url,path)).json();
 assert.equal(calls.length,2);assert.match(calls[0].endpoint,/gemini-2\.5-flash-lite/);assert.match(calls[1].endpoint,/gemini-2\.5-flash/);
 assert.equal(calls[1].payload.source,secondSource);assert.equal(calls[1].payload.draft,'Sử liệu ghi chép.');assert.deepEqual(calls[1].payload.requiredMarkers,['[12]']);
 assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingBudget,0);assert.deepEqual(calls[1].body.generationConfig.responseSchema.required,['translation']);
 assert.equal(data.translation,'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép [12].');assert.equal(data.usage.total,36);assert.equal(data.model,'gemini-2.5-flash-lite');assert.equal(data.repairModel,'gemini-2.5-flash');assert.equal(writes(),0);
});

test('An unaligned long passage is flagged without paying for a full second translation',async t=>{
 const {env}=environment();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch cần đối chiếu.',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:'甲'.repeat(1700)+'[12]',mode:'economy'}),env,url,path)).json();
 assert.equal(calls,1);assert.equal(data.usage.total,18);assert.equal(data.retried,false);assert.match(data.warnings.join(' '),/\[12\]/);
});

test('A marker repair that rewrites the meaning is rejected and counted',async t=>{
 const {env}=environment();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;const value=calls===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{translation:'Không hề có chứng cứ nào [12].'};return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:`${'甲'.repeat(160)}\n\n史料记载[12]。`,mode:'economy'}),env,url,path)).json();
 assert.equal(calls,2);assert.equal(data.usage.total,36);assert.equal(data.translation,'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.');assert.match(data.warnings.join(' '),/\[12\]/);
});

test('Student endpoint requires login and same-origin requests',async()=>{
 const {env}=environment(),unauthenticated={...env,DB:{prepare(){return {bind(){return this;},async first(){return null;}};}}};
 assert.equal((await studyRoute(request({apiKey:'student-key-long-enough',source:'你好'}),unauthenticated,url,path)).status,401);
 assert.equal((await studyRoute(request({apiKey:'student-key-long-enough',source:'你好'},'https://elsewhere.test'),env,url,path)).status,403);
});

test('Study translation never falls back to the server key',async()=>{
 const {env}=environment();env.GEMINI_API_KEY='server-key-must-not-be-used';
 await assert.rejects(()=>studyRoute(request({source:'你好',mode:'economy'}),env,url,path),/Khóa Gemini API không hợp lệ/);
});

test('TXT extraction needs no Gemini key or model request',async t=>{
 const {env,writes}=environment();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Gemini must not be called');});
 const form=new FormData();form.set('file',new File(['第一段。\n第二段。'],'lesson.txt',{type:'text/plain'}));
 const extractPath='/api/my/study/extract',extractUrl=new URL('https://example.test'+extractPath);
 const response=await studyRoute(new Request(extractUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:'https://example.test'},body:form}),env,extractUrl,extractPath);
 const data=await response.json();assert.equal(response.status,200);assert.match(data.text,/第一段/);assert.equal(calls,0);assert.equal(writes(),0);
});

test('Student OCR sends only an optimized image with the student key',async t=>{
 const {env,writes}=environment(),requests=[];env.GEMINI_MODEL='gemini-3.6-flash';t.mock.method(globalThis,'fetch',async(endpoint,options)=>{requests.push({endpoint,options});return Response.json({usageMetadata:{promptTokenCount:40,candidatesTokenCount:12,totalTokenCount:52},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'識別文字',warnings:[]})}]}}]});});
 const form=new FormData();form.set('apiKey','student-key-long-enough');form.set('image',new File([new Uint8Array([255,216,255,1,2,3])],'page.jpg',{type:'image/jpeg'}));
 const ocrPath='/api/my/study/ocr',ocrUrl=new URL('https://example.test'+ocrPath);
 const response=await studyRoute(new Request(ocrUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:'https://example.test'},body:form}),env,ocrUrl,ocrPath);
 const data=await response.json();assert.equal(response.status,200);assert.equal(data.text,'識別文字');assert.equal(data.usage.total,52);assert.equal(data.model,'gemini-3.6-flash');assert.equal(requests.length,1);assert.match(requests[0].endpoint,/gemini-3\.6-flash/);assert.equal(writes(),0);
});

test('Look-alike ideographs pasted from a PDF (Kangxi radicals, compatibility forms) are unified before glossary matching and translation',async t=>{
 const {env}=environment(),sent=[],cp=(...codes)=>String.fromCodePoint(...codes);
 // 力 as the Kangxi radical U+2F12, 一 as U+2F00, 人 as U+2F08 and 理 as the compatibility ideograph U+F9E4; the radical
 // U+2E81 has no unified form and stays.
 const pasted=`${cp(0x2F12)}学是物${cp(0xF9E4)}学的${cp(0x2F00)}部分，${cp(0x2F08)}民需要${cp(0x2F12)}学${cp(0x2E81)}。`,unified=`力学是物理学的一部分，人民需要力学${cp(0x2E81)}。`;
 let answer={translation:'Cơ học là một phần của vật lý; người dân cần cơ học.',contextUpdate:'',glossaryUpdates:{}};
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{sent.push(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text));return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]});});
 // The student's own term typed with the radical form too.
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:pasted,mode:'economy',glossary:{'力学':'cơ học',[`${cp(0x2F08)}民`]:'nhân dân'},previousSource:`前文${cp(0x2F00)}`}),env,url,path)).json();
 assert.equal(sent[0].source,unified);assert.equal(sent[0].previousSource,'前文一');
 assert.deepEqual(Object.keys(sent[0].glossary).filter(key=>['力学','人民'].includes(key)).sort(),['人民','力学']);
 // The term check reads the unified text as well: "nhân dân" is missing from the answer.
 assert.ok(data.warnings.some(warning=>/人民 → nhân dân/u.test(warning)),JSON.stringify(data.warnings));assert.ok(!data.warnings.some(warning=>/力学/u.test(warning)));
 // Kept-layout blocks: the sources Gemini reads and the terms matched against them are unified the same way.
 answer={blocks:[{id:'p1-b1',translation:'Cơ học.'}],contextUpdate:'',glossaryUpdates:{}};
 const blocksPath='/api/my/study/translate-blocks',blocksUrl=new URL('https://example.test'+blocksPath);
 const blocks=await studyRoute(new Request(blocksUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary','Content-Type':'application/json',Origin:'https://example.test'},body:JSON.stringify({apiKey:'student-key-long-enough',blocks:[{id:'p1-b1',source:`${cp(0x2F12)}学。`}],glossary:{[`${cp(0x2F12)}学`]:'cơ học'}})}),env,blocksUrl,blocksPath);
 assert.equal(blocks.status,200);assert.equal(sent[1].blocks[0].source,'力学。');assert.equal(sent[1].glossary['力学'],'cơ học');
 // Wherever terms are matched on the server (the admin pipeline, older manifests), look-alikes match too.
 const {relevantGlossary,missingGlossaryTerms}=await import('./ai.js');
 assert.deepEqual(relevantGlossary({'力学':'cơ học','化学':'hóa học'},`${cp(0x2F12)}学`),{'力学':'cơ học'});
 assert.deepEqual(relevantGlossary({[`${cp(0x2F12)}学`]:'cơ học'},'力学是物理学的一部分'),{'力学':'cơ học'});
 assert.deepEqual(missingGlossaryTerms(`${cp(0x2F12)}学`,'Vật lý',{'力学':'cơ học'}),['力学 → cơ học']);
});

test('Local academic review flags likely omissions without another model request',()=>{
 const source=['第一段包含大量需要翻译的中国历史资料。'.repeat(12),'第二段继续讨论史料。'.repeat(12),'第三段总结研究结论。'.repeat(12)].join('\n\n');
 const review=localTranslationReview(source,'Bản dịch quá ngắn.');
 assert.ok(review.warnings.some(item=>/ngắn bất thường/.test(item)));
 assert.ok(review.warnings.some(item=>/cấu trúc/.test(item)));
 assert.equal(review.metrics.sourceParagraphs,3);
});
