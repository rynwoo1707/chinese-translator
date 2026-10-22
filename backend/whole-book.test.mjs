import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import * as book from '../frontend/whole-book.js';
import {parseStudyPageRange} from '../frontend/study-pages.js';
const {PDFDocument}=createRequire(import.meta.url)('@cantoo/pdf-lib');

// "Dịch cả quyển" without a browser: page states, chunking, the token estimate, error handling and one whole run against
// a fake server that keeps the job as backend/book-jobs.js does (a done page never goes back). No network, no Gemini.

test('page states: cover, chosen pages, counts, updates and the next chunk',()=>{
 const states=book.initialPageStates(30,{cover:1,pages:new Set(Array.from({length:25},(_,i)=>i+3))});
 assert.equal(states,'cs'+'.'.repeat(25)+'sss');assert.equal(book.stateAt(states,1),'cover');assert.equal(book.stateAt(states,2),'skipped');
 assert.deepEqual(book.countStates(states),{total:30,pending:25,done:0,blank:0,cover:1,skipped:4,failed:0,wanted:25});
 assert.throws(()=>book.initialPageStates(0),/Số trang/u);
 const later=book.withStates(states,{3:'done',4:'blank',5:'failed',99:'done',6:'nonsense'});
 assert.equal(later.slice(0,7),'csdbf..');assert.equal(book.progressText(later),'Đã dịch 1/24 trang');assert.equal(book.progressNote(later),'bìa giữ nguyên · 1 trang trống · bỏ qua 4 trang · 1 trang lỗi');
 // A chunk is one run of pending pages from the first one, never across a finished page, at most `limit` long.
 assert.deepEqual(book.nextChunk(later,20),{start:6,end:25,pages:Array.from({length:20},(_,i)=>i+6)});
 assert.deepEqual(book.nextChunk('c..d....',20),{start:2,end:3,pages:[2,3]});
 assert.deepEqual(book.nextChunk('c'+'.'.repeat(40),20).end,21);assert.equal(book.nextChunk('cdbsf',20),null);
 assert.deepEqual(book.nextChunk('.....',2).pages,[1,2]);
 assert.deepEqual(book.statesFor([4,5],'blank'),{4:'blank',5:'blank'});
 assert.deepEqual(book.rangeUpdates('c..s.d',new Set([2,4,6])),{3:'skipped',4:'pending',5:'skipped'});
 assert.deepEqual(book.rangeUpdates('c.s',null),{3:'pending'});
 assert.equal(book.pageList([7,1,2,3,9,10,3]),'1–3, 7, 9–10');
 assert.deepEqual(book.chunkPages({pages:[{number:21,blocks:[{}]},{number:22,blocks:[]},{number:23,blocks:[{},{}]}]}),{done:[21,23],blank:[22],processed:3});
});

test('token estimate from measured page costs, and the projection from what the book has used',()=>{
 const states=book.initialPageStates(10,{cover:1}),estimate=book.estimateTokens(states,['scan','text','text','scan']);
 assert.deepEqual({text:estimate.text,scan:estimate.scan,unknown:estimate.unknown},{text:2,scan:1,unknown:6});
 // Unsurveyed pages range from a light text page to a heavy scan; the cover costs nothing.
 assert.equal(estimate.low,2*900+3000+6*900);assert.equal(estimate.high,2*2100+7*8000);
 assert.deepEqual(book.PAGE_TOKENS,{text:[900,2100],scan:[3000,8000]});
 assert.equal(book.usageProjection({pageStates:'cdd..',usage:{total:2000}}).remaining,2000);
 assert.equal(book.usageProjection({pageStates:'c....',usage:{total:0}}),null);
 assert.equal(book.formatTokenRange(75_000,200_000),'75–200 nghìn');assert.equal(book.formatTokenRange(540_000,1_300_000),'0,5–1,3 triệu');assert.equal(book.formatTokenRange(15_000,40_000),'15.000–40.000');
 assert.equal(book.formatTokens(1_250_000),'1,3 triệu');assert.equal(book.formatTokens(540_400),'540 nghìn');assert.equal(book.formatTokens(54_321),'54.321');assert.equal(book.formatTokens(-3),'0');
});

test('errors map to the contract: quota waits or pauses, keys, limits, connection loss, chunk problems',()=>{
 const error=(status,data={},message='x')=>Object.assign(new Error(message),{status,data});
 assert.deepEqual(book.classifyError(error(429,{code:'quota_minute',retryAfter:42})),{reason:'quota_minute',wait:42,retries:20});
 assert.equal(book.classifyError(error(429,{code:'quota_minute',retryAfter:null})).wait,60);
 assert.equal(book.classifyError(error(429,{code:'quota',retryAfter:30})).reason,'quota_minute');
 assert.equal(book.classifyError(error(429,{code:'quota',retryAfter:3600})).reason,'quota');
 assert.equal(book.classifyError(error(429,{code:'quota_day'})).reason,'quota_day');
 assert.equal(book.classifyError(error(403,{code:'gemini_key'})).reason,'gemini_key');
 assert.deepEqual(book.classifyError(error(429,{code:'rate_limited',retryAfter:12})),{reason:'rate_limited',wait:12,retries:20});
 // A daily cap answers with the hours left until midnight: that pauses instead of waiting.
 assert.equal(book.classifyError(error(429,{code:'rate_limited',retryAfter:40000})).reason,'limit');
 for(const status of [0,502,503,504])assert.equal(book.classifyError(error(status)).reason,'network');
 assert.equal(book.classifyError(error(500)).reason,'server');
 // Messages of servers older than the contract.
 assert.equal(book.classifyError(error(400,{},'Gemini đã hết hạn mức yêu cầu trong ngày của dự án. Hãy bật Billing…')).reason,'quota_day');
 assert.equal(book.classifyError(error(400,{},'Gemini trả lỗi 429. Kiểm tra hạn mức và thử lại sau.')).reason,'quota_minute');
 assert.equal(book.classifyError(error(400,{},'Gemini từ chối yêu cầu (403). Khóa API có thể không hợp lệ…')).reason,'gemini_key');
 assert.equal(book.classifyError(error(400,{},'Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút.')).reason,'network');
 assert.equal(book.classifyError(error(422,{code:'no_text',pages:[3]})).reason,'no_blocks');
 assert.equal(book.classifyError(error(413,{code:'too_large'})).reason,'too_large');
 assert.equal(book.classifyError(error(400,{},'Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt.')).reason,'too_large');
 assert.equal(book.classifyError(error(400,{},'Trang 37 có block quá dài; cần tách trước khi dịch.'),'extract').reason,'page');
 assert.equal(book.classifyError(error(400,{},'Trang 37: lỗi lạ'),'extract').reason,'page');
 // A server without Tesseract fails every scanned page alike: that pauses for the administrator, page by page is pointless.
 assert.equal(book.classifyError(error(400,{},'Trang 3 là scan nhưng không chạy được OCR Tesseract (x). Hãy chạy npm run prepare:pdf-ocr'),'extract').reason,'error');
 assert.deepEqual(book.classifyError(error(400,{},'Thiếu bản dịch block p3-b1.'),'translate'),{reason:'error',wait:3,retries:1});
 assert.deepEqual(book.classifyError(new TypeError('boom')),{reason:'error'});
});

test('the daily quota resets at midnight Pacific time: 15:00 or 14:00 in Vietnam',()=>{
 const reset=iso=>book.nextQuotaReset(Date.parse(iso)).toISOString();
 assert.equal(reset('2026-12-01T07:59:00Z'),'2026-12-01T08:00:00.000Z');assert.equal(reset('2026-12-01T08:01:00Z'),'2026-12-02T08:00:00.000Z');
 assert.equal(reset('2026-10-19T03:00:00Z'),'2026-10-19T07:00:00.000Z');
 // Across both daylight-saving switches of 2026 (8 March, 1 November).
 assert.equal(reset('2026-03-08T07:30:00Z'),'2026-03-08T08:00:00.000Z');assert.equal(reset('2026-03-08T09:00:00Z'),'2026-03-09T07:00:00.000Z');
 assert.equal(reset('2026-11-01T06:30:00Z'),'2026-11-01T07:00:00.000Z');assert.equal(reset('2026-11-01T08:30:00Z'),'2026-11-02T08:00:00.000Z');
 assert.equal(book.quotaResetLabel(Date.parse('2026-12-01T03:00:00Z')),'15:00 hôm nay');assert.equal(book.quotaResetLabel(Date.parse('2026-10-19T09:00:00Z')),'14:00 ngày mai');
 assert.match(book.pauseMessage('quota_day',null,Date.parse('2026-12-01T03:00:00Z')),/dán khóa khác.*15:00 hôm nay \(giờ Việt Nam\)/isu);
 assert.match(book.pauseMessage('limit',new Error('Bạn đã dùng hết 100 lượt tách PDF hôm nay.')),/^Bạn đã dùng hết 100 lượt tách PDF hôm nay\. Tiến độ đã lưu\.$/u);
 assert.match(book.waitMessage('quota_minute',37),/37 giây/u);
});

test('SHA-256 without crypto.subtle matches node:crypto',async()=>{
 for(const length of [0,1,55,56,63,64,65,119,120,128,1000,70001]){const bytes=randomBytes(length);assert.equal(book.sha256Hex(bytes),createHash('sha256').update(bytes).digest('hex'),`length ${length}`);}
 const bytes=randomBytes(5000);assert.equal(await book.digestHex(bytes),createHash('sha256').update(bytes).digest('hex'));
 const subtle=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{value:{},configurable:true});
 try{assert.equal(await book.digestHex(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)),createHash('sha256').update(bytes).digest('hex'));}finally{Object.defineProperty(globalThis,'crypto',subtle);}
});

test('history: a job owns the sessions of its original made after it started, and resumes the unfinished one',()=>{
 const job={sourceSha256:'a'.repeat(64),storyId:'book-1',createdAt:'2026-10-18T10:00:00.000Z'};
 const items=[
  {id:'new-draft',source_sha256:'a'.repeat(64),library_story_id:null,created_at:'2026-10-18 10:30:00',page_start:22,page_end:41,status:'translating'},
  {id:'done-1',source_sha256:'a'.repeat(64),library_story_id:'book-1',created_at:'2026-10-18 10:05:00',page_start:2,page_end:21,status:'complete'},
  {id:'older-range',source_sha256:'a'.repeat(64),library_story_id:'book-1',created_at:'2026-10-17 09:00:00',page_start:2,page_end:4,status:'complete'},
  {id:'other-book',source_sha256:'a'.repeat(64),library_story_id:'book-2',created_at:'2026-10-18 11:00:00',page_start:2,page_end:4,status:'complete'},
  {id:'other-file',source_sha256:'b'.repeat(64),library_story_id:'book-1',created_at:'2026-10-18 11:00:00',page_start:2,page_end:4,status:'complete'},
  {id:'local',source_sha256:'a'.repeat(64),library_story_id:'book-1',created_at:new Date(Date.parse(job.createdAt)+5e5).toISOString(),page_start:42,page_end:45,status:'draft'}
 ];
 assert.deepEqual(book.jobSessions(items,job).map(item=>item.id),['new-draft','done-1','local']);
 assert.equal(book.findChunkSession(items,job,30).id,'new-draft');assert.equal(book.findChunkSession(items,job,2).id,'done-1');assert.equal(book.findChunkSession(items,job,46),null);
 // Before its first chunk completes, the job has no book; a chunk saved into a book the job missed still counts.
 assert.deepEqual(book.jobSessions(items,{...job,storyId:null}).map(item=>item.id),['new-draft','done-1','other-book','local']);
 // A second run of the same original (the first one's progress was deleted) owns only what was saved after it started.
 const later={...job,id:'job-2',createdAt:'2026-10-18T11:30:00.000Z'},groups=book.sessionsByJob([...items,{id:'after-2',source_sha256:'a'.repeat(64),library_story_id:'book-1',created_at:'2026-10-18 11:40:00',page_start:2,page_end:21,status:'draft'}],[{...job,id:'job-1'},later]);
 assert.deepEqual(groups.get('job-1').map(item=>item.id),['new-draft','done-1','local']);assert.deepEqual(groups.get('job-2').map(item=>item.id),['after-2']);
 assert.deepEqual(book.glossaryUpdates({史料:'sử liệu',明朝:'nhà Minh'},{史料:'sử liệu',明朝:'triều Minh',向量:'vectơ',__proto__x:'',长:'x'.repeat(101)}),{明朝:'triều Minh',向量:'vectơ'});
});

test('chunks are cut with pdf-lib from the original, page for page, and sent with their offset',async()=>{
 const source=await PDFDocument.create();for(let page=1;page<=45;page++)source.addPage([300+page,400]);
 const bytes=await source.save(),loaded=await book.openSourcePdf(PDFDocument,bytes),chunk=await book.cutChunk(PDFDocument,loaded,Array.from({length:20},(_,i)=>i+22));
 const cut=await PDFDocument.load(chunk);assert.equal(cut.getPageCount(),20);assert.deepEqual(cut.getPages().map(page=>page.getWidth()),Array.from({length:20},(_,i)=>322+i));
 const form=book.extractForm(chunk,Array.from({length:20},(_,i)=>i+22),{sourceSha256:'c'.repeat(64)});
 assert.equal(form.get('pages'),'1-20');assert.equal(form.get('pageOffset'),'21');assert.equal(form.get('sourceSha256'),'c'.repeat(64));assert.equal(form.get('file').name,'trang-22-41.pdf');assert.equal(form.get('file').size,chunk.byteLength);
 await assert.rejects(book.openSourcePdf(PDFDocument,new Uint8Array([1,2,3])),/Không mở được PDF để chia lượt dịch/u);
});

// A fake account: the job as backend/book-jobs.js keeps it (a done page never goes back, each token report counts once,
// one runner holds the job while it reports), an extractor that numbers pages from the chunk's offset, and the four
// chunk steps of study.js reduced to their effect on the job. lose(body): the PATCH is applied but its answer is lost.
const offline=()=>Object.assign(new Error('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.'),{status:0});
// refuse({offset,count}): an error the PDF service answers instead of extracting that chunk, or nothing.
function fakeAccount({total=45,cover=1,blank=[],processedLimit=Infinity,badPages=[],translateErrors=[],pageBytes=1000,lose=()=>false,down=()=>false,refuse=()=>null}={}){
 const job={id:'0b7e2a43-0000-4000-8000-000000000001',sourceSha256:'d'.repeat(64),filename:'sach.pdf',title:'Sách thử',storyId:null,totalPages:total,pageStates:book.initialPageStates(total,{cover}),chunkSize:20,status:'ready',pauseReason:null,usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{史料:'sử liệu'},createdAt:'2026-10-18T10:00:00.000Z',runner:null,leaseSeconds:0};
 const calls=[],patches=[],extracts=[],state={job,translateErrors:[...translateErrors],counted:new Set(),lease:{runner:null,until:0}};
 const view=()=>{const held=state.lease.runner&&state.lease.until>Date.now();return {...state.job,runner:held?state.lease.runner:null,leaseSeconds:held?Math.ceil((state.lease.until-Date.now())/1000):0};};
 const api=async(path,options={})=>{
  calls.push(path);
  if(path===`book-jobs/${job.id}`&&options.method==='PATCH'){
   const body=JSON.parse(options.body);if(down(body))throw offline();patches.push(body);
   const held=state.lease.runner&&state.lease.until>Date.now(),mine=held&&body.runner===state.lease.runner;
   if(held&&!mine&&['pages','status','pauseReason','model','storyId','glossary'].some(key=>body[key]!==undefined))throw Object.assign(new Error('Quyển này đang được dịch ở một thiết bị khác.'),{status:409,data:{code:'job_busy',retryAfter:view().leaseSeconds,job:view()}});
   if(body.pages){const chars=[...state.job.pageStates];for(const [page,name] of Object.entries(body.pages)){const char=book.PAGE_STATES[name];if(chars[page-1]==='d'&&(char==='.'||char==='f'))continue;chars[page-1]=char;}state.job={...state.job,pageStates:chars.join('')};}
   const usage={...state.job.usage};for(const report of body.reports||[])if(!state.counted.has(report.id)){state.counted.add(report.id);for(const key of Object.keys(usage))usage[key]+=report.usage?.[key]||0;}
   state.job={...state.job,usage,...(body.status?{status:body.status}:{}),...(body.pauseReason!==undefined?{pauseReason:body.pauseReason}:{}),...(body.storyId!==undefined?{storyId:body.storyId}:{}),...(body.model?{model:body.model}:{}),glossary:{...state.job.glossary,...body.glossary}};
   if(body.runner&&(!held||mine))state.lease=state.job.status==='running'?{runner:body.runner,until:Date.now()+600000}:{runner:null,until:0};
   if(lose(body))throw offline();
   return {job:view()};
  }
  if(path==='pdf-layout/extract'){
   const form=options.body,offset=Number(form.get('pageOffset')),count=Number(form.get('pages').split('-')[1]);extracts.push({offset,count,size:form.get('file').size,sha:form.get('sourceSha256')});
   // The service names the page it cannot render, in pages of the original (the Worker shifts chunk page numbers).
   const refused=refuse({offset,count});if(refused)throw refused;
   const first=offset+1,bad=badPages.find(page=>page>offset&&page<=offset+count);if(bad)throw Object.assign(new Error(`Trang ${bad} quá lớn để render an toàn (2000×3000 pt).`),{status:400,data:{}});
   const pages=Array.from({length:Math.min(count,processedLimit)},(_,i)=>offset+i+1).map(number=>({number,blocks:blank.includes(number)?[]:[{id:`p${number}-b1`}]}));
   if(!pages.some(page=>page.blocks.length))throw Object.assign(new Error('Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.'),{status:422,data:{code:'no_text',pages:pages.map(page=>page.number)}});
   return {assetId:`asset-${first}`,document:{pages}};
  }
  throw new Error(`unexpected ${path}`);
 };
 let run=null;const sessions=[];
 const steps={
  async open(){return null;},
  async start(result){sessions.push({pages:result.document.pages.map(page=>page.number)});},
  async translate(){const failure=state.translateErrors.shift();if(failure)throw failure;run.recordUsage({prompt:600,output:267,thinking:0,total:867,requests:1});return {complete:true,model:'gemini-2.5-flash-lite'};},
  async finish(){return {storyId:'book-1',glossary:{史料:'sử liệu',向量:'vectơ'}};}
 };
 const sleeps=[],waits=[],source={cut:async pages=>new Uint8Array(pages.length*pageBytes)},reports=book.reportStore();
 const create=(options={})=>run=book.createBookRun({api,steps,source,reports,sleep:async(seconds,{stopped,early})=>{sleeps.push(seconds);waits.push({seconds,early});return stopped();},...options});
 return {state,calls,patches,extracts,sessions,sleeps,waits,steps,reports,create};
}

test('a whole run: chunks of 20 from the first pending page, blank pages free, one PATCH per chunk',async()=>{
 const account=fakeAccount({total:45,cover:1,blank:[10,44]}),run=account.create(),outcome=await run.run(account.state.job);
 assert.equal(outcome.status,'done');
 assert.deepEqual(account.extracts.map(({offset,count})=>[offset,count]),[[1,20],[21,20],[41,4]]);
 assert.ok(account.extracts.every(entry=>entry.sha==='d'.repeat(64)&&entry.size===entry.count*1000));
 assert.equal(account.state.job.pageStates,'c'+'d'.repeat(8)+'b'+'d'.repeat(33)+'bd');
 assert.equal(account.state.job.status,'done');assert.equal(account.state.job.storyId,'book-1');
 // Tokens of each chunk ride on its PATCH; the book glossary only receives what a chunk learned.
 assert.deepEqual(account.state.job.usage,{prompt:1800,output:801,thinking:0,total:2601,requests:3});
 const chunkPatches=account.patches.filter(body=>body.pages);assert.equal(chunkPatches.length,3);
 assert.deepEqual(chunkPatches[0].glossary,{向量:'vectơ'});assert.equal(chunkPatches[1].glossary,undefined);assert.equal(chunkPatches[0].storyId,'book-1');assert.equal(chunkPatches[1].storyId,undefined);
 assert.equal(chunkPatches[0].model,'gemini-2.5-flash-lite');assert.deepEqual(chunkPatches[0].pages[10],'blank');
 // The run holds the job under its own id from the first report to the last; every chunk's tokens are one report.
 const {runner}=account.patches[0];assert.match(runner,/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u);
 assert.deepEqual(account.patches[0],{status:'running',pauseReason:null,runner});assert.deepEqual(account.patches.at(-1),{status:'done',pauseReason:null,runner});
 assert.ok(account.patches.every(body=>body.runner===runner));assert.deepEqual(chunkPatches.map(body=>body.reports.length),[1,1,1]);
 assert.equal(new Set(chunkPatches.map(body=>body.reports[0].id)).size,3);assert.deepEqual(account.reports.load(account.state.job.id),[]);
});

test('pages the extractor did not reach go to the next chunk, which is cut to what fitted',async()=>{
 const account=fakeAccount({total:45,cover:0,processedLimit:12}),outcome=await account.create().run(account.state.job);
 assert.equal(outcome.status,'done');
 assert.deepEqual(account.extracts.map(({offset,count})=>[offset,count]),[[0,20],[12,12],[24,12],[36,9]]);
 assert.equal(account.state.job.pageStates,'d'.repeat(45));
});

test('a chunk with no Chinese is marked blank without Gemini, using the page numbers the server sends',async()=>{
 const account=fakeAccount({total:30,cover:1,blank:Array.from({length:20},(_,i)=>i+2)}),outcome=await account.create().run(account.state.job);
 assert.equal(outcome.status,'done');assert.equal(account.state.job.pageStates,'c'+'b'.repeat(20)+'d'.repeat(9));
 assert.equal(account.sessions.length,1);assert.equal(account.state.job.usage.requests,1);
 // A blank run the service could read only part of: those pages are blank, the next chunk is cut to what fitted.
 const partial=fakeAccount({total:30,cover:1,blank:Array.from({length:12},(_,i)=>i+2),processedLimit:12});
 assert.equal((await partial.create().run(partial.state.job)).status,'done');
 assert.deepEqual(partial.extracts.map(({offset,count})=>[offset,count]),[[1,20],[13,12],[25,5]]);assert.equal(partial.state.job.pageStates,'c'+'b'.repeat(12)+'d'.repeat(17));
});

test('heavy chunks are cut smaller on the device; a page too heavy alone, or refused alone, is marked failed',async()=>{
 const heavy=fakeAccount({total:25,cover:0,pageBytes:3*1024*1024}),outcome=await heavy.create({maxBytes:16*1024*1024}).run(heavy.state.job);
 assert.equal(outcome.status,'done');assert.ok(heavy.extracts.every(entry=>entry.count<=5),JSON.stringify(heavy.extracts));assert.equal(heavy.state.job.pageStates,'d'.repeat(25));
 const huge=fakeAccount({total:3,cover:0,pageBytes:20*1024*1024}),warnings=[],result=await huge.create({ui:{warn:message=>warnings.push(message)}}).run(huge.state.job);
 assert.equal(result.status,'done');assert.equal(huge.state.job.pageStates,'fff');assert.equal(huge.extracts.length,0);assert.match(warnings[0],/^Trang 1 nặng 20,0 MB/u);
 // A page the service refuses is found by halving the chunk; only that page is marked failed, the rest are translated.
 const refused=fakeAccount({total:8,cover:0,badPages:[5]}),notes=[],done=await refused.create({ui:{warn:message=>notes.push(message)}}).run(refused.state.job);
 assert.equal(done.status,'done');assert.deepEqual(refused.extracts.map(({offset,count})=>[offset,count]),[[0,8],[0,4],[4,4],[4,2],[4,1],[5,3]]);
 assert.equal(refused.state.job.pageStates,'ddddfddd');assert.match(notes[0],/^Trang 5 quá lớn/u);
});

test('quota per minute waits and continues by itself; a day quota, a refused key or a lost connection pause the run',async()=>{
 const minute=fakeAccount({total:5,cover:0,translateErrors:[Object.assign(new Error('Gemini giới hạn theo phút.'),{status:429,data:{code:'quota_minute',retryAfter:42}})]});
 const waited=await minute.create().run(minute.state.job);assert.equal(waited.status,'done');assert.deepEqual(minute.sleeps,[42]);
 const day=fakeAccount({total:45,cover:0,translateErrors:[undefined,Object.assign(new Error('Hết hạn mức ngày.'),{status:429,data:{code:'quota_day',retryAfter:null}})]});
 const paused=await day.create().run(day.state.job);
 assert.equal(paused.status,'paused');assert.equal(paused.reason,'quota_day');assert.match(paused.message,/giờ Việt Nam/u);
 assert.equal(day.state.job.status,'paused');assert.equal(day.state.job.pauseReason,'quota_day');assert.equal(day.state.job.pageStates,'d'.repeat(20)+'.'.repeat(25));
 const key=fakeAccount({total:5,cover:0,translateErrors:[Object.assign(new Error('Khóa bị từ chối.'),{status:403,data:{code:'gemini_key'}})]}),refused=await key.create().run(key.state.job);
 assert.equal(refused.reason,'gemini_key');assert.match(refused.message,/khóa Gemini hợp lệ/u);
 const lost=Array.from({length:7},()=>Object.assign(new Error('Không kết nối được máy chủ.'),{status:0})),network=fakeAccount({total:5,cover:0,translateErrors:lost}),gone=await network.create().run(network.state.job);
 assert.equal(gone.reason,'network');assert.deepEqual(network.sleeps,book.BACKOFF_SECONDS);
 const back=fakeAccount({total:5,cover:0,translateErrors:[Object.assign(new Error('503'),{status:503,data:{}})]});assert.equal((await back.create().run(back.state.job)).status,'done');
});

test('a stop pauses between chunks; a saved session is continued instead of extracted again',async()=>{
 let stop=false;const account=fakeAccount({total:45,cover:0});
 account.steps.finish=async()=>{stop=true;return {storyId:'book-1',glossary:{}};};
 const stopped=await account.create({shouldStop:()=>stop}).run(account.state.job);
 assert.equal(stopped.status,'paused');assert.equal(stopped.reason,'stopped');assert.equal(account.extracts.length,1);assert.equal(account.state.job.pageStates,'d'.repeat(20)+'.'.repeat(25));
 // Resuming: the chunk from page 21 was saved by another tab; it is opened, not paid for again.
 stop=false;account.steps.finish=async()=>({storyId:'book-1',glossary:{}});
 account.steps.open=async(job,chunk)=>chunk.start===21?{document:{pages:Array.from({length:20},(_,i)=>({number:21+i,blocks:[{}]}))}}:null;
 const resumed=await account.create().run(account.state.job);
 assert.equal(resumed.status,'done');assert.deepEqual(account.extracts.map(entry=>entry.offset),[0,40]);assert.equal(account.state.job.pageStates,'d'.repeat(45));
 // A translate step that stopped at a page boundary leaves the job paused, with its tokens recorded.
 const partial=fakeAccount({total:5,cover:0});let runner;partial.steps.translate=async()=>{runner.recordUsage({total:100,requests:1});return {complete:false};};
 runner=partial.create();const half=await runner.run(partial.state.job);
 assert.equal(half.reason,'stopped');assert.equal(partial.state.job.usage.total,100);assert.equal(partial.state.job.pageStates,'.....');
});

test('the wake lock follows the tab and two tabs never run one book',async()=>{
 const listeners={},doc={visibilityState:'visible',addEventListener:(type,handler)=>{listeners[type]=handler;}},requests=[];
 const nav={wakeLock:{request:async type=>{requests.push(type);const sentinel={released:false,listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},async release(){this.released=true;this.listeners.release?.();}};return sentinel;}}};
 const lock=book.createWakeLock(nav,doc);assert.equal(lock.supported,true);await lock.on();assert.equal(lock.active,true);
 // Hidden tabs lose the lock; coming back takes it again.
 doc.visibilityState='hidden';await lock.off();await lock.on();assert.equal(requests.length,1);doc.visibilityState='visible';await listeners.visibilitychange();assert.equal(requests.length,2);
 await lock.off();assert.equal(lock.active,false);
 assert.equal(book.createWakeLock({},doc).supported,false);
 const held=new Set(),locks={request:async(name,options,task)=>{if(held.has(name))return task(null);held.add(name);try{return await task({name});}finally{held.delete(name);}}};
 let inner=null;await book.withJobLock('j1',async()=>{inner=book.withJobLock('j1',async()=>'second',locks);await assert.rejects(inner,/đang được dịch ở một tab khác/u);},locks);
 assert.equal(await book.withJobLock('j2',async()=>'free',undefined),'free');
 // Another tab's lock is seen before the original is downloaded; no Web Locks, or a failing query, means no lock.
 const query={query:async()=>({held:[{name:'hoa-tri-book-j1'}],pending:[]})};
 assert.equal(await book.jobLockHeld('j1',query),true);assert.equal(await book.jobLockHeld('j2',query),false);
 assert.equal(await book.jobLockHeld('j1',undefined),false);assert.equal(await book.jobLockHeld('j1',{query:async()=>{throw new Error('denied');}}),false);
});

test('countdown ticks each second, stops on request and waits for a hidden tab before retrying',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const ticks=[],waiting=book.countdown(3,{onTick:left=>ticks.push(left)});t.mock.timers.tick(3000);assert.equal(await waiting,false);assert.deepEqual(ticks,[3,2,1]);
 let stop=false;const stopping=book.countdown(30,{stopped:()=>stop});t.mock.timers.tick(1000);stop=true;t.mock.timers.tick(1000);assert.equal(await stopping,true);
 const previous=globalThis.document,listeners={};globalThis.document={visibilityState:'hidden',addEventListener:(type,handler)=>{listeners[type]=handler;},removeEventListener(){}};
 try{const early=book.countdown(5,{early:true});t.mock.timers.tick(10000);let settled=false;early.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);globalThis.document.visibilityState='visible';listeners.visibilitychange();assert.equal(await early,false);}
 finally{globalThis.document=previous;}
});

test('a run continued later keeps the pages the student left out; only an edited range field adds or skips pages',()=>{
 // Cover 1, page 2 done, page 3 blank, 4-6 pending, 7-12 left out when the job was made, 13 failed.
 const states='c'+'db'+'...'+'s'.repeat(6)+'f';
 assert.equal(book.chosenPagesText(states),'2-6, 13');assert.equal(book.chosenPagesText('c.....'),'');assert.equal(book.chosenPagesText('sssd.'),'4-5');
 // After a reload or on another device the field is empty: failed pages are tried again, skipped pages stay skipped.
 assert.deepEqual(book.resumeUpdates(states,null,false),{13:'pending'});
 assert.deepEqual(book.resumeUpdates('cdd..sssssss',null),{});
 // A field the student cleared means the whole book again; an edited range adds or skips pages, failed ones included.
 assert.deepEqual(book.resumeUpdates(states,null,true),{7:'pending',8:'pending',9:'pending',10:'pending',11:'pending',12:'pending',13:'pending'});
 assert.deepEqual(book.resumeUpdates(states,new Set([2,3,4,7]),true),{5:'skipped',6:'skipped',7:'pending',13:'skipped'});
 // The field filled from a job names exactly its pages: applying it changes nothing.
 assert.deepEqual(book.resumeUpdates(states,parseStudyPageRange(book.chosenPagesText(states),13,Infinity),true),{13:'pending'});
});

test('a chunk saved twice after a lost answer is continued from the session that went on, never from the leftover draft',()=>{
 const sha='b'.repeat(64),job={id:'j',sourceSha256:sha,storyId:'book-1',createdAt:'2026-10-19T01:00:00.000Z',pageStates:'d'.repeat(20)+'.'.repeat(20)};
 // GET /history order (updated_at DESC): the retry's session finished, the first save's draft never went on.
 const items=[
  {id:'S2-complete',status:'complete',source_sha256:sha,created_at:'2026-10-19 01:10:05',updated_at:'2026-10-19 01:20:00',library_story_id:'book-1',page_start:21,page_end:40,translated_parts:30,total_parts:30},
  {id:'orphan-draft',status:'draft',source_sha256:sha,created_at:'2026-10-19 01:10:00',updated_at:'2026-10-19 01:10:00',library_story_id:null,page_start:21,page_end:40,translated_parts:0,total_parts:30}
 ];
 assert.equal(book.findChunkSession(items,job,21).id,'S2-complete');assert.equal(book.findChunkSession([...items].reverse(),job,21).id,'S2-complete');
 // Of two unfinished copies the one with more translated parts goes on, however the list is ordered.
 const early={...items[1],id:'early',status:'translating',translated_parts:4,updated_at:'2026-10-19 01:30:00'},further={...items[1],id:'further',status:'translating',translated_parts:12};
 assert.equal(book.findChunkSession([early,further],job,25).id,'further');assert.equal(book.findChunkSession([further,early],job,25).id,'further');
 assert.equal(book.findChunkSession([items[1]],job,21).id,'orphan-draft');assert.equal(book.findChunkSession(items,job,41),null);
});

test('a chunk\'s first save keeps one session id however often it is retried',async()=>{
 const account=fakeAccount({total:25,cover:0}),ids=[];let failures=2;
 account.steps.start=async(result,job,options={})=>{ids.push(options.sessionId);if(failures-->0)throw offline();};
 assert.equal((await account.create().run(account.state.job)).status,'done');
 // Chunk 1 tried three times under one id, chunk 2 under its own.
 assert.equal(ids.length,4);assert.match(ids[0],/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u);
 assert.deepEqual(ids.slice(0,3),[ids[0],ids[0],ids[0]]);assert.notEqual(ids[3],ids[0]);
});

test('Gemini overloaded or out of reach is waited out with backoff before the run pauses',async()=>{
 const error=(status,data={},message='x')=>Object.assign(new Error(message),{status,data});
 const unavailable=()=>error(503,{code:'gemini_unavailable',retryAfter:30},'Gemini đang quá tải hoặc tạm thời không phản hồi (mã 503).');
 assert.deepEqual(book.classifyError(unavailable(),'translate'),{reason:'gemini_unavailable',backoff:true,retries:6,wait:30});
 assert.deepEqual(book.classifyError(error(503,{code:'gemini_unavailable',retryAfter:9000})),{reason:'gemini_unavailable',backoff:true,retries:6,wait:300});
 // Older servers answered the same case with a plain 400.
 assert.equal(book.classifyError(error(400,{},'Gemini trả lỗi 503. Kiểm tra hạn mức và thử lại sau.'),'translate').reason,'gemini_unavailable');
 assert.equal(book.classifyError(error(400,{},'Gemini trả lỗi 500. Kiểm tra hạn mức và thử lại sau.'),'translate').reason,'gemini_unavailable');
 assert.match(book.pauseMessage('gemini_unavailable'),/Gemini đang quá tải.*Tiến độ đã lưu/u);assert.match(book.waitMessage('gemini_unavailable',30),/30 giây/u);
 const twice=fakeAccount({total:5,cover:0,translateErrors:[unavailable(),unavailable()]});
 assert.equal((await twice.create().run(twice.state.job)).status,'done');assert.deepEqual(twice.sleeps,[30,30]);
 const always=fakeAccount({total:5,cover:0,translateErrors:Array.from({length:7},unavailable)}),gone=await always.create().run(always.state.job);
 assert.deepEqual([gone.status,gone.reason],['paused','gemini_unavailable']);assert.deepEqual(always.sleeps,[30,30,30,40,60,60]);
 assert.equal(always.state.job.pauseReason,'gemini_unavailable');
});

test('tokens are reported once: a report resent after a lost answer, and the tokens of a run whose pause could not be sent',async()=>{
 // The chunk report is applied but its answer is lost; the retry carries the same report id.
 let lost=false;const account=fakeAccount({total:3,cover:0,lose:body=>!lost&&Boolean(body.pages)&&(lost=true)});
 assert.equal((await account.create().run(account.state.job)).status,'done');assert.ok(lost);
 assert.deepEqual([account.state.job.usage.total,account.state.job.usage.requests],[867,1]);
 const [sent,resent]=account.patches.filter(body=>body.pages);assert.deepEqual(resent.reports,sent.reports);
 // The connection drops mid-chunk and stays down, so the pause is not sent either: the tokens stay with the device
 // and go with the next run's first report.
 let down=false,runner;const broken=fakeAccount({total:5,cover:0,down:()=>down});
 broken.steps.translate=async()=>{if(!down)runner.recordUsage({prompt:5000,output:3000,total:8000,requests:4});down=true;throw offline();};
 const device='device-0000-4000-8000-000000000003';runner=broken.create({runner:device});const paused=await runner.run(broken.state.job);
 assert.deepEqual([paused.status,paused.reason],['paused','network']);assert.equal(broken.state.job.usage.total,0);assert.equal(runner.usage.total,8000);
 assert.equal(broken.reports.load(broken.state.job.id).length,1);
 down=false;broken.steps.translate=async()=>({complete:true,model:'gemini-2.5-flash-lite'});
 // The same browser (its runner id is kept per browser) goes on at once, although its pause never arrived.
 const before=broken.patches.length;assert.equal((await broken.create({runner:device}).run(broken.state.job)).status,'done');
 assert.deepEqual([broken.state.job.usage.total,broken.state.job.usage.requests],[8000,4]);assert.deepEqual(broken.reports.load(broken.state.job.id),[]);
 assert.equal(broken.patches[before].status,'running');assert.equal(broken.patches[before].reports.length,1,'the first report of the next run carries them');
});

test('the reports kept on the device survive a reload and a broken storage, and drop what is malformed',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
 const report={id:'11111111-1111-4111-8111-111111111111',usage:{prompt:1,output:2,thinking:0,total:3,requests:1}};
 book.reportStore(storage).save('job-1',[report]);assert.deepEqual(book.reportStore(storage).load('job-1'),[report]);
 book.reportStore(storage).save('job-1',[]);assert.equal(values.size,0,'an empty list leaves nothing behind');
 values.set('hoa-tri-book-usage:job-2','not json');values.set('hoa-tri-book-usage:job-3',JSON.stringify([{id:'x'},report,{id:report.id,usage:'bad'}]));
 assert.deepEqual(book.reportStore(storage).load('job-2'),[]);assert.deepEqual(book.reportStore(storage).load('job-3'),[report]);
 // Storage that throws (a private window) still keeps the reports for this page.
 const broken={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}},store=book.reportStore(broken);
 store.save('job-1',[report]);assert.deepEqual(store.load('job-1'),[report]);
});

test('one run per job: a second device stops before paying for anything, and a run whose lease another device took stops too',async()=>{
 assert.match(book.pauseMessage('busy',Object.assign(new Error('x'),{status:409,data:{code:'job_busy',retryAfter:540}})),/^Quyển này đang được dịch ở một thiết bị khác.*Chờ rồi dịch tiếp/su);
 assert.equal(book.classifyError(Object.assign(new Error('x'),{status:409,data:{code:'job_busy',retryAfter:540}}),'save').reason,'busy');
 assert.equal(book.heldElsewhere({runner:'a'.repeat(36),leaseSeconds:300},'b'.repeat(36)),true);assert.equal(book.heldElsewhere({runner:'a'.repeat(36),leaseSeconds:300},'a'.repeat(36)),false);assert.equal(book.heldElsewhere({runner:null,leaseSeconds:0},'b'.repeat(36)),false);
 // The laptop is translating its first chunk when the phone starts the same job.
 const account=fakeAccount({total:30,cover:0});let phone=null,laptop;
 account.steps.translate=async()=>{if(!phone)phone=await account.create({runner:'phone-0000-4000-8000-000000000002'}).run(account.state.job);laptop.recordUsage({total:867,requests:1});return {complete:true,model:'gemini-2.5-flash-lite'};};
 laptop=account.create({runner:'laptop-000-4000-8000-000000000001'});
 const done=await laptop.run(account.state.job);
 assert.deepEqual([done.status,phone.status,phone.reason],['done','paused','busy']);assert.match(phone.message,/Quyển này đang được dịch ở một thiết bị khác/u);
 assert.deepEqual(account.extracts.map(entry=>entry.offset),[0,20],'the phone extracted nothing');assert.equal(account.state.job.usage.total,867*2);
 assert.ok(account.patches.filter(body=>body.runner==='phone-0000-4000-8000-000000000002').length<=1,'the phone only asked once');
 // A run that reports every minute renews its lease from inside a long chunk; when another device has taken the job
 // meanwhile, it stops at its next report and its tokens still count.
 const taken=fakeAccount({total:5,cover:0});let run,beats=0;
 taken.steps.translate=async({renew})=>{run.recordUsage({total:500,requests:1});await renew();beats++;taken.state.lease={runner:'other-device-4000-8000-000000000009',until:Date.now()+600000};return {complete:true,model:'gemini-2.5-flash-lite'};};
 run=taken.create({renewEvery:0});const lostLease=await run.run(taken.state.job);
 assert.equal(beats,1);assert.deepEqual([lostLease.status,lostLease.reason],['paused','busy']);assert.equal(taken.state.job.pageStates,'.....');
 assert.equal(taken.state.job.usage.total,500);assert.notEqual(taken.state.job.status,'paused','the job is the other device\'s to report');
});

// The PDF service's typed answers (backend/pdf-layout.js), as study.js api() hands them to a run.
const pdfError=(status,code,message,retryAfter)=>Object.assign(new Error(message),{status,data:{error:message,code,...(retryAfter?{retryAfter}:{})},retryAfter:retryAfter||null});
const serviceBusy=()=>pdfError(503,'pdf_service_busy','Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.',20);

test('PDF service answers map to waiting, halving or a pause: busy is waited out long, too heavy halves the chunk',()=>{
 assert.deepEqual(book.classifyError(serviceBusy(),'extract'),{reason:'pdf_busy',backoff:true,retries:book.SERVICE_BUSY_RETRIES,wait:20,early:false,jitter:true});
 assert.equal(book.classifyError(serviceBusy(),'export').reason,'pdf_busy');assert.equal(book.SERVICE_BUSY_RETRIES,30);
 for(const code of ['pdf_timeout','pdf_memory','pdf_too_large'])assert.deepEqual(book.classifyError(pdfError(413,code,'Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.'),'extract'),{reason:'too_large',heavy:true},code);
 assert.deepEqual(book.classifyError(pdfError(413,'pdf_crash','Dịch vụ PDF dừng đột ngột…'),'extract'),{reason:'too_large'});
 assert.deepEqual(book.classifyError(pdfError(503,'pdf_unavailable','Dịch vụ PDF đang tạm ngừng.',30),'extract'),{reason:'network',backoff:true,retries:6,wait:30});
 // This account's own other PDF call (another tab) is still the short wait of a limit.
 assert.deepEqual(book.classifyError(pdfError(429,'pdf_busy','Tài khoản của bạn đang có một lượt xử lý PDF khác…',30),'extract'),{reason:'rate_limited',wait:30,retries:20});
 assert.match(book.waitMessage('pdf_busy',20),/Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc\. Tự thử lại sau 20 giây/u);
 assert.match(book.pauseMessage('pdf_busy'),/Dịch vụ PDF vẫn bận.*Tiến độ đã lưu/u);
});

test('a run waits while the PDF service is busy, in a hidden tab too, and pauses only after about half an hour',async()=>{
 let refusals=2;const account=fakeAccount({total:5,cover:0,refuse:()=>refusals-->0?serviceBusy():null});
 const outcome=await account.create({random:()=>0}).run(account.state.job);
 assert.equal(outcome.status,'done');assert.equal(account.state.job.pageStates,'ddddd');
 assert.deepEqual(account.waits,[{seconds:20,early:false},{seconds:20,early:false}]);
 // The waits grow to a minute and are spread a little (random), so the students it refused do not all come back at once.
 const always=fakeAccount({total:5,cover:0,refuse:()=>serviceBusy()}),paused=await always.create({random:()=>1}).run(always.state.job);
 assert.deepEqual([paused.status,paused.reason],['paused','pdf_busy']);assert.equal(always.state.job.pauseReason,'pdf_busy');assert.match(paused.message,/Dịch vụ PDF vẫn bận/u);
 assert.equal(always.sleeps.length,book.SERVICE_BUSY_RETRIES);assert.deepEqual(always.sleeps.slice(0,5),[25,25,25,50,75]);assert.ok(always.sleeps.every(seconds=>seconds<=75));
 const total=always.sleeps.reduce((sum,seconds)=>sum+seconds,0);assert.ok(total>=25*60&&total<=40*60,`${total} s`);
 // An export refused as busy is tried again too, instead of being skipped.
 let exportRefusals=1;const exporting=fakeAccount({total:5,cover:0});const finish=exporting.steps.finish;exporting.steps.finish=async job=>{if(exportRefusals-->0)throw serviceBusy();return finish(job);};
 assert.equal((await exporting.create({random:()=>0}).run(exporting.state.job)).status,'done');assert.deepEqual(exporting.sleeps,[20]);
});

test('a chunk that runs out of time or memory in the service is retried with half the pages, and later chunks keep that size',async()=>{
 const tooHeavy=({count})=>count>10?pdfError(413,'pdf_timeout','Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.'):null;
 const account=fakeAccount({total:45,cover:0,refuse:tooHeavy}),outcome=await account.create().run(account.state.job);
 assert.equal(outcome.status,'done');assert.equal(account.state.job.pageStates,'d'.repeat(45));
 assert.deepEqual(account.extracts.map(({offset,count})=>[offset,count]),[[0,20],[0,10],[10,10],[20,10],[30,10],[40,5]]);
 // Out of memory alone on one page: that page is marked failed and the rest go on.
 const memory=fakeAccount({total:3,cover:0,refuse:({offset,count})=>offset<=1&&offset+count>=2?pdfError(413,'pdf_memory','Không đủ bộ nhớ để xử lý các trang đã chọn. Hãy chọn ít trang hơn cho mỗi lượt.'):null}),notes=[];
 assert.equal((await memory.create({ui:{warn:message=>notes.push(message)}}).run(memory.state.job)).status,'done');
 assert.equal(memory.state.job.pageStates,'dfd');assert.match(notes[0],/^Trang 2: Không đủ bộ nhớ/u);
});
