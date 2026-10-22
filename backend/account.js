// Deleting an account: the student from the account page (DELETE /api/me), or an admin (DELETE /api/users/:id), who
// can also lock and unlock one (PATCH /api/users/:id {disabled}) and create a password reset link for it
// (POST /api/users/:id/password-reset). Everything private goes: history, study books, whole-book runs, originals and
// translations, requests and their files, sessions, password reset links. Books published to the shared library stay,
// without the owner's name.
import {json,crossOrigin,originRefused,logEvent} from './http.js';
import {currentReader,verifyPassword,failuresLocked,failureKey,clearSessionCookie,signedInWithin,createPasswordReset} from './reader-auth.js';
import {rateLimit} from './rate-limit.js';
import {removeKeys,removePrefix} from './study-history.js';

const PRIVATE_STORIES="SELECT id FROM stories WHERE owner_user_id=?1 AND visibility='private'";
// A job of a private book that an admin run is processing would write files back after they were removed.
const BUSY=`EXISTS (SELECT 1 FROM jobs WHERE story_id IN (${PRIVATE_STORIES}) AND lease_until>?2)`;
// The Vietnamese word can be typed with either tone placement (XÓA, XOÁ), in any case.
const confirmed=value=>['XÓA','XOÁ'].includes(String(value||'').normalize('NFC').trim().toUpperCase());
// A Google-only account has no password to confirm with: a sign-in this recent stands in for one, so a session left
// open on a shared school computer cannot delete the account.
const REAUTH_MS=10*60*1000;

// True while the account exists and its deletion has not started. A request that was already running when the deletion
// started can still write files after the deletion cleared the account's folders: it asks this after writing and
// removes what it wrote when the answer is no (see keepWritten). Without a database answer it says yes, so a storage
// hiccup never removes a student's work.
export async function accountActive(env,userId){
 if(typeof env?.DB?.prepare!=='function')return true;
 try{return Boolean(await env.DB.prepare('SELECT 1 AS active FROM reader_users WHERE id=? AND deleting_at IS NULL').bind(userId).first());}
 catch(error){logEvent('account_check_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});return true;}
}
// The answer to a request whose results were removed because its account was deleted meanwhile; extra keeps what the
// browser still needs to know (the tokens a Gemini call already spent).
export const accountDeleted=(extra={})=>json({error:'Tài khoản này vừa bị xóa nên kết quả của thao tác không được lưu.',code:'account_deleted',...extra},410);
// Call after writing files for userId: null while the account is active, else the files are removed again and the
// answer for a deleted account is returned.
export async function keepWritten(env,userId,keys,extra){
 if(await accountActive(env,userId))return null;
 await removeKeys(env,keys);return accountDeleted(extra);
}

// 'deleted', 'missing' (no such account) or 'busy' (one of its private books is being translated right now).
export async function deleteAccount(env,userId){
 const now=Date.now(),db=env.DB,exists=async()=>Boolean(await db.prepare('SELECT id FROM reader_users WHERE id=?').bind(userId).first());
 if(!await exists())return 'missing';
 // Blocked first, before anything is listed for removal: its sessions stop working (currentReader), so no new request
 // adds a row or a file behind the lists below. A request already running checks accountActive after its writes.
 const blocked=await db.prepare(`UPDATE reader_users SET deleting_at=COALESCE(deleting_at,CURRENT_TIMESTAMP) WHERE id=?1 AND NOT ${BUSY}`).bind(userId,now).run();
 if(!blocked?.meta?.changes)return await exists()?'busy':'missing';
 // A deletion that cannot finish gives the account back as it was.
 const unblock=()=>db.prepare('UPDATE reader_users SET deleting_at=NULL WHERE id=?').bind(userId).run().catch(error=>logEvent('account_unblock_error',{name:error?.name,message:String(error?.message||'').slice(0,200)}));
 let stories,chapters,jobs,requests,results;
 try{
  const rows=async sql=>(await db.prepare(sql).bind(userId).all()).results||[];
  stories=await rows("SELECT id,cover_key FROM stories WHERE owner_user_id=?1 AND visibility='private'");chapters=await rows(`SELECT file_key,text_key FROM chapters WHERE story_id IN (${PRIVATE_STORIES})`);
  jobs=await rows(`SELECT id,file_key,source_key,translation_key FROM jobs WHERE story_id IN (${PRIVATE_STORIES})`);requests=await rows('SELECT file_key FROM requests WHERE user_id=?1 AND file_key IS NOT NULL');
  // The wrong-password counts kept for the account itself (reader-auth.js): its signed-in checks and its email (a
  // Google-only account's too: passwords typed for it are counted as for any email). Those of a network, or of an email
  // with a network or a browser, are hashed with what they count and drain within a day.
  const email=(await rows('SELECT COALESCE(c.email_normalized,LOWER(TRIM(u.email))) AS email FROM reader_users u LEFT JOIN reader_credentials c ON c.user_id=u.id WHERE u.id=?1'))[0]?.email,failures=await Promise.all([`password:${userId}`,`login-email:${email||userId}`].map(failureKey));
  // One transaction, each statement guarded: if a run took a lease since the check above, nothing changes. Rows are
  // removed child first, so the result does not depend on foreign keys being enforced.
  const guarded=(sql,...more)=>db.prepare(`${sql} AND NOT ${BUSY}`).bind(userId,now,...more);
  results=await db.batch([
   guarded('DELETE FROM study_sessions WHERE user_id=?1'),
   // Whole-book runs: the title, file name and glossary of a private book.
   guarded('DELETE FROM book_jobs WHERE user_id=?1'),
   guarded('DELETE FROM requests WHERE user_id=?1'),
   guarded(`DELETE FROM chapters WHERE story_id IN (${PRIVATE_STORIES})`),
   guarded(`DELETE FROM jobs WHERE story_id IN (${PRIVATE_STORIES})`),
   guarded("DELETE FROM stories WHERE owner_user_id=?1 AND visibility='private'"),
   guarded('UPDATE stories SET owner_user_id=NULL WHERE owner_user_id=?1'),
   guarded('DELETE FROM reader_sessions WHERE user_id=?1'),
   guarded('DELETE FROM reader_password_resets WHERE user_id=?1'),
   guarded('DELETE FROM reader_credentials WHERE user_id=?1'),
   // Daily counts and leases keyed by the account id; the per-IP registration count stays, it is not about this account.
   guarded("DELETE FROM rate_limits WHERE key IN ('upload:'||?1,'pdf-extract:'||?1,'pdf-render:'||?1,'pdf-source:'||?1,'history:'||?1)"),
   guarded("DELETE FROM service_leases WHERE key='pdf:'||?1"),
   guarded('DELETE FROM auth_failures WHERE key IN (?3,?4)',...failures),
   guarded('DELETE FROM reader_users WHERE id=?1')
  ]);
 }catch(error){await unblock();throw error;}
 if(!results.at(-1)?.meta?.changes){if(await exists()){await unblock();return 'busy';}return 'missing';}
 // Storage goes after the rows: a failure here leaves files nothing points to (logged), never a broken account.
 await removeKeys(env,[
  ...chapters.flatMap(row=>[row.file_key,row.text_key]),...requests.map(row=>row.file_key),...stories.map(row=>row.cover_key),
  ...jobs.flatMap(job=>[job.file_key,job.source_key,job.translation_key,`processing/${job.id}.json`,`books/${job.id}.txt`,`texts/${job.id}/source.txt`,`texts/${job.id}/translation.txt`])
 ]);
 for(const prefix of [`study/${userId}/`,...stories.map(story=>`covers/${story.id}/`),...jobs.map(job=>`split/${job.id}/`)])await removePrefix(env,prefix);
 return 'deleted';
}

export async function accountRoute(request,env,url,path){
 if(path!=='/api/me'||request.method!=='DELETE')return null;
 if(crossOrigin(request,url))return originRefused();
 const reader=await currentReader(request,env);if(!reader)return json({error:'Hãy đăng nhập để xóa tài khoản.'},401);
 const limit=await rateLimit(env,[{binding:'AUTH_LIMITER',key:`account:${reader.id}`}]);if(limit)return limit;
 const body=await request.json();
 if(!confirmed(body?.confirm))return json({error:'Hãy nhập đúng chữ XÓA để xác nhận.',code:'confirm_required'},400);
 // An account with a password confirms with it (wrong answers are counted as at login); a Google-only account with a
 // recent sign-in.
 const password=await verifyPassword(env,reader.id,body?.password);
 if(password.status==='missing')return json({error:'Hãy nhập mật khẩu hiện tại để xóa tài khoản.',code:'password_required'},400);
 if(password.status==='locked')return failuresLocked(password.lock);
 if(password.status==='wrong')return json({error:'Mật khẩu không đúng.',code:'wrong_password'},403);
 if(password.status==='none'&&!await signedInWithin(request,env,REAUTH_MS))return json({error:'Hãy đăng xuất rồi đăng nhập lại bằng Google, sau đó xóa tài khoản trong vòng 10 phút.',code:'reauth_required'},403);
 if(await deleteAccount(env,reader.id)==='busy')return json({error:'Một tài liệu của bạn đang được xử lý. Hãy thử lại sau vài phút.',code:'busy'},409);
 return new Response(null,{status:204,headers:{'Set-Cookie':clearSessionCookie(url),'Cache-Control':'no-store'}});
}

// Called after the admin check.
export async function adminAccountRoute(request,env,path){
 // A student who forgot a password gets a one-time link from an admin or teacher: no e-mail is sent.
 const reset=path.match(/^\/api\/users\/([^/]+)\/password-reset$/u);
 if(reset){
  if(request.method!=='POST')return json({error:'Phương thức không được hỗ trợ.'},405);
  const link=await createPasswordReset(env,reset[1]);
  if(link.refused==='missing')return json({error:'Không tìm thấy tài khoản.'},404);
  if(link.refused==='google')return json({error:'Tài khoản này đăng nhập bằng Google nên không có mật khẩu để đặt lại.',code:'no_password'},409);
  if(link.refused==='disabled')return json({error:'Tài khoản này đang bị tạm khóa. Hãy mở khóa trước khi tạo liên kết đặt lại mật khẩu.',code:'account_disabled'},409);
  // The token is in the fragment, which browsers never send to a server or in a Referer.
  return json({resetUrl:`/#dat-lai-mat-khau?token=${link.token}`,expiresAt:link.expiresAt},201);
 }
 const match=path.match(/^\/api\/users\/([^/]+)$/u);if(!match)return null;
 const id=match[1];
 if(request.method==='DELETE'){
  const outcome=await deleteAccount(env,id);
  if(outcome==='missing')return json({error:'Không tìm thấy tài khoản.'},404);
  if(outcome==='busy')return json({error:'Một tài liệu của người này đang được xử lý. Hãy thử lại sau vài phút.',code:'busy'},409);
  return json({ok:true});
 }
 if(request.method==='PATCH'){
  const body=await request.json();if(typeof body?.disabled!=='boolean')return json({error:'Hãy chọn khóa hoặc mở khóa tài khoản.'},400);
  // Locking also ends the account's sessions and its unused password reset links, everything that could sign it in
  // except the password; currentReader refuses a locked account in any case.
  const results=await env.DB.batch([
   env.DB.prepare('UPDATE reader_users SET disabled_at=CASE WHEN ?2 THEN COALESCE(disabled_at,CURRENT_TIMESTAMP) ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?1').bind(id,body.disabled?1:0),
   ...(body.disabled?[env.DB.prepare('DELETE FROM reader_sessions WHERE user_id=?').bind(id),env.DB.prepare('DELETE FROM reader_password_resets WHERE user_id=?').bind(id)]:[])
  ]);
  if(!results[0]?.meta?.changes)return json({error:'Không tìm thấy tài khoản.'},404);
  return json({ok:true,disabled:body.disabled});
 }
 return json({error:'Phương thức không được hỗ trợ.'},405);
}
