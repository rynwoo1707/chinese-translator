import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync,crc32} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {bookSources,planBook,coverageNote,checkLocalSource,assembleBook,concatenateParts,readPageLabels,missingPdfNote} from '../frontend/book-assembly.js';

// The CommonJS build: the package's ES build imports JSON without import attributes, which Node refuses.
const PDFLib=createRequire(import.meta.url)('@cantoo/pdf-lib'),{PDFDocument,StandardFonts,PDFName,PDFNumber,PDFHexString,PDFString,PDFNull,PDFDict}=PDFLib;
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const standardFontDataUrl=new URL('../node_modules/pdfjs-dist/standard_fonts/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1');
const openPdfjs=bytes=>pdfjs.getDocument({data:new Uint8Array(bytes),standardFontDataUrl,verbosity:0}).promise;
const SHA_A='a'.repeat(64),SHA_B='b'.repeat(64);

// A PNG of random pixels: it barely compresses, so every copied original page shows up in the output size.
function noisePng(seed,size=110){
 let state=seed;const raw=Buffer.alloc((size*3+1)*size);for(let i=0;i<raw.length;i++){state=(state*1103515245+12345)>>>0;raw[i]=i%(size*3+1)===0?0:state>>>24;}
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// The original: 10 A4 scan-like pages, an outline using explicit and named destinations (nested, one entry closed), and
// page labels i, ii, 1-6, A-1, A-2 — what a real textbook PDF carries.
async function originalBook(){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),pages=[];
 for(let n=1;n<=10;n++){const page=doc.addPage([595.2,842]),image=await doc.embedPng(noisePng(n));page.drawImage(image,{x:60,y:300,width:470,height:470});page.drawText(`Original page ${n}`,{x:60,y:120,size:20,font});pages.push(page);}
 const {context,catalog}=doc,ref=index=>pages[index].ref;
 const dests=context.obj({Names:[PDFString.of('toc'),context.obj([ref(1),PDFName.of('XYZ'),PDFNumber.of(0),PDFNumber.of(842),PDFNull]),PDFString.of('sec-1-2'),context.obj([ref(6),PDFName.of('Fit')])]});
 catalog.set(PDFName.of('Names'),context.obj({Dests:dests}));
 const node=(title,dest,extra={})=>({title,dest,...extra}),tree=[node('封面',[ref(0),'Fit']),node('目录','toc'),node('第一章 空间向量',[ref(2),'XYZ',0,800,0],{kids:[node('1.1 空间向量及其运算',[ref(3),'FitH',700]),node('1.2 坐标','sec-1-2')]}),node('附录',[ref(8),'Fit'],{closed:true,kids:[node('答案',[ref(9),'Fit'])]})];
 const build=(items,parent)=>{const refs=items.map(()=>context.nextRef());items.forEach((item,i)=>{const dict=context.obj({Title:PDFHexString.fromText(item.title),Parent:parent});dict.set(PDFName.of('Dest'),typeof item.dest==='string'?PDFString.of(item.dest):context.obj([item.dest[0],PDFName.of(item.dest[1]),...item.dest.slice(2).map(v=>PDFNumber.of(v))]));if(i)dict.set(PDFName.of('Prev'),refs[i-1]);if(i<items.length-1)dict.set(PDFName.of('Next'),refs[i+1]);if(item.kids){const sub=build(item.kids,refs[i]);dict.set(PDFName.of('First'),sub[0]);dict.set(PDFName.of('Last'),sub.at(-1));dict.set(PDFName.of('Count'),PDFNumber.of(item.closed?-item.kids.length:item.kids.length));}context.assign(refs[i],dict);});return refs;};
 const root=context.nextRef(),top=build(tree,root);context.assign(root,context.obj({Type:'Outlines',First:top[0],Last:top.at(-1),Count:PDFNumber.of(6)}));catalog.set(PDFName.of('Outlines'),root);
 catalog.set(PDFName.of('PageLabels'),context.obj({Nums:[PDFNumber.of(0),context.obj({S:'r'}),PDFNumber.of(2),context.obj({S:'D',St:PDFNumber.of(1)}),PDFNumber.of(8),context.obj({S:'D',P:PDFString.of('A-'),St:PDFNumber.of(1)})]}));
 return doc.save();
}
// A rendered range: one page per translated page, a fraction of a point smaller than the original, like the real renderer.
async function translatedPart(numbers,tag=''){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
 for(const n of numbers)doc.addPage([595,841.9]).drawText(`Ban dich trang ${n}${tag}`,{x:60,y:700,size:20,font});
 return doc.save();
}
const pageTexts=async bytes=>{const pdf=await openPdfjs(bytes),texts=[];for(let n=1;n<=pdf.numPages;n++)texts.push((await (await pdf.getPage(n)).getTextContent()).items.map(item=>item.str).join(' ').trim());await pdf.loadingTask.destroy();return texts;};

test('The page plan takes every page of each original in chapter order; the most recently saved part wins an overlap',()=>{
 const part=(id,pages,extra={})=>({id,title:id,mime:'application/pdf',file:`/api/chapter-file/${id}`,sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages,updatedAt:'2026-10-01 08:00:00',...extra});
 const parts=[part('a',[4,5,6]),part('b',[7,8]),part('c',[8],{updatedAt:'2026-10-02 08:00:00'}),part('d',[2],{sha256:SHA_B,filename:'tap-2.pdf',totalPages:3}),part('text',[9],{mime:'text/plain',file:null,layout:true}),part('legacy',[1],{sha256:null,filename:'tap-2.pdf',totalPages:3}),part('nameless',[1],{sha256:null,filename:''})];
 const {sources,unplaced}=bookSources(parts);
 assert.deepEqual(sources.map(source=>[source.sha256,source.parts.map(p=>p.id)]),[[SHA_A,['a','b','c','text']],[SHA_B,['d','legacy']]]);assert.deepEqual(unplaced.map(p=>p.id),['nameless']);
 const plan=planBook(sources),describe=entry=>`${entry.page}${entry.from==='translated'?`:${entry.part.id}#${entry.index}`:''}`;
 assert.deepEqual(plan.entries.filter(e=>e.source===sources[0]).map(describe),['1','2','3','4:a#0','5:a#1','6:a#2','7:b#0','8:c#0','9','10']);
 assert.deepEqual(plan.entries.filter(e=>e.source===sources[1]).map(describe),['1:legacy#0','2:d#0','3']);
 assert.equal(plan.translated,7);assert.equal(plan.total,13);assert.equal(coverageNote(plan),'Đã dịch 7/13 trang; các trang còn lại giữ nguyên bản gốc.');
 assert.match(plan.warnings.join('\n'),/Phần “text” chưa có PDF tiếng Việt/);
 // An older save of the same page loses; equal times fall back to the book order (a later part wins).
 const older=planBook(bookSources([part('a',[4,5,6],{updatedAt:'2026-10-03 08:00:00'}),part('x',[5],{updatedAt:'2026-10-02 08:00:00'})]).sources);
 assert.deepEqual(older.entries.slice(3,6).map(describe),['4:a#0','5:a#1','6:a#2']);
 // Page counts come from the stored or picked original when the parts do not know it; pages outside the file are reported.
 const unknown=bookSources([part('a',[4,12],{totalPages:null})]).sources;assert.throws(()=>planBook(unknown),/Chưa biết số trang/);
 const counted=planBook(unknown,new Map([[SHA_A,10]]));assert.equal(counted.total,10);assert.equal(counted.translated,1);assert.match(counted.warnings[0],/trang 12 nằm ngoài tệp gốc 10 trang/);
});

test('Of two parts translating a page, the newer translation wins even after the older part is renamed or moved',()=>{
 const part=(id,pages,translatedAt,updatedAt)=>({id,title:id,mime:'application/pdf',file:`/f/${id}`,sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages,translatedAt,updatedAt});
 // "Trang 4–6" was renamed at 13:00 (updatedAt), after the redo of pages 5–6 was translated at 11:00.
 const plan=planBook(bookSources([part('old',[4,5,6],'2026-10-15 10:00:00','2026-10-15 13:00:00'),part('redo',[5,6],'2026-10-15 11:00:00','2026-10-15 11:00:00')]).sources);
 assert.deepEqual(plan.entries.filter(entry=>entry.from==='translated').map(entry=>`${entry.page}:${entry.part.id}`),['4:old','5:redo','6:redo']);
 // Rows without a translation time (an older client) still fall back to the last save.
 const legacy=planBook(bookSources([part('old',[4,5,6],undefined,'2026-10-15 12:00:00'),part('redo',[5,6],undefined,'2026-10-15 11:00:00')]).sources);
 assert.deepEqual(legacy.entries.filter(entry=>entry.from==='translated').map(entry=>entry.part.id),['old','old','old']);
});

test('A part without a Vietnamese PDF is explained by its kind: a layout range is exported, a text translation redone',()=>{
 const layout={title:'Trang 9',layout:true,filename:'toan.pdf'},browser={title:'Mục lục (đọc tại trình duyệt)',layout:false,filename:'toan.pdf'},docx={title:'Bài đọc thêm',layout:false,filename:'bai-doc.docx'};
 assert.match(missingPdfNote(layout),/^Phần “Trang 9” chưa có PDF tiếng Việt \(hãy mở lại phần này trong Xưởng dịch và bấm Xuất PDF tiếng Việt\); các trang của phần này giữ nguyên bản gốc\.$/u);
 assert.match(missingPdfNote(layout,{inBook:false}),/chưa có trong bản ghép; hãy mở lại phần này trong Xưởng dịch và bấm Xuất PDF tiếng Việt\./u);
 // The export button is disabled for text translations, so they are never told to press it.
 for(const part of [browser,docx])for(const inBook of [true,false])assert.doesNotMatch(missingPdfNote(part,{inBook}),/Xuất PDF/u);
 assert.equal(missingPdfNote(browser),'Phần “Mục lục (đọc tại trình duyệt)” là bản dịch dạng chữ, không có trang PDF, nên các trang của phần này giữ nguyên bản gốc. Muốn có các trang này bằng tiếng Việt trong bản ghép, hãy dịch lại chúng với tùy chọn “Giữ bố cục PDF và xuất PDF tiếng Việt”.');
 // The option is quoted as Xưởng dịch labels it ("xuất PDF": exporting a PDF, not "xuất bản", publishing).
 const label=/<input id="pdf-layout-enabled"[^>]*> <span>([^<]+)<small/u.exec(readFileSync(new URL('../frontend/study.html',import.meta.url),'utf8'))?.[1];
 assert.equal(label,'Giữ bố cục PDF và xuất PDF tiếng Việt');assert.ok(missingPdfNote(browser).includes(`“${label}”`));
 assert.equal(missingPdfNote(docx,{inBook:false}),'Phần “Bài đọc thêm” là bản dịch dạng chữ, không có trang PDF, nên không có trong bản ghép; phần này vẫn đọc được trong Thư viện riêng.');
 const plan=planBook(bookSources([{id:'a',title:'Trang 4',mime:'application/pdf',file:'/f/a',sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages:[4]},{id:'b',...browser,mime:'text/plain',file:null,sha256:SHA_A,totalPages:10,pages:null,pageStart:2,pageEnd:3}]).sources);
 assert.deepEqual(plan.warnings,[missingPdfNote(browser)]);
});

test('An original picked on the device must match the hash of the translated parts, or at least their page count',()=>{
 const withHash={sha256:SHA_A,filename:'toan.pdf',totalPages:10,parts:[{pages:[4,5,6]}]},legacy={sha256:null,filename:'toan.pdf',totalPages:10,parts:[{pages:[7,8]}]};
 assert.deepEqual(checkLocalSource(withHash,{sha256:SHA_A,pageCount:10}),{ok:true});
 assert.match(checkLocalSource(withHash,{sha256:SHA_B,pageCount:10}).error,/không phải bản gốc “toan.pdf”/);
 assert.match(checkLocalSource(legacy,{sha256:SHA_B,pageCount:9}).error,/có 9 trang, còn bản gốc “toan.pdf” có 10 trang/);
 const accepted=checkLocalSource(legacy,{sha256:SHA_B,pageCount:10});assert.equal(accepted.ok,true);assert.match(accepted.warning,/Chưa xác minh được .*trước khi Hoa Trí ghi mã tệp.*\(10\)/);
 assert.match(checkLocalSource({...legacy,totalPages:null},{pageCount:7}).error,/ít hơn trang 8 đã dịch/);
 assert.match(checkLocalSource(withHash,{sha256:'',pageCount:10}).warning,/không tính được mã tệp/);
});

test('The whole book keeps every original page, size, outline and page label, with translated pages in place',async()=>{
 const original=await originalBook(),partA=await translatedPart([4,5,6]),partB=await translatedPart([7,8]),partC=await translatedPart([8],' (sua lai)');
 const part=(id,pages,bytes,updatedAt='2026-10-01 08:00:00')=>({id,title:`Phần ${id}`,mime:'application/pdf',file:`/api/chapter-file/${id}`,sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages,updatedAt,bytes});
 const parts=[part('a',[4,5,6],partA),part('b',[7,8],partB),part('c',[8],partC,'2026-10-02 08:00:00')],{sources}=bookSources(parts),loads=[],progress=[];
 const result=await assembleBook({PDFLib,pdfjs,title:'Toán 1 · Vectơ',sources,loadSource:async source=>{loads.push('source');return original;},loadPart:async p=>{loads.push(p.id);return p.bytes;},onProgress:(done,total)=>progress.push(`${done}/${total}`)});
 assert.equal(result.pages,10);assert.equal(result.plan.translated,5);assert.deepEqual(loads,['a','b','c','source']);assert.equal(progress.at(-1),'10/10');assert.equal(progress.length,10);
 assert.deepEqual(await pageTexts(result.bytes),['Original page 1','Original page 2','Original page 3','Ban dich trang 4','Ban dich trang 5','Ban dich trang 6','Ban dich trang 7','Ban dich trang 8 (sua lai)','Original page 9','Original page 10']);
// pdf-lib rewrites Producer on load unless told not to.
 const book=await PDFDocument.load(result.bytes,{updateMetadata:false});
 // Every page has the original's size, including the rendered ones (595 × 841.9 before).
 assert.deepEqual(book.getPages().map(page=>Object.values(page.getSize()).join('×')),Array(10).fill('595.2×842'));
 // The rendered page grew at the bottom and right: its top edge, and so everything drawn on it, did not move.
 const grown=book.getPage(3).getMediaBox();assert.ok(Math.abs(grown.y+grown.height-841.9)<1e-6&&grown.x===0,JSON.stringify(grown));
 assert.equal(book.getTitle(),'Toán 1 · Vectơ');assert.equal(book.getProducer(),'Hoa Trí');assert.equal(book.getCreator(),'Hoa Trí');assert.equal(book.catalog.lookup(PDFName.of('Lang')).decodeText(),'vi');
 // Only the pages used are written: the replaced originals (with their large images) are not carried along.
 assert.ok(result.bytes.length<original.length*.7,`${result.bytes.length} vs ${original.length}`);
 const pdf=await openPdfjs(result.bytes);
 assert.deepEqual(await pdf.getPageLabels(),['i','ii','1','2','3','4','5','6','A-1','A-2']);
 const outline=async items=>Promise.all((items||[]).map(async item=>[item.title,await pdf.getPageIndex(item.dest[0])+1,item.dest[1].name,item.count??0,...(item.items.length?[await outline(item.items)]:[])]));
 assert.deepEqual(await outline(await pdf.getOutline()),[['封面',1,'Fit',0],['目录',2,'XYZ',0],['第一章 空间向量',3,'XYZ',2,[['1.1 空间向量及其运算',4,'FitH',0],['1.2 坐标',7,'Fit',0]]],['附录',9,'Fit',-1,[['答案',10,'Fit',0]]]]);
 await pdf.loadingTask.destroy();
 assert.equal(readPageLabels(PDFLib,book).length,3);
});

// The same original with a linked table of contents on page 2, as Word or LaTeX (hyperref) exports have: an explicit
// GoTo action, an explicit /Dest, a name from the /Names tree, an old-style /Dests name, a web link and a link to a
// name that does not exist; every annotation names its page in /P.
async function linkedBook(){
 const doc=await PDFDocument.load(await originalBook()),{context}=doc,pages=doc.getPages(),ref=index=>pages[index].ref;
 doc.catalog.set(PDFName.of('Dests'),context.obj({chap1:context.obj([ref(2),PDFName.of('Fit')])}));
 const link=(y,entries)=>context.register(context.obj({Type:'Annot',Subtype:'Link',Rect:[60,y,300,y+20],Border:[0,0,0],P:ref(1),...entries}));
 pages[1].node.set(PDFName.of('Annots'),context.obj([
  link(700,{A:context.obj({S:'GoTo',D:context.obj([ref(3),PDFName.of('XYZ'),PDFNumber.of(0),PDFNumber.of(800),PDFNull])})}),
  link(670,{Dest:context.obj([ref(8),PDFName.of('Fit')])}),
  link(640,{Dest:PDFString.of('sec-1-2')}),
  link(610,{Dest:PDFName.of('chap1')}),
  link(580,{A:context.obj({S:'URI',URI:PDFString.of('https://example.org/')})}),
  link(550,{Dest:PDFString.of('missing')})
 ]));
 return doc.save();
}
const pageObjects=doc=>doc.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFDict&&object.lookup(PDFName.of('Type'))===PDFName.of('Page')).length;
const linkTargets=async(pdf,number)=>Promise.all((await (await pdf.getPage(number)).getAnnotations()).filter(item=>item.subtype==='Link').map(async item=>{
 if(item.url)return item.url;const dest=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;
 return Array.isArray(dest)?await pdf.getPageIndex(dest[0])+1:`unresolved ${JSON.stringify(item.dest)}`;
}));

test('Links of a kept page lead to their pages in the book, and no page is copied twice',async()=>{
 const original=await linkedBook(),plainOriginal=await originalBook(),part=(id,pages,bytes)=>({id,title:id,mime:'application/pdf',file:`/f/${id}`,sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages,updatedAt:'2026-10-01 08:00:00',bytes});
 const parts=async()=>[part('a',[4,5,6],await translatedPart([4,5,6])),part('b',[7,8],await translatedPart([7,8]))];
 const build=async bytes=>assembleBook({PDFLib,pdfjs,title:'Toán 1',sources:bookSources(await parts()).sources,loadSource:async()=>bytes,loadPart:async p=>p.bytes});
 const result=await build(original),plain=await build(plainOriginal);
 const opened=await openPdfjs(original),book=await openPdfjs(result.bytes);
 // In the original the table of contents leads to pages 4, 9, 7 and 3; in the book it still does (4 and 7 are now the
 // translated pages), the web link is kept and the link to a missing name is dropped.
 assert.deepEqual(await linkTargets(opened,2),[4,9,7,3,'https://example.org/','unresolved "missing"']);
 assert.deepEqual(await linkTargets(book,2),[4,9,7,3,'https://example.org/']);
 assert.deepEqual((await pageTexts(result.bytes)).slice(2,9),['Original page 3','Ban dich trang 4','Ban dich trang 5','Ban dich trang 6','Ban dich trang 7','Ban dich trang 8','Original page 9']);
 await opened.loadingTask.destroy();await book.loadingTask.destroy();
 // Exactly the book's ten pages exist: no copy of a linked page (with the scan of a replaced page) rides along.
 const saved=await PDFDocument.load(result.bytes);assert.equal(pageObjects(saved),10);assert.ok(result.bytes.length<plain.bytes.length*1.02,`${result.bytes.length} vs ${plain.bytes.length}`);
 const tocPage=saved.getPage(1),annots=tocPage.node.lookup(PDFName.of('Annots'));
 for(let i=0;i<annots.size();i++)assert.equal(annots.lookup(i).get(PDFName.of('P')),tocPage.ref);
});

test('Joined parts keep their internal links inside the joined file',async()=>{
 // A part whose page 1 links to its own page 3, as a chapter PDF with its own contents list has.
 const linked=async label=>{const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);for(let n=1;n<=3;n++)doc.addPage([595,841.9]).drawText(`${label} trang ${n}`,{x:60,y:700,size:20,font});const pages=doc.getPages();pages[0].node.set(PDFName.of('Annots'),doc.context.obj([doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[60,600,300,620],P:pages[0].ref,Dest:[pages[2].ref,PDFName.of('Fit')]}))]));return doc.save();};
 const parts=[{id:'a',title:'Phần 1',bytes:await linked('Phan 1')},{id:'b',title:'Phần 2',bytes:await linked('Phan 2')}];
 const result=await concatenateParts({PDFLib,title:'Hai phần',parts,loadPart:async part=>part.bytes});
 const book=await openPdfjs(result.bytes);assert.deepEqual([await linkTargets(book,1),await linkTargets(book,4)],[[3],[6]]);await book.loadingTask.destroy();
 assert.equal(pageObjects(await PDFDocument.load(result.bytes)),6);
});

test('A second file restarts page numbers, an unreadable part keeps its originals, and a wrong original is refused',async()=>{
 const original=await originalBook(),plain=await PDFDocument.create();for(let n=1;n<=2;n++)plain.addPage([420,595]).drawText(`Tap 2 trang ${n}`,{x:40,y:500,size:18,font:await plain.embedFont(StandardFonts.Helvetica)});
 const second=await plain.save(),part=(id,pages,extra={})=>({id,title:id,mime:'application/pdf',file:`/f/${id}`,sha256:SHA_A,filename:'toan.pdf',totalPages:10,pages,updatedAt:'2026-10-01 08:00:00',...extra});
 const parts=[part('a',[4],{bytes:await translatedPart([4])}),part('broken',[5,6],{bytes:new TextEncoder().encode('not a pdf')}),part('two',[2],{sha256:SHA_B,filename:'tap-2.pdf',totalPages:2,bytes:await translatedPart([2])})];
 const {sources}=bookSources(parts),originals={[SHA_A]:original,[SHA_B]:second};
 const result=await assembleBook({PDFLib,pdfjs,title:'Hai tập',sources,loadSource:async source=>originals[source.sha256],loadPart:async p=>p.bytes});
 assert.equal(result.pages,12);assert.equal(result.plan.translated,2);assert.match(result.plan.warnings.join('\n'),/Không mở được PDF của phần “broken”.*giữ nguyên bản gốc/u);
 const texts=await pageTexts(result.bytes);assert.deepEqual(texts.slice(3,6),['Ban dich trang 4','Original page 5','Original page 6']);assert.deepEqual(texts.slice(10),['Tap 2 trang 1','Ban dich trang 2']);
 const pdf=await openPdfjs(result.bytes);assert.deepEqual((await pdf.getPageLabels()).slice(8),['A-1','A-2','1','2']);
 // The second file keeps its own page size; a rendered page that is really a different size is not stretched.
 const book=await PDFDocument.load(result.bytes);assert.deepEqual(Object.values(book.getPage(10).getSize()),[420,595]);assert.deepEqual(Object.values(book.getPage(11).getSize()),[595,841.9]);await pdf.loadingTask.destroy();
 // A translated part whose original file is unknown is kept, after the rebuilt originals, instead of being dropped.
 const {sources:known,unplaced}=bookSources([part('a',[4],{bytes:await translatedPart([4])}),{id:'loose',title:'Phần lẻ',mime:'application/pdf',file:'/f/loose',pages:[1],sha256:null,filename:'',bytes:await translatedPart([1],' (le)')}]);
 const withExtra=await assembleBook({PDFLib,pdfjs,title:'x',sources:known,extras:unplaced,loadSource:async()=>original,loadPart:async p=>p.bytes});
 assert.equal(withExtra.pages,11);assert.equal((await pageTexts(withExtra.bytes))[10],'Ban dich trang 1 (le)');assert.match(withExtra.plan.warnings.join('\n'),/“Phần lẻ” không rõ tệp gốc nên được đặt ở cuối sách/u);
 // The stored original must have the page count the translated ranges were made from.
 await assert.rejects(()=>assembleBook({PDFLib,pdfjs,title:'x',sources:bookSources([part('a',[4],{bytes:null})]).sources,loadSource:async()=>second,loadPart:async()=>translatedPart([4])}),/có 2 trang, khác 10 trang/);
 // A part that cannot be downloaded fails the whole download (a retry gives the full book) instead of silently dropping it.
 await assert.rejects(()=>assembleBook({PDFLib,pdfjs,title:'x',sources:bookSources([part('a',[4])]).sources,loadSource:async()=>original,loadPart:async()=>{throw Object.assign(new Error('Không tải được phần 1.'),{known:true});}}),/Không tải được phần 1/);
});

test('Without the originals the parts are joined behind the book cover image',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 const parts=[{id:'a',title:'Trang 4–6',bytes:await translatedPart([4,5,6])},{id:'b',title:'Trang 7–8',bytes:await translatedPart([7,8])}],seen=[];
 const result=await concatenateParts({PDFLib,title:'Toán 1',parts,loadPart:async part=>part.bytes,cover:{type:'image/png',bytes:png},onProgress:(i,n)=>seen.push(`${i}/${n}`)});
 assert.equal(result.pages,6);assert.deepEqual(seen,['1/2','2/2']);
 const texts=await pageTexts(result.bytes);assert.equal(texts[0],'');assert.deepEqual(texts.slice(1),['Ban dich trang 4','Ban dich trang 5','Ban dich trang 6','Ban dich trang 7','Ban dich trang 8']);
 const book=await PDFDocument.load(result.bytes);assert.deepEqual(Object.values(book.getPage(0).getSize()),[595,841.9]);assert.equal(book.getTitle(),'Toán 1');
 const plainJoin=await concatenateParts({PDFLib,title:'Toán 1',parts,loadPart:async part=>part.bytes});assert.equal(plainJoin.pages,5);
});
