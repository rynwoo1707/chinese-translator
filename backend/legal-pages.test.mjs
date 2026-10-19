import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {footerHtml,SOURCE_URL} from '../frontend/site-footer.js';
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
 const days=/maxAge=(\d+)\*24\*60\*60/u.exec(auth)[1];assert.match(privacy,new RegExp(`hết hạn sau ${days} ngày`,'u'));
 for(const name of ['SESSION_COOKIE','STATE_COOKIE','RETURN_COOKIE'])assert.ok(privacy.includes(new RegExp(`const ${name}='([^']+)'`,'u').exec(auth)[1]),name);
 assert.match(auth,/cookie\(STATE_COOKIE,state,600,url\)/u);assert.match(privacy,/tự hết hạn sau 10 phút/u);
 assert.match(auth,/SHA-?256|hashToken/u);assert.match(privacy,/chỉ lưu mã băm SHA-256 của cookie/u);
 const preview=Number(/PREVIEW=(\d+)/u.exec(history)[1]);assert.match(privacy,new RegExp(`${preview.toLocaleString('vi-VN')} ký tự đầu`,'u'));
 const chapter=Number(/content=state\.translation\.slice\(0,(\d+)\)/u.exec(history)[1]);assert.match(privacy,new RegExp(`${chapter.toLocaleString('vi-VN')} ký tự đầu của mỗi phần`,'u'));
 // Every key the pages keep in localStorage is named, and nothing named is gone from the code.
 const keys=new Set();
 for(const file of ['app.js','music.js','hanzi-lookup.js','study.js','bilingual-reader.js','library-samples.js','site-footer.js']){
  const source=existsSync(new URL(`frontend/${file}`,root))?read(`frontend/${file}`):'';
  for(const [,argument] of source.matchAll(/localStorage\??\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/gu)){const literal=/^(['"])(.+)\1$/u.exec(argument.trim());keys.add(literal?literal[2]:new RegExp(`\\b${argument.trim()}=(['"])([^'"]+)\\1`,'u').exec(source)?.[2]);}
 }
 assert.ok(!keys.has(undefined),'every localStorage key resolves to a name');
 const listed=new Set([...pages.privacy.matchAll(/<code>([a-zA-Z.]+)<\/code>/gu)].map(match=>match[1]).filter(name=>!/^cat_hien_/u.test(name)));
 assert.deepEqual([...keys].sort(),[...listed].sort());
 // Google Fonts is named exactly while a stylesheet still loads it.
 const fonts=/fonts\.googleapis\.com/u.test(read('frontend/style.css')+read('frontend/study.css'));assert.equal(/Google Fonts/u.test(privacy),fonts);
 // The Gemini key: the page promises it is never stored; no browser storage call may mention it.
 assert.match(privacy,/Khóa Gemini của bạn\. Khóa chỉ nằm trong bộ nhớ của tab đang mở/u);assert.doesNotMatch(read('frontend/study.js'),/(?:localStorage|sessionStorage)[^;]*apiKey/u);
 assert.match(privacy,/Không quảng cáo, không công cụ phân tích/u);assert.match(privacy,/18 tuổi/u);
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
 assert.match(translation,/text\.length>2_000_000/u);assert.match(terms,/tối đa 2 triệu ký tự/u);
 assert.match(read('backend/rate-limit.js'),/0:00 \(giờ Việt Nam\)/u);assert.match(terms,/đặt lại lúc 0:00 giờ Việt Nam/u);
 for(const name of ['PyMuPDF','GNU AGPL-3.0','pdf.js','CC-CEDICT','CVDICT','hanviet-pinyin-wordlist','Unihan','CC BY-SA 4.0','Tesseract','PaddleOCR'])assert.ok(terms.includes(name),name);
 assert.ok(pages.terms.includes(SOURCE_URL),'source link for the AGPL service');
});

test('Privacy page: what the PDF service receives and the daily counts kept per account match the code',()=>{
 const privacy=text(pages.privacy),layout=read('backend/pdf-layout.js'),study=read('frontend/study.js'),wholeBook=read('frontend/whole-book.js');
 // Range mode posts the whole selected file with its page list, and the Worker forwards that file to the service.
 assert.match(study,/form\.set\('file',selectedFile\);form\.set\('pages',range\)/u);assert.match(layout,/service\(env,'extract',null,\{file,pages:String\(form\.get\('pages'\)/u);
 // A whole-book run cuts each chunk on the device, at most CHUNK_PAGES pages; a refresh sends the pages kept from before.
 const chunk=Number(/CHUNK_PAGES=(\d+)/u.exec(wholeBook)?.[1]);assert.match(wholeBook,/export async function cutChunk\(/u);assert.match(layout,/'selected-pages\.pdf'/u);
 assert.match(layout,/service\(env,'render',\{document,translations\b/u);
 assert.match(privacy,new RegExp(`Để tách chữ, dịch vụ nhận tệp PDF bạn tải lên \\(cả tệp, tối đa 25 MB, kèm danh sách trang cần tách\\); khi Dịch cả quyển, dịch vụ chỉ nhận từng phần tối đa ${chunk} trang được cắt sẵn trên thiết bị của bạn; khi cập nhật bố cục, dịch vụ nhận lại các trang đã tách trước đó\\. Để dựng bản PDF tiếng Việt, dịch vụ nhận ảnh trang, vị trí và chữ của các đoạn đã tách cùng bản dịch\\.`,'u'));
 assert.doesNotMatch(privacy,/nhận các trang PDF bạn chọn/u);
 // Counts kept per account (keyed by its id) are named; the per-IP one is the registration count described above them.
 const counted=/<li>Số lượt ([^<]+) của mỗi tài khoản trong ngày, để áp dụng hạn mức\.<\/li>/u.exec(pages.privacy)?.[1]||'',caps=dailyCaps();
 assert.deepEqual(named(counted),[...new Set(caps.filter(cap=>/\.id$/u.test(cap.per)).map(cap=>cap.label))].sort(),'Privacy names every count kept per account, and no other');
 for(const cap of caps.filter(cap=>!/\.id$/u.test(cap.per)))assert.equal(cap.key,'register',`${cap.key}: the only count not per account is registration, per network address`);
 assert.match(privacy,/Hoa Trí đếm số tài khoản được tạo từ mỗi địa chỉ IP trong ngày/u);
});

test('Site footer: legal links, source code, dictionary attribution and the AGPL notice',()=>{
 const html=footerHtml();
 for(const href of ['/dieu-khoan','/quyen-rieng-tu','/quyen-rieng-tu#lien-he','/dieu-khoan#giay-phep',SOURCE_URL,'https://creativecommons.org/licenses/by-sa/4.0/deed.vi'])assert.ok(html.includes(`href="${href}"`),href);
 for(const words of ['CC-CEDICT (MDBG)','CVDICT (Phong Phan)','CC BY-SA 4.0','hanviet-pinyin-wordlist (MIT)','Unicode, Inc.','PyMuPDF','GNU AGPL-3.0','services/pdf-layout'])assert.ok(html.includes(words),words);
 assert.match(SOURCE_URL,/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u);
 assert.doesNotMatch(html,/<script|\son[a-z]+=/u);
});

test('Homepage head and robots.txt',()=>{
 const index=read('frontend/index.html'),robots=read('frontend/robots.txt');
 for(const pattern of [/<html lang="vi">/u,/<meta name="description" content="[^"]{40,}">/u,/<meta property="og:title" content="Hoa Trí — [^"]+">/u,/<meta property="og:description" content="[^"]+">/u,/<meta property="og:locale" content="vi_VN">/u,/<meta property="og:type" content="website">/u,/<meta name="theme-color" content="#[0-9a-f]{6}">/u])assert.match(index,pattern);
 assert.match(index,/<noscript>[\s\S]*?Hoa Trí cần bật JavaScript[\s\S]*href="\/dieu-khoan"[\s\S]*href="\/quyen-rieng-tu"[\s\S]*<\/noscript>/u);
 assert.match(robots,/^User-agent: \*$/mu);assert.match(robots,/^Disallow: \/api\/$/mu);assert.match(robots,/^Disallow: \/admin$/mu);assert.doesNotMatch(robots,/^Disallow: \/$/mu);
});
