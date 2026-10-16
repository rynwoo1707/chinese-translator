// Starts Hoa Trí on this machine in one window: the PDF layout service and the web app (wrangler dev), then opens the
// browser. `npm start` only starts; start.cmd passes --launcher to update the code, install packages and run setup first.
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
const windows=process.platform==='win32';
function fail(message){console.error(`\nLỖI: ${message}`);process.exit(1);}
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))fail(`Cần Node.js 22.13 trở lên (máy đang dùng ${process.version}). Cài bản LTS mới ở https://nodejs.org (hoặc "winget upgrade OpenJS.NodeJS.LTS") rồi chạy lại.`);
const run=(command,args)=>spawnSync(command,args,{stdio:'inherit',windowsHide:true}).status;
// npm itself is a script next to node; running it through node avoids spawning npm.cmd through a shell.
const npmCli=process.env.npm_execpath||[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),join(dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js')].find(existsSync);
const npm=args=>npmCli?run(process.execPath,[npmCli,...args]):run(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`npm ${args.join(' ')}`]);

if(process.argv.includes('--launcher')){
 // A git clone takes the latest code each time; offline, a ZIP copy or local edits simply keep the current version.
 if(existsSync('.git')){console.log('Đang lấy bản code mới nhất (git pull)…');if(run('git',['pull','--ff-only','--quiet'])!==0)console.log('Không cập nhật được code; vẫn chạy bản hiện có.');}
 const installed='node_modules/.package-lock.json';
 if(!existsSync(installed)||statSync(installed).mtimeMs<statSync('package-lock.json').mtimeMs){console.log('\nĐang cài thư viện (npm ci, lần đầu mất khoảng 1 phút)…');if(npm(['ci'])!==0)fail('Cài thư viện thất bại. Kiểm tra Internet rồi chạy lại.');}
 // Setup skips finished steps, so it also applies new migrations and vendor files after an update.
 if(run(process.execPath,['backend/setup.mjs','--launcher'])!==0)console.log('\nCài đặt còn LỖI ở trên; app vẫn khởi động nhưng phần liên quan có thể chưa dùng được.\n');
}
if(!existsSync('node_modules/wrangler')||!existsSync('frontend/vendor/pdf.mjs')||!existsSync('.dev.vars'))fail('Chưa cài đặt xong. Chạy "npm ci" rồi "npm run setup" (hoặc bấm đúp start.cmd trên Windows).');

const children=[];let webUrl='',pdfReady=false,stopping=false,announced=false,portHint=false;
function stop(code=0){
 stopping=true;
 // wrangler runs workerd as a child process: stop whole process trees so no server keeps the ports.
 for(const child of children)if(child.exitCode===null){if(windows)spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else child.kill('SIGTERM');}
 setTimeout(()=>process.exit(code),300);
}
function start(name,args,onLine){
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,FORCE_COLOR:'0'}});children.push(child);
 let pending='';
 const feed=chunk=>{pending+=chunk;const lines=pending.split(/\r?\n/u);pending=lines.pop();for(const raw of lines){const line=raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu,'');if(line.trim())console.log(`[${name}] ${line}`);onLine(line);}};
 child.stdout.setEncoding('utf8').on('data',feed);child.stderr.setEncoding('utf8').on('data',feed);
 child.on('exit',code=>{if(stopping)return;console.error(`\n[${name}] đã dừng (mã ${code}). Xem thông báo ở trên, đóng cửa sổ này rồi chạy lại.`);stop(1);});
}
function openBrowser(url){
 const [command,args]=windows?['cmd.exe',['/d','/c','start','',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
 spawn(command,args,{stdio:'ignore',detached:true,windowsHide:true}).on('error',()=>{}).unref();
}
function announce(){
 if(announced||!pdfReady||!webUrl)return;announced=true;const url=`${webUrl}/#account`;
 console.log(`\n================================================================\n Hoa Trí đang chạy: ${url}\n Lần đầu: "Tạo tài khoản", rồi mở "Xưởng dịch học tập".\n Giữ cửa sổ này mở trong lúc dùng; bấm Ctrl+C để tắt.\n================================================================\n`);
 if(!process.env.HOATRI_NO_BROWSER)openBrowser(url);
}
process.on('SIGINT',()=>stop(0));process.on('SIGTERM',()=>stop(0));
start('PDF',['services/pdf-layout/local.mjs'],line=>{
 if(line.includes('PDF layout service ready')){pdfReady=true;announce();}
 if(line.includes('EADDRINUSE')&&!portHint){portHint=true;console.error('[PDF] Cổng của dịch vụ PDF đang bận: có thể Hoa Trí đang chạy ở một cửa sổ khác. Tắt cửa sổ đó rồi chạy lại.');}
});
start('WEB',['node_modules/wrangler/bin/wrangler.js','dev','--ip','127.0.0.1'],line=>{const ready=/Ready on (https?:\/\/[^\s]+)/u.exec(line);if(ready){webUrl=ready[1].replace(/\/+$/u,'');announce();}});
