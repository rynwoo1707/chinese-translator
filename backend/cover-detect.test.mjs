import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {deflateSync,crc32} from 'node:zlib';
import {coverFeatures,scoreCover,scoreCoverPixels,coverHints,detectCover,excludeCover,formatPageRange,PDFJS_ASSETS} from '../frontend/cover-detect.js';

// ---- synthetic pixel pages (600 × 849, an A4 page at ~73 dpi) ----
const W=600,H=849;
function page(rgb=[255,255,255]){const data=new Uint8ClampedArray(W*H*4);for(let p=0;p<W*H;p++)data.set([...rgb,255],p*4);return {data,width:W,height:H};}
const fill=(img,x,y,w,h,rgb)=>{for(let j=Math.max(0,y);j<Math.min(H,y+h);j++)for(let i=Math.max(0,x);i<Math.min(W,x+w);i++)img.data.set(rgb,(j*W+i)*4);};
// A line of CJK-like glyphs: square cells of strokes (two vertical, three horizontal) with gaps between characters.
function glyphs(img,{x=60,y,size,count,rgb=[30,30,30],gap=.15}){const stroke=Math.max(1,Math.round(size*.12));for(let c=0;c<count;c++){const left=Math.round(x+c*size*(1+gap));for(const fx of [.15,.7])fill(img,left+Math.round(size*fx),y,stroke,size,rgb);for(const fy of [0,.45,.88])fill(img,left,y+Math.round(size*fy),size,stroke,rgb);}}
const textPage=(img,{from=80,lines=34,pitch=21,size=11,rgb}={})=>{for(let l=0;l<lines;l++)glyphs(img,{y:from+l*pitch,size,count:36-(l%4),rgb});return img;};
function photo(img,seed=1){let s=seed;for(let j=0;j<H;j++)for(let i=0;i<W;i++){s=(s*1103515245+12345)>>>0;const n=(s>>>24)%40;img.data.set([Math.round(20+60*Math.sin(i/90)+n),Math.round(60+50*Math.cos(j/70))+n,Math.round(150+80*Math.sin((i+j)/120)),255].map(v=>Math.max(0,Math.min(255,v))),(j*W+i)*4);}return img;}
const darken=(img,factor)=>{for(let i=0;i<img.data.length;i+=4)for(let k=0;k<3;k++)img.data[i+k]*=factor;return img;};
// The pixels as an RGB PNG, to place a photo on a generated PDF page.
function pngOf({data,width,height}){
 const raw=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let k=0;k<3;k++)raw[y*(width*3+1)+1+x*3+k]=data[(y*width+x)*4+k];
 const chunk=(type,body)=>{const content=Buffer.concat([Buffer.from(type),body]),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(content));return Buffer.concat([length,content,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

test('Synthetic covers score as covers and content pages do not, with the reasons stated',()=>{
 const colour=photo(page());glyphs(colour,{x:200,y:120,size:70,count:2,rgb:[250,250,250]});
 const result=scoreCoverPixels(colour);assert.equal(result.isCover,true);assert.ok(result.score>=5);assert.ok(result.reasons.includes('nhiều mảng màu'));assert.ok(result.reasons.includes('hình phủ kín trang'));
 // A plain black-and-white novel cover: a big title, the author and the publisher on an otherwise empty page.
 const novel=page();glyphs(novel,{x:150,y:260,size:56,count:5});glyphs(novel,{x:240,y:380,size:16,count:4});glyphs(novel,{x:220,y:780,size:13,count:6});
 const bw=scoreCoverPixels(novel);assert.equal(bw.isCover,true,JSON.stringify(bw));assert.ok(bw.reasons.includes('chữ tiêu đề cỡ lớn'));assert.equal(coverFeatures(novel).colourfulness,0);
 // The same on grey scanned paper with noise, and a plain coloured cover with a light title.
 const scan=page([226,224,218]);let s=7;for(let p=0;p<W*H;p++){s=(s*1103515245+12345)>>>0;const d=((s>>>24)%15)-7;for(let k=0;k<3;k++)scan.data[p*4+k]+=d;}
 glyphs(scan,{x:150,y:260,size:56,count:5,rgb:[40,40,40]});glyphs(scan,{x:240,y:380,size:16,count:4,rgb:[40,40,40]});assert.equal(scoreCoverPixels(scan).isCover,true);
 const red=page([160,30,26]);glyphs(red,{x:200,y:300,size:64,count:2,rgb:[255,255,255]});glyphs(red,{x:250,y:420,size:18,count:3,rgb:[255,230,180]});assert.equal(scoreCoverPixels(red).isCover,true);
 // Body text, a table of contents with small colour pictures, and text on coloured paper are content pages.
 const content=scoreCoverPixels(textPage(page()));assert.equal(content.isCover,false);assert.ok(content.reasons.includes('nhiều dòng chữ đều như trang nội dung'));
 const toc=textPage(page(),{from:150,lines:26,pitch:26});for(const y of [160,380,600])fill(toc,30,y,110,90,[40,140,220]);glyphs(toc,{x:250,y:60,size:40,count:2});assert.equal(scoreCoverPixels(toc).isCover,false);
 assert.equal(scoreCoverPixels(textPage(page([250,236,150]))).isCover,false);
 // A chapter opening (large title above many regular lines) is content too.
 const opener=textPage(page(),{from:260,lines:24});glyphs(opener,{x:120,y:120,size:48,count:6});assert.equal(scoreCoverPixels(opener).isCover,false);
 const blank=page();fill(blank,300,400,2,2,[0,0,0]);const empty=scoreCoverPixels(blank);assert.equal(empty.blank,true);assert.equal(empty.isCover,false);
});

test('Light text printed on a photo is read as text: a chapter opening on a picture is not a cover, the picture alone is',()=>{
 // A full-bleed dark photo with a white chapter title and a white paragraph of 14 lines, as modern textbooks open chapters.
 const opener=darken(photo(page()),.45);glyphs(opener,{x:60,y:60,size:30,count:4,rgb:[255,255,255]});textPage(opener,{from:420,lines:14,size:11,rgb:[250,250,250]});
 const scored=scoreCoverPixels(opener);assert.equal(scored.isCover,false,JSON.stringify(scored));assert.ok(scored.reasons.includes('nhiều dòng chữ đều như trang nội dung'),scored.reasons.join('; '));
 // The same photo with only its title (white strokes too thick to be body text) and the bare photo stay covers.
 const titled=darken(photo(page()),.45);glyphs(titled,{x:60,y:60,size:30,count:4,rgb:[255,255,255]});
 for(const image of [titled,darken(photo(page()),.45)]){const result=scoreCoverPixels(image);assert.equal(result.isCover,true,JSON.stringify(result));}
});

test('Hints from the PDF itself: a cover label or outline entry decides, a page number counts against',()=>{
 assert.deepEqual(coverHints({label:'封面'}),{label:'cover',outline:false});assert.equal(coverHints({label:'Cover'}).label,'cover');assert.equal(coverHints({label:'Front cover'}).label,'cover');
 assert.equal(coverHints({label:'iii'}).label,'roman');assert.equal(coverHints({label:'45'}).label,'number');assert.equal(coverHints({label:'1'}).label,'');assert.equal(coverHints({}).label,'');
 const sparse={coverage:.01,colourfulness:0,colourArea:0,textRows:12,regularRows:11,titleRows:0,blockRows:0};
 assert.equal(scoreCover(sparse).isCover,false);assert.equal(scoreCover(sparse,coverHints({label:'封皮'})).isCover,false);
 assert.equal(scoreCover({...sparse,regularRows:4,textRows:5},coverHints({label:'封面'})).isCover,true);
 assert.equal(scoreCover({...sparse,regularRows:2,textRows:2,titleRows:1},coverHints({label:'45'})).isCover,false);
 assert.equal(scoreCover({...sparse,coverage:0,textRows:0,regularRows:0},coverHints({outline:true})).blank,true);
});

test('The cover stays artwork: a range that includes it skips that page unless its text is to be translated',()=>{
 assert.deepEqual(excludeCover('1-20',300,1),{pages:new Set(Array.from({length:19},(_,i)=>i+2)),text:'2-20',excluded:true});
 assert.equal(excludeCover('1-21',300,1).text,'2-21');assert.throws(()=>excludeCover('1-22',300,1),/tối đa 20 trang/);
 assert.equal(excludeCover('1-20',300,1,{translateCover:true}).text,'1-20');assert.equal(excludeCover('3-5, 9',300,1).text,'3-5, 9');assert.equal(excludeCover('2-4',300,0).excluded,false);
 assert.throws(()=>excludeCover('1',300,1),/Trang 1 là bìa/);assert.throws(()=>excludeCover('0-3',300,1),/1-300/);
 assert.equal(formatPageRange(new Set([9,3,4,5,12,13])),'3-5, 9, 12-13');assert.equal(formatPageRange([7]),'7');
});

// ---- rasterised PDFs, through the same pdf.js the browser uses ----
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
let pdfjs=null,canvasReady=false;
try{pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');await import('@napi-rs/canvas');canvasReady=true;}catch{}
const skip=canvasReady?false:'pdf.js cannot rasterise here (@napi-rs/canvas is missing)';
async function rasterise(bytes,options={}){
 const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes),standardFontDataUrl:root+'node_modules/pdfjs-dist/standard_fonts/',verbosity:0,...options}).promise;
 const render=async number=>{const p=await pdf.getPage(number),viewport=p.getViewport({scale:600/p.getViewport({scale:1}).width}),{canvas,context}=pdf.canvasFactory.create(Math.round(viewport.width),Math.round(viewport.height));await p.render({canvasContext:context,viewport,background:'rgb(255,255,255)'}).promise;const image=context.getImageData(0,0,canvas.width,canvas.height);p.cleanup();return {data:image.data,width:canvas.width,height:canvas.height};};
 return {pdf,render};
}

test('Generated PDFs: covers found on page 1 (or page 2 after a blank page), labels and outline hints used',{skip},async()=>{
 const {PDFDocument,StandardFonts,PDFName,PDFNumber,PDFHexString,rgb}=require('@cantoo/pdf-lib');
 async function make(build,{labels=null,outlineCover=false}={}){
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);await build(doc,font,bold);
  if(labels)doc.catalog.set(PDFName.of('PageLabels'),doc.context.obj({Nums:labels.flatMap(([index,label])=>[PDFNumber.of(index),doc.context.obj(label)])}));
  if(outlineCover){const root=doc.context.nextRef(),item=doc.context.nextRef();doc.context.assign(item,doc.context.obj({Title:PDFHexString.fromText('封面'),Parent:root,Dest:[doc.getPage(0).ref,PDFName.of('Fit')]}));doc.context.assign(root,doc.context.obj({Type:'Outlines',First:item,Last:item,Count:PDFNumber.of(1)}));doc.catalog.set(PDFName.of('Outlines'),root);}
  return doc.save();
 }
 const body=(page,font,from=760)=>{for(let l=0;l<34;l++)page.drawText('The train reached the small town at dusk while the fields grew dark outside.',{x:56,y:from-l*19,size:11,font});};
 const colourCover=await make(async(doc,font,bold)=>{const p=doc.addPage([595.2,842]);for(let i=0;i<40;i++)p.drawRectangle({x:0,y:i*21,width:595.2,height:22,color:rgb(.1+.02*i,.3+.01*(i%7),.75-.015*i)});p.drawText('MATHEMATICS',{x:90,y:600,size:56,font:bold,color:rgb(1,1,1)});p.drawText('Book One',{x:230,y:540,size:24,font,color:rgb(1,1,.8)});body(doc.addPage([595.2,842]),font);});
 const novelCover=await make(async(doc,font,bold)=>{const p=doc.addPage([595.2,842]);p.drawText('DISTANT LIGHTS',{x:70,y:560,size:58,font:bold});p.drawText('A novel by Lin Qiu',{x:200,y:480,size:18,font});p.drawText('People\'s Literature Press',{x:190,y:60,size:14,font});body(doc.addPage([595.2,842]),font);});
 const afterBlank=await make(async(doc,font,bold)=>{doc.addPage([595.2,842]);const p=doc.addPage([595.2,842]);p.drawText('DISTANT LIGHTS',{x:70,y:560,size:58,font:bold});p.drawText('Lin Qiu',{x:260,y:480,size:18,font});body(doc.addPage([595.2,842]),font);});
 const contentFirst=await make(async(doc,font,bold)=>{const p=doc.addPage([595.2,842]);p.drawText('Chapter 3  Home',{x:150,y:780,size:30,font:bold});body(p,font,720);body(doc.addPage([595.2,842]),font);});
 const sparseLabelled=await make(async(doc,font)=>{const p=doc.addPage([595.2,842]);p.drawText('Series of the Institute',{x:180,y:700,size:14,font});for(let l=0;l<4;l++)p.drawText('Editorial board and acknowledgements',{x:150,y:400-l*19,size:11,font});body(doc.addPage([595.2,842]),font);},{labels:[[0,{S:'D',P:PDFHexString.fromText('封面')}],[1,{S:'D'}]]});
 const outlined=await make(async(doc,font)=>{const p=doc.addPage([595.2,842]);for(let l=0;l<5;l++)p.drawText('Plain front matter line',{x:150,y:500-l*19,size:11,font});body(doc.addPage([595.2,842]),font);},{outlineCover:true});
 const numbered=await make(async(doc,font,bold)=>{const p=doc.addPage([595.2,842]);p.drawText('PART TWO',{x:150,y:560,size:58,font:bold});body(doc.addPage([595.2,842]),font);},{labels:[[0,{S:'D',St:PDFNumber.of(45)}]]});
 // A chapter opening printed on a photo (a white title and a white paragraph) is content; with its title only, a cover.
 const dark=pngOf(darken(photo(page(),3),.45)),onPhoto=lines=>make(async(doc,font,bold)=>{const p=doc.addPage([595.2,842]);p.drawImage(await doc.embedPng(dark),{x:0,y:0,width:595.2,height:842});p.drawText('Chapter 3  Home',{x:56,y:760,size:30,font:bold,color:rgb(1,1,1)});for(let l=0;l<lines;l++)p.drawText('The train reached the small town at dusk while the fields grew dark outside.',{x:56,y:420-l*19,size:11,font,color:rgb(1,1,1)});body(doc.addPage([595.2,842]),font);});
 const whiteText=await onPhoto(14),photoTitle=await onPhoto(0);
 const expected=[[colourCover,1],[novelCover,1],[afterBlank,2],[contentFirst,0],[sparseLabelled,1],[outlined,1],[numbered,0],[whiteText,0],[photoTitle,1]];
 for(const [bytes,cover] of expected){const {pdf,render}=await rasterise(bytes);try{const result=await detectCover(pdf,render);assert.equal(result.page,cover,JSON.stringify({...result,image:undefined}));}finally{await pdf.loadingTask.destroy();}}
});

// A black-and-white novel cover scan (300 × 424, a big title, an author and a publisher line) compressed as CCITT G4,
// the way most black-and-white book scans are stored (made with MuPDF's fax recompression).
const FAX_COVER='////////////////////IIDUSAaiQDUSAaiQDV/////5UmdGQbOjINnRkGzoyDZ0f///////////////////////////////kEBqJANRIBqJANRIBq/////8qTOjINnRkGzoyDZ0ZBs6P///////////////////////////////yCA1EgGokA1EgGokA1f////+IiI//////52KhDUENQQ1BP/Z7TPaZ7TPa///QtC0LQv/2e0z2me0z2v//0LQtC0L/8REf///////////////////////////////O6hDqIdRDqIdRDqJ//s8JnhM8JnhM8Jnhf///6FoWhaFoWhf/+zwmeEzwmeEzwmeFQtC0LQtC0L//xEREf///4AIAIA=';
test('pdf.js gets the CMaps, fonts and scan decoders it needs: covers in CCITT scans and non-embedded Chinese fonts are seen',{skip},async()=>{
 const {PDFDocument,StandardFonts,PDFString,PDFHexString,pushGraphicsState,popGraphicsState,concatTransformationMatrix,drawObject,beginText,endText,setFontAndSize,moveText,showText}=require('@cantoo/pdf-lib');
 // The browser loads these from /vendor, where backend/vendor.mjs copies pdf.js's own folders; here they are read in place.
 const vendor=readFileSync(root+'backend/vendor.mjs','utf8'),local={};
 for(const [key,value] of Object.entries(PDFJS_ASSETS)){
  if(typeof value!=='string'){local[key]=value;continue;}const folder=value.match(/^\/vendor\/([a-z_]+)\/$/u)?.[1];
  assert.ok(folder&&existsSync(`${root}node_modules/pdfjs-dist/${folder}`),`${key}: ${value}`);assert.ok(vendor.includes(`'node_modules/pdfjs-dist/${folder}','frontend/vendor/${folder}'`),`vendor.mjs copies ${folder}`);local[key]=`${root}node_modules/pdfjs-dist/${folder}/`;
 }
 const body=async doc=>{const font=await doc.embedFont(StandardFonts.Helvetica),p=doc.addPage([595.2,842]);for(let l=0;l<34;l++)p.drawText('The train reached the small town at dusk while the fields grew dark outside.',{x:56,y:760-l*19,size:11,font});};
 const fax=async()=>{const doc=await PDFDocument.create(),page=doc.addPage([595.2,842]),{context}=doc;const image=context.register(context.stream(Buffer.from(FAX_COVER,'base64'),{Type:'XObject',Subtype:'Image',Width:300,Height:424,BitsPerComponent:1,ColorSpace:'DeviceGray',Filter:'CCITTFaxDecode',DecodeParms:{K:-1,Columns:300,Rows:424}}));page.pushOperators(pushGraphicsState(),concatTransformationMatrix(595.2,0,0,842,0,0),drawObject(page.node.newXObject('Scan',image)),popGraphicsState());await body(doc);return doc.save();};
 // A cover set in STSong-Light, not embedded, through the predefined CMap UniGB-UCS2-H, as many Chinese PDFs are.
 const song=async()=>{
  const doc=await PDFDocument.create(),{context}=doc,page=doc.addPage([595.2,842]),ucs2=text=>PDFHexString.of([...text].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  const descriptor=context.register(context.obj({Type:'FontDescriptor',FontName:'STSong-Light',Flags:6,FontBBox:[-25,-254,1000,880],ItalicAngle:0,Ascent:880,Descent:-120,CapHeight:880,StemV:80}));
  const descendant=context.register(context.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'STSong-Light',CIDSystemInfo:{Registry:PDFString.of('Adobe'),Ordering:PDFString.of('GB1'),Supplement:4},FontDescriptor:descriptor,DW:1000}));
  const font=page.node.newFontDictionary('Song',context.register(context.obj({Type:'Font',Subtype:'Type0',BaseFont:'STSong-Light-UniGB-UCS2-H',Encoding:'UniGB-UCS2-H',DescendantFonts:[descendant]})));
  page.pushOperators(beginText(),setFontAndSize(font,58),moveText(80,560),showText(ucs2('远方的灯火')),endText(),beginText(),setFontAndSize(font,18),moveText(240,480),showText(ucs2('林秋 著')),endText(),beginText(),setFontAndSize(font,14),moveText(220,60),showText(ucs2('人民文学出版社')),endText());
  await body(doc);return doc.save();
 };
 for(const [name,bytes] of [['CCITT',await fax()],['CID',await song()]]){
  // Without them page 1 draws blank, so it is taken for a flyleaf and the content page after it decides: no cover.
  const bare=await rasterise(bytes);try{const result=await detectCover(bare.pdf,bare.render);assert.deepEqual([result.page,result.checked],[0,2],`${name} without assets`);}finally{await bare.pdf.loadingTask.destroy();}
  const full=await rasterise(bytes,local);try{const result=await detectCover(full.pdf,full.render);assert.deepEqual([result.page,result.checked],[1,1],`${name}: ${result.reasons.join('; ')}`);}finally{await full.pdf.loadingTask.destroy();}
 }
});

// Real scans, when present on this machine (git-ignored): a colour textbook cover, its table of contents, inner-page
// excerpts and the multi-genre fixture pages.
const samples=root+'tmp/pdf-layout/cover-samples/',genres=root+'tmp/pdf-layout/genre-fixtures/fixtures/';
test('Real scans: the textbook cover is found; its table of contents, inner excerpts and genre pages are not covers',{skip:skip||(!existsSync(samples+'source-10p.pdf')&&'real samples are not on this machine')},async()=>{
 const book=await rasterise(readFileSync(samples+'source-10p.pdf'));
 try{
  const result=await detectCover(book.pdf,book.render);assert.equal(result.page,1);assert.ok(result.reasons.includes('nhiều mảng màu'),result.reasons.join());
  // Page 2 (目录) has colour pictures but regular rows of entries: never a cover on its own.
  for(let n=2;n<=10;n++){const scored=scoreCoverPixels(await book.render(n));assert.equal(scored.isCover,false,`trang ${n}: ${scored.reasons.join('; ')}`);}
 }finally{await book.pdf.loadingTask.destroy();}
 const others=['excerpt-p4-6.pdf','excerpt-p7-8.pdf'].map(name=>samples+name);
 if(existsSync(genres))for(const genre of ['physics','chemistry','novel','poetry','history','exercises'])if(existsSync(`${genres}${genre}/scan.pdf`))others.push(`${genres}${genre}/scan.pdf`);
 for(const file of others.filter(existsSync)){const {pdf,render}=await rasterise(readFileSync(file));try{const result=await detectCover(pdf,render);assert.equal(result.page,0,`${file}: ${result.reasons.join('; ')}`);}finally{await pdf.loadingTask.destroy();}}
});
