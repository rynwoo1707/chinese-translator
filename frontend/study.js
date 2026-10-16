import {parseStudyGlossary} from './study-glossary.js';
import {parseStudyPageRange} from './study-pages.js';
import {evaluateStudyTranslation} from './study-evaluation.js';
import {shouldUseGeminiOcr} from './ocr-policy.js';
import {runStudyTranslation} from './study-flow.js';
import {createTranslationPlan,joinedPageText,textOutsideFigures} from './document-layout.js';
import {originalPageView,partTitle,buildStudyHtml,translationContentHtml,figuresForPart,readingStyles} from './study-layout-view.js';
import {extractPageFigures} from './document-figures.js';
import {blockBatches,ocrImageBatches,validateBlockTranslations} from './pdf-box-layout.js';
import {PdfDualViewer} from './pdf-dual-viewer.js';
import {excludeCover,detectCoverInFile,pageJpeg} from './cover-detect.js';
const $=selector=>document.querySelector(selector);
const readingStyle=document.createElement('style');readingStyle.textContent=readingStyles;document.head.append(readingStyle);
let sessionKey='',selectedFile=null,pdfAnalysis=null,running=false,starting=false,stopRequested=false;
let usage={prompt:0,output:0,total:0,requests:0},translationParts=[];
let preparedPages=new Map(),pageImages=new Map(),translationState=null,preparedRangeKey=null;
let ocrWarnings=[];
let selectionVersion=0;
let selectionTask=Promise.resolve();
let historyItems=[],activeHistoryId='',activeHistoryMeta={},historySave=Promise.resolve(),historyWarningShown=false;
let pdfLayoutDocument=null,pdfLayoutRange='',pdfExportUrl='',layoutConfig={configured:false};
// A finished range becomes one part of a private book. bookTarget survives resetHistoryIdentity(), so a new range or a
// refreshed copy of the same file keeps going into the book the student chose.
let studyBooks=[],bookTarget={id:'',replaceChapterId:''},bookChoiceTouched=false,selectedHash=Promise.resolve(''),selectedSha256='',selectedTotalPages=0;
// The picked PDF's cover stays original artwork: ranges skip it unless its text is translated, and it becomes the book's
// cover image. page 0 = no cover; source = who decided it: the detector, the book (remembered for this file) or the student.
let cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:0,note:'',detecting:false},autoRange='';
let modelCatalogFingerprint='',modelCatalogPurpose='',checkedModelMode='';
async function ensureStudyModel(purpose='text'){
 const apiKey=key(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(apiKey)),fingerprint=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join(''),mode=$('#mode').value;
 if(modelCatalogFingerprint===fingerprint&&modelCatalogPurpose===purpose&&checkedModelMode===mode&&$('#gemini-model').value)return $('#gemini-model').value;
 $('#gemini-model-status').textContent='Đang kiểm tra model khả dụng với khóa trong tab…';
 const result=await api('models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey,purpose,mode})}),select=$('#gemini-model');select.replaceChildren();
 for(const model of result.models||[]){const option=document.createElement('option');option.value=model.id;option.textContent=model.id;select.append(option);}select.disabled=running||!(result.models?.length);
 modelCatalogFingerprint=fingerprint;modelCatalogPurpose=purpose;checkedModelMode=mode;
 if(!result.selected){select.value='';$('#gemini-model-status').textContent='Không có model phù hợp với chế độ hiện tại. Hãy chọn model trong danh sách để tiếp tục.';throw new Error('Khóa này chưa có model phù hợp cho chế độ dịch. Hãy chọn model khả dụng trong danh sách.');}
 select.value=result.selected;
 $('#gemini-model-status').textContent=result.selected===result.requested?`Đang dùng ${result.selected}.`:`Model cấu hình ${result.requested} không khả dụng; đang dùng ${result.selected}.`;return result.selected;
}
const dualViewer=new PdfDualViewer($('#pdf-dual-viewer'));
dualViewer.onEdit=async(id,translation)=>{
 if(running)return;busy(true);try{const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),index=blocks.findIndex(b=>b.id===id);validateBlockTranslations([blocks[index]],[{id,translation}]);translationParts[index]=translation.normalize('NFC');pdfExportUrl='';translationState.pdfLayout.exported=false;syncPdfText();await dualViewer.invalidatePdf();await dualViewer.update(pdfTranslations());if(!await saveHistory())throw new Error('Chưa lưu được đoạn đã sửa. Hãy thử lại.');$('#download-pdf').disabled=translationState.done!==blocks.length;status('Đã lưu đoạn sửa. Bấm Xuất PDF tiếng Việt để dàn trang lại.');}catch(error){fail(error);}finally{busy(false);}
};
const layoutConfiguration=api('pdf-layout/config').then(async config=>{layoutConfig=config;$('#pdf-layout-enabled').checked=Boolean(config.configured);if(config.configured){const font=await api('pdf-layout/font');const style=document.createElement('style');style.textContent=font.css;document.head.append(style);}$('#pdf-layout-service-status').textContent=config.configured?'Dịch theo từng block; giữ hình gốc, công thức và vị trí.':'Dịch vụ PDF giữ bố cục chưa được cấu hình.';}).catch(()=>{layoutConfig={configured:false};$('#pdf-layout-enabled').checked=false;$('#pdf-layout-service-status').textContent='Dịch vụ PDF giữ bố cục chưa sẵn sàng.';});
const PDF_MAX_BYTES=250*1024*1024,OTHER_MAX_BYTES=25*1024*1024;
const MATH_GLOSSARY=`空间向量与立体几何 = Hình học vectơ và hình học không gian
空间向量 = vectơ trong không gian
立体几何 = hình học không gian
空间直角坐标系 = hệ tọa độ Oxyz trong không gian
平面方程 = phương trình mặt phẳng
直线方程 = phương trình đường thẳng
两平面夹角 = góc giữa hai mặt phẳng
距离 = khoảng cách
圆锥曲线 = đường conic
椭圆 = elip
双曲线 = hyperbol
抛物线 = parabol
数列 = dãy số
等差数列 = cấp số cộng
等比数列 = cấp số nhân`;

function status(message,type=''){$('#progress').textContent=message;$('#progress').className=type;}
// Error text from services is bounded upstream; this cap keeps the progress box readable whatever arrives.
function fail(error){const message=String(error?.message||error).trim();status(message.length>500?`${message.slice(0,499)}…`:message,'error');}
function workflow(step){document.querySelectorAll('.workflow li').forEach((item,index)=>{item.classList.toggle('active',index===step-1);item.classList.toggle('done',index<step-1);});}
async function api(path,options={}){
 const failed=(message,status,data=null)=>Object.assign(new Error(message),{status,data});
 const response=await fetch('/api/my/study/'+path,{credentials:'same-origin',...options}).catch(()=>{throw failed('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.',0);});
 const data=await response.json().catch(()=>null);
 if(response.status===401)throw failed('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.',401);
 // A page instead of JSON usually means the server is restarting or being updated, not that the request was wrong.
 if(!data||typeof data!=='object')throw failed(`Máy chủ trả về phản hồi không đọc được (mã ${response.status}). Có thể máy chủ đang khởi động lại hoặc cập nhật; hãy thử lại sau vài giây.`,response.status);
 if(!response.ok)throw failed(data.error||'Không thể xử lý yêu cầu.',response.status,data);
 return data;
}
function resetHistoryIdentity(){activeHistoryId='';activeHistoryMeta={};historyWarningShown=false;renderHistory();}
function historyTitle(){
 const entered=$('#content-title').value.trim().normalize('NFC');if(entered)return entered;
 if(activeHistoryMeta.title)return activeHistoryMeta.title;
 const filename=selectedFile?.name||activeHistoryMeta.filename||'';
 if(filename)return filename.replace(/\.[^.]+$/u,'').trim();
 return `Bản dịch ${new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date())}`;
}
function requireContentTitle(){
 const input=$('#content-title'),title=input.value.trim().normalize('NFC');
 if(!title||title.length>200||/[\u0000-\u001f\u007f]/u.test(title)){
  const message=!title?'Hãy nhập tên nội dung trước khi dịch.':'Tên nội dung tối đa 200 ký tự và không chứa ký tự xuống dòng.';
  input.setCustomValidity(message);input.setAttribute('aria-invalid','true');input.reportValidity();input.focus();throw new Error(message);
 }
 input.value=title;input.setCustomValidity('');input.removeAttribute('aria-invalid');return title;
}
function downloadFilename(extension){return (historyTitle().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'-').replace(/[.\s]+$/u,'').slice(0,150)||'Hoa Trí')+`.vi.${extension}`;}
function updateTitleControls(){
 const input=$('#content-title'),button=$('#save-title');button.hidden=!activeHistoryId;button.disabled=running||!input.value.trim()||input.value.trim().normalize('NFC')===activeHistoryMeta.title;
}
async function renameHistory(){
 if(running||!activeHistoryId)return;const title=requireContentTitle();if(title===activeHistoryMeta.title)return;
 busy(true);try{
  await historySave.catch(()=>{});const saved=await api(`history/${encodeURIComponent(activeHistoryId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});activeHistoryMeta.title=title;
  const item=historyItems.find(item=>item.id===activeHistoryId);if(item){item.title=title;item.updated_at=saved.updatedAt;}
  renderHistory();$('#content-title-hint').textContent='Đã lưu tên trong lịch sử và Thư viện riêng.';
 }finally{busy(false);}
}
function historyDate(value){
 // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix.
 const text=String(value||''),date=new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)?text.replace(' ','T')+'Z':text);
 return Number.isNaN(date.getTime())?null:date;
}
function historyPayload(){
 if(!translationState?.source)return null;
 // Browser-read PDFs have no manifest, so their page range travels with the save; layout PDFs take it from the manifest.
 const pages=translationState.pdfLayout?[]:(translationState.plan||[]).flatMap(part=>part.pages||[]),pageRange=pages.length&&pdfAnalysis?{start:Math.min(...pages),end:Math.max(...pages),total:pdfAnalysis.totalPages}:null;
 return {title:historyTitle(),filename:selectedFile?.name||activeHistoryMeta.filename||'',domain:translationState.domain||$('#domain').value,mode:translationState.mode||$('#mode').value,bookId:bookTarget.id||'',...(bookTarget.replaceChapterId?{replaceChapterId:bookTarget.replaceChapterId}:{}),...(selectedSha256?{sha256:selectedSha256}:{}),...(pageRange?{pageRange}:{}),state:{source:translationState.source,parts:translationState.parts,translationParts,done:translationState.done,context:translationState.context,glossary:translationState.glossary,manualGlossary:translationState.manualGlossary,previousSource:translationState.previousSource,previousTranslation:translationState.previousTranslation,...(translationState.pdfLayout?{pdfLayout:translationState.pdfLayout}:{})}};
}
function historyStatus(item){
 if(item.status==='complete')return `Hoàn tất · ${item.total_parts} phần`;
 if(item.status==='translating')return `${item.translated_parts}/${item.total_parts} phần`;
 return 'Đã lưu nguyên tác';
}
function renderHistory(){
 updateTitleControls();
 const section=$('#study-history'),root=$('#study-history-list');if(!section||!root)return;
 section.hidden=false;root.replaceChildren();$('#study-history-count').textContent=historyItems.length?`· ${historyItems.length} bản đã lưu`:'· chưa có';
 if(!historyItems.length){const empty=document.createElement('p');empty.className='history-empty';empty.textContent='Chưa có bản dịch nào được lưu trong tài khoản này.';root.append(empty);return;}
 for(const item of historyItems){
  const card=document.createElement('article'),open=document.createElement('button'),title=document.createElement('strong'),progress=document.createElement('span'),date=document.createElement('time');
  card.className='history-card'+(item.id===activeHistoryId?' is-active':'');open.type='button';open.className='history-card-main';open.dataset.historyOpen=item.id;open.disabled=running;
  title.textContent=item.title||'Bản dịch chưa đặt tên';title.title=title.textContent;open.append(title);
  if(item.filename){const filename=document.createElement('small');filename.className='history-source';filename.textContent=item.filename;filename.title=item.filename;open.append(filename);}
  progress.textContent=historyStatus(item);const updated=historyDate(item.updated_at);date.textContent=updated?'Cập nhật '+new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(updated):'Ngày cập nhật chưa xác định';if(updated)date.dateTime=updated.toISOString();open.append(progress,date);
  const book=studyBooks.find(entry=>entry.id===item.library_story_id),part=book?book.parts.findIndex(entry=>entry.id===item.library_chapter_id):-1;
  if(book&&book.parts.length>1&&part>=0){const tag=document.createElement('small');tag.className='history-book';tag.textContent=`Sách “${book.title}” · phần ${part+1}/${book.parts.length}`;tag.title=tag.textContent;open.append(tag);}
  card.append(open);
  const actions=document.createElement('div');actions.className='history-actions';
  if(item.library_chapter_id||item.status==='complete'&&item.library_story_id){const link=document.createElement('a');link.className='history-library';link.href='/#account';link.textContent='Thư viện riêng';actions.append(link);}
  if(item.status==='complete'&&item.library_chapter_id&&studyBooks.some(entry=>entry.id!==item.library_story_id)){const merge=document.createElement('button');merge.type='button';merge.className='history-merge';merge.dataset.historyMerge=item.id;merge.disabled=running;merge.textContent='Gộp vào sách…';actions.append(merge);}
  if(actions.children.length)card.append(actions);
  root.append(card);
 }
}
async function loadHistory(){const [rows,books]=await Promise.all([api('history'),api('books').catch(()=>studyBooks)]);historyItems=Array.isArray(rows)?rows:[];setStudyBooks(books);}
async function loadBooks(){setStudyBooks(await api('books'));}
function setStudyBooks(rows){
 studyBooks=Array.isArray(rows)?rows:[];
 // Books that arrive after the file was picked still preselect, unless the student already chose in the list.
 if(bookChoiceActive()&&!bookChoiceTouched&&!bookTarget.id){const book=matchingBook();if(book)bookTarget={id:book.id,replaceChapterId:''};}
 renderBookTarget();renderStudyBooks();renderHistory();
 if(bookChoiceActive())applyBookCover().then(()=>{renderCover();refreshOfferedRange();}).catch(()=>{});
}
const pageLabel=(start,end)=>start===end?`trang ${start}`:`trang ${start}–${end}`;
const rangeValue=({start,end})=>start===end?String(start):`${start}-${end}`;
// Same rule as the server's placement: the file hash when both sides have one, otherwise file name and page count.
const sameSource=(part,source)=>part.sha256&&source.sha256?part.sha256===source.sha256:Boolean(part.filename)&&part.filename===source.filename&&(part.totalPages||null)===(source.totalPages||null);
const bookChoiceActive=()=>Boolean(selectedFile)&&!$('#pdf-range-options').hidden;
function selectedSource(){return {sha256:selectedSha256,filename:selectedFile?.name||'',totalPages:selectedTotalPages||null};}
function matchingBook(){const source=selectedSource();return selectedFile?studyBooks.find(entry=>entry.parts.some(part=>part.pageStart&&sameSource(part,source))):null;}
// The first page of this file no part covers yet, sized like the furthest range (a run takes at most 20 pages).
function suggestedRange(parts,total){
 const spans=parts.map(part=>[part.pageStart,part.pageEnd||part.pageStart]).sort((a,b)=>a[0]-b[0]);let next=1;
 for(const [start,end] of spans){if(start>next)break;next=Math.max(next,end+1);}
 if(!spans.length||total&&next>total)return null;
 const furthest=spans.reduce((a,b)=>b[1]>a[1]?b:a),size=Math.max(1,Math.min(20,furthest[1]-furthest[0]+1)),gapEnd=(spans.find(([start])=>start>next)?.[0]??Infinity)-1;
 return {start:next,end:Math.min(next+size-1,gapEnd,total||Infinity)};
}
function renderBookTarget(){
 const select=$('#book-target');if(!select)return;
 select.replaceChildren(new Option('Sách mới · đặt theo tên nội dung',''),...studyBooks.map(book=>new Option(`${book.title} · ${book.parts.length} phần`,book.id)));
 select.value=studyBooks.some(book=>book.id===bookTarget.id)?bookTarget.id:'';updateBookHint();
}
function updateBookHint(){
 const select=$('#book-target'),hint=$('#book-target-hint'),next=$('#book-next-range'),replace=$('#book-replace-option');if(!select||!hint)return;
 const book=studyBooks.find(entry=>entry.id===select.value),lines=[];let replaceId='';next.hidden=true;replace.hidden=true;
 if(!book)lines.push('Bản dịch hoàn tất sẽ thành một sách mới trong Thư viện riêng; các phạm vi trang sau có thể thêm tiếp vào sách đó.');
 else{
  const source=selectedSource(),siblings=book.parts.filter(part=>part.pageStart&&sameSource(part,source)),range=$('#page-range').value.trim();
  if(siblings.length){
   lines.push(`Sách đã có ${[...new Set(siblings.map(part=>pageLabel(part.pageStart,part.pageEnd||part.pageStart)))].join(', ')} của tệp này.`);
   // The cover is never "next to translate": it stays original artwork unless the student ticks Dịch chữ trên bìa.
   const suggestion=suggestedRange([...siblings,...coverSpans()],selectedTotalPages);
   if(suggestion){next.dataset.range=rangeValue(suggestion);next.textContent=`Dịch tiếp ${pageLabel(suggestion.start,suggestion.end)}`;next.hidden=range===next.dataset.range;}else lines.push('Đã dịch đủ các trang của tệp này.');
  }else lines.push(`Sách đang có ${book.parts.length} phần; phạm vi này sẽ được thêm vào cuối sách và có thể sắp xếp lại trong Lịch sử dịch.`);
  // Pressing Bắt đầu dịch with the current range continues the open session, so its own part is not a duplicate.
  let effective=null;try{effective=translationRange();}catch{}
  const continuing=Boolean(activeHistoryId)&&effective?.text===pdfLayoutRange,pages=effective?.pages||null;
  const overlaps=pages?siblings.filter(part=>!(continuing&&part.sessionId===activeHistoryId)&&[...pages].some(page=>page>=part.pageStart&&page<=(part.pageEnd||part.pageStart))):[];
  if(overlaps.length===1){
   const [part]=overlaps;replace.hidden=false;$('#book-replace-label').textContent=`Thay phần “${part.title}” bằng bản dịch này thay vì thêm trang trùng`;
   // Replacing is the default only when the new range covers every page of the old part; nothing silently disappears.
   if(replace.dataset.part!==part.id){replace.dataset.part=part.id;$('#book-replace').checked=Array.from({length:(part.pageEnd||part.pageStart)-part.pageStart+1},(_,i)=>part.pageStart+i).every(page=>pages.has(page));}
   if($('#book-replace').checked)replaceId=part.id;else lines.push('Nếu giữ cả hai, sách sẽ có trang lặp lại.');
  }else if(overlaps.length>1)lines.push(`Phạm vi này trùng ${overlaps.length} phần đã có (${overlaps.map(part=>part.title).join(', ')}); sách sẽ có trang lặp lại. Hãy chọn phạm vi khác nếu không muốn trùng.`);
 }
 if(replace.hidden)delete replace.dataset.part;
 hint.textContent=lines.join(' ');
 if(bookChoiceActive())bookTarget={id:book?.id||'',replaceChapterId:replaceId};
}
// A file whose ranges already sit in a book preselects that book and, for layout PDFs, the next untranslated pages.
async function prepareBookTarget(version,{suggest=false}={}){
 renderBookTarget();
 const sha256=await selectedHash;if(version!==selectionVersion)return;selectedSha256=sha256;
 const source=selectedSource(),book=bookChoiceTouched?null:matchingBook();
 if(book){
  $('#book-target').value=book.id;delete $('#book-replace-option').dataset.part;
  const suggestion=suggestedRange([...book.parts.filter(part=>part.pageStart&&sameSource(part,source)),...coverSpans()],selectedTotalPages);
  if(suggest&&suggestion&&$('#page-range').value===autoRange){autoRange=$('#page-range').value=rangeValue(suggestion);setFileStatus(`${selectedTotalPages} trang · sách “${book.title}” đã có các phần trước; đã chọn sẵn ${pageLabel(suggestion.start,suggestion.end)} để dịch tiếp.`);}
 }
 await applyBookCover(version);updateBookHint();renderCover();
}

// ---- Cover of the picked PDF ----
const coverExcluded=()=>cover.page>0&&!$('#cover-translate').checked;
const coverSpans=()=>coverExcluded()?[{pageStart:cover.page,pageEnd:cover.page}]:[];
// The pages actually sent for translation. A session reopened from history has no picked file; its field is used as typed.
function translationRange(){
 const value=$('#page-range').value.trim();if(!selectedFile||!selectedTotalPages)return {text:value,pages:null,excluded:false};
 return excludeCover(value,selectedTotalPages,cover.page,{translateCover:$('#cover-translate').checked});
}
function setCoverImage(blob){if(cover.url)URL.revokeObjectURL(cover.url);cover.jpeg=blob||null;cover.url=blob?URL.createObjectURL(blob):'';}
function resetCover(){setCoverImage(null);cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:cover.task+1,note:'',detecting:false};$('#cover-translate').checked=false;renderCover();}
function renderCover(){
 const root=$('#cover-choice');if(!root)return;root.hidden=!/\.pdf$/iu.test(selectedFile?.name||'');if(root.hidden)return;const detecting=cover.detecting&&!cover.page;
 const thumb=$('#cover-thumb');thumb.hidden=!(cover.page&&cover.url);if(!thumb.hidden){thumb.src=cover.url;thumb.alt=`Trang bìa · trang ${cover.page} của tệp`;}
 $('#cover-label').textContent=detecting?'Đang tìm trang bìa…':cover.page?`Bìa: trang ${cover.page}`:['student','book'].includes(cover.source)?'Không dùng bìa':'Không thấy trang bìa';
 $('#cover-change').textContent=cover.page?'Đổi':'Chọn trang bìa';$('#cover-change-group').hidden=detecting;$('#cover-none-group').hidden=detecting||!cover.page;$('#cover-translate-option').hidden=detecting||!cover.page;
 // Without a cover there is nothing to translate on it; a tick left from before must not apply to a cover chosen later.
 if(!cover.page)$('#cover-translate').checked=false;
 let note=cover.note;
 // A range holding only the cover is explained here at once; other range mistakes are reported on Bắt đầu dịch, as before.
 if(!note&&cover.page){try{const range=translationRange();note=range.excluded?`Trang bìa giữ nguyên ảnh gốc; chỉ dịch trang ${range.text}.`:$('#cover-translate').checked?'Chữ trên bìa sẽ được dịch cùng các trang khác.':'Trang bìa giữ nguyên ảnh gốc và là ảnh bìa sách trong Thư viện riêng.';}catch(error){if(/là bìa/u.test(error.message))note=error.message;}}
 $('#cover-note').textContent=note||'';
}
// Detection reads only page 1 (page 2 after a blank flyleaf) on this device; a failure just leaves the file without a cover.
async function detectSelectedCover(file,version){
 const task=++cover.task;cover.detecting=true;renderCover();
 try{
  const result=await detectCoverInFile(file);if(version!==selectionVersion||task!==cover.task)return;
  cover.detected=result.page;cover.detectedJpeg=result.jpeg;
  if(!cover.source||cover.source==='detected'){cover.source='detected';cover.page=result.page;setCoverImage(result.jpeg);}
  await applyBookCover(version);
 }catch{if(version===selectionVersion&&task===cover.task&&!cover.source)cover.source='detected';}
 finally{if(version===selectionVersion&&task===cover.task){cover.detecting=false;renderCover();refreshOfferedRange();updateBookHint();}}
}
// A book remembers which page of which file is its cover, or that it has none; picking that file again follows it.
async function applyBookCover(version=selectionVersion){
 if(!selectedFile||cover.source==='student')return;
 const book=studyBooks.find(entry=>entry.id===$('#book-target').value),stored=book?.cover;
 const remembered=Boolean(stored&&stored.page!==null&&stored.sha256&&stored.sha256===selectedSha256&&stored.page<=selectedTotalPages);
 if(!remembered&&cover.source!=='book')return;
 const page=remembered?stored.page:cover.detected,source=remembered?'book':'detected';if(cover.source===source&&cover.page===page)return;
 const image=page===cover.detected?cover.detectedJpeg:page?await pageJpeg(selectedFile,page).catch(()=>null):null;if(version!==selectionVersion)return;
 cover.source=source;cover.page=page;setCoverImage(image);renderCover();
}
// The cover is seldom known before the range is offered; the offer then moves past it, unless the student typed a range.
function skipCover(value){
 const match=String(value).match(/^(\d+)(?:-(\d+))?$/u);if(!match||!coverExcluded())return value;
 const start=Number(match[1]),end=Number(match[2]||match[1]),first=cover.page+1,last=Math.min(selectedTotalPages,first+end-start);
 return cover.page<start||cover.page>end||first>selectedTotalPages?value:first===last?String(first):`${first}-${last}`;
}
function refreshOfferedRange(){
 if(!selectedFile||$('#page-range').value!==autoRange)return;
 const book=$('#pdf-layout-enabled').checked?studyBooks.find(entry=>entry.id===$('#book-target').value):null,siblings=book?book.parts.filter(part=>part.pageStart&&sameSource(part,selectedSource())):[];
 const suggestion=siblings.length?suggestedRange([...siblings,...coverSpans()],selectedTotalPages):null,value=suggestion?rangeValue(suggestion):skipCover(autoRange);
 if(value===autoRange)return;autoRange=$('#page-range').value=value;updateBookHint();renderCover();
 const [start,end=start]=value.split('-').map(Number);setFileStatus(`${selectedTotalPages} trang · đã chọn sẵn ${pageLabel(start,end)}${coverExcluded()?`; trang ${cover.page} là bìa nên giữ nguyên ảnh gốc`:''}. Có thể sửa phạm vi rồi bấm Bắt đầu dịch.`);
}
function openCoverDialog(){
 if(running||!selectedFile)return;const file=selectedFile,version=selectionVersion,total=selectedTotalPages,book=studyBooks.find(entry=>entry.id===$('#book-target').value);let preview=null,timer=0;
 openBookDialog('Chọn trang bìa',body=>{
  const label=document.createElement('label'),input=document.createElement('input'),figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption'),note=document.createElement('p');
  label.htmlFor='cover-page-input';label.textContent=`Trang bìa trong tệp PDF (1–${total})`;Object.assign(input,{id:'cover-page-input',type:'number',inputMode:'numeric',min:'1',max:String(total),value:String(cover.page||cover.detected||1)});
  figure.className='cover-preview';image.alt='';caption.textContent='Đang tải trang…';figure.append(image,caption);
  note.className='hint';note.textContent='Trang bìa được giữ nguyên ảnh gốc khi ghép sách và dùng làm ảnh bìa trong Thư viện riêng.';
  const show=()=>{clearTimeout(timer);timer=setTimeout(async()=>{
   const page=Number(input.value);if(!Number.isInteger(page)||page<1||page>total){caption.textContent=`Hãy nhập số từ 1 đến ${total}.`;return;}caption.textContent='Đang tải trang…';
   try{const blob=await pageJpeg(file,page);if(Number(input.value)!==page)return;preview={page,blob};if(image.src)URL.revokeObjectURL(image.src);image.src=URL.createObjectURL(blob);image.alt=`Trang ${page} của tệp`;caption.textContent=`Trang ${page}`;}catch(error){caption.textContent=error.message;}
  },250);};
  input.addEventListener('input',show);show();body.append(label,input,figure,note);
  $('#book-dialog').addEventListener('close',()=>{clearTimeout(timer);if(image.src)URL.revokeObjectURL(image.src);},{once:true});
  // Replacing a cover the book already has is the student's explicit choice, never a side effect.
  if(book?.cover?.image){const replace=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');replace.className='book-replace';Object.assign(box,{type:'checkbox',id:'cover-replace'});text.textContent=`Thay ảnh bìa hiện tại của sách “${book.title}” bằng trang này`;replace.append(box,text);body.append(replace);}
 },async()=>{
  const page=Number($('#cover-page-input').value);if(!Number.isInteger(page)||page<1||page>total)throw new Error(`Hãy nhập số trang từ 1 đến ${total}.`);
  if(version!==selectionVersion)throw new Error('Tệp đã thay đổi. Hãy mở lại hộp chọn bìa.');
  const blob=preview?.page===page?preview.blob:await pageJpeg(file,page);
  Object.assign(cover,{page,source:'student',replace:Boolean($('#cover-replace')?.checked),synced:'',note:''});setCoverImage(blob);coverChanged();
 },'Dùng trang này');
}
function coverChanged(){renderCover();refreshOfferedRange();updateBookHint();const storyId=historyItems.find(item=>item.id===activeHistoryId)?.library_story_id;if(storyId)syncBookCover(storyId);}
// Runs after a save that put this range in a book: a new book gets the cover image; a book with a cover keeps it (the
// server refuses to replace one unless the student confirmed), and the page choice is remembered for this file.
async function syncBookCover(storyId){
 if(!storyId||!selectedFile||!cover.source)return;
 const key=`${storyId}:${cover.page}:${cover.replace}`;if(cover.synced===key||cover.page===0&&cover.source!=='student')return;cover.synced=key;
 // A cover this book already remembers for this file, with its image in place, needs nothing more.
 if(cover.source==='book'&&studyBooks.find(book=>book.id===storyId)?.cover?.image)return;
 const remember=()=>api(`books/${encodeURIComponent(storyId)}/cover`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:cover.page,...(selectedSha256?{sha256:selectedSha256}:{})})});
 try{
  if(cover.page&&cover.jpeg){
   const form=new FormData();form.set('cover',cover.jpeg,'bia.jpg');form.set('page',String(cover.page));if(selectedSha256)form.set('sha256',selectedSha256);if(cover.replace)form.set('replace','1');
   try{await api(`books/${encodeURIComponent(storyId)}/cover`,{method:'POST',body:form});cover.note=`Đã đặt trang ${cover.page} làm ảnh bìa sách.`;}
   catch(error){if(error.status!==409)throw error;await remember();cover.note='Sách đã có ảnh bìa nên giữ nguyên ảnh hiện tại; bấm Đổi nếu muốn thay.';}
  }else if(selectedSha256||!cover.page)await remember();
  renderCover();loadBooks().catch(()=>{});
 }catch(error){cover.synced='';$('#warnings').textContent+=`Chưa lưu được ảnh bìa sách: ${error.message}\n`;}
}
function renderStudyBooks(){
 const section=$('#study-books'),root=$('#study-books-list');if(!section||!root)return;
 const books=studyBooks.filter(book=>book.parts.length>1);section.hidden=!books.length;root.replaceChildren();
 for(const book of books){
  const row=document.createElement('article'),text=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('small'),actions=document.createElement('div'),order=document.createElement('button'),read=document.createElement('a');
  row.className='study-book';title.textContent=book.title;meta.textContent=`${book.parts.length} phần · ${book.parts.map(part=>part.title).join(' · ')}`;text.append(title,meta);
  order.type='button';order.dataset.bookOrder=book.id;order.disabled=running;order.textContent='Sắp xếp phần';read.href=`/?read=${encodeURIComponent(book.id)}`;read.textContent='Đọc sách';
  actions.className='study-book-actions';actions.append(order,read);row.append(text,actions);root.append(row);
 }
}
let dialogSubmit=null;
function openBookDialog(title,build,submit,label){
 const dialog=$('#book-dialog');$('#book-dialog-title').textContent=title;$('#book-dialog-body').replaceChildren();build($('#book-dialog-body'));$('#book-dialog-status').textContent='';$('#book-dialog-submit').textContent=label;$('#book-dialog-submit').disabled=false;dialogSubmit=submit;
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
 // Start on the heading: focusing the first field would open the keyboard on a phone before the student reads the dialog.
 $('#book-dialog-title').focus();
}
function closeBookDialog(){const dialog=$('#book-dialog');dialogSubmit=null;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
function openMergeDialog(id){
 const item=historyItems.find(entry=>entry.id===id);if(!item||running)return;
 const targets=studyBooks.filter(book=>book.id!==item.library_story_id),current=studyBooks.find(book=>book.id===item.library_story_id);if(!targets.length){status('Chưa có sách nào khác để gộp.');return;}
 openBookDialog(`Gộp “${item.title}” vào sách`,body=>{
  const label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('p');
  label.htmlFor='book-merge-target';label.textContent='Sách nhận phần này';select.id='book-merge-target';select.append(...targets.map(book=>new Option(`${book.title} · ${book.parts.length} phần`,book.id)));
  const overlap=document.createElement('p'),source={sha256:item.source_sha256||'',filename:item.filename||'',totalPages:item.source_total_pages||null};
  note.className='hint';note.textContent=`Phần này được xếp theo số trang trong sách đã chọn. ${current?.parts.length===1?'Mục sách riêng chỉ có phần này sẽ được gỡ khỏi Thư viện riêng; bản dịch, PDF và lịch sử vẫn giữ nguyên.':'Bản dịch, PDF và lịch sử vẫn giữ nguyên.'}`;overlap.className='hint book-overlap';
  // Ranges recorded before books existed have no pages yet; the server reads them back from the manifest when moving.
  const warn=()=>{const book=targets.find(entry=>entry.id===select.value),same=item.page_start?(book?.parts||[]).filter(part=>part.pageStart&&sameSource(part,source)&&part.pageStart<=(item.page_end||item.page_start)&&(part.pageEnd||part.pageStart)>=item.page_start):[];overlap.textContent=same.length?`Sách này đã có ${same.map(part=>`“${part.title}”`).join(', ')} trùng ${pageLabel(item.page_start,item.page_end||item.page_start)} của cùng tệp; sau khi gộp, sách sẽ có trang lặp lại.`:'';};
  select.addEventListener('change',warn);warn();body.append(label,select,note,overlap);
 },async()=>{
  const bookId=$('#book-merge-target').value,book=studyBooks.find(entry=>entry.id===bookId);
  await api(`history/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookId})});
  if(id===activeHistoryId)bookTarget={id:bookId,replaceChapterId:''};
  await loadHistory();status(`Đã gộp “${item.title}” vào sách “${book?.title||''}”. Bấm Sắp xếp phần nếu thứ tự chưa đúng.`);
 },'Gộp vào sách');
}
function openOrderDialog(bookId){
 const book=studyBooks.find(entry=>entry.id===bookId);if(!book||running)return;const order=book.parts.slice();
 openBookDialog('Sắp xếp các phần của sách',body=>{
  const label=document.createElement('label'),input=document.createElement('input'),note=document.createElement('p'),list=document.createElement('ol');
  label.htmlFor='book-order-title';label.textContent='Tên sách';input.id='book-order-title';input.type='text';input.maxLength=200;input.required=true;input.autocomplete='off';input.value=book.title;
  note.className='hint';note.textContent='Số trang được đếm theo từng tệp đã tải lên. Nếu sách ghép từ nhiều tệp, hãy kiểm tra thứ tự ở đây.';list.className='book-order';
  // Focus follows the moved part so keyboard and screen-reader users can keep moving it.
  const move=(index,step)=>{[order[index],order[index+step]]=[order[index+step],order[index]];draw();const buttons=[...list.children[index+step].querySelectorAll('button')];(buttons.find(button=>button.dataset.step===String(step)&&!button.disabled)||buttons.find(button=>!button.disabled))?.focus();};
  const draw=()=>list.replaceChildren(...order.map((part,index)=>{
   const item=document.createElement('li'),name=document.createElement('span'),title=document.createElement('strong'),source=document.createElement('small'),up=document.createElement('button'),down=document.createElement('button');
   title.textContent=part.title;source.textContent=[part.pageStart?pageLabel(part.pageStart,part.pageEnd||part.pageStart):'',part.filename].filter(Boolean).join(' · ');name.append(title,source);
   for(const [button,step,glyph,verb] of [[up,-1,'↑','lên'],[down,1,'↓','xuống']]){button.type='button';button.dataset.step=String(step);button.textContent=glyph;button.setAttribute('aria-label',`Chuyển “${part.title}” ${verb}`);button.disabled=index+step<0||index+step>=order.length;button.addEventListener('click',()=>move(index,step));}
   item.append(name,up,down);return item;
  }));
  draw();body.append(label,input,note,list);
 },async()=>{
  const title=$('#book-order-title').value.trim().normalize('NFC');if(!title)throw new Error('Hãy nhập tên sách.');
  await api(`books/${encodeURIComponent(bookId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,order:order.map(part=>part.id)})});
  await loadBooks();status(`Đã lưu thứ tự ${order.length} phần của sách “${title}”.`);
 },'Lưu thứ tự');
}
function currentHistoryRecord(saved,payload){
 return {id:saved.id,title:payload.title,filename:payload.filename,domain:payload.domain,mode:payload.mode,status:saved.status,translated_parts:payload.state.done,total_parts:payload.state.parts.length,source_characters:payload.state.source.length,translation_characters:translationParts.join('\n\n').length,library_story_id:saved.libraryStoryId||null,library_chapter_id:saved.libraryChapterId||null,updated_at:saved.updatedAt};
}
async function persistHistory(){
 const payload=historyPayload();if(!payload)return null;
 const path=activeHistoryId?`history/${encodeURIComponent(activeHistoryId)}`:'history',method=activeHistoryId?'PUT':'POST',saved=await api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 activeHistoryId=saved.id;activeHistoryMeta={title:payload.title,filename:payload.filename};const record=currentHistoryRecord(saved,payload),index=historyItems.findIndex(item=>item.id===saved.id),prior=index>=0?historyItems[index]:null;if(index>=0)historyItems.splice(index,1);historyItems.unshift(record);renderHistory();
 // A range that just became a book part: later ranges of this file default to the same book.
 if(saved.libraryChapterId&&prior?.library_chapter_id!==saved.libraryChapterId){bookTarget={id:saved.libraryStoryId,replaceChapterId:''};loadBooks().catch(()=>{});}
 // The book exists once the range belongs to it (a draft for a chosen book, a new book on completion): it gets its cover.
 if(saved.libraryStoryId)syncBookCover(saved.libraryStoryId);
 return saved;
}
async function saveHistory(){
 historySave=historySave.catch(()=>{}).then(persistHistory);
 try{return await historySave;}catch(error){if(!historyWarningShown){historyWarningShown=true;$('#warnings').textContent+=`Không thể tự lưu lịch sử: ${error.message}\n`;}return null;}
}
function glossaryText(value){return Object.entries(value||{}).map(([term,translation])=>`${term} = ${translation}`).join('\n');}
async function openHistory(id){
 if(running)return;
 const version=++selectionVersion;busy(true);
 try{
 await dualViewer.clear();pdfLayoutDocument=null;pdfExportUrl='';$('#download-pdf').disabled=true;
 const item=await api(`history/${encodeURIComponent(id)}`),state=item.state||{};if(version!==selectionVersion)return;selectedFile=null;selectedHash=Promise.resolve('');selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';bookTarget={id:item.library_story_id||'',replaceChapterId:''};pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];$('#source').readOnly=false;$('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';
 activeHistoryId=item.id;activeHistoryMeta={title:item.title,filename:item.filename};historyWarningShown=false;$('#content-title').value=item.title||'';$('#content-title').setCustomValidity('');$('#content-title').removeAttribute('aria-invalid');$('#content-title-hint').textContent='Có thể đổi tên rồi bấm Lưu tên; bản dịch đã lưu được giữ nguyên.';$('#source').value=state.source||'';$('#domain').value=item.domain||'general';$('#mode').value=item.mode||'economy';$('#glossary').value=glossaryText(state.manualGlossary);
 const parts=Array.isArray(state.parts)?state.parts:[],plan=parts.map(text=>({text,pages:[],blockIds:{}}));translationParts=Array.isArray(state.translationParts)?state.translationParts.slice(0,parts.length):[];while(translationParts.length<parts.length)translationParts.push('');
 translationState={source:state.source||'',domain:item.domain||'general',mode:item.mode||'economy',parts,plan,done:Math.min(Number(state.done)||0,parts.length),context:state.context||'',glossary:state.glossary||{},manualGlossary:state.manualGlossary||{},previousSource:state.previousSource||'',previousTranslation:state.previousTranslation||''};
 renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});$('#translation').value=translationParts.filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value.trim();$('#download-rich').disabled=true;$('#warnings').textContent='';setFileStatus(item.filename?`${item.filename} · đã mở từ lịch sử tài khoản.`:'Đã mở bản dịch từ lịch sử tài khoản.');updateCount();workflow(translationState.done===parts.length?3:2);status(translationState.done===parts.length?'Bản dịch đã hoàn tất và có trong Thư viện riêng.':`Đã khôi phục ${translationState.done}/${parts.length} phần. Nhập khóa Gemini để tiếp tục.`);renderHistory();$('.workspace').scrollIntoView({behavior:'smooth',block:'start'});
 if(state.pdfLayout){
  translationState.pdfLayout=state.pdfLayout;pdfLayoutDocument=await api(`pdf-layout/assets/${state.pdfLayout.assetId}/manifest`);$('#pdf-layout-enabled').checked=true;clearPartStream();syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());$('#download-pdf').disabled=translationState.done!==parts.length;
  // Exports from an older renderer are rendered again from the saved translations: no Gemini call, no token cost.
  if(state.pdfLayout.exported&&state.pdfLayout.renderVersion>=3){pdfExportUrl=`/api/my/study/pdf-layout/assets/${state.pdfLayout.assetId}/translated`;await dualViewer.setExportedPdf(pdfExportUrl);}
  else if(state.pdfLayout.exported&&translationState.done===parts.length)status('PDF đã xuất dùng cách dàn trang cũ. Bấm Xuất PDF tiếng Việt để dàn trang lại; không cần dịch lại, không tốn token.');
 }
 }finally{busy(false);}
}
function key(){
 const input=$('#api-key'),entered=input.value.trim();
 if(entered){
  if(entered.length<20||entered.length>500||/[\r\n\0]/u.test(entered)){input.setCustomValidity('Khóa Gemini API không hợp lệ.');input.reportValidity();input.focus();throw new Error('Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa.');}
  sessionKey=entered;input.value='';input.setCustomValidity('');input.removeAttribute('aria-invalid');$('#key-status').textContent='Đã nạp khóa Gemini cho phiên này.';workflow(2);
 }
 if(!sessionKey){input.setCustomValidity('Hãy nhập khóa Gemini API trước khi dịch.');input.setAttribute('aria-invalid','true');input.reportValidity();input.focus();throw new Error('Chưa có khóa Gemini. Hãy nhập khóa API riêng cho phiên này rồi bấm Bắt đầu dịch.');}
 return sessionKey;
}
function rejectKey(error){
 if(!/Gemini từ chối|Khóa Gemini/u.test(error?.message||''))return;
 sessionKey='';const input=$('#api-key');input.setAttribute('aria-invalid','true');input.focus();$('#key-status').textContent='Khóa vừa nhập chưa được Gemini chấp nhận.';
}
function addUsage(value){for(const field of ['prompt','output','total','requests'])usage[field]+=(Number(value?.[field])||0);$('#usage-total').textContent=new Intl.NumberFormat('vi-VN').format(usage.total);$('#usage-detail').textContent=`${usage.requests} lượt gọi · ${usage.prompt} token đầu vào · ${usage.output} token đầu ra`;}
function updateCount(){const source=$('#source').value,length=source.length;$('#source-count').textContent=`${new Intl.NumberFormat('vi-VN').format(length)} ký tự`;$('#part-count').textContent=`${length?createTranslationPlan(source,preparedPages).length:0} phần dịch`;}
function segments(text,limit=5000){const pieces=[];let remaining=text;while(remaining.length>limit){let end=remaining.lastIndexOf('\n',limit);if(end<limit/2){end=0;for(const match of remaining.slice(0,limit).matchAll(/[。！？!?；;]\s*/gu))end=match.index+match[0].length;}if(end<limit/2)end=limit;if(/[\uD800-\uDBFF]/u.test(remaining[end-1]))end--;pieces.push(remaining.slice(0,end));remaining=remaining.slice(end);}if(remaining)pieces.push(remaining);return pieces;}
function clearPartStream(){const root=$('#translation-parts');root.replaceChildren();root.hidden=true;}
function renderPartStream(parts){
 const root=$('#translation-parts');root.replaceChildren();root.hidden=!parts.length;
 parts.forEach((part,index)=>{
  const card=document.createElement('details'),summary=document.createElement('summary'),title=document.createElement('span'),state=document.createElement('small'),body=document.createElement('div'),paired=document.createElement('div');
  card.className='translation-part queued';card.dataset.translationPart=String(index);title.textContent=partTitle(part,index);state.dataset.partState='';state.textContent='Chờ xử lý';body.className='translation-part-text';body.textContent='Nội dung sẽ xuất hiện ngay khi phần này dịch xong.';
  const toolbar=document.createElement('div');toolbar.className='part-toolbar';const label=document.createElement('span');label.className='reading-label';label.textContent='BẢN DỊCH TIẾNG VIỆT';toolbar.append(label);
  paired.className='translation-pair';if(part.pages.length){const originals=document.createElement('div');originals.className='part-originals';originals.id=`part-originals-${index}`;for(const number of part.pages){const image=pageImages.get(number);if(image)originals.append(originalPageView(number,image,preparedPages.get(number)));}if(originals.children.length){paired.append(originals);paired.classList.add('has-original');const toggle=document.createElement('button');toggle.type='button';toggle.className='compare-toggle';toggle.textContent='Đối chiếu trang gốc';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',originals.id);toggle.addEventListener('click',()=>{const comparing=paired.classList.toggle('comparing');toggle.setAttribute('aria-expanded',String(comparing));toggle.textContent=comparing?'Ẩn trang gốc':'Đối chiếu trang gốc';});toolbar.append(toggle);}}
  paired.append(body);summary.append(title,state);card.append(summary,toolbar,paired);root.append(card);
 });
}
function updatePart(index,text,state){
 const root=$('#translation-parts'),card=root.querySelector(`[data-translation-part="${index}"]`);if(!card)return;
 card.className=`translation-part ${state}`;const label=card.querySelector('[data-part-state]'),body=card.querySelector('.translation-part-text');
 label.textContent=state==='done'?'Hoàn tất':state==='working'?'Đang dịch…':'Tạm dừng';
 if(text!==undefined){const article=document.createElement('article');article.className='translation-document';article.innerHTML=translationContentHtml(text,figuresForPart(translationState?.plan||[],index,pageImages));body.replaceChildren(article);}
 if(state!=='queued')card.open=true;
}
function technicalPages(text){return String(text).replace(/^\[Trang PDF \d+(?:[–-]\d+)?\]\s*$/gmu,'').replace(/\n{3,}/gu,'\n\n').trim();}
function setFileStatus(text){$('#file-status').textContent=text;}
// Suggests a teacher-published translation of the identical file. Admin uploads are capped at 25 MB, so larger
// files cannot match; any failure is ignored so the student can always translate with their own key.
// One hash per selected file: library-match, the book suggestion and the layout upload reuse it. crypto.subtle is missing
// on plain-HTTP origins (a phone on the LAN), and the server then hashes the upload itself.
function fileSha256(file){
 if(!file||file.size>OTHER_MAX_BYTES||!globalThis.crypto?.subtle)return Promise.resolve('');
 return file.arrayBuffer().then(data=>crypto.subtle.digest('SHA-256',data)).then(digest=>[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')).catch(()=>'');
}
async function showLibraryMatch(version){
 try{
  const sha256=await selectedHash;if(!sha256||version!==selectionVersion)return;
  const {match}=await api(`library-match?sha256=${sha256}`);
  if(!match||version!==selectionVersion)return;
  $('#library-match-title').textContent=`${match.title} · ${match.chapters} phần`;$('#library-match-open').href=`/?read=${encodeURIComponent(match.id)}`;$('#library-match').hidden=false;
 }catch{}
}
function busy(value){running=value||starting;$('#content-title').disabled=running;updateTitleControls();$('#translate').disabled=running;$('#source-file').disabled=running;$('#source').disabled=running;$('#mode').disabled=running;$('#domain').disabled=running;$('#glossary').disabled=running;$('#page-range').disabled=running;$('#pdf-layout-enabled').disabled=running;$('#api-key').disabled=running;$('#clear-key').disabled=running;$('#check-gemini-model').disabled=running;$('#gemini-model').disabled=running||!Array.from($('#gemini-model').options).some(option=>option.value);$('#stop').disabled=!running;$('#book-target').disabled=running;$('#book-replace').disabled=running;$('#book-next-range').disabled=running;$('#cover-change').disabled=running;$('#cover-none').disabled=running;$('#cover-translate').disabled=running;document.querySelectorAll('[data-history-open],[data-history-merge],[data-book-order]').forEach(button=>{button.disabled=running;});}

function optionalKey(){
 if(sessionKey)return sessionKey;
 if($('#api-key').value.trim())return key();
 return '';
}
function releasePageImage(item){if(!item)return;URL.revokeObjectURL(item.url);for(const figure of item.figures||[])URL.revokeObjectURL(figure.url);}
function clearPageImages(){for(const item of pageImages.values())releasePageImage(item);pageImages=new Map();$('#source-figure-grid').replaceChildren();$('#source-figures').hidden=true;$('#download-rich').disabled=true;}
function keepPageImage(page,blob){releasePageImage(pageImages.get(page));pageImages.set(page,{blob,url:URL.createObjectURL(blob),figures:[]});renderPageImages();}
async function keepPageFigures(page,layout){
 const item=pageImages.get(page);if(!item)return [];
 try{const figures=await extractPageFigures(item.blob,layout);if(pageImages.get(page)!==item)return [];for(const figure of item.figures)URL.revokeObjectURL(figure.url);item.figures=figures.map(figure=>({...figure,url:URL.createObjectURL(figure.blob)}));return item.figures;}
 catch{ocrWarnings.push(`Trang ${page}: chưa tách được hình riêng; ảnh trang gốc vẫn có trong Đối chiếu trang gốc.`);}
 return [];
}
function renderPageImages(){
 const root=$('#source-figure-grid');root.replaceChildren();
 for(const [page,item] of [...pageImages].sort((a,b)=>a[0]-b[0])){const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=item.url;img.alt=`Trang gốc ${page}, gồm hình và công thức`;img.loading='lazy';caption.textContent=`Trang ${page}`;figure.append(img,caption);root.append(figure);}
 $('#source-figures').hidden=!pageImages.size;$('#download-rich').disabled=!pageImages.size||!$('#translation').value.trim();
}
async function blobDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
function escapeHtml(value){return String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
async function downloadRichHtml(){
 const title=historyTitle();
 const html=await buildStudyHtml({title,parts:translationState?.plan||[],translations:translationParts,images:pageImages,blobDataUrl,combined:$('#translation').value});
 const blob=new Blob(['\uFEFF'+html],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=downloadFilename('html');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function selected(file){workflow(1);await layoutConfiguration;const isPdf=file?.name.toLowerCase().endsWith('.pdf'),useLayout=isPdf&&$('#pdf-layout-enabled').checked;if(file?.size>(useLayout?OTHER_MAX_BYTES:isPdf?PDF_MAX_BYTES:OTHER_MAX_BYTES))throw new Error(useLayout?'PDF giữ bố cục tối đa 25 MB.':isPdf?'PDF tối đa 250 MB khi xử lý tại trình duyệt.':'Tệp tối đa 25 MB.');const version=++selectionVersion;selectedFile=file;resetHistoryIdentity();bookTarget={id:'',replaceChapterId:''};bookChoiceTouched=false;selectedHash=fileSha256(file);selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';await dualViewer.clear();clearPartStream();$('#source').readOnly=false;$('#source').value='';$('#translation').value='';$('#warnings').textContent='';$('#download').disabled=true;$('#download-pdf').disabled=true;$('#pdf-range-options').hidden=true;$('#page-range').value='';updateCount();$('#library-match').hidden=true;if(!file){setFileStatus('Hoặc dán một đoạn tiếng Trung bên dưới.');return;}showLibraryMatch(version);
 if(useLayout){const {pdfPageCount}=await import('./pdf-client.js');setFileStatus('Đang kiểm tra số trang PDF…');const total=await pdfPageCount(file);if(version!==selectionVersion)return;$('#pdf-range-options').hidden=false;autoRange=$('#page-range').value=`1-${Math.min(3,total)}`;selectedTotalPages=total;setFileStatus(`${total} trang · dịch theo block có tọa độ; chọn phạm vi rồi bấm Bắt đầu dịch.`);prepareBookTarget(version,{suggest:true});detectSelectedCover(file,version);return;}
 if(!isPdf){await prepare();return;}
 setFileStatus('Đang kiểm tra lớp chữ PDF trên trình duyệt…');try{const {analyzePdf}=await import('./pdf-client.js');const analysis=await analyzePdf(file,(page,total)=>{if(version===selectionVersion)setFileStatus(`Đang đọc trang ${page}/${total}…`);});if(version!==selectionVersion)return;pdfAnalysis=analysis;}catch(error){if(version!==selectionVersion)return;selectedFile=null;throw error;}
 $('#pdf-range-options').hidden=false;selectedTotalPages=pdfAnalysis.totalPages;
 const start=pdfAnalysis.mode==='scan'&&pdfAnalysis.totalPages>30?Math.max(1,Math.floor(pdfAnalysis.totalPages/2)-1):1,end=Math.min(pdfAnalysis.totalPages,start+2);
 autoRange=$('#page-range').value=start===end?String(start):`${start}-${end}`;
 if(pdfAnalysis.mode==='text'){$('#source').value=pdfAnalysis.pages.filter(page=>page.number>=start&&page.number<=end).map(page=>page.text).join('\n\n');updateCount();setFileStatus(`${pdfAnalysis.totalPages} trang có lớp chữ · đang chọn ${$('#page-range').value} · không cần OCR. Hình gốc sẽ được giữ khi dịch.`);}
 else setFileStatus(`${pdfAnalysis.pagesWithText} trang có lớp chữ · ${pdfAnalysis.scanPages} trang scan. Đang chọn ${$('#page-range').value}; bấm Bắt đầu dịch để tự OCR và dịch.`);
 prepareBookTarget(version);detectSelectedCover(file,version);
}
async function geminiOcr(blob,page){
 const form=new FormData();form.set('apiKey',key());form.set('model',await ensureStudyModel('text'));form.set('image',blob,`page-${page}.${blob.type==='image/webp'?'webp':'jpg'}`);
 const result=await api('ocr',{method:'POST',body:form});addUsage(result.usage);
 if(result.warnings?.length)ocrWarnings.push(...result.warnings.map(warning=>`OCR trang ${page}: ${warning}`));
 return result.text;
}
async function prepare(){if(!selectedFile)return false;busy(true);let localOcr=null;try{
  if(!selectedFile.name.toLowerCase().endsWith('.pdf')){const form=new FormData();form.set('file',selectedFile);const result=await api('extract',{method:'POST',body:form});$('#source').value=result.text;setFileStatus(`${selectedFile.name} · đã trích xuất, không gọi Gemini.`);}
  else{
   if(!pdfAnalysis)throw new Error('Hãy đợi phân tích PDF hoàn tất.');
   const selectedPages=translationRange().pages;
   for(const page of preparedPages.keys())if(!selectedPages.has(page)){preparedPages.delete(page);releasePageImage(pageImages.get(page));pageImages.delete(page);}
   const {uploadPreparedPdf}=await import('./pdf-client.js');
   await uploadPreparedPdf(selectedFile,pdfAnalysis,async(item,page,total)=>{
    // Pages still flagged needsGemini (weak local OCR, no key yet at the time) are retried once a key
    // becomes available; everything else (text layer, confident local OCR, already-Gemini pages) is kept.
    const existing=preparedPages.get(page);if(existing&&!existing.needsGemini)return;if(stopRequested)throw new Error('Đã dừng sau trang hiện tại.');
    keepPageImage(page,item.previewBlob);
    if(item.kind==='text'){preparedPages.set(page,{text:item.text,layout:item.layout,engine:'pdf-text',needsGemini:false});await keepPageFigures(page,item.layout);return;}
    if(!localOcr)localOcr=await import('./local-ocr.js');
    status(`Đang OCR cục bộ trang ${page}/${total} · không tốn token…`);
    const assessment=existing?.assessment||await localOcr.recognizeChinesePage(item.blob,message=>{
     if(message.status==='loading model')status('Đang nạp mô hình PaddleOCR lần đầu · không gửi tài liệu ra ngoài…');
     if(message.status==='recognizing text')status(`OCR cục bộ trang ${page}/${total} · 0 token`);
     if(message.status==='fallback')status('PaddleOCR chưa chạy được · chuyển sang Tesseract cục bộ…');
    });
    if(assessment.fallbackReason)ocrWarnings.push(`PaddleOCR chưa sẵn sàng; đã dùng Tesseract cục bộ (${assessment.fallbackReason}).`);
    const fallback=shouldUseGeminiOcr('hybrid',assessment);
    if(fallback&&optionalKey()){
     ocrWarnings.push(`Trang ${page}: OCR cục bộ chỉ đạt ${assessment.confidence}% nên đã dùng Gemini cho riêng trang này.`);
     status(`Trang ${page}/${total} khó đọc · đang chuyển riêng trang này sang Gemini…`);preparedPages.set(page,{text:await geminiOcr(item.blob,page),layout:assessment.layout,engine:'gemini',needsGemini:false,assessment});
    }else{
     preparedPages.set(page,{text:assessment.text,layout:assessment.layout,engine:assessment.engine,confidence:assessment.confidence,metrics:assessment.metrics,assessment,needsGemini:assessment.needsGemini});
     if(assessment.needsGemini)ocrWarnings.push(`Trang ${page}: OCR cục bộ đạt ${assessment.confidence}% và có thể thiếu chữ hoặc công thức${!optionalKey()?' (chưa có khóa để dùng Gemini dự phòng; nhập khóa rồi bấm Bắt đầu dịch lại để thử trang này bằng Gemini)':''}. Hãy đối chiếu ảnh gốc.`);
    }
    const figures=await keepPageFigures(page,assessment.layout),prepared=preparedPages.get(page);
    if(figures.length&&prepared&&['paddle','tesseract'].includes(assessment.engine))prepared.text=textOutsideFigures(assessment.layout,figures);
   },()=>{},selectedPages,{keepTextPreviews:true});
   preparedRangeKey=translationRange().text;
   $('#source').value=joinedPageText(preparedPages);
   $('#warnings').textContent=ocrWarnings.join('\n');renderPageImages();
   const figureCount=[...pageImages.values()].reduce((sum,item)=>sum+item.figures.length,0);
   setFileStatus(`Đã chuẩn bị ${preparedPages.size} trang riêng biệt · ${figureCount} hình được tách từ bản gốc. Có thể mở Đối chiếu trang gốc để xem đầy đủ hình và công thức.`);
  }
  updateCount();status('Đã chuẩn bị nguyên tác.');return Boolean($('#source').value.trim());
 }catch(error){rejectKey(error);fail(error);return false;}finally{if(localOcr)await localOcr.terminateLocalOcr().catch(()=>{});busy(false);stopRequested=false;}}

function hasUsableKey(){return !!(sessionKey||$('#api-key').value.trim());}
function needsPreparation(){
 if(!selectedFile||!selectedFile.name.toLowerCase().endsWith('.pdf'))return false;
 if(!pdfAnalysis)return false;
 let range='';try{range=translationRange().text;}catch{return true;}
 if(preparedRangeKey!==range||!preparedPages.size)return true;
 // A key arriving after a weak local-only OCR pass should trigger one retry of just those pages.
 return hasUsableKey()&&[...preparedPages.values()].some(entry=>entry?.needsGemini);
}
async function run(){
 if(running||starting)return;requireContentTitle();starting=true;busy(true);
 try{
  await layoutConfiguration;
  if($('#pdf-layout-enabled').checked&&(selectedFile?.name.toLowerCase().endsWith('.pdf')||translationState?.pdfLayout)){await selectionTask;return await runPdfLayout({fromRun:true});}
  await ensureStudyModel('text');
  if(selectedFile&&!pdfAnalysis&&selectedFile.name.toLowerCase().endsWith('.pdf'))status('Đang chờ phân tích PDF; hệ thống sẽ tự OCR và dịch ngay sau đó…');
  return await runStudyTranslation({selectionTask,requireKey:key,needsPreparation,hasSource:()=>Boolean($('#source').value.trim()),hasFile:()=>Boolean(selectedFile),prepare,translate});
 }finally{starting=false;busy(false);}
}

function pdfTranslations(){const blocks=pdfLayoutDocument?.pages.flatMap(p=>p.blocks)||[];return blocks.map((b,i)=>({id:b.id,translation:translationParts[i]||''})).filter(b=>b.translation.trim());}
function needsPdfLayoutRefresh(){return pdfLayoutDocument&&pdfLayoutDocument.pages.some(p=>p.ocr)&&((pdfLayoutDocument.extractionVersion||0)<2||!pdfLayoutDocument.ocrCorrectedVersion);}
// OCR that stopped part-way (Gemini error, closed tab) resumes on the same asset: the server keeps every finished
// batch, so re-extracting would pay for those images again. A draft whose OCR never started still refreshes.
function pdfOcrResumable(){
 const pending=pdfLayoutDocument?.pages.filter(p=>p.ocr).flatMap(p=>p.blocks).filter(b=>!b.ocrCorrected)||[];
 return Boolean(translationState?.pdfLayout&&!translationState.done&&pending.length&&pending.every(b=>b.image||b.ocrSheet)&&(translationState.pdfLayout.ocrPending||pdfLayoutDocument.ocrCorrectedVersion===0));
}
function syncLayoutParts(){const parts=pdfLayoutDocument.pages.flatMap(p=>p.blocks).map(b=>b.source);Object.assign(translationState,{source:parts.join('\n\n'),parts,plan:parts.map(text=>({text,pages:[],blockIds:{}}))});}
// A new asset becomes the session before OCR starts, so a failed OCR batch leaves something to resume.
async function adoptPdfLayout(result){
 await dualViewer.clear();pdfLayoutDocument=result.document;pdfExportUrl='';const manualGlossary=parseStudyGlossary($('#glossary').value);
 translationState={mode:$('#mode').value,domain:$('#domain').value,done:0,context:'',glossary:{...manualGlossary},manualGlossary,pdfLayout:{assetId:result.assetId,ocrPending:true}};syncLayoutParts();
 translationParts=[];clearPartStream();$('#download-pdf').disabled=true;$('#warnings').textContent=(pdfLayoutDocument.warnings||[]).join('\n');syncPdfText();
}
async function correctPdfOcr(model){
 // A manifest with OCR sheets is read a whole sheet (several blocks, one image) at a time.
 const pages=pdfLayoutDocument.pages.filter(p=>p.ocr),blocks=pages.flatMap(p=>p.blocks),pending=blocks.filter(b=>!b.ocrCorrected);
 let done=blocks.length-pending.length;for(const ids of ocrImageBatches(pending,undefined,pages.flatMap(p=>p.ocrSheets||[]))){status(`Đang đọc lại chữ trong ảnh đoạn ${Math.min(done+1,blocks.length)}–${Math.min(done+ids.length,blocks.length)}/${blocks.length}…`);const output=await api('pdf-layout/ocr-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,blockIds:ids,apiKey:key(),model})});pdfLayoutDocument=output.document;model=output.model||model;addUsage(output.usage);done+=ids.length;}
 // History requires parts to match the manifest, which now holds the corrected sources.
 syncLayoutParts();delete translationState.pdfLayout.ocrPending;syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,[]);
}
function syncPdfText(){
 const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks);$('#source').value=blocks.map(b=>b.text).join('\n\n');$('#source').readOnly=true;
 $('#translation').value=blocks.map((b,i)=>{let text=translationParts[i]||'';for(const inline of b.inlines||[])text=text.replace(inline.token,inline.text);return text;}).filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value;$('#source-count').textContent=`${$('#source').value.length} ký tự`;$('#part-count').textContent=`${blocks.length} block`;
}
async function runPdfLayout({fromRun=false}={}){
 if(running&&!fromRun)return;
 key();if(!layoutConfig.configured)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');busy(true);stopRequested=false;
 try{
  let selectedModel=await ensureStudyModel('pdf');
  const range=translationRange().text;
  if(translationState?.pdfLayout&&!pdfOcrResumable()&&needsPdfLayoutRefresh()){
   status('Đang cập nhật bố cục scan và tách lại vùng chữ khỏi hình gốc…');const result=await api('pdf-layout/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,forceClone:true})}),priorTitle=historyTitle(),priorFilename=selectedFile?.name||activeHistoryMeta.filename||'',prior=historyItems.find(item=>item.id===activeHistoryId);
   // The refreshed copy is a new session; it rejoins the old one's book and takes over its part instead of adding the same pages twice.
   if(prior?.library_story_id)bookTarget={id:prior.library_story_id,replaceChapterId:prior.library_chapter_id||''};
   resetHistoryIdentity();activeHistoryMeta={title:priorTitle,filename:priorFilename};await adoptPdfLayout(result);await saveHistory();
  }
  if(!translationState?.pdfLayout||selectedFile&&pdfLayoutRange!==range){
   if(!selectedFile)throw new Error('Hãy chọn PDF gốc.');status('Đang tách ảnh, công thức và block có tọa độ từ PDF…');const form=new FormData(),sha256=await selectedHash;form.set('file',selectedFile);form.set('pages',range);if(sha256)form.set('sha256',sha256);const result=await api('pdf-layout/extract',{method:'POST',body:form});
   // Phones on plain HTTP cannot hash in the browser; the Worker's hash still lets the book and its cover remember this file.
   if(!selectedSha256&&/^[a-f\d]{64}$/u.test(result.document?.sourceSha256||''))selectedSha256=result.document.sourceSha256;
   resetHistoryIdentity();pdfLayoutRange=range;if(bookChoiceActive())updateBookHint();clearPageImages();await adoptPdfLayout(result);await saveHistory();
  }
  if(translationState.pdfLayout.ocrPending||pdfOcrResumable())await correctPdfOcr(selectedModel);
  // A save can land between the last OCR batch and the history update; untranslated parts follow the manifest.
  else if(!translationState.done)syncLayoutParts();
  const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks);await saveHistory();
  if(translationState.done===blocks.length){$('#download-pdf').disabled=false;status('Đã dịch đủ các block. Bấm Xuất PDF tiếng Việt để tải bản giữ bố cục.');return;}
  for(const batch of blockBatches(blocks.slice(translationState.done))){
   if(stopRequested)break;status(`Đang dịch block ${translationState.done+1}–${translationState.done+batch.length}/${blocks.length}…`);
   const result=await api('translate-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model:selectedModel,blocks:batch.map(({id,source})=>({id,source})),domain:translationState.domain,mode:translationState.mode,context:translationState.context,glossary:translationState.glossary})});
   if(result.model){selectedModel=result.model;$('#gemini-model-status').textContent=`Đã dùng ${result.model}.`;if([...$('#gemini-model').options].some(o=>o.value===result.model))$('#gemini-model').value=result.model;}
   const translated=new Map(result.blocks.map(b=>[b.id,b.translation]));for(const b of batch){const text=translated.get(b.id);if(!text)throw new Error(`Thiếu bản dịch block ${b.id}.`);translationParts[translationState.done++]=text;}
   if(result.warnings?.length)$('#warnings').textContent+=result.warnings.join('\n')+'\n';
   translationState.context=result.context||translationState.context;translationState.glossary={...translationState.glossary,...result.glossary,...translationState.manualGlossary};addUsage(result.usage);syncPdfText();await dualViewer.update(pdfTranslations());await saveHistory();workflow(3);
  }
  const complete=translationState.done===blocks.length;$('#download-pdf').disabled=!complete;status(complete?'Đã dịch đủ các block. Đang xuất PDF tiếng Việt…':`Đã dừng sau ${translationState.done}/${blocks.length} block; có thể tiếp tục từ lịch sử.`);
  if(complete)await exportLayoutPdf(false);
 }catch(error){rejectKey(error);fail(error);}finally{busy(false);stopRequested=false;}
}
async function exportLayoutPdf(download=true){
 if(!translationState?.pdfLayout||!activeHistoryId)throw new Error('Hãy lưu đủ các block trước khi xuất PDF.');
 if(!pdfExportUrl){status('Đang đo chữ, điều chỉnh cỡ font và xuất PDF tiếng Việt…');const result=await api('pdf-layout/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,historyId:activeHistoryId})});pdfExportUrl=result.url;translationState.pdfLayout.exported=true;translationState.pdfLayout.renderVersion=result.renderVersion||2;await dualViewer.setExportedPdf(result.url);}
 status('PDF tiếng Việt đã được lưu vào Thư viện riêng. Hai bản đang hiển thị song song.');
 if(download){const response=await fetch(pdfExportUrl,{credentials:'same-origin'});if(!response.ok)throw new Error('Không tải được PDF.');const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=downloadFilename('pdf');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}

async function translate(){
 const source=$('#source').value.trim();
 if(!source)throw new Error('Hãy dán hoặc trích xuất nguyên tác trước.');
 if(source.length>2_000_000)throw new Error('Tối đa 2 triệu ký tự cho một phiên học tập.');
 const mode=$('#mode').value,domain=$('#domain').value,continuing=translationState&&translationState.source===source&&translationState.mode===mode&&translationState.domain===domain;
 const plan=continuing?translationState.plan:createTranslationPlan(source,preparedPages),parts=continuing?translationState.parts:plan.map(part=>part.text),manualGlossary=parseStudyGlossary($('#glossary').value);
 if(!continuing){
  translationState={source,domain,mode,parts,plan,done:0,context:'',glossary:{...manualGlossary},manualGlossary,previousSource:'',previousTranslation:''};
  translationParts=[];renderPartStream(plan);$('#translation').value='';$('#warnings').textContent=ocrWarnings.join('\n')+(ocrWarnings.length?'\n':'');
  if(pageImages.size&&domain==='math')$('#warnings').textContent+='OCR chữ không xác nhận tính đúng của công thức. Hãy đối chiếu ký hiệu với hình gốc.\n';
 }else{
  for(const term of Object.keys(translationState.manualGlossary||{}))if(!Object.hasOwn(manualGlossary,term))delete translationState.glossary[term];
  translationState.manualGlossary=manualGlossary;Object.assign(translationState.glossary,manualGlossary);
  if(!$('#translation-parts').children.length){renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});}
 }
 if(translationState.done===parts.length){status('Tài liệu này đã dịch xong trong phiên. Không gọi Gemini lại.');return;}
 key();busy(true);stopRequested=false;let activeIndex=-1,lastSaved=await saveHistory();
 try{
  for(let index=translationState.done;index<parts.length;index++){
   if(stopRequested)break;activeIndex=index;const part=parts[index];updatePart(index,undefined,'working');status(`Đang dịch phần ${index+1}/${parts.length}…`);
   const result=await api('translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model:$('#gemini-model').value,source:part,mode,domain,context:translationState.context,glossary:translationState.glossary,previousSource:translationState.previousSource,previousTranslation:translationState.previousTranslation})});
   translationParts[index]=result.translation;updatePart(index,result.translation,'done');$('#translation').value=translationParts.join('\n\n');$('#download').disabled=false;renderPageImages();workflow(3);
   translationState.context=result.context||translationState.context;translationState.glossary={...(result.glossary||translationState.glossary),...translationState.manualGlossary};translationState.previousSource=part.slice(-350);translationState.previousTranslation=result.translation.slice(-500);translationState.done=index+1;addUsage(result.usage);
   if(result.warnings?.length)$('#warnings').textContent+=`Phần ${index+1}: ${result.warnings.join('; ')}\n`;
   lastSaved=await saveHistory()||lastSaved;
  }
  status(stopRequested?`Đã dừng sau ${translationState.done}/${parts.length} phần. Tiến độ đã lưu vào tài khoản; bấm Bắt đầu dịch để tiếp tục.`:lastSaved?.libraryStoryId?`Hoàn tất ${parts.length} phần. Bản dịch đã được lưu vào Thư viện riêng.`:`Hoàn tất ${parts.length} phần. Hãy đối chiếu bản dịch với nguyên tác.`);
 }catch(error){if(activeIndex>=0)updatePart(activeIndex,undefined,'failed');rejectKey(error);fail(error);}finally{busy(false);stopRequested=false;}
}

$('#source').addEventListener('input',()=>{resetHistoryIdentity();if(!bookChoiceActive())bookTarget={id:'',replaceChapterId:''};translationState=null;translationParts=[];clearPartStream();$('#translation').value='';$('#download').disabled=true;updateCount();});
$('#content-title').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');updateTitleControls();$('#content-title-hint').textContent=activeHistoryId?'Bấm Lưu tên để cập nhật lịch sử và Thư viện riêng.':'Tên này xuất hiện trong lịch sử, Thư viện riêng và tệp tải xuống.';});
$('#save-title').addEventListener('click',()=>renameHistory().catch(fail));
$('#domain').addEventListener('change',event=>{if(event.target.value==='math'&&!$('#glossary').value.trim())$('#glossary').value=MATH_GLOSSARY;if(translationState?.pdfLayout){translationState.domain=event.target.value;translationState.manualGlossary=parseStudyGlossary($('#glossary').value);Object.assign(translationState.glossary,translationState.manualGlossary);}else translationState=null;});
$('#pdf-layout-enabled').addEventListener('change',()=>{if(selectedFile)selectionTask=selected(selectedFile).catch(fail);});
$('#library-match-dismiss').addEventListener('click',()=>{$('#library-match').hidden=true;});
$('#source-file').addEventListener('change',event=>{selectionTask=selected(event.target.files[0]).catch(error=>{fail(error);return false;});});
$('#study-history-list').addEventListener('click',event=>{const merge=event.target.closest('[data-history-merge]');if(merge){openMergeDialog(merge.dataset.historyMerge);return;}const button=event.target.closest('[data-history-open]');if(button)openHistory(button.dataset.historyOpen).catch(fail);});
$('#study-books-list').addEventListener('click',event=>{const button=event.target.closest('[data-book-order]');if(button)openOrderDialog(button.dataset.bookOrder);});
$('#book-target').addEventListener('change',()=>{bookChoiceTouched=true;delete $('#book-replace-option').dataset.part;updateBookHint();applyBookCover().then(()=>{renderCover();refreshOfferedRange();updateBookHint();}).catch(()=>{});});
$('#page-range').addEventListener('input',()=>{cover.note='';updateBookHint();renderCover();});
$('#cover-change').addEventListener('click',openCoverDialog);
$('#cover-none').addEventListener('click',()=>{if(running)return;Object.assign(cover,{page:0,source:'student',replace:false,synced:'',note:''});setCoverImage(null);coverChanged();});
$('#cover-translate').addEventListener('change',()=>{cover.note='';renderCover();updateBookHint();});
$('#book-replace').addEventListener('change',updateBookHint);
$('#book-next-range').addEventListener('click',event=>{$('#page-range').value=event.currentTarget.dataset.range||$('#page-range').value;cover.note='';updateBookHint();renderCover();$('#page-range').focus();});
$('#book-dialog-form').addEventListener('submit',async event=>{event.preventDefault();if(!dialogSubmit)return;const button=$('#book-dialog-submit');button.disabled=true;$('#book-dialog-status').textContent='Đang lưu…';try{await dialogSubmit();closeBookDialog();}catch(error){$('#book-dialog-status').textContent=error.message;button.disabled=false;}});
$('#book-dialog-cancel').addEventListener('click',closeBookDialog);
$('#translate').addEventListener('click',()=>run().catch(fail));
$('#check-gemini-model').addEventListener('click',()=>{if(running)return;ensureStudyModel($('#pdf-layout-enabled').checked&&(selectedFile?.name.toLowerCase().endsWith('.pdf')||translationState?.pdfLayout)?'pdf':'text').then(model=>status(`Đã kiểm tra ${model}. Bấm Bắt đầu dịch để tiếp tục.`)).catch(fail);});
$('#stop').addEventListener('click',()=>{stopRequested=true;status('Sẽ dừng sau yêu cầu đang chạy.');});
$('#api-key').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');});
$('#clear-key').addEventListener('click',()=>{sessionKey='';$('#api-key').value='';$('#key-status').textContent='Chưa nạp khóa cho phiên này.';status('Đã xóa khóa API khỏi phiên.');});
$('#download').addEventListener('click',()=>{const blob=new Blob(['\uFEFF'+$('#translation').value],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=downloadFilename('txt');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#download-rich').addEventListener('click',()=>downloadRichHtml().catch(fail));
$('#download-pdf').addEventListener('click',()=>{if(running)return;busy(true);exportLayoutPdf().catch(fail).finally(()=>busy(false));});
$('#evaluate').addEventListener('click',()=>{const candidate=$('#translation').value.trim(),reference=$('#reference').value.trim();if(!candidate||!reference){fail(new Error('Cần có cả bản dịch AI và bản dịch chuẩn để đánh giá.'));return;}const result=evaluateStudyTranslation(candidate,reference);$('#evaluation-result').innerHTML=`<strong>BLEU-4 tham khảo: ${result.bleu}</strong><span>Công thức khớp tuyệt đối: ${result.formulaRetention}% (${result.formulasMatched}/${result.formulasTotal})</span><small>${result.candidateTokens} token bản dịch AI · ${result.referenceTokens} token ground truth</small>`;});
// Same avatar + name control as the library header, so both pages look like one product.
function renderHeaderAccount(user){
 const name=String(user.name||user.email||'Tài khoản').trim(),words=name.split(/\s+/u),initials=(words[0][0]+(words.length>1?words.at(-1)[0]:'')).toLocaleUpperCase('vi-VN');
 const link=document.createElement('a'),avatar=document.createElement('span'),label=document.createElement('span');
 link.className='header-account';link.href='/#account';link.title=name;link.setAttribute('aria-label',`Tài khoản của ${name}`);avatar.className='header-avatar';label.className='header-account-name';label.textContent=name;
 if(user.picture){const image=document.createElement('img');image.src=user.picture;image.alt='';image.width=32;image.height=32;image.referrerPolicy='no-referrer';avatar.append(image);}else avatar.textContent=initials;
 link.append(avatar,label);document.querySelector('.site-header-actions')?.replaceChildren(link);
}
fetch('/api/me',{credentials:'same-origin'}).then(response=>response.json()).then(data=>{if(data.authenticated){renderHeaderAccount(data.user);$('#account-status').hidden=true;$('#study-history').hidden=false;$('#study-history-count').textContent='· đang tải…';$('#account-status').textContent=`Đang học với tài khoản ${data.user.name||data.user.email}.`;loadHistory().catch(error=>{historyItems=[];renderHistory();$('#warnings').textContent+=`Không tải được lịch sử: ${error.message}\n`;});return;}$('#account-status').innerHTML='Hãy <a href="/#account">đăng nhập hoặc tạo tài khoản</a> trước khi dịch.';$('#translate').disabled=true;}).catch(()=>{$('#account-status').textContent='Không kiểm tra được trạng thái đăng nhập.';$('#translate').disabled=true;});
updateCount();
