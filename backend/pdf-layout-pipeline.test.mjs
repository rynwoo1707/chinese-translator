import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {pdfLayoutRoute} from './pdf-layout.js';
import {serviceHandler} from '../services/pdf-layout/server.mjs';
import {pythonOperation} from '../services/pdf-layout/engine.mjs';
import {LAYOUT_VERSION,untranslatedHan} from '../frontend/translation-modes.js';
import {chunkPages} from '../frontend/whole-book.js';

// What the extractor writes and what the Worker and the browser read of it, end to end: the Worker's routes
// (backend/pdf-layout.js) against the real PDF service (services/pdf-layout/server.mjs and engine.mjs running extract.py
// with PyMuPDF and Tesseract) on a port of this machine. Only Gemini is a stand-in, and no other host is reached.
//  - "Cập nhật bố cục": the saved blocks a refresh names (knownBlocks) are found again by extract.py (payload known) and
//    keep their reading; only blocks still to read go on OCR sheets.
//  - block.hanCells (extract.py) against a Gemini reading: the 'han' doubt and keepPixels (pdf-block-ocr.js,
//    pdf-layout-apply.js).
//  - page.untranslated (extract.py) for "Dịch cả quyển": a page with no block but Chinese left on it is no blank page.
// The pages are synthetic, set with PyMuPDF's own fonts (services/pdf-layout/test_known_blocks.py build_pdf: a scanned
// page and a text-layer page; and a page whose only text is a diagonal watermark).
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
const skip=ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)';

const FIXTURES=`
import base64, json, sys
sys.path.insert(0, 'services/pdf-layout')
import test_known_blocks as known
fitz = known.fitz
data, marks = known.build_pdf()
mixed = fitz.open()
page = mixed.new_page(width=595, height=420)
page.insert_text((60, 60), '第四单元　土壤', fontname='china-s', fontsize=16)
page.insert_text((60, 100), '土壤是岩石经过长期风化，再加上生物的作用形成的。', fontname='china-s', fontsize=12)
page = mixed.new_page(width=595, height=420)
page.insert_text((150, 300), '内部资料　仅供学习', fontname='china-s', fontsize=30, color=(.7, .7, .7), morph=(fitz.Point(150, 300), fitz.Matrix(35)))
json.dump({'part': base64.b64encode(data).decode('ascii'), 'marks': marks, 'water': known.WATER, 'rows': known.ROWS, 'mixed': base64.b64encode(mixed.tobytes()).decode('ascii')}, sys.stdout)
`;
let fixtures=null;
function pdfs(){
 if(fixtures)return fixtures;
 const run=spawnSync(python,['-B','-c',FIXTURES],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,timeout:120000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stderr||''}`.slice(-3000));
 const value=JSON.parse(run.stdout);return fixtures={...value,part:Buffer.from(value.part,'base64'),mixed:Buffer.from(value.mixed,'base64')};
}

const TOKEN='pipeline-'+'t'.repeat(40),origin='https://example.test',base='/api/my/study/pdf-layout',reader={id:'student-1',name:'Lan'};
// The service as server.mjs runs it, its extraction payloads recorded. No export is asked for here.
async function pdfService(t){
 const payloads=[],operations={pythonOperation:(payload,options)=>{payloads.push(payload);return pythonOperation(payload,options);},renderDocument:async()=>{throw new Error('no export in this test');},fontCss:async()=>''};
 const server=createServer(serviceHandler({token:TOKEN,operations,version:null,log:()=>{}}).handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 return {url:`http://127.0.0.1:${server.address().port}/`,payloads};
}
// Storage like R2: a streamed value is read to its end when stored. Without D1, leases and daily caps let every call through.
class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value,options){if(typeof value!=='string'&&!ArrayBuffer.isView(value)&&!(value instanceof ArrayBuffer))value=new Uint8Array(await new Response(value).arrayBuffer());this.values.set(key,{value,options});}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async get(key){
  const item=this.values.get(key);if(!item)return null;
  const bytes=()=>typeof item.value==='string'?new TextEncoder().encode(item.value):new Uint8Array(item.value),text=()=>new TextDecoder().decode(bytes());
  return {body:bytes(),customMetadata:item.options?.customMetadata,json:async()=>JSON.parse(text()),text:async()=>text(),arrayBuffer:async()=>bytes().slice().buffer};
 }
}
const environment=url=>({FILES:new MemoryFiles(),PDF_LAYOUT_SERVICE_URL:url,PDF_LAYOUT_SERVICE_TOKEN:TOKEN});
const route=(env,path,init)=>pdfLayoutRoute(new Request(origin+base+path,init),env,base+path,reader);
const json=body=>({method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
// A chunk of a book the account keeps whole (a whole-book run): pages of the original after offset, so its pages and
// block ids are those of the book.
async function chunk(env,bytes,{pages,offset,total}){
 const sha=String(offset).padStart(64,'0');await env.FILES.put(`study/${reader.id}/sources/${sha}.pdf`,'%PDF-1.7 kept original',{customMetadata:{pages:String(total),filename:'sach.pdf'}});
 const form=new FormData();form.set('file',new File([bytes],'chunk.pdf',{type:'application/pdf'}));form.set('pages',pages);form.set('sourceSha256',sha);form.set('pageOffset',String(offset));
 return route(env,'/extract',{method:'POST',body:form});
}
const hanCount=text=>(String(text).match(/\p{Script=Han}/gu)||[]).length;
// The blocks of a page on the printed line at baseline y (PDF points from the top), and the one block there.
const on=(page,y)=>page.blocks.filter(b=>b.box[1]<=y-3&&y-3<=b.box[3]);
function at(page,y){const found=on(page,y);assert.equal(found.length,1,`one block on the line at y=${y}: ${JSON.stringify(found.map(b=>b.source))}`);return found[0];}
const strips=page=>(page.ocrSheets||[]).flatMap(sheet=>sheet.strips.map(strip=>strip.blockId)).sort();

test('Cập nhật bố cục: the blocks a part read for good are found again by the extractor and keep their reading; only the others go on OCR sheets, and Gemini\'s reading of them is weighed against the Han their ink shows',{skip,timeout:280000},async t=>{
 const {part,marks,water,rows}=pdfs(),{url,payloads}=await pdfService(t),env=environment(url);
 // Pages 7 and 8 of a book, extracted as a whole-book run does.
 const extracted=await chunk(env,part,{pages:'1-2',offset:6,total:20}),first=await extracted.json();
 assert.equal(extracted.status,201,JSON.stringify(first).slice(0,500));
 const {document}=first,[scan,layer]=document.pages;
 assert.deepEqual([document.extractionVersion,...document.pages.map(p=>p.extractionVersion)],[LAYOUT_VERSION,LAYOUT_VERSION,LAYOUT_VERSION]);
 assert.deepEqual(document.pages.map(p=>[p.number,p.ocr]),[[7,true],[8,false]]);
 // What the browser reads of each page and block: Han left outside every block by cause, the Han-sized cells of a block.
 for(const page of document.pages){assert.ok(page.untranslated&&Object.values(page.untranslated).every(Number.isInteger),JSON.stringify(page.untranslated));assert.equal(untranslatedHan(page),0,`a clean page ${page.number} keeps no Chinese`);}
 for(const b of scan.blocks){assert.ok(Number.isInteger(b.hanCells)&&b.hanCells>=0,b.id);assert.ok(b.ocrSheet,`${b.id} waits for its reading`);}
 // The caption may be two blocks, its number and its words (a full-width space between them).
 const heading=at(scan,marks.heading),formula=at(scan,marks.formula),long=at(scan,marks.long),think=at(scan,marks.short),act=at(scan,marks.short+30),captions=on(scan,marks.caption);
 assert.ok(captions.length===1||captions.length===2,JSON.stringify(captions.map(b=>b.source)));
 assert.equal(formula.inlines.length,1,'the sentence holds its formula as a crop');

 // The part as an older extractor left it, read and translated in part: the heading, the sentence and the caption read
 // for good; the paragraph read with a doubt still to read again, a line kept as its pixels, a line never read.
 const LONG=water.repeat(5).slice(0,rows*34),reading={
  [heading.id]:{source:'第三单元　水的循环与天气'},[formula.id]:{source:`在流量计算中，有${formula.inlines[0].token}，其中流速和截面积都可以测量。`},
  ...Object.fromEntries(captions.map((b,k)=>[b.id,{source:captions.length===1?'图3-1　水循环示意图':['图3-1','水循环示意图'][k]}])),
  [long.id]:{source:LONG,ocrDoubt:'han'},[think.id]:{source:'[□]',keepPixels:true}
 };
 const saved=structuredClone(document);saved.extractionVersion=3;
 for(const page of saved.pages){page.extractionVersion=3;for(const b of page.blocks)if(reading[b.id]){const {source,...rest}=reading[b.id];Object.assign(b,{source,text:source,ocrCorrected:true,...rest});}}
 saved.ocrCorrectedVersion=0;await env.FILES.put(`study/${reader.id}/pdf-layout/${first.assetId}/manifest.json`,JSON.stringify(saved));

 const refreshed=await route(env,'/refresh',json({assetId:first.assetId,forceClone:true,mode:'economy'})),result=await refreshed.json();
 assert.equal(refreshed.status,201,JSON.stringify(result).slice(0,500));
 // Named to the extractor: the scanned blocks read for good with their formula crops, every text-layer block with its source.
 const final=[heading,formula,...captions].sort((a,b)=>scan.blocks.indexOf(a)-scan.blocks.indexOf(b));
 assert.deepEqual(payloads.at(-1).known,[
  {page:1,ocr:true,blocks:final.map(b=>({id:b.id,box:b.box,inlines:(b.inlines||[]).map(inline=>inline.box)}))},
  {page:2,ocr:false,blocks:layer.blocks.map(b=>({id:b.id,box:b.box,source:b.source}))}
 ]);
 const [scanAgain,layerAgain]=result.document.pages;
 assert.deepEqual([result.document.extractionVersion,...result.document.pages.map(p=>[p.number,p.ocr])],[LAYOUT_VERSION,[7,true],[8,false]]);
 // Found again: the saved id (the browser carries its translation by it), the saved reading, no crop to read.
 const found=scanAgain.blocks.filter(b=>b.known!==undefined);
 assert.deepEqual(found.map(b=>b.known),final.map(b=>b.id));
 for(const b of found){assert.equal(b.source,reading[b.known].source,b.id);assert.equal(b.ocrCorrected,true,b.id);assert.equal(b.ocrSheet,undefined,b.id);assert.equal(b.image,undefined,b.id);}
 assert.match(found.find(b=>b.known===formula.id).text,/^在流量计算中，有\S+，其中流速/u,'the reading takes the new crop\'s machine text');
 // Read again: the doubt still waiting, the line kept as pixels, the line never read, and any block the part lacked.
 const left=scanAgain.blocks.filter(b=>b.known===undefined);
 assert.deepEqual(left.map(b=>b.id).sort(),scan.blocks.filter(b=>!final.includes(b)).map(b=>b.id).sort());
 for(const b of left){assert.ok(b.ocrSheet,`${b.id} is on a sheet`);assert.notEqual(b.ocrCorrected,true,b.id);}
 assert.deepEqual(strips(scanAgain),left.map(b=>b.id).sort(),'the sheets hold only the blocks still to read');
 assert.deepEqual(layerAgain.blocks.map(b=>b.known),layer.blocks.map(b=>b.id),'a text-layer block whose text is the same is found again');
 assert.equal(result.document.ocrCorrectedVersion,0,'blocks are left to read');

 // The browser reads what is left (Tiết kiệm): Gemini reads the paragraph whole, the question only in part, the other
 // line not at all. Weighed against the Han its ink shows (hanCells), only the short reading is doubted, and the empty
 // one keeps the page's pixels.
 const ids=strips(scanAgain),blockIds=scanAgain.blocks.filter(b=>ids.includes(b.id)).map(b=>b.id),thinkAgain=at(scanAgain,marks.short),actAgain=at(scanAgain,marks.short+30),longAgain=at(scanAgain,marks.long);
 assert.ok(longAgain.hanCells<=hanCount(LONG)+1,`hanCells ${longAgain.hanCells} never counts more than the paragraph's ${hanCount(LONG)} Han`);
 assert.ok(thinkAgain.hanCells>=hanCount('想一想：')/.75,`the question shows ${thinkAgain.hanCells} Han-sized cells`);
 const answers=new Map([[longAgain.id,LONG],[thinkAgain.id,'想一想：'],[actAgain.id,'[□][□]']]);
 t.mock.method(globalThis,'fetch',async input=>{
  assert.match(String(input?.url??input),/generativelanguage\.googleapis\.com/u,'only Gemini is asked');
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({blocks:blockIds.map(id=>({id,text:answers.get(id)??'某段文字。'})),warnings:[]})}]}}],usageMetadata:{promptTokenCount:900,candidatesTokenCount:300,totalTokenCount:1200}});
 });
 const ocr=await route(env,'/ocr-blocks',json({assetId:result.assetId,blockIds,apiKey:'student-ocr-key-12345678901234567890',model:'gemini-3.6-flash',mode:'economy',slim:true})),read=await ocr.json();
 assert.equal(ocr.status,200,JSON.stringify(read).slice(0,500));
 const fields=new Map(read.blocks.map(b=>[b.id,b]));
 assert.equal(fields.get(longAgain.id).ocrDoubt,undefined,'a whole reading is no doubt');assert.equal(fields.get(longAgain.id).source,LONG);
 assert.equal(fields.get(thinkAgain.id).ocrDoubt,'han','a reading with far fewer Han than the strip shows is doubted');
 assert.equal(fields.get(actAgain.id).keepPixels,true,'nothing readable: the page keeps its pixels there');
});

test('Dịch cả quyển: a page with no block whose Chinese stays printed (a diagonal watermark) is named untranslated, never blank, with the extractor\'s note under the book\'s page number',{skip,timeout:280000},async t=>{
 const {mixed}=pdfs(),{url}=await pdfService(t),env=environment(url);
 // A chunk of pages 12-13: a page of text, then a page whose only text is a watermark set aslant.
 const answer=await chunk(env,mixed,{pages:'1-2',offset:11,total:20}),result=await answer.json();
 assert.equal(answer.status,201,JSON.stringify(result).slice(0,500));
 assert.deepEqual(chunkPages(result.document),{done:[12],blank:[],untranslated:[13],processed:2});
 assert.ok(result.document.pages[1].untranslated.rotated>0,JSON.stringify(result.document.pages[1].untranslated));
 assert.ok(result.document.warnings.some(note=>/^Trang 13: /u.test(note)),JSON.stringify(result.document.warnings));
 // The watermark page alone: no block at all, answered with the page the run marks untranslated and its note.
 const alone=await chunk(env,mixed,{pages:'2',offset:11,total:20}),data=await alone.json();
 assert.equal(alone.status,422);assert.equal(data.code,'no_text');
 assert.deepEqual([data.pages,data.untranslated],[[13],[13]]);assert.ok(data.warnings.some(note=>/^Trang 13: /u.test(note)),JSON.stringify(data.warnings));
});
