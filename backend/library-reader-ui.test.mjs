import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import pdfLibrary from './pdf.cjs';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

// The library and reader in a real browser engine with the real stylesheets: a closed glossary popover is really gone,
// library cards can be opened on a phone, and a PDF part is drawn as pages there. Pages are served from memory and the
// repo, every other request is aborted. Skipped when Microsoft Edge (or the vendored pdf.js, for the PDF test) is missing.
const frontend=new URL('../frontend/',import.meta.url),ORIGIN='http://hoatri.test';
const read=name=>readFileSync(new URL(name,frontend),'utf8');
const css=read('style.css')+read('header.css');
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
const pdfSkip=skip||(existsSync(new URL('vendor/pdf.mjs',frontend))?false:'frontend/vendor/pdf.mjs is missing (npm run prepare:vendor)');
test.after(()=>browser?.close());
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};

async function open(width,body,{files={},touch=width<500}={}){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`});
  if(files[url.pathname])return route.fulfill({contentType:'application/pdf',body:files[url.pathname]});
  const path=new URL(`.${url.pathname}`,frontend);
  if(/^\/(reader-terms\.js|bilingual-reader\.js|vendor\/)/u.test(url.pathname)&&existsSync(path))return route.fulfill({contentType:TYPES[url.pathname.match(/\.[a-z]+$/u)?.[0]]||'application/octet-stream',body:readFileSync(path)});
  return route.fulfill({status:404,contentType:'application/json',body:'{"error":"Không tìm thấy."}'});
 });
 await page.goto(ORIGIN+'/');
 return {context,page,errors};
}

for(const width of [390,1440])test(`Glossary popover at ${width} px: closed by Escape or an outside tap, it is not drawn and blocks nothing`,{skip},async()=>{
 const {context,page,errors}=await open(width,'<div class="public-shell"><main class="public-content read-mode"><article class="reader paper"><div class="prose">Trong không gian, vectơ là một đoạn thẳng có hướng. Đoạn sau dài hơn để có chỗ chạm ra ngoài.</div></article></main></div>');
 await page.evaluate(async()=>{const {termMatcher,highlightTerms,bindTermPopover}=await import('/reader-terms.js');const prose=document.querySelector('.prose');highlightTerms(prose,termMatcher([{vi:'vectơ',zh:['向量']}]));bindTermPopover(prose);});
 const state=()=>page.$eval('#term-popover',popover=>{const box=popover.getBoundingClientRect();return {hidden:popover.hidden,display:getComputedStyle(popover).display,width:box.width,height:box.height};});
 const term=page.locator('.prose .term');
 await term.click();let shown=await state();
 assert.equal(shown.hidden,false);assert.equal(shown.display,'grid');assert.ok(shown.width>0&&shown.height>0);
 const center=await page.$eval('#term-popover',popover=>{const box=popover.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};});
 await page.keyboard.press('Escape');shown=await state();
 assert.deepEqual(shown,{hidden:true,display:'none',width:0,height:0},'Escape: nothing drawn');
 assert.equal(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('#term-popover')),center),false,'Escape: the old box takes no taps');
 assert.equal(await term.getAttribute('aria-expanded'),'false');
 await term.click();assert.equal((await state()).display,'grid');
 await page.mouse.click(5,5);shown=await state();
 assert.equal(shown.display,'none','an outside tap closes it');
 assert.equal(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('#term-popover')),center),false);
 assert.deepEqual(errors,[]);
 await context.close();
});

// The library page as app.js draws it (run as in library-home.test.mjs), inside the real stylesheet.
function libraryMarkup(){
 const source=read('app.js').replace(/^import .*\r?\n/gmu,''),root={innerHTML:''};
 const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover(){},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){},mountPdfPages(){},releaseBilingual(){},location:{pathname:'/',hash:'',search:''},document:{querySelector:selector=>selector==='#app'?root:null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},window:{addEventListener(){}},fetch:async()=>({ok:true,status:200,json:async()=>[]}),setTimeout,clearTimeout,clearInterval,FormData,console});
 vm.runInContext(source,context);
 return vm.runInContext(`state.loaded=true;state.route='library';state.library=[{id:'a',title:'Toán THPT (bản A) – Tự chọn bắt buộc, quyển 1',author:'Nhà xuất bản Giáo dục',genre:'Toán học · STEM',chapters:1,sample:1,translated_pages:3},{id:'b',title:'Sử ký',genre:'Lịch sử Trung Hoa',chapters:2}];publicLayout()`,context);
}
for(const width of [390,1440])test(`Library cards at ${width} px: the title and "Mở tài liệu" are visible and can be tapped without hovering`,{skip},async()=>{
 const {context,page,errors}=await open(width,libraryMarkup());
 const cards=await page.$$eval('.cover-book',cards=>cards.map(card=>{
  const title=card.querySelector('.book-title'),action=card.querySelector('.book-actions .primary'),author=card.querySelector('.book-author');
  action.scrollIntoView({block:'center'});const box=action.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
  return {title:title.getBoundingClientRect().height>0&&getComputedStyle(title).visibility==='visible',actionHeight:Math.round(box.height),hit:hit?.closest('button')===action,author:getComputedStyle(author.closest('.book-reveal')).opacity,cover:card.querySelector('.cover-trigger').getAttribute('aria-label')};
 }));
 for(const card of cards){
  assert.equal(card.title,true,'title visible');assert.ok(card.actionHeight>=44,'a 44 px action');assert.equal(card.hit,true,'the action takes the tap');
  assert.match(card.cover,/^Mở tài liệu /u);
 }
 // A phone shows the details under the title; a mouse reveals them over the cover on hover.
 assert.equal(cards[0].author,width<500?'1':'0');
 if(width>=500){await page.hover('.cover-book .cover-frame');await page.waitForFunction(()=>getComputedStyle(document.querySelector('.book-reveal')).opacity==='1');}
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
});

test('PDF part on a phone: every page drawn with pdf.js at the column width, with selectable text, no sideways scroll',{skip:pdfSkip},async()=>{
 const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);
 for(const number of [1,2,3])doc.addPage([420,595]).drawText(`Ban dich trang ${number}`,{x:40,y:520,size:24,font});
 const {context,page,errors}=await open(390,'<main class="public-content read-mode"><article class="reader paper"><div class="reader-pdf-area"><div id="root"></div></div></article></main>',{files:{'/part.pdf':Buffer.from(await doc.save())}});
 await page.evaluate(async()=>{const {mountPdfPages}=await import('/bilingual-reader.js');globalThis.viewer=mountPdfPages(document.querySelector('#root'),{url:'/part.pdf',label:'Bản dịch tiếng Việt'});});
 await page.waitForFunction(()=>document.querySelectorAll('.pdf-pages-page .textLayer span').length>=1,null,{timeout:30000});
 const pages=await page.$$eval('.pdf-pages-page',pages=>pages.map(page=>({width:Math.round(page.getBoundingClientRect().width),label:page.getAttribute('aria-label'),list:Math.round(page.parentElement.clientWidth)})));
 assert.equal(pages.length,3);assert.deepEqual(pages.map(page=>page.label),['Trang 1 / 3','Trang 2 / 3','Trang 3 / 3']);
 for(const item of pages)assert.equal(item.width,item.list,'fit to the column');
 assert.ok(pages[0].width>=340,'the page uses the phone width');
 await page.evaluate(()=>document.querySelector('.pdf-pages-page:last-child').scrollIntoView());
 await page.waitForFunction(()=>document.querySelector('.pdf-pages-page:last-child .textLayer')?.textContent.includes('Ban dich trang 3'),null,{timeout:30000});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll');
 assert.equal(await page.locator('.pdf-pages [role="status"]').textContent(),'3 trang · kéo xuống để đọc tiếp.');
 await page.evaluate(()=>globalThis.viewer.destroy());assert.equal(await page.$eval('#root',root=>root.childElementCount),0);
 assert.deepEqual(errors,[]);
 await context.close();
});

// The real app: index.html and every script and stylesheet from frontend/ on disk, with the Content-Security-Policy of
// frontend/_headers; /api is answered here (nothing reaches a server). `reads` counts GET /api/read/<id> per book.
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(read('_headers'))[1];
const APP_TYPES={...TYPES,'.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
async function openApp(path,{width=390,api=()=>undefined}={}){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<500,isMobile:width<500,reducedMotion:'reduce',locale:'vi-VN'}),page=await context.newPage(),errors=[],reads={};
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{(globalThis.__csp||=[]).push(`${event.violatedDirective} ${event.blockedURI}`);}));
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==ORIGIN)return route.abort();
  if(url.pathname.startsWith('/api/')){
   const book=/^\/api\/read\/([^/]+)$/u.exec(url.pathname)?.[1];if(book)reads[book]=(reads[book]||0)+1;
   const answer=api(url.pathname)||[200,url.pathname==='/api/me'?{authenticated:false,googleConfigured:false,registration:{mode:'open',domains:[]}}:[]];
   return route.fulfill({status:answer[0],contentType:'application/json',body:JSON.stringify(answer[1])});
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1),source=new URL(file,frontend);
  if(!file.includes('..')&&existsSync(source))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':APP_TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(source)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors,reads,csp:()=>page.evaluate(()=>globalThis.__csp||[])};
}
const LIBRARY=[{id:'book-su-ky',title:'Sử ký',author:'Tư Mã Thiên (司马迁)',genre:'Lịch sử Trung Hoa',chapters:2,visibility:'public'},{id:'book-luan-ngu',title:'Luận ngữ',genre:'Triết học',chapters:1,visibility:'public'}];
const NOTES='\n\n[1] Tần Thủy Hoàng (259–210 TCN) là hoàng đế đầu tiên thống nhất Trung Hoa, lập ra nhà Tần và đặt chế độ quận huyện.\n[2] Hàm Dương là kinh đô nhà Tần, nay thuộc tỉnh Thiểm Tây; thành bị đốt khi nhà Tần sụp đổ.\n[3] Chữ viết được thống nhất theo lối tiểu triện, do Lý Tư soạn mẫu; các nước cũ phải bỏ lối viết riêng.\n[4] Đơn vị đo lường được thống nhất trên toàn cõi, kể cả cỡ trục xe.\n[5] Vạn Lý Trường Thành được nối từ các đoạn tường của những nước cũ.\n[6] Lăng mộ ở Ly Sơn, nổi tiếng với đội quân đất nung.';
const PARTS=[
 {id:'c1',title:'Bản kỷ',mime:'text/plain',content:`${Array.from({length:6},(_,i)=>`Đoạn ${i+1}: ${'vua '.repeat(i*3)}Tần Thủy Hoàng [${i+1}] đi tuần khắp các quận, cho khắc đá ghi công ở nhiều nơi, sửa đường sá, đắp đê và đặt quan cai trị mới cho từng vùng đất vừa thu về.`).join('\n\n')}\n\n${'Đoạn văn thêm để trang đủ dài cho việc cuộn. '.repeat(60)}${NOTES}`},
 {id:'c2',title:'Thế gia',mime:'text/plain',content:'Khổng Tử nói: 子曰：學而時習之，不亦說乎？ Học rồi đem ra luyện tập.\n\nTrong toán học, 空间向量 là vectơ trong không gian; còn 秦始皇 là Tần Thủy Hoàng.\n\nTên gốc trong sử sách của vị vua này là 秦始皇.'}
];
const readerApi=path=>path==='/api/library'?[200,LIBRARY]:path==='/api/read/book-su-ky'?[200,PARTS]:path==='/api/read/book-luan-ngu'?[200,[{id:'l1',title:'Học nhi',mime:'text/plain',content:'Một chương ngắn.'}]]:path==='/api/glossary/book-su-ky'?[200,{terms:[{vi:'Tần Thủy Hoàng',zh:['秦始皇']}]}]:undefined;

test('Reader at 390 px in the real app: footnote notes stay on screen, the term popover yields to the header, Chinese keeps lang="zh", each address change loads once',{skip,timeout:120000},async()=>{
 const {context,page,errors,reads,csp}=await openApp('/',{api:readerApi});
 try{
  // The library card's author line marks its Chinese too.
  await page.waitForSelector('.book-author');
  assert.equal(await page.evaluate(()=>document.querySelector('.book-author span[lang="zh"]')?.textContent),'司马迁');
  await page.evaluate(()=>{location.hash='#reader/book-su-ky/1';});await page.waitForSelector('.reader h1');
  assert.equal(reads['book-su-ky'],1,'a typed address loads the book once');
  // Every footnote's note opens inside the screen, and the page never scrolls sideways.
  const refs=await page.locator('.footnote-ref').count();assert.ok(refs>=6,`${refs} footnotes`);
  for(let index=0;index<refs;index++){
   const ref=page.locator('.footnote-ref').nth(index);await ref.scrollIntoViewIfNeeded();await ref.click();
   const box=await ref.evaluate(button=>{const style=getComputedStyle(button,'::after'),shift=new DOMMatrixReadOnly(style.transform).m41,width=['width','paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'].reduce((sum,name)=>sum+parseFloat(style[name]),0),rect=button.getBoundingClientRect(),left=rect.left+rect.width/2+shift;return {left:Math.round(left),right:Math.round(left+width),view:document.documentElement.clientWidth,sideways:document.documentElement.scrollWidth-document.documentElement.clientWidth,display:style.display};});
   assert.equal(box.display,'block',`[${index+1}] open`);assert.ok(box.left>=0&&box.right<=box.view,`[${index+1}] ${box.left}..${box.right} inside 0..${box.view}`);assert.equal(box.sideways,0,`[${index+1}] no sideways scroll`);
   await ref.click();
  }
  // The term popover sits under the sticky header and closes once its term scrolls under it.
  await page.evaluate(()=>scrollTo(0,0));const term=page.locator('.prose .term').first();await term.scrollIntoViewIfNeeded();await term.click();
  assert.equal(await page.$eval('#term-popover',popover=>popover.hidden),false);
  assert.ok(await page.evaluate(()=>Number(getComputedStyle(document.querySelector('#term-popover')).zIndex)<Number(getComputedStyle(document.querySelector('.site-masthead')).zIndex)));
  await page.evaluate(()=>{const term=document.querySelector('.term[aria-expanded="true"]');scrollBy(0,term.getBoundingClientRect().bottom-document.querySelector('.site-masthead').getBoundingClientRect().bottom+40);});
  await page.waitForFunction(()=>document.querySelector('#term-popover').hidden);
  // The next part: every Chinese run is marked, the book is not loaded again.
  await page.click('#next-chapter');await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Thế gia');
  assert.deepEqual(await page.evaluate(()=>{const walker=document.createTreeWalker(document.querySelector('.reader .prose'),NodeFilter.SHOW_TEXT),left=[];for(let node=walker.nextNode();node;node=walker.nextNode())if(/\p{Script=Han}/u.test(node.nodeValue)&&!node.parentElement.closest('[lang^="zh"]'))left.push(node.nodeValue);return left;}),[]);
  assert.equal(reads['book-su-ky'],1);
  // Another book by address, then Back: each loads once.
  await page.evaluate(()=>{location.hash='#reader/book-luan-ngu/1';});await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Học nhi');
  assert.equal(reads['book-luan-ngu'],1);
  await page.goBack();await page.waitForFunction(()=>document.querySelector('.reader h1')?.textContent==='Thế gia');
  assert.equal(reads['book-su-ky'],2,'Back loads the earlier book once');
  assert.deepEqual(await csp(),[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('PDF part on a slow phone: a fast fling through 60 pages keeps only the pages near the screen, and the page in view is drawn',{skip:pdfSkip,timeout:120000},async()=>{
 const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);
 for(let number=1;number<=60;number++){const sheet=doc.addPage([420,595]);for(let line=0;line<30;line++)sheet.drawText(`Trang ${number} dong ${line+1} ban dich`,{x:30,y:560-line*18,size:12,font});}
 const {context,page,errors}=await open(390,'<main class="public-content read-mode"><article class="reader paper"><div class="reader-pdf-area"><div id="root"></div></div></article></main>',{files:{'/long.pdf':Buffer.from(await doc.save())}});
 try{
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
  await page.evaluate(async()=>{const {mountPdfPages}=await import('/bilingual-reader.js');globalThis.viewer=mountPdfPages(document.querySelector('#root'),{url:'/long.pdf'});});
  await page.waitForFunction(()=>document.querySelector('.pdf-pages-page canvas'),null,{timeout:30000});
  // Faster than a throttled phone can draw: about 12 screens a second, down to the end.
  await page.evaluate(async()=>{const end=document.documentElement.scrollHeight;for(let y=0;y<end;y+=400){scrollTo(0,y);await new Promise(done=>setTimeout(done,30));}scrollTo(0,end);});
  await page.waitForFunction(()=>Boolean(document.querySelector('.pdf-pages-page:last-child canvas')),null,{timeout:60000});
  const drawn=await page.$$eval('.pdf-pages-page',pages=>pages.filter(page=>page.querySelector('canvas')).map(page=>Number(page.dataset.page)));
  assert.ok(drawn.length<=10,`only pages near the screen keep a canvas: ${drawn.join(',')}`);
  assert.ok(drawn.every(number=>number>=50),`pages flung past were released: ${drawn.join(',')}`);
  await page.evaluate(()=>globalThis.viewer.destroy());
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
