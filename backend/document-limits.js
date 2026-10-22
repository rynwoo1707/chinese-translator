// Limits for documents the server opens itself (DOCX, EPUB, AZW3, TXT), checked before any parser runs. Parsers build a
// tree in memory: mammoth takes about 1 KB for each XML element of a DOCX and htmlparser2 about 250 bytes for each HTML
// element, so a file of a few kilobytes that unzips to hundreds of thousands of empty paragraphs would pass the 128 MB a
// Worker has and fail every request it was serving.
import mammoth from 'mammoth/mammoth.browser.js';
import {UserError} from './http.js';

const MB=1024*1024;
// elements: start tags in all the XML of a DOCX together (about 5,000–8,000 ordinary paragraphs); xmlBytes: that XML
// unzipped; part: one XML part unzipped.
export const DOCX_LIMITS=Object.freeze({entries:5000,partBytes:16*MB,xmlBytes:24*MB,elements:75000});
// One chapter of an EPUB or AZW3 (about 36 MB of tree).
export const HTML_ELEMENTS=150000;
export const TOO_LARGE_CODE='document_too_large';
const DOCX_TOO_LARGE='Tệp DOCX quá lớn hoặc có quá nhiều đoạn và định dạng để máy chủ đọc an toàn. Hãy lưu tài liệu thành TXT (UTF-8) hoặc PDF, hoặc chia thành các tệp nhỏ hơn, rồi tải lên lại.';
const DOCX_INVALID='Không đọc được tệp DOCX. Hãy kiểm tra tệp không đặt mật khẩu, mở bằng Word rồi lưu lại dưới dạng .docx và thử lại.';
const tooLarge=()=>new UserError(DOCX_TOO_LARGE,413,TOO_LARGE_CODE),invalid=()=>new UserError(DOCX_INVALID,400,'docx_invalid');
export const documentTooLarge=message=>new UserError(message,413,TOO_LARGE_CODE);

// Start tags in markup: "<" not followed by "/", "!" or "?". Counting stops past limit.
export function countTags(text,limit=Infinity){
 let count=0;
 for(let i=text.indexOf('<');i!==-1;i=text.indexOf('<',i+1)){const next=text.charCodeAt(i+1);if(next!==47&&next!==33&&next!==63&&++count>limit)break;}
 return count;
}
// The same over unzipped bytes, chunk by chunk; state.open carries a "<" that ended the previous chunk.
function countByteTags(bytes,state){
 let count=0,open=state.open;
 for(let i=0;i<bytes.length;i++){const byte=bytes[i];if(open&&byte!==47&&byte!==33&&byte!==63)count++;open=byte===60;}
 state.open=open;return count;
}

const u16=(b,o)=>b[o]|b[o+1]<<8,u32=(b,o)=>(b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0;
// The entries a zip's central directory lists: what JSZip, inside mammoth, reads too. ZIP64 is refused: Word, LibreOffice,
// WPS and Google Docs never need it for a file of at most 25 MB.
function centralDirectory(bytes){
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-22-65535);i--)if(u32(bytes,i)===0x06054b50){end=i;break;}
 if(end<0)throw invalid();
 const count=u16(bytes,end+10),size=u32(bytes,end+12),offset=u32(bytes,end+16),stop=offset+size;
 if(count===0xffff||size===0xffffffff||offset===0xffffffff||stop>end)throw invalid();
 if(count>DOCX_LIMITS.entries)throw tooLarge();
 const entries=[];
 for(let i=0,p=offset;i<count;i++){
  if(p+46>stop||u32(bytes,p)!==0x02014b50)throw invalid();
  const nameLength=u16(bytes,p+28),next=p+46+nameLength+u16(bytes,p+30)+u16(bytes,p+32);if(next>stop)throw invalid();
  entries.push({flags:u16(bytes,p+8),method:u16(bytes,p+10),time:u16(bytes,p+12),date:u16(bytes,p+14),crc:u32(bytes,p+16),compressed:u32(bytes,p+20),size:u32(bytes,p+24),name:bytes.subarray(p+46,p+46+nameLength),local:u32(bytes,p+42)});
  p=next;
 }
 return entries;
}
function entryData(bytes,entry){
 const p=entry.local;if(p+30>bytes.length||u32(bytes,p)!==0x04034b50)throw invalid();
 const start=p+30+u16(bytes,p+26)+u16(bytes,p+28),end=start+entry.compressed;if(end>bytes.length)throw invalid();
 return bytes.subarray(start,end);
}
// Unzips one part as a stream, never holding more than a chunk: a part that unzips to more than it declares (a size
// JSZip would only check after unzipping all of it) or past the limits stops at once.
async function scanPart(bytes,entry,state){
 if(entry.flags&1||![0,8].includes(entry.method))throw invalid();
 if(entry.size>DOCX_LIMITS.partBytes||state.bytes+entry.size>DOCX_LIMITS.xmlBytes)throw tooLarge();
 const data=entryData(bytes,entry),tags={open:false};let produced=0;
 const take=chunk=>{produced+=chunk.length;if(produced>entry.size)throw invalid();state.elements+=countByteTags(chunk,tags);if(state.elements>DOCX_LIMITS.elements)throw tooLarge();};
 if(entry.method===0){if(data.length!==entry.size)throw invalid();take(data);}
 else{
  const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;take(value);}}
  catch(error){reader.cancel().catch(()=>{});throw error instanceof UserError?error:invalid();}
 }
 if(produced!==entry.size)throw invalid();
 state.bytes+=entry.size;
}
// The same zip with every part that is not XML replaced by an empty element: mammoth parses whichever part the
// document's relationships name, even one called image1.png, so it must only ever find parts that were counted (an
// empty file would make its XML reader fail). Text extraction never needs images.
const PLACEHOLDER=new TextEncoder().encode('<x/>');
const crc32=bytes=>{let crc=-1;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc>>>1^0xedb88320&-(crc&1);}return (crc^-1)>>>0;};
const PLACEHOLDER_CRC=crc32(PLACEHOLDER);
function rebuilt(bytes,entries,kept){
 const pieces=[],central=[];let offset=0;
 const header=(size,fields,name)=>{const out=new Uint8Array(size+name.length),view=new DataView(out.buffer);for(const [at,bits,value] of fields)view[bits===32?'setUint32':'setUint16'](at,value,true);out.set(name,size);return out;};
 for(const entry of entries){
  const keep=kept.has(entry),data=keep?entryData(bytes,entry):PLACEHOLDER,method=keep?entry.method:0,crc=keep?entry.crc:PLACEHOLDER_CRC,size=keep?entry.size:PLACEHOLDER.length,flags=entry.flags&0x800;
  const common=[[8,16,flags],[10,16,method],[12,16,entry.time],[14,16,entry.date],[16,32,crc],[20,32,data.length],[24,32,size],[28,16,entry.name.length]];
  const local=header(30,[[0,32,0x04034b50],[4,16,20],...common.map(([at,bits,value])=>[at-2,bits,value])],entry.name);
  central.push(header(46,[[0,32,0x02014b50],[4,16,20],[6,16,20],...common,[42,32,offset]],entry.name));
  pieces.push(local,data);offset+=local.length+data.length;
 }
 const directory=central.reduce((sum,item)=>sum+item.length,0),end=header(22,[[0,32,0x06054b50],[8,16,entries.length],[10,16,entries.length],[12,32,directory],[16,32,offset]],new Uint8Array(0));
 const out=new Uint8Array(offset+directory+end.length);let p=0;for(const piece of [...pieces,...central,end]){out.set(piece,p);p+=piece.length;}
 return out.buffer;
}
const MARKUP=/\.(?:xml|rels)$/iu,decoder=new TextDecoder();
// The text of a DOCX, as mammoth.extractRawText gives it, once the file is known to fit.
export async function extractDocxText(data){
 const bytes=new Uint8Array(data),entries=centralDirectory(bytes),kept=new Set(),state={bytes:0,elements:0};
 for(const entry of entries)if(MARKUP.test(decoder.decode(entry.name))){await scanPart(bytes,entry,state);kept.add(entry);}
 let result;try{result=await mammoth.extractRawText({arrayBuffer:rebuilt(bytes,entries,kept)});}catch{throw invalid();}
 return String(result?.value??'');
}
