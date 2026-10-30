import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deflateSync,crc32} from 'node:zlib';
import {W,H,BODY,BODY2,chineseFont,write,pdf,image,fill,glyphs,png,drawScan} from './test-support/text-pdf.mjs';

// A PDF read as text in the browser (frontend/pdf-client.js: the study page's text mode and every Xưởng dịch upload),
// run here with the pdf.js the app ships: backend/vendor.mjs copies pdfjs-dist's legacy build to /vendor and its
// cmaps, standard_fonts and wasm folders to the URLs of PDFJS_ASSETS, mapped back to node_modules below. Every fixture
// is written here with pdf-lib from its own text (test-support/text-pdf.mjs); Chinese is set in fonts the PDF names
// without embedding them, as many Chinese PDFs are, and scans are drawn pixel by pixel.
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),dist=pathToFileURL(root+'node_modules/pdfjs-dist/').href;
const assets=Object.fromEntries(['cmaps','standard_fonts','wasm'].map(folder=>[`/vendor/${folder}/`,`${root}node_modules/pdfjs-dist/${folder}/`]));
const shim=`import * as pdfjs from '${dist}legacy/build/pdf.mjs';export * from '${dist}legacy/build/pdf.mjs';const assets=${JSON.stringify(assets)};
export function getDocument(source){return pdfjs.getDocument({verbosity:0,...Object.fromEntries(Object.entries(source).map(([key,value])=>[key,assets[value]??value]))});}`;
registerHooks({resolve(specifier,context,next){
 if(specifier==='/vendor/pdf.mjs')return {url:'data:text/javascript,'+encodeURIComponent(shim),shortCircuit:true};
 if(specifier==='/vendor/pdf.worker.mjs')return {url:dist+'legacy/build/pdf.worker.mjs',shortCircuit:true};
 return next(specifier,context);
}});
const {analyzePdf,cleanPdfPages,readPictureText,scanReading}=await import('../frontend/pdf-client.js');
const ops=require('@cantoo/pdf-lib');
let canvasReady=false;try{await import('@napi-rs/canvas');canvasReady=true;}catch{}
const drawing=canvasReady?{}:{skip:'pdf.js cannot draw pages here (@napi-rs/canvas is missing)'};

const analyze=async bytes=>analyzePdf(new File([bytes],'tai-lieu.pdf',{type:'application/pdf'}));
const pageLines=(analysis,number)=>analysis.pages[number-1].text.split('\n');

test('Text mode reads every font: headings set through a predefined CMap (UniGB-UCS2-H) reach the text with the body',async()=>{
 const bytes=await pdf(async doc=>{
  const page=doc.addPage([W,H]),gb=chineseFont(doc,page,'G','gb'),body=chineseFont(doc,page,'B');
  write(page,gb,22,150,760,'第一章 河流与城市');write(page,gb,14,60,700,'一、交通运输');
  for(let l=0;l<6;l++)write(page,body,11,60,670-l*20,l%2?BODY2:BODY);
  write(page,gb,14,60,520,'练习');write(page,body,11,60,495,'1. 说出两条你熟悉的河流。');
 });
 // The fixture needs the CMaps: pdf.js without them has no text for the headings.
 const pdfjs=await import('/vendor/pdf.mjs'),bare=await (await import(`${dist}legacy/build/pdf.mjs`)).getDocument({data:new Uint8Array(bytes),verbosity:0}).promise;
 try{const items=(await (await bare.getPage(1)).getTextContent()).items.map(item=>item.str).join('');assert.match(items,/河流为沿岸城市/u);assert.doesNotMatch(items,/交通运输|练习/u);}finally{await bare.loadingTask.destroy();}
 assert.ok(pdfjs.OPS,'the app reads the same pdf.js');
 const analysis=await analyze(bytes);
 assert.equal(analysis.mode,'text');
 assert.deepEqual(pageLines(analysis,1),['第一章 河流与城市','一、交通运输',...Array.from({length:6},(_,l)=>l%2?BODY2:BODY),'练习','1. 说出两条你熟悉的河流。']);
});

test('Page furniture by place: a running head goes where it repeats, the chapter title it equals stays, folios go only in step, answers stay',async()=>{
 // Four pages; the running head and the folio are drawn first on some pages and last on others (the order a page
 // draws them in is not where they stand).
 const bytes=await pdf(async doc=>{
  for(let n=1;n<=4;n++){
   const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'+n),furniture=()=>{if(n>1){write(page,font,9,230,810,'第一章 河流与城市');write(page,font,9,290,40,String(n+5));}};
   if(n%2)furniture();
   if(n===1)write(page,font,22,150,760,'第一章 河流与城市');
   write(page,font,11,60,700,'思考与讨论');for(let l=0;l<5;l++)write(page,font,11,60,670-l*20,l%2?BODY2:BODY);
   if(n===3){write(page,font,11,60,560,'答：长度差为');write(page,font,11,60,540,'400');}
   if(!(n%2))furniture();
  }
 });
 const analysis=await analyze(bytes);
 assert.equal((analysis.text.match(/第一章 河流与城市/gu)||[]).length,1,'the chapter title once, on its opening page');
 assert.equal(pageLines(analysis,1)[0],'第一章 河流与城市');
 for(const n of [2,3,4])assert.doesNotMatch(analysis.pages[n-1].text,/^(?:7|8|9)$/mu,`page ${n}: its folio (printed ${n+5}) goes`);
 assert.deepEqual(pageLines(analysis,3).slice(-2),['答：长度差为','400'],'an answer and its number stay');
 for(const n of [1,2,3,4])assert.equal(pageLines(analysis,n).filter(line=>line==='思考与讨论').length,1,`page ${n}: a heading inside the page stays`);
});

test('Page furniture from text alone: three pages at one edge; numbers kept unless in step, in 1- and 2-page files too',()=>{
 // A heading that opens a few pages of a long document is no running head: it does not come back on nearly half of the
 // pages between its first and last.
 const long=Array.from({length:14},(_,i)=>`${[4,8,13].includes(i)?'练习\n':''}正文第${i+1}页的内容。\n继续说明。`);
 assert.equal((cleanPdfPages(long).match(/^练习$/gmu)||[]).length,3);
 assert.match(cleanPdfPages(['问题一：两条河流的长度差是多少？\n答：长度差为\n400']),/答：长度差为\n400$/u);
 const two=cleanPdfPages(['第一题的答案是\n12','第二题的答案是\n40']);assert.match(two,/\n12\n/u);assert.match(two,/\n40$/u);
 assert.match(cleanPdfPages(['一半写成\n3/4','另一半写成\n2/4']),/\n3\/4\n[\s\S]*\n2\/4$/u,'a fraction is no page label');
 const folios=cleanPdfPages(['正文一。\n7','正文二。\n8']);assert.doesNotMatch(folios,/^(?:7|8)$/mu,'7 and 8 run in step with pages 1 and 2');
 // A heading is never glued to the line after it; a wrapped line still joins.
 assert.equal(cleanPdfPages(['第二节 城市的发展\n一、城市的起源\n城市沿河扩展，形成了带状分布的格局，并\n逐渐向两岸延伸。\n春风吹过河岸\n柳枝轻轻摇动\n表1-1 主要河流的比较\n名称 长度 流经地区\n甲河 1200 北部平原']),
  '[Trang PDF 1]\n第二节 城市的发展\n一、城市的起源\n城市沿河扩展，形成了带状分布的格局，并逐渐向两岸延伸。\n春风吹过河岸\n柳枝轻轻摇动\n表1-1 主要河流的比较\n名称 长度 流经地区\n甲河 1200 北部平原');
});

// A heading, an item or an answer set in body type that opens or closes a page is no running head, however often it
// does: it stays on each page, as a body sentence that happens to open several pages does. A running head set smaller
// than the body stays once; an "N 页" folio in the margin goes, an answer "12页" in the body stays.
test('A body-size heading, item or answer opening or closing pages stays on each; a running head in smaller type stays once',async()=>{
 const analysis=await analyze(await pdf(async doc=>{
  for(let n=1;n<=8;n++){
   const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'+n);let y=770,k=0;
   const line=text=>{write(page,font,11,60,y,text);y-=20;};
   if(n>1)write(page,font,9,230,812,'第一章 河流与城市');
   if([2,4,6].includes(n))line('思考');
   if([6,7,8].includes(n))line('一、选择题');
   while(y>150)line(k++%2?BODY2:BODY);
   if(n===3){line('答：还剩');line('12页');}
   y=78;line([2,3,4].includes(n)?'答案：略':'本节完。');
   write(page,font,9,280,40,`${n+10} 页`);
  }
 }));
 const on=pattern=>analysis.pages.filter(page=>pattern.test(page.text)).map(page=>page.number);
 assert.deepEqual([on(/^思考$/mu),on(/^一、选择题$/mu),on(/^答案：略$/mu),on(/^本节完。$/mu)],[[2,4,6],[6,7,8],[2,3,4],[1,5,6,7,8]]);
 assert.deepEqual(on(/第一章 河流与城市/u),[2],'the running head once, where it first appears');
 assert.deepEqual(on(/^\d+ 页$/mu),[],'the folios go');
 assert.deepEqual(pageLines(analysis,3).slice(-3),['答：还剩','12页','答案：略'],'an answer reading "12页" stays');
 for(const n of [1,3,5])assert.equal(pageLines(analysis,n)[0],BODY,`page ${n}: a body sentence opening the page stays`);
});

// A line joins the next only where it runs its column's full width, as a wrap of a paragraph does: verse lines, a table's
// rows, options, a dialogue's turns and bracketed labels keep their own lines, placed on the page or read without places.
test('Verse lines, table rows, options, speakers and labels keep their own lines; a line running its column\'s full width joins the next',async()=>{
 const poem=['再别康桥','轻轻的我走了','正如我轻轻的来','我轻轻的招手','作别西天的云彩'],long='河流为沿岸城市提供了水源和便利的交通条件许多城市因此沿河兴起并不断扩展';
 const analysis=await analyze(await pdf(async doc=>{
  const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F');
  write(page,font,18,240,780,poem[0]);poem.slice(1).forEach((text,k)=>write(page,font,14,200,740-k*26,text));
  [['名称','长度','流经地区'],['甲河','一千二百','北部平原']].forEach((row,r)=>row.forEach((cell,k)=>write(page,font,11,60+k*150,600-r*20,cell)));
  write(page,font,11,60,560,`${long}人们利用河`);write(page,font,11,60,540,'水灌溉农田。');
 }));
 assert.deepEqual(pageLines(analysis,1),[...poem,'名称 长度 流经地区','甲河 一千二百 北部平原',`${long}人们利用河水灌溉农田。`]);
 const items=['下列说法正确的是（ ）',`A．${long}`,`B．${long}`,`甲：${long}`,`乙：${long}`,`【答案】${long}`,`[1]${long}`];
 assert.deepEqual(cleanPdfPages([items.join('\n')]).split('\n').slice(1),items);
 assert.equal(cleanPdfPages([poem.join('\n')]),`[Trang PDF 1]\n${poem.join('\n')}`,'a verse read without places keeps its lines');
});

test('A searchable scan is read as a scan: an invisible OCR layer, or one painted under the picture, keeps its text as the hint',async()=>{
 const layer=async(doc,page,{under=false,lines=4}={})=>{const font=chineseFont(doc,page,'F');if(!under)await drawScan(doc,page);for(let l=0;l<lines;l++)write(page,font,11,60,640-l*26,l%2?BODY2:BODY,{mode:under?0:3});if(under)await drawScan(doc,page);};
 for(const [name,options] of [['invisible',{}],['under the picture',{under:true}]]){
  const analysis=await analyze(await pdf(async doc=>layer(doc,doc.addPage([W,H]),options)));
  assert.deepEqual(analysis.pages.map(page=>[page.kind,page.reclassified]),[['scan','hidden']],name);
  assert.equal(analysis.mode,'scan',name);assert.equal(analysis.reclassified,1,name);
  assert.equal(analysis.pages[0].text,[BODY,BODY2,BODY,BODY2].join('\n'),`${name}: the layer stays as the page's text`);
  assert.match(analysis.notes[0],/^Trang 1: lớp chữ có sẵn của PDF là chữ nhận dạng nằm ẩn dưới ảnh scan/u);
 }
 // A scan stored as a black-and-white stencil (an image mask) under its OCR layer, then a born-digital page: hybrid.
 const mixed=await analyze(await pdf(async doc=>{
  const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'),{context}=doc,bits=Buffer.alloc(75*849,0xff);
  for(let y=200;y<700;y+=20)bits.fill(0x81,y*75+8,y*75+70);
  const mask=context.register(context.stream(deflateSync(bits),{Type:'XObject',Subtype:'Image',Width:600,Height:849,ImageMask:true,BitsPerComponent:1,Decode:[1,0],Filter:'FlateDecode'}));
  page.pushOperators(ops.pushGraphicsState(),ops.concatTransformationMatrix(W,0,0,H,0,0),ops.drawObject(page.node.newXObject('Scan',mask)),ops.popGraphicsState());
  for(let l=0;l<3;l++)write(page,font,11,60,640-l*26,BODY,{mode:3});
  const second=doc.addPage([W,H]),body=chineseFont(doc,second,'B');for(let l=0;l<8;l++)write(second,body,11,60,760-l*22,l%2?BODY2:BODY);
 }));
 assert.deepEqual(mixed.pages.map(page=>page.kind),['scan','text']);assert.equal(mixed.mode,'hybrid');assert.equal(mixed.pages[0].reclassified,'hidden');
});

test('A scan whose only text is a stamp at its foot is read as a scan; born-digital pages keep their text layer',async()=>{
 const stamped=await analyze(await pdf(async doc=>{for(let n=1;n<=3;n++){const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'+n);await drawScan(doc,page);write(page,font,8,60,40,'本文档由资料分享网站整理发布，仅供学习交流使用，请勿用于商业用途。');write(page,font,8,60,30,'更多学习资料请访问本站首页下载，欢迎转发分享给同学。');write(page,font,9,295,15,`第 ${n} 页`);}}));
 assert.deepEqual(stamped.pages.map(page=>[page.kind,page.reclassified]),[['scan','stamp'],['scan','stamp'],['scan','stamp']]);assert.equal(stamped.mode,'scan');
 // The document's notes name the pages of one finding together; each page keeps its own.
 assert.deepEqual(stamped.notes,['Trang 1-3: lớp chữ của PDF chỉ có dấu hoặc chữ ở mép trang scan nên trang được đọc từ ảnh.']);
 assert.equal(stamped.pages[1].note,'Trang 2: lớp chữ của PDF chỉ có dấu hoặc chữ ở mép trang scan nên trang được đọc từ ảnh.');
 // A tilted watermark over a page of text; text over a full-page background picture painted first; a page of text
 // with a running head and a folio at its edges.
 const paper=png((()=>{const img=image(300,425,[250,240,210]);fill(img,0,0,300,30,[200,160,90]);return img;})());
 const digital=await analyze(await pdf(async doc=>{
  let page=doc.addPage([W,H]),font=chineseFont(doc,page,'A');for(let l=0;l<10;l++)write(page,font,11,60,760-l*22,l%2?BODY2:BODY);write(page,font,40,120,300,'内部资料 请勿外传',{angle:35});
  page=doc.addPage([W,H]);font=chineseFont(doc,page,'B');page.drawImage(await doc.embedPng(paper),{x:0,y:0,width:W,height:H});for(let l=0;l<10;l++)write(page,font,11,60,700-l*22,l%2?BODY2:BODY);
  page=doc.addPage([W,H]);font=chineseFont(doc,page,'C');write(page,font,9,230,810,'第一章 河流与城市');for(let l=0;l<10;l++)write(page,font,11,60,700-l*22,l%2?BODY2:BODY);write(page,font,9,295,40,'3');
 }));
 assert.deepEqual(digital.pages.map(page=>[page.kind,page.reclassified,page.regions]),[['text',undefined,undefined],['text',undefined,undefined],['text',undefined,undefined]]);
 assert.equal(digital.mode,'text');assert.deepEqual(digital.notes,[]);assert.match(digital.pages[0].text,/内部资料[\s\S]*请勿外传/u);
});

// A searchable scan hides (nearly) all of its text; a page of text over a background picture shows most of it, even
// when its title is set as a clip for a decorated fill (render mode 7) or carries an invisible copy (render mode 3).
test('A page of text over a background picture stays text when only its title is clipped or invisible',async()=>{
 const paper=png((()=>{const img=image(300,425,[250,244,226]);fill(img,0,0,300,40,[90,140,200]);return img;})());
 const analysis=await analyze(await pdf(async doc=>{
  for(const mode of [7,3]){
   const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'+mode);page.drawImage(await doc.embedPng(paper),{x:0,y:0,width:W,height:H});
   write(page,font,26,60,780,'第二单元 城市与乡村的变迁和发展',{mode});
   for(let l=0;l<10;l++)write(page,font,11,60,700-l*22,l%2?BODY2:BODY);
  }
 }));
 assert.deepEqual(analysis.pages.map(page=>[page.kind,page.reclassified]),[['text',undefined],['text',undefined]]);
 assert.equal(analysis.mode,'text');assert.equal(analysis.reclassified,0);
});

// A publisher's sample mark or a site's logo laid over a page of text hides none of it: an image with an alpha of its own,
// an opaque one painted at low opacity or in multiply mode. Only an opaque picture painted over the text makes a scan.
test('A page of text under a translucent overlay stays text: an image with its own alpha, one at low opacity or in multiply mode',async()=>{
 const width=150,height=212,raw=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set(Math.abs(x-y*.7)<8?[200,200,200,70]:[255,255,255,0],y*(width*4+1)+1+x*4);
 const chunk=(type,body)=>{const content=Buffer.concat([Buffer.from(type),body]),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(content));return Buffer.concat([length,content,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const rgba=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
 const band=png((()=>{const img=image(150,212);fill(img,20,90,110,24,[220,220,220]);return img;})());
 const analysis=await analyze(await pdf(async doc=>{
  for(const kind of ['alpha','opacity','multiply','opaque']){
   const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'+kind),whole={x:0,y:0,width:W,height:H};
   write(page,font,16,200,780,'第一章 河流与城市');for(let l=0;l<20;l++)write(page,font,11,60,740-l*22,l%2?BODY2:BODY);
   if(kind==='alpha')page.drawImage(await doc.embedPng(rgba),whole);
   else page.drawImage(await doc.embedPng(band),{...whole,...kind==='opacity'?{opacity:.15}:kind==='multiply'?{blendMode:ops.BlendMode.Multiply}:{}});
  }
 }));
 assert.deepEqual(analysis.pages.map(page=>[page.kind,page.reclassified]),[['text',undefined],['text',undefined],['text',undefined],['scan','hidden']]);
 assert.deepEqual(analysis.notes,['Trang 4: lớp chữ có sẵn của PDF là chữ nhận dạng nằm ẩn dưới ảnh scan nên trang được đọc lại từ ảnh.']);
});

test('A searchable scan keeps its OCR layer and gains the lines a reading of its pixels finds; a far fuller reading replaces it',()=>{
 const rest=Array.from({length:10},(_,i)=>i%2?BODY2:BODY).join('\n'),layer=`${BODY}\n${BODY2}\n${rest}`,item={kind:'scan',text:layer,reclassified:'hidden'};
 // The layer's OCR left out a title and a table row: they are set in where the reading has them, the layer's own
 // lines kept as they were (a misread character of the reading changes nothing).
 const reading=`第三章 归乡\n${BODY}\n${BODY2.replace('河水','河木')}\n名称 长度 流经地区\n${rest}`;
 assert.deepEqual(scanReading(item,reading,4),{text:`第三章 归乡\n${BODY}\n${BODY2}\n名称 长度 流经地区\n${rest}`,note:'Trang 4: lớp chữ nhận dạng sẵn trong PDF thiếu khoảng 13 chữ so với ảnh trang; đã thêm các dòng đó từ bản nhận dạng lại.'});
 assert.deepEqual(scanReading(item,layer.replace('河流','河留'),4),{text:layer,note:''},'a complete layer stays as it is');
 assert.equal(scanReading(item,'',4).text,layer);assert.match(scanReading(item,'',4).note,/chưa nhận dạng được ảnh trang nên giữ lớp chữ có sẵn của PDF/u);
 // A two-line layer over a full page, and a stamp: the reading replaces them.
 const page=[BODY,BODY2,BODY,BODY2,BODY].join('\n');
 assert.deepEqual(scanReading({kind:'scan',text:BODY,reclassified:'hidden'},page,2),{text:page,note:'Trang 2: lớp chữ nhận dạng sẵn trong PDF thiếu nhiều chữ so với ảnh trang nên đã dùng bản nhận dạng lại từ ảnh.'});
 assert.equal(scanReading({kind:'scan',text:'本文档由资料分享网站整理发布，仅供学习交流使用。',reclassified:'stamp'},page,2).text,page);
 assert.deepEqual(scanReading({kind:'scan',text:''},'甲乙丙',1),{text:'甲乙丙',note:''},'an ordinary scan keeps its reading');
});

test('Han drawn as a picture or in outlines on a text page is found, read on the device and set where it stands',drawing,async()=>{
 const heading=png((()=>{const img=image(320,40);glyphs(img,{x:10,y:8,size:24,count:9});return img;})());
 const analysis=await analyze(await pdf(async doc=>{
  const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F');
  page.drawImage(await doc.embedPng(heading),{x:140,y:760,width:320,height:40});
  // A white heading in outlines on a blue band: each stroke a filled path with a curve.
  page.pushOperators(ops.pushGraphicsState(),ops.setFillingRgbColor(.16,.27,.59),ops.rectangle(50,690,500,34),ops.fill(),ops.setFillingRgbColor(1,1,1));
  for(let c=0;c<5;c++){const left=70+c*20;for(const [x,y,w,h] of [[[left+2,702,2,16],[left+11,702,2,16],[left,716,16,2],[left,709,16,2],[left,702,16,2]],[[left+7,702,2,16],[left,716,16,2],[left,711,16,2],[left,706,16,2],[left,702,16,2]],[[left+1,702,2,16],[left+7,702,2,16],[left+13,702,2,16],[left,716,16,2],[left,702,16,2]]][c%3])page.pushOperators(ops.moveTo(x,y),ops.lineTo(x+w,y),ops.appendBezierCurve(x+w,y+h/3,x+w,y+2*h/3,x+w,y+h),ops.lineTo(x,y+h),ops.closePath(),ops.fill());}
  page.pushOperators(ops.popGraphicsState());
  for(let l=0;l<12;l++)write(page,font,11,60,650-l*22,l%2?BODY2:BODY);
 }));
 const [page]=analysis.pages;
 assert.equal(page.kind,'text');assert.equal(analysis.pictured,1);
 assert.deepEqual(page.regions.map(({cells,light})=>({cells,light})),[{cells:9,light:false},{cells:5,light:true}]);
 assert.ok(page.regions[0].box.y<.08&&page.regions[1].box.y>.12&&page.regions[1].box.y<.2,JSON.stringify(page.regions));
 assert.deepEqual(analysis.notes,['Trang 1: khoảng 14 chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh.']);
 // The regions come cropped (uploadPreparedPdf, in the browser); read here by a stand-in for the device's OCR.
 const item={...page,regions:page.regions.map((region,index)=>({...region,blob:new Blob([String(index)])}))};
 const read=await readPictureText(item,async blob=>(await blob.text())==='0'?'第四章 水的循环与人类活动':'阅读与讨论',1);
 assert.deepEqual(read.text.split('\n').slice(0,3),['第四章 水的循环与人类活动','阅读与讨论',BODY]);assert.equal(read.note,'');
 const unread=await readPictureText(item,async blob=>(await blob.text())==='0'?'第四章 水的循环与人类活动':'',1);
 assert.equal(unread.note,'Trang 1: khoảng 5 chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên chưa dịch; hãy đối chiếu với PDF gốc.');
 // A reading of letters or digits alone says the region holds no Chinese: it stays a picture, unnamed, unless the reader
 // was not sure (Tesseract). Nothing read (ocr_empty) and the device's own failure leave it unread; a Gemini error with a
 // status (a quota, a key) stops the page, which is then read again, never kept with that region lost.
 const second=async(answer,blob)=>(await blob.text())==='0'?'第四章 水的循环与人类活动':answer();
 const latin=await readPictureText(item,blob=>second(()=>'Water and cities 1.2',blob),1);
 assert.equal(latin.note,'');assert.doesNotMatch(latin.text,/Water/u);
 assert.match((await readPictureText(item,blob=>second(()=>({text:'Il lI ll',sure:false}),blob),1)).note,/khoảng 5 chữ/u);
 // The study page's api() throws {status, data: the server's answer}, its code in data.code: a reading Gemini refused is
 // refused again each time it is asked, so it is left unread too, never a page that cannot be prepared.
 const answered=(message,status,code)=>Object.assign(new Error(message),{status,data:{error:message,code}});
 for(const error of [Object.assign(new Error('OCR không nhận được văn bản; hãy kiểm tra trang scan.'),{status:400,code:'ocr_empty'}),answered('OCR không nhận được văn bản; hãy kiểm tra trang scan.',400,'ocr_empty'),answered('Gemini chặn kết quả của đoạn này theo bộ lọc an toàn.',400,'gemini_refused'),new Error('Bộ nhận dạng chữ Tesseract không phản hồi khi đọc trang này.')])
  assert.match((await readPictureText(item,blob=>second(()=>{throw error;},blob),1)).note,/khoảng 5 chữ/u,error.message);
 for(const quota of [Object.assign(new Error('Đã hết lượt Gemini trong phút này.'),{status:429,code:'quota_minute'}),answered('Đã hết lượt Gemini trong phút này.',429,'quota_minute'),answered('Không kết nối được máy chủ.',0)])
  await assert.rejects(readPictureText(item,blob=>second(()=>{throw quota;},blob),1),error=>error===quota);
});

// A workbook page's drawn marks (answer boxes, writing grids, difficulty stars, ticked boxes) and a figure whose labels
// and formula are English show no Han: beside a heading drawn as a picture, they add no region, no cell, no OCR call.
test('Answer boxes, writing grids, stars, ticked boxes and an English-labelled figure add nothing for OCR to read',drawing,async()=>{
 const {rgb,StandardFonts,PDFDocument}=ops,heading=png((()=>{const img=image(320,40);glyphs(img,{x:10,y:8,size:24,count:9});return img;})());
 // The figure's English, set in a standard font that pdf.js draws from its own data, pasted in as a picture.
 const figure=await (async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage([300,120]),font=await doc.embedFont(StandardFonts.Helvetica);
  ['velocity v (m/s) and time t (s)','temperature of the water','F = ma,  W = Fs cos a'].forEach((line,k)=>page.drawText(line,{x:12,y:92-k*30,size:12,font}));
  const pdfjs=await import('/vendor/pdf.mjs'),file=await pdfjs.getDocument({data:await doc.save(),standardFontDataUrl:'/vendor/standard_fonts/'}).promise;
  try{const page1=await file.getPage(1),view=page1.getViewport({scale:2}),target=file.canvasFactory.create(view.width,view.height);await page1.render({canvasContext:target.context,viewport:view,background:'rgb(255,255,255)'}).promise;const bytes=target.canvas.toBuffer('image/png');file.canvasFactory.destroy(target);return bytes;}
  finally{await file.loadingTask.destroy();}
 })();
 const analysis=await analyze(await pdf(async doc=>{
  const page=doc.addPage([W,H]),font=chineseFont(doc,page,'F'),green=rgb(.2,.5,.2),star='M 0 -6 L 1.4 -1.9 L 5.7 -1.9 L 2.3 0.7 L 3.5 4.9 L 0 2.4 L -3.5 4.9 L -2.3 0.7 L -5.7 -1.9 L -1.4 -1.9 Z';
  page.drawImage(await doc.embedPng(heading),{x:140,y:770,width:320,height:40});
  for(let l=0;l<8;l++)write(page,font,11,60,740-l*20,l%2?BODY2:BODY);
  page.drawImage(await doc.embedPng(figure),{x:300,y:400,width:240,height:96});
  write(page,font,11,60,580,'一、看拼音，写词语。');
  for(let k=0;k<4;k++)page.drawRectangle({x:80+k*22,y:550,width:18,height:18,borderColor:rgb(0,0,0),borderWidth:.8});
  for(let k=0;k<6;k++){const x=80+k*26,y=510;page.drawRectangle({x,y,width:24,height:24,borderColor:green,borderWidth:.8});page.drawLine({start:{x:x+12,y},end:{x:x+12,y:y+24},thickness:.4,color:green,dashArray:[2,2]});page.drawLine({start:{x,y:y+12},end:{x:x+24,y:y+12},thickness:.4,color:green,dashArray:[2,2]});}
  for(let k=0;k<3;k++)page.drawSvgPath(star,{x:300+k*13,y:586,color:rgb(.9,.6,0)});
  for(let k=0;k<4;k++){page.drawRectangle({x:80+k*16,y:470,width:12,height:12,borderColor:rgb(0,0,0),borderWidth:.8});page.drawSvgPath('M 2 6 L 5 9 L 10 2',{x:80+k*16,y:482,borderColor:rgb(0,0,0),borderWidth:.9});}
 }));
 const [page]=analysis.pages;
 assert.equal(page.kind,'text');assert.deepEqual(page.regions.map(region=>region.cells),[9],JSON.stringify(page.regions));assert.ok(page.regions[0].box.y<.06);
 assert.deepEqual(analysis.notes,['Trang 1: khoảng 9 chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh.']);
 let calls=0;await readPictureText({...page,regions:page.regions.map(region=>({...region,blob:new Blob(['0'])}))},async()=>{calls++;return '第三课 小练习 看拼音写词语';},1);
 assert.equal(calls,1,'only the heading is read');
});

// "Dịch cả quyển" sorts pages before anything is extracted (frontend/whole-book.js surveyPages): by the same rule as the
// analysis, a page whose text layer is a searchable scan's own OCR text, or a stamp over a scan, is a scan for Gemini to
// read, never a page translated from its layer.
test('Dịch cả quyển sorts a searchable scan and a stamped scan as scans, and a born-digital page as text',async()=>{
 const {surveyPages}=await import('../frontend/whole-book.js');
 const bytes=await pdf(async doc=>{
  let page=doc.addPage([W,H]),font=chineseFont(doc,page,'A');for(let l=0;l<10;l++)write(page,font,11,60,760-l*22,l%2?BODY2:BODY);
  page=doc.addPage([W,H]);font=chineseFont(doc,page,'B');await drawScan(doc,page);for(let l=0;l<4;l++)write(page,font,11,60,640-l*26,l%2?BODY2:BODY,{mode:3});
  page=doc.addPage([W,H]);font=chineseFont(doc,page,'C');await drawScan(doc,page);write(page,font,8,60,40,'本文档由资料分享网站整理发布，仅供学习交流使用，请勿用于商业用途。');write(page,font,8,60,30,'更多学习资料请访问本站首页下载，欢迎转发分享给同学。');
 });
 const progress=[],kinds=await surveyPages(new File([bytes],'sach.pdf',{type:'application/pdf'}),{onProgress:(done,total)=>progress.push([done.length,total])});
 assert.deepEqual(kinds,['text','scan','scan']);assert.deepEqual(progress,[[3,3]]);
});
