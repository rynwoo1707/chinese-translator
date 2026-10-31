import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import pdfLibrary from './pdf.cjs';
import {renderMathText,normalizeVectorMath} from '../frontend/math-text.js';
import {PDFJS_FILES,vendoredPdfjs} from './pdfjs-vendor.mjs';

// Browsers older than the newest: Safari and iOS before 16.4 (no lookbehind, no class static blocks), and browsers a
// year or two old that lack the newest built-ins pdf.js's default build calls. The pages must load there, say plainly
// when they cannot, and open PDFs with pdf.js's legacy build (backend/vendor.mjs).
const root=new URL('../',import.meta.url),frontend=new URL('frontend/',root),require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');

// esbuild rewrites what a target cannot parse: marking these features unsupported changes the output of a module that
// uses them. Each would stop the module, and every page importing it, from loading on Safari/iOS 15.4.
const SAFARI_15_4_MISSING={'regexp-lookbehind-assertions':false,'class-static-blocks':false,'regexp-set-notation':false,'regexp-match-indices':false,'import-attributes':false};
test('Every first-party page script parses on Safari/iOS 15.4: no lookbehind literal, no class static block, no v or d flag',()=>{
 const esbuild=require('esbuild'),files=readdirSync(frontend).filter(name=>name.endsWith('.js'));
 assert.ok(files.includes('app.js')&&files.includes('math-text.js')&&files.length>20,files.join());
 const broken=files.filter(name=>{const source=readFileSync(new URL(name,frontend),'utf8'),plain=esbuild.transformSync(source,{loader:'js',format:'esm'}).code;return esbuild.transformSync(source,{loader:'js',format:'esm',supported:SAFARI_15_4_MISSING}).code!==plain;});
 assert.deepEqual(broken,[]);
 // The check sees a lookbehind literal.
 assert.notEqual(esbuild.transformSync('export const x=/(?<!a)b/u;',{loader:'js',format:'esm',supported:SAFARI_15_4_MISSING}).code,esbuild.transformSync('export const x=/(?<!a)b/u;',{loader:'js',format:'esm'}).code);
});

// The same text, rendered where RegExp refuses a lookbehind (test-support/no-lookbehind.mjs, as Safari before 16.4) and
// here: math-text.js finds the same tokens without one.
const PIECES=['x','a','b','A','B','O','H','Na','Cl','Fe','(OH)','_','^','{','}','\\','\\\\','$','$$',' ','\n',"'",'′','@','.',',','(',')','[',']','\u20d7','𝑥','𝐀','2','10','-','−','+','=','/','tốc độ','Tần','中文','α','Δ','\\frac','\\vec','\\alpha','\\sqrt','\\(','\\)','\\[','\\]','{1}','{2}','_2','^2','^{-1}','_{n}','^{2+}','x^2','a_1','H_2O','CO_2','SO_4^{2-}','AB\u20d7','$x$','$ x$','$5','https://a.b/x_1','C:\\Users\\max','\uD835','\uDC00','MAX_2','snake_case','e^{x}'];
function corpus(count=4000){let seed=20261022;const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;const list=['$x^2+y_1$ và $5 hay $10','Vận tốc v = s/t; H_2O và CO_2, vectơ AB\u20d7, 3^{-1}, a_{n}'];for(let i=0;i<count;i++){let text='';for(let n=1+Math.floor(random()*12);n>0;n--)text+=PIECES[Math.floor(random()*PIECES.length)];list.push(text);}return list;}
const render=texts=>texts.map(text=>[renderMathText(text),renderMathText(text,{bare:false}),normalizeVectorMath(text)]);
test('math-text.js loads and renders the same where a lookbehind is refused (Safari/iOS before 16.4)',()=>{
 const texts=corpus(),child=spawnSync(process.execPath,['--import','./backend/test-support/no-lookbehind.mjs','--input-type=module','-e',`
  let refused=false;try{new RegExp('(?<!a)b','u');}catch(error){refused=error instanceof SyntaxError;}
  const {renderMathText,normalizeVectorMath}=await import('./frontend/math-text.js');
  const texts=JSON.parse(await new Response(process.stdin).text());
  process.stdout.write(JSON.stringify({refused,out:texts.map(text=>[renderMathText(text),renderMathText(text,{bare:false}),normalizeVectorMath(text)])}));`],{cwd:fileURLToPath(root),input:JSON.stringify(texts),encoding:'utf8',maxBuffer:256*1024*1024});
 assert.equal(child.status,0,child.stderr);
 const {refused,out}=JSON.parse(child.stdout);assert.equal(refused,true,'the child refuses lookbehind');
 const here=render(texts),differ=texts.filter((text,i)=>JSON.stringify(here[i])!==JSON.stringify(out[i]));
 assert.deepEqual(differ,[],'same HTML for every text');
});

// The real home page in Edge under the site's CSP, with what an older browser lacks taken away before any script runs.
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(read('frontend/_headers'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
const ORIGIN='http://hoatri.test';
let browser=null;
try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());
const LIBRARY=[{id:'b1',title:'Sử ký',genre:'Lịch sử Trung Hoa',chapters:1,visibility:'public'}];
// files: published path -> {path} on disk or {body}; init: a script run in the page (and prefix: in its pdf.js worker).
async function open(path,{init=null,files={},abort=[],width=390}={}){
 const context=await browser.newContext({viewport:{width,height:844},locale:'vi-VN',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 if(init)await page.addInitScript(init);
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==ORIGIN||abort.includes(url.pathname))return route.abort();
  if(url.pathname.startsWith('/api/')){const body=url.pathname==='/api/library'?LIBRARY:url.pathname==='/api/me'?{authenticated:false,googleConfigured:false,registration:{mode:'open',domains:[]}}:[];return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});}
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1),own=files[url.pathname],source=own?.path||new URL(file,frontend);
  const type=file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream';
  if(own?.body!==undefined)return route.fulfill({status:200,headers:{'Content-Type':type,'Content-Security-Policy':CSP},body:own.body});
  if(!file.includes('..')&&existsSync(source))return route.fulfill({status:200,headers:{'Content-Type':type,'Content-Security-Policy':CSP},body:readFileSync(source)});
  return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
 });
 await page.goto(ORIGIN+path);
 return {context,page,errors};
}
// As Safari before 16.4: RegExp refuses a lookbehind (literals are compiled by the engine; the esbuild test covers them).
const NO_LOOKBEHIND=()=>{const Native=RegExp;class Old extends Native{constructor(pattern,flags){const source=pattern instanceof Native?pattern.source:String(pattern??'');if(/\(\?<[=!]/u.test(source))throw new SyntaxError('Invalid regular expression: invalid group specifier name');super(pattern,flags);}static get [Symbol.species](){return Old;}}globalThis.RegExp=Old;};

test('The home page works where a lookbehind is refused, and is never left blank: an old browser or a missing script gets a notice',{skip,timeout:120000},async()=>{
 // Safari 15.4–16.3: the library draws as anywhere else, without the notice.
 let {context,page,errors}=await open('/',{init:NO_LOOKBEHIND});
 try{
  await page.waitForSelector('.cover-book',{timeout:15000});
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.app),'ready');assert.equal(await page.$('#browser-notice'),null);assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // A module that did not arrive (a dropped connection): what happened and how to try again, instead of a blank page.
 ({context,page,errors}=await open('/',{abort:['/math-text.js']}));
 try{
  await page.waitForSelector('#browser-notice',{timeout:15000});
  assert.deepEqual(await page.evaluate(()=>{const box=document.querySelector('#browser-notice');return {inApp:box.parentElement.id,role:box.getAttribute('role'),title:box.querySelector('h1').textContent,button:box.querySelector('button')?.textContent};}),{inApp:'app',role:'alert',title:'Chưa tải xong trang Hoa Trí',button:'Tải lại trang'});
 }finally{await context.close();}
 // A browser older than iOS/Safari 15.4 (no Object.hasOwn, Array.prototype.at…): told to update, with no reload button.
 ({context,page,errors}=await open('/',{init:()=>{delete Object.hasOwn;}}));
 try{
  await page.waitForSelector('#browser-notice',{timeout:15000});
  const notice=await page.evaluate(()=>({title:document.querySelector('#browser-notice h1').textContent,text:document.querySelector('#browser-notice p').textContent,button:Boolean(document.querySelector('#browser-notice button'))}));
  assert.equal(notice.title,'Trình duyệt này quá cũ để mở Hoa Trí');assert.match(notice.text,/iOS 15\.4 trở lên/u);assert.equal(notice.button,false);
 }finally{await context.close();}
});

// Built-ins of 2023–2026 that pdf.js's default build calls without a fallback (Promise.withResolvers: Safari 17.4, the
// rest newer); Edge has them, so they are removed in the page and, through a prefix to its file, in pdf.js's worker.
const NEW_BUILTINS='for(const [owner,names] of [[URL,["parse","canParse"]],[Promise,["withResolvers","try"]],[Math,["sumPrecise"]],[Uint8Array,["fromBase64","fromHex"]],[Uint8Array.prototype,["toBase64","toHex","setFromBase64","setFromHex"]],[Map.prototype,["getOrInsert","getOrInsertComputed"]],[WeakMap.prototype,["getOrInsert","getOrInsertComputed"]]])for(const name of names)delete owner[name];';
// What backend/vendor.mjs writes to /vendor (pdfjs-vendor.mjs), and pdf.js's default build as it was vendored before.
const disk=path=>fileURLToPath(new URL(path,root)),[[legacyPdf],[legacyWorker]]=PDFJS_FILES;
const VENDORED={pdf:vendoredPdfjs(readFileSync(disk(legacyPdf),'utf8')),worker:vendoredPdfjs(readFileSync(disk(legacyWorker),'utf8'))};
const DEFAULT_BUILD={pdf:readFileSync(disk('node_modules/pdfjs-dist/build/pdf.mjs'),'utf8'),worker:readFileSync(disk('node_modules/pdfjs-dist/build/pdf.worker.mjs'),'utf8')};
const pdfFiles=build=>({'/vendor/pdf.mjs':{body:build.pdf},'/vendor/pdf.worker.mjs':{body:NEW_BUILTINS+'\n'+build.worker}});
const BLANK='<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>PDF</title></head><body><div id="root" style="width:360px"></div></body></html>';
async function threePages(){const doc=await pdfLibrary.PDFDocument.create(),font=await doc.embedFont(pdfLibrary.StandardFonts.Helvetica);for(const number of [1,2,3])doc.addPage([420,595]).drawText(`Ban dich trang ${number}`,{x:40,y:520,size:24,font});return Buffer.from(await doc.save());}
// The phone reader (drawn pages), cover detection and the workspace's PDF check, each on a browser without those built-ins.
async function pdfPaths(build){
 const pdf=await threePages(),{context,page,errors}=await open('/blank.html',{init:new Function(NEW_BUILTINS),files:{...pdfFiles(build),'/part.pdf':{body:pdf},'/blank.html':{body:BLANK}}});
 try{
  return await page.evaluate(async()=>{
   const result={};
   const {mountPdfPages}=await import('/bilingual-reader.js');
   mountPdfPages(document.querySelector('#root'),{url:'/part.pdf'});
   const deadline=Date.now()+10000;while(Date.now()<deadline&&!document.querySelector('.pdf-pages-page canvas')&&!/Không|quá cũ/u.test(document.querySelector('[data-pp="status"]')?.textContent||''))await new Promise(done=>setTimeout(done,100));
   result.reader={canvases:document.querySelectorAll('.pdf-pages-page canvas').length,status:document.querySelector('[data-pp="status"]')?.textContent||''};
   const bytes=new Uint8Array(await (await fetch('/part.pdf')).arrayBuffer());
   try{const covers=await import('/cover-detect.js');const found=await covers.detectCoverInBytes(bytes);result.cover={checked:found.checked??null,page:found.page??null};}catch(error){result.cover={error:String(error?.message||error)};}
   try{const {pdfPageCount,analyzePdf}=await import('/pdf-client.js'),file=new File([bytes],'a.pdf',{type:'application/pdf'}),analysis=await analyzePdf(file);result.workspace={pages:await pdfPageCount(file),analyzed:analysis.totalPages};}catch(error){result.workspace={error:String(error?.message||error)};}
   return result;
  });
 }finally{await context.close();}
}
test('PDFs open with the vendored pdf.js (legacy build) where the newest built-ins are missing: phone reader, cover detection, workspace',{skip,timeout:180000},async t=>{
 // backend/vendor.mjs writes the legacy build, with Promise.withResolvers added, to /vendor (the folders of CMaps, fonts and
 // decoders cover-detect.test.mjs checks are copied as before).
 assert.deepEqual(PDFJS_FILES.map(([,to])=>to),['frontend/vendor/pdf.mjs','frontend/vendor/pdf.worker.mjs']);
 for(const [from] of PDFJS_FILES)assert.match(from,/^node_modules\/pdfjs-dist\/legacy\/build\//u);
 const vendor=read('backend/vendor.mjs');assert.match(vendor,/\.\.\.PDFJS_FILES\.map\(async\(\[from,to\]\)=>writeFile\(to,vendoredPdfjs\(await readFile\(from,'utf8'\)\)\)\)/u);assert.doesNotMatch(vendor,/pdfjs-dist\/build\/pdf/u);
 const legacy=await pdfPaths(VENDORED);
 assert.deepEqual(legacy.reader,{canvases:legacy.reader.canvases,status:'3 trang'});assert.ok(legacy.reader.canvases>=1,JSON.stringify(legacy));
 assert.equal(legacy.cover.error,undefined,JSON.stringify(legacy.cover));assert.deepEqual(legacy.workspace,{pages:3,analyzed:3});
 // The default build fails on the same browser: what the switch fixes.
 const modern=await pdfPaths(DEFAULT_BUILD);
 assert.ok(modern.reader.canvases===0||modern.cover.error||modern.workspace.error,JSON.stringify(modern));
 // What the legacy build costs, loaded only with a PDF.
 const size=build=>[build.pdf,build.worker].reduce((sum,text)=>{const bytes=Buffer.from(text);return {raw:sum.raw+bytes.length,gzip:sum.gzip+gzipSync(bytes,{level:9}).length};},{raw:0,gzip:0});
 const more=size(VENDORED),less=size(DEFAULT_BUILD);t.diagnostic(`pdf.js legacy ${more.raw} B (gzip ${more.gzip}) vs default ${less.raw} B (gzip ${less.gzip})`);
 assert.ok(more.gzip-less.gzip<200*1024,`${more.gzip-less.gzip} B more after gzip`);
});

test('A browser that cannot parse pdf.js at all (Safari/iOS before 16.4) is told to update, not to check its network',{skip,timeout:60000},async()=>{
 const {context,page}=await open('/blank.html',{files:{'/vendor/pdf.mjs':{body:'export class A{static{ this.x=1 }; static{'},'/blank.html':{body:BLANK}}});
 try{
  const status=await page.evaluate(async()=>{const {mountPdfPages}=await import('/bilingual-reader.js');mountPdfPages(document.querySelector('#root'),{url:'/x.pdf'});const box=document.querySelector('[data-pp="status"]');for(let i=0;i<100&&!/quá cũ|mạng/u.test(box.textContent);i++)await new Promise(done=>setTimeout(done,50));return {text:box.textContent,retry:Boolean(box.querySelector('button'))};});
  assert.equal(status.text,'Trình duyệt này quá cũ để mở PDF. Hãy cập nhật iPhone hoặc iPad lên iOS 16.4 trở lên, hoặc dùng bản mới của Chrome, Edge, Firefox hay Safari.');
  assert.equal(status.retry,false,'no "Thử lại": trying again cannot help');
 }finally{await context.close();}
});
