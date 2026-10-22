import {UserError} from './http.js';

// The codes a failed Gemini call reaches the browser with ({error, code, retryAfter?, usage?}). Only gemini_key means the
// student's key (or its project) must change; the browser may forget the key for that one and for no other.
//   gemini_key          400/403  key invalid, expired, blocked, suspended, leaked, not allowed to use the API, or its
//                                project needs Billing to use Gemini from here
//   gemini_location     503      Google does not serve the place Hoa Trí's server called from; the key is fine.
//                                retryAfter: another attempt may run from another location
//   quota_minute        429      per-minute quota of the key; retryAfter
//   quota_day           429      daily quota of the key; retryAfter (until Google's reset)
//   quota               429      other quota; retryAfter when Google gives one
//   gemini_unavailable  503      Gemini overloaded or out of reach after the server's own retries; retryAfter
//   gemini_refused      400      Gemini would not answer for this text (safety, recitation of copyrighted text…)
//   gemini_truncated    400      the answer hit the output limit (text translation splits and retries by itself)
//   gemini_malformed    400      the answer stayed unreadable after three attempts, or came back empty
//   gemini_request      400      Gemini refused the request itself as invalid or too large
//   gemini_model        400      the chosen model is not available to this key
//   gemini_error        400      any other answer from Gemini
export const GEMINI_ERROR_CODES=Object.freeze(['gemini_key','gemini_location','quota_minute','quota_day','quota','gemini_unavailable','gemini_refused','gemini_truncated','gemini_malformed','gemini_request','gemini_model','gemini_error']);
// Messages never contain "Gemini từ chối" or "Khóa Gemini" unless they are about the key: browsers released before
// these codes forget the key on those words.
export const LOCATION_MESSAGE='Gemini chưa phục vụ khu vực của máy chủ Hoa Trí vừa gửi yêu cầu, nên lượt dịch này chưa chạy và không tốn token. Khóa của bạn vẫn dùng được, không cần nhập lại; hãy thử lại sau ít phút. Nếu lỗi lặp lại, hãy báo quản trị viên.';
export const LOCATION_WAIT=60;
// "User location is not supported for the API use." A variant that asks for a billing account is the key's project to fix.
const location=error=>{const message=String(error.message||'');return /location is not supported|not (?:available|supported) in your (?:country|region|location)/iu.test(message)&&!/billing/iu.test(message);};
// 401/403 and an invalid, expired, blocked or Billing-less key or project are the student's to fix: code gemini_key. Google's
// own text is never shown: some of it quotes the key. Any other 400 is about the request, not the key.
export async function geminiRejection(response){
 const body=await response.clone().json().catch(()=>null),error=body?.error||{},status=response.status,prefix=`Gemini từ chối yêu cầu (${status})`;
 const reasons=(Array.isArray(error.details)?error.details:[]).map(detail=>String(detail?.reason||'')).join(' ');
 if(location(error))return new UserError(LOCATION_MESSAGE,503,'gemini_location',{retryAfter:LOCATION_WAIT});
 if(status===403||/BLOCKED|SUSPENDED|SERVICE_DISABLED|LEAKED|DENIED/u.test(reasons))return new UserError(`${prefix}: khóa Gemini API đang bị chặn, bị tạm ngưng hoặc chưa được phép dùng Gemini API. Hãy kiểm tra khóa và dự án trong Google AI Studio.`,403,'gemini_key');
 if(error.status==='FAILED_PRECONDITION')return new UserError(`${prefix}: dự án của khóa này chưa dùng được Gemini API khi chưa bật Billing. Hãy kiểm tra trong Google AI Studio.`,403,'gemini_key');
 if(status===401||/API_KEY/u.test(reasons)||/api[ _-]?key/iu.test(String(error.message||'')))return new UserError(`${prefix}: khóa Gemini API không hợp lệ hoặc đã hết hạn. Hãy kiểm tra lại khóa trong Google AI Studio.`,400,'gemini_key');
 return new UserError(`Gemini không nhận yêu cầu này (${status}): dữ liệu gửi đi không hợp lệ hoặc quá lớn. Hãy thử lại với phần ngắn hơn.`,400,'gemini_request');
}
