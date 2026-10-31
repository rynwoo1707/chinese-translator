import {musicMarkup,bindMusic} from './music.js';
import {renderMathText,mathStyles} from './math-text.js';
import {termMatcher,highlightTerms,bindTermPopover,hideTermPopover} from './reader-terms.js';
import {attachHanziLookup,openHanziPanel,closeHanziPanel,setHanziTheme} from './hanzi-lookup.js';
import {footerHtml} from './site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from './library-samples.js';
import {bilingualSource,mountBilingual,mountPdfPages,releaseBilingual} from './bilingual-reader.js';
import {inAppBrowser,openInBrowserHelp} from './in-app-browser.js';
import {MODES,ADMIN_DEFAULT_MODE,isMode,modeProfile} from './translation-modes.js';
if(document.head){const style=document.createElement('style');style.textContent=mathStyles;document.head.append(style);}
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',translate:'M4 5h12M10 3v2M6 5c0 6 4 9 8 11M14 5c0 6-4 9-10 11M14 21l4-10 4 10M16 17h4',book:'M3 4h6l3 2 3-2h6v15h-6l-3 2-3-2H3z M12 6v15',file:'M5 3h9l5 5v13H5z M14 3v6h5M8 13h8M8 17h6',chat:'M3 4h18v13H9l-6 4z',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',arrow:'M5 12h14M14 7l5 5-5 5',upload:'M12 16V3M7 8l5-5 5 5M4 15v6h16v-6',spark:'M12 3l3 6 6 3-6 3-3 6-3-6-6-3 6-3z',check:'M5 12l4 4L19 6',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',plus:'M12 5v14M5 12h14',headphones:'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H3z M17 12h4v9h-4z'};
Object.assign(icons,{sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',moon:'M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z',paper:'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',stop:'M6 6h12v12H6z',share:'M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6M8.6 13.5l6.8 4M15.4 6.5l-6.8 4'});
// A link that came from stored data (a request's source, a part's source) is drawn as a link only when it is a web
// address with a host, as the server now keeps it (worker.js webLink); anything else, e.g. javascript: or data:, is
// plain text.
function webLink(value){
 const text=String(value??'').trim();if(!/^https?:\/\//iu.test(text))return '';
 try{const url=new URL(text);return ['http:','https:'].includes(url.protocol)&&url.hostname?url.href:'';}catch{return '';}
}
const sourceLink=(value,label,prefix='')=>{const href=webLink(value);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:`<span class="source-text">${esc(prefix+String(value??'').trim().slice(0,300))}</span>`;};
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[n]||icons.file}"/></svg>`;
const adminArea=location.pathname==='/admin'||location.pathname.startsWith('/admin/');
// Admins sign in with a username and password (backend/admin-auth.js). The session cookie is HttpOnly and counts only on
// requests that carry this header, which the admin pages add to every API call, private cover and download: a public
// page open in the same browser never sends it, so it never gains an admin's rights.
const ADMIN_HEADER={'X-Hoa-Tri-Admin':'1'};
// What the console asks by itself (api background: new requests, a running job's row) says so: such a request never
// keeps the admin session alive, so a console left open ends 2 hours after its last use (backend/admin-auth.js).
const BACKGROUND_HEADER={'X-Hoa-Tri-Background':'1'};
// ADMIN_TOKEN is typed only to create the first admin account and to reset a forgotten admin password. The server
// refuses a token under 32 characters outside this machine, so no token typed here can do either then.
const ADMIN_TOKEN_SHORT='ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự nên chưa dùng được. Đặt lại bằng <code>npx wrangler secret put ADMIN_TOKEN</code> (64 ký tự hex) rồi tải lại trang.';
const genreDrafts={};
const adminRoutes=new Set(['translate','stories','users','review','requests','settings','glossary']);
// #dat-lai-mat-khau?token=… is a password reset link an admin or teacher created (contract 7).
const RESET_ROUTE='dat-lai-mat-khau',publicRoutes=['reader','account',RESET_ROUTE];
// The reader's address is #reader/<storyId>/<1-based part> (shareable as /?read=<storyId>&phan=<part>).
function queryValue(name){const match=new RegExp(`[?&]${name}=([^&#]*)`,'u').exec(location.search||'');try{return match?decodeURIComponent(match[1].replace(/\+/gu,' ')):null;}catch{return null;}}
function parseHash(){const raw=String(location.hash||'').slice(1),cut=raw.indexOf('?'),[route='',story='',part='']=(cut<0?raw:raw.slice(0,cut)).split('/');let storyId='';try{storyId=decodeURIComponent(story);}catch{}return {route,storyId,part:Math.max(1,Number.parseInt(part,10)||1),query:cut<0?'':raw.slice(cut+1)};}
function currentRoute(){const route=parseHash().route;return adminArea?(adminRoutes.has(route)?route:'translate'):(publicRoutes.includes(route)?route:'library');}
const prefersReducedMotion=()=>Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
// Phones and tablets show a PDF part as drawn pages: an <iframe> PDF is an empty box there.
const COMPACT_PDF='(max-width: 768px), (pointer: coarse)',compactPdf=()=>Boolean(globalThis.matchMedia?.(COMPACT_PDF).matches);
// Reading preferences only; a browser that blocks storage (private mode, site data off) must still open the library.
const savedTheme=(()=>{try{return localStorage.getItem('readerTheme');}catch{return null;}})(),savedFontSize=(()=>{try{return localStorage.getItem('readerFontSize');}catch{return null;}})();
let state={route:currentRoute(),stories:[],users:[],jobs:[],requests:[],more:{stories:null,jobs:null},jobDetails:{},storyDetails:{},userBooks:{},library:[],myLibrary:[],myRequests:[],studyBooks:[],reader:{authenticated:false},status:{},file:null,pdfAnalysis:null,tab:'file',selected:null,reviewStory:null,showReviewQueue:false,chapters:[],chapter:0,theme:['paper','light','night'].includes(savedTheme)?savedTheme:'paper',fontSize:Math.max(16,Math.min(30,Number(savedFontSize)||19))};let poll=null,busy=false;
const OFFLINE='Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.';
// Covers of private books in the admin console (coverArt, showAdminCovers): "<id>:<cover_key>" -> object URL ('' when
// it could not be loaded, null while it loads), for the view they were made in; revoked when the admin opens another
// view or signs out.
const BLANK_IMAGE='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',adminCovers=new Map();let adminCoverView='';
// The server's own error text is shown as is; status, code and retryAfter ride along for the callers that react to them.
// onResponse sees the response itself (a paged admin list reads its X-Next-Offset header there). An admin page whose
// session has ended (code admin_signed_out) goes back to the sign-in form (adminSessionEnded).
async function api(path,{onResponse=null,background=false,...options}={}){
 const headers={...(adminArea?ADMIN_HEADER:{}),...(adminArea&&background?BACKGROUND_HEADER:{})};if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const failed=(message,status,data=null)=>Object.assign(new Error(message),{status,code:data?.code||'',retryAfter:data?.retryAfter??null});
 const r=await fetch('/api'+path,{...options,headers:{...headers,...options.headers}}).catch(()=>{throw failed(OFFLINE,0);});
 onResponse?.(r);
 if(r.status===204)return null;
 const d=await r.json().catch(()=>null);
 // A page instead of JSON usually means the server is restarting or being updated, not that the request was wrong.
 if(!d||typeof d!=='object')throw failed(`Máy chủ trả về phản hồi không đọc được (mã ${r.status}). Có thể máy chủ đang cập nhật; hãy thử lại sau vài giây.`,r.status);
 if(!r.ok){if(adminArea&&r.status===401&&d.code==='admin_signed_out')adminSessionEnded();throw failed(d.error||'Kết nối thất bại.',r.status,d);}
 return d;
}
// The toast region stays rendered while idle (only visually hidden), so screen readers already know it as a live region
// when its first message arrives.
{const box=document.querySelector?.('#toast');box?.setAttribute?.('aria-live','polite');box?.setAttribute?.('aria-atomic','true');}
// Menus (details.menu: “Tải về”, the ⋯ of a row): one open at a time; a press outside it, Escape, Tab out of it or a
// choice closes it. A choice first gives the focus to the menu's button, so a dialog it opens hands the focus back there;
// Escape does too. Only a focus that lands outside counts as leaving: Safari focuses nothing when an item is clicked, and
// that click must still reach the item.
function closeMenus(except=null){for(const menu of document.querySelectorAll?.('details.menu[open]')||[])if(menu!==except)menu.open=false;}
function bindMenus(){
 if(!document.addEventListener)return;
 // A list that would run past the screen's left edge (a ⋯ near the left of a phone row) opens to the right instead.
 document.addEventListener('toggle',event=>{const menu=event.target;if(!menu?.matches?.('details.menu')||!menu.open)return;closeMenus(menu);menu.classList.remove('menu-start');const list=menu.querySelector('.menu-list'),box=list?.getBoundingClientRect?.();if(box&&box.left<8)menu.classList.add('menu-start');},true);
 document.addEventListener('pointerdown',event=>closeMenus(event.target?.closest?.('details.menu')||null),true);
 document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=event.target?.closest?.('details.menu[open]');if(!menu)return;event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary')?.focus();},true);
 document.addEventListener('click',event=>{const item=event.target?.closest?.('.menu-list button,.menu-list a'),menu=item?.closest('details.menu');if(!menu||item.disabled)return;menu.querySelector('summary')?.focus();menu.open=false;},true);
 document.addEventListener('focusout',event=>{const menu=event.target?.closest?.('details.menu[open]');if(menu&&event.relatedTarget&&!menu.contains(event.relatedTarget))menu.open=false;},true);
}
bindMenus();
function toast(message){const box=$('#toast');box.textContent=message;box.className='is-visible';clearTimeout(toast.timer);toast.timer=setTimeout(()=>{box.className='';box.textContent='';},5500);}
// A password reset link is read once: the address bar and its history entry keep just #dat-lai-mat-khau, so a reload, a
// shared screen or a screenshot does not leak the token. The link is first only checked (POST /check uses nothing up),
// because chat and mail apps open links to scan them: it is traded for a fresh token that lives in this page only
// (openResetLink) when the student presses "Tiếp tục". The browser's own history (Ctrl+H) still records the address that
// was opened, which stops working once traded.
function takeResetToken(){
 const {route,query}=parseHash();if(adminArea||route!==RESET_ROUTE)return false;
 const match=/(?:^|&)token=([^&]*)/u.exec(query);let found='';try{found=match?decodeURIComponent(match[1]):'';}catch{}
 if(query)setUrl(RESET_ROUTE,true);if(!found)return false;
 state.resetToken=null;state.resetFailed=null;checkResetLink(found);return true;
}
async function checkResetLink(token){
 const checking=state.resetOpening={};state.resetLink=null;
 try{const answer=await api('/auth/password-reset/check',{method:'POST',body:{token}});if(state.resetOpening!==checking)return;state.resetLink={token,expiresAt:String(answer?.expiresAt||'')};state.resetFailed=null;}
 catch(error){if(state.resetOpening!==checking)return;state.resetLink=null;state.resetFailed=error.message;}
 state.resetOpening=null;if(state.loaded&&state.route===RESET_ROUTE)render();
}
// The server answers with a token good for 30 minutes at most; the opened link no longer works, so a page closed before
// the new password is saved needs a new link (the page says so).
async function openResetLink(){
 const link=state.resetLink;if(!link||state.resetOpening)return;
 const opening=state.resetOpening={};render();
 try{const answer=await api('/auth/password-reset/open',{method:'POST',body:{token:link.token}});if(state.resetOpening!==opening)return;if(typeof answer?.token!=='string')throw new Error('Máy chủ chưa mở được liên kết này. Hãy thử lại sau ít phút.');state.resetToken=answer.token;state.resetFailed=null;}
 catch(error){if(state.resetOpening!==opening)return;state.resetToken=null;state.resetFailed=error.message;}
 state.resetLink=null;state.resetOpening=null;state.focusAfterRender='heading';if(state.route===RESET_ROUTE)render();
}
// The request a signed-out student started waits in this tab (sessionStorage) while they sign in, also through the
// Google round trip (return_to=/#yeu-cau): title, link, notes and sharing choice (a chosen file cannot be kept). It is
// removed as soon as the dialog opens again, or when the student leaves the sign-in page.
const REQUEST_DRAFT='hoa-tri-request-draft';
function keepRequestDraft(draft={}){state.pendingRequest=true;try{sessionStorage.setItem(REQUEST_DRAFT,JSON.stringify(draft));}catch{}}
function takeRequestDraft(){let draft=null;try{const kept=sessionStorage.getItem(REQUEST_DRAFT);sessionStorage.removeItem(REQUEST_DRAFT);draft=JSON.parse(kept||'null');}catch{}state.pendingRequest=false;return draft&&typeof draft==='object'?draft:{};}
function dropRequestDraft(){state.pendingRequest=false;try{sessionStorage.removeItem(REQUEST_DRAFT);}catch{}}
const requestDraftKept=()=>{try{return sessionStorage.getItem(REQUEST_DRAFT)!==null;}catch{return false;}};
const requestDraftHasText=()=>{try{const draft=JSON.parse(sessionStorage.getItem(REQUEST_DRAFT)||'null');return Boolean(draft&&['title','source_url','notes'].some(field=>String(draft[field]||'').trim()));}catch{return false;}};
// #account?sau=xuong-dich (the study page's sign-in card) or #account?sau=reader/<id>/<part> (a private book that needs a
// session): after signing in, also through Google, the student goes back there. Any other value is ignored.
// #account?loi=<code>: a Google sign-in that could not finish (the server never answers that navigation with a bare
// error); the sign-in page says why, in the words of GOOGLE_FAILURES.
function takeAfterSignIn(){
 const {route,query}=parseHash();if(adminArea||route!=='account'||!query)return;
 const value=/(?:^|&)sau=([^&]*)/u.exec(query)?.[1]||'',failure=/(?:^|&)loi=([a-z_]{1,40})(?:&|$)/u.exec(query)?.[1]||'';
 state.afterSignIn=value==='xuong-dich'?'/study':/^reader\/[A-Za-z0-9._%-]{1,200}\/\d{1,4}$/u.test(value)?`/#${value}`:'';
 if(failure){state.googleFailure=failure;state.focusAfterRender='heading';}
 setUrl('account',true);
}
const GOOGLE_FAILURES={google_cancelled:'Bạn đã hủy đăng nhập bằng Google. Bấm “Tiếp tục bằng Google” để thử lại.',google_error:'Google chưa hoàn tất đăng nhập. Hãy thử lại.',google_state:'Lần đăng nhập Google đã hết hạn. Bấm “Tiếp tục bằng Google” lại.',google_failed:'Chưa xác nhận được đăng nhập với Google. Hãy thử lại sau ít phút.',google_unverified:'Tài khoản Google này chưa xác minh email. Hãy dùng tài khoản Google khác.',google_email_invalid:'Email của tài khoản Google không hợp lệ. Hãy dùng tài khoản Google khác.',google_email_has_password:'Email này đã có tài khoản Hoa Trí dùng mật khẩu. Hãy đăng nhập bằng mật khẩu đó; nếu quên, mở “Quên mật khẩu?” bên dưới.',account_disabled:'Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên.',registration_closed:'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.',google_not_configured:'Máy chủ chưa bật đăng nhập Google. Hãy đăng nhập bằng email và mật khẩu.',terms_required:'Hãy đánh dấu ô đồng ý rồi bấm “Tiếp tục bằng Google” lại.',server_error:'Máy chủ gặp lỗi khi đăng nhập bằng Google. Hãy thử lại sau ít phút.'};
// The two refusals of domain mode name the school's domains (/api/me registration.domains).
function googleFailureText(code){
 const domains=(Array.isArray(state.reader.registration?.domains)?state.reader.registration.domains:[]).join(' hoặc ');
 if(code==='registration_domain')return domains?`Chỉ email thuộc ${domains} được tạo tài khoản. Hãy chọn đúng tài khoản Google của trường.`:'Email của tài khoản Google này không thuộc trường được phép tạo tài khoản.';
 if(code==='registration_workspace')return domains?`Chỉ tài khoản Google do ${domains} quản lý được tạo tài khoản. Hãy chọn đúng tài khoản Google của trường.`:'Tài khoản Google này không do trường quản lý nên chưa tạo được tài khoản.';
 return GOOGLE_FAILURES[code]||'Chưa đăng nhập được bằng Google. Hãy thử lại.';
}
// Leaving the account page drops what only made sense there: the waiting request, where to go back, a confirmation,
// a failed Google sign-in.
function leftAccount(){dropRequestDraft();state.accountNotice=null;state.afterSignIn='';state.googleFailure=null;}
if(!adminArea){takeResetToken();takeAfterSignIn();if(['account','yeu-cau'].includes(parseHash().route))state.pendingRequest=requestDraftKept();else dropRequestDraft();}
// Admin lists come in pages of light rows (GET /api/stories, /api/jobs, /api/user-library: limit, offset, and the
// X-Next-Offset header while more rows follow): a reload keeps as many rows as were shown, up to 500. A job's text and
// warnings and a student's book glossary come from their own routes (loadJobDetail, loadStoryDetail), a student's books
// when the admin opens them (loadUserBooks).
const PAGE=100,PAGE_MAX=500;
async function apiPage(path){
 let next=null;const rows=await api(path,{onResponse:response=>{next=response.headers?.get?.('X-Next-Offset')??null;}});
 return {rows:Array.isArray(rows)?rows:[],next:next!==null&&/^\d+$/u.test(next)?Number(next):null};
}
const shown=name=>Math.min(PAGE_MAX,Math.max(PAGE,state[name]?.length||0));
async function refresh(){if(adminArea){state.status=await api('/status');if(state.status.authenticated){
 const [stories,jobs,requests,users]=await Promise.all([apiPage(`/stories?limit=${shown('stories')}`),apiPage(`/jobs?limit=${shown('jobs')}`),api('/requests'),api('/users')]);
 state.stories=stories.rows;state.more.stories=stories.next;state.jobs=jobs.rows;state.more.jobs=jobs.next;state.requests=Array.isArray(requests)?requests:[];state.users=Array.isArray(users)?users:[];
 state.jobDetails={};state.storyDetails={};for(const id of Object.keys(state.userBooks))loadUserBooks(id,{again:true});
 requestsCheckedAt=Date.now();watchRequests();
}else{state.stories=[];state.jobs=[];state.requests=[];state.users=[];state.more={stories:null,jobs:null};state.jobDetails={};state.storyDetails={};state.userBooks={};}}else{
 // Each part fails on its own: a library that did not load shows an error card (state.errors), never an empty shelf.
 // The personal lists are asked for only with a session (no 401 for a signed-out visitor): together with /api/me when
 // this page already knew one, else as soon as /api/me confirms it.
 // The parts of the student's books (GET /api/my/study/books) only add the "Bố cục cũ" notes: failing, they add nothing.
 const personal=()=>Promise.allSettled([api('/my/library'),api('/my/requests'),api('/my/study/books')]),early=state.reader?.authenticated?personal():null;
 const [library,me]=await Promise.allSettled([api('/library'),api('/me')]);const errors={};
 if(library.status==='fulfilled')state.library=Array.isArray(library.value)?library.value:[];else errors.library=library.reason;
 if(me.status==='fulfilled')state.reader=me.value||{authenticated:false};else errors.me=me.reason;
 const [mine,requests,books]=state.reader.authenticated?await (early||personal()):[];
 const own=(result,name)=>{if(!result)return [];if(result.status==='fulfilled')return Array.isArray(result.value)?result.value:[];errors[name]=result.reason;return [];};
 // A local database behind the code (schema_outdated) is said, with how to mend it (start.cmd), rather than the notes
 // simply missing.
 if(books?.status==='rejected'&&books.reason?.code==='schema_outdated')errors.studyBooks=books.reason;
 state.myLibrary=own(mine,'myLibrary');state.myRequests=own(requests,'myRequests');state.studyBooks=books?.status==='fulfilled'&&Array.isArray(books.value)?books.value:[];state.errors=errors;
}}
// Public pages keep "/" for the library and #reader/<storyId>/<part> for an open book; replace is for a part change.
function setUrl(hash,replace=false){if(adminArea||!globalThis.history?.pushState){location.hash=hash;return;}const url=location.pathname+(hash?'#'+hash:'');if(url===location.pathname+location.search+location.hash)return;history[replace?'replaceState':'pushState'](null,'',url);}
const readerHash=()=>state.readerStory?.id?`reader/${encodeURIComponent(state.readerStory.id)}/${state.chapter+1}`:'reader';
function go(route,{replace=false}={}){globalThis.speechSynthesis?.cancel();state.speaking=false;if(adminArea&&!adminRoutes.has(route)){location.href='/#'+route;return;}const from=state.route;state.route=adminArea?(adminRoutes.has(route)?route:'translate'):(publicRoutes.includes(route)?route:'library');if(adminArea)location.hash=state.route;else{if(state.route!=='account')leftAccount();setUrl(state.route==='reader'?readerHash():state.route==='library'?'':state.route,replace);}if(from!==state.route||state.route==='reader')state.focusAfterRender=state.route==='library'&&from==='reader'?'book':'heading';render();}
const nav=[['translate','translate','Xưởng dịch'],['stories','book','Kho tài liệu'],['users','grid','Học sinh'],['review','file','Đối chiếu'],['requests','chat','Yêu cầu dịch'],['glossary','book','Thuật ngữ']];
// Translation requests waiting for the admin (status pending) show as a count on the "Yêu cầu dịch" button, also on
// phones, and in the tab's title, so they are not left unseen while the console stays open: the list is asked for again
// every 5 minutes and when the admin comes back to the tab (at most once a minute), and only the count and the title
// are redrawn then, never a form being edited.
const pendingRequests=()=>state.requests.filter(request=>request.status==='pending').length;
const requestBadge=()=>{const count=pendingRequests();return count?`<span class="count" aria-hidden="true">${count}</span><span class="visually-hidden"> (${count} yêu cầu mới)</span>`:'';};
const navButton=([route,name,label])=>`${icon(name)}${label}${route==='requests'?requestBadge():''}`;
const adminTitle=()=>`${pendingRequests()?`(${pendingRequests()}) `:''}Hoa Trí — Quản trị`;
// The checks are background requests: they never keep the admin session alive (2 hours idle on the server), so a console
// left open on a shared computer still signs out, and the next check then brings back the sign-in form (api).
const REQUEST_CHECK_MS=5*60*1000;let requestsCheckedAt=0,watchingRequests=false;
async function checkRequests(){
 if(!adminArea||!state.status.authenticated||Date.now()-requestsCheckedAt<60*1000)return;requestsCheckedAt=Date.now();
 const rows=await api('/requests',{background:true}).catch(()=>null);if(!Array.isArray(rows)||!state.status.authenticated)return;
 state.requests=rows;showRequestCount();
}
function showRequestCount(){document.title=adminTitle();const button=document.querySelector?.('.sidebar [data-route="requests"]');if(button)button.innerHTML=navButton(nav.find(([route])=>route==='requests'));}
function watchRequests(){
 if(watchingRequests)return;watchingRequests=true;
 const tick=()=>{checkRequests().finally(()=>globalThis.setTimeout?.(tick,REQUEST_CHECK_MS));};globalThis.setTimeout?.(tick,REQUEST_CHECK_MS);
 document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible')checkRequests();});window.addEventListener?.('focus',()=>checkRequests());
}
// Entrance motion when the page changes or its data first arrives, not on every re-render (theme, font size, filters).
let lastPublicView=null;
// The admin sign-in card on screen (its markup), null while the console is: render() draws the card again only when it
// changes (another form, a note, the server's answer), so a late answer to a request made while signed in (a job's text,
// a long translation step, the address changed by "Đăng xuất") neither moves the focus nor wipes what is being typed.
let shownAuth=null;
function pageTitle(){
 if(state.route==='reader'){const chapter=state.chapters[state.chapter];return chapter?`Phần ${state.chapter+1} · ${state.readerStory?.title||chapter.title} — Hoa Trí`:state.readerError?'Không mở được tài liệu — Hoa Trí':'Đang mở tài liệu — Hoa Trí';}
 return state.route==='account'?'Tài khoản — Hoa Trí':state.route===RESET_ROUTE?'Đặt lại mật khẩu — Hoa Trí':'Hoa Trí — Dịch tiếng Trung sang tiếng Việt, giữ bố cục trang';
}
// A re-render replaces every control, so the one that had the focus (a theme button, a filter, a tab) gets it back;
// after a route or part change the focus goes to the new page's heading, or back to the book's cover in the library.
const FOCUS_KEYS=['data-reader-theme','data-library-genre','data-route','data-auth-tab','data-retry'];
function focusKey(element){
 if(!element?.getAttribute||element===document.body)return '';if(element.id)return `[id="${element.id.replace(/["\\]/g,'\\$&')}"]`;
 const name=FOCUS_KEYS.find(item=>element.hasAttribute(item));return name?`[${name}="${String(element.getAttribute(name)).replace(/["\\]/g,'\\$&')}"]`:'';
}
function restoreFocus(key){
 const target=state.focusAfterRender;state.focusAfterRender=null;let element=null;
 if(target==='book')element=state.readerStory?.id&&document.querySelector?.(`[data-read-cover="${String(state.readerStory.id).replace(/["\\]/g,'\\$&')}"]`);
 // A page that opens with a message to read first (the account page after a password reset) marks it data-focus-first.
 if(target&&!element){element=document.querySelector?.('.public-content [data-focus-first]')||document.querySelector?.('.public-content h1');element?.setAttribute('tabindex','-1');}
 if(!target&&key){element=document.querySelector?.(key);if(element?.disabled)element=null;}
 // A part reopened at its saved place (restorePlace) keeps the focus on its heading without scrolling up to it.
 element?.focus?.({preventScroll:!target||Boolean(state.placePending)});
}
function render(){
 if(!adminArea){const key=focusKey(document.activeElement);document.title=pageTitle();document.documentElement?.classList?.toggle('is-reading',state.route==='reader');document.documentElement?.classList?.toggle('is-home',state.route==='library');document.documentElement?.classList?.add('is-public');$('#app').innerHTML=publicLayout();const view=`${state.route}:${Boolean(state.loaded)}`;if(view!==lastPublicView){if(state.route!=='reader')$('.public-content')?.classList.add('route-enter');lastPublicView=view;}bind();decorateReader();restoreFocus(key);restorePlace();if(state.pendingRequest&&state.reader.authenticated&&state.route==='account'){state.pendingRequest=false;requestStory();}return;}
 document.title=adminTitle();
 if(!state.status.authenticated){const html=loginView();if(html!==shownAuth){$('#app').innerHTML=html;shownAuth=html;bind();}focusAdminAuth();return;}
 shownAuth=null;
 if(state.route==='review'&&state.selected&&!jobDetail(state.selected))loadJobDetail(state.selected);
 if(state.route==='glossary'&&state.glossaryId&&glossaryOf(state.glossaryId)===null)loadStoryDetail(state.glossaryId);
 if(state.route==='settings'&&!state.admins)loadAdmins();
 const admin=adminIdentity(),noKey=state.status.aiConfigured?'':'<p class="side-key"><span class="dot" aria-hidden="true"></span>Chưa có khóa Gemini · <a href="#settings">Cài đặt</a></p>';
 $('#app').innerHTML=`<div class="shell"><aside class="sidebar"><a class="brand" href="#translate"><img src="/favicon.svg" alt=""><div><strong>Hoa Trí<span class="brand-dot">.</span></strong></div></a><nav class="nav" aria-label="Quản lý nội dung">${nav.map(([r,i,t])=>`<button data-route="${r}" class="${state.route===r?'active':''}" ${state.route===r?'aria-current="page"':''}>${navButton([r,i,t])}</button>`).join('')}</nav><div class="side-bottom">${noKey}<nav class="nav" aria-label="Hệ thống"><a class="side-library" href="/" target="_blank" rel="noopener">Mở thư viện ↗</a><button data-route="settings" class="${state.route==='settings'?'active':''}" ${state.route==='settings'?'aria-current="page"':''}>${icon('settings')}Cài đặt</button><button id="admin-logout">${icon('arrow')}Đăng xuất</button></nav><div class="profile"><span class="avatar" aria-hidden="true">${esc(admin.initials)}</span><div><span class="profile-name">${esc(admin.name)}</span>${admin.username?`<small>${esc(admin.username)}</small>`:''}</div></div></div></aside><main class="main"><div class="content">${view()}</div></main></div>`;bind();showAdminCovers();restoreAdminDrafts();}
// Who is signed in (GET /api/status admin): the display name, else the username.
function adminIdentity(){const admin=state.status.admin||{},username=String(admin.username||''),name=String(admin.name||'').trim()||username;return {name:name||'Không gian biên tập',username,initials:name?avatarOf({name}).initials:'HT'};}
// Tap-to-see-Chinese for glossary terms; applied after each render because render() rebuilds the reader DOM.
// Placeholder cards while the first library request is in flight, instead of a misleading "empty library".
function skeletonCards(count){return `<div class="skeleton-grid" role="status" aria-label="Đang tải thư viện">${Array.from({length:count},()=>'<div class="skeleton-card" aria-hidden="true"><span class="skeleton skeleton-cover"></span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span></div>').join('')}</div>`;}
function decorateReader(){hideTermPopover();if(state.route!=='reader'){closeHanziPanel();closeBilingual(true);markChinese(document.querySelector?.('.public-content'));return;}closeHanziPanel({ifDetached:true});setHanziTheme(state.theme);syncBilingual();const prose=document.querySelector('.reader .prose');if(prose)attachHanziLookup(prose);if(prose&&state.readerTerms){highlightTerms(prose,state.readerTerms);bindTermPopover(prose);const popover=document.querySelector('#term-popover');if(popover)attachHanziLookup(popover,{selector:'.term-popover-zh',onOpen:hideTermPopover});}markChinese(prose);}
// Chinese runs in the Vietnamese reading text get lang="zh", so screen readers and fonts treat them as Chinese.
const HAN_RUN=/\p{Script=Han}[\p{Script=Han}　-〿！-｠]*/gu;
// The test is not global: a global regex's test() moves lastIndex, and matchAll(HAN_RUN) would start from there.
const HAS_HAN=/\p{Script=Han}/u;
function markChinese(root){
 if(!root?.ownerDocument?.createTreeWalker)return;const doc=root.ownerDocument,walker=doc.createTreeWalker(root,4),nodes=[];
 for(let node=walker.nextNode();node;node=walker.nextNode()){if(HAS_HAN.test(node.nodeValue)&&!node.parentElement?.closest('[lang^="zh"],button,svg,code,textarea,option,script,style,[class^="math-"],[class*=" math-"]'))nodes.push(node);}
 for(const node of nodes){
  const text=node.nodeValue,fragment=doc.createDocumentFragment();let last=0;
  for(const match of text.matchAll(HAN_RUN)){if(match.index>last)fragment.append(text.slice(last,match.index));const span=doc.createElement('span');span.lang='zh';span.textContent=match[0];fragment.append(span);last=match.index+match[0].length;}
  if(last<text.length)fragment.append(text.slice(last));node.replaceWith(fragment);
 }
}
// Where the reader is in the open part, kept for this tab (sessionStorage) so a reload, or a phone that discarded the
// tab, opens the part at the same place: the character at the top of the screen for a text part (so a new font size or
// screen width does not move it), the page and how far into it for drawn PDF pages. Saved when scrolling stops and when
// the tab is hidden; used once, when the address opens that same part again (openStory with restore).
const READER_PLACE='hoa-tri-reader-place';
const readPlace=()=>{try{const place=JSON.parse(sessionStorage.getItem(READER_PLACE)||'null');return place&&typeof place==='object'?place:null;}catch{return null;}};
// The top of what the reader sees: under the header where it stays on screen (sticky), the screen's top on a phone,
// where it scrolls away with the page while reading.
const visibleTop=()=>{const masthead=document.querySelector('.site-masthead');return (masthead&&['sticky','fixed'].includes(getComputedStyle(masthead).position)?masthead.getBoundingClientRect().height:0)+8;};
function textOffsetAt(prose,y){
 const box=prose.getBoundingClientRect(),x=Math.min(box.right-2,Math.max(box.left+2,box.left+24));let node=null,offset=0;
 const caret=document.caretPositionFromPoint?.(x,y);if(caret){node=caret.offsetNode;offset=caret.offset;}else{const range=document.caretRangeFromPoint?.(x,y);if(range){node=range.startContainer;offset=range.startOffset;}}
 if(!node||!prose.contains(node))return null;
 const range=document.createRange();range.setStart(prose,0);range.setEnd(node,offset);return range.toString().length;
}
function currentPlace(){
 const story=state.readerStory?.id,chapter=state.chapters[state.chapter];if(state.route!=='reader'||!story||!chapter)return null;
 const base={story,part:state.chapter+1},top=visibleTop(),prose=document.querySelector('.reader .prose');
 if(prose){const box=prose.getBoundingClientRect();if(box.top>=top)return {...base,offset:0};const offset=textOffsetAt(prose,top);return {...base,offset:offset??0,ratio:(top-box.top)/Math.max(1,box.height)};}
 const pages=[...document.querySelectorAll('.pdf-pages-page')],page=pages.find(item=>item.getBoundingClientRect().bottom>top);
 if(page){const box=page.getBoundingClientRect();return {...base,page:Number(page.dataset.page)||1,within:Math.max(0,Math.min(1,(top-box.top)/Math.max(1,box.height)))};}
 return null;
}
function savePlace(){const place=currentPlace();if(place)try{sessionStorage.setItem(READER_PLACE,JSON.stringify(place));}catch{}}
// While a saved place waits to be scrolled to (at most 10 seconds), the page's own scrolling saves nothing over it.
const placeWaiting=()=>{if(state.placePending&&Date.now()<state.placePending.until)return true;state.placePending=null;return false;};
let placeTimer=0;
window.addEventListener('scroll',()=>{if(state.route!=='reader'||placeWaiting())return;clearTimeout(placeTimer);placeTimer=setTimeout(savePlace,300);},{passive:true});
window.addEventListener('pagehide',()=>{if(state.route==='reader'&&!placeWaiting())savePlace();});
document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='hidden'&&state.route==='reader'&&!placeWaiting())savePlace();});
// The part an address opened (openStory with restore) goes back to its saved place once drawn: a text part here, drawn
// PDF pages once mountPdfPages has laid them out (placePdfPages).
function restorePlace(){
 const place=state.placePending;if(!place||state.route!=='reader'||!state.chapters[state.chapter])return;
 if(place.story!==state.readerStory?.id||place.part!==state.chapter+1){state.placePending=null;return;}
 const prose=document.querySelector('.reader .prose');if(!prose){if(!document.querySelector('#pdf-pages-root'))state.placePending=null;return;}
 state.placePending=null;scrollToText(prose,place);
 // Web fonts that arrive later change the line heights (and the browser's scroll anchoring then keeps the top of the
 // part, not the character): for a few seconds the same character is found again, until the reader scrolls.
 let moved=false;const stop=()=>{moved=true;},events=['wheel','touchstart','keydown','pointerdown'];
 const again=()=>{if(!moved&&state.route==='reader'&&document.querySelector('.reader .prose')===prose)scrollToText(prose,place);};
 for(const type of events)window.addEventListener(type,stop,{passive:true,once:true});
 document.fonts?.addEventListener?.('loadingdone',again);document.fonts?.ready?.then(again);
 for(const wait of [100,300,700,1500,2500])setTimeout(again,wait);
 setTimeout(()=>{document.fonts?.removeEventListener?.('loadingdone',again);for(const type of events)window.removeEventListener(type,stop);},3000);
}
function scrollToText(prose,{offset=0,ratio=0}){
 let target=null;
 // The character itself is measured: a caret between two line breaks (an empty line) has no box at all.
 if(offset>0){
  const walker=document.createTreeWalker(prose,4);let left=offset,found=null,tail=null;
  for(let node=walker.nextNode();node;node=walker.nextNode()){const length=node.nodeValue.length;if(!length)continue;tail=node;if(left<length){found=node;break;}left-=length;}
  if(!found&&tail){found=tail;left=tail.nodeValue.length-1;}
  if(found){const range=document.createRange();range.setStart(found,left);range.setEnd(found,left+1);const box=range.getBoundingClientRect();if(box.top||box.bottom)target=box.top;}
 }
 if(target===null&&ratio>0){const box=prose.getBoundingClientRect();target=box.top+ratio*box.height;}
 if(target!==null)globalThis.scrollTo?.({top:Math.max(0,globalThis.scrollY+target-visibleTop()),behavior:'auto'});
 return globalThis.scrollY;
}
function placePdfPages(root){
 const place=state.placePending;if(!place||!place.page||state.route!=='reader'||place.story!==state.readerStory?.id||place.part!==state.chapter+1)return;
 state.placePending=null;const page=root.querySelector(`.pdf-pages-page[data-page="${Number(place.page)}"]`);if(!page)return;
 const box=page.getBoundingClientRect();globalThis.scrollTo?.({top:Math.max(0,globalThis.scrollY+box.top+box.height*(Number(place.within)||0)-visibleTop()),behavior:'auto'});
}
// The page colour changes in place: rebuilding the reader would redraw a long chapter (about a second for 500,000
// characters) and reload an open PDF.
function setReaderTheme(theme){
 state.theme=['paper','light','night'].includes(theme)?theme:'paper';try{localStorage.setItem('readerTheme',state.theme);}catch{}
 const article=$('.reader');if(article){article.classList.remove('paper','light','night');article.classList.add(state.theme);}
 document.querySelectorAll('[data-reader-theme]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.readerTheme===state.theme)));setHanziTheme(state.theme);
}
// A new part starts at its heading (the page above it is the toolbar the student just used), with the options closed.
function showChapter(index,{keepFocus=false}={}){
 globalThis.speechSynthesis?.cancel();state.speaking=false;state.chapter=Math.max(0,Math.min(state.chapters.length-1,index));state.readerMore=false;setUrl(readerHash(),true);
 if(!keepFocus)state.focusAfterRender='heading';render();
 const article=document.querySelector?.('.reader-layout .reader');if(article?.scrollIntoView)article.scrollIntoView({block:'start',behavior:prefersReducedMotion()?'auto':'smooth'});else globalThis.scrollTo?.({top:0});
}
async function shareReader(){
 const story=state.readerStory;if(!story?.id)return;const url=`${location.origin}/?read=${encodeURIComponent(story.id)}&phan=${state.chapter+1}`,title=pageTitle();
 if(typeof navigator.share==='function'&&(navigator.canShare?.({title,url})??true))try{await navigator.share({title,url});return;}catch(error){if(error?.name==='AbortError')return;}
 try{await navigator.clipboard.writeText(url);}catch{throw new Error(`Không sao chép tự động được. Hãy sao chép liên kết này: ${url}`);}
 const button=$('#reader-share'),label=button?.querySelector('span');if(label){label.textContent='Đã sao chép';clearTimeout(shareReader.timer);shareReader.timer=setTimeout(()=>{if(label.isConnected)label.textContent='Chia sẻ';},2500);}
 const said=$('#reader-share-status');if(said){said.textContent='';said.textContent='Đã sao chép liên kết.';}
}
// "Đọc song ngữ" for the open PDF part. The book's assembly says which original page each translated page comes from;
// it is loaded once per open book, only when a PDF part is shown, and the toggle appears only when both sides exist.
let bilingualView=null,pagesView=null;
function readerAssembly(){
 const story=state.readerStory;if(!story?.id||!state.chapters[state.chapter]||state.chapters[state.chapter].mime!=='application/pdf')return null;
 if(state.readerAssembly?.storyId===story.id)return state.readerAssembly;
 const entry={storyId:story.id,data:null,done:false};state.readerAssembly=entry;
 // A public book whose library row says it has no page-mapped part has nothing to look up.
 if(!story.study&&story.mappedParts===0){entry.done=true;return entry;}
 // A local database behind the code (schema_outdated) is kept to be said beside the PDF; other failures leave the part
 // without its bilingual view, as before.
 api(story.study?`/my/study/books/${encodeURIComponent(story.id)}/assembly`:`/library/${encodeURIComponent(story.id)}/assembly`).then(data=>{entry.data=data;},error=>{if(error?.code==='schema_outdated')entry.error=error;}).finally(()=>{entry.done=true;if(state.readerAssembly===entry)assemblyLoaded();});
 return entry;
}
function bilingualFor(chapter){const assembly=readerAssembly();return assembly?.data&&chapter?bilingualSource(assembly.data,chapter.id):null;}
// One row above a PDF part: "Bản dịch | Song ngữ" (only when the original page exists) and the "Tải về" menu: the whole
// book, this part, the original. The menu is drawn with the toggle, so it follows the book's assembly when that loads.
function pdfTools(chapter){
 const source=bilingualFor(chapter),failed=state.readerAssembly?.error,story=state.readerStory||{},whole=wholeBookPdf(),busy=Boolean(state.bookDownload?.busy);
 const mode=source?`<div class="segmented reading-mode" role="group" aria-label="Cách đọc"><button type="button" id="translation-only" aria-pressed="${!state.bilingual}">Bản dịch</button><button type="button" class="bilingual-toggle" id="bilingual-toggle" aria-pressed="${Boolean(state.bilingual)}">Song ngữ</button></div>`:'';
 const items=[whole?`<button type="button" id="download-whole-book" ${busy?'disabled':''}>Cả quyển (PDF)${story.study||story.assembly?'<small>kèm bìa và trang chưa dịch</small>':''}</button>`:'',`<a id="download-part" href="/api/chapter-file/${encodeURIComponent(chapter.id)}" download="${esc(bookFilename(chapter.title))}">Phần này (PDF)</a>`,source?`<a href="${esc(source.url)}#page=${source.pages[0]}" target="_blank" rel="noopener">PDF gốc ↗</a>`:''].join('');
 return `${mode}<details class="menu reader-download"><summary>Tải về <span aria-hidden="true">▾</span></summary><div class="menu-list">${items}</div></details>${failed?`<p class="status bilingual-toggle-hint" data-tone="error" role="status">${esc(failed.message)}</p>`:''}`;
}
const pdfMode=chapter=>state.bilingual&&bilingualFor(chapter)?'bilingual':compactPdf()?'pages':'frame';
function pdfFrame(chapter){return {bilingual:'<div class="bilingual-root" id="bilingual-root"></div>',pages:'<div class="pdf-pages-root" id="pdf-pages-root"></div>'}[pdfMode(chapter)]||`<iframe class="reader-pdf" title="${esc(chapter.title)}" src="/api/chapter-file/${encodeURIComponent(chapter.id)}"></iframe>`;}
// Only the PDF row and area are redrawn, so the reader keeps its place and the focus stays on the pressed button.
function renderPdfArea(){
 const chapter=state.chapters[state.chapter],tools=$('#reader-pdf-tools'),area=$('#reader-pdf-area');if(!tools||!area||chapter?.mime!=='application/pdf')return;
 const focused=['bilingual-toggle','translation-only'].includes(document.activeElement?.id)?document.activeElement.id:'';tools.innerHTML=pdfTools(chapter);
 const wanted=pdfMode(chapter),shown=area.querySelector('#bilingual-root')?'bilingual':area.querySelector('#pdf-pages-root')?'pages':'frame';
 if(wanted!==shown){closeBilingual();area.innerHTML=pdfFrame(chapter);}
 bindPdfTools();if(focused)$(`#${focused}`)?.focus();syncBilingual();
}
function toggleBilingual(){state.bilingual=!state.bilingual;renderPdfArea();}
// "Bản dịch" shows the Vietnamese PDF alone; "Song ngữ" switches the original page in beside it (pressed again: off).
function bindPdfTools(){
 on('#bilingual-toggle','click',toggleBilingual);on('#translation-only','click',()=>{if(state.bilingual)toggleBilingual();});
 on('#download-whole-book','click',()=>{const app=inAppBrowser();if(app){leaveInApp(app,{purpose:'download',go:()=>downloadWholeBook()});return;}return downloadWholeBook();});
}
function assemblyLoaded(){
 if(state.route!=='reader')return;const story=state.readerStory,data=state.readerAssembly?.data;
 // A public book with page-mapped parts is rebuilt like its original by "Tải cả quyển", as a student's own book is.
 if(story&&!story.study&&!story.assembly&&Array.isArray(data?.parts)&&data.parts.some(part=>bilingualSource(data,part.id))){story.assembly=true;renderBookDownloadSlot();}
 renderPdfArea();
}
function syncBilingual(){
 const pages=$('#pdf-pages-root'),chapter=state.chapters[state.chapter];
 if(pagesView&&(pagesView.root!==pages||pagesView.chapterId!==chapter?.id)){pagesView.controller.destroy();pagesView=null;}
 if(pages&&!pagesView&&chapter)pagesView={root:pages,chapterId:chapter.id,controller:mountPdfPages(pages,{url:`/api/chapter-file/${encodeURIComponent(chapter.id)}`,label:`Bản dịch tiếng Việt: ${chapter.title}`,onLayout:()=>placePdfPages(pages)})};
 const root=$('#bilingual-root'),source=root?bilingualFor(chapter):null;
 if(bilingualView&&(bilingualView.root!==root||bilingualView.chapterId!==chapter?.id))closeBilingual();
 if(!root||!source||bilingualView)return;
 const place=state.bilingualPlace?.chapterId===chapter.id?state.bilingualPlace:{chapterId:chapter.id,index:0,zoom:state.bilingualPlace?.zoom||1};
 bilingualView={root,chapterId:chapter.id,controller:mountBilingual(root,{originalUrl:source.url,translatedUrl:`/api/chapter-file/${encodeURIComponent(chapter.id)}`,pages:source.pages,labels:source.labels||null,index:place.index,zoom:place.zoom,onChange:({index,zoom})=>{state.bilingualPlace={chapterId:chapter.id,index,zoom};},onOriginalLayer:sheet=>attachHanziLookup(sheet,{selector:'.textLayer'})})};
}
// release: the reader is left, so the open PDF files and the pdf.js worker go too.
function closeBilingual(release=false){bilingualView?.controller.destroy();bilingualView=null;if(release){pagesView?.controller.destroy();pagesView=null;releaseBilingual();}}
function loadReaderTerms(storyId){state.readerTerms=null;api(`/glossary/${encodeURIComponent(storyId)}`).then(result=>{state.readerTerms=termMatcher(result.terms);decorateReader();}).catch(()=>{});}
// A view's heading: its title (plain text, escaped here: a story title comes from a student's request), the actions at
// the right (markup) and at most one muted line under it (markup, escaped by the caller). No kicker, no subtitle.
function heading(title,action='',meta=''){return `<div class="page-heading"><div class="page-title"><h1>${esc(title)}</h1>${meta?`<p class="page-meta">${meta}</p>`:''}</div>${action}</div>`;}
function view(){switch(state.route){case 'translate':return translateView();case 'review':return reviewView();case 'stories':return storiesView();case 'users':return usersView();case 'requests':return requestsView();case 'settings':return settingsView();case 'glossary':return glossaryView();case 'library':return libraryView();case 'reader':return readerView();default:return translateView();}}
function storyOptions(selected=state.storyId){const option=(s,owner='')=>`<option value="${esc(s.id)}" ${s.id===selected?'selected':''}>${esc(s.title)}${owner?` · ${esc(owner)}`:''}</option>`,web=state.stories.filter(s=>!s.owner_user_id),personal=state.stories.filter(s=>s.owner_user_id);return `${web.length?`<optgroup label="Kho tài liệu">${web.map(s=>option(s)).join('')}</optgroup>`:''}${personal.length?`<optgroup label="Tài liệu của học sinh">${personal.map(s=>option(s,s.owner_name||s.owner_email||'Học sinh')).join('')}</optgroup>`:''}`;}
function selectAcademicField(storyId){const select=$('#genre');if(!select)return;const requested=genreDrafts[storyId]||state.stories.find(s=>s.id===storyId)?.genre||'Chuyên khảo · Nghiên cứu';select.value=[...select.options].some(option=>option.value===requested)?requested:'Chuyên khảo · Nghiên cứu';}
// Admin rows loaded so far: library and student books (state.stories, then each opened student shelf), jobs.
const adminStories=()=>{const seen=new Map(state.stories.map(story=>[story.id,story]));for(const shelf of Object.values(state.userBooks))for(const story of shelf.rows||[])if(!seen.has(story.id))seen.set(story.id,story);return [...seen.values()];};
const adminStory=id=>adminStories().find(story=>story.id===id)||null;
// "100+" while the server has more rows than were loaded.
const listCount=(name,count=state[name].length)=>`${count}${state.more[name]!==null&&state.more[name]!==undefined?'+':''}`;
const moreButton=(name,label)=>state.more[name]!==null&&state.more[name]!==undefined?`<div class="load-more"><button type="button" data-load-more="${name}">${label}</button></div>`:'';
async function loadMore(name){
 const offset=state.more[name];if(offset===null||offset===undefined||!['stories','jobs'].includes(name))return;
 const page=await apiPage(`/${name}?offset=${offset}&limit=${PAGE}`),known=new Set(state[name].map(item=>item.id));
 state[name]=[...state[name],...page.rows.filter(row=>!known.has(row.id))];state.more[name]=page.next;render();
}
// A job's text, translation and warnings (GET /api/jobs/:id), fetched once per job shown; a list row that still carries
// its text (an older server) is used as is.
function jobDetail(id){const entry=state.jobDetails[id];if(entry?.data)return entry.data;const row=state.jobs.find(job=>job.id===id);return row&&typeof row.source==='string'?row:null;}
function loadJobDetail(id,{again=false}={}){
 if(!id||!again&&state.jobDetails[id])return;
 const entry=state.jobDetails[id]={loading:true,data:null,error:null};
 api(`/jobs/${encodeURIComponent(id)}`).then(data=>{entry.data=data;},error=>{entry.error=error;}).finally(()=>{entry.loading=false;if(state.jobDetails[id]===entry&&state.selected===id&&state.route==='review')render();});
}
const warningsOf=detail=>{try{const list=JSON.parse(detail?.warnings||'[]');return Array.isArray(list)?list:[];}catch{return [];}};
// A book's glossary: a library row carries it; a student's book is fetched (GET /api/stories/:id) before it can be edited,
// so saving never replaces its terms with an empty list; "Lưu bảng thuật ngữ" asks again when it is missing with no answer
// on its way. null while unknown. Its answer draws Thuật ngữ again only while the editor cannot be typed in (still
// loading, or not shown), never over terms being typed.
function glossaryOf(id){
 const row=adminStory(id);if(typeof row?.glossary==='string')return row.glossary;
 const entry=state.storyDetails[id];if(entry?.data)return typeof entry.data.glossary==='string'?entry.data.glossary:'{}';
 return null;
}
function loadStoryDetail(id,{again=false}={}){
 if(!id||!again&&state.storyDetails[id])return;
 const entry=state.storyDetails[id]={loading:true,data:null,error:null};
 api(`/stories/${encodeURIComponent(id)}`).then(data=>{entry.data=data;},error=>{entry.error=error;}).finally(()=>{entry.loading=false;if(state.storyDetails[id]===entry&&state.route==='glossary'&&$('#glossary-text')?.readOnly!==false)render();});
}
const glossaryTerms=text=>{try{const value=JSON.parse(text||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
// One student's books (GET /api/user-library?user=), loaded when the admin opens them; again: a reload after a change.
function loadUserBooks(userId,{again=false,more=false}={}){
 const old=state.userBooks[userId];if(!again&&!more&&old)return;
 const offset=more?old?.next:0;if(more&&(offset===null||offset===undefined))return;
 const entry=state.userBooks[userId]={rows:more?old.rows:old?.rows||[],next:old?.next??null,loading:true,error:null};
 apiPage(`/user-library?user=${encodeURIComponent(userId)}&offset=${offset}&limit=${more?PAGE:Math.max(PAGE,Math.min(PAGE_MAX,old?.rows?.length||0))}`).then(page=>{entry.rows=more?[...entry.rows,...page.rows.filter(row=>!entry.rows.some(item=>item.id===row.id))]:page.rows;entry.next=page.next;},error=>{entry.error=error;}).finally(()=>{entry.loading=false;if(state.userBooks[userId]===entry&&state.route==='users')render();});
}
// A student's books, open under their row ("N tài liệu ▾"): one line each (title, where it is, its parts) with the same ⋯
// as in Kho tài liệu; more on demand, "Thu gọn" folds it.
function userShelf(user,count){
 const id=esc(user.id),shelf=state.userBooks[user.id];
 if(!shelf)return '';
 if(shelf.error&&!shelf.rows.length)return `<div class="note" data-tone="error" role="alert">Chưa tải được tài liệu của học sinh này: ${esc(shelf.error.message)} <button type="button" data-user-books-retry="${id}">Thử lại</button></div>`;
 if(shelf.loading&&!shelf.rows.length)return '<p class="status" role="status">Đang tải…</p>';
 if(!shelf.rows.length)return '<p class="empty-line">Học sinh này chưa có tài liệu.</p>';
 return `<ul class="rows shelf-rows">${shelf.rows.map(s=>`<li class="row"><div class="row-text"><span class="row-title" title="${esc(s.title)}">${esc(s.title)}</span><span class="row-meta">${s.visibility==='public'?'Thư viện chung':'Thư viện riêng'} · ${Number(s.chapters)||0} phần</span></div>${storyMenu(s)}</li>`).join('')}</ul><div class="load-more">${shelf.next!==null?`<button type="button" data-user-books-more="${id}" ${shelf.loading?'disabled':''}>Tải thêm</button>`:''}<button type="button" class="quiet" data-user-books-hide="${id}">Thu gọn</button></div>`;
}
// While jobs run, only their rows are asked for (GET /api/jobs?ids=), in the background: the run's own steps keep the
// session; a job whose status changed has its text fetched again for the editor.
async function pollJobs(ids){
 const wanted=ids.filter(Boolean).slice(0,100);if(!wanted.length)return;
 const rows=await api(`/jobs?ids=${wanted.map(encodeURIComponent).join(',')}`,{background:true});if(!Array.isArray(rows))return;
 for(const row of rows){const old=state.jobs.find(job=>job.id===row.id);if(old&&old.status!==row.status)delete state.jobDetails[row.id];}
 state.jobs=state.jobs.map(job=>rows.find(row=>row.id===job.id)||job);
}
// Xưởng dịch: what waits (links, only when something does), the form for a new translation, the latest jobs. With no
// document yet, creating one is the next step and "Bắt đầu dịch" waits for it.
function translateView(){
 const web=state.stories.length>0,pdf=state.tab==='file'&&Boolean(state.file?.name.toLowerCase().endsWith('.pdf'));
 const source=state.tab==='file'?`<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Chọn tài liệu để dịch"><p>Kéo thả tệp vào đây hoặc</p><button id="pick-file" type="button">Chọn tệp</button><p class="upload-limit">PDF, DOCX, EPUB, AZW3, ảnh scan, TXT · tối đa 25 MB · không nhận sách khóa DRM</p></div><input class="hide" type="file" id="file-input" accept=".pdf,.epub,.azw3,.docx,.png,.jpg,.jpeg,.webp,.txt">${state.file?`<div class="selected-file"><span>${esc(state.file.name)} <small>· ${(state.file.size/1024).toFixed(0)} KB</small></span><button id="remove-file" type="button" class="quiet">Bỏ tệp</button></div>`:''}`:`<label>Nguyên tác tiếng Trung<textarea id="source-input" rows="9" maxlength="25000000" placeholder="Dán nội dung tiếng Trung vào đây…">${esc(state.draftText||'')}</textarea></label>`;
 const story=web?`<div class="story-pick"><label>Tài liệu<select id="story-select"><option value="">Chọn tài liệu…</option>${storyOptions()}</select></label><button type="button" id="new-story">Tạo tài liệu mới…</button></div>`:'<div class="story-pick"><span class="field-label">Tài liệu</span><button type="button" class="primary" id="new-story">Tạo tài liệu đầu tiên…</button></div>';
 return heading('Xưởng dịch')+`${jobStats()}<section class="panel translate-panel" aria-labelledby="new-job-title"><div class="panel-heading"><h2 id="new-job-title">Bản dịch mới</h2></div><div class="tabs"><button class="${state.tab==='file'?'active':''}" data-tab="file">Tải tài liệu</button><button class="${state.tab==='text'?'active':''}" data-tab="text">Nhập văn bản</button></div><div class="upload-area">${source}</div><div class="form-grid">${story}<label>Lĩnh vực<select id="genre"><option selected>Chuyên khảo · Nghiên cứu</option><option>Toán học · STEM</option><option>Lịch sử Trung Hoa</option><option>Cổ văn · Hán Nôm</option><option>Triết học · Tư tưởng</option><option>Văn hóa · Xã hội</option><option>Địa lý · Khảo cổ</option><option>Giáo dục</option><option>Ngôn ngữ học</option><option>Tài liệu khác</option></select></label>${modeField()}<div class="field-wide" id="story-cover-slot">${uploadCoverPanel()}</div></div><div class="upload-footer"><div class="upload-actions">${pdf?'<button type="button" id="prepare-pdf">Chia PDF trước</button>':''}${web?'<button type="button" class="primary" id="start-translate">Bắt đầu dịch</button>':''}</div></div></section>${recentJobs()}`;
}
// Xưởng dịch's waiting work and recent jobs: drawn again on their own when a run ends (jobsChanged), never with the form.
// Only what is waiting is named, each a link to where it is handled; nothing at all when nothing waits.
function jobStats(){const more=state.more.jobs!==null&&state.more.jobs!==undefined?'+':'',review=state.jobs.filter(j=>j.status==='review').length,failed=state.jobs.filter(j=>j.status==='failed').length,fresh=pendingRequests();const items=[review?`<button type="button" class="quiet" data-route="review">${review}${more} chờ duyệt</button>`:'',failed?`<button type="button" class="quiet" data-route="review">${failed}${more} cần xử lý</button>`:'',fresh?`<button type="button" class="quiet" data-route="requests">${fresh} yêu cầu mới</button>`:''].filter(Boolean);return `<div class="stats" role="group" aria-label="Việc đang chờ"${items.length?'':' hidden'}>${items.join('<span class="stats-dot" aria-hidden="true">·</span>')}</div>`;}
function recentJobs(){return `<section class="recent" aria-labelledby="recent-title"${state.jobs.length?'':' hidden'}><div class="section-head"><h2 id="recent-title">Tài liệu gần đây</h2><div class="section-actions"><button type="button" class="quiet" data-route="review">Xem tất cả</button></div></div>${jobRows(state.jobs.slice(0,4),{book:true})}</section>`;}
// One set of words for a job's state, everywhere: rows, the job's own page, the counts.
const JOB_STATES={uploaded:['Chờ dịch',''],prepared:['Chờ dịch',''],splitting:['Đang dịch',''],ocr:['Đang dịch',''],translating:['Đang dịch',''],assembling:['Đang dịch',''],review:['Chờ duyệt','warn'],published:['Đã công bố','ok'],failed:['Cần xử lý','danger']};
const statuses=Object.fromEntries(Object.entries(JOB_STATES).map(([key,[label]])=>[key,label]));
const jobChip=j=>{const [label,tone]=JOB_STATES[j.status]||JOB_STATES.uploaded;return `<span class="chip"${tone?` data-tone="${tone}"`:''}>${label}</span>`;};
// A job's progress line without the "Cách dịch" it names (the select says it).
const progressOf=j=>String(j.progress||'').replace(/\s*·?\s*Cách dịch:\s*[^·]*/u,'').trim();
// "Cách dịch" of the admin's jobs (frontend/translation-modes.js): the server's default (GET /api/status translationMode,
// from ADMIN_TRANSLATION_MODE, else Kỹ nhất) unless the admin picks another in this tab; each new job carries its own
// (POST /api/jobs mode). A job without one (made before modes, or from a student's request) runs with the default.
function adminDefaultMode(){return isMode(state.status.translationMode)?state.status.translationMode:ADMIN_DEFAULT_MODE;}
function chosenMode(){return isMode(state.jobMode)?state.jobMode:adminDefaultMode();}
function modeName(mode){return modeProfile(mode).label;}
// The one line under "Cách dịch": the mode's brief (translation-modes.js), else its hint with what it costs next to
// Tiết kiệm. The full hints sit in "So sánh các Cách dịch".
function modeHint(mode){const {brief,hint,estimate}=modeProfile(mode);return brief||(estimate>1?`${hint} Ước tính tốn khoảng gấp ${estimate.toLocaleString('vi-VN')} lần token so với Tiết kiệm.`:hint);}
const modeDetail=mode=>{const {hint,estimate}=modeProfile(mode);return estimate>1?`${hint} Khoảng ${estimate.toLocaleString('vi-VN')}× token so với Tiết kiệm.`:hint;};
function modeField(){const mode=chosenMode();return `<label>Cách dịch<select id="job-mode" aria-describedby="job-mode-hint">${MODES.map(id=>`<option value="${id}"${id===mode?' selected':''}>${esc(modeProfile(id).label)}</option>`).join('')}</select></label><div class="mode-help"><p class="mode-hint" id="job-mode-hint" aria-live="polite">${esc(modeHint(mode))}</p><details class="more"><summary>So sánh các Cách dịch</summary><div class="more-body">${MODES.map(id=>`<p><strong>${esc(modeName(id))}:</strong> ${esc(modeDetail(id))}</p>`).join('')}</div></details></div>`;}
// Beside "Bắt đầu dịch / Tiếp tục xử lý / Dịch lại": the job's own mode (its list row, else GET /api/jobs/:id: the light
// list rows may not carry it), else the default it runs with. Only a mode picked here is sent when the job (re)starts
// (POST /api/jobs/:id/run {mode}) and kept from then on; an untouched select sends none, so a job paused in one mode
// resumes in it.
const pickedRunMode=id=>state.runMode?.job===id&&isMode(state.runMode.mode)?state.runMode.mode:null;
const jobMode=j=>pickedRunMode(j.id)||[j.mode,jobDetail(j.id)?.mode].find(isMode)||adminDefaultMode();
function runModeField(j){
 if(j.status==='published')return '';const mode=jobMode(j);
 return `<label class="run-mode">Cách dịch<select id="run-mode" ${busy?'disabled':''}>${MODES.map(id=>`<option value="${id}"${id===mode?' selected':''}>${esc(modeName(id))}</option>`).join('')}</select></label>`;
}
// The AI log, folded under the editors: model, prompt, tokens in, out and thinking, calls and cache hits.
function jobAudit(j){const requests=Number(j.ai_requests)||0,total=Number(j.total_tokens)||0,prompt=Number(j.prompt_tokens)||0,output=Number(j.output_tokens)||0,thinking=Number(j.thinking_tokens)||0;if(!requests&&!total&&!j.model&&!j.prompt_version)return '';return `<details class="more job-audit"><summary>Nhật ký AI</summary><div class="more-body"><p>${esc(j.model||'Chưa ghi model')} · Prompt ${esc(j.prompt_version||'chưa ghi phiên bản')}</p><p>${total.toLocaleString('vi-VN')} token · ${prompt.toLocaleString('vi-VN')} vào + ${output.toLocaleString('vi-VN')} ra${thinking?` + ${thinking.toLocaleString('vi-VN')} suy luận`:''} · ${requests} lượt gọi${Number(j.ai_cache_hits)?` · ${Number(j.ai_cache_hits)} cache hit`:''}</p></div></details>`;}
// A job as one row: its file, its book where the list mixes books, its state and day; the whole row opens it.
function jobRows(jobs,{book=false}={}){return jobs.length?`<ul class="rows job-rows">${jobs.map(j=>{const progress=['review','published'].includes(j.status)?'':progressOf(j);return `<li class="row"><button type="button" class="row-main" data-job="${esc(j.id)}" aria-label="Mở ${esc(j.filename)}"><span class="row-title">${esc(j.filename)}</span>${book||progress?`<span class="row-meta">${[book?esc(j.story_title):'',esc(progress)].filter(Boolean).join(' · ')}</span>`:''}</button><span class="row-side">${jobChip(j)}<span class="row-day">${dayShort(j.created_at)}</span></span></li>`;}).join('')}</ul>`:'';}
// Đối chiếu: one row per book (those waiting for a review or a fix first), what its parts wait for, the row opens it.
function reviewBooks(){
 const groups=new Map();for(const job of state.jobs){if(!groups.has(job.story_id))groups.set(job.story_id,[]);groups.get(job.story_id).push(job);}
 const urgent=jobs=>jobs.some(j=>['review','failed'].includes(j.status)),books=[...groups].sort((a,b)=>Number(urgent(b[1]))-Number(urgent(a[1])));
 if(!books.length)return `<p class="empty-line">Chưa có bản dịch nào. <button type="button" class="quiet" data-route="translate">Mở Xưởng dịch</button></p>${moreButton('jobs','Tải thêm bản dịch cũ hơn')}`;
 const count=(jobs,test)=>jobs.filter(test).length,running=j=>['splitting','ocr','translating','assembling'].includes(j.status);
 return `<ul class="rows review-books">${books.map(([storyId,jobs])=>{const title=jobs[0]?.story_title||'Chưa đặt tên',story=adminStory(storyId),parts=[[count(jobs,j=>j.status==='review'),'chờ duyệt'],[count(jobs,j=>j.status==='failed'),'cần xử lý'],[count(jobs,j=>j.status==='published'),'đã công bố'],[count(jobs,running),'đang dịch'],[count(jobs,j=>['uploaded','prepared'].includes(j.status)),'chờ dịch']].filter(([n])=>n).map(([n,word])=>`${n} ${word}`).join(' · ');return `<li class="row review-book"><span class="review-book-cover" aria-hidden="true">${story?coverArt(story):coverPlaceholder({title})}</span><button type="button" class="row-main review-enter" data-review-story="${esc(storyId)}" aria-label="Vào xem các phần của ${esc(title)}"><span class="row-title">${esc(title)}</span><span class="row-meta">${parts}</span></button><span class="row-chevron" aria-hidden="true">›</span></li>`;}).join('')}</ul>${moreButton('jobs','Tải thêm bản dịch cũ hơn')}`;
}
// A book's parts by state: what waits for a review or a fix is open; the queue and what is published are folded.
function reviewBook(){
 const jobs=state.jobs.filter(job=>job.story_id===state.reviewStory),by=test=>jobs.filter(test),waiting=by(j=>j.status==='review'),failed=by(j=>j.status==='failed'),published=by(j=>j.status==='published'),queue=by(j=>!['review','published','failed'].includes(j.status));
 const open=(title,list)=>list.length?`<section class="review-section"><div class="section-head"><h2>${title} <span class="count">(${list.length})</span></h2></div>${jobRows(list)}</section>`:'';
 const fold=(title,list,id='')=>list.length?`<details class="fold review-section${id?' review-queue':''}"${id&&state.showReviewQueue?' open':''}><summary${id?` id="${id}"`:''}>${title} (${list.length})</summary>${jobRows(list)}</details>`:'';
 return `<p class="back-link"><button type="button" class="quiet" id="back-review-books">← Đối chiếu</button></p>${heading(jobs[0]?.story_title||'Các phần đã dịch')}${open('Chờ duyệt',waiting)}${open('Cần xử lý',failed)}${fold('Chờ dịch',queue,'toggle-review-queue')}${fold('Đã công bố',published)}${jobs.length?'':'<p class="empty-line">Chưa có phần nào.</p>'}`;
}
// A job's page. One action leads, by state: start, resume, or review and publish; a failed job says why in one alert that
// holds "Tiếp tục xử lý" (and "Cách dịch" beside it), so #rerun is drawn once. "Tải về" and ⋯ hold the rest.
function jobView(j){
 const detail=jobDetail(j.id),entry=state.jobDetails[j.id],warnings=warningsOf(detail),running=['splitting','ocr','translating','assembling'].includes(j.status),long=Boolean(j.source_key||j.translation_key);
 const editable=!long&&!busy&&!['splitting','prepared','ocr','translating','assembling','published'].includes(j.status)&&!(j.status==='failed'&&j.progress),locked=!detail||!editable;
 const fresh=['uploaded','prepared'].includes(j.status),failed=j.status==='failed',partial=failed&&(detail?String(detail.translation||'').trim():Number(j.has_translation));
 const run=label=>`${runModeField(j)}<button type="button" class="primary" id="rerun" ${busy?'disabled':''}>${label}</button>`;
 // While the text loads, publishing and saving wait for it (disabled beside "Đang tải…"); when it did not load they are
 // not drawn: the alert's "Thử lại" is the one thing to do.
 const unloaded=!detail&&Boolean(entry?.error);
 const lead=j.status==='review'?unloaded?'':`<button type="button" class="primary" id="publish-job" ${detail?'':'disabled'}>Duyệt & công bố</button>`:fresh?run('Bắt đầu dịch'):running&&!busy?run('Tiếp tục xử lý'):'';
 const downloads=[j.file_key?'<button type="button" id="download-original">Bản gốc</button>':'',['review','published'].includes(j.status)?'<button type="button" id="download-book">Cả quyển (.txt)</button>':''].join('');
 // While a run goes on in this tab, what would start another (Dịch lại…) or remove its job waits, said in one line.
 const more=[j.status==='review'?busy?'<p class="menu-note">Dịch lại — đợi lượt dịch xong</p>':'<button type="button" id="rerun-dialog">Dịch lại…</button>':'',j.mime==='application/pdf'?'<button type="button" id="pdf-parts">Các phần PDF</button>':''].join('');
 const remove=busy?'<p class="menu-note">Xóa tài liệu — đợi lượt dịch xong</p>':`<button type="button" class="danger" data-delete-job="${esc(j.id)}">Xóa tài liệu…</button>`;
 const actions=`<div class="button-row job-actions">${lead}${editable&&!unloaded?`<button type="button" id="save-job" ${detail?'':'disabled'}>Lưu</button>`:''}${downloads?`<details class="menu job-download"><summary>Tải về <span aria-hidden="true">▾</span></summary><div class="menu-list">${downloads}</div></details>`:''}<details class="menu job-more"><summary class="icon-btn" aria-label="Thao tác cho “${esc(j.filename)}”" title="Thao tác">⋯</summary><div class="menu-list">${more}${more?'<div class="menu-sep" role="separator"></div>':''}${remove}</div></details></div>`;
 const total=Number(({...detail,...j}).total_tokens)||0,meta=[esc(j.filename),esc(progressOf(j)),total?`${total.toLocaleString('vi-VN')} token`:''].filter(Boolean).join(' · ');
 const top=`<p class="back-link"><button type="button" class="quiet" id="back-jobs" aria-label="Về các phần của ${esc(j.story_title||'tài liệu')}">← Các phần</button></p><div class="page-heading"><div class="page-title"><div class="title-row"><h1>${esc(j.story_title)}</h1>${jobChip(j)}</div><p class="page-meta">${meta}</p></div>${actions}</div>`;
 // The text did not load: one alert with "Thử lại" where the editors would be.
 if(!detail&&entry?.error)return `${top}<div class="note" data-tone="error" role="alert">Chưa tải được nội dung bản dịch: ${esc(entry.error.message)} <button type="button" id="job-detail-retry">Thử lại</button></div>`;
 // The error's own words (backend/ai.js, worker.js) may say already that the work is saved or kept ("đã được lưu", "được
 // giữ"; never "không/chưa được lưu"); the day's quota adds the admin's ways on: its reset time, or Billing for the server's
 // key. No lookbehind: Safari/iOS 15.4 would refuse the whole script.
 const saidSaved=[...String(j.error||'').matchAll(/(\S+) được (?:lưu|giữ)/gu)].some(([,before])=>!/^(?:không|chưa)$/iu.test(before)),dayQuota=/hết lượt hôm nay/u.test(j.error||'');
 const notes=[failed?`<div class="note job-alert" data-tone="error" role="alert"><p>${[j.progress,j.error].filter(Boolean).map(esc).join(' ')||'Lượt dịch đã dừng.'}${partial&&!saidSaved?' Phần đã dịch được giữ.':''}${dayQuota?' Chờ tới giờ đặt lại hoặc bật Billing trong Google AI Studio, rồi bấm Tiếp tục xử lý.':''}</p><div class="note-actions">${run('Tiếp tục xử lý')}</div></div>`:j.error?`<div class="note" data-tone="error" role="alert">${esc(j.error)}</div>`:'',busy&&running?'<p class="status" role="status">Đang dịch… Giữ trang mở; nếu đóng, có thể tiếp tục sau.</p>':'',!detail?'<p class="status" role="status">Đang tải…</p>':'',long?'<p class="note job-long">Văn bản dài: chỉ xem 20.000 ký tự đầu, không sửa ở đây. <button type="button" id="download-source">Tải nguyên tác đầy đủ</button></p>':'',warnings.length?`<div class="note" data-tone="warn"><ul class="job-warnings">${warnings.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''].join('');
 const empty=detail&&!String(detail.translation||'').trim()&&(fresh||running)?' placeholder="Chưa có bản dịch."':'';
 return `${top}${notes}<div class="editor-grid"><section class="editor-pane"><label for="edit-source">Nguyên tác</label><textarea id="edit-source" ${locked?'readonly':''}>${esc(detail?.source)}</textarea></section><section class="editor-pane"><label for="edit-translation">Bản dịch</label><textarea id="edit-translation" ${locked?'readonly':''}${empty}>${esc(detail?.translation)}</textarea></section></div>${jobAudit({...detail,...j})}`;
}
function reviewView(){const j=state.jobs.find(job=>job.id===state.selected);if(j)return jobView(j);if(state.reviewStory)return reviewBook();return heading('Đối chiếu')+reviewBooks();}
// The ⋯ of a book (Kho tài liệu, a student's shelf): what can be done with it, its deletion last.
function storyMenu(s){const id=esc(s.id);return `<details class="menu story-actions"><summary class="icon-btn" aria-label="Thao tác cho “${esc(s.title)}”" title="Thao tác">⋯</summary><div class="menu-list"><button type="button" data-story="${id}">Dịch phần mới</button><button type="button" data-rename-story="${id}">Đổi tên…</button><button type="button" data-cover="${id}">Ảnh bìa…</button><button type="button" data-import="${id}">Tải bản đã dịch lên…</button><button type="button" data-chapters="${id}">Các phần đã công bố</button><div class="menu-sep" role="separator"></div><button type="button" class="danger" data-delete-story="${id}">Xóa tài liệu…</button></div></details>`;}
function adminStoryCard(s){const chapters=Number(s.chapters)||0,jobs=state.jobs.filter(j=>j.story_id===s.id).length,draft=!s.owner_user_id&&s.visibility==='private';return `<article class="panel book story-card">${storyMenu(s)}${coverArt(s)}${isSample(s)||draft?`<div class="story-flags">${isSample(s)?`<span class="chip sample-flag">${SAMPLE_LABEL}</span>`:''}${draft?'<span class="chip draft-flag" title="Chưa công khai trong Thư viện">Nháp</span>':''}</div>`:''}<h2>${esc(s.title)}</h2>${s.author||s.genre?`<p class="story-meta">${[s.author,s.genre].filter(Boolean).map(esc).join(' · ')}</p>`:''}<p class="story-counts">${chapters?`${chapters} phần đã công bố`:'Chưa công bố'}${jobs?` · ${jobs} bản dịch`:''}</p></article>`;}
function storiesView(){const web=state.stories.filter(s=>!s.owner_user_id),parts=web.reduce((sum,s)=>sum+Number(s.chapters||0),0);return heading('Kho tài liệu','<div class="button-row"><button type="button" id="import-chapter">Tải bản đã dịch lên…</button><button type="button" class="primary" id="new-story">Tạo tài liệu…</button></div>',web.length?`${listCount('stories',web.length)} tài liệu · ${parts} phần đã công bố`:'')+(web.length?`<div class="library">${web.map(s=>adminStoryCard(s)).join('')}</div>`:'<p class="empty-line">Kho chưa có tài liệu.</p>')+moreButton('stories','Tải thêm tài liệu');}
// Học sinh: one row each (name, e-mail and the terms version and day the student agreed to, in view for any admin's
// device; Google, a lock or missing consent as chips; their books and requests) and a ⋯ with the account's actions. Resetting a password is not offered to a Google account, and waits for a locked one to
// be unlocked.
function usersView(){
 const books=state.users.reduce((sum,user)=>sum+(Number(user.books)||0),0);
 const rows=state.users.map(user=>{const id=esc(user.id),count=Number(user.books)||0,requests=state.requests.filter(r=>r.user_id===user.id).length,name=user.name||user.email,locked=Boolean(user.disabled_at),google=user.provider==='google',open=Boolean(state.userBooks[user.id]);
  // "Điều khoản <version>" stays on one line (.nowrap) when the row's line wraps on a phone: never split at its hyphen.
  const consent=user.terms_version?`<span class="nowrap">Điều khoản ${esc(user.terms_version)}</span>${user.terms_accepted_at?` · ${esc(dayText(user.terms_accepted_at))}`:''}`:'';
  const reset=google?'':locked?'<p class="menu-note">Đặt lại mật khẩu — mở khóa trước</p>':`<button type="button" data-user-reset="${id}">Tạo liên kết đặt lại mật khẩu</button>`;
  return `<li class="user-block"><div class="row user-row"><span class="avatar" aria-hidden="true">${user.picture?`<img src="${esc(user.picture)}" alt="">`:esc(String(name).slice(0,1).toUpperCase())}</span><div class="row-text user-identity"><h2 class="row-title">${esc(user.name||'Chưa đặt tên')}</h2><p class="row-meta">${esc(user.email)}${consent?` · ${consent}`:''}</p></div><div class="row-side user-badges">${google?'<span class="chip" title="Tài khoản Google, không có mật khẩu">Google</span>':''}${locked?'<span class="chip user-locked" data-tone="danger">Đang khóa</span>':''}${user.terms_version?'':'<span class="chip" data-tone="warn" title="Tài khoản tạo trước khi có điều khoản">Chưa đồng ý điều khoản</span>'}${count?`<button type="button" class="quiet" data-user-books="${id}" aria-expanded="${open}">${count} tài liệu ▾</button>`:''}${requests?`<button type="button" class="quiet" data-route="requests">${requests} yêu cầu</button>`:''}<details class="menu"><summary class="icon-btn" aria-label="Thao tác cho “${esc(name)}”" title="Thao tác">⋯</summary><div class="menu-list">${reset}<button type="button" data-user-lock="${id}">${locked?'Mở khóa':'Khóa tài khoản…'}</button><div class="menu-sep" role="separator"></div><button type="button" class="danger" data-user-delete="${id}">Xóa tài khoản…</button></div></details></div></div>${open?`<div class="user-books">${userShelf(user,count)}</div>`:''}</li>`;}).join('');
 return heading('Học sinh','',state.users.length?`${state.users.length} tài khoản${books?` · ${books} tài liệu riêng`:''}`:'')+(state.users.length?`<ul class="user-management">${rows}</ul>`:'<p class="empty-line">Chưa có học sinh nào đăng ký.</p>');
}
// Yêu cầu dịch: new ones first, then those being translated; finished ones folded. One action leads by state.
const REQUEST_LABELS={pending:['Mới',''],accepted:['Đang dịch','warn'],done:['Đã xong','ok']};
function requestItem(r){
 const id=esc(r.id),[label,tone]=REQUEST_LABELS[r.status]||REQUEST_LABELS.pending,meta=[esc(r.reader_name||r.reader_email||'Học sinh'),dayShort(r.created_at)].filter(Boolean).join(' · ');
 // A row's action is outlined, as in every other list: several new requests never stack up red buttons.
 const lead=r.status==='pending'?`<button type="button" data-accept="${id}">Tiếp nhận</button>`:r.status==='accepted'?`${r.story_id?`<button type="button" class="quiet" data-accept="${id}">Mở tài liệu</button>`:''}<button type="button" data-done="${id}">Đánh dấu xong</button>`:'';
 const menu=`<details class="menu"><summary class="icon-btn" aria-label="Thao tác cho “${esc(r.title)}”" title="Thao tác">⋯</summary><div class="menu-list">${r.status==='pending'?`<button type="button" data-done="${id}">Đánh dấu xong</button><div class="menu-sep" role="separator"></div>`:''}<button type="button" class="danger" data-delete-request="${id}">Xóa…</button></div></details>`;
 return `<li class="request-item"><div class="request-head"><h2 class="row-title">${esc(r.title)}</h2>${r.visibility==='public'?'<span class="chip">Thư viện chung</span>':''}<span class="chip"${tone?` data-tone="${tone}"`:''}>${label}</span></div><p class="row-meta">${meta}</p>${r.notes?`<p class="request-notes">${esc(r.notes)}</p>`:''}${r.source_url||r.filename?`<div class="request-links">${r.source_url?sourceLink(r.source_url,'Xem nguồn ↗','Nguồn: '):''}${r.filename?`<button type="button" class="file-row" data-request-file="${id}" aria-label="Tải tệp ${esc(r.filename)}">${esc(r.filename)}</button>`:''}</div>`:''}<div class="request-actions">${lead}${menu}</div></li>`;
}
function requestsView(){const of=status=>state.requests.filter(r=>r.status===status),open=[...of('pending'),...of('accepted')],done=of('done');return heading('Yêu cầu dịch')+(state.requests.length?`${open.length?`<ul class="request-list">${open.map(requestItem).join('')}</ul>`:''}${done.length?`<details class="fold request-done"><summary>Đã xong (${done.length})</summary><ul class="request-list">${done.map(requestItem).join('')}</ul></details>`:''}`:'<p class="empty-line">Chưa có yêu cầu dịch.</p>');}
// Cài đặt: the Gemini key (its state in one line, the model and default "Cách dịch"), your account, the other admins.
// "Đổi mật khẩu" and "Thêm quản trị viên" open their form in place (state.settingsOpen keeps it open while it is used).
function settingsView(){
 const fromDashboard=state.status.apiKeySource==='dashboard',updated=state.status.apiKeyUpdatedAt?dayText(state.status.apiKeyUpdatedAt):'';
 const status=state.status.aiConfigured?`<p class="key-status ready"><span class="dot" aria-hidden="true"></span>Sẵn sàng · ${fromDashboard?`khóa nhập tại đây${updated?` · ${esc(updated)}`:''}`:'khóa trên máy chủ'}</p>`:'<p class="key-status missing"><span class="dot" aria-hidden="true"></span>Chưa có khóa Gemini. Dán khóa bên dưới để bắt đầu dịch.</p>';
 return heading('Cài đặt')+`<div class="settings-grid"><section class="panel settings-card" aria-labelledby="gemini-key-title"><h2 id="gemini-key-title">Khóa Gemini</h2>${status}<p class="settings-meta">${esc(state.status.model||'gemini-2.5-flash')} · Cách dịch mặc định: ${esc(modeName(adminDefaultMode()))}</p><form id="gemini-key-form"><label for="gemini-api-key">Khóa API mới<div class="secret-field"><input type="password" id="gemini-api-key" name="apiKey" autocomplete="new-password" minlength="20" maxlength="500" required placeholder="Dán khóa Gemini API" aria-describedby="gemini-key-note"><button type="button" class="icon-btn" id="toggle-api-key" aria-label="Hiện khóa API">Hiện</button></div></label><small class="field-hint" id="gemini-key-note">Khóa được mã hóa trên máy chủ và không hiện lại; khóa mới dùng từ lần dịch sau.</small><div class="button-row"><button class="primary" type="submit">Lưu khóa</button>${fromDashboard?'<button type="button" class="quiet" id="reset-api-key">Dùng lại khóa máy chủ</button>':''}</div></form></section>${adminAccountCard()}${adminTeamCard()}</div>`;
}
// Under every new admin password and username: what the server takes (backend/admin-auth.js: a password of 12 to 128
// characters, passwordProblem, never ADMIN_TOKEN itself; a username it looks up in lower case).
const ADMIN_PASSWORD_RULE='12–128 ký tự; không dùng mật khẩu phổ biến, tên đăng nhập hay ADMIN_TOKEN.';
const USERNAME_RULE='3–64 ký tự: chữ không dấu, số, dấu . - _; bắt đầu bằng chữ hoặc số.';
// Settings: who is signed in, changing the password (POST /api/admin/password: the other sessions end, this browser gets
// a new cookie) and signing out. The hidden username tells a password manager which entry the new password replaces.
// The session cookie goes when the browser closes; the server ends the session after 12 hours, or 2 hours unused (the
// console's own checks do not count, backend/admin-auth.js).
function adminAccountCard(){const admin=adminIdentity(),open=Boolean(state.settingsOpen?.password);return `<section class="panel settings-card settings-session" aria-labelledby="admin-account-title"><h2 id="admin-account-title">${esc(admin.name)}</h2><p class="settings-meta">${admin.username?`${esc(admin.username)} · `:''}phiên tự kết thúc sau 2 giờ không dùng (tối đa 12 giờ). Máy dùng chung: nhớ Đăng xuất.</p><div class="button-row"><button type="button" id="admin-password-toggle" aria-expanded="${open}" aria-controls="admin-password-form">Đổi mật khẩu</button><button type="button" class="quiet" id="logout">Đăng xuất</button></div><form id="admin-password-form" class="auth-form admin-password" aria-labelledby="admin-password-title"${open?'':' hidden'}><h3 id="admin-password-title">Đổi mật khẩu</h3>${formError('admin-password-error')}${formDone('admin-password-done')}<input type="text" autocomplete="username" value="${esc(admin.username)}" hidden><label>Mật khẩu<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="admin-password-rule"><small class="field-hint" id="admin-password-rule">${ADMIN_PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu mới<input name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><button class="primary" type="submit">Đổi mật khẩu</button></form></section>`;}
// Settings: every admin account (GET /api/admin/admins), "Xóa…" beside the others (never yourself; the server keeps the
// last one), and a form to add one (POST /api/admin/admins). Both ask for your own password ("Mật khẩu của bạn"). The
// form holds no hidden username, unlike "Đổi mật khẩu": a password manager would take the new admin's password as a
// new one of yours.
function adminTeamCard(){const open=Boolean(state.settingsOpen?.add);return `<section class="panel settings-card admin-team" aria-labelledby="admin-team-title"><div class="section-head"><h2 id="admin-team-title" tabindex="-1">Quản trị viên</h2><div class="section-actions"><button type="button" id="admin-add-toggle" aria-expanded="${open}" aria-controls="admin-add-form">Thêm quản trị viên</button></div></div><div class="admin-list" id="admin-list">${adminList()}</div><form id="admin-add-form" class="auth-form admin-add" aria-labelledby="admin-add-title"${open?'':' hidden'}><h3 id="admin-add-title">Thêm quản trị viên</h3>${formError('admin-add-error')}${formDone('admin-add-done')}<label>Tên đăng nhập<input name="username" autocomplete="off" required minlength="3" maxlength="64" autocapitalize="none" spellcheck="false" aria-describedby="admin-add-username-rule"><small class="field-hint" id="admin-add-username-rule">${USERNAME_RULE}</small></label><label>Tên hiển thị (không bắt buộc)<input name="name" autocomplete="off" maxlength="100"></label><label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="admin-add-password-rule"><small class="field-hint" id="admin-add-password-rule">${ADMIN_PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label>Mật khẩu của bạn<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128" aria-describedby="admin-add-own-note"><small class="field-hint" id="admin-add-own-note">Để xác nhận.</small></label><button class="primary" type="submit">Thêm quản trị viên</button></form></section>`;}
function adminList(){
 const entry=state.admins,failed=entry?.error?`<div class="note" data-tone="error" role="alert">Chưa tải được danh sách quản trị viên: ${esc(entry.error.message)} <button type="button" id="admins-retry">Thử lại</button></div>`:'';
 if(!entry?.rows)return failed||'<p class="status" role="status">Đang tải…</p>';
 return `${failed}<ul class="rows admin-accounts">${entry.rows.map(row=>{const name=String(row.name||'').trim()||String(row.username||''),since=dayText(row.createdAt),last=dayText(row.lastLoginAt);return `<li class="row"${since?` title="Tạo ngày ${since}"`:''}><span class="avatar" aria-hidden="true">${esc(avatarOf({name}).initials)}</span><div class="admin-account row-text"><strong class="row-title">${esc(name)}</strong>${row.self?'<span class="chip admin-self">Bạn</span>':''}<small class="row-meta">${esc(row.username)} · ${last?`đăng nhập ${last}`:'chưa đăng nhập'}</small></div>${row.self?'':`<button type="button" class="danger" data-admin-delete="${esc(row.id)}" aria-label="Xóa quản trị viên ${esc(name)}">Xóa…</button>`}</li>`;}).join('')}</ul>`;
}
// Loaded when Settings opens and after each change; only the list is redrawn, never a form being typed in.
function loadAdmins(){
 const entry=state.admins={rows:state.admins?.rows||null,error:null};
 return api('/admin/admins').then(data=>{entry.rows=Array.isArray(data?.admins)?data.admins:[];},error=>{entry.error=error;}).finally(()=>{if(state.admins!==entry)return;const box=$('#admin-list');if(box){box.innerHTML=adminList();bindAdminList();}});
}
function bindAdminList(){
 document.querySelectorAll('[data-admin-delete]').forEach(button=>button.onclick=()=>deleteAdmin(button.dataset.adminDelete));
 on('#admins-retry','click',()=>{loadAdmins();const box=$('#admin-list');if(box){box.innerHTML=adminList();bindAdminList();}});
}
// The dialog asks for your own password (DELETE {currentPassword}) and opens with the focus in that field. A refusal is
// said in the dialog (modal) and the focus goes back to the field once it is, marked invalid when the password was the
// reason. Escape or "Hủy" gives the focus back to this admin's "Xóa…", a removal to the list's heading.
function deleteAdmin(id){
 const row=state.admins?.rows?.find(item=>String(item.id)===id);if(!row||row.self)return;const name=String(row.name||'').trim()||String(row.username||''),opener=`[data-admin-delete="${String(id).replace(/["\\]/g,'\\$&')}"]`;
 modal(`<h2>Xóa quản trị viên ${esc(name)}?</h2><p class="subtitle">${esc(row.username)} bị đăng xuất ngay và không đăng nhập được nữa. Không thể hoàn tác.</p><input type="text" autocomplete="username" value="${esc(adminIdentity().username)}" hidden><label class="modal-field">Mật khẩu của bạn<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label>`,async form=>{
  const field=$('#modal input[name="currentPassword"]');field?.removeAttribute('aria-invalid');field?.removeAttribute('aria-describedby');
  try{await api(`/admin/admins/${encodeURIComponent(id)}`,{method:'DELETE',body:{currentPassword:String(form.get('currentPassword')||'')}});}
  catch(error){
   if(field){if(['wrong_password','password_required'].includes(error.code)){field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby','modal-error');}setTimeout(()=>{if($('#modal')?.open)field.focus();});}
   throw error;
  }
  await loadAdmins();toast(`Đã xóa quản trị viên ${row.username}.`);
 },'Xóa',{danger:true,returnFocus:()=>document.querySelector(opener)||$('#admin-team-title')});
}
// Thuật ngữ: the book first; its terms, one per line, once it is chosen (and loaded).
function glossaryView(){
 const id=state.glossaryId||'',terms=id?glossaryOf(id):'{}',entry=id?state.storyDetails[id]:null,waiting=!id||terms!==null?'':entry?.error?`<div class="note" data-tone="error" role="alert">Chưa tải được thuật ngữ của tài liệu này: ${esc(entry.error.message)} <button type="button" id="story-detail-retry">Thử lại</button></div>`:'<p class="status" role="status">Đang tải…</p>';
 // Not loaded: the alert with "Thử lại" alone, no empty editor and no "Lưu" that cannot be used.
 return heading('Thuật ngữ')+`<div class="panel glossary-panel"><label>Tài liệu<select id="glossary-story"><option value="">Chọn tài liệu</option>${storyOptions(id)}</select></label>${waiting}${id&&!(terms===null&&entry?.error)?`<label class="glossary-field">Thuật ngữ<textarea id="glossary-text" rows="12" ${terms===null?'readonly':''} aria-describedby="glossary-hint"${terms===null?'':' placeholder="清朝 = triều Thanh\n翰林院 = Hàn Lâm viện"'}>${esc(terms===null?'':Object.entries(glossaryTerms(terms)).map(([k,v])=>`${k} = ${v}`).join('\n'))}</textarea><small class="field-hint" id="glossary-hint">Mỗi dòng: 中文 = tiếng Việt</small></label><button type="button" id="save-glossary" class="primary" ${terms===null?'disabled':''}>Lưu</button>`:''}</div>`;
}
// Home: what Hoa Trí does and for whom, then the shared library. Nothing here says a book was reviewed by a teacher.
function libraryView(){
 const hero=`<section class="library-intro" aria-labelledby="home-title"><p class="eyebrow">DÀNH CHO HỌC SINH VÀ GIÁO VIÊN</p><h1 id="home-title">Dịch tài liệu tiếng Trung sang tiếng Việt, giữ nguyên bố cục trang</h1><div class="hero-actions"><a class="hero-cta hero-cta-primary" href="/study">Dịch tài liệu của tôi</a><a class="hero-cta" href="#thu-vien" id="show-library">Xem Thư viện</a></div></section>`;
 // The genre chips show only when they narrow something: a genre with at least two books.
 const books=state.library.length>0,genres=[...new Set(state.library.map(s=>s.genre).filter(Boolean))],chips=genres.some(genre=>state.library.filter(s=>s.genre===genre).length>1);
 const filters=books?`<div class="library-filters"><label class="library-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="library-search" type="search" aria-label="Tìm tên tài liệu hoặc tác giả" placeholder="Tìm tài liệu, tác giả…" value="${esc(state.libraryQuery||'')}"></label>${chips?`<div class="genre-filter" role="group" aria-label="Lọc lĩnh vực">${['',...genres].map(g=>`<button type="button" data-library-genre="${esc(g)}" aria-pressed="${(state.libraryGenre||'')===g}">${esc(g||'Tất cả')}</button>`).join('')}</div>`:''}</div><p class="library-result-count sr-only" id="library-result-count" role="status"></p>`:'';
 const empty='<div class="empty-line library-empty"><p>Thư viện chung chưa có tài liệu.</p><a class="hero-cta" href="/study">Mở Xưởng dịch</a></div>';
 const content=state.errors?.library?errorCard('Chưa tải được thư viện',state.errors.library,'library',{primary:false}):!state.loaded?skeletonCards(6):!books?empty:`${filters}<div class="cover-library">${state.library.map(libraryCard).join('')}</div><p id="library-no-results" class="empty-line" hidden>Không có tài liệu khớp. <button type="button" class="quiet" id="library-clear-filter">Xóa bộ lọc</button></p>`;
 return `${hero}<section class="library-section" id="thu-vien" aria-labelledby="library-title"><div class="library-heading"><h2 id="library-title" tabindex="-1">Thư viện chung</h2></div>${content}</section>`;
}
// A book card: the cover opens the book (the part picker, or the reader for a one-part book); title and action stay
// visible under the cover. With a mouse the author and notes slide over the cover; on touch screens they sit below.
function libraryCard(s,i){
 const ready=Number(s.chapters)>0,id=esc(s.id),title=esc(s.title),reveal=`${s.author?`<p class="book-author">${esc(s.author)}</p>`:''}${sampleCardNote(s)}`;
 const cover=ready?`<button type="button" class="cover-trigger" data-read="${id}" data-read-cover="${id}" aria-label="Mở tài liệu ${title}${isSample(s)?` · ${SAMPLE_LABEL}`:''}">${coverArt(s)}</button>`:`<div class="cover-trigger">${coverArt(s)}</div>`;
 return `<article class="cover-book ${ready?'':'book-pending'}" data-library-index="${i}" aria-labelledby="book-title-${i}"><div class="cover-frame">${sampleBadge(s)}${cover}</div><div class="book-caption"><small class="book-genre">${esc(s.genre||'Tài liệu học thuật')}</small><h3 class="book-title" id="book-title-${i}">${title}</h3><p class="book-chapters">${ready?`${Number(s.chapters)} phần`:'Đang dịch'}</p></div>${reveal?`<div class="book-reveal" id="book-info-${i}">${reveal}</div>`:''}${ready?`<div class="book-actions"><button type="button" class="secondary" data-read="${id}" aria-describedby="book-title-${i}"><span data-read-label="Mở">Mở</span></button></div>`:''}</article>`;
}
// Parts of a student's book whose pages an older extractor read, or that still show the PDF of the part they took over
// (GET /api/my/study/books: layoutOutdated): headings, captions or lines may be printed Chinese there. Thư viện riêng,
// the reader and "Tải cả quyển" say "Bố cục cũ" and link the part's session in Xưởng dịch, where "Cập nhật bố cục" reads
// it again (nothing is paid before it is pressed); a refreshed copy begun already is linked instead, with the blocks it
// still has to translate.
const outdatedParts=storyId=>(state.studyBooks.find(book=>book.id===storyId)?.parts||[]).filter(part=>part.layoutOutdated===true&&part.sessionId);
const refreshLink=part=>part.refresh?.sessionId?`/study?history=${encodeURIComponent(part.refresh.sessionId)}`:`/study?history=${encodeURIComponent(part.sessionId)}&refresh=1`;
const newBlocks=part=>Number(part.refresh?.blocks)>0?` (${Number(part.refresh.blocks)} đoạn)`:'';
// A part is told apart by its pages when it has them (two parts, or two books, may share a title: "tesst" pages 4–6 and
// 7–8), unless its title already says them; else, among parts of the same title, by its place in the book.
function outdatedWhere(part){
 const start=Number(part.pageStart)||0,end=Number(part.pageEnd)||start,pages=start?start===end?`trang ${start}`:`trang ${start}–${end}`:'';
 if(pages)return String(part.title||'').toLocaleLowerCase('vi').includes(pages)?'':pages;
 const parts=(state.studyBooks.find(book=>book.parts?.some(item=>item.id===part.id))?.parts)||[];
 return parts.filter(item=>item.title===part.title).length>1?`phần ${parts.findIndex(item=>item.id===part.id)+1}`:'';
}
// "Trang 3–4: bố cục cũ · Cập nhật": the part (its pages, else its title in a book of several parts), then its own link.
const outdatedNote=(part,named=true)=>{const where=outdatedWhere(part),label=where?where[0].toLocaleUpperCase('vi')+where.slice(1):named?esc(part.title):'';return `${label?`${label}: bố cục cũ`:'Bố cục cũ'} · <a href="${esc(refreshLink(part))}">Cập nhật</a>${newBlocks(part)}`;};
function outdatedCardNote(storyId){
 const parts=outdatedParts(storyId);if(!parts.length)return '';const many=(state.studyBooks.find(book=>book.id===storyId)?.parts.length||0)>1;
 return parts.slice(0,3).map(part=>`<p class="layout-outdated">${outdatedNote(part,many)}</p>`).join('')+(parts.length>3?`<p class="layout-outdated">và ${parts.length-3} phần khác dùng bố cục cũ</p>`:'');
}
// Thư viện riêng: one row per book. A state shows only while the book cannot be read yet; a shared book says so.
const BOOK_STATES={uploaded:['Chờ dịch',''],prepared:['Chờ dịch',''],splitting:['Đang dịch','warn'],ocr:['Đang dịch','warn'],translating:['Đang dịch','warn'],assembling:['Đang dịch','warn'],review:['Chờ duyệt','warn'],failed:['Chờ quản trị viên xử lý','danger'],published:['Đã công bố','ok']};
function personalBookCards(){return state.myLibrary.map(s=>{const parts=Number(s.chapters)||0,[label,tone]=parts?['','']:BOOK_STATES[s.translation_status]||['Chờ dịch',''];return `<li class="row personal-book"><span class="personal-cover" aria-hidden="true">${coverArt(s)}</span><div class="row-text"><h3 class="row-title" title="${esc(s.title)}">${esc(s.title)}</h3><p class="row-meta">${[s.genre,parts?`${parts} phần`:''].filter(Boolean).map(esc).join(' · ')}</p>${outdatedCardNote(s.id)}</div><div class="row-side">${s.visibility==='public'?'<span class="chip">Thư viện chung</span>':''}${label?`<span class="chip"${tone?` data-tone="${tone}"`:''}>${label}</span>`:''}${parts?`<button type="button" class="secondary" data-read="${esc(s.id)}" aria-label="Đọc ${esc(s.title)}"><span data-read-label="Đọc">Đọc</span></button>`:''}</div></li>`;}).join('');}
// Sign-in and registration. The server decides who may register (/api/me registration.mode: open, closed or domain);
// the Google button works only once a terms box is ticked, since Google sign-in can create an account. In domain mode
// only Google creates accounts (it proves the address belongs to the school), so there is no registration form.
// Each form says what went wrong inside itself (.form-error, see sendForm); a server without Google sign-in shows no
// Google part at all.
const formError=id=>`<p class="form-error" id="${id}" role="alert" tabindex="-1" hidden></p>`;
// A form that stays on the page once the server took it (Cài đặt) says so in its own note, which takes the focus
// (showFormDone): the button pressed waited disabled for the answer, and the focus must not fall to the page.
const formDone=id=>`<p class="account-notice form-done" id="${id}" role="status" tabindex="-1" style="margin:0" hidden></p>`;
// Where a student asks the administrator for a password reset link: the contact section of the Terms (dieu-khoan.html
// #lien-he), whose address the operator fills in before launch.
const CONTACT_LINK='<a href="/dieu-khoan#lien-he" target="_blank" rel="noopener">mục Liên hệ</a>';
// Under every new-password field: the length the server takes and what it refuses (backend/reader-auth.js passwordProblem).
const PASSWORD_RULE='8–128 ký tự; tránh mật khẩu dễ đoán (12345678, ngày sinh, email).';
// The Google button carries accept_terms=1 only while a terms box is ticked (bindAuth keeps it in step): a link opened
// in a new tab, which no click handler sees, then comes back with loi=terms_required instead of recording consent.
const googleReturn=()=>state.pendingRequest?'/#yeu-cau':state.afterSignIn||'/#account';
const googleHref=agreed=>`/api/auth/google/start?${agreed?'accept_terms=1&':''}return_to=${encodeURIComponent(googleReturn())}`;
// The form comes first: the heading (it follows the chosen tab), one line, the tabs. Pressing "Tiếp tục bằng Google"
// before the box is ticked says so under the box (bindAuth), never in a toast.
function authView(){
 const registration=state.reader.registration||{},closed=registration.mode==='closed',googleOnly=registration.mode==='domain',single=closed||googleOnly,domains=googleOnly&&Array.isArray(registration.domains)?registration.domains.map(esc).join(' hoặc '):'';
 const terms='<a href="/dieu-khoan" target="_blank" rel="noopener">Điều khoản sử dụng</a> và <a href="/quyen-rieng-tu" target="_blank" rel="noopener">Chính sách quyền riêng tư</a>';
 const tabs=single?'':'<div class="auth-tabs" role="tablist" aria-label="Đăng nhập hoặc tạo tài khoản"><button type="button" class="active" role="tab" id="auth-tab-login" aria-selected="true" aria-controls="auth-panel-login" data-auth-tab="login">Đăng nhập</button><button type="button" role="tab" id="auth-tab-register" aria-selected="false" aria-controls="auth-panel-register" tabindex="-1" data-auth-tab="register">Tạo tài khoản</button></div>';
 const policy=closed?'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.':!googleOnly?'':state.reader.googleConfigured?`Tài khoản mới chỉ tạo được bằng nút Tiếp tục bằng Google, với email thuộc ${domains}.`:`Tài khoản mới chỉ tạo được bằng đăng nhập Google với email thuộc ${domains}, nhưng máy chủ chưa cấu hình đăng nhập Google. Hãy liên hệ quản trị viên.`;
 // No e-mail is sent: the administrator creates a one-time link (contract 7), asked for at the address in the Terms'
 // contact section (CONTACT_LINK).
 const forgot=`<details class="auth-forgot more"><summary>Quên mật khẩu?</summary><div class="more-body"><p>Hoa Trí không gửi email. Hãy nhắn quản trị viên (xem ${CONTACT_LINK}) kèm email đăng nhập để nhận liên kết đặt lại; liên kết dùng một lần, trong 24 giờ.</p>${state.reader.googleConfigured?'<p>Tài khoản Google không có mật khẩu: bấm “Tiếp tục bằng Google”.</p>':''}</div></details>`;
 const login=`<form id="reader-login-form" class="auth-form"${single?' aria-labelledby="auth-title"':''}>${formError('reader-login-error')}<label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128"></label><button class="primary" type="submit">Đăng nhập</button>${forgot}${policy?`<p class="auth-note" role="note">${policy}</p>`:''}</form>`;
 const register=single?'':`<form id="reader-register-form" class="auth-form">${formError('reader-register-error')}<label>Tên hiển thị<input name="name" autocomplete="name" required maxlength="100"></label><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="register-password-rule"><small class="field-hint" id="register-password-rule">${PASSWORD_RULE}</small></label><label class="terms-check"><input name="acceptTerms" type="checkbox" required data-terms-check> <span>Tôi đồng ý với ${terms}.</span></label><button class="primary" type="submit">Tạo tài khoản</button></form>`;
 // The tab panels wrap the forms: a form keeps its own role.
 const panels=single?login:`<div class="auth-panel" role="tabpanel" id="auth-panel-login" aria-labelledby="auth-tab-login">${login}</div><div class="auth-panel" role="tabpanel" id="auth-panel-register" aria-labelledby="auth-tab-register" hidden>${register}</div>`;
 // A request started while signed out comes back after sign-in, also from Google (return_to=/#yeu-cau).
 const pending=state.pendingRequest?`<p class="auth-note auth-pending" role="note">Đăng nhập xong, hộp Yêu cầu dịch sẽ ${requestDraftHasText()?'mở lại với nội dung bạn đã nhập':'tự mở'}.</p>`:state.afterSignIn?`<p class="auth-note auth-pending" role="note">Đăng nhập xong, bạn sẽ quay lại ${state.afterSignIn==='/study'?'Xưởng dịch':'tài liệu đang mở'}.</p>`:'';
 const google=state.reader.googleConfigured?`<div class="auth-divider"><span>hoặc</span></div><label class="terms-check google-terms-check" id="google-terms-row"><input type="checkbox" data-terms-check> <span>Tôi đồng ý với ${terms}.</span></label><p class="field-error" id="google-terms-error" role="alert"></p><a class="google-login" id="google-login" href="${esc(googleHref(Boolean(state.termsAccepted)))}" aria-disabled="${!state.termsAccepted}" aria-describedby="google-terms-error${domains?' google-domain-hint':''}"><span aria-hidden="true">G</span> Tiếp tục bằng Google</a>${closed?'<small class="field-hint google-terms">Chỉ tài khoản Google đã đăng ký mới đăng nhập được.</small>':domains?`<small class="field-hint google-terms" id="google-domain-hint">Tài khoản Google mới cần email thuộc ${domains}.</small>`:''}`:'';
 // A Google sign-in that came back with ?loi= (takeAfterSignIn) says why, first.
 const failure=state.googleFailure?`<p class="form-error auth-failure" role="alert" tabindex="-1" data-focus-first>${esc(googleFailureText(state.googleFailure))}</p>`:'';
 return `<section class="account-auth"><div class="auth-forms panel"><h1 id="auth-title">Đăng nhập</h1><p class="auth-lead">Thư viện chung đọc được không cần đăng nhập.</p>${failure}${pending}${tabs}${panels}${google}</div></section>`;
}
// The same picture and initials in the header and on the account page (site-header.js draws the static pages' header).
function avatarOf(user){
 const name=String(user?.name||'').trim()||'Tài khoản',words=name.split(/\s+/u),initials=(words[0][0]+(words.length>1?words.at(-1)[0]:'')).toLocaleUpperCase('vi-VN');
 return {name,initials,picture:/^https:\/\//u.test(String(user?.picture||''))?String(user.picture):''};
}
// A date the server wrote ("2026-10-01 08:00:00", UTC as SQLite writes it, or ISO) as the reader's own day, dd/mm/yyyy.
function dayText(value){
 const text=String(value||''),date=new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)?`${text.replace(' ','T')}Z`:text);
 return text&&!Number.isNaN(date.getTime())?date.toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric'}):'';
}
// In a list the day is short (dd/mm), the full date in its tooltip.
function dayShort(value){const day=dayText(value);return day?`<span title="${day}">${day.slice(0,5)}</span>`:'';}
// Why the server flagged a password that still signs in (POST /api/auth/login weakPassword).
const WEAK_REASONS={password_common:'Mật khẩu này quá phổ biến, dễ bị đoán.',password_pattern:'Mật khẩu này theo quy luật dễ đoán.',password_like_email:'Mật khẩu này giống email hoặc tên của bạn, dễ bị đoán.'};
// A request: its title, what was sent (a file's name, or "Liên kết") and the day, one state; a finished one opens its book.
const REQUEST_STATES={pending:['Mới',''],accepted:['Đang dịch','warn'],done:['Đã xong','ok']};
const requestRow=r=>{const [label,tone]=REQUEST_STATES[r.status]||REQUEST_STATES.pending,what=r.filename?esc(r.filename):r.source_url?'Liên kết':'',readable=r.status==='done'&&r.story_id&&[...state.myLibrary,...state.library].some(book=>book.id===r.story_id&&Number(book.chapters)>0);return `<li class="row request-row" data-request-row="${esc(r.id)}"><div class="row-text"><h3 class="row-title" title="${esc(r.title)}">${esc(r.title)}</h3>${what||r.created_at?`<p class="row-meta">${[what,dayShort(r.created_at)].filter(Boolean).join(' · ')}</p>`:''}</div><div class="row-side">${r.visibility==='public'?'<span class="chip">Thư viện chung</span>':''}<span class="chip"${tone?` data-tone="${tone}"`:''}>${label}</span>${readable?`<button type="button" class="quiet" data-read="${esc(r.story_id)}" aria-label="Đọc ${esc(r.title)}"><span data-read-label="Đọc">Đọc</span></button>`:''}</div></li>`;};
// Contract 8 on the account page: a list that did not load is an error card with "Thử lại", never an empty state.
function accountView(){
 if(!state.loaded)return `<section class="account-loading"><span class="skeleton skeleton-title"></span>${skeletonCards(3)}</section>`;
 const notice=state.accountNotice?`<p class="account-notice status" data-tone="ok" role="status" tabindex="-1" data-focus-first>${esc(state.accountNotice)}</p>`:'';
 if(!state.reader.authenticated)return state.errors?.me?`<section class="account-error"><h1>Tài khoản</h1>${errorCard('Chưa tải được tài khoản',state.errors.me,'account')}</section>`:notice+authView();
 const u=state.reader.user||{},avatar=avatarOf(u),errors=state.errors||{};
 const books=errors.myLibrary?errorCard('Chưa tải được Thư viện riêng',errors.myLibrary,'account',{primary:false}):`${errors.studyBooks?errorCard('Chưa đọc được các phần sách của bạn',errors.studyBooks,'account',{primary:false}):''}${state.myLibrary.length?`<ul class="rows personal-library">${personalBookCards()}</ul>`:'<div class="empty-line account-empty"><p>Chưa có tài liệu.</p><a class="hero-cta hero-cta-primary" href="/study">Dịch tài liệu đầu tiên</a></div>'}`;
 const requests=errors.myRequests?errorCard('Chưa tải được yêu cầu dịch của bạn',errors.myRequests,'account',{primary:false}):state.myRequests.length?`<ul class="rows my-requests">${state.myRequests.map(requestRow).join('')}</ul>`:'<p class="empty-line account-empty">Chưa có yêu cầu dịch.</p>';
 // An account with a password changes it here (the current one confirms it); any account can end its other sessions,
 // e.g. one left open on a school computer.
 const local=u.provider!=='google';
 const weak=state.weakPassword&&local?`<p class="note account-warning" data-tone="warn" role="note">${esc(WEAK_REASONS[state.weakPassword]||'Mật khẩu này dễ bị đoán.')} <button type="button" id="weak-password-change">Đổi mật khẩu</button></p>`:'';
 const security=`<section class="personal-section account-security" aria-labelledby="account-security-title"><div class="section-head"><h2 id="account-security-title">Bảo mật tài khoản</h2></div>${local?`<form id="password-change-form" class="auth-form account-password" aria-labelledby="password-change-title"><h3 id="password-change-title">Đổi mật khẩu</h3>${formError('password-change-error')}<label>Mật khẩu hiện tại<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-change-rule"><small class="field-hint" id="password-change-rule">${PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu mới<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button class="secondary" type="submit">Đổi mật khẩu</button></form>`:'<p class="account-security-note">Tài khoản Google không có mật khẩu riêng ở Hoa Trí.</p>'}<div class="account-sessions"><h3>Nơi đang đăng nhập</h3><button type="button" id="logout-all">Đăng xuất khỏi mọi thiết bị…</button></div></section>`;
 const remove=`<section class="personal-section account-delete" aria-labelledby="account-delete-title"><div class="section-head"><h2 id="account-delete-title">Xóa tài khoản</h2></div><p>Xóa vĩnh viễn tài khoản và mọi dữ liệu riêng. Không thể hoàn tác.</p><p class="account-delete-links"><button type="button" class="danger" id="delete-account">Xóa tài khoản…</button><a class="button quiet" href="/quyen-rieng-tu#thoi-gian">Dữ liệu nào bị xóa</a></p></section>`;
 return `<section class="account-heading"><div class="account-profile">${avatar.picture?`<img src="${esc(avatar.picture)}" alt="" width="48" height="48" referrerpolicy="no-referrer">`:`<span aria-hidden="true">${esc(avatar.initials)}</span>`}<div><h1>${esc(u.name||'Tài khoản')}</h1><p class="account-email">${esc(u.email)}</p></div></div><button type="button" class="quiet" id="reader-logout">Đăng xuất</button></section>${notice}${weak}<section class="personal-section"><div class="section-head"><h2>Thư viện riêng</h2></div>${books}</section><section class="personal-section"><div class="section-head"><h2>Yêu cầu của tôi</h2><div class="section-actions"><button type="button" class="quiet" id="account-request">+ Yêu cầu dịch</button></div></div>${requests}</section>${security}${remove}`;
}
// #dat-lai-mat-khau: a checked link waits for "Tiếp tục" (checkResetLink), then a new password with the token it was
// traded for (in memory only, see takeResetToken). Without a token (the page was reloaded, or the link was refused) the
// page says how to get a working link instead of showing a form. One card per state, under one heading.
const resetExpiry=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('vi-VN',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'});};
function resetView(){
 const ready=state.loaded&&!state.resetOpening,until=state.resetLink?resetExpiry(state.resetLink.expiresAt):'';
 const body=state.resetToken?`<form id="password-reset-form" class="auth-form" aria-labelledby="reset-title">${formError('password-reset-error')}<label>Mật khẩu mới<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-reset-rule"><small class="field-hint" id="password-reset-rule">${PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button class="primary" type="submit">Lưu mật khẩu mới</button><p class="field-hint">Lưu xong bạn được đăng nhập; các thiết bị khác bị đăng xuất.</p></form>`
  :state.resetLink?`<div class="reset-ready"><p>${until?`Liên kết dùng được đến ${esc(until)}. `:''}Sau khi bấm Tiếp tục, liên kết không mở lại được.</p><button type="button" class="primary" id="reset-continue">Tiếp tục</button></div>`
  :`<div class="reset-unavailable"${state.resetFailed?' role="alert"':''}><p${state.resetFailed?' tabindex="-1" data-focus-first':''}>${state.resetFailed?`${esc(state.resetFailed)} Địa chỉ ở ${CONTACT_LINK}.`:`Liên kết đã dùng, hết hạn, hoặc mất khi tải lại trang. Hãy xin quản trị viên liên kết mới (${CONTACT_LINK}).`}</p><a class="hero-cta" href="/#account">Đến trang đăng nhập</a></div>`;
 if(!ready)return `<section class="account-auth reset-auth"><div class="auth-forms panel" role="status" aria-label="Đang chuẩn bị biểu mẫu"><h1 id="reset-title">Đặt lại mật khẩu</h1><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span></div></section>`;
 return `<section class="account-auth reset-auth"><div class="auth-forms panel"><h1 id="reset-title">Đặt lại mật khẩu</h1>${body}</div></section>`;
}
// A note is centred on its [n] but kept 8px inside the screen (its box: min(340px,75vw) plus 28px padding and the border);
// on a phone most references sit nearer an edge than half a note.
function placeFootnote(ref){const view=document.documentElement.clientWidth,width=Math.min(340,innerWidth*.75)+30,box=ref.getBoundingClientRect(),centre=box.left+box.width/2,left=Math.max(8,Math.min(centre-width/2,view-width-8));ref.style.setProperty('--note-shift',`${Math.round(left-(centre-width/2))}px`);}
// A note is shown as written, its line breaks joined: "tr. 239–240", "trang 45" are the pages of a cited work or a table,
// part of what the student reads and cites (the stored and downloaded translation keep them too).
const cleanFootnoteDisplay=content=>String(content||'').replace(/\s+/gu,' ').trim();
function readerFootnotes(content){
 const text=String(content||''),matches=[...text.matchAll(/(?:^|\n)\[(\d{1,3})\]\s*/g)];let start=-1;
 for(let i=0;i<matches.length;i++){const tail=matches.slice(i),numbers=tail.map(match=>Number(match[1])),ordered=numbers.every((number,index)=>index===0||number>=numbers[index-1]);if(tail.length>=3&&ordered){start=i;break;}}
 if(start<0)return {body:text,notes:[]};const notes=matches.slice(start).map((match,index,list)=>({number:Number(match[1]),content:cleanFootnoteDisplay(text.slice(match.index+match[0].length,list[index+1]?.index??text.length))})).filter(note=>note.content);return {body:text.slice(0,matches[start].index).trim(),notes};
}
function readerProse(content){
 const parsed=readerFootnotes(content),lookup=new Map(parsed.notes.map(note=>[note.number,note.content]));let body='',start=0;
 for(const match of parsed.body.matchAll(/\[(\d{1,3})\]/gu)){const note=lookup.get(Number(match[1]));if(!note)continue;body+=renderMathText(parsed.body.slice(start,match.index),{bare:false})+`<button type="button" class="footnote-ref" data-note="${esc(note)}" aria-label="Chú thích ${match[1]}" aria-expanded="false" aria-describedby="note-${match[1]}">[${match[1]}]</button>`;start=match.index+match[0].length;}
 body+=renderMathText(parsed.body.slice(start),{bare:false});return {html:body,notes:parsed.notes};
}
// Contract 8: a load failure is a card where the content belongs, with "Thử lại"; a 401 also offers to sign in (on the
// account page itself "Thử lại" leads to the sign-in form).
// heading: 'h1' where the card is the whole page (the reader). back: a signed-out reader's book and part (reader/<id>/<n>);
// /api/read answers 404, not 401, for a private book, so the card offers to sign in and come back there.
// primary:false where the page already leads with another action (the home page, a part of the account page), so
// "Thử lại" never adds a second red button.
function errorCard(title,error,retry,{heading='h2',back='',library=false,primary=true}={}){const signIn=(error?.status===401||Boolean(back))&&state.route!=='account';return `<div class="panel load-error" role="alert"><${heading}>${esc(title)}</${heading}><p>${esc(error?.message||'Đã có lỗi khi tải dữ liệu.')}${back?' Nếu là tài liệu riêng của bạn, hãy đăng nhập.':''}</p><div class="button-row">${signIn?`<a class="button primary load-error-link" href="/#account${back?`?sau=${esc(back)}`:''}">Đăng nhập</a>`:''}<button type="button" class="${signIn||!primary?'secondary':'primary'}" data-retry="${retry}">Thử lại</button>${library?'<button type="button" class="quiet" data-route="library">Về Thư viện</button>':''}</div></div>`;}
// A part of the student's own book an older extractor read: said above it, with the way to update it.
function readerOutdatedNotice(chapter){
 const part=state.readerStory?.study?outdatedParts(state.readerStory.id).find(item=>item.id===chapter?.id):null;if(!part)return '';const blocks=Number(part.refresh?.blocks)||0;
 return `<aside class="note sample-notice layout-outdated" data-tone="warn" role="note"><strong>Bố cục cũ:</strong> tiêu đề, chú thích có thể chưa được dịch. <a href="${esc(refreshLink(part))}">Cập nhật</a> (${blocks?`${blocks} đoạn cần dịch; `:''}chỉ đoạn mới hoặc đổi vùng chữ tốn token).</aside>`;
}
// Only a book in the public library has a link others can open.
const shareable=()=>Boolean(state.readerStory?.id&&state.library.some(item=>item.id===state.readerStory.id));
function readerView(){
 const c=state.chapters[state.chapter];
 if(!c){
  if(state.readerError){const {storyId,part}=state.readerError,back=!state.reader.authenticated&&storyId?`reader/${encodeURIComponent(storyId)}/${part||1}`:'';return `<div class="reader-layout">${errorCard('Không mở được tài liệu này',state.readerError,'reader',{heading:'h1',back,library:true})}</div>`;}
  return state.readerPending||!state.loaded?'<div class="reader-layout" role="status" aria-label="Đang mở tài liệu"><span class="skeleton skeleton-title"></span><span class="skeleton reader-skeleton"></span></div>':'<div class="empty">Chọn một tài liệu trong thư viện để đọc.</div>';
 }
 const pdf=c.mime==='application/pdf',reading=pdf?null:readerProse(c.content),many=state.chapters.length>1;
 // One slim row: library, share, the part, then page colour, Chinese lookup, font size and listening. On a phone the
 // row keeps library, part and "Tùy chọn"; the rest opens under it on demand (style.css), so the first screen shows
 // reading text.
 return `<div class="reader-layout"><div class="reader-toolbar${state.readerMore?' is-more-open':''}" role="toolbar" aria-label="Công cụ đọc tài liệu">
 <div class="reader-start"><button class="reader-back" data-route="library" title="Về Thư viện">${icon('book')}<span>Thư viện</span></button>${shareable()?`<button type="button" class="reader-share" id="reader-share" title="Chia sẻ liên kết đến phần này">${icon('share')}<span>Chia sẻ</span></button><span class="sr-only" id="reader-share-status" role="status"></span>`:''}</div>
 <label class="reader-chapter-picker"><span class="sr-only">Phần</span><select id="reader-chapter-select" aria-label="Chọn phần đang đọc">${state.chapters.map((chapter,index)=>`<option value="${index}" ${index===state.chapter?'selected':''}>${index+1}. ${esc(chapter.title)}</option>`).join('')}</select></label>
 <button type="button" class="reader-more-toggle" id="reader-more-toggle" aria-expanded="${Boolean(state.readerMore)}" aria-controls="reader-more" title="Màu trang, cỡ chữ, nghe đọc và tra chữ Hán">${icon('settings')}<span>Tùy chọn</span></button>
 <div class="reader-more" id="reader-more"><div class="reader-options"><div class="reader-control-group theme-options" role="group" aria-label="Màu trang sách">${[['paper','paper','Màu giấy'],['light','sun','Nền sáng'],['night','moon','Ban đêm']].map(([theme,glyph,label])=>`<button class="reader-icon theme-${theme}" data-reader-theme="${theme}" aria-label="${label}" title="${label}" aria-pressed="${state.theme===theme}">${icon(glyph)}</button>`).join('')}</div><div class="reader-control-group" role="group" aria-label="Tra cứu chữ Hán"><button class="reader-icon" id="hanzi-open" aria-label="Tra chữ Hán: pinyin, âm Hán Việt và nghĩa" title="Tra chữ Hán"><span class="font-symbol" lang="zh-Hans" aria-hidden="true">字</span></button></div>
 ${!pdf?`<div class="reader-control-group font-options" role="group" aria-label="Cỡ chữ"><button class="reader-icon" id="font-smaller" title="Giảm cỡ chữ" aria-label="Giảm cỡ chữ" ${state.fontSize<=16?'disabled':''}><span class="font-symbol">A−</span></button><output class="font-value" aria-live="polite" aria-label="Cỡ chữ hiện tại">${state.fontSize}</output><button class="reader-icon" id="font-larger" title="Tăng cỡ chữ" aria-label="Tăng cỡ chữ" ${state.fontSize>=30?'disabled':''}><span class="font-symbol">A+</span></button></div>`:''}</div>
 ${!pdf?`<div class="reader-audio" role="group" aria-label="Đọc thành tiếng"><button type="button" class="reader-listen${state.speaking?' is-speaking':''}" id="speak" title="${state.speaking?'Dừng đọc':'Nghe đọc tiếng Việt'}">${icon(state.speaking?'stop':'headphones')}<span>${state.speaking?'Dừng':'Nghe'}</span></button></div>`:''}</div>
 </div><article class="reader ${state.theme}">${state.readerStory?.title?`<p class="reader-book-title">${esc(state.readerStory.title)}</p>`:''}<h1 tabindex="-1">${esc(c.title)}</h1>${c.source_url?`<p class="chapter-source">${sourceLink(c.source_url,'Nguyên tác ↗','Nguồn: ')}</p>`:''}${sampleReaderNotice(state.readerStory,c)}${readerOutdatedNotice(c)}${pdf?`<div class="reader-pdf-tools" id="reader-pdf-tools">${pdfTools(c)}</div><div id="book-download-slot">${wholeBookPdf()?bookDownloadPanel():''}</div><div class="reader-pdf-area" id="reader-pdf-area">${pdfFrame(c)}</div>`:`<div class="prose" style="font-size:${state.fontSize}px">${reading.html}</div>${reading.notes.length?`<details class="footnotes-panel"><summary>Chú thích <span>${reading.notes.length}</span></summary><ol>${reading.notes.map(note=>`<li id="note-${note.number}"><b>[${note.number}]</b> ${renderMathText(note.content,{bare:false})}</li>`).join('')}</ol></details>`:''}`}</article>
 ${many?`<nav class="reader-pagination" aria-label="Chuyển phần"><button id="prev-chapter" ${state.chapter===0?'disabled':''}>← <span>Phần trước</span></button><span class="chapter-position">${state.chapter+1}<small> / ${state.chapters.length}</small></span><button id="next-chapter" ${state.chapter===state.chapters.length-1?'disabled':''}><span>Phần tiếp</span> →</button></nav>`:''}</div>`;
}
// "Tải cả quyển (PDF)". A student's own book, and a public book whose parts record their original pages (assembly), is
// rebuilt like the original on this device: every page of each original file, translated pages in place, cover and
// untranslated pages as printed. Other books (or a student who has no original at hand) get the parts joined in reading
// order. A whole book can pass 100 MB, beyond what the Worker can buffer, while every part is already a finished PDF;
// pdf-lib and pdf.js load only when this is used.
function wholeBookPdf(){const pdfs=state.chapters.filter(chapter=>chapter.mime==='application/pdf').length;return state.readerStory?.study||state.readerStory?.assembly?pdfs>0:state.chapters.length>1&&pdfs===state.chapters.length;}
const bookFilename=title=>(String(title||'').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'-').replace(/[.\s]+$/u,'').slice(0,150)||'Hoa Trí')+'.vi.pdf';
let bookLibraries=null,localSources=new Map();
function loadBookLibraries(){
 bookLibraries??=Promise.all([import('/vendor/pdf-lib.esm.min.js'),import('/vendor/pdf.mjs'),import('/book-assembly.js'),import('/cover-detect.js')]).then(([PDFLib,pdfjs,assembly,covers])=>{pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';return {PDFLib,pdfjs,assembly,covers};});
 return bookLibraries.catch(error=>{bookLibraries=null;throw error;});
}
// What "Cả quyển (PDF)" (the "Tải về" menu) reports under the PDF row: its progress or result (only while working or
// done), the originals to pick, a join-only way out, notes and the cover offer. Empty while nothing was asked.
function bookDownloadPanel(){
 const d=state.bookDownload||{};
 const pick=d.pick?`<div class="book-pick note" data-tone="warn" role="group" aria-labelledby="book-pick-title"><strong id="book-pick-title">Cần PDF gốc để ghép bìa và các trang chưa dịch</strong><p>Tệp chỉ dùng trên thiết bị này, không tải lên.</p><ul>${d.pick.sources.map(source=>`<li>${esc(source.filename||'Tệp gốc')} · ${source.totalPages?`${source.totalPages} trang`:'chưa rõ số trang'}${localSources.has(source.key)?' · đã chọn':''}</li>`).join('')}</ul>${d.pick.errors?.length?`<ul class="book-pick-errors" role="alert">${d.pick.errors.map(error=>`<li>${esc(error)}</li>`).join('')}</ul>`:''}<div class="book-pick-actions"><label class="book-pick-file button secondary"><span>Chọn PDF gốc…</span><input type="file" id="book-pick-input" accept="application/pdf,.pdf" multiple ${d.busy?'disabled':''}></label><button type="button" class="quiet" id="book-join-only" ${d.busy?'disabled':''}>Chỉ ghép các phần đã dịch</button></div></div>`:'';
 const join=!d.pick&&d.offerJoin?`<button type="button" class="quiet book-join-secondary" id="book-join-only">Chỉ ghép các phần đã dịch</button>`:'';
 const offer=d.coverOffer?`<div class="book-cover-offer note"><img src="${d.coverOffer.url}" alt="Trang ${d.coverOffer.page} của bản gốc" width="48" height="68"><p>Dùng trang ${d.coverOffer.page} của bản gốc làm ảnh bìa sách?</p><button type="button" id="book-cover-offer">Đặt làm ảnh bìa</button></div>`:'';
 return `<div class="book-download"><p id="book-download-status" class="status" role="status" aria-live="polite">${esc(d.pick?'':d.message||'')}</p>${pick}${join}${d.notes?.length||d.outdated?.length?`<ul class="book-download-notes">${(d.notes||[]).map(note=>`<li>${esc(note)}</li>`).join('')}${(d.outdated||[]).map(part=>`<li>${outdatedNote(part)}.</li>`).join('')}</ul>`:''}${offer}</div>`;
}
// Only the download box is redrawn, so the open PDF does not reload; the menu's "Cả quyển (PDF)" waits while it works.
function renderBookDownload(){const box=$('.book-download');if(box){box.outerHTML=bookDownloadPanel();bindBookDownload();}const button=$('#download-whole-book');if(button)button.disabled=Boolean(state.bookDownload?.busy);}
function renderBookDownloadSlot(){const slot=$('#book-download-slot');if(slot){slot.innerHTML=wholeBookPdf()?bookDownloadPanel():'';bindBookDownload();}}
// The panel's own controls ("Cả quyển (PDF)" itself is bound with the PDF row, bindPdfTools). Inside Zalo, Facebook…
// (in-app-browser.js) a downloaded file is often dropped: the student is offered Chrome or Safari first.
function bindBookDownload(){on('#book-join-only','click',()=>downloadWholeBook({joinOnly:true}));on('#book-pick-input','change',event=>pickOriginals([...event.target.files]));on('#book-cover-offer','click',useOfferedCover);}
function saveBookFile(bytes,title){const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=bookFilename(title);document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
const knownError=message=>Object.assign(new Error(message),{known:true});
async function downloadWholeBook({joinOnly=false}={}){
 if(state.bookDownload?.busy||!wholeBookPdf())return;
 const story=state.readerStory||{},chapters=state.chapters.slice(),title=story.title||'Hoa Trí',keep=state.bookDownload?.coverOffer?{coverOffer:state.bookDownload.coverOffer}:{};
 const progress=(message,busy=true)=>{state.bookDownload={...state.bookDownload,busy,message};const node=$('#book-download-status'),button=$('#download-whole-book');if(node)node.textContent=message;if(button)button.disabled=busy;};
 state.bookDownload={busy:true,message:'Đang chuẩn bị công cụ ghép PDF…',...keep};renderBookDownload();
 try{
  const libs=await loadBookLibraries();let joinNote='';
  if((story.study||story.assembly)&&!joinOnly){
   const info=await api(story.study?`/my/study/books/${encodeURIComponent(story.id)}/assembly`:`/library/${encodeURIComponent(story.id)}/assembly`),{sources:found,unplaced}=libs.assembly.bookSources(info.parts),stored=new Map(info.storedSources.map(item=>[item.sha256,item]));
   // A finished PDF part of a public book that maps no page of an original (uploaded with "Tải bản đã dịch lên") is
   // joined after the rebuilt original, in book order, instead of being left out of the book.
   const appended=part=>libs.assembly.hasTranslatedPdf(part)||!story.study&&part.mime==='application/pdf'&&Boolean(part.file);
   // A file none of whose parts has a Vietnamese PDF yet adds no translated page, so its original is not asked for; those
   // parts, and text parts of no known file, are named in the notes instead of silently missing.
   const sources=found.filter(source=>source.parts.some(libs.assembly.hasTranslatedPdf)),waiting=[...found.filter(source=>!sources.includes(source)).flatMap(source=>source.parts),...unplaced.filter(part=>!appended(part))];
   if(sources.length){
    const missing=sources.filter(source=>!(source.sha256&&stored.has(source.sha256))&&!localSources.has(source.key));
    // A student can pick their own original on this device; a reader of a public book cannot, so its parts are joined.
    if(missing.length&&story.study){state.bookDownload={busy:false,message:'Cần PDF gốc để ghép đủ bìa và các trang chưa dịch.',pick:{sources:missing,errors:[]}};renderBookDownload();return;}
    // The pages a whole-book run of this book found blank come from its part but count as kept, as Xưởng dịch
    // counts them.
    const blank=story.study?libs.assembly.blankPages(await api('/my/study/book-jobs').then(data=>data?.jobs,()=>[]),story.id):new Map();
    if(!missing.length)return await assembleLikeOriginal(libs,info,sources,stored,title,progress,{extras:unplaced.filter(appended),waiting,offerCover:Boolean(story.study),library:!story.study,blank});
    joinNote='Sách chưa có PDF gốc trên máy chủ nên chỉ ghép các phần đã dịch.';
   }
  }
  await joinParts(libs,chapters,title,story,progress,joinNote);
 }catch(error){
  state.bookDownload={busy:false,message:'',offerJoin:Boolean((story.study||story.assembly)&&!joinOnly)};renderBookDownload();
  // The server's own words (a database behind the code names start.cmd, a part gone…) and a lost connection are said as
  // they are; only a failure on this device is told it may be its memory.
  throw error?.known||error?.code||Number.isInteger(error?.status)?error:new Error('Không ghép được cả quyển trên thiết bị này (có thể do thiếu bộ nhớ). Hãy thử lại hoặc mở từng phần.');
 }
}
// A library reader has neither Xưởng dịch nor a Thư viện riêng: a part that is not in the file is simply named.
const libraryMissingNote=part=>part.mime==='application/pdf'?`Phần “${part.title}” chưa có PDF tiếng Việt nên không có trong tệp ghép.`:`Phần “${part.title}” là bản dịch dạng chữ, không có trang PDF, nên không có trong tệp ghép; phần này vẫn đọc được trong Thư viện.`;
// "5, 7–9": the printed book's pages an excerpt original holds.
const pageRunText=pages=>{const out=[];for(let i=0;i<pages.length;i++){const start=pages[i];while(pages[i+1]===pages[i]+1)i++;out.push(start===pages[i]?String(start):`${start}–${pages[i]}`);}return out.join(', ');};
async function assembleLikeOriginal({PDFLib,pdfjs,assembly,covers},info,sources,stored,title,progress,{extras=[],waiting=[],offerCover=true,library=false,blank=new Map()}={}){
 const counts=new Map(sources.map(source=>[source.key,localSources.get(source.key)?.pageCount??(source.sha256&&stored.get(source.sha256)?.pages)??source.totalPages]));
 // A student's book without a cover (and not marked "no cover") is offered the cover found on its first original.
 const wantCover=offerCover&&!info.cover?.image&&info.cover?.page!==0;let coverOffer=null;
 const loadSource=async source=>{
  const local=localSources.get(source.key);let bytes;
  if(local)bytes=new Uint8Array(await local.file.arrayBuffer());
  else{const response=await fetch(stored.get(source.sha256).url,{credentials:'same-origin'});if(!response.ok)throw knownError(`Không tải được PDF gốc “${source.filename}”. Hãy thử lại sau.`);bytes=new Uint8Array(await response.arrayBuffer());}
  if(wantCover&&source===sources[0])try{const found=await covers.detectCoverInBytes(bytes);if(found.page&&found.jpeg)coverOffer={page:found.page,jpeg:found.jpeg,url:URL.createObjectURL(found.jpeg),sha256:source.sha256||''};}catch{}
  return bytes;
 };
 const loadPart=async part=>{const response=await fetch(part.file,{credentials:'same-origin'});if(!response.ok)throw knownError(`Không tải được phần “${part.title}”. Hãy thử lại sau.`);return response.arrayBuffer();};
 const result=await assembly.assembleBook({PDFLib,pdfjs,title,sources,loadSource,loadPart,extras,blank,pageCounts:counts,onProgress:(done,total)=>progress(`Đang ghép trang ${done}/${total}…`)});
 progress('Đang lưu tệp PDF…');saveBookFile(result.bytes,title);
 // An original kept as an excerpt (a sample: the cover and the translated pages) says which pages of the book it holds.
 const excerpts=sources.map(source=>stored.get(source.sha256)?.bookPages).filter(pages=>Array.isArray(pages)&&pages.length).map(pages=>`PDF gốc của sách này là bản trích đoạn, chỉ gồm trang ${pageRunText(pages)} của sách in.`);
 const notes=[...new Set([...excerpts,...sources.map(source=>localSources.get(source.key)?.warning).filter(Boolean),...result.plan.warnings,...waiting.map(part=>library?libraryMissingNote(part):assembly.missingPdfNote(part,{inBook:false}))])];
 state.bookDownload={busy:false,message:`Đã ghép ${result.pages} trang như bản gốc. ${assembly.coverageNote(result.plan)}`,notes,coverOffer,outdated:library?[]:(info.parts||[]).filter(part=>part.layoutOutdated===true&&part.sessionId)};renderBookDownload();
}
// Parts without a Vietnamese PDF (text translations, ranges not exported yet) cannot be joined; they are named, not dropped silently.
async function joinParts({PDFLib,assembly},chapters,title,story,progress,joinNote=''){
 const parts=chapters.filter(chapter=>chapter.mime==='application/pdf'),notes=[...(joinNote?[joinNote]:[]),...chapters.filter(chapter=>!parts.includes(chapter)).map(chapter=>`Phần “${chapter.title}” chưa có PDF tiếng Việt nên không có trong tệp ghép; phần này vẫn đọc được ${story.study?'trong Thư viện riêng':'trong Thư viện'}.`)];
 const cover=(story.study||story.assembly)&&story.cover?await bookCoverImage(story.id).catch(()=>null):null;
 const loadPart=async part=>{const index=parts.indexOf(part)+1,response=await fetch(`/api/chapter-file/${encodeURIComponent(part.id)}`,{credentials:'same-origin'});if(!response.ok)throw knownError(`Không tải được phần ${index} “${part.title}”. Hãy thử lại sau.`);return response.arrayBuffer();};
 const result=await assembly.concatenateParts({PDFLib,title,parts,loadPart,cover,onProgress:(index,total)=>progress(`Đang ghép phần ${index}/${total}…`)});
 progress('Đang lưu tệp PDF…');saveBookFile(result.bytes,title);
 state.bookDownload={busy:false,message:`Đã ghép ${parts.length} phần · ${result.pages} trang${cover?' · có ảnh bìa ở trang đầu':''}.`,notes,outdated:story.study?outdatedParts(story.id):[]};renderBookDownload();
}
// pdf-lib embeds JPEG and PNG; a WebP cover is redrawn as JPEG first.
async function bookCoverImage(storyId){
 const response=await fetch(`/api/covers/${encodeURIComponent(storyId)}`,{credentials:'same-origin'});if(!response.ok)return null;
 const type=response.headers.get('Content-Type')||'',bytes=new Uint8Array(await response.arrayBuffer());if(['image/jpeg','image/png'].includes(type))return {type,bytes};
 const bitmap=await createImageBitmap(new Blob([bytes],{type})),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));return blob?{type:'image/jpeg',bytes:new Uint8Array(await blob.arrayBuffer())}:null;
}
// The original is checked against the parts before use: same hash, or (parts saved before hashes existed) same page count.
async function pickOriginals(files){
 const pick=state.bookDownload?.pick;if(!pick||!files.length)return;
 state.bookDownload={...state.bookDownload,busy:true,message:'Đang kiểm tra PDF gốc…'};renderBookDownload();
 let libs;try{libs=await loadBookLibraries();}catch{state.bookDownload={...state.bookDownload,busy:false,message:''};renderBookDownload();throw new Error('Không tải được công cụ ghép PDF. Hãy kiểm tra mạng rồi thử lại.');}
 const {assembly,pdfjs}=libs,errors=[];
 for(const file of files){
  if(!/\.pdf$/iu.test(file.name)&&file.type!=='application/pdf'){errors.push(`“${file.name}” không phải tệp PDF.`);continue;}
  const bytes=new Uint8Array(await file.arrayBuffer()),sha256=globalThis.crypto?.subtle?[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''):'';
  let pageCount=0;try{const pdf=await pdfjs.getDocument({data:bytes.slice(),verbosity:0}).promise;pageCount=pdf.numPages;await pdf.loadingTask.destroy();}catch{errors.push(`Không mở được “${file.name}”.`);continue;}
  const open=pick.sources.filter(source=>!localSources.has(source.key));
  const source=open.find(item=>item.sha256&&item.sha256===sha256)||open.find(item=>!item.sha256&&item.filenames?.has(file.name)&&(!item.totalPages||item.totalPages===pageCount))||open.find(item=>!item.sha256&&item.totalPages===pageCount)||(open.length===1?open[0]:null);
  if(!source){errors.push(`“${file.name}” không khớp tệp gốc nào còn thiếu của sách.`);continue;}
  const check=assembly.checkLocalSource(source,{sha256,pageCount});if(!check.ok){errors.push(check.error);continue;}
  localSources.set(source.key,{file,sha256,pageCount,warning:check.warning||''});
 }
 if(pick.sources.every(source=>localSources.has(source.key))){state.bookDownload={busy:false,message:''};await downloadWholeBook();return;}
 state.bookDownload={busy:false,message:'Cần PDF gốc để ghép đủ bìa và các trang chưa dịch.',pick:{...pick,errors}};renderBookDownload();
}
async function useOfferedCover(){
 const offer=state.bookDownload?.coverOffer,story=state.readerStory;if(!offer||!story?.study)return;
 const form=new FormData();form.set('cover',offer.jpeg,'bia.jpg');form.set('page',String(offer.page));if(offer.sha256)form.set('sha256',offer.sha256);
 await api(`/my/study/books/${encodeURIComponent(story.id)}/cover`,{method:'POST',body:form});
 URL.revokeObjectURL(offer.url);story.cover=true;state.bookDownload={...state.bookDownload,coverOffer:null,message:`Đã đặt trang ${offer.page} của bản gốc làm ảnh bìa sách.`};
 refresh().catch(()=>{});renderBookDownload();
}
function on(sel,event,fn){$(sel)?.addEventListener(event,async e=>{try{await fn(e);}catch(error){toast(error.message);}})}
// Google sign-in or a download inside another app's browser: how to open this page in Chrome or Safari, its address to
// copy (opened there, the page asks to sign in again: the app's browser keeps its own cookies), and "Vẫn tiếp tục".
function leaveInApp(app,{purpose,go:proceed}){
 const {browser,name,menu}=openInBrowserHelp(app),google=purpose==='google',link=location.href;
 modal(`<h2>Mở bằng ${browser} để ${google?'đăng nhập':'tải tệp'}</h2><p class="subtitle">${esc(name)} ${google?'không cho đăng nhập Google':'thường không lưu được tệp tải về'}. ${esc(menu)}, hoặc sao chép địa chỉ rồi dán vào ${browser}.</p><label class="modal-field">Địa chỉ trang<input id="in-app-link" readonly value="${esc(link)}" spellcheck="false"></label><div class="reset-link-actions"><button type="button" id="copy-in-app-link">Sao chép địa chỉ</button><span id="in-app-link-status" role="status"></span></div>`,async()=>{Promise.resolve().then(proceed).catch(error=>toast(error.message));},google?'Vẫn thử đăng nhập':'Vẫn tải ở đây');
 on('#copy-in-app-link','click',async()=>{
  const status=$('#in-app-link-status'),input=$('#in-app-link');
  try{await navigator.clipboard.writeText(link);status.textContent=`Đã sao chép. Mở ${browser} rồi dán vào thanh địa chỉ.`;}
  catch{input?.focus();input?.select();status.textContent='Chưa sao chép được. Địa chỉ đã được chọn: giữ ngón tay trên ô để sao chép.';}
 });
}
// A failed submit keeps the dialog open and says why inside it: the toast would sit behind the modal backdrop.
// The dialog is named by its first heading; when it closes the focus returns to returnFocus() or to what opened it, at
// once when this code closes it (the close event comes one task later, with the focus still on a button of the hidden
// dialog), else on that event (Escape). A dialog replaced by the next one gives nothing back.
let giveFocusBack=null;
function modal(html,submit,confirmLabel='Đóng',{danger=false,returnFocus=null,cancel=true,confirm=true,confirmId=''}={}){const d=$('#modal'),opener=document.activeElement;if(giveFocusBack)d.removeEventListener?.('close',giveFocusBack);giveFocusBack=null;if(d.open)d.close();d.innerHTML=`<form id="modal-form">${html}<p class="modal-error" id="modal-error" role="alert" hidden></p><div class="button-row">${cancel?'<button type="button" id="close-modal">Hủy</button>':''}${confirm?`<button class="primary${danger?' danger-solid':''}"${confirmId?` id="${confirmId}"`:''}>${esc(confirmLabel)}</button>`:''}</div></form>`;const title=d.querySelector?.('h2');if(title){title.id||='modal-title';d.setAttribute('aria-labelledby',title.id);}else d.removeAttribute?.('aria-labelledby');const back=()=>{if(d.open||giveFocusBack!==back)return;giveFocusBack=null;d.removeEventListener?.('close',back);const target=(typeof returnFocus==='function'?returnFocus():returnFocus)||opener;if(target?.isConnected&&target!==document.body){target.focus();return;}const heading=document.querySelector('main h1');if(heading){heading.setAttribute('tabindex','-1');heading.focus();}};giveFocusBack=back;d.addEventListener?.('close',back);d.showModal();const close=()=>{d.close();back();};const cancelButton=$('#close-modal');if(cancelButton)cancelButton.onclick=close;$('#modal-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter,error=$('#modal-error');if(button)button.disabled=true;error.hidden=true;try{await submit(new FormData(e.target));close();}catch(err){if(err?.inline)return;if(d.open){error.textContent=err.message;error.hidden=false;}else toast(err.message);}finally{if(button)button.disabled=false;}};}
// A dialog the page itself closes because the view behind it is gone (the admin signed out, or the session ended): the
// focus is not handed back to what opened it, which is gone too.
function closeModal(){const d=$('#modal');if(giveFocusBack)d?.removeEventListener?.('close',giveFocusBack);giveFocusBack=null;if(d?.open)d.close();}

// Opens a book: straight into the reader for a one-part book or a known part (a link, a reload), else the part picker.
// restore: the address asked for it (no opening animation, the address is replaced instead of added to the history);
// a book that cannot be opened then shows an error card in the reader instead of an empty page, and a part reopened
// this way goes back to where the reader was (READER_PLACE).
// One request brings every part of the book, which takes seconds on a slow network: the tapped book's buttons say
// "Đang mở…" meanwhile, and only the book tapped last opens (an earlier answer that arrives later is dropped).
let openTicket=0;
function markOpening(storyId){
 for(const button of document.querySelectorAll?.('[data-read]')||[]){
  const mine=storyId!==null&&button.dataset?.read===storyId,label=button.querySelector?.('[data-read-label]');
  button.disabled=mine;if(mine)button.setAttribute('aria-busy','true');else button.removeAttribute?.('aria-busy');
  if(label)label.textContent=mine?'Đang mở…':label.dataset.readLabel;
 }
}
function openStory(storyId,{part=null,restore=false}={}){
 const ticket=++openTicket;
 if(restore){state.readerPending=true;state.readerError=null;if(state.route==='reader')render();}else{state.readerPending=false;markOpening(storyId);}
 return chooseChapter(storyId,{part,restore,ticket}).catch(error=>{
  if(ticket!==openTicket)return;
  if(!restore){toast(error.message);return;}
  state.readerError={message:error.message,status:error.status,storyId,part};state.chapters=[];state.route='reader';state.focusAfterRender='heading';render();
 }).finally(()=>{
  if(ticket!==openTicket)return;if(!restore)markOpening(null);
  if(state.readerPending){state.readerPending=false;if(state.route==='reader'&&!state.chapters.length&&!state.readerError)go('library',{replace:true});}
 });
}
function chooseChapter(storyId,{part=null,restore=false,ticket=openTicket}={}){
 const story=[...state.library,...state.myLibrary].find(item=>item.id===storyId);
 return api(`/read/${encodeURIComponent(storyId)}`).then(data=>{
  if(ticket!==openTicket)return;
  // A list of parts; a server that also flags the book may answer {chapters, sample}.
  const chapters=Array.isArray(data)?data:Array.isArray(data?.chapters)?data.chapters:[];
  if(!chapters.length)throw new Error('Tài liệu này chưa có phần nào để đọc.');
  // mappedParts: PDF parts that record their original pages (null from a server that does not say). Such a public book
  // is rebuilt like its original by "Tải cả quyển" (assembly), as a student's own book is.
  const mapped=story?.mapped_parts,mappedParts=mapped===undefined||mapped===null?null:Number(mapped),study=/^study(?:-book)?:/u.test(story?.source_url||'')&&state.myLibrary.some(item=>item.id===storyId);
  // The reader's state changes only when this book is the one opened.
  const open=()=>{state.chapters=chapters;state.readerStory={id:storyId,title:story?.title||'',cover:Boolean(story?.cover_key),study,sample:isSample(story)||isSample(data)||chapters.some(isSample),mappedParts,assembly:!study&&mappedParts>0};state.bookDownload=null;state.readerAssembly=null;state.bilingualPlace=null;localSources=new Map();loadReaderTerms(storyId);};
  // A book with one part, or a part named by the address, opens at once: the picker would offer no choice.
  const index=part?Math.min(part,chapters.length)-1:chapters.length===1?0:-1;
  if(index>=0){
   open();
   if(restore){const place=readPlace();state.placePending=place?.story===storyId&&place.part===index+1?{...place,until:Date.now()+10000}:null;state.chapter=index;state.readerError=null;state.readerPending=false;go('reader',{replace:true});}
   else openReaderWithBookAnimation(story,index,ticket);
   return;
  }
  const cover=()=>document.querySelector(`[data-read-cover="${String(storyId).replace(/["\\]/g,'\\$&')}"]`),start=index=>{$('#modal')?.close();open();openReaderWithBookAnimation(story,index,++openTicket);};
  // The book's title, then one row per part: a tap opens it. Above 8 parts a search narrows the list; Enter in it opens
  // the first part shown, arrow keys move between the rows. "Hủy" and Escape close it.
  modal(`<h2>${esc(story?.title||'Mục lục')}</h2>${chapters.length>8?'<label class="chapter-search">Tìm phần<input id="chapter-search-input" type="search" placeholder="Số hoặc tên phần" autocomplete="off"></label>':''}<ol class="chapter-rows" id="chapter-start-list" aria-label="Mục lục">${chapters.map((chapter,index)=>`<li><button type="button" class="chapter-row" data-start-part="${index}"><span class="chapter-row-number" aria-hidden="true">${index+1}</span><span class="chapter-row-title">${esc(chapter.title)}</span></button></li>`).join('')}</ol><p id="chapter-search-empty" class="empty-line" hidden>Không có phần khớp.</p>`,()=>{const first=document.querySelector('#chapter-start-list li:not([hidden]) [data-start-part]');if(first)start(Number(first.dataset.startPart));},'',{returnFocus:cover,confirm:false});
  document.querySelectorAll('[data-start-part]').forEach(button=>button.onclick=()=>start(Number(button.dataset.startPart)));
  on('#chapter-start-list','keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const rows=[...document.querySelectorAll('#chapter-start-list li:not([hidden]) [data-start-part]')],index=rows.indexOf(document.activeElement);if(index<0)return;event.preventDefault();(event.key==='Home'?rows[0]:event.key==='End'?rows.at(-1):rows[Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))]).focus();});
  on('#chapter-search-input','input',event=>{const query=normalizeLibraryText(event.target.value);let visible=0;for(const row of document.querySelectorAll('#chapter-start-list li')){const matches=normalizeLibraryText(row.textContent).includes(query);row.hidden=!matches;if(matches)visible++;}$('#chapter-search-empty').hidden=visible>0;});
 });
}

// ticket: the open this animation belongs to; a book tapped since then is the one that opens.
function openReaderWithBookAnimation(story,chapterIndex,ticket=openTicket){
 state.chapter=chapterIndex;state.readerError=null;
 if(prefersReducedMotion()){go('reader');return;}
 document.querySelector('.book-opening-overlay')?.remove();
 const cover=story?.cover_key?`<img src="/api/covers/${encodeURIComponent(story.id)}?v=${encodeURIComponent(story.cover_key)}" alt="">`:`<div class="opening-cover-placeholder">${esc(story?.title?.slice(0,1)||'書')}</div>`;
 const overlay=document.createElement('div');overlay.className='book-opening-overlay';overlay.setAttribute('aria-hidden','true');overlay.innerHTML=`<div class="opening-light"></div><div class="opening-book"><div class="opening-pages opening-pages-left"><span></span><span></span><span></span></div><div class="opening-pages opening-pages-right"><span></span><span></span><span></span></div><div class="opening-book-cover">${cover}<div class="opening-cover-shade"></div><strong>${esc(story?.title||'Hoa Trí')}</strong></div><div class="opening-book-spine"></div></div><p class="opening-caption">Đang mở · ${esc(state.chapters[chapterIndex]?.title||'Phần tài liệu')}</p>`;document.body.append(overlay);
 requestAnimationFrame(()=>overlay.classList.add('is-opening'));
 setTimeout(()=>{if(ticket!==openTicket){overlay.remove();return;}go('reader');overlay.classList.add('is-finished');},1050);
 setTimeout(()=>overlay.remove(),1500);
}
function createStory(){modal(`<h2>Tạo tài liệu</h2><label class="modal-field">Tên tài liệu<input name="title" required maxlength="200"></label><label class="modal-field">Lĩnh vực<select name="genre"><option selected>Chuyên khảo · Nghiên cứu</option><option>Toán học · STEM</option><option>Lịch sử Trung Hoa</option><option>Cổ văn · Hán Nôm</option><option>Triết học · Tư tưởng</option><option>Văn hóa · Xã hội</option><option>Địa lý · Khảo cổ</option><option>Giáo dục</option><option>Ngôn ngữ học</option><option>Tài liệu khác</option></select></label>${coverInput()}`,async f=>{const r=await api('/stories',{method:'POST',body:f});state.storyId=r.id;await refresh();render();},'Tạo tài liệu');bindCoverPreview();}
// mode: the "Cách dịch" picked for this run (runModeField), sent with each part of the queue; none keeps each job's own.
async function runJob(jid,{mode=null}={}){const first=state.jobs.find(job=>job.id===jid),siblings=first&&/^[0-9]{2,}\s*·/.test(first.filename)?state.jobs.filter(job=>job.story_id===first.story_id&&job.status==='uploaded'&&job.filename.localeCompare(first.filename,'vi')>=0).sort((a,b)=>a.filename.localeCompare(b.filename,'vi')):[],queue=[first,...siblings].filter((job,index,list)=>job&&list.findIndex(item=>item.id===job.id)===index);busy=true;go('review');state.selected=jid;render();toast(queue.length>1?`Đã xếp ${queue.length} phần vào hàng dịch.`:'Đang dịch…');poll=setInterval(async()=>{try{await pollJobs([state.selected]);if(state.route==='review')render();}catch{}},4000);try{for(const queued of queue){state.selected=queued.id;if(state.route==='review')render();let result;do{result=await api(`/jobs/${queued.id}/run`,{method:'POST',...(isMode(mode)?{body:{mode}}:{})});state.jobs=state.jobs.map(j=>j.id===queued.id?{...j,...result}:j);}while(state.status.authenticated&&['splitting','prepared','assembling','ocr','translating','uploaded'].includes(result.status));if(result.status==='review'){state.selected=queued.id;if(state.route==='review')render();toast(`${queued.filename} đã dịch xong, chờ duyệt.`);}else if(result.status==='failed'){state.selected=queued.id;if(state.route==='review')render();break;}}}finally{busy=false;clearInterval(poll);await refresh();jobsChanged();}}
// A run or a split that ends (or a splitting step) draws again only what shows jobs: the review view, or Xưởng dịch's
// counts and recent jobs without its upload form. Another view the admin went to meanwhile (Cài đặt, Thuật ngữ…) keeps
// what is being typed in it and the focus; only the request count and the title follow there. Thuật ngữ asks again for
// a student's book glossary that the refresh dropped (as render() would), so saving still works and one loading opens.
function jobsChanged(){
 if(state.route==='review'||!state.status.authenticated){render();return;}
 showRequestCount();if(state.route==='glossary'&&state.glossaryId&&glossaryOf(state.glossaryId)===null)loadStoryDetail(state.glossaryId);
 if(state.route!=='translate')return;
 const stats=$('.stats'),recent=$('.recent');if(stats)stats.outerHTML=jobStats();
 if(recent){recent.outerHTML=recentJobs();const drawn=$('.recent');if(drawn){bindOpeners(drawn);bindDeletes(drawn);}}
}
// Signed out, the student signs in first and the dialog then opens by itself (render(), state.pendingRequest), filled
// with what they had typed when their session ran out while sending (keepRequestDraft).
function requestStory(){
 if(!state.reader.authenticated){if(!requestDraftKept())keepRequestDraft();state.pendingRequest=true;go('account');return;}
 const draft=takeRequestDraft(),value=name=>esc(typeof draft[name]==='string'?draft[name]:''),shared=draft.visibility==='public',again=typeof draft.filename==='string'&&draft.filename;
 const invalid=(names,bad)=>{for(const name of names){const input=$(`#modal [name="${name}"]`);if(bad)input?.setAttribute('aria-invalid','true');else input?.removeAttribute('aria-invalid');}};
 // A missing or wrong file or link is said right under the two fields (role="alert") and the focus goes back to the
 // field; #modal-error is kept for what the server answers.
 const sourceError=(message,names,focus='file')=>{const box=$('#request-source-error');if(box)box.textContent=message;invalid(names,true);$(`#modal [name="${focus}"]`)?.focus();return Object.assign(new Error(message),{inline:true});};
 modal(`<h2>Yêu cầu dịch</h2><label class="modal-field">Tên tài liệu<input name="title" required maxlength="200" value="${value('title')}"></label><fieldset class="request-source" aria-describedby="request-source-error"><legend>Tệp hoặc liên kết (chọn một)</legend><div class="request-file"><label class="file-pick button secondary"><span>Chọn tệp…</span><input class="sr-only" name="file" type="file" accept=".pdf,.epub,.azw3,.docx,.txt,.jpg,.jpeg,.png,.webp" aria-describedby="request-file-hint${again?' request-file-again':''} request-source-error"></label><span class="file-name" id="request-file-name"></span></div><small class="field-hint" id="request-file-hint">PDF, EPUB, AZW3, DOCX, TXT, ảnh · tối đa 25 MB</small>${again?`<small class="field-hint request-file-again" id="request-file-again">Hãy chọn lại tệp “${esc(again)}”: trình duyệt không giữ tệp qua lần đăng nhập.</small>`:''}<label class="modal-field">Liên kết<input name="source_url" type="url" placeholder="https://…" value="${value('source_url')}" aria-describedby="request-source-error"></label></fieldset><p class="field-error" id="request-source-error" role="alert"></p><label class="modal-field">Ghi chú<textarea name="notes" maxlength="2000" rows="3" placeholder="Phần cần dịch, thuật ngữ cần giữ…">${value('notes')}</textarea></label><fieldset class="visibility-choice"><legend>Ai đọc được khi xong?</legend><label><input type="radio" name="visibility" value="private"${shared?'':' checked'}><span>Chỉ mình tôi</span></label><label><input type="radio" name="visibility" value="public"${shared?' checked':''} aria-describedby="visibility-rights"><span>Chia sẻ cộng đồng (Thư viện chung)</span></label><small class="field-hint visibility-rights" id="visibility-rights">Chỉ khi tài liệu hết bản quyền hoặc bạn được phép chia sẻ.</small></fieldset>`,async f=>{
  const file=f.get('file'),source=String(f.get('source_url')||'').trim(),box=$('#request-source-error');invalid(['file','source_url'],false);if(box)box.textContent='';
  if(file?.size>25*1024*1024)throw sourceError('Tệp tối đa 25 MB.',['file']);
  if(!file?.size&&!source)throw sourceError('Hãy chọn tệp hoặc dán liên kết.',['file','source_url']);
  // The server keeps only web addresses (http or https with a host); anything else is said here, under the field.
  if(source&&!webLink(source))throw sourceError('Liên kết phải là địa chỉ web bắt đầu bằng http:// hoặc https://.',['source_url'],'source_url');
  let sent;
  try{sent=await api('/requests',{method:'POST',body:f});}
  catch(error){
   if(error.status===400&&/^Liên kết/u.test(error.message))throw sourceError(error.message,['source_url'],'source_url');
   // The session ran out while the dialog was open: what was typed waits in this tab while the student signs in again
   // (the sign-in form says the dialog comes back with it).
   if(error.status!==401)throw error;
   keepRequestDraft({title:String(f.get('title')||''),source_url:source,notes:String(f.get('notes')||''),visibility:String(f.get('visibility')||'private'),filename:file?.size?String(file.name||''):''});
   $('#modal').close();state.reader={...state.reader,authenticated:false,user:null};state.myLibrary=[];state.myRequests=[];state.studyBooks=[];go('account');return;
  }
  await refresh();render();toast('Đã gửi yêu cầu dịch.');highlightRequest(sent?.id);
 },'Gửi yêu cầu');
 on('#modal [name="file"]','change',event=>{const name=$('#request-file-name');if(name)name.textContent=event.target.files?.[0]?.name||'';});
}
// The request just sent is marked for a moment in "Yêu cầu của tôi" (style.css: no fade for a student who asks for none).
function highlightRequest(id){const row=id&&document.querySelector?.(`[data-request-row="${String(id).replace(/["\\]/g,'\\$&')}"]`);if(!row)return;row.classList.add('is-new');globalThis.setTimeout?.(()=>row.classList.remove('is-new'),3000);}
// The server takes XÓA or XOÁ in any case; an account with a password also confirms with it. A Google-only account has
// no password to ask, so the server takes its deletion only within 10 minutes of signing in (code reauth_required): the
// dialog says so first, and on that answer offers to sign out, to sign in again with Google.
const REAUTH_NOTE='Tài khoản Google chỉ xóa được trong 10 phút sau khi đăng nhập; nếu lâu hơn, hãy đăng xuất rồi đăng nhập lại bằng Google.';
function deleteAccountDialog(){
 // A server that does not name the sign-in kind gets the password field too; a Google-only account's answer is ignored.
 const local=state.reader.user?.provider!=='google';
 modal(`<h2>Xóa tài khoản vĩnh viễn?</h2><p class="subtitle">Xóa ngay, không khôi phục được: lịch sử dịch, Thư viện riêng, PDF gốc, bản dịch và yêu cầu dịch. Tài liệu đã công bố trong Thư viện chung vẫn còn nhưng không ghi tên bạn.</p>${local?'<label class="modal-field">Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>':`<p class="auth-note" role="note">${REAUTH_NOTE}</p>`}<label class="modal-field">Nhập XÓA để xác nhận<input name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="10"></label><p id="reauth-row" hidden><button type="button" id="reauth-signout">Đăng xuất để đăng nhập lại bằng Google</button></p>`,async form=>{
  const confirm=String(form.get('confirm')||'').normalize('NFC').trim(),field=name=>$(`#modal input[name="${name}"]`);
  if(!['XÓA','XOÁ'].includes(confirm.toUpperCase())){field('confirm')?.focus();throw new Error('Hãy nhập đúng chữ XÓA để xác nhận.');}
  try{await api('/me',{method:'DELETE',body:{confirm,...(local?{password:String(form.get('password')||'')}:{})}});}
  catch(error){
   const name={wrong_password:'password',password_required:'password',confirm_required:'confirm'}[error.code];if(name)field(name)?.focus();if(error.status===401){await refresh().catch(()=>{});render();}
   // The server's message (shown in the dialog) says what to do; the button next to it does the first step.
   if(error.code==='reauth_required'){const row=$('#reauth-row');if(row){row.hidden=false;$('#reauth-signout')?.focus();}}
   throw error;
  }
  localSources=new Map();Object.assign(state,{reader:{...state.reader,authenticated:false,user:null},myLibrary:[],myRequests:[],studyBooks:[],readerStory:null,chapters:[]});
  await refresh().catch(()=>{});go('library');toast('Tài khoản và dữ liệu của bạn đã được xóa.');
 },'Xóa vĩnh viễn',{danger:true});
 on('#reauth-signout','click',signOutToReauthenticate);
}
// Signing out is said only once the server ended the session (204; 401: there was none). Otherwise the student stays
// signed in and is told so: on a shared school computer, "signed out" must be true.
async function signOut(){
 const response=await fetch('/api/auth/logout',{method:'POST'}).catch(()=>{throw new Error('Không kết nối được máy chủ nên chưa đăng xuất được. Hãy kiểm tra mạng rồi thử lại.');});
 if(!response.ok&&response.status!==401)throw new Error(`Chưa đăng xuất được (mã ${response.status}). Bạn vẫn đang đăng nhập; hãy thử lại sau vài giây.`);
 state.reader={...state.reader,authenticated:false,user:null};state.weakPassword=null;
}
async function signOutToReauthenticate(){
 // Asked from the deletion dialog: a failure is said inside it (a toast would sit behind its backdrop).
 try{await signOut();}catch(error){const box=$('#modal-error');if($('#modal')?.open&&box){box.textContent=error.message;box.hidden=false;return;}throw error;}
 $('#modal')?.close();
 await refresh().catch(()=>{});go('account');toast('Đã đăng xuất. Hãy đăng nhập lại bằng Google, rồi xóa tài khoản trong vòng 10 phút.');
}
// Every session of the account ends, this one too unless the box is kept ticked (POST /api/auth/logout-all).
function logoutAllDialog(){
 modal(`<h2>Đăng xuất khỏi mọi thiết bị?</h2><p class="subtitle">Các thiết bị khác phải đăng nhập lại; liên kết đặt lại mật khẩu chưa dùng cũng hết hạn.</p><label class="confirm-check"><input type="checkbox" name="keepCurrent" checked> Vẫn giữ đăng nhập trên thiết bị này</label>`,async form=>{
  const keepCurrent=form.get('keepCurrent')==='on';let result;
  try{result=await api('/auth/logout-all',{method:'POST',body:keepCurrent?{keepCurrent:true}:{}});}
  catch(error){if(error.status===401){$('#modal')?.close();await refresh().catch(()=>{});go('account');}throw error;}
  const ended=Number(result?.ended)||0;
  if(result?.signedOut){state.reader={...state.reader,authenticated:false,user:null};state.weakPassword=null;await refresh().catch(()=>{});go('account');toast(`Đã đăng xuất khỏi mọi thiết bị${ended?` (${ended} nơi khác)`:''}, kể cả thiết bị này.`);return;}
  toast(ended?`Đã đăng xuất ${ended} nơi khác. Thiết bị này vẫn đăng nhập.`:'Không có thiết bị nào khác đang đăng nhập tài khoản này.');
 },'Đăng xuất');
}
// POST /api/auth/password: the current password confirms the change; this browser gets a new session, the others end.
function changePassword(event){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form),currentPassword=String(data.get('currentPassword')||''),newPassword=String(data.get('newPassword')||''),confirm=String(data.get('confirm')||'');
 if(newPassword!==confirm){clearFormError(form);showFormError(form,'Hai mật khẩu mới chưa khớp. Hãy nhập lại cho giống nhau.',['confirm']);return;}
 return sendForm(form,async()=>{
  let result;
  try{result=await api('/auth/password',{method:'POST',body:{currentPassword,newPassword}});}
  catch(error){if(error.status===401){await refresh().catch(()=>{});render();}throw error;}
  const ended=Number(result?.ended)||0;state.weakPassword=null;
  state.accountNotice=ended?`Đã đổi mật khẩu và đăng xuất ${ended} nơi khác.`:'Đã đổi mật khẩu.';state.focusAfterRender='heading';render();
 },error=>['wrong_password','password_required'].includes(error.code)?['currentPassword']:error.status===400?['newPassword']:[]);
}
function bindAuth(){
 const tabs=[...document.querySelectorAll('[data-auth-tab]')];
 const select=button=>{const register=button.dataset.authTab==='register';for(const item of tabs){const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;}$('#auth-panel-login').hidden=register;$('#auth-panel-register').hidden=!register;const row=$('#google-terms-row'),title=$('#auth-title');if(row)row.hidden=register;if(title)title.textContent=register?'Tạo tài khoản':'Đăng nhập';};
 tabs.forEach((button,index)=>{button.onclick=()=>select(button);button.onkeydown=event=>{const step={ArrowRight:1,ArrowLeft:-1}[event.key];if(!step&&!['Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+step+tabs.length)%tabs.length];select(next);next.focus();};});
 // The registration box and the Google box stand for the same consent, so ticking one ticks the other.
 const boxes=[...document.querySelectorAll('[data-terms-check]')];
 const agree=checked=>{state.termsAccepted=checked;for(const box of boxes)box.checked=checked;const google=$('#google-login'),error=$('#google-terms-error');if(google){google.setAttribute('aria-disabled',String(!checked));google.setAttribute('href',googleHref(checked));}if(error&&checked)error.textContent='';};
 boxes.forEach(box=>box.onchange=()=>agree(box.checked));if(boxes.length)agree(Boolean(state.termsAccepted));
 // Inside Zalo, Facebook… Google refuses the sign-in (in-app-browser.js): the student is first offered Chrome or Safari.
 $('#google-login')?.addEventListener('click',event=>{
  if(event.currentTarget.getAttribute('aria-disabled')!=='true'){
   const app=inAppBrowser(),href=event.currentTarget.href;state.googleFailure=null;
   if(app){event.preventDefault();leaveInApp(app,{purpose:'google',go:()=>{location.href=href;}});}
   return;
  }
  event.preventDefault();const error=$('#google-terms-error');if(error)error.textContent='Hãy đánh dấu ô đồng ý trước.';(boxes.find(box=>box.offsetParent)||boxes[0])?.focus();
 });
 // A field the last answer marked invalid is cleared as soon as it is edited.
 document.querySelectorAll('.auth-form').forEach(form=>form.addEventListener('input',event=>{if(event.target.getAttribute?.('aria-invalid'))markInvalid(form,[],form.querySelector('.form-error'),event.target);}));
 // A password the server still takes but would refuse as a new one (weakPassword) is pointed out on the account page.
 on('#reader-login-form','submit',event=>{event.preventDefault();const form=event.currentTarget,body=Object.fromEntries(new FormData(form));return sendForm(form,async()=>{const answer=await api('/auth/login',{method:'POST',body});state.weakPassword=typeof answer?.weakPassword==='string'?answer.weakPassword:null;await enterAccount('Đăng nhập thành công.');},authFields);});
 on('#reader-register-form','submit',event=>{
  event.preventDefault();const form=event.currentTarget,data=new FormData(form),body={...Object.fromEntries(data),acceptTerms:data.get('acceptTerms')==='on'};
  return sendForm(form,async()=>{
   try{await api('/auth/register',{method:'POST',body});}
   catch(error){
    // The form is shown only while registration is open: the server has since closed it or left it to Google sign-in
    // (domain mode), so the page shows the current policy, and the message moves to the sign-in form (sendForm).
    if(['registration_closed','registration_google_only'].includes(error.code)){await refresh().catch(()=>{});render();}
    throw error;
   }
   await enterAccount('Tài khoản đã được tạo.');
  },authFields);
 });
 on('#password-reset-form','submit',submitPasswordReset);
 on('#reset-continue','click',event=>{event.currentTarget.disabled=true;return openResetLink();});
 on('#password-change-form','submit',changePassword);
 on('#logout-all','click',logoutAllDialog);
 on('#weak-password-change','click',()=>{const field=$('#password-change-form [name="currentPassword"]');field?.scrollIntoView?.({block:'center'});field?.focus();});
}
// Sign-in forms (login, registration, new password) say what went wrong inside the form: the message (role="alert")
// takes the focus and the fields it is about are marked invalid. The submit button waits for the answer, so a second
// press sends nothing.
const sendingForms=new WeakSet();
// After a sign-in the server accepted, the page asks /api/me again: a browser that did not keep the session cookie (or a
// server that did not answer) is said in the form, instead of the same sign-in form coming back without a word.
async function enterAccount(message){
 await refresh();if(!state.reader.authenticated)throw state.errors?.me||new Error('Máy chủ đã nhận thông tin nhưng trình duyệt chưa giữ phiên đăng nhập. Hãy cho phép cookie của trang này rồi đăng nhập lại.');
 state.googleFailure=null;state.focusAfterRender='heading';render();
 // Signed in from Xưởng dịch or from a private book's reader: back there.
 if(state.afterSignIn){const target=state.afterSignIn;state.afterSignIn='';location.replace(target);}
}
// The server names no field, so its known messages say which fields an answer is about.
const WEAK_CODES=['password_common','password_pattern','password_like_email'];
const authFields=error=>error.code==='terms_required'?['acceptTerms']:WEAK_CODES.includes(error.code)?['password']:error.code==='email_taken'?['email']:error.status===401?['email','password']:error.status===409||/^Email/u.test(error.message)?['email']:/^Mật khẩu/u.test(error.message)?['password']:/^Tên hiển thị/u.test(error.message)?['name']:[];
// only: limit the change to that one field (it was edited); its other descriptions (a rule under the field) are kept.
function markInvalid(form,names,box,only=null){
 for(const input of only?[only]:form?.querySelectorAll?.('input[name]')||[]){
  const bad=names.includes(input.name),ids=String(input.getAttribute('aria-describedby')||'').split(/\s+/u).filter(id=>id&&id!==box?.id);
  if(bad&&box){input.setAttribute('aria-invalid','true');ids.push(box.id);}else input.removeAttribute('aria-invalid');
  if(ids.length)input.setAttribute('aria-describedby',ids.join(' '));else input.removeAttribute('aria-describedby');
 }
}
function showFormError(form,message,fields=[]){
 const box=form?.querySelector?.('.form-error');if(!box){toast(message);return;}
 box.textContent=message;box.hidden=false;markInvalid(form,fields,box);box.focus();
}
function showFormDone(form,message){const note=form?.querySelector?.('.form-done');if(!note){toast(message);return;}note.innerHTML=`${icon('check')}<span>${esc(message)}</span>`;note.hidden=false;note.focus();}
function clearFormError(form){const done=form?.querySelector?.('.form-done');if(done){done.hidden=true;done.textContent='';}const box=form?.querySelector?.('.form-error');if(!box)return;box.hidden=true;box.textContent='';markInvalid(form,[],box);}
async function sendForm(form,send,fieldsFor=()=>[]){
 if(sendingForms.has(form))return;sendingForms.add(form);
 const button=form.querySelector?.('[type="submit"]');if(button)button.disabled=true;form.setAttribute?.('aria-busy','true');clearFormError(form);
 try{await send();}
 catch(error){
  // A form the answer replaced (registration closed meanwhile) hands its message to the sign-in form now shown.
  const live=form.isConnected===false?$('#reader-login-form'):form;showFormError(live,error.message,live===form?fieldsFor(error):[]);
 }
 finally{sendingForms.delete(form);if(button)button.disabled=false;form.removeAttribute?.('aria-busy');}
}
// A refused link (used, expired, or its account locked) cannot be tried again: the page then says how to get a new one.
async function submitPasswordReset(event){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form),password=String(data.get('password')||''),confirm=String(data.get('confirm')||'');
 if(password!==confirm){clearFormError(form);showFormError(form,'Hai mật khẩu chưa khớp. Hãy nhập lại cho giống nhau.',['confirm']);return;}
 await sendForm(form,async()=>{
  try{await api('/auth/password-reset',{method:'POST',body:{token:state.resetToken,password}});}
  catch(error){if(!['reset_link_invalid','account_disabled'].includes(error.code))throw error;state.resetToken=null;state.resetFailed=error.message;state.focusAfterRender='heading';render();return;}
  state.resetToken=null;state.resetFailed=null;await refresh();
  state.accountNotice=state.reader.authenticated?'Đã đặt mật khẩu mới; các thiết bị khác đã bị đăng xuất.':'Đã đặt mật khẩu mới. Hãy đăng nhập bằng mật khẩu đó.';go('account');
 },error=>/^Mật khẩu/u.test(error.message)?['password','confirm']:[]);
}
// Admin: a one-time link for a student who forgot their password (no e-mail is sent). It is shown once, here.
async function createResetLink(id,button){
 const user=state.users.find(item=>item.id===id);if(!user||button?.disabled)return;
 if(button)button.disabled=true;
 try{showResetLink(user,await api(`/users/${encodeURIComponent(id)}/password-reset`,{method:'POST'}));}
 catch(error){
  // 404: the account is gone; 409: a Google account or a locked one. The list is reloaded to show why.
  if([404,409].includes(error.status)){await refresh().catch(()=>{});render();document.querySelector(`[data-user-reset="${String(id).replace(/["\\]/g,'\\$&')}"]`)?.focus();}
  throw error;
 }
 finally{if(button?.isConnected)button.disabled=false;}
}
function showResetLink(user,{resetUrl,expiresAt}){
 const link=location.origin+resetUrl,expires=new Date(expiresAt),when=Number.isNaN(expires.getTime())?'':expires.toLocaleString('vi-VN',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'});
 const opener=`[data-user-reset="${String(user.id).replace(/["\\]/g,'\\$&')}"]`,back=()=>{const item=document.querySelector(opener);return item?.closest?.('details.menu')?.querySelector('summary')||item;};
 modal(`<h2>Liên kết đặt lại mật khẩu · ${esc(user.name||user.email)}</h2><p class="subtitle">Gửi riêng liên kết này cho đúng học sinh ${esc(user.email)}, không đăng vào nhóm lớp: ai có liên kết đều đặt được mật khẩu mới.</p><label class="modal-field"><span class="sr-only">Liên kết đặt lại mật khẩu</span><input id="reset-link" readonly value="${esc(link)}" spellcheck="false"></label><div class="reset-link-actions"><button type="button" id="copy-reset-link">Sao chép</button><span id="reset-link-status" role="status"></span></div><p class="field-hint reset-link-note">Liên kết chỉ hiện một lần · mở được một lần${when?` · hết hạn lúc ${esc(when)}`:''}.</p>`,async()=>{},'Đóng',{cancel:false,returnFocus:back});
 const input=$('#reset-link');input?.focus();input?.select();
 on('#copy-reset-link','click',async()=>{
  const status=$('#reset-link-status');
  try{await navigator.clipboard.writeText(link);status.textContent='Đã sao chép.';}
  catch{input?.focus();input?.select();status.textContent='Chưa sao chép được. Liên kết đã được chọn: nhấn Ctrl+C (điện thoại: giữ để sao chép).';}
 });
}
// Admin: lock (sessions end, login refused, data kept), unlock, or delete an account with everything private to it.
function lockUser(id){
 const user=state.users.find(item=>item.id===id);if(!user)return;
 // The rows are drawn again: the focus goes back to this row's ⋯ (also after the dialog), and the toast, a live region,
 // says what changed.
 const menuButton=()=>document.querySelector(`[data-user-lock="${String(id).replace(/["\\]/g,'\\$&')}"]`)?.closest?.('details.menu')?.querySelector('summary');
 const change=async disabled=>{await api(`/users/${encodeURIComponent(id)}`,{method:'PATCH',body:{disabled}});await refresh();render();menuButton()?.focus();toast(disabled?'Đã khóa tài khoản.':'Đã mở khóa tài khoản.');};
 if(user.disabled_at){change(false).catch(error=>toast(error.message));return;}
 modal(`<h2>Khóa tài khoản ${esc(user.email)}?</h2><p class="subtitle">Học sinh bị đăng xuất và không đăng nhập được cho tới khi mở khóa. Dữ liệu được giữ nguyên.</p>`,()=>change(true),'Khóa tài khoản',{returnFocus:menuButton});
}
function deleteUser(id){
 const user=state.users.find(item=>item.id===id);if(!user)return;
 modal(`<h2>Xóa tài khoản ${esc(user.email)}?</h2><p class="subtitle">Xóa vĩnh viễn lịch sử dịch, Thư viện riêng (PDF gốc, bản dịch), yêu cầu dịch và phiên đăng nhập. Tài liệu đã công bố ở Thư viện chung được giữ. Không thể hoàn tác.</p><label class="confirm-check"><input type="checkbox" required> Tôi muốn xóa tài khoản này.</label>`,async()=>{await api(`/users/${encodeURIComponent(id)}`,{method:'DELETE'});await refresh();render();},'Xóa vĩnh viễn',{danger:true});
}
function bind(){bindMusic(toast);bindAuth();on('#delete-account','click',deleteAccountDialog);document.querySelectorAll('[data-user-lock]').forEach(b=>b.onclick=()=>lockUser(b.dataset.userLock));document.querySelectorAll('[data-user-delete]').forEach(b=>b.onclick=()=>deleteUser(b.dataset.userDelete));document.querySelectorAll('[data-user-reset]').forEach(b=>b.onclick=()=>createResetLink(b.dataset.userReset,b).catch(error=>toast(error.message)));document.querySelectorAll('[data-request-open]').forEach(b=>b.onclick=()=>requestStory());on('#hanzi-open','click',()=>{const picked=String(getSelection()||'').trim();openHanziPanel({text:/\p{Script=Han}/u.test(picked)?picked.slice(0,600):'',search:true,returnFocus:$('#hanzi-open'),theme:state.theme});});bindPdfTools();document.querySelectorAll('[data-request-file]').forEach(b=>b.onclick=()=>adminDownload(`/requests/${encodeURIComponent(b.dataset.requestFile)}/file`,state.requests.find(x=>x.id===b.dataset.requestFile)?.filename||'nguyen-tac','Không tải được tệp nguồn').catch(error=>toast(error.message)));on('#download-source','click',()=>adminDownload(`/jobs/${encodeURIComponent(state.selected)}/source`,'nguyen-tac.txt','Không tải được nguyên tác'));bindAdminContent();on('#pdf-parts','click',showPdfParts);on('#download-book','click',downloadBook);bindCoverButtons();on('#reader-request','click',requestStory);on('#account-request','click',requestStory);on('#reader-logout','click',async event=>{const button=event.currentTarget;button.disabled=true;try{await signOut();}finally{if(button.isConnected!==false)button.disabled=false;}await refresh().catch(()=>{});go('library');toast('Đã đăng xuất.');});on('#reader-more-toggle','click',event=>{state.readerMore=!state.readerMore;$('.reader-toolbar')?.classList.toggle('is-more-open',state.readerMore);event.currentTarget.setAttribute('aria-expanded',String(state.readerMore));});bindAdminAuth();bindOpeners(document);document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.draftText=$('#source-input')?.value||state.draftText;state.storyId=$('#story-select')?.value;state.tab=b.dataset.tab;render();});
 document.querySelectorAll('[data-review-story]').forEach(b=>b.onclick=()=>{state.reviewStory=b.dataset.reviewStory;state.showReviewQueue=false;state.selected=null;render();});on('#back-review-books','click',()=>{state.reviewStory=null;state.showReviewQueue=false;render();});$('#toggle-review-queue')?.parentElement?.addEventListener?.('toggle',event=>{state.showReviewQueue=event.currentTarget.open;});
 on('#new-story','click',createStory);on('#back-jobs','click',()=>{state.selected=null;render();});on('#story-select','change',e=>{state.storyId=e.target.value;selectAcademicField(state.storyId);$('#story-cover-slot').innerHTML=uploadCoverPanel();bindCoverButtons();showAdminCovers();});selectAcademicField(state.storyId||'');on('#genre','change',e=>{genreDrafts[state.storyId||'']=e.target.value;});
 async function selected(file){if(!file)return;if(file.size>25*1024*1024)throw new Error('Tối đa 25 MB mỗi tài liệu.');state.file=file;state.pdfAnalysis=null;state.storyId=$('#story-select')?.value;render();if(file.name.toLowerCase().endsWith('.pdf')){toast('Đang kiểm tra lớp chữ của PDF trên trình duyệt…');try{const {analyzePdf}=await import('./pdf-client.js');state.pdfAnalysis=await analyzePdf(file,(page,total)=>{if(page===1||page===total||page%10===0)toast(`Đang phân tích PDF · ${page}/${total} trang`);});const analysis=state.pdfAnalysis,reread=analysis.reclassified?` ${analysis.reclassified} trang có lớp chữ không khớp ảnh trang (chữ nhận dạng nằm ẩn dưới ảnh scan, hoặc chỉ có dấu ở mép trang) sẽ được đọc lại từ ảnh.`:'';toast(analysis.mode==='hybrid'?`Đã lấy chữ từ ${analysis.pagesWithText} trang; chỉ ${analysis.scanPages} trang cần OCR.${reread}`:analysis.mode==='text'?analysis.pictured?`Đã lấy và làm sạch lớp chữ từ ${analysis.totalPages} trang; ${analysis.pictured} trang có chữ nằm trong hình ảnh hoặc nét vẽ sẽ được nhận dạng thêm từ ảnh.`:`Đã lấy và làm sạch lớp chữ từ ${analysis.totalPages} trang. Không cần OCR ảnh.`:`Đã nhận diện PDF scan ${analysis.totalPages} trang. Ảnh sẽ được giảm còn 1200px, chuyển xám và nén trước khi OCR.${reread}`);}catch(error){state.pdfAnalysis={mode:'fallback',error:error.message};toast('Không đọc được lớp chữ trong trình duyệt; máy chủ sẽ dùng quy trình PDF dự phòng.');}render();}}
 on('#dropzone','click',e=>{e.preventDefault();$('#file-input').click();});on('#dropzone','keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#file-input').click();}});on('#file-input','change',e=>selected(e.target.files[0]));on('#dropzone','dragover',e=>{e.preventDefault();e.currentTarget.classList.add('drag');});on('#dropzone','dragleave',e=>e.currentTarget.classList.remove('drag'));on('#dropzone','drop',e=>{e.preventDefault();selected(e.dataTransfer.files[0]);});on('#remove-file','click',()=>{state.file=null;render();});
 on('#start-translate','click',e=>uploadJob(e,false));on('#prepare-pdf','click',e=>uploadJob(e,true));
 on('#logout','click',signOutAdmin);on('#admin-logout','click',signOutAdmin);
 on('#job-mode','change',event=>{state.jobMode=isMode(event.target.value)?event.target.value:null;const hint=$('#job-mode-hint');if(hint)hint.textContent=modeHint(chosenMode());});
 on('#toggle-api-key','click',e=>{const input=$('#gemini-api-key'),show=input.type==='password';input.type=show?'text':'password';e.currentTarget.textContent=show?'Ẩn':'Hiện';e.currentTarget.setAttribute('aria-label',show?'Ẩn khóa API':'Hiện khóa API');});
 on('#gemini-key-form','submit',async e=>{e.preventDefault();const input=$('#gemini-api-key'),button=e.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{await api('/settings/gemini-key',{method:'PUT',body:{apiKey:input.value}});input.value='';await refresh();render();toast('Đã lưu khóa; dùng từ lần dịch sau.');}finally{if(button.isConnected)button.disabled=false;}});
 on('#reset-api-key','click',async()=>{await api('/settings/gemini-key',{method:'DELETE'});await refresh();render();toast('Đã chuyển về khóa trên máy chủ.');});
 on('#run-mode','change',event=>{state.runMode={job:state.selected,mode:event.target.value};});on('#rerun','click',()=>runJob(state.selected,{mode:pickedRunMode(state.selected)}));on('#rerun-dialog','click',rerunDialog);on('#save-job','click',async()=>{if(!jobDetail(state.selected))throw new Error('Nội dung bản dịch chưa tải xong. Hãy đợi một chút.');const result=await api(`/jobs/${state.selected}`,{method:'PATCH',body:{source:$('#edit-source').value,translation:$('#edit-translation').value}});await refresh();render();toast(result?.long?'Đã lưu. Văn bản dài được lưu đầy đủ; ô sửa chỉ hiện 20.000 ký tự đầu.':'Đã lưu.');});
 on('#publish-job','click',()=>{if(!jobDetail(state.selected))throw new Error('Nội dung bản dịch chưa tải xong. Hãy đợi một chút.');const jobId=state.selected,source=$('#edit-source').value,translation=$('#edit-translation').value,ebook=/^\[Phần (?:AZW3|EPUB) \d+/mu.test(source),job=state.jobs.find(j=>j.id===jobId),firstLine=translation.split('\n').map(line=>line.trim()).find(Boolean),suggested=(firstLine&&firstLine.length<=200?firstLine:String(job?.filename||'').replace(/^\d+\s*·\s*/,''))||'Phần 1';modal(`<h2>Duyệt & công bố</h2>${ebook?'<p class="subtitle">Các mục, chương giữ thứ tự như trong sách.</p>':`<label class="modal-field">Tên phần<input name="title" required maxlength="200" value="${esc(suggested)}" placeholder="Phần 1: Mở đầu"></label>`}<label class="confirm-check"><input type="checkbox" name="confirmed" required> Tôi đã đối chiếu bản dịch và các chữ chưa rõ.</label>`,async f=>{if(!job?.source_key&&!job?.translation_key)await api(`/jobs/${jobId}`,{method:'PATCH',body:{source,translation}});const result=await api(`/jobs/${jobId}/publish`,{method:'POST',body:{title:f.get('title')||'Phần 1',confirmed:true}});await refresh();state.selected=jobId;render();toast(result.chapters>1?`Đã công bố ${result.chapters} phần.`:'Đã công bố.');},'Công bố');});
 on('#download-original','click',()=>adminDownload(`/jobs/${encodeURIComponent(state.selected)}/file`,state.jobs.find(j=>j.id===state.selected)?.filename||'ban-goc','Không tải được bản gốc'));
 document.querySelectorAll('[data-story]').forEach(b=>b.onclick=()=>{state.storyId=b.dataset.story;go('translate');});on('#glossary-story','change',e=>{state.glossaryId=e.target.value;render();});on('#save-glossary','click',async()=>{if(!state.glossaryId)throw new Error('Hãy chọn tài liệu.');if(glossaryOf(state.glossaryId)===null){if(!state.storyDetails[state.glossaryId]?.loading)loadStoryDetail(state.glossaryId,{again:true});throw new Error('Bảng thuật ngữ của tài liệu này chưa tải xong. Hãy đợi một chút.');}const glossary={};for(const line of $('#glossary-text').value.split('\n').filter(x=>x.trim())){const i=line.indexOf('=');if(i<1||!line.slice(i+1).trim())throw new Error('Mỗi dòng cần có dạng: 中文 = tiếng Việt');glossary[line.slice(0,i).trim()]=line.slice(i+1).trim();}await api(`/stories/${state.glossaryId}`,{method:'PATCH',body:{glossary}});await refresh();render();toast('Đã lưu thuật ngữ; dùng từ lần dịch sau.');});
 document.querySelectorAll('[data-accept]').forEach(b=>b.onclick=async()=>{try{b.disabled=true;const result=await api(`/requests/${b.dataset.accept}/accept`,{method:'POST'});state.storyId=result.story_id;if(result.job_id)state.selected=result.job_id;await refresh();if(result.job_id){go('review');toast(result.alreadyAccepted?'Đã mở tài liệu của yêu cầu.':'Đã tiếp nhận; tệp đã vào Xưởng dịch.');}else{go('translate');toast(result.alreadyAccepted?'Yêu cầu này đã được tiếp nhận.':'Đã tạo tài liệu. Yêu cầu chỉ có liên kết nên chưa có bản dịch.');}}catch(e){b.disabled=false;toast(e.message);}});document.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{try{await api(`/requests/${b.dataset.done}`,{method:'PATCH',body:{status:'done'}});await refresh();render();}catch(e){toast(e.message);}});
 document.querySelectorAll('[data-load-more]').forEach(b=>b.onclick=()=>{b.disabled=true;loadMore(b.dataset.loadMore).catch(error=>{b.disabled=false;toast(error.message);});});
 document.querySelectorAll('[data-user-books]').forEach(b=>b.onclick=()=>{const id=b.dataset.userBooks;if(state.userBooks[id])delete state.userBooks[id];else loadUserBooks(id);render();$(`[data-user-books="${String(id).replace(/["\\]/g,'\\$&')}"]`)?.focus();});document.querySelectorAll('[data-user-books-more]').forEach(b=>b.onclick=()=>{loadUserBooks(b.dataset.userBooksMore,{more:true});render();});document.querySelectorAll('[data-user-books-hide]').forEach(b=>b.onclick=()=>{delete state.userBooks[b.dataset.userBooksHide];render();});document.querySelectorAll('[data-user-books-retry]').forEach(b=>b.onclick=()=>{loadUserBooks(b.dataset.userBooksRetry,{again:true});render();});
 on('#job-detail-retry','click',()=>{loadJobDetail(state.selected,{again:true});render();});on('#story-detail-retry','click',()=>{loadStoryDetail(state.glossaryId,{again:true});render();});
 bindPublicNavigation();
 on('#library-search','input',e=>{state.libraryQuery=e.target.value;filterLibrary();});on('#library-clear-filter','click',()=>{state.libraryQuery='';state.libraryGenre='';const search=$('#library-search');if(search){search.value='';search.focus();}filterLibrary();});document.querySelectorAll('[data-library-genre]').forEach(b=>b.onclick=()=>{state.libraryGenre=b.dataset.libraryGenre;filterLibrary();});filterLibrary();document.querySelectorAll('[data-read]').forEach(b=>b.onclick=()=>openStory(b.dataset.read));document.querySelectorAll('[data-reader-theme]').forEach(b=>b.onclick=()=>setReaderTheme(b.dataset.readerTheme));document.querySelectorAll('.footnote-ref').forEach(button=>{button.onpointerenter=button.onfocus=()=>placeFootnote(button);button.onclick=()=>{placeFootnote(button);button.setAttribute('aria-expanded',String(button.classList.toggle('is-open')));};});bindBookDownload();on('#reader-chapter-select','change',e=>showChapter(Number(e.target.value),{keepFocus:true}));on('#font-smaller','click',()=>changeReaderFont(-1));on('#font-larger','click',()=>changeReaderFont(1));on('#prev-chapter','click',()=>showChapter(state.chapter-1));on('#next-chapter','click',()=>showChapter(state.chapter+1));on('#speak','click',()=>{if(state.speaking){globalThis.speechSynthesis?.cancel();state.speaking=false;setSpeaking(false);return;}if(state.chapters[state.chapter]?.mime==='application/pdf')throw new Error('PDF được đọc trong khung tài liệu; chức năng giọng đọc chỉ dùng cho phần văn bản.');if(!('speechSynthesis'in window))throw new Error('Trình duyệt không hỗ trợ đọc giọng máy.');const voice=speechSynthesis.getVoices().find(v=>v.lang.startsWith('vi'));if(!voice)throw new Error('Chưa có giọng tiếng Việt trên thiết bị. Hãy cài giọng tiếng Việt trong hệ điều hành.');speechSynthesis.cancel();const readable=readerFootnotes(state.chapters[state.chapter].content).body,paragraphs=readable.match(/[\s\S]{1,200}[.!?\n\s]|[\s\S]+$/g)||[];paragraphs.forEach((p,index)=>{const u=new SpeechSynthesisUtterance(p);u.voice=voice;u.lang='vi-VN';if(index===paragraphs.length-1)u.onend=u.onerror=()=>setSpeaking(false);speechSynthesis.speak(u);});setSpeaking(paragraphs.length>0);});
}
// Back/forward and typed addresses: a #reader/<id>/<part> that is not the open part opens it; the same view is not redrawn.
function routeFromUrl(){
 if(adminArea){state.route=currentRoute();render();return;}
 // A reset link opened while the app is already open: its token is taken (and the address cleaned) first.
 const fresh=takeResetToken(),{route,storyId,part}=parseHash();takeAfterSignIn();
 if(route==='yeu-cau'){setUrl('',true);state.route='library';render();requestStory();return;}
 const next=currentRoute();if(next!=='account')leftAccount();
 if(next==='reader'&&storyId&&(state.readerStory?.id!==storyId||state.chapter!==part-1||state.route!=='reader')){
  // The open book's parts are already here: only the part and the view change.
  if(state.readerStory?.id===storyId&&state.chapters.length){globalThis.speechSynthesis?.cancel();state.speaking=false;state.chapter=Math.min(part,state.chapters.length)-1;state.route='reader';state.focusAfterRender='heading';render();return;}
  if(state.loaded)openStory(storyId,{part,restore:true}).catch(()=>{});return;
 }
 if(next==='reader'&&!state.chapters.length){go('library',{replace:true});return;}
 if(next===state.route&&!fresh)return;
 state.route=next;state.focusAfterRender='heading';render();
}
// A fragment navigation (a link, a typed address, Back/Forward between fragments) fires popstate and then hashchange:
// it is routed once.
let poppedUrl=null;
window.addEventListener('popstate',()=>{poppedUrl=location.href;routeFromUrl();});
window.addEventListener('hashchange',event=>{const routed=event?.newURL===poppedUrl;poppedUrl=null;if(!routed)routeFromUrl();});
// What the address asks for once the data is in: /?read=<storyId>[&phan=<part>] (a shared link, the study workspace),
// #reader/<storyId>/<part> (a reload), or #yeu-cau (the request dialog, from another page; after sign-in if needed).
function openFromUrl(){
 if(adminArea)return;const linked=queryValue('read'),{route,storyId,part}=parseHash();
 if(linked){const phan=Number.parseInt(queryValue('phan'),10);setUrl(location.hash.slice(1),true);openStory(linked,{part:phan>0?phan:null,restore:true}).catch(()=>{});return;}
 if(route==='reader'&&storyId){openStory(storyId,{part,restore:true}).catch(()=>{});return;}
 if(route==='reader'){go('library',{replace:true});return;}
 if(route==='yeu-cau'){setUrl('',true);requestStory();}
}
async function loadPublicData(){state.loaded=false;await refresh().catch(error=>{state.errors={library:error};});state.loaded=true;}
if(!adminArea&&(queryValue('read')||parseHash().storyId))state.readerPending=true;
render();if(adminArea)refresh().then(()=>{state.loaded=true;render();}).catch(e=>{state.loaded=true;render();toast('Chưa tải được dữ liệu: '+e.message);});else loadPublicData().then(()=>{if(state.googleFailure)state.focusAfterRender='heading';render();openFromUrl();});
// Every module loaded and the first screen is drawn: browser-check.js shows its notice only on a page without this mark.
document.documentElement?.setAttribute?.('data-app','ready');
// A phone turned sideways, or a window resized past the tablet width, switches a PDF part between frame and pages.
globalThis.matchMedia?.(COMPACT_PDF).addEventListener?.('change',()=>{if(state.route==='reader')renderPdfArea();});
if(adminArea&&document.modelContext?.registerTool){try{document.modelContext.registerTool({name:'open_translation_workspace',description:'Mở xưởng dịch; không tải tệp hoặc gọi AI.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!state.status.authenticated)throw new Error('Cần đăng nhập quản trị.');if(!input||Object.keys(input).length)throw new Error('Không nhận tham số.');go('translate');return{route:'translate'};}});}catch{}}

function publicHeader(){
 const {name,initials,picture}=avatarOf(state.reader.user);
 const accountCurrent=state.route==='account'?' aria-current="page"':'';
 return `<header class="public-header site-masthead"><div class="site-masthead-inner">
  <a class="brand" href="/" data-home-link aria-label="Hoa Trí — Trang chủ"><img src="/favicon.svg" alt="" width="40" height="40"><span><strong>Hoa Trí<span class="brand-dot">.</span></strong></span></a>
  <nav class="site-nav" aria-label="Điều hướng chính">
   <a href="/" data-home-link${state.route==='library'||state.route==='reader'?' aria-current="page"':''}>${icon('book')}<span>Thư viện</span></a>
   <a href="/study">${icon('translate')}<span>Xưởng dịch</span></a>
  </nav>
  <div class="site-header-actions">
   <button class="header-request" id="reader-request" type="button"><span>Yêu cầu dịch</span></button>
   ${state.reader.authenticated?`<a class="header-account" href="/#account"${accountCurrent} aria-label="Tài khoản của ${esc(name)}" title="${esc(name)}"><span class="header-avatar">${picture?`<img src="${esc(picture)}" alt="" width="32" height="32" referrerpolicy="no-referrer">`:esc(initials)}</span><span class="header-account-name">${esc(name)}</span></a>`:`<a class="header-login" href="/#account"${accountCurrent}>Đăng nhập</a>`}
  </div>
 </div></header>`;
}
// The music switch sits in the footer, so it never covers reading text, labels or buttons.
// is-reading: on a phone the header scrolls away with the page while reading (style.css), instead of covering a fifth of
// the screen.
function publicLayout(){return `<div class="public-shell${state.route==='reader'?' is-reading':''}"><a class="skip-link" href="#noi-dung">Bỏ qua, đến nội dung chính</a>${state.route==='library'?homeAtmosphere():''}${publicHeader()}<main class="public-content ${state.route==='reader'?'read-mode':''} ${['account',RESET_ROUTE].includes(state.route)?'account-mode':''}" id="noi-dung" tabindex="-1">${state.route==='reader'?readerView():state.route==='account'?accountView():state.route===RESET_ROUTE?resetView():libraryView()}</main><footer class="site-footer" data-site-footer>${footerHtml()}${musicMarkup()}</footer></div>`;}
function bindPublicNavigation(){
 if(adminArea)return;const behavior=()=>prefersReducedMotion()?'auto':'smooth';
 // In-page targets are focused by hand: a real #fragment would be read as a route of this page.
 on('.skip-link','click',event=>{event.preventDefault();$('#noi-dung')?.focus();});
 on('#show-library','click',event=>{event.preventDefault();const heading=$('#library-title');heading?.scrollIntoView({behavior:behavior(),block:'start'});heading?.focus({preventScroll:true});});
 // The library is this page: its links switch the view instead of loading the page again.
 document.querySelectorAll('[data-home-link]').forEach(link=>link.onclick=event=>{if(event.button||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();if(state.route!=='library')go('library');else scrollTo({top:0,behavior:behavior()});});
 document.querySelectorAll('[data-retry]').forEach(button=>button.onclick=()=>retryLoad(button.dataset.retry).catch(error=>toast(error.message)));
 on('#reader-share','click',shareReader);
 // Escape hides an open or hovered footnote until the pointer or focus leaves it (WCAG 1.4.13).
 on('.reader .prose','keydown',event=>{if(event.key!=='Escape')return;for(const ref of document.querySelectorAll('.footnote-ref.is-open,.footnote-ref:hover,.footnote-ref:focus')){ref.classList.remove('is-open');ref.classList.add('is-dismissed');ref.setAttribute('aria-expanded','false');}});
 document.querySelectorAll('.footnote-ref').forEach(ref=>{ref.onblur=ref.onmouseleave=()=>ref.classList.remove('is-dismissed');});
 // Arrow keys move between the toolbar's buttons (role="toolbar"); Tab still visits each control.
 // Escape closes the phone's reader options and gives the focus back to their button.
 on('.reader-toolbar','keydown',event=>{if(event.key!=='Escape'||!state.readerMore)return;state.readerMore=false;event.currentTarget.classList.remove('is-more-open');const toggle=$('#reader-more-toggle');toggle?.setAttribute('aria-expanded','false');toggle?.focus();});
 on('.reader-toolbar','keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.target.tagName!=='BUTTON')return;const buttons=[...event.currentTarget.querySelectorAll('button:not(:disabled)')].filter(button=>button.offsetParent),index=buttons.indexOf(event.target);if(index<0)return;event.preventDefault();const step=event.key==='ArrowRight'?1:-1;(event.key==='Home'?buttons[0]:event.key==='End'?buttons.at(-1):buttons[(index+step+buttons.length)%buttons.length]).focus();});
}
async function retryLoad(kind){
 if(kind==='reader'){const failed=state.readerError;if(failed)await openStory(failed.storyId,{part:failed.part,restore:true});return;}
 state.errors={};state.loaded=false;render();await loadPublicData();render();
 // The focus goes back to "Thử lại" if it failed again, else to what loaded (the library heading, the account page).
 const again=$(`[data-retry="${kind}"]`),heading=kind==='library'?$('#library-title'):$('.public-content h1');
 if(again)again.focus();else{if(heading&&kind!=='library')heading.setAttribute('tabindex','-1');heading?.focus();}
}
// The admin sign-in page. While /api/status is asked it shows no form (a signed-in admin's reload goes straight to the
// console); with no admin account yet, the first-run form; "Quên mật khẩu?" opens the recovery form; else the sign-in
// form. ADMIN_TOKEN is typed only in the first-run and recovery forms (autocomplete off: never offered as a saved
// password), and the warning about a short server token is shown there.
function loginView(){
 const card=(title,body)=>`<main class="admin-login"><a class="login-back" href="/">← Thư viện</a><section class="panel login-card" aria-labelledby="admin-auth-title"><h1 id="admin-auth-title">${title}</h1>${body}</section></main>`;
 if(!state.loaded)return card('Đăng nhập quản trị','<p class="status" role="status">Đang kiểm tra phiên đăng nhập…</p>');
 const short=state.status.adminTokenTooShort?`<p class="note" data-tone="error" role="alert">${ADMIN_TOKEN_SHORT}</p>`:'';
 // Where ADMIN_TOKEN is, folded: needed once, by whoever runs the server.
 const where=end=>`<details class="more"><summary>ADMIN_TOKEN ở đâu?</summary><div class="more-body"><p>Trên máy cá nhân: dòng ADMIN_TOKEN trong tệp .dev.vars. Trang đã triển khai: secret ADMIN_TOKEN đặt lúc triển khai.${end}</p></div></details>`;
 const tokenField=id=>`<label>Mã ADMIN_TOKEN<input name="token" type="password" autocomplete="off" required maxlength="1024" spellcheck="false" aria-describedby="${id}-token-note"><small class="field-hint" id="${id}-token-note">Không phải mật khẩu đăng nhập.</small></label>`;
 const newPassword=(id,label)=>`<label>${label}<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="${id}-password-rule"><small class="field-hint" id="${id}-password-rule">${ADMIN_PASSWORD_RULE}</small></label><label>Nhập lại ${label.toLowerCase()}<input name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>`;
 if(state.status.adminSetupRequired)return card('Tạo tài khoản quản trị đầu tiên',`<p class="login-lead">Hoa Trí chưa có quản trị viên. ADMIN_TOKEN chỉ cần nhập một lần ở đây để tạo tài khoản đầu tiên.</p>${where('')}${short}<form id="admin-setup-form" class="auth-form">${formError('admin-setup-error')}${tokenField('admin-setup')}<label>Tên đăng nhập<input name="username" autocomplete="username" required minlength="3" maxlength="64" autocapitalize="none" spellcheck="false" aria-describedby="admin-setup-username-rule"><small class="field-hint" id="admin-setup-username-rule">${USERNAME_RULE}</small></label><label>Tên hiển thị (không bắt buộc)<input name="name" autocomplete="name" maxlength="100"></label>${newPassword('admin-setup','Mật khẩu')}<button class="primary" type="submit">Tạo tài khoản và đăng nhập</button></form>`);
 if(state.adminAuth==='recover')return card('Đặt lại mật khẩu quản trị',`<p class="login-lead">Nhập ADMIN_TOKEN của máy chủ để đặt mật khẩu mới; mọi phiên của tài khoản này sẽ bị đăng xuất.</p>${where(' Không có mã? Hãy nhờ người quản lý máy chủ.')}${short}<form id="admin-recover-form" class="auth-form">${formError('admin-recover-error')}${tokenField('admin-recover')}<label>Tên đăng nhập<input name="username" autocomplete="username" required maxlength="64" autocapitalize="none" spellcheck="false"></label>${newPassword('admin-recover','Mật khẩu mới')}<button class="primary" type="submit">Đặt mật khẩu mới và đăng nhập</button></form><p class="admin-auth-switch"><button type="button" class="link-button quiet" id="admin-back-login">← Quay lại đăng nhập</button></p>`);
 const notice=state.adminNotice?`<p class="auth-note admin-auth-notice" role="status" tabindex="-1" data-focus-first>${esc(state.adminNotice)}</p>`:'';
 return card('Đăng nhập quản trị',`${notice}<form id="admin-login-form" class="auth-form">${formError('admin-login-error')}<label>Tên đăng nhập<input name="username" autocomplete="username" required maxlength="64" autocapitalize="none" spellcheck="false"></label><label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><button class="primary" type="submit">Đăng nhập</button></form><p class="admin-auth-switch"><button type="button" class="link-button quiet" id="admin-forgot">Quên mật khẩu?</button></p>`);
}
// The sign-in card's own focus: a notice to read first (the session ended), else its heading after a switch of form.
function focusAdminAuth(){
 const target=state.focusAfterRender;state.focusAfterRender=null;if(!target)return;
 const element=document.querySelector?.('.login-card [data-focus-first]')||document.querySelector?.('.login-card h1');element?.setAttribute?.('tabindex','-1');element?.focus?.();
}
function showAdminAuth(view){state.adminAuth=view;state.adminNotice=null;state.focusAfterRender='heading';render();}
// The server names no field: its codes (backend/admin-auth.js) say which fields of an admin form an answer is about. A
// wrong username or password is one 401 with one message, on both fields; wrong_password and password_required are
// about your own password ("Mật khẩu của bạn"), any other password_ code about the new one.
function adminFields(error){
 const code=String(error.code||'');
 if(code==='admin_token_wrong')return ['token'];
 if(['wrong_password','password_required'].includes(code))return ['currentPassword'];
 if(['bad_username','username_taken','admin_not_found'].includes(code))return ['username'];
 if(code==='bad_name')return ['name'];
 if(code==='credentials_required'||error.status===401&&!code)return ['username','password'];
 return code.startsWith('password_')||WEAK_CODES.includes(code)?['password']:[];
}
function passwordsDiffer(form,data){if(String(data.get('password')||'')===String(data.get('confirm')||''))return false;clearFormError(form);showFormError(form,'Hai mật khẩu chưa khớp. Hãy nhập lại cho giống nhau.',['confirm']);return true;}
function submitAdminLogin(event){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form),body={username:String(data.get('username')||'').trim(),password:String(data.get('password')||'')};
 return sendForm(form,async()=>{await api('/admin/login',{method:'POST',body});await enterAdmin('Đã đăng nhập khu quản trị.');},adminFields);
}
// POST /api/admin/setup: with no admin yet it creates the first one; once one exists, the same token resets the named
// admin's password (recovery). The server signs that admin in; one that does not is asked to, with the password just
// chosen. The first-run form says so (first:true), so one whose first admin was made elsewhere meanwhile is refused
// (admin_exists) rather than taken as a reset, and leads to the sign-in form.
function submitAdminSetup(event,recover=false){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);if(passwordsDiffer(form,data))return;
 const username=String(data.get('username')||'').trim(),name=String(data.get('name')||'').trim(),password=String(data.get('password')||''),body={token:String(data.get('token')||''),username,...(name?{name}:{}),password,...(recover?{}:{first:true})};
 const message=recover?'Đã đặt mật khẩu mới và đăng nhập.':'Đã tạo tài khoản quản trị đầu tiên và đăng nhập.',toLogin=notice=>{state.status={authenticated:false};state.adminAuth='login';state.adminNotice=notice;state.focusAfterRender='heading';render();};
 return sendForm(form,async()=>{
  try{await api('/admin/setup',{method:'POST',body});}catch(error){
   if(error.code==='admin_exists'){toLogin(error.message);return;}
   throw error;
  }
  try{await enterAdmin(message);return;}catch(error){if(state.status.authenticated)throw error;}
  // The account is there (or its password is set); only signing in failed, e.g. after too many attempts.
  try{await api('/admin/login',{method:'POST',body:{username,password}});}catch(error){toLogin(`${recover?'Đã đặt mật khẩu mới':'Đã tạo tài khoản'} cho ${username}, nhưng chưa đăng nhập được: ${error.message}`);return;}
  await enterAdmin(message);
 },adminFields);
}
// After the server accepted a sign-in, /api/status must say so: a browser that did not keep the cookie is told in the
// form. A list that fails to load then is said in the same toast as the welcome; the console opens anyway. What the
// previous admin of this page left unsaved when the session ended goes only to that admin, never to another one signing
// in on the same computer.
async function enterAdmin(message){
 let failed=null;try{await refresh();}catch(error){if(!state.status.authenticated)throw error;failed=error;}
 if(!state.status.authenticated)throw new Error('Máy chủ đã nhận đăng nhập nhưng trình duyệt chưa giữ phiên quản trị. Hãy cho phép cookie của trang này rồi đăng nhập lại.');
 if(typeof state.endedFor==='string'&&state.endedFor!==(state.status.admin?.username||''))Object.assign(state,{adminDrafts:null,draftText:'',file:null,pdfAnalysis:null,jobMode:null,runMode:null});
 state.endedFor=null;state.adminNotice=null;state.adminAuth='login';state.loaded=true;render();
 if(failed)toast(`${message} Chưa tải được dữ liệu: ${failed.message}`);
}
// The server answered admin_signed_out (12 hours, 2 hours idle, signed out elsewhere or by a password change): the
// sign-in form comes back in place of the console. What was being typed (keepAdminDrafts) stays in this tab and is put
// back once signed in again; an open dialog closes, its error goes to the toast.
function adminSessionEnded(){
 if(!state.status.authenticated)return;
 keepAdminDrafts();clearInterval(poll);releaseAdminCovers();closeModal();
 state.endedFor=state.status.admin?.username||'';state.status={authenticated:false};state.admins=null;state.adminAuth='login';state.adminNotice='Phiên đã hết hạn. Đăng nhập lại để tiếp tục; phần đang soạn vẫn được giữ.';
 state.focusAfterRender='heading';render();
}
// Text that only the page holds: the source being typed (state.draftText), a job's edited text, a glossary. It comes back
// once the same job or book is open again and can be edited (restoreAdminDrafts, after each render of the console).
function keepAdminDrafts(){
 const source=$('#source-input');if(source)state.draftText=source.value;
 const fields={};for(const id of ['edit-source','edit-translation','glossary-text']){const field=$(`#${id}`);if(field&&!field.readOnly)fields[id]=field.value;}
 if(Object.keys(fields).length)state.adminDrafts={route:state.route,job:state.selected,glossary:state.glossaryId,fields};
}
function restoreAdminDrafts(){
 const kept=state.adminDrafts;if(!kept)return;
 if(kept.route!==state.route||state.route==='review'&&kept.job!==state.selected||state.route==='glossary'&&kept.glossary!==state.glossaryId){state.adminDrafts=null;return;}
 for(const [id,value] of Object.entries(kept.fields)){const field=$(`#${id}`);if(field&&!field.readOnly){field.value=value;delete kept.fields[id];}}
 if(!Object.keys(kept.fields).length)state.adminDrafts=null;
}
function submitAdminPassword(event){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form),currentPassword=String(data.get('currentPassword')||''),newPassword=String(data.get('newPassword')||'');
 if(newPassword!==String(data.get('confirm')||'')){clearFormError(form);showFormError(form,'Hai mật khẩu mới chưa khớp. Hãy nhập lại cho giống nhau.',['confirm']);return;}
 return sendForm(form,async()=>{const result=await api('/admin/password',{method:'POST',body:{currentPassword,newPassword}});form.reset?.();const ended=Number(result?.ended)||0;showFormDone(form,ended?'Đã đổi mật khẩu. Các nơi khác đã bị đăng xuất.':'Đã đổi mật khẩu.');},error=>['wrong_password','password_required'].includes(error.code)?['currentPassword']:error.status===400?['newPassword']:[]);
}
function submitAddAdmin(event){
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);if(passwordsDiffer(form,data))return;
 const username=String(data.get('username')||'').trim(),name=String(data.get('name')||'').trim();
 return sendForm(form,async()=>{const answer=await api('/admin/admins',{method:'POST',body:{username,...(name?{name}:{}),password:String(data.get('password')||''),currentPassword:String(data.get('currentPassword')||'')}});form.reset?.();await loadAdmins();showFormDone(form,`Đã thêm ${answer?.admin?.username||username}. Gửi riêng tên đăng nhập và mật khẩu cho người đó; họ nên đổi mật khẩu khi đăng nhập lần đầu.`);},adminFields);
}
// Signing out ends the session on the server first (POST /api/admin/logout; 401: there was none). Until it has, the
// admin stays signed in and is told why, as a student is (signOut): on a shared school computer "signed out" must be true.
// logout_incomplete: this browser's cookie is gone but the server kept the session row (it expires by itself); the
// answer's text is returned for the caller to show.
async function logout(){
 const response=await fetch('/api/admin/logout',{method:'POST',headers:ADMIN_HEADER}).catch(()=>{throw new Error('Không kết nối được máy chủ nên chưa đăng xuất được. Hãy kiểm tra mạng rồi thử lại.');});
 let data=null;if(!response.ok&&response.status!==401)try{data=await response.json();}catch{}
 if(!response.ok&&response.status!==401&&data?.code!=='logout_incomplete')throw new Error(`Chưa đăng xuất được (mã ${response.status}). Bạn vẫn đang đăng nhập; hãy thử lại sau vài giây.`);
 releaseAdminCovers();clearInterval(poll);state.status={authenticated:false};state.jobs=[];state.stories=[];state.requests=[];state.users=[];state.more={stories:null,jobs:null};state.jobDetails={};state.storyDetails={};state.userBooks={};state.admins=null;state.adminDrafts=null;state.endedFor=null;state.adminNotice=null;state.adminAuth='login';state.jobMode=null;state.runMode=null;state.file=null;state.pdfAnalysis=null;state.selected=null;state.draftText='';closeModal();state.focusAfterRender='heading';go('translate');
 return data?.error||'';
}
async function signOutAdmin(event){
 const button=event?.currentTarget;if(button)button.disabled=true;let note='';
 try{note=await logout();}finally{if(button?.isConnected)button.disabled=false;}
 toast(note||'Đã đăng xuất.');
}
function bindAdminAuth(){
 if(!adminArea)return;
 on('#admin-login-form','submit',submitAdminLogin);on('#admin-setup-form','submit',event=>submitAdminSetup(event));on('#admin-recover-form','submit',event=>submitAdminSetup(event,true));
 on('#admin-forgot','click',()=>showAdminAuth('recover'));on('#admin-back-login','click',()=>showAdminAuth('login'));
 on('#admin-password-form','submit',submitAdminPassword);on('#admin-add-form','submit',submitAddAdmin);bindAdminList();
 for(const [toggle,form,key] of [['#admin-password-toggle','#admin-password-form','password'],['#admin-add-toggle','#admin-add-form','add']])on(toggle,'click',event=>{const open=event.currentTarget.getAttribute('aria-expanded')!=='true',box=$(form);state.settingsOpen={...state.settingsOpen,[key]:open};event.currentTarget.setAttribute('aria-expanded',String(open));if(box){box.hidden=!open;if(open)box.querySelector('input:not([hidden])')?.focus();}});
}

function coverPlaceholder(s){return `<div class="book-art cover-placeholder"><span>${esc(s.title.slice(0,1))}</span></div>`;}
function coverArt(s){
 if(!s.cover_key)return coverPlaceholder(s);
 // In the admin console a private book's cover (a student's book, an unpublished draft) is shown from an object URL
 // fetched with the admin header (showAdminCovers): an <img> cannot send it, and the admin has no reader cookie.
 if(adminArea&&s.visibility==='private'){const url=adminCovers.get(`${s.id}:${s.cover_key}`);return url===''?coverPlaceholder(s):`<img class="book-cover" src="${url?esc(url):BLANK_IMAGE}" ${url?'':`data-admin-cover="${esc(s.id)}" data-cover-key="${esc(s.cover_key)}" `}alt="Bìa ${esc(s.title)}">`;}
 return `<img class="book-cover" src="/api/covers/${encodeURIComponent(s.id)}?v=${encodeURIComponent(s.cover_key)}" alt="Bìa ${esc(s.title)}" loading="lazy">`;
}
function releaseAdminCovers(view=''){for(const url of adminCovers.values())if(url)URL.revokeObjectURL(url);adminCovers.clear();adminCoverView=view;}
function showAdminCovers(){
 if(adminCoverView!==state.route)releaseAdminCovers(state.route);const view=adminCoverView;
 for(const img of document.querySelectorAll('img[data-admin-cover]')){
  const id=img.dataset.adminCover,version=img.dataset.coverKey,key=`${id}:${version}`;if(adminCovers.has(key))continue;adminCovers.set(key,null);
  fetch(`/api/covers/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`,{headers:ADMIN_HEADER}).then(response=>response.ok?response.blob():null).catch(()=>null).then(blob=>{
   // Another view (or signing out) cleared the list meanwhile: nothing is kept.
   if(adminCoverView!==view||adminCovers.get(key)!==null)return;
   const url=blob?URL.createObjectURL(blob):'';adminCovers.set(key,url);
   for(const node of document.querySelectorAll('img[data-admin-cover]'))if(node.dataset.adminCover===id&&node.dataset.coverKey===version){if(url){node.src=url;node.removeAttribute('data-admin-cover');}else node.outerHTML=coverPlaceholder({title:node.alt.replace(/^Bìa /u,'')});}
  });
 }
}
function uploadCoverPanel(){const s=state.stories.find(s=>s.id===state.storyId);return s?`<div class="upload-cover">${coverArt(s)}<div><strong>Ảnh bìa</strong><button type="button" data-cover="${s.id}">${s.cover_key?'Đổi ảnh bìa…':'Tải ảnh bìa…'}</button></div></div>`:'';}
function coverInput(){return `<label class="modal-field">Ảnh bìa<input type="file" name="cover" id="cover-input" accept="image/jpeg,image/png,image/webp" aria-describedby="cover-hint"><small class="field-hint" id="cover-hint">JPG, PNG, WebP · tối đa 5 MB · ảnh dọc 2:3</small></label><img id="cover-preview" class="cover-preview hide" alt="Xem trước ảnh bìa">`;}
function bindCoverPreview(){let previewUrl;const dialog=$('#modal');dialog.addEventListener('close',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);},{once:true});on('#cover-input','change',e=>{if(previewUrl)URL.revokeObjectURL(previewUrl);const image=$('#cover-preview');image.classList.add('hide');image.removeAttribute('src');const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){e.target.value='';throw new Error('Chọn ảnh JPG, PNG hoặc WebP tối đa 5 MB.');}previewUrl=URL.createObjectURL(file);image.src=previewUrl;image.classList.remove('hide');});}
function bindCoverButtons(){document.querySelectorAll('[data-cover]').forEach(b=>b.onclick=()=>{state.draftText=$('#source-input')?.value??state.draftText;const sid=b.dataset.cover;modal(`<h2>Ảnh bìa</h2>${coverInput()}`,async form=>{if(!form.get('cover')?.size)throw new Error('Hãy chọn ảnh bìa.');await api(`/stories/${sid}/cover`,{method:'POST',body:form});await refresh();render();},'Lưu ảnh bìa');bindCoverPreview();});}
// The job carries the "Cách dịch" chosen above (POST /api/jobs mode), so starting it sends none: the other parts queued
// with it keep their own. Its profile also says whether a scanned page may keep the text read on this device (hybrid) or
// always goes to Gemini (gemini).
// A PDF goes page by page when some page is read from its picture: a scan, or a page of text with Han in pictures or
// outlines (analyzePdf pictured); otherwise its cleaned text layer goes whole (parsed_text).
const pagewise=analysis=>['scan','hybrid'].includes(analysis?.mode)||analysis?.mode==='text'&&analysis.pictured>0;
async function uploadJob(e,prepareOnly){const sid=$('#story-select')?.value;if(!sid)throw new Error('Hãy chọn tài liệu trước.');const f=new FormData(),sourceFile=state.file,pdfAnalysis=state.pdfAnalysis,picked=$('#job-mode')?.value,mode=isMode(picked)?picked:chosenMode(),ocrPolicy=modeProfile(mode).textOcr;f.set('story_id',sid);f.set('mode',mode);if(state.tab==='file'){if(!sourceFile)throw new Error('Hãy chọn tài liệu.');if(sourceFile.name.toLowerCase().endsWith('.pdf')&&!pdfAnalysis)throw new Error('Hãy đợi phân tích PDF hoàn tất.');f.set('file',sourceFile);if(pdfAnalysis?.mode==='text'&&!pagewise(pdfAnalysis)){f.set('parsed_text',pdfAnalysis.text);f.set('pdf_pages',String(pdfAnalysis.totalPages));}if(pagewise(pdfAnalysis)){f.set('pdf_mode','scan');f.set('pdf_pages',String(pdfAnalysis.totalPages));}if(pdfAnalysis?.notes?.length)f.set('notes',JSON.stringify(pdfAnalysis.notes));}else f.set('text',$('#source-input').value);const genre=$('#genre').value;e.currentTarget.disabled=true;try{if(genre!==state.stories.find(s=>s.id===sid)?.genre){await api(`/stories/${sid}`,{method:'PATCH',body:{genre}});const story=state.stories.find(s=>s.id===sid);if(story)story.genre=genre;}const j=await api('/jobs',{method:'POST',body:f});state.selected=j.id;if(pagewise(pdfAnalysis)){
  const {uploadPreparedPdf,readPictureText,scanReading}=await import('./pdf-client.js');let localOcr=null,localOcrPages=0,fallback='',told=false;
  // Same on-device OCR (0 token) used by the student workspace: skip Gemini for pages a local pass
  // can already read confidently. Math/formula-heavy pages stay low-confidence and still go to Gemini.
  // When Tesseract reads in place of PaddleOCR, the progress line says why once, then names Tesseract on each page.
  try{
   await uploadPreparedPdf(sourceFile,pdfAnalysis,async(item,page,total)=>{
    const pageForm=new FormData(),send=()=>api(`/jobs/${j.id}/pdf-page`,{method:'POST',body:pageForm});pageForm.set('page',String(page));pageForm.set('total',String(total));
    // A page taken from its text layer, which the browser cleaned from each line's place: the server keeps its lines.
    if(item.kind==='text'&&!item.regions){pageForm.set('text',item.text);pageForm.set('cleaned','1');await send();return;}
    // A page image for Gemini to read. A page whose PDF gave a text layer as well (a searchable scan, a stamp over a
    // scan, a page of text with Han in pictures) sends that layer along: the server weighs the reading against it.
    const image=()=>{pageForm.set('image',item.blob,`page-${page}.${item.blob.type==='image/webp'?'webp':'jpg'}`);if(item.reclassified||item.regions)pageForm.set('hint',JSON.stringify({text:item.text,reason:item.reclassified||'pictured'}));};
    if(ocrPolicy==='gemini'){image();await send();return;}
    if(!localOcr){const [engine,policy]=await Promise.all([import('./local-ocr.js'),import('./ocr-policy.js')]);localOcr={...engine,...policy};}
    if(item.kind==='text'){
     // Han in pictures or outlines on a page of text, read on the device and set where it stands; a region the device
     // cannot read sends the page to Gemini. PaddleOCR's reading of letters or digits alone says a region holds no
     // Chinese (an English label, a formula); Tesseract's is not sure (readPictureText).
     const read=await readPictureText(item,async blob=>{const assessment=await localOcr.recognizeChinesePage(blob);fallback||=assessment.fallbackReason||'';return {text:assessment.text,sure:assessment.engine==='paddle'};},page);
     if(read.note)image();else{pageForm.set('text',read.text);pageForm.set('cleaned','1');localOcrPages++;}
     await send();return;
    }
    const assessment=await localOcr.recognizeChinesePage(item.blob);fallback||=assessment.fallbackReason||'';
    if(localOcr.shouldUseGeminiOcr(ocrPolicy,assessment))image();
    // A scan under its own OCR text or a stamp keeps that layer where the device read clearly fewer Han (scanReading).
    else{const merged=scanReading(item,assessment.text,page);pageForm.set('text',merged.text);if(merged.note)pageForm.set('note',merged.note);localOcrPages++;}
    await send();
   },(page,total,kind)=>{const notice=kind==='scan'&&fallback&&!told?localOcr.fallbackNotice(fallback):'';told||=Boolean(notice);toast(`Đang chuẩn bị PDF · ${page}/${total} trang · ${kind!=='scan'?'lớp chữ':ocrPolicy==='gemini'?'ảnh trang để Gemini đọc':notice?`kiểm tra OCR cục bộ. ${notice}`:`kiểm tra OCR cục bộ${fallback?' bằng Tesseract':''}`}`);});
   if(localOcrPages)toast(`Đã nhận dạng cục bộ ${localOcrPages} trang${fallback?' bằng Tesseract':''} (0 token Gemini); các trang còn lại sẽ OCR bằng Gemini khi dịch.`);
  }finally{if(localOcr)await localOcr.terminateLocalOcr().catch(()=>{});}
 }state.file=null;state.pdfAnalysis=null;await refresh();go('review');if(prepareOnly)await prepareJob(j.id);else if(state.status.aiConfigured)await runJob(j.id);else toast('Đã lưu tài liệu. Thêm khóa Gemini trong Cài đặt để bắt đầu dịch.');}finally{if($('#start-translate'))$('#start-translate').disabled=false;}}

// The dialog's controls have ids of their own: the page's #rerun and #run-mode get their handlers again on every render(),
// which would bind them to the dialog (one press, two paid runs). A run going on in this tab is never joined by another.
function rerunDialog(){
 if(busy)return;const j=state.jobs.find(job=>job.id===state.selected);if(!j)return;const mode=jobMode(j);
 modal(`<h2>Dịch lại ${esc(j.filename)}?</h2><p class="subtitle">Lượt dịch mới tốn token và thay bản dịch đang chờ duyệt.</p><label class="run-mode modal-field">Cách dịch<select id="rerun-mode" name="mode">${MODES.map(id=>`<option value="${id}"${id===mode?' selected':''}>${esc(modeName(id))}</option>`).join('')}</select></label>`,form=>{if(busy)throw new Error('Đang có lượt dịch khác; đợi lượt đó xong rồi dịch lại.');const picked=String(form.get('mode')||'');if(picked!==mode&&isMode(picked))state.runMode={job:j.id,mode:picked};runJob(j.id,{mode:pickedRunMode(j.id)}).catch(error=>toast(error.message));},'Dịch lại',{confirmId:'rerun-confirm'});
}
async function prepareJob(jid){busy=true;try{let result;do{result=await api(`/jobs/${jid}/prepare`,{method:'POST'});state.jobs=state.jobs.map(j=>j.id===jid?{...j,...result}:j);jobsChanged();}while(state.status.authenticated&&result.status==='splitting');if(result.status==='prepared')toast('Đã chia xong PDF. Bấm Bắt đầu dịch khi sẵn sàng.');}finally{busy=false;await refresh();jobsChanged();}}
async function showPdfParts(){const data=await api(`/jobs/${state.selected}/parts`);modal(`<h2>Các phần PDF</h2><p class="subtitle">${data.totalPages?`${data.totalPages} trang · ${data.parts.length} phần (${data.pagesPerPart} trang/phần)`:'Chưa chia; “Bắt đầu dịch” sẽ tự chia.'}</p>${data.parts.length?`<ol class="pdf-parts">${data.parts.map(p=>`<li>Phần ${p.index+1} <span>Trang ${p.startPage}–${p.endPage}</span></li>`).join('')}</ol>`:''}`,async()=>{},'Đóng',{cancel:false});}
async function downloadBook(){await adminDownload(`/jobs/${encodeURIComponent(state.selected)}/book`,(state.jobs.find(j=>j.id===state.selected)?.story_title||'ban-dich')+'.txt','Không tải được bản dịch');}
// Admin downloads (a request's file, a job's original, full source or joined translation): a refusal, a server error or
// a lost connection is said in the toast, like any other failure (callers go through on() or catch it); a session that
// ended brings back the sign-in form, as in api().
async function adminDownload(path,name,failure){
 const response=await fetch('/api'+path,{headers:ADMIN_HEADER}).catch(()=>{throw new Error('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.');});
 if(!response.ok){const data=await response.json().catch(()=>null);if(response.status===401&&data?.code==='admin_signed_out')adminSessionEnded();throw new Error(data?.error||`${failure} (mã ${response.status}).`);}
 const blob=await response.blob().catch(()=>{throw new Error(`${failure}: kết nối bị ngắt giữa chừng. Hãy thử lại.`);}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function bindAdminContent(){
 on('#import-chapter','click',()=>importChapter());
 document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>importChapter(b.dataset.import));
 document.querySelectorAll('[data-chapters]').forEach(b=>b.onclick=()=>showChapters(b.dataset.chapters).catch(e=>toast(e.message)));
 document.querySelectorAll('[data-rename-story]').forEach(b=>b.onclick=()=>renameStory(b.dataset.renameStory));
 bindDeletes(document);
}
// Buttons that open a view (data-route) or a job (data-job), and the "Xóa" ones of rows: bound by assignment, so a part of
// the page drawn again on its own (jobsChanged) can bind its buttons again without doubling any.
function bindOpeners(root){root.querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>go(b.dataset.route));root.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{state.selected=b.dataset.job;go('review');});}
function bindDeletes(root){
 for(const [kind,field,collection,label,details] of [['job','deleteJob',state.jobs,'tài liệu','Xóa bản gốc, các phần PDF, bản dịch và phần đã công bố của tài liệu này.'],['story','deleteStory',adminStories(),'tài liệu','Xóa mọi phần, bản gốc, bản dịch và ảnh bìa của tài liệu khỏi thư viện.'],['request','deleteRequest',state.requests,'yêu cầu','Xóa yêu cầu của học sinh.']]){
  root.querySelectorAll(`[data-delete-${kind}]`).forEach(b=>b.onclick=()=>{const item=collection.find(x=>x.id===b.dataset[field]);confirmDelete(kind,item?.id,item?.title||item?.filename||label,details);});
 }
}
function confirmDelete(kind,id,title,details){
 if(!id)return;const endpoints={job:'jobs',story:'stories',request:'requests',chapter:'chapters'};
 modal(`<h2>Xóa ${esc(title)}?</h2><p class="subtitle">${esc(details)} Không thể hoàn tác.</p><label class="confirm-check"><input type="checkbox" required> Tôi muốn xóa.</label>`,async()=>{await api(`/${endpoints[kind]}/${id}`,{method:'DELETE'});if(kind==='job'&&state.selected===id)state.selected=null;if(kind==='story'){state.selected=null;if(state.storyId===id)state.storyId='';}await refresh();render();toast('Đã xóa.');},'Xóa',{danger:true});
}
async function showChapters(sid){
 const chapters=await api(`/stories/${sid}/chapters`);
 modal(`<h2 tabindex="-1">Các phần đã công bố</h2><p class="subtitle">${chapters.length} phần</p><div class="chapter-admin-list">${chapters.map((c,index)=>`<div><span class="chapter-admin-number">${String(index+1).padStart(2,'0')}</span><span class="chapter-admin-title"><strong>${esc(c.title)}</strong><small>${c.mime==='application/pdf'?'PDF':'Văn bản'}</small></span><button type="button" class="danger" data-delete-chapter="${c.id}">Xóa phần…</button></div>`).join('')||'<p class="empty-line">Chưa có phần nào.</p>'}</div>`,async()=>{},'Đóng',{cancel:false});$('#modal h2')?.focus();
 document.querySelectorAll('[data-delete-chapter]').forEach(b=>b.onclick=()=>{const chapter=chapters.find(c=>c.id===b.dataset.deleteChapter);confirmDelete('chapter',chapter.id,chapter.title,'Gỡ phần này khỏi thư viện; bản dịch trong Xưởng dịch (nếu có) vẫn được giữ để đăng lại.');});
}
function renameStory(sid){
 const story=adminStory(sid);if(!story)return;
 modal(`<h2>Đổi tên tài liệu</h2><label class="modal-field">Tên tài liệu<input name="title" value="${esc(story.title)}" required minlength="1" maxlength="200" autocomplete="off"></label>`,async form=>{const title=String(form.get('title')||'').trim();await api(`/stories/${sid}`,{method:'PATCH',body:{title}});await refresh();render();},'Lưu tên');
 setTimeout(()=>$('#modal input[name="title"]')?.select());
}

function importChapter(sid){
 if(!state.stories.length){toast('Hãy tạo tài liệu trước.');createStory();return;}
 modal(`<h2>Tải bản đã dịch lên</h2><label class="modal-field">Tài liệu<select name="story_id">${state.stories.map(s=>`<option value="${s.id}" ${s.id===sid?'selected':''}>${esc(s.title)}</option>`).join('')}</select></label><label class="modal-field">Tên phần<input name="title" required maxlength="200"></label><label class="modal-field">Tệp<input id="publication-file" name="file" type="file" accept=".txt,.docx,.pdf" required aria-describedby="publication-hint"><small class="field-hint" id="publication-hint">TXT, DOCX hoặc PDF · tối đa 25 MB</small></label><p id="import-status" class="status" role="status"></p><label id="publication-text-label" class="hide">Nội dung (có thể biên tập)<textarea name="content" id="publication-text" rows="9"></textarea></label><iframe id="publication-pdf" class="reader-pdf hide" title="Xem trước PDF"></iframe><label class="confirm-check"><input name="confirmed" value="true" type="checkbox" required> Tôi đã đối chiếu và đồng ý công bố.</label>`,async form=>{if(!ready)throw new Error('Hãy đợi xem trước xong.');await api(`/stories/${form.get('story_id')}/chapters`,{method:'POST',body:form});await refresh();render();toast('Đã công bố trong Thư viện.');},'Công bố');
 let ready=false,sequence=0,previewUrl;
 $('#modal').addEventListener('close',()=>{sequence++;if(previewUrl)URL.revokeObjectURL(previewUrl);},{once:true});
 on('#publication-file','change',async e=>{
  ready=false;const current=++sequence,file=e.target.files[0];$('#publication-text-label').classList.add('hide');$('#publication-pdf').classList.add('hide');$('#publication-text').value='';if(previewUrl)URL.revokeObjectURL(previewUrl);if(!file)return;
  $('#import-status').textContent='Đang đọc tệp…';const form=new FormData();form.set('file',file);
  try{const data=await api('/import-preview',{method:'POST',body:form});if(current!==sequence)return;
   if(data.mime==='application/pdf'){previewUrl=URL.createObjectURL(file);$('#publication-pdf').src=previewUrl;$('#publication-pdf').classList.remove('hide');}
   else{$('#publication-text').value=data.content;$('#publication-text-label').classList.remove('hide');}
   $('#import-status').textContent='';ready=true;
  }catch(error){if(current===sequence)$('#import-status').textContent='Không đọc được tệp: '+error.message;}
 });
}

// "Nghe" turns into "Dừng" while the part is read aloud, and back when it ends or is stopped. The name carries the state
// (no aria-pressed, which would be heard as "Dừng, pressed").
function setSpeaking(on){state.speaking=Boolean(on);const button=$('#speak');if(!button)return;button.classList.toggle('is-speaking',state.speaking);button.title=state.speaking?'Dừng đọc':'Nghe đọc tiếng Việt';button.innerHTML=`${icon(state.speaking?'stop':'headphones')}<span>${state.speaking?'Dừng':'Nghe'}</span>`;}
function changeReaderFont(delta){state.fontSize=Math.max(16,Math.min(30,state.fontSize+delta));try{localStorage.setItem('readerFontSize',String(state.fontSize));}catch{}const prose=$('.prose');if(prose)prose.style.fontSize=state.fontSize+'px';const value=$('.font-value');if(value)value.textContent=state.fontSize;$('#font-smaller').disabled=state.fontSize<=16;$('#font-larger').disabled=state.fontSize>=30;}

function normalizeLibraryText(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().trim();}
function filterLibrary(){
 const counter=$('#library-result-count');if(!counter)return;
 const query=normalizeLibraryText(state.libraryQuery);let count=0;
 document.querySelectorAll('[data-library-index]').forEach(card=>{const book=state.library[Number(card.dataset.libraryIndex)];const matches=(!state.libraryGenre||book.genre===state.libraryGenre)&&normalizeLibraryText(`${book.title} ${book.author||''}${isSample(book)?` ${SAMPLE_LABEL}`:''}`).includes(query);card.hidden=!matches;if(matches)count++;});
 document.querySelectorAll('[data-library-genre]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.libraryGenre===(state.libraryGenre||''))));
 // The count shows only while a search or a genre narrows the list; otherwise screen readers alone hear the total.
 const filtered=Boolean(query||state.libraryGenre);counter.textContent=state.loaded?filtered?`${count} kết quả`:`${state.library.length} tài liệu`:'Đang tải thư viện…';counter.classList.toggle('sr-only',!filtered||!count);
 $('#library-no-results').hidden=count>0||state.library.length===0;
}

function homeAtmosphere(){return `<div class="home-atmosphere" aria-hidden="true">${Array.from({length:7},(_,i)=>`<svg class="drifting-leaf" style="--leaf:${i};left:${8+i*14}%" viewBox="0 0 60 24"><path d="M2 21Q18-8 58 3Q39 30 2 21Z" fill="currentColor"/><path d="M3 21 54 5" stroke="#edf0df" stroke-width=".8"/></svg>`).join('')}<div class="mist mist-one"></div><div class="mist mist-two"></div></div>`;}


