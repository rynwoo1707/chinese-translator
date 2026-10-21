import {mkdir,copyFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {installPaddle} from './paddle-assets.mjs';
// The paths below are relative to the project root (PaddleOCR gets it as `root`), whichever folder this starts from.
const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);
// What the app cannot start without (frontend/vendor/pdf.mjs above all) comes first; a failure here is a LỖI (exit
// code 1, set rather than process.exit so the message reaches a piped reader such as deploy.mjs in full).
let copied=true;
try{
 await Promise.all([
  mkdir('frontend/vendor',{recursive:true}),
  mkdir('frontend/vendor/tesseract-core',{recursive:true}),
  mkdir('frontend/vendor/tessdata',{recursive:true})
 ]);
 await Promise.all([
  copyFile('node_modules/pdfjs-dist/build/pdf.mjs','frontend/vendor/pdf.mjs'),
  copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs','frontend/vendor/pdf.worker.mjs'),
  // What pdf.js loads to draw every page (PDFJS_ASSETS in frontend/cover-detect.js): CMaps for non-embedded Chinese
  // fonts, the standard fonts, and the CCITT/JBIG2/JPEG 2000 decoders of scans; the script engine (quickjs) is not used.
  cp('node_modules/pdfjs-dist/cmaps','frontend/vendor/cmaps',{recursive:true}),
  cp('node_modules/pdfjs-dist/standard_fonts','frontend/vendor/standard_fonts',{recursive:true}),
  cp('node_modules/pdfjs-dist/wasm','frontend/vendor/wasm',{recursive:true,filter:source=>!/quickjs/u.test(source)}),
  // The library reader joins a book's translated PDF parts in the browser ("Tải cả quyển"); loaded only on that click.
  copyFile('node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.min.js','frontend/vendor/pdf-lib.esm.min.js'),
  copyFile('node_modules/tesseract.js/dist/tesseract.esm.min.js','frontend/vendor/tesseract.esm.min.js'),
  copyFile('node_modules/tesseract.js/dist/worker.min.js','frontend/vendor/tesseract.worker.min.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core.wasm.js','frontend/vendor/tesseract-core/tesseract-core.wasm.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core-simd.wasm.js','frontend/vendor/tesseract-core/tesseract-core-simd.wasm.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm.js','frontend/vendor/tesseract-core/tesseract-core-relaxedsimd.wasm.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js','frontend/vendor/tesseract-core/tesseract-core-lstm.wasm.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js','frontend/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js'),
  copyFile('node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js','frontend/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js'),
  copyFile('node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz','frontend/vendor/tessdata/chi_sim.traineddata.gz'),
  copyFile('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz','frontend/vendor/tessdata/eng.traineddata.gz')
 ]);
}catch(error){copied=false;process.exitCode=1;console.error(`LỖI: Chưa chép được thư viện giao diện vào frontend/vendor (${error.message}). Chạy "npm ci" rồi chạy lại.`);}
// PaddleOCR is optional: without its models or bundle the browser OCR uses Tesseract, so this only warns (and removes
// stale Paddle files). CI and deploy pass --require-paddle, because production must ship it.
if(copied)await installPaddle({root,require:process.argv.includes('--require-paddle')}).catch(error=>{process.exitCode=1;console.error(`LỖI: PaddleOCR là bắt buộc khi chạy với --require-paddle. ${error.message}`);});
