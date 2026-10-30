import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizePdfBlocks,normalizeOcrMath,readingDoubt,undrawableTex} from './pdf-block-ocr.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {applyOcrReadings,unreadable} from './pdf-layout-apply.js';
import {MODES,modeProfile,LAYOUT_VERSION} from '../frontend/translation-modes.js';
import {renderMathText,unsupportedMath} from '../frontend/math-text.js';

const png='data:image/png;base64,AA==';
const studentKey='student-ocr-key-12345678901234567890';
const serverKey='server-key-must-never-be-used';
const model='gemini-3.6-flash';
const reader={id:'student-1'},other={id:'student-2'};
const assetId='11111111-1111-4111-8111-111111111111';
const base='/api/my/study/pdf-layout';
const origin='https://example.test';
const manifestKey=owner=>`study/${owner.id}/pdf-layout/${assetId}/manifest.json`;
const aiEnv={GEMINI_API_KEY:studentKey,GEMINI_MODEL:model,GEMINI_THINKING:'minimal'};
const blocks=()=>[
 {id:'p4-b0',source:'Tesseract 猜错 SPACE vector',image:png,box:[20,20,220,80],fontSize:12},
 {id:'p4-b1',source:'向量 @@PDF_INLINE_0@@ 的模。',image:png,box:[20,100,220,160],fontSize:12,
  inlines:[{token:'@@PDF_INLINE_0@@',box:[80,110,110,125],image:png,text:'a = b',width:30,height:15}]}
];
const corrected=()=>[{id:'p4-b0',text:'空间向量是有大小和方向的量。'},{id:'p4-b1',text:'向量 @@PDF_INLINE_0@@ 的模。'}];
const generationResponse=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:23,candidatesTokenCount:17,totalTokenCount:40}});
function mockGeneration(t,result={blocks:corrected(),warnings:[]}){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),options,body:JSON.parse(options.body)});
  return generationResponse(typeof result==='function'?result(calls):result);
 });
 return calls;
}
// Manifests are stored as ASCII JSON bytes (asciiJsonBytes); values a test puts itself are strings.
const storedText=value=>typeof value==='string'?value:new TextDecoder().decode(value);
class MemoryFiles{
 constructor(){this.values=new Map();this.reads=[];this.writes=[];}
 async put(key,value,options){this.values.set(key,value);this.writes.push({key,value,options});}
 async get(key){this.reads.push(key);const value=this.values.get(key);return value===undefined?null:{body:value,json:async()=>JSON.parse(storedText(value)),text:async()=>storedText(value)};}
}
function environment(){
 const FILES=new MemoryFiles();
 return {env:{FILES,GEMINI_API_KEY:serverKey,GEMINI_MODEL:'gemini-2.5-flash'},FILES};
}
function document(){
 return {version:1,extractionVersion:2,totalPages:88,pages:[
  {number:4,width:600,height:800,ocr:true,background:png,original:png,blocks:blocks()},
  {number:5,width:600,height:800,ocr:false,background:png,original:png,blocks:[{id:'p5-b0',source:'原生 PDF 文本。',text:'原生 PDF 文本。',box:[20,20,220,80],fontSize:12}]}
 ]};
}
const request=body=>new Request(origin+base+'/ocr-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const body=overrides=>({assetId,apiKey:studentKey,model,blockIds:['p4-b0','p4-b1'],...overrides});
const ocrRoute=(env,payload,owner=reader)=>pdfLayoutRoute(request(payload),env,base+'/ocr-blocks',owner);

test('Block OCR sends authoritative PNG images with noisy source hints and formula locations as multimodal parts',async t=>{
 const input=blocks(),before=structuredClone(input),calls=mockGeneration(t,{blocks:corrected().reverse(),warnings:['术语需核对。',42]});
 const result=await recognizePdfBlocks(aiEnv,input);
 assert.equal(calls.length,1);assert.match(calls[0].url,/\/models\/gemini-3\.6-flash:generateContent$/u);
 assert.equal(calls[0].options.headers['x-goog-api-key'],studentKey);
 const payload=calls[0].body,parts=payload.contents[0].parts;
 assert.equal(parts.length,6);
 const paragraphs=parts.flatMap((part,index)=>{if(!part.text)return [];const metadata=JSON.parse(part.text);return metadata.id?[{metadata,image:parts[index+1]}]:[];});
 for(let i=0;i<input.length;i++){
  const hint=paragraphs[i].metadata;assert.equal(hint.id,input[i].id);assert.equal(hint.sourceHint,input[i].source);
  assert.deepEqual(hint.formulaRegions,(input[i].inlines||[]).map(({token,box})=>({token,box})));
  assert.deepEqual(paragraphs[i].image,{inlineData:{mimeType:'image/png',data:'AA=='}});
  assert.equal('image' in hint,false);
 }
 const formula=parts.flatMap(part=>part.text?JSON.parse(part.text).type==='protected-formula'?[JSON.parse(part.text)]:[]:[]);assert.equal(formula.length,1);assert.equal(formula[0].replaceWith,input[1].inlines[0].token);
 assert.match(payload.systemInstruction.parts[0].text,/IMAGE is authoritative/u);
 assert.equal(payload.generationConfig.responseMimeType,'application/json');
 assert.deepEqual(payload.generationConfig.responseJsonSchema.required,['blocks','warnings']);
 assert.deepEqual(result.blocks,corrected());assert.deepEqual(result.warnings,['术语需核对。']);
 assert.deepEqual(result.usage,{prompt:23,output:17,thinking:0,total:40,requests:1,cacheHits:0});assert.equal(result.model,model);
 assert.deepEqual(input,before);
});

test('Block OCR sends no separate crop for a formula labeled inside the paragraph image and restores a copied label',async t=>{
 const input=blocks();input[1].inlines.push({token:'@@PDF_INLINE_1@@',label:'@1',box:[120,110,150,125],image:png,text:'c',width:30,height:15});input[1].inlines[0].label='@0';input[1].source+=' @@PDF_INLINE_1@@';
 const calls=mockGeneration(t,{blocks:[corrected()[0],{id:'p4-b1',text:'向量 @@PDF_INLINE_0@@ 的模 @1。'}],warnings:[]});
 const result=await recognizePdfBlocks(aiEnv,input),parts=calls[0].body.contents[0].parts;
 assert.equal(parts.length,4);assert.equal(parts.filter(part=>part.inlineData).length,2);
 assert.ok(parts.every(part=>!part.text||JSON.parse(part.text).type!=='protected-formula'));
 assert.deepEqual(JSON.parse(parts[2].text).formulaRegions,[{token:'@@PDF_INLINE_0@@',box:[80,110,110,125],label:'@0'},{token:'@@PDF_INLINE_1@@',box:[120,110,150,125],label:'@1'}]);
 assert.equal(result.blocks[1].text,'向量 @@PDF_INLINE_0@@ 的模 @@PDF_INLINE_1@@。');
});

// The machine OCR text each test block keeps when its reading fails (its sourceHint, formula token once).
const machine={'p4-b0':'Tesseract 猜错 SPACE vector','p4-b1':'向量 @@PDF_INLINE_0@@ 的模。'};
const kept=(id,ocrKept)=>({id,text:machine[id],ocrKept});

test('Block OCR never assigns text by position: a missing, doubled or unknown answer leaves its block the machine text',async t=>{
 let answer;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return generationResponse({blocks:answer,warnings:[]});});
 for(const [invalid,expected] of [
  [[corrected()[0]],[corrected()[0],kept('p4-b1','unread')]],
  [[corrected()[0],corrected()[0]],[kept('p4-b0','unread'),kept('p4-b1','unread')]],
  [[corrected()[0],{id:'p999-b0',text:'Invented block'}],[corrected()[0],kept('p4-b1','unread')]],
  [{not:'a list'},[kept('p4-b0','unread'),kept('p4-b1','unread')]]
 ]){answer=invalid;assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks())).blocks,expected,JSON.stringify(invalid));}
 assert.equal(calls,4,'one call each: a failed block is never asked for again here');
});

test('An OCR answer that fails a check keeps the machine text of the blocks concerned, names them and reports the billed call',async t=>{
 let answer;t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:['Ảnh hơi mờ.']}));
 const spent={prompt:23,output:17,thinking:0,total:40,requests:1,cacheHits:0},three=[...blocks(),{id:'p4-b2',source:'第三段文字。',image:png,box:[20,180,220,240],fontSize:12}];
 for(const [invalid,input,codes,note] of [
  [[corrected()[0],{id:'p4-b1',text:'向量 a=b 的模。'}],blocks(),[undefined,'formula'],/^Trang 4 · đoạn 1: bản đọc của Gemini làm mất hoặc thừa mã công thức\. Đoạn này giữ chữ OCR máy/u],
  // Most of a call back empty: each empty strip keeps its machine text; the strip that was read keeps its reading.
  [[{id:'p4-b0',text:''},{id:'p4-b1',text:' '},{id:'p4-b2',text:'第三段文字。'}],three,['empty','empty',undefined],/^Trang 4 · đoạn 0, Trang 4 · đoạn 1: Gemini không thấy chữ trong ảnh\. Các đoạn này giữ chữ OCR máy/u],
  // Two strips read into each other's blocks: neither reading is kept.
  [[{id:'p4-b0',text:'向量的模长度。'},{id:'p4-b1',text:'Tesseract 猜错 SPACE vector'}],[{...blocks()[0]},{...blocks()[1],source:'向量的模长度。',inlines:[]}],['mixed','mixed'],/lẫn chữ giữa các đoạn/u]
 ]){
  answer=invalid;const result=await recognizePdfBlocks(aiEnv,input);
  assert.deepEqual(result.blocks.map(block=>block.ocrKept),codes,JSON.stringify(invalid));assert.match(result.warnings[0],note);assert.equal(result.warnings.at(-1),'Ảnh hơi mờ.');
  assert.deepEqual(result.usage,spent);
  for(const [index,block] of result.blocks.entries())if(block.ocrKept)assert.equal(block.text,input[index].source.trim(),'the machine text, never the failed reading');
 }
});

test('Block OCR keeps the machine OCR text of a strip Gemini reads as empty and accepts a re-cased ID',async t=>{
 let answer;t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:['Ảnh mờ.']}));
 answer=[{id:'P4-B0 ',text:corrected()[0].text},{id:'p4-b1',text:'  '}];
 const result=await recognizePdfBlocks(aiEnv,blocks());
 assert.deepEqual(result.blocks,[corrected()[0],kept('p4-b1','empty')]);assert.match(result.warnings[0],/^Trang 4 · đoạn 1: Gemini không thấy chữ trong ảnh/u);assert.equal(result.warnings[1],'Ảnh mờ.');
 // A hint without any letter or digit becomes the unreadable mark, still carrying the block's formula token once.
 const marks=blocks();marks[1].source='. , @@PDF_INLINE_0@@';answer=[corrected()[0],{id:'p4-b1',text:''}];
 assert.equal((await recognizePdfBlocks(aiEnv,marks)).blocks[1].text,'[□] @@PDF_INLINE_0@@');
});

test('Block OCR keeps the machine text of a block whose reading loses, repeats or invents a formula token',async t=>{
 let answer;
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:[]}));
 for(const text of ['向量 a=b 的模。','@@PDF_INLINE_0@@ @@PDF_INLINE_0@@','@@PDF_INLINE_0@@ @@PDF_INLINE_99@@']){
  answer=[corrected()[0],{id:'p4-b1',text}];assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks())).blocks,[corrected()[0],kept('p4-b1','formula')],text);
 }
 answer=[{id:'p4-b0',text:'中文 @@PDF_INLINE_0@@'},{...corrected()[1]}];
 assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks())).blocks,[kept('p4-b0','formula'),corrected()[1]]);
 answer=corrected();assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks())).blocks,corrected());
});

test('A refused, cut-off or unreadable OCR call keeps the machine text of every block of the call and reports what it cost; quota and key errors still fail',async t=>{
 let reply;const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(String(url));return reply();});
 const billed=(finishReason,total=500)=>()=>Response.json({candidates:[{finishReason}],usageMetadata:{promptTokenCount:total,candidatesTokenCount:0,totalTokenCount:total}});
 for(const [finishReason,code,note] of [['RECITATION','refused',/trùng khớp nguyên văn với nội dung có bản quyền/u],['SAFETY','refused',/bộ lọc an toàn/u],['OTHER','refused',/Gemini không trả bản đọc\./u],['MAX_TOKENS','truncated',/bị cắt vì vượt giới hạn độ dài/u]]){
  reply=billed(finishReason);const result=await recognizePdfBlocks(aiEnv,blocks());
  assert.deepEqual(result.blocks,[kept('p4-b0',code),kept('p4-b1',code)],finishReason);
  assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/^Trang 4 · đoạn 0, Trang 4 · đoạn 1: /u);assert.match(result.warnings[0],note);
  assert.equal(result.usage.total,500);assert.equal(result.usage.requests,1);assert.doesNotMatch(result.warnings[0],/Gemini từ chối|Khóa Gemini/u);
 }
 // An answer that stays unreadable is retried by generate (each attempt billed), then kept as machine text.
 calls.length=0;reply=()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'không phải JSON'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}});
 const malformed=await recognizePdfBlocks(aiEnv,blocks());assert.deepEqual(malformed.blocks.map(block=>block.ocrKept),['malformed','malformed']);assert.equal(malformed.usage.requests,3);assert.equal(calls.length,3);
 // A quota, a refused key or an overloaded Gemini is not about these images: nothing is kept and the call fails.
 reply=()=>Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel'}]},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'60s'}]}},{status:429});
 await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks()),error=>error.code==='quota_minute');
 reply=()=>Response.json({error:{message:'API key not valid'}},{status:400});
 await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks()),error=>error.code==='gemini_key');
});

test('Block OCR validates image type, duplicate input IDs, six-image limit and 4 MB limit before model calls',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Invalid input must not reach Gemini');});
 const invalidSets=[
  [],
  Array.from({length:7},(_,i)=>({...blocks()[0],id:`p4-b${i}`})),
  [blocks()[0],blocks()[0]],
  [{...blocks()[0],image:'data:image/jpeg;base64,AA=='}],
  [{...blocks()[0],image:'data:image/png;base64,not-base64!'}],
  [{...blocks()[0],image:`data:image/png;base64,${'A'.repeat(4*1024*1024)}`}]
 ];
 for(const invalid of invalidSets)await assert.rejects(()=>recognizePdfBlocks(aiEnv,invalid));
 assert.equal(calls,0);
});

test('OCR route uses only stored owner OCR blocks and the student key, updates text without changing geometry or images',async t=>{
 const {env,FILES}=environment(),prior=document();await FILES.put(manifestKey(reader),JSON.stringify(prior));
 const calls=mockGeneration(t,{blocks:[corrected()[1]],warnings:[]}),writesBefore=FILES.writes.length;
 const response=await ocrRoute(env,body({blockIds:['p4-b1'],blocks:[{id:'p4-b1',source:'attacker hint',image:'attacker image'}]}));
 assert.equal(response.status,200);
 const result=await response.json();
 assert.equal(result.document.ocrCorrectedVersion,0);assert.equal(result.document.pages[0].blocks[1].source,corrected()[1].text);
 assert.equal(result.document.pages[0].blocks[1].text,'向量 a = b 的模。');assert.equal(result.document.pages[0].blocks[1].ocrCorrected,true);
 assert.deepEqual(result.document.pages[0].blocks[0],prior.pages[0].blocks[0]);
 assert.deepEqual(result.document.pages[1],prior.pages[1]);
 const changed=result.document.pages[0].blocks[1],original=prior.pages[0].blocks[1];
 for(const key of Object.keys(original).filter(key=>!['source','text'].includes(key)))assert.deepEqual(changed[key],original[key]);
 assert.equal(result.document.pages[0].background,prior.pages[0].background);assert.equal(result.document.pages[0].original,prior.pages[0].original);
 assert.equal(calls[0].options.headers['x-goog-api-key'],studentKey);assert.match(calls[0].url,/gemini-3\.6-flash:generateContent$/u);
 assert.equal(JSON.parse(calls[0].body.contents[0].parts[0].text).sourceHint,original.source);
 assert.doesNotMatch(JSON.stringify(calls),/server-key|attacker hint|attacker image/u);
 assert.equal(FILES.writes.length,writesBefore+1);assert.equal(FILES.writes.at(-1).key,manifestKey(reader));
 assert.doesNotMatch(FILES.writes.map(write=>storedText(write.value)).join('\n'),/student-ocr-key|server-key/u);assert.doesNotMatch(JSON.stringify(result),/student-ocr-key|server-key/u);
});

// The rule: a scanned block is handled once an OCR call returned for it, read by Gemini or kept with its machine text
// because its reading failed (ocrKept); both are stored as ocrCorrected, so no client asks for it again by itself. The
// document is corrected (ocrCorrectedVersion 1) once every block of its scanned pages is handled. A call that fails for
// another reason (quota, key, network) handles nothing.
test('OCR route marks the document corrected once every OCR block is handled, a block kept after a failed reading included, and persists no API key',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));
 let answer=[corrected()[0]];
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:['Đã đối chiếu ảnh.']}));
 let response=await ocrRoute(env,body({blockIds:['p4-b0']})),result=await response.json();
 assert.equal(result.document.ocrCorrectedVersion,0);assert.equal(result.document.pages[0].blocks[0].ocrCorrected,true);
 // The second block's reading drops its formula: it keeps its machine text, is named, and the document is complete.
 answer=[{id:'p4-b1',text:'向量 a=b 的模。'}];response=await ocrRoute(env,body({blockIds:['p4-b1'],slim:true}));result=await response.json();
 assert.equal(response.status,200);assert.equal(result.ocrCorrectedVersion,1);
 assert.deepEqual(result.blocks.map(({id,source,ocrCorrected})=>({id,source,ocrCorrected})),[{id:'p4-b1',source:machine['p4-b1'],ocrCorrected:true}]);
 assert.match(result.warnings[0],/^Trang 4 · đoạn 1: bản đọc của Gemini làm mất hoặc thừa mã công thức/u);assert.deepEqual(result.ocrWarnings,['Đã đối chiếu ảnh.',result.warnings[0],'Đã đối chiếu ảnh.']);
 const saved=JSON.parse(storedText(FILES.values.get(manifestKey(reader))));
 assert.equal(saved.ocrCorrectedVersion,1);assert.equal(saved.pages[0].blocks[1].source,machine['p4-b1']);assert.equal(saved.pages[0].blocks[1].text,'向量 a = b 的模。');
 assert.equal(saved.pages[1].blocks[0].ocrCorrected,undefined,'a native-text page is not OCR');assert.deepEqual(saved.ocrWarnings,result.ocrWarnings);
 assert.doesNotMatch(FILES.writes.map(write=>storedText(write.value)).join('\n'),/student-ocr-key|server-key/u);
});

test('OCR route cannot read another student asset or select native-text and foreign block IDs',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(other),JSON.stringify(document()));let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('No unauthorized model calls');});
 const writesBefore=FILES.writes.length,response=await ocrRoute(env,body());
 assert.equal(response.status,404);assert.deepEqual(FILES.reads,[manifestKey(reader)]);assert.equal(FILES.writes.length,writesBefore);
 await FILES.put(manifestKey(reader),JSON.stringify(document()));const ownWrites=FILES.writes.length;
 for(const blockIds of [['p5-b0'],['p999-b0'],['p4-b0','p999-b0']])await assert.rejects(()=>ocrRoute(env,body({blockIds})));
 assert.equal(calls,0);assert.equal(FILES.writes.length,ownWrites);
});

test('OCR route validates supplied key, Flash model and block selection before generating or persisting',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));const writesBefore=FILES.writes.length;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Invalid request must not reach Gemini');});
 for(const invalid of [
  {apiKey:''},{apiKey:'too-short'},{apiKey:'student\n'+studentKey},{apiKey:'a'.repeat(501)},
  {model:'gemini-3.6-pro'},{model:'../../other-model'},
  {blockIds:[]},{blockIds:['p4-b0','p4-b0']},{blockIds:Array.from({length:7},(_,i)=>`p4-b${i}`)}
 ])await assert.rejects(()=>ocrRoute(env,body(invalid)));
 assert.equal(calls,0);assert.equal(FILES.writes.length,writesBefore);
});

test('OCR route stores the readings that pass and the machine text of a block whose answer was lost or lost its formula, never the bad reading',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));const writesBefore=FILES.writes.length;
 let answer=[corrected()[0]];
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:[]}));
 const stored=()=>JSON.parse(storedText(FILES.values.get(manifestKey(reader)))).pages[0].blocks.map(({source,ocrCorrected})=>({source,ocrCorrected}));
 let response=await ocrRoute(env,body());assert.equal(response.status,200);assert.match((await response.json()).warnings[0],/^Trang 4 · đoạn 1: Gemini không trả bản đọc dùng được/u);
 assert.deepEqual(stored(),[{source:corrected()[0].text,ocrCorrected:true},{source:machine['p4-b1'],ocrCorrected:true}]);
 answer=[corrected()[0],{id:'p4-b1',text:'向量 a=b 的模。'}];response=await ocrRoute(env,body());assert.equal(response.status,200);
 assert.deepEqual(stored(),[{source:corrected()[0].text,ocrCorrected:true},{source:machine['p4-b1'],ocrCorrected:true}]);
 assert.equal(FILES.writes.length,writesBefore+2);assert.doesNotMatch(storedText(FILES.values.get(manifestKey(reader))),/a=b 的模/u);
});

test('OCR route keeps a refused call\'s blocks as machine text and reports its tokens; a quota error stores nothing',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));let reply;
 t.mock.method(globalThis,'fetch',async()=>reply());
 reply=()=>Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel'}]}]}},{status:429});
 const writes=FILES.writes.length;await assert.rejects(()=>ocrRoute(env,body()),error=>error.code==='quota_day');assert.equal(FILES.writes.length,writes);
 reply=()=>Response.json({candidates:[{finishReason:'RECITATION'}],usageMetadata:{promptTokenCount:1800,candidatesTokenCount:0,totalTokenCount:1800}});
 const response=await ocrRoute(env,body({slim:true})),result=await response.json();
 assert.equal(response.status,200);assert.equal(result.usage.total,1800);assert.equal(result.ocrCorrectedVersion,1);
 assert.deepEqual(result.blocks.map(({id,source,ocrCorrected})=>({id,source,ocrCorrected})),[{id:'p4-b0',source:machine['p4-b0'],ocrCorrected:true},{id:'p4-b1',source:machine['p4-b1'],ocrCorrected:true}]);
 assert.match(result.warnings[0],/^Trang 4 · đoạn 0, Trang 4 · đoạn 1: Gemini không trả bản đọc vì trùng khớp nguyên văn với nội dung có bản quyền\. Các đoạn này giữ chữ OCR máy/u);
});

test('A block kept with its machine text carries the reason in the stored manifest and the slim answer until a later call reads it',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));let reply;
 t.mock.method(globalThis,'fetch',async()=>reply());
 const stored=()=>JSON.parse(storedText(FILES.values.get(manifestKey(reader)))).pages[0].blocks.map(b=>b.ocrKept);
 reply=()=>Response.json({candidates:[{finishReason:'SAFETY'}],usageMetadata:{promptTokenCount:900,candidatesTokenCount:0,totalTokenCount:900}});
 let result=await (await ocrRoute(env,body({slim:true}))).json();
 assert.deepEqual(result.blocks.map(b=>b.ocrKept),['refused','refused']);assert.deepEqual(stored(),['refused','refused']);
 // An explicit re-read: the block read this time loses its mark, the one whose reading drops a formula gets its own.
 reply=()=>generationResponse({blocks:[corrected()[0],{id:'p4-b1',text:'向量 a=b 的模。'}],warnings:[]});
 result=await (await ocrRoute(env,body({slim:true}))).json();
 assert.deepEqual(result.blocks.map(b=>b.ocrKept),[undefined,'formula']);assert.deepEqual(stored(),[undefined,'formula']);
 assert.equal(result.blocks[0].source,corrected()[0].text);assert.equal(result.blocks[1].source,machine['p4-b1']);
});

test('OCR route recovers an unavailable Flash model using only the supplied student key',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).includes('gemini-2.5-flash:generateContent'))return Response.json({error:{message:'Model not available'}},{status:404});
  if(String(url).includes('/models?'))return Response.json({models:[{name:'models/gemini-3.6-flash',displayName:'Available Flash',supportedGenerationMethods:['generateContent']}]});
  return generationResponse({blocks:corrected(),warnings:[]});
 });
 const response=await ocrRoute(env,body({model:'gemini-2.5-flash'})),result=await response.json();
 assert.equal(response.status,200);assert.equal(result.model,'gemini-3.6-flash');assert.equal(calls.length,3);
 assert.ok(calls.every(call=>call.options.headers['x-goog-api-key']===studentKey));
 assert.doesNotMatch(JSON.stringify(calls),/server-key/u);assert.doesNotMatch(FILES.writes.map(write=>storedText(write.value)).join('\n'),/student-ocr-key|server-key/u);
});

test('Force-cloning a current extraction gives OCR correction a new private asset without altering saved history assets, sending the stored original beside the blocks read for good',async t=>{
 const {env,FILES}=environment();env.PDF_LAYOUT_SERVICE_URL='https://pdf.example.test/v1/';env.PDF_LAYOUT_SERVICE_TOKEN='service-secret';
 const prior=document();prior.ocrCorrectedVersion=1;prior.pages[0].blocks.forEach(block=>{block.ocrCorrected=true;});
 const oldManifest=JSON.stringify(prior),original='%PDF-1.7\nselected pages 4 and 5';
 const originalKey=`study/${reader.id}/pdf-layout/${assetId}/original.pdf`;
 await FILES.put(manifestKey(reader),oldManifest);await FILES.put(originalKey,original);const writesBefore=FILES.writes.length,calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),options,body:await new Response(options.body).text()});
  const fresh=document();fresh.totalPages=2;fresh.extractionVersion=LAYOUT_VERSION;
  fresh.pages.forEach((page,i)=>{page.number=i+1;page.blocks.forEach(block=>{block.id=block.id.replace(/^p\d+-/u,`p${i+1}-`);});});
  return Response.json({document:fresh,originalPdfBase64:btoa(original)});
 });
 const path=base+'/refresh',response=await pdfLayoutRoute(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,forceClone:true,apiKey:studentKey})}),env,path,reader),result=await response.json();
 assert.equal(response.status,201);assert.notEqual(result.assetId,assetId);assert.equal(result.document.totalPages,88);
 assert.deepEqual(result.document.pages.map(page=>page.number),[4,5]);assert.deepEqual(result.document.pages.flatMap(page=>page.blocks.map(block=>block.id)),['p4-b0','p4-b1','p5-b0']);
 assert.equal(result.document.ocrCorrectedVersion,undefined);assert.ok(result.document.pages[0].blocks.every(block=>block.ocrCorrected===undefined));
 assert.equal(FILES.values.get(manifestKey(reader)),oldManifest);assert.equal(FILES.values.get(originalKey),original);
 const writes=FILES.writes.slice(writesBefore);assert.equal(writes.length,2);assert.ok(writes.every(write=>write.key.startsWith(`study/${reader.id}/pdf-layout/${result.assetId}/`)));
 // The stored original goes as base64 in a JSON body with the range and the blocks Gemini read for good (extract.py
 // known): a service that finds them again keeps their reading; this one finds none, so every block is read again.
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers['X-PDF-All-Pages'],'1');const sent=JSON.parse(calls[0].body);assert.equal(atob(sent.pdfBase64),original);assert.equal(sent.pages,'1-2');
 assert.deepEqual(sent.known,[{page:1,ocr:true,blocks:[{id:'p4-b0',box:[20,20,220,80],inlines:[]},{id:'p4-b1',box:[20,100,220,160],inlines:[[80,110,110,125]]}]},{page:2,ocr:false,blocks:[{id:'p5-b0',box:[20,20,220,80],source:'原生 PDF 文本。'}]}]);
 assert.doesNotMatch(JSON.stringify(result),/student-ocr-key|service-secret/u);assert.doesNotMatch(writes.map(write=>storedText(write.value)).join('\n'),/student-ocr-key|service-secret/u);
});

test('Block OCR instruction states line, notation and visible-text rules for any subject and stays compact',async t=>{
 const calls=mockGeneration(t);await recognizePdfBlocks(aiEnv,blocks());
 const instruction=calls[0].body.systemInstruction.parts[0].text;
 for(const rule of [/IMAGE is authoritative/u,/one visual row on one output line/u,/verse line/u,/H₂O, Fe³⁺/u,/LaTeX inside \\\( \\\) only for stacked fractions \\frac\{a\}\{b\}, roots \\sqrt\{x\}, vectors \\vec\{AB\}/u,/every vector arrow, in prose as in lists/u,/never replace or drop visible text outside the boxes \(words, operators, =, brackets, punctuation/u,/punctuation included, belongs to its token/u])assert.match(instruction,rule);
 // A system of equations or a matrix has one drawable form (the renderer's environments: display math on a row of its
 // own, inline math inside a sentence), scripts are braced and relations named, so "S_{n-1} … n\geq 2" is never
 // improvised as a bare \begin{cases} or "n 2 2".
 for(const rule of [/brace system or matrix as one \\\[…\\\] on its own row, \\\(…\\\) inside a sentence \(only cases, aligned, array, matrix, pmatrix, bmatrix, vmatrix\)/u,/in LaTeX brace each script \(S_\{n-1\}\)/u,/use \\geq \\leq \\neq/u])assert.match(instruction,rule);
 // 2,440 characters (about 610 tokens) with every call: those rules cost about 35 tokens more than the 2,300 before.
 assert.doesNotMatch(instruction,/not LaTeX code|Join visual line wraps/u);assert.ok(instruction.length<=2440,`${instruction.length} characters are sent with every OCR call`);
});

// Real Gemini OCR output from two scanned exercise rows (p7-b8, p7-b10 of the vector chapter sample).
test('OCR math normalization delimits bare LaTeX and joins math split by a hyphen into one expression with a real minus',()=>{
 for(const [input,output] of [
  [String.raw`(2) @@PDF_INLINE_2@@ \frac{1}{2} (@@PDF_INLINE_3@@`,String.raw`(2) @@PDF_INLINE_2@@ \(\frac{1}{2}\) (@@PDF_INLINE_3@@`],
  [String.raw`(3) \(\overrightarrow{AF}\)-\frac{1}{2} @@PDF_INLINE_4@@`,String.raw`(3) \(\overrightarrow{AF}−\frac{1}{2}\) @@PDF_INLINE_4@@`],
  [String.raw`(1) \(\overrightarrow{AA'}\)-\(\overrightarrow{CB}\);`,String.raw`(1) \(\overrightarrow{AA'}−\overrightarrow{CB}\);`],
  [String.raw`x=\frac{\sqrt{2}}{2}，\sqrt[3]{8}=2`,String.raw`x=\(\frac{\sqrt{2}}{2}\)，\(\sqrt[3]{8}\)=2`],
  [String.raw`\overline{AB}_1 与 \hat{x}`,String.raw`\(\overline{AB}_1\) 与 \(\hat{x}\)`],
  [String.raw`\vec{a}^2-\vec{b}^2 和 \\frac{1}{2}`,String.raw`\(\vec{a}^2−\vec{b}^2\) 和 \(\frac{1}{2}\)`],
  ['AB\u20d7 - CD\u20d7',String.raw`\(\vec{AB} − \vec{CD}\)`]
 ])assert.equal(normalizeOcrMath(input),output);
});

test('OCR math normalization leaves hyphens in words, names and dates, prose dashes and malformed LaTeX untouched',()=>{
 for(const text of [
  String.raw`2. 如图, E, F 分别是长方体 ABCD-A'B'C'D' 的棱 AB, CD 的中点.`,
  String.raw`=x(\(\overrightarrow{AB}\)+\(\overrightarrow{BC}\)+\(\overrightarrow{CC'}\))`,
  '与向量a长度相等而方向相反的向量，叫做a的相反向量，记为-a．','DNA-RNA 杂交','1949-1953 年','鲁迅——《呐喊》','Na⁺ 与 Cl⁻ 结合成 NaCl',
  String.raw`\(\vec{a}\)—\(\vec{b}\)`,String.raw`\(x\)-axis`,'$a$-$b$',
  String.raw`\frac{1}{2`,String.raw`\frac{}{2}`,String.raw`C:\Users\bar\x`,String.raw`\frac{@@PDF_INLINE_1@@}{2}`
 ])assert.equal(normalizeOcrMath(text),text);
});

test('Block OCR output delimits bare LaTeX and spaces glued formula tokens only when their boxes are apart on one row',async t=>{
 const inline=(n,box)=>({token:`@@PDF_INLINE_${n}@@`,label:`@${n}`,box,image:png,text:'',width:box[2]-box[0],height:box[3]-box[1]});
 // p7-b6 geometry: @1 and @2 are 3.6pt apart, @2 and @3 share an edge (one row split by Tesseract).
 const input=[
  {id:'p7-b6',source:'@@PDF_INLINE_1@@，@@PDF_INLINE_2@@@@PDF_INLINE_3@@ 因为',image:png,box:[84.9,353,336.4,388.9],fontSize:9.8,inlines:[inline(1,[92.7,353.3,150.2,365.6]),inline(2,[153.8,353.3,211.4,368.9]),inline(3,[211.4,353.3,336.4,368.9])]},
  {id:'p7-b10',source:'(1) @@PDF_INLINE_1@@\n@@PDF_INLINE_2@@',image:png,box:[60.5,708.6,527.6,774.5],fontSize:9,inlines:[inline(1,[89.4,709.5,166.1,732.3]),inline(2,[200,740,260,760])]}
 ];
 mockGeneration(t,{blocks:[{id:'p7-b6',text:'@@PDF_INLINE_1@@@@PDF_INLINE_2@@@@PDF_INLINE_3@@ 因为'},{id:'p7-b10',text:String.raw`(1) @@PDF_INLINE_1@@@@PDF_INLINE_2@@ \frac{1}{2}`}],warnings:[]});
 const result=await recognizePdfBlocks(aiEnv,input);
 assert.equal(result.blocks[0].text,'@@PDF_INLINE_1@@ @@PDF_INLINE_2@@@@PDF_INLINE_3@@ 因为');
 assert.equal(result.blocks[1].text,String.raw`(1) @@PDF_INLINE_1@@@@PDF_INLINE_2@@ \(\frac{1}{2}\)`,'boxes on different rows are not spaced');
});

test('OCR math normalization delimits a bare environment the renderer draws: display alone on its line, inline in a sentence, never a command inside it',()=>{
 for(const [input,output] of [
  [String.raw`\begin{cases}x+y=1\\x-y=3\end{cases}`,String.raw`\[\begin{cases}x+y=1\\x-y=3\end{cases}\]`],
  [String.raw`解方程组 \begin{cases}x+y=1\\x-y=3\end{cases} 得`,String.raw`解方程组 \(\begin{cases}x+y=1\\x-y=3\end{cases}\) 得`],
  // the \left…\right fences go with it, and the \frac inside is never delimited on its own
  [`因为\n${String.raw`\left\{\begin{array}{l}\frac{1}{2}x\\y\geq 0\end{array}\right.`}\n所以`,`因为\n${String.raw`\[\left\{\begin{array}{l}\frac{1}{2}x\\y\geq 0\end{array}\right.\]`}\n所以`],
  [String.raw`a_{n}=\begin{pmatrix}1&0\\0&1\end{pmatrix}，`,String.raw`a_{n}=\(\begin{pmatrix}1&0\\0&1\end{pmatrix}\)，`],
  // a row that starts with \frac keeps its break (three backslashes); two before a command are JSON escaping as before
  [String.raw`\begin{cases}1,&x>0\\\frac{1}{2},&x\leq 0\end{cases}`,String.raw`\[\begin{cases}1,&x>0\\\frac{1}{2},&x\leq 0\end{cases}\]`]
 ])assert.equal(normalizeOcrMath(input),output);
 // already delimited, an environment the renderer does not draw, or one holding a formula image: as written
 for(const text of [String.raw`\[\begin{cases}a\\b\end{cases}\]`,String.raw`$\begin{matrix}a&b\end{matrix}$`,String.raw`\begin{tabular}{cc}a&\frac{1}{2}\end{tabular}`,String.raw`\begin{cases}@@PDF_INLINE_1@@\\b\end{cases}`])assert.equal(normalizeOcrMath(text),text);
});

test('OCR math normalization makes display math holding an environment inline when it shares its line with other text',()=>{
 const R=String.raw,piecewise=R`f(x)=\begin{cases}\log_2 x, & x>0\\3^x, & x\leq 0\end{cases}`;
 for(const [input,output] of [
  // an exercise row of any subject read as the prompt once asked: the system inside the sentence becomes inline, as the
  // same system written bare would (the renderer would set \[…\] as a block the row's box cannot hold)
  [R`已知函数 \[${piecewise}\]，则 f(f(\frac{1}{4})) 的值为____`,R`已知函数 \(${piecewise}\)，则 f(f(\(\frac{1}{4}\))) 的值为____`],
  [R`矩阵 $$A=\begin{pmatrix}1&2\\3&4\end{pmatrix}$$ 的逆矩阵`,R`矩阵 \(A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\) 的逆矩阵`],
  [R`\[\left\{\begin{array}{l}x+y=1\\x-y=3\end{array}\right.\]，解得 x=2`,R`\(\left\{\begin{array}{l}x+y=1\\x-y=3\end{array}\right.\)，解得 x=2`],
  // alone on its row (other rows around it) it stays display math
  [R`解方程组${'\n'}\[\begin{cases}x+y=1\\x-y=3\end{cases}\]${'\n'}得 x=2`,R`解方程组${'\n'}\[\begin{cases}x+y=1\\x-y=3\end{cases}\]${'\n'}得 x=2`]
 ])assert.equal(normalizeOcrMath(input),output);
 // display math without an environment, an environment the renderer does not draw, and inline math stay as written
 for(const text of [R`由 \[x^2+y^2=1\] 得`,R`如下 \[\begin{tabular}{cc}a&b\end{tabular}\] 所示`,R`解 \(\begin{cases}a\\b\end{cases}\) 得`])assert.equal(normalizeOcrMath(text),text);
 // the page sets the sentence's system inline, on the row's own line, never as a block of its own
 const html=renderMathText(normalizeOcrMath(R`已知函数 \[${piecewise}\]，则`));
 assert.doesNotMatch(html,/math-display/u);assert.match(html,/class="math-inline"/u);assert.match(html,/math-env-cases/u);
});

test('OCR math normalization takes the \\left…\\right fences with an environment only as a pair, as translation shielding does',()=>{
 // the |…| of a determinant holds more than the matrix: both fences stay text, so neither is cut from its partner
 assert.equal(normalizeOcrMath(String.raw`\det\left|A-\lambda\begin{matrix}1&0\\0&1\end{matrix}\right|=0`),String.raw`\det\left|A-\lambda\(\begin{matrix}1&0\\0&1\end{matrix}\)\right|=0`);
 assert.equal(normalizeOcrMath(String.raw`\left\{\begin{matrix}a\\b\end{matrix} 和 c`),String.raw`\left\{\(\begin{matrix}a\\b\end{matrix}\) 和 c`);
 assert.equal(normalizeOcrMath(String.raw`\left(\begin{matrix}a&b\end{matrix}\right)`),String.raw`\[\left(\begin{matrix}a&b\end{matrix}\right)\]`);
});

test('OCR math normalization takes an environment nested in one of its own name whole, and leaves one never closed as text',async t=>{
 const block=String.raw`\begin{matrix}\begin{matrix}a&b\end{matrix}&c\\d&e\end{matrix}`;
 for(const [input,output] of [
  // a block matrix: the first \end{matrix} closes the inner one, and the outer one runs on to the last
  [`矩阵\n${block}\n的秩`,`矩阵\n\\[${block}\\]\n的秩`],
  [String.raw`已知 \begin{array}{c}\begin{array}{cc}1&2\end{array}\\3\end{array} 所以`,String.raw`已知 \(\begin{array}{c}\begin{array}{cc}1&2\end{array}\\3\end{array}\) 所以`],
  // with its fences, and a \frac after the inner one is still inside the outer one
  [String.raw`\left|\begin{matrix}\begin{matrix}1\end{matrix}&\frac{1}{2}\end{matrix}\right|`,String.raw`\[\left|\begin{matrix}\begin{matrix}1\end{matrix}&\frac{1}{2}\end{matrix}\right|\]`],
  // a cases left open (a cut-off reading) is text: the words after it stay out of math, the closed one after them is math
  [String.raw`\begin{cases}x>0 再看 \begin{cases}a\\b\end{cases}`,String.raw`\begin{cases}x>0 再看 \(\begin{cases}a\\b\end{cases}\)`]
 ])assert.equal(normalizeOcrMath(input),output);
 // one holding a formula image stays as written, and nothing inside it is delimited
 const image=String.raw`\begin{matrix}\begin{matrix}@@PDF_INLINE_1@@\end{matrix}&\frac{1}{2}\end{matrix}`;assert.equal(normalizeOcrMath(image),image);
 // read by Gemini: stored whole, not doubtful, and drawn as a grid with no \begin, \end, & or \\ printed
 mockGeneration(t,{blocks:[{id:'p2-b1',text:`矩阵\n${block}\n的秩`}],warnings:[]});
 const [read]=(await recognizePdfBlocks(aiEnv,[{id:'p2-b1',source:'矩阵 的秩',image:png,box:[20,20,220,80],fontSize:12}])).blocks;
 assert.equal(read.text,`矩阵\n\\[${block}\\]\n的秩`);assert.equal(read.ocrDoubt,undefined);
 const visible=html=>html.replace(/<[^>]+>/gu,'').replace(/&(?:lt|gt|quot|#39);/gu,' ').replace(/&amp;/gu,'&');
 for(const bare of [true,false]){const shown=visible(renderMathText(read.text,{bare}));assert.doesNotMatch(shown,/\\begin|\\end|&|\\\\/u,shown);assert.match(shown,/^矩阵\s*a\s*b\s*c\s*d\s*e\s*的秩$/u,shown);}
});

test('A reading that passes the checks but looks doubtful is used, marked ocrDoubt and named in the warnings unless asked not to',async t=>{
 const inline=n=>({token:`@@PDF_INLINE_${n}@@`,label:`@${n}`,box:[40*n,30,40*n+30,45],image:png,text:'x',width:30,height:15});
 const block=(id,source,count=0)=>({id,source,image:png,box:[20,20,220,80],fontSize:12,inlines:Array.from({length:count},(_,i)=>inline(i+1))});
 const [t1,t2]=['@@PDF_INLINE_1@@','@@PDF_INLINE_2@@'];
 // Tesseract hints and Gemini readings: ",_;" stuck to a formula (the S_{n-1} line of the screenshot), TeX the page cannot
 // draw, two formulas swapped, most of the Chinese dropped; then a hint with two misread characters around its formula,
 // and a system of equations the renderer draws.
 const input=[block('p4-b1',`显然 ${t1}，而${t2}，于是`,2),block('p4-b2','表格如下：'),block('p4-b3',`已知 ${t1}，求证 ${t2} 成立`,2),block('p4-b4','两个向量所在的直线平行或重合，这些向量叫做平行向量。'),block('p4-b5',`癌量 ${t1} 的槙。`,1),block('p4-b6','求解方程组')];
 const readings=[`显然 ${t1}，而S${t2},_;(n 2 2, 于是`,String.raw`表格如下：\begin{tabular}{cc}a&b\end{tabular}`,`已知 ${t2}，求证 ${t1} 成立`,'两个向量所在的直线。',`向量 ${t1} 的模。`,String.raw`求解方程组 \begin{cases}x+y=1\\x-y=3\end{cases}`];
 mockGeneration(t,{blocks:input.map((b,i)=>({id:b.id,text:readings[i]})),warnings:['Ảnh mờ.']});
 const result=await recognizePdfBlocks(aiEnv,input);
 assert.deepEqual(result.blocks.map(b=>b.ocrDoubt),['glued','tex','hint','han',undefined,undefined]);
 assert.ok(result.blocks.every(b=>b.ocrKept===undefined),'a doubtful reading is still the reading');assert.equal(result.blocks[0].text,readings[0]);
 assert.equal(result.blocks[5].text,String.raw`求解方程组 \(\begin{cases}x+y=1\\x-y=3\end{cases}\)`,'an environment the renderer draws is not doubtful');
 assert.deepEqual(result.warnings.map(w=>w.split(':')[0]),['Trang 4 · đoạn 2','Trang 4 · đoạn 1','Trang 4 · đoạn 3','Trang 4 · đoạn 4','Ảnh mờ.']);
 for(const note of result.warnings.slice(0,4)){assert.match(note,/có thể bị đọc sai; hãy đối chiếu với trang gốc\.$/u);assert.doesNotMatch(note,/giữ chữ OCR máy/u,'never taken for a note on kept machine text');}
 assert.deepEqual((await recognizePdfBlocks(aiEnv,input,[],{noteDoubts:false})).warnings,['Ảnh mờ.']);
 // A fill-in line or one mark beside a formula is ordinary text, and a hint with Latin junk for Chinese leaves the count alone.
 for(const [hint,reading,count] of [[`则 ${t1}`,`则 ${t1}______`,1],[`则 ${t1}，`,`则 ${t1}；`,1],['iii | ll .. ,','1.1 空间向量及其运算',0]])assert.equal(readingDoubt(reading,block('p4-b9',hint,count)),null,reading);
 // The TeX names the block translation reports too; a path and an escaped & are text.
 const found=undrawableTex(String.raw`\begin{tabular}{c}a\end{tabular} x &= y\\ z \begin{cases}1\\2\end{cases}`);
 for(const name of [String.raw`\begin{tabular}`,String.raw`\\`,'&'])assert.ok(found.includes(name),`${name} in ${found}`);
 assert.deepEqual(undrawableTex(String.raw`C:\Users\Lan 和 A\&B，\[\begin{aligned}a&=b\\c&=d\end{aligned}\]`),[]);
});

test('Only TeX the page prints as written counts as undrawable: rows inside math, a braced \\\\, a lone \\left and prices are drawn or prose',()=>{
 const R=String.raw;
 // Drawn: a two-line limit, rows of delimited math (gathered, aligned), columns of an inline formula, a bare \substack,
 // a \left without its \right (its delimiter alone); prose with prices and "Q&A" (Pandoc's $…$ rule), a path, \&.
 for(const text of [R`\[\sum_{\substack{1\leq i\leq n\\ i\neq j}} a_{ij}\]`,R`\[x+y=1 \\ x-y=3\]`,R`\[S_n &= a_1+a_2 \\ &= 2a_1+d\]`,R`\(a&b\)`,R`由 \sum_{\substack{0<i<m\\0<j<n}} a_{ij} 得`,R`\(\left( x+1\)`,'Chi phí R&D là $5 tỷ, phần Q&A là $2 tỷ.',R`C:\Users\Lan 和 A\&B，\[\begin{aligned}a&=b\\c&=d\end{aligned}\]`]){
  assert.deepEqual(undrawableTex(text),[],text);assert.equal(readingDoubt(text,{source:text}),null,text);
 }
 // Drawn too: rows and columns of delimited math that also holds environments (the opener comes first, so the renderer
 // sets the formula's own rows round them), a delimited environment alone, and row spacing (\\[2pt]) in or out of math.
 for(const text of [R`已知矩阵 \[ A &= \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix} \\ B &= \begin{pmatrix} 5 & 6 \\ 7 & 8 \end{pmatrix} \]`,R`\[ D &= \begin{vmatrix} a & b \\ c & d \end{vmatrix} \\ &= ad-bc \]`,R`\[ f(x) = \begin{cases} x, & x \geq 0 \\ -x, & x < 0 \end{cases} \\ g(x) = x^2 \]`,R`求解方程组 \(\begin{cases}x+y=1\\x-y=3\end{cases}\)`,R`\[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]`,R`\begin{aligned} a &= 1 \\[2pt] b &= 2 \end{aligned}`,R`\[ a \\[4pt] b \]`,R`echo $$ 输出当前进程号`]){
  assert.deepEqual(unsupportedMath(text),[],text);assert.deepEqual(undrawableTex(text),[],text);assert.equal(readingDoubt(text,{source:text}),null,text);
 }
 // Printed as written: rows and columns typed outside math, a row break after a group that closed or in one that never
 // does, an aligned row between escaped dollars (no math), a row after a bare environment, and a \( or \[ left open or a
 // \) or \] never opened (the page shows the delimiter; a $$ left open is prose, echo $$).
 for(const [text,names] of [[R`a &= b \\ c &= d`,[R`\\`,'&']],[R`{a} x+y=1 \\ x-y=3`,[R`\\`]],[R`{a \\ b`,[R`\\`]],[R`\$x &= 1\$`,['&']],[R`\begin{pmatrix}1&2\end{pmatrix} \\ x &= 3`,[R`\\`,'&']],[R`求 \(x^{2}+1 的最小值。`,[R`\(`]],[R`求 x^{2}+1\) 的最小值。`,[R`\)`]],[R`已知 \[ S_{n}=n^{2} 求 a_{n}。`,[R`\[`]],[R`已知 S_{n}=n^{2} \] 求 a_{n}。`,[R`\]`]],[R`已知 \(\begin{cases} x=1 \\ y=2 \end{cases} 求 x`,[R`\(`]]]){
  const found=undrawableTex(text);for(const name of names)assert.ok(found.includes(name),`${name} in ${text}: ${found}`);assert.equal(readingDoubt(text,{source:text}),'tex',text);
 }
});

test('A row break in a braced group of bare text counts unless the page draws it: \\substack does, a bare {…}, \\boxed, \\underset or a script prints it as written',()=>{
 const R=String.raw,printed=text=>/(?:^|[^\\])\\\\(?![A-Za-z])/u.test(renderMathText(text).replace(/<[^>]*>/gu,''));
 // Drawn: the rows of a \substack, under a sum or a limit or on its own.
 for(const text of [R`由 \sum_{\substack{0<i<m\\0<j<n}} a_{ij} 得`,R`由 \lim_{\substack{x\to 0 \\ y\to 0}} f(x,y) 得`,R`由 \substack {i<n \\ j<m} 得`]){
  assert.equal(printed(text),false,text);assert.deepEqual(undrawableTex(text),[],text);assert.equal(readingDoubt(text,{source:text}),null,text);
 }
 // Printed as written: a system typed in bare braces, rows boxed, stacked, in a script or under a limit, a group inside
 // \substack's own, and a \substack a formula splits (the page reads the text on each side of a formula on its own).
 for(const text of [R`已知 {x+y=1 \\ x-y=3} 求 x`,R`由 \boxed{x \\ y} 得`,R`由 \underset{x \\ y}{\max} f 得`,R`由 \overset{a \\ b}{=} 得`,R`由 x^{a \\ b} 得`,R`由 \lim_{x \\ y} f 得`,R`由 \substack{{a \\ b}} 得`,R`由 \substack{a \(x\) \\ b} 得`]){
  assert.equal(printed(text),true,text);assert.ok(undrawableTex(text).includes(R`\\`),`${text}: ${undrawableTex(text)}`);assert.equal(readingDoubt(text,{source:text}),'tex',text);
 }
});

test('Block OCR gives a call that thinks more room for its answer: the output cap grows with the thinking level',async t=>{
 const calls=mockGeneration(t),cap=1024+4*blocks().reduce((n,b)=>n+b.source.length,0);
 for(const level of ['minimal','low','medium','high'])await recognizePdfBlocks({...aiEnv,GEMINI_THINKING:level},blocks());
 assert.deepEqual(calls.map(call=>call.body.generationConfig.maxOutputTokens),[cap,cap+2048,cap+8192,cap+16384]);
 assert.deepEqual(calls.map(call=>call.body.generationConfig.thinkingConfig),['minimal','low','medium','high'].map(thinkingLevel=>({thinkingLevel})));
});

test('The OCR route reasons as the session\'s mode says, and every mode, Tiết kiệm included, reads blocks again with its own reasoning',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));
 const calls=mockGeneration(t),cap=1024+4*blocks().reduce((n,b)=>n+b.source.length,0),config=()=>calls.at(-1).body.generationConfig;
 // Thinking tokens count against the cap (ai.js thinkingHeadroom); the levels are the modes' own (translation-modes.js).
 const headroom={minimal:0,low:2048,medium:8192,high:16384},expect=(level,label)=>{assert.deepEqual(config().thinkingConfig,{thinkingLevel:level},label);assert.equal(config().maxOutputTokens,cap+headroom[level],label);};
 // The hint stays the machine text once a block is read, so every call below has the same cap before thinking.
 for(const mode of [undefined,'turbo',...MODES]){assert.equal((await ocrRoute(env,body({mode,slim:true}))).status,200,String(mode));expect(modeProfile(mode).ocrThinking,String(mode));}
 assert.equal(modeProfile('turbo').ocrThinking,modeProfile('economy').ocrThinking,'an unknown mode is economy');
 // A reading again costs tokens only where a block needs it, so every mode has one (no mode, or an unknown one, is economy).
 for(const mode of [undefined,'turbo',...MODES]){assert.ok(modeProfile(mode).reread,String(mode));assert.equal((await ocrRoute(env,body({mode,reread:true,slim:true}))).status,200,String(mode));expect(modeProfile(mode).reread.thinking,String(mode));}
});

test('A re-read is sent the machine text as its hint, never replaces a reading with a failed one, and counts itself; a good one replaces text and marks',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));
 let answer;const calls=mockGeneration(t,()=>({blocks:answer,warnings:[]}));
 const stored=()=>JSON.parse(storedText(FILES.values.get(manifestKey(reader)))).pages[0].blocks;
 // A mode that reads every doubtful block again (Kỹ hơn and Kỹ nhất do; the others only those far from the strip's Chinese).
 const mode=MODES.find(id=>modeProfile(id).reread?.doubt===true);assert.equal(modeProfile('premium').reread?.doubt,true);
 const read=async extra=>(await (await ocrRoute(env,body({mode,slim:true,...extra}))).json());
 const marks=result=>result.blocks.map(b=>[b.source,b.ocrDoubt,b.ocrKept,b.ocrRereads]);
 // The first reading of p4-b1 has ",_;" stuck to its formula: used, and doubtful; the mode reads it again, so no note yet.
 const doubtful='向量 @@PDF_INLINE_0@@,_; 的模。';answer=[corrected()[0],{id:'p4-b1',text:doubtful}];
 let result=await read();
 assert.deepEqual(marks(result),[[corrected()[0].text,undefined,undefined,undefined],[doubtful,'glued',undefined,undefined]]);assert.deepEqual(result.warnings,[]);
 assert.deepEqual(stored().map(b=>b.ocrHint),[machine['p4-b0'],machine['p4-b1']],'the machine text is kept for a re-read');
 // A re-read whose answer loses the formula keeps the earlier reading and its doubt, and says so; only the count grows.
 answer=[corrected()[0],{id:'p4-b1',text:'向量 的模。'}];result=await read({reread:true});
 assert.deepEqual(marks(result),[[corrected()[0].text,undefined,undefined,1],[doubtful,'glued',undefined,1]]);
 assert.deepEqual(result.warnings,['Trang 4 · đoạn 1: bản đọc của Gemini làm mất hoặc thừa mã công thức. Đoạn này giữ bản đọc trước đó của Gemini; hãy đối chiếu với trang gốc.']);
 const sent=calls.at(-1).body.contents[0].parts.filter(part=>part.text&&JSON.parse(part.text).id).map(part=>JSON.parse(part.text).sourceHint);
 assert.deepEqual(sent,[machine['p4-b0'],machine['p4-b1']],'a re-read is compared with what Tesseract saw, not with the reading it checks');
 // A re-read never makes a block worse: one doubtful in its own way replaces a doubtful reading, carrying that doubt, now
 // named; a clean reading whose re-read looks doubtful stays as it was, and that re-read is not named.
 const tabular=String.raw` \begin{tabular}{c}a\end{tabular}`,other=`${corrected()[1].text}${tabular}`;
 answer=[{id:'p4-b0',text:`空间向量${tabular}`},{id:'p4-b1',text:other}];result=await read({reread:true});
 assert.deepEqual(marks(result),[[corrected()[0].text,undefined,undefined,2],[other,'tex',undefined,2]]);
 assert.deepEqual(result.warnings,['Trang 4 · đoạn 1: bản đọc của Gemini còn mã công thức chưa dựng được. Đoạn này có thể bị đọc sai; hãy đối chiếu với trang gốc.']);
 // A good re-read replaces the text and clears the doubt.
 answer=corrected();result=await read({reread:true});
 assert.deepEqual(marks(result),[[corrected()[0].text,undefined,undefined,3],[corrected()[1].text,undefined,undefined,3]]);assert.deepEqual(result.warnings,[]);
 assert.deepEqual(stored().map(b=>[b.ocrDoubt,b.ocrRereads,b.ocrHint]),[[undefined,3,machine['p4-b0']],[undefined,3,machine['p4-b1']]]);
});

// A sheet is read whole, so a re-read of one block of it reads the others of the sheet too (sheet-mates).
const sheetDocument=()=>({version:1,extractionVersion:3,totalPages:88,pages:[{number:7,width:600,height:800,ocr:true,background:png,original:png,
 blocks:[['p7-b1','在平面向量的学习中我们学习了向量的投影类似地在空间向量的投影有什么意义'],['p7-b2','选择恰当的向量表示问题中的几何元素通过向量运算得出几何元素的关系是解决立体几何问题的常用方法']].map(([id,source],i)=>({id,source,text:source,box:[20,20+60*i,520,60+60*i],fontSize:12,inlines:[],ocrSheet:'p7-s1',ocrLabel:`#${i+1}`})),
 ocrSheets:[{id:'p7-s1',image:png,strips:[{blockId:'p7-b1',label:'#1',box:[74,12,474,68]},{blockId:'p7-b2',label:'#2',box:[74,90,474,140]}]}]}]});
test('A re-read of one block of a sheet never makes its sheet-mates worse: only the blocks chosen (rereadIds) count it and are named',async t=>{
 const {env,FILES}=environment(),[hint1,hint2]=sheetDocument().pages[0].blocks.map(b=>b.source);await FILES.put(manifestKey(reader),JSON.stringify(sheetDocument()));
 let answer;const calls=mockGeneration(t,()=>({blocks:answer,warnings:[]}));
 const stored=()=>JSON.parse(storedText(FILES.values.get(manifestKey(reader)))).pages[0].blocks;
 const read=async extra=>(await (await ocrRoute(env,body({mode:'premium',slim:true,blockIds:['p7-b1','p7-b2'],...extra}))).json());
 const marks=result=>result.blocks.map(b=>[b.id,b.source.length,b.ocrDoubt,b.ocrRereads]);
 // First reading: p7-b1 clean, p7-b2 drops most of its Chinese (doubtful, 'han').
 answer=[{id:'p7-b1',text:hint1},{id:'p7-b2',text:hint2.slice(0,5)}];await read();
 // The browser chose p7-b2; this time Gemini drops most of p7-b1 and reads p7-b2 well.
 answer=[{id:'p7-b1',text:hint1.slice(0,3)},{id:'p7-b2',text:hint2}];let result=await read({reread:true,rereadIds:['p7-b2']});
 assert.deepEqual(marks(result),[['p7-b1',hint1.length,undefined,undefined],['p7-b2',hint2.length,undefined,1]],'p7-b1 keeps its clean reading and is not counted');
 assert.deepEqual(result.warnings,[]);assert.deepEqual(stored().map(b=>[b.source,b.ocrDoubt,b.ocrRereads]),[[hint1,undefined,undefined],[hint2,undefined,1]]);
 assert.equal(calls.length,2);
 // An older page names no rereadIds: every block named counts, and a clean reading still stays clean.
 await FILES.put(manifestKey(reader),JSON.stringify(sheetDocument()));answer=[{id:'p7-b1',text:hint1},{id:'p7-b2',text:hint2.slice(0,5)}];await read();
 answer=[{id:'p7-b1',text:hint1.slice(0,3)},{id:'p7-b2',text:hint2}];result=await read({reread:true});
 assert.deepEqual(marks(result),[['p7-b1',hint1.length,undefined,1],['p7-b2',hint2.length,undefined,1]]);
 // rereadIds must name blocks of the call, each once, before any call or write.
 const made=calls.length,writes=FILES.writes.length;
 for(const rereadIds of [[],['p7-b3'],['p7-b2','p7-b2'],'p7-b2'])await assert.rejects(()=>read({reread:true,rereadIds}),/không hợp lệ/u,JSON.stringify(rereadIds));
 assert.equal(calls.length,made);assert.equal(FILES.writes.length,writes);
});

test('A re-read of blocks kept with their machine text that fails again changes nothing but its count; one of blocks never read stores them handled',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));
 let reply;t.mock.method(globalThis,'fetch',async()=>reply());
 const refused=()=>Response.json({candidates:[{finishReason:'RECITATION'}],usageMetadata:{promptTokenCount:900,candidatesTokenCount:0,totalTokenCount:900}});
 const mode=MODES.find(id=>modeProfile(id).reread),read=async extra=>(await (await ocrRoute(env,body({mode,slim:true,...extra}))).json());
 // A re-read may name blocks no call read yet: kept, they are handled like any reading that failed.
 reply=refused;let result=await read({reread:true});
 assert.deepEqual(result.blocks.map(b=>[b.source,b.ocrKept,b.ocrCorrected,b.ocrRereads]),[[machine['p4-b0'],'refused',true,1],[machine['p4-b1'],'refused',true,1]]);
 assert.equal(result.ocrCorrectedVersion,1);
 reply=()=>Response.json({candidates:[{finishReason:'SAFETY'}],usageMetadata:{promptTokenCount:900,candidatesTokenCount:0,totalTokenCount:900}});
 result=await read({reread:true});
 assert.deepEqual(result.blocks.map(b=>[b.source,b.ocrKept,b.ocrRereads]),[[machine['p4-b0'],'refused',2],[machine['p4-b1'],'refused',2]]);
 assert.equal(result.usage.total,900);assert.match(result.warnings[0],/bộ lọc an toàn/u);
 // A later reading clears the mark; the count stays.
 reply=()=>generationResponse({blocks:corrected(),warnings:[]});result=await read();
 assert.deepEqual(result.blocks.map(b=>[b.source,b.ocrKept,b.ocrRereads]),[[corrected()[0].text,undefined,2],[corrected()[1].text,undefined,2]]);
});

test('A formula whose machine text holds a $ (OCR often reads S as $) goes into the block text as written, never as a replacement pattern',()=>{
 const inline={token:'@@PDF_INLINE_0@@',image:png,width:24,height:12,text:"$'(x) = $$ + $& - $`"};
 const document={version:1,pages:[{number:4,width:600,height:800,ocr:true,background:png,original:png,blocks:[{id:'p4-b0',source:'Tesseract 猜错',image:png,box:[20,20,220,80],fontSize:12,inlines:[inline]}]}]};
 applyOcrReadings(document,{blocks:[{id:'p4-b0',text:'函数 @@PDF_INLINE_0@@ 的导数。'}]});
 assert.equal(document.pages[0].blocks[0].text,"函数 $'(x) = $$ + $& - $` 的导数。");assert.equal(document.pages[0].blocks[0].source,'函数 @@PDF_INLINE_0@@ 的导数。');
});

// A strip's ink says how much Chinese it holds (extract.py hanCells): three rows of 12 characters each.
const rows=['向量是既有大小又有方向的','量我们用有向线段表示向量','箭头所指的方向表示其方向'];
test('A reading with far fewer Chinese characters than its strip shows or its machine hint holds is doubted (han); junk Han it shares nothing with is no measure',()=>{
 const strip=(hint,hanCells)=>({id:'p4-b1',source:hint,...(hanCells===undefined?{}:{hanCells})});
 // The strip's cells err low (a bold heading shows none, a framed panel half its glyphs): the hint is weighed too. A
 // heading read with no Chinese, or a paragraph a row short, is doubted although the cells alone would pass it.
 for(const cells of [0,undefined])assert.equal(readingDoubt('Section 2 Water cycle',strip('第二节 水的循环',cells)),'han',`hanCells ${cells}`);
 assert.equal(readingDoubt('汉'.repeat(40),strip('汉'.repeat(75),34)),'han');assert.equal(readingDoubt('汉'.repeat(70),strip('汉'.repeat(75),34)),null);
 // One row of three lost: 24 of 36. Measured against the hint alone (a manifest without hanCells) that passes (two thirds).
 assert.equal(readingDoubt(`${rows[0]}\n${rows[2]}`,strip(rows.join('\n'),36)),'han');assert.equal(readingDoubt(`${rows[0]}\n${rows[2]}`,strip(rows.join('\n'))),null);
 // A heading strip of two characters read as a digit, or as nothing Chinese: the hint ("7)") could not tell.
 for(const reading of ['1','—','[□][□]'])assert.equal(readingDoubt(reading,strip('7)',2)),'han',reading);
 assert.equal(readingDoubt('1',strip('7)')),null);assert.equal(readingDoubt('A',strip('A',1)),null,'one cell is no text');
 // Tesseract junk full of Chinese (a figure's dots read as 一二三…) no longer makes a good reading doubtful: the strip is the
 // measure. Without hanCells that junk made the same reading doubtful.
 assert.equal(readingDoubt('探究',strip('一二三四五六七八九十十一',2)),null);assert.equal(readingDoubt('探究',strip('一二三四五六七八九十十一')),'han');
 assert.equal(readingDoubt('点',strip('一二三四五六七八九十十一',2)),'han');
 // A repetition is still doubted against the hint.
 assert.equal(readingDoubt('向量'.repeat(120),strip(rows.join(''),36)),'han');
});

test('Tiết kiệm reads once more a strip Gemini returned empty and one that lost a row; a block still unreadable keeps the page\'s pixels (keepPixels)',async t=>{
 const scan=()=>({version:1,extractionVersion:3,totalPages:88,pages:[{number:4,width:600,height:800,ocr:true,background:png,original:png,blocks:[
  {id:'p4-b1',source:'7)',image:png,box:[20,20,120,50],fontSize:14,hanCells:2},
  {id:'p4-b2',source:rows.join('\n'),image:png,box:[20,60,520,160],fontSize:12,hanCells:36}]}]});
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(scan()));
 let answer;const calls=mockGeneration(t,()=>({blocks:answer,warnings:[]}));
 const read=async extra=>(await (await ocrRoute(env,body({mode:'economy',slim:true,blockIds:['p4-b1','p4-b2'],...extra}))).json());
 const marks=result=>result.blocks.map(b=>[b.source,b.ocrKept,b.ocrDoubt,b.keepPixels,b.ocrRereads]);
 // The heading comes back empty: it keeps the machine text "7)", nothing Chinese, so the page keeps its pixels there. The
 // paragraph lost a row: used, and doubtful; Tiết kiệm reads it again, so it is not named yet.
 answer=[{id:'p4-b1',text:''},{id:'p4-b2',text:`${rows[0]}\n${rows[2]}`}];let result=await read();
 assert.deepEqual(marks(result),[['7)','empty',undefined,true,undefined],[`${rows[0]}\n${rows[2]}`,undefined,'han',undefined,undefined]]);
 assert.deepEqual(result.warnings,['Trang 4 · đoạn 1: Gemini không thấy chữ trong ảnh. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.']);
 // The reading again (low thinking) reads both: the heading is text again, the paragraph whole.
 answer=[{id:'p4-b1',text:'探究'},{id:'p4-b2',text:rows.join('\n')}];result=await read({reread:true,rereadIds:['p4-b1','p4-b2']});
 assert.deepEqual(calls.at(-1).body.generationConfig.thinkingConfig,{thinkingLevel:modeProfile('economy').reread.thinking});
 assert.deepEqual(marks(result),[['探究',undefined,undefined,undefined,1],[rows.join('\n'),undefined,undefined,undefined,1]]);assert.deepEqual(result.warnings,[]);
 // Still empty when read again: the heading keeps its pixels and says so; it is never read again by the browser (ocrRereads).
 await FILES.put(manifestKey(reader),JSON.stringify(scan()));answer=[{id:'p4-b1',text:''},{id:'p4-b2',text:rows.join('\n')}];await read();
 answer=[{id:'p4-b1',text:'[□][□]'},{id:'p4-b2',text:rows.join('\n')}];result=await read({reread:true,rereadIds:['p4-b1']});
 assert.deepEqual(marks(result)[0],['[□][□]',undefined,'han',true,1],'a reading of only unreadable marks keeps the pixels too');
 const stored=JSON.parse(storedText(FILES.values.get(manifestKey(reader)))).pages[0].blocks;
 assert.deepEqual(stored.map(b=>[b.source,b.keepPixels]),[['[□][□]',true],[rows.join('\n'),undefined]]);
 assert.deepEqual(applyOcrReadings(scan(),{blocks:[{id:'p4-b1',text:'探究'}]}).pages[0].blocks[0].keepPixels,undefined,'a reading with Chinese clears it');
 // Nothing to translate is told by the strip's cells where the manifest has them, by [□] alone where it does not; a reading
 // of formulas alone keeps its crops, which are the strip's own pixels.
 assert.deepEqual([['[□]',undefined],['7)',undefined],['7)',2],['—',2],['1',1],['@@PDF_INLINE_0@@',4],['@@PDF_INLINE_0@@，',4],['@@PDF_INLINE_0@@ [□]',4]].map(([text,cells])=>unreadable(text,cells)),[true,false,true,true,false,false,false,true]);
});
