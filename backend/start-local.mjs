// Starts Hoa Trí on this machine in one window: the PDF layout service and the web app (wrangler dev), then opens the
// browser. `npm start` only starts; start.cmd passes --launcher to update the code, install packages and run setup first.
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {get} from 'node:http';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
const windows=process.platform==='win32',launcher=process.argv.includes('--launcher');
function fail(message){console.error(`\nLỖI: ${message}`);process.exit(1);}
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))fail(`Cần Node.js 22.13 trở lên (máy đang dùng ${process.version}). Cài bản LTS mới ở https://nodejs.org (hoặc "winget upgrade OpenJS.NodeJS.LTS") rồi chạy lại.`);
const run=(command,args,options={})=>spawnSync(command,args,{stdio:'inherit',windowsHide:true,...options});
// npm itself is a script next to node; running it through node avoids spawning npm.cmd through a shell.
const npmCli=process.env.npm_execpath||[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),join(dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js')].find(existsSync);
const npm=args=>(npmCli?run(process.execPath,[npmCli,...args]):run(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`npm ${args.join(' ')}`])).status;
// .dev.vars read the way services/pdf-layout/local.mjs reads it (the last line wins); '' when the file or the key is missing.
function devVar(key){let text='';try{text=readFileSync('.dev.vars','utf8');}catch{}return [...text.matchAll(new RegExp(`^${key}=([^\\r\\n]*)`,'gmu'))].at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';}
// The PDF service listens on the port of PDF_LAYOUT_SERVICE_URL, wrangler dev on 8787 (wrangler.jsonc sets no "dev" port;
// one added there wins).
function pdfPort(){try{return new URL(devVar('PDF_LAYOUT_SERVICE_URL')||'http://127.0.0.1:8091').port||'8091';}catch{return '8091';}}
function webPort(){try{return /"dev"\s*:\s*\{[^{}]*?"port"\s*:\s*(\d+)/u.exec(readFileSync('wrangler.jsonc','utf8'))?.[1]||'8787';}catch{return '8787';}}

let setupFailed=false;
if(launcher){
 // A second window cannot work: npm ci cannot replace node_modules while the first one's workerd.exe runs (EPERM), and two
 // wrangler dev would share one local D1. Only Hoa Trí's own answer counts; an error or another program on a port does not.
 // node:http, not fetch: on Windows, process.exit() right after two fetch() calls aborts Node (a libuv assertion in async.c).
 const answers=(url,headers,test)=>new Promise(resolve=>{
  const request=get(url,{headers,agent:false},response=>{let text='';response.setEncoding('utf8').on('data',chunk=>{text+=chunk;if(text.length>65536)request.destroy();}).on('end',()=>{try{resolve(Boolean(test(JSON.parse(text))));}catch{resolve(false);}}).on('error',()=>resolve(false)).on('close',()=>resolve(false));});
  request.on('error',()=>resolve(false));setTimeout(()=>request.destroy(),1500).unref();
 }).catch(()=>false);
 const web=`http://127.0.0.1:${webPort()}`,[webUp,pdfUp]=await Promise.all([answers(`${web}/api/health`,{},body=>body.service==='hoa-tri'),answers(`http://127.0.0.1:${pdfPort()}/health`,{Authorization:`Bearer ${devVar('PDF_LAYOUT_SERVICE_TOKEN')}`},body=>body.ok===true&&body.engine==='pymupdf-puppeteer')]);
 if(webUp||pdfUp)fail(`Hoa Trí đang chạy ở một cửa sổ khác${webUp?`: ${web}/#account`:` (dịch vụ PDF của nó đang dùng cổng ${pdfPort()}).`}\nDùng cửa sổ đó, hoặc tắt nó (bấm Ctrl+C trong cửa sổ đó) rồi chạy lại. Không thấy cửa sổ nào thì khởi động lại máy.`);
 // A git clone takes the latest code each time; offline, a ZIP copy or local edits simply keep the current version. git
 // never waits for a password or a stalled download: it gives up and the current version runs.
 if(existsSync('.git')){
  console.log('Đang lấy bản code mới nhất (git pull)…');
  const pull=run('git',['-c','http.lowSpeedLimit=1000','-c','http.lowSpeedTime=20','pull','--ff-only','--quiet'],{stdio:['ignore','inherit','inherit'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
  if(pull.status!==0)console.log(pull.error?.code==='ENOENT'?'Máy chưa có lệnh git nên không tự cập nhật được code; vẫn chạy bản hiện có.':'Không cập nhật được code mới nên vẫn chạy bản hiện có. Thường do máy chưa có Internet, hoặc tệp trong thư mục dự án đã bị sửa trên máy này (git không ghi đè những thay đổi đó).');
 }
 const installed='node_modules/.package-lock.json';
 if(!existsSync(installed)||!existsSync('node_modules/wrangler')||statSync(installed).mtimeMs<statSync('package-lock.json').mtimeMs){console.log('\nĐang cài thư viện (npm ci, lần đầu mất khoảng 1 phút)…');if(npm(['ci'])!==0)fail('Cài thư viện (npm ci) thất bại. Thường do: máy chưa có Internet, hoặc mạng cần proxy ("npm config set proxy …"); Hoa Trí còn mở ở một cửa sổ khác; phần mềm diệt virus hoặc OneDrive đang khóa thư mục node_modules (nên để dự án ngoài OneDrive, ví dụ C:\\src\\chinese-translator). Xử lý xong thì chạy lại.');}
 // Setup skips finished steps, so it also applies new migrations and vendor files after an update. It exits with 1 only
 // after printing a LỖI line; what the app cannot start without is checked below either way.
 setupFailed=run(process.execPath,['backend/setup.mjs','--launcher']).status!==0;
}
// What the app cannot start without, and what creates it.
const missing=[['node_modules/wrangler','cài bằng "npm ci"'],['frontend/vendor/pdf.mjs','do bước 2 của cài đặt tạo ra (chạy riêng bước này: "npm run prepare:vendor")'],['.dev.vars','do bước 6 của cài đặt tạo ra ("npm run setup")']].filter(([file])=>!existsSync(file));
if(missing.length)fail(`Chưa khởi động được vì còn thiếu:\n${missing.map(([file,source])=>`  - ${file}: ${source}`).join('\n')}\n${setupFailed?'Nguyên nhân nằm ở các dòng LỖI của phần cài đặt phía trên: sửa theo hướng dẫn ở đó rồi chạy lại.':'Chạy lệnh ghi bên cạnh trong thư mục dự án (trên Windows có thể bấm đúp start.cmd để làm tất cả) rồi chạy lại.'}`);
if(setupFailed)console.log('\nApp vẫn khởi động; phần liên quan đến các LỖI ở trên có thể chưa dùng được.\n');
// npm start runs no setup: like npm run dev (predev), it does not start on a local database a migration behind the code.
// The check reads only and prints its own LỖI line; start.cmd's setup applies the migrations first.
if(!launcher&&existsSync('backend/check-migrations.mjs')&&run(process.execPath,['--no-warnings','backend/check-migrations.mjs','--command','npm start']).status===1)process.exit(1);

const children=[];let webUrl='',pdfState='starting',stopping=false,announced=false,portBusy=false;
function stop(code=0){
 stopping=true;
 // wrangler runs workerd as a child process: stop whole process trees so no server keeps the ports.
 for(const child of children)if(child.exitCode===null){if(windows)spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else child.kill('SIGTERM');}
 setTimeout(()=>process.exit(code),300);
}
function start(name,args,onLine,onExit){
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,FORCE_COLOR:'0'}});children.push(child);
 let pending='';
 const feed=chunk=>{pending+=chunk;const lines=pending.split(/\r?\n/u);pending=lines.pop();for(const raw of lines){const line=raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu,'');if(line.trim())console.log(`[${name}] ${line}`);onLine(line);}};
 child.stdout.setEncoding('utf8').on('data',feed);child.stderr.setEncoding('utf8').on('data',feed);
 // 'exit' can come before the last output lines: waiting for them (1 s at most) keeps the message about the exit last.
 const drained=Promise.all([child.stdout,child.stderr].map(stream=>new Promise(resolve=>stream.once('close',resolve))));
 child.on('exit',(code,signal)=>Promise.race([drained,new Promise(resolve=>setTimeout(resolve,1000))]).then(()=>{if(pending)feed('\n');if(!stopping)onExit(code??signal);}));
}
function openBrowser(url){
 const [command,args]=windows?['cmd.exe',['/d','/c','start','',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
 spawn(command,args,{stdio:'ignore',detached:true,windowsHide:true}).on('error',()=>{}).unref();
}
function announce(){
 if(announced||!webUrl||pdfState==='starting')return;announced=true;const url=`${webUrl}/#account`;
 const note={stopped:'\n Chế độ "Giữ bố cục PDF" chưa dùng được: dịch vụ PDF đã dừng (xem CẢNH BÁO ở trên).',slow:'\n Dịch vụ PDF (chế độ "Giữ bố cục PDF") còn đang khởi động; các phần khác dùng được ngay.'}[pdfState]||'';
 console.log(`\n================================================================\n Hoa Trí đang chạy: ${url}\n Lần đầu: "Tạo tài khoản", rồi mở "Xưởng dịch học tập".${note}\n Giữ cửa sổ này mở trong lúc dùng; bấm Ctrl+C để tắt.\n================================================================\n`);
 if(!process.env.HOATRI_NO_BROWSER)openBrowser(url);
}
process.on('SIGINT',()=>stop(0));process.on('SIGTERM',()=>stop(0));
// Only "Giữ bố cục PDF" needs the PDF service: the browser opens once the web app is ready, without waiting for a PDF
// service that stopped or still starts after 20 s (first Python start, an antivirus scan).
setTimeout(()=>{if(pdfState==='starting'){pdfState='slow';announce();}},20000).unref();
start('PDF',['services/pdf-layout/local.mjs'],line=>{
 if(line.includes('PDF layout service ready')){if(announced&&pdfState==='slow')console.log('\nDịch vụ PDF đã sẵn sàng: dùng được chế độ "Giữ bố cục PDF".\n');pdfState='ready';announce();}
 if(line.includes('EADDRINUSE'))portBusy=true;
},code=>{
 pdfState='stopped';const port=pdfPort(),cause=portBusy?`\nCổng ${port} của dịch vụ PDF đang bận: có thể Hoa Trí đang chạy ở một cửa sổ khác (tắt cửa sổ đó rồi chạy lại), hoặc một chương trình khác đang dùng cổng này (sửa dòng PDF_LAYOUT_SERVICE_URL trong tệp .dev.vars sang cổng khác, ví dụ "PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:${Number(port)+1}", rồi chạy lại).`:'';
 console.warn(`\nCẢNH BÁO: dịch vụ PDF đã dừng (mã ${code}) nên chế độ "Giữ bố cục PDF" không dùng được cho tới khi sửa lỗi${portBusy?'':' (xem các dòng [PDF] ở trên)'} rồi chạy lại; các phần khác của app vẫn chạy.${cause}`);announce();
});
start('WEB',['node_modules/wrangler/bin/wrangler.js','dev','--ip','127.0.0.1'],line=>{const ready=/Ready on (https?:\/\/[^\s]+)/u.exec(line);if(ready){webUrl=ready[1].replace(/\/+$/u,'');announce();}},code=>{console.error(`\n[WEB] đã dừng (mã ${code}). Xem thông báo ở trên, đóng cửa sổ này rồi chạy lại.`);stop(1);});
