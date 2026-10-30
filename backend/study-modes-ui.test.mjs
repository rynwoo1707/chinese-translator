import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {MODES,ADMIN_DEFAULT_MODE,modeProfile,modeLabel,LAYOUT_VERSION} from '../frontend/translation-modes.js';
import {ocrImageBatches,blockBatches} from '../frontend/pdf-box-layout.js';
import {pageTokens,formatTokens} from '../frontend/whole-book.js';
import {W,H,BODY,BODY2,chineseFont,write,image,glyphs,png,drawScan} from './test-support/text-pdf.mjs';

// "Cách dịch" (frontend/translation-modes.js) in Xưởng dịch, in Microsoft Edge: the hint under the field, the mode sent
// with every request of a kept-layout run in calls no larger than the mode allows, the second reading of kept and
// doubtful OCR blocks (reread), the administrator's default, a saved session's engine, the thinking tokens, a scan read
// in the browser (one with a figure, its device reading served in place of local-ocr.js and document-figures.js) and the
// whole-book estimate. The real study.html, study.css and study.js; /api, Gemini and the PDF service answered here, every
// other host blocked; no Gemini call. Skipped when Edge or frontend/vendor is missing.
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../frontend/',import.meta.url)),{PDFDocument,StandardFonts}=require('@cantoo/pdf-lib');
let browser=null;try{browser=await require('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const vendor=await readFile(join(root,'vendor/pdf.mjs')).then(()=>true,()=>false);
const skip=!vendor?'frontend/vendor is not built here (npm run prepare:vendor)':browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

const ORIGIN='http://localhost:4179',KEY='AIzaSy'+'x'.repeat(33),ASSET='3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',SESSION='4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.png':'image/png','.ico':'image/x-icon','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.wasm':'application/wasm','.gz':'application/gzip'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const USER={authenticated:true,user:{name:'Học sinh thử',email:'hs@example.com',provider:'local'}};
const now=()=>new Date().toISOString();
const hintOf=id=>{const {hint,estimate}=modeProfile(id);return id==='economy'?hint:`${hint} Ước tính tốn khoảng gấp ${estimate.toLocaleString('vi-VN')} lần token so với Tiết kiệm.`;};
const ADMIN_NOTE='Trình duyệt này đang đăng nhập quản trị nên Cách dịch mặc định là Kỹ nhất.';
const DOUBT_NOTE='Bản đọc của Gemini cho đoạn này có chỗ đáng ngờ (công thức hoặc chữ có thể sai); hãy đối chiếu với trang gốc.';

// Scanned pages for a kept-layout run: per page, `blocks` blocks with their own image (older manifests) or `sheets`
// (OCR sheets of that many blocks each, extract.py ocr_sheets). Tab labels are unique in the document, as extract.py makes them.
function scanned(pages){
 let label=0;
 return {version:1,extractionVersion:LAYOUT_VERSION,engine:'pymupdf',totalPages:pages.length,warnings:[],pages:pages.map((spec,p)=>{
  const number=p+1,count=spec.sheets?spec.sheets.reduce((a,b)=>a+b,0):spec.blocks,ocrSheets=[];
  const blocks=Array.from({length:count},(_,i)=>{const source=`（扫描）第${number}页第${i+1}段`;return {id:`p${number}-b${i+1}`,text:source,source,box:[40,24+i*11,360,33+i*11],fontSize:8,...(spec.sheets?{}:{image:PNG})};});
  let next=0;for(const [s,size] of (spec.sheets||[]).entries()){const id=`p${number}-s${s+1}`,strips=blocks.slice(next,next+size).map((b,i)=>{b.ocrSheet=id;b.ocrLabel=`#${++label}`;return {label:b.ocrLabel,blockId:b.id,box:[0,i*20,100,i*20+18]};});ocrSheets.push({id,image:PNG,strips});next+=size;}
  return {number,width:400,height:560,original:PNG,background:PNG,blocks,images:[],drawings:[],ocr:true,protectedRegions:[],extractionVersion:LAYOUT_VERSION,...(spec.sheets?{ocrSheets}:{})};
 })};
}
const keptNote=id=>{const [,page,k]=/^p(\d+)-b(\d+)$/u.exec(id);return `Trang ${page} · đoạn ${k}: Gemini không trả bản đọc dùng được. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc.`;};
// The account as the Worker keeps one layout session. first/again: {blockId:{kept?:code,doubt?:code}} for the first
// reading and for a reading again (reread): a kept reading again never replaces an earlier Gemini reading, a good one
// replaces it and clears or sets the doubt, but a doubtful one never replaces a clean one; only the blocks a reading
// again names (rereadIds, or all of a call without them) count it (as backend/pdf-layout-apply.js stores them).
// hooks.ocr(json,call) may wait, or answer instead; account.readOcr(json) is the Worker's own answer.
function layoutAccount(document,{first={},again={},hooks={}}={}){
 const account={document:structuredClone(document),session:null,revision:0,extracts:[],ocr:[],translate:[],saves:[]};
 const all=()=>account.document.pages.flatMap(p=>p.blocks);
 account.readOcr=json=>{
  const warnings=[],read=all().filter(b=>json.blockIds.includes(b.id)),chosen=json.rereadIds??json.blockIds;
  for(const block of read){
   const plan=(json.reread?again:first)[block.id]||{},clean=block.source.replace('（扫描）','');
   if(json.reread){
    if(chosen.includes(block.id))block.ocrRereads=(block.ocrRereads||0)+1;
    if(plan.kept){if(chosen.includes(block.id))warnings.push(keptNote(block.id));continue;}
    if(plan.doubt&&block.ocrCorrected&&!block.ocrKept&&!block.ocrDoubt)continue;
   }
   block.ocrCorrected=true;
   if(plan.kept&&!json.reread){block.ocrKept=plan.kept;warnings.push(keptNote(block.id));}else{block.source=block.text=clean;delete block.ocrKept;}
   if(plan.doubt)block.ocrDoubt=plan.doubt;else delete block.ocrDoubt;
  }
  account.document.ocrCorrectedVersion=all().every(b=>b.ocrCorrected)?1:0;account.document.ocrWarnings=[...(account.document.ocrWarnings||[]),...warnings];
  return {blocks:read.map(({id,source,text,ocrCorrected,ocrKept,ocrDoubt,ocrRereads})=>({id,source,text,ocrCorrected,...(ocrKept?{ocrKept}:{}),...(ocrDoubt?{ocrDoubt}:{}),...(ocrRereads?{ocrRereads}:{})})),ocrCorrectedVersion:account.document.ocrCorrectedVersion,ocrWarnings:account.document.ocrWarnings,usage:{prompt:1000,output:200,thinking:300,total:1500,requests:1},warnings,model:json.model};
 };
 account.api=async(path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/extract'){account.extracts.push({mode:json.get('mode'),pages:json.get('pages')});return {assetId:ASSET,document:account.document,originalUrl:`/api/my/study/pdf-layout/assets/${ASSET}/original`};}
  if(path==='/api/my/study/history'&&method==='POST'||path===`/api/my/study/history/${SESSION}`&&method==='PUT'){
   account.revision++;account.session=structuredClone(json.state);account.saves.push(json);const complete=json.state.done===json.state.parts.length;
   return {id:SESSION,status:complete?'complete':json.state.done?'translating':'draft',libraryStoryId:complete?'book-1':null,libraryChapterId:complete?'chapter-1':null,updatedAt:now(),revision:account.revision};
  }
  if(path==='/api/my/study/history'&&method==='GET')return [];
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/manifest`)return account.document;
  if(path==='/api/my/study/pdf-layout/ocr-blocks'){account.ocr.push(json);const hooked=await hooks.ocr?.(json,account.ocr.length);return hooked||account.readOcr(json);}
  if(path==='/api/my/study/translate-blocks'){account.translate.push(json);return {blocks:json.blocks.map(b=>({id:b.id,translation:`Bản dịch ${b.id}.`})),failedBlocks:[],context:'',glossary:{},usage:{prompt:600,output:200,thinking:100,total:900,requests:1},warnings:[],model:'gemini-test'};}
  if(path==='/api/my/study/pdf-layout/render')return {url:`/api/my/study/pdf-layout/assets/${ASSET}/translated`,renderVersion:3};
  if(path===`/api/my/study/pdf-layout/assets/${ASSET}/translated`)return {fakeBody:await pdfBytes(account.document.pages.length),contentType:'application/pdf'};
 };
 return account;
}
const pdfBytes=async(count=1)=>{const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);for(let number=1;number<=count;number++){const page=pdf.addPage([400,560]);for(let line=0;line<20;line++)page.drawText(`Trang ${number}, dong ${line+1}: noi dung mau de kiem tra bo cuc`,{x:36,y:520-line*20,size:10,font});}return Buffer.from(await pdf.save());};
const defaults=(path,method)=>path==='/api/me'?USER:path==='/api/my/study/history'&&method==='GET'?[]:path==='/api/my/study/books'?[]:path==='/api/my/study/book-jobs'?{jobs:[]}:path==='/api/my/study/pdf-layout/config'?{configured:true}:path==='/api/my/study/library-match'?{match:null}:path==='/api/my/study/models'?{models:[{id:'gemini-test'}],requested:'gemini-test',selected:'gemini-test'}:path==='/api/my/study/pdf-layout/font'?{css:''}:path==='/api/admin/session'?{fakeStatus:401,json:{error:'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.',code:'admin_signed_out'}}:undefined;
// api(path,method,json,request) -> a body, {fakeStatus,json}, {fakeBody,contentType} or undefined (the defaults above).
// requests: every /api request with its query string and headers. modules: {'/name.js':source} served in place of
// those frontend files (before the page loads, so a static import takes them too).
async function openStudy(api,{init=null,viewport={width:1280,height:900},wait=true,modules={}}={}){
 const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await context.addInitScript(()=>{window.__statuses=[];addEventListener('DOMContentLoaded',()=>{const line=document.querySelector('#progress');new MutationObserver(()=>window.__statuses.push(line.textContent)).observe(line,{childList:true,characterData:true,subtree:true});});});
 if(init)await context.addInitScript(init);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN)return route.abort();
  const path=decodeURIComponent(url.pathname),method=request.method();
  if(Object.hasOwn(modules,path))return route.fulfill({status:200,headers:{'Content-Type':'text/javascript'},body:modules[path]});
  if(path.startsWith('/api/')){
   requests.push({method,path,search:url.search,headers:request.headers()});
   let json=null;const type=request.headers()['content-type']||'';
   if(type.startsWith('multipart/form-data'))json=await new Request('http://fake/',{method:'POST',headers:{'content-type':type},body:request.postDataBuffer()}).formData();else try{json=JSON.parse(request.postData()||'null');}catch{}
   let body=await api(path,method,json,request);if(body===undefined)body=defaults(path,method);
   if(body===undefined)return route.fulfill({status:404,json:{error:`fake: ${method} ${path}`}});
   if(body?.fakeBody)return route.fulfill({status:200,headers:{'Content-Type':body.contentType},body:body.fakeBody});
   if(body?.fakeStatus)return route.fulfill({status:body.fakeStatus,json:body.json});
   return route.fulfill({json:body});
  }
  const file=normalize(join(root,path==='/study'?'study.html':path));if(!file.startsWith(normalize(root)))return route.abort();
  const data=await readFile(file).catch(()=>null);if(!data)return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,headers:{'Content-Type':TYPES[extname(file)]||'application/octet-stream'},body:data});
 });
 await page.goto(`${ORIGIN}/study`);await page.waitForFunction(()=>document.body.dataset.session!=='checking');
 if(wait)await page.waitForFunction(()=>!/đang tải/u.test(document.querySelector('#study-history-count').textContent));
 return {context,page,errors,requests};
}
async function pickPdf(page,pages=1){
 await page.waitForFunction(()=>document.querySelector('#pdf-layout-enabled').checked);
 await page.setInputFiles('#source-file',{name:'bai-scan.pdf',mimeType:'application/pdf',buffer:await pdfBytes(pages)});
 await page.waitForFunction(count=>new RegExp(`^${count} trang · `,'u').test(document.querySelector('#file-status').textContent),pages,{timeout:30000});
 await page.fill('#content-title','Bài giữ bố cục');await page.fill('#api-key',KEY);
}
const progress=page=>page.textContent('#progress');
const waitProgress=(page,pattern,timeout=60000)=>page.waitForFunction(source=>new RegExp(source,'u').test(document.querySelector('#progress').textContent),pattern.source,{timeout});
const idle=page=>page.waitForFunction(()=>!document.querySelector('#translate').disabled,null,{timeout:60000});
// Waits until check() holds on this side (the requests seen); then lets the page handle the answer.
const until=async(check,ms=15000)=>{for(const end=Date.now()+ms;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,50)))if(check())return new Promise(resolve=>setTimeout(()=>resolve(true),300));return false;};
const askedAdmin=requests=>requests.some(entry=>entry.path==='/api/admin/session');
const EXPORTED=/^PDF tiếng Việt đã được lưu vào Thư viện riêng/u;
// The second reading as study.js chooses it, checked against the mode's profile: per page at most maxPerPage blocks (the
// kept ones before any doubtful one), each block once, every call within ocrBatch.
function checkRereads(account,mode,{exact=null}={}){
 const {reread,ocrBatch}=modeProfile(mode),calls=account.ocr.filter(body=>body.reread===true),sent=calls.flatMap(body=>body.blockIds);
 assert.ok(calls.every(body=>body.mode===mode&&body.slim===true&&body.blockIds.length<=ocrBatch.blocks),JSON.stringify(calls.map(body=>[body.mode,body.blockIds.length])));
 assert.equal(new Set(sent).size,sent.length,`each block is read again once: ${sent}`);
 if(exact)assert.deepEqual(sent,exact);
 return {calls,sent,reread};
}

describe('Cách dịch in Xưởng dịch, in Edge',{concurrency:3},()=>{
test('Under Cách dịch the chosen mode says what it does and, beside Tiết kiệm, about how many times the tokens; the hint is read out when it changes',{skip,timeout:60000},async()=>{
 const {context,page,errors}=await openStudy(()=>undefined);
 try{
  assert.deepEqual(await page.evaluate(()=>{const hint=document.querySelector('#mode-hint');return {live:hint.getAttribute('aria-live'),described:document.querySelector('#mode').getAttribute('aria-describedby'),text:hint.textContent,mode:document.querySelector('#mode').value};}),{live:'polite',described:'mode-hint',text:hintOf('economy'),mode:'economy'});
  assert.deepEqual(await page.$$eval('#mode option',options=>options.map(option=>[option.value,option.textContent])),MODES.map(id=>[id,modeLabel(id)]));
  for(const id of [...MODES].reverse()){await page.selectOption('#mode',id);assert.equal(await page.textContent('#mode-hint'),hintOf(id),id);}
  await page.selectOption('#mode','premium');assert.match(await page.textContent('#mode-hint'),/\. Ước tính tốn khoảng gấp \d+(?:,\d+)? lần token so với Tiết kiệm\.$/u);
  // On a phone the hint wraps under the field, inside the screen.
  await page.setViewportSize({width:360,height:740});
  const measure=await page.evaluate(()=>{const hint=document.querySelector('#mode-hint').getBoundingClientRect(),select=document.querySelector('#mode').getBoundingClientRect();return {scroll:document.documentElement.scrollWidth,inner:innerWidth,right:hint.right,below:hint.top>=select.bottom,height:hint.height};});
  assert.ok(measure.scroll<=measure.inner&&measure.right<=measure.inner&&measure.below&&measure.height>0,JSON.stringify(measure));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Kỹ nhất goes with the extraction, every OCR call and every translation call of a kept-layout run, in calls no larger than it allows; Tiết kiệm keeps its large calls',{skip,timeout:120000},async()=>{
 const document=scanned([{sheets:[5,5,5,5]},{sheets:[5,5]}]),blocks=document.pages.flatMap(p=>p.blocks),sheets=document.pages.flatMap(p=>p.ocrSheets),counts={};
 for(const mode of ['premium','economy']){
  const account=layoutAccount(document),{context,page,errors}=await openStudy(account.api);
  try{
   await pickPdf(page);await page.selectOption('#mode',mode);await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
   const {ocrBatch,layoutBatch}=modeProfile(mode);
   assert.deepEqual(account.extracts.map(entry=>entry.mode),[mode],'the extraction');
   assert.deepEqual(account.ocr.map(body=>body.blockIds),ocrImageBatches(blocks,undefined,sheets,ocrBatch),`${mode}: OCR calls as the mode's ocrBatch cuts them`);
   assert.ok(account.ocr.every(body=>body.mode===mode&&body.slim===true&&body.reread===undefined),`${mode}: nothing doubtful, nothing read again`);
   const read=blocks.map(b=>({...b,source:b.source.replace('（扫描）','')}));
   assert.deepEqual(account.translate.map(body=>body.blocks.map(b=>b.id)),blockBatches(read,layoutBatch).map(batch=>batch.map(b=>b.id)),`${mode}: translation calls as its layoutBatch cuts them`);
   assert.ok(account.translate.every(body=>body.mode===mode&&body.partial===true));assert.equal(account.saves.at(-1).mode,mode,'the session is saved with its mode');
   counts[mode]=account.ocr.length+account.translate.length;assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 assert.ok(counts.premium>counts.economy,`Kỹ nhất makes more, smaller calls: ${JSON.stringify(counts)}`);
});

test('A mode that reads again sends the kept and the doubtful readings once more after the OCR pass (reread), kept ones first, at most maxPerPage a page; the notes follow; Tiết kiệm reads again only what it could not read and readings short of their strip\'s Chinese',{skip,timeout:150000},async()=>{
 const document=scanned([{blocks:8},{blocks:2}]);
 const first={'p1-b2':{kept:'unread'},'p1-b3':{doubt:'tex'},'p1-b5':{doubt:'glued'},'p1-b6':{kept:'formula'},'p1-b8':{doubt:'hint'},'p2-b1':{doubt:'han'}};
 // Read again, p1-b6 is still kept and p1-b3 still doubtful; the others come back good.
 const again={'p1-b6':{kept:'unread'},'p1-b3':{doubt:'tex'}};
 const account=layoutAccount(document,{first,again}),{context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page,2);await page.selectOption('#mode','quality');await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
  const {calls,sent,reread}=checkRereads(account,'quality');
  // The reading again comes after every block was read, and before any translation.
  const firstReread=account.ocr.findIndex(body=>body.reread);assert.ok(firstReread>0&&account.ocr.slice(0,firstReread).flatMap(body=>body.blockIds).length===10&&account.ocr.slice(firstReread).every(body=>body.reread));
  assert.ok(calls.length>0);
  for(const [pageNumber,kept,doubtful] of [[1,['p1-b2','p1-b6'],['p1-b3','p1-b5','p1-b8']],[2,[],['p2-b1']]]){
   const onPage=sent.filter(id=>id.startsWith(`p${pageNumber}-`)),candidates=kept.length+doubtful.length;
   assert.equal(onPage.length,Math.min(reread.maxPerPage,candidates),`page ${pageNumber}: ${onPage}`);
   assert.ok(onPage.every(id=>kept.includes(id)||doubtful.includes(id)),'only kept or doubtful readings');
   assert.deepEqual(kept.filter(id=>onPage.includes(id)),kept.slice(0,Math.min(kept.length,reread.maxPerPage)),'kept ones first');
  }
  // A kept block read well this time loses its note; one still kept keeps it. The translation took the new readings.
  const warnings=await page.textContent('#warnings');
  assert.ok(!warnings.includes(keptNote('p1-b2')),warnings);assert.ok(warnings.includes(keptNote('p1-b6')),warnings);
  // The doubtful readings the page's quota left as they are are named once, since nothing else names them.
  const left=['p1-b3','p1-b5','p1-b8','p2-b1'].filter(id=>!sent.includes(id)).map(id=>id.replace(/^p(\d+)-b(\d+)$/u,'Trang $1 · đoạn $2'));
  assert.equal(warnings.split('\n').filter(line=>line.includes('chưa được đọc lại')).join('\n'),left.length?`${left.join(', ')}: bản đọc của Gemini có chỗ đáng ngờ (công thức hoặc chữ có thể sai) và chưa được đọc lại; hãy đối chiếu với trang gốc.`:'');
  assert.equal(account.translate.flatMap(body=>body.blocks).find(b=>b.id==='p1-b2').source,'第1页第2段');
  // A reading still doubtful says so in the Hanzi panel of the original.
  await page.click('[data-source-block="p1-b3"]');await page.waitForSelector('#hanzi-panel:not([hidden])');
  assert.equal(await page.textContent('#hanzi-panel .hz-note'),DOUBT_NOTE);
  // Nothing is read again on the next Bắt đầu dịch: the OCR of this session is done.
  const before=account.ocr.length;await page.keyboard.press('Escape');await page.click('#translate');await idle(page);assert.equal(account.ocr.length,before);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 // Tiết kiệm reads again only the block Gemini could not read (p1-b2) and the reading short of its strip's Chinese (p2-b1):
 // never a block kept for its formula (p1-b6) nor a formula doubt. The note of p1-b2 goes; that of p1-b6 stays.
 const cheap=layoutAccount(document,{first,again}),plain=await openStudy(cheap.api);
 try{
  await pickPdf(plain.page,2);await plain.page.click('#translate');await waitProgress(plain.page,EXPORTED);await idle(plain.page);
  checkRereads(cheap,'economy',{exact:['p1-b2','p2-b1']});
  const warnings=await plain.page.textContent('#warnings');assert.ok(!warnings.includes(keptNote('p1-b2')),warnings);assert.ok(warnings.includes(keptNote('p1-b6')),warnings);
  assert.deepEqual(plain.errors,[]);
 }finally{await plain.context.close();}
});

test('A doubtful block of an OCR sheet is read again with its whole sheet (one image); a sheet with more blocks than one call of the mode takes is left as it is and uses none of its page\'s quota',{skip,timeout:120000},async()=>{
 const {ocrBatch,reread}=modeProfile('premium'),big=ocrBatch.blocks+1,document=scanned([{sheets:[4,big,3]}]);
 // The large sheet (p1-b5…) holds more kept blocks than the page's quota; kept ones come first, yet they cannot be read
 // again, so the quota goes to the kept block of the last sheet and the doubtful one of the first.
 const large=Array.from({length:reread.maxPerPage+1},(_,i)=>`p1-b${5+i}`).concat('p1-b10'),first=Object.fromEntries([...large.map(id=>[id,{kept:'unread'}]),['p1-b2',{doubt:'tex'}],[`p1-b${4+big+2}`,{kept:'unread'}]]);
 const account=layoutAccount(document,{first}),{context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.selectOption('#mode','premium');await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
  const last=[1,2,3].map(i=>`p1-b${4+big+i}`);
  checkRereads(account,'premium',{exact:['p1-b1','p1-b2','p1-b3','p1-b4',...last]});
  const warnings=await page.textContent('#warnings');
  for(const id of large)assert.ok(warnings.includes(keptNote(id)),`${id} on the large sheet keeps its machine text and its note`);
  assert.ok(!warnings.includes(keptNote(last[1])),'the kept block read well again loses its note');assert.ok(!warnings.includes('chưa được đọc lại'),warnings);
  assert.ok(account.ocr.filter(body=>!body.reread).every(body=>body.mode==='premium'));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Dừng while readings are read again stops before the next paid call; Bắt đầu dịch goes on within the page\'s quota, never reading a block twice',{skip,timeout:150000},async()=>{
 const {reread,ocrBatch}=modeProfile('premium');
 // Enough kept blocks that the second reading takes more than one call: a page holds maxPerPage+2 of them.
 const pages=Math.ceil((ocrBatch.images+1)/reread.maxPerPage),perPage=reread.maxPerPage+2,document=scanned(Array.from({length:pages},()=>({blocks:perPage})));
 const first=Object.fromEntries(document.pages.flatMap(p=>p.blocks.map(b=>[b.id,{kept:'unread'}])));
 let release=null;const gate=new Promise(resolve=>{release=resolve;});
 const account=layoutAccount(document,{first,hooks:{ocr:async json=>{if(json.reread&&account.ocr.filter(body=>body.reread).length===1)await gate;return null;}}});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page,pages);await page.selectOption('#mode','premium');await page.click('#translate');
  await page.waitForFunction(()=>/^Đang đọc kỹ lại \d+ đoạn chữ trong ảnh còn đáng ngờ \(Trang /u.test(document.querySelector('#progress').textContent),null,{timeout:60000});
  await page.click('#stop');release();await idle(page);
  assert.equal(await progress(page),'Đã dừng khi đang đọc kỹ lại các đoạn chữ trong ảnh còn đáng ngờ. Phần đã đọc được giữ lại; bấm Bắt đầu dịch để đọc tiếp và dịch.');
  assert.equal(account.ocr.filter(body=>body.reread).length,1,'no reading again is paid after Dừng');assert.equal(account.translate.length,0);
  await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
  const {sent}=checkRereads(account,'premium');
  for(const entry of document.pages){const ids=entry.blocks.map(b=>b.id);assert.deepEqual(sent.filter(id=>ids.includes(id)),ids.slice(0,reread.maxPerPage),`page ${entry.number}: its quota, across both runs`);}
  assert.ok(account.translate.length>0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('Only the blocks chosen to be read again count it, never the others of their sheets: after Dừng the page\'s quota still has room for the rest',{skip,timeout:150000},async()=>{
 const {reread,ocrBatch}=modeProfile('premium'),count=reread.maxPerPage;assert.ok(count>ocrBatch.images,'the reading again takes more than one call');
 // count two-block sheets on one page: the first block of each is doubtful, and so is the very last block, one more
 // than the page's quota. Read again, that last block is still doubtful.
 const document=scanned([{sheets:Array.from({length:count},()=>2)}]),ids=document.pages[0].blocks.map(b=>b.id),firsts=ids.filter((id,i)=>i%2===0),last=ids.at(-1);
 const first=Object.fromEntries([...firsts,last].map(id=>[id,{doubt:'tex'}]));
 let release=null;const gate=new Promise(resolve=>{release=resolve;});
 const account=layoutAccount(document,{first,again:{[last]:{doubt:'tex'}},hooks:{ocr:async json=>{if(json.reread&&account.ocr.filter(body=>body.reread).length===1)await gate;return null;}}});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.selectOption('#mode','premium');await page.click('#translate');
  await page.waitForFunction(()=>/^Đang đọc kỹ lại \d+ đoạn chữ trong ảnh còn đáng ngờ \(Trang /u.test(document.querySelector('#progress').textContent),null,{timeout:60000});
  await page.click('#stop');release();await idle(page);
  await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
  // Each call sends whole sheets and names the blocks chosen among them (rereadIds); the first call's sheet-mates use
  // none of the quota, so the run after Dừng still reads the chosen block of the last sheet again.
  assert.deepEqual(account.ocr.filter(body=>body.reread).map(body=>[body.blockIds,body.rereadIds]),[[ids.slice(0,2*ocrBatch.images),firsts.slice(0,ocrBatch.images)],[ids.slice(2*ocrBatch.images),firsts.slice(ocrBatch.images)]]);
  assert.deepEqual(account.document.pages[0].blocks.filter(b=>b.ocrRereads).map(b=>b.id),firsts,'only the chosen blocks were counted');
  // The last block only came along with its sheet: still doubtful, it is named as not read again.
  assert.match(await page.textContent('#warnings'),new RegExp(`^Trang 1 · đoạn ${ids.length}: bản đọc của Gemini có chỗ đáng ngờ \\(công thức hoặc chữ có thể sai\\) và chưa được đọc lại`,'mu'));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('An OCR call stopped part-way by a quota keeps the sheets read before it: the next Bắt đầu dịch sends only the sheets still to read',{skip,timeout:120000},async()=>{
 const document=scanned([{sheets:[3,3]}]),ids=document.pages[0].blocks.map(b=>b.id),read=ids.slice(0,3),left=ids.slice(3);
 const QUOTA='Gemini đang giới hạn số lượt gọi mỗi phút của khóa này. Hãy đợi khoảng 40 giây rồi tiếp tục; nội dung đã được lưu.';
 // The Worker split the call: the first sheet was read and stored, then the per-minute quota stopped it; its answer is
 // that error with the blocks read (backend/pdf-layout.js).
 const account=layoutAccount(document,{hooks:{ocr:(json,call)=>call===1?{fakeStatus:429,json:{...account.readOcr({...json,blockIds:read}),error:QUOTA,code:'quota_minute',retryAfter:40,pending:left}}:null}});
 const {context,page,errors}=await openStudy(account.api);
 try{
  await pickPdf(page);await page.click('#translate');await waitProgress(page,/giới hạn số lượt gọi mỗi phút/u);await idle(page);
  await page.click('#translate');await waitProgress(page,EXPORTED);await idle(page);
  assert.deepEqual(account.ocr.map(body=>body.blockIds),[ids,left],'the sheet read before the quota is not sent, nor paid for, again');
  // Its tokens count once (two readings, one translation); the translation takes its reading.
  assert.equal(await page.textContent('#usage-total'),'3.900');
  assert.equal(account.translate.flatMap(body=>body.blocks).find(b=>b.id===read[0]).source,'第1页第1段');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('A browser signed in to /admin starts at the school\'s mode (Kỹ nhất unless the server sets another) and says why; a mode the student picks or a session brings back wins; signed out of /admin it stays Tiết kiệm',{skip,timeout:120000},async()=>{
 const ADMIN={admin:{username:'quantri',name:'Quản trị'},expiresAt:'2026-10-27T00:00:00.000Z'};
 // 0. The server's ADMIN_TRANSLATION_MODE (the session's translationMode) is the one preselected and named.
 const school=await openStudy(path=>path==='/api/admin/session'?{...ADMIN,translationMode:'quality'}:undefined);
 try{
  await school.page.waitForFunction(()=>document.querySelector('#mode').value==='quality');
  assert.equal(await school.page.textContent('#mode-hint'),`${hintOf('quality')} Trình duyệt này đang đăng nhập quản trị nên Cách dịch mặc định là Kỹ hơn.`);assert.deepEqual(school.errors,[]);
 }finally{await school.context.close();}
 // 1. Signed in, the answer naming no mode (a Worker from before translationMode): Kỹ nhất is preselected, asked with
 // the header that lets the admin cookie count, and marked as only a
 // look (probe=1), which the Worker must not count as admin activity that keeps the session from going idle.
 let admin=await openStudy(path=>path==='/api/admin/session'?ADMIN:undefined);
 try{
  await admin.page.waitForFunction(mode=>document.querySelector('#mode').value===mode,ADMIN_DEFAULT_MODE);
  assert.equal(await admin.page.textContent('#mode-hint'),`${hintOf(ADMIN_DEFAULT_MODE)} ${ADMIN_NOTE}`);
  const asked=admin.requests.filter(entry=>entry.path==='/api/admin/session');
  assert.equal(asked.length,1);assert.equal(asked[0].method,'GET');assert.equal(asked[0].headers['x-hoa-tri-admin'],'1');assert.equal(asked[0].search,'?probe=1');
  // The student's own choice holds, and the note goes.
  await admin.page.selectOption('#mode','economy');assert.equal(await admin.page.textContent('#mode-hint'),hintOf('economy'));
  await admin.page.selectOption('#mode','premium');assert.equal(await admin.page.textContent('#mode-hint'),hintOf('premium'));
  assert.deepEqual(admin.errors,[]);
 }finally{await admin.context.close();}
 // 2. Signed out of /admin (401) or never an admin: Tiết kiệm.
 const student=await openStudy(()=>undefined);
 try{
  assert.ok(await until(()=>askedAdmin(student.requests)));
  assert.equal(await student.page.inputValue('#mode'),'economy');assert.equal(await student.page.textContent('#mode-hint'),hintOf('economy'));assert.deepEqual(student.errors,[]);
 }finally{await student.context.close();}
 // 3. A session opened before the answer arrives keeps its own mode.
 const ID='1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',item={id:ID,title:'Bài cũ',filename:'',domain:'general',mode:'balanced',status:'translating',translated_parts:1,total_parts:2,library_story_id:null,library_chapter_id:null,created_at:'2026-10-20 07:00:00',updated_at:'2026-10-20 08:00:00',page_start:null,page_end:null,source_total_pages:null,source_sha256:null,revision:2};
 let answer=null;const late=new Promise(resolve=>{answer=resolve;});
 admin=await openStudy(async(path,method)=>{
  if(path==='/api/admin/session'){await late;return ADMIN;}
  if(path==='/api/my/study/history'&&method==='GET')return [item];
  if(path===`/api/my/study/history/${ID}`)return {...item,state:{source:'一。\n\n二。',parts:['一。','二。'],translationParts:['Một.',''],done:1,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:''}};
 });
 try{
  await admin.page.click('#study-history > summary');await admin.page.click(`[data-history-open="${ID}"]`);await waitProgress(admin.page,/Đã khôi phục 1\/2 phần/u);
  assert.ok(await until(()=>askedAdmin(admin.requests)),'asked at start, answered only now');answer();await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(await admin.page.inputValue('#mode'),'balanced');assert.equal(await admin.page.textContent('#mode-hint'),hintOf('balanced'));assert.deepEqual(admin.errors,[]);
 }finally{await admin.context.close();}
 // 4. Signed out of Xưởng dịch: /admin is not asked at all.
 const out=await openStudy(path=>path==='/api/me'?{authenticated:false}:undefined,{wait:false});
 try{assert.equal(await out.page.evaluate(()=>document.body.dataset.session),'out');await new Promise(resolve=>setTimeout(resolve,300));assert.deepEqual(out.requests.filter(entry=>entry.path.startsWith('/api/admin/')),[]);assert.deepEqual(out.errors,[]);}
 finally{await out.context.close();}
});

test('A saved session comes back with its engine (a mode its old column cannot hold); a whole-book run with its own; the estimate follows the mode',{skip,timeout:120000},async()=>{
 const row=(id,over)=>({id,title:`Bài ${id.slice(-1)}`,filename:'',domain:'general',status:'translating',translated_parts:1,total_parts:2,library_story_id:null,library_chapter_id:null,created_at:'2026-10-20 07:00:00',updated_at:'2026-10-20 08:00:00',page_start:null,page_end:null,source_total_pages:null,source_sha256:null,revision:2,...over});
 const items=[row('2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c61',{mode:'quality',engine:'premium'}),row('2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c62',{mode:'balanced'}),row('2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c63',{mode:'turbo'})];
 const sha='a'.repeat(64),job={id:'0b7e2a43-0000-4000-8000-0000000000ab',sourceSha256:sha,filename:'sach.pdf',title:'Sách Kỹ nhất',storyId:null,totalPages:30,pageStates:'d'.repeat(10)+'.'.repeat(20),chunkSize:20,domain:'general',mode:'premium',model:null,status:'paused',pauseReason:'quota_day',usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{},createdAt:'2026-10-19T01:00:00.000Z',updatedAt:'2026-10-20T01:00:00.000Z',runner:null,leaseSeconds:0};
 const {context,page,errors}=await openStudy((path,method)=>{
  if(path==='/api/my/study/history'&&method==='GET')return items;
  const item=items.find(entry=>path===`/api/my/study/history/${entry.id}`);if(item)return {...item,state:{source:'一。\n\n二。',parts:['一。','二。'],translationParts:['Một.',''],done:1,context:'',glossary:{},manualGlossary:{},previousSource:'',previousTranslation:''}};
  if(path==='/api/my/study/book-jobs'&&method==='GET')return {jobs:[job]};
 });
 try{
  // An unfinished book run opens the history by itself.
  await page.waitForSelector('#study-books-list [data-book-resume]');if(!await page.evaluate(()=>document.querySelector('#study-history').open))await page.click('#study-history > summary');
  for(const [item,mode] of [[items[0],'premium'],[items[1],'balanced'],[items[2],'economy']]){
   await page.click(`[data-history-open="${item.id}"]`);await waitProgress(page,/Đã khôi phục 1\/2 phần/u);await page.evaluate(()=>{document.querySelector('#progress').textContent='';});
   assert.equal(await page.inputValue('#mode'),mode,item.mode);assert.equal(await page.textContent('#mode-hint'),hintOf(mode));
  }
  // The book's run is continued with its own mode (no key yet, so nothing runs); its estimate is Kỹ nhất's.
  await page.click('#study-books-list [data-book-resume]');await page.waitForSelector('#whole-book:not([hidden])');await waitProgress(page,/Dán khóa Gemini rồi bấm Tiếp tục dịch cả quyển/u);
  assert.equal(await page.inputValue('#mode'),'premium');
  const estimate=()=>page.textContent('#whole-book-estimate'),costs=mode=>pageTokens(mode);
  assert.match(await estimate(),/chỉ là ước tính · Cách dịch Kỹ nhất/u);
  assert.ok((await estimate()).includes(`Trang scan (Gemini đọc ảnh): khoảng ${formatTokens(costs('premium').scan[0])}–${formatTokens(costs('premium').scan[1])} token`),await estimate());
  await page.selectOption('#mode','economy');
  assert.match(await estimate(),/chỉ là ước tính · Cách dịch Tiết kiệm/u);assert.ok((await estimate()).includes(`Trang scan (Gemini đọc ảnh): khoảng ${formatTokens(3000)}–${formatTokens(8000)} token`),await estimate());
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('The token count shows the thinking Gemini spent beside what was sent and received',{skip,timeout:60000},async()=>{
 const ID='3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e70';let saved=0;
 const {context,page,errors}=await openStudy((path,method)=>{
  if(path==='/api/my/study/history'&&method==='POST')return {id:ID,status:'draft',libraryStoryId:null,updatedAt:now(),revision:++saved};
  if(path===`/api/my/study/history/${ID}`&&method==='PUT')return {id:ID,status:'complete',libraryStoryId:null,updatedAt:now(),revision:++saved};
  if(path==='/api/my/study/translate')return {translation:'Học mà thường ôn tập.',context:'',glossary:{},usage:{prompt:1200,output:340,thinking:2048,total:3588,requests:1},warnings:[]};
 });
 try{
  assert.equal(await page.textContent('#usage-detail'),'0 lần gửi · 0 token gửi đi · 0 token nhận về · 0 token suy luận');
  await page.fill('#content-title','Thử suy luận');await page.fill('#api-key',KEY);await page.fill('#source','子曰：学而时习之。');await page.selectOption('#mode','quality');
  await page.click('#translate');await waitProgress(page,/^Hoàn tất/u);
  assert.equal(await page.textContent('#usage-detail'),'1 lần gửi · 1.200 token gửi đi · 340 token nhận về · 2.048 token suy luận');assert.equal(await page.textContent('#usage-total'),'3.588');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// A one-page scan made here from invented sentences (as backend/study-ui-states.test.mjs makes it), read in the browser
// when the PDF service is not configured; PaddleOCR is missing, so Tesseract reads it on the device.
async function scannedPdf(page){
 const png=await page.evaluate(()=>{const canvas=document.createElement('canvas'),g=canvas.getContext('2d');canvas.width=1240;canvas.height=1754;g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);g.fillStyle='#111';g.font='44px "Microsoft YaHei","SimHei","Noto Sans CJK SC",sans-serif';['第一课 空间向量的概念','今天我们学习平面方程和直线方程。','老师在黑板上画了一个立体图形。','同学们一起讨论两个平面的夹角。'].forEach((line,index)=>g.fillText(line,120,240+index*120));return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);});
 const pdf=await PDFDocument.create(),image=await pdf.embedPng(Buffer.from(png,'base64'));pdf.addPage([595.2,842]).drawImage(image,{x:0,y:0,width:595.2,height:842});return Buffer.from(await pdf.save());
}
test('A scan read in the browser: Kỹ nhất has Gemini read every scanned page, with the mode on the OCR form',{skip,timeout:180000},async()=>{
 const ID='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a81',forms=[];
 const {context,page,errors}=await openStudy((path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/config')return {configured:false};
  if(path==='/api/my/study/history'&&method==='POST')return {id:ID,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};
  if(path===`/api/my/study/history/${ID}`&&method==='PUT')return {id:ID,status:'complete',libraryStoryId:null,updatedAt:now(),revision:2};
  if(path==='/api/my/study/ocr'){forms.push({mode:json.get('mode'),model:json.get('model')});return {text:'第一课 空间向量的概念\n今天我们学习平面方程和直线方程。',usage:{prompt:900,output:60,thinking:0,total:960,requests:1},warnings:[]};}
  if(path==='/api/my/study/translate')return {translation:'Bài 1: khái niệm vectơ trong không gian.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};
 },{init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}})});
 await context.route('**/vendor/paddle/**',route=>route.fulfill({status:404,headers:{'Content-Type':'text/html; charset=utf-8'},body:'<!doctype html><title>Không tìm thấy</title>'}));
 try{
  await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
  await page.fill('#content-title','Bài scan Kỹ nhất');await page.fill('#api-key',KEY);await page.selectOption('#mode','premium');
  await page.setInputFiles('#source-file',{name:'bai-scan.pdf',mimeType:'application/pdf',buffer:await scannedPdf(page)});
  await page.waitForFunction(()=>/trang scan/u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
  await page.click('#translate');await waitProgress(page,/^Hoàn tất/u,150000);
  assert.deepEqual(forms,[{mode:'premium',model:'gemini-test'}],'the page went to Gemini once, with its mode');
  const statuses=await page.evaluate(()=>window.__statuses);
  assert.ok(statuses.some(line=>/^(?:Đang đọc trang scan 1\/1 bằng Gemini \(Cách dịch Kỹ nhất\)…|Trang 1\/1 khó đọc · đang chuyển riêng trang này sang Gemini…)$/u.test(line)),statuses.join(' | '));
  assert.match(await page.inputValue('#source'),/空间向量的概念/u);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
// The device's reading of a scanned page with a figure, served in place of local-ocr.js: read well (Tiết kiệm sends it to
// no Gemini call), with a label inside the figure and its caption; document-figures.js finds that figure.
const DEVICE_LINES=[{id:'line-1',text:'第一课 空间向量的概念。今天我们学习平面方程和直线方程，老师在黑板上画了一个立体图形，同学们一起讨论两个平面的夹角。',box:{x:.08,y:.1,width:.84,height:.03},confidence:93},{id:'line-2',text:'PQR',box:{x:.46,y:.5,width:.06,height:.02},confidence:93},{id:'line-3',text:'图 1 立体图形',box:{x:.42,y:.78,width:.16,height:.02},confidence:93}];
const DEVICE_OCR=`import {structureLayoutBlocks} from './document-layout.js';import {assessLocalOcr} from './ocr-policy.js';
export const OCR_DOWNLOAD={paddle:{engine:'PaddleOCR',mb:29},tesseract:{engine:'Tesseract',mb:9}};
export async function ocrDownload(){return {cached:true};}
export function fallbackNotice(){return '';}
export async function terminateLocalOcr(){}
export async function recognizeChinesePage(){const layout={engine:'paddle',width:1240,height:1754,...structureLayoutBlocks(${JSON.stringify(DEVICE_LINES)}),confidence:93,metrics:{}};return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'paddle',metrics:{}};}`;
const FIGURES=`export function detectDocumentFigures(){return [];}
export async function extractPageFigures(){return [{box:{x:.3,y:.4,width:.4,height:.42},caption:'图 1 立体图形',blob:new Blob(['x'],{type:'image/png'})}];}`;
test('A scanned page with a figure keeps the reading Gemini made of it (Kỹ nhất); only the device\'s reading has the labels inside the figure cut out (Tiết kiệm)',{skip,timeout:120000},async()=>{
 const ID='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a82',GEMINI='第一课 空间向量的概念\n如图 1，点 P、Q、R 都在同一个平面上。';
 for(const mode of ['economy','premium']){
  const forms=[],{context,page,errors}=await openStudy((path,method,json)=>{
   if(path==='/api/my/study/pdf-layout/config')return {configured:false};
   if(path==='/api/my/study/history'&&method==='POST')return {id:ID,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};
   if(path===`/api/my/study/history/${ID}`&&method==='PUT')return {id:ID,status:'complete',libraryStoryId:null,updatedAt:now(),revision:2};
   if(path==='/api/my/study/ocr'){forms.push(json.get('mode'));return {text:GEMINI,usage:{prompt:900,output:60,thinking:0,total:960,requests:1},warnings:[]};}
   if(path==='/api/my/study/translate')return {translation:'Bài 1: khái niệm vectơ trong không gian.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};
  },{init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}}),modules:{'/local-ocr.js':DEVICE_OCR,'/document-figures.js':FIGURES}});
  try{
   await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
   await page.fill('#content-title','Bài scan có hình');await page.fill('#api-key',KEY);await page.selectOption('#mode',mode);
   await page.setInputFiles('#source-file',{name:'bai-scan.pdf',mimeType:'application/pdf',buffer:await scannedPdf(page)});
   await page.waitForFunction(()=>/trang scan/u.test(document.querySelector('#file-status').textContent),null,{timeout:30000});
   await page.click('#translate');await waitProgress(page,/^Hoàn tất/u);
   assert.match(await page.textContent('#file-status'),/· 1 hình được tách từ bản gốc/u,'the figure was found');
   const source=await page.inputValue('#source');
   if(mode==='premium'){assert.deepEqual(forms,['premium'],'Gemini read the page once');assert.equal(source,GEMINI,'the reading paid for is the one translated');}
   else{assert.deepEqual(forms,[],'a page the device read well costs no OCR call');assert.equal(source,`${DEVICE_LINES[0].text}\n\n${DEVICE_LINES[2].text}`,'the label inside the figure is cut, its caption kept');}
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
});

// A PDF read as text on the study page (frontend/pdf-client.js analyzePdf, then prepare): a searchable scan, whose PDF
// text layer is its own hidden OCR text, is read from its picture and keeps that layer where the device's reading holds
// fewer Han, gaining the lines the reading adds; Han drawn as a picture on a page of text is read on the device and set
// where it stands. The device's reading is served in place of local-ocr.js (the page, or a cropped region: told apart
// by the image's height), and no figure is cut out.
const LAYER=[BODY,BODY2,BODY,BODY2],PICTURED='第四章 水的循环与人类活动';
const READER=`import {structureLayoutBlocks} from './document-layout.js';import {assessLocalOcr} from './ocr-policy.js';
export const OCR_DOWNLOAD={paddle:{engine:'PaddleOCR',mb:29},tesseract:{engine:'Tesseract',mb:9}};
export async function ocrDownload(){return {cached:true};}
export function fallbackNotice(){return '';}
export function missedNotice(cells){return 'khoảng '+cells+' chữ chưa đọc được';}
export async function terminateLocalOcr(){}
const PAGE=${JSON.stringify(['第三章 归乡',BODY,BODY2.replace('河水','河木'),BODY,BODY2])},REGION=${JSON.stringify([PICTURED])};
export async function recognizeChinesePage(blob){const {height}=await createImageBitmap(blob),lines=height>600?PAGE:REGION;const layout={engine:'paddle',width:1240,height:1754,...structureLayoutBlocks(lines.map((text,i)=>({id:'line-'+(i+1),text,box:{x:.08,y:.1+i*.05,width:.84,height:.03},confidence:93}))),confidence:93,metrics:{}};return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'paddle',metrics:{}};}`;
const NO_FIGURES=`export function detectDocumentFigures(){return [];}
export async function extractPageFigures(){return [];}`;
async function searchablePdf(){
 const heading=png((()=>{const img=image(320,40);glyphs(img,{x:10,y:8,size:24,count:9});return img;})()),doc=await PDFDocument.create();
 let page=doc.addPage([W,H]),font=chineseFont(doc,page,'S');await drawScan(doc,page);LAYER.forEach((line,l)=>write(page,font,11,60,640-l*26,line,{mode:3}));
 page=doc.addPage([W,H]);font=chineseFont(doc,page,'T');page.drawImage(await doc.embedPng(heading),{x:140,y:760,width:320,height:40});for(let l=0;l<12;l++)write(page,font,11,60,650-l*22,l%2?BODY2:BODY);
 return Buffer.from(await doc.save());
}
test('A searchable scan read as text keeps its own OCR layer and gains the lines the device reads more; a heading drawn as a picture is read on the device and set where it stands; what the checks still find is named by its page',{skip,timeout:150000},async()=>{
 const ID='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a83',sent=[],{context,page,errors}=await openStudy((path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/config')return {configured:false};
  if(path==='/api/my/study/history'&&method==='POST')return {id:ID,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};
  if(path===`/api/my/study/history/${ID}`&&method==='PUT')return {id:ID,status:'complete',libraryStoryId:null,updatedAt:now(),revision:2};
  if(path==='/api/my/study/ocr')throw new Error('the device read every page: no Gemini OCR');
  // What the server's checks still find in a part is named by the part's page (backend/ai.js textProblems: "Đoạn k: …").
  if(path==='/api/my/study/translate'){sent.push(json.source);return {translation:'Bản dịch.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:sent.length===1?['Đoạn 1: còn chữ Hán chưa dịch: 归乡','Thuật ngữ mới cần xem lại.']:[]};}
 },{init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}}),modules:{'/local-ocr.js':READER,'/document-figures.js':NO_FIGURES}});
 try{
  await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
  await page.fill('#content-title','Sách có trang scan tìm được chữ');await page.fill('#api-key',KEY);await page.selectOption('#mode','economy');
  await page.setInputFiles('#source-file',{name:'sach.pdf',mimeType:'application/pdf',buffer:await searchablePdf()});
  await page.waitForFunction(()=>/trang scan/u.test(document.querySelector('#file-status').textContent),null,{timeout:60000});
  assert.match(await page.textContent('#file-status'),/^1 trang có lớp chữ · 1 trang scan \(1 trang có lớp chữ không khớp ảnh trang nên sẽ được đọc lại từ ảnh\)\. Đang chọn 1-2;/u);
  await page.click('#translate');await waitProgress(page,/^Hoàn tất/u,120000);
  const [scan,text]=(await page.inputValue('#source')).split('\n\n');
  assert.equal(scan,['第三章 归乡',...LAYER].join('\n'),'the layer\'s own lines stay (a character the device misread changes nothing) and the title it lacked is added');
  assert.equal(text.split('\n')[0],PICTURED,'the pictured heading is read and set above the text it heads');assert.match(text,new RegExp(BODY,'u'));
  const notes=await page.textContent('#warnings');
  assert.match(notes,/Trang 1: lớp chữ có sẵn của PDF là chữ nhận dạng nằm ẩn dưới ảnh scan nên trang được đọc lại từ ảnh\./u);
  assert.match(notes,/Trang 1: lớp chữ nhận dạng sẵn trong PDF thiếu khoảng \d+ chữ so với ảnh trang; đã thêm các dòng đó từ bản nhận dạng lại\./u);
  assert.match(notes,/Trang 2: khoảng 9 chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh\./u);
  assert.match(notes,/^Trang 1 · đoạn 1: còn chữ Hán chưa dịch: 归乡$/mu);assert.match(notes,/^Trang 1: Thuật ngữ mới cần xem lại\.$/mu);
  assert.ok(sent.join('\n').includes(PICTURED),'the reading reaches the translation');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// The device's reader served in place of local-ocr.js: a page reads weakly, and a cropped region (told apart by the
// image's height) makes the reader itself fail.
const FAILING=`import {structureLayoutBlocks} from './document-layout.js';import {assessLocalOcr} from './ocr-policy.js';
export const OCR_DOWNLOAD={paddle:{engine:'PaddleOCR',mb:29},tesseract:{engine:'Tesseract',mb:9}};
export async function ocrDownload(){return {cached:true};}
export function fallbackNotice(){return '';}
export function missedNotice(cells){return 'khoảng '+cells+' chữ chưa đọc được';}
export async function terminateLocalOcr(){}
export async function recognizeChinesePage(blob){const {height}=await createImageBitmap(blob);if(height<=600)throw new Error('the device reader failed');const layout={engine:'paddle',width:1240,height:1754,...structureLayoutBlocks([{id:'line-1',text:'第一课',box:{x:.1,y:.3,width:.3,height:.03},confidence:90}]),confidence:90,metrics:{}};return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'paddle',metrics:{}};}`;
// A history kept here: saves, the list and a session opened again.
function historyStore(ID){
 const store={state:null,api(path,method,json){
  if(path==='/api/my/study/history'&&method==='POST'||path===`/api/my/study/history/${ID}`&&method==='PUT'){store.state=structuredClone(json.state);const complete=json.state.done===json.state.parts.length;return {id:ID,status:complete?'complete':'translating',libraryStoryId:null,updatedAt:now(),revision:method==='POST'?1:2};}
  const row=()=>({id:ID,title:'Sách scan',filename:'sach-scan.pdf',domain:'general',mode:'premium',status:'complete',translated_parts:store.state.done,total_parts:store.state.parts.length,library_story_id:null,library_chapter_id:'chapter-1',created_at:'2026-10-30 01:00:00',updated_at:'2026-10-30 01:00:00',revision:2});
  if(path==='/api/my/study/history'&&method==='GET')return store.state?[row()]:[];
  if(path===`/api/my/study/history/${ID}`&&method==='GET')return {...row(),state:store.state};
 }};
 return store;
}
// D8 for pages read from their image: a line repeated at the same edge of three pages or more (a running head or foot) is
// kept where it first appears and dropped where it repeats; headings and body lines stay. Gemini's [đầu trang]/[chân
// trang] marks (the OCR answer's marked text) make the edge firm, so a running head that reads like a heading goes too;
// without them the first and last lines are only a guess, and a heading-like one stays. The notes the checks leave on a
// text session ("Trang N · đoạn k: …") are saved with it and named again when it is opened again.
test('Pages read from their image keep a running head or foot once (firm where Gemini marked it); the checks\' notes of a text session come back with it',{skip,timeout:180000},async()=>{
 const ID='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a84',doc=await PDFDocument.create();for(let n=0;n<4;n++)await drawScan(doc,doc.addPage([W,H]));const pdf=Buffer.from(await doc.save());
 const lines=n=>[`[đầu trang] 第一章 集合与函数概念`,`第${n}节 集合的含义`,`第${n}页正文：学而时习之，不亦说乎。`,'[chân trang] 人民教育出版社'];
 const body=n=>[`第${n}节 集合的含义`,`第${n}页正文：学而时习之，不亦说乎。`];
 for(const marked of [true,false]){
  const history=historyStore(ID),{context,page,errors}=await openStudy((path,method,json)=>{
   if(path==='/api/my/study/pdf-layout/config')return {configured:false};
   if(path==='/api/my/study/ocr'){const n=Number(/page-(\d+)\./u.exec(json.get('image').name)[1]),text=lines(n).join('\n');return {text:text.replace(/\[(?:đầu|chân) trang\] /gu,''),...(marked?{marked:text}:{}),usage:{prompt:900,output:60,thinking:0,total:960,requests:1},warnings:[]};}
   if(path==='/api/my/study/translate')return {translation:'Bản dịch.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:/第1页/u.test(json.source)?['Đoạn 2: còn chữ Hán chưa dịch: 集合']:[]};
   return history.api(path,method,json);
  },{init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}}),modules:{'/local-ocr.js':FAILING,'/document-figures.js':NO_FIGURES}});
  try{
   await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
   await page.fill('#content-title','Sách scan');await page.fill('#api-key',KEY);await page.selectOption('#mode','premium');
   await page.setInputFiles('#source-file',{name:'sach-scan.pdf',mimeType:'application/pdf',buffer:pdf});
   await page.waitForFunction(()=>/trang scan/u.test(document.querySelector('#file-status').textContent),null,{timeout:60000});await page.fill('#page-range','1-4');
   await page.click('#translate');await waitProgress(page,/^Hoàn tất/u,150000);
   const pages=(await page.inputValue('#source')).split('\n\n');
   assert.deepEqual(pages,marked?[['第一章 集合与函数概念',...body(1),'人民教育出版社'].join('\n'),...[2,3,4].map(n=>body(n).join('\n'))]:[['第一章 集合与函数概念',...body(1),'人民教育出版社'].join('\n'),...[2,3,4].map(n=>['第一章 集合与函数概念',...body(n)].join('\n'))]);
   assert.match(await page.textContent('#warnings'),/^Trang 1 · đoạn 2: còn chữ Hán chưa dịch: 集合$/mu);assert.deepEqual(errors,[]);
  }finally{await context.close();}
  if(!marked)break;
  // Opened again from the history (a reload, another device): the notes are named again.
  const again=await openStudy(history.api);
  try{
   await again.page.click('#study-history > summary');await again.page.click(`[data-history-open="${ID}"]`);await waitProgress(again.page,/Bản dịch đã hoàn tất/u);
   assert.equal(await again.page.textContent('#warnings'),'Trang 1 · đoạn 2: còn chữ Hán chưa dịch: 集合\n');assert.deepEqual(history.state.notes,['Trang 1 · đoạn 2: còn chữ Hán chưa dịch: 集合']);assert.deepEqual(again.errors,[]);
  }finally{await again.context.close();}
 }
});

// A region of Han drawn as a picture on a page of text that the device's reader fails on (not only reads nothing) is read
// by Gemini when a key is there, as the comment of prepare() says, instead of staying unread.
test('A pictured heading the device reader fails on is read by Gemini, set where it stands',{skip,timeout:150000},async()=>{
 const ID='5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a85',forms=[],heading=png((()=>{const img=image(320,40);glyphs(img,{x:10,y:8,size:24,count:9});return img;})()),doc=await PDFDocument.create();
 const sheet=doc.addPage([W,H]),font=chineseFont(doc,sheet,'T');sheet.drawImage(await doc.embedPng(heading),{x:140,y:760,width:320,height:40});for(let l=0;l<12;l++)write(sheet,font,11,60,650-l*22,l%2?BODY2:BODY);
 const pdf=Buffer.from(await doc.save()),{context,page,errors}=await openStudy((path,method,json)=>{
  if(path==='/api/my/study/pdf-layout/config')return {configured:false};
  if(path==='/api/my/study/history'&&method==='POST')return {id:ID,status:'draft',libraryStoryId:null,updatedAt:now(),revision:1};
  if(path===`/api/my/study/history/${ID}`&&method==='PUT')return {id:ID,status:'complete',libraryStoryId:null,updatedAt:now(),revision:2};
  if(path==='/api/my/study/ocr'){forms.push(json.get('mode'));return {text:PICTURED,usage:{prompt:300,output:20,thinking:0,total:320,requests:1},warnings:[]};}
  if(path==='/api/my/study/translate')return {translation:'Bản dịch.',context:'',glossary:{},usage:{prompt:10,output:5,total:15,requests:1},warnings:[]};
 },{init:()=>Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:false,effectiveType:'4g'}}),modules:{'/local-ocr.js':FAILING,'/document-figures.js':NO_FIGURES}});
 try{
  await page.waitForFunction(()=>/chưa được cấu hình/u.test(document.querySelector('#pdf-layout-service-status').textContent));
  await page.fill('#content-title','Trang có tiêu đề vẽ');await page.fill('#api-key',KEY);await page.selectOption('#mode','economy');
  await page.setInputFiles('#source-file',{name:'tieu-de.pdf',mimeType:'application/pdf',buffer:pdf});
  await page.waitForFunction(()=>/có lớp chữ/u.test(document.querySelector('#file-status').textContent),null,{timeout:60000});
  await page.click('#translate');await waitProgress(page,/^Hoàn tất/u,120000);
  assert.deepEqual(forms,['economy'],'the region went to Gemini once');assert.equal((await page.inputValue('#source')).split('\n')[0],PICTURED);
  assert.doesNotMatch(await page.textContent('#warnings'),/chưa nhận dạng được/u);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
});
