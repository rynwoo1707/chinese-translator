import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';

// The console's ⋯ menus, its in-place forms and the public pages' inline checks in a real browser engine (the minimal
// pass, 2026-10-31): index.html and every script and stylesheet come from frontend/ on disk, served with the
// Content-Security-Policy of frontend/_headers; every /api request is answered here (nothing reaches a server, a port or
// Gemini). Skipped when Microsoft Edge is missing.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://localhost:4897';
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(readFileSync(new URL('_headers',frontend),'utf8'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());

const ADMIN={authenticated:true,admin:{username:'lan.nguyen',name:'Nguyễn Thị Lan'},via:'session',translationMode:'premium',aiConfigured:true,model:'gemini-3.6-flash'};
// Three students: one with a password, one locked, one Google account; each row has a ⋯ menu.
const USERS=[
 {id:'u1',email:'nam.le@thpt.edu.vn',name:'Lê Hoàng Nam',provider:'local',picture:null,books:0,requests:0,disabled_at:null,terms_version:'2026-09',terms_accepted_at:'2026-09-14 07:12:00',created_at:'2026-09-14 07:12:00'},
 {id:'u2',email:'vy.bui@gmail.com',name:'Bùi Thảo Vy',provider:'local',picture:null,books:0,requests:0,disabled_at:'2026-10-25 09:00:00',terms_version:'2026-09',terms_accepted_at:'2026-09-21 11:00:00',created_at:'2026-09-21 11:00:00'},
 {id:'u3',email:'huy.hoang@thpt.edu.vn',name:'Hoàng Gia Huy',provider:'google',picture:null,books:0,requests:0,disabled_at:null,terms_version:'2026-09',terms_accepted_at:'2026-08-30 08:00:00',created_at:'2026-08-30 08:00:00'}
];
const ME_IN={authenticated:true,googleConfigured:true,registration:{mode:'open',domains:[]},user:{id:'s1',name:'Nguyễn Thị Thảo',email:'thao@example.test',provider:'local'}};
const ME_OUT={authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]}};
// reader: the library holds one book whose PDF part knows its original pages (so the reader offers Song ngữ and, in
// "Tải về", "PDF gốc ↗").
const SHA='c'.repeat(64);
const READER={
 '/api/library':[{id:'b1',title:'Sách thử nghiệm',genre:'Toán học · STEM',chapters:1,mapped_parts:1,visibility:'public'}],
 '/api/read/b1':[{id:'c1',title:'Trang 3–4',mime:'application/pdf',source_sha256:SHA,source_pages:[3,4]}],
 '/api/library/b1/assembly':{parts:[{id:'c1',mime:'application/pdf',pages:[3,4],sha256:SHA}],storedSources:[{sha256:SHA,pages:9,url:`/api/library/b1/sources/${SHA}`}]}
};
function answer(path,{me=ME_OUT,reader=false}={}){
 if(path==='/api/status')return ADMIN;
 if(path==='/api/users')return USERS;
 if(path==='/api/admin/admins')return {admins:[{id:'a1',username:'lan.nguyen',name:'Nguyễn Thị Lan',createdAt:'2026-09-02T01:20:00.000Z',lastLoginAt:'2026-10-31T00:45:00.000Z',self:true}]};
 if(path==='/api/me')return me;
 if(reader&&READER[path])return READER[path];
 return [];
}
async function open(path,{width=1280,height=900,me=ME_OUT,reader=false}={}){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce',locale:'vi-VN'});
 const page=await context.newPage(),errors=[],sent=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname.startsWith('/api/')){sent.push(`${request.method()} ${url.pathname}`);return route.fulfill({status:200,headers:{'Content-Type':'application/json'},body:JSON.stringify(answer(url.pathname,{me,reader}))});}
  const file=['/','/admin'].includes(url.pathname)?'index.html':url.pathname.slice(1),source=new URL(file,frontend);
  if(!file.includes('..')&&existsSync(source))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(source)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors,sent,sideways:()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)};
}
// The ⋯ of a student's row and what has the focus.
const menuOf=(page,name)=>page.locator(`.user-block:has-text("${name}") details.menu`);
const focused=page=>page.evaluate(()=>{const element=document.activeElement;return {tag:element?.tagName||'',label:element?.getAttribute('aria-label')||'',text:(element?.textContent||'').trim(),name:element?.getAttribute('name')||''};});

test('⋯ menus of the console: one open at a time, above the next row, closed by Escape, a press outside or a choice; the focus comes back to ⋯',{skip,timeout:120000},async()=>{
 const {context,page,errors,sideways}=await open('/admin#users');
 await page.waitForSelector('.user-block');
 const first=menuOf(page,'Lê Hoàng Nam'),second=menuOf(page,'Bùi Thảo Vy');
 // A row that is not the last: its menu opens over the next row, and its last item takes the click.
 await first.locator('summary').click();
 assert.equal(await first.evaluate(menu=>menu.open),true);
 const last=first.locator('.menu-list > :last-child');
 assert.equal((await last.textContent()).trim(),'Xóa tài khoản…','the deletion is the last item');
 const box=await last.boundingBox(),top=await page.evaluate(({x,y})=>{const element=document.elementFromPoint(x,y);return element?.closest('details.menu')?.querySelector('summary')?.getAttribute('aria-label')||'';},{x:box.x+box.width/2,y:box.y+box.height/2});
 assert.equal(top,'Thao tác cho “Lê Hoàng Nam”','nothing of the next row covers the open menu');
 await last.click();
 assert.equal(await page.locator('#modal').evaluate(dialog=>dialog.open),true);assert.match(await page.locator('#modal h2').textContent(),/^Xóa tài khoản nam\.le@thpt\.edu\.vn\?$/u);
 assert.equal(await first.evaluate(menu=>menu.open),false,'a choice closes the menu');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal').open);
 assert.deepEqual(await focused(page),{tag:'SUMMARY',label:'Thao tác cho “Lê Hoàng Nam”',text:'⋯',name:''},'the focus is back on ⋯');
 // Keyboard: Enter opens, Tab reaches the first item, Escape closes and gives the focus back to ⋯.
 await page.keyboard.press('Enter');assert.equal(await first.evaluate(menu=>menu.open),true);
 await page.keyboard.press('Tab');assert.equal((await focused(page)).text,'Tạo liên kết đặt lại mật khẩu');
 await page.keyboard.press('Escape');
 assert.equal(await first.evaluate(menu=>menu.open),false);assert.equal((await focused(page)).label,'Thao tác cho “Lê Hoàng Nam”');
 // Tab past its last item closes it too: the open list never covers the control the focus moved on to (the next row's ⋯).
 await page.keyboard.press('Enter');for(let i=0;i<4;i++)await page.keyboard.press('Tab');
 assert.equal(await first.evaluate(menu=>menu.open||menu.contains(document.activeElement)),false);assert.equal((await focused(page)).label,'Thao tác cho “Bùi Thảo Vy”');
 // One menu at a time; a locked account's reset is a line saying why, never a control.
 // (The lower row's menu is opened first: an open menu covers the rows under it, as it should.)
 await second.locator('summary').click();await first.locator('summary').click();
 assert.deepEqual([await first.evaluate(menu=>menu.open),await second.evaluate(menu=>menu.open)],[true,false]);
 await page.keyboard.press('Escape');await second.locator('summary').click();assert.equal(await second.evaluate(menu=>menu.open),true);
 assert.equal((await second.locator('.menu-note').textContent()).trim(),'Đặt lại mật khẩu — mở khóa trước');
 assert.equal(await second.locator('[data-user-reset]').count(),0);
 await page.keyboard.press('Tab');assert.equal((await focused(page)).text,'Mở khóa','the note is skipped by Tab');
 // A press outside closes it.
 await page.locator('h1').click();assert.equal(await second.evaluate(menu=>menu.open),false);
 // A Google account has no reset at all.
 const google=menuOf(page,'Hoàng Gia Huy');await google.locator('summary').click();
 assert.deepEqual(await google.locator('.menu-list > *').evaluateAll(items=>items.map(item=>item.textContent.trim()).filter(Boolean)),['Khóa tài khoản…','Xóa tài khoản…']);
 assert.equal(await sideways(),0);assert.deepEqual(errors,[]);
 await context.close();
});

// The rows are drawn again after a lock or an unlock: the toast (a live region) says what changed, and the focus comes back
// to that row's ⋯ rather than falling to the top of the page, after the confirming dialog too.
test('Unlocking and locking from ⋯: the toast says what changed and the focus comes back to that row\'s ⋯',{skip,timeout:120000},async()=>{
 const {context,page,errors,sent}=await open('/admin#users');
 await page.waitForSelector('.user-block');
 const locked=menuOf(page,'Bùi Thảo Vy'),unlocked=menuOf(page,'Lê Hoàng Nam');
 await locked.locator('summary').click();await locked.locator('[data-user-lock]').click();
 await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Đã mở khóa tài khoản.');
 assert.ok(sent.includes('PATCH /api/users/u2'));assert.deepEqual(await focused(page),{tag:'SUMMARY',label:'Thao tác cho “Bùi Thảo Vy”',text:'⋯',name:''});
 await unlocked.locator('summary').click();await unlocked.locator('[data-user-lock]').click();
 await page.waitForSelector('#modal[open]');await page.click('#modal-form button.primary');
 await page.waitForFunction(()=>!document.querySelector('#modal').open&&document.querySelector('#toast').textContent==='Đã khóa tài khoản.');
 assert.ok(sent.includes('PATCH /api/users/u1'));assert.deepEqual(await focused(page),{tag:'SUMMARY',label:'Thao tác cho “Lê Hoàng Nam”',text:'⋯',name:''});
 assert.deepEqual(errors,[]);await context.close();
});

test('⋯ menus on a phone (390 px) stay on the screen; "Đổi mật khẩu" and "Thêm quản trị viên" open their form in place',{skip,timeout:120000},async()=>{
 const phone=await open('/admin#users',{width:390,height:844});
 await phone.page.waitForSelector('.user-block');
 // The consent record (terms version and day) is in the row's line, whole on a phone: it wraps, it is never cut off, and
 // "Điều khoản <version>" is never split across two lines (a version such as 2026-09 would break at its hyphen).
 const consent=await phone.page.locator('.user-block:has-text("Lê Hoàng Nam") .row-meta').evaluate(node=>({text:node.textContent,whole:node.scrollWidth<=node.clientWidth}));
 assert.deepEqual(consent,{text:'nam.le@thpt.edu.vn · Điều khoản 2026-09 · 14/09/2026',whole:true});
 const versions=await phone.page.$$eval('.user-block .row-meta .nowrap',nodes=>nodes.map(node=>({text:node.textContent,lines:node.getClientRects().length})));
 assert.ok(versions.length>0);assert.deepEqual(versions.filter(version=>version.lines!==1),[]);
 const menu=menuOf(phone.page,'Lê Hoàng Nam');await menu.locator('summary').click();
 const list=await menu.locator('.menu-list').boundingBox();
 assert.ok(list.x>=0&&list.x+list.width<=390,JSON.stringify(list));assert.equal(await phone.sideways(),0,'no sideways scroll');
 assert.deepEqual(phone.errors,[]);await phone.context.close();
 const {context,page,errors}=await open('/admin#settings');
 await page.waitForSelector('#admin-password-toggle');
 assert.equal(await page.locator('#admin-password-form').isHidden(),true,'the form waits behind its button');
 await page.click('#admin-password-toggle');
 assert.equal(await page.getAttribute('#admin-password-toggle','aria-expanded'),'true');assert.equal(await page.locator('#admin-password-form').isVisible(),true);
 assert.equal((await focused(page)).name,'currentPassword','the focus goes to the form\'s first field');
 await page.click('#admin-password-toggle');assert.equal(await page.locator('#admin-password-form').isHidden(),true);assert.equal(await page.getAttribute('#admin-password-toggle','aria-expanded'),'false');
 await page.click('#admin-add-toggle');assert.equal(await page.locator('#admin-add-form').isVisible(),true);assert.equal((await focused(page)).name,'username');
 assert.deepEqual(errors,[]);await context.close();
});

// The reader's "Tải về" list stays light on the night page: each item, "PDF gốc ↗" included, reads at 4.5:1 or more on it.
test('Night page: every item of the reader\'s "Tải về" menu, "PDF gốc ↗" included, reads at 4.5:1 or more on the menu',{skip,timeout:120000},async()=>{
 const {context,page,errors}=await open('/#reader/b1/1',{reader:true});
 await page.waitForSelector('#bilingual-toggle',{timeout:30000});
 await page.click('[data-reader-theme="night"]');await page.click('.reader-download > summary');
 const items=await page.$$eval('.reader-download .menu-list > :is(a,button)',nodes=>{
  const channel=value=>{value/=255;return value<=.03928?value/12.92:((value+.055)/1.055)**2.4;},luminance=color=>{const [r,g,b]=color.match(/[\d.]+/gu).map(Number);return .2126*channel(r)+.7152*channel(g)+.0722*channel(b);};
  return nodes.map(node=>{let back=node,fill=getComputedStyle(node).backgroundColor;while(back.parentElement&&/^(?:transparent|rgba\(0, 0, 0, 0\))$/u.test(fill)){back=back.parentElement;fill=getComputedStyle(back).backgroundColor;}const [a,b]=[luminance(getComputedStyle(node).color),luminance(fill)];return {label:node.textContent.trim(),ratio:Math.round((Math.max(a,b)+.05)/(Math.min(a,b)+.05)*100)/100};});
 });
 assert.ok(items.some(item=>item.label==='PDF gốc ↗'),JSON.stringify(items));
 for(const {label,ratio} of items)assert.ok(ratio>=4.5,`${label}: ${ratio}:1`);
 assert.deepEqual(errors,[]);await context.close();
});

test('Public pages: Google before the terms box says so under the box; a request without a file or a link says so under them',{skip,timeout:120000},async()=>{
 const out=await open('/#account');
 await out.page.waitForSelector('#google-login');
 assert.equal(await out.page.locator('#google-terms-error').isHidden(),true,'no message before anything is pressed');
 // aria-disabled: a screen reader hears it waits for the box; a press still says why (force: Playwright takes aria-disabled as disabled).
 await out.page.click('#google-login',{force:true});
 assert.equal(new URL(out.page.url()).pathname,'/','the page stays');assert.equal((await out.page.locator('#google-terms-error').textContent()).trim(),'Hãy đánh dấu ô đồng ý trước.');
 assert.equal(await out.page.evaluate(()=>document.activeElement?.closest('#google-terms-row')!==null),true,'the focus is on the box');
 assert.match(await out.page.getAttribute('#google-login','aria-describedby'),/google-terms-error/u);
 await out.page.check('#google-terms-row input');assert.equal(await out.page.locator('#google-terms-error').isHidden(),true,'ticked: the message goes');
 assert.match(await out.page.getAttribute('#google-login','href'),/accept_terms=1/u);
 assert.deepEqual(out.errors,[]);await out.context.close();
 const {context,page,errors,sent}=await open('/#account',{me:ME_IN});
 await page.waitForSelector('#account-request');await page.click('#account-request');await page.waitForSelector('#modal[open]');
 await page.fill('#modal [name="title"]','Hồng lâu mộng – hồi 6');await page.click('#modal-form button.primary');
 assert.equal((await page.locator('#request-source-error').textContent()).trim(),'Hãy chọn tệp hoặc dán liên kết.');
 assert.equal(await page.locator('#modal-error').isHidden(),true,'#modal-error is kept for the server');
 assert.equal((await focused(page)).name,'file','the focus is on the file button');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.file-pick')).outlineStyle),'solid','its label shows the focus');
 assert.ok(!sent.includes('POST /api/requests'),'nothing sent');
 assert.deepEqual(errors,[]);await context.close();
});
