// This machine's PDF engine settings, read the way services/pdf-layout/local.mjs reads them, and the Python helper.
import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT} from './paths.mjs';

// Only these .dev.vars entries are ever read; Gemini keys are not among them.
const READABLE=new Set(['PDF_PYTHON','CHROMIUM_EXECUTABLE_PATH','PDF_FONT_PATH','ADMIN_TOKEN']);
export function devVar(key,{file=resolve(ROOT,'.dev.vars')}={}){
 if(!READABLE.has(key))throw new Error(`Công cụ ví dụ mẫu không đọc ${key} trong .dev.vars.`);
 let text='';try{text=readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 const matches=[...text.matchAll(new RegExp(`^${key}=([^\\r\\n]*)`,'gmu'))];
 return matches.at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';
}
// Machine-specific paths written by `npm run setup`; a value set in the shell still wins (as in local.mjs).
export function prepareEngineEnv(){
 for(const key of ['PDF_PYTHON','CHROMIUM_EXECUTABLE_PATH','PDF_FONT_PATH'])if(!process.env[key]&&devVar(key))process.env[key]=devVar(key);
}
export const RUNTIME_PYTHONPATH=resolve(ROOT,'.runtime/pdf-python');
const TOOL=resolve(ROOT,'tools/samples/pdf_tool.py');
export function pythonEnv(){
 const tessdata=resolve(ROOT,'.runtime/tessdata');
 return {...process.env,PYTHONPATH:[RUNTIME_PYTHONPATH,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',...(process.env.TESSDATA_PREFIX||!existsSync(tessdata)?{}:{TESSDATA_PREFIX:tessdata})};
}
// pdf_tool.py prints one JSON object on its last stdout line; a failure is {"error": "..."} with exit code 1.
export function pdfTool(args,{input='',timeout=600000}={}){
 return new Promise((done,fail)=>{
  const python=process.env.PDF_PYTHON||'python',child=spawn(python,[TOOL,...args.map(String)],{windowsHide:true,env:pythonEnv(),stdio:['pipe','pipe','pipe']});
  const out=[];let err='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?fail(error):done(value);};
  const timer=setTimeout(()=>{child.kill();finish(new Error(`pdf_tool.py ${args[0]} chạy quá ${timeout/1000} giây.`));},timeout);
  child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>{err=(err+chunk.toString('utf8')).slice(-6000);});
  child.on('error',error=>finish(new Error(error.code==='ENOENT'?`Không tìm thấy Python (${python}). Chạy "npm run setup" hoặc đặt PDF_PYTHON.`:error.message)));
  child.on('close',code=>{
   const lines=Buffer.concat(out).toString('utf8').trim().split(/\r?\n/u);let result=null;try{result=JSON.parse(lines.at(-1));}catch{}
   if(code===0&&result&&!result.error)return finish(null,result);
   if(code===9009)return finish(new Error('Lệnh "python" đang mở lối tắt Microsoft Store: cài Python 3 từ python.org rồi chạy "npm run setup".'));
   finish(new Error(result?.error||`pdf_tool.py ${args[0]} lỗi (mã ${code}): ${err.split(/\r?\n/u).filter(Boolean).at(-1)||'không rõ nguyên nhân'}`));
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
