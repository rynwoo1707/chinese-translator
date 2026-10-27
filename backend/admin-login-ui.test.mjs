import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';

// The admin sign-in in a real browser engine: index.html and every script and stylesheet come from frontend/ on disk,
// served with the Content-Security-Policy of frontend/_headers; every /api request is answered here by a small model of
// backend/admin-auth.js (nothing reaches a server). The session is a real cookie (HttpOnly, SameSite=Strict, Path=/api/)
// set by these answers, and, as on the server, it counts only on a request carrying X-Hoa-Tri-Admin: 1. Skipped when
// Microsoft Edge is missing.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://localhost:4893';
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(readFileSync(new URL('_headers',frontend),'utf8'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
const TOKEN='f'.repeat(64),PASSWORD='mai-hoa-no-som-tren-doi-7',WRONG='Tên đăng nhập hoặc mật khẩu không đúng.',ENDED='Phiên quản trị đã hết hạn. Hãy đăng nhập lại.';
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());

// Waits here, outside the page, until check() holds (what the model of the server has seen).
async function until(check,timeout=10000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Đợi quá lâu.');await new Promise(resolve=>setTimeout(resolve,25));}}
// The server side: admin accounts, sessions by cookie, and what every /api request carried. job: the one job j1
// ({mode,status}), else the one POST /api/jobs makes; runDelay: how long a translation step (POST /run) takes. The
// session is a session cookie (no Max-Age) and a new password, an admin added or removed are confirmed with the admin's
// own password, as on the server. stories: the light rows of GET /api/stories; glossaries: what GET /api/stories/:id
// answers for a book whose row carries none (a student's), and what PATCH saves.
function adminServer({admins=[],job=null}={}){
 const server={admins:new Map(admins.map(admin=>[admin.username,{id:randomUUID(),name:'',...admin}])),sessions:new Map(),requests:[],jobs:[],job,runDelay:0,logins:0,glossaries:{}};
 server.stories=[{id:'s1',title:'Sử ký',author:'',genre:'Lịch sử Trung Hoa',cover_key:null,source_url:null,owner_user_id:null,visibility:'public',created_at:'2026-10-20 08:00:00',glossary:'{}',chapters:0}];
 const cookie=(value,maxAge=null)=>`cat_hien_admin=${value}; Path=/api/; HttpOnly; SameSite=Strict${maxAge===null?'':`; Max-Age=${maxAge}`}`;
 const signIn=admin=>{const value=randomUUID();server.sessions.set(value,admin.username);return {'Set-Cookie':cookie(value)};};
 const reply=(status,body,headers={})=>({status,body,headers});
 // A job's list row as backend/admin-lists.js answers it: no text, no mode; its detail (GET /api/jobs/j1) has both.
 const row=()=>({id:'j1',story_id:'s1',filename:'Văn bản trực tiếp',mime:null,status:server.job.status,progress:'',created_at:'2026-10-26 08:00:00',story_title:'Sử ký',genre:'Lịch sử Trung Hoa',has_translation:0,warning_count:0});
 server.answer=async({method,path,headers,body})=>{
  const value=/(?:^|;\s*)cat_hien_admin=([^;]+)/u.exec(headers.cookie||'')?.[1],name=headers['x-hoa-tri-admin']==='1'&&value?server.sessions.get(value):null,admin=name?server.admins.get(name):null;
  let json={};try{json=body?JSON.parse(body):{};}catch{}
  if(path==='/api/status')return reply(200,admin?{authenticated:true,admin:{username:admin.username,name:admin.name},via:'session',translationMode:'premium',aiConfigured:true,model:'gemini-3.6-flash'}:{authenticated:false,...(server.admins.size?{}:{adminSetupRequired:true})});
  if(path==='/api/admin/setup'){
   if(json.token!==TOKEN)return reply(403,{error:'Mã ADMIN_TOKEN không đúng.',code:'admin_token_wrong'});
   if(json.first===true&&server.admins.size)return reply(409,{error:'Tài khoản quản trị đầu tiên đã được tạo ở nơi khác. Hãy đăng nhập bằng tài khoản đó, hoặc nhờ người đã tạo thêm tài khoản cho bạn.',code:'admin_exists'});
   if(!server.admins.size){const made={id:randomUUID(),username:json.username,name:json.name||'',password:json.password};server.admins.set(made.username,made);return reply(201,{admin:{username:made.username,name:made.name},created:true},signIn(made));}
   const found=server.admins.get(json.username);if(!found)return reply(404,{error:'Không có tài khoản quản trị nào với tên đăng nhập này.',code:'admin_not_found'});
   found.password=json.password;for(const [key,owner] of server.sessions)if(owner===found.username)server.sessions.delete(key);
   return reply(200,{admin:{username:found.username,name:found.name},created:false},signIn(found));
  }
  if(path==='/api/admin/login'){server.logins++;const found=server.admins.get(String(json.username||'').toLowerCase());return found&&found.password===json.password?reply(200,{admin:{username:found.username,name:found.name}},signIn(found)):reply(401,{error:WRONG});}
  if(path==='/api/admin/logout'){if(value)server.sessions.delete(value);return reply(200,{ok:true},{'Set-Cookie':cookie('',0)});}
  if(!admin)return reply(401,{error:ENDED,code:'admin_signed_out'});
  const own=label=>typeof json.currentPassword!=='string'||!json.currentPassword?reply(400,{error:`Hãy nhập ${label.toLowerCase()}.`,code:'password_required'}):json.currentPassword!==admin.password?reply(403,{error:`${label} không đúng.`,code:'wrong_password'}):null;
  if(path==='/api/admin/password'&&method==='POST'){const refused=own('Mật khẩu hiện tại');if(refused)return refused;admin.password=json.newPassword;return reply(200,{ok:true,ended:0});}
  if(path==='/api/admin/admins'&&method==='GET')return reply(200,{admins:[...server.admins.values()].map(item=>({id:item.id,username:item.username,name:item.name,createdAt:'2026-10-20T08:00:00.000Z',lastLoginAt:null,self:item.username===admin.username}))});
  if(path==='/api/admin/admins'&&method==='POST'){const refused=own('Mật khẩu của bạn');if(refused)return refused;const made={id:randomUUID(),username:json.username,name:json.name||'',password:json.password};server.admins.set(made.username,made);return reply(201,{admin:{id:made.id,username:made.username,name:made.name,createdAt:'2026-10-26T08:00:00.000Z',lastLoginAt:null,self:false}});}
  const remove=/^\/api\/admin\/admins\/([^/]+)$/u.exec(path);if(remove&&method==='DELETE'){const refused=own('Mật khẩu của bạn');if(refused)return refused;const found=[...server.admins.values()].find(item=>item.id===remove[1]);server.admins.delete(found.username);return reply(200,{ok:true});}
  if(path==='/api/stories')return reply(200,server.stories);
  const book=/^\/api\/stories\/([^/]+)$/u.exec(path),found=book&&server.stories.find(item=>item.id===book[1]);
  if(found&&method==='GET')return reply(200,{...found,glossary:found.glossary??server.glossaries[found.id]??'{}',context:''});
  if(found&&method==='PATCH'){server.glossaries[found.id]=JSON.stringify(json.glossary);return reply(200,{ok:true});}
  if(path==='/api/jobs'&&method==='POST'){server.jobs.push(body);server.job={mode:/name="mode"\r\n\r\n([a-z]+)\r\n/u.exec(body)?.[1]??null,status:'uploaded'};return reply(201,{id:'j1',ids:['j1'],chapters:1});}
  if(path==='/api/jobs'&&server.job)return reply(200,[row()]);
  if(path==='/api/jobs/j1'&&method==='GET'&&server.job)return reply(200,{...row(),mode:server.job.mode,source:'子曰：學而時習之',translation:'',warnings:'[]'});
  // A run keeps the job's mode unless it names one (worker.js: mode=COALESCE(?,mode)).
  if(path==='/api/jobs/j1/run'&&server.job){if(json.mode)server.job.mode=json.mode;await new Promise(resolve=>setTimeout(resolve,server.runDelay));server.job.status='review';return reply(200,{...row(),mode:server.job.mode});}
  return reply(200,[]);
 };
 return server;
}
async function open(path,server,{width=1440,height=900}={}){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce',locale:'vi-VN'});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{(globalThis.__csp||=[]).push(`${event.violatedDirective} ${event.blockedURI}`);}));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname.startsWith('/api/')){
   const headers=await request.allHeaders(),page=new URL(request.frame().url()).pathname,item={method:request.method(),path:url.pathname,header:headers['x-hoa-tri-admin']??null,authorization:headers.authorization??null,cookie:headers.cookie??'',page,body:request.postData()};
   server.requests.push(item);const answer=await server.answer({...item,headers});
   return route.fulfill({status:answer.status,headers:{'Content-Type':'application/json',...answer.headers},body:JSON.stringify(answer.body)});
  }
  const file=['/','/admin'].includes(url.pathname)?'index.html':url.pathname.slice(1),source=new URL(file,frontend);
  if(!file.includes('..')&&existsSync(source))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(source)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors,csp:()=>page.evaluate(()=>globalThis.__csp||[]),sideways:()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)};
}
const focusText=page=>page.evaluate(()=>({id:document.activeElement?.id||'',text:document.activeElement?.textContent||'',invalid:[...document.querySelectorAll('[aria-invalid="true"]')].map(input=>input.name)}));

test('First run at 1440 px: the setup form takes ADMIN_TOKEN once, errors stay in the form, the new admin is signed in, a reload keeps the session, "Đăng xuất" ends it',{skip},async()=>{
 const server=adminServer(),{context,page,errors,csp}=await open('/admin',server);
 await page.waitForSelector('#admin-setup-form');
 assert.equal(await page.textContent('h1'),'Tạo tài khoản quản trị đầu tiên');
 assert.match(await page.textContent('.login-card'),/dòng ADMIN_TOKEN trong tệp \.dev\.vars/u);
 assert.deepEqual(await page.$$eval('#admin-setup-form input',inputs=>inputs.map(input=>[input.name,input.type,input.autocomplete])),[['token','password','off'],['username','text','username'],['name','text','name'],['password','password','new-password'],['confirm','password','new-password']]);
 assert.equal(await page.$('#admin-login-form'),null,'no sign-in form while there is no admin');
 // Two different passwords: said in the form, nothing sent.
 await page.fill('[name=token]',TOKEN);await page.fill('[name=username]','co.lan');await page.fill('[name=name]','Cô Trần Ngọc Lan');
 await page.fill('[name=password]',PASSWORD);await page.fill('[name=confirm]',`${PASSWORD}x`);await page.click('#admin-setup-form [type=submit]');
 await page.waitForSelector('#admin-setup-error:not([hidden])');
 assert.deepEqual(await focusText(page),{id:'admin-setup-error',text:'Hai mật khẩu chưa khớp. Hãy nhập lại cho giống nhau.',invalid:['confirm']});
 assert.ok(!server.requests.some(item=>item.path==='/api/admin/setup'),'nothing sent');
 // A wrong token: the server's words, on the token field.
 await page.fill('[name=confirm]',PASSWORD);await page.fill('[name=token]','sai-ma');await page.click('#admin-setup-form [type=submit]');
 await page.waitForFunction(()=>document.querySelector('#admin-setup-error').textContent==='Mã ADMIN_TOKEN không đúng.');
 assert.deepEqual(await focusText(page),{id:'admin-setup-error',text:'Mã ADMIN_TOKEN không đúng.',invalid:['token']});
 // The right token: the account is made and this browser is signed in as it.
 await page.fill('[name=token]',TOKEN);await page.click('#admin-setup-form [type=submit]');
 await page.waitForSelector('.sidebar');
 assert.equal(await page.textContent('.profile-name'),'Cô Trần Ngọc Lan');assert.match(await page.textContent('.profile small'),/^co\.lan · Quản trị viên$/u);
 assert.equal(await page.textContent('#toast'),'Đã tạo tài khoản quản trị đầu tiên và đăng nhập.');
 assert.deepEqual(JSON.parse(server.requests.findLast(item=>item.path==='/api/admin/setup').body),{token:TOKEN,username:'co.lan',name:'Cô Trần Ngọc Lan',password:PASSWORD,first:true});
 // A session cookie (expires -1): the browser drops it when it closes; a reload keeps it (below).
 const cookie=(await context.cookies()).find(item=>item.name==='cat_hien_admin');
 assert.deepEqual([cookie.httpOnly,cookie.sameSite,cookie.path,cookie.expires],[true,'Strict','/api/',-1]);
 // The default "Cách dịch" of the school's jobs is preselected in the upload form.
 assert.equal(await page.$eval('#job-mode',select=>select.selectedOptions[0].textContent),'Kỹ nhất (tốn nhiều token nhất)');
 // A reload keeps the session: the console comes back without any form in between.
 await page.reload();await page.waitForSelector('.sidebar');
 assert.equal(await page.$('#admin-login-form'),null);
 // "Đăng xuất": the server ends the session first, then the sign-in form (not the first-run one: an admin exists).
 await page.click('#admin-logout');await page.waitForSelector('#admin-login-form');
 assert.equal(server.sessions.size,0);assert.equal(await page.textContent('h1'),'Đăng nhập quản trị');
 // Its heading has the focus, still once the address has changed (#translate) and that change has been routed.
 await page.waitForFunction(()=>location.hash==='#translate');await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));
 assert.equal(await page.evaluate(()=>document.activeElement.id),'admin-auth-title');
 assert.equal((await context.cookies()).some(item=>item.name==='cat_hien_admin'),false,'the cookie is gone');
 await page.reload();await page.waitForSelector('#admin-login-form');
 // Every request of the admin page carried the header, none a token; ADMIN_TOKEN was sent only to /api/admin/setup.
 assert.deepEqual(server.requests.filter(item=>item.page==='/admin'&&(item.header!=='1'||item.authorization)),[]);
 assert.deepEqual([...new Set(server.requests.filter(item=>String(item.body||'').includes(TOKEN)).map(item=>item.path))],['/api/admin/setup']);
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('Sign-in on a phone (390 px): the error inside the form, one request for a double press; a session that ends brings the form back over the same page; settings',{skip},async()=>{
 const server=adminServer({admins:[{username:'co.lan',name:'Cô Lan',password:PASSWORD},{username:'thay.minh',name:'Thầy Minh',password:'mot-mat-khau-khac-de-doan-9'}]});
 const {context,page,errors,csp,sideways}=await open('/admin#settings',server,{width:390,height:844});
 await page.waitForSelector('#admin-login-form');
 assert.deepEqual(await page.$$eval('#admin-login-form input',inputs=>inputs.map(input=>[input.name,input.type,input.autocomplete])),[['username','text','username'],['password','password','current-password']]);
 assert.doesNotMatch(await page.textContent('.login-card'),/ADMIN_TOKEN/u,'no token on the sign-in form');
 await page.fill('[name=username]','co.lan');await page.fill('[name=password]','sai-mat-khau-roi');
 await page.evaluate(()=>{const form=document.querySelector('#admin-login-form');form.requestSubmit();form.requestSubmit();});
 await page.waitForSelector('#admin-login-error:not([hidden])');
 assert.equal(server.logins,1,'one request for a double press');
 assert.deepEqual(await focusText(page),{id:'admin-login-error',text:WRONG,invalid:['username','password']});
 assert.equal(await sideways(),0);
 await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');
 // Back where the address pointed: Cài đặt, with who is signed in, the password form and the admins.
 await page.waitForSelector('#admin-password-form');await page.waitForSelector('.admin-accounts');
 assert.equal(await page.textContent('#admin-account-title'),'Cô Lan');
 assert.deepEqual(await page.$$eval('.admin-accounts li',rows=>rows.map(row=>[row.querySelector('strong').textContent,Boolean(row.querySelector('[data-admin-delete]'))])),[['Cô Lan',false],['Thầy Minh',true]],'"Xóa" beside the others only');
 assert.equal(await sideways(),0,'the settings fit a phone');
 // Another admin is added, confirmed with her own password; the list shows the new one at once and the focus is on the
 // form's note.
 await page.fill('#admin-add-form [name=username]','co.hoa');await page.fill('#admin-add-form [name=name]','Cô Hoa');await page.fill('#admin-add-form [name=password]','hoa-sen-trong-dam-lay-3');await page.fill('#admin-add-form [name=confirm]','hoa-sen-trong-dam-lay-3');await page.fill('#admin-add-form [name=currentPassword]',PASSWORD);
 await page.click('#admin-add-form [type=submit]');await page.waitForFunction(()=>document.querySelectorAll('.admin-accounts li').length===3);
 assert.equal(await page.inputValue('#admin-add-form [name=username]'),'','the form is emptied');
 await page.waitForFunction(()=>document.activeElement.id==='admin-add-done');assert.equal(await page.textContent('#admin-add-done'),'Đã thêm quản trị viên co.hoa. Hãy gửi riêng tên đăng nhập và mật khẩu cho người đó.');
 // The session ends on the server (2 hours idle, a password changed elsewhere) while a dialog is open: its request brings
 // the sign-in form back, the dialog closed, the reason read first; signing in again returns to the same page.
 server.sessions.clear();
 await page.click('[data-admin-delete]');await page.waitForSelector('#modal[open]');await page.fill('#modal [name=currentPassword]',PASSWORD);await page.click('#modal .primary');
 await page.waitForSelector('.admin-auth-notice');
 assert.deepEqual(await page.evaluate(()=>({open:document.querySelector('#modal').open,focus:document.activeElement.className})),{open:false,focus:'auth-note admin-auth-notice'});
 assert.equal(await page.textContent('#toast'),ENDED);
 await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');
 await page.waitForFunction(()=>document.querySelectorAll('.admin-accounts li').length===3);assert.equal(await page.evaluate(()=>location.hash),'#settings');
 assert.equal(server.admins.size,3,'nothing was deleted');
 assert.deepEqual(server.requests.filter(item=>item.page==='/admin'&&(item.header!=='1'||item.authorization)),[]);
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('A first-run form left open while the first admin was made elsewhere is refused and leads to the sign-in form, never resetting that admin\'s password',{skip},async()=>{
 const server=adminServer(),{context,page,errors}=await open('/admin',server);
 try{
  await page.waitForSelector('#admin-setup-form');
  server.admins.set('co.lan',{id:randomUUID(),username:'co.lan',name:'Cô Lan',password:'mat-khau-cua-co-lan-1'});
  await page.fill('[name=token]',TOKEN);await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.fill('[name=confirm]',PASSWORD);
  await page.click('#admin-setup-form [type=submit]');await page.waitForSelector('#admin-login-form');
  assert.equal(await page.textContent('.admin-auth-notice'),'Tài khoản quản trị đầu tiên đã được tạo ở nơi khác. Hãy đăng nhập bằng tài khoản đó, hoặc nhờ người đã tạo thêm tài khoản cho bạn.');
  assert.equal(server.admins.get('co.lan').password,'mat-khau-cua-co-lan-1');assert.equal(server.sessions.size,0,'nobody was signed in');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('"Quên mật khẩu?": ADMIN_TOKEN and the username set a new password and sign in; the job form sends the "Cách dịch" picked; public pages never send the admin header',{skip},async()=>{
 const server=adminServer({admins:[{username:'co.lan',name:'Cô Lan',password:'mat-khau-cu-da-quen-1'}]});
 const {context,page,errors,csp}=await open('/admin',server);
 await page.waitForSelector('#admin-login-form');await page.click('#admin-forgot');
 await page.waitForSelector('#admin-recover-form');
 assert.equal(await page.evaluate(()=>document.activeElement.tagName+' '+document.activeElement.textContent),'H1 Đặt lại mật khẩu quản trị');
 await page.fill('[name=token]',TOKEN);await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.fill('[name=confirm]',PASSWORD);
 await page.click('#admin-recover-form [type=submit]');await page.waitForSelector('.sidebar');
 assert.equal(server.admins.get('co.lan').password,PASSWORD);assert.equal(await page.textContent('#toast'),'Đã đặt mật khẩu mới và đăng nhập.');
 assert.equal(JSON.parse(server.requests.findLast(item=>item.path==='/api/admin/setup').body).first,undefined,'the recovery form is a reset, not a first-run form');
 // A new job carries the mode picked in the form; starting it names none (the job has it). Its page shows that mode, from
 // the job's own detail (its list row does not carry it), and a mode picked there goes with "Dịch lại".
 await page.click('[data-tab="text"]');await page.fill('#source-input','子曰：學而時習之');await page.selectOption('#story-select','s1');await page.selectOption('#job-mode','quality');
 assert.match(await page.textContent('#job-mode-hint'),/Ước tính tốn khoảng gấp/u);
 await page.click('#start-translate');await page.waitForFunction(()=>location.hash==='#review');
 await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('đã dịch xong'));
 assert.match(server.jobs[0],/name="mode"\r\n\r\nquality\r\n/u);
 const runs=()=>server.requests.filter(item=>item.path==='/api/jobs/j1/run').map(item=>item.body&&JSON.parse(item.body));
 assert.deepEqual(runs(),[null]);
 await page.waitForFunction(()=>document.querySelector('#run-mode')?.value==='quality');
 await page.selectOption('#run-mode','economy');await page.click('#rerun');await page.waitForSelector('#rerun:not([disabled])');
 assert.deepEqual(runs(),[null,{mode:'economy'}]);assert.equal(server.job.mode,'economy');
 // The library page in the same browser: no admin header on any request, no admin form.
 await page.goto(`${ORIGIN}/`);await page.waitForSelector('#home-title');
 assert.deepEqual(server.requests.filter(item=>item.page==='/'&&item.header!==null),[]);
 assert.doesNotMatch(await page.content(),/admin-(?:login|setup|recover)-form|ADMIN_TOKEN/u);
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

// Requests made while signed in may answer after the session has ended and the sign-in form is back (a job's text, a
// long translation step, the console's reload after it): the form is not drawn again, so the reason read first keeps
// the focus and what the admin has started to type stays.
test('After the session ended, late answers leave the sign-in form alone: the note keeps the focus, typed text stays; a job resumes in its own mode',{skip},async()=>{
 const server=adminServer({admins:[{username:'co.lan',name:'Cô Lan',password:PASSWORD}],job:{mode:'economy',status:'failed'}});
 const {context,page,errors,csp}=await open('/admin#review',server);
 const signIn=async()=>{await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');};
 await page.waitForSelector('#admin-login-form');await signIn();
 await page.click('[data-review-story]');await page.waitForSelector('[data-job]');
 // The session ends on the server; the admin opens the job: its text is refused, the form comes back with the reason
 // focused, and that request's own redraw afterwards leaves it so.
 server.sessions.clear();await page.click('[data-job]');await page.waitForSelector('.admin-auth-notice');
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));
 assert.equal(await page.evaluate(()=>document.activeElement.className),'auth-note admin-auth-notice');
 // Signed in again on the job's page: it shows the job's own mode (Tiết kiệm; the default is Kỹ nhất).
 await signIn();await page.waitForFunction(()=>document.querySelector('#run-mode')?.value==='economy');
 // "Tiếp tục xử lý": a long step runs; the session ends meanwhile and opening Cài đặt brings the form back. The admin
 // starts typing before the step answers; neither its answer nor the console's reload after it draws the form again.
 server.runDelay=2000;await page.click('#rerun');await until(()=>server.requests.some(item=>item.path==='/api/jobs/j1/run'));
 server.sessions.clear();await page.click('.sidebar [data-route="settings"]');await page.waitForSelector('.admin-auth-notice');
 const asked=()=>server.requests.filter(item=>item.path==='/api/status').length,before=asked();
 await page.fill('[name=username]','co.lan');await page.fill('[name=password]','mai-hoa');
 assert.equal(server.job.status,'failed','typed while the step still runs');
 await until(()=>asked()>before);await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));
 assert.deepEqual(await page.evaluate(()=>[document.querySelector('[name=username]').value,document.querySelector('[name=password]').value,document.activeElement.name]),['co.lan','mai-hoa','password']);
 assert.deepEqual(server.requests.filter(item=>item.path==='/api/jobs/j1/run').map(item=>item.body),[null],'"Tiếp tục xử lý" left as it was names no mode');assert.equal(server.job.mode,'economy');
 // Signing in brings her back to Cài đặt.
 await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');await page.waitForSelector('#admin-password-form');
 assert.deepEqual(server.requests.filter(item=>item.page==='/admin'&&(item.header!=='1'||item.authorization)),[]);
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

// Cài đặt with the keyboard. A translation that ends while the admin types there leaves both forms as they are. "Xóa"
// opens a dialog that asks for her own password with the focus in it; Escape gives the focus back to "Xóa"; a wrong
// password is said in the dialog with the focus back on the field; the right one removes the admin and the focus goes
// to the list's heading. "Đổi mật khẩu" ends on its own note.
test('Cài đặt: a run that ends leaves what is typed; removing an admin asks for your password in a dialog; "Đổi mật khẩu" ends on its note',{skip},async()=>{
 const server=adminServer({admins:[{username:'co.lan',name:'Cô Lan',password:PASSWORD},{username:'thay.minh',name:'Thầy Minh',password:'mot-mat-khau-khac-de-doan-9'}],job:{mode:'economy',status:'failed'}});
 const {context,page,errors,csp}=await open('/admin#review',server);
 try{
  await page.waitForSelector('#admin-login-form');await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');
  await page.click('[data-review-story]');await page.waitForSelector('[data-job]');await page.click('[data-job]');await page.waitForSelector('#rerun:not([disabled])');
  server.runDelay=2500;await page.click('#rerun');await until(()=>server.requests.some(item=>item.path==='/api/jobs/j1/run'));
  await page.click('.sidebar [data-route="settings"]');await page.waitForSelector('.admin-accounts');
  const asked=()=>server.requests.filter(item=>item.path==='/api/status').length,before=asked();
  await page.fill('#admin-password-form [name=currentPassword]','mai-hoa');await page.fill('#admin-add-form [name=username]','co.hoa');await page.fill('#admin-add-form [name=password]','hoa-sen-trong-dam-lay-3');
  await page.focus('#admin-add-form [name=confirm]');await page.keyboard.type('hoa-sen');
  await until(()=>server.job.status==='review'&&asked()>before);await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));
  assert.match(await page.textContent('#toast'),/đã dịch xong/u);
  const typed=await page.evaluate(()=>({values:Object.fromEntries(['admin-password-form','admin-add-form'].map(id=>[id,Object.fromEntries([...document.querySelectorAll(`#${id} input[name]`)].map(input=>[input.name,input.value]))])),focus:`${document.activeElement.form?.id} ${document.activeElement.name}`}));
  assert.deepEqual(typed,{values:{'admin-password-form':{currentPassword:'mai-hoa',newPassword:'',confirm:''},'admin-add-form':{username:'co.hoa',name:'',password:'hoa-sen-trong-dam-lay-3',confirm:'hoa-sen',currentPassword:''}},focus:'admin-add-form confirm'});
  // "Xóa": the dialog names whom it removes and asks for her own password, the focus in that field.
  await page.focus('[data-admin-delete]');await page.keyboard.press('Enter');await page.waitForSelector('#modal[open]');
  const shown=()=>page.evaluate(()=>{const field=document.activeElement,dialog=document.querySelector('#modal');return {name:field.name,label:field.closest('label')?.textContent,autocomplete:field.autocomplete,title:document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent};});
  assert.deepEqual(await shown(),{name:'currentPassword',label:'Mật khẩu của bạn',autocomplete:'current-password',title:'Xóa quản trị viên Thầy Minh?'});
  // Escape: closed, nothing sent, the focus back on "Xóa".
  const closed=()=>page.waitForFunction(()=>!document.querySelector('#modal').open);
  await page.keyboard.press('Escape');await closed();
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Xóa quản trị viên Thầy Minh');assert.ok(!server.requests.some(item=>item.method==='DELETE'));
  // A wrong password: the server's words in the dialog, the field marked and focused again; nobody removed.
  await page.keyboard.press('Enter');await page.waitForSelector('#modal[open]');await page.keyboard.type('sai-mat-khau-roi');await page.click('#modal .primary');
  await page.waitForSelector('#modal-error:not([hidden])');await page.waitForFunction(()=>document.activeElement.name==='currentPassword');
  assert.deepEqual(await page.evaluate(()=>[document.querySelector('#modal-error').textContent,document.querySelector('#modal-error').getAttribute('role'),document.activeElement.getAttribute('aria-invalid'),document.activeElement.getAttribute('aria-describedby')]),['Mật khẩu của bạn không đúng.','alert','true','modal-error']);
  assert.equal(server.admins.size,2);
  // The right one: removed, the dialog closed, the focus on the list's heading.
  await page.fill('#modal [name=currentPassword]',PASSWORD);await page.keyboard.press('Enter');await closed();
  await page.waitForFunction(()=>document.querySelectorAll('.admin-accounts li').length===1);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'admin-team-title');assert.equal(server.admins.has('thay.minh'),false);
  assert.deepEqual(JSON.parse(server.requests.findLast(item=>item.method==='DELETE').body),{currentPassword:PASSWORD});
  // "Đổi mật khẩu" with Enter on its button: the focus goes to the form's note.
  await page.fill('#admin-password-form [name=currentPassword]',PASSWORD);await page.fill('#admin-password-form [name=newPassword]','mot-mat-khau-moi-rat-dai-9');await page.fill('#admin-password-form [name=confirm]','mot-mat-khau-moi-rat-dai-9');
  await page.focus('#admin-password-form [type=submit]');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement.id==='admin-password-done');
  assert.equal(await page.textContent('#admin-password-done'),'Đã đổi mật khẩu. Lần sau hãy đăng nhập bằng mật khẩu mới.');assert.equal(server.admins.get('co.lan').password,'mot-mat-khau-moi-rat-dai-9');
  assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Thuật ngữ: a run that ends leaves the terms typed in a student\'s book glossary and the focus; "Lưu bảng thuật ngữ" saves them',{skip},async()=>{
 const server=adminServer({admins:[{username:'co.lan',name:'Cô Lan',password:PASSWORD}],job:{mode:'economy',status:'failed'}});
 server.stories.push({...server.stories[0],id:'s2',title:'Tả truyện',owner_user_id:'u1',visibility:'private',glossary:null});server.glossaries.s2=JSON.stringify({'秦':'Tần'});
 const {context,page,errors,csp}=await open('/admin#review',server);
 try{
  await page.waitForSelector('#admin-login-form');await page.fill('[name=username]','co.lan');await page.fill('[name=password]',PASSWORD);await page.click('#admin-login-form [type=submit]');
  await page.click('[data-review-story]');await page.waitForSelector('[data-job]');await page.click('[data-job]');await page.waitForSelector('#rerun:not([disabled])');
  server.runDelay=2500;await page.click('#rerun');await until(()=>server.requests.some(item=>item.path==='/api/jobs/j1/run'));
  // The student's book glossary is asked for when it is opened, and once more when the run's refresh has dropped it.
  const asked=()=>server.requests.filter(item=>item.path==='/api/stories/s2'&&item.method==='GET').length;
  await page.click('.sidebar [data-route="glossary"]');await page.selectOption('#glossary-story','s2');await page.waitForSelector('#glossary-text:not([readonly])');
  await page.focus('#glossary-text');await page.keyboard.press('Control+End');await page.keyboard.type('\n漢 = Hán');
  await until(()=>server.job.status==='review'&&asked()===2);await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));
  assert.match(await page.textContent('#toast'),/đã dịch xong/u);
  assert.deepEqual(await page.evaluate(()=>{const field=document.querySelector('#glossary-text');return {value:field.value,readOnly:field.readOnly,focus:document.activeElement.id};}),{value:'秦 = Tần\n漢 = Hán',readOnly:false,focus:'glossary-text'});
  await page.click('#save-glossary');await until(()=>server.requests.some(item=>item.method==='PATCH'));
  assert.deepEqual(JSON.parse(server.requests.find(item=>item.method==='PATCH').body),{glossary:{'秦':'Tần','漢':'Hán'}});
  await page.waitForFunction(()=>/^Đã lưu bảng thuật ngữ\./u.test(document.querySelector('#toast').textContent));
  assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
