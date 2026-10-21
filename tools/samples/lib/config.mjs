// samples/<slug>/sample.json: what the owner decides about one sample (book, pages, cover, rights).
import {SUBJECT_IDS} from '../../../backend/subject-glossaries.js';
// Same list as GENRES in backend/worker.js (a test keeps the two equal): the library only shows these genres.
export const GENRES=Object.freeze(['Chuyên khảo · Nghiên cứu','Toán học · STEM','Lịch sử Trung Hoa','Cổ văn · Hán Nôm','Triết học · Tư tưởng','Văn hóa · Xã hội','Địa lý · Khảo cổ','Giáo dục','Ngôn ngữ học','Tài liệu khác']);
// The study workspace's subjects: each adds its built-in terms to the translation rules.
export const DOMAINS=SUBJECT_IDS;
// excerpt: readers get the cover and the translated pages as the original; full: the whole source.pdf.
export const PUBLISH_SOURCES=Object.freeze(['excerpt','full']);
const RANGE=/^\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*\s*$/u;

export function sampleTemplate(slug,{title='',author='',source='source.pdf'}={}){
 return {slug,title,author,genre:'Tài liệu khác',domain:'general',source,ranges:[],cover:'auto',translateCover:false,publishSource:'excerpt',glossary:{},rights:{confirmed:false,localOnly:true,note:''}};
}
export function validGlossary(value,where='glossary'){
 if(value===undefined||value===null)return {};
 if(typeof value!=='object'||Array.isArray(value))throw new Error(`${where} phải là bảng {"chữ Trung":"tiếng Việt"}.`);
 const entries=Object.entries(value);
 if(entries.length>500||entries.some(([k,v])=>!k.trim()||k.length>100||typeof v!=='string'||!v.trim()||v.length>100||['__proto__','constructor','prototype'].includes(k)))throw new Error(`${where}: mỗi mục gồm chữ Trung và tiếng Việt, tối đa 100 ký tự mỗi bên (tối đa 500 mục).`);
 return Object.fromEntries(entries.map(([k,v])=>[k.trim(),v.trim()]));
}
// need: the fields a command cannot work without ('ranges' to extract, 'publish' for everything shown publicly).
// Every problem is listed at once.
export function validateSample(value,{slug,need=[]}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('sample.json phải là một đối tượng JSON.');
 const problems=[],text=(key,max,{required=false}={})=>{const v=value[key];if(v===undefined||v===null||v==='')return required?(problems.push(`thiếu "${key}"`),''):'';if(typeof v!=='string'||v.trim().length>max){problems.push(`"${key}" phải là chuỗi tối đa ${max} ký tự`);return '';}return v.trim();};
 const publishing=need.includes('publish');
 if(value.slug!==undefined&&value.slug!==slug)problems.push(`"slug" phải là "${slug}" (tên thư mục)`);
 const title=text('title',200,{required:publishing}),author=text('author',200);
 const genre=value.genre??'Tài liệu khác';if(!GENRES.includes(genre))problems.push(`"genre" phải là một trong: ${GENRES.join('; ')}`);
 const domain=value.domain??'general';if(!DOMAINS.includes(domain))problems.push(`"domain" phải là một trong: ${DOMAINS.join(', ')}`);
 const publishSource=value.publishSource??'excerpt';if(!PUBLISH_SOURCES.includes(publishSource))problems.push('"publishSource" phải là "excerpt" (bìa và các trang đã dịch) hoặc "full" (cả tệp gốc)');
 const source=value.source??'source.pdf';if(typeof source!=='string'||!/\.pdf$/iu.test(source)||/[\\/]/u.test(source))problems.push('"source" phải là tên tệp .pdf nằm ngay trong thư mục ví dụ mẫu');
 const ranges=value.ranges??[];
 if(!Array.isArray(ranges)||ranges.some(r=>typeof r!=='string'||!RANGE.test(r)))problems.push('"ranges" phải là danh sách phạm vi trang, ví dụ ["5-9", "12"] (mỗi mục là một phần)');
 else if(need.includes('ranges')&&!ranges.length)problems.push('"ranges" chưa có trang nào để dịch');
 const cover=value.cover??'auto';if(!(cover==='auto'||cover==='none'||Number.isInteger(cover)&&cover>=1))problems.push('"cover" phải là "auto", "none" hoặc số trang bìa');
 const translateCover=value.translateCover??false;if(typeof translateCover!=='boolean')problems.push('"translateCover" phải là true hoặc false');
 let glossary={};try{glossary=validGlossary(value.glossary,'"glossary"');}catch(error){problems.push(error.message);}
 const rights=value.rights??{};if(!rights||typeof rights!=='object'||Array.isArray(rights))problems.push('"rights" phải là {"confirmed": true, "note": "…"}');
 else if(rights.localOnly!==undefined&&typeof rights.localOnly!=='boolean')problems.push('"rights.localOnly" phải là true hoặc false');
 // localOnly: a book the owner may not publish (still under copyright) can be shown only on this machine's own server.
 else if(publishing&&rights.confirmed!==true&&rights.localOnly!==true)problems.push('"rights.confirmed" phải là true: chủ sách xác nhận được phép công bố các trang gốc và bản dịch này (hoặc "localOnly": true để chỉ đăng lên máy chủ trên máy này)');
 if(problems.length)throw new Error(`sample.json của "${slug}" chưa hợp lệ:\n- ${problems.join('\n- ')}`);
 return {slug,title,author,genre,domain,source,ranges:Array.isArray(ranges)?ranges.map(r=>r.trim()):[],cover,translateCover,publishSource,glossary,rights:{confirmed:rights.confirmed===true,localOnly:rights.localOnly===true,note:typeof rights.note==='string'?rights.note.slice(0,1000):''}};
}
