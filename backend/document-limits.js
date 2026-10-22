// Documents the server opens itself (DOCX, EPUB, AZW3, TXT): the limits checked while they are read, and readers for
// their markup. A Worker has 128 MB for every request it is serving, and a tree of the markup costs hundreds of bytes
// for each element and each attribute: a file of a few kilobytes can unzip to millions of them, and limits on start
// tags alone let a file through whose tags carry dozens of attributes each. So nothing here builds a tree: the markup is
// read as a stream of tags (htmlparser2's Parser) that keeps only the text and the little structure the text depends
// on. What a document costs in memory then follows its text; the limits bound the time it takes.
import {Parser} from 'htmlparser2';
import dingbats from 'dingbat-to-unicode';
import {UserError} from './http.js';

const MB=1024*1024;
// elements: start tags in the XML read from a DOCX, its main document and package relationships (about 5,000–8,000
// ordinary paragraphs); xmlBytes: that XML unzipped; part: one XML part unzipped.
export const DOCX_LIMITS=Object.freeze({entries:5000,partBytes:16*MB,xmlBytes:24*MB,elements:75000});
// Start tags in one chapter of an EPUB or AZW3, or in one of an EPUB's package files.
export const HTML_ELEMENTS=150000;
// Elements nested deeper than this are refused: the parser's stack grows with the nesting. Word nests a table in a
// table in a text box a few dozen levels at most; sloppy HTML that never closes its <font> or <span> tags goes deeper.
export const MAX_DEPTH=Object.freeze({docx:1024,html:4096});
// Attributes of one element: the parser gathers an element's attributes in one object before handing it over. Word's
// root element declares a few dozen namespaces, a VML shape has a few dozen attributes; a million on one tag would fill
// the memory the tree was taken out to save.
export const MAX_ATTRIBUTES=1024;
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

// The text of an (X)HTML chapter as a tree walk reads it: a block element on lines of its own, a table cell followed by
// a tab, <br> a line break; script, style, head, noscript and ruby annotations (rt, rp) left out; in each text node every
// run of whitespace one space. Read from the parser's events, with consecutive text events joined first, as the tree
// joins them into one text node. body: the text of the first <body> (of everything when there is none); images: an <img>
// or <svg> is in that text's part of the document. tooComplex(): the error for nesting deeper than MAX_DEPTH.html or an
// element with more than MAX_ATTRIBUTES attributes.
const BLOCKS=new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','blockquote','tr','pre','hr']);
const HIDDEN=new Set(['script','style','head','noscript','rt','rp']);
const localName=name=>name.split(':').pop().toLowerCase();
export function markupText(html,{body=false,tooComplex}){
 const all={out:[],skip:0},names=[];let first=null,active=[all],depth=0,bodyDepth=0,pending='',images=false,attributes=0;
 const flush=()=>{if(!pending)return;const text=pending.replace(/[\t\r\n ]+/gu,' ');pending='';for(const part of active)if(!part.skip)part.out.push(text);};
 new Parser({
  onopentagname(){attributes=0;},
  onattribute(){if(++attributes>MAX_ATTRIBUTES)throw tooComplex();},
  onopentag(name){
   flush();if(++depth>MAX_DEPTH.html)throw tooComplex();
   const local=localName(name);names.push(local);if(active.length&&(local==='img'||local==='svg'))images=true;
   for(const part of active){if(part.skip)part.skip++;else if(HIDDEN.has(local))part.skip=1;else if(local==='br'){part.out.push('\n');part.skip=1;}else if(BLOCKS.has(local))part.out.push('\n');}
   if(body&&!first&&local==='body'){first={out:[],skip:0};active=[first];bodyDepth=depth;images=false;}
  },
  onclosetag(){
   flush();const local=names.pop();
   for(const part of active){if(part.skip)part.skip--;else if(BLOCKS.has(local))part.out.push('\n');else if(local==='td')part.out.push('\t');}
   // Past the first body nothing more is read, images included.
   if(first&&depth===bodyDepth)active=[];
   depth--;
  },
  ontext(value){if(active.length)pending+=value;},
  oncomment:flush,oncdatastart:flush,oncdataend:flush,onprocessinginstruction:flush
 },{decodeEntities:true}).end(html);
 flush();
 return {text:(first??all).out.join(''),images};
}

const u16=(b,o)=>b[o]|b[o+1]<<8,u32=(b,o)=>(b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0;
// The entries a zip's central directory lists, as JSZip (inside mammoth) reads them. ZIP64 is refused: Word,
// LibreOffice, WPS and Google Docs never need it for a file of at most 25 MB.
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
  entries.push({flags:u16(bytes,p+8),method:u16(bytes,p+10),compressed:u32(bytes,p+20),size:u32(bytes,p+24),name:bytes.subarray(p+46,p+46+nameLength),local:u32(bytes,p+42)});
  p=next;
 }
 return entries;
}
function entryData(bytes,entry){
 const p=entry.local;if(p+30>bytes.length||u32(bytes,p)!==0x04034b50)throw invalid();
 const start=p+30+u16(bytes,p+26)+u16(bytes,p+28),end=start+entry.compressed;if(end>bytes.length)throw invalid();
 return bytes.subarray(start,end);
}

// Element and attribute names as mammoth gives them (mammoth/lib/docx/office-xml-reader.js): the prefix it maps the
// namespace to, {namespace}name for another namespace, the bare name without one. Only the namespaces of what the
// readers below look at are listed; any other element is left out either way.
const NAMESPACES=new Map([
 ['http://schemas.openxmlformats.org/wordprocessingml/2006/main','w'],['http://purl.oclc.org/ooxml/wordprocessingml/main','w'],
 ['http://schemas.openxmlformats.org/officeDocument/2006/relationships','r'],['http://purl.oclc.org/ooxml/officeDocument/relationships','r'],
 ['http://schemas.openxmlformats.org/package/2006/relationships','relationships'],['http://schemas.openxmlformats.org/markup-compatibility/2006','mc'],
 ['urn:schemas-microsoft-com:vml','v'],['http://schemas.microsoft.com/office/word/2010/wordml','wordml']
]);
const RESERVED=new Map([['xml','http://www.w3.org/XML/1998/namespace'],['xmlns','http://www.w3.org/2000/xmlns/']]);
class Names{
 constructor(){this.bound=new Map();this.declared=[];}
 // An element's declarations apply to its own name and attributes and to everything inside it.
 open(attribs){
  let declared=null;
  for(const key in attribs)if(key==='xmlns'||key.startsWith('xmlns:')){const prefix=key.slice(6);if(!this.bound.has(prefix))this.bound.set(prefix,[]);this.bound.get(prefix).push(attribs[key]);(declared??=[]).push(prefix);}
  this.declared.push(declared);
 }
 close(){for(const prefix of this.declared.pop()??[])this.bound.get(prefix).pop();}
 name(qualified,attribute=false){
  const colon=qualified.indexOf(':'),prefix=colon<0?'':qualified.slice(0,colon),local=qualified.slice(colon+1);
  const uri=colon<0&&attribute?'':RESERVED.get(prefix)??this.bound.get(prefix)?.at(-1);
  return !uri?local:NAMESPACES.has(uri)?`${NAMESPACES.get(uri)}:${local}`:`{${uri}}${local}`;
 }
 // An attribute by its mammoth name; of several that map to one name the last counts, as in mammoth.
 attribute(attribs,name){let value;for(const key in attribs)if(this.name(key,true)===name)value=attribs[key];return value;}
}

// One XML part of a DOCX read into handler {open(name,value),close(),text(text)}, value(name) giving an attribute.
// Unzipped as a stream, never holding more than a chunk: a part that unzips to more than it declares (a size JSZip would
// only check after unzipping all of it) or past the limits stops at once. Read as XML is: UTF-8, every line end made \n
// before parsing (a &#13; stays a \r); text in CDATA is left out, as mammoth leaves it out.
async function readXml(bytes,entry,state,handler){
 if(entry.flags&1||![0,8].includes(entry.method))throw invalid();
 if(entry.size>DOCX_LIMITS.partBytes||state.bytes+entry.size>DOCX_LIMITS.xmlBytes)throw tooLarge();
 state.bytes+=entry.size;
 const names=new Names();let depth=0,cdata=false,attributes=0;
 const parser=new Parser({
  onopentagname(){attributes=0;},
  onattribute(){if(++attributes>MAX_ATTRIBUTES)throw tooLarge();},
  onopentag(name,attribs){if(++state.elements>DOCX_LIMITS.elements||++depth>MAX_DEPTH.docx)throw tooLarge();names.open(attribs);handler.open(names.name(name),key=>names.attribute(attribs,key));},
  onclosetag(){depth--;handler.close();names.close();},
  ontext(text){if(!cdata)handler.text(text);},
  oncdatastart(){cdata=true;},oncdataend(){cdata=false;}
 },{xmlMode:true,decodeEntities:true});
 const decoder=new TextDecoder();let produced=0,carriage=false;
 const write=text=>{if(carriage)text='\r'+text;carriage=text.endsWith('\r');if(carriage)text=text.slice(0,-1);if(text)parser.write(text.replace(/\r\n?/gu,'\n'));};
 const take=chunk=>{produced+=chunk.length;if(produced>entry.size)throw invalid();write(decoder.decode(chunk,{stream:true}));};
 const data=entryData(bytes,entry);
 if(entry.method===0){if(data.length!==entry.size)throw invalid();take(data);}
 else{
  const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  try{for(;;){let next;try{next=await reader.read();}catch{throw invalid();}if(next.done)break;take(next.value);}}
  catch(error){reader.cancel().catch(()=>{});throw error;}
 }
 if(produced!==entry.size)throw invalid();
 write(decoder.decode());if(carriage)parser.write('\n');parser.end();
}

// mammoth's findPartPaths: the main document is the first target of an officeDocument relationship in _rels/.rels
// that is in the zip, else word/document.xml.
const OFFICE_DOCUMENT='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
function packageTargets(){
 const targets=[];let depth=0;
 return {targets,open(name,value){if(++depth===2&&name==='relationships:Relationship'&&value('Type')===OFFICE_DOCUMENT)targets.push(value('Target'));},close(){depth--;},text(){}};
}

// The text mammoth.extractRawText gives for the body of a document (mammoth/lib/docx/body-reader.js and raw-text.js),
// read from events instead of mammoth's trees. Each element hands its parent items ({k,s}, or {k,c} with children where
// the structure still matters) and extras: the content of VML pictures (text boxes), which mammoth places after the
// paragraph holding them and drops when no paragraph holds them. A paragraph ends with a blank line, a tab is \t; line
// breaks, pictures, notes and field codes give nothing; elements mammoth ignores or does not know are left out with all
// they contain (so are equations and simple fields, as in mammoth). The structure is kept only where mammoth's text
// depends on it: rows and cells until their table ends (a cell continuing a vertical merge is left out), and the content
// of a checkbox content control (its first text gives way to the checkbox). A paragraph whose mark was deleted (tracked
// changes) joins the next one: mammoth reads its content only when that paragraph starts, so it is recorded (names, the
// few attributes read, the text of w:t) and read there.
const PASS=new Set(['w:ins','w:object','w:smartTag','v:roundrect','v:shape','v:textbox','w:txbxContent','v:group','v:rect']);
const CHARACTERS=new Map([['w:tab',{k:'tab',s:'\t'}],['w:noBreakHyphen',{k:'text',s:String.fromCharCode(0x2011)}],['w:softHyphen',{k:'text',s:String.fromCharCode(0xad)}]]);
const BREAKS=new Set([undefined,'textWrapping','page','column']),NOTES=new Set(['w:footnoteReference','w:endnoteReference','w:commentReference']);
const ATTRIBUTES=new Map([['w:hyperlink',['r:id','w:anchor']],['w:sym',['w:font','w:char']],['w:br',['w:type']],['w:bookmarkStart',['w:name']],['w:gridSpan',['w:val']],['w:vMerge',['w:val']]]);
const NOTHING={k:'el',s:''},CLOSE=0;
const textOf=item=>item.c?item.c.map(textOf).join('')+(item.k==='p'?'\n\n':''):item.s;
const container=(k,items,keep)=>keep?{k,c:items}:{k,s:items.map(textOf).join('')+(k==='p'?'\n\n':'')};
// A character of a symbol font (w:sym), as mammoth maps it to Unicode; null when it has no mapping.
function symbol(font,char){
 if(typeof font!=='string'||typeof char!=='string')return null;
 return (dingbats.hex(font,char)??(/^F0..$/u.test(char)?dingbats.hex(font,char.substring(2)):undefined))?.string??null;
}
function table(rows,keep){
 if(rows.every(row=>row.k==='row'&&row.c.every(cell=>cell.k==='cell'))){
  const columns={};
  for(const row of rows){let index=0;for(const cell of row.c){if(cell.vMerge&&columns[index])cell.merged=true;else columns[index]=cell;index+=cell.colSpan;}}
  for(const row of rows)row.c=row.c.filter(cell=>!cell.merged);
 }
 return container('el',rows,keep);
}
function checkbox(items){
 let found=false;
 const replace=item=>{if(item.c)item.c=item.c.map(replace);if(!found&&item.k==='text'&&item.s.length){found=true;return NOTHING;}return item;};
 const replaced=items.map(replace);return found?replaced:[NOTHING];
}
function bodyReader(){
 const out=[],stack=[];let skip=0,done=false,body=false,deferred=[],recording=null;
 const push=(kind,keep,more)=>stack.push({kind,keep,items:[],extras:[],...more});
 const give=(items,extras=[])=>{const parent=stack.at(-1);if(parent.kind==='body'){for(const item of items)out.push(textOf(item));return;}for(const item of items)parent.items.push(item);for(const item of extras)parent.extras.push(item);};
 // A paragraph is read on once its own properties are: a deleted one records the rest of its content, any other first
 // reads what the deleted paragraphs before it recorded.
 const decide=frame=>{
  frame.decided=true;
  if(frame.deleted)recording={events:frame.recorded,names:[]};
  else for(const event of frame.prefix)event===CLOSE?close():typeof event==='string'?text(event):open(event.name,key=>event.attrs?.[key]);
 };
 function open(name,value){
  if(recording){recording.names.push(name);const keys=ATTRIBUTES.get(name);recording.events.push({name,attrs:keys&&Object.fromEntries(keys.map(key=>[key,value(key)]))});return;}
  if(skip||done){skip++;return;}
  const frame=stack.at(-1);
  if(!frame){push('root',false,{body:false});return;}
  switch(frame.kind){
   case 'root':if(name==='w:body'&&!frame.body){frame.body=body=true;push('body',false);}else skip=1;return;
   case 't':skip=1;return;
   // Properties: a paragraph or row whose (first) properties hold w:del is deleted; a cell's span and vertical merge.
   case 'pPr':if(name==='w:rPr'&&!frame.rPr){frame.rPr=true;push('pPrRPr',false,{target:frame.target});}else skip=1;return;
   case 'pPrRPr':case 'trPr':if(name==='w:del')frame.target.deleted=true;skip=1;return;
   case 'tcPr':
    if(name==='w:gridSpan'&&!frame.span){frame.span=true;const span=value('w:val');frame.target.colSpan=span?parseInt(span,10):1;}
    else if(name==='w:vMerge'&&!frame.merge){frame.merge=true;const merge=value('w:val');frame.target.vMerge=merge==='continue'||!merge;}
    skip=1;return;
   case 'sdtPr':if(name==='wordml:checkbox')frame.target.checkbox=true;skip=1;return;
   // A content control is read from its first w:sdtContent, a w:AlternateContent from its first mc:Fallback.
   case 'sdt':if(name==='w:sdtPr'&&!frame.pr){frame.pr=true;push('sdtPr',false,{target:frame});}else if(name==='w:sdtContent'&&!frame.content){frame.content=true;push('pass',frame.keep||frame.checkbox);}else skip=1;return;
   case 'ac':if(name==='mc:Fallback'&&!frame.fallback){frame.fallback=true;push('pass',frame.keep);}else skip=1;return;
   case 'p':
    if(!frame.decided){if(name==='w:pPr'&&!frame.pr){frame.pr=true;push('pPr',false,{target:frame});return;}decide(frame);if(recording){open(name,value);return;}}
    break;
   // A deleted row is left out whole, as mammoth never reads past its properties.
   case 'tr':if(frame.deleted){skip=1;return;}if(name==='w:trPr'&&!frame.pr){frame.pr=true;push('trPr',false,{target:frame});return;}break;
   case 'tc':if(name==='w:tcPr'&&!frame.pr){frame.pr=true;push('tcPr',false,{target:frame});return;}break;
  }
  const keep=frame.keep;
  if(name==='w:p'){push('p',keep,{prefix:deferred,recorded:[],deleted:false,decided:false,pr:false});deferred=[];}
  else if(name==='w:r')push('run',keep);
  else if(name==='w:t')push('t',keep,{text:''});
  else if(name==='w:hyperlink')push('hyperlink',keep,{wrap:Boolean(value('r:id')||value('w:anchor'))});
  else if(name==='w:tbl')push('tbl',keep);
  else if(name==='w:tr')push('tr',keep,{deleted:false,pr:false});
  else if(name==='w:tc')push('tc',keep,{colSpan:1,vMerge:null,pr:false});
  else if(name==='w:sdt')push('sdt',keep,{checkbox:false,pr:false,content:false});
  else if(name==='mc:AlternateContent')push('ac',keep,{fallback:false});
  else if(name==='w:pict')push('pict',keep);
  else if(PASS.has(name))push('pass',keep);
  else{
   skip=1;
   if(CHARACTERS.has(name))give([{...CHARACTERS.get(name)}]);
   else if(name==='w:sym'){const character=symbol(value('w:font'),value('w:char'));if(character!==null)give([{k:'text',s:character}]);}
   else if(name==='w:br'&&BREAKS.has(value('w:type'))||NOTES.has(name)||name==='w:bookmarkStart'&&value('w:name')!=='_GoBack')give([NOTHING]);
  }
 }
 function close(){
  if(recording){if(recording.names.length){recording.names.pop();recording.events.push(CLOSE);return;}recording=null;}
  if(skip){skip--;return;}
  const top=stack.at(-1);if(top.kind==='p'&&!top.decided)decide(top);
  const frame=stack.pop();
  switch(frame.kind){
   case 'root':done=true;return;
   case 'pPr':if(!frame.target.decided)decide(frame.target);return;
   // What deleted paragraphs left goes on to the next paragraph, after what was there before.
   case 'p':if(frame.deleted)deferred=frame.prefix.concat(frame.recorded,deferred);else give([container('p',frame.items,frame.keep)].concat(frame.extras));return;
   case 'run':give([container('el',frame.items,frame.keep)],frame.extras);return;
   case 'hyperlink':give(frame.wrap?[container('el',frame.items,frame.keep)]:frame.items,frame.extras);return;
   case 't':give([{k:'text',s:frame.text}]);return;
   case 'tbl':give([table(frame.items,frame.keep)],frame.extras);return;
   case 'tr':if(!frame.deleted)give([{k:'row',c:frame.items}],frame.extras);return;
   case 'tc':give([{...container('cell',frame.items,frame.keep),colSpan:frame.colSpan,vMerge:frame.vMerge}],frame.extras);return;
   case 'sdt':give(frame.checkbox?checkbox(frame.items):frame.items,frame.extras);return;
   case 'pict':give([],frame.extras.concat(frame.items));return;
   case 'ac':case 'pass':give(frame.items,frame.extras);return;
  }
 }
 function text(value){
  if(recording){if(recording.names.at(-1)==='w:t')recording.events.push(value);return;}
  const frame=stack.at(-1);if(!skip&&frame?.kind==='t')frame.text+=value;
 }
 return {open,close,text,result(){if(!body)throw invalid();return out.join('');}};
}

const MARKUP=/\.(?:xml|rels)$/iu,decoder=new TextDecoder();
// The text of a DOCX, as mammoth.extractRawText gives it. Only the package relationships and the main document are
// read; styles, numbering, notes and comments never change that text.
export async function extractDocxText(data){
 const bytes=new Uint8Array(data),files=new Map(centralDirectory(bytes).map(entry=>[decoder.decode(entry.name),entry])),state={bytes:0,elements:0};
 let path='word/document.xml';
 if(files.has('_rels/.rels')){const rels=packageTargets();await readXml(bytes,files.get('_rels/.rels'),state,rels);path=rels.targets.filter(Boolean).map(target=>target.startsWith('/')?target.slice(1):target).find(target=>files.has(target))??path;}
 // A main document named like a picture (the relationships can name any part) is no document.
 if(!files.has(path)||!MARKUP.test(path))throw invalid();
 const reader=bodyReader();await readXml(bytes,files.get(path),state,reader);
 return reader.result();
}
