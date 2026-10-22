// Whether a failed request means the student's Gemini key has to change. Only the code gemini_key says so
// (backend/gemini-errors.js); a refusal of the text, a quota, an overloaded Gemini or the place the server called from
// never does, whatever the wording. Without a code (a server older than these codes), the key's own messages count.
export function keyRefused(error){
 const code=String(error?.data?.code||error?.code||''),message=String(error?.message||'');
 return code==='gemini_key'||!code&&/Gemini từ chối yêu cầu \(40[13]\)|^Khóa Gemini API không hợp lệ|Khóa hoặc model Gemini/u.test(message);
}
