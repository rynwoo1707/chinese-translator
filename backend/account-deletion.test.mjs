import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import {hashToken} from './reader-auth.js';
import {deleteAccount,accountActive} from './account.js';

const origin='https://hoa-tri.example',ADMIN='d1'.repeat(32),PASSWORD='mat-khau-dai',SHA='a'.repeat(64);
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
// R2 lists in pages; the cursor is the last key returned, so removing listed keys never skips the next page.
class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value){this.values.set(key,value);}
 async get(key){return this.values.has(key)?{text:async()=>String(this.values.get(key)),json:async()=>JSON.parse(this.values.get(key))}:null;}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix='',cursor=''}={}){const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)&&key>cursor).sort(),page=keys.slice(0,2);return {objects:page.map(key=>({key})),truncated:keys.length>2,cursor:page.at(-1)};}
}
const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url));
async function environment(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,FILES:new MemoryFiles(),ADMIN_TOKEN:ADMIN};
 // Lan registers through the API, so her password check runs on a real PBKDF2 hash.
 const registered=await worker.fetch(new Request(origin+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({name:'Lan',email:'lan@example.test',password:PASSWORD,acceptTerms:true})}),env,{});
 assert.equal(registered.status,201);
 const lan=sqlite.prepare('SELECT id FROM reader_users').get().id,cookie=registered.headers.getSetCookie()[0].split(';')[0];
 const run=(sql,...args)=>sqlite.prepare(sql).run(...args),put=(...keys)=>{for(const key of keys)env.FILES.values.set(key,'{}');};
 for(const [id,name] of [['user-minh','Minh'],['user-other','Other']])run('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)',id,`sub-${id}`,`${id}@example.test`,name);
 run('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',await hashToken('minh-token'),'user-minh',Date.now()+3600000);
 run('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',await hashToken('other-token'),'user-other',Date.now()+3600000);
 const story=(id,owner,visibility,extra='')=>run(`INSERT INTO stories(id,title,genre,owner_user_id,visibility,source_url,cover_key) VALUES(?,?,?,?,?,?,?)`,id,id,'Giáo dục',owner,visibility,extra||null,`covers/${id}/cover`);
 // Lan's study book with one finished range, its PDF asset and the kept original.
 story('book-lan',lan,'private','study-book:book-lan');put('covers/book-lan/cover');
 run('INSERT INTO chapters(id,story_id,title,content,text_key,file_key,mime,position) VALUES(?,?,?,?,?,?,?,1)','chapter-study','book-lan','Trang 1–3','…',`study/${lan}/session-1/translation.txt`,`study/${lan}/pdf-layout/asset-1/translated.pdf`,'application/pdf');
 run('INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id,library_chapter_id,pdf_asset_id,source_sha256) VALUES(?,?,?,?,?,?,?,?,?)','session-1',lan,'Toán','study/x/state.json','complete','book-lan','chapter-study','asset-1',SHA);
 put(`study/${lan}/session-1/state.json`,`study/${lan}/session-1/translation.txt`,`study/${lan}/pdf-layout/asset-1/manifest.json`,`study/${lan}/pdf-layout/asset-1/original.pdf`,`study/${lan}/pdf-layout/asset-1/translated.pdf`,`study/${lan}/sources/${SHA}.pdf`);
 // A private book made from her request, with its translation job and every file a job leaves behind.
 story('private-lan',lan,'private');put('covers/private-lan/cover');
 run('INSERT INTO jobs(id,story_id,filename,file_key,source_key,translation_key,mime) VALUES(?,?,?,?,?,?,?)','job-private','private-lan','a.txt','uploads/job-private','texts/job-private/source.txt','texts/job-private/translation.txt','text/plain');
 run('INSERT INTO chapters(id,story_id,job_id,title,content,text_key) VALUES(?,?,?,?,?,?)','chapter-private','private-lan','job-private','Phần 1','…','reader/chapter-private.txt');
 put('uploads/job-private','texts/job-private/source.txt','texts/job-private/translation.txt','processing/job-private.json','books/job-private.txt','split/job-private/manifest.json','split/job-private/part-00001.pdf','split/job-private/part-00002.pdf','reader/chapter-private.txt');
 run('INSERT INTO requests(id,title,user_id,file_key,story_id) VALUES(?,?,?,?,?)','request-file','Yêu cầu',lan,'requests/request-file/original','private-lan');put('requests/request-file/original');
 // A book she shared to the public library: it stays, without her name.
 story('public-lan',lan,'public');put('covers/public-lan/cover','uploads/job-public','reader/chapter-public.txt');
 run('INSERT INTO jobs(id,story_id,filename,file_key,mime,status) VALUES(?,?,?,?,?,?)','job-public','public-lan','b.txt','uploads/job-public','text/plain','published');
 run('INSERT INTO chapters(id,story_id,job_id,title,content,text_key) VALUES(?,?,?,?,?,?)','chapter-public','public-lan','job-public','Phần 1','…','reader/chapter-public.txt');
 run('INSERT INTO requests(id,title,user_id,story_id) VALUES(?,?,?,?)','request-link','Yêu cầu công khai',lan,'public-lan');
 // Another student's data must not be touched.
 story('book-other','user-other','private','study-book:book-other');put('covers/book-other/cover',`study/user-other/session-o/state.json`,`study/user-other/sources/${SHA}.pdf`,'requests/request-other/original');
 run('INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id) VALUES(?,?,?,?,?,?)','session-o','user-other','Khác','study/user-other/session-o/state.json','draft','book-other');
 run('INSERT INTO requests(id,title,user_id,file_key) VALUES(?,?,?,?)','request-other','Khác','user-other','requests/request-other/original');
 return {sqlite,env,lan,cookie};
}
const remove=(env,cookie,body,headers={})=>worker.fetch(new Request(origin+'/api/me',{method:'DELETE',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)}),env,{});
const count=(sqlite,sql,...args)=>sqlite.prepare(`SELECT COUNT(*) AS count FROM ${sql}`).get(...args).count;
const otherKeys=['covers/book-other/cover','study/user-other/session-o/state.json',`study/user-other/sources/${SHA}.pdf`,'requests/request-other/original'];

test('Deleting an account asks for XÓA and the password, and refuses other sites and signed-out visitors',async t=>{
 const {sqlite,env,cookie}=await environment(t),before=env.FILES.values.size;
 const answer=async(...args)=>{const response=await remove(...args);return [response.status,(await response.json()).code];};
 assert.deepEqual(await answer(env,null,{confirm:'XÓA',password:PASSWORD}),[401,undefined]);
 assert.deepEqual(await answer(env,cookie,{confirm:'XÓA',password:PASSWORD},{Origin:'https://evil.example'}),[403,'origin']);
 for(const confirm of [undefined,'xoa','XÓA tài khoản'])assert.deepEqual(await answer(env,cookie,{confirm,password:PASSWORD}),[400,'confirm_required'],String(confirm));
 assert.deepEqual(await answer(env,cookie,{confirm:'XÓA'}),[400,'password_required']);
 assert.deepEqual(await answer(env,cookie,{confirm:'XÓA',password:'mat-khau-sai'}),[403,'wrong_password']);
 assert.equal(count(sqlite,'reader_users'),3);assert.equal(env.FILES.values.size,before);
});

test('Deleting an account removes every private row and file, keeps shared books without the owner, and signs out',async t=>{
 const {sqlite,env,lan,cookie}=await environment(t);
 const response=await remove(env,cookie,{confirm:' xóa ',password:PASSWORD});
 assert.equal(response.status,204);assert.match(response.headers.get('Set-Cookie'),/^cat_hien_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/u);
 for(const [table,where] of [['reader_users','id=?'],['reader_sessions','user_id=?'],['reader_credentials','user_id=?'],['study_sessions','user_id=?'],['requests','user_id=?'],['stories','owner_user_id=?']])assert.equal(count(sqlite,`${table} WHERE ${where}`,lan),0,table);
 for(const [table,id] of [['stories','book-lan'],['stories','private-lan'],['chapters','chapter-study'],['chapters','chapter-private'],['jobs','job-private']])assert.equal(count(sqlite,`${table} WHERE id=?`,id),0,id);
 assert.equal(sqlite.prepare('SELECT owner_user_id FROM stories WHERE id=?').get('public-lan').owner_user_id,null);
 assert.equal(count(sqlite,"chapters WHERE id='chapter-public'"),1);assert.equal(count(sqlite,"jobs WHERE id='job-public'"),1);
 // What stays in storage: the public book's files and the other student's files, nothing of Lan's.
 assert.deepEqual([...env.FILES.values.keys()].sort(),['covers/public-lan/cover','reader/chapter-public.txt','uploads/job-public',...otherKeys].sort());
 assert.equal(count(sqlite,"study_sessions WHERE user_id='user-other'"),1);assert.equal(count(sqlite,"requests WHERE user_id='user-other'"),1);assert.equal(count(sqlite,"stories WHERE id='book-other'"),1);
 assert.equal((await (await worker.fetch(new Request(origin+'/api/me',{headers:{Cookie:cookie}}),env,{})).json()).authenticated,false);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('A Google-only account confirms with its session, and an account is not deleted while one of its books is being translated',async t=>{
 const {sqlite,env,lan,cookie}=await environment(t);
 sqlite.prepare("UPDATE jobs SET lease_until=? WHERE id='job-private'").run(Date.now()+60000);const before=env.FILES.values.size;
 const busy=await remove(env,cookie,{confirm:'XÓA',password:PASSWORD});assert.equal(busy.status,409);assert.equal((await busy.json()).code,'busy');
 assert.equal(count(sqlite,'reader_users WHERE id=?',lan),1);assert.equal(count(sqlite,"study_sessions WHERE id='session-1'"),1);assert.equal(env.FILES.values.size,before);
 assert.equal(await deleteAccount(env,lan),'busy');
 // The other tone placement (XOÁ) is the same word; Minh signs in with Google only, so no password is asked.
 const google=await remove(env,'cat_hien_session=minh-token',{confirm:'XOÁ'});assert.equal(google.status,204);assert.equal(count(sqlite,"reader_users WHERE id='user-minh'"),0);
 sqlite.prepare("UPDATE jobs SET lease_until=0 WHERE id='job-private'").run();assert.equal(await deleteAccount(env,lan),'deleted');assert.equal(await deleteAccount(env,lan),'missing');
});

test('An admin deletes an account by id; only the admin can',async t=>{
 const {sqlite,env}=await environment(t);
 const admin=(id,token=ADMIN)=>worker.fetch(new Request(`${origin}/api/users/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`,Origin:origin}}),env,{});
 assert.equal((await admin('user-other','x'.repeat(64))).status,401);assert.equal(count(sqlite,"reader_users WHERE id='user-other'"),1);
 assert.deepEqual(await (await admin('user-other')).json(),{ok:true});
 assert.equal(count(sqlite,"reader_users WHERE id='user-other'"),0);assert.equal(count(sqlite,"stories WHERE id='book-other'"),0);
 for(const key of otherKeys)assert.equal(env.FILES.values.has(key),false,key);
 assert.equal((await admin('user-other')).status,404);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('A Google-only account is deleted only within 10 minutes of signing in; a password stays enough for the others',async t=>{
 const {sqlite,env,lan,cookie}=await environment(t),signedIn=(user,minutes)=>sqlite.prepare(`UPDATE reader_sessions SET created_at=datetime('now','-${minutes} minutes') WHERE user_id=?`).run(user);
 // A session left open on a shared computer: the next person types XÓA, and nothing happens.
 signedIn('user-minh',11);const stale=await remove(env,'cat_hien_session=minh-token',{confirm:'XÓA'});
 assert.equal(stale.status,403);assert.deepEqual(await stale.json(),{error:'Hãy đăng xuất rồi đăng nhập lại bằng Google, sau đó xóa tài khoản trong vòng 10 phút.',code:'reauth_required'});
 assert.equal(count(sqlite,"reader_users WHERE id='user-minh'"),1);
 signedIn('user-minh',9);assert.equal((await remove(env,'cat_hien_session=minh-token',{confirm:'XÓA'})).status,204);assert.equal(count(sqlite,"reader_users WHERE id='user-minh'"),0);
 signedIn(lan,60);assert.equal((await remove(env,cookie,{confirm:'XÓA',password:PASSWORD})).status,204,'an account with a password confirms with it');
});

test('Deletion blocks the account before it lists what to remove, and gives it back when it cannot finish',async t=>{
 const {sqlite,env,lan,cookie}=await environment(t);
 const signedIn=async()=>(await (await worker.fetch(new Request(origin+'/api/me',{headers:{Cookie:cookie}}),env,{})).json()).authenticated;
 sqlite.prepare('UPDATE reader_users SET deleting_at=CURRENT_TIMESTAMP WHERE id=?').run(lan);
 assert.equal(await signedIn(),false,'a blocked account takes no new request');assert.equal(await accountActive(env,lan),false);
 sqlite.prepare('UPDATE reader_users SET deleting_at=NULL WHERE id=?').run(lan);
 assert.equal(await signedIn(),true);assert.equal(await accountActive(env,lan),true);assert.equal(await accountActive(env,'no-such-user'),false);
 assert.equal(await accountActive({},lan),true,'without a database nothing is removed');
 // When the rows to clean are listed, the account is already blocked. A run then takes a lease on one of her books:
 // nothing is removed and the account works again.
 const {prepare,batch}=env.DB,blockedWhenListed=[];
 env.DB.prepare=sql=>{if(sql.startsWith('SELECT id,cover_key FROM stories'))blockedWhenListed.push(Boolean(sqlite.prepare('SELECT deleting_at FROM reader_users WHERE id=?').get(lan).deleting_at));return prepare(sql);};
 env.DB.batch=async statements=>{sqlite.prepare("UPDATE jobs SET lease_until=? WHERE id='job-private'").run(Date.now()+60000);return batch(statements);};
 const before=env.FILES.values.size;
 assert.equal(await deleteAccount(env,lan),'busy');assert.deepEqual(blockedWhenListed,[true]);
 assert.equal(await signedIn(),true,'given back');assert.equal(env.FILES.values.size,before);assert.equal(count(sqlite,'study_sessions WHERE user_id=?',lan),1);
 env.DB.batch=batch;sqlite.prepare("UPDATE jobs SET lease_until=0 WHERE id='job-private'").run();
 assert.equal(await deleteAccount(env,lan),'deleted');assert.deepEqual(blockedWhenListed,[true,true]);assert.equal(await accountActive(env,lan),false);
});

// A request that is already running when the account is deleted: its PDF service call or upload waits on `gate`
// (entered tells the test it is waiting), the account is deleted meanwhile, then the request writes its files.
function gated(){let entered,release;const reached=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});return {reached,gate,entered,release};}
const PNG='data:image/png;base64,AA==',SERVICE={PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test/v1/',PDF_LAYOUT_SERVICE_TOKEN:'service-secret'};
const pdfDocument=number=>({version:1,totalPages:3,pages:[{number,width:600,height:800,background:PNG,original:PNG,blocks:[{id:`p${number}-b0`,source:'定义向量。',box:[20,20,200,80],fontSize:12}]}]});
const lanKeys=(env,lan)=>[...env.FILES.values.keys()].filter(key=>key.startsWith(`study/${lan}/`));

test('An extraction or export still running when the account is deleted removes what it writes afterwards',async t=>{
 const {sqlite,env,lan,cookie}=await environment(t);Object.assign(env,SERVICE);
 const call=(path,init)=>worker.fetch(new Request(origin+path,{...init,headers:{Origin:origin,Cookie:cookie,...init.headers}}),env,{});
 let step=gated();
 t.mock.method(globalThis,'fetch',async url=>{step.entered();await step.gate;return String(url).endsWith('/render')?Response.json({pdfBase64:btoa('%PDF-1.7 vi'),report:[]}):Response.json({document:pdfDocument(2),originalPdfBase64:btoa('%PDF-1.7 page 2')});});
 // Extraction: up to 280 s at the service, then the manifest, the selected pages and the whole original are written.
 const form=new FormData();form.set('file',new File(['%PDF-1.7\nthree pages'],'toan.pdf',{type:'application/pdf'}));form.set('pages','2');
 const extracting=call('/api/my/study/pdf-layout/extract',{method:'POST',body:form});
 await step.reached;assert.equal(await deleteAccount(env,lan),'deleted');step.release();
 const extracted=await extracting;assert.equal(extracted.status,410);assert.equal((await extracted.json()).code,'account_deleted');
 assert.deepEqual(lanKeys(env,lan),[]);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0);
 // Export: the Vietnamese PDF and the saved state are written after the service answers.
 const again=await environment(t);Object.assign(again.env,SERVICE);step=gated();
 const assetId='11111111-1111-4111-8111-111111111111',stateKey=`study/${again.lan}/session-2/state.json`;
 again.env.FILES.values.set(`study/${again.lan}/pdf-layout/${assetId}/manifest.json`,JSON.stringify(pdfDocument(1)));
 again.env.FILES.values.set(stateKey,JSON.stringify({complete:true,translationParts:['Định nghĩa vectơ.'],pdfLayout:{assetId}}));
 again.sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id,library_chapter_id) VALUES(?,?,?,?,?,?,?)').run('session-2',again.lan,'Toán',stateKey,'complete','book-lan','chapter-study');
 const exporting=worker.fetch(new Request(origin+'/api/my/study/pdf-layout/render',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:again.cookie},body:JSON.stringify({assetId,historyId:'session-2'})}),again.env,{});
 await step.reached;assert.equal(await deleteAccount(again.env,again.lan),'deleted');step.release();
 const exported=await exporting;assert.equal(exported.status,410);assert.deepEqual(lanKeys(again.env,again.lan),[]);
});

test('A whole original still uploading when the account is deleted is removed once stored',async t=>{
 const {env,lan,cookie}=await environment(t),bytes=new TextEncoder().encode('%PDF-1.7\nwhole book\n%%EOF'),sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const step=gated(),put=env.FILES.put.bind(env.FILES);env.FILES.put=async(key,value,options)=>{if(key.includes('/sources/')){step.entered();await step.gate;}return put(key,value,options);};
 const uploading=worker.fetch(new Request(`${origin}/api/my/study/sources/${sha}`,{method:'PUT',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/pdf','Content-Length':String(bytes.length),'X-PDF-Pages':'3','X-Source-Filename':'sach.pdf'},body:bytes}),env,{});
 await step.reached;assert.equal(await deleteAccount(env,lan),'deleted');assert.deepEqual(lanKeys(env,lan),[]);step.release();
 const uploaded=await uploading;assert.equal(uploaded.status,410);assert.equal((await uploaded.json()).code,'account_deleted');
 assert.deepEqual(lanKeys(env,lan),[],'nothing of the deleted account is left in storage');
});
