// JSON text for layout manifests and service answers, with every non-ASCII character escaped (\uXXXX). V8 stores a
// string with even one Chinese character at two bytes per character; this text, and the strings parsed back from it,
// take one, so a scanned chunk's manifest (page images as base64) costs half the memory in the 128 MB Worker and in
// the service. Same data as JSON.stringify for what JSON.parse returns (objects, arrays, strings, numbers, booleans,
// null); parsing it gives the same value back.
const PLAIN=/^[\x20\x21\x23-\x5b\x5d-\x7e]*$/u;
// A string that needs escapes, as its JSON text built only from ASCII pieces (so the result is a one-byte string).
function escaped(text){
 const json=JSON.stringify(text),codes=[];let out='';
 for(let i=0;i<json.length;i++){
  const code=json.charCodeAt(i);
  if(code<128)codes.push(code);else for(const char of `\\u${code.toString(16).padStart(4,'0')}`)codes.push(char.charCodeAt(0));
  if(codes.length>=4096){out+=String.fromCharCode(...codes);codes.length=0;}
 }
 return out+String.fromCharCode(...codes);
}
const skipped=value=>value===undefined||typeof value==='function'||typeof value==='symbol';
// The text as a list of ASCII pieces; a plain string (a page image) is one piece of its own, never copied.
function pieces(value){
 const parts=[],string=text=>{if(PLAIN.test(text))parts.push('"',text,'"');else parts.push(escaped(text));};
 const write=item=>{
  if(typeof item?.toJSON==='function')item=item.toJSON();
  if(typeof item==='string'){string(item);return;}
  if(item===null||typeof item!=='object'){parts.push(JSON.stringify(item)??'null');return;}
  if(Array.isArray(item)){parts.push('[');for(let i=0;i<item.length;i++){if(i)parts.push(',');write(skipped(item[i])?null:item[i]);}parts.push(']');return;}
  parts.push('{');let first=true;
  for(const key of Object.keys(item)){if(skipped(item[key]))continue;if(!first)parts.push(',');string(key);parts.push(':');first=false;write(item[key]);}
  parts.push('}');
 };
 write(value);return parts;
}
export const asciiJson=value=>pieces(value).join('');
// The same text as UTF-8 bytes (one per character, all being ASCII), written piece by piece: no joined string first.
export function asciiJsonBytes(value){
 const parts=pieces(value);let size=0;for(const part of parts)size+=part.length;
 const bytes=new Uint8Array(size),encoder=new TextEncoder();let offset=0;
 for(const part of parts)offset+=encoder.encodeInto(part,bytes.subarray(offset)).written;
 return bytes;
}
