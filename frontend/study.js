import {parseStudyGlossary} from './study-glossary.js';
import {parseStudyPageRange} from './study-pages.js';
import {evaluateStudyTranslation} from './study-evaluation.js';
import {shouldUseGeminiOcr} from './ocr-policy.js';
import {runStudyTranslation} from './study-flow.js';
import {createTranslationPlan,joinedPageText,textOutsideFigures,pageFurniture} from './document-layout.js';
import {originalPageView,partTitle,buildStudyHtml,translationContentHtml,figuresForPart,readingStyles} from './study-layout-view.js';
import {extractPageFigures} from './document-figures.js';
import {attachHanziLookup,openHanziPanel,lookupTextarea,hasHan} from './hanzi-lookup.js';
import {keyRefused} from './gemini-key.js';
import {inAppBrowser,openInBrowserHelp} from './in-app-browser.js';
import {DEFAULT_MODE,ADMIN_DEFAULT_MODE,isMode,modeProfile,modeLabel,rereads,hanLeft,learnedTerm,LAYOUT_VERSION,layoutStamp,blockTokens,untranslatedHan} from './translation-modes.js';
// Loaded only when needed, so the page opens without them: the PDF tools (whole-book.js, cover-detect.js) with a picked
// PDF or a whole-book run, the layout code with a layout run, the dual viewer with the first layout PDF it shows.
let wholeBook=null,coverTools=null;
const pdfTools=()=>Promise.all([import('./whole-book.js'),import('./cover-detect.js')]).then(([book,coverModule])=>{wholeBook=book;coverTools=coverModule;});
const boxLayout=()=>import('./pdf-box-layout.js');
const $=selector=>document.querySelector(selector);
const readingStyle=document.createElement('style');readingStyle.textContent=readingStyles;document.head.append(readingStyle);
let sessionKey='',selectedFile=null,pdfAnalysis=null,running=false,starting=false,stopRequested=false;
// lastPickPdf: the last file picked is a PDF (photos too), so "Giữ bố cục PDF" is offered; ocrAsking: the question about
// downloading the OCR engine is open, and Dừng steps aside for its own buttons. refusedPick: a PDF refused only for its
// size as a kept layout, read again when that box is unticked (the refusal says to untick it).
let lastPickPdf=false,ocrAsking=false,refusedPick=null;
let usage={prompt:0,output:0,thinking:0,total:0,requests:0},translationParts=[];
let preparedPages=new Map(),pageImages=new Map(),translationState=null,preparedRangeKey=null;
let ocrWarnings=[];
let selectionVersion=0;
let selectionTask=Promise.resolve();
// historyIdToCreate: the id a whole-book chunk's first save asks for, so that save sent again creates nothing new.
// activeHistoryRevision: the revision of the open session this tab last saved or loaded; a save names it, and the server
// refuses one made from an older copy (another tab or device saved since) instead of overwriting newer work.
let historyItems=[],activeHistoryId='',historyIdToCreate='',activeHistoryMeta={},activeHistoryRevision=null,historySave=Promise.resolve(),historyError=null;
// unsaved: the last save of the open session failed, so work shown here is not in the account yet (saveError: why).
// runActive: a run started with Bắt đầu dịch is going (Dừng shows, closing the tab asks first).
let unsaved=false,saveError=null,runActive=false;
let pdfLayoutDocument=null,pdfLayoutRange='',pdfExportUrl='',layoutConfig={configured:false};
// A finished range becomes one part of a private book. bookTarget survives resetHistoryIdentity(), so a new range or a
// refreshed copy of the same file keeps going into the book the student chose.
let studyBooks=[],bookTarget={id:'',replaceChapterId:''},bookChoiceTouched=false,selectedHash=Promise.resolve(''),selectedSha256='',selectedTotalPages=0;
// The picked PDF's cover stays original artwork: ranges skip it unless its text is translated, and it becomes the book's
// cover image. page 0 = no cover; source = who decided it: the detector, the book (remembered for this file) or the student.
let cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:0,note:'',detecting:false,untick:false},autoRange='';
let modelCatalogFingerprint='',modelCatalogPurpose='',checkedModelMode='';
// "Dịch cả quyển" (whole-book.js): the job in the panel, every job of the account (the history groups their parts), the
// original pdf-lib cuts chunks from, the page kinds read on the device, the run in progress and the chunk session it owns.
// bookPagesEdited: the student changed the page field for the bound job; bookBusy: another device runs it, so the
// button offers to wait for that run (Chờ rồi dịch tiếp).
let bookMode=false,bookJob=null,bookJobs=[],bookSource=null,bookSurvey=null,bookRun=null,bookWorking=null,bookChunkId='',bookContext='',bookStatusText='',bookNotes=[],bookHashTask=null,coverTask=Promise.resolve(),lastSavedHistory=null,bookPagesEdited=false,bookBusy=false;
let wake=null,runnerId='',reportStore=null;
// What a whole-book run leaves to the student: the last chunk's outcome and the run's count ("Cần xem lại", layoutReview).
let bookOutcome=null,bookReview=null;
// Exports the PDF service refused in this tab (pdf_overflow or another refusal), by history id: the blocks it named,
// so opening that part again here marks them at once. The lasting record is the part itself: its session stays
// unexported and its chapter text/plain until an export succeeds (missingPdf), on any device.
const exportProblems=new Map();
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
 if(!result.selected){select.value='';$('#gemini-model-status').textContent='Chọn một phiên bản trong danh sách.';$('#advanced-settings').open=true;throw new Error('Khóa chưa dùng được phiên bản Gemini phù hợp. Chọn một phiên bản trong Nâng cao.');}
 select.value=result.selected;
 $('#gemini-model-status').textContent=result.selected===result.requested?`Đang dùng ${result.selected}.`:`Phiên bản ${result.requested} chưa dùng được với khóa này; đang dùng ${result.selected}.`;return result.selected;
}
// Chinese source of a block, looked up in the offline dictionary (no Gemini, no /api).
const OCR_NOTE='Đoạn này nhận dạng từ ảnh (OCR) và chưa được đọc lại; chữ có thể sai, hãy đối chiếu với trang gốc.';
// A scanned block Gemini could not read again (backend/pdf-block-ocr.js ocrKept: refused, cut off, unreadable…) keeps
// the machine OCR text; it counts as read, so no run pays for its image again.
const OCR_KEPT_NOTE='Gemini chưa đọc lại được đoạn này nên đoạn này giữ chữ nhận dạng máy (OCR); chữ có thể sai, hãy đối chiếu với trang gốc.';
// Gemini's reading was used but looks doubtful (ocrDoubt: TeX it cannot draw, junk glued to a formula, far from the machine
// hint): read again once in the modes that do so, and said here when it still is.
const OCR_DOUBT_NOTE='Bản đọc của Gemini cho đoạn này có chỗ đáng ngờ (công thức hoặc chữ có thể sai); hãy đối chiếu với trang gốc.';
// A scanned block whose reading holds nothing to translate though its strip shows Chinese (backend/pdf-layout-apply.js
// keepPixels): it is not translated, and the page keeps its original pixels there.
const OCR_UNREAD_NOTE='Gemini không đọc được chữ trong ảnh của đoạn này nên trang giữ nguyên hình gốc ở đây, không dịch; hãy đối chiếu với trang gốc hoặc gõ bản dịch trong “Chỉnh bản dịch từng đoạn”.';
const ocrHandled=block=>block.ocrCorrected===true||Boolean(block.ocrKept);
// The editor shows a block's formulas as [Công thức n] and puts each back as its token on saving (pdf-dual-viewer.js):
// a box deleted or written twice, a block emptied or longer than a block may be (validateBlockTranslations) is said in
// the editor's own words, never with the token or the "ID block" the server's check names.
function editProblem(block,translation){
 const page=pdfLayoutDocument.pages.find(entry=>entry.blocks.includes(block)),label=page?`Đoạn ${page.blocks.indexOf(block)+1}`:'Đoạn này';
 if(!translation.trim())return `${label}: bản sửa đang trống; hãy viết bản dịch rồi bấm “Lưu đoạn đã sửa”.`;
 if(translation.length>20000)return `${label}: bản sửa dài hơn 20.000 ký tự, mức tối đa của một đoạn; hãy viết ngắn lại rồi bấm “Lưu đoạn đã sửa”.`;
 for(const [i,inline] of (block.inlines||[]).entries()){
  const box=`[Công thức ${i+1}]`,count=translation.split(inline.token).length+translation.split(box).length-2;
  if(!count)return `${label}: bản sửa làm mất ${box}; hãy giữ nguyên ô này.`;
  if(count>1)return `${label}: bản sửa có ${box} hơn một lần; hãy giữ đúng một ô này.`;
 }
 return '';
}
// The blocks the student translated by hand (“Chỉnh bản dịch từng đoạn”), kept with the session (pdfLayout.edited): no
// run sends them again, though they keep Chinese on purpose (a character discussed, a name written first), and no note
// asks to translate them again.
const handEdited=()=>new Set(Array.isArray(translationState?.pdfLayout?.edited)?translationState.pdfLayout.edited:[]);
// A session saved before hand edits were recorded (no edited list) may hold some that keep Chinese on purpose: when it is
// opened, its blocks keeping Chinese that are not stand-ins are recorded (pdfLayout.legacy) and never sent again, as
// before this check existed; a note says how to have Gemini translate one again (empty it first).
const legacyBlocks=()=>new Set(Array.isArray(translationState?.pdfLayout?.legacy)?translationState.pdfLayout.legacy:[]);
function markLegacyEdits(){
 const layout=translationState?.pdfLayout;if(!layout||Array.isArray(layout.edited)||!pdfLayoutDocument)return;
 const allowed=Object.values(usableGlossary());
 layout.legacy=pdfLayoutDocument.pages.flatMap(p=>p.blocks).filter((b,i)=>{const text=translationParts[i];return Boolean(text?.trim())&&!standIn(b,text)&&!(b.keepPixels&&text===b.source)&&hanLeft(b.source,text,allowed).length>0;}).map(b=>b.id);layout.edited=[];
}
// The problems of the drafts a session holds (pdfLayout.review: block id -> 'han', 'rows', 'numbers'), kept with it so a
// reload or a later run still names and counts them; a clean translation or a hand edit clears a block's entry.
function draftProblems(){
 const review=translationState?.pdfLayout?.review,blocks=pdfLayoutDocument?.pages.flatMap(p=>p.blocks)||[],index=new Map(blocks.map((b,i)=>[b.id,i]));
 return new Map(review&&typeof review==='object'?Object.entries(review).filter(([id,list])=>index.has(id)&&Array.isArray(list)&&list.length&&translationParts[index.get(id)]?.trim()):[]);
}
// True once the edited block is saved (the viewer then drops the block's "longer than its box" mark). A part exported
// before has no PDF again until it is exported anew: the save turns its chapter back into text.
async function editLayoutBlock(id,translation){
 if(running)return false;busy(true);try{const {validateBlockTranslations}=await boxLayout(),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),index=blocks.findIndex(b=>b.id===id),problem=editProblem(blocks[index],translation),exported=Boolean(translationState.pdfLayout.exported);if(problem)throw new Error(problem);validateBlockTranslations([blocks[index]],[{id,translation}]);translationParts[index]=translation.normalize('NFC');
  // The block's own Chinese saved as its translation gives the block back to Gemini (a stand-in Bắt đầu dịch sends again),
  // never a hand edit kept as written.
  const edited=handEdited(),legacy=legacyBlocks(),review={...(translationState.pdfLayout.review||{})};if(translationParts[index].trim()&&!standIn(blocks[index],translationParts[index]))edited.add(id);else edited.delete(id);legacy.delete(id);delete review[id];Object.assign(translationState.pdfLayout,{edited:[...edited],legacy:[...legacy],review});pdfExportUrl='';translationState.pdfLayout.exported=false;syncPdfText();await dualViewer.invalidatePdf();await dualViewer.update(pdfTranslations());if(!await saveHistory())throw new Error('Chưa lưu được đoạn đã sửa. Hãy thử lại.');const refused=exportProblems.get(activeHistoryId);if(refused)refused.blocks=refused.blocks.filter(blockId=>blockId!==id);if(exported)partHasPdf(activeHistoryId,false);overflowIds=overflowIds.filter(blockId=>blockId!==id);$('#download-pdf').disabled=translationState.done!==blocks.length;renderNotes();status(edited.has(id)?'Đã lưu đoạn sửa. Bấm Xuất PDF tiếng Việt để dàn trang lại.':`Đã lưu: đoạn này giữ chữ gốc. Bấm ${runLabel()}.`);return true;}catch(error){fail(error);return false;}finally{busy(false);}
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
  const viewer=new PdfDualViewer($('#pdf-dual-viewer'),{loadFont:previewFont,isRunning:()=>runActive});
  viewer.onSourceBlock=(block,page,region)=>openHanziPanel({text:block.text||block.source,title:`Nguyên tác · Trang ${page.number} · đoạn ${page.blocks.indexOf(block)+1}`,note:!page.ocr?'':block.keepPixels?OCR_UNREAD_NOTE:block.ocrKept?OCR_KEPT_NOTE:!block.ocrCorrected?OCR_NOTE:block.ocrDoubt?OCR_DOUBT_NOTE:'',returnFocus:region});
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
 setExportedPdf:url=>loadViewer().then(viewer=>viewer.setExportedPdf(url)),
 // The count of translated blocks ("9/23 đoạn"), or "Đang dịch…" while a run goes: said again when a run starts or ends.
 renderState:()=>viewerTask?viewerTask.then(viewer=>viewer.renderState(),()=>{}):Promise.resolve()
};
// The PDF service is asked about only once the session is known: a signed-out visitor would only get a 401.
let sessionKnown;const sessionChecked=new Promise(resolve=>{sessionKnown=resolve;});
// Said only when the service is missing: the PDF is then read in the browser and translated as text.
const SERVICE_OFF='Dịch vụ PDF chưa sẵn sàng; PDF sẽ được dịch thành văn bản.';
const layoutConfiguration=sessionChecked.then(signedIn=>signedIn?api('pdf-layout/config'):{configured:false}).then(config=>{layoutConfig=config;$('#pdf-layout-enabled').checked=Boolean(config.configured);$('#pdf-layout-service-status').textContent=config.configured?'':SERVICE_OFF;}).catch(()=>{layoutConfig={configured:false};$('#pdf-layout-enabled').checked=false;$('#pdf-layout-service-status').textContent=SERVICE_OFF;});
// ---- "Cách dịch" (translation-modes.js): how hard Gemini works, in every kind of run (text, kept layout, whole book) ----
// modeTouched: the student picked a mode, or an opened session or book run brought its own back; nothing preselects one
// after that. adminDefault: the school's mode, preselected because this browser is signed in to /admin ('' otherwise).
let modeTouched=false,adminDefault='';
const modeName=mode=>modeLabel(mode).split(' (')[0];
// A saved session names a mode its old column cannot hold (Kỹ nhất) in engine; older rows have mode only.
const storedMode=item=>[item?.engine,item?.mode].find(isMode)||DEFAULT_MODE;
// Under the field, read out when it changes: the mode's one line (translation-modes.js brief: what it does and about how
// many times Tiết kiệm's tokens); the full descriptions are behind "So sánh các Cách dịch".
function renderModeHint(){
 const line=$('#mode-hint');if(!line)return;const mode=$('#mode').value,profile=modeProfile(mode);
 const text=[profile.brief,adminDefault&&!modeTouched&&mode===adminDefault?`Mặc định của quản trị: ${modeName(adminDefault)}.`:''].filter(Boolean).join(' ');
 if(line.textContent!==text)line.textContent=text;
}
function renderModeCompare(){
 const list=$('#mode-compare-list');if(!list)return;
 list.replaceChildren(...[...$('#mode').options].flatMap(option=>{const term=document.createElement('dt'),text=document.createElement('dd');term.textContent=modeLabel(option.value);text.textContent=modeProfile(option.value).hint;return [term,text];}));
}
// The field shows the Cách dịch of the work going on: a whole-book run's, which every chunk it opens or begins is read
// and translated in.
function showMode(mode){setChoice($('#mode'),mode,$('#mode').value);renderModeHint();}
// A Cách dịch chosen while a whole-book job is bound and idle is saved with the job, so the book keeps it after a reload
// and on another device. Not saved (another device runs the book, no network), it applies only to the run started here.
// The saves go one at a time, each sending the field as it is by then (on a closed field every arrow key is a change):
// an earlier one never lands after a later one, and the job ends on the last mode chosen. A run waits for them
// (bookModeSave), so its claim of the job never races one.
let bookModeSave=Promise.resolve();
function saveBookMode(){
 const job=bookJob;if(!bookMode||!job||running)return;
 bookModeSave=bookModeSave.then(()=>{
  const mode=$('#mode').value,kept=bookJob;if(!bookMode||kept?.id!==job.id||!isMode(mode)||mode===kept.mode)return;
  return patchBookJob(job.id,{mode}).then(()=>{if(bookJob?.id===job.id)bookStatus(`Đã lưu Cách dịch ${modeName(mode)} cho quyển này.`);},error=>{if(bookJob?.id===job.id)bookStatus(`Chưa lưu được Cách dịch ${modeName(mode)} cho quyển này: ${error.message} Cách dịch này chỉ áp dụng cho lượt dịch bạn bắt đầu ở đây; quyển vẫn giữ Cách dịch ${modeName(kept.mode)}.`);});
 });
}
// An administrator translates for the school with its paid key: a browser signed in to /admin (its cookie goes only to
// /api/ and counts only with this header) starts at the school's mode (ADMIN_TRANSLATION_MODE, Kỹ nhất unless set),
// unless a mode was chosen or brought back before the answer.
// probe=1: only a look, not admin work. The Worker must not count it toward the session's idle time, or students opening
// Xưởng dịch on a shared computer would keep a forgotten /admin session from ending.
sessionChecked.then(signedIn=>signedIn?fetch('/api/admin/session?probe=1',{credentials:'same-origin',headers:{'X-Hoa-Tri-Admin':'1'}}).then(response=>response.ok?response.json():null):null).then(data=>{
 if(!data?.admin||modeTouched||translationState||running)return;adminDefault=isMode(data.translationMode)?data.translationMode:ADMIN_DEFAULT_MODE;$('#mode').value=adminDefault;renderModeHint();renderBookPanel();
}).catch(()=>{});
const PDF_MAX_BYTES=250*1024*1024,OTHER_MAX_BYTES=25*1024*1024;
// autoGlossary: the glossary field holds MATH_GLOSSARY because choosing Toán học filled it, not the student.
let autoGlossary=false;
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
// quiet: a countdown's later seconds are shown, not read aloud each second.
function status(message,type='',{quiet=false}={}){const line=$('#progress');line.setAttribute('aria-live',quiet?'off':'polite');line.textContent=message;line.className=type;const mirror=$('#run-bar-status');mirror.textContent=message;mirror.classList.toggle('error',type==='error');}
const SESSION_EXPIRED='Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.';
const signedOut=error=>error?.status===401||String(error?.message||'').startsWith(SESSION_EXPIRED);
function signInLink(text='Đăng nhập lại'){const link=document.createElement('a');link.href='/#account';link.textContent=text;return link;}
// The day's quota of the key (backend/ai.js quotaError names the reset time): the student's way on is another key.
function quotaDay(error){const at=/(?:đặt lại lúc|chờ đến) (\d\d?:\d\d(?: (?:hôm nay|ngày mai))?)/u.exec(String(error?.message||''))?.[1];return `Khóa đã hết lượt hôm nay${at?` (đặt lại lúc ${at})`:''}. Phần đã dịch đã lưu; dán khóa khác để dịch tiếp.`;}
// Error text from services is bounded upstream; this cap keeps the progress box readable whatever arrives. The day's
// quota and a lost connection are said in one sentence with what to do; a key Gemini refused is named under the key field
// (forgetKey), so here only what to do. The run button is named only when a run failed (run) and the button shows;
// anything else (an export, a history row, Lưu tên) is tried again where it was pressed. Work already translated is said
// to stay. An expired session also gets the way back: a link to sign in.
function fail(error,{run=false}={}){
 const kept=translationState?.done?'; phần đã dịch vẫn còn':'',go=run?runState().label:'',press=go?` rồi bấm ${go}`:'';
 const message=error?.status&&keyRefused(error)?`${run&&!kept?'Chưa dịch: dán':'Dán'} khóa khác${press}${kept}.`:error?.data?.code==='quota_day'?quotaDay(error):error?.status===0&&!error.code?`Mất kết nối. Kiểm tra mạng rồi ${go?`bấm ${go}`:'thử lại'}${kept}.`:String(error?.message||error).trim();
 status(message.length>500?`${message.slice(0,499)}…`:message,'error');if(signedOut(error))$('#progress').append(' ',signInLink());
}
// ---- "Cần xem lại": the notes of the open document, one line each ("Trang 2 · đoạn 3: …", "Phần 2: …", or a note on the
// whole document), as the checks and the services word them. In a kept layout each block named gets Sửa (the editor opens
// on it); in a text run a note of a part (notePart) opens that part, whose header says Cần xem lại.
let notes=[],overflowIds=[];const notePart=new Map();
const noteLines=list=>Array.isArray(list)&&list.length?`${list.join('\n')}\n`:'';
function setNotes(lines=[]){notes=lines.filter(line=>typeof line==='string'&&line.trim());notePart.clear();renderNotes();}
function addNotes(lines,part=null){const added=(Array.isArray(lines)?lines:[lines]).filter(line=>typeof line==='string'&&line.trim());notes.push(...added);if(part!==null)for(const line of added)notePart.set(line,part);renderNotes();}
// A note's place: the blocks it names, or a part or page; the rest of the line says what to look at.
const NOTE_PLACE=/^((?:Trang \d+ · đoạn \d+)(?:, Trang \d+ · đoạn \d+)*|Trang \d+(?:–\d+)?|Phần \d+(?: · đoạn \d+)?)(?: \(bố cục cũ\))?: ([\s\S]*)$/u;
function blockAt(label){const [,page,index]=/^Trang (\d+) · đoạn (\d+)$/u.exec(label)||[];return pdfLayoutDocument?.pages.find(entry=>entry.number===Number(page))?.blocks[Number(index)-1]||null;}
function renderNotes(){
 const root=$('#warnings');if(!root)return;root.replaceChildren();
 const overflow=(pdfLayoutDocument?.pages.flatMap(p=>p.blocks)||[]).filter(b=>overflowIds.includes(b.id)).map(b=>`${blockLabel(b)}: dài hơn khung chữ.`),lines=[...overflow,...notes];
 for(const card of document.querySelectorAll('#translation-parts .translation-part')){const chip=card.querySelector('[data-part-review]');if(chip)chip.hidden=![...notePart.values()].includes(Number(card.dataset.translationPart));}
 if(!lines.length)return;
 const title=document.createElement('h3'),list=document.createElement('ul');title.className='review-title';title.textContent=`Cần xem lại (${lines.length})`;list.className='review-list';
 for(const line of lines){
  const item=document.createElement('li'),[,where,rest]=NOTE_PLACE.exec(line)||[],text=document.createElement('span');item.dataset.note=line;
  if(!where){text.className='review-doc';text.textContent=line;item.append(text);list.append(item);continue;}
  const blocks=where.split(', ').map(blockAt),part=notePart.get(line);text.textContent=rest;
  if(pdfLayoutDocument&&blocks.every(Boolean)&&blocks.length>1){for(const [i,b] of blocks.entries()){const open=document.createElement('button');open.type='button';open.className='quiet review-where';open.dataset.editBlock=b.id;open.textContent=blockLabel(b);item.append(...(i?[', ']:[]),open);}item.append(text);}
  else if(part!==undefined){const open=document.createElement('button');open.type='button';open.className='quiet review-where';open.dataset.openPart=String(part);open.textContent=where;item.append(open,text);}
  else{const place=document.createElement('span');place.className='review-where';place.textContent=where;item.append(place,text);if(pdfLayoutDocument&&blocks.length===1&&blocks[0]){const edit=document.createElement('button');edit.type='button';edit.className='quiet';edit.dataset.editBlock=blocks[0].id;edit.textContent='Sửa';edit.setAttribute('aria-label',`Sửa ${where}`);item.append(edit);}}
  list.append(item);
 }
 root.append(title,list);
}
// onResponse(response): called with a successful answer before its body is returned (the history reads its paging header).
async function api(path,{onResponse=null,...options}={}){
 const failed=(message,status,data=null)=>Object.assign(new Error(message),{status,data});
 const response=await fetch('/api/my/study/'+path,{credentials:'same-origin',...options}).catch(()=>{throw failed('Mất kết nối. Kiểm tra mạng rồi thử lại.',0);});
 if(response.ok)onResponse?.(response);
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
function resetHistoryIdentity(){activeHistoryId='';historyIdToCreate='';activeHistoryMeta={};activeHistoryRevision=null;setUnsaved(false);renderHistory();}
const revisionOf=value=>Number.isInteger(value?.revision)&&value.revision>=0?value.revision:null;
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
  // Said under the field, which takes the focus; the progress line keeps it for the floating bar of phones.
  const message=!title?'Hãy nhập tên nội dung trước khi dịch.':'Tên nội dung tối đa 200 ký tự và không chứa ký tự xuống dòng.';
  input.setCustomValidity(message);input.setAttribute('aria-invalid','true');$('#content-title-hint').textContent=message;input.reportValidity();input.focus();throw new Error(message);
 }
 input.value=title;input.setCustomValidity('');input.removeAttribute('aria-invalid');return title;
}
function downloadFilename(extension){return (historyTitle().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'-').replace(/[.\s]+$/u,'').slice(0,150)||'Hoa Trí')+`.vi.${extension}`;}
function updateTitleControls(){
 // Lưu tên shows once the typed name differs from the saved one. A whole-book run keeps the name it started with; its
 // book is renamed in the dialog Sắp xếp phần, which Đổi tên sách… opens once the book exists.
 const input=$('#content-title'),button=$('#save-title'),rename=$('#rename-book'),bound=Boolean(bookMode&&bookJob),typed=input.value.trim().normalize('NFC');input.readOnly=bound;
 button.hidden=!activeHistoryId||bookMode||!typed||typed===activeHistoryMeta.title;button.disabled=running;
 rename.hidden=!bound||!studyBooks.some(book=>book.id===bookJob.storyId);rename.disabled=running;
}
async function renameHistory(){
 if(running||!activeHistoryId)return;const title=requireContentTitle();if(title===activeHistoryMeta.title)return;
 busy(true);try{
  await historySave.catch(()=>{});const saved=await api(`history/${encodeURIComponent(activeHistoryId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});activeHistoryMeta.title=title;
  const item=historyItems.find(item=>item.id===activeHistoryId);if(item){item.title=title;item.updated_at=saved.updatedAt;}
  renderHistory();$('#content-title-hint').textContent='Đã lưu tên.';
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
 // The part to take over is said whenever the book choice is in view, '' when "Thay phần …" is unticked (keep both): the
 // server then forgets one an earlier save named. Without it (a session opened from the history) the server keeps that one.
 return {title:historyTitle(),filename:selectedFile?.name||activeHistoryMeta.filename||'',domain:translationState.domain||$('#domain').value,mode:translationState.mode||$('#mode').value,bookId:bookTarget.id||'',...(bookTarget.replaceChapterId||bookChoiceActive()?{replaceChapterId:bookTarget.replaceChapterId||''}:{}),...(selectedSha256?{sha256:selectedSha256}:{}),...(pageRange?{pageRange}:{}),state:{source:translationState.source,parts:translationState.parts,translationParts,done:translationState.done,context:translationState.context,glossary:translationState.glossary,manualGlossary:translationState.manualGlossary,previousSource:translationState.previousSource,previousTranslation:translationState.previousTranslation,...(translationState.notes?.length?{notes:translationState.notes}:{}),...(translationState.pdfLayout?{pdfLayout:translationState.pdfLayout}:{})}};
}
// A PDF range names its pages: its parts are paragraphs of a kept layout or parts of a text run, so its progress is a
// share. Pasted text and documents count their parts, as the run does ("Đang dịch phần 3/5").
function historyStatus(item){
 const pages=item.page_start?pageLabel(item.page_start,item.page_end||item.page_start):'',number=new Intl.NumberFormat('vi-VN'),done=Number(item.translated_parts)||0,total=Number(item.total_parts)||0;
 if(item.status==='complete')return `Hoàn tất · ${pages||`${number.format(total)} phần`}`;
 if(item.status==='translating')return pages?`Đã dịch ${Math.min(99,Math.max(1,Math.floor(done*100/Math.max(1,total))))}% · ${pages}`:`Đã dịch ${number.format(done)}/${number.format(total)} phần`;
 return pages?`Chưa dịch · ${pages}`:'Chưa dịch';
}
// Lists show the day as dd/mm, the full date in the tooltip.
function dayElement(value){
 const date=historyDate(value),time=document.createElement('time');if(!date)return null;
 const two=value=>String(value).padStart(2,'0');time.dateTime=date.toISOString();time.textContent=`${two(date.getDate())}/${two(date.getMonth()+1)}`;time.title=`${two(date.getDate())}/${two(date.getMonth()+1)}/${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;return time;
}
// A row's ⋯ menu: items are [label, attributes] (an href makes a link), the last one destructive when danger.
function rowMenu(name,items){
 const menu=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('div');menu.className='menu';summary.className='icon-btn';summary.setAttribute('aria-label',`Thao tác cho “${name}”`);summary.textContent='⋯';list.className='menu-list';
 for(const [label,data={},{href='',danger=false}={}] of items){
  if(danger&&list.children.length){const line=document.createElement('hr');line.className='menu-sep';list.append(line);}
  const item=document.createElement(href?'a':'button');if(href)item.href=href;else{item.type='button';item.disabled=running;}if(danger)item.className='danger';item.textContent=label;Object.assign(item.dataset,data);list.append(item);
 }
 menu.append(summary,list);return menu;
}
// GET history answers the sessions updated last, a page of at most 100 at a time (backend/study-history.js). When older
// ones are left it names the next page in X-Next-Before (opaque), which "Xem thêm bản cũ hơn" asks for (?before=).
// historyNext: that cursor, '' once every session is listed; historyMore: 'loading' while that page loads, or why it failed.
let historyNext='',historyMore=null;
// One page of the list: rows (null for an answer that is not a list) and the cursor of the page after it.
async function historyPage(before=''){
 let next='';const rows=await api(before?`history?before=${encodeURIComponent(before)}`:'history',{onResponse:response=>{next=response.headers.get('X-Next-Before')||'';}});
 return {rows:Array.isArray(rows)?rows:null,next};
}
// The next older page goes under the sessions listed (one saved again meanwhile is not listed twice); keyboard and
// screen-reader users go on from the first session it added.
async function loadMoreHistory(){
 if(!historyNext||historyMore==='loading')return;historyMore='loading';renderHistory();$('#study-history-list [data-history-more]')?.focus();
 let added=[];
 try{const page=await historyPage(historyNext),known=new Set(historyItems.map(item=>item.id));added=(page.rows||[]).filter(item=>!known.has(item.id));historyItems=[...historyItems,...added];historyNext=page.next;historyMore=null;}
 catch(error){historyMore=error;}
 renderHistory();
 const first=added.map(item=>$(`#study-history-list [data-history-open="${item.id}"]`)).find(Boolean);
 (first||$('#study-history-list [data-history-more]')||$('#study-history-list .load-error-action')||$('#study-history>summary'))?.focus();
}
function historyMoreBlock(){
 const box=document.createElement('div'),loading=historyMore==='loading',failed=historyMore&&!loading?historyMore:null;box.className='history-more';
 if(failed){const why=document.createElement('p');why.className='history-more-error';why.setAttribute('role','alert');why.textContent=signedOut(failed)?'Phiên đăng nhập đã hết hạn nên chưa tải được các bản cũ hơn.':`Chưa tải được các bản cũ hơn. ${String(failed.message||'')}`.trim();box.append(why);}
 if(failed&&signedOut(failed)){const link=signInLink('Đăng nhập');link.className='load-error-action';box.append(link);return box;}
 const button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.historyMore='';button.textContent=loading?'Đang tải…':failed?'Thử lại':'Xem bản cũ hơn';
 if(loading){button.setAttribute('aria-disabled','true');box.setAttribute('aria-busy','true');}
 box.append(button);return box;
}
// Contract 8: a load that failed is explained where its content belongs, with Thử lại, or a sign-in link after a 401.
function loadErrorCard(title,error,retry){
 const card=document.createElement('div'),heading=document.createElement('p'),text=document.createElement('p');card.className='load-error';card.setAttribute('role','alert');heading.className='load-error-title';heading.textContent=title;
 text.textContent=signedOut(error)?'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để xem lịch sử dịch.':String(error?.message||error||'Không kết nối được máy chủ.');card.append(heading,text);
 if(signedOut(error)){const link=signInLink('Đăng nhập');link.className='load-error-action';card.append(link);}
 else{const button=document.createElement('button');button.type='button';button.className='secondary load-error-action';button.textContent='Thử lại';button.addEventListener('click',retry);card.append(button);}
 return card;
}
function renderHistory(){
 updateTitleControls();renderLayoutRefresh();
 const section=$('#study-history'),root=$('#study-history-list');if(!section||!root)return;
 section.hidden=false;root.replaceChildren();renderResume();
 if(historyError){$('#study-history-count').textContent='';$('#study-books').hidden=true;root.append(loadErrorCard('Chưa tải được lịch sử dịch.',historyError,()=>loadHistoryView().then(()=>(historyError?root.querySelector('.load-error-action'):$('#study-history>summary'))?.focus())));return;}
 // The count of sessions listed; "+" while older ones are not listed yet.
 const count=new Intl.NumberFormat('vi-VN').format(historyItems.length);
 $('#study-history-count').textContent=historyItems.length?`· ${count}${historyNext?'+':''}`:'';
 // The parts a whole-book run saved (one per chunk) are listed under that book, not one row each.
 const grouped=new Set([...jobSessions().values()].flat().map(item=>item.id));renderStudyBooks();
 if(!historyItems.length){if(historyNext){root.append(historyMoreBlock());return;}const empty=document.createElement('p');empty.className='history-empty';empty.textContent='Chưa có bản dịch nào.';root.append(empty);return;}
 const list=document.createElement('ul');list.className='rows';
 for(const item of historyItems.filter(item=>!grouped.has(item.id))){
  const row=document.createElement('li'),open=document.createElement('button'),title=document.createElement('strong'),meta=document.createElement('span'),name=item.title||'Bản dịch chưa đặt tên';
  row.className='row history-card'+(item.id===activeHistoryId?' is-active':'');open.type='button';open.className='row-main';open.dataset.historyOpen=item.id;open.disabled=running;if(item.filename)open.title=item.filename;
  title.className='row-title';title.textContent=name;meta.className='row-meta';
  // "Hoàn tất · trang 4–6 · 31/10", and the part of its book when the book has several.
  const book=studyBooks.find(entry=>entry.id===item.library_story_id),part=book?book.parts.findIndex(entry=>entry.id===item.library_chapter_id):-1,day=dayElement(item.updated_at);
  meta.append(historyStatus(item),...(day?[' · ',day]:[]),book&&book.parts.length>1&&part>=0?` · phần ${part+1}/${book.parts.length}`:'');open.append(title,meta);row.append(open);
  for(const [flag,tone] of [[missingPdf(item)&&'Chưa có PDF tiếng Việt','warn'],[partOf(item)?.layoutOutdated===true&&'Bố cục cũ','']]){if(!flag)continue;const chip=document.createElement('span');chip.className='chip';if(tone)chip.dataset.tone=tone;chip.textContent=flag;row.append(chip);}
  const storyId=item.library_story_id;
  row.append(rowMenu(name,[...(item.library_chapter_id||item.status==='complete'&&storyId?[['Đọc trong Thư viện riêng',{},{href:storyId?`/?read=${encodeURIComponent(storyId)}`:'/#account'}]]:[]),...(item.status==='complete'&&item.library_chapter_id&&studyBooks.some(entry=>entry.id!==storyId)?[['Gộp vào sách…',{historyMerge:item.id}]]:[]),['Xóa…',{historyDelete:item.id},{danger:true}]]));
  list.append(row);
 }
 root.append(list);
 if(historyNext)root.append(historyMoreBlock());
}
// An unfinished whole-book run keeps one line under the folded history, with Dịch tiếp: the newest such run that is not
// the one open in the panel or running here.
function renderResume(){
 const root=$('#study-resume');if(!root)return;
 const job=wholeBook?bookJobs.find(entry=>entry.status!=='done'&&/[.f]/u.test(entry.pageStates)&&!(bookMode&&bookJob?.id===entry.id)&&!(bookRun&&bookJob?.id===entry.id)):null;
 root.hidden=!job||document.body.dataset.session!=='in';root.replaceChildren();if(root.hidden)return;
 const count=wholeBook.countStates(job.pageStates),line=document.createElement('p'),button=document.createElement('button');
 line.textContent=`“${studyBooks.find(book=>book.id===job.storyId)?.title||job.title}” đang dừng ở ${count.done}/${count.wanted} trang`;
 button.type='button';button.className='secondary';button.dataset.bookResume=job.id;button.disabled=running;button.textContent='Dịch tiếp';root.append(line,button);
}
// The books are asked for again after a save that made a book part and after an export (the part's chapter becomes a
// PDF); only the newest answer is used, so an older one arriving late never brings back a part's earlier state.
let booksAsked=0;
async function fetchBooks(){const asked=++booksAsked,rows=await api('books');return asked===booksAsked?rows:null;}
async function loadHistory(){const [page,books]=await Promise.all([historyPage(),fetchBooks().catch(()=>null),loadBookJobs()]);historyItems=page.rows||[];historyNext=page.next;historyMore=null;setStudyBooks(books||studyBooks);}
async function loadBooks(){const rows=await fetchBooks();if(rows)setStudyBooks(rows);}
// Only the list (its newest page again), for a run about to look for its parts in it; a failure leaves the list as it
// was (the run asks the server for each part by its id anyway), except an expired session.
async function refreshHistoryList(){try{const page=await historyPage();if(page.rows){historyItems=page.rows;historyNext=page.next;historyMore=null;renderHistory();}}catch(error){if(signedOut(error))throw error;}}
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
 // Without a book there is nothing to choose: the field shows once the account has one.
 select.replaceChildren(new Option('Sách mới',''),...studyBooks.map(book=>new Option(`${book.title} · ${book.parts.length} phần`,book.id)));$('#book-target-group').hidden=bookMode||!studyBooks.length;
 select.value=studyBooks.some(book=>book.id===bookTarget.id)?bookTarget.id:'';updateBookHint();
}
function updateBookHint(){
 const select=$('#book-target'),hint=$('#book-target-hint'),next=$('#book-next-range'),replace=$('#book-replace-option');if(!select||!hint)return;
 const book=studyBooks.find(entry=>entry.id===select.value),lines=[];let replaceId='';next.hidden=true;replace.hidden=true;
 // Said only to keep a book from holding the same pages twice: which pages it has of this file, and an overlap kept.
 if(book){
  const source=selectedSource(),siblings=book.parts.filter(part=>part.pageStart&&sameSource(part,source)),range=$('#page-range').value.trim();
  if(siblings.length){
   lines.push(`Sách đã có ${[...new Set(siblings.map(part=>pageLabel(part.pageStart,part.pageEnd||part.pageStart)))].join(', ')} của tệp này.`);
   // The cover is "next to translate" only while its text is translated (Dịch chữ trên bìa, ticked unless the student unticks it).
   const suggestion=suggestedRange([...siblings,...coverSpans()],selectedTotalPages);
   if(suggestion){next.dataset.range=rangeValue(suggestion);next.textContent=`Dịch tiếp ${pageLabel(suggestion.start,suggestion.end)}`;next.hidden=range===next.dataset.range;}
  }
  // Pressing Bắt đầu dịch with the current range continues the open session, so its own part is not a duplicate.
  let effective=null;try{effective=translationRange();}catch{}
  const continuing=Boolean(activeHistoryId)&&effective?.text===pdfLayoutRange,pages=effective?.pages||null;
  const overlaps=pages?siblings.filter(part=>!(continuing&&part.sessionId===activeHistoryId)&&[...pages].some(page=>page>=part.pageStart&&page<=(part.pageEnd||part.pageStart))):[];
  if(overlaps.length===1){
   const [part]=overlaps;replace.hidden=false;$('#book-replace-label').textContent=`Thay phần “${part.title}” bằng bản dịch này thay vì thêm trang trùng`;
   // Replacing is the default only when the new range covers every page of the old part; nothing silently disappears.
   if(replace.dataset.part!==part.id){replace.dataset.part=part.id;$('#book-replace').checked=Array.from({length:(part.pageEnd||part.pageStart)-part.pageStart+1},(_,i)=>part.pageStart+i).every(page=>pages.has(page));}
   if($('#book-replace').checked)replaceId=part.id;else lines.push('Nếu giữ cả hai, sách sẽ có trang lặp lại.');
  }else if(overlaps.length>1)lines.push(`Trùng ${overlaps.length} phần đã có; sách sẽ có trang lặp lại.`);
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
  if(suggest&&suggestion&&$('#page-range').value===autoRange){autoRange=$('#page-range').value=rangeValue(suggestion);if(!bookMode)setFileStatus(`${selectedTotalPages} trang · đã chọn tiếp ${pageLabel(suggestion.start,suggestion.end)}`);}
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
// D2: the text on a cover is translated like any heading. "Dịch chữ trên bìa" starts ticked; unticking it is the student's
// own choice for this file (cover.untick), kept for a cover found or chosen later. Either way the original page is the
// book's cover image in Thư viện riêng (syncBookCover).
function resetCover(){setCoverImage(null);cover={page:0,detected:0,detectedJpeg:null,jpeg:null,url:'',source:'',replace:false,synced:'',task:cover.task+1,note:'',detecting:false,untick:false};$('#cover-translate').checked=true;renderCover();}
// The page-range box is not drawn while none of its parts shows (study.css .pdf-range:not(:has(…))).
function renderCover(){
 // A whole-book run keeps the cover it started with (its page state); the grid shows it.
 const root=$('#cover-choice');if(!root)return;root.hidden=!/\.pdf$/iu.test(selectedFile?.name||'')||Boolean(bookMode&&bookJob);if(root.hidden){renderBookPanel();return;}const detecting=cover.detecting&&!cover.page;
 const thumb=$('#cover-thumb');thumb.hidden=!(cover.page&&cover.url);if(!thumb.hidden){thumb.src=cover.url;thumb.alt=`Trang bìa · trang ${cover.page} của tệp`;}
 $('#cover-label').textContent=detecting?'Đang tìm trang bìa…':cover.page?`Bìa: trang ${cover.page}`:['student','book'].includes(cover.source)?'Không dùng bìa':'Không thấy trang bìa';
 $('#cover-change').textContent=cover.page?'Đổi':'Chọn trang bìa';$('#cover-change-group').hidden=detecting;$('#cover-none-group').hidden=detecting||!cover.page;$('#cover-translate-option').hidden=detecting||!cover.page;
 $('#cover-translate').checked=!cover.untick;
 let note=cover.note;
 // Said only when it changes what is translated: an unticked cover keeps its original, and a range holding only the cover
 // is explained here at once; other range mistakes are reported on Bắt đầu dịch, as before.
 if(!note&&cover.page&&!bookMode){try{translationRange();}catch(error){if(/là bìa/u.test(error.message))note=error.message;}}
 if(!note&&cover.page&&!$('#cover-translate').checked)note='Bìa giữ nguyên ảnh gốc.';
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
 // The range field shows the pages offered; a book's next pages are named here.
 const [start,end=start]=value.split('-').map(Number);if(!bookMode&&suggestion)setFileStatus(`${selectedTotalPages} trang · đã chọn tiếp ${pageLabel(start,end)}`);
}
function openCoverDialog(){
 if(running||!selectedFile)return;const file=selectedFile,version=selectionVersion,total=selectedTotalPages,book=studyBooks.find(entry=>entry.id===$('#book-target').value);let preview=null,timer=0;
 openBookDialog('Chọn trang bìa',body=>{
  const label=document.createElement('label'),input=document.createElement('input'),figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption'),note=document.createElement('p');
  label.htmlFor='cover-page-input';label.textContent=`Trang bìa trong tệp PDF (1–${total})`;Object.assign(input,{id:'cover-page-input',type:'number',inputMode:'numeric',min:'1',max:String(total),value:String(cover.page||cover.detected||1)});
  figure.className='cover-preview';image.alt='';caption.textContent='Đang tải trang…';figure.append(image,caption);
  note.className='field-hint';note.textContent='Trang này là ảnh bìa sách trong Thư viện riêng.';
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
   catch(error){if(error.status!==409)throw error;await remember();cover.note='Sách đã có ảnh bìa; bấm Đổi để thay.';}
  }else if(selectedSha256||!cover.page)await remember();
  renderCover();loadBooks().catch(()=>{});
 }catch(error){cover.synced='';addNotes(`Chưa lưu được ảnh bìa sách: ${error.message}`);}
}
// Books with several parts, and every whole-book run with its progress: the parts a run saved (one per chunk) are listed
// in its row, where they open or are deleted, instead of one history card each.
// A run's list of parts opens by itself when a part of it is first seen lacking its PDF; otherwise the student's own
// choice (open or closed) is kept. missingShown: the parts the lists were opened for.
const missingShown=new Set();
function renderStudyBooks(){
 const section=$('#study-books'),root=$('#study-books-list');if(!section||!root)return;
 const jobOf=book=>bookJobs.find(job=>job.storyId===book.id),books=studyBooks.filter(book=>book.parts.length>1||jobOf(book)),loose=bookJobs.filter(job=>!job.storyId||!studyBooks.some(book=>book.id===job.storyId));
 const opened=new Set([...root.querySelectorAll('details.book-job-parts[open]')].map(details=>details.dataset.job)),groups=jobSessions();
 for(const job of bookJobs)for(const item of (groups.get(job.id)||[]).filter(missingPdf))if(!missingShown.has(item.id)){missingShown.add(item.id);opened.add(job.id);}
 section.hidden=!books.length&&!loose.length;root.replaceChildren();const list=document.createElement('ul');list.className='rows';root.append(list);
 for(const job of loose)list.append(studyBookRow(null,job,opened,groups));
 for(const book of books)list.append(studyBookRow(book,jobOf(book),opened,groups));
 updateTitleControls();
}
// ---- A finished part without its Vietnamese PDF ----
// The export of a kept-layout part can be refused (translations longer than their boxes even at the smallest size, or
// another refusal of the PDF service). The part keeps a text chapter (GET books: parts[].mime 'text/plain', with the
// pages of its layout) and its session stays unexported until an export succeeds, on any device and after a reload;
// "Tải cả quyển (PDF)", offered once some part of the book has its PDF, then holds those pages as printed. This tab's
// own refusal says it at once, whatever the books list this tab holds still says (an export made before it). The
// session a run of this tab is working on is finished a moment before its export: it is said to lack its PDF only once
// that export was refused. A session that no longer belongs to a book (its book deleted, its part taken over by a redone
// range) has no part, and no PDF to lack: the Worker exports only a part of a book.
const partOf=item=>studyBooks.find(book=>book.id===item?.library_story_id)?.parts.find(part=>part.id===item.library_chapter_id)||null;
function missingPdf(item){
 if(item?.status!=='complete'||!item.library_chapter_id)return false;if(exportProblems.has(item.id))return true;
 if(runActive&&item.id===activeHistoryId)return false;const part=partOf(item);
 // oldPdf: the part still shows the PDF of the older part this range took over, until this range's own export.
 return Boolean(part)&&Array.isArray(part.pages)&&part.pages.length>0&&(part.mime!=='application/pdf'||part.oldPdf===true);
}
// An export just made (or a saved edit that undid one) changes the part's chapter: said here at once, then read again.
function partHasPdf(id,pdf){
 const item=historyItems.find(entry=>entry.id===id),part=partOf(item);if(!item?.library_chapter_id)return;
 if(part){part.mime=pdf?'application/pdf':'text/plain';renderHistory();}
 loadBooks().catch(()=>{});
}
const partName=item=>item.page_start?pageLabel(item.page_start,item.page_end||item.page_start).replace(/^t/u,'T'):item.title||'Phần chưa đặt tên';
const missingPdfParts=job=>wholeBook&&job?(jobSessions().get(job.id)||[]).filter(missingPdf).sort((a,b)=>(a.page_start||0)-(b.page_start||0)):[];
function missingPdfPages(job){
 const pages=new Set();
 for(const item of missingPdfParts(job)){const listed=partOf(item)?.pages,start=item.page_start,end=item.page_end||start;for(const page of Array.isArray(listed)?listed:start?Array.from({length:end-start+1},(_,i)=>start+i):[])pages.add(page);}
 return pages;
}
// What a finished run still lacks, or '' when every part has its Vietnamese PDF. The reader offers “Tải cả quyển (PDF)”
// for a student's book only once a part of it has its PDF (frontend/app.js wholeBookPdf), so a book without one (a book
// of one part, or every part refused) is told it cannot be downloaded as a PDF yet.
function missingPdfNote(job){
 const missing=missingPdfParts(job);if(!missing.length)return '';const names=missing.map(partName),list=names.length>1?`${names.slice(0,-1).join(', ')} và ${names.at(-1)}`:names[0];
 // Parts that still show the PDF of the older part they took over are downloaded with those older pages meanwhile. Never
 // said to be downloadable as a PDF: only what lacks one, and where to make it (no token).
 const older=missing.every(item=>partOf(item)?.oldPdf===true);
 return `${list} chưa có PDF tiếng Việt${older?' mới':''}. Mở ${missing.length>1?'từng phần':'phần đó'} trong Lịch sử dịch rồi bấm Xuất PDF tiếng Việt.`;
}
function studyBookRow(book,job,opened,groups){
 // One row: the title, one line ("39/311 trang · Tạm dừng: hết hạn mức hôm nay · 400 nghìn token" for a run, "3 phần" for
 // a book), the parts a run saved behind a disclosure, Dịch tiếp, and the rest in the ⋯ menu.
 const row=document.createElement('li'),text=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('span'),actions=document.createElement('div'),name=book?.title||job.title;
 row.className=job?'row study-book book-job':'row study-book';text.className='row-text';title.className='row-title';title.textContent=name;meta.className='row-meta book-job-progress';
 const count=job?wholeBook.countStates(job.pageStates):null;
 meta.textContent=job?[`${count.done}/${count.wanted} trang`,jobStatusLabel(job),job.usage?.total?`${wholeBook.formatTokens(job.usage.total)} token`:''].filter(Boolean).join(' · '):`${book.parts.length} phần`;text.append(title,meta);
 const parts=job?[...(groups.get(job.id)||[])].sort((a,b)=>(a.page_start||0)-(b.page_start||0)):[];if(parts.length)text.append(jobPartList(job,parts,opened.has(job.id)));
 actions.className='row-actions study-book-actions';
 if(job&&/[.f]/u.test(job.pageStates)){const resume=document.createElement('button');resume.type='button';resume.className='secondary';resume.disabled=running;resume.dataset.bookResume=job.id;resume.textContent=job.pageStates.includes('.')?'Dịch tiếp':'Thử lại trang lỗi';actions.append(resume);}
 const storyId=book?.id||job?.storyId;
 actions.append(rowMenu(name,[...(book?[['Sắp xếp phần',{bookOrder:book.id}]]:[]),...(storyId?[['Đọc sách',{},{href:`/?read=${encodeURIComponent(storyId)}`}]]:[]),...(job?[['Xóa tiến độ…',{bookDelete:job.id},{danger:true}]]:[])]));
 row.append(text,actions);return row;
}
function jobPartList(job,parts,expanded){
 const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');details.className='more book-job-parts';details.dataset.job=job.id;details.open=expanded;summary.textContent=`Các phần đã lưu (${parts.length})`;
 for(const item of parts){
  const entry=document.createElement('li'),open=document.createElement('button'),remove=document.createElement('button'),label=partName(item);
  open.type='button';open.dataset.historyOpen=item.id;open.disabled=running;open.textContent=`${label} · ${item.status==='complete'?'Hoàn tất':item.status==='translating'?'Dịch dở':'Chưa dịch'}${missingPdf(item)?' · chưa có PDF tiếng Việt':''}`;
  remove.type='button';remove.className='danger history-delete';remove.dataset.historyDelete=item.id;remove.disabled=running;remove.textContent='Xóa…';remove.setAttribute('aria-label',`Xóa phần ${label}`);
  entry.append(open,remove);list.append(entry);
 }
 details.append(summary,list);return details;
}
function jobStatusLabel(job){
 if(bookRun&&bookJob?.id===job.id)return 'Đang dịch';
 if(wholeBook.heldElsewhere(job,bookRunner()))return 'Đang dịch ở thiết bị khác';
 if(job.status==='done')return job.pageStates.includes('.')?'Còn trang chưa dịch':missingPdfParts(job).length?'Còn phần chưa có PDF tiếng Việt':'Hoàn tất';
 if(job.status==='paused')return `Tạm dừng${({quota_day:': hết hạn mức hôm nay',quota:': hết hạn mức',gemini_key:': cần khóa hợp lệ',network:': mất kết nối',gemini_unavailable:': Gemini quá tải',gemini_location:': Gemini chưa phục vụ khu vực máy chủ',limit:': hết lượt hôm nay',pdf_busy:': dịch vụ PDF bận',pdf_account:': đang có lượt xử lý PDF khác',history_full:': lịch sử dịch đã đầy',conflict:': phần đang dịch đã lưu ở nơi khác'})[job.pauseReason]||''}`;
 // "running" with no run in this tab: the tab that ran it was closed; every finished chunk is kept.
 return job.status==='running'?'Dịch dở':'Chưa bắt đầu';
}
// dialogOpened counts the dialogs opened: a submit that ends after its dialog was closed (Escape while "Đang xóa…") or
// replaced by another reports through the progress line and closes nothing.
let dialogSubmit=null,dialogWorking='Đang lưu…',dialogOpened=0;
// danger: the confirm deletes for good (filled red). extra: [label, onClick] for a second choice, beside Hủy.
function openBookDialog(title,build,submit,label,working='Đang lưu…',{danger=false,extra=null}={}){
 const dialog=$('#book-dialog');dialogOpened++;$('#book-dialog-title').textContent=title;$('#book-dialog-body').replaceChildren();build($('#book-dialog-body'));$('#book-dialog-status').textContent='';$('#book-dialog-submit').textContent=label;$('#book-dialog-submit').className=danger?'primary danger':'primary';$('#book-dialog-submit').disabled=false;dialogSubmit=submit;dialogWorking=working;
 dialog.querySelector('[data-dialog-extra]')?.remove();
 if(extra){const [text,onClick]=extra,button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.dialogExtra='';button.textContent=text;button.addEventListener('click',onClick);$('#book-dialog-submit').before(button);}
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
  note.className='field-hint';note.textContent=current?.parts.length===1?`Sách “${current.title}” chỉ có phần này nên sẽ được gỡ khỏi Thư viện riêng; bản dịch vẫn giữ nguyên.`:'';overlap.className='field-hint book-overlap';
  // Ranges recorded before books existed have no pages yet; the server reads them back from the manifest when moving.
  const warn=()=>{const book=targets.find(entry=>entry.id===select.value),same=item.page_start?(book?.parts||[]).filter(part=>part.pageStart&&sameSource(part,source)&&part.pageStart<=(item.page_end||item.page_start)&&(part.pageEnd||part.pageStart)>=item.page_start):[];overlap.textContent=same.length?`Sách này đã có ${same.map(part=>`“${part.title}”`).join(', ')} trùng ${pageLabel(item.page_start,item.page_end||item.page_start)} của cùng tệp; sau khi gộp, sách sẽ có trang lặp lại.`:'';};
  select.addEventListener('change',warn);warn();body.append(label,select,note,overlap);
 },async()=>{
  const bookId=$('#book-merge-target').value,book=studyBooks.find(entry=>entry.id===bookId);
  await api(`history/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookId})});
  if(id===activeHistoryId)bookTarget={id:bookId,replaceChapterId:''};
  await loadHistory();status(`Đã gộp vào sách “${book?.title||''}”.`);
 },'Gộp vào sách');
}
function openOrderDialog(bookId){
 const book=studyBooks.find(entry=>entry.id===bookId);if(!book||running)return;const order=book.parts.slice();
 openBookDialog('Sắp xếp các phần của sách',body=>{
  const label=document.createElement('label'),input=document.createElement('input'),note=document.createElement('p'),list=document.createElement('ol');
  label.htmlFor='book-order-title';label.textContent='Tên sách';input.id='book-order-title';input.type='text';input.maxLength=200;input.required=true;input.autocomplete='off';input.value=book.title;
  note.className='field-hint';list.className='book-order';
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
  // A whole-book run bound to this book shows its new name (the run saves its parts under the book's name).
  await loadBooks();if(bookJob?.storyId===bookId)$('#content-title').value=title;status(`Đã lưu sách “${title}”.`);
 },'Lưu');
}
// With the page fields of the server's list rows, so a part just saved sorts into its book and its whole-book run at once.
function currentHistoryRecord(saved,payload,prior=null){
 const pages=payload.state.pdfLayout&&pdfLayoutDocument?pdfLayoutDocument.pages.map(page=>page.number):[],range=payload.pageRange;
 return {id:saved.id,title:payload.title,filename:payload.filename,domain:payload.domain,mode:payload.mode,status:saved.status,translated_parts:payload.state.done,total_parts:payload.state.parts.length,source_characters:payload.state.source.length,translation_characters:translationParts.join('\n\n').length,library_story_id:saved.libraryStoryId||null,library_chapter_id:saved.libraryChapterId||null,updated_at:saved.updatedAt,
  created_at:prior?.created_at||new Date().toISOString(),source_sha256:(pages.length&&pdfLayoutDocument.sourceSha256)||payload.sha256||prior?.source_sha256||null,page_start:pages.length?Math.min(...pages):range?.start??prior?.page_start??null,page_end:pages.length?Math.max(...pages):range?.end??prior?.page_end??null,source_total_pages:(pages.length&&pdfLayoutDocument.totalPages)||range?.total||prior?.source_total_pages||null,
  // The part a draft takes over once complete (a refreshed layout), as the server keeps it: the part's own page then
  // points here instead of offering a second refresh.
  layout_version:pages.length?layoutStamp(pdfLayoutDocument):null,replaces_chapter_id:saved.libraryChapterId?null:(Object.hasOwn(payload,'replaceChapterId')?payload.replaceChapterId:prior?.replaces_chapter_id)||null,
  refreshed_from:pages.length?pdfLayoutDocument.refreshedFrom||null:prior?.refreshed_from||null};
}
// A save names the revision the tab's copy was made from. Another tab or device saved since: the server refuses it
// (history_conflict) and nothing is overwritten.
async function persistHistory(){
 const payload=historyPayload();if(!payload)return null;
 const id=activeHistoryId,body=id?{...payload,...(activeHistoryRevision!==null?{revision:activeHistoryRevision}:{})}:historyIdToCreate?{...payload,id:historyIdToCreate}:payload;
 let saved;
 try{saved=await api(id?`history/${encodeURIComponent(id)}`:'history',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
 catch(error){saved=await ownSave(error,id,payload);if(!saved){if(error?.data?.code==='history_conflict')bookChunkId='';throw error;}}
 activeHistoryId=saved.id;historyIdToCreate='';activeHistoryRevision=revisionOf(saved);activeHistoryMeta={title:payload.title,filename:payload.filename};lastSavedHistory=saved;const index=historyItems.findIndex(item=>item.id===saved.id),prior=index>=0?historyItems[index]:null,record=currentHistoryRecord(saved,payload,prior);if(index>=0)historyItems.splice(index,1);historyItems.unshift(record);renderHistory();
 // A range that just became a book part: later ranges of this file default to the same book.
 if(saved.libraryChapterId&&prior?.library_chapter_id!==saved.libraryChapterId){bookTarget={id:saved.libraryStoryId,replaceChapterId:''};loadBooks().catch(()=>{});}
 // The book exists once the range belongs to it (a draft for a chosen book, a new book on completion): it gets its cover.
 if(saved.libraryStoryId)syncBookCover(saved.libraryStoryId);
 return saved;
}
// A save whose answer was lost and that is sent again meets the revision it made itself: when the stored copy holds
// exactly what this tab sends, nothing of anyone else's was overwritten and the save stands.
async function ownSave(error,id,payload){
 if(error?.data?.code!=='history_conflict'||!id)return null;
 const stored=await api(`history/${encodeURIComponent(id)}`).catch(()=>null),state=stored?.state,parts=list=>Array.from({length:payload.state.parts.length},(_,i)=>String(list?.[i]||'').normalize('NFC'));
 if(!state||state.done!==payload.state.done||JSON.stringify(parts(state.translationParts))!==JSON.stringify(parts(payload.state.translationParts)))return null;
 return {id,status:stored.status,libraryStoryId:stored.library_story_id||null,libraryChapterId:stored.library_chapter_id||null,updatedAt:stored.updated_at,revision:stored.revision};
}
// What a refused save tells the student: the server's own words for a full history, a part too large, the day's new
// saves used up, a copy saved elsewhere since or a database behind the code (schema_outdated: on this machine they name
// start.cmd); a lost connection or a busy server otherwise.
const SAVE_REFUSALS=new Set(['history_conflict','history_full','too_many_parts','history_invalid','rate_limited','schema_outdated']);
const saveRefusal=error=>SAVE_REFUSALS.has(error?.data?.code)?String(error.message||'').trim():'';
// While a save has failed, a warning stays in view (also in the floating action bar on phones) and closing the tab asks
// first; the next successful save clears both.
function setUnsaved(value,error=null){
 unsaved=Boolean(value);saveError=unsaved?error:null;const warning=$('#save-warning');warning.hidden=!unsaved;warning.replaceChildren();if(!unsaved)return;
 const refusal=saveRefusal(error);
 // Signing in in another tab keeps this tab's work; the next save then goes through.
 if(signedOut(error)){const link=signInLink('đăng nhập lại ở tab mới');link.target='_blank';link.rel='noopener';warning.append('Chưa lưu được: phiên đăng nhập đã hết hạn. Đừng đóng tab; ',link,`, rồi bấm ${runLabel()}.`);}
 // A copy saved elsewhere since is reopened from the history; this tab's newer part cannot be saved over it. A whole-book
 // run reopens it itself when it goes on.
 else if(error?.data?.code==='history_conflict'){
  warning.append(`Chưa lưu được: ${refusal}`);const id=activeHistoryId;
  if(id&&!bookMode){const reopen=document.createElement('button');reopen.type='button';reopen.className='secondary save-warning-action';reopen.textContent='Mở bản mới nhất';reopen.addEventListener('click',()=>openHistory(id).catch(fail));warning.append(' ',reopen);}
 }
 else if(refusal)warning.append(`Chưa lưu được vào tài khoản: ${refusal} Đừng đóng tab.`);
 else warning.append(`Chưa lưu được vào tài khoản. Đừng đóng tab; kiểm tra mạng rồi bấm ${runLabel()}.`);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A lost connection, a busy server or a per-minute limit is tried again; a refusal, a daily limit or a database behind
// the code (which no wait mends) is not.
const retriableSave=error=>error?.data?.code!=='schema_outdated'&&(!error?.status||error.status===408||error.status===429&&!(Number(error.data?.retryAfter??error.retryAfter)>60)||error.status>=500);
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
// A refusal keeps its code (history_full, history_conflict…), so a whole-book run pauses for what it is, in the
// server's own words: the run's pause adds what to do for the book (whole-book.js pauseMessage), not a range run's.
// keptInTab: this tab shows translations the failed save was to keep (a paid batch), so a whole-book pause asks to keep
// the tab open and go on there, where the chunk this tab holds is saved first, instead of saying the progress is saved.
async function saveBeforeSpending(finished=false){
 const saved=await saveHistory();if(!unsaved)return saved;
 // The progress line says what happened; the save warning above the button (persistent) says why and what to do.
 const refusal=saveRefusal(saveError),kept=translationParts.some(text=>text?.trim());
 const message=bookRun&&refusal?refusal:finished?'Đã dịch xong nhưng chưa lưu được; không gọi Gemini lại.':'Đã dừng; chưa gửi thêm gì cho Gemini.';
 throw Object.assign(new Error(message),refusal?{code:'save_failed',status:saveError.status,data:saveError.data}:{code:'save_failed',status:0},{keptInTab:kept});
}
// A whole-book chunk cannot go on from a save that failed (its part would be lost), so these saves report their errors.
// A translation that is not saved yet lives only in this tab: opening another session, picking a file or editing the
// source (which starts a new session) asks first. True means: keep what is here.
function keepUnsaved(){return unsaved&&typeof confirm==='function'&&!confirm('Phần đã dịch chưa lưu sẽ mất nếu bạn mở hoặc nhập tài liệu khác. Vẫn tiếp tục?');}
function saveHistoryStrict(){historySave=historySave.catch(()=>{}).then(persistHistory);return historySave.then(saved=>{setUnsaved(false);return saved;},error=>{setUnsaved(true,error);throw error;});}
function glossaryText(value){return Object.entries(value||{}).map(([term,translation])=>`${term} = ${translation}`).join('\n');}
async function openHistory(id){
 if(running||keepUnsaved())return;
 const version=++selectionVersion;busy(true);
 try{
 await dualViewer.clear();pdfLayoutDocument=null;pdfExportUrl='';$('#download-pdf').disabled=true;
 const item=await api(`history/${encodeURIComponent(id)}`),state=item.state||{};if(version!==selectionVersion)return;unbindBook();selectedFile=null;refusedPick=null;lastPickPdf=false;selectedHash=Promise.resolve('');selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';bookTarget={id:item.library_story_id||'',replaceChapterId:item.library_chapter_id?'':item.replaces_chapter_id||''};pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];overflowIds=[];$('#source').readOnly=false;$('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';
 activeHistoryId=item.id;activeHistoryRevision=revisionOf(item);activeHistoryMeta={title:item.title,filename:item.filename,record:item};setUnsaved(false);$('#content-title').value=item.title||'';$('#content-title').setCustomValidity('');$('#content-title').removeAttribute('aria-invalid');$('#content-title-hint').textContent='';$('#source').value=state.source||'';setChoice($('#domain'),item.domain,'general');setChoice($('#mode'),storedMode(item),DEFAULT_MODE);modeTouched=true;renderModeHint();autoGlossary=false;$('#glossary').value=glossaryText(state.manualGlossary);
 const parts=Array.isArray(state.parts)?state.parts:[],plan=parts.map(text=>({text,pages:[],blockIds:{}}));translationParts=Array.isArray(state.translationParts)?state.translationParts.slice(0,parts.length):[];while(translationParts.length<parts.length)translationParts.push('');
 // A layout session counts its translated blocks: one Gemini would not translate can sit before others that it did.
 const done=state.pdfLayout?translationParts.filter(text=>text?.trim()).length:Math.min(Number(state.done)||0,parts.length),unit=state.pdfLayout?'đoạn':'phần';
 // notes: what the checks still found in a text session's parts ("Trang N · đoạn k: …"), named again; a layout session
 // names its blocks again from its state below.
 const notes=Array.isArray(state.notes)?state.notes.filter(note=>typeof note==='string'&&note.trim()):[];
 translationState={source:state.source||'',domain:$('#domain').value,mode:$('#mode').value,parts,plan,done,context:state.context||'',glossary:state.glossary||{},manualGlossary:state.manualGlossary||{},previousSource:state.previousSource||'',previousTranslation:state.previousTranslation||'',...(notes.length?{notes}:{})};
 renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});$('#translation').value=translationParts.filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value.trim();$('#download-rich').disabled=true;setNotes(state.pdfLayout?[]:notes);setFileStatus(item.filename||'');updateCount();
 // A finished session outside any book (its book deleted, its part taken over by a redone range) is said to be so: it
 // is not in Thư viện riêng, and the Worker exports only a part of a book, so it is never offered an export. A PDF it
 // exported before is still shown and downloaded as it is.
 const complete=done===parts.length,detached=complete&&!item.library_chapter_id,shown=Boolean(state.pdfLayout?.exported&&state.pdfLayout.renderVersion>=3);
 status(detached?`Bản dịch đã hoàn tất nhưng không còn trong Thư viện riêng; ${shown?'PDF đã xuất vẫn tải được ở đây':state.pdfLayout?'không xuất PDF được nữa':'vẫn xem được ở đây'}.`:complete?'Bản dịch đã hoàn tất và có trong Thư viện riêng.':`Đã khôi phục ${done}/${parts.length} ${unit}. ${sessionKey?'Bấm':'Dán khóa Gemini rồi bấm'} ${runLabel()}.`);renderHistory();$('.workspace').scrollIntoView({behavior:scrollBehavior(),block:'start'});
 if(state.pdfLayout){
  translationState.pdfLayout=state.pdfLayout;pdfLayoutDocument=await api(`pdf-layout/assets/${state.pdfLayout.assetId}/manifest`);markLegacyEdits();$('#pdf-layout-enabled').checked=true;clearPartStream();syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());$('#download-pdf').disabled=!complete||detached&&!shown;
  setNotes([...ocrNotes(),...(state.pdfLayout.ocrPending?[]:[unreadDoubtNote(translationState.mode)].filter(Boolean)),...keptBlockNotes()]);
  // Exports from an older renderer are rendered again from the saved translations: no Gemini call, no token cost.
  if(shown){pdfExportUrl=`/api/my/study/pdf-layout/assets/${state.pdfLayout.assetId}/translated`;await dualViewer.setExportedPdf(pdfExportUrl);}
  // An older layout is offered Cập nhật bố cục by the note under the run button, and nothing else is said.
  else if(state.pdfLayout.exported&&complete&&!detached)status(needsPdfLayoutRefresh()?'':'PDF này dùng cách dàn trang cũ. Bấm Xuất PDF tiếng Việt để dàn lại (không tốn token).');
  else if(complete&&!detached)await showMissingPdf(item.id,version);
 }
 }finally{busy(false);}
}
// A saved value that is no longer an option (a removed subject) falls back instead of leaving the field empty.
function setChoice(select,value,fallback){select.value=[...select.options].some(option=>option.value===value)?value:fallback;}
// Scrolling follows the student's reduced-motion setting; an explicit "smooth" would override the stylesheet's rule.
const scrollBehavior=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
// A run disables the key field (busy) before the key is checked; it is enabled again here so it can show why and take
// focus (above the floating action bar on phones).
function askForKey(input){input.disabled=false;input.reportValidity();input.focus();}
function key(){
 const input=$('#api-key'),entered=input.value.trim();
 if(entered){
  if(entered.length<20||entered.length>500||/[\r\n\0]/u.test(entered)){input.setCustomValidity('Khóa Gemini API không hợp lệ.');askForKey(input);throw new Error('Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa.');}
  sessionKey=entered;input.value='';input.setCustomValidity('');input.removeAttribute('aria-invalid');$('#key-status').textContent=KEY_LOADED;delete $('#key-status').dataset.tone;renderKeyHelp();
 }
 if(!sessionKey){const message=`Dán khóa Gemini rồi bấm ${runLabel()}.`;input.setCustomValidity(message);input.setAttribute('aria-invalid','true');askForKey(input);throw new Error(message);}
 return sessionKey;
}
// The key's promise is said here only, so each state of the key says it: in this tab, never stored.
const KEY_EMPTY='Khóa chỉ dùng trong tab này, không được lưu.',KEY_LOADED='Đã nạp khóa · chỉ dùng trong tab này, không lưu.',KEY_REFUSED='Gemini không nhận khóa này · chỉ dùng trong tab này, không lưu.';
// Where to get a key shows while the tab has none: before the first key, and again once Gemini refused it or it was
// cleared. Google's terms stay in every state. Xóa shows only when there is a key to clear (loaded, or typed in).
function renderKeyHelp(){const missing=!sessionKey;$('#key-help-link').hidden=!missing;$('#key-steps').hidden=!missing;$('#clear-key').hidden=missing&&!$('#api-key').value;}
// A key Gemini refused leaves the tab: the field asks for another (whole-book runs too, through outcome.reason).
function forgetKey(){
 sessionKey='';const input=$('#api-key');input.setAttribute('aria-invalid','true');input.disabled=false;input.focus();$('#key-status').textContent=KEY_REFUSED;$('#key-status').dataset.tone='danger';renderKeyHelp();
}
// The key is forgotten only when Gemini refused the key itself (gemini-key.js); a refused text, a quota or Gemini's
// location keeps it, so the student is never asked for a key that works.
function rejectKey(error){if(error?.status&&keyRefused(error))forgetKey();}
// Gemini counts thinking apart from the answer (usage.thinking): sent, received and thinking add up to the total.
// The running count stays under the run button once a request has cost something; the breakdown is in Nâng cao.
function addUsage(value){bookRun?.recordUsage(value);for(const field of ['prompt','output','thinking','total','requests'])usage[field]+=(Number(value?.[field])||0);const number=new Intl.NumberFormat('vi-VN');$('#usage-total').textContent=number.format(usage.total);$('#usage').hidden=!usage.total;$('.usage-detail').hidden=!usage.requests&&!usage.total;$('#usage-detail').textContent=`${number.format(usage.requests)} lần gửi · ${number.format(usage.prompt)} token gửi đi · ${number.format(usage.output)} token nhận về · ${number.format(usage.thinking)} token suy luận`;}
// The counts and Tra chữ Hán show once the box holds Chinese.
function updateCount(){const source=$('#source').value,length=source.length,number=new Intl.NumberFormat('vi-VN'),han=hasHan(source);$('#source-count').textContent=`${number.format(length)} ký tự`;$('#part-count').textContent=`${number.format(length?createTranslationPlan(source,preparedPages).length:0)} phần dịch`;showMetrics(han);updateRunBar();}
function showMetrics(han){for(const id of ['#source-count','#part-count','#source-lookup'])$(id).hidden=!han;$('.metrics').hidden=!han;}
// ---- The run button ----
// What Bắt đầu dịch does now, named as its label: a new run ("Bắt đầu dịch", "Dịch cả quyển"), the rest of a session
// ("Dịch tiếp"), the blocks still in Chinese ("Dịch lại 2 đoạn còn chữ gốc", secondary), or nothing ('' : hidden, the
// export is then the view's action). Every status that says "bấm …" names it as it reads.
function runState(){
 if(bookMode&&bookAvailable()){const label=bookButtonLabel(bookStates());return label==='Đã dịch xong'?{label:''}:{label};}
 const state=translationState;if(!state)return {label:'Bắt đầu dịch'};
 if(state.pdfLayout&&pdfLayoutDocument){
  let range='';try{range=translationRange().text;}catch{}
  if(selectedFile&&pdfLayoutRange&&range!==pdfLayoutRange)return {label:'Bắt đầu dịch'};
  const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),open=blocks.some((b,i)=>!translationParts[i]?.trim());
  if(unsaved||open||state.pdfLayout.ocrPending||pdfOcrResumable()||mustRefreshLayout())return {label:'Dịch tiếp'};
  const again=layoutCost().blocks;return again?{label:`Dịch lại ${again} đoạn còn chữ gốc`,secondary:true}:{label:''};
 }
 if(state.pdfLayout)return {label:'Dịch tiếp'};
 // Another range of a PDF read in the browser (or pages to read again) is a new run.
 if(selectedFile&&pdfAnalysis&&needsPreparation())return {label:'Bắt đầu dịch'};
 if($('#source').value.trim()!==String(state.source||'').trim()||!state.done)return {label:'Bắt đầu dịch'};
 return state.done<(state.parts?.length||0)||unsaved?{label:'Dịch tiếp'}:{label:''};
}
const runLabel=()=>runState().label||'Bắt đầu dịch';
// A PDF fills the source box itself, so its empty box is hidden; kept-layout and book sessions show their text in the
// viewer instead. On phones the action bar floats at the bottom of the screen while it holds an action: something to
// translate, or a run to stop; once a run is done the bar stays in place and the export is the action.
function updateRunBar(){
 const layout=Boolean(translationState?.pdfLayout||bookMode||bookJob&&!selectedFile||/\.pdf$/iu.test(selectedFile?.name||'')&&$('#pdf-layout-enabled').checked&&layoutConfig.configured);
 $('.source-panel').classList.toggle('is-pdf',/\.pdf$/iu.test(selectedFile?.name||'')||Boolean(translationState?.pdfLayout||bookJob&&!selectedFile));$('.source-panel').classList.toggle('is-layout',layout);
 // The option shows for a picked PDF (photos included, and one refused for its size) and an open kept-layout session.
 $('.pdf-layout-option').hidden=!(lastPickPdf||translationState?.pdfLayout);
 const {label,secondary=false}=runState(),button=$('#translate'),idle=!runActive;
 if(label&&button.textContent!==label)button.textContent=label;button.className=secondary?'secondary':'primary';button.hidden=!idle||!label;
 $('#run-bar').classList.toggle('is-floating',document.body.dataset.session==='in'&&(runActive||!button.hidden&&Boolean(selectedFile||bookJob||translationState||$('#source').value.trim())));
 renderExport();
}
// ---- Đối chiếu kết quả: the export group ----
// The ids stay (#download-pdf, #download, #download-rich); each is shown where it belongs, or hidden when this session can
// never make it: a kept layout gives the PDF (the text in the menu), a text run with pictures the page with pictures (.html,
// the text in the menu), any other text run the text. The first available is the main button: primary unless a run is
// going or #translate is the primary (Bắt đầu dịch, Dịch tiếp), so a secondary re-ask leaves the download the primary; a
// disabled one is not available yet. Toàn văn and the comparison show once there is a translation. A whole book's run
// offers none: the session in view is only its last chunk, and the book is read (and downloaded) in Thư viện riêng
// (#book-read).
function renderExport(){
 const group=$('.result-actions');if(!group)return;
 const pdf=$('#download-pdf'),txt=$('#download'),rich=$('#download-rich'),main=group.querySelector('.export-main'),menu=group.querySelector('.export-more'),list=menu.querySelector('.menu-list');
 const order=bookMode&&bookJob?[]:translationState?.pdfLayout||pdfLayoutDocument?[pdf,txt]:pageImages.size?[rich,txt]:[txt],usable=order.filter(button=>!button.disabled),[first,...rest]=usable;
 for(const button of [pdf,txt,rich])button.hidden=!usable.includes(button);
 pdf.textContent=pdfExportUrl?'Tải PDF':'Xuất PDF tiếng Việt';txt.textContent=first===txt?'Tải .txt':'Văn bản (.txt)';rich.textContent='Tải bản có hình (.html)';
 if(first){if(first.parentElement!==main)main.append(first);const go=$('#translate');first.className=!runActive&&(go.hidden||!go.classList.contains('primary'))?'primary':'secondary';}
 for(const button of rest){if(button.parentElement!==list)list.append(button);button.className='';}
 group.hidden=!first;menu.hidden=!rest.length;if(menu.hidden)menu.open=false;
 const text=Boolean($('#translation').value.trim());$('.combined-output').hidden=!text;$('.evaluation').hidden=!text;
}
function segments(text,limit=5000){const pieces=[];let remaining=text;while(remaining.length>limit){let end=remaining.lastIndexOf('\n',limit);if(end<limit/2){end=0;for(const match of remaining.slice(0,limit).matchAll(/[。！？!?；;]\s*/gu))end=match.index+match[0].length;}if(end<limit/2)end=limit;if(/[\uD800-\uDBFF]/u.test(remaining[end-1]))end--;pieces.push(remaining.slice(0,end));remaining=remaining.slice(end);}if(remaining)pieces.push(remaining);return pieces;}
function clearPartStream(){const root=$('#translation-parts');root.replaceChildren();root.hidden=true;}
function renderPartStream(parts){
 const root=$('#translation-parts');root.replaceChildren();root.hidden=!parts.length;
 parts.forEach((part,index)=>{
  // A chip only while the part waits, runs or failed (none once done), and Cần xem lại while a note names the part.
  const card=document.createElement('details'),summary=document.createElement('summary'),title=document.createElement('span'),state=document.createElement('span'),review=document.createElement('span'),body=document.createElement('div'),paired=document.createElement('div');
  card.className='translation-part queued';card.dataset.translationPart=String(index);title.textContent=partTitle(part,index);state.className='chip';state.dataset.partState='';state.textContent='Chờ dịch';review.className='chip';review.dataset.tone='warn';review.dataset.partReview='';review.textContent='Cần xem lại';review.hidden=true;body.className='translation-part-text';
  const toolbar=document.createElement('div');toolbar.className='part-toolbar';
  paired.className='translation-pair';if(part.pages.length){const originals=document.createElement('div');originals.className='part-originals';originals.id=`part-originals-${index}`;for(const number of part.pages){const image=pageImages.get(number);if(image){const entry=preparedPages.get(number);originals.append(originalPageView(number,image,entry,{onRegion:(block,region)=>openHanziPanel({text:block.text,title:`Nguyên tác · Trang ${number}`,note:['paddle','tesseract','gemini'].includes(entry?.engine)?OCR_NOTE:'',returnFocus:region})}));}}if(originals.children.length){paired.append(originals);paired.classList.add('has-original');const toggle=document.createElement('button');toggle.type='button';toggle.className='quiet compare-toggle';toggle.textContent='Đối chiếu trang gốc';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',originals.id);toggle.addEventListener('click',()=>{const comparing=paired.classList.toggle('comparing');toggle.setAttribute('aria-expanded',String(comparing));toggle.textContent=comparing?'Ẩn trang gốc':'Đối chiếu trang gốc';});toolbar.append(toggle);}}
  paired.append(body);summary.append(title,state,review);card.append(summary,toolbar,paired);root.append(card);
 });
}
function updatePart(index,text,state){
 const root=$('#translation-parts'),card=root.querySelector(`[data-translation-part="${index}"]`);if(!card)return;
 card.className=`translation-part ${state}`;const label=card.querySelector('[data-part-state]'),body=card.querySelector('.translation-part-text');
 label.textContent=state==='done'?'':state==='working'?'Đang dịch':state==='failed'?'Chưa dịch được':'Chờ dịch';label.dataset.tone=state==='failed'?'danger':state==='working'?'warn':'';
 if(text!==undefined){const article=document.createElement('article');article.className='translation-document';article.innerHTML=translationContentHtml(text,figuresForPart(translationState?.plan||[],index,pageImages));body.replaceChildren(article);}
 if(state!=='queued')card.open=true;
}
// #file-status is a status line: screen readers hear what a picked file is. busy: a per-page count is still running, and
// only its last line needs reading out.
function setFileStatus(text,{busy=false}={}){const line=$('#file-status');line.setAttribute('aria-busy',String(busy));line.textContent=text;}
// Suggests a translation the library published for the identical file. Admin uploads are capped at 25 MB, so larger
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
  $('#library-match-title').textContent=match.title;$('#library-match-open').href=`/?read=${encodeURIComponent(match.id)}`;$('#library-match').hidden=false;
 }catch{}
}
function busy(value){running=value||starting;$('#content-title').disabled=running;updateTitleControls();$('#translate').disabled=running;$('#source-file').disabled=running;$('#source').disabled=running;$('#mode').disabled=running;$('#domain').disabled=running;$('#glossary').disabled=running;$('#page-range').disabled=running;$('#pdf-layout-enabled').disabled=running;$('#api-key').disabled=running;$('#clear-key').disabled=running;$('#check-gemini-model').disabled=running;$('#gemini-model').disabled=running||!Array.from($('#gemini-model').options).some(option=>option.value);$('#stop').disabled=!running;$('#stop').hidden=!runActive||ocrAsking;dualViewer.renderState();$('#book-target').disabled=running;$('#book-replace').disabled=running;$('#book-next-range').disabled=running;$('#cover-change').disabled=running;$('#cover-none').disabled=running;$('#cover-translate').disabled=running;$('#book-pages').disabled=running;document.querySelectorAll('button:is([data-history-open],[data-history-merge],[data-book-order],[data-history-delete],[data-book-resume],[data-book-delete])').forEach(button=>{button.disabled=running;});renderBookMode();renderBookPanel();updateRunBar();renderLayoutRefresh();}

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
 $('#source-figures').hidden=!pageImages.size;$('#source-figures>summary').textContent=`Trang gốc (${pageImages.size})`;$('#download-rich').disabled=!pageImages.size||!$('#translation').value.trim();
}
async function blobDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
function escapeHtml(value){return String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
async function downloadRichHtml(){
 const title=historyTitle();
 const html=await buildStudyHtml({title,parts:translationState?.plan||[],translations:translationParts,images:pageImages,blobDataUrl,combined:$('#translation').value});
 saveFile(new Blob(['\uFEFF'+html],{type:'text/html;charset=utf-8'}),downloadFilename('html'));
}
// A file made in the tab is handed to the browser as a download. Its address stays valid for about a minute, or until
// the page is left: a browser inside another app (iOS) may read it well after the click.
const DOWNLOAD_URL_MS=60_000;
function saveFile(blob,filename){
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;
 const revoke=()=>{clearTimeout(timer);removeEventListener('pagehide',revoke);URL.revokeObjectURL(url);},timer=setTimeout(revoke,DOWNLOAD_URL_MS);
 addEventListener('pagehide',revoke);link.click();
}
// Inside Zalo, Facebook, Messenger… (in-app-browser.js) a downloaded file is often dropped: the student is first told how
// to open this page in Chrome or Safari, with its address to copy; "Vẫn tải ở đây" downloads all the same. Never blocks.
async function offerDownload(download){
 const app=inAppBrowser();if(!app)return download();
 const {browser,name,menu}=openInBrowserHelp(app),address=location.href,saved=Boolean(activeHistoryId)&&!unsaved;
 openBookDialog(`Mở bằng ${browser} để tải tệp về máy`,body=>{
  const text=document.createElement('p'),label=document.createElement('label'),input=document.createElement('input'),line=document.createElement('div'),copy=document.createElement('button'),said=document.createElement('span');
  text.textContent=`${name} thường không lưu được tệp tải về. ${menu}, hoặc sao chép địa chỉ rồi dán vào ${browser}${saved?'; bản dịch đã lưu, có thể tải lại từ Lịch sử dịch':''}.`;
  label.htmlFor='in-app-address';label.textContent='Địa chỉ trang';Object.assign(input,{id:'in-app-address',type:'text',readOnly:true,value:address,spellcheck:false});
  line.className='in-app-copy';copy.type='button';copy.className='secondary';copy.textContent='Sao chép địa chỉ';said.setAttribute('role','status');
  copy.addEventListener('click',async()=>{
   try{await navigator.clipboard.writeText(address);said.textContent=`Đã sao chép. Mở ${browser} rồi dán vào thanh địa chỉ.`;}
   catch{input.focus();input.select();said.textContent='Không sao chép tự động được. Địa chỉ đã được chọn: giữ ngón tay trên ô để sao chép.';}
  });
  line.append(copy,said);body.append(text,label,input,line);
 },async()=>{Promise.resolve().then(download).catch(fail);},'Vẫn tải ở đây','Đang tải…');
}

// A new pick starts afresh: the error of a file picked before (one that could not be opened, a photo that could not be
// read) leaves the progress line and, on phones, the floating action bar.
function clearStatus(){status('');$('#run-bar-status').textContent='';}
async function selected(file){await layoutConfiguration;const isPdf=file?.name.toLowerCase().endsWith('.pdf'),useLayout=isPdf&&$('#pdf-layout-enabled').checked;lastPickPdf=Boolean(isPdf);updateRunBar();if(isPdf)await pdfTools();if(file?.size>(useLayout?wholeBook.SOURCE_MAX_BYTES:isPdf?PDF_MAX_BYTES:OTHER_MAX_BYTES)){refusedPick=useLayout?file:null;throw new Error(useLayout?'PDF giữ bố cục tối đa 100 MB. Bỏ chọn “Giữ bố cục PDF và xuất PDF tiếng Việt” để dịch thành văn bản.':isPdf?'PDF tối đa 250 MB khi xử lý tại trình duyệt.':'Tệp tối đa 25 MB.');}const version=++selectionVersion;clearStatus();selectedFile=file;refusedPick=null;unbindBook();resetHistoryIdentity();bookTarget={id:'',replaceChapterId:''};bookChoiceTouched=false;selectedHash=fileSha256(file);selectedSha256='';selectedTotalPages=0;resetCover();autoRange='';pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';overflowIds=[];await dualViewer.clear();clearPartStream();$('#source').readOnly=false;$('#source').value='';$('#translation').value='';setNotes([]);$('#download').disabled=true;$('#download-pdf').disabled=true;$('#pdf-range-options').hidden=true;$('#page-range').value='';updateCount();$('#library-match').hidden=true;if(!file){setFileStatus('');return;}showLibraryMatch(version);
 if(useLayout){const {pdfPageCount}=await import('./pdf-client.js');setFileStatus('Đang kiểm tra số trang PDF…');let total;try{total=await pdfPageCount(file);}catch(error){if(version!==selectionVersion)return;throw forgetPickedFile(file,error);}if(version!==selectionVersion)return;$('#pdf-range-options').hidden=false;autoRange=$('#page-range').value=`1-${Math.min(3,total)}`;selectedTotalPages=total;const large=file.size>OTHER_MAX_BYTES;setFileStatus(`${total} trang · ${megabytes(file.size)}`);renderBookMode();if(large)setBookMode(true);prepareBookTarget(version,{suggest:true});coverTask=detectSelectedCover(file,version);findBookJob(version);return;}
 if(!isPdf){await prepare();return;}
 setFileStatus('Đang kiểm tra lớp chữ PDF trên trình duyệt…',{busy:true});try{const {analyzePdf}=await import('./pdf-client.js');const analysis=await analyzePdf(file,(page,total)=>{if(version===selectionVersion)setFileStatus(`Đang đọc trang ${page}/${total}…`,{busy:true});});if(version!==selectionVersion)return;pdfAnalysis=analysis;}catch(error){if(version!==selectionVersion)return;throw forgetPickedFile(file,error);}
 $('#pdf-range-options').hidden=false;selectedTotalPages=pdfAnalysis.totalPages;
 const start=pdfAnalysis.mode==='scan'&&pdfAnalysis.totalPages>30?Math.max(1,Math.floor(pdfAnalysis.totalPages/2)-1):1,end=Math.min(pdfAnalysis.totalPages,start+2);
 autoRange=$('#page-range').value=start===end?String(start):`${start}-${end}`;
 if(pdfAnalysis.mode==='text'){$('#source').value=pdfAnalysis.pages.filter(page=>page.number>=start&&page.number<=end).map(page=>page.text).join('\n\n');updateCount();setFileStatus(`${pdfAnalysis.totalPages} trang · có lớp chữ${pdfAnalysis.pictured?` · ${pdfAnalysis.pictured} trang có chữ trong hình sẽ được nhận dạng thêm`:''}`);}
 else setFileStatus(`${pdfAnalysis.pagesWithText?`${pdfAnalysis.pagesWithText} trang có lớp chữ · `:''}${pdfAnalysis.scanPages} trang scan · nhận dạng chữ khi bấm ${runLabel()}.`);
 prepareBookTarget(version);detectSelectedCover(file,version);
}
// Photos of pages (JPG, PNG, WebP) become one PDF on the device, a page per photo in the order picked; every PDF path
// (kept layout, reading in the browser, whole book) then reads it as a scan. Several files at once are photos only.
const PHOTO=/\.(?:jpe?g|png|webp)$/iu,MAX_PHOTOS=60;
const isPhoto=file=>/^image\/(?:jpeg|png|webp)$/u.test(file?.type||'')||PHOTO.test(file?.name||'');
async function pickFiles(files){
 clearStatus();refusedPick=null;if(!files.length||files.length===1&&!isPhoto(files[0]))return selected(files[0]);
 if(!files.every(isPhoto))throw new Error('Chỉ chọn nhiều tệp cùng lúc khi tất cả là ảnh chụp trang; tài liệu khác chọn từng tệp.');
 if(files.length>MAX_PHOTOS)throw new Error(`Mỗi lần chọn tối đa ${MAX_PHOTOS} ảnh; hãy chia thành nhiều lượt.`);
 setFileStatus(files.length>1?`Đang ghép ${files.length} ảnh thành một PDF trên thiết bị…`:'Đang chuyển ảnh thành PDF trên thiết bị…',{busy:true});
 let pdf;try{pdf=await photosToPdf(files);}catch(error){$('#source-file').value='';setFileStatus(error.message);throw error;}
 return selected(pdf);
}
// Each photo is drawn upright (as the browser shows it) at most 2,400 px on its long side, which keeps a page of text
// sharp for OCR and a PDF of 20 photos well under the 25 MB a kept-layout range takes. No creation time is written, so
// the same photos picked again give the same bytes, hence the same SHA-256: their unfinished whole-book run goes on and
// the ranges already in a book are found, instead of being translated and paid for again.
async function photosToPdf(files){
 const {PDFDocument}=await import('/vendor/pdf-lib.esm.min.js'),pdf=await PDFDocument.create({updateMetadata:false});
 for(const file of files){
  const url=URL.createObjectURL(file),image=new Image();
  try{image.src=url;await image.decode();}catch{throw new Error(`Không đọc được ảnh “${file.name}”. Hãy chọn ảnh JPG, PNG hoặc WebP.`);}finally{URL.revokeObjectURL(url);}
  const scale=Math.min(1,2400/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
  const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));canvas.width=canvas.height=1;if(!jpeg)throw new Error(`Không chuyển được ảnh “${file.name}” thành PDF.`);
  // A page as wide as A4 (portrait or landscape, like the photo), as tall as the photo's shape asks.
  const embedded=await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer())),width=embedded.width>embedded.height?841.89:595.28,height=width*embedded.height/embedded.width;
  pdf.addPage([width,height]).drawImage(embedded,{x:0,y:0,width,height});
 }
 return new File([await pdf.save()],`${files[0].name.replace(/\.[^.]+$/u,'')||'anh-chup'}.pdf`,{type:'application/pdf'});
}
// A PDF that cannot be opened (a password, a broken download) leaves nothing picked: the file line says why, nothing
// waits on it, and picking the same file again once it is fixed reads it afresh. Returns the error for #progress.
function forgetPickedFile(file,error){
 selectionVersion++;selectedFile=null;selectedHash=Promise.resolve('');selectedSha256='';selectedTotalPages=0;autoRange='';pdfAnalysis=null;bookTarget={id:'',replaceChapterId:''};resetCover();
 $('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';$('#library-match').hidden=true;
 setFileStatus(`Chưa mở được “${file.name}”. ${String(error?.message||error)}`);renderBookMode();updateRunBar();
 return Object.assign(new Error(`Chưa mở được tệp “${file.name}”.`),{cause:error,status:error?.status});
}
// marks: a whole page's reading, returned as {text, marked}: marked is the reading with the lines Gemini took for a running
// head or foot marked [đầu trang]/[chân trang] (when the server sends it), which cleanReadPages uses.
async function geminiOcr(blob,page,{marks=false}={}){
 const form=new FormData();form.set('apiKey',key());form.set('model',await ensureStudyModel('text'));form.set('mode',$('#mode').value);form.set('image',blob,`page-${page}.${blob.type==='image/webp'?'webp':'jpg'}`);
 const result=await api('ocr',{method:'POST',body:form});addUsage(result.usage);
 if(result.warnings?.length)ocrWarnings.push(...result.warnings.map(warning=>`OCR trang ${page}: ${warning}`));
 return marks?{text:result.text,marked:typeof result.marked==='string'?result.marked:null}:result.text;
}
// D8 for the pages read from their image (a scan, a text layer read again): a line repeated at the same edge of three pages
// or more is a running head or foot, kept where it first appears and dropped where it repeats; a number in step with the
// pages goes; headings and body lines stay (document-layout.js pageFurniture, as for the text layer's pages and the
// server's OCR text). An edge is firm where the reading says it: a line Gemini marked, or a paragraph the device placed in
// the page's top or bottom tenth no taller than the body's lines; else a Gemini page's first or last two lines are a guess,
// which needs more to go. Each page keeps its reading (raw) for the next pass; the marks never reach the text.
const EDGE_MARK=/^\s*\[(đầu|chân)\s+trang\]\s*/iu;
function devicePlaces(layout){
 const blocks=new Map((layout?.blocks||[]).map(b=>[b.id,b])),heights=[...blocks.values()].map(b=>b.box?.height).filter(Number.isFinite).sort((a,b)=>a-b),body=heights[Math.floor(heights.length/2)]||0,places=new Map();
 for(const paragraph of layout?.paragraphs||[]){
  const boxes=(paragraph.blockIds||[]).map(id=>blocks.get(id)?.box).filter(Boolean);if(!boxes.length)continue;
  const top=Math.min(...boxes.map(b=>b.y)),bottom=Math.max(...boxes.map(b=>b.y+b.height)),tall=Math.max(...boxes.map(b=>b.height));
  const edge=top<.1&&bottom<.2?'top':bottom>.9&&top>.8?'bottom':'';if(edge&&tall<=1.15*body)places.set(sameText(paragraph.text),{edge,firm:tall<=.95*body});
 }
 return places;
}
function cleanReadPages(pages){
 const read=[...pages].filter(([,entry])=>['gemini','paddle','tesseract'].includes(entry.engine)).sort((a,b)=>a[0]-b[0]).map(([number,entry])=>{
  entry.raw??=entry.marked||entry.text||'';
  const raw=entry.raw.split('\n'),device=entry.engine!=='gemini',places=device?devicePlaces(entry.layout):new Map(),lines=[];
  raw.forEach((line,at)=>{const mark=line.match(EDGE_MARK),text=(mark?line.slice(mark[0].length):line).trim();if(text)lines.push({at,text,mark:mark?(/^đầu$/iu.test(mark[1])?'top':'bottom'):''});});
  lines.forEach((line,i)=>{const place=places.get(sameText(line.text));line.edge=line.mark||place?.edge||(device?'':i<2?'top':i>=lines.length-2?'bottom':'');line.guess=Boolean(line.edge)&&!line.mark&&!place?.firm;});
  return {number,entry,raw,lines};
 });
 const furniture=pageFurniture(read.map(({number,lines})=>({number,lines})));
 read.forEach(({entry,raw,lines},index)=>{const drop=new Set([...furniture[index].drop].map(i=>lines[i].at));entry.text=raw.filter((line,at)=>!drop.has(at)).map(line=>line.replace(EDGE_MARK,'')).join('\n').replace(/\n{3,}/gu,'\n\n').trim();});
}
async function prepare(){if(!selectedFile)return false;busy(true);let localOcr=null;try{
  if(!selectedFile.name.toLowerCase().endsWith('.pdf')){const form=new FormData();form.set('file',selectedFile);const result=await api('extract',{method:'POST',body:form});$('#source').value=result.text;setFileStatus(selectedFile.name);}
  else{
   if(!pdfAnalysis)throw new Error('Hãy đợi phân tích PDF hoàn tất.');
   const selectedPages=translationRange().pages;
   for(const page of preparedPages.keys())if(!selectedPages.has(page)){preparedPages.delete(page);releasePageImage(pageImages.get(page));pageImages.delete(page);}
   const {uploadPreparedPdf,readPictureText,scanReading}=await import('./pdf-client.js');
   await uploadPreparedPdf(selectedFile,pdfAnalysis,async(item,page,total)=>{
    // Pages still flagged needsGemini (weak local OCR, no key yet at the time) are retried once a key
    // becomes available; everything else (text layer, confident local OCR, already-Gemini pages) is kept.
    const existing=preparedPages.get(page);if(existing&&!wantsGemini(existing))return;if(stopRequested)throw new Error('Đã dừng sau trang hiện tại.');
    keepPageImage(page,item.previewBlob);
    // What the analysis found on the page (a scan read again despite its text layer, Han in pictures), said once.
    if(item.note&&!ocrWarnings.includes(item.note))ocrWarnings.push(item.note);
    if(item.kind==='text'){
     const figures=await keepPageFigures(page,item.layout);let text=item.text;
     // Han in pictures or outlines outside the figures kept as pixels (analyzePdf regions): read on the device, or by
     // Gemini under a Cách dịch that reads every scan with Gemini (Kỹ nhất); a region the device cannot read, or fails
     // on, is tried once with Gemini when a key is there. Set where it stands (readPictureText). A page whose regions the
     // device read (device) is read again by Gemini once Kỹ nhất is chosen before its translation begins (wantsGemini).
     let device=false,note='';if(existing?.note)ocrWarnings=ocrWarnings.filter(line=>line!==existing.note);
     if(item.regions?.length){
      const gemini=modeProfile($('#mode').value).textOcr==='gemini'&&Boolean(optionalKey());
      if(!gemini&&!localOcr){localOcr=await import('./local-ocr.js');await allowOcrDownload(localOcr);}
      // PaddleOCR reads Chinese well: its reading of letters or digits alone (an English label, a formula) says the region
      // holds no Chinese. Tesseract may read a title as a few letters, so such a region goes to Gemini when a key is there.
      // A stop asked meanwhile sends no further region.
      const read=await readPictureText(item,async blob=>{
       if(!gemini){
        const assessment=await localOcr.recognizeChinesePage(blob,message=>{const line=ocrStatus(localOcr,message,page,total);if(line)status(line);}).catch(()=>null),sure=assessment?.engine==='paddle';
        if(assessment&&(/\p{Script=Han}/u.test(assessment.text)||!optionalKey()||sure&&/[\p{L}\p{N}]/u.test(assessment.text))){device=true;return {text:assessment.text,sure};}
       }
       if(stopRequested)throw Object.assign(new Error('Đã dừng sau trang hiện tại.'),{code:'stopped'});
       status(`Đang đọc chữ trong hình của trang ${page}/${total} bằng Gemini…`);return geminiOcr(blob,page);
      },page,figures);
      text=read.text;note=read.note;if(note)ocrWarnings.push(note);
     }
     preparedPages.set(page,{text,layout:item.layout,engine:'pdf-text',needsGemini:false,device,note});return;
    }
    if(!localOcr)localOcr=await import('./local-ocr.js');
    if(!existing?.assessment)await allowOcrDownload(localOcr);
    status(`Đang nhận dạng chữ trên thiết bị · trang ${page}/${total} · không tốn token…`);
    const assessment=existing?.assessment||await localOcr.recognizeChinesePage(item.blob,message=>{const line=ocrStatus(localOcr,message,page,total);if(line)status(line);});
    // Said once in each document read while PaddleOCR is unavailable.
    const notice=assessment.fallbackReason?localOcr.fallbackNotice(assessment.fallbackReason):'';if(notice&&!ocrWarnings.includes(notice))ocrWarnings.push(notice);
    // Cách dịch says which scanned pages Gemini reads (textOcr): those the device read poorly, or (Kỹ nhất) every one.
    const textOcr=modeProfile($('#mode').value).textOcr,fallback=shouldUseGeminiOcr(textOcr,assessment);
    if(fallback&&optionalKey()){
     if(assessment.needsGemini)ocrWarnings.push(`Trang ${page}: ${assessment.missedCells?localOcr.missedNotice(assessment.missedCells):`nhận dạng chữ trên thiết bị chỉ đạt ${assessment.confidence}%`} nên đã dùng Gemini cho riêng trang này.`);
     status(assessment.needsGemini?`Trang ${page}/${total} khó đọc · đang chuyển riêng trang này sang Gemini…`:`Đang đọc trang scan ${page}/${total} bằng Gemini (Cách dịch ${modeName($('#mode').value)})…`);const reading=await geminiOcr(item.blob,page,{marks:true});preparedPages.set(page,{text:reading.text,marked:reading.marked,layout:assessment.layout,engine:'gemini',needsGemini:false,assessment});
    }else{
     preparedPages.set(page,{text:assessment.text,layout:assessment.layout,engine:assessment.engine,confidence:assessment.confidence,metrics:assessment.metrics,assessment,needsGemini:assessment.needsGemini});
     if(assessment.needsGemini)ocrWarnings.push(`Trang ${page}: ${assessment.missedCells?`${localOcr.missedNotice(assessment.missedCells)}, có thể thiếu chữ`:`nhận dạng chữ trên thiết bị đạt ${assessment.confidence}% và có thể thiếu chữ hoặc công thức`}${!optionalKey()?' (dán khóa Gemini để đọc lại trang này)':''}. Hãy đối chiếu ảnh gốc.`);
    }
    // The labels inside a figure kept as pixels are cut from the text the device read, whose layout says where each line
    // lies. A page Gemini read (paid for, and told to keep diagram labels) keeps Gemini's text as it came.
    const figures=await keepPageFigures(page,assessment.layout),prepared=preparedPages.get(page);
    if(figures.length&&prepared&&['paddle','tesseract'].includes(prepared.engine))prepared.text=textOutsideFigures(assessment.layout,figures);
    // A scan under its own OCR text or a stamp (analyzePdf reclassified) keeps that layer where the reading holds
    // clearly fewer Han, and gains the lines the reading adds (scanReading).
    if(prepared&&item.reclassified){const merged=scanReading(item,prepared.text,page);prepared.text=merged.text;prepared.marked=null;if(merged.note)ocrWarnings.push(merged.note);}
   },()=>{},selectedPages,{keepTextPreviews:true});
   cleanReadPages(preparedPages);preparedRangeKey=translationRange().text;
   $('#source').value=joinedPageText(preparedPages);
   setNotes(ocrWarnings);renderPageImages();
   const figureCount=[...pageImages.values()].reduce((sum,item)=>sum+item.figures.length,0);
   setFileStatus(`${preparedPages.size} trang${figureCount?` · ${figureCount} hình giữ nguyên từ bản gốc`:''}`);
  }
  updateCount();status('Đã chuẩn bị nguyên tác.');return Boolean($('#source').value.trim());
 }catch(error){rejectKey(error);fail(error,{run:runActive});return false;}finally{if(localOcr)await localOcr.terminateLocalOcr().catch(()=>{});busy(false);stopRequested=false;}}

// The progress line while the device reads a scan. A first download says its size: PaddleOCR's at once, Tesseract's with
// the share done; an engine this browser already keeps only starts, so nothing is said about downloading.
function ocrStatus(localOcr,message,page,total){
 if(message.status==='loading model')return message.cached?'Đang khởi động bộ nhận dạng chữ…':`Đang tải bộ nhận dạng chữ lần đầu (khoảng ${localOcr.OCR_DOWNLOAD.paddle.mb} MB) · tài liệu không rời khỏi thiết bị…`;
 if(message.engine==='tesseract'&&'download' in message)return message.cached?'Đang khởi động bộ nhận dạng chữ…':`Đang tải Tesseract (khoảng ${localOcr.OCR_DOWNLOAD.tesseract.mb} MB lần đầu)… ${Math.round(message.download*100)}%`;
 if(message.status==='recognizing text')return `Đang nhận dạng chữ trên thiết bị · trang ${page}/${total} · 0 token`;
 if(message.status==='fallback')return 'Nhận dạng chữ bằng Tesseract trên thiết bị, thay cho PaddleOCR…';
 return '';
}
// On Save-Data or a slow connection the first local OCR asks before downloading its engine, with the size of the one this
// install uses (PaddleOCR, or Tesseract without it); the answer holds for this tab, and an engine the browser already
// keeps is not asked about. Without navigator.connection (Safari, Firefox) nothing is asked, as before. Dừng counts as
// "Để sau": the preparation stops, saying how much is to be downloaded later.
let ocrDownloadAllowed=false,ocrChoice=null;
async function allowOcrDownload(localOcr){
 if(ocrDownloadAllowed)return;
 const connection=navigator.connection,slow=Boolean(connection?.saveData)||/^(?:slow-2g|2g|3g)$/u.test(connection?.effectiveType||'');
 const download=slow?await localOcr.ocrDownload():{cached:true};
 if(download.cached){ocrDownloadAllowed=true;return;}
 $('#ocr-download-title strong').textContent=`Tải bộ nhận dạng chữ về máy (khoảng ${download.mb} MB)?`;
 $('#ocr-download-text').textContent=`Trang scan được nhận dạng chữ ngay trên máy, không tốn token. Lần đầu cần tải khoảng ${download.mb} MB (${connection.saveData?'trình duyệt đang bật tiết kiệm dữ liệu':'kết nối đang chậm'}).`;
 ocrAsking=true;$('#stop').hidden=true;$('#ocr-download').hidden=false;status('Chọn ở trên để tiếp tục.');$('#ocr-download-yes').focus();
 const allowed=await new Promise(resolve=>{ocrChoice=resolve;});ocrChoice=null;ocrAsking=false;$('#stop').hidden=!runActive;$('#ocr-download').hidden=true;$('#progress').focus();
 if(!(ocrDownloadAllowed=allowed))throw Object.assign(new Error(`Đã để sau. Khi có Wi-Fi, bấm ${runLabel()} để tải bộ nhận dạng chữ (khoảng ${download.mb} MB, một lần).`),{code:'ocr_declined'});
}
function hasUsableKey(){return !!(sessionKey||$('#api-key').value.trim());}
// A prepared page Gemini still has to read once a key is there: one the device read poorly, or, under a Cách dịch that
// reads every scan with Gemini (Kỹ nhất), one the device read (a scan, or the pictured regions of a text page), as long as
// no translation of these pages has begun.
const wantsGemini=entry=>Boolean(entry?.needsGemini)||!translationState&&modeProfile($('#mode').value).textOcr==='gemini'&&(['paddle','tesseract'].includes(entry?.engine)||Boolean(entry?.device));
function needsPreparation(){
 if(!selectedFile||!selectedFile.name.toLowerCase().endsWith('.pdf'))return false;
 if(!pdfAnalysis)return false;
 let range='';try{range=translationRange().text;}catch{return true;}
 if(preparedRangeKey!==range||!preparedPages.size)return true;
 // A key arriving after a weak local-only OCR pass should trigger one retry of just those pages.
 return hasUsableKey()&&[...preparedPages.values()].some(wantsGemini);
}
// The pressed button hides while the run goes on: keyboard focus moves to Dừng (or the progress line), and when the run
// ends to what comes next (nextFocus: Dịch tiếp, else the export), unless something else (the key field) took it on purpose.
async function run(){
 if(running||starting)return;requireContentTitle();const pressed=document.activeElement===$('#translate');starting=true;runActive=true;busy(true);
 if(pressed)($('#stop').hidden?$('#progress'):$('#stop')).focus({preventScroll:true});
 try{
  await layoutConfiguration;
  if(bookMode&&bookAvailable()){await selectionTask;return await runWholeBook();}
  // An opened layout session goes on as one, whatever the checkbox (it chooses how a newly picked PDF is read).
  if(translationState?.pdfLayout||$('#pdf-layout-enabled').checked&&selectedFile?.name.toLowerCase().endsWith('.pdf')){await selectionTask;return await runPdfLayout({fromRun:true});}
  await ensureStudyModel('text');
  if(selectedFile&&!pdfAnalysis&&selectedFile.name.toLowerCase().endsWith('.pdf'))status('Đang chờ đọc xong PDF…');
  return await runStudyTranslation({selectionTask,requireKey:key,needsPreparation,hasSource:()=>Boolean($('#source').value.trim()),hasFile:()=>Boolean(selectedFile),prepare,translate});
 // The run's own session may now be named as lacking its PDF (missingPdf), in the history and in Sách của tôi.
 }finally{starting=false;runActive=false;busy(false);renderHistory();if(pressed&&[document.body,$('#stop'),$('#progress')].includes(document.activeElement))nextFocus().focus({preventScroll:true});}
}

function pdfTranslations(){const blocks=pdfLayoutDocument?.pages.flatMap(p=>p.blocks)||[];return blocks.map((b,i)=>({id:b.id,translation:translationParts[i]||''})).filter(b=>b.translation.trim());}
// A layout an older extractor read (translation-modes.js LAYOUT_VERSION: its oldest page's stamp; scanned and text-layer
// pages alike) may keep headings, captions or lines as printed Chinese: "Cập nhật bố cục" (refreshLayout) is offered.
function needsPdfLayoutRefresh(){return Boolean(pdfLayoutDocument)&&layoutStamp(pdfLayoutDocument)<LAYOUT_VERSION;}
// A scan extracted before Gemini read scanned blocks again, or whose unread blocks have no crop to send, cannot be read on:
// Bắt đầu dịch extracts it again first. One whose every scanned block was read or kept (ocrHandled) never is.
function mustRefreshLayout(){
 const scanned=pdfLayoutDocument?.pages.filter(p=>p.ocr)||[];if(!scanned.length)return false;
 return (pdfLayoutDocument.extractionVersion||0)<2||!pdfLayoutDocument.ocrCorrectedVersion&&scanned.some(p=>p.blocks.some(b=>!ocrHandled(b)));
}
// OCR that stopped part-way (Gemini error, closed tab) resumes on the same asset: the server keeps every finished
// batch, so re-extracting would pay for those images again. A draft whose OCR never started still refreshes. A refreshed
// layout has translations (those carried over) while its new blocks still wait for their reading.
function pdfOcrResumable(){
 const pending=pdfLayoutDocument?.pages.filter(p=>p.ocr).flatMap(p=>p.blocks).filter(b=>!ocrHandled(b))||[];
 return Boolean(translationState?.pdfLayout&&pending.length&&pending.every(b=>b.image||b.ocrSheet)&&(translationState.pdfLayout.ocrPending||pdfLayoutDocument.ocrCorrectedVersion===0));
}
// The translation of each block of a refreshed layout: its saved block's, named by known (the saved id; ids are numbered
// afresh, so a same id may be another block), with its formula tokens renamed in order where the extractor numbers them
// otherwise; '' for a new or grown block. Hand edits are translations too, so they stay.
function carriedTranslations(before,parts,after){
 const old=before.pages.flatMap(p=>p.blocks),index=new Map(old.map((b,i)=>[b.id,i]));
 return after.pages.flatMap(p=>p.blocks).map(b=>{
  const i=typeof b.known==='string'?index.get(b.known):undefined,text=i===undefined?'':String(parts[i]||'');if(!text.trim())return '';
  const from=(old[i].inlines||[]).map(inline=>inline.token),to=(b.inlines||[]).map(inline=>inline.token);if(from.length!==to.length)return '';
  let value=text;from.forEach((token,k)=>{value=value.split(token).join(`\u0000${k}\u0000`);});to.forEach((token,k)=>{value=value.split(`\u0000${k}\u0000`).join(token);});
  return value;
 });
}
// The blocks Bắt đầu dịch sends (those without a translation, and those whose translation still keeps Chinese: a run
// asks for them again, hand translations excepted), and about what reading and translating them costs
// (translation-modes.js blockTokens): the OCR sheets of those still to read, their characters, the requests the
// session's Cách dịch sends.
function layoutCost(){
 const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),allowed=Object.values(usableGlossary()),edited=handEdited(),legacy=legacyBlocks();
 const fresh=blocks.filter((b,i)=>{const text=translationParts[i];return !text?.trim()||!edited.has(b.id)&&!legacy.has(b.id)&&stillChinese(b,text,allowed);}),unread=fresh.filter(b=>!ocrHandled(b)),mode=translationState.mode;
 const sheets=new Set(unread.map(b=>b.ocrSheet).filter(Boolean)).size+unread.filter(b=>!b.ocrSheet&&b.image).length,characters=fresh.reduce((sum,b)=>sum+b.source.length,0),{layoutBatch,ocrBatch}=modeProfile(mode);
 const requests=(fresh.length?Math.max(Math.ceil(fresh.length/layoutBatch.blocks),Math.ceil(characters/layoutBatch.chars)):0)+Math.ceil(sheets/ocrBatch.images);
 return {blocks:fresh.length,tokens:blockTokens({sheets,characters,requests},mode)};
}
const tokenText=value=>new Intl.NumberFormat('vi-VN').format(value>=1000?Math.round(value/100)*100:value);
// The open session as the history lists it, or as it was opened (a session older than the listed page, opened from
// Thư viện riêng's link): its book, its part and the part it takes over.
const openRecord=()=>historyItems.find(item=>item.id===activeHistoryId)||(activeHistoryMeta.record?.id===activeHistoryId?activeHistoryMeta.record:null);
// The unfinished session that will take the open part over (a refreshed layout begun before, here or on another device):
// the copy names the layout it was made from (refreshed_from); one saved before that is known, for a part of a book, by
// the chapter it replaces, and for a draft, which has none yet, by the same file and pages read by this extractor in a
// session begun after it. A draft is never refreshed twice into two copies of its pages.
const refreshTaker=()=>{
 const record=openRecord(),chapter=record?.library_chapter_id,asset=translationState?.pdfLayout?.assetId;if(!record)return null;
 const copy=item=>Boolean(asset)&&item.refreshed_from===asset||(chapter?item.replaces_chapter_id===chapter:Boolean(record.source_sha256)&&item.source_sha256===record.source_sha256&&item.page_start===record.page_start&&item.page_end===record.page_end&&Number(item.layout_version)>=LAYOUT_VERSION&&String(item.created_at||'')>String(record.created_at||''));
 // A copy finished already (it named this layout) took a draft's pages into the book: the draft is not refreshed again.
 return historyItems.find(item=>item.id!==activeHistoryId&&item.status!=='complete'&&copy(item))||(asset&&!chapter?historyItems.find(item=>item.id!==activeHistoryId&&item.refreshed_from===asset):null)||null;
};
// What "Cập nhật bố cục" left to do: the blocks to read and translate and about their tokens, with how many translated
// blocks the refreshed copy kept (pdfLayout.carried: those its extractor found again as they were; a block whose text
// region or formula crops changed is read and translated again).
function refreshSummary(cost){
 const carried=translationState.pdfLayout?.carried,again=carried?Math.min(cost.blocks,Math.max(0,carried.before-carried.kept)):0;
 return `Còn ${cost.blocks} đoạn cần đọc và dịch${again?` (${again} đoạn đổi vùng chữ khi tách lại)`:''}, khoảng ${tokenText(cost.tokens)} token${carried?.before?`; giữ bản dịch của ${carried.kept}/${carried.before} đoạn`:''}.`;
}
// After a run: the primary (Dịch tiếp when there is more to run, else the main export, or a finished book's link to Thư
// viện riêng), else the progress line (never a hidden button).
function nextFocus(){const go=$('#translate'),main=$('.result-actions:not([hidden]) .export-main>button');return !go.hidden&&go.classList.contains('primary')?go:main||$('#whole-book:not([hidden]) #book-read:not([hidden])')||(!go.hidden?go:$('#progress'));}
// A finished session that left its book (its part taken over by a newer range, or its book deleted) has nothing to refresh.
const detachedSession=()=>{const record=openRecord();return record?.status==='complete'&&!record.library_chapter_id;};
// Under the progress line, for an open layout session: "Cập nhật bố cục" for a layout an older extractor read (or the
// refreshed copy begun already), and after a refresh what is left to read and translate, about what it costs, until done.
function renderLayoutRefresh(){
 const box=$('#layout-refresh');if(!box)return;
 const session=Boolean(translationState?.pdfLayout&&pdfLayoutDocument)&&!running&&!bookMode,taker=session&&needsPdfLayoutRefresh()?refreshTaker():null,older=session&&needsPdfLayoutRefresh()&&!pdfOcrResumable()&&!detachedSession();
 const refreshed=session&&!older&&pdfLayoutDocument.pages.some(p=>p.blocks.some(b=>typeof b.known==='string'))?layoutCost():null;
 const text=taker?.status==='complete'?'Bố cục của phần này đã được cập nhật trong một bản dịch đã xong; bản này không cần dịch tiếp.'
  :taker?`Bố cục của phần này đã được cập nhật trong một bản dịch chưa xong (còn ${taker.total_parts-taker.translated_parts} đoạn chưa dịch).${openRecord()?.library_chapter_id?' Phần này giữ nguyên trong Thư viện riêng tới khi PDF mới xuất xong.':''}`
  :older?'Phần này dùng bố cục cũ: tiêu đề hoặc chú thích ngoài các đoạn có thể còn chữ Trung. Cập nhật bố cục không tốn token; Hoa Trí báo số đoạn và token trước khi dịch.'
  // What is left after a refresh and about its tokens, until it is done. Only a copy that takes a part of a book over has
  // an old part in Thư viện riêng (a refreshed draft has none).
  :refreshed?.blocks?`${refreshSummary(refreshed)}${bookTarget.replaceChapterId||openRecord()?.replaces_chapter_id?' Phần cũ vẫn ở Thư viện riêng tới khi PDF mới xuất xong.':''}`:'';
 box.hidden=!text;box.replaceChildren();if(!text)return;
 const line=document.createElement('p');line.textContent=text;box.append(line);if(!taker&&!older)return;
 const actions=document.createElement('div'),button=document.createElement('button');actions.className='note-actions';button.type='button';button.className='secondary';
 button.textContent=taker?'Mở bản cập nhật bố cục':'Cập nhật bố cục';button.addEventListener('click',()=>(taker?openHistory(taker.id):refreshLayout()).catch(fail));actions.append(button);box.append(actions);
}
// "Cập nhật bố cục": the stored original is read again by this site's extractor (no Gemini; one of the day's PDF
// extractions). The blocks it finds again as saved keep their reading (backend/pdf-layout.js) and their translation; new
// or grown ones are read and translated only once Bắt đầu dịch is pressed, after the count and the estimate are shown.
// The copy is a new session that takes the part over in its book once it is complete, and the part keeps its old PDF
// until the new one is exported (backend/study-history.js). With nothing new, the PDF is exported at once (no token).
async function refreshLayout(){
 if(running||!translationState?.pdfLayout||!pdfLayoutDocument)return;
 runActive=true;busy(true);stopRequested=false;
 try{
  status('Đang tách lại các trang bằng bộ tách mới (không tốn token)…');
  const result=await pdfService(()=>api('pdf-layout/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,forceClone:true,mode:translationState.mode})}),'update');
  // A PDF service older than this page (a Worker that does not refuse its answer, backend/pdf-layout.js) reads the pages
  // as an older extractor: its copy is not taken.
  if(layoutStamp(result.document)<LAYOUT_VERSION){status('Dịch vụ PDF vẫn dùng bộ tách trang cũ; thử lại sau khi dịch vụ được cập nhật (máy này: chạy lại start.cmd).','error');return;}
  await adoptRefreshed(result);const cost=layoutCost();
  if(!cost.blocks){await exportLayoutPdf(false);status('Đã cập nhật bố cục · PDF đã lưu vào Thư viện riêng (không tốn token).');return;}
  // The note under the button says what is left and about its tokens.
  status(`Đã cập nhật bố cục. Bấm ${runLabel()} để đọc và dịch các đoạn mới.`);
 }catch(error){if(error?.code==='stopped')status(error.message);else{rejectKey(error);fail(error);}}
 finally{runActive=false;busy(false);stopRequested=false;renderHistory();}
}
// A refreshed layout becomes the open session: a new one, in the old one's book, taking its part over once complete
// (bookTarget.replaceChapterId; the server keeps it for a draft continued elsewhere). Each block found again keeps its
// translation (carriedTranslations); the session keeps its terms, context and Cách dịch.
async function adoptRefreshed(result){
 const before=pdfLayoutDocument,parts=translationParts.slice(),old=translationState,prior=openRecord(),title=historyTitle(),filename=selectedFile?.name||activeHistoryMeta.filename||'';
 if(prior?.library_story_id)bookTarget={id:prior.library_story_id,replaceChapterId:prior.library_chapter_id||prior.replaces_chapter_id||''};
 resetHistoryIdentity();activeHistoryMeta={title,filename};await adoptPdfLayout(result);
 Object.assign(translationState,{mode:old.mode||translationState.mode,domain:old.domain||translationState.domain,context:old.context||'',glossary:{...(old.glossary||{}),...translationState.manualGlossary},manualGlossary:translationState.manualGlossary});
 translationParts=carriedTranslations(before,parts,pdfLayoutDocument);translationState.done=translationParts.filter(text=>text?.trim()).length;
 // A hand translation carried over stays the student's; carried: how many of the translated blocks the copy kept.
 const edited=new Set(old.pdfLayout?.edited||[]),legacy=new Set(old.pdfLayout?.legacy||[]),review=old.pdfLayout?.review||{},blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),carry=(b,i)=>Boolean(translationParts[i]?.trim())&&typeof b.known==='string';
 translationState.pdfLayout.edited=blocks.filter((b,i)=>carry(b,i)&&edited.has(b.known)).map(b=>b.id);
 // Blocks that may be older hand edits, and the problems of drafts carried over, go with their translations.
 translationState.pdfLayout.legacy=blocks.filter((b,i)=>carry(b,i)&&legacy.has(b.known)).map(b=>b.id);
 translationState.pdfLayout.review=Object.fromEntries(blocks.flatMap((b,i)=>carry(b,i)&&Array.isArray(review[b.known])?[[b.id,review[b.known]]]:[]));
 translationState.pdfLayout.carried={before:parts.filter(text=>text?.trim()).length,kept:translationState.done};
 // A hand translation of a block the new extractor reads anew (its text region changed, or its reading was not final:
 // unreadable, kept machine text) cannot be carried: it is named, so the student can write it again.
 const carried=new Set(translationState.pdfLayout.edited.map(id=>blocks.find(b=>b.id===id)?.known)),lost=before.pages.flatMap(page=>page.blocks.map((b,k)=>({b,label:`Trang ${page.number} · đoạn ${k+1}`}))).filter(({b})=>edited.has(b.id)&&!carried.has(b.id));
 if(lost.length)addNotes(`${lost.map(item=>item.label).join(', ')} (bố cục cũ): bản dịch tay không được giữ vì vùng chữ đổi khi tách lại; hãy dịch tay lại.`);
 syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());
 addNotes(keptBlockNotes());
 await saveBeforeSpending(translationState.done===translationState.parts.length);
}
function syncLayoutParts(){const parts=pdfLayoutDocument.pages.flatMap(p=>p.blocks).map(b=>b.source);Object.assign(translationState,{source:parts.join('\n\n'),parts,plan:parts.map(text=>({text,pages:[],blockIds:{}}))});}
// A new asset becomes the session before OCR starts, so a failed OCR batch leaves something to resume.
// A whole-book chunk starts with the book's terms and the context the chunk before it left.
// Its terms stay fixed (fixedGlossary): a later chunk never renames what the book already says, unless the student does.
async function adoptPdfLayout(result,{glossary={},context=''}={}){
 await dualViewer.clear();pdfLayoutDocument=result.document;pdfExportUrl='';const manualGlossary=parseStudyGlossary($('#glossary').value);
 translationState={mode:$('#mode').value,domain:$('#domain').value,done:0,context,glossary:{...glossary,...manualGlossary},manualGlossary,fixedGlossary:glossary,pdfLayout:{assetId:result.assetId,ocrPending:true,edited:[]}};syncLayoutParts();
 // One note per line, the last one ended too: a note added later starts its own line, where dropBlockNotes finds it.
 translationParts=[];clearPartStream();overflowIds=[];$('#download-pdf').disabled=true;setNotes(pdfLayoutDocument.warnings);syncPdfText();
}
// The slim /ocr-blocks answer (backend/pdf-layout.js ocrBlockFields) carries only the blocks just read: they are applied
// to this tab's copy of the manifest, so no batch sends the whole manifest with its page images back. A server without
// it answers {document} as before. reread: the call read its blocks again; chosen: the IDs it was asked to read again
// (the others of their sheets only came along).
function applyOcrAnswer(output,{reread=false,chosen=null}={}){
 if(!Array.isArray(output?.blocks)){if(output?.document)pdfLayoutDocument=output.document;return;}
 const byId=new Map(pdfLayoutDocument.pages.flatMap(p=>p.blocks).map(b=>[b.id,b]));
 // ocrKept: Gemini could not read the block again and it keeps its machine OCR text (a later reading clears the mark).
 // ocrDoubt: Gemini's reading was used but looks doubtful. ocrRereads: how often the block was read again; a server that
 // does not say still never gets a block asked for again from this tab.
 for(const value of output.blocks){
  const block=byId.get(value?.id);if(!block)continue;Object.assign(block,{source:value.source,text:value.text,ocrCorrected:value.ocrCorrected===true},value.kind!==undefined?{kind:value.kind}:{},value.bold!==undefined?{bold:value.bold}:{});
  for(const field of ['ocrKept','ocrDoubt'])if(typeof value[field]==='string'&&value[field])block[field]=value[field];else delete block[field];
  if(value.keepPixels===true)block.keepPixels=true;else delete block.keepPixels;
  if(Number.isInteger(value.ocrRereads)&&value.ocrRereads>0)block.ocrRereads=value.ocrRereads;else if(!reread)delete block.ocrRereads;else if(!chosen||chosen.includes(value.id))block.ocrRereads=(Number(block.ocrRereads)||0)+1;
 }
 if(output.ocrCorrectedVersion!==undefined)pdfLayoutDocument.ocrCorrectedVersion=output.ocrCorrectedVersion;
 if(Array.isArray(output.ocrWarnings))pdfLayoutDocument.ocrWarnings=output.ocrWarnings;
}
// Returns false when shouldStop (Dừng) ended it early, before the next paid batch: the manifest keeps every batch already
// read and the session keeps ocrPending, so the next run reads on from there. heartbeat (whole-book runs) follows every
// batch: it keeps the job held while a long chunk is read. A block Gemini could not read keeps its machine text and is
// named in the warnings ("Trang N · đoạn k: …"); onNotes (whole-book runs) keeps those notes past the chunk. Read or kept,
// a block is never sent again, except once more as its Cách dịch reads such blocks again (translation-modes.js reread):
// the blocks that kept their machine text, and the readings that look doubtful, of the codes it names, are read again with
// more thinking once all are read, at most maxPerPage a page, kept ones first.
async function correctPdfOcr(model,{shouldStop=()=>false,heartbeat=async()=>{},onNotes=()=>{}}={}){
 // A manifest with OCR sheets is read a whole sheet (several blocks, one image) at a time, in calls as large as the
 // session's Cách dịch allows.
 const {ocrImageBatches}=await boxLayout(),mode=isMode(translationState.mode)?translationState.mode:DEFAULT_MODE,{ocrBatch,reread}=modeProfile(mode);
 const pages=pdfLayoutDocument.pages.filter(p=>p.ocr),blocks=pages.flatMap(p=>p.blocks),sheets=pages.flatMap(p=>p.ocrSheets||[]),pending=blocks.filter(b=>!ocrHandled(b));
 const note=output=>{const lines=Array.isArray(output?.warnings)?output.warnings.filter(text=>typeof text==='string'&&text.trim()):[];if(lines.length){addNotes(lines);onNotes(lines);}};
 // chosen: the IDs a reading again is asked for (rereadIds); the others of their sheets go along, as a sheet is read whole.
 const read=async(ids,chosen=null)=>{
  const again=Boolean(chosen);let output;
  // Stopped part-way (a quota, Gemini overloaded…): the blocks read before the stop are stored and come with the error
  // (api() has counted its tokens). Kept here, the next try (Bắt đầu dịch, or a whole-book run's own) asks only for the
  // sheets still to read.
  try{output=await api('pdf-layout/ocr-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,blockIds:ids,apiKey:key(),model,mode,...(again?{reread:true,rereadIds:chosen}:{}),slim:true})});}
  catch(error){if(Array.isArray(error?.data?.blocks)){applyOcrAnswer(error.data,{reread:again,chosen});note(error.data);}throw error;}
  applyOcrAnswer(output,{reread:again,chosen});model=output.model||model;addUsage(output.usage);note(output);
  await heartbeat();
 };
 let done=blocks.length-pending.length;
 for(const ids of ocrImageBatches(pending,undefined,sheets,ocrBatch)){
  if(shouldStop()){status(`Đã dừng khi đọc chữ trong ảnh (${done}/${blocks.length} đoạn). Bấm ${runLabel()} để đọc tiếp.`);return false;}
  status(bookRun?`Đang đọc chữ trong ảnh ${chunkPages()} · ${done}/${blocks.length} đoạn…`:`Đang đọc chữ trong ảnh… ${done}/${blocks.length} đoạn`);
  await read(ids);done+=ids.length;
 }
 if(reread){
  // A block packed into a sheet is read again with its whole sheet (the image is sent once, as the route takes it); only
  // the chosen blocks count it (rereadIds), never the others of the sheet. A sheet holding more blocks than one call of
  // this mode may is left as it is, so its blocks are no candidates and use none of their page's quota. That quota counts
  // the blocks the page already had read again (a pass Dừng stopped goes on within it).
  const sheetSize=new Map(sheets.map(s=>[s.id,s.strips.length])),fits=b=>!sheetSize.has(b.ocrSheet)||sheetSize.get(b.ocrSheet)<=ocrBatch.blocks;
  const again=b=>!(b.ocrRereads>0)&&(rereads(reread.kept,b.ocrKept)||rereads(reread.doubt,b.ocrDoubt))&&fits(b),quota=page=>Math.max(0,(reread.maxPerPage??Infinity)-page.blocks.filter(b=>b.ocrRereads>0).length);
  const chosen=new Set(pages.flatMap(page=>page.blocks.filter(again).sort((a,b)=>Boolean(b.ocrKept)-Boolean(a.ocrKept)).slice(0,quota(page))));
  // Never more blocks in one call than the route reads again at once.
  const touched=new Set([...chosen].map(b=>b.ocrSheet).filter(Boolean)),batches=chosen.size?ocrImageBatches(blocks.filter(b=>chosen.has(b)||touched.has(b.ocrSheet)),undefined,sheets,ocrBatch).filter(ids=>ids.length<=ocrBatch.blocks):[];
  for(const ids of batches){
   if(shouldStop()){status(`Đã dừng khi đọc kỹ lại chữ trong ảnh. Bấm ${runLabel()} để đọc tiếp.`);return false;}
   const named=blocks.filter(b=>chosen.has(b)&&ids.includes(b.id));status(`Đang đọc kỹ lại ${named.length} đoạn chữ trong ảnh còn đáng ngờ…`);
   await read(ids,named.map(b=>b.id));
  }
  // A note that a block keeps its machine text is gone once Gemini read that block after all.
  if(batches.length){setNotes(liveOcrNotes(notes));bookNotes=liveOcrNotes(bookNotes);}
  const doubt=unreadDoubtNote(mode);if(doubt){addNotes(doubt);onNotes([doubt]);}
 }
 // History requires parts to match the manifest, which now holds the corrected sources.
 syncLayoutParts();delete translationState.pdfLayout.ocrPending;syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,[]);return true;
}
function syncPdfText(){
 const blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),number=new Intl.NumberFormat('vi-VN');$('#source').value=blocks.map(b=>b.text).join('\n\n');$('#source').readOnly=true;showMetrics(hasHan($('#source').value));
 // A formula's machine text goes in through a function, so a $ it holds is never read as a replacement pattern.
 $('#translation').value=blocks.map((b,i)=>{let text=translationParts[i]||'';for(const inline of b.inlines||[])text=text.replace(inline.token,()=>inline.text);return text;}).filter(Boolean).join('\n\n');$('#download').disabled=!$('#translation').value;$('#source-count').textContent=`${number.format($('#source').value.length)} ký tự`;$('#part-count').textContent=`${number.format(blocks.length)} đoạn`;
}
// The PDF service is shared by every student: a busy service, this account's other PDF call or a service restarting is
// waited out with a countdown (Dừng stops waiting) before the student is told. The service of the machine running Hoa
// Trí gets a few short waits (it may still be starting), then the server's words say how to start it (start.cmd). A
// whole-book run has its own waits (whole-book.js classifyError), so there the error goes straight back to it.
const PDF_WAITS={pdf_service_busy:[15,'Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc.'],pdf_busy:[10,'Tài khoản của bạn đang có một lượt xử lý PDF khác (ở tab hoặc thiết bị khác).'],pdf_unavailable:[3,'Dịch vụ PDF tạm thời chưa phản hồi.'],pdf_local_off:[3,'Dịch vụ PDF trên máy này chưa trả lời (có thể còn đang khởi động).']};
// A selection too heavy for one job of the service: fewer pages work (backend/pdf-layout.js).
const HEAVY_PDF=new Set(['pdf_timeout','pdf_memory','pdf_too_large','pdf_crash']);
// While every place of the service is taken (pdf_service_busy) or this account's other PDF call holds its own
// (pdf_busy), the file is not uploaded again just to find out: after each wait GET pdf-layout/capacity (no lease, no
// daily count) says whether a place is free, and the request goes again only then, or at the last try. A capacity call
// that fails (an older server, a lost connection) changes nothing: the request is sent as before.
const PLACE_WAITS=new Set(['pdf_service_busy','pdf_busy']);
async function pdfPlace(){
 try{const answer=await api('pdf-layout/capacity');return typeof answer?.busy==='boolean'?answer:null;}
 catch(error){if(signedOut(error))throw error;return null;}
}
async function pdfService(request,operation){
 // held: the refusal still standing while the service says it has no free place (nothing was sent for it again);
 // after: the seconds the service asked to wait before it is asked again.
 for(let attempt=0,held=null,after=null;;attempt++){
  let error=held;held=null;
  if(!error)try{return await request();}catch(caught){error=caught;}
  // A stop names the button that asks again: Cập nhật bố cục for its own refresh (operation 'update'), else Bắt đầu dịch.
  const code=error?.data?.code,[tries,message]=PDF_WAITS[code]||[0,''],stopped=()=>Object.assign(new Error(`${message} Đã thôi chờ; bấm ${operation==='update'?'Cập nhật bố cục':operation==='render'?'Xuất PDF tiếng Việt':runLabel()} khi muốn thử lại.`),{code:'stopped'});
  if(HEAVY_PDF.has(code)&&operation==='extract'&&!/ít trang hơn/u.test(error.message))error.message=`${error.message} Hãy chọn ít trang hơn cho lượt này (ví dụ 3–5 trang) rồi bấm ${runLabel()}.`;
  if(bookRun||attempt>=tries||stopRequested)throw error;
  const seconds=Math.min(120,Math.max(5,Math.round(Number(after??error.data?.retryAfter??error.retryAfter)||20)));after=null;
  if(await waitSeconds(seconds,(left,first)=>status(`${message} Tự thử lại sau ${left} giây… Bấm Dừng để thôi chờ.`,'',{quiet:!first})))throw stopped();
  if(PLACE_WAITS.has(code)&&attempt+1<tries){const place=await pdfPlace();if(stopRequested)throw stopped();if(place?.busy){held=error;after=Number(place.retryAfter)||null;}}
 }
}
// Resolves true when Dừng was pressed during the wait.
function waitSeconds(seconds,onTick){
 return new Promise(resolve=>{let left=seconds;onTick(left,true);const timer=setInterval(()=>{if(stopRequested){clearInterval(timer);resolve(true);}else if(--left<=0){clearInterval(timer);resolve(false);}else onTick(left,false);},1000);});
}
async function runPdfLayout({fromRun=false}={}){
 if(running&&!fromRun)return;
 key();if(!layoutConfig.configured)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');busy(true);stopRequested=false;
 try{
  const range=translationRange().text;
  // A draft an older extractor read whose refreshed copy exists (here or on another device: the list is read again) is not
  // translated on: finished too, it would give its book the same pages twice. Its copy is opened from the note below.
  if(translationState?.pdfLayout&&!(selectedFile&&pdfLayoutRange!==range)&&needsPdfLayoutRefresh()&&!openRecord()?.library_chapter_id){
   await refreshHistoryList();
   const taker=refreshTaker();if(taker){status(`Bố cục của phần này đã được cập nhật trong một bản dịch ${taker.status==='complete'?'đã xong':'chưa xong'}, nên bản này không dịch tiếp.`,'error');return;}
  }
  let selectedModel=await ensureStudyModel('pdf');
  // A scan that cannot be read on is extracted again first (its blocks found again keep their reading and translation);
  // the refreshed copy is a new session that rejoins the old one's book and takes its part over, never adding the pages twice.
  if(translationState?.pdfLayout&&!pdfOcrResumable()&&mustRefreshLayout()){
   status('Đang cập nhật bố cục scan và tách lại vùng chữ khỏi hình gốc…');
   await adoptRefreshed(await pdfService(()=>api('pdf-layout/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,forceClone:true,mode:$('#mode').value})}),'refresh'));
  }
  if(!translationState?.pdfLayout||selectedFile&&pdfLayoutRange!==range){
   if(!selectedFile)throw new Error('Hãy chọn PDF gốc.');status('Đang tách các đoạn chữ trên trang PDF…');const form=new FormData(),sha256=await selectedHash;form.set('file',selectedFile);form.set('pages',range);if(sha256)form.set('sha256',sha256);
   // The new session's Cách dịch goes with it: Kỹ nhất has scanned pages cut into finer OCR sheets.
   form.set('mode',$('#mode').value);const result=await pdfService(()=>api('pdf-layout/extract',{method:'POST',body:form}),'extract');
   // Phones on plain HTTP cannot hash in the browser; the Worker's hash still lets the book and its cover remember this file.
   if(!selectedSha256&&/^[a-f\d]{64}$/u.test(result.document?.sourceSha256||''))selectedSha256=result.document.sourceSha256;
   resetHistoryIdentity();pdfLayoutRange=range;if(bookChoiceActive())updateBookHint();clearPageImages();await adoptPdfLayout(result);await saveBeforeSpending();
  }
  // A term the student added to or removed from the field since the session began applies to the blocks left.
  syncManualGlossary();
  const outcome=await translateLayoutSession(selectedModel,{retryKept:true}),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks);
  if(outcome.ocrStopped)return;
  // Nothing left to send: what the student still has to look at (drafts kept with the session, hand-kept Chinese) is said.
  if(outcome.idle){const count=reviewCount(outcome);$('#download-pdf').disabled=false;status(`Đã dịch đủ các đoạn${count?` · ${count} đoạn cần xem lại`:''}. Bấm ${pdfExportUrl?'Tải PDF':'Xuất PDF tiếng Việt'}.`);return;}
  // Finished after its refreshed copy became a part of its book (another tab or device): it stays out of that book.
  if(outcome.complete&&lastSavedHistory?.supersededBy){$('#download-pdf').disabled=true;status('Đã dịch xong, nhưng sách đã có bản cập nhật bố cục của các trang này nên bản này không vào sách.');return;}
  // The refused blocks are named in Cần xem lại; the status says what happened and the button that goes on.
  const complete=outcome.complete;$('#download-pdf').disabled=!complete;status(complete?'Đang xuất PDF tiếng Việt…':outcome.halted?.length?`Gemini từ chối cả lượt ${outcome.halted.length} đoạn nên Hoa Trí dừng để đỡ tốn token. Còn ${blocks.length-translationState.done} đoạn: bấm ${runLabel()}.`:`Đã dừng sau ${translationState.done}/${blocks.length} đoạn${unsaved?'':'; tiến độ đã lưu'}.`,outcome.halted?.length&&!complete?'error':'');
  if(complete)await exportLayoutPdf(false);
 }catch(error){if(error?.code==='stopped')status(error.message);else{rejectKey(error);fail(error,{run:true});}}finally{busy(false);stopRequested=false;}
}
// "Cần xem lại" of a part (layoutReview): "2 đoạn giữ nguyên chữ gốc vì Gemini không dịch được, 1 đoạn dùng bản dịch còn
// thiếu số hoặc dẫn chứng".
const REVIEW_KEYS=['kept','han','rows','numbers','unread','ocr'],emptyReview=()=>Object.fromEntries(REVIEW_KEYS.map(key=>[key,0]));
// How many blocks a part leaves to the student, for "Xong · … · 2 đoạn cần xem lại" (Cần xem lại names them).
const reviewCount=review=>REVIEW_KEYS.reduce((sum,key)=>sum+(Number(review?.[key])||0),0);
// The pages of the chunk a whole-book run translates ("trang 2–21"), for its progress line.
function chunkPages(){const numbers=(pdfLayoutDocument?.pages||[]).map(page=>page.number);return numbers.length?pageLabel(Math.min(...numbers),Math.max(...numbers)):'';}
function reviewNote({kept=0,han=0,rows=0,numbers=0,unread=0,ocr=0}={}){return [kept?`${kept} đoạn giữ nguyên chữ gốc vì Gemini không dịch được`:'',han?`${han} đoạn còn chữ Hán chưa dịch`:'',rows?`${rows} đoạn có thể thiếu dòng`:'',numbers?`${numbers} đoạn dùng bản dịch còn thiếu số hoặc dẫn chứng`:'',unread?`${unread} đoạn giữ nguyên hình gốc vì Gemini không đọc được chữ trong ảnh`:'',ocr?`${ocr} đoạn chữ trong ảnh có thể đọc sai`:''].filter(Boolean).join(', ');}
// A block Gemini would not translate, even alone and after the server's own retry (translate-blocks partial), gets a
// stand-in so the part can still be saved, exported and read: its better translation when that one is only incomplete
// (draft: numbers or citations missing, Chinese left, a line missing), or else its Chinese source. Each is named in the
// warnings and counted in "Cần xem lại", and the block editor takes either. A range run asks again for the blocks still in
// Chinese; a whole-book run asks once more for its stand-ins before the chunk is exported (retryPass), so one refusal never
// stops a book.
const CONTENT_FAILURES=new Set(['block_check','gemini_refused','gemini_truncated','gemini_malformed']);
// A failure that stopped the request part-way (a quota, Gemini overloaded…) is raised as that error would have been on
// its own (backend/gemini-errors.js), so the usual waits, pauses and key handling apply to it.
const STOP_STATUS={quota_minute:429,quota_day:429,quota:429,rate_limited:429,gemini_unavailable:503,gemini_location:503};
function stopError(failure){const after=Number(failure.retryAfter),retryAfter=Number.isFinite(after)&&after>0?after:null;return Object.assign(new Error(String(failure.message||'Gemini dừng giữa chừng.')),{status:STOP_STATUS[failure.code]||400,data:{code:failure.code,...(retryAfter?{retryAfter}:{})},retryAfter});}
// A stand-in: the block's own Chinese, kept because Gemini did not translate it.
const standIn=(block,text)=>Boolean(text?.trim())&&/\p{Script=Han}/u.test(block.source)&&text.normalize('NFC')===block.source.normalize('NFC');
// The glossary a batch is sent with: the student's own terms, and a learned one only as a Vietnamese rendering, its Chinese
// in parentheses after a reading at most (learnedTerm, as text mode and the server learn). A learned term keeping Chinese
// bare (saved before this rule) would keep that Chinese in every later block.
function usableGlossary(){
 const own=translationState?.manualGlossary||{};
 return Object.fromEntries(Object.entries(translationState?.glossary||{}).filter(([term,value])=>typeof value==='string'&&(Object.hasOwn(own,term)||learnedTerm(term,value))));
}
// Still Chinese, as every Cách dịch sees it (translation-modes.js hanLeft, allowed: the glossary's renderings): a stand-in,
// or Chinese kept beyond quoted examples, the renderings and a name glossed in parentheses.
const stillChinese=(block,text,allowed)=>standIn(block,text)||Boolean(text?.trim())&&hanLeft(block.source,text,allowed).length>0;
function blockLabel(block){const page=pdfLayoutDocument.pages.find(entry=>entry.blocks.includes(block));return page?`Trang ${page.number} · đoạn ${page.blocks.indexOf(block)+1}`:block.id;}
// "Trang 1 · đoạn 3, Trang 2 · đoạn 7": at most five named, then how many more.
function blockNames(blocks){const labels=[...new Set(blocks.map(blockLabel))];return labels.length>5?`${labels.slice(0,5).join(', ')} và ${labels.length-5} đoạn khác`:labels.join(', ');}
// Blocks still in Chinese in a session opened again, and those whose scan could not be read: the warnings that named them
// are gone, so they are named again.
function keptBlockNotes(){
 const blocks=pdfLayoutDocument?.pages.flatMap(p=>p.blocks)||[],allowed=Object.values(usableGlossary()),edited=handEdited(),legacy=legacyBlocks(),drafted=draftProblems();
 return blocks.flatMap((b,i)=>{
  const text=translationParts[i];if(!text?.trim()||edited.has(b.id))return [];
  if(b.keepPixels&&text===b.source)return [`${blockLabel(b)}: ${OCR_UNREAD_NOTE}`];
  if(standIn(b,text))return [`${blockLabel(b)}: vẫn là chữ gốc vì Gemini chưa dịch được đoạn này.`];
  const han=hanLeft(b.source,text,allowed),problems=drafted.get(b.id)||[];
  if(han.length)return [legacy.has(b.id)?`${blockLabel(b)}: bản dịch còn chữ Hán (${han.slice(0,5).join('; ')}), có thể là bản dịch tay trước đây nên không gửi lại cho Gemini. Muốn Gemini dịch lại: dán đúng chữ gốc của đoạn vào ô bản dịch rồi bấm “Lưu đoạn đã sửa”.`:`${blockLabel(b)}: bản dịch vẫn còn chữ Hán chưa dịch: ${han.slice(0,5).join('; ')}.`];
  // A draft Gemini gave without a line or a number of its source, kept to look at (a later run does not send it again).
  if(problems.includes('rows'))return [`${blockLabel(b)}: bản dịch có thể thiếu dòng so với nguyên tác.`];
  return problems.includes('numbers')?[`${blockLabel(b)}: bản dịch có thể thiếu số hoặc dẫn chứng của nguyên tác.`]:[];
 });
}
// What a part leaves to the student ("Cần xem lại"), each block once: its scan unreadable (unread), its Chinese kept
// (kept), Chinese left in its translation (han), a draft lacking a line (rows) or numbers (numbers; drafted: the problems of
// the drafts the session holds), or a reading Gemini could not make or doubts (ocr).
function layoutReview(blocks,drafted=draftProblems(),allowed=Object.values(usableGlossary())){
 const count=emptyReview(),edited=handEdited();
 for(const [i,b] of blocks.entries()){
  const text=translationParts[i],problems=drafted.get(b.id)||[];if(!text?.trim())continue;
  if(b.keepPixels&&text===b.source)count.unread++;else if(standIn(b,text)&&!edited.has(b.id))count.kept++;
  else if(!edited.has(b.id)&&(problems.includes('han')||hanLeft(b.source,text,allowed).length))count.han++;else if(problems.includes('rows'))count.rows++;
  else if(problems.includes('numbers'))count.numbers++;else if(b.ocrKept||b.ocrDoubt)count.ocr++;
 }
 return count;
}
// The OCR notes the manifest keeps (blocks kept with their machine OCR text, Gemini's remarks on the scans), shown again
// with a session opened again.
function ocrNotes(){return [...new Set(liveOcrNotes((Array.isArray(pdfLayoutDocument?.ocrWarnings)?pdfLayoutDocument.ocrWarnings:[]).filter(note=>typeof note==='string'&&note.trim())))];}
// A note that blocks keep their machine OCR text (backend/pdf-block-ocr.js keptNote: "Trang N · đoạn k[, …]: … giữ chữ OCR
// máy …") no longer holds once Gemini read every block it names again; notes about blocks of other parts are kept.
const KEPT_NOTE=/^(Trang \d+ · đoạn \d+(?:, Trang \d+ · đoạn \d+)*): [^\n]*giữ chữ OCR máy/u;
function liveOcrNotes(notes){
 // The note names each block as its ID says (p<N>-b<k>: ocrBlockLabel).
 const named=new Map((pdfLayoutDocument?.pages||[]).flatMap(page=>page.blocks.map(b=>[/^p(\d+)-b(\d+)$/u.exec(b.id),b]).filter(([id])=>id).map(([id,b])=>[`Trang ${id[1]} · đoạn ${id[2]}`,b])));
 return notes.filter(note=>{const labels=KEPT_NOTE.exec(note)?.[1];return !labels||!labels.split(', ').every(label=>named.get(label)?.ocrCorrected===true&&!named.get(label).ocrKept);});
}
// The server names a doubt its mode reads again only once the block was read again; those its quota of a page (or a sheet
// too large for one call) left as they are would go unnamed, so they are named here.
function unreadDoubtNote(mode){
 const {reread}=modeProfile(mode),blocks=(pdfLayoutDocument?.pages||[]).filter(p=>p.ocr).flatMap(p=>p.blocks).filter(b=>rereads(reread?.doubt,b.ocrDoubt)&&!b.ocrKept&&!(b.ocrRereads>0));
 return blocks.length?`${blockNames(blocks)}: bản đọc của Gemini có chỗ đáng ngờ (công thức hoặc chữ có thể sai) và chưa được đọc lại; hãy đối chiếu với trang gốc.`:'';
}
// Notes about blocks that are being asked for again leave the warnings (and a whole-book run's notes); a new answer says
// what became of them. Only the notes on their translation: one on their OCR text still holds.
const TRANSLATION_NOTE=/^(?:giữ nguyên chữ gốc|vẫn là chữ gốc|bản dịch vẫn còn chữ Hán|còn chữ Hán chưa dịch|thiếu số hoặc dẫn chứng|bản dịch có thể thiếu dòng)/u;
function dropBlockNotes(blocks){
 const labels=blocks.map(b=>`${blockLabel(b)}: `),gone=line=>labels.some(label=>line.startsWith(label)&&TRANSLATION_NOTE.test(line.slice(label.length)));
 notes=notes.filter(line=>!gone(line));renderNotes();bookNotes=bookNotes.filter(line=>!gone(line));
}
// The server names a block by its ID ("Block p3-b7: …"); a note names it as the student finds it ("Trang 3 · đoạn 7: …").
const labelled=(blocks,line)=>String(line).replace(/^Block (p\d+-b\d+):?\s*/u,(whole,id)=>{const block=blocks.find(b=>b.id===id);return block?`${blockLabel(block)}: `:whole;});
// The same text twice (a running head or footer on every page, a repeated label), its whitespace aside: translated once in
// a session, it reads the same everywhere. A space beside a Chinese character or mark counts for nothing (OCR sets it or
// not from page to page); the lines stay. No lookbehind: Safari before 16.4 cannot parse one (old-browsers.test.mjs).
const sameText=text=>String(text??'').normalize('NFC').split('\n').map(line=>line.replace(/\s+/gu,' ').replace(/([\p{Script=Han}、-〿！-｠]) | (?=[\p{Script=Han}、-〿！-｠])/gu,(space,mark)=>mark||'').trim()).filter(Boolean).join('\n');
// OCR (when pending) and the blocks of the open layout session still without a translation; errors reach the caller.
// pageStop (whole-book runs): a stop waits until the page being translated is finished, so no page is left half
// translated. heartbeat (whole-book runs) follows every saved batch, keeping the job held through a long chunk.
// retryKept (range runs): blocks still in Chinese (a stand-in, or Chinese the checks do not allow) are asked for again.
// retryPass (whole-book runs): once every block has a translation, the stand-ins are asked for once more. onNotes: the
// stand-ins' and drafts' notes, also kept by a whole-book run past the chunk. done counts the blocks with a translation,
// wherever they are. Beyond the server's own retry a block gets one more try only where it needs one, in every Cách dịch:
// blocks MAX_CALLS left (not_reached) go again at once in a request of their own, in the groups the server left them in,
// at most twice; a block that failed a check with no translation to use goes once more on its own. A block of the same
// text as one translated in this session takes that translation (no call), and a scanned block with nothing readable
// (keepPixels) keeps its pixels (no call either). Returns what is left to the student (layoutReview) with the outcome.
async function translateLayoutSession(model,{pageStop=false,retryKept=false,retryPass=false,shouldStop=()=>stopRequested,heartbeat=async()=>{},onNotes=()=>{}}={}){
 if(translationState.pdfLayout.ocrPending||pdfOcrResumable()){if(!await correctPdfOcr(model,{shouldStop,heartbeat,onNotes}))return {complete:false,model,idle:false,ocrStopped:true,...emptyReview()};}
 // A save can land between the last OCR batch and the history update; untranslated parts follow the manifest.
 else if(!translationState.done)syncLayoutParts();
 const {blockBatches}=await boxLayout(),blocks=pdfLayoutDocument.pages.flatMap(p=>p.blocks),pageOf=new Map(pdfLayoutDocument.pages.flatMap(page=>page.blocks.map(b=>[b.id,page.number]))),indexOf=new Map(blocks.map((b,i)=>[b.id,i]));
 const text=b=>translationParts[indexOf.get(b.id)],put=(b,value)=>{translationParts[indexOf.get(b.id)]=value;},translated=()=>blocks.filter(b=>text(b)?.trim()).length;
 // drafted: the problems of the drafts the session holds (pdfLayout.review, kept with it: a reload or a later run still
 // names them); reached: how often a block came back not reached; owed: the group a block not reached was left in
 // (request:group); alone: blocks owed a try on their own; retried: blocks given their one more try (alone, or by
 // retryPass); refused: blocks of a request Gemini refused whole, which a last pass would only see refused again.
 const asked=new Set(),drafted=draftProblems(),reached=new Map(),owed=new Map(),alone=new Set(),retried=new Set(),refused=new Set();let pass=false,requests=0,halted=null,allowed=Object.values(usableGlossary());
 // A hand-translated block is never sent again, nor one that may be (legacy: a session saved before hand edits were
 // recorded); one the student emptied is translated as any other.
 const edited=handEdited(),legacy=legacyBlocks();for(const id of [...edited,...legacy])if(!translationParts[indexOf.get(id)]?.trim()){edited.delete(id);legacy.delete(id);}Object.assign(translationState.pdfLayout,{edited:[...edited],legacy:[...legacy]});
 const kept=b=>edited.has(b.id)||legacy.has(b.id),keepReview=()=>{translationState.pdfLayout.review=Object.fromEntries([...drafted].filter(([id])=>text(blocks[indexOf.get(id)])?.trim()));};
 const pending=()=>blocks.filter(b=>{const value=text(b);return !asked.has(b.id)&&(!value?.trim()||retryKept&&!kept(b)&&stillChinese(b,value,allowed))||pass&&!retried.has(b.id)&&!refused.has(b.id)&&!kept(b)&&standIn(b,value);});
 // A translation made for a text serves every block of that text still waiting (its own drafts and stand-ins never do).
 const reuse=()=>{
  const made=new Map();for(const b of blocks){const value=text(b),key=sameText(b.source);if(value?.trim()&&!made.has(key)&&!drafted.has(b.id)&&!b.keepPixels&&!stillChinese(b,value,allowed))made.set(key,value);}
  let filled=0;for(const b of pending()){const value=made.get(sameText(b.source));if(value){put(b,value);asked.add(b.id);if(pass)retried.add(b.id);filled++;}}
  return filled;
 };
 const waiting=pending(),idle=!waiting.length,notes=[];
 if(retryKept)dropBlockNotes(waiting.filter(b=>text(b)?.trim()));
 for(const b of waiting)if(b.keepPixels&&!text(b)?.trim()){put(b,b.source);notes.push(`${blockLabel(b)}: ${OCR_UNREAD_NOTE}`);}
 // A block still in Chinese that took the translation of its text makes an exported PDF out of date, as below.
 const filled=reuse()+notes.length,stale=filled>0&&Boolean(pdfExportUrl);if(stale){pdfExportUrl='';translationState.pdfLayout.exported=false;await dualViewer.invalidatePdf();}
 translationState.done=translated();keepReview();await saveBeforeSpending();if(stale)partHasPdf(activeHistoryId,false);
 if(filled){syncPdfText();await dualViewer.update(pdfTranslations());}
 if(notes.length){addNotes(notes);onNotes(notes);}
 let next=pending();const first=next.length?indexOf.get(next[0].id):-1;
 // The page a stop lets finish: that of the block translated just before this call began, then of the last one sent.
 let page=first>0&&translationParts[first-1]?.trim()?pageOf.get(blocks[first-1].id):0;
 for(;;next=pending()){
  if(!next.length){
   if(!retryPass||pass||shouldStop())break;
   pass=true;next=pending();if(!next.length)break;dropBlockNotes(next);
  }
  // One request per text: the others of the same text wait for its answer. A block owed a try on its own goes alone, blocks
  // not reached go before the others and never with them (a refused block still among them would cost the others their
  // calls); as many blocks per call as the session's Cách dịch sends (its layoutBatch), the most the server takes for it.
  // A range run sends the blocks never translated before those it asks for again, so a part Gemini refused once never
  // keeps the rest from being translated.
  const keys=new Set(),unique=next.filter(b=>{const key=sameText(b.source);if(keys.has(key))return false;keys.add(key);return true;}),single=unique.find(b=>alone.has(b.id)),due=unique.filter(b=>owed.has(b.id)),fresh=unique.filter(b=>!text(b)?.trim());
  let [batch]=single?[[single]]:blockBatches(due.length?due:retryKept&&fresh.length?fresh:unique,modeProfile(translationState.mode).layoutBatch);
  if(shouldStop()){if(!pageStop||!page||pageOf.get(batch[0].id)!==page)break;batch=batch.filter(b=>pageOf.get(b.id)===page);}
  // The try on its own and a whole-book run's last pass are a block's one more try: the server asks them once (again).
  const once=Boolean(single)||pass;for(const b of batch)if(once){alone.delete(b.id);retried.add(b.id);}
  const groups=[...new Set(batch.map(b=>owed.get(b.id)).filter(Boolean))].map(group=>batch.filter(b=>owed.get(b.id)===group).map(b=>b.id));requests++;
  // The count of blocks translated so far ("9/23 đoạn"); blocks asked for again after a refusal are counted, and named
  // in Cần xem lại.
  const again=batch.every(b=>stillChinese(b,text(b),allowed));
  status(again?`Đang dịch lại ${batch.length} đoạn còn chữ gốc…`:bookRun?`Đang dịch ${chunkPages()} · ${translated()}/${blocks.length} đoạn…`:`Đang dịch… ${translated()}/${blocks.length} đoạn`);
  const result=await api('translate-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model,blocks:batch.map(({id,source})=>({id,source})),domain:translationState.domain,mode:translationState.mode,context:translationState.context,glossary:usableGlossary(),partial:true,...(groups.length>1?{groups}:{}),...(once?{again:true}:{})})});
  // Counted before anything else: tokens are spent even on the blocks Gemini would not translate.
  addUsage(result.usage);
  if(result.model){model=result.model;$('#gemini-model-status').textContent=`Đã dùng ${result.model}.`;if([...$('#gemini-model').options].some(o=>o.value===result.model))$('#gemini-model').value=result.model;}
  const before=translationParts.slice(),failures=Array.isArray(result.failedBlocks)?result.failedBlocks:[];let answered=false;
  for(const entry of Array.isArray(result.blocks)?result.blocks:[]){const index=indexOf.get(entry?.id);if(index!==undefined&&typeof entry.translation==='string'&&entry.translation.trim()){translationParts[index]=entry.translation;drafted.delete(entry.id);answered=true;}}
  // A request that made headway (a block translated, or answered with a draft or a check of its own) sends the blocks it
  // did not reach again; one Gemini refused whole is not sent again and again: its blocks keep their Chinese with its reason.
  const progress=answered||failures.some(f=>f?.code==='block_check');
  const whole=!progress&&batch.length>1&&failures.length>0&&failures.every(f=>f?.code==='not_reached'||CONTENT_FAILURES.has(f?.code));
  // outcome: what became of a block this request did not translate, as its note says it; resend: blocks asked for again.
  const outcome=new Map(),resend=new Set();let stop=null;
  for(const failure of failures){
   const index=indexOf.get(failure?.id);if(index===undefined)continue;
   const block=blocks[index];
   // Never refused itself: asked for again in the next request, at most twice (a stand-in asked once more keeps itself).
   if(failure.code==='not_reached'){const count=(reached.get(block.id)||0)+1;reached.set(block.id,count);if(count<=2&&!pass&&progress){resend.add(block.id);owed.set(block.id,`${requests}:${Number.isInteger(failure.group)?failure.group:0}`);continue;}}
   else if(!CONTENT_FAILURES.has(failure.code)){stop??=failure;continue;}
   if(whole)refused.add(block.id);
   const why=whole&&failure.code==='not_reached'?'Gemini từ chối dịch cả lượt gồm đoạn này.':String(failure.message||'Gemini không trả bản dịch cho đoạn này.').trim().replace(/^Block p\d+-b\d+:?\s*/u,'');
   if(failure.code==='block_check'&&typeof failure.draft==='string'&&failure.draft.trim()){put(block,failure.draft);drafted.set(block.id,Array.isArray(failure.problems)&&failure.problems.length?failure.problems:['numbers']);outcome.set(block.id,`${why} Đã dùng bản nháp của Gemini.`);}
   // Nothing to use (a formula token lost twice, the block left out twice): once more on its own.
   else if(failure.code==='block_check'&&!retried.has(block.id)){alone.add(block.id);resend.add(block.id);}
   else{put(block,block.source);drafted.delete(block.id);outcome.set(block.id,`giữ nguyên chữ gốc. ${why.charAt(0).toUpperCase()+why.slice(1)}`);}
  }
  for(const b of batch)if(!resend.has(b.id)){asked.add(b.id);owed.delete(b.id);}page=pageOf.get(batch.at(-1).id);
  // The blocks of the same text that waited take what their text got: the translation, or the same draft or stand-in.
  const sent=new Map(batch.filter(b=>!resend.has(b.id)).map(b=>[sameText(b.source),b]));
  for(const b of next){
   const lead=sent.get(sameText(b.source));if(!lead||lead===b||!text(lead)?.trim())continue;
   put(b,standIn(lead,text(lead))?b.source:text(lead));asked.add(b.id);if(pass)retried.add(b.id);
   if(drafted.has(lead.id))drafted.set(b.id,drafted.get(lead.id));else drafted.delete(b.id);if(outcome.has(lead.id))outcome.set(b.id,outcome.get(lead.id));
  }
  reuse();translationState.done=translated();
  const notes=blocks.filter(b=>outcome.has(b.id)).map(b=>`${blockLabel(b)}: ${outcome.get(b.id)}`);
  // A block translated again (one left in Chinese before) makes an exported PDF out of date: it is exported anew. The
  // save below turns the part's chapter back into text (backend/study-history.js), as Sách của tôi then says. An answer
  // that changes no block (the same draft again) keeps the PDF.
  const dropped=Boolean(pdfExportUrl)&&translationParts.some((value,i)=>value!==before[i]);if(dropped){pdfExportUrl='';translationState.pdfLayout.exported=false;await dualViewer.invalidatePdf();}
  if(result.warnings?.length)addNotes(result.warnings.map(line=>labelled(blocks,line)));
  if(notes.length){addNotes(notes);onNotes(notes);}
  translationState.context=result.context||translationState.context;translationState.glossary={...translationState.glossary,...result.glossary,...translationState.fixedGlossary,...translationState.manualGlossary};allowed=Object.values(usableGlossary());keepReview();syncPdfText();await dualViewer.update(pdfTranslations());await saveBeforeSpending();if(dropped)partHasPdf(activeHistoryId,false);
  // What passed is saved first; then a quota or an overloaded Gemini stops the run as that error would have.
  if(stop)throw stopError(stop);
  const missing=batch.find(block=>!resend.has(block.id)&&!text(block)?.trim());if(missing)throw new Error(`Gemini trả thiếu bản dịch của đoạn ${missing.id}.`);
  await heartbeat();
  // A range run stops at a request Gemini refused whole: the next one would most likely cost as much for nothing.
  if(whole&&retryKept&&pending().length){halted=batch.filter(b=>refused.has(b.id));break;}
 }
 return {complete:translated()===blocks.length,model,idle,halted,...layoutReview(blocks,drafted,allowed)};
}
// show:false (whole-book runs) skips loading every exported chunk into the viewer. The PDF is exported (and kept in
// Thư viện riêng) before a browser inside another app is offered Chrome or Safari for the download.
async function exportLayoutPdf(download=true,{show=true}={}){
 if(!translationState?.pdfLayout||!activeHistoryId)throw new Error('Hãy dịch và lưu đủ các đoạn trước khi xuất PDF.');
 if(!pdfExportUrl){
  if(!bookRun)status('Đang xuất PDF tiếng Việt…');let result;const exported=activeHistoryId;
  try{result=await pdfService(()=>api('pdf-layout/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:translationState.pdfLayout.assetId,historyId:activeHistoryId})}),'render');}
  catch(error){
   // A refusal (not a wait, a stop or an expired session) is kept for this part: opened again here, it marks the blocks.
   if(error?.code!=='stopped'&&!signedOut(error)&&!transient(error)){const blocks=overflowBlocks(error).map(b=>b.id);exportProblems.set(exported,{blocks,message:blocks.length?'':String(error?.message||'')});}
   if(show&&error?.data?.code==='pdf_overflow'){await showOverflow(error).catch(()=>{});const count=overflowBlocks(error).length;if(count)error.message=`${count} đoạn dài hơn khung chữ. Viết ngắn lại rồi bấm Xuất PDF tiếng Việt.`;}throw error;
  }
  pdfExportUrl=result.url;translationState.pdfLayout.exported=true;translationState.pdfLayout.renderVersion=result.renderVersion||2;exportProblems.delete(exported);overflowIds=[];renderNotes();
  // The part's chapter is a PDF now: Sách của tôi and the history stop saying it lacks one.
  partHasPdf(exported,true);
  if(show)await dualViewer.setExportedPdf(result.url);
 }
 if(!bookRun){const count=reviewCount(layoutReview(pdfLayoutDocument.pages.flatMap(p=>p.blocks)));status(`Xong · PDF đã lưu vào Thư viện riêng${count?` · ${count} đoạn cần xem lại`:''}.`);}
 if(download){const url=pdfExportUrl,filename=downloadFilename('pdf');await offerDownload(async()=>{const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('Không tải được PDF.');saveFile(await response.blob(),filename);});}
}
// An export refused because translations are longer than their boxes even at the smallest size (422 pdf_overflow, with
// the blocks; the service's message names each "Trang N · đoạn k", as the viewer's notice below it does, and "Đoạn k"
// only as the editor's option to pick): the viewer outlines every one of them and opens the editor on the first, on its
// page, so the student shortens it, saves it and exports again.
async function showOverflow(error){
 const ids=overflowBlocks(error).map(b=>b.id);overflowIds=ids;renderNotes();
 if(ids.length)await (await loadViewer()).flagBlocks(ids);
}
// A finished part opened without its Vietnamese PDF (its export was refused, or never ran) says so and, as a refused
// export does, opens the editor on each block longer than its box: the blocks the service named in this tab, otherwise
// those the preview finds measuring every page as the exporter does (no PDF service, no token).
async function showMissingPdf(id,version){
 const known=exportProblems.get(id),viewer=await loadViewer();let ids=known?.blocks||[];
 if(!known){status('Đang tìm đoạn dài hơn khung chữ…');ids=await viewer.overflowBlocks().catch(()=>[]);if(version!==selectionVersion)return;}
 const blocks=pdfLayoutDocument.pages.flatMap(page=>page.blocks).filter(b=>ids.includes(b.id));
 if(blocks.length){overflowIds=blocks.map(b=>b.id);renderNotes();await viewer.flagBlocks(overflowIds);status(`${blocks.length} đoạn dài hơn khung chữ. Viết ngắn lại rồi bấm Xuất PDF tiếng Việt.`);return;}
 status(known?.message?`Chưa có PDF tiếng Việt: ${known.message} Bấm Xuất PDF tiếng Việt để thử lại.`:'Chưa có PDF tiếng Việt. Bấm Xuất PDF tiếng Việt (không tốn token).');
}
// The same refusal in a whole-book run, which goes on with the next chunk: a short note naming the blocks to shorten
// ("Trang 5 · đoạn 2"), at most five of them, kept with the book's other notes.
function overflowNote(range,error){
 const found=overflowBlocks(error);
 return `${range}: chưa xuất được PDF vì ${blockNames(found)||'một số đoạn'} dài hơn khung chữ. Mở phần này trong Lịch sử dịch, viết ngắn lại rồi bấm Xuất PDF tiếng Việt.`;
}
// The blocks of the open session a 422 pdf_overflow names, each once.
function overflowBlocks(error){
 const byId=new Map(pdfLayoutDocument?.pages.flatMap(page=>page.blocks.map(b=>[b.id,b]))||[]);
 return [...new Set((Array.isArray(error?.data?.blocks)?error.data.blocks:[]).map(entry=>byId.get(entry?.id)).filter(Boolean))];
}

// The terms in the field apply from the next part on; a term the student removed there leaves the session's terms too.
function syncManualGlossary(manual=parseStudyGlossary($('#glossary').value)){
 for(const term of Object.keys(translationState.manualGlossary||{}))if(!Object.hasOwn(manual,term))delete translationState.glossary[term];
 translationState.manualGlossary=manual;Object.assign(translationState.glossary,manual);
}
// A new subject or way of translating, chosen on an opened session, applies to the parts not translated yet. Nothing is
// saved or sent until Bắt đầu dịch, and the parts already translated stay as they are.
function settingChanged(field){
 if(!translationState)return;translationState[field]=$(`#${field}`).value;
 const total=translationState.parts?.length||0,done=translationState.done||0,unit=translationState.pdfLayout?'đoạn':'phần',label=field==='mode'?'Cách dịch':'Lĩnh vực';
 if(done&&done<total)status(`${label} mới áp dụng cho các ${unit} chưa dịch; ${done} ${unit} đã dịch được giữ nguyên, không dịch lại.`);
 else if(done&&done===total)status(`Bản dịch này đã hoàn tất nên được giữ nguyên. ${label} mới áp dụng cho tài liệu bạn dịch tiếp theo.`);
}
async function translate(){
 const source=$('#source').value.trim();
 if(!source)throw new Error('Hãy dán hoặc trích xuất nguyên tác trước.');
 if(source.length>2_000_000)throw new Error('Tối đa 2 triệu ký tự cho một phiên học tập.');
 // The same source continues its session, whatever Cách dịch or Lĩnh vực say now: they apply to the parts left, and the
 // parts already translated (and paid for) are neither sent again nor overwritten in the account.
 const mode=$('#mode').value,domain=$('#domain').value,continuing=Boolean(translationState)&&!translationState.pdfLayout&&translationState.source===source;
 const plan=continuing?translationState.plan:createTranslationPlan(source,preparedPages),parts=continuing?translationState.parts:plan.map(part=>part.text),manualGlossary=parseStudyGlossary($('#glossary').value);
 if(!continuing){
  // Another source on a session with translated parts (another range of a PDF read in the browser) is a new session: the
  // saved one keeps its parts instead of being saved over.
  if(translationState?.done&&activeHistoryId)resetHistoryIdentity();
  translationState={source,domain,mode,parts,plan,done:0,context:'',glossary:{...manualGlossary},manualGlossary,previousSource:'',previousTranslation:''};
  translationParts=[];renderPartStream(plan);$('#translation').value='';setNotes(ocrWarnings);
  if(domain==='math'&&[...preparedPages.values()].some(entry=>['paddle','tesseract','gemini'].includes(entry.engine)))addNotes('Công thức đọc từ ảnh có thể sai; hãy đối chiếu với trang gốc.');
 }else{
  Object.assign(translationState,{mode,domain});syncManualGlossary(manualGlossary);
  if(!$('#translation-parts').children.length){renderPartStream(plan);translationParts.forEach((text,index)=>{if(text)updatePart(index,text,index<translationState.done?'done':'queued');});}
 }
 if(translationState.done===parts.length){
  // A finished translation whose last save failed: Bắt đầu dịch saves it again (setUnsaved says so), without Gemini.
  if(unsaved){busy(true);try{status('Đang lưu bản dịch vào tài khoản…');const saved=await saveHistory();if(saved)status(saved.libraryStoryId&&saved.status==='complete'?'Đã lưu bản dịch vào Thư viện riêng.':'Đã lưu bản dịch vào tài khoản.');else status(saveRefusal(saveError)?`Vẫn chưa lưu được: ${saveRefusal(saveError)}`:`Vẫn chưa lưu được. Đừng đóng tab; kiểm tra mạng rồi bấm ${runLabel()}.`,'error');}finally{busy(false);}return;}
  status('Tài liệu này đã dịch xong trong phiên. Không gọi Gemini lại.');return;
 }
 key();busy(true);stopRequested=false;let activeIndex=-1,lastSaved=null;
 try{
  lastSaved=await saveBeforeSpending();
  for(let index=translationState.done;index<parts.length;index++){
   if(stopRequested)break;activeIndex=index;const part=parts[index];updatePart(index,undefined,'working');status(`Đang dịch… ${index}/${parts.length} phần`);
   const result=await api('translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key(),model:$('#gemini-model').value,source:part,mode,domain,context:translationState.context,glossary:translationState.glossary,previousSource:translationState.previousSource,previousTranslation:translationState.previousTranslation})});
   translationParts[index]=result.translation;updatePart(index,result.translation,'done');$('#translation').value=translationParts.join('\n\n');$('#download').disabled=false;renderPageImages();
   translationState.context=result.context||translationState.context;translationState.glossary={...(result.glossary||translationState.glossary),...translationState.manualGlossary};translationState.previousSource=part.slice(-350);translationState.previousTranslation=result.translation.slice(-500);translationState.done=index+1;addUsage(result.usage);
   // What the server's checks still found (backend/ai.js textProblems, "Đoạn k: …") is named by the part's page when it
   // has one ("Trang N · đoạn k"), as kept-layout notes are; a pasted text has parts only.
   // They are kept with the session (notes), so the session opened again still names them.
   if(result.warnings?.length){const pages=translationState.plan?.[index]?.pages,where=pages?.length===1?`Trang ${pages[0]}`:`Phần ${index+1}`,lines=result.warnings.map(line=>/^Đoạn \d+:/u.test(line)?line.replace(/^Đoạn (\d+):/u,`${where} · đoạn $1:`):`${where}: ${line}`);addNotes(lines,index);translationState.notes=[...(translationState.notes||[]),...lines].slice(-200);}
   activeIndex=-1;lastSaved=await saveBeforeSpending(index===parts.length-1)||lastSaved;
  }
  const review=new Set(notePart.values()).size;
  status(stopRequested?`Đã dừng sau ${translationState.done}/${parts.length} phần; tiến độ đã lưu.`:`Xong · ${parts.length} phần${lastSaved?.libraryStoryId&&lastSaved.status==='complete'?' · đã lưu vào Thư viện riêng':''}${review?` · ${review} phần cần xem lại`:''}.`);
 }catch(error){if(activeIndex>=0)updatePart(activeIndex,undefined,'failed');rejectKey(error);fail(error,{run:true});}finally{busy(false);stopRequested=false;}
}

// ---- "Dịch cả quyển" ----
const bookAvailable=()=>Boolean(layoutConfig.configured&&$('#pdf-layout-enabled').checked&&(/\.pdf$/iu.test(selectedFile?.name||'')||bookJob&&!selectedFile));
// Over 25 MB only this mode takes a PDF: chunks are cut on the device before anything is extracted. A run continued from
// the history has no picked file at all and reads the original kept in the account.
const bookForced=()=>Boolean(selectedFile?selectedFile.size>OTHER_MAX_BYTES:bookJob);
const megabytes=bytes=>bytes<1048576?`${Math.max(1,Math.round(bytes/1024))} KB`:`${new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1}).format(bytes/1048576)} MB`;
function bookFileStatus(){if(selectedFile&&selectedTotalPages)setFileStatus(`${selectedTotalPages} trang · ${megabytes(selectedFile.size)}`);}
// quiet: a countdown's later seconds are shown, not read aloud each second by a screen reader.
function bookStatus(text,{quiet=false}={}){bookStatusText=text;const line=$('#whole-book-status');if(!line)return;line.setAttribute('aria-live',quiet?'off':'polite');line.textContent=text;}
function renderBookMode(){
 const field=$('#book-mode');if(!field)return;field.hidden=!bookAvailable();
 const range=field.querySelector('input[value="range"]'),whole=field.querySelector('input[value="book"]');
 range.disabled=running||bookForced();whole.disabled=running;(bookMode?whole:range).checked=true;
 $('#book-mode-note').textContent=selectedFile&&bookForced()?'Tệp trên 25 MB chỉ dịch được cả quyển.':'';
}
function setBookMode(on){
 bookMode=Boolean(on);$('#whole-book').hidden=!bookMode;$('#range-fields').hidden=bookMode;$('#book-target-group').hidden=bookMode||!studyBooks.length;
 $('#stop').textContent=bookMode?'Dừng sau trang này':'Dừng sau lượt này';
 if(bookMode)startBookSurvey();renderBookMode();updateTitleControls();renderCover();updateRunBar();
}
function unbindBook(){
 const bound=Boolean(bookJob),pages=$('#book-pages');bookJob=null;bookSource=null;bookSurvey=null;bookChunkId='';bookContext='';bookHashTask=null;bookPagesEdited=false;bookBusy=false;bookStatus('');pages.value='';pages.setCustomValidity('');pages.removeAttribute('aria-invalid');
 if(bound)$('#content-title-hint').textContent='';
 if(bookMode)setBookMode(false);else{renderBookMode();updateTitleControls();}
}
function bindBookJob(job){
 bookJob=job;const title=$('#content-title');title.value=job.title||'';title.setCustomValidity('');title.removeAttribute('aria-invalid');
 // The page field shows the pages this job translates (empty for a whole book); only the student's own edit changes them.
 const pages=$('#book-pages');pages.value=wholeBook.chosenPagesText(job.pageStates);pages.setCustomValidity('');pages.removeAttribute('aria-invalid');bookPagesEdited=false;bookBusy=false;
 // The book keeps its name; Đổi tên sách… (updateTitleControls) renames it once it exists.
 $('#content-title-hint').textContent='';
 for(const [select,value] of [[$('#domain'),job.domain],[$('#mode'),job.mode]])if([...select.options].some(option=>option.value===value))select.value=value;
 if(isMode(job.mode))modeTouched=true;renderModeHint();
 const count=wholeBook.countStates(job.pageStates);
 bookStatus(count.pending||count.failed?'Trang đã dịch không tốn token lại.':`Quyển này đã dịch xong.${missingPdfNote(job)?` ${missingPdfNote(job)}`:''}`);
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
// The run button of a book: Dịch cả quyển, then Dịch tiếp; Đã dịch xong hides it (runState).
function bookButtonLabel(states){
 if(!bookJob)return 'Dịch cả quyển';if(bookBusy&&!running)return 'Chờ rồi dịch tiếp';const count=wholeBook.countStates(states);
 if(count.pending)return count.done||bookJob.status!=='ready'?'Dịch tiếp':'Dịch cả quyển';
 return count.failed?'Thử lại các trang lỗi':'Đã dịch xong';
}
function renderBookPanel(){
 if(!bookMode)return;
 const states=bookStates(),total=bookJob?.totalPages||selectedTotalPages;updateRunBar();
 // One line only: a run continued without the picked file says where its original comes from.
 $('#whole-book-summary').textContent=!total?'Đang đọc số trang…':bookJob&&!selectedFile?'Bản gốc lấy từ tài khoản':'';
 $('#whole-book-count').textContent=states?wholeBook.progressText(states):'';$('#whole-book-note').textContent=states?wholeBook.progressNote(states):'';
 // The book's own count, once it has used any (never a zero count).
 const used=(Number(bookJob?.usage?.total)||0)+(bookRun?.usage.total||0);$('#whole-book-tokens').textContent=bookJob&&used?`Quyển này đã dùng ${wholeBook.formatTokens(used)} token Gemini`:'';
 // Pages of a part without its Vietnamese PDF are drawn apart from the translated ones; the legend names only the states
 // the grid shows.
 const noPdf=bookJob&&!running?missingPdfPages(bookJob):new Set();
 wholeBook.renderPageGrid($('#page-grid'),states,bookWorking,noPdf);renderBookEstimate(states);
 const shown=new Set([...$('#page-grid').children].map(cell=>cell.dataset.state));for(const item of document.querySelectorAll('.page-legend li'))item.hidden=!shown.has(item.dataset.state);
 // The book in Thư viện riêng: a quiet link while pages are left, the view's one primary once nothing is (the run button
 // and the export group then step aside).
 const read=$('#book-read');read.hidden=!bookJob?.storyId;read.className=bookJob?.storyId&&!running&&bookButtonLabel(states)==='Đã dịch xong'?'button primary':'quiet';if(bookJob?.storyId)read.href=`/?read=${encodeURIComponent(bookJob.storyId)}`;
 $('#whole-book-status').textContent=bookStatusText;
}
// One line in view: about how many tokens are left in the Cách dịch chosen (the book's own average once pages are done);
// how it is counted, page kind by page kind, is behind "Cách tính".
function renderBookEstimate(states){
 // Nothing left to translate, nothing to estimate: exporting again or downloading the book costs no token.
 const root=$('#whole-book-estimate'),open=Boolean(root.querySelector('details')?.open);root.replaceChildren();root.hidden=!wholeBook.countStates(states).pending;if(root.hidden)return;
 // The pages' measured costs are Tiết kiệm's; the Cách dịch the run will use scales them (whole-book.js pageTokens).
 const mode=$('#mode').value,name=modeName(mode),f=wholeBook.formatTokens,{text:[textLow,textHigh],scan:[scanLow,scanHigh]}=wholeBook.pageTokens(mode),list=document.createElement('ul');
 const line=(text,tag='li',className='')=>{const item=document.createElement(tag);item.textContent=text;if(className)item.className=className;return item;};
 const projection=bookJob?wholeBook.usageProjection({...bookJob,pageStates:states}):null,estimate=bookSurvey?.kinds.length||!bookJob?wholeBook.estimateTokens(states,bookSurvey?.kinds||[],mode):null;
 const total=estimate?.high?`khoảng ${wholeBook.formatTokenRange(estimate.low,estimate.high)} token`:'';
 root.append(line(projection?.pending?`Còn khoảng ${f(projection.remaining)} token cho ${projection.pending} trang (theo mức quyển này đã dùng)`:total?`Ước tính còn ${total} (${name})`:`Ước tính mỗi trang khoảng ${f(textLow)}–${f(scanHigh)} token (${name})`,'p','estimate-total'));
 // A cover whose text is translated costs what its page does; only one kept as printed is free.
 const free=`${states.includes('c')?'Bìa giữ nguyên, trang':'Trang'} trống và trang bỏ qua: 0 token`;
 if(estimate){
  if(estimate.text)list.append(line(`${estimate.text} trang có lớp chữ × ${f(textLow)}–${f(textHigh)} token`));
  if(estimate.scan)list.append(line(`${estimate.scan} trang scan (Gemini đọc ảnh) × ${f(scanLow)}–${f(scanHigh)} token`));
  if(estimate.unknown)list.append(line(`${estimate.unknown} trang ${bookSurvey&&!bookSurvey.done&&!bookSurvey.failed?'đang khảo sát':'chưa rõ loại'} × ${f(textLow)}–${f(scanHigh)} token`));
 }else list.append(line(`Trang có lớp chữ: khoảng ${f(textLow)}–${f(textHigh)} token`),line(`Trang scan (Gemini đọc ảnh): khoảng ${f(scanLow)}–${f(scanHigh)} token`));
 list.append(line(free));
 const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');details.className='more';details.open=open;summary.textContent='Cách tính';body.className='more-body';body.append(list);
 // The book's own average took the line in view: the estimate by page kind stays here.
 if(projection?.pending&&total)body.append(line(`Theo loại trang: ${total} (${name}).`,'p'));
 if(bookSurvey&&!bookSurvey.done&&!bookSurvey.failed)body.append(line(`Đang đọc lớp chữ của tệp: ${bookSurvey.kinds.length}/${bookSurvey.total||'?'} trang…`,'p'));
 body.append(line('Chỉ là ước tính: số token thật tùy lượng chữ, công thức và phiên bản Gemini; trang trống chỉ biết sau khi tách trang.','p'));
 details.append(summary,body);root.append(details);
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
 const version=++selectionVersion;refusedPick=null;busy(true);
 try{
  const same=Boolean(selectedFile)&&await bookHash()===job.sourceSha256;if(version!==selectionVersion)return;
  if(!same){
   unbindBook();await dualViewer.clear();selectedFile=null;selectedHash=Promise.resolve('');resetCover();autoRange='';pdfAnalysis=null;preparedPages=new Map();preparedRangeKey=null;clearPageImages();ocrWarnings=[];translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';clearPartStream();
   $('#source').readOnly=false;$('#source').value='';$('#translation').value='';setNotes([]);overflowIds=[];lastPickPdf=false;$('#download').disabled=true;$('#download-pdf').disabled=true;$('#source-file').value='';$('#pdf-range-options').hidden=true;$('#page-range').value='';$('#library-match').hidden=true;updateCount();
   setFileStatus(job.filename||'PDF gốc');
  }
  resetHistoryIdentity();selectedSha256=job.sourceSha256;selectedTotalPages=job.totalPages;bookTarget={id:job.storyId||'',replaceChapterId:''};bindBookJob(job);
  $('.workspace').scrollIntoView({behavior:scrollBehavior(),block:'start'});
 }finally{busy(false);}
 if(version!==selectionVersion)return;
 if(sessionKey||$('#api-key').value.trim())await run();else{$('#api-key').focus();status(`Dán khóa Gemini rồi bấm ${runLabel()}.`);}
}
// The original as pdf-lib reads it: the picked file, or the copy kept in the account when a run continues after a reload.
async function prepareBookSource(){
 const wanted=bookJob?.sourceSha256||'';if(bookSource&&(!wanted||bookSource.sha256===wanted))return bookSource;
 const {PDFDocument}=await wholeBook.loadPdfLib();let bytes,file=selectedFile,sha256='';
 if(file){
  status('Đang đọc tệp PDF trên thiết bị…');bytes=new Uint8Array(await file.arrayBuffer());sha256=await selectedHash||await wholeBook.digestHex(bytes);bookHashTask=Promise.resolve(sha256);
  if(wanted&&sha256!==wanted)throw new Error('Tệp đang chọn không phải bản gốc của quyển đang dịch dở. Hãy chọn đúng tệp, hoặc bấm Tiếp tục ở quyển đó trong Lịch sử dịch.');
 }else{
  if(!wanted)throw new Error('Hãy chọn PDF gốc.');
  status('Đang lấy bản gốc từ tài khoản…');bytes=await wholeBook.downloadSource(wanted,{onProgress:share=>status(`Đang lấy bản gốc từ tài khoản… ${Math.round(share*100)}%`,'',{quiet:true})});
  sha256=wanted;file=new File([bytes],bookJob.filename||'nguyen-tac.pdf',{type:'application/pdf'});
 }
 status('Đang mở PDF để chia lượt dịch…');const doc=await wholeBook.openSourcePdf(PDFDocument,bytes),totalPages=doc.getPageCount();
 if(bookJob&&totalPages!==bookJob.totalPages)throw new Error(`Bản gốc có ${totalPages} trang, khác ${bookJob.totalPages} trang của lượt dịch này.`);
 selectedSha256=sha256;
 return bookSource={sha256,file,filename:file.name,totalPages,cut:pages=>wholeBook.cutChunk(PDFDocument,doc,pages)};
}
// The original goes to the account once (HEAD first): every chunk is cut from it, here or on another device.
async function uploadOriginal(source){
 const url=`/api/my/study/sources/${source.sha256}`,head=await fetch(url,{method:'HEAD',credentials:'same-origin'}).catch(()=>null);
 if(head?.status===401)throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.');if(head?.ok)return;
 const label='Đang tải bản gốc lên tài khoản (một lần cho cả quyển)…';status(label);
 await wholeBook.uploadSource(url,source.file,{pages:source.totalPages,filename:source.filename,onProgress:share=>status(`${label} ${Math.round(share*100)}%`,'',{quiet:true})});
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
// The cover page a job's book remembers for the job's file (its text translated, so no 'c' page says it); 0: none.
function rememberedCover(job){const stored=studyBooks.find(book=>book.id===job?.storyId)?.cover;return stored?.page&&stored.sha256===job.sourceSha256?stored.page:0;}
// A run continued without the picked file still gives a new book its cover image, drawn from the stored original: the
// page kept as printed, or the one its book remembers.
async function ensureBookCover(source){
 const page=bookJob.pageStates.indexOf('c')+1||rememberedCover(bookJob);if(selectedFile||!page||cover.page===page&&cover.jpeg||studyBooks.find(book=>book.id===bookJob.storyId)?.cover?.image)return;
 const jpeg=await coverTools.pageJpeg(source.file,page).catch(()=>null);Object.assign(cover,{page,source:'detected',replace:false,synced:'',note:''});setCoverImage(jpeg);
}
// A chunk session saved earlier (in another tab, before a reload) becomes the open session again, as the history opens it.
// What is left of it is read and translated in mode, the run's Cách dịch, whichever it began in (its own when none is
// given), as a Cách dịch chosen on an open session applies to the parts not translated yet (settingChanged).
async function resumeChunkSession(id,mode){
 const item=await api(`history/${encodeURIComponent(id)}`),state=item.state||{};if(!state.pdfLayout)throw Object.assign(new Error('Phần này không có bố cục PDF.'),{status:409});
 const document=await api(`pdf-layout/assets/${state.pdfLayout.assetId}/manifest`);
 await dualViewer.clear();pdfLayoutDocument=document;pdfExportUrl='';pdfLayoutRange='';clearPageImages();
 activeHistoryId=item.id;activeHistoryMeta={title:item.title,filename:item.filename};bookChunkId=item.id;bookTarget={id:item.library_story_id||bookJob?.storyId||'',replaceChapterId:''};
 const parts=Array.isArray(state.parts)?state.parts:[];translationParts=Array.isArray(state.translationParts)?state.translationParts.slice(0,parts.length):[];while(translationParts.length<parts.length)translationParts.push('');activeHistoryRevision=revisionOf(item);
 const fixedGlossary={...(bookJob?.glossary||{})};translationState={source:state.source||'',domain:item.domain||'general',mode:isMode(mode)?mode:storedMode(item),parts,plan:parts.map(text=>({text,pages:[],blockIds:{}})),done:translationParts.filter(text=>text?.trim()).length,context:state.context||'',glossary:{...(state.glossary||{}),...fixedGlossary,...(state.manualGlossary||{})},manualGlossary:state.manualGlossary||{},fixedGlossary,previousSource:'',previousTranslation:'',pdfLayout:state.pdfLayout};showMode(translationState.mode);
 // OCR that never finished goes on from the manifest, which keeps every batch already read and paid for.
 if(!translationState.done&&document.pages.some(page=>page.ocr&&page.blocks.some(b=>!ocrHandled(b))))translationState.pdfLayout.ocrPending=true;
 if(state.pdfLayout.exported&&state.pdfLayout.renderVersion>=3)pdfExportUrl=`/api/my/study/pdf-layout/assets/${state.pdfLayout.assetId}/translated`;
 clearPartStream();syncPdfText();await dualViewer.setDocument(pdfLayoutDocument,pdfTranslations());
}
// One chunk, done exactly as a range picked by hand; createBookRun (whole-book.js) drives these steps and the job.
const transient=error=>error?.status===0||error?.status===429||error?.status>=500;
const bookSteps={
 // mode: the run's Cách dịch, which what is left of the chunk is read and translated in.
 async open(job,chunk,{mode}={}){
  // The chunk this tab stopped in goes on where it was; one saved elsewhere is opened again (its tokens are spent).
  if(bookChunkId&&bookChunkId===activeHistoryId&&translationState?.pdfLayout&&pdfLayoutDocument?.pages.some(page=>page.number===chunk.start)){if(isMode(mode))translationState.mode=mode;showMode(translationState.mode);return {document:pdfLayoutDocument};}
  // The server is asked for the session by the id the chunk's first save gives it (whole-book.js chunkSessionId), from
  // whichever tab or device saved it and however many sessions were saved since. One saved before these ids existed, or
  // one covering this page from an earlier first page, is looked for in the list the run loaded when it began.
  const ids=[await wholeBook.chunkSessionId(job.id,chunk.start),wholeBook.findChunkSession(historyItems,job,chunk.start)?.id].filter((id,index,list)=>id&&list.indexOf(id)===index);
  for(const id of ids){
   try{await resumeChunkSession(id,mode);return {document:pdfLayoutDocument};}
   catch(error){if(transient(error))throw error;}
  }
  return null;
 },
 // sessionId: the same for every retry of this save, so a save whose answer was lost is not made twice. mode: the run's
 // Cách dịch, which the chunk was extracted for and is read and translated in.
 async start(result,job,{sessionId='',mode=job.mode}={}){
  resetHistoryIdentity();historyIdToCreate=sessionId;activeHistoryMeta={title:job.title,filename:job.filename};bookTarget={id:job.storyId||'',replaceChapterId:''};pdfLayoutRange='';clearPageImages();showMode(mode);
  await adoptPdfLayout(result,{glossary:job.glossary,context:bookContext});
  // Notes of earlier chunks stay in view; "dịch tiếp ở lượt sau" is what the run does by itself, so it is not shown. The
  // extractor's note on a page it leaves with Chinese outside every block (page.untranslated) stays with the book's notes.
  const own=(result.document.warnings||[]).filter(note=>typeof note==='string'&&!/^Lượt này xử lý \d+\/\d+ trang/u.test(note)),left=new Set(result.document.pages.filter(page=>untranslatedHan(page)>0).map(page=>page.number));
  for(const note of own)if(left.has(Number(/^Trang (\d+)/u.exec(note)?.[1]))&&!bookNotes.includes(note))bookNotes.push(note);
  setNotes([...bookNotes,...own.filter(note=>!bookNotes.includes(note))]);
  bookChunkId='';await saveHistoryStrict();bookChunkId=activeHistoryId;
 },
 // A chunk asks once more for its stand-ins before it is exported (retryPass).
 async translate({shouldStop,renew}){syncManualGlossary();bookOutcome=await translateLayoutSession(await ensureStudyModel('pdf'),{pageStop:true,retryPass:true,shouldStop,heartbeat:renew,onNotes:notes=>bookNotes.push(...notes)});return bookOutcome;},
 async finish(){
  await saveHistoryStrict();let warning='';
  const pages=pdfLayoutDocument.pages.map(page=>page.number),range=pageLabel(Math.min(...pages),Math.max(...pages)).replace(/^t/u,'T');
  // Exporting uses only the PDF service, never Gemini: a part that fails here can be exported later from the history.
  try{await exportLayoutPdf(false,{show:false});}catch(error){if(transient(error))throw error;warning=error?.data?.code==='pdf_overflow'?overflowNote(range,error):`${range}: chưa xuất được PDF tiếng Việt (${error.message}). Mở phần này trong Lịch sử dịch rồi bấm Xuất PDF tiếng Việt; không tốn token.`;}
  // What the chunk leaves to the student, said for the chunk and counted for the book.
  const review=bookOutcome&&!bookOutcome.ocrStopped?bookOutcome:layoutReview(pdfLayoutDocument.pages.flatMap(p=>p.blocks)),note=reviewNote(review);
  if(bookReview)for(const name of REVIEW_KEYS)bookReview[name]+=Number(review[name])||0;
  if(note)warning=[warning,`${range}: cần xem lại ${note} (các đoạn được nêu ở trên).`].filter(Boolean).join('\n');
  bookOutcome=null;bookContext=translationState.context||'';
  return {storyId:lastSavedHistory?.libraryStoryId||null,glossary:{...translationState.glossary},warning};
 }
};
// Read with the books as the server has them now: a part whose export was refused is named, and the book is not said to
// be ready to download until it has its PDF. review: what this run's chunks left to the student.
function bookFinishedMessage(job,review=null){
 const failed=[...job.pageStates].flatMap((char,index)=>char==='f'?[index+1]:[]),count=review?reviewCount(review):0,missing=missingPdfNote(job);
 return `Đã dịch xong cả quyển: ${wholeBook.progressText(job.pageStates).replace(/^Đã dịch /u,'')}${failed.length?` · trang ${wholeBook.pageList(failed)} lỗi, giữ bản gốc`:''}${count?` · ${count} đoạn cần xem lại`:''}.${missing?` ${missing}`:''}`;
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
  if(stopped){bookBusy=true;const message='Đã thôi chờ; quyển này vẫn đang được dịch ở thiết bị khác.';bookStatus(message);status(message);return false;}
 }
}
async function runWholeBook(){
 key();if(!layoutConfig.configured)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');
 // Pressed while another device runs the book: the student chose to wait for it.
 const waiting=bookBusy;busy(true);stopRequested=false;bookBusy=false;
 // runMode: the Cách dịch the run extracts, reads and translates every chunk in, one begun before included; the field
 // shows it again when the run ends.
 let runMode='';
 try{
  await bookModeSave;await pdfTools();wake??=wholeBook.createWakeLock();await ensureStudyModel('pdf');
  if(bookJob&&!await bookRunnerFree(waiting))return;
  if(bookJob&&await wholeBook.jobLockHeld(bookJob.id))throw new Error('Quyển này đang được dịch ở một tab khác của trình duyệt. Hãy dùng tab đó, hoặc đóng nó rồi thử lại.');
  // Waited for another device that has finished the book meanwhile: nothing is left to download or translate here.
  if(waiting&&bookJob&&!/[.f]/u.test(bookJob.pageStates)){await Promise.all([refreshHistoryList(),loadBooks().catch(()=>{})]);const message=bookFinishedMessage(bookJob);bookStatus(message);status(message);return;}
  // A tab opened long ago knows only its own saves since: the run starts from the history as the server has it now.
  if(bookJob)await refreshHistoryList();
  const source=await prepareBookSource();
  if(selectedFile)await uploadOriginal(source);
  // The cover is known before the job starts: kept as printed it is never sent (paid for) like the other pages.
  if(!bookJob&&selectedFile){status('Đang tìm trang bìa…');await coverTask.catch(()=>{});}
  const resumed=Boolean(bookJob)&&bookJob.sourceSha256===source.sha256;if(!resumed)bookJob=await createBookJob(source);
  // A new run of an existing job tries every page not done yet, failed ones included; the range field adds or skips
  // pages only when the student edited it. These changes go with the run's claim of the job.
  const updates=resumed?wholeBook.resumeUpdates(bookJob.pageStates,bookPagesEdited?bookChosenPages(bookJob.totalPages):null,bookPagesEdited):{};
  setBookMode(true);await ensureBookCover(source);bookNotes=[];bookReview=emptyReview();bookOutcome=null;
  let chunkText='',waitingFor='';runMode=$('#mode').value;
  const run=bookRun=wholeBook.createBookRun({api,source,steps:bookSteps,shouldStop:()=>stopRequested,runner:bookRunner(),reports:bookReports(),mode:runMode,ui:{
   job(job){const changed=job!==bookJob;bookJob=upsertJob(job);renderBookPanel();if(changed)renderStudyBooks();},
   chunk(chunk){bookWorking=chunk?new Set(chunk.pages):null;chunkText=chunk?`Đang dịch ${pageLabel(chunk.start,chunk.pages.at(-1))}…`:'';if(chunk)status(chunkText);renderBookPanel();},
   waiting(reason,left){if(!reason){waitingFor='';bookStatus('');if(chunkText)status(chunkText);return;}bookStatus(wholeBook.waitMessage(reason,left),{quiet:waitingFor===reason});waitingFor=reason;},
   warn(message){bookNotes.push(message);addNotes(message);}
  }});
  let outcome=null;
  await wholeBook.withJobLock(bookJob.id,async()=>{await wake.on();try{outcome=await run.run(bookJob,{pages:updates});}finally{await wake.off();}});
  bookJob=upsertJob(outcome.job||bookJob);
  if(outcome.status==='done'){await loadBooks().catch(()=>{});const message=bookFinishedMessage(bookJob,bookReview);bookStatus(message);status(message);}
  else{
   if(outcome.reason==='gemini_key')forgetKey();
   if(outcome.reason==='busy')bookBusy=true;
   bookStatus(outcome.message);status(outcome.message,outcome.reason==='stopped'?'':'error');
  }
 }catch(error){rejectKey(error);fail(error,{run:true});bookStatus(String(error?.message||error));}
 finally{bookRun=null;bookWorking=null;historyIdToCreate='';if(runMode)showMode(runMode);busy(false);stopRequested=false;renderBookPanel();renderStudyBooks();}
}
function openDeleteDialog(id){
 const item=historyItems.find(entry=>entry.id===id);if(!item||running)return;const pages=item.page_start?` (${pageLabel(item.page_start,item.page_end||item.page_start)})`:'';
 openBookDialog('Xóa bản dịch?',body=>{const note=document.createElement('p');note.textContent=`“${item.title||'Bản dịch chưa đặt tên'}”${pages} sẽ bị xóa vĩnh viễn khỏi lịch sử và Thư viện riêng, cùng PDF tiếng Việt và tệp gốc của phần này.`;body.append(note);},()=>deleteHistory(id),'Xóa vĩnh viễn','Đang xóa…',{danger:true});
}
async function deleteHistory(id){
 const item=historyItems.find(entry=>entry.id===id),groups=jobSessions(),job=item&&bookJobs.find(entry=>groups.get(entry.id)?.some(part=>part.id===id));let result;
 try{result=await api(`history/${encodeURIComponent(id)}`,{method:'DELETE'});}
 catch(error){if(error.status!==404)throw error;await loadHistory();status('Bản dịch này đã được xóa trước đó.');return;}
 historyItems=historyItems.filter(entry=>entry.id!==id);if(id===bookChunkId)bookChunkId='';
 if(id===activeHistoryId){resetHistoryIdentity();await dualViewer.clear();translationState=null;translationParts=[];pdfLayoutDocument=null;pdfExportUrl='';pdfLayoutRange='';clearPartStream();$('#source').readOnly=false;$('#source').value='';$('#translation').value='';setNotes([]);overflowIds=[];$('#download').disabled=true;$('#download-pdf').disabled=true;if(!selectedFile&&!refusedPick)lastPickPdf=false;updateCount();}
 if(result.removedBookId){studyBooks=studyBooks.filter(book=>book.id!==result.removedBookId);if(bookTarget.id===result.removedBookId)bookTarget={id:'',replaceChapterId:''};}
 // A whole-book part leaves its run too: the server offers its pages again unless the run's book still holds them, and
 // forgets an emptied book; the run is shown as it is now (another device may be running it, so nothing is sent).
 if(job)await loadBookJobs();
 // Older sessions not listed yet stay behind "Xem thêm bản cũ hơn", whose cursor still holds.
 renderBookTarget();renderHistory();renderBookPanel();status('Đã xóa bản dịch.');
}
function openJobDeleteDialog(id){
 const job=bookJobs.find(entry=>entry.id===id);if(!job||running)return;
 openBookDialog('Xóa tiến độ dịch cả quyển?',body=>{const note=document.createElement('p');note.textContent=`Bảng tiến độ của “${job.title}” sẽ bị xóa. Các phần đã dịch vẫn nằm trong Lịch sử dịch và Thư viện riêng.`;body.append(note);},async()=>{
  await api(`book-jobs/${encodeURIComponent(id)}`,{method:'DELETE'}).catch(error=>{if(error.status!==404)throw error;});
  bookReports().save(id,[]);bookJobs=bookJobs.filter(entry=>entry.id!==id);if(bookJob?.id===id){bookJob=null;bookStatus('');updateTitleControls();}renderHistory();renderBookPanel();status('Đã xóa tiến độ dịch cả quyển.');
 },'Xóa tiến độ','Đang xóa…',{danger:true});
}

$('#source').addEventListener('beforeinput',event=>{if(keepUnsaved())event.preventDefault();});
$('#source').addEventListener('input',()=>{resetHistoryIdentity();if(!bookChoiceActive())bookTarget={id:'',replaceChapterId:''};translationState=null;translationParts=[];clearPartStream();$('#translation').value='';$('#download').disabled=true;updateCount();});
$('#content-title').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');updateTitleControls();$('#content-title-hint').textContent='';});
$('#save-title').addEventListener('click',()=>renameHistory().catch(fail));
// A whole-book run keeps its book's name in the field; the book is renamed in Sắp xếp phần.
$('#rename-book').addEventListener('click',()=>{if(bookJob?.storyId)openOrderDialog(bookJob.storyId);});
// The suggested math terms fill an empty field only before anything is translated, and leave with the subject while the
// student has not touched them; an opened session keeps the terms it has.
$('#glossary').addEventListener('input',()=>{autoGlossary=false;});
$('#domain').addEventListener('change',event=>{
 const domain=event.target.value,field=$('#glossary');
 if(autoGlossary&&domain!=='math'&&field.value===MATH_GLOSSARY){field.value='';autoGlossary=false;}
 else if(domain==='math'&&!translationState&&!field.value.trim()){field.value=MATH_GLOSSARY;autoGlossary=true;}
 settingChanged('domain');
});
$('#mode').addEventListener('change',()=>{modeTouched=true;renderModeHint();settingChanged('mode');renderBookPanel();saveBookMode();});
// The box reads the picked file again its way: a PDF refused for its size as a kept layout (refusedPick) included.
$('#pdf-layout-enabled').addEventListener('change',()=>{const file=refusedPick||selectedFile;if(file)selectionTask=selected(file).catch(fail);else if(bookJob)unbindBook();});
$('#library-match-dismiss').addEventListener('click',()=>{$('#library-match').hidden=true;});
$('#source-file').addEventListener('click',event=>{if(keepUnsaved())event.preventDefault();});
$('#source-file').addEventListener('change',event=>{selectionTask=pickFiles([...event.target.files]).catch(error=>{fail(error);return false;});});
$('#study-history-list').addEventListener('click',event=>{if(event.target.closest('[data-history-more]')){loadMoreHistory();return;}const remove=event.target.closest('[data-history-delete]');if(remove){openDeleteDialog(remove.dataset.historyDelete);return;}const merge=event.target.closest('[data-history-merge]');if(merge){openMergeDialog(merge.dataset.historyMerge);return;}const button=event.target.closest('[data-history-open]');if(button)openHistory(button.dataset.historyOpen).catch(fail);});
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
$('#page-range').addEventListener('input',()=>{cover.note='';updateBookHint();renderCover();updateRunBar();});
$('#cover-change').addEventListener('click',openCoverDialog);
$('#cover-none').addEventListener('click',()=>{if(running)return;Object.assign(cover,{page:0,source:'student',replace:false,synced:'',note:''});setCoverImage(null);coverChanged();});
$('#cover-translate').addEventListener('change',()=>{cover.untick=!$('#cover-translate').checked;cover.note='';renderCover();refreshOfferedRange();updateBookHint();updateRunBar();});
$('#book-replace').addEventListener('change',updateBookHint);
$('#book-next-range').addEventListener('click',event=>{$('#page-range').value=event.currentTarget.dataset.range||$('#page-range').value;cover.note='';updateBookHint();renderCover();updateRunBar();$('#page-range').focus();});
$('#book-dialog-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!dialogSubmit)return;const button=$('#book-dialog-submit'),submit=dialogSubmit,opened=dialogOpened,shown=()=>opened===dialogOpened&&Boolean($('#book-dialog').open);
 button.disabled=true;$('#book-dialog-status').textContent=dialogWorking;
 try{await submit();if(shown())closeBookDialog();}
 catch(error){if(shown()){$('#book-dialog-status').textContent=error.message;button.disabled=false;}else fail(error);}
});
$('#book-dialog').addEventListener('close',()=>{dialogSubmit=null;});
$('#book-dialog-cancel').addEventListener('click',closeBookDialog);
// A key Gemini refused while the run was checking its model leaves the tab too (S74).
$('#translate').addEventListener('click',()=>run().catch(error=>{rejectKey(error);fail(error,{run:true});}));
$('#check-gemini-model').addEventListener('click',()=>{if(running)return;ensureStudyModel(translationState?.pdfLayout||$('#pdf-layout-enabled').checked&&selectedFile?.name.toLowerCase().endsWith('.pdf')?'pdf':'text').then(model=>status(`Khóa dùng được ${model}. Bấm ${runLabel()}.`)).catch(error=>{rejectKey(error);fail(error);});});
$('#stop').addEventListener('click',()=>{stopRequested=true;ocrChoice?.(false);const message=bookRun?'Sẽ dừng khi xong trang đang dịch; tiến độ được lưu.':'Sẽ dừng sau yêu cầu đang chạy.';status(message);if(bookRun)bookStatus(message);});
$('#api-key').addEventListener('input',event=>{event.currentTarget.setCustomValidity('');event.currentTarget.removeAttribute('aria-invalid');renderKeyHelp();});
$('#clear-key').addEventListener('click',()=>{sessionKey='';$('#api-key').value='';$('#api-key').removeAttribute('aria-invalid');$('#key-status').textContent=KEY_EMPTY;delete $('#key-status').dataset.tone;renderKeyHelp();$('#api-key').focus();status('Đã xóa khóa khỏi tab này.');});
$('#download').addEventListener('click',()=>{const text=$('#translation').value,filename=downloadFilename('txt');offerDownload(()=>saveFile(new Blob(['﻿'+text],{type:'text/plain;charset=utf-8'}),filename)).catch(fail);});
$('#download-rich').addEventListener('click',()=>offerDownload(downloadRichHtml).catch(fail));
// While the export waits for a busy PDF service, Dừng shows and stops the wait.
function exportNow(){if(running)return;runActive=true;stopRequested=false;busy(true);exportLayoutPdf().catch(error=>error?.code==='stopped'?status(error.message):fail(error)).finally(()=>{runActive=false;stopRequested=false;busy(false);renderHistory();});}
// Exporting a layout an older extractor read draws that old layout again (its printed Chinese outside the blocks too):
// "Cập nhật bố cục" is offered first, and the old layout is still one click away (Vẫn xuất bản cũ).
function offerRefreshBeforeExport(){
 openBookDialog('Bố cục của phần này đã cũ',body=>{
  const note=document.createElement('p');
  note.textContent='Xuất lại sẽ giữ bố cục cũ (tiêu đề, chú thích ngoài các đoạn vẫn là chữ Trung). Cập nhật bố cục không tốn token và báo trước số token cho phần mới.';body.append(note);
 },async()=>{closeBookDialog();refreshLayout().catch(fail);},'Cập nhật bố cục','Đang lưu…',{extra:['Vẫn xuất bản cũ',()=>{closeBookDialog();exportNow();}]});
}
$('#download-pdf').addEventListener('click',()=>{if(running)return;if(translationState?.pdfLayout&&needsPdfLayoutRefresh()&&!pdfOcrResumable()&&!bookMode&&!detachedSession())offerRefreshBeforeExport();else exportNow();});
// S71/S72: the score in one line, the formulas only when the model translation has some, and why a score is low when the
// two differ much in length; BLEU-4 is named once, under it.
$('#evaluate').addEventListener('click',()=>{
 const candidate=$('#translation').value.trim(),reference=$('#reference').value.trim();if(!candidate||!reference){fail(new Error('Dán bản dịch mẫu rồi bấm So sánh.'));$('#reference').focus();return;}
 const result=evaluateStudyTranslation(candidate,reference),number=new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1}),line=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;},lines=[line('strong',`Độ giống: ${number.format(result.bleu)}/100`)];
 if(result.formulasTotal)lines.push(line('span',`Công thức giữ đúng: ${number.format(result.formulaRetention)}% (${result.formulasMatched}/${result.formulasTotal})`));
 const [ours,theirs]=[result.candidateTokens,result.referenceTokens];
 if(theirs*3<ours)lines.push(line('span',`Bản mẫu chỉ có ${number.format(theirs)} từ so với ${number.format(ours)} của bản dịch, nên điểm thấp.`));else if(ours*3<theirs)lines.push(line('span',`Bản dịch chỉ có ${number.format(ours)} từ so với ${number.format(theirs)} của bản mẫu, nên điểm thấp.`));
 lines.push(line('small','BLEU-4, chỉ để tham khảo.'));$('#evaluation-result').replaceChildren(...lines);
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
// Cần xem lại: Sửa opens the block's editor on its page; a part's note opens that part.
$('#warnings').addEventListener('click',event=>{
 const edit=event.target.closest('[data-edit-block]');if(edit){loadViewer().then(viewer=>viewer.openBlock(edit.dataset.editBlock)).catch(fail);return;}
 const part=event.target.closest('[data-open-part]'),card=part&&$(`#translation-parts [data-translation-part="${part.dataset.openPart}"]`);
 if(card){card.open=true;card.scrollIntoView?.({behavior:scrollBehavior(),block:'start'});card.querySelector('summary').focus({preventScroll:true});}
});
// Dịch tiếp of the line under the folded history: the same as the book row's.
$('#study-resume').addEventListener('click',event=>{const button=event.target.closest('[data-book-resume]');if(button&&!button.disabled)openBookJob(button.dataset.bookResume).catch(fail);});
// ---- Menus (Tải định dạng khác ▾, the rows' ⋯): one open at a time; Escape, a tap outside or Tab out of it closes it, and
// so does an item, which leaves the focus on the menu's button (a dialog it opens gives the focus back there). Only a focus
// that lands outside counts: Safari focuses nothing on a click, and its item must still take that click.
function closeMenus(except=null){for(const menu of document.querySelectorAll('details.menu[open]'))if(menu!==except)menu.open=false;}
document.addEventListener('toggle',event=>{if(event.target.matches?.('details.menu')&&event.target.open)closeMenus(event.target);},true);
document.addEventListener('focusout',event=>{const menu=event.target.closest?.('details.menu[open]');if(menu&&event.relatedTarget&&!menu.contains(event.relatedTarget))menu.open=false;},true);
document.addEventListener('pointerdown',event=>{if(!event.target.closest?.('details.menu[open]'))closeMenus();});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=event.target.closest?.('details.menu[open]');if(menu){event.preventDefault();menu.open=false;menu.querySelector(':scope>summary').focus();}});
document.addEventListener('click',event=>{const item=event.target.closest?.('details.menu .menu-list>:is(button,a)');if(!item)return;const menu=item.closest('details.menu');menu.open=false;if(item.tagName==='BUTTON')menu.querySelector(':scope>summary').focus({preventScroll:true});},true);
// The export group follows what each download can do: the code that makes one available or not sets its disabled flag.
new MutationObserver(()=>renderExport()).observe($('.result-actions'),{subtree:true,attributes:true,attributeFilter:['disabled']});
// The history explains its own loading failure in place, with Thử lại (contract 8). It stays folded; an unfinished book
// run has its line under it (renderResume), and a part that lacks its Vietnamese PDF opens it.
function loadHistoryView(){
 historyError=null;$('#study-history-count').textContent='· đang tải…';$('#study-history-list').replaceChildren();
 return loadHistory().then(()=>{if(bookJobs.some(job=>missingPdfParts(job).length))$('#study-history').open=true;renderResume();}).catch(error=>{historyError=error;renderHistory();$('#study-history').open=true;});
}
// Signed out, the form could not be used: a card says why and links to sign in. A failed check offers Thử lại.
function sessionCard(kind){
 const card=$('#session-card'),title=document.createElement('h2'),text=document.createElement('p'),actions=document.createElement('div');title.id='session-card-title';actions.className='session-card-actions';
 if(kind==='out'){
  title.textContent='Đăng nhập để dùng Xưởng dịch';text.textContent='Tài liệu gốc và bản dịch được lưu vào tài khoản của bạn. Khi dịch, bạn dùng khóa Gemini riêng (tạo miễn phí).';
  const login=signInLink('Đăng nhập hoặc tạo tài khoản'),library=document.createElement('a');login.href='/#account?sau=xuong-dich';login.className='button primary';library.href='/';library.className='button quiet';library.textContent='Vào Thư viện';actions.append(login,library);
  card.replaceChildren(title,text,actions);
 }else{
  title.textContent='Chưa kết nối được máy chủ';
  const retry=document.createElement('button');retry.type='button';retry.className='primary';retry.textContent='Thử lại';retry.addEventListener('click',()=>checkSession().then(()=>($('#session-card').hidden?$('#main'):$('#session-card .primary'))?.focus()));actions.append(retry);
  card.replaceChildren(title,actions);
 }
 card.hidden=false;
}
// /study?history=<id> (Thư viện riêng links a part here) opens that saved translation once the history is listed;
// &refresh=1 brings "Cập nhật bố cục" into view when its layout is older. Nothing is extracted or paid for until a button
// is pressed. The address drops the query at once, so a reload does not open it again.
async function openFromAddress(){
 const params=new URLSearchParams(location.search),id=params.get('history');if(id===null)return;
 globalThis.history?.replaceState?.(null,'',location.pathname+location.hash);if(!/^[a-f\d-]{36}$/iu.test(id))return;
 await openHistory(id);
 const button=$('#layout-refresh:not([hidden]) button');if(params.get('refresh')==='1'&&button){button.scrollIntoView?.({behavior:scrollBehavior(),block:'center'});button.focus({preventScroll:true});}
}
function checkSession(){
 document.body.dataset.session='checking';$('#session-card').hidden=true;$('#account-status').hidden=false;$('#account-status').textContent='Đang kiểm tra phiên đăng nhập…';
 return fetch('/api/me',{credentials:'same-origin'}).then(response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}).then(data=>{
  if(!data?.authenticated){document.body.dataset.session='out';sessionKnown(false);$('#translate').disabled=true;sessionCard('out');return;}
  document.body.dataset.session='in';sessionKnown(true);renderHeaderAccount(data.user);$('#account-status').hidden=true;$('#study-history').hidden=false;$('#translate').disabled=running;updateRunBar();loadHistoryView().then(openFromAddress).catch(fail);
 }).catch(()=>{document.body.dataset.session='error';$('#translate').disabled=true;sessionCard('error');});
}
// The page ends above the floating action bar on phones, and a focused field scrolls above it, however tall the bar is
// (a save warning, Dừng, the progress line).
if(globalThis.ResizeObserver)new ResizeObserver(([entry])=>document.documentElement.style.setProperty('--run-bar-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`)).observe($('#run-bar'));
checkSession();
updateCount();
// The page may open with another mode than the one written in study.html (the browser restoring the field).
renderModeHint();renderModeCompare();renderKeyHelp();
