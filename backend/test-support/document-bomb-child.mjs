// Run with a small heap (node --max-old-space-size=64 document-bomb-child.mjs <kind>): builds a document of a few KB that
// unzips to a huge number of elements and reads it the way the server does. Prints {"ok":…} or {"code":…}; a parser
// that builds the whole tree runs out of memory and the process dies instead.
import {zipSync,strToU8} from 'fflate';
import {extractDocxText} from '../document-limits.js';
import {extractEpub} from '../epub.js';

const kind=process.argv[2];
const CONTENT_TYPES='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS='<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
try{
 if(kind==='docx'){
  const xml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>字</w:t></w:r></w:p>'.repeat(200000)}</w:body></w:document>`;
  const file=zipSync({'[Content_Types].xml':strToU8(CONTENT_TYPES),'_rels/.rels':strToU8(RELS),'word/document.xml':strToU8(xml)},{level:9});
  const text=await extractDocxText(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));
  console.log(JSON.stringify({ok:true,characters:text.length,bytes:file.length}));
 }else if(kind==='epub'){
  const file=zipSync(Object.fromEntries(Object.entries({mimetype:'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>','OPS/book.opf':'<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>','OPS/one.xhtml':`<html><body>${'<p>字</p>'.repeat(800000)}</body></html>`}).map(([name,text])=>[name,strToU8(text)])),{level:9});
  const book=extractEpub(file);console.log(JSON.stringify({ok:true,characters:book.source.length,bytes:file.length}));
 }else throw new Error('kind?');
}catch(error){console.log(JSON.stringify({code:error.code||null,status:error.status||null,message:String(error.message).slice(0,200)}));}
