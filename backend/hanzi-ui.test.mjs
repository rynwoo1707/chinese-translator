import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {buildDictionary} from './dictionary-build.js';

// The dictionary hooks of the study viewers in a real browser engine: tapping a block of the original PDF page (dual
// viewer) or an OCR region of a page image opens the lookup panel over that block's Chinese text, and a character of it
// shows pinyin and Hán Việt. The page wires the viewers the way study.js does. The modules, study.css and a small
// dictionary built from inline sources are served from memory and every other request is aborted, so nothing reaches
// /api, Gemini or the network. Skipped when Microsoft Edge is missing.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const ORIGIN='http://hoatri.test',MODULES=new Set(['pdf-dual-viewer.js','pdf-box-layout.js','math-text.js','study-layout-view.js','hanzi-lookup.js','hanzi-dict.js']);
const header=name=>`# ${name}\n#! format=ts\n#! charset=UTF-8\n`;
const dictionary=buildDictionary({builder:'test',sources:[],texts:{
 cedict:`${header('CC-CEDICT')}銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/\n銀 银 [yin2] /silver/\n行 行 [xing2] /to walk/\n行 行 [hang2] /row/\n我們 我们 [wo3 men5] /we/\n在 在 [zai4] /at/\n工作 工作 [gong1 zuo4] /to work/\n設 设 [she4] /to suppose/\n直線 直线 [zhi2 xian4] /straight line/\n與 与 [yu3] /and/\n平面 平面 [ping2 mian4] /plane (flat surface)/\n垂直 垂直 [chui2 zhi2] /perpendicular/\n`,
 cvdict:`${header('CVDICT')}銀行 银行 [yin2 hang2] /ngân hàng/LT:家[jia1],個|个[ge4]/\n直線 直线 [zhi2 xian4] /đường thẳng/\n平面 平面 [ping2 mian4] /mặt phẳng/\n`,
 hanviet:"char,hanviet,pinyin\n銀,['ngân'],*\n行,\"['hành', 'hạnh']\",xing2\n行,\"['hàng', 'hạng']\",hang2\n工,['công'],*\n作,['tác'],zuo4\n直,['trực'],*\n線,['tuyến'],*\n平,['bình'],*\n面,['diện'],*\n垂,['thùy'],*\n",
 hanvietLicense:'MIT',radicals:'144; 2F8F; 884C\n',unihanReadings:'U+884C\tkMandarin\txíng\n',unihanVariants:'',unihanIrg:'U+884C\tkRSUnicode\t144.0\nU+884C\tkTotalStrokes\t6\n'
}});
// One page with prose, a formula-only block and a maths sentence holding an inline formula; the OCR reading of the same
// page for the aligned original view (boxes as fractions of the page there).
const FIXTURE={width:300,height:200,blocks:[
 {id:'p1-b1',source:'我们在银行工作。',text:'我们在银行工作。',box:[20,20,220,50],fontSize:14,color:'#202020',inlines:[]},
 {id:'p1-b2',source:'x+y=2',text:'x+y=2',box:[20,70,120,90],fontSize:14,color:'#202020',inlines:[]},
 {id:'p1-b3',source:'设直线@@PDF_INLINE_1@@与平面垂直',text:'',box:[20,110,280,140],fontSize:14,color:'#202020',inlines:[]}
],ocr:['我们在银行工作。','x+y=2','设直线l与平面α垂直']};
const studyCss=read('frontend/study.css').replace(/^@import[^;]*;/gmu,'');
// study.css positions the regions over the original PDF page (dictionary integration note 7). Until those rules land the
// phone test of the dual viewer runs as a todo: its result shows without failing the suite.
const regionRules=/\.pdf-source-region\b/u.test(studyCss)?false:'needs the .pdf-source-region rules (dictionary integration note 7) in frontend/study.css';
const PAGE=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/study.css"></head><body><main><div id="pdf-dual-viewer" class="pdf-dual-viewer" hidden></div><div id="translation-parts" class="translation-parts"><details class="translation-part done" open><summary><span>Trang 1 · Phần 01</span></summary><div class="translation-pair has-original comparing"><div class="part-originals" id="part-originals-0"></div><div class="translation-part-text"><article class="translation-document"><p>Chúng tôi làm việc ở ngân hàng.</p></article></div></div></details></div></main></body></html>`;
let browser=null;try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());

// Runs in the page: draws the original page, then wires both viewers as study.js does (dictionary integration notes 2b,
// 2e and 2f).
async function wireViewers({width,height,blocks,ocr}){
 const [{PdfDualViewer},{originalPageView},{attachHanziLookup,openHanziPanel}]=await Promise.all(['/pdf-dual-viewer.js','/study-layout-view.js','/hanzi-lookup.js'].map(path=>import(path)));
 const canvas=document.createElement('canvas'),g=canvas.getContext('2d');canvas.width=width*2;canvas.height=height*2;
 g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);g.fillStyle='#202020';g.font='28px serif';g.textBaseline='top';
 blocks.forEach((b,i)=>g.fillText(ocr[i],b.box[0]*2,b.box[1]*2+12));
 const image=canvas.toDataURL('image/png'),OCR_NOTE='Đoạn này nhận dạng từ ảnh (OCR) và chưa được đọc lại; chữ có thể sai, hãy đối chiếu với trang gốc.';
 const dualViewer=globalThis.dualViewer=new PdfDualViewer(document.querySelector('#pdf-dual-viewer'));
 dualViewer.onSourceBlock=(block,page,region)=>openHanziPanel({text:block.text||block.source,title:`Nguyên tác · Trang ${page.number} · Đoạn ${page.blocks.indexOf(block)+1}`,note:page.ocr&&!block.ocrCorrected?OCR_NOTE:'',returnFocus:region});
 const entry={engine:'tesseract',confidence:91,layout:{blocks:blocks.map((b,i)=>({text:ocr[i],box:{x:b.box[0]/width,y:b.box[1]/height,width:(b.box[2]-b.box[0])/width,height:(b.box[3]-b.box[1])/height}}))}};
 document.querySelector('#part-originals-0').append(originalPageView(1,{url:image},entry,{onRegion:(block,region)=>openHanziPanel({text:block.text,title:'Nguyên tác · Trang 1',note:['paddle','tesseract','gemini'].includes(entry?.engine)?OCR_NOTE:'',returnFocus:region})}));
 attachHanziLookup(document.querySelector('#translation-parts'),{selector:'.region-description[lang|="zh"],.translation-document'});
 attachHanziLookup(document.querySelector('#pdf-dual-viewer'),{selector:'[data-hanzi-lookup]'});
 await dualViewer.setDocument({version:1,pages:[{number:1,width,height,original:image,background:image,blocks}]},[]);
}
async function open(options){
 const context=await browser.newContext({reducedMotion:'reduce',...options}),page=await context.newPage(),requests=[],errors=[];
 page.setDefaultTimeout(5000);
 // "Failed to load resource" is the browser reporting a request this test aborts on purpose (study.css's background).
 page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource/u.test(message.text()))errors.push(message.text());});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url()),path=url.pathname,{base}=dictionary.manifest;requests.push({href:url.href,type:route.request().resourceType()});
  const file=url.origin!==ORIGIN?null:path==='/'?['text/html',PAGE]:path==='/study.css'?['text/css',studyCss]:MODULES.has(path.slice(1))?['text/javascript',read(`frontend${path}`)]:path==='/vendor/dict/manifest.json'?['application/json',JSON.stringify(dictionary.manifest)]:path.startsWith(base)&&dictionary.files.has(path.slice(base.length))?['application/json',dictionary.files.get(path.slice(base.length))]:null;
  return file?route.fulfill({contentType:`${file[0]}; charset=utf-8`,body:file[1]}):route.abort();
 });
 await page.goto(`${ORIGIN}/`);await page.evaluate(wireViewers,FIXTURE);
 return {page,close:()=>context.close(),checkTraffic:()=>{
  const data=requests.filter(({type})=>type==='fetch'||type==='xhr').map(({href})=>href);
  assert.deepEqual(data.filter(href=>!href.startsWith(`${ORIGIN}/vendor/dict/`)),[],'lookups read only the offline dictionary: no /api, no Gemini');
  assert.ok(data.some(href=>href.startsWith(`${ORIGIN}${dictionary.manifest.base}`)));
  assert.deepEqual(requests.filter(({href})=>new URL(href).pathname.startsWith('/api/')),[]);
  assert.deepEqual(errors,[]);
 }};
}
const PHONE={viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2};
const text=(page,selector)=>page.$eval(selector,node=>node.textContent);
// The card once it shows `word`: the headword, then the first reading's pinyin and Hán Việt.
async function card(page,word){
 await page.waitForFunction(word=>document.querySelector('#hanzi-panel .hz-word')?.textContent===word,word);
 return page.$eval('#hanzi-panel',panel=>({word:panel.querySelector('.hz-word').textContent,pinyin:panel.querySelector('.hz-pinyin')?.textContent,hanViet:panel.querySelector('.hz-hv b')?.textContent}));
}
const stripChar=(page,char)=>page.locator('#hanzi-panel .hz-strip .hz-c').filter({hasText:new RegExp(`^${char}$`,'u')});
// Client coordinates of the first `char` in the text of `selector`, scrolled into view.
const charPoint=(page,selector,char)=>page.$eval(selector,(root,char)=>{
 root.scrollIntoView({block:'center'});const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){const at=node.nodeValue.indexOf(char);if(at<0)continue;const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+char.length);const box=range.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};}
 return null;
},char);
// The sheet stays on screen and the page never scrolls sideways.
const sheetFits=page=>page.$eval('#hanzi-panel',panel=>{const box=panel.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight&&document.documentElement.scrollWidth<=document.documentElement.clientWidth;});

test('Enter on a block of the original PDF page opens the lookup over its Chinese text; a character shows pinyin and Hán Việt',{skip},async()=>{
 const {page,close,checkTraffic}=await open({viewport:{width:1280,height:900}});
 const regions=await page.$$eval('[data-pdf-original] .pdf-source-region',nodes=>nodes.map(node=>[node.dataset.sourceBlock,node.getAttribute('aria-label'),node.getAttribute('aria-pressed')]));
 assert.deepEqual(regions,[['p1-b1','Đoạn 1: 我们在银行工作。','false'],['p1-b3','Đoạn 3: 设直线 与平面垂直','false']],'one region per block with Chinese text, none for the formula');
 await page.focus('[data-source-block="p1-b1"]');await page.keyboard.press('Enter');
 await page.waitForSelector('#hanzi-panel:not([hidden])');
 assert.equal(await text(page,'#hanzi-panel-title'),'Nguyên tác · Trang 1 · Đoạn 1');
 assert.equal(await text(page,'#hanzi-panel .hz-strip'),'我们在银行工作。');
 assert.equal(await page.getAttribute('[data-source-block="p1-b1"]','aria-pressed'),'true');
 // The focus starts on the strip's first character: four steps right is 行.
 for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Enter');
 assert.deepEqual(await card(page,'银行'),{word:'银行',pinyin:'yínháng',hanViet:'ngân hàng'});
 // A translated batch re-renders the page under the open panel: the block stays pressed and gets the focus back.
 assert.deepEqual(await page.evaluate(async()=>{const old=document.querySelector('#pdf-source-p1-b1');await globalThis.dualViewer.update([{id:'p1-b1',translation:'Chúng tôi làm việc ở ngân hàng.'}]);return [old.isConnected,document.querySelector('#pdf-source-p1-b1').getAttribute('aria-pressed')];}),[false,'true']);
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'pdf-source-p1-b1','Escape gives the focus back to the region');
 assert.ok(await page.isHidden('#hanzi-panel'));
 // Another block: inline formula tokens show as "…", and only the block being looked up stays pressed.
 await page.focus('[data-source-block="p1-b3"]');await page.keyboard.press('Enter');
 await page.waitForSelector('#hanzi-panel:not([hidden])');
 assert.equal(await text(page,'#hanzi-panel-title'),'Nguyên tác · Trang 1 · Đoạn 3');
 assert.equal(await text(page,'#hanzi-panel .hz-strip'),'设直线…与平面垂直');
 assert.deepEqual(await page.$$eval('[data-source-block]',nodes=>nodes.map(node=>node.getAttribute('aria-pressed'))),['false','true']);
 await page.keyboard.press('Escape');
 // The block editor shows the Chinese source of a block; a plain click on a character looks its word up.
 await page.click('.pdf-block-editor summary');
 const point=await charPoint(page,'[data-pdf-edit-source]','行');await page.mouse.click(point.x,point.y);
 assert.deepEqual(await card(page,'银行'),{word:'银行',pinyin:'yínháng',hanViet:'ngân hàng'});
 checkTraffic();await close();
});

test('On a phone, tapping an OCR region of a page image opens the lookup; a formula-only region just shows its text',{skip},async()=>{
 const {page,close,checkTraffic}=await open(PHONE);
 const regions=page.locator('.aligned-original .ocr-region'),description='.aligned-original .region-description';
 assert.equal(await text(page,description),'Chạm vào vùng chữ để xem nguyên tác và tra chữ Hán.');
 await regions.nth(1).tap();
 assert.equal(await text(page,description),'x+y=2');
 assert.equal(await page.locator('#hanzi-panel:not([hidden])').count(),0,'nothing to look up in a formula');
 await regions.nth(0).tap();
 await page.waitForSelector('#hanzi-panel:not([hidden])');
 assert.equal(await text(page,'#hanzi-panel-title'),'Nguyên tác · Trang 1');
 assert.equal(await text(page,'#hanzi-panel .hz-strip'),'我们在银行工作。');
 assert.deepEqual(await page.$eval(description,node=>[node.lang,node.textContent]),['zh','我们在银行工作。']);
 await stripChar(page,'行').tap();
 assert.deepEqual(await card(page,'银行'),{word:'银行',pinyin:'yínháng',hanViet:'ngân hàng'});
 assert.ok(await sheetFits(page),'the sheet fits a 390 px screen');
 await page.locator('#hanzi-panel .hz-close').tap();
 // The region's text under the image is Chinese now: tapping one of its characters looks the word up in place.
 const point=await charPoint(page,description,'工');await page.touchscreen.tap(point.x,point.y);
 assert.deepEqual(await card(page,'工作'),{word:'工作',pinyin:'gōngzuò',hanViet:'công tác'});
 assert.ok(await page.evaluate(()=>CSS.highlights.has('hanzi-lookup')),'the word is highlighted on the page');
 checkTraffic();await close();
});

test('On a phone, a tap on a block of the original PDF page lands on its region and shows pinyin and Hán Việt',{skip,todo:regionRules},async()=>{
 const {page,close,checkTraffic}=await open(PHONE);
 // Each region covers its block: PDF points × 4/3 px × zoom from the page frame's corner, at every zoom.
 const geometry=()=>page.$eval('[data-pdf-original] .pdf-page-frame',frame=>{
  const origin=frame.getBoundingClientRect(),scale=4/3*Number(document.querySelector('[data-pdf-zoom]').value);
  return [...frame.querySelectorAll('.pdf-source-region')].map(node=>{const box=node.getBoundingClientRect();return [node.dataset.sourceBlock,...[box.left-origin.left,box.top-origin.top,box.right-origin.left,box.bottom-origin.top].map(value=>Math.round(value/scale*2)/2)];});
 });
 const expected=FIXTURE.blocks.filter(b=>b.id!=='p1-b2').map(b=>[b.id,...b.box]);
 assert.deepEqual(await geometry(),expected);
 // The middle of the third block's text hits its region, not the page image under it.
 const [x0,y0,x1,y1]=FIXTURE.blocks[2].box,target=await page.$eval('[data-pdf-original] .pdf-page-frame',(frame,[x,y])=>{frame.scrollIntoView({block:'center'});const origin=frame.getBoundingClientRect(),scale=4/3*Number(document.querySelector('[data-pdf-zoom]').value),point={x:origin.left+x*scale,y:origin.top+y*scale};return {...point,hit:document.elementFromPoint(point.x,point.y)?.dataset.sourceBlock};},[(x0+x1)/2,(y0+y1)/2]);
 assert.equal(target.hit,'p1-b3');
 await page.touchscreen.tap(target.x,target.y);
 await page.waitForSelector('#hanzi-panel:not([hidden])');
 assert.equal(await text(page,'#hanzi-panel-title'),'Nguyên tác · Trang 1 · Đoạn 3');
 assert.equal(await text(page,'#hanzi-panel .hz-strip'),'设直线…与平面垂直');
 await stripChar(page,'平').tap();
 assert.deepEqual(await card(page,'平面'),{word:'平面',pinyin:'píngmiàn',hanViet:'bình diện'});
 assert.ok(await sheetFits(page),'the sheet fits a 390 px screen');
 await page.locator('#hanzi-panel .hz-close').tap();
 await page.selectOption('[data-pdf-zoom]','1.25');
 await page.waitForFunction(()=>document.querySelector('[data-pdf-original] .pdf-page-frame')?.style.width==='500px');
 assert.deepEqual(await geometry(),expected,'the regions follow the zoom');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'a zoomed page scrolls inside the viewer, not the page');
 checkTraffic();await close();
});
