// texts.json -> the corrected manifest and the block translations, through the app's own checks: OCR readings as the
// ocr-blocks route checks Gemini's (readOcrText, misassignedBlocks, applyOcrReadings), translations as
// translatePdfBlocks checks them (checkBlockTranslation, blockTranslationWarnings), then the exporter's final gate
// (validateBlockTranslations). Every problem of the file is reported in one pass. No model is called.
import {readOcrText,misassignedBlocks} from '../../../backend/pdf-block-ocr.js';
import {checkBlockTranslation,blockTranslationWarnings} from '../../../backend/pdf-block-translation.js';
import {applyOcrReadings} from '../../../backend/pdf-layout-apply.js';
import {validateBlockTranslations} from '../../../frontend/pdf-box-layout.js';
import {protectMathExpressions} from '../../../backend/ai.js';
import {localTranslationReview} from '../../../backend/study-translation.js';
import {builtInGlossary,termsInText} from '../../../backend/subject-glossaries.js';
import {validGlossary} from './config.mjs';

// Delimited math without Chinese in it must reach the translation unchanged (math with Chinese words is translated).
const keptFormulas=(source,translation)=>{const kept=new Set(protectMathExpressions(translation).formulas.map(f=>f.formula));return protectMathExpressions(source).formulas.map(f=>f.formula).filter(f=>!/\p{Script=Han}/u.test(f)&&!kept.has(f)&&!translation.includes(f));};
// Extractor notes worth a warning: Chinese outside every block stays Chinese on the exported page.
const LEFT_CHINESE=/chữ Hán không thuộc đoạn nào/u;

// domain: the sample's subject; its built-in terms tell which of the book's terms stand on their own in a block.
export function importTexts(document,texts,{slug,chunk,glossary={},domain='general'}={}){
 const errors=[],warnings=[],info=[],entries=new Map(),translations=[],working=structuredClone(document);
 const error=(id,message)=>errors.push({id:id||null,message}),warn=(id,message)=>warnings.push({id:id||null,message});
 const blocks=working.pages.flatMap(page=>page.blocks.map(block=>({block,page})));let merged={...glossary},notes=[],translator='';
 const result=()=>{
  const sourceCharacters=blocks.reduce((n,{block})=>n+block.source.length,0),translationCharacters=translations.reduce((n,t)=>n+t.translation.length,0);
  return {document:working,translations:errors.length?[]:translations,errors,warnings,info,notes,translator,glossary:merged,stats:{blocks:blocks.length,ocrBlocks:blocks.filter(item=>item.page.ocr).length,corrected:blocks.filter(item=>item.block.ocrCorrected).length,translated:translations.length,sourceCharacters,translationCharacters}};
 };
 if(!texts||typeof texts!=='object'||Array.isArray(texts)){error(null,'texts.json phải là một đối tượng JSON.');return result();}
 if(texts.version!==1)error(null,'texts.json: "version" phải là 1.');
 if(texts.sample!==slug)error(null,`texts.json: "sample" phải là "${slug}".`);
 if(texts.chunk!==chunk)error(null,`texts.json: "chunk" phải là "${chunk}".`);
 try{merged={...glossary,...validGlossary(texts.glossary,'texts.json "glossary"')};}catch(e){error(null,e.message);}
 if(typeof texts.translator==='string'&&texts.translator.trim())translator=texts.translator.trim().slice(0,200);else warn(null,'texts.json chưa ghi "translator" (mô hình hoặc người dịch).');
 const rawNotes=texts.notes===undefined||texts.notes===null?[]:[texts.notes].flat();
 if(rawNotes.some(note=>typeof note!=='string'))warn(null,'texts.json: "notes" phải là danh sách chuỗi; đã bỏ qua phần không phải chuỗi.');
 notes=rawNotes.filter(note=>typeof note==='string'&&note.trim()).map(note=>note.trim().slice(0,1000)).slice(0,50);
 if(!Array.isArray(texts.blocks)){error(null,'texts.json: "blocks" phải là danh sách đoạn.');return result();}
 const known=new Map(blocks.map(item=>[item.block.id,item]));
 for(const [index,entry] of texts.blocks.entries()){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)){error(null,`Mục ${index+1} của "blocks" không phải một đoạn.`);continue;}
  if(typeof entry.id!=='string'||!known.has(entry.id)){error(null,`Mã đoạn lạ "${String(entry.id??'').slice(0,40)}" (mục ${index+1}).`);continue;}
  if(entries.has(entry.id)){error(entry.id,`Đoạn ${entry.id} được ghi hai lần.`);continue;}
  entries.set(entry.id,entry);
 }
 for(const {block} of blocks)if(!entries.has(block.id))error(block.id,`Thiếu đoạn ${block.id}.`);
 // Scanned pages: a corrected source replaces the machine hint exactly as an OCR answer would.
 const readings=[],read=[];
 for(const {block,page} of blocks){
  const entry=entries.get(block.id);if(!entry)continue;const value=entry.source;
  if(!page.ocr){if(value!==undefined&&value!==null&&value!==block.source)warn(block.id,`Đoạn ${block.id} thuộc trang có lớp chữ: "source" bị bỏ qua, chữ Trung lấy từ PDF.`);continue;}
  if(value===undefined||value===null){warn(block.id,`Đoạn ${block.id} (trang scan) giữ chữ OCR máy vì "source" để trống; hãy chắc là chữ đó đúng với ảnh.`);continue;}
  if(typeof value!=='string'||!value.trim()){error(block.id,`Đoạn ${block.id}: "source" (chữ Trung) trống.`);continue;}
  if(value.length>8000){error(block.id,`Đoạn ${block.id}: "source" dài quá 8.000 ký tự.`);continue;}
  let text;try{text=readOcrText(value,block,{tab:block.ocrLabel});}catch(e){error(block.id,e.message);continue;}
  if(value.trim()===String(block.source).trim())warn(block.id,`Đoạn ${block.id}: chữ Trung giống hệt chữ OCR máy; hãy chắc là đã đối chiếu với ảnh.`);
  readings.push({id:block.id,text});read.push(block);
 }
 const swapped=misassignedBlocks(read,new Map(readings.map(r=>[r.id,r.text])));
 if(swapped.length)error(null,`Chữ Trung của các đoạn ${[...new Set(swapped.flatMap(s=>[s.id,s.matches]))].join(', ')} có vẻ bị ghi lẫn sang nhau; hãy kiểm tra lại.`);
 applyOcrReadings(working,{blocks:readings});
 const sources=[];
 for(const {block} of blocks){
  const entry=entries.get(block.id);if(!entry)continue;
  let translation;try{translation=checkBlockTranslation(block.id,block.source,entry.translation);}catch(e){error(block.id,e.message);continue;}
  if(translation.length>20000){error(block.id,`Block ${block.id}: bản dịch dài quá 20.000 ký tự.`);continue;}
  for(const formula of keptFormulas(block.source,translation))warn(block.id,`Đoạn ${block.id}: công thức ${formula.slice(0,80)} không được chép nguyên văn sang bản dịch.`);
  translations.push({id:block.id,translation});sources.push(block);
 }
 // Chinese left in a block, then the book's terms not followed: each block is checked on the terms it uses as terms of
 // their own (termsInText), so a book term is not asked for inside a longer one (质量 in 质量数).
 const leftover=blockTranslationWarnings(sources,translations,{}),within={...builtInGlossary(domain),...merged};
 const terms=sources.flatMap((block,index)=>blockTranslationWarnings([block],[translations[index]],termsInText(merged,block.source,{within}))).filter(message=>!leftover.includes(message));
 for(const message of [...leftover,...terms])warn(message.match(/^Block (\S+):/u)?.[1],message);
 if(!errors.length)try{validateBlockTranslations(working.pages.flatMap(p=>p.blocks),translations);}catch(e){error(null,e.message);}
 if(translations.length)for(const message of localTranslationReview(sources.map(b=>b.source).join('\n\n'),translations.map(t=>t.translation).join('\n\n')).warnings)warn(null,message);
 for(const note of document.warnings||[]){if(LEFT_CHINESE.test(note))warn(null,`Khi tách trang: ${note}`);else info.push(`Khi tách trang: ${note}`);}
 return result();
}
