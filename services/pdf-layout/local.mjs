// Local developer launcher: creates an ignored service token once, preserving all existing settings.
import {readFile,appendFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTessdata,tessdataIsClean} from './prepare-ocr.mjs';
const file=new URL('../../.dev.vars',import.meta.url),text=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
function value(key){const matches=[...text.matchAll(new RegExp(`^${key}=([^\\r\\n]*)`,'gm'))];return matches.at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';}
const existingUrl=value('PDF_LAYOUT_SERVICE_URL'),url=new URL(existingUrl||'http://127.0.0.1:8091');
if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')throw new Error('Đã cấu hình dịch vụ PDF bên ngoài. Chạy server.mjs với cấu hình của môi trường đó.');
const token=value('PDF_LAYOUT_SERVICE_TOKEN')||randomBytes(32).toString('hex'),add=[];
if(!existingUrl)add.push(`PDF_LAYOUT_SERVICE_URL=${url.origin}`);if(!value('PDF_LAYOUT_SERVICE_TOKEN'))add.push(`PDF_LAYOUT_SERVICE_TOKEN=${token}`);
if(add.length)await appendFile(file,`\n# Local PDF layout service\n${add.join('\n')}\n`);
// OCR data from an older checkout still carries the noisy config lines; refresh it before serving.
if(!process.env.TESSDATA_PREFIX&&!await tessdataIsClean()){const prepared=await prepareTessdata();console.log(`Đã chuẩn bị dữ liệu OCR (chi_sim + eng) tại ${prepared.to}.`);}
// Machine-specific paths written by `npm run setup`; a value set in the shell still wins.
for(const key of ['PDF_PYTHON','CHROMIUM_EXECUTABLE_PATH','PDF_FONT_PATH'])if(!process.env[key]&&value(key))process.env[key]=value(key);
// Python only starts on the first PDF, so a missing PyMuPDF would otherwise surface only after "Bắt đầu dịch".
const python=process.env.PDF_PYTHON||'python',runtime=fileURLToPath(new URL('../../.runtime/pdf-python',import.meta.url));
const probe=spawnSync(python,['-c','import pymupdf'],{windowsHide:true,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':')}});
if(probe.error||probe.status!==0)console.warn(`CẢNH BÁO: không chạy được PyMuPDF bằng "${python}", nên dịch PDF giữ bố cục sẽ lỗi. Chạy "npm run setup" rồi khởi động lại lệnh này.`);
process.env.PDF_LAYOUT_SERVICE_TOKEN=token;process.env.PORT=url.port||'8091';process.env.PDF_LAYOUT_HOST='127.0.0.1';
await import('./server.mjs');
