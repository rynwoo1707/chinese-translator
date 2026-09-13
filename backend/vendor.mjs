import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('frontend/vendor',{recursive:true});
await Promise.all([
 copyFile('node_modules/pdfjs-dist/build/pdf.mjs','frontend/vendor/pdf.mjs'),
 copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs','frontend/vendor/pdf.worker.mjs')
]);
