import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {pdfLayoutRoute,bodyDeadline} from './pdf-layout.js';
import {studyRoute} from './study-translation.js';
import {studyHistoryRoute} from './study-history.js';
import {errorResponse} from './http.js';
import {holdLease,keepRenewed} from './pdf-slots.js';
import {classifyError} from '../frontend/whole-book.js';
import {overflowMessage} from '../services/pdf-layout/engine.mjs';
import {MODES,modeProfile} from '../frontend/translation-modes.js';

const base='/api/my/study/pdf-layout',origin='https://example.test';
const reader={id:'student-1',name:'Lan'},other={id:'student-2'};
const assetId='11111111-1111-4111-8111-111111111111';
const historyId='22222222-2222-4222-8222-222222222222';
const assetKey=(student,file)=>`study/${student.id}/pdf-layout/${assetId}/${file}`;
const pdf='%PDF-1.7\nselected page only';
const png='data:image/png;base64,AA==';
const document=()=>({version:1,pages:[{number:4,width:600,height:800,background:png,original:png,blocks:[
 {id:'p4-b0',source:'定义向量。',box:[20,20,200,80],fontSize:12},
 {id:'p4-b1',source:'公式 @@PDF_INLINE_0@@。',box:[20,100,200,160],fontSize:12,inlines:[{token:'@@PDF_INLINE_0@@',image:png,width:24,height:12,text:'a = b'}]}
]}]});
const jsonRequest=(path,body)=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});

// Manifests are stored as ASCII JSON bytes (asciiJsonBytes); values a test puts itself are strings.
const storedText=value=>typeof value==='string'?value:new TextDecoder().decode(value);
class MemoryFiles{
 constructor(){this.values=new Map();this.reads=[];this.writes=[];this.deletes=[];}
 // Like R2, a streamed value is read to its end when stored.
 async put(key,value,options){if(typeof value!=='string'&&!ArrayBuffer.isView(value)&&!(value instanceof ArrayBuffer))value=new Uint8Array(await new Response(value).arrayBuffer());this.values.set(key,{value,options});this.writes.push({key,value,options});}
 // R2 deletes one key or a list of keys.
 async delete(keys){for(const key of [keys].flat()){this.deletes.push(key);this.values.delete(key);}}
 async get(key){
  this.reads.push(key);const item=this.values.get(key);if(!item)return null;
  const text=()=>typeof item.value==='string'?item.value:new TextDecoder().decode(item.value);
  const bytes=()=>typeof item.value==='string'?new TextEncoder().encode(item.value):item.value;
  return {body:bytes(),customMetadata:item.options?.customMetadata,json:async()=>JSON.parse(text()),text:async()=>text(),arrayBuffer:async()=>bytes().slice().buffer};
 }
}
function environment(){
 const FILES=new MemoryFiles(),sessions=new Map(),queries=[],batches=[];
 const DB={prepare(sql){const statement={sql,args:[],bind(...args){this.args=args;return this;},async first(){queries.push(this);if(sql.includes('FROM study_sessions WHERE id=? AND user_id=?')){const row=sessions.get(this.args[0]);return row?.user_id===this.args[1]?row:null;}return reader;},async run(){queries.push(this);return {success:true};}};return statement;},async batch(statements){batches.push(statements);return statements.map(()=>({success:true}));}};
 return {env:{FILES,DB,PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test/v1/',PDF_LAYOUT_SERVICE_TOKEN:'service-secret'},FILES,sessions,queries,batches};
}
async function seed(env,{owner=reader,complete=true,libraryStoryId='private-story',libraryChapterId='private-chapter',linkedAssetId=assetId}={}){
 const stateKey=`study/${owner.id}/${historyId}/state.json`;
 await env.FILES.put(assetKey(owner,'manifest.json'),JSON.stringify(document()));
 await env.FILES.put(stateKey,JSON.stringify({complete,translationParts:['Định nghĩa vectơ.','Công thức @@PDF_INLINE_0@@.'],pdfLayout:{assetId:linkedAssetId}}));
 return {id:historyId,user_id:owner.id,title:'Vectơ trong không gian - bài 1',state_key:stateKey,library_story_id:libraryStoryId,library_chapter_id:libraryChapterId};
}

test('PDF config reports availability and limits without disclosing the service token',async()=>{
 const {env}=environment(),configured=await pdfLayoutRoute(new Request(origin+base+'/config'),env,base+'/config',reader);
 assert.deepEqual(await configured.json(),{configured:true,maxBytes:25*1024*1024,maxPages:20});
 assert.equal(configured.headers.get('Cache-Control'),'no-store');
 const unavailable=await pdfLayoutRoute(new Request(origin+base+'/config'),{},base+'/config',reader);
 assert.equal((await unavailable.json()).configured,false);
 await assert.rejects(()=>pdfLayoutRoute(new Request(origin+base+'/config'),{PDF_LAYOUT_SERVICE_URL:'http://external.example.test',PDF_LAYOUT_SERVICE_TOKEN:'secret'},base+'/config',reader),/HTTPS/);
});

test('The preview font is cached by the browser for a day and revalidated with its ETag, without asking the service again',async t=>{
 // Its own service URL: the Worker's font cache is keyed by it, so other tests start cold.
 const env={...environment().env,PDF_LAYOUT_SERVICE_URL:'https://font-cache.example.test/v1/'},css='@font-face{font-family:HoaTriPDF;src:url(data:font/ttf;base64,AAEAAA==)}',calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),method:options.method,auth:options.headers.Authorization});return Response.json({css});});
 const get=headers=>pdfLayoutRoute(new Request(origin+base+'/font',{headers}),env,base+'/font',reader);
 const first=await get();
 assert.equal(first.status,200);assert.deepEqual(await first.json(),{css});
 assert.equal(first.headers.get('Cache-Control'),'private, max-age=86400');assert.match(first.headers.get('Content-Type'),/^application\/json/u);
 const etag=first.headers.get('ETag');assert.match(etag,/^"[a-f\d]{32}"$/u);
 assert.deepEqual(calls,[{url:'https://font-cache.example.test/v1/font',method:'GET',auth:'Bearer service-secret'}]);
 // The browser's revalidation (also with the weak tag a compressing CDN may hand out) costs no body and no service call.
 for(const tag of [etag,`W/${etag}`,`"other", ${etag}`]){const again=await get({'If-None-Match':tag});assert.equal(again.status,304);assert.equal(await again.text(),'');assert.equal(again.headers.get('ETag'),etag);assert.equal(again.headers.get('Cache-Control'),'private, max-age=86400');}
 const changed=await get({'If-None-Match':'"stale"'});assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{css});
 assert.equal(calls.length,1,'the Worker answered from its own short cache');
});

test('A preview font answer without @font-face is refused instead of being cached',async t=>{
 const env={...environment().env,PDF_LAYOUT_SERVICE_URL:'https://font-broken.example.test/v1/'};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({css:calls===1?'':'@font-face{font-family:HoaTriPDF}'});});
 await assert.rejects(()=>pdfLayoutRoute(new Request(origin+base+'/font'),env,base+'/font',reader),/phông chữ không hợp lệ/u);
 const fixed=await pdfLayoutRoute(new Request(origin+base+'/font'),env,base+'/font',reader);assert.equal(fixed.status,200);assert.equal(calls,2);
});

test('PDF endpoints require an authenticated same-origin student session',async()=>{
 const {env}=environment(),path=base+'/config',url=new URL(origin+path);
 const unauthenticated={...env,DB:{prepare(){return {bind(){return this;},async first(){return null;}};}}};
 assert.equal((await studyRoute(new Request(url),unauthenticated,url,path)).status,401);
 assert.equal((await studyRoute(new Request(url,{headers:{Cookie:'cat_hien_session=temporary',Origin:'https://elsewhere.test'}}),env,url,path)).status,403);
});

test('PDF assets are private to the account for original, translated and manifest files',async()=>{
 const {env,FILES}=environment();
 await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));
 await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 await FILES.put(assetKey(reader,'translated.pdf'),new TextEncoder().encode(pdf));
 for(const kind of ['manifest','original','translated']){
  const path=`${base}/assets/${assetId}/${kind}`;
  const foreign=await pdfLayoutRoute(new Request(origin+path),env,path,other);assert.equal(foreign.status,404);
  const owned=await pdfLayoutRoute(new Request(origin+path),env,path,reader);assert.equal(owned.status,200);assert.equal(owned.headers.get('Cache-Control'),'no-store');
  if(kind!=='manifest'){assert.equal(owned.headers.get('Content-Type'),'application/pdf');assert.equal(owned.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(await owned.text(),pdf);}
 }
});

test('PDF extraction sends the selected range and stores the selected original and manifest without API keys',async t=>{
 const {env,FILES}=environment(),calls=[],selected='%PDF-1.7\npage 4';
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options,body:await new Response(options.body).text()});return Response.json({document:document(),originalPdfBase64:btoa(selected)});});
 const form=new FormData();form.set('file',new File([pdf],'lesson.pdf',{type:'application/pdf'}));form.set('pages','4');form.set('apiKey','student-key-must-not-be-stored');
 const response=await pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:form}),env,base+'/extract',reader),result=await response.json();
 assert.equal(response.status,201);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://pdf.example.test/v1/extract');assert.equal(calls[0].options.headers.Authorization,'Bearer service-secret');
 assert.equal(calls[0].body,pdf);assert.equal(calls[0].options.headers['Content-Type'],'application/pdf');assert.equal(calls[0].options.headers['X-PDF-Pages'],'4');assert.equal(result.document.pages[0].number,4);
 assert.match(result.originalUrl,new RegExp(`${base}/assets/[a-f\\d-]{36}/original`));
 const saved=FILES.writes.find(item=>item.key.endsWith('/original.pdf'));assert.equal(new TextDecoder().decode(saved.value),selected);
 // Besides the selected pages, the whole uploaded file is kept once under the reader's own sources folder.
 const sourceKey=`study/${reader.id}/sources/${result.document.sourceSha256}.pdf`;
 assert.ok(FILES.writes.every(item=>item.key.startsWith(`study/${reader.id}/pdf-layout/${result.assetId}/`)||item.key===sourceKey));
 assert.equal(storedText(FILES.values.get(sourceKey).value),pdf);
 assert.doesNotMatch(FILES.writes.map(write=>storedText(write.value)).join('\n'),/student-key|service-secret/);assert.doesNotMatch(JSON.stringify(result),/student-key|service-secret/);
});

test('PDF extraction rejects non-PDF bytes and invalid block geometry before persistence',async t=>{
 const {env,FILES}=environment();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;const invalid=document();invalid.pages[0].blocks[0].box=[-5,20,200,80];return Response.json({document:invalid,originalPdfBase64:btoa(pdf)});});
 const form=new FormData();form.set('file',new File(['plain text'],'fake.pdf'));
 await assert.rejects(()=>pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:form}),env,base+'/extract',reader),/không phải PDF/);assert.equal(calls,0);
 form.set('file',new File([pdf],'lesson.pdf'));
 await assert.rejects(()=>pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:form}),env,base+'/extract',reader),/Box nằm ngoài/);
 assert.equal(FILES.writes.length,0);
});

test('PDF rendering uses saved owner history and ignores translations supplied in the request',async t=>{
 const {env,FILES,sessions,queries}=environment(),row=await seed(env);sessions.set(historyId,row);const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options,body:JSON.parse(await new Response(options.body).text())});return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[{id:'p4-b0',overflow:false}]});});
 const response=await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId,translations:[{id:'p4-b0',translation:'injected attacker translation'}],apiKey:'never-use-me'}),env,base+'/render',reader),result=await response.json();
 assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://pdf.example.test/v1/render');
 assert.deepEqual(calls[0].body.translations,[{id:'p4-b0',translation:'Định nghĩa vectơ.'},{id:'p4-b1',translation:'Công thức @@PDF_INLINE_0@@.'}]);
 assert.equal(calls[0].body.title,row.title);assert.equal(result.renderVersion,3);
 assert.doesNotMatch(JSON.stringify(calls[0].body),/attacker|never-use-me/);assert.equal(result.url,`${base}/assets/${assetId}/translated`);
 // The render addresses this range's own chapter, never every chapter of the book.
 const chapterUpdate=queries.find(item=>item.sql.startsWith('UPDATE chapters'));assert.match(chapterUpdate.sql,/WHERE id=\?3/u);assert.doesNotMatch(chapterUpdate.sql,/WHERE story_id=/u);
 // Linked only while the session is still the save the PDF was made from (its revision and chapter).
 assert.match(chapterUpdate.sql,/EXISTS \(SELECT 1 FROM study_sessions WHERE id=\?5 AND user_id=\?4 AND revision=\?6 AND library_chapter_id=\?3\)/u);
 assert.deepEqual(chapterUpdate.args,[assetKey(reader,'translated.pdf'),'application/pdf','private-chapter',reader.id,historyId,0]);
 assert.equal((await (await FILES.get(row.state_key)).json()).pdfLayout.exported,true);
 assert.equal((await (await FILES.get(row.state_key)).json()).pdfLayout.renderVersion,3);
 const translated=await pdfLayoutRoute(new Request(origin+result.url),env,result.url,reader);
 assert.equal(decodeURIComponent(translated.headers.get('Content-Disposition').split("UTF-8''")[1]),row.title+'.vi.pdf');
});

test('PDF rendering rejects a foreign asset or history without calling the render service',async t=>{
 const {env,sessions}=environment(),foreign=await seed(env,{owner:other});sessions.set(historyId,foreign);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Service must not be called');});
 assert.equal((await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader)).status,404);
 await env.FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));
 assert.equal((await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader)).status,404);
 assert.equal(calls,0);
});

test('PDF rendering requires complete history, a library entry and a matching original asset',async t=>{
 const {env,sessions}=environment();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Service must not be called');});
 for(const options of [{complete:false},{libraryChapterId:null},{linkedAssetId:'33333333-3333-4333-8333-333333333333'}]){
  sessions.set(historyId,await seed(env,options));
  assert.equal((await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader)).status,409);
 }
 assert.equal(calls,0);
});

test('PDF rendering rejects a history missing formula tokens and rejects non-PDF engine output',async t=>{
 const {env,FILES,sessions}=environment(),row=await seed(env);sessions.set(historyId,row);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({pdfBase64:btoa('not a PDF'),report:[]});});
 const state=await (await FILES.get(row.state_key)).json();state.translationParts[1]='Công thức bị mất.';await FILES.put(row.state_key,JSON.stringify(state));
 await assert.rejects(()=>pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader),/không bảo toàn công thức/);assert.equal(calls,0);
 sessions.set(historyId,await seed(env));
 await assert.rejects(()=>pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader),/PDF hợp lệ/);assert.equal(calls,1);
 assert.equal(FILES.values.has(assetKey(reader,'translated.pdf')),false);
});

test('PDF-linked history validates source blocks and stores a small key-free reference',async()=>{
 const {env,FILES,batches}=environment();await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));
 const blocks=document().pages[0].blocks;
 const body={title:'Bản dịch PDF',filename:'lesson.pdf',apiKey:'secret-never-store',state:{source:blocks.map(b=>b.source).join('\n\n'),parts:blocks.map(b=>b.source),translationParts:['Định nghĩa vectơ.','Công thức @@PDF_INLINE_0@@.'],done:2,pdfLayout:{assetId,exported:true,document:document(),apiKey:'secret-never-store'}}};
 const path='/api/my/study/history',response=await studyHistoryRoute(jsonRequest(path,body),env,path,reader),saved=await response.json();
 assert.equal(response.status,201);assert.equal(saved.status,'complete');
 const stored=JSON.parse(FILES.writes.find(item=>item.key.endsWith('/state.json')).value);assert.deepEqual(stored.pdfLayout,{assetId});assert.equal(stored.translation,'Định nghĩa vectơ.\n\nCông thức a = b.');
 assert.doesNotMatch(JSON.stringify(stored),/secret-never-store|data:image|exported/);
 assert.ok(batches[0].some(item=>item.sql.includes("'private'")&&item.args.includes(reader.id)));
 const foreign=await studyHistoryRoute(jsonRequest(path,body),env,path,other);assert.equal(foreign.status,404);
 body.state.parts[0]='另一内容。';body.state.source=body.state.parts.join('\n\n');
 await assert.rejects(()=>studyHistoryRoute(jsonRequest(path,body),env,path,reader),/không khớp PDF gốc/);
});

test('PDF rendering reports missing saved history content without calling the service',async t=>{
 const {env,FILES,sessions}=environment(),row=await seed(env);sessions.set(historyId,row);await FILES.delete(row.state_key);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Service must not be called');});
 const response=await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader);
 assert.equal(response.status,410);assert.equal(calls,0);
});

test('Unchanged PDF history preserves its export while edited translations invalidate the library PDF',async()=>{
 const {env,FILES,sessions,batches}=environment(),row=await seed(env);sessions.set(historyId,row);
 const prior=await (await FILES.get(row.state_key)).json();prior.pdfLayout.exported=true;await FILES.put(row.state_key,JSON.stringify(prior));await FILES.put(assetKey(reader,'translated.pdf'),new TextEncoder().encode(pdf));
 const sourceBlocks=document().pages[0].blocks,body={title:'Bản dịch PDF',filename:'lesson.pdf',state:{source:sourceBlocks.map(b=>b.source).join('\n\n'),parts:sourceBlocks.map(b=>b.source),translationParts:prior.translationParts,done:2,pdfLayout:{assetId}}};
 const path=`/api/my/study/history/${historyId}`,request=()=>new Request(origin+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await studyHistoryRoute(request(),env,path,reader)).status,200);
 assert.equal((await (await FILES.get(row.state_key)).json()).pdfLayout.exported,true);assert.ok(FILES.values.has(assetKey(reader,'translated.pdf')));assert.equal(FILES.deletes.length,0);
 body.state.translationParts=['Định nghĩa của vectơ.','Công thức @@PDF_INLINE_0@@.'];
 assert.equal((await studyHistoryRoute(request(),env,path,reader)).status,200);
 assert.notEqual((await (await FILES.get(row.state_key)).json()).pdfLayout.exported,true);assert.equal(FILES.values.has(assetKey(reader,'translated.pdf')),false);
 const reset=batches.at(-1).find(item=>item.sql.startsWith('UPDATE chapters')&&item.sql.includes('file_key'));assert.ok(reset);assert.ok(reset.sql.includes('text/plain')||reset.args.includes('text/plain'));assert.ok(reset.args.includes('private-chapter'));assert.doesNotMatch(reset.sql,/WHERE story_id=/u);
});

test('Reopening an exported PDF as partially translated also clears the stale library file',async()=>{
 const {env,FILES,sessions,batches}=environment(),row=await seed(env);sessions.set(historyId,row);
 const prior=await (await FILES.get(row.state_key)).json();prior.pdfLayout.exported=true;await FILES.put(row.state_key,JSON.stringify(prior));await FILES.put(assetKey(reader,'translated.pdf'),new TextEncoder().encode(pdf));
 const sourceBlocks=document().pages[0].blocks,body={title:'Bản dịch PDF',state:{source:sourceBlocks.map(b=>b.source).join('\n\n'),parts:sourceBlocks.map(b=>b.source),translationParts:['Định nghĩa đã sửa.',''],done:1,pdfLayout:{assetId}}};
 const path=`/api/my/study/history/${historyId}`,response=await studyHistoryRoute(new Request(origin+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,path,reader);
 assert.equal((await response.json()).status,'translating');assert.equal(FILES.values.has(assetKey(reader,'translated.pdf')),false);
 assert.ok(batches.at(-1).some(item=>item.sql.startsWith('UPDATE chapters')&&item.sql.includes('file_key')&&item.args.includes('private-chapter')&&!item.sql.includes('WHERE story_id=')));
});

test('PDF refresh re-extracts saved selected pages into a new asset and restores their original page numbers and block IDs',async t=>{
 const {env,FILES}=environment(),prior=document();prior.totalPages=88;
 const second=structuredClone(prior.pages[0]);second.number=5;second.blocks.forEach(b=>b.id=b.id.replace(/^p4-/u,'p5-'));prior.pages.push(second);
 await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 const writesBefore=FILES.writes.length,oldManifest=FILES.values.get(assetKey(reader,'manifest.json')).value,oldOriginal=FILES.values.get(assetKey(reader,'original.pdf')).value.slice(),calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const selected=structuredClone(prior);selected.extractionVersion=2;selected.totalPages=2;
  selected.pages.forEach((page,i)=>{page.number=i+1;page.blocks.forEach(block=>block.id=block.id.replace(/^p\d+-/u,`p${i+1}-`));});
  calls.push({url:String(url),options,body:await new Response(options.body).text()});
  return Response.json({document:selected,originalPdfBase64:btoa(pdf)});
 });
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,apiKey:'student-key-must-not-be-sent'}),env,base+'/refresh',reader),result=await response.json();
 assert.equal(response.status,201);assert.notEqual(result.assetId,assetId);assert.match(result.assetId,/^[a-f\d-]{36}$/iu);
 assert.equal(result.document.extractionVersion,2);assert.equal(result.document.totalPages,88);assert.deepEqual(result.document.pages.map(p=>p.number),[4,5]);
 assert.deepEqual(result.document.pages.flatMap(p=>p.blocks.map(b=>b.id)),['p4-b0','p4-b1','p5-b0','p5-b1']);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://pdf.example.test/v1/extract');assert.equal(calls[0].body,pdf);
 assert.equal(calls[0].options.headers['X-PDF-Pages'],'1-2');assert.equal(calls[0].options.headers.Authorization,'Bearer service-secret');assert.equal(calls[0].options.headers['Content-Type'],'application/pdf');
 assert.doesNotMatch(calls[0].body,/student-key/);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const writes=FILES.writes.slice(writesBefore);assert.equal(writes.length,2);
 assert.ok(writes.every(w=>w.key.startsWith(`study/${reader.id}/pdf-layout/${result.assetId}/`)));
 assert.equal(writes.find(w=>w.key.endsWith('/manifest.json')).options.httpMetadata.contentType,'application/json');
 assert.equal(writes.find(w=>w.key.endsWith('/original.pdf')).options.httpMetadata.contentType,'application/pdf');
 assert.equal(new TextDecoder().decode(writes.find(w=>w.key.endsWith('/original.pdf')).value),pdf);
 assert.equal(FILES.values.get(assetKey(reader,'manifest.json')).value,oldManifest);assert.deepEqual(FILES.values.get(assetKey(reader,'original.pdf')).value,oldOriginal);
 assert.equal(result.originalUrl,`${base}/assets/${result.assetId}/original`);assert.doesNotMatch(JSON.stringify(result),/student-key|service-secret/);assert.doesNotMatch(writes.map(write=>storedText(write.value)).join('\n'),/student-key|service-secret/);
});

test('A current PDF extraction returns its existing asset without service calls or storage writes',async t=>{
 const {env,FILES}=environment(),prior=document();prior.extractionVersion=2;
 await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));const writesBefore=FILES.writes.length;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Current extraction must not be sent to the service');});
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId}),env,base+'/refresh',reader),result=await response.json();
 assert.equal(response.status,200);assert.equal(result.assetId,assetId);assert.deepEqual(result.document,prior);assert.equal(result.originalUrl,`${base}/assets/${assetId}/original`);
 assert.equal(calls,0);assert.equal(FILES.writes.length,writesBefore);assert.deepEqual(FILES.reads,[assetKey(reader,'manifest.json')]);
});

test('PDF refresh cannot read or refresh another student asset and makes no network request',async t=>{
 const {env,FILES}=environment();await FILES.put(assetKey(other,'manifest.json'),JSON.stringify(document()));await FILES.put(assetKey(other,'original.pdf'),new TextEncoder().encode(pdf));
 const writesBefore=FILES.writes.length;let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Foreign asset must never be sent to the service');});
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId}),env,base+'/refresh',reader);
 assert.equal(response.status,404);assert.deepEqual(FILES.reads,[assetKey(reader,'manifest.json')]);assert.equal(FILES.writes.length,writesBefore);assert.equal(calls,0);
});

test('PDF refresh reports a missing selected original without creating any replacement asset',async t=>{
 const {env,FILES}=environment();await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));const writesBefore=FILES.writes.length;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('A missing original cannot be refreshed');});
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId}),env,base+'/refresh',reader);
 assert.equal(response.status,410);assert.equal(calls,0);assert.equal(FILES.writes.length,writesBefore);
 assert.deepEqual(FILES.reads,[assetKey(reader,'manifest.json'),assetKey(reader,'original.pdf')]);
});

test('PDF refresh validates service page counts, block geometry and nonempty content before persisting',async t=>{
 const {env,FILES}=environment();await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));const writesBefore=FILES.writes.length;
 let returned;t.mock.method(globalThis,'fetch',async()=>Response.json({document:returned,originalPdfBase64:btoa(pdf)}));
 const refresh=()=>pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId}),env,base+'/refresh',reader);
 returned=document();returned.pages.push(structuredClone(returned.pages[0]));await assert.rejects(refresh,/Không khớp số trang/);
 returned=document();returned.pages[0].blocks[0].box=[-5,20,200,80];await assert.rejects(refresh,/Box nằm ngoài/);
 returned=document();returned.pages[0].blocks=[];await assert.rejects(refresh,/Không lấy được nội dung tiếng Trung/);
 returned=document();returned.version=99;await assert.rejects(refresh,/Dữ liệu bố cục PDF không hợp lệ/);
 assert.equal(FILES.writes.length,writesBefore);assert.equal(FILES.deletes.length,0);
});

test('PDF refresh rejects a malformed asset ID before reading storage or calling the service',async t=>{
 const {env,FILES}=environment();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Invalid ID must not use the service');});
 await assert.rejects(()=>pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId:'../../other-student/manifest'}),env,base+'/refresh',reader),/Mã PDF không hợp lệ/);
 assert.equal(FILES.reads.length,0);assert.equal(FILES.writes.length,0);assert.equal(calls,0);
});

test('PDF extraction records the uploaded file hash so ranges of one textbook can join one book, and refresh keeps it',async t=>{
 const {env,FILES}=environment(),hex=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 t.mock.method(globalThis,'fetch',async()=>Response.json({document:document(),originalPdfBase64:btoa(pdf)}));
 const extract=async sha256=>{const form=new FormData();form.set('file',new File([pdf],'lesson.pdf',{type:'application/pdf'}));form.set('pages','4');if(sha256!==undefined)form.set('sha256',sha256);const response=await pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:form}),env,base+'/extract',reader);return (await response.json()).assetId;};
 const stored=async id=>JSON.parse(await (await FILES.get(`study/${reader.id}/pdf-layout/${id}/manifest.json`)).text()).sourceSha256;
 // The stored original is filed under this hash, so the Worker always hashes the upload itself: a browser value (or none,
 // on plain-HTTP phones without crypto.subtle) never decides it.
 const fromBrowser='c'.repeat(64);assert.equal(await stored(await extract(fromBrowser)),await hex(pdf));
 assert.equal(await stored(await extract()),await hex(pdf));assert.equal(await stored(await extract('not-a-hash')),await hex(pdf));
 const prior=document();prior.sourceSha256=fromBrowser;prior.totalPages=40;await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader),result=await response.json();
 assert.equal(response.status,201);assert.equal(result.document.sourceSha256,fromBrowser);assert.equal(await stored(result.assetId),fromBrowser);
});

test('An extraction asks for fine OCR sheets when its mode cuts them finer, a refresh asks for what the stored copy has, and the manifest keeps what was made',async t=>{
 const {env,FILES}=environment(),asked=[];
 // As a service that knows the header: it records the sheets it made (an older one ignores the header and records nothing).
 t.mock.method(globalThis,'fetch',async(url,options)=>{asked.push(options.headers);await new Response(options.body).arrayBuffer();const made=document();made.sheetQuality=options.headers['X-PDF-Quality']==='fine'?'fine':'standard';return Response.json({document:made,originalPdfBase64:btoa(pdf)});});
 const form=(fields={})=>{const data=new FormData();data.set('file',new File([pdf],'lesson.pdf',{type:'application/pdf'}));data.set('pages','4');for(const [key,value] of Object.entries(fields))data.set(key,value);return data;};
 const extract=async fields=>{const response=await pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:form(fields)}),env,base+'/extract',reader);assert.equal(response.status,201);return response.json();};
 const kept=async id=>JSON.parse(await (await FILES.get(`study/${reader.id}/pdf-layout/${id}/manifest.json`)).text()).sheetQuality;
 // Kỹ nhất cuts them finer (translation-modes.js sheets); no mode or an unknown one is economy.
 assert.equal(modeProfile('premium').sheets,'fine');assert.equal(modeProfile('economy').sheets,'standard');
 for(const mode of [...MODES,undefined,'turbo']){
  const quality=modeProfile(mode).sheets==='fine'?'fine':undefined,result=await extract(mode?{mode}:{});assert.equal(asked.at(-1)['X-PDF-Quality'],quality,String(mode));assert.equal(asked.at(-1)['X-PDF-Pages'],'4');
  assert.equal(result.document.sheetQuality,quality?'fine':'standard');assert.equal(await kept(result.assetId),result.document.sheetQuality,String(mode));
 }
 // A whole-book chunk carries its mode the same way.
 const sha='e'.repeat(64);await FILES.put(`study/${reader.id}/sources/${sha}.pdf`,pdf,{customMetadata:{pages:'40',filename:'book.pdf'}});
 await extract({sourceSha256:sha,pageOffset:'10',pages:'1',mode:'premium'});assert.equal(asked.at(-1)['X-PDF-Quality'],'fine');
 await extract({sourceSha256:sha,pageOffset:'10',pages:'1'});assert.equal(asked.at(-1)['X-PDF-Quality'],undefined);
 // A refresh makes the sheets the stored copy has, unless it names a mode.
 const prior=document();prior.sheetQuality='fine';await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 for(const [mode,quality] of [[undefined,'fine'],['economy',undefined],['premium','fine'],['turbo','fine']]){
  const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true,...(mode?{mode}:{})}),env,base+'/refresh',reader);
  assert.equal(response.status,201,String(mode));assert.equal(asked.at(-1)['X-PDF-Quality'],quality,String(mode));assert.equal(asked.at(-1)['X-PDF-All-Pages'],'1');
 }
 delete prior.sheetQuality;await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));
 assert.equal((await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader)).status,201);assert.equal(asked.at(-1)['X-PDF-Quality'],undefined,'an older copy has standard sheets');
});

// The same routes over a real SQLite database (every migration), for the per-account lease and the daily caps.
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
function sqliteEnvironment(t,vars={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url));
 for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(migrations+name,'utf8'));
 for(const user of [reader,other])sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(user.id,`sub-${user.id}`,`${user.id}@example.test`,user.name||'Minh');
 sqlite.prepare("INSERT INTO stories(id,title,genre,owner_user_id,visibility,source_url) VALUES('private-story','Vectơ','Toán học · STEM',?,'private','study-book:private-story')").run(reader.id);
 sqlite.prepare("INSERT INTO chapters(id,story_id,title,content) VALUES('private-chapter','private-story','Trang 4','…')").run();
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,env:{DB,FILES:new MemoryFiles(),PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test/v1/',PDF_LAYOUT_SERVICE_TOKEN:'service-secret',...vars}};
}
const extractForm=()=>{const form=new FormData();form.set('file',new File([pdf],'lesson.pdf',{type:'application/pdf'}));form.set('pages','4');return form;};
const extract=(env,owner=reader)=>pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:extractForm()}),env,base+'/extract',owner);
const render=env=>pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader);
const count=(sqlite,key)=>sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get(key)?.count??0;

test('A student has one PDF service call at a time: another tab waits, other students do not, and a failed call frees it',async t=>{
 const {sqlite,env}=sqliteEnvironment(t);let release,entered,calls=0,fail=false;const held=new Promise(done=>{release=done;}),reached=new Promise(done=>{entered=done;});
 t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1){entered();await held;}if(fail)return Response.json({error:'Dịch vụ PDF đang bận.'},{status:503});return Response.json({document:document(),originalPdfBase64:btoa(pdf)});});
 const first=extract(env);await reached;assert.equal(calls,1);
 const second=await extract(env);assert.equal(second.status,429);assert.equal(second.headers.get('Retry-After'),'30');
 assert.deepEqual(await second.json(),{error:'Tài khoản của bạn đang có một lượt xử lý PDF khác (tách trang hoặc xuất PDF) chưa xong. Hãy đợi lượt đó xong rồi thử lại.',code:'pdf_busy',retryAfter:30});
 await env.FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));await env.FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 const refresh=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader);assert.equal(refresh.status,429);assert.equal((await refresh.json()).code,'pdf_busy');
 assert.equal((await extract(env,other)).status,201,'another student is not held up');assert.equal(calls,2);
 release();assert.equal((await first).status,201);
 assert.equal(count(sqlite,`pdf-extract:${reader.id}`),1,'waiting for the lease does not use up the day');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0,'every lease is given back');
 fail=true;await assert.rejects(()=>extract(env),/bận/u);fail=false;
 assert.equal((await extract(env)).status,201,'a failed call gave its lease back');
});

test('Exporting a Vietnamese PDF has a daily cap per account, counted only for exports that reach the service',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{DAILY_PDF_RENDERS_PER_USER:'2'}),row=await seed(env);let calls=0;
 sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id,library_chapter_id) VALUES(?,?,?,?,?,?,?)').run(row.id,reader.id,row.title,row.state_key,'complete','private-story','private-chapter');
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]});});
 const incomplete=await (await env.FILES.get(row.state_key)).json();await env.FILES.put(row.state_key,JSON.stringify({...incomplete,complete:false}));
 assert.equal((await render(env)).status,409,'refused before the service');await env.FILES.put(row.state_key,JSON.stringify(incomplete));
 assert.equal((await render(env)).status,200);assert.equal((await render(env)).status,200);
 const capped=await render(env),body=await capped.json();assert.equal(capped.status,429);assert.equal(calls,2);
 assert.equal(body.error,'Bạn đã dùng hết 2 lượt xuất PDF tiếng Việt hôm nay. Hạn mức được đặt lại lúc 0:00 (giờ Việt Nam).');assert.ok(body.retryAfter>0);
 assert.equal(count(sqlite,`pdf-render:${reader.id}`),3);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0);
});

test('A PDF drawn by a service on other layout code than the Worker (an image not rebuilt after a deploy) is not kept and costs no daily export',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{PDF_LAYOUT_VERSION:' 0123abcd\n'}),row=await seed(env);let drawn,calls=0;const logged=[];
 sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,state_key,status,library_story_id,library_chapter_id) VALUES(?,?,?,?,?,?,?)').run(row.id,reader.id,row.title,row.state_key,'complete','private-story','private-chapter');
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[],...(drawn===undefined?{}:{layoutVersion:drawn})});});
 t.mock.method(console,'error',line=>{try{logged.push(JSON.parse(line));}catch{logged.push(line);}});
 const translated=assetKey(reader,'translated.pdf'),exported=async()=>(await (await env.FILES.get(row.state_key)).json()).pdfLayout.exported;
 // An image from before this check names no layout; one on older or newer code names another.
 for(drawn of [undefined,null,'89abcdef','0123ABCD']){
  const answer=await render(env);assert.equal(answer.status,503,String(drawn));
  assert.deepEqual(await answer.json(),{error:'Dịch vụ PDF chưa được cập nhật cùng phiên bản với trang web, nên PDF vừa dựng chưa được lưu và lượt xuất này không bị tính. Hãy thử xuất lại sau ít phút.',code:'pdf_service_outdated'});
  assert.equal(await env.FILES.get(translated),null,'no PDF stored');assert.equal(await exported(),undefined,'the session is not marked exported');
  assert.deepEqual(logged.at(-1),{event:'pdf_service_outdated',expected:'0123abcd',drawn:typeof drawn==='string'?drawn:null});
 }
 assert.equal(calls,4);assert.equal(count(sqlite,`pdf-render:${reader.id}`),0,'every refused export was given back');
 assert.equal(sqlite.prepare('SELECT file_key FROM chapters WHERE id=?').get('private-chapter').file_key,null,'the chapter links no PDF');
 drawn='0123abcd';const kept=await render(env);assert.equal(kept.status,200);
 assert.ok(await env.FILES.get(translated));assert.equal(await exported(),true);assert.equal(count(sqlite,`pdf-render:${reader.id}`),1);
 // Without PDF_LAYOUT_VERSION (a local run) nothing is compared, as /api/health?deep=1 compares nothing then.
 drawn=undefined;delete env.PDF_LAYOUT_VERSION;assert.equal((await render(env)).status,200);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0,'every lease is given back');
});

test('OCR results for an account deleted during the Gemini call are not kept, and the tokens spent are still reported',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),key=assetKey(reader,'manifest.json');
 await env.FILES.put(key,JSON.stringify({version:1,pages:[{number:4,width:600,height:800,ocr:true,background:png,original:png,blocks:[{id:'p4-b0',source:'Tesseract 猜错',image:png,box:[20,20,220,80],fontSize:12}]}]}));
 t.mock.method(globalThis,'fetch',async()=>{
  sqlite.prepare('UPDATE reader_users SET deleting_at=CURRENT_TIMESTAMP WHERE id=?').run(reader.id);
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({blocks:[{id:'p4-b0',text:'空间向量。'}],warnings:[]})}]}}],usageMetadata:{promptTokenCount:23,candidatesTokenCount:17,totalTokenCount:40}});
 });
 const response=await pdfLayoutRoute(jsonRequest(base+'/ocr-blocks',{assetId,apiKey:'student-ocr-key-12345678901234567890',model:'gemini-3.6-flash',blockIds:['p4-b0']}),env,base+'/ocr-blocks',reader),body=await response.json();
 assert.equal(response.status,410);assert.equal(body.code,'account_deleted');assert.equal(body.usage.total,40);
 assert.equal(env.FILES.values.has(key),false,'the manifest written after the deletion is removed again');
});

// What a PDF call's failure is in the browser: the Worker's answer (errorResponse for a thrown error) read the way
// study.js api() reads it, then classified as a whole-book run classifies it.
async function browserError(call){
 let response;try{response=await call();}catch(error){response=errorResponse(error);}
 const data=await response.json();
 return Object.assign(new Error(data.error),{status:response.status,data,retryAfter:Number(response.headers.get('Retry-After'))||null});
}
const until=async(check,ms=5000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('timed out waiting');await new Promise(done=>setTimeout(done,5));}};
const ocrBody=(blockIds,extra={})=>({assetId,apiKey:'student-ocr-key-12345678901234567890',model:'gemini-3.6-flash',blockIds,...extra});
const geminiReading=(blocks,warnings=[])=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({blocks,warnings})}]}}],usageMetadata:{promptTokenCount:23,candidatesTokenCount:17,totalTokenCount:40}});

test('PDF service failures reach the browser typed: busy is waited out, too heavy halves the chunk, out of reach backs off',async t=>{
 const {env}=environment();let answer;t.mock.method(globalThis,'fetch',async()=>answer());
 const call=()=>pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:extractForm()}),env,base+'/extract',reader);
 const heavy='Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.',memory='Dịch vụ PDF dừng đột ngột khi xử lý các trang đã chọn (tín hiệu SIGKILL, có thể do hết bộ nhớ). Hãy thử lại với ít trang hơn; nếu vẫn lỗi, hãy kiểm tra tệp PDF.';
 // [service answer, browser status, code, whole-book reason]; the answers without code are an older service's.
 const cases=[
  [()=>Response.json({error:'Dịch vụ PDF đang bận. Hãy thử lại sau.',code:'busy',retryAfter:20},{status:503,headers:{'Retry-After':'20'}}),503,'pdf_service_busy','pdf_busy'],
  [()=>Response.json({error:'Dịch vụ PDF đang bận. Hãy thử lại sau.'},{status:503}),503,'pdf_service_busy','pdf_busy'],
  [()=>Response.json({error:heavy,code:'timeout'},{status:422}),413,'pdf_timeout','too_large'],
  [()=>Response.json({error:heavy},{status:422}),413,'pdf_timeout','too_large'],
  [()=>Response.json({error:memory,code:'memory'},{status:422}),413,'pdf_memory','too_large'],
  [()=>Response.json({error:memory},{status:422}),413,'pdf_memory','too_large'],
  [()=>Response.json({error:'Không đủ bộ nhớ để xử lý các trang đã chọn. Hãy chọn ít trang hơn cho mỗi lượt.'},{status:422}),413,'pdf_memory','too_large'],
  [()=>Response.json({error:'Kết quả tách PDF vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.',code:'too_large'},{status:422}),413,'pdf_too_large','too_large'],
  [()=>Response.json({error:'Dịch vụ PDF dừng đột ngột khi xử lý các trang đã chọn (tín hiệu SIGSEGV). Hãy thử lại với ít trang hơn; nếu vẫn lỗi, hãy kiểm tra tệp PDF.',code:'crash'},{status:422}),413,'pdf_crash','too_large'],
  [()=>{throw new TypeError('fetch failed');},503,'pdf_unavailable','network'],
  [()=>{throw new DOMException('The operation timed out.','TimeoutError');},413,'pdf_timeout','too_large'],
  [()=>new Response('<html>502 Bad Gateway</html>',{status:502,headers:{'Content-Type':'text/html'}}),503,'pdf_unavailable','network']
 ];
 for(const [make,status,code,reason] of cases){
  answer=make;const error=await browserError(call),kind=classifyError(error,'extract');
  assert.equal(error.status,status,code);assert.equal(error.data.code,code);assert.equal(kind.reason,reason,code);
  if(status===503){assert.ok(error.retryAfter>0,code);assert.equal(error.data.retryAfter,error.retryAfter);}
  if(['pdf_timeout','pdf_memory','pdf_too_large'].includes(code))assert.equal(kind.heavy,true,code);
 }
 // Busy is waited out far longer than a lost connection, and a hidden tab keeps counting down.
 answer=cases[0][0];const busy=classifyError(await browserError(call),'extract');
 for(const [key,value] of Object.entries({reason:'pdf_busy',backoff:true,retries:30,wait:20,early:false,jitter:true}))assert.deepEqual(busy[key],value,key);
 // A problem of the file itself keeps its plain answer, so a run halves the chunk to find that page.
 answer=()=>Response.json({error:'Trang 3: không đọc được hình vẽ.'},{status:422});
 const page=await browserError(call);assert.equal(page.status,400);assert.equal(page.data.code,undefined);assert.equal(classifyError(page,'extract').reason,'page');
 assert.match((await browserError(call)).data.error,/^Trang 3: /u);
});

test('An export refused for translations longer than their boxes reaches the browser as 422 pdf_overflow with the boxes to open',async t=>{
 const {env,FILES,sessions}=environment(),row=await seed(env);sessions.set(historyId,row);let answer;t.mock.method(globalThis,'fetch',async()=>answer());
 const call=()=>browserError(()=>pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId}),env,base+'/render',reader));
 // The service's text names each block ("Trang N · đoạn k") and the controls of Xưởng dịch; it is passed on whole (up to 600
 // characters), and only well-formed boxes go with it.
 const message=overflowMessage(Array.from({length:3000},(_,i)=>({page:10000+i,id:`p${10000+i}-b${i}`,label:`Đoạn ${1001+i}`})));
 assert.ok(message.length>400&&message.length<=600,String(message.length));
 answer=()=>Response.json({error:message,code:'overflow',blocks:[{page:4,id:'p4-b0'},{page:4,id:'p4-b1'},{page:'4',id:'p4-b2'},{page:5,id:'<b>'},null]},{status:422});
 const refused=await call();
 assert.equal(refused.status,422);assert.deepEqual(refused.data,{error:message,code:'pdf_overflow',blocks:[{page:4,id:'p4-b0'},{page:4,id:'p4-b1'}]});
 const kind=classifyError(refused);assert.ok(!kind.backoff&&!kind.wait&&!kind.heavy&&kind.reason!=='too_large',`not waited out, retried or halved: the student shortens the translation (${JSON.stringify(kind)})`);
 assert.equal(FILES.values.has(assetKey(reader,'translated.pdf')),false);assert.notEqual((await (await FILES.get(row.state_key)).json()).pdfLayout.exported,true);
 // A browser the service could not start is the service's problem: waited out like a service that is restarting.
 const down='Dịch vụ PDF chưa mở được trình duyệt để dựng bản PDF tiếng Việt. Hãy thử xuất lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.';
 answer=()=>Response.json({error:down,code:'browser'},{status:500});
 const unavailable=await call();
 assert.equal(unavailable.status,503);assert.deepEqual(unavailable.data,{error:down,code:'pdf_unavailable',retryAfter:30});assert.equal(unavailable.retryAfter,30);
 assert.equal(classifyError(unavailable).reason,'network');
 // A body over the service's limit: too heavy for one job.
 answer=()=>Response.json({error:'Dữ liệu gửi tới dịch vụ PDF lớn hơn 40 MB, vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.',code:'too_large'},{status:413});
 const heavy=await call();assert.equal(heavy.status,413);assert.equal(heavy.data.code,'pdf_too_large');
});

test('The PDF service is shared out: a few slots for the whole site, one per account, 503 with Retry-After when all are taken',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),third={id:'student-3',name:'Mai'};
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(third.id,'sub-3','s3@example.test','Mai');
 const held=[];let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;await new Promise(done=>held.push(done));return Response.json({document:document(),originalPdfBase64:btoa(pdf)});});
 const slots=()=>sqlite.prepare("SELECT COUNT(*) AS n FROM service_leases WHERE key LIKE 'pdf-slot:%'").get().n;
 const first=extract(env,reader),second=extract(env,other);await until(()=>calls===2);
 // The same account never takes a second slot: its own lease answers first.
 const again=await extract(env,reader);assert.equal(again.status,429);assert.equal((await again.json()).code,'pdf_busy');assert.equal(slots(),2);
 const full=await extract(env,third);
 assert.equal(full.status,503);assert.equal(full.headers.get('Retry-After'),'20');
 assert.deepEqual(await full.json(),{error:'Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.',code:'pdf_service_busy',retryAfter:20});
 assert.equal(calls,2,'a full service is never called');assert.equal(count(sqlite,`pdf-extract:${third.id}`),0,'a refused call does not use up the day');
 held[0]();assert.equal((await first).status,201);
 const later=extract(env,third);await until(()=>calls===3);held[1]();held[2]();
 assert.equal((await second).status,201);assert.equal((await later).status,201);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0,'every lease is given back');
 // PDF_LAYOUT_SLOTS sets how many calls the site runs at once (a larger or a smaller service).
 env.PDF_LAYOUT_SLOTS='1';const only=extract(env,reader);await until(()=>calls===4);
 assert.equal((await extract(env,other)).status,503);held[3]();assert.equal((await only).status,201);
 // A slot left by a Worker that stopped mid-call is free again once its lease runs out.
 sqlite.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?,?,?)').run('pdf-slot:0','stopped-worker',Date.now()+60000);
 assert.equal((await extract(env,other)).status,503);
 sqlite.prepare("UPDATE service_leases SET expires_at=? WHERE key='pdf-slot:0'").run(Date.now()-1);
 const resumed=extract(env,other);await until(()=>calls===5);held[4]();assert.equal((await resumed).status,201);
});

test('A lease lasts a minute unless renewed, is renewed while its call runs, and never frees a newer holder',async t=>{
 const {sqlite,env}=sqliteEnvironment(t);let now=1_000_000;const clock=()=>now;
 const lease=await holdLease(env,'pdf-slot:0',{now:clock});assert.ok(lease);assert.equal(await holdLease(env,'pdf-slot:0',{now:clock}),null);
 now+=59_000;assert.equal(await lease.renew(),true);now+=59_000;assert.equal(await holdLease(env,'pdf-slot:0',{now:clock}),null,'renewed, still held');
 now+=2_000;const newer=await holdLease(env,'pdf-slot:0',{now:clock});assert.ok(newer,'a lease nobody renews runs out');
 assert.equal(await lease.renew(),false,'the old holder learns that it lost its slot');await lease.release();
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM service_leases WHERE key='pdf-slot:0'").get().n,1,'releasing an old lease never frees the newer one');
 await newer.release();assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,0);
 let renewals=0;const counting={renew:async()=>{renewals++;return true;},release:async()=>{}};
 assert.equal(await keepRenewed([counting],()=>new Promise(done=>setTimeout(()=>done('done'),150)),{every:20}),'done');
 const after=renewals;assert.ok(after>=3,`${after} renewals`);await new Promise(done=>setTimeout(done,80));assert.equal(renewals,after,'renewing stops with the call');
 // Without D1 nothing is refused.
 const open=await holdLease({},'pdf-slot:0');assert.equal(await open.renew(),true);
});

test('OCR answers only the blocks it read when asked (slim), and keeps a reading another tab stored during the Gemini call',async t=>{
 const {env,FILES}=environment(),key=assetKey(reader,'manifest.json');
 await FILES.put(key,JSON.stringify({version:1,pages:[{number:4,width:600,height:800,ocr:true,background:png,original:png,blocks:[{id:'p4-b0',source:'Tesseract 猜错',image:png,box:[20,20,220,80],fontSize:12},{id:'p4-b1',source:'另一 段',image:png,box:[20,100,220,160],fontSize:12}]}]}));
 t.mock.method(globalThis,'fetch',async()=>{
  const stored=JSON.parse(await (await FILES.get(key)).text());Object.assign(stored.pages[0].blocks[1],{source:'另一段。',text:'另一段。',ocrCorrected:true});await FILES.put(key,JSON.stringify(stored));
  return geminiReading([{id:'p4-b0',text:'1.2 空间向量'}],['Ảnh hơi mờ.']);
 });
 const response=await pdfLayoutRoute(jsonRequest(base+'/ocr-blocks',ocrBody(['p4-b0'],{slim:true})),env,base+'/ocr-blocks',reader),body=await response.json();
 const stored=JSON.parse(await (await FILES.get(key)).text()),[read,other]=stored.pages[0].blocks;
 assert.equal(response.status,200);assert.equal(body.document,undefined,'no page images go back');
 assert.deepEqual(body.blocks,[{id:'p4-b0',source:read.source,text:read.text,ocrCorrected:true,kind:'heading',bold:true}]);assert.equal(read.source,'1.2 空间向量');
 assert.equal(other.source,'另一段。',"the other tab's reading is kept");assert.equal(other.ocrCorrected,true);
 assert.equal(body.ocrCorrectedVersion,1);assert.equal(stored.ocrCorrectedVersion,1);assert.deepEqual(body.ocrWarnings,stored.ocrWarnings);assert.deepEqual(body.warnings,['Ảnh hơi mờ.']);
 assert.equal(body.usage.total,40);assert.equal(body.model,'gemini-3.6-flash');
 // Without slim the answer is the whole manifest, as before.
 t.mock.method(globalThis,'fetch',async()=>geminiReading([{id:'p4-b0',text:'1.2 空间向量'}]));
 const full=await (await pdfLayoutRoute(jsonRequest(base+'/ocr-blocks',ocrBody(['p4-b0'])),env,base+'/ocr-blocks',reader)).json();
 assert.deepEqual(full.document,JSON.parse(await (await FILES.get(key)).text()));assert.equal(full.usage.total,40);assert.equal(full.blocks,undefined);
 // A manifest removed during the Gemini call is not written back; the tokens are still reported.
 t.mock.method(globalThis,'fetch',async()=>{await FILES.delete(key);return geminiReading([{id:'p4-b0',text:'1.2 空间向量'}]);});
 await FILES.put(key,JSON.stringify(full.document));
 const gone=await pdfLayoutRoute(jsonRequest(base+'/ocr-blocks',ocrBody(['p4-b0'],{slim:true})),env,base+'/ocr-blocks',reader);
 assert.equal(gone.status,404);assert.equal((await gone.json()).usage.total,40);assert.equal(FILES.values.has(key),false);
});

test('Manifests are stored as ASCII JSON and handed on as stored bytes: the extract answer, GET and the export request',async t=>{
 const {env,FILES,sessions}=environment(),renders=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).endsWith('/render')){renders.push(await new Response(options.body).text());return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]});}
  return Response.json({document:document(),originalPdfBase64:btoa(pdf)});
 });
 const response=await pdfLayoutRoute(new Request(origin+base+'/extract',{method:'POST',body:extractForm()}),env,base+'/extract',reader),text=await response.text(),result=JSON.parse(text);
 assert.equal(response.status,201);assert.match(response.headers.get('Content-Type'),/^application\/json/u);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const stored=new TextDecoder().decode(FILES.values.get(`study/${reader.id}/pdf-layout/${result.assetId}/manifest.json`).value);
 assert.doesNotMatch(stored,/[^\x00-\x7f]/u,'one byte per character in V8');assert.deepEqual(JSON.parse(stored),result.document);assert.equal(result.document.pages[0].blocks[0].source,'定义向量。');
 assert.ok(text.includes(stored),'the answer carries the stored bytes as they are');
 // GET streams the stored object: it is neither parsed nor serialised again.
 const path=`${base}/assets/${result.assetId}/manifest`,unparsed={get:async()=>({body:new Response(stored).body,json:()=>{throw new Error('parsed');},text:()=>{throw new Error('parsed');}}),put:async()=>{}};
 const streamed=await pdfLayoutRoute(new Request(origin+path),{...env,FILES:unparsed},path,reader);
 assert.equal(streamed.status,200);assert.equal(await streamed.text(),stored);assert.match(streamed.headers.get('Content-Type'),/^application\/json/u);assert.equal(streamed.headers.get('Cache-Control'),'no-store');
 // An export sends the stored manifest (here one written before this change, Chinese unescaped) as it is.
 const row=await seed(env);sessions.set(historyId,row);const before=await (await FILES.get(assetKey(reader,'manifest.json'))).text();
 // Storage hands the body over as a stream, which goes on to the service as it is read.
 const streaming={...env,FILES:{get:async key=>{const object=await FILES.get(key);return object&&{...object,body:new Response(object.body).body};},put:(...args)=>FILES.put(...args)}};
 assert.equal((await render(streaming)).status,200);assert.ok(renders[0].includes(before));
 const sent=JSON.parse(renders[0]);assert.deepEqual(sent.document,document());assert.equal(sent.title,row.title);assert.deepEqual(sent.translations.map(item=>item.id),['p4-b0','p4-b1']);
});

// Like R2: every stored object has an etag, and put() with onlyIf.etagMatches stores nothing (null) when it differs.
class EtagFiles extends MemoryFiles{
 constructor(){super();this.etags=new Map();this.version=0;}
 async put(key,value,options){const wanted=options?.onlyIf?.etagMatches;if(wanted!==undefined&&this.etags.get(key)!==wanted)return null;await super.put(key,value,options);this.etags.set(key,`etag-${++this.version}`);return {key,etag:this.etags.get(key)};}
 async get(key){const object=await super.get(key);return object&&{...object,etag:this.etags.get(key)};}
}
// A PDF range saved as complete through the history route over real SQLite: its revision, its chapter and its state.json.
async function pdfSession(t,{files=null}={}){
 const {sqlite,env}=sqliteEnvironment(t);if(files)env.FILES=files;
 await env.FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(document()));
 const sources=document().pages[0].blocks.map(b=>b.source),historyPath='/api/my/study/history';
 const save=async(translationParts,{id,revision}={})=>{
  const path=id?`${historyPath}/${id}`:historyPath,body={title:'Vectơ - bài 1',filename:'lesson.pdf',domain:'math',...(revision===undefined?{}:{revision}),state:{source:sources.join('\n\n'),parts:sources,translationParts,done:translationParts.filter(Boolean).length,pdfLayout:{assetId}}};
  const response=await studyHistoryRoute(new Request(origin+path,{method:id?'PUT':'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)}),env,path,reader);
  return {...await response.json(),http:response.status};
 };
 const first=await save(['Định nghĩa vectơ.','Công thức @@PDF_INLINE_0@@.']);assert.equal(first.http,201);assert.equal(first.revision,1);
 const stateKey=`study/${reader.id}/${first.id}/state.json`;
 return {sqlite,env,save,first,stateKey,state:async()=>JSON.parse(await (await env.FILES.get(stateKey)).text()),
  chapter:()=>({...sqlite.prepare('SELECT file_key,mime FROM chapters WHERE id=?').get(first.libraryChapterId)}),
  render:()=>browserError(()=>pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId:first.id}),env,base+'/render',reader))};
}

test('An export never undoes a save made while the service worked, nor links the PDF of the older text',async t=>{
 const {sqlite,env,save,first,state,chapter,render}=await pdfSession(t);
 let release,entered;const held=new Promise(done=>{release=done;}),reached=new Promise(done=>{entered=done;}),sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push(JSON.parse(await new Response(options.body).text()).translations.map(item=>item.translation));if(sent.length===1){entered();await held;}return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]});});
 const exporting=render();await reached;
 // Meanwhile another tab saves a corrected block, naming the revision it was opened at: accepted as revision 2.
 const edited=['Định nghĩa vectơ.','Công thức đã sửa @@PDF_INLINE_0@@.'],saved=await save(edited,{id:first.id,revision:first.revision});
 assert.equal(saved.http,200);assert.equal(saved.revision,2);
 release();const refused=await exporting;
 assert.equal(refused.status,409);assert.equal(refused.data.code,'history_conflict');assert.equal(refused.data.revision,2);assert.ok(refused.data.updatedAt);
 assert.match(refused.data.error,/^Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác trong lúc xuất PDF.*Lịch sử dịch.*Xuất PDF tiếng Việt\.$/u);
 assert.equal(classifyError(refused).reason,'conflict','a whole-book run pauses as for a save from an older copy');
 // The newer save stands, unexported, and the library keeps its text instead of a PDF of the older one.
 const kept=await state();assert.deepEqual(kept.translationParts,edited);assert.notEqual(kept.pdfLayout.exported,true);
 assert.deepEqual(chapter(),{file_key:null,mime:'text/plain'});assert.equal(env.FILES.values.has(assetKey(reader,'translated.pdf')),false);
 assert.equal(sqlite.prepare('SELECT revision FROM study_sessions WHERE id=?').get(first.id).revision,2,'the export wrote nothing');
 // Exported again, the PDF is made from the newer text and kept.
 const again=await render();assert.equal(again.status,200,again.message);assert.deepEqual(sent[1],edited);
 assert.equal((await state()).pdfLayout.exported,true);assert.deepEqual((await state()).translationParts,edited);assert.deepEqual(chapter(),{file_key:assetKey(reader,'translated.pdf'),mime:'application/pdf'});
});

test('A save landing after the export\'s last check is never overwritten: the chapter link checks the revision, state.json its etag',async t=>{
 // The other tab's save lands while the PDF is being stored: after the export compared the session, before it links the
 // chapter (the save's whole route runs), or only its state.json write before the chapter link and the export's write.
 for(const step of ['whole save','state.json only']){
  const files=new EtagFiles(),{env,save,first,state,stateKey,chapter,render}=await pdfSession(t,{files});
  t.mock.method(globalThis,'fetch',async()=>Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]}));
  const edited=['Định nghĩa vectơ.','Công thức sửa ở thẻ khác @@PDF_INLINE_0@@.'],put=files.put.bind(files),stateWrites=[];let landed=null;
  files.put=async(key,value,options)=>{
   if(key===stateKey)stateWrites.push(options);
   if(!landed&&key.endsWith('/translated.pdf')){
    landed=step==='whole save'?await save(edited,{id:first.id,revision:first.revision}):await put(stateKey,JSON.stringify({...await state(),translationParts:edited}));
   }
   return put(key,value,options);
  };
  const refused=await render();
  assert.equal(refused.status,409,step);assert.equal(refused.data.code,'history_conflict',step);
  const kept=await state();assert.deepEqual(kept.translationParts,edited,step);assert.notEqual(kept.pdfLayout.exported,true,step);
  if(step==='whole save'){assert.equal(landed.http,200);assert.equal(refused.data.revision,2);assert.deepEqual(chapter(),{file_key:null,mime:'text/plain'},'the link waited for the same revision');}
  // The export's own write named the etag of the copy it compared, so storage refused it.
  else assert.match(String(stateWrites.at(-1)?.onlyIf?.etagMatches),/^etag-\d+$/u);
 }
});

test('An export overtaken by a save of the same translations is kept; one overtaken by other translations is refused and gives the day\'s export back',async t=>{
 const files=new EtagFiles(),{sqlite,env,save,first,state,chapter,render}=await pdfSession(t,{files}),translated=assetKey(reader,'translated.pdf');
 // The PDF service holds each export until the test lets it answer (also when an assertion fails first).
 let gate=null;const opened=[],hold=()=>{let open,reached;const entered=new Promise(done=>{reached=done;}),held=new Promise(done=>{open=done;});gate={held,reached};opened.push(open);return {entered,open};};
 t.after(()=>{for(const open of opened)open();});
 t.mock.method(globalThis,'fetch',async(url,options)=>{await new Response(options.body).arrayBuffer();const waiting=gate;gate=null;if(waiting){waiting.reached();await waiting.held;}return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]});});
 const same=['Định nghĩa vectơ.','Công thức @@PDF_INLINE_0@@.'],revision=()=>sqlite.prepare('SELECT revision FROM study_sessions WHERE id=?').get(first.id).revision;
 const exportedPdf=()=>({file_key:translated,mime:'application/pdf'}),text=()=>({file_key:null,mime:'text/plain'}),exports=()=>count(sqlite,`pdf-render:${reader.id}`);
 // Another tab saves the session unchanged ("Lưu đoạn đã sửa" without an edit) while the PDF is made: a new revision, the
 // same text. The PDF still shows that text: it is kept and linked at the new revision.
 let call=hold(),exporting=render();await call.entered;
 const resaved=await save(same,{id:first.id,revision:first.revision});assert.equal(resaved.http,200);assert.equal(resaved.revision,2);
 call.open();const kept=await exporting;
 assert.equal(kept.status,200,kept.message);assert.equal(kept.data.url,`${base}/assets/${assetId}/translated`);
 assert.deepEqual(chapter(),exportedPdf());assert.ok(files.values.has(translated));assert.equal(revision(),2,'the export made no revision of its own');
 assert.equal((await state()).pdfLayout.exported,true);assert.equal((await state()).pdfLayout.renderVersion,3);assert.deepEqual((await state()).translationParts,same);
 assert.equal(exports(),1);
 // Saved unchanged once more from that tab, the session keeps its PDF.
 assert.equal((await save(same,{id:first.id,revision:2})).revision,3);assert.deepEqual(chapter(),exportedPdf());assert.ok(files.values.has(translated));
 // An edited block makes the part text again; exported anew while the other tab saves that text unchanged, and that
 // save's last step (removing the PDF of a copy it saw unexported) comes only after the export stored its PDF: the export
 // stores it again, so the chapter is never linked to nothing.
 const edited=['Định nghĩa vectơ.','Công thức đã sửa @@PDF_INLINE_0@@.'];
 assert.equal((await save(edited,{id:first.id,revision:3})).revision,4);assert.deepEqual(chapter(),text());assert.equal(files.values.has(translated),false);
 call=hold();exporting=render();await call.entered;
 assert.equal((await save(edited,{id:first.id,revision:4})).revision,5);assert.deepEqual(chapter(),text());
 const put=files.put.bind(files);let removedLate=false;
 files.put=async(key,value,options)=>{const stored=await put(key,value,options);if(key===translated&&!removedLate){removedLate=true;await files.delete(key);}return stored;};
 call.open();const again=await exporting;files.put=put;
 assert.equal(again.status,200,again.message);assert.ok(removedLate);assert.ok(files.values.has(translated),'stored again');assert.deepEqual(chapter(),exportedPdf());
 assert.equal((await state()).pdfLayout.exported,true);assert.deepEqual((await state()).translationParts,edited);assert.equal(exports(),2);
 // Other translations saved meanwhile: the PDF is not kept, and the refused export does not use up the day's exports.
 call=hold();exporting=render();await call.entered;assert.equal(exports(),3,'counted while the service works');
 const other=['Định nghĩa vectơ.','Công thức sửa ở thẻ khác @@PDF_INLINE_0@@.'];assert.equal((await save(other,{id:first.id,revision:5})).revision,6);
 call.open();const refused=await exporting;
 assert.equal(refused.status,409);assert.equal(refused.data.code,'history_conflict');assert.equal(refused.data.revision,6);
 assert.equal(refused.data.error,'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác trong lúc xuất PDF, nên PDF vừa dựng không khớp bản mới nhất và chưa được lưu. Hãy mở lại bản dịch từ Lịch sử dịch rồi bấm Xuất PDF tiếng Việt.');
 assert.equal(exports(),2,'the refused export is given back');
 assert.deepEqual((await state()).translationParts,other);assert.notEqual((await state()).pdfLayout.exported,true);assert.deepEqual(chapter(),text());
 const latest=await render();assert.equal(latest.status,200,latest.message);assert.equal(exports(),3);assert.deepEqual(chapter(),exportedPdf());
});

// The bytes of a request body as the browser sends them, read only when someone pulls them: reads counts the pulls.
async function recordedBody(body){
 const encoded=new Response(body),type=encoded.headers.get('Content-Type'),bytes=new Uint8Array(await encoded.arrayBuffer()),record={reads:0};let offset=0;
 const stream=new ReadableStream({pull(controller){record.reads++;if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,offset+=1024));}},{highWaterMark:0});
 return {request:path=>new Request(origin+base+path,{method:'POST',headers:{'Content-Type':type,Origin:origin},body:stream,duplex:'half'}),record};
}
test('A busy answer comes before the upload is read: another call of the account, or every slot taken, costs no body and no daily call',async t=>{
 const {sqlite,env}=sqliteEnvironment(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({document:document(),originalPdfBase64:btoa(pdf)});});
 const chunk=()=>{const form=extractForm();form.set('sourceSha256','a'.repeat(64));form.set('pageOffset','10');form.set('pages','1-2');return form;};
 const bodies=()=>[['/extract',extractForm()],['/extract',chunk()],['/refresh',JSON.stringify({assetId,forceClone:true})],['/render',JSON.stringify({assetId,historyId})]];
 const leases=()=>sqlite.prepare('SELECT key,token FROM service_leases ORDER BY key').all().map(row=>`${row.key}=${row.token}`);
 const hold=(key,token)=>sqlite.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?,?,?)').run(key,token,Date.now()+60000);
 // Another tab of this account is extracting; then two other students hold both slots of the site.
 for(const [held,status,code,wait] of [[[['pdf:student-1','other-tab']],429,'pdf_busy','30'],[[['pdf-slot:0','student-2'],['pdf-slot:1','student-3']],503,'pdf_service_busy','20']]){
  sqlite.prepare('DELETE FROM service_leases').run();for(const [key,token] of held)hold(key,token);const before=leases();
  for(const [path,body] of bodies()){
   const {request,record}=await recordedBody(body),response=await pdfLayoutRoute(request(path),env,base+path,reader);
   assert.equal(response.status,status,path);assert.equal(response.headers.get('Retry-After'),wait,path);assert.equal((await response.json()).code,code,path);
   assert.equal(record.reads,0,`${path}: not a byte of the upload was read`);
  }
  assert.deepEqual(leases(),before,'the account\'s lease taken on the way is given back');
 }
 assert.equal(calls,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n,0,'no daily call used');
 // Once a slot is free, the same kind of upload is read and extracted.
 sqlite.prepare('DELETE FROM service_leases').run();
 const {request,record}=await recordedBody(extractForm()),response=await pdfLayoutRoute(request('/extract'),env,base+'/extract',reader);
 assert.equal(response.status,201);assert.ok(record.reads>0);assert.equal(calls,1);assert.equal(count(sqlite,`pdf-extract:${reader.id}`),1);
});

// A request body the test sends a piece at a time (send, end; fail breaks it off); pulls counts the reads that found
// nothing left to take, cancelled is the reason the Worker gave when it stopped reading.
function trickledBody(path,first,{type,length}){
 const record={pulls:0,cancelled:null},encoder=new TextEncoder();let controller;
 const stream=new ReadableStream({start(c){controller=c;},pull(){record.pulls++;},cancel(reason){record.cancelled=reason;}});
 controller.enqueue(encoder.encode(first));
 return {record,send:text=>controller.enqueue(encoder.encode(text)),end:()=>controller.close(),fail:()=>{try{controller.error(new Error('the test ended'));}catch{}},
  request:()=>new Request(origin+base+path,{method:'POST',headers:{'Content-Type':type,'Content-Length':String(length),Origin:origin},body:stream,duplex:'half'})};
}
// An extraction's multipart body: its head with the first bytes of the PDF, then the rest.
const BOUNDARY='----hoa-tri-test';
const multipartHead=`--${BOUNDARY}\r\nContent-Disposition: form-data; name="pages"\r\n\r\n4\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="lesson.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`;
const multipartRest=`selected page only\r\n--${BOUNDARY}--\r\n`,multipartType=`multipart/form-data; boundary=${BOUNDARY}`;
// Lets the Worker go on (D1 here answers at once) without moving the mocked clock.
const settle=async(check,rounds=100)=>{for(let i=0;i<rounds&&!check();i++)await new Promise(done=>setImmediate(done));assert.ok(check(),'the call did not get there');};
test('An upload holds no slot of the site while it arrives: a stalled one is stopped with 408 after its time limit, one finished after the last slot went is answered busy',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),third={id:'student-3',name:'Mai'};
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(third.id,'sub-3','s3@example.test','Mai');
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({document:document(),originalPdfBase64:btoa(pdf)});});
 t.mock.timers.enable({apis:['setTimeout']});
 const leases=()=>sqlite.prepare('SELECT key FROM service_leases ORDER BY key').all().map(row=>row.key),bodies=[];
 const trickled=(...args)=>{const sent=trickledBody(...args);bodies.push(sent);return sent;};t.after(()=>{for(const sent of bodies)sent.fail();});
 // Two students' uploads stop after their first bytes, then go on at a byte every 10 s: an extraction and an export.
 const upload=trickled('/extract',multipartHead,{type:multipartType,length:2000}),body=trickled('/render',`{"assetId":"${assetId}","historyId":`,{type:'application/json',length:100});
 const answers=[];
 const stalled=[[upload,'/extract',reader],[body,'/render',other]].map(([sent,path,owner],i)=>browserError(()=>pdfLayoutRoute(sent.request(),env,base+path,owner)).then(answer=>{answers[i]=answer;return answer;}));
 await settle(()=>upload.record.pulls>0&&body.record.pulls>0);
 assert.deepEqual(leases(),['pdf:student-1','pdf:student-2'],'while the bodies arrive, only their accounts are held');
 // Every other student still finds the whole service free.
 const capacity=await pdfLayoutRoute(new Request(origin+base+'/capacity'),env,base+'/capacity',third);
 assert.deepEqual(await capacity.json(),{busy:false,free:2,slots:2,retryAfter:null});
 assert.equal((await extract(env,third)).status,201);assert.equal(calls,1);
 for(let second=10;second<120;second+=10){t.mock.timers.tick(10000);upload.send(' ');body.send(' ');await settle(()=>true,5);}
 assert.deepEqual(answers,[],'still taken in after 110 s');
 // Two minutes after they began, both are stopped: the upload is cancelled, nothing is held and no daily call is used.
 t.mock.timers.tick(10000);await settle(()=>answers.filter(Boolean).length===2);
 for(const answer of await Promise.all(stalled)){
  assert.equal(answer.status,408);assert.equal(answer.retryAfter,null);
  assert.deepEqual(answer.data,{error:'Kết nối mạng quá chậm nên máy chủ chưa nhận hết dữ liệu gửi lên và đã dừng lượt xử lý PDF này. Hãy kiểm tra mạng (ví dụ chuyển sang Wi-Fi) rồi thử lại.',code:'upload_timeout'});
 }
 assert.ok(upload.record.cancelled&&body.record.cancelled,'the Worker stopped reading both');
 assert.deepEqual(leases(),[]);assert.equal(calls,1);
 assert.deepEqual(sqlite.prepare('SELECT key,count FROM rate_limits').all().map(row=>({...row})),[{key:`pdf-extract:${third.id}`,count:1}]);
 // The slots are counted before the body is read and taken once it is in: here both went meanwhile.
 const late=trickled('/extract',multipartHead,{type:multipartType,length:2000}),answer=browserError(()=>pdfLayoutRoute(late.request(),env,base+'/extract',reader));
 await settle(()=>late.record.pulls>0);assert.deepEqual(leases(),['pdf:student-1']);
 for(const slot of ['pdf-slot:0','pdf-slot:1'])sqlite.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?,?,?)').run(slot,'another-call',Date.now()+60000);
 late.send(multipartRest);late.end();
 const full=await answer;assert.equal(full.status,503);assert.equal(full.data.code,'pdf_service_busy');assert.equal(full.retryAfter,20);
 assert.equal(calls,1,'the service is not called');assert.equal(count(sqlite,`pdf-extract:${reader.id}`),0);assert.deepEqual(leases(),['pdf-slot:0','pdf-slot:1'],'its account is free again');
 // A large upload on a slow connection gets longer: 16 KB a second over the length it declares (or the route's limit).
 const deadline=(path,headers)=>bodyDeadline(new Request(origin+base+path,{method:'POST',headers}),base+path);
 assert.equal(deadline('/render',{'Content-Length':'100'}),120000);assert.equal(deadline('/extract',{'Content-Length':String(25*1024*1024)}),1600000);
 assert.equal(deadline('/extract',{}),Math.ceil(26*1024*1024/16384)*1000);
});

test('GET capacity tells a waiting browser whether its call would find a place, in one read of D1 that takes nothing',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),statements=[],db=env.DB;
 env.DB={prepare:sql=>{statements.push(sql);return db.prepare(sql);},batch:list=>db.batch(list)};
 const ask=async(owner=reader,vars=env)=>{statements.length=0;const response=await pdfLayoutRoute(new Request(origin+base+'/capacity'),vars,base+'/capacity',owner);return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json(),queries:statements.length};};
 const hold=(key,ms=60000)=>sqlite.prepare('INSERT INTO service_leases(key,token,expires_at) VALUES(?,?,?)').run(key,'held',Date.now()+ms);
 assert.deepEqual(await ask(),{status:200,cache:'no-store',body:{busy:false,free:2,slots:2,retryAfter:null},queries:1});
 hold('pdf-slot:0');assert.deepEqual((await ask()).body,{busy:false,free:1,slots:2,retryAfter:null});
 hold(`pdf:${reader.id}`);assert.deepEqual((await ask()).body,{busy:true,free:1,slots:2,retryAfter:30},'this account\'s own call is still running');
 assert.deepEqual((await ask(other)).body,{busy:false,free:1,slots:2,retryAfter:null},'another student is not held up by it');
 hold('pdf-slot:1');assert.deepEqual((await ask(other)).body,{busy:true,free:0,slots:2,retryAfter:20});assert.deepEqual((await ask()).body,{busy:true,free:0,slots:2,retryAfter:30});
 // A lease nobody renewed is free; a slot past PDF_LAYOUT_SLOTS (left from a larger setting) is not counted.
 sqlite.prepare("UPDATE service_leases SET expires_at=? WHERE key IN ('pdf-slot:1',?)").run(Date.now()-1,`pdf:${reader.id}`);hold('pdf-slot:12');
 assert.deepEqual((await ask()).body,{busy:false,free:1,slots:2,retryAfter:null});
 env.PDF_LAYOUT_SLOTS='3';assert.deepEqual((await ask()).body,{busy:false,free:2,slots:3,retryAfter:null});
 // Asking takes no lease and uses no daily call; without D1 the hint says free (the call itself still takes its leases).
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM service_leases').get().n,4);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n,0);
 const withoutDb={...env};delete withoutDb.DB;assert.deepEqual((await ask(reader,withoutDb)).body,{busy:false,free:3,slots:3,retryAfter:null});
 const path=base+'/capacity',url=new URL(origin+path),signedOut={...env,DB:{prepare(){return {bind(){return this;},async first(){return null;}};}}};
 assert.equal((await studyRoute(new Request(url),signedOut,url,path)).status,401,'only for a signed-in student');
});

test('A refresh too heavy for one job keeps the old copy, says how to go on, and gives the day\'s extraction back',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),prior=document();prior.totalPages=40;
 for(const number of [5,9]){const page=structuredClone(prior.pages[0]);page.number=number;page.blocks.forEach(b=>b.id=b.id.replace(/^p4-/u,`p${number}-`));prior.pages.push(page);}
 await env.FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));await env.FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 const writes=env.FILES.writes.length,asked=[];let answer;
 t.mock.method(globalThis,'fetch',async(url,options)=>{asked.push(options.headers);await new Response(options.body).arrayBuffer();return answer();});
 const refresh=()=>browserError(()=>pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader));
 // As the service numbers them: pages 1-3 of the stored range.
 const selected=count=>{const doc=structuredClone(prior);doc.pages=doc.pages.slice(0,count).map((page,i)=>{page.number=i+1;page.blocks.forEach(b=>b.id=b.id.replace(/^p\d+-/u,`p${i+1}-`));return page;});doc.extractionVersion=3;doc.totalPages=3;return doc;};
 const advice='Chưa cập nhật được bố cục của bản dịch này: 3 trang của nó (trang 4-5, 9) quá nặng để dịch vụ PDF xử lý hết trong một lượt. Bản dịch cũ vẫn còn nguyên trong Lịch sử dịch. Hãy chọn lại PDF gốc rồi dịch lại các trang đó thành nhiều lượt nhỏ hơn, ví dụ 3–5 trang mỗi lượt.';
 // The service stopped after the first page (its time budget, or its size limits): the pages it did cannot replace the range.
 answer=()=>{const doc=selected(1);doc.warnings=['Lượt này xử lý 1/3 trang đã chọn (trang 1) vì đã dùng hết thời gian xử lý của một lượt. Hãy dịch tiếp trang 2-3 ở lượt sau.'];return Response.json({document:doc,originalPdfBase64:btoa(pdf)});};
 const short=await refresh();
 assert.equal(short.status,413);assert.deepEqual(short.data,{error:advice,code:'pdf_too_large'});
 assert.equal(asked[0]['X-PDF-All-Pages'],'1','the service may give this job its whole time limit');assert.equal(asked[0]['X-PDF-Pages'],'1-3');
 // Out of time even so: the same advice, with the service's kind of failure.
 answer=()=>Response.json({error:'Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.',code:'timeout'},{status:422});
 const late=await refresh();assert.equal(late.status,413);assert.deepEqual(late.data,{error:advice,code:'pdf_timeout'});
 assert.equal(env.FILES.writes.length,writes,'nothing stored');assert.equal(count(sqlite,`pdf-extract:${reader.id}`),0,'nothing kept: the day\'s extractions are given back');
 // Every page back: refreshed, and counted.
 answer=()=>Response.json({document:selected(3),originalPdfBase64:btoa(pdf)});
 const done=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader);
 assert.equal(done.status,201);assert.deepEqual((await done.json()).document.pages.map(page=>page.number),[4,5,9]);assert.equal(count(sqlite,`pdf-extract:${reader.id}`),1);
});

test('A PDF service that refuses the Worker (another token or URL) is out of reach for students, logged for the operator, and costs no daily call',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),logs=[];t.mock.method(console,'error',line=>logs.push(String(line)));
 let status;t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Unauthorized'},{status}));
 for(status of [401,403,404]){
  const error=await browserError(()=>extract(env));
  assert.equal(error.status,503,String(status));assert.deepEqual(error.data,{error:'Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.',code:'pdf_unavailable',retryAfter:30});assert.equal(error.retryAfter,30);
  assert.equal(classifyError(error,'extract').reason,'network','a whole-book run backs off and tries again');
 }
 const refused=logs.filter(line=>line.includes('"event":"pdf_service_refused"'));assert.equal(refused.length,3);assert.match(refused[0],/"operation":"extract","status":401/u);assert.doesNotMatch(logs.join('\n'),/service-secret/u);
 // On the machine running both (npm start), the answer names the settings to compare.
 status=401;const local=await browserError(()=>extract({...env,PDF_LAYOUT_SERVICE_URL:'http://127.0.0.1:18191'}));
 assert.equal(local.data.code,'pdf_unavailable');assert.match(local.data.error,/PDF_LAYOUT_SERVICE_TOKEN hoặc PDF_LAYOUT_SERVICE_URL trong \.dev\.vars/u);
 // A busy service, one out of reach and a font the service lacks did not do the call either.
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Dịch vụ PDF đang bận. Hãy thử lại sau.',code:'busy',retryAfter:20},{status:503,headers:{'Retry-After':'20'}}));
 assert.equal((await browserError(()=>extract(env))).data.code,'pdf_service_busy');
 t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('fetch failed');});
 assert.equal((await browserError(()=>extract(env))).data.code,'pdf_unavailable');
 const noFont='Dịch vụ PDF đang thiếu phông chữ để dựng bản PDF tiếng Việt, nên chưa xuất được PDF. Hãy báo quản trị viên; bản dịch vẫn được lưu trong Lịch sử dịch.';
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:noFont,code:'font'},{status:500}));
 const font=await browserError(()=>pdfLayoutRoute(new Request(origin+base+'/font'),{...env,PDF_LAYOUT_SERVICE_URL:'https://font-missing.example.test/'},base+'/font',reader));
 assert.equal(font.status,503);assert.deepEqual(font.data,{error:noFont,code:'pdf_unavailable',retryAfter:30});
 assert.equal(count(sqlite,`pdf-extract:${reader.id}`),0,'none of these used up a daily call');
 t.mock.method(globalThis,'fetch',async()=>Response.json({document:document(),originalPdfBase64:btoa(pdf)}));
 assert.equal((await extract(env)).status,201);assert.equal(count(sqlite,`pdf-extract:${reader.id}`),1,'a call the service did is counted');
});
