import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Page objects of scanned pages (services/pdf-layout/extract.py): headings printed light on dark bands, figure
// captions, framed callouts against drawings, faint words, mask tones, running footers and grey paper are checked on
// a synthetic scan through the real PyMuPDF + Tesseract pipeline; the cases live in the Python file.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;

test('Banner headings, captions, callout frames, faint words and paper tones of scanned pages',{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_page_objects.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
