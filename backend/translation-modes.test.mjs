import test from 'node:test';
import assert from 'node:assert/strict';
import {MODES,DEFAULT_MODE,ADMIN_DEFAULT_MODE,isMode,modeProfile,modeLabel} from '../frontend/translation-modes.js';
import {OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {generate,thinkingConfigFor,thinkingHeadroom} from './ai.js';
import {studyRoute,studyModelConfig} from './study-translation.js';

// "Cách dịch": the profiles shared by the browser, the Worker routes and the admin pipeline, the thinking levels they name
// (backend/ai.js) and how the study routes apply them. No test here reaches Gemini: every call goes to a fake fetch.
const LEVELS=['minimal','low','medium','high'];
const KEYS=['id','label','hint','translateThinking','ocrThinking','retryThinking','allowRepair','strict','reread','layoutBatch','ocrBatch','sheets','textOcr','textChunk','estimate'];
const KEY='student-key-long-enough-0123';
const levelsOf=profile=>[profile.translateThinking,profile.ocrThinking,profile.retryThinking,...(profile.reread?[profile.reread.thinking]:[])];
const reply=value=>Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
const studyEnv=(extra={})=>({DB:{prepare(){return {bind(){return this;},async first(){return {id:'student',name:'Lan'};}};}},FILES:{async get(){throw new Error('Student text must not reach R2');},async put(){throw new Error('Student text must not reach R2');}},...extra});
function call(path,{method='POST',body,form,env=studyEnv({GEMINI_MODEL:'gemini-3.6-flash'})}={}){
 const url=new URL(`https://example.test/api/my/study/${path}`);
 return studyRoute(new Request(url,{method,headers:{Cookie:'cat_hien_session=test',Origin:url.origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:form?{body:form}:{})}),env,url,url.pathname);
}
const ocrForm=(mode,model)=>{const form=new FormData();form.set('apiKey',KEY);if(mode!==undefined)form.set('mode',mode);if(model)form.set('model',model);form.set('image',new File([new Uint8Array([255,216,255,1,2,3])],'page.jpg',{type:'image/jpeg'}));return form;};
// A layout block answer that passes every check: no Chinese, no digits, about three times the source's length.
const fluent=(source,index)=>`Vectơ ${String.fromCharCode(97+index%26)}${'ơ'.repeat(Math.floor(index/26))} ${'không '.repeat(Math.ceil(source.length/2))}`.trim();

test('Every mode has the shared profile shape, within the limits the routes and an OCR call enforce',()=>{
 assert.deepEqual(MODES,['economy','balanced','quality','premium']);assert.equal(DEFAULT_MODE,'economy');assert.equal(ADMIN_DEFAULT_MODE,'premium');
 let estimate=0;
 for(const id of MODES){
  const profile=modeProfile(id);
  assert.ok(isMode(id));assert.deepEqual(Object.keys(profile).sort(),[...KEYS].sort(),id);assert.equal(profile.id,id);
  assert.ok(profile.label.trim()&&profile.hint.trim(),id);assert.equal(profile.label,profile.label.normalize('NFC'));assert.equal(profile.hint,profile.hint.normalize('NFC'));assert.equal(modeLabel(id),profile.label);
  for(const level of levelsOf(profile))assert.ok(LEVELS.includes(level),`${id}: ${level}`);
  assert.equal(typeof profile.allowRepair,'boolean');assert.equal(typeof profile.strict,'boolean');
  if(profile.reread!==null){
   assert.deepEqual(Object.keys(profile.reread).sort(),['doubt','kept','maxPerPage','thinking'],id);
   assert.equal(typeof profile.reread.kept,'boolean');assert.equal(typeof profile.reread.doubt,'boolean');assert.ok(Number.isInteger(profile.reread.maxPerPage)&&profile.reread.maxPerPage>0,id);
  }
  // translate-blocks takes at most 48 blocks and 8,000 characters a request (pdf-block-translation.js); an OCR call at
  // most OCR_LIMITS. A mode may ask for less, never more.
  assert.ok(Number.isInteger(profile.layoutBatch.chars)&&profile.layoutBatch.chars>=500&&profile.layoutBatch.chars<=8000,id);
  assert.ok(Number.isInteger(profile.layoutBatch.blocks)&&profile.layoutBatch.blocks>=1&&profile.layoutBatch.blocks<=48,id);
  assert.ok(Number.isInteger(profile.ocrBatch.images)&&profile.ocrBatch.images>=1&&profile.ocrBatch.images<=OCR_LIMITS.images,id);
  assert.ok(Number.isInteger(profile.ocrBatch.blocks)&&profile.ocrBatch.blocks>=1&&profile.ocrBatch.blocks<=OCR_LIMITS.sheetBlocks,id);
  assert.ok(['standard','fine'].includes(profile.sheets),id);assert.ok(['hybrid','gemini'].includes(profile.textOcr),id);
  assert.ok(Number.isInteger(profile.textChunk)&&profile.textChunk>=1000&&profile.textChunk<=10000,id);
  // Listed from the cheapest: a later mode never estimates fewer tokens.
  assert.ok(profile.estimate>=1&&profile.estimate>=estimate,id);estimate=profile.estimate;
 }
});

test('Tiết kiệm is the engine every request used before modes; Kỹ nhất reads and reasons the most',()=>{
 const economy=modeProfile('economy'),premium=modeProfile('premium'),rank=level=>LEVELS.indexOf(level);
 assert.deepEqual({...economy,label:undefined,hint:undefined},{id:'economy',label:undefined,hint:undefined,translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:false,reread:null,layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:OCR_LIMITS.images,blocks:OCR_LIMITS.sheetBlocks},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1});
 assert.equal(premium.sheets,'fine');assert.equal(premium.textOcr,'gemini');assert.equal(premium.strict,true);assert.ok(premium.reread?.kept&&premium.reread.doubt);
 for(const id of MODES){
  const profile=modeProfile(id);
  assert.ok(rank(premium.translateThinking)>=rank(profile.translateThinking)&&rank(premium.ocrThinking)>=rank(profile.ocrThinking)&&rank(premium.retryThinking)>=rank(profile.retryThinking),id);
  assert.ok(premium.layoutBatch.chars<=profile.layoutBatch.chars&&premium.layoutBatch.blocks<=profile.layoutBatch.blocks&&premium.ocrBatch.images<=profile.ocrBatch.images&&premium.ocrBatch.blocks<=profile.ocrBatch.blocks,id);
 }
 // The labels the select and the history show.
 assert.match(modeLabel('premium'),/^Kỹ nhất/u);assert.match(modeLabel('economy'),/^Tiết kiệm/u);
});

test('An unknown or missing mode is economy, never a dearer one',()=>{
 for(const value of [undefined,null,'','turbo','Premium',' premium','__proto__','constructor','toString',1,{},['premium']]){assert.equal(modeProfile(value).id,'economy',String(value));assert.equal(isMode(value),false,String(value));}
});

test('Thinking levels: Gemini 3 is sent the level by name, the 2.5 Flash family a bounded budget, default and unknown levels nothing',()=>{
 for(const id of ['gemini-3.6-flash','gemini-3-flash-preview','gemini-3.1-flash-lite'])for(const level of LEVELS)assert.deepEqual(thinkingConfigFor(id,level),{thinkingLevel:level},`${id} ${level}`);
 for(const id of ['gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.5-flash-preview-09-2025'])assert.deepEqual(LEVELS.map(level=>thinkingConfigFor(id,level)),[{thinkingBudget:0},{thinkingBudget:1024},{thinkingBudget:4096},{thinkingBudget:12288}],id);
 for(const level of ['default','',undefined,null,'max','HIGH','__proto__','toString'])for(const id of ['gemini-3.6-flash','gemini-2.5-flash'])assert.equal(thinkingConfigFor(id,level),null,`${id} ${String(level)}`);
 for(const level of LEVELS)assert.equal(thinkingConfigFor('gemini-2.0-flash',level),null);
 // Gemini 3 Pro (only the admin pipeline's own settings can name one) takes low and high only.
 assert.deepEqual(LEVELS.map(level=>thinkingConfigFor('gemini-3.0-pro',level)),[{thinkingLevel:'low'},{thinkingLevel:'low'},{thinkingLevel:'low'},{thinkingLevel:'high'}]);
 assert.deepEqual(thinkingConfigFor('gemini-3.1-pro-preview','minimal'),{thinkingLevel:'low'});
 // Every level a mode names is one ai.js bounds: no mode falls back on a model's unbounded default thinking.
 for(const id of MODES)for(const level of levelsOf(modeProfile(id)))for(const model of ['gemini-3.6-flash','gemini-2.5-flash','gemini-2.5-flash-lite'])assert.ok(thinkingConfigFor(model,level),`${id} ${level} ${model}`);
});

test('A call that reasons more gets a larger output cap by itself; a cap the caller sets is kept as it is',async t=>{
 const sent=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const {generationConfig}=JSON.parse(options.body);sent.push([generationConfig.maxOutputTokens,generationConfig.thinkingConfig]);return reply({ok:true});});
 const env=(model,level)=>({GEMINI_API_KEY:KEY,GEMINI_MODEL:model,...(level===undefined?{}:{GEMINI_THINKING:level})});
 for(const level of [undefined,'default','minimal','low','medium','high'])await generate(env('gemini-3.6-flash',level),[{text:'x'}],'i');
 assert.deepEqual(sent.map(([cap])=>cap),[32768,32768,32768,32768+2048,32768+8192,32768+16384]);
 assert.deepEqual(['minimal','low','medium','high','default',undefined].map(thinkingHeadroom),[0,2048,8192,16384,0,0]);
 sent.length=0;
 await generate(env('gemini-2.5-flash','medium'),[{text:'x'}],'i');
 // A model sent no thinking config gets no headroom either; an explicit cap (an OCR call's) is the caller's to size.
 await generate(env('gemini-2.0-flash','high'),[{text:'x'}],'i');
 await generate(env('gemini-3.6-flash','high'),[{text:'x'}],'i',true,{maxOutputTokens:5000});
 assert.deepEqual(sent,[[32768+8192,{thinkingBudget:4096}],[32768,undefined],[5000,{thinkingLevel:'high'}]]);
});

test('/config keeps its keys and adds premium, the modes the select offers and the modes that change a kept-layout PDF',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('The config is answered locally');});
 const response=await call('config',{method:'GET'}),data=await response.json();
 assert.equal(response.status,200);
 assert.deepEqual(Object.keys(data).sort(),['balanced','economy','layoutModes','modes','pdf','premium','quality','runtimeVersion']);
 assert.equal(data.premium,'gemini-3.6-flash');assert.deepEqual(data.layoutModes,MODES);assert.match(data.runtimeVersion,/key-model-selection/u);
 assert.deepEqual(data.modes,MODES.map(id=>{const {label,hint,estimate}=modeProfile(id);return {id,label,hint,estimate};}));
 // The premium model: its own variable, then GEMINI_MODEL, then the quality default (a Flash model, never Pro).
 assert.deepEqual(studyModelConfig({}),{economy:'gemini-2.5-flash-lite',balanced:'gemini-3.1-flash-lite',quality:'gemini-2.5-flash',premium:'gemini-2.5-flash',pdf:'gemini-2.5-flash-lite',modes:data.modes,layoutModes:MODES,runtimeVersion:data.runtimeVersion});
 assert.equal(studyModelConfig({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_QUALITY_MODEL:'gemini-3.8-flash'}).premium,'gemini-3.6-flash');
 assert.equal(studyModelConfig({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PREMIUM_MODEL:'gemini-3.8-flash'}).premium,'gemini-3.8-flash');
});

test('Kỹ nhất translates text with its own model and more reasoning, and its full retry reasons as much',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{calls.push({endpoint:String(endpoint),config:JSON.parse(options.body).generationConfig});return reply({translation:calls.length===1?'Bản dịch thiếu dẫn chứng.':'Bản dịch có dẫn chứng [12].',contextUpdate:'',glossaryUpdates:{}});});
 const env=studyEnv({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PREMIUM_MODEL:'gemini-3.8-flash'});
 const data=await (await call('translate',{env,body:{apiKey:KEY,source:'原文[12]。',mode:'premium'}})).json();
 assert.equal(calls.length,2);assert.match(data.translation,/\[12\]/u);
 assert.match(calls[0].endpoint,/\/gemini-3\.8-flash:generateContent$/u);assert.deepEqual(calls[0].config.thinkingConfig,{thinkingLevel:'medium'});assert.equal(calls[0].config.maxOutputTokens,32768+8192);
 // Without a model chosen in the tab, the retry uses the quality model (GEMINI_MODEL here) at the mode's retry level.
 assert.match(calls[1].endpoint,/\/gemini-3\.6-flash:generateContent$/u);assert.deepEqual(calls[1].config.thinkingConfig,{thinkingLevel:modeProfile('premium').retryThinking});
});

test('Each mode bounds the reasoning of a marker repair as of its translation; Kỹ hơn no longer skips the repair',async t=>{
 for(const mode of ['economy','balanced','quality','premium']){
  const levels=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{levels.push(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel);return reply(levels.length===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{translation:'Sử liệu ghi chép [12].'});});
  const data=await (await call('translate',{body:{apiKey:KEY,source:`${'甲'.repeat(160)}\n\n史料记载[12]。`,mode}})).json();
  const level=modeProfile(mode).translateThinking;
  assert.deepEqual(levels,[level,level],mode);assert.equal(data.translation,'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép [12].',mode);
  t.mock.restoreAll();
 }
});

test('A mode the server does not know is refused before any Gemini call; a request without one is economy',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Gemini must not be called');});
 for(const mode of ['turbo','Premium','__proto__',3,['premium'],{}])for(const [path,body] of [['translate',{source:'你好。'}],['translate-blocks',{blocks:[{id:'p1-b0',source:'你好。'}]}],['models',{purpose:'pdf'}]])
  await assert.rejects(()=>call(path,{body:{apiKey:KEY,mode,...body}}),error=>error.status===400&&error.code==='bad_mode'&&/Cách dịch không hợp lệ/u.test(error.message),`${path} ${JSON.stringify(mode)}`);
 await assert.rejects(()=>call('ocr',{form:ocrForm('turbo')}),error=>error.status===400&&error.code==='bad_mode');
 assert.equal(calls,0);
 t.mock.restoreAll();
 const levels=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{levels.push(JSON.parse(options.body).generationConfig.thinkingConfig?.thinkingLevel);return reply({translation:'Xin chào.',contextUpdate:'',glossaryUpdates:{}});});
 for(const mode of [undefined,null,''])assert.equal((await call('translate',{body:{apiKey:KEY,source:'你好。',mode}})).status,200);
 assert.deepEqual(levels,['minimal','minimal','minimal']);
});

test('Kept-layout blocks go in the mode\'s batch, with the mode\'s reasoning; a batch over it is refused before any call',async t=>{
 const requests=[];
 t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const body=JSON.parse(options.body),blocks=JSON.parse(body.contents[0].parts[0].text).blocks;requests.push({config:body.generationConfig,count:blocks.length});return reply({blocks:blocks.map((block,index)=>({id:block.id,translation:fluent(block.source,index)})),contextUpdate:'',glossaryUpdates:{}});});
 const premium=modeProfile('premium').layoutBatch,blocks=count=>Array.from({length:count},(_,n)=>({id:`p1-b${n}`,source:'空间向量。'}));
 const send=(mode,list)=>call('translate-blocks',{body:{apiKey:KEY,mode,partial:true,blocks:list}});
 for(const list of [blocks(premium.blocks+1),[{id:'p1-b0',source:'空'.repeat(premium.chars)},{id:'p1-b1',source:'间。'}]])
  await assert.rejects(()=>send('premium',list),error=>error.status===400&&error.code==='bad_batch'&&error.message.includes(String(premium.blocks)));
 assert.equal(requests.length,0);
 // At the limit, and one block longer than the mode's characters on its own, go through.
 assert.equal((await send('premium',blocks(premium.blocks))).status,200);
 assert.equal((await send('premium',[{id:'p1-b0',source:'空间向量的概念。'.repeat(Math.ceil((premium.chars+500)/8))}])).status,200);
 assert.deepEqual(requests.map(r=>[r.count,r.config.thinkingConfig,r.config.maxOutputTokens]),[[premium.blocks,{thinkingLevel:modeProfile('premium').translateThinking},32768+thinkingHeadroom(modeProfile('premium').translateThinking)],[1,{thinkingLevel:modeProfile('premium').translateThinking},32768+thinkingHeadroom(modeProfile('premium').translateThinking)]]);
 // Tiết kiệm keeps today's batch of 48 blocks and 5,000 characters, without extra reasoning.
 requests.length=0;
 assert.equal((await send('economy',blocks(48))).status,200);
 await assert.rejects(()=>send('economy',blocks(49)),error=>error.code==='bad_batch');
 await assert.rejects(()=>send(undefined,[{id:'p1-b0',source:'空'.repeat(4000)},{id:'p1-b1',source:'间'.repeat(1001)}]),error=>error.code==='bad_batch');
 assert.deepEqual(requests.map(r=>[r.count,r.config.thinkingConfig]),[[48,{thinkingLevel:'minimal'}]]);
});

test('Kỹ nhất translates a kept-layout block again when Chinese is left in it; Tiết kiệm only warns',async t=>{
 for(const [mode,calls] of [['premium',2],['economy',1]]){
  const requests=[];
  t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const ids=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).blocks.map(block=>block.id);requests.push(ids);return reply({blocks:ids.map(id=>({id,translation:requests.length===1?'Khái niệm 向量 trong không gian và các phép toán.':'Khái niệm vectơ trong không gian và các phép toán.'})),contextUpdate:'',glossaryUpdates:{}});});
  const data=await (await call('translate-blocks',{body:{apiKey:KEY,mode,partial:true,blocks:[{id:'p1-b0',source:'空间向量的概念与运算。'}]}})).json();
  assert.equal(requests.length,calls,`${mode}: ${JSON.stringify(data)}`);
  if(mode==='premium')assert.deepEqual(data.blocks,[{id:'p1-b0',translation:'Khái niệm vectơ trong không gian và các phép toán.'}]);
  else{assert.deepEqual(data.blocks,[{id:'p1-b0',translation:'Khái niệm 向量 trong không gian và các phép toán.'}]);assert.ok(data.warnings.some(warning=>/chữ Hán/u.test(warning)),JSON.stringify(data.warnings));}
  t.mock.restoreAll();
 }
});

test('Text-mode OCR reasons at the mode\'s OCR level, with room for that reasoning',async t=>{
 const sent=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const {generationConfig}=JSON.parse(options.body);sent.push([String(endpoint).match(/models\/([^:]+)/u)[1],generationConfig.thinkingConfig?.thinkingLevel,generationConfig.maxOutputTokens]);return reply({text:'識別文字',warnings:[]});});
 const env=studyEnv({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PREMIUM_MODEL:'gemini-3.8-flash'}),level=modeProfile('premium').ocrThinking;
 for(const form of [ocrForm(),ocrForm('economy'),ocrForm('premium'),ocrForm('premium','gemini-3.6-flash-lite')])assert.equal((await call('ocr',{env,form})).status,200);
 assert.deepEqual(sent,[['gemini-3.6-flash','minimal',32768],['gemini-3.6-flash','minimal',32768],['gemini-3.8-flash',level,32768+thinkingHeadroom(level)],['gemini-3.6-flash-lite',level,32768+thinkingHeadroom(level)]]);
});

test('Through the Worker the browser reads a refused mode or batch as a 400 with its code, and the config lists every mode',async t=>{
 const {default:worker}=await import('./worker.js'),{sqliteEnvironment,signedIn}=await import('./test-support/sqlite-d1.mjs');
 const {sqlite,env}=sqliteEnvironment(t,{vars:{GEMINI_MODEL:'gemini-3.6-flash'}}),lan=await signedIn(sqlite);
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Gemini must not be called');});
 const send=(path,body)=>worker.fetch(new Request(`https://example.test/api/my/study/${path}`,{method:body?'POST':'GET',headers:{Cookie:lan.cookie,Origin:'https://example.test',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{});
 let response=await send('translate',{apiKey:KEY,source:'你好。',mode:'turbo'});
 assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'Cách dịch không hợp lệ. Hãy tải lại trang rồi thử lại.',code:'bad_mode'});
 response=await send('translate-blocks',{apiKey:KEY,mode:'premium',blocks:Array.from({length:modeProfile('premium').layoutBatch.blocks+1},(_,n)=>({id:`p1-b${n}`,source:'你好。'}))});
 assert.equal(response.status,400);assert.equal((await response.json()).code,'bad_batch');
 response=await send('config');assert.equal(response.status,200);const config=await response.json();
 assert.deepEqual(config.layoutModes,MODES);assert.equal(config.premium,'gemini-3.6-flash');assert.deepEqual(config.modes.map(mode=>mode.id),MODES);
});

test('Model discovery knows Kỹ nhất, and a Pro model set for it is never what a student key is used with',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({models:['gemini-3.6-flash','gemini-3.8-flash','gemini-3.8-pro'].map(id=>({name:`models/${id}`,displayName:id,supportedGenerationMethods:['generateContent']}))}));
 const ask=premiumModel=>call('models',{env:studyEnv({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PREMIUM_MODEL:premiumModel}),body:{apiKey:KEY,purpose:'text',mode:'premium'}}).then(response=>response.json());
 let data=await ask('gemini-3.8-flash');assert.deepEqual([data.requested,data.selected],['gemini-3.8-flash','gemini-3.8-flash']);
 data=await ask('gemini-3.8-pro');assert.equal(data.requested,'gemini-3.8-pro');assert.equal(data.selected,'gemini-3.6-flash');assert.ok(data.models.every(model=>/-flash/u.test(model.id)));
 await assert.rejects(()=>call('translate',{body:{apiKey:KEY,source:'你好。',mode:'premium',model:'gemini-3.8-pro'}}),/model Gemini Flash/u);
});
