// Fixtures for PDFs read as text in the browser (frontend/pdf-client.js), written with pdf-lib from their own text:
// Chinese set in fonts the PDF names without embedding them, as many Chinese PDFs are, and scans drawn pixel by pixel.
// Shared by backend/pdf-text-mode.test.mjs (Node, the vendored pdf.js) and backend/study-modes-ui.test.mjs (Edge).
import {createRequire} from 'node:module';
import {deflateSync,crc32} from 'node:zlib';

const require=createRequire(import.meta.url),{PDFDocument,PDFString,PDFHexString,...ops}=require('@cantoo/pdf-lib');
export const W=595.2,H=842,hex=text=>[...text].map(c=>c.codePointAt(0).toString(16).padStart(4,'0')).join('');
export const IDENTITY_UCS='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
// 'gb': STSong-Light through the predefined CMap UniGB-UCS2-H, which pdf.js reads only with its CMap files; otherwise a
// font through Identity-H with a ToUnicode map, which it reads without them.
export function chineseFont(doc,page,name,kind){
 const {context}=doc,descriptor=fontName=>context.register(context.obj({Type:'FontDescriptor',FontName:fontName,Flags:6,FontBBox:[-25,-254,1000,880],ItalicAngle:0,Ascent:880,Descent:-120,CapHeight:880,StemV:80}));
 const font=kind==='gb'
  ?{Type:'Font',Subtype:'Type0',BaseFont:'STSong-Light-UniGB-UCS2-H',Encoding:'UniGB-UCS2-H',DescendantFonts:[context.register(context.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'STSong-Light',CIDSystemInfo:{Registry:PDFString.of('Adobe'),Ordering:PDFString.of('GB1'),Supplement:4},FontDescriptor:descriptor('STSong-Light'),DW:1000}))]}
  :{Type:'Font',Subtype:'Type0',BaseFont:'HoaTriSong',Encoding:'Identity-H',ToUnicode:context.register(context.stream(IDENTITY_UCS)),DescendantFonts:[context.register(context.obj({Type:'Font',Subtype:'CIDFontType2',BaseFont:'HoaTriSong',CIDSystemInfo:{Registry:PDFString.of('Adobe'),Ordering:PDFString.of('Identity'),Supplement:0},FontDescriptor:descriptor('HoaTriSong'),DW:1000,CIDToGIDMap:'Identity'}))]};
 return page.node.newFontDictionary(name,context.register(context.obj(font)));
}
// One line of text: render mode 3 is invisible (an OCR layer); angle in degrees.
export function write(page,font,size,x,y,text,{mode=0,angle=0}={}){
 const r=angle*Math.PI/180,place=angle?ops.setTextMatrix(Math.cos(r),Math.sin(r),-Math.sin(r),Math.cos(r),x,y):ops.moveText(x,y);
 page.pushOperators(ops.beginText(),ops.setFontAndSize(font,size),ops.setTextRenderingMode(mode),place,ops.showText(PDFHexString.of(hex(text))),ops.endText());
}
export const pdf=async build=>{const doc=await PDFDocument.create();await build(doc);return doc.save();};
export const BODY='河流为沿岸城市提供了水源和便利的交通条件，许多城市因此沿河兴起并不断扩展。';
export const BODY2='人们利用河水灌溉农田，发展航运，河流两岸逐渐形成了繁荣的商业中心和集市。';

// ---- pixels: a page scan, a pictured heading ----
export const image=(width,height,rgb=[255,255,255])=>{const data=new Uint8ClampedArray(width*height*4);for(let p=0;p<width*height;p++)data.set([...rgb,255],p*4);return {data,width,height};};
export const fill=(img,x,y,w,h,rgb)=>{for(let j=Math.max(0,y);j<Math.min(img.height,y+h);j++)for(let i=Math.max(0,x);i<Math.min(img.width,x+w);i++)img.data.set(rgb,(j*img.width+i)*4);};
// A row of Han-like glyphs: square cells of strokes upright and across, placed differently from one glyph to the next
// as in a line of text (a row of copies of one shape is a drawn pattern, not text: frontend/document-layout.js).
const STROKES=[[[.15,.7],[0,.45,.88]],[[.3,.85],[.1,.55,.9]],[[.5],[.05,.35,.65,.9]]];
export function glyphs(img,{x,y,size,count,rgb=[30,30,30]}){const stroke=Math.max(1,Math.round(size*.12));for(let c=0;c<count;c++){const left=Math.round(x+c*size*1.15),[ups,acrosses]=STROKES[c%3];for(const fx of ups)fill(img,left+Math.round(size*fx),y,stroke,size,rgb);for(const fy of acrosses)fill(img,left,y+Math.round(size*fy),size,stroke,rgb);}}
export function png({data,width,height}){
 const raw=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let k=0;k<3;k++)raw[y*(width*3+1)+1+x*3+k]=data[(y*width+x)*4+k];
 const chunk=(type,body)=>{const content=Buffer.concat([Buffer.from(type),body]),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(content));return Buffer.concat([length,content,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// A scanned page at about 1 px/pt: a title, a white title on a blue band, rows of body text.
const scanPage=()=>{const img=image(600,849,[246,244,238]);glyphs(img,{x:150,y:70,size:26,count:8});fill(img,50,130,500,34,[40,70,150]);glyphs(img,{x:70,y:139,size:16,count:5,rgb:[250,250,250]});for(let r=0;r<22;r++)glyphs(img,{x:60,y:190+r*26,size:12,count:30+r%3});return img;};
export const SCAN=png(scanPage());
export const drawScan=async(doc,page)=>page.drawImage(await doc.embedPng(SCAN),{x:0,y:0,width:W,height:H});
