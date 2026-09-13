import pdfLibrary from './pdf.cjs';
import {cleanReaderText} from './pdf-cleaning.js';
const {PDFDocument}=pdfLibrary;
export const PDF_PAGES_PER_PART=2;
const manifestKey=id=>`split/${id}/manifest.json`;

export async function getPdfManifest(jobId,env){
 const stored=await env.FILES.get(manifestKey(jobId));
 return stored?stored.json():null;
}

// Only split a bounded number per request. No Gemini call is made here.
export async function preparePdf(job,env,maxParts=10){
 let manifest=await getPdfManifest(job.id,env);
 if(manifest?.complete)return manifest;
 const original=await env.FILES.get(job.file_key);
 if(!original)throw new Error('Không tìm thấy PDF gốc.');
 let pdf;
 try{pdf=await PDFDocument.load(await original.arrayBuffer(),{password:''});}
 catch{throw new Error('Không đọc được PDF. Hãy tải PDF mở được không cần mật khẩu.');}
 const totalPages=pdf.getPageCount();
 if(!totalPages)throw new Error('PDF không có trang.');
 manifest??={version:1,totalPages,pagesPerPart:PDF_PAGES_PER_PART,parts:[],complete:false};
 if(manifest.totalPages!==totalPages)throw new Error('PDF gốc đã thay đổi; hãy tạo tài liệu mới.');
 const totalParts=Math.ceil(totalPages/manifest.pagesPerPart);
 for(let n=0;n<maxParts&&manifest.parts.length<totalParts;n++){
  const index=manifest.parts.length,startPage=index*manifest.pagesPerPart+1,endPage=Math.min(totalPages,startPage+manifest.pagesPerPart-1);
  const small=await PDFDocument.create();
  const pages=await small.copyPages(pdf,Array.from({length:endPage-startPage+1},(_,i)=>startPage-1+i));
  pages.forEach(page=>small.addPage(page));
  const key=`split/${job.id}/part-${String(index+1).padStart(5,'0')}.pdf`;
  await env.FILES.put(key,await small.save(),{httpMetadata:{contentType:'application/pdf'}});
  manifest.parts.push({index,startPage,endPage,key});
  manifest.complete=manifest.parts.length===totalParts;
  // Checkpoint after each successful write so a retry never loses a completed part.
  await env.FILES.put(manifestKey(job.id),JSON.stringify(manifest));
 }
 return manifest;
}

export function assembleBook(cp){
 if(!cp.ocrDone||cp.translatedChars!==cp.source.length||!cp.translations.length||cp.translations.some(p=>typeof p!=='string'||!p.trim()))throw new Error('Chưa dịch đủ các phần để ghép thành quyển.');
 if(cp.totalPages&&cp.page!==cp.totalPages)throw new Error('Chưa xử lý đủ trang của PDF.');
 return cleanReaderText(cp.translations.join('\n\n'));
}
