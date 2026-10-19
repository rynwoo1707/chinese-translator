// Builds the offline Chinese lookup data in frontend/vendor/dict/ (git-ignored): `npm run prepare:dict`. Downloads the
// pinned open sources once (about 29 MB, no API key), checks their size and SHA-256 and keeps them in
// .runtime/dict-sources/. Re-running is a no-op while the sources and the builder code are unchanged.
// Offline: --from <folder> (or DICT_SOURCE_DIR) holding the files named in SOURCES. --print-hashes [url…] prints the
// size and SHA-256 of the pinned URLs (or the given ones) so a maintainer can bump a pin.
import {mkdir,readFile,writeFile,rename,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {unzipSync} from 'fflate';
import {buildDictionary,dictionaryKey} from './dictionary-build.js';
import {INDEX_BUCKETS,ENTRY_BUCKETS} from '../frontend/hanzi-dict.js';

const root=fileURLToPath(new URL('../',import.meta.url));
export const OUTPUT=join(root,'frontend','vendor','dict'),CACHE=join(root,'.runtime','dict-sources');
const MB=1024*1024,DOWNLOAD_LIMIT=40*MB,UNZIP_LIMIT=32*MB;
// Pinned by commit (CC-CEDICT from Debian's packaging repository, because MDBG's export changes daily) or by release.
export const SOURCES=[
 {key:'cedict',file:'cedict_ts.u8',name:'CC-CEDICT',version:'2026-09-06',license:'CC BY-SA 4.0',url:'https://salsa.debian.org/debian/cc-cedict/-/raw/906c4c2138b1ab9257e5bfc7f10c38bb1a318484/cedict_ts.u8',bytes:9842665,sha256:'76e7e169e7609f51abcd15b89579a627cd330b994818cd9b6d97677955794866'},
 {key:'cvdict',file:'CVDICT.u8',name:'CVDICT',version:'1.0.1',license:'CC BY-SA 4.0',url:'https://raw.githubusercontent.com/ph0ngp/CVDICT/c379d909e308343a247e51619f7839a2060a271c/CVDICT.u8',bytes:10803314,sha256:'4dde4b204193efa9c192d7f7daeab1bb579c8ccd7c41ed90d1b6caee22ba0948'},
 {key:'hanviet',file:'hanviet.csv',name:'hanviet-pinyin-wordlist',version:'b9923df',license:'MIT',url:'https://raw.githubusercontent.com/ph0ngp/hanviet-pinyin-wordlist/b9923df92c8b55f013001390e37cddd35e986dc1/hanviet.csv',bytes:195371,sha256:'dd90d59db1265a47317477c9f741baeff7cb4dfed58d9a0c2be5f69b9ed14d66'},
 {key:'hanvietLicense',file:'hanviet-LICENSE.txt',name:'hanviet-pinyin-wordlist LICENSE',version:'b9923df',license:'MIT',url:'https://raw.githubusercontent.com/ph0ngp/hanviet-pinyin-wordlist/b9923df92c8b55f013001390e37cddd35e986dc1/LICENSE',bytes:1061,sha256:'4c88b09e549ab516a6a7acb5b2091fb664dba39dd73e3530199c59783a819d25'},
 {key:'unihan',file:'Unihan.zip',name:'Unihan',version:'18.0.0',license:'Unicode License v3',url:'https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip',bytes:8340649,sha256:'4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e'},
 {key:'radicals',file:'CJKRadicals.txt',name:'CJKRadicals',version:'18.0.0',license:'Unicode License v3',url:'https://www.unicode.org/Public/18.0.0/ucd/CJKRadicals.txt',bytes:5491,sha256:'689e2e5852699e7115823dc0b6d3e615eb767c7f477b615678f4f989d1f06105'}
];
const UNIHAN_FILES={readings:'Unihan_Readings.txt',variants:'Unihan_Variants.txt',irg:'Unihan_IRGSources.txt'};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const megabytes=bytes=>`${(bytes/MB).toFixed(1)} MB`;

export function verifySource(source,bytes){
 if(bytes.length!==source.bytes||sha256(bytes)!==source.sha256)throw new Error(`Nguồn ${source.name}: checksum khác phiên bản đã kiểm thử; không thay dữ liệu hiện tại. Kiểm tra mạng hoặc cập nhật SOURCES (xem ONBOARDING).`);
 return bytes;
}
// The builder code is part of the rebuild key; line endings are normalised so a CRLF checkout gives the same key.
export async function builderHash(){
 const parts=await Promise.all(['backend/dictionary-build.js','frontend/hanzi-dict.js'].map(path=>readFile(join(root,path),'utf8')));
 return sha256(parts.map(text=>text.replace(/\r\n/gu,'\n')).join('\0'));
}
export async function expectedKey(sources=SOURCES){return dictionaryKey({builder:await builderHash(),sources});}
// Up to date when manifest.json carries the expected key and its version folder is complete.
export async function isUpToDate(directory=OUTPUT,key){
 try{
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  if(manifest.key!==key||!/^[a-f\d]{12}$/u.test(manifest.id||''))return false;
  const folder=join(directory,'v',manifest.id),[index,entries,top]=await Promise.all([readdir(join(folder,'i')),readdir(join(folder,'e')),readdir(folder)]);
  return index.filter(name=>name.endsWith('.json')).length===INDEX_BUCKETS&&entries.filter(name=>name.endsWith('.json')).length===ENTRY_BUCKETS&&top.includes('LICENSE.txt');
 }catch{return false;}
}

async function download(url,limit=DOWNLOAD_LIMIT){
 let response;
 try{response=await fetch(url,{signal:AbortSignal.timeout(180_000),headers:{'User-Agent':'hoa-tri-prepare-dictionary'}});}
 catch(error){throw new Error(`Không tải được ${url} (${error?.cause?.code||error?.name||error?.message}). Kiểm tra mạng, hoặc tải các tệp nguồn ở máy khác vào một thư mục rồi chạy "npm run prepare:dict -- --from <thư mục>".`);}
 if(!response.ok)throw new Error(`HTTP ${response.status} khi tải ${url}`);
 if(Number(response.headers.get('content-length'))>limit)throw new Error(`${url} lớn hơn ${megabytes(limit)}.`);
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error(`${url} lớn hơn ${megabytes(limit)}.`);chunks.push(chunk);}
 return new Uint8Array(Buffer.concat(chunks));
}
const readIfPresent=path=>readFile(path).then(buffer=>new Uint8Array(buffer),()=>null);
// --from folder first, then the verified cache, then the network. --from means offline: a file missing from both the
// folder and the cache is reported, not downloaded.
export async function getSource(source,{from='',cache=CACHE,log=console.log}={}){
 const offline=from?await readIfPresent(join(from,source.file)):null;
 if(offline)return verifySource(source,offline);
 const cached=join(cache,source.sha256,source.file),saved=await readIfPresent(cached);
 if(saved){try{return verifySource(source,saved);}catch{await rm(cached,{force:true});}}
 if(from)throw new Error(`Thiếu ${source.file} trong ${from}.`);
 log(`Đang tải ${source.name} (${megabytes(source.bytes)})…`);
 const bytes=verifySource(source,await download(source.url));
 await mkdir(join(cache,source.sha256),{recursive:true});await writeFile(`${cached}.tmp`,bytes);await rename(`${cached}.tmp`,cached);
 return bytes;
}
export function unihanTexts(zip){
 const wanted=new Set(Object.values(UNIHAN_FILES));
 const files=unzipSync(zip,{filter:file=>wanted.has(file.name)&&file.originalSize<=UNZIP_LIMIT}),decoder=new TextDecoder('utf-8',{fatal:true});
 const texts={};
 for(const [key,name] of Object.entries(UNIHAN_FILES)){if(!files[name])throw new Error(`Unihan.zip thiếu ${name}.`);texts[key]=decoder.decode(files[name]);}
 return texts;
}

const locked=error=>['EPERM','EBUSY','EACCES'].includes(error?.code);
async function eachLimited(items,limit,task){const queue=[...items];await Promise.all(Array.from({length:Math.min(limit,queue.length)},async()=>{while(queue.length)await task(queue.shift());}));}
async function filesIn(target){
 const lists=await Promise.all(['','i','e'].map(async folder=>(await readdir(join(target,folder),{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isFile()).map(entry=>folder?`${folder}/${entry.name}`:entry.name)));
 return new Set(lists.flat());
}
// Files go straight into v/<id>/: the id hashes the content, so a new id is a folder no page uses yet, and an existing
// one already holds these bytes (only missing or damaged files are rewritten). Leftovers, such as an interrupted run's
// files, are removed so they are never deployed. manifest.json switches last, through a temporary file. No folder is
// renamed: Windows refuses that while wrangler dev watches frontend/.
export async function writeDictionary({id,manifest,files},directory=OUTPUT){
 const versions=join(directory,'v'),target=join(versions,id);let written=0;
 try{
  await Promise.all(['i','e'].map(folder=>mkdir(join(target,folder),{recursive:true})));
  const present=await filesIn(target);
  await eachLimited(files,16,async([path,text])=>{
   const file=join(target,path);
   if(present.has(path)&&await readFile(file,'utf8').catch(()=>null)===text)return;
   await writeFile(file,text);written++;
  });
  for(const path of present)if(!files.has(path))await rm(join(target,path),{force:true});
  await writeFile(join(directory,'manifest.json.tmp'),`${JSON.stringify(manifest)}\n`);await rename(join(directory,'manifest.json.tmp'),join(directory,'manifest.json'));
 }catch(error){
  if(locked(error))throw new Error(`Không ghi được ${directory} (${error.code}): đóng Hoa Trí (start.cmd) rồi chạy lại.`);
  throw error;
 }
 const kept=[];
 for(const name of await readdir(versions))if(name!==id)await rm(join(versions,name),{recursive:true,force:true}).catch(()=>kept.push(name));
 return {written,kept};
}

async function printHashes(urls){
 for(const url of urls.length?urls:SOURCES.map(source=>source.url)){const bytes=await download(url,100*MB);console.log(`${bytes.length} ${sha256(bytes)} ${url}`);}
}
async function main(args){
 if(args.includes('--print-hashes'))return printHashes(args.filter(arg=>/^https?:/u.test(arg)));
 const fromAt=args.indexOf('--from'),from=fromAt>=0?resolve(args[fromAt+1]||''):process.env.DICT_SOURCE_DIR?resolve(process.env.DICT_SOURCE_DIR):'';
 const key=await expectedKey();
 if(!args.includes('--force')&&await isUpToDate(OUTPUT,key)){console.log('Từ điển đã có, bỏ qua.');return;}
 const started=Date.now(),bytes={};
 for(const source of SOURCES)bytes[source.key]=await getSource(source,{from});
 const downloaded=Date.now(),text=key=>new TextDecoder('utf-8',{fatal:true}).decode(bytes[key]).replace(/\r\n/gu,'\n');
 const unihan=unihanTexts(bytes.unihan);
 const built=buildDictionary({texts:{cedict:text('cedict'),cvdict:text('cvdict'),hanviet:text('hanviet'),hanvietLicense:text('hanvietLicense'),radicals:text('radicals'),unihanReadings:unihan.readings,unihanVariants:unihan.variants,unihanIrg:unihan.irg},sources:SOURCES,builder:await builderHash()});
 const compiled=Date.now();
 const {written,kept}=await writeDictionary(built);
 const total=[...built.files.values()].reduce((sum,text)=>sum+Buffer.byteLength(text),0),{counts}=built.manifest;
 console.log(`Từ điển: ${counts.entries.toLocaleString('vi-VN')} mục (${counts.vietnamese.toLocaleString('vi-VN')} có nghĩa tiếng Việt), ${counts.chars.toLocaleString('vi-VN')} chữ, ${built.files.size+1} tệp, ${megabytes(total)} → ${join(OUTPUT,'v',built.id)}`);
 if(kept.length)console.log(`Chưa xóa được bản cũ ${kept.join(', ')} trong ${join(OUTPUT,'v')} (đang được dùng); có thể xóa tay sau khi tắt Hoa Trí.`);
 console.log(`Thời gian: nguồn ${((downloaded-started)/1000).toFixed(1)} s, dựng ${((compiled-downloaded)/1000).toFixed(1)} s, ghi ${((Date.now()-compiled)/1000).toFixed(1)} s (${written} tệp mới hoặc thay đổi).`);
}

const invoked=process.argv[1]&&resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase();
if(invoked)main(process.argv.slice(2)).catch(error=>{console.error(`LỖI: ${error.message}`);process.exitCode=1;});
