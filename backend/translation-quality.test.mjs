import test from 'node:test';
import assert from 'node:assert/strict';
import {chunks,translate} from './ai.js';
test('Chunking preserves punctuation, all text and surrogate pairs',()=>{
 for(const text of ['你好世界！你好朋友？新的句子。尾声','甲'.repeat(19)+'😀'+'乙'.repeat(30),'第一段\n第二段\n'+ '文'.repeat(50)]){
 const parts=chunks(text,20);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=20));assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
 }
 assert.equal(chunks('你好世界！你好朋友？新的句子。尾声',12)[0],'你好世界！你好朋友？');
});
test('Translation receives continuity and keeps editor glossary authoritative',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);calls.push(JSON.parse(body.contents[0].parts[0].text));return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(calls.length===1?{context:'Hai người bạn',glossary:{张三:'Tên khác'}}:{translation:'Anh quay lại.'})}]}}]});});
 const result=await translate({GEMINI_API_KEY:'test'},'他回来了。',{context:'Bạn cũ',genre:'Hiện đại',glossary:JSON.stringify({'张三':'Trương Tam'}),previousSource:'张三走了。',previousTranslation:'Trương Tam rời đi.'});
 assert.equal(calls[1].previousTranslation,'Trương Tam rời đi.');assert.equal(calls[1].previousSource,'张三走了。');assert.equal(calls[1].glossary['张三'],'Trương Tam');assert.equal(result.glossary['张三'],'Trương Tam');
});
