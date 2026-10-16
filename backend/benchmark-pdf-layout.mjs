import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {pythonOperation,renderDocument,fontCss} from '../services/pdf-layout/engine.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),output=resolve(root,'tmp/pdf-layout');await mkdir(output,{recursive:true});
await new Promise((resolve,reject)=>{const child=spawn('python',[`${root}services/pdf-layout/fixture.py`,output],{windowsHide:true,env:{...process.env,PYTHONPATH:`${root}.runtime/pdf-python`,PYTHONUTF8:'1'}});child.stderr.on('data',c=>process.stderr.write(c));child.on('error',reject);child.on('close',c=>c===0?resolve():reject(new Error('Fixture generation failed')));});
const source=await readFile(resolve(output,'source.pdf')),extracted=await pythonOperation({pdfBase64:source.toString('base64'),pages:'1-2'}),doc=extracted.document;
assert.equal(doc.pages.length,2);assert.equal(doc.pages[0].width,595);assert.equal(doc.pages[1].width,650);assert.ok(doc.pages[0].drawings.length);assert.ok(doc.pages[0].images.length);assert.ok(doc.pages[0].blocks.some(b=>b.inlines.length),'inline mathematics must be isolated');
const translatedText=b=>{
 if(b.source.includes('图'))return 'Hình 1.1-2';
 if(b.source.includes('1.1'))return '1.1 Vectơ trong không gian';
 if(b.source.includes('第二节'))return '2. Vectơ song song';
 if(b.source.includes('向量的长度'))return `Độ dài vectơ ${(b.source.match(/@@PDF_INLINE_\d+@@/gu)||[]).join(' ')}`;
 if(b.source.includes('两个向量所在'))return 'Hai vectơ có giá song song hoặc trùng nhau được gọi là vectơ cùng phương. Vectơ không cùng phương với mọi vectơ.';
 return 'Vectơ trong không gian có độ lớn và hướng. Hai vectơ bằng nhau có cùng độ lớn và cùng hướng. Đoạn thẳng có hướng biểu diễn vectơ với điểm đầu A và điểm cuối B.';
};
const translations=doc.pages.flatMap(p=>p.blocks).map(b=>({id:b.id,translation:translatedText(b)})),rendered=await renderDocument(doc,translations);let pdf=Buffer.from(rendered.pdfBase64,'base64');assert.ok(pdf.subarray(0,5).toString()==='%PDF-');assert.ok(rendered.report.every(p=>p.blocks.every(b=>!b.overflow)));await writeFile(resolve(output,'translated.pdf'),pdf);await writeFile(resolve(output,'report.json'),JSON.stringify({pages:doc.pages.map(p=>({page:p.number,blocks:p.blocks.map(b=>({id:b.id,source:b.source,box:b.box,inlines:b.inlines.map(i=>i.token)}))})),fontReport:rendered.report},null,2));
await assert.rejects(()=>renderDocument(doc,translations.map((b,i)=>i?b:{...b,translation:'Nội dung dài không vừa box. '.repeat(200)})),/không vừa box/);
let stored=null,calls=0,exports=0;
const assetId='11111111-1111-4111-8111-111111111111',historyId='history-pdf',prefix='/api/my/study/pdf-layout';
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname,json=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  const body=async()=>{let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw);};
  if(path==='/api/me')return json({authenticated:true,user:{name:'Lan'}});
  if(path==='/api/my/study/models')return json({models:[{id:'gemini-3.6-flash',name:'Gemini 3.6 Flash'}],requested:'gemini-3.6-flash',selected:'gemini-3.6-flash'});
  if(path===prefix+'/config')return json({configured:true});
  if(path===prefix+'/font')return json({css:await fontCss()});
  if(path==='/api/my/study/history'&&req.method==='GET')return json(stored?[{id:historyId,title:stored.title,filename:stored.filename,domain:'math',mode:'economy',status:stored.state.done===translations.length?'complete':'translating',translated_parts:stored.state.done,total_parts:translations.length,updated_at:new Date().toISOString(),library_story_id:stored.state.done===translations.length?'private-story':null}]:[]);
  if(path===prefix+'/extract')return json({assetId,document:doc,originalUrl:prefix+`/assets/${assetId}/original`},201);
  if((path==='/api/my/study/history'&&req.method==='POST')||(path==='/api/my/study/history/'+historyId&&req.method==='PUT')){stored=await body();assert.doesNotMatch(JSON.stringify(stored),/local-test-key/);return json({id:historyId,status:stored.state.done===translations.length?'complete':'draft',libraryStoryId:stored.state.done===translations.length?'private-story':null,updatedAt:new Date().toISOString()});}
  if(path==='/api/my/study/history/'+historyId&&req.method==='GET')return json({id:historyId,title:stored.title,filename:stored.filename,domain:stored.domain,mode:stored.mode,state:stored.state});
  if(path===prefix+`/assets/${assetId}/manifest`)return json(doc);
  if(path==='/api/my/study/translate-blocks'){const value=await body();calls++;return json({blocks:value.blocks.map(b=>translations.find(t=>t.id===b.id)),usage:{total:0,requests:0},context:'',glossary:{}});}
  if(path===prefix+'/render'){exports++;if(exports>1){const updated=await renderDocument(doc,doc.pages.flatMap(p=>p.blocks).map((b,i)=>({id:b.id,translation:stored.state.translationParts[i]})));pdf=Buffer.from(updated.pdfBase64,'base64');}stored.state.pdfLayout.exported=true;stored.state.pdfLayout.renderVersion=2;return json({url:prefix+`/assets/${assetId}/translated`,report:rendered.report,renderVersion:2});}
  if(path===prefix+`/assets/${assetId}/translated`){res.setHeader('Content-Type','application/pdf');return res.end(pdf);}
  const frontend=resolve(root,'frontend'),target=resolve(frontend,'.'+decodeURIComponent(path));if(!target.startsWith(frontend+sep))throw new Error('Forbidden');res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[extname(target)]||'application/octet-stream');await stat(target);createReadStream(target).pipe(res);
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/study.html`);await page.waitForFunction(()=>document.querySelector('#pdf-layout-service-status').textContent.includes('từng block'));await page.locator('#source-file').setInputFiles(resolve(output,'source.pdf'));await page.waitForFunction(()=>document.querySelector('#file-status').textContent.includes('dịch theo block'));await page.locator('#content-title').fill('Vectơ trong không gian — kiểm thử PDF');await page.locator('#domain').selectOption('math');await page.locator('#api-key').fill('local-test-key-no-external-api');await page.locator('#translate').click();await page.waitForFunction(()=>document.querySelector('[data-pdf-render-state]')?.textContent==='PDF đã xuất',{},{timeout:90000});assert.equal(exports,1);assert.ok(calls>0);assert.ok(await page.locator('[data-pdf-translated] canvas').count());await page.locator('#pdf-dual-viewer').screenshot({path:resolve(output,'dual-desktop.png')});
 const downloadPromise=page.waitForEvent('download');await page.locator('#download-pdf').click();const download=await downloadPromise;await download.saveAs(resolve(output,'downloaded.pdf'));assert.equal(await stat(resolve(output,'downloaded.pdf')).then(r=>r.size),pdf.length);
 await page.reload();await page.waitForSelector('[data-history-open]');await page.locator('[data-history-open]').click();await page.waitForFunction(()=>document.querySelector('[data-pdf-render-state]')?.textContent==='PDF đã xuất');await page.locator('[data-pdf-next]').click();await page.waitForFunction(()=>document.querySelector('[data-pdf-page]').textContent.includes('Trang 2'));assert.equal(calls,1);assert.equal(errors.length,0,errors.join('; '));
 await page.locator('.pdf-block-editor summary').click();await page.locator('[data-pdf-edit-text]').fill('2. Các vectơ cùng phương');await page.locator('[data-pdf-edit-save]').click();await page.waitForFunction(()=>document.querySelector('#progress').textContent.includes('Đã lưu đoạn sửa'));assert.equal(stored.state.translationParts[4],'2. Các vectơ cùng phương');assert.equal(await page.locator('[data-pdf-render-state]').textContent(),'Bản xem trước');
 const revisedDownload=page.waitForEvent('download');await page.locator('#download-pdf').click();await revisedDownload;assert.equal(exports,2);assert.equal(calls,1,'Editing must not call Gemini again');assert.equal(await page.locator('[data-pdf-render-state]').textContent(),'PDF đã xuất');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('#pdf-dual-viewer').screenshot({path:resolve(output,'dual-mobile.png')});console.log('Real PyMuPDF + Puppeteer PDF and dual viewer passed: boxes, images/vectors, math tokens, mixed page sizes, download, account reload.');
}catch(error){for(const context of browser?.contexts()||[])for(const page of context.pages()){console.error(await page.evaluate(()=>({status:document.querySelector('#progress')?.textContent,file:document.querySelector('#file-status')?.textContent,config:document.querySelector('#pdf-layout-service-status')?.textContent})));await page.screenshot({path:resolve(output,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
