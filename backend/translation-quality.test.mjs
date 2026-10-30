import test from 'node:test';
import assert from 'node:assert/strict';
import {chunks,translate,translateAndVerify,missingTranslationMarkers,protectMathExpressions,restoreMathExpressions,MATH_GLOSSARY,TEXTBOOK_GLOSSARY} from './ai.js';
test('explicit Unicode vector arrows are protected through translation while plain point names remain text',()=>{
 const source='向量 AB⃗, OA⃗, a⃗ 和 AB, OA, [□]。',protectedValue=protectMathExpressions(source);
 assert.equal(protectedValue.formulas.length,3);assert.doesNotMatch(protectedValue.source,/\u20d7/u);
 assert.match(protectedValue.source,/AB, OA, \[□\]/u);
 const restored=restoreMathExpressions(protectedValue.source,protectedValue.formulas);
 assert.match(restored,/\\\(\\vec\{AB\}\\\)/u);
 assert.match(restored,/\\\(\\vec\{OA\}\\\)/u);
 assert.match(restored,/\\\(\\vec\{a\}\\\)/u);
 assert.throws(()=>restoreMathExpressions(protectedValue.source.replace('@@MATH_0001@@','AB'),protectedValue.formulas),/không bảo toàn/u);
});
test('Chunking preserves punctuation, all text and surrogate pairs',()=>{
 for(const text of ['你好世界！你好朋友？新的句子。尾声','甲'.repeat(19)+'😀'+'乙'.repeat(30),'第一段\n第二段\n'+ '文'.repeat(50)]){
 const parts=chunks(text,20);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=20));assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
 }
 assert.equal(chunks('你好世界！你好朋友？新的句子。尾声',12)[0],'你好世界！你好朋友？');
});
test('Mathematical expressions are replaced locally and restored byte-for-byte',()=>{
 const source='设 \\(\\vec a=(1,2,3)\\) 且 \\[x^2/a^2+y^2/b^2=1\\]。';
 const protectedValue=protectMathExpressions(source);
 assert.equal(protectedValue.formulas.length,2);assert.match(protectedValue.source,/@@MATH_0001@@/);assert.doesNotMatch(protectedValue.source,/x\^2/);
 const restored=restoreMathExpressions('Cho @@MATH_0001@@ và @@MATH_0002@@.',protectedValue.formulas);
 assert.equal(restored,'Cho \\(\\vec a=(1,2,3)\\) và \\[x^2/a^2+y^2/b^2=1\\].');
 assert.throws(()=>restoreMathExpressions('Thiếu công thức.',protectedValue.formulas),/không bảo toàn công thức/);
});
test('A formula holding dollar signs comes back byte for byte: $$…$$ keeps both, and $&, $\' or $` inside one paste nothing',async t=>{
 const R=String.raw;
 for(const formula of [R`$$ \frac{a}{b}=1 $$`,R`\[\text{lãi $5$&$6$}\]`,R`$&x$`,R`\(a$'b\)`,R`\(a$${'`'}b\)`,R`\[\text{giá $$ và $1}\]`]){
  const shielded=protectMathExpressions(`由 ${formula} 得`);
  assert.deepEqual(shielded.formulas.map(f=>f.formula),[formula],formula);
  assert.equal(restoreMathExpressions('Từ @@MATH_0001@@ suy ra.',shielded.formulas),`Từ ${formula} suy ra.`,formula);
 }
 // Through a translation: the display formula stays display ($$), not a $…$ the page would print with its dollars.
 t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Từ @@MATH_0001@@ suy ra.',contextUpdate:'',glossaryUpdates:{}})}]}}]}));
 const result=await translate({GEMINI_API_KEY:'test'},R`由 $$ \frac{a}{b}=1 $$ 得`,{context:'',genre:'Toán học · STEM',glossary:'{}'});
 assert.equal(result.translation,R`Từ $$ \frac{a}{b}=1 $$ suy ra.`);
});
test('Math translation receives textbook terminology and cannot rewrite formulas',async t=>{
 let payload;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);payload=JSON.parse(body.contents[0].parts[0].text);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Elip có phương trình @@MATH_0001@@.',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const result=await translate({GEMINI_API_KEY:'test'},'椭圆的方程是 \\(x^2/a^2+y^2/b^2=1\\)。',{context:'',genre:'Toán học · STEM',glossary:'{}'});
 assert.equal(payload.source,'椭圆的方程是 @@MATH_0001@@。');assert.equal(payload.glossary['椭圆'],MATH_GLOSSARY['椭圆']);assert.equal(result.translation,'Elip có phương trình \\(x^2/a^2+y^2/b^2=1\\).');
});
test('A transient Gemini network reset is retried without changing the source',async t=>{
 let calls=0,payload;
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;if(calls===1)throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const result=await translate({GEMINI_API_KEY:'test'},'原文',{context:'',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}'});
 assert.equal(calls,2);assert.equal(payload.source,'原文');assert.equal(result.translation,'Bản dịch');
});
test('Translation receives continuity and keeps editor glossary authoritative',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);calls.push(JSON.parse(body.contents[0].parts[0].text));return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Anh quay lại.',contextUpdate:'Hai người bạn',glossaryUpdates:{张三:'Tên khác'}})}]}}]});});
 const result=await translate({GEMINI_API_KEY:'test'},'张三重新考订了清代档案。',{context:'Khảo cứu sử liệu',genre:'Lịch sử Trung Hoa',glossary:JSON.stringify({'张三':'Trương Tam'}),previousSource:'张三查阅档案。',previousTranslation:'Trương Tam tra cứu hồ sơ lưu trữ.'});
 assert.equal(calls.length,1);assert.equal(calls[0].previousTranslation,'Trương Tam tra cứu hồ sơ lưu trữ.');assert.equal(calls[0].previousSource,'张三查阅档案。');assert.equal(calls[0].glossary['张三'],'Trương Tam');assert.equal(result.glossary['张三'],'Trương Tam');
});
test('A 10000-character translation segment is handled in one Gemini request',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch đầy đủ',contextUpdate:'Ngữ cảnh',glossaryUpdates:{}})}]}}]});});
 const source='文'.repeat(10000),result=await translate({GEMINI_API_KEY:'test'},source,{context:'',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}'});
 assert.equal(calls,1);assert.equal(result.translation,'Bản dịch đầy đủ');
});
test('Exact translation retries use private cache without another Gemini request',async t=>{
 const objects=new Map(),env={GEMINI_API_KEY:'test',GEMINI_MODEL:'test-model',FILES:{async get(key){const value=objects.get(key);return value?{json:async()=>JSON.parse(value)}:null;},async put(key,value){objects.set(key,value);}}};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({usageMetadata:{promptTokenCount:120,candidatesTokenCount:80,totalTokenCount:200},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const story={context:'',genre:'Chuyên khảo · Nghiên cứu',glossary:'{}'},first=await translate(env,'原文',story),second=await translate(env,'原文',story);
 assert.equal(calls,1);assert.equal(first.usage.total,200);assert.equal(first.usage.requests,1);assert.equal(second.usage.total,0);assert.equal(second.usage.cacheHits,1);assert.equal(second.translation,first.translation);
});

test('Translation cache is isolated by context to preserve quality',async t=>{
 const objects=new Map(),env={GEMINI_API_KEY:'test',FILES:{async get(key){const value=objects.get(key);return value?{json:async()=>JSON.parse(value)}:null;},async put(key,value){objects.set(key,value);}}};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 await translate(env,'原文',{context:'Người kể thứ nhất',genre:'Khác',glossary:'{}'});await translate(env,'原文',{context:'Người kể thứ ba',genre:'Khác',glossary:'{}'});
 assert.equal(calls,2);
});

test('Geometry vocabulary used in high-school textbooks is available to every translation',()=>{
 for(const term of ['法向量','二面角','点到平面的距离','球的方程','异面直线'])assert.ok(MATH_GLOSSARY[term],`Thiếu thuật ngữ ${term}`);
});

test('Textbook pedagogical labels stay consistent even outside the Math genre',async t=>{
 let payload;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);payload=JSON.parse(body.contents[0].parts[0].text);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Định lý và bài tập.',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 await translate({GEMINI_API_KEY:'test'},'定理与练习。',{context:'',genre:'Lịch sử Trung Hoa',glossary:'{}'});
 assert.equal(payload.glossary['定理'],TEXTBOOK_GLOSSARY['定理']);assert.equal(payload.glossary['练习'],TEXTBOOK_GLOSSARY['练习']);
});

test('translateAndVerify corrects only the paragraph that lost its citation marker, in the one correction request admin and study engines share',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body),payload=JSON.parse(body.contents[0].parts[0].text);calls.push({url,payload});
  const value=calls.length===1?{translation:'Đoạn đầu.\n\nSử liệu ghi chép.',contextUpdate:'',glossaryUpdates:{}}:{items:[{id:'d1',translation:'Sử liệu ghi chép [12].'}]};
  return Response.json({usageMetadata:{promptTokenCount:10,candidatesTokenCount:8,totalTokenCount:18},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
 });
 const env={GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-2.5-flash-lite'};
 const result=await translateAndVerify(env,`${'甲'.repeat(160)}\n\n史料记载[12]。`,{context:'',genre:'Khác',glossary:'{}'});
 assert.equal(calls.length,2);assert.deepEqual(calls[1].payload.items,[{id:'d1',source:'史料记载[12]。',draft:'Sử liệu ghi chép.',missingNumbers:['[12]']}]);
 assert.equal(result.repairScope,'partial');assert.equal(result.translation,'Đoạn đầu.\n\nSử liệu ghi chép [12].');assert.equal(result.warnings.length,0);assert.equal(result.usage.total,36);
});

test('translateAndVerify corrects a short passage that lost its citation marker in place, never translating it again',async t=>{
 const sent=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const payload=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);sent.push(payload);const value=payload.items?{items:[{id:'d1',translation:'Bản dịch có dẫn chứng [12].'}]}:{translation:'Bản dịch thiếu dẫn chứng.',contextUpdate:'',glossaryUpdates:{}};return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});});
 const result=await translateAndVerify({GEMINI_API_KEY:'test'},'原文[12]。',{context:'',genre:'Khác',glossary:'{}'});
 assert.equal(sent.length,2);assert.equal(sent[1].items[0].draft,'Bản dịch thiếu dẫn chứng.');assert.equal(result.repairScope,'partial');assert.match(result.translation,/\[12\]/);assert.equal(result.warnings.length,0);
});

test('translateAndVerify skips the correction entirely when allowRepair is false, and names what is missing',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({translation:'Bản dịch thiếu dẫn chứng.',contextUpdate:'',glossaryUpdates:{}})}]}}]});});
 const result=await translateAndVerify({GEMINI_API_KEY:'test'},'原文[12]。',{context:'',genre:'Khác',glossary:'{}'},{allowRepair:false});
 assert.equal(calls,1);assert.equal(result.repairScope,'none');assert.deepEqual(result.warnings,['Đoạn 1: thiếu số hoặc dẫn chứng: [12]']);
});

test('missingTranslationMarkers detects dropped footnote numbers and years',()=>{
 assert.deepEqual(missingTranslationMarkers('原文[1][2]1998年','译文[1]'),['[2]','1998']);
 assert.deepEqual(missingTranslationMarkers('原文[1]','译文[1]'),[]);
});
