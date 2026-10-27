import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {recognizePdfBlocks,ocrRequest,misassignedBlocks,SPLIT_CALLS} from './pdf-block-ocr.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {ocrImageBatches,validateLayoutDocument,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {MODES,modeProfile} from '../frontend/translation-modes.js';
import {classifyError} from '../frontend/whole-book.js';

// OCR sheets: extract.py packs the OCR crops of a scanned page into a few images, one framed strip per block with a #N
// tab, so Gemini 3 bills a few ~1,090-token images per page instead of one per block. Manifests without sheets keep
// the one-image-per-block path.
const png='data:image/png;base64,AA==',studentKey='student-ocr-key-12345678901234567890',model='gemini-3.6-flash';
const reader={id:'student-1'},assetId='11111111-1111-4111-8111-111111111111',base='/api/my/study/pdf-layout';
const manifestKey=`study/${reader.id}/pdf-layout/${assetId}/manifest.json`;
const aiEnv={GEMINI_API_KEY:studentKey,GEMINI_MODEL:model,GEMINI_THINKING:'minimal'};
const inline=(n,label)=>({token:`@@PDF_INLINE_${n}@@`,box:[80,110,110,125],image:png,text:'a=b',width:30,height:15,...(label?{label}:{})});
const block=(id,source,sheet,label,extra={})=>({id,source,text:source,box:[20,20,220,80],fontSize:12,inlines:[],ocrSheet:sheet,ocrLabel:label,...extra});
const strip=(blockId,label)=>({blockId,label,box:[74,12,474,68]});
// Real Tesseract hints and Gemini readings of the case19 pages (vector chapter, pages 7-8).
const REAL=[
 ['p7-b1','可以发现\n，如果两个向量a，\n不共线，那么癌量p 与向量a，a\n存在唯一的有序实数对(x, vy), fF','可以发现，如果两个向量 a，b 不共线，那么向量 p 与向量 a，b 共面的充要条件是存在唯一的有序实数对 (x, y)，使'],
 ['p7-b3','ii. EE, Fa G,\nHW A#%H, RF¥W EH,\nEF, EGC 共面。而由已知AD, AB, AC 共面，可以利用\n向\n量运算由AD, AB, AC 共面的表达式推\n得EH, EF,\nEG 共面的表达式.','分析：欲证 E，F，G，H 四点共面，只需证明 EH，EF，EG 共面. 而由已知 AD，AB，AC 共面，可以利用向量运算由 AD，AB，AC 共面的表达式推得 EH，EF，EG 共面的表达式.'],
 ['p7-b5','选耕恰当的向量表示\n问题\n中的几何元素，通过\n向量运算得出几何元素的\n关系，是解决\n立体几何问\n题\n的常用方法.','选择恰当的向量表示问题中的几何元素，通过向量运算得出几何元素的关系，是解决立体几何问题的常用方法.'],
 ['p7-b9','第2题)','(第 2 题)'],
 ['p8-b2','1.1.2\n空间向量的数量积运算','1.1.2 空间向量的数量积运算'],
 ['p8-b8','主平面向量的学习中，我们\n学习了向量的投影类似地，在空间，向量a 向\n量\n的投影有什么意义? 测量a 向直线Z 的投影喝? 向\n量a 向平面B 的投影呢?','在平面向量的学习中，我们学习了向量的投影. 类似地，在空间，向量 a 向向量 b 的投影有什么意义？向量 a 向直线 l 的投影呢？向量 a 向平面 β 的投影呢？']
];
const realBlocks=()=>REAL.map(([id,source])=>({id,source})),realTexts=()=>new Map(REAL.map(([id,,text])=>[id,text]));
function sheetDocument(){
 return {version:1,extractionVersion:3,totalPages:88,pages:[
  {number:7,width:600,height:800,ocr:true,background:png,original:png,blocks:[block('p7-b1',REAL[0][1],'p7-s1','#1'),block('p7-b5',REAL[2][1],'p7-s1','#2'),block('p7-b6','因为 @@PDF_INLINE_1@@ 所以','p7-s2','#3',{inlines:[inline(1,'@1')]})],
   ocrSheets:[{id:'p7-s1',image:'data:image/png;base64,U0hFRVQx',strips:[strip('p7-b1','#1'),strip('p7-b5','#2')]},{id:'p7-s2',image:'data:image/png;base64,U0hFRVQy',strips:[strip('p7-b6','#3')]}]},
  {number:8,width:600,height:800,ocr:true,background:png,original:png,blocks:[block('p8-b2',REAL[4][1],'p8-s1','#4')],ocrSheets:[{id:'p8-s1',image:'data:image/png;base64,U0hFRVQz',strips:[strip('p8-b2','#4')]}]}
 ]};
}
const generationResponse=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:2300,candidatesTokenCount:120,totalTokenCount:2420}});
function mockGeneration(t,answer){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return generationResponse(typeof answer==='function'?answer(calls):answer);});
 return calls;
}
// Manifests are stored as ASCII JSON bytes (asciiJsonBytes); values a test puts itself are strings.
const storedText=value=>typeof value==='string'?value:new TextDecoder().decode(value);
class MemoryFiles{
 constructor(){this.values=new Map();this.writes=[];}
 async put(key,value){this.values.set(key,value);this.writes.push(key);}
 async get(key){const value=this.values.get(key);return value===undefined?null:{body:value,json:async()=>JSON.parse(storedText(value)),text:async()=>storedText(value)};}
}
const ocrRoute=(env,blockIds)=>pdfLayoutRoute(new Request(`https://example.test${base}/ocr-blocks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,apiKey:studentKey,model,blockIds})}),env,base+'/ocr-blocks',reader);
async function stored(document=sheetDocument()){const FILES=new MemoryFiles();await FILES.put(manifestKey,JSON.stringify(document));return {env:{FILES,GEMINI_API_KEY:'server-key',GEMINI_MODEL:'gemini-2.5-flash'},FILES};}

test('A sheet is sent once, after a JSON map from each tab label to its block, hint and formula labels',()=>{
 const document=sheetDocument(),[first,second]=document.pages[0].ocrSheets,blocks=document.pages[0].blocks;
 blocks[2].inlines.push(inline(2));blocks[2].source+=' @@PDF_INLINE_2@@';
 const {parts,instruction}=ocrRequest(blocks,[first,second]);
 assert.deepEqual(parts.map(p=>p.inlineData?.data||JSON.parse(p.text).type||'map'),['map','U0hFRVQx','map','U0hFRVQy','protected-formula','AA==']);
 assert.deepEqual(JSON.parse(parts[0].text),{'#1':{id:'p7-b1',sourceHint:REAL[0][1]},'#2':{id:'p7-b5',sourceHint:REAL[2][1]}});
 // page coordinates mean nothing on a sheet: tokens and their @N labels only; an unlabeled formula still gets its crop
 assert.deepEqual(JSON.parse(parts[2].text),{'#3':{id:'p7-b6',sourceHint:blocks[2].source,formulaRegions:[{token:'@@PDF_INLINE_1@@',label:'@1'},{token:'@@PDF_INLINE_2@@'}]}});
 assert.deepEqual(JSON.parse(parts[4].text),{type:'protected-formula',blockId:'p7-b6',replaceWith:'@@PDF_INLINE_2@@'});
 for(const rule of [/sheet of separate framed strips/u,/blue tab #N/u,/maps each label to its strip's block/u,/text never runs across strips/u,/hidden in its strip/u,/beyond strip edges/u,/IMAGE is authoritative/u,/one visual row on one output line/u])assert.match(instruction,rule);
 assert.doesNotMatch(instruction,/Each paragraph image belongs/u);assert.ok(instruction.length<=2640,`${instruction.length} characters`);
 // a manifest without sheets keeps one paragraph image per block and the paragraph instruction
 const old=ocrRequest([{id:'p4-b0',source:'旧',image:png,box:[0,0,9,9]}]);
 assert.equal(old.parts.length,2);assert.match(old.instruction,/Each paragraph image belongs to the block ID/u);assert.equal(JSON.parse(old.parts[0].text).blockBox.length,4);
});

test('Sheet requests must cover exactly the blocks of the call, with valid labels and images, within the limits',()=>{
 const document=sheetDocument(),blocks=document.pages[0].blocks,[first,second]=document.pages[0].ocrSheets;
 for(const [list,sheets] of [
  [blocks.slice(0,2),[first,second]],[blocks,[first]],[blocks.slice(0,2),[first,first]],
  [blocks.slice(0,2),[{...first,strips:[strip('p7-b1','#1'),strip('p7-b5','#1')]}]],[blocks.slice(0,2),[{...first,strips:[strip('p7-b1','1'),strip('p7-b5','#2')]}]],
  [blocks.slice(0,2),[{...first,image:'data:image/jpeg;base64,AA=='}]],[blocks.slice(0,2),[{...first,strips:[]}]],
  [blocks.slice(0,2),Array.from({length:7},()=>first)],[Array.from({length:49},(_,i)=>({id:`p7-b${i+1}`,source:'x'})),[first]]
 ])assert.throws(()=>ocrRequest(list,sheets));
 assert.equal(OCR_LIMITS.images,6);assert.equal(OCR_LIMITS.sheetBlocks,48);
});

test('Sheet OCR maps answers to blocks, drops a copied tab label, restores @N labels and keeps token checks',async t=>{
 const document=sheetDocument(),blocks=document.pages[0].blocks,sheets=document.pages[0].ocrSheets;
 const calls=mockGeneration(t,{blocks:[{id:'p7-b6',text:'#3 因为 @1 所以'},{id:'p7-b1',text:`#1: ${REAL[0][2]}`},{id:'p7-b5',text:REAL[2][2]}],warnings:[]});
 const result=await recognizePdfBlocks(aiEnv,blocks,sheets);
 assert.equal(calls.length,1);assert.equal(calls[0].body.contents[0].parts.filter(p=>p.inlineData).length,2);
 assert.match(calls[0].body.systemInstruction.parts[0].text,/blue tab #N/u);
 // a repetition loop stops near four tokens per hint character instead of running to 32,768 output tokens
 assert.equal(calls[0].body.generationConfig.maxOutputTokens,1024+4*blocks.reduce((n,b)=>n+b.source.length,0));
 assert.deepEqual(result.blocks,[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b5',text:REAL[2][2]},{id:'p7-b6',text:'因为 @@PDF_INLINE_1@@ 所以'}]);
 assert.deepEqual(result.usage,{prompt:2300,output:120,thinking:0,total:2420,requests:1,cacheHits:0});
 // the existing ID and formula-token checks still apply to sheet answers: a block whose answer is missing, doubled or
 // lost its formula keeps its machine OCR text (ocrKept), and the other blocks keep their readings
 for(const [answer,codes] of [[[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b5',text:REAL[2][2]}],[undefined,undefined,'unread']],[[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b5',text:REAL[2][2]},{id:'p7-b6',text:'因为 a=b 所以'}],[undefined,undefined,'formula']],[[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b1',text:REAL[2][2]},{id:'p7-b6',text:'@@PDF_INLINE_1@@'}],['unread','unread',undefined]]]){
  t.mock.restoreAll();mockGeneration(t,{blocks:answer,warnings:[]});const read=await recognizePdfBlocks(aiEnv,blocks,sheets);
  assert.deepEqual(read.blocks.map(b=>b.ocrKept),codes);for(const [i,b] of read.blocks.entries())if(b.ocrKept)assert.equal(b.text,blocks[i].source,'the machine OCR text');
 }
});

test('Sheet answers that name strips by their tab labels map to those blocks; empty strips keep their machine text',async t=>{
 const document=sheetDocument(),blocks=document.pages[0].blocks,sheets=document.pages[0].ocrSheets;
 mockGeneration(t,{blocks:[{id:'#3',text:'因为 @1 所以'},{id:'#1',text:REAL[0][2]},{id:'#2',text:REAL[2][2]}],warnings:[]});
 assert.deepEqual((await recognizePdfBlocks(aiEnv,blocks,sheets)).blocks,[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b5',text:REAL[2][2]},{id:'p7-b6',text:'因为 @@PDF_INLINE_1@@ 所以'}]);
 t.mock.restoreAll();mockGeneration(t,{blocks:[{id:'p7-b1',text:''},{id:'p7-b5',text:' '},{id:'p7-b6',text:'因为 @1 所以'}],warnings:[]});
 const most=await recognizePdfBlocks(aiEnv,blocks,sheets);assert.deepEqual(most.blocks.map(b=>b.ocrKept),['empty','empty',undefined]);
 assert.deepEqual(most.blocks.map(b=>b.text),[REAL[0][1],REAL[2][1],'因为 @@PDF_INLINE_1@@ 所以']);assert.match(most.warnings[0],/^Trang 7 · đoạn 1, Trang 7 · đoạn 5: Gemini không thấy chữ trong ảnh/u);
 t.mock.restoreAll();mockGeneration(t,{blocks:[{id:'p7-b1',text:''},{id:'p7-b5',text:REAL[2][2]},{id:'p7-b6',text:'因为 @1 所以'}],warnings:[]});
 const one=await recognizePdfBlocks(aiEnv,blocks,sheets);assert.equal(one.blocks[0].text,REAL[0][1]);assert.equal(one.blocks[0].ocrKept,'empty');assert.match(one.warnings[0],/^Trang 7 · đoạn 1: /u);
});

test('An answer whose texts were swapped between strips is not returned: both blocks keep their machine text',async t=>{
 const document=sheetDocument(),blocks=document.pages[0].blocks,sheets=document.pages[0].ocrSheets;
 mockGeneration(t,{blocks:[{id:'p7-b1',text:REAL[2][2]},{id:'p7-b5',text:REAL[0][2]},{id:'p7-b6',text:'因为 @@PDF_INLINE_1@@ 所以'}],warnings:[]});
 const result=await recognizePdfBlocks(aiEnv,blocks,sheets);assert.deepEqual(result.blocks.map(b=>b.ocrKept),['mixed','mixed',undefined]);
 assert.deepEqual(result.blocks.slice(0,2).map(b=>b.text),[REAL[0][1],REAL[2][1]]);assert.match(result.warnings[0],/^Trang 7 · đoạn 1, Trang 7 · đoạn 5: bản đọc của Gemini lẫn chữ giữa các đoạn/u);
});

test('Misassignment detection compares each text with its own hint and the other blocks hints (real case19 readings)',()=>{
 const blocks=realBlocks(),texts=realTexts();
 assert.deepEqual(misassignedBlocks(blocks,texts),[],'the correct readings, even with noisy hints');
 const swapped=new Map(texts);swapped.set('p7-b1',texts.get('p8-b8'));swapped.set('p8-b8',texts.get('p7-b1'));
 assert.deepEqual(misassignedBlocks(blocks,swapped).map(f=>[f.id,f.matches]),[['p7-b1','p8-b8'],['p8-b8','p7-b1']]);
 const shifted=new Map(texts);shifted.set('p7-b3',texts.get('p7-b5'));shifted.set('p7-b5',texts.get('p7-b9'));
 assert.deepEqual(misassignedBlocks(blocks,shifted).map(f=>[f.id,f.matches]),[['p7-b3','p7-b5']]);
 const twice=new Map(texts);twice.set('p7-b5',texts.get('p8-b8'));
 assert.deepEqual(misassignedBlocks(blocks,twice).map(f=>[f.id,f.matches]),[['p7-b5','p8-b8']],'a long text written under two blocks');
 // similar wording is not a swap, even when one block's own hint is Tesseract junk
 const headings=[{id:'p4-b1',source:'iii | ll .. ,'},{id:'p4-b3',source:'1.1.1\n室间向量及其线性运算'}];
 assert.deepEqual(misassignedBlocks(headings,new Map([['p4-b1','1.1 空间向量及其运算'],['p4-b3','1.1.1 空间向量及其线性运算']])),[]);
 const captions=[{id:'p7-b9',source:'第2题)'},{id:'p8-b9',source:'(第\n2题)'}];
 assert.deepEqual(misassignedBlocks(captions,new Map([['p7-b9','(第 2 题)'],['p8-b9','(第 2 题)']])),[],'two identical captions');
 // formula tokens and LaTeX commands are not content
 assert.deepEqual(misassignedBlocks([{id:'a',source:'@@PDF_INLINE_1@@ 和 @@PDF_INLINE_2@@'},{id:'b',source:'\\(\\overrightarrow{AB}\\) 和 \\(\\overrightarrow{CD}\\)'}],new Map([['a','@@PDF_INLINE_1@@ 和 @@PDF_INLINE_2@@'],['b','\\(\\overrightarrow{AB}\\) 和 \\(\\overrightarrow{CD}\\)']])),[]);
});

test('OCR batches send whole sheets, at most six images and 48 blocks per call, and never mix sheets with paragraph images',()=>{
 const sheet=(id,count,size=10)=>({id,image:'S'.repeat(size),strips:Array.from({length:count},(_,i)=>strip(`${id}-b${i}`,`#${id.length}${i}`))});
 const blocksOf=sheets=>sheets.flatMap(s=>s.strips.map(st=>({id:st.blockId,ocrSheet:s.id,inlines:[]})));
 let sheets=Array.from({length:7},(_,i)=>sheet(`p1-s${i+1}`,3));
 assert.deepEqual(ocrImageBatches(blocksOf(sheets),undefined,sheets).map(b=>b.length),[18,3],'six sheets of 3 blocks, then one');
 sheets=[sheet('p1-s1',20),sheet('p1-s2',20),sheet('p1-s3',20)];
 assert.deepEqual(ocrImageBatches(blocksOf(sheets),undefined,sheets).map(b=>b.length),[40,20],'at most 48 blocks per call');
 sheets=[sheet('p1-s1',2,40),sheet('p1-s2',2,40),sheet('p1-s3',2,40)];
 assert.deepEqual(ocrImageBatches(blocksOf(sheets),100,sheets).map(b=>b.length),[4,2],'byte limit');
 assert.throws(()=>ocrImageBatches(blocksOf(sheets),39,sheets),/quá lớn/u);
 // a sheet with one block still to read is sent whole; its unlabeled formula crops count in the bytes
 const partial=ocrImageBatches([{id:'p1-s2-b1',ocrSheet:'p1-s2',inlines:[{image:'F'.repeat(50)}]}],100,sheets);
 assert.deepEqual(partial,[['p1-s2-b0','p1-s2-b1']]);assert.throws(()=>ocrImageBatches([{id:'p1-s2-b1',ocrSheet:'p1-s2',inlines:[{image:'F'.repeat(70)}]}],100,sheets),/quá lớn/u);
 const old=[{id:'p2-b1',image:'A'.repeat(10)},{id:'p2-b2',image:'A'.repeat(10)}];
 assert.deepEqual(ocrImageBatches([...blocksOf(sheets.slice(0,1)),...old,...blocksOf(sheets.slice(1,2))],undefined,sheets),[['p1-s1-b0','p1-s1-b1'],['p2-b1','p2-b2'],['p1-s2-b0','p1-s2-b1']]);
 assert.deepEqual(ocrImageBatches(old),[['p2-b1','p2-b2']],'manifests without sheets batch paragraph images as before');
});

test('Layout validation accepts sheets whose strips match their blocks and rejects any inconsistency',()=>{
 assert.doesNotThrow(()=>validateLayoutDocument(sheetDocument()));
 const legacy=sheetDocument();for(const page of legacy.pages){delete page.ocrSheets;for(const b of page.blocks){delete b.ocrSheet;delete b.ocrLabel;b.image=png;}}
 assert.doesNotThrow(()=>validateLayoutDocument(legacy),'manifests without sheets stay valid');
 for(const breakIt of [
  d=>{d.pages[1].ocrSheets[0].strips[0].label='#1';d.pages[1].blocks[0].ocrLabel='#1';},
  d=>{d.pages[0].blocks[0].ocrLabel='#9';},
  d=>{d.pages[0].blocks[2].ocrSheet='p7-s1';},
  d=>{d.pages[0].ocrSheets[0].strips.push(strip('p8-b2','#7'));},
  d=>{d.pages[1].ocrSheets[0].id='p7-s1';},
  d=>{d.pages[0].ocrSheets[1].image='data:image/jpeg;base64,AA==';},
  d=>{d.pages[0].ocrSheets[1].strips=[];},
  d=>{delete d.pages[1].ocrSheets;},
  d=>{d.pages[0].ocrSheets[0].strips[0].box=[5,5,1,1];}
 ]){const d=sheetDocument();breakIt(d);assert.throws(()=>validateLayoutDocument(d),/Ảnh gộp OCR/u);}
});

test('OCR route reads whole stored sheets only, sends the stored sheet images and saves every block of them',async t=>{
 const {env,FILES}=await stored(),calls=mockGeneration(t,{blocks:[{id:'p7-b1',text:REAL[0][2]},{id:'p7-b5',text:REAL[2][2]},{id:'p8-b2',text:REAL[4][2]}],warnings:[]});
 const response=await ocrRoute(env,['p7-b1','p7-b5','p8-b2']),result=await response.json();
 assert.equal(response.status,200);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].body.contents[0].parts.filter(p=>p.inlineData).map(p=>p.inlineData.data),['U0hFRVQx','U0hFRVQz']);
 assert.equal(calls[0].url.endsWith('gemini-3.6-flash:generateContent'),true);
 const blocks=result.document.pages.flatMap(p=>p.blocks);
 assert.deepEqual(blocks.filter(b=>b.ocrCorrected).map(b=>b.id),['p7-b1','p7-b5','p8-b2']);assert.equal(blocks.find(b=>b.id==='p7-b5').source,REAL[2][2]);
 assert.equal(result.document.ocrCorrectedVersion,0,'p7-b6 on sheet p7-s2 is still to read');
 assert.deepEqual(result.document.pages[0].ocrSheets,sheetDocument().pages[0].ocrSheets,'sheets are kept for a later run');
 assert.doesNotMatch(storedText(FILES.values.get(manifestKey)),/student-ocr-key|server-key/u);
});

test('OCR route rejects part of a sheet, sheets mixed with paragraph images and unknown sheets before any Gemini call',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not reach Gemini');});
 const {env,FILES}=await stored(),writes=FILES.writes.length;
 for(const ids of [['p7-b1'],['p7-b1','p7-b6'],['p7-b5','p8-b2']])await assert.rejects(()=>ocrRoute(env,ids),/không hợp lệ/u);
 const mixed=sheetDocument();mixed.pages[1].blocks.push({id:'p8-b3',source:'旧',text:'旧',box:[20,100,220,160],fontSize:12,inlines:[],image:png});
 const second=await stored(mixed);await assert.rejects(()=>ocrRoute(second.env,['p8-b2','p8-b3']),/không hợp lệ/u);
 const lost=sheetDocument();lost.pages[1].ocrSheets=[];const third=await stored(lost);await assert.rejects(()=>ocrRoute(third.env,['p8-b2']),/không hợp lệ/u);
 assert.equal(calls,0);assert.equal(FILES.writes.length,writes);
});

test('Refreshing a sheet manifest renumbers sheets, strips and block references with the stored page numbers',async t=>{
 const {env,FILES}=await stored();env.PDF_LAYOUT_SERVICE_URL='https://pdf.example.test/';env.PDF_LAYOUT_SERVICE_TOKEN='service-secret';
 await FILES.put(`study/${reader.id}/pdf-layout/${assetId}/original.pdf`,'%PDF-1.7 pages 7-8');
 t.mock.method(globalThis,'fetch',async()=>{
  const fresh=sheetDocument();fresh.totalPages=2;
  for(const [i,page] of fresh.pages.entries()){const from=`p${page.number}-`,to=`p${i+1}-`;page.number=i+1;for(const b of page.blocks){b.id=b.id.replace(from,to);b.ocrSheet=b.ocrSheet.replace(from,to);}for(const s of page.ocrSheets){s.id=s.id.replace(from,to);for(const st of s.strips)st.blockId=st.blockId.replace(from,to);}}
  return Response.json({document:fresh,originalPdfBase64:btoa('%PDF-1.7 pages 7-8')});
 });
 const response=await pdfLayoutRoute(new Request(`https://example.test${base}/refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,forceClone:true})}),env,base+'/refresh',reader),result=await response.json();
 assert.equal(response.status,201);assert.deepEqual(result.document,{...sheetDocument(),totalPages:88});
});

test('A call of several sheets that is refused or cut off is split by sheet, each half asked once more, before its blocks keep their machine text',async t=>{
 const document=sheetDocument(),blocks=document.pages.flatMap(p=>p.blocks),sheets=document.pages.flatMap(p=>p.ocrSheets),readings={'p7-b1':REAL[0][2],'p7-b5':REAL[2][2],'p7-b6':'因为 @1 所以','p8-b2':REAL[4][2]};
 const billed=(reason,total)=>Response.json({candidates:[{finishReason:reason}],usageMetadata:{promptTokenCount:total,candidatesTokenCount:0,totalTokenCount:total}});
 const read=ids=>generationResponse({blocks:ids.map(id=>({id,text:readings[id]})),warnings:['Ảnh mờ.']});
 let decide;const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body),ids=body.contents[0].parts.filter(p=>p.text&&!JSON.parse(p.text).type).flatMap(p=>Object.values(JSON.parse(p.text)).map(v=>v.id));
  calls.push({ids,cap:body.generationConfig.maxOutputTokens});return decide(ids,calls.length);
 });
 // Three sheets refused together (RECITATION of one page): page 7's two sheets are read, page 8's is refused once more.
 decide=(ids,n)=>n===1||ids.includes('p8-b2')?billed('RECITATION',500):read(ids);
 const result=await recognizePdfBlocks(aiEnv,blocks,sheets);
 assert.deepEqual(calls.map(c=>c.ids),[['p7-b1','p7-b5','p7-b6','p8-b2'],['p7-b1','p7-b5','p7-b6'],['p8-b2']]);
 assert.deepEqual(result.blocks.map(b=>[b.id,b.text,b.ocrKept]),[['p7-b1',REAL[0][2],undefined],['p7-b5',REAL[2][2],undefined],['p7-b6','因为 @@PDF_INLINE_1@@ 所以',undefined],['p8-b2',REAL[4][1],'refused']]);
 assert.deepEqual(result.usage,{prompt:500+2300+500,output:120,thinking:0,total:500+2420+500,requests:3,cacheHits:0},'every call is counted');
 assert.deepEqual(result.warnings,['Trang 8 · đoạn 2: Gemini không trả bản đọc vì trùng khớp nguyên văn với nội dung có bản quyền. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.','Ảnh mờ.']);
 assert.ok(calls[1].cap<calls[0].cap&&calls[2].cap<calls[0].cap,'each half is capped by its own hints');
 // A one-sheet call is not split; a cut-off answer is split like a refusal, and the extra calls are bounded.
 calls.length=0;decide=()=>billed('RECITATION',500);
 assert.equal((await recognizePdfBlocks(aiEnv,[blocks[3]],[sheets[2]])).blocks[0].ocrKept,'refused');assert.equal(calls.length,1);
 const six=Array.from({length:6},(_,i)=>({id:`p9-s${i+1}`,image:'data:image/png;base64,U0hFRVQx',strips:[strip(`p9-b${i+1}`,`#${i+1}`)]})),sixBlocks=six.map((s,i)=>block(`p9-b${i+1}`,`第${i+1}段`,s.id,`#${i+1}`));
 calls.length=0;decide=()=>billed('MAX_TOKENS',100);
 const capped=await recognizePdfBlocks(aiEnv,sixBlocks,six);
 assert.equal(calls.length,1+SPLIT_CALLS);assert.deepEqual(calls.map(c=>c.ids.length),[6,3,3,2,1]);
 assert.ok(capped.blocks.every(b=>b.ocrKept==='truncated'));assert.equal(capped.usage.requests,5);assert.equal(capped.warnings.length,1);
 calls.length=0;decide=(ids,n)=>n===1?billed('MAX_TOKENS',100):read(ids);
 assert.ok((await recognizePdfBlocks(aiEnv,blocks,sheets)).blocks.every(b=>!b.ocrKept));assert.equal(calls.length,3);
 // A quota stop in a half keeps what the halves before it read (paid for): the result carries those blocks, the IDs still
 // to read and the error, with every call it made counted; no call follows the stop.
 const quota=()=>Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel'}]}]}},{status:429});
 calls.length=0;decide=(ids,n)=>n===1?billed('RECITATION',500):n===2?read(ids):quota();
 const partial=await recognizePdfBlocks(aiEnv,blocks,sheets);
 assert.deepEqual(calls.map(c=>c.ids),[['p7-b1','p7-b5','p7-b6','p8-b2'],['p7-b1','p7-b5','p7-b6'],['p8-b2']]);
 assert.deepEqual(partial.blocks.map(b=>[b.id,b.text,b.ocrKept]),[['p7-b1',REAL[0][2],undefined],['p7-b5',REAL[2][2],undefined],['p7-b6','因为 @@PDF_INLINE_1@@ 所以',undefined]]);
 assert.deepEqual(partial.pending,['p8-b2']);assert.equal(partial.stop.code,'quota_day');assert.deepEqual(partial.warnings,['Ảnh mờ.']);
 assert.deepEqual([partial.usage.total,partial.usage.requests],[500+2420,2]);assert.deepEqual(partial.stop.usage,partial.usage);
 // A stop before any half decided a block still fails the request, its calls counted; so does one in the first call.
 const four=six.slice(0,4),fourBlocks=sixBlocks.slice(0,4);
 calls.length=0;decide=(ids,n)=>n<=2?billed('RECITATION',500):quota();
 await assert.rejects(()=>recognizePdfBlocks(aiEnv,fourBlocks,four),error=>error.code==='quota_day'&&error.usage.total===1000&&error.usage.requests===2);
 calls.length=0;decide=()=>quota();
 await assert.rejects(()=>recognizePdfBlocks(aiEnv,blocks,sheets),error=>error.code==='quota_day'&&error.usage.requests===0);assert.equal(calls.length,1);
});

test('A split half stopped by a quota: the route stores what the halves before it read and answers the error with those blocks, so only the rest is read again',async t=>{
 const {env,FILES}=await stored(),readings={'p7-b1':REAL[0][2],'p7-b5':REAL[2][2],'p7-b6':'因为 @1 所以','p8-b2':REAL[4][2]},calls=[];let decide;
 const minute=()=>Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'}]},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'40s'}]}},{status:429});
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body),ids=body.contents[0].parts.filter(p=>p.text&&!JSON.parse(p.text).type).flatMap(p=>Object.values(JSON.parse(p.text)).map(v=>v.id));calls.push(ids);return decide(ids,calls.length);});
 const read=ids=>generationResponse({blocks:ids.map(id=>({id,text:readings[id]})),warnings:[]});
 const call=blockIds=>pdfLayoutRoute(new Request(`https://example.test${base}/ocr-blocks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,apiKey:studentKey,model,blockIds,slim:true})}),env,base+'/ocr-blocks',reader);
 // Three sheets refused together; page 7's two sheets are then read, page 8's meets the per-minute quota (40 s).
 decide=(ids,n)=>n===1?Response.json({candidates:[{finishReason:'RECITATION'}],usageMetadata:{promptTokenCount:500,candidatesTokenCount:0,totalTokenCount:500}}):ids.includes('p8-b2')?minute():read(ids);
 const response=await call(['p7-b1','p7-b5','p7-b6','p8-b2']),answer=await response.json();
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'40');assert.equal(answer.code,'quota_minute');assert.equal(answer.retryAfter,40);assert.match(answer.error,/giới hạn số lượt gọi mỗi phút/u);
 assert.deepEqual(answer.blocks.map(b=>[b.id,b.source,b.ocrCorrected]),[['p7-b1',REAL[0][2],true],['p7-b5',REAL[2][2],true],['p7-b6','因为 @@PDF_INLINE_1@@ 所以',true]],'the blocks read, as stored');
 assert.deepEqual(answer.pending,['p8-b2']);assert.deepEqual([answer.usage.total,answer.usage.requests],[500+2420,2]);assert.equal(answer.ocrCorrectedVersion,0);assert.equal(answer.document,undefined);
 assert.deepEqual(JSON.parse(storedText(FILES.values.get(manifestKey))).pages.flatMap(p=>p.blocks).map(b=>[b.id,b.ocrCorrected===true]),[['p7-b1',true],['p7-b5',true],['p7-b6',true],['p8-b2',false]]);
 // In the browser it is a 429 as ever (a whole-book run waits it out); the request after it names only the sheet left.
 assert.equal(classifyError(Object.assign(new Error(answer.error),{status:response.status,data:answer,retryAfter:40})).reason,'quota_minute');
 calls.length=0;decide=ids=>read(ids);
 const rest=await call(['p8-b2']);assert.equal(rest.status,200);assert.deepEqual(calls,[['p8-b2']]);assert.equal((await rest.json()).ocrCorrectedVersion,1);
});

test('A re-read names at most the mode\'s ocrBatch.blocks blocks, whole sheets as ever; a first reading may take a larger sheet',async t=>{
 // One sheet a block larger than Kỹ nhất may re-read in one call (16 in translation-modes.js), within the 48 of a first
 // reading and of a mode that re-reads more at once (Kỹ hơn: 24).
 const most=modeProfile('premium').ocrBatch.blocks,wider=MODES.find(id=>modeProfile(id).reread&&modeProfile(id).ocrBatch.blocks>most),ids=Array.from({length:most+1},(_,i)=>`p7-b${i+1}`);
 const doc={version:1,extractionVersion:3,totalPages:88,pages:[{number:7,width:600,height:800,ocr:true,background:png,original:png,blocks:ids.map((id,i)=>block(id,`第${i+1}段。`,'p7-s1',`#${i+1}`)),ocrSheets:[{id:'p7-s1',image:'data:image/png;base64,U0hFRVQx',strips:ids.map((id,i)=>strip(id,`#${i+1}`))}]}]};
 const {env,FILES}=await stored(doc),calls=mockGeneration(t,{blocks:ids.map((id,i)=>({id,text:`第${i+1}段。`})),warnings:[]});
 const call=extra=>pdfLayoutRoute(new Request(`https://example.test${base}/ocr-blocks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId,apiKey:studentKey,model,blockIds:ids,slim:true,...extra})}),env,base+'/ocr-blocks',reader);
 assert.equal((await call({mode:'premium'})).status,200);const writes=FILES.writes.length;
 // Part of a sheet is refused for a re-read as for a first reading.
 for(const extra of [{mode:'premium',reread:true},{mode:wider,reread:true,blockIds:ids.slice(0,3)}])await assert.rejects(()=>call(extra),/không hợp lệ/u);
 assert.equal(calls.length,1);assert.equal(FILES.writes.length,writes,'refused before any call or write');
 const again=await (await call({mode:wider,reread:true})).json();
 assert.equal(calls.length,2);assert.ok(again.blocks.every(b=>b.ocrRereads===1&&b.ocrCorrected));
});

const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
test('extract.py packs the OCR crops of each scanned page into sheets: pixels unchanged, unique labels, caps kept',{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_ocr_sheets.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
