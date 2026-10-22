// Metadata only; keys are sent as headers and are never cached or returned.
import {geminiRejection} from './gemini-errors.js';
import {UserError} from './http.js';
export const isStudyModel=id=>typeof id==='string'&&/^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-(?:preview(?:-[\d-]+)?|001))?$/u.test(id);
export async function listStudyModels(apiKey){
 if(typeof apiKey!=='string'||apiKey.length<20||apiKey.length>500||/[\r\n\0]/u.test(apiKey))throw new Error('Khóa Gemini API không hợp lệ.');
 const models=new Map();let token='';
 for(let i=0;i<5;i++){
  const url=new URL('https://generativelanguage.googleapis.com/v1beta/models');url.searchParams.set('pageSize','1000');if(token)url.searchParams.set('pageToken',token);
  const response=await fetch(url,{headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(20000)});
  // The same codes as a translation (gemini-errors.js): a region Google does not serve is not the key's fault.
  if([400,401,403].includes(response.status)){const error=await geminiRejection(response);throw error.code==='gemini_request'?new UserError(`Gemini không trả danh sách model cho khóa này (${response.status}). Hãy thử lại sau ít phút.`,400,'gemini_error'):error;}
  if(!response.ok)throw new Error(`Không lấy được danh sách model Gemini (${response.status}). Hãy thử lại sau.`);
  const result=await response.json();
  for(const m of result.models||[]){const id=String(m.name||'').replace(/^models\//u,'');if(isStudyModel(id)&&m.supportedGenerationMethods?.includes('generateContent'))models.set(id,{id,name:String(m.displayName||id)});}
  token=result.nextPageToken||'';if(!token)break;
 }
 return [...models.values()].sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
}
export function selectStudyModel(models,requested,preferred='gemini-3.6-flash'){
 const ids=models.map(m=>m.id);if(ids.includes(requested))return requested;
 const lite=String(requested).includes('-lite'),sameTier=ids.filter(id=>id.includes('-lite')===lite);
 if(sameTier.includes(preferred))return preferred;
 const stable=sameTier.filter(id=>!id.includes('preview')&&!/^gemini-[12](?:\.|-)/u.test(id));
 return stable.at(-1)||sameTier.filter(id=>!id.includes('preview')).at(-1)||sameTier.at(-1)||null;
}
