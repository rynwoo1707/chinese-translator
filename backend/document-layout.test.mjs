import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOcrLayout,normalizePolygon,orderLayoutBlocks,createTranslationPlan,joinedPageText,tesseractLayout,splitTranslationText,textOutsideFigures} from '../frontend/document-layout.js';
import {pdfTextLayout} from '../frontend/pdf-client.js';
import {buildStudyHtml} from '../frontend/study-layout-view.js';

const line=(text,x,y,w=.25)=>({text,score:.92,poly:[[x*1000,y*1400],[(x+w)*1000,y*1400],[(x+w)*1000,(y+.02)*1400],[x*1000,(y+.02)*1400]]});
test('OCR coordinates are bounded and numeric formula labels survive inside the page',()=>{
 const result=normalizeOcrLayout({image:{width:1000,height:1400},items:[line('12',.1,.97),line('12',.4,.5),line('x²+y²=1',.1,.3),line('中文定义',.1,.1)]});
 assert.deepEqual(result.blocks.map(b=>b.text),['中文定义','x²+y²=1','12']);
 assert.equal(result.confidence,92);assert.equal(result.blocks[1].box.x,.1);
 assert.equal(normalizePolygon([[0,0],[NaN,20],[20,20]],100,100),null);
 assert.deepEqual(normalizePolygon([[-20,-20],[120,0],[120,120]],100,100),{x:0,y:0,width:1,height:1});
});
test('Text reading order retains heading, then reads columns instead of alternating rows',()=>{
 const blocks=normalizeOcrLayout({image:{width:1000,height:1400},items:[line('标题',.1,.05,.8),...Array.from({length:3},(_,i)=>line('左'+i,.1,.2+i*.1)),...Array.from({length:3},(_,i)=>line('右'+i,.6,.2+i*.1))]}).blocks;
 assert.deepEqual(orderLayoutBlocks(blocks).map(b=>b.text),['标题','左0','左1','左2','右0','右1','右2']);
});
test('Tesseract fallback preserves line boxes',()=>{
 const layout=tesseractLayout({blocks:[{paragraphs:[{lines:[{text:'空间向量',confidence:88,bbox:{x0:10,y0:20,x1:80,y1:40}}]}]}]},100,200);
 assert.equal(layout.blocks[0].box.y,.1);assert.equal(layout.confidence,88);
});
test('PDF text coordinates transform bottom-origin baselines into top-origin regions',()=>{
 const layout=pdfTextLayout([{str:'中文',transform:[10,0,0,10,20,80],width:40,height:10}],{width:100,height:100,convertToViewportPoint:(x,y)=>[x,100-y]});
 assert.deepEqual(layout.blocks[0].box,{x:.2,y:.1,width:.39999999999999997,height:.1});
});
test('Each translation stays with one source page, and manual edits invalidate mapping',()=>{
 const pages=new Map([[3,{text:'第三页。'}],[1,{text:'第一页。'}]]),source=joinedPageText(pages),plan=createTranslationPlan(source,pages);
 assert.equal(plan.length,2);assert.deepEqual(plan.map(part=>part.pages),[[1],[3]]);assert.equal(plan.map(part=>part.text).join('\n\n'),source);
 assert.deepEqual(createTranslationPlan(source+'手动更改',pages)[0].pages,[]);
 const long='甲'.repeat(4999)+'😀'+'乙'.repeat(5000),split=createTranslationPlan(long,new Map(),5000);
 assert.equal(split.map(p=>p.text).join(''),long);assert.ok(split.every(p=>p.text.length<=5000));assert.ok(split.every(p=>!/[\uD800-\uDBFF]$/u.test(p.text)));
});
test('OCR joins wrapped body lines while preserving section and paragraph boundaries',()=>{
 const layout=normalizeOcrLayout({image:{width:1000,height:1400},items:[
  line('1.1 空间向量及其运算',.1,.08,.65),
  line('与平面向量一样，在空间，我们把具有大小和方向的量',.14,.15,.64),
  line('叫做空间向量，向量可以表示物体的运动。',.1,.178,.68),
  line('如果表示若干空间向量的有向线段所在直线互相平行，',.14,.206,.64),
  line('那么这些向量叫做共线向量。',.1,.234,.4),
  line('图 1.1-2',.67,.35,.12)
 ]});
 assert.equal(layout.paragraphs.length,4);
 assert.equal(layout.paragraphs[0].kind,'heading');assert.equal(layout.paragraphs[3].kind,'caption');
 assert.equal(layout.text,'1.1 空间向量及其运算\n\n与平面向量一样，在空间，我们把具有大小和方向的量叫做空间向量，向量可以表示物体的运动。\n\n如果表示若干空间向量的有向线段所在直线互相平行，那么这些向量叫做共线向量。\n\n图 1.1-2');
 for(const block of layout.blocks)assert.equal(layout.text.slice(block.textStart,block.textEnd),block.text);
 const pages=new Map([[4,{text:layout.text,layout}]]),plan=createTranslationPlan(layout.text,pages,65);
 assert.ok(plan.every(part=>part.pages.length===1&&part.pages[0]===4));
 assert.equal(plan.map(part=>part.text).join(''),layout.text);
 let offset=0;
 for(const part of plan){
  assert.deepEqual(part.blockIds[4],layout.blocks.filter(block=>block.textEnd>offset&&block.textStart<offset+part.text.length).map(block=>block.id));offset+=part.text.length;
 }
});
test('Diagram labels stay separate from paragraphs and Tesseract paragraph boundaries survive',()=>{
 const layout=normalizeOcrLayout({image:{width:1000,height:1400},items:[line('空间中的向量可以表示物体的运动。',.1,.1,.5),line('A',.72,.115,.025),line('B',.83,.16,.025)]});
 assert.equal(layout.text,'空间中的向量可以表示物体的运动。\n\nA\n\nB');
 const tesseract=tesseractLayout({blocks:[{paragraphs:[
  {lines:[{text:'这是第一段的中文文字',confidence:88,bbox:{x0:10,y0:20,x1:80,y1:30}},{text:'仍然属于第一段内容',confidence:88,bbox:{x0:10,y0:33,x1:80,y1:43}}]},
  {lines:[{text:'这是第二段的中文文字',confidence:88,bbox:{x0:10,y0:46,x1:80,y1:56}}]}
 ]}]},100,200);
 assert.equal(tesseract.text,'这是第一段的中文文字仍然属于第一段内容\n\n这是第二段的中文文字');
});
test('Long pages prefer paragraph boundaries and keep exact block mapping after rewrapping',()=>{
 const text='第一段内容很长，第一段结束。\n\n第二段保留全部内容。';
 const pages=new Map([[4,{text,layout:{blocks:[{id:'a',text:'第一段内容很长，'},{id:'b',text:'第一段结束。'},{id:'c',text:'第二段保留全部内容。'}]}}]]);
 const plan=createTranslationPlan(text,pages,20);
 assert.equal(plan.length,2);assert.deepEqual(plan[0].blockIds[4],['a','b']);assert.deepEqual(plan[1].blockIds[4],['c']);
 assert.equal(plan.map(part=>part.text).join(''),text);assert.ok(plan.every(part=>part.text.length<=20));
 assert.throws(()=>splitTranslationText('abc',0),RangeError);
});
test('diagram point labels leave translation text after exact source pixels are preserved',()=>{
 const layout=normalizeOcrLayout({image:{width:1000,height:1400},items:[line('正文说明。',.1,.1,.5),line('A',.6,.5,.02),line('B',.75,.55,.02),line('图1.1-2',.64,.65,.1),line('后续正文。',.1,.8,.5)]});
 const text=textOutsideFigures(layout,[{box:{x:.55,y:.45,width:.32,height:.25},caption:'图1.1-2'}]);
 assert.match(text,/正文说明。/);assert.match(text,/图1.1-2/);assert.match(text,/后续正文。/);assert.doesNotMatch(text,/(?:^|\n\n)[AB](?:$|\n\n)/u);
});
test('HTML export pairs only completed translations with their original images and escapes content',async()=>{
 const html=await buildStudyHtml({title:'<script>bad</script>',parts:[{text:'原文',pages:[80]},{text:'未完成',pages:[81]}],translations:['Bản dịch <img onerror=bad>'],images:new Map([[80,{blob:new Blob(['a'])}],[81,{blob:new Blob(['b'])}]]),blobDataUrl:async blob=>'data:image/png;base64,'+await blob.text(),combined:''});
 assert.match(html,/Trang gốc 80/);assert.doesNotMatch(html,/Trang gốc 81|<script>|<img onerror/);assert.match(html,/&lt;img onerror/);
});
