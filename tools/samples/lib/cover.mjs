// The book cover, found the way the study workspace finds it (frontend/cover-detect.js): page 1, or page 2 after a
// blank flyleaf, scored from its pixels and from the page labels and outline of the PDF. PyMuPDF draws the pages here,
// so pdf.js is not needed in Node.
import {detectCover} from '../../../frontend/cover-detect.js';
import {pdfTool} from './machine.mjs';

// The part of a pdf.js document detectCover reads, from pdf_tool.py info (labels and a flat outline).
export const coverDocument=info=>({numPages:info.pages,getPageLabels:async()=>info.labels||null,getOutline:async()=>(info.toc||[]).filter(([,,page])=>page>0).map(([,title,page])=>({title,dest:[page-1],items:[]}))});
export async function rasterPage(pdfPath,page,width=600){
 const result=await pdfTool(['raster',pdfPath,page,width]);
 return {data:new Uint8ClampedArray(Buffer.from(result.rgba,'base64')),width:result.width,height:result.height};
}
// choice: "auto", "none" or a page number. Returns {page (0 = none), reasons}.
export async function chooseCover(pdfPath,info,choice,{render=page=>rasterPage(pdfPath,page)}={}){
 if(choice==='none')return {page:0,reasons:['sample.json đặt "cover": "none"']};
 if(Number.isInteger(choice)){if(choice>info.pages)throw new Error(`Trang bìa ${choice} vượt quá số trang của PDF (${info.pages}).`);return {page:choice,reasons:['trang bìa do sample.json chỉ định']};}
 const found=await detectCover(coverDocument(info),render);
 return {page:found.page,reasons:found.page?found.reasons:[`không nhận ra bìa ở trang ${found.checked}${found.reasons?.length?` (${found.reasons.join(', ')})`:''}`]};
}
