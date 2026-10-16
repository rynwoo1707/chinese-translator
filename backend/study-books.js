// Students' own books beyond their parts: the original PDF each range came from, the book cover, and what the browser
// needs to rebuild the whole book like the original (every page, the cover and untranslated pages from the original).
import {saveCover} from './covers.js';
import {fileDisposition} from './download-filename.js';
import {ownedBook,listBooks,storedRange,rangeStatement,publicPart,removeFile} from './study-history.js';

const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const SHA=/^[a-f\d]{64}$/u;
// One copy of each uploaded original per student and file. The key is built from the reader's own id, so a hash can
// only ever name a file in that reader's folder.
export const sourceKey=(userId,sha256)=>`study/${userId}/sources/${sha256}.pdf`;
const stat=async(env,key)=>env.FILES.head?env.FILES.head(key):env.FILES.get(key),exists=async(env,key)=>Boolean(await stat(env,key));
export async function keepSource(env,userId,sha256,file,{filename='',pages=null}={}){
 if(!SHA.test(sha256||''))return false;const key=sourceKey(userId,sha256);if(await exists(env,key))return false;
 await env.FILES.put(key,file,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:String(filename||'').slice(0,240),pages:String(pages||'')}});return true;
}
// '' or missing: no page; 0: the student chose no cover; 1..: a page of the uploaded file.
function coverPage(value){
 if(value===null||value===undefined||value==='')return null;const page=Number(value);
 return Number.isInteger(page)&&page>=0&&page<=100000?page:undefined;
}

export async function studyBookRoute(request,env,path,reader){
 const source=path.match(/^\/api\/my\/study\/sources\/([^/]*)$/u);
 if(source){
  if(request.method!=='GET')return reply({error:'Phương thức không được hỗ trợ.'},405);
  if(!SHA.test(source[1]))return reply({error:'Mã tệp không hợp lệ.'},400);
  const object=await env.FILES.get(sourceKey(reader.id,source[1]));if(!object)return reply({error:'Tài khoản chưa lưu PDF gốc này.'},404);
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':fileDisposition(object.customMetadata?.filename||'nguyen-tac.pdf',{fallback:'nguyen-tac.pdf'}),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 const match=path.match(/^\/api\/my\/study\/books\/([^/]+)\/(cover|assembly)$/u);if(!match)return null;
 const book=await ownedBook(env,reader.id,match[1]);if(!book)return reply({error:'Không tìm thấy sách trong Thư viện riêng.'},404);
 if(match[2]==='assembly'&&request.method==='GET')return reply(await assembly(env,reader,book));
 if(match[2]==='cover'&&request.method==='POST')return uploadCover(request,env,reader,book);
 if(match[2]==='cover'&&request.method==='PATCH')return chooseCover(request,env,reader,book);
 return reply({error:'Phương thức không được hỗ trợ.'},405);
}

async function uploadCover(request,env,reader,book){
 const form=await request.formData(),page=coverPage(form.get('page')),sha256=String(form.get('sha256')||'').toLowerCase();
 if(page===undefined||page===0||sha256&&!SHA.test(sha256))return reply({error:'Trang bìa hoặc mã tệp không hợp lệ.'},400);
 const current=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=? AND owner_user_id=?').bind(book.id,reader.id).first();
 // A cover the book already has is replaced only when the student confirmed it.
 if(current?.cover_key&&form.get('replace')!=='1')return reply({error:'Sách đã có ảnh bìa; ảnh hiện tại được giữ nguyên.',hasCover:true},409);
 const key=await saveCover(form.get('cover'),book.id,env);
 // Compare-and-set on the old key: two tabs saving at once cannot both win, and the loser's image is removed. So is the
 // image of a write that failed, or every retry after a database error would leave one more image nothing points to.
 let updated;
 try{updated=await env.DB.prepare('UPDATE stories SET cover_key=?,cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=? AND cover_key IS ?').bind(key,page,sha256||null,book.id,reader.id,current?.cover_key??null).run();}
 catch(error){await removeFile(env,key);throw error;}
 if(!updated?.meta?.changes){await removeFile(env,key);return reply({error:'Ảnh bìa vừa được đổi ở nơi khác. Hãy tải lại trang rồi thử lại.'},409);}
 // The new cover is saved; an old image that cannot be removed now must not report the replacement as failed.
 if(current?.cover_key?.startsWith('covers/'))await removeFile(env,current.cover_key);
 return reply({id:book.id,cover:{image:true,page,sha256:sha256||null}});
}
// Remembers which page of a file is the cover (or that it has none) without touching the cover image.
async function chooseCover(request,env,reader,book){
 const body=await request.json().catch(()=>({})),page=coverPage(body?.page),sha256=String(body?.sha256||'').toLowerCase();
 if(page===undefined||page===null||sha256&&!SHA.test(sha256))return reply({error:'Trang bìa hoặc mã tệp không hợp lệ.'},400);
 await env.DB.prepare('UPDATE stories SET cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=?').bind(page,sha256||null,book.id,reader.id).run();
 const row=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=? AND owner_user_id=?').bind(book.id,reader.id).first();
 return reply({id:book.id,cover:{image:Boolean(row?.cover_key),page,sha256:sha256||null}});
}

async function assembly(env,reader,book){
 const [listed]=await listBooks(env,reader.id,book.id),parts=listed?.parts||[],statements=[];let budget=12;
 // Ranges saved before page lists existed read theirs back from the saved manifest once; a few per request bound the cost.
 // A text part with pages but no page list was read in the browser (no manifest), and a DOCX or EPUB part never has one.
 for(const part of parts){
  const older=part.mime==='application/pdf'||!part.pageStart&&/\.pdf$/iu.test(part.filename||'');
  if(part.pages||!older||!part.sessionId||!part.stateKey||budget<=0)continue;budget--;
  const range=await storedRange(env,reader.id,part.stateKey).catch(()=>null);if(!range)continue;
  Object.assign(part,{pageStart:range.start,pageEnd:range.end,totalPages:part.totalPages??range.total,sha256:part.sha256||range.sha256,pages:range.pages});statements.push(rangeStatement(env,reader.id,part.sessionId,range));
 }
 if(statements.length)await env.DB.batch(statements);
 const storedSources=[];
 for(const sha256 of new Set(parts.map(part=>part.sha256).filter(Boolean))){const object=await stat(env,sourceKey(reader.id,sha256));if(object)storedSources.push({sha256,pages:Number(object.customMetadata?.pages)||null,url:`/api/my/study/sources/${sha256}`});}
 // layout: translated with "Giữ bố cục PDF", so the part has (or can export) Vietnamese PDF pages; a text translation
 // (a PDF range read in the browser, a DOCX chapter…) has none, and only redoing the range in layout mode adds them.
 return {id:book.id,title:listed?.title||book.title,cover:listed?.cover||{image:false,page:null,sha256:null},parts:parts.map(part=>({...publicPart(part),layout:Boolean(part.pages)||part.mime==='application/pdf',file:part.mime==='application/pdf'?`/api/chapter-file/${encodeURIComponent(part.id)}`:null})),storedSources};
}
