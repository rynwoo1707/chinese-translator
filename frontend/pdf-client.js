import {normalizePolygon,joinLines,pageFurniture,glyphRows,glyphRegions} from './document-layout.js';
import {PDFJS_ASSETS,formatPageRange} from './cover-detect.js';
export {scanReading} from './ocr-policy.js';
const HAN=/[\u3400-\u9fff\uf900-\ufaff]/gu,HAN_GLYPH=/[\u3400-\u9fff\uf900-\ufaff]/u;
const hanCount=text=>(String(text||'').match(HAN)||[]).length;
// A page's edges, where running heads and feet, page numbers and stamps stand: its top and bottom tenth.
const BAND=.1;

export function normalizePdfLine(value){return String(value||'').replace(/[\u00a0\u2000-\u200b\u3000]/g,' ').replace(/[ \t]+/g,' ').trim();}
// The text of a document's pages as translation gets it ([Trang PDF n] before each): page furniture out (pageFurniture:
// page labels, page numbers in step with the pages, a running head or foot where it repeats after its first place),
// wrapped lines joined into paragraphs, headings, captions and rows kept on their own lines (joinLines). A page is its
// text, whose first and last two lines are its edges (guessed), or (analyzePdf) its lines placed on the page, whose
// edges are the lines in its top or bottom tenth set no larger than its body text: firm in smaller type, guessed for a
// body line that opens or closes the page.
export function cleanPdfPages(rawPages){return pagesText(cleanPages(rawPages));}
const pagesText=pages=>pages.map(page=>`[Trang PDF ${page.number}]\n${page.paragraphs.map(paragraph=>paragraph.text).join('\n')}`).join('\n\n').trim();
function cleanPages(rawPages){
 const pages=rawPages.map((page,index)=>{
  const placed=Array.isArray(page?.lines),lines=(placed?page.lines:String(page??'').split(/\r?\n/u).map(text=>({text}))).map(line=>({...line,text:normalizePdfLine(line.text)})).filter(line=>line.text);
  // The body's type size: the size half of the page's characters are set in or under.
  const sizes=lines.filter(line=>line.size&&!line.vertical).map(line=>[line.size,[...line.text].length]).sort((a,b)=>a[0]-b[0]),total=sizes.reduce((sum,[,count])=>sum+count,0);
  let body=0;for(let k=0,seen=0;k<sizes.length;k++){seen+=sizes[k][1];if(seen>=total/2){body=sizes[k][0];break;}}
  lines.forEach((line,i)=>{
   // A placed edge is firm in type smaller than the body (a running head, a foot, a folio, a stamp in the margin); a body
   // line that opens or closes the page (a heading, an exercise, an answer) is only guessed to be one.
   line.edge=placed?edgeOf(line,body):i<2?'top':i>=lines.length-2?'bottom':'';line.guess=Boolean(line.edge)&&!(placed&&body&&line.size&&line.size<=.95*body);
   // A chapter's own title, set larger than the body: the first place of the running head that repeats it.
   if(placed&&body&&!line.vertical&&line.size>body*1.15)line.title=true;
  });
  return {number:placed?page.number??index+1:index+1,lines};
 });
 const furniture=pageFurniture(pages);
 return pages.map((page,index)=>({number:page.number,paragraphs:joinLines(page.lines.flatMap((line,i)=>furniture[index].drop.has(i)?[]:[{...line,keep:furniture[index].furniture.has(i)}]))}));
}
// Where a placed line stands: at the top or bottom edge of its page (in its outer tenth, in type no larger than the
// body text: a chapter's big title is never page furniture), or ''.
function edgeOf(line,body){
 if(!line.box||line.vertical||body&&line.size>body*1.15)return '';
 const {y,height}=line.box;
 return y<BAND&&y+height<2*BAND?'top':y+height>1-BAND&&y>1-2*BAND?'bottom':'';
}
export function usefulPageText(text){const compact=String(text||'').replace(/\s/gu,''),cjk=(compact.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)||[]).length;return compact.length>=40&&cjk>=12;}
// pdf.js reports a protected or broken file in English (PasswordException "No password given", InvalidPDFException
// "Invalid PDF structure."); the student is told in Vietnamese what to do. A browser too old for this pdf.js fails with a
// TypeError or SyntaxError (a missing built-in), which is said as such rather than as a broken file.
export function pdfOpenError(error){
 const name=String(error?.name||''),said=(message,code)=>Object.assign(new Error(message),{code,cause:error});
 if(name==='PasswordException')return said('PDF này có mật khẩu mở tệp nên Hoa Trí không đọc được. Hãy mở tệp bằng mật khẩu, lưu (hoặc in) thành một bản PDF không có mật khẩu, rồi chọn bản đó.','pdf_password');
 if(['InvalidPDFException','FormatError','MissingPDFException','UnknownErrorException','ResponseException'].includes(name))return said('Không đọc được tệp PDF này: tệp bị hỏng, chưa tải về đủ hoặc không phải PDF. Hãy tải lại tệp gốc rồi chọn lại.','pdf_invalid');
 if(error instanceof TypeError||error instanceof SyntaxError||['TypeError','SyntaxError'].includes(name))return said('Trình duyệt này chưa đọc được PDF, có thể vì phiên bản trình duyệt đã cũ. Hãy cập nhật trình duyệt (hoặc dùng Chrome, Edge, Firefox, Safari bản mới) rồi chọn lại tệp.','pdf_browser');
 return error;
}
// pdf.js gets the CMaps, standard fonts and scan decoders it reads and draws every page with (PDFJS_ASSETS): without
// them a line set in a Chinese font through a predefined CMap (UniGB-UCS2-H, GBK-EUC-H…) has no text and draws blank.
async function loadPdf(file){
 // A reader that does not arrive is the network's fault; one this browser cannot run is the browser's.
 const pdfjs=await import('/vendor/pdf.mjs').catch(error=>{throw error instanceof SyntaxError?pdfOpenError(error):Object.assign(new Error('Không tải được bộ đọc PDF. Hãy kiểm tra mạng rồi chọn lại tệp.'),{code:'pdf_reader',cause:error});});
 pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
 const data=new Uint8Array(await file.arrayBuffer());
 try{return await pdfjs.getDocument({data,...PDFJS_ASSETS}).promise;}catch(error){throw pdfOpenError(error);}
}
export async function pdfPageCount(file){const pdf=await loadPdf(file);try{return pdf.numPages;}finally{await pdf.loadingTask.destroy();}}
// A text item's box on the page (0-1 from the top left): from its baseline up one type size, along its direction.
function itemBox(item,viewport){
 const [a,b,,,x,y]=item.transform,angle=Math.atan2(b,a),w=item.width,h=item.height||Math.hypot(a,b);
 const poly=[[x,y],[x+w*Math.cos(angle),y+w*Math.sin(angle)],[x+w*Math.cos(angle)-h*Math.sin(angle),y+w*Math.sin(angle)+h*Math.cos(angle)],[x-h*Math.sin(angle),y+h*Math.cos(angle)]].map(point=>viewport.convertToViewportPoint(...point));
 return normalizePolygon(poly,viewport.width,viewport.height);
}
// The text items of a page as lines, in the order the page draws them (vertical writing read in columns from the
// right), each with its box on the page, its type size (points; em: the same, 0-1 of the page's width), whether it is
// vertical and whether it is a table's row (cells: items set more than an em and a half apart along it). pdf.js marks
// the item a line break follows (hasEOL): the line ends after it.
function textLines(items,viewport){
 let textItems=items.filter(item=>'str' in item&&item.str);
 const vertical=textItems.filter(item=>item.dir==='ttb').length>textItems.length*.4;
 if(vertical)textItems=[...textItems].sort((a,b)=>(b.transform?.[4]||0)-(a.transform?.[4]||0)||(b.transform?.[5]||0)-(a.transform?.[5]||0));
 const lines=[];let current=[],lastAxis=null;
 const close=()=>{
  if(!current.length)return;
  const boxes=current.map(item=>item.transform&&itemBox(item,viewport)).filter(Boolean),x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y));
  const size=Math.max(...current.map(item=>item.height||Math.hypot(item.transform?.[0]||0,item.transform?.[1]||0))),words=current.filter(item=>item.str.trim()&&item.transform&&Math.abs(item.transform[1])<.02*Math.abs(item.transform[0]||1)).sort((a,b)=>a.transform[4]-b.transform[4]);
  const cells=!vertical&&words.some((item,k)=>k&&item.transform[4]-(words[k-1].transform[4]+(words[k-1].width||0))>1.5*size);
  lines.push({text:current.map(item=>item.str).join(vertical?'':' '),box:boxes.length?{x,y,width:Math.max(...boxes.map(box=>box.x+box.width))-x,height:Math.max(...boxes.map(box=>box.y+box.height))-y}:null,size,em:size/viewport.width,vertical,...(cells?{cells}:{})});
  current=[];
 };
 for(const item of textItems){
  const axis=Math.round(item.transform?.[vertical?4:5]||0);
  if(lastAxis!==null&&Math.abs(axis-lastAxis)>3)close();
  current.push(item);lastAxis=axis;
  if(item.hasEOL){close();lastAxis=null;}
 }
 close();
 return lines;
}
export function pdfTextLayout(items,viewport){
 const blocks=items.filter(item=>item.str?.trim()).map((item,index)=>({id:`text-${index+1}`,text:normalizePdfLine(item.str),confidence:100,box:itemBox(item,viewport)})).filter(block=>block.box);
 return {engine:'pdf-text',width:viewport.width,height:viewport.height,blocks};
}

// What a page paints, from pdf.js's operator list: the share of the page its pictures cover (summed, so a scan cut into
// strips or layers counts whole), the Han its text shows (han), of them those shown invisibly (render mode 3 or 7) or
// before opaque pictures that then cover nine tenths of the page, how many pictures it paints and how many filled
// outlines with curves (glyphs drawn as paths). A searchable scan keeps its OCR text so; a born-digital page shows its
// text beside or over its pictures, or under a translucent one (a publisher's sample mark or a site's logo laid over the
// page): painted at a fill alpha under 0.99, in a blend mode other than normal or through a soft mask, with an alpha of
// its own (pdf.js wraps such an image in save, setGState SMask false, the image, restore) or as a stencil (an image mask
// inks only its set bits), a picture hides nothing under it.
export async function pagePaint(page,OPS){
 const {fnArray,argsArray}=await page.getOperatorList(),[vx0,vy0,vx1,vy1]=page.view,area=Math.max(1,(vx1-vx0)*(vy1-vy0));
 const multiply=(m,n)=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
 const share=m=>{const xs=[m[4],m[0]+m[4],m[2]+m[4],m[0]+m[2]+m[4]],ys=[m[5],m[1]+m[5],m[3]+m[5],m[1]+m[3]+m[5]];return Math.max(0,Math.min(Math.max(...xs),vx1)-Math.max(Math.min(...xs),vx0))*Math.max(0,Math.min(Math.max(...ys),vy1)-Math.max(Math.min(...ys),vy0))/area;};
 const images=new Set([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageXObjectRepeat,OPS.paintImageMaskXObject,OPS.paintImageMaskXObjectRepeat,OPS.paintSolidColorImageMask]),stencils=new Set([OPS.paintImageMaskXObject,OPS.paintImageMaskXObjectRepeat]);
 const groups=new Set([OPS.paintInlineImageXObjectGroup,OPS.paintImageMaskXObjectGroup]),fills=new Set([OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);
 // A path is a run of drawing ops (pdf.js DrawOPS: 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath).
 const curved=path=>{if(!path)return false;for(let k=0;k<path.length;){const op=path[k++];if(op===2||op===3)return true;if(!(op>=0&&op<=4))return false;k+=[2,2,6,4,0][op];}return false;};
 const ownAlpha=i=>{const k=fnArray[i-1]===OPS.beginMarkedContentProps?i-2:i-1,entries=argsArray[k]?.[0];return fnArray[k]===OPS.setGState&&fnArray[k-1]===OPS.save&&entries?.length===1&&entries[0]?.[0]==='SMask'&&entries[0][1]===false;};
 let ctm=[1,0,0,1,0,0],mode=0,look={alpha:1,blend:'source-over',soft:false},han=0,hidden=0,pictures=0,outlines=0;const stack=[],shown=[],painted=[];
 for(let i=0;i<fnArray.length;i++){
  const fn=fnArray[i],args=argsArray[i];
  if(fn===OPS.save||fn===OPS.paintFormXObjectBegin){stack.push([ctm,mode,look]);if(fn===OPS.paintFormXObjectBegin&&args?.[0]?.length===6)ctm=multiply(ctm,args[0]);}
  else if(fn===OPS.restore||fn===OPS.paintFormXObjectEnd){const state=stack.pop();if(state)[ctm,mode,look]=state;}
  else if(fn===OPS.transform)ctm=multiply(ctm,args);
  else if(fn===OPS.setTextRenderingMode)mode=args[0];
  else if(fn===OPS.setGState){look={...look};for(const [key,value] of args?.[0]||[]){if(key==='ca')look.alpha=Number(value);else if(key==='BM')look.blend=value;else if(key==='SMask')look.soft=Boolean(value);}}
  else if(fn===OPS.showText){
   let count=0;for(const glyph of args[0]||[])if(glyph?.unicode&&HAN_GLYPH.test(glyph.unicode))count++;
   han+=count;if(count&&(mode===3||mode===7))hidden+=count;else if(count)shown.push([i,count]);
  }
  else if(images.has(fn)){const part=share(ctm),opaque=!(look.alpha<.99)&&!look.soft&&(!look.blend||look.blend==='source-over')&&!stencils.has(fn)&&!ownAlpha(i);painted.push([i,part,opaque?part:0]);if(part>.002)pictures++;}
  else if(groups.has(fn))pictures++;
  else if(fn===OPS.constructPath&&fills.has(args?.[0])&&curved(args[1]?.[0]))outlines++;
 }
 const after=new Float64Array(painted.length+1);for(let k=painted.length-1;k>=0;k--)after[k]=after[k+1]+painted[k][2];
 let covered=0,next=0;for(const [at,han] of shown){while(next<painted.length&&painted[next][0]<at)next++;if(after[next]>=.9)covered+=han;}
 return {cover:Math.min(1,painted.reduce((sum,[,part])=>sum+part,0)),han,hidden,covered,pictures,outlines};
}
// Why a page whose text layer would make it 'text' is read as a scan all the same: 'hidden', a scan under its own OCR
// text (a searchable scan: twelve Han or more, and at least half of the page's, shown invisibly or covered by the
// picture painted after them; a page of text over a background picture whose title is set as a clip shows the rest);
// 'stamp', a scan whose visible text is all page furniture (a site's stamp, a running head, a page number: in the top
// or bottom tenth of the page, or set aslant). Either needs pictures over half the page; '' for a page of text.
function scanBeneath(paint,items,viewport){
 if(paint.cover<.5)return '';
 const unseen=paint.hidden+paint.covered;
 if(unseen>=12&&unseen*2>=paint.han)return 'hidden';
 const visible=items.filter(item=>item.str?.trim()&&item.transform);
 return visible.length&&visible.every(item=>{
  const [a,b]=item.transform,scale=Math.hypot(a,b)||1;if(Math.abs(a)>.02*scale&&Math.abs(b)>.02*scale)return true;
  const box=itemBox(item,viewport);return !box||box.y+box.height/2<BAND||box.y+box.height/2>1-BAND;
 })?'stamp':'';
}
// The rule analyzePdf reads a page by, for a page whose text layer holds Han (whole-book.js surveyPages): a scan?
export async function readsAsScan(page,items){
 const {OPS}=await import('/vendor/pdf.mjs');
 return Boolean(scanBeneath(await pagePaint(page,OPS),items,page.getViewport({scale:1})));
}
// Han a text page shows as a picture or in outlines, which its text layer lacks: the page drawn at about 1.5 px/pt, the
// boxes of its text items blanked (a CJK glyph reaches a quarter of its size past them), its rows of Han glyphs found
// (glyphRows) and grouped into the regions an OCR pass reads.
async function pictureRegions(pdf,page,layout,viewport){
 const scale=Math.min(1.5,1300/Math.max(viewport.width,viewport.height)),view=page.getViewport({scale});
 const width=Math.max(1,Math.round(view.width)),height=Math.max(1,Math.round(view.height)),target=pdf.canvasFactory.create(width,height);
 try{
  await page.render({canvasContext:target.context,viewport:view,background:'rgb(255,255,255)'}).promise;
  const {data}=target.context.getImageData(0,0,width,height),gray=new Uint8Array(width*height);
  for(let i=0,p=0;p<gray.length;i+=4,p++)gray[p]=(299*data[i]+587*data[i+1]+114*data[i+2])/1000|0;
  const mask=layout.blocks.map(({box})=>({x0:box.x*width-1,x1:(box.x+box.width)*width+1,y0:(box.y-box.height*.25)*height-1,y1:(box.y+box.height*1.25)*height+1}));
  return glyphRegions(glyphRows(gray,width,height,{scale,mask}),width,height);
 }finally{pdf.canvasFactory.destroy(target);}
}
// A page the 40-character, 12-Han rule calls 'text' is checked against what it paints (pagePaint): a scan under its
// own OCR text or under a stamp is read as a scan (reclassified; the layer stays as its text, which a reading from the
// pixels replaces only when it holds clearly more Han: scanReading); on a page that stays text, the Han shown in
// pictures or outlines is found (regions), for the device to read. A vertical page keeps its text as it is.
async function checkTextPage(pdf,page,entry,items,viewport,OPS){
 let paint;try{paint=await pagePaint(page,OPS);}catch{return;}
 const reason=scanBeneath(paint,items,viewport);
 if(reason){entry.kind='scan';entry.reclassified=reason;return;}
 if((paint.pictures||paint.outlines)&&!entry.lines.some(line=>line.vertical)){const regions=await pictureRegions(pdf,page,entry.layout,viewport).catch(()=>[]);if(regions.length)entry.regions=regions;}
}
const pictureCells=page=>(page.regions||[]).reduce((sum,region)=>sum+region.cells,0);
const FOUND={hidden:'lớp chữ có sẵn của PDF là chữ nhận dạng nằm ẩn dưới ảnh scan nên trang được đọc lại từ ảnh.',stamp:'lớp chữ của PDF chỉ có dấu hoặc chữ ở mép trang scan nên trang được đọc từ ảnh.'};
// Per page: kind 'text' (translated from its text layer) or 'scan' (read from its pixels); reclassified ('hidden' or
// 'stamp') for a scan whose text layer is kept as a hint; regions for Han shown in pictures or outlines on a text page;
// paragraphs ({text, top}) of its cleaned text; note, what the analysis found on it. notes: the same for the whole
// document, the pages of one finding named together.
export async function analyzePdf(file,onProgress=()=>{}){
 const pdf=await loadPdf(file),{OPS}=await import('/vendor/pdf.mjs'),pages=[];
 try{
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number),viewport=page.getViewport({scale:1}),content=await page.getTextContent({includeMarkedContent:false});
   const lines=textLines(content.items,viewport),entry={number,kind:usefulPageText(lines.map(line=>line.text).join('\n'))?'text':'scan',text:'',layout:pdfTextLayout(content.items,viewport),lines};
   if(entry.kind==='text')await checkTextPage(pdf,page,entry,content.items,viewport,OPS);
   pages.push(entry);onProgress(number,pdf.numPages,'text');page.cleanup();
  }
  const cleaned=cleanPages(pages);
  for(const [index,page] of pages.entries()){
   page.paragraphs=cleaned[index].paragraphs;page.text=page.paragraphs.map(paragraph=>paragraph.text).join('\n');delete page.lines;
   if(page.kind==='text'&&!page.text){page.kind='scan';delete page.regions;}
   const note=page.reclassified?FOUND[page.reclassified]:page.regions?`khoảng ${pictureCells(page)} chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh.`:'';
   if(note)page.note=`Trang ${page.number}: ${note}`;
  }
  const notes=[...Object.entries(FOUND).map(([reason,note])=>{const numbers=pages.filter(page=>page.reclassified===reason).map(page=>page.number);return numbers.length?`Trang ${formatPageRange(numbers)}: ${note}`:'';}).filter(Boolean),...pages.filter(page=>page.regions).map(page=>page.note)];
  const pagesWithText=pages.filter(page=>page.kind==='text').length,scanPages=pages.length-pagesWithText;
  return {mode:scanPages?(pagesWithText?'hybrid':'scan'):'text',totalPages:pages.length,text:pagesText(cleaned),pagesWithText,scanPages,reclassified:pages.filter(page=>page.reclassified).length,pictured:pages.filter(page=>page.regions).length,notes,pages};
 }finally{await pdf.loadingTask.destroy();}
}
function canvasBlob(canvas,type,quality){return new Promise(resolve=>canvas.toBlob(resolve,type,quality));}
// One region of a drawn page as an image of its own for OCR (light text on a dark band turned dark on light): WebP, or
// JPEG where the browser cannot write WebP (it would give a PNG), the two kinds the OCR routes take.
async function regionBlob(source,{box,light}){
 const x=Math.max(0,Math.floor(box.x*source.width)),y=Math.max(0,Math.floor(box.y*source.height)),width=Math.min(source.width-x,Math.ceil(box.width*source.width)),height=Math.min(source.height-y,Math.ceil(box.height*source.height));
 if(width<4||height<4)return null;
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});context.drawImage(source,x,y,width,height,0,0,width,height);
 if(light){const pixels=context.getImageData(0,0,width,height);for(let i=0;i<pixels.data.length;i+=4)for(let k=0;k<3;k++)pixels.data[i+k]=255-pixels.data[i+k];context.putImageData(pixels,0,0);}
 let blob=await canvasBlob(canvas,'image/webp',.92);if(blob?.type!=='image/webp')blob=await canvasBlob(canvas,'image/jpeg',.92);
 canvas.width=canvas.height=1;return blob;
}
// regionsOf(number): the regions of a page to send along as images of their own (regions: [{box, cells, light, blob}]).
export async function uploadOptimizedScan(file,uploadPage,onProgress=()=>{},selectedPages=null,regionsOf=()=>null){
 const pdf=await loadPdf(file);
 try{
 for(let number=1;number<=pdf.numPages;number++){
  if(selectedPages&&!selectedPages.has(number))continue;
  const page=await pdf.getPage(number),base=page.getViewport({scale:1}),scale=Math.min(2.4,1600/base.width),viewport=page.getViewport({scale}),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height));
  const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  await page.render({canvasContext:context,viewport,background:'rgb(255,255,255)'}).promise;
  // Keep a colour copy for diagrams and figures before converting the OCR input to grayscale.
  const previewBlob=await canvasBlob(canvas,'image/webp',.84)||await canvasBlob(canvas,'image/jpeg',.86),regions=[];
  for(const region of regionsOf(number)||[]){const blob=await regionBlob(canvas,region);if(blob)regions.push({...region,blob});}
  const pixels=context.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<pixels.data.length;i+=4){const gray=Math.round(.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2]);pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;}
  context.putImageData(pixels,0,0);
  const blob=await canvasBlob(canvas,'image/webp',.78)||await canvasBlob(canvas,'image/jpeg',.8);
  if(!blob||!previewBlob)throw new Error(`Không tối ưu được ảnh trang ${number}.`);
  await uploadPage({blob,previewBlob,width:canvas.width,height:canvas.height,...(regions.length?{regions}:{})},number,pdf.numPages);
  page.cleanup();canvas.width=canvas.height=1;onProgress(number,pdf.numPages,'scan');
 }
 }finally{await pdf.loadingTask.destroy();}
}

// Mixed PDFs keep extractable pages as text and rasterize only pages that need OCR: scans, and text pages showing Han
// in pictures or outlines, whose regions come along as images of their own (readPictureText reads them). A page is
// given with its paragraphs, what the analysis found on it (note) and, read as a scan despite its text layer, why
// (reclassified; its text is then the layer: scanReading weighs it against the reading).
export async function uploadPreparedPdf(file,analysis,uploadPage,onProgress=()=>{},selectedPages=null,{keepTextPreviews=false}={}){
 const included=page=>!selectedPages||selectedPages.has(page.number),drawn=page=>page.kind==='scan'||keepTextPreviews||Boolean(page.regions);
 const selected=new Set(analysis.pages.filter(page=>included(page)&&drawn(page)).map(page=>page.number));
 const described=page=>({kind:page.kind,text:page.text,layout:page.layout,paragraphs:page.paragraphs,...(page.reclassified?{reclassified:page.reclassified}:{}),...(page.note?{note:page.note}:{})});
 for(const page of analysis.pages){if(included(page)&&!drawn(page)){await uploadPage(described(page),page.number,analysis.totalPages);onProgress(page.number,analysis.totalPages,'text');}}
 if(selected.size)await uploadOptimizedScan(file,async(images,number,total)=>{await uploadPage({...described(analysis.pages[number-1]),...images},number,total);},onProgress,selected,number=>analysis.pages[number-1]?.regions);
}
// The text of a text page whose Han in pictures or outlines came along as regions (uploadPreparedPdf): each region is
// read by read(blob, region) (the device's OCR, or Gemini in Kỹ nhất: its text, or {text, sure}) and set among the page's
// paragraphs where it stands. A region inside one of the page's figures kept as pixels (figures: [{box}],
// keepPageFigures) stays in its figure, as the labels of a figure read from a scan do. A reading without Han that holds
// Latin letters or digits for half the region's cells or more (an English label, a formula) says the region holds no
// Chinese: it stays a picture, unnamed, unless the reader was not sure (sure: false, Tesseract, which may read a title as
// a few letters). A reader's error that has a status or a code (Gemini's quota or key, the network, a stop) is thrown,
// so the run waits or stops as for any other Gemini call; nothing read (ocr_empty), a reading Gemini refused, cut off or
// garbled (the same answer every time it is asked) and the device's own failures leave the region unread. The code is
// the error's own or, from the study page's api(), its answer's (data.code). note: what stays unread, for the reader to
// check.
const UNREAD=new Set(['ocr_empty','gemini_refused','gemini_truncated','gemini_malformed']);
export async function readPictureText(item,read,number,figures=[]){
 const readings=[],inside=({box},figure)=>box.x>=figure.box.x-.002&&box.y>=figure.box.y-.002&&box.x+box.width<=figure.box.x+figure.box.width+.002&&box.y+box.height<=figure.box.y+figure.box.height+.002;let missed=0;
 for(const region of (item.regions||[]).filter(region=>region.blob&&!figures.some(figure=>figure?.box&&inside(region,figure)))){
  let reading={};
  try{const value=await read(region.blob,region);reading=value&&typeof value==='object'?value:{text:value};}
  catch(error){const code=error?.code??error?.data?.code;if(!UNREAD.has(code)&&(Number.isInteger(error?.status)||code))throw error;}
  const text=String(reading.text||'').split(/\r?\n/u).map(normalizePdfLine).filter(Boolean).join('\n');
  if(hanCount(text))readings.push({text,top:region.box.y});
  else if(reading.sure===false||(text.match(/[\p{L}\p{N}]/gu)||[]).length<Math.max(2,region.cells/2))missed+=region.cells;
 }
 readings.sort((a,b)=>a.top-b.top);
 const merged=[];
 for(const paragraph of item.paragraphs||[{text:item.text||'',top:null}]){while(readings.length&&paragraph.top!==null&&readings[0].top<paragraph.top)merged.push(readings.shift().text);merged.push(paragraph.text);}
 merged.push(...readings.map(reading=>reading.text));
 return {text:merged.filter(Boolean).join('\n'),note:missed?`Trang ${number}: khoảng ${missed} chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên chưa dịch; hãy đối chiếu với PDF gốc.`:''};
}
