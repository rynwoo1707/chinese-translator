import {musicMarkup,bindMusic} from './music.js';
import {renderMathText,mathStyles} from './math-text.js';
import {termMatcher,highlightTerms,bindTermPopover,hideTermPopover} from './reader-terms.js';
import {attachHanziLookup,openHanziPanel,closeHanziPanel,setHanziTheme} from './hanzi-lookup.js';
import {footerHtml} from './site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleReaderNotice,SAMPLE_LABEL} from './library-samples.js';
import {bilingualSource,mountBilingual,mountPdfPages,releaseBilingual} from './bilingual-reader.js';
import {inAppBrowser,openInBrowserHelp} from './in-app-browser.js';
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
// The server refuses an ADMIN_TOKEN under 32 characters outside this machine; no token typed here can open it then.
const ADMIN_TOKEN_SHORT='ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự nên trang quản trị đang khóa. Đặt lại bằng npx wrangler secret put ADMIN_TOKEN (nên dùng 64 ký tự hex).';
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
let state={route:currentRoute(),stories:[],users:[],jobs:[],requests:[],more:{stories:null,jobs:null},jobDetails:{},storyDetails:{},userBooks:{},library:[],myLibrary:[],myRequests:[],reader:{authenticated:false},status:{},file:null,pdfAnalysis:null,tab:'file',selected:null,reviewStory:null,showReviewQueue:false,chapters:[],chapter:0,theme:['paper','light','night'].includes(savedTheme)?savedTheme:'paper',fontSize:Math.max(16,Math.min(30,Number(savedFontSize)||19))};let token='',poll=null,busy=false;
const OFFLINE='Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.';
// Covers of private books in the admin console (coverArt, showAdminCovers): "<id>:<cover_key>" -> object URL ('' when
// it could not be loaded, null while it loads), for the view they were made in; revoked when the admin opens another
// view or signs out.
const BLANK_IMAGE='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',adminCovers=new Map();let adminCoverView='';
// The server's own error text is shown as is; status, code and retryAfter ride along for the callers that react to them.
// onResponse sees the response itself (a paged admin list reads its X-Next-Offset header there).
async function api(path,{onResponse=null,...options}={}){
 const headers={...(token?{Authorization:`Bearer ${token}`}:{})};if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const failed=(message,status,data=null)=>Object.assign(new Error(message),{status,code:data?.code||'',retryAfter:data?.retryAfter??null});
 const r=await fetch('/api'+path,{...options,headers:{...headers,...options.headers}}).catch(()=>{throw failed(OFFLINE,0);});
 onResponse?.(r);
 if(r.status===204)return null;
 const d=await r.json().catch(()=>null);
 // A page instead of JSON usually means the server is restarting or being updated, not that the request was wrong.
 if(!d||typeof d!=='object')throw failed(`Máy chủ trả về phản hồi không đọc được (mã ${r.status}). Có thể máy chủ đang cập nhật; hãy thử lại sau vài giây.`,r.status);
 if(!r.ok)throw failed(d.error||'Kết nối thất bại.',r.status,d);
 return d;
}
// The toast region stays rendered while idle (only visually hidden), so screen readers already know it as a live region
// when its first message arrives.
{const box=document.querySelector?.('#toast');box?.setAttribute?.('aria-live','polite');box?.setAttribute?.('aria-atomic','true');}
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
const GOOGLE_FAILURES={google_cancelled:'Bạn đã hủy đăng nhập bằng Google.',google_error:'Google chưa hoàn tất đăng nhập. Hãy thử lại.',google_state:'Phiên đăng nhập Google đã hết hạn hoặc không hợp lệ. Hãy bấm “Tiếp tục bằng Google” lại.',google_failed:'Chưa xác nhận được đăng nhập với Google. Hãy thử lại sau ít phút.',google_unverified:'Tài khoản Google này chưa xác minh email nên không dùng để đăng nhập được.',google_email_invalid:'Email của tài khoản Google không hợp lệ.',google_email_has_password:'Email của tài khoản Google này đã có một tài khoản Hoa Trí đăng nhập bằng mật khẩu, nên Hoa Trí không tạo thêm tài khoản thứ hai. Hãy đăng nhập bằng email và mật khẩu đó. Nếu quên mật khẩu, hoặc bạn không tạo tài khoản đó, hãy xem mục “Quên mật khẩu?” bên dưới để liên hệ quản trị viên.',account_disabled:'Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên.',registration_closed:'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.',google_not_configured:'Đăng nhập Google chưa được cấu hình trên máy chủ.',terms_required:'Hãy đánh dấu ô đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư trước khi tiếp tục bằng Google.',server_error:'Máy chủ gặp lỗi khi đăng nhập bằng Google. Hãy thử lại sau ít phút.'};
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
 const personal=()=>Promise.allSettled([api('/my/library'),api('/my/requests')]),early=state.reader?.authenticated?personal():null;
 const [library,me]=await Promise.allSettled([api('/library'),api('/me')]);const errors={};
 if(library.status==='fulfilled')state.library=Array.isArray(library.value)?library.value:[];else errors.library=library.reason;
 if(me.status==='fulfilled')state.reader=me.value||{authenticated:false};else errors.me=me.reason;
 const [mine,requests]=state.reader.authenticated?await (early||personal()):[];
 const own=(result,name)=>{if(!result)return [];if(result.status==='fulfilled')return Array.isArray(result.value)?result.value:[];errors[name]=result.reason;return [];};
 state.myLibrary=own(mine,'myLibrary');state.myRequests=own(requests,'myRequests');state.errors=errors;
}}
// Public pages keep "/" for the library and #reader/<storyId>/<part> for an open book; replace is for a part change.
function setUrl(hash,replace=false){if(adminArea||!globalThis.history?.pushState){location.hash=hash;return;}const url=location.pathname+(hash?'#'+hash:'');if(url===location.pathname+location.search+location.hash)return;history[replace?'replaceState':'pushState'](null,'',url);}
const readerHash=()=>state.readerStory?.id?`reader/${encodeURIComponent(state.readerStory.id)}/${state.chapter+1}`:'reader';
function go(route,{replace=false}={}){globalThis.speechSynthesis?.cancel();if(adminArea&&!adminRoutes.has(route)){location.href='/#'+route;return;}const from=state.route;state.route=adminArea?(adminRoutes.has(route)?route:'translate'):(publicRoutes.includes(route)?route:'library');if(adminArea)location.hash=state.route;else{if(state.route!=='account')leftAccount();setUrl(state.route==='reader'?readerHash():state.route==='library'?'':state.route,replace);}if(from!==state.route||state.route==='reader')state.focusAfterRender=state.route==='library'&&from==='reader'?'book':'heading';render();}
const nav=[['translate','translate','Xưởng dịch'],['stories','book','Kho tài liệu Hoa Trí'],['users','grid','Học sinh & Thư viện riêng'],['review','file','Đối chiếu bản dịch'],['requests','chat','Yêu cầu dịch'],['glossary','book','Thuật ngữ học thuật']];
// Translation requests waiting for the admin (status pending) show as a count on the "Yêu cầu dịch" button, also on
// phones, and in the tab's title, so they are not left unseen while the console stays open: the list is asked for again
// every 5 minutes and when the admin comes back to the tab (at most once a minute), and only the count and the title
// are redrawn then, never a form being edited.
const pendingRequests=()=>state.requests.filter(request=>request.status==='pending').length;
const requestBadge=()=>{const count=pendingRequests();return count?`<span class="count" aria-hidden="true">${count}</span><span class="visually-hidden"> (${count} yêu cầu mới)</span>`:'';};
const navButton=([route,name,label])=>`${icon(name)}${label}${route==='requests'?requestBadge():''}`;
const adminTitle=()=>`${pendingRequests()?`(${pendingRequests()}) `:''}Hoa Trí — Quản trị`;
const REQUEST_CHECK_MS=5*60*1000;let requestsCheckedAt=0,watchingRequests=false;
async function checkRequests(){
 if(!adminArea||!state.status.authenticated||Date.now()-requestsCheckedAt<60*1000)return;requestsCheckedAt=Date.now();
 const rows=await api('/requests').catch(()=>null);if(!Array.isArray(rows)||!state.status.authenticated)return;
 state.requests=rows;document.title=adminTitle();
 const button=document.querySelector?.('.sidebar [data-route="requests"]');if(button)button.innerHTML=navButton(nav.find(([route])=>route==='requests'));
}
function watchRequests(){
 if(watchingRequests)return;watchingRequests=true;
 const tick=()=>{checkRequests().finally(()=>globalThis.setTimeout?.(tick,REQUEST_CHECK_MS));};globalThis.setTimeout?.(tick,REQUEST_CHECK_MS);
 document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible')checkRequests();});window.addEventListener?.('focus',()=>{checkRequests();});
}
// Entrance motion when the page changes or its data first arrives, not on every re-render (theme, font size, filters).
let lastPublicView=null;
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
 if(!adminArea){const key=focusKey(document.activeElement);document.title=pageTitle();document.documentElement?.classList?.toggle('is-reading',state.route==='reader');$('#app').innerHTML=publicLayout();const view=`${state.route}:${Boolean(state.loaded)}`;if(view!==lastPublicView){if(state.route!=='reader')$('.public-content')?.classList.add('route-enter');lastPublicView=view;}bind();decorateReader();restoreFocus(key);restorePlace();if(state.pendingRequest&&state.reader.authenticated&&state.route==='account'){state.pendingRequest=false;requestStory();}return;}
 document.title=adminTitle();
 if(!state.status.authenticated){$('#app').innerHTML=loginView();bind();return;}
 if(state.route==='review'&&state.selected&&!jobDetail(state.selected))loadJobDetail(state.selected);
 if(state.route==='glossary'&&state.glossaryId&&glossaryOf(state.glossaryId)===null)loadStoryDetail(state.glossaryId);
 const label=nav.find(x=>x[0]===state.route)?.[2]||({settings:'Cài đặt',library:'Thư viện',reader:'Đọc tài liệu',glossary:'Tên & thuật ngữ'}[state.route])||'Xưởng dịch';
 $('#app').innerHTML=`<div class="shell"><aside class="sidebar"><a class="brand" href="#translate"><img src="/favicon.svg" alt=""><div><strong>Hoa Trí<span style="color:var(--red)">.</span></strong><small>TRUNG VĂN · VIỆT NGỮ</small></div></a><div class="nav-label">QUẢN TRỊ VIÊN</div><nav class="nav" aria-label="Quản lý nội dung">${nav.map(([r,i,t])=>`<button data-route="${r}" class="${state.route===r?'active':''}" ${state.route===r?'aria-current="page"':''}>${navButton([r,i,t])}</button>`).join('')}</nav><div class="side-bottom"><div class="engine"><strong style="font-size:12px">${icon('spark')} &nbsp; Gemini Flash</strong><p><span class="dot" style="background:${state.status.aiConfigured?'#7e9169':'#bb9b60'}"></span>${state.status.aiConfigured?'Sẵn sàng dịch thuật':'Chờ kết nối API'}<br>Thuật ngữ nhất quán. Trích dẫn nguyên vẹn.</p></div><nav class="nav" aria-label="Hệ thống"><button data-route="settings" class="${state.route==='settings'?'active':''}">${icon('settings')}Cài đặt</button><button id="admin-logout">${icon('arrow')}Đăng xuất</button></nav><div class="profile"><span class="avatar">HT</span><div style="font-size:12px">Không gian biên tập<small>${state.status.authenticated?'Quản trị viên':'Chưa đăng nhập'}</small></div></div></div></aside><main class="main"><header class="topbar"><span>Khu quản trị <span style="margin-left:14px">/</span><b>${label}</b></span><a href="/">Xem thư viện tài liệu ${icon('arrow')}</a></header><div class="content">${view()}<footer class="footer"><span>HOA TRÍ &nbsp; / &nbsp; Mỗi câu chữ, một hành trình.</span><span>Trung văn → Việt ngữ</span></footer></div></main></div>`;bind();showAdminCovers();}
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
 globalThis.speechSynthesis?.cancel();state.chapter=Math.max(0,Math.min(state.chapters.length-1,index));state.readerMore=false;setUrl(readerHash(),true);
 if(!keepFocus)state.focusAfterRender='heading';render();
 const article=document.querySelector?.('.reader-layout .reader');if(article?.scrollIntoView)article.scrollIntoView({block:'start',behavior:prefersReducedMotion()?'auto':'smooth'});else globalThis.scrollTo?.({top:0});
}
async function shareReader(){
 const story=state.readerStory;if(!story?.id)return;const url=`${location.origin}/?read=${encodeURIComponent(story.id)}&phan=${state.chapter+1}`,title=pageTitle();
 if(typeof navigator.share==='function'&&(navigator.canShare?.({title,url})??true))try{await navigator.share({title,url});return;}catch(error){if(error?.name==='AbortError')return;}
 try{await navigator.clipboard.writeText(url);}catch{throw new Error(`Không sao chép tự động được. Hãy sao chép liên kết này: ${url}`);}
 const button=$('#reader-share'),label=button?.querySelector('span');if(label){label.textContent='Đã sao chép';clearTimeout(shareReader.timer);shareReader.timer=setTimeout(()=>{if(label.isConnected)label.textContent='Chia sẻ';},2500);}
 toast('Đã sao chép liên kết đến phần này. Dán vào tin nhắn để gửi cho bạn bè hoặc lớp học.');
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
 api(story.study?`/my/study/books/${encodeURIComponent(story.id)}/assembly`:`/library/${encodeURIComponent(story.id)}/assembly`).then(data=>{entry.data=data;},()=>{}).finally(()=>{entry.done=true;if(state.readerAssembly===entry)assemblyLoaded();});
 return entry;
}
function bilingualFor(chapter){const assembly=readerAssembly();return assembly?.data&&chapter?bilingualSource(assembly.data,chapter.id):null;}
function pdfTools(chapter){
 const source=bilingualFor(chapter);if(!source)return '';
 return `<button type="button" class="bilingual-toggle" id="bilingual-toggle" aria-pressed="${Boolean(state.bilingual)}">${icon('book')}<span>Đọc song ngữ</span></button><span class="bilingual-toggle-hint">Xem trang gốc cùng bản dịch</span><a class="bilingual-original-link" href="${esc(source.url)}#page=${source.pages[0]}" target="_blank" rel="noopener">Mở PDF gốc ↗</a>`;
}
const pdfMode=chapter=>state.bilingual&&bilingualFor(chapter)?'bilingual':compactPdf()?'pages':'frame';
function pdfFrame(chapter){return {bilingual:'<div class="bilingual-root" id="bilingual-root"></div>',pages:'<div class="pdf-pages-root" id="pdf-pages-root"></div>'}[pdfMode(chapter)]||`<iframe class="reader-pdf" title="${esc(chapter.title)}" src="/api/chapter-file/${encodeURIComponent(chapter.id)}"></iframe>`;}
// Only the PDF area is redrawn, so the reader keeps its place and the focus stays on the toggle.
function renderPdfArea(){
 const chapter=state.chapters[state.chapter],tools=$('#reader-pdf-tools'),area=$('#reader-pdf-area');if(!tools||!area||chapter?.mime!=='application/pdf')return;
 const focused=document.activeElement?.id==='bilingual-toggle';tools.innerHTML=pdfTools(chapter);
 const wanted=pdfMode(chapter),shown=area.querySelector('#bilingual-root')?'bilingual':area.querySelector('#pdf-pages-root')?'pages':'frame';
 if(wanted!==shown){closeBilingual();area.innerHTML=pdfFrame(chapter);}
 on('#bilingual-toggle','click',toggleBilingual);if(focused)$('#bilingual-toggle')?.focus();syncBilingual();
}
function toggleBilingual(){state.bilingual=!state.bilingual;renderPdfArea();}
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
// kicker, title and desc are plain text and escaped here (a story title comes from a student's request); action is markup.
function heading(kicker,title,desc,action=''){return `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="subtitle">${esc(desc)}</p></div>${action}</div>`;}
function view(){switch(state.route){case 'translate':return translateView();case 'review':return reviewView();case 'stories':return storiesView();case 'users':return usersView();case 'requests':return requestsView();case 'settings':return settingsView();case 'glossary':return glossaryView();case 'library':return libraryView();case 'reader':return readerView();default:return translateView();}}
function storyOptions(){const option=s=>`<option value="${s.id}" ${s.id===state.storyId?'selected':''}>${esc(s.title)}</option>`,web=state.stories.filter(s=>!s.owner_user_id),personal=state.stories.filter(s=>s.owner_user_id);return `${web.length?`<optgroup label="Kho học liệu Hoa Trí">${web.map(option).join('')}</optgroup>`:''}${personal.length?`<optgroup label="Tài liệu của người học">${personal.map(s=>`<option value="${s.id}" ${s.id===state.storyId?'selected':''}>${esc(s.title)} · ${esc(s.owner_name||s.owner_email||'Người học')}</option>`).join('')}</optgroup>`:''}`;}
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
// so saving never replaces its terms with an empty list. null while unknown.
function glossaryOf(id){
 const row=adminStory(id);if(typeof row?.glossary==='string')return row.glossary;
 const entry=state.storyDetails[id];if(entry?.data)return typeof entry.data.glossary==='string'?entry.data.glossary:'{}';
 return null;
}
function loadStoryDetail(id,{again=false}={}){
 if(!id||!again&&state.storyDetails[id])return;
 const entry=state.storyDetails[id]={loading:true,data:null,error:null};
 api(`/stories/${encodeURIComponent(id)}`).then(data=>{entry.data=data;},error=>{entry.error=error;}).finally(()=>{entry.loading=false;if(state.storyDetails[id]===entry&&state.route==='glossary')render();});
}
const glossaryTerms=text=>{try{const value=JSON.parse(text||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
// One student's books (GET /api/user-library?user=), loaded when the admin opens them; again: a reload after a change.
function loadUserBooks(userId,{again=false,more=false}={}){
 const old=state.userBooks[userId];if(!again&&!more&&old)return;
 const offset=more?old?.next:0;if(more&&(offset===null||offset===undefined))return;
 const entry=state.userBooks[userId]={rows:more?old.rows:old?.rows||[],next:old?.next??null,loading:true,error:null};
 apiPage(`/user-library?user=${encodeURIComponent(userId)}&offset=${offset}&limit=${more?PAGE:Math.max(PAGE,Math.min(PAGE_MAX,old?.rows?.length||0))}`).then(page=>{entry.rows=more?[...entry.rows,...page.rows.filter(row=>!entry.rows.some(item=>item.id===row.id))]:page.rows;entry.next=page.next;},error=>{entry.error=error;}).finally(()=>{entry.loading=false;if(state.userBooks[userId]===entry&&state.route==='users')render();});
}
function userShelf(user,count){
 const id=esc(user.id),shelf=state.userBooks[user.id];
 if(!count&&!shelf?.rows?.length)return '<div class="empty">Người học này chưa có tài liệu.</div>';
 if(!shelf)return `<button type="button" class="user-books-open" data-user-books="${id}">Xem ${count} tài liệu</button>`;
 if(shelf.error&&!shelf.rows.length)return `<div class="warning" role="alert">Chưa tải được tài liệu của người học này: ${esc(shelf.error.message)} <button type="button" data-user-books-retry="${id}">Thử lại</button></div>`;
 if(shelf.loading&&!shelf.rows.length)return '<p class="note" role="status">Đang tải tài liệu…</p>';
 return `${shelf.rows.map(s=>adminStoryCard(s,s.visibility==='public'?'Đã chia sẻ':'Thư viện riêng')).join('')}<div class="load-more">${shelf.next!==null?`<button type="button" data-user-books-more="${id}" ${shelf.loading?'disabled':''}>Tải thêm tài liệu</button>`:''}<button type="button" data-user-books-hide="${id}">Thu gọn</button></div>`;
}
// While jobs run, only their rows are asked for (GET /api/jobs?ids=); a job whose status changed has its text fetched
// again for the editor.
async function pollJobs(ids){
 const wanted=ids.filter(Boolean).slice(0,100);if(!wanted.length)return;
 const rows=await api(`/jobs?ids=${wanted.map(encodeURIComponent).join(',')}`);if(!Array.isArray(rows))return;
 for(const row of rows){const old=state.jobs.find(job=>job.id===row.id);if(old&&old.status!==row.status)delete state.jobDetails[row.id];}
 state.jobs=state.jobs.map(job=>rows.find(row=>row.id===job.id)||job);
}
function translateView(){return heading('XƯỞNG DỊCH HỌC THUẬT','Từ nguyên tác đến bản dịch có thể kiểm chứng.','Dịch chuyên khảo Trung – Việt phục vụ học tập và nghiên cứu trong trường phổ thông.',`<div class="button-row"><button data-route="review">${icon('clock')} &nbsp; Lịch sử dịch</button></div>`)+`<div class="stats">${[['file','Tài liệu đã tải',listCount('jobs'),'tài liệu'],['translate','Chờ đối chiếu',listCount('jobs',state.jobs.filter(j=>j.status==='review').length),'bản dịch'],['book','Đã duyệt',listCount('jobs',state.jobs.filter(j=>j.status==='published').length),'tài liệu'],['chat','Yêu cầu mới',String(state.requests.filter(r=>r.status==='pending').length),'từ người học']].map(([i,t,n,s])=>`<div class="stat"><div class="stat-top">${t}${icon(i)}</div><strong>${n.padStart(2,'0')}</strong><small>${s}</small></div>`).join('')}</div><div class="workspace"><section class="panel"><div class="panel-heading"><h2>Tạo bản dịch mới</h2><span class="step-label">01 / TÀI LIỆU NGUỒN</span></div><div class="tabs"><button class="${state.tab==='file'?'active':''}" data-tab="file">${icon('upload')} &nbsp; Tải tài liệu</button><button class="${state.tab==='text'?'active':''}" data-tab="text">${icon('file')} &nbsp; Nhập văn bản</button></div><div class="upload-area">${state.tab==='file'?`<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Chọn tài liệu để dịch"><div class="upload-symbol">${icon('upload')}</div><strong>Kéo thả tài liệu của bạn vào đây</strong><p>hoặc chọn tệp từ máy tính để bắt đầu</p><button id="pick-file" type="button">Chọn tài liệu ${icon('plus')}</button><div class="formats"><span>PDF</span><span>DOCX</span><span>EPUB</span><span>AZW3</span><span>ẢNH SCAN</span><span>TXT</span><span>TỐI ĐA 25 MB</span></div><p class="upload-limit">PDF có lớp chữ được trích xuất tại trình duyệt; chỉ trang scan mới dùng OCR. TXT / DOCX / EPUB / AZW3 dài được chia theo cấu trúc mục và chương của sách. EPUB / AZW3 khóa DRM không được hỗ trợ.</p></div><input class="hide" type="file" id="file-input" accept=".pdf,.epub,.azw3,.docx,.png,.jpg,.jpeg,.webp,.txt">${state.file?`<div class="selected-file">${icon('file')}<span>${esc(state.file.name)} <small>· ${(state.file.size/1024).toFixed(0)} KB</small></span><button id="remove-file" style="margin-left:auto;padding:4px 8px" aria-label="Bỏ tệp">×</button></div>`:''}`:`<label>Nguyên tác tiếng Trung<textarea id="source-input" rows="9" maxlength="25000000" placeholder="Dán nội dung tiếng Trung vào đây…">${esc(state.draftText||'')}</textarea></label>`}</div><div class="form-grid"><label>Hồ sơ tài liệu<select id="story-select"><option value="">Chọn hồ sơ tài liệu…</option>${storyOptions()}</select></label><label>Lĩnh vực<select id="genre"><option selected>Chuyên khảo · Nghiên cứu</option><option>Toán học · STEM</option><option>Lịch sử Trung Hoa</option><option>Cổ văn · Hán Nôm</option><option>Triết học · Tư tưởng</option><option>Văn hóa · Xã hội</option><option>Địa lý · Khảo cổ</option><option>Giáo dục</option><option>Ngôn ngữ học</option><option>Tài liệu khác</option></select></label><div class="field-wide"><button id="new-story" style="border:0;background:none;color:var(--red);padding:0;font-size:12px">+ Tạo hồ sơ tài liệu mới</button></div><div class="field-wide" id="story-cover-slot">${uploadCoverPanel()}</div></div><div class="upload-footer"><small>${icon('check')} &nbsp; Bản dịch luôn được duyệt trước khi đăng</small><div class="upload-actions"><button id="prepare-pdf" ${!state.file?.name.toLowerCase().endsWith(".pdf")?"disabled":""}>Chia PDF trước</button><button class="primary" id="start-translate">${icon('spark')} &nbsp; Bắt đầu dịch</button></div></div></section><aside class="panel aside-panel"><h3>${icon('settings')} Hỗ trợ bản dịch</h3><div class="language-pair" aria-label="Dịch từ tiếng Trung sang tiếng Việt"><div><small>Nguyên tác</small><strong>中文 · Tiếng Trung</strong></div>${icon('arrow')}<div><small>Bản dịch</small><strong>Tiếng Việt</strong></div></div><div class="toggle-row"><div><strong>Giữ nhất quán thuật ngữ và tên riêng</strong><p>Dùng bảng thuật ngữ xuyên suốt tài liệu.</p></div><span class="feature-status">${icon('check')}<span>Tự động</span></span></div><div class="toggle-row"><div><strong>Phục hồi chữ từ sách cũ</strong><p>Nhận diện chữ phồn thể, cột dọc và đánh dấu chữ mờ.</p></div><span class="feature-status">${icon('check')}<span>Tự động</span></span></div><div class="note">${icon('spark')} &nbsp; AI phân tích chủ đề, văn cảnh và thuật ngữ trước khi dịch. Chữ chưa rõ được giữ để giáo viên hoặc người biên tập đối chiếu.</div><div class="process"><h3 style="font-size:12px;margin:0">QUY TRÌNH DỊCH</h3><p><i>1</i>Chia PDF · 2 trang mỗi phần</p><p><i>2</i>OCR & dịch lần lượt từng phần</p><p><i>3</i>Ghép đủ các phần thành tài liệu</p><p><i>4</i>Đối chiếu học thuật & duyệt</p></div></aside></div><section class="recent"><div class="section-title"><h2>Tài liệu gần đây <span class="muted" style="font-size:12px">&nbsp; ${listCount('jobs')}</span></h2><button data-route="review">Xem tất cả &nbsp; →</button></div>${jobsTable(state.jobs.slice(0,4))}</section>`;}
const statuses={uploaded:'Đã tải lên',splitting:'Đang chia PDF',prepared:'Đã chia · Sẵn sàng dịch',assembling:'Đang ghép thành quyển',ocr:'Đang OCR',translating:'Đang dịch',review:'Chờ đối chiếu',published:'Đã xuất bản',failed:'Cần xử lý'};
function jobAudit(j){const requests=Number(j.ai_requests)||0,total=Number(j.total_tokens)||0,prompt=Number(j.prompt_tokens)||0,output=Number(j.output_tokens)||0;if(!requests&&!total&&!j.model&&!j.prompt_version)return '';return `<div class="job-audit"><strong>Nhật ký AI</strong><span>${esc(j.model||'Chưa ghi model')}</span><span>Prompt ${esc(j.prompt_version||'chưa ghi phiên bản')}</span><span>${total.toLocaleString('vi-VN')} token · ${prompt.toLocaleString('vi-VN')} vào + ${output.toLocaleString('vi-VN')} ra</span><span>${requests} lượt gọi${Number(j.ai_cache_hits)?` · ${Number(j.ai_cache_hits)} cache hit`:''}</span></div>`;}
function jobsTable(jobs){return `<div class="panel table-wrap"><table><thead><tr><th>TÀI LIỆU</th><th>HỒ SƠ TÀI LIỆU</th><th>TRẠNG THÁI</th><th>NGÀY TẢI</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><div class="file-cell"><span class="file-icon">${icon('file')}</span><span><strong>${esc(j.filename)}</strong>${j.progress?`<small class="job-progress">${esc(j.progress)}</small>`:''}</span></div></td><td>${esc(j.story_title)}</td><td><span class="badge ${j.status==='review'?'review':j.status==='failed'?'failed':''}">${statuses[j.status]}</span></td><td class="muted">${esc(j.created_at?.slice(0,10))}</td><td><button data-job="${j.id}" style="padding:6px 10px;border:0" aria-label="Mở ${esc(j.filename)}">→</button><button class="danger" data-delete-job="${j.id}" ${busy?"disabled":""}>Xóa</button></td></tr>`).join('')}</tbody></table>${!jobs.length?`<div class="empty">${icon('file')} &nbsp; Chưa có tài liệu. Tải lên bản nguyên tác đầu tiên để bắt đầu.</div>`:''}</div>`;}
function reviewBooks(){const groups=new Map();for(const job of state.jobs){if(!groups.has(job.story_id))groups.set(job.story_id,[]);groups.get(job.story_id).push(job);}return `<div class="review-books">${[...groups].map(([storyId,jobs])=>{const done=jobs.filter(j=>['review','published'].includes(j.status)).length,waiting=jobs.filter(j=>['uploaded','prepared','splitting','ocr','translating','assembling'].includes(j.status)).length,failed=jobs.filter(j=>j.status==='failed').length,story=adminStory(storyId);return `<article class="panel review-book"><div class="review-book-cover">${story?coverArt(story):icon('book')}</div><div class="review-book-main"><p class="eyebrow">HỒ SƠ TÀI LIỆU</p><h2>${esc(jobs[0]?.story_title||'Chưa đặt tên')}</h2><div class="review-book-counts"><span><strong>${done}</strong> phần đã xong</span><span><strong>${waiting}</strong> đang chờ</span>${failed?`<span class="has-error"><strong>${failed}</strong> cần xử lý</span>`:''}</div></div><button class="review-enter" data-review-story="${storyId}" aria-label="Vào xem các phần của ${esc(jobs[0]?.story_title||'tài liệu')}">${icon('book')}<span>Vào xem</span> →</button></article>`;}).join('')}</div>${!groups.size?'<div class="panel empty">Chưa có hồ sơ tài liệu nào trong khu vực đối chiếu.</div>':''}${moreButton('jobs','Tải thêm bản dịch cũ hơn')}`;}
function reviewView(){const j=state.jobs.find(j=>j.id===state.selected);if(!j&&state.reviewStory){const jobs=state.jobs.filter(job=>job.story_id===state.reviewStory),finished=jobs.filter(job=>['review','published'].includes(job.status)),failed=jobs.filter(job=>job.status==='failed'),queue=jobs.filter(job=>!['review','published','failed'].includes(job.status));return heading('ĐỐI CHIẾU TÀI LIỆU',jobs[0]?.story_title||'Các phần đã dịch','Mỗi phần hoàn tất được giữ ở hàng chờ để giáo viên hoặc người quản trị đối chiếu trước khi công bố.',`<button id="back-review-books">← Danh sách sách</button>`)+`<section class="review-section"><div class="section-title"><h2>Bản dịch chờ duyệt <span class="muted">${finished.length}</span></h2></div>${jobsTable(finished)}</section>${failed.length?`<section class="review-section"><div class="section-title"><h2>Đang dịch dở / cần xử lý <span class="muted">${failed.length}</span></h2></div>${jobsTable(failed)}</section>`:''}<section class="review-section review-queue"><div class="section-title"><h2>Hàng chờ <span class="muted">${queue.length}</span></h2><button id="toggle-review-queue">${state.showReviewQueue?'Thu gọn':'Xem hàng chờ'} ${state.showReviewQueue?'↑':'↓'}</button></div>${state.showReviewQueue?jobsTable(queue):''}</section>`;}if(!j)return heading('ĐỐI CHIẾU','Bản dịch cần có người chịu trách nhiệm.','Các bản dịch được gom theo hồ sơ tài liệu. Chọn một tài liệu để xem phần đã hoàn tất hoặc đang xử lý.')+reviewBooks();const detail=jobDetail(j.id),entry=state.jobDetails[j.id],warnings=warningsOf(detail),locked=Boolean(!detail||j.source_key||j.translation_key||busy||['splitting','prepared','ocr','translating','assembling','published'].includes(j.status)||(j.status==='failed'&&j.progress)),loading=!detail?entry?.error?`<div class="warning" role="alert">Chưa tải được nội dung bản dịch: ${esc(entry.error.message)} <button type="button" id="job-detail-retry">Thử lại</button></div>`:'<p class="note" role="status" style="margin-top:16px">Đang tải nguyên tác và bản dịch…</p>':'';return heading('BẢN ĐỐI CHIẾU',j.story_title,j.filename)+`<div class="button-row"><button id="back-jobs">← Danh sách phần</button>${j.file_key?'<button id="download-original">Tải bản gốc</button>':''}${j.mime==='application/pdf'?'<button id="pdf-parts">Các phần PDF</button>':''}${['review','published'].includes(j.status)?'<button id="download-book">Tải cả quyển (.txt)</button>':''}<span class="badge">${statuses[j.status]}</span><button id="rerun" ${busy||j.status==='published'?'disabled':''}>${icon('spark')} ${['uploaded','prepared'].includes(j.status)?'Bắt đầu dịch':['failed','splitting','ocr','translating','assembling'].includes(j.status)?'Tiếp tục xử lý':'Dịch lại'}</button><button class="danger" data-delete-job="${j.id}" ${busy?"disabled":""}>Xóa tài liệu</button><button id="save-job" ${locked?'disabled':''}>Lưu biên tập</button><button class="primary" id="publish-job" ${j.status!=='review'||!detail?'disabled':''}>Duyệt & công bố</button></div>${loading}${j.source_key||j.translation_key?'<p class="note" style="margin-top:16px">Văn bản dài: ô bên dưới hiển thị 20.000 ký tự đầu. Bản đầy đủ được lưu riêng, không bị cắt. <button id="download-source">Tải nguyên tác đầy đủ</button></p>':''}${j.status==='failed'&&(detail?String(detail.translation||'').trim():Number(j.has_translation))?'<div class="partial-translation-notice"><strong>Đã giữ bản dịch một phần.</strong><span>Phần này chưa đủ nội dung để công bố. Bấm “Tiếp tục xử lý” khi hạn mức Gemini được khôi phục.</span></div>':''}${j.progress?`<p class="note" style="margin-top:16px">${esc(j.progress)}${['review','published'].includes(j.status)?'':' · Giữ trang mở khi xử lý; có thể tiếp tục sau nếu đóng trang.'}</p>`:''}${jobAudit(j)}${j.error?`<div class="warning">${esc(j.error)}</div>`:''}${warnings.length?`<div class="warning">${warnings.map(esc).join('<br>')}</div>`:''}<div class="editor-grid"><section class="panel aside-panel"><h3>中文 &nbsp; Nguyên tác / OCR</h3><textarea id="edit-source" ${locked?'readonly':''}>${esc(detail?.source)}</textarea></section><section class="panel aside-panel"><h3>Tiếng Việt &nbsp; · &nbsp; Bản dịch</h3><textarea id="edit-translation" ${locked?'readonly':''} placeholder="Bản dịch xuất hiện sau khi Gemini xử lý hoàn tất.">${esc(detail?.translation)}</textarea></section></div>`;}
function adminStoryCard(s,owner=''){return `<article class="panel book story-card"><details class="story-actions"><summary aria-label="Mở thao tác cho ${esc(s.title)}" title="Quản lý tài liệu">${icon('settings')}</summary><div class="story-actions-menu"><button data-story="${s.id}">${icon('translate')} Dịch phần mới</button><button data-rename-story="${s.id}">${icon('file')} Đổi tên tài liệu</button><button data-cover="${s.id}">${icon('upload')} ${s.cover_key?'Đổi ảnh bìa':'Tải ảnh bìa'}</button><button data-import="${s.id}">${icon('book')} Tải bản đã dịch lên</button><button data-chapters="${s.id}">${icon('grid')} Các phần đã công bố</button><button class="danger" data-delete-story="${s.id}">${icon('plus')} Xóa tài liệu</button></div></details>${coverArt(s)}${owner?`<span class="owner-chip">${icon('book')} ${esc(owner)}</span>`:''}${isSample(s)||!s.owner_user_id&&s.visibility==='private'?`<div class="story-flags">${isSample(s)?`<span class="sample-flag">${SAMPLE_LABEL}</span>`:''}${!s.owner_user_id&&s.visibility==='private'?'<span class="draft-flag">Nháp · chưa công khai</span>':''}</div>`:''}<h2>${esc(s.title)}</h2><p>${esc(s.author||'Chưa cập nhật')} · ${esc(s.genre)}</p><p><strong>${Number(s.chapters)||0}</strong> phần đã công bố · ${state.jobs.filter(j=>j.story_id===s.id).length} bản dịch nguồn</p></article>`;}
function storiesView(){const webStories=state.stories.filter(s=>!s.owner_user_id);return heading('KHO HỌC LIỆU HOA TRÍ','Sách và tài liệu học thuật','Quản lý chuyên khảo, sử liệu, cổ văn và tài liệu nghiên cứu Trung Hoa đã được đối chiếu.',`<div class="button-row"><button id="import-chapter">Tải bản đã dịch lên</button><button class="primary" id="new-story">+ Tạo hồ sơ tài liệu</button></div>`)+`<div class="collection-summary"><span>${icon('book')} ${listCount('stories',webStories.length)} hồ sơ tài liệu</span><span>${icon('grid')} ${webStories.reduce((sum,s)=>sum+Number(s.chapters||0),0)} phần đã công bố</span></div><div class="library">${webStories.map(s=>adminStoryCard(s)).join('')}</div>${!webStories.length?'<div class="panel empty">Kho Hoa Trí chưa có tài liệu học thuật nào.</div>':''}${moreButton('stories','Tải thêm tài liệu')}`;}
function usersView(){return heading('TÀI KHOẢN NGƯỜI HỌC','Người học & Thư viện riêng','Theo dõi tài khoản, yêu cầu dịch và học liệu thuộc từng người dùng.')+`<div class="user-stats"><div class="panel"><strong>${state.users.length}</strong><span>Tài khoản</span></div><div class="panel"><strong>${state.users.reduce((sum,user)=>sum+(Number(user.books)||0),0)}</strong><span>Tài liệu cá nhân</span></div><div class="panel"><strong>${state.requests.filter(r=>r.status==='pending').length}</strong><span>Yêu cầu đang chờ</span></div></div><div class="user-management">${state.users.map(user=>{const count=Number(user.books)||0,requests=state.requests.filter(r=>r.user_id===user.id);return `<section class="panel user-block"><header><div class="user-identity">${user.picture?`<img src="${esc(user.picture)}" alt="">`:'<span>'+esc((user.name||user.email).slice(0,1).toUpperCase())+'</span>'}<div><h2>${esc(user.name||'Chưa đặt tên')}</h2><p>${esc(user.email)}</p></div></div><div class="user-badges">${user.disabled_at?'<span class="user-locked">Đang khóa</span>':''}<span>${user.provider==='google'?'Google':'Hoa Trí'}</span><span>${count} tài liệu</span><span>${requests.length} yêu cầu</span></div></header><div class="user-admin-row"><small>${user.terms_version?`Đã đồng ý điều khoản ${esc(user.terms_version)}${user.terms_accepted_at?` · ${esc(String(user.terms_accepted_at).slice(0,10))}`:''}`:'Chưa ghi nhận đồng ý điều khoản (tài khoản tạo trước khi có điều khoản)'}</small><div class="user-actions">${user.provider==='google'?'<span class="user-reset-note">Đăng nhập bằng Google nên không có mật khẩu để đặt lại.</span>':`<button type="button" data-user-reset="${esc(user.id)}">Tạo link đặt lại mật khẩu</button>`}<button type="button" data-user-lock="${esc(user.id)}">${user.disabled_at?'Mở khóa':'Khóa tài khoản'}</button><button type="button" class="danger" data-user-delete="${esc(user.id)}">Xóa tài khoản</button></div></div><div class="user-request-line">${requests.length?`Yêu cầu gần nhất: <strong>${esc(requests[0].title)}</strong> · ${({pending:'đang chờ',accepted:'đang dịch',done:'hoàn tất'})[requests[0].status]}`:'Chưa gửi yêu cầu dịch.'}</div><div class="user-books">${userShelf(user,count)}</div></section>`;}).join('')}</div>${!state.users.length?'<div class="panel empty">Chưa có tài khoản người học.</div>':''}`;}
function requestsView(){return heading('YÊU CẦU DỊCH','Tài liệu học tập đang được chờ xử lý.','Tiếp nhận sách, sử liệu và chuyên khảo tiếng Trung do người học gửi lên.')+`<div class="library">${state.requests.map(r=>`<article class="panel book"><div class="request-meta"><span class="badge">${({pending:'Mới',accepted:'Đang xử lý',done:'Đã hoàn tất'})[r.status]}</span><span class="privacy-badge">${r.visibility==='public'?'Thư viện chung':'Riêng tư'}</span></div><h2 style="margin-top:16px">${esc(r.title)}</h2><p class="subtitle">${esc(r.reader_name||r.reader_email||'Người dùng cũ')}</p><p>${esc(r.notes)}</p><div class="request-links">${r.source_url?sourceLink(r.source_url,'Xem nguồn ↗','Nguồn (không phải địa chỉ web): '):''}${r.filename?`<button type="button" class="link-button" data-request-file="${r.id}">Tải tệp · ${esc(r.filename)}</button>`:''}</div><div class="button-row" style="margin-top:20px"><button data-accept="${r.id}" ${r.story_id?'disabled':''}>${r.story_id?'Đã tạo hồ sơ':'Tiếp nhận & tạo hồ sơ'}</button><button data-done="${r.id}">Hoàn tất</button><button class="danger" data-delete-request="${r.id}">Xóa</button></div></article>`).join('')}</div>${!state.requests.length?'<div class="panel empty">Chưa có yêu cầu dịch tài liệu mới.</div>':''}`;}
function settingsView(){const fromDashboard=state.status.apiKeySource==='dashboard',updated=state.status.apiKeyUpdatedAt?new Date(state.status.apiKeyUpdatedAt).toLocaleString('vi-VN'):'';return heading('KẾT NỐI AI','Cấu hình Gemini','Thay đổi khóa API an toàn ngay trong trang quản trị.')+`<div class="settings-grid"><section class="panel settings-card"><div class="settings-card-icon">${icon('spark')}</div><div><p class="eyebrow">GEMINI API</p><h2>Khóa dịch thuật</h2><p class="subtitle">Khóa hiện tại không bao giờ được gửi lại xuống trình duyệt. Khóa mới có hiệu lực từ lần dịch tiếp theo.</p></div><div class="key-status ${state.status.aiConfigured?'ready':'missing'}"><span class="dot"></span><strong>${state.status.aiConfigured?'Đã sẵn sàng':'Chưa có khóa API'}</strong><small>${fromDashboard?'Đang dùng khóa cập nhật từ giao diện':'Đang dùng khóa cấu hình trên máy chủ'}${updated?` · cập nhật ${esc(updated)}`:''}</small></div><form id="gemini-key-form"><label for="gemini-api-key">Khóa API mới<div class="secret-field"><input type="password" id="gemini-api-key" name="apiKey" autocomplete="new-password" minlength="20" maxlength="500" required placeholder="Dán khóa Gemini API mới"><button type="button" id="toggle-api-key" aria-label="Hiện khóa API">Hiện</button></div></label><div class="button-row"><button class="primary" type="submit">Lưu và sử dụng</button>${fromDashboard?'<button type="button" id="reset-api-key">Dùng lại khóa máy chủ</button>':''}</div></form><p class="settings-security">${icon('check')} Khóa được mã hóa trước khi lưu và không xuất hiện trong mã nguồn hoặc phản hồi API.</p></section><section class="panel settings-card settings-session"><div class="settings-card-icon">${icon('settings')}</div><div><p class="eyebrow">PHIÊN QUẢN TRỊ</p><h2>Kết nối hiện tại</h2><p class="subtitle">Model: <strong>${esc(state.status.model||'gemini-2.5-flash')}</strong><br>Mã quản trị chỉ được giữ trong bộ nhớ của tab này.</p></div><button id="logout">Đăng xuất quản trị</button></section></div>`;}
function glossaryView(){const id=state.glossaryId||'',terms=id?glossaryOf(id):'{}',entry=id?state.storyDetails[id]:null,waiting=terms!==null?'':entry?.error?`<div class="warning" role="alert">Chưa tải được bảng thuật ngữ của tài liệu này: ${esc(entry.error.message)} <button type="button" id="story-detail-retry">Thử lại</button></div>`:'<p class="note" role="status" style="margin-top:12px">Đang tải bảng thuật ngữ của tài liệu này…</p>';return heading('NHẤT QUÁN HỌC THUẬT','Thuật ngữ & tên riêng','Quy định cách dịch nhân danh, địa danh, niên hiệu, chức quan và thuật ngữ chuyên ngành xuyên suốt tài liệu.')+`<div class="panel aside-panel"><label>Hồ sơ tài liệu<select id="glossary-story"><option value="">Chọn tài liệu</option>${state.stories.map(s=>`<option value="${s.id}" ${state.glossaryId===s.id?'selected':''}>${esc(s.title)}</option>`).join('')}</select></label><label style="margin-top:20px">Mỗi dòng: thuật ngữ tiếng Trung = cách dùng tiếng Việt<textarea id="glossary-text" rows="12" ${terms===null?'readonly':''} placeholder="清朝 = triều Thanh\n翰林院 = Hàn Lâm viện">${esc(terms===null?'':Object.entries(glossaryTerms(terms)).map(([k,v])=>`${k} = ${v}`).join('\n'))}</textarea></label>${waiting}<button id="save-glossary" class="primary" style="margin-top:18px" ${terms===null?'disabled':''}>Lưu bảng thuật ngữ</button></div>`;}
// Home: what Hoa Trí does and for whom, then the shared library. Nothing here says a book was reviewed by a teacher.
function libraryView(){
 const hero=`<section class="library-intro" aria-labelledby="home-title"><div class="library-ornament" aria-hidden="true"><span></span><i>學</i><span></span></div><p class="eyebrow">DÀNH CHO HỌC SINH VÀ GIÁO VIÊN</p><p class="library-chinese" lang="zh-Hant">學而時習之</p><h1 id="home-title">Dịch tài liệu tiếng Trung sang tiếng Việt, giữ nguyên bố cục trang</h1><div class="hero-actions"><a class="hero-cta hero-cta-primary" href="/study">Dịch tài liệu của tôi <span aria-hidden="true">→</span></a><a class="hero-cta" href="#thu-vien" id="show-library">Xem thư viện</a></div><div class="library-seal" aria-hidden="true">華<br>智</div></section>`;
 const books=state.library.length>0,filters=books?`<div class="library-filters"><label class="library-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="library-search" type="search" aria-label="Tìm tên tài liệu hoặc tác giả" placeholder="Tìm tài liệu, tác giả, chủ đề…" value="${esc(state.libraryQuery||'')}"></label><div class="genre-filter" role="group" aria-label="Lọc lĩnh vực">${['',...new Set(state.library.map(s=>s.genre).filter(Boolean))].map(g=>`<button type="button" data-library-genre="${esc(g)}" aria-pressed="${(state.libraryGenre||'')===g}">${esc(g||'Tất cả')}</button>`).join('')}</div></div><p class="library-result-count" id="library-result-count" role="status"></p>`:'';
 const empty='<div class="panel empty library-empty"><p>Thư viện chung đang được bổ sung. Trong lúc chờ, hãy tự dịch tài liệu của bạn ở Xưởng dịch.</p><a class="hero-cta hero-cta-primary" href="/study">Mở Xưởng dịch <span aria-hidden="true">→</span></a></div>';
 const content=state.errors?.library?errorCard('Chưa tải được thư viện',state.errors.library,'library'):!state.loaded?skeletonCards(6):!books?empty:`${filters}<div class="cover-library">${state.library.map(libraryCard).join('')}</div><div id="library-no-results" class="empty" hidden>Không tìm thấy tài liệu phù hợp. Hãy thử từ khóa hoặc lĩnh vực khác.</div>`;
 return `${hero}<section class="library-section" id="thu-vien" aria-labelledby="library-title"><div class="library-heading"><h2 id="library-title" tabindex="-1">Thư viện chung</h2><p class="subtitle">Tài liệu đã dịch sang tiếng Việt, đọc ngay trên trình duyệt cùng công cụ tra chữ Hán.</p></div>${content}</section>`;
}
// A book card: the cover opens the book (the part picker, or the reader for a one-part book); title and action stay
// visible under the cover. With a mouse the author and notes slide over the cover; on touch screens they sit below.
function libraryCard(s,i){
 const ready=Number(s.chapters)>0,id=esc(s.id),title=esc(s.title);
 const cover=ready?`<button type="button" class="cover-trigger" data-read="${id}" data-read-cover="${id}" aria-label="Mở tài liệu ${title}${isSample(s)?` · ${SAMPLE_LABEL}`:''}">${coverArt(s)}</button>`:`<div class="cover-trigger">${coverArt(s)}</div>`;
 return `<article class="cover-book ${ready?'':'book-pending'}" data-library-index="${i}" aria-labelledby="book-title-${i}"><div class="cover-frame">${sampleBadge(s)}${cover}</div><div class="book-caption"><small class="book-genre">${esc(s.genre||'Tài liệu học thuật')}</small><h3 class="book-title" id="book-title-${i}">${title}</h3><p class="book-chapters">${icon('book')} ${ready?`${Number(s.chapters)} phần`:'Đang dịch phần đầu tiên'}</p></div><div class="book-reveal" id="book-info-${i}"><p class="book-author">Tác giả / chủ biên: ${esc(s.author||'Chưa cập nhật')}</p>${sampleCardNote(s)}</div><div class="book-actions">${ready?`<button type="button" class="primary" data-read="${id}" aria-describedby="book-title-${i}"><span data-read-label="Mở tài liệu">Mở tài liệu</span> ${icon('arrow')}</button>`:'<span class="pending-reader-badge">Đang biên tập</span>'}</div></article>`;
}
function personalBookCards(){const progress={uploaded:'Đã tiếp nhận · chờ dịch',prepared:'Đã chuẩn bị · chờ dịch',splitting:'Đang chuẩn bị tài liệu',ocr:'Đang nhận diện nội dung',translating:'Đang dịch',assembling:'Đang ghép bản dịch',review:'Chờ đối chiếu',failed:'Bản dịch cần quản trị viên xử lý',published:'Đã công bố'};return state.myLibrary.map(s=>`<article class="personal-book">${coverArt(s)}<div><span class="privacy-badge">${s.visibility==='public'?'Đã chia sẻ thư viện chung':'Riêng tư'}</span><h3>${esc(s.title)}</h3><p>${esc(s.genre)} · ${Number(s.chapters)||0} phần</p>${Number(s.chapters)?`<button class="primary" data-read="${esc(s.id)}"><span data-read-label="Đọc tài liệu">Đọc tài liệu</span> ${icon('arrow')}</button>`:`<small>${esc(progress[s.translation_status]||'Ban biên tập đang chuẩn bị phần đầu tiên.')}</small>`}</div></article>`).join('');}
// Sign-in and registration. The server decides who may register (/api/me registration.mode: open, closed or domain);
// the Google button works only once a terms box is ticked, since Google sign-in can create an account. In domain mode
// only Google creates accounts (it proves the address belongs to the school), so there is no registration form.
// Each form says what went wrong inside itself (.form-error, see sendForm); a server without Google sign-in shows no
// Google part at all.
const formError=id=>`<p class="form-error" id="${id}" role="alert" tabindex="-1" hidden></p>`;
// Where a student asks the administrator for a password reset link: the contact section of the Terms (dieu-khoan.html
// #lien-he), whose address the operator fills in before launch.
const CONTACT_LINK='<a href="/dieu-khoan#lien-he" target="_blank" rel="noopener">mục Liên hệ của Điều khoản sử dụng</a>';
// Under every new-password field: the length the server takes and what it refuses (backend/reader-auth.js passwordProblem).
const PASSWORD_RULE='Từ 8 đến 128 ký tự; tránh mật khẩu phổ biến như 12345678 hay matkhau123, ngày sinh, hàng phím, tên hay email của bạn.';
// The Google button carries accept_terms=1 only while a terms box is ticked (bindAuth keeps it in step): a link opened
// in a new tab, which no click handler sees, then comes back with loi=terms_required instead of recording consent.
const googleReturn=()=>state.pendingRequest?'/#yeu-cau':state.afterSignIn||'/#account';
const googleHref=agreed=>`/api/auth/google/start?${agreed?'accept_terms=1&':''}return_to=${encodeURIComponent(googleReturn())}`;
function authView(){
 const registration=state.reader.registration||{},closed=registration.mode==='closed',googleOnly=registration.mode==='domain',single=closed||googleOnly,domains=googleOnly&&Array.isArray(registration.domains)?registration.domains.map(esc).join(' hoặc '):'';
 const terms='<a href="/dieu-khoan" target="_blank" rel="noopener">Điều khoản sử dụng</a> và <a href="/quyen-rieng-tu" target="_blank" rel="noopener">Chính sách quyền riêng tư</a>';
 const tabs=single?'':'<div class="auth-tabs" role="tablist" aria-label="Đăng nhập hoặc tạo tài khoản"><button type="button" class="active" role="tab" id="auth-tab-login" aria-selected="true" aria-controls="auth-panel-login" data-auth-tab="login">Đăng nhập</button><button type="button" role="tab" id="auth-tab-register" aria-selected="false" aria-controls="auth-panel-register" tabindex="-1" data-auth-tab="register">Tạo tài khoản</button></div>';
 const policy=closed?'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.':!googleOnly?'':state.reader.googleConfigured?`Tài khoản mới chỉ tạo được bằng nút Tiếp tục bằng Google, với email thuộc ${domains}.`:`Tài khoản mới chỉ tạo được bằng đăng nhập Google với email thuộc ${domains}, nhưng máy chủ chưa cấu hình đăng nhập Google. Hãy liên hệ quản trị viên.`;
 // No e-mail is sent: the administrator creates a one-time link (contract 7), asked for at the address in the Terms'
 // contact section (CONTACT_LINK).
 const forgot=`<details class="auth-forgot"><summary>Quên mật khẩu?</summary><p>Hoa Trí không gửi email đặt lại mật khẩu. Hãy viết cho quản trị viên Hoa Trí theo địa chỉ ở ${CONTACT_LINK}, ghi rõ email bạn dùng để đăng nhập, để xin một liên kết đặt lại mật khẩu; rồi mở liên kết đó để chọn mật khẩu mới. Liên kết chỉ mở được một lần, trong vòng 24 giờ: mở ra là đặt mật khẩu mới ngay.</p>${state.reader.googleConfigured?'<p>Nếu bạn đăng nhập bằng Google thì tài khoản không có mật khẩu riêng: hãy bấm “Tiếp tục bằng Google”.</p>':''}</details>`;
 const login=`<form id="reader-login-form" class="auth-form"${single?' aria-labelledby="auth-login-title"':''}>${single?'<h2 class="auth-form-title" id="auth-login-title">Đăng nhập</h2>':''}${formError('reader-login-error')}<label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128"></label><button class="primary" type="submit">Đăng nhập</button>${forgot}${policy?`<p class="auth-note" role="note">${policy}</p>`:''}</form>`;
 const register=single?'':`<form id="reader-register-form" class="auth-form">${formError('reader-register-error')}<label>Tên hiển thị<input name="name" autocomplete="name" required maxlength="100"></label><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><label>Mật khẩu<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="register-password-rule"><small id="register-password-rule">${PASSWORD_RULE}</small></label><label class="terms-check"><input name="acceptTerms" type="checkbox" required data-terms-check> <span>Tôi đồng ý với ${terms}.</span></label><button class="primary" type="submit">Tạo tài khoản</button></form>`;
 // The tab panels wrap the forms: a form keeps its own role.
 const panels=single?login:`<div class="auth-panel" role="tabpanel" id="auth-panel-login" aria-labelledby="auth-tab-login">${login}</div><div class="auth-panel" role="tabpanel" id="auth-panel-register" aria-labelledby="auth-tab-register" hidden>${register}</div>`;
 // A request started while signed out comes back after sign-in, also from Google (return_to=/#yeu-cau).
 const pending=state.pendingRequest?`<p class="auth-note auth-pending" role="note">Đăng nhập hoặc tạo tài khoản xong, hộp “Yêu cầu dịch” sẽ tự mở${requestDraftHasText()?' lại với nội dung bạn đã nhập':''}.</p>`:state.afterSignIn?`<p class="auth-note auth-pending" role="note">Đăng nhập hoặc tạo tài khoản xong, bạn sẽ quay lại ${state.afterSignIn==='/study'?'Xưởng dịch':'tài liệu đang mở'}.</p>`:'';
 const google=state.reader.googleConfigured?`<div class="auth-divider"><span>hoặc</span></div><label class="terms-check google-terms-check" id="google-terms-row"><input type="checkbox" data-terms-check> <span>Tôi đồng ý với ${terms}.</span></label><a class="google-login" id="google-login" href="${esc(googleHref(Boolean(state.termsAccepted)))}" aria-disabled="${!state.termsAccepted}" aria-describedby="google-terms-hint${domains?' google-domain-hint':''}"><span aria-hidden="true">G</span> Tiếp tục bằng Google</a><small class="google-terms" id="google-terms-hint">Đánh dấu ô đồng ý để tiếp tục bằng Google.</small>${closed?'<small class="google-terms">Chỉ tài khoản Google đã đăng ký mới đăng nhập được.</small>':domains?`<small class="google-terms" id="google-domain-hint">Tài khoản Google mới cần email thuộc ${domains}.</small>`:''}`:'';
 // A Google sign-in that came back with ?loi= (takeAfterSignIn) says why, first.
 const failure=state.googleFailure?`<p class="form-error auth-failure" role="alert" tabindex="-1" data-focus-first>${esc(googleFailureText(state.googleFailure))}</p>`:'';
 return `<section class="account-auth"><div class="auth-intro"><p class="eyebrow">GÓC NGƯỜI HỌC</p><h1>Thư viện nghiên cứu của bạn</h1><p>Xưởng dịch cần tài khoản Hoa Trí: nguyên tác, bản dịch và tiến độ dịch được lưu vào tài khoản của bạn. Với tài khoản, bạn còn gửi được yêu cầu dịch, theo dõi tiến độ và đọc học liệu riêng tư. Thư viện chung đọc được mà không cần đăng nhập.</p><div class="auth-benefits"><span>${icon('translate')} Xưởng dịch</span><span>${icon('book')} Thư viện riêng</span><span>${icon('chat')} Theo dõi yêu cầu</span></div></div><div class="auth-forms panel">${failure}${pending}${tabs}${panels}${google}</div></section>`;
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
// Why the server flagged a password that still signs in (POST /api/auth/login weakPassword).
const WEAK_REASONS={password_common:'là một mật khẩu phổ biến',password_pattern:'theo một quy luật dễ đoán (dãy số, hàng phím hay ngày tháng)',password_like_email:'giống email hoặc tên của bạn'};
// Contract 8 on the account page: a list that did not load is an error card with "Thử lại", never an empty state.
function accountView(){
 if(!state.loaded)return `<section class="account-loading"><span class="skeleton skeleton-title"></span>${skeletonCards(3)}</section>`;
 const notice=state.accountNotice?`<p class="account-notice" role="status" tabindex="-1" data-focus-first>${icon('check')}<span>${esc(state.accountNotice)}</span></p>`:'';
 if(!state.reader.authenticated)return state.errors?.me?`<section class="account-error"><p class="eyebrow">GÓC NGƯỜI HỌC</p><h1>Tài khoản</h1>${errorCard('Chưa tải được tài khoản',state.errors.me,'account')}</section>`:notice+authView();
 const u=state.reader.user||{},avatar=avatarOf(u),errors=state.errors||{},ask='<button type="button" class="hero-cta" data-request-open>Gửi yêu cầu dịch</button>';
 const books=errors.myLibrary?errorCard('Chưa tải được Thư viện riêng',errors.myLibrary,'account'):`<div class="personal-library">${personalBookCards()||`<div class="panel empty account-empty"><p>Thư viện riêng chưa có tài liệu. Bản dịch hoàn tất ở Xưởng dịch và các yêu cầu dịch đã xử lý xong sẽ hiện ở đây.</p><div class="account-empty-actions"><a class="hero-cta hero-cta-primary" href="/study">Dịch tài liệu đầu tiên <span aria-hidden="true">→</span></a>${ask}</div></div>`}</div>`;
 const requests=errors.myRequests?errorCard('Chưa tải được yêu cầu dịch của bạn',errors.myRequests,'account'):`<div class="my-requests">${state.myRequests.map(r=>`<article class="panel request-row"><div><span class="badge">${({pending:'Đang chờ',accepted:'Đang dịch',done:'Hoàn tất'})[r.status]}</span><span class="privacy-badge">${r.visibility==='public'?'Chia sẻ chung':'Riêng tư'}</span></div><h3>${esc(r.title)}</h3><p>${r.filename?`Tệp: ${esc(r.filename)}`:r.source_url?'Đã gửi liên kết nguyên tác':'Nguồn chưa cập nhật'}${dayText(r.created_at)?` · gửi ngày ${dayText(r.created_at)}`:''}</p>${r.story_id?'<small>Tài liệu đã được đưa vào Thư viện riêng của bạn.</small>':''}</article>`).join('')||`<div class="panel empty account-empty"><p>Bạn chưa gửi yêu cầu dịch nào. Gửi tệp hoặc liên kết tài liệu tiếng Trung, rồi theo dõi tiến độ tại đây.</p><div class="account-empty-actions">${ask}</div></div>`}</div>`;
 // An account with a password changes it here (the current one confirms it); any account can end its other sessions,
 // e.g. one left open on a school computer.
 const local=u.provider!=='google';
 const weak=state.weakPassword&&local?`<p class="account-warning" role="note"><span>Mật khẩu bạn vừa dùng ${esc(WEAK_REASONS[state.weakPassword]||'dễ bị đoán')}, nên người khác có thể đoán ra. Hãy đổi sang mật khẩu mới ở mục “Bảo mật tài khoản” bên dưới.</span><button type="button" id="weak-password-change">Đổi mật khẩu ngay</button></p>`:'';
 const security=`<section class="personal-section account-security" aria-labelledby="account-security-title"><h2 id="account-security-title">Bảo mật tài khoản</h2>${local?`<form id="password-change-form" class="auth-form account-password" aria-labelledby="password-change-title"><h3 id="password-change-title">Đổi mật khẩu</h3>${formError('password-change-error')}<label>Mật khẩu hiện tại<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-change-rule"><small id="password-change-rule">${PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu mới<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><p class="account-security-note">Đổi xong, các thiết bị khác đang đăng nhập tài khoản này bị đăng xuất; thiết bị này vẫn giữ đăng nhập.</p><button class="primary" type="submit">Đổi mật khẩu</button></form>`:'<p class="account-security-note">Tài khoản này đăng nhập bằng Google nên không có mật khẩu riêng ở Hoa Trí.</p>'}<div class="account-sessions"><h3>Nơi đang đăng nhập</h3><p>Lỡ để tài khoản đăng nhập trên máy tính dùng chung ở trường hay ở quán? Đăng xuất mọi nơi từ đây.</p><button type="button" id="logout-all">Đăng xuất khỏi mọi thiết bị…</button></div></section>`;
 return `<section class="account-heading"><div class="account-profile">${avatar.picture?`<img src="${esc(avatar.picture)}" alt="" width="62" height="62" referrerpolicy="no-referrer">`:`<span aria-hidden="true">${esc(avatar.initials)}</span>`}<div><p class="eyebrow">GÓC NGƯỜI HỌC</p><h1>${esc(u.name||'Thư viện của tôi')}</h1><p class="account-email">${esc(u.email)}</p></div></div><button type="button" id="reader-logout">Đăng xuất</button></section>${notice}${weak}<section class="personal-section"><div class="section-title"><h2>Thư viện riêng</h2><button type="button" id="account-request">+ Yêu cầu dịch</button></div>${books}</section><section class="personal-section"><h2>Yêu cầu của tôi</h2>${requests}</section>${security}<section class="personal-section account-delete" aria-labelledby="account-delete-title"><h2 id="account-delete-title">Xóa tài khoản</h2><p>Xóa vĩnh viễn tài khoản, lịch sử dịch, sách trong Thư viện riêng, PDF gốc và bản dịch đã lưu, cùng các yêu cầu dịch bạn đã gửi. Tài liệu đã công bố trong Thư viện chung vẫn được giữ nhưng không còn gắn với tên bạn. Không thể hoàn tác.</p><p class="account-delete-links"><a href="/quyen-rieng-tu#thoi-gian">Dữ liệu nào bị xóa</a></p><button type="button" class="danger" id="delete-account">Xóa tài khoản…</button></section>`;
}
// #dat-lai-mat-khau: a checked link waits for "Tiếp tục" (checkResetLink), then a new password with the token it was
// traded for (in memory only, see takeResetToken). Without a token (the page was reloaded, or the link was refused) the
// page explains how to get a working link instead of showing a form.
const resetExpiry=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('vi-VN',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'});};
function resetView(){
 const ready=state.loaded&&!state.resetOpening,intro='<div class="auth-intro"><p class="eyebrow">GÓC NGƯỜI HỌC</p><h1>Đặt lại mật khẩu</h1><p>Liên kết đặt lại mật khẩu do quản trị viên Hoa Trí tạo cho riêng bạn và chỉ dùng được một lần: bấm “Tiếp tục” rồi chọn mật khẩu mới ngay, trong vòng 30 phút. Đặt mật khẩu mới xong, bạn được đăng nhập ngay; các thiết bị khác đang đăng nhập tài khoản này sẽ bị đăng xuất.</p></div>';
 const until=state.resetLink?resetExpiry(state.resetLink.expiresAt):'';
 const body=state.resetToken?`<form id="password-reset-form" class="auth-form" aria-labelledby="reset-form-title"><h2 class="auth-form-title" id="reset-form-title">Chọn mật khẩu mới</h2>${formError('password-reset-error')}<label>Mật khẩu mới<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="password-reset-rule"><small id="password-reset-rule">${PASSWORD_RULE}</small></label><label>Nhập lại mật khẩu<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button class="primary" type="submit">Lưu mật khẩu mới</button></form>`
  :state.resetLink?`<div class="reset-ready"><h2 class="auth-form-title">Liên kết dùng được</h2><p>${until?`Liên kết còn hiệu lực tới ${esc(until)}. `:''}Bấm “Tiếp tục” khi bạn sẵn sàng chọn mật khẩu mới: từ lúc đó, liên kết không mở lại được nữa.</p><button type="button" class="primary" id="reset-continue">Tiếp tục</button></div>`
  :`<div class="reset-unavailable"${state.resetFailed?' role="alert"':''}><h2 class="auth-form-title"${state.resetFailed?' tabindex="-1" data-focus-first':''}>${state.resetFailed?'Không dùng được liên kết này':'Chưa có liên kết đặt lại mật khẩu'}</h2><p>${esc(state.resetFailed||'Vì an toàn, liên kết chỉ mở được một lần và mã của nó không được giữ lại, nên tải lại hoặc đóng trang trước khi lưu mật khẩu sẽ làm mất mã. Hãy xin quản trị viên Hoa Trí một liên kết mới.')}</p><p class="reset-contact">Địa chỉ của quản trị viên ở ${CONTACT_LINK}.</p><a class="hero-cta" href="/#account">Đến trang đăng nhập</a></div>`;
 if(!ready)return `<section class="account-auth reset-auth">${intro}<div class="auth-forms panel" role="status" aria-label="Đang chuẩn bị biểu mẫu"><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span></div></section>`;
 return `<section class="account-auth reset-auth">${intro}<div class="auth-forms panel">${body}</div></section>`;
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
function errorCard(title,error,retry,{heading='h2',back=''}={}){return `<div class="panel load-error" role="alert"><${heading}>${esc(title)}</${heading}><p>${esc(error?.message||'Đã có lỗi khi tải dữ liệu.')}</p>${back?'<p>Nếu đây là tài liệu trong Thư viện riêng của bạn, hãy đăng nhập để mở.</p>':''}<div class="button-row">${(error?.status===401||back)&&state.route!=='account'?`<a class="load-error-link" href="/#account${back?`?sau=${esc(back)}`:''}">Đăng nhập</a>`:''}<button type="button" class="primary" data-retry="${retry}">Thử lại</button></div></div>`;}
// Only a book in the public library has a link others can open.
const shareable=()=>Boolean(state.readerStory?.id&&state.library.some(item=>item.id===state.readerStory.id));
function readerView(){
 const c=state.chapters[state.chapter];
 if(!c){
  if(state.readerError){const {storyId,part}=state.readerError,back=!state.reader.authenticated&&storyId?`reader/${encodeURIComponent(storyId)}/${part||1}`:'';return `<div class="reader-layout">${errorCard('Chưa mở được tài liệu này',state.readerError,'reader',{heading:'h1',back})}<p class="reader-error-back"><button type="button" data-route="library">${icon('book')} Về thư viện</button></p></div>`;}
  return state.readerPending||!state.loaded?'<div class="reader-layout" role="status" aria-label="Đang mở tài liệu"><span class="skeleton skeleton-title"></span><span class="skeleton reader-skeleton"></span></div>':'<div class="empty">Chọn một tài liệu trong thư viện để đọc.</div>';
 }
 const pdf=c.mime==='application/pdf',reading=pdf?null:readerProse(c.content);
 // On a phone the toolbar is one row (library, part, "Tùy chọn"): page colour, Chinese lookup, font size and listening
 // open under it on demand (style.css), so the first screen shows reading text. Wider screens show them all.
 return `<div class="reader-layout"><div class="reader-toolbar${state.readerMore?' is-more-open':''}" role="toolbar" aria-label="Công cụ đọc tài liệu">
 <div class="reader-start"><button class="reader-back" data-route="library" title="Về thư viện">${icon('book')}<span>Thư viện</span></button>${shareable()?`<button type="button" class="reader-share" id="reader-share" title="Chia sẻ liên kết đến phần này">${icon('share')}<span>Chia sẻ</span></button>`:''}</div>
 <label class="reader-chapter-picker"><span>Phần</span><select id="reader-chapter-select" aria-label="Chọn phần đang đọc">${state.chapters.map((chapter,index)=>`<option value="${index}" ${index===state.chapter?'selected':''}>${index+1}. ${esc(chapter.title)}</option>`).join('')}</select></label>
 <button type="button" class="reader-more-toggle" id="reader-more-toggle" aria-expanded="${Boolean(state.readerMore)}" aria-controls="reader-more" title="Màu trang, cỡ chữ, nghe đọc và tra chữ Hán">${icon('settings')}<span>Tùy chọn</span></button>
 <div class="reader-more" id="reader-more"><div class="reader-options"><div class="reader-control-group theme-options" role="group" aria-label="Màu trang sách">${[['paper','paper','Màu giấy'],['light','sun','Nền sáng'],['night','moon','Ban đêm']].map(([theme,glyph,label])=>`<button class="reader-icon theme-${theme}" data-reader-theme="${theme}" aria-label="${label}" title="${label}" aria-pressed="${state.theme===theme}">${icon(glyph)}</button>`).join('')}</div><div class="reader-control-group" role="group" aria-label="Tra cứu chữ Hán"><button class="reader-icon" id="hanzi-open" aria-label="Tra chữ Hán: pinyin, âm Hán Việt và nghĩa" title="Tra chữ Hán"><span class="font-symbol" lang="zh-Hans" aria-hidden="true">字</span></button></div>
 ${!pdf?`<div class="reader-control-group font-options" role="group" aria-label="Cỡ chữ"><button class="reader-icon" id="font-smaller" title="Giảm cỡ chữ" aria-label="Giảm cỡ chữ" ${state.fontSize<=16?'disabled':''}><span class="font-symbol">A−</span></button><output class="font-value" aria-live="polite" aria-label="Cỡ chữ hiện tại">${state.fontSize}</output><button class="reader-icon" id="font-larger" title="Tăng cỡ chữ" aria-label="Tăng cỡ chữ" ${state.fontSize>=30?'disabled':''}><span class="font-symbol">A+</span></button></div>`:''}</div>
 ${!pdf?`<div class="reader-audio" role="group" aria-label="Đọc thành tiếng"><button class="reader-icon listen-icon" id="speak" aria-label="Nghe đọc tiếng Việt" title="Nghe đọc tiếng Việt">${icon('headphones')}</button><button class="reader-icon stop-icon" id="stop-speak" aria-label="Dừng nghe" title="Dừng nghe">${icon('stop')}</button></div>`:''}</div>
 </div><article class="reader ${state.theme}">${state.readerStory?.title?`<p class="reader-book-title">${esc(state.readerStory.title)}</p>`:''}<p class="eyebrow">PHẦN ${state.chapter+1} / ${state.chapters.length}</p><h1 tabindex="-1">${esc(c.title)}</h1>${c.source_url?`<p class="chapter-source">Nguồn: ${sourceLink(c.source_url,'Mở nguyên tác ↗')}</p>`:''}${sampleReaderNotice(state.readerStory,c)}${pdf?`<p class="subtitle">Tài liệu PDF · <a href="/api/chapter-file/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">Mở PDF trong tab mới ↗</a></p><div id="book-download-slot">${wholeBookPdf()?bookDownloadPanel():''}</div><div class="reader-pdf-tools" id="reader-pdf-tools">${pdfTools(c)}</div><div class="reader-pdf-area" id="reader-pdf-area">${pdfFrame(c)}</div>`:`<div class="prose" style="font-size:${state.fontSize}px">${reading.html}</div>${reading.notes.length?`<details class="footnotes-panel"><summary>Chú thích <span>${reading.notes.length}</span></summary><ol>${reading.notes.map(note=>`<li id="note-${note.number}"><b>[${note.number}]</b> ${renderMathText(note.content,{bare:false})}</li>`).join('')}</ol></details>`:''}`}</article>
 <nav class="reader-pagination" aria-label="Chuyển phần"><button id="prev-chapter" ${state.chapter===0?'disabled':''}>← <span>Phần trước</span></button><span class="chapter-position">${state.chapter+1}<small> / ${state.chapters.length}</small></span><button id="next-chapter" ${state.chapter===state.chapters.length-1?'disabled':''}><span>Phần tiếp</span> →</button></nav></div>`;
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
function bookDownloadPanel(){
 const d=state.bookDownload||{},hint=state.readerStory?.study||state.readerStory?.assembly?'Ghép như bản gốc trên thiết bị này: bìa và các trang chưa dịch giữ nguyên':`${state.chapters.length} phần ghép thành một tệp trên thiết bị này`;
 const pick=d.pick?`<div class="book-pick" role="group" aria-labelledby="book-pick-title"><strong id="book-pick-title">Chọn PDF gốc để ghép đủ bìa và các trang chưa dịch</strong><p>Tài khoản chưa lưu bản gốc của ${d.pick.sources.length>1?'các tệp':'tệp'} dưới đây (phần dịch từ trước khi Hoa Trí lưu bản gốc). Tệp bạn chọn chỉ dùng trên thiết bị này, không tải lên.</p><ul>${d.pick.sources.map(source=>`<li>${esc(source.filename||'Tệp gốc')} · ${source.totalPages?`${source.totalPages} trang`:'chưa rõ số trang'}${localSources.has(source.key)?' · đã chọn':''}</li>`).join('')}</ul>${d.pick.errors?.length?`<ul class="book-pick-errors" role="alert">${d.pick.errors.map(error=>`<li>${esc(error)}</li>`).join('')}</ul>`:''}<div class="book-pick-actions"><label class="book-pick-file">${icon('upload')}<span>Chọn PDF gốc…</span><input type="file" id="book-pick-input" accept="application/pdf,.pdf" multiple ${d.busy?'disabled':''}></label><button type="button" id="book-join-only" ${d.busy?'disabled':''}>Chỉ ghép các phần đã dịch</button></div></div>`:'';
 const join=!d.pick&&d.offerJoin?`<button type="button" class="book-join-secondary" id="book-join-only">Chỉ ghép các phần đã dịch</button>`:'';
 const offer=d.coverOffer?`<div class="book-cover-offer"><img src="${d.coverOffer.url}" alt="Trang ${d.coverOffer.page} của bản gốc" width="48" height="68"><p>Bản gốc có trang bìa (trang ${d.coverOffer.page}). Dùng làm ảnh bìa sách trong Thư viện riêng?</p><button type="button" id="book-cover-offer">Đặt làm ảnh bìa</button></div>`:'';
 return `<div class="book-download"><button type="button" id="download-whole-book" ${d.busy?'disabled':''}>${icon('file')}<span>Tải cả quyển (PDF)</span></button><span id="book-download-status" role="status" aria-live="polite">${esc(d.message||hint)}</span>${pick}${join}${d.notes?.length?`<ul class="book-download-notes">${d.notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul>`:''}${offer}</div>`;
}
// Only the download box is redrawn, so the open PDF does not reload.
function renderBookDownload(){const box=$('.book-download');if(box){box.outerHTML=bookDownloadPanel();bindBookDownload();}}
function renderBookDownloadSlot(){const slot=$('#book-download-slot');if(slot){slot.innerHTML=wholeBookPdf()?bookDownloadPanel():'';bindBookDownload();}}
// Inside Zalo, Facebook… (in-app-browser.js) the downloaded file is often dropped: the student is offered Chrome or
// Safari first, and may still go on.
function bindBookDownload(){on('#download-whole-book','click',()=>{const app=inAppBrowser();if(app){leaveInApp(app,{purpose:'download',go:()=>downloadWholeBook()});return;}return downloadWholeBook();});on('#book-join-only','click',()=>downloadWholeBook({joinOnly:true}));on('#book-pick-input','change',event=>pickOriginals([...event.target.files]));on('#book-cover-offer','click',useOfferedCover);}
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
  throw new Error(error?.known?error.message:'Không ghép được cả quyển trên thiết bị này (có thể do thiếu bộ nhớ). Hãy thử lại hoặc mở từng phần.');
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
 state.bookDownload={busy:false,message:`Đã ghép ${result.pages} trang như bản gốc. ${assembly.coverageNote(result.plan)}`,notes,coverOffer};renderBookDownload();
}
// Parts without a Vietnamese PDF (text translations, ranges not exported yet) cannot be joined; they are named, not dropped silently.
async function joinParts({PDFLib,assembly},chapters,title,story,progress,joinNote=''){
 const parts=chapters.filter(chapter=>chapter.mime==='application/pdf'),notes=[...(joinNote?[joinNote]:[]),...chapters.filter(chapter=>!parts.includes(chapter)).map(chapter=>`Phần “${chapter.title}” chưa có PDF tiếng Việt nên không có trong tệp ghép; phần này vẫn đọc được ${story.study?'trong Thư viện riêng':'trong Thư viện'}.`)];
 const cover=(story.study||story.assembly)&&story.cover?await bookCoverImage(story.id).catch(()=>null):null;
 const loadPart=async part=>{const index=parts.indexOf(part)+1,response=await fetch(`/api/chapter-file/${encodeURIComponent(part.id)}`,{credentials:'same-origin'});if(!response.ok)throw knownError(`Không tải được phần ${index} “${part.title}”. Hãy thử lại sau.`);return response.arrayBuffer();};
 const result=await assembly.concatenateParts({PDFLib,title,parts,loadPart,cover,onProgress:(index,total)=>progress(`Đang ghép phần ${index}/${total}…`)});
 progress('Đang lưu tệp PDF…');saveBookFile(result.bytes,title);
 state.bookDownload={busy:false,message:`Đã ghép ${parts.length} phần · ${result.pages} trang${cover?' · có ảnh bìa ở trang đầu':''}.`,notes};renderBookDownload();
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
 refresh().catch(()=>{});renderBookDownload();toast('Đã đặt ảnh bìa sách trong Thư viện riêng.');
}
function on(sel,event,fn){$(sel)?.addEventListener(event,async e=>{try{await fn(e);}catch(error){toast(error.message);}})}
// Google sign-in or a download inside another app's browser: how to open this page in Chrome or Safari, its address to
// copy (opened there, the page asks to sign in again: the app's browser keeps its own cookies), and "Vẫn tiếp tục".
function leaveInApp(app,{purpose,go:proceed}){
 const {browser,where,steps}=openInBrowserHelp(app),google=purpose==='google',link=location.href;
 modal(`<h2>Mở bằng ${browser} để ${google?'đăng nhập bằng Google':'tải tệp về máy'}</h2><p class="subtitle">Bạn đang mở Hoa Trí trong ${esc(where)}. ${google?'Google không cho đăng nhập trong trình duyệt của ứng dụng khác.':'Trình duyệt này thường không lưu được tệp tải về.'} Hãy ${esc(steps)}, hoặc sao chép địa chỉ dưới đây rồi dán vào ${browser}.</p><label class="modal-field">Địa chỉ trang<input id="in-app-link" readonly value="${esc(link)}" spellcheck="false"></label><div class="reset-link-actions"><button type="button" id="copy-in-app-link">Sao chép địa chỉ</button><span id="in-app-link-status" role="status"></span></div>`,async()=>{Promise.resolve().then(proceed).catch(error=>toast(error.message));},google?'Vẫn thử đăng nhập':'Vẫn tải ở đây');
 on('#copy-in-app-link','click',async()=>{
  const status=$('#in-app-link-status'),input=$('#in-app-link');
  try{await navigator.clipboard.writeText(link);status.textContent=`Đã sao chép. Mở ${browser} rồi dán vào thanh địa chỉ.`;}
  catch{input?.focus();input?.select();status.textContent='Không sao chép tự động được. Địa chỉ đã được chọn: giữ ngón tay trên ô để sao chép.';}
 });
}
// A failed submit keeps the dialog open and says why inside it: the toast would sit behind the modal backdrop.
// The dialog is named by its first heading; when it closes the focus returns to returnFocus() or to what opened it, at
// once when this code closes it (the close event comes one task later, with the focus still on a button of the hidden
// dialog), else on that event (Escape). A dialog replaced by the next one gives nothing back.
let giveFocusBack=null;
function modal(html,submit,confirmLabel='Xác nhận',{danger=false,returnFocus=null,cancel=true}={}){const d=$('#modal'),opener=document.activeElement;if(giveFocusBack)d.removeEventListener?.('close',giveFocusBack);giveFocusBack=null;if(d.open)d.close();d.innerHTML=`<form id="modal-form">${html}<p class="modal-error" id="modal-error" role="alert" hidden></p><div class="button-row">${cancel?'<button type="button" id="close-modal">Hủy</button>':''}<button class="primary${danger?' danger-solid':''}">${esc(confirmLabel)}</button></div></form>`;const title=d.querySelector?.('h2');if(title){title.id||='modal-title';d.setAttribute('aria-labelledby',title.id);}else d.removeAttribute?.('aria-labelledby');const back=()=>{if(d.open||giveFocusBack!==back)return;giveFocusBack=null;d.removeEventListener?.('close',back);const target=(typeof returnFocus==='function'?returnFocus():returnFocus)||opener;if(target?.isConnected&&target!==document.body){target.focus();return;}const heading=document.querySelector('main h1');if(heading){heading.setAttribute('tabindex','-1');heading.focus();}};giveFocusBack=back;d.addEventListener?.('close',back);d.showModal();const close=()=>{d.close();back();};const cancelButton=$('#close-modal');if(cancelButton)cancelButton.onclick=close;$('#modal-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter,error=$('#modal-error');button.disabled=true;error.hidden=true;try{await submit(new FormData(e.target));close();}catch(err){if(d.open){error.textContent=err.message;error.hidden=false;}else toast(err.message);}finally{button.disabled=false;}};}

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
  const cover=()=>document.querySelector(`[data-read-cover="${String(storyId).replace(/["\\]/g,'\\$&')}"]`);
  modal(`<div class="chapter-choice-heading"><p class="eyebrow">${esc(story?.title||'MỤC LỤC')}</p><h2>Chọn phần bắt đầu</h2><p class="subtitle">${chapters.length} phần đã công bố</p></div><label class="chapter-search">Tìm phần<input id="chapter-search-input" type="search" placeholder="Nhập số hoặc tên phần…" autocomplete="off"></label><label class="chapter-choice-label">Mục lục tài liệu<select name="chapter" id="chapter-start-select" size="${Math.max(2,Math.min(9,chapters.length))}" required>${chapters.map((chapter,index)=>`<option value="${index}" ${index===0?'selected':''}>${index+1}. ${esc(chapter.title)}</option>`).join('')}</select></label><p id="chapter-search-empty" class="subtitle" hidden>Không tìm thấy phần phù hợp.</p>`,form=>{open();openReaderWithBookAnimation(story,Number(form.get('chapter')),++openTicket);},'Mở sách',{returnFocus:cover});
  on('#chapter-search-input','input',event=>{const query=normalizeLibraryText(event.target.value),select=$('#chapter-start-select');let visible=0;for(const option of select.options){const matches=normalizeLibraryText(option.textContent).includes(query);option.hidden=!matches;if(matches)visible++;}if(select.selectedOptions[0]?.hidden)select.value=Array.from(select.options).find(option=>!option.hidden)?.value||'';$('#chapter-search-empty').hidden=visible>0;});
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
function createStory(){modal(`<h2>Tạo hồ sơ tài liệu</h2><label>Tên sách / tài liệu<input name="title" required maxlength="200"></label><label style="margin-top:16px">Lĩnh vực<select name="genre"><option selected>Chuyên khảo · Nghiên cứu</option><option>Toán học · STEM</option><option>Lịch sử Trung Hoa</option><option>Cổ văn · Hán Nôm</option><option>Triết học · Tư tưởng</option><option>Văn hóa · Xã hội</option><option>Địa lý · Khảo cổ</option><option>Giáo dục</option><option>Ngôn ngữ học</option><option>Tài liệu khác</option></select></label>${coverInput()}`,async f=>{const r=await api('/stories',{method:'POST',body:f});state.storyId=r.id;await refresh();render();toast('Đã tạo hồ sơ tài liệu.');});bindCoverPreview();}
async function runJob(jid){const first=state.jobs.find(job=>job.id===jid),siblings=first&&/^[0-9]{2,}\s*·/.test(first.filename)?state.jobs.filter(job=>job.story_id===first.story_id&&job.status==='uploaded'&&job.filename.localeCompare(first.filename,'vi')>=0).sort((a,b)=>a.filename.localeCompare(b.filename,'vi')):[],queue=[first,...siblings].filter((job,index,list)=>job&&list.findIndex(item=>item.id===job.id)===index);busy=true;go('review');state.selected=jid;render();toast(queue.length>1?`Đã xếp ${queue.length} phần vào hàng dịch. Mỗi phần hoàn tất sẽ chờ người quản trị đối chiếu.`:'Đang nhận diện và dịch. Kết quả sẽ được giữ ở trạng thái chờ duyệt.');poll=setInterval(async()=>{try{await pollJobs([state.selected]);if(state.route==='review')render();}catch{}},4000);try{for(const queued of queue){state.selected=queued.id;if(state.route==='review')render();let result;do{result=await api(`/jobs/${queued.id}/run`,{method:'POST'});state.jobs=state.jobs.map(j=>j.id===queued.id?{...j,...result}:j);}while(token&&['splitting','prepared','assembling','ocr','translating','uploaded'].includes(result.status));if(result.status==='review'){state.selected=queued.id;if(state.route==='review')render();toast(`${queued.filename} đã dịch xong · đang chờ đối chiếu và duyệt.`);}else if(result.status==='failed'){state.selected=queued.id;if(state.route==='review')render();break;}}}finally{busy=false;clearInterval(poll);await refresh();render();}}
// Signed out, the student signs in first and the dialog then opens by itself (render(), state.pendingRequest), filled
// with what they had typed when their session ran out while sending (keepRequestDraft).
function requestStory(){
 if(!state.reader.authenticated){if(!requestDraftKept())keepRequestDraft();state.pendingRequest=true;go('account');toast('Hãy đăng nhập hoặc tạo tài khoản để gửi yêu cầu. Hộp yêu cầu dịch sẽ mở ngay sau khi đăng nhập.');return;}
 const draft=takeRequestDraft(),value=name=>esc(typeof draft[name]==='string'?draft[name]:''),shared=draft.visibility==='public',again=typeof draft.filename==='string'&&draft.filename;
 const invalid=(names,bad)=>{for(const name of names){const input=$(`#modal [name="${name}"]`);if(bad)input?.setAttribute('aria-invalid','true');else input?.removeAttribute('aria-invalid');}};
 modal(`<div class="request-form-heading"><p class="eyebrow">GỬI TÀI LIỆU NGUỒN</p><h2>Bạn cần dịch sách hoặc tài liệu nào?</h2><p class="subtitle">Tải tệp tiếng Trung trực tiếp hoặc gửi liên kết nguồn. Chỉ cần một trong hai.</p></div><label class="modal-field">Tên sách / tài liệu<input name="title" required maxlength="200" value="${value('title')}"></label><fieldset class="request-source"><legend>Tệp hoặc liên kết <span>(cần một trong hai)</span></legend><label class="request-file">Tệp nguyên tác<input name="file" type="file" accept=".pdf,.epub,.azw3,.docx,.txt,.jpg,.jpeg,.png,.webp" aria-describedby="request-file-hint${again?' request-file-again':''}"><small id="request-file-hint">PDF, EPUB, AZW3, DOCX, TXT hoặc ảnh scan · tối đa 25 MB</small>${again?`<small class="request-file-again" id="request-file-again">Hãy chọn lại tệp “${esc(again)}”: trình duyệt không giữ tệp đã chọn qua lần đăng nhập.</small>`:''}</label><label class="modal-field">Liên kết nguyên tác<input name="source_url" type="url" placeholder="https://…" value="${value('source_url')}"></label></fieldset><label class="modal-field">Mục đích học tập / lưu ý<textarea name="notes" maxlength="2000" rows="3" placeholder="Chủ đề nghiên cứu, giai đoạn lịch sử, thuật ngữ cần giữ…">${value('notes')}</textarea></label><fieldset class="visibility-choice"><legend>Ai có thể đọc khi tài liệu hoàn thành?</legend><label><input type="radio" name="visibility" value="private"${shared?'':' checked'}><span>${icon('book')}<strong>Chỉ mình tôi</strong><small>Lưu trong Thư viện riêng của bạn</small></span></label><label><input type="radio" name="visibility" value="public"${shared?' checked':''}><span>${icon('spark')}<strong>Chia sẻ cộng đồng</strong><small>Đưa vào thư viện học liệu chung</small><small class="visibility-rights">Chỉ chọn khi tài liệu hết bản quyền hoặc bạn được phép chia sẻ.</small></span></label></fieldset>`,async f=>{
  const file=f.get('file'),source=String(f.get('source_url')||'').trim();invalid(['file','source_url'],false);
  if(file?.size>25*1024*1024){invalid(['file'],true);throw new Error('Tệp yêu cầu tối đa 25 MB.');}
  if(!file?.size&&!source){invalid(['file','source_url'],true);throw new Error('Hãy chọn một tệp hoặc nhập liên kết nguyên tác.');}
  // The server keeps only web addresses (http or https with a host); anything else is said here, on the field.
  if(source&&!webLink(source)){invalid(['source_url'],true);throw new Error('Liên kết nguyên tác phải là một địa chỉ web bắt đầu bằng http:// hoặc https://, ví dụ https://www.example.com/sach.');}
  try{await api('/requests',{method:'POST',body:f});}
  catch(error){
   if(error.status===400&&/^Liên kết/u.test(error.message))invalid(['source_url'],true);
   // The session ran out while the dialog was open: what was typed waits in this tab while the student signs in again.
   if(error.status!==401)throw error;
   keepRequestDraft({title:String(f.get('title')||''),source_url:source,notes:String(f.get('notes')||''),visibility:String(f.get('visibility')||'private'),filename:file?.size?String(file.name||''):''});
   $('#modal').close();state.reader={...state.reader,authenticated:false,user:null};state.myLibrary=[];state.myRequests=[];go('account');
   toast('Phiên đăng nhập đã hết. Hãy đăng nhập lại; hộp yêu cầu dịch sẽ mở lại với nội dung bạn đã nhập.');return;
  }
  await refresh();render();toast('Đã gửi yêu cầu dịch. Bạn có thể theo dõi tiến độ tại đây.');
 },'Gửi yêu cầu');
}
// The server takes XÓA or XOÁ in any case; an account with a password also confirms with it. A Google-only account has
// no password to ask, so the server takes its deletion only within 10 minutes of signing in (code reauth_required): the
// dialog says so first, and on that answer offers to sign out, to sign in again with Google.
const REAUTH_NOTE='Tài khoản đăng nhập bằng Google chỉ xóa được trong vòng 10 phút sau khi đăng nhập. Nếu bạn đã đăng nhập lâu hơn, hãy đăng xuất rồi đăng nhập lại bằng Google trước.';
function deleteAccountDialog(){
 // A server that does not name the sign-in kind gets the password field too; a Google-only account's answer is ignored.
 const local=state.reader.user?.provider!=='google';
 modal(`<h2>Xóa tài khoản vĩnh viễn?</h2><p class="subtitle">Lịch sử dịch, sách trong Thư viện riêng, PDF gốc và bản dịch đã lưu, cùng các yêu cầu dịch của bạn sẽ bị xóa ngay và không khôi phục được. Tài liệu đã công bố trong Thư viện chung được giữ lại nhưng không còn gắn với tên bạn.</p>${local?'<label class="modal-field">Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>':`<p class="auth-note" role="note" style="margin-top:16px">${REAUTH_NOTE}</p>`}<label class="modal-field">Nhập XÓA để xác nhận<input name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="10"></label><p id="reauth-row" style="margin-top:12px" hidden><button type="button" id="reauth-signout">Đăng xuất để đăng nhập lại bằng Google</button></p>`,async form=>{
  const confirm=String(form.get('confirm')||'').normalize('NFC').trim(),field=name=>$(`#modal input[name="${name}"]`);
  if(!['XÓA','XOÁ'].includes(confirm.toUpperCase())){field('confirm')?.focus();throw new Error('Hãy nhập đúng chữ XÓA để xác nhận.');}
  try{await api('/me',{method:'DELETE',body:{confirm,...(local?{password:String(form.get('password')||'')}:{})}});}
  catch(error){
   const name={wrong_password:'password',password_required:'password',confirm_required:'confirm'}[error.code];if(name)field(name)?.focus();if(error.status===401){await refresh().catch(()=>{});render();}
   // The server's message (shown in the dialog) says what to do; the button next to it does the first step.
   if(error.code==='reauth_required'){const row=$('#reauth-row');if(row){row.hidden=false;$('#reauth-signout')?.focus();}}
   throw error;
  }
  localSources=new Map();Object.assign(state,{reader:{...state.reader,authenticated:false,user:null},myLibrary:[],myRequests:[],readerStory:null,chapters:[]});
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
 modal(`<h2>Đăng xuất khỏi mọi thiết bị?</h2><p class="subtitle">Mọi nơi đang đăng nhập tài khoản này, như máy tính dùng chung ở trường, sẽ phải đăng nhập lại. Liên kết đặt lại mật khẩu chưa dùng của tài khoản cũng hết hiệu lực.</p><label class="confirm-check"><input type="checkbox" name="keepCurrent" checked> Vẫn giữ đăng nhập trên thiết bị này</label>`,async form=>{
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
  state.accountNotice=`Đã đổi mật khẩu.${ended?` ${ended} nơi khác đang đăng nhập tài khoản này đã bị đăng xuất.`:''} Lần sau hãy đăng nhập bằng mật khẩu mới.`;state.focusAfterRender='heading';render();
 },error=>['wrong_password','password_required'].includes(error.code)?['currentPassword']:error.status===400?['newPassword']:[]);
}
function bindAuth(){
 const tabs=[...document.querySelectorAll('[data-auth-tab]')];
 const select=button=>{const register=button.dataset.authTab==='register';for(const item of tabs){const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;}$('#auth-panel-login').hidden=register;$('#auth-panel-register').hidden=!register;const row=$('#google-terms-row');if(row)row.hidden=register;};
 tabs.forEach((button,index)=>{button.onclick=()=>select(button);button.onkeydown=event=>{const step={ArrowRight:1,ArrowLeft:-1}[event.key];if(!step&&!['Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+step+tabs.length)%tabs.length];select(next);next.focus();};});
 // The registration box and the Google box stand for the same consent, so ticking one ticks the other.
 const boxes=[...document.querySelectorAll('[data-terms-check]')];
 const agree=checked=>{state.termsAccepted=checked;for(const box of boxes)box.checked=checked;const google=$('#google-login'),hint=$('#google-terms-hint');if(google){google.setAttribute('aria-disabled',String(!checked));google.setAttribute('href',googleHref(checked));}if(hint)hint.textContent=checked?'Khi tiếp tục bằng Google, bạn đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư.':'Đánh dấu ô đồng ý để tiếp tục bằng Google.';};
 boxes.forEach(box=>box.onchange=()=>agree(box.checked));if(boxes.length)agree(Boolean(state.termsAccepted));
 // Inside Zalo, Facebook… Google refuses the sign-in (in-app-browser.js): the student is first offered Chrome or Safari.
 $('#google-login')?.addEventListener('click',event=>{
  if(event.currentTarget.getAttribute('aria-disabled')!=='true'){
   const app=inAppBrowser(),href=event.currentTarget.href;state.googleFailure=null;
   if(app){event.preventDefault();leaveInApp(app,{purpose:'google',go:()=>{location.href=href;}});}
   return;
  }
  event.preventDefault();(boxes.find(box=>box.offsetParent)||boxes[0])?.focus();toast('Hãy đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư trước khi tiếp tục bằng Google.');
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
 state.googleFailure=null;state.focusAfterRender='heading';render();toast(message);
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
function clearFormError(form){const box=form?.querySelector?.('.form-error');if(!box)return;box.hidden=true;box.textContent='';markInvalid(form,[],box);}
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
  state.accountNotice=state.reader.authenticated?'Đã đặt mật khẩu mới. Bạn đã được đăng nhập; các thiết bị khác đang dùng tài khoản này đã được đăng xuất.':'Đã đặt mật khẩu mới. Hãy đăng nhập bằng mật khẩu mới.';go('account');
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
 const opener=`[data-user-reset="${String(user.id).replace(/["\\]/g,'\\$&')}"]`;
 modal(`<h2>Liên kết đặt lại mật khẩu cho ${esc(user.name||user.email)}</h2><p class="subtitle">Gửi riêng liên kết này cho đúng học sinh ${esc(user.email)}, qua tin nhắn riêng, không đăng vào nhóm lớp: ai mở được liên kết đều đặt được mật khẩu mới cho tài khoản này. Mật khẩu cũ vẫn dùng được cho tới lúc đó.</p><label class="modal-field">Liên kết đặt lại mật khẩu<input id="reset-link" readonly value="${esc(link)}" spellcheck="false"></label><div class="reset-link-actions"><button type="button" id="copy-reset-link">Sao chép</button><span id="reset-link-status" role="status"></span></div><p class="auth-note reset-link-note">Liên kết chỉ hiện một lần: đóng hộp này là không xem lại được (tạo liên kết mới nếu cần, liên kết cũ sẽ hết hiệu lực). Liên kết chỉ mở được một lần${when?` và hết hạn lúc ${esc(when)}`:''}; học sinh mở ra thì đặt mật khẩu mới ngay (trong 30 phút).</p>`,async()=>{},'Đóng',{cancel:false,returnFocus:()=>document.querySelector(opener)});
 const input=$('#reset-link');input?.focus();input?.select();
 on('#copy-reset-link','click',async()=>{
  const status=$('#reset-link-status');
  try{await navigator.clipboard.writeText(link);status.textContent='Đã sao chép. Hãy dán vào tin nhắn riêng cho học sinh.';}
  catch{input?.focus();input?.select();status.textContent='Không sao chép tự động được. Liên kết đã được chọn: nhấn Ctrl+C (hoặc giữ để sao chép trên điện thoại).';}
 });
}
// Admin: lock (sessions end, login refused, data kept), unlock, or delete an account with everything private to it.
function lockUser(id){
 const user=state.users.find(item=>item.id===id);if(!user)return;
 const change=async disabled=>{await api(`/users/${encodeURIComponent(id)}`,{method:'PATCH',body:{disabled}});await refresh();render();toast(disabled?'Đã khóa tài khoản.':'Đã mở khóa tài khoản.');};
 if(user.disabled_at){change(false).catch(error=>toast(error.message));return;}
 modal(`<h2>Khóa tài khoản ${esc(user.email)}?</h2><p class="subtitle">Người này bị đăng xuất khỏi mọi thiết bị và không đăng nhập được cho tới khi được mở khóa. Dữ liệu vẫn được giữ nguyên.</p>`,()=>change(true),'Khóa tài khoản');
}
function deleteUser(id){
 const user=state.users.find(item=>item.id===id);if(!user)return;
 modal(`<h2>Xóa tài khoản ${esc(user.email)} và toàn bộ dữ liệu riêng của người này?</h2><p class="subtitle">Lịch sử dịch, sách trong Thư viện riêng, PDF gốc và bản dịch, yêu cầu dịch và phiên đăng nhập của người này sẽ bị xóa vĩnh viễn. Tài liệu đã công bố trong Thư viện chung được giữ lại nhưng không còn gắn với tài khoản này. Không thể hoàn tác.</p><label class="confirm-check"><input type="checkbox" required> Tôi xác nhận xóa tài khoản này.</label>`,async()=>{await api(`/users/${encodeURIComponent(id)}`,{method:'DELETE'});await refresh();render();toast('Đã xóa tài khoản.');},'Xóa vĩnh viễn',{danger:true});
}
function bind(){bindMusic(toast);bindAuth();on('#delete-account','click',deleteAccountDialog);document.querySelectorAll('[data-user-lock]').forEach(b=>b.onclick=()=>lockUser(b.dataset.userLock));document.querySelectorAll('[data-user-delete]').forEach(b=>b.onclick=()=>deleteUser(b.dataset.userDelete));document.querySelectorAll('[data-user-reset]').forEach(b=>b.onclick=()=>createResetLink(b.dataset.userReset,b).catch(error=>toast(error.message)));document.querySelectorAll('[data-request-open]').forEach(b=>b.onclick=()=>requestStory());on('#hanzi-open','click',()=>{const picked=String(getSelection()||'').trim();openHanziPanel({text:/\p{Script=Han}/u.test(picked)?picked.slice(0,600):'',search:true,returnFocus:$('#hanzi-open'),theme:state.theme});});on('#bilingual-toggle','click',toggleBilingual);document.querySelectorAll('[data-request-file]').forEach(b=>b.onclick=()=>adminDownload(`/requests/${encodeURIComponent(b.dataset.requestFile)}/file`,state.requests.find(x=>x.id===b.dataset.requestFile)?.filename||'nguyen-tac','Không tải được tệp nguồn').catch(error=>toast(error.message)));on('#download-source','click',()=>adminDownload(`/jobs/${encodeURIComponent(state.selected)}/source`,'nguyen-tac.txt','Không tải được nguyên tác'));bindAdminContent();on('#pdf-parts','click',showPdfParts);on('#download-book','click',downloadBook);bindCoverButtons();on('#reader-request','click',requestStory);on('#account-request','click',requestStory);on('#reader-logout','click',async event=>{const button=event.currentTarget;button.disabled=true;try{await signOut();}finally{if(button.isConnected!==false)button.disabled=false;}await refresh().catch(()=>{});go('library');toast('Đã đăng xuất tài khoản người học.');});on('#reader-more-toggle','click',event=>{state.readerMore=!state.readerMore;$('.reader-toolbar')?.classList.toggle('is-more-open',state.readerMore);event.currentTarget.setAttribute('aria-expanded',String(state.readerMore));});on('#admin-login-form','submit',e=>e.preventDefault());document.querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>go(b.dataset.route));document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.draftText=$('#source-input')?.value||state.draftText;state.storyId=$('#story-select')?.value;state.tab=b.dataset.tab;render();});document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{state.selected=b.dataset.job;go('review');});
 document.querySelectorAll('[data-review-story]').forEach(b=>b.onclick=()=>{state.reviewStory=b.dataset.reviewStory;state.showReviewQueue=false;state.selected=null;render();});on('#back-review-books','click',()=>{state.reviewStory=null;state.showReviewQueue=false;render();});on('#toggle-review-queue','click',()=>{state.showReviewQueue=!state.showReviewQueue;render();});
 on('#new-story','click',createStory);on('#back-jobs','click',()=>{state.selected=null;render();});on('#story-select','change',e=>{state.storyId=e.target.value;selectAcademicField(state.storyId);$('#story-cover-slot').innerHTML=uploadCoverPanel();bindCoverButtons();showAdminCovers();});selectAcademicField(state.storyId||'');on('#genre','change',e=>{genreDrafts[state.storyId||'']=e.target.value;});
 async function selected(file){if(!file)return;if(file.size>25*1024*1024)throw new Error('Tối đa 25 MB mỗi tài liệu.');state.file=file;state.pdfAnalysis=null;state.storyId=$('#story-select')?.value;render();if(file.name.toLowerCase().endsWith('.pdf')){toast('Đang kiểm tra lớp chữ của PDF trên trình duyệt…');try{const {analyzePdf}=await import('./pdf-client.js');state.pdfAnalysis=await analyzePdf(file,(page,total)=>{if(page===1||page===total||page%10===0)toast(`Đang phân tích PDF · ${page}/${total} trang`);});toast(state.pdfAnalysis.mode==='hybrid'?`Đã lấy chữ từ ${state.pdfAnalysis.pagesWithText} trang; chỉ ${state.pdfAnalysis.scanPages} trang cần OCR.`:state.pdfAnalysis.mode==='text'?`Đã lấy và làm sạch lớp chữ từ ${state.pdfAnalysis.totalPages} trang. Không cần OCR ảnh.`:`Đã nhận diện PDF scan ${state.pdfAnalysis.totalPages} trang. Ảnh sẽ được giảm còn 1200px, chuyển xám và nén trước khi OCR.`);}catch(error){state.pdfAnalysis={mode:'fallback',error:error.message};toast('Không đọc được lớp chữ trong trình duyệt; máy chủ sẽ dùng quy trình PDF dự phòng.');}render();}}
 on('#dropzone','click',e=>{e.preventDefault();$('#file-input').click();});on('#dropzone','keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#file-input').click();}});on('#file-input','change',e=>selected(e.target.files[0]));on('#dropzone','dragover',e=>{e.preventDefault();e.currentTarget.classList.add('drag');});on('#dropzone','dragleave',e=>e.currentTarget.classList.remove('drag'));on('#dropzone','drop',e=>{e.preventDefault();selected(e.dataTransfer.files[0]);});on('#remove-file','click',()=>{state.file=null;render();});
 on('#start-translate','click',e=>uploadJob(e,false));on('#prepare-pdf','click',e=>uploadJob(e,true));
 on('#login','click',async e=>{e.preventDefault();token=$('#admin-token').value;try{await refresh();if(!state.status.authenticated)throw new Error(state.status.adminTokenTooShort?ADMIN_TOKEN_SHORT:'Mã quản trị không đúng.');go('translate');toast('Đã kết nối không gian quản trị.');}catch(e){token='';state.status={authenticated:false};state.jobs=[];state.stories=[];state.requests=[];render();throw e;}});on('#logout','click',logout);on('#admin-logout','click',logout);
 on('#toggle-api-key','click',e=>{const input=$('#gemini-api-key'),show=input.type==='password';input.type=show?'text':'password';e.currentTarget.textContent=show?'Ẩn':'Hiện';e.currentTarget.setAttribute('aria-label',show?'Ẩn khóa API':'Hiện khóa API');});
 on('#gemini-key-form','submit',async e=>{e.preventDefault();const input=$('#gemini-api-key'),button=e.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{await api('/settings/gemini-key',{method:'PUT',body:{apiKey:input.value}});input.value='';await refresh();render();toast('Đã lưu khóa API mới. Lần dịch tiếp theo sẽ dùng khóa này.');}finally{if(button.isConnected)button.disabled=false;}});
 on('#reset-api-key','click',async()=>{await api('/settings/gemini-key',{method:'DELETE'});await refresh();render();toast('Đã chuyển về khóa API cấu hình trên máy chủ.');});
 on('#rerun','click',()=>runJob(state.selected));on('#save-job','click',async()=>{if(!jobDetail(state.selected))throw new Error('Nội dung bản dịch chưa tải xong. Hãy đợi một chút.');const result=await api(`/jobs/${state.selected}`,{method:'PATCH',body:{source:$('#edit-source').value,translation:$('#edit-translation').value}});await refresh();render();toast(result?.long?'Đã lưu bản biên tập. Văn bản dài được lưu riêng, đầy đủ; ô biên tập chỉ hiện 20.000 ký tự đầu.':'Đã lưu bản biên tập.');});
 on('#publish-job','click',()=>{if(!jobDetail(state.selected))throw new Error('Nội dung bản dịch chưa tải xong. Hãy đợi một chút.');const jobId=state.selected,source=$('#edit-source').value,translation=$('#edit-translation').value,ebook=/^\[Phần (?:AZW3|EPUB) \d+/mu.test(source),job=state.jobs.find(j=>j.id===jobId),firstLine=translation.split('\n').map(line=>line.trim()).find(Boolean),suggested=(firstLine&&firstLine.length<=200?firstLine:String(job?.filename||'').replace(/^\d+\s*·\s*/,''))||'Phần 1';modal(`<h2>Duyệt & công bố</h2><p class="subtitle">${ebook?'Hệ thống sẽ giữ thứ tự mục/chương theo cấu trúc có sẵn trong sách.':'Kiểm tra tên phần được gợi ý trước khi công bố.'}</p>${ebook?'':`<label>Tên phần / mục<input name="title" required maxlength="200" value="${esc(suggested)}" placeholder="Phần 1: Mở đầu"></label>`}<label class="confirm-check"><input type="checkbox" name="confirmed" required> Tôi đã đối chiếu bản dịch, thuật ngữ, niên đại và những chữ chưa rõ.</label>`,async f=>{if(!job?.source_key&&!job?.translation_key)await api(`/jobs/${jobId}`,{method:'PATCH',body:{source,translation}});const result=await api(`/jobs/${jobId}/publish`,{method:'POST',body:{title:f.get('title')||'Phần 1',confirmed:true}});await refresh();state.selected=jobId;render();toast(result.chapters>1?`Đã tự động tách và công bố ${result.chapters} phần.`:'Phần tài liệu đã được công bố trong thư viện.');});});
 on('#download-original','click',()=>adminDownload(`/jobs/${encodeURIComponent(state.selected)}/file`,state.jobs.find(j=>j.id===state.selected)?.filename||'ban-goc','Không tải được bản gốc'));
 document.querySelectorAll('[data-story]').forEach(b=>b.onclick=()=>{state.storyId=b.dataset.story;go('translate');});on('#glossary-story','change',e=>{state.glossaryId=e.target.value;render();});on('#save-glossary','click',async()=>{if(!state.glossaryId)throw new Error('Chọn hồ sơ tài liệu.');if(glossaryOf(state.glossaryId)===null)throw new Error('Bảng thuật ngữ của tài liệu này chưa tải xong. Hãy đợi một chút.');const glossary={};for(const line of $('#glossary-text').value.split('\n').filter(x=>x.trim())){const i=line.indexOf('=');if(i<1||!line.slice(i+1).trim())throw new Error('Mỗi dòng cần có dạng: tên Trung = tên dịch');glossary[line.slice(0,i).trim()]=line.slice(i+1).trim();}await api(`/stories/${state.glossaryId}`,{method:'PATCH',body:{glossary}});await refresh();render();toast('Đã lưu bảng thuật ngữ. Áp dụng cho những lần dịch tiếp theo.');});
 document.querySelectorAll('[data-accept]').forEach(b=>b.onclick=async()=>{try{b.disabled=true;const result=await api(`/requests/${b.dataset.accept}/accept`,{method:'POST'});state.storyId=result.story_id;if(result.job_id)state.selected=result.job_id;await refresh();if(result.job_id){go('review');toast(result.alreadyAccepted?'Đã mở tài liệu được tạo từ yêu cầu.':'Đã tạo hồ sơ và đưa tệp vào Xưởng dịch.');}else{go('translate');toast(result.alreadyAccepted?'Yêu cầu này đã được tiếp nhận.':'Đã tạo hồ sơ tài liệu. Yêu cầu chỉ có liên kết nên chưa tạo bản dịch.');}}catch(e){b.disabled=false;toast(e.message);}});document.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{try{await api(`/requests/${b.dataset.done}`,{method:'PATCH',body:{status:'done'}});await refresh();render();}catch(e){toast(e.message);}});
 document.querySelectorAll('[data-load-more]').forEach(b=>b.onclick=()=>{b.disabled=true;loadMore(b.dataset.loadMore).catch(error=>{b.disabled=false;toast(error.message);});});
 document.querySelectorAll('[data-user-books]').forEach(b=>b.onclick=()=>{loadUserBooks(b.dataset.userBooks);render();});document.querySelectorAll('[data-user-books-more]').forEach(b=>b.onclick=()=>{loadUserBooks(b.dataset.userBooksMore,{more:true});render();});document.querySelectorAll('[data-user-books-hide]').forEach(b=>b.onclick=()=>{delete state.userBooks[b.dataset.userBooksHide];render();});document.querySelectorAll('[data-user-books-retry]').forEach(b=>b.onclick=()=>{loadUserBooks(b.dataset.userBooksRetry,{again:true});render();});
 on('#job-detail-retry','click',()=>{loadJobDetail(state.selected,{again:true});render();});on('#story-detail-retry','click',()=>{loadStoryDetail(state.glossaryId,{again:true});render();});
 bindPublicNavigation();
 on('#library-search','input',e=>{state.libraryQuery=e.target.value;filterLibrary();});document.querySelectorAll('[data-library-genre]').forEach(b=>b.onclick=()=>{state.libraryGenre=b.dataset.libraryGenre;filterLibrary();});filterLibrary();document.querySelectorAll('[data-read]').forEach(b=>b.onclick=()=>openStory(b.dataset.read));document.querySelectorAll('[data-reader-theme]').forEach(b=>b.onclick=()=>setReaderTheme(b.dataset.readerTheme));document.querySelectorAll('.footnote-ref').forEach(button=>{button.onpointerenter=button.onfocus=()=>placeFootnote(button);button.onclick=()=>{placeFootnote(button);button.setAttribute('aria-expanded',String(button.classList.toggle('is-open')));};});bindBookDownload();on('#reader-chapter-select','change',e=>showChapter(Number(e.target.value),{keepFocus:true}));on('#font-smaller','click',()=>changeReaderFont(-1));on('#font-larger','click',()=>changeReaderFont(1));on('#prev-chapter','click',()=>showChapter(state.chapter-1));on('#next-chapter','click',()=>showChapter(state.chapter+1));on('#stop-speak','click',()=>speechSynthesis.cancel());on('#speak','click',()=>{if(state.chapters[state.chapter]?.mime==='application/pdf')throw new Error('PDF được đọc trong khung tài liệu; chức năng giọng đọc chỉ dùng cho phần văn bản.');if(!('speechSynthesis'in window))throw new Error('Trình duyệt không hỗ trợ đọc giọng máy.');const voice=speechSynthesis.getVoices().find(v=>v.lang.startsWith('vi'));if(!voice)throw new Error('Chưa có giọng tiếng Việt trên thiết bị. Hãy cài giọng tiếng Việt trong hệ điều hành.');speechSynthesis.cancel();const readable=readerFootnotes(state.chapters[state.chapter].content).body,paragraphs=readable.match(/[\s\S]{1,200}[.!?\n\s]|[\s\S]+$/g)||[];for(const p of paragraphs){const u=new SpeechSynthesisUtterance(p);u.voice=voice;u.lang='vi-VN';speechSynthesis.speak(u);}});
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
  if(state.readerStory?.id===storyId&&state.chapters.length){globalThis.speechSynthesis?.cancel();state.chapter=Math.min(part,state.chapters.length)-1;state.route='reader';state.focusAfterRender='heading';render();return;}
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
  <a class="brand" href="/" data-home-link aria-label="Hoa Trí — Trang chủ"><img src="/favicon.svg" alt="" width="40" height="40"><span><strong>Hoa Trí<span class="brand-dot">.</span></strong><small>TRUNG VĂN · VIỆT NGỮ</small></span></a>
  <nav class="site-nav" aria-label="Dành cho người học">
   <a href="/" data-home-link${state.route==='library'||state.route==='reader'?' aria-current="page"':''}>${icon('book')}<span>Học liệu</span></a>
   <a href="/study">${icon('translate')}<span>Xưởng dịch</span></a>
  </nav>
  <div class="site-header-actions">
   <button class="header-request" id="reader-request" type="button">${icon('plus')}<span>Yêu cầu dịch</span></button>
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
function loginView(){return `<main class="admin-login"><a class="login-back" href="/">← Về thư viện học liệu</a><section class="panel login-card"><p class="eyebrow">KHU VỰC QUẢN TRỊ</p><h1>Đăng nhập quản trị</h1><p class="subtitle">Dịch, đối chiếu và công bố tài liệu học thuật Trung – Việt.</p>${state.status.adminTokenTooShort?`<p class="warning" role="alert">${ADMIN_TOKEN_SHORT}</p>`:''}<form id="admin-login-form"><label for="admin-token">Mã quản trị</label><input type="password" id="admin-token" autocomplete="current-password" required placeholder="Nhập mã quản trị"><button class="primary" id="login" type="submit">Đăng nhập</button></form></section></main>`;}
async function logout(){token='';releaseAdminCovers();clearInterval(poll);state.status={authenticated:false};state.jobs=[];state.stories=[];state.requests=[];state.users=[];state.more={stories:null,jobs:null};state.jobDetails={};state.storyDetails={};state.userBooks={};state.file=null;state.selected=null;state.draftText='';$('#modal').close();go('settings');}

function coverPlaceholder(s){return `<div class="book-art cover-placeholder"><span>${esc(s.title.slice(0,1))}</span><small>Chưa có ảnh bìa</small></div>`;}
function coverArt(s){
 if(!s.cover_key)return coverPlaceholder(s);
 // In the admin console a private book's cover (a student's book, an unpublished draft) is shown from an object URL
 // fetched with the admin's token (showAdminCovers): an <img> cannot send it, and the admin has no reader cookie.
 if(adminArea&&s.visibility==='private'){const url=adminCovers.get(`${s.id}:${s.cover_key}`);return url===''?coverPlaceholder(s):`<img class="book-cover" src="${url?esc(url):BLANK_IMAGE}" ${url?'':`data-admin-cover="${esc(s.id)}" data-cover-key="${esc(s.cover_key)}" `}alt="Bìa ${esc(s.title)}">`;}
 return `<img class="book-cover" src="/api/covers/${encodeURIComponent(s.id)}?v=${encodeURIComponent(s.cover_key)}" alt="Bìa ${esc(s.title)}" loading="lazy">`;
}
function releaseAdminCovers(view=''){for(const url of adminCovers.values())if(url)URL.revokeObjectURL(url);adminCovers.clear();adminCoverView=view;}
function showAdminCovers(){
 if(adminCoverView!==state.route)releaseAdminCovers(state.route);const view=adminCoverView;
 for(const img of document.querySelectorAll('img[data-admin-cover]')){
  const id=img.dataset.adminCover,version=img.dataset.coverKey,key=`${id}:${version}`;if(adminCovers.has(key))continue;adminCovers.set(key,null);
  fetch(`/api/covers/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.ok?response.blob():null).catch(()=>null).then(blob=>{
   // Another view (or signing out) cleared the list meanwhile: nothing is kept.
   if(adminCoverView!==view||adminCovers.get(key)!==null)return;
   const url=blob?URL.createObjectURL(blob):'';adminCovers.set(key,url);
   for(const node of document.querySelectorAll('img[data-admin-cover]'))if(node.dataset.adminCover===id&&node.dataset.coverKey===version){if(url){node.src=url;node.removeAttribute('data-admin-cover');}else node.outerHTML=coverPlaceholder({title:node.alt.replace(/^Bìa /u,'')});}
  });
 }
}
function uploadCoverPanel(){const s=state.stories.find(s=>s.id===state.storyId);return s?`<div class="upload-cover">${coverArt(s)}<div><strong>Ảnh bìa tài liệu</strong><p class="subtitle">Hiển thị cùng tài liệu trong thư viện người đọc.</p><button type="button" data-cover="${s.id}">${s.cover_key?'Đổi ảnh bìa':'Tải ảnh bìa'}</button></div></div>`:'';}
function coverInput(){return `<label style="margin-top:18px">Ảnh bìa tài liệu<input type="file" name="cover" id="cover-input" accept="image/jpeg,image/png,image/webp"><small>JPG, PNG, WebP · tối đa 5 MB · nên dùng ảnh dọc 2:3.</small></label><img id="cover-preview" class="cover-preview hide" alt="Xem trước ảnh bìa">`;}
function bindCoverPreview(){let previewUrl;const dialog=$('#modal');dialog.addEventListener('close',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);},{once:true});on('#cover-input','change',e=>{if(previewUrl)URL.revokeObjectURL(previewUrl);const image=$('#cover-preview');image.classList.add('hide');image.removeAttribute('src');const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){e.target.value='';throw new Error('Chọn ảnh JPG, PNG hoặc WebP tối đa 5 MB.');}previewUrl=URL.createObjectURL(file);image.src=previewUrl;image.classList.remove('hide');});}
function bindCoverButtons(){document.querySelectorAll('[data-cover]').forEach(b=>b.onclick=()=>{state.draftText=$('#source-input')?.value??state.draftText;const sid=b.dataset.cover;modal(`<h2>Ảnh bìa tài liệu</h2>${coverInput()}`,async form=>{if(!form.get('cover')?.size)throw new Error('Hãy chọn ảnh bìa.');await api(`/stories/${sid}/cover`,{method:'POST',body:form});await refresh();render();toast('Đã lưu ảnh bìa.');});bindCoverPreview();});}
async function uploadJob(e,prepareOnly){const sid=$('#story-select').value;if(!sid)throw new Error('Hãy tạo hoặc chọn hồ sơ tài liệu trước.');const f=new FormData(),sourceFile=state.file,pdfAnalysis=state.pdfAnalysis;f.set('story_id',sid);if(state.tab==='file'){if(!sourceFile)throw new Error('Hãy chọn tài liệu.');if(sourceFile.name.toLowerCase().endsWith('.pdf')&&!pdfAnalysis)throw new Error('Hãy đợi phân tích PDF hoàn tất.');f.set('file',sourceFile);if(pdfAnalysis?.mode==='text'){f.set('parsed_text',pdfAnalysis.text);f.set('pdf_pages',String(pdfAnalysis.totalPages));}if(['scan','hybrid'].includes(pdfAnalysis?.mode)){f.set('pdf_mode','scan');f.set('pdf_pages',String(pdfAnalysis.totalPages));}}else f.set('text',$('#source-input').value);const genre=$('#genre').value;e.currentTarget.disabled=true;try{if(genre!==state.stories.find(s=>s.id===sid)?.genre){await api(`/stories/${sid}`,{method:'PATCH',body:{genre}});const story=state.stories.find(s=>s.id===sid);if(story)story.genre=genre;}const j=await api('/jobs',{method:'POST',body:f});state.selected=j.id;if(['scan','hybrid'].includes(pdfAnalysis?.mode)){
  const {uploadPreparedPdf}=await import('./pdf-client.js');let localOcr=null,localOcrPages=0,fallback='',told=false;
  // Same on-device OCR (0 token) used by the student workspace: skip Gemini for pages a local pass
  // can already read confidently. Math/formula-heavy pages stay low-confidence and still go to Gemini.
  // When Tesseract reads in place of PaddleOCR, the progress line says why once, then names Tesseract on each page.
  try{
   await uploadPreparedPdf(sourceFile,pdfAnalysis,async(item,page,total)=>{
    const pageForm=new FormData();pageForm.set('page',String(page));pageForm.set('total',String(total));
    if(item.kind==='text'){pageForm.set('text',item.text);await api(`/jobs/${j.id}/pdf-page`,{method:'POST',body:pageForm});return;}
    if(!localOcr){const [engine,policy]=await Promise.all([import('./local-ocr.js'),import('./ocr-policy.js')]);localOcr={...engine,...policy};}
    const assessment=await localOcr.recognizeChinesePage(item.blob);fallback||=assessment.fallbackReason||'';
    if(localOcr.shouldUseGeminiOcr('hybrid',assessment))pageForm.set('image',item.blob,`page-${page}.${item.blob.type==='image/webp'?'webp':'jpg'}`);
    else{pageForm.set('text',assessment.text);localOcrPages++;}
    await api(`/jobs/${j.id}/pdf-page`,{method:'POST',body:pageForm});
   },(page,total,kind)=>{const notice=kind==='scan'&&fallback&&!told?localOcr.fallbackNotice(fallback):'';told||=Boolean(notice);toast(`Đang chuẩn bị PDF · ${page}/${total} trang · ${kind!=='scan'?'lớp chữ':notice?`kiểm tra OCR cục bộ. ${notice}`:`kiểm tra OCR cục bộ${fallback?' bằng Tesseract':''}`}`);});
   if(localOcrPages)toast(`Đã nhận dạng cục bộ ${localOcrPages} trang${fallback?' bằng Tesseract':''} (0 token Gemini); các trang còn lại sẽ OCR bằng Gemini khi dịch.`);
  }finally{if(localOcr)await localOcr.terminateLocalOcr().catch(()=>{});}
 }state.file=null;state.pdfAnalysis=null;await refresh();go('review');if(prepareOnly)await prepareJob(j.id);else if(state.status.aiConfigured)await runJob(j.id);else toast('Đã lưu tài liệu. Cấu hình khóa Gemini trong máy chủ để bắt đầu dịch.');}finally{if($('#start-translate'))$('#start-translate').disabled=false;}}

async function prepareJob(jid){busy=true;try{let result;do{result=await api(`/jobs/${jid}/prepare`,{method:'POST'});state.jobs=state.jobs.map(j=>j.id===jid?{...j,...result}:j);render();}while(token&&result.status==='splitting');if(result.status==='prepared')toast('Đã chia xong PDF. Bấm Bắt đầu dịch khi sẵn sàng.');}finally{busy=false;await refresh();render();}}
async function showPdfParts(){const data=await api(`/jobs/${state.selected}/parts`);modal(`<h2>Các phần PDF</h2><p class="subtitle">${data.totalPages?`${data.totalPages} trang · ${data.parts.length} phần đã chia · ${data.pagesPerPart} trang/phần`:'PDF chưa được chia. Bấm Bắt đầu dịch để tự động chia trước.'}</p><p class="subtitle">Các phần sẽ được dịch và ghép theo thứ tự trang, giữ chung ngữ cảnh và bảng tên.</p><ol class="pdf-parts">${data.parts.map(p=>`<li>Phần ${p.index+1} <span>Trang ${p.startPage}–${p.endPage}</span></li>`).join('')}</ol>`,async()=>{});}
async function downloadBook(){await adminDownload(`/jobs/${encodeURIComponent(state.selected)}/book`,(state.jobs.find(j=>j.id===state.selected)?.story_title||'ban-dich')+'.txt','Không tải được bản dịch');}
// Admin downloads (a request's file, a job's original, full source or joined translation): a refusal, a server error or
// a lost connection is said in the toast, like any other failure (callers go through on() or catch it).
async function adminDownload(path,name,failure){
 const response=await fetch('/api'+path,{headers:{Authorization:`Bearer ${token}`}}).catch(()=>{throw new Error('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.');});
 if(!response.ok){const data=await response.json().catch(()=>null);throw new Error(data?.error||`${failure} (mã ${response.status}).`);}
 const blob=await response.blob().catch(()=>{throw new Error(`${failure}: kết nối bị ngắt giữa chừng. Hãy thử lại.`);}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function bindAdminContent(){
 on('#import-chapter','click',()=>importChapter());
 document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>importChapter(b.dataset.import));
 document.querySelectorAll('[data-chapters]').forEach(b=>b.onclick=()=>showChapters(b.dataset.chapters).catch(e=>toast(e.message)));
 document.querySelectorAll('[data-rename-story]').forEach(b=>b.onclick=()=>renameStory(b.dataset.renameStory));
 for(const [kind,field,collection,label,details] of [['job','deleteJob',state.jobs,'tài liệu','Bản gốc, phần PDF đã chia, bản dịch và phần đã công bố từ tài liệu này sẽ bị xóa.'],['story','deleteStory',adminStories(),'hồ sơ tài liệu','Toàn bộ các phần, bản gốc, bản dịch và ảnh bìa của tài liệu sẽ bị xóa khỏi thư viện.'],['request','deleteRequest',state.requests,'yêu cầu','Yêu cầu của người học sẽ bị xóa.']]){
  document.querySelectorAll(`[data-delete-${kind}]`).forEach(b=>b.onclick=()=>{const item=collection.find(x=>x.id===b.dataset[field]);confirmDelete(kind,item?.id,item?.title||item?.filename||label,details);});
 }
}
function confirmDelete(kind,id,title,details){
 if(!id)return;const endpoints={job:'jobs',story:'stories',request:'requests',chapter:'chapters'};
 modal(`<h2>Xóa ${esc(title)}?</h2><p class="subtitle">${esc(details)} Thao tác này không thể hoàn tác.</p><label class="confirm-check"><input type="checkbox" required> Tôi xác nhận xóa nội dung này.</label>`,async()=>{await api(`/${endpoints[kind]}/${id}`,{method:'DELETE'});if(kind==='job'&&state.selected===id)state.selected=null;if(kind==='story'){state.selected=null;if(state.storyId===id)state.storyId='';}await refresh();render();toast('Đã xóa.');});
}
async function showChapters(sid){
 const chapters=await api(`/stories/${sid}/chapters`);
 modal(`<h2>Các phần đã công bố</h2><p class="subtitle">${chapters.length} phần · sắp xếp theo thứ tự tài liệu</p><div class="chapter-admin-list">${chapters.map((c,index)=>`<div><span class="chapter-admin-number">${String(index+1).padStart(2,'0')}</span><span class="chapter-admin-title"><strong>${esc(c.title)}</strong><small>${c.mime==='application/pdf'?'PDF':'Văn bản'}</small></span><button type="button" class="danger" data-delete-chapter="${c.id}">Xóa phần</button></div>`).join('')||'<p class="empty">Chưa có phần nào. Dùng “Tải bản đã dịch lên” để thêm nội dung.</p>'}</div>`,async()=>{});
 document.querySelectorAll('[data-delete-chapter]').forEach(b=>b.onclick=()=>{const chapter=chapters.find(c=>c.id===b.dataset.deleteChapter);confirmDelete('chapter',chapter.id,chapter.title,'Phần tài liệu sẽ được gỡ khỏi thư viện. Bản dịch trong xưởng (nếu có) vẫn được giữ để đăng lại.');});
}
function renameStory(sid){
 const story=adminStory(sid);if(!story)return;
 modal(`<h2>Đổi tên tài liệu</h2><p class="subtitle">Tên mới sẽ được cập nhật trong quản trị, bản dịch và thư viện học liệu.</p><label>Tên tài liệu<input name="title" value="${esc(story.title)}" required minlength="1" maxlength="200" autocomplete="off"></label>`,async form=>{const title=String(form.get('title')||'').trim();await api(`/stories/${sid}`,{method:'PATCH',body:{title}});await refresh();render();toast('Đã đổi tên tài liệu.');},'Lưu tên mới');
 setTimeout(()=>$('#modal input[name="title"]')?.select());
}

function importChapter(sid){
 if(!state.stories.length){toast('Hãy tạo hồ sơ tài liệu trước khi tải bản đã dịch lên.');createStory();return;}
 modal(`<h2>Tải bản đã dịch lên thư viện</h2><p class="subtitle">Đăng bản tiếng Việt đã được đối chiếu để người học đọc ngay. TXT / DOCX hiển thị thành văn bản; PDF mở trong khung đọc.</p><label>Hồ sơ tài liệu<select name="story_id">${state.stories.map(s=>`<option value="${s.id}" ${s.id===sid?'selected':''}>${esc(s.title)}</option>`).join('')}</select></label><label>Tên phần / mục<input name="title" required maxlength="200"></label><label>Tệp bản đọc<input id="publication-file" name="file" type="file" accept=".txt,.docx,.pdf" required><small>Tối đa 25 MB. TXT dùng UTF-8; văn bản tối đa 500.000 ký tự.</small></label><p id="import-status" class="subtitle">Chọn tệp để xem trước.</p><label id="publication-text-label" class="hide">Nội dung (có thể biên tập)<textarea name="content" id="publication-text" rows="9"></textarea></label><iframe id="publication-pdf" class="reader-pdf hide" title="Xem trước PDF"></iframe><label class="confirm-check"><input name="confirmed" value="true" type="checkbox" required> Tôi đã đối chiếu nội dung và đồng ý công bố cho người học.</label>`,async form=>{if(!ready)throw new Error('Hãy đợi xem trước tài liệu hoàn tất.');await api(`/stories/${form.get('story_id')}/chapters`,{method:'POST',body:form});await refresh();render();toast('Đã công bố trong thư viện học liệu.');});
 let ready=false,sequence=0,previewUrl;
 $('#modal').addEventListener('close',()=>{sequence++;if(previewUrl)URL.revokeObjectURL(previewUrl);},{once:true});
 on('#publication-file','change',async e=>{
  ready=false;const current=++sequence,file=e.target.files[0];$('#publication-text-label').classList.add('hide');$('#publication-pdf').classList.add('hide');$('#publication-text').value='';if(previewUrl)URL.revokeObjectURL(previewUrl);if(!file)return;
  $('#import-status').textContent='Đang đọc tệp để xem trước…';const form=new FormData();form.set('file',file);
  try{const data=await api('/import-preview',{method:'POST',body:form});if(current!==sequence)return;
   if(data.mime==='application/pdf'){previewUrl=URL.createObjectURL(file);$('#publication-pdf').src=previewUrl;$('#publication-pdf').classList.remove('hide');}
   else{$('#publication-text').value=data.content;$('#publication-text-label').classList.remove('hide');}
   $('#import-status').textContent='Đã đọc tệp. Kiểm tra nội dung trước khi đăng.';ready=true;
  }catch(error){if(current===sequence)$('#import-status').textContent='Không đọc được tệp: '+error.message;}
 });
}

function changeReaderFont(delta){state.fontSize=Math.max(16,Math.min(30,state.fontSize+delta));try{localStorage.setItem('readerFontSize',String(state.fontSize));}catch{}const prose=$('.prose');if(prose)prose.style.fontSize=state.fontSize+'px';const value=$('.font-value');if(value)value.textContent=state.fontSize;$('#font-smaller').disabled=state.fontSize<=16;$('#font-larger').disabled=state.fontSize>=30;}

function normalizeLibraryText(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().trim();}
function filterLibrary(){
 const counter=$('#library-result-count');if(!counter)return;
 const query=normalizeLibraryText(state.libraryQuery);let count=0;
 document.querySelectorAll('[data-library-index]').forEach(card=>{const book=state.library[Number(card.dataset.libraryIndex)];const matches=(!state.libraryGenre||book.genre===state.libraryGenre)&&normalizeLibraryText(`${book.title} ${book.author||''}${isSample(book)?` ${SAMPLE_LABEL}`:''}`).includes(query);card.hidden=!matches;if(matches)count++;});
 document.querySelectorAll('[data-library-genre]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.libraryGenre===(state.libraryGenre||''))));
 counter.textContent=state.loaded?`${count} / ${state.library.length} tài liệu`:'Đang tải thư viện…';
 $('#library-no-results').hidden=count>0||state.library.length===0;
}

function homeAtmosphere(){return `<div class="home-atmosphere" aria-hidden="true">${Array.from({length:7},(_,i)=>`<svg class="drifting-leaf" style="--leaf:${i};left:${8+i*14}%" viewBox="0 0 60 24"><path d="M2 21Q18-8 58 3Q39 30 2 21Z" fill="currentColor"/><path d="M3 21 54 5" stroke="#edf0df" stroke-width=".8"/></svg>`).join('')}<div class="mist mist-one"></div><div class="mist mist-two"></div></div>`;}


