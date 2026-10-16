import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {pythonOperation} from '../services/pdf-layout/engine.mjs';

const output=resolve('tmp/pdf-preview');await mkdir(output,{recursive:true});
const source=await readFile(resolve('tmp/pdf-layout/source.pdf'));
const {document:layout}=await pythonOperation({pdfBase64:source.toString('base64'),pages:'1'});
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><style>body{margin:17px;font-family:Arial}.pdf-viewer-grid{display:flex;gap:10px}.pdf-viewer-grid>section{width:48%}.pdf-viewer-scroll{overflow:auto;height:600px}.pdf-page-frame{position:relative;flex:none}.pdf-page-frame>*{display:block}.pdf-viewer-toolbar{display:flex;justify-content:space-between}.pdf-viewer-toolbar small{display:block}textarea{width:100%}</style></head><body><main id="viewer"></main><script type="module">import {PdfDualViewer} from "/pdf-dual-viewer.js";window.viewer=new PdfDualViewer(document.querySelector("#viewer"));window.ready=true;</script></body></html>');return;}
  if(!['/pdf-dual-viewer.js','/pdf-box-layout.js','/math-text.js'].includes(pathname)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(resolve('frontend','.'+pathname)));
 }catch(error){res.statusCode=500;res.end(error.message);}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.ready);
 await page.evaluate(document=>viewer.setDocument(document),layout);
 assert.equal(await page.locator('[data-pdf-render-state]').textContent(),'Chưa có bản dịch');
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-box').count(),0);
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-mask').count(),0);
 assert.equal(await page.locator('[data-pdf-translated] .pdf-background').getAttribute('src'),layout.pages[0].original);
 assert.equal(await page.locator('[data-pdf-edit-text]').isDisabled(),true);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.body).margin),'17px');
 await page.locator('#viewer').screenshot({path:resolve(output,'original-pending.png')});
 const first=layout.pages[0].blocks[0],translation='1.1 Vectơ trong không gian';
 await page.evaluate(item=>viewer.update([item]),{id:first.id,translation});
 assert.equal(await page.locator('[data-pdf-render-state]').textContent(),'Đang dịch…');
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-box').count(),1);
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-mask').count(),1);
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-box').textContent(),translation);
 assert.equal(await page.locator('[data-pdf-edit-text]').isDisabled(),false);
 assert.equal(await page.locator('[data-pdf-edit-select] option:disabled').count(),layout.pages[0].blocks.length-1);
 const actual=await page.locator('[data-pdf-translated] .pdf-text-box').evaluate(el=>({x:el.offsetLeft,y:el.offsetTop,width:el.offsetWidth,height:el.offsetHeight}));
 assert.ok(Math.abs(actual.x-first.box[0]*4/3)<1);assert.ok(Math.abs(actual.width-(first.box[2]-first.box[0])*4/3)<1);
 await page.locator('#viewer').screenshot({path:resolve(output,'partial-translated.png')});
 await page.evaluate(item=>viewer.update([item]),{id:first.id,translation:'Nội dung quá dài. '.repeat(2000)});
 assert.equal(await page.locator('[data-pdf-translated] .pdf-text-box[data-overflow=true]').count(),1);
 assert.match(await page.locator('[data-pdf-notice]').textContent(),/1 block đã dịch/);
 assert.equal(errors.length,0,errors.join('; '));
 console.log('Browser preview passed: original bitmap before translation, partial completed masks, pending editor disabled, PDF point coordinates, scoped typography, translated-only overflow.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
