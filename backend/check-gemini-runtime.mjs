// Checks the running server's Gemini settings from this machine. It reads ADMIN_TOKEN from .dev.vars and sends it as a
// Bearer token, the credential of command-line tools; people sign in to /admin with an admin account instead.
import {readFile} from 'node:fs/promises';
import {translatePdfBlocks} from './pdf-block-translation.js';
const text=await readFile(new URL('../.dev.vars',import.meta.url),'utf8');
const setting=name=>[...text.matchAll(new RegExp(`^${name}=([^\\r\\n]*)`,'gm'))].at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';
const origin=process.argv.find(arg=>/^https?:\/\//u.test(arg))||'http://127.0.0.1:8787';
const response=await fetch(origin+'/api/status',{headers:{Authorization:`Bearer ${setting('ADMIN_TOKEN')}`},signal:AbortSignal.timeout(10000)}),status=await response.json();
console.log(JSON.stringify({origin,status:response.status,model:status.model,pdfModel:status.pdfModel,authenticated:status.authenticated,aiConfigured:status.aiConfigured,apiKeySource:status.apiKeySource}));
if(process.argv.includes('--models')){
 const dashboard=await fetch(origin+'/api/settings/gemini-models',{headers:{Authorization:`Bearer ${setting('ADMIN_TOKEN')}`},signal:AbortSignal.timeout(30000)}),available=await dashboard.json();
 console.log(JSON.stringify({dashboardCatalogStatus:dashboard.status,models:(available.models||[]).map(m=>m.id),error:available.error}));
 // No process.exit() here: on Node 24 for Windows, exiting right after fetch() can abort with a libuv assertion.
 const key=setting('GEMINI_API_KEY');
 if(!key)console.log('No environment key available for metadata check.');
 else{
  const catalog=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',{headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(15000)}),result=await catalog.json();
  console.log(JSON.stringify({catalogStatus:catalog.status,models:(result.models||[]).filter(m=>m.supportedGenerationMethods?.includes('generateContent')&&/^models\/gemini-[\d.]+-flash(?:-lite)?$/u.test(m.name)).map(m=>m.name)}));
 }
}
if(process.argv.includes('--translate')){
 const key=setting('GEMINI_API_KEY');if(!key)throw new Error('Không có khóa môi trường để kiểm tra lượt dịch nhỏ.');
 const model=setting('GEMINI_MODEL'),result=await translatePdfBlocks({GEMINI_API_KEY:key,GEMINI_MODEL:model,GEMINI_THINKING:'minimal'},{domain:'math',blocks:[{id:'p1-b1',source:'两个空间向量的方向相同，长度相等。'}]});
 console.log(JSON.stringify({liveTranslationModel:result.model,blocks:result.blocks,totalTokens:result.usage?.total}));
}
