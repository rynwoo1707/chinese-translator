// Finds a book's cover on the device: page 1 (page 2 when page 1 is a blank flyleaf) is scored from its pixels and from
// the hints a PDF can carry (a page label or an outline entry naming the cover). No network call and no AI are involved.
import {parseStudyPageRange} from './study-pages.js';

const COVER_NAME=/封\s*[面皮]|[书書]\s*衣|^\s*(?:front\s+)?cover\b|^\s*bìa\b/iu;
const ROMAN=/^[ivxlcdm]{1,7}$/iu;

// Pixels in (RGBA, any size; ~360-600 px wide is plenty), measurements out.
export function coverFeatures({data,width,height}){
 const n=width*height,hist=new Uint32Array(256),lum=new Uint8Array(n),chroma=new Uint8Array(n),bins=new Uint32Array(4096),binSums=new Float64Array(4096*3);
 let rg=0,yb=0,rg2=0,yb2=0,coloured=0;
 for(let i=0,p=0;p<n;i+=4,p++){
  const r=data[i],g=data[i+1],b=data[i+2],y=(299*r+587*g+114*b)/1000|0,c=Math.max(r,g,b)-Math.min(r,g,b),a=r-g,d=(r+g)/2-b,bin=(r>>4)<<8|(g>>4)<<4|b>>4;
  lum[p]=y;chroma[p]=c;hist[y]++;rg+=a;yb+=d;rg2+=a*a;yb2+=d*d;if(c>=48)coloured++;bins[bin]++;binSums[bin*3]+=r;binSums[bin*3+1]+=g;binSums[bin*3+2]+=b;
 }
 // The background is the colour most of the page shares (white, grey scan paper, a plain coloured cover); ink is whatever
 // stands out from it. A page with no dominant colour (a photo) is measured against its lightest common tone instead,
 // and a page with no light tone at all (a dark cover) against white.
 let mode=0;for(let bin=1;bin<4096;bin++)if(bins[bin]>bins[mode])mode=bin;
 let paper=255;for(let y=255,seen=0;y>=0;y--){seen+=hist[y];if(seen>=n*.08){paper=y;break;}}
 const dominant=bins[mode]>=n*.3,bg=dominant?[0,1,2].map(k=>binSums[mode*3+k]/bins[mode]):null,bgLum=dominant?(299*bg[0]+587*bg[1]+114*bg[2])/1000:Math.max(paper,190);
 const ink=new Uint8Array(n);let inked=0;
 for(let p=0,i=0;p<n;p++,i+=4){
  const stands=dominant?Math.abs(lum[p]-bgLum)>48||Math.hypot(data[i]-bg[0],data[i+1]-bg[1],data[i+2]-bg[2])>96:lum[p]<bgLum-48||chroma[p]>=64;
  if(stands){ink[p]=1;inked++;}
 }
 paper=Math.round(bgLum);
 const mean=v=>v/n,sdRg=Math.sqrt(Math.max(0,mean(rg2)-mean(rg)**2)),sdYb=Math.sqrt(Math.max(0,mean(yb2)-mean(yb)**2));
 // Hasler & Süsstrunk (2003): ~15 is "slightly", ~33 "moderately", ~45+ "quite" colourful.
 const colourfulness=Math.hypot(sdRg,sdYb)+.3*Math.hypot(mean(rg),mean(yb));
 // Over a photo, ink above is only what is darker than the light tone, so light text printed on the picture (a chapter
 // opening with a white paragraph) would show no rows at all. Its thin bright strokes are found apart, and its lines
 // count as text; they never add to the title or picture measures, so they can only speak against a cover.
 const dark=inkRows(ink,width,height),light=dominant?{text:0,regular:0}:inkRows(lightStrokes(lum,width,height),width,height);
 return {width,height,paper,coverage:inked/n,colourfulness,colourArea:coloured/n,textRows:Math.max(dark.text,light.text),regularRows:Math.max(dark.regular,light.regular),titleRows:dark.title,blockRows:dark.block};
}
// Rows are read without long unbroken vertical runs of ink (frame lines, table rules, photos a quarter of the page tall
// or more): those would keep every row busy, while text below or beside them still counts. Text never draws one
// unbroken vertical stroke that long. Each half page is read too, so a picture beside text cannot merge the rows.
function inkRows(ink,width,height){
 const rows=ink.slice(),long=height*.25;
 for(let x=0;x<width;x++)for(let y=0;y<height;){if(!ink[y*width+x]){y++;continue;}let end=y;while(end<height&&ink[end*width+x])end++;if(end-y>=long)for(let j=y;j<end;j++)rows[j*width+x]=0;y=end;}
 let text=0,regular=0,title=0,block=0;
 for(const [from,to] of [[0,width],[0,width>>1],[width>>1,width]]){const strip=stripRows(rows,width,height,from,to);text=Math.max(text,strip.text);regular=Math.max(regular,strip.regular);title=Math.max(title,strip.title);block=Math.max(block,strip.block);}
 return {text,regular,title,block};
}
// Light strokes at most 2 px wide (body text at the ~600 px the page is read at): a white top-hat, the page minus its
// 3×3 opening. Clouds, skies and other broad light areas survive the opening and are not taken for text.
function lightStrokes(lum,width,height){
 const pass=(src,vertical,dilate)=>{const out=new Uint8Array(src.length);for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){let v=src[p];const a=vertical?(y>0?src[p-width]:v):(x>0?src[p-1]:v),b=vertical?(y<height-1?src[p+width]:v):(x<width-1?src[p+1]:v);if(dilate){if(a>v)v=a;if(b>v)v=b;}else{if(a<v)v=a;if(b<v)v=b;}out[p]=v;}return out;};
 const opened=pass(pass(pass(pass(lum,false,false),true,false),false,true),true,true),strokes=new Uint8Array(lum.length);
 for(let p=0;p<lum.length;p++)if(lum[p]>=160&&lum[p]-opened[p]>=64)strokes[p]=1;
 return strokes;
}
function stripRows(ink,width,height,from,to){
 const span=to-from,active=new Uint8Array(height),density=new Float32Array(height);
 for(let y=0;y<height;y++){let count=0;for(let x=from,p=y*width+from;x<to;x++,p++)count+=ink[p];density[y]=count/span;active[y]=count>=Math.max(2,span*.015)?1:0;}
 // A one-pixel break inside a glyph row (二, 三 at small sizes) is not a gap between lines.
 for(let y=1;y<height-1;y++)if(!active[y]&&active[y-1]&&active[y+1])active[y]=1;
 const runs=[];for(let y=0;y<height;y++){if(!active[y])continue;let end=y,sum=0;while(end<height&&active[end]){sum+=density[end];end++;}runs.push({start:y,height:end-y,density:sum/(end-y)});y=end;}
 const text=runs.filter(run=>run.height>=height*.004&&run.height<=height*.03),title=runs.filter(run=>run.height>height*.03&&run.height<=height*.22&&run.density<=.6);
 const pitches=text.slice(1).map((run,i)=>run.start-text[i].start).filter(pitch=>pitch<=height*.06).sort((a,b)=>a-b),median=pitches[pitches.length>>1]||0;
 // Body text repeats at one line pitch; a cover's few lines (title, author, publisher) do not.
 const regular=median?pitches.filter(pitch=>pitch>=median*.75&&pitch<=median*1.3).length:0;
 return {text:text.length,regular,title:title.length,block:runs.filter(run=>run.height>height*.22||run.density>.6).length};
}

// What a PDF says about a page: its label (封面, Cover, i, ii…) and whether an outline entry named "cover" points to it.
export function coverHints({label,outline=false}={}){
 const text=String(label??'').trim();
 return {label:COVER_NAME.test(text)?'cover':ROMAN.test(text)?'roman':/^\d+$/u.test(text)&&Number(text)>1?'number':'',outline:Boolean(outline)};
}
export const isCoverName=title=>COVER_NAME.test(String(title||''));

export function scoreCover(features,hints={}){
 const reasons=[];let score=0;const add=(points,reason)=>{score+=points;reasons.push(reason);};
 if(hints.outline)add(4,'mục lục của PDF gọi trang này là bìa');
 if(hints.label==='cover')add(4,'nhãn trang ghi là bìa');else if(hints.label==='roman')add(1,'nhãn trang đánh số La Mã');else if(hints.label==='number')add(-2,'nhãn trang là số trang nội dung');
 const f=features,blank=f.coverage<.004&&!f.textRows&&!f.titleRows;
 if(blank)return {score,isCover:score>=4,blank:true,reasons:[...reasons,'trang trắng']};
 if(f.colourArea>=.3)add(2,'nhiều mảng màu');else if(f.colourfulness>=28&&f.coverage>=.3)add(1,'hình màu lớn');
 if(f.coverage>=.6)add(3,'hình phủ kín trang');else if(f.coverage>=.45)add(2,'hình phủ gần kín trang');else if(f.coverage>=.2)add(1,'nhiều hình');
 if(f.regularRows>=10)add(-4,'nhiều dòng chữ đều như trang nội dung');else if(f.regularRows>=6)add(-2,'có các dòng chữ đều');else if(f.regularRows<=3)add(1,'ít dòng chữ');
 // Black-and-white covers (novels, classics): a few large title lines on an otherwise empty page.
 if(f.titleRows&&f.regularRows<6)add(f.coverage<.2?2:1,'chữ tiêu đề cỡ lớn');
 return {score,isCover:score>=3,blank:false,reasons};
}
export const scoreCoverPixels=(image,hints)=>scoreCover(coverFeatures(image),hints);

// Pages an outline entry named like a cover points to (1-based), resolved with pdf.js.
export async function outlineCoverPages(pdf){
 const pages=new Set(),outline=await pdf.getOutline().catch(()=>null);
 const visit=async items=>{for(const item of items||[]){if(isCoverName(item.title)){const page=await destinationPage(pdf,item.dest).catch(()=>null);if(page)pages.add(page);}await visit(item.items);}};
 await visit(outline);return pages;
}
export async function destinationPage(pdf,dest){
 const explicit=typeof dest==='string'?await pdf.getDestination(dest):dest;if(!Array.isArray(explicit)||!explicit.length)return null;
 const target=explicit[0];return (Number.isInteger(target)?target:await pdf.getPageIndex(target))+1;
}
// render(pageNumber) resolves to {data,width,height} (browser: renderPageImage; tests: any rasteriser).
export async function detectCover(pdf,render){
 const labels=await pdf.getPageLabels().catch(()=>null),outline=await outlineCoverPages(pdf).catch(()=>new Set());
 for(const page of [1,2]){
  if(page>pdf.numPages)break;
  const image=await render(page),result=scoreCoverPixels(image,coverHints({label:labels?.[page-1],outline:outline.has(page)}));
  if(result.blank&&page===1)continue;
  return {...result,page:result.isCover?page:0,checked:page,image};
 }
 return {page:0,checked:1,score:0,isCover:false,blank:true,reasons:['trang trắng']};
}

// A range that includes the cover skips it, so the cover stays the original artwork, unless the student asks to translate it.
export function excludeCover(value,total,cover,{translateCover=false,maxPages=20}={}){
 const pages=parseStudyPageRange(value,total,Infinity),excluded=Boolean(cover)&&!translateCover&&pages.has(cover);if(excluded)pages.delete(cover);
 if(!pages.size)throw new Error(`Trang ${cover} là bìa nên được giữ nguyên ảnh gốc. Hãy chọn thêm trang nội dung, hoặc tích “Dịch chữ trên bìa”.`);
 if(pages.size>maxPages)throw new Error(`Mỗi lượt thử tối đa ${maxPages} trang để kiểm soát token. Hãy chia thành nhiều phạm vi nhỏ.`);
 return {pages,text:formatPageRange(pages),excluded};
}
export function formatPageRange(pages){
 const sorted=[...pages].sort((a,b)=>a-b),parts=[];
 for(let i=0;i<sorted.length;i++){const start=sorted[i];while(sorted[i+1]===sorted[i]+1)i++;parts.push(start===sorted[i]?String(start):`${start}-${sorted[i]}`);}
 return parts.join(', ');
}

// What pdf.js needs to draw every page, copied to /vendor by backend/vendor.mjs: CMaps for Chinese text set in fonts the
// PDF does not embed (UniGB-UCS2-H…), the standard fonts, and the decoders of black-and-white scans (CCITT fax, JBIG2)
// and JPEG 2000 images. Without them those pages come out blank: no cover is found and a chosen cover is a white image.
export const PDFJS_ASSETS={cMapUrl:'/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/standard_fonts/',wasmUrl:'/vendor/wasm/'};
// Browser only: pdf.js is loaded on demand from the vendored copy. It takes ownership of the bytes it is given.
async function openPdfData(data){
 const pdfjs=await import('/vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
 return pdfjs.getDocument({data,verbosity:0,...PDFJS_ASSETS}).promise;
}
export const openPdf=async file=>openPdfData(new Uint8Array(await file.arrayBuffer()));
export async function renderPageImage(pdf,number,width=600){
 const page=await pdf.getPage(number),base=page.getViewport({scale:1}),viewport=page.getViewport({scale:width/base.width}),canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height));
 const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
 await page.render({canvasContext:context,viewport,background:'rgb(255,255,255)'}).promise;page.cleanup();
 const image=context.getImageData(0,0,canvas.width,canvas.height);return {data:image.data,width:canvas.width,height:canvas.height,canvas};
}
export const canvasJpeg=(canvas,quality=.85)=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Không tạo được ảnh bìa.')),'image/jpeg',quality));
// One pass over a picked file: the cover (if any) with a ~600 px JPEG of it, ready to show and to upload as the book cover.
async function detectIn(pdf){
 try{const result=await detectCover(pdf,page=>renderPageImage(pdf,page,600));return {...result,jpeg:result.page?await canvasJpeg(result.image.canvas):null,image:undefined,totalPages:pdf.numPages};}
 finally{await pdf.loadingTask.destroy();}
}
export const detectCoverInFile=async file=>detectIn(await openPdf(file));
// Bytes the caller still needs (the reader assembling a book) are copied for pdf.js.
export const detectCoverInBytes=async bytes=>detectIn(await openPdfData((bytes instanceof Uint8Array?bytes:new Uint8Array(bytes)).slice()));
export async function pageJpeg(file,number){
 const pdf=await openPdf(file);
 try{if(number<1||number>pdf.numPages)throw new Error(`PDF chỉ có ${pdf.numPages} trang.`);return await canvasJpeg((await renderPageImage(pdf,number,600)).canvas);}
 finally{await pdf.loadingTask.destroy();}
}
