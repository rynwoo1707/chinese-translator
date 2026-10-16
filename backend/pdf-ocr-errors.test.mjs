import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {cleanTraineddata,noisyConfigLines,NOISY_CONFIG_KEYS} from '../services/pdf-layout/tessdata.mjs';
import {pythonFailureMessage,withoutTesseractNoise} from '../services/pdf-layout/engine.mjs';
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

test('the Worker keeps only the meaningful sentence from an older service, and bounds any message',()=>{
 const legacy=NOISE.repeat(45)+'Ảnh của các trang PDF quá lớn. Hãy chọn ít trang hơn cho mỗi lượt.';
 assert.equal(serviceErrorMessage(legacy,422),'Ảnh của các trang PDF quá lớn. Hãy chọn ít trang hơn cho mỗi lượt.');
 assert.equal(serviceErrorMessage(NOISE,422),'Không xử lý được PDF (dịch vụ trả mã 422).');
 assert.ok(serviceErrorMessage('x'.repeat(5000),422).length<=400);
});

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const documentWith=image=>({version:1,totalPages:1,pages:[{number:1,width:100,height:100,original:image,background:image,blocks:[{id:'p1-b1',text:'中文',source:'中文',box:[0,0,50,20],fontSize:10,bold:false,color:'#202020',inlines:[]}],images:[],drawings:[]}]});
test('scanned page images may be JPEG; other image types are still rejected',()=>{
 assert.doesNotThrow(()=>validateLayoutDocument(documentWith(`data:image/jpeg;base64,${pixel}`)));
 assert.doesNotThrow(()=>validateLayoutDocument(documentWith(`data:image/png;base64,${pixel}`)));
 assert.throws(()=>validateLayoutDocument(documentWith(`data:image/gif;base64,${pixel}`)),/Ảnh trang PDF không hợp lệ/u);
 assert.throws(()=>validateLayoutDocument(documentWith('javascript:alert(1)')),/Ảnh trang PDF không hợp lệ/u);
});
