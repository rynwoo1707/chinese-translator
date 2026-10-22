import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {zipSync,strToU8} from 'fflate';
import mammoth from 'mammoth/mammoth.browser.js';
import {extractDocxText,countTags,DOCX_LIMITS} from './document-limits.js';
import {extractEpub} from './epub.js';
import {extractAzw3} from './azw3.js';
import {readPublication} from './admin-content.js';
import {studyRoute} from './study-translation.js';
import worker,{acceptReaderRequest} from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>';
const packageRels=(target='word/document.xml')=>`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="${target}"/></Relationships>`;
const documentXml=paragraphs=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${paragraphs}</w:body></w:document>`;
const paragraph=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const buffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
function docx(files,level=6){return buffer(zipSync(Object.fromEntries(Object.entries({'[Content_Types].xml':CONTENT_TYPES,'_rels/.rels':packageRels(),...files}).map(([name,value])=>[name,typeof value==='string'?strToU8(value):value])),{level}));}
const refused=async(promise,code)=>{try{await promise;}catch(error){assert.equal(error.code,code,error.message);return error;}assert.fail(`expected ${code}`);};
const small=docx({'word/document.xml':documentXml(paragraph('第一段。')+paragraph('第二段。'))});
// 200,000 short paragraphs: about 3 KB zipped, 800,000 elements and several hundred MB in mammoth.
const bomb=()=>docx({'word/document.xml':documentXml(paragraph('字').repeat(200000))},9);

test('A DOCX within the limits reads exactly as mammoth reads it, real Word files included',async t=>{
 assert.equal(await extractDocxText(small),(await mammoth.extractRawText({arrayBuffer:small})).value);
 const dir=fileURLToPath(new URL('../node_modules/mammoth/test/test-data/',import.meta.url));
 if(!existsSync(dir)){t.diagnostic('mammoth test files not installed');return;}
 let compared=0;
 for(const name of readdirSync(dir).filter(name=>name.endsWith('.docx'))){
  const data=buffer(readFileSync(dir+name));let expected;try{expected=(await mammoth.extractRawText({arrayBuffer:data})).value;}catch{continue;}
  assert.equal(await extractDocxText(data),expected,name);compared++;
 }
 assert.ok(compared>=10,`${compared} Word files compared`);
});

test('A small DOCX that unzips to hundreds of thousands of elements is refused before mammoth parses it',async t=>{
 const file=bomb();assert.ok(file.byteLength<32*1024,`${file.byteLength} bytes`);
 const parse=t.mock.method(mammoth,'extractRawText');
 const error=await refused(extractDocxText(file),'document_too_large');
 assert.equal(error.status,413);assert.match(error.message,/TXT \(UTF-8\) hoặc PDF/u);assert.equal(parse.mock.callCount(),0);
 // Elements in another part mammoth reads (styles) count too.
 await refused(extractDocxText(docx({'word/document.xml':documentXml(paragraph('字')),'word/styles.xml':`<w:styles xmlns:w="${W}">${'<w:style/>'.repeat(DOCX_LIMITS.elements)}</w:styles>`})),'document_too_large');
});

test('A process with 64 MB of heap refuses the small DOCX and EPUB bombs instead of running out of memory',()=>{
 for(const kind of ['docx','epub']){
  const child=spawnSync(process.execPath,['--max-old-space-size=64',fileURLToPath(new URL('./test-support/document-bomb-child.mjs',import.meta.url)),kind],{encoding:'utf8',timeout:120000});
  assert.equal(child.status,0,`${kind}: ${child.stderr.slice(-300)}`);
  const result=JSON.parse(child.stdout.trim().split('\n').at(-1));assert.deepEqual([result.code,result.status],['document_too_large',413],kind);
 }
});

test('Sizes a zip lies about, parts named like images, encryption and ZIP64 never reach mammoth',async t=>{
 // The central directory and local header claim 100 bytes; the part unzips to 1.7 MB. JSZip would unzip it all.
 const lying=new Uint8Array(docx({'word/document.xml':documentXml(paragraph('x').repeat(50000))}));
 const view=new DataView(lying.buffer),name='word/document.xml';
 for(let i=0;i+4<=lying.length;i++){
  const signature=view.getUint32(i,true);
  if(signature===0x04034b50&&new TextDecoder().decode(lying.subarray(i+30,i+30+view.getUint16(i+26,true)))===name)view.setUint32(i+22,100,true);
  if(signature===0x02014b50&&new TextDecoder().decode(lying.subarray(i+46,i+46+view.getUint16(i+28,true)))===name)view.setUint32(i+24,100,true);
 }
 const parse=t.mock.method(mammoth,'extractRawText');
 await refused(extractDocxText(lying.buffer),'docx_invalid');assert.equal(parse.mock.callCount(),0);
 parse.mock.restore();
 // mammoth parses whatever part the relationships name, junk before the XML included: here styles is a ".png" holding
 // a bomb. Parts that are not XML reach mammoth empty, so the document still reads and the bomb is never parsed.
 const styles=strToU8('\u0089PNG\r\n'+`<w:styles xmlns:w="${W}">${'<w:style/>'.repeat(300000)}</w:styles>`);
 const redirected=docx({'word/document.xml':documentXml(paragraph('正文。')),'word/_rels/document.xml.rels':`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${R}/styles" Target="media/image1.png"/></Relationships>`,'word/media/image1.png':styles},9);
 assert.equal(await extractDocxText(redirected),'正文。\n\n');
 // The main document itself named as an image: nothing XML is left to read.
 await refused(extractDocxText(docx({'_rels/.rels':packageRels('word/media/doc.png'),'word/media/doc.png':strToU8(documentXml(paragraph('x').repeat(300000)))},9)),'docx_invalid');
 // Not a zip (a password-protected Word file is an OLE container), an encrypted entry, a ZIP64 end record.
 await refused(extractDocxText(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,...new Uint8Array(600)]).buffer),'docx_invalid');
 const encrypted=new Uint8Array(small.slice(0));for(let i=0;i+4<=encrypted.length;i++)if(new DataView(encrypted.buffer).getUint32(i,true)===0x02014b50)encrypted[i+8]|=1;
 await refused(extractDocxText(encrypted.buffer),'docx_invalid');
 const zip64=new Uint8Array(small.slice(0));zip64.fill(0xff,zip64.length-22+10,zip64.length-22+12);
 await refused(extractDocxText(zip64.buffer),'docx_invalid');
});

test('Every place the server opens a DOCX uses the guard: study extraction, request acceptance, admin jobs and publications',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),reader=await signedIn(sqlite);
 const form=(name,data)=>{const body=new FormData();body.set('file',new File([data],name));return body;};
 const study=body=>{const url=new URL('https://hoatri.example/api/my/study/extract');return studyRoute(new Request(url,{method:'POST',headers:{Cookie:reader.cookie},body}),env,url,url.pathname);};
 let response=await study(form('bai.docx',small));assert.equal(response.status,200);assert.equal((await response.json()).text,'第一段。\n\n第二段。\n\n');
 await refused(study(form('bai.docx',bomb())),'document_too_large');
 // A TXT that cannot fit 2 million characters is refused before it is decoded.
 await refused(study(form('bai.txt',new Uint8Array(8_000_001).fill(0x61))),'document_too_large');
 await refused(readPublication(new File([bomb()],'phan.docx')),'document_too_large');
 assert.equal((await readPublication(new File([small],'phan.docx'))).content,'第一段。\n\n第二段。');
 // A student's request with a bombed DOCX: accepting it fails cleanly and leaves no story, job or stored file behind.
 sqlite.prepare("INSERT INTO requests(id,title,user_id,visibility,file_key,filename,mime) VALUES('r1','Sách',?, 'private','requests/r1/original','sach.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')").run(reader.id);
 await env.FILES.put('requests/r1/original',bomb());
 await refused(acceptReaderRequest('r1',env),'document_too_large');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM stories').get().n,0);assert.deepEqual(env.FILES.keys('uploads/'),[]);
 // The admin upload of a job.
 const admin={...env,ADMIN_TOKEN:'a'.repeat(64)};sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách','Giáo dục')").run();
 const jobForm=new FormData();jobForm.set('story_id','s1');jobForm.set('file',new File([bomb()],'sach.docx'));
 response=await worker.fetch(new Request('https://hoatri.example/api/jobs',{method:'POST',headers:{Authorization:`Bearer ${'a'.repeat(64)}`},body:jobForm}),admin,{});
 assert.equal(response.status,413);assert.equal((await response.json()).code,'document_too_large');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
});

test('An EPUB chapter of nothing but tags is refused before it is parsed; ordinary chapters read as before',()=>{
 const epub=chapter=>zipSync(Object.fromEntries(Object.entries({mimetype:'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>','OPS/book.opf':'<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>','OPS/one.xhtml':chapter}).map(([name,text])=>[name,strToU8(text)])));
 assert.throws(()=>extractEpub(epub(`<html><body>${'<p>字</p>'.repeat(200000)}</body></html>`)),error=>error.code==='document_too_large'&&error.status===413&&/Phần 1 của EPUB/u.test(error.message));
 assert.equal(extractEpub(epub(`<html><body>${'<p>字</p>'.repeat(1000)}</body></html>`)).parts[0].content,Array(1000).fill('字').join('\n\n'));
 assert.equal(countTags('<p>a</p><!-- x --><?pi?><br/>'),2);assert.equal(countTags('<p>'.repeat(10),3),4);
});

test('AZW3 text is checked before the library decompresses it: declared size, record size, chapter size and tags',async()=>{
 const header=new Uint8Array(100);header.set(new TextEncoder().encode('BOOKMOBI'),60);
 const book=({compression=2,fullRawLength=1000,records=[[100,4196]],chapters=[{length:500,html:'<html><body><p>第一章 开始。</p></body></html>'}]}={})=>{
  const loaded=[];
  return {loaded,mobiFile:{palmdocHeader:{compression,numTextRecords:records.length},start:0,recordsOffset:[[0,100],...records],loadTextBuffer:index=>{loaded.push(index);return new Uint8Array(4096);}},fullRawLength,getSpine:()=>chapters,loadText(chapter){this.mobiFile.loadTextBuffer(0);return chapter.html;},getMetadata:()=>({title:'Sách',author:['Tác giả']}),destroy(){}};
 };
 const read=fake=>extractAzw3(header,{init:async()=>fake});
 assert.equal((await read(book())).parts[0].content,'第一章 开始。');
 for(const [label,fake] of [['HUFF/CDIC',book({compression:17480})],['16 MB of text',book({fullRawLength:20*1024*1024})],['a 1 MB record',book({records:[[100,100+1024*1024]]})],['a 9 MB chapter',book({chapters:[{length:9*1024*1024,html:''}]})],['200,000 tags',book({chapters:[{length:500,html:'<p>字</p>'.repeat(200000)}]})]]){
  const error=await refused(read(fake),'document_too_large');assert.equal(error.status,413,label);
  if(label!=='200,000 tags')assert.deepEqual(fake.loaded,[],`${label}: nothing was decompressed`);
 }
});
