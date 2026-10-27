import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';
import {MODES,ADMIN_DEFAULT_MODE,isMode,modeProfile} from '../frontend/translation-modes.js';

// The admin console against the paged light lists of backend/admin-lists.js: GET /api/stories, /api/jobs and
// /api/user-library answer pages of rows without text, glossary or warnings (limit, offset, X-Next-Offset); one job's
// text and one book's glossary come from GET /api/jobs/:id and GET /api/stories/:id. app.js runs as in app-ui.test.mjs.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
const story=(id,extra={})=>({id,title:`Sách ${id}`,author:'',genre:'Lịch sử Trung Hoa',cover_key:null,cover_page:null,source_url:null,owner_user_id:null,visibility:'public',created_at:'2026-10-20 08:00:00',glossary:'{}',owner_name:null,owner_email:null,chapters:1,...extra});
const job=(id,extra={})=>({id,story_id:'s1',filename:`${id}.txt`,file_key:null,mime:'text/plain',status:'review',progress:'',error:null,source_key:null,translation_key:null,created_at:'2026-10-20 08:00:00',has_translation:1,warning_count:0,story_title:'Sử ký',genre:'Lịch sử Trung Hoa',...extra});
// all(selector): what document.querySelectorAll answers (nothing by default); globals: more of the page's globals.
function console_(server,elements={},{all=()=>[],globals={}}={}){
 const root={innerHTML:''},calls=[],intervals=[],timeouts=[],listeners={},location={pathname:'/admin',hash:'',search:'',origin:'https://hoatri.test'};
 const toast={textContent:'',className:'',setAttribute(){}},modal={open:false,innerHTML:'',close(){this.open=false;},showModal(){this.open=true;},addEventListener(){},removeAttribute(){}};
 const document={title:'',visibilityState:'visible',querySelector:selector=>({'#app':root,'#toast':toast,'#modal':modal,...elements})[selector]||null,querySelectorAll:selector=>all(selector,root),addEventListener(type,fn){(listeners[type]||=[]).push(fn);}};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},inAppBrowser:()=>null,openInBrowserHelp(){},MODES,ADMIN_DEFAULT_MODE,isMode,modeProfile,
  location,document,matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},setTimeout:(fn,ms)=>{timeouts.push({fn,ms});const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},FormData,console,...globals});
 context.fetch=async(url,init={})=>{
  calls.push({url,method:init.method||'GET',body:init.body,headers:init.headers||{}});await new Promise(done=>setTimeout(done,1));
  const [status,body,headers={}]=await server(url,init)||(url==='/api/status'?[200,{authenticated:true}]:[200,[]]);
  return {ok:status<300,status,headers:{get:name=>headers[name]??null},json:async()=>body,blob:async()=>new Blob([body instanceof Uint8Array?body:JSON.stringify(body)],{type:headers['Content-Type']||'application/json'})};
 };
 vm.runInContext(source,context);
 return {root,calls,intervals,timeouts,listeners,document,toast,modal,urls:()=>calls.map(call=>call.url),run:code=>vm.runInContext(code,context)};
}

test('The console loads one page of each list (no text, no student shelves), more on demand, and reloads as many as were shown',async()=>{
 const first=Array.from({length:100},(_,i)=>story(`a${i}`)),second=Array.from({length:30},(_,i)=>story(`b${i}`,{owner_user_id:'u1',glossary:null}));
 const page=console_(url=>url==='/api/stories?limit=100'?[200,first,{'X-Next-Offset':'100'}]:url==='/api/stories?offset=100&limit=100'?[200,second]:url==='/api/stories?limit=130'?[200,[...first,...second]]:url==='/api/jobs?limit=100'?[200,[job('j1'),job('j2',{status:'translating'})],{'X-Next-Offset':'100'}]:url==='/api/users'?[200,[]]:null);
 await settle();
 assert.deepEqual(page.urls().sort(),['/api/jobs?limit=100','/api/requests','/api/status','/api/stories?limit=100','/api/users'],'no /api/user-library and no job text in the first load');
 const stories=page.run(`state.route='stories';storiesView()`);
 assert.match(stories,/100\+ hồ sơ tài liệu/u);assert.match(stories,/<div class="load-more"><button type="button" data-load-more="stories">Tải thêm tài liệu<\/button><\/div>/u);
 assert.match(page.run(`translateView()`),/Tài liệu đã tải[\s\S]*?<strong>2\+<\/strong>/u,'a count of the rows loaded says there are more');
 await page.run(`loadMore('stories')`);
 assert.ok(page.urls().includes('/api/stories?offset=100&limit=100'));assert.equal(page.run('state.stories.length'),130);
 assert.doesNotMatch(page.run('storiesView()'),/data-load-more/u,'no more pages');
 page.calls.length=0;await page.run('refresh()');
 assert.ok(page.urls().includes('/api/stories?limit=130'),'a reload keeps the 130 rows shown');assert.equal(page.run('state.stories.length'),130);
});

test('The job editor fetches the job\'s text when it is opened; saving and publishing wait for it; a long save is said',async()=>{
 let detail=[503,{error:'Máy chủ đang bận.'}];const save={handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}};
 const page=console_((url,init)=>url==='/api/jobs?limit=100'?[200,[job('j1',{warning_count:1})]]:url==='/api/jobs/j1'&&(init.method||'GET')==='GET'?detail:url==='/api/jobs/j1'&&init.method==='PATCH'?[200,{ok:true,long:true}]:null,{'#save-job':save,'#edit-source':{value:'子曰：學而時習之'},'#edit-translation':{value:'Khổng Tử nói: Học rồi đem ra luyện tập.'}});
 await settle();
 const waiting=page.run(`state.route='review';state.selected='j1';reviewView()`);
 assert.match(waiting,/Đang tải nguyên tác và bản dịch…/u);assert.match(waiting,/<button id="save-job" disabled>/u);assert.match(waiting,/<button class="primary" id="publish-job" disabled>/u);
 assert.match(waiting,/<textarea id="edit-source" readonly><\/textarea>/u);
 page.run('render()');await settle();
 assert.deepEqual(page.calls.filter(call=>call.url==='/api/jobs/j1').map(call=>call.method),['GET'],'asked once');
 // A failed load says so, with "Thử lại"; it is not retried in a loop.
 page.run('render()');await settle();assert.equal(page.calls.filter(call=>call.url==='/api/jobs/j1').length,1);
 assert.match(page.root.innerHTML,/Chưa tải được nội dung bản dịch: Máy chủ đang bận\. <button type="button" id="job-detail-retry">Thử lại<\/button>/u);
 await save.handlers.click({});assert.equal(page.toast.textContent,'Nội dung bản dịch chưa tải xong. Hãy đợi một chút.');
 assert.ok(!page.calls.some(call=>call.method==='PATCH'),'nothing is saved over a text the editor has not shown');
 detail=[200,{...job('j1'),source:'子曰：學而時習之',translation:'Khổng Tử nói: Học rồi đem ra luyện tập.',warnings:'["Chữ 說 có thể đọc là duyệt."]'}];
 page.run(`loadJobDetail('j1',{again:true})`);await settle();
 const ready=page.root.innerHTML;
 assert.match(ready,/<textarea id="edit-source" >子曰：學而時習之<\/textarea>/u);assert.match(ready,/>Khổng Tử nói: Học rồi đem ra luyện tập\.<\/textarea>/u);
 assert.match(ready,/<div class="warning">Chữ 說 có thể đọc là duyệt\.<\/div>/u);assert.match(ready,/<button id="save-job" >Lưu biên tập<\/button><button class="primary" id="publish-job" >/u);
 await save.handlers.click({});await settle();
 assert.deepEqual(JSON.parse(page.calls.find(call=>call.method==='PATCH').body),{source:'子曰：學而時習之',translation:'Khổng Tử nói: Học rồi đem ra luyện tập.'});
 assert.equal(page.toast.textContent,'Đã lưu bản biên tập. Văn bản dài được lưu riêng, đầy đủ; ô biên tập chỉ hiện 20.000 ký tự đầu.');
 // The list row of an older server that still carries the text is used as is.
 assert.match(page.run(`state.jobs=[{...state.jobs[0],source:'舊',translation:'Cũ',warnings:'[]'}];state.jobDetails={};reviewView()`),/<textarea id="edit-source" >舊<\/textarea>/u);
});

test('While a job runs, only that job is polled (GET /api/jobs?ids=), and its text is fetched again when its status changes',async()=>{
 let release;const finished=new Promise(done=>{release=()=>done([200,{status:'review'}]);});
 const page=console_((url,init)=>url==='/api/jobs?limit=100'?[200,[job('j1',{status:'uploaded'}),job('j2')]]:url==='/api/jobs/j1/run'?finished:url==='/api/jobs?ids=j1'?[200,[job('j1',{status:'translating',progress:'Phần 2/5'})]]:url==='/api/jobs/j1'?[200,{...job('j1'),source:'原文',translation:'',warnings:'[]'}]:null);
 await settle();
 const running=page.run(`runJob('j1')`);
 assert.equal(page.intervals.length,1);page.calls.length=0;
 page.run(`state.jobDetails={j1:{data:{source:'cũ'}}}`);await page.intervals[0]();
 assert.equal(page.urls()[0],'/api/jobs?ids=j1','one row');assert.ok(!page.urls().some(url=>/^\/api\/jobs(?:\?limit=|$)/u.test(url)),'never the whole list');
 assert.equal(page.run(`state.jobs.find(job=>job.id==='j1').progress`),'Phần 2/5');await settle();
 assert.deepEqual(page.urls().slice(1),['/api/jobs/j1'],'its status changed: the editor fetches its text again');assert.equal(page.run(`state.jobDetails.j1.data.source`),'原文');
 release();await running;
});

test('A student\'s book glossary is fetched before it can be edited, so saving never replaces its terms with an empty list',async()=>{
 const page=console_(url=>url==='/api/stories?limit=100'?[200,[story('lib',{glossary:'{"清朝":"triều Thanh"}'}),story('stu',{owner_user_id:'u1',glossary:null})]]:url==='/api/stories/stu'?[200,{...story('stu',{owner_user_id:'u1'}),glossary:'{"秦":"Tần"}',context:'Sử Tần'}]:null);
 await settle();
 assert.match(page.run(`state.route='glossary';state.glossaryId='lib';glossaryView()`),/>清朝 = triều Thanh<\/textarea><\/label><button id="save-glossary" class="primary" style="margin-top:18px" >/u,'a library book carries its glossary');
 const waiting=page.run(`state.glossaryId='stu';glossaryView()`);
 assert.match(waiting,/<textarea id="glossary-text" rows="12" readonly/u);assert.match(waiting,/Đang tải bảng thuật ngữ của tài liệu này…/u);assert.match(waiting,/<button id="save-glossary" class="primary" style="margin-top:18px" disabled>/u);
 page.run('render()');await settle();
 assert.ok(page.urls().includes('/api/stories/stu'));assert.ok(!page.urls().includes('/api/stories/lib'));
 assert.match(page.root.innerHTML,/>秦 = Tần<\/textarea><\/label><button id="save-glossary" class="primary" style="margin-top:18px" >/u);
});

test('Students: the book counts come with the accounts; each one\'s books load when opened, a page at a time',async()=>{
 const users=[{id:'u1',email:'lan@example.test',name:'Lan',provider:'local',books:3,requests:0},{id:'u2',email:'minh@example.test',name:'Minh',provider:'google',books:0,requests:0}];
 const shelf=[story('b1',{owner_user_id:'u1',visibility:'private'}),story('b2',{owner_user_id:'u1',visibility:'public'})];
 const page=console_(url=>url==='/api/users'?[200,users]:url==='/api/user-library?user=u1&offset=0&limit=100'?[200,shelf,{'X-Next-Offset':'2'}]:url==='/api/user-library?user=u1&offset=2&limit=100'?[200,[story('b3',{owner_user_id:'u1'})]]:null);
 await settle();
 const closed=page.run(`state.route='users';usersView()`);
 assert.match(closed,/<strong>3<\/strong><span>Tài liệu cá nhân<\/span>/u);assert.match(closed,/<span>3 tài liệu<\/span>/u);
 assert.match(closed,/<button type="button" class="user-books-open" data-user-books="u1">Xem 3 tài liệu<\/button>/u);assert.match(closed,/Người học này chưa có tài liệu\./u);
 page.run(`loadUserBooks('u1')`);assert.match(page.run('usersView()'),/Đang tải tài liệu…/u);await settle();
 const open=page.run('usersView()');
 assert.match(open,/<h2>Sách b1<\/h2>/u);assert.match(open,/<button type="button" data-user-books-more="u1" >Tải thêm tài liệu<\/button><button type="button" data-user-books-hide="u1">Thu gọn<\/button>/u);
 assert.equal(page.run(`adminStory('b2').visibility`),'public','actions on a shelf book find it');
 page.run(`loadUserBooks('u1',{more:true})`);await settle();
 assert.equal(page.run(`state.userBooks.u1.rows.length`),3);assert.doesNotMatch(page.run('usersView()'),/data-user-books-more/u);
});

// An <img> cannot send the admin header (the admin's cookie counts only with it), and the admin has no reader cookie:
// the covers of private books (a student's, an unpublished draft) are fetched with the header into object URLs, revoked
// when the admin opens another view.
test('Covers of private books load with the admin header as object URLs, are reused while the view stays, and are revoked when it changes',async()=>{
 const users=[{id:'u1',email:'lan@example.test',name:'Lan',provider:'local',books:3,requests:0}];
 const shelf=[story('b1',{owner_user_id:'u1',visibility:'private',cover_key:'covers/b1-1.jpg'}),story('b2',{owner_user_id:'u1',visibility:'public',cover_key:'covers/b2-1.jpg'}),story('b3',{owner_user_id:'u1',visibility:'private',cover_key:'covers/b3-1.jpg'})];
 // The <img> elements a render makes, as the page would hold them (an attribute removed, an element replaced).
 let drawn=null,images=[];
 const all=(selector,root)=>{
  if(selector!=='img[data-admin-cover]')return [];
  if(root.innerHTML!==drawn){drawn=root.innerHTML;images=[...drawn.matchAll(/<img class="book-cover" src="([^"]*)" data-admin-cover="([^"]+)" data-cover-key="([^"]+)" alt="([^"]*)">/gu)].map(([,src,id,key,alt])=>({src,alt,dataset:{adminCover:id,coverKey:key},replaced:null,removeAttribute(name){if(name==='data-admin-cover')delete this.dataset.adminCover;},set outerHTML(value){this.replaced=value;}}));}
  return images.filter(image=>image.dataset.adminCover&&!image.replaced);
 };
 const made=[],revoked=[],URL={createObjectURL:blob=>{made.push(blob);return `blob:cover-${made.length}`;},revokeObjectURL:url=>{revoked.push(url);}};
 const page=console_((url,init)=>url==='/api/users'?[200,users]:url==='/api/user-library?user=u1&offset=0&limit=100'?[200,shelf]:url==='/api/covers/b1?v=covers%2Fb1-1.jpg'?(init.headers?.['X-Hoa-Tri-Admin']==='1'?[200,new Uint8Array([255,216,255,224]),{'Content-Type':'image/jpeg'}]:[404,{error:'Không tìm thấy ảnh bìa hoặc bạn không có quyền xem.'}]):url.startsWith('/api/covers/')?[404,{error:'Chưa có ảnh bìa.'}]:null,{},{all,globals:{URL}});
 await settle();
 page.run(`state.route='users';loadUserBooks('u1')`);await settle();await settle();
 const html=page.root.innerHTML,first=images;
 assert.match(html,/<img class="book-cover" src="\/api\/covers\/b2\?v=covers%2Fb2-1\.jpg" alt="Bìa Sách b2" loading="lazy">/u,'a public cover needs no header');
 const coverCalls=page.calls.filter(call=>call.url.startsWith('/api/covers/'));
 assert.deepEqual(coverCalls.map(call=>[call.url,call.headers['X-Hoa-Tri-Admin'],call.headers.Authorization]),[['/api/covers/b1?v=covers%2Fb1-1.jpg','1',undefined],['/api/covers/b3?v=covers%2Fb3-1.jpg','1',undefined]],'the header, never a token');
 assert.equal(first[0].src,'blob:cover-1');assert.equal(made.length,1);assert.match(first[1].replaced,/cover-placeholder[\s\S]*Chưa có ảnh bìa/u,'a cover that cannot be loaded shows the placeholder');
 // Drawn again in the same view: the object URL is reused, nothing is fetched again.
 page.run('render()');
 assert.match(page.root.innerHTML,/<img class="book-cover" src="blob:cover-1" alt="Bìa Sách b1">/u);assert.equal(page.calls.filter(call=>call.url.startsWith('/api/covers/')).length,2);assert.deepEqual(revoked,[]);
 // Another view: the URL is revoked; signing out leaves none behind either.
 page.run(`go('stories')`);assert.deepEqual(revoked,['blob:cover-1']);
 page.run(`go('users')`);await settle();assert.equal(made.length,2,'back in the view, the cover is fetched again');
 await page.run('logout()');assert.deepEqual(revoked,['blob:cover-1','blob:cover-2']);
});

// Translation requests waiting for the admin are counted on the "Yêu cầu dịch" button and in the tab's title. A console
// left open asks for the list again (every 5 minutes, and when the admin comes back to the tab, at most once a minute)
// and redraws only the count and the title, never the view (a form may be half filled).
test('Pending requests: a count on "Yêu cầu dịch" and in the title, kept up to date while the console stays open',async()=>{
 const request=(id,status)=>({id,title:`Yêu cầu ${id}`,status,visibility:'private',notes:'',source_url:null,reader_name:'Lan'});
 let requests=[request('r1','pending'),request('r2','pending'),request('r3','accepted')];
 const button={innerHTML:''},page=console_(url=>url==='/api/requests'?[200,requests]:null,{'.sidebar [data-route="requests"]':button});
 await settle();
 const badge=count=>`Yêu cầu dịch<span class="count" aria-hidden="true">${count}</span><span class="visually-hidden"> (${count} yêu cầu mới)</span>`;
 assert.ok(page.root.innerHTML.includes(`${badge(2)}</button>`),'the count, and its words for a screen reader');assert.equal(page.document.title,'(2) Hoa Trí — Quản trị');
 assert.match(page.run('translateView()'),/Yêu cầu mới[\s\S]*?<strong>02<\/strong>/u);
 // Another student sends a request meanwhile.
 requests=[request('r4','pending'),...requests];const drawn=page.root.innerHTML,asked=()=>page.urls().filter(url=>url==='/api/requests').length;
 assert.equal(asked(),1);
 for(const fn of page.listeners.focus||[])await fn();assert.equal(asked(),1,'not again within a minute of the last load');
 page.run('requestsCheckedAt=Date.now()-61000');for(const fn of page.listeners.focus||[])await fn();await settle();
 assert.equal(asked(),2,'coming back to the tab after a minute asks again');
 assert.ok(button.innerHTML.endsWith(badge(3)),button.innerHTML);assert.equal(page.document.title,'(3) Hoa Trí — Quản trị');
 assert.equal(page.root.innerHTML,drawn,'the view itself is not redrawn');
 // Every 5 minutes, also when the tab is hidden; nothing while signed out.
 const tick=page.timeouts.find(item=>item.ms===5*60*1000);assert.ok(tick,'a check every 5 minutes');
 requests=requests.map(item=>({...item,status:'accepted'}));page.run('requestsCheckedAt=0');tick.fn();await settle();
 assert.equal(asked(),3);assert.equal(button.innerHTML,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18v13H9l-6 4z"/></svg>Yêu cầu dịch');
 assert.equal(page.document.title,'Hoa Trí — Quản trị','no count when nothing waits');
 assert.equal(page.timeouts.filter(item=>item.ms===5*60*1000).length,2,'the next check is planned');
 page.run('state.status={authenticated:false};requestsCheckedAt=0');for(const fn of page.listeners.visibilitychange||[])await fn();await settle();
 assert.equal(asked(),3,'signed out: nothing is asked');
});

// The same console against the real Worker (backend/admin-lists.js and the detail routes) on an in-memory D1: 123 books
// of which 120 are students' with 1,000-term glossaries, 130 jobs with long texts.
test('Against the real Worker: light pages, more on demand, a job\'s text, a student\'s glossary and shelf, polling by id',async t=>{
 const {default:worker}=await import('./worker.js'),{sqliteEnvironment}=await import('./test-support/sqlite-d1.mjs');
 const TOKEN='a'.repeat(64),{sqlite,env}=sqliteEnvironment(t,{vars:{ADMIN_TOKEN:TOKEN}});
 const glossary=JSON.stringify(Object.fromEntries(Array.from({length:1000},(_,i)=>[`术语${i}`,`thuật ngữ ${i}`])));
 for(let i=0;i<3;i++)sqlite.prepare("INSERT INTO stories(id,title,genre,glossary,created_at) VALUES(?,?,'Giáo dục',?,?)").run(`lib-${i}`,`Sách ${i}`,JSON.stringify({书:'sách'}),`2026-01-0${i+1} 00:00:00`);
 for(let u=0;u<2;u++){
  sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)').run(`u${u}`,`g${u}`,`hs${u}@example.test`,`Học sinh ${u}`,`2026-02-0${u+1} 00:00:00`);
  for(let b=0;b<60;b++)sqlite.prepare("INSERT INTO stories(id,title,genre,glossary,owner_user_id,visibility,created_at) VALUES(?,?,'Giáo dục',?,?,'private',?)").run(`u${u}-b${b}`,`Bản dịch ${b}`,glossary,`u${u}`,`2026-03-01 00:${String(b).padStart(2,'0')}:00`);
 }
 for(let j=0;j<130;j++)sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,translation,warnings,created_at) VALUES(?,?,?,?,?,?,?,?)").run(`job-${j}`,'lib-0',`bai-${j}.txt`,j%2?'review':'translating','原文'.repeat(5000),'Bản dịch '.repeat(1000),JSON.stringify(['Cảnh báo']),`2026-04-01 00:${String(Math.floor(j/60)).padStart(2,'0')}:${String(j%60).padStart(2,'0')}`);
 // An admin made with the token once (POST /api/admin/setup signs her in); the browser then sends her cookie with every
 // request, which counts because the console adds X-Hoa-Tri-Admin: 1.
 const made=await worker.fetch(new Request('https://hoatri.example/api/admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,username:'quantri',name:'Cô Lan',password:'mai-hoa-no-som-tren-doi-7'})}),env,{waitUntil(){}});
 assert.equal(made.status,201,await made.clone().text());const cookie=made.headers.getSetCookie().find(line=>line.startsWith('cat_hien_admin='))?.split(';')[0];assert.ok(cookie);
 let cookieless=0;
 const page=console_(async(url,init)=>{if(init.headers?.['X-Hoa-Tri-Admin']!=='1')cookieless++;const response=await worker.fetch(new Request('https://hoatri.example'+url,{method:init.method||'GET',headers:{...init.headers,Cookie:cookie},body:init.body}),env,{waitUntil(){}});return [response.status,await response.json(),{'X-Next-Offset':response.headers.get('X-Next-Offset')}];});
 await page.run('refresh()');
 assert.equal(page.run('state.status.admin.username'),'quantri');assert.equal(page.run('state.status.via'),'session');
 assert.equal(page.run('state.status.authenticated'),true);
 assert.deepEqual([page.run('state.stories.length'),page.run('state.more.stories'),page.run('state.jobs.length'),page.run('state.more.jobs')],[100,100,100,100]);
 assert.equal(page.run(`state.stories.find(story=>story.owner_user_id).glossary`),null,'no student glossary in the list');assert.equal(page.run(`'source' in state.jobs[0]`),false,'no job text in the list');
 await page.run(`loadMore('stories')`);assert.deepEqual([page.run('state.stories.length'),page.run('state.more.stories')],[123,null]);
 await page.run(`loadMore('jobs')`);assert.deepEqual([page.run('state.jobs.length'),page.run('state.more.jobs')],[130,null]);
 // The job editor.
 page.run(`state.route='review';state.selected='job-5';render()`);await settle();
 assert.equal(page.run(`state.jobDetails['job-5'].data.source.length`),10000);assert.ok(page.root.innerHTML.includes('<textarea id="edit-source" >原文原文'),'the editor shows the text');assert.ok(page.root.innerHTML.includes('<div class="warning">Cảnh báo</div>'),'and its warnings');
 // The glossary of a student's book.
 page.run(`state.route='glossary';state.glossaryId='u1-b7';render()`);await settle();
 assert.ok(page.root.innerHTML.includes('术语999 = thuật ngữ 999</textarea>'),'the 1,000 terms are in the editor');
 // A student's shelf.
 page.run(`state.route='users';loadUserBooks('u0')`);await settle();
 assert.equal(page.run(`state.userBooks.u0.rows.length`),60);assert.equal(page.run(`state.users.find(user=>user.id==='u0').books`),60);
 // Polling one running job.
 sqlite.prepare("UPDATE jobs SET status='review',progress='Xong' WHERE id='job-4'").run();await page.run(`pollJobs(['job-4'])`);
 assert.equal(page.run(`state.jobs.find(job=>job.id==='job-4').status`),'review');
 assert.equal(cookieless,0,'every request of the console carries X-Hoa-Tri-Admin: 1');
 // The same cookie without the header (a public page, the reader's frame) is nobody.
 assert.deepEqual(await (await worker.fetch(new Request('https://hoatri.example/api/status',{headers:{Cookie:cookie}}),env,{waitUntil(){}})).json(),{authenticated:false});
});

// Fake elements for the forms these tests submit: attributes kept, one handler per event, a form's error box and its
// note of success, named inputs and submit button; FakeFormData reads a form's values.
class Element{
 constructor(props={}){this.attributes=new Map();this.handlers={};this.hidden=false;this.disabled=false;this.textContent='';this.isConnected=true;Object.assign(this,props);}
 setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}removeAttribute(name){this.attributes.delete(name);}
 addEventListener(type,fn){this.handlers[type]=fn;}fire(type,event={}){return this.handlers[type]?.({preventDefault(){},currentTarget:this,target:this,...event});}
 focus(){this.focused=true;}
}
function fakeForm(id,values){
 const box=new Element({id:`${id.replace(/-form$/u,'')}-error`,hidden:true}),done=new Element({id:`${id.replace(/-form$/u,'')}-done`,hidden:true,innerHTML:''}),button=new Element(),inputs=Object.keys(values).map(name=>new Element({name}));
 return Object.assign(new Element({id,values}),{box,done,button,inputs,input:name=>inputs.find(input=>input.name===name),querySelector:selector=>({'.form-error':box,'.form-done':done,'[type="submit"]':button})[selector]||null,querySelectorAll:selector=>selector==='input[name]'?inputs:[]});
}
class FakeFormData{constructor(form){this.list=Object.entries(form?.values||{});}get(name){return this.list.find(([key])=>key===name)?.[1]??null;}*[Symbol.iterator](){yield* this.list;}}
const SIGNED_OUT=[401,{error:'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.',code:'admin_signed_out'}];
const ADMIN={authenticated:true,admin:{username:'lan.nguyen',name:'Nguyễn Thị Lan'},via:'session',translationMode:'premium'};

// The session cookie counts only with X-Hoa-Tri-Admin: 1 (backend/admin-auth.js). When the session has ended (12 hours,
// 2 hours idle, signed out elsewhere) the next answer is 401 admin_signed_out: the sign-in form comes back in place of
// the console, and what the admin had typed in the job editor is there again once she has signed in.
test('Every call of the console carries the admin header; a session that ended brings back the sign-in form, and the edited text after signing in',async()=>{
 let signedIn=true;const text={'#edit-source':'子曰','#edit-translation':'Khổng Tử nói.'};
 // The editor's textareas as the page draws them: readonly while the job's text loads.
 const field=id=>({get value(){return text[id];},set value(next){text[id]=next;},get readOnly(){return new RegExp(`<textarea id="${id.slice(1)}" readonly`,'u').test(page.root.innerHTML);}});
 const save=new Element(),login=fakeForm('admin-login-form',{username:'lan.nguyen',password:'mai-hoa-no-som-tren-doi-7'});
 const page=console_((url,init)=>{
  if(url==='/api/status')return [200,signedIn?ADMIN:{authenticated:false}];
  if(url==='/api/admin/login'){signedIn=true;return [200,{admin:ADMIN.admin}];}
  if(!signedIn)return SIGNED_OUT;
  if(url==='/api/jobs?limit=100')return [200,[job('j1')]];
  if(url==='/api/jobs/j1'&&(init.method||'GET')==='GET')return [200,{...job('j1'),source:'子曰',translation:'Khổng Tử nói.',warnings:'[]'}];
  if(url==='/api/jobs/j1'&&init.method==='PATCH')return [200,{ok:true}];
 },{'#save-job':save,'#edit-source':field('#edit-source'),'#edit-translation':field('#edit-translation'),'#admin-login-form':login},{globals:{FormData:FakeFormData}});
 await settle();
 page.run(`state.route='review';state.selected='j1';render()`);await settle();
 assert.match(page.root.innerHTML,/<textarea id="edit-translation"  placeholder="[^"]*">Khổng Tử nói\.<\/textarea>/u);
 assert.ok(page.calls.length>=5&&page.calls.every(call=>call.headers['X-Hoa-Tri-Admin']==='1'&&!call.headers.Authorization),'the header on every call, never a token');
 // She edits; the session ends meanwhile; she saves.
 text['#edit-translation']='Khổng Tử nói: học rồi đem ra luyện tập.';signedIn=false;
 await save.handlers.click({});
 assert.equal(page.toast.textContent,'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.');
 assert.match(page.root.innerHTML,/<h1 id="admin-auth-title">Đăng nhập quản trị<\/h1>[\s\S]*data-focus-first>Phiên quản trị đã kết thúc\. Hãy đăng nhập lại; nội dung đang soạn dở vẫn được giữ trên trang này\.<\/p><form id="admin-login-form"/u);
 assert.doesNotMatch(page.root.innerHTML,/class="sidebar"/u);
 assert.deepEqual([page.run('state.route'),page.run('state.selected')],['review','j1'],'where she was is kept');
 // Late answers to what was asked while signed in (the job's text, a translation step, the address) redraw nothing while
 // the sign-in card stays the same: what she types there and the focus stay.
 let writes=0,drawn=page.root.innerHTML;Object.defineProperty(page.root,'innerHTML',{get:()=>drawn,set:value=>{writes++;drawn=value;},configurable:true});
 page.run('render()');page.run(`loadJobDetail('j1',{again:true})`);await settle();page.run(`location.hash='#review';routeFromUrl()`);
 assert.equal(writes,0,'the sign-in card is not drawn again');
 // The sign-in form replaced the editor; signing in again draws it with what she had typed.
 text['#edit-translation']='';page.calls.length=0;
 await login.fire('submit');await settle();await settle();
 assert.deepEqual(JSON.parse(page.calls.find(call=>call.url==='/api/admin/login').body),{username:'lan.nguyen',password:'mai-hoa-no-som-tren-doi-7'});
 assert.match(page.root.innerHTML,/class="sidebar"/u);assert.equal(page.toast.textContent,'Đã đăng nhập khu quản trị.');
 assert.match(page.root.innerHTML,/<textarea id="edit-translation"  placeholder="[^"]*">Khổng Tử nói\.<\/textarea>/u,'the server\'s text is drawn');
 assert.equal(text['#edit-translation'],'Khổng Tử nói: học rồi đem ra luyện tập.','then what she had typed is put back');assert.equal(page.run('state.adminDrafts'),null,'once');
 assert.ok(!page.calls.some(call=>call.method==='PATCH'),'nothing is saved by itself');
 // A wrong password is said in the form: its error box, focused, both fields marked, the button usable again.
 page.run(`state.status={authenticated:false};render()`);login.values={username:'lan.nguyen',password:'sai'};
 page.run(`fetch=async()=>({ok:false,status:401,headers:{get:()=>null},json:async()=>({error:'Tên đăng nhập hoặc mật khẩu không đúng.'})})`);
 await login.fire('submit');
 assert.deepEqual([login.box.textContent,login.box.hidden,login.box.focused],['Tên đăng nhập hoặc mật khẩu không đúng.',false,true]);
 assert.deepEqual(login.inputs.map(input=>input.getAttribute('aria-invalid')),['true','true']);assert.equal(login.button.disabled,false);
});

test('What one admin left unsaved when the session ended is never put back for another admin signing in on the same page',async()=>{
 let who='lan.nguyen',signedIn=true;const text={'#edit-source':'子曰','#edit-translation':'Bản dịch.'};
 const field=id=>({get value(){return text[id];},set value(next){text[id]=next;},get readOnly(){return new RegExp(`<textarea id="${id.slice(1)}" readonly`,'u').test(page.root.innerHTML);}});
 const save=new Element(),source=new Element({value:''});
 const page=console_((url,init)=>{
  if(url==='/api/status')return [200,signedIn?{...ADMIN,admin:{username:who,name:who}}:{authenticated:false}];
  if(url==='/api/admin/login'){signedIn=true;who=JSON.parse(init.body).username;return [200,{admin:{username:who,name:who}}];}
  if(!signedIn)return SIGNED_OUT;
  if(url==='/api/jobs?limit=100')return [200,[job('j1')]];
  if(url==='/api/jobs/j1')return [200,{...job('j1'),source:'子曰',translation:'Bản dịch.',warnings:'[]'}];
 },{'#save-job':save,'#edit-source':field('#edit-source'),'#edit-translation':field('#edit-translation'),'#source-input':source});
 await settle();page.run(`state.route='review';state.selected='j1';render()`);await settle();
 text['#edit-translation']='Bản dịch đang sửa dở.';source.value='原文 đang nhập';signedIn=false;await save.handlers.click({});
 assert.equal(page.run('state.adminDrafts.fields["edit-translation"]'),'Bản dịch đang sửa dở.');assert.equal(page.run('state.draftText'),'原文 đang nhập');
 text['#edit-translation']='';
 await page.run(`api('/admin/login',{method:'POST',body:{username:'thay.minh',password:'mot-mat-khau-khac-de-doan-9'}}).then(()=>enterAdmin('Đã đăng nhập khu quản trị.'))`);await settle();await settle();
 assert.match(page.root.innerHTML,/<textarea id="edit-translation"  placeholder="[^"]*">Bản dịch\.<\/textarea>/u);
 assert.equal(text['#edit-translation'],'','nothing of hers is put into his editor');
 assert.deepEqual([page.run('state.adminDrafts'),page.run('state.draftText')],[null,'']);
});

test('Signing out asks the server first: a refusal keeps the console and says why; then the sign-in form, with nothing of the console kept',async()=>{
 let answer=[500,{error:'Máy chủ gặp lỗi.'}];
 const page=console_(url=>url==='/api/status'?[200,ADMIN]:url==='/api/admin/logout'?answer:url==='/api/jobs?limit=100'?[200,[job('j1')]]:null);
 await settle();
 await assert.rejects(page.run('logout()'),{message:'Chưa đăng xuất được (mã 500). Bạn vẫn đang đăng nhập; hãy thử lại sau vài giây.'});
 assert.match(page.root.innerHTML,/class="sidebar"/u);assert.equal(page.run('state.status.authenticated'),true);
 const sent=page.calls.find(call=>call.url==='/api/admin/logout');assert.equal(sent.method,'POST');assert.equal(sent.headers['X-Hoa-Tri-Admin'],'1');
 answer=[200,{ok:true}];await page.run('signOutAdmin()');
 assert.equal(page.toast.textContent,'Đã đăng xuất khỏi khu quản trị.');
 assert.match(page.root.innerHTML,/<form id="admin-login-form"/u);assert.doesNotMatch(page.root.innerHTML,/class="sidebar"|admin-auth-notice/u);
 assert.deepEqual([page.run('state.jobs.length'),page.run('state.status.authenticated'),page.run('state.route')],[0,false,'translate']);
 // The server could not delete its session but cleared the cookie: signed out here, in its words.
 page.run(`state.status=${JSON.stringify(ADMIN)};render()`);answer=[503,{error:'Đã đăng xuất trên trình duyệt này, nhưng máy chủ chưa xóa được phiên; phiên sẽ tự hết hạn sau tối đa 2 giờ không dùng.',code:'logout_incomplete'}];
 await page.run('signOutAdmin()');
 assert.equal(page.run('state.status.authenticated'),false);assert.match(page.toast.textContent,/^Đã đăng xuất trên trình duyệt này/u);
 // No connection: still signed in.
 page.run(`state.status=${JSON.stringify(ADMIN)};render()`);page.run(`fetch=async()=>{throw new TypeError('Failed to fetch');}`);
 await assert.rejects(page.run('logout()'),/Không kết nối được máy chủ nên chưa đăng xuất được/u);assert.equal(page.run('state.status.authenticated'),true);
});

// A job keeps its own "Cách dịch" (jobs.mode; the server keeps it on a run that names none): the console names one only
// where the admin picked it, in the upload form (POST /api/jobs) or beside "Bắt đầu dịch / Tiếp tục xử lý" on the job's
// page. The list rows are the light ones of backend/admin-lists.js; the job's detail carries its mode.
test('"Cách dịch" goes with the job: POST /api/jobs carries the mode picked in the form; a job\'s page shows its own and sends only one picked there',async()=>{
 const rerun=new Element(),runMode=new Element({value:'economy'});let created=false;
 const page=console_((url,init)=>url==='/api/status'?[200,{...ADMIN,aiConfigured:true}]:url==='/api/stories?limit=100'?[200,[story('s1')]]:url==='/api/jobs'&&init.method==='POST'?(created=true,[201,{id:'j9',ids:['j9'],chapters:1}]):url==='/api/jobs?limit=100'?[200,[job('j1',{status:'failed',progress:'Đã dịch 1 phần · Cách dịch: Tiết kiệm'}),...(created?[job('j9',{status:'uploaded',filename:'Văn bản trực tiếp',created_at:'2026-10-26 08:00:00'})]:[])]]:/^\/api\/jobs\/j[19]\/run$/u.test(url)?[200,{status:'failed'}]:url==='/api/jobs/j1'?[200,{...job('j1',{status:'failed'}),mode:'economy',source:'原文',translation:'',warnings:'[]'}]:null,
  {'#story-select':new Element({value:'s1'}),'#genre':new Element({value:'Lịch sử Trung Hoa',options:[{value:'Lịch sử Trung Hoa'}]}),'#source-input':new Element({value:'原文'}),'#job-mode':new Element({value:'quality'}),'#run-mode':runMode,'#rerun':rerun});
 await settle();
 page.run(`state.tab='text'`);await page.run(`uploadJob({currentTarget:{}},false)`);
 const sent=page.calls.find(call=>call.url==='/api/jobs'&&call.method==='POST');assert.equal(sent.body.get('mode'),'quality');assert.equal(sent.body.get('story_id'),'s1');
 assert.deepEqual(page.calls.filter(call=>call.url==='/api/jobs/j9/run').map(call=>call.body),[undefined],'starting it names no mode: the job carries the one picked in the form');
 // A job stopped half-way in "Tiết kiệm": its page shows that mode, and "Tiếp tục xử lý" left as it is names none, so it
 // goes on in Tiết kiệm rather than in the default (Kỹ nhất).
 page.run(`state.route='review';state.selected='j1';render()`);await settle();
 assert.match(page.root.innerHTML,/<select id="run-mode" ><option value="economy" selected>Tiết kiệm<\/option>/u);
 await rerun.handlers.click({});await settle();
 const runs=()=>page.calls.filter(call=>call.url==='/api/jobs/j1/run');
 assert.deepEqual(runs().map(call=>call.body),[undefined]);
 // A mode picked beside the button goes with the run, and stays shown when the page is drawn again.
 runMode.value='quality';await runMode.fire('change');
 assert.match(page.run('reviewView()'),/<option value="quality" selected>Kỹ hơn<\/option>/u);
 await rerun.handlers.click({});await settle();
 assert.deepEqual(JSON.parse(runs()[1].body),{mode:'quality'});assert.equal(runs()[1].headers['Content-Type'],'application/json');
});

// The same against the real Worker's routes: GET /api/jobs (light rows) and GET /api/jobs/:id. /run itself is answered
// here (it would start translating); what the console sends with it is recorded.
test('Against the real Worker: a job\'s page shows the mode the job was made with, and resuming it untouched names no mode',async t=>{
 const {default:worker}=await import('./worker.js'),{sqliteEnvironment}=await import('./test-support/sqlite-d1.mjs');
 const TOKEN='a'.repeat(64),{sqlite,env}=sqliteEnvironment(t,{vars:{ADMIN_TOKEN:TOKEN}});
 const made=await worker.fetch(new Request('https://hoatri.example/api/admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,username:'quantri',name:'Cô Lan',password:'mai-hoa-no-som-tren-doi-7'})}),env,{waitUntil(){}});
 assert.equal(made.status,201,await made.clone().text());const cookie=made.headers.getSetCookie().find(line=>line.startsWith('cat_hien_admin='))?.split(';')[0];
 sqlite.prepare("INSERT INTO stories(id,title,genre,glossary,created_at) VALUES('s1','Sách','Giáo dục','{}','2026-01-01 00:00:00')").run();
 // Made with "Tiết kiệm" and stopped half-way (the Gemini quota ran out); the server's default is Kỹ nhất.
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,status,source,translation,warnings,mode,created_at) VALUES('j1','s1','a.txt','failed','原文','','[]','economy','2026-04-01 00:00:00')").run();
 const runs=[],rerun=new Element();
 const page=console_(async(url,init)=>{
  if(url==='/api/jobs/j1/run'){runs.push(init.body??null);return [200,{status:'failed'}];}
  const response=await worker.fetch(new Request('https://hoatri.example'+url,{method:init.method||'GET',headers:{...init.headers,Cookie:cookie},body:init.body}),env,{waitUntil(){}});
  return [response.status,await response.json(),{'X-Next-Offset':response.headers.get('X-Next-Offset')}];
 },{'#rerun':rerun});
 await page.run('refresh()');assert.equal(page.run('state.status.translationMode'),'premium');
 page.run(`state.route='review';state.selected='j1';render()`);await settle();await settle();
 assert.equal(/<select id="run-mode"[^>]*>[\s\S]*?<option value="([a-z]+)" selected>/u.exec(page.root.innerHTML)?.[1],'economy','the job\'s own mode, not the default');
 await rerun.handlers.click({});await settle();await settle();
 assert.deepEqual(runs,[null],'no mode named: the server keeps Tiết kiệm');
});

// What the console asks by itself carries X-Hoa-Tri-Background: 1, which never keeps the admin session alive
// (backend/admin-auth.js): the 5-minute check of new requests, the one on coming back to the tab, a running job's row.
// So a console left open ends 2 hours after its last use, and the next check then brings back the sign-in form instead
// of leaving the console on screen.
test('What the console asks by itself carries X-Hoa-Tri-Background: 1; a check that finds the session ended brings back the sign-in form',async()=>{
 let signedIn=true,release;const finished=new Promise(done=>{release=()=>done([200,{status:'review'}]);});
 const page=console_(url=>url==='/api/status'?[200,signedIn?ADMIN:{authenticated:false}]:!signedIn?SIGNED_OUT:url==='/api/jobs?limit=100'?[200,[job('j1',{status:'uploaded'})]]:url==='/api/jobs/j1/run'?finished:url==='/api/jobs?ids=j1'?[200,[job('j1',{status:'translating'})]]:null);
 await settle();
 const marked=()=>page.calls.filter(call=>call.headers['X-Hoa-Tri-Background']==='1').map(call=>call.url);
 assert.ok(page.calls.length>=5);assert.deepEqual(marked(),[],'loading the console is the admin using it');
 // Every 5 minutes, and on coming back to the tab.
 const tick=page.timeouts.find(item=>item.ms===5*60*1000);page.run('requestsCheckedAt=0');tick.fn();await settle();
 page.run('requestsCheckedAt=0');for(const fn of page.listeners.focus||[])await fn();await settle();
 assert.deepEqual(marked(),['/api/requests','/api/requests']);
 // A running job: its steps are the admin's and keep the session while it runs; the 4-second look at its row does not.
 const running=page.run(`runJob('j1')`);await settle();await page.intervals[0]();
 assert.deepEqual(marked().slice(2),['/api/jobs?ids=j1']);
 const step=page.calls.find(call=>call.url==='/api/jobs/j1/run');assert.equal(step.headers['X-Hoa-Tri-Background'],undefined);assert.equal(step.headers['X-Hoa-Tri-Admin'],'1');
 release();await running;
 // The session ends on the server (2 hours unused, signed out elsewhere): the next check brings back the sign-in form.
 signedIn=false;page.run('requestsCheckedAt=0');for(const fn of page.listeners.focus||[])await fn();await settle();
 assert.equal(page.run('state.status.authenticated'),false);assert.match(page.root.innerHTML,/data-focus-first>Phiên quản trị đã kết thúc\.[^<]*<\/p><form id="admin-login-form"/u);
});

// A run (or a split) that ends while the admin is in another view draws again only what shows jobs: a form typed in
// elsewhere (Cài đặt, a glossary) keeps its text and the focus, and Xưởng dịch gets new counts and recent jobs, not a new
// upload form. The request count and the title follow everywhere.
test('A run or a split that ends redraws only what shows jobs: other views keep what is typed in them, Xưởng dịch its form',async()=>{
 let release=null,splits=0;const step=()=>new Promise(done=>{release=()=>done([200,{status:'review'}]);});
 const stats={outerHTML:''},recent={outerHTML:'',querySelectorAll:()=>[]},button={innerHTML:''};
 const page=console_(url=>url==='/api/jobs?limit=100'?[200,[job('j1',{status:'uploaded'})]]:url==='/api/jobs/j1/run'?step():url==='/api/jobs/j1/prepare'?[200,{status:++splits<3?'splitting':'prepared'}]:url==='/api/requests'?[200,[{id:'r1',title:'Yêu cầu',status:'pending',visibility:'private'}]]:null,{'.stats':stats,'.recent':recent,'.sidebar [data-route="requests"]':button});
 await settle();
 let writes=0,drawn=page.root.innerHTML;Object.defineProperty(page.root,'innerHTML',{get:()=>drawn,set:value=>{writes++;drawn=value;},configurable:true});
 const run=async route=>{const running=page.run(`runJob('j1')`);await settle();page.run(`go('${route}')`);writes=0;stats.outerHTML=recent.outerHTML='';release();await running;await settle();return writes;};
 // Cài đặt (its forms) and Thuật ngữ (its glossary) are not drawn again; the count of new requests is.
 for(const route of ['settings','glossary']){button.innerHTML='';assert.equal(await run(route),0,route);assert.equal(page.document.title,'(1) Hoa Trí — Quản trị');assert.match(button.innerHTML,/<span class="count" aria-hidden="true">1<\/span>/u,route);}
 // Xưởng dịch: only its counts and recent jobs.
 assert.equal(await run('translate'),0);assert.match(stats.outerHTML,/^<div class="stats">/u);assert.match(recent.outerHTML,/^<section class="recent">[\s\S]*Tài liệu gần đây/u);
 // The review view shows the jobs: drawn again.
 assert.ok(await run('review')>0);
 // "Chia PDF trước": each splitting step and the end leave Cài đặt alone too.
 page.run(`go('settings')`);writes=0;await page.run(`prepareJob('j1')`);assert.equal(writes,0);assert.equal(splits,3);
});

// Thuật ngữ stays as drawn when a run or a split ends, but the refresh drops a student's book glossary, which its list row
// does not carry: it is asked for again, so "Lưu bảng thuật ngữ" sends what is typed and a glossary still loading opens.
// Its answer never draws over an editor that can be typed in; an answer that failed is asked for again by "Lưu".
test('A run that ends while a student\'s book glossary is open: typed terms stay and are saved, one still loading opens',async()=>{
 const terms=()=>[200,{...story('stu',{owner_user_id:'u1'}),glossary:'{"秦":"Tần"}',context:''}],loading=page=>/<textarea id="glossary-text"[^>]*readonly/u.test(page.root.innerHTML);
 // detail(): the answer to GET /api/stories/stu. The fake editor is read-only while the drawn one is.
 const open=detail=>{
  let release=null;const save={handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}},text={value:'',get readOnly(){return loading(page);}};
  const page=console_((url,init)=>url==='/api/stories?limit=100'?[200,[story('stu',{owner_user_id:'u1',glossary:null})]]:url==='/api/stories/stu'?init.method==='PATCH'?[200,{ok:true}]:detail():url==='/api/jobs?limit=100'?[200,[job('j1',{status:'uploaded'})]]:url==='/api/jobs/j1/run'?new Promise(done=>{release=()=>done([200,{status:'review'}]);}):url==='/api/jobs/j1/prepare'?[200,{status:'prepared'}]:null,{'#save-glossary':save,'#glossary-text':text});
  // A run of j1, with Thuật ngữ opened on the student's book meanwhile; the function it gives ends the run.
  const run=async()=>{const running=page.run(`runJob('j1')`);await settle();page.run(`state.glossaryId='stu';go('glossary')`);await settle();return async()=>{release();await running;await settle();};};
  return {page,save,text,run,gets:()=>page.calls.filter(call=>call.url==='/api/stories/stu'&&call.method==='GET').length,patched:()=>page.calls.filter(call=>call.method==='PATCH').map(call=>JSON.parse(call.body))};
 };
 // Open and typed in when the run ends: asked for again, nothing drawn over it, and saving sends the typed terms.
 let answer=terms;const typed=open(()=>answer());await settle();
 let end=await typed.run();assert.equal(loading(typed.page),false);assert.match(typed.page.root.innerHTML,/>秦 = Tần<\/textarea>/u);
 typed.text.value='秦 = Tần\n漢 = Hán';const before=typed.gets();
 let writes=0,drawn=typed.page.root.innerHTML;Object.defineProperty(typed.page.root,'innerHTML',{get:()=>drawn,set:value=>{writes++;drawn=value;},configurable:true});
 await end();
 assert.equal(typed.gets(),before+1,'the glossary the refresh dropped is asked for again');assert.equal(writes,0,'nothing is drawn over the typed terms');
 await typed.save.handlers.click({});await settle();
 assert.deepEqual(typed.patched(),[{glossary:{'秦':'Tần','漢':'Hán'}}]);assert.match(typed.page.toast.textContent,/^Đã lưu bảng thuật ngữ\./u);
 // That answer fails: "Lưu bảng thuật ngữ" asks again and says to wait, then saves.
 end=await typed.run();typed.text.value='秦 = Tần\n楚 = Sở';answer=()=>[500,{error:'Máy chủ đang bận.'}];await end();answer=terms;
 await typed.save.handlers.click({});await settle();
 assert.equal(typed.page.toast.textContent,'Bảng thuật ngữ của tài liệu này chưa tải xong. Hãy đợi một chút.');
 await typed.save.handlers.click({});await settle();
 assert.deepEqual(typed.patched().at(-1),{glossary:{'秦':'Tần','楚':'Sở'}});
 // A split that ends ("Chia PDF trước") does the same.
 typed.text.value='秦 = Tần\n魏 = Ngụy';await settle();writes=0;const asked=typed.gets();await typed.page.run(`prepareJob('j1')`);await settle();
 assert.equal(typed.gets(),asked+1);assert.equal(writes,0);
 await typed.save.handlers.click({});await settle();assert.deepEqual(typed.patched().at(-1),{glossary:{'秦':'Tần','魏':'Ngụy'}});
 // Still loading when the run ends: that answer is dropped with the refresh; the one asked for again opens the editor.
 const answers=[],waiting=open(()=>new Promise(done=>answers.push(()=>done(terms()))));await settle();
 end=await waiting.run();assert.equal(loading(waiting.page),true);
 await end();for(const done of answers)done();await settle();
 assert.equal(answers.length,2);assert.equal(loading(waiting.page),false);assert.match(waiting.page.root.innerHTML,/>秦 = Tần<\/textarea>/u);
});

test('A list that does not load right after signing in is said with the welcome; the console opens anyway',async()=>{
 let signedIn=false;const login=fakeForm('admin-login-form',{username:'lan.nguyen',password:'mai-hoa-no-som-tren-doi-7'});
 const page=console_(url=>url==='/api/status'?[200,signedIn?ADMIN:{authenticated:false}]:url==='/api/admin/login'?(signedIn=true,[200,{admin:ADMIN.admin}]):url==='/api/users'?[500,{error:'Máy chủ đang bận.'}]:null,{'#admin-login-form':login},{globals:{FormData:FakeFormData}});
 await settle();
 await login.fire('submit');await settle();
 assert.match(page.root.innerHTML,/class="sidebar"/u);assert.equal(login.box.hidden,true,'not a sign-in error');
 assert.equal(page.toast.textContent,'Đã đăng nhập khu quản trị. Chưa tải được dữ liệu: Máy chủ đang bận.');
});

// POST /api/admin/password (backend/admin-auth.js) answers with a code: the current password's (wrong_password,
// password_required), or a 400 about the new one, also password_unchanged, whose words name the current one.
test('Changing the password: each refusal is said in the form and marks the field it is about',async()=>{
 let answer=null;const form=fakeForm('admin-password-form',{currentPassword:'mai-hoa-no-som-tren-doi-7',newPassword:'mai-hoa-no-som-tren-doi-7',confirm:'mai-hoa-no-som-tren-doi-7'});
 const page=console_(url=>url==='/api/status'?[200,ADMIN]:url==='/api/admin/password'?answer:null,{'#admin-password-form':form},{globals:{FormData:FakeFormData}});
 await settle();page.run(`state.route='settings';render()`);await settle();
 const refused=async reply=>{answer=reply;await form.fire('submit');return [form.box.textContent,form.inputs.filter(input=>input.getAttribute('aria-invalid')==='true').map(input=>input.name)];};
 assert.deepEqual(await refused([400,{error:'Mật khẩu mới cần khác mật khẩu hiện tại.',code:'password_unchanged'}]),['Mật khẩu mới cần khác mật khẩu hiện tại.',['newPassword']]);
 assert.deepEqual(await refused([403,{error:'Mật khẩu hiện tại không đúng.',code:'wrong_password'}]),['Mật khẩu hiện tại không đúng.',['currentPassword']]);
 assert.deepEqual(await refused([400,{error:'Hãy nhập mật khẩu hiện tại.',code:'password_required'}]),['Hãy nhập mật khẩu hiện tại.',['currentPassword']]);
 assert.deepEqual(await refused([400,{error:'Mật khẩu quản trị không được trùng với ADMIN_TOKEN.',code:'password_is_token'}]),['Mật khẩu quản trị không được trùng với ADMIN_TOKEN.',['newPassword']]);
 assert.deepEqual(await refused([409,{error:'Mật khẩu vừa được đổi ở nơi khác. Hãy tải lại trang rồi đăng nhập lại.',code:'password_changed'}]),['Mật khẩu vừa được đổi ở nơi khác. Hãy tải lại trang rồi đăng nhập lại.',[]]);
 assert.ok(!form.box.hidden&&form.box.focused,'shown in the form, focused');
});

// Adding an admin is confirmed with the signed-in admin's own password ("Mật khẩu của bạn", backend/admin-auth.js), whose
// refusals mark that field. Both settings forms end on a note of their own (role="status") that takes the focus: the
// button pressed waits disabled for the answer, and the focus must not fall to the page.
test('"Thêm quản trị viên" sends "Mật khẩu của bạn"; it and "Đổi mật khẩu" end on a focused note in the form',async()=>{
 let answer=null;
 const add=fakeForm('admin-add-form',{username:'co.hoa',name:'Cô Hoa',password:'hoa-sen-trong-dam-lay-3',confirm:'hoa-sen-trong-dam-lay-3',currentPassword:'mai-hoa-no-som-tren-doi-7'}),change=fakeForm('admin-password-form',{currentPassword:'mai-hoa-no-som-tren-doi-7',newPassword:'bien-xanh-cat-trang-nang-vang',confirm:'bien-xanh-cat-trang-nang-vang'});
 const page=console_((url,init)=>url==='/api/status'?[200,ADMIN]:url==='/api/admin/admins'&&init.method==='POST'?answer:url==='/api/admin/admins'?[200,{admins:[]}]:url==='/api/admin/password'?[200,{ok:true,ended:2}]:null,{'#admin-add-form':add,'#admin-password-form':change},{globals:{FormData:FakeFormData}});
 await settle();page.run(`state.route='settings';render()`);await settle();
 const invalid=form=>form.inputs.filter(input=>input.getAttribute('aria-invalid')==='true').map(input=>input.name);
 for(const [reply,field] of [[[403,{error:'Mật khẩu của bạn không đúng.',code:'wrong_password'}],'currentPassword'],[[400,{error:'Hãy nhập mật khẩu của bạn.',code:'password_required'}],'currentPassword'],[[400,{error:'Mật khẩu quản trị cần từ 12 đến 128 ký tự.',code:'password_length'}],'password']]){
  answer=reply;add.box.focused=false;await add.fire('submit');assert.deepEqual([add.box.textContent,add.box.focused,invalid(add)],[reply[1].error,true,[field]]);
 }
 answer=[201,{admin:{id:'a9',username:'co.hoa',name:'Cô Hoa',createdAt:'2026-10-27T08:00:00.000Z',lastLoginAt:null,self:false}}];await add.fire('submit');
 assert.deepEqual(JSON.parse(page.calls.findLast(call=>call.url==='/api/admin/admins'&&call.method==='POST').body),{username:'co.hoa',name:'Cô Hoa',password:'hoa-sen-trong-dam-lay-3',currentPassword:'mai-hoa-no-som-tren-doi-7'});
 assert.deepEqual([add.done.hidden,add.done.focused,add.box.hidden,invalid(add)],[false,true,true,[]]);assert.match(add.done.innerHTML,/<span>Đã thêm quản trị viên co\.hoa\. Hãy gửi riêng tên đăng nhập và mật khẩu cho người đó\.<\/span>$/u);
 await change.fire('submit');
 assert.deepEqual([change.done.hidden,change.done.focused],[false,true]);assert.match(change.done.innerHTML,/<span>Đã đổi mật khẩu\. 2 nơi khác đang đăng nhập tài khoản này đã bị đăng xuất\. Lần sau hãy đăng nhập bằng mật khẩu mới\.<\/span>$/u);
 // The next attempt starts without the last note.
 answer=[409,{error:'Tên đăng nhập này đã có tài khoản quản trị.',code:'username_taken'}];await add.fire('submit');assert.deepEqual([add.done.hidden,add.box.textContent],[true,'Tên đăng nhập này đã có tài khoản quản trị.']);
});
