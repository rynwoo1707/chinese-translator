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

// app.js runs as in access-upload.test.mjs: imports stripped, the imported names given to the context, a fake fetch.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const SHA='b'.repeat(64);
function app({pathname='/'}={}){
 const root={innerHTML:''},calls=[];
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},releaseBilingual(){},MODES,ADMIN_DEFAULT_MODE,isMode,modeProfile,location:{pathname,hash:'',search:''},document:{querySelector:selector=>selector==='#app'?root:selector==='#modal'?{close(){}}:null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout,clearTimeout,clearInterval,FormData,URL,console});
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
 assert.match(open,/<a class="google-login" id="google-login" href="\/api\/auth\/google\/start\?return_to=%2F%23account" aria-disabled="true"/u,'no consent in the link before a box is ticked');
 assert.match(run(`state.termsAccepted=true;accountView()`),/<a class="google-login" id="google-login" href="\/api\/auth\/google\/start\?accept_terms=1&amp;return_to=%2F%23account" aria-disabled="false"/u);run('state.termsAccepted=false');
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
 assert.match(html,/<section class="personal-section account-delete" aria-labelledby="account-delete-title"><div class="section-head"><h2 id="account-delete-title">Xóa tài khoản<\/h2><\/div><p>Xóa vĩnh viễn tài khoản và mọi dữ liệu riêng\. Không thể hoàn tác\.<\/p>/u);
 assert.match(html,/<button type="button" class="danger" id="delete-account">Xóa tài khoản…<\/button><a class="button quiet" href="\/quyen-rieng-tu#thoi-gian">Dữ liệu nào bị xóa<\/a>/u,'the privacy page says what is deleted, next to the button');
 // What is deleted, and what stays, is said in the dialog that confirms it, before anything is removed.
 const dialog=run('modal=html=>{globalThis.__deleteDialog=html;};deleteAccountDialog();__deleteDialog');
 assert.match(dialog,/<h2>Xóa tài khoản vĩnh viễn\?<\/h2><p class="subtitle">Xóa ngay, không khôi phục được: lịch sử dịch, Thư viện riêng, PDF gốc, bản dịch và yêu cầu dịch\. Tài liệu đã công bố trong Thư viện chung vẫn còn nhưng không ghi tên bạn\.<\/p>/u);
 assert.match(dialog,/Mật khẩu hiện tại<input name="password" type="password"/u);assert.match(dialog,/Nhập XÓA để xác nhận<input name="confirm"/u);
});

test('Admin: lock, unlock and delete per account, terms shown; a short server token is explained where ADMIN_TOKEN is typed',()=>{
 const {run}=app({pathname:'/admin'});
 const users=run(`state.status={authenticated:true};state.users=[{id:'u1',email:'a@example.test',name:'A',provider:'local',disabled_at:'2026-10-18 10:00:00',terms_version:'2026-10',terms_accepted_at:'2026-10-18 09:00:00'},{id:'u2',email:'b@example.test',name:'',provider:'google',disabled_at:null,terms_version:null,terms_accepted_at:null}];state.userStories=[];state.requests=[];usersView()`);
 assert.match(users,/<span class="chip user-locked" data-tone="danger">Đang khóa<\/span>/u);assert.equal((users.match(/class="chip user-locked"/gu)||[]).length,1);
 assert.match(users,/data-user-lock="u1">Mở khóa<\/button>/u);assert.match(users,/data-user-lock="u2">Khóa tài khoản…<\/button>/u);
 assert.equal((users.match(/data-user-delete="u[12]"/gu)||[]).length,2);assert.match(users,/class="danger" data-user-delete="u1">Xóa tài khoản…<\/button><\/div><\/details>/u,'the deletion is the menu\'s last item');
 // The consent record (terms version and day) is in the row's visible line, which touch, the keyboard and screen readers
 // reach; never only in a tooltip.
 assert.match(users,/<li class="user-block"><div class="row user-row">/u);assert.doesNotMatch(users,/<li[^>]* title=/u);
 assert.match(users,/<p class="row-meta">a@example\.test · <span class="nowrap">Điều khoản 2026-10<\/span> · 18\/10\/2026<\/p>/u);assert.match(users,/<p class="row-meta">b@example\.test<\/p>/u);
 assert.match(users,/<span class="chip" data-tone="warn" title="Tài khoản tạo trước khi có điều khoản">Chưa đồng ý điều khoản<\/span>/u);
 assert.equal((users.match(/Chưa đồng ý điều khoản/gu)||[]).length,1,'only the exception is said');assert.match(users,/<span class="chip" title="Tài khoản Google, không có mật khẩu">Google<\/span>/u);
 // A locked account's password reset waits for it to be unlocked (said in its menu, not a button); a Google one has none.
 assert.match(users,/<p class="menu-note">Đặt lại mật khẩu — mở khóa trước<\/p>/u);assert.doesNotMatch(users,/data-user-reset=/u);
 assert.match(users,/<summary class="icon-btn" aria-label="Thao tác cho “A”" title="Thao tác">⋯<\/summary>/u);
 // ADMIN_TOKEN is typed only to create the first admin and to reset a password: the warning about a short server token
 // stands in those two forms; signing in with a username and password does not depend on it.
 assert.match(run(`state.loaded=true;state.status={authenticated:false,adminSetupRequired:true,adminTokenTooShort:true};loginView()`),/<p class="note" data-tone="error" role="alert">ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự nên chưa dùng được\. Đặt lại bằng <code>npx wrangler secret put ADMIN_TOKEN<\/code> \(64 ký tự hex\) rồi tải lại trang\.<\/p><form id="admin-setup-form"/u);
 assert.match(run(`state.status={authenticated:false,adminTokenTooShort:true};state.adminAuth='recover';loginView()`),/<p class="note" data-tone="error" role="alert">ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự[^<]*<code>[^<]*<\/code>[^<]*<\/p><form id="admin-recover-form"/u);
 assert.doesNotMatch(run(`state.adminAuth='login';loginView()`),/ngắn hơn 32 ký tự/u,'not on the sign-in form');
 assert.doesNotMatch(run(`state.status={authenticated:false,adminSetupRequired:true};loginView()`),/ngắn hơn 32 ký tự/u);
 const stories=run(`state.jobs=[];adminStoryCard({id:'s',title:'Mẫu',genre:'Toán học · STEM',source_url:'sample:ham-so',visibility:'private',owner_user_id:null})`);
 assert.match(stories,/<span class="chip sample-flag">Ví dụ mẫu<\/span><span class="chip draft-flag" title="Chưa công khai trong Thư viện">Nháp<\/span>/u);
 assert.match(stories,/<p class="story-counts">Chưa công bố<\/p>/u);assert.doesNotMatch(stories,/Chưa cập nhật|Chưa có ảnh bìa/u,'no empty author, no cover caption');
 assert.doesNotMatch(run(`adminStoryCard({id:'t',title:'Sách',genre:'Giáo dục',visibility:'public',owner_user_id:null})`),/story-flags/u);
});

test('Library: samples carry the badge, the card note and the intro; the footer is the shared one',()=>{
 const {run}=app();
 const html=run(`state.loaded=true;state.route='library';state.library=[{id:'s',title:'Hàm số',genre:'Toán học · STEM',chapters:2,sample:1,translated_pages:4},{id:'p',title:'Sử ký',genre:'Lịch sử Trung Hoa',chapters:1,sample:0}];publicLayout()`);
 assert.equal((html.match(/class="sample-badge"/gu)||[]).length,1);assert.match(html,/aria-label="Mở tài liệu Hàm số · Ví dụ mẫu"/u);assert.match(html,/aria-label="Mở tài liệu Sử ký"/u);
 assert.match(html,/<p class="sample-card-note">AI dịch · chưa qua giáo viên duyệt<\/p>/u);assert.doesNotMatch(html,/trang dịch mẫu|Tác giả \/ chủ biên|Chưa có ảnh bìa/u);assert.doesNotMatch(html,/sample-intro|Mới dùng Hoa Trí/u,'no sample hint above the library');
 assert.ok(html.includes(`<footer class="site-footer" data-site-footer>${footerHtml()}</footer>`));
});

test('Reader: sample notice, "Đọc song ngữ" only when the original page is known, whole book for page-mapped public books',()=>{
 const {run}=app();
 const chapter={id:'c1',title:'Trang 3–4',mime:'application/pdf',sample:1,source_sha256:SHA,source_pages:[3,4]};
 const assembly={parts:[{id:'c1',mime:'application/pdf',pages:[3,4],sha256:SHA}],storedSources:[{sha256:SHA,pages:9,url:`/api/library/s1/sources/${SHA}`}]};
 const reader=(extra='')=>run(`state.route='reader';state.chapters=[${JSON.stringify(chapter)}];state.chapter=0;state.readerStory={id:'s1',title:'Hàm số',sample:true};state.readerAssembly={storyId:'s1',data:${JSON.stringify(assembly)},done:true};${extra}readerView()`);
 const single=reader('state.bilingual=false;');
 assert.match(single,/<aside class="note sample-notice" role="note"><strong>Ví dụ mẫu\.<\/strong>/u);
 assert.match(single,/<div class="segmented reading-mode" role="group" aria-label="Cách đọc"><button type="button" id="translation-only" aria-pressed="true">Bản dịch<\/button><button type="button" class="bilingual-toggle" id="bilingual-toggle" aria-pressed="false">Song ngữ<\/button><\/div>/u);
 // A plain menu item (no class of the old inline link, whose night colour is meant for the dark page, not the light menu).
 assert.match(single,new RegExp(`<div class="menu-list">[\\s\\S]*?<a href="/api/library/s1/sources/${SHA}#page=3" target="_blank" rel="noopener">PDF gốc ↗</a></div></details>`,'u'),'the original page is the last item of "Tải về"');
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
 // Nghe turns into Dừng while the part is read aloud: the name says what a press does, with no aria-pressed (which would be
 // heard as "Dừng, pressed").
 assert.match(text,/<button type="button" class="reader-listen" id="speak" title="Nghe đọc tiếng Việt">[\s\S]*?<span>Nghe<\/span><\/button>/u);
 const speaking=run(`state.speaking=true;readerView()`);run('state.speaking=false');
 assert.match(speaking,/<button type="button" class="reader-listen is-speaking" id="speak" title="Dừng đọc">[\s\S]*?<span>Dừng<\/span><\/button>/u);
 assert.doesNotMatch(text+speaking,/id="speak"[^>]*aria-pressed/u);
});

// A request's link and a part's source come from stored data: only a web address (http or https with a host) is drawn as
// a link, by its normalized address; anything else (javascript:, data:, a bare word, "https://") is plain text.
test('Stored links: only an http(s) address with a host becomes a link, in the admin requests and in the reader',()=>{
 const admin=app({pathname:'/admin'}).run,request=(id,source_url)=>({id,title:`Yêu cầu ${id}`,notes:'',status:'pending',visibility:'private',reader_name:'Lan',source_url});
 const links=['https://example.com/sách?a=1','HTTP://Example.COM/x'],texts=['javascript:alert(document.cookie)','JavaScript:alert(1)','data:text/html,<script>alert(1)</script>','vbscript:x','//example.com/x','https://','ftp://example.com/a','  javascript:alert(1)'];
 const html=admin(`state.status={authenticated:true};state.requests=${JSON.stringify([...links,...texts].map((url,i)=>request(`r${i}`,url)))};requestsView()`);
 const hrefs=[...html.matchAll(/<a href="([^"]*)"/gu)].map(match=>match[1]);
 assert.deepEqual(hrefs,['https://example.com/s%C3%A1ch?a=1','http://example.com/x'],'only the two web addresses, normalized');
 for(const text of texts)assert.ok(html.includes(`<span class="source-text">Nguồn: ${text.trim().replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')}</span>`),text);
 assert.doesNotMatch(html,/href="(?:javascript|data|vbscript):/iu);
 const reader=app().run,part=source_url=>reader(`state.route='reader';state.chapters=[{id:'c1',title:'Phần 1',mime:'text/plain',content:'Nội dung.',source_url:${JSON.stringify(source_url)}}];state.chapter=0;state.readerStory={id:'s1',title:'Sách'};state.readerAssembly=null;readerView()`);
 assert.match(part('https://ctext.org/analects'),/<p class="chapter-source"><a href="https:\/\/ctext\.org\/analects" target="_blank" rel="noopener noreferrer">Nguyên tác ↗<\/a><\/p>/u);
 assert.match(part('javascript:alert(1)'),/<p class="chapter-source"><span class="source-text">Nguồn: javascript:alert\(1\)<\/span><\/p>/u);
 assert.match(part('Sách giáo khoa Toán 10'),/<p class="chapter-source"><span class="source-text">Nguồn: Sách giáo khoa Toán 10<\/span><\/p>/u);
 assert.doesNotMatch(part(null),/chapter-source/u);
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

// The admin console signs in with a username and a password (backend/admin-auth.js). ADMIN_TOKEN is typed only to create
// the first account and to reset a forgotten password, in a field a password manager neither fills nor saves.
test('Admin sign-in page: no form while the session is checked, then sign-in, first-run setup or recovery, each with its own fields',()=>{
 const {run,root}=app({pathname:'/admin'});
 // Before /api/status answers: the heading and a status line, nothing to type into (a signed-in reload shows no form).
 assert.match(root.innerHTML,/<h1 id="admin-auth-title">Đăng nhập quản trị<\/h1><p class="status" role="status">Đang kiểm tra phiên đăng nhập…<\/p>/u);assert.doesNotMatch(root.innerHTML,/eyebrow|KHU VỰC QUẢN TRỊ/u);
 assert.doesNotMatch(root.innerHTML,/<form|<input/u);
 const login=run(`state.loaded=true;state.status={authenticated:false};loginView()`);
 assert.match(login,/<form id="admin-login-form" class="auth-form"><p class="form-error" id="admin-login-error" role="alert" tabindex="-1" hidden><\/p><label>Tên đăng nhập<input name="username" autocomplete="username" required maxlength="64" autocapitalize="none" spellcheck="false"><\/label><label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required maxlength="128"><\/label><button class="primary" type="submit">Đăng nhập<\/button><\/form>/u);
 assert.match(login,/<button type="button" class="link-button quiet" id="admin-forgot">Quên mật khẩu\?<\/button>/u);assert.match(login,/<h1 id="admin-auth-title">Đăng nhập quản trị<\/h1><form id="admin-login-form"/u,'no subtitle');
 assert.doesNotMatch(login,/ADMIN_TOKEN|name="token"|Mã quản trị/u,'no token on the sign-in form');
 const setup=run(`state.status={authenticated:false,adminSetupRequired:true};loginView()`);
 assert.match(setup,/<h1 id="admin-auth-title">Tạo tài khoản quản trị đầu tiên<\/h1>/u);
 assert.match(setup,/chỉ cần nhập một lần[\s\S]*dòng ADMIN_TOKEN trong tệp \.dev\.vars/u,'typed once; where it is on this machine');
 assert.match(setup,/<details class="more"><summary>ADMIN_TOKEN ở đâu\?<\/summary>/u,'where it is, folded');
 for(const field of ['<label>Mã ADMIN_TOKEN<input name="token" type="password" autocomplete="off" required','<label>Tên đăng nhập<input name="username" autocomplete="username" required minlength="3" maxlength="64"','<label>Tên hiển thị (không bắt buộc)<input name="name" autocomplete="name" maxlength="100">','<label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"','<label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128">','<button class="primary" type="submit">Tạo tài khoản và đăng nhập</button>'])assert.ok(setup.includes(field),field);
 assert.doesNotMatch(setup,/admin-login-form|current-password|admin-forgot/u,'no sign-in while there is no admin');
 const recover=run(`state.status={authenticated:false};state.adminAuth='recover';loginView()`);
 assert.match(recover,/<h1 id="admin-auth-title">Đặt lại mật khẩu quản trị<\/h1>/u);
 for(const field of ['<form id="admin-recover-form" class="auth-form">','name="token" type="password" autocomplete="off"','<label>Tên đăng nhập<input name="username" autocomplete="username"','<label>Mật khẩu mới<input name="password" type="password" autocomplete="new-password"','<label>Nhập lại mật khẩu mới<input name="confirm" type="password" autocomplete="new-password"','id="admin-back-login">← Quay lại đăng nhập</button>'])assert.ok(recover.includes(field),field);
 // A session that ended: its note comes first, then the form.
 assert.match(run(`state.adminAuth='login';state.adminNotice='Phiên quản trị đã kết thúc.';loginView()`),/<p class="auth-note admin-auth-notice" role="status" tabindex="-1" data-focus-first>Phiên quản trị đã kết thúc\.<\/p><form id="admin-login-form"/u);
 // A public page holds none of it.
 assert.doesNotMatch(app().root.innerHTML,/admin-(?:login|setup|recover)-form|ADMIN_TOKEN|name="token"/u);
});

test('Admin "Cách dịch": the upload form offers every mode with its cost, the server default chosen; job rows, the AI log and a job\'s page name it',()=>{
 const {run}=app({pathname:'/admin'});
 run(`state.loaded=true;state.status={authenticated:true,translationMode:'balanced'};state.jobs=[];state.stories=[];state.requests=[]`);
 const form=run('translateView()'),options=[...form.matchAll(/<option value="([a-z]+)"( selected)?>([^<]+)<\/option>/gu)].filter(match=>isMode(match[1]));
 assert.deepEqual(options.map(match=>[match[1],match[3],Boolean(match[2])]),MODES.map(id=>[id,modeProfile(id).label,id==='balanced']),'labels from translation-modes.js, the server default chosen');
 assert.match(form,/<label>Cách dịch<select id="job-mode" aria-describedby="job-mode-hint">/u);
 const hint=id=>{const {hint:text,estimate}=modeProfile(id);return estimate>1?`${text} Ước tính tốn khoảng gấp ${estimate.toLocaleString('vi-VN')} lần token so với Tiết kiệm.`:text;};
 const brief=id=>modeProfile(id).brief||hint(id);
 assert.ok(form.includes(`<p class="mode-hint" id="job-mode-hint" aria-live="polite">${brief('balanced')}</p>`));
 assert.match(form,/<details class="more"><summary>So sánh các Cách dịch<\/summary>/u);for(const id of MODES)assert.ok(form.includes(`<strong>${modeProfile(id).label.split(' (')[0]}:</strong>`),id);
 // No default from the server: Kỹ nhất (ADMIN_DEFAULT_MODE). A choice made in this tab stays across redraws.
 const premium=run(`state.status={authenticated:true};translateView()`);
 assert.match(premium,new RegExp(`<option value="${ADMIN_DEFAULT_MODE}" selected>`,'u'));assert.ok(premium.includes(`aria-live="polite">${brief('premium')}</p>`));assert.match(premium,/token/u,'what it costs is said');
 const economy=run(`state.jobMode='economy';translateView()`);
 assert.match(economy,/<option value="economy" selected>/u);assert.ok(economy.includes(`aria-live="polite">${modeProfile('economy').brief||modeProfile('economy').hint}</p>`),'Tiết kiệm itself: no estimate');
 // Job rows: the file, the book, the state and the day, the row opens the job; a running one says how far it is, without
 // the mode (the job's page has the select). The AI log folds model, prompt, tokens in, out and thinking, calls.
 const rows=run(`jobRows([{id:'j1',filename:'a.txt',story_title:'S',status:'uploaded',created_at:'2026-10-26 08:00:00',mode:'premium'},{id:'j2',filename:'b.txt',story_title:'S',status:'translating',created_at:'2026-10-26 08:00:00',mode:null,progress:'Đang dịch khối 2/5 · Cách dịch: Kỹ nhất'},{id:'j3',filename:'c.txt',story_title:'S',status:'review',created_at:'2026-10-26 08:00:00',mode:'quality',progress:'Đã dịch 2 phần · Cách dịch: Kỹ hơn'}],{book:true})`);
 assert.match(rows,/<li class="row"><button type="button" class="row-main" data-job="j1" aria-label="Mở a\.txt"><span class="row-title">a\.txt<\/span><span class="row-meta">S<\/span><\/button><span class="row-side"><span class="chip">Chờ dịch<\/span><span class="row-day"><span title="26\/10\/2026">26\/10<\/span><\/span><\/span><\/li>/u);
 assert.match(rows,/<span class="row-meta">S · Đang dịch khối 2\/5<\/span>/u);assert.match(rows,/<span class="chip" data-tone="warn">Chờ duyệt<\/span>/u);assert.doesNotMatch(rows,/Cách dịch|job-mode|data-delete-job/u,'no mode, no delete in a row');
 const audit=run(`jobAudit({mode:'quality',model:'gemini-3.6-flash',prompt_version:'v9',total_tokens:1500,prompt_tokens:900,output_tokens:400,thinking_tokens:200,ai_requests:3})`);
 assert.match(audit,/^<details class="more job-audit"><summary>Nhật ký AI<\/summary><div class="more-body"><p>gemini-3\.6-flash · Prompt v9<\/p>/u);assert.match(audit,/1\.500 token · 900 vào \+ 400 ra \+ 200 suy luận · 3 lượt gọi/u);
 assert.doesNotMatch(run(`jobAudit({model:'m',total_tokens:10,prompt_tokens:6,output_tokens:4,ai_requests:1})`),/suy luận|Cách dịch/u,'an older job: neither');
 // A job's page: the mode beside "Bắt đầu dịch", the job's own chosen. Its list row is a light one (backend/admin-lists.js,
 // which may not carry the mode); the job's detail (GET /api/jobs/:id) does. None once published.
 run(`state.jobs=[{id:'j1',story_id:'s1',story_title:'S',filename:'a.txt',status:'uploaded',created_at:'2026-10-26',has_translation:0,warning_count:0}];state.selected='j1';state.jobDetails={j1:{data:{id:'j1',status:'uploaded',mode:'quality',source:'原文',translation:'',warnings:'[]'}}}`);
 assert.match(run('reviewView()'),/<label class="run-mode">Cách dịch<select id="run-mode" ><option value="economy">Tiết kiệm<\/option><option value="balanced">Cân bằng<\/option><option value="quality" selected>Kỹ hơn<\/option><option value="premium">Kỹ nhất<\/option><\/select><\/label><button type="button" class="primary" id="rerun" >Bắt đầu dịch<\/button>/u);
 assert.match(run(`state.jobs[0].mode='economy';reviewView()`),/<option value="economy" selected>Tiết kiệm<\/option>/u,'a row that carries the mode (a run\'s answer) is the newer');
 assert.match(run(`delete state.jobs[0].mode;state.jobDetails={};reviewView()`),new RegExp(`<option value="${ADMIN_DEFAULT_MODE}" selected>`,'u'),'unknown yet (its detail loads), or a job without one: the default it runs with');
 assert.match(run(`state.jobDetails={j1:{data:{id:'j1',mode:'quality',source:'',translation:'',warnings:'[]'}}};state.runMode={job:'j1',mode:'premium'};reviewView()`),/<option value="premium" selected>Kỹ nhất<\/option>/u,'a pick made on the page wins and survives a redraw');
 const published=run(`state.jobs[0].status='published';reviewView()`);
 assert.doesNotMatch(published,/run-mode|id="rerun"|id="save-job"|id="publish-job"/u,'a published part: nothing to run, save or publish');
 // A part waiting for review leads with "Duyệt & công bố"; "Dịch lại…" asks first, from ⋯, with the mode, and is #rerun once.
 const review=run(`state.jobs[0].status='review';state.runMode=null;state.jobDetails={j1:{data:{id:'j1',status:'review',mode:'quality',source:'原文',translation:'Bản dịch',warnings:'[]'}}};reviewView()`);
 assert.match(review,/<button type="button" class="primary" id="publish-job" >Duyệt & công bố<\/button><button type="button" id="save-job" >Lưu<\/button>/u);assert.doesNotMatch(review,/id="rerun"|run-mode/u);assert.match(review,/<button type="button" id="rerun-dialog">Dịch lại…<\/button>/u);
 // The dialog's own controls never take the page's ids (#rerun, #run-mode), which render() binds again (A1). While a run goes
 // on in this tab, Dịch lại… waits in one line as Xóa tài liệu… does, and no dialog opens to start a second paid run (A2).
 run(`modal=(html,submit,label,options)=>{globalThis.__dialog={html,label,confirmId:options?.confirmId};};globalThis.__dialog=null`);
 const dialog=run(`rerunDialog();__dialog`);
 assert.equal(dialog.label,'Dịch lại');assert.equal(dialog.confirmId,'rerun-confirm');assert.match(dialog.html,/<select id="rerun-mode" name="mode">/u);assert.doesNotMatch(dialog.html,/id="(?:rerun|run-mode)"/u);
 const waiting=run(`busy=true;reviewView()`);
 assert.match(waiting,/<p class="menu-note">Dịch lại — đợi lượt dịch xong<\/p>/u);assert.doesNotMatch(waiting,/id="rerun-dialog"/u);
 assert.equal(run(`globalThis.__dialog=null;rerunDialog();busy=false;__dialog`),null,'no dialog while a run goes on');
 // A failed part says why in one alert, which holds "Tiếp tục xử lý" and its mode; the heading has no second #rerun.
 const failed=run(`state.jobs[0].status='failed';state.jobs[0].progress='Dừng ở khối 2/5: Gemini hết hạn mức (429).';state.jobs[0].has_translation=1;state.jobDetails={j1:{data:{id:'j1',status:'failed',mode:'quality',source:'原文',translation:'Một phần',warnings:'[]'}}};reviewView()`);
 assert.match(failed,/<div class="note job-alert" data-tone="error" role="alert"><p>Dừng ở khối 2\/5: Gemini hết hạn mức \(429\)\. Phần đã dịch được giữ\.<\/p><div class="note-actions"><label class="run-mode">Cách dịch<select id="run-mode" >[\s\S]*?<\/select><\/label><button type="button" class="primary" id="rerun" >Tiếp tục xử lý<\/button><\/div><\/div>/u);
 assert.equal((failed.match(/id="rerun"/gu)||[]).length,1,'#rerun once');assert.equal((failed.match(/id="run-mode"/gu)||[]).length,1);
 // The day's quota (backend/ai.js) says already that the work is saved: it is said once, with the admin's ways on (the
 // reset time, or Billing for the server's key).
 const quota=run(`state.jobs[0].progress='Đã dịch 2/5 khối.';state.jobs[0].error='Khóa Gemini đã hết lượt hôm nay (đặt lại lúc 15:00). Phần đã dịch đã được lưu.';reviewView()`);
 assert.match(quota,/<p>Đã dịch 2\/5 khối\. Khóa Gemini đã hết lượt hôm nay \(đặt lại lúc 15:00\)\. Phần đã dịch đã được lưu\. Chờ tới giờ đặt lại hoặc bật Billing trong Google AI Studio, rồi bấm Tiếp tục xử lý\.<\/p>/u);
 assert.doesNotMatch(quota,/được giữ/u,'not said twice');
 const slow=run(`state.jobs[0].progress='';state.jobs[0].error='Gemini không phản hồi (mã 504). Tiến độ đã được giữ; hãy thử lại sau ít phút.';reviewView()`);
 assert.match(slow,/<p>Gemini không phản hồi \(mã 504\)\. Tiến độ đã được giữ; hãy thử lại sau ít phút\.<\/p>/u,'kept, said once; no quota advice');
});

test('Admin settings: who is signed in, "Đổi mật khẩu", "Đăng xuất", and the admins, with "Xóa" beside the others only',()=>{
 const {run,root}=app({pathname:'/admin'});
 run(`state.loaded=true;state.status={authenticated:true,admin:{username:'lan.nguyen',name:'Nguyễn Thị Lan'},via:'session',translationMode:'premium',model:'gemini-3.6-flash'};state.admins={rows:[{id:'a1',username:'lan.nguyen',name:'Nguyễn Thị Lan',createdAt:'2026-10-01T08:00:00.000Z',lastLoginAt:'2026-10-26T07:00:00.000Z',self:true},{id:'a2',username:'minh',name:'',createdAt:'2026-10-02T08:00:00.000Z',lastLoginAt:null,self:false}],error:null}`);
 const html=run('settingsView()');
 assert.doesNotMatch(html,/bộ nhớ của tab|Mã quản trị/u,'the token kept in the tab is gone');
 assert.match(html,/<h2 id="admin-account-title">Nguyễn Thị Lan<\/h2><p class="settings-meta">lan\.nguyen · phiên tự kết thúc sau 2 giờ không dùng \(tối đa 12 giờ\)\. Máy dùng chung: nhớ Đăng xuất\.<\/p>/u);
 assert.match(html,/<button type="button" id="admin-password-toggle" aria-expanded="false" aria-controls="admin-password-form">Đổi mật khẩu<\/button>/u);assert.match(html,/<button type="button" id="admin-add-toggle" aria-expanded="false" aria-controls="admin-add-form">Thêm quản trị viên<\/button>/u);
 assert.match(html,/<form id="admin-password-form" class="auth-form admin-password"[^>]*><h3 id="admin-password-title">Đổi mật khẩu<\/h3><p class="form-error" id="admin-password-error"/u);
 assert.match(html,/<input type="text" autocomplete="username" value="lan\.nguyen" hidden><label>Mật khẩu<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"><\/label><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" required minlength="12"/u);
 assert.match(html,/<button type="button" class="quiet" id="logout">Đăng xuất<\/button>/u);assert.match(html,/<p class="settings-meta">gemini-3\.6-flash · Cách dịch mặc định: Kỹ nhất<\/p>/u);
 assert.match(html,/<li class="row" title="Tạo ngày 01\/10\/2026">[\s\S]*?<strong class="row-title">Nguyễn Thị Lan<\/strong><span class="chip admin-self">Bạn<\/span><small class="row-meta">lan\.nguyen · đăng nhập 26\/10\/2026<\/small><\/div><\/li>/u);
 assert.match(html,/<li class="row" title="Tạo ngày 02\/10\/2026">[\s\S]*?<strong class="row-title">minh<\/strong><small class="row-meta">minh · chưa đăng nhập<\/small><\/div><button type="button" class="danger" data-admin-delete="a2" aria-label="Xóa quản trị viên minh">Xóa…<\/button>/u);
 assert.equal((html.match(/data-admin-delete=/gu)||[]).length,1,'no "Xóa" beside yourself');
 assert.match(html,/<form id="admin-add-form" class="auth-form admin-add"[^>]*><h3 id="admin-add-title">Thêm quản trị viên<\/h3>/u);
 assert.match(html,/<label>Tên đăng nhập<input name="username" autocomplete="off" required minlength="3" maxlength="64"/u);
 // Adding is confirmed with your own password; the form holds no username of yours, so a password manager does not take
 // the new admin's password for a new one of yours.
 const addForm=/<form id="admin-add-form"[\s\S]*?<\/form>/u.exec(html)[0];
 assert.match(addForm,/<label>Mật khẩu của bạn<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128" aria-describedby="admin-add-own-note"><small class="field-hint" id="admin-add-own-note">Để xác nhận\.<\/small><\/label><button class="primary" type="submit">Thêm quản trị viên<\/button><\/form>$/u);
 assert.doesNotMatch(addForm,/autocomplete="username"/u);
 // Each form says it was done in a note of its own (it takes the focus then), hidden until then.
 for(const id of ['admin-password-done','admin-add-done'])assert.ok(html.includes(`<p class="account-notice form-done" id="${id}" role="status" tabindex="-1" style="margin:0" hidden></p>`),id);
 // The session: a session cookie, 12 hours, 2 hours unused.
 assert.match(html,/<form id="admin-password-form" class="auth-form admin-password" aria-labelledby="admin-password-title" hidden>/u,'the form opens from its button');
 // Loading and a failed load of the list.
 assert.match(run(`state.admins={rows:null,error:null};adminList()`),/<p class="status" role="status">Đang tải…<\/p>/u);
 assert.match(run(`state.admins={rows:null,error:{message:'Máy chủ đang bận.'}};adminList()`),/Chưa tải được danh sách quản trị viên: Máy chủ đang bận\. <button type="button" id="admins-retry">Thử lại<\/button>/u);
 // The sidebar names who is signed in.
 run(`state.route='stories';render()`);
 assert.match(root.innerHTML,/<span class="avatar" aria-hidden="true">NL<\/span><div><span class="profile-name">Nguyễn Thị Lan<\/span><small>lan\.nguyen<\/small><\/div>/u);
 assert.doesNotMatch(root.innerHTML,/QUẢN TRỊ VIÊN|TRUNG VĂN|class="topbar"|class="footer"|class="engine"/u,'no label, tagline, breadcrumb, footer or engine card');
 assert.match(root.innerHTML,/<a class="side-library" href="\/" target="_blank" rel="noopener">Mở thư viện ↗<\/a>/u);
});
