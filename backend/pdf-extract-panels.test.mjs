import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Boxed, tinted and shaded text on scanned pages (services/pdf-layout/extract.py retint, page_objects, ruled_cells,
// body_rows, unchain, separate): tinted panels, cards, margin notes, text on a shade, ruled tables cell by cell (in
// small print too), a line touching a photograph and figure margins are read, frames, rules and pictures stay as
// printed, also tilted by up to 3 degrees, and rows on a grainy panel never share a text box; checked on a synthetic
// scan through the real PyMuPDF + Tesseract pipeline; the cases live in the Python file.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;

// The file runs as two processes (its classes named), so that neither nears the 280 s limit on a runner slower than a
// desktop (CI's extracts about five times slower); together they run every test class of the file.
const file=`${root}services/pdf-layout/test_scan_panels.py`,PARTS=[['Tinted, shaded and boxed text, ruled tables, figure margins and grainy panels of scanned pages',['Panels','MisreadCell','Rules']],['Tilted boxes and tables, short ruled tables and dashed drawings of scanned pages',['TiltedTablesAndDrawings']]];
test('The two runs of the panels file take every test class in it',()=>{
 assert.deepEqual([...readFileSync(file,'utf8').matchAll(/^class (\w+)\([^)]*TestCase\)/gmu)].map(match=>match[1]).sort(),PARTS.flatMap(([,classes])=>classes).sort());
});
for(const [title,classes] of PARTS)test(title,{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[file,...classes],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
