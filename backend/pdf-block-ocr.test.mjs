import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizePdfBlocks,normalizeOcrMath} from './pdf-block-ocr.js';
import {pdfLayoutRoute} from './pdf-layout.js';

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
class MemoryFiles{
 constructor(){this.values=new Map();this.reads=[];this.writes=[];}
 async put(key,value,options){this.values.set(key,value);this.writes.push({key,value,options});}
 async get(key){this.reads.push(key);const value=this.values.get(key);return value===undefined?null:{body:value,json:async()=>JSON.parse(value)};}
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

test('Block OCR rejects missing, duplicate and unknown result IDs instead of assigning text by position',async t=>{
 let answer;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return generationResponse({blocks:answer,warnings:[]});});
 for(const invalid of [
  [corrected()[0]],
  [corrected()[0],corrected()[0]],
  [corrected()[0],{id:'p999-b0',text:'Invented block'}],
  [corrected()[0],{id:'p4-b1',text:''}]
 ]){answer=invalid;await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks()));}
 assert.equal(calls,4);
});

test('Block OCR requires every supplied formula token exactly once and forbids invented formula tokens',async t=>{
 let answer;
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:[]}));
 for(const text of ['向量 a=b 的模。','@@PDF_INLINE_0@@ @@PDF_INLINE_0@@','@@PDF_INLINE_0@@ @@PDF_INLINE_99@@']){
  answer=[corrected()[0],{id:'p4-b1',text}];await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks()));
 }
 answer=[{id:'p4-b0',text:'中文 @@PDF_INLINE_0@@'},{...corrected()[1]}];
 await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks()));
 answer=corrected();assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks())).blocks,corrected());
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
 assert.doesNotMatch(JSON.stringify(FILES.writes),/student-ocr-key|server-key/u);assert.doesNotMatch(JSON.stringify(result),/student-ocr-key|server-key/u);
});

test('OCR route marks the document corrected only after every OCR block succeeds and persists no API key',async t=>{
 const {env,FILES}=environment();await FILES.put(manifestKey(reader),JSON.stringify(document()));
 let selected=0;
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:[corrected()[selected]],warnings:['Đã đối chiếu ảnh.']}));
 let response=await ocrRoute(env,body({blockIds:['p4-b0']})),result=await response.json();
 assert.equal(result.document.ocrCorrectedVersion,0);assert.equal(result.document.pages[0].blocks[0].ocrCorrected,true);
 selected=1;response=await ocrRoute(env,body({blockIds:['p4-b1']}));result=await response.json();
 assert.equal(result.document.ocrCorrectedVersion,1);assert.equal(result.document.pages[1].blocks[0].ocrCorrected,undefined);
 const saved=JSON.parse(FILES.values.get(manifestKey(reader)));assert.deepEqual(saved,result.document);
 assert.deepEqual(saved.ocrWarnings,['Đã đối chiếu ảnh.','Đã đối chiếu ảnh.']);
 assert.doesNotMatch(JSON.stringify(FILES.writes),/student-ocr-key|server-key/u);
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

test('OCR route never persists partial corrected state when the model loses an ID or formula token',async t=>{
 const {env,FILES}=environment(),prior=JSON.stringify(document());await FILES.put(manifestKey(reader),prior);const writesBefore=FILES.writes.length;
 let answer=[corrected()[0]];
 t.mock.method(globalThis,'fetch',async()=>generationResponse({blocks:answer,warnings:[]}));
 await assert.rejects(()=>ocrRoute(env,body()));
 answer=[corrected()[0],{id:'p4-b1',text:'向量 a=b 的模。'}];await assert.rejects(()=>ocrRoute(env,body()));
 assert.equal(FILES.writes.length,writesBefore);assert.equal(FILES.values.get(manifestKey(reader)),prior);
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
 assert.doesNotMatch(JSON.stringify(calls),/server-key/u);assert.doesNotMatch(JSON.stringify(FILES.writes),/student-ocr-key|server-key/u);
});

test('Force-cloning a current extraction gives OCR correction a new private asset without altering saved history assets',async t=>{
 const {env,FILES}=environment();env.PDF_LAYOUT_SERVICE_URL='https://pdf.example.test/v1/';env.PDF_LAYOUT_SERVICE_TOKEN='service-secret';
 const prior=document();prior.ocrCorrectedVersion=1;prior.pages[0].blocks.forEach(block=>{block.ocrCorrected=true;});
 const oldManifest=JSON.stringify(prior),original='%PDF-1.7\nselected pages 4 and 5';
 const originalKey=`study/${reader.id}/pdf-layout/${assetId}/original.pdf`;
 await FILES.put(manifestKey(reader),oldManifest);await FILES.put(originalKey,original);const writesBefore=FILES.writes.length,calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),options,body:await new Response(options.body).text()});
  const fresh=document();fresh.totalPages=2;
  fresh.pages.forEach((page,i)=>{page.number=i+1;page.blocks.forEach(block=>{block.id=block.id.replace(/^p\d+-/u,`p${i+1}-`);});});
  return Response.json({document:fresh,originalPdfBase64:btoa(original)});
 });
 const path=base+'/refresh',response=await pdfLayoutRoute(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,forceClone:true,apiKey:studentKey})}),env,path,reader),result=await response.json();
 assert.equal(response.status,201);assert.notEqual(result.assetId,assetId);assert.equal(result.document.totalPages,88);
 assert.deepEqual(result.document.pages.map(page=>page.number),[4,5]);assert.deepEqual(result.document.pages.flatMap(page=>page.blocks.map(block=>block.id)),['p4-b0','p4-b1','p5-b0']);
 assert.equal(result.document.ocrCorrectedVersion,undefined);assert.ok(result.document.pages[0].blocks.every(block=>block.ocrCorrected===undefined));
 assert.equal(FILES.values.get(manifestKey(reader)),oldManifest);assert.equal(FILES.values.get(originalKey),original);
 const writes=FILES.writes.slice(writesBefore);assert.equal(writes.length,2);assert.ok(writes.every(write=>write.key.startsWith(`study/${reader.id}/pdf-layout/${result.assetId}/`)));
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers['X-PDF-Pages'],'1-2');assert.equal(calls[0].body,original);
 assert.doesNotMatch(JSON.stringify(result),/student-ocr-key|service-secret/u);assert.doesNotMatch(JSON.stringify(writes),/student-ocr-key|service-secret/u);
});

test('Block OCR instruction states line, notation and visible-text rules for any subject and stays compact',async t=>{
 const calls=mockGeneration(t);await recognizePdfBlocks(aiEnv,blocks());
 const instruction=calls[0].body.systemInstruction.parts[0].text;
 for(const rule of [/IMAGE is authoritative/u,/one visual row on one output line/u,/verse line/u,/H₂O, Fe³⁺/u,/LaTeX inside \\\( \\\) only for stacked fractions \\frac\{a\}\{b\}, roots \\sqrt\{x\}, vectors \\vec\{AB\}/u,/every vector arrow, in prose as in lists/u,/never replace or drop visible text outside the boxes \(words, operators, =, brackets, punctuation/u,/punctuation included, belongs to its token/u])assert.match(instruction,rule);
 assert.doesNotMatch(instruction,/not LaTeX code|Join visual line wraps/u);assert.ok(instruction.length<=2300,`${instruction.length} characters are sent with every OCR call`);
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
