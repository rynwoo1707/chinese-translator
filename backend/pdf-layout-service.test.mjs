import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmdirSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serviceHandler,jobLimit,failureAnswer,BUSY_SECONDS,BODY_LIMITS} from '../services/pdf-layout/server.mjs';
import {pythonOperation,pythonFailure,stopError,overflowError,overflowMessage,blockLabel,browserFailure} from '../services/pdf-layout/engine.mjs';
import {asciiJson,asciiJsonBytes} from '../services/pdf-layout/ascii-json.mjs';
import {buildVersion,filesHash,layoutVersion,LAYOUT_FILES,SERVICE_FILES} from '../services/pdf-layout/version.mjs';
import {healthCheck} from '../services/pdf-layout/healthcheck.mjs';

// The PDF layout service without Python, Chromium or Gemini: its HTTP layer with stand-in jobs, the engine's process
// handling with Node standing in for Python, and the real `node services/pdf-layout/server.mjs` with a fake extract.py
// (test-support/fake-python.mjs).
const root=fileURLToPath(new URL('../',import.meta.url)),TOKEN='t'.repeat(40),auth={Authorization:`Bearer ${TOKEN}`};
const read=file=>readFileSync(join(root,file),'utf8');
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const page=()=>({number:1,width:600,height:800,background:PNG,original:PNG,blocks:[{id:'p1-b0',source:'空间向量。',box:[20,20,200,80],fontSize:12}]});
const extracted=()=>({document:{version:1,pages:[page()]},originalPdfBase64:Buffer.from('%PDF-1.7').toString('base64')});
// Jobs that wait until the test lets them finish, or until their caller leaves (their signal), as the engine's do.
function heldJobs(){
 const jobs=[];
 const operation=(payload,{signal}={})=>new Promise((resolve,reject)=>{jobs.push({payload,signal,finish:()=>resolve(extracted())});signal?.addEventListener('abort',()=>reject(stopError(signal)),{once:true});});
 return {jobs,operations:{pythonOperation:operation,renderDocument:(document,translations,options)=>operation({document,translations},options),fontCss:async()=>'@font-face{font-family:HoaTriPDF}'}};
}
async function listen(t,handler){
 const server=createServer(handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 return `http://127.0.0.1:${server.address().port}`;
}
const extract=(origin,options={})=>fetch(origin+'/extract',{method:'POST',headers:{...auth,'Content-Type':'application/pdf','X-PDF-Pages':'1'},body:'%PDF-1.7 stand-in',...options});
const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error('timed out waiting');await new Promise(done=>setTimeout(done,20));}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('The service answers busy with 503, Retry-After and a code once its jobs are all running; PDF_LAYOUT_JOBS sets how many',async t=>{
 assert.equal(jobLimit(undefined),2);assert.equal(jobLimit(''),2);assert.equal(jobLimit('3'),3);assert.equal(jobLimit('0'),2);assert.equal(jobLimit('x'),2);
 const {jobs,operations}=heldJobs(),origin=await listen(t,serviceHandler({token:TOKEN,operations,version:null,log:()=>{}}).handler);
 const first=extract(origin),second=extract(origin);await until(()=>jobs.length===2);
 const third=await extract(origin);
 assert.equal(third.status,503);assert.equal(third.headers.get('Retry-After'),String(BUSY_SECONDS));
 assert.deepEqual(await third.json(),{error:'Dịch vụ PDF đang bận. Hãy thử lại sau.',code:'busy',retryAfter:BUSY_SECONDS});
 assert.equal(jobs.length,2,'a third job never starts');
 jobs[0].finish();assert.equal((await first).status,200);
 const fourth=extract(origin);await until(()=>jobs.length===3);jobs[1].finish();jobs[2].finish();
 assert.equal((await second).status,200);assert.equal((await fourth).status,200);
 // One job at a time on a server with a single CPU.
 const single=heldJobs(),one=await listen(t,serviceHandler({token:TOKEN,jobs:jobLimit('1'),operations:single.operations,version:null,log:()=>{}}).handler);
 const running=extract(one);await until(()=>single.jobs.length===1);assert.equal((await extract(one)).status,503);single.jobs[0].finish();assert.equal((await running).status,200);
});

test('A caller that hangs up stops its job at once and frees its place; an export also gets the service deadline',async t=>{
 const {jobs,operations}=heldJobs(),logs=[],service=serviceHandler({token:TOKEN,operations,version:null,log:line=>logs.push(line)}),origin=await listen(t,service.handler);
 const caller=new AbortController(),gone=extract(origin,{signal:caller.signal}).catch(error=>error);await until(()=>jobs.length===1);
 assert.equal(jobs[0].signal.aborted,false);caller.abort();await gone;
 await until(()=>jobs[0].signal.aborted&&service.active===0);
 assert.match(logs.join('\n'),/stopped: the caller left/u);
 const next=extract(origin);await until(()=>jobs.length===2);assert.equal(jobs[1].signal.aborted,false);jobs[1].finish();assert.equal((await next).status,200);
 const renders=[],exporting={...operations,renderDocument:(document,translations,options)=>{renders.push(options);return new Promise(()=>{});}};
 const exportOrigin=await listen(t,serviceHandler({token:TOKEN,operations:exporting,version:null,log:()=>{}}).handler),leaving=new AbortController();
 const render=fetch(exportOrigin+'/render',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({document:{version:1,pages:[page()]},translations:[],title:'Bài 1'}),signal:leaving.signal}).catch(error=>error);
 await until(()=>renders.length===1);assert.equal(renders[0].title,'Bài 1');assert.ok(renders[0].deadlineMs>0&&renders[0].deadlineMs<280000,'below the Worker\'s 280 s');
 leaving.abort();await render;await until(()=>renders[0].signal.aborted);
});

test('Failed jobs answer 422 with their kind of failure; /health reports the load, the build and the font; answers are ASCII',async t=>{
 for(const [code,expected] of [['timeout','timeout'],['memory','memory'],['too_large','too_large'],['crash','crash'],['aborted',undefined],['ENOENT',undefined],[undefined,undefined]]){
  const answer=failureAnswer(Object.assign(new Error('Trang 3: lỗi.'),code?{code}:{}));
  assert.equal(answer.status,422);assert.deepEqual(answer.body,{error:'Trang 3: lỗi.',...(expected?{code:expected}:{})});
 }
 const failing={pythonOperation:async()=>{throw Object.assign(new Error('Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.'),{code:'timeout'});},renderDocument:async()=>({pdfBase64:'JVBERi0=',report:[]}),fontCss:async()=>''};
 const origin=await listen(t,serviceHandler({token:TOKEN,operations:failing,version:{layout:'1234abcd',service:'5678ef00'},font:()=>'LiberationSerif-Regular.ttf',log:()=>{}}).handler);
 const failed=await extract(origin);assert.equal(failed.status,422);assert.deepEqual(await failed.json(),{error:'Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.',code:'timeout'});
 assert.equal((await fetch(origin+'/health')).status,401);
 assert.deepEqual(await (await fetch(origin+'/health',{headers:auth})).json(),{ok:true,engine:'pymupdf-puppeteer',busy:false,active:0,jobs:2,version:{layout:'1234abcd',service:'5678ef00'},font:'LiberationSerif-Regular.ttf'});
 // Chinese and Vietnamese travel as \u escapes, so the text stays one byte per character in V8 on both sides.
 const echo=await listen(t,serviceHandler({token:TOKEN,operations:{...failing,pythonOperation:async()=>extracted()},version:null,log:()=>{}}).handler);
 const text=await (await extract(echo)).text();assert.doesNotMatch(text,/[^\x00-\x7f]/u);assert.equal(JSON.parse(text).document.pages[0].blocks[0].source,'空间向量。');
 assert.throws(()=>serviceHandler({token:'short'}),/tối thiểu 24 ký tự/u);
});

test('A translation longer than its box: the answer names each block “Trang N · đoạn k” as Xưởng dịch does, and the editor\'s “Đoạn k” to pick',async t=>{
 // The message quotes the PDF view of Xưởng dịch: its panel, editor, save and export controls, and its block numbers.
 const viewer=read('frontend/pdf-dual-viewer.js'),study=read('frontend/study.html');
 for(const control of ['Chỉnh bản dịch từng đoạn','Lưu đoạn đã sửa'])assert.ok(viewer.includes(control),control);
 assert.match(viewer,/textContent=`Đoạn \$\{i\+1\} · /u,'the editor lists a page\'s blocks as Đoạn 1, Đoạn 2, …');
 // In a sentence the viewer names a block "Trang N · đoạn k" (its notice on the same screen), as the message does.
 assert.match(viewer,/Trang \$\{entry\.number\} · đoạn \$\{i\+1\}/u);
 for(const control of ['Đối chiếu kết quả','>Xuất PDF tiếng Việt<'])assert.ok(study.includes(control),control);
 // The label is the block's place on its page, whatever its id says.
 const entry={number:24,blocks:['p24-b0','p24-b1','p24-b5','p24-b6'].map(id=>({id}))};
 assert.equal(blockLabel(entry,'p24-b0'),'Đoạn 1');assert.equal(blockLabel(entry,'p24-b5'),'Đoạn 3');
 const one=[{page:24,id:'p24-b5',label:'Đoạn 3'}],two=[...one,{page:24,id:'p24-b6',label:'Đoạn 4'}];
 const pages=[{page:3,id:'p3-b1',label:'Đoạn 2'},{page:15,id:'p15-b0',label:'Đoạn 1'},{page:15,id:'p15-b3',label:'Đoạn 4'}];
 assert.equal(overflowMessage(one),'Bản dịch của Trang 24 · đoạn 3 dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức, nên chưa xuất được PDF tiếng Việt. Ở phần “Đối chiếu kết quả”, chuyển tới Trang 24, mở “Chỉnh bản dịch từng đoạn”, chọn Đoạn 3, viết ngắn lại, bấm “Lưu đoạn đã sửa” rồi bấm lại “Xuất PDF tiếng Việt”.');
 assert.equal(overflowMessage(two),'Bản dịch của Trang 24 · đoạn 3 và Trang 24 · đoạn 4 dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức, nên chưa xuất được PDF tiếng Việt. Ở phần “Đối chiếu kết quả”, chuyển tới Trang 24, mở “Chỉnh bản dịch từng đoạn”, chọn từng đoạn đó, viết ngắn lại, bấm “Lưu đoạn đã sửa” rồi bấm lại “Xuất PDF tiếng Việt”.');
 assert.equal(overflowMessage(pages),'Bản dịch của 3 đoạn dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức, nên chưa xuất được PDF tiếng Việt: Trang 3 · đoạn 2, Trang 15 · đoạn 1, Trang 15 · đoạn 4. Ở phần “Đối chiếu kết quả”, chuyển tới từng trang đó, mở “Chỉnh bản dịch từng đoạn”, chọn đoạn cần sửa, viết ngắn lại, bấm “Lưu đoạn đã sửa” rồi bấm lại “Xuất PDF tiếng Việt”.');
 // Never an internal id, nor advice no control matches; short enough for the Worker to pass on whole. "Đoạn k",
 // capitalised, only where it names the editor's option to pick ("chọn Đoạn 3").
 const worst=Array.from({length:3000},(_,i)=>({page:10000+i,id:`p${10000+i}-b${i}`,label:`Đoạn ${1001+i}`}));
 for(const blocks of [one,two,pages,worst,worst.map(b=>({...b,page:12345}))]){
  const text=overflowMessage(blocks);assert.doesNotMatch(text,/p\d+-b\d+|\bblock\b|\bbox\b|điều chỉnh/iu,text);assert.ok(text.length<=600,`${text.length} characters`);
  assert.deepEqual(text.match(/Đoạn \d+/gu)||[],blocks.length===1?[blocks[0].label]:[],text);
 }
 assert.match(overflowMessage(worst),/: Trang 10000 · đoạn 1001, Trang 10001 · đoạn 1002, Trang 10002 · đoạn 1003, Trang 10003 · đoạn 1004, Trang 10004 · đoạn 1005 và 2995 đoạn khác\. /u);
 assert.match(overflowMessage(worst.map(b=>({...b,page:12345}))),/^Bản dịch của Trang 12345 · đoạn 1001, .*Trang 12345 · đoạn 1005 và 2995 đoạn khác dài hơn khung chữ, .* chuyển tới Trang 12345, .* chọn từng đoạn đó, /u);
 // The engine's own message keeps the ids (the samples tool edits texts.json by id, the log names them); the service
 // answers the student's text with the boxes for the browser to open.
 const error=overflowError(pages);assert.equal(error.code,'overflow');
 assert.equal(error.message,'Trang 3: chữ Việt không vừa box (p3-b1); Trang 15: chữ Việt không vừa box (p15-b0, p15-b3), kể cả ở cỡ chữ nhỏ nhất. Hãy rút gọn bản dịch của các block này rồi xuất lại.');
 assert.deepEqual(failureAnswer(error),{status:422,body:{error:overflowMessage(pages),code:'overflow',blocks:[{page:3,id:'p3-b1'},{page:15,id:'p15-b0'},{page:15,id:'p15-b3'}]}});
 const logs=[],refusing={pythonOperation:async()=>extracted(),renderDocument:async()=>{throw overflowError(one);},fontCss:async()=>''};
 const origin=await listen(t,serviceHandler({token:TOKEN,operations:refusing,version:null,log:line=>logs.push(line)}).handler);
 const answer=await fetch(origin+'/render',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({document:{version:1,pages:[page()]},translations:[],title:'Bài 1'})});
 assert.equal(answer.status,422);assert.deepEqual(await answer.json(),{error:overflowMessage(one),code:'overflow',blocks:[{page:24,id:'p24-b5'}]});
 assert.match(logs.join('\n'),/\/render Trang 24: chữ Việt không vừa box \(p24-b5\)/u);
});

test('Input the service cannot read gets a Vietnamese answer, and a body over the limit is read to its end before the 413',async t=>{
 const {jobs,operations}=heldJobs(),logs=[],origin=await listen(t,serviceHandler({token:TOKEN,operations,version:null,log:line=>logs.push(line)}).handler);
 const post=(path,type,body,headers={})=>fetch(origin+path,{method:'POST',headers:{...auth,'Content-Type':type,...headers},body,...(body instanceof ReadableStream?{duplex:'half'}:{})});
 for(const body of ['{"document":{"version":1,"pages":[','null','[]']){
  const answer=await post('/render','application/json',body);
  assert.equal(answer.status,400,body);assert.deepEqual(await answer.json(),{error:'Dịch vụ PDF nhận được dữ liệu hỏng hoặc bị cắt giữa chừng. Hãy thử lại; nếu lỗi lặp lại, hãy báo quản trị viên.'},body);
 }
 const range=await post('/extract','application/pdf','%PDF-1.7 stand-in',{'X-PDF-Pages':'%E0%A4%A'});
 assert.equal(range.status,400);assert.deepEqual(await range.json(),{error:'Phạm vi trang gửi tới dịch vụ PDF không hợp lệ. Hãy chọn lại phạm vi trang, ví dụ 1-5.'});
 // 1 MB past the limit, announced by Content-Length or streamed without it: the caller gets the 413, not a reset.
 const MB=1024*1024,stream=size=>{let left=size;return new ReadableStream({pull(controller){if(left<=0)return controller.close();const chunk=new Uint8Array(Math.min(MB,left)).fill(120);left-=chunk.length;controller.enqueue(chunk);}});};
 for(const [path,type,body,limit] of [['/extract','application/pdf',new Uint8Array(BODY_LIMITS.pdf+MB),25],['/extract','application/pdf',stream(BODY_LIMITS.pdf+MB),25],['/render','application/json',stream(BODY_LIMITS.json+MB),40]]){
  const answer=await post(path,type,body,{'X-PDF-Pages':'1'});
  assert.equal(answer.status,413,`${path} ${type}`);assert.deepEqual(await answer.json(),{error:`Dữ liệu gửi tới dịch vụ PDF lớn hơn ${limit} MB, vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.`,code:'too_large'});
 }
 assert.equal(jobs.length,0,'none of these reached a job');
 // The job's place was given back each time: a good request still runs.
 const good=post('/extract','application/pdf','%PDF-1.7 stand-in',{'X-PDF-Pages':'1'});await until(()=>jobs.length===1);jobs[0].finish();assert.equal((await good).status,200);
 assert.doesNotMatch(logs.join('\n'),/Unexpected end of JSON input|URI malformed/u);
});

test('An export whose browser cannot start answers 500 browser in Vietnamese; the log keeps Puppeteer\'s own words',async t=>{
 const saved=process.env.CHROMIUM_EXECUTABLE_PATH;t.after(()=>{if(saved===undefined)delete process.env.CHROMIUM_EXECUTABLE_PATH;else process.env.CHROMIUM_EXECUTABLE_PATH=saved;});
 const logs=[],origin=await listen(t,serviceHandler({token:TOKEN,version:null,log:line=>logs.push(line)}).handler);
 const profiles=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('puppeteer_dev_chrome_profile-')),before=new Set(profiles());
 const body=JSON.stringify({document:{version:1,pages:[page()]},translations:[{id:'p1-b0',translation:'Vectơ trong không gian.'}],title:'Bài 1'});
 // No file at the configured path, and a program that is no browser (Node exits on Chromium's switches).
 for(const [path,cause] of [[join(tmpdir(),'hoa-tri-no-browser','msedge.exe'),/Không có trình duyệt ở /u],[process.execPath,/Failed to launch the browser process/u]]){
  process.env.CHROMIUM_EXECUTABLE_PATH=path;logs.length=0;
  const answer=await fetch(origin+'/render',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body});
  assert.equal(answer.status,500,path);
  assert.deepEqual(await answer.json(),{error:'Dịch vụ PDF chưa mở được trình duyệt để dựng bản PDF tiếng Việt. Hãy thử xuất lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.',code:'browser'});
  assert.match(logs.join('\n'),cause);
 }
 await until(()=>profiles().every(name=>before.has(name)),15000).catch(()=>assert.fail(`browser profiles left behind: ${profiles().filter(name=>!before.has(name)).join(', ')}`));
 // Failures of a browser that did start are told apart from the engine's own errors, which pass unchanged.
 const timeout=browserFailure(Object.assign(new Error('Navigation timeout of 30000 ms exceeded'),{name:'TimeoutError'}),3);
 assert.equal(timeout.code,'timeout');assert.match(timeout.message,/^Xuất PDF tiếng Việt vượt thời gian cho phép/u);
 for(const broken of [Object.assign(new Error('Protocol error (Page.printToPDF): Printing failed'),{name:'ProtocolError',code:-32000}),new Error('Target closed'),Object.assign(new Error('x'),{name:'TargetCloseError'})]){
  const mapped=browserFailure(broken,7);assert.equal(mapped.code,'crash',broken.message);assert.match(mapped.message,/^Trình duyệt của dịch vụ PDF dừng giữa chừng khi dựng trang 7\. /u);assert.equal(mapped.cause,broken);
 }
 for(const own of [Object.assign(new Error('Tách PDF vượt thời gian cho phép.'),{code:'timeout'}),overflowError([{page:1,id:'p1-b0',label:'Đoạn 1'}]),new Error('PyMuPDF trả dữ liệu không hợp lệ.')])assert.equal(browserFailure(own,1),own);
});

test('ASCII JSON is JSON.stringify for every value JSON.parse returns, with no character above 127',()=>{
 // Every UTF-16 unit above 127 as \uXXXX: an emoji becomes its two surrogate escapes.
 const escaped=text=>Array.from({length:text.length},(_,i)=>text.charCodeAt(i)<128?text[i]:`\\u${text.charCodeAt(i).toString(16).padStart(4,'0')}`).join('');
 const values=[{a:'空间向量 Việt Nam “x” \\ \n\t\u0001\u007f',b:[1,-0,1.5e300,null,true,false,'😀',{}],c:{d:[[]],e:''}},'𝒙\ud800 lone',[undefined,()=>1,Symbol('s')],{skip:undefined,fn(){},n:NaN,i:Infinity,date:new Date(0),nested:{toJSON:()=>({x:'é'})}},0,'',null];
 for(const value of values){const text=asciiJson(value);assert.deepEqual(asciiJsonBytes(value),new TextEncoder().encode(text),'the bytes are the text, written piece by piece');assert.equal(text,escaped(JSON.stringify(value)));assert.doesNotMatch(text,/[^\x00-\x7f]/u);assert.deepEqual(JSON.parse(text),JSON.parse(JSON.stringify(value)));}
 const long='数'.repeat(10000)+'a'.repeat(5000);assert.equal(JSON.parse(asciiJson({long})).long,long);
});

test('The build version: hashes of the shared layout checks and of the service, the same for CRLF and LF checkouts',()=>{
 const version=buildVersion();assert.match(version.layout,/^[a-f\d]{16}$/u);assert.match(version.service,/^[a-f\d]{16}$/u);assert.notEqual(version.layout,version.service);
 assert.equal(layoutVersion(),version.layout);assert.deepEqual(LAYOUT_FILES,['frontend/pdf-box-layout.js','frontend/math-text.js']);
 // Every file the hash reads is in the repository and in the image (the service folder and the two layout files).
 const docker=read('services/pdf-layout/Dockerfile');
 for(const file of SERVICE_FILES){assert.ok(existsSync(join(root,file)),file);assert.ok(file.startsWith('services/pdf-layout/')||docker.includes(`COPY ${file} `),file);}
 const dir=mkdtempSync(join(tmpdir(),'hoa-tri-version-'));
 try{
  for(const [name,ending] of [['lf','\n'],['crlf','\r\n']]){mkdirSync(join(dir,name,'frontend'),{recursive:true});for(const file of LAYOUT_FILES)writeFileSync(join(dir,name,file),`${file}${ending}second line${ending}`);}
  assert.equal(filesHash(LAYOUT_FILES,join(dir,'lf')),filesHash(LAYOUT_FILES,join(dir,'crlf')));assert.equal(layoutVersion(join(dir,'lf')),filesHash(LAYOUT_FILES,join(dir,'lf')));
  assert.equal(buildVersion(join(dir,'lf')),null,'a copy without the service files has no build version');assert.equal(layoutVersion(join(dir,'missing')),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Python stand-ins: a stopped job kills its process, a slow one times out, and failures carry their kind',async()=>{
 const node=process.execPath,dir=mkdtempSync(join(tmpdir(),'hoa-tri-engine-'));
 try{
  // The stand-in writes its process id to a file, then waits: only a kill ends it.
  const hang=file=>['-e','require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',file];
  const controller=new AbortController(),job=pythonOperation({pages:'1'},{signal:controller.signal,command:node,args:hang(join(dir,'stopped')),timeoutMs:60000}).catch(error=>error);
  await until(()=>existsSync(join(dir,'stopped')));const pid=Number(readFileSync(join(dir,'stopped'),'utf8'));assert.ok(alive(pid));
  controller.abort();assert.equal((await job).code,'aborted');await until(()=>!alive(pid));
  const timed=await pythonOperation({pages:'1'},{command:node,args:hang(join(dir,'slow')),timeoutMs:500}).catch(error=>error);
  assert.equal(timed.code,'timeout');assert.match(timed.message,/vượt thời gian cho phép/u);await until(()=>!alive(Number(readFileSync(join(dir,'slow'),'utf8'))));
  // A signal already given never starts a process; a deadline that passed reads as a timeout.
  const given=new AbortController();given.abort();assert.equal((await pythonOperation({},{signal:given.signal,command:'does-not-exist'}).catch(error=>error)).code,'aborted');
  const deadline=AbortSignal.timeout(1);await until(()=>deadline.aborted);assert.equal((await pythonOperation({},{signal:deadline,command:'does-not-exist'}).catch(error=>error)).code,'timeout');
  const answered=await pythonOperation({pages:'1'},{command:node,args:['-e','let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify({echo:JSON.parse(s)})))']});
  assert.deepEqual(answered,{echo:{pages:'1'}});
  const memory=await pythonOperation({},{command:node,args:['-e','process.stdout.write(JSON.stringify({error:"Không đủ bộ nhớ để xử lý các trang đã chọn. Hãy chọn ít trang hơn cho mỗi lượt."}));process.exitCode=1']}).catch(error=>error);
  assert.equal(memory.code,'memory');assert.match(memory.message,/Không đủ bộ nhớ/u);
 }finally{rmSync(dir,{recursive:true,force:true});}
 assert.equal(pythonFailure({code:null,signal:'SIGKILL'}).code,'memory');assert.equal(pythonFailure({code:0xC0000017}).code,'memory');
 assert.equal(pythonFailure({code:null,signal:'SIGSEGV'}).code,'crash');assert.equal(pythonFailure({code:0xC0000005}).code,'crash');
 assert.equal(pythonFailure({killedForSize:true}).code,'too_large');assert.equal(pythonFailure({timedOut:true}).code,'timeout');
 assert.equal(pythonFailure({code:1,stdout:JSON.stringify({error:'Trang 3: ảnh hỏng.'})}).code,null);
 assert.equal(pythonFailure({code:1,stderr:'Traceback (most recent call last):\nMemoryError'}).code,'memory');
 // extract.py's own answer to a MemoryError is recognised: the two files must not drift apart.
 const message=/isinstance\(error, MemoryError\):\s*return "([^"]+)"/u.exec(read('services/pdf-layout/extract.py'))?.[1];
 assert.ok(message,'extract.py still answers a MemoryError with a message');assert.equal(pythonFailure({code:1,stdout:JSON.stringify({error:message})}).code,'memory');
});

// The real entry point, as Docker runs it, with Node standing in for Python.
async function startService(t,env={}){
 const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
 const dir=mkdtempSync(join(tmpdir(),'hoa-tri-service-')),pids=join(dir,'pids');
 const {NODE_TEST_CONTEXT,...inherited}=process.env;void NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,[join(root,'services/pdf-layout/server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...inherited,PDF_LAYOUT_SERVICE_TOKEN:TOKEN,PORT:String(port),PDF_LAYOUT_HOST:'127.0.0.1',PDF_PYTHON:process.execPath,NODE_OPTIONS:`--import=${pathToFileURL(join(root,'backend/test-support/fake-python.mjs')).href}`,FAKE_PYTHON:'hang',FAKE_PYTHON_PIDS:pids,...env}});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(()=>{child.kill();for(const pid of fakes())try{process.kill(pid);}catch{}rmSync(dir,{recursive:true,force:true});});
 const fakes=()=>existsSync(pids)?readFileSync(pids,'utf8').split(/\s+/u).filter(Boolean).map(Number):[];
 const origin=`http://127.0.0.1:${port}`;await until(async()=>(await fetch(origin+'/health',{headers:auth}).catch(()=>null))?.ok,15000).catch(error=>{throw new Error(`${error.message}: ${output}`);});
 return {origin,fakes,output:()=>output};
}

test('node services/pdf-layout/server.mjs: busy answers carry Retry-After, and a request whose caller left kills its Python',async t=>{
 const service=await startService(t);
 // One after the other, so the first fake Python is the first request's.
 const callers=[new AbortController(),new AbortController()],held=[];
 for(const caller of callers){held.push(extract(service.origin,{signal:caller.signal}).catch(error=>error));await until(()=>service.fakes().length===held.length);}
 const busy=await extract(service.origin);assert.equal(busy.status,503);assert.equal(busy.headers.get('Retry-After'),'20');assert.equal((await busy.json()).code,'busy');
 const [first]=service.fakes();assert.ok(alive(first));
 callers[0].abort();await held[0];
 // The fake Python of the abandoned request is killed and its place taken by the next request.
 await until(()=>!alive(first));
 const next=new AbortController(),nextJob=extract(service.origin,{signal:next.signal}).catch(error=>error);await until(()=>service.fakes().length===3);
 const health=await (await fetch(service.origin+'/health',{headers:auth})).json();assert.equal(health.active,2);assert.match(health.version.layout,/^[a-f\d]{16}$/u);
 callers[1].abort();next.abort();await Promise.all([held[1],nextJob]);
 await until(()=>service.fakes().every(pid=>!alive(pid)));
});

test('node services/pdf-layout/server.mjs answers an extraction from the fake Python with an ASCII JSON document',async t=>{
 const service=await startService(t,{FAKE_PYTHON:'echo',PDF_LAYOUT_JOBS:'1'});
 const response=await extract(service.origin),text=await response.text();
 assert.equal(response.status,200,text);assert.doesNotMatch(text,/[^\x00-\x7f]/u);assert.equal(JSON.parse(text).document.pages[0].blocks[0].source,'空间向量。');
 assert.equal((await (await fetch(service.origin+'/health',{headers:auth})).json()).jobs,1);
});

test('The image health check restarts a service that failed several checks in a row, and never a healthy one',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hoa-tri-health-')),file=join(dir,'failures');let restarts=0,up=true;
 try{
  const fetch=async(url,options)=>{assert.equal(options.headers.authorization,`Bearer ${TOKEN}`);if(!up)throw new TypeError('fetch failed');return new Response('{}',{status:200});};
  const check=(limit=4)=>healthCheck({url:'http://127.0.0.1:8091/health',token:TOKEN,limit,file,fetch,restart:()=>restarts++});
  assert.equal(await check(),0);assert.equal(existsSync(file),false);
  up=false;for(let i=1;i<=3;i++){assert.equal(await check(),1);assert.equal(readFileSync(file,'utf8'),String(i));}
  assert.equal(restarts,0);up=true;assert.equal(await check(),0);assert.equal(existsSync(file),false,'a success starts the count again');
  up=false;for(let i=0;i<4;i++)assert.equal(await check(),1);assert.equal(restarts,1);assert.equal(existsSync(file),false);
  for(let i=0;i<10;i++)await check(0);assert.equal(restarts,1,'0 turns the restart off');
  rmSync(file);assert.equal(await healthCheck({url:'http://x/health',token:TOKEN,file,fetch:async()=>new Response('{}',{status:401}),restart:()=>restarts++}),1,'a refused token is a failed check');
 }finally{rmSync(dir,{recursive:true,force:true});}
 const compose=read('deploy/pdf-layout/docker-compose.yml'),docker=read('services/pdf-layout/Dockerfile');
 assert.match(docker,/^HEALTHCHECK .*"services\/pdf-layout\/healthcheck\.mjs","\/health","PDF_LAYOUT_SERVICE_TOKEN"\]$/mu);
 assert.match(compose,/healthcheck:\n\s+test: \["CMD", "node", "services\/pdf-layout\/healthcheck\.mjs", "\/health", "PDF_LAYOUT_SERVICE_TOKEN"\]/u);
 assert.match(compose,/restart: unless-stopped/u);assert.match(compose,/init: true/u);
});

// Only where Edge is installed (the owner's and recipients' machines); CI checks the same in the PDF image smoke test.
const edge=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(path=>existsSync(path));
test('An export stopped midway closes its browser at once, and one past its deadline says it ran out of time',{skip:edge?false:'needs Microsoft Edge on Windows',timeout:120000},async t=>{
 const {renderDocument}=await import('../services/pdf-layout/engine.mjs');
 const saved=process.env.PDF_PYTHON;process.env.PDF_PYTHON='hoa-tri-no-python-in-this-test';t.after(()=>{if(saved===undefined)delete process.env.PDF_PYTHON;else process.env.PDF_PYTHON=saved;});
 const document={version:1,pages:Array.from({length:20},(_,i)=>({...page(),number:i+1,blocks:[{id:`p${i+1}-b0`,source:'空间向量。',box:[20,20,200,80],fontSize:12}]}))};
 const translations=document.pages.map(entry=>({id:entry.blocks[0].id,translation:'Vectơ trong không gian.'}));
 const profiles=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('puppeteer_dev_chrome_profile-'));
 const before=new Set(profiles()),controller=new AbortController(),started=Date.now();
 const render=renderDocument(document,translations,{signal:controller.signal,deadlineMs:200000}).catch(error=>error);
 // Stopped once the browser runs: its profile folder exists from the launch until the browser has exited.
 await until(()=>profiles().some(name=>!before.has(name)),30000);const profile=profiles().find(name=>!before.has(name));
 controller.abort();const stopped=await render;
 assert.equal(stopped.code,'aborted',stopped.stack);assert.ok(Date.now()-started<60000);
 await until(()=>!existsSync(join(tmpdir(),profile)),15000);
 const late=await renderDocument(document,translations,{deadlineMs:1}).catch(error=>error);
 assert.equal(late.code,'timeout');assert.match(late.message,/vượt thời gian cho phép/u);
 assert.deepEqual(profiles().filter(name=>!before.has(name)),[],'no browser profile is left behind');
});

test('Production renders with Liberation Serif (Times New Roman widths, every Vietnamese letter); PDF_FONT_PATH still wins',async t=>{
 const docker=read('services/pdf-layout/Dockerfile'),{fontPath,LINUX_FONTS}=await import('../services/pdf-layout/engine.mjs');
 assert.match(docker,/apt-get install[^\n]*\bfonts-liberation2\b/u);assert.match(docker,/fontPath\(\)[^\n]*LiberationSerif-Regular\.ttf/u);
 assert.match(LINUX_FONTS[0],/liberation2\/LiberationSerif-Regular\.ttf$/u);assert.match(LINUX_FONTS.at(-1),/DejaVuSerif\.ttf$/u);
 const saved={path:process.env.PDF_FONT_PATH,platform:Object.getOwnPropertyDescriptor(process,'platform')},dir=mkdtempSync(join(tmpdir(),'hoa-tri-font-'));
 t.after(()=>{if(saved.path===undefined)delete process.env.PDF_FONT_PATH;else process.env.PDF_FONT_PATH=saved.path;Object.defineProperty(process,'platform',saved.platform);rmSync(dir,{recursive:true,force:true});});
 const own=join(dir,'Own.ttf');writeFileSync(own,'font');process.env.PDF_FONT_PATH=own;assert.equal(fontPath(),own);
 // Only a file that is there is named: never a path the service cannot read.
 process.env.PDF_FONT_PATH=join(dir,'missing.ttf');assert.equal(fontPath(),null);
 delete process.env.PDF_FONT_PATH;Object.defineProperty(process,'platform',{...saved.platform,value:'linux'});
 assert.equal(fontPath(),LINUX_FONTS.find(path=>existsSync(path))||null);
});

test('Without its font file the service names none: /health says null, /font and an export answer code font, and the image build stops',async t=>{
 const {fontPath,fontCss}=await import('../services/pdf-layout/engine.mjs'),dir=mkdtempSync(join(tmpdir(),'hoa-tri-font-')),saved=process.env.PDF_FONT_PATH;
 t.after(()=>{if(saved===undefined)delete process.env.PDF_FONT_PATH;else process.env.PDF_FONT_PATH=saved;rmSync(dir,{recursive:true,force:true});});
 const liberation=join(dir,'liberation2','LiberationSerif-Regular.ttf').replaceAll('\\','/');process.env.PDF_FONT_PATH=liberation;
 assert.equal(fontPath(),null);
 const message='Dịch vụ PDF đang thiếu phông chữ để dựng bản PDF tiếng Việt, nên chưa xuất được PDF. Hãy báo quản trị viên; bản dịch vẫn được lưu trong Lịch sử dịch.';
 const failed=await fontCss().catch(error=>error);assert.equal(failed.code,'font');assert.equal(failed.message,message);assert.match(String(failed.cause?.message),/LiberationSerif-Regular\.ttf/u);
 // The service with its real engine: no browser starts, the log names the file looked for.
 const logs=[],origin=await listen(t,serviceHandler({token:TOKEN,version:null,log:line=>logs.push(line)}).handler);
 assert.equal((await (await fetch(origin+'/health',{headers:auth})).json()).font,null,'/health never names a font that is not there');
 const font=await fetch(origin+'/font',{headers:auth});assert.equal(font.status,500);assert.deepEqual(await font.json(),{error:message,code:'font'});
 const render=await fetch(origin+'/render',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({document:{version:1,pages:[page()]},translations:[{id:'p1-b0',translation:'Vectơ trong không gian.'}],title:'Bài 1'})});
 assert.equal(render.status,500);assert.deepEqual(await render.json(),{error:message,code:'font'});
 assert.match(logs.join('\n'),/\/font .*no font file: .*LiberationSerif-Regular\.ttf/u);assert.match(logs.join('\n'),/\/render .*no font file: /u);
 // The image build runs the same fontPath(): it stops without the file, and with a font that is not Liberation Serif.
 const check=read('services/pdf-layout/Dockerfile').split(/\r?\n/u).map(line=>/^RUN node -e "(.+)"$/u.exec(line)?.[1]).find(code=>code?.includes('fontPath()'));assert.ok(check,'the Dockerfile checks the font');
 const {NODE_TEST_CONTEXT,...inherited}=process.env;void NODE_TEST_CONTEXT;
 const build=path=>spawnSync(process.execPath,['-e',check],{cwd:root,windowsHide:true,encoding:'utf8',env:{...inherited,PDF_FONT_PATH:path}});
 const missing=build(liberation);assert.equal(missing.status,1,missing.stdout+missing.stderr);assert.match(missing.stdout,/PDF font: none/u);
 mkdirSync(join(dir,'liberation2'));writeFileSync(liberation,'font');const dejavu=join(dir,'DejaVuSerif.ttf').replaceAll('\\','/');writeFileSync(dejavu,'font');
 assert.equal(build(dejavu).status,1,'another font stops the build too');
 const present=build(liberation);assert.equal(present.status,0,present.stdout+present.stderr);
 // Once the file is there, it is named and read.
 assert.equal(fontPath(),liberation);assert.match(await fontCss(),/^@font-face\{font-family:HoaTriPDF;src:url\(data:font\/ttf;base64,Zm9udA==\)/u);
});

test('An all-pages extraction (a refresh) may use the whole time limit; any other keeps the service\'s own budget',async t=>{
 const saved=process.env.PDF_EXTRACT_SECONDS;process.env.PDF_EXTRACT_SECONDS='170';t.after(()=>{if(saved===undefined)delete process.env.PDF_EXTRACT_SECONDS;else process.env.PDF_EXTRACT_SECONDS=saved;});
 const node=process.execPath,echo=['-e','process.stdout.write(JSON.stringify({seconds:process.env.PDF_EXTRACT_SECONDS??null}))'];
 assert.deepEqual(await pythonOperation({pages:'1'},{command:node,args:echo}),{seconds:'170'});
 assert.deepEqual(await pythonOperation({pages:'1'},{command:node,args:echo,allPages:true}),{seconds:'225'},'240 s hard stop, 15 s to write the answer');
 assert.deepEqual(await pythonOperation({pages:'1'},{command:node,args:echo,allPages:true,timeoutMs:100000}),{seconds:'85'});
 // The service hands the Worker's X-PDF-All-Pages on to the job.
 const seen=[],operations={pythonOperation:async(payload,options)=>{seen.push(options.allPages);return extracted();},renderDocument:async()=>({}),fontCss:async()=>''};
 const origin=await listen(t,serviceHandler({token:TOKEN,operations,version:null,log:()=>{}}).handler);
 assert.equal((await extract(origin)).status,200);
 assert.equal((await extract(origin,{headers:{...auth,'Content-Type':'application/pdf','X-PDF-Pages':'1-3','X-PDF-All-Pages':'1'}})).status,200);
 assert.deepEqual(seen,[false,true]);
});

// A folder link to the repository's services folder, as a release layout (/srv/app/current) or a Windows junction makes
// one. Removed as a link only: its target is never touched.
function linkedServices(t){
 const dir=mkdtempSync(join(tmpdir(),'hoa-tri-link-')),link=join(dir,'services');symlinkSync(join(root,'services'),link,'junction');
 t.after(()=>{
  try{unlinkSync(link);}catch{try{rmdirSync(link);}catch{}}
  let gone=false;try{lstatSync(link);}catch{gone=true;}
  if(gone)rmSync(dir,{recursive:true,force:true});
 });
 return {dir,link};
}
const freePort=async()=>{const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const {port}=probe.address();await new Promise(done=>probe.close(done));return port;};
test('server.mjs and healthcheck.mjs run as programs also when started through a symlinked or junction folder',async t=>{
 const {dir,link}=linkedServices(t),{NODE_TEST_CONTEXT,...inherited}=process.env;void NODE_TEST_CONTEXT;
 const port=await freePort(),child=spawn(process.execPath,[join(link,'pdf-layout','server.mjs')],{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...inherited,PDF_LAYOUT_SERVICE_TOKEN:TOKEN,PORT:String(port),PDF_LAYOUT_HOST:'127.0.0.1'}});
 let output='',exited=null;child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('exit',(code,signal)=>{exited=code??signal;});
 t.after(()=>{if(exited===null)child.kill();});
 await until(async()=>exited!==null||(await fetch(`http://127.0.0.1:${port}/health`,{headers:auth}).catch(()=>null))?.ok,15000).catch(error=>{throw new Error(`${error.message}: ${output}`);});
 assert.equal(exited,null,`server.mjs ended at once (code ${exited}) instead of serving: ${output}`);assert.match(output,/PDF layout service ready/u);
 child.kill();await until(()=>exited!==null);
 // The health check really asks: with nothing listening on its port it fails, through the link as through the real path.
 const closed=await freePort(),temp=join(dir,'temp');mkdirSync(temp);
 const check=script=>spawnSync(process.execPath,[script,'/health','PDF_LAYOUT_SERVICE_TOKEN'],{cwd:dir,windowsHide:true,env:{...inherited,PORT:String(closed),PDF_LAYOUT_SERVICE_TOKEN:TOKEN,PDF_HEALTH_RESTART_AFTER:'0',TMP:temp,TEMP:temp,TMPDIR:temp}}).status;
 assert.equal(check(join(link,'pdf-layout','healthcheck.mjs')),1,'through the link');assert.equal(check(join(root,'services','pdf-layout','healthcheck.mjs')),1,'through the real path');
});
