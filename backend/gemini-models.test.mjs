import test from 'node:test';
import assert from 'node:assert/strict';
import {isStudyModel,listStudyModels,selectStudyModel} from './gemini-models.js';
import {studyRoute} from './study-translation.js';
import {generate} from './ai.js';

const studentKey='student-private-key-long-enough';
const serverKey='server-private-key-never-use';
const catalogModel=(id,methods=['generateContent'])=>({name:`models/${id}`,displayName:id,supportedGenerationMethods:methods});
const modelIds=ids=>ids.map(id=>({id,name:id}));
const gemini=value=>Response.json({usageMetadata:{promptTokenCount:20,candidatesTokenCount:10,totalTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
const translatedBlocks={blocks:[{id:'p4-b0',translation:'Vectơ trong không gian.'}],contextUpdate:'',glossaryUpdates:{}};
const blocks=[{id:'p4-b0',source:'空间向量。'}];
function environment(overrides={}){
 return {GEMINI_API_KEY:serverKey,GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PDF_BLOCK_MODEL:'gemini-2.5-flash',DB:{prepare(){return {bind(){return this;},async first(){return {id:'student-1'};}};}},FILES:{async get(){throw new Error('Student keys and text must not use persistent AI storage');},async put(){throw new Error('Student keys and text must not use persistent AI storage');}},...overrides};
}
async function route(path,body,env=environment(),method='POST',authenticated=true){
 const url=new URL(`https://example.test/api/my/study/${path}`),request=new Request(url,{method,headers:{...(authenticated?{Cookie:'cat_hien_session=test-session'}:{}),Origin:url.origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return studyRoute(request,env,url,url.pathname);
}

test('Model discovery paginates with the tab key in headers and returns only supported text Flash models',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{
  const url=new URL(endpoint);calls.push({url,options});
  return Response.json(calls.length===1?{models:[catalogModel('gemini-3.6-flash'),catalogModel('gemini-3.8-pro'),catalogModel('gemini-3.1-flash-image'),catalogModel('gemini-2.5-flash-preview-tts'),catalogModel('gemini-2.5-flash-live'),catalogModel('gemini-3.6-flash-lite',['embedContent'])],nextPageToken:'second/page token'}:{models:[catalogModel('gemini-3.8-flash'),catalogModel('gemini-3.6-flash-lite'),catalogModel('gemini-3.6-flash'),catalogModel('gemini-embedding-001'),catalogModel('gemini-2.5-flash-native-audio-preview')]});
 });
 const models=await listStudyModels(studentKey);
 assert.deepEqual(models.map(m=>m.id),['gemini-3.6-flash','gemini-3.6-flash-lite','gemini-3.8-flash']);
 assert.equal(calls.length,2);assert.equal(calls[0].url.searchParams.get('pageSize'),'1000');assert.equal(calls[1].url.searchParams.get('pageToken'),'second/page token');
 for(const {url,options} of calls){assert.equal(options.headers['x-goog-api-key'],studentKey);assert.equal(url.origin,'https://generativelanguage.googleapis.com');assert.equal(url.searchParams.get('key'),null);assert.doesNotMatch(url.href,/student-private/);}
 assert.doesNotMatch(JSON.stringify(models),/student-private|server-private/);
});

test('Model discovery rejects invalid keys before making any request',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Must not fetch');});
 for(const invalid of ['',null,'short','a'.repeat(501),studentKey+'\n',studentKey+'\0'])await assert.rejects(()=>listStudyModels(invalid),/Khóa Gemini API không hợp lệ/);
 assert.equal(calls,0);
});

test('Model filter excludes specialised and more expensive model families',()=>{
 for(const id of ['gemini-3.6-flash','gemini-3.1-flash-lite','gemini-2.5-flash-001','gemini-3.8-flash-preview','gemini-2.5-flash-preview-05-20'])assert.equal(isStudyModel(id),true,id);
 for(const id of ['gemini-3.8-pro','gemini-3.1-flash-image','gemini-2.5-flash-preview-tts','gemini-2.5-flash-live','gemini-2.5-flash-native-audio-preview','gemini-embedding-001','models/gemini-3.6-flash','https://example.test','gemini-3.6-flash\n'])assert.equal(isStudyModel(id),false,id);
});

test('Model selection preserves an available request, then prefers the main model within its cost class',()=>{
 const models=modelIds(['gemini-2.5-flash','gemini-3.6-flash','gemini-3.6-flash-lite','gemini-3.8-flash']);
 assert.equal(selectStudyModel(models,'gemini-2.5-flash','gemini-3.6-flash'),'gemini-2.5-flash');
 assert.equal(selectStudyModel(models,'gemini-3.1-flash','gemini-3.6-flash'),'gemini-3.6-flash');
 assert.equal(selectStudyModel(models,'gemini-2.5-flash-lite','gemini-3.6-flash'),'gemini-3.6-flash-lite');
 assert.equal(selectStudyModel(modelIds(['gemini-3.6-flash','gemini-3.8-flash']),'gemini-2.5-flash-lite','gemini-3.6-flash'),null);
 assert.equal(selectStudyModel(modelIds(['gemini-3.6-flash-lite']),'gemini-2.5-flash','gemini-3.6-flash'),null);
});

test('Authenticated config diagnostics expose the actual PDF override and no credentials',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Config must be local');});
 const response=await route('config',null,environment(),'GET'),data=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal(data.economy,'gemini-3.6-flash');assert.equal(data.pdf,'gemini-2.5-flash');assert.match(data.runtimeVersion,/key-model-selection/);
 assert.doesNotMatch(JSON.stringify(data),/private-key/);assert.equal(calls,0);
 assert.equal((await route('config',null,environment(),'GET',false)).status,401);
});

test('Student model discovery uses the tab key and diagnoses a stale PDF model before selecting the main model',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{calls.push({endpoint,options});return Response.json({models:[catalogModel('gemini-3.6-flash'),catalogModel('gemini-3.8-flash')]});});
 const response=await route('models',{apiKey:studentKey,purpose:'pdf',mode:'economy'}),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.requested,'gemini-2.5-flash');assert.equal(data.selected,'gemini-3.6-flash');
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers['x-goog-api-key'],studentKey);assert.doesNotMatch(JSON.stringify(data),/private-key/);
});

test('Student model discovery stops on bad credentials without attempting generation',async t=>{
 const endpoints=[];t.mock.method(globalThis,'fetch',async(endpoint)=>{endpoints.push(String(endpoint));return Response.json({error:{message:'Private diagnostic must not be exposed'}},{status:403});});
 await assert.rejects(()=>route('models',{apiKey:studentKey,purpose:'pdf'}),error=>error.code==='gemini_key'&&error.status===403&&/\(403\): khóa Gemini API đang bị chặn/u.test(error.message)&&!/Private diagnostic/u.test(error.message));
 assert.equal(endpoints.length,1);assert.doesNotMatch(endpoints[0],/generateContent/);
});

test('An explicit supported tab model bypasses a stale PDF override and preserves the actual response model',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{calls.push({endpoint,options});return gemini(translatedBlocks);});
 const response=await route('translate-blocks',{apiKey:studentKey,model:'gemini-3.6-flash',mode:'economy',blocks}),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.model,'gemini-3.6-flash');assert.deepEqual(data.blocks,translatedBlocks.blocks);
 assert.equal(calls.length,1);assert.match(calls[0].endpoint,/\/models\/gemini-3\.6-flash:generateContent$/);assert.equal(calls[0].options.headers['x-goog-api-key'],studentKey);
 assert.deepEqual(JSON.parse(calls[0].options.body).generationConfig.thinkingConfig,{thinkingLevel:'minimal'});assert.doesNotMatch(JSON.stringify(data),/private-key/);
});

test('Invalid or expensive tab model overrides fail before generation',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('No generation allowed');});
 for(const model of ['gemini-3.8-pro','gemini-3.1-flash-image','arbitrary/model'])await assert.rejects(()=>route('translate-blocks',{apiKey:studentKey,model,blocks}),/model Gemini Flash/);
 assert.equal(calls,0);
});

test('404 recovery excludes already rejected models and reports the successful PDF model',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{
  const url=new URL(endpoint);calls.push({url,options});
  if(url.pathname==='/v1beta/models')return Response.json({models:[catalogModel('gemini-2.5-flash'),catalogModel('gemini-3.6-flash'),catalogModel('gemini-3.8-flash'),catalogModel('gemini-3.8-pro')]});
  if(!url.pathname.includes('gemini-3.8-flash'))return Response.json({error:{message:'not available'}},{status:404});
  return gemini(translatedBlocks);
 });
 const response=await route('translate-blocks',{apiKey:studentKey,blocks}),data=await response.json(),generation=calls.filter(c=>c.url.pathname.endsWith(':generateContent'));
 assert.equal(response.status,200);assert.equal(data.model,'gemini-3.8-flash');assert.equal(data.usage.requests,1);assert.deepEqual(data.blocks,translatedBlocks.blocks);
 assert.deepEqual(generation.map(c=>c.url.pathname),['/v1beta/models/gemini-2.5-flash:generateContent','/v1beta/models/gemini-3.6-flash:generateContent','/v1beta/models/gemini-3.8-flash:generateContent']);
 assert.equal(calls.filter(c=>c.url.pathname==='/v1beta/models').length,2);
 for(const call of calls)assert.equal(call.options.headers['x-goog-api-key'],studentKey);
 assert.doesNotMatch(JSON.stringify(data),/private-key/);
});

test('404 recovery never upgrades a lite request to regular Flash or Pro',async t=>{
 const endpoints=[];t.mock.method(globalThis,'fetch',async(endpoint)=>{const url=new URL(endpoint);endpoints.push(url.pathname);return url.pathname==='/v1beta/models'?Response.json({models:[catalogModel('gemini-3.6-flash'),catalogModel('gemini-3.8-pro')]}):Response.json({error:{message:'not found'}},{status:404});});
 await assert.rejects(()=>route('translate-blocks',{apiKey:studentKey,model:'gemini-2.5-flash-lite',blocks}),/không khả dụng/);
 assert.deepEqual(endpoints,['/v1beta/models/gemini-2.5-flash-lite:generateContent','/v1beta/models']);
});

test('A version the key cannot use names the real control in Xưởng dịch; the admin pipeline is pointed to its own setting',async t=>{
 const html=(await import('node:fs')).readFileSync(new URL('../frontend/study.html',import.meta.url),'utf8');
 const control=html.match(/<button id="check-gemini-model"[^>]*>([^<]+)<\/button>/u)?.[1],advanced=html.match(/<summary>(Nâng cao)\b/u)?.[1];
 assert.equal(control,'Kiểm tra phiên bản dùng được với khóa');assert.equal(advanced,'Nâng cao');
 t.mock.method(globalThis,'fetch',async endpoint=>new URL(endpoint).pathname==='/v1beta/models'?Response.json({models:[]}):Response.json({error:{message:'not found'}},{status:404}));
 let error=null;try{await (await route('translate-blocks',{apiKey:studentKey,model:'gemini-2.5-flash-lite',blocks}));}catch(caught){error=caught;}
 assert.equal(error?.code,'gemini_model');assert.ok(error.message.includes(`“${advanced}”`)&&error.message.includes(`“${control}”`),error.message);
 assert.doesNotMatch(error.message,/Kiểm tra model của khóa|Gemini từ chối|Khóa Gemini/u);
 await assert.rejects(()=>generate({GEMINI_API_KEY:serverKey,GEMINI_MODEL:'gemini-2.5-flash'},[{text:'data'}],'Translate'),error=>error.code==='gemini_model'&&/GEMINI_MODEL/u.test(error.message)&&!error.message.includes(control));
});

test('Generation authentication errors do not trigger model discovery or any retry',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint)=>{calls.push(String(endpoint));return Response.json({error:{message:'secret details'}},{status:401});});
 await assert.rejects(()=>generate({GEMINI_API_KEY:studentKey,GEMINI_MODEL:'gemini-2.5-flash',GEMINI_MODEL_RECOVERY:true},[{text:'data'}],'Translate'),/Gemini từ chối yêu cầu \(401\)/);
 assert.equal(calls.length,1);assert.match(calls[0],/:generateContent$/);
});
