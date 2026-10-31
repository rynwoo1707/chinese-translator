import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';
import {inAppBrowser,openInBrowserHelp} from '../frontend/in-app-browser.js';
import {GOOGLE_FAILURE_CODES} from './reader-auth.js';

// The account page against the auth contracts of backend/reader-auth.js: Google sign-ins that come back with
// #account?loi=<code>, signing out (only said once the server ended the session), changing the password, signing out
// everywhere, the weak-password nudge, and Google sign-in inside another app's browser. app.js runs as in
// library-account.test.mjs: imports stripped and given, fake elements, a fake server.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
const ME_OUT={authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]}};
const ME_IN={...ME_OUT,authenticated:true,user:{id:'u1',name:'Lan',email:'lan@example.test',picture:'',provider:'local'}};
const ZALO='Mozilla/5.0 (Linux; Android 13; SM-A135F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Zalo android/12100500 ZaloTheme/light ZaloLanguage/vn';
class Element{
 constructor(props={}){this.attributes=new Map();this.handlers={};this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.style={};this.className='';this.isConnected=true;Object.assign(this,props);}
 setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}
 removeAttribute(name){this.attributes.delete(name);}hasAttribute(name){return this.attributes.has(name);}
 addEventListener(type,fn){this.handlers[type]=fn;}fire(type,event={}){return this.handlers[type]?.({preventDefault(){this.prevented=true;},currentTarget:this,target:this,...event});}
 focus(){this.focused=true;}select(){this.selected=true;}
}
function form(id,names,values={}){
 const box=new Element({id:`${id.replace(/-form$/u,'')}-error`,hidden:true}),button=new Element(),inputs=names.map(name=>new Element({name}));
 return Object.assign(new Element({id,values}),{box,button,inputs,input:name=>inputs.find(input=>input.name===name),querySelector:selector=>selector==='.form-error'?box:selector==='[type="submit"]'?button:null,querySelectorAll:selector=>selector==='input[name]'?inputs:[]});
}
class FakeFormData{constructor(form){this.list=Object.entries(form?.values||{});}get(name){return this.list.find(([key])=>key===name)?.[1]??null;}*[Symbol.iterator](){yield* this.list;}}
function app({hash='',answers=()=>null,elements={},agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'}={}){
 const root={innerHTML:''},calls=[],location={pathname:'/',hash,search:'',origin:'https://hoatri.test',href:`https://hoatri.test/${hash}`};
 const history={pushState(state,title,url){apply(url);},replaceState(state,title,url){apply(url);}};
 function apply(url){const parsed=new URL(url,'https://hoatri.test');location.pathname=parsed.pathname;location.search=parsed.search;location.hash=parsed.hash;location.href=parsed.href;}
 const toast=new Element(),modal=new Element({open:false,showModal(){this.open=true;},close(){this.open=false;}}),modalForm=new Element(),modalError=new Element();
 const known={'#app':root,'#toast':toast,'#modal':modal,'#modal-form':modalForm,'#modal-error':modalError,'#close-modal':new Element(),...elements};
 const document={title:'',querySelector:selector=>known[selector]||null,querySelectorAll:()=>[]};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},
  inAppBrowser:()=>inAppBrowser(agent,{home:false}),openInBrowserHelp,
  location,history,document,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},navigator:{clipboard:{async writeText(){}}},matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,clearInterval,FormData:FakeFormData,console});
 context.fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET',body:init.body});await new Promise(done=>setTimeout(done,1));const answer=answers(url,init);if(answer instanceof Error)throw answer;const [status,body]=answer||[200,url==='/api/me'?ME_OUT:[]];return {ok:status<300,status,json:async()=>body};};
 vm.runInContext(source,context);
 return {root,calls,location,toast,modal,modalForm,modalError,run:code=>vm.runInContext(code,context)};
}

test('A Google sign-in that could not finish (#account?loi=<code>) is explained in Vietnamese on the sign-in page, then forgotten',async()=>{
 const page=app({hash:'#account?loi=google_cancelled&sau=xuong-dich'});
 assert.equal(page.location.hash,'#account','the code leaves the address');assert.equal(page.run('state.afterSignIn'),'/study','where the student was going is kept');
 await settle();
 assert.match(page.root.innerHTML,/<p class="form-error auth-failure" role="alert" tabindex="-1" data-focus-first>Bạn đã hủy đăng nhập bằng Google\. Bấm “Tiếp tục bằng Google” để thử lại\.<\/p>/u);
 assert.match(page.root.innerHTML,/bạn sẽ quay lại Xưởng dịch\./u);
 // Every code the server sends has its own sentence, never the raw code; the domain refusals name the school's domains.
 for(const code of GOOGLE_FAILURE_CODES){
  const text=page.run(`googleFailureText(${JSON.stringify(code)})`);
  assert.ok(text.length>20&&!text.includes(code)&&/[ạảãáàâăđêôơư]/u.test(text),`${code}: ${text}`);
  assert.notEqual(text,page.run(`googleFailureText('khong-co-ma-nay')`),`${code} has its own text`);
 }
 page.run(`state.reader={...state.reader,registration:{mode:'domain',domains:['truong.edu.vn','thpt.edu.vn']}}`);
 assert.equal(page.run(`googleFailureText('registration_domain')`),'Chỉ email thuộc truong.edu.vn hoặc thpt.edu.vn được tạo tài khoản. Hãy chọn đúng tài khoản Google của trường.');
 assert.match(page.run(`googleFailureText('registration_workspace')`),/^Chỉ tài khoản Google do truong\.edu\.vn hoặc thpt\.edu\.vn quản lý được tạo tài khoản\./u);
 assert.equal(page.run(`googleFailureText('khong-co-ma-nay')`),'Chưa đăng nhập được bằng Google. Hãy thử lại.');
 // A first Google sign-in with the e-mail of an account that has a password makes no second account (reader-auth.js):
 // sign in with that password, or follow "Quên mật khẩu?" to the administrator's address.
 assert.equal(page.run(`googleFailureText('google_email_has_password')`),'Email này đã có tài khoản Hoa Trí dùng mật khẩu. Hãy đăng nhập bằng mật khẩu đó; nếu quên, mở “Quên mật khẩu?” bên dưới.');
 // Leaving the page (or signing in) drops it.
 page.run(`go('library')`);assert.equal(page.run('state.googleFailure'),null);
 // A hostile value never reaches the page: only the known shape is read, and the text is escaped.
 const odd=app({hash:'#account?loi=%3Cimg%20src%3Dx%3E'});await settle();
 assert.equal(odd.run('state.googleFailure'),undefined);assert.doesNotMatch(odd.root.innerHTML,/auth-failure|<img src=x/u);
});

// POST /api/auth/register answers 409 email_taken for an e-mail a password account or a Google account holds, with one
// text that points to both ways of signing in: the form shows it as the server wrote it, on the e-mail field.
test('Registering an e-mail an account already holds (password or Google): the server\'s answer, in the form, on the e-mail',async()=>{
 const TAKEN='Email này đã có tài khoản. Hãy đăng nhập bằng mật khẩu của tài khoản đó, hoặc bấm “Tiếp tục bằng Google” nếu tài khoản được tạo bằng Google.';
 const register=form('reader-register-form',['name','email','password','acceptTerms'],{name:'Minh',email:'minh@truong.edu.vn',password:'mat-khau-dai-123',acceptTerms:'on'});
 const page=app({hash:'#account',elements:{'#reader-register-form':register},answers:url=>url==='/api/auth/register'?[409,{error:TAKEN,code:'email_taken'}]:null});
 await settle();await register.fire('submit');
 assert.equal(register.box.textContent,TAKEN);assert.equal(register.box.hidden,false);assert.equal(register.box.focused,true);
 assert.equal(register.input('email').getAttribute('aria-invalid'),'true');for(const name of ['name','password'])assert.equal(register.input(name).getAttribute('aria-invalid'),null,name);
 assert.equal(page.toast.textContent,'','said in the form, not in a toast');assert.equal(page.run('state.reader.authenticated'),false);
});

test('Signing out is said only when the server ended the session; otherwise the student stays signed in and is told so',async()=>{
 for(const [answer,signedOut,message] of [
  [[503,{error:'Máy chủ đang bận.'}],false,'Chưa đăng xuất được (mã 503). Bạn vẫn đang đăng nhập; hãy thử lại sau vài giây.'],
  [new TypeError('Failed to fetch'),false,'Không kết nối được máy chủ nên chưa đăng xuất được. Hãy kiểm tra mạng rồi thử lại.'],
  [[401,{error:'Phiên đăng nhập đã hết.'}],true,'Đã đăng xuất.'],
  [[204,null],true,'Đã đăng xuất.']
 ]){
  let ended=false;const logout=new Element();
  const page=app({hash:'#account',elements:{'#reader-logout':logout},answers:url=>url==='/api/auth/logout'?(ended=Array.isArray(answer)&&answer[0]<300||answer?.[0]===401,answer):url==='/api/me'?[200,ended?ME_OUT:ME_IN]:null});
  await settle();assert.equal(page.run('state.reader.authenticated'),true);
  await logout.fire('click');await settle();
  assert.equal(page.toast.textContent,message);assert.equal(page.run('state.reader.authenticated'),!signedOut);
  assert.equal(page.run('state.route'),signedOut?'library':'account');assert.equal(logout.disabled,false,'the button can be pressed again');
 }
});

test('Changing the password: the current one confirms it, mistakes stay in the form, success says the other devices were signed out',async()=>{
 const change=form('password-change-form',['currentPassword','newPassword','confirm'],{currentPassword:'mat-khau-cu-dai',newPassword:'Ba-con-meo-tren-mai',confirm:'Ba-con-meo-tren-maj'});
 let answer=[200,{ok:true,ended:2}];
 const page=app({hash:'#account',elements:{'#password-change-form':change},answers:url=>url==='/api/auth/password'?answer:url==='/api/me'?[200,ME_IN]:null});
 await settle();
 const html=page.root.innerHTML;
 assert.match(html,/<section class="personal-section account-security" aria-labelledby="account-security-title"><div class="section-head"><h2 id="account-security-title">Bảo mật tài khoản<\/h2><\/div><form id="password-change-form" class="auth-form account-password" aria-labelledby="password-change-title">/u);
 assert.match(html,/<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128">/u);
 assert.match(html,/<input name="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-change-rule"><small class="field-hint" id="password-change-rule">8–128 ký tự; tránh mật khẩu dễ đoán \(12345678, ngày sinh, email\)\.<\/small>/u);
 assert.match(html,/<button type="button" id="logout-all">Đăng xuất khỏi mọi thiết bị…<\/button>/u);
 // Two different new passwords: said on the second field, nothing sent.
 await change.fire('submit');
 assert.equal(change.box.textContent,'Hai mật khẩu mới chưa khớp. Hãy nhập lại cho giống nhau.');assert.equal(change.input('confirm').getAttribute('aria-invalid'),'true');
 assert.ok(!page.calls.some(call=>call.url==='/api/auth/password'));
 change.values.confirm=change.values.newPassword;
 // The server's refusals: a wrong current password marks that field, a weak new one the new field.
 for(const [refusal,field] of [[[403,{error:'Mật khẩu hiện tại không đúng.',code:'wrong_password'}],'currentPassword'],[[400,{error:'Mật khẩu này nằm trong số những mật khẩu phổ biến nhất nên rất dễ bị đoán.',code:'password_common'}],'newPassword'],[[400,{error:'Mật khẩu mới cần khác mật khẩu hiện tại.',code:'password_unchanged'}],'newPassword']]){
  answer=refusal;await change.fire('submit');
  assert.equal(change.box.textContent,refusal[1].error);assert.equal(change.input(field).getAttribute('aria-invalid'),'true',refusal[1].code);
  for(const other of ['currentPassword','newPassword'].filter(name=>name!==field))assert.equal(change.input(other).getAttribute('aria-invalid'),null);
 }
 answer=[200,{ok:true,ended:2}];await change.fire('submit');
 const sent=page.calls.filter(call=>call.url==='/api/auth/password').at(-1);
 assert.equal(sent.method,'POST');assert.deepEqual(JSON.parse(sent.body),{currentPassword:'mat-khau-cu-dai',newPassword:'Ba-con-meo-tren-mai'});
 assert.match(page.root.innerHTML,/<p class="account-notice status" data-tone="ok" role="status" tabindex="-1" data-focus-first>Đã đổi mật khẩu và đăng xuất 2 nơi khác\.<\/p>/u);
 assert.equal(page.run('state.reader.authenticated'),true,'this browser stays signed in (its session was renewed)');
 // A Google-only account has no password form, but can still sign out everywhere.
 const google=page.run(`state.reader=${JSON.stringify({...ME_IN,user:{...ME_IN.user,provider:'google'}})};accountView()`);
 assert.doesNotMatch(google,/password-change-form/u);assert.match(google,/không có mật khẩu riêng ở Hoa Trí/u);assert.match(google,/id="logout-all"/u);
});

test('Signing out everywhere keeps this device by default; unticked, this device signs out too',async()=>{
 let signedIn=true;
 const page=app({hash:'#account',answers:(url,init)=>url==='/api/auth/logout-all'?(JSON.parse(init.body).keepCurrent?[200,{ok:true,ended:3,signedOut:false}]:(signedIn=false,[200,{ok:true,ended:1,signedOut:true}])):url==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:null});
 await settle();page.run('logoutAllDialog()');
 assert.equal(page.modal.open,true);assert.match(page.modal.innerHTML,/<h2>Đăng xuất khỏi mọi thiết bị\?<\/h2>/u);assert.match(page.modal.innerHTML,/<input type="checkbox" name="keepCurrent" checked> Vẫn giữ đăng nhập trên thiết bị này/u);
 await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{keepCurrent:'on'}}});
 assert.deepEqual(JSON.parse(page.calls.find(call=>call.url==='/api/auth/logout-all').body),{keepCurrent:true});
 assert.equal(page.toast.textContent,'Đã đăng xuất 3 nơi khác. Thiết bị này vẫn đăng nhập.');assert.equal(page.run('state.reader.authenticated'),true);assert.equal(page.modal.open,false);
 page.run('logoutAllDialog()');await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{}}});await settle();
 assert.deepEqual(JSON.parse(page.calls.filter(call=>call.url==='/api/auth/logout-all').at(-1).body),{});
 assert.equal(page.run('state.reader.authenticated'),false);assert.equal(page.run('state.route'),'account');
 assert.equal(page.toast.textContent,'Đã đăng xuất khỏi mọi thiết bị (1 nơi khác), kể cả thiết bị này.');assert.match(page.root.innerHTML,/reader-login-form/u);
});

test('A password the server flags at sign-in (weakPassword) is pointed out on the account page until it is changed',async()=>{
 const login=form('reader-login-form',['email','password'],{email:'lan@example.test',password:'12345678'});
 let signedIn=false;
 const page=app({hash:'#account',elements:{'#reader-login-form':login},answers:url=>url==='/api/auth/login'?(signedIn=true,[200,{ok:true,weakPassword:'password_pattern'}]):url==='/api/me'?[200,signedIn?ME_IN:ME_OUT]:url==='/api/auth/password'?[200,{ok:true,ended:0}]:null});
 await settle();await login.fire('submit');await settle();
 assert.match(page.root.innerHTML,/<p class="note account-warning" data-tone="warn" role="note">Mật khẩu này theo quy luật dễ đoán\. <button type="button" id="weak-password-change">Đổi mật khẩu<\/button><\/p>/u);
 const change=form('password-change-form',['currentPassword','newPassword','confirm'],{currentPassword:'12345678',newPassword:'Ba-con-meo-tren-mai',confirm:'Ba-con-meo-tren-mai'});
 await page.run('changePassword')({preventDefault(){},currentTarget:change});await settle();
 assert.doesNotMatch(page.root.innerHTML,/account-warning/u,'gone once changed');assert.match(page.root.innerHTML,/data-focus-first>Đã đổi mật khẩu\.<\/p>/u);assert.equal(page.toast.textContent,'','no toast: the page says it');
 // An answer without the flag shows nothing.
 const plain=app({hash:'#account',elements:{'#reader-login-form':form('reader-login-form',['email','password'],{email:'a@b.vn',password:'x'})},answers:url=>url==='/api/auth/login'?[200,{ok:true}]:url==='/api/me'?[200,ME_IN]:null});
 await settle();assert.doesNotMatch(plain.root.innerHTML,/account-warning/u);
});

test('Google sign-in inside Zalo, Facebook…: the page first offers Chrome or Safari with the address to copy, and can still go on',async()=>{
 const google=new Element({href:'https://hoatri.test/api/auth/google/start?accept_terms=1&return_to=%2F%23account'});google.setAttribute('aria-disabled','false');
 const page=app({hash:'#account',agent:ZALO,elements:{'#google-login':google}});await settle();
 page.run('state.termsAccepted=true;render()');
 const click={preventDefault(){this.prevented=true;},currentTarget:google,target:google};
 google.handlers.click(click);
 assert.equal(click.prevented,true,'Google would refuse this browser (disallowed_useragent)');assert.equal(page.modal.open,true);
 assert.match(page.modal.innerHTML,/<h2>Mở bằng Chrome để đăng nhập<\/h2><p class="subtitle">Zalo không cho đăng nhập Google\. Bấm ⋮ → “Mở bằng trình duyệt”, hoặc sao chép địa chỉ rồi dán vào Chrome\.<\/p>/u);
 assert.match(page.modal.innerHTML,/<input id="in-app-link" readonly value="https:\/\/hoatri\.test\/#account" spellcheck="false">/u);
 assert.match(page.modal.innerHTML,/<button class="primary">Vẫn thử đăng nhập<\/button>/u);
 await page.modalForm.onsubmit({preventDefault(){},submitter:new Element(),target:{values:{}}});await settle();
 assert.equal(page.location.href,google.href,'"Vẫn thử đăng nhập" goes on to Google');
 // Any other browser goes straight to Google.
 const normal=app({hash:'#account',elements:{'#google-login':google}});await settle();normal.run('state.termsAccepted=true;render()');
 const direct={preventDefault(){this.prevented=true;},currentTarget:google,target:google};google.handlers.click(direct);
 assert.equal(direct.prevented,undefined);assert.equal(normal.modal.open,false);
});

test('"Tải cả quyển" inside an app\'s browser (which often drops downloads) first offers Chrome or Safari, and can still go on',async()=>{
 const download=new Element();
 const iphone='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/438.0.0.41.106]';
 const page=app({hash:'#account',agent:iphone,elements:{'#download-whole-book':download}});await settle();
 page.run(`state.readerStory={id:'s1',title:'Sử ký'};state.chapters=[{id:'p1',mime:'application/pdf'},{id:'p2',mime:'application/pdf'}];bindPdfTools()`);
 await download.handlers.click({preventDefault(){},currentTarget:download,target:download});
 assert.equal(page.modal.open,true);
 assert.match(page.modal.innerHTML,/<h2>Mở bằng Safari để tải tệp<\/h2><p class="subtitle">Messenger thường không lưu được tệp tải về\. Bấm ⋯ → “Mở trong Safari”, hoặc sao chép địa chỉ rồi dán vào Safari\.<\/p>/u);
 assert.match(page.modal.innerHTML,/<button class="primary">Vẫn tải ở đây<\/button>/u);
 assert.ok(!page.run('state.bookDownload'),'nothing is built before the student chooses');
});

test('In-app browsers are told apart from real browsers by their user agent',()=>{
 const cases=[
  ['Zalo, Android',ZALO,'Zalo'],
  ['Zalo, iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/482 ZaloTheme/light ZaloLanguage/vn','Zalo'],
  ['Facebook, iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.37.104;FBBV/622262938;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/vi_VN;FBOP/80]','Facebook'],
  ['Facebook, Android','Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.178 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/449.0.0.37.111;]','Facebook'],
  ['Messenger, iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/438.0.0.41.106;FBBV/539389513;FBDV/iPhone12,1]','Messenger'],
  ['Instagram','Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 323.0.3.23.54 (iPhone13,2; iOS 17_4; vi_VN; vi; scale=3.00; 1170x2532; 577210397)','Instagram'],
  ['TikTok','Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36 trill_310503 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/31.5.3 ByteLocale/vi','TikTok'],
  ['another app, Android','Mozilla/5.0 (Linux; Android 13; RMX3630 Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36','']
 ];
 for(const [name,agent,app] of cases){const found=inAppBrowser(agent,{home:false});assert.ok(found,name);assert.equal(found.name,app,name);}
 assert.equal(inAppBrowser(cases[1][1],{home:false}).ios,true);assert.equal(openInBrowserHelp(inAppBrowser(cases[1][1],{home:false})).browser,'Safari');
 assert.equal(inAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',{home:false})?.name,'','an iOS web view without Safari/');
 for(const [name,agent] of [
  ['Chrome, Android','Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'],
  ['Safari, iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
  ['Chrome, iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1'],
  ['Cốc Cốc, Android','Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/131.0.208 Chrome/125.0.6422.208 Mobile Safari/537.36'],
  ['Edge, Windows','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'],
  ['Firefox, Linux','Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0']
 ])assert.equal(inAppBrowser(agent,{home:false}),null,name);
 // Hoa Trí added to an iPhone's home screen has no Safari/ either, and is no app's browser.
 assert.equal(inAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',{home:true}),null);
});
