import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {cleanTraineddata,noisyConfigLines,NOISY_CONFIG_KEYS} from '../services/pdf-layout/tessdata.mjs';
import {pythonFailureMessage,withoutTesseractNoise,stderrTail} from '../services/pdf-layout/engine.mjs';
import {serviceErrorMessage} from './pdf-layout.js';
import {validateLayoutDocument} from '../frontend/pdf-box-layout.js';

const NOISE=`Warning: Parameter not found: language_model_ngram_on
Warning: Parameter not found: allow_blob_division
Error opening data file C:\\Users\\student\\hoa-tri\\.runtime/tessdata/chi_sim_vert.traineddata
Please make sure the TESSDATA_PREFIX environment variable is set to your "tessdata" directory.
Failed loading language 'chi_sim_vert'
Image too small to scale!! (2x36 vs min width of 3)
Line cannot be recognized!!
`;
const components=bytes=>{const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getInt32(0,true),offsets=Array.from({length:count},(_,i)=>Number(view.getBigInt64(4+i*8,true)));return offsets.map(start=>start===-1?null:Buffer.from(bytes.subarray(start,Math.min(bytes.length,...offsets.filter(o=>o>start)))));};

test('chi_sim language data loses only the noisy config lines; every model component stays byte-identical',()=>{
 const raw=new Uint8Array(gunzipSync(readFileSync(new URL('../frontend/vendor/tessdata/chi_sim.traineddata.gz',import.meta.url))));
 assert.deepEqual(new Set(noisyConfigLines(raw)),NOISY_CONFIG_KEYS);
 const clean=cleanTraineddata(raw),before=components(raw),after=components(clean);
 assert.deepEqual(noisyConfigLines(clean),[]);
 for(let i=1;i<before.length;i++)assert.ok(before[i]===null?after[i]===null:before[i].equals(after[i]),`component ${i} must be unchanged`);
 const config=after[0].toString('utf8');
 assert.match(config,/tessedit_char_blacklist/u,'recognition settings such as the character blacklist are kept');
 assert.match(config,/textord_use_cjk_fp_model T/u);
 assert.doesNotMatch(config,/chi_sim_vert|language_model_ngram_on/u);
 assert.ok(Buffer.from(cleanTraineddata(clean)).equals(Buffer.from(clean)),'cleaning is idempotent');
});

test('eng language data has nothing to clean and is returned unchanged',()=>{
 const raw=new Uint8Array(gunzipSync(readFileSync(new URL('../frontend/vendor/tessdata/eng.traineddata.gz',import.meta.url))));
 assert.deepEqual(noisyConfigLines(raw),[]);assert.equal(cleanTraineddata(raw),raw);
});

test('a structured Python error wins over any amount of native OCR output',()=>{
 const message=pythonFailureMessage({code:1,stdout:JSON.stringify({error:'Trang 7 có ảnh quá lớn.'}),stderr:NOISE.repeat(400)});
 assert.equal(message,'Trang 7 có ảnh quá lớn.');
});

test('abnormal exits become one short Vietnamese sentence without OCR noise',()=>{
 for(const outcome of [{code:3221225477},{code:null,signal:'SIGKILL'},{code:null,signal:'SIGSEGV'},{killedForSize:true},{timedOut:true},{code:1,stderr:NOISE},{code:1,stderr:NOISE+'Traceback (most recent call last):\nMemoryError'}]){
  const message=pythonFailureMessage(outcome);
  assert.ok(message.length<320,`short message for ${JSON.stringify(outcome)}`);
  assert.doesNotMatch(message,/Parameter not found|chi_sim_vert|TESSDATA_PREFIX/u);
  assert.match(message,/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/u,'message is Vietnamese');
 }
 assert.match(pythonFailureMessage({code:3221225477}),/0xC0000005/u);
 assert.match(pythonFailureMessage({code:null,signal:'SIGKILL'}),/hết bộ nhớ/u);
 assert.match(pythonFailureMessage({code:1,stderr:NOISE+'Traceback (most recent call last):\nMemoryError'}),/MemoryError/u);
 // The Microsoft Store "python" shortcut exits 9009 with text in the console code page (garbled as UTF-8 on Vietnamese Windows).
 const shortcut=pythonFailureMessage({code:9009,stderr:Buffer.from([0x50,0x79,0x74,0x68,0x6f,0x6e,0x20,0x74,0xec,0x6d,0x20,0x74,0x68]).toString('utf8')});
 assert.match(shortcut,/Microsoft Store/u);assert.match(shortcut,/npm run setup/u);assert.doesNotMatch(shortcut,/�/u);
 assert.equal(withoutTesseractNoise(NOISE),'');
});

test('any Windows crash code is reported as a crash with advice, never as "PyMuPDF could not run"',()=>{
 assert.match(pythonFailureMessage({code:3221226356}),/dừng đột ngột .*0xC0000374: hỏng vùng nhớ heap/u);
 const unknown=pythonFailureMessage({code:0xC0000135});
 assert.match(unknown,/dừng đột ngột .*0xC0000135: lỗi hệ thống/u);assert.match(unknown,/Hãy thử lại/u);
 assert.match(pythonFailureMessage({code:2}),/mã thoát 2/u,'an ordinary exit code is not mistaken for a crash');
});

test('a trimmed stderr tail starts at a line boundary, so no fragment of OCR noise reaches the student',()=>{
 const stderr='x'.repeat(30)+'\n'+NOISE.repeat(30)+'Traceback (most recent call last):\nOSError: real cause\n';
 const tail=stderrTail(stderr,200);
 assert.ok(tail.length<=200);assert.ok(stderr.endsWith(tail));
 assert.ok(tail===stderr.slice(-tail.length)&&stderr[stderr.length-tail.length-1]==='\n','tail begins right after a newline');
 assert.equal(pythonFailureMessage({code:1,stderr:tail}),'Dịch vụ PDF gặp lỗi: OSError: real cause');
 assert.equal(withoutTesseractNoise("Tesseract couldn't load any languages!\nCould not initialize tesseract.\nkept"),'kept');
});

test('the Worker keeps only the meaningful sentence from an older service, and bounds any message',()=>{
 const legacy=NOISE.repeat(45)+'Ảnh của các trang PDF quá lớn. Hãy chọn ít trang hơn cho mỗi lượt.';
 assert.equal(serviceErrorMessage(legacy,422),'Ảnh của các trang PDF quá lớn. Hãy chọn ít trang hơn cho mỗi lượt.');
 assert.equal(serviceErrorMessage(NOISE,422),'Không xử lý được PDF (dịch vụ trả mã 422).');
 assert.ok(serviceErrorMessage('x'.repeat(5000),422).length<=400);
 assert.equal(serviceErrorMessage("Failed loading language 'eng'\nTesseract couldn't load any languages!\nCould not initialize tesseract.\nTrang 1 là scan nhưng không chạy được OCR Tesseract.",422),'Trang 1 là scan nhưng không chạy được OCR Tesseract.');
});

// Page limits, skipped pages, OCR start-up failures and MuPDF warnings run through the real PyMuPDF pipeline.
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=`${root}.runtime/pdf-python`,tessdata=process.env.TESSDATA_PREFIX||`${root}.runtime/tessdata`,python=process.env.PDF_PYTHON||'python';
const ready=existsSync(runtime)&&existsSync(`${tessdata}/chi_sim.traineddata`)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
test('extract.py: pages that never fit are skipped, full runs name what is left, scan failures name their real cause',{skip:ready?false:'needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)',timeout:300000},()=>{
 const run=spawnSync(python,[`${root}services/pdf-layout/test_extract_limits.py`],{encoding:'utf8',windowsHide:true,timeout:280000,env:{...process.env,PYTHONPATH:[runtime,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',TESSDATA_PREFIX:tessdata}});
 assert.equal(run.status,0,`${run.stdout||''}\n${run.stderr||''}`.slice(-6000));
 assert.match(run.stderr,/\bOK\b/u);
});

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const documentWith=image=>({version:1,totalPages:1,pages:[{number:1,width:100,height:100,original:image,background:image,blocks:[{id:'p1-b1',text:'中文',source:'中文',box:[0,0,50,20],fontSize:10,bold:false,color:'#202020',inlines:[]}],images:[],drawings:[]}]});
test('scanned page images may be JPEG; other image types are still rejected',()=>{
 assert.doesNotThrow(()=>validateLayoutDocument(documentWith(`data:image/jpeg;base64,${pixel}`)));
 assert.doesNotThrow(()=>validateLayoutDocument(documentWith(`data:image/png;base64,${pixel}`)));
 assert.throws(()=>validateLayoutDocument(documentWith(`data:image/gif;base64,${pixel}`)),/Ảnh trang PDF không hợp lệ/u);
 assert.throws(()=>validateLayoutDocument(documentWith('javascript:alert(1)')),/Ảnh trang PDF không hợp lệ/u);
});
