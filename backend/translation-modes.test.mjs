import test from 'node:test';
import assert from 'node:assert/strict';
import {MODES,DEFAULT_MODE,ADMIN_DEFAULT_MODE,isMode,modeProfile,modeLabel,rereads,hanLeft,learnedTerm,LAYOUT_VERSION,layoutStamp,untranslatedHan,blockTokens} from '../frontend/translation-modes.js';
import {OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {OCR_KEPT_CODES,OCR_DOUBT_CODES} from './pdf-block-ocr.js';
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
// A layout block answer that passes every check: no Chinese, no digits, about three times the source's length, a sentence
// for each of the source's.
const fluent=(source,index)=>{const sentences=Math.max(1,(source.match(/[。！？]/gu)||[]).length),words=Math.max(1,Math.ceil(source.length/2/sentences));return Array.from({length:sentences},(_,i)=>`${i?'Khi':`Vectơ ${String.fromCharCode(97+index%26)}${'ơ'.repeat(Math.floor(index/26))}`} ${'không '.repeat(words).trim()}.`).join(' ');};

test('Every mode has the shared profile shape, within the limits the routes and an OCR call enforce',()=>{
 assert.deepEqual(MODES,['economy','balanced','quality','premium']);assert.equal(DEFAULT_MODE,'economy');assert.equal(ADMIN_DEFAULT_MODE,'premium');
 let estimate=0;
 for(const id of MODES){
  const profile=modeProfile(id);
  assert.ok(isMode(id));assert.deepEqual(Object.keys(profile).sort(),[...KEYS].sort(),id);assert.equal(profile.id,id);
  assert.ok(profile.label.trim()&&profile.hint.trim(),id);assert.equal(profile.label,profile.label.normalize('NFC'));assert.equal(profile.hint,profile.hint.normalize('NFC'));assert.equal(modeLabel(id),profile.label);
  for(const level of levelsOf(profile))assert.ok(LEVELS.includes(level),`${id}: ${level}`);
  assert.equal(typeof profile.allowRepair,'boolean');assert.equal(typeof profile.strict,'boolean');
  // Every mode reads again what it could not read (a code of OCR_KEPT_CODES, or all) and doubts it names (or all, or none).
  assert.deepEqual(Object.keys(profile.reread).sort(),['doubt','kept','maxPerPage','thinking'],id);
  assert.ok(profile.reread.kept===true||Array.isArray(profile.reread.kept)&&profile.reread.kept.length&&profile.reread.kept.every(code=>OCR_KEPT_CODES.includes(code)),id);
  assert.ok(typeof profile.reread.doubt==='boolean'||Array.isArray(profile.reread.doubt)&&profile.reread.doubt.every(code=>OCR_DOUBT_CODES.includes(code)),id);
  assert.ok(Number.isInteger(profile.reread.maxPerPage)&&profile.reread.maxPerPage>0,id);
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

test('Tiết kiệm is the engine every request used before modes, reading again only what it could not read or read short; Kỹ nhất reads and reasons the most',()=>{
 const economy=modeProfile('economy'),premium=modeProfile('premium'),rank=level=>LEVELS.indexOf(level);
 assert.deepEqual({...economy,label:undefined,hint:undefined},{id:'economy',label:undefined,hint:undefined,translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:false,reread:{kept:['empty','unread','refused','truncated','malformed'],doubt:['han'],thinking:'low',maxPerPage:2},layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:OCR_LIMITS.images,blocks:OCR_LIMITS.sheetBlocks},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1});
 // Tiết kiệm leaves a reading kept for its formula or mixed with another strip's text as it is; Kỹ nhất reads every kind again.
 assert.deepEqual(['empty','formula','mixed'].map(code=>rereads(economy.reread.kept,code)),[true,false,false]);assert.deepEqual(OCR_DOUBT_CODES.map(code=>rereads(economy.reread.doubt,code)),[false,false,false,true]);
 assert.ok(OCR_KEPT_CODES.every(code=>rereads(premium.reread.kept,code))&&OCR_DOUBT_CODES.every(code=>rereads(premium.reread.doubt,code)));assert.equal(rereads(premium.reread.kept,undefined),false,'nothing to read again');
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

test('Kỹ nhất translates text with its own model and more reasoning, and its one correction reasons as much',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{calls.push({endpoint:String(endpoint),config:JSON.parse(options.body).generationConfig});return reply(calls.length===1?{translation:'Bản dịch thiếu dẫn chứng.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Bản dịch có dẫn chứng [12].'}]});});
 const env=studyEnv({GEMINI_MODEL:'gemini-3.6-flash',GEMINI_PREMIUM_MODEL:'gemini-3.8-flash'});
 const data=await (await call('translate',{env,body:{apiKey:KEY,source:'原文[12]。',mode:'premium'}})).json();
 assert.equal(calls.length,2);assert.match(data.translation,/\[12\]/u);
 assert.match(calls[0].endpoint,/\/gemini-3\.8-flash:generateContent$/u);assert.deepEqual(calls[0].config.thinkingConfig,{thinkingLevel:'medium'});assert.equal(calls[0].config.maxOutputTokens,32768+8192);
 // Without a model chosen in the tab, the correction uses the quality model (GEMINI_MODEL here) at the mode's level.
 assert.match(calls[1].endpoint,/\/gemini-3\.6-flash:generateContent$/u);assert.deepEqual(calls[1].config.thinkingConfig,{thinkingLevel:modeProfile('premium').translateThinking});
});

test('Each mode bounds the reasoning of its one correction as of its translation; Kỹ hơn no longer skips it',async t=>{
 for(const mode of ['economy','balanced','quality','premium']){
  const levels=[];t.mock.method(globalThis,'fetch',async(endpoint,options)=>{levels.push(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel);return reply(levels.length===1?{translation:'Đoạn đầu được giữ nguyên.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Sử liệu ghi chép [12].'}]});});
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

test('Every Cách dịch, Tiết kiệm included, translates a kept-layout block again when Chinese is left in it, and only then',async t=>{
 for(const mode of MODES){
  for(const [first,calls] of [['Khái niệm 向量 trong không gian và các phép toán.',2],['Khái niệm vectơ trong không gian và các phép toán.',1]]){
   const requests=[];
   t.mock.method(globalThis,'fetch',async(endpoint,options)=>{const ids=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).blocks.map(block=>block.id);requests.push(ids);return reply({blocks:ids.map(id=>({id,translation:requests.length===1?first:'Khái niệm vectơ trong không gian và các phép toán.'})),contextUpdate:'',glossaryUpdates:{}});});
   const data=await (await call('translate-blocks',{body:{apiKey:KEY,mode,partial:true,blocks:[{id:'p1-b0',source:'空间向量的概念与运算。'}]}})).json();
   assert.equal(requests.length,calls,`${mode}: ${JSON.stringify(data)}`);
   assert.deepEqual(data.blocks,[{id:'p1-b0',translation:'Khái niệm vectơ trong không gian và các phép toán.'}],mode);assert.deepEqual(data.failedBlocks,[],mode);
   t.mock.restoreAll();
  }
 }
 // What every mode allows to stay Chinese: a quoted example, a glossary rendering, a name glossed in parentheses.
 assert.deepEqual(hanLeft('“的”字表示所属。','Chữ “的” chỉ sở hữu.'),[]);assert.deepEqual(hanLeft('《论语》是经典。','《论语》 là kinh điển.'),['论语'],'a title is translated');
 assert.deepEqual(hanLeft('张三说。','Trương Tam (张三) nói.'),[]);assert.deepEqual(hanLeft('答案(略)','Đáp án (略)'),['略'],'the source\'s own parenthesis is no gloss');
 assert.deepEqual(hanLeft('人名','Tên 人名',['Tên 人名']),[]);assert.deepEqual(hanLeft('思考','思考'),['思考']);
 // Correct translations of any subject that keep characters on purpose: a word list glossing each word after it, a
 // phonetics exercise listing its characters, a character named as such, a name glossed with its pinyin, a gloss after a
 // number. None is asked for again.
 for(const [source,translation] of [['生词：山 shān，水 shuǐ','Từ mới: 山 (sơn – núi), 水 (thủy – nước)'],['生词：山、水、火','Từ mới: 山 (núi), 水 (nước), 火 (lửa)'],['给下列汉字注音：山 水 火','Ghi phiên âm cho các chữ sau: 山, 水, 火'],['山字有三画。','Chữ 山 có ba nét.'],['张三说','Trương Tam (张三, Zhāng Sān) nói'],['练习三','Bài 3 (练习三)']])assert.deepEqual(hanLeft(source,translation),[],translation);
 // Still named: a word left before the source's own parenthesis, a list the translation reorders, a name left bare.
 assert.deepEqual(hanLeft('答案（略）','答案 (lược)'),['答案']);assert.deepEqual(hanLeft('给下列汉字注音：山 水 火','Ghi phiên âm: 火, 山, 水'),['火','山','水']);assert.deepEqual(hanLeft('王小明来了。','王小明 đến.'),['王小明']);
 // Chinese a lesson teaches as language, as text mode allows it (ai.js chineseLeft): the words of a line read aloud in
 // pinyin, a character the translation names, a name glossed in the other script. Speech in quotes is translated, and a
 // pinyin line licenses its own words only; a gloss sharing nothing with the source is no gloss.
 for(const [source,translation] of [['山 shān 山峰','Núi: 山 shān; đỉnh núi: 山峰'],['mā 妈','mā 妈 (mẹ)'],['江：河流。','Chữ 江 có nghĩa là sông.'],['張三說。','Trương Tam (张三) nói.']])assert.deepEqual(hanLeft(source,translation),[],translation);
 assert.deepEqual(hanLeft('他说：“好。”','Anh ấy nói: “好。”'),['好']);assert.deepEqual(hanLeft('山 shān\n他住在城市。','Núi 山 shān.\nAnh ấy sống ở 城市.'),['城市']);
 assert.deepEqual(hanLeft('张三说。','Trương Tam (李四) nói.'),['李四']);assert.deepEqual(hanLeft('江河','Sông 江 và sông 河'),['江','河']);
 // A glossary rendering keeping Chinese (a teacher's, or a name learned as D9 gives it) allows that rendering as written,
 // never its characters elsewhere: a learned 'Tư Mã Thiên (司马迁)' does not let 司马迁 or 中国人民 stand bare.
 const learned=['Tư Mã Thiên (司马迁)','Sử ký (史记)','Trung Quốc (中国)','nhân dân (人民)','đại học (大学)'];
 assert.deepEqual(hanLeft('司马迁写了史记。','Tư Mã Thiên (司马迁) viết Sử ký (史记).',learned),[]);
 // One rule learns a term in every path (text mode, kept layouts, whole books): a Vietnamese rendering, the Chinese in
 // parentheses after a reading at most.
 assert.deepEqual(Object.entries({张三:'Trương Tam (张三)',司马迁:'Tư Mã Thiên (司马迁, Sīmǎ Qiān)',向量:'vectơ',探究:'探究',史景迁:'史景迁 (Sử Cảnh Khiên)',DNA:'DNA',空:' ',人民:'nhân dân 人民'}).filter(([term,value])=>learnedTerm(term,value)).map(([term])=>term),['张三','司马迁','向量']);
 // What a lesson may keep in a translation is no rendering for every later page: Chinese outside the parentheses never.
 assert.deepEqual(Object.entries({張三:'Trương Tam (张三)',山:'chữ 山',山字:'chữ 山'}).filter(([term,value])=>learnedTerm(term,value)).map(([term])=>term),['張三']);
 assert.deepEqual(hanLeft('司马迁写了史记。','司马迁 viết 史记.',learned),['司马迁','史记']);assert.deepEqual(hanLeft('中国人民热爱祖国。','中国人民 yêu tổ quốc.',learned),['中国人民']);assert.deepEqual(hanLeft('国民大学','国民大学',learned),['国民大学']);
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

// The extractor stamp a saved layout is compared with: the same number as services/pdf-layout/extract.py, read here so the
// two never drift (a newer extractor makes "Cập nhật bố cục" offered for the parts read before it).
test('LAYOUT_VERSION is extract.py EXTRACTION_VERSION; a manifest\'s stamp is its oldest page\'s; untranslated Han and the token estimate',async()=>{
 const {readFile}=await import('node:fs/promises'),extractor=await readFile(new URL('../services/pdf-layout/extract.py',import.meta.url),'utf8');
 assert.equal(LAYOUT_VERSION,Number(/^EXTRACTION_VERSION = (\d+)$/mu.exec(extractor)?.[1]),'the same number as the extractor');
 assert.equal(layoutStamp({extractionVersion:4,pages:[{},{extractionVersion:3}]}),3,'the oldest page counts');assert.equal(layoutStamp({extractionVersion:2,pages:[{},{}]}),2,'pages take the document\'s');
 assert.equal(layoutStamp({pages:[{}]}),0);assert.equal(layoutStamp({extractionVersion:4,pages:[]}),4);assert.equal(layoutStamp(null),0);
 assert.equal(untranslatedHan({untranslated:{figure:12,footer:3,unread:0}}),15);assert.equal(untranslatedHan({untranslated:7}),7);
 for(const page of [{},{untranslated:{}},{untranslated:{figure:0}},{untranslated:{figure:-3,note:'x',other:Number.NaN}},null])assert.equal(untranslatedHan(page),0,JSON.stringify(page));
 assert.equal(blockTokens({sheets:7,characters:2030,requests:2}),7*1400+3045+1600,'about the owner\'s three refreshed parts, as the plan measured them');assert.equal(blockTokens({}),0);
 assert.equal(blockTokens({sheets:1},'premium'),Math.round(1400*modeProfile('premium').estimate));assert.equal(blockTokens({sheets:1},'turbo'),1400);
});
