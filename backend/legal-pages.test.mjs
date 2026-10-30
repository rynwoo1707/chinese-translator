import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {footerHtml,SOURCE_URL,SERVICE_SOURCE_URL} from '../frontend/site-footer.js';
import {placeholderFiles,PLACEHOLDER} from './deploy.mjs';
import {TERMS_VERSION} from './reader-auth.js';

const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root),'utf8');
const pages={terms:read('frontend/dieu-khoan.html'),privacy:read('frontend/quyen-rieng-tu.html')};
const text=html=>html.replace(/<script[\s\S]*?<\/script>/gu,'').replace(/<[^>]+>/gu,' ').replace(/&amp;/gu,'&').replace(/\s+/gu,' ');
// The operator fills exactly these before launch; npm run deploy refuses while one is left.
const BLANKS=new Set(['tên người hoặc tổ chức vận hành','email liên hệ','ngày hiệu lực','nhà cung cấp và quốc gia đặt máy chủ dịch vụ PDF']);

test('Legal pages: Vietnamese, titled, self-contained links and anchors, no inline script',()=>{
 for(const [name,html] of Object.entries(pages)){
  assert.match(html,/^<!doctype html>\s*<html lang="vi">/u,name);assert.match(html,/<title>Hoa Trí — (Điều khoản sử dụng|Quyền riêng tư)<\/title>/u,name);
  assert.equal(html,html.normalize('NFC'),`${name} is NFC`);
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/u,`${name}: scripts come from files (CSP script-src 'self')`);assert.doesNotMatch(html,/\son[a-z]+=/u,`${name}: no inline handlers`);
  const ids=[...html.matchAll(/\sid="([^"]+)"/gu)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length,`${name}: unique ids`);
  for(const [,target] of html.matchAll(/href="#([^"]+)"/gu))assert.ok(ids.includes(target),`${name}: #${target} exists`);
  for(const [,page,anchor] of html.matchAll(/href="\/(dieu-khoan|quyen-rieng-tu)(?:#([^"]+))?"/gu)){assert.ok(existsSync(new URL(`frontend/${page}.html`,root)),page);if(anchor)assert.match(page==='dieu-khoan'?pages.terms:pages.privacy,new RegExp(`id="${anchor}"`,'u'),`${page}#${anchor}`);}
  assert.match(html,/<footer class="site-footer" data-site-footer>[\s\S]*?<\/footer>\s*<script type="module" src="\/site-footer\.js"><\/script>/u,`${name}: footer filled by site-footer.js, with a static fallback`);
  assert.match(html,new RegExp(`Phiên bản ${TERMS_VERSION}`,'u'),`${name} names the terms version accounts accept`);
 }
});

// Before launch the four blanks are there; once the operator fills them (deploy refuses until then) none is, and the
// test still passes, so it never stands between a filled-in page and npm run deploy.
test('Legal pages: only the four operator blanks are left to fill, only in the two pages, and deploy sees each one left',()=>{
 const found=new Set(Object.values(pages).flatMap(html=>[...html.matchAll(/\[\[CHƯA ĐIỀN: ([^\]]+)\]\]/gu)].map(match=>match[1])));
 for(const blank of found)assert.ok(BLANKS.has(blank),`unknown blank “${blank}”`);
 for(const html of Object.values(pages))assert.equal(html.includes(PLACEHOLDER),/\[\[CHƯA ĐIỀN: [^\]]+\]\]/u.test(html),'every placeholder is a whole blank');
 const blocked=placeholderFiles();for(const [page,html] of [['frontend/dieu-khoan.html',pages.terms],['frontend/quyen-rieng-tu.html',pages.privacy]])assert.equal(blocked.includes(page),html.includes(PLACEHOLDER),page);
 for(const file of ['frontend/app.js','frontend/site-footer.js','frontend/library-samples.js','frontend/bilingual-reader.js','frontend/index.html'])assert.ok(!blocked.includes(file),`${file} must not hold a blank`);
});

test('Privacy page states what the code really stores',()=>{
 const privacy=text(pages.privacy),auth=read('backend/reader-auth.js'),history=read('backend/study-history.js');
 const iterations=Number(/PBKDF2_ITERATIONS=(\d+)/u.exec(auth)[1]);assert.match(privacy,new RegExp(`PBKDF2-SHA256 \\(${iterations.toLocaleString('vi-VN')} vòng, chuỗi muối ngẫu nhiên 16 byte\\)`,'u'));
 assert.match(auth,/salt=crypto\.getRandomValues\(new Uint8Array\(16\)\)/u);
 const days=/(?:maxAge|SESSION_MAX_AGE)=(\d+)\*24\*60\*60/u.exec(auth)[1];assert.match(privacy,new RegExp(`hết hạn sau ${days} ngày`,'u'));
 for(const name of ['SESSION_COOKIE','STATE_COOKIE','RETURN_COOKIE','DEVICE_COOKIE'])assert.ok(privacy.includes(new RegExp(`const ${name}='([^']+)'`,'u').exec(auth)[1]),name);
 assert.match(auth,/cookie\(STATE_COOKIE,state,600,url\)/u);assert.match(privacy,/tự hết hạn sau 10 phút/u);
 assert.match(auth,/SHA-?256|hashToken/u);assert.match(privacy,/chỉ lưu mã băm SHA-256 của cookie/u);
 // The admin's session (admin-auth.js): a session cookie, gone when the browser closes, and a session the server ends
 // after SESSION_SECONDS, or IDLE_MS unused.
 const admin=read('backend/admin-auth.js'),hours=Number(/SESSION_SECONDS=(\d+)\*60\*60/u.exec(admin)[1]),idle=Number(/IDLE_MS=(\d+)\*60\*60\*1000/u.exec(admin)[1]);
 assert.match(privacy,new RegExp(`cookie cat_hien_admin [^.]*giữ phiên đăng nhập trang quản trị\\. Đây là cookie phiên: trình duyệt xóa nó khi đóng lại[^.]*sau tối đa ${hours} giờ, hoặc sớm hơn nếu ${idle} giờ không dùng\\.`,'u'));
 const preview=Number(/PREVIEW=(\d+)/u.exec(history)[1]);assert.match(privacy,new RegExp(`${preview.toLocaleString('vi-VN')} ký tự đầu`,'u'));
 const chapter=Number(/content=state\.translation\.slice\(0,(\d+)\)/u.exec(history)[1]);assert.match(privacy,new RegExp(`${chapter.toLocaleString('vi-VN')} ký tự đầu của mỗi phần`,'u'));
 // Every key the pages keep in localStorage or sessionStorage is named, and nothing named is gone from the code. study.js
 // and whole-book.js reach it through a variable (browserStorage, storage); a key built as PREFIX+id is listed as "PREFIX…".
 const keys=new Set();
 for(const file of ['app.js','music.js','hanzi-lookup.js','study.js','whole-book.js','bilingual-reader.js','library-samples.js','site-footer.js','site-header.js']){
  const source=existsSync(new URL(`frontend/${file}`,root))?read(`frontend/${file}`):'';
  const constant=name=>new RegExp(`\\b${name}=(['"])([^'"]+)\\1`,'u').exec(source)?.[2];
  for(const [,raw] of source.matchAll(/\b(?:localStorage|sessionStorage|browserStorage|storage)\??\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/gu)){
   const argument=raw.trim(),literal=/^(['"])(.+)\1$/u.exec(argument),prefix=/^(\w+)\+/u.exec(argument);
   keys.add(literal?literal[2]:prefix?constant(prefix[1])&&`${constant(prefix[1])}…`:constant(argument));
  }
 }
 assert.ok(!keys.has(undefined),'every localStorage key resolves to a name');
 assert.ok(keys.has('hoa-tri-runner')&&keys.has('hoa-tri-book-usage:…'),[...keys].join(', '));
 const listed=new Set([...pages.privacy.matchAll(/<code>([\w.:…-]+)<\/code>/gu)].map(match=>match[1]).filter(name=>!/^cat_hien_/u.test(name)));
 assert.deepEqual([...keys].sort(),[...listed].sort());
 // Fonts: while a page or stylesheet still loads Google Fonts, the page names Google Fonts as a third party; once none
 // does, it says the fonts come from Hoa Trí itself, and the pages that state it link the self-hosted fonts.
 const sources=['frontend/style.css','frontend/study.css','frontend/index.html','frontend/study.html','frontend/dieu-khoan.html','frontend/quyen-rieng-tu.html','frontend/404.html'].map(read).join('\n');
 const google=/fonts\.(?:googleapis|gstatic)\.com/u.test(sources);
 assert.equal(/<strong>Google Fonts:<\/strong>/u.test(pages.privacy),google,'Google Fonts is listed as a third party exactly while it is loaded');
 assert.equal(/Phông chữ của trang \(Be Vietnam Pro, Noto Serif\) do chính máy chủ Hoa Trí cung cấp/u.test(privacy),!google,'self-hosted fonts are stated exactly while nothing loads Google Fonts');
 for(const page of ['index.html','dieu-khoan.html','quyen-rieng-tu.html','404.html'])assert.match(read(`frontend/${page}`),/<link rel="stylesheet" href="\/fonts\/fonts\.css">/u,page);
 // The Gemini key: the page promises it is never stored; no browser storage call may mention it.
 assert.match(privacy,/Khóa Gemini của bạn\. Khóa chỉ nằm trong bộ nhớ của tab đang mở/u);assert.doesNotMatch(read('frontend/study.js'),/(?:localStorage|sessionStorage)[^;]*apiKey/u);
 assert.match(privacy,/Không quảng cáo, không công cụ phân tích/u);assert.match(privacy,/18 tuổi/u);
 // Error reports (browser-check.js → POST /api/client-error): how many, how long and what, as the page and the server
 // do it; kept only in the server's log.
 const beacon=read('frontend/browser-check.js'),[,reports,characters]=/MAX_REPORTS=(\d+),MESSAGE_MAX=(\d+)/u.exec(beacon)||[];
 assert.match(beacon,/navigator\.sendBeacon\('\/api\/client-error',JSON\.stringify\(body\)\)/u);assert.match(beacon,/page:location\.pathname\.slice/u);
 assert.match(read('backend/client-error.js'),new RegExp(`message:${characters},`,'u'),'the server keeps what the page sends');
 assert.match(privacy,new RegExp(`tối đa ${reports} báo lỗi mỗi lần mở trang: nội dung lỗi \\(tối đa ${characters} ký tự\\), tệp mã của Hoa Trí cùng dòng gây lỗi, đường dẫn của trang \\(không kèm phần sau dấu \\? hay #`,'u'));
 assert.match(privacy,/Báo lỗi không được lưu vào cơ sở dữ liệu: máy chủ chỉ ghi nó vào nhật ký kỹ thuật trên Cloudflare/u);assert.match(privacy,/Nhật ký của Cloudflare, gồm cả báo lỗi của trang: tối đa 7 ngày/u);
});

// Every daily cap the server applies (rate-limit.js {daily,…,label}), with what it counts per: an account or an address.
const backendSources=readdirSync(new URL('backend/',root)).filter(name=>name.endsWith('.js')).map(name=>read(`backend/${name}`));
const dailyCaps=()=>backendSources.flatMap(source=>[...source.matchAll(/daily:`([\w-]+):\$\{([^}]+)\}`[^}]*?label:'([^']+)'/gu)].map(([,key,per,label])=>({key,per,label})));
// "a, b, c và d lên" -> the caps a page names, each in the words of its own message ("… lượt <label> hôm nay").
const named=list=>[...new Set(list.split(/, | và /u).map(item=>item.trim().replace(/ lên$/u,'')))].sort();

test('Terms page limits match the server',()=>{
 const terms=text(pages.terms),layout=read('backend/pdf-layout.js'),translation=read('backend/study-translation.js'),http=read('backend/http.js'),wholeBook=read('frontend/whole-book.js'),worker=read('backend/worker.js'),library=read('backend/library-books.js');
 // A file sent to the server: 25 MB (the PDF a layout extract posts, a request's file, an admin upload); the original kept
 // for "Dịch cả quyển" and a library book's original: 100 MB, streamed to storage.
 const upload=Number(/\|\|file\.size>(\d+)\*1024\*1024\)throw new \w*Error\('PDF giữ bố cục tối đa \1 MB/u.exec(layout)?.[1]),source=Number(/export const SOURCE_MAX=(\d+)\*MB;/u.exec(http)?.[1]);
 assert.equal(upload,25);assert.match(worker,new RegExp(`file\\.size>${upload}\\*1024\\*1024\\)throw new Error\\('Tệp yêu cầu tối đa ${upload} MB\\.'\\)`,'u'));
 assert.match(wholeBook,new RegExp(`SOURCE_MAX_BYTES=${source}\\*1024\\*1024`,'u'));assert.match(library,new RegExp(`MAX_SOURCE=${source}\\*1024\\*1024`,'u'));
 assert.match(layout,new RegExp(`maxBytes:${upload}\\*1024\\*1024,maxPages:20`,'u'));
 assert.match(terms,new RegExp(`mỗi tệp gửi lên máy chủ tối đa ${upload} MB, riêng bản PDF gốc lưu lại để Dịch cả quyển tối đa ${source} MB; mỗi lượt tách PDF giữ bố cục tối đa 20 trang`,'u'));
 // Every daily cap is named in the words of its own message ("Bạn đã dùng hết … lượt <label> hôm nay").
 const caps=dailyCaps();assert.ok(caps.length>=4,JSON.stringify(caps));
 const sentence=/Việc ([^.]+) có hạn mức mỗi ngày, đặt lại lúc 0:00 giờ Việt Nam\./u.exec(terms)?.[1]||'';
 assert.deepEqual(named(sentence),[...new Set(caps.map(cap=>cap.label))].sort(),'Terms §6 names every daily cap of the server, and no other');
 assert.match(translation,/source\.length>8000/u);assert.match(terms,/mỗi lượt dịch văn bản tối đa 8\.000 ký tự/u);
 assert.match(translation,/MAX_STUDY_CHARACTERS=2_000_000\b/u);assert.match(translation,/text\.length>MAX_STUDY_CHARACTERS\b/u);assert.match(terms,/tối đa 2 triệu ký tự/u);
 assert.match(read('backend/rate-limit.js'),/0:00 \(giờ Việt Nam\)/u);assert.match(terms,/đặt lại lúc 0:00 giờ Việt Nam/u);
 for(const name of ['PyMuPDF','GNU AGPL-3.0','pdf.js','CC-CEDICT','CVDICT','hanviet-pinyin-wordlist','Unihan','CC BY-SA 4.0','Tesseract','PaddleOCR'])assert.ok(terms.includes(name),name);
 assert.ok(pages.terms.includes(SOURCE_URL),'source link for the AGPL service');
});

test('Privacy page: what the PDF service receives and the daily counts kept per account match the code',()=>{
 const privacy=text(pages.privacy),layout=read('backend/pdf-layout.js'),study=read('frontend/study.js'),wholeBook=read('frontend/whole-book.js');
 // Range mode posts the whole selected file with its page list, and the Worker forwards that file to the service.
 assert.match(study,/form\.set\('file',selectedFile\);form\.set\('pages',range\)/u);assert.match(layout,/service\(env,'extract',null,\{file,pages:String\(form\.get\('pages'\)/u);
 // A whole-book run cuts each chunk on the device, at most CHUNK_PAGES pages; a refresh sends the pages kept from before.
 const chunk=Number(/CHUNK_PAGES=(\d+)/u.exec(wholeBook)?.[1]);assert.match(wholeBook,/export async function cutChunk\(/u);assert.match(layout,/env\.FILES\.get\(assetKey\(reader,assetId,'original\.pdf'\)\)/u);assert.match(layout,/service\(env,'extract',null,\{stream:jsonStream\(\{pages:`1-\$\{priorPages\.length\}`,quality,known\},'pdfBase64',base64Value\(original\.body\)\)/u);
 assert.match(layout,/service\(env,'render',null,\{stream:jsonStream\(\{translations,title\},'document',stored\.body\)\}\)/u);
 assert.match(privacy,new RegExp(`Để tách chữ, dịch vụ nhận tệp PDF bạn tải lên \\(cả tệp, tối đa 25 MB, kèm danh sách trang cần tách\\); khi Dịch cả quyển, dịch vụ chỉ nhận từng phần tối đa ${chunk} trang được cắt sẵn trên thiết bị của bạn; khi cập nhật bố cục, dịch vụ nhận lại các trang đã tách trước đó, kèm vị trí các đoạn đã đọc \\(và chữ gốc của các đoạn lấy từ lớp chữ của PDF\\) để giữ lại các đoạn đã dịch\\. Để dựng bản PDF tiếng Việt, dịch vụ nhận ảnh trang, vị trí và chữ của các đoạn đã tách cùng bản dịch\\.`,'u'));
 assert.doesNotMatch(privacy,/nhận các trang PDF bạn chọn/u);
 // Counts kept per account (keyed by its id) are named; the per-IP one is the registration count described above them.
 const counted=/<li>Số lượt ([^<]+) của mỗi tài khoản trong ngày, để áp dụng hạn mức\.<\/li>/u.exec(pages.privacy)?.[1]||'',caps=dailyCaps();
 assert.deepEqual(named(counted),[...new Set(caps.filter(cap=>/\.id$/u.test(cap.per)).map(cap=>cap.label))].sort(),'Privacy names every count kept per account, and no other');
 for(const cap of caps.filter(cap=>!/\.id$/u.test(cap.per)))assert.equal(cap.key,'register',`${cap.key}: the only count not per account is registration, per network address`);
 assert.match(privacy,/Hoa Trí đếm số tài khoản được tạo từ mỗi địa chỉ IP trong ngày/u);
});

test('Site footer: one line of legal links, contact, source code and licences; the attribution lives in terms §12 and the Tra chữ Hán panel',()=>{
 const html=footerHtml();
 for(const href of ['/dieu-khoan','/quyen-rieng-tu','/quyen-rieng-tu#lien-he','/dieu-khoan#giay-phep',SOURCE_URL])assert.ok(html.includes(`href="${href}"`),href);
 assert.match(SOURCE_URL,/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[\w./-]+[\w-]$/u,'the deployed branch or tag, not the default branch');
 assert.equal(SERVICE_SOURCE_URL,`${SOURCE_URL}/services/pdf-layout`);
 assert.doesNotMatch(html,/<script|\son[a-z]+=/u);
 // A page read without JavaScript shows the same footer.
 for(const page of ['frontend/404.html','frontend/dieu-khoan.html','frontend/quyen-rieng-tu.html'])assert.ok(read(page).includes(`<footer class="site-footer" data-site-footer>${html}</footer>`),page);
 // "Giấy phép" opens what CC BY-SA 4.0 asks for (§3(a) allows a link to it): who made the data, its licence and that it
 // was changed, with the source of the AGPL service; the Tra chữ Hán panel credits the data where it shows.
 const licences=/<section id="giay-phep"[\s\S]*?<\/section>/u.exec(pages.terms)?.[0]||'';
 for(const words of ['CC-CEDICT','MDBG','CVDICT','Phong Phan','hanviet-pinyin-wordlist','Unihan','Unicode, Inc.','PyMuPDF','GNU AGPL-3.0','đã chuyển đổi'])assert.ok(licences.includes(words),words);
 for(const href of ['https://creativecommons.org/licenses/by-sa/4.0/deed.vi',SOURCE_URL,SERVICE_SOURCE_URL])assert.ok(licences.includes(`href="${href}"`),href);
 const panel=read('frontend/hanzi-lookup.js');
 for(const words of ['CC-CEDICT (MDBG)','CVDICT (Phong Phan)','CC BY-SA 4.0','hanviet-pinyin-wordlist','Unicode, Inc.'])assert.ok(panel.includes(words),words);
});

// The footer's music switch (music.js), run with a stand-in button: its icon is drawn and hidden from screen readers, so
// its words alone name it (a font glyph such as ♫ or Ⅱ is missing from the site font and is read aloud).
test('Music switch: words beside a hidden drawn icon, no glyph; pressing keeps the id and flips aria-pressed',()=>{
 const button={setAttribute(name,value){this[name]=value;}};
 const context=vm.createContext({localStorage:{getItem:()=>null,setItem(){}},document:{addEventListener(){},querySelector:selector=>selector==='#music-toggle'?button:null},Audio:class{addEventListener(){}play(){return Promise.resolve();}pause(){}}});
 vm.runInContext(read('frontend/music.js').replace(/^export /gmu,''),context);
 const label=words=>new RegExp(`^<svg [^>]*aria-hidden="true"[^>]*>(?:<path [^>]*/>)+</svg><span>${words}</span>$`,'u');
 const markup=context.musicMarkup(),inner=/^<div class="background-music" role="group" aria-label="Nhạc nền"><button id="music-toggle" type="button" aria-pressed="false">(.*)<\/button><\/div>$/u.exec(markup)?.[1];
 assert.match(inner||'',label('Bật nhạc nền'),markup);
 context.bindMusic(()=>{});button.onclick();
 assert.equal(button['aria-pressed'],'true');assert.match(button.innerHTML,label('Dừng nhạc'));
 const pressed=button.innerHTML;button.onclick();
 assert.equal(button['aria-pressed'],'false');assert.equal(button.innerHTML,inner);
 for(const html of [markup,pressed])assert.doesNotMatch(html.replace(/<[^>]+>/gu,''),/[\p{So}\p{Nl}]/u,html);
});

test('Homepage head and robots.txt',()=>{
 const index=read('frontend/index.html'),robots=read('frontend/robots.txt');
 for(const pattern of [/<html lang="vi">/u,/<meta name="description" content="[^"]{40,}">/u,/<meta property="og:title" content="Hoa Trí — [^"]+">/u,/<meta property="og:description" content="[^"]+">/u,/<meta property="og:locale" content="vi_VN">/u,/<meta property="og:type" content="website">/u,/<meta name="theme-color" content="#[0-9a-f]{6}">/u])assert.match(index,pattern);
 assert.match(index,/<noscript>[\s\S]*?Hoa Trí cần bật JavaScript[\s\S]*href="\/dieu-khoan"[\s\S]*href="\/quyen-rieng-tu"[\s\S]*<\/noscript>/u);
 assert.match(robots,/^User-agent: \*$/mu);assert.match(robots,/^Disallow: \/api\/$/mu);assert.match(robots,/^Disallow: \/admin$/mu);assert.doesNotMatch(robots,/^Disallow: \/$/mu);
 // The library's own data stays crawlable, so a crawler renders the home page as a reader sees it.
 for(const path of ['/api/library','/api/me'])assert.match(robots,new RegExp(`^Allow: ${path}$`,'mu'),path);
 // The Worker turns the relative line into an absolute URL on the request's origin (backend/site-pages.js).
 assert.match(robots,/^Sitemap: \/sitemap\.xml$/mu);
});

test('Legal pages: header with the two sections, the request link and sign-in; links use /study',()=>{
 for(const [name,html] of Object.entries(pages)){
  const header=/<header class="site-masthead">[\s\S]*?<\/header>/u.exec(html)?.[0]||'';
  assert.match(header,/<a href="\/">[\s\S]*?<span>Học liệu<\/span><\/a>/u,name);assert.match(header,/<a href="\/study">[\s\S]*?Xưởng dịch/u,name);
  assert.match(header,/<a class="header-request" href="\/#yeu-cau">[\s\S]*?Yêu cầu dịch/u,name);assert.match(header,/<a class="header-login" href="\/#account">Đăng nhập<\/a>/u,name);
  assert.doesNotMatch(html,/study\.html/u,`${name}: /study, never /study.html (a redirect)`);
  assert.match(html,/<script type="module" src="\/site-header\.js"><\/script>/u,name);
 }
 // Sample books are local-only unless the owner publishes one: the terms never claim the library has them.
 assert.match(text(pages.terms),/Nếu Thư viện có sách gắn nhãn “Ví dụ mẫu”/u);assert.doesNotMatch(text(pages.terms),/Sách có nhãn “Ví dụ mẫu” trong Thư viện là/u);
});

// One constant says where the deployed code is published (site-footer.js SOURCE_URL): every link to the repository on the
// pages is that address or its services/pdf-layout folder, so moving to another branch or tag is one line.
test('Every link to the source code is SOURCE_URL (the deployed branch), or its services/pdf-layout folder',()=>{
 for(const page of ['frontend/dieu-khoan.html','frontend/quyen-rieng-tu.html','frontend/404.html','frontend/index.html']){
  for(const [,href] of read(page).matchAll(/href="(https:\/\/github\.com\/[^"]*)"/gu))assert.ok([SOURCE_URL,SERVICE_SOURCE_URL].includes(href),`${page}: ${href}`);
 }
 const terms=pages.terms;
 assert.match(terms,new RegExp(`<a href="${SOURCE_URL}" rel="noopener" data-source-link="repo">`,'u'),'§12 links the deployed branch and follows SOURCE_URL');
 assert.match(terms,new RegExp(`<a href="${SERVICE_SOURCE_URL}" rel="noopener" data-source-link="service"><code>services/pdf-layout</code></a>`,'u'));
 for(const [,kind] of terms.matchAll(/data-source-link="([^"]*)"/gu))assert.ok(['repo','service'].includes(kind),kind);
 // site-footer.js sets these links from the constant when the page runs it.
 assert.match(read('frontend/site-footer.js'),/a\[data-source-link\]/u);
});
