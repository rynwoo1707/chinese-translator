// The sample tool never spends Gemini (or any other paid API) tokens: translations come from texts.json. Every fetch of
// this process goes through this guard, which only lets requests reach the publish target, and the Gemini key is
// dropped from the environment so no imported module can find it.
const PAID=/(^|\.)googleapis\.com$|(^|\.)generativelanguage\.|(^|\.)anthropic\.com$|(^|\.)openai\.com$/iu;
export const isPaidHost=hostname=>PAID.test(String(hostname||''));
const urlOf=input=>new URL(typeof input==='string'||input instanceof URL?input:input?.url);
export function installNetworkGuard({allow=[]}={}){
 for(const key of Object.keys(process.env))if(/^GEMINI_/u.test(key))delete process.env[key];
 const allowed=new Set(allow.map(origin=>new URL(origin).origin)),original=globalThis.fetch;
 const guarded=async(input,init)=>{
  const url=urlOf(input);
  if(isPaidHost(url.hostname)||!allowed.has(url.origin))throw new Error(`Công cụ ví dụ mẫu không gọi API trả phí hay máy chủ ngoài địa chỉ đăng (${url.host}).`);
  return original(input,init);
 };
 globalThis.fetch=guarded;
 return ()=>{if(globalThis.fetch===guarded)globalThis.fetch=original;};
}
