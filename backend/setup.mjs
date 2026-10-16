// One-time local setup for a fresh clone: `npm run setup` (after `npm ci`). Safe to re-run: finished steps are skipped.
// Nothing is installed globally: models and vendor files go to frontend/vendor/, PyMuPDF and OCR data to .runtime/,
// local secrets and machine paths to .dev.vars, the local D1 database to .wrangler/ (all git-ignored).
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
const STEPS=7,windows=process.platform==='win32',warnings=[],problems=[];
const step=(n,text)=>console.log(`\n[${n}/${STEPS}] ${text}`);
function run(command,args,{hint='',...options}={}){
 const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true,...options});
 if(result.status!==0)throw new Error(`Lệnh thất bại: ${command} ${args.join(' ')}${hint?`\n${hint}`:''}`);
}
const node=(script,...args)=>run(process.execPath,[script,...args]);
const secret=()=>randomBytes(32).toString('hex');

const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))throw new Error(`Cần Node.js 22.13 trở lên (đang dùng ${process.version}).`);
if(!existsSync('node_modules/wrangler'))throw new Error('Chưa cài thư viện. Chạy "npm ci" trước, rồi chạy lại "npm run setup".');

step(1,'Mô hình PaddleOCR cho OCR trong trình duyệt (tải khoảng 21 MB một lần)');
if(['det.tar','rec.tar','manifest.json'].every(file=>existsSync(`frontend/vendor/paddle/models/${file}`)))console.log('Đã có, bỏ qua.');
else node('backend/prepare-paddle-models.mjs');

step(2,'Thư viện giao diện (frontend/vendor)');
node('backend/vendor.mjs');console.log('Xong.');

step(3,'Python 3.10+ và PyMuPDF cho dịch vụ PDF giữ bố cục');
function findPython(){
 const candidates=[process.env.PDF_PYTHON?[process.env.PDF_PYTHON]:null,['python'],['python3'],windows?['py','-3']:null].filter(Boolean);
 for(const [command,...args] of candidates){
  // The Microsoft Store alias "python" exits with an error instead of printing a version, so it is skipped here.
  const probe=spawnSync(command,[...args,'-c','import sys;print(sys.version_info>=(3,10));print(sys.executable)'],{encoding:'utf8',windowsHide:true});
  const [ok,executable]=String(probe.stdout||'').trim().split(/\r?\n/u);
  if(probe.status===0&&ok==='True')return {command,args,executable};
 }
 return null;
}
// Without Python only the layout-preserving PDF mode is unavailable, so the remaining steps still run.
const python=findPython();
if(!python)problems.push('Không tìm thấy Python 3.10 trở lên nên chế độ "Giữ bố cục PDF" chưa dùng được. Cài Python 3 (Windows: python.org, chọn "Add python.exe to PATH"), mở terminal mới rồi chạy lại "npm run setup".');
else try{
 console.log(`Dùng ${python.executable}`);
 const pin=readFileSync('services/pdf-layout/requirements.txt','utf8').match(/^PyMuPDF==([\w.]+)/imu)?.[1];
 const installed=pin&&existsSync('.runtime/pdf-python')&&readdirSync('.runtime/pdf-python').some(name=>name.toLowerCase()===`pymupdf-${pin}.dist-info`);
 if(installed)console.log(`PyMuPDF ${pin} đã có trong .runtime/pdf-python, bỏ qua.`);
 else run(python.command,[...python.args,'-m','pip','install','--upgrade','--disable-pip-version-check','--target','.runtime/pdf-python','-r','services/pdf-layout/requirements.txt'],{hint:'Nếu báo thiếu pip: chạy "python -m ensurepip --upgrade" (Linux: cài gói python3-pip) rồi chạy lại.'});
 run(python.command,[...python.args,'-c','import pymupdf;print("PyMuPDF",pymupdf.VersionBind,"OK")'],{env:{...process.env,PYTHONPATH:join(root,'.runtime','pdf-python')}});
}catch(error){problems.push(`Chưa cài được PyMuPDF nên chế độ "Giữ bố cục PDF" chưa dùng được. ${error.message}`);}

step(4,'Dữ liệu OCR tiếng Trung + Anh cho dịch vụ PDF (.runtime/tessdata)');
node('services/pdf-layout/prepare-ocr.mjs');

step(5,'Trình duyệt và phông chữ để xuất PDF');
// The service finds these paths by itself (services/pdf-layout/engine.mjs); anything else is written to .dev.vars.
const AUTO_BROWSERS=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'];
const OTHER_BROWSERS=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/microsoft-edge','/snap/bin/chromium'];
const DEFAULT_FONT=windows?'C:/Windows/Fonts/times.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const OTHER_FONTS=['/System/Library/Fonts/Supplemental/Times New Roman.ttf','/Library/Fonts/Times New Roman.ttf','/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf','/usr/share/fonts/TTF/DejaVuSerif.ttf','/usr/share/fonts/dejavu/DejaVuSerif.ttf'];
const machine={};
if(python&&python.command!=='python')machine.PDF_PYTHON=python.executable;
const browser=process.env.CHROMIUM_EXECUTABLE_PATH||AUTO_BROWSERS.find(existsSync)||OTHER_BROWSERS.find(existsSync);
if(!browser)warnings.push('Không tìm thấy Edge, Chrome hoặc Chromium: dịch vụ PDF sẽ không xuất được PDF. Cài một trình duyệt rồi chạy lại "npm run setup", hoặc ghi CHROMIUM_EXECUTABLE_PATH=<đường dẫn> vào .dev.vars.');
else{console.log(`Trình duyệt: ${browser}`);if(!AUTO_BROWSERS.includes(browser))machine.CHROMIUM_EXECUTABLE_PATH=browser;}
const font=process.env.PDF_FONT_PATH||[DEFAULT_FONT,...OTHER_FONTS].find(existsSync);
if(!font)warnings.push('Không tìm thấy phông Times New Roman/DejaVu Serif/Liberation Serif: dịch vụ PDF sẽ báo lỗi khi xuất. Cài một phông có chữ Việt (Linux: fonts-dejavu-core), hoặc ghi PDF_FONT_PATH=<tệp .ttf> vào .dev.vars.');
else{console.log(`Phông chữ: ${font}`);if(font!==DEFAULT_FONT)machine.PDF_FONT_PATH=font;}

step(6,'Cấu hình máy (.dev.vars, không đưa lên git)');
const original=existsSync('.dev.vars')?readFileSync('.dev.vars','utf8'):null;let vars=original;
if(vars===null){vars=readFileSync('.dev.vars.example','utf8');console.log('Đã tạo .dev.vars từ .dev.vars.example.');}
else console.log('.dev.vars đã có: giữ nguyên các giá trị bạn đã đặt.');
const current=key=>[...vars.matchAll(new RegExp(`^${key}=([^\\r\\n]*)`,'gmu'))].at(-1)?.[1].trim()||'';
function setVar(key,value){const line=`${key}=${value}`;vars=new RegExp(`^${key}=`,'mu').test(vars)?vars.replace(new RegExp(`^${key}=[^\\r\\n]*`,'gmu'),()=>line):`${vars.replace(/\s*$/u,'')}\n${line}\n`;}
if(!current('ADMIN_TOKEN')||current('ADMIN_TOKEN')==='replace-with-a-long-random-secret'){setVar('ADMIN_TOKEN',secret());console.log('Đã tạo ADMIN_TOKEN ngẫu nhiên (mã đăng nhập trang /admin, xem trong .dev.vars).');}
if(current('PDF_LAYOUT_SERVICE_TOKEN').length<24){setVar('PDF_LAYOUT_SERVICE_TOKEN',secret());console.log('Đã tạo PDF_LAYOUT_SERVICE_TOKEN ngẫu nhiên.');}
if(!current('PDF_LAYOUT_SERVICE_URL'))setVar('PDF_LAYOUT_SERVICE_URL','http://127.0.0.1:8091');
for(const [key,value] of Object.entries(machine))if(current(key)!==value){setVar(key,value);console.log(`Đã ghi ${key} cho máy này.`);}
if(vars!==original)writeFileSync('.dev.vars',vars);

step(7,'Cơ sở dữ liệu D1 cục bộ (.wrangler)');
// stdin is not a terminal here, so wrangler applies the pending migrations without asking.
run(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local'],{stdio:['ignore','inherit','inherit']});

for(const warning of warnings)console.warn(`\nCẢNH BÁO: ${warning}`);
for(const problem of problems)console.error(`\nLỖI: ${problem}`);
if(problems.length)process.exitCode=1;
console.log(`
${problems.length?'Cài đặt xong phần còn lại; sửa LỖI ở trên rồi chạy lại "npm run setup".':'Cài đặt xong.'} Chạy app (2 cửa sổ terminal, đều ở thư mục dự án):
  1) npm run dev:pdf-layout   (dịch vụ PDF giữ bố cục, cổng 8091)
  2) npm run dev              (web, mở địa chỉ wrangler in ra, thường là http://127.0.0.1:8787)
Sau đó: tạo tài khoản ở /#account, mở /study.html, dán khóa Gemini API của bạn và chọn tệp để dịch.
${windows?'Nếu PowerShell chặn "npm", dùng "npm.cmd".\n':''}`);
