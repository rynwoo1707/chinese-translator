import {normalizeVietnameseText} from './vietnamese-text.js';
import {validateBlockTranslations} from '../frontend/pdf-box-layout.js';
import {logEvent,routeLabel,UserError} from './http.js';
import {rateLimit,dailyMax} from './rate-limit.js';
import {readJsonShape} from './json-shape.js';
// account.js imports this module too; its helpers are read when called, never while the modules load.
import * as account from './account.js';

import {SUBJECT_LABELS as DOMAINS} from './subject-glossaries.js';
import {DEFAULT_MODE,isMode,LAYOUT_VERSION,layoutStamp} from '../frontend/translation-modes.js';
// study_sessions.domain still has the CHECK of migration 0011; newer subjects live in the subject column (0017).
const CHECKED_DOMAINS=new Set(['general','math','history']);
// study_sessions.mode has that CHECK too: a newer mode ("Kỹ nhất", premium) is stored there as quality, and as itself in
// the engine column (0026). Rows saved before 0026 have no engine, and a version from before it (after a rollback) saves
// mode alone, leaving engine as it was: so engine counts only while mode still holds the value saved beside it.
const CHECKED_MODES=new Set(['economy','balanced','quality']);
const legacyMode=mode=>CHECKED_MODES.has(mode)?mode:'quality';
const storedMode=(mode,engine)=>isMode(engine)&&legacyMode(engine)===mode?engine:mode;
// A save without a mode (a page from before modes existed) is economy; a mode this server does not know is refused
// rather than stored as another one.
function historyMode(value){
 if(value===undefined||value===null||value==='')return DEFAULT_MODE;
 if(!isMode(value))throw new UserError('Cách dịch không hợp lệ. Hãy tải lại trang rồi thử lại.',400,'bad_mode');
 return value;
}
const MAX_SOURCE=2_000_000,MAX_TRANSLATION=3_000_000,PREVIEW=1200;
// The parts of one session: a PDF range has one per block, and one extraction may hold up to 3,000 blocks
// (frontend/pdf-box-layout.js); a text session has far fewer.
export const MAX_PARTS=3000;
// A book's terms (UTF-8 bytes of JSON in its D1 row) grow with every range added to it; past this size new terms are no
// longer added. Every item an account saves can start a book, so this bounds what an account's history puts in D1.
export const MAX_BOOK_GLOSSARY=131072;
const MB=1024*1024,number=value=>new Intl.NumberFormat('vi-VN').format(value);
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const stateKey=(userId,id)=>`study/${userId}/${id}/state.json`;
const translationKey=(userId,id)=>`study/${userId}/${id}/translation.txt`;
const assetFolder=(userId,assetId)=>`study/${userId}/pdf-layout/${assetId}/`;
// One copy of each uploaded original per student and file. The key is built from the reader's own id, so a hash can
// only ever name a file in that reader's folder.
export const sourceKey=(userId,sha256)=>`study/${userId}/sources/${sha256}.pdf`;
const UUID=/^[a-f\d-]{36}$/iu;
// Books a student may add to, reorder or delete: their own study stories, never admin, request or web books.
const STUDY_BOOK="(source_url LIKE 'study:%' OR source_url LIKE 'study-book:%')";
// Reader glossaries are edited by hand elsewhere; a malformed value must not make json_patch fail a save.
const jsonObject=column=>`CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column})='object' THEN ${column} ELSE '{}' END ELSE '{}' END`;
// A book's terms with another set merged in, unless that would pass MAX_BOOK_GLOSSARY: then the book keeps the terms it has.
const boundedPatch=(base,patch)=>`CASE WHEN length(CAST(json_patch(${base},${patch}) AS BLOB))<=${MAX_BOOK_GLOSSARY} THEN json_patch(${base},${patch}) ELSE ${base} END`;
const validSha=value=>typeof value==='string'&&/^[a-f\d]{64}$/u.test(value)?value:null;

function cleanObject(value,limit=500){
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value).filter(([key,item])=>!['__proto__','constructor','prototype'].includes(key)&&key.length<=100&&typeof item==='string'&&item.length<=100).slice(0,limit));
}
// A list of texts, refused with the reason when it cannot be saved as it is (never shortened or dropped in silence).
function textArray(value,maxTotal,tooMany){
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value))throw new UserError('Dữ liệu lịch sử bản dịch không hợp lệ. Hãy tải lại trang rồi thử lại.',400,'history_invalid');
 tooMany(value.length);
 let total=0;const result=[];for(const item of value){const text=typeof item==='string'?item:'';total+=text.length;if(total>maxTotal)throw new Error('Lịch sử bản dịch vượt giới hạn lưu trữ.');result.push(text);}return result;
}
// What the browser keeps with a layout session besides its asset (frontend/study.js): the blocks the student translated by
// hand (edited: their IDs, which no run sends again; an empty list still says the session records them), those that may
// be hand edits saved before they were recorded (legacy: never sent again either), the problems of the drafts it holds
// (review: id -> 'han', 'rows' or 'numbers', which a reload still names) and, for a refreshed copy, how many translated
// blocks it kept of the part it takes over (carried: {before, kept}). The save keeps only IDs of the session's own blocks.
const BLOCK_ID=/^[\w.:-]{1,64}$/u,PROBLEMS=new Set(['han','rows','numbers']);
function layoutMarks(layout,count){
 const ids=list=>Array.isArray(list)?[...new Set(list.filter(id=>typeof id==='string'&&BLOCK_ID.test(id)))].slice(0,count):null,edited=ids(layout.edited),legacy=ids(layout.legacy);
 const review=layout.review&&typeof layout.review==='object'&&!Array.isArray(layout.review)?Object.fromEntries(Object.entries(layout.review).filter(([id,list])=>BLOCK_ID.test(id)&&Array.isArray(list)).map(([id,list])=>[id,[...new Set(list.filter(item=>PROBLEMS.has(item)))]]).filter(([,list])=>list.length).slice(0,count)):{};
 const amount=value=>Number.isInteger(value)&&value>=0&&value<=MAX_PARTS?value:null,before=amount(layout.carried?.before),kept=amount(layout.carried?.kept);
 return {...(edited?{edited}:{}),...(legacy?.length?{legacy}:{}),...(Object.keys(review).length?{review}:{}),...(before!==null&&kept!==null?{carried:{before,kept}}:{})};
}
function normalizeState(body){
 const source=String(body.source||'');if(!source.trim()||source.length>MAX_SOURCE)throw new Error('Nguyên tác trong lịch sử phải từ 1 đến 2 triệu ký tự.');
 const parts=textArray(body.parts,MAX_SOURCE,count=>{if(count>MAX_PARTS)throw new UserError(`Bản dịch có ${number(count)} phần, nhiều hơn mức ${number(MAX_PARTS)} phần của một lần lưu. Hãy chọn khoảng trang ngắn hơn rồi dịch lại.`,413,'too_many_parts');}),compact=value=>value.replace(/\s/gu,'');
 if(!parts.length||compact(parts.join(''))!==compact(source))throw new Error('Các phần dịch không khớp nguyên tác.');
 const translationParts=textArray(body.translationParts,MAX_TRANSLATION,count=>{if(count>parts.length)throw new UserError(`Bản dịch có ${number(count)} phần trong khi nguyên tác có ${number(parts.length)} phần. Hãy tải lại trang rồi thử lại.`,400,'history_invalid');}),done=Math.max(0,Math.min(parts.length,Number.isInteger(body.done)?body.done:0));
 while(translationParts.length<parts.length)translationParts.push('');
 const translation=normalizeVietnameseText(translationParts.filter(Boolean).join('\n\n')).trim();
 const complete=done===parts.length&&parts.length>0&&translationParts.every(item=>item.trim());
 const pdfLayout=body.pdfLayout&&/^[a-f\d-]{36}$/iu.test(body.pdfLayout.assetId||'')?{assetId:body.pdfLayout.assetId,...layoutMarks(body.pdfLayout,parts.length)}:null;
 // notes (a text session): what the checks still found in its parts, "Trang N · đoạn k: …", named again when the session
 // is opened again (frontend/study.js); the last 200, each cut to 500 characters. Anything else is left out.
 const notes=Array.isArray(body.notes)?body.notes.filter(note=>typeof note==='string'&&note.trim()).slice(-200).map(note=>note.slice(0,500)):[];
 return {version:1,source,parts,translationParts:translationParts.map(normalizeVietnameseText),done,context:String(body.context||'').slice(-1200),glossary:cleanObject(body.glossary),manualGlossary:cleanObject(body.manualGlossary),previousSource:String(body.previousSource||'').slice(-350),previousTranslation:normalizeVietnameseText(String(body.previousTranslation||'')).slice(-500),translation,complete,...(notes.length&&!pdfLayout?{notes}:{}),...(pdfLayout?{pdfLayout}:{})};
}
function cleanTitle(value,filename){
 const title=(String(value||'').trim()||String(filename||'').replace(/\.[^.]+$/u,'').trim()||'Bản dịch chưa đặt tên').normalize('NFC');
 if(title.length>200||/[\u0000-\u001f\u007f]/u.test(title))throw new Error('Tên lịch sử không hợp lệ.');return title;
}
const cleanFilename=value=>{const filename=String(value||'').trim();if(filename.length>260||/[\r\n\0]/u.test(filename))throw new Error('Tên tệp không hợp lệ.');return filename;};
async function existingSession(env,id,userId){return env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(id,userId).first();}

// Room for an account's history: accounts cost nothing to make, so neither the number of items nor what they store may
// grow without bound. MAX_HISTORY_PER_USER (default 300 items), MAX_HISTORY_MB_PER_USER (default 500 MB of saved state
// and text) and DAILY_HISTORY_PER_USER (default 150 new items a day) set it; 0 turns a limit off. A save that does not
// grow an item, and every save of an item into the room it already has, always passes: deleting items frees room.
const utf8Length=text=>{let bytes=0;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);if(code<0x80)bytes++;else if(code<0x800)bytes+=2;else if(code>=0xd800&&code<0xdc00){bytes+=4;i++;}else bytes+=3;}return bytes;};
// Items saved before migration 0023 have no stored size: the state holds the source twice and the translation three times.
const STORED_SIZE='CASE WHEN stored_bytes>0 THEN stored_bytes ELSE 6*source_characters+4*translation_characters END';
const storedSize=row=>Number(row?.stored_bytes)>0?Number(row.stored_bytes):6*(Number(row?.source_characters)||0)+4*(Number(row?.translation_characters)||0);
const sizeLabel=bytes=>bytes>=10*MB?`${number(Math.round(bytes/MB))} MB`:`${(bytes/MB).toFixed(1).replace('.',',')} MB`;
const roomLimits=env=>({maxItems:dailyMax(env,'MAX_HISTORY_PER_USER',300),maxBytes:dailyMax(env,'MAX_HISTORY_MB_PER_USER',500)*MB});
// refused: the room guard already refused this new item inside its save's transaction (see roomGuard). Room freed since
// (an item deleted in another tab meanwhile) does not undo that refusal, so the save is answered as full all the same.
async function historyRoom(env,userId,existing,bytes,refused=false){
 const {maxItems,maxBytes}=roomLimits(env),previous=existing?storedSize(existing):0;
 if(!maxItems&&!maxBytes||existing&&bytes<=previous)return null;
 const row=await env.DB.prepare(`SELECT COUNT(*) AS items,COALESCE(SUM(${STORED_SIZE}),0) AS bytes FROM study_sessions WHERE user_id=?`).bind(userId).first();
 const items=Number(row?.items)||0,used=Number(row?.bytes)||0,full=reason=>reply({error:`${reason} Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.`,code:'history_full',items,maxItems,bytes:used,maxBytes},413);
 if(!existing&&maxItems&&items>=maxItems)return full(`Lịch sử dịch của tài khoản đã có ${number(items)} bản dịch, mức tối đa cho mỗi tài khoản.`);
 if(maxBytes&&used-previous+bytes>maxBytes)return full(`Lịch sử dịch của tài khoản đã chiếm ${sizeLabel(used)}; lưu bản dịch này (${sizeLabel(bytes)}) sẽ vượt mức ${sizeLabel(maxBytes)} cho mỗi tài khoản.`);
 return refused?full('Lịch sử dịch của tài khoản vừa đầy lúc lưu bản dịch này, vì một tab hoặc thiết bị khác cũng lưu bản dịch mới cùng lúc.'):null;
}
// The same check for a new item, made inside the save's transaction: saves sent at once all pass historyRoom before any
// of them is written. Run first in the batch, it tries to insert a row the CHECK on status refuses whenever the item
// would not fit, so the whole save fails and nothing of it is kept; an item saved meanwhile under the same id (a save
// sent again) is an update and passes. GUARD_REFUSED tells that failure from others: no other statement of a save can
// break a CHECK, and SQLite (D1 too) names the kind of constraint in its error.
const GUARD_REFUSED=/CHECK constraint failed/iu;
function roomGuard(env,userId,sessionId,bytes){
 const {maxItems,maxBytes}=roomLimits(env);if(!maxItems&&!maxBytes)return null;
 return env.DB.prepare(`INSERT INTO study_sessions(id,user_id,title,state_key,status) SELECT ?1,?2,'','','history_full' WHERE NOT EXISTS (SELECT 1 FROM study_sessions WHERE id=?1) AND (?3>0 AND (SELECT COUNT(*) FROM study_sessions WHERE user_id=?2)>=?3 OR ?4>0 AND (SELECT COALESCE(SUM(${STORED_SIZE}),0) FROM study_sessions WHERE user_id=?2)+?5>?4)`).bind(sessionId,userId,maxItems,maxBytes,bytes);
}
// The terms a save gives its book: the student's own first, then the learned ones, within MAX_BOOK_GLOSSARY.
function bookTerms(state){
 const all=JSON.stringify({...state.glossary,...state.manualGlossary});if(utf8Length(all)<=MAX_BOOK_GLOSSARY)return all;
 const terms={};let bytes=2;
 for(const [key,value] of [...Object.entries(state.manualGlossary),...Object.entries(state.glossary).filter(([key])=>!Object.hasOwn(state.manualGlossary,key))]){
  const size=utf8Length(JSON.stringify(key)+JSON.stringify(value))+2;if(bytes+size>MAX_BOOK_GLOSSARY)break;terms[key]=value;bytes+=size;
 }
 return JSON.stringify(terms);
}
const CONFLICT='Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác. Hãy tải lại bản dịch từ Lịch sử dịch rồi tiếp tục, để không ghi đè phần đã dịch.';
// The history list comes newest first, HISTORY_PAGE items at a time. When more are left the answer carries
// X-Next-Before, a cursor naming the last item (its updated_at and id, opaque to the browser); ?before=<cursor> answers
// the items after it. Keyset paging: an item saved meanwhile moves to the top, so no item is listed twice or skipped.
const HISTORY_PAGE=100;
const pageCursor=row=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([String(row.updated_at),String(row.id)])))).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'');
function readCursor(value){
 try{
  if(typeof value!=='string'||value.length>400||!/^[A-Za-z\d_-]+$/u.test(value))return null;
  const [updatedAt,id,...rest]=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.replace(/-/gu,'+').replace(/_/gu,'/')),c=>c.charCodeAt(0))));
  return typeof updatedAt==='string'&&typeof id==='string'&&!rest.length&&updatedAt.length<=40&&id.length<=100?{updatedAt,id}:null;
 }catch{return null;}
}

// What a history save and a book's page ranges read from a layout manifest: the blocks' ids, sources and formula tokens,
// the page numbers and the extractor's stamps. The manifest's images (most of its up to ~15 MB) are streamed past, never
// held (json-shape.js).
const MANIFEST_SHAPE={totalPages:true,sourceSha256:true,extractionVersion:true,refreshedFrom:true,pages:[{number:true,extractionVersion:true,blocks:[{id:true,source:true,inlines:[{token:true,text:true}]}]}]};
const RANGE_SHAPE={totalPages:true,sourceSha256:true,pages:[{number:true}]};
// What a save compares with the state saved before it: its translations, never its source.
const PRIOR_STATE_SHAPE={pdfLayout:true,translationParts:true};
// A stored object's JSON read with a shape, from its body as storage streams it (a test double may have only text or json).
async function storedShape(object,shape){
 if(object.body!==undefined&&object.body!==null)return readJsonShape(object.body,shape);
 return readJsonShape(typeof object.text==='function'?await object.text():JSON.stringify(await object.json()),shape);
}
// Page numbers count pages of the uploaded file; a range can be a list (12-14, 37), so start/end bound it and pages lists
// it in manifest order, which is also the page order of the rendered PDF.
function manifestRange(manifest){
 const numbers=(manifest?.pages||[]).map(page=>page.number).filter(Number.isInteger);if(!numbers.length)return null;
 return {start:Math.min(...numbers),end:Math.max(...numbers),total:Number.isInteger(manifest.totalPages)?manifest.totalPages:null,sha256:validSha(manifest.sourceSha256),pages:[...new Set(numbers)]};
}
const pageList=value=>{try{const pages=JSON.parse(value||'null');return Array.isArray(pages)&&pages.length&&pages.every(page=>Number.isInteger(page)&&page>0)?pages:null;}catch{return null;}};
// PDFs read in the browser have no manifest; their range only orders the student's own book, so the client's word is enough.
function bodyRange(value){
 if(!value||typeof value!=='object')return null;const {start,end}=value,total=value.total??null;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>100000||total!==null&&(!Number.isInteger(total)||total<end||total>100000))return null;
 return {start,end,total};
}
const pageLabel=range=>range?.start?(range.start===range.end?`Trang ${range.start}`:`Trang ${range.start}–${range.end}`):'';
// A range keeping the book's own name is labelled by its pages, so the table of contents reads Trang 1–20, Trang 21–40…
const partTitle=(title,bookTitle,range)=>title===bookTitle&&pageLabel(range)||title;
const sameSource=(a,b)=>a.sha256&&b.sha256?a.sha256===b.sha256:Boolean(a.filename)&&a.filename===b.filename&&(a.totalPages||null)===(b.totalPages||null);
// Same-file ranges keep page order. Pages restart at 1 in every split file, so a range from another file goes to the
// end of the book, where the student can move it; its later siblings then follow it.
export function placeBookPart(parts,part){
 const list=parts.filter(item=>item.id!==part.id);let index=list.length;
 if(part.pageStart){
  const siblings=list.map((item,i)=>({item,i})).filter(({item})=>item.pageStart&&sameSource(item,part));
  const lower=siblings.filter(({item})=>item.pageStart<=part.pageStart).sort((a,b)=>b.item.pageStart-a.item.pageStart||b.i-a.i)[0];
  if(lower)index=lower.i+1;else if(siblings.length)index=Math.min(...siblings.map(({i})=>i));
 }
 return [...list.slice(0,index),part,...list.slice(index)];
}
// translatedAt: when the part's translation last changed; renaming or moving it changes only updatedAt.
// layoutVersion: the extractor stamp of the part's kept layout (null: none recorded). oldPdf: the part's PDF is another
// layout's, an older part's that a range took over and keeps until that range's own export succeeds. layoutOutdated: the
// pages the reader sees come from an older extractor than this code's (LAYOUT_VERSION), so headings, captions or lines
// may still be printed Chinese; Thư viện riêng says "Bố cục cũ" and links to Xưởng dịch, where "Cập nhật bố cục" pays only
// for the blocks it finds new. A layout saved before migration 0027 has no stamp and counts as older.
const layoutPart=row=>Boolean(row.pdf_asset_id)||/\/pdf-layout\/[^/]+\/translated\.pdf$/u.test(row.file_key||'');
const otherPdf=row=>Boolean(row.file_key&&row.pdf_asset_id)&&!String(row.file_key).includes(`/pdf-layout/${row.pdf_asset_id}/`);
// assetId (never sent): the kept layout of the part's session, which a refreshed copy of it names (refreshedFrom).
const partFromRow=row=>({id:row.id,title:row.title,position:row.position??null,mime:row.mime||'text/plain',sessionId:row.session_id||null,stateKey:row.state_key||null,assetId:row.pdf_asset_id||null,filename:row.filename||'',pageStart:row.page_start??null,pageEnd:row.page_end??null,totalPages:row.source_total_pages??null,sha256:row.source_sha256||null,pages:pageList(row.source_pages),updatedAt:row.updated_at||null,translatedAt:row.translated_at||row.updated_at||null,
 layoutVersion:Number.isInteger(row.layout_version)?row.layout_version:null,oldPdf:otherPdf(row),layoutOutdated:Boolean(row.session_id)&&layoutPart(row)&&(!(row.layout_version>=LAYOUT_VERSION)||otherPdf(row))});
export const publicPart=({stateKey,assetId,...part})=>part;
export async function ownedBook(env,userId,id){
 if(typeof id!=='string'||!UUID.test(id))return null;
 return env.DB.prepare(`SELECT id,title FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK}`).bind(id,userId).first();
}
export async function listBooks(env,userId,bookId=null){
 const rows=(await env.DB.prepare(`SELECT s.id AS book_id,s.title AS book_title,s.cover_key,s.cover_page,s.cover_source_sha256,c.id,c.title,c.position,c.mime,c.file_key,ss.id AS session_id,ss.state_key,ss.filename,ss.page_start,ss.page_end,ss.source_total_pages,ss.source_sha256,ss.source_pages,ss.updated_at,ss.translated_at,ss.layout_version,ss.pdf_asset_id
  FROM stories s LEFT JOIN chapters c ON c.story_id=s.id LEFT JOIN study_sessions ss ON ss.library_chapter_id=c.id AND ss.user_id=s.owner_user_id
  WHERE s.owner_user_id=? AND ${STUDY_BOOK.replaceAll('source_url','s.source_url')}${bookId?' AND s.id=?':''}
  ORDER BY s.created_at DESC,s.id,CASE WHEN c.position IS NULL THEN 1 ELSE 0 END,c.position,c.created_at,c.id LIMIT 2000`).bind(...(bookId?[userId,bookId]:[userId])).all()).results;
 // refresh: the unfinished range that will take a part over (a refreshed layout), the newest, and the blocks it still has
 // to translate: Thư viện riêng links there instead of extracting the part once more.
 const takers=(await env.DB.prepare('SELECT id,replaces_chapter_id,total_parts,translated_parts FROM study_sessions WHERE user_id=? AND replaces_chapter_id IS NOT NULL AND library_chapter_id IS NULL ORDER BY updated_at DESC,id DESC LIMIT 500').bind(userId).all()).results||[];
 const refresh=new Map();for(const row of takers)if(!refresh.has(row.replaces_chapter_id))refresh.set(row.replaces_chapter_id,{sessionId:row.id,blocks:Math.max(0,(Number(row.total_parts)||0)-(Number(row.translated_parts)||0))});
 const books=new Map();
 for(const row of rows){
  // cover.page: the page of file cover.sha256 kept as the cover (0 = the student chose none); image: a cover is set.
  if(!books.has(row.book_id))books.set(row.book_id,{id:row.book_id,title:row.book_title,cover:{image:Boolean(row.cover_key),page:row.cover_page??null,sha256:row.cover_source_sha256||null},parts:[]});
  const parts=books.get(row.book_id).parts;if(row.id&&!parts.some(part=>part.id===row.id))parts.push({...partFromRow(row),refresh:refresh.get(row.id)||null});
 }
 return [...books.values()];
}
// Ranges were not recorded before migration 0013; the saved manifest still has them. Only placing a range pays for this read.
export async function storedRange(env,userId,key){
 const stored=key?await env.FILES.get(key):null,state=stored?await storedShape(stored,{pdfLayout:true}):null,assetId=state?.pdfLayout?.assetId;if(!assetId||!UUID.test(assetId))return null;
 const asset=await env.FILES.get(`study/${userId}/pdf-layout/${assetId}/manifest.json`);return asset?manifestRange(await storedShape(asset,RANGE_SHAPE)):null;
}
export const rangeStatement=(env,userId,sessionId,range)=>env.DB.prepare('UPDATE study_sessions SET page_start=?,page_end=?,source_total_pages=?,source_sha256=COALESCE(source_sha256,?),source_pages=COALESCE(source_pages,?) WHERE id=? AND user_id=?').bind(range.start,range.end,range.total,range.sha256,range.pages?JSON.stringify(range.pages):null,sessionId,userId);
async function backfillRanges(env,userId,parts,limit=12){
 const statements=[];
 for(const part of parts){
  if(part.pageStart||!part.sessionId||!part.stateKey||limit<=0)continue;limit--;
  const range=await storedRange(env,userId,part.stateKey).catch(()=>null);if(!range)continue;
  Object.assign(part,{pageStart:range.start,pageEnd:range.end,totalPages:part.totalPages??range.total,sha256:part.sha256||range.sha256,pages:part.pages||range.pages});statements.push(rangeStatement(env,userId,part.sessionId,range));
 }
 return statements;
}
const pageRangeOf=part=>part.pageStart?{start:part.pageStart,end:part.pageEnd||part.pageStart}:null;
// Writes a new book order: positions 1..n, plus page labels for parts still named after the book once a page-labelled range joins.
function arrangeStatements(env,book,order,incoming){
 const statements=[],incomingLabel=pageLabel(pageRangeOf(incoming)),relabel=Boolean(incomingLabel)&&incoming.title===incomingLabel;
 for(const [index,part] of order.entries()){
  if(part===incoming)continue;
  if(part.position!==index+1)statements.push(env.DB.prepare('UPDATE chapters SET position=? WHERE id=? AND story_id=?').bind(index+1,part.id,book.id));
  const label=pageLabel(pageRangeOf(part));
  if(relabel&&label&&part.title===book.title)statements.push(env.DB.prepare('UPDATE chapters SET title=? WHERE id=? AND story_id=?').bind(label,part.id,book.id));
 }
 return statements;
}
const ownedChapter="story_id IN (SELECT id FROM stories WHERE owner_user_id=?)";
// A one-part book is the session itself and follows its name; inside a larger book only the session's own part is renamed.
async function renameStatements(env,userId,session,title){
 if(!session.library_story_id||!session.library_chapter_id)return [];
 const book=await env.DB.prepare('SELECT s.title,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS parts FROM stories s WHERE s.id=? AND s.owner_user_id=?').bind(session.library_story_id,userId).first();if(!book)return [];
 const single=Number(book.parts)<=1,chapterTitle=single?title:partTitle(title,book.title,session.page_start?{start:session.page_start,end:session.page_end||session.page_start}:null);
 return [...(single?[env.DB.prepare('UPDATE stories SET title=? WHERE id=? AND owner_user_id=?').bind(title,session.library_story_id,userId)]:[]),env.DB.prepare(`UPDATE chapters SET title=? WHERE id=? AND ${ownedChapter}`).bind(chapterTitle,session.library_chapter_id,userId)];
}

async function moveSession(env,reader,existing,bookId){
 const target=await ownedBook(env,reader.id,bookId);if(!target)return reply({error:'Không tìm thấy sách đã chọn trong Thư viện riêng.'},404);
 if(!existing.library_chapter_id)return reply({error:'Chỉ gộp được bản dịch đã hoàn tất và có trong Thư viện riêng.'},409);
 const done=extra=>reply({id:existing.id,status:existing.status,libraryStoryId:target.id,libraryChapterId:existing.library_chapter_id,updatedAt:new Date().toISOString(),revision:Number(existing.revision)||0,...extra});
 if(existing.library_story_id===target.id)return done({removedBookId:null});
 const source=existing.library_story_id?await ownedBook(env,reader.id,existing.library_story_id):null;if(!source)return reply({error:'Bản dịch này không nằm trong sách học tập của bạn.'},409);
 const chapter=await env.DB.prepare('SELECT id,title,position FROM chapters WHERE id=? AND story_id=?').bind(existing.library_chapter_id,source.id).first();if(!chapter)return reply({error:'Không tìm thấy phần sách của bản dịch này.'},409);
 const moving={id:chapter.id,title:chapter.title,position:null,sessionId:existing.id,stateKey:existing.state_key,filename:existing.filename||'',pageStart:existing.page_start??null,pageEnd:existing.page_end??null,totalPages:existing.source_total_pages??null,sha256:existing.source_sha256||null};
 const parts=(await listBooks(env,reader.id,target.id))[0]?.parts||[],backfill=await backfillRanges(env,reader.id,[moving,...parts]);
 // A part named after its old one-part book takes the new book's naming; a title the student chose is kept.
 moving.title=chapter.title===source.title?partTitle(existing.title,target.title,pageRangeOf(moving)):chapter.title;
 const order=placeBookPart(parts,moving),position=order.indexOf(moving)+1;
 const covers=(await env.DB.prepare('SELECT id,cover_key,cover_page,cover_source_sha256 FROM stories WHERE id IN (?,?) AND owner_user_id=?').bind(source.id,target.id,reader.id).all()).results,sourceCover=covers.find(row=>row.id===source.id),targetCover=covers.find(row=>row.id===target.id);
 const results=await env.DB.batch([
  ...backfill,
  env.DB.prepare(`UPDATE stories SET glossary=${boundedPatch(jsonObject('glossary'),`COALESCE((SELECT ${jsonObject('old.glossary')} FROM stories old WHERE old.id=?1 AND old.owner_user_id=?2),'{}')`)} WHERE id=?3 AND owner_user_id=?2`).bind(source.id,reader.id,target.id),
  env.DB.prepare('UPDATE chapters SET story_id=?,title=?,position=? WHERE id=? AND story_id=?').bind(target.id,moving.title,position,chapter.id,source.id),
  ...arrangeStatements(env,target,order,moving),
  // A whole-book run adding to the emptied book adds its next chunks to the book it was merged into.
  env.DB.prepare('UPDATE book_jobs SET story_id=? WHERE user_id=? AND story_id=? AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=?)').bind(target.id,reader.id,source.id,source.id),
  env.DB.prepare('UPDATE study_sessions SET library_story_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').bind(target.id,existing.id,reader.id),
  // Only the empty study story goes; its files belong to the moved chapter and stay in storage.
  env.DB.prepare(`DELETE FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK} AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=stories.id) AND NOT EXISTS (SELECT 1 FROM jobs WHERE story_id=stories.id)`).bind(source.id,reader.id)
 ]);
 const removed=Boolean(results.at(-1)?.meta?.changes);
 if(removed&&sourceCover?.cover_key)await handOverCover(env,reader.id,sourceCover,target.id,!targetCover?.cover_key);
 return done({removedBookId:removed?source.id:null});
}
// Removing an object nothing points to any more is best effort: a storage error must not fail a change already saved.
export const removeFile=(env,key)=>Promise.resolve().then(()=>env.FILES.delete(key)).catch(()=>{});
// A kept original stays while anything still needs it: a part translated from it, a book cover taken from it, or a
// whole-book run over it (every later chunk is cut from it).
export async function sourceInUse(env,userId,sha256){
 return Boolean(await env.DB.prepare('SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM study_sessions WHERE user_id=?1 AND source_sha256=?2) OR EXISTS (SELECT 1 FROM stories WHERE owner_user_id=?1 AND cover_source_sha256=?2) OR EXISTS (SELECT 1 FROM book_jobs WHERE user_id=?1 AND source_sha256=?2)').bind(userId,sha256).first());
}
// The same for many objects (R2 deletes up to 1,000 keys per call) and for whole folders; failures are logged by route
// shape only, since keys hold account ids.
export async function removeKeys(env,keys){
 const unique=[...new Set(keys.filter(key=>typeof key==='string'&&key))];
 for(let i=0;i<unique.length;i+=1000){try{await env.FILES.delete(unique.slice(i,i+1000));}catch(error){logEvent('cleanup_error',{keys:unique.slice(i,i+1000).length,message:String(error?.message||'').slice(0,200)});}}
}
export async function removePrefix(env,prefix){
 if(typeof env.FILES?.list!=='function')return;
 let cursor;
 try{do{const page=await env.FILES.list({prefix,...(cursor?{cursor}:{})}),keys=page.objects.map(object=>object.key);if(keys.length)await env.FILES.delete(keys);cursor=page.truncated?page.cursor:undefined;}while(cursor);}
 catch(error){logEvent('cleanup_error',{prefix:routeLabel(prefix),message:String(error?.message||'').slice(0,200)});}
}
// The whole-book runs over a session's original, with the book each one adds its chunks to. Read before a delete: the
// delete may empty that book, which also clears the run's book.
async function jobBooks(env,userId,session){
 const sha256=validSha(session.source_sha256);if(!sha256||!pageList(session.source_pages))return [];
 return (await env.DB.prepare('SELECT id,story_id FROM book_jobs WHERE user_id=? AND source_sha256=?').bind(userId,sha256).all()).results||[];
}
// A whole-book run gets the pages of a deleted range back as pending (the job API itself never turns a done page back),
// unless a translation in the run's own book still holds them: a finished part of that book, never a draft, an
// unfinished range or a range of another book. A finished run becomes paused so it can resume.
async function releaseJobPages(env,userId,session,jobs){
 const sha256=validSha(session.source_sha256),pages=pageList(session.source_pages)||[];if(!sha256||!pages.length||!jobs.length)return;
 const parts=(await env.DB.prepare("SELECT library_story_id,source_pages FROM study_sessions WHERE user_id=? AND source_sha256=? AND status='complete' AND library_chapter_id IS NOT NULL").bind(userId,sha256).all()).results||[];
 for(const job of jobs){
  const covered=new Set(parts.filter(part=>job.story_id&&part.library_story_id===job.story_id).flatMap(part=>pageList(part.source_pages)||[]));
  // As a progress report does: written over the version read and redone on a newer one, so a report from the device
  // running the book at that moment is kept.
  for(let attempt=0;attempt<5;attempt++){
   const row=await env.DB.prepare('SELECT page_states,version FROM book_jobs WHERE id=? AND user_id=?').bind(job.id,userId).first();if(!row)break;
   const states=String(row.page_states||'').split(''),freed=pages.filter(page=>page>=1&&page<=states.length&&states[page-1]==='d'&&!covered.has(page));if(!freed.length)break;
   for(const page of freed)states[page-1]='.';
   const updated=await env.DB.prepare("UPDATE book_jobs SET page_states=?,status=CASE WHEN status='done' THEN 'paused' ELSE status END,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?").bind(states.join(''),new Date().toISOString(),job.id,userId,row.version).run();
   if(updated?.meta?.changes)break;
  }
 }
}
// A request that wrote files while its account was being deleted removes them again: the deletion has already cleared,
// or is clearing, the account's folders. Without account.js's check (an older build) only a missing account counts.
async function accountKept(env,userId,keys){
 let active=true;
 try{active=typeof account.accountActive==='function'?await account.accountActive(env,userId)!==false:Boolean(await env.DB.prepare('SELECT 1 AS active FROM reader_users WHERE id=?').bind(userId).first());}catch{}
 if(!active)await removeKeys(env,keys);
 return active;
}
const accountGone=()=>typeof account.accountDeleted==='function'?account.accountDeleted():reply({error:'Tài khoản này vừa bị xóa nên kết quả của thao tác không được lưu.',code:'account_deleted'},410);
// Deleting a history item takes its range out of the student's book (and the book itself once empty) and removes every
// file only that item used. A file another item still names stays: the same PDF asset, the same original upload, or
// the original a book's cover page comes from.
async function deleteSession(env,userId,session){
 let assetId=UUID.test(session.pdf_asset_id||'')?session.pdf_asset_id:null;
 // Saved before migration 0014: the saved state names the asset.
 if(!assetId){const state=await Promise.resolve().then(()=>env.FILES.get(session.state_key)).then(object=>object?object.json():null).catch(()=>null);assetId=UUID.test(state?.pdfLayout?.assetId||'')?state.pdfLayout.assetId:null;}
 const chapter=session.library_chapter_id?await env.DB.prepare(`SELECT c.id,c.story_id,c.file_key,c.text_key FROM chapters c JOIN stories s ON s.id=c.story_id WHERE c.id=? AND s.owner_user_id=? AND ${STUDY_BOOK.replaceAll('source_url','s.source_url')}`).bind(session.library_chapter_id,userId).first():null;
 const jobs=await jobBooks(env,userId,session);
 const results=await env.DB.batch([
  env.DB.prepare('DELETE FROM study_sessions WHERE id=? AND user_id=?').bind(session.id,userId),
  ...(chapter?[
   env.DB.prepare(`DELETE FROM chapters WHERE id=? AND ${ownedChapter}`).bind(chapter.id,userId),
   env.DB.prepare(`DELETE FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK} AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=stories.id) AND NOT EXISTS (SELECT 1 FROM jobs WHERE story_id=stories.id)`).bind(chapter.story_id,userId),
   // A whole-book run whose book is gone starts a new book with its next chunk (the foreign key does the same).
   env.DB.prepare('UPDATE book_jobs SET story_id=NULL WHERE user_id=? AND story_id=? AND NOT EXISTS (SELECT 1 FROM stories WHERE id=?)').bind(userId,chapter.story_id,chapter.story_id)
  ]:[])
 ]);
 await releaseJobPages(env,userId,session,jobs);
 const removedBookId=chapter&&results[2]?.meta?.changes?chapter.story_id:null,own=`study/${userId}/`,folders=[`${own}${session.id}/`];
 let keys=[chapter?.file_key,chapter?.text_key].filter(key=>typeof key==='string'&&key.startsWith(own));
 // The chapter may still show an older part's PDF (a range that took it over and has not exported yet): that file belongs
 // to the older session, which keeps it while it exists.
 const shown=/\/pdf-layout\/([a-f\d-]{36})\//iu.exec(chapter?.file_key||'')?.[1];
 if(shown&&shown!==assetId&&await env.DB.prepare('SELECT 1 AS used FROM study_sessions WHERE user_id=? AND pdf_asset_id=?').bind(userId,shown).first())keys=keys.filter(key=>key!==chapter.file_key);
 if(assetId){
  const folder=assetFolder(userId,assetId),used=await env.DB.prepare(`SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM study_sessions WHERE user_id=?1 AND pdf_asset_id=?2) OR EXISTS (SELECT 1 FROM chapters WHERE instr(file_key,?3)=1 AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?1))`).bind(userId,assetId,folder).first();
  if(used)keys=keys.filter(key=>!key.startsWith(folder));else folders.push(folder);
 }
 const sha256=validSha(session.source_sha256);
 if(sha256&&!await sourceInUse(env,userId,sha256))keys.push(sourceKey(userId,sha256));
 if(removedBookId)folders.push(`covers/${removedBookId}/`);
 await removeKeys(env,keys);for(const folder of folders)await removePrefix(env,folder);
 return {ok:true,removedBookId};
}
// A book's cover image lives under covers/<its id>/, the folder cleared when that book is deleted. The emptied book's
// cover is stored again under the target's id when the target has none, and its old image is removed either way. The
// move is already saved: a storage error here costs the cover at most, never the move.
async function handOverCover(env,userId,from,targetId,adopt){
 if(!from.cover_key.startsWith('covers/'))return;
 const image=adopt?await Promise.resolve().then(()=>env.FILES.get(from.cover_key)).catch(()=>null):null;
 if(image){
  const key=`covers/${targetId}/${crypto.randomUUID()}`;let adopted=false;
  try{await env.FILES.put(key,await image.arrayBuffer(),{httpMetadata:image.httpMetadata});adopted=Boolean((await env.DB.prepare('UPDATE stories SET cover_key=?,cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=? AND cover_key IS NULL').bind(key,from.cover_page,from.cover_source_sha256,targetId,userId).run())?.meta?.changes);}catch{}
  if(!adopted)await removeFile(env,key);
 }
 await removeFile(env,from.cover_key);
}

async function studyBooksRoute(request,env,path,reader){
 const id=path.slice('/api/my/study/books'.length).replace(/^\//u,'');
 if(request.method==='GET'&&!id)return reply((await listBooks(env,reader.id)).map(book=>({...book,parts:book.parts.map(publicPart)})));
 if(request.method!=='PATCH'||!id)return reply({error:'Phương thức không được hỗ trợ.'},405);
 const book=await ownedBook(env,reader.id,id);if(!book)return reply({error:'Không tìm thấy sách trong Thư viện riêng.'},404);
 const body=await request.json(),statements=[];
 if(body.title!==undefined){if(typeof body.title!=='string'||!body.title.trim())return reply({error:'Hãy nhập tên sách.'},400);statements.push(env.DB.prepare('UPDATE stories SET title=? WHERE id=? AND owner_user_id=?').bind(cleanTitle(body.title),book.id,reader.id));}
 if(body.order!==undefined){
  // Page numbers restart in every split file, so the student's order is the authority; it must name each part once.
  const ids=((await listBooks(env,reader.id,book.id))[0]?.parts||[]).map(part=>part.id);
  if(!Array.isArray(body.order)||body.order.length!==ids.length||new Set(body.order).size!==ids.length||body.order.some(item=>!ids.includes(item)))return reply({error:'Thứ tự các phần không khớp với sách.'},400);
  statements.push(...body.order.map((chapterId,index)=>env.DB.prepare('UPDATE chapters SET position=? WHERE id=? AND story_id=?').bind(index+1,chapterId,book.id)));
 }
 if(!statements.length)return reply({error:'Không có thay đổi nào cho sách.'},400);
 await env.DB.batch(statements);
 const [updated]=await listBooks(env,reader.id,book.id);return reply({...updated,parts:updated.parts.map(publicPart)});
}

export async function studyHistoryRoute(request,env,path,reader){
 if(path==='/api/my/study/books'||path.startsWith('/api/my/study/books/'))return studyBooksRoute(request,env,path,reader);
 if(!path.startsWith('/api/my/study/history'))return null;
 if(!env.FILES?.get||!env.FILES?.put)return reply({error:'Lưu lịch sử chưa được cấu hình.'},503);
 const suffix=path.slice('/api/my/study/history'.length),id=suffix.startsWith('/')?suffix.slice(1):'';
 if(suffix&&(!id||id.includes('/')||id.length>100))return reply({error:'Mã lịch sử không hợp lệ.'},400);
 if(request.method==='GET'&&!id){
  const before=new URL(request.url).searchParams.get('before'),after=before===null?null:readCursor(before);
  if(before!==null&&!after)return reply({error:'Vị trí trang Lịch sử dịch không hợp lệ. Hãy tải lại trang rồi thử lại.',code:'history_invalid'},400);
  const rows=(await env.DB.prepare(`SELECT id,title,filename,COALESCE(subject,domain) AS domain,mode,engine,status,translated_parts,total_parts,source_characters,translation_characters,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,created_at,updated_at,revision,layout_version,replaces_chapter_id,refreshed_from
   FROM study_sessions WHERE user_id=?1${after?' AND updated_at<=?2 AND (updated_at<?2 OR id<?3)':''} ORDER BY updated_at DESC,id DESC LIMIT ${HISTORY_PAGE+1}`).bind(reader.id,...(after?[after.updatedAt,after.id]:[])).all()).results;
  const response=reply(rows.slice(0,HISTORY_PAGE).map(({engine,...row})=>({...row,mode:storedMode(row.mode,engine)})));
  if(rows.length>HISTORY_PAGE)response.headers.set('X-Next-Before',pageCursor(rows[HISTORY_PAGE-1]));
  return response;
 }
 if(request.method==='GET'&&id){
  const row=await existingSession(env,id,reader.id);if(!row)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  const stored=await env.FILES.get(row.state_key);if(!stored)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  // The page restores engine before mode (frontend/study.js): one that no longer counts is answered as none.
  const mode=storedMode(row.mode,row.engine);
  return reply({...row,domain:row.subject||row.domain,mode,engine:mode===row.engine?mode:null,state:await stored.json()});
 }
 if(request.method==='DELETE'){
  if(!id)return reply({error:'Hãy chọn bản dịch cần xóa.'},400);
  const existing=await existingSession(env,id,reader.id);if(!existing)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  return reply(await deleteSession(env,reader.id,existing));
 }
 if(request.method==='PATCH'){
  if(!id)return reply({error:'Hãy chọn bản dịch cần đổi tên.'},400);
  const existing=await existingSession(env,id,reader.id);if(!existing)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  const body=await request.json();if(Object.hasOwn(body,'bookId'))return moveSession(env,reader,existing,body.bookId);
  if(typeof body.title!=='string'||!body.title.trim())return reply({error:'Hãy nhập tên nội dung.'},400);
  const title=cleanTitle(body.title);
  await env.DB.batch([env.DB.prepare('UPDATE study_sessions SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').bind(title,id,reader.id),...await renameStatements(env,reader.id,existing,title)]);
  return reply({id,status:existing.status,libraryStoryId:existing.library_story_id,libraryChapterId:existing.library_chapter_id||null,updatedAt:new Date().toISOString(),revision:Number(existing.revision)||0});
 }
 if(!['POST','PUT'].includes(request.method))return reply({error:'Phương thức không được hỗ trợ.'},405);
 if(request.method==='POST'&&id||request.method==='PUT'&&!id)return reply({error:'Đường dẫn lưu lịch sử không hợp lệ.'},400);
 const saved=id?await existingSession(env,id,reader.id):null;if(id&&!saved)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
 const body=await request.json(),named=!id&&body?.id!==undefined?body.id:null;
 // A first save may name its session (a whole-book chunk does): sent again after its answer was lost, it saves that
 // session again instead of leaving a second one. An id another account's session has is refused.
 if(named!==null&&(typeof named!=='string'||!UUID.test(named)))return reply({error:'Mã lịch sử không hợp lệ.'},400);
 const existing=saved||(named?await existingSession(env,named,reader.id):null);
 if(named&&!existing&&await env.DB.prepare('SELECT 1 AS taken FROM study_sessions WHERE id=?').bind(named).first())return reply({error:'Mã lịch sử này đã được dùng.'},409);
 // revision (optional): the revision this save was made from, as the last save, GET or list answered it. Another tab or
 // device saved since: nothing is written, and the browser reloads the session before it goes on.
 if(body.revision!==undefined&&body.revision!==null){
  if(!Number.isInteger(body.revision)||body.revision<0)return reply({error:'Phiên bản lịch sử không hợp lệ.',code:'history_invalid'},400);
  if(existing&&body.revision!==(Number(existing.revision)||0))return reply({error:CONFLICT,code:'history_conflict',revision:Number(existing.revision)||0,updatedAt:existing.updated_at},409);
 }
 const sessionId=id||named||crypto.randomUUID(),filename=cleanFilename(body.filename),title=cleanTitle(body.title,filename),domain=Object.hasOwn(DOMAINS,body.domain)?body.domain:'general',checkedDomain=CHECKED_DOMAINS.has(domain)?domain:'general',mode=historyMode(body.mode),checkedMode=legacyMode(mode),state=normalizeState(body.state||{});
 // Of two parts translating the same page, the whole-book PDF uses the newer translation, so that time is kept apart
 // from renames and moves. A PDF range compares with its saved state; any other save counts as a change.
 // layoutVersion: the extractor stamp of a kept layout (its oldest page's), which Thư viện riêng compares with this code's.
 // refreshedFrom: the kept layout a refreshed copy was made from (pdf-layout.js /refresh), recorded with the session.
 let range=bodyRange(body.pageRange),sameTranslation=false,layoutVersion=null,refreshedFrom=null,superseded=null;
 // An extraction stores its asset (manifest and original) before any session names it (pdf-layout.js). One whose first
 // save never succeeds is named by no session and stays until the account is deleted, which clears study/<user>/;
 // deleteSession removes an asset once no session or part names it.
 if(state.pdfLayout){
  const asset=await env.FILES.get(`study/${reader.id}/pdf-layout/${state.pdfLayout.assetId}/manifest.json`);if(!asset)return reply({error:'Không tìm thấy PDF trong tài khoản của bạn.'},404);
  const manifest=await storedShape(asset,MANIFEST_SHAPE),blocks=manifest.pages.flatMap(p=>p.blocks);range=manifestRange(manifest);layoutVersion=layoutStamp(manifest);
  if(typeof manifest.refreshedFrom==='string'&&UUID.test(manifest.refreshedFrom)&&manifest.refreshedFrom!==state.pdfLayout.assetId)refreshedFrom=manifest.refreshedFrom;
  if(blocks.length!==state.parts.length||blocks.some((b,i)=>b.source!==state.parts[i]))throw new Error('Lịch sử block không khớp PDF gốc.');
  const ids=new Set(blocks.map(b=>b.id));if(state.pdfLayout.edited)state.pdfLayout.edited=state.pdfLayout.edited.filter(id=>ids.has(id));
  if(state.pdfLayout.legacy){state.pdfLayout.legacy=state.pdfLayout.legacy.filter(id=>ids.has(id));if(!state.pdfLayout.legacy.length)delete state.pdfLayout.legacy;}
  if(state.pdfLayout.review){state.pdfLayout.review=Object.fromEntries(Object.entries(state.pdfLayout.review).filter(([id])=>ids.has(id)));if(!Object.keys(state.pdfLayout.review).length)delete state.pdfLayout.review;}
  validateBlockTranslations(blocks,state.translationParts.map((translation,i)=>({id:blocks[i].id,translation})).filter(b=>b.translation.trim()),{complete:state.complete});
  // Through a function, so a $ in a formula's machine text is kept as written ($' would paste the rest of the block in).
  state.translation=blocks.map((b,i)=>{let value=state.translationParts[i];for(const inline of b.inlines||[])value=value.replace(inline.token,()=>inline.text);return value;}).filter(Boolean).join('\n\n');
  if(existing){const priorObject=await env.FILES.get(existing.state_key),prior=priorObject?await storedShape(priorObject,PRIOR_STATE_SHAPE):null;sameTranslation=prior?.pdfLayout?.assetId===state.pdfLayout.assetId&&JSON.stringify(prior.translationParts)===JSON.stringify(state.translationParts);if(sameTranslation&&prior.pdfLayout.exported){state.pdfLayout.exported=true;state.pdfLayout.renderVersion=Number(prior.pdfLayout.renderVersion)||0;}}
 }
 const pages={start:range?.start??existing?.page_start??null,end:range?.end??existing?.page_end??null,total:range?.total??existing?.source_total_pages??null,sha256:range?.sha256||validSha(body.sha256)||existing?.source_sha256||null,list:range?(range.pages?JSON.stringify(range.pages):null):existing?.source_pages??null};
 // A session joins its book once: after it owns a chapter, only an explicit move (PATCH bookId) changes its book.
 let libraryStoryId=existing?.library_story_id||null,chapterId=existing?.library_chapter_id||null,book=null;
 if(!chapterId&&Object.hasOwn(body,'bookId')){
  if(body.bookId){book=await ownedBook(env,reader.id,body.bookId);if(!book)return reply({error:'Không tìm thấy sách đã chọn trong Thư viện riêng.'},404);}
  libraryStoryId=book?.id||null;
 }
 // The part this range takes over once complete: the one this save names (Thay phần…, a refreshed layout), or, when the
 // save says nothing (a page that never knew it: another tab or device), the one an earlier save of this draft named
 // (replaces_chapter_id), so a draft continued elsewhere still replaces it instead of adding the same pages twice. An empty
 // name is the student's choice to keep both. A draft records it only while it is a part of the draft's book.
 const naming=typeof body.replaceChapterId==='string'?body.replaceChapterId:'',replacing=chapterId?'':Object.hasOwn(body,'replaceChapterId')?naming:existing?.replaces_chapter_id||'';
 const replaces=replacing&&!state.complete&&libraryStoryId?(await env.DB.prepare(`SELECT id FROM chapters WHERE id=? AND story_id=? AND ${ownedChapter}`).bind(replacing,libraryStoryId,reader.id).first())?.id||null:null;
 const stateJson=JSON.stringify(state),storedBytes=utf8Length(stateJson)+(state.complete?utf8Length(state.translation):0);
 const room=await historyRoom(env,reader.id,existing,storedBytes);if(room)return room;
 // Counted once the save is valid and fits, so a refused save never uses up the day's new items.
 if(!existing){const daily=await rateLimit(env,[{daily:`history:${reader.id}`,max:dailyMax(env,'DAILY_HISTORY_PER_USER',150),label:'lưu bản dịch mới'}]);if(daily)return daily;}
 const key=stateKey(reader.id,sessionId),translatedKey=translationKey(reader.id,sessionId),status=state.complete?'complete':state.done?'translating':'draft';
 const statements=[],content=state.translation.slice(0,20000);let newChapter=false;
 // The private library copy keeps the student's terms so the reader can show the Chinese original on tap; every range adds to the book's terms.
 const terms=bookTerms(state);
 const glossaryStatement=storyId=>env.DB.prepare(`UPDATE stories SET glossary=${boundedPatch(jsonObject('glossary'),'?1')},genre=CASE WHEN (SELECT COUNT(*) FROM chapters WHERE chapters.story_id=stories.id)<=1 THEN ?2 ELSE genre END WHERE id=?3 AND owner_user_id=?4`).bind(terms,DOMAINS[domain],storyId,reader.id);
 if(state.complete&&!chapterId){
  if(libraryStoryId&&!book)book=await ownedBook(env,reader.id,libraryStoryId);
  const part={id:crypto.randomUUID(),title,position:null,sessionId,filename,pageStart:pages.start,pageEnd:pages.end,totalPages:pages.total,sha256:pages.sha256};
  if(book){
   // A refreshed copy takes over the part of the layout it was refreshed from (refreshedFrom), wherever that layout's
   // session went on: a draft refreshed before it was complete still gives its pages one part. A layout whose refreshed
   // copy is a part of this book already is not added again (superseded): it stays complete, outside the book.
   const parts=(await listBooks(env,reader.id,book.id))[0]?.parts||[],named=replacing?parts.find(item=>item.id===replacing):null;
   if(naming&&!named)return reply({error:'Phần cần thay không thuộc sách đã chọn.'},400);
   const replaced=named||(refreshedFrom&&parts.find(item=>item.assetId===refreshedFrom))||null;
   superseded=!replaced&&state.pdfLayout?await env.DB.prepare('SELECT id FROM study_sessions WHERE user_id=? AND refreshed_from=? AND library_story_id=? AND library_chapter_id IS NOT NULL AND id<>? LIMIT 1').bind(reader.id,state.pdfLayout.assetId,book.id,sessionId).first():null;
   part.title=partTitle(title,book.title,pages.start?pages:null);
   if(superseded)libraryStoryId=null;
   else if(replaced){
    // A redone range takes over the old part (same place in the book); the superseded session leaves the library. A kept
    // layout of the same pages of the same file (a refreshed layout: its copy names the layout it was made from, whatever
    // hashes older rows lack) keeps the old part's PDF linked until its own export succeeds (pdf-layout.js /render), so an
    // export that fails or waits never leaves the book with the original's pages there. Other pages (Thay phần… over
    // another range) never keep a PDF of pages they do not hold, and a text translation has no PDF to wait for.
    chapterId=replaced.id;
    const samePages=Boolean(state.pdfLayout)&&(Boolean(refreshedFrom)&&replaced.assetId===refreshedFrom||Boolean(pages.sha256)&&replaced.sha256===pages.sha256&&(replaced.pages&&pages.list?JSON.stringify(replaced.pages)===JSON.stringify(pageList(pages.list)):replaced.pageStart===pages.start&&replaced.pageEnd===pages.end));
    statements.push(env.DB.prepare(`UPDATE chapters SET title=?1,content=?2,text_key=?3,file_key=CASE WHEN ?4 THEN file_key END,mime=CASE WHEN ?4 AND file_key IS NOT NULL THEN mime ELSE 'text/plain' END WHERE id=?5 AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?6)`).bind(part.title,content,translatedKey,samePages?1:0,chapterId,reader.id));
    statements.push(env.DB.prepare('UPDATE study_sessions SET library_chapter_id=NULL,library_story_id=NULL WHERE library_chapter_id=? AND user_id=? AND id<>?').bind(chapterId,reader.id,sessionId));
   }else{
    statements.push(...await backfillRanges(env,reader.id,parts));
    const order=placeBookPart(parts,part);chapterId=part.id;newChapter=true;
    statements.push(env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,book.id,part.title,content,translatedKey,'text/plain',order.indexOf(part)+1),...arrangeStatements(env,book,order,part));
   }
   if(!superseded){libraryStoryId=book.id;statements.push(glossaryStatement(book.id));}
  }else{
   // A new book: later ranges can join it, so it is not tied to this session's id.
   libraryStoryId=crypto.randomUUID();chapterId=part.id;newChapter=true;
   statements.push(env.DB.prepare("INSERT INTO stories(id,title,author,genre,source_url,owner_user_id,visibility,glossary) VALUES(?,?,?,?,?,?, 'private',?)").bind(libraryStoryId,title,'Bản dịch cá nhân',DOMAINS[domain],`study-book:${libraryStoryId}`,reader.id,terms));
   statements.push(env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,libraryStoryId,title,content,translatedKey,'text/plain',1));
  }
 }else if(state.complete&&chapterId){
  statements.push(env.DB.prepare(`UPDATE chapters SET content=?,text_key=? WHERE id=? AND ${ownedChapter}`).bind(content,translatedKey,chapterId,reader.id));
  if(libraryStoryId)statements.push(glossaryStatement(libraryStoryId));
  if(existing.title!==title)statements.push(...await renameStatements(env,reader.id,existing,title));
 }
 // Only this session's own PDF goes when its translation changed; an older part's, which this range took over, stays
 // linked until this range's export replaces it.
 if(state.pdfLayout&&!state.pdfLayout.exported&&chapterId&&!newChapter){
  statements.push(env.DB.prepare(`UPDATE chapters SET file_key=NULL,mime=? WHERE id=? AND ${ownedChapter} AND (file_key IS NULL OR instr(file_key,?)=1)`).bind('text/plain',chapterId,reader.id,assetFolder(reader.id,state.pdfLayout.assetId)));
 }
 // The session references its book and chapter, so it is written after them in the transaction. A concurrent move changes
 // only the book of an existing chapter; keeping the stored book then avoids pointing back at a deleted story.
 statements.push(env.DB.prepare(`INSERT INTO study_sessions(id,user_id,title,filename,domain,subject,mode,engine,status,state_key,source_preview,translation_preview,translated_parts,total_parts,source_characters,translation_characters,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,source_pages,pdf_asset_id,translated_at,stored_bytes,revision,layout_version,replaces_chapter_id,refreshed_from)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP END,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=study_sessions.revision+1,stored_bytes=excluded.stored_bytes,layout_version=excluded.layout_version,replaces_chapter_id=excluded.replaces_chapter_id,refreshed_from=excluded.refreshed_from,translated_at=COALESCE(excluded.translated_at,study_sessions.translated_at,CURRENT_TIMESTAMP), title=excluded.title,filename=excluded.filename,domain=excluded.domain,subject=excluded.subject,mode=excluded.mode,engine=excluded.engine,status=excluded.status,state_key=excluded.state_key,source_preview=excluded.source_preview,translation_preview=excluded.translation_preview,translated_parts=excluded.translated_parts,total_parts=excluded.total_parts,source_characters=excluded.source_characters,translation_characters=excluded.translation_characters,library_story_id=CASE WHEN study_sessions.library_chapter_id IS NOT NULL AND study_sessions.library_chapter_id=excluded.library_chapter_id THEN study_sessions.library_story_id ELSE excluded.library_story_id END,library_chapter_id=excluded.library_chapter_id,page_start=excluded.page_start,page_end=excluded.page_end,source_total_pages=excluded.source_total_pages,source_sha256=excluded.source_sha256,source_pages=excluded.source_pages,pdf_asset_id=excluded.pdf_asset_id,updated_at=CURRENT_TIMESTAMP WHERE user_id=excluded.user_id`).bind(sessionId,reader.id,title,filename,checkedDomain,domain,checkedMode,mode,status,key,state.source.slice(0,PREVIEW),state.translation.slice(0,PREVIEW),state.done,state.parts.length,state.source.length,state.translation.length,libraryStoryId,chapterId,pages.start,pages.end,pages.total,pages.sha256,pages.list,state.pdfLayout?.assetId||null,sameTranslation?1:0,storedBytes,layoutVersion,chapterId?null:replaces,refreshedFrom));
 const guard=existing?null:roomGuard(env,reader.id,sessionId,storedBytes);if(guard)statements.unshift(guard);
 const written=[key,...(state.complete?[translatedKey]:[])];
 await env.FILES.put(key,stateJson,{httpMetadata:{contentType:'application/json; charset=utf-8'}});
 if(state.complete)await env.FILES.put(translatedKey,state.translation,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
 // An account deleted meanwhile keeps none of this: its rows cannot be written (or went with it), its files go here.
 // A new item whose batch failed keeps none either (the guard refused it, or the database failed): its files are its own
 // unless the same save, sent again, landed meanwhile. A refusal by the guard is answered 413 history_full, also when
 // room was freed before the check here, never with the database's error.
 try{await env.DB.batch(statements);}
 catch(error){
  if(!await accountKept(env,reader.id,written))return accountGone();
  if(!existing&&!await existingSession(env,sessionId,reader.id))await removeKeys(env,written);
  const full=guard?await historyRoom(env,reader.id,null,storedBytes,GUARD_REFUSED.test(String(error?.message||''))):null;
  if(full)return full;
  throw error;
 }
 // The revision this save made, which the next save from this tab names; read back, as a save from elsewhere may have
 // landed in between.
 const revision=Number((await env.DB.prepare('SELECT revision FROM study_sessions WHERE id=? AND user_id=?').bind(sessionId,reader.id).first())?.revision)||(existing?(Number(existing.revision)||0)+1:1);
 if(!await accountKept(env,reader.id,written))return accountGone();
 // The save is done: an export that no longer matches is only removed on a best-effort basis, never failing the save.
 if(state.pdfLayout&&!state.pdfLayout.exported)await removeFile(env,`study/${reader.id}/pdf-layout/${state.pdfLayout.assetId}/translated.pdf`);
 return reply({id:sessionId,status,libraryStoryId,libraryChapterId:chapterId,updatedAt:new Date().toISOString(),revision,...(superseded?{supersededBy:superseded.id}:{})},existing?200:201);
}
