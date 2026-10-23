import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Shapes of born-digital text layers (services/pdf-layout/extract.py) that were read wrong: a symbol font's runs, rare
// characters and unreadable spans stay in their line; pinyin and emphasis dots are markup while glosses, credits,
// limits and a reaction's conditions are not; drawn signs are no blanks; short last lines, tight ruled tables and
// columns of one-character cells; lines cut by a picture, a drawing or letter-spacing; watermarks and pictures of
// English text keep a page born-digital; reading order below two columns, a smaller scan, boxes of one-line blocks,
// a wrapped citation and the time budget setting; pinyin with erhua, quotes or digits, a figure's labels and a
// table's header side by side, one-character columns of three-line tables, a longer column after a heading or a
// figure, paragraphs on ruled or graph paper and compound paths of many strokes. The cases live in the Python file
// and run through the real PyMuPDF pipeline with OCR stubbed.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;

test('Text layers keep formulas, small print, tables and split lines as the reader sees them',{skip:ready?false:'needs Python with .runtime/pdf-python (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_text_layer_shapes.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1'}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
