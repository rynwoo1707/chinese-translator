const CONFIG_KEY='private/config/gemini-api-key.json';
const encoder=new TextEncoder(),decoder=new TextDecoder();

function encodeBase64(bytes){
 let value='';
 for(let offset=0;offset<bytes.length;offset+=8192)value+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
 return btoa(value);
}
function decodeBase64(value){return Uint8Array.from(atob(value),character=>character.charCodeAt(0));}
async function encryptionKey(env,usage){
 if(!env.ADMIN_TOKEN)throw new Error('Cần cấu hình ADMIN_TOKEN trước khi lưu khóa API.');
 const digest=await crypto.subtle.digest('SHA-256',encoder.encode(env.ADMIN_TOKEN));
 return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,[usage]);
}
async function storedConfig(env){
 if(!env.FILES?.get)return null;
 const object=await env.FILES.get(CONFIG_KEY);
 if(!object)return null;
 try{return await object.json();}catch{throw new Error('Không đọc được cấu hình khóa API đã lưu.');}
}

export async function saveGeminiApiKey(env,value){
 const apiKey=String(value||'').trim();
 if(apiKey.length<20||apiKey.length>500||/[\r\n\0]/.test(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
 if(!env.FILES?.put)throw new Error('Kho FILES chưa được cấu hình để lưu khóa API.');
 const iv=crypto.getRandomValues(new Uint8Array(12)),key=await encryptionKey(env,'encrypt');
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(CONFIG_KEY)},key,encoder.encode(apiKey)));
 const updatedAt=new Date().toISOString();
 await env.FILES.put(CONFIG_KEY,JSON.stringify({version:1,iv:encodeBase64(iv),ciphertext:encodeBase64(encrypted),updatedAt}),{httpMetadata:{contentType:'application/json'}});
 return {configured:true,source:'dashboard',updatedAt};
}

export async function clearGeminiApiKey(env){
 if(!env.FILES?.delete)throw new Error('Kho FILES chưa được cấu hình để xóa khóa API.');
 await env.FILES.delete(CONFIG_KEY);
 return geminiKeyStatus(env);
}

export async function runtimeGeminiApiKey(env){
 const config=await storedConfig(env);
 if(!config)return String(env.GEMINI_API_KEY||'').trim();
 try{
  const key=await encryptionKey(env,'decrypt');
  const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(config.iv),additionalData:encoder.encode(CONFIG_KEY)},key,decodeBase64(config.ciphertext));
  return decoder.decode(decrypted).trim();
 }catch{throw new Error('Không giải mã được khóa API đã lưu. Hãy nhập lại khóa trong Cài đặt.');}
}

export async function geminiKeyStatus(env){
 const config=await storedConfig(env);
 if(config)return {configured:true,source:'dashboard',updatedAt:config.updatedAt||null};
 return {configured:!!String(env.GEMINI_API_KEY||'').trim(),source:'environment',updatedAt:null};
}

export async function withRuntimeGeminiKey(env){
 const apiKey=await runtimeGeminiApiKey(env);
 return new Proxy(env,{get(target,property){return property==='GEMINI_API_KEY'?apiKey:Reflect.get(target,property);}});
}

export const runtimeConfigInternals={CONFIG_KEY};
