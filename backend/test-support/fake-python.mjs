// Stands in for extract.py in tests of the PDF service (no Python, no PyMuPDF). A test starts services/pdf-layout with
// PDF_PYTHON set to Node itself and NODE_OPTIONS=--import=<this file>: every Node process of that test loads it, but it
// only acts in one started as `node …/extract.py`, which it answers or holds without ever letting extract.py load.
//   FAKE_PYTHON       'hang' (read the request, then wait until killed) or 'echo' (answer a one-page document)
//   FAKE_PYTHON_PIDS  a file each fake appends its process id to, so a test can see whether it was stopped
import {appendFileSync} from 'node:fs';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
if(/extract\.py$/u.test(process.argv[1]||'')){
 if(process.env.FAKE_PYTHON_PIDS)appendFileSync(process.env.FAKE_PYTHON_PIDS,`${process.pid}\n`);
 for await(const chunk of process.stdin)void chunk;
 if(process.env.FAKE_PYTHON==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
 const answer=JSON.stringify({document:{version:1,pages:[{number:1,width:600,height:800,background:PNG,original:PNG,blocks:[{id:'p1-b0',source:'空间向量。',box:[20,20,200,80],fontSize:12}]}]},originalPdfBase64:Buffer.from('%PDF-1.7\nfake').toString('base64')});
 // Exits once the answer is written out (a pipe may still be flushing), before Node would load extract.py.
 await new Promise(()=>process.stdout.write(answer,()=>process.exit(0)));
}
