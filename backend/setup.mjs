// One-time local setup for a fresh clone: `npm run setup` (after `npm ci`). Safe to re-run: finished steps are skipped.
// Nothing is installed globally: models and vendor files go to frontend/vendor/, PyMuPDF and OCR data to .runtime/,
// local secrets and machine paths to .dev.vars, the local D1 database to .wrangler/ (all git-ignored).
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
const STEPS=7,windows=process.platform==='win32',warnings=[],problems=[];
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

const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))throw new Error(`Cần Node.js 22.13 trở lên (đang dùng ${process.version}).`);
if(!existsSync('node_modules/wrangler'))throw new Error('Chưa cài thư viện. Chạy "npm ci" trước, rồi chạy lại "npm run setup".');
// Local state files such as <root>\.wrangler\state\v3\observability\miniflare-wobs-trace-store\<64 hex>.sqlite-wal add
// up to 136 characters, and workerd cannot open a path past the 260-character Windows limit: D1 then only reports
// "internal error; reference = …".
const rootLength=root.replace(/[\\/]+$/u,'').length,longPath=windows&&rootLength+136>259;
if(longPath)problems.push(`Đường dẫn thư mục dự án quá dài cho Windows (${rootLength} ký tự, cần tối đa 123): cơ sở dữ liệu local sẽ báo "internal error". Chuyển (hoặc clone lại) dự án vào thư mục ngắn, ví dụ C:\\src\\chinese-translator, rồi chạy lại "npm run setup".`);

step(1,'Mô hình PaddleOCR cho OCR trong trình duyệt (tải khoảng 21 MB một lần)');
const MODEL_HINT='Không tải được mô hình PaddleOCR (cần vào được paddle-model-ecology.bj.bcebos.com). Có thể chép det.tar, rec.tar, manifest.json từ máy khác vào frontend/vendor/paddle/models/ rồi chạy lại.';
const models=['det.tar','rec.tar','manifest.json'].every(file=>existsSync(`frontend/vendor/paddle/models/${file}`))?(console.log('Đã có, bỏ qua.'),true):attempt(MODEL_HINT,()=>node('backend/prepare-paddle-models.mjs'));

step(2,'Thư viện giao diện (frontend/vendor)');
const vendor=models?attempt('Chưa chép được thư viện giao diện vào frontend/vendor.',()=>{node('backend/vendor.mjs');console.log('Xong.');}):(console.log('Bỏ qua vì thiếu mô hình PaddleOCR (bước 1).'),false);

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
 if(installed)console.log(`PyMuPDF ${pin} đã có trong .runtime/pdf-python, bỏ qua.`);
 else run(python.command,[...python.args,'-m','pip','install','--upgrade','--disable-pip-version-check','--target','.runtime/pdf-python','-r','services/pdf-layout/requirements.txt'],{hint:'Nếu báo thiếu pip: chạy "python -m ensurepip --upgrade" (Linux: cài gói python3-pip) rồi chạy lại.'});
 run(python.command,[...python.args,'-c','import pymupdf;print("PyMuPDF",pymupdf.VersionBind,"OK")'],{env:{...process.env,PYTHONPATH:join(root,'.runtime','pdf-python')}});
});

step(4,'Dữ liệu OCR tiếng Trung + Anh cho dịch vụ PDF (.runtime/tessdata)');
if(vendor)attempt('Chưa tạo được dữ liệu OCR cho dịch vụ PDF.',()=>node('services/pdf-layout/prepare-ocr.mjs'));
else console.log('Bỏ qua vì frontend/vendor chưa sẵn sàng (bước 2).');

step(5,'Trình duyệt và phông chữ để xuất PDF');
// The service finds the AUTO paths by itself (services/pdf-layout/engine.mjs); other choices are written to .dev.vars,
// which `npm run dev:pdf-layout` reads. A value set in the shell or a still-valid value in .dev.vars is kept.
const AUTO_BROWSERS=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'];
const OTHER_BROWSERS=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/microsoft-edge','/snap/bin/chromium'];
const DEFAULT_FONT=windows?'C:/Windows/Fonts/times.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const OTHER_FONTS=['/System/Library/Fonts/Supplemental/Times New Roman.ttf','/Library/Fonts/Times New Roman.ttf','/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf','/usr/share/fonts/TTF/DejaVuSerif.ttf','/usr/share/fonts/dejavu/DejaVuSerif.ttf'];
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
const font=choose('PDF_FONT_PATH',[DEFAULT_FONT],OTHER_FONTS);
if(!font)warnings.push('Không tìm thấy phông Times New Roman/DejaVu Serif/Liberation Serif: dịch vụ PDF sẽ báo lỗi khi xuất. Cài một phông có chữ Việt (Linux: fonts-dejavu-core), hoặc ghi PDF_FONT_PATH=<tệp .ttf> vào .dev.vars.');
else{console.log(`Phông chữ: ${font.value}`);remember('PDF_FONT_PATH',font);}

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
if(longPath)console.log('Bỏ qua vì đường dẫn thư mục dự án quá dài (xem LỖI bên dưới).');
else attempt('Chưa tạo được cơ sở dữ liệu local. Nếu wrangler báo "internal error; reference = …": chuyển dự án vào thư mục có đường dẫn ngắn hơn rồi chạy lại.',()=>run(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local'],{stdio:['ignore','inherit','inherit']}));

for(const warning of warnings)console.warn(`\nCẢNH BÁO: ${warning}`);
for(const problem of problems)console.error(`\nLỖI: ${problem}`);
if(problems.length)process.exitCode=1;
let layoutPort='8091';try{layoutPort=new URL(current('PDF_LAYOUT_SERVICE_URL')).port||layoutPort;}catch{}
const npm=windows?'npm.cmd':'npm';
// start.cmd starts both services itself right after setup.
if(process.argv.includes('--launcher'))console.log(problems.length?'\nĐã làm xong các bước còn lại.':'\nCài đặt xong.');
else console.log(`
${problems.length?'Đã làm xong các bước còn lại; sửa LỖI ở trên rồi chạy lại "npm run setup".':'Cài đặt xong.'} Chạy app (2 cửa sổ terminal, đều ở thư mục dự án):
  1) ${npm} run dev:pdf-layout   (dịch vụ PDF giữ bố cục, cổng ${layoutPort})
  2) ${npm} run dev              (web, mở địa chỉ wrangler in ra, thường là http://127.0.0.1:8787)
Sau đó: tạo tài khoản ở /#account, mở /study.html, nhập "Tên nội dung", dán khóa Gemini API của bạn và chọn tệp để dịch.
`);
