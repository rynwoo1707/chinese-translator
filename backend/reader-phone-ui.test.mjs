import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import pdfLibrary from './pdf.cjs';
import {PDFJS_FILES,vendoredPdfjs} from './pdfjs-vendor.mjs';

// The reader and the pages around it on a phone, in Edge with the real app: index.html and every script and stylesheet
// from frontend/ under the CSP of frontend/_headers, /api answered here, pdf.js as backend/vendor.mjs writes it. The first
// screen shows reading text, a new part starts at its heading, a reload comes back to the same place, the last book
// tapped is the one that opens, and long titles never widen the page. Skipped when Microsoft Edge is missing.
const root=new URL('../',import.meta.url),frontend=new URL('frontend/',root),ORIGIN='http://hoatri.test';
const read=name=>readFileSync(new URL(name,frontend),'utf8');
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(read('_headers'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
const PDFJS=Object.fromEntries(PDFJS_FILES.map(([from,to])=>[`/${to.replace(/^frontend\//u,'')}`,vendoredPdfjs(readFileSync(new URL(from,root),'utf8'))]));
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());

// api(path) -> [status, json] | {pdf: bytes} | {wait: ms, answer} | undefined.
async function openApp(path,{width=390,height=844,api=()=>undefined}={}){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce',locale:'vi-VN'}),page=await context.newPage(),errors=[],reads={};
 page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname.startsWith('/api/')){
   const book=/^\/api\/read\/([^/]+)$/u.exec(url.pathname)?.[1];if(book)reads[book]=(reads[book]||0)+1;
   let answer=api(url.pathname);if(answer?.wait){await new Promise(done=>setTimeout(done,answer.wait));answer=answer.answer;}
   if(answer?.pdf)return route.fulfill({status:200,headers:{'Content-Type':'application/pdf'},body:answer.pdf});
   answer??=[200,url.pathname==='/api/me'?{authenticated:false,googleConfigured:false,registration:{mode:'open',domains:[]}}:url.pathname==='/api/status'?{authenticated:true}:[]];
   return route.fulfill({status:answer[0],contentType:'application/json',body:JSON.stringify(answer[1])}).catch(()=>{});
  }
  if(PDFJS[url.pathname])return route.fulfill({status:200,headers:{'Content-Type':'text/javascript'},body:PDFJS[url.pathname]});
  const file=['/','/admin'].includes(url.pathname)?'index.html':url.pathname.slice(1),source=new URL(file,frontend);
  if(!file.includes('..')&&existsSync(source))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(source)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors,reads,sideways:()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)};
}
const LIBRARY=[{id:'book-su-ky',title:'Sử ký',author:'Tư Mã Thiên',genre:'Lịch sử Trung Hoa',chapters:2,visibility:'public'},{id:'book-luan-ngu',title:'Luận ngữ',genre:'Triết học',chapters:1,visibility:'public'}];
const LONG=Array.from({length:40},(_,i)=>`Đoạn ${i+1}: Tần Thủy Hoàng đi tuần khắp các quận, cho khắc đá ghi công ở nhiều nơi, sửa đường sá, đắp đê và đặt quan cai trị mới cho từng vùng đất vừa thu về.`).join('\n\n');
const PARTS=[{id:'c1',title:'Bản kỷ',mime:'text/plain',content:LONG},{id:'c2',title:'Thế gia',mime:'text/plain',content:'Khổng Tử nói: Học rồi đem ra luyện tập.\n\n'+LONG}];
const readerApi=path=>path==='/api/library'?[200,LIBRARY]:path==='/api/read/book-su-ky'?[200,PARTS]:path==='/api/read/book-luan-ngu'?[200,[{id:'l1',title:'Học nhi',mime:'text/plain',content:'Một chương ngắn.'}]]:undefined;
// Where a run of text sits on the screen.
const textTop=(page,text)=>page.evaluate(wanted=>{const prose=document.querySelector('.reader .prose'),walker=document.createTreeWalker(prose,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const at=node.nodeValue.indexOf(wanted);if(at>=0){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+1);return range.getBoundingClientRect().top;}}return null;},text);

test('Reader on a phone: the first screen shows reading text; the toolbar is one row and its options open on demand; the header scrolls away',{skip,timeout:120000},async()=>{
 for(const [width,height] of [[360,740],[390,844]]){
  const {context,page,errors,sideways}=await openApp('/#reader/book-su-ky/1',{width,height,api:readerApi});
  try{
   await page.waitForSelector('.reader .prose');
   const screen=await page.evaluate(()=>{
    const toolbar=document.querySelector('.reader-toolbar'),controls=[...toolbar.querySelectorAll('button,select')].filter(element=>element.offsetParent);
    return {toolbar:Math.round(toolbar.getBoundingClientRect().height),rows:new Set(controls.map(element=>Math.round(element.getBoundingClientRect().top))).size,controls:controls.map(element=>element.id||element.className.split(' ')[0])};
   });
   assert.ok(screen.toolbar<=64,`${width}: toolbar ${screen.toolbar} px`);assert.equal(screen.rows,1,`${width}: ${screen.controls}`);
   assert.deepEqual(screen.controls,['reader-back','reader-share','reader-chapter-select','reader-more-toggle'],'library, share, part and "Tùy chọn"');
   const first=await textTop(page,'Đoạn 1'),line=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.reader .prose')).lineHeight));
   assert.ok(first<height*.6,`${width}: the first line at ${Math.round(first)} px`);assert.ok((height-first)/line>=9,`${width}: ${Math.floor((height-first)/line)} lines of text on the first screen`);
   // Page colour, font size, listening and Chinese lookup: one tap away.
   assert.equal(await page.isVisible('[data-reader-theme="night"]'),false);
   await page.click('#reader-more-toggle');assert.equal(await page.getAttribute('#reader-more-toggle','aria-expanded'),'true');
   for(const selector of ['[data-reader-theme="night"]','#hanzi-open','#font-larger','#speak'])assert.equal(await page.isVisible(selector),true,selector);
   await page.click('[data-reader-theme="night"]');assert.match(await page.getAttribute('.reader','class'),/\bnight\b/u);
   assert.equal(await page.getAttribute('#reader-more-toggle','aria-expanded'),'true','the options stay open while used');
   await page.click('#reader-more-toggle');assert.equal(await page.isVisible('[data-reader-theme="night"]'),false);
   // While reading, the header scrolls away instead of covering the top of the screen.
   await page.evaluate(()=>scrollTo(0,900));
   assert.ok(await page.evaluate(()=>document.querySelector('.site-masthead').getBoundingClientRect().bottom)<=0,'the header is off screen');
   assert.equal(await sideways(),0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 // A wide screen keeps every control in view and the header in place.
 const {context,page}=await openApp('/#reader/book-su-ky/1',{width:1280,height:800,api:readerApi});
 try{
  await page.waitForSelector('.reader .prose');
  assert.equal(await page.isVisible('#reader-more-toggle'),false);assert.equal(await page.isVisible('[data-reader-theme="night"]'),true);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.site-masthead')).position),'sticky');
 }finally{await context.close();}
});

test('A new part starts at its heading, not at the top of the page above the toolbar',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openApp('/#reader/book-su-ky/1',{api:readerApi});
 try{
  await page.waitForSelector('.reader .prose');await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  await page.click('#next-chapter');await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Thế gia');
  const heading=await page.evaluate(()=>Math.round(document.querySelector('.reader h1').getBoundingClientRect().top));
  assert.ok(heading>=0&&heading<=140,`the heading at ${heading} px`);assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A reload (or a phone that discarded the tab) opens the part at the place the reader left: text and drawn PDF pages',{skip,timeout:120000},async()=>{
 let {context,page,errors}=await openApp('/#reader/book-su-ky/1',{api:readerApi});
 try{
  await page.waitForSelector('.reader .prose');
  await page.evaluate(async()=>{const prose=document.querySelector('.reader .prose'),walker=document.createTreeWalker(prose,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const at=node.nodeValue.indexOf('Đoạn 23:');if(at>=0){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+1);scrollBy(0,range.getBoundingClientRect().top-30);break;}}});
  await page.waitForTimeout(600);
  const before=await textTop(page,'Đoạn 23:');
  // A larger font after the reload must not move the place: the character at the top is kept, not the scroll offset.
  await page.evaluate(()=>localStorage.setItem('readerFontSize','24'));
  await page.reload();await page.waitForSelector('.reader .prose');await page.waitForTimeout(300);
  const after=await textTop(page,'Đoạn 23:');
  assert.ok(Math.abs(after-before)<=40,`before ${Math.round(before)} px, after ${Math.round(after)} px`);
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1','the heading has the focus, without scrolling to it');
  assert.equal(await page.evaluate(()=>location.hash),'#reader/book-su-ky/1');assert.deepEqual(errors,[]);
  // Another part, or a part opened from the library, starts at its top.
  await page.evaluate(()=>{location.hash='#reader/book-su-ky/2';});await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Thế gia');
  assert.ok(await page.evaluate(()=>document.querySelector('.reader h1').getBoundingClientRect().top)>=0);
 }finally{await context.close();}
 // Drawn PDF pages on a phone: the page in view, and how far into it.
 const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);
 for(let number=1;number<=6;number++)doc.addPage([420,595]).drawText(`Ban dich trang ${number}`,{x:40,y:520,size:24,font});
 const pdf=Buffer.from(await doc.save()),pdfApi=path=>path==='/api/library'?[200,[{id:'pdf-book',title:'Hàm số',genre:'Toán học · STEM',chapters:1,visibility:'public'}]]:path==='/api/read/pdf-book'?[200,[{id:'p1',title:'Trang 1–6',mime:'application/pdf'}]]:path==='/api/chapter-file/p1'?{pdf}:undefined;
 ({context,page,errors}=await openApp('/#reader/pdf-book/1',{api:pdfApi}));
 try{
  await page.waitForFunction(()=>document.querySelectorAll('.pdf-pages-page').length===6,null,{timeout:30000});
  await page.evaluate(()=>{const third=document.querySelector('.pdf-pages-page[data-page="4"]');scrollBy(0,third.getBoundingClientRect().top+third.getBoundingClientRect().height/3);});
  await page.waitForTimeout(600);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.pdf-pages-page').length===6,null,{timeout:30000});await page.waitForTimeout(300);
  const box=await page.evaluate(()=>{const page=document.querySelector('.pdf-pages-page[data-page="4"]').getBoundingClientRect();return {top:page.top,height:page.height};});
  assert.ok(box.top<0&&box.top>-box.height*.6,`page 4 at ${Math.round(box.top)} px of ${Math.round(box.height)}`);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Opening a book: the tapped book says "Đang mở…" while its parts download, and the book tapped last is the one that opens',{skip,timeout:60000},async()=>{
 const slow={wait:1500,answer:[200,[{id:'a1',title:'Phần A1',mime:'text/plain',content:'A1'},{id:'a2',title:'Phần A2',mime:'text/plain',content:'A2'},{id:'a3',title:'Phần A3',mime:'text/plain',content:'A3'}]]},fast={wait:100,answer:[200,[{id:'b1',title:'Phần B1',mime:'text/plain',content:'Nội dung B.'}]]};
 const library=[{id:'book-a',title:'Sách A',genre:'Lịch sử Trung Hoa',chapters:3,visibility:'public'},{id:'book-b',title:'Sách B',genre:'Triết học',chapters:1,visibility:'public'}];
 const {context,page,errors}=await openApp('/',{api:path=>path==='/api/library'?[200,library]:path==='/api/read/book-a'?slow:path==='/api/read/book-b'?fast:undefined});
 try{
  await page.waitForSelector('.book-actions [data-read="book-a"]');
  await page.click('.book-actions [data-read="book-a"]');
  assert.deepEqual(await page.$eval('.book-actions [data-read="book-a"]',button=>({text:button.textContent.trim(),disabled:button.disabled,busy:button.getAttribute('aria-busy')})),{text:'Đang mở…',disabled:true,busy:'true'});
  await page.click('.book-actions [data-read="book-b"]');
  assert.equal(await page.$eval('.book-actions [data-read="book-a"]',button=>button.disabled),false,'only the book tapped last waits');
  await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Phần B1');
  await page.waitForTimeout(1800);
  assert.deepEqual(await page.evaluate(()=>({title:document.querySelector('.reader h1')?.textContent,hash:location.hash,modal:document.querySelector('#modal').open})),{title:'Phần B1',hash:'#reader/book-b/1',modal:false},'the earlier answer is dropped');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

const LONG_TITLE='Tuyển_tập_nghiên_cứu_lịch_sử_Trung_Hoa_thời_Tần_Hán_bản_scan_chất_lượng_cao_năm_2026.pdf';
test('Long titles without spaces wrap instead of widening a phone page: reader, library, account, admin',{skip,timeout:120000},async()=>{
 const user={id:'u1',name:'Nguyễn_Thị_Phương_Thảo_lớp_11A2_trường_THPT_chuyên_Lê_Hồng_Phong',email:'phuongthao.nguyen.lop11a2.truong.thpt.chuyen@example.edu.vn',provider:'local'};
 const api=path=>path==='/api/library'?[200,[{id:'long',title:LONG_TITLE,author:LONG_TITLE,genre:'Lịch sử Trung Hoa',chapters:1,visibility:'public'}]]:path==='/api/read/long'?[200,[{id:'l1',title:LONG_TITLE,mime:'text/plain',content:`${LONG_TITLE}\n\nNội dung.`}]]:path==='/api/me'?[200,{authenticated:true,googleConfigured:false,registration:{mode:'open',domains:[]},user}]:path==='/api/stories'?[200,[{id:'s1',title:LONG_TITLE,author:'',genre:'Lịch sử Trung Hoa',owner_user_id:null,visibility:'public',chapters:1,glossary:'{}'}]]:path==='/api/jobs'?[200,[{id:'j1',story_id:'s1',filename:LONG_TITLE,status:'review',story_title:LONG_TITLE,created_at:'2026-10-20',has_translation:1,warning_count:0}]]:path==='/api/jobs/j1'?[200,{id:'j1',story_id:'s1',filename:LONG_TITLE,status:'review',story_title:LONG_TITLE,source:'原文',translation:'Bản dịch.',warnings:'[]'}]:undefined;
 for(const width of [360,390]){
  for(const [path,ready] of [['/#reader/long/1','.reader .prose'],['/','.cover-book'],['/#account','#reader-logout'],['/admin#stories','.story-card']]){
   const {context,page,errors,sideways}=await openApp(path,{width,api});
   try{await page.waitForSelector(ready);assert.equal(await sideways(),0,`${width} ${path}`);assert.deepEqual(errors,[]);}finally{await context.close();}
  }
  // The admin's job view, reached as the admin does: a book, then its part.
  const {context,page,sideways}=await openApp('/admin#review',{width,api});
  try{
   await page.click('[data-review-story="s1"]');await page.click('[data-job="j1"]');await page.waitForSelector('#edit-translation');
   await page.waitForFunction(()=>document.querySelector('#edit-translation').value==='Bản dịch.');
   assert.equal(await sideways(),0,`${width} admin job view`);
  }finally{await context.close();}
 }
});
