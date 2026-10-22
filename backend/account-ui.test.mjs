import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// The account page against the server's registration and deletion contracts: in domain mode only Google creates
// accounts (POST /api/auth/register answers 403 registration_google_only), and a Google-only account is deleted only
// within 10 minutes of signing in (DELETE /api/me answers 403 reauth_required). app.js runs as in app-ui.test.mjs, with
// a few fake elements standing in for the page and a fake server answering the API.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const REAUTH='Hãy đăng xuất rồi đăng nhập lại bằng Google, sau đó xóa tài khoản trong vòng 10 phút.';
function element(extra={}){const handlers={};return {innerHTML:'',textContent:'',hidden:false,disabled:false,style:{},handlers,addEventListener(type,fn){handlers[type]=fn;},focus(){this.focused=true;},...extra};}
// A FormData built from a fake form's values (the real one only takes an HTML form element).
class FakeFormData{constructor(form){this.list=Object.entries(form?.values||{});}get(name){return this.list.find(([key])=>key===name)?.[1]??null;}*[Symbol.iterator](){yield* this.list;}}
function page(answers){
 const elements=new Map(),calls=[],get=selector=>{if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);};
 const known=new Set(['#app','#toast','#modal','#modal-form','#close-modal','#modal-error','#reader-register-form','#reauth-row','#reauth-signout']);
 const modal=get('#modal');Object.assign(modal,{open:false,showModal(){this.open=true;},close(){this.open=false;}});
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},releaseBilingual(){},
  location:{pathname:'/',hash:'',search:''},document:{querySelector:selector=>known.has(selector)?get(selector):null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},window:{addEventListener(){}},
  setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout,clearInterval,FormData:FakeFormData,console});
 context.fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET',body:init.body});const [status,body]=answers(url,init)||[200,url==='/api/me'?{authenticated:false}:[]];return {ok:status<300,status,json:async()=>body};};
 vm.runInContext(source,context);
 // The page loads its data first (refresh): a test changes the state only after that.
 return {get,calls,run:code=>vm.runInContext(code,context),loaded:()=>new Promise(done=>setTimeout(done,20))};
}
const signedOut=registration=>({authenticated:false,googleConfigured:true,registration});

test('Domain mode: no registration form, Google with the school domain; a server that changed its policy since is reloaded',async()=>{
 const {run,get,calls,loaded}=page(url=>url==='/api/auth/register'?[403,{error:'Chỉ đăng nhập Google mới tạo được tài khoản mới.',code:'registration_google_only'}]:url==='/api/me'?[200,signedOut({mode:'domain',domains:['truong.edu.vn','<b>x</b>']})]:null);
 await loaded();
 const view=reader=>run(`state.loaded=true;state.reader=${JSON.stringify(reader)};accountView()`);
 const domain=view(signedOut({mode:'domain',domains:['truong.edu.vn','<b>x</b>']}));
 assert.doesNotMatch(domain,/reader-register-form|data-auth-tab|acceptTerms|role="tablist"/u,'no local registration in domain mode');
 assert.match(domain,/<form id="reader-login-form" class="auth-form" aria-labelledby="auth-login-title"><h2 class="auth-form-title" id="auth-login-title">Đăng nhập<\/h2>/u,'existing accounts still sign in with their password');
 assert.match(domain,/<p class="auth-note" role="note">Tài khoản mới chỉ tạo được bằng nút Tiếp tục bằng Google, với email thuộc truong\.edu\.vn hoặc &lt;b&gt;x&lt;\/b&gt;\.<\/p>/u);
 assert.match(domain,/id="google-login" href="\/api\/auth\/google\/start\?return_to=%2F%23account" aria-disabled="true" aria-describedby="google-terms-hint google-domain-hint"/u);
 assert.match(domain,/<small class="google-terms" id="google-domain-hint">Tài khoản Google mới cần email thuộc truong\.edu\.vn hoặc &lt;b&gt;x&lt;\/b&gt;\.<\/small>/u);
 assert.match(domain,/id="google-terms-row"><input type="checkbox" data-terms-check>/u,'the Google button still waits for the terms box');
 const noGoogle=view({...signedOut({mode:'domain',domains:['truong.edu.vn']}),googleConfigured:false});
 assert.doesNotMatch(noGoogle,/reader-register-form|google-login|google-later/u);
 assert.match(noGoogle,/Tài khoản mới chỉ tạo được bằng đăng nhập Google với email thuộc truong\.edu\.vn, nhưng máy chủ chưa cấu hình đăng nhập Google\. Hãy liên hệ quản trị viên\./u);
 // Open and closed modes are as before.
 const open=view(signedOut({mode:'open',domains:[]}));assert.match(open,/data-auth-tab="register"/u);assert.match(open,/<form id="reader-register-form"/u);assert.doesNotMatch(open,/google-domain-hint|auth-note/u);
 assert.match(view(signedOut({mode:'closed',domains:[]})),/Hoa Trí hiện chưa mở đăng ký tài khoản mới\. Hãy liên hệ quản trị viên\./u);
 // The page was loaded while registration was open; the server now leaves new accounts to Google: it says why, and the
 // page fetches the policy again to show it.
 run(`state.reader=${JSON.stringify(signedOut({mode:'open',domains:[]}))};bind()`);
 const form=get('#reader-register-form');form.values={name:'Lan',email:'lan@truong.edu.vn',password:'mat-khau-dai',acceptTerms:'on'};
 const before=calls.length;await form.handlers.submit({preventDefault(){},currentTarget:form});await new Promise(done=>setTimeout(done,20));
 const after=calls.slice(before);
 assert.deepEqual(after[0],{url:'/api/auth/register',method:'POST',body:JSON.stringify({name:'Lan',email:'lan@truong.edu.vn',password:'mat-khau-dai',acceptTerms:true})});
 assert.ok(after.some(call=>call.url==='/api/me'),'the policy is fetched again');assert.equal(get('#toast').textContent,'Chỉ đăng nhập Google mới tạo được tài khoản mới.');
 assert.equal(run('state.reader.registration.mode'),'domain');
});

test('Deleting a Google-only account: the dialog says it needs a recent sign-in, shows reauth_required and offers to sign out',async()=>{
 let deleted=0;
 const {run,get,calls,loaded}=page((url,init)=>url==='/api/me'&&init.method==='DELETE'?(deleted++,[403,{error:REAUTH,code:'reauth_required'}]):url==='/api/auth/logout'?[204,null]:url==='/api/me'?[200,{authenticated:false,googleConfigured:true,registration:{mode:'open',domains:[]}}]:null);
 await loaded();run(`state.loaded=true;state.reader={authenticated:true,user:{id:'u',name:'Lan',email:'lan@example.test',provider:'google'}};deleteAccountDialog()`);
 const modal=get('#modal');assert.equal(modal.open,true);
 assert.doesNotMatch(modal.innerHTML,/name="password"/u,'no password to ask');
 assert.match(modal.innerHTML,/<p class="auth-note" role="note" style="margin-top:16px">Tài khoản đăng nhập bằng Google chỉ xóa được trong vòng 10 phút sau khi đăng nhập\. Nếu bạn đã đăng nhập lâu hơn, hãy đăng xuất rồi đăng nhập lại bằng Google trước\.<\/p>/u);
 assert.match(modal.innerHTML,/<p id="reauth-row" style="margin-top:12px" hidden><button type="button" id="reauth-signout">Đăng xuất để đăng nhập lại bằng Google<\/button><\/p>/u);
 const row=get('#reauth-row'),error=get('#modal-error');row.hidden=true;error.hidden=true;
 const submitter={disabled:false},form=element({values:{confirm:'xóa'}});
 await get('#modal-form').onsubmit({preventDefault(){},submitter,target:form});
 assert.equal(deleted,1);assert.deepEqual(JSON.parse(calls.find(call=>call.method==='DELETE').body),{confirm:'xóa'});
 assert.equal(modal.open,true,'the dialog stays open');assert.equal(error.hidden,false);assert.equal(error.textContent,REAUTH);
 assert.equal(row.hidden,false);assert.equal(get('#reauth-signout').focused,true,'the way out has the focus');assert.equal(submitter.disabled,false);
 assert.equal(run('state.reader.authenticated'),true,'nothing was deleted, the student is still signed in');
 // Signing out from the dialog leads to the account page, where Google sign-in starts again.
 await get('#reauth-signout').handlers.click({});await new Promise(done=>setTimeout(done,20));
 assert.ok(calls.some(call=>call.url==='/api/auth/logout'&&call.method==='POST'));assert.equal(modal.open,false);
 assert.equal(run('state.route'),'account');assert.equal(run('state.reader.authenticated'),false);
 assert.equal(get('#toast').textContent,'Đã đăng xuất. Hãy đăng nhập lại bằng Google, rồi xóa tài khoản trong vòng 10 phút.');
 // An account with a password still confirms with it, and sees no Google note.
 run(`state.reader={authenticated:true,user:{id:'v',name:'An',email:'an@example.test',provider:'local'}};deleteAccountDialog()`);
 assert.match(modal.innerHTML,/name="password" type="password" autocomplete="current-password" required/u);assert.doesNotMatch(modal.innerHTML,/auth-note/u);
});
