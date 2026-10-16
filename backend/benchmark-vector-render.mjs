// Offline regression for the exact combining-arrow notation in saved history.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {buildStudyHtml} from '../frontend/study-layout-view.js';
import {pageHtml,fitTextBoxes} from '../frontend/pdf-box-layout.js';
import {fontCss,renderDocument} from '../services/pdf-layout/engine.mjs';

const root=fileURLToPath(new URL('../frontend/',import.meta.url)),output=fileURLToPath(new URL('../tmp/pdfs/vector-render/',import.meta.url));
await mkdir(output,{recursive:true});
const text=String.raw`B, thì vectơ a cũng có thể ký hiệu là AB⃗, độ dài của nó ký hiệu là |a| hoặc |AB⃗|. Trong hình lập phương ở Hình 1.1-2, ba đoạn thẳng có hướng trên ba cạnh đi qua cùng một đỉnh O biểu diễn ba vectơ OA⃗, OB⃗, OC⃗, chúng là các vectơ không đồng phẳng.

Ký hiệu có chỉ số: \(\vec{a}_{1} + \overrightarrow{A_1B}^{2} = \vec b\). AB và OA là các điểm. Ký hiệu [□] chưa đọc rõ được giữ nguyên.`;
const title='Vectơ trong không gian – kiểm tra ký hiệu',book={id:'vectors',title,author:'Hoa Trí',genre:'Toán học',chapters:1};
const standalone=await buildStudyHtml({title,parts:[],translations:[],images:new Map(),combined:text});
await writeFile(resolve(output,'translated.html'),standalone);
const json=(res,value)=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/me')return json(res,{authenticated:true,user:{id:'student',name:'Lan'}});
  if(pathname==='/api/library'||pathname==='/api/my/library')return json(res,[book]);
  if(pathname==='/api/my/requests')return json(res,[]);
  if(pathname==='/api/read/vectors')return json(res,[{id:'vectors-1',title,content:text,mime:'text/plain'}]);
  if(pathname==='/translated.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(standalone);}
  const target=resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
  if(!target.startsWith(root.endsWith(sep)?root:root+sep))throw new Error('Forbidden');
  const info=await stat(target);if(!info.isFile())throw new Error('Not found');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',types[extname(target)]||'application/octet-stream');createReadStream(target).pipe(res);
 }catch(error){res.statusCode=404;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),origin=`http://127.0.0.1:${server.address().port}`,errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('https://**',route=>route.abort());
 await page.goto(origin+'/#library');await page.waitForSelector('.cover-trigger');
 await page.locator('.cover-trigger').click();assert.equal(await page.locator('.cover-trigger').getAttribute('aria-expanded'),'true');
 await page.locator('[data-read="vectors"]').click();await page.locator('#modal-form .primary').click();
 await page.waitForSelector('.reader .math-vector');assert.equal(await page.locator('.prose .math-vector').count(),8);
 assert.doesNotMatch(await page.locator('.prose').innerText(),/⃗|\\vec|\\overrightarrow/u);
 assert.match(await page.locator('.prose').innerText(),/AB và OA là các điểm/u);assert.match(await page.locator('.prose').innerText(),/\[□\]/u);
 const arrows=await page.locator('.prose .math-vector').evaluateAll(items=>items.map(item=>{const arrow=item.querySelector('svg').getBoundingClientRect(),label=item.querySelector('span').getBoundingClientRect();return {width:arrow.width,height:arrow.height,above:arrow.bottom<=label.top+1};}));
 assert.ok(arrows.every(arrow=>arrow.width>4&&arrow.height>1&&arrow.above));
 await page.locator('.reader').screenshot({path:resolve(output,'reader-desktop.png')});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('.reader').screenshot({path:resolve(output,'reader-mobile.png')});
 await page.goto(origin+'/translated.html');assert.equal(await page.locator('.translation-document .math-vector').count(),8);
 await page.locator('.translation-document').screenshot({path:resolve(output,'studio-html.png')});
 await page.setViewportSize({width:794,height:1123});await page.setContent('<html><body style="margin:0;background:white"></body></html>');
 const blank='data:image/png;base64,'+(await page.screenshot()).toString('base64');
 const document={version:1,extractionVersion:2,pages:[{number:1,width:595,height:842,background:blank,original:blank,blocks:[{id:'p1-b0',box:[36,36,559,220],fontSize:16,source:'原始向量',inlines:[]}]}]};
 const translations=[{id:'p1-b0',translation:text}],css=await fontCss();
 await page.setContent(pageHtml({...document.pages[0],extractionVersion:2},new Map(translations.map(b=>[b.id,b.translation])),css));await page.evaluate(()=>document.fonts.ready);
 const fit=await page.evaluate(`(${fitTextBoxes.toString()})(document)`);assert.ok(fit.every(block=>!block.overflow));
 assert.equal(await page.locator('.pdf-text-box .math-vector').count(),8);
 await page.locator('.pdf-paper').screenshot({path:resolve(output,'pdf-box.png')});
 const rendered=await renderDocument(document,translations,{title});assert.ok(rendered.report.every(entry=>entry.blocks.every(block=>!block.overflow)));
 await writeFile(resolve(output,'vectors.pdf'),Buffer.from(rendered.pdfBase64,'base64'));
 assert.deepEqual(errors,[]);console.log('Vector browser/PDF benchmark passed: saved U+20D7 history, library reader, mobile, HTML export, eight SVG arrows, scripts and PDF box fitting.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
