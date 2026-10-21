import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Browser OCR in an install without PaddleOCR, checked in Node without a browser: the install check asked once per tab,
// the size of the first download of the engine actually used, and a PaddleOCR worker that cannot start failing at once
// (not after the 180 s backstop) with a message that blames neither the browser nor the network. Each test file runs in
// its own process, so the browser globals stubbed here stay here.
const ORIGIN='http://localhost:4179',NOT_INSTALLED='Bản cài Hoa Trí này chưa có PaddleOCR.';
const NOT_STARTED='Không mở được PaddleOCR (/vendor/paddle/worker.js); bản cài này có thể thiếu PaddleOCR.';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
let requests=[],answer=()=>new Response(null,{status:404});
globalThis.location={href:`${ORIGIN}/study`};
globalThis.fetch=async(url,options={})=>{requests.push({method:options.method||'GET',path:new URL(url).pathname,cache:options.cache});return answer(url,options);};
// A fresh copy of local-ocr.js is a fresh tab: its install check is asked again.
let copies=0;const freshTab=()=>import(`../frontend/local-ocr.js?tab=${++copies}`);
const page=(status,type)=>()=>new Response(null,{status,headers:type?{'Content-Type':type}:{}});
const offline=()=>{throw new TypeError('fetch failed');};
// A PaddleOCR worker that fails to load, as a browser reports a missing or blocked worker.js: an error event, later.
const workers=[];
globalThis.Worker=class{constructor(url,options){workers.push({url,options});setTimeout(()=>this.onerror?.({type:'error'}),5);}postMessage(){}terminate(){this.terminated=true;}};

test('paddleInstalled(): a 404 or a page in place of worker.js means not installed, asked once per tab; no connection is asked again',async()=>{
 for(const [name,respond,installed,asks] of [
  ['404',page(404,'text/html; charset=utf-8'),false,1],
  ['a page (HTTP 200, HTML)',page(200,'text/html'),false,1],
  ['no connection',offline,false,2],
  ['a server error',page(503,'application/json'),false,2],
  ['the worker script',page(200,'text/javascript'),true,1]
 ]){
  const ocr=await freshTab();requests=[];answer=respond;
  assert.equal(await ocr.paddleInstalled(),installed,name);
  assert.deepEqual(requests,[{method:'HEAD',path:'/vendor/paddle/worker.js',cache:'no-store'}],name);
  assert.equal(await ocr.paddleInstalled(),installed,name);
  assert.equal(requests.length,asks,`${name}: ${asks===1?'asked once per tab':'asked again'}`);
 }
});

test('ocrDownload() names the engine this install uses, the size of its first download and whether the browser keeps it',async()=>{
 // Without PaddleOCR: Tesseract, about 9 MB (8.8 MB measured), not kept (no IndexedDB in Node counts as not kept).
 answer=page(404,'text/html');
 assert.deepEqual(await (await freshTab()).ocrDownload(),{engine:'Tesseract',mb:9,cached:false});
 // With PaddleOCR and both models in Cache Storage: nothing large to fetch.
 const asked=[];globalThis.caches={match:async(url,options)=>{asked.push([new URL(url).pathname,options?.cacheName]);return new Response('model',{headers:{'Content-Type':'application/x-tar'}});}};
 answer=page(200,'text/javascript');
 assert.deepEqual(await (await freshTab()).ocrDownload(),{engine:'PaddleOCR',mb:29,cached:true});
 assert.deepEqual(asked.sort(),[['/vendor/paddle/models/det.tar','hoa-tri-paddle-v5-0.4.2'],['/vendor/paddle/models/rec.tar','hoa-tri-paddle-v5-0.4.2']]);
 // A page kept in place of a model (an older version kept any HTTP 200) is not a kept model.
 globalThis.caches={match:async url=>url.endsWith('rec.tar')?new Response('<!doctype html>',{headers:{'Content-Type':'text/html'}}):new Response('model')};
 assert.deepEqual(await (await freshTab()).ocrDownload(),{engine:'PaddleOCR',mb:29,cached:false});
 delete globalThis.caches;
 // Tesseract's data kept in IndexedDB, as tesseract.js keeps it: only both languages count.
 for(const [keys,cached] of [[['./chi_sim.traineddata','./eng.traineddata'],true],[['./chi_sim.traineddata'],false],[null,false]]){
  globalThis.indexedDB=fakeIndexedDB(keys);answer=page(404,'text/html');
  assert.deepEqual(await (await freshTab()).ocrDownload(),{engine:'Tesseract',mb:9,cached},JSON.stringify(keys));
 }
 delete globalThis.indexedDB;
});

test('Where tesseract.js keeps its language data is pinned to the installed version',()=>{
 // tesseract.js 7 (node_modules/tesseract.js/dist/worker.min.js, served as /vendor/tesseract.worker.min.js) writes each
 // language through idb-keyval's default store under "<cachePath or .>/<lang>.traineddata"; local-ocr.js sets no
 // cachePath. A new tesseract.js that moves it fails here, before the Save-Data dialog starts asking in every tab.
 const worker=read('node_modules/tesseract.js/dist/worker.min.js'),source=read('frontend/local-ocr.js');
 assert.match(worker,/\("keyval-store","keyval"\)/u);
 assert.match(worker,/writeCache\(""\.concat\(\w+\|\|"\.","\/"\)\.concat\(\w+,"\.traineddata"\)/u);
 assert.doesNotMatch(source,/cachePath\s*:/u);
 assert.match(source,/'keyval-store'/u);assert.match(source,/\.\/\$\{lang\}\.traineddata/u);
});

test('A PaddleOCR worker that cannot start rejects at once with a neutral message, not after the 180 s backstop',async()=>{
 const {recognizePaddle}=await import('../frontend/paddle-client.js');workers.length=0;
 const started=performance.now();
 await assert.rejects(recognizePaddle(new Blob(['page'])),error=>error.message===NOT_STARTED);
 assert.ok(performance.now()-started<1000,`rejected after ${Math.round(performance.now()-started)} ms`);
 assert.deepEqual(workers,[{url:'/vendor/paddle/worker.js',options:{type:'module'}}]);
 assert.doesNotMatch(NOT_STARTED,/[Tt]rình duyệt|mạng/u,'neither the browser nor the network is blamed');
});

test('Scans go to Tesseract with the reason on every result: no PaddleOCR worker without PaddleOCR, one announcement per document',async()=>{
 // Tesseract itself cannot load in Node: each page ends with its load error, after the fallback was announced.
 const tesseract=/Không tải được bộ nhận dạng chữ Tesseract/u;
 answer=page(404,'text/html');workers.length=0;
 let ocr=await freshTab(),progress=[];
 await assert.rejects(ocr.recognizeChinesePage(new Blob(['page']),message=>progress.push(message)),tesseract);
 assert.deepEqual(progress,[{status:'fallback',engine:'tesseract',reason:NOT_INSTALLED}]);
 assert.equal(workers.length,0,'an install without PaddleOCR starts no PaddleOCR worker');
 // Installed, but its worker cannot start: Tesseract within a second, then for the rest of the tab, said once per document.
 answer=page(200,'text/javascript');ocr=await freshTab();progress=[];
 const started=performance.now();
 await assert.rejects(ocr.recognizeChinesePage(new Blob(['page']),message=>progress.push(message)),tesseract);
 assert.ok(performance.now()-started<1000,`fell back after ${Math.round(performance.now()-started)} ms`);
 assert.deepEqual(progress,[{status:'fallback',engine:'tesseract',reason:NOT_STARTED}]);
 await assert.rejects(ocr.recognizeChinesePage(new Blob(['page 2']),message=>progress.push(message)),tesseract);
 assert.equal(workers.length,1,'the next page does not start PaddleOCR again');assert.equal(progress.length,1,'nor announce it again');
 await ocr.terminateLocalOcr();
 await assert.rejects(ocr.recognizeChinesePage(new Blob(['next document']),message=>progress.push(message)),tesseract);
 assert.equal(progress.length,2,'the next document hears it again');assert.equal(workers.length,1);
});

test('fallbackNotice() reads as one or two sentences, without ".)."',async()=>{
 const {fallbackNotice}=await freshTab();
 assert.equal(fallbackNotice(NOT_INSTALLED),`Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR. ${NOT_INSTALLED}`);
 assert.equal(fallbackNotice('Bản cài Hoa Trí này thiếu mô hình PaddleOCR (det.tar: HTTP 404)'),'Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR. Bản cài Hoa Trí này thiếu mô hình PaddleOCR (det.tar: HTTP 404).');
 assert.equal(fallbackNotice(''),'Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR.');
 for(const reason of [NOT_INSTALLED,NOT_STARTED,'PaddleOCR quá thời gian xử lý trang.'])assert.doesNotMatch(fallbackNotice(reason),/\.\)\.|\.\./u,reason);
});

// idb-keyval's requests answer later, as IndexedDB does. keys: the keys in store "keyval", or null without the database.
function fakeIndexedDB(keys){
 const later=value=>{const request={};setTimeout(()=>{request.result=value;request.onsuccess?.();},1);return request;};
 const db={transaction:(store,mode)=>{assert.equal(store,'keyval');assert.equal(mode,'readonly');return {objectStore:name=>{assert.equal(name,'keyval');return {count:key=>later(keys.includes(key)?1:0)};}};},close(){}};
 return {databases:async()=>keys?[{name:'keyval-store',version:1}]:[],open:name=>{assert.equal(name,'keyval-store');return later(db);}};
}
