// "Đọc song ngữ": each page of a translated PDF part beside the page of the original it translates, both drawn with
// pdf.js. One page number and one zoom drive both sides; on a phone the two stack. The original is fetched only when the
// reader turns this on, and stays open while they move between pages and parts (a book's parts share one original).
const ASSETS={cMapUrl:'/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/standard_fonts/',wasmUrl:'/vendor/wasm/',isEvalSupported:false};
// Only the byte ranges of the pages shown are fetched from a server that answers ranges (the originals and the parts do):
// with streaming on, pdf.js keeps reading the first full request to its end and disableAutoFetch saves nothing, so a
// 100 MB original would download whole over mobile data. A server without ranges still sends the whole file.
export const RANGE_OPTIONS=Object.freeze({disableAutoFetch:true,disableStream:true});
const SHA=/^[a-f\d]{64}$/u;
// Relative to the column width: 1 fits the page to its column.
export const ZOOMS=[.5,.75,1,1.25,1.5,2,2.5,3];
// iOS Safari refuses canvases above about 16.7 million pixels, so a large zoom lowers the sharpness instead.
const MAX_PIXELS=16_000_000;

// The original of one part, from a book assembly (/api/my/study/books/:id/assembly or /api/library/:id/assembly): the
// stored file, and for each page of the part's PDF in order, the page of that file it translates. Null when a side is
// missing: a text part, a part without page numbers, or an original the server does not keep.
// labels: the page number in the printed book of each of those pages, when the stored file is an excerpt that records
// them (a sample keeps only its cover and translated pages, so its page 2 can be page 7 of the book); without them the
// pages of the file are the book's own.
const positive=value=>Number.isInteger(value)&&value>0;
function bookLabels(part,stored,pages){
 const own=Array.isArray(part.bookPages)&&part.bookPages.length===pages.length?part.bookPages.map(Number):null;
 if(own?.every(positive))return own;
 const all=Array.isArray(stored.bookPages)?stored.bookPages.map(Number):null,mapped=all?pages.map(page=>all[page-1]):null;
 return mapped?.every(positive)?mapped:null;
}
export function bilingualSource(assembly,chapterId){
 const part=Array.isArray(assembly?.parts)?assembly.parts.find(item=>item?.id===chapterId):null;
 if(!part||part.mime!=='application/pdf'||!Array.isArray(part.pages)||!part.pages.length||!SHA.test(String(part.sha256||'')))return null;
 const pages=part.pages.map(Number);if(!pages.every(positive))return null;
 const stored=(Array.isArray(assembly.storedSources)?assembly.storedSources:[]).find(item=>item?.sha256===part.sha256&&typeof item.url==='string'&&item.url.startsWith('/api/'));
 if(!stored)return null;const labels=bookLabels(part,stored,pages);
 return {url:stored.url,sha256:part.sha256,pages,totalPages:Number(stored.pages)||Number(part.totalPages)||null,filename:String(part.filename||''),...(labels?{labels}:{})};
}
export const nextZoom=(zoom,step)=>step>0?ZOOMS.find(value=>value>zoom+1e-9)??ZOOMS.at(-1):[...ZOOMS].reverse().find(value=>value<zoom-1e-9)??ZOOMS[0];

let library=null,worker=null;const files=new Map();
function pdfjs(){return library??=import('/vendor/pdf.mjs').then(module=>{module.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';return module;},error=>{library=null;throw error;});}
// Open files by URL, most recent last: the current part's two plus the previous part's, so moving back and forth
// between parts (or redrawing after a theme change) never downloads a file again.
function openPdf(lib,url){
 let file=files.get(url);
 if(file){files.delete(url);files.set(url,file);return file;}
 worker??=new lib.PDFWorker();
 const task=lib.getDocument({url,worker,...ASSETS,...RANGE_OPTIONS});
 file={task,promise:task.promise,progress:null};task.onProgress=event=>file.progress?.(event);
 file.promise.catch(()=>{if(files.get(url)===file)files.delete(url);});
 files.set(url,file);
 for(const [key,old] of files){if(files.size<=4)break;if(old!==file){files.delete(key);old.task.destroy().catch(()=>{});}}
 return file;
}
// Frees the files and the pdf.js worker; called when the reader is left.
export function releaseBilingual(){for(const file of files.values())file.task.destroy().catch(()=>{});files.clear();worker?.destroy();worker=null;}

// On a phone the page buttons keep only their arrows (the name stays in aria-label), so a toolbar row fits.
const nav=end=>`<div class="bilingual-nav${end?' bilingual-nav-end':''}" role="group" aria-label="Chuyển trang"><button type="button" data-bi="prev" aria-label="Trang trước"><span aria-hidden="true">←</span><span class="bilingual-label"> Trang trước</span></button>${end?'':'<span class="bilingual-position" data-bi="position"></span>'}<button type="button" data-bi="next" aria-label="Trang sau"><span class="bilingual-label">Trang sau </span><span aria-hidden="true">→</span></button></div>`;
// On a phone the two sides stack with the Vietnamese page on top (style.css); "announce" tells a screen reader the new page.
const MARKUP=`<section class="bilingual" aria-label="Đọc song ngữ: trang gốc và bản dịch">
<div class="bilingual-bar">${nav(false)}<div class="bilingual-zoom" role="group" aria-label="Thu phóng cả hai trang"><button type="button" data-bi="out" aria-label="Thu nhỏ">−</button><output data-bi="zoom" aria-live="polite"></output><button type="button" data-bi="in" aria-label="Phóng to">+</button><button type="button" data-bi="fit">Vừa khung</button></div></div>
<p class="bilingual-hint">Phím ← → hoặc Page Up / Page Down để chuyển trang, phím + − để thu phóng.</p>
<div class="bilingual-grid"><figure class="bilingual-side bilingual-side-original"><figcaption>Nguyên tác</figcaption><div class="bilingual-scroll" data-bi="original-scroll" tabindex="0" role="group" aria-label="Trang gốc"><div class="bilingual-sheet" data-bi="original"></div></div></figure><figure class="bilingual-side bilingual-side-translated"><figcaption>Bản dịch tiếng Việt</figcaption><div class="bilingual-scroll" data-bi="translated-scroll" tabindex="0" role="group" aria-label="Trang bản dịch"><div class="bilingual-sheet" data-bi="translated"></div></div></figure></div>
<p class="bilingual-status" data-bi="status" role="status" aria-live="polite"></p><p class="visually-hidden" data-bi="announce" aria-live="polite"></p>${nav(true)}</section>`;
const loadFailure=(error,what)=>error?.name==='PasswordException'?`${what[0].toUpperCase()}${what.slice(1)} có mật khẩu nên không hiển thị được.`:`Không mở được ${what}. Hãy kiểm tra mạng rồi bấm Thử lại.`;
// One page as a .bilingual-page frame cssWidth wide: a canvas for the picture and an empty text layer above it.
function pageFrame(page,cssWidth){
 const viewport=page.getViewport({scale:cssWidth/page.getViewport({scale:1}).width});
 const ratio=Math.max(.5,Math.min(globalThis.devicePixelRatio||1,Math.sqrt(MAX_PIXELS/(viewport.width*viewport.height))));
 const frame=document.createElement('div'),canvas=document.createElement('canvas'),layer=document.createElement('div');
 frame.className='bilingual-page';frame.style.width=`${Math.floor(viewport.width)}px`;frame.style.height=`${Math.floor(viewport.height)}px`;frame.style.setProperty('--scale-factor',String(viewport.scale));
 canvas.width=Math.floor(viewport.width*ratio);canvas.height=Math.floor(viewport.height*ratio);canvas.setAttribute('aria-hidden','true');
 layer.className='textLayer';frame.append(canvas,layer);
 return {frame,canvas,layer,viewport,ratio};
}
const renderTask=(page,{canvas,viewport,ratio})=>page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});

// Draws into root. onChange({index,zoom}) reports the reader's place so a redraw (theme, next visit) can return to it;
// onOriginalLayer(element) gets the original side once, for tap-to-look-up on its text layer. labels (bilingualSource):
// the printed book's number of each original page, shown instead of its place in the stored file.
export function mountBilingual(root,{originalUrl,translatedUrl,pages,labels=null,index=0,zoom=1,onChange=()=>{},onOriginalLayer=()=>{}}={}){
 root.innerHTML=MARKUP;
 const printed=Array.isArray(labels)&&labels.length===pages.length&&labels.every(positive)?labels:null;
 const pick=name=>root.querySelector(`[data-bi="${name}"]`),all=name=>[...root.querySelectorAll(`[data-bi="${name}"]`)];
 const docs={original:null,translated:null},failures={original:'',translated:''},renders={},sheets={original:pick('original'),translated:pick('translated')};
 let alive=true,current=Math.max(0,Math.floor(index)||0),scale=ZOOMS.includes(zoom)?zoom:1,count=pages.length,run=0,lib=null,width=0,loading='Đang tải PDF…';
 const status=text=>{const box=pick('status');box.replaceChildren(text);if(failures.original||failures.translated){const retry=document.createElement('button');retry.type='button';retry.textContent='Thử lại';retry.onclick=()=>load();box.append(' ',retry);}};
 // The book page both sides show, then the place in this part.
 const place=(spoken=false)=>{const original=printed?.[current]??pages[current],book=Number.isInteger(original);return spoken?`Đã chuyển đến ${book?`trang ${original}, `:''}${current+1} trên ${count}`:`${book?`Trang ${original} · `:''}${current+1}/${count}`;};
 function chrome(){
  count=docs.translated?.numPages||count;current=Math.min(current,Math.max(0,count-1));
  pick('position').textContent=place();
  const active=document.activeElement;
  for(const button of all('prev'))button.disabled=current<=0;for(const button of all('next'))button.disabled=current>=count-1;
  // A button that just became disabled would drop the keyboard focus to the page body.
  if(active?.disabled&&root.contains(active))active.closest('.bilingual-nav')?.querySelector(`[data-bi="${active.dataset.bi==='prev'?'next':'prev'}"]`)?.focus();
  pick('zoom').textContent=`${Math.round(scale*100)}%`;pick('out').disabled=scale<=ZOOMS[0];pick('in').disabled=scale>=ZOOMS.at(-1);pick('fit').disabled=scale===1;
 }
 const note=text=>{const p=document.createElement('p');p.className='bilingual-empty';p.textContent=text;return p;};
 async function paint(side,doc,number,cssWidth,token){
  const sheet=sheets[side];
  if(!doc){sheet.replaceChildren(note(failures[side]||loading));return;}
  if(!Number.isInteger(number)||number<1||number>doc.numPages){sheet.replaceChildren(note(side==='original'?'Không có trang gốc tương ứng với trang này.':'Bản dịch không có trang này.'));return;}
  const page=await doc.getPage(number);if(token!==run||!alive)return;
  const drawn=pageFrame(page,cssWidth),{frame,layer,viewport}=drawn;if(side==='original')layer.dataset.hanziContext='';
  renders[side]?.cancel();const task=renderTask(page,drawn);renders[side]=task;
  try{await task.promise;}catch(error){if(error?.name==='RenderingCancelledException')return;throw error;}
  if(token!==run||!alive)return;
  // Selectable text over the picture: screen readers read the page, and Chinese on the original can be looked up.
  try{await new lib.TextLayer({textContentSource:page.streamTextContent(),container:layer,viewport}).render();}catch{}
  if(token!==run||!alive)return;
  sheet.replaceChildren(frame);page.cleanup();
 }
 async function draw(){
  if(!alive)return;chrome();
  const scroller=pick('translated-scroll');width=scroller.clientWidth;if(width<40)return;
  const token=++run,cssWidth=Math.floor((width-2)*scale);
  const results=await Promise.allSettled([paint('original',docs.original,pages[current],cssWidth,token),paint('translated',docs.translated,current+1,cssWidth,token)]);
  if(token!==run||!alive)return;
  const failed=results.find(result=>result.status==='rejected');status(failed?'Không vẽ được trang này. Hãy thử lại.':failures.original||failures.translated||'');
 }
 function go(target){const next=Math.max(0,Math.min(count-1,target));if(next===current)return;current=next;onChange({index:current,zoom:scale});for(const scroller of root.querySelectorAll('.bilingual-scroll'))scroller.scrollTo({left:0,top:0});pick('announce').textContent=place(true);draw();}
 function setZoom(value){if(value===scale)return;scale=value;onChange({index:current,zoom:scale});draw();}
 async function load(){
  failures.original=failures.translated='';status(loading);
  try{lib=await pdfjs();}catch{failures.translated=failures.original='Không tải được bộ đọc PDF. Hãy kiểm tra mạng rồi bấm Thử lại.';draw();return;}
  if(!alive)return;
  const sides=[['translated',translatedUrl,'bản dịch PDF'],['original',originalUrl,'PDF gốc']];
  await Promise.all(sides.map(async([side,url,what])=>{
   if(docs[side])return;const file=openPdf(lib,url);
   if(side==='original')file.progress=({loaded,total})=>{if(alive&&!docs.original&&loaded)status(total?`Đang tải PDF gốc… ${Math.min(99,Math.round(loaded/total*100))}%`:`Đang tải PDF gốc… ${(loaded/1048576).toFixed(1)} MB`);};
   try{docs[side]=await file.promise;}catch(error){failures[side]=loadFailure(error,what);}
   if(alive)draw();
  }));
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest?.('button[data-bi]');if(!button||button.disabled)return;
  const action=button.dataset.bi;
  if(action==='prev')go(current-1);else if(action==='next')go(current+1);else if(action==='in')setZoom(nextZoom(scale,1));else if(action==='out')setZoom(nextZoom(scale,-1));else if(action==='fit')setZoom(1);
 });
 root.addEventListener('keydown',event=>{
  if(event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('input,select,textarea'))return;
  // Arrow keys pan a zoomed page that is wider than its column; page keys always turn the page.
  const scroller=event.target.closest?.('.bilingual-scroll'),pans=Boolean(scroller)&&scroller.scrollWidth>scroller.clientWidth+1;
  const actions={PageDown:()=>go(current+1),PageUp:()=>go(current-1),ArrowRight:pans?null:()=>go(current+1),ArrowLeft:pans?null:()=>go(current-1),Home:scroller?null:()=>go(0),End:scroller?null:()=>go(count-1),'+':()=>setZoom(nextZoom(scale,1)),'=':()=>setZoom(nextZoom(scale,1)),'-':()=>setZoom(nextZoom(scale,-1)),'0':()=>setZoom(1)};
  const action=actions[event.key];if(!action)return;event.preventDefault();action();
 });
 // Zoomed pages scroll together, so the same part of both pages stays in view.
 let syncing=false;const scrollers=[pick('original-scroll'),pick('translated-scroll')];
 for(const [a,b] of [scrollers,[...scrollers].reverse()])a.addEventListener('scroll',()=>{if(syncing)return;syncing=true;b.scrollLeft=a.scrollLeft/Math.max(1,a.scrollWidth-a.clientWidth)*Math.max(0,b.scrollWidth-b.clientWidth);b.scrollTop=a.scrollTop/Math.max(1,a.scrollHeight-a.clientHeight)*Math.max(0,b.scrollHeight-b.clientHeight);requestAnimationFrame(()=>{syncing=false;});},{passive:true});
 let resizeTimer=0;const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(Math.abs(pick('translated-scroll').clientWidth-width)>2)draw();},120);}):null;
 observer?.observe(pick('translated-scroll'));
 onOriginalLayer(sheets.original);chrome();load();
 return {destroy(){alive=false;run++;observer?.disconnect();clearTimeout(resizeTimer);for(const task of Object.values(renders))task?.cancel();root.replaceChildren();},get index(){return current;},get zoom(){return scale;}};
}

// A translated PDF part as a column of pages fit to the reader's width, for phones and tablets: their browsers show an
// <iframe> PDF as an empty box (Android has no inline PDF viewer). Pages are drawn when they come near the screen and
// dropped again when far away, so a long part never holds more than a few canvases. One page is drawn at a time, the
// waiting near page closest to the screen first; a page that left the screen meanwhile is skipped (a fast fling on a slow
// phone would otherwise draw every page it passed, keep their canvases, and leave the page in view blank behind them).
export function mountPdfPages(root,{url,label='Bản dịch tiếng Việt'}={}){
 root.innerHTML='<section class="bilingual pdf-pages"><p class="bilingual-status" data-pp="status" role="status" aria-live="polite"></p><div class="pdf-pages-list" data-pp="list"></div></section>';
 root.firstElementChild.setAttribute('aria-label',label);
 const box=root.querySelector('[data-pp="status"]'),list=root.querySelector('[data-pp="list"]'),slots=[],tasks=new Map();
 let alive=true,doc=null,lib=null,width=0,aspect=1.414,near=null,resizeTimer=0,painting=false;const nearSlots=new Set(),failed=new Set();
 const status=(text,retry=false)=>{box.replaceChildren(text);if(retry){const button=document.createElement('button');button.type='button';button.textContent='Thử lại';button.onclick=()=>load();box.append(' ',button);}};
 const columnWidth=()=>Math.max(0,Math.floor(list.clientWidth));
 function release(slot){tasks.get(slot)?.cancel();tasks.delete(slot);delete slot.dataset.drawn;slot.replaceChildren();}
 const wanted=slot=>alive&&Boolean(slot.dataset.drawn)&&nearSlots.has(slot);
 async function paint(slot){
  if(!alive||slot.dataset.drawn||!doc||!nearSlots.has(slot))return;slot.dataset.drawn='1';
  try{
   const page=await doc.getPage(Number(slot.dataset.page));if(!wanted(slot)){release(slot);return;}
   const drawn=pageFrame(page,width),task=renderTask(page,drawn);tasks.set(slot,task);
   slot.style.height=`${Math.floor(drawn.viewport.height)}px`;
   await task.promise;if(!alive||tasks.get(slot)!==task)return;tasks.delete(slot);
   try{await new lib.TextLayer({textContentSource:page.streamTextContent(),container:drawn.layer,viewport:drawn.viewport}).render();}catch{}
   if(!wanted(slot)){release(slot);return;}
   // The slot is the page frame: its picture and text layer move in, sized like the frame.
   slot.style.setProperty('--scale-factor',String(drawn.viewport.scale));slot.replaceChildren(drawn.canvas,drawn.layer);page.cleanup();
  }catch(error){if(error?.name==='RenderingCancelledException')return;delete slot.dataset.drawn;failed.add(slot);if(alive)status('Không vẽ được một trang. Hãy thử lại.',true);}
 }
 function nextSlot(){
  const middle=innerHeight/2;let best=null,distance=Infinity;
  for(const slot of nearSlots){if(slot.dataset.drawn||failed.has(slot))continue;const box=slot.getBoundingClientRect(),away=Math.abs((box.top+box.bottom)/2-middle);if(away<distance){best=slot;distance=away;}}
  return best;
 }
 async function pump(){
  if(painting)return;painting=true;
  try{for(let slot=nextSlot();alive&&slot;slot=nextSlot())await paint(slot);}finally{painting=false;}
 }
 function observe(){
  near?.disconnect();nearSlots.clear();failed.clear();
  if(typeof IntersectionObserver!=='function'){for(const slot of slots)nearSlots.add(slot);pump();return;}
  near=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting)nearSlots.add(entry.target);else{nearSlots.delete(entry.target);release(entry.target);}}pump();},{rootMargin:'150% 0px'});
  for(const slot of slots)near.observe(slot);
 }
 function layout(){
  width=columnWidth();if(width<40)return;
  for(const slot of slots){release(slot);slot.style.width=`${width}px`;slot.style.height=`${Math.floor(width*aspect)}px`;}
  observe();
 }
 async function load(){
  status('Đang tải PDF…');
  try{lib=await pdfjs();}catch{if(alive)status('Không tải được bộ đọc PDF. Hãy kiểm tra mạng rồi bấm Thử lại.',true);return;}
  if(!alive)return;const file=openPdf(lib,url);
  file.progress=({loaded,total})=>{if(alive&&!doc&&loaded)status(total?`Đang tải PDF… ${Math.min(99,Math.round(loaded/total*100))}%`:`Đang tải PDF… ${(loaded/1048576).toFixed(1)} MB`);};
  try{doc=await file.promise;const first=(await doc.getPage(1)).getViewport({scale:1});aspect=first.height/first.width||aspect;}catch(error){if(alive)status(loadFailure(error,'bản dịch PDF'),true);return;}
  if(!alive)return;
  slots.length=0;list.replaceChildren();
  for(let number=1;number<=doc.numPages;number++){const slot=document.createElement('div');slot.className='bilingual-page pdf-pages-page';slot.dataset.page=String(number);slot.setAttribute('role','group');slot.setAttribute('aria-label',`Trang ${number} / ${doc.numPages}`);slots.push(slot);}
  list.append(...slots);status(doc.numPages>1?`${doc.numPages} trang · kéo xuống để đọc tiếp.`:'');layout();
 }
 const resize=typeof ResizeObserver==='function'?new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(alive&&slots.length&&Math.abs(columnWidth()-width)>2)layout();},150);}):null;
 resize?.observe(list);load();
 return {destroy(){alive=false;near?.disconnect();resize?.disconnect();clearTimeout(resizeTimer);for(const task of tasks.values())task.cancel();tasks.clear();root.replaceChildren();}};
}
