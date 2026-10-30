import {extractDocxText,documentTooLarge} from './document-limits.js';
import {extractEpub} from './epub.js';
import {extractAzw3} from './azw3.js';
import {decodeText} from './text-storage.js';
import {recognizeDocument,translateAndVerify,spentOn} from './ai.js';
import {withoutEdgeMarks} from './pdf-cleaning.js';
import {currentReader} from './reader-auth.js';
import {studyHistoryRoute} from './study-history.js';
import {studyBookRoute} from './study-books.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {translatePdfBlocks} from './pdf-block-translation.js';
import {isStudyModel,listStudyModels,selectStudyModel} from './gemini-models.js';
import {rateLimit} from './rate-limit.js';
import {isSubject,subjectOf,ownTerms,textModeTerms,ownTermWarnings,GLOSSARY_WARNING} from './subject-glossaries.js';
import {unifyHan,unifyGlossaryKeys} from './han-text.js';
import {UserError} from './http.js';
import {MODES,DEFAULT_MODE,isMode,modeProfile} from '../frontend/translation-modes.js';

const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
// A mode's own variable, then GEMINI_MODEL, then the default; "Kỹ nhất" (premium) falls back on quality's, a Flash model.
const MODELS={economy:'gemini-2.5-flash-lite',balanced:'gemini-3.1-flash-lite',quality:'gemini-2.5-flash'};
const MODEL_VARS={economy:'GEMINI_ECONOMY_MODEL',balanced:'GEMINI_BALANCED_MODEL',quality:'GEMINI_QUALITY_MODEL',premium:'GEMINI_PREMIUM_MODEL'};
const modelFor=(env,mode)=>env[MODEL_VARS[mode]]||env.GEMINI_MODEL||MODELS[mode]||MODELS.quality;
// modes: what the "Cách dịch" select offers (frontend/translation-modes.js); layoutModes: the modes that change a kept-layout
// PDF, which is every one of them now that each sets its own reasoning, batches and OCR sheets.
export const studyModelConfig=env=>({economy:modelFor(env,'economy'),balanced:modelFor(env,'balanced'),quality:modelFor(env,'quality'),premium:modelFor(env,'premium'),pdf:env.GEMINI_PDF_BLOCK_MODEL||modelFor(env,'economy'),modes:MODES.map(id=>{const {label,hint,estimate}=modeProfile(id);return {id,label,hint,estimate};}),layoutModes:[...MODES],runtimeVersion:'pdf-layout-v2-key-model-selection'});
function requestModel(body,fallback){if(!body.model)return fallback;if(!isStudyModel(body.model))throw new Error('Hãy chọn một model Gemini Flash trong danh sách khả dụng.');return body.model;}
// A request without a mode (a page from before modes existed) is economy; a mode this server does not know is refused
// rather than quietly run as another one.
function requestMode(value){
 if(value===undefined||value===null||value==='')return DEFAULT_MODE;
 if(!isMode(value))throw new UserError('Cách dịch không hợp lệ. Hãy tải lại trang rồi thử lại.',400,'bad_mode');
 return value;
}
// A mode's layoutBatch is the most one block request may carry; a block longer than its characters still goes, alone.
function checkBatch(blocks,{chars,blocks:most}){
 const length=blocks.reduce((sum,block)=>sum+(typeof block?.source==='string'?block.source.length:0),0);
 if(blocks.length>most||blocks.length>1&&length>chars)throw new UserError(`Mỗi lượt dịch của cách dịch đã chọn nhận tối đa ${most} đoạn và ${new Intl.NumberFormat('vi-VN').format(chars)} ký tự. Hãy tải lại trang rồi dịch tiếp.`,400,'bad_batch');
}
const validKey=value=>typeof value==='string'&&value.length>=20&&value.length<=500&&!/[\r\n\0]/.test(value);
const MAX_STUDY_CHARACTERS=2_000_000,TOO_LONG='Tệp không có văn bản hoặc vượt giới hạn 2 triệu ký tự của không gian học tập.';
const scopedEnv=(env,apiKey,model,thinking=model==='gemini-2.5-flash'?'default':'minimal')=>new Proxy(env,{get(target,property){if(property==='GEMINI_API_KEY')return apiKey;if(property==='GEMINI_MODEL')return model;if(property==='GEMINI_THINKING')return thinking;if(property==='GEMINI_MODEL_RECOVERY')return true;if(property==='GEMINI_PREFERRED_MODEL')return target.GEMINI_MODEL||'gemini-3.6-flash';if(property==='FILES')return undefined;return Reflect.get(target,property);}});
// The whole part at a glance, beside the line-by-line checks of translateAndVerify (which name each paragraph that keeps
// Chinese or lacks a heading, an item, a caption, a verse line or a number): much Chinese left, or a translation far too
// short. Paragraph counts are only reported: Gemini joins the wrapped lines of an OCR reading, so a count that differs
// says nothing by itself.
export function localTranslationReview(source,translation){
 const sourceText=String(source||'').trim(),translatedText=String(translation||'').trim();
 const sourceHan=(sourceText.match(/\p{Script=Han}/gu)||[]).length,remainingHan=(translatedText.match(/\p{Script=Han}/gu)||[]).length;
 const sourceParagraphs=sourceText?sourceText.split(/\n\s*\n/u).filter(Boolean).length:0,translatedParagraphs=translatedText?translatedText.split(/\n\s*\n/u).filter(Boolean).length:0;
 const warnings=[];
 if(sourceHan>=20&&remainingHan/sourceHan>.25)warnings.push('Bản dịch còn nhiều chữ Hán; nên đối chiếu vì có thể có đoạn chưa được dịch hết.');
 if(sourceText.length>=200&&translatedText.length<sourceText.length*.35)warnings.push('Bản dịch ngắn bất thường so với nguyên tác; nên kiểm tra khả năng bỏ sót nội dung.');
 return {warnings,metrics:{sourceCharacters:sourceText.length,translationCharacters:translatedText.length,sourceParagraphs,translatedParagraphs,remainingHan}};
}

// Per-minute limits per account. Uploads and PDF service calls are heavy; every other change, and the font call that
// reaches the PDF service, shares one looser limit, which also stops a runaway loop spending the student's own key.
// OCR of a scan's blocks runs call after call, so it stays on the looser one.
const HEAVY=new Set(['/api/my/study/extract','/api/my/study/pdf-layout/extract','/api/my/study/pdf-layout/refresh','/api/my/study/pdf-layout/render']);
function studyLimit(path,method){
 if(HEAVY.has(path))return {binding:'HEAVY_LIMITER',key:path.includes('pdf-layout')?'pdf':'upload'};
 return method!=='GET'||path==='/api/my/study/pdf-layout/font'?{binding:'API_LIMITER',key:'api'}:null;
}
export async function studyRoute(request,env,url,path){
 if(!path.startsWith('/api/my/study/'))return null;
 const reader=await currentReader(request,env);if(!reader)return reply({error:'Hãy đăng nhập để dùng không gian dịch học tập.'},401);
 const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return reply({error:'Nguồn yêu cầu không hợp lệ.'},403);
 const rule=studyLimit(path,request.method);
 if(rule){const limit=await rateLimit(env,[{binding:rule.binding,key:`${rule.key}:${reader.id}`}]);if(limit)return limit;}
 if(path==='/api/my/study/config'&&request.method==='GET')return reply(studyModelConfig(env));
 if(path==='/api/my/study/models'&&request.method==='POST'){
  const body=await request.json(),apiKey=String(body.apiKey||'').trim(),mode=requestMode(body.mode);if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  const requested=body.purpose==='pdf'?(env.GEMINI_PDF_BLOCK_MODEL||modelFor(env,mode)):modelFor(env,mode),models=await listStudyModels(apiKey),selected=selectStudyModel(models,requested,env.GEMINI_MODEL||'gemini-3.6-flash');
  return reply({models,requested,selected,runtimeVersion:studyModelConfig(env).runtimeVersion});
 }
 if(path==='/api/my/study/library-match'&&request.method==='GET'){
  // Points a student to a teacher-published translation of the identical file; the student may still translate.
  const sha256=String(url.searchParams.get('sha256')||'').toLowerCase();if(!/^[a-f\d]{64}$/u.test(sha256))return reply({error:'Mã tệp không hợp lệ.'},400);
  const match=await env.DB.prepare(`SELECT s.id,s.title,s.genre,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS chapters FROM jobs j JOIN stories s ON s.id=j.story_id
   WHERE j.source_sha256=? AND j.status='published' AND s.visibility='public' AND EXISTS (SELECT 1 FROM chapters c WHERE c.story_id=s.id) ORDER BY j.created_at DESC LIMIT 1`).bind(sha256).first();
  return reply({match:match||null});
 }
 const bookResponse=await studyBookRoute(request,env,path,reader);if(bookResponse)return bookResponse;
 const historyResponse=await studyHistoryRoute(request,env,path,reader);if(historyResponse)return historyResponse;
 const layoutResponse=await pdfLayoutRoute(request,env,path,reader);if(layoutResponse)return layoutResponse;
 if(request.method!=='POST')return reply({error:'Phương thức không được hỗ trợ.'},405);
 if(path==='/api/my/study/translate-blocks'){
  const body=await request.json(),apiKey=String(body.apiKey||'').trim();if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  const mode=requestMode(body.mode),profile=modeProfile(mode),model=requestModel(body,env.GEMINI_PDF_BLOCK_MODEL||modelFor(env,mode));
  // Measured as the browser cut the batch, before the look-alike ideographs below are unified.
  if(Array.isArray(body.blocks))checkBatch(body.blocks,profile.layoutBatch);
  // Gemini and the glossary see ordinary ideographs where a PDF wrote look-alike ones (han-text.js); the blocks keep
  // their IDs and the browser keeps its own copy of the sources.
  if(Array.isArray(body.blocks))body.blocks=body.blocks.map(block=>block&&typeof block.source==='string'?{...block,source:unifyHan(block.source)}:block);
  if(body.glossary&&typeof body.glossary==='object'&&!Array.isArray(body.glossary))body.glossary=unifyGlossaryKeys(body.glossary);
  // The mode sets how much Gemini reasons; every mode asks once more for a block that still holds Chinese or lacks a line,
  // a strict one also for a block that changed a number or came back implausibly short (body.groups: blocks not reached
  // sent again in the groups they were left in).
  const result=await translatePdfBlocks(scopedEnv(env,apiKey,model,profile.translateThinking),body,{strict:profile.strict});return reply({...result,model:result.model||model});
 }
 if(path==='/api/my/study/extract'){
  const file=(await request.formData()).get('file');if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('Tệp phải từ 1 byte đến 25 MB.');
  const extension=String(file.name||'').split('.').pop().toLowerCase();
  // A character takes at most 4 bytes: a longer TXT cannot fit the 2 million characters and is never decoded whole.
  if(extension==='txt'&&file.size>4*MAX_STUDY_CHARACTERS)throw documentTooLarge(TOO_LONG);
  const data=await file.arrayBuffer();let text;
  if(extension==='txt')text=decodeText(data);
  else if(extension==='docx')text=await extractDocxText(data);
  else if(extension==='epub')text=extractEpub(data).parts.map(part=>part.content).join('\n\n');
  else if(extension==='azw3')text=(await extractAzw3(data)).parts.map(part=>part.content).join('\n\n');
  else throw new Error('Chỉ hỗ trợ TXT, DOCX, EPUB và AZW3 tại bước trích xuất. PDF được đọc ngay trong trình duyệt.');
  if(!text.trim()||text.length>MAX_STUDY_CHARACTERS)throw new Error(TOO_LONG);
  return reply({text});
 }
 if(path==='/api/my/study/ocr'){
  const form=await request.formData(),apiKey=String(form.get('apiKey')||'').trim(),file=form.get('image');
  if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  const mode=requestMode(form.get('mode'));
  if(!file||typeof file==='string'||!file.size||file.size>3*1024*1024)throw new Error('Ảnh OCR phải nhỏ hơn 3 MB.');
  const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer()),webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP',jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!webp&&!jpeg)throw new Error('Ảnh OCR phải là WebP hoặc JPEG.');
  const selectedModel=isStudyModel(String(form.get('model')||''))?String(form.get('model')):modelFor(env,mode);
  const result=await recognizeDocument(scopedEnv(env,apiKey,selectedModel,modeProfile(mode).ocrThinking),file,webp?'image/webp':'image/jpeg');
  // ocr_empty: nothing was read, which the browser counts as a region left unread (frontend/pdf-client.js readPictureText);
  // the reading was billed all the same, and its tokens go back with the error to the student's counter.
  if(typeof result.text!=='string'||!result.text.trim())throw spentOn(new UserError('OCR không nhận được văn bản; hãy kiểm tra trang scan.',400,'ocr_empty'),result.__usage);
  // A page read on its own keeps its running head and foot as lines to translate, without the marks the reading put on them
  // (text). marked: the reading with those marks, when it has any, so the study page keeps a running head or foot once
  // across the pages it read (frontend/study.js cleanReadPages, D8); a page that does not know it reads text as before.
  const text=withoutEdgeMarks(result.text);
  return reply({text,...(text!==result.text?{marked:result.text}:{}),warnings:Array.isArray(result.warnings)?result.warnings:[],usage:result.__usage||null,model:result.__model||selectedModel});
 }
 if(path==='/api/my/study/translate'){
  // Text pasted from a PDF may spell Chinese with radicals or compatibility ideographs: the source, its context and the
  // glossary keys are unified first, so terms match and Gemini reads ordinary characters (han-text.js).
  const body=await request.json(),source=unifyHan(String(body.source||'')),apiKey=String(body.apiKey||'').trim(),mode=requestMode(body.mode),profile=modeProfile(mode),domain=isSubject(body.domain)?body.domain:'general';
  if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  if(!source.trim()||source.length>8000)throw new Error('Mỗi lượt dịch cần từ 1 đến 8.000 ký tự.');
  const context=String(body.context||'').slice(-900),previousSource=unifyHan(String(body.previousSource||'').slice(-350)),previousTranslation=String(body.previousTranslation||'').slice(-500);
  const rawGlossary=body.glossary&&typeof body.glossary==='object'&&!Array.isArray(body.glossary)?unifyGlossaryKeys(body.glossary):{};
  // Built-in terms come back in every reply's glossary; they are added here again, so they never take the 500 places
  // kept for the student's own and learned terms.
  const glossary=Object.fromEntries(Object.entries(ownTerms(rawGlossary,domain)).filter(([key,value])=>!['__proto__','constructor','prototype'].includes(key)&&key.length<=100&&typeof value==='string'&&value.length<=100).slice(0,500)),subjectTerms=textModeTerms(domain);
  // ai.js adds the math terms itself (by genre); another subject's terms travel in the glossary it is given.
  const story={genre:subjectOf(domain).label,context,glossary:JSON.stringify({...subjectTerms,...glossary}),previousSource,previousTranslation};
  const selectedModel=requestModel(body,modelFor(env,mode)),qualityModel=body.model?selectedModel:modelFor(env,'quality');
  // The mode bounds the reasoning of the translation and of the one correction of the places the checks find (Chinese
  // left, a line, a number or a marker missing), made by the stronger model: unbounded default thinking can cost more than
  // the translation.
  const outcome=await translateAndVerify(scopedEnv(env,apiKey,selectedModel,profile.translateThinking),source,story,{
   repairEnv:scopedEnv(env,apiKey,qualityModel,profile.translateThinking),
   allowRepair:profile.allowRepair
  });
  const model=outcome.model||selectedModel;
  const review=localTranslationReview(source,outcome.translation);
  // Subject terms may vary with context, as the math ones do: only the student's own terms are checked afterwards.
  const warnings=Object.keys(subjectTerms).length?[...outcome.warnings.filter(warning=>!warning.startsWith(GLOSSARY_WARNING)),...ownTermWarnings(source,outcome.translation,glossary)]:outcome.warnings;
  return reply({translation:outcome.translation,context:outcome.context,glossary:outcome.glossary,usage:outcome.usage,model,repairModel:outcome.repairModel,retried:outcome.retried,warnings:[...warnings,...review.warnings],review:review.metrics});
 }
 return reply({error:'Không tìm thấy chức năng học tập.'},404);
}
