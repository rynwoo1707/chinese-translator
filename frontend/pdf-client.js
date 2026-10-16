const PAGE_NUMBER=/^(?:[-–—]\s*)?(?:(?:trang|page)\s*)?\d+(?:\s*[\/／]\s*\d+)?(?:\s*(?:页|頁))?(?:\s*[-–—])?$/iu;
import {normalizePolygon} from './document-layout.js';
const CJK=/[\u3400-\u9fff\uf900-\ufaff]/u;
const END_PUNCT=/[。！？!?；;：:…」』”’）】]$/u;
const HEADING=/^(?:第.{1,12}[章节回卷]|章(?:节)?\s*\d+|chapter\s+\d+)/iu;

export function normalizePdfLine(value){return String(value||'').replace(/[\u00a0\u2000-\u200b\u3000]/g,' ').replace(/[ \t]+/g,' ').trim();}
export function cleanPdfPages(rawPages,{preserveBodyNumbers=false}={}){
 const pages=rawPages.map(page=>String(page||'').split(/\r?\n/).map(normalizePdfLine).filter(Boolean)),edgeCounts=new Map();
 for(const lines of pages){if(lines.length<3)continue;for(const line of new Set([...lines.slice(0,2),...lines.slice(-2)])){const key=line.toLocaleLowerCase();edgeCounts.set(key,(edgeCounts.get(key)||0)+1);}}
 const repeated=new Set([...edgeCounts].filter(([,count])=>pages.length>2&&count>=Math.max(2,Math.ceil(pages.length*.45))).map(([line])=>line));
 return pages.map((lines,pageIndex)=>{const clean=lines.filter((line,index)=>(!PAGE_NUMBER.test(line)||(preserveBodyNumbers&&index>0&&index<lines.length-1))&&!repeated.has(line.toLocaleLowerCase())),paragraphs=[];let current='';for(const line of clean){if(!current){current=line;continue;}const join=CJK.test(current)&&CJK.test(line)&&!END_PUNCT.test(current)&&!HEADING.test(line);if(join)current+=line;else{paragraphs.push(current);current=line;}}if(current)paragraphs.push(current);return `[Trang PDF ${pageIndex+1}]\n${paragraphs.join('\n')}`;}).join('\n\n').trim();
}
export function usefulPageText(text){const compact=String(text||'').replace(/\s/gu,''),cjk=(compact.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)||[]).length;return compact.length>=40&&cjk>=12;}
async function loadPdf(file){const pdfjs=await import('/vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';return pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;}
export async function pdfPageCount(file){const pdf=await loadPdf(file);try{return pdf.numPages;}finally{await pdf.loadingTask.destroy();}}
function itemsToLines(items){let textItems=items.filter(item=>'str' in item&&item.str);const vertical=textItems.filter(item=>item.dir==='ttb').length>textItems.length*.4;if(vertical)textItems=[...textItems].sort((a,b)=>(b.transform?.[4]||0)-(a.transform?.[4]||0)||(b.transform?.[5]||0)-(a.transform?.[5]||0));const lines=[];let current=[],lastAxis=null;for(const item of textItems){const axis=Math.round(item.transform?.[vertical?4:5]||0);if(lastAxis!==null&&(Math.abs(axis-lastAxis)>3||item.hasEOL)){if(current.length)lines.push(current.join(vertical?'':' '));current=[];}current.push(item.str);lastAxis=axis;if(item.hasEOL&&current.length){lines.push(current.join(vertical?'':' '));current=[];lastAxis=null;}}if(current.length)lines.push(current.join(vertical?'':' '));return lines.join('\n');}
export function pdfTextLayout(items,viewport){
 const blocks=items.filter(item=>item.str?.trim()).map((item,index)=>{
  const [a,b,,,x,y]=item.transform,angle=Math.atan2(b,a),w=item.width,h=item.height||Math.hypot(a,b);
  const poly=[[x,y],[x+w*Math.cos(angle),y+w*Math.sin(angle)],[x+w*Math.cos(angle)-h*Math.sin(angle),y+w*Math.sin(angle)+h*Math.cos(angle)],[x-h*Math.sin(angle),y+h*Math.cos(angle)]].map(point=>viewport.convertToViewportPoint(...point));
  return {id:`text-${index+1}`,text:normalizePdfLine(item.str),confidence:100,box:normalizePolygon(poly,viewport.width,viewport.height)};
 }).filter(block=>block.box);
 return {engine:'pdf-text',width:viewport.width,height:viewport.height,blocks};
}
export async function analyzePdf(file,onProgress=()=>{}){
 const pdf=await loadPdf(file),rawPages=[],pages=[];
 try{
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number),content=await page.getTextContent({includeMarkedContent:false}),text=itemsToLines(content.items);
   rawPages.push(text);pages.push({number,kind:usefulPageText(text)?'text':'scan',text:'',layout:pdfTextLayout(content.items,page.getViewport({scale:1}))});
   onProgress(number,pdf.numPages,'text');page.cleanup();
  }
  const cleaned=cleanPdfPages(rawPages,{preserveBodyNumbers:true});
  for(const block of cleaned.split(/\n\n(?=\[Trang PDF \d+\]\n)/u)){
   const match=block.match(/^\[Trang PDF (\d+)\]\n?([\s\S]*)$/u);if(match)pages[Number(match[1])-1].text=match[2].trim();
  }
  for(const page of pages)if(page.kind==='text'&&!page.text)page.kind='scan';
  const pagesWithText=pages.filter(page=>page.kind==='text').length,scanPages=pages.length-pagesWithText;
  return {mode:scanPages?(pagesWithText?'hybrid':'scan'):'text',totalPages:pages.length,text:cleaned,pagesWithText,scanPages,pages};
 }finally{await pdf.loadingTask.destroy();}
}
function canvasBlob(canvas,type,quality){return new Promise(resolve=>canvas.toBlob(resolve,type,quality));}
export async function uploadOptimizedScan(file,uploadPage,onProgress=()=>{},selectedPages=null){
 const pdf=await loadPdf(file);
 try{
 for(let number=1;number<=pdf.numPages;number++){
  if(selectedPages&&!selectedPages.has(number))continue;
  const page=await pdf.getPage(number),base=page.getViewport({scale:1}),scale=Math.min(2.4,1600/base.width),viewport=page.getViewport({scale}),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height));
  const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  await page.render({canvasContext:context,viewport,background:'rgb(255,255,255)'}).promise;
  // Keep a colour copy for diagrams and figures before converting the OCR input to grayscale.
  const previewBlob=await canvasBlob(canvas,'image/webp',.84)||await canvasBlob(canvas,'image/jpeg',.86);
  const pixels=context.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<pixels.data.length;i+=4){const gray=Math.round(.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2]);pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;}
  context.putImageData(pixels,0,0);
  const blob=await canvasBlob(canvas,'image/webp',.78)||await canvasBlob(canvas,'image/jpeg',.8);
  if(!blob||!previewBlob)throw new Error(`Không tối ưu được ảnh trang ${number}.`);
  await uploadPage({blob,previewBlob,width:canvas.width,height:canvas.height},number,pdf.numPages);
  page.cleanup();canvas.width=canvas.height=1;onProgress(number,pdf.numPages,'scan');
 }
 }finally{await pdf.loadingTask.destroy();}
}

// Mixed PDFs keep extractable pages as text and rasterize only pages that need OCR.
export async function uploadPreparedPdf(file,analysis,uploadPage,onProgress=()=>{},selectedPages=null,{keepTextPreviews=false}={}){
 const included=page=>!selectedPages||selectedPages.has(page.number);
 const selected=new Set(analysis.pages.filter(page=>included(page)&&(page.kind==='scan'||keepTextPreviews)).map(page=>page.number));
 for(const page of analysis.pages){if(included(page)&&page.kind==='text'&&!keepTextPreviews){await uploadPage({kind:'text',text:page.text,layout:page.layout},page.number,analysis.totalPages);onProgress(page.number,analysis.totalPages,'text');}}
 if(selected.size)await uploadOptimizedScan(file,async(images,number,total)=>{const page=analysis.pages[number-1];await uploadPage({kind:page.kind,text:page.text,layout:page.layout,...images},number,total);},onProgress,selected);
}
