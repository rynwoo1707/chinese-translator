const pageLabel=/^(?:(?:[-–—]\s*)?\d+(?:\s*[-–—])?|(?:trang|page)\s*\d+(?:\s*[\/／]\s*\d+)?|第?\s*\d+\s*[页頁])$/iu;
const normalizeText=text=>String(text||'').replace(/[\u00a0\u2000-\u200b\u3000]/gu,' ').replace(/[ \t]+/gu,' ').trim();
const HAN=/\p{Script=Han}/u;
const HEADING=/^(?:\d+(?:[.．]\d+){1,4}[\s、．.]|第.{1,12}[章节節篇部]|(?:chapter|section)\s+\d+)/iu;
const CAPTION=/^(?:图|圖|表|figure|fig\.|hình)\s*\d+(?:[.．–-]\d+)*/iu;
const SENTENCE_END=/[。！？!?；;：:]\s*[”’」』）)]?$/u;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:0;};

export function normalizePolygon(poly,width,height){
 if(!(width>0&&height>0)||!Array.isArray(poly)||poly.length<3)return null;
 const points=poly.map(point=>Array.isArray(point)?point:[point?.x,point?.y]);
 if(points.some(point=>!point.every(Number.isFinite)))return null;
 const xs=points.map(point=>Math.max(0,Math.min(1,point[0]/width))),ys=points.map(point=>Math.max(0,Math.min(1,point[1]/height)));
 const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
 return w>0&&h>0?{x,y,width:w,height:h}:null;
}

// A conservative gutter heuristic, not a document-layout classifier. Spanning
// headings are kept above the two columns; diagrams are never erased or cropped.
export function orderLayoutBlocks(blocks){
 const sorted=[...blocks].sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
 const left=sorted.filter(b=>b.box.x+b.box.width<.49),right=sorted.filter(b=>b.box.x>.51);
 if(left.length<3||right.length<3)return sorted;
 const columnTop=Math.max(left[0].box.y,right[0].box.y),columnBottom=Math.min(...[left,right].map(list=>Math.max(...list.map(b=>b.box.y+b.box.height))));
 if(columnBottom-columnTop<.15)return sorted;
 const spanning=sorted.filter(b=>!left.includes(b)&&!right.includes(b));
 if(spanning.some(b=>b.box.y>columnTop&&b.box.y<columnBottom))return sorted;
 return [...spanning.filter(b=>b.box.y<=columnTop),...left,...right,...spanning.filter(b=>b.box.y>columnTop)];
}

// Keep the original line rectangles for inspection, but send actual paragraphs
// to translation. Only join neighboring lines with compatible geometry.
export function structureLayoutBlocks(input){
 const blocks=input.map(block=>({...block})),paragraphs=[];
 const bodyHeight=median(blocks.filter(block=>block.text.length>8).map(block=>block.box.height))||median(blocks.map(block=>block.box.height));
 const bodyWidth=median(blocks.filter(block=>block.text.length>8).map(block=>block.box.width));
 for(const block of blocks){
  const box=block.box;
  block.kind=CAPTION.test(block.text)&&block.text.length<100?'caption':HEADING.test(block.text)||(bodyHeight&&box.height>bodyHeight*1.35&&block.text.length<100)?'heading':'paragraph';
  const previous=paragraphs.at(-1),last=previous?.lines.at(-1),lastBox=last?.box;
  let joins=false;
  if(last&&block.kind==='paragraph'&&previous.kind==='paragraph'){
   const height=Math.max(box.height,lastBox.height),gap=box.y-lastBox.y-lastBox.height;
   const overlap=Math.min(box.x+box.width,lastBox.x+lastBox.width)-Math.max(box.x,lastBox.x);
   const sameColumn=overlap>=Math.min(box.width,lastBox.width)*.55;
   const charWidth=Math.min(lastBox.width/Math.max(1,[...last.text].length),box.width/Math.max(1,[...block.text].length)),indent=box.x-previous.box.x;
   const startsIndented=indent>Math.max(.012,charWidth*1.2);
   const paragraphEnd=SENTENCE_END.test(last.text)&&(startsIndented||(bodyWidth&&lastBox.width<bodyWidth*.72));
   const nativeBoundary=last.sourceParagraph!==undefined&&block.sourceParagraph!==undefined&&last.sourceParagraph!==block.sourceParagraph;
   const symbolLine=block.text.length<=3||last.text.length<=3;
   joins=!nativeBoundary&&!paragraphEnd&&!symbolLine&&sameColumn&&gap>=-height*.25&&gap<=height*.85;
  }
  if(joins){
   previous.lines.push(block);
   const right=Math.max(previous.box.x+previous.box.width,box.x+box.width),bottom=Math.max(previous.box.y+previous.box.height,box.y+box.height);
   previous.box.x=Math.min(previous.box.x,box.x);previous.box.y=Math.min(previous.box.y,box.y);previous.box.width=right-previous.box.x;previous.box.height=bottom-previous.box.y;
  }else paragraphs.push({id:`paragraph-${paragraphs.length+1}`,kind:block.kind,box:{...box},lines:[block]});
 }
 let text='';
 for(const paragraph of paragraphs){
  if(text)text+='\n\n';
  paragraph.textStart=text.length;paragraph.blockIds=paragraph.lines.map(block=>block.id);
  for(const [index,block] of paragraph.lines.entries()){
   if(index){const last=paragraph.lines[index-1].text;const chineseBoundary=HAN.test(last.at(-1))||HAN.test(block.text[0]);text+=chineseBoundary?'':' ';}
   block.textStart=text.length;text+=block.text;block.textEnd=text.length;
  }
  paragraph.textEnd=text.length;paragraph.text=text.slice(paragraph.textStart,paragraph.textEnd);delete paragraph.lines;
 }
 return {blocks,paragraphs,text};
}

export function normalizeOcrLayout(result,engine='paddle'){
 const width=Number(result?.image?.width)||0,height=Number(result?.image?.height)||0;
 const blocks=[];
 for(const [index,item] of (result?.items||[]).entries()){
  const text=normalizeText(item.text),box=normalizePolygon(item.poly,width,height);
  if(!text||!box)continue;
  // Numbers in equations/figure labels inside the page must survive cleaning.
  if((box.y<.035||box.y+box.height>.95)&&pageLabel.test(text))continue;
  blocks.push({id:`line-${index+1}`,text,box,confidence:Math.round(Math.max(0,Math.min(1,Number(item.score)||0))*100),...(item.sourceParagraph!==undefined?{sourceParagraph:item.sourceParagraph}:{})});
 }
 const ordered=orderLayoutBlocks(blocks),weight=ordered.reduce((sum,b)=>sum+b.text.length,0);
 return {engine,width,height,...structureLayoutBlocks(ordered),confidence:weight?ordered.reduce((sum,b)=>sum+b.confidence*b.text.length,0)/weight:0,metrics:result?.metrics||{}};
}

export function tesseractLayout(data,width,height){
 const lines=(data?.blocks||[]).flatMap((block,blockIndex)=>(block.paragraphs||[]).flatMap((paragraph,paragraphIndex)=>(paragraph.lines||[]).map(line=>({...line,sourceParagraph:`${blockIndex}-${paragraphIndex}`}))));
 return normalizeOcrLayout({image:{width,height},items:lines.map(line=>({text:line.text,sourceParagraph:line.sourceParagraph,score:line.confidence/100,poly:[[line.bbox.x0,line.bbox.y0],[line.bbox.x1,line.bbox.y0],[line.bbox.x1,line.bbox.y1],[line.bbox.x0,line.bbox.y1]]}))},'tesseract');
}

const inside=(outer,inner,pad=.002)=>inner.x>=outer.x-pad&&inner.y>=outer.y-pad&&inner.x+inner.width<=outer.x+outer.width+pad&&inner.y+inner.height<=outer.y+outer.height+pad;
// Once exact source pixels preserve a diagram, its short point labels should
// not become stray translated paragraphs. The numbered caption stays so the
// translated passage can refer to and position the correct figure.
export function textOutsideFigures(layout,figures=[]){
 const blocks=layout?.blocks||[];if(!blocks.length||!figures.length)return String(layout?.text||'');
 const kept=blocks.filter(block=>CAPTION.test(block.text)||!figures.some(figure=>inside(figure.box,block.box)));
 if(kept.length===blocks.length||!kept.length)return String(layout?.text||'');
 return structureLayoutBlocks(kept).text;
}

export function splitTranslationText(text,limit=5000){
 if(!Number.isInteger(limit)||limit<2)throw new RangeError('Translation limit must be an integer of at least 2.');
 const pieces=[];let remaining=String(text);
 while(remaining.length>limit){
  let end=remaining.lastIndexOf('\n\n',limit-2);if(end>=0)end+=2;
  if(end<limit/2){end=remaining.lastIndexOf('\n',limit-1);if(end>=0)end++;}
  if(end<limit/2){end=0;for(const match of remaining.slice(0,limit).matchAll(/[。！？!?；;]\s*/gu))end=match.index+match[0].length;}
  if(end<limit/2)end=limit;
  if(/[\uD800-\uDBFF]/u.test(remaining[end-1]))end--;
  pieces.push(remaining.slice(0,end));remaining=remaining.slice(end);
 }
 if(remaining)pieces.push(remaining);return pieces;
}

export function joinedPageText(pages){return [...pages].sort((a,b)=>a[0]-b[0]).map(([,entry])=>entry.text).filter(Boolean).join('\n\n').trim();}
function pageBlockSpans(entry){
 const source=String(entry.text||''),blocks=entry.layout?.blocks||[];
 if(source===entry.layout?.text&&blocks.every(block=>Number.isInteger(block.textStart)&&Number.isInteger(block.textEnd)))return blocks.map(block=>({id:block.id,start:block.textStart,end:block.textEnd}));
 // Older OCR and PDF text extraction may retain different line wrapping. Match
 // text in reading order instead of assuming a single newline after every box.
 const positions=[];let compact='';
 for(let index=0;index<source.length;index++)if(!/\s/u.test(source[index])){compact+=source[index];positions.push(index);}
 let cursor=0;const spans=[];
 for(const block of blocks){
  const text=block.text.replace(/\s/gu,'');if(!text)continue;
  const start=compact.indexOf(text,cursor);if(start<0)continue;
  const end=start+text.length;spans.push({id:block.id,start:positions[start],end:positions[end-1]+1});cursor=end;
 }
 return spans;
}
export function createTranslationPlan(source,pages=new Map(),limit=5000){
 // Manual edits invalidate positional alignment rather than attach the wrong page.
 if(!pages.size||source.trim()!==joinedPageText(pages))return splitTranslationText(source,limit).map(text=>({text,pages:[],blockIds:{}}));
 const parts=[];
 for(const [number,entry] of [...pages].sort((a,b)=>a[0]-b[0])){
  if(!entry.text?.trim())continue;
  let offset=0;const spans=pageBlockSpans(entry);
  for(const text of splitTranslationText(entry.text,limit)){
   const ids=spans.filter(block=>block.end>offset&&block.start<offset+text.length).map(block=>block.id);
   // A translation belongs to exactly one source page, including its figures.
   // Long pages still split into requests; short neighboring pages stay apart.
   parts.push({text,pages:[number],blockIds:{[number]:ids}});
   offset+=text.length;
  }
 }
 return parts;
}

// ---- Page furniture and wrapped lines, for text read from a PDF (pdf-client.js) or extracted by the server ----
// A line that opens a heading, a caption, a numbered or lettered item, a speaker's words or a bracketed label: 第三章…,
// 第二节…, 第一单元…, 一、…, （一）…, 1.2…, 1. …, ①…, 图3-1…, 表2…, 例1…, A．…, 甲：…, 答：…, 【答案】…, [1]…. A line break
// before it is kept.
export const LINE_START=/^(?:第[^\s，。,.；;：:]{1,12}?(?:[章节節回卷篇部课課讲講]|单元|單元)|[一二三四五六七八九十百]{1,4}[、．.]|[（(](?:[一二三四五六七八九十]{1,3}|\d{1,3})[）)]|\d{1,3}(?:[.．]\d{1,3}){1,4}(?![\d.．])|\d{1,3}[.．、](?![\d.．])|[①-⑳]|(?:图|圖|表|figure|fig\.|hình)\s*\d+(?:[.．–-]\d+)*|例(?:题|題)?\s*\d+|(?:chapter|section)\s+\d+|[A-HＡ-Ｈ][.．、)）]|\p{Script=Han}{1,4}[：:]|[【〔\[][^】〕\]]{1,6}[】〕\]])/iu;
// A line that only labels a page, wherever it stands: "- 12 -", "Trang 5/6", "Page 12", "第 12 页" (backend/pdf-cleaning.js
// takes the same). A bare number ("12", "1958", "3/4") is none by itself: it is an answer, a year or a fraction as often
// as a page number; so is "12 页" in a page's body (EDGE_LABEL: a label at a page's edge only).
export const PAGE_LABEL=/^(?:[-–—]\s*\d{1,4}\s*[-–—]|(?:trang|page)\s*\d{1,4}(?:\s*[/／]\s*\d{1,4})?|第\s*\d{1,4}\s*[页頁](?:\s*[,，]?\s*共\s*\d{1,4}\s*[页頁])?)$/iu;
const EDGE_LABEL=/^\d{1,4}\s*[页頁](?:\s*[,，]?\s*共\s*\d{1,4}\s*[页頁])?$/u;
const END_PUNCT=/[。！？!?；;：:…」』”’）】]$/u;
// What a guessed edge never loses: an answer or a question's stem (…：, …略), a sentence or a clause.
const CONTENT=/[：:略]$|[。！？!?；;，,…]/u;
const lineKey=text=>normalizeText(text).toLocaleLowerCase();
// The page number a line at a page's edge may carry: alone, as a label, or before or after a running head
// ("8 第一章 函数", "第一章 函数 9"); rest is the line without it.
function folioOf(text){
 if(/^\d{1,4}$/u.test(text))return {number:Number(text),rest:''};
 if(PAGE_LABEL.test(text)||EDGE_LABEL.test(text))return {number:Number(text.match(/\d{1,4}/u)[0]),rest:'',label:true};
 const before=text.match(/^(\d{1,4})\s+(\S.*)$/u);if(before)return {number:Number(before[1]),rest:before[2]};
 const after=text.match(/^(.*\S)\s+(\d{1,4})$/u);return after?{number:Number(after[2]),rest:after[1]}:null;
}
// The page furniture of a document's pages (or extracted sections), line by line. A line that only labels a page
// goes, wherever it stands; "12 页" only at a firm edge. A number at a page's edge goes when it runs in step with the
// pages on two pages or more (printed page 7 on PDF page 12, 8 on 13…); elsewhere it is an answer or a year and stays.
// A line repeated at the same firm edge (top or bottom: a line set smaller than the body in the page's margin, or one an
// OCR reading marked) of three pages or more, and of nearly half the pages between its first and last, is a running head
// or foot, a site's stamp: it stays where it first appears (or where a chapter's title set larger said it first: title)
// and goes where it repeats. An edge known only from a line's place (guess: the first or last lines of a text read
// without positions, a body line that opens or closes a page), which a heading or an exercise holds as often, needs
// more: the line comes back at that edge on nearly half of all such pages and on four in five of those between its first
// and last (a running head stands on nearly every page), and it opens no heading, item or caption (LINE_START) and holds
// no sentence, clause or answer (CONTENT): kept on every page, a running head costs a few tokens; dropped, a heading is
// lost. Every other line stays: headings, captions, answers and body lines away from the edges are never dropped.
// pages: [{number, last (the last page a section covers), lines:[{text, edge:'top'|'bottom'|'', guess, title}]}]. Returns
// for each page {drop: the indices of the lines that go, furniture: those of running heads kept where they first appear}.
export function pageFurniture(pages){
 const offsets=new Map(),pageOf=(page,line)=>line.edge==='bottom'?page.last??page.number:page.number;
 pages.forEach((page,index)=>{for(const line of page.lines){
  const folio=line.edge&&folioOf(line.text),at=pageOf(page,line);if(!folio||!Number.isFinite(at))continue;
  const offset=folio.number-at;if(!offsets.has(offset))offsets.set(offset,new Set());offsets.get(offset).add(index);
 }});
 const keys=pages.map(page=>page.lines.map(line=>{
  if(!line.edge)return null;
  const folio=folioOf(line.text),stepped=folio&&Number.isFinite(pageOf(page,line))&&(offsets.get(folio.number-pageOf(page,line))?.size||0)>=2;
  return {number:Boolean(stepped&&!folio.rest||folio?.label&&!line.guess),key:lineKey(stepped?folio.rest:line.text)};
 }));
 // The pages holding a guessed edge, counted in order: a line's span is those from its first page to its last.
 const guessedBefore=[0];for(const page of pages)guessedBefore.push(guessedBefore.at(-1)+(page.lines.some(line=>line.guess)?1:0));
 const guessed=guessedBefore.at(-1),where=new Map();
 pages.forEach((page,index)=>page.lines.forEach((line,i)=>{
  const item=keys[index][i];if(!item||item.number||!item.key)return;const id=`${line.edge}\u0000${item.key}`;
  if(!where.has(id))where.set(id,{key:item.key,firm:new Set(),all:new Set(),guess:false});const seen=where.get(id);seen.all.add(index);if(line.guess)seen.guess=true;else seen.firm.add(index);
 }));
 const repeated=new Set([...where].filter(([,{key,firm,all,guess}])=>{
  if(/[：:略]$/u.test(key))return false;
  const list=[...firm];if(list.length>=3&&list.length>=.45*(Math.max(...list)-Math.min(...list)+1))return true;
  if(!guess||LINE_START.test(key)||CONTENT.test(key)||all.size<Math.max(3,Math.ceil(.45*guessed)))return false;
  const every=[...all];return all.size>=.8*(guessedBefore[Math.max(...every)+1]-guessedBefore[Math.min(...every)]);
 }).map(([id])=>id));
 const kept=new Set();
 return pages.map((page,index)=>{
  const drop=new Set(),furniture=new Set();
  page.lines.forEach((line,i)=>{
   const item=keys[index][i],key=item?item.key:lineKey(line.text),running=item&&repeated.has(`${line.edge}\u0000${key}`);
   if(PAGE_LABEL.test(line.text)||item?.number||running&&kept.has(key)){drop.add(i);return;}
   if(running)furniture.add(i);if(item||line.title)kept.add(key);
  });
  return {drop,furniture};
 });
}
// How wide a line of text is, in ems: a Han glyph or a full-width sign one, a Latin letter, digit or half-width sign half.
const ems=text=>[...String(text).replace(/\s/gu,'')].reduce((sum,c)=>sum+(c.codePointAt(0)<0x2000?.5:1),0);
// A page's paragraphs from its lines, in the order the page gives them. A Chinese line that runs on without closing
// punctuation joins the next one, as the wrap of one paragraph does, but only when it runs the full width of its column
// and that column holds ten ems or more (a narrower one is a table, a verse or a list), and never before a heading,
// caption, item, speaker or label (LINE_START), after a line that ends short (a heading, a verse line, an option, the end
// of a paragraph), to or from a table row (cells: items set apart by wide gaps), across a blank line (a paragraph end the
// OCR kept), at a running head (keep), nor, for lines placed on the page, across a change of type size, a gap wider than
// a line or a step back up. A placed line runs the full width when it ends within about an em of the right edge its
// column's lines reach; a line of text alone, when it is within two ems of the page's full lines (the upper tenth of its
// line widths).
// lines: [{text, gap, keep, cells, box (0-1), size (points), em (the type size, 0-1 of the page's width), vertical}].
// Returns [{text, top}] (top: where the paragraph starts, when known).
export function joinLines(lines){
 const placed=line=>line.box&&line.em>0&&!line.vertical,body=lines.filter(line=>HAN.test(line.text)&&!line.cells);
 const widths=body.filter(line=>!placed(line)).map(line=>ems(line.text)).sort((a,b)=>a-b),full=widths.length?widths[Math.floor(widths.length*.9)]:0;
 // The right edge a placed line's column reaches: the upper tenth of the right edges of the lines beside it.
 const edge=line=>{
  const {x,width}=line.box,ends=body.filter(other=>placed(other)&&Math.min(x+width,other.box.x+other.box.width)-Math.max(x,other.box.x)>=.5*Math.min(width,other.box.width)).map(other=>other.box.x+other.box.width).sort((a,b)=>a-b);
  return ends.length?ends[Math.floor(ends.length*.9)]:x+width;
 };
 const wraps=line=>placed(line)?line.box.width>=10*line.em&&line.box.x+line.box.width>=edge(line)-1.2*line.em:ems(line.text)>=Math.max(10,full-2);
 const joins=(previous,next)=>{
  if(next.gap||previous.keep||next.keep||previous.cells||next.cells||!HAN.test(previous.text)||!HAN.test(next.text)||END_PUNCT.test(previous.text)||LINE_START.test(next.text)||!wraps(previous))return false;
  const a=previous.box,b=next.box;if(!a||!b||previous.vertical||next.vertical)return true;
  if(previous.size&&next.size&&Math.abs(previous.size-next.size)>.15*Math.max(previous.size,next.size))return false;
  return b.y>=a.y+a.height*.5&&b.y-(a.y+a.height)<=Math.max(a.height,b.height);
 };
 const paragraphs=[];let current=null,last=null;
 for(const line of lines){
  if(current&&joins(last,line))current.text+=line.text;
  else paragraphs.push(current={text:line.text,top:line.box?.y??null});
  last=line;
 }
 return paragraphs;
}

// ---- Chinese shown as pixels ----
// Rows of Han glyphs in a page image that no text holds: titles, bands and tables drawn as pictures or outlines on a
// page with a text layer, or lines an OCR pass left out. gray: one luminance byte per pixel; scale: pixels per point;
// mask: pixel boxes {x0,y0,x1,y1} left out first (the glyphs a text layer or an OCR line already holds). Ink is dark
// on the paper, or light where the page is dark (a white title on a coloured band). Each row is measured at its own
// glyph size (em): a cell is touching ink .85-1.3 em tall, at least .7 em wide and a quarter inked, and a row counts
// where three cells or more stand on one line with gaps under half an em (extract.py pixel_han and text_cells); the
// dots of a chart or the hatching of a drawing do not line up so, Latin letters and digits make narrower cells crossing
// fewer strokes, and drawn marks (answer boxes, writing grids, stars) are copies of one shape (cellRuns). Returns
// [{x0,y0,x1,y1,cells,em,light}] in pixels.
export function glyphRows(gray,width,height,{scale=1.5,mask=[]}={}){
 const size=width*height;if(!size)return [];
 const counts=new Uint32Array(256);let sampled=0;for(let i=0;i<size;i+=7){counts[gray[i]]++;sampled++;}
 let paper=255;for(let value=0,seen=0;value<256;value++){seen+=counts[value];if(seen>=.75*sampled){paper=value;break;}}
 const dark=new Uint8Array(size),light=new Uint8Array(size),cut=Math.min(190,paper-40),deep=paper-70,block=Math.max(8,Math.round(8*scale));
 for(let i=0;i<size;i++)if(gray[i]<cut)dark[i]=1;
 // Light ink: in blocks mostly darker than the paper (a band, a photograph), what stands well above their dark tone.
 for(let top=0;top<height;top+=block)for(let left=0;left<width;left+=block){
  const bottom=Math.min(height,top+block),right=Math.min(width,left+block);let count=0,sum=0;
  for(let y=top;y<bottom;y++)for(let i=y*width+left,end=y*width+right;i<end;i++)if(gray[i]<deep){count++;sum+=gray[i];}
  if(count<.5*(bottom-top)*(right-left))continue;
  const level=Math.min(235,sum/count+60);
  for(let y=top;y<bottom;y++)for(let i=y*width+left,end=y*width+right;i<end;i++)if(gray[i]>level)light[i]=1;
 }
 for(const box of mask){
  const x0=Math.max(0,Math.floor(box.x0)),x1=Math.min(width,Math.ceil(box.x1));if(x1<=x0)continue;
  for(let y=Math.max(0,Math.floor(box.y0)),end=Math.min(height,Math.ceil(box.y1));y<end;y++){dark.fill(0,y*width+x0,y*width+x1);light.fill(0,y*width+x0,y*width+x1);}
 }
 return [...inkRows(dark,width,height,scale,false),...inkRows(light,width,height,scale,true)];
}
// 8-connected ink of a bitmap (one byte per pixel, 1 = ink): [x0, y0, x1, y1, pixels], ends exclusive.
function inkComponents(bits,width,height){
 const parent=[],boxes=[],find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
 let previous=[];
 for(let y=0;y<height;y++){
  const runs=[],row=y*width;let cursor=0;
  for(let x=0;x<width;){
   if(!bits[row+x]){x++;continue;}
   const start=x;while(x<width&&bits[row+x])x++;
   while(cursor<previous.length&&previous[cursor][1]<start)cursor++;
   let id=-1;
   for(let k=cursor;k<previous.length&&previous[k][0]<=x;k++){
    const other=find(previous[k][2]);
    if(id<0)id=other;
    else if(other!==id){parent[other]=id;const a=boxes[id],b=boxes[other];a[0]=Math.min(a[0],b[0]);a[1]=Math.min(a[1],b[1]);a[2]=Math.max(a[2],b[2]);a[3]=Math.max(a[3],b[3]);a[4]+=b[4];}
   }
   if(id<0){id=parent.length;parent.push(id);boxes.push([start,y,x,y+1,0]);}
   const box=boxes[id];box[0]=Math.min(box[0],start);box[2]=Math.max(box[2],x);box[3]=y+1;box[4]+=x-start;
   runs.push([start,x,id]);
  }
  previous=runs;
 }
 return boxes.filter((box,i)=>find(i)===i);
}
// Glyph-sized ink banded into rows (a row: the pixel rows its ink fills, gaps of under 3 pt bridged), each measured
// with every piece of ink standing in it (the dots of 氵 are smaller than a glyph but belong to one).
function inkRows(bits,width,height,scale,light){
 const pieces=inkComponents(bits,width,height).filter(([x0,y0,x1,y1,pixels])=>y1-y0<=60*scale&&x1-x0<=65*scale&&pixels>=3);
 const glyphs=pieces.filter(([x0,y0,x1,y1])=>y1-y0>=3.5*scale&&x1-x0>=.6*scale);
 const occupancy=new Float64Array(height);for(const [x0,y0,x1,y1] of glyphs)for(let y=y0;y<y1;y++)occupancy[y]+=x1-x0;
 const bands=[],bridge=Math.max(2,Math.round(2.7*scale));
 for(let y=0;y<height;y++){if(occupancy[y]<4*scale)continue;const last=bands.at(-1);if(last&&y-last[1]<=bridge)last[1]=y;else bands.push([y,y]);}
 return bands.flatMap(([top,bottom])=>cellRuns(pieces.filter(([,y0,,y1])=>(y0+y1)/2>=top&&(y0+y1)/2<=bottom+1),bits,width,scale,light,height));
}
// Ink pixels of a bitmap in a box (clipped to the bitmap).
function inkIn(bits,width,height,x0,y0,x1,y1){
 let n=0;for(let y=Math.max(0,Math.floor(y0)),ye=Math.min(height,Math.ceil(y1));y<ye;y++)for(let x=Math.max(0,Math.floor(x0)),xe=Math.min(width,Math.ceil(x1));x<xe;x++)n+=bits[y*width+x];
 return n;
}
// Strokes a cell's scanlines cross on average, across and down: Han glyphs cross three or more.
function strokes([x0,y0,x1,y1],bits,width){
 if(x1-x0<2||y1-y0<2)return 0;
 let across=0,down=0;
 for(let y=y0;y<y1;y++)for(let i=y*width+x0+1,end=y*width+x1;i<end;i++)if(bits[i]&&!bits[i-1])across++;
 for(let x=x0;x<x1;x++)for(let y=y0+1;y<y1;y++)if(bits[y*width+x]&&!bits[(y-1)*width+x])down++;
 return across/(y1-y0)+down/(x1-x0);
}
// The straight strokes of a cell at least `length` long: 1 a horizontal one, 2 a vertical one, 3 both, 0 none. Han glyphs
// are built of such strokes; capitals such as W, A or V, circled digits and stars are not.
function straight([x0,y0,x1,y1],bits,width,length){
 let found=0;
 for(let y=y0;y<y1&&!(found&1);y++){let run=0;for(let x=x0;x<x1;x++){run=bits[y*width+x]?run+1:0;if(run>=length){found|=1;break;}}}
 for(let x=x0;x<x1&&!(found&2);x++){let run=0;for(let y=y0;y<y1;y++){run=bits[y*width+x]?run+1:0;if(run>=length){found|=2;break;}}}
 return found;
}
// Whether two cells are copies of one shape: under three tenths of their ink is inked by one only, laid on each other
// from the top left at the best of nine places a pixel apart (extract.py differ). Copies of a drawn mark differ by a
// sixth, or nearly three tenths where its thin lines fall half a pixel apart; one Han glyph from the next by a third or
// more.
function alike(a,b,bits,width){
 const w=Math.max(a[2]-a[0],b[2]-b[0]),h=Math.max(a[3]-a[1],b[3]-b[1]),ink=(cell,x,y)=>x>=0&&y>=0&&x<cell[2]-cell[0]&&y<cell[3]-cell[1]?bits[(cell[1]+y)*width+cell[0]+x]:0;
 for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
  let only=0,both=0;
  for(let y=-1;y<=h;y++)for(let x=-1;x<=w;x++){const p=ink(a,x,y),q=ink(b,x+dx,y+dy);only+=p^q;both+=p|q;}
  if(both&&only<.3*both)return true;
 }
 return false;
}
// Whether pieces of ink are Latin small letters: these stand between the baseline and one line under the row's top (the
// x-height), so nearly half of the pieces start on that line, a sixth of an em or more under the top, and above it only
// the stems of ascenders and capitals rise (under three tenths of the columns inked). Han glyphs start at their top or
// anywhere down it, and their top strokes run across them.
function smallLetters(pieces,em,bits,width){
 const tops=pieces.filter(([,y0,,y1])=>y1-y0>=.3*em&&y1-y0<=1.4*em).map(([,y0])=>y0).sort((a,b)=>a-b);if(tops.length<3)return false;
 const top=tops[Math.floor(tops.length*.1)],near=Math.max(1,.07*em);let line=top,most=0;
 for(const y of tops){const n=tops.filter(value=>Math.abs(value-y)<=near).length;if(n>most||n===most&&y<line){most=n;line=y;}}
 if(line-top<.15*em||most<.45*tops.length)return false;
 // Small letters are short: in a Chinese line with formulas, fractions, primes and arrows rise above the glyphs, whose
 // tops then make such a line, but the glyphs standing on it are as tall as the line's em.
 const standing=pieces.filter(([,y0,,y1])=>y1-y0>=.3*em&&y1-y0<=1.4*em&&Math.abs(y0-line)<=near).map(([,y0,,y1])=>y1-y0).sort((a,b)=>a-b);
 if(standing[Math.floor(standing.length/2)]>.85*em)return false;
 const x0=Math.min(...pieces.map(piece=>piece[0])),x1=Math.max(...pieces.map(piece=>piece[2]));let inked=0;
 for(let x=x0;x<x1;x++)for(let y=top;y<line;y++)if(bits[y*width+x]){inked++;break;}
 return inked<.3*(x1-x0);
}
// The Han glyphs of one row of ink, measured at the row's own size: its em is the upper quartile height of its pieces
// (a Han glyph has strokes or a radical that run its full height; slivers, such as the edge of a band, do not count).
// The pieces of one glyph (氵 and 舌, 讠 and 仑) sit
// close together and are merged while the cell stays about an em wide; a cell is a glyph when it is .75-1.3 em tall,
// .6-1.3 em wide and inked for at least a sixth. A row counts when three cells or more stand on one line with gaps
// under .6 em and read as Han; every aligned cell of the row is then counted, so a table's two-glyph cells stay in its
// region. Cells that do not read as Han: crossing under 2.8 strokes (median: capitals, Greek, a row of answer boxes,
// writing grids, stars or discs; natural Han text crosses 3 or more at any size; 2.4 for light ink, whose strokes a
// band thins and breaks), narrower than three quarters of their
// height (median: digits, narrow letters), Latin small letters (smallLetters: English labels of a figure) or copies of
// one shape (more than half of the neighbours alike: ticked boxes, grids, icons; a word said twice, 许许多多, stays).
// A gap up to an em and a half that only a flat mark fills (a colon's dots, 、 or 。, or a lone bar nearly an em long: 一;
// not a minus, an equals sign's two bars or a superscript) keeps a run going (答案：略, 第一章), and a
// heading of two characters counts when it stands alone (练习, 习题): the only glyphs of its band, each crossing as many
// strokes as Han glyphs do and unlike the other, with an em and a half of paper above and below it (a label in a
// picture or a word among lines has ink around it).
function cellRuns(pieces,bits,width,scale,light,height){
 const sorted=[...pieces].sort((a,b)=>a[0]-b[0]),heights=sorted.filter(([x0,y0,x1,y1])=>y1-y0>=3.5*scale&&x1-x0>=.2*(y1-y0)).map(([,y0,,y1])=>y1-y0).sort((a,b)=>a-b);
 if(heights.length<2)return [];
 // The upper quartile of the pieces at least half as tall as most: the dots of 思 or 习 do not pull a short row's em down.
 const tall=heights.filter(value=>value>=.5*heights[Math.floor(heights.length*3/4)]),em=tall[Math.floor(tall.length*3/4)];
 if(smallLetters(sorted,em,bits,width))return [];
 const cells=[];
 for(const piece of sorted){
  const last=cells.at(-1);
  if(last&&piece[0]-last[2]<=.3*em&&Math.max(last[2],piece[2])-last[0]<=1.15*em){last[0]=Math.min(last[0],piece[0]);last[1]=Math.min(last[1],piece[1]);last[2]=Math.max(last[2],piece[2]);last[3]=Math.max(last[3],piece[3]);last[4]+=piece[4];}
  else cells.push([...piece]);
 }
 const good=cells.filter(([x0,y0,x1,y1,ink])=>y1-y0>=.75*em&&y1-y0<=1.3*em&&x1-x0>=.6*em&&x1-x0<=1.3*em&&ink>=(x1-x0)*(y1-y0)/6);
 if(good.length<2)return [];
 const top=median(good.map(cell=>cell[1])),bottom=median(good.map(cell=>cell[3]));
 const aligned=good.filter(cell=>Math.abs(cell[1]-top)<=.25*em&&Math.abs(cell[3]-bottom)<=.25*em),runs=[],flat=sorted.filter(piece=>{const [x0,y0,x1,y1]=piece;return y1-y0<.5*em&&(x1-x0>=.7*em&&!sorted.some(other=>other!==piece&&Math.min(x1,other[2])-Math.max(x0,other[0])>=.5*(x1-x0))||x1-x0<=.25*em&&y1-y0<=.25*em);});
 for(const cell of aligned){const last=runs.at(-1)?.at(-1),gap=last?cell[0]-last[2]:Infinity;if(gap<=.6*em||gap<=1.6*em&&flat.some(([x0,,x1])=>x0>=last[2]-.1*em&&x1<=cell[0]+.1*em))runs.at(-1).push(cell);else runs.push([cell]);}
 const copies=run=>{let same=0;for(let k=1;k<run.length;k++)if(alike(run[k-1],run[k],bits,width))same++;return 2*same>run.length-1;};
 const latin=run=>median(run.map(cell=>strokes(cell,bits,width)))<(light?2.4:2.8)||median(run.map(([x0,y0,x1,y1])=>(x1-x0)/(y1-y0)))<.75||smallLetters(sorted.filter(([x0,,x1])=>(x0+x1)/2>=run[0][0]&&(x0+x1)/2<=run.at(-1)[2]),em,bits,width)||copies(run);
 const kept=runs.filter(run=>!latin(run)),han=kept.flat();
 const paper=(x0,y0,x1,y1)=>inkIn(bits,width,height,x0,y0,x1,y1)<=.01*Math.max(1,(x1-x0)*(y1-y0));
 const alone=([a,b])=>{
  const x0=a[0]-em,x1=b[2]+em,y0=Math.min(a[1],b[1]),y1=Math.max(a[3],b[3]),[sa,sb]=[a,b].map(cell=>straight(cell,bits,width,.45*em));
  return good.length===2&&[a,b].every(cell=>strokes(cell,bits,width)>=(light?2.4:2.8))&&sa&&sb&&(sa===3||sb===3)&&!alike(a,b,bits,width)&&paper(x0,y0-1.5*em,x1,y0-.15*em)&&paper(x0,y1+.15*em,x1,y1+1.5*em);
 };
 if(!kept.some(run=>run.length>=3)&&!(kept.length===1&&kept[0].length===2&&alone(kept[0])))return [];
 return [{x0:han[0][0],y0:Math.min(...han.map(cell=>cell[1])),x1:Math.max(...han.map(cell=>cell[2])),y1:Math.max(...han.map(cell=>cell[3])),cells:han.length,em,light}];
}
// glyphRows as the regions OCR reads: rows of one kind of ink that overlap across and stand within an em and a half of
// each other (a table, a title on two lines) make one region. Boxes 0-1, padded by a third of an em; em 0-1 of the
// height.
export function glyphRegions(rows,width,height){
 const regions=[];
 for(const row of [...rows].sort((a,b)=>a.y0-b.y0)){
  const near=regions.find(region=>region.light===row.light&&row.y0-region.y1<=1.5*Math.max(region.em,row.em)&&row.x0<region.x1&&row.x1>region.x0);
  if(near){near.x0=Math.min(near.x0,row.x0);near.y0=Math.min(near.y0,row.y0);near.x1=Math.max(near.x1,row.x1);near.y1=Math.max(near.y1,row.y1);near.cells+=row.cells;near.em=Math.max(near.em,row.em);}
  else regions.push({...row});
 }
 return regions.map(({x0,y0,x1,y1,cells,em,light})=>{
  const pad=em/3,left=Math.max(0,x0-pad),top=Math.max(0,y0-pad),right=Math.min(width,x1+pad),bottom=Math.min(height,y1+pad);
  return {box:{x:left/width,y:top/height,width:(right-left)/width,height:(bottom-top)/height},cells,light,em:em/height};
 });
}
