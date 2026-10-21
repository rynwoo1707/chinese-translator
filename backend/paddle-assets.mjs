// PaddleOCR for the in-browser OCR. Its two models ship in the repo (backend/paddle-models/, see the README there):
// checked offline by size, tar signature and SHA-256 against manifest.json, then installed into frontend/vendor/paddle/
// with the worker bundle and the ONNX Runtime files. PaddleOCR is optional: without it the browser reads scans with
// Tesseract, so nothing here stops an install or the app unless `require` is set (CI and deploy).
import {readFileSync} from 'node:fs';
import {copyFile,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

export const MODELS_DIR='backend/paddle-models',MODEL_FILES=['det.tar','rec.tar'];
export const TESSERACT_FALLBACK='OCR trong trình duyệt sẽ dùng Tesseract (chậm hơn, đọc chữ Trung kém hơn).';
export const RESTORE_HINT='Lấy lại bằng: git checkout -- backend/paddle-models';
const ORT_FILES=['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'];
const LFS_POINTER='version https://git-lfs';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// {ok, problem, models}: `models` lists the manifest entries with their absolute `path` once manifest.json is valid.
export function checkPaddleModels(root){
 const folder=join(root,MODELS_DIR);let manifest;
 try{manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));}
 catch(error){return {ok:false,problem:error.code==='ENOENT'?`Thiếu ${MODELS_DIR}/manifest.json.`:`Không đọc được ${MODELS_DIR}/manifest.json (${error.code||'JSON hỏng'}).`,models:[]};}
 const list=Array.isArray(manifest?.models)?manifest.models:[];
 if(list.length!==MODEL_FILES.length||!MODEL_FILES.every(file=>list.filter(model=>model?.file===file).length===1)||!list.every(model=>Number.isSafeInteger(model.bytes)&&model.bytes>0&&/^[0-9a-f]{64}$/u.test(model.sha256||'')))return {ok:false,problem:`${MODELS_DIR}/manifest.json không hợp lệ: cần đúng hai mục ${MODEL_FILES.join(' và ')}, mỗi mục có bytes và sha256.`,models:[]};
 const models=list.map(model=>({...model,path:join(folder,model.file)})),problems=[];
 for(const model of models){
  const name=`${MODELS_DIR}/${model.file}`;let bytes;
  try{bytes=readFileSync(model.path);}catch(error){problems.push(error.code==='ENOENT'?`Thiếu ${name}.`:`Không đọc được ${name} (${error.code||error.message}).`);continue;}
  if(bytes.subarray(0,LFS_POINTER.length).toString('latin1')===LFS_POINTER)problems.push(`${name} chỉ là con trỏ Git LFS (${bytes.length} byte), không phải mô hình.`);
  else if(bytes.length!==model.bytes)problems.push(`${name} có ${bytes.length} byte thay vì ${model.bytes}: tệp bị cắt hoặc bị thay.`);
  else if(bytes.subarray(257,262).toString('latin1')!=='ustar')problems.push(`${name} không phải tệp tar.`);
  else if(sha256(bytes)!==model.sha256)problems.push(`${name} khác bản đã kiểm thử (SHA-256 không khớp manifest.json).`);
 }
 return {ok:!problems.length,problem:problems.join(' '),models};
}

const matches=async(file,model)=>{try{const bytes=await readFile(file);return bytes.length===model.bytes&&sha256(bytes)===model.sha256;}catch{return false;}};
const detail=error=>error?.errors?.[0]?.text||String(error?.message||error).split(/\r?\n/u)[0];

// {installed, reason}. When PaddleOCR cannot be installed, its old files are removed: the browser then gets a 404 for
// /vendor/paddle/worker.js at once and switches to Tesseract, instead of loading an old worker that fails on the models.
export async function installPaddle({root,out=join(root,'frontend','vendor','paddle'),require:required=false,log=console}={}){
 const check=checkPaddleModels(root);let reason=check.problem,fix=RESTORE_HINT;
 if(check.ok)try{
  // Files already identical are left alone: npm run dev runs this each time, maybe while the app serves them.
  const models=join(out,'models');await mkdir(models,{recursive:true});
  for(const model of check.models){
   const target=join(models,model.file);if(await matches(target,model))continue;
   await copyFile(model.path,`${target}.tmp`);
   if(!await matches(`${target}.tmp`,model))throw new Error(`bản chép ${model.file} khác SHA-256 trong manifest.json`);
   await rename(`${target}.tmp`,target);
  }
  const manifest=await readFile(join(root,MODELS_DIR,'manifest.json'),'utf8'),saved=join(models,'manifest.json');
  if(await readFile(saved,'utf8').catch(()=>null)!==manifest){await writeFile(`${saved}.tmp`,manifest);await rename(`${saved}.tmp`,saved);}
  // Anything else in that folder (the .tmp file of an interrupted copy) would be deployed with the models.
  for(const name of await readdir(models))if(![...MODEL_FILES,'manifest.json'].includes(name))await rm(join(models,name),{recursive:true,force:true});
  // Loaded here, not at the top: setup.mjs and deploy.mjs import this file for the check alone.
  const {build}=await import('esbuild');
  // Use the installed WASM-only runtime in both bundle and loader, with single-thread inference.
  await build({absWorkingDir:root,entryPoints:[join(root,'frontend','paddle-worker.js')],outfile:join(out,'worker.js'),bundle:true,format:'esm',platform:'browser',minify:true,alias:{'onnxruntime-web':'onnxruntime-web/wasm'},external:['fs','path','crypto'],define:{'process.versions.node':'undefined'}});
  // One at a time: after a failure no copy may still be running while the cleanup below removes the files.
  for(const file of ORT_FILES)await copyFile(join(root,'node_modules','onnxruntime-web','dist',file),join(out,file));
  return {installed:true,reason:''};
 }catch(error){reason=`Chưa cài được PaddleOCR cho trình duyệt (${detail(error)}).`;fix='Chạy lại "npm ci" rồi "npm run prepare:vendor".';}
 const kept=[];
 for(const name of ['worker.js',...ORT_FILES,'models'])await rm(join(out,name),{recursive:true,force:true}).catch(()=>kept.push(join(out,name)));
 if(required)throw new Error(`${reason} ${fix}`);
 log.warn(`CẢNH BÁO: ${reason} ${TESSERACT_FALLBACK} ${fix}${kept.length?` Chưa xóa được ${kept.join(', ')} (tắt Hoa Trí rồi chạy lại).`:''}`);
 return {installed:false,reason};
}
