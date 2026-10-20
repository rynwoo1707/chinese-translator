import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// app.js runs as in access-upload.test.mjs: imports stripped, the imported names given to the context, a fake fetch.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const SHA='b'.repeat(64);
function app({pathname='/'}={}){
 const root={innerHTML:''},calls=[];
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},releaseBilingual(){},location:{pathname,hash:'',search:''},document:{querySelector:selector=>selector==='#app'?root:selector==='#modal'?{close(){}}:null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout,clearTimeout,clearInterval,FormData,console});
 context.fetch=async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>pathname.startsWith('/admin')?{authenticated:false}:[]};};
 vm.runInContext(source,context);
 return {root,calls,context,run:code=>vm.runInContext(code,context)};
}

test('api(): 204 has no body, a non-JSON page and a JSON error carry the server text, status and code',async()=>{
 const {context,run}=app();let sent;
 context.fetch=async(url,init)=>{sent={url,init};return {status:204,ok:true,json:async()=>{throw new SyntaxError('no body');}};};
 assert.equal(await run(`api('/me',{method:'DELETE',body:{confirm:'XÓA'}})`),null);
 assert.equal(sent.url,'/api/me');assert.equal(sent.init.method,'DELETE');assert.equal(sent.init.headers['Content-Type'],'application/json');assert.equal(sent.init.body,'{"confirm":"XÓA"}');
 context.fetch=async()=>({status:502,ok:false,json:async()=>{throw new SyntaxError('Unexpected token <');}});
 await assert.rejects(run(`api('/library')`),error=>/không đọc được \(mã 502\)/u.test(error.message)&&error.status===502);
 context.fetch=async()=>({status:429,ok:false,json:async()=>({error:'Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.',code:'rate_limited',retryAfter:60})});
 await assert.rejects(run(`api('/auth/login',{method:'POST',body:{}})`),error=>error.message==='Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.'&&error.status===429&&error.code==='rate_limited'&&error.retryAfter===60);
 context.fetch=async()=>({status:500,ok:false,json:async()=>({error:'Máy chủ gặp lỗi ngoài dự kiến… gửi mã abc123 cho quản trị viên.',code:'internal',ray:'abc123'})});
 await assert.rejects(run(`api('/library')`),error=>/abc123/u.test(error.message)&&error.code==='internal');
 context.fetch=async()=>{throw new TypeError('Failed to fetch');};
 await assert.rejects(run(`api('/library')`),error=>/Không kết nối được máy chủ/u.test(error.message)&&error.status===0);
});

test('Sign-in: the Google button waits for a terms box, and the page follows the registration policy',()=>{
 const {run}=app(),view=reader=>run(`state.loaded=true;state.reader=${JSON.stringify(reader)};accountView()`);
 const open=view({authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]}});
 assert.match(open,/data-auth-tab="register"/u);assert.match(open,/<input name="acceptTerms" type="checkbox" required data-terms-check>/u);
 assert.match(open,/<a class="google-login" id="google-login" href="\/api\/auth\/google\/start\?accept_terms=1&amp;return_to=%2F%23account" aria-disabled="true"/u);
 assert.match(open,/id="google-terms-row"><input type="checkbox" data-terms-check>/u);assert.match(open,/href="\/dieu-khoan"[^>]*>Điều khoản sử dụng<\/a> và <a href="\/quyen-rieng-tu"/u);
 assert.match(open,/role="tablist"[\s\S]*role="tab"[^>]*aria-selected="true"[\s\S]*role="tabpanel"/u);
 const closed=view({authenticated:false,googleConfigured:true,registration:{mode:'closed',domains:[]}});
 assert.doesNotMatch(closed,/reader-register-form|data-auth-tab/u);assert.match(closed,/Hoa Trí hiện chưa mở đăng ký tài khoản mới\. Hãy liên hệ quản trị viên\./u);
 assert.match(closed,/id="google-login"/u,'existing Google accounts still sign in');assert.match(closed,/Chỉ tài khoản Google đã đăng ký mới đăng nhập được\./u);
 const domain=view({authenticated:false,googleConfigured:false,registration:{mode:'domain',domains:['truong.edu.vn','<b>x</b>']}});
 assert.doesNotMatch(domain,/reader-register-form|data-auth-tab|google-login/u,'domain mode: only Google sign-in creates accounts');
 assert.match(domain,/email thuộc truong\.edu\.vn hoặc &lt;b&gt;x&lt;\/b&gt;, nhưng máy chủ chưa cấu hình đăng nhập Google\./u);
 // An older server without the registration field behaves as open.
 assert.match(view({authenticated:false,googleConfigured:false}),/reader-register-form/u);
});

test('Signed in: the account page offers deletion with what it removes',()=>{
 const {run}=app();
 const html=run(`state.loaded=true;state.reader={authenticated:true,user:{id:'u',name:'Lan',email:'lan@example.test',provider:'local'}};state.myLibrary=[];state.myRequests=[];accountView()`);
 assert.match(html,/<section class="personal-section account-delete" aria-labelledby="account-delete-title"><h2 id="account-delete-title">Xóa tài khoản<\/h2>/u);
 assert.match(html,/Tài liệu đã công bố trong Thư viện chung vẫn được giữ nhưng không còn gắn với tên bạn\. Không thể hoàn tác\./u);
 assert.match(html,/<button type="button" class="danger" id="delete-account">Xóa tài khoản…<\/button>/u);assert.match(html,/href="\/quyen-rieng-tu#thoi-gian"/u);
});

test('Admin: lock, unlock and delete per account, terms shown; a short server token explains the locked admin page',()=>{
 const {run}=app({pathname:'/admin'});
 const users=run(`state.status={authenticated:true};state.users=[{id:'u1',email:'a@example.test',name:'A',provider:'local',disabled_at:'2026-10-18 10:00:00',terms_version:'2026-10',terms_accepted_at:'2026-10-18 09:00:00'},{id:'u2',email:'b@example.test',name:'',provider:'google',disabled_at:null,terms_version:null,terms_accepted_at:null}];state.userStories=[];state.requests=[];usersView()`);
 assert.match(users,/<span class="user-locked">Đang khóa<\/span>/u);assert.equal((users.match(/class="user-locked"/gu)||[]).length,1);
 assert.match(users,/data-user-lock="u1">Mở khóa<\/button>/u);assert.match(users,/data-user-lock="u2">Khóa tài khoản<\/button>/u);
 assert.equal((users.match(/data-user-delete="u[12]"/gu)||[]).length,2);
 assert.match(users,/Đã đồng ý điều khoản 2026-10 · 2026-10-18/u);assert.match(users,/Chưa ghi nhận đồng ý điều khoản/u);
 assert.match(run(`state.status={authenticated:false,adminTokenTooShort:true};loginView()`),/<p class="warning" role="alert">ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự/u);
 assert.doesNotMatch(run(`state.status={authenticated:false};loginView()`),/ngắn hơn 32 ký tự/u);
 const stories=run(`state.jobs=[];adminStoryCard({id:'s',title:'Mẫu',genre:'Toán học · STEM',source_url:'sample:ham-so',visibility:'private',owner_user_id:null})`);
 assert.match(stories,/<span class="sample-flag">Ví dụ mẫu<\/span><span class="draft-flag">Nháp · chưa công khai<\/span>/u);
 assert.doesNotMatch(run(`adminStoryCard({id:'t',title:'Sách',genre:'Giáo dục',visibility:'public',owner_user_id:null})`),/story-flags/u);
});

test('Library: samples carry the badge, the card note and the intro; the footer is the shared one',()=>{
 const {run}=app();
 const html=run(`state.loaded=true;state.route='library';state.library=[{id:'s',title:'Hàm số',genre:'Toán học · STEM',chapters:2,sample:1,translated_pages:4},{id:'p',title:'Sử ký',genre:'Lịch sử Trung Hoa',chapters:1,sample:0}];publicLayout()`);
 assert.equal((html.match(/class="sample-badge"/gu)||[]).length,1);assert.match(html,/aria-label="Thông tin tài liệu Hàm số · Ví dụ mẫu"/u);assert.match(html,/aria-label="Thông tin tài liệu Sử ký"/u);
 assert.match(html,/4 trang dịch mẫu · giữ bố cục gốc/u);assert.match(html,/class="sample-intro"/u);
 assert.ok(html.includes(`<footer class="site-footer" data-site-footer>${footerHtml()}</footer>`));
});

test('Reader: sample notice, "Đọc song ngữ" only when the original page is known, whole book for page-mapped public books',()=>{
 const {run}=app();
 const chapter={id:'c1',title:'Trang 3–4',mime:'application/pdf',sample:1,source_sha256:SHA,source_pages:[3,4]};
 const assembly={parts:[{id:'c1',mime:'application/pdf',pages:[3,4],sha256:SHA}],storedSources:[{sha256:SHA,pages:9,url:`/api/library/s1/sources/${SHA}`}]};
 const reader=(extra='')=>run(`state.route='reader';state.chapters=[${JSON.stringify(chapter)}];state.chapter=0;state.readerStory={id:'s1',title:'Hàm số',sample:true};state.readerAssembly={storyId:'s1',data:${JSON.stringify(assembly)},done:true};${extra}readerView()`);
 const single=reader('state.bilingual=false;');
 assert.match(single,/<aside class="sample-notice" role="note"><strong>Ví dụ mẫu\.<\/strong>/u);
 assert.match(single,/<button type="button" class="bilingual-toggle" id="bilingual-toggle" aria-pressed="false">/u);
 assert.match(single,new RegExp(`href="/api/library/s1/sources/${SHA}#page=3" target="_blank" rel="noopener">Mở PDF gốc ↗`,'u'));
 assert.match(single,/<iframe class="reader-pdf"/u);assert.match(single,/id="hanzi-open"/u);
 const both=reader('state.bilingual=true;');
 assert.match(both,/<div class="bilingual-root" id="bilingual-root"><\/div>/u);assert.doesNotMatch(both,/<iframe/u);assert.match(both,/aria-pressed="true"/u);
 // No assembly answer yet (or a book without page numbers): the plain PDF, no toggle.
 const pending=run(`state.readerAssembly={storyId:'s1',data:null,done:false};state.bilingual=true;readerView()`);
 assert.doesNotMatch(pending,/bilingual-toggle|bilingual-root/u);assert.match(pending,/<iframe class="reader-pdf"/u);
 // A single-part public book downloads as a whole book only once its parts map original pages.
 assert.equal(run(`state.readerStory={id:'s1'};wholeBookPdf()`),false);assert.equal(run(`state.readerStory={id:'s1',assembly:true};wholeBookPdf()`),true);
 const text=run(`state.chapters=[{id:'t1',title:'Văn bản',mime:'text/plain',content:'Nội dung.'}];state.readerStory={id:'s2'};state.readerAssembly=null;readerView()`);
 assert.doesNotMatch(text,/reader-pdf-tools|sample-notice/u);assert.match(text,/class="prose"/u);
});

test('Admin review: a student-chosen story title is shown as text in every heading, never as markup',()=>{
 const {run}=app({pathname:'/admin'});
 const hostile='<img src=x onerror="window.__xss=1">';
 run(`state.status={authenticated:true};state.jobs=[{id:'j1',story_id:'s1',story_title:${JSON.stringify(hostile)},filename:'<b>tệp</b>.pdf',status:'review',created_at:'2026-10-20',source:'',translation:'',warnings:'[]'}]`);
 const book=run(`state.selected=null;state.reviewStory='s1';reviewView()`);
 const part=run(`state.selected='j1';reviewView()`);
 for(const html of [book,part]){
  assert.doesNotMatch(html,/<img src=x/u,'the title must never become an element');
  assert.match(html,/&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;/u);
 }
 assert.match(part,/&lt;b&gt;tệp&lt;\/b&gt;\.pdf/u,'the file name is escaped exactly once');
 assert.doesNotMatch(part,/&amp;lt;/u,'no double escaping');
});
