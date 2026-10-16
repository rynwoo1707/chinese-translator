import test from 'node:test';
import assert from 'node:assert/strict';
import {generate,translate,translateAndVerify,missingTranslationMarkers,missingGlossaryTerms,relevantGlossary,MATH_GLOSSARY} from './ai.js';
import {translatePdfBlocks} from './pdf-block-translation.js';

const reply=(body,finishReason='STOP',usageMetadata={promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15})=>Response.json({candidates:[{finishReason,content:{parts:[{text:typeof body==='string'?body:JSON.stringify(body)}]}}],usageMetadata});
const translation=text=>({translation:text,contextUpdate:'',glossaryUpdates:{}});

test('Vietnamese thousands separators are not reported as dropped numbers, real omissions still are',()=>{
 assert.deepEqual(missingTranslationMarkers('该校有3000名学生。','Trường có 3.000 học sinh.'),[]);
 assert.deepEqual(missingTranslationMarkers('该校有3000名学生。','Trường có 3 000 học sinh.'),[]);
 assert.deepEqual(missingTranslationMarkers('1949年有3000人[12]。','Năm 1949 có 3.000 người [12].'),[]);
 assert.deepEqual(missingTranslationMarkers('该校有3000名学生。','Trường có 300 học sinh.'),['3000']);
 assert.deepEqual(missingTranslationMarkers('1949年','Năm 1,949'),['1949'],'a decimal comma is not a thousands group');
});

test('glossary trimming keeps teacher terms first and prefers the more specific term',()=>{
 const builtIn=MATH_GLOSSARY,teacher={'王老师':'thầy Vương'},text=Object.keys(builtIn).join('，')+'王老师';
 const chosen=relevantGlossary({...builtIn,...teacher},text,{priority:teacher,builtIn},10);
 assert.equal(Object.keys(chosen).length,10);assert.equal(Object.keys(chosen)[0],'王老师');
 const keys=Object.keys(relevantGlossary({'向量':'vectơ','空间向量':'vectơ trong không gian'},'空间向量',{builtIn:{'向量':'vectơ','空间向量':'vectơ trong không gian'}}));
 assert.deepEqual(keys,['空间向量','向量']);
});

test('the prompt never loses a teacher term when a math section has more than 60 relevant terms',async t=>{
 let payload;t.mock.method(globalThis,'fetch',async(url,options)=>{payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);return reply(translation('x'));});
 await translate({GEMINI_API_KEY:'k'},Object.keys(MATH_GLOSSARY).join('，')+'，练习，例题，定理，定义，证明，性质，公式。王老师',{genre:'Toán học · STEM',glossary:JSON.stringify({'王老师':'thầy Vương'})});
 assert.equal(Object.keys(payload.glossary).length,60);assert.equal(payload.glossary['王老师'],'thầy Vương');
});

test('a section cut off at the output limit is retried as two halves instead of failing',async t=>{
 const sources=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const source=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).source;sources.push(source);return source.length>1500?reply('',`MAX_TOKENS`):reply(translation(`[${source.length}]`));});
 const source='甲'.repeat(1000)+'。\n'+'乙'.repeat(1000)+'。';
 const result=await translate({GEMINI_API_KEY:'k'},source,{genre:'',glossary:'{}'});
 assert.equal(sources.length,3);assert.equal(sources[1]+sources[2],source);assert.match(result.translation,/^\[\d+\]\n\n\[\d+\]$/u);
});

test('stop reasons are explained, and only Gemini 3 keeps its default temperature',async t=>{
 const configs=[];let finish='RECITATION';t.mock.method(globalThis,'fetch',async(url,options)=>{configs.push(JSON.parse(options.body).generationConfig);return reply(translation('x'),finish);});
 await assert.rejects(()=>generate({GEMINI_API_KEY:'k',GEMINI_MODEL:'gemini-3.6-flash'},[{text:'x'}],'i'),error=>error.finishReason==='RECITATION'&&/bản quyền/u.test(error.message));
 finish='STOP';await generate({GEMINI_API_KEY:'k',GEMINI_MODEL:'gemini-2.5-flash'},[{text:'x'}],'i');
 assert.equal('temperature' in configs[0],false);assert.equal(configs[1].temperature,0.1);
});

test('terminology check flags teacher terms the translation ignored, but not context-dependent built-ins',()=>{
 const glossary={'王老师':'thầy Vương','空间向量':'vectơ không gian / vectơ trong không gian','定义':'định nghĩa'};
 assert.deepEqual(missingGlossaryTerms('王老师给出定义。','Thầy Vương đưa ra định nghĩa.',glossary),[]);
 assert.deepEqual(missingGlossaryTerms('空间向量','Vectơ trong không gian',glossary),[],'any listed alternative is accepted, case-insensitively');
 assert.deepEqual(missingGlossaryTerms('王老师确定了它。','Ông Vương đã xác định nó.',glossary),['王老师 → thầy Vương']);
});

test('translateAndVerify reports a teacher term that the model did not use',async t=>{
 t.mock.method(globalThis,'fetch',async()=>reply(translation('Ông Vương giảng bài.')));
 const result=await translateAndVerify({GEMINI_API_KEY:'k'},'王老师讲课。',{genre:'',glossary:JSON.stringify({'王老师':'thầy Vương'})});
 assert.ok(result.warnings.some(w=>/王老师 → thầy Vương/u.test(w)));
});

test('a rejected PDF block is retried alone instead of discarding the whole batch',async t=>{
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const ids=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).blocks.map(b=>b.id);requests.push(ids);
  const blocks=ids.map(id=>({id,translation:id==='p1-b1'&&requests.length===1?'Năm học.':id==='p1-b1'?'Năm 2024.':'Xin chào.'}));
  return reply({blocks,contextUpdate:'',glossaryUpdates:{}});
 });
 const result=await translatePdfBlocks({GEMINI_API_KEY:'k',GEMINI_MODEL:'gemini-3.6-flash'},{blocks:[{id:'p1-b0',source:'你好。'},{id:'p1-b1',source:'2024年。'},{id:'p1-b2',source:'你好。'}]});
 assert.deepEqual(requests,[['p1-b0','p1-b1','p1-b2'],['p1-b1']]);
 assert.deepEqual(result.blocks.map(b=>b.translation),['Xin chào.','Năm 2024.','Xin chào.']);
 assert.equal(result.usage.requests,2);assert.equal(result.usage.total,30);
});
