import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import worker from './worker.js';
import {recognizePdfBlocks,readOcrText,OCR_RULES,SHEET_OCR_RULES} from './pdf-block-ocr.js';
import {translatePdfBlocks,checkBlockTranslation,blockTranslationWarnings,BLOCK_TRANSLATION_RULES} from './pdf-block-translation.js';
import {applyOcrReadings} from './pdf-layout-apply.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {missingTranslationMarkers} from './ai.js';
import {validateLayoutDocument} from '../frontend/pdf-box-layout.js';
import {GENRES,validateSample,sampleTemplate} from '../tools/samples/lib/config.mjs';
import {planChunks,pageLabel,pageArgument,chapterTitle} from '../tools/samples/lib/plan.mjs';
import {buildListing,buildTemplate} from '../tools/samples/lib/listing.mjs';
import {importTexts} from '../tools/samples/lib/importer.mjs';
import {installNetworkGuard} from '../tools/samples/lib/guard.mjs';
import {resolveTarget,targetToken,adminClient,AdminError} from '../tools/samples/lib/admin-client.mjs';
import {sampleDir,validSlug,assertIgnored,assertInsideSamples} from '../tools/samples/lib/paths.mjs';
import {compactJson,sha256} from '../tools/samples/lib/util.mjs';
import {codeVersions,RENDER_VERSION,chunkFiles} from '../tools/samples/lib/state.mjs';
import {checkChunk,checkSample,renderSample} from '../tools/samples/lib/render.mjs';
import {publishSample,publishPlan,publishedSource,removeSample,unpublishSample,EXCERPT_VERSION} from '../tools/samples/lib/publish.mjs';
import {bilingualSource} from '../frontend/bilingual-reader.js';
import {coverDocument} from '../tools/samples/lib/cover.mjs';
import {rulesGlossary} from '../tools/samples/lib/rules.mjs';
import {SUBJECT_IDS} from './subject-glossaries.js';

// The CommonJS build: the package's ES build imports JSON without import attributes, which Node refuses.
const PDFLib=createRequire(import.meta.url)('@cantoo/pdf-lib');

const png='data:image/png;base64,AA==';
const root=fileURLToPath(new URL('../',import.meta.url));
const generation=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:10,totalTokenCount:20}});
const aiEnv={GEMINI_API_KEY:'student-ocr-key-12345678901234567890',GEMINI_MODEL:'gemini-3.6-flash',GEMINI_THINKING:'minimal'};

// A text-layer page and a scanned page, as extract.py writes them (images reduced to a stub).
function manifest(){
 return {version:1,extractionVersion:3,engine:'pymupdf',totalPages:40,sourceSha256:'a'.repeat(64),warnings:['Trang 8: dùng OCR; hãy đối chiếu công thức với PDF gốc.'],pages:[
  {number:7,width:600,height:800,ocr:false,background:png,original:png,blocks:[
   {id:'p7-b1',text:'1.2 空间向量的运算',source:'1.2 空间向量的运算',box:[50,40,300,70],fontSize:16},
   {id:'p7-b2',text:'1844年，格拉斯曼研究了向量的运算[2]。',source:'1844年，格拉斯曼研究了向量的运算[2]。',box:[50,90,550,130],fontSize:12},
   {id:'p7-b3',text:'向量 a = b 的模。',source:'向量 @@PDF_INLINE_1@@ 的模。',box:[50,150,550,180],fontSize:12,inlines:[{token:'@@PDF_INLINE_1@@',text:'a = b',box:[90,152,130,170],width:40,height:18,image:png}]}
  ]},
  {number:8,width:600,height:800,ocr:true,background:png,original:png,blocks:[
   {id:'p8-b1',text:'1 . 3 平 行向 量',source:'1 . 3 平 行向 量',box:[50,40,300,70],fontSize:16,kind:'paragraph'},
   {id:'p8-b2',text:'两 个向量所在的直线平行或重 合，这些向量叫 做平行向量。',source:'两 个向量所在的直线平行或重 合，这些向量叫 做平行向量。',box:[50,90,550,130],fontSize:12,kind:'paragraph'},
   {id:'p8-b3',text:'公式 x 成立。',source:'公式 @@PDF_INLINE_1@@ 成立。',box:[50,150,550,180],fontSize:12,kind:'paragraph',inlines:[{token:'@@PDF_INLINE_1@@',label:'@1',text:'x',box:[90,152,130,170],width:40,height:18,image:png}]}
  ]}
 ]};
}
const goodTexts=(slug='demo',chunk='c01')=>({version:1,sample:slug,chunk,translator:'Kiểm thử',glossary:{'平行向量':'vectơ song song'},blocks:[
 {id:'p7-b1',translation:'1.2 Các phép toán vectơ trong không gian'},
 {id:'p7-b2',translation:'Năm 1844, Grassmann đã nghiên cứu các phép toán vectơ [2].'},
 {id:'p7-b3',translation:'Độ dài của vectơ @@PDF_INLINE_1@@.'},
 {id:'p8-b1',source:'1.3 平行向量',translation:'1.3 Vectơ song song'},
 {id:'p8-b2',source:'两个向量所在的直线平行或重合，这些向量叫做平行向量。',translation:'Hai vectơ có giá song song hoặc trùng nhau gọi là vectơ song song.'},
 // "@1" is the label the image shows for the formula: like a Gemini answer, it becomes the token.
 {id:'p8-b3',source:'公式 @1 成立。',translation:'Công thức @@PDF_INLINE_1@@ đúng.'}
]});
const messages=list=>list.map(e=>e.message);

test('the shared OCR rules are the exact instructions Gemini receives, for paragraph images and for sheets',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(JSON.parse(options.body));return generation({blocks:[{id:'p4-b0',text:'甲'},{id:'p4-b1',text:'乙'}],warnings:[]});});
 const blocks=[{id:'p4-b0',source:'甲',image:png,box:[0,0,10,10],fontSize:10},{id:'p4-b1',source:'乙',image:png,box:[0,20,10,30],fontSize:10}];
 await recognizePdfBlocks(aiEnv,blocks);
 await recognizePdfBlocks(aiEnv,blocks.map(({image,...b})=>b),[{id:'p4-s1',image:png,strips:[{label:'#1',blockId:'p4-b0'},{label:'#2',blockId:'p4-b1'}]}]);
 assert.equal(calls[0].systemInstruction.parts[0].text,OCR_RULES);assert.equal(calls[1].systemInstruction.parts[0].text,SHEET_OCR_RULES);
 assert.notEqual(OCR_RULES,SHEET_OCR_RULES);
});

test('readOcrText checks and normalizes a reading exactly as a Gemini answer is checked',async t=>{
 const block={id:'p4-b1',source:'向量 @@PDF_INLINE_1@@@@PDF_INLINE_2@@ 的模',box:[0,0,300,20],fontSize:10,inlines:[{token:'@@PDF_INLINE_1@@',label:'@1',box:[20,2,40,14],image:png,text:'a',width:20,height:12},{token:'@@PDF_INLINE_2@@',label:'@2',box:[60,2,80,14],image:png,text:'b',width:20,height:12}]};
 const answers=['#2 向量 @1@@PDF_INLINE_2@@ 的模 \\frac{1}{2}','向量 @@PDF_INLINE_1@@ @@PDF_INLINE_2@@ 的模。'];let answer;
 t.mock.method(globalThis,'fetch',async()=>generation({blocks:[{id:'p4-b1',text:answer}],warnings:[]}));
 for(answer of answers){
  const viaGemini=(await recognizePdfBlocks(aiEnv,[block],[{id:'p4-s1',image:png,strips:[{label:'#2',blockId:'p4-b1'}]}])).blocks[0].text;
  assert.equal(readOcrText(answer,block,{tab:'#2'}),viaGemini);
 }
 assert.equal(readOcrText(answers[0],block,{tab:'#2'}),'向量 @@PDF_INLINE_1@@ @@PDF_INLINE_2@@ 的模 \\(\\frac{1}{2}\\)');
 for(const [text,message] of [['向量 的模',/không bảo toàn công thức của p4-b1/u],['@@PDF_INLINE_1@@ @@PDF_INLINE_2@@ @@PDF_INLINE_3@@',/mã công thức không hợp lệ/u]]){
  answer=text;await assert.rejects(()=>recognizePdfBlocks(aiEnv,[{...block,image:png}]),message);assert.throws(()=>readOcrText(text,block),message);
 }
});

test('applyOcrReadings stores readings exactly as the ocr-blocks route does, and rejects a block of another page',async t=>{
 const assetId='11111111-1111-4111-8111-111111111111',reader={id:'student-1'},key=`study/${reader.id}/pdf-layout/${assetId}/manifest.json`,values=new Map();
 const FILES={async put(k,v){values.set(k,v);},async get(k){const v=values.get(k);return v===undefined?null:{body:v,json:async()=>JSON.parse(v)};}};
 // Scanned blocks of manifests without sheets carry their own crop, which the route sends to Gemini.
 const withCrops=()=>{const doc=manifest();for(const b of doc.pages[1].blocks)b.image=png;return doc;},prior=withCrops();await FILES.put(key,JSON.stringify(prior));
 const answer={blocks:[{id:'p8-b1',text:'1.3 平行向量'},{id:'p8-b3',text:'公式 @1 成立。'}],warnings:['Ảnh mờ.']};
 t.mock.method(globalThis,'fetch',async()=>generation(answer));
 const body={assetId,apiKey:aiEnv.GEMINI_API_KEY,model:'gemini-3.6-flash',blockIds:['p8-b1','p8-b3']};
 const response=await pdfLayoutRoute(new Request('https://example.test/api/my/study/pdf-layout/ocr-blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{FILES},'/api/my/study/pdf-layout/ocr-blocks',reader);
 assert.equal(response.status,200);
 const viaRoute=(await response.json()).document,readings=await recognizePdfBlocks(aiEnv,prior.pages[1].blocks.filter(b=>body.blockIds.includes(b.id)));
 const direct=applyOcrReadings(withCrops(),readings);
 assert.deepEqual(direct,viaRoute);
 assert.equal(direct.pages[1].blocks[0].kind,'heading');assert.equal(direct.pages[1].blocks[0].bold,true);assert.equal(direct.pages[1].blocks[2].text,'公式 x 成立。');
 assert.equal(direct.ocrCorrectedVersion,0);assert.deepEqual(direct.ocrWarnings,['Ảnh mờ.']);
 assert.equal(applyOcrReadings(direct,{blocks:[{id:'p8-b2',text:'两个向量叫做平行向量。'}]}).ocrCorrectedVersion,1);
 const untouched=manifest();assert.throws(()=>applyOcrReadings(untouched,{blocks:[{id:'p8-b1',text:'甲'},{id:'p7-b1',text:'乙'}]}),/không thuộc PDF đã chọn/u);
 assert.deepEqual(untouched,manifest(),'nothing changes when one ID is wrong');
});

test('the shared translation rules and checks are the ones translatePdfBlocks applies to Gemini answers',async t=>{
 const blocks=[{id:'p1-b1',source:'1949年，新中国成立[3]。'},{id:'p1-b2',source:'向量 @@PDF_INLINE_1@@ 的模 \\(\\frac{1}{2}\\)。'}],calls=[];let answer;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);const sent=JSON.parse(body.contents[0].parts[0].text).blocks;return generation({blocks:sent.map(b=>({id:b.id,translation:answer(b)})),contextUpdate:'',glossaryUpdates:{}});});
 answer=b=>b.id==='p1-b1'?'Năm 1949, nước Trung Hoa mới ra đời [3]. 中国':`Độ dài vectơ @@PDF_INLINE_1@@ ${b.source.match(/@@MATH_\d{4}@@/u)[0]}.`;
 const result=await translatePdfBlocks(aiEnv,{blocks,glossary:{'模':'môđun'}});
 assert.equal(calls[0].systemInstruction.parts[0].text,BLOCK_TRANSLATION_RULES);
 assert.deepEqual(result.warnings,blockTranslationWarnings(blocks,result.blocks,{'模':'môđun'}));
 assert.ok(result.warnings.some(w=>/chữ Hán/u.test(w))&&result.warnings.some(w=>/bảng tên/u.test(w)));
 assert.equal(checkBlockTranslation('p1-b2',blocks[1].source,'Độ dài vectơ @@PDF_INLINE_1@@ \\(\\frac{1}{2}\\).'),result.blocks[1].translation);
 for(const [bad,expected] of [[()=>'Nước Trung Hoa mới ra đời [3].','Block p1-b1 thiếu số hoặc dẫn chứng: 1949.'],[()=>'   ','Block p1-b1 không có bản dịch.']]){
  answer=b=>b.id==='p1-b1'?bad():`Độ dài vectơ @@PDF_INLINE_1@@ ${b.source.match(/@@MATH_\d{4}@@/u)[0]}.`;
  await assert.rejects(()=>translatePdfBlocks(aiEnv,{blocks}),new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'));
  assert.throws(()=>checkBlockTranslation('p1-b1',blocks[0].source,bad()),{message:expected});
 }
 assert.throws(()=>checkBlockTranslation('p1-b2',blocks[1].source,'Độ dài vectơ.'),{message:'Block p1-b2 không bảo toàn ký hiệu toán.'});
 assert.throws(()=>checkBlockTranslation('p1-b2',blocks[1].source,'@@PDF_INLINE_1@@ @@PDF_INLINE_2@@'),{message:'Block p1-b2 chứa mã toán không hợp lệ.'});
 assert.throws(()=>checkBlockTranslation('p1-b2',blocks[1].source,'@@PDF_INLINE_1@@ @@MATH_0001@@'),/mã công thức không hợp lệ/u);
});

test('sample.json is checked field by field, the genres are the library genres, and publishing needs rights',async()=>{
 const workerSource=readFileSync(resolve(root,'backend/worker.js'),'utf8'),literal=workerSource.match(/const GENRES=(\[[^\]]*\])/u)?.[1];
 const library=existsSync(resolve(root,'backend/genres.js'))?(await import('./genres.js')).GENRES:Function(`return ${literal}`)();
 assert.deepEqual([...GENRES],[...library]);
 const config=validateSample({...sampleTemplate('toan-11'),title:'Toán 11 (Ví dụ mẫu)',genre:'Toán học · STEM',ranges:['5-9','12'],rights:{confirmed:true,note:'x'}},{slug:'toan-11',need:['ranges','publish']});
 assert.deepEqual(config.ranges,['5-9','12']);assert.equal(config.domain,'general');assert.equal(config.publishSource,'excerpt');
 assert.throws(()=>validateSample({slug:'other',genre:'Thể loại lạ',domain:'astronomy',publishSource:'all',ranges:'5-9',cover:0,source:'../x.pdf',glossary:{'向量':7}},{slug:'toan-11',need:['publish']}),error=>{
  for(const field of ['"slug"','"title"','"genre"','"domain"','"publishSource"','"source"','"ranges"','"cover"','"glossary"','"rights.confirmed"'])assert.match(error.message,new RegExp(field.replace('.','\\.'),'u'));return true;});
 // Every subject of the study workspace works for samples too, with its own built-in terms in RULES.md.
 for(const domain of SUBJECT_IDS)assert.equal(validateSample({...sampleTemplate('mon-hoc'),domain,publishSource:'full'},{slug:'mon-hoc'}).domain,domain);
 assert.equal(rulesGlossary({domain:'chemistry',glossary:{}},'化学键与氧化还原反应').terms['氧化还原反应'],'phản ứng oxi hóa – khử');
 assert.equal(rulesGlossary({domain:'biology',glossary:{'细胞膜':'màng sinh chất'}},'細胞膜和细胞膜').terms['細胞膜'],'màng tế bào');
 assert.equal(rulesGlossary({domain:'biology',glossary:{'细胞膜':'màng sinh chất'}},'细胞膜').terms['细胞膜'],'màng sinh chất','the book\'s own term wins');
 assert.throws(()=>validateSample(sampleTemplate('a1'),{slug:'a1',need:['ranges']}),/"ranges" chưa có trang/u);
 for(const bad of ['A','-ab','ab-','a_b','a'.repeat(65),'../x'])assert.throws(()=>validSlug(bad),/không hợp lệ/u);
 assert.equal(validSlug('toan-a1'),'toan-a1');
});

test('ranges become parts of at most 20 pages; the cover stays original, overlaps and bad ranges are refused',()=>{
 assert.deepEqual(planChunks(['1-3','5, 7–8'],100,{cover:1}),{chunks:[{range:0,pages:[2,3]},{range:1,pages:[5,7,8]}],coverExcluded:true});
 assert.deepEqual(planChunks(['1-2'],100,{cover:1,translateCover:true}).chunks[0].pages,[1,2]);
 const long=planChunks(['10-54'],100).chunks;assert.deepEqual(long.map(c=>c.pages.length),[20,20,5]);assert.deepEqual([long[1].pages[0],long[2].pages.at(-1)],[30,54]);
 assert.throws(()=>planChunks(['1'],10,{cover:1}),/chỉ có trang bìa 1/u);
 assert.throws(()=>planChunks(['3-6','6-8'],10),/Trang 6 nằm trong cả phạm vi/u);
 assert.throws(()=>planChunks(['9-12'],10),/1-10/u);assert.throws(()=>planChunks([],10),/Chưa có phạm vi/u);assert.throws(()=>planChunks([' '],10),/trống/u);
 assert.equal(pageLabel([5,6,7,9,12,13]),'5–7, 9, 12–13');assert.equal(pageArgument([5,6,7,9]),'5-7,9');assert.equal(chapterTitle([12]),'Trang 12');
});

test('the listing and template carry every block field a translator needs and no image data',()=>{
 const listing=buildListing(manifest(),{slug:'demo',chunk:'c01',file:'source.pdf'}),template=buildTemplate(manifest(),{slug:'demo',chunk:'c01'});
 assert.deepEqual(listing.pages,[7,8]);assert.equal(listing.source.totalPages,40);assert.equal(listing.pageImages[1].layer,'ocr');
 const scanned=listing.blocks.find(b=>b.id==='p8-b3');
 assert.deepEqual(scanned,{id:'p8-b3',page:8,order:2,layer:'ocr',kind:'paragraph',box:[50,150,550,180],fontSize:12,bold:false,crop:'crops/p8-b3.png',hint:'公式 @@PDF_INLINE_1@@ 成立。',hintText:'公式 x 成立。',tokens:[{token:'@@PDF_INLINE_1@@',label:'@1',ocrText:'x',box:[90,152,130,170],image:'inlines/p8-b3-1.png',trailingPunctuation:false}]});
 assert.equal('hintText' in listing.blocks[0],false);assert.equal('crop' in listing.blocks[0],false);
 assert.deepEqual(template.blocks.map(b=>Object.keys(b).join()),['id,layer,translation','id,layer,translation','id,layer,translation','id,layer,source,translation','id,layer,source,translation','id,layer,source,translation']);
 assert.equal(template.blocks[3].source,'1 . 3 平 行向 量');
 for(const value of [listing,template]){assert.doesNotMatch(JSON.stringify(value),/data:image/u);assert.deepEqual(JSON.parse(compactJson(value)),value);}
});

test('texts.json goes through the same OCR and translation checks as Gemini output and corrects the manifest like the route',()=>{
 const result=importTexts(manifest(),goodTexts(),{slug:'demo',chunk:'c01'});
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.warnings,[]);assert.deepEqual(result.info,['Khi tách trang: Trang 8: dùng OCR; hãy đối chiếu công thức với PDF gốc.']);
 const expected=applyOcrReadings(manifest(),{blocks:[{id:'p8-b1',text:'1.3 平行向量'},{id:'p8-b2',text:'两个向量所在的直线平行或重合，这些向量叫做平行向量。'},{id:'p8-b3',text:'公式 @@PDF_INLINE_1@@ 成立。'}]});
 assert.deepEqual(result.document,expected);assert.equal(result.document.ocrCorrectedVersion,1);assert.equal(result.document.pages[1].blocks[0].kind,'heading');
 assert.doesNotThrow(()=>validateLayoutDocument(result.document));
 assert.deepEqual(result.translations.map(t=>t.id),['p7-b1','p7-b2','p7-b3','p8-b1','p8-b2','p8-b3']);
 assert.deepEqual(result.stats,{blocks:6,ocrBlocks:3,corrected:3,translated:6,sourceCharacters:result.document.pages.flatMap(p=>p.blocks).reduce((n,b)=>n+b.source.length,0),translationCharacters:result.translations.reduce((n,t)=>n+t.translation.length,0)});
 // Decomposed Vietnamese and a detached tone mark are stored composed, as for Gemini answers.
 const texts=goodTexts();texts.blocks[0].translation='1.2 Các phép toán vectơ giố`ng nhau'.normalize('NFD');
 assert.equal(importTexts(manifest(),texts,{slug:'demo',chunk:'c01'}).translations[0].translation,'1.2 Các phép toán vectơ giống nhau');
});

test('every problem of texts.json is reported in one pass and nothing is half-imported',()=>{
 const texts={version:1,sample:'demo',chunk:'c01',translator:'x',blocks:[
  {id:'p7-b1',translation:''},
  {id:'p7-b2',translation:'Grassmann đã nghiên cứu các phép toán vectơ.'},
  {id:'p7-b3',translation:'Độ dài của vectơ.'},
  {id:'p7-b3',translation:'lần hai'},
  {id:'p9-b1',translation:'đoạn lạ'},
  'không phải đoạn',
  {id:'p8-b1',source:'  ',translation:'1.3 Vectơ song song'},
  {id:'p8-b3',source:'公式成立。',translation:'Công thức @@PDF_INLINE_1@@ @@MATH_0001@@ đúng.'}
 ]};
 const result=importTexts(manifest(),texts,{slug:'demo',chunk:'c01'}),found=messages(result.errors);
 for(const expected of ['Block p7-b1 không có bản dịch.','Block p7-b2 thiếu số hoặc dẫn chứng: 1844, [2].','Block p7-b3 không bảo toàn ký hiệu toán.','Đoạn p7-b3 được ghi hai lần.','Mã đoạn lạ "p9-b1" (mục 5).','Mục 6 của "blocks" không phải một đoạn.','Đoạn p8-b1: "source" (chữ Trung) trống.','Đọc ảnh không bảo toàn công thức của p8-b3.','Thiếu đoạn p8-b2.'])assert.ok(found.includes(expected),`${expected} in ${found.join(' | ')}`);
 assert.ok(found.some(m=>/mã công thức không hợp lệ/u.test(m)),'a shielded-math token is never accepted');
 assert.deepEqual(result.translations,[]);
 const shape=importTexts(manifest(),{version:2,sample:'x',chunk:'c09',glossary:[],blocks:{}},{slug:'demo',chunk:'c01'});
 assert.deepEqual(messages(shape.errors),['texts.json: "version" phải là 1.','texts.json: "sample" phải là "demo".','texts.json: "chunk" phải là "c01".','texts.json "glossary" phải là bảng {"chữ Trung":"tiếng Việt"}.','texts.json: "blocks" phải là danh sách đoạn.']);
 assert.deepEqual(messages(importTexts(manifest(),[],{slug:'demo',chunk:'c01'}).errors),['texts.json phải là một đối tượng JSON.']);
 const extra=goodTexts();extra.blocks[2].translation='Độ dài @@PDF_INLINE_1@@ và @@PDF_INLINE_2@@.';
 assert.deepEqual(messages(importTexts(manifest(),extra,{slug:'demo',chunk:'c01'}).errors),['Block p7-b3 chứa mã toán không hợp lệ.']);
});

test('readings written into the wrong blocks are caught like a Gemini answer that swapped strips',()=>{
 const doc=manifest();doc.pages[1].blocks[0].source=doc.pages[1].blocks[0].text='第一节 平行向量与共线向量的概念和性质';
 const texts=goodTexts();texts.blocks[3].source=goodTexts().blocks[4].source;texts.blocks[4].source='第一节 平行向量与共线向量的概念和性质';
 const result=importTexts(doc,texts,{slug:'demo',chunk:'c01'});
 assert.deepEqual(messages(result.errors),['Chữ Trung của các đoạn p8-b1, p8-b2 có vẻ bị ghi lẫn sang nhau; hãy kiểm tra lại.']);
});

test('warnings: Chinese left, glossary misses, changed LaTeX, ignored text-layer source and unchecked OCR hints',()=>{
 const doc=manifest();doc.pages[0].blocks[1].source=doc.pages[0].blocks[1].text='1844年，格拉斯曼研究了 \\(\\frac{1}{2}\\) 的运算[2]。';
 const texts=goodTexts();texts.translator='';texts.glossary={'空间向量':'véc-tơ không gian'};
 texts.blocks[0]={id:'p7-b1',source:'1.2 别的文字',translation:'1.2 Các phép toán vectơ trong không gian 运算'};
 texts.blocks[1].translation='Năm 1844, Grassmann đã nghiên cứu \\(\\frac12\\) [2].';
 texts.blocks[4].source='两 个向量所在的直线平行或重 合，这些向量叫 做平行向量。';delete texts.blocks[3].source;
 const result=importTexts(doc,texts,{slug:'demo',chunk:'c01'}),found=messages(result.warnings);
 assert.deepEqual(result.errors,[]);
 for(const pattern of [/chưa ghi "translator"/u,/p7-b1 thuộc trang có lớp chữ: "source" bị bỏ qua/u,/p8-b1 \(trang scan\) giữ chữ OCR máy/u,/p8-b2: chữ Trung giống hệt chữ OCR máy/u,/p7-b2: công thức \\\(\\frac\{1\}\{2\}\\\) không được chép nguyên văn/u,/Block p7-b1: còn chữ Hán chưa dịch: 运算/u,/Block p7-b1: thuật ngữ chưa theo bảng tên: 空间向量 → véc-tơ không gian/u])assert.ok(found.some(m=>pattern.test(m)),`${pattern} in ${found.join(' | ')}`);
 assert.equal(result.document.pages[0].blocks[0].source,'1.2 空间向量的运算','a text-layer source never changes');
 assert.equal(result.document.pages[1].blocks[0].ocrCorrected,undefined);assert.equal(result.document.ocrCorrectedVersion,0);
});

test('the network guard lets requests reach only the publish target and drops the Gemini key',async t=>{
 const seen=[];t.mock.method(globalThis,'fetch',async url=>{seen.push(String(url));return new Response('ok');});
 process.env.GEMINI_API_KEY_SAMPLE_TEST='x';const restore=installNetworkGuard({allow:['http://127.0.0.1:8803']});
 try{
  assert.equal(process.env.GEMINI_API_KEY_SAMPLE_TEST,undefined);
  await assert.rejects(()=>fetch('https://generativelanguage.googleapis.com/v1beta/models'),/không gọi API trả phí/u);
  await assert.rejects(()=>fetch('https://hoatri.example/api/status'),/hoatri\.example/u);
  await assert.rejects(()=>fetch(new Request('http://127.0.0.1:8787/api/status')),/127\.0\.0\.1:8787/u);
  assert.equal(await (await fetch('http://127.0.0.1:8803/api/status')).text(),'ok');
  assert.deepEqual(seen,['http://127.0.0.1:8803/api/status']);
 }finally{restore();}
});

test('targets: the local token never leaves this machine; other servers need HTTPS and their own token',async()=>{
 assert.deepEqual(resolveTarget('local'),{origin:'http://127.0.0.1:8787',local:true});
 assert.deepEqual(resolveTarget('http://localhost:8803/'),{origin:'http://localhost:8803',local:true});
 assert.deepEqual(resolveTarget('https://hoatri.example'),{origin:'https://hoatri.example',local:false});
 for(const [bad,pattern] of [['http://hoatri.example',/HTTPS/u],['https://hoatri.example/admin',/không đường dẫn/u],['https://admin:x@hoatri.example',/không đường dẫn/u],['https://generativelanguage.googleapis.com',/dịch vụ AI/u],['ftp://x',/giao thức/u],['nonsense',/không hợp lệ/u]])assert.throws(()=>resolveTarget(bad),pattern);
 const never=()=>{throw new Error('.dev.vars must not be read for a remote server');};
 assert.equal(await targetToken(resolveTarget('local'),{readDevToken:()=>'local-admin-token-1234567890'}),'local-admin-token-1234567890');
 await assert.rejects(()=>targetToken(resolveTarget('local'),{readDevToken:()=>'replace-with-a-long-random-secret'}),/ADMIN_TOKEN hợp lệ/u);
 await assert.rejects(()=>targetToken(resolveTarget('https://hoatri.example'),{env:{},readDevToken:never}),/HOATRI_ADMIN_TOKEN/u);
 assert.equal(await targetToken(resolveTarget('https://hoatri.example'),{env:{HOATRI_ADMIN_TOKEN:' remote-token '},readDevToken:never}),'remote-token');
 assert.equal(await targetToken(resolveTarget('https://hoatri.example'),{env:{},readDevToken:never,prompt:async()=>'typed-token'}),'typed-token');
 const calls=[],client=adminClient({origin:'https://hoatri.example',token:'remote-token',fetch:async(url,init)=>{calls.push({url,init});return calls.length===2?new Response(null,{status:302,headers:{Location:'https://elsewhere.example/'}}):Response.json([]);}});
 await client.call('GET','/api/library',{admin:false});
 await assert.rejects(()=>client.call('GET','/api/status'),error=>error instanceof AdminError&&error.status===302&&!/remote-token/u.test(error.message));
 assert.equal(calls[0].init.headers.Authorization,undefined);assert.equal(calls[1].init.headers.Authorization,'Bearer remote-token');
 assert.ok(calls.every(call=>call.init.redirect==='manual'&&new URL(call.url).origin==='https://hoatri.example'));
 await assert.rejects(()=>client.call('GET','https://elsewhere.example/api/status'),/không hợp lệ/u);
});

test('the tool only works inside the git-ignored samples folder',async()=>{
 assert.throws(()=>assertInsideSamples(resolve(root,'frontend/index.html')),/chỉ ghi vào thư mục samples/u);
 assert.throws(()=>assertInsideSamples(resolve(root,'samples')),/chỉ ghi/u);
 assert.doesNotThrow(()=>assertIgnored([resolve(sampleDir('zz-test-ignored'),'work','c01','texts.json')]));
 assert.throws(()=>assertIgnored([resolve(root,'backend/worker.js')]),/Git chưa bỏ qua backend\/worker\.js/u);
 const cover=coverDocument({pages:3,labels:null,toc:[[1,'封面',1],[1,'目录',-1]]});
 assert.equal(cover.numPages,3);assert.equal(await cover.getPageLabels(),null);assert.deepEqual(await cover.getOutline(),[{title:'封面',dest:[0],items:[]}]);
});

// An in-memory Hoa Trí: the real worker on node:sqlite (every migration) and a map standing in for R2.
class D1Statement{constructor(db,sql){this.statement=db.prepare(sql);this.args=[];}bind(...args){this.args=args;return this;}async first(){return this.statement.get(...this.args)||null;}async all(){return {results:this.statement.all(...this.args),success:true};}execute(){const r=this.statement.run(...this.args);return {success:true,meta:{changes:r.changes}};}async run(){return this.execute();}}
class D1Database{constructor(db){this.db=db;}prepare(sql){return new D1Statement(this.db,sql);}async batch(statements){this.db.exec('BEGIN');try{const r=statements.map(s=>s.execute());this.db.exec('COMMIT');return r;}catch(error){this.db.exec('ROLLBACK');throw error;}}}
class MemoryR2{
 constructor(){this.values=new Map();}
 async put(key,value,options={}){const bytes=typeof value==='string'?new TextEncoder().encode(value):value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice():new Uint8Array(await new Response(value).arrayBuffer());this.values.set(key,{bytes,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});}
 async get(key){const item=this.values.get(key);if(!item)return null;const bytes=item.bytes;return {body:bytes,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer,text:async()=>new TextDecoder().decode(bytes),json:async()=>JSON.parse(new TextDecoder().decode(bytes))};}
 async head(key){const item=this.values.get(key);return item?{size:item.bytes.length,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata}:null;}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix=''}={}){return {objects:[...this.values].filter(([k])=>k.startsWith(prefix)).map(([key,item])=>({key,size:item.bytes.length,customMetadata:item.customMetadata})),truncated:false};}
}
const ADMIN='admin-token-for-sample-tool-tests',TARGET='http://127.0.0.1:8803';
function server(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 const dir=resolve(root,'database/migrations');for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(dir,name),'utf8'));
 const env={DB:new D1Database(sqlite),FILES:new MemoryR2(),ADMIN_TOKEN:ADMIN};
 return {sqlite,env,fetch:(url,init)=>worker.fetch(new Request(url,init),env,{waitUntil(){},passThroughOnException(){}})};
}
const readDevToken=()=>ADMIN;
// A sample whose parts were checked by the real importer and "rendered" (a stub PDF stands in for the engine's).
async function preparedSample(t,name,{chunks=1,title='Vectơ (Ví dụ mẫu)',rights=true,cover=true}={}){
 const slug=`zz-test-${process.pid}-${name}`,dir=sampleDir(slug);await rm(dir,{recursive:true,force:true});t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={...sampleTemplate(slug),title,author:'Nhóm kiểm thử',genre:'Toán học · STEM',domain:'math',ranges:['7-8'],cover:cover?1:'none',glossary:{'向量':'vectơ'},rights:{confirmed:rights,note:'Tài liệu tự tạo.'}};
 await mkdir(resolve(dir,'work'),{recursive:true});await writeFile(resolve(dir,'sample.json'),JSON.stringify(config));
 if(cover)await writeFile(resolve(dir,'work','cover.jpg'),Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,5,6,7,8]));
 const code=await codeVersions(),parts=[];
 for(let i=0;i<chunks;i++){
  const id=`c0${i+1}`,files=chunkFiles(slug,id),doc=manifest();await mkdir(files.render,{recursive:true});
  await writeFile(files.manifest,JSON.stringify(doc));await writeFile(files.texts,JSON.stringify(goodTexts(slug,id)));
  parts.push({id,pages:[7+2*i,8+2*i],title:`Trang ${7+2*i}–${8+2*i}`,blocks:6,ocrBlocks:3,manifestSha256:sha256(await readFile(files.manifest))});
 }
 await writeFile(resolve(dir,'work','state.json'),JSON.stringify({version:1,slug,source:{file:'source.pdf',sha256:'a'.repeat(64),bytes:1,totalPages:40},cover:{page:cover?1:0,reasons:[],file:cover?'cover.jpg':null},chunks:parts,code}));
 for(const part of parts){
  const files=chunkFiles(slug,part.id),report=await checkChunk(slug,part,validateSample(config,{slug}));assert.equal(report.ok,true,JSON.stringify(report.errors));
  const pdf=Buffer.from(`%PDF-1.7\n% ${slug} ${part.id}\n`);await writeFile(files.pdf,pdf);
  await writeFile(files.renderReport,JSON.stringify({version:1,chunk:part.id,preview:false,renderVersion:RENDER_VERSION,code:{renderer:code.renderer},inputs:report.inputs,pdf:{file:`${part.id}.vi.pdf`,sha256:sha256(pdf),bytes:pdf.length},overflow:[],shrunk:[]}));
 }
 return {slug,dir,config,parts};
}
const anonymous=(fetch,path)=>fetch(TARGET+path);

// The excerpt pdf_tool would cut from source.pdf: one page per selected page, in order.
async function pdfOfPages(count,label){const doc=await PDFLib.PDFDocument.create(),font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);for(let n=1;n<=count;n++)doc.addPage([595,842]).drawText(`${label} ${n}`,{x:60,y:700,size:20,font});return Buffer.from(await doc.save());}
const subset=async(file,pages,out)=>{await writeFile(out,await pdfOfPages(pages.length,`Original page of ${pages.join(',')} #`));};

test('publish makes a sample book: kept id, parts on their original pages, the excerpt original, no job',async t=>{
 const {sqlite,env,fetch}=server(t),{slug,dir}=await preparedSample(t,'publish',{chunks:2});let globalCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{globalCalls++;throw new Error('no global fetch');});
 const quiet={target:TARGET,fetch,readDevToken,log:()=>{},subset};
 const published=await publishSample(slug,quiet);
 assert.equal(published.visibility,'public');assert.equal(published.sample,true);assert.equal(published.kept,false);assert.equal(published.chapters.length,2);
 assert.deepEqual([published.source.mode,published.source.pages,published.source.bookPages],['excerpt',5,[1,7,8,9,10]]);
 const library=await (await anonymous(fetch,'/api/library')).json(),book=library.find(s=>s.id===published.storyId);
 assert.deepEqual([book.title,book.author,book.sample,book.chapters,book.mapped_parts,book.translated_pages,book.translation_status],['Vectơ (Ví dụ mẫu)','Nhóm kiểm thử',1,2,2,4,null]);
 assert.equal(sqlite.prepare('SELECT source_url FROM stories').get().source_url,`sample:${slug}`);
 // The excerpt is the cover (page 1) then pages 7-10: the parts translate its pages 2-3 and 4-5, in page order.
 const read=await (await anonymous(fetch,`/api/read/${published.storyId}`)).json();
 assert.deepEqual(read.map(c=>[c.title,c.position,c.sample,c.source_sha256,c.source_pages]),[['Trang 7–8',1,1,published.source.sha256,[2,3]],['Trang 9–10',2,1,published.source.sha256,[4,5]]]);
 const assembly=await (await anonymous(fetch,`/api/library/${published.storyId}/assembly`)).json();
 assert.equal(assembly.sample,true);assert.deepEqual(assembly.cover,{image:true,page:1,sha256:published.source.sha256});
 assert.deepEqual(assembly.parts.map(p=>[p.id,p.pages,p.sha256,p.totalPages,p.file]),published.chapters.map((c,i)=>[c.id,i?[4,5]:[2,3],published.source.sha256,5,`/api/chapter-file/${c.id}`]));
 // The excerpt keeps the book's page numbers: its page 2 is page 7 of the book, so the reader says "Trang 7", not 2.
 assert.deepEqual(assembly.storedSources,[{sha256:published.source.sha256,pages:5,url:`/api/library/${published.storyId}/sources/${published.source.sha256}`,bookPages:[1,7,8,9,10]}]);
 assert.deepEqual(assembly.parts.map(p=>[p.title,p.bookPages]),[['Trang 7–8',[7,8]],['Trang 9–10',[9,10]]]);
 assert.deepEqual(bilingualSource(assembly,published.chapters[0].id)?.labels,[7,8]);
 assert.equal(JSON.parse(await readFile(resolve(dir,'work','excerpt.json'),'utf8')).version,EXCERPT_VERSION);
 const original=await anonymous(fetch,assembly.storedSources[0].url);assert.equal(original.status,200);assert.equal(sha256(Buffer.from(await original.arrayBuffer())),published.source.sha256);
 assert.equal(Buffer.from(await (await anonymous(fetch,`/api/chapter-file/${published.chapters[1].id}`)).arrayBuffer()).toString(),`%PDF-1.7\n% ${slug} c02\n`);
 assert.equal((await anonymous(fetch,`/api/covers/${published.storyId}`)).headers.get('Content-Type'),'image/jpeg');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0,'a sample never creates a job, so no "teacher reviewed" banner');
 assert.deepEqual(JSON.parse(sqlite.prepare('SELECT glossary FROM stories WHERE id=?').get(published.storyId).glossary),{'向量':'vectơ','平行向量':'vectơ song song'});
 const record=JSON.parse(await readFile(resolve(dir,'published.json'),'utf8'));
 assert.equal(record.targets[TARGET].storyId,published.storyId);assert.equal(record.targets[TARGET].source.sha256,published.source.sha256);assert.doesNotMatch(JSON.stringify(record),new RegExp(ADMIN,'u'));
 await assert.rejects(()=>publishSample(slug,quiet),/--replace .*\(mã sách giữ nguyên\)/u);
 // Replacing keeps the book and its links; the old parts and their files go, the cover image is swapped, not added.
 const replaced=await publishSample(slug,{...quiet,replace:true});
 assert.equal(replaced.storyId,published.storyId);assert.equal(replaced.kept,true);assert.equal(replaced.replaced,null);
 assert.deepEqual(sqlite.prepare('SELECT id,visibility FROM stories').all().map(r=>[r.id,r.visibility]),[[published.storyId,'public']]);
 const keys=[...env.FILES.values.keys()];
 assert.deepEqual(['reader/','covers/','library/'].map(prefix=>keys.filter(k=>k.startsWith(prefix)).length),[2,1,1]);
 assert.ok(published.chapters.every(c=>!keys.some(k=>k.includes(c.id))),'the replaced parts leave no file behind');
 // A changed excerpt replaces the stored original.
 const state=JSON.parse(await readFile(resolve(dir,'work','state.json'),'utf8'));state.cover.page=0;await writeFile(resolve(dir,'work','state.json'),JSON.stringify(state));
 const recut=await publishSample(slug,{...quiet,replace:true});assert.equal(recut.source.pages,4);assert.notEqual(recut.source.sha256,published.source.sha256);assert.deepEqual(recut.source.bookPages,[7,8,9,10]);
 assert.deepEqual([...env.FILES.values.keys()].filter(k=>k.startsWith('library/')),[`library/${published.storyId}/sources/${recut.source.sha256}.pdf`]);
 assert.equal(env.FILES.values.get(`library/${published.storyId}/sources/${recut.source.sha256}.pdf`).customMetadata.bookPages,'7-10');
 // unpublish hides the book in place; a draft is invisible to readers, original included.
 assert.deepEqual(await unpublishSample(slug,{target:TARGET,fetch,readDevToken}),{origin:TARGET,storyId:published.storyId,changed:true});
 assert.equal((await (await anonymous(fetch,'/api/library')).json()).length,0);
 for(const path of [`/api/read/${published.storyId}`,`/api/library/${published.storyId}/assembly`,`/api/library/${published.storyId}/sources/${recut.source.sha256}`,`/api/chapter-file/${recut.chapters[0].id}`])assert.equal((await anonymous(fetch,path)).status,404,path);
 const draft=await publishSample(slug,{...quiet,replace:true,draft:true});
 assert.equal(draft.storyId,published.storyId);assert.equal(sqlite.prepare('SELECT visibility FROM stories').get().visibility,'private');
 assert.deepEqual(await unpublishSample(slug,{target:TARGET,fetch,readDevToken}),{origin:TARGET,storyId:draft.storyId,changed:false});
 await assert.rejects(()=>removeSample(slug,{target:TARGET,fetch,readDevToken}),/chưa xác nhận/u);
 assert.deepEqual(await removeSample(slug,{target:TARGET,fetch,readDevToken,yes:true}),{origin:TARGET,storyId:draft.storyId,alreadyGone:false});
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM stories').get().n,0);assert.equal(env.FILES.values.size,0);
 assert.deepEqual(JSON.parse(await readFile(resolve(dir,'published.json'),'utf8')).targets,{});
 assert.equal(globalCalls,0,'publishing never used the global fetch (no Gemini, no other host)');
});

test('the whole source can be published instead of an excerpt, and a server without migration 0015 is refused early',async t=>{
 const {sqlite,fetch}=server(t),{slug,dir}=await preparedSample(t,'full',{cover:false}),bytes=await pdfOfPages(40,'Full page');
 await writeFile(resolve(dir,'source.pdf'),bytes);
 const state=JSON.parse(await readFile(resolve(dir,'work','state.json'),'utf8'));state.source.sha256=sha256(bytes);await writeFile(resolve(dir,'work','state.json'),JSON.stringify(state));
 const config=JSON.parse(await readFile(resolve(dir,'sample.json'),'utf8'));await writeFile(resolve(dir,'sample.json'),JSON.stringify({...config,publishSource:'full'}));
 const quiet={target:TARGET,fetch,readDevToken,log:()=>{},subset:()=>{throw new Error('no excerpt in full mode');}};
 const plan=await publishPlan(slug),source=await publishedSource(slug,plan);assert.deepEqual([source.mode,source.pages,source.sha256,source.map(8)],['full',40,sha256(bytes),8]);
 const published=await publishSample(slug,quiet);
 assert.deepEqual((await (await anonymous(fetch,`/api/read/${published.storyId}`)).json()).map(c=>c.source_pages),[[7,8]]);
 await writeFile(resolve(dir,'source.pdf'),await pdfOfPages(40,'Edited page'));
 await assert.rejects(()=>publishedSource(slug,plan),/đã đổi sau lần extract/u);
 // The same server before migration 0015: nothing is created.
 const old=new DatabaseSync(':memory:');t.after(()=>old.close());
 const migrations=resolve(root,'database/migrations');for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n<'0015').sort())old.exec(readFileSync(resolve(migrations,name),'utf8'));
 const before={DB:new D1Database(old),FILES:new MemoryR2(),ADMIN_TOKEN:ADMIN},oldFetch=(url,init)=>worker.fetch(new Request(url,init),before,{});
 const fresh=await preparedSample(t,'premigration');
 await assert.rejects(()=>publishSample(fresh.slug,{...quiet,fetch:oldFetch,subset}),/migration 0015/u);
 assert.equal(old.prepare('SELECT COUNT(*) AS n FROM stories').get().n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM stories').get().n,1);
});

test('a server that does not keep samples gets a plain book: the title must say "Ví dụ mẫu", and a replacement gets a new id',async t=>{
 const {sqlite,fetch:direct}=server(t);
 // The status answer of a server from before sample books.
 const fetch=async(url,init)=>{const response=await direct(url,init);if(new URL(url).pathname!=='/api/status')return response;const body=await response.json();delete body.samples;return Response.json(body);};
 const quiet={target:TARGET,fetch,readDevToken,log:()=>{},sleep:async()=>{},subset};
 const unlabeled=await preparedSample(t,'label',{title:'Vectơ trong không gian',cover:false});
 assert.deepEqual((await publishPlan(unlabeled.slug)).warnings,[],'the title only matters where the homepage cannot label samples');
 const logs=[];await assert.rejects(()=>publishSample(unlabeled.slug,{...quiet,log:line=>logs.push(line)}),/còn cảnh báo/u);assert.match(logs.join('\n'),/chưa có chữ “Ví dụ mẫu”/u);
 const first=await publishSample(unlabeled.slug,{...quiet,confirm:async()=>true});
 assert.deepEqual([first.visibility,first.sample,first.source],['public',false,null]);
 assert.equal(sqlite.prepare('SELECT source_url FROM stories').get().source_url,null);
 const second=await publishSample(unlabeled.slug,{...quiet,yes:true,replace:true});
 assert.notEqual(second.storyId,first.storyId);assert.equal(second.replaced,first.storyId);
 assert.deepEqual(sqlite.prepare('SELECT id FROM stories').all().map(r=>r.id),[second.storyId]);
 // Publishing the same sample once the server keeps samples swaps the plain book for a sample book.
 const upgraded=await publishSample(unlabeled.slug,{...quiet,fetch:direct,replace:true});
 assert.equal(upgraded.sample,true);assert.equal(upgraded.replaced,second.storyId);
 assert.deepEqual(sqlite.prepare('SELECT id,source_url FROM stories').all().map(r=>[r.id,r.source_url]),[[upgraded.storyId,`sample:${unlabeled.slug}`]]);
});

test('publish refuses missing rights, stale renders and a wrong token, and asks before publishing with warnings',async t=>{
 const {fetch}=server(t),quiet={target:TARGET,fetch,readDevToken,log:()=>{},subset};
 const unsure=await preparedSample(t,'rights',{rights:false});
 await assert.rejects(()=>publishSample(unsure.slug,quiet),/rights\.confirmed/u);
 const stale=await preparedSample(t,'stale',{cover:false});const texts=chunkFiles(stale.slug,'c01').texts,changed=goodTexts(stale.slug);changed.blocks[0].translation='1.2 Phép toán vectơ';
 await writeFile(texts,JSON.stringify(changed));
 await assert.rejects(()=>publishSample(stale.slug,quiet),/c01 \(Trang 7–8\): texts\.json chưa được check/u);
 await checkSample(stale.slug,'c01');
 assert.match((await publishPlan(stale.slug)).errors.join('\n'),/chưa render bản mới nhất/u);
 // A warning of the plan (the cover image went missing) needs --yes or a confirmation.
 const warned=await preparedSample(t,'warned');await rm(resolve(warned.dir,'work','cover.jpg'));
 assert.match((await publishPlan(warned.slug)).warnings.join('\n'),/cover\.jpg/u);
 await assert.rejects(()=>publishSample(warned.slug,quiet),/còn cảnh báo/u);
 await assert.rejects(()=>publishSample(warned.slug,{...quiet,yes:true,readDevToken:()=>'wrong-admin-token-123456'}),/không được http:\/\/127\.0\.0\.1:8803 chấp nhận/u);
 const done=await publishSample(warned.slug,{...quiet,confirm:async()=>true});assert.equal(done.visibility,'public');
 // localOnly: a book still under copyright is shown only by this machine's own server.
 const local=await preparedSample(t,'local-only');const config=JSON.parse(await readFile(resolve(local.dir,'sample.json'),'utf8'));
 await writeFile(resolve(local.dir,'sample.json'),JSON.stringify({...config,rights:{confirmed:false,localOnly:true}}));
 await assert.rejects(()=>publishSample(local.slug,{...quiet,target:'https://hoatri.example'}),/rights\.localOnly/u);
});

// The real engines (extract.py through PyMuPDF and Tesseract, the Puppeteer renderer), as on the owner's machine.
const runtime=resolve(root,'.runtime/pdf-python'),tessdata=process.env.TESSDATA_PREFIX||resolve(root,'.runtime/tessdata'),python=process.env.PDF_PYTHON||'python';
const browser=process.env.CHROMIUM_EXECUTABLE_PATH||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
const ready=existsSync(runtime)&&existsSync(resolve(tessdata,'chi_sim.traineddata'))&&Boolean(browser)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
test('a synthetic text-layer page and scanned page go through extract, check and render without any model call',{skip:ready?false:'needs Python with .runtime/pdf-python, tessdata and Edge/Chromium (npm run setup)',timeout:300000},async t=>{
 const {pdfTool}=await import('../tools/samples/lib/machine.mjs'),{extractSample,extractPages}=await import('../tools/samples/lib/extract.mjs');
 let globalCalls=0;t.mock.method(globalThis,'fetch',async()=>{globalCalls++;throw new Error('no network');});
 const slug=`zz-test-${process.pid}-engine`,dir=sampleDir(slug);await rm(dir,{recursive:true,force:true});t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(dir,{recursive:true});await pdfTool(['fixture',resolve(dir,'source.pdf')]);
 await writeFile(resolve(dir,'sample.json'),JSON.stringify({...sampleTemplate(slug),title:'Mẫu thử (Ví dụ mẫu)',genre:'Toán học · STEM',domain:'math',ranges:['1-2'],cover:'none',rights:{confirmed:true,note:'Tài liệu tự tạo.'}}));
 const state=await extractSample(slug,{log:()=>{}});
 assert.equal(state.chunks.length,1);assert.deepEqual(state.chunks[0].pages,[1,2]);assert.ok(state.chunks[0].ocrBlocks>=1,'page 2 is read as a scan');
 const files=chunkFiles(slug,'c01'),listing=JSON.parse(await readFile(files.blocks,'utf8')),template=JSON.parse(await readFile(files.template,'utf8'));
 assert.ok(listing.blocks.some(b=>b.layer==='text')&&listing.blocks.some(b=>b.layer==='ocr'));
 for(const b of listing.blocks.filter(b=>b.layer==='ocr'))assert.ok(existsSync(resolve(files.dir,b.crop)),b.crop);
 for(const image of listing.pageImages)assert.ok(existsSync(resolve(files.dir,image.image))&&existsSync(resolve(files.dir,image.boxes)));
 assert.doesNotMatch(await readFile(files.blocks,'utf8'),/data:image/u);assert.match(await readFile(resolve(dir,'work','RULES.md'),'utf8'),/IMAGE is authoritative/u);
 // A source over 25 MB is cut to its selected pages first; that gives the same manifest as the whole file.
 const bytes=await readFile(resolve(dir,'source.pdf')),engine=await import('../services/pdf-layout/engine.mjs'),options={source:resolve(dir,'source.pdf'),whole:bytes.toString('base64'),pages:[2],totalPages:2,pythonOperation:engine.pythonOperation,scratch:resolve(dir,'work')};
 assert.deepEqual((await extractPages({...options,cut:true})).document,(await extractPages(options)).document);
 const texts={...template,translator:'Kiểm thử',blocks:template.blocks.map(b=>{const hint=listing.blocks.find(x=>x.id===b.id).hint,tokens=hint.match(/@@PDF_INLINE_\d+@@/gu)||[];return {...b,...(b.layer==='ocr'?{source:hint.replace(/\s+/gu,'')}:{}),translation:`Đoạn dịch thử ${b.id}. ${[...tokens,...missingTranslationMarkers(hint,'')].join(' ')}`.trim()};})};
 await writeFile(files.texts,JSON.stringify(texts));
 const [checked]=await checkSample(slug);assert.equal(checked.report.ok,true,JSON.stringify(checked.report.errors));
 const [rendered]=await renderSample(slug,'c01',{log:()=>{}});assert.equal(rendered.error,undefined);assert.deepEqual(rendered.rendered.overflow,[]);
 assert.equal((await pdfTool(['info',files.pdf])).pages,2);for(const n of [1,2])assert.ok(existsSync(resolve(files.render,`p${n}.compare.png`)));
 const ready=await publishPlan(slug);assert.deepEqual(ready.errors,[]);
 // The original readers get is cut by PyMuPDF: one page per translated page, and a second call reuses it.
 const excerpt=await publishedSource(slug,ready);assert.deepEqual([excerpt.mode,excerpt.pages,excerpt.map(2)],['excerpt',2,2]);
 assert.equal((await pdfTool(['info',resolve(dir,'work','excerpt.pdf')])).pages,2);
 assert.equal((await publishedSource(slug,ready,{subset:()=>{throw new Error('cut again');}})).sha256,excerpt.sha256);
 // Too long for its box: the export is refused; a preview shows it and cannot be published.
 texts.blocks[0].translation=`${'Một câu dịch rất dài vượt khỏi khung. '.repeat(60)}`;await writeFile(files.texts,JSON.stringify(texts));
 assert.match((await renderSample(slug,'c01',{log:()=>{}}))[0].error,/không vừa box/u);
 const [preview]=await renderSample(slug,'c01',{previewOverflow:true,log:()=>{}});
 assert.equal(preview.rendered.preview,true);assert.ok(preview.rendered.overflow.includes(texts.blocks[0].id));assert.ok(existsSync(files.preview));
 assert.match((await publishPlan(slug)).errors.join('\n'),/chưa render bản mới nhất/u);
 assert.equal(globalCalls,0);
});

test('publish --replace takes the old cover off a kept book whose new publish has none; a server that cannot is refused first',async t=>{
 const {sqlite,env,fetch}=server(t),{slug,dir}=await preparedSample(t,'cover-off'),quiet={target:TARGET,fetch,readDevToken,log:()=>{},subset};
 const first=await publishSample(slug,quiet),cover=()=>({...sqlite.prepare('SELECT cover_key,cover_page,cover_source_sha256 FROM stories WHERE id=?').get(first.storyId)});
 assert.ok(cover().cover_key);assert.equal((await anonymous(fetch,`/api/covers/${first.storyId}`)).status,200);
 // The new publish has no cover (work/cover.jpg gone, or "cover": "none").
 await rm(resolve(dir,'work','cover.jpg'));assert.equal((await publishPlan(slug)).cover,null);
 // A server that cannot remove a cover is refused before the book is hidden or emptied.
 const older=async(url,init)=>{const response=await fetch(url,init);if(new URL(url).pathname!=='/api/status')return response;const body=await response.json();delete body.sampleFeatures;return Response.json(body);};
 const parts=sqlite.prepare('SELECT id FROM chapters ORDER BY id').all().map(r=>r.id);
 await assert.rejects(()=>publishSample(slug,{...quiet,fetch:older,replace:true,yes:true}),/chưa xóa được ảnh bìa/u);
 assert.equal(sqlite.prepare('SELECT visibility FROM stories WHERE id=?').get(first.storyId).visibility,'public');assert.deepEqual(sqlite.prepare('SELECT id FROM chapters ORDER BY id').all().map(r=>r.id),parts,'nothing changed');
 const logs=[],replaced=await publishSample(slug,{...quiet,replace:true,yes:true,log:line=>logs.push(line)});
 assert.equal(replaced.storyId,first.storyId);assert.match(logs.join('\n'),/Ảnh bìa cũ: đã xóa/u);
 assert.deepEqual(cover(),{cover_key:null,cover_page:null,cover_source_sha256:null});
 assert.equal((await anonymous(fetch,`/api/covers/${first.storyId}`)).status,404);assert.deepEqual([...env.FILES.values.keys()].filter(k=>k.startsWith('covers/')),[]);
 assert.equal((await (await anonymous(fetch,'/api/library')).json()).find(s=>s.id===first.storyId).cover_key,null);
 assert.equal(JSON.parse(await readFile(resolve(dir,'published.json'),'utf8')).targets[TARGET].cover,null);
 // The route is the admin's only: a reader cannot take a cover off.
 assert.equal((await fetch(`${TARGET}/api/stories/${first.storyId}/cover`,{method:'DELETE'})).status,401);
});

test('a server that does not keep book pages still gets the excerpt (with a warning) and no X-Book-Pages',async t=>{
 const {env,fetch:direct}=server(t),{slug}=await preparedSample(t,'no-book-pages',{cover:false}),headers=[];
 const fetch=async(url,init)=>{if(init?.method==='PUT')headers.push(init.headers);const response=await direct(url,init);if(new URL(url).pathname!=='/api/status')return response;const body=await response.json();delete body.sampleFeatures;return Response.json(body);};
 const quiet={target:TARGET,fetch,readDevToken,log:()=>{},subset},logs=[];
 await assert.rejects(()=>publishSample(slug,{...quiet,log:line=>logs.push(line)}),/còn cảnh báo/u);assert.match(logs.join('\n'),/chưa ghi được số trang sách/u);
 const published=await publishSample(slug,{...quiet,yes:true});
 assert.deepEqual(published.source.bookPages,[7,8]);assert.equal(headers.length,1);assert.equal(headers[0]['X-Book-Pages'],undefined);
 const stored=[...env.FILES.values].find(([key])=>key.startsWith('library/'))[1];assert.deepEqual(stored.customMetadata,{filename:'Vectơ (Ví dụ mẫu) (trích đoạn bản gốc).pdf',pages:'2'});
});

test('the translator\'s terms and the terms check take the longest term: 质量数 is số khối, never 质量 = khối lượng inside it',()=>{
 const rules=rulesGlossary({domain:'physics',glossary:{}},'原子核的质量数与质量亏损。').terms;
 assert.deepEqual([rules['质量数'],rules['质量亏损'],rules['质量']],['số khối','độ hụt khối',undefined]);
 assert.equal(rulesGlossary({domain:'physics',glossary:{}},'物体的质量。').terms['质量'],'khối lượng','on its own it is still a term');
 // The book's own term 质量 is not asked for inside 质量数, where the subject knows the compound; on its own it is.
 const block=(source,translation)=>{const doc=manifest();doc.pages[0].blocks[1].source=doc.pages[0].blocks[1].text=source;const texts=goodTexts();texts.glossary={'质量':'khối lượng'};texts.blocks[1].translation=translation;return messages(importTexts(doc,texts,{slug:'demo',chunk:'c01',domain:'physics'}).warnings).filter(m=>/bảng tên/u.test(m));};
 assert.deepEqual(block('1844年，原子核的质量数为A[2]。','Năm 1844, số khối của hạt nhân là A [2].'),[]);
 assert.deepEqual(block('1844年，物体的质量为m[2]。','Năm 1844, vật nặng m [2].'),['Block p7-b2: thuật ngữ chưa theo bảng tên: 质量 → khối lượng']);
 assert.deepEqual(block('1844年，物体的质量为m[2]。','Năm 1844, khối lượng của vật là m [2].'),[]);
});

// pdf_tool.py through PyMuPDF only (no OCR data or browser needed).
const pymupdf=existsSync(runtime)&&spawnSync(python,['--version'],{windowsHide:true}).status===0;
test('the excerpt carries the book\'s page numbers as page labels, and "Tải cả quyển" keeps them',{skip:pymupdf?false:'needs Python with .runtime/pdf-python (npm run setup)'},async t=>{
 const {pdfTool}=await import('../tools/samples/lib/machine.mjs'),{assembleBook}=await import('../frontend/book-assembly.js'),pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const dir=sampleDir(`zz-test-${process.pid}-labels`);await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
 const book=resolve(dir,'source.pdf'),out=resolve(dir,'excerpt.pdf');await writeFile(book,await pdfOfPages(12,'Book page'));
 const labels=async bytes=>{const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0,isEvalSupported:false}).promise;try{return {pages:doc.numPages,labels:await doc.getPageLabels()};}finally{await doc.loadingTask.destroy();}};
 assert.deepEqual((await pdfTool(['subset',book,JSON.stringify([1,7,8,9,10,12]),out])).labels,['1','7','8','9','10','12']);
 const excerpt=await readFile(out);assert.deepEqual(await labels(excerpt),{pages:6,labels:['1','7','8','9','10','12']});
 const sha='e'.repeat(64),part={id:'p1',title:'Trang 7–8',mime:'application/pdf',file:'/p1',pages:[2,3],sha256:sha,filename:'x.pdf',totalPages:6};
 const result=await assembleBook({PDFLib,pdfjs:null,title:'Mẫu',sources:[{key:sha,sha256:sha,filename:'x.pdf',totalPages:6,filenames:new Set(['x.pdf']),parts:[part]}],loadSource:async()=>excerpt,loadPart:async()=>pdfOfPages(2,'Ban dich'),pageCounts:new Map([[sha,6]])});
 assert.deepEqual(await labels(result.bytes),{pages:6,labels:['1','7','8','9','10','12']},'the downloaded book shows page 7 where the book has page 7');
});
