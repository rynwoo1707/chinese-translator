// Run with a small heap (node --max-old-space-size=64 or =128 document-bomb-child.mjs <kind>): builds a document of a few
// tens of KB (a few MB for the namespace kinds) that unzips to a huge number of elements, attributes, namespace
// declarations or characters and reads it the way the server does. Prints {"ok":…} or {"code":…}; a reader that builds
// a tree of it, keeps what it declares or copies its text without bound runs out of memory and the process dies instead.
// The kinds ending in -attributes are what a guard counting only tags let through.
import {zipSync,strToU8} from 'fflate';
import {extractDocxText} from '../document-limits.js';
import {extractEpub} from '../epub.js';
import {extractAzw3} from '../azw3.js';

const kind=process.argv[2];
const CONTENT_TYPES='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS='<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
// count attributes, all different and empty (a0="" … in XML, a0 a1 … in HTML): what a tree keeps an object for.
const attributes=(count,xml=true)=>Array.from({length:count},(_,i)=>` a${i.toString(36)}${xml?'=""':''}`).join('');
const DOCUMENT_HEAD='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',DOCUMENT_TAIL='</w:body></w:document>';
const zipDocx=(documentXml,level=9)=>zipSync({'[Content_Types].xml':strToU8(CONTENT_TYPES),'_rels/.rels':strToU8(RELS),'word/document.xml':documentXml},{level});
const docx=paragraph=>zipDocx(strToU8(DOCUMENT_HEAD+paragraph+DOCUMENT_TAIL));
// A main document of one paragraph and elements declaring new prefixes (xmlns:0, xmlns:1 … all different), nested or
// side by side. It is encoded piece by piece, so this process never holds its 14 MB of XML as one string.
function namespaced(elements,each,nested){
 const chunks=[];let text=DOCUMENT_HEAD+'<w:p><w:r><w:t>字</w:t></w:r></w:p>';
 for(let i=0;i<elements;i++){
  text+='<e';for(let k=0;k<each;k++)text+=` xmlns:${(i*each+k).toString(36)}="u"`;text+=nested?'>':'/>';
  if(text.length>262144){chunks.push(strToU8(text));text='';}
 }
 chunks.push(strToU8(text+(nested?'</e>'.repeat(elements):'')+DOCUMENT_TAIL));
 const xml=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){xml.set(chunk,at);at+=chunk.length;}
 return zipDocx(xml,6);
}
const epub=({opf='',spine='<itemref idref="one"/>',chapter})=>zipSync(Object.fromEntries(Object.entries({mimetype:'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>','OPS/book.opf':`<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>${opf}</manifest><spine>${spine}</spine></package>`,'OPS/one.xhtml':chapter}).map(([name,text])=>[name,strToU8(text)])),{level:9});
// A Kindle book as the KF8 library would give it (azw3.test.mjs does the same): one chapter of the given HTML.
const azw3=html=>{const header=new Uint8Array(100);header.set(new TextEncoder().encode('BOOKMOBI'),60);return extractAzw3(header,{init:async()=>({mobiFile:{palmdocHeader:{compression:2,numTextRecords:1},start:0,recordsOffset:[[0,100],[100,4196]],loadTextBuffer:()=>new Uint8Array(4096)},fullRawLength:html.length,getSpine:()=>[{length:html.length,html}],loadText:chapter=>chapter.html,getMetadata:()=>({title:'Sách',author:[]}),destroy(){}})});};
const report=(text,bytes)=>console.log(JSON.stringify({ok:true,characters:text.length,bytes}));
try{
 if(kind==='docx'){const file=docx('<w:p><w:r><w:t>字</w:t></w:r></w:p>'.repeat(200000));report(await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)),file.length);}
 // 18,000 paragraphs, 54,002 elements (under the limit of 75,000), with 60 attributes on each paragraph.
 else if(kind==='docx-attributes'){const file=docx(`<w:p${attributes(60)}><w:r><w:t>字</w:t></w:r></w:p>`.repeat(18000));report(await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)),file.length);}
 // 1,000 nested elements declaring 1,000 prefixes each: a million in force at once (14 MB of XML, 1,005 elements, depth
 // 1,002, 1,000 attributes on a tag: under every other limit).
 else if(kind==='docx-namespaces'){const file=namespaced(1000,1000,true);report(await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)),file.length);}
 // 60,000 sibling elements declaring 16 new prefixes each: never more than 17 in force, 960,000 over the part.
 else if(kind==='docx-namespaces-siblings'){const file=namespaced(60000,16,false);report(await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)),file.length);}
 else if(kind==='epub'){const file=epub({chapter:`<html><body>${'<p>字</p>'.repeat(800000)}</body></html>`});report(extractEpub(file).source,file.length);}
 // 100,000 paragraphs (under the 150,000 tags of a chapter) with 25 attributes each: 7.9 MB, under the 8 MB of a chapter.
 else if(kind==='epub-attributes'){const file=epub({chapter:`<html><body>${`<p${attributes(25,false)}>x</p>`.repeat(100000)}</body></html>`});report(extractEpub(file).source,file.length);}
 // The package file instead: 100,000 manifest items with 25 attributes each (htmlparser2 takes them without values).
 else if(kind==='opf-attributes'){const file=epub({opf:`<item${attributes(25,false)}/>`.repeat(100000),chapter:'<html><body><p>字</p></body></html>'});report(extractEpub(file).source,file.length);}
 // One chapter of 2.7 million characters (8 MB unzipped, 10 KB zipped) named 60 times in the reading order.
 else if(kind==='epub-repeat'){const file=epub({spine:'<itemref idref="one"/>'.repeat(60),chapter:`<html><body><p>${'字'.repeat(2700000)}</p></body></html>`});report(extractEpub(file).source,file.length);}
 // The same chapter named 9 times: 24.3 million characters, under the 25 MB counted in characters, but 73 MB of UTF-8.
 else if(kind==='epub-repeat-bytes'){const file=epub({spine:'<itemref idref="one"/>'.repeat(9),chapter:`<html><body><p>${'字'.repeat(2700000)}</p></body></html>`});report(extractEpub(file).source,file.length);}
 else if(kind==='azw3-attributes'){const book=await azw3(`<html><body>${`<p${attributes(25,false)}>x</p>`.repeat(100000)}</body></html>`);report(book.source,0);}
 // Every attribute on one start tag: 800,000 (6.8 MB of XML, 5.3 MB of HTML), gathered by the parser into one object.
 else if(kind==='docx-one-tag'){const file=docx(`<w:p${attributes(800000)}><w:r><w:t>字</w:t></w:r></w:p>`);report(await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)),file.length);}
 else if(kind==='epub-one-tag'){const file=epub({chapter:`<html><body><p${attributes(800000,false)}>x</p></body></html>`});report(extractEpub(file).source,file.length);}
 else throw new Error('kind?');
}catch(error){console.log(JSON.stringify({code:error.code||null,status:error.status||null,message:String(error.message).slice(0,200)}));}
