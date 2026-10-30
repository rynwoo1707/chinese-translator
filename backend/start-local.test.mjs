// start-local.mjs runs in a throw-away copy of the project: fake wrangler, PDF service and setup, a .dev.vars whose PDF port
// nothing listens on, and HOATRI_NO_BROWSER. No git remote, npm, browser or app port (8787, 8091) is used: the launcher's
// "already running" check talks to fake services on ports the system picks. No process a test starts outlives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';

const windows=process.platform==='win32',TOKEN='f00d'.repeat(16),START=readFileSync(new URL('./start-local.mjs',import.meta.url),'utf8');
const git=spawnSync('git',['--version'],{stdio:'ignore'}).status===0;
// Each fake service prints its pid, so a test can check that none is left running.
const WEB_READY=`console.log('pid='+process.pid);console.log('[wrangler:info] Ready on http://127.0.0.1:48787');`;
const FAKE={
 web:`${WEB_READY}setInterval(()=>{},60000);`,
 webCrash:`${WEB_READY}setTimeout(()=>{console.error('X [ERROR] fake wrangler stopped');process.exit(1);},700);`,
 pdf:`console.log('pid='+process.pid);console.log('PDF layout service ready (PyMuPDF + Puppeteer).');setInterval(()=>{},60000);`,
 pdfPortBusy:`console.log('pid='+process.pid);console.error('Error: listen EADDRINUSE: address already in use');process.exit(1);`,
 pdfCrash:`console.log('pid='+process.pid);console.error('Error: Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự.');process.exit(3);`,
 setup:`import {writeFileSync} from 'node:fs';writeFileSync('setup-ran','');console.log('[2/8] Thư viện giao diện (frontend/vendor)');console.error('\\nLỖI: giả lập lỗi của bước 2.');process.exitCode=1;`
};
const runs=[],folders=[];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(check,ms=20000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)return false;await pause(50);}return true;}
// A run that should end but goes on (a launcher that starts the app after all) fails in 30 s instead of hanging the suite.
const ended=run=>Promise.race([run.exited,new Promise(done=>setTimeout(done,30000,'still running after 30 s').unref())]);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const pids=(run,name='PDF|WEB')=>[...run.text.matchAll(new RegExp(`\\[(?:${name})\\] pid=(\\d+)`,'gu'))].map(match=>Number(match[1]));
const killTree=pid=>{if(windows)spawnSync('taskkill',['/pid',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else try{process.kill(-pid,'SIGKILL');}catch{}};
test.after(()=>{
 for(const run of runs){if(run.code===undefined)killTree(run.child.pid);for(const pid of pids(run))if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}}
 for(const dir of folders)rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
async function listen(handler){const server=createServer(handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));return server;}
async function freePort(){const server=await listen(()=>{});const {port}=server.address();await new Promise(done=>server.close(done));return port;}
function write(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}

// The project as start-local.mjs sees it. Launcher tests (setup given) also get an installed node_modules newer than
// package-lock.json, so npm ci never runs, and a wrangler.jsonc dev port, so the running check never looks at 8787.
function project({pdfPort,webPort,web=FAKE.web,pdf=FAKE.pdf,setup=null,without=[],repository=false}){
 const root=mkdtempSync(join(tmpdir(),'hoa-tri-start-'));folders.push(root);
 const files={'backend/start-local.mjs':START,'node_modules/wrangler/bin/wrangler.js':web,'services/pdf-layout/local.mjs':pdf,'frontend/vendor/pdf.mjs':'','.dev.vars':`PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:${pdfPort}\nPDF_LAYOUT_SERVICE_TOKEN=${TOKEN}\n`};
 if(setup)Object.assign(files,{'backend/setup.mjs':setup,'package-lock.json':'{}','node_modules/.package-lock.json':'{}','wrangler.jsonc':`{\n  // test project\n  "name": "start-local-test",\n  "dev": {"ip": "127.0.0.1", "port": ${webPort}}\n}\n`});
 for(const [file,text] of Object.entries(files))if(!without.includes(file))write(join(root,file),text);
 if(setup){const later=new Date(Date.now()+3600000);utimesSync(join(root,'node_modules/.package-lock.json'),later,later);}
 if(repository)spawnSync('git',['init','-q'],{cwd:root,stdio:'ignore'});
 return root;
}
function launch(root,...args){
 const env={...process.env,HOATRI_NO_BROWSER:'1'};delete env.NODE_TEST_CONTEXT;
 // Its own process group on Linux and macOS, so the whole tree can be killed at the end.
 const child=spawn(process.execPath,[join(root,'backend','start-local.mjs'),...args],{cwd:root,env,detached:!windows,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const run={child,text:'',code:undefined};runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.setEncoding('utf8').on('data',chunk=>{run.text+=chunk;});
 run.exited=new Promise(resolve=>child.on('close',code=>{run.code=code;resolve(code);}));
 return run;
}
async function stopTree(run){
 killTree(run.child.pid);assert.notEqual(await ended(run),'still running after 30 s');
 for(const pid of pids(run))assert.ok(await until(()=>!alive(pid),5000),`process ${pid} is still running`);
}

test('npm start names each missing file and what creates it, instead of a generic "not installed"',async()=>{
 const one=launch(project({pdfPort:await freePort(),without:['frontend/vendor/pdf.mjs']}));
 assert.equal(await ended(one),1,one.text);
 assert.ok(one.text.includes('LỖI: Chưa khởi động được vì còn thiếu:\n  - frontend/vendor/pdf.mjs: do bước 2 của cài đặt tạo ra (chạy riêng bước này: "npm run prepare:vendor")\n'),one.text);
 assert.doesNotMatch(one.text,/node_modules\/wrangler:|\.dev\.vars:|Chưa cài đặt xong|\[(PDF|WEB)\]/u);
 const all=launch(project({pdfPort:await freePort(),without:['node_modules/wrangler/bin/wrangler.js','frontend/vendor/pdf.mjs','.dev.vars']}));
 assert.equal(await ended(all),1,all.text);
 for(const text of ['  - node_modules/wrangler: cài bằng "npm ci"\n','  - frontend/vendor/pdf.mjs: do bước 2 của cài đặt','  - .dev.vars: do bước 6 của cài đặt tạo ra ("npm run setup")\n','bấm đúp start.cmd'])assert.ok(all.text.includes(text),`${text}\n${all.text}`);
});

test('npm start does not start on a local database a migration behind the code, names it and how to apply it; once applied it starts',async()=>{
 // As npm run dev's predev: backend/check-migrations.mjs (copied with what it imports) reads the local D1, read only.
 const root=project({pdfPort:await freePort()}),repo=new URL('../',import.meta.url);
 for(const file of ['backend/check-migrations.mjs','backend/deploy.mjs','backend/paddle-assets.mjs','services/pdf-layout/version.mjs','frontend/translation-modes.js'])write(join(root,file),readFileSync(new URL(file,repo),'utf8'));
 write(join(root,'wrangler.jsonc'),'{\n  // test project\n  "name": "start-local-test",\n  "d1_databases": [{"binding": "DB", "database_name": "test", "database_id": "00000000-0000-4000-8000-000000000000", "preview_database_id": "start-local-test", "migrations_dir": "database/migrations"}]\n}\n');
 for(const name of ['0001_first.sql','0002_second.sql'])write(join(root,'database/migrations',name),'SELECT 1;\n');
 const {localDatabase}=await import('./check-migrations.mjs'),{DatabaseSync}=await import('node:sqlite'),{file,table}=localDatabase(root);mkdirSync(dirname(file),{recursive:true});
 const applied=name=>{const db=new DatabaseSync(file);try{db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name);}finally{db.close();}};
 applied('0001_first.sql');
 const stale=launch(root);
 assert.equal(await ended(stale),1,stale.text);
 assert.ok(stale.text.includes('LỖI: cơ sở dữ liệu cục bộ (.wrangler) chưa có 1 migration mà code này cần: 0002_second.sql.\n"npm start" không tự áp migration nên chưa khởi động. Chạy "npm run db:local" rồi chạy lại "npm start", hoặc bấm đúp start.cmd'),stale.text);
 assert.doesNotMatch(stale.text,/\[(PDF|WEB)\]/u);
 applied('0002_second.sql');
 const run=launch(root);
 assert.ok(await until(()=>run.text.includes('bấm Ctrl+C để tắt.')),run.text);
 assert.doesNotMatch(run.text,/LỖI|migration/u);
 await stopTree(run);
});

test('a PDF service that stops (its port is taken) leaves the web app running, with a warning and the banner',async()=>{
 const port=await freePort(),run=launch(project({pdfPort:port,pdf:FAKE.pdfPortBusy}));
 assert.ok(await until(()=>run.text.includes('bấm Ctrl+C để tắt.')),run.text);
 await pause(1000);
 assert.equal(run.code,undefined,`start-local stopped:\n${run.text}`);
 const [web]=pids(run,'WEB');assert.ok(web&&alive(web),run.text);
 assert.ok(run.text.includes(`CẢNH BÁO: dịch vụ PDF đã dừng (mã 1) nên chế độ "Giữ bố cục PDF" không dùng được cho tới khi sửa lỗi rồi chạy lại; các phần khác của app vẫn chạy.\nCổng ${port} của dịch vụ PDF đang bận: có thể Hoa Trí đang chạy ở một cửa sổ khác (tắt cửa sổ đó rồi chạy lại), hoặc một chương trình khác đang dùng cổng này (sửa dòng PDF_LAYOUT_SERVICE_URL trong tệp .dev.vars sang cổng khác, ví dụ "PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:${port+1}", rồi chạy lại).\n`),run.text);
 assert.ok(run.text.includes(' Hoa Trí đang chạy: http://127.0.0.1:48787/#account\n Lần đầu: "Tạo tài khoản", rồi mở "Xưởng dịch học tập".\n Chế độ "Giữ bố cục PDF" chưa dùng được: dịch vụ PDF đã dừng (xem CẢNH BÁO ở trên).\n'),run.text);
 await stopTree(run);
});

test('a PDF service that stops for another reason points at its own lines; the web app keeps running',async()=>{
 const run=launch(project({pdfPort:await freePort(),pdf:FAKE.pdfCrash}));
 assert.ok(await until(()=>run.text.includes('bấm Ctrl+C để tắt.')),run.text);
 assert.ok(run.text.includes('[PDF] Error: Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự.'),run.text);
 assert.ok(run.text.includes('CẢNH BÁO: dịch vụ PDF đã dừng (mã 3) nên chế độ "Giữ bố cục PDF" không dùng được cho tới khi sửa lỗi (xem các dòng [PDF] ở trên) rồi chạy lại; các phần khác của app vẫn chạy.\n'),run.text);
 assert.doesNotMatch(run.text,/đang bận/u);
 assert.equal(run.code,undefined,run.text);
 await stopTree(run);
});

test('the web app stopping stops everything with exit code 1, the PDF service included',async()=>{
 const run=launch(project({pdfPort:await freePort(),web:FAKE.webCrash}));
 assert.equal(await ended(run),1,run.text);
 assert.ok(run.text.includes('[WEB] X [ERROR] fake wrangler stopped'),run.text);
 assert.ok(run.text.includes('[WEB] đã dừng (mã 1). Xem thông báo ở trên, đóng cửa sổ này rồi chạy lại.'),run.text);
 const [pdf]=pids(run,'PDF');assert.ok(pdf,run.text);
 assert.ok(await until(()=>!alive(pdf),5000),'the PDF service is stopped with the web app');
});

test('the launcher stops before git, npm ci and setup when Hoa Trí already answers in another window',async t=>{
 // As services/pdf-layout/server.mjs: /health needs the token of .dev.vars.
 const service=await listen((request,response)=>{const ok=request.url==='/health'&&request.headers.authorization===`Bearer ${TOKEN}`;response.writeHead(ok?200:401,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(ok?{ok:true,engine:'pymupdf-puppeteer',busy:false}:{error:'Unauthorized'}));});
 // As backend/health.js when the local database fails: 503, but still Hoa Trí.
 const app=await listen((request,response)=>{response.writeHead(request.url==='/api/health'?503:404,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify({ok:false,service:'hoa-tri',version:'dev',database:'error',pdfLayout:'configured'}));});
 t.after(()=>{service.close();app.close();});
 const pdfPort=service.address().port,webPort=app.address().port;
 const byService=project({pdfPort,webPort:await freePort(),setup:FAKE.setup,repository:true}),first=launch(byService,'--launcher');
 assert.equal(await ended(first),1,first.text);
 assert.ok(first.text.includes(`LỖI: Hoa Trí đang chạy ở một cửa sổ khác (dịch vụ PDF của nó đang dùng cổng ${pdfPort}).\nDùng cửa sổ đó, hoặc tắt nó (bấm Ctrl+C trong cửa sổ đó) rồi chạy lại.`),first.text);
 const byApp=project({pdfPort:await freePort(),webPort,setup:FAKE.setup,repository:true}),second=launch(byApp,'--launcher');
 assert.equal(await ended(second),1,second.text);
 assert.ok(second.text.includes(`LỖI: Hoa Trí đang chạy ở một cửa sổ khác: http://127.0.0.1:${webPort}/#account\n`),second.text);
 // Both answer, as a whole Hoa Trí window does: still a clean exit code 1 (fetch() made Node abort here on Windows).
 const byBoth=project({pdfPort,webPort,setup:FAKE.setup,repository:true}),third=launch(byBoth,'--launcher');
 assert.equal(await ended(third),1,third.text);
 assert.ok(third.text.includes(`LỖI: Hoa Trí đang chạy ở một cửa sổ khác: http://127.0.0.1:${webPort}/#account\n`),third.text);
 assert.doesNotMatch(third.text,/Assertion failed/u);
 for(const [root,run] of [[byService,first],[byApp,second],[byBoth,third]]){
  assert.ok(!existsSync(join(root,'setup-ran')),'setup must not run');
  assert.doesNotMatch(run.text,/git pull|npm ci|\[(PDF|WEB)\]/u);
 }
});

test('launcher: another program on the ports is not Hoa Trí, a failed git pull keeps the current version, and a setup LỖI that leaves frontend/vendor/pdf.mjs missing is pointed at',async t=>{
 const other=await listen((request,response)=>{response.writeHead(401,{'Content-Type':'application/json'});response.end('{"error":"Unauthorized"}');});
 t.after(()=>other.close());
 const port=other.address().port,root=project({pdfPort:port,webPort:port,setup:FAKE.setup,repository:true,without:['frontend/vendor/pdf.mjs']});
 const run=launch(root,'--launcher');
 assert.equal(await ended(run),1,run.text);
 assert.ok(existsSync(join(root,'setup-ran')),run.text);
 if(git)assert.ok(run.text.includes('Không cập nhật được code mới nên vẫn chạy bản hiện có. Thường do máy chưa có Internet, hoặc tệp trong thư mục dự án đã bị sửa trên máy này'),run.text);
 assert.ok(run.text.includes('LỖI: giả lập lỗi của bước 2.'),run.text);
 assert.ok(run.text.includes('  - frontend/vendor/pdf.mjs: do bước 2 của cài đặt tạo ra'),run.text);
 assert.ok(run.text.includes('Nguyên nhân nằm ở các dòng LỖI của phần cài đặt phía trên: sửa theo hướng dẫn ở đó rồi chạy lại.'),run.text);
 assert.doesNotMatch(run.text,/đang chạy ở một cửa sổ khác|Đang cài thư viện|[Aa]pp vẫn khởi động/u);
});

test('launcher: a setup LỖI that left every needed file in place still starts the app, and says so',async()=>{
 const run=launch(project({pdfPort:await freePort(),webPort:await freePort(),setup:FAKE.setup}),'--launcher');
 assert.ok(await until(()=>run.text.includes('bấm Ctrl+C để tắt.')),run.text);
 assert.ok(run.text.includes('\nApp vẫn khởi động; phần liên quan đến các LỖI ở trên có thể chưa dùng được.\n'),run.text);
 assert.ok(run.text.includes(' Hoa Trí đang chạy: http://127.0.0.1:48787/#account\n Lần đầu: "Tạo tài khoản", rồi mở "Xưởng dịch học tập".\n Giữ cửa sổ này'),`no PDF note when the service is ready:\n${run.text}`);
 assert.equal(pids(run).length,2,run.text);
 await stopTree(run);
});
