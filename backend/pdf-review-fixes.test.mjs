import test from 'node:test';
import assert from 'node:assert/strict';
import {pageMarkup,fitTextBoxes,prepareLayout} from '../frontend/pdf-box-layout.js';
import {renderMathText,normalizeVectorMath} from '../frontend/math-text.js';
import {normalizeOcrMath,mapBareLatex,ocrRequest} from './pdf-block-ocr.js';
import {protectMathExpressions} from './ai.js';
import {translatePdfBlocks} from './pdf-block-translation.js';

// Regression tests for the review of the layout-preserving PDF pipeline (renderer, math text, OCR and translation
// prompts). Each case comes from a reproduced failure; none is specific to one subject.
const png='data:image/png;base64,QUJD',B=String.fromCharCode(92);
const token=n=>`@@PDF_INLINE_${n}@@`;
const inline=(n,box,extra={})=>({token:token(n),image:png,text:'AB',box,width:box[2]-box[0],height:box[3]-box[1],...extra});
const page=(blocks,extra={})=>({number:1,width:600,height:800,original:png,background:png,extractionVersion:3,blocks,...extra});
const textBox=html=>html.slice(html.indexOf('<div class="pdf-text-box"'));
const tags=html=>html.match(/<[^>]*>/gu)||[];

test('a formula token inside a vector, fraction or root keeps its image in the text and its alt text in the label',()=>{
 for(const tex of [`${B}(${B}vec{${token(1)}}${B})`,`${B}(${B}frac{${token(1)}}{2}${B})`,`${B}frac{1}{${token(1)}}`,`${B}sqrt{${token(1)}}`,`${B}overrightarrow{${token(1)}}`]){
  const b={id:'p1-b1',source:'原文',fontSize:10,box:[50,100,550,160],inlines:[inline(1,[100,200,150,215])]};
  const html=textBox(pageMarkup(page([b]),new Map([[b.id,`Cho ${tex} xong`]])));
  assert.equal((html.match(/<img class="pdf-inline"/gu)||[]).length,1,tex);
  assert.doesNotMatch(html,/@@PDF_INLINE|[\uE000-\uF8FF]/u,tex);
  // no tag carries another tag inside an attribute, and the label names the formula by its alt text
  for(const tag of tags(html))assert.doesNotMatch(tag.slice(1),/</u,tex);
  assert.match(html,/aria-label="[^"]*AB[^"]*"/u,tex);
 }
});

test('a private-use character in a formula\'s own text never captures the next formula\'s image',()=>{
 const b={id:'p1-b1',source:'原文',fontSize:10,box:[50,100,550,160],inlines:[inline(1,[100,200,150,215],{text:`x${String.fromCharCode(0xE001)}`}),inline(2,[150,200,190,215],{text:'y'})]};
 const html=textBox(pageMarkup(page([b]),new Map([[b.id,`Một ${token(1)} hai ${token(2)} ba`]])));
 assert.equal((html.match(/<img class="pdf-inline"/gu)||[]).length,2);assert.doesNotMatch(html,/@@PDF_INLINE|[\uE000-\uF8FF]/u);
 for(const tag of tags(html))assert.doesNotMatch(tag.slice(1),/</u);
});

test('OCR normalisation never wraps a vector round a formula token, and the prompt keeps tokens and words out of LaTeX',()=>{
 assert.equal(normalizeVectorMath(`${B}vec{${token(1)}} = ${B}vec{a}`),`${B}vec{${token(1)}} = ${B}(${B}vec{a}${B})`);
 assert.equal(normalizeOcrMath(`${B}vec{${token(1)}} = ${B}vec{a}`),`${B}vec{${token(1)}} = ${B}(${B}vec{a}${B})`);
 const {instruction}=ocrRequest([{id:'p1-b1',source:'x',box:[0,0,1,1],image:'data:image/png;base64,iVBORw0KGgo='}]);
 assert.match(instruction,/never around words \(write 路程\/时间 as plain text\)/u);assert.match(instruction,/@@PDF_INLINE_N@@ token exactly once at its original image position, never inside LaTeX/u);
});

test('a stray dollar before a long row of TeX commands is linear for every $…$ scanner of the OCR and translation stages',()=>{
 // 24 commands took about 5 s with the exponential pattern (each one more doubles it); 2,000 must stay instant
 for(const count of [12,1000]){
  const line=`Giá $5: ${`${B}alpha+${B}beta `.repeat(count)}`;
  for(const run of [()=>normalizeOcrMath(line),()=>mapBareLatex(line,x=>x),()=>protectMathExpressions(line)]){
   const started=performance.now();run();assert.ok(performance.now()-started<1000,`catastrophic backtracking at ${2*count} commands`);
  }
 }
 // the delimiters still work: an escaped dollar and a command inside $…$ stay one math span
 assert.equal(protectMathExpressions(`giá ${B}$5 và $${B}frac{1}{2}$`).formulas.length,1);
});

const env={GEMINI_API_KEY:'student-key-long-enough',GEMINI_MODEL:'gemini-2.5-flash',GEMINI_THINKING:'minimal'};
const gemini=value=>Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
test('math holding Chinese words is translated, other math stays shielded, and Chinese left in a translation is asked for again once, then reported',async t=>{
 const blocks=[{id:'p1-b1',source:`速度 ${B}(v=${B}frac{路程}{时间}${B})，单位是 ${B}(m/s${B})。`},{id:'p1-b2',source:`密度 ${B}frac{质量}{体积}`}];
 const sent=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);sent.push(payload);return gemini({blocks:[{id:'p1-b1',translation:`Vận tốc ${B}(v=${B}frac{quãng đường}{thời gian}${B}), đơn vị là @@MATH_0002@@.`},{id:'p1-b2',translation:`Khối lượng riêng ${B}frac{质量}{thể tích}`}].filter(b=>payload.blocks.some(sentBlock=>sentBlock.id===b.id)),contextUpdate:'',glossaryUpdates:{}});});
 const result=await translatePdfBlocks(env,{blocks});
 assert.equal(sent[0].blocks[0].source,`速度 ${B}(v=${B}frac{路程}{时间}${B})，单位是 @@MATH_0002@@。`);
 assert.equal(sent[0].blocks[1].source,`密度 ${B}frac{质量}{体积}`);
 assert.deepEqual(sent.map(payload=>payload.blocks.map(b=>b.id)),[['p1-b1','p1-b2'],['p1-b2']],'only the block that kept Chinese is asked for again');
 assert.equal(result.blocks[0].translation,`Vận tốc ${B}(v=${B}frac{quãng đường}{thời gian}${B}), đơn vị là ${B}(m/s${B}).`);
 assert.ok(result.warnings.some(w=>/p1-b2.*质量/u.test(w)));assert.ok(!result.warnings.some(w=>/p1-b1/u.test(w)));
});

test('paths, URLs and code stay as written; the general reader renders only delimited math, vectors and elements',()=>{
 for(const text of [`C:${B}Program Files${B}App${B}log${B}error.txt`,`D:${B}data${B}in${B}input.csv`,`${B}${B}server${B}share${B}to${B}file.docx`,`C:${B}Users${B}Lan${B}max${B}deg`,'https://example.com/a_1/b^2?q=x_1','www.example.com/x_1','an@example.com_2'])
  for(const options of [{},{bare:false}])assert.equal(renderMathText(text,options),text.replace(/&/gu,'&amp;'),text);
 // OCR text still renders what a model wrote without delimiters
 assert.match(renderMathText(`x${B}in A, ${B}frac{1}{2}, x^2, H_2O`),/x∈ A, <span class="math-inline"><span class="math-frac"[\s\S]*x<sup>2<\/sup>[\s\S]*H<sub>2<\/sub>O/u);
 // the reader keeps code and tutorials verbatim but still draws delimited math, vectors and element formulas
 const reader=renderMathText(`2^3 là XOR, a_1, ${B}frac{a}{b} và ${B}alpha; ${B}(x^2${B}), ${B}vec{AB}, H_2O`,{bare:false});
 assert.match(reader,/^2\^3 là XOR, a_1, \\frac\{a\}\{b\} và \\alpha; /u);assert.match(reader,/x<sup>2<\/sup>/u);assert.match(reader,/class="math-vector"/u);assert.match(reader,/H<sub>2<\/sub>O/u);
});

// Minimal layout model for fitTextBoxes (as in pdf-render-layout.test.mjs): `ems` em of text wraps across the width.
function layout(specs){
 const document={createRange(){let target;return {selectNodeContents(el){target=el;},getClientRects:()=>target.lines()};}};
 const boxes=specs.map(spec=>({
  dataset:{pending:'false',blockId:spec.id,baseFont:String(spec.base),...(spec.data||{})},textContent:'x',querySelectorAll:()=>[],
  style:{left:`${spec.box[0]}pt`,top:`${spec.box[1]}pt`,width:`${spec.box[2]-spec.box[0]}pt`,height:`${spec.box[3]-spec.box[1]}pt`,fontSize:`${spec.base}pt`,paddingTop:''},
  get offsetHeight(){return parseFloat(this.style.height)*4/3;},get clientWidth(){return Math.round(parseFloat(this.style.width)*4/3);},get scrollWidth(){return this.clientWidth;},
  getBoundingClientRect(){const [l,t,w,h]=['left','top','width','height'].map(k=>parseFloat(this.style[k])*4/3);return {left:l,top:t,right:l+w,bottom:t+h,width:w,height:h};},
  lines(){const box=this.getBoundingClientRect(),px=parseFloat(this.style.fontSize)*4/3,width=spec.ems*px,count=Math.max(1,Math.ceil(width/box.width-1e-9)),height=1.08*px;return Array.from({length:count},(_,i)=>({left:box.left,right:box.left+Math.min(box.width,width-i*box.width),top:box.top+i*height,bottom:box.top+(i+1)*height,width:1,height}));}
 }));
 return {boxes,report:()=>fitTextBoxes({ownerDocument:document,querySelectorAll:()=>boxes})};
}

test('a centred one-line title grows evenly round its printed centre and is set centred; other lines keep their anchor',()=>{
 const {boxes,report}=layout([
  {id:'title',base:10,box:[150,50,250,64],ems:15,data:{centred:'true',roomLeft:'60',roomRight:'340',rowAlone:'false'}},
  {id:'left',base:10,box:[50,100,150,114],ems:15,data:{roomLeft:'30',roomRight:'340',rowAlone:'false'}},
  {id:'label',base:10,box:[300,200,330,214],ems:5,data:{roomLeft:'280',roomRight:'330',rowAlone:'false'}}
 ]);
 const r=Object.fromEntries(report().map(e=>[e.id,e]));
 const [title,left,label]=boxes.map(b=>[parseFloat(b.style.left),parseFloat(b.style.left)+parseFloat(b.style.width)]);
 assert.equal(r.title.fontSize,10);assert.ok(Math.abs((title[0]+title[1])/2-200)<.01,'centre kept');assert.equal(boxes[0].style.textAlign,'center');
 assert.equal(left[0],50);assert.equal(boxes[1].style.textAlign,'');
 // a label stopped on its right (a leader line) takes up to 1.5 em on its left and stays flush right
 assert.ok(label[0]<300&&label[0]>=284.99&&Math.abs(label[1]-330)<.01);assert.equal(boxes[2].style.textAlign,'right');
});

// prepareLayout on a fake page: paper pixels of one colour, boxes as plain objects.
async function prepared({paper=[255,255,255],boxes=[],protectedRegions=[],width=400,height=600}){
 const cw=width,ch=height,data=new Uint8ClampedArray(cw*ch*4);
 for(let i=0;i<cw*ch;i++){data.set(paper,i*4);data[i*4+3]=255;}
 // a few dark strokes, as text on the page
 for(let y=520;y<530;y++)for(let x=40;x<120;x++)data.set([20,20,20],(y*cw+x)*4);
 const filters=Object.fromEntries(['R','G','B'].map(c=>[c,{attributes:{},setAttribute(name,value){this.attributes[name]=value;}}]));
 const elements=boxes.map(([x0,y0,x1,y1,size=10])=>({dataset:{baseFont:String(size)},style:{left:`${x0}pt`,top:`${y0}pt`,width:`${x1-x0}pt`,height:`${y1-y0}pt`}}));
 const background={naturalWidth:cw,naturalHeight:ch};
 const paperEl={classList:{contains:name=>name==='pdf-paper'},style:{width:`${width}pt`,height:`${height}pt`},dataset:{protected:JSON.stringify(protectedRegions)},querySelector:q=>q==='.pdf-background'?background:q.startsWith('#pdf-ink-tone feFunc')?filters[q.at(-1)]:null,querySelectorAll:q=>q==='.pdf-text-box'?elements:[]};
 const saved=globalThis.document;
 globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:(x,y,w,h)=>({data:w===cw&&h===ch?data:new Uint8ClampedArray(w*h*4)})})})};
 try{await prepareLayout(paperEl);}finally{globalThis.document=saved;}
 return {elements,filters};
}

test('the formula crops\' tone curve keeps each channel\'s paper level and above, and never lightens',async()=>{
 const {filters}=await prepared({paper:[235,230,200]});
 for(const [c,level] of [['R',235],['G',230],['B',200]]){
  const values=filters[c].attributes.tableValues.split(' ').map(Number);assert.equal(values.length,129);
  values.forEach((value,k)=>{const v=k/128;assert.ok(value<=v+1e-4,`${c} ${k} lighter`);if(v>=level/255)assert.ok(Math.abs(value-v)<1e-4,`${c} ${k} paper changed`);});
  assert.ok(values[32]<32/128-.05,`${c} midtones are darkened`);
 }
});

test('prepareLayout marks a one-line source centred in its column or under its figure, never a line at the margin',async()=>{
 const {elements}=await prepared({boxes:[[150,50,250,64],[50,100,350,200],[50,220,150,234],[160,405,240,417],[60,450,340,464]],protectedRegions:[[100,300,300,400]]});
 const [title,body,left,caption,wide]=elements;
 assert.equal(title.dataset.centred,'true');assert.equal(caption.dataset.centred,'true');
 for(const el of [body,left,wide])assert.equal(el.dataset.centred,undefined);
 assert.ok(Number(title.dataset.roomLeft)<150&&Number(title.dataset.roomRight)>250);
});

test('a label among labels of one width is not held to their width: it may grow into the blank paper beside it',async()=>{
 const {elements}=await prepared({boxes:[[60,380,355,500],[368,410,395,419,9],[368,442,395,451,9],[368,475,395,484,9]],width:600});
 for(const label of elements.slice(1))assert.ok(Number(label.dataset.roomRight)>395+9,label.dataset.roomRight);
 // a heading over its column still stops at the column's edge
 const {elements:[column,heading]}=await prepared({boxes:[[60,100,300,200],[60,60,150,74],[320,100,560,200]],width:600});
 assert.ok(Number(heading.dataset.roomRight)<=300.01,heading.dataset.roomRight);
});

test('A scanned block Gemini could not read keeps the page pixels: no mask, no text box, its box protected; a translation typed for it is drawn as text',()=>{
 // keepPixels (backend/pdf-layout-apply.js): the study page puts the source back as its translation (frontend/study.js).
 const kept={id:'p1-b1',source:'[□][□]',fontSize:10,box:[50,100,550,160],keepPixels:true},other={id:'p1-b2',source:'原文',fontSize:10,box:[50,200,550,260]},waiting={id:'p1-b3',source:'等待',fontSize:10,box:[50,300,550,360]};
 const html=pageMarkup(page([kept,other,waiting]),new Map([['p1-b1','[□][□]'],['p1-b2','Bản dịch']]));
 assert.equal((html.match(/class="pdf-original-patch"/gu)||[]).length,1);
 assert.match(html,/<div class="pdf-original-patch" data-block-id="p1-b1" aria-hidden="true" style="left:50pt;top:100pt;width:500pt;height:60pt"><\/div>/u);
 assert.match(html,/<clipPath id="pdf-keep-1"><rect x="50" y="100" width="500" height="60"\/><\/clipPath><image href="data:image\/png;base64,QUJD" width="600" height="800" preserveAspectRatio="none" clip-path="url\(#pdf-keep-1\)"\/>/u);
 // Two blocks kept on one page draw the original once, clipped to both boxes (a scan page is 1-3 MB of data URL).
 const twice=pageMarkup(page([kept,{...waiting,keepPixels:true,source:'[□]'}]),new Map([['p1-b1','[□][□]'],['p1-b3','[□]']]));
 assert.equal((twice.match(/class="pdf-original-patch"/gu)||[]).length,2);assert.equal((twice.match(/<image href="data:image\/png;base64,QUJD"/gu)||[]).length,1);
 assert.equal((twice.match(/<rect /gu)||[]).length,2);
 assert.doesNotMatch(html,/class="pdf-text-box" data-block-id="p1-b1"/u);
 assert.equal((html.match(/class="pdf-text-mask"/gu)||[]).length,1);assert.match(html,/class="pdf-text-box" data-block-id="p1-b2"/u);
 assert.match(html,/data-translated-blocks="2"/u);assert.match(html,/data-protected="\[\[50,100,550,160\]\]"/u);
 // A translation the student typed for it is drawn like any other; so is a block read for good.
 const typed=pageMarkup(page([kept,other]),new Map([['p1-b1','Chữ đã sửa'],['p1-b2','Bản dịch']]));
 assert.doesNotMatch(typed,/pdf-original-patch/u);assert.match(typed,/class="pdf-text-box" data-block-id="p1-b1"/u);assert.match(typed,/data-protected="\[\]"/u);
 assert.doesNotMatch(pageMarkup(page([{...kept,keepPixels:undefined}]),new Map([['p1-b1','[□][□]']])),/pdf-original-patch/u);
});
