import {parseStudyGlossary} from './study-glossary.js';
import {parseStudyPageRange} from './study-pages.js';
import {evaluateStudyTranslation} from './study-evaluation.js';
import {shouldUseGeminiOcr} from './ocr-policy.js';
import {runStudyTranslation} from './study-flow.js';
import {createTranslationPlan,joinedPageText,textOutsideFigures} from './document-layout.js';
import {originalPageView,partTitle,buildStudyHtml,translationContentHtml,figuresForPart,readingStyles} from './study-layout-view.js';
import {extractPageFigures} from './document-figures.js';
import {attachHanziLookup,openHanziPanel,lookupTextarea,hasHan} from './hanzi-lookup.js';
// Loaded only when needed, so the page opens without them: the PDF tools (whole-book.js, cover-detect.js) with a picked
// PDF or a whole-book run, the layout code with a layout run, the dual viewer with the first layout PDF it shows.
let wholeBook=null,coverTools=null;
const pdfTools=()=>Promise.all([import('./whole-book.js'),import('./cover-detect.js')]).then(([book,coverModule])=>{wholeBook=book;coverTools=coverModule;});
const boxLayout=()=>import('./pdf-box-layout.js');
const $=selector=>document.querySelector(selector);
const readingStyle=document.createElement('style');readingStyle.textContent=readingStyles;document.head.append(readingStyle);
let sessionKey='',selectedFile=null,pdfAnalysis=null,running=false,starting=false,stopRequested=false;
let usage={prompt:0,output:0,total:0,requests:0},translationParts=[];
let preparedPages=new Map(),pageImages=new Map(),translationState=null,preparedRangeKey=null;
let ocrWarnings=[];
let selectionVersion=0;
let selectionTask=Promise.resolve();
// historyIdToCreate: the id a whole-book chunk's first save asks for, so that save sent again creates nothing new.
let historyItems=[],activeHistoryId='',historyIdToCreate='',activeHistoryMeta={},historySave=Promise.resolve(),historyError=null;
// unsaved: the last save of the open session failed, so work shown here is not in the account yet. runActive: a run
// started with Bắt đầu dịch is going (Dừng shows, closing the tab asks first).
let unsaved=false,runActive=false;
let pdfLayoutDocument=null,pdfLayoutRange='',pdfExportUrl='',layoutConfig={configured:false};
// A finished range becomes one part of a private book. bookTarget survives resetHistoryIdentity(), so a new range or a
// refreshed copy of the same file keeps going into the book the student chose.
let studyBooks=[],bookTarget={id:'',replaceChapterId:''},bookChoiceTouched=false,selectedHash=Promise.resolve(''),selectedSha256='',selectedTotalPages=0;
// The picked PDF's cover stays original artwork: ranges skip it unless its text is translated, and it becomes the book's
// cover image. page 0 = no cover; source = who decided it: the detector, the book (remembered for this file) or the student.
let cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:0,note:'',detecting:false},autoRange='';
let modelCatalogFingerprint='',modelCatalogPurpose='',checkedModelMode='';
// "Dịch cả quyển" (whole-book.js): the job in the panel, every job of the account (the history groups their parts), the
// original pdf-lib cuts chunks from, the page kinds read on the device, the run in progress and the chunk session it owns.
// bookPagesEdited: the student changed the page field for the bound job; bookBusy: another device runs it, so the
// button offers to wait for that run (Chờ rồi dịch tiếp).
let bookMode=false,bookJob=null,bookJobs=[],bookSource=null,bookSurvey=null,bookRun=null,bookWorking=null,bookChunkId='',bookContext='',bookStatusText='',bookNotes=[],bookHashTask=null,coverTask=Promise.resolve(),lastSavedHistory=null,bookPagesEdited=false,bookBusy=false;
let wake=null,runnerId='',reportStore=null;
// One run id per browser: after a reload this browser goes on with its own run at once, while another device waits until
// that run stops reporting. Tokens not yet reported are kept here too. Without localStorage both last as long as the page.
// Both need whole-book.js, so they are made the first time a book job is shown or run.
const browserStorage=(()=>{try{const storage=globalThis.localStorage;storage.getItem('hoa-tri-runner');return storage;}catch{return null;}})();
function bookRunner(){if(!runnerId)try{let id=browserStorage?.getItem('hoa-tri-runner');if(!/^[A-Za-z\d-]{8,64}$/u.test(id||'')){id=wholeBook.newId();browserStorage?.setItem('hoa-tri-runner',id);}runnerId=id;}catch{runnerId=wholeBook.newId();}return runnerId;}
const bookReports=()=>reportStore??=wholeBook.reportStore(browserStorage);
// The parts each whole-book run saved; without a job (or before whole-book.js is loaded) there is nothing to group.
const jobSessions=()=>wholeBook&&bookJobs.length?wholeBook.sessionsByJob(historyItems,bookJobs):new Map();
async function ensureStudyModel(purpose='text'){
 const apiKey=key(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(apiKey)),fingerprint=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join(''),mode=$('#mode').value;
 if(modelCatalogFingerprint===fingerprint&&modelCatalogPurpose===purpose&&checkedModelMode===mode&&$('#gemini-model').value)return $('#gemini-model').value;
 $('#gemini-model-status').textContent='Đang kiểm tra phiên bản Gemini dùng được với khóa…';
 const result=await api('models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey,purpose,mode})}),select=$('#gemini-model');select.replaceChildren();
 for(const model of result.models||[]){const option=document.createElement('option');option.value=model.id;option.textContent=model.id;select.append(option);}select.disabled=running||!(result.models?.length);
 modelCatalogFingerprint=fingerprint;modelCatalogPurpose=purpose;checkedModelMode=mode;
 if(!result.selected){select.value='';$('#gemini-model-status').textContent='Không có phiên bản Gemini phù hợp với cách dịch đang chọn. Hãy chọn một phiên bản trong danh sách để tiếp tục.';$('#advanced-settings').open=true;throw new Error('Khóa này chưa dùng được phiên bản Gemini phù hợp với cách dịch đang chọn. Hãy mở Nâng cao và chọn một phiên bản trong danh sách.');}
 select.value=result.selected;
 $('#gemini-model-status').textContent=result.selected===result.requested?`Đang dùng ${result.selected}.`:`Phiên bản ${result.requested} chưa dùng được với khóa này; đang dùng ${result.selected}.`;return result.selected;
}
// Chinese source of a block, looked up in the offline dictionary (no Gemini, no /api).
const OCR_NOTE='Đoạn này nhận dạng từ ảnh (OCR) và chưa được đọc lại; chữ có thể sai, hãy đối chiếu với trang gốc.';
async function editLayoutBlock(id,translation){
 if(running)return;busy(true);try{const {validateBlockTranslations}=await boxLayout(),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),index=blocks.findIndex(b=>b.id===id);validateBlockTranslations([blocks[index]],[{id,translation}]);translationParts[index]=translation.normalize('NFC');pdfExportUrl='';translationState.pdfLayout.exported=false;syncPdfText();await dualViewer.invalidatePdf();await dualViewer.update(pdfTranslations());if(!await saveHistory())throw new Error('Chưa lưu được đoạn đã sửa. Hãy thử lại.');$('#download-pdf').disabled=translationState.done!==blocks.length;status('Đã lưu đoạn sửa. Bấm Xuất PDF tiếng Việt để dàn trang lại.');}catch(error){fail(error);}finally{busy(false);}
}
// The preview font (~800 KB) is fetched the first time the viewer draws a translated page, never at start-up, so picking a
// file never waits for it. The browser keeps it a day and then revalidates it (ETag); a failure is tried again later.
let fontTask=null;
function previewFont(){
 fontTask??=api('pdf-layout/font').then(font=>{const style=document.createElement('style');style.textContent=font.css;document.head.append(style);}).catch(error=>{fontTask=null;throw error;});
 return fontTask;
}
let viewerTask=null;
function loadViewer(){
 viewerTask??=import('./pdf-dual-viewer.js').then(({PdfDualViewer})=>{
  const viewer=new PdfDualViewer($('#pdf-dual-viewer'),{loadFont:previewFont});
  viewer.onSourceBlock=(block,page,region)=>openHanziPanel({text:block.text||block.source,title:`Nguyên tác · Trang ${page.number} · Đoạn ${page.blocks.indexOf(block)+1}`,note:page.ocr&&!block.ocrCorrected?OCR_NOTE:'',returnFocus:region});
  viewer.onEdit=editLayoutBlock;return viewer;
 }).catch(error=>{viewerTask=null;throw error;});
 return viewerTask;
}
// Until the first layout PDF is shown there is no viewer, and nothing to clear.
const dualViewer={
 clear:()=>viewerTask?viewerTask.then(viewer=>viewer.clear(),()=>{}):Promise.resolve(),
 setDocument:(...args)=>loadViewer().then(viewer=>viewer.setDocument(...args)),
 update:translations=>loadViewer().then(viewer=>viewer.update(translations)),
 invalidatePdf:()=>loadViewer().then(viewer=>viewer.invalidatePdf()),
 setExportedPdf:url=>loadViewer().then(viewer=>viewer.setExportedPdf(url))
};
// The PDF service is asked about only once the session is known: a signed-out visitor would only get a 401.
let sessionKnown;const sessionChecked=new Promise(resolve=>{sessionKnown=resolve;});
const layoutConfiguration=sessionChecked.then(signedIn=>signedIn?api('pdf-layout/config'):{configured:false}).then(config=>{layoutConfig=config;$('#pdf-layout-enabled').checked=Boolean(config.configured);$('#pdf-layout-service-status').textContent=config.configured?'Dịch từng đoạn ngay tại chỗ; giữ hình gốc, công thức và vị trí chữ.':'Dịch vụ PDF giữ bố cục chưa được cấu hình.';}).catch(()=>{layoutConfig={configured:false};$('#pdf-layout-enabled').checked=false;$('#pdf-layout-service-status').textContent='Dịch vụ PDF giữ bố cục chưa sẵn sàng.';});
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

// On phones the floating action bar repeats the latest line (#run-bar-status; screen readers hear #progress only).
function status(message,type=''){$('#progress').textContent=message;$('#progress').className=type;const mirror=$('#run-bar-status');mirror.textContent=message;mirror.classList.toggle('error',type==='error');}
const SESSION_EXPIRED='Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.';
const signedOut=error=>error?.status===401||String(error?.message||'').startsWith(SESSION_EXPIRED);
function signInLink(text='Đăng nhập lại'){const link=document.createElement('a');link.href='/#account';link.textContent=text;return link;}
// Error text from services is bounded upstream; this cap keeps the progress box readable whatever arrives.
// An expired session also gets the way back: a link to sign in.
function fail(error){const message=String(error?.message||error).trim();status(message.length>500?`${message.slice(0,499)}…`:message,'error');if(signedOut(error))$('#progress').append(' ',signInLink());}
function workflow(step){document.querySelectorAll('.workflow li').forEach((item,index)=>{item.classList.toggle('active',index===step-1);item.classList.toggle('done',index<step-1);});}
async function api(path,options={}){
 const failed=(message,status,data=null)=>Object.assign(new Error(message),{status,data});
 const response=await fetch('/api/my/study/'+path,{credentials:'same-origin',...options}).catch(()=>{throw failed('Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại sau vài giây.',0);});
 if(response.status===204)return {};
 const data=await response.json().catch(()=>null);
 if(response.status===401)throw failed(SESSION_EXPIRED,401);
 // A page instead of JSON usually means the server is restarting or being updated, not that the request was wrong.
 if(!data||typeof data!=='object')throw failed(`Máy chủ trả về phản hồi không đọc được (mã ${response.status}). Có thể máy chủ đang khởi động lại hoặc cập nhật; hãy thử lại sau vài giây.`,response.status);
 // A refused Gemini answer was still billed: the server sends what it spent, so the counters (and a book's total) count it.
 // Retry-After lets a whole-book run wait out a limit by itself.
 if(!response.ok){if(data.usage)addUsage(data.usage);throw Object.assign(failed(data.error||'Không thể xử lý yêu cầu.',response.status,data),{retryAfter:Number(response.headers.get('Retry-After'))||null});}
 return data;
}
function resetHistoryIdentity(){activeHistoryId='';historyIdToCreate='';activeHistoryMeta={};setUnsaved(false);renderHistory();}
function historyTitle(){
 // Every chunk of a whole-book run is saved under the book's name, so the book labels its parts by their pages.
 if(bookRun&&bookJob){const book=studyBooks.find(entry=>entry.id===bookJob.storyId);return book?.title||bookJob.title;}
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
 // A whole-book run keeps the name it started with; its book is renamed in Lịch sử dịch (Sắp xếp phần).
 const input=$('#content-title'),button=$('#save-title');input.readOnly=Boolean(bookMode&&bookJob);button.hidden=!activeHistoryId||bookMode;button.disabled=running||!input.value.trim()||input.value.trim().normalize('NFC')===activeHistoryMeta.title;
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
// A layout PDF counts its text blocks as parts: its pages say more than "27 phần".
function historyStatus(item){
 const pages=item.page_start?pageLabel(item.page_start,item.page_end||item.page_start):'';
 if(item.status==='complete')return `Hoàn tất · ${pages||`${item.total_parts} đoạn`}`;
 if(item.status==='translating')return `Đang dịch dở · ${item.translated_parts}/${item.total_parts} đoạn${pages?` · ${pages}`:''}`;
 return pages?`Đã lưu nguyên tác · ${pages}`:'Đã lưu nguyên tác';
}
// Contract 8: a load that failed is explained where its content belongs, with Thử lại, or a sign-in link after a 401.
function loadErrorCard(title,error,retry){
 const card=document.createElement('div'),heading=document.createElement('p'),text=document.createElement('p');card.className='load-error';card.setAttribute('role','alert');heading.className='load-error-title';heading.textContent=title;
 text.textContent=signedOut(error)?'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để xem lịch sử dịch.':String(error?.message||error||'Không kết nối được máy chủ.');card.append(heading,text);
 if(signedOut(error)){const link=signInLink('Đăng nhập');link.className='load-error-action';card.append(link);}
 else{const button=document.createElement('button');button.type='button';button.className='load-error-action';button.textContent='Thử lại';button.addEventListener('click',retry);card.append(button);}
 return card;
}
function renderHistory(){
 updateTitleControls();
 const section=$('#study-history'),root=$('#study-history-list');if(!section||!root)return;
 section.hidden=false;root.replaceChildren();
 if(historyError){$('#study-history-count').textContent='· chưa tải được';$('#study-books').hidden=true;root.append(loadErrorCard('Chưa tải được lịch sử dịch.',historyError,()=>loadHistoryView().then(()=>(historyError?root.querySelector('.load-error-action'):$('#study-history>summary'))?.focus())));return;}
 $('#study-history-count').textContent=historyItems.length?`· ${historyItems.length} bản đã lưu`:'· chưa có';
 // The parts a whole-book run saved (one per chunk) are listed under that book, not one card each.
 const grouped=new Set([...jobSessions().values()].flat().map(item=>item.id));renderStudyBooks();
 if(!historyItems.length){const empty=document.createElement('p');empty.className='history-empty';empty.textContent='Chưa có bản dịch nào được lưu trong tài khoản này.';root.append(empty);return;}
 for(const item of historyItems.filter(item=>!grouped.has(item.id))){
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
  const remove=document.createElement('button');remove.type='button';remove.className='history-delete';remove.dataset.historyDelete=item.id;remove.disabled=running;remove.textContent='Xóa';remove.setAttribute('aria-label',`Xóa “${item.title||'Bản dịch chưa đặt tên'}”`);actions.append(remove);
  card.append(actions);root.append(card);
 }
}
async function loadHistory(){const [rows,books]=await Promise.all([api('history'),api('books').catch(()=>studyBooks),loadBookJobs()]);historyItems=Array.isArray(rows)?rows:[];setStudyBooks(books);}
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
  if(suggest&&suggestion&&$('#page-range').value===autoRange){autoRange=$('#page-range').value=rangeValue(suggestion);if(!bookMode)setFileStatus(`${selectedTotalPages} trang · sách “${book.title}” đã có các phần trước; đã chọn sẵn ${pageLabel(suggestion.start,suggestion.end)} để dịch tiếp.`);}
 }
 await applyBookCover(version);updateBookHint();renderCover();
}

// ---- Cover of the picked PDF ----
const coverExcluded=()=>cover.page>0&&!$('#cover-translate').checked;
const coverSpans=()=>coverExcluded()?[{pageStart:cover.page,pageEnd:cover.page}]:[];
// The pages actually sent for translation. A session reopened from history has no picked file; its field is used as typed.
function translationRange(){
 const value=$('#page-range').value.trim();if(!selectedFile||!selectedTotalPages)return {text:value,pages:null,excluded:false};
 return coverTools.excludeCover(value,selectedTotalPages,cover.page,{translateCover:$('#cover-translate').checked});
}
function setCoverImage(blob){if(cover.url)URL.revokeObjectURL(cover.url);cover.jpeg=blob||null;cover.url=blob?URL.createObjectURL(blob):'';}
function resetCover(){setCoverImage(null);cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:cover.task+1,note:'',detecting:false};$('#cover-translate').checked=false;renderCover();}
function renderCover(){
 // A whole-book run keeps the cover it started with (its page state); the panel names it.
 const root=$('#cover-choice');if(!root)return;root.hidden=!/\.pdf$/iu.test(selectedFile?.name||'')||Boolean(bookMode&&bookJob);if(root.hidden){renderBookPanel();return;}const detecting=cover.detecting&&!cover.page;
 const thumb=$('#cover-thumb');thumb.hidden=!(cover.page&&cover.url);if(!thumb.hidden){thumb.src=cover.url;thumb.alt=`Trang bìa · trang ${cover.page} của tệp`;}
 $('#cover-label').textContent=detecting?'Đang tìm trang bìa…':cover.page?`Bìa: trang ${cover.page}`:['student','book'].includes(cover.source)?'Không dùng bìa':'Không thấy trang bìa';
 $('#cover-change').textContent=cover.page?'Đổi':'Chọn trang bìa';$('#cover-change-group').hidden=detecting;$('#cover-none-group').hidden=detecting||!cover.page;$('#cover-translate-option').hidden=detecting||!cover.page;
 // Without a cover there is nothing to translate on it; a tick left from before must not apply to a cover chosen later.
 if(!cover.page)$('#cover-translate').checked=false;
 let note=cover.note;
 // A range holding only the cover is explained here at once; other range mistakes are reported on Bắt đầu dịch, as before.
 if(!note&&cover.page&&bookMode)note=$('#cover-translate').checked?'Chữ trên bìa sẽ được dịch cùng các trang khác.':'Trang bìa giữ nguyên ảnh gốc, không gọi Gemini, và là ảnh bìa sách trong Thư viện riêng.';
 else if(!note&&cover.page){try{const range=translationRange();note=range.excluded?`Trang bìa giữ nguyên ảnh gốc; chỉ dịch trang ${range.text}.`:$('#cover-translate').checked?'Chữ trên bìa sẽ được dịch cùng các trang khác.':'Trang bìa giữ nguyên ảnh gốc và là ảnh bìa sách trong Thư viện riêng.';}catch(error){if(/là bìa/u.test(error.message))note=error.message;}}
 $('#cover-note').textContent=note||'';renderBookPanel();
}
// Detection reads only page 1 (page 2 after a blank flyleaf) on this device; a failure just leaves the file without a cover.
async function detectSelectedCover(file,version){
 const task=++cover.task;cover.detecting=true;renderCover();
 try{
  const result=await coverTools.detectCoverInFile(file);if(version!==selectionVersion||task!==cover.task)return;
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
 const image=page===cover.detected?cover.detectedJpeg:page?await coverTools.pageJpeg(selectedFile,page).catch(()=>null):null;if(version!==selectionVersion)return;
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
 // The offered range belongs to "Dịch theo phạm vi"; the whole-book panel says what it will do itself.
 const [start,end=start]=value.split('-').map(Number);if(!bookMode)setFileStatus(`${selectedTotalPages} trang · đã chọn sẵn ${pageLabel(start,end)}${coverExcluded()?`; trang ${cover.page} là bìa nên giữ nguyên ảnh gốc`:''}. Có thể sửa phạm vi rồi bấm Bắt đầu dịch.`);
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
   try{const blob=await coverTools.pageJpeg(file,page);if(Number(input.value)!==page)return;preview={page,blob};if(image.src)URL.revokeObjectURL(image.src);image.src=URL.createObjectURL(blob);image.alt=`Trang ${page} của tệp`;caption.textContent=`Trang ${page}`;}catch(error){caption.textContent=error.message;}
  },250);};
  input.addEventListener('input',show);show();body.append(label,input,figure,note);
  $('#book-dialog').addEventListener('close',()=>{clearTimeout(timer);if(image.src)URL.revokeObjectURL(image.src);},{once:true});
  // Replacing a cover the book already has is the student's explicit choice, never a side effect.
  if(book?.cover?.image){const replace=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');replace.className='book-replace';Object.assign(box,{type:'checkbox',id:'cover-replace'});text.textContent=`Thay ảnh bìa hiện tại của sách “${book.title}” bằng trang này`;replace.append(box,text);body.append(replace);}
 },async()=>{
  const page=Number($('#cover-page-input').value);if(!Number.isInteger(page)||page<1||page>total)throw new Error(`Hãy nhập số trang từ 1 đến ${total}.`);
  if(version!==selectionVersion)throw new Error('Tệp đã thay đổi. Hãy mở lại hộp chọn bìa.');
  const blob=preview?.page===page?preview.blob:await coverTools.pageJpeg(file,page);
  Object.assign(cover,{page,source:'student',replace:Boolean($('#cover-replace')?.checked),synced:'',note:''});setCoverImage(blob);coverChanged();
 },'Dùng trang này');
}
function coverChanged(){renderCover();refreshOfferedRange();updateBookHint();const storyId=historyItems.find(item=>item.id===activeHistoryId)?.library_story_id;if(storyId)syncBookCover(storyId);}
// Runs after a save that put this range in a book: a new book gets the cover image; a book with a cover keeps it (the
// server refuses to replace one unless the student confirmed), and the page choice is remembered for this file.
async function syncBookCover(storyId){
 // A whole-book run continued from the account has no picked file; its original is bookSource.
 if(!storyId||!(selectedFile||bookSource)||!cover.source)return;
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
// Books with several parts, and every whole-book run with its progress: the parts a run saved (one per chunk) are listed
// in its row, where they open or are deleted, instead of one history card each.
function renderStudyBooks(){
 const section=$('#study-books'),root=$('#study-books-list');if(!section||!root)return;
 const jobOf=book=>bookJobs.find(job=>job.storyId===book.id),books=studyBooks.filter(book=>book.parts.length>1||jobOf(book)),loose=bookJobs.filter(job=>!job.storyId||!studyBooks.some(book=>book.id===job.storyId));
 const opened=new Set([...root.querySelectorAll('details.book-job-parts[open]')].map(details=>details.dataset.job)),groups=jobSessions();
 section.hidden=!books.length&&!loose.length;root.replaceChildren();
 for(const job of loose)root.append(studyBookRow(null,job,opened,groups));
 for(const book of books)root.append(studyBookRow(book,jobOf(book),opened,groups));
}
function studyBookRow(book,job,opened,groups){
 const row=document.createElement('article'),text=document.createElement('div'),title=document.createElement('strong'),actions=document.createElement('div');
 const add=(label,data)=>{const button=document.createElement('button');button.type='button';button.disabled=running;button.textContent=label;Object.assign(button.dataset,data);actions.append(button);};
 row.className=job?'study-book book-job':'study-book';title.textContent=book?.title||job.title;text.append(title);
 if(job){const progress=document.createElement('small');progress.className='book-job-progress';progress.textContent=[`Dịch cả quyển · ${wholeBook.progressText(job.pageStates)}`,jobStatusLabel(job),job.usage?.total?`${wholeBook.formatTokens(job.usage.total)} token`:'',wholeBook.progressNote(job.pageStates)].filter(Boolean).join(' · ');text.append(progress);}
 if(book){const meta=document.createElement('small');meta.textContent=`${book.parts.length} phần · ${book.parts.map(part=>part.title).join(' · ')}`;text.append(meta);}
 const parts=job?[...(groups.get(job.id)||[])].sort((a,b)=>(a.page_start||0)-(b.page_start||0)):[];if(parts.length)text.append(jobPartList(job,parts,opened.has(job.id)));
 actions.className='study-book-actions';
 if(job&&/[.f]/u.test(job.pageStates))add(job.pageStates.includes('.')?'Tiếp tục':'Thử lại trang lỗi',{bookResume:job.id});
 if(book)add('Sắp xếp phần',{bookOrder:book.id});
 const storyId=book?.id||job?.storyId;if(storyId){const read=document.createElement('a');read.href=`/?read=${encodeURIComponent(storyId)}`;read.textContent='Đọc sách';actions.append(read);}
 if(job)add('Xóa tiến độ',{bookDelete:job.id});
 row.append(text,actions);return row;
}
function jobPartList(job,parts,expanded){
 const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');details.className='book-job-parts';details.dataset.job=job.id;details.open=expanded;summary.textContent=`Các phần đã lưu (${parts.length})`;
 for(const item of parts){
  const entry=document.createElement('li'),open=document.createElement('button'),remove=document.createElement('button'),label=item.page_start?pageLabel(item.page_start,item.page_end||item.page_start).replace(/^t/u,'T'):item.title||'Phần chưa đặt tên';
  open.type='button';open.dataset.historyOpen=item.id;open.disabled=running;open.textContent=`${label} · ${item.status==='complete'?'Hoàn tất':item.status==='translating'?'Dịch dở':'Chưa dịch'}`;
  remove.type='button';remove.className='history-delete';remove.dataset.historyDelete=item.id;remove.disabled=running;remove.textContent='Xóa';remove.setAttribute('aria-label',`Xóa phần ${label}`);
  entry.append(open,remove);list.append(entry);
 }
 details.append(summary,list);return details;
}
function jobStatusLabel(job){
 if(bookRun&&bookJob?.id===job.id)return 'Đang dịch';
 if(wholeBook.heldElsewhere(job,bookRunner()))return 'Đang dịch ở thiết bị khác';
 if(job.status==='done')return job.pageStates.includes('.')?'Còn trang chưa dịch':'Hoàn tất';
 if(job.status==='paused')return ({quota_day:'Tạm dừng · hết hạn mức ngày',quota:'Tạm dừng · hết hạn mức',gemini_key:'Tạm dừng · cần khóa hợp lệ',network:'Tạm dừng · mất kết nối',gemini_unavailable:'Tạm dừng · Gemini quá tải',limit:'Tạm dừng · hết lượt trong ngày'})[job.pauseReason]||'Tạm dừng';
 // "running" with no run in this tab: the tab that ran it was closed; every finished chunk is kept.
 return job.status==='running'?'Dịch dở':'Chưa bắt đầu';
}
let dialogSubmit=null,dialogWorking='Đang lưu…';
function openBookDialog(title,build,submit,label,working='Đang lưu…'){
 const dialog=$('#book-dialog');$('#book-dialog-title').textContent=title;$('#book-dialog-body').replaceChildren();build($('#book-dialog-body'));$('#book-dialog-status').textContent='';$('#book-dialog-submit').textContent=label;$('#book-dialog-submit').disabled=false;dialogSubmit=submit;dialogWorking=working;
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
// With the page fields of the server's list rows, so a part just saved sorts into its book and its whole-book run at once.
function currentHistoryRecord(saved,payload,prior=null){
 const pages=payload.state.pdfLayout&&pdfLayoutDocument?pdfLayoutDocument.pages.map(page=>page.number):[],range=payload.pageRange;
 return {id:saved.id,title:payload.title,filename:payload.filename,domain:payload.domain,mode:payload.mode,status:saved.status,translated_parts:payload.state.done,total_parts:payload.state.parts.length,source_characters:payload.state.source.length,translation_characters:translationParts.join('\n\n').length,library_story_id:saved.libraryStoryId||null,library_chapter_id:saved.libraryChapterId||null,updated_at:saved.updatedAt,
  created_at:prior?.created_at||new Date().toISOString(),source_sha256:(pages.length&&pdfLayoutDocument.sourceSha256)||payload.sha256||prior?.source_sha256||null,page_start:pages.length?Math.min(...pages):range?.start??prior?.page_start??null,page_end:pages.length?Math.max(...pages):range?.end??prior?.page_end??null,source_total_pages:(pages.length&&pdfLayoutDocument.totalPages)||range?.total||prior?.source_total_pages||null};
}
async function persistHistory(){
 const payload=historyPayload();if(!payload)return null;
 const path=activeHistoryId?`history/${encodeURIComponent(activeHistoryId)}`:'history',method=activeHistoryId?'PUT':'POST',saved=await api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(activeHistoryId||!historyIdToCreate?payload:{...payload,id:historyIdToCreate})});
 activeHistoryId=saved.id;historyIdToCreate='';activeHistoryMeta={title:payload.title,filename:payload.filename};lastSavedHistory=saved;const index=historyItems.findIndex(item=>item.id===saved.id),prior=index>=0?historyItems[index]:null,record=currentHistoryRecord(saved,payload,prior);if(index>=0)historyItems.splice(index,1);historyItems.unshift(record);renderHistory();
 // A range that just became a book part: later ranges of this file default to the same book.
 if(saved.libraryChapterId&&prior?.library_chapter_id!==saved.libraryChapterId){bookTarget={id:saved.libraryStoryId,replaceChapterId:''};loadBooks().catch(()=>{});}
 // The book exists once the range belongs to it (a draft for a chosen book, a new book on completion): it gets its cover.
 if(saved.libraryStoryId)syncBookCover(saved.libraryStoryId);
 return saved;
}
// While a save has failed, a warning stays in view (also in the floating action bar on phones) and closing the tab asks
// first; the next successful save clears both.
function setUnsaved(value,error=null){
 unsaved=Boolean(value);const warning=$('#save-warning');warning.hidden=!unsaved;warning.replaceChildren();if(!unsaved)return;
 // Signing in in another tab keeps this tab's work; the next save then goes through.
 if(signedOut(error)){const link=signInLink('đăng nhập lại ở thẻ mới');link.target='_blank';link.rel='noopener';warning.append('Chưa lưu được tiến độ: phiên đăng nhập đã hết hạn. Đừng đóng tab; ',link,', rồi bấm Bắt đầu dịch để lưu tiếp.');}
 else warning.append('Chưa lưu được tiến độ vào tài khoản. Đừng đóng tab; kiểm tra mạng rồi bấm Bắt đầu dịch để thử lưu lại.');
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const retriableSave=error=>!error?.status||error.status===408||error.status===429||error.status>=500;
// A lost connection or a busy server gets two more tries (after 1 s, then 3 s) before the save counts as failed. A first
// save names its session, so a retry after a lost answer saves that session again instead of adding a second one.
async function saveHistory(){
 if(!activeHistoryId&&!historyIdToCreate)historyIdToCreate=globalThis.crypto?.randomUUID?.()||'';
 for(let attempt=0;;attempt++){
  historySave=historySave.catch(()=>{}).then(persistHistory);
  try{const saved=await historySave;setUnsaved(false);return saved;}
  catch(error){if(attempt>=2||!retriableSave(error)){setUnsaved(true,error);return null;}await sleep(attempt?3000:1000);}
 }
}
// A run never spends tokens on work it cannot keep: when the save before the next Gemini call failed, the run stops here.
// After the last part nothing is left to send, so that save says only that the finished translation is not saved yet.
async function saveBeforeSpending(finished=false){
 const saved=await saveHistory();
 if(unsaved&&finished)throw Object.assign(new Error('Đã dịch xong nhưng chưa lưu được bản dịch vào tài khoản. Bản dịch vẫn hiện trong tab này: đừng đóng tab. Kiểm tra mạng rồi bấm Bắt đầu dịch để lưu lại; không gọi Gemini lại.'),{code:'save_failed',status:0});
 if(unsaved)throw Object.assign(new Error(`Đã dừng vì chưa lưu được tiến độ vào tài khoản, nên Hoa Trí không gửi thêm yêu cầu tới Gemini.${translationParts.some(text=>text?.trim())?' Phần đã dịch vẫn hiện trong tab này: đừng đóng tab.':''} Kiểm tra mạng rồi bấm Bắt đầu dịch để lưu và dịch tiếp.`),{code:'save_failed',status:0});
 return saved;
}
// A whole-book chunk cannot go on from a save that failed (its part would be lost), so these saves report their errors.
// A translation that is not saved yet lives only in this tab: opening another session, picking a file or editing the
// source (which starts a new session) asks first. True means: keep what is here.
function keepUnsaved(){return unsaved&&typeof confirm==='function'&&!confirm('Phần đã dịch chưa được lưu vào tài khoản và sẽ mất nếu bạn mở hoặc nhập tài liệu khác. Vẫn tiếp tục?');}
function saveHistoryStrict(){historySave=historySave.catch(()=>{}).then(persistHistory);return historySave.then(saved=>{setUnsaved(false);return saved;},error=>{setUnsaved(true,error);throw error;});}
function glossaryText(value){return Object.entries(value||{}).map(([term,translation])=>`${term} = ${translation}`).join('\n');}
async function openHistory(id){
 if(running||keepUnsaved())return;
 const version=++selectionVersion;busy(true);
 try{
 await dualViewer.clear();pdfLayoutDocument=null;pdfExportUrl='';$('#download-pdf').disabled=true;
 const item=await api(`history/${encodeURIComponent(id)}`),state=item.state||{};if(version!==selectionVersion)return;unbindBook();selectedFile=null;selectedHash=Promise.resolve('');selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';bookTarget={id:item.library_story_id||'',replaceChapterId:''};pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];$('#source').readOnly=false;$('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';
 activeHistoryId=item.id;activeHistoryMeta={title:item.title,filename:item.filename};setUnsaved(false);$('#content-title').value=item.title||'';$('#content-title').setCustomValidity('');$('#content-title').removeAttribute('aria-invalid');$('#content-title-hint').textContent='Có thể đổi tên rồi bấm Lưu tên; bản dịch đã lưu được giữ nguyên.';$('#source').value=state.source||'';$('#domain').value=item.domain||'general';$('#mode').value=item.mode||'economy';$('#glossary').value=glossaryText(state.manualGlossary);
 const parts=Array.isArray(state.parts)?state.parts:[],plan=parts.map(text=>({text,pages:[],blockIds:{}}));translationParts=Array.isArray(state.translationParts)?state.translationParts.slice(0,parts.length):[];while(translationParts.length<parts.length)translationParts.push('');
 translationState={source:state.source||'',domain:item.domain||'general',mode:item.mode||'economy',parts,plan,done:Math.min(Number(state.done)||0,parts.length),context:state.context||'',glossary:state.glossary||{},manualGlossary:state.manualGlossary||{},previousSource:state.previousSource||'',previousTranslation:state.previousTranslation||''};
 renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});$('#translation').value=translationParts.filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value.trim();$('#download-rich').disabled=true;$('#warnings').textContent='';setFileStatus(item.filename?`${item.filename} · đã mở từ lịch sử tài khoản.`:'Đã mở bản dịch từ lịch sử tài khoản.');updateCount();workflow(translationState.done===parts.length?3:2);status(translationState.done===parts.length?'Bản dịch đã hoàn tất và có trong Thư viện riêng.':`Đã khôi phục ${translationState.done}/${parts.length} đoạn. Nhập khóa Gemini để tiếp tục.`);renderHistory();$('.workspace').scrollIntoView({behavior:'smooth',block:'start'});
 if(state.pdfLayout){
  translationState.pdfLayout=state.pdfLayout;pdfLayoutDocument=await api(`pdf-layout/assets/${state.pdfLayout.assetId}/manifest`);$('#pdf-layout-enabled').checked=true;clearPartStream();syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());$('#download-pdf').disabled=translationState.done!==parts.length;
  // Exports from an older renderer are rendered again from the saved translations: no Gemini call, no token cost.
  if(state.pdfLayout.exported&&state.pdfLayout.renderVersion>=3){pdfExportUrl=`/api/my/study/pdf-layout/assets/${state.pdfLayout.assetId}/translated`;await dualViewer.setExportedPdf(pdfExportUrl);}
  else if(state.pdfLayout.exported&&translationState.done===parts.length)status('PDF đã xuất dùng cách dàn trang cũ. Bấm Xuất PDF tiếng Việt để dàn trang lại; không cần dịch lại, không tốn token.');
 }
 }finally{busy(false);}
}
// A run disables the key field (busy) before the key is checked; it is enabled again here so it can show why and take
// focus (above the floating action bar on phones).
function askForKey(input){input.disabled=false;input.reportValidity();input.focus();}
function key(){
 const input=$('#api-key'),entered=input.value.trim();
 if(entered){
  if(entered.length<20||entered.length>500||/[\r\n\0]/u.test(entered)){input.setCustomValidity('Khóa Gemini API không hợp lệ.');askForKey(input);throw new Error('Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa.');}
  sessionKey=entered;input.value='';input.setCustomValidity('');input.removeAttribute('aria-invalid');$('#key-status').textContent='Đã nạp khóa Gemini cho phiên này.';workflow(2);
 }
 if(!sessionKey){input.setCustomValidity('Hãy nhập khóa Gemini API trước khi dịch.');input.setAttribute('aria-invalid','true');askForKey(input);throw new Error('Chưa có khóa Gemini. Hãy nhập khóa API riêng cho phiên này rồi bấm Bắt đầu dịch.');}
 return sessionKey;
}
function rejectKey(error){
 if(!/Gemini từ chối|Khóa Gemini/u.test(error?.message||''))return;
 sessionKey='';const input=$('#api-key');input.setAttribute('aria-invalid','true');input.disabled=false;input.focus();$('#key-status').textContent='Khóa vừa nhập chưa được Gemini chấp nhận.';
}
function addUsage(value){bookRun?.recordUsage(value);for(const field of ['prompt','output','total','requests'])usage[field]+=(Number(value?.[field])||0);$('#usage-total').textContent=new Intl.NumberFormat('vi-VN').format(usage.total);const number=new Intl.NumberFormat('vi-VN');$('#usage-detail').textContent=`${number.format(usage.requests)} lần gửi · ${number.format(usage.prompt)} token gửi đi · ${number.format(usage.output)} token nhận về`;}
function updateCount(){const source=$('#source').value,length=source.length;$('#source-count').textContent=`${new Intl.NumberFormat('vi-VN').format(length)} ký tự`;$('#part-count').textContent=`${length?createTranslationPlan(source,preparedPages).length:0} phần dịch`;$('#source-lookup').disabled=!hasHan(source);updateRunBar();}
// A PDF fills the source box itself, so its empty box is hidden. On phones the action bar floats at the bottom of the
// screen once there is something to translate, or a run to stop.
function updateRunBar(){
 $('.source-panel').classList.toggle('is-pdf',/\.pdf$/iu.test(selectedFile?.name||'')||Boolean(translationState?.pdfLayout||bookJob&&!selectedFile));
 $('#run-bar').classList.toggle('is-floating',document.body.dataset.session==='in'&&(runActive||Boolean(selectedFile||bookJob||translationState||$('#source').value.trim())));
}
function segments(text,limit=5000){const pieces=[];let remaining=text;while(remaining.length>limit){let end=remaining.lastIndexOf('\n',limit);if(end<limit/2){end=0;for(const match of remaining.slice(0,limit).matchAll(/[。！？!?；;]\s*/gu))end=match.index+match[0].length;}if(end<limit/2)end=limit;if(/[\uD800-\uDBFF]/u.test(remaining[end-1]))end--;pieces.push(remaining.slice(0,end));remaining=remaining.slice(end);}if(remaining)pieces.push(remaining);return pieces;}
function clearPartStream(){const root=$('#translation-parts');root.replaceChildren();root.hidden=true;}
function renderPartStream(parts){
 const root=$('#translation-parts');root.replaceChildren();root.hidden=!parts.length;
 parts.forEach((part,index)=>{
  const card=document.createElement('details'),summary=document.createElement('summary'),title=document.createElement('span'),state=document.createElement('small'),body=document.createElement('div'),paired=document.createElement('div');
  card.className='translation-part queued';card.dataset.translationPart=String(index);title.textContent=partTitle(part,index);state.dataset.partState='';state.textContent='Chờ xử lý';body.className='translation-part-text';body.textContent='Nội dung sẽ xuất hiện ngay khi phần này dịch xong.';
  const toolbar=document.createElement('div');toolbar.className='part-toolbar';const label=document.createElement('span');label.className='reading-label';label.textContent='BẢN DỊCH TIẾNG VIỆT';toolbar.append(label);
  paired.className='translation-pair';if(part.pages.length){const originals=document.createElement('div');originals.className='part-originals';originals.id=`part-originals-${index}`;for(const number of part.pages){const image=pageImages.get(number);if(image){const entry=preparedPages.get(number);originals.append(originalPageView(number,image,entry,{onRegion:(block,region)=>openHanziPanel({text:block.text,title:`Nguyên tác · Trang ${number}`,note:['paddle','tesseract','gemini'].includes(entry?.engine)?OCR_NOTE:'',returnFocus:region})}));}}if(originals.children.length){paired.append(originals);paired.classList.add('has-original');const toggle=document.createElement('button');toggle.type='button';toggle.className='compare-toggle';toggle.textContent='Đối chiếu trang gốc';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',originals.id);toggle.addEventListener('click',()=>{const comparing=paired.classList.toggle('comparing');toggle.setAttribute('aria-expanded',String(comparing));toggle.textContent=comparing?'Ẩn trang gốc':'Đối chiếu trang gốc';});toolbar.append(toggle);}}
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
function busy(value){running=value||starting;$('#content-title').disabled=running;updateTitleControls();$('#translate').disabled=running;$('#source-file').disabled=running;$('#source').disabled=running;$('#mode').disabled=running;$('#domain').disabled=running;$('#glossary').disabled=running;$('#page-range').disabled=running;$('#pdf-layout-enabled').disabled=running;$('#api-key').disabled=running;$('#clear-key').disabled=running;$('#check-gemini-model').disabled=running;$('#gemini-model').disabled=running||!Array.from($('#gemini-model').options).some(option=>option.value);$('#stop').disabled=!running;$('#stop').hidden=!runActive;$('#book-target').disabled=running;$('#book-replace').disabled=running;$('#book-next-range').disabled=running;$('#cover-change').disabled=running;$('#cover-none').disabled=running;$('#cover-translate').disabled=running;$('#book-pages').disabled=running;document.querySelectorAll('[data-history-open],[data-history-merge],[data-book-order],[data-history-delete],[data-book-resume],[data-book-delete]').forEach(button=>{button.disabled=running;});renderBookMode();renderBookPanel();updateRunBar();}

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

async function selected(file){workflow(1);await layoutConfiguration;const isPdf=file?.name.toLowerCase().endsWith('.pdf'),useLayout=isPdf&&$('#pdf-layout-enabled').checked;if(isPdf)await pdfTools();if(file?.size>(useLayout?wholeBook.SOURCE_MAX_BYTES:isPdf?PDF_MAX_BYTES:OTHER_MAX_BYTES))throw new Error(useLayout?'PDF giữ bố cục tối đa 100 MB (tệp trên 25 MB được dịch bằng chế độ Dịch cả quyển).':isPdf?'PDF tối đa 250 MB khi xử lý tại trình duyệt.':'Tệp tối đa 25 MB.');const version=++selectionVersion;selectedFile=file;unbindBook();resetHistoryIdentity();bookTarget={id:'',replaceChapterId:''};bookChoiceTouched=false;selectedHash=fileSha256(file);selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';await dualViewer.clear();clearPartStream();$('#source').readOnly=false;$('#source').value='';$('#translation').value='';$('#warnings').textContent='';$('#download').disabled=true;$('#download-pdf').disabled=true;$('#pdf-range-options').hidden=true;$('#page-range').value='';updateCount();$('#library-match').hidden=true;if(!file){setFileStatus('Hoặc dán một đoạn tiếng Trung bên dưới.');return;}showLibraryMatch(version);
 if(useLayout){const {pdfPageCount}=await import('./pdf-client.js');setFileStatus('Đang kiểm tra số trang PDF…');const total=await pdfPageCount(file);if(version!==selectionVersion)return;$('#pdf-range-options').hidden=false;autoRange=$('#page-range').value=`1-${Math.min(3,total)}`;selectedTotalPages=total;const large=file.size>OTHER_MAX_BYTES;setFileStatus(large?`${total} trang · ${megabytes(file.size)} · tệp trên 25 MB được dịch bằng chế độ Dịch cả quyển.`:`${total} trang · dịch từng đoạn ngay trên trang; chọn phạm vi rồi bấm Bắt đầu dịch, hoặc chọn Dịch cả quyển.`);renderBookMode();if(large)setBookMode(true);prepareBookTarget(version,{suggest:true});coverTask=detectSelectedCover(file,version);findBookJob(version);return;}
 if(!isPdf){await prepare();return;}
 setFileStatus('Đang kiểm tra lớp chữ PDF trên trình duyệt…');try{const {analyzePdf}=await import('./pdf-client.js');const analysis=await analyzePdf(file,(page,total)=>{if(version===selectionVersion)setFileStatus(`Đang đọc trang ${page}/${total}…`);});if(version!==selectionVersion)return;pdfAnalysis=analysis;}catch(error){if(version!==selectionVersion)return;selectedFile=null;throw error;}
 $('#pdf-range-options').hidden=false;selectedTotalPages=pdfAnalysis.totalPages;
 const start=pdfAnalysis.mode==='scan'&&pdfAnalysis.totalPages>30?Math.max(1,Math.floor(pdfAnalysis.totalPages/2)-1):1,end=Math.min(pdfAnalysis.totalPages,start+2);
 autoRange=$('#page-range').value=start===end?String(start):`${start}-${end}`;
 if(pdfAnalysis.mode==='text'){$('#source').value=pdfAnalysis.pages.filter(page=>page.number>=start&&page.number<=end).map(page=>page.text).join('\n\n');updateCount();setFileStatus(`${pdfAnalysis.totalPages} trang có lớp chữ · đang chọn ${$('#page-range').value} · không cần nhận dạng chữ từ ảnh. Hình gốc sẽ được giữ khi dịch.`);}
 else setFileStatus(`${pdfAnalysis.pagesWithText} trang có lớp chữ · ${pdfAnalysis.scanPages} trang scan. Đang chọn ${$('#page-range').value}; bấm Bắt đầu dịch để tự nhận dạng chữ và dịch.`);
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
    if(!existing?.assessment&&!await allowOcrDownload(localOcr))throw Object.assign(new Error(`Chưa nhận dạng các trang scan vì bạn chọn để sau. Khi có Wi-Fi, bấm Bắt đầu dịch để tải bộ nhận dạng chữ (khoảng ${localOcr.DOWNLOAD_MB} MB, một lần) rồi dịch tiếp.`),{code:'ocr_declined'});
    status(`Đang nhận dạng chữ trên thiết bị · trang ${page}/${total} · không tốn token…`);
    const assessment=existing?.assessment||await localOcr.recognizeChinesePage(item.blob,message=>{
     if(message.status==='loading model')status(`Đang tải bộ nhận dạng chữ lần đầu (khoảng ${localOcr.DOWNLOAD_MB} MB) · tài liệu không rời khỏi thiết bị…`);
     if(message.status==='recognizing text')status(`Đang nhận dạng chữ trên thiết bị · trang ${page}/${total} · 0 token`);
     if(message.status==='fallback')status('PaddleOCR chưa chạy được · chuyển sang Tesseract trên thiết bị…');
    });
    if(assessment.fallbackReason)ocrWarnings.push(`PaddleOCR chưa sẵn sàng; đã dùng Tesseract cục bộ (${assessment.fallbackReason}).`);
    const fallback=shouldUseGeminiOcr('hybrid',assessment);
    if(fallback&&optionalKey()){
     ocrWarnings.push(`Trang ${page}: nhận dạng chữ trên thiết bị chỉ đạt ${assessment.confidence}% nên đã dùng Gemini cho riêng trang này.`);
     status(`Trang ${page}/${total} khó đọc · đang chuyển riêng trang này sang Gemini…`);preparedPages.set(page,{text:await geminiOcr(item.blob,page),layout:assessment.layout,engine:'gemini',needsGemini:false,assessment});
    }else{
     preparedPages.set(page,{text:assessment.text,layout:assessment.layout,engine:assessment.engine,confidence:assessment.confidence,metrics:assessment.metrics,assessment,needsGemini:assessment.needsGemini});
     if(assessment.needsGemini)ocrWarnings.push(`Trang ${page}: nhận dạng chữ trên thiết bị đạt ${assessment.confidence}% và có thể thiếu chữ hoặc công thức${!optionalKey()?' (chưa có khóa để dùng Gemini dự phòng; nhập khóa rồi bấm Bắt đầu dịch lại để thử trang này bằng Gemini)':''}. Hãy đối chiếu ảnh gốc.`);
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

// On Save-Data or a slow connection the first local OCR asks before downloading its engine; the answer holds for this tab.
// Without navigator.connection (Safari, Firefox) nothing is asked, as before. Dừng counts as "Để sau".
let ocrDownloadAllowed=false,ocrChoice=null;
async function allowOcrDownload(localOcr){
 if(ocrDownloadAllowed)return true;
 const connection=navigator.connection,slow=Boolean(connection?.saveData)||/^(?:slow-2g|2g|3g)$/u.test(connection?.effectiveType||'');
 if(!slow||await localOcr.localOcrCached())return ocrDownloadAllowed=true;
 $('#ocr-download-text').textContent=`Tài liệu có trang scan. Hoa Trí nhận dạng chữ ngay trên thiết bị (không tốn token), nhưng lần đầu cần tải khoảng ${localOcr.DOWNLOAD_MB} MB${connection.saveData?' trong khi trình duyệt đang bật chế độ tiết kiệm dữ liệu':' qua một kết nối đang chậm'}. Những lần sau trình duyệt dùng lại bản đã tải.`;
 $('#ocr-download').hidden=false;status('Đang chờ bạn chọn có tải bộ nhận dạng chữ hay không…');$('#ocr-download-yes').focus();
 const allowed=await new Promise(resolve=>{ocrChoice=resolve;});ocrChoice=null;$('#ocr-download').hidden=true;$('#progress').focus();
 return ocrDownloadAllowed=allowed;
}
function hasUsableKey(){return !!(sessionKey||$('#api-key').value.trim());}
function needsPreparation(){
 if(!selectedFile||!selectedFile.name.toLowerCase().endsWith('.pdf'))return false;
 if(!pdfAnalysis)return false;
 let range='';try{range=translationRange().text;}catch{return true;}
 if(preparedRangeKey!==range||!preparedPages.size)return true;
 // A key arriving after a weak local-only OCR pass should trigger one retry of just those pages.
 return hasUsableKey()&&[...preparedPages.values()].some(entry=>entry?.needsGemini);
}
// The pressed button is disabled while the run goes on: keyboard focus moves to Dừng (or the progress line) and comes
// back to Bắt đầu dịch when the run ends, unless something else (the key field) took it on purpose.
async function run(){
 if(running||starting)return;requireContentTitle();const pressed=document.activeElement===$('#translate');starting=true;runActive=true;busy(true);
 if(pressed)($('#stop').hidden?$('#progress'):$('#stop')).focus({preventScroll:true});
 try{
  await layoutConfiguration;
  if(bookMode&&bookAvailable()){await selectionTask;return await runWholeBook();}
  if($('#pdf-layout-enabled').checked&&(selectedFile?.name.toLowerCase().endsWith('.pdf')||translationState?.pdfLayout)){await selectionTask;return await runPdfLayout({fromRun:true});}
  await ensureStudyModel('text');
  if(selectedFile&&!pdfAnalysis&&selectedFile.name.toLowerCase().endsWith('.pdf'))status('Đang chờ phân tích PDF; hệ thống sẽ tự nhận dạng chữ và dịch ngay sau đó…');
  return await runStudyTranslation({selectionTask,requireKey:key,needsPreparation,hasSource:()=>Boolean($('#source').value.trim()),hasFile:()=>Boolean(selectedFile),prepare,translate});
 }finally{starting=false;runActive=false;busy(false);if(pressed&&[document.body,$('#stop'),$('#progress')].includes(document.activeElement))$('#translate').focus({preventScroll:true});}
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
// A whole-book chunk starts with the book's terms and the context the chunk before it left.
// Its terms stay fixed (fixedGlossary): a later chunk never renames what the book already says, unless the student does.
async function adoptPdfLayout(result,{glossary={},context=''}={}){
 await dualViewer.clear();pdfLayoutDocument=result.document;pdfExportUrl='';const manualGlossary=parseStudyGlossary($('#glossary').value);
 translationState={mode:$('#mode').value,domain:$('#domain').value,done:0,context,glossary:{...glossary,...manualGlossary},manualGlossary,fixedGlossary:glossary,pdfLayout:{assetId:result.assetId,ocrPending:true}};syncLayoutParts();
 translationParts=[];clearPartStream();$('#download-pdf').disabled=true;$('#warnings').textContent=(pdfLayoutDocument.warnings||[]).join('\n');syncPdfText();
}
// Returns false when shouldStop ended it early; the manifest keeps every batch already read, so it resumes from there.
// heartbeat (whole-book runs) follows every batch: it keeps the job held while a long chunk is read.
async function correctPdfOcr(model,{shouldStop=()=>false,heartbeat=async()=>{}}={}){
 // A manifest with OCR sheets is read a whole sheet (several blocks, one image) at a time.
 const {ocrImageBatches}=await boxLayout(),pages=pdfLayoutDocument.pages.filter(p=>p.ocr),blocks=pages.flatMap(p=>p.blocks),pending=blocks.filter(b=>!b.ocrCorrected);
 let done=blocks.length-pending.length;for(const ids of ocrImageBatches(pending,undefined,pages.flatMap(p=>p.ocrSheets||[]))){if(shouldStop())return false;status(`Đang đọc lại chữ trong ảnh đoạn ${Math.min(done+1,blocks.length)}–${Math.min(done+ids.length,blocks.length)}/${blocks.length}…`);const output=await api('pdf-layout/ocr-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,blockIds:ids,apiKey:key(),model})});pdfLayoutDocument=output.document;model=output.model||model;addUsage(output.usage);if(output.warnings?.length)$('#warnings').textContent+=output.warnings.join('\n')+'\n';done+=ids.length;await heartbeat();}
 // History requires parts to match the manifest, which now holds the corrected sources.
 syncLayoutParts();delete translationState.pdfLayout.ocrPending;syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,[]);return true;
}
function syncPdfText(){
 const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks);$('#source').value=blocks.map(b=>b.text).join('\n\n');$('#source').readOnly=true;$('#source-lookup').disabled=!hasHan($('#source').value);
 $('#translation').value=blocks.map((b,i)=>{let text=translationParts[i]||'';for(const inline of b.inlines||[])text=text.replace(inline.token,inline.text);return text;}).filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value;$('#source-count').textContent=`${$('#source').value.length} ký tự`;$('#part-count').textContent=`${blocks.length} đoạn`;
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
   resetHistoryIdentity();activeHistoryMeta={title:priorTitle,filename:priorFilename};await adoptPdfLayout(result);await saveBeforeSpending();
  }
  if(!translationState?.pdfLayout||selectedFile&&pdfLayoutRange!==range){
   if(!selectedFile)throw new Error('Hãy chọn PDF gốc.');status('Đang tách ảnh, công thức và các đoạn chữ cùng vị trí của chúng trên trang PDF…');const form=new FormData(),sha256=await selectedHash;form.set('file',selectedFile);form.set('pages',range);if(sha256)form.set('sha256',sha256);const result=await api('pdf-layout/extract',{method:'POST',body:form});
   // Phones on plain HTTP cannot hash in the browser; the Worker's hash still lets the book and its cover remember this file.
   if(!selectedSha256&&/^[a-f\d]{64}$/u.test(result.document?.sourceSha256||''))selectedSha256=result.document.sourceSha256;
   resetHistoryIdentity();pdfLayoutRange=range;if(bookChoiceActive())updateBookHint();clearPageImages();await adoptPdfLayout(result);await saveBeforeSpending();
  }
  const outcome=await translateLayoutSession(selectedModel),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks);
  if(outcome.idle){$('#download-pdf').disabled=false;status('Đã dịch đủ các đoạn. Bấm Xuất PDF tiếng Việt để tải bản giữ bố cục.');return;}
  const complete=outcome.complete;$('#download-pdf').disabled=!complete;status(complete?'Đã dịch đủ các đoạn. Đang xuất PDF tiếng Việt…':`Đã dừng sau ${translationState.done}/${blocks.length} đoạn. ${unsaved?'Chưa lưu được tiến độ vào tài khoản: đừng đóng tab, bấm Bắt đầu dịch để thử lưu lại.':'Tiến độ đã lưu; có thể dịch tiếp từ Lịch sử dịch.'}`);
  if(complete)await exportLayoutPdf(false);
 }catch(error){rejectKey(error);fail(error);}finally{busy(false);stopRequested=false;}
}
// OCR (when pending) and the remaining block batches of the open layout session; errors reach the caller. pageStop
// (whole-book runs): a stop waits until the page being translated is finished, so no page is left half translated.
// heartbeat (whole-book runs) follows every saved batch, keeping the job held through a long chunk.
async function translateLayoutSession(model,{pageStop=false,shouldStop=()=>stopRequested,heartbeat=async()=>{}}={}){
 if(translationState.pdfLayout.ocrPending||pdfOcrResumable()){if(!await correctPdfOcr(model,{shouldStop:pageStop?shouldStop:()=>false,heartbeat}))return {complete:false,model,idle:false};}
 // A save can land between the last OCR batch and the history update; untranslated parts follow the manifest.
 else if(!translationState.done)syncLayoutParts();
 const {blockBatches}=await boxLayout(),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),pageOf=new Map(pdfLayoutDocument.pages.flatMap(page=>page.blocks.map(b=>[b.id,page.number])));await saveBeforeSpending();
 const idle=translationState.done===blocks.length;
 while(translationState.done<blocks.length){
  let [batch]=blockBatches(blocks.slice(translationState.done));
  if(shouldStop()){const page=translationState.done?pageOf.get(blocks[translationState.done-1].id):0;if(!pageStop||!page||pageOf.get(batch[0].id)!==page)break;batch=batch.filter(b=>pageOf.get(b.id)===page);}
  status(`Đang dịch đoạn ${translationState.done+1}–${translationState.done+batch.length}/${blocks.length}…`);
  const result=await api('translate-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model,blocks:batch.map(({id,source})=>({id,source})),domain:translationState.domain,mode:translationState.mode,context:translationState.context,glossary:translationState.glossary})});
  // Counted before the checks below: tokens are spent even when an answer is refused.
  addUsage(result.usage);
  if(result.model){model=result.model;$('#gemini-model-status').textContent=`Đã dùng ${result.model}.`;if([...$('#gemini-model').options].some(o=>o.value===result.model))$('#gemini-model').value=result.model;}
  const translated=new Map(result.blocks.map(b=>[b.id,b.translation]));for(const b of batch){const text=translated.get(b.id);if(!text)throw new Error(`Gemini trả thiếu bản dịch của đoạn ${b.id}.`);translationParts[translationState.done++]=text;}
  if(result.warnings?.length)$('#warnings').textContent+=result.warnings.join('\n')+'\n';
  translationState.context=result.context||translationState.context;translationState.glossary={...translationState.glossary,...result.glossary,...translationState.fixedGlossary,...translationState.manualGlossary};syncPdfText();await dualViewer.update(pdfTranslations());await saveBeforeSpending();workflow(3);
  await heartbeat();
 }
 return {complete:translationState.done===blocks.length,model,idle};
}
// show:false (whole-book runs) skips loading every exported chunk into the viewer.
async function exportLayoutPdf(download=true,{show=true}={}){
 if(!translationState?.pdfLayout||!activeHistoryId)throw new Error('Hãy dịch và lưu đủ các đoạn trước khi xuất PDF.');
 if(!pdfExportUrl){status('Đang đo chữ, điều chỉnh cỡ font và xuất PDF tiếng Việt…');const result=await api('pdf-layout/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,historyId:activeHistoryId})});pdfExportUrl=result.url;translationState.pdfLayout.exported=true;translationState.pdfLayout.renderVersion=result.renderVersion||2;if(show)await dualViewer.setExportedPdf(result.url);}
 status(show?'PDF tiếng Việt đã được lưu vào Thư viện riêng. Hai bản đang hiển thị song song.':'PDF tiếng Việt của phần này đã được lưu vào Thư viện riêng.');
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
  if(pageImages.size&&domain==='math')$('#warnings').textContent+='Nhận dạng chữ không xác nhận tính đúng của công thức. Hãy đối chiếu ký hiệu với hình gốc.\n';
 }else{
  for(const term of Object.keys(translationState.manualGlossary||{}))if(!Object.hasOwn(manualGlossary,term))delete translationState.glossary[term];
  translationState.manualGlossary=manualGlossary;Object.assign(translationState.glossary,manualGlossary);
  if(!$('#translation-parts').children.length){renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});}
 }
 if(translationState.done===parts.length){
  // A finished translation whose last save failed: Bắt đầu dịch saves it again (setUnsaved says so), without Gemini.
  if(unsaved){busy(true);try{status('Đang lưu bản dịch vào tài khoản…');const saved=await saveHistory();if(saved)status(saved.libraryStoryId&&saved.status==='complete'?'Đã lưu bản dịch. Bản dịch đã có trong Thư viện riêng.':'Đã lưu bản dịch vào tài khoản.');else status('Vẫn chưa lưu được bản dịch vào tài khoản. Đừng đóng tab; kiểm tra mạng rồi bấm Bắt đầu dịch để thử lại.','error');}finally{busy(false);}return;}
  status('Tài liệu này đã dịch xong trong phiên. Không gọi Gemini lại.');return;
 }
 key();busy(true);stopRequested=false;let activeIndex=-1,lastSaved=null;
 try{
  lastSaved=await saveBeforeSpending();
  for(let index=translationState.done;index<parts.length;index++){
   if(stopRequested)break;activeIndex=index;const part=parts[index];updatePart(index,undefined,'working');status(`Đang dịch phần ${index+1}/${parts.length}…`);
   const result=await api('translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model:$('#gemini-model').value,source:part,mode,domain,context:translationState.context,glossary:translationState.glossary,previousSource:translationState.previousSource,previousTranslation:translationState.previousTranslation})});
   translationParts[index]=result.translation;updatePart(index,result.translation,'done');$('#translation').value=translationParts.join('\n\n');$('#download').disabled=false;renderPageImages();workflow(3);
   translationState.context=result.context||translationState.context;translationState.glossary={...(result.glossary||translationState.glossary),...translationState.manualGlossary};translationState.previousSource=part.slice(-350);translationState.previousTranslation=result.translation.slice(-500);translationState.done=index+1;addUsage(result.usage);
   if(result.warnings?.length)$('#warnings').textContent+=`Phần ${index+1}: ${result.warnings.join('; ')}\n`;
   activeIndex=-1;lastSaved=await saveBeforeSpending(index===parts.length-1)||lastSaved;
  }
  status(stopRequested?`Đã dừng sau ${translationState.done}/${parts.length} phần. Tiến độ đã lưu vào tài khoản; bấm Bắt đầu dịch để tiếp tục.`:lastSaved?.libraryStoryId&&lastSaved.status==='complete'?`Hoàn tất ${parts.length} phần. Bản dịch đã được lưu vào Thư viện riêng.`:`Hoàn tất ${parts.length} phần. Hãy đối chiếu bản dịch với nguyên tác.`);
 }catch(error){if(activeIndex>=0)updatePart(activeIndex,undefined,'failed');rejectKey(error);fail(error);}finally{busy(false);stopRequested=false;}
}

// ---- "Dịch cả quyển" ----
const bookAvailable=()=>Boolean(layoutConfig.configured&&$('#pdf-layout-enabled').checked&&(/\.pdf$/iu.test(selectedFile?.name||'')||bookJob&&!selectedFile));
// Over 25 MB only this mode takes a PDF: chunks are cut on the device before anything is extracted. A run continued from
// the history has no picked file at all and reads the original kept in the account.
const bookForced=()=>Boolean(selectedFile?selectedFile.size>OTHER_MAX_BYTES:bookJob);
const megabytes=bytes=>bytes<1048576?`${Math.max(1,Math.round(bytes/1024))} KB`:`${new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1}).format(bytes/1048576)} MB`;
function translateLabel(text){const node=[...$('#translate').childNodes].find(item=>item.nodeType===3);if(node)node.nodeValue=`${text} `;}
function bookFileStatus(){if(selectedFile&&selectedTotalPages)setFileStatus(bookMode?`${selectedTotalPages} trang · ${megabytes(selectedFile.size)} · Hoa Trí tự chia thành từng lượt tối đa 20 trang; bìa và trang không có chữ Trung không tốn token.`:`${selectedTotalPages} trang · dịch từng đoạn ngay trên trang; chọn phạm vi rồi bấm Bắt đầu dịch, hoặc chọn Dịch cả quyển.`);}
// quiet: a countdown's later seconds are shown, not read aloud each second by a screen reader.
function bookStatus(text,{quiet=false}={}){bookStatusText=text;const line=$('#whole-book-status');if(!line)return;line.setAttribute('aria-live',quiet?'off':'polite');line.textContent=text;}
function renderBookMode(){
 const field=$('#book-mode');if(!field)return;field.hidden=!bookAvailable();
 const range=field.querySelector('input[value="range"]'),whole=field.querySelector('input[value="book"]');
 range.disabled=running||bookForced();whole.disabled=running;(bookMode?whole:range).checked=true;
 $('#book-mode-note').textContent=selectedFile&&bookForced()?'Tệp trên 25 MB chỉ dịch được bằng chế độ Dịch cả quyển: Hoa Trí chia tệp thành từng lượt ngay trên thiết bị.':'';
}
function setBookMode(on){
 bookMode=Boolean(on);$('#whole-book').hidden=!bookMode;$('#range-fields').hidden=bookMode;$('#book-target-group').hidden=bookMode;
 $('#stop').textContent=bookMode?'Dừng sau trang hiện tại':'Dừng sau lượt hiện tại';if(!bookMode)translateLabel('Bắt đầu dịch');
 if(bookMode)startBookSurvey();renderBookMode();updateTitleControls();renderCover();
}
function unbindBook(){
 const bound=Boolean(bookJob),pages=$('#book-pages');bookJob=null;bookSource=null;bookSurvey=null;bookChunkId='';bookContext='';bookHashTask=null;bookPagesEdited=false;bookBusy=false;bookStatus('');pages.value='';pages.setCustomValidity('');pages.removeAttribute('aria-invalid');
 if(bound)$('#content-title-hint').textContent='Tên này xuất hiện trong lịch sử, Thư viện riêng và tệp tải xuống.';
 if(bookMode)setBookMode(false);else{renderBookMode();updateTitleControls();}
}
function bindBookJob(job){
 bookJob=job;const title=$('#content-title');title.value=job.title||'';title.setCustomValidity('');title.removeAttribute('aria-invalid');
 // The page field shows the pages this job translates (empty for a whole book); only the student's own edit changes them.
 const pages=$('#book-pages');pages.value=wholeBook.chosenPagesText(job.pageStates);pages.setCustomValidity('');pages.removeAttribute('aria-invalid');bookPagesEdited=false;bookBusy=false;
 $('#content-title-hint').textContent='Tên sách của lượt dịch cả quyển; đổi tên sách trong Lịch sử dịch (Sắp xếp phần).';
 for(const [select,value] of [[$('#domain'),job.domain],[$('#mode'),job.mode]])if([...select.options].some(option=>option.value===value))select.value=value;
 const count=wholeBook.countStates(job.pageStates);
 bookStatus(count.pending||count.failed?`Quyển này đã có tiến độ: ${wholeBook.progressText(job.pageStates)}. Bấm ${count.pending?'Tiếp tục dịch cả quyển':'Thử lại các trang lỗi'}; trang đã dịch không tốn token lại.`:'Quyển này đã dịch xong. Mở Thư viện riêng để đọc hoặc tải cả quyển.');
 setBookMode(true);bookFileStatus();
}
function bookChosenPages(total){const value=$('#book-pages').value.trim();return value?parseStudyPageRange(value,total,Infinity):null;}
// The page states the panel shows: the job's with an edited range field applied, or, before there is a job, the picked
// file's.
function bookStates(){
 const total=bookJob?.totalPages||selectedTotalPages;if(!total)return '';let chosen=null;try{chosen=bookChosenPages(total);}catch{}
 if(bookJob)return running||!bookPagesEdited?bookJob.pageStates:wholeBook.withStates(bookJob.pageStates,wholeBook.rangeUpdates(bookJob.pageStates,chosen));
 return wholeBook.initialPageStates(total,{cover:coverExcluded()?cover.page:0,pages:chosen});
}
function bookButtonLabel(states){
 if(!bookJob)return 'Dịch cả quyển';if(bookBusy&&!running)return 'Chờ rồi dịch tiếp';const count=wholeBook.countStates(states);
 if(count.pending)return count.done||bookJob.status!=='ready'?'Tiếp tục dịch cả quyển':'Dịch cả quyển';
 return count.failed?'Thử lại các trang lỗi':'Đã dịch xong';
}
function renderBookPanel(){
 if(!bookMode)return;
 const states=bookStates(),total=bookJob?.totalPages||selectedTotalPages,label=bookButtonLabel(states),facts=[];
 translateLabel(label);$('#translate').disabled=running||label==='Đã dịch xong';
 if(bookJob)facts.push(bookJob.filename||'PDF gốc');if(total)facts.push(`${total} trang`);if(selectedFile)facts.push(megabytes(selectedFile.size));
 facts.push(bookJob?(bookJob.pageStates.includes('c')?`bìa: trang ${bookJob.pageStates.indexOf('c')+1}`:'không dùng bìa'):cover.detecting&&!cover.page?'đang tìm bìa…':coverExcluded()?`bìa: trang ${cover.page}`:'không dùng bìa');
 if(bookJob&&!selectedFile)facts.push('bản gốc lấy từ tài khoản');
 $('#whole-book-summary').textContent=total?facts.join(' · '):'Đang đọc số trang…';
 $('#whole-book-count').textContent=states?wholeBook.progressText(states):'';$('#whole-book-note').textContent=states?wholeBook.progressNote(states):'';
 $('#whole-book-tokens').textContent=bookJob?`Quyển này đã dùng ${wholeBook.formatTokens((Number(bookJob.usage?.total)||0)+(bookRun?.usage.total||0))} token Gemini`:'';
 wholeBook.renderPageGrid($('#page-grid'),states,bookWorking);renderBookEstimate(states);
 const read=$('#book-read');read.hidden=!bookJob?.storyId;if(bookJob?.storyId)read.href=`/?read=${encodeURIComponent(bookJob.storyId)}`;
 $('#whole-book-status').textContent=bookStatusText;
}
function renderBookEstimate(states){
 // Nothing left to translate, nothing to estimate: exporting again or downloading the book costs no token.
 const root=$('#whole-book-estimate');root.replaceChildren();root.hidden=!wholeBook.countStates(states).pending;if(root.hidden)return;
 const f=wholeBook.formatTokens,[textLow,textHigh]=wholeBook.PAGE_TOKENS.text,[scanLow,scanHigh]=wholeBook.PAGE_TOKENS.scan,list=document.createElement('ul');
 const line=(text,tag='li',className='')=>{const item=document.createElement(tag);item.textContent=text;if(className)item.className=className;return item;};
 const head=line('','p','estimate-head'),strong=document.createElement('strong'),note=document.createElement('small');strong.textContent='Ước tính token Gemini';note.textContent='chỉ là ước tính';head.append(strong,' ',note);root.append(head);
 if(bookSurvey?.kinds.length||!bookJob){
  const estimate=wholeBook.estimateTokens(states,bookSurvey?.kinds||[]);
  if(estimate.text)list.append(line(`${estimate.text} trang có lớp chữ × ${f(textLow)}–${f(textHigh)} token`));
  if(estimate.scan)list.append(line(`${estimate.scan} trang scan (Gemini đọc ảnh) × ${f(scanLow)}–${f(scanHigh)} token`));
  if(estimate.unknown)list.append(line(`${estimate.unknown} trang ${bookSurvey&&!bookSurvey.done&&!bookSurvey.failed?'đang khảo sát':'chưa rõ loại'} × ${f(textLow)}–${f(scanHigh)} token`));
  list.append(line('Bìa, trang trống và trang bỏ qua: 0 token'));root.append(list);
  if(estimate.high)root.append(line(`Còn lại khoảng ${wholeBook.formatTokenRange(estimate.low,estimate.high)} token.`,'p','estimate-total'));
 }else{list.append(line(`Trang có lớp chữ: khoảng ${f(textLow)}–${f(textHigh)} token`),line(`Trang scan (Gemini đọc ảnh): khoảng ${f(scanLow)}–${f(scanHigh)} token`),line('Bìa, trang trống và trang bỏ qua: 0 token'));root.append(list);}
 // Once pages are done, the book's own average says more than the generic range.
 const projection=bookJob?wholeBook.usageProjection({...bookJob,pageStates:states}):null;
 if(projection?.pending)root.append(line(`Theo mức quyển này đã dùng (khoảng ${f(projection.perPage)} token mỗi trang): còn khoảng ${f(projection.remaining)} token cho ${projection.pending} trang.`,'p','estimate-total'));
 if(bookSurvey&&!bookSurvey.done&&!bookSurvey.failed)root.append(line(`Đang đọc lớp chữ của tệp: ${bookSurvey.kinds.length}/${bookSurvey.total||'?'} trang…`,'p'));
 root.append(line('Số token thật tùy lượng chữ, công thức và phiên bản Gemini; trang trống chỉ biết sau khi tách trang.','p','hint'));
}
// Text layers only (no drawing): a 300-page book takes seconds, after the cover detector is done with the file.
function startBookSurvey(){
 const file=selectedFile;if(!file||bookSurvey?.file===file)return;
 const survey=bookSurvey={file,kinds:[],total:selectedTotalPages,done:false,failed:false},current=()=>bookSurvey===survey;
 Promise.resolve(coverTask).catch(()=>{}).then(()=>current()?wholeBook.surveyPages(file,{cancelled:()=>!current(),onProgress:kinds=>{if(current()){survey.kinds=kinds;renderBookPanel();}}}):null)
  .then(kinds=>{if(kinds&&current()){survey.kinds=kinds;survey.done=true;renderBookPanel();}}).catch(()=>{if(current()){survey.failed=true;renderBookPanel();}});
}
// whole-book.js is loaded before the jobs are kept: every view of a job needs it.
async function loadBookJobs(){const data=await api('book-jobs').catch(()=>null);if(data){const jobs=Array.isArray(data.jobs)?data.jobs:[];if(jobs.length)await pdfTools();bookJobs=jobs;}if(bookJob)bookJob=bookJobs.find(job=>job.id===bookJob.id)||bookJob;if(!bookRun&&bookJobs.length)flushBookReports();return bookJobs;}
// Tokens a run in this browser spent but could not report (its last report failed, the tab closed) are sent the next
// time the jobs are listed: tokens only, accepted whichever device runs the book, each report counted once.
function flushBookReports(){
 for(const job of bookJobs){
  const pending=bookReports().load(job.id).slice(0,20);if(!pending.length)continue;
  api(`book-jobs/${encodeURIComponent(job.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({reports:pending})}).then(data=>{const sent=new Set(pending.map(report=>report.id));bookReports().save(job.id,bookReports().load(job.id).filter(report=>!sent.has(report.id)));upsertJob(data?.job);renderBookPanel();renderStudyBooks();}).catch(()=>{});
 }
}
function upsertJob(job){if(!job?.id)return job;const index=bookJobs.findIndex(entry=>entry.id===job.id);if(index>=0)bookJobs[index]=job;else bookJobs.unshift(job);if(bookJob?.id===job.id)bookJob=job;return job;}
async function patchBookJob(id,body){const data=await api(`book-jobs/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return upsertJob(data?.job||data);}
// The picked file's SHA-256, also over 25 MB where the shared hash stops: it names the stored original.
function bookHash(){
 if(!bookHashTask){const file=selectedFile;bookHashTask=selectedHash.then(hash=>hash||(file?file.arrayBuffer().then(wholeBook.digestHex):''));}
 return bookHashTask;
}
// A picked PDF that already has a whole-book run (the same file, on any device) continues it instead of starting over.
async function findBookJob(version){
 try{
  await loadBookJobs();if(version!==selectionVersion||!bookJobs.length)return;
  const sha256=await bookHash();if(version!==selectionVersion||!sha256)return;
  // An unfinished run is continued at once (so no page is paid for twice); a finished one shows only in "Dịch cả quyển".
  const job=bookJobs.find(entry=>entry.sourceSha256===sha256&&entry.status!=='done')||(bookMode?bookJobs.find(entry=>entry.sourceSha256===sha256):null);
  if(job&&!running)bindBookJob(job);renderHistory();
 }catch{}
}
// "Tiếp tục" in the history: the run goes on from the original kept in the account; no file to pick again.
async function openBookJob(id){
 if(running)return;const job=bookJobs.find(entry=>entry.id===id);if(!job)return;
 await Promise.all([layoutConfiguration,pdfTools()]);if(!layoutConfig.configured)throw new Error('Dịch vụ PDF giữ bố cục chưa sẵn sàng nên chưa dịch tiếp được quyển này. Hãy thử lại sau.');$('#pdf-layout-enabled').checked=true;
 const version=++selectionVersion;busy(true);
 try{
  const same=Boolean(selectedFile)&&await bookHash()===job.sourceSha256;if(version!==selectionVersion)return;
  if(!same){
   unbindBook();await dualViewer.clear();selectedFile=null;selectedHash=Promise.resolve('');resetCover();autoRange='';pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';clearPartStream();
   $('#source').readOnly=false;$('#source').value='';$('#translation').value='';$('#warnings').textContent='';$('#download').disabled=true;$('#download-pdf').disabled=true;$('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';$('#library-match').hidden=true;updateCount();
   setFileStatus(`${job.filename||'PDF gốc'} · dùng bản gốc đã lưu trong tài khoản, không cần chọn lại tệp.`);
  }
  resetHistoryIdentity();selectedSha256=job.sourceSha256;selectedTotalPages=job.totalPages;bookTarget={id:job.storyId||'',replaceChapterId:''};bindBookJob(job);workflow(2);
  $('.workspace').scrollIntoView({behavior:'smooth',block:'start'});
 }finally{busy(false);}
 if(version!==selectionVersion)return;
 if(sessionKey||$('#api-key').value.trim())await run();else{$('#api-key').focus();status('Dán khóa Gemini rồi bấm Tiếp tục dịch cả quyển.');}
}
// The original as pdf-lib reads it: the picked file, or the copy kept in the account when a run continues after a reload.
async function prepareBookSource(){
 const wanted=bookJob?.sourceSha256||'';if(bookSource&&(!wanted||bookSource.sha256===wanted))return bookSource;
 const {PDFDocument}=await wholeBook.loadPdfLib();let bytes,file=selectedFile,sha256='';
 if(file){
  bookStatus('Đang đọc tệp PDF trên thiết bị…');bytes=new Uint8Array(await file.arrayBuffer());sha256=await selectedHash||await wholeBook.digestHex(bytes);bookHashTask=Promise.resolve(sha256);
  if(wanted&&sha256!==wanted)throw new Error('Tệp đang chọn không phải bản gốc của quyển đang dịch dở. Hãy chọn đúng tệp, hoặc bấm Tiếp tục ở quyển đó trong Lịch sử dịch.');
 }else{
  if(!wanted)throw new Error('Hãy chọn PDF gốc.');
  bookStatus('Đang lấy bản gốc từ tài khoản…');bytes=await wholeBook.downloadSource(wanted,{onProgress:share=>bookStatus(`Đang lấy bản gốc từ tài khoản… ${Math.round(share*100)}%`)});
  sha256=wanted;file=new File([bytes],bookJob.filename||'nguyen-tac.pdf',{type:'application/pdf'});
 }
 bookStatus('Đang mở PDF để chia lượt dịch…');const doc=await wholeBook.openSourcePdf(PDFDocument,bytes),totalPages=doc.getPageCount();
 if(bookJob&&totalPages!==bookJob.totalPages)throw new Error(`Bản gốc có ${totalPages} trang, khác ${bookJob.totalPages} trang của lượt dịch này.`);
 selectedSha256=sha256;bookStatus('');
 return bookSource={sha256,file,filename:file.name,totalPages,cut:pages=>wholeBook.cutChunk(PDFDocument,doc,pages)};
}
// The original goes to the account once (HEAD first): every chunk is cut from it, here or on another device.
async function uploadOriginal(source){
 const url=`/api/my/study/sources/${source.sha256}`,head=await fetch(url,{method:'HEAD',credentials:'same-origin'}).catch(()=>null);
 if(head?.status===401)throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.');if(head?.ok)return;
 const label='Đang tải bản gốc lên tài khoản (một lần cho cả quyển)…';bookStatus(label);
 await wholeBook.uploadSource(url,source.file,{pages:source.totalPages,filename:source.filename,onProgress:share=>bookStatus(`${label} ${Math.round(share*100)}%`)});bookStatus('');
}
async function createBookJob(source){
 const title=requireContentTitle(),coverPage=coverExcluded()?cover.page:0,matching=matchingBook();let job;
 try{job=(await api('book-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceSha256:source.sha256,totalPages:source.totalPages,filename:source.filename,title,domain:$('#domain').value,mode:$('#mode').value,chunkSize:wholeBook.CHUNK_PAGES,...(coverPage?{coverPage}:{}),...(matching?{storyId:matching.id}:{}),glossary:parseStudyGlossary($('#glossary').value)})})).job;}
 // The file already has an unfinished run (another tab or device started it): that run goes on.
 catch(error){if(error.data?.code!=='job_exists'||!error.data.job)throw error;return upsertJob(error.data.job);}
 // Pages the chosen book already has from this file (ranges translated by hand) are not paid for again.
 const owned=matching?matching.parts.filter(part=>Array.isArray(part.pages)&&sameSource(part,{sha256:source.sha256,filename:source.filename,totalPages:source.totalPages})).flatMap(part=>part.pages):[];
 const updates={...wholeBook.rangeUpdates(job.pageStates,bookChosenPages(source.totalPages)),...wholeBook.statesFor(owned.filter(page=>wholeBook.stateAt(job.pageStates,page)==='pending'),'done')};
 return Object.keys(updates).length?patchBookJob(job.id,{pages:updates}):upsertJob(job);
}
// A run continued without the picked file still gives a new book its cover image, drawn from the stored original.
async function ensureBookCover(source){
 const page=bookJob.pageStates.indexOf('c')+1;if(selectedFile||!page||cover.page===page&&cover.jpeg||studyBooks.find(book=>book.id===bookJob.storyId)?.cover?.image)return;
 const jpeg=await coverTools.pageJpeg(source.file,page).catch(()=>null);Object.assign(cover,{page,source:'detected',replace:false,synced:'',note:''});setCoverImage(jpeg);
}
// A chunk session saved earlier (in another tab, before a reload) becomes the open session again, as the history opens it.
async function resumeChunkSession(id){
 const item=await api(`history/${encodeURIComponent(id)}`),state=item.state||{};if(!state.pdfLayout)throw Object.assign(new Error('Phần này không có bố cục PDF.'),{status:409});
 const document=await api(`pdf-layout/assets/${state.pdfLayout.assetId}/manifest`);
 await dualViewer.clear();pdfLayoutDocument=document;pdfExportUrl='';pdfLayoutRange='';clearPageImages();
 activeHistoryId=item.id;activeHistoryMeta={title:item.title,filename:item.filename};bookChunkId=item.id;bookTarget={id:item.library_story_id||bookJob?.storyId||'',replaceChapterId:''};
 const parts=Array.isArray(state.parts)?state.parts:[];translationParts=Array.isArray(state.translationParts)?state.translationParts.slice(0,parts.length):[];while(translationParts.length<parts.length)translationParts.push('');
 const fixedGlossary={...(bookJob?.glossary||{})};translationState={source:state.source||'',domain:item.domain||'general',mode:item.mode||'economy',parts,plan:parts.map(text=>({text,pages:[],blockIds:{}})),done:Math.min(Number(state.done)||0,parts.length),context:state.context||'',glossary:{...(state.glossary||{}),...fixedGlossary,...(state.manualGlossary||{})},manualGlossary:state.manualGlossary||{},fixedGlossary,previousSource:'',previousTranslation:'',pdfLayout:state.pdfLayout};
 // OCR that never finished goes on from the manifest, which keeps every batch already read and paid for.
 if(!translationState.done&&document.pages.some(page=>page.ocr&&page.blocks.some(b=>!b.ocrCorrected)))translationState.pdfLayout.ocrPending=true;
 if(state.pdfLayout.exported&&state.pdfLayout.renderVersion>=3)pdfExportUrl=`/api/my/study/pdf-layout/assets/${state.pdfLayout.assetId}/translated`;
 clearPartStream();syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());
}
// One chunk, done exactly as a range picked by hand; createBookRun (whole-book.js) drives these steps and the job.
const transient=error=>error?.status===0||error?.status===429||error?.status>=500;
const bookSteps={
 async open(job,chunk){
  // The chunk this tab stopped in goes on where it was; one saved elsewhere is opened again (its tokens are spent).
  if(bookChunkId&&bookChunkId===activeHistoryId&&translationState?.pdfLayout&&pdfLayoutDocument?.pages.some(page=>page.number===chunk.start))return {document:pdfLayoutDocument};
  const item=wholeBook.findChunkSession(historyItems,job,chunk.start);if(!item)return null;
  try{await resumeChunkSession(item.id);}catch(error){if(transient(error))throw error;return null;}
  return {document:pdfLayoutDocument};
 },
 // sessionId: the same for every retry of this save, so a save whose answer was lost is not made twice.
 async start(result,job,{sessionId=''}={}){
  resetHistoryIdentity();historyIdToCreate=sessionId;activeHistoryMeta={title:job.title,filename:job.filename};bookTarget={id:job.storyId||'',replaceChapterId:''};pdfLayoutRange='';clearPageImages();
  await adoptPdfLayout(result,{glossary:job.glossary,context:bookContext});
  // Notes of earlier chunks stay in view; "dịch tiếp ở lượt sau" is what the run does by itself, so it is not shown.
  const notes=[...bookNotes,...(result.document.warnings||[]).filter(note=>!/^Lượt này xử lý \d+\/\d+ trang/u.test(note))];$('#warnings').textContent=notes.length?`${notes.join('\n')}\n`:'';
  bookChunkId='';await saveHistoryStrict();bookChunkId=activeHistoryId;
 },
 async translate({shouldStop,renew}){return translateLayoutSession(await ensureStudyModel('pdf'),{pageStop:true,shouldStop,heartbeat:renew});},
 async finish(){
  await saveHistoryStrict();let warning='';
  // Exporting uses only the PDF service, never Gemini: a part that fails here can be exported later from the history.
  try{await exportLayoutPdf(false,{show:false});}catch(error){if(transient(error))throw error;const pages=pdfLayoutDocument.pages.map(page=>page.number);warning=`${pageLabel(Math.min(...pages),Math.max(...pages)).replace(/^t/u,'T')}: chưa xuất được PDF tiếng Việt (${error.message}). Mở phần này trong Lịch sử dịch rồi bấm Xuất PDF tiếng Việt; không tốn token.`;}
  bookContext=translationState.context||'';
  return {storyId:lastSavedHistory?.libraryStoryId||null,glossary:{...translationState.glossary},warning};
 }
};
function bookFinishedMessage(job){
 const failed=[...job.pageStates].flatMap((char,index)=>char==='f'?[index+1]:[]);
 return `Đã dịch xong cả quyển: ${wholeBook.progressText(job.pageStates).replace(/^Đã dịch /u,'')}${failed.length?`; trang ${wholeBook.pageList(failed)} chưa xử lý được nên giữ nguyên bản gốc`:''}. Mở Thư viện riêng để đọc hoặc tải cả quyển.`;
}
// Whether this device may run the bound job now. Another device's run holds it while it keeps reporting: the student is
// told so, or, having chosen to wait ("Chờ rồi dịch tiếp"), the job is watched (its progress shows here) until that run
// pauses, finishes or stops reporting. Nothing is downloaded or paid for meanwhile.
async function bookRunnerFree(wait){
 let announced=false;
 for(;;){
  const job=await api(`book-jobs/${encodeURIComponent(bookJob.id)}`).then(data=>upsertJob(data.job)).catch(error=>{if(error.status===404)throw error;return null;});
  renderBookPanel();renderStudyBooks();
  if(!job||!wholeBook.heldElsewhere(job,bookRunner()))return true;
  if(!wait){bookBusy=true;const message=wholeBook.pauseMessage('busy',{data:{retryAfter:job.leaseSeconds}});bookStatus(message);status(message,'error');return false;}
  const stopped=await wholeBook.countdown(Math.min(10,Math.max(2,job.leaseSeconds)),{onTick:left=>{bookStatus(wholeBook.waitMessage('busy',left),{quiet:announced});announced=true;},stopped:()=>stopRequested});
  if(stopped){bookBusy=true;const message='Đã thôi chờ. Quyển này vẫn đang được dịch ở thiết bị khác; bấm Chờ rồi dịch tiếp khi muốn chờ tiếp.';bookStatus(message);status(message);return false;}
 }
}
async function runWholeBook(){
 key();if(!layoutConfig.configured)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');
 // Pressed while another device runs the book: the student chose to wait for it.
 const waiting=bookBusy;busy(true);stopRequested=false;bookBusy=false;
 try{
  await pdfTools();wake??=wholeBook.createWakeLock();await ensureStudyModel('pdf');
  if(bookJob&&!await bookRunnerFree(waiting))return;
  if(bookJob&&await wholeBook.jobLockHeld(bookJob.id))throw new Error('Quyển này đang được dịch ở một tab khác của trình duyệt. Hãy dùng tab đó, hoặc đóng nó rồi thử lại.');
  // Waited for another device that has finished the book meanwhile: nothing is left to download or translate here.
  if(waiting&&bookJob&&!/[.f]/u.test(bookJob.pageStates)){const message=bookFinishedMessage(bookJob);bookStatus(message);status(message);return;}
  const source=await prepareBookSource();
  if(selectedFile)await uploadOriginal(source);
  // The cover is known before the job starts, or it would be translated (and paid for) like any page.
  if(!bookJob&&selectedFile){bookStatus('Đang tìm trang bìa…');await coverTask.catch(()=>{});}
  const resumed=Boolean(bookJob)&&bookJob.sourceSha256===source.sha256;if(!resumed)bookJob=await createBookJob(source);
  // A new run of an existing job tries every page not done yet, failed ones included; the range field adds or skips
  // pages only when the student edited it. These changes go with the run's claim of the job.
  const updates=resumed?wholeBook.resumeUpdates(bookJob.pageStates,bookPagesEdited?bookChosenPages(bookJob.totalPages):null,bookPagesEdited):{};
  setBookMode(true);await ensureBookCover(source);bookNotes=[];
  let chunkText='',waitingFor='';
  const run=bookRun=wholeBook.createBookRun({api,source,steps:bookSteps,shouldStop:()=>stopRequested,runner:bookRunner(),reports:bookReports(),ui:{
   job(job){const changed=job!==bookJob;bookJob=upsertJob(job);renderBookPanel();if(changed)renderStudyBooks();},
   chunk(chunk){bookWorking=chunk?new Set(chunk.pages):null;chunkText=chunk?`Đang dịch ${pageLabel(chunk.start,chunk.pages.at(-1))}…`:'';if(chunk)bookStatus(chunkText);renderBookPanel();},
   waiting(reason,left){if(!reason){waitingFor='';if(chunkText)bookStatus(chunkText);return;}bookStatus(wholeBook.waitMessage(reason,left),{quiet:waitingFor===reason});waitingFor=reason;},
   warn(message){bookNotes.push(message);$('#warnings').textContent+=`${message}\n`;}
  }});
  let outcome=null;
  await wholeBook.withJobLock(bookJob.id,async()=>{await wake.on();try{outcome=await run.run(bookJob,{pages:updates});}finally{await wake.off();}});
  bookJob=upsertJob(outcome.job||bookJob);
  if(outcome.status==='done'){const message=bookFinishedMessage(bookJob);bookStatus(message);status(message);}
  else{
   if(outcome.reason==='gemini_key'){sessionKey='';const input=$('#api-key');input.setAttribute('aria-invalid','true');input.focus();$('#key-status').textContent='Khóa vừa nhập chưa được Gemini chấp nhận.';}
   if(outcome.reason==='busy')bookBusy=true;
   bookStatus(outcome.message);status(outcome.message,outcome.reason==='stopped'?'':'error');
  }
 }catch(error){rejectKey(error);fail(error);bookStatus(String(error?.message||error));}
 finally{bookRun=null;bookWorking=null;historyIdToCreate='';busy(false);stopRequested=false;renderBookPanel();renderStudyBooks();}
}
function openDeleteDialog(id){
 const item=historyItems.find(entry=>entry.id===id);if(!item||running)return;const pages=item.page_start?` (${pageLabel(item.page_start,item.page_end||item.page_start)})`:'';
 openBookDialog('Xóa bản dịch?',body=>{const note=document.createElement('p');note.textContent=`Xóa “${item.title||'Bản dịch chưa đặt tên'}”${pages} khỏi lịch sử và Thư viện riêng? Bản dịch, PDF tiếng Việt và tệp gốc chỉ dùng cho phần này sẽ bị xóa vĩnh viễn.`;body.append(note);},()=>deleteHistory(id),'Xóa vĩnh viễn','Đang xóa…');
}
async function deleteHistory(id){
 const item=historyItems.find(entry=>entry.id===id),groups=jobSessions(),job=item&&bookJobs.find(entry=>groups.get(entry.id)?.some(part=>part.id===id));let result;
 try{result=await api(`history/${encodeURIComponent(id)}`,{method:'DELETE'});}
 catch(error){if(error.status!==404)throw error;await loadHistory();status('Bản dịch này đã được xóa trước đó.');return;}
 historyItems=historyItems.filter(entry=>entry.id!==id);if(id===bookChunkId)bookChunkId='';
 if(id===activeHistoryId){resetHistoryIdentity();await dualViewer.clear();translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';clearPartStream();$('#source').readOnly=false;$('#source').value='';$('#translation').value='';$('#warnings').textContent='';$('#download').disabled=true;$('#download-pdf').disabled=true;updateCount();workflow(1);}
 if(result.removedBookId){studyBooks=studyBooks.filter(book=>book.id!==result.removedBookId);if(bookTarget.id===result.removedBookId)bookTarget={id:'',replaceChapterId:''};}
 // A whole-book part leaves its run too: the server offers its pages again unless the run's book still holds them, and
 // forgets an emptied book; the run is shown as it is now (another device may be running it, so nothing is sent).
 if(job)await loadBookJobs();
 renderBookTarget();renderHistory();renderBookPanel();status('Đã xóa bản dịch.');
}
function openJobDeleteDialog(id){
 const job=bookJobs.find(entry=>entry.id===id);if(!job||running)return;
 openBookDialog('Xóa tiến độ dịch cả quyển?',body=>{const note=document.createElement('p');note.textContent=`Xóa bảng tiến độ của “${job.title}”? Các phần đã dịch vẫn nằm trong Lịch sử dịch và Thư viện riêng. Lần sau dịch cả quyển này, Hoa Trí bắt đầu bảng mới và bỏ qua các trang sách đã có.`;body.append(note);},async()=>{
  await api(`book-jobs/${encodeURIComponent(id)}`,{method:'DELETE'}).catch(error=>{if(error.status!==404)throw error;});
  bookReports().save(id,[]);bookJobs=bookJobs.filter(entry=>entry.id!==id);if(bookJob?.id===id){bookJob=null;bookStatus('');updateTitleControls();}renderHistory();renderBookPanel();status('Đã xóa tiến độ dịch cả quyển.');
 },'Xóa tiến độ','Đang xóa…');
}

$('#source').addEventListener('beforeinput',event=>{if(keepUnsaved())event.preventDefault();});
$('#source').addEventListener('input',()=>{resetHistoryIdentity();if(!bookChoiceActive())bookTarget={id:'',replaceChapterId:''};translationState=null;translationParts=[];clearPartStream();$('#translation').value='';$('#download').disabled=true;updateCount();});
$('#content-title').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');updateTitleControls();$('#content-title-hint').textContent=activeHistoryId?'Bấm Lưu tên để cập nhật lịch sử và Thư viện riêng.':'Tên này xuất hiện trong lịch sử, Thư viện riêng và tệp tải xuống.';});
$('#save-title').addEventListener('click',()=>renameHistory().catch(fail));
$('#domain').addEventListener('change',event=>{if(event.target.value==='math'&&!$('#glossary').value.trim())$('#glossary').value=MATH_GLOSSARY;if(translationState?.pdfLayout){translationState.domain=event.target.value;translationState.manualGlossary=parseStudyGlossary($('#glossary').value);Object.assign(translationState.glossary,translationState.manualGlossary);}else translationState=null;});
$('#pdf-layout-enabled').addEventListener('change',()=>{if(selectedFile)selectionTask=selected(selectedFile).catch(fail);else if(bookJob)unbindBook();});
$('#library-match-dismiss').addEventListener('click',()=>{$('#library-match').hidden=true;});
$('#source-file').addEventListener('click',event=>{if(keepUnsaved())event.preventDefault();});
$('#source-file').addEventListener('change',event=>{selectionTask=selected(event.target.files[0]).catch(error=>{fail(error);return false;});});
$('#study-history-list').addEventListener('click',event=>{const remove=event.target.closest('[data-history-delete]');if(remove){openDeleteDialog(remove.dataset.historyDelete);return;}const merge=event.target.closest('[data-history-merge]');if(merge){openMergeDialog(merge.dataset.historyMerge);return;}const button=event.target.closest('[data-history-open]');if(button)openHistory(button.dataset.historyOpen).catch(fail);});
$('#study-books-list').addEventListener('click',event=>{
 const target=event.target.closest('[data-book-order],[data-book-resume],[data-book-delete],[data-history-open],[data-history-delete]');if(!target||target.disabled)return;const data=target.dataset;
 if(data.bookOrder)openOrderDialog(data.bookOrder);else if(data.bookResume)openBookJob(data.bookResume).catch(fail);else if(data.bookDelete)openJobDeleteDialog(data.bookDelete);else if(data.historyDelete)openDeleteDialog(data.historyDelete);else openHistory(data.historyOpen).catch(fail);
});
$('#book-mode').addEventListener('change',event=>{if(running||event.target.name!=='book-mode')return;setBookMode(event.target.value==='book');bookFileStatus();if(bookMode&&selectedFile&&!bookJob)findBookJob(selectionVersion);});
$('#book-pages').addEventListener('input',event=>{const input=event.currentTarget,total=bookJob?.totalPages||selectedTotalPages;bookPagesEdited=true;try{if(total)bookChosenPages(total);input.setCustomValidity('');input.removeAttribute('aria-invalid');}catch(error){input.setCustomValidity(error.message);input.setAttribute('aria-invalid','true');}renderBookPanel();});
// Closing the tab mid-run (or with progress not saved) would lose work, so the browser asks first.
addEventListener('beforeunload',event=>{if(bookRun||runActive||unsaved){event.preventDefault();event.returnValue='';}});
$('#source-lookup').addEventListener('click',()=>lookupTextarea($('#source')));
attachHanziLookup($('#translation-parts'),{selector:'.region-description[lang|="zh"],.translation-document'});
attachHanziLookup($('#pdf-dual-viewer'),{selector:'[data-hanzi-lookup]'});
$('#book-target').addEventListener('change',()=>{bookChoiceTouched=true;delete $('#book-replace-option').dataset.part;updateBookHint();applyBookCover().then(()=>{renderCover();refreshOfferedRange();updateBookHint();}).catch(()=>{});});
$('#page-range').addEventListener('input',()=>{cover.note='';updateBookHint();renderCover();});
$('#cover-change').addEventListener('click',openCoverDialog);
$('#cover-none').addEventListener('click',()=>{if(running)return;Object.assign(cover,{page:0,source:'student',replace:false,synced:'',note:''});setCoverImage(null);coverChanged();});
$('#cover-translate').addEventListener('change',()=>{cover.note='';renderCover();updateBookHint();});
$('#book-replace').addEventListener('change',updateBookHint);
$('#book-next-range').addEventListener('click',event=>{$('#page-range').value=event.currentTarget.dataset.range||$('#page-range').value;cover.note='';updateBookHint();renderCover();$('#page-range').focus();});
$('#book-dialog-form').addEventListener('submit',async event=>{event.preventDefault();if(!dialogSubmit)return;const button=$('#book-dialog-submit');button.disabled=true;$('#book-dialog-status').textContent=dialogWorking;try{await dialogSubmit();closeBookDialog();}catch(error){$('#book-dialog-status').textContent=error.message;button.disabled=false;}});
$('#book-dialog-cancel').addEventListener('click',closeBookDialog);
$('#translate').addEventListener('click',()=>run().catch(fail));
$('#check-gemini-model').addEventListener('click',()=>{if(running)return;ensureStudyModel($('#pdf-layout-enabled').checked&&(selectedFile?.name.toLowerCase().endsWith('.pdf')||translationState?.pdfLayout)?'pdf':'text').then(model=>status(`Khóa dùng được ${model}. Bấm Bắt đầu dịch để tiếp tục.`)).catch(fail);});
$('#stop').addEventListener('click',()=>{stopRequested=true;ocrChoice?.(false);const message=bookRun?'Sẽ dừng khi xong trang đang dịch; tiến độ được lưu.':'Sẽ dừng sau yêu cầu đang chạy.';status(message);if(bookRun)bookStatus(message);});
$('#api-key').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');});
$('#clear-key').addEventListener('click',()=>{sessionKey='';$('#api-key').value='';$('#key-status').textContent='Chưa nạp khóa cho phiên này.';status('Đã xóa khóa API khỏi phiên.');});
$('#download').addEventListener('click',()=>{const blob=new Blob(['\uFEFF'+$('#translation').value],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=downloadFilename('txt');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#download-rich').addEventListener('click',()=>downloadRichHtml().catch(fail));
$('#download-pdf').addEventListener('click',()=>{if(running)return;busy(true);exportLayoutPdf().catch(fail).finally(()=>busy(false));});
$('#evaluate').addEventListener('click',()=>{
 const candidate=$('#translation').value.trim(),reference=$('#reference').value.trim();if(!candidate||!reference){fail(new Error('Cần có cả bản dịch của AI và bản dịch mẫu để so sánh.'));return;}
 const result=evaluateStudyTranslation(candidate,reference),number=new Intl.NumberFormat('vi-VN'),line=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
 $('#evaluation-result').replaceChildren(line('strong',`Độ giống bản mẫu: ${number.format(result.bleu)}/100`),line('span',result.formulasTotal?`Công thức giữ đúng: ${number.format(result.formulaRetention)}% (${result.formulasMatched}/${result.formulasTotal})`:'Bản mẫu không có công thức để so.'),line('small',`So ${number.format(result.candidateTokens)} từ và dấu câu của bản AI với ${number.format(result.referenceTokens)} của bản mẫu.`));
});
// Same avatar + name control as the library header, so both pages look like one product.
function renderHeaderAccount(user){
 const name=String(user.name||user.email||'Tài khoản').trim(),words=name.split(/\s+/u),initials=(words[0][0]+(words.length>1?words.at(-1)[0]:'')).toLocaleUpperCase('vi-VN');
 const link=document.createElement('a'),avatar=document.createElement('span'),label=document.createElement('span');
 link.className='header-account';link.href='/#account';link.title=name;link.setAttribute('aria-label',`Tài khoản của ${name}`);avatar.className='header-avatar';label.className='header-account-name';label.textContent=name;
 if(/^https:\/\//u.test(String(user.picture||''))){const image=document.createElement('img');image.src=user.picture;image.alt='';image.width=32;image.height=32;image.referrerPolicy='no-referrer';avatar.append(image);}else avatar.textContent=initials;
 link.append(avatar,label);document.querySelector('.site-header-actions .header-login')?.replaceWith(link);
}
$('#ocr-download-yes').addEventListener('click',()=>ocrChoice?.(true));
$('#ocr-download-no').addEventListener('click',()=>ocrChoice?.(false));
// The history explains its own loading failure in place, with Thử lại (contract 8).
function loadHistoryView(){
 historyError=null;$('#study-history-count').textContent='· đang tải…';$('#study-history-list').replaceChildren();
 return loadHistory().then(()=>{if(bookJobs.some(job=>job.status!=='done'&&/[.f]/u.test(job.pageStates)))$('#study-history').open=true;}).catch(error=>{historyError=error;renderHistory();$('#study-history').open=true;});
}
// Signed out, the form could not be used: a card says why and links to sign in. A failed check offers Thử lại.
function sessionCard(kind){
 const card=$('#session-card'),title=document.createElement('h2'),text=document.createElement('p'),actions=document.createElement('div');title.id='session-card-title';actions.className='session-card-actions';
 if(kind==='out'){
  title.textContent='Đăng nhập để dùng Xưởng dịch';text.textContent='Xưởng dịch lưu nguyên tác, bản dịch và tiến độ vào tài khoản của bạn, nên cần đăng nhập trước khi chọn tài liệu. Khi dịch, bạn dùng khóa Gemini riêng, tạo miễn phí ở Google AI Studio.';
  const login=signInLink('Đăng nhập hoặc tạo tài khoản'),library=document.createElement('a');login.href='/#account?sau=xuong-dich';login.className='primary';library.href='/';library.textContent='Đọc Học liệu không cần đăng nhập';actions.append(login,library);
 }else{
  title.textContent='Chưa kiểm tra được phiên đăng nhập';text.textContent='Mạng đang chập chờn hoặc máy chủ tạm thời chưa trả lời. Hãy bấm Thử lại sau giây lát.';
  const retry=document.createElement('button');retry.type='button';retry.className='primary';retry.textContent='Thử lại';retry.addEventListener('click',()=>checkSession().then(()=>($('#session-card').hidden?$('#main'):$('#session-card .primary'))?.focus()));actions.append(retry);
 }
 card.replaceChildren(title,text,actions);card.hidden=false;
}
function checkSession(){
 document.body.dataset.session='checking';$('#session-card').hidden=true;$('#account-status').hidden=false;$('#account-status').textContent='Đang kiểm tra phiên đăng nhập…';
 return fetch('/api/me',{credentials:'same-origin'}).then(response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}).then(data=>{
  if(!data?.authenticated){document.body.dataset.session='out';sessionKnown(false);$('#translate').disabled=true;sessionCard('out');return;}
  document.body.dataset.session='in';sessionKnown(true);renderHeaderAccount(data.user);$('#account-status').hidden=true;$('#study-history').hidden=false;$('#account-status').textContent=`Đang học với tài khoản ${data.user.name||data.user.email}.`;$('#translate').disabled=running;updateRunBar();loadHistoryView();
 }).catch(()=>{document.body.dataset.session='error';$('#translate').disabled=true;sessionCard('error');});
}
// The page ends above the floating action bar on phones, and a focused field scrolls above it, however tall the bar is
// (a save warning, Dừng, the progress line).
if(globalThis.ResizeObserver)new ResizeObserver(([entry])=>document.documentElement.style.setProperty('--run-bar-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`)).observe($('#run-bar'));
checkSession();
updateCount();
