import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../frontend/',import.meta.url)),output=fileURLToPath(new URL('../tmp/study-history/',import.meta.url));
await mkdir(output,{recursive:true});
let row=null,storedState=null,historyWrites=0,renameWrites=0,translationCalls=0,lastHistoryBody='',privateLibraryTitle='',modelRequests=0,releaseModels,notifyModelRequested;
const modelGate=new Promise(resolve=>releaseModels=resolve),modelRequested=new Promise(resolve=>notifyModelRequested=resolve);
const source='两个向量相等。',title='Vectơ trong không gian – bài 1',renamedTitle='Vectơ trong không gian – ôn tập 14/10',filename='sach-toan-goc.txt',updatedAt='2026-10-14 11:22:00';
const json=(res,value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
const body=async req=>{let value='';for await(const chunk of req)value+=chunk;return value;};
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/me')return json(res,{authenticated:true,user:{id:'student-1',name:'Lan'}});
  if(pathname==='/api/my/study/models'){modelRequests++;notifyModelRequested();await modelGate;return json(res,{models:[{id:'gemini-3.6-flash',name:'Gemini 3.6 Flash'}],requested:'gemini-3.6-flash',selected:'gemini-3.6-flash'});}
  if(pathname==='/api/my/study/extract'&&req.method==='POST')return json(res,{text:source});
  if(pathname==='/api/my/study/history'&&req.method==='GET')return json(res,row?[row]:[]);
  if(pathname==='/api/my/study/history'&&req.method==='POST'||pathname==='/api/my/study/history/local-history'&&req.method==='PUT'){
   lastHistoryBody=await body(req);const payload=JSON.parse(lastHistoryBody),done=payload.state.done,total=payload.state.parts.length;storedState=payload.state;historyWrites++;row={id:'local-history',title:payload.title,filename:payload.filename,domain:payload.domain,mode:payload.mode,status:done===total?'complete':done?'translating':'draft',translated_parts:done,total_parts:total,source_characters:payload.state.source.length,translation_characters:payload.state.translationParts.join('\n\n').length,library_story_id:done===total?'private-story':null,created_at:updatedAt,updated_at:updatedAt};if(row.library_story_id)privateLibraryTitle=row.title;return json(res,{id:row.id,status:row.status,libraryStoryId:row.library_story_id,updatedAt:row.updated_at},req.method==='POST'?201:200);
  }
  if(pathname==='/api/my/study/history/local-history'&&req.method==='PATCH'){const payload=JSON.parse(await body(req));assert.deepEqual(Object.keys(payload),['title']);row.title=payload.title;privateLibraryTitle=payload.title;renameWrites++;return json(res,{id:row.id,status:row.status,libraryStoryId:row.library_story_id,updatedAt:row.updated_at});}
  if(pathname==='/api/my/study/history/local-history'&&req.method==='GET')return json(res,{...row,state:storedState});
  if(pathname==='/api/my/study/translate'&&req.method==='POST'){translationCalls++;return json(res,{translation:'Hai vectơ bằng nhau.',context:'',glossary:{},usage:{prompt:8,output:5,total:13,requests:1},warnings:[]});}
  const target=resolve(root,'.'+decodeURIComponent(pathname==='/'?'/study.html':pathname));if(!target.startsWith(root.endsWith(sep)?root:root+sep))throw new Error('Forbidden');const info=await stat(target);if(!info.isFile())throw new Error('Not found');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2'};res.setHeader('Content-Type',types[extname(target)]||'application/octet-stream');res.setHeader('Content-Length',info.size);createReadStream(target).pipe(res);
 }catch(error){res.statusCode=404;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:'Asia/Ho_Chi_Minh'}),origin=`http://127.0.0.1:${server.address().port}`;await page.goto(origin+'/study.html');
 await page.waitForSelector('.history-empty');await page.locator('#source').fill(source);await page.locator('#api-key').fill('local-ui-test-key-no-external-api');await page.locator('#translate').click();await page.waitForFunction(()=>document.querySelector('#progress').textContent==='Hãy nhập tên nội dung trước khi dịch.');assert.equal(translationCalls,0);assert.equal(historyWrites,0);assert.equal(await page.locator('#content-title').getAttribute('aria-invalid'),'true');
 await page.locator('#content-title').fill(title);await page.locator('#source-file').setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from(source)});await page.waitForFunction(()=>document.querySelector('#file-status').textContent.includes('đã trích xuất'));assert.equal(await page.locator('#content-title').inputValue(),title);
 await page.evaluate(()=>{const button=document.querySelector('#translate');button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await modelRequested;
 assert.equal(modelRequests,1);for(const id of ['translate','content-title','source','source-file','domain','mode','glossary','api-key','clear-key','check-gemini-model','gemini-model'])assert.equal(await page.locator('#'+id).isDisabled(),true,id+' remains locked during model lookup');assert.equal(historyWrites,0);releaseModels();
 await page.waitForSelector('.translation-part.done');await page.waitForFunction(()=>document.querySelector('.history-card-main span')?.textContent.startsWith('Hoàn tất'));await page.waitForFunction(()=>!document.querySelector('#translate').disabled);assert.equal(modelRequests,1);
 assert.equal(translationCalls,1);assert.equal(historyWrites,2);assert.equal(row.title,title);assert.equal(row.filename,filename);assert.equal(privateLibraryTitle,title);assert.doesNotMatch(lastHistoryBody,/local-ui-test-key/);assert.equal(await page.locator('#translation').inputValue(),'Hai vectơ bằng nhau.');assert.equal(await page.locator('.translation-part-text').textContent(),'Hai vectơ bằng nhau.');assert.equal(await page.locator('.history-library').count(),1);assert.equal(await page.locator('.history-source').textContent(),filename);assert.match(await page.locator('.history-card-main time').textContent(),/18:22/);assert.equal(await page.locator('.history-card-main time').getAttribute('datetime'),'2026-10-14T11:22:00.000Z');await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:resolve(output,'desktop.png'),fullPage:true});
 const downloadPromise=page.waitForEvent('download');await page.locator('#download').click();assert.equal((await downloadPromise).suggestedFilename(),title+'.vi.txt');
 await page.reload();await page.waitForSelector('[data-history-open="local-history"]');await page.locator('[data-history-open="local-history"]').click();await page.waitForFunction(()=>document.querySelector('#source').value==='两个向量相等。');assert.equal(await page.locator('#content-title').inputValue(),title);assert.equal(await page.locator('#translation').inputValue(),'Hai vectơ bằng nhau.');assert.match(await page.locator('#progress').textContent(),/Thư viện riêng/);
 const beforeRename=JSON.stringify(storedState);await page.locator('#content-title').fill(renamedTitle);await page.locator('#save-title').click();await page.waitForFunction(()=>document.querySelector('#content-title-hint').textContent.startsWith('Đã lưu tên'));assert.equal(renameWrites,1);assert.equal(row.title,renamedTitle);assert.equal(privateLibraryTitle,renamedTitle);assert.equal(JSON.stringify(storedState),beforeRename);assert.equal(translationCalls,1);assert.equal(await page.locator('.history-card-main strong').getAttribute('title'),renamedTitle);
 await page.reload();await page.waitForSelector('[data-history-open="local-history"]');await page.locator('[data-history-open="local-history"]').click();await page.waitForFunction(title=>document.querySelector('#content-title').value===title,renamedTitle);assert.equal(await page.locator('#translation').inputValue(),'Hai vectơ bằng nhau.');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
 await page.locator('#translate').click();await page.waitForFunction(()=>document.querySelector('#progress').textContent.startsWith('Chưa có khóa Gemini.'));for(const id of ['translate','content-title','source','source-file','domain','mode','glossary','api-key','clear-key','check-gemini-model'])assert.equal(await page.locator('#'+id).isDisabled(),false,id+' is unlocked after failed preparation');assert.equal(translationCalls,1);assert.equal(historyWrites,2);assert.equal(renameWrites,1);
 console.log('Study history browser benchmark passed: required title, preparation lock/double-click/failure release, upload retention, named download, save, UTC date, reload and rename without translation.');
}finally{releaseModels();await browser?.close();await new Promise(resolve=>server.close(resolve));}
