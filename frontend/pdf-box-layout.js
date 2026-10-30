// Shared by the browser preview and Puppeteer PDF exporter. Coordinates are PDF points.
import {renderMathText,mathStyles} from './math-text.js';
const escape=value=>String(value).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=(n,min,max)=>Number.isFinite(n)&&n>=min&&n<=max;
const PNG=/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u;
// One OCR call: up to 6 images (paragraph crops, or sheets holding at most 48 blocks between them) in 4 MB.
export const OCR_LIMITS=Object.freeze({images:6,sheetBlocks:48,bytes:4*1024*1024});
// OCR sheets (extract.py ocr_sheets) hold the crops of several blocks of one page: each strip names one block of that
// page under a #label used once in the document, and a block naming a sheet is that sheet's strip with that label.
function validateSheets(page,sheetIds,labels){
 const strips=new Map(),invalid=()=>new Error('Ảnh gộp OCR của PDF không hợp lệ.');
 if(page.ocrSheets===undefined&&page.blocks.every(b=>b.ocrSheet===undefined))return;if(!Array.isArray(page.ocrSheets))throw invalid();
 for(const sheet of page.ocrSheets){
  if(!/^p\d+-s\d+$/u.test(sheet?.id||'')||sheetIds.has(sheet.id)||!PNG.test(sheet.image||'')||!Array.isArray(sheet.strips)||!sheet.strips.length||sheet.strips.length>OCR_LIMITS.sheetBlocks)throw invalid();sheetIds.add(sheet.id);
  for(const strip of sheet.strips){if(!/^#\d{1,4}$/u.test(strip?.label||'')||labels.has(strip.label)||strips.has(strip.blockId)||!box4(strip.box))throw invalid();labels.add(strip.label);strips.set(strip.blockId,[sheet.id,strip.label]);}
 }
 for(const b of page.blocks){const strip=strips.get(b.id);if(b.ocrSheet===undefined&&!strip)continue;if(strip?.[0]!==b.ocrSheet||strip[1]!==b.ocrLabel)throw invalid();strips.delete(b.id);}
 if(strips.size)throw invalid();
}
export function validateLayoutDocument(document){
 if(document?.version!==1||!Array.isArray(document.pages)||!document.pages.length||document.pages.length>20)throw new Error('Dữ liệu bố cục PDF không hợp lệ.');
 const ids=new Set(),sheetIds=new Set(),labels=new Set();let count=0;
 for(const page of document.pages){
  if(!finite(page.width,10,3000)||!finite(page.height,10,3000)||!Number.isInteger(page.number))throw new Error('Kích thước trang PDF không hợp lệ.');
  // Scanned pages use JPEG for these two full-page images (preview and export background); crops stay PNG.
  for(const image of [page.background,page.original])if(!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/u.test(image||''))throw new Error('Ảnh trang PDF không hợp lệ.');
  if(!Array.isArray(page.blocks))throw new Error('Thiếu block PDF.');
  for(const b of page.blocks){
   if(++count>3000||typeof b.id!=='string'||!/^p\d+-b\d+$/u.test(b.id)||ids.has(b.id))throw new Error('ID block PDF không hợp lệ hoặc bị trùng.');ids.add(b.id);
   if(typeof b.source!=='string'||!b.source.trim()||b.source.length>8000||!Array.isArray(b.box)||b.box.length!==4||b.box.some(n=>!Number.isFinite(n)))throw new Error('Nội dung block PDF không hợp lệ.');
   const [x,y,r,t]=b.box;if(x<-.1||y<-.1||r>page.width+.1||t>page.height+.1||r<=x||t<=y)throw new Error('Box nằm ngoài trang PDF.');
   if(!finite(b.fontSize,1,200))throw new Error('Cỡ chữ PDF không hợp lệ.');
   for(const inline of b.inlines||[])if(!/^@@PDF_INLINE_\d+@@$/u.test(inline.token)||!PNG.test(inline.image||'')||!finite(inline.width,0,3000)||!finite(inline.height,0,3000))throw new Error('Công thức trong block không hợp lệ.');
  }
  validateSheets(page,sheetIds,labels);
 }
 return document;
}
export function validateBlockTranslations(blocks,translations,{complete=true}={}){
 if(!Array.isArray(translations))throw new Error('Thiếu mảng bản dịch block.');
 const expected=new Map(blocks.map(b=>[b.id,b])),result=new Map();
 for(const entry of translations){
  const b=expected.get(entry?.id);if(!b||result.has(entry.id)||typeof entry.translation!=='string'||!entry.translation.trim()||entry.translation.length>20000)throw new Error('Bản dịch thiếu, trùng hoặc sai ID block.');
  for(const inline of b.inlines||[]){if(entry.translation.split(inline.token).length-1!==1)throw new Error(`Block ${b.id} không bảo toàn công thức ${inline.token}.`);}
  const tokens=entry.translation.match(/@@PDF_INLINE_\d+@@/gu)||[];if(tokens.length!==(b.inlines||[]).length)throw new Error('Bản dịch chứa mã công thức không hợp lệ.');
  result.set(entry.id,entry.translation.normalize('NFC'));
 }
 if(complete&&result.size!==expected.size)throw new Error('Chưa dịch đủ các block; chưa thể xuất PDF.');
 return result;
}
const TOKEN=/@@PDF_INLINE_\d+@@/gu;
// Marks of the same function, Latin or full-width: a crop ending in "，" duplicates a following ",".
const PUNCTUATION=Object.freeze({'.':'.','。':'.','．':'.',',':',','，':',','、':',',';':';','；':';',':':':','：':':'});
const box4=value=>Array.isArray(value)&&value.length===4&&value.every(Number.isFinite)&&value[2]>value[0]&&value[3]>value[1]?value:null;
// Where inline.axis (the centre of the row's normal-height glyphs) lands above the text baseline. On scanned
// Chinese textbook rows the Han glyph centre is .36-.41 of the body size above the Latin baseline, so this
// puts the formula's own letters on the translated line's baseline.
export const TEXT_AXIS_EM=.38;
// A page's own extractor version wins: a merged book can hold pages from older and newer extractions.
export const pageVersion=(page,document)=>Number(page?.extractionVersion??document?.extractionVersion)||0;
// Image size in em of the block's base font keeps the crop at its printed size and lets it scale with fitting.
export function inlineGeometry(item,base){
 const size=Math.max(1,base),box=box4(item.box),width=item.width/size,height=item.height/size,span=box?box[3]-box[1]:0;
 const axis=box&&Number.isFinite(item.axis)&&item.axis>=box[1]-span*.5&&item.axis<=box[3]+span*.5?item.axis:null;
 return {width,height,align:axis==null?null:TEXT_AXIS_EM-height*(box[3]-axis)/span};
}
// The translation repeats a mark the crop already shows ("OB=b, ," / "k.."). Only with evidence: the extractor's
// trail flag, or for older manifests without that flag, Tesseract's text of the crop ending in punctuation.
export function dropRepeatedPunctuation(b,text,{tight=false}={}){
 let out=String(text);
 for(const item of b.inlines||[]){
  const mark=PUNCTUATION[String(item.text||'').trim().slice(-1)];
  if(!(item.trail===true||(!tight&&item.trail===undefined&&mark)))continue;
  const at=out.indexOf(item.token);if(at<0)continue;
  const after=out.slice(at+item.token.length),found=after.match(/^[ \t]*([.,;:。，、；：．])(?![.,;:。，、；：．…])/u);
  if(!found||(mark&&PUNCTUATION[found[1]]!==mark))continue;
  const rest=after.slice(found[0].length);out=out.slice(0,at+item.token.length)+(/^[\p{L}\p{N}]/u.test(rest)?' ':'')+rest;
 }
 return out;
}
// A newline the OCR model put between two formulas that shared ONE original row is not a source line break
// (exercise items "(1) … (2) … (3) …" on one row became three tall rows and shrank the whole block).
export function joinSameRowBreaks(b,text){
 const boxes=new Map((b.inlines||[]).map(i=>[i.token,box4(i.box)]));if(!boxes.size||!text.includes('\n'))return text;
 const segments=text.split('\n'),tokens=s=>(s.match(TOKEN)||[]).map(t=>boxes.get(t)).filter(Boolean);
 let out=segments[0];
 for(let i=1;i<segments.length;i++){
  const prev=tokens(segments[i-1]).at(-1),next=tokens(segments[i])[0];
  // Same row: vertical overlap of most of the smaller box, and the next formula starts right of the previous.
  const same=prev&&next&&Math.min(prev[3],next[3])-Math.max(prev[1],next[1])>=.6*Math.min(prev[3]-prev[1],next[3]-next[1])&&next[0]>=prev[2]-1;
  out+=(same?'    ':'\n')+segments[i];
 }
 return out;
}
// A source row holding only formulas ("OE=kOA, OF=kOB, OG=kOC, OH=kOD.") is a display row; when the OCR model
// joins it with the next sentence, that sentence flows up beside the formulas.
export function keepDisplayRows(b,text){
 const inlines=(b.inlines||[]).map(i=>({token:i.token,box:box4(i.box)})).filter(i=>i.box&&text.includes(i.token));if(inlines.length<2)return text;
 const size=Math.max(1,b.fontSize),rows=[];
 for(const i of inlines.sort((p,q)=>p.box[0]-q.box[0])){const row=rows.find(r=>Math.min(r.y1,i.box[3])-Math.max(r.y0,i.box[1])>=.6*Math.min(r.y1-r.y0,i.box[3]-i.box[1]));if(row){row.items.push(i);row.y0=Math.min(row.y0,i.box[1]);row.y1=Math.max(row.y1,i.box[3]);}else rows.push({y0:i.box[1],y1:i.box[3],items:[i]});}
 for(const row of rows){
  if(row.items.length<2)continue;const first=row.items[0],last=row.items.at(-1),a=text.indexOf(first.token),z=text.indexOf(last.token);if(a<0||z<a)continue;
  const between=text.slice(a+first.token.length,z).replace(TOKEN,''),before=text.slice(text.lastIndexOf('\n',a)+1,a);
  // Only punctuation between the formulas and at most a short label before them; on the page the row started at
  // the block's left edge and its last formula reached the right edge, so nothing else shared it.
  if(/[^\s.,;:，。；：、]/u.test(between)||before.trim().length>4||first.box[0]-b.box[0]>size*3||b.box[2]-last.box[2]>size*1.5)continue;
  const tail=text.slice(z+last.token.length).match(/^[.,;:，。；：、]*[ \t]*/u)[0],at=z+last.token.length+tail.length;
  if(at<text.length&&text[at]!=='\n')text=`${text.slice(0,at).trimEnd()}\n${text.slice(at)}`;
 }
 return text;
}
// Whether the source fitted on one printed row: Han and full-width glyphs take about 1em, other characters about
// half, formulas their crop width. Only such a block is a lone row made tall by a stacked formula.
export function singleSourceRow(b){
 const text=String(b.source||'').replace(TOKEN,'').trim(),[x,,r]=b.box;if(text.includes('\n'))return false;
 const wide=(text.match(/[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/gu)||[]).length,narrow=[...text].length-wide;
 return wide*b.fontSize+narrow*b.fontSize*.55+(b.inlines||[]).reduce((sum,i)=>sum+(Number(i.width)||0),0)<=(r-x)*1.1;
}
// Blank lines inside one block are never on the page (a paragraph gap splits blocks) but cost a whole line.
export function blockText(b,value,{tight=false}={}){
 const text=String(value??'').replace(/\r\n?/gu,'\n').replace(/[ \t]*\n(?:[ \t]*\n)+/gu,'\n').trim();
 return (b.inlines||[]).length?keepDisplayRows(b,joinSameRowBreaks(b,dropRepeatedPunctuation(b,text,{tight}))):text;
}
function inlineContent(b,text,{base,tight}){
 // Tokens become private-use characters before math rendering: "_" in PDF_INLINE is never read as a subscript
 // and a token inside \( \) stays one atom.
 const items=(b.inlines||[]).filter(i=>typeof i.token==='string').slice(0,6000),marks=new Map();let source=text.replace(/[\uE000-\uF8FF]/gu,'\uFFFD');
 items.forEach((item,i)=>{const mark=String.fromCharCode(0xE000+i);marks.set(mark,item);source=source.split(item.token).join(mark);});
 // A private-use character of the OCR or native text (a user-defined glyph) would be read as another formula's mark.
 const alt=item=>escape(String(item.text||'').replace(/[\uE000-\uF8FF]/gu,'\uFFFD')),used=new Set();
 const image=mark=>{
  const item=marks.get(mark);if(!item)return '';if(used.has(mark))return escape(item.token);used.add(mark);
  const g=inlineGeometry(item,base),next=(text.split(item.token)[1]||'').match(/^[ \t]*([.,;:，。；：、])/u)?.[1],crisp=tight||g.align!=null;
  return `<img class="pdf-inline" src="${escape(item.image)}" alt="${alt(item)}"${crisp?' data-tight="true"':''}${next&&!crisp?` data-next-punct="${escape(next)}"`:''} style="width:${g.width.toFixed(4)}em;height:${g.height.toFixed(4)}em${g.align==null?'':`;vertical-align:${g.align.toFixed(4)}em`}">`;
 };
 // One pass over the rendered HTML, so no inserted alt text is scanned again. A token inside a construct that also
 // writes its body into an attribute (\vec{…}, \frac{…}{2}, \sqrt{…} into aria-label) becomes the formula's alt text
 // there and its image only in the visible text. Never break between a formula image and the punctuation written
 // right after it (", khi đó"), nor between crops written with no space between them: they are one printed
 // expression split by OCR ("AB+AA" | "′+AD").
 return renderMathText(source).replace(/<[^>]*>|[^<]+/gu,part=>part.startsWith('<')?part.replace(/[\uE000-\uF8FF]/gu,mark=>marks.has(mark)?alt(marks.get(mark)):''):part.replace(/[\uE000-\uF8FF]+(?:[.,;:!?…)\]}’”，。；：、！？）】」』]|&#39;)*/gu,run=>{const html=run.replace(/[\uE000-\uF8FF]/gu,image);return [...run].length>1?`<span class="pdf-nobr">${html}</span>`:html;}));
}
// Bases within 4% are one printed size measured with noise (9 vs 9.1pt): one size per group keeps paragraphs of
// one original size consistent on the page. Bold text (headings) never joins regular text.
export function bodySizes(blocks,tolerance=.04){
 const result=new Map();let group=0;
 for(const bold of [false,true]){
  const list=blocks.filter(b=>!!b.bold===bold).sort((p,q)=>p.fontSize-q.fontSize);
  for(let i=0;i<list.length;){
   let j=i;while(j<list.length&&list[j].fontSize<=list[i].fontSize*(1+tolerance))j++;
   const members=list.slice(i,j),weight=b=>Math.max(1,String(b.source||'').length),total=members.reduce((s,b)=>s+weight(b),0);
   let seen=0,base=members[0].fontSize;for(const b of members){seen+=weight(b);if(seen>=total/2){base=b.fontSize;break;}}
   for(const b of members)result.set(b.id,{base,group:`g${group}`});group++;i=j;
  }
 }
 return result;
}
// overflow:clip with a clip margin keeps diacritics and descenders of the first and last line visible (line-height
// 1.08 is tighter than the font's content area) while real overflow stays bounded; hidden is the fallback.
export const boxStyles=`.pdf-paper,.pdf-paper *{box-sizing:border-box}.pdf-paper{position:relative;flex:none;background:white;overflow:hidden}.pdf-background{position:absolute;inset:0;display:block;width:100%;height:100%}.pdf-text-mask{position:absolute;background:white;pointer-events:none}.pdf-text-box{position:absolute;margin:0;padding:0;border:0;font-family:'HoaTriPDF','Noto Serif','DejaVu Serif','Times New Roman',serif;line-height:1.08;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;letter-spacing:0;color:#111;overflow:hidden;overflow:clip;overflow-clip-margin:.25em}.pdf-text-box .pdf-inline{object-fit:contain;vertical-align:middle;margin:0 .04em;filter:url(#pdf-ink-tone)}.pdf-filters{position:absolute;width:0;height:0}.pdf-nobr{white-space:nowrap}.pdf-text-box[data-overflow=true]{outline:2px solid #b64a3b;background:#fff8f5}.pdf-text-box:focus{outline:1px solid #8aa674}.pdf-original-pixels{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.pdf-original-patch{position:absolute}${mathStyles}`;
export function hasBlockTranslation(translations,id){return typeof translations.get(id)==='string'&&!!translations.get(id).trim();}
export function pageMarkup(page,translations=new Map()){
 // Keep the untouched page until each individual translation is available. A
 // globally redacted background from older manifests cannot represent pending
 // blocks: reflowing their source text produces a misleading, damaged preview.
 const completed=page.blocks.filter(b=>hasBlockTranslation(translations,b.id)),useCleanBackground=page.extractionVersion>=2&&completed.length===page.blocks.length&&completed.length>0;
 // A scanned block Gemini could not read (keepPixels, backend/pdf-layout-apply.js) whose translation is still its own
 // source keeps the page's original pixels: no mask, no text box; its box is protected so no neighbour grows over it. A
 // translation typed for it is drawn like any other. The original is drawn once for all of them (keptPixels).
 const pixels=b=>b.keepPixels===true&&String(translations.get(b.id)).normalize('NFC')===String(b.source).normalize('NFC'),kept=completed.filter(pixels),texts=completed.filter(b=>!pixels(b));
 const sizes=bodySizes(texts),tight=page.extractionVersion>=3,protectedRegions=[...(page.protectedRegions||[]).filter(box4),...kept.map(b=>b.box)];
 // Scanned formula crops are grey next to near-black typed text; a tone curve on the crops only (never on figures or
 // the page) darkens their strokes. prepareLayout fits it to the page's paper level of each channel, so the crops'
 // paper keeps the page's tone; this default is for white paper.
 return `<div class="pdf-paper" data-translated-blocks="${completed.length}" data-protected="${escape(JSON.stringify(protectedRegions))}" style="width:${page.width}pt;height:${page.height}pt"><svg class="pdf-filters" aria-hidden="true" focusable="false"><filter id="pdf-ink-tone" color-interpolation-filters="sRGB"><feComponentTransfer>${['R','G','B'].map(c=>`<feFunc${c} type="table" tableValues="0 .05 .11 .19 .3 .45 .66 .875 1"/>`).join('')}</feComponentTransfer></filter></svg><img class="pdf-background" src="${useCleanBackground?page.background:page.original}" alt="${useCleanBackground?'Hình và công thức gốc':'Trang PDF gốc'}">${keptPixels(page,kept)}${texts.map(b=>{const [x,y,r,t]=b.box,position=`left:${x}pt;top:${y}pt;width:${r-x}pt;height:${t-y}pt`,background=/^#[a-f\d]{6}$/iu.test(b.backgroundColor)?b.backgroundColor:'#ffffff',{base,group}=sizes.get(b.id),indent=Number(b.indent),count=(b.inlines||[]).length;return `${useCleanBackground?'':`<div class="pdf-text-mask" aria-hidden="true" style="${position};background:${background}"></div>`}<div class="pdf-text-box" data-block-id="${escape(b.id)}"${b.kind==='caption'||b.kind==='heading'?` data-kind="${b.kind}"`:''} data-base-font="${base}" data-size-group="${group}"${count?` data-inlines="${count}"`:''}${count&&singleSourceRow(b)?' data-one-row="true"':''} data-pending="false" style="${position};font-size:${base}pt;font-weight:${b.bold?700:400};color:${/^#[a-f\d]{6}$/iu.test(b.color)?b.color:'#111'}${Number.isFinite(indent)&&indent>.5&&indent<(r-x)*.5?`;text-indent:${indent.toFixed(2)}pt`:''}">${inlineContent(b,blockText(b,translations.get(b.id),{tight}),{base,tight})}</div>`;}).join('')}</div>`;
}
// The page's original pixels in the boxes of its kept blocks: one copy of the original (a scan page is 1-3 MB of data URL),
// clipped to their boxes, then an empty box of each block for the viewer to find it by (data-block-id).
function keptPixels(page,kept){
 if(!kept.length)return '';const clip=`pdf-keep-${escape(String(page.number??''))}`,boxes=kept.map(b=>b.box);
 return `<svg class="pdf-original-pixels" aria-hidden="true" focusable="false" viewBox="0 0 ${page.width} ${page.height}" preserveAspectRatio="none"><clipPath id="${clip}">${boxes.map(([x,y,r,t])=>`<rect x="${x}" y="${y}" width="${r-x}" height="${t-y}"/>`).join('')}</clipPath><image href="${page.original}" width="${page.width}" height="${page.height}" preserveAspectRatio="none" clip-path="url(#${clip})"/></svg>${kept.map(b=>{const [x,y,r,t]=b.box;return `<div class="pdf-original-patch" data-block-id="${escape(b.id)}" aria-hidden="true" style="left:${x}pt;top:${y}pt;width:${r-x}pt;height:${t-y}pt"></div>`;}).join('')}`;
}
export function pageHtml(page,translations,fontCss=''){
 return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${fontCss}${boxStyles}@page{size:${page.width}pt ${page.height}pt;margin:0}html,body{margin:0;padding:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${pageMarkup(page,translations)}</body></html>`;
}
// Runs once after fonts and images load, before fitTextBoxes; self-contained because the exporter stringifies it.
// 1. Older manifests only (crops without data-tight): Tesseract line boxes carry blank bands and glyph slivers, so
//    each crop is trimmed to its ink, its letter baseline goes on the text baseline, and a trailing mark is cut
//    when the translation writes the same mark right after it. Newer crops are ink-tight and never re-trimmed.
// 2. Measures blank paper right of and below each box on the displayed background, never into another block, a
//    protected region or ink, so fitting can grow a box before it shrinks the font.
export async function prepareLayout(root){
 const lum=(d,o)=>d[o]*.299+d[o+1]*.587+d[o+2]*.114,jobs=[],papers=root.classList?.contains('pdf-paper')?[root]:[...root.querySelectorAll('.pdf-paper')];
 const canvasOf=(image,w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(image,0,0,w,h);try{return {c,d:g.getImageData(0,0,w,h).data};}catch{return null;}};
 for(const img of root.querySelectorAll('.pdf-text-box img.pdf-inline:not([data-tight])')){
  if(!img.complete||!img.naturalWidth)continue;
  const W=img.naturalWidth,H=img.naturalHeight,em=H/parseFloat(img.style.height),pixels=canvasOf(img,W,H);if(!pixels||!(em>0))continue;
  const dark=new Uint8Array(W*H);let count=0;for(let i=0;i<W*H;i++)if(lum(pixels.d,i*4)<150){dark[i]=1;count++;}
  // A tinted panel or an inverted crop is not ink on paper: leave it as it is.
  if(!count||count>W*H*.45)continue;
  const cols=new Array(W).fill(0);for(let y=0;y<H;y++)for(let x=0;x<W;x++)cols[x]+=dark[y*W+x];
  const rowsOf=(a,z)=>{const rows=new Array(H).fill(0);for(let y=0;y<H;y++)for(let x=a;x<=z;x++)rows[y]+=dark[y*W+x];return rows;};
  // Blank columns stay: where two crops abut they are the printed space between words ("kOB. OG").
  let left=0,right=W-1,inkLeft=0,inkRight=W-1;
  // Left edge: a thin run touching column 0 and then a clear gap is the tail of the previous glyph ("(2)" paren).
  // The cut is in the middle of the gap, so the sliver's faint antialiased edge goes with it.
  if(cols[0]>0){let run=0;while(run<W&&cols[run]>0)run++;let gap=run;while(gap<W&&cols[gap]===0)gap++;if(run<=Math.round(em*.35)&&gap-run>=Math.max(2,Math.round(em*.12))&&gap<W)left=inkLeft=Math.floor((run+gap)/2);}
  while(inkLeft<inkRight&&cols[inkLeft]===0)inkLeft++;while(inkRight>inkLeft&&cols[inkRight]===0)inkRight--;
  // Letter baseline: the lowest row still carrying 30% of the strongest row of the lower ink half. Commas,
  // semicolons and parenthesis tails hang below it with only a few pixels per row.
  const baselineOf=rows=>{const noise=Math.max(1,Math.round((right-left+1)*.004)),top=rows.findIndex(n=>n>=noise);let bottom=H-1;while(bottom>0&&rows[bottom]<noise)bottom--;if(top<0||bottom<=top)return null;const mid=Math.floor((top+bottom)/2);let peak=0;for(let y=mid;y<=bottom;y++)peak=Math.max(peak,rows[y]);let base=bottom;while(base>mid&&rows[base]<peak*.3)base--;return {top,bottom,base};};
  let geo=baselineOf(rowsOf(left,right));if(!geo)continue;
  const want={'.':'.','。':'.',',':',','，':',','、':',',';':';','；':';',':':':','：':':'}[img.dataset.nextPunct];
  if(want){
   let run=inkRight;while(run>inkLeft&&cols[run]>0)run--;let gap=run;while(gap>inkLeft&&cols[gap]===0)gap--;
   // Vertical parts of the last ink run; a 1-2px antialiasing break inside one comma does not make two marks.
   const rows=rowsOf(run+1,inkRight),parts=[],join=Math.max(1,Math.round(em*.1));for(let y=0;y<H;y++)if(rows[y]){if(!parts.length||y-parts.at(-1)[1]>join+1)parts.push([y,y]);parts.at(-1)[1]=y;}
   // Measured from the baseline of the glyph just before the mark ("k" in a fraction row "…=k."), in em, up is
   // positive. A raised mark (prime, degree, superscript) is never cut.
   const local=baselineOf(rowsOf(Math.max(inkLeft,gap-Math.round(em*.6)),gap))||geo;
   const above=p=>(local.base-p[0])/em,below=p=>(p[1]-local.base)/em,tall=p=>(p[1]-p[0]+1)/em;
   const dot=p=>tall(p)<=.2&&above(p)<=.25&&below(p)<=.1,comma=p=>tall(p)<=.38&&above(p)<=.25&&below(p)>=.03&&below(p)<=.35,upper=p=>tall(p)<=.2&&above(p)<=.6&&(local.base-p[1])/em>=.15;
   const shape=parts.length===1?(dot(parts[0])?'.':comma(parts[0])?',':null):parts.length===2&&upper(parts[0])?(dot(parts[1])?':':comma(parts[1])?';':null):null;
   if(shape&&(shape===want||(want===','&&shape==='.'))&&(inkRight-run)/em<=.22&&(run-gap)/em>=.05){right=Math.floor((gap+run+1)/2);geo=baselineOf(rowsOf(left,right))||geo;img.dataset.punctTrimmed='true';}
  }
  const {top,bottom,base}=geo,t=Math.max(0,top-1),b=Math.min(H-1,bottom+1),l=left,r=right,hEm=(b-t+1)/em,ink=(bottom-top+1)/em;
  // Stacked (a fraction) or letterless (a lone "=" or "→"): the ink centre goes on the minus-sign height.
  const centred=ink>1.5||ink<.5,align=centred?.25-hEm/2:-(b-base)/em;
  const out=document.createElement('canvas');out.width=r-l+1;out.height=b-t+1;out.getContext('2d').drawImage(pixels.c,l,t,out.width,out.height,0,0,out.width,out.height);
  img.style.width=`${((r-l+1)/em).toFixed(4)}em`;img.style.height=`${hEm.toFixed(4)}em`;img.style.verticalAlign=`${align.toFixed(4)}em`;
  // A stacked fraction gets the clearance the printed page gives it instead of touching the descenders above.
  if(ink>1.5)img.style.margin='.12em .04em';
  jobs.push(new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;img.src=out.toDataURL('image/png');}));
 }
 await Promise.all(jobs);
 for(const paper of papers){
  const bg=paper.querySelector('.pdf-background'),pw=parseFloat(paper.style.width),ph=parseFloat(paper.style.height);if(!bg||!bg.naturalWidth||!(pw>0)||!(ph>0))continue;
  const cw=Math.round(pw),ch=Math.round(ph),pixels=canvasOf(bg,cw,ch);if(!pixels)continue;
  // Summed-area tables of ink: "faint" is anything clearly darker than paper (dotted panel borders), "dark" is a
  // glyph core. The 2.5pt band along a box edge holds the faint antialiased halo of the block's own masked
  // glyphs, so only dark ink there is another object.
  const table=limit=>{const sum=new Uint32Array((cw+1)*(ch+1));for(let y=0;y<ch;y++){let row=0;for(let x=0;x<cw;x++){row+=lum(pixels.d,(y*cw+x)*4)<limit?1:0;sum[(y+1)*(cw+1)+x+1]=sum[y*(cw+1)+x+1]+row;}}return (x0,y0,x1,y1)=>{x0=Math.max(0,Math.floor(x0));y0=Math.max(0,Math.floor(y0));x1=Math.min(cw,Math.ceil(x1));y1=Math.min(ch,Math.ceil(y1));return x1<=x0||y1<=y0?0:sum[y1*(cw+1)+x1]-sum[y0*(cw+1)+x1]-sum[y1*(cw+1)+x0]+sum[y0*(cw+1)+x0];};};
  // Thresholds follow the paper tone: on off-white or yellowed scans (paper ~235) a fixed 235 would call the
  // paper itself ink. Paper is the 75th luminance percentile; text and art cover far less than a quarter of a page.
  const tones=new Uint32Array(256);for(let i=0;i<cw*ch;i+=7)tones[Math.round(lum(pixels.d,i*4))]++;let tone=255;for(let v=0,seen=0,total=tones.reduce((s,n)=>s+n,0);v<256;v++){seen+=tones[v];if(seen>=total*.75){tone=v;break;}}
  const faint=table(Math.min(235,tone-22)),dark=table(Math.min(150,tone-90)),HALO=2.5;
  // The formula crops' tone curve darkens strokes only: each channel keeps every value at or above that channel's
  // paper level (75th percentile) and never comes out lighter than it went in, so a crop's paper on an off-white,
  // grey or yellowed scan, or a tinted panel, stays the page's own tone instead of a pale rectangle.
  const levels=[0,1,2].map(c=>{const counts=new Uint32Array(256);let total=0;for(let i=0;i<cw*ch;i+=7){counts[pixels.d[i*4+c]]++;total++;}for(let v=0,seen=0;v<256;v++){seen+=counts[v];if(seen>=total*.75)return v/255;}return 1;});
  const CURVE=[0,.05,.11,.19,.3,.45,.66,.96,1],curve=x=>{const t=Math.min(1,Math.max(0,x))*8,i=Math.min(7,Math.floor(t));return CURVE[i]+(CURVE[i+1]-CURVE[i])*(t-i);};
  for(const [i,c] of ['R','G','B'].entries())paper.querySelector(`#pdf-ink-tone feFunc${c}`)?.setAttribute('tableValues',Array.from({length:129},(_,k)=>{const v=k/128,p=Math.max(levels[i],.05);return (v>=p?v:Math.min(v,p*curve(v/p))).toFixed(4);}).join(' '));
  let protectedRegions=[];try{protectedRegions=JSON.parse(paper.dataset.protected||'[]').filter(r=>Array.isArray(r)&&r.length===4&&r.every(Number.isFinite));}catch{}
  const boxes=[...paper.querySelectorAll('.pdf-text-box')].map(el=>{const [x,y,w,h]=['left','top','width','height'].map(k=>parseFloat(el.style[k]));return {el,r:[x,y,x+w,y+h]};}),widest=Math.max(0,...boxes.map(o=>o.r[2]-o.r[0]));
  for(const self of boxes){
   const [x0,y0,x1,y1]=self.r,size=Number(self.el.dataset.baseFont)||10,clear=Math.max(2,size*.5),others=[...protectedRegions,...boxes.filter(o=>o!==self).map(o=>o.r)],inset=Math.min(1.5,(y1-y0)*.25);
   const hit=(a,b,c,e)=>others.some(o=>o[0]<c&&o[2]>a&&o[1]<e&&o[3]>b);
   // side: which edge of the box the region starts at, so its first HALO points are checked for dark ink only.
   const blocked=(a,b,c,e,side,ink=2)=>{if(hit(a,b,c,e))return true;const near=side==='right'?[a,b,Math.min(c,a+HALO),e]:side==='left'?[Math.max(a,c-HALO),b,c,e]:[a,b,c,Math.min(e,b+HALO)],far=side==='right'?[a+HALO,b,c,e]:side==='left'?[a,b,c-HALO,e]:[a,b+HALO,c,e];return dark(...near)>=ink||faint(...far)>=ink;};
   // The widest a one-line source may grow is its column: the edges of the nearest block sharing most of its width
   // and two em wider than it, so a heading in a two-column page never crosses the gutter. A label among labels of one
   // width (a diagram's 细胞壁 | 细胞核 | 液泡) has no column: ink and the other boxes stop it.
   const gapTo=o=>Math.max(0,o.r[1]-y1,y0-o.r[3]),mate=boxes.filter(o=>o!==self&&Math.min(o.r[2],x1)-Math.max(o.r[0],x0)>=.5*(x1-x0)&&o.r[2]-o.r[0]>=x1-x0+2*size).sort((p,q)=>gapTo(p)-gapTo(q))[0];
   const limitRight=Math.min(pw*.94,mate?Math.max(x1,mate.r[2]):pw*.94),limitLeft=Math.max(pw*.06,mate?Math.min(x0,mate.r[0]):pw*.06),limitBottom=ph*.94;
   const reach=(lo,hi,ok)=>{if(hi<=lo||!ok(lo+.5))return lo;while(hi-lo>.5){const mid=(lo+hi)/2;if(ok(mid))lo=mid;else hi=mid;}return lo;};
   const bottom=reach(y1,limitBottom,b=>!blocked(x0,y1,x1,b+clear,'bottom')),right=reach(x1,limitRight,r=>!blocked(x1,y0+inset,r+clear,y1-inset,'right')),left=x0-reach(0,x0-limitLeft,d=>!blocked(x0-d-clear,y0+inset,x0,y1-inset,'left'));
   self.el.dataset.roomBottom=bottom.toFixed(2);self.el.dataset.roomRight=right.toFixed(2);self.el.dataset.roomLeft=left.toFixed(2);
   // A one-line source set centred (a chapter title, a running head, a caption under its figure) grows evenly round its
   // printed centre: its centre is within 3% of the width of its column, of the page or of the figure right above or
   // below it, with an eighth of that width (and an em) blank on each side, so a full or left-aligned line is never
   // taken for one; against the page, a line as wide as the page's text is no title. A caption may be wider than its
   // figure: centred under it is enough.
   const centredIn=(a,b,loose)=>{const l=x0-a,r=b-x1;return loose?Math.abs(l-r)<=.06*Math.max(b-a,x1-x0)+2:Math.min(l,r)>=Math.max(size,.125*(b-a))&&Math.abs(l-r)<=.06*(b-a);};
   const figure=protectedRegions.find(o=>o[0]<x1&&o[2]>x0&&Math.max(y0-o[3],o[1]-y1)<=3*size&&Math.max(y0-o[3],o[1]-y1)>=-2);
   if(y1-y0<size*1.08*1.7&&((figure&&centredIn(figure[0],figure[2],self.el.dataset.kind==='caption'))||(mate&&centredIn(mate.r[0],mate.r[2]))||(!mate&&x1-x0<=.75*widest&&centredIn(0,pw))))self.el.dataset.centred='true';
   // A one-line source with other words beside it on its row ("又 EH," | fragment | "一点 E") must not wrap
   // onto a second line, which would land between the printed rows. A leftover speck is not a word.
   self.el.dataset.rowAlone=String(!blocked(x0-size*1.5,y0+inset,x0,y1-inset,'left',8)&&!blocked(x1,y0+inset,x1+size*1.5,y1-inset,'right',8));
  }
 }
}
// Self-contained (stringified into the page). Fit policy per block: (1) the base size in the source box, else in a
// grown box inside the measured room (one-line sources widen, paragraphs grow down); (2) shrink to 85% of the
// base; (3) to 60%; (4) only then to the old absolute minimum, reported as shrunk. fits() measures the real content
// bottom (no +1px tolerance that cut the last line's descenders). Blocks of one size group end at one size when
// they all fit within 90% of it. A lone line beside a tall formula row is centred in its box.
export function fitTextBoxes(root,{minFont=5.5,floorRatio=.85,lastRatio=.6,consistentRatio=.9}={}){
 const report=[],entries=[],doc=root.ownerDocument||root,boxes=[...root.querySelectorAll('.pdf-text-box')];
 const rectOf=el=>{const [x,y,w,h]=['left','top','width','height'].map(k=>parseFloat(el.style[k]));return [x,y,x+w,y+h];};
 const measure=el=>{
  const box=el.getBoundingClientRect(),k=el.offsetHeight>0?box.height/el.offsetHeight:1,range=doc.createRange();range.selectNodeContents(el);let bottom=box.top,right=box.left,top=Infinity;
  for(const r of range.getClientRects())if(r.width>0||r.height>0){bottom=Math.max(bottom,r.bottom);top=Math.min(top,r.top);}
  // Pre-wrap spaces hang past the edge in text rects (also inside inline spans), so width is checked on the
  // pieces that cannot wrap: images, glued formula+punctuation, fractions, roots, over-marks, 2-D environments (a
  // cases system, a matrix: math-text.js math-env) and stacks (limits, \overset, labelled arrows: math-stack).
  for(const child of el.querySelectorAll('img,.pdf-nobr,.math-frac,.math-sqrt,.math-vector,.math-over,.math-env,.math-stack')){const r=child.getBoundingClientRect();if(r.width>0)right=Math.max(right,r.right);}
  return {box,k,bottom,right,top:Number.isFinite(top)?top:box.top};
 };
 // slack: how far the last line's glyphs may hang below the box (in em); .06em is the font's content area.
 const fits=(el,slack=.06)=>{const {box,k,bottom,right}=measure(el),px=parseFloat(el.style.fontSize)*4/3*k;return el.scrollWidth<=el.clientWidth+1&&right<=box.right+.5*k&&bottom<=box.bottom+px*slack;};
 const set=(el,[w,h,x],size)=>{if(x!==undefined)el.style.left=`${x}pt`;el.style.width=`${w}pt`;el.style.height=`${h}pt`;el.style.fontSize=`${size}pt`;};
 // A grown box is tightened back to its content, so later blocks see the room it really uses.
 const tighten=(el,H0)=>{const {box,k,bottom}=measure(el),used=(bottom-box.top)/k*.75+.5;el.style.height=`${Math.min(parseFloat(el.style.height),Math.max(H0,used)).toFixed(2)}pt`;};
 for(const el of boxes){
  if(el.dataset.pending==='true')continue;
  el.style.paddingTop='';
  const base=Number(el.dataset.baseFont)||10,[L,T,R0,B0]=rectOf(el),W0=R0-L,H0=B0-T,single=H0<base*1.08*1.7;
  const roomR=Math.max(R0,Number(el.dataset.roomRight)||0),roomB=Math.max(B0,Number(el.dataset.roomBottom)||0),roomL=Math.min(L,Number(el.dataset.roomLeft)||L);
  // A one-line source set centred (prepareLayout's data-centred) grows evenly round its printed centre and is set
  // centred, so a chapter title or a caption under its figure stays centred; any other source grows to the right.
  const centred=single&&el.dataset.centred==='true',cx=(L+R0)/2,even=Math.max(W0/2,Math.min(cx-roomL,roomR-cx));
  // Never into a box an earlier block already grew into the same blank space. A shape is [width, height, left].
  const others=boxes.filter(o=>o!==el).map(rectOf),clip=([w,h,x=L])=>{let a=x,b=x+w;for(const o of others){if(o[1]<T+h&&o[3]>T){if(o[0]<b&&o[2]>R0)b=Math.max(R0,o[0]-2);if(o[2]>a&&o[0]<L)a=Math.min(L,o[2]+2);}if(o[0]<b&&o[2]>a&&o[1]<T+h&&o[3]>B0)h=Math.max(H0,o[1]-2-T);}if(centred){const half=Math.max(W0/2,Math.min(cx-a,b-cx));a=cx-half;b=cx+half;}return [b-a,h,a];};
  // A one-line box measured on the glyph ink can be shorter than one line box (1.08em) at the base size; it may take
  // a full line's height when the room below is blank. That is the line's own descent, not a second line.
  const H1=single&&H0<base*1.1?Math.max(H0,Math.min(base*1.1,clip([W0,roomB-T,L])[1])):H0,shapes=[[W0,H1,L]];
  if(centred&&even>W0/2+.5)shapes.push(clip([2*even,H1,cx-even]));else if(!centred&&single&&roomR>R0+1)shapes.push(clip([roomR-L,H1,L]));
  // A one-line source whose right side is taken (a label right before its figure's leader line) grows up to an em and
  // a half into the blank paper on its left instead, set flush right against what stops it.
  const back=Math.min(L-roomL,1.5*base);if(!centred&&single&&roomR-R0<.5*base&&back>.5*base)shapes.push(clip([R0-L+back+Math.max(0,roomR-R0),H1,L-back]));
  const wraps=single&&el.dataset.rowAlone==='true'&&roomB>B0+1;
  if((!single||wraps)&&roomB>B0+1)shapes.push(clip(centred?[2*even,roomB-T,cx-even]:[single?Math.max(W0,roomR-L):W0,roomB-T,L]));
  el.style.textAlign=centred?'center':'';
  // A size found by bisection sits at the very edge of fitting; .01pt less keeps the same lines when the page is
  // laid out again for printing.
  const search=(shape,lo,hi,slack)=>{set(el,shape,hi);if(fits(el,slack))return hi;set(el,shape,lo);if(!fits(el,slack))return null;const low=lo;let best=lo;for(let i=0;i<10;i++){const s=(lo+hi)/2;set(el,shape,s);if(fits(el,slack)){best=s;lo=s;}else hi=s;}return Math.max(low,best-.01);};
  const floor=Math.min(base,Math.max(minFont,base*floorRatio)),last=Math.min(floor,Math.max(minFont,base*lastRatio)),tiny=Math.min(last,minFont,base);let chosen=null;
  // A one-line source stays on one line down to the 85% floor before it may wrap into blank room below it.
  // Last resort before reporting overflow (which aborts the export): the smallest sizes may let the last line hang
  // into the .25em clip margin, where it stays visible. The old fit accepted a clipped 1px overhang here.
  const flat=wraps?shapes.slice(0,-1):shapes,tiers=[[base,base,flat],[floor,base,flat],...(wraps?[[floor,base,shapes.slice(-1)]]:[]),[last,floor,shapes],[tiny,last,shapes],[tiny,last,shapes,.24]];
  for(const [lo,hi,list,slack] of tiers){
   if(lo>hi)continue;
   for(const shape of list){const size=search(shape,lo,hi,slack);if(size!=null&&(!chosen||size>chosen.size+.01))chosen={shape,size};if(chosen&&lo===hi)break;}
   if(chosen)break;
  }
  const overflow=!chosen;
  if(chosen){set(el,chosen.shape,chosen.size);if(chosen.shape[1]>H0)tighten(el,H0);}else set(el,shapes.at(-1),tiny);
  if(!centred&&parseFloat(el.style.left)<L-.1)el.style.textAlign='right';
  el.dataset.overflow=String(overflow);
  entries.push({el,base,size:chosen?chosen.size:tiny,overflow,group:el.dataset.sizeGroup,W0,H0,floor});
 }
 const groups=new Map();for(const entry of entries)if(entry.group&&!entry.overflow&&entry.size>=entry.base*consistentRatio-.001)groups.set(entry.group,[...(groups.get(entry.group)||[]),entry]);
 for(const members of groups.values()){
  if(members.length<2)continue;const target=Math.min(...members.map(m=>m.size));
  for(const m of members)if(m.size>target+.01){m.size=target;m.unified=true;m.el.style.fontSize=`${target}pt`;if(parseFloat(m.el.style.height)>m.H0)tighten(m.el,m.H0);}
 }
 for(const entry of entries){
  // Rounded down: the search ends exactly at the largest size that fits, and rounding up can re-wrap the last word.
  const {el,base,overflow,W0,H0,floor,unified}=entry,size=Math.floor(entry.size*1000)/1000;
  el.style.fontSize=`${size}pt`;
  if(!overflow&&el.dataset.oneRow==='true'&&!(el.textContent||'').includes('\n')){
   const {box,k,bottom,top}=measure(el),px=size*4/3*k,content=bottom-top;
   if(content<px*2.2&&content<box.height*.6)el.style.paddingTop=`${((box.height-content)/2/k*.75).toFixed(2)}pt`;
  }
  const height=parseFloat(el.style.height),width=parseFloat(el.style.width);
  report.push({id:el.dataset.blockId,fontSize:size,overflow,base,grown:width>W0+.5||height>H0+.5?[+(width-W0).toFixed(1),+(height-H0).toFixed(1)]:null,shrunk:size<floor-.01,...(unified?{unified:true}:{}),...(el.style.paddingTop?{centred:true}:{})});
 }
 return report;
}
// The blocks of each translation call: at most maxCharacters of source and maxBlocks blocks, or a mode's layoutBatch
// ({chars,blocks}, translation-modes.js) given in their place. The defaults are Tiết kiệm's; the server takes at most 48.
export function blockBatches(blocks,maxCharacters=5000,maxBlocks=48){
 const limits=maxCharacters&&typeof maxCharacters==='object'?maxCharacters:{chars:maxCharacters,blocks:maxBlocks},chars=limits.chars>0?limits.chars:5000,most=Math.min(48,limits.blocks>=1?Math.floor(limits.blocks):48);
 const batches=[];let current=[],length=0;
 for(const b of blocks){if(current.length&&(length+b.source.length>chars||current.length>=most)){batches.push(current);current=[];length=0;}current.push(b);length+=b.source.length;}
 if(current.length)batches.push(current);return batches;
}
// Block IDs of each OCR call. A block packed into a sheet goes with every block of that sheet (the image is sent once);
// blocks of older manifests carry their own paragraph image. The two kinds never share a call. limits: a mode's ocrBatch
// ({images,blocks}, translation-modes.js), never above OCR_LIMITS; one sheet with more blocks than that is still one call.
export function ocrImageBatches(blocks,maxBytes=OCR_LIMITS.bytes,sheets=[],limits={}){
 // Labeled formulas are marked inside the paragraph image, so only unlabeled formula crops are uploaded.
 const formulas=b=>(b.inlines||[]).reduce((sum,i)=>sum+(/^@\d{1,3}$/u.test(i.label||'')?0:String(i.image||'').length),0),stored=new Map(sheets.map(s=>[s.id,s])),items=[],seen=new Set();
 for(const block of blocks){
  const sheet=stored.get(block.ocrSheet);
  if(!sheet){items.push({ids:[block.id],size:String(block.image||'').length+formulas(block)});continue;}
  if(seen.has(sheet.id))continue;seen.add(sheet.id);const ids=sheet.strips.map(s=>s.blockId);
  items.push({sheet:true,ids,size:String(sheet.image||'').length+blocks.filter(b=>ids.includes(b.id)).reduce((sum,b)=>sum+formulas(b),0)});
 }
 const images=Math.min(OCR_LIMITS.images,limits?.images>=1?Math.floor(limits.images):OCR_LIMITS.images),room=Math.min(OCR_LIMITS.sheetBlocks,limits?.blocks>=1?Math.floor(limits.blocks):OCR_LIMITS.sheetBlocks);
 const batches=[];let current=[],bytes=0;
 for(const item of items){
  if(item.size>maxBytes)throw new Error('Ảnh đoạn văn quá lớn; hãy tách đoạn trước khi đọc lại.');
  const full=current.length>=images||current.reduce((n,i)=>n+i.ids.length,0)+item.ids.length>room;
  if(current.length&&(full||current[0].sheet!==item.sheet||bytes+item.size>maxBytes)){batches.push(current.flatMap(i=>i.ids));current=[];bytes=0;}
  current.push(item);bytes+=item.size;
 }
 if(current.length)batches.push(current.flatMap(i=>i.ids));return batches;
}
