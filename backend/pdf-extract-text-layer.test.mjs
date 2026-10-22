import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Born-digital pages (services/pdf-layout/extract.py): which pages are scans despite a text layer (an invisible OCR
// layer, text under the scan image, text converted to outlines, a font without a Unicode map), paragraphs joined at any
// line pitch, formulas MuPDF sets apart from their Han line (inline tokens, never across a table column, a rule, a
// figure or a column gutter), blanks to fill in versus the borders of a tight table, radicals and compatibility
// ideographs read as unified ideographs, reading order of columns, vertical and rotated text, specks on a banner, the
// time budget and messages for broken input. The cases live in the Python file and run through the real PyMuPDF
// pipeline.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;

test('Text layers are read as the reader sees them: hidden OCR text means a scan, lines make paragraphs, columns read in order',{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_text_layer.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
