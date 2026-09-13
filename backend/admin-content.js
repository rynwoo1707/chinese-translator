import mammoth from 'mammoth/mammoth.browser.js';
import {previewWebSource,importWebSeries} from './web-import.js';
const json=(body,status=200)=>Response.json(body,{status});
const required=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Nội dung trống hoặc vượt giới hạn.');return value.trim();};
export async function readPublication(file){
 if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('Chọn tệp từ 1 byte đến 25 MB.');
 const ext=file.name.split('.').pop().toLowerCase(),bytes=await file.arrayBuffer();
 if(ext==='pdf'){
  if(!new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-'))throw new Error('Tệp PDF không hợp lệ.');
  return {mime:'application/pdf',content:'',bytes};
 }
 let content;
 if(ext==='txt')content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 else if(ext==='docx')content=(await mammoth.extractRawText({arrayBuffer:bytes})).value;
 else throw new Error('Hỗ trợ TXT (UTF-8), DOCX và PDF.');
 return {mime:'text/plain',content:required(content,500000),bytes};
}
async function deleteJobFiles(job,env){
 if(job.file_key)await env.FILES.delete(job.file_key);
 await env.FILES.delete([`processing/${job.id}.json`,`books/${job.id}.txt`,`texts/${job.id}/source.txt`,`texts/${job.id}/translation.txt`]);
 let cursor;do{const page=await env.FILES.list({prefix:`split/${job.id}/`,...(cursor?{cursor}:{})});if(page.objects.length)await env.FILES.delete(page.objects.map(o=>o.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);
}
export async function adminContent(request,env,path){
 const method=request.method;
 if(path==='/api/web-import/preview'&&method==='POST'){
  const body=await request.json();return json(await previewWebSource(body.source_url));
 }
 if(path==='/api/web-import'&&method==='POST')return json(await importWebSeries(env,await request.json()),201);
 if(path==='/api/import-preview'&&method==='POST'){
  const file=(await request.formData()).get('file'),data=await readPublication(file);
  return json({mime:data.mime,content:data.content});
 }
 const chapters=path.match(/^\/api\/stories\/([^/]+)\/chapters$/);
 if(chapters){
  const sid=chapters[1];if(!await env.DB.prepare('SELECT id FROM stories WHERE id=?').bind(sid).first())return json({error:'Không tìm thấy truyện.'},404);
  if(method==='GET')return json((await env.DB.prepare('SELECT id,title,mime,created_at FROM chapters WHERE story_id=? ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END,position,created_at,id').bind(sid).all()).results);
  if(method==='POST'){
   const form=await request.formData();if(form.get('confirmed')!=='true')throw new Error('Cần xác nhận đã kiểm tra nội dung trước khi đăng.');
   const title=required(form.get('title'),200),file=form.get('file'),data=await readPublication(file),cid=crypto.randomUUID();
   const content=data.mime==='application/pdf'?'':required(form.get('content')??data.content,500000);
   const key=data.mime==='application/pdf'?`reader/${cid}.pdf`:null;
   if(key)await env.FILES.put(key,data.bytes,{httpMetadata:{contentType:data.mime}});
   try{await env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,file_key,mime) VALUES(?,?,?,?,?,?)').bind(cid,sid,title,content,key,data.mime).run();}
   catch(e){if(key)await env.FILES.delete(key);throw e;}
   return json({id:cid},201);
  }
 }
 const chapter=path.match(/^\/api\/chapters\/([^/]+)$/);
 if(chapter&&method==='DELETE'){
  const c=await env.DB.prepare('SELECT * FROM chapters WHERE id=?').bind(chapter[1]).first();if(!c)return json({error:'Không tìm thấy chương.'},404);
  const statements=[env.DB.prepare('DELETE FROM chapters WHERE id=?').bind(c.id)];
  if(c.job_id)statements.push(env.DB.prepare("UPDATE jobs SET status='review' WHERE id=? AND status='published'").bind(c.job_id));
  await env.DB.batch(statements);if(c.file_key)await env.FILES.delete(c.file_key);if(c.text_key)await env.FILES.delete(c.text_key);return json({ok:true});
 }
 const jobMatch=path.match(/^\/api\/jobs\/([^/]+)$/);
 if(jobMatch&&method==='DELETE'){
  const job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobMatch[1]).first();if(!job)return json({error:'Không tìm thấy tài liệu.'},404);
  const linked=(await env.DB.prepare('SELECT text_key FROM chapters WHERE job_id=? AND text_key IS NOT NULL').bind(job.id).all()).results;
  const now=Date.now();
  const result=await env.DB.batch([
   env.DB.prepare('DELETE FROM chapters WHERE job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_until<?)').bind(job.id,job.id,now),
   env.DB.prepare('DELETE FROM jobs WHERE id=? AND lease_until<?').bind(job.id,now)
  ]);
  if(!result[1].meta.changes)return json({error:'Tài liệu đang xử lý. Hãy đợi lượt hiện tại kết thúc rồi xóa.'},409);
  await deleteJobFiles(job,env);for(const chapter of linked)await env.FILES.delete(chapter.text_key);return json({ok:true});
 }
 const storyMatch=path.match(/^\/api\/stories\/([^/]+)$/);
 if(storyMatch&&method==='DELETE'){
  const sid=storyMatch[1],story=await env.DB.prepare('SELECT * FROM stories WHERE id=?').bind(sid).first();if(!story)return json({error:'Không tìm thấy truyện.'},404);
  const jobs=(await env.DB.prepare('SELECT * FROM jobs WHERE story_id=?').bind(sid).all()).results;
  const files=(await env.DB.prepare('SELECT file_key,text_key FROM chapters WHERE story_id=? AND (file_key IS NOT NULL OR text_key IS NOT NULL)').bind(sid).all()).results;
  const now=Date.now(),guard='NOT EXISTS (SELECT 1 FROM jobs active WHERE active.story_id=? AND active.lease_until>=?)';
  const results=await env.DB.batch([
   env.DB.prepare(`DELETE FROM chapters WHERE story_id=? AND ${guard}`).bind(sid,sid,now),
   env.DB.prepare(`DELETE FROM jobs WHERE story_id=? AND ${guard}`).bind(sid,sid,now),
   env.DB.prepare('DELETE FROM stories WHERE id=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE story_id=?)').bind(sid,sid)
  ]);
  if(!results[2].meta.changes)return json({error:'Truyện có tài liệu đang xử lý. Hãy đợi lượt hiện tại kết thúc rồi xóa.'},409);
  for(const job of jobs)await deleteJobFiles(job,env);
  for(const file of files){if(file.file_key)await env.FILES.delete(file.file_key);if(file.text_key)await env.FILES.delete(file.text_key);}
  let cursor;do{const page=await env.FILES.list({prefix:`covers/${sid}/`,...(cursor?{cursor}:{})});if(page.objects.length)await env.FILES.delete(page.objects.map(o=>o.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);
  return json({ok:true});
 }
 if(/^\/api\/requests\/[^/]+$/.test(path)&&method==='DELETE'){const rid=path.split('/').pop(),item=await env.DB.prepare('SELECT file_key FROM requests WHERE id=?').bind(rid).first();await env.DB.prepare('DELETE FROM requests WHERE id=?').bind(rid).run();if(item?.file_key)await env.FILES.delete(item.file_key);return json({ok:true});}
 return null;
}
