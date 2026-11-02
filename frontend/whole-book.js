// "Dịch cả quyển": the original PDF goes to the student's account once, then the device cuts it into chunks of at most 20
// pages. Each chunk is translated exactly like a range picked by hand (one study session, one part of the same private
// book), so the history, the library and "Tải cả quyển" need nothing new. The job (page states, tokens, the book's
// glossary) lives on the server, so a reload or another day continues where it stopped; the Gemini key stays in the tab.
// pdf.js and pdf-lib load only when used; everything else here also runs under node --test.
import {openPdf} from './cover-detect.js';
import {keyRefused} from './gemini-key.js';
import {DEFAULT_MODE,isMode,modeProfile,untranslatedHan} from './translation-modes.js';

// untranslated: a page with no block to translate that still shows Chinese outside every block (the extractor's
// page.untranslated: in a figure, a rotated watermark…), kept as printed and named in the notes; only a page that shows
// none is blank.
export const PAGE_STATES=Object.freeze({pending:'.',done:'d',blank:'b',untranslated:'u',cover:'c',skipped:'s',failed:'f'});
const NAMES=Object.fromEntries(Object.entries(PAGE_STATES).map(([name,char])=>[char,name]));
// 20 pages is the PDF service's limit per extraction. A chunk over 16 MB would not fit the service's 32 MB budget once it
// is base64-encoded next to its page images, so it is cut smaller before it is sent.
export const CHUNK_PAGES=20,SOURCE_MAX_BYTES=100*1024*1024,CHUNK_MAX_BYTES=16*1024*1024;
// nopdf: a translated page of a part whose Vietnamese PDF is missing (study.js missingPdf), drawn apart in the grid.
export const PAGE_LABELS=Object.freeze({pending:'Chưa dịch',working:'Đang dịch',done:'Đã dịch',nopdf:'Đã dịch, chưa có PDF',blank:'Trang trống',untranslated:'Còn chữ chưa dịch',cover:'Bìa',skipped:'Bỏ qua',failed:'Lỗi'});

// ---- Page states (one character per page, as the server stores them) ----
export function initialPageStates(total,{cover=0,pages=null}={}){
 if(!Number.isInteger(total)||total<1||total>100000)throw new Error('Số trang PDF không hợp lệ.');
 return Array.from({length:total},(_,i)=>i+1===cover?'c':pages&&!pages.has(i+1)?'s':'.').join('');
}
export const stateAt=(states,page)=>NAMES[String(states||'')[page-1]]||'pending';
export function withStates(states,updates){
 const chars=[...String(states||'')];
 for(const [page,name] of Object.entries(updates||{})){const index=Number(page)-1;if(Number.isInteger(index)&&index>=0&&index<chars.length&&PAGE_STATES[name])chars[index]=PAGE_STATES[name];}
 return chars.join('');
}
export const statesFor=(pages,name)=>Object.fromEntries([...pages].map(page=>[page,name]));
export function countStates(states){
 const count={total:0,pending:0,done:0,blank:0,untranslated:0,cover:0,skipped:0,failed:0};
 for(const char of String(states||'')){count.total++;count[NAMES[char]||'pending']++;}
 // The pages Gemini has to translate: the cover, blank, untranslated and skipped pages keep the original.
 count.wanted=count.total-count.cover-count.blank-count.untranslated-count.skipped;return count;
}
// The next chunk: the first pending page and the pending pages right after it. A chunk is one run of pages because the
// server numbers its pages from the chunk's offset in the original.
export function nextChunk(states,limit=CHUNK_PAGES){
 const text=String(states||''),start=text.indexOf('.')+1;if(!start)return null;let end=start;
 while(end<text.length&&end-start+1<limit&&text[end]==='.')end++;
 return {start,end,pages:Array.from({length:end-start+1},(_,i)=>start+i)};
}
// What a chunk's manifest says: pages with blocks are translated with the chunk; a page without any has nothing to
// translate and costs no Gemini call: blank only when the extractor saw no Chinese left on it (translation-modes.js
// untranslatedHan), untranslated otherwise. Pages the extractor did not reach stay pending for the next chunk.
export function chunkPages(document){
 const done=[],blank=[],untranslated=[];
 for(const page of document?.pages||[])if(Number.isInteger(page?.number))(page.blocks?.length?done:untranslatedHan(page)>0?untranslated:blank).push(page.number);
 return {done,blank,untranslated,processed:done.length+blank.length+untranslated.length};
}
// Pages outside the chosen ones are skipped, and skipped pages chosen again become pending; finished pages stay.
export function rangeUpdates(states,chosen){
 const updates={};
 for(let page=1;page<=String(states||'').length;page++){const name=stateAt(states,page),wanted=!chosen||chosen.has(page);if(name==='pending'&&!wanted)updates[page]='skipped';else if(name==='skipped'&&wanted)updates[page]='pending';}
 return updates;
}
// What a new run of an existing job changes first: failed pages are tried again, and the range field counts only when
// the student edited it. An untouched field (empty after a reload or on another device) never brings back the pages
// the student left out when the job was made.
export function resumeUpdates(states,chosen,edited=false){
 const failed=statesFor([...String(states||'')].flatMap((char,index)=>char==='f'?[index+1]:[]),'pending');
 return {...failed,...(edited?rangeUpdates(withStates(states,failed),chosen):{})};
}
// The range field for a job: the pages it translates (not left out, not the cover), as the field takes them ("2-8, 12");
// empty for a whole book.
export function chosenPagesText(states){
 const text=String(states||'');if(!text.includes('s'))return '';
 return pageList([...text].flatMap((char,index)=>char==='s'||char==='c'?[]:[index+1])).replaceAll('–','-');
}
// "1–3, 7, 9–12" for a list of pages.
export function pageList(pages){
 const sorted=[...new Set(pages)].sort((a,b)=>a-b),parts=[];
 for(let i=0;i<sorted.length;i++){const start=sorted[i];while(sorted[i+1]===sorted[i]+1)i++;parts.push(start===sorted[i]?String(start):`${start}–${sorted[i]}`);}
 return parts.join(', ');
}
export function progressText(states){const count=countStates(states);return `Đã dịch ${count.done}/${count.wanted} trang`;}
export function progressNote(states){
 const count=countStates(states),notes=[];
 if(count.cover)notes.push('bìa giữ nguyên');if(count.blank)notes.push(`${count.blank} trang trống`);if(count.untranslated)notes.push(`${count.untranslated} trang còn chữ chưa dịch`);if(count.skipped)notes.push(`bỏ qua ${count.skipped} trang`);if(count.failed)notes.push(`${count.failed} trang lỗi`);
 return notes.join(' · ');
}

// ---- Token estimate ----
// Measured, not guessed: 867 tokens for one text-layer page (the handoff run from a fresh clone) and 2,056 for the dense
// math page of docs/math-pdf-test-report.md. A scanned page adds Gemini's reading of its OCR sheets: 2,078–5,209 prompt
// tokens per page over eight genres (countTokens, tmp/pdf-layout/final-report) plus up to ~800 output tokens.
export const PAGE_TOKENS=Object.freeze({text:Object.freeze([900,2100]),scan:Object.freeze([3000,8000])});
// Those costs are Tiết kiệm's. Another "Cách dịch" spends more (more thinking, smaller calls, finer OCR sheets, readings
// read again): its profile's estimate (translation-modes.js) scales them.
export function pageTokens(mode=DEFAULT_MODE){
 const factor=modeProfile(mode).estimate,scale=range=>range.map(tokens=>Math.round(tokens*factor));
 return {text:scale(PAGE_TOKENS.text),scan:scale(PAGE_TOKENS.scan)};
}
// kinds[i] is 'text', 'scan' or missing (not surveyed yet); only pages still pending count.
export function estimateTokens(states,kinds=[],mode=DEFAULT_MODE){
 const result={text:0,scan:0,unknown:0,low:0,high:0},costs=pageTokens(mode);
 for(let page=1;page<=String(states||'').length;page++){if(stateAt(states,page)!=='pending')continue;const kind=kinds[page-1];result[kind==='text'||kind==='scan'?kind:'unknown']++;}
 result.low=result.text*costs.text[0]+result.scan*costs.scan[0]+result.unknown*costs.text[0];
 result.high=result.text*costs.text[1]+(result.scan+result.unknown)*costs.scan[1];
 return result;
}
// Once pages are done, the book's own average says more than the generic range.
export function usageProjection(job){
 const count=countStates(job?.pageStates),total=Number(job?.usage?.total)||0;if(!count.done||!total)return null;
 const perPage=total/count.done;return {perPage:Math.round(perPage),pending:count.pending,remaining:Math.round(perPage*count.pending)};
}
// Both ends of a range in one unit: "75–200 nghìn", "0,5–1,3 triệu".
export function formatTokenRange(low,high){
 const unit=high>=1e6?[1e6,' triệu',1]:high>=1e5?[1e3,' nghìn',0]:null;if(!unit)return `${formatTokens(low)}–${formatTokens(high)}`;
 const format=value=>new Intl.NumberFormat('vi-VN',{maximumFractionDigits:unit[2]}).format(Math.max(0,value)/unit[0]);
 return `${format(low)}–${format(high)}${unit[1]}`;
}
export function formatTokens(value){
 const n=Math.max(0,Math.round(Number(value)||0));
 if(n>=1e6)return `${new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1}).format(n/1e6)} triệu`;
 if(n>=1e5)return `${new Intl.NumberFormat('vi-VN').format(Math.round(n/1e3))} nghìn`;
 return new Intl.NumberFormat('vi-VN').format(n);
}

// ---- Errors: what to do with a failed request ----
// Gemini quota errors reach the browser as 429 {code:'quota_minute'|'quota_day'|'quota', retryAfter}; a refused key as
// {code:'gemini_key'}, and only that code means the key (backend/gemini-errors.js); Gemini not serving the place the
// server called from as 503 {code:'gemini_location', retryAfter}; Hoa Trí's own limiter as {code:'rate_limited',
// retryAfter}. Older servers sent the same cases as plain messages, which are recognised when no code came. The PDF
// service's (backend/pdf-layout.js): 503 pdf_service_busy with retryAfter (every place of the service is taken), 503
// pdf_unavailable (out of reach), 503 pdf_local_off (the service of the machine running Hoa Trí does not answer), 413
// pdf_timeout, pdf_memory, pdf_too_large or pdf_crash (this chunk is too heavy for one job), 429 pdf_busy (this account's
// other PDF call). Saving a part (backend/study-history.js): 413 history_full or too_many_parts, 409 history_conflict
// (another tab or device saved that part since). 500 schema_outdated: a database behind the code (backend/http.js).
// capacity: while the wait lasts, GET pdf-layout/capacity is asked before the request goes again (createBookRun).
const BACKOFF=[5,10,20,40,60,60];
// A busy PDF service is shared by the whole site: a class running books at once can keep it full for a while, so a run
// waits about half an hour (30 tries, at most a minute apart) before it pauses.
export const SERVICE_BUSY_RETRIES=30;
const HEAVY_PDF=new Set(['pdf_timeout','pdf_memory','pdf_too_large']);
export function classifyError(error,step=''){
 const status=error?.status,data=error?.data||{},code=String(data.code||error?.code||''),message=String(error?.message||''),after=Number(data.retryAfter??error?.retryAfter);
 const retryAfter=Number.isFinite(after)&&after>0?after:null;
 if(code==='quota_day'||/hết hạn mức (?:yêu cầu )?trong ngày/u.test(message))return {reason:'quota_day'};
 if(code==='quota_minute'||code==='quota'&&retryAfter!==null&&retryAfter<=300||!code&&/Gemini trả lỗi 429/u.test(message))return {reason:'quota_minute',wait:Math.min(300,Math.max(5,retryAfter??60)),retries:20};
 if(code==='quota')return {reason:'quota'};
 if(keyRefused(error))return {reason:'gemini_key'};
 // The key is fine: Google does not serve the place the server called from. A later call may run from elsewhere.
 if(code==='gemini_location')return {reason:'gemini_location',wait:Math.min(300,Math.max(30,retryAfter??60)),retries:5};
 // The account's history has no room for the part, or the part has more blocks than one save takes: before the
 // generic 413 below, which means a chunk too heavy for the PDF service.
 if(code==='history_full')return {reason:'history_full'};
 if(code==='too_many_parts')return {reason:'too_many_parts'};
 if(code==='history_conflict')return {reason:'conflict'};
 // A migration the database lacks fails every save alike until it is applied: no wait mends it.
 if(code==='schema_outdated')return {reason:'schema'};
 // Another device's run holds the job (409): this run stops before it pays for anything.
 if(code==='job_busy')return {reason:'busy'};
 // Waited out like a lost connection, never shorter than the server asks, a little spread so that the students it
 // turned away do not all come back at once; a hidden tab keeps counting down (a book runs in the background).
 if(code==='pdf_service_busy')return {reason:'pdf_busy',backoff:true,retries:SERVICE_BUSY_RETRIES,wait:Math.min(300,Math.max(5,retryAfter??20)),early:false,jitter:true,capacity:true};
 // This account's own other PDF call (another tab or device) holds its place: waited out like a limit, asking too.
 if(code==='pdf_busy')return {reason:'pdf_account',wait:Math.min(300,Math.max(5,retryAfter??30)),retries:20,capacity:true};
 if(code==='pdf_unavailable')return {reason:'network',backoff:true,retries:BACKOFF.length,...(retryAfter!==null?{wait:Math.min(300,retryAfter)}:{})};
 // The service of this machine may still be starting: a few short waits, then the server's words name start.cmd.
 if(code==='pdf_local_off')return {reason:'pdf_local',wait:Math.min(300,Math.max(5,retryAfter??10)),retries:3};
 // A PDF drawn on other layout code than this site's (the service's image not rebuilt yet after a deploy) is thrown
 // away: drawn again before the rebuild it would be thrown away again, so the run pauses at once with the server's words.
 if(code==='pdf_service_outdated')return {reason:'error'};
 // Out of time, memory or room in one job: the chunk is tried again with half the pages, and later chunks keep the size
 // that worked (heavy). A crash is handled like a page the service refuses: halving finds that page.
 if(HEAVY_PDF.has(code))return {reason:'too_large',heavy:true};
 if(code==='pdf_crash')return {reason:'too_large'};
 // A daily cap answers with the time left until midnight; only a short wait is worth sitting through.
 if(code==='rate_limited'||status===429)return retryAfter!==null&&retryAfter>300?{reason:'limit'}:{reason:'rate_limited',wait:Math.min(300,Math.max(2,retryAfter??30)),retries:20};
 // Gemini overloaded or out of reach after the server's own attempts (503 gemini_unavailable; older servers sent a
 // plain 400): backed off like a lost connection, never shorter than the wait the server asks for.
 if(code==='gemini_unavailable'||!code&&/Gemini trả lỗi 5\d\d/u.test(message))return {reason:'gemini_unavailable',backoff:true,retries:BACKOFF.length,...(retryAfter!==null?{wait:Math.min(300,retryAfter)}:{})};
 if(status===0||[502,503,504].includes(status)||/Không kết nối ổn định tới Gemini|Không kết nối được dịch vụ PDF|Dịch vụ PDF đang tạm ngừng|tạm thời không phản hồi|phản hồi không đọc được/u.test(message))return {reason:'network',backoff:true,retries:BACKOFF.length};
 if(code==='no_text'||code==='no_blocks'||/Không tìm thấy block tiếng Trung/u.test(message))return {reason:'no_blocks'};
 // A server without Tesseract fails every scanned page alike: that is for the administrator, not a bad page.
 if(/Tesseract|TESSDATA|prepare:pdf-ocr/u.test(message))return {reason:'error'};
 if(status===413||code==='too_large'||/quá lớn|xử lý quá lâu/u.test(message))return {reason:'too_large'};
 if(status===500)return {reason:'server',backoff:true,retries:2};
 if(step==='extract'&&/\bTrang \d+/u.test(message))return {reason:'page'};
 // Gemini's output failed a check (a missing block, a broken formula token): one more try, then the student decides.
 return step==='translate'&&status>=400&&status<500?{reason:'error',wait:3,retries:1}:{reason:'error'};
}
export const BACKOFF_SECONDS=BACKOFF;

// Gemini's daily quotas reset at midnight Pacific time: 15:00 in Vietnam, 14:00 while the US is on daylight time.
const PACIFIC='America/Los_Angeles',VIETNAM='Asia/Ho_Chi_Minh';
function zoneOffset(time,zone){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}).formatToParts(new Date(time)).map(part=>[part.type,part.value]));
 return Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour%24,+parts.minute,+parts.second)-Math.floor(time/1000)*1000;
}
export function nextQuotaReset(now=Date.now()){
 const wall=new Date(now+zoneOffset(now,PACIFIC)),midnight=Date.UTC(wall.getUTCFullYear(),wall.getUTCMonth(),wall.getUTCDate()+1);
 // Daylight time changes at 2:00, never at midnight; the second pass takes the offset valid at the reset itself.
 let instant=midnight-zoneOffset(now,PACIFIC);instant=midnight-zoneOffset(instant,PACIFIC);return new Date(instant);
}
export function quotaResetLabel(now=Date.now()){
 const reset=nextQuotaReset(now),day=time=>new Intl.DateTimeFormat('en-CA',{timeZone:VIETNAM}).format(new Date(time));
 const clock=new Intl.DateTimeFormat('vi-VN',{timeZone:VIETNAM,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(reset);
 const when=day(reset)===day(now)?'hôm nay':day(reset)===day(now+864e5)?'ngày mai':new Intl.DateTimeFormat('vi-VN',{timeZone:VIETNAM,day:'numeric',month:'numeric'}).format(reset);
 return `${clock} ${when}`;
}
// The time a lease that ends in `seconds` runs out, on the device's own clock.
const clockIn=(seconds,now)=>new Intl.DateTimeFormat('vi-VN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(now+seconds*1000));
export function pauseMessage(reason,error,now=Date.now()){
 const detail=String(error?.message||'').trim(),lease=Number(error?.data?.retryAfter);
 // A save that failed after Gemini had translated part of the chunk (study.js saveBeforeSpending, keptInTab): that part
 // is only in this tab, which saves it first when the run goes on there. The pause says so, after the server's own
 // words for a refusal, instead of "Tiến độ đã lưu". A copy saved elsewhere since (conflict) is reopened instead.
 if(error?.keptInTab&&reason!=='conflict'){
  const next=reason==='history_full'?'dọn bớt xong, bấm Tiếp tục dịch cả quyển ở tab này':reason==='network'?'khi mạng ổn định, bấm Tiếp tục dịch cả quyển ở tab này':'bấm Tiếp tục dịch cả quyển ở tab này để lưu và dịch tiếp';
  return `${reason==='network'?'Mất kết nối tới máy chủ.':detail||'Chưa lưu được phần vừa dịch vào tài khoản.'} Phần đã dịch vẫn hiện trong tab này: đừng đóng tab. Các trang đã xong trước đó đã lưu; ${next}.`;
 }
 switch(reason){
  case 'stopped':return 'Đã dừng theo yêu cầu. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển khi muốn dịch tiếp.';
  case 'busy':return `Quyển này đang được dịch ở một thiết bị khác (hoặc một trình duyệt khác). Để không trả token hai lần cho cùng trang, Hoa Trí không dịch song song ở thiết bị này; tiến độ đã lưu. Bấm Chờ rồi dịch tiếp: Hoa Trí theo dõi tiến độ và tự dịch tiếp ở đây khi thiết bị kia dừng${lease>0?`, hoặc muộn nhất khoảng ${clockIn(lease,now)} nếu thiết bị kia không còn báo tiến độ`:''}.`;
  case 'gemini_unavailable':return 'Gemini đang quá tải hoặc tạm thời không phản hồi sau nhiều lần thử. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển sau ít phút.';
  case 'quota_day':return `Khóa Gemini này đã dùng hết hạn mức trong ngày. Tiến độ đã lưu. Dán khóa khác rồi bấm Tiếp tục dịch cả quyển, hoặc đợi hạn mức đặt lại lúc khoảng ${quotaResetLabel(now)} (giờ Việt Nam).`;
  case 'quota':return 'Gemini báo khóa này đã hết hạn mức. Tiến độ đã lưu; hãy thử lại sau hoặc dán khóa khác.';
  case 'quota_minute':return 'Gemini vẫn giới hạn số yêu cầu mỗi phút sau nhiều lần chờ. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển sau ít phút.';
  case 'gemini_key':return 'Gemini không chấp nhận khóa này. Hãy dán một khóa Gemini hợp lệ rồi bấm Tiếp tục dịch cả quyển.';
  case 'rate_limited':return 'Hoa Trí đang giới hạn tốc độ. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển sau ít phút.';
  case 'pdf_busy':return 'Dịch vụ PDF vẫn bận vì nhiều người dùng cùng lúc sau nhiều lần chờ. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển sau ít phút.';
  case 'pdf_account':return 'Tài khoản của bạn vẫn đang có một lượt xử lý PDF khác (ở tab hoặc thiết bị khác) sau nhiều lần chờ. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển khi lượt đó xong.';
  case 'pdf_local':return `${detail||'Dịch vụ PDF trên máy này chưa chạy.'} Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển khi dịch vụ PDF đã chạy.`;
  case 'schema':return `${detail||'Cơ sở dữ liệu chưa được cập nhật lên phiên bản mới.'} Các trang đã xong trước đó vẫn được giữ; bấm Tiếp tục dịch cả quyển sau khi cơ sở dữ liệu được cập nhật.`;
  case 'gemini_location':return 'Gemini vẫn chưa phục vụ khu vực của máy chủ Hoa Trí sau nhiều lần thử. Khóa của bạn vẫn dùng được và các lần thử này không tốn token. Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển sau ít phút. Nếu lỗi lặp lại, hãy báo quản trị viên.';
  case 'history_full':return `${detail||'Lịch sử dịch của tài khoản đã đầy.'} Tiến độ của quyển đã lưu; dọn bớt xong, bấm Tiếp tục dịch cả quyển.`;
  case 'conflict':return 'Phần đang dịch vừa được lưu từ một tab hoặc thiết bị khác, nên tab này dừng để không ghi đè phần đó. Tiến độ của quyển đã lưu; bấm Tiếp tục dịch cả quyển để mở bản mới nhất và dịch tiếp.';
  case 'network':return 'Mất kết nối tới máy chủ. Tiến độ đã lưu; khi mạng ổn định, bấm Tiếp tục dịch cả quyển.';
  case 'limit':return `${detail||'Đã hết lượt dùng trong ngày.'} Tiến độ đã lưu.`;
  default:return `${detail||'Có lỗi khi dịch.'} Tiến độ đã lưu; bấm Tiếp tục dịch cả quyển để thử lại.`;
 }
}
export function waitMessage(reason,seconds){
 const left=`${seconds} giây`;
 switch(reason){
  case 'quota_minute':return `Gemini đang giới hạn số yêu cầu mỗi phút của khóa này. Tự tiếp tục sau ${left}…`;
  case 'rate_limited':return `Hoa Trí đang giới hạn tốc độ để bảo vệ máy chủ. Tự tiếp tục sau ${left}…`;
  case 'pdf_busy':return `Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Tự thử lại sau ${left}…`;
  case 'pdf_account':return `Tài khoản của bạn đang có một lượt xử lý PDF khác (ở tab hoặc thiết bị khác). Tự thử lại sau ${left}…`;
  case 'pdf_local':return `Dịch vụ PDF trên máy này chưa trả lời (có thể còn đang khởi động). Tự thử lại sau ${left}…`;
  case 'gemini_location':return `Gemini chưa phục vụ khu vực của máy chủ vừa gửi yêu cầu; khóa của bạn vẫn dùng được. Tự thử lại sau ${left}…`;
  case 'network':return `Mất kết nối. Tự thử lại sau ${left}; nếu bạn chuyển sang ứng dụng khác, việc dịch chờ đến khi bạn quay lại tab này.`;
  case 'server':return `Máy chủ gặp lỗi tạm thời. Tự thử lại sau ${left}…`;
  case 'gemini_unavailable':return `Gemini đang quá tải hoặc tạm thời không phản hồi. Tự thử lại sau ${left}…`;
  case 'busy':return `Quyển này đang được dịch ở một thiết bị khác. Đang chờ thiết bị đó dừng; kiểm tra lại sau ${left}…`;
  default:return `Gemini trả kết quả chưa hợp lệ; tự thử lại sau ${left}…`;
 }
}

// ---- History of a job ----
// SQLite's CURRENT_TIMESTAMP is UTC without a zone suffix.
export function parseTime(value){const text=String(value||''),time=Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)?text.replace(' ','T')+'Z':text);return Number.isNaN(time)?null:time;}
// The sessions a job made: the same original, created after the job started, in its book (a chunk joins the book when it
// completes, and a book id the job missed while a request failed still counts).
export function jobSessions(items,job){
 const since=(parseTime(job?.createdAt)??0)-60000;
 return (items||[]).filter(item=>job?.sourceSha256&&item.source_sha256===job.sourceSha256&&(parseTime(item.created_at)??Infinity)>=since&&(!item.library_story_id||!job.storyId||item.library_story_id===job.storyId));
}
// For the history list: each saved session under one run only, the latest of its original started before it.
export function sessionsByJob(items,jobs){
 const groups=new Map((jobs||[]).map(job=>[job.id,[]])),newest=[...(jobs||[])].sort((a,b)=>(parseTime(b.createdAt)??0)-(parseTime(a.createdAt)??0));
 for(const item of items||[]){const job=newest.find(entry=>jobSessions([item],entry).length);if(job)groups.get(job.id).push(item);}
 return groups;
}
// The saved session covering a page: a finished one the job never recorded (the tab closed in between) is only
// recorded; otherwise the unfinished one with the most progress is continued (its OCR and finished batches are paid
// for). A draft left behind by a save sent twice never wins over the session that went on.
export function findChunkSession(items,job,page){
 const rank=item=>item.status==='complete'?2:item.status==='translating'?1:0;
 return jobSessions(items,job).filter(item=>Number.isInteger(item.page_start)&&item.page_start<=page&&page<=(item.page_end??item.page_start))
  .sort((a,b)=>rank(b)-rank(a)||(Number(b.translated_parts)||0)-(Number(a.translated_parts)||0)||(parseTime(b.updated_at)??0)-(parseTime(a.updated_at)??0))[0]||null;
}
// The id a chunk's session is saved under: the same for a job and the chunk's first page on every device and in every
// tab, so a run continued anywhere asks the server for that session by its id (GET history/:id) instead of looking for
// it in a list it loaded earlier (or in the newest 100 sessions the list holds). Shaped as a v4 UUID, as the server takes.
export async function chunkSessionId(jobId,page){
 const hex=await digestHex(new TextEncoder().encode(`hoa-tri-chunk:${jobId}:${page}`));
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${(8|parseInt(hex[16],16)&3).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
// Terms a chunk added or changed; the job merges them into the book's glossary. A rendering that keeps Chinese, or
// repeats its term, is never learned: it would keep that Chinese in every later chunk.
export function glossaryUpdates(known,next){
 const updates={};
 for(const [term,value] of Object.entries(next||{}))if(typeof value==='string'&&value.trim()&&term.length<=100&&value.length<=100&&!['__proto__','constructor','prototype'].includes(term)&&known?.[term]!==value&&!/\p{Script=Han}/u.test(value)&&value.trim()!==term.trim())updates[term]=value;
 return updates;
}

// ---- The original on the device ----
const HAN=/\p{Script=Han}/gu;
// Which pages have a Chinese text layer (translated straight from it) and which need Gemini to read an image, from
// pdf.js's text content and, for a page with a text layer, its list of drawing operations (pdf-client.js readsAsScan:
// a scan under its own OCR text, or under a stamp, is read from its picture). Nothing is drawn, so a 300-page book takes
// seconds to a minute. Blank pages are only known after extraction.
export async function surveyPages(file,{onProgress=()=>{},cancelled=()=>false}={}){
 const {readsAsScan}=await import('./pdf-client.js'),pdf=await openPdf(file),kinds=[];
 try{
  for(let number=1;number<=pdf.numPages&&!cancelled();number++){
   const page=await pdf.getPage(number),content=await page.getTextContent();
   const text=(content.items.map(item=>item.str||'').join('').match(HAN)||[]).length>=12&&!await readsAsScan(page,content.items).catch(()=>false);page.cleanup();
   kinds.push(text?'text':'scan');
   if(number%10===0||number===pdf.numPages)onProgress(kinds.slice(),pdf.numPages);
  }
 }finally{await pdf.loadingTask.destroy();}
 return kinds;
}
export const loadPdfLib=()=>import('/vendor/pdf-lib.esm.min.js');
export async function openSourcePdf(PDFDocument,bytes){
 // Textbooks are often "restricted" (an owner password over an empty user password); pdf-lib opens those with ''.
 try{return await PDFDocument.load(bytes,{password:'',updateMetadata:false,parseSpeed:1500});}
 catch(error){throw new Error(`Không mở được PDF để chia lượt dịch (${String(error?.message||error).slice(0,160)}). Nếu PDF có mật khẩu, hãy mở khóa trước.`);}
}
// pdf-lib copies only what the chosen pages use (their fonts and images), so a chunk stays small even from a 100 MB book.
export async function cutChunk(PDFDocument,source,pages){
 const out=await PDFDocument.create({updateMetadata:false});
 for(const page of await out.copyPages(source,pages.map(number=>number-1)))out.addPage(page);
 return out.save({useObjectStreams:true});
}
// mode: the run's "Cách dịch" (the job's own by default); the Worker passes it on to the PDF service, where Kỹ nhất cuts
// scanned pages into finer OCR sheets.
export function extractForm(bytes,pages,job,mode=job?.mode){
 const form=new FormData();form.set('file',new Blob([bytes],{type:'application/pdf'}),`trang-${pages[0]}-${pages.at(-1)}.pdf`);
 form.set('pages',`1-${pages.length}`);form.set('sourceSha256',job.sourceSha256);form.set('pageOffset',String(pages[0]-1));if(isMode(mode))form.set('mode',mode);
 return form;
}
// SHA-256 names the stored original. crypto.subtle is missing on plain-HTTP origins (a phone on the LAN), so a small
// pure implementation takes over there.
const primes=count=>{const list=[];for(let n=2;list.length<count;n++)if(list.every(p=>n%p))list.push(n);return list;};
const K=Uint32Array.from(primes(64),p=>(Math.cbrt(p)%1)*2**32>>>0),H0=Uint32Array.from(primes(8),p=>(Math.sqrt(p)%1)*2**32>>>0);
export function sha256Hex(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input),h=H0.slice(),w=new Uint32Array(64);
 const block=(data,offset)=>{
  for(let i=0;i<16;i++)w[i]=data[offset+4*i]<<24|data[offset+4*i+1]<<16|data[offset+4*i+2]<<8|data[offset+4*i+3];
  for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=((a>>>7|a<<25)^(a>>>18|a<<14)^a>>>3)+w[i-7]+((b>>>17|b<<15)^(b>>>19|b<<13)^b>>>10)+w[i-16];}
  let [A,B,C,D,E,F,G,X]=h;
  for(let i=0;i<64;i++){const t1=X+((E>>>6|E<<26)^(E>>>11|E<<21)^(E>>>25|E<<7))+(E&F^~E&G)+K[i]+w[i]>>>0,t2=((A>>>2|A<<30)^(A>>>13|A<<19)^(A>>>22|A<<10))+(A&B^A&C^B&C)>>>0;X=G;G=F;F=E;E=D+t1>>>0;D=C;C=B;B=A;A=t1+t2>>>0;}
  h[0]+=A;h[1]+=B;h[2]+=C;h[3]+=D;h[4]+=E;h[5]+=F;h[6]+=G;h[7]+=X;
 };
 const full=bytes.length-bytes.length%64;for(let offset=0;offset<full;offset+=64)block(bytes,offset);
 const tail=new Uint8Array(bytes.length%64<56?64:128),view=new DataView(tail.buffer),bits=bytes.length*8;tail.set(bytes.subarray(full));tail[bytes.length-full]=0x80;
 view.setUint32(tail.length-8,Math.floor(bits/2**32));view.setUint32(tail.length-4,bits>>>0);
 for(let offset=0;offset<tail.length;offset+=64)block(tail,offset);
 return [...h].map(n=>n.toString(16).padStart(8,'0')).join('');
}
export async function digestHex(data){
 if(globalThis.crypto?.subtle)try{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');}catch{}
 return sha256Hex(data instanceof Uint8Array?data:new Uint8Array(data));
}
// The original is streamed from disk (XHR shows upload progress, fetch does not) to the contract's PUT.
export function uploadSource(url,file,{pages,filename='',onProgress=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.withCredentials=true;
  xhr.setRequestHeader('Content-Type','application/pdf');xhr.setRequestHeader('X-PDF-Pages',String(pages));xhr.setRequestHeader('X-Source-Filename',encodeURIComponent([...String(filename)].slice(0,240).join('')));
  xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded/event.total);};
  xhr.onload=()=>{let data=null;try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300&&data)return resolve(data);
   reject(Object.assign(new Error(xhr.status===401?'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi mở lại Xưởng dịch.':data?.error||`Chưa tải được bản gốc lên (mã ${xhr.status}). Hãy thử lại sau ít phút.`),{status:xhr.status,data,retryAfter:Number(xhr.getResponseHeader('Retry-After'))||null}));};
  xhr.onerror=()=>reject(Object.assign(new Error('Mất kết nối khi tải bản gốc lên. Hãy kiểm tra mạng rồi thử lại.'),{status:0}));
  xhr.send(file);
 });
}
// The stored original, for a job continued after a reload or on another device: no need to pick the file again.
export async function downloadSource(sha256,{onProgress=()=>{}}={}){
 const response=await fetch(`/api/my/study/sources/${sha256}`,{credentials:'same-origin'}).catch(()=>{throw Object.assign(new Error('Không kết nối được máy chủ để lấy bản gốc. Hãy kiểm tra mạng rồi thử lại.'),{status:0});});
 if(response.status===404)throw Object.assign(new Error('Tài khoản không còn bản PDF gốc của quyển này. Hãy chọn lại đúng tệp PDF gốc để dịch tiếp.'),{status:404,code:'source_missing'});
 if(!response.ok)throw Object.assign(new Error(`Chưa lấy được bản gốc từ tài khoản (mã ${response.status}). Hãy thử lại sau.`),{status:response.status});
 const total=Number(response.headers.get('Content-Length'))||0,reader=response.body?.getReader?.();if(!reader)return new Uint8Array(await response.arrayBuffer());
 const chunks=[];let received=0;
 for(;;){const {done,value}=await reader.read();if(done)break;chunks.push(value);received+=value.length;if(total)onProgress(Math.min(1,received/total));}
 const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return bytes;
}

// ---- While a book runs ----
// Waits `seconds`, ticking each second; resolves true when the student stopped meanwhile. A retry after a lost connection
// waits while the tab is hidden (a phone may freeze it) and goes at once when the tab is back or the network returns.
export function countdown(seconds,{onTick=()=>{},stopped=()=>false,early=false}={}){
 const doc=globalThis.document;
 return new Promise(resolve=>{
  let left=Math.max(1,Math.ceil(seconds)),timer=0;
  const end=value=>{clearInterval(timer);doc?.removeEventListener?.('visibilitychange',wake);globalThis.removeEventListener?.('online',wake);resolve(value);};
  const wake=()=>{if(doc?.visibilityState!=='hidden')end(false);};
  timer=setInterval(()=>{if(stopped())return end(true);if(early&&doc?.visibilityState==='hidden')return;if(--left<=0)return end(false);onTick(left);},1000);
  onTick(left);if(early){doc?.addEventListener?.('visibilitychange',wake);globalThis.addEventListener?.('online',wake);}
 });
}
// The screen stays on while a book runs; the system drops the lock whenever the tab is hidden, so it is taken again
// when the student comes back.
export function createWakeLock(nav=globalThis.navigator,doc=globalThis.document){
 let sentinel=null,wanted=false;
 const release=()=>{const held=sentinel;sentinel=null;return Promise.resolve(held?.release?.()).catch(()=>{});};
 const acquire=async()=>{
  if(!wanted||sentinel||!nav?.wakeLock?.request||doc?.visibilityState==='hidden')return;
  try{sentinel=await nav.wakeLock.request('screen');sentinel.addEventListener?.('release',()=>{sentinel=null;});if(!wanted)await release();}catch{sentinel=null;}
 };
 doc?.addEventListener?.('visibilitychange',()=>doc.visibilityState==='visible'?acquire():undefined);
 return {supported:Boolean(nav?.wakeLock?.request),get active(){return Boolean(sentinel);},on(){wanted=true;return acquire();},off(){wanted=false;return release();}};
}
// Whether another tab of this browser is running the book (holds its lock): known before anything is downloaded.
export async function jobLockHeld(id,locks=globalThis.navigator?.locks){
 try{return Boolean((await locks?.query?.())?.held?.some(lock=>lock.name===`hoa-tri-book-${id}`));}catch{return false;}
}
// Two tabs of one browser never run the same book (they would extract and pay for the same pages twice).
export async function withJobLock(id,task,locks=globalThis.navigator?.locks){
 if(!locks?.request)return task();
 return locks.request(`hoa-tri-book-${id}`,{ifAvailable:true},lock=>{if(!lock)throw new Error('Quyển này đang được dịch ở một tab khác của trình duyệt. Hãy dùng tab đó, hoặc đóng nó rồi thử lại.');return task();});
}

// ---- Runs, reports and the device ----
// A random v4 UUID: a run's id, a report's id, a chunk session's id. crypto.randomUUID needs a secure context and
// getRandomValues does not (a phone on plain HTTP).
export function newId(){
 const bytes=new Uint8Array(16);
 if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(bytes);else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
 bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;
 const hex=[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
// Token reports the server has not confirmed yet, by job: sent again, under the same ids, with the next report of that
// job, from this run or a later one. The server counts each id once, so a report that did arrive is never added twice.
// storage: localStorage where the browser allows it (a reload keeps them); otherwise they live as long as the page.
const REPORTS='hoa-tri-book-usage:',RUN_ID=/^[A-Za-z\d-]{8,64}$/u,USAGE_KEYS=['prompt','output','thinking','total','requests'];
const validReport=report=>typeof report?.id==='string'&&RUN_ID.test(report.id)&&Boolean(report.usage)&&typeof report.usage==='object'&&!Array.isArray(report.usage);
export function reportStore(storage=null){
 const memory=new Map();
 return {
  load(jobId){
   if(!jobId)return [];let list=memory.get(jobId);
   try{const saved=storage?.getItem(REPORTS+jobId);if(saved!=null)list=JSON.parse(saved);}catch{}
   const ids=new Set();return (Array.isArray(list)?list:[]).filter(report=>validReport(report)&&!ids.has(report.id)&&ids.add(report.id));
  },
  save(jobId,list){
   if(!jobId)return;if(list.length)memory.set(jobId,list);else memory.delete(jobId);
   try{if(list.length)storage?.setItem(REPORTS+jobId,JSON.stringify(list));else storage?.removeItem(REPORTS+jobId);}catch{try{storage?.removeItem(REPORTS+jobId);}catch{}}
  }
 };
}
const sharedReports=reportStore();
// Another run (another device, another browser) holds the job and is still reporting.
export const heldElsewhere=(job,runner)=>Boolean(job?.runner)&&job.runner!==runner&&Number(job.leaseSeconds)>0;
// The server keeps a run's hold for 10 minutes after each report; a long chunk renews it at most once a minute.
export const RENEW_SECONDS=60;
const REPORT_BATCH=20;

// The job keeps a model id only in the server's own Flash pattern; anything else is left out rather than failing a save.
const STUDY_MODEL=/^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-(?:preview(?:-[\d-]+)?|001))?$/u;
export class BookPause extends Error{constructor(reason,message=''){super(message||reason);this.name='BookPause';this.reason=reason;}}
const emptyUsage=()=>({prompt:0,output:0,thinking:0,total:0,requests:0});
// One run over the pending pages of a job. steps (study.js) translate one chunk the way a hand-picked range is:
//  open(job,chunk,{mode}) -> {document}|null  continue the saved session covering chunk.start, if any, what is left of
//                                      it in the run's Cách dịch (mode), whichever it was begun in;
//  start(extractResult,job,{sessionId,mode}) make the new chunk the open session, in the Cách dịch it was extracted for
//                                      (mode), and save it under sessionId, the same id for every retry of that save, so
//                                      a retried save never leaves a second session;
//  translate({shouldStop,renew}) -> {complete,model}  OCR and translate what is left, stopping at a page boundary;
//                                      renew() after each request keeps the job held through a long chunk;
//  finish(job) -> {storyId,glossary,warning}    save the finished part and export its Vietnamese PDF.
// source.cut(pages) returns a chunk's bytes. Every chunk ends with one PATCH: page states, tokens, model, book, glossary.
// The run holds the job under `runner` (one id per browser): the server refuses another device's run meanwhile. Its
// tokens go out as reports with an id each; `reports` keeps those the server did not confirm, for the next PATCH.
// mode: the "Cách dịch" the chunks are extracted, read and translated in (the job's own when missing).
export function createBookRun({api,steps,source,ui={},sleep=countdown,shouldStop=()=>false,maxPages=CHUNK_PAGES,maxBytes=CHUNK_MAX_BYTES,runner=newId(),reports=sharedReports,renewEvery=RENEW_SECONDS*1000,now=()=>Date.now(),random=Math.random,mode=null}){
 let job=null,usage=emptyUsage(),fit=maxPages,probe=maxPages,claimed=false,renewed=0;
 const notify=()=>ui.job?.(job,usage),runMode=()=>isMode(mode)?mode:job.mode;
 const owes=()=>USAGE_KEYS.some(key=>usage[key])||reports.load(job?.id).length>0;
 // Whether the PDF service has a free place for this account, asked while a busy service is waited out (classifyError's
 // capacity): GET pdf-layout/capacity takes no place and counts toward no daily cap. null when it cannot say (an older
 // server, a lost connection): the request is then sent as before. An expired session stops the run.
 async function place(){
  try{const answer=await api('pdf-layout/capacity');return typeof answer?.busy==='boolean'?answer:null;}
  catch(error){if(error?.status===401)throw error;return null;}
 }
 // held: a refusal still standing because the service said it had no free place, so nothing was sent for it again (a
 // chunk can be 16 MB); after: the seconds the service asked to wait before it is asked again. The last try is sent.
 async function retrying(step,task){
  for(let failure=0,held=null,after=0;;failure++){
   let error=held;held=null;
   if(!error)try{return await task();}catch(caught){if(caught instanceof BookPause)throw caught;error=caught;}
   const kind=classifyError(error,step),base=kind.backoff?Math.max(BACKOFF[Math.min(failure,BACKOFF.length-1)],kind.wait||0,after):kind.wait&&Math.max(kind.wait,after);after=0;
   const wait=base&&kind.jitter?Math.round(base*(1+random()/4)):base;
   if(!wait||failure>=(kind.retries||0)||shouldStop())throw error;
   // A long wait (a quota, a lost connection) keeps the job held.
   if(step!=='save')await renew();
   const stopped=await sleep(wait,{onTick:left=>ui.waiting?.(kind.reason,left),stopped:shouldStop,early:kind.early??Boolean(kind.backoff)});
   ui.waiting?.(null,0);if(stopped)throw new BookPause('stopped');
   if(kind.capacity&&failure+1<kind.retries){const free=await place();if(shouldStop())throw new BookPause('stopped');if(free?.busy){held=error;after=Math.min(300,Number(free.retryAfter)||0);}}
  }
 }
 // Tokens recorded since the last report become one report with its own id, kept until the server has confirmed it:
 // a PATCH that fails, or whose answer is lost, leaves it for the next one, which sends it again under the same id.
 // own=false: a report that is not this run's (only tokens, no runner), accepted whoever holds the job.
 async function patch(body,{once=false,own=true}={}){
  if(USAGE_KEYS.some(key=>usage[key])){reports.save(job.id,[...reports.load(job.id),{id:newId(),usage}]);usage=emptyUsage();}
  const send=async()=>{
   const pending=reports.load(job.id).slice(0,REPORT_BATCH);
   const data=await api(`book-jobs/${encodeURIComponent(job.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...(own?{runner}:{}),...(pending.length?{reports:pending}:{})})});
   const sent=new Set(pending.map(report=>report.id));reports.save(job.id,reports.load(job.id).filter(report=>!sent.has(report.id)));
   job=data?.job||data;if(own)renewed=now();notify();return job;
  };
  try{return await (once?send():retrying('save',send));}
  // Refused because another device holds the job: its progress is what this device shows now.
  catch(error){if(error?.data?.job&&classifyError(error).reason==='busy'){job=error.data.job;notify();}throw error;}
 }
 // At most once per renewEvery a bare report renews the hold (and sends the tokens spent so far). A run whose job
 // another device took meanwhile stops; a renewal that fails otherwise is simply tried again later.
 async function renew(){
  if(!claimed||now()-renewed<renewEvery)return;
  try{await patch({},{once:true});}
  catch(error){if(classifyError(error).reason==='busy')throw Object.assign(new BookPause('busy',error.message),{data:error.data});}
 }
 const smaller=pages=>{probe=Math.max(1,Math.ceil(pages.length/2));return pages.slice(0,probe);};
 async function fail(page,message){probe=maxPages;await patch({pages:{[page]:'failed'}});ui.warn?.(message);return null;}
 // The extractor's notes on pages it leaves with Chinese, kept with the book's notes ("dịch tiếp ở lượt sau" is what the
 // run does by itself).
 const warnNotes=notes=>{for(const note of Array.isArray(notes)?notes:[])if(typeof note==='string'&&note.trim()&&!/^Lượt này xử lý \d+\/\d+ trang/u.test(note))ui.warn?.(note);};
 async function extract(chunk){
  // heavy: this chunk was halved because a job ran out of time, memory or room; the size that then worked is kept.
  let pages=chunk.pages,heavy=false;
  for(;;){
   const bytes=await source.cut(pages);
   if(bytes.byteLength>maxBytes){
    if(pages.length>1){pages=pages.slice(0,Math.max(1,Math.min(pages.length-1,Math.floor(pages.length*maxBytes/bytes.byteLength))));continue;}
    return fail(pages[0],`Trang ${pages[0]} nặng ${(bytes.byteLength/1048576).toFixed(1).replace('.',',')} MB, vượt giới hạn một lượt của dịch vụ PDF; trang này giữ nguyên bản gốc.`);
   }
   let result;
   try{result=await retrying('extract',()=>api('pdf-layout/extract',{method:'POST',body:extractForm(bytes,pages,job,runMode())}));}
   catch(error){
    const kind=classifyError(error,'extract'),{reason}=kind;
    if(reason==='no_blocks'){
     // The server names the pages it read (fewer than were sent: the service's size budget stopped it) and those still
     // showing Chinese outside every block, which are named with the extractor's notes instead of called blank.
     probe=maxPages;const read=Array.isArray(error.data?.pages)?error.data.pages.filter(page=>pages.includes(page)):[];if(read.length&&read.length<pages.length)fit=read.length;
     const left=new Set(Array.isArray(error.data?.untranslated)?error.data.untranslated.filter(page=>pages.includes(page)):[]);
     await patch({pages:{...statesFor((read.length?read:pages).filter(page=>!left.has(page)),'blank'),...statesFor(left,'untranslated')}});
     if(left.size)warnNotes(error.data?.warnings);return null;
    }
    if(reason==='too_large'||reason==='page'){if(pages.length>1){heavy||=Boolean(kind.heavy);pages=smaller(pages);continue;}return fail(pages[0],/^Trang \d+/u.test(error.message)?error.message:`Trang ${pages[0]}: ${error.message}`);}
    throw error;
   }
   probe=maxPages;if(heavy)fit=Math.min(fit,pages.length);const found=chunkPages(result.document);
   // The service stops early when a selection's images do not fit one run; later chunks are cut to what fitted.
   if(found.processed&&found.processed<pages.length)fit=found.processed;
   if(!found.done.length){await patch({pages:{...statesFor(found.processed?found.blank:pages,'blank'),...statesFor(found.untranslated,'untranslated')}});if(found.untranslated.length)warnNotes(result.document?.warnings);return null;}
   return result;
  }
 }
 // pages: what the run changes first (failed pages tried again, an edited range), sent with the claim itself.
 async function run(start,{pages=null}={}){
  job=start;fit=probe=maxPages;claimed=false;
  try{
   // The run takes the job before anything else: another device's run stops it here, before anything is paid for.
   await patch({status:'running',pauseReason:null,...(pages&&Object.keys(pages).length?{pages}:{})});claimed=true;
   for(;;){
    if(shouldStop())throw new BookPause('stopped');
    const chunk=nextChunk(job.pageStates,Math.min(maxPages,fit,probe));if(!chunk)break;
    ui.chunk?.(chunk);await renew();
    let document=(await retrying('open',()=>steps.open(job,chunk,{mode:runMode()})))?.document;
    if(!document){
     const result=await extract(chunk);if(!result)continue;
     // One session id for this chunk, however often its first save is tried, and the one open() asks for next time.
     const sessionId=await chunkSessionId(job.id,chunk.start);document=result.document;await renew();
     try{await retrying('save',()=>steps.start(result,job,{sessionId,mode:runMode()}));}
     catch(error){
      // More blocks than one save takes (pages full of table cells): the chunk is extracted again, half as long.
      if(classifyError(error,'save').reason!=='too_many_parts')throw error;
      const pages=chunkPages(result.document).processed||chunk.pages.length;
      if(pages<=1){await fail(chunk.start,/^Trang \d+/u.test(error.message)?error.message:`Trang ${chunk.start}: ${error.message}`);continue;}
      fit=Math.max(1,Math.floor(pages/2));continue;
     }
    }
    const found=chunkPages(document);ui.chunk?.({...chunk,pages:found.done.concat(found.blank,found.untranslated).sort((a,b)=>a-b)},document);
    await renew();const outcome=await retrying('translate',()=>steps.translate({shouldStop,renew}));
    if(!outcome?.complete)throw new BookPause('stopped');
    await renew();const finished=await retrying('export',()=>steps.finish(job))||{};if(finished.warning)ui.warn?.(finished.warning);
    const learned=glossaryUpdates(job.glossary,finished.glossary);
    await patch({pages:{...statesFor(found.done,'done'),...statesFor(found.blank,'blank'),...statesFor(found.untranslated,'untranslated')},...(STUDY_MODEL.test(outcome.model||'')?{model:outcome.model}:{}),...(finished.storyId&&finished.storyId!==job.storyId?{storyId:finished.storyId}:{}),...(Object.keys(learned).length?{glossary:learned}:{})});
   }
   await patch({status:'done',pauseReason:null});
   return {status:'done',job};
  }catch(error){
   const reason=error instanceof BookPause?error.reason:classifyError(error).reason;
   // Another device holds the job: its state is that run's to report; only the tokens this run spent are sent.
   if(reason==='busy'){if(owes())await patch({},{once:true,own:false}).catch(()=>{});}
   else await patch({status:'paused',pauseReason:reason},{once:true}).catch(()=>{});
   return {status:'paused',reason,message:pauseMessage(reason,error),error,job};
  }finally{ui.chunk?.(null);}
 }
 return {run,recordUsage(value){for(const key of Object.keys(usage))usage[key]+=Number(value?.[key])||0;if(job)notify();},get job(){return job;},runner,
  // Tokens spent and not yet in job.usage: recorded since the last report, and reports not confirmed yet.
  get usage(){const total={...usage};for(const report of reports.load(job?.id))for(const key of USAGE_KEYS)total[key]+=Number(report.usage[key])||0;return total;}};
}

// ---- Panel pieces (browser) ----
// Cells are reused, so a 500-page grid redraws in place after every chunk. noPdf: translated pages of parts whose
// Vietnamese PDF is missing.
export function renderPageGrid(root,states,working=null,noPdf=null){
 const text=String(states||''),cells=root.children;
 while(cells.length<text.length){const cell=root.ownerDocument.createElement('span');cell.className='page-cell';root.append(cell);}
 while(cells.length>text.length)root.lastElementChild.remove();
 for(let i=0;i<text.length;i++){const name=NAMES[text[i]]||'pending',state=name==='pending'&&working?.has(i+1)?'working':name==='done'&&noPdf?.has(i+1)?'nopdf':name,cell=cells[i];if(cell.dataset.state!==state){cell.dataset.state=state;cell.title=`Trang ${i+1} · ${PAGE_LABELS[state]}`;}}
 const count=countStates(text),missing=[...noPdf||[]].filter(page=>text[page-1]==='d').length,parts=[`${count.done} trang đã dịch`,`${count.pending} trang chưa dịch`];
 if(working?.size)parts.unshift(`đang dịch trang ${pageList([...working])}`);if(missing)parts.push(`${missing} trang chưa có PDF tiếng Việt`);if(count.blank)parts.push(`${count.blank} trang trống`);if(count.untranslated)parts.push(`${count.untranslated} trang còn chữ chưa dịch`);if(count.cover)parts.push('bìa');if(count.skipped)parts.push(`${count.skipped} trang bỏ qua`);if(count.failed)parts.push(`${count.failed} trang lỗi`);
 root.setAttribute('aria-label',`Tiến độ ${count.total} trang: ${parts.join(', ')}.`);
}
