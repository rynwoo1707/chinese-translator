import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {bodyLimit,routeLabel} from './http.js';

const MB=1024*1024,origin='https://hoa-tri.example',ADMIN='f'.repeat(64);
const call=(path,init,env)=>worker.fetch(new Request(origin+path,init),env,{});
// A database that answers every query with one row, enough for public reads and a signed-in reader.
const rows=row=>({prepare(){return {bind(){return this;},async first(){return row;},async all(){return {results:[]};},async run(){return {meta:{changes:1}};}};}});
const untouchable={prepare(){throw new Error('The database must not be reached');}};
function expectSecure(response,{pdf=false}={}){
 assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('X-Frame-Options'),'SAMEORIGIN');
 assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 assert.ok(response.headers.get('Cache-Control'));
 if(pdf)assert.equal(response.headers.get('Content-Security-Policy'),null);else assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'.*frame-ancestors 'none'/u);
}

test('JSON, PDF and redirect answers all carry the security headers; only PDFs go without a CSP',async()=>{
 const library=await call('/api/library',{},{DB:rows({id:'story',visibility:'public'})});assert.equal(library.status,200);expectSecure(library);assert.equal(library.headers.get('Cache-Control'),'no-store');
 const refused=await call('/api/stories',{},{DB:rows(null)});assert.equal(refused.status,401);expectSecure(refused);
 const env={DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM chapters')?{title:'Bài 1',story_id:'s',file_key:'reader/c.pdf'}:{id:'s',visibility:'public'};}};}},FILES:{async get(){return {body:new TextEncoder().encode('%PDF-1.7')};}}};
 const pdf=await call('/api/chapter-file/chapter-1',{},env);assert.equal(pdf.status,200);assert.equal(pdf.headers.get('Content-Type'),'application/pdf');expectSecure(pdf,{pdf:true});
 assert.equal(decodeURIComponent(pdf.headers.get('Content-Disposition').split("UTF-8''")[1]),'Bài 1.vi.pdf');
 // Response.redirect() has immutable headers: the answer is copied, keeping its status and Location.
 const redirect=await call('/api/auth/google/callback',{},{});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('Location'),origin+'/#library');expectSecure(redirect);
});

test('Every Set-Cookie line survives the security headers',async()=>{
 const start=await call('/api/auth/google/start?accept_terms=1',{},{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});
 assert.equal(start.status,302);assert.equal(start.headers.getSetCookie().length,2);expectSecure(start);
 assert.ok(start.headers.getSetCookie().every(line=>/HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u.test(line)));
});

test('A declared body over the route limit is refused with 413 before anything reads it',async()=>{
 let pulled=0;const stream=()=>new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(1024));}});
 for(const [path,size] of [['/api/requests',26*MB+1],['/api/my/study/history',32*MB+1],['/api/my/study/ocr',4*MB+1],['/api/stories/s/cover',6*MB+1],['/api/auth/register',64*1024+1],['/api/admin/login',64*1024+1],['/api/my/study/translate',8*MB+1]]){
  const request=new Request(origin+path,{method:'POST',headers:{'Content-Length':String(size),Cookie:'cat_hien_session=token',Origin:origin},body:stream(),duplex:'half'});
  const response=await worker.fetch(request,{DB:untouchable},{});
  assert.equal(response.status,413,path);const body=await response.json();assert.equal(body.code,'too_large');assert.match(body.error,/quá lớn: tối đa \d+ (MB|KB)/u);expectSecure(response);
  assert.equal(request.bodyUsed,false,path);
 }
 assert.equal(pulled<=7,true,'the refused bodies were not read');
 assert.deepEqual([bodyLimit('/api/my/study/pdf-layout/extract'),bodyLimit('/api/jobs'),bodyLimit('/api/jobs/j/pdf-page'),bodyLimit('/api/my/study/books/b/cover'),bodyLimit('/api/me'),bodyLimit('/api/stories/s/chapters'),bodyLimit('/api/admin/setup'),bodyLimit('/api/admin/admins')],[26*MB,26*MB,4*MB,6*MB,64*1024,26*MB,64*1024,64*1024]);
});

test('A body sent without a length is counted while it is read and stops at the limit',async()=>{
 // A chunked upload has no Content-Length; the route starts parsing it and the counter ends it at 26 MB.
 let sent=0,stored=0;const chunk=new Uint8Array(MB);
 const body=new ReadableStream({pull(controller){if(sent>=40){controller.close();return;}sent++;controller.enqueue(chunk);}});
 const env={DB:rows({id:'reader-1',email:'r@example.test',name:'R',picture:''}),FILES:{async put(){stored++;},async delete(){}}};
 const request=new Request(origin+'/api/requests',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=x',Cookie:'cat_hien_session=token'},body,duplex:'half'});
 const response=await worker.fetch(request,env,{});
 assert.equal(response.status,413);assert.equal((await response.json()).code,'too_large');assert.equal(stored,0);assert.ok(sent<=29,`read ${sent} MB of 40`);
 // Within the limit the same counted body parses normally.
 const form=new FormData();form.set('title','Tài liệu');form.set('source_url','https://example.test/sach');
 const small=new Request(origin+'/api/requests',{method:'POST',headers:{Cookie:'cat_hien_session=token'},body:form});
 assert.equal((await worker.fetch(small,env,{})).status,201);
});

test('Requests that change data from another site are refused before routing',async()=>{
 const form=new FormData();form.set('title','x');form.set('source_url','https://example.test/');
 // The admin session cookie and the console's header ride along: neither makes another site's request pass.
 for(const [path,method,body] of [['/api/requests','POST',form],['/api/me','DELETE','{"confirm":"XÓA"}'],['/api/auth/logout','POST',null],['/api/my/study/history/x','DELETE',null],['/api/stories','POST','{}'],['/api/admin/login','POST','{}'],['/api/admin/logout','POST',null],['/api/admin/setup','POST','{}'],['/api/admin/password','POST','{}'],['/api/admin/admins','POST','{}'],['/api/admin/admins/x','DELETE',null]]){
  const response=await call(path,{method,headers:{Origin:'https://evil.example',Cookie:'cat_hien_session=token; cat_hien_admin=admin-session','X-Hoa-Tri-Admin':'1',Authorization:`Bearer ${ADMIN}`},body},{DB:untouchable,ADMIN_TOKEN:ADMIN});
  assert.equal(response.status,403,`${method} ${path}`);assert.equal((await response.json()).error,'Nguồn yêu cầu không hợp lệ.');expectSecure(response);
 }
 // Reads stay open to links from anywhere; a request without Origin (curl, scripts) is not a browser attack.
 assert.equal((await call('/api/library',{headers:{Origin:'https://evil.example'}},{DB:rows({id:'s'})})).status,200);
 const env={DB:rows({id:'reader-1',email:'r@example.test',name:'R',picture:''}),FILES:{async put(){},async delete(){}}};
 assert.equal((await call('/api/requests',{method:'POST',headers:{Cookie:'cat_hien_session=token'},body:form},env)).status,201);
 assert.equal((await call('/api/requests',{method:'POST',headers:{Cookie:'cat_hien_session=token',Origin:origin},body:form},env)).status,201);
});

test('An ADMIN_TOKEN shorter than 32 characters opens nothing except on this machine',async()=>{
 const status=async(base,token,configured)=>(await worker.fetch(new Request(base+'/api/status',{headers:{Authorization:`Bearer ${token}`}}),{ADMIN_TOKEN:configured,DB:untouchable},{})).json();
 assert.deepEqual(await status(origin,'short-admin-token','short-admin-token'),{authenticated:false,adminTokenTooShort:true});
 assert.equal((await worker.fetch(new Request(origin+'/api/jobs',{headers:{Authorization:'Bearer short-admin-token'}}),{ADMIN_TOKEN:'short-admin-token',DB:untouchable},{})).status,401);
 // wrangler dev keeps working with an older, shorter local token; setup generates 64 hex characters.
 for(const local of ['http://127.0.0.1:8787','http://localhost:8787'])assert.equal((await status(local,'short-admin-token','short-admin-token')).authenticated,true,local);
 // Command-line tools sign in with the token itself (Bearer); people use an admin account (admin-auth.test.mjs).
 const tool=await status(origin,ADMIN,ADMIN);assert.deepEqual([tool.authenticated,tool.via,tool.admin],[true,'token',{username:null,name:'ADMIN_TOKEN'}]);
 assert.deepEqual(await status(origin,ADMIN.slice(1)+'0',ADMIN),{authenticated:false});
 assert.deepEqual(await status(origin,ADMIN,undefined),{authenticated:false});
});

test('Only http(s) links with a host are stored for a request; a link of another kind is never copied to a book or listed',async t=>{
 const {sqliteEnvironment,signedIn}=await import('./test-support/sqlite-d1.mjs'),{sqlite,env}=sqliteEnvironment(t,{vars:{ADMIN_TOKEN:ADMIN}}),reader=await signedIn(sqlite);
 // A request saved before links were checked: accepting it makes a book without that link, and the admin list shows none.
 sqlite.prepare('INSERT INTO requests(id,title,source_url,user_id) VALUES(?,?,?,?)').run('legacy','Cũ','javascript:alert(1)',reader.id);
 const admin={Authorization:`Bearer ${ADMIN}`,Origin:origin},accepted=await call('/api/requests/legacy/accept',{method:'POST',headers:admin},env);
 assert.equal(accepted.status,201);const {story_id}=await accepted.json();
 assert.equal(sqlite.prepare('SELECT source_url FROM stories WHERE id=?').get(story_id).source_url,null);
 const send=link=>{const form=new FormData();form.set('title','Sách cần dịch');form.set('source_url',link);return call('/api/requests',{method:'POST',headers:{Cookie:reader.cookie,Origin:origin},body:form},env);};
 for(const link of ['javascript:alert(document.cookie)',' JavaScript:alert(1)','data:text/html,<script>alert(1)</script>','vbscript:msgbox(1)','ftp://example.test/a','//evil.example/x','/thu-vien','http:/thieu-gach.example','https://','http:// cach.example'])assert.equal((await send(link)).status,400,link);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM requests WHERE id<>'legacy'").get().n,0);
 for(const link of ['https://example.test/sach?id=1#chuong-2','HTTP://Example.TEST/a b']){const response=await send(link);assert.equal(response.status,201,link);}
 assert.deepEqual(sqlite.prepare("SELECT source_url FROM requests WHERE id<>'legacy' ORDER BY rowid").all().map(row=>row.source_url),['https://example.test/sach?id=1#chuong-2','http://example.test/a%20b']);
 const listed=await (await call('/api/requests',{headers:admin},env)).json();
 assert.equal(listed.find(row=>row.id==='legacy').source_url,null);assert.deepEqual(listed.filter(row=>row.id!=='legacy').map(row=>row.source_url).sort(),['http://example.test/a%20b','https://example.test/sach?id=1#chuong-2']);
 assert.doesNotMatch(JSON.stringify(listed),/javascript:/iu);
});

test('Logged routes keep their shape but lose ids and hashes',()=>{
 assert.equal(routeLabel('/api/my/study/history/5b1c9a2e-1111-4222-8333-444455556666'),'/api/my/study/history/:id');
 assert.equal(routeLabel(`/api/my/study/sources/${'ab'.repeat(32)}`),'/api/my/study/sources/:id');
 assert.equal(routeLabel('/api/jobs/123/run'),'/api/jobs/:id/run');assert.equal(routeLabel('/api/my/study/pdf-layout/extract'),'/api/my/study/pdf-layout/extract');
});

test('Covers: the ?v=<cover_key> URL is cached for good, any other is revalidated by ETag; parts and covers are not indexed',async()=>{
 let cancelled=0;
 const env={DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('cover_key')?{cover_key:'covers/s/k2'}:sql.includes('FROM chapters')?{title:'Bài 1',story_id:'s',file_key:'reader/c.pdf'}:{id:'s',visibility:'public'};}};}},
  FILES:{async get(key){return key.startsWith('covers/')?{body:new ReadableStream({start(c){c.enqueue(new Uint8Array([0xff,0xd8,0xff]));c.close();},cancel(){cancelled++;}}),httpEtag:'"etag-k2"',httpMetadata:{contentType:'image/jpeg'}}:{body:new TextEncoder().encode('%PDF-1.7')};}}};
 const current=await call('/api/covers/s?v=covers%2Fs%2Fk2',{},env);
 assert.equal(current.status,200);assert.equal(current.headers.get('Cache-Control'),'private, max-age=31536000, immutable');
 assert.equal(current.headers.get('ETag'),'"etag-k2"');assert.equal(current.headers.get('Content-Type'),'image/jpeg');assert.equal(current.headers.get('X-Robots-Tag'),'noindex');
 assert.deepEqual([...new Uint8Array(await current.arrayBuffer())],[0xff,0xd8,0xff]);
 // An old key (the cover was replaced) or no key: the browser must ask again, and an unchanged cover costs a 304.
 for(const path of ['/api/covers/s?v=covers%2Fs%2Fk1','/api/covers/s']){
  const response=await call(path,{},env);assert.equal(response.headers.get('Cache-Control'),'no-cache',path);assert.equal(response.headers.get('X-Robots-Tag'),'noindex',path);
 }
 const unchanged=await call('/api/covers/s',{headers:{'If-None-Match':'"etag-k2"'}},env);
 assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');assert.equal(cancelled,1,'the stored image is not read for a 304');
 assert.equal((await call('/api/covers/s',{headers:{'If-None-Match':'"etag-k1"'}},env)).status,200);
 const part=await call('/api/chapter-file/chapter-1',{},env);assert.equal(part.status,200);assert.equal(part.headers.get('X-Robots-Tag'),'noindex');
});
