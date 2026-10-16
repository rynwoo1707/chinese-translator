import {mkdir,copyFile,access,cp} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await Promise.all([
 mkdir('frontend/vendor',{recursive:true}),
 mkdir('frontend/vendor/tesseract-core',{recursive:true}),
 mkdir('frontend/vendor/tessdata',{recursive:true})
]);

await mkdir('frontend/vendor/paddle',{recursive:true});
for(const file of ['det.tar','rec.tar']){
 await access(`frontend/vendor/paddle/models/${file}`).catch(()=>{throw new Error('Thiếu mô hình PaddleOCR. Chạy npm run prepare:ocr một lần trước khi build/dev.');});
}
// Use the installed WASM-only runtime in both bundle and loader, with single-thread inference.
await build({absWorkingDir:root,entryPoints:[fileURLToPath(new URL('../frontend/paddle-worker.js',import.meta.url))],outfile:fileURLToPath(new URL('../frontend/vendor/paddle/worker.js',import.meta.url)),bundle:true,format:'esm',platform:'browser',minify:true,alias:{'onnxruntime-web':'onnxruntime-web/wasm'},external:['fs','path','crypto'],define:{'process.versions.node':'undefined'}});
await Promise.all(['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(file=>copyFile(`node_modules/onnxruntime-web/dist/${file}`,`frontend/vendor/paddle/${file}`)));
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
