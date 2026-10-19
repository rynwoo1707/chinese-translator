// publish, unpublish and remove through the admin API. A server that keeps samples (its /api/status names them) gets a
// sample book: keyed by the slug, so a replacement keeps the book's id and links; private until every part is in; with
// its original (by default an excerpt: the cover and the translated pages, numbered as pages of the book) and the pages
// each part translates, so "Tải cả quyển" and "Đọc song ngữ" work as for a student's own book and name the book's
// pages. An older server gets a plain book, as before.
// A sample creates no job, so the library never says a teacher reviewed it.
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {workDir,sampleFile,assertInsideSamples} from './paths.mjs';
import {readJson,writeJson,sha256,fileSha256,isPdf} from './util.mjs';
import {validateSample} from './config.mjs';
import {loadSample,readState,chunkStatus,codeVersions,publishedPath} from './state.mjs';
import {resolveTarget,targetToken,adminClient,AdminError} from './admin-client.mjs';
import {devVar,pdfTool,prepareEngineEnv} from './machine.mjs';
import {pageLabel} from './plan.mjs';

const MAX_PDF=25*1024*1024,MAX_COVER=5*1024*1024,MAX_SOURCE=100*1024*1024,SAMPLE_PREFIX='sample:';
// work/excerpt.json names how the excerpt was cut; an older one is cut again. 2: its pages carry the book's page numbers
// as PDF page labels (pdf_tool.py subset), so a PDF reader and "Tải cả quyển" show 7, not 2, for page 7 of the book.
export const EXCERPT_VERSION=2;
// The book page of each page of the excerpt, in the order of the file, as runs ("1,7-10"): the X-Book-Pages header.
const bookPagesHeader=pages=>pages.reduce((runs,page)=>{const last=runs.at(-1);if(last&&page===last[1]+1)last[1]=page;else runs.push([page,page]);return runs;},[]).map(([first,last])=>first===last?String(first):`${first}-${last}`).join(',');
// A server without part positions lists parts by creation time (to the second): one second between uploads keeps them
// in page order there.
const CHAPTER_SPACING_MS=1100;

// Everything that can be decided without the network: errors stop the publish, warnings need --yes.
export async function publishPlan(slug){
 const {dir,config:basic}=await loadSample(slug),errors=[],warnings=[];let config=basic;
 // The fields a public book needs (title, genre, rights) are reported with the other problems, not on their own.
 try{config=validateSample(await readJson(resolve(dir,'sample.json')),{slug,need:['publish']});}catch(error){errors.push(error.message);}
 const state=await readState(slug),code=await codeVersions(),chunks=[];let glossary={...config.glossary};
 if(state.code?.extractor&&state.code.extractor!==code.extractor)warnings.push('Bộ tách trang (extract.py) đã đổi sau lần extract; bản hiện tại vẫn dùng được.');
 for(const chunk of state.chunks){
  const status=await chunkStatus(slug,chunk,{code});
  for(const problem of status.problems)errors.push(`${chunk.id} (${chunk.title}): ${problem}.`);
  for(const note of status.notes)warnings.push(`${chunk.id}: ${note}.`);
  if(!status.rendered)continue;
  for(const warning of status.report.warnings)warnings.push(`${chunk.id}: ${warning.message}`);
  if(status.render.shrunk?.length)warnings.push(`${chunk.id}: ${status.render.shrunk.length} đoạn phải thu nhỏ chữ nhiều (${status.render.shrunk.slice(0,6).join(', ')}); xem render/*.compare.png.`);
  const bytes=await readFile(status.files.pdf);
  if(!isPdf(bytes)||bytes.length>MAX_PDF){errors.push(`${chunk.id}: PDF tiếng Việt phải hợp lệ và không quá 25 MB.`);continue;}
  glossary={...glossary,...(status.report.glossary||{})};
  chunks.push({id:chunk.id,title:chunk.title,pages:chunk.pages,pdf:status.files.pdf,sha256:sha256(bytes),bytes:bytes.length});
 }
 let cover=null;
 if(state.cover?.page){
  const file=resolve(workDir(slug),'cover.jpg');
  if(!existsSync(file))warnings.push('Không còn work/cover.jpg; sách sẽ đăng không có ảnh bìa (chạy lại extract để tạo).');
  else{const bytes=await readFile(file);if(bytes.length>MAX_COVER)errors.push('Ảnh bìa vượt 5 MB.');else cover={file,page:state.cover.page,sha256:sha256(bytes),bytes};}
 }
 return {config,state,chunks,cover,glossary,errors,warnings};
}

// The original readers get: the cover and the translated pages by default (what rights.confirmed covers), or the whole
// source.pdf with "publishSource": "full". map turns a page of source.pdf into the same page of that file; bookPages
// (excerpt only) is the page of source.pdf each page of the excerpt is, which the server keeps with the file
// (X-Book-Pages) so the reader names book pages, and which the excerpt itself carries as page labels.
export async function publishedSource(slug,{config,state,chunks},{subset=(file,pages,out)=>{prepareEngineEnv();return pdfTool(['subset',file,JSON.stringify(pages),out]);}}={}){
 const file=sampleFile(slug,state.source.file);
 if(config.publishSource==='full'){
  const bytes=await readFile(file);if(sha256(bytes)!==state.source.sha256)throw new Error(`${state.source.file} đã đổi sau lần extract: chạy lại extract.`);
  return {mode:'full',bytes,sha256:state.source.sha256,pages:state.source.totalPages,bookPages:null,filename:config.source,map:page=>page};
 }
 const pages=[...new Set([state.cover?.page||0,...chunks.flatMap(chunk=>chunk.pages)])].filter(Boolean).sort((a,b)=>a-b);
 const out=assertInsideSamples(resolve(workDir(slug),'excerpt.pdf')),meta=resolve(workDir(slug),'excerpt.json');
 let record=await readJson(meta,{what:'work/excerpt.json'});
 if(!record||record.version!==EXCERPT_VERSION||record.sourceSha256!==state.source.sha256||JSON.stringify(record.pages)!==JSON.stringify(pages)||await fileSha256(out)!==record.sha256){
  await subset(file,pages,out);const bytes=await readFile(out);if(!isPdf(bytes))throw new Error('Không tạo được PDF trích đoạn của bản gốc.');
  record={version:EXCERPT_VERSION,sourceSha256:state.source.sha256,pages,sha256:sha256(bytes),bytes:bytes.length};await writeJson(meta,record);
 }
 const index=new Map(pages.map((page,i)=>[page,i+1]));
 return {mode:'excerpt',bytes:await readFile(out),sha256:record.sha256,pages:pages.length,bookPages:pages,filename:`${(config.title||slug).slice(0,200)} (trích đoạn bản gốc).pdf`,map:page=>index.get(page)};
}

async function readRecord(slug){return await readJson(publishedPath(slug),{what:'published.json'})||{version:1,slug,targets:{}};}
async function connect(target,{fetch,env,readDevToken,prompt}){
 const resolved=resolveTarget(target),token=await targetToken(resolved,{env,readDevToken,prompt}),client=adminClient({origin:resolved.origin,token,fetch});
 const status=await client.call('GET','/api/status');if(status?.authenticated!==true)throw new Error(`Mã quản trị không được ${resolved.origin} chấp nhận.`);
 // features: what a newer server also does for samples (bookPages: keeps the book's page numbers of an excerpt;
 // clearCover: removes a cover the new publish no longer has). An older server says nothing and gets neither.
 const features=status.sampleFeatures&&typeof status.sampleFeatures==='object'?status.sampleFeatures:{};
 return {client,origin:resolved.origin,samples:status.samples&&typeof status.samples==='object'?status.samples:null,features:{bookPages:features.bookPages===true,clearCover:features.clearCover===true}};
}
async function findStory(client,id){const stories=await client.call('GET','/api/stories');return Array.isArray(stories)?stories.find(story=>story.id===id)||null:null;}
const hidden=async request=>{try{await request();}catch(error){if(error instanceof AdminError&&error.status===404)return true;throw error;}return false;};

// What a reader sees: a public book in /api/library with its parts in page order and the same PDF bytes, and the cover
// made for it or none at all; a draft hidden from everyone but the admin. A sample book also: marked as a sample, each
// part on its original pages (and, for an excerpt the server numbers, on its book pages), and the original itself
// downloadable.
async function verify(client,{storyId,visibility,chapters,cover,source=null}){
 const open=visibility==='public',library=await client.call('GET','/api/library',{admin:false}),row=Array.isArray(library)?library.find(story=>story.id===storyId):null;
 if(open&&!row)throw new Error('Sách chưa hiện trong thư viện công khai (/api/library): kiểm tra lại thể loại.');
 if(!open&&row)throw new Error('Bản nháp lại hiện trong thư viện công khai.');
 if(open&&source&&(Number(row.sample)!==1||Number(row.mapped_parts)!==chapters.length))throw new Error('Thư viện chưa ghi nhận sách là ví dụ mẫu có trang gốc.');
 const read=await client.call('GET',`/api/read/${storyId}`,{admin:!open});
 if(JSON.stringify(read.map(c=>c.id))!==JSON.stringify(chapters.map(c=>c.id)))throw new Error('Thứ tự các phần trên máy chủ khác thứ tự trang.');
 for(const chapter of chapters){
  const file=await client.call('GET',`/api/chapter-file/${chapter.id}`,{admin:!open,bytes:true});
  if(sha256(file.data)!==chapter.sha256)throw new Error(`PDF của ${chapter.title} trên máy chủ khác tệp đã render.`);
 }
 if(!open&&!await hidden(()=>client.call('GET',`/api/chapter-file/${chapters[0].id}`,{admin:false,bytes:true})))throw new Error('Bản nháp lại tải được khi chưa đăng nhập.');
 if(cover){const image=await client.call('GET',`/api/covers/${storyId}`,{admin:!open,bytes:true});if(sha256(image.data)!==cover.sha256)throw new Error('Ảnh bìa trên máy chủ khác ảnh đã tạo.');}
 else if(!await hidden(()=>client.call('GET',`/api/covers/${storyId}`,{admin:!open,bytes:true})))throw new Error('Sách vẫn còn ảnh bìa trên máy chủ, dù bản mới không có ảnh bìa.');
 if(!source)return;
 const assembly=await client.call('GET',`/api/library/${storyId}/assembly`,{admin:!open}),parts=new Map((assembly.parts||[]).map(part=>[part.id,part]));
 if(chapters.some(c=>parts.get(c.id)?.sha256!==source.sha256||JSON.stringify(parts.get(c.id)?.pages)!==JSON.stringify(c.sourcePages)))throw new Error('Trang gốc của các phần trên máy chủ khác trang đã dịch.');
 const stored=(assembly.storedSources||[]).find(item=>item.sha256===source.sha256);if(!stored||stored.pages!==source.pages)throw new Error('Máy chủ chưa giữ PDF gốc của sách.');
 if(source.bookPages&&(JSON.stringify(stored.bookPages)!==JSON.stringify(source.bookPages)||chapters.some(c=>JSON.stringify(parts.get(c.id)?.bookPages)!==JSON.stringify(c.pages))))throw new Error('Máy chủ chưa ghi đúng số trang sách của PDF gốc trích đoạn.');
 const original=await client.call('GET',stored.url,{admin:!open,bytes:true});if(sha256(original.data)!==source.sha256)throw new Error('PDF gốc trên máy chủ khác tệp đã tải lên.');
 if(!open&&!await hidden(()=>client.call('GET',`/api/library/${storyId}/assembly`,{admin:false})))throw new Error('Bản nháp lại mở được khi chưa đăng nhập.');
}

// A sample book: created private (or emptied and hidden while it is replaced), filled, then published. A kept book
// whose new publish has no cover loses its old one, so the library never shows a cover the owner removed.
async function publishKept(slug,plan,{client,origin,previous,replace,draft,log,subset,features={}}){
 const {config}=plan,stories=await client.call('GET','/api/stories'),list=Array.isArray(stories)?stories:[];
 const existing=list.find(story=>story.source_url===SAMPLE_PREFIX+slug)||null;
 // A book published before the server kept samples has no slug: --replace swaps it for the sample book.
 const older=!existing&&previous?list.find(story=>story.id===previous.storyId)||null:null,found=existing||older;
 if(found&&!replace)throw new Error(`"${slug}" đã có trên ${origin} (mã ${found.id}, ${found.visibility==='private'?'bản nháp':'công khai'}). Thêm --replace để thay bằng bản mới${existing?' (mã sách giữ nguyên)':''}.`);
 const dropCover=Boolean(existing?.cover_key)&&!plan.cover;
 // Refused before anything changes: the old cover would stay on the book.
 if(dropCover&&!features.clearCover)throw new Error(`"${slug}" trên ${origin} đang có ảnh bìa, còn bản mới không có ảnh bìa ("cover": "none" hoặc thiếu work/cover.jpg), nhưng máy chủ này chưa xóa được ảnh bìa của sách. Hãy cập nhật máy chủ, hoặc chạy lại extract để có work/cover.jpg.`);
 const source=await publishedSource(slug,plan,{subset});
 if(source.bytes.length>MAX_SOURCE)throw new Error('PDF gốc để đăng vượt 100 MB: dùng "publishSource": "excerpt".');
 // Book pages go only to a server that keeps them; verify then checks them.
 const bookPages=features.bookPages&&source.bookPages?source.bookPages:null;
 let storyId=existing?.id||null;
 if(existing){
  log(`Đang thay "${config.title}" (mã ${storyId}) trên ${origin}; sách tạm ẩn đến khi đủ các phần…`);
  await client.call('PATCH',`/api/stories/${storyId}`,{json:{visibility:'private'}});
  for(const chapter of await client.call('GET',`/api/stories/${storyId}/chapters`))await client.call('DELETE',`/api/chapters/${chapter.id}`);
  for(const field of [{title:config.title},{genre:config.genre},{author:config.author}])await client.call('PATCH',`/api/stories/${storyId}`,{json:field});
 }else{
  log(`Đang đăng "${config.title}" lên ${origin} (${draft?'bản nháp riêng tư':'công khai'})…`);
  const form=new FormData();form.set('title',config.title);form.set('genre',config.genre);form.set('visibility','private');form.set('sample',slug);if(config.author)form.set('author',config.author);
  storyId=(await client.call('POST','/api/stories',{form}))?.id;if(typeof storyId!=='string'||!storyId)throw new Error('Máy chủ không trả mã sách mới.');
 }
 const chapters=[];
 try{
  const stored=await client.call('PUT',`/api/stories/${storyId}/sources/${source.sha256}`,{body:source.bytes,headers:{'Content-Type':'application/pdf','X-PDF-Pages':String(source.pages),'X-Source-Filename':encodeURIComponent(source.filename),...(bookPages?{'X-Book-Pages':bookPagesHeader(bookPages)}:{})}});
  if(stored?.sha256!==source.sha256)throw new Error('Máy chủ không nhận PDF gốc.');
  log(`  PDF gốc (${source.mode==='full'?'cả tệp':`trích đoạn: trang ${pageLabel(source.bookPages)} của sách`}, ${source.pages} trang): ${stored.stored?'đã tải lên':'đã có trên máy chủ'}.`);
  if(plan.cover){const form=new FormData(),page=source.map(plan.cover.page);form.set('cover',new File([plan.cover.bytes],'cover.jpg',{type:'image/jpeg'}));if(page){form.set('page',String(page));form.set('sha256',source.sha256);}await client.call('POST',`/api/stories/${storyId}/cover`,{form});}
  else if(dropCover){await client.call('DELETE',`/api/stories/${storyId}/cover`);log('  Ảnh bìa cũ: đã xóa (bản mới không có ảnh bìa).');}
  for(const [index,chunk] of plan.chunks.entries()){
   const sourcePages=chunk.pages.map(source.map),part=new FormData();
   part.set('confirmed','true');part.set('title',chunk.title);part.set('position',String(index+1));part.set('source_sha256',source.sha256);part.set('source_pages',JSON.stringify(sourcePages));
   part.set('file',new File([await readFile(chunk.pdf)],`${chunk.id}.vi.pdf`,{type:'application/pdf'}));
   const chapter=await client.call('POST',`/api/stories/${storyId}/chapters`,{form:part});
   chapters.push({id:chapter.id,chunk:chunk.id,title:chunk.title,pages:chunk.pages,sourcePages,sha256:chunk.sha256,bytes:chunk.bytes});
   log(`  ${chunk.id} · ${chunk.title}: đã tải lên.`);
  }
  await client.call('PATCH',`/api/stories/${storyId}`,{json:{glossary:plan.glossary}});
  // An original no part uses any more (the excerpt of an earlier publish) is removed.
  for(const old of (await client.call('GET',`/api/stories/${storyId}/sources`)).sources||[])if(old.sha256!==source.sha256)await client.call('DELETE',`/api/stories/${storyId}/sources/${old.sha256}`);
  if(!draft)await client.call('PATCH',`/api/stories/${storyId}`,{json:{visibility:'public'}});
  await verify(client,{storyId,visibility:draft?'private':'public',chapters,cover:plan.cover,source:{...source,bookPages}});
 }catch(error){
  if(existing)throw new Error(`${error.message}\nSách ${storyId} đang là bản nháp, người đọc không thấy; sửa lỗi rồi chạy lại "publish ${slug} --replace".`);
  let cleaned=true;try{await client.call('DELETE',`/api/stories/${storyId}`);}catch{cleaned=false;}
  throw new Error(`${error.message}\n${cleaned?`Đã gỡ bản vừa tải lên (${storyId}).`:`Chưa gỡ được bản vừa tải lên (${storyId}): hãy xóa trong trang quản trị.`}`);
 }
 const notes=[];let replaced=null;
 if(older){try{await client.call('DELETE',`/api/stories/${older.id}`);replaced=older.id;}catch(error){notes.push(`Chưa xóa được bản cũ ${older.id} (${error.message}); hãy xóa trong trang quản trị.`);}}
 return {storyId,chapters,replaced,kept:Boolean(existing),notes,source:{mode:source.mode,sha256:source.sha256,pages:source.pages,bytes:source.bytes.length,...(source.bookPages?{bookPages:source.bookPages}:{})}};
}
// A plain book, for a server that does not keep samples: created with its final visibility, parts uploaded a second
// apart, and on --replace the old book deleted once the new one checks out (so the id changes).
async function publishPlain(slug,plan,{client,origin,previous,replace,draft,log,sleep}){
 const {config}=plan,visibility=draft?'private':'public',existing=previous?await findStory(client,previous.storyId):null;
 if(existing&&!replace)throw new Error(`"${slug}" đã có trên ${origin} (mã ${existing.id}, ${existing.visibility==='private'?'bản nháp':'công khai'}). Thêm --replace để thay bằng bản mới.`);
 const form=new FormData();form.set('title',config.title);form.set('genre',config.genre);form.set('visibility',visibility);
 if(config.author)form.set('author',config.author);
 if(plan.cover)form.set('cover',new File([plan.cover.bytes],'cover.jpg',{type:'image/jpeg'}));
 log(`Đang đăng "${config.title}" lên ${origin} (${draft?'bản nháp riêng tư':'công khai'})…`);
 const created=await client.call('POST','/api/stories',{form}),storyId=created?.id;
 if(typeof storyId!=='string'||!storyId)throw new Error('Máy chủ không trả mã sách mới.');
 const chapters=[];
 try{
  for(const [index,chunk] of plan.chunks.entries()){
   if(index)await sleep(CHAPTER_SPACING_MS);
   const part=new FormData();part.set('confirmed','true');part.set('title',chunk.title);part.set('position',String(index+1));
   part.set('file',new File([await readFile(chunk.pdf)],`${chunk.id}.vi.pdf`,{type:'application/pdf'}));
   const chapter=await client.call('POST',`/api/stories/${storyId}/chapters`,{form:part});
   chapters.push({id:chapter.id,chunk:chunk.id,title:chunk.title,pages:chunk.pages,sha256:chunk.sha256,bytes:chunk.bytes});
   log(`  ${chunk.id} · ${chunk.title}: đã tải lên.`);
  }
  if(Object.keys(plan.glossary).length)await client.call('PATCH',`/api/stories/${storyId}`,{json:{glossary:plan.glossary}});
  await verify(client,{storyId,visibility,chapters,cover:plan.cover});
 }catch(error){
  let cleaned=true;try{await client.call('DELETE',`/api/stories/${storyId}`);}catch{cleaned=false;}
  throw new Error(`${error.message}\n${cleaned?`Đã gỡ bản vừa tải lên (${storyId}).`:`Chưa gỡ được bản vừa tải lên (${storyId}): hãy xóa trong trang quản trị.`}`);
 }
 const notes=[];let replaced=null;
 if(existing){
  try{await client.call('DELETE',`/api/stories/${existing.id}`);replaced=existing.id;}
  catch(error){notes.push(`Chưa xóa được bản cũ ${existing.id} (${error.message}); hãy xóa trong trang quản trị.`);}
 }
 const row=await findStory(client,storyId);
 if(config.author&&row&&row.author!==config.author)notes.push(`Máy chủ này chưa lưu tác giả nên sách hiện “${row.author}”.`);
 return {storyId,chapters,replaced,kept:false,notes};
}

export async function publishSample(slug,{target='local',draft=false,replace=false,yes=false,fetch,env=process.env,readDevToken=()=>devVar('ADMIN_TOKEN'),prompt,confirm,log=console.log,sleep=ms=>new Promise(done=>setTimeout(done,ms)),subset}={}){
 const plan=await publishPlan(slug);
 if(plan.errors.length)throw new Error(`Chưa đăng được "${slug}":\n- ${plan.errors.join('\n- ')}`);
 if(plan.config.rights?.localOnly&&!resolveTarget(target).local)throw new Error(`"${slug}" chỉ được đăng lên máy chủ trên máy này (rights.localOnly): sách còn bản quyền nên không đăng lên trang công khai.`);
 const {client,origin,samples,features}=await connect(target,{fetch,env,readDevToken,prompt});
 if(samples&&!samples.pages)throw new Error(`Máy chủ ${origin} chưa áp migration 0015 nên chưa lưu được trang gốc của từng phần: chạy "npm run db:local" (máy này) hoặc "npx wrangler d1 migrations apply DB --remote", rồi đăng lại.`);
 const warnings=[...plan.warnings];
 // A server that cannot mark samples shows the book like any other: only its title can say what it is.
 if(!samples&&plan.config.title&&!/ví dụ mẫu/iu.test(plan.config.title))warnings.push('Tên sách chưa có chữ “Ví dụ mẫu”: máy chủ này chưa gắn được nhãn ví dụ mẫu, người đọc sẽ không biết đây là bản dịch AI minh họa.');
 if(samples&&plan.config.publishSource!=='full'&&!features.bookPages)warnings.push('Máy chủ này chưa ghi được số trang sách của PDF gốc trích đoạn: “Đọc song ngữ” sẽ đánh số theo vị trí trong bản trích đoạn (bìa là trang 1). Hãy cập nhật máy chủ rồi đăng lại.');
 if(warnings.length){
  log(`Cảnh báo (${warnings.length}):\n- ${warnings.join('\n- ')}`);
  if(!yes&&!(confirm&&await confirm('Vẫn đăng?')))throw new Error('Đã dừng vì còn cảnh báo. Đọc lại, rồi chạy kèm --yes nếu vẫn muốn đăng.');
 }
 const record=await readRecord(slug),previous=record.targets?.[origin]||null,visibility=draft?'private':'public';
 const done=samples?await publishKept(slug,plan,{client,origin,previous,replace,draft,log,subset,features}):await publishPlain(slug,plan,{client,origin,previous,replace,draft,log,sleep});
 record.targets={...(record.targets||{}),[origin]:{storyId:done.storyId,visibility,title:plan.config.title,genre:plan.config.genre,sample:Boolean(samples),chapters:done.chapters,cover:plan.cover?{page:plan.cover.page,sha256:plan.cover.sha256}:null,source:done.source||null,publishedAt:new Date().toISOString(),replaced:[...(previous?.replaced||[]),...(done.replaced?[done.replaced]:[])]}};
 await writeJson(publishedPath(slug),record);
 return {origin,storyId:done.storyId,visibility,chapters:done.chapters,replaced:done.replaced,kept:done.kept,sample:Boolean(samples),source:done.source||null,notes:done.notes,reader:`${origin}/?read=${done.storyId}`};
}

async function recorded(slug,origin){
 const record=await readRecord(slug),entry=record.targets?.[origin];
 if(!entry)throw new Error(`published.json chưa ghi bản đăng nào của "${slug}" trên ${origin}.`);
 return {record,entry};
}
export async function removeSample(slug,{target='local',yes=false,fetch,env=process.env,readDevToken=()=>devVar('ADMIN_TOKEN'),prompt,confirm}={}){
 await loadSample(slug);
 const {origin}=resolveTarget(target),{record,entry}=await recorded(slug,origin);
 if(!yes&&!(confirm&&await confirm(`Xóa sách ${entry.storyId} ("${entry.title}") khỏi ${origin}?`)))throw new Error('Đã dừng: chưa xác nhận (thêm --yes).');
 const {client}=await connect(target,{fetch,env,readDevToken,prompt});
 let gone=false;try{await client.call('DELETE',`/api/stories/${entry.storyId}`);}catch(error){if(!(error instanceof AdminError)||error.status!==404)throw error;gone=true;}
 delete record.targets[origin];await writeJson(publishedPath(slug),record);
 return {origin,storyId:entry.storyId,alreadyGone:gone};
}
// Hides a published book in place (PATCH visibility). A server that cannot change a book's visibility answers 400
// without changing anything, and the owner is told what does work there.
export async function unpublishSample(slug,{target='local',fetch,env=process.env,readDevToken=()=>devVar('ADMIN_TOKEN'),prompt}={}){
 await loadSample(slug);
 const {origin}=resolveTarget(target),{record,entry}=await recorded(slug,origin);
 if(entry.visibility==='private')return {origin,storyId:entry.storyId,changed:false};
 const {client}=await connect(target,{fetch,env,readDevToken,prompt});
 let result=null;try{result=await client.call('PATCH',`/api/stories/${entry.storyId}`,{json:{visibility:'private'}});}catch(error){if(!(error instanceof AdminError)||![400,404].includes(error.status))throw error;}
 if(result?.visibility!=='private')throw new Error(`Máy chủ ${origin} chưa có lệnh ẩn một sách đã đăng. Dùng "remove ${slug}" để gỡ sách (thư mục làm việc vẫn giữ nguyên, đăng lại lúc nào cũng được), hoặc "publish ${slug} --draft --replace" để thay bằng bản nháp riêng tư.`);
 entry.visibility='private';await writeJson(publishedPath(slug),record);
 return {origin,storyId:entry.storyId,changed:true};
}
