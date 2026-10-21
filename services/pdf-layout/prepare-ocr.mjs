// Writes the PDF service's OCR language data with the noisy config lines removed (see tessdata.mjs).
// Default: the project's vendored tesseract.js data -> .runtime/tessdata. Docker passes
// --from <dir with chi_sim/eng .traineddata> --to <dir> to clean the distribution's own models in place of them.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {cleanTraineddata,noisyConfigLines} from './tessdata.mjs';

export const LANGUAGES=['chi_sim','eng'];
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
export const RUNTIME_TESSDATA=resolve(projectRoot,'.runtime/tessdata');

export async function prepareTessdata({from=null,to=RUNTIME_TESSDATA}={}){
 await mkdir(to,{recursive:true});const removed={};
 for(const lang of LANGUAGES){
  const raw=from?await readFile(resolve(from,`${lang}.traineddata`)):gunzipSync(await readFile(resolve(projectRoot,`frontend/vendor/tessdata/${lang}.traineddata.gz`)));
  removed[lang]=noisyConfigLines(raw);
  const clean=cleanTraineddata(raw);if(noisyConfigLines(clean).length)throw new Error(`Không làm sạch được cấu hình ${lang}.traineddata.`);
  await writeFile(resolve(to,`${lang}.traineddata`),clean);
 }
 return {to,removed};
}

// True when every language file exists and no longer carries the noisy config lines.
export async function tessdataIsClean(dir=RUNTIME_TESSDATA){
 try{for(const lang of LANGUAGES)if(noisyConfigLines(await readFile(resolve(dir,`${lang}.traineddata`))).length)return false;return true;}
 catch{return false;}
}

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(process.argv[1]&&samePath(fileURLToPath(import.meta.url),resolve(process.argv[1]))){
 const option=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;},from=option('--from')||null;
 try{
  const result=await prepareTessdata({from,to:option('--to')?resolve(option('--to')):RUNTIME_TESSDATA});
  console.log(`PDF OCR language data prepared (${LANGUAGES.join(' + ')}) in ${result.to}; removed config lines: ${Object.entries(result.removed).map(([lang,keys])=>`${lang}=${keys.length}`).join(', ')}.`);
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  // The default source is the copy setup step 2 makes from node_modules; name the missing file instead of a stack trace.
  console.error(`LỖI: thiếu ${error.path}.${from?'':' Bước 2 của cài đặt chép dữ liệu này vào frontend/vendor/tessdata: chạy "npm run setup" (Windows: bấm đúp start.cmd) rồi chạy lại.'}`);
  process.exitCode=1;
 }
}
