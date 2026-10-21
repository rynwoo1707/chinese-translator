import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// Account, sign-in, password reset (contract 7), admin reset links and the request dialog of app.js, run as in
// library-home.test.mjs (imports stripped and given, a fake fetch answering per URL), with fake elements that keep
// attributes, a fake history and a fake sessionStorage. Nothing here reaches a server.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
const TOKEN='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde',FRESH='Fr'+'e'.repeat(41);
// Opening the link trades its token for a fresh one (POST /api/auth/password-reset/open).
const opens=url=>url==='/api/auth/password-reset/open'?[200,{token:FRESH}]:null;
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
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},
  location,history,document,sessionStorage,navigator:{clipboard},matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,clearInterval,FormData:FakeFormData,console});
 context.fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET',body:init.body});await new Promise(done=>setTimeout(done,1));const [status,body]=answers(url,init)||[200,url==='/api/me'?ME_OUT:url==='/api/status'?{authenticated:true}:[]];return {ok:status<300,status,json:async()=>body};};
 vm.runInContext(source,context);
 return {root,calls,location,toast,modal,modalForm,modalError,session,clipboard,run:code=>vm.runInContext(code,context)};
}

test('A reset link: the token leaves the address at once and is traded for a fresh one kept in memory; then the form',async()=>{
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,answers:opens});
 assert.equal(page.location.hash,'#dat-lai-mat-khau','the address keeps no token');assert.equal(page.run('state.route'),'dat-lai-mat-khau');
 assert.doesNotMatch(page.root.innerHTML,/password-reset-form/u,'no form before the link is opened (nothing typed is lost to a later render)');
 await settle();
 const opened=page.calls.find(call=>call.url==='/api/auth/password-reset/open');
 assert.equal(opened.method,'POST');assert.deepEqual(JSON.parse(opened.body),{token:TOKEN});assert.equal(page.run('state.resetToken'),FRESH);
 const html=page.root.innerHTML;
 assert.equal(page.run('document.title'),'Đặt lại mật khẩu — Hoa Trí');
 assert.match(html,/<form id="password-reset-form" class="auth-form" aria-labelledby="reset-form-title">/u);
 assert.match(html,/<label>Mật khẩu mới<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-reset-rule"><small id="password-reset-rule">Từ 8 đến 128 ký tự\.<\/small><\/label>/u);
 assert.match(html,/<label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"><\/label>/u);
 assert.match(html,/<p class="form-error" id="password-reset-error" role="alert" tabindex="-1" hidden><\/p>/u);
 assert.doesNotMatch(html,new RegExp(`${TOKEN}|${FRESH}`,'u'),'the tokens are never written into the page');
 // Reloaded (or typed) without a token: how to get a working link, no form.
 const reloaded=app({hash:'#dat-lai-mat-khau'});await settle();
 assert.doesNotMatch(reloaded.root.innerHTML,/password-reset-form/u);
 assert.match(reloaded.root.innerHTML,/Chưa có liên kết đặt lại mật khẩu<\/h2><p>Vì an toàn, liên kết chỉ mở được một lần và mã của nó không được giữ lại[^<]*xin giáo viên hoặc quản trị viên một liên kết mới\.<\/p><a class="hero-cta" href="\/#account">Đến trang đăng nhập<\/a>/u);
 // A link opened while the app is already open (hashchange) is taken the same way.
 const open=app({answers:opens});await settle();open.location.hash=`#dat-lai-mat-khau?token=${TOKEN}`;open.run('routeFromUrl()');
 assert.equal(open.location.hash,'#dat-lai-mat-khau');assert.equal(open.run('state.route'),'dat-lai-mat-khau');
 await settle();assert.match(open.root.innerHTML,/password-reset-form/u);
 // A link opened before (its address is in the browser's history) is refused at once: no form, how to get a new one.
 const used=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,answers:url=>url==='/api/auth/password-reset/open'?[400,{error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'}]:null});await settle();
 assert.doesNotMatch(used.root.innerHTML,/password-reset-form/u);assert.match(used.root.innerHTML,/Không dùng được liên kết này<\/h2><p>Liên kết đặt lại mật khẩu không hợp lệ/u);
});

test('New password: a mismatch is said on the second field without a request; success signs in and confirms on the account page',async()=>{
 let signedIn=false;
 const reset=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-2'},{password:'password-reset-rule'});
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':reset},answers:url=>url==='/api/auth/password-reset'?(signedIn=true,[200,{ok:true}]):url==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:opens(url)});
 await settle();
 await reset.fire('submit');
 assert.equal(reset.box.hidden,false);assert.equal(reset.box.textContent,'Hai mật khẩu chưa khớp. Hãy nhập lại cho giống nhau.');assert.equal(reset.box.focused,true);
 assert.equal(reset.input('confirm').getAttribute('aria-invalid'),'true');assert.equal(reset.input('confirm').getAttribute('aria-describedby'),'password-reset-error');
 assert.equal(reset.input('password').getAttribute('aria-invalid'),null);assert.equal(reset.input('password').getAttribute('aria-describedby'),'password-reset-rule','the rule under the field stays');
 assert.ok(!page.calls.some(call=>call.url==='/api/auth/password-reset'),'nothing sent');
 reset.values.confirm='mat-khau-moi-1';await reset.fire('submit');await settle();
 const sent=page.calls.find(call=>call.url==='/api/auth/password-reset');
 assert.equal(sent.method,'POST');assert.deepEqual(JSON.parse(sent.body),{token:FRESH,password:'mat-khau-moi-1'},'the fresh token, not the one in the link');
 assert.equal(page.run('state.route'),'account');assert.equal(page.location.hash,'#account');assert.equal(page.run('state.resetToken'),null);
 assert.match(page.root.innerHTML,/<p class="account-notice" role="status" tabindex="-1" data-focus-first>[\s\S]*Đã đặt mật khẩu mới\. Bạn đã được đăng nhập; các thiết bị khác đang dùng tài khoản này đã được đăng xuất\.<\/span><\/p>/u);
 // Leaving the account page drops the confirmation.
 page.run(`go('library')`);assert.equal(page.run('state.accountNotice'),null);
});

test('New password refused: a used or expired link is explained with how to get a new one; a weak password keeps the form',async()=>{
 const reset=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-1'});
 const page=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':reset},answers:url=>url==='/api/auth/password-reset'?[400,{error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'}]:opens(url)});
 await settle();await reset.fire('submit');
 assert.equal(page.run('state.resetToken'),null);assert.equal(page.run('state.route'),'dat-lai-mat-khau');
 assert.match(page.root.innerHTML,/<div class="reset-unavailable" role="alert"><h2 class="auth-form-title" tabindex="-1" data-focus-first>Không dùng được liên kết này<\/h2><p>Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn\. Hãy xin quản trị viên một liên kết mới\.<\/p>/u);
 assert.doesNotMatch(page.root.innerHTML,/password-reset-form/u);
 const again=form('password-reset-form',['password','confirm'],{password:'mat-khau-moi-1',confirm:'mat-khau-moi-1'});
 const weak=app({hash:`#dat-lai-mat-khau?token=${TOKEN}`,elements:{'#password-reset-form':again},answers:url=>url==='/api/auth/password-reset'?[400,{error:'Mật khẩu cần từ 8 đến 128 ký tự.'}]:opens(url)});
 await settle();await again.fire('submit');
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

test('Sign-in page: "Quên mật khẩu?" explains the teacher link, tab panels wrap the forms, nothing about Google without it',()=>{
 const {run}=app(),view=reader=>run(`state.loaded=true;state.route='account';state.pendingRequest=false;state.reader=${JSON.stringify(reader)};accountView()`);
 const open=view(ME_OUT);
 assert.match(open,/<details class="auth-forgot"><summary>Quên mật khẩu\?<\/summary><p>Hoa Trí không gửi email đặt lại mật khẩu\. Hãy nhờ giáo viên hoặc quản trị viên tạo cho bạn một liên kết đặt lại mật khẩu, rồi mở liên kết đó để chọn mật khẩu mới\. Liên kết chỉ mở được một lần, trong vòng 24 giờ: mở ra là đặt mật khẩu mới ngay\.<\/p><p>Nếu bạn đăng nhập bằng Google thì tài khoản không có mật khẩu riêng: hãy bấm “Tiếp tục bằng Google”\.<\/p><\/details>/u);
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
 assert.match(domain,/<form id="reader-login-form" class="auth-form" aria-labelledby="auth-login-title"><h2 class="auth-form-title" id="auth-login-title">Đăng nhập<\/h2><p class="form-error"/u);
 assert.doesNotMatch(domain,/role="tabpanel"|role="tablist"/u);assert.match(domain,/Quên mật khẩu\?/u);
});

test('Account page: the header\'s initials, failed lists as error cards with "Thử lại", empty lists with actions',async()=>{
 const {run}=app();
 const html=run(`state.loaded=true;state.route='account';state.errors={};state.reader=${JSON.stringify(ME_IN)};state.myLibrary=[];state.myRequests=[];publicLayout()`);
 const header=/<span class="header-avatar">([^<]*)<\/span>/u.exec(html)[1],profile=/<div class="account-profile"><span aria-hidden="true">([^<]*)<\/span>/u.exec(html)[1];
 assert.equal(header,'NT');assert.equal(profile,header,'the same initials as the header');assert.doesNotMatch(html,/insecure\.example|讀/u,'an http picture is not shown, as in the header');
 assert.match(html,/<p class="account-email">thao@example\.test<\/p><\/div><\/div><button type="button" id="reader-logout">Đăng xuất<\/button>/u);
 assert.match(html,/Thư viện riêng chưa có tài liệu\.[^<]*<\/p><div class="account-empty-actions"><a class="hero-cta hero-cta-primary" href="\/study">Dịch tài liệu đầu tiên <span aria-hidden="true">→<\/span><\/a><button type="button" class="hero-cta" data-request-open>Gửi yêu cầu dịch<\/button>/u);
 assert.match(html,/Bạn chưa gửi yêu cầu dịch nào\.[^<]*<\/p><div class="account-empty-actions"><button type="button" class="hero-cta" data-request-open>Gửi yêu cầu dịch<\/button>/u);
 const failed=run(`state.errors={myLibrary:Object.assign(new Error('Chưa đọc được Thư viện riêng.'),{status:503}),myRequests:Object.assign(new Error('Hãy đăng nhập.'),{status:401})};accountView()`);
 assert.match(failed,/<div class="panel load-error" role="alert"><h2>Chưa tải được Thư viện riêng<\/h2><p>Chưa đọc được Thư viện riêng\.<\/p><div class="button-row"><button type="button" class="primary" data-retry="account">Thử lại<\/button>/u);
 assert.match(failed,/<h2>Chưa tải được yêu cầu dịch của bạn<\/h2><p>Hãy đăng nhập\.<\/p><div class="button-row"><button type="button" class="primary" data-retry="account">/u,'on the account page "Thử lại" leads to sign-in: no link to the same page');
 assert.doesNotMatch(failed,/account-empty|chưa gửi yêu cầu/u,'never an empty state for an error');
 const me=run(`state.reader={authenticated:false};state.errors={me:Object.assign(new Error('Máy chủ gặp lỗi ngoài dự kiến.'),{status:500})};accountView()`);
 assert.match(me,/<section class="account-error"><p class="eyebrow">GÓC NGƯỜI HỌC<\/p><h1>Tài khoản<\/h1><div class="panel load-error" role="alert"><h2>Chưa tải được tài khoản<\/h2>/u);
 assert.doesNotMatch(me,/reader-login-form/u);
 // "Thử lại" asks for everything again.
 const retry=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:null});await settle();
 retry.calls.length=0;await retry.run(`retryLoad('account')`);
 assert.deepEqual(retry.calls.map(call=>call.url).sort(),['/api/library','/api/me','/api/my/library','/api/my/requests']);
});

test('Request intent: kept in sessionStorage while signing in (Google returns to /#yeu-cau); an expired session keeps the draft',async()=>{
 // Signed out: sign in first; the Google button comes back to the dialog.
 const out=app();await settle();
 out.run('requestStory()');
 assert.equal(out.run('state.route'),'account');assert.equal(out.session.get('hoa-tri-request-draft'),'{}');
 assert.match(out.root.innerHTML,/return_to=%2F%23yeu-cau/u);
 assert.match(out.root.innerHTML,/<p class="auth-note auth-pending" role="note">Đăng nhập hoặc tạo tài khoản xong, hộp “Yêu cầu dịch” sẽ tự mở\.<\/p>/u,'nothing was typed yet: no promise to restore it');
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
 assert.match(dialog,/<input name="title" required maxlength="200" value="Sử ký – Bản kỷ">/u);assert.match(dialog,/<input name="source_url" type="url" placeholder="https:\/\/…" value="https:\/\/example\.test\/su-ky">/u);
 assert.match(dialog,/>Giữ tên quan chức\.<\/textarea>/u);assert.match(dialog,/value="public" checked>/u);assert.doesNotMatch(dialog,/value="private" checked/u);
 assert.match(dialog,/Hãy chọn lại tệp “su-ky\.pdf”: trình duyệt không giữ tệp đã chọn qua lần đăng nhập\./u);
 // The session ran out while sending: the dialog closes, the draft waits, the page asks to sign in again; signing in
 // opens the dialog again with it.
 const expired=app({hash:'#account',answers:url=>url==='/api/me'?[200,ME_IN]:url==='/api/requests'?[401,{error:'Hãy đăng nhập để gửi yêu cầu dịch.'}]:null});await settle();
 expired.run('requestStory()');assert.equal(expired.modal.open,true);
 const submitter=new Element();
 await expired.modalForm.onsubmit({preventDefault(){},submitter,target:{values:{title:'Hàm số',file:{size:2048,name:'ham-so.pdf'},source_url:'',notes:'Chương 2',visibility:'private'}}});
 assert.deepEqual(JSON.parse(expired.session.get('hoa-tri-request-draft')),{title:'Hàm số',source_url:'',notes:'Chương 2',visibility:'private',filename:'ham-so.pdf'});
 assert.equal(expired.modal.open,false);assert.equal(expired.run('state.reader.authenticated'),false);assert.equal(expired.run('state.route'),'account');
 assert.match(expired.root.innerHTML,/reader-login-form[\s\S]*auth-pending|auth-pending[\s\S]*reader-login-form/u);
 assert.match(expired.root.innerHTML,/hộp “Yêu cầu dịch” sẽ tự mở lại với nội dung bạn đã nhập\./u);
 assert.equal(expired.toast.textContent,'Phiên đăng nhập đã hết. Hãy đăng nhập lại; hộp yêu cầu dịch sẽ mở lại với nội dung bạn đã nhập.');
 expired.run(`state.reader=${JSON.stringify(ME_IN)};render()`);
 assert.equal(expired.modal.open,true);assert.match(expired.modal.innerHTML,/value="Hàm số"/u);assert.match(expired.modal.innerHTML,/>Chương 2<\/textarea>/u);
 assert.match(expired.modal.innerHTML,/Hãy chọn lại tệp “ham-so\.pdf”/u);assert.equal(expired.session.has('hoa-tri-request-draft'),false);
});

test('Request dialog: one of a file or a link, said and marked when both are missing; the sharing rights note',async()=>{
 const file=new Element(),link=new Element();
 const page=app({answers:url=>url==='/api/me'?[200,ME_IN]:null,elements:{'#modal [name="file"]':file,'#modal [name="source_url"]':link}});await settle();
 page.run('requestStory()');const html=page.modal.innerHTML;
 assert.match(html,/<fieldset class="request-source"><legend>Tệp hoặc liên kết <span>\(cần một trong hai\)<\/span><\/legend><label class="request-file">Tệp nguyên tác<input name="file" type="file"/u);
 assert.match(html,/<label class="modal-field">Liên kết nguyên tác<input name="source_url" type="url"/u);
 assert.match(html,/<strong>Chia sẻ cộng đồng<\/strong><small>Đưa vào thư viện học liệu chung<\/small><small class="visibility-rights">Chỉ chọn khi tài liệu hết bản quyền hoặc bạn được phép chia sẻ\.<\/small>/u);
 assert.doesNotMatch(html,/không bắt buộc/u);assert.match(html,/value="private" checked>/u);
 await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{title:'Hàm số',file:{size:0,name:''},source_url:'',notes:'',visibility:'private'}}});
 assert.equal(page.modalError.textContent,'Hãy chọn một tệp hoặc nhập liên kết nguyên tác.');assert.equal(page.modalError.hidden,false);assert.equal(page.modal.open,true);
 assert.equal(file.getAttribute('aria-invalid'),'true');assert.equal(link.getAttribute('aria-invalid'),'true');
 assert.ok(!page.calls.some(call=>call.url==='/api/requests'),'nothing sent');
});

test('Admin: a reset link for a password account (shown once, full address, expiry, copy); Google accounts say why not',async()=>{
 const copy=new Element(),status=new Element(),link=new Element(),button=new Element({isConnected:true});
 const users=[{id:'u1',email:'lan@example.test',name:'Lan',provider:'local'},{id:'u2',email:'minh@example.test',name:'Minh',provider:'google'}];
 let answer=[201,{resetUrl:`/#dat-lai-mat-khau?token=${TOKEN}`,expiresAt:'2026-10-22T08:30:00.000Z'}];
 const page=app({pathname:'/admin',hash:'#users',elements:{'#copy-reset-link':copy,'#reset-link-status':status,'#reset-link':link},answers:url=>url==='/api/users/u1/password-reset'?answer:url==='/api/users'?[200,users]:null});
 await settle();
 const view=page.run(`state.userStories=[];state.requests=[];usersView()`);
 assert.match(view,/<button type="button" data-user-reset="u1">Tạo link đặt lại mật khẩu<\/button>/u);
 assert.doesNotMatch(view,/data-user-reset="u2"/u);assert.match(view,/<span class="user-reset-note">Đăng nhập bằng Google nên không có mật khẩu để đặt lại\.<\/span>/u);
 await page.run('createResetLink')('u1',button);
 assert.equal(page.calls.find(call=>call.url==='/api/users/u1/password-reset').method,'POST');assert.equal(page.modal.open,true);
 const html=page.modal.innerHTML;
 assert.match(html,/<h2>Liên kết đặt lại mật khẩu cho Lan<\/h2>/u);
 assert.match(html,new RegExp(`<input id="reset-link" readonly value="https://hoatri\\.test/#dat-lai-mat-khau\\?token=${TOKEN}" spellcheck="false">`,'u'),'the full address');
 assert.match(html,/Gửi riêng liên kết này cho đúng học sinh lan@example\.test/u);assert.match(html,/Liên kết chỉ hiện một lần/u);assert.match(html,/hết hạn lúc \d\d:\d\d \d\d\/10\/2026/u);
 assert.doesNotMatch(html,/id="close-modal"/u,'one button: Đóng');assert.match(html,/<button class="primary">Đóng<\/button>/u);
 assert.equal(link.selected,true,'the link is selected, ready to copy by hand');assert.equal(button.disabled,false);
 await copy.fire('click');
 assert.equal(page.clipboard.text,`https://hoatri.test/#dat-lai-mat-khau?token=${TOKEN}`);assert.equal(status.textContent,'Đã sao chép. Hãy dán vào tin nhắn riêng cho học sinh.');
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
