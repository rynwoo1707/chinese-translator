import {validateLayoutDocument,validateBlockTranslations,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {recognizePdfBlocks} from './pdf-block-ocr.js';
import {isStudyModel} from './gemini-models.js';
import {fileDisposition} from './download-filename.js';
import {keepSource} from './study-books.js';

const base='/api/my/study/pdf-layout';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const assetKey=(reader,id,file)=>`study/${reader.id}/pdf-layout/${id}/${file}`;
const decodeBytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
// 3: renderer rework (inline formula alignment, indents); older exports are re-rendered from saved translations, no Gemini call.
const RENDER_VERSION=3;
const sha256Hex=async file=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
function serviceUrl(env){
 if(!env.PDF_LAYOUT_SERVICE_URL||!env.PDF_LAYOUT_SERVICE_TOKEN)return null;
 const url=new URL(env.PDF_LAYOUT_SERVICE_URL);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','pdf-layout'].includes(url.hostname)))throw new Error('Dịch vụ PDF cần HTTPS.');return url;
}
// Older service builds returned MuPDF/Tesseract's whole stderr as the error, with the real cause at the very end.
const SERVICE_NOISE=/Warning: Parameter not found: \S+|Error opening data file [^\n]*?\.traineddata|Please make sure the TESSDATA_PREFIX environment variable is set to your "tessdata" directory\.|Failed loading language '[^'\n]*'|Image too small to scale!! \([^)\n]*\)|Line cannot be recognized!!/gu;
export function serviceErrorMessage(value,status){
 const text=String(value||'').replace(SERVICE_NOISE,' ').replace(/\s+/gu,' ').trim();
 if(!text)return `Không xử lý được PDF (dịch vụ trả mã ${status}).`;
 return text.length>400?`${text.slice(0,399)}…`:text;
}
async function service(env,operation,body,{file,pages}={}){
 const url=serviceUrl(env);if(!url)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');url.pathname=url.pathname.replace(/\/$/u,'')+'/'+operation;
 let response;
 try{response=await fetch(url,{method:operation==='font'?'GET':'POST',headers:{'Content-Type':file?'application/pdf':'application/json',Authorization:`Bearer ${env.PDF_LAYOUT_SERVICE_TOKEN}`,...(file?{'X-PDF-Pages':encodeURIComponent(pages||'')}:{})},...(operation==='font'?{}:{body:file?file.stream():JSON.stringify(body)}),signal:AbortSignal.timeout(280000),...(file?{duplex:'half'}:{})});}
 catch(error){throw new Error(['TimeoutError','AbortError'].includes(error?.name)?'Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt.':'Không kết nối được dịch vụ PDF giữ bố cục. Hãy kiểm tra dịch vụ (npm run dev:pdf-layout) rồi thử lại.');}
 const text=await response.text();let result;
 try{result=JSON.parse(text);}catch{throw new Error(response.ok?'Dịch vụ PDF trả dữ liệu không hợp lệ.':`Dịch vụ PDF tạm thời không phản hồi đúng (mã ${response.status}). Hãy thử lại sau.`);}
 if(!response.ok)throw new Error(serviceErrorMessage(result?.error,response.status));return result;
}
function validAsset(id){if(!/^[a-f\d-]{36}$/iu.test(id||''))throw new Error('Mã PDF không hợp lệ.');return id;}
// A re-extracted selection keeps the stored page numbers; block, sheet and strip IDs follow them.
function renumberPage(page,number){
 const id=value=>value.replace(/^p\d+-/u,`p${number}-`);page.number=number;
 for(const block of page.blocks){block.id=id(block.id);if(typeof block.ocrSheet==='string')block.ocrSheet=id(block.ocrSheet);}
 for(const sheet of page.ocrSheets||[]){sheet.id=id(String(sheet.id));for(const strip of sheet.strips||[])strip.blockId=id(String(strip.blockId));}
}
async function storedDocument(env,reader,id){const object=await env.FILES.get(assetKey(reader,validAsset(id),'manifest.json'));return object?object.json():null;}
export async function pdfLayoutRoute(request,env,path,reader){
 if(!path.startsWith(base))return null;
 if(path===base+'/config'&&request.method==='GET')return reply({configured:Boolean(serviceUrl(env)),maxBytes:25*1024*1024,maxPages:20});
 if(path===base+'/font'&&request.method==='GET')return reply(await service(env,'font'));
 if(!env.FILES?.get||!env.FILES?.put)return reply({error:'Thiếu lưu trữ PDF.'},503);
 const asset=path.match(/^\/api\/my\/study\/pdf-layout\/assets\/([a-f\d-]{36})\/(manifest|original|translated)$/iu);
 if(asset&&request.method==='GET'){
  const [,id,kind]=asset;
  const object=await env.FILES.get(assetKey(reader,id,kind==='manifest'?'manifest.json':`${kind}.pdf`));if(!object)return reply({error:'Không tìm thấy PDF trong tài khoản của bạn.'},404);
  if(kind==='manifest')return reply(await object.json());
  const name=object.customMetadata?.filename||`hoa-tri-${kind}.pdf`;
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':fileDisposition(name,{fallback:`hoa-tri-${kind}.pdf`}),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(path===base+'/extract'&&request.method==='POST'){
  const form=await request.formData(),file=form.get('file');if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('PDF giữ bố cục tối đa 25 MB.');
  if(new TextDecoder().decode(await file.slice(0,5).arrayBuffer())!=='%PDF-')throw new Error('Tệp không phải PDF.');
  // Groups ranges of one uploaded file into a book and names the stored original, so the Worker hashes the bytes itself
  // instead of trusting the browser's value.
  const sha256=await sha256Hex(file);
  const result=await service(env,'extract',null,{file,pages:String(form.get('pages')||'')}),document=validateLayoutDocument(result.document),id=crypto.randomUUID();
  if(!document.pages.some(p=>p.blocks.length))throw new Error('Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.');
  document.sourceSha256=sha256;
  // The whole file is kept once per student and file: the whole-book PDF takes the cover and every untranslated page
  // from it. Failing to keep it never blocks translating; the book download then asks for the file on the device.
  try{await keepSource(env,reader.id,sha256,file,{filename:file.name,pages:document.totalPages});}
  catch{document.warnings=[...(document.warnings||[]),'Chưa lưu được bản PDF gốc đầy đủ; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc.'];}
  await env.FILES.put(assetKey(reader,id,'manifest.json'),JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
  await env.FILES.put(assetKey(reader,id,'original.pdf'),decodeBytes(result.originalPdfBase64),{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:file.name}});
  return reply({assetId:id,document,originalUrl:`${base}/assets/${id}/original`},201);
 }
 if(path===base+'/refresh'&&request.method==='POST'){
  const {assetId,forceClone}=await request.json(),prior=await storedDocument(env,reader,assetId);if(!prior)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  if(prior.extractionVersion>=2&&!forceClone)return reply({assetId,document:prior,originalUrl:`${base}/assets/${assetId}/original`});
  const original=await env.FILES.get(assetKey(reader,assetId,'original.pdf'));if(!original)return reply({error:'Không còn PDF gốc để cập nhật bố cục.'},410);
  const file=new File([await new Response(original.body).arrayBuffer()],'selected-pages.pdf',{type:'application/pdf'}),result=await service(env,'extract',null,{file,pages:`1-${prior.pages.length}`});
  if(result.document.pages.length!==prior.pages.length)throw new Error('Không khớp số trang khi cập nhật bố cục.');
  for(const [i,page] of result.document.pages.entries())renumberPage(page,prior.pages[i].number);result.document.totalPages=prior.totalPages;if(prior.sourceSha256)result.document.sourceSha256=prior.sourceSha256;
  const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
  if(!document.pages.some(p=>p.blocks.length))throw new Error('Không lấy được nội dung tiếng Trung khi cập nhật bố cục.');
  await env.FILES.put(assetKey(reader,id,'manifest.json'),JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
  await env.FILES.put(assetKey(reader,id,'original.pdf'),decodeBytes(result.originalPdfBase64),{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:original.customMetadata?.filename||'nguyen-tac.pdf'}});
  return reply({assetId:id,document,originalUrl:`${base}/assets/${id}/original`},201);
 }
 if(path===base+'/ocr-blocks'&&request.method==='POST'){
  const body=await request.json(),document=await storedDocument(env,reader,body.assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const apiKey=String(body.apiKey||'').trim();if(apiKey.length<20||apiKey.length>500||/[\r\n\0]/u.test(apiKey)||!isStudyModel(body.model))throw new Error('Khóa hoặc model Gemini OCR không hợp lệ.');
  if(!Array.isArray(body.blockIds)||!body.blockIds.length||body.blockIds.length>OCR_LIMITS.sheetBlocks||new Set(body.blockIds).size!==body.blockIds.length)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
  const pages=document.pages.filter(p=>p.ocr),all=pages.flatMap(p=>p.blocks),blocks=body.blockIds.map(id=>all.find(b=>b.id===id));if(blocks.some(b=>!b))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
  // Blocks packed into stored sheets are read a whole sheet at a time: the request names every block of each sheet it
  // touches and nothing else. Older manifests (no sheets) keep one image per block, at most 6 per call.
  const stored=new Map(pages.flatMap(p=>p.ocrSheets||[]).map(s=>[s.id,s])),sheets=[...new Set(blocks.map(b=>b.ocrSheet).filter(Boolean))].map(id=>stored.get(id));
  if(sheets.length?sheets.some(s=>!s)||blocks.some(b=>!b.ocrSheet)||sheets.reduce((n,s)=>n+s.strips.length,0)!==blocks.length||sheets.some(s=>s.strips.some(strip=>!body.blockIds.includes(strip.blockId))):blocks.length>OCR_LIMITS.images)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
  const result=await recognizePdfBlocks({GEMINI_API_KEY:apiKey,GEMINI_MODEL:body.model,GEMINI_THINKING:'minimal',GEMINI_MODEL_RECOVERY:true,GEMINI_PREFERRED_MODEL:env.GEMINI_MODEL||body.model},blocks,sheets);
  for(const value of result.blocks){const block=all.find(b=>b.id===value.id);block.source=value.text;let text=value.text;for(const inline of block.inlines||[])text=text.replace(inline.token,inline.text);block.text=text;block.ocrCorrected=true;if(/^\d+(?:\.\d+){1,4}\s*[\u3400-\u9fff]/u.test(text)&&text.length<100){block.kind='heading';block.bold=true;}}
  document.ocrCorrectedVersion=all.every(b=>b.ocrCorrected)?1:0;document.ocrWarnings=[...(document.ocrWarnings||[]),...result.warnings];await env.FILES.put(assetKey(reader,body.assetId,'manifest.json'),JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
  return reply({document,usage:result.usage,warnings:result.warnings,model:result.model});
 }
 if(path===base+'/render'&&request.method==='POST'){
  const {assetId,historyId}=await request.json(),document=await storedDocument(env,reader,assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const row=await env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(String(historyId||''),reader.id).first();if(!row)return reply({error:'Không tìm thấy lịch sử trong tài khoản.'},404);
  const savedState=await env.FILES.get(row.state_key);if(!savedState)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  const state=await savedState.json();if(state.pdfLayout?.assetId!==assetId||!state.complete||!row.library_chapter_id)return reply({error:'Hãy dịch và lưu đủ các block trước khi xuất PDF.'},409);
  const blocks=document.pages.flatMap(p=>p.blocks),translations=blocks.map((b,i)=>({id:b.id,translation:state.translationParts[i]}));validateBlockTranslations(blocks,translations);
  const title=String(row.title||'Bản dịch Hoa Trí'),result=await service(env,'render',{document,translations,title}),pdf=decodeBytes(result.pdfBase64);if(new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw new Error('Engine không trả PDF hợp lệ.');
  const key=assetKey(reader,assetId,'translated.pdf');await env.FILES.put(key,pdf,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:`${title}.vi.pdf`,renderVersion:String(RENDER_VERSION)}});
  // Only this range's chapter: other ranges of the same book keep their own PDFs.
  await env.DB.prepare('UPDATE chapters SET file_key=?,mime=? WHERE id=? AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?)').bind(key,'application/pdf',row.library_chapter_id,reader.id).run();
  state.pdfLayout.exported=true;state.pdfLayout.renderVersion=RENDER_VERSION;await env.FILES.put(row.state_key,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
  return reply({url:`${base}/assets/${assetId}/translated`,report:result.report,renderVersion:RENDER_VERSION});
 }
 return reply({error:'Không tìm thấy thao tác PDF.'},404);
}
