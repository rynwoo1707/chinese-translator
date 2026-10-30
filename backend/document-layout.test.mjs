import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOcrLayout,normalizePolygon,orderLayoutBlocks,createTranslationPlan,joinedPageText,tesseractLayout,splitTranslationText,textOutsideFigures,glyphRows,glyphRegions} from '../frontend/document-layout.js';
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

// ---- Han glyphs in a page image (glyphRows): a grey page drawn here pixel by pixel ----
const sheet=(width,height,paper=245)=>({width,height,gray:new Uint8Array(width*height).fill(paper)});
const paint=(page,x,y,w,h,value)=>{for(let j=Math.max(0,y);j<Math.min(page.height,y+h);j++)page.gray.fill(value,j*page.width+Math.max(0,x),j*page.width+Math.min(page.width,x+w));};
// A Han-like glyph of two parts that do not touch, as 氵 and 舌 or 讠 and 仑: three dots on the left, a framed part on
// the right whose inner strokes differ from one glyph to the next (k), as the glyphs of a line of text do.
function hanGlyph(page,x,y,size,ink=20,k=0){
 const t=Math.max(1,Math.round(size*.1)),left=x+Math.round(size*.34),w=Math.round(size*.62);
 const across=(fy,from=0,to=1)=>paint(page,left+Math.round(w*from),y+Math.round(size*fy),Math.round(w*(to-from)),t,ink),down=(fx,from=0,to=1)=>paint(page,left+Math.round(w*fx),y+Math.round(size*from),t,Math.round(size*(to-from)),ink);
 if(k%3===1)paint(page,x+Math.round(size*.1),y,t+1,size,ink);else for(const j of k%3?[0,2]:[0,1,2])paint(page,x,y+Math.round(size*(.08+j*.34)),Math.round(size*.22),t+1,ink);
 [()=>{across(0);across(.5);across(.9);down(0);down(.5);down(.9);},()=>{across(0);across(.35);across(.7);down(0,0,.7);down(.9,0,.7);down(.45,.7);},()=>{across(.1);across(.5,0,.6);across(.9);down(.2);down(.75,0,.5);}][k%3]();
}
const hanRow=(page,x,y,size,count,ink)=>{for(let c=0;c<count;c++)hanGlyph(page,x+Math.round(c*size*1.12),y,size,ink,c);};
test('Han glyphs in a page image are found row by row at each row\'s own size, dark on paper or light on a band',()=>{
 const page=sheet(900,700);
 hanRow(page,40,40,18,6);                                   // a heading of six glyphs, 18 px
 paint(page,30,110,500,40,60);hanRow(page,50,120,18,5,250);  // a white title on a dark band
 hanRow(page,40,200,40,4);                                  // a big title, 40 px
 // Latin letters (narrow cells of one or two upright strokes) and the dots of a chart line up as no Han row.
 for(let c=0;c<14;c++){const x=40+c*13,stroke=c%3?2:3;paint(page,x,300,stroke,16,20);if(c%2)paint(page,x+6,300,stroke,16,20);}
 for(let k=0;k<60;k++)paint(page,(k*97)%850+20,400+(k*53)%120,3,3,20);
 const rows=glyphRows(page.gray,page.width,page.height,{scale:1.5});
 assert.deepEqual(rows.map(({cells,light,y0})=>({cells,light,y0})),[{cells:6,light:false,y0:40},{cells:4,light:false,y0:200},{cells:5,light:true,y0:120}]);
 assert.ok(Math.abs(rows[1].em-40)<=2&&Math.abs(rows[0].em-18)<=2,JSON.stringify(rows));
 // What a text layer holds is left out (mask); the rows left make the regions an OCR pass reads, light kept apart.
 const masked=glyphRows(page.gray,page.width,page.height,{scale:1.5,mask:[{x0:30,y0:30,x1:300,y1:70}]});
 assert.deepEqual(masked.map(row=>row.y0),[200,120]);
 const regions=glyphRegions(rows,page.width,page.height);
 assert.deepEqual(regions.map(({cells,light})=>({cells,light})),[{cells:6,light:false},{cells:5,light:true},{cells:4,light:false}],'top to bottom');
 for(const {box} of regions)assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=1&&box.y+box.height<=1);
 // A table: rows of short cells under each other make one region, read row by row.
 const table=sheet(600,300);for(const y of [20,50,80]){hanRow(table,20,y,18,2);hanRow(table,140,y,18,4);hanRow(table,300,y,18,3);}
 const tableRows=glyphRows(table.gray,table.width,table.height,{scale:1.5});
 assert.deepEqual(tableRows.map(row=>row.cells),[9,9,9]);assert.deepEqual(glyphRegions(tableRows,table.width,table.height).map(region=>region.cells),[27]);
});

// A heading of two characters standing alone on paper (练习, 习题) is a row, and so is one whose run a colon or a lone bar
// such as 一 breaks (答案：略, 第一章 函数); two glyphs with ink close under them (a label in a picture) or two copies of
// one mark are not.
test('A two-character heading standing alone, or one a colon or 一 breaks, is found; a pair among ink or of copies is not',()=>{
 const page=sheet(700,560),size=18,step=Math.round(size*1.12),pair=y=>{hanGlyph(page,40,y,size,20,0);hanGlyph(page,40+step,y,size,20,2);};
 pair(40);
 hanGlyph(page,40,120,size,20,0);hanGlyph(page,40+step,120,size,20,1);paint(page,40+2*step+8,125,3,3,20);paint(page,40+2*step+8,133,3,3,20);hanGlyph(page,40+3*step,120,size,20,2);
 hanGlyph(page,40,200,size,20,0);paint(page,40+step,208,Math.round(size*.9),2,20);hanGlyph(page,40+2*step,200,size,20,1);hanGlyph(page,40+Math.round(3.4*step),200,size,20,2);hanGlyph(page,40+Math.round(4.4*step),200,size,20,0);
 pair(300);paint(page,30,325,120,2,20);
 const frame=(x,y)=>{paint(page,x,y,size,2,20);paint(page,x,y+size-2,size,2,20);paint(page,x,y,2,size,20);paint(page,x+size-2,y,2,size,20);};frame(40,420);frame(40+step,420);
 assert.deepEqual(glyphRows(page.gray,page.width,page.height,{scale:1.5}).map(({cells,y0})=>({cells,y0})),[{cells:2,y0:40},{cells:3,y0:120},{cells:4,y0:200}]);
});

// A workbook's drawn marks are copies of one shape or cross few strokes, digits are narrow, and Latin small letters stand
// under the stems of their ascenders: none is a row of Han glyphs, so none costs an OCR or Gemini reading.
test('Answer boxes, writing grids, ticked boxes, stars, digits and Latin words in a page image make no Han row',()=>{
 const page=sheet(900,420),ink=20,t=2,frame=(x,y,w,h)=>{paint(page,x,y,w,t,ink);paint(page,x,y+h-t,w,t,ink);paint(page,x,y,t,h,ink);paint(page,x+w-t,y,t,h,ink);};
 for(let c=0;c<5;c++)frame(40+c*26,20,20,20);
 for(let c=0;c<5;c++){const x=40+c*30,y=70;frame(x,y,26,26);for(let d=0;d<26;d+=4){paint(page,x+12,y+d,1,2,ink);paint(page,x+d,y+12,2,1,ink);}}
 for(let c=0;c<4;c++){const x=40+c*26,y=120;frame(x,y,20,20);for(let d=0;d<5;d++)paint(page,x+4+d,y+9+d,2,2,ink);for(let d=0;d<9;d++)paint(page,x+8+d,y+13-d,2,2,ink);}
 const star=(cx,cy,r)=>{const points=Array.from({length:10},(_,k)=>{const a=-Math.PI/2+k*Math.PI/5,q=k%2?r*.42:r;return [cx+q*Math.cos(a),cy+q*Math.sin(a)];});for(let y=Math.floor(cy-r);y<=cy+r;y++)for(let x=Math.floor(cx-r);x<=cx+r;x++){let inside=false;for(let i=0,j=9;i<10;j=i++){const [xi,yi]=points[i],[xj,yj]=points[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}if(inside)paint(page,x,y,1,1,ink);}};
 for(let c=0;c<4;c++)star(52+c*24,185,11);
 const digit=(x,y,k)=>{const w=11,h=20;if(k===0)frame(x,y,w,h);if(k===1){frame(x,y,w,11);frame(x,y+9,w,11);}if(k===2){frame(x,y+9,w,11);paint(page,x,y,t,h,ink);paint(page,x,y,w,t,ink);}if(k===3){frame(x,y,w,11);paint(page,x+w-t,y,t,h,ink);paint(page,x,y+h-t,w,t,ink);}};
 for(let c=0;c<8;c++)digit(40+c*15,230,c%4);
 // Words of small letters (o, n, a under the x-height line) and ascenders (d, b, h, l rising to the top).
 const letter=(x,y,c)=>{const xh=y+6,w=9;
  if(c==='o')frame(x,xh,w,14);if(c==='n'){paint(page,x,xh,t,14,ink);paint(page,x+w-t,xh,t,14,ink);paint(page,x,xh,w,t,ink);}
  if(c==='a'){frame(x,xh+5,w,9);paint(page,x+w-t,xh,t,14,ink);paint(page,x,xh,w,t,ink);}
  if(c==='d'){frame(x,xh,w,14);paint(page,x+w-t,y,t,20,ink);}if(c==='b'){frame(x,xh,w,14);paint(page,x,y,t,20,ink);}
  if(c==='h'){paint(page,x,y,t,20,ink);paint(page,x+w-t,xh,t,14,ink);paint(page,x,xh,w,t,ink);}if(c==='l')paint(page,x+3,y,t,20,ink);return x+w+2;};
 let x=40;for(const word of ['donna','band','hold','aload','dona','bold'])for(const c of word+' ')x=c===' '?x+6:letter(x,290,c);
 hanRow(page,40,360,18,6);
 assert.deepEqual(glyphRows(page.gray,page.width,page.height,{scale:1.5}).map(({cells,y0})=>({cells,y0})),[{cells:6,y0:360}],'only the Han row');
});
