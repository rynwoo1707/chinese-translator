import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// Account, sign-in, password reset (contract 7), admin reset links and the request dialog of app.js, run as in
// library-home.test.mjs (imports stripped and given, a fake fetch answering per URL), with fake elements that keep
// attributes, a fake history and a fake sessionStorage. Nothing here reaches a server.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
const TOKEN='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde',FRESH='Fr'+'e'.repeat(41);
// A link is first checked without being used up (POST /api/auth/password-reset/check), then, on "Tiếp tục", traded for
// a fresh token (POST /api/auth/password-reset/open).
const opens=url=>url==='/api/auth/password-reset/check'?[200,{ok:true,expiresAt:'2026-10-22T08:30:00.000Z'}]:url==='/api/auth/password-reset/open'?[200,{token:FRESH}]:null;
const ME_OUT={authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]}};
const ME_IN={authenticated:true,googleConfigured:true,registration:{mode:'open',domains:[]},user:{id:'u1',name:'Nguyễn Thị Phương Thảo',email:'thao@example.test',picture:'http://insecure.example/a.png',provider:'local'}};
// One handler per event type, as on an element the page has just drawn (each render draws new ones).
class Element{
 constructor(props={}){this.attributes=new Map();this.handlers={};this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.style={};this.className='';Object.assign(this,props);}
 setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}
 removeAttribute(name){this.attributes.delete(name);}hasAttribute(name){return this.attributes.has(name);}
 addEventListener(type,fn){this.handlers[type]=fn;}fire(type,event={}){return this.handlers[type]?.({preventDefault(){},currentTarget:this,target:this,...event});}
 focus(){this.focused=true;}select(){this.selected=true;}
}
// A form as the page draws it: its error box, its named inputs and its submit button; `values` feed FakeFormData.
function form(id,names,values={},described={}){
 const box=new Element({id:`${id.replace(/-form$/u,'')}-error`,hidden:true}),button=new Element(),inputs=names.map(name=>{const input=new Element({name});if(described[name])input.setAttribute('aria-describedby',described[name]);return input;});
 return Object.assign(new Element({id,values}),{box,button,inputs,input:name=>inputs.find(input=>input.name===name),querySelector:selector=>selector==='.form-error'?box:selector==='[type="submit"]'?button:null,querySelectorAll:selector=>selector==='input[name]'?inputs:[]});
}
class FakeFormData{constructor(form){this.list=Object.entries(form?.values||{});}get(name){return this.list.find(([key])=>key===name)?.[1]??null;}*[Symbol.iterator](){yield* this.list;}}
function app({pathname='/',hash='',answers=()=>null,elements={},lists={},stored={}}={}){
 const root={innerHTML:''},calls=[],location={pathname,hash,search:'',origin:'https://hoatri.test'};
 const history={pushState(state,title,url){apply(url);},replaceState(state,title,url){apply(url);}};
 function apply(url){const parsed=new URL(url,'https://hoatri.test');location.pathname=parsed.pathname;location.search=parsed.search;location.hash=parsed.hash;}
 const toast=new Element(),modal=new Element({open:false,showModal(){this.open=true;},close(){this.open=false;}}),modalForm=new Element(),modalError=new Element();
 const known={'#app':root,'#toast':toast,'#modal':modal,'#modal-form':modalForm,'#modal-error':modalError,'#close-modal':new Element(),...elements};
 const session=new Map(Object.entries(stored)),sessionStorage={getItem:key=>session.has(key)?session.get(key):null,setItem:(key,value)=>session.set(key,String(value)),removeItem:key=>session.delete(key)};
 const clipboard={text:'',async writeText(text){this.text=text;}};
 const document={title:'',querySelector:selector=>known[selector]||null,querySelectorAll:selector=>lists[selector]||[]};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},
  location,history,document,sessionStorage,navigator:{clipboard},matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,clearInterval,FormData:FakeFormData,URL,console});
 context.fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET',body:init.body});await new Promise(done=>setTimeout(done,1));const [status,body]=answers(url,init)||[200,url==='/api/me'?ME_OUT:url==='/api/status'?{authenticated:true}:[]];return {ok:status<300,status,json:async()=>body};};
 vm.runInContext(source,context);
 return {root,calls,location,toast,modal,modalForm,modalError,session,clipboard,run:code=>vm.runInContext(code,context)};
}

test('A reset link: the token leaves the address at once, is only checked on load, and is traded for a fresh one on "Tiếp tục"; then the form',async()=>{
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,answers:opens});
 assert.equal(page.location.hash,'#dat-lai-mat-khau','the address keeps no token');assert.equal(page.run('state.route'),'dat-lai-mat-khau');
 assert.doesNotMatch(page.root.innerHTML,/password-reset-form/u,'no form before the link is opened (nothing typed is lost to a later render)');
 await settle();
 // A chat app or a mail scanner that opens the link runs this page too: nothing is used up until the student acts.
 const checked=page.calls.find(call=>call.url==='/api/auth/password-reset/check');
 assert.equal(checked.method,'POST');assert.deepEqual(JSON.parse(checked.body),{token:TOKEN});
 assert.ok(!page.calls.some(call=>call.url==='/api/auth/password-reset/open'),'not traded on load');
 assert.match(page.root.innerHTML,/<h1 id="reset-title">Đặt lại mật khẩu<\/h1><div class="reset-ready"><p>Liên kết dùng được đến [^<]*2026\. Sau khi bấm Tiếp tục, liên kết không mở lại được\.<\/p><button type="button" class="primary" id="reset-continue">Tiếp tục<\/button><\/div>/u);
 assert.doesNotMatch(page.root.innerHTML,/password-reset-form/u);assert.doesNotMatch(page.root.innerHTML,new RegExp(TOKEN,'u'));
 await page.run('openResetLink()');
 const opened=page.calls.find(call=>call.url==='/api/auth/password-reset/open');
 assert.equal(opened.method,'POST');assert.deepEqual(JSON.parse(opened.body),{token:TOKEN});assert.equal(page.run('state.resetToken'),FRESH);
 assert.equal(page.run('state.resetLink'),null,'the checked token is dropped once traded');
 const html=page.root.innerHTML;
 assert.equal(page.run('document.title'),'Đặt lại mật khẩu — Hoa Trí');
 assert.match(html,/<form id="password-reset-form" class="auth-form" aria-labelledby="reset-title">/u);assert.match(html,/<p class="field-hint">Lưu xong bạn được đăng nhập; các thiết bị khác bị đăng xuất\.<\/p><\/form>/u);
 assert.match(html,/<label>Mật khẩu mới<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-reset-rule"><small class="field-hint" id="password-reset-rule">8–128 ký tự; tránh mật khẩu dễ đoán \(12345678, ngày sinh, email\)\.<\/small><\/label>/u);
 assert.match(html,/<label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"><\/label>/u);
 assert.match(html,/<p class="form-error" id="password-reset-error" role="alert" tabindex="-1" hidden><\/p>/u);
 assert.doesNotMatch(html,new RegExp(`${TOKEN}|${FRESH}`,'u'),'the tokens are never written into the page');
 // Reloaded (or typed) without a token: how to get a working link, no form.
 const reloaded=app({hash:'#dat-lai-mat-khau'});await settle();
 assert.doesNotMatch(reloaded.root.innerHTML,/password-reset-form/u);
 assert.match(reloaded.root.innerHTML,/<h1 id="reset-title">Đặt lại mật khẩu<\/h1><div class="reset-unavailable"><p>Liên kết đã dùng, hết hạn, hoặc mất khi tải lại trang\. Hãy xin quản trị viên liên kết mới \(<a href="\/dieu-khoan#lien-he" target="_blank" rel="noopener">mục Liên hệ<\/a>\)\.<\/p><a class="hero-cta" href="\/#account">Đến trang đăng nhập<\/a>/u);
 assert.doesNotMatch(reloaded.root.innerHTML,/giáo viên/u,'teachers cannot create reset links: only the administrator can');
 // A link opened while the app is already open (hashchange) is taken the same way.
 const open=app({answers:opens});await settle();open.location.hash=`#dat-lai-mat-khau?token=${TOKEN}`;open.run('routeFromUrl()');
 assert.equal(open.location.hash,'#dat-lai-mat-khau');assert.equal(open.run('state.route'),'dat-lai-mat-khau');
 await settle();assert.match(open.root.innerHTML,/id="reset-continue"/u);await open.run('openResetLink()');assert.match(open.root.innerHTML,/password-reset-form/u);
 // A link opened before (its address is in the browser's history) is refused at once: no form, how to get a new one.
 const used=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,answers:url=>url==='/api/auth/password-reset/check'?[400,{error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'}]:null});await settle();
 assert.doesNotMatch(used.root.innerHTML,/password-reset-form|reset-continue/u);assert.match(used.root.innerHTML,/<div class="reset-unavailable" role="alert"><p tabindex="-1" data-focus-first>Liên kết đặt lại mật khẩu không hợp lệ/u);
 assert.ok(!used.calls.some(call=>call.url==='/api/auth/password-reset/open'));
 // Used in another tab between the check and the click: said the same way.
 const late=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,answers:url=>url==='/api/auth/password-reset/open'?[400,{error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'}]:opens(url)});await settle();
 await late.run('openResetLink()');
 assert.doesNotMatch(late.root.innerHTML,/password-reset-form|reset-continue/u);assert.match(late.root.innerHTML,/<div class="reset-unavailable" role="alert"><p tabindex="-1" data-focus-first>/u);
});

test('New password: a mismatch is said on the second field without a request; success signs in and confirms on the account page',async()=>{
 let signedIn=false;
 const reset=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-2'},{password:'password-reset-rule'});
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':reset},answers:url=>url==='/api/auth/password-reset'?(signedIn=true,[200,{ok:true}]):url==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:opens(url)});
 await settle();await page.run('openResetLink()');
 await reset.fire('submit');
 assert.equal(reset.box.hidden,false);assert.equal(reset.box.textContent,'Hai mật khẩu chưa khớp. Hãy nhập lại cho giống nhau.');assert.equal(reset.box.focused,true);
 assert.equal(reset.input('confirm').getAttribute('aria-invalid'),'true');assert.equal(reset.input('confirm').getAttribute('aria-describedby'),'password-reset-error');
 assert.equal(reset.input('password').getAttribute('aria-invalid'),null);assert.equal(reset.input('password').getAttribute('aria-describedby'),'password-reset-rule','the rule under the field stays');
 assert.ok(!page.calls.some(call=>call.url==='/api/auth/password-reset'),'nothing sent');
 reset.values.confirm='mat-khau-moi-1';await reset.fire('submit');await settle();
 const sent=page.calls.find(call=>call.url==='/api/auth/password-reset');
 assert.equal(sent.method,'POST');assert.deepEqual(JSON.parse(sent.body),{token:FRESH,password:'mat-khau-moi-1'},'the fresh token, not the one in the link');
 assert.equal(page.run('state.route'),'account');assert.equal(page.location.hash,'#account');assert.equal(page.run('state.resetToken'),null);
 assert.match(page.root.innerHTML,/<p class="account-notice status" data-tone="ok" role="status" tabindex="-1" data-focus-first>Đã đặt mật khẩu mới; các thiết bị khác đã bị đăng xuất\.<\/p>/u);
 // Leaving the account page drops the confirmation.
 page.run(`go('library')`);assert.equal(page.run('state.accountNotice'),null);
});

test('New password refused: a used or expired link is explained with how to get a new one; a weak password keeps the form',async()=>{
 const reset=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-1'});
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':reset},answers:url=>url==='/api/auth/password-reset'?[400,{error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'}]:opens(url)});
 await settle();await page.run('openResetLink()');await reset.fire('submit');
 assert.equal(page.run('state.resetToken'),null);assert.equal(page.run('state.route'),'dat-lai-mat-khau');
 assert.match(page.root.innerHTML,/<div class="reset-unavailable" role="alert"><p tabindex="-1" data-focus-first>Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn\. Hãy xin quản trị viên một liên kết mới\. Địa chỉ ở <a href="\/dieu-khoan#lien-he" target="_blank" rel="noopener">mục Liên hệ<\/a>\.<\/p>/u,'where to ask for a new link');
 assert.doesNotMatch(page.root.innerHTML,/password-reset-form/u);
 const again=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-1'});
 const weak=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':again},answers:url=>url==='/api/auth/password-reset'?[400,{error:'Mật khẩu cần từ 8 đến 128 ký tự.'}]:opens(url)});
 await settle();await weak.run('openResetLink()');await again.fire('submit');
 assert.equal(again.box.textContent,'Mật khẩu cần từ 8 đến 128 ký tự.');assert.equal(again.input('password').getAttribute('aria-invalid'),'true');
 assert.equal(weak.run('state.resetToken'),FRESH,'the link can be tried again');assert.equal(again.button.disabled,false);
});

test('Sign-in errors stay in the form (alert, focus, aria-invalid); a double press sends one request; an edit clears its mark',async()=>{
 const login=form('reader-login-form',['email','password'],{email:'lan@example.test',password:'sai-mat-khau'});
 const page=app({hash:'#account',elements:{'#reader-login-form':login},lists:{'.auth-form':[login]},answers:url=>url==='/api/auth/login'?[401,{error:'Email hoặc mật khẩu không đúng.'}]:null});
 await settle();
 const first=login.fire('submit');assert.equal(login.button.disabled,true,'the button waits for the answer');
 await Promise.all([first,login.fire('submit')]);
 assert.equal(page.calls.filter(call=>call.url==='/api/auth/login').length,1,'one request for a double press');
 assert.equal(login.box.textContent,'Email hoặc mật khẩu không đúng.');assert.equal(login.box.hidden,false);assert.equal(login.box.focused,true);
 for(const name of ['email','password'])assert.equal(login.input(name).getAttribute('aria-invalid'),'true',name);
 assert.equal(page.toast.textContent,'','no toast for a form error');assert.equal(login.button.disabled,false);
 const password=login.input('password');await login.fire('input',{target:password});
 assert.equal(password.getAttribute('aria-invalid'),null);assert.equal(password.getAttribute('aria-describedby'),null);assert.equal(login.input('email').getAttribute('aria-invalid'),'true');
 // Registration: an address that has an account is marked on the e-mail field.
 const register=form('reader-register-form',['name','email','password','acceptTerms'],{name:'Lan',email:'lan@example.test',password:'mat-khau-dai',acceptTerms:'on'});
 const second=app({hash:'#account',elements:{'#reader-register-form':register},answers:url=>url==='/api/auth/register'?[409,{error:'Email này đã có tài khoản.'}]:null});
 await settle();await register.fire('submit');
 assert.equal(register.box.textContent,'Email này đã có tài khoản.');assert.equal(register.input('email').getAttribute('aria-invalid'),'true');assert.equal(register.input('name').getAttribute('aria-invalid'),null);
 assert.equal(JSON.parse(second.calls.find(call=>call.url==='/api/auth/register').body).acceptTerms,true);
 // A sign-in the server took but the browser did not keep (no session cookie) is said, not lost.
 const kept=form('reader-login-form',['email','password'],{email:'lan@example.test',password:'mat-khau-dung'});
 const third=app({hash:'#account',elements:{'#reader-login-form':kept},answers:url=>url==='/api/auth/login'?[200,{ok:true}]:null});
 await settle();await kept.fire('submit');
 assert.match(kept.box.textContent,/trình duyệt chưa giữ phiên đăng nhập/u);assert.equal(third.run('state.reader.authenticated'),false);
});

test('Sign-in page: "Quên mật khẩu?" says where to ask the administrator for a link, tab panels wrap the forms, nothing about Google without it',async()=>{
 const {run}=app(),view=reader=>run(`state.loaded=true;state.route='account';state.pendingRequest=false;state.reader=${JSON.stringify(reader)};accountView()`);
 const open=view(ME_OUT);
 // No e-mail is sent and teachers cannot make links: the student writes to the administrator, at the address the Terms
 // give in their contact section (a blank the operator fills in before launch).
 assert.match(open,/<details class="auth-forgot more"><summary>Quên mật khẩu\?<\/summary><div class="more-body"><p>Hoa Trí không gửi email\. Hãy nhắn quản trị viên \(xem <a href="\/dieu-khoan#lien-he" target="_blank" rel="noopener">mục Liên hệ<\/a>\) kèm email đăng nhập để nhận liên kết đặt lại; liên kết dùng một lần, trong 24 giờ\.<\/p><p>Tài khoản Google không có mật khẩu: bấm “Tiếp tục bằng Google”\.<\/p><\/div><\/details>/u);
 assert.doesNotMatch(open,/giáo viên/u,'only the administrator creates reset links');
 const contact=/<section id="lien-he"[^>]*>[\s\S]*?<\/section>/u.exec(await readFile(new URL('../frontend/dieu-khoan.html',import.meta.url),'utf8'))?.[0]||'';
 assert.match(contact,/xin liên kết đặt lại mật khẩu/u,'the Terms\' contact section is where a reset link is asked for');
 assert.match(contact,/\[\[CHƯA ĐIỀN: email liên hệ\]\]|[\w.+-]+@[\w-]+\.[\w.-]+/u,'with its address');
 assert.match(open,/aria-controls="auth-panel-login"[\s\S]*aria-controls="auth-panel-register"/u);
 assert.match(open,/<div class="auth-panel" role="tabpanel" id="auth-panel-login" aria-labelledby="auth-tab-login"><form id="reader-login-form" class="auth-form">/u);
 assert.match(open,/<div class="auth-panel" role="tabpanel" id="auth-panel-register" aria-labelledby="auth-tab-register" hidden><form id="reader-register-form" class="auth-form">/u);
 assert.doesNotMatch(open,/<form[^>]*role=/u,'a form keeps its own role');
 assert.match(open,/<p class="form-error" id="reader-login-error" role="alert" tabindex="-1" hidden><\/p>/u);assert.match(open,/id="reader-register-error"/u);
 assert.match(open,/return_to=%2F%23account/u);assert.doesNotMatch(open,/auth-pending/u);
 const noGoogle=view({...ME_OUT,googleConfigured:false});
 assert.doesNotMatch(noGoogle,/google-login|google-later|sẽ xuất hiện khi được cấu hình|Google/u,'nothing about Google when it is not configured');
 assert.match(noGoogle,/Quên mật khẩu\?/u);
 const domain=view({...ME_OUT,registration:{mode:'domain',domains:['truong.edu.vn']}});
 assert.match(domain,/<h1 id="auth-title">Đăng nhập<\/h1>[\s\S]*<form id="reader-login-form" class="auth-form" aria-labelledby="auth-title"><p class="form-error"/u);
 assert.doesNotMatch(domain,/role="tabpanel"|role="tablist"/u);assert.match(domain,/Quên mật khẩu\?/u);
});

test('Account page: the header\'s initials, failed lists as error cards with "Thử lại", empty lists with actions',async()=>{
 const {run}=app();
 const html=run(`state.loaded=true;state.route='account';state.errors={};state.reader=${JSON.stringify(ME_IN)};state.myLibrary=[];state.myRequests=[];publicLayout()`);
 const header=/<span class="header-avatar">([^<]*)<\/span>/u.exec(html)[1],profile=/<div class="account-profile"><span aria-hidden="true">([^<]*)<\/span>/u.exec(html)[1];
 assert.equal(header,'NT');assert.equal(profile,header,'the same initials as the header');assert.doesNotMatch(html,/insecure\.example|讀/u,'an http picture is not shown, as in the header');
 assert.match(html,/<p class="account-email">thao@example\.test<\/p><\/div><\/div><button type="button" class="quiet" id="reader-logout">Đăng xuất<\/button>/u);
 assert.match(html,/<h2>Thư viện riêng<\/h2><\/div><div class="empty-line account-empty"><p>Chưa có tài liệu\.<\/p><a class="hero-cta hero-cta-primary" href="\/study">Dịch tài liệu đầu tiên<\/a><\/div>/u);
 assert.match(html,/<h2>Yêu cầu của tôi<\/h2><div class="section-actions"><button type="button" class="quiet" id="account-request">\+ Yêu cầu dịch<\/button><\/div><\/div><p class="empty-line account-empty">Chưa có yêu cầu dịch\.<\/p>/u);
 assert.equal((html.match(/id="account-request"|data-request-open/gu)||[]).length,1,'one way to ask for a translation in the page (the header has its own)');assert.doesNotMatch(html,/class="eyebrow"/u);
 const failed=run(`state.errors={myLibrary:Object.assign(new Error('Chưa đọc được Thư viện riêng.'),{status:503}),myRequests:Object.assign(new Error('Hãy đăng nhập.'),{status:401})};accountView()`);
 assert.match(failed,/<div class="panel load-error" role="alert"><h2>Chưa tải được Thư viện riêng<\/h2><p>Chưa đọc được Thư viện riêng\.<\/p><div class="button-row"><button type="button" class="secondary" data-retry="account">Thử lại<\/button>/u,'a part of the page that did not load: an outlined Thử lại, never a second red button');
 assert.match(failed,/<h2>Chưa tải được yêu cầu dịch của bạn<\/h2><p>Hãy đăng nhập\.<\/p><div class="button-row"><button type="button" class="secondary" data-retry="account">/u,'on the account page "Thử lại" leads to sign-in: no link to the same page');
 assert.doesNotMatch(failed,/account-empty|chưa gửi yêu cầu/u,'never an empty state for an error');
 const me=run(`state.reader={authenticated:false};state.errors={me:Object.assign(new Error('Máy chủ gặp lỗi ngoài dự kiến.'),{status:500})};accountView()`);
 assert.match(me,/<section class="account-error"><h1>Tài khoản<\/h1><div class="panel load-error" role="alert"><h2>Chưa tải được tài khoản<\/h2>/u);
 assert.doesNotMatch(me,/reader-login-form/u);
 // "Thử lại" asks for everything again.
 const retry=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:null});await settle();
 retry.calls.length=0;await retry.run(`retryLoad('account')`);
 // The parts of the student's books come too: they only add the "Bố cục cũ" notes.
 assert.deepEqual(retry.calls.map(call=>call.url).sort(),['/api/library','/api/me','/api/my/library','/api/my/requests','/api/my/study/books']);
});

// One name for the student's library ("Thư viện riêng"), dates as the reader's own day (dd/mm/yyyy), and the sign-in
// page says that Xưởng dịch needs an account (study.js sends a signed-out student there).
test('Account copy: request rows show dd/mm (the full date in the tooltip), the library is "Thư viện riêng", the sign-in card is the form',()=>{
 const {run}=app();
 const requests=[{id:'r1',title:'Sử ký',status:'done',visibility:'private',filename:'su-ky.pdf',created_at:'2026-10-01 12:00:00',story_id:'s1'},{id:'r2',title:'Luận ngữ',status:'pending',visibility:'public',source_url:'https://example.com/a',created_at:'2026-09-30T12:00:00.000Z'},{id:'r3',title:'Cũ',status:'pending',visibility:'private',created_at:null}];
 const html=run(`state.loaded=true;state.route='account';state.errors={};state.reader=${JSON.stringify(ME_IN)};state.myLibrary=[];state.myRequests=${JSON.stringify(requests)};accountView()`);
 assert.match(html,/<li class="row request-row" data-request-row="r1"><div class="row-text"><h3 class="row-title" title="Sử ký">Sử ký<\/h3><p class="row-meta">su-ky\.pdf · <span title="01\/10\/2026">01\/10<\/span><\/p><\/div><div class="row-side"><span class="chip" data-tone="ok">Đã xong<\/span><\/div><\/li>/u);
 assert.match(html,/<h3 class="row-title" title="Luận ngữ">Luận ngữ<\/h3><p class="row-meta">Liên kết · <span title="30\/09\/2026">30\/09<\/span><\/p><\/div><div class="row-side"><span class="chip">Thư viện chung<\/span><span class="chip">Mới<\/span><\/div>/u);
 assert.match(html,/<h3 class="row-title" title="Cũ">Cũ<\/h3><\/div>/u,'no meta line when the server sent neither a source nor a date');
 assert.doesNotMatch(html,/Nguồn chưa cập nhật|đã được đưa vào|privacy-badge|Riêng tư/u);
 // A finished request whose book can be read opens it from its row.
 const done=run(`state.myLibrary=[{id:'s1',title:'Sử ký',genre:'Lịch sử',chapters:2,visibility:'private'}];accountView()`);
 assert.match(done,/<span class="chip" data-tone="ok">Đã xong<\/span><button type="button" class="quiet" data-read="s1" aria-label="Đọc Sử ký"><span data-read-label="Đọc">Đọc<\/span><\/button>/u);
 assert.doesNotMatch(html,/\d{4}-\d\d-\d\d/u,'no ISO date on the page');
 const card=run(`state.myLibrary=[];state.reader=${JSON.stringify(ME_OUT)};accountView()`);
 assert.match(card,/^<section class="account-auth"><div class="auth-forms panel"><h1 id="auth-title">Đăng nhập<\/h1><p class="auth-lead">Thư viện chung đọc được không cần đăng nhập\.<\/p>/u,'the form first: its heading and one line');
 assert.doesNotMatch(card,/auth-intro|auth-benefits|class="eyebrow"/u);
 assert.doesNotMatch(run(`accountView()`)+run(`state.reader=${JSON.stringify(ME_IN)};accountView()`),/[Tt]hư viện cá nhân|thư viện riêng/u,'one spelling: Thư viện riêng');
});

test('Request intent: kept in sessionStorage while signing in (Google returns to /#yeu-cau); an expired session keeps the draft',async()=>{
 // Signed out: sign in first; the Google button comes back to the dialog.
 const out=app();await settle();
 out.run('requestStory()');
 assert.equal(out.run('state.route'),'account');assert.equal(out.session.get('hoa-tri-request-draft'),'{}');
 assert.match(out.root.innerHTML,/return_to=%2F%23yeu-cau/u);
 assert.match(out.root.innerHTML,/<p class="auth-note auth-pending" role="note">Đăng nhập xong, hộp Yêu cầu dịch sẽ tự mở\.<\/p>/u,'nothing was typed yet: no promise to restore it');
 // A reload of the sign-in page keeps the intent; leaving the page, or any other page, drops it.
 const reload=app({hash:'#account',stored:{'hoa-tri-request-draft':'{}'}});await settle();
 assert.equal(reload.run('state.pendingRequest'),true);assert.match(reload.root.innerHTML,/return_to=%2F%23yeu-cau/u);
 reload.run(`go('library')`);assert.equal(reload.session.has('hoa-tri-request-draft'),false);assert.equal(reload.run('state.pendingRequest'),false);
 assert.equal(app({stored:{'hoa-tri-request-draft':'{}'}}).session.has('hoa-tri-request-draft'),false,'another page drops it');
 // Back from Google at /#yeu-cau, signed in: the dialog opens with the kept draft, which leaves the storage.
 const draft={title:'Sử ký – Bản kỷ',source_url:'https://example.test/su-ky',notes:'Giữ tên quan chức.',visibility:'public',filename:'su-ky.pdf'};
 const back=app({hash:'#yeu-cau',stored:{'hoa-tri-request-draft':JSON.stringify(draft)},answers:url=>url==='/api/me'?[200,ME_IN]:null});await settle();
 assert.equal(back.modal.open,true);assert.equal(back.location.hash,'');assert.equal(back.session.has('hoa-tri-request-draft'),false);
 const dialog=back.modal.innerHTML;
 assert.match(dialog,/<input name="title" required maxlength="200" value="Sử ký – Bản kỷ">/u);assert.match(dialog,/<input name="source_url" type="url" placeholder="https:\/\/…" value="https:\/\/example\.test\/su-ky" aria-describedby="request-source-error">/u);
 assert.match(dialog,/>Giữ tên quan chức\.<\/textarea>/u);assert.match(dialog,/value="public" checked aria-describedby="visibility-rights">/u);assert.doesNotMatch(dialog,/value="private" checked/u);
 assert.match(dialog,/Hãy chọn lại tệp “su-ky\.pdf”: trình duyệt không giữ tệp qua lần đăng nhập\./u);
 // The session ran out while sending: the dialog closes, the draft waits, the page asks to sign in again; signing in
 // opens the dialog again with it.
 const expired=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/requests'?[401,{error:'Hãy đăng nhập để gửi yêu cầu dịch.'}]:null});await settle();
 expired.run('requestStory()');assert.equal(expired.modal.open,true);
 const submitter=new Element();
 await expired.modalForm.onsubmit({preventDefault(){},submitter,target:{values:{title:'Hàm số',file:{size:2048,name:'ham-so.pdf'},source_url:'',notes:'Chương 2',visibility:'private'}}});
 assert.deepEqual(JSON.parse(expired.session.get('hoa-tri-request-draft')),{title:'Hàm số',source_url:'',notes:'Chương 2',visibility:'private',filename:'ham-so.pdf'});
 assert.equal(expired.modal.open,false);assert.equal(expired.run('state.reader.authenticated'),false);assert.equal(expired.run('state.route'),'account');
 assert.match(expired.root.innerHTML,/reader-login-form[\s\S]*auth-pending|auth-pending[\s\S]*reader-login-form/u);
 assert.match(expired.root.innerHTML,/Đăng nhập xong, hộp Yêu cầu dịch sẽ mở lại với nội dung bạn đã nhập\./u);
 assert.equal(expired.toast.textContent,'','the sign-in form says it; no toast');
 expired.run(`state.reader=${JSON.stringify(ME_IN)};render()`);
 assert.equal(expired.modal.open,true);assert.match(expired.modal.innerHTML,/value="Hàm số"/u);assert.match(expired.modal.innerHTML,/>Chương 2<\/textarea>/u);
 assert.match(expired.modal.innerHTML,/Hãy chọn lại tệp “ham-so\.pdf”/u);assert.equal(expired.session.has('hoa-tri-request-draft'),false);
});

test('Request dialog: one of a file or a link, said under them and marked when both are missing, the focus on the file; the sharing rights note',async()=>{
 const file=new Element(),link=new Element(),source=new Element();
 const page=app({answers:url=>url==='/api/me'?[200,ME_IN]:null,elements:{'#modal [name="file"]':file,'#modal [name="source_url"]':link,'#request-source-error':source}});await settle();
 page.run('requestStory()');const html=page.modal.innerHTML;
 assert.match(html,/^<form id="modal-form"><h2>Yêu cầu dịch<\/h2><label class="modal-field">Tên tài liệu<input name="title"/u,'one heading, no eyebrow or subtitle');
 assert.match(html,/<fieldset class="request-source" aria-describedby="request-source-error"><legend>Tệp hoặc liên kết \(chọn một\)<\/legend><div class="request-file"><label class="file-pick button secondary"><span>Chọn tệp…<\/span><input class="sr-only" name="file" type="file"/u);
 assert.match(html,/<small class="field-hint" id="request-file-hint">PDF, EPUB, AZW3, DOCX, TXT, ảnh · tối đa 25 MB<\/small>/u);
 assert.match(html,/<label class="modal-field">Liên kết<input name="source_url" type="url"/u);assert.match(html,/<\/fieldset><p class="field-error" id="request-source-error" role="alert"><\/p>/u);
 assert.match(html,/<span>Chia sẻ cộng đồng \(Thư viện chung\)<\/span><\/label><small class="field-hint visibility-rights" id="visibility-rights">Chỉ khi tài liệu hết bản quyền hoặc bạn được phép chia sẻ\.<\/small>/u);
 assert.doesNotMatch(html,/không bắt buộc|học liệu chung/u);assert.match(html,/value="private" checked>/u);
 // The Terms and the Privacy page say what choosing “Chia sẻ cộng đồng” for a request means: the choice is named so.
 for(const name of ['dieu-khoan.html','quyen-rieng-tu.html']){
  const quoted=/Khi (?:bạn )?chọn “([^”]+)” cho một yêu cầu dịch/u.exec(await readFile(new URL(`../frontend/${name}`,import.meta.url),'utf8'))?.[1];
  assert.equal(quoted,'Chia sẻ cộng đồng',name);assert.ok(html.includes(`<span>${quoted} (Thư viện chung)</span>`),name);
 }
 await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{title:'Hàm số',file:{size:0,name:''},source_url:'',notes:'',visibility:'private'}}});
 assert.equal(source.textContent,'Hãy chọn tệp hoặc dán liên kết.');assert.equal(page.modalError.textContent,'','#modal-error is for the server');assert.equal(page.modal.open,true);
 assert.equal(file.getAttribute('aria-invalid'),'true');assert.equal(link.getAttribute('aria-invalid'),'true');assert.equal(file.focused,true,'the focus goes to the file button');
 assert.ok(!page.calls.some(call=>call.url==='/api/requests'),'nothing sent');
 assert.match(html,/<span>Chỉ mình tôi<\/span>/u,'the private choice');
});

test('Request dialog: a link that is not a web address (javascript:, data:, "https://") is refused on its field before sending',async()=>{
 const file=new Element(),link=new Element(),source=new Element();let answer=[201,{ok:true}];
 const page=app({answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/requests'?answer:null,elements:{'#modal [name="file"]':file,'#modal [name="source_url"]':link,'#request-source-error':source}});await settle();
 const send=source_url=>page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{title:'Hàm số',file:{size:0,name:''},source_url,notes:'',visibility:'private'}}});
 for(const bad of ['javascript:alert(document.cookie)','data:text/html,<b>x</b>','https://','www.example.com/sach','ftp://example.com/a']){
  page.run('requestStory()');source.textContent='';link.focused=false;await send(bad);
  assert.equal(source.textContent,'Liên kết phải là địa chỉ web bắt đầu bằng http:// hoặc https://.',bad);
  assert.equal(link.focused,true,bad);assert.equal(link.getAttribute('aria-invalid'),'true',bad);assert.equal(file.getAttribute('aria-invalid'),null,bad);
 }
 assert.ok(!page.calls.some(call=>call.url==='/api/requests'),'nothing sent');
 // A refusal of the server about the link (an older page, another rule) is marked on the same field.
 answer=[400,{error:'Liên kết phải là một địa chỉ web bắt đầu bằng http:// hoặc https://'}];page.run('requestStory()');await send('https://example.com/sach');
 assert.equal(source.textContent,'Liên kết phải là một địa chỉ web bắt đầu bằng http:// hoặc https://');assert.equal(link.getAttribute('aria-invalid'),'true');
 answer=[201,{ok:true}];page.run('requestStory()');await send('https://example.com/sach');
 assert.equal(page.calls.filter(call=>call.url==='/api/requests').length,2,'a web address is sent');assert.equal(page.modal.open,false);
});

test('Admin: a reset link for a password account (shown once, full address, expiry, copy); Google accounts say why not',async()=>{
 const copy=new Element(),status=new Element(),link=new Element(),button=new Element({isConnected:true});
 const users=[{id:'u1',email:'lan@example.test',name:'Lan',provider:'local'},{id:'u2',email:'minh@example.test',name:'Minh',provider:'google'}];
 let answer=[201,{resetUrl:`/#dat-lai-mat-khau?token=${TOKEN}`,expiresAt:'2026-10-22T08:30:00.000Z'}];
 const page=app({pathname:'/admin',hash:'#users',elements:{'#copy-reset-link':copy,'#reset-link-status':status,'#reset-link':link,'[data-user-reset="u1"]':button},answers:url=>url==='/api/users/u1/password-reset'?answer:url==='/api/users'?[200,users]:null});
 // The console's first load (status, then four lists) may take longer than one settle on a busy machine.
 for(let wait=0;wait<100&&page.run('state.users.length')<2;wait++)await settle();
 const view=page.run(`state.requests=[];usersView()`);
 assert.match(view,/<button type="button" data-user-reset="u1">Tạo liên kết đặt lại mật khẩu<\/button>/u);
 assert.doesNotMatch(view,/data-user-reset="u2"/u);assert.match(view,/<span class="chip" title="Tài khoản Google, không có mật khẩu">Google<\/span>/u,'a Google account has no reset: its chip says why');
 await page.run('createResetLink')('u1',button);
 assert.equal(page.calls.find(call=>call.url==='/api/users/u1/password-reset').method,'POST');assert.equal(page.modal.open,true);
 const html=page.modal.innerHTML;
 assert.match(html,/<h2>Liên kết đặt lại mật khẩu · Lan<\/h2>/u);assert.match(html,/không đăng vào nhóm lớp: ai có liên kết đều đặt được mật khẩu mới\./u);
 assert.match(html,new RegExp(`<input id="reset-link" readonly value="https://hoatri\\.test/#dat-lai-mat-khau\\?token=${TOKEN}" spellcheck="false">`,'u'),'the full address');
 assert.match(html,/Gửi riêng liên kết này cho đúng học sinh lan@example\.test/u);assert.match(html,/Liên kết chỉ hiện một lần · mở được một lần · hết hạn lúc \d\d:\d\d \d\d\/10\/2026\./u);
 assert.doesNotMatch(html,/id="close-modal"/u,'one button: Đóng');assert.match(html,/<button class="primary">Đóng<\/button>/u);
 assert.equal(link.selected,true,'the link is selected, ready to copy by hand');assert.equal(button.disabled,false);
 await copy.fire('click');
 assert.equal(page.clipboard.text,`https://hoatri.test/#dat-lai-mat-khau?token=${TOKEN}`);assert.equal(status.textContent,'Đã sao chép.');
 // "Đóng": the focus is back on the button as the dialog closes, before the browser's close event (one task later,
 // never fired here); that event, when it comes, changes nothing.
 assert.equal(button.focused,undefined);
 await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{}}});
 assert.equal(page.modal.open,false);assert.equal(button.focused,true,'the focus is back where the link was asked for');
 button.focused=false;page.modal.fire('close');assert.equal(button.focused,false,'given back once');
 // 404 and 409: the server's reason (the caller shows it in the toast), the list loaded again.
 for(const [code,error] of [[404,'Không tìm thấy tài khoản.'],[409,'Tài khoản này đăng nhập bằng Google nên không có mật khẩu để đặt lại.']]){
  answer=[code,{error,...(code===409?{code:'no_password'}:{})}];page.calls.length=0;
  await assert.rejects(page.run('createResetLink')('u1',button),{message:error});
  assert.ok(page.calls.some(call=>call.url==='/api/users'),`${code}: the list is reloaded`);assert.equal(button.disabled,false);
 }
});

test('Admin: a request file that cannot be downloaded is a message, never an unhandled rejection',async()=>{
 const file=new Element({dataset:{requestFile:'r1'}});
 const page=app({pathname:'/admin',hash:'#requests',lists:{'[data-request-file]':[file]},answers:url=>url==='/api/requests/r1/file'?[404,{error:'Không tìm thấy tệp của yêu cầu này.'}]:null});
 await settle();page.run(`state.requests=[{id:'r1',title:'Sử ký',filename:'su-ky.pdf',status:'pending'}];render()`);
 assert.equal(typeof file.onclick,'function');
 await file.onclick();assert.equal(page.toast.textContent,'Không tìm thấy tệp của yêu cầu này.');
 page.run(`fetch=async()=>{throw new TypeError('Failed to fetch');}`);
 await file.onclick();assert.equal(page.toast.textContent,'Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.');
});

test('The toast region is a polite live region that stays in the page while idle',()=>{
 const page=app();
 assert.equal(page.toast.getAttribute('aria-live'),'polite');assert.equal(page.toast.getAttribute('aria-atomic'),'true');
 page.run(`toast('Đã lưu.')`);assert.equal(page.toast.className,'is-visible');assert.equal(page.toast.textContent,'Đã lưu.');
});

// A part of a student's book an older extractor read (GET /api/my/study/books: layoutOutdated) says "Bố cục cũ" on the
// book's card and above the part in the reader, with a link to Xưởng dịch: the part's session with refresh=1, or the
// refreshed copy begun already, with the blocks it still has to translate. Nothing else is asked for or paid.
test('Thư viện riêng and the reader say "Bố cục cũ" on parts an older extractor read, linking each to Xưởng dịch',async()=>{
 const OLD='6a1b2c3d-1111-4a2b-8c3d-4e5f6a7b8c90',DRAFT='9d4e5f6a-4444-4d5e-9f6a-7b8c9d0e1f23';
 const book={id:'book-1',title:'tesst',genre:'Toán học · STEM',chapters:3,visibility:'private',source_url:'study-book:book-1'};
 const parts=[{id:'chapter-1',title:'Trang 4–6',sessionId:OLD,layoutVersion:null,layoutOutdated:true,refresh:null},{id:'chapter-2',title:'Trang 7–8',sessionId:'s-2',layoutVersion:2,layoutOutdated:true,refresh:{sessionId:DRAFT,blocks:12}},{id:'chapter-3',title:'Trang 9',sessionId:'s-3',layoutVersion:4,layoutOutdated:false,refresh:null}];
 const page=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/my/library'?[200,[book]]:url==='/api/my/study/books'?[200,[{id:'book-1',title:'tesst',parts}]]:null});await settle();
 const card=page.run('personalBookCards()');
 assert.ok(card.includes(`<p class="layout-outdated">Trang 4–6: bố cục cũ · <a href="/study?history=${OLD}&amp;refresh=1">Cập nhật</a></p>`),card);
 assert.ok(card.includes(`<p class="layout-outdated">Trang 7–8: bố cục cũ · <a href="/study?history=${DRAFT}">Cập nhật</a> (12 đoạn)</p>`),card);
 assert.doesNotMatch(card,/privacy-badge|Riêng tư/u,'a private book carries no badge');
 assert.doesNotMatch(card,/Trang 9/u,'a part of this extractor says nothing');
 // The reader: above the part, with the same link; another part, or a book of the public library, says nothing.
 const reader=chapter=>page.run(`state.route='reader';state.readerStory={id:'book-1',title:'tesst',study:true,cover:false,sample:false};state.chapters=[{id:'${chapter}',title:'Phần',mime:'application/pdf'}];state.chapter=0;readerView()`);
 const first=reader('chapter-1');
 assert.ok(first.includes('<aside class="note sample-notice layout-outdated" data-tone="warn" role="note"><strong>Bố cục cũ:</strong> tiêu đề, chú thích có thể chưa được dịch.'),first);
 assert.ok(first.includes(`<a href="/study?history=${OLD}&amp;refresh=1">Cập nhật</a> (chỉ đoạn mới hoặc đổi vùng chữ tốn token).</aside>`),first);
 assert.match(reader('chapter-2'),/Cập nhật<\/a> \(12 đoạn cần dịch; chỉ đoạn mới hoặc đổi vùng chữ tốn token\)/u);
 assert.doesNotMatch(reader('chapter-3'),/Bố cục cũ/u);
 assert.doesNotMatch(page.run(`state.readerStory={id:'book-1',title:'tesst',study:false};state.chapters=[{id:'chapter-1',title:'Phần',mime:'application/pdf'}];readerView()`),/Bố cục cũ/u);
 // Without that list (it failed, or an older server), nothing is said and nothing fails.
 const quiet=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/my/library'?[200,[book]]:url==='/api/my/study/books'?[503,{error:'Bận.'}]:null});await settle();
 assert.doesNotMatch(quiet.run('personalBookCards()'),/Bố cục cũ/u);assert.equal(quiet.run('state.errors.myLibrary'),undefined);
 assert.doesNotMatch(quiet.run('accountView()'),/Chưa đọc được các phần sách/u);
 // A local database behind the code (schema_outdated) is said with how to mend it, instead of the notes vanishing.
 const SCHEMA='Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start.cmd (hoặc npm run db:local rồi khởi động lại).';
 const behind=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/my/library'?[200,[book]]:url==='/api/my/study/books'?[500,{error:SCHEMA,code:'schema_outdated'}]:null});await settle();
 assert.ok(behind.run('accountView()').includes(`<h2>Chưa đọc được các phần sách của bạn</h2><p>${SCHEMA}</p>`));assert.match(behind.run('personalBookCards()'),/tesst/u,'the shelf itself still shows');
});

// Two parts, or two books, may share a title (the owner's "tesst" pages 4–6 and 7–8): a "Bố cục cũ" note names the part
// by its pages, or, without pages, by its place among the parts of that title; a title that says its pages is not
// repeated.
test('"Bố cục cũ" tells parts of one title apart by their pages, or by their place in the book',async()=>{
 const shelf=(id,chapters)=>({id,title:'tesst',genre:'Toán học · STEM',chapters,visibility:'private',source_url:`study-book:${id}`});
 const part=(id,pageStart,pageEnd,title='tesst')=>({id,title,sessionId:`s-${id}`,layoutVersion:2,layoutOutdated:true,refresh:null,pageStart,pageEnd});
 const books=[{id:'book-1',title:'tesst',parts:[part('c1',4,6)]},{id:'book-2',title:'tesst',parts:[part('c4',4,6),part('c7',7,8),part('c9',9,9,'Trang 9')]},{id:'book-3',title:'tesst',parts:[part('c10',null,null),part('c11',null,null)]}];
 const page=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/my/library'?[200,[shelf('book-1',1),shelf('book-2',3),shelf('book-3',2)]]:url==='/api/my/study/books'?[200,books]:null});await settle();
 const cards=page.run('personalBookCards()');
 assert.ok(cards.includes('<p class="layout-outdated">Trang 4–6: bố cục cũ · <a href="/study?history=s-c1&amp;refresh=1">'),cards);
 for(const [id,label] of [['c4','Trang 4–6'],['c7','Trang 7–8'],['c9','Trang 9'],['c10','Phần 1'],['c11','Phần 2']])assert.ok(cards.includes(`<p class="layout-outdated">${label}: bố cục cũ · <a href="/study?history=s-${id}&amp;refresh=1">`),label);
});
