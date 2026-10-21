import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {pdfLayoutRoute} from './pdf-layout.js';
import {studyRoute} from './study-translation.js';
import {studyHistoryRoute} from './study-history.js';

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

class MemoryFiles{
 constructor(){this.values=new Map();this.reads=[];this.writes=[];this.deletes=[];}
 async put(key,value,options){this.values.set(key,{value,options});this.writes.push({key,value,options});}
 // R2 deletes one key or a list of keys.
 async delete(keys){for(const key of [keys].flat()){this.deletes.push(key);this.values.delete(key);}}
 async get(key){
  this.reads.push(key);const item=this.values.get(key);if(!item)return null;
  const text=()=>typeof item.value==='string'?item.value:new TextDecoder().decode(item.value);
  return {body:typeof item.value==='string'?new TextEncoder().encode(item.value):item.value,customMetadata:item.options?.customMetadata,json:async()=>JSON.parse(text()),text:async()=>text()};
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
 assert.equal(await FILES.values.get(sourceKey).value.text(),pdf);
 assert.doesNotMatch(JSON.stringify(FILES.writes),/student-key|service-secret/);assert.doesNotMatch(JSON.stringify(result),/student-key|service-secret/);
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
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options,body:JSON.parse(options.body)});return Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[{id:'p4-b0',overflow:false}]});});
 const response=await pdfLayoutRoute(jsonRequest(base+'/render',{assetId,historyId,translations:[{id:'p4-b0',translation:'injected attacker translation'}],apiKey:'never-use-me'}),env,base+'/render',reader),result=await response.json();
 assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://pdf.example.test/v1/render');
 assert.deepEqual(calls[0].body.translations,[{id:'p4-b0',translation:'Định nghĩa vectơ.'},{id:'p4-b1',translation:'Công thức @@PDF_INLINE_0@@.'}]);
 assert.equal(calls[0].body.title,row.title);assert.equal(result.renderVersion,3);
 assert.doesNotMatch(JSON.stringify(calls[0].body),/attacker|never-use-me/);assert.equal(result.url,`${base}/assets/${assetId}/translated`);
 // The render addresses this range's own chapter, never every chapter of the book.
 const chapterUpdate=queries.find(item=>item.sql.startsWith('UPDATE chapters'));assert.match(chapterUpdate.sql,/WHERE id=\?/u);assert.doesNotMatch(chapterUpdate.sql,/WHERE story_id=/u);assert.deepEqual(chapterUpdate.args,[assetKey(reader,'translated.pdf'),'application/pdf','private-chapter',reader.id]);
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
 assert.equal(result.originalUrl,`${base}/assets/${result.assetId}/original`);assert.doesNotMatch(JSON.stringify(result),/student-key|service-secret/);assert.doesNotMatch(JSON.stringify(writes),/student-key|service-secret/);
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
 const stored=async id=>JSON.parse(FILES.values.get(`study/${reader.id}/pdf-layout/${id}/manifest.json`).value).sourceSha256;
 // The stored original is filed under this hash, so the Worker always hashes the upload itself: a browser value (or none,
 // on plain-HTTP phones without crypto.subtle) never decides it.
 const fromBrowser='c'.repeat(64);assert.equal(await stored(await extract(fromBrowser)),await hex(pdf));
 assert.equal(await stored(await extract()),await hex(pdf));assert.equal(await stored(await extract('not-a-hash')),await hex(pdf));
 const prior=document();prior.sourceSha256=fromBrowser;prior.totalPages=40;await FILES.put(assetKey(reader,'manifest.json'),JSON.stringify(prior));await FILES.put(assetKey(reader,'original.pdf'),new TextEncoder().encode(pdf));
 const response=await pdfLayoutRoute(jsonRequest(base+'/refresh',{assetId,forceClone:true}),env,base+'/refresh',reader),result=await response.json();
 assert.equal(response.status,201);assert.equal(result.document.sourceSha256,fromBrowser);assert.equal(await stored(result.assetId),fromBrowser);
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
