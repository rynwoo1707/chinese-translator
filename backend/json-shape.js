// Reads only the parts of a stored JSON document a caller names (its shape), as storage streams the bytes, and never
// builds the rest: a layout manifest of scanned pages is mostly base64 images (up to about 15 MB), which are scanned
// past, never decoded or held. A shape is:
//   true        keep the value as it is (parsed with JSON.parse from its own bytes)
//   {key:shape} keep those members of an object, each read with its shape; other members are skipped
//   [shape]     keep every element of an array, each read with that shape
// A value whose kind does not match its shape (a string where an object was expected) is kept as it is: the caller's
// own checks refuse it. Skipped values are only scanned for their end, so the document is trusted to be JSON there;
// the structure around kept values is checked, and a cut or broken document throws.
const QUOTE=0x22,BACKSLASH=0x5c,COMMA=0x2c,COLON=0x3a,OPEN_OBJECT=0x7b,CLOSE_OBJECT=0x7d,OPEN_ARRAY=0x5b,CLOSE_ARRAY=0x5d;
const space=c=>c===0x20||c===0x0a||c===0x0d||c===0x09;
const objectShape=shape=>Boolean(shape)&&typeof shape==='object'&&!Array.isArray(shape);
const broken=()=>new Error('Bố cục PDF đã lưu bị hỏng. Hãy tách lại các trang này từ PDF gốc.');
function joined(parts){
 if(parts.length===1)return parts[0];
 const bytes=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
class ShapeReader{
 constructor(shape){this.result={};this.stack=[];this.done=false;this.raw=null;this.key=null;this.decoder=new TextDecoder();this.rootShape=shape;}
 parse(parts){try{return JSON.parse(this.decoder.decode(joined(parts)));}catch{throw broken();}}
 // A value starting at chunk[i] goes to set: a container the shape reads into, or a raw value kept or skipped.
 start(shape,set,chunk,i){
  const c=chunk[i];
  if(Array.isArray(shape)&&c===OPEN_ARRAY){const target=[];set(target);this.stack.push({array:true,target,shape:shape[0],state:'first'});return i+1;}
  if(objectShape(shape)&&c===OPEN_OBJECT){const target={};set(target);this.stack.push({array:false,target,shape,state:'first',key:null});return i+1;}
  this.raw={keep:shape!==undefined,set,parts:[],first:true,depth:0,string:false,escape:false,primitive:false};return i;
 }
 close(){this.stack.pop();if(!this.stack.length)this.done=true;}
 member(frame){const key=frame.key,keep=Object.hasOwn(frame.shape,key);return [keep?frame.shape[key]:undefined,value=>{Object.defineProperty(frame.target,key,{value,enumerable:true,writable:true,configurable:true});}];}
 structural(chunk,i){
  const c=chunk[i],frame=this.stack.at(-1);
  if(!frame){if(this.done)throw broken();return this.start(this.rootShape,value=>{this.result.value=value;},chunk,i);}
  if(!frame.array){
   if(frame.state==='first'&&c===CLOSE_OBJECT||frame.state==='next'&&c===CLOSE_OBJECT){this.close();return i+1;}
   if(frame.state==='first'||frame.state==='key'){if(c!==QUOTE)throw broken();this.key={parts:[],escape:false,first:true};return i;}
   if(frame.state==='colon'){if(c!==COLON)throw broken();frame.state='value';return i+1;}
   if(frame.state==='next'){if(c!==COMMA)throw broken();frame.state='key';return i+1;}
   frame.state='next';const [shape,set]=this.member(frame);return this.start(shape,set,chunk,i);
  }
  if((frame.state==='first'||frame.state==='next')&&c===CLOSE_ARRAY){this.close();return i+1;}
  if(frame.state==='next'){if(c!==COMMA)throw broken();frame.state='value';return i+1;}
  frame.state='next';return this.start(frame.shape,value=>{frame.target.push(value);},chunk,i);
 }
 readKey(chunk,i){
  const key=this.key,from=i;let j=i;if(key.first){key.first=false;j++;}
  for(;j<chunk.length;j++){
   if(key.escape){key.escape=false;continue;}
   if(chunk[j]===BACKSLASH)key.escape=true;
   else if(chunk[j]===QUOTE){key.parts.push(chunk.subarray(from,j+1));const frame=this.stack.at(-1);frame.key=this.parse(key.parts);frame.state='colon';this.key=null;return j+1;}
  }
  key.parts.push(chunk.slice(from));return chunk.length;
 }
 finish(chunk,from,end){
  const raw=this.raw;this.raw=null;
  if(raw.keep){raw.parts.push(chunk.subarray(from,end));raw.set(this.parse(raw.parts));}
  if(!this.stack.length)this.done=true;
  return end;
 }
 // Scans a raw value from chunk[i] to its end, or to the end of the chunk. Inside strings it jumps from quote to quote
 // and from backslash to backslash, each found once per chunk (-1: none left), so a megabyte of base64 costs two native
 // searches and text written as \uXXXX escapes stays linear.
 readRaw(chunk,i){
  const raw=this.raw,n=chunk.length,from=i;let j=i,slash=-2,quote=-2;
  if(raw.first){
   raw.first=false;const c=chunk[j];
   if(c===QUOTE){raw.string=true;j++;}else if(c===OPEN_OBJECT||c===OPEN_ARRAY){raw.depth=1;j++;}
   // A value cannot start with a separator: [1,,2], [1,] and {"a":} are broken.
   else if(c===COMMA||c===COLON||c===CLOSE_OBJECT||c===CLOSE_ARRAY)throw broken();else raw.primitive=true;
  }
  while(j<n){
   if(raw.string){
    if(raw.escape){raw.escape=false;j++;continue;}
    if(slash<j&&slash!==-1)slash=chunk.indexOf(BACKSLASH,j);
    if(quote<j&&quote!==-1)quote=chunk.indexOf(QUOTE,j);
    if(slash!==-1&&(quote===-1||slash<quote)){raw.escape=true;j=slash+1;continue;}
    if(quote===-1){j=n;break;}
    j=quote+1;raw.string=false;if(!raw.depth)return this.finish(chunk,from,j);
    continue;
   }
   const c=chunk[j];
   if(raw.primitive){if(c===COMMA||c===CLOSE_OBJECT||c===CLOSE_ARRAY||space(c))return this.finish(chunk,from,j);j++;continue;}
   if(c===QUOTE)raw.string=true;
   else if(c===OPEN_OBJECT||c===OPEN_ARRAY)raw.depth++;
   else if((c===CLOSE_OBJECT||c===CLOSE_ARRAY)&&!--raw.depth)return this.finish(chunk,from,j+1);
   j++;
  }
  if(raw.keep)raw.parts.push(chunk.slice(from));
  return n;
 }
 push(chunk){
  for(let i=0;i<chunk.length;){
   if(this.raw)i=this.readRaw(chunk,i);
   else if(this.key)i=this.readKey(chunk,i);
   else if(space(chunk[i]))i++;
   else i=this.structural(chunk,i);
  }
 }
 end(){
  if(this.raw?.primitive&&!this.raw.string&&!this.stack.length){const raw=this.raw;this.raw=null;if(raw.keep)this.result.value=this.parse(raw.parts);this.done=true;}
  if(this.raw||this.key||this.stack.length||!this.done)throw broken();
  return this.result.value;
 }
}
const bytesOf=value=>typeof value==='string'?new TextEncoder().encode(value):value instanceof Uint8Array?value:ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
// source: a ReadableStream of bytes (a stored object's body), bytes, or a string.
export async function readJsonShape(source,shape){
 const reader=new ShapeReader(shape);
 if(source&&typeof source.getReader==='function'){
  const stream=source.getReader();
  try{for(;;){const {done,value}=await stream.read();if(done)break;reader.push(bytesOf(value));}}
  catch(error){await stream.cancel().catch(()=>{});throw error;}
 }
 else reader.push(bytesOf(source));
 return reader.end();
}
