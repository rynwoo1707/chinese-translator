// Library books (stories without an owner) beyond their parts: the original PDF the parts translate, kept under
// library/<story>/sources/, so any reader can rebuild a book like the original ("Tải cả quyển") and read each page beside
// its source. A sample is such a book marked source_url 'sample:<slug>': a demonstration the operator publishes with
// tools/samples, translated without Gemini. It never has a job, so nothing ever calls it reviewed by a teacher.
import {fileDisposition} from './download-filename.js';
import {json,UserError} from './http.js';
import {removeFile} from './study-history.js';

export const SAMPLE_PREFIX='sample:';
const SHA=/^[a-f\d]{64}$/u,SLUG=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/u;
// The folder name of samples/<slug>/ in the sample tool: lowercase letters, digits and inner hyphens, 2-64 characters.
export const validSlug=value=>typeof value==='string'&&SLUG.test(value);
export const isSampleBook=story=>String(story?.source_url||'').startsWith(SAMPLE_PREFIX);
export const librarySourceKey=(storyId,sha256)=>`library/${storyId}/sources/${sha256}.pdf`;
const MAX_SOURCE=100*1024*1024,MAX_PAGES=100000,MAX_PART_PAGES=1000;
const stat=(env,key)=>env.FILES.head?env.FILES.head(key):env.FILES.get(key);
const missingColumn=error=>/no such column/iu.test(String(error?.message||''));
const NOT_FOUND='Không tìm thấy sách trong thư viện.';

// An original can be an excerpt of the printed book (a sample keeps only its cover and translated pages): X-Book-Pages
// then gives the book's page number of each page of the file, as runs ("1,7-10"). It is kept with the file, so the
// reader and "Tải cả quyển" name pages of the book, not places in the excerpt. Distinct pages, 1,000 characters at most.
export function bookPageList(value){
 const text=String(value??'').replace(/\s/gu,'');if(!text||text.length>1000||!/^\d{1,6}(?:-\d{1,6})?(?:,\d{1,6}(?:-\d{1,6})?)*$/u.test(text))return null;
 const pages=[];
 for(const run of text.split(',')){const [start,end=start]=run.split('-').map(Number);if(start<1||end<start||end>MAX_PAGES||pages.length+end-start>=MAX_PAGES)return null;for(let page=start;page<=end;page++)pages.push(page);}
 return new Set(pages).size===pages.length?pages:null;
}
export const pageRuns=pages=>{const out=[];for(let i=0;i<pages.length;i++){const start=pages[i];while(pages[i+1]===pages[i]+1)i++;out.push(start===pages[i]?String(start):`${start}-${pages[i]}`);}return out.join(',');};
const storedBookPages=object=>object?.customMetadata?.bookPages?bookPageList(object.customMetadata.bookPages):null;
// 1-based pages of the stored original in the order of the part's own pages: distinct, inside the file, 1,000 at most.
export function pageList(value,total){
 let pages=value;if(typeof pages==='string')try{pages=JSON.parse(pages);}catch{return null;}
 if(!Array.isArray(pages)||!pages.length||pages.length>MAX_PART_PAGES)return null;
 return pages.every(page=>Number.isInteger(page)&&page>=1&&page<=total)&&new Set(pages).size===pages.length?pages:null;
}
export function chapterPosition(value){
 if(value===null||value===undefined||value==='')return null;const position=Number(value);
 if(!Number.isInteger(position)||position<1||position>100000)throw new UserError('Vị trí của phần phải là số nguyên từ 1 đến 100.000.');
 return position;
}
// The original a new PDF part translates (form fields source_sha256 and source_pages, both or neither), as chapter
// columns. Page count and file name come from the stored original, never from the form.
export async function chapterSource(env,story,form,mime){
 const sha=form.get('source_sha256'),pages=form.get('source_pages');
 if((sha===null||sha==='')&&(pages===null||pages===''))return null;
 if(story.owner_user_id)throw new UserError('Chỉ sách trong kho Hoa Trí mới gắn được với trang của PDF gốc.');
 if(mime!=='application/pdf')throw new UserError('Chỉ phần PDF mới gắn được với trang của PDF gốc.');
 const sha256=String(sha||'').toLowerCase();if(!SHA.test(sha256))throw new UserError('Mã SHA-256 của PDF gốc không hợp lệ.');
 const object=await stat(env,librarySourceKey(story.id,sha256));if(!object)throw new UserError('Hãy tải PDF gốc của sách lên trước.',409);
 const total=Number(object.customMetadata?.pages)||0,list=total?pageList(String(pages||''),total):null;
 if(!list)throw new UserError(`Danh sách trang không hợp lệ: cần các số trang khác nhau, từ 1 đến ${total||'số trang của PDF gốc'}.`);
 return {source_sha256:sha256,source_pages:JSON.stringify(list),source_total_pages:total,source_filename:object.customMetadata?.filename||null};
}

// The public library, samples first. A database without migration 0015 has no page columns yet: the list still works.
export async function libraryRows(env,genres){
 const pages="COALESCE(SUM(CASE WHEN c.mime='application/pdf' AND c.source_pages IS NOT NULL THEN 1 ELSE 0 END),0) AS mapped_parts,COALESCE(SUM(CASE WHEN c.mime='application/pdf' AND json_valid(c.source_pages) THEN json_array_length(c.source_pages) ELSE 0 END),0) AS translated_pages";
 const query=columns=>env.DB.prepare(`SELECT s.id,s.title,s.author,s.genre,s.cover_key,s.source_url,CASE WHEN s.source_url LIKE '${SAMPLE_PREFIX}%' THEN 1 ELSE 0 END AS sample,COUNT(c.id) AS chapters,${columns},(SELECT status FROM jobs j WHERE j.story_id=s.id ORDER BY j.created_at DESC LIMIT 1) AS translation_status FROM stories s LEFT JOIN chapters c ON c.story_id=s.id WHERE s.visibility='public' AND s.genre IN (${genres.map(()=>'?').join(',')}) GROUP BY s.id ORDER BY sample DESC,s.created_at DESC`).bind(...genres).all();
 try{return (await query(pages)).results;}catch(error){if(!missingColumn(error))throw error;return (await query('0 AS mapped_parts,0 AS translated_pages')).results;}
}
// Whether migration 0015 is applied. It never fails: the admin status answer must not depend on the database.
export async function bookPagesReady(env){try{await env.DB.prepare('SELECT source_pages FROM chapters LIMIT 0').all();return true;}catch{return false;}}
// A book's parts for the reader, each with the original pages it translates (source_pages as an array) when it has them.
export async function readChapters(env,storyId){
 const query=columns=>env.DB.prepare(`SELECT id,title,content,mime,text_key,source_url,position${columns} FROM chapters WHERE story_id=? ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END,position,created_at,id`).bind(storyId).all();
 let rows;try{rows=(await query(',source_sha256,source_pages,source_total_pages')).results;}catch(error){if(!missingColumn(error))throw error;rows=(await query('')).results;}
 return rows.map(row=>{const pages=pageList(row.source_pages,row.source_total_pages||MAX_PAGES);return {...row,source_sha256:pages?row.source_sha256:null,source_pages:pages,source_total_pages:pages?row.source_total_pages:null};});
}

// Drafts and students' own books are not in the library: they answer like a book that does not exist (admin excepted).
async function libraryBook(env,id,admin){
 const story=await env.DB.prepare('SELECT id,title,visibility,source_url,cover_key,cover_page,cover_source_sha256 FROM stories WHERE id=? AND owner_user_id IS NULL').bind(id).first();
 return story&&(story.visibility==='public'||admin)?story:null;
}
// The shape of a student's book assembly (study-books.js), so the reader rebuilds either kind the same way.
export async function publicAssembly(env,story){
 const rows=(await env.DB.prepare('SELECT id,title,position,mime,source_sha256,source_pages,source_total_pages,source_filename,created_at FROM chapters WHERE story_id=? ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END,position,created_at,id').bind(story.id).all()).results;
 const parts=rows.map(row=>{
  const pdf=row.mime==='application/pdf',pages=pdf?pageList(row.source_pages,row.source_total_pages||MAX_PAGES):null;
  return {id:row.id,title:row.title,position:row.position??null,mime:row.mime||'text/plain',sessionId:null,filename:pages?row.source_filename||'':'',pageStart:pages?Math.min(...pages):null,pageEnd:pages?Math.max(...pages):null,totalPages:pages?row.source_total_pages:null,sha256:pages?row.source_sha256:null,pages,updatedAt:row.created_at||null,translatedAt:row.created_at||null,layout:pdf,file:pdf?`/api/chapter-file/${encodeURIComponent(row.id)}`:null};
 });
 const storedSources=[];
 for(const sha256 of new Set(parts.map(part=>part.sha256).filter(Boolean))){
  const object=await stat(env,librarySourceKey(story.id,sha256));if(!object)continue;
  const pages=Number(object.customMetadata?.pages)||null,book=storedBookPages(object);
  storedSources.push({sha256,pages,url:`/api/library/${encodeURIComponent(story.id)}/sources/${sha256}`,...(book&&book.length===pages?{bookPages:book}:{})});
 }
 // An excerpt's book pages also follow each part: its pages of the file, as page numbers of the printed book.
 for(const part of parts){const book=storedSources.find(source=>source.sha256===part.sha256)?.bookPages,mapped=book&&part.pages?part.pages.map(page=>book[page-1]):null;if(mapped?.every(Number.isInteger))part.bookPages=mapped;}
 return {id:story.id,title:story.title,sample:isSampleBook(story),cover:{image:Boolean(story.cover_key),page:story.cover_page??null,sha256:story.cover_source_sha256||null},parts,storedSources};
}
// One byte range of the original: pdf.js reads a large file in pieces, so "Đọc song ngữ" never downloads it all.
function byteRange(header){
 const match=/^bytes=(\d*)-(\d*)$/u.exec(String(header||'').trim());if(!match||!match[1]&&!match[2])return null;
 if(!match[1])return {suffix:Number(match[2])};
 const offset=Number(match[1]);return match[2]?(Number(match[2])>=offset?{offset,length:Number(match[2])-offset+1}:null):{offset};
}
async function sourceResponse(request,env,story,sha256){return rangedPdfResponse(request,env,librarySourceKey(story.id,sha256),'Sách này không có PDF gốc đó.');}
// A stored PDF answered whole or as one byte range, so pdf.js (disableAutoFetch, disableStream) downloads only the pages
// it shows. disposition: the Content-Disposition of a file whose name is not in its metadata (a translated part).
export async function rangedPdfResponse(request,env,key,missing,{disposition=null}={}){
 const range=byteRange(request.headers.get('Range'));let object;
 try{object=await env.FILES.get(key,range?{range}:undefined);}
 catch(error){if(range)return new Response(null,{status:416,headers:{'Content-Range':'bytes */*'}});throw error;}
 if(!object)return json({error:missing},404);
 const headers={'Content-Type':'application/pdf','Content-Disposition':disposition||fileDisposition(object.customMetadata?.filename||'nguyen-tac.pdf',{fallback:'nguyen-tac.pdf'}),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
 const size=Number(object.size);if(!range||!Number.isFinite(size))return new Response(object.body,{headers});
 const start=range.suffix!==undefined?Math.max(0,size-range.suffix):range.offset,end=range.length!==undefined?Math.min(size,start+range.length)-1:size-1;
 if(start>=size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
 return new Response(object.body,{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${size}`}});
}
export async function libraryPublicRoute(request,env,path,admin){
 const match=path.match(/^\/api\/library\/([^/]+)\/(?:(assembly)|sources\/([^/]*))$/u);if(!match)return null;
 if(request.method!=='GET')return json({error:'Phương thức không được hỗ trợ.'},405);
 if(!match[2]&&!SHA.test(match[3]))return json({error:'Mã tệp không hợp lệ.'},400);
 const story=await libraryBook(env,match[1],admin);if(!story)return json({error:NOT_FOUND},404);
 return match[2]?json(await publicAssembly(env,story)):sourceResponse(request,env,story,match[3]);
}

async function listSources(env,storyId){
 const prefix=`library/${storyId}/sources/`,sources=[];let cursor;
 do{
  const page=await env.FILES.list({prefix,include:['customMetadata'],...(cursor?{cursor}:{})});
  for(const object of page.objects){const sha256=object.key.slice(prefix.length).replace(/\.pdf$/u,''),book=storedBookPages(object);if(SHA.test(sha256))sources.push({sha256,pages:Number(object.customMetadata?.pages)||null,filename:object.customMetadata?.filename||'',size:object.size??null,...(book?{bookPages:book}:{})});}
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor);
 return sources;
}
// Stored once per book and file. A body with its length is streamed into storage and R2 checks it against the hash;
// one without is read first (http.js caps it). The first kilobyte must then show a PDF. The same file is stored again
// only to record book pages it did not have (R2 keeps metadata with the object); the bytes are the same.
async function putSource(request,env,story,sha256,key){
 const pages=Number(request.headers.get('X-PDF-Pages'));
 if(!Number.isInteger(pages)||pages<1||pages>MAX_PAGES)return json({error:'Thiếu số trang hợp lệ của PDF gốc (X-PDF-Pages).'},400);
 let filename;try{filename=decodeURIComponent(request.headers.get('X-Source-Filename')||'').normalize('NFC').trim();}catch{filename=null;}
 if(filename===null||filename.length>240||/[\u0000-\u001f\u007f]/u.test(filename))return json({error:'Tên tệp gốc không hợp lệ.'},400);
 filename||='nguyen-tac.pdf';
 const bookHeader=request.headers.get('X-Book-Pages'),book=bookHeader?bookPageList(bookHeader):null;
 if(bookHeader&&(!book||book.length!==pages))return json({error:`Số trang trong sách (X-Book-Pages) không hợp lệ: cần ${pages} số trang khác nhau, mỗi số một trang của PDF gốc, viết gọn (như 1,7-10) trong 1.000 ký tự.`},400);
 const runs=book?pageRuns(book):null,existing=await stat(env,key);
 if(existing&&(!runs||existing.customMetadata?.bookPages===runs)){const kept=storedBookPages(existing);return json({sha256,pages:Number(existing.customMetadata?.pages)||pages,filename:existing.customMetadata?.filename||filename,stored:false,...(kept?{bookPages:kept}:{})});}
 const declared=request.headers.get('Content-Length');
 if(declared!==null&&Number(declared)>MAX_SOURCE)return json({error:'PDF gốc tối đa 100 MB.',code:'too_large'},413);
 if(!request.body||declared==='0')return json({error:'Chưa có nội dung PDF gốc.'},400);
 const body=declared!==null?request.body:await request.arrayBuffer();
 try{await env.FILES.put(key,body,{sha256,httpMetadata:{contentType:'application/pdf'},customMetadata:{filename,pages:String(pages),...(runs?{bookPages:runs}:{})}});}
 catch(error){if(/checksum|digest|10037/iu.test(String(error?.message||'')))return json({error:'Mã SHA-256 không khớp nội dung tệp.'},400);throw error;}
 const head=await env.FILES.get(key,{range:{offset:0,length:1024}}),start=head?new Uint8Array(await head.arrayBuffer()).slice(0,1024):new Uint8Array();
 if(!new TextDecoder().decode(start).includes('%PDF-')){await removeFile(env,key);return json({error:'Tệp gửi lên không phải PDF.'},400);}
 return json({sha256,pages,filename,stored:!existing,...(book?{bookPages:book}:{})},existing?200:201);
}
// An original a part still uses stays; a cover chosen from it forgets its page.
async function deleteSource(env,story,sha256,key){
 if(await env.DB.prepare('SELECT 1 FROM chapters WHERE story_id=? AND source_sha256=? LIMIT 1').bind(story.id,sha256).first())return json({error:'Còn phần sách dùng PDF gốc này; hãy xóa phần đó trước.'},409);
 if(story.cover_source_sha256===sha256)await env.DB.prepare('UPDATE stories SET cover_page=NULL,cover_source_sha256=NULL WHERE id=? AND cover_source_sha256=?').bind(story.id,sha256).run();
 await env.FILES.delete(key);return json({ok:true});
}
// Admin only: the originals of a library book, listed, checked (HEAD), stored (PUT) and removed (DELETE).
export async function libraryAdminRoute(request,env,path){
 const match=path.match(/^\/api\/stories\/([^/]+)\/sources(?:\/([^/]*))?$/u);if(!match)return null;
 const story=await env.DB.prepare('SELECT id,owner_user_id,cover_source_sha256 FROM stories WHERE id=?').bind(match[1]).first();
 if(!story||story.owner_user_id)return json({error:'Không tìm thấy sách trong kho Hoa Trí.'},404);
 if(match[2]===undefined)return request.method==='GET'?json({sources:await listSources(env,story.id)}):json({error:'Phương thức không được hỗ trợ.'},405);
 const sha256=match[2],key=librarySourceKey(story.id,sha256);if(!SHA.test(sha256))return json({error:'Mã SHA-256 không hợp lệ.'},400);
 if(request.method==='HEAD'){const object=await stat(env,key),book=storedBookPages(object);return new Response(null,{status:object?200:404,headers:object?{'X-PDF-Pages':String(Number(object.customMetadata?.pages)||''),'X-Source-Filename':encodeURIComponent(object.customMetadata?.filename||''),...(book?{'X-Book-Pages':pageRuns(book)}:{})}:{}});}
 if(request.method==='PUT')return putSource(request,env,story,sha256,key);
 if(request.method==='DELETE')return deleteSource(env,story,sha256,key);
 return json({error:'Phương thức không được hỗ trợ.'},405);
}
