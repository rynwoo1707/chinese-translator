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
