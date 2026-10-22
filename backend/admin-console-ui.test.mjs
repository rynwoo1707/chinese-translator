import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// The admin console against the paged light lists of backend/admin-lists.js: GET /api/stories, /api/jobs and
// /api/user-library answer pages of rows without text, glossary or warnings (limit, offset, X-Next-Offset); one job's
// text and one book's glossary come from GET /api/jobs/:id and GET /api/stories/:id. app.js runs as in app-ui.test.mjs.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
const story=(id,extra={})=>({id,title:`Sách ${id}`,author:'',genre:'Lịch sử Trung Hoa',cover_key:null,cover_page:null,source_url:null,owner_user_id:null,visibility:'public',created_at:'2026-10-20 08:00:00',glossary:'{}',owner_name:null,owner_email:null,chapters:1,...extra});
const job=(id,extra={})=>({id,story_id:'s1',filename:`${id}.txt`,file_key:null,mime:'text/plain',status:'review',progress:'',error:null,source_key:null,translation_key:null,created_at:'2026-10-20 08:00:00',has_translation:1,warning_count:0,story_title:'Sử ký',genre:'Lịch sử Trung Hoa',...extra});
function console_(server,elements={}){
 const root={innerHTML:''},calls=[],intervals=[],timeouts=[],listeners={},location={pathname:'/admin',hash:'',search:'',origin:'https://hoatri.test'};
 const toast={textContent:'',className:'',setAttribute(){}},modal={open:false,innerHTML:'',close(){this.open=false;},showModal(){this.open=true;},addEventListener(){},removeAttribute(){}};
 const document={title:'',visibilityState:'visible',querySelector:selector=>({'#app':root,'#toast':toast,'#modal':modal,...elements})[selector]||null,querySelectorAll:()=>[],addEventListener(type,fn){(listeners[type]||=[]).push(fn);}};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},inAppBrowser:()=>null,openInBrowserHelp(){},
  location,document,matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},setTimeout:(fn,ms)=>{timeouts.push({fn,ms});const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},FormData,console});
 context.fetch=async(url,init={})=>{
  calls.push({url,method:init.method||'GET',body:init.body});await new Promise(done=>setTimeout(done,1));
  const [status,body,headers={}]=await server(url,init)||(url==='/api/status'?[200,{authenticated:true}]:[200,[]]);
  return {ok:status<300,status,headers:{get:name=>headers[name]??null},json:async()=>body};
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
 const page=console_(async(url,init)=>{const response=await worker.fetch(new Request('https://hoatri.example'+url,{method:init.method||'GET',headers:init.headers,body:init.body}),env,{waitUntil(){}});return [response.status,await response.json(),{'X-Next-Offset':response.headers.get('X-Next-Offset')}];});
 page.run(`token=${JSON.stringify(TOKEN)}`);await page.run('refresh()');
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
});
