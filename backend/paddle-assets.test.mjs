import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPaddleModels,installPaddle,MODEL_FILES,MODELS_DIR} from './paddle-assets.mjs';

// No network anywhere: the PaddleOCR models ship in the repo (backend/paddle-models/README.md), and a missing or damaged
// copy must only cost the browser its PaddleOCR (Tesseract takes over), never the install or the app.
const root=fileURLToPath(new URL('../',import.meta.url)),models=join(root,MODELS_DIR);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=()=>JSON.parse(readFileSync(join(models,'manifest.json'),'utf8'));
const temp=[];test.after(()=>{for(const dir of temp)rmSync(dir,{recursive:true,force:true});});
const tempDir=()=>{const dir=mkdtempSync(join(tmpdir(),'hoa-tri-paddle-'));temp.push(dir);return dir;};
const write=(file,data)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data);return file;};
const PADDLE_OUTPUTS=['worker.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm','models'];
// A miniature model folder: two 1 KiB "tars" and their manifest (only size, tar signature and SHA-256 are checked).
function miniature(base=tempDir()){
 const list=MODEL_FILES.map((file,index)=>{const bytes=Buffer.alloc(1024,index+1);bytes.write('ustar',257,'latin1');write(join(base,MODELS_DIR,file),bytes);return {name:file,file,bytes:bytes.length,sha256:sha256(bytes)};});
 write(join(base,MODELS_DIR,'manifest.json'),`${JSON.stringify({sdk:'test',models:list},null,2)}\n`);
 return base;
}

test('The PaddleOCR models in the repo match manifest.json byte for byte (a truncated copy or a Git LFS pointer fails)',()=>{
 const {sdk,models:list}=manifest(),pinned=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies['@paddleocr/paddleocr-js'];
 assert.equal(sdk,`@paddleocr/paddleocr-js@${pinned}`,'the models are the ones tested with the SDK version package.json installs');
 assert.deepEqual(list.map(model=>model.file),MODEL_FILES);
 for(const model of list){
  const bytes=readFileSync(join(models,model.file));
  assert.ok(!bytes.subarray(0,64).toString('latin1').startsWith('version https://git-lfs'),`${model.file} is a Git LFS pointer, not the model`);
  assert.equal(bytes.length,model.bytes,model.file);assert.equal(bytes.subarray(257,262).toString('latin1'),'ustar',`${model.file}: an uncompressed tar`);
  assert.equal(sha256(bytes),model.sha256,model.file);
  assert.ok(model.bytes<=25*1024*1024,`${model.file}: Cloudflare Workers serves static files up to 25 MiB`);
  assert.match(model.url,/^https:\/\/paddle-model-ecology\.bj\.bcebos\.com\/.+_onnx_infer\.tar$/u,'url records where the file came from');
 }
 const check=checkPaddleModels(root);
 assert.deepEqual({ok:check.ok,problem:check.problem},{ok:true,problem:''});assert.deepEqual(check.models.map(model=>model.path),MODEL_FILES.map(file=>join(models,file)));
});

test('The models come with the Apache-2.0 licence text and a README naming each file, its SHA-256 and its source',()=>{
 const license=readFileSync(join(models,'LICENSE'),'utf8'),readme=readFileSync(join(models,'README.md'),'utf8');
 assert.match(license,/Apache License/u);assert.match(license,/Version 2\.0/u);
 for(const model of manifest().models)for(const value of [model.file,model.name,model.sha256,model.url])assert.ok(readme.includes(value),`README.md: ${value}`);
 assert.match(readme,/Apache/u);assert.match(readme,/hoa-tri-paddle-v5-0\.4\.2/u,'the update steps name the browser cache to rename');
});

test('checkPaddleModels names what is wrong: no or broken manifest, a missing, truncated, altered or non-tar file, a Git LFS pointer',()=>{
 assert.equal(checkPaddleModels(miniature()).ok,true);
 const file=(base,name)=>join(base,MODELS_DIR,name),edit=(path,change)=>{const bytes=readFileSync(path);change(bytes);writeFileSync(path,bytes);};
 const cases=[
  [base=>rmSync(file(base,'manifest.json')),/^Thiếu backend\/paddle-models\/manifest\.json\.$/u],
  [base=>writeFileSync(file(base,'manifest.json'),'{"models":'),/^Không đọc được backend\/paddle-models\/manifest\.json \(JSON hỏng\)\.$/u],
  [base=>writeFileSync(file(base,'manifest.json'),'{"models":[{"file":"det.tar","bytes":1024,"sha256":"x"}]}'),/^backend\/paddle-models\/manifest\.json không hợp lệ/u],
  [base=>rmSync(file(base,'det.tar')),/^Thiếu backend\/paddle-models\/det\.tar\.$/u],
  [base=>writeFileSync(file(base,'rec.tar'),readFileSync(file(base,'rec.tar')).subarray(0,700)),/^backend\/paddle-models\/rec\.tar có 700 byte thay vì 1024: tệp bị cắt hoặc bị thay\.$/u],
  [base=>writeFileSync(file(base,'det.tar'),'version https://git-lfs.github.com/spec/v1\noid sha256:781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30\nsize 4843520\n'),/^backend\/paddle-models\/det\.tar chỉ là con trỏ Git LFS \(\d+ byte\), không phải mô hình\.$/u],
  [base=>edit(file(base,'rec.tar'),bytes=>{bytes[600]^=1;}),/^backend\/paddle-models\/rec\.tar khác bản đã kiểm thử \(SHA-256 không khớp manifest\.json\)\.$/u],
  [base=>edit(file(base,'det.tar'),bytes=>{bytes.write('xxxxx',257,'latin1');}),/^backend\/paddle-models\/det\.tar không phải tệp tar\.$/u],
  [base=>{rmSync(file(base,'det.tar'));writeFileSync(file(base,'rec.tar'),'');},/^Thiếu backend\/paddle-models\/det\.tar\. backend\/paddle-models\/rec\.tar có 0 byte thay vì 1024/u]
 ];
 for(const [damage,pattern] of cases){const base=miniature();damage(base);const result=checkPaddleModels(base);assert.equal(result.ok,false,pattern.source);assert.match(result.problem,pattern);}
});

test('installPaddle without usable models: one warning, no throw, the old Paddle files removed; with require it throws',async()=>{
 const base=tempDir(),vendor=join(base,'frontend','vendor'),out=join(vendor,'paddle');
 const plant=()=>{for(const name of ['worker.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm','models/det.tar','models/manifest.json'])write(join(out,name),'old');};
 plant();write(join(vendor,'pdf.mjs'),'core');const warnings=[];
 const result=await installPaddle({root:base,log:{warn:line=>warnings.push(line)}});
 assert.equal(result.installed,false);assert.equal(result.reason,'Thiếu backend/paddle-models/manifest.json.');
 assert.deepEqual(warnings,['CẢNH BÁO: Thiếu backend/paddle-models/manifest.json. OCR trong trình duyệt sẽ dùng Tesseract (chậm hơn, đọc chữ Trung kém hơn). Lấy lại bằng: git checkout -- backend/paddle-models']);
 assert.deepEqual(readdirSync(out),[],'the browser gets a 404 for /vendor/paddle/worker.js at once and reads scans with Tesseract');
 assert.equal(readFileSync(join(vendor,'pdf.mjs'),'utf8'),'core','only the Paddle files are touched');
 plant();
 await assert.rejects(installPaddle({root:base,require:true,log:{warn:()=>assert.fail('a required install throws instead of warning')}}),/Thiếu backend\/paddle-models\/manifest\.json\. Lấy lại bằng: git checkout -- backend\/paddle-models$/u);
 assert.deepEqual(readdirSync(out),[]);
});

test('installPaddle: a failure halfway (here the ONNX Runtime files are missing) removes what that run had written',async()=>{
 const base=miniature(),out=join(base,'frontend','vendor','paddle'),warnings=[];
 write(join(base,'frontend','paddle-worker.js'),'self.onmessage=()=>self.postMessage("ok");\n');
 const result=await installPaddle({root:base,log:{warn:line=>warnings.push(line)}});
 assert.equal(result.installed,false);assert.match(result.reason,/^Chưa cài được PaddleOCR cho trình duyệt \(ENOENT.*ort-wasm-simd-threaded\.mjs/u);
 assert.equal(warnings.length,1);assert.match(warnings[0],/^CẢNH BÁO: Chưa cài được PaddleOCR cho trình duyệt .* OCR trong trình duyệt sẽ dùng Tesseract .*"npm ci"/u);
 assert.deepEqual(readdirSync(out),[],'the models and the worker bundle written before the failure are gone');
 await assert.rejects(installPaddle({root:base,require:true}),/Chưa cài được PaddleOCR cho trình duyệt/u);
});

test('installPaddle with the models in the repo: the worker bundle, ONNX Runtime and models that match manifest.json',async()=>{
 const out=join(tempDir(),'paddle'),warnings=[],log={warn:line=>warnings.push(line)};
 write(join(out,'models','det.tar.tmp'),'left by an interrupted copy');
 assert.deepEqual(await installPaddle({root,out,log}),{installed:true,reason:''});assert.deepEqual(warnings,[]);
 assert.deepEqual(readdirSync(out).sort(),[...PADDLE_OUTPUTS].sort());
 assert.ok(statSync(join(out,'worker.js')).size>1024*1024,'the worker bundles PaddleOCR, OpenCV and ONNX Runtime');
 for(const name of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])assert.equal(sha256(readFileSync(join(out,name))),sha256(readFileSync(join(root,'node_modules','onnxruntime-web','dist',name))),name);
 assert.deepEqual(readdirSync(join(out,'models')).sort(),['det.tar','manifest.json','rec.tar'],'nothing else in the folder gets deployed');
 for(const model of manifest().models)assert.equal(sha256(readFileSync(join(out,'models',model.file))),model.sha256,model.file);
 assert.equal(readFileSync(join(out,'models','manifest.json'),'utf8'),readFileSync(join(models,'manifest.json'),'utf8'));
 // npm run dev runs this every time, maybe while the app serves the models: identical copies are left alone.
 const old=new Date('2001-01-01T00:00:00Z');for(const file of MODEL_FILES)utimesSync(join(out,'models',file),old,old);
 assert.equal((await installPaddle({root,out,log})).installed,true);
 assert.deepEqual(MODEL_FILES.map(file=>statSync(join(out,'models',file)).mtime.toISOString()),MODEL_FILES.map(()=>old.toISOString()));
 assert.ok(existsSync(join(out,'worker.js')));assert.deepEqual(warnings,[]);
});
