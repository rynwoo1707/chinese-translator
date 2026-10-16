// Rebuilds a student's book like the original PDF, on the device: every page of each original file in order, with each
// translated page in place of its original; the cover, untranslated, blank and back pages stay the original artwork.
// pdf-lib and pdf.js are passed in, so the same code runs in the reader and under node --test.

const usable=part=>part.mime==='application/pdf'&&Boolean(part.file)&&Array.isArray(part.pages)&&part.pages.length>0;
export const hasTranslatedPdf=usable;
// The sources of a book in chapter order. A file is known by its hash; parts saved before hashes existed fall back to the
// file name and page count, the same rule that places parts in the book.
export function bookSources(parts){
 const sources=[],unplaced=[];
 for(const part of parts){
  if(!part.sha256&&!part.filename){unplaced.push(part);continue;}
  const legacy=source=>source.filenames.has(part.filename)&&(source.totalPages??null)===(part.totalPages??null);
  let source=part.sha256?sources.find(item=>item.sha256===part.sha256)||sources.find(item=>!item.sha256&&legacy(item)):sources.find(legacy);
  if(source&&part.sha256&&!source.sha256)source.sha256=part.sha256;
  if(!source){source={key:'',sha256:part.sha256||null,filename:part.filename||'',totalPages:part.totalPages??null,filenames:new Set(),parts:[]};sources.push(source);}
  source.filenames.add(part.filename);source.parts.push(part);source.totalPages??=part.totalPages??null;
 }
 sources.forEach((source,index)=>{source.key=source.sha256||`tệp ${index+1}: ${source.filename}`;});
 return {sources,unplaced};
}
// One entry per page of the finished book: {source, page, from:'translated'|'original', part, index (page in the part's PDF)}.
// When two parts translated the same page, the newer translation wins: translatedAt, which a rename or a move between
// books leaves alone (updatedAt does not); equal times fall back to the book order.
export function planBook(sources,pageCounts=new Map()){
 const entries=[],warnings=[];let translated=0;
 for(const source of sources){
  const total=pageCounts.get(source.key)??source.totalPages;if(!Number.isInteger(total)||total<1)throw Object.assign(new Error(`Chưa biết số trang của tệp gốc “${source.filename}”.`),{known:true});
  const when=part=>String(part.translatedAt||part.updatedAt||''),owners=new Map(),recent=[...source.parts].filter(usable).sort((a,b)=>when(a).localeCompare(when(b))||(a.position??0)-(b.position??0));
  for(const part of recent)part.pages.forEach((page,index)=>{if(page>=1&&page<=total)owners.set(page,{part,index});else warnings.push(`Phần “${part.title}” có trang ${page} nằm ngoài tệp gốc ${total} trang; trang này bị bỏ qua.`);});
  for(let page=1;page<=total;page++){const owner=owners.get(page);if(owner)translated++;entries.push(owner?{source,page,from:'translated',part:owner.part,index:owner.index}:{source,page,from:'original'});}
  for(const part of source.parts)if(!usable(part))warnings.push(missingPdfNote(part));
 }
 return {entries,translated,total:entries.length,warnings};
}
// Why a part adds no Vietnamese page to the book. A range translated with "Giữ bố cục PDF" only needs exporting; a text
// translation (a PDF range read in the browser, a DOCX chapter…) has no PDF pages, and its button is disabled.
// inBook: its file is in the book, so its pages are there as the original; otherwise the part is simply not in the file.
export function missingPdfNote(part,{inBook=true}={}){
 const name=`Phần “${part.title}”`;
 if(part.layout)return inBook?`${name} chưa có PDF tiếng Việt (hãy mở lại phần này trong Xưởng dịch và bấm Xuất PDF tiếng Việt); các trang của phần này giữ nguyên bản gốc.`:`${name} chưa có PDF tiếng Việt nên chưa có trong bản ghép; hãy mở lại phần này trong Xưởng dịch và bấm Xuất PDF tiếng Việt.`;
 const redo=/\.pdf$/iu.test(part.filename||'')?' Muốn có các trang này bằng tiếng Việt trong bản ghép, hãy dịch lại chúng với tùy chọn “Giữ bố cục PDF và xuất bản tiếng Việt”.':'';
 return `${name} là bản dịch dạng chữ, không có trang PDF, nên ${inBook?'các trang của phần này giữ nguyên bản gốc':'không có trong bản ghép; phần này vẫn đọc được trong Thư viện riêng'}.${redo}`;
}
export const coverageNote=plan=>`Đã dịch ${plan.translated}/${plan.total} trang; các trang còn lại giữ nguyên bản gốc.`;

// Students pick an original on the device when the account has no copy (ranges translated before originals were kept).
// With a hash the match is exact; parts saved before hashes existed can only be checked by their page count.
export function checkLocalSource(source,{sha256='',pageCount}){
 if(source.sha256&&sha256)return sha256===source.sha256?{ok:true}:{ok:false,error:`Tệp này không phải bản gốc “${source.filename}” của các phần đã dịch (mã tệp khác). Hãy chọn đúng tệp đã tải lên khi dịch.`};
 if(source.totalPages&&pageCount!==source.totalPages)return {ok:false,error:`Tệp này có ${pageCount} trang, còn bản gốc “${source.filename}” có ${source.totalPages} trang. Hãy chọn đúng tệp đã tải lên khi dịch.`};
 const highest=Math.max(0,...source.parts.flatMap(part=>part.pages||[]));if(highest>pageCount)return {ok:false,error:`Tệp này chỉ có ${pageCount} trang, ít hơn trang ${highest} đã dịch.`};
 const why=source.sha256?'trình duyệt này không tính được mã tệp':'các phần này được dịch trước khi Hoa Trí ghi mã tệp';
 return {ok:true,warning:`Chưa xác minh được đây đúng là tệp gốc vì ${why}; chỉ kiểm tra được số trang (${pageCount}). Hãy xem lại các trang chưa dịch trong bản ghép.`};
}

// Outline and page labels of an original, read with pdf.js (outline) and pdf-lib (the raw page-label number tree).
export async function readOutline(pdf){
 const outline=await pdf.getOutline().catch(()=>null);
 const visit=async(items,depth)=>{
  const result=[];if(depth>32)return result;
  for(const item of items||[]){
   const children=await visit(item.items,depth+1);let page=null,dest=null;
   try{const explicit=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;if(Array.isArray(explicit)&&explicit.length){page=Number.isInteger(explicit[0])?explicit[0]:await pdf.getPageIndex(explicit[0]);dest={type:explicit[1]?.name||'Fit',args:explicit.slice(2).map(value=>typeof value==='number'&&Number.isFinite(value)?value:null)};}}catch{page=null;}
   if(page===null&&!children.length)continue;
   result.push({title:String(item.title||'').slice(0,500),page,dest,open:!(item.count<0),children});
  }
  return result;
 };
 return visit(outline,0);
}
export function readPageLabels(PDFLib,doc){
 const {PDFName,PDFNumber,PDFDict,PDFArray}=PDFLib,entries=[];
 const walk=(node,depth)=>{
  if(!(node instanceof PDFDict)||depth>16)return;
  const nums=node.lookup(PDFName.of('Nums'));if(nums instanceof PDFArray)for(let i=0;i+1<nums.size();i+=2){const key=nums.lookup(i),value=nums.lookup(i+1);if(key instanceof PDFNumber&&value instanceof PDFDict)entries.push([key.asNumber(),value]);}
  const kids=node.lookup(PDFName.of('Kids'));if(kids instanceof PDFArray)for(let i=0;i<kids.size();i++)walk(kids.lookup(i),depth+1);
 };
 try{walk(doc.catalog.lookup(PDFName.of('PageLabels')),0);}catch{return [];}
 return entries.sort((a,b)=>a[0]-b[0]);
}
function writeOutline(PDFLib,out,items){
 const {PDFName,PDFNumber,PDFHexString,PDFNull}=PDFLib,context=out.context,pages=out.getPages();
 const build=(list,parent)=>{
  const refs=list.map(()=>context.nextRef());let visible=0;
  list.forEach((item,i)=>{
   const dict=context.obj({Title:PDFHexString.fromText(item.title),Parent:parent});
   if(i>0)dict.set(PDFName.of('Prev'),refs[i-1]);if(i<list.length-1)dict.set(PDFName.of('Next'),refs[i+1]);
   if(item.page!==null&&pages[item.page])dict.set(PDFName.of('Dest'),context.obj([pages[item.page].ref,PDFName.of(item.dest?.type||'Fit'),...(item.dest?.args||[]).map(value=>value===null?PDFNull:PDFNumber.of(value))]));
   if(item.children.length){const sub=build(item.children,refs[i]);dict.set(PDFName.of('First'),sub.first);dict.set(PDFName.of('Last'),sub.last);dict.set(PDFName.of('Count'),PDFNumber.of(item.open?sub.count:-sub.count));if(item.open)visible+=sub.count;}
   visible++;context.assign(refs[i],dict);
  });
  return {first:refs[0],last:refs.at(-1),count:visible};
 };
 if(!items.length)return;
 const root=context.nextRef(),top=build(items,root);
 context.assign(root,context.obj({Type:'Outlines',First:top.first,Last:top.last,Count:top.count}));out.catalog.set(PDFName.of('Outlines'),root);
}
const shiftOutline=(items,offset,total)=>items.map(item=>({...item,page:item.page!==null&&item.page>=0&&item.page<total?item.page+offset:null,children:shiftOutline(item.children,offset,total)})).filter(item=>item.page!==null||item.children.length);

// Internal links (a table of contents, "see page 12") name a page of their own PDF. Copied as they are, each would bring
// that page into the book a second time, outside its page list: the link goes nowhere useful and the scan of a replaced
// page is carried along. So before a copy every link names its target by number, and once the book's pages exist it is
// pointed at the page now standing there. target(index) gives that number, or null to drop the link; named
// destinations are resolved first. /P (the annotation's own page) is cleared too, or it would copy the page again.
function detachLinks(PDFLib,doc,indices,target){
 const {PDFName,PDFDict,PDFArray,PDFRef,PDFNumber,PDFNull,PDFString,PDFHexString}=PDFLib,key=name=>PDFName.of(name),context=doc.context,pages=doc.getPages();
 const pageIndex=new Map(pages.map((page,index)=>[page.ref.toString(),index]));let names=null;
 const named=text=>{
  if(!names){
   names=new Map();const walk=(node,depth)=>{if(!(node instanceof PDFDict)||depth>32)return;const list=node.lookup(key('Names'));if(list instanceof PDFArray)for(let i=0;i+1<list.size();i+=2){const name=list.lookup(i);if(name instanceof PDFString||name instanceof PDFHexString)names.set(name.decodeText(),list.get(i+1));}const kids=node.lookup(key('Kids'));if(kids instanceof PDFArray)for(let i=0;i<kids.size();i++)walk(kids.lookup(i),depth+1);};
   try{const old=doc.catalog.lookup(key('Dests'));if(old instanceof PDFDict)for(const [name,value] of old.entries())names.set(name.decodeText(),value);const tree=doc.catalog.lookup(key('Names'));if(tree instanceof PDFDict)walk(tree.lookup(key('Dests')),0);}catch{}
  }
  return names.get(text);
 };
 const explicit=(value,depth=0)=>{
  value=context.lookup(value);if(value instanceof PDFDict)value=context.lookup(value.get(key('D')));
  if((value instanceof PDFName||value instanceof PDFString||value instanceof PDFHexString)&&depth<4)return explicit(named(value.decodeText()),depth+1);
  return value instanceof PDFArray&&value.size()?value:null;
 };
 for(const index of indices){
  const node=pages[index]?.node;if(!node)continue;
  try{
   const annots=node.lookup(key('Annots'));if(!(annots instanceof PDFArray))continue;const kept=[];
   for(let i=0;i<annots.size();i++){
    const item=annots.get(i),annot=context.lookup(item);if(!(annot instanceof PDFDict)){kept.push(item);continue;}
    if(annot.has(key('P')))annot.set(key('P'),PDFNull);
    const action=annot.lookup(key('A')),goTo=action instanceof PDFDict&&action.lookup(key('S'))===key('GoTo');
    // Web links, other files and scripts name no page of this PDF: they stay as they are.
    if(annot.lookup(key('Subtype'))!==key('Link')||!annot.has(key('Dest'))&&!goTo){kept.push(item);continue;}
    const dest=explicit(annot.has(key('Dest'))?annot.get(key('Dest')):action.get(key('D'))),first=dest?.get(0);
    const from=first instanceof PDFRef?pageIndex.get(first.toString()):first instanceof PDFNumber?first.asNumber():undefined,to=Number.isInteger(from)?target(from):null;
    if(!Number.isInteger(to))continue;
    annot.delete(key('A'));annot.set(key('Dest'),context.obj([PDFNumber.of(to),...dest.asArray().slice(1)]));kept.push(item);
   }
   node.set(key('Annots'),context.obj(kept));
  }catch{node.delete(key('Annots'));}
 }
}
function attachLinks(PDFLib,context,pages,resolve){
 const {PDFName,PDFDict,PDFArray,PDFNumber,PDFNull}=PDFLib,key=name=>PDFName.of(name);
 for(const page of pages){
  const annots=page.node.lookup(key('Annots'));if(!(annots instanceof PDFArray))continue;const kept=[];
  for(let i=0;i<annots.size();i++){
   const item=annots.get(i),annot=context.lookup(item);
   if(annot instanceof PDFDict){
    if(annot.get(key('P'),true)===PDFNull)annot.set(key('P'),page.ref);
    const dest=annot.lookup(key('Dest'));if(dest instanceof PDFArray&&dest.get(0) instanceof PDFNumber){const to=resolve(dest.get(0).asNumber());if(!to)continue;dest.set(0,to.ref);}
   }
   kept.push(item);
  }
  page.node.set(key('Annots'),context.obj(kept));
 }
}

const known=(message,extra={})=>Object.assign(new Error(message),{known:true,...extra});
async function loadPdfLib(PDFLib,bytes,what){
 try{return await PDFLib.PDFDocument.load(bytes,{updateMetadata:false});}
 catch(error){throw known(/encrypt/iu.test(String(error?.message))?`${what} được mã hóa nên không ghép trang được.`:`Không mở được ${what} để ghép.`,{unreadable:true});}
}
// Pages are inserted at their final place whatever order they arrive in, so only one input PDF is open at a time:
// each translated part, then the original it belongs to.
// extras: translated parts whose original file is unknown; they follow the rebuilt originals instead of being dropped.
export async function assembleBook({PDFLib,pdfjs,title,sources,loadSource,loadPart,onProgress=()=>{},pageCounts=new Map(),extras=[]}){
 const out=await PDFLib.PDFDocument.create(),placed=[],pageAt=new Map(),outline=[],labels=[];let done=0,offset=0,anyLabels=false;
 const plan=planBook(sources,pageCounts),finalIndex=new Map(plan.entries.map((entry,index)=>[entry,index]));
 let total=plan.total+extras.reduce((sum,part)=>sum+(part.pages?.length||0),0);
 const insert=(page,index)=>{let low=0,high=placed.length;while(low<high){const mid=(low+high)>>1;if(placed[mid]<index)low=mid+1;else high=mid;}out.insertPage(low,page);placed.splice(low,0,index);pageAt.set(index,page);onProgress(++done,total);};
 for(const source of sources){
  const entries=plan.entries.filter(entry=>entry.source===source),copied=[];
  for(const part of [...new Set(entries.filter(entry=>entry.from==='translated').map(entry=>entry.part))]){
   const mine=entries.filter(entry=>entry.part===part);
   const bytes=await loadPart(part);
   try{
    const doc=await loadPdfLib(PDFLib,bytes,`PDF của phần “${part.title}”`);
    if(doc.getPageCount()!==part.pages.length)throw known(`PDF của phần “${part.title}” có ${doc.getPageCount()} trang, khác ${part.pages.length} trang đã dịch.`,{unreadable:true});
    const indices=mine.map(entry=>entry.index);detachLinks(PDFLib,doc,indices,index=>part.pages[index]>0?part.pages[index]-1:null);
    const copies=await out.copyPages(doc,indices);copies.forEach((page,i)=>insert(page,finalIndex.get(mine[i])));copied.push(...copies);
   }catch(error){
    // A part whose PDF is unreadable or does not match its pages keeps those pages from the original instead of
    // leaving a hole; a download that failed (network) still fails, so a retry gives the complete book.
    if(!error?.unreadable)throw error;plan.warnings.push(`${error.message} Các trang này giữ nguyên bản gốc.`);for(const entry of mine){entry.from='original';plan.translated--;}
   }
  }
  const bytes=await loadSource(source),data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(pdfjs){const pdf=await pdfjs.getDocument({data:data.slice(),verbosity:0}).promise;try{outline.push(...shiftOutline(await readOutline(pdf),offset,entries.length));}finally{await pdf.loadingTask.destroy();}}
  const src=await loadPdfLib(PDFLib,data,`PDF gốc “${source.filename}”`);
  if(src.getPageCount()!==entries.length)throw known(`PDF gốc “${source.filename}” có ${src.getPageCount()} trang, khác ${entries.length} trang của sách.`);
  const originals=entries.filter(entry=>entry.from==='original'),indices=originals.map(entry=>entry.page-1);
  detachLinks(PDFLib,src,indices,index=>index>=0&&index<entries.length?index:null);
  const copies=await out.copyPages(src,indices);copies.forEach((page,i)=>insert(page,finalIndex.get(originals[i])));copied.push(...copies);
  // Every page of this file is in the book now; a link leads to its page there, translated or original.
  attachLinks(PDFLib,out.context,copied,index=>pageAt.get(finalIndex.get(entries[index])));
  // Rendered pages come out a fraction of a point off the original size (594.96 × 841.92 for 595.22 × 842); they take
  // the original's size so the whole book keeps one page size, as in print. The box grows at the bottom and right, so
  // nothing on the page moves. Real differences in size are left alone.
  for(const entry of entries)if(entry.from==='translated'){
   const original=src.getPage(entry.page-1),page=out.getPage(placed.indexOf(finalIndex.get(entry))),box=original.getMediaBox(),own=page.getMediaBox(),crop=original.getCropBox();
   if(Math.abs(box.width-own.width)<=2&&Math.abs(box.height-own.height)<=2&&original.getRotation().angle===page.getRotation().angle&&crop.width===box.width&&crop.height===box.height){
    const explicitCrop=page.node.get(PDFLib.PDFName.of('CropBox')),y=own.y+own.height-box.height;
    page.setMediaBox(own.x,y,box.width,box.height);if(explicitCrop)page.setCropBox(own.x,y,box.width,box.height);
   }
  }
  const ownLabels=readPageLabels(PDFLib,src);
  if(ownLabels.length){anyLabels=true;const copier=PDFLib.PDFObjectCopier.for(src.context,out.context);if(ownLabels[0][0]!==0)labels.push([offset,null]);for(const [index,dict] of ownLabels)if(index<entries.length)labels.push([offset+index,copier.copy(dict)]);}
  else labels.push([offset,null]);
  offset+=entries.length;
 }
 for(const part of extras){
  const doc=await loadPdfLib(PDFLib,await loadPart(part),`PDF của phần “${part.title}”`),indices=doc.getPageIndices();detachLinks(PDFLib,doc,indices,index=>index);
  const copies=await out.copyPages(doc,indices);total+=copies.length-(part.pages?.length||0);attachLinks(PDFLib,out.context,copies,index=>copies[index]);
  if(anyLabels)labels.push([offset,null]);for(const page of copies){out.addPage(page);placed.push(Infinity);onProgress(++done,total);}offset+=copies.length;
  plan.warnings.push(`Phần “${part.title}” không rõ tệp gốc nên được đặt ở cuối sách.`);
 }
 writeOutline(PDFLib,out,outline);
 // Page numbers restart in every file of a book, so a file without labels of its own counts 1, 2, 3… from its first page.
 if(anyLabels){const {PDFName,PDFNumber}=PDFLib;out.catalog.set(PDFName.of('PageLabels'),out.context.obj({Nums:labels.flatMap(([index,dict])=>[PDFNumber.of(index),dict||out.context.obj({S:'D'})])}));}
 out.setTitle(title,{showInWindowTitleBar:true});out.setLanguage('vi');out.setCreator('Hoa Trí');out.setProducer('Hoa Trí');
 return {bytes:await out.save({useObjectStreams:true}),plan,pages:out.getPageCount()};
}

// Without the originals: the translated parts one after another, behind the book cover when it has one.
export async function concatenateParts({PDFLib,title,parts,loadPart,cover=null,onProgress=()=>{}}){
 const out=await PDFLib.PDFDocument.create();let size=null;
 for(const [index,part] of parts.entries()){
  onProgress(index+1,parts.length);
  const doc=await loadPdfLib(PDFLib,await loadPart(part),`PDF của phần ${index+1} “${part.title}”`),indices=doc.getPageIndices();detachLinks(PDFLib,doc,indices,page=>page);
  const copies=await out.copyPages(doc,indices);attachLinks(PDFLib,out.context,copies,page=>copies[page]);
  for(const page of copies){size??=page.getSize();out.addPage(page);}
 }
 if(cover){
  const image=cover.type==='image/png'?await out.embedPng(cover.bytes):await out.embedJpg(cover.bytes),{width,height}=size||{width:595.28,height:841.89},scale=Math.min(width/image.width,height/image.height);
  out.insertPage(0,[width,height]).drawImage(image,{x:(width-image.width*scale)/2,y:(height-image.height*scale)/2,width:image.width*scale,height:image.height*scale});
 }
 out.setTitle(title,{showInWindowTitleBar:true});out.setLanguage('vi');out.setCreator('Hoa Trí');out.setProducer('Hoa Trí');
 return {bytes:await out.save({useObjectStreams:true}),pages:out.getPageCount()};
}
