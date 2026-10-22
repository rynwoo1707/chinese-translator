// Smoke test of a running PDF layout service (local, Docker or behind Caddy) that never calls Gemini:
//  1. /health answers 401 without the token and 200 with it; /font answers.
//  2. A generated two-page PDF (fixture.py) is extracted and a stand-in translation rendered: every Han run becomes
//     "Vectơ" and formula tokens stay, as validateBlockTranslations requires.
//  3. verify.py checks translated.pdf (page sizes, Vietnamese glyphs, vector art kept) and writes hybrid-scan.pdf,
//     whose extraction must read Chinese text through OCR.
// Steps 2-3 run Python with PyMuPDF on this machine: PDF_PYTHON (from the shell, else the line `npm run setup` wrote
// in .dev.vars) or python, plus .runtime/pdf-python when present. Only node: modules, so no npm ci is needed.
// The token comes from the environment, so it stays out of shell history and process lists:
//   PDF_LAYOUT_SERVICE_TOKEN=… node services/pdf-layout/smoke.mjs <origin> [dir]
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {layoutVersion} from './version.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
// Vietnamese text uses Latin punctuation; keeping the full-width marks would only exercise a CJK fallback font.
const PUNCTUATION={'，':', ','、':', ','。':'. ','：':': ','；':'; ','（':' (','）':') ','“':'"','”':'"','！':'! ','？':'? '};
export function standInTranslation(block){
 const text=String(block?.source||'').replace(/\p{Script=Han}+/gu,'Vectơ').replace(/[，、。：；（）“”！？]/gu,mark=>PUNCTUATION[mark]).replace(/[ \t]{2,}/gu,' ').trim();
 return text||['Vectơ',...(block?.inlines||[]).map(inline=>inline.token)].join(' ');
}
export const hanCount=text=>(String(text||'').match(/\p{Script=Han}/gu)||[]).length;

function fail(message){throw Object.assign(new Error(message),{smoke:true});}
async function request(origin,path,{token,method='GET',headers={},body,timeout=30000}={}){
 const response=await fetch(origin+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...headers},body,signal:AbortSignal.timeout(timeout)});
 const text=await response.text();let json=null;try{json=JSON.parse(text);}catch{}
 return {status:response.status,json,text};
}
const problem=result=>`${result.status}: ${result.json?.error||result.text.slice(0,300)}`;
async function waitForHealth(origin,token,seconds){
 const until=Date.now()+seconds*1000;let last='';
 for(;;){
  try{
   const health=await request(origin,'/health',{token,timeout:10000});
   if(health.status===200&&health.json?.ok)return health.json;
   if(health.status===401)fail('Dịch vụ từ chối token (401): PDF_LAYOUT_SERVICE_TOKEN ở đây khác token của dịch vụ.');
   last=`mã ${health.status}`;
  }catch(error){if(error.smoke)throw error;last=error.cause?.code||error.message;}
  if(Date.now()>=until)fail(`Dịch vụ PDF chưa sẵn sàng sau ${seconds} s (${last}).`);
  await new Promise(done=>setTimeout(done,2000));
 }
}
// Only the PDF_PYTHON line of .dev.vars is read; the file also holds secrets.
function devVarsPython(){
 let text='';try{text=readFileSync(resolve(root,'.dev.vars'),'utf8');}catch{return '';}
 return [...text.matchAll(/^PDF_PYTHON=([^\r\n]*)/gmu)].at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';
}
function python(script,dir){
 const command=process.env.PDF_PYTHON||devVarsPython()||'python',runtime=resolve(root,'.runtime/pdf-python');
 const env={...process.env,PYTHONUTF8:'1',PYTHONPATH:[existsSync(runtime)?runtime:'',process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':')};
 const run=spawnSync(command,[resolve(root,'services/pdf-layout',script),dir],{encoding:'utf8',windowsHide:true,env,timeout:180000});
 const output=`${run.stdout||''}\n${run.stderr||''}`.trim();
 if(run.error?.code==='ENOENT')fail(`Không tìm thấy Python (${command}) để chạy ${script}: chạy npm run setup hoặc đặt PDF_PYTHON tới Python có PyMuPDF.`);
 // 9009: "python" is the Microsoft Store shortcut, not an interpreter.
 if(run.status===9009)fail(`"${command}" là lối tắt Microsoft Store, chưa phải Python: cài Python 3 từ python.org rồi chạy npm run setup.`);
 return {ok:run.status===0,output,last:output.split(/\r?\n/u).filter(Boolean).at(-1)||`mã thoát ${run.status}`};
}
const extract=(origin,token,pdf,pages)=>request(origin,'/extract',{token,method:'POST',headers:{'Content-Type':'application/pdf','X-PDF-Pages':encodeURIComponent(pages)},body:pdf,timeout:280000});
const since=start=>`${((Date.now()-start)/1000).toFixed(1)} s`;

export async function smoke({origin,token,dir,wait=90,log=console.log}){
 if(!token||token.length<24)fail('Đặt biến môi trường PDF_LAYOUT_SERVICE_TOKEN (cùng giá trị với dịch vụ, tối thiểu 24 ký tự).');
 let open;try{open=await request(origin,'/health',{timeout:15000});}catch(error){open={status:0,text:error.cause?.code||error.message};}
 // A service that is still starting refuses connections; waitForHealth below retries those.
 if(open.status&&open.status!==401)fail(`/health không kèm token phải trả 401, nhận ${open.status}: kiểm tra địa chỉ và proxy (gốc dịch vụ, không thêm đường dẫn).`);
 const health=await waitForHealth(origin,token,wait);
 if(health.engine!=='pymupdf-puppeteer')fail(`/health trả engine "${health.engine}", cần "pymupdf-puppeteer".`);
 if(!open.status){const again=await request(origin,'/health',{timeout:15000});if(again.status!==401)fail(`/health không kèm token phải trả 401, nhận ${again.status}.`);}
 log(`OK  /health: 401 khi thiếu token, 200 khi có token (${health.engine}${health.version?`, bản ${health.version.service}`:''}${health.jobs?`, ${health.jobs} việc cùng lúc`:''}${health.font?`, phông ${health.font}`:''}).`);
 // The service and this checkout should check documents with the same code (the Worker deployed from it does too).
 const local=layoutVersion();
 if(health.version?.layout&&local&&health.version.layout!==local)log(`CẢNH BÁO: dịch vụ dùng bộ kiểm tra bố cục ${health.version.layout}, mã nguồn trên máy này là ${local}: Worker và dịch vụ phải chạy cùng một commit (deploy/pdf-layout/README.md mục A.5).`);
 const font=await request(origin,'/font',{token});
 if(font.status!==200||!/@font-face/u.test(font.json?.css||''))fail(`/font trả ${problem(font)}`);
 log(`OK  /font: phông nhúng ${Math.round(font.json.css.length/1024)} KB.`);

 await mkdir(dir,{recursive:true});
 const source=resolve(dir,'source.pdf');
 if(!existsSync(source)){const made=python('fixture.py',dir);if(!made.ok)fail(`Không tạo được PDF mẫu bằng fixture.py: ${made.last}`);}
 let start=Date.now();const extracted=await extract(origin,token,await readFile(source),'1-2');
 if(extracted.status!==200)fail(`/extract trả ${problem(extracted)}`);
 const document=extracted.json?.document,pages=document?.pages||[];
 if(pages.length!==2||pages[0].width!==595||pages[1].width!==650)fail(`/extract phải trả 2 trang rộng 595 và 650 pt, nhận: ${pages.map(p=>p.width).join(', ')||'0 trang'}.`);
 if(!pages.every(p=>p.blocks?.length))fail('/extract trả một trang không có block chữ.');
 if(!pages[0].drawings?.length||!pages[0].images?.length)fail('/extract làm mất hình vẽ vector hoặc ảnh của trang 1.');
 if(!pages[0].blocks.some(b=>b.inlines?.length))fail('/extract không tách công thức "|a| = 1" thành mã công thức.');
 if(Buffer.from(String(extracted.json.originalPdfBase64||''),'base64').subarray(0,5).toString()!=='%PDF-')fail('/extract không trả kèm PDF gốc của các trang đã chọn.');
 const blocks=pages.flatMap(p=>p.blocks);
 log(`OK  /extract: 2 trang, ${blocks.length} block, ${blocks.reduce((n,b)=>n+(b.inlines?.length||0),0)} công thức; hình vẽ và ảnh giữ nguyên (${since(start)}).`);

 start=Date.now();
 const translations=blocks.map(b=>({id:b.id,translation:standInTranslation(b)}));
 const rendered=await request(origin,'/render',{token,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document,translations,title:'Hoa Trí - kiểm thử dịch vụ PDF'}),timeout:280000});
 if(rendered.status!==200)fail(`/render trả ${problem(rendered)}`);
 const pdf=Buffer.from(String(rendered.json?.pdfBase64||''),'base64'),report=rendered.json?.report||[];
 if(pdf.subarray(0,5).toString()!=='%PDF-')fail('/render không trả PDF.');
 if(report.length!==2||report.some(page=>page.blocks?.some(b=>b.overflow)))fail('/render báo chữ không vừa box với bản dịch thử.');
 await writeFile(resolve(dir,'translated.pdf'),pdf);
 log(`OK  /render: PDF tiếng Việt ${Math.round(pdf.length/1024)} KB (${since(start)}).`);

 const verified=python('verify.py',dir);
 if(!verified.ok)fail(`verify.py không đạt: ${verified.last}`);
 log(`OK  verify.py: ${verified.last}`);

 start=Date.now();const scan=await extract(origin,token,await readFile(resolve(dir,'hybrid-scan.pdf')),'1');
 if(scan.status!==200)fail(`/extract (trang scan) trả ${problem(scan)}`);
 const scanBlocks=scan.json?.document?.pages?.[0]?.blocks||[],han=scanBlocks.reduce((sum,b)=>sum+hanCount(b.source),0);
 if(han<8)fail(`OCR chỉ đọc được ${han} chữ Hán trên trang scan: kiểm tra dữ liệu OCR (TESSDATA_PREFIX, npm run prepare:pdf-ocr).`);
 log(`OK  OCR trang scan: ${han} chữ Hán trong ${scanBlocks.length} block (${since(start)}).`);
 return {blocks:blocks.length,bytes:pdf.length,han};
}

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(process.argv[1]&&samePath(fileURLToPath(import.meta.url),resolve(process.argv[1]))){
 const [origin,dir]=process.argv.slice(2);
 try{
  if(!origin||!/^https?:\/\/[^/?#]+\/?$/u.test(origin))fail('Cách dùng: PDF_LAYOUT_SERVICE_TOKEN=<token> node services/pdf-layout/smoke.mjs <gốc dịch vụ, ví dụ https://pdf.example.com> [thư mục kết quả]');
  const target=resolve(dir||resolve(root,'tmp/pdf-smoke'));
  await smoke({origin:origin.replace(/\/$/u,''),token:process.env.PDF_LAYOUT_SERVICE_TOKEN,dir:target});
  console.log(`Dịch vụ PDF đạt kiểm thử (không gọi Gemini). Kết quả: ${target}`);
 }catch(error){console.error(`LỖI: ${error.message}`);process.exitCode=1;}
}
