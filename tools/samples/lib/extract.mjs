// init and extract: the owner's PDF -> work/<part>/ folders a translator can work from, by the PDF service's own engine
// (extract.py through engine.pythonOperation, as the extract route calls it), on this machine and without Gemini.
import {readFile,rename,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateLayoutDocument} from '../../../frontend/pdf-box-layout.js';
import {tessdataIsClean} from '../../../services/pdf-layout/prepare-ocr.mjs';
import {sampleDir,workDir,assertIgnored,assertInsideSamples,sampleFile} from './paths.mjs';
import {readJson,writeJson,writeCompactJson,writeRawJson,writeSampleFile,removeSamplePath,sha256,dataUrlBytes,isPdf} from './util.mjs';
import {sampleTemplate} from './config.mjs';
import {planChunks,pageArgument,pageLabel,chapterTitle,chunkId} from './plan.mjs';
import {chooseCover} from './cover.mjs';
import {pdfTool,prepareEngineEnv} from './machine.mjs';
import {buildListing,buildTemplate,sheetImage,inlineImage,tokenNumber} from './listing.mjs';
import {rulesMarkdown} from './rules.mjs';
import {loadSample,statePath,chunkFiles,codeVersions} from './state.mjs';

const MAX_BYTES=25*1024*1024;
const stamp=()=>new Date().toISOString().replace(/[-:]/gu,'').replace(/\.\d+Z$/u,'');
// Same as renumberPage in backend/pdf-layout.js (the refresh route): a page extracted from a cut-down PDF takes back its
// page number in the book, and block, sheet and strip IDs follow it.
export function renumberPage(page,number){
 const id=value=>value.replace(/^p\d+-/u,`p${number}-`);page.number=number;
 for(const block of page.blocks){block.id=id(block.id);if(typeof block.ocrSheet==='string')block.ocrSheet=id(block.ocrSheet);}
 for(const sheet of page.ocrSheets||[]){sheet.id=id(String(sheet.id));for(const strip of sheet.strips||[])strip.blockId=id(String(strip.blockId));}
}
// The extractor's note that it stopped early names pages to do "next time"; the tool queues them itself.
const BUDGET_NOTE=/^Lượt này xử lý /u;
// Sources the extractor takes whole (25 MB at most) go as they are, with the page list, like the extract route. Larger
// ones are first cut to the selected pages and extracted as pages 1-N of that PDF, like the refresh route.
export async function extractPages({source,whole,pages,totalPages,pythonOperation,scratch,cut=!whole}){
 if(!cut){const result=await pythonOperation({pdfBase64:whole,pages:pageArgument(pages)});result.document.warnings=(result.document.warnings||[]).filter(w=>!BUDGET_NOTE.test(w));return result;}
 const file=assertInsideSamples(resolve(scratch,'.selected-pages.pdf'));await mkdir(scratch,{recursive:true});
 try{
  await pdfTool(['subset',source,JSON.stringify(pages),file]);
  const result=await pythonOperation({pdfBase64:(await readFile(file)).toString('base64'),pages:`1-${pages.length}`}),document=result.document;
  for(const [index,page] of document.pages.entries())renumberPage(page,pages[index]);
  document.totalPages=totalPages;
  document.warnings=(document.warnings||[]).filter(w=>!BUDGET_NOTE.test(w)).map(w=>w.replace(/Trang (\d+)/gu,(text,n)=>pages[Number(n)-1]?`Trang ${pages[Number(n)-1]}`:text));
  return result;
 }finally{await removeSamplePath(file);}
}

export async function initSample(slug,{pdf,title='',force=false,log=console.log}={}){
 const dir=sampleDir(slug),config=resolve(dir,'sample.json'),target=resolve(dir,'source.pdf');
 assertIgnored([config,target,resolve(dir,'work','state.json')]);
 if(!pdf)throw new Error('Cần --pdf <đường dẫn tệp PDF gốc>.');
 const bytes=await readFile(resolve(pdf)).catch(error=>{throw new Error(error.code==='ENOENT'?`Không tìm thấy tệp ${pdf}.`:`Không đọc được ${pdf}: ${error.message}`);});
 if(!isPdf(bytes))throw new Error(`${pdf} không phải tệp PDF.`);
 if(existsSync(config)&&!force)throw new Error(`Đã có samples/${slug}/sample.json. Thêm --force để tạo lại (bản cũ được giữ thành sample.old.json).`);
 await mkdir(dir,{recursive:true});
 if(existsSync(config))await rename(config,resolve(dir,'sample.old.json'));
 if(resolve(pdf).toLowerCase()!==target.toLowerCase())await writeSampleFile(target,bytes);
 const info=await pdfTool(['info',target]);
 await writeJson(config,sampleTemplate(slug,{title}));
 log(`Đã tạo samples/${slug}/ (source.pdf: ${info.pages} trang, ${(bytes.length/1048576).toFixed(1)} MB).`);
 log(`Tiếp theo: mở samples/${slug}/sample.json, điền "title", "author", "genre", "ranges" (vd. ["5-9"]), "rights"; rồi chạy: npm run samples -- extract ${slug}`);
 return {dir,pages:info.pages};
}

async function writeChunk(slug,id,document,selectedBase64,{file}){
 const files=chunkFiles(slug,id),dir=files.dir,folder=name=>assertInsideSamples(resolve(dir,name));
 await writeRawJson(files.manifest,document);
 await writeSampleFile(files.selected,Buffer.from(selectedBase64,'base64'));
 for(const page of document.pages){
  for(const sheet of page.ocrSheets||[])await writeSampleFile(resolve(dir,sheetImage(sheet.id)),dataUrlBytes(sheet.image));
  for(const block of page.blocks)for(const inline of block.inlines||[])await writeSampleFile(resolve(dir,inlineImage(block.id,inline.token)),dataUrlBytes(inline.image));
 }
 await mkdir(folder('pages'),{recursive:true});
 await pdfTool(['pages'],{input:JSON.stringify({pdf:files.selected,outDir:folder('pages'),scale:2,pages:document.pages.map((page,index)=>({index,number:page.number,blocks:page.blocks.map(b=>({id:b.id,box:b.box,inlines:(b.inlines||[]).map(i=>({n:tokenNumber(i.token),box:i.box}))}))}))})});
 const scanned=document.pages.flatMap((page,index)=>page.ocr?page.blocks.map(b=>({index,id:b.id,box:b.box,inlines:(b.inlines||[]).map(i=>({token:i.token,box:i.box}))})):[]);
 if(scanned.length){await mkdir(folder('crops'),{recursive:true});await pdfTool(['crops'],{input:JSON.stringify({pdf:files.selected,outDir:folder('crops'),scale:3,blocks:scanned})});}
 await writeCompactJson(files.blocks,buildListing(document,{slug,chunk:id,file}));
 await writeCompactJson(files.template,buildTemplate(document,{slug,chunk:id}));
 return sha256(await readFile(files.manifest));
}

export async function extractSample(slug,{force=false,log=console.log}={}){
 const {dir,config}=await loadSample(slug,{need:['ranges']}),source=sampleFile(slug,config.source),work=workDir(slug);
 assertIgnored([source]);
 const bytes=await readFile(source).catch(error=>{if(error.code==='ENOENT')throw new Error(`Chưa có samples/${slug}/${config.source} (chạy init với --pdf, hoặc sửa "source").`);throw error;});
 if(!isPdf(bytes))throw new Error(`${config.source} không phải tệp PDF.`);
 if(existsSync(statePath(slug))&&!force)throw new Error(`"${slug}" đã được tách trang. Thêm --force để tách lại (thư mục work cũ được giữ thành work.old-…, texts.json của phần cùng trang được chép sang).`);
 prepareEngineEnv();
 if(!process.env.TESSDATA_PREFIX&&!await tessdataIsClean())throw new Error('Chưa có dữ liệu OCR chi_sim + eng cho trang scan: chạy "npm run prepare:pdf-ocr" rồi chạy lại.');
 const info=await pdfTool(['info',source]),cover=await chooseCover(source,info,config.cover);
 const {chunks:planned,coverExcluded}=planChunks(config.ranges,info.pages,{cover:cover.page,translateCover:config.translateCover});
 log(cover.page?`Bìa: trang ${cover.page} (${cover.reasons.join(', ')}).`:`Không dùng ảnh bìa: ${cover.reasons.join(', ')}.`);
 if(coverExcluded)log(`Trang bìa ${cover.page} giữ nguyên ảnh gốc, không dịch (đặt "translateCover": true để dịch).`);
 const {pythonOperation}=await import('../../../services/pdf-layout/engine.mjs');
 const old=existsSync(work)?resolve(dir,`work.old-${stamp()}`):null;if(old)await rename(work,old);
 const whole=bytes.length<=MAX_BYTES?bytes.toString('base64'):null,sourceSha256=sha256(bytes),queue=planned.map(c=>c.pages),chunks=[],skipped=[],notes=[];let coverFile=null;
 if(!whole)log(`${config.source} lớn hơn 25 MB: mỗi phần được cắt riêng các trang đã chọn trước khi tách.`);
 try{
  while(queue.length){
   const pages=queue.shift(),id=chunkId(chunks.length);
   log(`Đang tách trang ${pageLabel(pages)}…`);
   const result=await extractPages({source,whole,pages,totalPages:info.pages,pythonOperation,scratch:work}),document=validateLayoutDocument(result.document);
   // As the extract route does: the stored manifest names the whole file it came from.
   document.sourceSha256=sourceSha256;
   const done=document.pages.map(p=>p.number),rest=pages.filter(page=>page>done.at(-1));
   // Pages left out by the extractor's size budget become the next part instead of being lost.
   if(rest.length){queue.unshift(rest);notes.push(`Trang ${pageLabel(rest)} được tách thành phần riêng vì vượt dung lượng một lượt.`);}
   if(!document.pages.some(p=>p.blocks.length)){skipped.push(done);log(`  Bỏ qua trang ${pageLabel(done)}: không có đoạn chữ Trung cần dịch.`);continue;}
   const manifestSha256=await writeChunk(slug,id,document,result.originalPdfBase64,{file:config.source}),blocks=document.pages.flatMap(p=>p.blocks);
   chunks.push({id,pages:done,title:chapterTitle(done),blocks:blocks.length,ocrBlocks:document.pages.filter(p=>p.ocr).reduce((n,p)=>n+p.blocks.length,0),manifestSha256});
   log(`  ${id}: ${blocks.length} đoạn${chunks.at(-1).ocrBlocks?` (${chunks.at(-1).ocrBlocks} đoạn trang scan)`:''}.`);
   for(const warning of document.warnings||[])log(`  · ${warning}`);
  }
  if(!chunks.length)throw new Error('Không tìm thấy đoạn chữ Trung nào để dịch trong các trang đã chọn.');
  if(cover.page){coverFile=resolve(work,'cover.jpg');assertInsideSamples(coverFile);await mkdir(work,{recursive:true});const made=await pdfTool(['jpeg',source,cover.page,600,85,coverFile]);if(made.bytes>5*1024*1024)throw new Error('Ảnh bìa vượt 5 MB.');}
 }catch(error){
  // A failed extraction leaves the previous work folder as it was.
  await removeSamplePath(work);if(old)await rename(old,work);
  throw error;
 }
 // A re-extraction keeps the work already done: texts.json of a part with the same pages is copied over.
 const carried=[];
 if(old){
  const prior=await readJson(resolve(old,'state.json'))||{chunks:[]};
  for(const chunk of chunks){
   const match=prior.chunks?.find(c=>JSON.stringify(c.pages)===JSON.stringify(chunk.pages)),from=match&&resolve(old,match.id,'texts.json');
   if(!from||!existsSync(from))continue;
   const texts=await readJson(from);if(texts&&typeof texts==='object')texts.chunk=chunk.id;
   await writeJson(chunkFiles(slug,chunk.id).texts,texts);carried.push(`${match.id} → ${chunk.id}`);
  }
 }
 const text=(await Promise.all(chunks.map(async c=>JSON.parse(await readFile(chunkFiles(slug,c.id).manifest,'utf8')).pages.flatMap(p=>p.blocks.map(b=>b.source)).join('\n')))).join('\n');
 await writeSampleFile(resolve(work,'RULES.md'),rulesMarkdown(config,chunks,{text}));
 const state={version:1,slug,source:{file:config.source,sha256:sourceSha256,bytes:bytes.length,totalPages:info.pages},cover:{page:cover.page,reasons:cover.reasons,file:coverFile?'cover.jpg':null},coverExcluded,chunks,skipped,notes,code:await codeVersions(),extractedAt:new Date().toISOString(),...(old?{previous:old.split(/[\\/]/u).at(-1)}:{})};
 await writeJson(statePath(slug),state);
 if(old)log(`Thư mục work cũ được giữ ở samples/${slug}/${state.previous}${carried.length?`; đã chép texts.json: ${carried.join(', ')}`:''}.`);
 for(const note of notes)log(note);
 log(`Xong: ${chunks.length} phần. Người dịch đọc samples/${slug}/work/RULES.md rồi ghi work/<phần>/texts.json.`);
 return state;
}
