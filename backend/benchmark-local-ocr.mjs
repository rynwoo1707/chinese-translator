import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';

const file=process.argv[2];
if(!file)throw new Error('Dùng: npm run test:ocr -- "đường dẫn PDF" "9,39,59,80,110"');
const pages=(process.argv[3]||'9,39,59,80,110').split(',').map(Number);
assert.ok(pages.length<=10&&pages.every(n=>Number.isInteger(n)&&n>0));
const root=fileURLToPath(new URL('../frontend/',import.meta.url)),output=new URL('../tmp/ocr-benchmark/',import.meta.url);
await mkdir(output,{recursive:true});await stat(file);
let translationCalls=0,historyRecord=null;
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/me'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,user:{name:'Kiểm thử cục bộ'}}));return;}
  if(pathname==='/api/my/study/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{id:'gemini-3.6-flash',name:'Gemini 3.6 Flash'}],requested:'gemini-3.6-flash',selected:'gemini-3.6-flash'}));return;}
  if(pathname.startsWith('/api/')){
   res.setHeader('Content-Type','application/json');
   if(pathname==='/api/my/study/history'&&req.method==='GET'){res.end(JSON.stringify(historyRecord?[historyRecord]:[]));return;}
   if(pathname==='/api/my/study/history'&&req.method==='POST'||pathname.startsWith('/api/my/study/history/')&&req.method==='PUT'){
    let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw),done=payload.state.done,total=payload.state.parts.length,id=historyRecord?.id||'local-history';historyRecord={id,title:payload.title,filename:payload.filename,status:done===total?'complete':done?'translating':'draft',translated_parts:done,total_parts:total,library_story_id:done===total?'local-library':null,updated_at:new Date().toISOString()};res.statusCode=req.method==='POST'?201:200;res.end(JSON.stringify({id,status:historyRecord.status,libraryStoryId:historyRecord.library_story_id,updatedAt:historyRecord.updated_at}));return;
   }
   if(pathname==='/api/my/study/translate'){translationCalls++;res.end(JSON.stringify({translation:'Bản dịch mô phỏng để kiểm tra giao diện. Không gọi Gemini.',usage:{total:0,requests:0}}));return;}
   res.statusCode=500;res.end(JSON.stringify({error:'Không được gọi OCR Gemini trong kiểm thử cục bộ.'}));return;
  }
  const target=pathname==='/fixture.pdf'?resolve(file):resolve(root,'.'+decodeURIComponent(pathname));
  if(pathname!=='/fixture.pdf'&&!target.startsWith(root.endsWith(sep)?root:root+sep)){res.statusCode=403;res.end();return;}
  const types={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.pdf':'application/pdf','.svg':'image/svg+xml','.woff2':'font/woff2','.tar':'application/octet-stream'};
  res.setHeader('Content-Type',types[extname(target)]||'application/octet-stream');
  res.setHeader('Content-Length',(await stat(target)).size);createReadStream(target).pipe(res);
 }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('pageerror',error=>console.error('Browser:',error.message));
 await page.goto(origin+'/study.html');
 await page.locator('#content-title').fill('Bài học Toán — kiểm thử OCR cục bộ');
 const uiOnly=process.argv.includes('--ui-only');
 const report=uiOnly?JSON.parse(await readFile(new URL('results.json',output),'utf8')):{pdf:resolve(file),pages:[],apiTokens:0,notes:'Confidence is engine-specific, not accuracy. No ground truth, CER or formula correctness claim. Translation API is mocked for UI testing.'};
 await page.exposeFunction('recordOcrPage',async value=>{report.pages.push(value);console.log(JSON.stringify({page:value.page,paddle:{engine:value.paddle.engine,confidence:value.paddle.confidence,characters:value.paddle.characters,lines:value.paddle.layout.blocks.length,ms:Math.round(value.paddle.metrics.totalMs),fallback:value.paddle.fallbackReason},tesseract:{confidence:value.tesseract.confidence,characters:value.tesseract.characters,lines:value.tesseract.layout.blocks.length,ms:Math.round(value.tesseract.metrics.totalMs)}}));});
 if(!uiOnly)await page.evaluate(async numbers=>{
  const pdf=await (await fetch('/fixture.pdf')).blob(),client=await import('/pdf-client.js'),ocr=await import('/local-ocr.js');
  await client.uploadOptimizedScan(pdf,async(images,number)=>{
   const paddle=await ocr.recognizeChinesePage(images.blob);
   if(paddle.engine!=='paddle')throw new Error('PaddleOCR fallback: '+paddle.fallbackReason);
   const tesseract=await ocr.recognizeTesseractPage(images.blob);
   await window.recordOcrPage({page:number,paddle,tesseract});
  },()=>{},new Set(numbers));
  await ocr.terminateLocalOcr();
 },pages);
 assert.equal(translationCalls,0,'Local OCR must not call the translation API');
 assert.ok(report.pages.every(p=>p.paddle.engine==='paddle'),'PaddleOCR must actually execute, not silently pass a fallback benchmark');
 await writeFile(new URL('results.json',output),JSON.stringify(report,null,2)+'\n');
 // Exercise real upload -> OCR -> UI with a mocked translation, never a real key.
 await page.locator('#source-file').setInputFiles(file);
 await page.waitForFunction(()=>/trang scan|có lớp chữ/u.test(document.querySelector('#file-status').textContent),{},{timeout:180_000});
 await page.locator('#page-range').fill(String(pages[0]));
 await page.locator('#translate').click();assert.equal(translationCalls,0,'Missing key must prevent translation');
 await page.locator('#api-key').fill('local-ui-test-key-no-external-api');
 await page.locator('#translate').click();
 await page.waitForSelector('.translation-part.done',{timeout:240_000});
 assert.ok(await page.locator('.aligned-original .ocr-region').count()>0,'Original text boxes must appear');
 assert.match(await page.locator('.translation-part-text').textContent(),/mô phỏng/);
 await page.locator('.result').screenshot({path:fileURLToPath(new URL('desktop.png',output))});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile must not overflow');
 await page.locator('.result').screenshot({path:fileURLToPath(new URL('mobile.png',output))});
 // A changed range must not include the previously prepared page in the new plan.
 await page.locator('#page-range').fill(String(pages.at(-1)));
 await page.locator('#translate').click();
 await page.waitForFunction(number=>document.querySelector('.translation-part.done summary')?.textContent.startsWith(`Trang ${number} ·`),pages.at(-1),{timeout:240_000});
 assert.equal(await page.locator('.aligned-original').count(),1);
 const downloading=page.waitForEvent('download');await page.locator('#download-rich').click();const download=await downloading;
 await download.saveAs(fileURLToPath(new URL('export.html',output)));
 const exported=await readFile(new URL('export.html',output),'utf8');assert.match(exported,/data:image\/webp;base64,/);assert.match(exported,new RegExp(`Trang gốc ${pages.at(-1)}`));
 const fallbackPage=await browser.newPage();await fallbackPage.route('**/vendor/paddle/worker.js',route=>route.abort());await fallbackPage.goto(origin+'/study.html');const beforeFallback=translationCalls;
 const fallback=await fallbackPage.evaluate(async number=>{
  const client=await import('/pdf-client.js'),ocr=await import('/local-ocr.js'),pdf=await (await fetch('/fixture.pdf')).blob();let result;
  await client.uploadOptimizedScan(pdf,async({blob})=>{result=await ocr.recognizeChinesePage(blob);},()=>{},new Set([number]));await ocr.terminateLocalOcr();return {engine:result.engine,boxes:result.layout.blocks.length,reason:result.fallbackReason};
 },pages[0]);
 assert.equal(fallback.engine,'tesseract');assert.ok(fallback.boxes>0);assert.equal(translationCalls,beforeFallback);await fallbackPage.close();
 console.log(`OCR benchmark: ${report.pages.length} pages; 0 Gemini tokens. Upload/key/range/mobile checks passed.`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
