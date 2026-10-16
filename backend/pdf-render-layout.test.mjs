import test from 'node:test';
import assert from 'node:assert/strict';
import {pageMarkup,fitTextBoxes,inlineGeometry,dropRepeatedPunctuation,joinSameRowBreaks,keepDisplayRows,blockText,bodySizes,singleSourceRow,pageVersion,TEXT_AXIS_EM} from '../frontend/pdf-box-layout.js';

const png='data:image/png;base64,QUJD';
const token=n=>`@@PDF_INLINE_${n}@@`;
const inline=(n,box,extra={})=>({token:token(n),image:png,text:'',box,width:box[2]-box[0],height:box[3]-box[1],...extra});
const page=(blocks,extra={})=>({number:1,width:600,height:800,original:png,background:png,extractionVersion:3,blocks,...extra});
const markup=(b,translation,extra)=>pageMarkup(page([{source:'原文',fontSize:10,box:[50,100,550,160],...b}],extra),new Map([[b.id,translation]]));

test('formula images are sized in em of the base font and put the extractor axis on the text axis',()=>{
 // A 15pt crop whose row axis is at its middle: the axis lands TEXT_AXIS_EM above the baseline.
 const g=inlineGeometry(inline(1,[100,200,150,215],{axis:207.5}),10);
 assert.equal(g.width,5);assert.equal(g.height,1.5);assert.ok(Math.abs(g.align-(TEXT_AXIS_EM-.75))<1e-9);
 // A crop with an arrow above (axis in its lower part) is raised less than its middle would suggest.
 assert.ok(Math.abs(inlineGeometry(inline(1,[0,0,20,20],{axis:14}),10).align-(TEXT_AXIS_EM-.6))<1e-9);
 // No axis, or an axis far outside the crop: no alignment value, the stylesheet's fallback applies.
 for(const extra of [{},{axis:'207'},{axis:NaN},{axis:400},{axis:150}])assert.equal(inlineGeometry(inline(1,[100,200,150,215],extra),10).align,null);
 assert.equal(inlineGeometry({...inline(1,[100,200,150,215]),box:'x',axis:207},10).align,null);
 const html=markup({id:'p1-b1',inlines:[inline(1,[100,200,150,215],{axis:207.5})]},`Vectơ ${token(1)} và chữ`);
 assert.match(html,/<img class="pdf-inline"[^>]*data-tight="true"[^>]*style="width:5\.0000em;height:1\.5000em;vertical-align:-0\.3700em">/u);
});

test('newer crops are never re-trimmed; older crops get a trim hint only when the translation writes punctuation after them',()=>{
 const b={id:'p1-b1',inlines:[inline(1,[100,200,150,215])]};
 const newer=markup(b,`dựng ${token(1)}, khi đó`);assert.match(newer,/data-tight="true"/u);assert.doesNotMatch(newer,/data-next-punct/u);
 const older=markup(b,`dựng ${token(1)}, khi đó`,{extractionVersion:2});assert.doesNotMatch(older,/data-tight/u);assert.match(older,/data-next-punct=","/u);
 assert.doesNotMatch(markup(b,`dựng ${token(1)} khi đó`,{extractionVersion:2}),/data-next-punct/u);
 // An axis marks the crop as ink-tight even inside an older document.
 assert.match(markup({...b,inlines:[inline(1,[100,200,150,215],{axis:207})]},`${token(1)}, x`,{extractionVersion:2}),/data-tight="true"/u);
 assert.equal(pageVersion({extractionVersion:3},{extractionVersion:2}),3);assert.equal(pageVersion({},{extractionVersion:2}),2);assert.equal(pageVersion({},{}),0);
});

test('a formula image is glued to the punctuation after it and to a crop written with no space, never to the next word',()=>{
 const b={id:'p1-b1',inlines:[inline(1,[100,200,150,215]),inline(2,[150,200,190,215])]};
 const comma=markup(b,`dựng ${token(1)} ${token(2)}, khi đó`);
 assert.match(comma,/<span class="pdf-nobr"><img[^>]*>,<\/span> khi đó/u);assert.equal((comma.match(/class="pdf-nobr"/gu)||[]).length,1);
 const glued=markup(b,`chứng ${token(1)}${token(2)} minh`);assert.match(glued,/<span class="pdf-nobr"><img[^>]*><img[^>]*><\/span> minh/u);
 assert.doesNotMatch(markup(b,`a ${token(1)} b ${token(2)} c`),/pdf-nobr/u);
});

test('formula markup survives "$" patterns in OCR alt text, private-use characters and tokens inside TeX',()=>{
 for(const text of ['S$&T',"a$'b",'$`x','$1$2']){
  const html=markup({id:'p1-b1',inlines:[inline(1,[100,200,150,215],{text}),inline(2,[150,200,190,215])]},`Một ${token(1)} hai ${token(2)} ba`);
  assert.equal((html.match(/<img class="pdf-inline"/gu)||[]).length,2,text);assert.doesNotMatch(html,/@@PDF_INLINE/u,text);assert.ok(html.includes(`alt="${text.replace(/&/gu,'&amp;').replace(/'/gu,'&#39;')}"`),text);
 }
 const privateUse=String.fromCharCode(0xE000);
 const pua=markup({id:'p1-b1',inlines:[inline(1,[100,200,150,215])]},`${privateUse} ${token(1)}`);assert.equal((pua.match(/<img class="pdf-inline"/gu)||[]).length,1);assert.ok(pua.includes(String.fromCharCode(0xFFFD)));
 const tex=markup({id:'p1-b1',inlines:[inline(1,[100,200,150,215])]},String.raw`Cho \(${token(1)} + \frac{1}{2}\) xong`);
 assert.match(tex,/<span class="math-inline"><img class="pdf-inline"[^>]*> \+ <span class="math-frac"/u);assert.doesNotMatch(tex,/<sub>|PDF_INLINE/u);
});

test('the duplicate punctuation guard needs evidence that the crop already ends with the same mark',()=>{
 const b=(item,tight)=>[{inlines:[{token:token(1),...item}]},{tight}];
 const apply=(item,text,tight=false)=>{const [block,options]=b(item,tight);return dropRepeatedPunctuation(block,text,options);};
 // Older manifests: Tesseract's text of the crop ends with the mark.
 assert.equal(apply({text:' OB=b,'},`${token(1)}, khi đó`),`${token(1)} khi đó`);
 assert.equal(apply({text:' OB=b,'},`${token(1)}，khi đó`),`${token(1)} khi đó`,'a full-width comma is the same mark; the image never touches the next word');
 assert.equal(apply({text:' (AB+AC).'},`${token(1)}.`),token(1));
 for(const [item,text] of [[{text:'OB=b'},`${token(1)}, khi đó`],[{text:'x.'},`${token(1)}, khi đó`],[{text:'x,'},`${token(1)}... tiếp`],[{text:'x,'},`${token(1)}′, y`],[{text:'x,'},`${token(1)} và, y`]])assert.equal(apply(item,text),text,JSON.stringify(item)+text);
 // Newer manifests: only the extractor's trail flag counts; a trimmed crop's text is no evidence.
 assert.equal(apply({text:'x,'},`${token(1)}, y`,true),`${token(1)}, y`);
 assert.equal(apply({text:'x',trail:true},`${token(1)}; y`,true),`${token(1)} y`);
 assert.equal(apply({text:'x,',trail:true},`${token(1)}. Y`,true),`${token(1)}. Y`,'a different mark is kept');
 assert.equal(apply({text:'x,',trail:false},`${token(1)}, y`),`${token(1)}, y`);
});

test('line structure: same-row formulas are rejoined, display rows keep their break, prose is untouched',()=>{
 // Exercise row of page 7: four crops on one printed row, separated by OCR newlines.
 const row={box:[60.5,708.6,527.6,774.5],fontSize:9,inlines:[inline(1,[89.4,709.5,166.1,732.3]),inline(2,[238.3,709.5,270,732.3]),inline(3,[284.6,709.5,335.7,732.3]),inline(4,[433.1,709.5,489,732.3])]};
 const text=`(1) ${token(1)}\n(2) ${token(2)} x (${token(3)}\n(3) y ${token(4)}\n5. Như hình vẽ`;
 assert.equal(joinSameRowBreaks(row,text),`(1) ${token(1)}    (2) ${token(2)} x (${token(3)}    (3) y ${token(4)}\n5. Như hình vẽ`);
 const rows={...row,inlines:[inline(1,[89,700,160,712]),inline(2,[89,715,160,727]),inline(3,[60,730,70,742]),inline(4,[300,729,320,741])]};
 assert.equal(joinSameRowBreaks(rows,`${token(1)}\n${token(2)}\n${token(4)}\n${token(3)}`),`${token(1)}\n${token(2)}\n${token(4)}\n${token(3)}`,'different rows, or right-to-left order on one row');
 // Page 7 proof: a row of formulas only, reaching the right edge, joined by OCR to the next sentence.
 const display={box:[84.9,353,336.4,388.9],fontSize:9.8,inlines:[inline(1,[92.7,353.3,150.2,365.6]),inline(2,[153.8,353.3,211.4,368.9]),inline(3,[211.4,353.3,336.4,368.9])]};
 assert.equal(keepDisplayRows(display,`${token(1)}, ${token(2)}${token(3)} Vì tứ giác`),`${token(1)}, ${token(2)}${token(3)}\nVì tứ giác`);
 assert.equal(keepDisplayRows(display,`${token(1)} và ${token(2)}${token(3)} Vì`),`${token(1)} và ${token(2)}${token(3)} Vì`,'words between the formulas');
 assert.equal(keepDisplayRows(display,`Ta có hệ thức ${token(1)}, ${token(2)}${token(3)} Vì`),`Ta có hệ thức ${token(1)}, ${token(2)}${token(3)} Vì`,'a sentence before the formulas');
 assert.equal(keepDisplayRows({...display,box:[84.9,353,500,388.9]},`${token(1)}, ${token(2)}${token(3)} Vì`),`${token(1)}, ${token(2)}${token(3)} Vì`,'the row did not reach the right edge');
 // Text-only blocks (any genre): only blank lines collapse; single line breaks (verse, lists) stay.
 const prose={source:'诗',inlines:[]};
 assert.equal(blockText(prose,'  Câu một\n\n\nCâu hai\r\nCâu ba  '),'Câu một\nCâu hai\nCâu ba');
 assert.equal(blockText(prose,'Không có dấu, phẩy. Dòng\ncuối'),'Không có dấu, phẩy. Dòng\ncuối');
});

test('body sizes within 4% share one base per page; bold headings and clearly different sizes keep theirs',()=>{
 const sizes=bodySizes([{id:'a',fontSize:9,source:'x'.repeat(10)},{id:'b',fontSize:9.1,source:'x'.repeat(300)},{id:'c',fontSize:9.3,source:'x'},{id:'d',fontSize:9.8,source:'x'},{id:'e',fontSize:9.1,bold:true,source:'x'},{id:'f',fontSize:12.6,bold:true,source:'x'}]);
 assert.deepEqual(['a','b','c'].map(id=>sizes.get(id).base),[9.1,9.1,9.1]);assert.equal(new Set(['a','b','c'].map(id=>sizes.get(id).group)).size,1);
 assert.equal(sizes.get('d').base,9.8);assert.notEqual(sizes.get('d').group,sizes.get('a').group);assert.equal(sizes.get('e').base,9.1);assert.notEqual(sizes.get('e').group,sizes.get('b').group);assert.equal(sizes.get('f').base,12.6);
 const html=pageMarkup(page([{id:'p1-b1',source:'原文',fontSize:9,box:[50,100,550,160],indent:21},{id:'p1-b2',source:'很长的原文'.repeat(20),fontSize:9.1,box:[50,200,550,260],indent:-4}],{protectedRegions:[[1,2,3,4],[5,'x',6,7],'<b>']}),new Map([['p1-b1','Một'],['p1-b2','Hai']]));
 assert.match(html,/data-block-id="p1-b1" data-base-font="9.1" data-size-group="g0"[^>]*font-size:9.1pt;[^>]*;text-indent:21.00pt"/u);assert.doesNotMatch(html,/data-block-id="p1-b2"[^>]*text-indent/u);
 assert.match(html,/data-protected="\[\[1,2,3,4\]\]"/u);
});

test('only a block whose source was one printed row is centred beside a tall formula',()=>{
 const proof={source:`因为 ${token(1)}`,box:[118.6,317.4,277.6,345.1],fontSize:9.8,inlines:[{...inline(1,[148.3,332.4,255.8,344.4]),width:107.5}]};
 assert.equal(singleSourceRow(proof),true);
 assert.equal(singleSourceRow({...proof,source:`对任意两个空间向量\n${token(1)} 反过来`}),false);
 assert.equal(singleSourceRow({...proof,source:`${'对任意两个空间向量'.repeat(3)} ${token(1)}`}),false);
 assert.match(pageMarkup(page([{id:'p1-b1',...proof}]),new Map([['p1-b1',`Vì ${token(1)}`]])),/data-inlines="1" data-one-row="true"/u);
});

// Minimal layout model for fitTextBoxes: `ems` em of text wraps into lines of 1.08em across the box width.
function layout(specs){
 const document={createRange(){let target;return {selectNodeContents(el){target=el;},getClientRects:()=>target.lines()};}};
 const boxes=specs.map(spec=>({
  dataset:{pending:'false',blockId:spec.id,baseFont:String(spec.base),...(spec.data||{})},textContent:spec.text||'x',querySelectorAll:()=>[],
  style:{left:`${spec.box[0]}pt`,top:`${spec.box[1]}pt`,width:`${spec.box[2]-spec.box[0]}pt`,height:`${spec.box[3]-spec.box[1]}pt`,fontSize:`${spec.base}pt`,paddingTop:''},
  get offsetHeight(){return parseFloat(this.style.height)*4/3;},get clientWidth(){return Math.round(parseFloat(this.style.width)*4/3);},get scrollWidth(){return this.clientWidth;},
  getBoundingClientRect(){const [l,t,w,h]=['left','top','width','height'].map(k=>parseFloat(this.style[k])*4/3);return {left:l,top:t,right:l+w,bottom:t+h,width:w,height:h};},
  lines(){const box=this.getBoundingClientRect(),px=parseFloat(this.style.fontSize)*4/3,width=spec.ems*px,count=Math.max(1,Math.ceil(width/box.width-1e-9)),height=1.08*px;return Array.from({length:count},(_,i)=>({left:box.left,right:box.left+Math.min(box.width,width-i*box.width),top:box.top+i*height,bottom:box.top+(i+1)*height,width:1,height}));}
 }));
 return {root:{ownerDocument:document,querySelectorAll:()=>boxes},boxes,report:options=>fitTextBoxes({ownerDocument:document,querySelectorAll:()=>boxes},options)};
}
const byId=report=>Object.fromEntries(report.map(entry=>[entry.id,entry]));

test('fitting keeps the base size when the text fits, and grows a box into measured room before shrinking',()=>{
 const {report,boxes}=layout([
  {id:'fits',base:10,box:[50,50,350,90],ems:40},
  // One-line source (a heading): widens into blank room on its right, never wraps downward beside other words.
  {id:'heading',base:10,box:[50,100,150,114],ems:15,data:{roomRight:'300',roomBottom:'200',rowAlone:'false'}},
  // A paragraph keeps its measure and grows down; room on its right is ignored.
  {id:'paragraph',base:10,box:[50,300,350,340],ems:100,data:{roomRight:'500',roomBottom:'420'}},
  // A heading alone on its row may also wrap into blank room below it when widening is not enough.
  {id:'alone',base:10,box:[50,500,150,514],ems:15,data:{roomRight:'150',roomBottom:'560',rowAlone:'true'}}
 ]);
 const r=byId(report());
 assert.deepEqual([r.fits.fontSize,r.fits.grown,r.fits.shrunk,r.fits.overflow],[10,null,false,false]);
 assert.deepEqual([r.heading.fontSize,r.heading.grown],[10,[150,0]]);assert.equal(boxes[1].style.height,'14pt');
 assert.equal(r.paragraph.fontSize,10);assert.equal(r.paragraph.grown[0],0);assert.ok(r.paragraph.grown[1]>3&&r.paragraph.grown[1]<5,'grown down only as far as the content needs');
 assert.equal(r.alone.fontSize,10);assert.ok(r.alone.grown[1]>0);
});

test('a one-line heading stays on one line down to 85% of its size before it wraps into the room below',()=>{
 // 30 em of text: one line of 270pt needs 9pt (90%); two lines at the full 10pt would also fit below it.
 const {report,boxes}=layout([{id:'title',base:10,box:[50,50,150,64],ems:30,data:{roomRight:'320',roomBottom:'200',rowAlone:'true'}},{id:'long',base:10,box:[50,300,150,314],ems:60,data:{roomRight:'320',roomBottom:'400',rowAlone:'true'}}]);
 const r=byId(report());
 assert.ok(r.title.fontSize>8.5&&r.title.fontSize<10);assert.equal(parseFloat(boxes[0].style.height),14,'still one line');
 // Below the 85% floor on one line, it wraps instead of shrinking further.
 assert.equal(r.long.fontSize,10);assert.ok(parseFloat(boxes[1].style.height)>20);
});

test('shrinking stops at 85% of the base, then 60%, and only then reaches the absolute minimum and overflow',()=>{
 const {report}=layout([
  {id:'slight',base:10,box:[50,50,350,90],ems:108},
  {id:'fragment',base:10,box:[50,100,150,114],ems:15,data:{roomBottom:'300',rowAlone:'false'}},
  {id:'impossible',base:10,box:[50,200,350,240],ems:10000},
  {id:'tiny',base:5,box:[50,300,350,340],ems:10000}
 ]);
 const r=byId(report());
 assert.ok(r.slight.fontSize>=8.5&&r.slight.fontSize<10&&!r.slight.shrunk);
 // Text beside other printed words on its row is shrunk on its one line rather than wrapped below.
 assert.ok(r.fragment.fontSize<8.5&&r.fragment.fontSize>=6&&r.fragment.shrunk&&!r.fragment.grown);
 assert.deepEqual([r.impossible.fontSize,r.impossible.overflow],[5.5,true]);assert.deepEqual([r.tiny.fontSize,r.tiny.overflow],[5,true]);
});

test('blocks of one size group end at one size, a block far below it keeps its own, and grown boxes never overlap',()=>{
 const {report,boxes}=layout([
  {id:'a',base:10,box:[50,50,350,90],ems:20,data:{sizeGroup:'g1'}},
  {id:'b',base:10,box:[50,100,350,140],ems:105,data:{sizeGroup:'g1'}},
  {id:'c',base:10,box:[50,150,350,190],ems:200,data:{sizeGroup:'g1'}},
  {id:'grows',base:10,box:[50,300,350,340],ems:200,data:{roomBottom:'500'}},
  {id:'later',base:10,box:[10,350,40,360],ems:10,data:{roomRight:'300'}}
 ]);
 const r=byId(report());
 assert.ok(r.b.fontSize<10);assert.equal(r.a.fontSize,r.b.fontSize);assert.equal(r.a.unified,true);assert.ok(r.c.fontSize<r.b.fontSize*.95&&!r.c.unified);
 const bottom=parseFloat(boxes[3].style.top)+parseFloat(boxes[3].style.height);assert.ok(bottom>360,'the paragraph grew past the later block row');
 assert.ok(parseFloat(boxes[4].style.left)+parseFloat(boxes[4].style.width)<=48,'the later block does not widen into the grown paragraph');
});

test('a single printed row made tall by a stacked formula is centred; other short translations stay at the top',()=>{
 const {report,boxes}=layout([{id:'row',base:10,box:[50,50,250,90],ems:5,data:{oneRow:'true',inlines:'1'}},{id:'para',base:10,box:[50,100,250,140],ems:5,data:{inlines:'1'}}]);
 const r=byId(report());assert.equal(r.row.centred,true);assert.ok(parseFloat(boxes[0].style.paddingTop)>10);assert.equal(r.para.centred,undefined);assert.equal(boxes[1].style.paddingTop,'');
});
