import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// The home page, deep links and reader chrome of app.js, run as in app-ui.test.mjs (imports stripped and given, a fake
// fetch answering per URL), with history, matchMedia and document.title the way a browser has them.
const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
const settle=()=>new Promise(done=>setTimeout(done,20));
function app({pathname='/',hash='',search='',answers=()=>null,compact=false}={}){
 const root={innerHTML:''},calls=[],pushed=[];
 const location={pathname,hash,search,origin:'https://hoatri.test'};
 const history={pushState(state,title,url){pushed.push(['push',url]);apply(url);},replaceState(state,title,url){pushed.push(['replace',url]);apply(url);}};
 function apply(url){const parsed=new URL(url,'https://hoatri.test');location.pathname=parsed.pathname;location.search=parsed.search;location.hash=parsed.hash;}
 const toast={textContent:'',style:{}},modal={open:false,innerHTML:'',close(){this.open=false;},showModal(){this.open=true;},addEventListener(){}};
 const document={title:'',querySelector:selector=>({'#app':root,'#toast':toast,'#modal':modal})[selector]||null,querySelectorAll:()=>[]};
 const context=vm.createContext({musicMarkup:()=>'<div class="background-music">♫</div>',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},mountPdfPages(){return {destroy(){}};},releaseBilingual(){},
  location,history,document,matchMedia:query=>({matches:compact&&/max-width: 768px/u.test(query),addEventListener(){}}),localStorage:{getItem:()=>null},window:{addEventListener(){}},setTimeout,clearTimeout,clearInterval,FormData,console});
 context.fetch=async url=>{calls.push(url);const [status,body]=answers(url)||[200,url==='/api/me'?{authenticated:false}:url.startsWith('/api/my/')?{error:'Hãy đăng nhập.'}:[]];return {ok:status<300,status:url.startsWith('/api/my/')&&!answers(url)?401:status,json:async()=>body};};
 vm.runInContext(source,context);
 return {root,calls,pushed,location,document,run:code=>vm.runInContext(code,context)};
}
const library=[{id:'b1',title:'Sử ký',author:'Tư Mã Thiên',genre:'Lịch sử Trung Hoa',chapters:2,sample:0},{id:'b2',title:'Toán 11',genre:'Toán học · STEM',chapters:0,sample:0}];

test('Home: says what Hoa Trí does, for whom, with the two actions and the trust line; cards show their titles',async()=>{
 const {root,document,calls}=app({answers:url=>url==='/api/library'?[200,library]:null});await settle();
 const html=root.innerHTML;
 assert.equal(document.title,'Hoa Trí — Dịch tiếng Trung sang tiếng Việt, giữ bố cục trang');
 assert.match(html,/<p class="eyebrow">DÀNH CHO HỌC SINH VÀ GIÁO VIÊN<\/p>/u);
 assert.match(html,/<h1 id="home-title">Dịch tài liệu tiếng Trung sang tiếng Việt, giữ nguyên bố cục trang<\/h1>/u);
 assert.match(html,/pinyin, âm Hán Việt và nghĩa/u);assert.match(html,/khóa Gemini của chính mình/u);
 assert.match(html,/<a class="hero-cta hero-cta-primary" href="\/study">Dịch tài liệu của tôi <span aria-hidden="true">→<\/span><\/a><a class="hero-cta" href="#thu-vien" id="show-library">Xem thư viện<\/a>/u);
 assert.match(html,/Không quảng cáo, không theo dõi/u);assert.match(html,/Mã nguồn mở/u);
 assert.doesNotMatch(html,/sử liệu, cổ văn|đã được đối chiếu|giáo viên đã duyệt/u,'no claim that the library is reviewed');
 assert.doesNotMatch(html,/study\.html/u,'workspace links use /study');assert.match(html,/<a href="\/study">/u);
 // Title visible under every cover; a ready book's cover opens it, a book without parts has no button.
 assert.match(html,/<h3 class="book-title" id="book-title-0">Sử ký<\/h3>/u);assert.match(html,/<h3 class="book-title" id="book-title-1">Toán 11<\/h3>/u);
 assert.match(html,/<button type="button" class="cover-trigger" data-read="b1" data-read-cover="b1" aria-label="Mở tài liệu Sử ký">/u);
 assert.doesNotMatch(html,/aria-expanded/u,'the cover opens the book, it expands nothing');
 assert.equal((html.match(/data-read="b2"/gu)||[]).length,0);
 // The music switch is in the footer; a skip link leads to the main content.
 assert.match(html,/<footer class="site-footer" data-site-footer>[\s\S]*<div class="background-music">♫<\/div><\/footer>/u);
 assert.match(html,/^<div class="public-shell"><a class="skip-link" href="#noi-dung">Bỏ qua, đến nội dung chính<\/a>/u);assert.match(html,/<main class="public-content[^"]*" id="noi-dung" tabindex="-1">/u);
 // Signed out, nothing personal is asked for (no 401 in the console).
 assert.deepEqual(calls,['/api/library','/api/me']);
});

test('Home: an empty library points to the workspace; a failed library is an error card with "Thử lại", never an empty shelf',async()=>{
 const empty=app({answers:url=>url==='/api/library'?[200,[]]:null});await settle();
 assert.match(empty.root.innerHTML,/Thư viện chung đang được bổ sung\. Trong lúc chờ, hãy tự dịch tài liệu của bạn ở Xưởng dịch\.<\/p><a class="hero-cta hero-cta-primary" href="\/study">/u);
 const failed=app({answers:url=>url==='/api/library'?[500,{error:'Máy chủ gặp lỗi ngoài dự kiến.'}]:null});await settle();
 const html=failed.root.innerHTML;
 assert.match(html,/<div class="panel load-error" role="alert"><h2>Chưa tải được thư viện<\/h2><p>Máy chủ gặp lỗi ngoài dự kiến\.<\/p>/u);
 assert.match(html,/<button type="button" class="primary" data-retry="library">Thử lại<\/button>/u);
 assert.doesNotMatch(html,/đang được bổ sung|cover-library/u);
 // Signed in, a personal list that failed is kept apart from the ones that loaded.
 const partly=app({answers:url=>url==='/api/me'?[200,{authenticated:true,user:{id:'u',name:'Lan'}}]:url==='/api/my/library'?[503,{error:'Bận.'}]:url==='/api/my/requests'?[200,[{id:'r'}]]:null});await settle();
 assert.equal(partly.run('state.errors.myLibrary.status'),503);assert.equal(partly.run('state.myRequests.length'),1);assert.equal(partly.run('state.reader.authenticated'),true);
 assert.deepEqual(partly.calls,['/api/library','/api/me','/api/my/library','/api/my/requests'],'the personal lists follow a confirmed session');
 // A page that already knows the session asks for everything at once on the next refresh.
 partly.calls.length=0;partly.run('refresh()');assert.deepEqual(partly.calls,['/api/my/library','/api/my/requests','/api/library','/api/me']);
});

test('Deep links: #reader/<id>/<part> and /?read=<id>&phan=<n> open that part, keep it in the address and name it in the title',async()=>{
 const chapters=[{id:'c1',title:'Phần mở đầu',mime:'text/plain',content:'Một.'},{id:'c2',title:'Thống nhất',mime:'text/plain',content:'Hai 秦始皇.'}];
 const answers=url=>url==='/api/library'?[200,library]:url==='/api/read/b1'?[200,chapters]:null;
 const reload=app({hash:'#reader/b1/2',answers});
 assert.match(reload.root.innerHTML,/role="status" aria-label="Đang mở tài liệu"/u,'a loading state, not "choose a book"');
 await settle();
 assert.equal(reload.run('state.route'),'reader');assert.equal(reload.run('state.chapter'),1);assert.equal(reload.location.hash,'#reader/b1/2');
 assert.equal(reload.document.title,'Phần 2 · Sử ký — Hoa Trí');
 const reader=reload.root.innerHTML;
 assert.match(reader,/<div class="reader-toolbar" role="toolbar" aria-label="Công cụ đọc tài liệu">/u);
 assert.match(reader,/<h1 tabindex="-1">Thống nhất<\/h1>/u);assert.match(reader,/<p class="reader-book-title">Sử ký<\/p>/u);
 assert.match(reader,/id="reader-share"[^>]*>[\s\S]*?<span>Chia sẻ<\/span>/u,'a public book can be shared');
 const shared=app({search:'?read=b1&phan=2',answers});await settle();
 assert.equal(shared.location.search,'');assert.equal(shared.location.hash,'#reader/b1/2');assert.equal(shared.run('state.chapter'),1);
 assert.equal(shared.run('pageTitle()'),'Phần 2 · Sử ký — Hoa Trí');
 // A one-part book needs no picker; an unknown book is an error card in the reader.
 const one=app({search:'?read=b1',answers:url=>url==='/api/library'?[200,library]:url==='/api/read/b1'?[200,chapters.slice(0,1)]:null});await settle();
 assert.equal(one.run('state.route'),'reader');assert.equal(one.location.hash,'#reader/b1/1');
 // Its heading is the page's h1 and the title says so; signed out, it offers to sign in and come back to this part
 // (/api/read answers 404, not 401, for a private book).
 const missing=app({hash:'#reader/nope/1',answers:url=>url==='/api/read/nope'?[404,{error:'Không tìm thấy tài liệu.'}]:null});await settle();
 assert.match(missing.root.innerHTML,/<h1>Chưa mở được tài liệu này<\/h1><p>Không tìm thấy tài liệu\.<\/p><p>Nếu đây là tài liệu trong Thư viện riêng của bạn, hãy đăng nhập để mở\.<\/p><div class="button-row"><a class="load-error-link" href="\/#account\?sau=reader\/nope\/1">Đăng nhập<\/a><button type="button" class="primary" data-retry="reader">/u);
 assert.equal(missing.document.title,'Không mở được tài liệu — Hoa Trí');assert.equal(missing.run('state.focusAfterRender'),null,'the heading took the focus');
 const mine=app({hash:'#reader/nope/1',answers:url=>url==='/api/read/nope'?[404,{error:'Không tìm thấy tài liệu.'}]:url==='/api/me'?[200,{authenticated:true,user:{id:'u1',name:'Lan',email:'lan@example.test'}}]:null});await settle();
 assert.doesNotMatch(mine.root.innerHTML,/load-error-link|Thư viện riêng của bạn/u,'signed in, there is nothing to sign in to');
 assert.equal(app({}).run('pageTitle()'),'Hoa Trí — Dịch tiếng Trung sang tiếng Việt, giữ bố cục trang');
 assert.equal(app({hash:'#account'}).run('pageTitle()'),'Tài khoản — Hoa Trí');
});

test('Reader: footnotes expose their note, a private book has no share button, phones get drawn PDF pages',()=>{
 const {run}=app({compact:true});
 const text=run(`state.route='reader';state.library=[];state.readerStory={id:'mine',title:'Sách riêng'};state.chapters=[{id:'t',title:'Một',mime:'text/plain',content:'Câu có chú thích [1].\\n\\n[1] Ghi chú một.\\n[2] Hai.\\n[3] Ba.'}];state.chapter=0;readerView()`);
 assert.match(text,/<button type="button" class="footnote-ref" data-note="Ghi chú một\." aria-label="Chú thích 1" aria-expanded="false" aria-describedby="note-1">\[1\]<\/button>/u);
 assert.match(text,/<li id="note-1">/u);assert.doesNotMatch(text,/reader-share/u,'only a public book has a link others can open');
 const pdf=run(`state.chapters=[{id:'p',title:'Trang 1–4',mime:'application/pdf'}];readerView()`);
 assert.match(pdf,/<div class="pdf-pages-root" id="pdf-pages-root"><\/div>/u);assert.doesNotMatch(pdf,/<iframe/u);assert.match(pdf,/Mở PDF trong tab mới ↗/u);
});

test('#yeu-cau: the request dialog opens on load, after sign-in when the student is signed out',async()=>{
 const out=app({hash:'#yeu-cau'});await settle();
 assert.equal(out.run('state.route'),'account');assert.equal(out.run('state.pendingRequest'),true);
 out.run(`state.reader={authenticated:true,user:{id:'u',name:'Lan'}};let opened=0;requestStory=()=>{opened++;};render();globalThis.__opened=opened`);
 assert.equal(out.run('__opened'),1,'signing in opens the dialog');assert.equal(out.run('state.pendingRequest'),false);
});
