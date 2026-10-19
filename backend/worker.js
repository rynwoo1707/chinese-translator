import {extractEpub} from './epub.js';
import {extractAzw3} from './azw3.js';
import {storeJobText,fullText,decodeText} from './text-storage.js';
import {adminContent} from './admin-content.js';
import {preparePdf,getPdfManifest,assembleBook} from './pdf-pipeline.js';
import {savePreparedPdfPage} from './pdf-page-upload.js';
import {studyRoute,studyModelConfig,localTranslationReview} from './study-translation.js';
import mammoth from 'mammoth/mammoth.browser.js';
import {PROMPT_VERSION,recognizeDocument,translateAndVerify,chunks,withThinking,USAGE_KEYS} from './ai.js';
import {cleanExtractedPdfText,cleanReaderText} from './pdf-cleaning.js';
import {authRoute,currentReader} from './reader-auth.js';
import {nextBookTranslationPart,splitBookTranslation} from './book-sections.js';
import {saveGeminiApiKey,clearGeminiApiKey,geminiKeyStatus,withRuntimeGeminiKey} from './runtime-config.js';
import {listStudyModels} from './gemini-models.js';
import {fileDisposition} from './download-filename.js';
import {readerTerms} from './reader-glossary.js';
import {saveCover} from './covers.js';
import {json,withSecurityHeaders,limitBody,crossOrigin,originRefused,errorResponse,isLoopback} from './http.js';
import {healthRoute} from './health.js';
import {accountRoute,adminAccountRoute} from './account.js';
import {rateLimit,dailyMax} from './rate-limit.js';
import {SAMPLE_PREFIX,validSlug,isSampleBook,libraryRows,readChapters,libraryPublicRoute,libraryAdminRoute,bookPagesReady,rangedPdfResponse} from './library-books.js';
import {removeFile} from './study-history.js';
const id=()=>crypto.randomUUID();
const TRANSLATION_CHUNK_SIZE=10000;
const GENRES=['Chuyên khảo · Nghiên cứu','Toán học · STEM','Lịch sử Trung Hoa','Cổ văn · Hán Nôm','Triết học · Tư tưởng','Văn hóa · Xã hội','Địa lý · Khảo cổ','Giáo dục','Ngôn ngữ học','Tài liệu khác'];
function required(value,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Nội dung trống hoặc vượt giới hạn cho phép.');return value.trim();}
// Empty means the column default, "Chưa cập nhật".
function cleanAuthor(value){const author=String(value??'').normalize('NFC').trim();if(author.length>200||/[\u0000-\u001f\u007f]/u.test(author))throw new Error('Tên tác giả tối đa 200 ký tự, trên một dòng.');return author;}
const UNKNOWN_AUTHOR='Chưa cập nhật';
// Students' own study books: their visibility and author belong to the student's workspace, never to the admin.
const NOT_STUDY_BOOK="COALESCE(source_url,'') NOT LIKE 'study:%' AND COALESCE(source_url,'') NOT LIKE 'study-book:%'";
// A short ADMIN_TOKEN can be guessed, so it opens nothing outside this machine; setup generates 64 hex characters.
const MIN_ADMIN_TOKEN=32;
const adminTokenUsable=(env,url)=>String(env.ADMIN_TOKEN||'').length>=MIN_ADMIN_TOKEN||Boolean(env.ADMIN_TOKEN)&&isLoopback(url.hostname);
async function isAdmin(request,env,url){const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';if(!adminTokenUsable(env,url)||!token)return false;const enc=new TextEncoder();const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(token))),b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(env.ADMIN_TOKEN)));let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;}
async function canReadStory(request,env,storyId,admin=false){const story=await env.DB.prepare('SELECT id,visibility,owner_user_id,source_url FROM stories WHERE id=?').bind(storyId).first();if(!story)return null;if(story.visibility!=='private'||admin)return story;const reader=await currentReader(request,env);return reader&&reader.id===story.owner_user_id?story:null;}
function validRequestFile(file){const ext=String(file?.name||'').split('.').pop().toLowerCase();const types={pdf:'application/pdf',epub:'application/epub+zip',azw3:'application/vnd.amazon.ebook',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};return {ext,mime:types[ext]};}
export async function sha256Hex(data){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function prepareJobRows(env,sid,{source,parts,filename,mime,fileKey,firstId,warnings=[],progress='',sha256=null}){
 const units=parts?.length?parts.map((part,index)=>({source:part.content,filename:`${String(index+1).padStart(2,'0')} · ${part.title}`,progress:`Phần ${index+1}/${parts.length} · sẵn sàng dịch`})):[{source,filename,progress}];
 const rows=[],storedKeys=[];
 for(const [index,unit] of units.entries()){const jid=index===0&&firstId?firstId:id(),stored=await storeJobText(env,jid,unit.source,'');if(stored.sourceKey)storedKeys.push(stored.sourceKey);rows.push({id:jid,statement:env.DB.prepare('INSERT INTO jobs(id,story_id,filename,file_key,mime,source,source_key,warnings,progress,source_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(jid,sid,unit.filename,index===0?fileKey:null,mime,stored.source,stored.sourceKey,JSON.stringify(index===0?warnings:[]),unit.progress,index===0?sha256:null)});}
 return {rows,storedKeys};
}
export async function acceptReaderRequest(requestId,env){
 const item=await env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(requestId).first();if(!item)throw new Error('Không tìm thấy yêu cầu của người học.');
 if(item.story_id){const existingJob=await env.DB.prepare('SELECT id FROM jobs WHERE story_id=? ORDER BY created_at DESC LIMIT 1').bind(item.story_id).first();return {story_id:item.story_id,job_id:existingJob?.id||null,alreadyAccepted:true};}
 const sid=id(),visibility=item.visibility==='public'?'public':'private';let uploadKey=null,source='',parts=null,warnings=[],progress='',prepared={rows:[],storedKeys:[]};
 try{
  if(item.file_key){const firstId=id(),file=await env.FILES.get(item.file_key);if(!file)throw new Error('Tệp người dùng đã tải lên không còn tồn tại.');const data=await file.arrayBuffer();if(data.byteLength>25*1024*1024)throw new Error('Tệp yêu cầu vượt quá 25 MB.');const ext=String(item.filename||'').split('.').pop().toLowerCase();
   if(ext==='txt')source=decodeText(data);
   else if(ext==='docx')source=(await mammoth.extractRawText({arrayBuffer:data})).value;
   else if(ext==='epub'){const book=extractEpub(data);source=book.source;parts=book.parts;warnings=book.warnings;progress=`Đã đọc EPUB · ${book.chapterCount} phần theo thứ tự sách`;}
   else if(ext==='azw3'){const book=await extractAzw3(data);source=book.source;parts=book.parts;warnings=book.warnings;progress=`Đã đọc AZW3/KF8 · ${book.chapterCount} phần theo thứ tự sách`;}
   if(['txt','docx','epub','azw3'].includes(ext)&&!source.trim())throw new Error('Tệp yêu cầu không có văn bản để dịch.');if(new TextEncoder().encode(source).length>25*1024*1024)throw new Error('Văn bản trích xuất vượt quá 25 MB.');
   uploadKey=`uploads/${firstId}`;await env.FILES.put(uploadKey,data,{httpMetadata:{contentType:item.mime||'application/octet-stream'}});prepared=await prepareJobRows(env,sid,{source,parts,filename:item.filename,mime:item.mime,fileKey:uploadKey,firstId,warnings,progress,sha256:await sha256Hex(data)});
  }
  const statements=[env.DB.prepare('INSERT INTO stories(id,title,genre,source_url,owner_user_id,visibility) VALUES(?,?,?,?,?,?)').bind(sid,item.title,'Chuyên khảo · Nghiên cứu',item.source_url||null,item.user_id||null,visibility)];
  statements.push(...prepared.rows.map(row=>row.statement),env.DB.prepare("UPDATE requests SET status='accepted',story_id=? WHERE id=? AND story_id IS NULL").bind(sid,requestId));await env.DB.batch(statements);return {story_id:sid,job_id:prepared.rows[0]?.id||null,job_ids:prepared.rows.map(row=>row.id),has_file:!!item.file_key};
 }catch(error){if(uploadKey)await env.FILES.delete(uploadKey);for(const key of prepared.storedKeys)await env.FILES.delete(key);throw error;}
}
export async function processJob(jobId,env){
 const job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first();
 const checkpointKey=`processing/${jobId}.json`;
 // Optional stronger model used only to repair a verified missing marker, never for routine translation.
 const qualityModel=env.GEMINI_QUALITY_MODEL&&env.GEMINI_QUALITY_MODEL!==(env.GEMINI_MODEL||'gemini-2.5-flash')?env.GEMINI_QUALITY_MODEL:null;
 const qualityEnv=qualityModel?new Proxy(env,{get(target,property){return property==='GEMINI_MODEL'?qualityModel:Reflect.get(target,property);}}):undefined;
 // Routine translation gets no reasoning budget, like the study workspace; OCR keeps a small bounded budget to
 // recheck pages. GEMINI_THINKING=default restores the model's unbounded thinking for both.
 const translateEnv=withThinking(env,env.GEMINI_THINKING||'minimal'),ocrEnv=withThinking(env,env.GEMINI_THINKING||'low');
 try{
  const story=await env.DB.prepare('SELECT * FROM stories WHERE id=?').bind(job.story_id).first();
  const saved=await env.FILES.get(checkpointKey);
  const cp=saved?await saved.json():{page:0,source:await fullText(env,job.source_key,job.source),ocrDone:!!(job.source_key||job.source),warnings:JSON.parse(job.warnings||'[]'),translations:[],part:0,translatedChars:0,usage:{prompt:0,output:0,total:0,requests:0,cacheHits:0}};
  // Upgrade existing checkpoints without losing OCR or completed translations.
  if(cp.translatedChars===undefined)cp.translatedChars=chunks(cp.source,3000).slice(0,cp.part).join('').length;
  const previouslyComplete=cp.ocrDone&&cp.translatedChars===cp.source.length;
  let stage='translating';
  if(cp.ocrDone&&cp.translatedChars<cp.source.length){
   // Larger semantic chunks reduce repeated prompt/context tokens and usually improve continuity.
   const selection=nextBookTranslationPart(cp.source,cp.translatedChars,TRANSLATION_CHUNK_SIZE),part=selection.text;
   if(!part.trim())throw new Error('Phần sách không có nội dung để dịch.');
   // Same missing-marker verification/repair safeguard used by the student study workspace, so published
   // books get the identical accuracy check instead of a weaker, divergent pipeline. A configured
   // GEMINI_QUALITY_MODEL only gets used for the rare repair/retry pass, never for routine translation.
   const result=await translateAndVerify(translateEnv,part,{...story,previousSource:cp.source.slice(Math.max(0,cp.translatedChars-1500),cp.translatedChars),previousTranslation:cp.translations.slice(-2).join('\n\n').slice(-2000),context:cp.context||story.context,glossary:JSON.stringify(cp.glossary||JSON.parse(story.glossary))},{repairEnv:qualityEnv,retryEnv:qualityEnv});
   cp.translations.push((selection.marker?selection.marker+'\n':'')+result.translation);cp.part++;cp.translatedChars+=selection.consumed;cp.context=result.context;cp.glossary=result.glossary;cp.usage??={prompt:0,output:0,total:0,requests:0,cacheHits:0};for(const key of USAGE_KEYS)cp.usage[key]=(cp.usage[key]||0)+(result.usage?.[key]||0);
   // Books published for the whole school get the same omission / untranslated-Han checks as student translations.
   const partWarnings=[...result.warnings,...localTranslationReview(part,result.translation).warnings];
   if(partWarnings.length)cp.warnings.push(...partWarnings.map(w=>`Phần dịch ${cp.part}: ${w}`));
  }else if(!cp.ocrDone){
   stage='ocr';const file=job.mime==='application/pdf'?null:await env.FILES.get(job.file_key);if(job.mime!=='application/pdf'&&!file)throw new Error('Không tìm thấy tài liệu gốc.');
   let input=file,mime=job.mime,total=1,count=1,preparedPart=null;
   if(mime==='application/pdf'){
    const manifest=await getPdfManifest(jobId,env);
    if(!manifest?.complete)throw new Error('Cần chia xong PDF trước khi dịch.');
    const part=manifest.parts.find(part=>part.startPage===cp.page+1);
    if(!part)throw new Error('Không tìm thấy phần PDF tiếp theo.');
    input=await env.FILES.get(part.key);if(!input)throw new Error('Thiếu phần PDF đã chia.');preparedPart=part;mime=part.mime||'application/pdf';
    total=manifest.totalPages;count=part.endPage-part.startPage+1;
   }
   const ocr=preparedPart?.kind==='text'?{text:await input.text(),warnings:[]}:await recognizeDocument(ocrEnv,input,mime);
   if(typeof ocr.text!=='string'||!ocr.text.trim()||!Array.isArray(ocr.warnings))throw new Error('Kết quả OCR không hợp lệ.');
   const start=cp.page+1,end=cp.page+count;
   cp.source+=(cp.source?'\n\n':'')+`[Trang PDF ${start}–${end}]\n`+ocr.text;
   cp.warnings.push(...ocr.warnings.map(w=>`Trang PDF ${start}–${end}: ${w}`));cp.page+=count;cp.totalPages=total;cp.ocrDone=cp.page>=total;if(cp.ocrDone&&job.mime==='application/pdf')cp.source=cleanExtractedPdfText(cp.source);
  }
  // Commit the checkpoint before updating the display; a retry can recover after a database error.
  await env.FILES.put(checkpointKey,JSON.stringify(cp));
  const done=cp.ocrDone&&cp.translatedChars>=cp.source.length;
  const assembled=done&&previouslyComplete;
  const book=assembled?assembleBook(cp):cleanReaderText(cp.translations.join('\n\n'));
  if(assembled)await env.FILES.put(`books/${jobId}.txt`,book,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
  const tokenProgress=cp.usage?.total?` · ${new Intl.NumberFormat('vi-VN').format(cp.usage.total)} token Gemini${cp.usage.thinking?` (${new Intl.NumberFormat('vi-VN').format(cp.usage.thinking)} suy luận)`:''}`:cp.usage?.cacheHits?` · ${cp.usage.cacheHits} lượt dùng cache`:'';
  const progress=`${cp.totalPages?`Đã đọc ${cp.page}/${cp.totalPages} trang · `:cp.page?`Đã đọc ${cp.page} trang · `:''}Đã dịch ${cp.part} phần${cp.ocrDone?` · ${Math.floor(cp.translatedChars/Math.max(cp.source.length,1)*100)}% văn bản`:''}${tokenProgress}${assembled?' · Đã ghép đủ tài liệu':done?' · Đang ghép tài liệu':''}`;
  const stored=await storeJobText(env,jobId,cp.source,book);
  const nextStatus=assembled?'review':done?'assembling':stage;
  await env.DB.prepare("UPDATE jobs SET source=?,translation=?,source_key=?,translation_key=?,warnings=?,status=?,progress=?,error=NULL,prompt_tokens=?,output_tokens=?,total_tokens=?,ai_requests=?,ai_cache_hits=?,model=?,prompt_version=?,translated_at=CASE WHEN ?='review' THEN COALESCE(translated_at,CURRENT_TIMESTAMP) ELSE translated_at END WHERE id=?").bind(stored.source,stored.translation,stored.sourceKey,stored.translationKey,JSON.stringify(cp.warnings),nextStatus,progress,cp.usage?.prompt||0,cp.usage?.output||0,cp.usage?.total||0,cp.usage?.requests||0,cp.usage?.cacheHits||0,env.GEMINI_MODEL||'gemini-2.5-flash',PROMPT_VERSION,nextStatus,jobId).run();
  if(assembled&&cp.context)await env.DB.prepare('UPDATE stories SET context=?,glossary=? WHERE id=?').bind(cp.context,JSON.stringify(cp.glossary),story.id).run();
 }catch(e){const message=['TimeoutError','AbortError'].includes(e.name)?'Gemini phản hồi quá lâu. Tiến độ đã được lưu; bấm Tiếp tục dịch để thử lại phần hiện tại.':e.message;await env.DB.prepare("UPDATE jobs SET status='failed',error=? WHERE id=?").bind(message,jobId).run();}
 finally{await env.DB.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').bind(jobId).run();}
}
// Every API answer passes here: health first (no login, no body), then the origin and size checks that hold for all
// routes, then the routes. Whatever a route throws becomes a JSON error; internal ones are logged with the request's ray.
export default {async fetch(request,env,ctx){
 const url=new URL(request.url),path=url.pathname;
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 let body;
 try{
  const health=await healthRoute(request,env,path);if(health)return withSecurityHeaders(health);
  if(crossOrigin(request,url))return withSecurityHeaders(originRefused());
  body=limitBody(request,path);if(body instanceof Response)return withSecurityHeaders(body);
  return withSecurityHeaders(await route(body.request,env,ctx,url,path));
 }catch(error){return withSecurityHeaders(errorResponse(error,{request,url,path,body}));}
}};
async function route(request,env,ctx,url,path){
  const method=request.method,admin=await isAdmin(request,env,url);
  const authResponse=await authRoute(request,env,url,path);if(authResponse)return authResponse;
  const accountResponse=await accountRoute(request,env,url,path);if(accountResponse)return accountResponse;
  const studyResponse=await studyRoute(request,env,url,path);if(studyResponse)return studyResponse;
  if(path==='/api/status'){
   if(!admin)return json({authenticated:false,...(env.ADMIN_TOKEN&&!adminTokenUsable(env,url)?{adminTokenTooShort:true}:{})});
   const keyStatus=await geminiKeyStatus(env);
   // samples: this server keeps sample books (tools/samples asks); pages: migration 0015 is applied, so parts can carry
   // the original pages they translate. sampleFeatures: an excerpt original keeps the book's page numbers
   // (X-Book-Pages), and a book's cover can be removed (DELETE /api/stories/:id/cover).
   return json({aiConfigured:keyStatus.configured,apiKeySource:keyStatus.source,apiKeyUpdatedAt:keyStatus.updatedAt,adminConfigured:!!env.ADMIN_TOKEN,authenticated:true,model:env.GEMINI_MODEL||'gemini-2.5-flash',pdfModel:studyModelConfig(env).pdf,runtimeVersion:studyModelConfig(env).runtimeVersion,samples:{pages:await bookPagesReady(env)},sampleFeatures:{bookPages:true,clearCover:true}});
  }
  if(path==='/api/library'&&method==='GET')return json(await libraryRows(env,GENRES));
  if(path==='/api/my/requests'&&method==='GET'){const reader=await currentReader(request,env);if(!reader)return json({error:'Hãy đăng nhập Google để xem yêu cầu của bạn.'},401);return json((await env.DB.prepare('SELECT id,title,source_url,notes,status,visibility,filename,story_id,created_at FROM requests WHERE user_id=? ORDER BY created_at DESC').bind(reader.id).all()).results);}
  if(path==='/api/my/library'&&method==='GET'){const reader=await currentReader(request,env);if(!reader)return json({error:'Hãy đăng nhập để xem thư viện cá nhân.'},401);return json((await env.DB.prepare('SELECT s.id,s.title,s.author,s.genre,s.cover_key,s.source_url,s.visibility,COUNT(c.id) AS chapters,(SELECT status FROM jobs j WHERE j.story_id=s.id ORDER BY j.created_at DESC LIMIT 1) AS translation_status FROM stories s LEFT JOIN chapters c ON c.story_id=s.id WHERE s.owner_user_id=? GROUP BY s.id ORDER BY s.created_at DESC').bind(reader.id).all()).results);}
  const glossaryMatch=path.match(/^\/api\/glossary\/([^/]+)$/);
  if(glossaryMatch&&method==='GET'){
   if(!await canReadStory(request,env,glossaryMatch[1],admin))return json({error:'Không tìm thấy tài liệu hoặc bạn không có quyền đọc.'},404);
   return json({terms:readerTerms(await env.DB.prepare('SELECT genre,glossary FROM stories WHERE id=?').bind(glossaryMatch[1]).first())});
  }
  // Each part also says whether the book is a sample and which pages of its original it translates.
  if(path.startsWith('/api/read/')&&method==='GET'){const sid=path.split('/').pop(),story=await canReadStory(request,env,sid,admin);if(!story)return json({error:'Không tìm thấy tài liệu hoặc bạn không có quyền đọc.'},404);const chapters=await readChapters(env,sid),sample=isSampleBook(story)?1:0;for(const chapter of chapters){chapter.content=cleanReaderText(await fullText(env,chapter.text_key,chapter.content));delete chapter.text_key;chapter.sample=sample;}return json(chapters);}
  const publicFile=path.match(/^\/api\/chapter-file\/([^/]+)$/);
  if(publicFile&&method==='GET'){
   const chapter=await env.DB.prepare('SELECT c.file_key,c.story_id,c.title FROM chapters c WHERE c.id=?').bind(publicFile[1]).first();
   if(!chapter||!await canReadStory(request,env,chapter.story_id,admin))return json({error:'Không tìm thấy tài liệu hoặc bạn không có quyền đọc.'},404);
   if(!chapter.file_key)return json({error:'Không tìm thấy tài liệu đã đăng.'},404);
   // By byte ranges, like the originals: "Đọc song ngữ" fetches only the pages it shows of a long part too.
   return rangedPdfResponse(request,env,chapter.file_key,'Không tìm thấy tài liệu đã đăng.',{disposition:fileDisposition(`${chapter.title||'Bản dịch Hoa Trí'}.vi.pdf`)});
  }
  const coverMatch=path.match(/^\/api\/covers\/([^/]+)$/);
  if(coverMatch&&method==='GET'){
   const story=await canReadStory(request,env,coverMatch[1],admin);if(!story)return json({error:'Không tìm thấy ảnh bìa hoặc bạn không có quyền xem.'},404);
   const coverInfo=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=?').bind(coverMatch[1]).first();
   const cover=coverInfo?.cover_key?await env.FILES.get(coverInfo.cover_key):null;
   if(!cover)return json({error:'Chưa có ảnh bìa.'},404);
   return new Response(cover.body,{headers:{'Content-Type':cover.httpMetadata.contentType,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
  }
  const libraryResponse=await libraryPublicRoute(request,env,path,admin);if(libraryResponse)return libraryResponse;
  if(path==='/api/requests'&&method==='POST'){
   const reader=await currentReader(request,env);if(!reader)return json({error:'Hãy đăng nhập trước khi gửi yêu cầu dịch tài liệu.'},401);
   const fast=await rateLimit(env,[{binding:'HEAVY_LIMITER',key:`upload:${reader.id}`}]);if(fast)return fast;
   const form=await request.formData(),title=required(form.get('title')),notes=String(form.get('notes')||'').slice(0,2000),source=String(form.get('source_url')||'').trim().slice(0,1000),visibility=form.get('visibility')==='public'?'public':'private',file=form.get('file');
   if(source&&!/^https?:\/\//i.test(source))return json({error:'Liên kết phải bắt đầu bằng http:// hoặc https://'},400);
   const hasFile=file&&typeof file!=='string'&&file.size>0;if(!hasFile&&!source)return json({error:'Hãy tải lên một tệp hoặc nhập liên kết nguyên tác.'},400);
   const type=hasFile?validRequestFile(file):null;if(hasFile){if(file.size>25*1024*1024)throw new Error('Tệp yêu cầu tối đa 25 MB.');if(!type.mime)throw new Error('Chỉ hỗ trợ PDF, EPUB, AZW3, DOCX, TXT, JPG, PNG hoặc WebP.');}
   // Counted once the request is valid, so a rejected form never uses up the day's requests.
   const daily=await rateLimit(env,[{daily:`upload:${reader.id}`,max:dailyMax(env,'DAILY_REQUESTS_PER_USER',20),label:'gửi yêu cầu dịch'}]);if(daily)return daily;
   const rid=id();let key=null,filename=null,mime=null;if(hasFile){key=`requests/${rid}/original`;filename=String(file.name).slice(0,240);mime=type.mime;await env.FILES.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:mime}});}
   try{await env.DB.prepare('INSERT INTO requests(id,title,source_url,notes,user_id,visibility,file_key,filename,mime) VALUES(?,?,?,?,?,?,?,?,?)').bind(rid,title,source,notes,reader.id,visibility,key,filename,mime).run();}catch(e){if(key)await env.FILES.delete(key);throw e;}return json({ok:true,id:rid},201);
  }
  if(!admin)return json({error:'Hãy mở Cài đặt và nhập mã quản trị để tiếp tục.'},401);
  const userResponse=await adminAccountRoute(request,env,path);if(userResponse)return userResponse;
  if(path==='/api/settings/gemini-models'&&method==='GET'){const scoped=await withRuntimeGeminiKey(env);return json({models:await listStudyModels(scoped.GEMINI_API_KEY)});}
  if(path==='/api/settings/gemini-key'&&method==='PUT')return json(await saveGeminiApiKey(env,(await request.json()).apiKey));
  if(path==='/api/settings/gemini-key'&&method==='DELETE')return json(await clearGeminiApiKey(env));
  const contentResponse=await adminContent(request,env,path);if(contentResponse)return contentResponse;
  const sourcesResponse=await libraryAdminRoute(request,env,path);if(sourcesResponse)return sourcesResponse;
  if(path==='/api/stories'&&method==='GET')return json((await env.DB.prepare('SELECT s.*,u.name AS owner_name,u.email AS owner_email,COUNT(c.id) AS chapters FROM stories s LEFT JOIN reader_users u ON u.id=s.owner_user_id LEFT JOIN chapters c ON c.story_id=s.id GROUP BY s.id ORDER BY s.created_at DESC').all()).results);
  if(path==='/api/users'&&method==='GET')return json((await env.DB.prepare(`SELECT u.id,u.email,u.name,u.picture,u.created_at,u.updated_at,u.disabled_at,u.terms_version,u.terms_accepted_at,
   (SELECT COUNT(*) FROM requests r WHERE r.user_id=u.id) AS requests,
   (SELECT COUNT(*) FROM requests r WHERE r.user_id=u.id AND r.status='pending') AS pending_requests,
   (SELECT COUNT(*) FROM stories s WHERE s.owner_user_id=u.id) AS books,
   CASE WHEN EXISTS(SELECT 1 FROM reader_credentials rc WHERE rc.user_id=u.id) THEN 'local' ELSE 'google' END AS provider
   FROM reader_users u ORDER BY u.created_at DESC`).all()).results);
  if(path==='/api/user-library'&&method==='GET')return json((await env.DB.prepare(`SELECT s.*,u.email AS owner_email,u.name AS owner_name,COUNT(c.id) AS chapters
   FROM stories s JOIN reader_users u ON u.id=s.owner_user_id LEFT JOIN chapters c ON c.story_id=s.id
   GROUP BY s.id ORDER BY u.created_at DESC,s.created_at DESC`).all()).results);
  if(path==='/api/stories'&&method==='POST'){
   const multipart=request.headers.get('Content-Type')?.includes('multipart/form-data');
   const form=multipart?await request.formData():null,b=form?Object.fromEntries(form):await request.json(),sid=id();
   const title=required(b.title),genre=required(b.genre),visibility=b.visibility==='private'?'private':'public',owner=typeof b.owner_user_id==='string'&&b.owner_user_id?b.owner_user_id:null;if(!GENRES.includes(genre))throw new Error('Lĩnh vực không hợp lệ.');
   // A sample (tools/samples) is keyed by its slug: one book per slug, kept by the library, never by a student.
   const author=cleanAuthor(b.author),sample=b.sample===undefined||b.sample===null||b.sample===''?null:b.sample;
   if(sample!==null&&!validSlug(sample))throw new Error('Mã ví dụ mẫu chỉ gồm chữ thường a-z, số và dấu gạch ngang (2–64 ký tự).');
   if(sample&&owner)throw new Error('Ví dụ mẫu thuộc kho Hoa Trí, không gắn với tài khoản người học.');
   const taken=async()=>sample?await env.DB.prepare('SELECT id FROM stories WHERE source_url=?').bind(SAMPLE_PREFIX+sample).first():null;
   const existing=await taken();if(existing)return json({error:`Đã có ví dụ mẫu “${sample}”.`,id:existing.id},409);
   const cover=b.cover?.size?await saveCover(b.cover,sid,env):null;
   try{await env.DB.prepare('INSERT INTO stories(id,title,genre,cover_key,owner_user_id,visibility,author,source_url) VALUES(?,?,?,?,?,?,?,?)').bind(sid,title,genre,cover,owner,visibility,author||UNKNOWN_AUTHOR,sample?SAMPLE_PREFIX+sample:null).run();}
   catch(e){if(cover)await env.FILES.delete(cover);const raced=/UNIQUE/iu.test(String(e?.message||''))&&await taken();if(raced)return json({error:`Đã có ví dụ mẫu “${sample}”.`,id:raced.id},409);throw e;}
   return json({id:sid},201);
  }
  const storyCover=path.match(/^\/api\/stories\/([^/]+)\/cover$/);
  if(storyCover&&method==='POST'){
   const sid=storyCover[1],story=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=?').bind(sid).first();
   if(!story)return json({error:'Không tìm thấy tài liệu.'},404);
   // page and sha256 (optional): the image is that page of a stored original, which stays the original page in the book.
   const form=await request.formData(),page=String(form.get('page')||''),sha256=String(form.get('sha256')||'').toLowerCase();
   if(page&&!/^[1-9]\d{0,5}$/u.test(page)||sha256&&!/^[a-f\d]{64}$/u.test(sha256))throw new Error('Trang bìa hoặc mã tệp không hợp lệ.');
   const key=await saveCover(form.get('cover'),sid,env);
   try{await env.DB.prepare('UPDATE stories SET cover_key=?,cover_page=?,cover_source_sha256=? WHERE id=?').bind(key,page?Number(page):null,page&&sha256||null,sid).run();}
   catch(e){await env.FILES.delete(key);throw e;}
   if(story.cover_key?.startsWith('covers/')&&story.cover_key!==key)await removeFile(env,story.cover_key);
   return json({ok:true,cover_key:key});
  }
  // A book without a cover any more (a sample replaced by one whose sample.json says "cover": "none"): the image goes,
  // with the page of the original it was taken from.
  if(storyCover&&method==='DELETE'){
   const sid=storyCover[1],story=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=?').bind(sid).first();
   if(!story)return json({error:'Không tìm thấy tài liệu.'},404);
   await env.DB.prepare('UPDATE stories SET cover_key=NULL,cover_page=NULL,cover_source_sha256=NULL WHERE id=?').bind(sid).run();
   if(story.cover_key?.startsWith('covers/'))await removeFile(env,story.cover_key);
   return json({ok:true,cover_key:null});
  }
  if(/^\/api\/stories\/[^/]+$/.test(path)&&method==='PATCH'){const b=await request.json();
   if('title' in b){
    const title=String(b.title||'').trim(),sid=path.split('/').pop();
    if(!title||title.length>200)throw new Error('Tên tài liệu phải có từ 1 đến 200 ký tự.');
    if(!await env.DB.prepare('SELECT id FROM stories WHERE id=?').bind(sid).first())return json({error:'Không tìm thấy tài liệu.'},404);
    await env.DB.prepare('UPDATE stories SET title=? WHERE id=?').bind(title,sid).run();return json({ok:true,title});
   }
   if('genre' in b){
    if(!GENRES.includes(b.genre))throw new Error('Lĩnh vực không hợp lệ.');
    const sid=path.split('/').pop();
    if(!await env.DB.prepare('SELECT id FROM stories WHERE id=?').bind(sid).first())return json({error:'Không tìm thấy tài liệu.'},404);
    await env.DB.prepare('UPDATE stories SET genre=? WHERE id=?').bind(b.genre,sid).run();return json({ok:true});
   }
   // Publish or hide a library book (no owner); a sample needs a part before it goes public.
   if('visibility' in b){
    if(!['public','private'].includes(b.visibility))throw new Error('Chế độ hiển thị phải là public hoặc private.');
    const sid=path.split('/').pop(),updated=await env.DB.prepare(`UPDATE stories SET visibility=? WHERE id=? AND owner_user_id IS NULL AND ${NOT_STUDY_BOOK} AND (?='private' OR COALESCE(source_url,'') NOT LIKE '${SAMPLE_PREFIX}%' OR EXISTS (SELECT 1 FROM chapters WHERE story_id=stories.id))`).bind(b.visibility,sid,b.visibility).run();
    if(!updated.meta?.changes){const story=await env.DB.prepare(`SELECT id FROM stories WHERE id=? AND owner_user_id IS NULL AND ${NOT_STUDY_BOOK}`).bind(sid).first();return story?json({error:'Ví dụ mẫu chưa có phần nào.'},409):json({error:'Chỉ đổi được chế độ hiển thị của sách trong kho Hoa Trí.'},404);}
    return json({ok:true,visibility:b.visibility});
   }
   if('author' in b){
    const author=cleanAuthor(b.author)||UNKNOWN_AUTHOR,updated=await env.DB.prepare(`UPDATE stories SET author=? WHERE id=? AND ${NOT_STUDY_BOOK}`).bind(author,path.split('/').pop()).run();
    return updated.meta?.changes?json({ok:true,author}):json({error:'Không tìm thấy tài liệu trong kho Hoa Trí.'},404);
   }
   if(!b.glossary||typeof b.glossary!=='object'||Array.isArray(b.glossary)||Object.entries(b.glossary).some(([k,v])=>k.length>100||typeof v!=='string'||v.length>100))throw new Error('Bảng tên phải là các cặp tên Trung–Việt.');await env.DB.prepare('UPDATE stories SET glossary=? WHERE id=?').bind(JSON.stringify(b.glossary),path.split('/').pop()).run();return json({ok:true});}
  if(path==='/api/jobs'&&method==='GET')return json((await env.DB.prepare('SELECT j.*,s.title AS story_title,s.genre FROM jobs j JOIN stories s ON s.id=j.story_id ORDER BY j.created_at DESC').all()).results);
  if(path==='/api/jobs'&&method==='POST'){
   const form=await request.formData(),sid=form.get('story_id'),file=form.get('file');let source=String(form.get('text')||''),parts=null,warnings=[],progress='';
   if(!await env.DB.prepare('SELECT id FROM stories WHERE id=?').bind(sid).first())throw new Error('Vui lòng chọn hồ sơ tài liệu.');
   if(new TextEncoder().encode(source).length>25*1024*1024)throw new Error('Văn bản tối đa 25 MB.');
   let key=null,mime=null,filename='Văn bản trực tiếp',firstId=id(),sha256=null;
   if(file&&typeof file!=='string'){
    if(file.size>25*1024*1024||file.size===0)throw new Error('Tài liệu phải từ 1 byte đến 25 MB.');filename=file.name;
    const ext=file.name.split('.').pop().toLowerCase();const types={epub:'application/epub+zip',azw3:'application/vnd.amazon.ebook',pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain'};
    if(!types[ext])throw new Error('Định dạng chưa hỗ trợ. Với .doc cũ, hãy lưu thành .docx hoặc PDF.');mime=types[ext];const data=await file.arrayBuffer();sha256=await sha256Hex(data);
    if(ext==='docx'){const extracted=await mammoth.extractRawText({arrayBuffer:data});source=extracted.value;}if(ext==='txt')source=decodeText(data);if(ext==='epub'){const book=extractEpub(data);source=book.source;parts=book.parts;warnings=book.warnings;progress=`Đã đọc EPUB · ${book.chapterCount} phần theo thứ tự sách`;}if(ext==='azw3'){const book=await extractAzw3(data);source=book.source;parts=book.parts;warnings=book.warnings;progress=`Đã đọc AZW3/KF8 · ${book.chapterCount} phần theo thứ tự sách`;}if(ext==='pdf'&&form.get('parsed_text')){source=cleanExtractedPdfText(String(form.get('parsed_text')));progress=`Đã trích xuất và làm sạch lớp chữ · ${Number(form.get('pdf_pages'))||0} trang`;}if(ext==='pdf'&&form.get('pdf_mode')==='scan')progress=`Đã nhận diện PDF scan · đang nhận ${Number(form.get('pdf_pages'))||0} trang ảnh tối ưu`;
    if(['txt','docx','epub','azw3'].includes(ext)&&!source.trim())throw new Error('Tài liệu không có văn bản để dịch.');if(new TextEncoder().encode(source).length>25*1024*1024)throw new Error('Văn bản trích xuất tối đa 25 MB.');
    key=`uploads/${firstId}`;await env.FILES.put(key,data,{httpMetadata:{contentType:mime}});
   }else if(!source.trim())throw new Error('Hãy chọn tài liệu hoặc nhập văn bản.');
   let prepared;try{prepared=await prepareJobRows(env,sid,{source,parts,filename,mime,fileKey:key,firstId,warnings,progress,sha256});if(prepared.rows.length===1)await prepared.rows[0].statement.run();else await env.DB.batch(prepared.rows.map(row=>row.statement));}catch(error){if(key)await env.FILES.delete(key);for(const storedKey of prepared?.storedKeys||[])await env.FILES.delete(storedKey);throw error;}return json({id:prepared.rows[0].id,ids:prepared.rows.map(row=>row.id),chapters:prepared.rows.length},201);
  }
  const scanPage=path.match(/^\/api\/jobs\/([^/]+)\/pdf-page$/);
  if(scanPage&&method==='POST'){
   const jid=scanPage[1],job=await env.DB.prepare('SELECT id,mime FROM jobs WHERE id=?').bind(jid).first();if(!job||job.mime!=='application/pdf')return json({error:'Không tìm thấy tài liệu PDF.'},404);
   return json(await savePreparedPdfPage(jid,await request.formData(),env));
  }
  const match=path.match(/^\/api\/jobs\/([^/]+)(?:\/(run|prepare|parts|book|source|publish|file))?$/);
  if(match){const jid=match[1],action=match[2],job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jid).first();if(!job)return json({error:'Không tìm thấy bản dịch.'},404);
   if(action==='file'){const file=await env.FILES.get(job.file_key);if(!file)return json({error:'Không tìm thấy file.'},404);return new Response(file.body,{headers:{'Content-Type':job.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(job.filename)}});}
   if(action==='parts'&&method==='GET'){
    const manifest=await getPdfManifest(jid,env);
    return json(manifest?{totalPages:manifest.totalPages,pagesPerPart:manifest.pagesPerPart,complete:manifest.complete,parts:manifest.parts.map(({index,startPage,endPage})=>({index,startPage,endPage}))}:{complete:false,parts:[]});
   }
   if(action==='source'&&method==='GET'){const text=await fullText(env,job.source_key,job.source);return new Response('\uFEFF'+text,{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename=source.txt','Cache-Control':'no-store'}});}
   if(action==='book'&&method==='GET'){
    if(!['review','published'].includes(job.status)||!job.translation.trim())return json({error:'Quyển chưa hoàn tất. Hãy dịch đủ các phần trước khi tải.'},409);
    const story=await env.DB.prepare('SELECT title FROM stories WHERE id=?').bind(job.story_id).first();
    return new Response('\uFEFF'+(story?.title||job.filename)+'\n\n'+cleanReaderText(await fullText(env,job.translation_key,job.translation)),{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent((story?.title||'ban-dich')+'.txt')}});
   }
   if((action==='run'||action==='prepare')&&method==='POST'){
    if(action==='run'&&!(await geminiKeyStatus(env)).configured)return json({error:'Chưa cấu hình khóa Gemini API. Hãy mở Cài đặt để nhập khóa.'},503);
    if(action==='prepare'&&job.mime!=='application/pdf')throw new Error('Chức năng chia nhỏ chỉ dành cho PDF.');
    if(job.status==='published')throw new Error('Bản dịch đã xuất bản.');
    const now=Date.now();
    const locked=await env.DB.prepare("UPDATE jobs SET lease_until=?,error=NULL WHERE id=? AND status!='published' AND lease_until<? AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.story_id=? AND active.id!=? AND active.lease_until>?)").bind(now+900000,jid,now,job.story_id,jid,now).run();
    if(!locked.meta.changes)return json({error:'Hồ sơ tài liệu đang được xử lý. Vui lòng đợi hoàn tất.'},409);
    try{
     if(job.mime==='application/pdf'&&!job.source_key&&!job.source){
      const existing=await getPdfManifest(jid,env);
      if(!existing?.complete){
       const manifest=await preparePdf(job,env);
       await env.DB.prepare('UPDATE jobs SET status=?,progress=?,error=NULL,lease_until=0 WHERE id=?').bind(manifest.complete?'prepared':'splitting',`Đã chia ${manifest.parts.length}/${Math.ceil(manifest.totalPages/manifest.pagesPerPart)} phần · ${manifest.totalPages} trang · ${manifest.pagesPerPart} trang/phần`,jid).run();
       return json(await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jid).first());
      }
      if(action==='prepare'){await env.DB.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').bind(jid).run();return json(job);}
     }
     if(job.mime==='application/pdf'&&action==='prepare'){await env.DB.prepare("UPDATE jobs SET status='prepared',progress=?,lease_until=0 WHERE id=?").bind(job.source_key||job.source?'Đã làm sạch lớp chữ PDF · sẵn sàng dịch':'Đã tối ưu ảnh PDF scan · sẵn sàng OCR',jid).run();return json({...job,status:'prepared'});}
    }catch(e){await env.DB.prepare("UPDATE jobs SET status='failed',error=?,lease_until=0 WHERE id=?").bind(e.message,jid).run();return json(await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jid).first());}
    if(job.status==='review')await env.FILES.delete(`processing/${jid}.json`);
    await processJob(jid,await withRuntimeGeminiKey(env));return json(await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jid).first());
   }
   if(action==='publish'&&method==='POST'){
    if(job.status!=='review'||!job.translation.trim())throw new Error('Chỉ bản dịch đã sẵn sàng duyệt mới được xuất bản.');const b=await request.json();
    if(b.confirmed!==true)throw new Error('Cần xác nhận đã đối chiếu nội dung.');
    // Jobs uploaded before fingerprints existed get one when published, so students can be matched to them.
    if(!job.source_sha256&&job.file_key){const original=await env.FILES.get(job.file_key);if(original)await env.DB.prepare('UPDATE jobs SET source_sha256=? WHERE id=?').bind(await sha256Hex(await original.arrayBuffer()),jid).run();}
    const readerText=cleanReaderText(await fullText(env,job.translation_key,job.translation));if(!readerText)throw new Error('Bản dịch không còn nội dung học thuật sau khi loại bỏ dữ liệu kỹ thuật của PDF.');
    const sections=splitBookTranslation(readerText);
    if(sections.length){const last=await env.DB.prepare('SELECT COALESCE(MAX(position),0) AS position FROM chapters WHERE story_id=?').bind(job.story_id).first(),base=Number(last?.position)||0,statements=[];for(const section of sections){const chapterId=id(),textKey=section.content.length>20000?`reader/${chapterId}.txt`:null;if(textKey)await env.FILES.put(textKey,section.content);statements.push(env.DB.prepare('INSERT INTO chapters(id,story_id,job_id,title,content,text_key,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,job.story_id,jid,section.title,textKey?section.content.slice(0,20000):section.content,textKey,base+section.number));}statements.push(env.DB.prepare("UPDATE jobs SET status='published',error=NULL,progress='Đã được quản trị viên đối chiếu và xuất bản',reviewed_at=CURRENT_TIMESTAMP,published_at=CURRENT_TIMESTAMP WHERE id=?").bind(jid));await env.DB.batch(statements);return json({ok:true,chapters:sections.length});}
    const chapterId=id(),textKey=job.translation_key?`reader/${chapterId}.txt`:null,sequence=Number(String(job.filename||'').match(/^(\d+)\s*·/)?.[1])||null;if(textKey)await env.FILES.put(textKey,readerText);
    await env.DB.batch([env.DB.prepare('INSERT INTO chapters(id,story_id,job_id,title,content,text_key,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,job.story_id,jid,required(b.title),textKey?readerText.slice(0,20000):readerText,textKey,sequence),env.DB.prepare("UPDATE jobs SET status='published',error=NULL,progress='Đã được quản trị viên đối chiếu và xuất bản',reviewed_at=CURRENT_TIMESTAMP,published_at=CURRENT_TIMESTAMP WHERE id=?").bind(jid)]);return json({ok:true,chapters:1});
   }
   if(!action&&method==='PATCH'){
    if(job.lease_until>Date.now()||['splitting','prepared','ocr','translating','assembling','published'].includes(job.status)||(job.status==='failed'&&await env.FILES.get(`processing/${jid}.json`)))throw new Error('Không thể sửa bản dịch ở trạng thái hiện tại.');const b=await request.json();
    if(job.source_key||job.translation_key)throw new Error('Văn bản dài: tải bản đầy đủ để biên tập, rồi dùng Tải bản đọc lên để đăng. Không lưu đè từ bản xem trước.');
    const source=required(b.source,500000),translation=typeof b.translation==='string'?b.translation.trim():'';if(translation.length>1000000)throw new Error('Bản dịch vượt giới hạn cho phép.');await env.DB.prepare('UPDATE jobs SET source=?,translation=?,status=?,error=NULL,progress=? WHERE id=?').bind(source,translation,translation?'review':'uploaded',translation?'Đã lưu bản biên tập':'Sẵn sàng dịch',jid).run();await env.FILES.delete(`processing/${jid}.json`);return json({ok:true});
   }
  }
  if(path==='/api/requests'&&method==='GET')return json((await env.DB.prepare('SELECT r.*,u.email AS reader_email,u.name AS reader_name FROM requests r LEFT JOIN reader_users u ON u.id=r.user_id ORDER BY r.created_at DESC').all()).results);
  const acceptRequest=path.match(/^\/api\/requests\/([^/]+)\/accept$/);if(acceptRequest&&method==='POST')return json(await acceptReaderRequest(acceptRequest[1],env),201);
  const requestFile=path.match(/^\/api\/requests\/([^/]+)\/file$/);if(requestFile&&method==='GET'){const item=await env.DB.prepare('SELECT file_key,filename,mime FROM requests WHERE id=?').bind(requestFile[1]).first(),file=item?.file_key?await env.FILES.get(item.file_key):null;if(!file)return json({error:'Yêu cầu này không có tệp nguồn.'},404);return new Response(file.body,{headers:{'Content-Type':item.mime||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.filename||'nguyen-tac'),'X-Content-Type-Options':'nosniff'}});}
  if(/^\/api\/requests\/[^/]+$/.test(path)&&method==='PATCH'){const b=await request.json();if(!['accepted','done','pending'].includes(b.status))throw new Error('Trạng thái không hợp lệ.');const storyId=typeof b.story_id==='string'&&b.story_id?b.story_id:null;await env.DB.prepare('UPDATE requests SET status=?,story_id=COALESCE(?,story_id) WHERE id=?').bind(b.status,storyId,path.split('/').pop()).run();return json({ok:true});}
  return json({error:'Không tìm thấy chức năng.'},404);
}
