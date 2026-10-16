import {mkdir,writeFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const directory=new URL('../frontend/vendor/paddle/models/',import.meta.url);
await mkdir(directory,{recursive:true});
const origin='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
const manifest={sdk:'@paddleocr/paddleocr-js@0.4.2',models:[]};
for(const [name,file,expectedSha256] of [['PP-OCRv5_mobile_det','det.tar','781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30'],['PP-OCRv5_mobile_rec','rec.tar','f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c']]){
 const target=new URL(file,directory),url=origin+name+'_onnx_infer.tar';
 const response=await fetch(url,{signal:AbortSignal.timeout(120_000)});
 if(!response.ok)throw new Error(`Model ${name}: HTTP ${response.status}`);
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(bytes.length>25*1024*1024)throw new Error(`${name} vượt giới hạn 25 MB của tài nguyên Workers.`);
 if(new TextDecoder().decode(bytes.slice(257,262))!=='ustar')throw new Error(`${name}: cần tar không nén.`);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 if(sha256!==expectedSha256)throw new Error(`${name}: checksum khác phiên bản đã kiểm thử. Không thay mô hình hiện tại.`);
 await writeFile(target,bytes);
 manifest.models.push({name,file,url,bytes:bytes.length,sha256});
 console.log(`${name}: ${(await stat(target)).size} bytes -> ${fileURLToPath(target)}`);
}
await writeFile(new URL('manifest.json',directory),JSON.stringify(manifest,null,2)+'\n');
