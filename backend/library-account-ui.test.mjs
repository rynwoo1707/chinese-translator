import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';

// The account, sign-in, password reset and admin reset-link screens in a real browser engine: index.html and every
// script and stylesheet come from frontend/ on disk, served with the Content-Security-Policy of frontend/_headers; every
// /api request is answered here (nothing reaches a server). localhost is a secure context, so the clipboard works.
// Skipped when Microsoft Edge is missing.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://localhost:4890';
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(readFileSync(new URL('_headers',frontend),'utf8'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
const TOKEN='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde',FRESH='Fr'+'e'.repeat(41);
const ME_OUT={authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]},termsVersion:'2026-10'};
const ME_IN={...ME_OUT,authenticated:true,user:{id:'u1',name:'Nguyễn Thị Phương Thảo',email:'phuongthao.nguyen.lop11a2@truong-thpt-example.edu.vn',picture:'',provider:'local'}};
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());

// api(method, path, body) -> [status, json] | undefined (then: /api/me signed out, lists empty).
async function open(path,{width=390,height=844,api=()=>undefined}={}){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce',locale:'vi-VN'});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:ORIGIN});
 const page=await context.newPage(),errors=[],sent=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{(globalThis.__csp||=[]).push(`${event.violatedDirective} ${event.blockedURI}`);}));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname.startsWith('/api/')){
   const body=request.postData();if(request.method()!=='GET')sent.push({method:request.method(),path:url.pathname,body});
   const answer=api(request.method(),url.pathname,body)||[200,url.pathname==='/api/me'?ME_OUT:url.pathname==='/api/status'?{authenticated:true}:[]];
   return route.fulfill({status:answer[0],contentType:'application/json',body:JSON.stringify(answer[1])});
  }
  const file=['/','/admin'].includes(url.pathname)?'index.html':url.pathname.slice(1),path=new URL(file,frontend);
  if(!file.includes('..')&&existsSync(path))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(path)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors,sent,csp:()=>page.evaluate(()=>globalThis.__csp||[]),sideways:()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)};
}

test('Password reset link at 390 px under the CSP: the token leaves the address, is only checked until "Tiếp tục", errors stay in the form, success confirms',{skip},async()=>{
 let signedIn=false;
 const {context,page,errors,sent,csp,sideways}=await open(`/#dat-lai-mat-khau?token=${TOKEN}`,{api:(method,path)=>path==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:path==='/api/auth/password-reset/check'?[200,{ok:true,expiresAt:'2026-10-22T08:30:00.000Z'}]:path==='/api/auth/password-reset/open'?[200,{token:FRESH}]:path==='/api/auth/password-reset'?(signedIn=true,[200,{ok:true}]):undefined});
 // A chat app or mail scanner that opens the link runs this page too: it only checks the link, which stays usable.
 await page.waitForSelector('#reset-continue');
 assert.deepEqual(sent.map(item=>[item.path,JSON.parse(item.body)]),[['/api/auth/password-reset/check',{token:TOKEN}]],'only checked on load');sent.length=0;
 assert.equal(await page.evaluate(()=>location.href),`${ORIGIN}/#dat-lai-mat-khau`,'no token in the address bar');
 await page.click('#reset-continue');await page.waitForSelector('#password-reset-form');
 assert.deepEqual(sent.map(item=>[item.path,JSON.parse(item.body)]),[['/api/auth/password-reset/open',{token:TOKEN}]],'traded once, on the click');sent.length=0;
 assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
 await page.fill('[name=password]','mat-khau-moi-123');await page.fill('[name=confirm]','mat-khau-moi-124');await page.click('#password-reset-form [type=submit]');
 await page.waitForSelector('#password-reset-error:not([hidden])');
 assert.deepEqual(await page.evaluate(()=>({focus:document.activeElement.id,invalid:document.querySelector('[name=confirm]').getAttribute('aria-invalid'),visible:document.querySelector('#password-reset-error').getBoundingClientRect().height>0})),{focus:'password-reset-error',invalid:'true',visible:true});
 assert.equal(sent.length,0,'nothing sent for two different passwords');
 await page.fill('[name=confirm]','mat-khau-moi-123');await page.click('#password-reset-form [type=submit]');
 await page.waitForSelector('.account-notice');
 assert.deepEqual(JSON.parse(sent[0].body),{token:FRESH,password:'mat-khau-moi-123'});
 assert.equal(await page.evaluate(()=>location.hash),'#account');
 assert.equal(await page.evaluate(()=>document.activeElement.className),'account-notice status','the confirmation is read first');
 assert.equal(await sideways(),0);assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('Sign-in at 320 px: the error inside the form, focused, fields marked, one request for a double press; the account page fits',{skip},async()=>{
 let logins=0,signedIn=false;
 const {context,page,errors,csp,sideways}=await open('/#account',{width:320,height:700,api:(method,path)=>{
  if(path==='/api/me')return [200,signedIn?ME_IN:ME_OUT];
  if(path==='/api/auth/login'){logins++;if(logins===1)return [401,{error:'Email hoặc mật khẩu không đúng.'}];signedIn=true;return [200,{ok:true}];}
 }});
 await page.waitForSelector('#reader-login-form');
 assert.equal(await page.$eval('#toast',toast=>`${getComputedStyle(toast).display} ${toast.getAttribute('aria-live')}`),'block polite','the live region is in the page while idle');
 await page.fill('#reader-login-form [name=email]','lan@example.test');await page.fill('#reader-login-form [name=password]','sai-mat-khau');
 await page.evaluate(()=>{const form=document.querySelector('#reader-login-form');form.requestSubmit();form.requestSubmit();});
 await page.waitForSelector('#reader-login-error:not([hidden])');
 assert.equal(logins,1,'one request for a double press');
 assert.deepEqual(await page.evaluate(()=>({text:document.querySelector('#reader-login-error').textContent,focus:document.activeElement.id,invalid:[...document.querySelectorAll('#reader-login-form [aria-invalid="true"]')].map(input=>input.name)})),{text:'Email hoặc mật khẩu không đúng.',focus:'reader-login-error',invalid:['email','password']});
 assert.equal(await sideways(),0);
 await page.fill('#reader-login-form [name=password]','mat-khau-dung-roi');await page.click('#reader-login-form [type=submit]');
 await page.waitForSelector('#reader-logout');
 const layout=await page.evaluate(()=>{const button=document.querySelector('#reader-logout').getBoundingClientRect();return {inside:button.left>=0&&button.right<=document.documentElement.clientWidth,height:Math.round(button.height),header:document.querySelector('.header-avatar').textContent,profile:document.querySelector('.account-profile>span').textContent};});
 assert.deepEqual(layout,{inside:true,height:44,header:'NT',profile:'NT'});
 assert.equal(await sideways(),0,'no sideways scroll at 320 px');assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('Admin at 1440 px: "Tạo liên kết đặt lại mật khẩu" (in the student\'s ⋯) shows the full link once, with its expiry, and copies it',{skip},async()=>{
 const users=[{id:'u1',email:'lan@example.test',name:'Trần Ngọc Lan',provider:'local'},{id:'u2',email:'minh@example.test',name:'Lê Minh',provider:'google'}];
 const {context,page,errors,csp}=await open('/admin#users',{width:1440,height:900,api:(method,path)=>path==='/api/users'?[200,users]:path==='/api/users/u1/password-reset'?[201,{resetUrl:`/#dat-lai-mat-khau?token=${TOKEN}`,expiresAt:'2026-10-22T08:30:00.000Z'}]:undefined});
 await page.waitForSelector('.user-block');
 assert.equal(await page.$('[data-user-reset="u2"]'),null);assert.equal(await page.getAttribute('.user-block:has-text("Lê Minh") .chip','title'),'Tài khoản Google, không có mật khẩu');
 const summary='.user-block:has-text("Trần Ngọc Lan") details.menu > summary';
 await page.click(summary);await page.click('[data-user-reset="u1"]');await page.waitForSelector('#modal[open] #reset-link');
 assert.equal(await page.inputValue('#reset-link'),`${ORIGIN}/#dat-lai-mat-khau?token=${TOKEN}`);
 assert.match(await page.textContent('#modal'),/Liên kết chỉ hiện một lần[\s\S]*hết hạn lúc \d\d:\d\d 22\/10\/2026/u);
 await page.click('#copy-reset-link');await page.waitForFunction(()=>document.querySelector('#reset-link-status').textContent.length>0);
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),`${ORIGIN}/#dat-lai-mat-khau?token=${TOKEN}`);
 // The focus is back as the dialog closes, not one task later on its close event: until then it sat on the hidden
 // dialog's button (the opener lost it while disabled during the request, so the browser itself restores nothing).
 // The menu closed when its item was chosen, so the focus goes back to its ⋯.
 await page.evaluate(()=>{const dialog=document.querySelector('#modal');new MutationObserver((list,observer)=>{if(dialog.open)return;observer.disconnect();globalThis.__focusAtClose=document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName;}).observe(dialog,{attributes:true,attributeFilter:['open']});});
 await page.click('#modal .primary');await page.waitForFunction(()=>!document.querySelector('#modal').open);
 assert.equal(await page.evaluate(()=>globalThis.__focusAtClose),'Thao tác cho “Trần Ngọc Lan”','the focus is on ⋯ when the dialog closes');
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Thao tác cho “Trần Ngọc Lan”','the focus is back on ⋯');
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('Admin on a phone (390 px): translation requests waiting are counted on "Yêu cầu dịch", for a screen reader too, and in the title',{skip},async()=>{
 const requests=[{id:'r1',title:'Sử ký',status:'pending',visibility:'private',notes:'',reader_name:'Lan'},{id:'r2',title:'Luận ngữ',status:'pending',visibility:'public',notes:'',reader_name:'Minh'},{id:'r3',title:'Mạnh Tử',status:'done',visibility:'private',notes:''}];
 const {context,page,errors,csp,sideways}=await open('/admin#translate',{api:(method,path)=>path==='/api/requests'?[200,requests]:undefined});
 await page.waitForSelector('.sidebar [data-route="requests"] .count',{state:'attached'});
 const badge=await page.evaluate(()=>{const button=document.querySelector('.sidebar [data-route="requests"]'),count=button.querySelector('.count'),box=count.getBoundingClientRect(),own=button.getBoundingClientRect();return {text:count.textContent,shown:box.width>0&&box.height>0,inside:box.left>=own.left&&box.right<=own.right+1,title:document.title};});
 assert.deepEqual(badge,{text:'2',shown:true,inside:true,title:'(2) Hoa Trí — Quản trị'});
 assert.equal(await page.getByRole('button',{name:'Yêu cầu dịch (2 yêu cầu mới)',exact:true}).count(),1,'its name says what the number means');
 assert.equal(await sideways(),0);assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('A request started signed out survives a reload and the Google round trip (return_to=/#yeu-cau)',{skip},async()=>{
 let signedIn=false;
 const {context,page,errors,csp}=await open('/',{width:1440,height:900,api:(method,path)=>path==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:undefined});
 await page.waitForSelector('#home-title');await page.click('#reader-request');await page.waitForSelector('#reader-login-form');
 const google=()=>page.getAttribute('#google-login','href');
 assert.equal(await google(),'/api/auth/google/start?return_to=%2F%23yeu-cau','no consent in the link before a box is ticked');
 await page.check('#google-terms-row input');assert.equal(await google(),'/api/auth/google/start?accept_terms=1&return_to=%2F%23yeu-cau');
 await page.reload();await page.waitForSelector('#reader-login-form');
 assert.equal(await google(),'/api/auth/google/start?return_to=%2F%23yeu-cau','kept across a reload');
 signedIn=true;await page.goto('about:blank');await page.goto(`${ORIGIN}/#yeu-cau`);
 await page.waitForSelector('#modal[open] [name=title]');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('hoa-tri-request-draft')),null,'used once');
 assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});

test('A Google sign-in that came back with a reason (#account?loi=…): the reason is read first, the address is clean, the way back is kept',{skip},async()=>{
 const {context,page,errors,csp,sideways}=await open('/#account?loi=google_cancelled&sau=xuong-dich');
 await page.waitForSelector('.auth-failure');
 assert.deepEqual(await page.evaluate(()=>({hash:location.hash,focus:document.activeElement.className,text:document.querySelector('.auth-failure').textContent,role:document.querySelector('.auth-failure').getAttribute('role'),google:document.querySelector('#google-login').getAttribute('href')})),{hash:'#account',focus:'form-error auth-failure',text:'Bạn đã hủy đăng nhập bằng Google. Bấm “Tiếp tục bằng Google” để thử lại.',role:'alert',google:'/api/auth/google/start?return_to=%2Fstudy'});
 assert.equal(await sideways(),0);assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 await context.close();
});
