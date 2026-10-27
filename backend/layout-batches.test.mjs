import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {blockBatches,ocrImageBatches,fitTextBoxes,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {MODES,modeProfile} from '../frontend/translation-modes.js';

// How a kept-layout run cuts its work into Gemini calls (frontend/pdf-box-layout.js): translation groups and OCR calls,
// within the limits of each "Cách dịch" (translation-modes.js layoutBatch and ocrBatch), the old defaults (Tiết kiệm's)
// unchanged. Then the fitting of translated boxes, which measures 2-D math (math-text.js math-env, math-stack) as pieces
// that cannot wrap. No network, no Gemini; the last test runs in Edge and is skipped without it.
const blocks=(count,length=10,page=1)=>Array.from({length:count},(_,i)=>({id:`p${page}-b${i+1}`,source:'字'.repeat(length)}));
const sizes=batches=>batches.map(batch=>batch.length);
const chars=batch=>batch.reduce((sum,b)=>sum+b.source.length,0);

test('translation groups keep their old defaults: 5,000 characters and 48 blocks a call',()=>{
 assert.deepEqual(sizes(blockBatches(blocks(100))),[48,48,4]);
 assert.deepEqual(sizes(blockBatches(blocks(6,2000))),[2,2,2]);
 assert.deepEqual(sizes(blockBatches(blocks(6,2000),3000)),[1,1,1,1,1,1]);
 // A block longer than the limit still goes, alone.
 assert.deepEqual(sizes(blockBatches([...blocks(1,9000),...blocks(1,10,2)])),[1,1]);
 assert.deepEqual(blockBatches([]),[]);
});

test('translation groups follow a mode\'s layoutBatch, and never take more than the server\'s 48 blocks',()=>{
 const many=blocks(100);
 assert.deepEqual(sizes(blockBatches(many,{chars:2000,blocks:16})),[16,16,16,16,16,16,4]);
 assert.deepEqual(sizes(blockBatches(many,{chars:50,blocks:16})),Array(20).fill(5));
 assert.deepEqual(sizes(blockBatches(many,{chars:1e6,blocks:500})),[48,48,4]);
 // The old positional form, with the block limit as a third argument.
 assert.deepEqual(sizes(blockBatches(many,5000,10)),Array(10).fill(10));
 // Missing or nonsense limits are the defaults.
 for(const limits of [undefined,null,{},{chars:0,blocks:0},{chars:Number.NaN,blocks:-1}])assert.deepEqual(sizes(blockBatches(many,limits)),[48,48,4],String(JSON.stringify(limits)));
 // Each mode's own groups stay within its layoutBatch; the cheaper the mode, the fewer the calls.
 const counts=MODES.map(id=>{
  const {layoutBatch}=modeProfile(id),groups=blockBatches(blocks(100,120),layoutBatch);
  for(const group of groups)assert.ok(group.length<=Math.min(48,layoutBatch.blocks)&&(group.length===1||chars(group)<=layoutBatch.chars),`${id}: ${group.length} blocks, ${chars(group)} characters`);
  return groups.length;
 });
 assert.deepEqual(counts,[...counts].sort((a,b)=>a-b),`calls by mode ${MODES.join(', ')}: ${counts.join(', ')}`);
 assert.ok(counts.at(-1)>counts[0],'Kỹ nhất makes more, smaller calls than Tiết kiệm');
});

// An OCR sheet (extract.py ocr_sheets): one image holding the strips of `count` blocks of one page.
const sheet=(id,count,size=10)=>({id,image:'S'.repeat(size),strips:Array.from({length:count},(_,i)=>({label:`#${i+1}`,blockId:`${id}-b${i}`,box:[0,0,1,1]}))});
const blocksOf=sheets=>sheets.flatMap(s=>s.strips.map(strip=>({id:strip.blockId,ocrSheet:s.id,source:'字'})));
const own=count=>Array.from({length:count},(_,i)=>({id:`p9-b${i+1}`,image:'I'.repeat(10),source:'字'}));

test('OCR calls keep their old defaults: 6 images, 48 blocks of sheets, 4 MB',()=>{
 assert.deepEqual(OCR_LIMITS,{images:6,sheetBlocks:48,bytes:4*1024*1024});
 const small=Array.from({length:8},(_,i)=>sheet(`p1-s${i+1}`,3));
 assert.deepEqual(sizes(ocrImageBatches(blocksOf(small),undefined,small)),[18,6]);
 const full=Array.from({length:3},(_,i)=>sheet(`p1-s${i+1}`,20));
 assert.deepEqual(sizes(ocrImageBatches(blocksOf(full),undefined,full)),[40,20]);
 assert.deepEqual(sizes(ocrImageBatches(own(8))),[6,2]);
 assert.deepEqual(sizes(ocrImageBatches(own(8),25)),[2,2,2,2],'the byte limit still applies');
});

test('OCR calls follow a mode\'s ocrBatch: fewer images and blocks a call, a sheet never split, never above OCR_LIMITS',()=>{
 const small=Array.from({length:8},(_,i)=>sheet(`p1-s${i+1}`,3)),fine=Array.from({length:5},(_,i)=>sheet(`p2-s${i+1}`,8));
 assert.deepEqual(sizes(ocrImageBatches(blocksOf(small),undefined,small,{images:3,blocks:16})),[9,9,6]);
 assert.deepEqual(sizes(ocrImageBatches(blocksOf(fine),undefined,fine,{images:3,blocks:16})),[16,16,8]);
 // A sheet holding more blocks than the mode's calls take still goes whole, in a call of its own (its image is one).
 const big=[sheet('p3-s1',20),sheet('p3-s2',2)];
 assert.deepEqual(ocrImageBatches(blocksOf(big),undefined,big,{images:3,blocks:16}),[big[0].strips.map(s=>s.blockId),big[1].strips.map(s=>s.blockId)]);
 // A block of a sheet brings every block of that sheet, once.
 assert.deepEqual(ocrImageBatches([blocksOf(fine)[3],blocksOf(fine)[9]],undefined,fine,{images:3,blocks:16}),[[...fine[0].strips,...fine[1].strips].map(s=>s.blockId)]);
 assert.deepEqual(sizes(ocrImageBatches(own(8),undefined,[],{images:3,blocks:16})),[3,3,2]);
 assert.deepEqual(sizes(ocrImageBatches(own(8),undefined,[],{images:6,blocks:2})),[2,2,2,2]);
 // Never more than the server takes; missing or nonsense limits are the defaults.
 assert.deepEqual(sizes(ocrImageBatches(blocksOf(small),undefined,small,{images:20,blocks:500})),[18,6]);
 for(const limits of [undefined,null,{},{images:0,blocks:0},{images:Number.NaN,blocks:-3}])assert.deepEqual(sizes(ocrImageBatches(blocksOf(small),undefined,small,limits)),[18,6],String(JSON.stringify(limits)));
 for(const id of MODES){
  const {ocrBatch}=modeProfile(id);
  for(const [list,sheets] of [[blocksOf(small),small],[blocksOf(fine),fine],[own(8),[]]])for(const ids of ocrImageBatches(list,undefined,sheets,ocrBatch)){
   const images=sheets.length?new Set(ids.map(id=>sheets.find(s=>s.strips.some(strip=>strip.blockId===id)).id)).size:ids.length;
   assert.ok(images<=ocrBatch.images&&ids.length<=ocrBatch.blocks,`${id}: ${images} images, ${ids.length} blocks`);
  }
 }
});

// Fitting without a browser (as backend/pdf-render-layout.test.mjs does): one translated box whose text is one short line
// and which holds one piece `ems` em wide at the current size. querySelectorAll matches class selectors as the DOM does.
function oneBox(pieceClass,ems){
 const el={dataset:{pending:'false',blockId:'p1-b1',baseFont:'10'},textContent:'Ma trận',style:{left:'50pt',top:'50pt',width:'300pt',height:'60pt',fontSize:'10pt',paddingTop:''},
  get offsetHeight(){return parseFloat(this.style.height)*4/3;},get clientWidth(){return Math.round(parseFloat(this.style.width)*4/3);},get scrollWidth(){return this.clientWidth;},
  getBoundingClientRect(){const [l,t,w,h]=['left','top','width','height'].map(k=>parseFloat(this.style[k])*4/3);return {left:l,top:t,right:l+w,bottom:t+h,width:w,height:h};},
  querySelectorAll(selector){return selector.split(',').map(part=>part.trim()).includes(`.${pieceClass}`)?[piece]:[];}
 };
 const px=()=>parseFloat(el.style.fontSize)*4/3;
 const piece={getBoundingClientRect(){const box=el.getBoundingClientRect(),width=ems*px();return {left:box.left,right:box.left+width,top:box.top,bottom:box.top+1.08*px(),width,height:1.08*px()};}};
 const document={createRange(){return {selectNodeContents(){},getClientRects(){const box=el.getBoundingClientRect();return [{left:box.left,right:box.left+5*px(),top:box.top,bottom:box.top+1.08*px(),width:5*px(),height:1.08*px()}];}};}};
 return fitTextBoxes({ownerDocument:document,querySelectorAll:()=>[el]})[0];
}

test('fitting measures a 2-D environment (a cases system, a matrix) and a stack as pieces that cannot wrap',()=>{
 // 40em of matrix in a 300pt box: it fits only once the font is 7.5pt or smaller.
 for(const piece of ['math-env','math-stack']){
  const fitted=oneBox(piece,40);
  assert.equal(fitted.overflow,false,piece);assert.ok(fitted.fontSize<=7.5&&fitted.fontSize>7,`${piece}: ${fitted.fontSize}`);
 }
 // The same piece fitting at the base size changes nothing; an ordinary span (which wraps) is not measured this way.
 assert.equal(oneBox('math-env',20).fontSize,10);assert.equal(oneBox('math-row',40).fontSize,10);
 // Wider than the box even at the smallest size: reported, so the export says which block to shorten.
 assert.equal(oneBox('math-env',90).overflow,true);
});

// The same in Edge, with real layout: a pmatrix drawn as math-text.js draws 2-D math (an inline grid whose cells never
// wrap: the box's overflow-wrap:anywhere would otherwise break each cell's text to squeeze the grid in), wider than its
// box, comes out of fitting inside the box.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url));
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
test.after(()=>browser?.close());
test('in Edge, a matrix wider than its box shrinks the font until it fits instead of running past the box',{skip:browser?false:'Microsoft Edge is not available to playwright-core here',timeout:60000},async()=>{
 const context=await browser.newContext({viewport:{width:900,height:700}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost:4180')return route.abort();
  if(url.pathname==='/')return route.fulfill({status:200,headers:{'Content-Type':'text/html; charset=utf-8'},body:'<!doctype html><html lang="vi"><head><meta charset="utf-8"></head><body></body></html>'});
  const file=normalize(join(root,url.pathname));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);return data?route.fulfill({status:200,headers:{'Content-Type':extname(file)==='.js'?'text/javascript':'application/octet-stream'},body:data}):route.fulfill({status:404,body:''});
 });
 try{
  await page.goto('http://localhost:4180/');
  const result=await page.evaluate(async()=>{
   const {fitTextBoxes,boxStyles}=await import('/pdf-box-layout.js'),style=document.createElement('style');style.textContent=boxStyles;document.head.append(style);
   const cells=Array.from({length:12},(_,i)=>`<span>x<sub>${i+1}</sub>+y</span>`).join('');
   document.body.innerHTML=`<div class="pdf-paper" style="width:500pt;height:400pt"><div class="pdf-text-box" data-block-id="p1-b1" data-base-font="12" data-pending="false" style="left:20pt;top:20pt;width:200pt;height:80pt;font-size:12pt">Ma trận <span class="math-env math-env-pmatrix" style="display:inline-grid;grid-template-columns:repeat(12,auto);column-gap:.5em;vertical-align:middle;white-space:nowrap">${cells}</span></div></div>`;
   const box=document.querySelector('.pdf-text-box'),matrix=box.querySelector('.math-env'),before=matrix.getBoundingClientRect().right-box.getBoundingClientRect().right;
   const [report]=fitTextBoxes(document.querySelector('.pdf-paper'));
   return {before,after:matrix.getBoundingClientRect().right-box.getBoundingClientRect().right,report};
  });
  assert.ok(result.before>20,`the matrix starts wider than its box (${result.before}px past it)`);
  assert.equal(result.report.overflow,false);assert.ok(result.report.fontSize<12,JSON.stringify(result.report));
  assert.ok(result.after<=1,`after fitting it ends inside the box (${result.after}px)`);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
