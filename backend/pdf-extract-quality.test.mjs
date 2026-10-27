import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {serviceHandler,extractQuality} from '../services/pdf-layout/server.mjs';

// Coarse scans and the 'fine' quality (services/pdf-layout/extract.py): letter subscripts and capitals with a kerned
// subscript stay one formula crop, a cases system keeps its pixels, headings on tinted tabs and short lines Tesseract
// misreads whole are still translated, the scan's resolution is recorded and a low one is said, and quality 'fine'
// cuts finer OCR sheets. The cases live in the Python file and run through the real PyMuPDF + Tesseract pipeline; the
// service's part (the Worker's X-PDF-Quality header becoming the payload's quality) is checked here without Python.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&existsSync(`${tessdata}/eng.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('X-PDF-Quality: fine reaches extract.py as quality fine; anything else, or no header, is standard',async t=>{
 assert.equal(extractQuality('fine'),'fine');assert.equal(extractQuality(' FINE '),'fine');
 for(const value of [undefined,null,'','standard','high','fine,fine',['fine']])assert.equal(extractQuality(value),'standard',String(value));
 const TOKEN='t'.repeat(40),seen=[];
 const operations={pythonOperation:async payload=>{seen.push(payload.quality);return {document:{version:1,pages:[{number:1,width:600,height:800,background:PNG,original:PNG,blocks:[]}]},originalPdfBase64:'JVBERi0='};},renderDocument:async()=>({}),fontCss:async()=>''};
 const server=createServer(serviceHandler({token:TOKEN,operations,version:null,log:()=>{}}).handler);
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const post=(headers,body='%PDF-1.7 stand-in',type='application/pdf')=>fetch(`http://127.0.0.1:${server.address().port}/extract`,{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':type,...headers},body});
 // the Worker sends the PDF itself with its page range and, for the "Kỹ nhất" mode, X-PDF-Quality: fine
 assert.equal((await post({'X-PDF-Pages':'1','X-PDF-Quality':'fine'})).status,200);
 assert.equal((await post({'X-PDF-Pages':'1'})).status,200);
 assert.equal((await post({'X-PDF-Pages':'1','X-PDF-Quality':'ultra'})).status,200);
 // a JSON request keeps its own quality field unless the header says otherwise
 const json=JSON.stringify({pdfBase64:'JVBERi0=',pages:'1',quality:'fine'});
 assert.equal((await post({},json,'application/json')).status,200);
 assert.equal((await post({'X-PDF-Quality':'standard'},json,'application/json')).status,200);
 assert.deepEqual(seen,['fine','standard','standard','fine','standard']);
});

test('Coarse scans keep letter subscripts in one formula, cases systems as pixels, headings on tabs and short lines; fine quality cuts finer sheets',{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_scan_quality.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});
