import test from 'node:test';
import assert from 'node:assert/strict';
import * as book from '../frontend/whole-book.js';
import {keyRefused} from '../frontend/gemini-key.js';
import * as pdfClient from '../frontend/pdf-client.js';

// The error contracts Xưởng dịch reads, without a browser: when the student's Gemini key is forgotten, how a whole-book
// run treats Gemini's location, a full history or a part saved elsewhere, the id a chunk's session is saved under (so any
// device finds it), a chunk too big for one save, and pdf.js's English errors. No network, no Gemini.
const error=(status,data={},message='x')=>Object.assign(new Error(message),{status,data});

test('Only the code gemini_key forgets the key: a refused text, a quota, Gemini\'s location or a bad request never does',()=>{
 assert.equal(keyRefused(error(403,{code:'gemini_key'},'Gemini từ chối yêu cầu (403): khóa Gemini API đang bị chặn…')),true);
 // RECITATION and a generic 400 in the words older servers used, now with their codes: the code decides, not the words.
 assert.equal(keyRefused(error(400,{code:'gemini_refused'},'Gemini từ chối trả kết quả vì trùng khớp nguyên văn với nội dung có bản quyền.')),false);
 assert.equal(keyRefused(error(400,{code:'gemini_request'},'Gemini từ chối yêu cầu (400): dữ liệu gửi đi không hợp lệ hoặc quá lớn.')),false);
 assert.equal(keyRefused(error(503,{code:'gemini_location',retryAfter:60},'Gemini chưa phục vụ khu vực của máy chủ Hoa Trí…')),false);
 assert.equal(keyRefused(error(429,{code:'quota_day'},'Khóa Gemini này đã dùng hết hạn mức trong ngày.')),false);
 // Without a code (a server older than the codes) the key's own messages count, and a generic 400 still does not.
 assert.equal(keyRefused(error(400,{},'Gemini từ chối yêu cầu (403). Khóa API có thể không hợp lệ…')),true);
 assert.equal(keyRefused(error(400,{},'Gemini từ chối yêu cầu (400): dữ liệu gửi đi không hợp lệ hoặc quá lớn.')),false);
 assert.equal(keyRefused(new Error('Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa.')),true);
 // A whole-book run follows the same rule: only gemini_key pauses for a new key.
 assert.equal(book.classifyError(error(403,{code:'gemini_key'}),'translate').reason,'gemini_key');
 assert.notEqual(book.classifyError(error(400,{code:'gemini_refused'},'Gemini từ chối trả kết quả vì trùng khớp nguyên văn…'),'translate').reason,'gemini_key');
 assert.notEqual(book.classifyError(error(400,{},'Gemini từ chối yêu cầu (400): dữ liệu gửi đi không hợp lệ.'),'translate').reason,'gemini_key');
 assert.equal(book.classifyError(error(400,{},'Gemini từ chối yêu cầu (403). Khóa API có thể không hợp lệ…')).reason,'gemini_key');
});

test('Gemini not serving the server\'s location is waited out with the key kept; a full history and a part saved elsewhere pause for what they are',()=>{
 assert.deepEqual(book.classifyError(error(503,{code:'gemini_location',retryAfter:60}),'translate'),{reason:'gemini_location',wait:60,retries:5});
 assert.equal(book.classifyError(error(503,{code:'gemini_location'}),'translate').wait,60);
 assert.match(book.waitMessage('gemini_location',42),/khóa của bạn vẫn dùng được\. Tự thử lại sau 42 giây…$/u);
 assert.match(book.pauseMessage('gemini_location'),/Khóa của bạn vẫn dùng được và các lần thử này không tốn token\./u);
 // 413 history_full is the account's history, not a chunk too heavy for the PDF service (which halves the chunk).
 const full=error(413,{code:'history_full',items:300,maxItems:300},'Lịch sử dịch của tài khoản đã có 300 bản dịch, mức tối đa cho mỗi tài khoản. Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.');
 assert.equal(book.classifyError(full,'save').reason,'history_full');assert.equal(book.classifyError(error(413,{code:'pdf_too_large'}),'extract').reason,'too_large');
 assert.match(book.pauseMessage('history_full',full),/^Lịch sử dịch của tài khoản đã có 300 bản dịch.* Tiến độ của quyển đã lưu; dọn bớt xong, bấm Dịch tiếp\.$/u);
 assert.equal(book.classifyError(error(413,{code:'too_many_parts'}),'save').reason,'too_many_parts');
 assert.equal(book.classifyError(error(409,{code:'history_conflict',revision:8}),'translate').reason,'conflict');
 // One word for a browser tab everywhere: "tab".
 assert.match(book.pauseMessage('conflict'),/^Phần đang dịch vừa được lưu từ một tab hoặc thiết bị khác, nên tab này dừng.*Dịch tiếp để mở bản mới nhất/u);
 assert.doesNotMatch(Object.keys(book).filter(name=>/Message$/u.test(name)).flatMap(name=>['stopped','busy','gemini_unavailable','quota_day','quota','quota_minute','gemini_key','rate_limited','pdf_busy','pdf_account','gemini_location','history_full','conflict','network','limit','x'].map(reason=>book[name](reason,null,0))).join('\n'),/thẻ/u);
});

test('A save that fails after Gemini translated part of a chunk pauses the book saying that part is only in this tab, never that the progress is saved; with nothing translated yet, or a copy saved elsewhere, the pause is as before',async()=>{
 const FULL='Lịch sử dịch của tài khoản đã dùng 500 MB, mức tối đa cho mỗi tài khoản. Hãy xóa trong Lịch sử dịch những bản dịch không cần nữa rồi thử lại.';
 // As study.js saveBeforeSpending throws them: a refusal keeps the server's words and code, anything else is a lost connection.
 const failed=(status,data,message,keptInTab=true)=>Object.assign(error(status,data,message),{code:'save_failed',keptInTab});
 const KEPT=' Phần đã dịch vẫn hiện trong tab này: đừng đóng tab. Các trang đã xong trước đó đã lưu; ';
 assert.equal(book.pauseMessage('history_full',failed(413,{code:'history_full'},FULL)),`${FULL}${KEPT}dọn bớt xong, bấm Dịch tiếp ở tab này.`);
 assert.equal(book.pauseMessage('network',failed(0,undefined,'Đã dừng vì chưa lưu được tiến độ vào tài khoản, nên Hoa Trí không gửi thêm yêu cầu tới Gemini. Phần đã dịch vẫn hiện trong tab này: đừng đóng tab. Kiểm tra mạng rồi bấm Bắt đầu dịch để lưu và dịch tiếp.')),`Mất kết nối tới máy chủ.${KEPT}khi mạng ổn định, bấm Dịch tiếp ở tab này.`);
 assert.equal(book.pauseMessage('error',failed(400,{code:'history_invalid'},'Phiên bản lịch sử không hợp lệ.')),`Phiên bản lịch sử không hợp lệ.${KEPT}bấm Dịch tiếp ở tab này để lưu và dịch tiếp.`);
 assert.doesNotMatch(['history_full','network','error','rate_limited','limit','too_many_parts'].map(reason=>book.pauseMessage(reason,failed(413,{code:reason},FULL))).join('\n'),/Tiến độ (?:của quyển )?đã lưu/u);
 assert.equal(book.pauseMessage('history_full',failed(413,{code:'history_full'},FULL,false)),`${FULL} Tiến độ của quyển đã lưu; dọn bớt xong, bấm Dịch tiếp.`);
 assert.match(book.pauseMessage('conflict',failed(409,{code:'history_conflict'},'Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác.')),/^Phần đang dịch vừa được lưu từ một tab hoặc thiết bị khác.*Tiến độ của quyển đã lưu; bấm Dịch tiếp để mở bản mới nhất/u);
 // Through a run: the translate step's save is refused after a paid batch, and the run pauses for it in those words.
 const job={id:'0b7e2a43-0000-4000-8000-000000000003',sourceSha256:'e'.repeat(64),filename:'sach.pdf',title:'Sách',storyId:null,totalPages:2,pageStates:'..',chunkSize:20,status:'ready',pauseReason:null,usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{},createdAt:'2026-10-18T10:00:00.000Z',runner:null,leaseSeconds:0};
 let current=job;
 const api=async(path,options={})=>{
  if(path===`book-jobs/${job.id}`){const body=JSON.parse(options.body);current={...current,...(body.status?{status:body.status,pauseReason:body.pauseReason??null}:{})};return {job:current};}
  if(path==='pdf-layout/extract')return {assetId:'asset-0',document:{pages:[1,2].map(number=>({number,blocks:[{id:`p${number}-b1`}]}))}};
  throw new Error(`unexpected ${path}`);
 };
 const steps={async open(){return null;},async start(){},async translate(){throw failed(413,{code:'history_full'},FULL);},async finish(){return {storyId:null,glossary:{}};}};
 const outcome=await book.createBookRun({api,steps,source:{cut:async pages=>new Uint8Array(pages.length*10)},reports:book.reportStore(),sleep:async()=>false}).run(job);
 assert.deepEqual({status:outcome.status,reason:outcome.reason,message:outcome.message},{status:'paused',reason:'history_full',message:`${FULL}${KEPT}dọn bớt xong, bấm Dịch tiếp ở tab này.`});
 assert.equal(current.pauseReason,'history_full');
});

// A run over a fake job: chunks are cut as the run asks, extraction numbers pages from the chunk's offset, and start()
// may refuse a chunk as the history save does.
function miniRun({total=25,start=null}={}){
 const job={id:'0b7e2a43-0000-4000-8000-000000000001',sourceSha256:'d'.repeat(64),filename:'sach.pdf',title:'Sách',storyId:null,totalPages:total,pageStates:'.'.repeat(total),chunkSize:20,status:'ready',pauseReason:null,usage:{prompt:0,output:0,thinking:0,total:0,requests:0},glossary:{},createdAt:'2026-10-18T10:00:00.000Z',runner:null,leaseSeconds:0};
 const state={job,extracts:[],starts:[],warnings:[]};
 const api=async(path,options={})=>{
  if(path===`book-jobs/${job.id}`){
   const body=JSON.parse(options.body);if(body.pages)state.job={...state.job,pageStates:book.withStates(state.job.pageStates,body.pages)};
   if(body.status)state.job={...state.job,status:body.status,pauseReason:body.pauseReason??null};return {job:{...state.job}};
  }
  if(path==='pdf-layout/extract'){const form=options.body,offset=Number(form.get('pageOffset')),count=Number(form.get('pages').split('-')[1]);state.extracts.push([offset,count]);return {assetId:`asset-${offset}`,document:{pages:Array.from({length:count},(_,i)=>({number:offset+i+1,blocks:[{id:`p${offset+i+1}-b1`}]}))}};}
  throw new Error(`unexpected ${path}`);
 };
 const steps={
  async open(){return null;},
  async start(result,_,{sessionId}){const pages=result.document.pages.map(page=>page.number);state.starts.push({sessionId,pages});await start?.(pages);},
  async translate(){return {complete:true,model:'gemini-2.5-flash-lite'};},
  async finish(){return {storyId:null,glossary:{}};}
 };
 const run=book.createBookRun({api,steps,source:{cut:async pages=>new Uint8Array(pages.length*10)},reports:book.reportStore(),sleep:async()=>false,ui:{warn:message=>state.warnings.push(message)}});
 return {state,run,job};
}

test('A chunk\'s session is saved under an id every device derives from the job and its first page, so a stale tab finds it',async()=>{
 const jobId='0b7e2a43-0000-4000-8000-000000000001',first=await book.chunkSessionId(jobId,1);
 assert.match(first,/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u);
 assert.equal(await book.chunkSessionId(jobId,1),first,'the same on every call, tab and device');
 assert.notEqual(await book.chunkSessionId(jobId,21),first);assert.notEqual(await book.chunkSessionId('0b7e2a43-0000-4000-8000-000000000002',1),first);
 const {state,run,job}=miniRun({total:25});assert.equal((await run.run(job)).status,'done');
 assert.deepEqual(state.starts.map(entry=>entry.sessionId),[first,await book.chunkSessionId(jobId,21)]);
});

test('A chunk with more blocks than one history save takes is extracted again half as long; a page that still has too many is marked failed',async()=>{
 const tooMany=()=>error(413,{code:'too_many_parts'},'Bản dịch có 3.200 phần, nhiều hơn mức 3.000 phần của một lần lưu. Hãy chọn khoảng trang ngắn hơn rồi dịch lại.');
 const halved=miniRun({total:10,start:pages=>{if(pages.length>4)throw tooMany();}});
 assert.equal((await halved.run.run(halved.job)).status,'done');
 assert.deepEqual(halved.state.extracts,[[0,10],[0,5],[0,2],[2,2],[4,2],[6,2],[8,2]]);assert.equal(halved.state.job.pageStates,'d'.repeat(10));
 const single=miniRun({total:3,start:()=>{throw tooMany();}});
 assert.equal((await single.run.run(single.job)).status,'done');
 assert.deepEqual(single.state.extracts,[[0,3],[0,1],[1,1],[2,1]]);assert.equal(single.state.job.pageStates,'fff');
 assert.match(single.state.warnings[0],/^Trang 1: Bản dịch có 3\.200 phần/u);
});

test('pdf.js errors of a protected or broken file, or of a browser too old for it, become Vietnamese advice',()=>{
 const named=(name,message)=>Object.assign(new Error(message),{name});
 const password=pdfClient.pdfOpenError(named('PasswordException','No password given'));
 assert.equal(password.code,'pdf_password');assert.match(password.message,/^PDF này có mật khẩu mở tệp nên Hoa Trí không đọc được\./u);assert.doesNotMatch(password.message,/password/u);
 for(const name of ['InvalidPDFException','FormatError','UnknownErrorException']){const broken=pdfClient.pdfOpenError(named(name,'Invalid PDF structure.'));assert.equal(broken.code,'pdf_invalid',name);assert.match(broken.message,/tệp bị hỏng, chưa tải về đủ hoặc không phải PDF/u);}
 assert.equal(pdfClient.pdfOpenError(new TypeError('hashOriginal.toHex is not a function')).code,'pdf_browser');
 const other=new RangeError('x');assert.equal(pdfClient.pdfOpenError(other),other,'anything else is passed on as it is');
});
