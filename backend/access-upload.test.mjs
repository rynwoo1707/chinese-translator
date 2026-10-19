import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import worker, {processJob,acceptReaderRequest} from './worker.js';
import pdfLibrary from './pdf.cjs';
import {preparePdf,getPdfManifest,assembleBook} from './pdf-pipeline.js';
import {PROMPT_VERSION,recognizeDocument,generate} from './ai.js';
import {renderMathText,mathStyles} from '../frontend/math-text.js';
import {termMatcher,highlightTerms,bindTermPopover} from '../frontend/reader-terms.js';
import {footerHtml} from '../frontend/site-footer.js';
import {isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL} from '../frontend/library-samples.js';
import {bilingualSource} from '../frontend/bilingual-reader.js';

test('Readers cannot access management APIs or private configuration',async()=>{
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',GEMINI_API_KEY:'private-key',DB:{prepare(){throw new Error('Private database accessed');}}};
 for(const [path,method] of [['/stories','GET'],['/stories','POST'],['/users','GET'],['/user-library','GET'],['/jobs','GET'],['/jobs','POST'],['/jobs/test/run','POST'],['/jobs/test/publish','POST'],['/jobs/test/file','GET'],['/requests','GET'],['/requests/test','PATCH'],['/stories/test','PATCH'],['/stories/test/cover','POST'],['/stories/test/cover','DELETE'],['/settings/gemini-key','PUT'],['/settings/gemini-key','DELETE']]){
  const response=await worker.fetch(new Request('https://test/api'+path,{method}),env,{});
  assert.equal(response.status,401,`${method} ${path}`);
 }
 const status=await worker.fetch(new Request('https://test/api/status'),env,{});
 assert.deepEqual(await status.json(),{authenticated:false});
});

test('Public library and reading remain available; requests require Google login',async()=>{
 const env={DB:{prepare(){return {bind(){return this;},async first(){return {id:'story',visibility:'public'};},async all(){return {results:[]};},async run(){return {};}};}}};
 for(const path of ['/library','/read/story'])assert.equal((await worker.fetch(new Request('https://test/api'+path),env,{})).status,200);
 const request=new Request('https://test/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Tài liệu cần dịch'})});
 assert.equal((await worker.fetch(request,env,{})).status,401);
});

test('Upload accepts exactly 25 MB and rejects larger files before storage',async()=>{
 let stored=0;
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(){return {bind(){return this;},async first(){return {id:'story'};},async run(){return {};}};}},FILES:{async put(key,data){stored=data.byteLength;}}};
 for(const [size,status] of [[25*1024*1024,201],[25*1024*1024+1,400],[0,400]]){
  stored=0;const form=new FormData();form.set('story_id','story');form.set('file',new File([new Uint8Array(size)],'test.pdf',{type:'application/pdf'}));
  const request=new Request('https://test/api/jobs',{method:'POST',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef'},body:form});
  const response=await worker.fetch(request,env,{});assert.equal(response.status,status);assert.equal(stored,status===201?size:0);
 }
});

test('Reader and admin layouts stay separated, including direct hashes and logout',async()=>{
 const source=(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n/gmu,'');
 const runJobSource=source.slice(source.indexOf('async function runJob'),source.indexOf('function requestStory'));
 assert.match(runJobSource,/chờ người quản trị đối chiếu/);
 assert.doesNotMatch(runJobSource,/\/publish/,'Hoàn tất dịch không được tự động công bố');
 assert.doesNotMatch(source,/import-website|data-ai-cover|generateAiCover|\/web-import|\/generate-cover/);
 function browser(pathname,hash=''){
  const app={innerHTML:''};const context=vm.createContext({musicMarkup:()=>'',bindMusic(){},renderMathText,mathStyles,termMatcher,highlightTerms,bindTermPopover,hideTermPopover:()=>{},attachHanziLookup(){},openHanziPanel(){},closeHanziPanel(){},setHanziTheme(){},footerHtml,isSample,sampleBadge,sampleCardNote,sampleIntro,sampleReaderNotice,SAMPLE_LABEL,bilingualSource,mountBilingual(){return {destroy(){}};},releaseBilingual(){},location:{pathname,hash},document:{querySelector:s=>s==='#app'?app:s==='#modal'?{close(){}}:null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},window:{addEventListener(){}},fetch:async()=>({ok:true,json:async()=>pathname.startsWith('/admin')?{authenticated:false}:[]}),setTimeout,clearTimeout,clearInterval,FormData,console});
  vm.runInContext(source,context);return {app,context};
 }
 for(const hash of ['','#translate','#requests','#users','#settings','#review']){
  const {app}=browser('/',hash);assert.match(app.innerHTML,/public-shell/);assert.doesNotMatch(app.innerHTML,/admin-token|start-translate|data-accept|data-route="settings"/);
 }
 const {app,context}=browser('/admin','#review');assert.match(app.innerHTML,/Đăng nhập quản trị/);assert.doesNotMatch(app.innerHTML,/sidebar/);
 vm.runInContext("state.status={authenticated:true};render()",context);assert.match(app.innerHTML,/sidebar/);assert.match(app.innerHTML,/admin-logout/);
 await vm.runInContext('logout()',context);assert.match(app.innerHTML,/Đăng nhập quản trị/);assert.doesNotMatch(app.innerHTML,/sidebar/);
 const parsed=vm.runInContext("readerFootnotes('Nội dung có dẫn chứng [1].\\n\\n[1] Hồng Nghiệp, tr. 412.\\n[2] Cùng sách trên, trang 413.\\n[3] Tác phẩm dẫn trên, xem tr. 835.')",context);
 assert.equal(parsed.body,'Nội dung có dẫn chứng [1].');assert.equal(parsed.notes.length,3);assert.equal(parsed.notes[0].content,'Hồng Nghiệp.');assert.equal(parsed.notes[1].content,'Cùng sách trên.');assert.equal(parsed.notes[2].content,'Tác phẩm dẫn trên.');
 const saved=vm.runInContext("readerProse('Vectơ AB⃗ có độ dài |AB⃗|. Các vectơ OA⃗, OB⃗, OC⃗. AB và OA là điểm; [□] chưa đọc được.')",context);
 assert.equal((saved.html.match(/class="math-vector"/gu)||[]).length,5);assert.doesNotMatch(saved.html,/⃗/gu);assert.match(saved.html,/AB và OA là điểm; \[□\]/u);
});

test('Removed fiction import and AI cover APIs are unavailable',async()=>{
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(){throw new Error('Removed route accessed the database');}}};
 for(const path of ['/web-import','/web-import/preview','/stories/document/generate-cover']){
  const response=await worker.fetch(new Request('https://test/api'+path,{method:'POST',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef','Content-Type':'application/json'},body:'{}'}),env,{});
  assert.equal(response.status,404,path);
 }
});

test('Large OCR streams to Files API, uses file reference, then cleans up',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)return new Response(null,{headers:{'x-goog-upload-url':'https://generativelanguage.googleapis.com/upload/test'}});
  if(calls.length===2)return Response.json({file:{name:'files/test',uri:'https://generativelanguage.googleapis.com/v1beta/files/test',state:'ACTIVE'}});
  if(calls.length===3)return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'原文',warnings:[]})}]}}]});
  return new Response(null,{status:200});
 });
 const body=new ReadableStream({start(controller){controller.close();}});
 const result=await recognizeDocument({GEMINI_API_KEY:'test'}, {size:25*1024*1024,body},'application/pdf');
 assert.equal(result.text,'原文');assert.equal(calls[1].options.body,body);
 const part=JSON.parse(calls[2].options.body).contents[0].parts[0];assert.ok(part.fileData);assert.equal(part.inlineData,undefined);assert.equal(calls[3].options.method,'DELETE');
});

test('Covers are saved as images, readable publicly, and editable only by admin',async()=>{
 const objects=new Map();let coverKey=null;
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return {cover_key:coverKey};},async run(){if(sql.startsWith('UPDATE stories SET cover_key'))coverKey=this.args[0];return {};}};}},FILES:{async put(key,data,options){objects.set(key,{data,httpMetadata:options.httpMetadata});},async get(key){const f=objects.get(key);return f?{body:f.data,httpMetadata:f.httpMetadata}:null;}}};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 async function upload(bytes,authenticated=true){const form=new FormData();form.set('cover',new File([bytes],'cover.png',{type:'image/png'}));return worker.fetch(new Request('https://test/api/stories/story/cover',{method:'POST',headers:authenticated?{Authorization:'Bearer test-admin-token-0123456789abcdef'}:{},body:form}),env,{});}
 assert.equal((await upload(png,false)).status,401);assert.equal(objects.size,0);
 assert.equal((await upload(png)).status,200);assert.ok(coverKey);
 const cover=await worker.fetch(new Request('https://test/api/covers/story'),env,{});assert.equal(cover.status,200);assert.equal(cover.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await cover.arrayBuffer()),png);
 assert.equal((await upload('<svg onload="alert(1)"></svg>')).status,400);
 assert.equal((await upload(new Uint8Array(5*1024*1024+1))).status,400);
 assert.equal(objects.size,1);
});

test('Admin can update academic field; invalid values do not change the document',async()=>{
 let genre='Chuyên khảo · Nghiên cứu';
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return {id:'story'};},async run(){if(sql.startsWith('UPDATE stories SET genre'))genre=this.args[0];return {};}};}}};
 async function update(value){return worker.fetch(new Request('https://test/api/stories/story',{method:'PATCH',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef','Content-Type':'application/json'},body:JSON.stringify({genre:value})}),env,{});}
 assert.equal((await update('Lịch sử Trung Hoa')).status,200);assert.equal(genre,'Lịch sử Trung Hoa');
 assert.equal((await update('invalid')).status,400);assert.equal(genre,'Lịch sử Trung Hoa');
});

test('Accepting a reader request creates its story and translation job directly from the uploaded file',async()=>{
 const stored=new Map([['requests/request-1/original',new Blob(['第一章\n故事开始。'])]]),batches=[];
 const requestItem={id:'request-1',title:'Độc giả đề xuất',source_url:'',user_id:'reader-1',visibility:'private',file_key:'requests/request-1/original',filename:'source.txt',mime:'text/plain'};
 const env={DB:{prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){if(sql==='SELECT * FROM requests WHERE id=?')return requestItem;return null;}};},async batch(statements){batches.push(statements);return statements.map(()=>({meta:{changes:1}}));}},FILES:{async get(key){return stored.get(key)||null;},async put(key,value){stored.set(key,new Blob([value]));},async delete(key){stored.delete(key);}}};
 const result=await acceptReaderRequest('request-1',env);assert.ok(result.story_id);assert.ok(result.job_id);assert.equal(result.has_file,true);assert.ok(stored.has(`uploads/${result.job_id}`));
 const sql=batches[0].map(statement=>statement.sql);assert.ok(sql.some(value=>value.startsWith('INSERT INTO stories')));assert.ok(sql.some(value=>value.startsWith('INSERT INTO jobs')));assert.ok(sql.some(value=>value.startsWith('UPDATE requests SET status')));
 const job=batches[0].find(statement=>statement.sql.startsWith('INSERT INTO jobs'));assert.match(job.args[5],/故事开始/);assert.equal(job.args[1],result.story_id);
});

test('Admin can rename a story and invalid names are rejected',async()=>{
 let title='Tên cũ';
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return sql.startsWith('SELECT id FROM stories')?{id:'story'}:null;},async run(){if(sql.startsWith('UPDATE stories SET title'))title=this.args[0];return {};}};}}};
 async function rename(value){return worker.fetch(new Request('https://test/api/stories/story',{method:'PATCH',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef','Content-Type':'application/json'},body:JSON.stringify({title:value})}),env,{});}
 const response=await rename('  Tên tài liệu mới  ');assert.equal(response.status,200);assert.equal(title,'Tên tài liệu mới');
 assert.equal((await rename('   ')).status,400);assert.equal(title,'Tên tài liệu mới');
});


test('PDF OCR checkpoints survive timeouts and resume without repeating saved pages',async t=>{
 const pdf=await pdfLibrary.PDFDocument.create();for(let i=0;i<3;i++)pdf.addPage();
 const bytes=await pdf.save(),objects=new Map();let fail=false,seen=[];
 const job={id:'pdf-job',story_id:'story',file_key:'original',mime:'application/pdf',source:''};
 const env={GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM jobs')?job:{context:'',glossary:'{}',genre:'Khác'};},async run(){return {};}};}},FILES:{async get(key){if(key==='original')return new Blob([bytes]);const value=objects.get(key);return value?(typeof value==='string'?{json:async()=>JSON.parse(value)}:new Blob([value])):null;},async put(key,value){objects.set(key,value);}}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body);if(fail)throw new DOMException('timeout','TimeoutError');if(!body.contents[0].parts[0].inlineData){const data={translation:'Bản dịch tiếng Việt',contextUpdate:'Bối cảnh',glossaryUpdates:{}};return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(data)}]}}]});}const data=body.contents[0].parts[0].inlineData.data;
  const part=await pdfLibrary.PDFDocument.load(Buffer.from(data,'base64'));seen.push(part.getPageCount());
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({text:'原文',warnings:[]})}]}}]});
 });
 await preparePdf(job,env);
 await processJob(job.id,env);const first=JSON.parse(objects.get('processing/pdf-job.json'));assert.equal(first.page,2);assert.equal(first.ocrDone,false);
 await processJob(job.id,env);const ocrComplete=JSON.parse(objects.get('processing/pdf-job.json'));assert.equal(ocrComplete.page,3);assert.equal(ocrComplete.ocrDone,true);assert.deepEqual(seen,[2,1]);assert.equal(ocrComplete.source.match(/原文/g).length,2);
 fail=true;await processJob(job.id,env);assert.equal(objects.get('processing/pdf-job.json'),JSON.stringify(ocrComplete));
 fail=false;await processJob(job.id,env);const translated=JSON.parse(objects.get('processing/pdf-job.json'));assert.equal(translated.translations[0],'Bản dịch tiếng Việt');for(let n=0;n<4&&!objects.has('books/pdf-job.txt');n++)await processJob(job.id,env);assert.equal(objects.get('books/pdf-job.txt'),'Bản dịch tiếng Việt');
});


test('Malformed model JSON is retried instead of failing the PDF job immediately',async t=>{
 let count=0;
 t.mock.method(globalThis,'fetch',async()=>{count++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:count===1?'{} trailing content':'{"translation":"Bản dịch đầy đủ"}'}]}}]});});
 const result=await generate({GEMINI_API_KEY:'test'},[{text:'原文'}],'Translate ONLY the source');
 assert.equal(count,2);assert.equal(result.translation,'Bản dịch đầy đủ');
});


test('PDF is fully split and can resume preparation without recreating previous parts',async()=>{
 const pdf=await pdfLibrary.PDFDocument.create();for(let i=0;i<5;i++)pdf.addPage([100+i,200]);
 const bytes=await pdf.save(),objects=new Map(),writes=[];let originalReads=0;
 const env={FILES:{async get(key){if(key==='original'){originalReads++;return new Blob([bytes]);}const value=objects.get(key);return value?{json:async()=>JSON.parse(value)}:null;},async put(key,value){writes.push(key);objects.set(key,value);}}};
 const job={id:'split-test',file_key:'original'};
 const first=await preparePdf(job,env,1);assert.equal(first.complete,false);assert.equal(first.parts.length,1);
 const done=await preparePdf(job,env,10);assert.equal(done.complete,true);assert.deepEqual(done.parts.map(p=>[p.startPage,p.endPage]),[[1,2],[3,4],[5,5]]);
 for(const part of done.parts){const small=await pdfLibrary.PDFDocument.load(objects.get(part.key));assert.equal(small.getPageCount(),part.endPage-part.startPage+1);assert.equal(small.getPage(0).getWidth(),99+part.startPage);}
 assert.equal(writes.filter(k=>k.endsWith('part-00001.pdf')).length,1);
 await preparePdf(job,env);assert.equal(originalReads,2);
});

test('Book assembly requires every source segment and preserves translation order',()=>{
 const cp={source:'12345',translatedChars:5,ocrDone:true,totalPages:5,page:5,translations:['Đầu','Giữa','Cuối']};
 assert.equal(assembleBook(cp),'Đầu\n\nGiữa\n\nCuối');
 assert.throws(()=>assembleBook({...cp,translatedChars:4}));assert.throws(()=>assembleBook({...cp,page:4}));assert.throws(()=>assembleBook({...cp,translations:['Đầu','']}));
});

test('A partial book cannot be downloaded as a completed volume',async()=>{
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(){return {bind(){return this;},async first(){return {id:'job',status:'translating',translation:'Chưa đủ'};}};}}};
 const response=await worker.fetch(new Request('https://test/api/jobs/job/book',{headers:{Authorization:'Bearer test-admin-token-0123456789abcdef'}}),env,{});assert.equal(response.status,409);
 const denied=await worker.fetch(new Request('https://test/api/jobs/job/book'),env,{});assert.equal(denied.status,401);
});

test('Readers cannot upload or delete library content',async()=>{
 for(const [path,method] of [['/api/import-preview','POST'],['/api/stories/story/chapters','POST'],['/api/stories/story/chapters','GET'],['/api/stories/story','DELETE'],['/api/jobs/job','DELETE'],['/api/chapters/chapter','DELETE'],['/api/requests/request','DELETE']]){
  const response=await worker.fetch(new Request('https://test'+path,{method}),{ADMIN_TOKEN:'test-admin-token-0123456789abcdef'},{});assert.equal(response.status,401,path);
 }
});

test('Direct publishing requires confirmation and preserves plain text without interpreting HTML',async()=>{
 const stored=[];const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(sql){return {bind(...values){this.values=values;return this;},async first(){return {id:'story'};},async run(){stored.push(this.values);return {};}};}}};
 async function upload(confirmed){const form=new FormData();form.set('title','Chương thử');form.set('file',new File(['Xin chào <script>alert(1)</script>'],'story.txt'));if(confirmed)form.set('confirmed','true');return worker.fetch(new Request('https://test/api/stories/story/chapters',{method:'POST',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef'},body:form}),env,{});}
 assert.equal((await upload(false)).status,400);assert.equal(stored.length,0);
 assert.equal((await upload(true)).status,201);assert.equal(stored[0][3],'Xin chào <script>alert(1)</script>');
});

test('Deletion refuses a currently leased job without deleting its files',async()=>{
 let removed=false;const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',DB:{prepare(){return {bind(){return this;},async first(){return {id:'job',file_key:'original',lease_until:Date.now()+60000};},async all(){return {results:[]};}};},async batch(){return [{meta:{changes:0}},{meta:{changes:0}}];}},FILES:{async delete(){removed=true;}}};
 const response=await worker.fetch(new Request('https://test/api/jobs/job',{method:'DELETE',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef'}}),env,{});assert.equal(response.status,409);assert.equal(removed,false);
});


test('Long TXT passes upload, translates all chunks, and retains full content outside D1',async t=>{
 const source='今天是新的一天。'.repeat(10000),objects=new Map();let job;
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return sql.includes('FROM jobs')?job:{id:'story',context:'',genre:'Khác',glossary:'{}'};},async run(){
  if(sql.startsWith('INSERT INTO jobs')){const [id,story_id,filename,file_key,mime,source,source_key]=this.args;job={id,story_id,filename,file_key,mime,source,source_key};}
  if(sql.startsWith('UPDATE jobs SET source=')){assert.ok(this.args[0].length<=20000);assert.ok(this.args[1].length<=20000);Object.assign(job,{source:this.args[0],translation:this.args[1],source_key:this.args[2],translation_key:this.args[3],status:this.args[5],prompt_tokens:this.args[7],output_tokens:this.args[8],total_tokens:this.args[9],ai_requests:this.args[10],ai_cache_hits:this.args[11],model:this.args[12],prompt_version:this.args[13]});}
  if(sql.includes("status='failed'"))throw new Error(this.args[0]);return {};
 }};}},FILES:{async put(key,value){objects.set(key,value);},async get(key){const value=objects.get(key);return value===undefined?null:{text:async()=>value,json:async()=>JSON.parse(value)};}}};
 const form=new FormData();form.set('story_id','story');form.set('file',new File([source],'long.txt'));
 const response=await worker.fetch(new Request('https://test/api/jobs',{method:'POST',headers:{Authorization:'Bearer test-admin-token-0123456789abcdef'},body:form}),env,{});assert.equal(response.status,201);assert.equal(objects.get(job.source_key),source);
 let translatedSource='';t.mock.method(globalThis,'fetch',async(url,options)=>{const request=JSON.parse(options.body);translatedSource+=JSON.parse(request.contents[0].parts[0].text).source;return Response.json({usageMetadata:{promptTokenCount:120,candidatesTokenCount:80,totalTokenCount:200},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch '.repeat(800),contextUpdate:'Context',glossaryUpdates:{}})}]}}]});});
 for(let n=0;n<100&&job.status!=='review';n++)await processJob(job.id,env);
 assert.equal(job.status,'review');assert.equal(translatedSource,source);assert.ok(objects.get(job.translation_key).length>20000);assert.equal(objects.get(`books/${job.id}.txt`),objects.get(job.translation_key));
 assert.equal(job.prompt_version,PROMPT_VERSION);assert.equal(job.model,'gemini-2.5-flash');assert.ok(job.ai_requests>0);assert.equal(job.total_tokens,job.ai_requests*200);
});

test('Admin book pipeline repairs a dropped citation marker before marking review, same as the study workspace',async t=>{
 const source='原文[12]。',objects=new Map();let job;
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',GEMINI_API_KEY:'test',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return sql.includes('FROM jobs')?job:{id:'story',context:'',genre:'Khác',glossary:'{}'};},async run(){
  if(sql.startsWith('INSERT INTO jobs')){const [id,story_id,filename,file_key,mime,source,source_key]=this.args;job={id,story_id,filename,file_key,mime,source,source_key,warnings:'[]'};}
  if(sql.startsWith('UPDATE jobs SET source=')){Object.assign(job,{source:this.args[0],translation:this.args[1],source_key:this.args[2],translation_key:this.args[3],warnings:this.args[4],status:this.args[5]});}
  if(sql.includes("status='failed'"))throw new Error(this.args[0]);return {};
 }};}},FILES:{async put(key,value){objects.set(key,value);},async get(key){const value=objects.get(key);return value===undefined?null:{text:async()=>value,json:async()=>JSON.parse(value)};}}};
 const form=new FormData();form.set('story_id','story');form.set('file',new File([source],'short.txt'));
 const response=await worker.fetch(new Request('https://test/api/jobs',{method:'POST',headers:{Authorization:`Bearer test-admin-token-0123456789abcdef`},body:form}),env,{});assert.equal(response.status,201);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;const translation=calls===1?'Bản dịch thiếu dẫn chứng.':'Bản dịch có dẫn chứng [12].';return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation,contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 for(let n=0;n<10&&job.status!=='review';n++)await processJob(job.id,env);
 assert.equal(calls,2);assert.equal(job.status,'review');assert.match(job.translation,/\[12\]/);assert.deepEqual(JSON.parse(job.warnings),[]);
});

test('A configured GEMINI_QUALITY_MODEL is used only for the repair retry, never for routine translation',async t=>{
 const source='原文[12]。',objects=new Map();let job;
 const env={ADMIN_TOKEN:'test-admin-token-0123456789abcdef',GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-2.5-flash',GEMINI_QUALITY_MODEL:'gemini-3.0-pro',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){return sql.includes('FROM jobs')?job:{id:'story',context:'',genre:'Khác',glossary:'{}'};},async run(){
  if(sql.startsWith('INSERT INTO jobs')){const [id,story_id,filename,file_key,mime,source,source_key]=this.args;job={id,story_id,filename,file_key,mime,source,source_key,warnings:'[]'};}
  if(sql.startsWith('UPDATE jobs SET source=')){Object.assign(job,{source:this.args[0],translation:this.args[1],source_key:this.args[2],translation_key:this.args[3],warnings:this.args[4],status:this.args[5]});}
  if(sql.includes("status='failed'"))throw new Error(this.args[0]);return {};
 }};}},FILES:{async put(key,value){objects.set(key,value);},async get(key){const value=objects.get(key);return value===undefined?null:{text:async()=>value,json:async()=>JSON.parse(value)};}}};
 const form=new FormData();form.set('story_id','story');form.set('file',new File([source],'short.txt'));
 const response=await worker.fetch(new Request('https://test/api/jobs',{method:'POST',headers:{Authorization:`Bearer test-admin-token-0123456789abcdef`},body:form}),env,{});assert.equal(response.status,201);
 const models=[];t.mock.method(globalThis,'fetch',async(endpoint)=>{models.push(endpoint);const translation=models.length===1?'Bản dịch thiếu dẫn chứng.':'Bản dịch có dẫn chứng [12].';return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation,contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 for(let n=0;n<10&&job.status!=='review';n++)await processJob(job.id,env);
 assert.equal(models.length,2);assert.match(models[0],/gemini-2\.5-flash/);assert.match(models[1],/gemini-3\.0-pro/);assert.equal(job.status,'review');assert.match(job.translation,/\[12\]/);
});


test('Daily quota exhaustion is explained without repeatedly calling Gemini',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]}]}},{status:429});});
 await assert.rejects(()=>generate({GEMINI_API_KEY:'test'},[{text:'你好'}],'Translate ONLY the source'),/hết hạn mức yêu cầu trong ngày/);assert.equal(calls,1);
});
