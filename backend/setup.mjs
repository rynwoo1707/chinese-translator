// One-time local setup for a fresh clone: `npm run setup` (after `npm ci`). Safe to re-run: finished steps are skipped.
// Nothing is installed globally: vendor files and the PaddleOCR models kept in backend/paddle-models/ go to
// frontend/vendor/, PyMuPDF and OCR data to .runtime/, local secrets and machine paths to .dev.vars, the local D1
// database to .wrangler/ (all git-ignored). Only a LỖI exits with code 1; a missing optional part (PaddleOCR in the
// browser, PDF export, the lookup dictionary) is a CẢNH BÁO and never stops the other steps or the app.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {checkPaddleModels,RESTORE_HINT,TESSERACT_FALLBACK} from './paddle-assets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
const STEPS=8,windows=process.platform==='win32',warnings=[],problems=[],skipped=[];
const step=(n,text)=>console.log(`\n[${n}/${STEPS}] ${text}`);
function run(command,args,{hint='',...options}={}){
 const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true,...options});
 if(result.status!==0)throw new Error(`Lệnh thất bại: ${command} ${args.join(' ')}${hint?`\n${hint}`:''}`);
}
const node=(script,...args)=>run(process.execPath,[script,...args]);
const secret=()=>randomBytes(32).toString('hex');
// A failed step is reported at the end; later steps that do not depend on it still run.
function attempt(consequence,action){try{action();return true;}catch(error){problems.push(`${consequence} ${error.message}`);return false;}}
const valueIn=(text,key)=>[...text.matchAll(new RegExp(`^${key}=([^\\r\\n]*)`,'gmu'))].at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';
const saved=existsSync('.dev.vars')?readFileSync('.dev.vars','utf8'):null;

// The launcher points users at the "LỖI:" lines of setup, so these two stops print one too instead of a stack trace.
const abort=message=>{console.error(`\nLỖI: ${message}`);process.exit(1);};
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))abort(`Cần Node.js 22.13 trở lên (đang dùng ${process.version}). Cài bản LTS mới ở https://nodejs.org rồi chạy lại.`);
if(!existsSync('node_modules/wrangler'))abort('Chưa cài thư viện. Chạy "npm ci" trước, rồi chạy lại "npm run setup".');
// Local state files such as <root>\.wrangler\state\v3\observability\miniflare-wobs-trace-store\<64 hex>.sqlite-wal add
// up to 136 characters, and workerd cannot open a path past the 260-character Windows limit: D1 then only reports
// "internal error; reference = …".
const rootLength=root.replace(/[\\/]+$/u,'').length,longPath=windows&&rootLength+136>259;
if(longPath)problems.push(`Đường dẫn thư mục dự án quá dài cho Windows (${rootLength} ký tự, cần tối đa 123): cơ sở dữ liệu local sẽ báo "internal error". Chuyển (hoặc clone lại) dự án vào thư mục ngắn, ví dụ C:\\src\\chinese-translator, rồi chạy lại "npm run setup".`);

// Offline: the models ship in the repo. Optional, so a problem is only a warning: the browser then reads scans with Tesseract.
step(1,'Mô hình PaddleOCR cho OCR trong trình duyệt (có sẵn trong repo, kiểm tra checksum)');
const paddle=checkPaddleModels(root);
if(paddle.ok)console.log('Đủ và đúng checksum (backend/paddle-models).');
else{console.log(`Không dùng được: ${paddle.problem}`);warnings.push(`${paddle.problem} ${TESSERACT_FALLBACK} ${RESTORE_HINT}`);}

// Always runs: the app cannot start without frontend/vendor/pdf.mjs, and vendor.mjs adds PaddleOCR only when it can.
step(2,'Thư viện giao diện (frontend/vendor)');
const vendor=attempt('Chưa chép được thư viện giao diện vào frontend/vendor (xem lỗi ở bước 2): thiếu frontend/vendor/pdf.mjs thì app không khởi động được. Chạy "npm ci" rồi chạy lại "npm run setup".',()=>{node('backend/vendor.mjs');console.log('Xong.');});
if(vendor&&paddle.ok&&!existsSync('frontend/vendor/paddle/worker.js'))warnings.push(`Chưa cài được PaddleOCR cho trình duyệt (xem CẢNH BÁO ở bước 2). ${TESSERACT_FALLBACK} Chạy lại "npm ci" rồi "npm run setup".`);

step(3,'Python 3.10+ và PyMuPDF cho dịch vụ PDF giữ bố cục');
// Python installed without "Add python.exe to PATH", or by winget during this run, is still found in its usual folders.
function windowsPythons(){
 if(!windows)return [];
 const found=[];
 for(const folder of [join(process.env.LOCALAPPDATA||'','Programs','Python'),process.env.ProgramFiles||'C:\\Program Files','C:\\'])try{for(const name of readdirSync(folder)){const version=/^Python3(\d+)$/iu.exec(name),exe=join(folder,name,'python.exe');if(version&&existsSync(exe))found.push({version:Number(version[1]),exe});}}catch{}
 return found.sort((a,b)=>b.version-a.version).map(({exe})=>({from:'other',cmd:[exe]}));
}
// Interactive Windows runs offer to install Python (per user, no administrator rights) instead of only reporting it.
async function offerPython(){
 if(!windows||!process.stdin.isTTY||spawnSync('winget',['--version'],{windowsHide:true}).status!==0)return false;
 const prompt=createInterface({input:process.stdin,output:process.stdout});
 const answer=await new Promise(resolve=>prompt.question('Máy chưa có Python 3.10+. Cài Python 3.13 bằng winget ngay bây giờ? (C = có / K = không) ',resolve));prompt.close();
 if(/^\s*k/iu.test(answer))return false;
 return spawnSync('winget',['install','-e','--id','Python.Python.3.13','--scope','user','--silent','--accept-package-agreements','--accept-source-agreements'],{stdio:'inherit',windowsHide:true}).status===0;
}
function findPython(){
 const candidates=[process.env.PDF_PYTHON&&{from:'env',cmd:[process.env.PDF_PYTHON]},saved&&valueIn(saved,'PDF_PYTHON')&&{from:'file',cmd:[valueIn(saved,'PDF_PYTHON')]},{from:'auto',cmd:['python']},{from:'other',cmd:['python3']},windows&&{from:'other',cmd:['py','-3']},...windowsPythons()].filter(Boolean);
 for(const {from,cmd:[command,...args]} of candidates){
  // The Microsoft Store alias "python" exits with an error instead of printing a version, so it is skipped here.
  const probe=spawnSync(command,[...args,'-c','import sys;print(sys.version_info>=(3,10));print(sys.executable)'],{encoding:'utf8',windowsHide:true});
  const [ok,executable]=String(probe.stdout||'').trim().split(/\r?\n/u);
  if(probe.status===0&&ok==='True')return {from,command,args,executable};
 }
 return null;
}
// Without Python only the layout-preserving PDF mode is unavailable, so the remaining steps still run.
let python=findPython();
if(!python&&await offerPython())python=findPython();
if(!python)problems.push('Không tìm thấy Python 3.10 trở lên nên chế độ "Giữ bố cục PDF" chưa dùng được. Cài Python 3 (Windows: python.org, chọn "Add python.exe to PATH"), mở terminal mới rồi chạy lại "npm run setup".');
else attempt('Chưa cài được PyMuPDF nên chế độ "Giữ bố cục PDF" chưa dùng được.',()=>{
 console.log(`Dùng ${python.executable}`);
 const pin=readFileSync('services/pdf-layout/requirements.txt','utf8').match(/^PyMuPDF==([\w.]+)/imu)?.[1];
 const installed=pin&&existsSync('.runtime/pdf-python')&&readdirSync('.runtime/pdf-python').some(name=>name.toLowerCase()===`pymupdf-${pin}.dist-info`);
 const env={...process.env,PYTHONPATH:join(root,'.runtime','pdf-python')},probe=[...python.args,'-c','import pymupdf;print("PyMuPDF",pymupdf.VersionBind,"OK")'];
 // A copy that no longer imports (files removed by an antivirus, another Python) is installed again once, instead of
 // repeating the same LỖI on every run.
 const works=installed&&spawnSync(python.command,probe,{env,encoding:'utf8',windowsHide:true}).status===0;
 if(works)console.log(`PyMuPDF ${pin} đã có trong .runtime/pdf-python, bỏ qua.`);
 else{
  if(installed)console.log(`PyMuPDF ${pin} trong .runtime/pdf-python không nạp được: cài lại.`);
  run(python.command,[...python.args,'-m','pip','install','--upgrade','--disable-pip-version-check','--target','.runtime/pdf-python','-r','services/pdf-layout/requirements.txt'],{hint:'Nếu báo thiếu pip: chạy "python -m ensurepip --upgrade" (Linux: cài gói python3-pip) rồi chạy lại.'});
 }
 run(python.command,probe,{env});
});

step(4,'Dữ liệu OCR tiếng Trung + Anh cho dịch vụ PDF (.runtime/tessdata)');
if(['chi_sim','eng'].every(lang=>existsSync(`frontend/vendor/tessdata/${lang}.traineddata.gz`)))attempt('Chưa tạo được dữ liệu OCR cho dịch vụ PDF.',()=>node('services/pdf-layout/prepare-ocr.mjs'));
else{console.log('Bỏ qua vì thiếu frontend/vendor/tessdata (bước 2).');skipped.push(4);problems.push('Chưa tạo được dữ liệu OCR cho dịch vụ PDF: bước 2 chưa chép frontend/vendor/tessdata. Sửa LỖI của bước 2 rồi chạy lại "npm run setup".');}

step(5,'Trình duyệt và phông chữ để xuất PDF');
// The service finds the AUTO paths by itself (services/pdf-layout/engine.mjs); other choices are written to .dev.vars,
// which `npm run dev:pdf-layout` reads. A value set in the shell or a still-valid value in .dev.vars is kept.
const AUTO_BROWSERS=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'];
const OTHER_BROWSERS=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/microsoft-edge','/snap/bin/chromium'];
// The font list follows the PDF service's own order (Liberation Serif before DejaVu Serif on Linux): setup-font.mjs.
const {fontCandidates,fontWarning}=await import('./setup-font.mjs'),FONTS=fontCandidates();
function choose(key,auto,other){
 if(process.env[key])return {from:'env',value:process.env[key]};
 const kept=saved&&valueIn(saved,key);if(kept&&existsSync(kept))return {from:'file',value:kept};
 const found=auto.find(existsSync);if(found)return {from:'auto',value:found};
 const fallback=other.find(existsSync);return fallback?{from:'other',value:fallback}:null;
}
const machine={};
// Write a value when the service could not find it alone, or when it replaces a stale line in .dev.vars.
const remember=(key,choice)=>{if(choice&&choice.from!=='file'&&(choice.from!=='auto'||(saved&&valueIn(saved,key))))machine[key]=choice.value;};
// Always pin the interpreter that has PyMuPDF: the service may run in another terminal whose PATH resolves "python" to the
// Microsoft Store shortcut (for example a window opened before Python was installed).
if(python&&python.from!=='file')machine.PDF_PYTHON=python.executable;
const browser=choose('CHROMIUM_EXECUTABLE_PATH',AUTO_BROWSERS,OTHER_BROWSERS);
if(!browser)warnings.push('Không tìm thấy Edge, Chrome hoặc Chromium: dịch vụ PDF sẽ không xuất được PDF. Cài một trình duyệt rồi chạy lại "npm run setup", hoặc ghi CHROMIUM_EXECUTABLE_PATH=<đường dẫn> vào .dev.vars.');
else{console.log(`Trình duyệt: ${browser.value}`);remember('CHROMIUM_EXECUTABLE_PATH',browser);}
const font=choose('PDF_FONT_PATH',FONTS.auto,FONTS.other),fontAdvice=fontWarning(font);
if(font){console.log(`Phông chữ: ${font.value}`);remember('PDF_FONT_PATH',font);}
if(fontAdvice)warnings.push(fontAdvice);

step(6,'Cấu hình máy (.dev.vars, không đưa lên git)');
let vars=saved;
if(vars===null){vars=readFileSync('.dev.vars.example','utf8');console.log('Đã tạo .dev.vars từ .dev.vars.example.');}
else console.log('.dev.vars đã có: chỉ thêm giá trị còn thiếu.');
const current=key=>valueIn(vars,key);
function setVar(key,value){const line=`${key}=${value}`;vars=new RegExp(`^${key}=`,'mu').test(vars)?vars.replace(new RegExp(`^${key}=[^\\r\\n]*`,'gmu'),()=>line):`${vars.replace(/\s*$/u,'')}\n${line}\n`;}
if(!current('ADMIN_TOKEN')||current('ADMIN_TOKEN')==='replace-with-a-long-random-secret'){setVar('ADMIN_TOKEN',secret());console.log('Đã tạo ADMIN_TOKEN ngẫu nhiên (mã đăng nhập trang /admin, xem trong .dev.vars).');}
if(current('PDF_LAYOUT_SERVICE_TOKEN').length<24){setVar('PDF_LAYOUT_SERVICE_TOKEN',secret());console.log('Đã tạo PDF_LAYOUT_SERVICE_TOKEN ngẫu nhiên.');}
if(!current('PDF_LAYOUT_SERVICE_URL'))setVar('PDF_LAYOUT_SERVICE_URL','http://127.0.0.1:8091');
for(const [key,value] of Object.entries(machine))if(current(key)!==value){setVar(key,value);console.log(`Đã ghi ${key} cho máy này.`);}
if(vars!==saved)writeFileSync('.dev.vars',vars);

step(7,'Cơ sở dữ liệu D1 cục bộ (.wrangler)');
// stdin is not a terminal here, so wrangler applies the pending migrations without asking.
if(longPath){console.log('Bỏ qua vì đường dẫn thư mục dự án quá dài (xem LỖI bên dưới).');skipped.push(7);}
else attempt('Chưa tạo được cơ sở dữ liệu local. Nếu wrangler báo "internal error; reference = …": chuyển dự án vào thư mục có đường dẫn ngắn hơn rồi chạy lại.',()=>run(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local'],{stdio:['ignore','inherit','inherit']}));

// Last, because it is optional and the slowest download, and no other step needs it. Warning only: without the data the
// lookup panel says so and translation works as before. prepare-dictionary.mjs skips itself when already up to date.
step(8,'Từ điển Pinyin & Hán Việt cho tra cứu chữ Hán (tải khoảng 18 MB một lần, không dùng Gemini)');
try{node('backend/prepare-dictionary.mjs');}catch{warnings.push('Chưa tạo được từ điển tra cứu chữ Hán (xem lỗi ở bước 8). Nút "Tra chữ Hán" sẽ báo chưa có dữ liệu; phần dịch vẫn dùng được. Khi có mạng, chạy "npm run prepare:dict".');}

for(const warning of warnings)console.warn(`\nCẢNH BÁO: ${warning}`);
for(const problem of problems)console.error(`\nLỖI: ${problem}`);
if(problems.length)process.exitCode=1;
let layoutPort='8091';try{layoutPort=new URL(current('PDF_LAYOUT_SERVICE_URL')).port||layoutPort;}catch{}
const npm=windows?'npm.cmd':'npm',done=`Cài đặt xong.${warnings.length?' Có CẢNH BÁO ở trên.':''}`;
// start.cmd starts both services itself right after setup.
if(process.argv.includes('--launcher'))console.log(problems.length?'\nCài đặt còn LỖI (xem ở trên).':`\n${done}`);
else console.log(`
${problems.length?`${skipped.length?`Bước ${skipped.join(' và ')} bị bỏ qua`:'Đã làm xong các bước còn lại'}; sửa LỖI ở trên rồi chạy lại "npm run setup".`:done} Chạy app (2 cửa sổ terminal, đều ở thư mục dự án):
  1) ${npm} run dev:pdf-layout   (dịch vụ PDF giữ bố cục, cổng ${layoutPort})
  2) ${npm} run dev              (web, mở địa chỉ wrangler in ra, thường là http://127.0.0.1:8787)
Sau đó: tạo tài khoản ở /#account, mở /study, nhập "Tên nội dung", dán khóa Gemini API của bạn và chọn tệp để dịch.
`);
