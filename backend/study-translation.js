import mammoth from 'mammoth/mammoth.browser.js';
import {extractEpub} from './epub.js';
import {extractAzw3} from './azw3.js';
import {decodeText} from './text-storage.js';
import {recognizeDocument,translateAndVerify} from './ai.js';
import {currentReader} from './reader-auth.js';
import {studyHistoryRoute} from './study-history.js';
import {studyBookRoute} from './study-books.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {translatePdfBlocks} from './pdf-block-translation.js';
import {isStudyModel,listStudyModels,selectStudyModel} from './gemini-models.js';

const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const MODELS={economy:'gemini-2.5-flash-lite',balanced:'gemini-3.1-flash-lite',quality:'gemini-2.5-flash'};
const DOMAINS={general:'Chuyên khảo · Nghiên cứu',math:'Toán học · STEM',history:'Lịch sử Trung Hoa'};
const modelFor=(env,mode)=>env[{economy:'GEMINI_ECONOMY_MODEL',balanced:'GEMINI_BALANCED_MODEL',quality:'GEMINI_QUALITY_MODEL'}[mode]]||env.GEMINI_MODEL||MODELS[mode];
export const studyModelConfig=env=>({economy:modelFor(env,'economy'),balanced:modelFor(env,'balanced'),quality:modelFor(env,'quality'),pdf:env.GEMINI_PDF_BLOCK_MODEL||modelFor(env,'economy'),runtimeVersion:'pdf-layout-v2-key-model-selection'});
function requestModel(body,fallback){if(!body.model)return fallback;if(!isStudyModel(body.model))throw new Error('Hãy chọn một model Gemini Flash trong danh sách khả dụng.');return body.model;}
const validKey=value=>typeof value==='string'&&value.length>=20&&value.length<=500&&!/[\r\n\0]/.test(value);
const scopedEnv=(env,apiKey,model,thinking=model==='gemini-2.5-flash'?'default':'minimal')=>new Proxy(env,{get(target,property){if(property==='GEMINI_API_KEY')return apiKey;if(property==='GEMINI_MODEL')return model;if(property==='GEMINI_THINKING')return thinking;if(property==='GEMINI_MODEL_RECOVERY')return true;if(property==='GEMINI_PREFERRED_MODEL')return target.GEMINI_MODEL||'gemini-3.6-flash';if(property==='FILES')return undefined;return Reflect.get(target,property);}});
export function localTranslationReview(source,translation){
 const sourceText=String(source||'').trim(),translatedText=String(translation||'').trim();
 const sourceHan=(sourceText.match(/\p{Script=Han}/gu)||[]).length,remainingHan=(translatedText.match(/\p{Script=Han}/gu)||[]).length;
 const sourceParagraphs=sourceText?sourceText.split(/\n\s*\n/u).filter(Boolean).length:0,translatedParagraphs=translatedText?translatedText.split(/\n\s*\n/u).filter(Boolean).length:0;
 const warnings=[];
 if(sourceHan>=20&&remainingHan/sourceHan>.25)warnings.push('Bản dịch còn nhiều chữ Hán; nên đối chiếu vì có thể có đoạn chưa được dịch hết.');
 if(sourceText.length>=200&&translatedText.length<sourceText.length*.35)warnings.push('Bản dịch ngắn bất thường so với nguyên tác; nên kiểm tra khả năng bỏ sót nội dung.');
 if(sourceParagraphs>=3&&Math.abs(sourceParagraphs-translatedParagraphs)>Math.max(1,Math.floor(sourceParagraphs*.25)))warnings.push('Số đoạn giữa nguyên tác và bản dịch chênh lệch đáng kể; nên đối chiếu cấu trúc.');
 return {warnings,metrics:{sourceCharacters:sourceText.length,translationCharacters:translatedText.length,sourceParagraphs,translatedParagraphs,remainingHan}};
}

export async function studyRoute(request,env,url,path){
 if(!path.startsWith('/api/my/study/'))return null;
 const reader=await currentReader(request,env);if(!reader)return reply({error:'Hãy đăng nhập để dùng không gian dịch học tập.'},401);
 const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return reply({error:'Nguồn yêu cầu không hợp lệ.'},403);
 if(path==='/api/my/study/config'&&request.method==='GET')return reply(studyModelConfig(env));
 if(path==='/api/my/study/models'&&request.method==='POST'){
  const body=await request.json(),apiKey=String(body.apiKey||'').trim(),mode=Object.hasOwn(MODELS,body.mode)?body.mode:'economy';if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
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
  const model=requestModel(body,env.GEMINI_PDF_BLOCK_MODEL||modelFor(env,body.mode||'economy'));
  const result=await translatePdfBlocks(scopedEnv(env,apiKey,model,'minimal'),body);return reply({...result,model:result.model||model});
 }
 if(path==='/api/my/study/extract'){
  const file=(await request.formData()).get('file');if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('Tệp phải từ 1 byte đến 25 MB.');
  const extension=String(file.name||'').split('.').pop().toLowerCase(),data=await file.arrayBuffer();let text;
  if(extension==='txt')text=decodeText(data);
  else if(extension==='docx')text=(await mammoth.extractRawText({arrayBuffer:data})).value;
  else if(extension==='epub')text=extractEpub(data).parts.map(part=>part.content).join('\n\n');
  else if(extension==='azw3')text=(await extractAzw3(data)).parts.map(part=>part.content).join('\n\n');
  else throw new Error('Chỉ hỗ trợ TXT, DOCX, EPUB và AZW3 tại bước trích xuất. PDF được đọc ngay trong trình duyệt.');
  if(!text.trim()||text.length>2_000_000)throw new Error('Tệp không có văn bản hoặc vượt giới hạn 2 triệu ký tự của không gian học tập.');
  return reply({text});
 }
 if(path==='/api/my/study/ocr'){
  const form=await request.formData(),apiKey=String(form.get('apiKey')||'').trim(),file=form.get('image');
  if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  if(!file||typeof file==='string'||!file.size||file.size>3*1024*1024)throw new Error('Ảnh OCR phải nhỏ hơn 3 MB.');
  const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer()),webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP',jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!webp&&!jpeg)throw new Error('Ảnh OCR phải là WebP hoặc JPEG.');
  const selectedModel=isStudyModel(String(form.get('model')||''))?String(form.get('model')):modelFor(env,'economy');
  const result=await recognizeDocument(scopedEnv(env,apiKey,selectedModel,'minimal'),file,webp?'image/webp':'image/jpeg');
  if(typeof result.text!=='string'||!result.text.trim())throw new Error('OCR không nhận được văn bản; hãy kiểm tra trang scan.');
  return reply({text:result.text,warnings:Array.isArray(result.warnings)?result.warnings:[],usage:result.__usage||null,model:result.__model||selectedModel});
 }
 if(path==='/api/my/study/translate'){
  const body=await request.json(),source=String(body.source||''),apiKey=String(body.apiKey||'').trim(),mode=Object.hasOwn(MODELS,body.mode)?body.mode:'economy',domain=Object.hasOwn(DOMAINS,body.domain)?body.domain:'general';
  if(!validKey(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
  if(!source.trim()||source.length>8000)throw new Error('Mỗi lượt dịch cần từ 1 đến 8.000 ký tự.');
  const context=String(body.context||'').slice(-900),previousSource=String(body.previousSource||'').slice(-350),previousTranslation=String(body.previousTranslation||'').slice(-500);
  const rawGlossary=body.glossary&&typeof body.glossary==='object'&&!Array.isArray(body.glossary)?body.glossary:{};
  const glossary=Object.fromEntries(Object.entries(rawGlossary).filter(([key,value])=>!['__proto__','constructor','prototype'].includes(key)&&key.length<=100&&typeof value==='string'&&value.length<=100).slice(0,500));
  const story={genre:DOMAINS[domain],context,glossary:JSON.stringify(glossary),previousSource,previousTranslation};
  const selectedModel=requestModel(body,modelFor(env,mode)),qualityModel=body.model?selectedModel:modelFor(env,'quality');
  // Quality mode keeps a bounded reasoning budget; unbounded default thinking can cost more than the translation itself.
  const outcome=await translateAndVerify(scopedEnv(env,apiKey,selectedModel,mode==='quality'?'low':'minimal'),source,story,{
   repairEnv:scopedEnv(env,apiKey,qualityModel,'minimal'),
   retryEnv:scopedEnv(env,apiKey,qualityModel,'default'),
   allowRepair:mode!=='quality'
  });
  const model=outcome.model||(outcome.repairScope==='full'?qualityModel:selectedModel);
  const review=localTranslationReview(source,outcome.translation);
  return reply({translation:outcome.translation,context:outcome.context,glossary:outcome.glossary,usage:outcome.usage,model,repairModel:outcome.repairModel,retried:outcome.retried,warnings:[...outcome.warnings,...review.warnings],review:review.metrics});
 }
 return reply({error:'Không tìm thấy chức năng học tập.'},404);
}
