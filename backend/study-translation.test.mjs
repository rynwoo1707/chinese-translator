import test from 'node:test';
import assert from 'node:assert/strict';
import {localTranslationReview,studyRoute} from './study-translation.js';
import {errorResponse} from './http.js';

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

test('A passage that lost its citation marker is corrected once by the stronger model, within the mode\'s reasoning',async t=>{
 const {env}=environment(),models=[],configs=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{models.push(endpoint);configs.push(JSON.parse(options.body).generationConfig);const value=models.length===1?{translation:'Bản dịch thiếu dẫn chứng.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Bản dịch có dẫn chứng [12].'}]};return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:'原文[12]。',mode:'balanced'}),env,url,path)).json();
 assert.equal(models.length,2);assert.match(models[0],/gemini-3\.1-flash-lite/);assert.equal(configs[0].thinkingConfig.thinkingLevel,'minimal');assert.match(models[1],/gemini-2\.5-flash/);assert.match(data.translation,/\[12\]/);assert.equal(data.usage.total,36);
 // The correction keeps the mode's bounded reasoning: unbounded default thinking on 2.5 Flash would bill hidden tokens.
 assert.deepEqual(configs[1].thinkingConfig,{thinkingBudget:0});
});

test('Missing marker in an aligned paragraph: only that paragraph goes in the correction request',async t=>{
 const {env,writes}=environment(),calls=[];
 const firstSource='甲'.repeat(160),secondSource='史料记载[12]。';
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{
  const body=JSON.parse(options.body),payload=JSON.parse(body.contents[0].parts[0].text);calls.push({endpoint,body,payload});
  const value=calls.length===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Sử liệu ghi chép [12].'}]};
  return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
 });
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:`${firstSource}\n\n${secondSource}`,mode:'economy'}),env,url,path)).json();
 assert.equal(calls.length,2);assert.match(calls[0].endpoint,/gemini-2\.5-flash-lite/);assert.match(calls[1].endpoint,/gemini-2\.5-flash/);
 assert.deepEqual(calls[1].payload.items,[{id:'d1',source:secondSource,draft:'Sử liệu ghi chép.',missingNumbers:['[12]']}]);
 assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingBudget,0);assert.deepEqual(calls[1].body.generationConfig.responseJsonSchema.required,['items']);
 assert.equal(data.translation,'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép [12].');assert.equal(data.usage.total,36);assert.equal(data.model,'gemini-2.5-flash-lite');assert.equal(data.repairModel,'gemini-2.5-flash');assert.equal(writes(),0);
});

test('A long passage that lost its marker is corrected in place, never translated again in full',async t=>{
 const {env}=environment(),sent=[];
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);sent.push(payload);const value=payload.items?{items:[{id:'d1',translation:'Bản dịch cần đối chiếu [12].'}]}:{translation:'Bản dịch cần đối chiếu.',contextUpdate:'',glossaryUpdates:{}};return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:'甲'.repeat(1700)+'[12]',mode:'economy'}),env,url,path)).json();
 assert.equal(sent.length,2);assert.equal(sent[1].items[0].draft,'Bản dịch cần đối chiếu.');assert.equal(data.usage.total,36);assert.equal(data.retried,true);assert.equal(data.translation,'Bản dịch cần đối chiếu [12].');
 // The marker is back; a stub's translation this short is still named.
 assert.deepEqual(data.warnings,['Bản dịch ngắn bất thường so với nguyên tác; nên kiểm tra khả năng bỏ sót nội dung.']);
});

test('A marker correction that rewrites the meaning is rejected and counted',async t=>{
 const {env}=environment();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;const value=calls===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Không hề có chứng cứ nào [12].'}]};return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source:`${'甲'.repeat(160)}\n\n史料记载[12]。`,mode:'economy'}),env,url,path)).json();
 assert.equal(calls,2);assert.equal(data.usage.total,36);assert.equal(data.translation,'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.');assert.deepEqual(data.warnings,['Đoạn 2: thiếu số hoặc dẫn chứng: [12]']);
});

test('A text-mode part that keeps Chinese or lacks a heading is corrected once in every mode, a clean one never',async t=>{
 const {env}=environment(),source='第一章 河流与城市\n\n古代的城市大多沿河而建，河流提供了水源和交通。';
 for(const mode of ['economy','balanced','quality','premium']){
  const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);calls.push(payload);const value=payload.items?{items:payload.items.map(item=>({id:item.id,translation:`Chương 1. Sông ngòi và thành thị\n${item.draft.replace('giao通','giao thông')}`}))}:{translation:'Các thành thị thời cổ phần lớn được xây dọc theo sông; sông ngòi cung cấp nguồn nước và giao通.',contextUpdate:'',glossaryUpdates:{}};return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
  const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source,mode}),env,url,path)).json();
  assert.equal(calls.length,2,mode);assert.deepEqual(calls[1].items.map(item=>[item.missingLines,item.chinese]),[[['第一章 河流与城市'],['通']]],mode);
  assert.equal(data.translation,'Chương 1. Sông ngòi và thành thị\n\nCác thành thị thời cổ phần lớn được xây dọc theo sông; sông ngòi cung cấp nguồn nước và giao thông.',mode);assert.deepEqual(data.warnings,[],mode);
 }
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Chương 1. Sông ngòi và thành thị\n\nCác thành thị thời cổ phần lớn được xây dọc theo sông.',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const data=await (await studyRoute(request({apiKey:'student-key-long-enough',source,mode:'economy'}),env,url,path)).json();
 assert.equal(calls,1);assert.deepEqual(data.warnings,[]);assert.equal(data.retried,false);
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

test('Local review flags a translation far too short and only reports paragraph counts, which joined OCR lines change',()=>{
 const source=['第一段包含大量需要翻译的中国历史资料。'.repeat(12),'第二段继续讨论史料。'.repeat(12),'第三段总结研究结论。'.repeat(12)].join('\n\n');
 const review=localTranslationReview(source,'Bản dịch quá ngắn.');
 assert.deepEqual(review.warnings,['Bản dịch ngắn bất thường so với nguyên tác; nên kiểm tra khả năng bỏ sót nội dung.']);
 assert.equal(review.metrics.sourceParagraphs,3);assert.equal(review.metrics.translatedParagraphs,1);
});

// An empty reading (a region of a watermark or a drawn mark) is refused as ocr_empty, which the page counts as a region
// left unread (frontend/pdf-client.js readPictureText); Gemini billed it, so its tokens come back with the answer.
test('An empty OCR reading answers ocr_empty with the tokens it was billed',async t=>{
 const {env}=environment();t.mock.method(globalThis,'fetch',async()=>Response.json({usageMetadata:{promptTokenCount:300,candidatesTokenCount:4,totalTokenCount:304},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'  ',warnings:[]})}]}}]}));
 const form=new FormData();form.set('apiKey','student-key-long-enough');form.set('image',new File([new Uint8Array([255,216,255,1,2,3])],'region.jpg',{type:'image/jpeg'}));
 const ocrPath='/api/my/study/ocr',ocrUrl=new URL('https://example.test'+ocrPath);
 const error=await studyRoute(new Request(ocrUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:'https://example.test'},body:form}),env,ocrUrl,ocrPath).then(()=>null,error=>error);
 assert.equal(error?.code,'ocr_empty');
 const response=errorResponse(error),data=await response.json();
 assert.equal(response.status,400);assert.equal(data.code,'ocr_empty');assert.equal(data.usage.total,304);assert.equal(data.usage.requests,1);
});

test('Student OCR returns a page\'s running head and foot as lines, without the marks of the reading',async t=>{
 const {env}=environment();t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'[đầu trang] 第一章 空间向量\n正文第一段。\n[chân trang] 3',warnings:[]})}]}}]}));
 const form=new FormData();form.set('apiKey','student-key-long-enough');form.set('image',new File([new Uint8Array([255,216,255,1,2,3])],'page.jpg',{type:'image/jpeg'}));
 const ocrPath='/api/my/study/ocr',ocrUrl=new URL('https://example.test'+ocrPath);
 const data=await (await studyRoute(new Request(ocrUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:'https://example.test'},body:form}),env,ocrUrl,ocrPath)).json();
 assert.equal(data.text,'第一章 空间向量\n正文第一段。\n3');
});

// D8 on the study page: the marked reading goes back beside the text, so a running head or foot read on several pages is
// kept once (frontend/study.js cleanReadPages); a reading without marks sends the text alone.
test('Student OCR also returns the marked reading when Gemini marked a running head or foot, and only then',async t=>{
 const {env}=environment(),ocrPath='/api/my/study/ocr',ocrUrl=new URL('https://example.test'+ocrPath);
 for(const [answer,text,marked] of [['[đầu trang] 第一章 集合\n第1页正文。\n[chân trang] 人民教育出版社','第一章 集合\n第1页正文。\n人民教育出版社',true],['第一章 集合\n第1页正文。','第一章 集合\n第1页正文。',false]]){
  t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:answer,warnings:[]})}]}}]}));
  const form=new FormData();form.set('apiKey','student-key-long-enough');form.set('image',new File([new Uint8Array([255,216,255,1,2,3])],'page.jpg',{type:'image/jpeg'}));
  const data=await (await studyRoute(new Request(ocrUrl,{method:'POST',headers:{Cookie:'cat_hien_session=temporary',Origin:'https://example.test'},body:form}),env,ocrUrl,ocrPath)).json();
  assert.equal(data.text,text);
  if(marked)assert.equal(data.marked,answer);else assert.equal(Object.hasOwn(data,'marked'),false);
 }
});
