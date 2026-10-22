import {pageMarkup,boxStyles,prepareLayout,fitTextBoxes,hasBlockTranslation,pageVersion} from './pdf-box-layout.js';
// Blocks with Han text as tap targets over the original page image, in PDF points like pageMarkup.
export function sourceRegions(entry){
 return (entry?.blocks||[]).flatMap((b,i)=>{const text=String(b.text||b.source||'').replace(/@@PDF_INLINE_\d+@@/gu,' ').replace(/\s+/gu,' ').trim(),chars=[...text];if(!/\p{Script=Han}/u.test(text)||!Array.isArray(b.box)||b.box.length!==4)return [];const [x,y,r,t]=b.box;return [{id:b.id,label:`Đoạn ${i+1}: ${chars.length>40?`${chars.slice(0,40).join('')}…`:text}`,style:`left:${x}pt;top:${y}pt;width:${r-x}pt;height:${t-y}pt`}];});
}

// Phones see one column: the translated page comes first, both fitted to the width of the screen.
const PHONE='(max-width:680px)';
export class PdfDualViewer{
 // loadFont: fetches the preview font the first time a translated page is drawn (never before), so the page opens and a
 // file is picked without waiting for it. A failure keeps the fallback serif and is tried again on the next page.
 // flagged: blocks an export found longer than their boxes (flagBlocks); they are outlined and their editor options say
 // so until they are saved again.
 constructor(root,{loadFont=null}={}){
  this.root=root;this.index=0;this.zoom=1;this.zoomMode='fit';this.loadFont=loadFont;this.fontReady=!loadFont;this.translations=new Map();this.pdf=null;this.version=0;this.flagged=new Set();
  if(!document.querySelector('style[data-pdf-box-styles]')){const style=document.createElement('style');style.dataset.pdfBoxStyles='';style.textContent=boxStyles;document.head.append(style);}
  root.innerHTML='<div class="pdf-viewer-toolbar"><div><strong>PDF gốc & bản dịch tiếng Việt</strong><small>Hai bản dùng cùng trang và mức thu phóng. Chạm vào đoạn chữ ở PDF gốc để tra chữ Hán.</small></div><div class="pdf-page-controls"><button type="button" data-pdf-prev aria-label="Trang trước">←</button><span data-pdf-page></span><button type="button" data-pdf-next aria-label="Trang sau">→</button><select data-pdf-zoom aria-label="Thu phóng"><option value="fit" selected>Vừa khung</option><option value="0.6">60%</option><option value="0.8">80%</option><option value="1">100%</option><option value="1.25">125%</option></select></div></div><div class="pdf-viewer-grid"><section data-pdf-side="original"><h3>PDF gốc</h3><div class="pdf-viewer-scroll" data-pdf-original></div></section><section data-pdf-side="translated"><h3>Tiếng Việt <small data-pdf-render-state>Chưa có bản dịch</small></h3><div class="pdf-viewer-scroll" data-pdf-translated></div></section></div><p class="pdf-layout-notice" data-pdf-notice role="status"></p>';
  this.original=root.querySelector('[data-pdf-original]');this.translated=root.querySelector('[data-pdf-translated]');
  root.insertAdjacentHTML('beforeend','<details class="pdf-block-editor"><summary>Chỉnh bản dịch từng đoạn</summary><div><label>Đoạn trong trang hiện tại<select data-pdf-edit-select></select></label><p data-pdf-edit-source lang="zh" data-hanzi-lookup></p><label>Bản dịch tiếng Việt<textarea data-pdf-edit-text rows="4"></textarea></label><small>Giữ các ô [Công thức 1], [Công thức 2] để bảo toàn ký hiệu toán. Bản sửa sẽ được lưu vào tài khoản; xuất lại PDF để áp dụng.</small><button type="button" data-pdf-edit-save>Lưu đoạn đã sửa</button></div></details>');
  this.editSelect=root.querySelector('[data-pdf-edit-select]');this.editSelect.onchange=()=>this.editBlock(this.editSelect.value);root.querySelector('[data-pdf-edit-save]').onclick=async()=>{const b=this.document?.pages.flatMap(p=>p.blocks).find(b=>b.id===this.editSelect.value);if(!b||!hasBlockTranslation(this.translations,b.id))return;let translation=root.querySelector('[data-pdf-edit-text]').value;for(const [i,item] of (b.inlines||[]).entries())translation=translation.replace(`[Công thức ${i+1}]`,item.token);const flagged=this.flagged.delete(b.id);if(!await this.onEdit?.(b.id,translation)&&flagged){this.flagged.add(b.id);await this.show(this.index);}};
  this.translated.addEventListener('click',event=>{const b=event.target.closest('[data-block-id]');if(b){root.querySelector('.pdf-block-editor').open=true;this.editSelect.value=b.dataset.blockId;this.editBlock(b.dataset.blockId);}});
  this.original.addEventListener('click',event=>{const region=event.target.closest('[data-source-block]'),entry=this.document?.pages[this.index],block=region&&entry?.blocks.find(b=>b.id===region.dataset.sourceBlock);if(!block)return;for(const item of this.original.querySelectorAll('[data-source-block][aria-pressed="true"]'))item.setAttribute('aria-pressed','false');region.setAttribute('aria-pressed','true');this.sourceBlock=block.id;this.onSourceBlock?.(block,entry,region);});
  root.querySelector('[data-pdf-prev]').onclick=()=>this.show(Math.max(0,this.index-1));root.querySelector('[data-pdf-next]').onclick=()=>this.show(Math.min(this.document.pages.length-1,this.index+1));
  root.querySelector('[data-pdf-zoom]').onchange=event=>{this.zoomMode=event.target.value;this.show(this.index);};
  const grid=root.querySelector('.pdf-viewer-grid'),phone=globalThis.matchMedia?.(PHONE),order=()=>grid.prepend(grid.querySelector(`[data-pdf-side="${phone?.matches?'translated':'original'}"]`));
  if(phone){order();phone.addEventListener('change',order);}
  // Fitted pages follow the width of their column (a rotated phone, a resized window).
  this.resized=globalThis.ResizeObserver?new ResizeObserver(()=>{const now=this.original.clientWidth;if(this.zoomMode!=='fit'||!this.document||!now||Math.abs(now-(this.fitWidth||0))<2)return;clearTimeout(this.resizeTimer);this.resizeTimer=setTimeout(()=>this.show(this.index),150);}):null;this.resized?.observe(this.original);
  let syncing=false;for(const [a,b] of [[this.original,this.translated],[this.translated,this.original]])a.addEventListener('scroll',()=>{if(syncing)return;syncing=true;const ratio=a.scrollTop/Math.max(1,a.scrollHeight-a.clientHeight);b.scrollTop=ratio*Math.max(0,b.scrollHeight-b.clientHeight);b.scrollLeft=a.scrollLeft;requestAnimationFrame(()=>{syncing=false;});});
 }
 async clear(){this.version++;this.root.hidden=true;this.document=null;this.sourceBlock=null;this.translations=new Map();this.flagged=new Set();this.original.replaceChildren();this.translated.replaceChildren();this.editSelect.replaceChildren();this.setEditorAvailability(false);if(this.pdf){await this.pdf.loadingTask.destroy();this.pdf=null;}}
 async setDocument(document,translations=[]){await this.clear();this.document=document;this.root.hidden=false;this.translations=new Map(translations.map(item=>[item.id,item.translation]));await this.show(0);}
 async update(translations){this.translations=new Map(translations.map(item=>[item.id,item.translation]));await this.show(this.index);}
 // The blocks an export refused as longer than their boxes (study.js, 422 pdf_overflow): each is outlined and named in
 // the editor until it is saved again, and the editor opens on the first one.
 async flagBlocks(ids){this.flagged=new Set(ids);return ids.length?this.openBlock(ids[0]):false;}
 // Brings a block into view in the editor: its page, the editor opened on it, focus on its choice (no keyboard yet on a
 // phone). False when the document has no such block.
 async openBlock(id){
  const index=this.document?.pages.findIndex(page=>page.blocks.some(b=>b.id===id))??-1;if(index<0)return false;
  const shown=this.show(index),editor=this.root.querySelector('.pdf-block-editor');this.editSelect.value=id;this.editBlock(id);editor.open=true;
  editor.scrollIntoView?.({block:'nearest'});this.editSelect.focus({preventScroll:true});await shown;return true;
 }
 setEditorAvailability(available){this.root.querySelector('[data-pdf-edit-text]').disabled=!available;this.root.querySelector('[data-pdf-edit-text]').placeholder=available?'':'Đoạn này chưa có bản dịch.';this.root.querySelector('[data-pdf-edit-save]').disabled=!available;}
 editBlock(id){
  const b=this.document?.pages.flatMap(p=>p.blocks).find(b=>b.id===id);if(!b){this.root.querySelector('[data-pdf-edit-source]').textContent='';this.root.querySelector('[data-pdf-edit-text]').value='';this.setEditorAvailability(false);return;}const available=hasBlockTranslation(this.translations,id);let text=available?this.translations.get(id):'';for(const [i,item] of (b.inlines||[]).entries())text=text.replace(item.token,`[Công thức ${i+1}]`);this.root.querySelector('[data-pdf-edit-source]').textContent=b.text||b.source;this.root.querySelector('[data-pdf-edit-text]').value=text;this.setEditorAvailability(available);
 }
 async invalidatePdf(){if(this.pdf){await this.pdf.loadingTask.destroy();this.pdf=null;}await this.show(this.index);}
 scaledFrame(child,width,height){const frame=document.createElement('div');frame.className='pdf-page-frame';frame.style.width=`${width*4/3*this.zoom}px`;frame.style.height=`${height*4/3*this.zoom}px`;child.style.transform=`scale(${this.zoom})`;child.style.transformOrigin='top left';frame.append(child);return frame;}
 // The page width that fills the column (its padding and a reserved scrollbar gutter excluded), within 30–150%.
 fitZoom(entry){
  const box=this.original,style=getComputedStyle(box),width=box.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);this.fitWidth=box.clientWidth;
  return width>0?Math.min(1.5,Math.max(.3,Math.floor(width/(entry.width*4/3)*100)/100)):.8;
 }
 async show(index){
  if(!this.document)return;const version=++this.version;this.index=index;const entry=this.document.pages[index];this.zoom=this.zoomMode==='fit'?this.fitZoom(entry):Number(this.zoomMode)||.8;this.original.replaceChildren();this.translated.replaceChildren();
  this.root.querySelector('[data-pdf-page]').textContent=`Trang ${entry.number} · ${index+1}/${this.document.pages.length}`;this.root.querySelector('[data-pdf-prev]').disabled=index===0;this.root.querySelector('[data-pdf-next]').disabled=index===this.document.pages.length-1;
  const completed=entry.blocks.filter(b=>hasBlockTranslation(this.translations,b.id)),allBlocks=this.document.pages.flatMap(p=>p.blocks),totalCompleted=allBlocks.filter(b=>hasBlockTranslation(this.translations,b.id)).length;
  this.root.querySelector('[data-pdf-render-state]').textContent=allBlocks.length&&totalCompleted===allBlocks.length?'Bản xem trước':completed.length?'Đang dịch…':'Chưa có bản dịch';
  // Every block translated: nothing on any page is still in the original.
  this.root.querySelector('[data-pdf-notice]').textContent=allBlocks.length&&totalCompleted===allBlocks.length?`Đã dịch đủ ${new Intl.NumberFormat('vi-VN').format(allBlocks.length)} đoạn.`:completed.length?`Đã dịch ${totalCompleted}/${allBlocks.length} đoạn. Các đoạn chưa dịch vẫn hiển thị nguyên bản.`:'Trang này chưa có bản dịch. Đang hiển thị PDF gốc để giữ nguyên hình và chữ.';
  const selected=this.editSelect.value;this.editSelect.replaceChildren();for(const [i,b] of entry.blocks.entries()){const option=document.createElement('option');option.value=b.id;option.disabled=!hasBlockTranslation(this.translations,b.id);option.textContent=`Đoạn ${i+1} · ${(b.text||b.source).slice(0,40)}${option.disabled?' · Chưa dịch':this.flagged.has(b.id)?' · Dài hơn khung chữ':''}`;this.editSelect.append(option);}this.editSelect.disabled=!completed.length;if(completed.some(b=>b.id===selected))this.editSelect.value=selected;else if(completed.length)this.editSelect.value=completed[0].id;else if(entry.blocks.length)this.editSelect.value=entry.blocks[0].id;this.editBlock(this.editSelect.value);
  const sheet=document.createElement('div'),original=document.createElement('img');sheet.className='pdf-original-page';sheet.style.width=`${entry.width}pt`;sheet.style.height=`${entry.height}pt`;original.src=entry.original;original.alt=`PDF gốc trang ${entry.number}`;sheet.append(original);
  // Each translated batch re-renders the page: the looked-up block stays pressed and keeps its id, which the lookup
  // panel uses to give the focus back.
  for(const item of sourceRegions(entry)){const region=document.createElement('button');region.type='button';region.id=`pdf-source-${item.id}`;region.className='pdf-source-region';region.dataset.sourceBlock=item.id;region.title=item.label;region.setAttribute('aria-label',item.label);region.setAttribute('aria-pressed',String(item.id===this.sourceBlock));region.style.cssText=item.style;sheet.append(region);}
  this.original.append(this.scaledFrame(sheet,entry.width,entry.height));
  if(this.pdf){
   const page=await this.pdf.getPage(index+1);if(version!==this.version)return;const viewport=page.getViewport({scale:4/3}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*devicePixelRatio);canvas.height=Math.ceil(viewport.height*devicePixelRatio);canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;this.translated.append(this.scaledFrame(canvas,entry.width,entry.height));await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:devicePixelRatio===1?null:[devicePixelRatio,0,0,devicePixelRatio,0,0]}).promise;page.cleanup();this.root.querySelector('[data-pdf-render-state]').textContent='PDF đã xuất';this.root.querySelector('[data-pdf-notice]').textContent='Bản PDF hoàn tất đã lưu trong Thư viện riêng.';return;
  }
  if(!this.fontReady){try{await this.loadFont();this.fontReady=true;}catch{}if(version!==this.version)return;}
  const wrapper=document.createElement('div');wrapper.innerHTML=pageMarkup({...entry,extractionVersion:pageVersion(entry,this.document)},this.translations);const paper=wrapper.firstElementChild;for(const node of paper.querySelectorAll('[data-block-id]'))node.classList.toggle('is-overflow',this.flagged.has(node.dataset.blockId));this.translated.append(this.scaledFrame(paper,entry.width,entry.height));await document.fonts.ready;await Promise.all([...paper.querySelectorAll('img')].map(img=>img.decode().catch(()=>{})));if(version!==this.version)return;
  // Same steps as the PDF exporter, so the preview shows the layout that will be exported.
  await prepareLayout(paper);if(version!==this.version)return;
  const report=fitTextBoxes(paper),overflow=report.filter(b=>b.overflow),small=report.filter(b=>b.shrunk&&!b.overflow),flagged=entry.blocks.flatMap((b,i)=>this.flagged.has(b.id)?[`Đoạn ${i+1}`]:[]);
  if(flagged.length)this.root.querySelector('[data-pdf-notice]').textContent=`Khi xuất PDF, ${flagged.join(', ')} của trang này dài hơn khung chữ (viền đỏ). Hãy viết ngắn lại trong “Chỉnh bản dịch từng đoạn”, bấm “Lưu đoạn đã sửa” rồi xuất lại.`;
  else if(overflow.length)this.root.querySelector('[data-pdf-notice]').textContent=`Có ${overflow.length} đoạn dịch dài hơn khung chữ trên trang. Hãy rút gọn các đoạn đó trước khi xuất PDF.`;
  else if(!this.fontReady)this.root.querySelector('[data-pdf-notice]').textContent='Chưa tải được phông chữ xem trước nên chữ ở bản xem trước có thể khác PDF xuất ra một chút. Kiểm tra mạng rồi chuyển trang để thử lại.';
  else if(small.length)this.root.querySelector('[data-pdf-notice]').textContent=`Có ${small.length} đoạn phải thu nhỏ chữ dưới 85% cỡ gốc vì bản dịch dài hơn chỗ trống. Có thể rút gọn đoạn dịch để chữ dễ đọc hơn.`;
 }
 async setExportedPdf(url){
  const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('Không tải được PDF đã xuất.');const pdfjs=await import('/vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';if(this.pdf)await this.pdf.loadingTask.destroy();this.pdf=await pdfjs.getDocument({data:new Uint8Array(await response.arrayBuffer())}).promise;await this.show(this.index);
 }
}
