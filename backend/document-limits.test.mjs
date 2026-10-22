import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {zipSync,strToU8} from 'fflate';
import {parseDocument} from 'htmlparser2';
import mammoth from 'mammoth/mammoth.browser.js';
import {extractDocxText,countTags,markupText,DOCX_LIMITS,HTML_ELEMENTS} from './document-limits.js';
import {extractEpub} from './epub.js';
import {extractAzw3,azw3HtmlToText} from './azw3.js';
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
// 200,000 short paragraphs: about 3 KB zipped, 800,000 elements and several hundred MB in a tree.
const bomb=()=>docx({'word/document.xml':documentXml(paragraph('字').repeat(200000))},9);
const mammothText=async data=>(await mammoth.extractRawText({arrayBuffer:data})).value;

test('A DOCX within the limits reads exactly as mammoth reads it, real Word files included',async t=>{
 assert.equal(await extractDocxText(small),await mammothText(small));
 const dir=fileURLToPath(new URL('../node_modules/mammoth/test/test-data/',import.meta.url));
 if(!existsSync(dir)){t.diagnostic('mammoth test files not installed');return;}
 let compared=0;
 for(const name of readdirSync(dir).filter(name=>name.endsWith('.docx'))){
  const data=buffer(readFileSync(dir+name));let expected;try{expected=await mammothText(data);}catch{continue;}
  assert.equal(await extractDocxText(data),expected,name);compared++;
 }
 assert.ok(compared>=15,`${compared} Word files compared`);
});

// Documents put together from everything mammoth's raw text depends on, in random combinations: deleted paragraph marks
// (tracked changes: the paragraph joins the next one, also from inside a text box), text boxes in VML pictures and in
// mc:AlternateContent, content controls and checkbox ones, merged and spanned cells, deleted rows, bookmarks between
// rows, fields, symbols, hyphens, tabs and breaks, what mammoth leaves out (equations, simple fields, custom XML, deleted
// text), CDATA, character references and line ends, another prefix for the main namespace, and the strict namespace.
test('Generated Word documents read exactly as mammoth reads them',async()=>{
 let seed=20261022,w='w';const random=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
 const pick=list=>list[Math.floor(random()*list.length)],maybe=chance=>random()<chance,some=(most,make)=>Array.from({length:Math.floor(random()*(most+1))},make).join('');
 // CDATA only before the text: mammoth fails on a w:t whose text it splits in two.
 const t=()=>maybe(0.05)?`<${w}:t/>`:`<${w}:t${maybe(0.2)?' xml:space="preserve"':''}>${maybe(0.1)?'<![CDATA[cd]]>':''}${some(3,()=>pick(['学习','数学 ',' x ','a\r\nb','c\rd','&amp;&lt;b&gt;','&#x4e2d;','&#13;','']))}</${w}:t>`;
 const box=depth=>`<${w}:pict><v:shape><v:textbox><${w}:txbxContent>${paragraph(depth+1)}${some(1,()=>paragraph(depth+1))}</${w}:txbxContent></v:textbox></v:shape></${w}:pict>`;
 const runPart=depth=>pick([t,t,t,()=>`<${w}:tab/>`,()=>`<${w}:br/>`,()=>`<${w}:br ${w}:type="page"/>`,()=>`<${w}:cr/>`,()=>`<${w}:noBreakHyphen/><${w}:softHyphen/>`,
  ()=>`<${w}:sym ${w}:font="${pick(['Symbol','Wingdings','Nothing'])}" ${w}:char="${pick(['F061','F0FC','0061','f061'])}"/>`,()=>`<${w}:footnoteReference ${w}:id="1"/>`,()=>`<${w}:delText>x</${w}:delText>`,
  ()=>depth<2?box(depth):t(),()=>depth<2?`<mc:AlternateContent><mc:Choice Requires="wps"><${w}:drawing><wp:inline/></${w}:drawing></mc:Choice><mc:Fallback>${box(depth)}</mc:Fallback></mc:AlternateContent>`:t(),
  ()=>`<${w}:drawing><wp:inline><wp:docPr id="1" name="x"/></wp:inline></${w}:drawing>`])();
 const run=depth=>`<${w}:r>${maybe(0.3)?`<${w}:rPr><${w}:b/></${w}:rPr>`:''}${some(3,()=>runPart(depth))}</${w}:r>`;
 const inline=depth=>pick([run,run,run,d=>`<${w}:hyperlink r:id="rId5">${run(d)}</${w}:hyperlink>`,d=>`<${w}:hyperlink>${run(d)}</${w}:hyperlink>`,d=>`<${w}:ins ${w}:id="1">${run(d)}</${w}:ins>`,
  d=>`<${w}:del ${w}:id="2">${run(d)}</${w}:del>`,d=>`<${w}:smartTag>${run(d)}</${w}:smartTag>`,d=>`<${w}:fldSimple ${w}:instr="PAGE">${run(d)}</${w}:fldSimple>`,d=>`<${w}:customXml>${run(d)}</${w}:customXml>`,
  ()=>`<${w}:bookmarkStart ${w}:id="0" ${w}:name="${pick(['_GoBack','mark'])}"/><${w}:bookmarkEnd ${w}:id="0"/>`,()=>'<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>',
  d=>`<${w}:r><${w}:fldChar ${w}:fldCharType="begin"/></${w}:r><${w}:r><${w}:instrText> HYPERLINK "http://x" </${w}:instrText></${w}:r><${w}:r><${w}:fldChar ${w}:fldCharType="separate"/></${w}:r>${run(d)}<${w}:r><${w}:fldChar ${w}:fldCharType="end"/></${w}:r>`,
  d=>`<${w}:sdt><${w}:sdtPr>${maybe(0.5)?'<w14:checkbox><w14:checked w14:val="1"/></w14:checkbox>':''}</${w}:sdtPr><${w}:sdtContent>${some(2,()=>run(d))}</${w}:sdtContent></${w}:sdt>`])(depth);
 const paragraph=depth=>{const deleted=maybe(0.15);return `<${w}:p>${deleted||maybe(0.3)?`<${w}:pPr><${w}:jc ${w}:val="center"/>${deleted?`<${w}:rPr><${w}:del ${w}:id="3"/></${w}:rPr>`:''}</${w}:pPr>`:''}${some(3,()=>inline(depth))}</${w}:p>`;};
 const cell=depth=>`<${w}:tc>${maybe(0.6)?`<${w}:tcPr>${maybe(0.2)?`<${w}:gridSpan ${w}:val="2"/>`:''}${maybe(0.4)?`<${w}:vMerge${pick(['',` ${w}:val="restart"`,` ${w}:val="continue"`])}/>`:''}</${w}:tcPr>`:''}${depth<1&&maybe(0.15)?table(depth+1):''}${paragraph(depth)}</${w}:tc>`;
 const row=depth=>`<${w}:tr>${maybe(0.2)?`<${w}:trPr>${pick([`<${w}:del ${w}:id="4"/>`,`<${w}:tblHeader/>`])}</${w}:trPr>`:''}${maybe(0.08)?`<${w}:bookmarkStart ${w}:id="1" ${w}:name="c"/>`:''}${some(3,()=>maybe(0.1)?`<${w}:sdt><${w}:sdtContent>${cell(depth)}</${w}:sdtContent></${w}:sdt>`:cell(depth))}</${w}:tr>`;
 const table=depth=>`<${w}:tbl><${w}:tblPr/><${w}:tblGrid/>${some(4,()=>row(depth))}</${w}:tbl>`;
 const block=()=>pick([()=>paragraph(0),()=>paragraph(0),()=>table(0),()=>`<${w}:sdt><${w}:sdtPr>${maybe(0.3)?'<w14:checkbox/>':''}</${w}:sdtPr><${w}:sdtContent>${paragraph(0)}</${w}:sdtContent></${w}:sdt>`,()=>`<${w}:customXml>${paragraph(0)}</${w}:customXml>`,()=>`<!-- x -->${paragraph(0)}`])();
 const namespaces=uri=>`xmlns:${w}="${uri}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"`;
 const links=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="${R}/hyperlink" Target="http://example.com" TargetMode="External"/></Relationships>`;
 for(let n=0;n<250;n++){
  w=maybe(0.2)?'ns0':'w';const uri=maybe(0.15)?'http://purl.oclc.org/ooxml/wordprocessingml/main':W;
  const xml=`${maybe(0.1)?String.fromCharCode(0xfeff):''}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<${w}:document ${namespaces(uri)}><${w}:body>${some(5,block)}<${w}:sectPr/></${w}:body></${w}:document>`;
  const data=docx({'word/document.xml':xml,'word/_rels/document.xml.rels':links});
  assert.equal(await extractDocxText(data),await mammothText(data),xml);
 }
});

test('A small DOCX that unzips to hundreds of thousands of elements is refused, and parts the text never needs are not read',async t=>{
 const file=bomb();assert.ok(file.byteLength<32*1024,`${file.byteLength} bytes`);
 const error=await refused(extractDocxText(file),'document_too_large');
 assert.equal(error.status,413);assert.match(error.message,/TXT \(UTF-8\) hoặc PDF/u);
 // The limit counts the main document wherever the relationships put it.
 await refused(extractDocxText(docx({'_rels/.rels':packageRels('/word/main.xml'),'word/main.xml':documentXml(paragraph('字').repeat(DOCX_LIMITS.elements))})),'document_too_large');
 assert.equal(await extractDocxText(docx({'_rels/.rels':packageRels('/word/main.xml'),'word/main.xml':documentXml(paragraph('主文档。'))})),'主文档。\n\n');
 // Styles, numbering and the rest never change the text: a part of them as large as the limit is not even unzipped.
 assert.equal(await extractDocxText(docx({'word/document.xml':documentXml(paragraph('字')),'word/styles.xml':`<w:styles xmlns:w="${W}">${'<w:style/>'.repeat(DOCX_LIMITS.elements)}</w:styles>`})),'字\n\n');
 // Nesting deeper than any document refuses before the parser's stack grows with it.
 await refused(extractDocxText(docx({'word/document.xml':documentXml(`${'<w:sdt><w:sdtContent>'.repeat(600)}${paragraph('x')}${'</w:sdtContent></w:sdt>'.repeat(600)}`)})),'document_too_large');
});

test('Small files heavy in elements, attributes or repeated text are read or refused in 64 and 128 MB of heap, never run out of memory',()=>{
 const outcomes={docx:'document_too_large','docx-attributes':'ok','docx-one-tag':'document_too_large',epub:'document_too_large','epub-attributes':'ok','epub-one-tag':'document_too_large','opf-attributes':'ok','epub-repeat':'document_too_large','azw3-attributes':'ok'};
 for(const heap of [64,128])for(const [kind,outcome] of Object.entries(outcomes)){
  const child=spawnSync(process.execPath,[`--max-old-space-size=${heap}`,fileURLToPath(new URL('./test-support/document-bomb-child.mjs',import.meta.url)),kind],{encoding:'utf8',timeout:120000});
  assert.equal(child.status,0,`${kind} in ${heap} MB: ${child.stderr.slice(-300)}`);
  const result=JSON.parse(child.stdout.trim().split('\n').at(-1));
  if(outcome==='ok')assert.equal(result.ok,true,`${kind} in ${heap} MB: ${result.message}`);else assert.deepEqual([result.code,result.status],[outcome,413],`${kind} in ${heap} MB`);
 }
});

test('Sizes a zip lies about, parts named like images, encryption and ZIP64 are refused or never read',async()=>{
 // The central directory and local header claim 100 bytes; the part unzips to 1.7 MB. JSZip would unzip it all.
 const lying=new Uint8Array(docx({'word/document.xml':documentXml(paragraph('x').repeat(50000))}));
 const view=new DataView(lying.buffer),name='word/document.xml';
 for(let i=0;i+4<=lying.length;i++){
  const signature=view.getUint32(i,true);
  if(signature===0x04034b50&&new TextDecoder().decode(lying.subarray(i+30,i+30+view.getUint16(i+26,true)))===name)view.setUint32(i+22,100,true);
  if(signature===0x02014b50&&new TextDecoder().decode(lying.subarray(i+46,i+46+view.getUint16(i+28,true)))===name)view.setUint32(i+24,100,true);
 }
 await refused(extractDocxText(lying.buffer),'docx_invalid');
 // The document's relationships can name any part, junk before the XML included: here styles is a ".png" holding a
 // bomb. Only the main document is read, so the document still reads and the bomb is never unzipped.
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

const epubFile=({chapter='<html><body><p>字</p></body></html>',items='',spine='<itemref idref="one"/>'}={})=>zipSync(Object.fromEntries(Object.entries({mimetype:'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>','OPS/book.opf':`<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>${items}</manifest><spine>${spine}</spine></package>`,'OPS/one.xhtml':chapter}).map(([name,text])=>[name,strToU8(text)])));
const tooLarge=pattern=>error=>error.code==='document_too_large'&&error.status===413&&pattern.test(error.message);

test('An EPUB chapter of nothing but tags is refused before it is parsed; ordinary chapters read as before',()=>{
 assert.throws(()=>extractEpub(epubFile({chapter:`<html><body>${'<p>字</p>'.repeat(200000)}</body></html>`})),tooLarge(/Phần 1 của EPUB/u));
 assert.equal(extractEpub(epubFile({chapter:`<html><body>${'<p>字</p>'.repeat(1000)}</body></html>`})).parts[0].content,Array(1000).fill('字').join('\n\n'));
 assert.equal(countTags('<p>a</p><!-- x --><?pi?><br/>'),2);assert.equal(countTags('<p>'.repeat(10),3),4);
 // Tags never closed nest deeper than any chapter (the tree walk ran out of stack at a few thousand levels).
 assert.throws(()=>extractEpub(epubFile({chapter:`<html><body>${'<span>'.repeat(5000)}字</body></html>`})),tooLarge(/Phần 1 của EPUB/u));
 assert.equal(extractEpub(epubFile({chapter:`<html><body>${'<span>'.repeat(3500)}字</body></html>`})).parts[0].content,'字');
});

// The tree walk epub.js and azw3.js read chapters with before they read them as a stream: the reference for markupText.
const nodeName=node=>(node.name||'').split(':').pop().toLowerCase();
const named=(node,name)=>(node.children||[]).flatMap(child=>[...nodeName(child)===name?[child]:[],...named(child,name)]);
const BLOCKS=new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','blockquote','tr','pre','hr']);
function walk(node){
 if(node.type==='text')return node.data.replace(/[\t\r\n ]+/g,' ');
 const name=nodeName(node);if(['script','style','head','noscript','rt','rp'].includes(name))return '';if(name==='br')return '\n';
 const content=(node.children||[]).map(walk).join('');return BLOCKS.has(name)?'\n'+content+'\n':name==='td'?content+'\t':content;
}
test('EPUB and AZW3 chapters read exactly as the tree walk of their HTML read them, on generated HTML',()=>{
 let seed=7;const random=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
 const pick=list=>list[Math.floor(random()*list.length)],some=(most,make)=>Array.from({length:Math.floor(random()*(most+1))},make).join('');
 const TAGS=['p','div','span','b','td','tr','table','li','h1','pre','blockquote','font','br','hr','img','svg','image','script','style','head','noscript','rt','rp','ruby','body','html','x:p','math','select','textarea','form'];
 const TEXTS=['字','Hello  world',' \n\t ','&amp;&nbsp;&lt;p&gt;','a&#10;b','x\r\ny','<!-- c -->','<![CDATA[cd]]>','<?pi x?>','<!DOCTYPE html>','</p>','</br>','</td>','<','中文。'];
 const node=depth=>{
  if(depth>5||random()<0.35)return pick(TEXTS);
  const tag=pick(TAGS),open=`<${tag}${random()<0.3?' class="c" data-x=\'y\'':''}`;
  return random()<0.1?`${open}/>`:random()<0.1?`${open}>${some(2,()=>node(depth+1))}`:`${open}>${some(3,()=>node(depth+1))}</${random()<0.05?pick(TAGS):tag}>`;
 };
 const tooComplex=()=>new Error('too complex');
 for(let n=0;n<1500;n++){
  const html=random()<0.5?`<html><head><title>t</title><style>s</style></head><body>${some(4,()=>node(0))}</body></html>`:some(5,()=>node(0));
  const tree=parseDocument(html,{decodeEntities:true}),body=named(tree,'body')[0]||tree;
  assert.deepEqual(markupText(html,{body:true,tooComplex}),{text:walk(body),images:named(body,'img').length+named(body,'svg').length>0},html);
  assert.equal(markupText(html,{tooComplex}).text,walk(tree),html);
  assert.equal(azw3HtmlToText(html),walk(tree).replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim(),html);
 }
});

test('An EPUB is refused cleanly when its reading order repeats a chapter past 25 MB of text or lists too many parts, or its package file is all tags',()=>{
 // A chapter of a million characters named 30 times: 30 million characters out of a file of a few KB.
 assert.throws(()=>extractEpub(epubFile({chapter:`<html><body><p>${'字'.repeat(1000000)}</p></body></html>`,spine:'<itemref idref="one"/>'.repeat(30)})),tooLarge(/vượt quá 25 MB/u));
 // Named a few times, it reads, each time as a part, as before.
 const repeated=extractEpub(epubFile({spine:'<itemref idref="one"/>'.repeat(3)}));assert.equal(repeated.chapterCount,3);assert.equal(repeated.source,'[Phần EPUB 1: 字]\n字\n\n[Phần EPUB 2: 字]\n字\n\n[Phần EPUB 3: 字]\n字');
 assert.throws(()=>extractEpub(epubFile({spine:'<itemref idref="one"/>'.repeat(20001)})),tooLarge(/20\.000 phần/u));
 assert.equal(extractEpub(epubFile({spine:'<itemref idref="one"/>'.repeat(20000)})).chapterCount,20000);
 assert.throws(()=>extractEpub(epubFile({items:'<item/>'.repeat(HTML_ELEMENTS)})),tooLarge(/Tệp mô tả của EPUB/u));
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
