// The admin console's lists. Each row carries what a list shows, never a document's text: lists are paged (limit,
// default 100, at most 500; offset), answer a JSON array as before, and add X-Next-Offset when more rows follow. The text,
// glossary and warnings of one item come from its own detail route (GET /api/stories/:id, GET /api/jobs/:id).
import {json} from './http.js';

const DEFAULT_LIMIT=100,MAX_LIMIT=500,MAX_IDS=100;
const JOB_STATUSES=new Set(['uploaded','splitting','prepared','ocr','translating','assembling','review','published','failed']);
function paging(url){
 const number=name=>Number.parseInt(url.searchParams.get(name)??'',10);
 return {limit:Math.min(MAX_LIMIT,Math.max(1,number('limit')||DEFAULT_LIMIT)),offset:Math.min(1_000_000,Math.max(0,number('offset')||0))};
}
// One row more than the page is read, to know whether another page follows.
const pageOf=(rows,{limit,offset})=>json(rows.slice(0,limit),200,rows.length>limit?{'X-Next-Offset':String(offset+limit)}:{});
const list=value=>String(value||'').split(',').map(item=>item.trim()).filter(Boolean);

// Library books first (the console manages them), then students' own books, newest first in each. A library book keeps
// its glossary in the row (the console's glossary editor reads it; library books are few and made by the admin); a
// student's book does not.
const STORY_COLUMNS="s.id,s.title,s.author,s.genre,s.cover_key,s.cover_page,s.source_url,s.owner_user_id,s.visibility,s.created_at,CASE WHEN s.owner_user_id IS NULL THEN s.glossary END AS glossary,u.name AS owner_name,u.email AS owner_email,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS chapters";
const STORY_ORDER='CASE WHEN owner_user_id IS NULL THEN 0 ELSE 1 END,created_at DESC,id';
async function stories(env,url){
 const page=paging(url),scope=url.searchParams.get('scope'),where=scope==='library'?'WHERE owner_user_id IS NULL':scope==='personal'?'WHERE owner_user_id IS NOT NULL':'';
 const rows=(await env.DB.prepare(`SELECT ${STORY_COLUMNS} FROM (SELECT id,owner_user_id,created_at FROM stories ${where} ORDER BY ${STORY_ORDER} LIMIT ? OFFSET ?) page JOIN stories s ON s.id=page.id LEFT JOIN reader_users u ON u.id=s.owner_user_id ORDER BY CASE WHEN page.owner_user_id IS NULL THEN 0 ELSE 1 END,page.created_at DESC,page.id`).bind(page.limit+1,page.offset).all()).results;
 return pageOf(rows,page);
}
// Students' books, newest account first (?user=<id>: one student's).
async function userLibrary(env,url){
 const page=paging(url),user=url.searchParams.get('user');
 const rows=(await env.DB.prepare(`SELECT s.id,s.title,s.author,s.genre,s.cover_key,s.source_url,s.owner_user_id,s.visibility,s.created_at,u.email AS owner_email,u.name AS owner_name,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS chapters
  FROM (SELECT s.id,u.created_at AS joined,s.created_at FROM stories s JOIN reader_users u ON u.id=s.owner_user_id ${user?'WHERE s.owner_user_id=?':''} ORDER BY u.created_at DESC,s.created_at DESC,s.id LIMIT ? OFFSET ?) page
  JOIN stories s ON s.id=page.id JOIN reader_users u ON u.id=s.owner_user_id ORDER BY page.joined DESC,page.created_at DESC,page.id`).bind(...(user?[user]:[]),page.limit+1,page.offset).all()).results;
 return pageOf(rows,page);
}
// Jobs, newest first. ?ids=a,b (at most 100) answers just those rows, which is what a console waiting on running jobs
// polls; ?status=translating,ocr filters by status. has_translation and warning_count stand in for the text and warnings.
const JOB_COLUMNS="j.id,j.story_id,j.filename,j.file_key,j.mime,j.status,j.progress,j.error,j.lease_until,j.source_key,j.translation_key,j.prompt_tokens,j.output_tokens,j.total_tokens,j.ai_requests,j.ai_cache_hits,j.model,j.prompt_version,j.translated_at,j.reviewed_at,j.published_at,j.source_sha256,j.created_at,j.mode,j.thinking_tokens,CASE WHEN j.translation_key IS NOT NULL OR j.translation<>'' THEN 1 ELSE 0 END AS has_translation,CASE WHEN json_valid(j.warnings) AND json_type(j.warnings)='array' THEN json_array_length(j.warnings) ELSE 0 END AS warning_count,s.title AS story_title,s.genre";
async function jobs(env,url){
 const page=paging(url),ids=list(url.searchParams.get('ids')).slice(0,MAX_IDS),statuses=list(url.searchParams.get('status')).filter(status=>JOB_STATUSES.has(status)),where=[],args=[];
 if(url.searchParams.has('ids')){if(!ids.length)return json([]);where.push(`j.id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
 if(statuses.length){where.push(`j.status IN (${statuses.map(()=>'?').join(',')})`);args.push(...statuses);}
 const rows=(await env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM jobs j JOIN stories s ON s.id=j.story_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY j.created_at DESC,j.id LIMIT ? OFFSET ?`).bind(...args,page.limit+1,page.offset).all()).results;
 return pageOf(rows,page);
}
// One item with everything its old list row had: a story's glossary and context, a job's text preview and warnings.
async function storyDetail(env,id){
 const row=await env.DB.prepare('SELECT s.*,u.name AS owner_name,u.email AS owner_email,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS chapters FROM stories s LEFT JOIN reader_users u ON u.id=s.owner_user_id WHERE s.id=?').bind(id).first();
 return row?json(row):json({error:'Không tìm thấy tài liệu.'},404);
}
async function jobDetail(env,id){
 const row=await env.DB.prepare('SELECT j.*,s.title AS story_title,s.genre FROM jobs j JOIN stories s ON s.id=j.story_id WHERE j.id=?').bind(id).first();
 return row?json(row):json({error:'Không tìm thấy bản dịch.'},404);
}
export async function adminListRoute(request,env,url,path){
 if(request.method!=='GET')return null;
 if(path==='/api/stories')return stories(env,url);
 if(path==='/api/user-library')return userLibrary(env,url);
 if(path==='/api/jobs')return jobs(env,url);
 const story=path.match(/^\/api\/stories\/([^/]+)$/u);if(story)return storyDetail(env,story[1]);
 const job=path.match(/^\/api\/jobs\/([^/]+)$/u);if(job)return jobDetail(env,job[1]);
 return null;
}
