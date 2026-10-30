import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {translate,translateAndVerify,textProblems,protectMathExpressions,exposeWords,OCR_INSTRUCTION,TRANSLATION_INSTRUCTION,TEXT_REPAIR_INSTRUCTION,PROMPT_VERSION} from './ai.js';
import {processJob} from './worker.js';
import {sqliteEnvironment} from './test-support/sqlite-d1.mjs';

// Text mode (admin books, a student's TXT/DOCX/EPUB/AZW3 or PDF read as text): every translation is checked line by line
// without a token, and the places found are asked for once, together, in every mode. Gemini is a stub here: no call
// leaves the machine. The Chinese below was written for these tests.
const usage={promptTokenCount:100,candidatesTokenCount:40,totalTokenCount:140};
const reply=value=>Response.json({usageMetadata:usage,candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
const translated=text=>({translation:text,contextUpdate:'',glossaryUpdates:{}});
// answers: one per call, a value or a function of the request's payload.
function gemini(t,answers){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body),part=body.contents[0].parts[0],payload=part.text?JSON.parse(part.text):part,instruction=body.systemInstruction.parts[0].text;
  calls.push({url:String(url),body,payload,instruction});const answer=answers[Math.min(calls.length,answers.length)-1];
  return reply(typeof answer==='function'?answer(payload):answer);
 });
 return calls;
}
const env={GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-2.5-flash-lite'},story={genre:'Lịch sử Trung Hoa',glossary:'{}',context:''};
const SOURCE=['第一章 河流与城市','古代的城市大多沿河而建，河流提供了水源和交通。','商人通过水路运送粮食和布匹，城市因此繁荣起来。'].join('\n\n');
const CLEAN=['Chương 1. Sông ngòi và thành thị','Các thành thị thời cổ phần lớn được xây dọc theo sông; sông ngòi cung cấp nguồn nước và đường giao thông.','Thương nhân chở lương thực và vải vóc bằng đường thủy, nhờ đó thành thị trở nên phồn thịnh.'].join('\n\n');
// The repair request answers each item with its draft corrected by fix(item).
const repaired=fix=>payload=>({items:payload.items.map(item=>({id:item.id,translation:fix(item)}))});

test('A part whose translation keeps Chinese glued to a Vietnamese word is corrected once, with only that paragraph sent',async t=>{
 const leaked=CLEAN.replace('phồn thịnh','phồn荣');
 const calls=gemini(t,[translated(leaked),repaired(item=>item.draft.replace('phồn荣','phồn thịnh'))]);
 const result=await translateAndVerify(env,SOURCE,story);
 assert.equal(calls.length,2);assert.equal(calls[1].instruction,TEXT_REPAIR_INSTRUCTION);
 assert.deepEqual(calls[1].payload.items,[{id:'d1',source:'商人通过水路运送粮食和布匹，城市因此繁荣起来。',draft:'Thương nhân chở lương thực và vải vóc bằng đường thủy, nhờ đó thành thị trở nên phồn荣.',chinese:['荣']}]);
 assert.deepEqual(calls[1].body.generationConfig.responseJsonSchema.required,['items']);
 assert.equal(result.translation,CLEAN);assert.deepEqual(result.warnings,[]);
 assert.equal(result.retried,true);assert.equal(result.repairScope,'partial');assert.equal(result.usage.requests,2);assert.equal(result.usage.total,280);
});

test('A heading kept in Chinese, or in Chinese with its Vietnamese after it, is found; the Hán-Việt reading with the Chinese in parentheses is not',()=>{
 const echoed=CLEAN.replace('Chương 1. Sông ngòi và thành thị','第一章 河流与城市');
 assert.deepEqual(textProblems(SOURCE,echoed).places.map(place=>place.chinese),[['第一章','河流与城市']]);
 assert.deepEqual(textProblems(SOURCE,CLEAN.replace('Chương 1. Sông ngòi và thành thị','河流与城市 (Sông ngòi và thành thị)')).places.map(place=>place.chinese),[['河流与城市']]);
 assert.deepEqual(textProblems('张三和李四。','Trương Tam (张三) và Lý Tứ (李四).').places,[]);
 // Bibliographies keep a cited title in Chinese with its Vietnamese rendering after it.
 assert.deepEqual(textProblems('参见《论语》。','Xem 《论语》 (Luận ngữ).').places,[]);
 assert.deepEqual(textProblems('参见《论语》。','Xem 《论语》.').places.map(place=>place.chinese),[['论语']]);
});

test('A dropped heading is found and put back on its own line by the one correction',async t=>{
 const dropped=CLEAN.split('\n\n').slice(1).join('\n\n');
 const found=textProblems(SOURCE,dropped);
 assert.equal(found.places.length,1);assert.deepEqual(found.places[0].lines,[0]);
 const calls=gemini(t,[translated(dropped),repaired(item=>`Chương 1. Sông ngòi và thành thị\n${item.draft}`)]);
 const result=await translateAndVerify(env,SOURCE,story);
 assert.equal(calls.length,2);assert.deepEqual(calls[1].payload.items[0].missingLines,['第一章 河流与城市']);
 assert.ok(calls[1].payload.items[0].source.startsWith('第一章 河流与城市\n古代的城市'),calls[1].payload.items[0].source);
 assert.equal(result.translation,CLEAN);assert.deepEqual(result.warnings,[]);
 // Glued to its paragraph the heading is missing all the same.
 const glued=CLEAN.replace('thị\n\nCác','thị. Các');
 assert.deepEqual(textProblems(SOURCE,glued).places.map(place=>place.lines),[[0]]);
 // A correction that adds a line the translation already has beside the place (a line named missing where it was not)
 // is refused: no second copy.
 const [,body,next]=CLEAN.split('\n\n');
 gemini(t,[translated(dropped),repaired(item=>`${next}\n${item.draft}`)]);
 const kept=await translateAndVerify(env,SOURCE,story);
 assert.equal(kept.translation,dropped);assert.deepEqual(kept.warnings,['Đoạn 1: bản dịch có thể thiếu dòng “第一章 河流与城市”']);assert.ok(body);
});

// An owner-style session: a scan read on the device (wrapped lines kept apart, a margin note, a figure's letters), whose
// translation joins the wrapped lines, keeps headings, items and captions on their own lines and drops the letters.
const SESSION_SOURCE=['2.1 直线的方程','练习','我们先回顾直线的倾斜角与斜率，再研究直线方程的几','种形式。','想一想，斜率不存','在时怎么办？','(1)写出经过点A的直线方程；','(2)求直线与坐标轴围成的面积。','B','A','图2.1-1','探究','如图2.1-1，直线l经过两点，求它的方程。','①','12'].join('\n\n');
const SESSION=['2.1 Phương trình đường thẳng','Luyện tập','Trước hết chúng ta ôn lại góc nghiêng và hệ số góc của đường thẳng, rồi nghiên cứu một số dạng của phương trình đường thẳng.','Hãy nghĩ xem, khi hệ số góc không tồn tại thì làm thế nào?','(1) Viết phương trình đường thẳng đi qua điểm A;','(2) Tính diện tích hình tạo bởi đường thẳng và các trục tọa độ.','Hình 2.1-1','Khám phá','Như Hình 2.1-1, đường thẳng l đi qua hai điểm, hãy tìm phương trình của nó.','12'].join('\n\n');

test('A clean part costs nothing more: no place is found and no second call is made',async t=>{
 assert.deepEqual(textProblems(SESSION_SOURCE,SESSION).places,[]);
 const calls=gemini(t,[translated(SESSION)]);
 const result=await translateAndVerify(env,SESSION_SOURCE,{...story,genre:'Toán học · STEM'});
 assert.equal(calls.length,1);assert.deepEqual(result.warnings,[]);assert.equal(result.retried,false);assert.equal(result.repairScope,'none');assert.equal(result.usage.requests,1);
 // An OCR that misread a label's separator (1.11 for 1.1-1) is no miss when the translation writes it right.
 assert.deepEqual(textProblems('如图1.11，向量a的起点是A。','Như Hình 1.1-1, vectơ a có điểm đầu là A.').places,[]);
});

test('A dropped caption, item or footnote marker is found where it belongs',()=>{
 const without=(text,line)=>text.split('\n\n').filter(item=>item!==line).join('\n\n');
 const caption=textProblems(SESSION_SOURCE,without(SESSION,'Hình 2.1-1'));
 assert.deepEqual(caption.places.map(place=>place.lines.map(i=>caption.S[i])),[['图2.1-1']]);
 const item=textProblems(SESSION_SOURCE,without(SESSION,'(2) Tính diện tích hình tạo bởi đường thẳng và các trục tọa độ.'));
 assert.deepEqual(item.places.map(place=>place.lines.map(i=>item.S[i])),[['(2)求直线与坐标轴围成的面积。']]);
 const heading=textProblems(SESSION_SOURCE,without(SESSION,'Khám phá'));
 assert.deepEqual(heading.places.map(place=>place.lines.map(i=>heading.S[i])),[['探究']]);
 const marker=textProblems('甲'.repeat(80)+'。\n\n史料记载[12]，事在1644年。','Đoạn đầu.\n\nSử liệu ghi chép, việc xảy ra năm 1644.');
 assert.deepEqual(marker.places.map(place=>[place.at,place.numbers]),[[[1,1],['[12]']]]);
});

test('A correction that rewrites the draft, drops a formula or adds Chinese is refused: the first translation stays, named for review',async t=>{
 const formula='\\(S=\\frac{1}{2}ah\\)',source=`已知三角形的面积 ${formula}，求高。\n\n商人运送布匹，城市繁荣。`;
 const draft=`Cho diện tích tam giác ${formula}, tìm chiều cao.\n\nThương nhân chở vải vóc, thành thị phồn荣.`,asked=text=>translated(text.replace(formula,'@@MATH_0001@@'));
 for(const answer of [
  repaired(()=>'Một câu khác hẳn, không còn giữ ý của bản dịch.'),
  repaired(item=>item.draft.replace('phồn荣','phồn thịnh').replace('Thương nhân','商人')),
  {items:[]},
  {translation:'không đúng dạng'}
 ]){
  const calls=gemini(t,[asked(draft),answer]);
  const result=await translateAndVerify(env,source,story);
  assert.equal(calls.length,2);assert.equal(result.translation,draft);assert.equal(result.usage.requests,2);
  assert.ok(result.warnings.includes('Đoạn 2: còn chữ Hán chưa dịch: 荣'),JSON.stringify(result.warnings));
 }
 // A correction that loses a formula is refused; one that keeps it byte for byte is taken. Each place is judged alone.
 const leaky=draft.replace('chiều cao.','chiều cao 高.'),fixed=draft.replace('phồn荣','phồn thịnh');
 let calls=gemini(t,[asked(leaky),repaired(item=>item.draft.replace(' 高','').replace(formula,'S = ah/2').replace('phồn荣','phồn thịnh'))]);
 let result=await translateAndVerify(env,source,story);
 assert.equal(calls.length,2);assert.equal(result.translation,leaky.replace('phồn荣','phồn thịnh'));assert.deepEqual(result.warnings,['Đoạn 1: còn chữ Hán chưa dịch: 高']);
 calls=gemini(t,[asked(leaky),repaired(item=>item.draft.replace(' 高','').replace('phồn荣','phồn thịnh'))]);
 result=await translateAndVerify(env,source,story);
 assert.equal(calls.length,2);assert.equal(result.translation,fixed);assert.deepEqual(result.warnings,[]);
});

test('An admin book job corrects its part once in its own mode, and an image read on its own keeps its running head as a line',async t=>{
 const {sqlite,env}=sqliteEnvironment(t,{vars:{GEMINI_API_KEY:'server-key',GEMINI_MODEL:'gemini-2.5-flash'}});
 sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách thư viện','Lịch sử Trung Hoa')").run();
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,mime,source,mode) VALUES('j1','s1','bai.txt','text/plain',?,'economy')").run(SOURCE);
 let calls=gemini(t,[translated(CLEAN.replace('phồn thịnh','phồn荣')),repaired(item=>item.draft.replace('phồn荣','phồn thịnh'))]);
 await processJob('j1',env);
 let job=sqlite.prepare('SELECT status,translation,warnings,ai_requests FROM jobs WHERE id=?').get('j1');
 assert.equal(calls.length,2);assert.equal(calls[1].instruction,TEXT_REPAIR_INSTRUCTION);assert.equal(job.translation,CLEAN);assert.deepEqual(JSON.parse(job.warnings),[]);assert.equal(job.ai_requests,2);
 // A photo of a page: the reading's marks go, its running head stays a line of the source to translate.
 sqlite.prepare("INSERT INTO jobs(id,story_id,filename,file_key,mime,mode) VALUES('j2','s1','trang.png','uploads/j2','image/png','economy')").run();
 await env.FILES.put('uploads/j2',new Uint8Array([137,80,78,71]));
 calls=gemini(t,[{text:'[đầu trang] 地理选修一\n第一章 河流与城市\n[chân trang] 资料分享网',warnings:[]}]);
 await processJob('j2',env);
 const checkpoint=JSON.parse(new TextDecoder().decode(env.FILES.values.get('processing/j2.json').bytes));
 assert.equal(calls.length,1);assert.equal(checkpoint.source,'[Trang PDF 1–1]\n地理选修一\n第一章 河流与城市\n资料分享网');
});

test('Without allowRepair the places are only named, with no second call',async t=>{
 const calls=gemini(t,[translated(CLEAN.replace('phồn thịnh','phồn荣'))]);
 const result=await translateAndVerify(env,SOURCE,story,{allowRepair:false});
 assert.equal(calls.length,1);assert.deepEqual(result.warnings,['Đoạn 3: còn chữ Hán chưa dịch: 荣']);assert.equal(result.retried,false);
});

test('Every place of a part goes in one request, at most 24 000 characters of sources and drafts',async t=>{
 // Each source line names its scholar; the stub translates each line it is sent, leaving one Chinese character.
 const line=(n,tail='')=>`第${n}位学者讨论了城市与河流的关系，并引用了大量的地方志材料。${tail}`,leak=(n,tail='')=>`Học giả thứ ${n} bàn về quan hệ giữa thành thị và sông ngòi, dẫn nhiều tư liệu địa phương和.${tail}`;
 const answer=tail=>payload=>payload.items?repaired(item=>item.draft.replace('phương和','phương'))(payload):translated(payload.source.split('\n\n').filter(Boolean).map(text=>leak(Number(text.match(/第(\d+)位/u)[1]),tail)).join('\n\n'));
 let calls=gemini(t,[answer('')]);
 const result=await translateAndVerify(env,Array.from({length:40},(_,i)=>line(i+1)).join('\n\n'),story);
 assert.equal(calls.length,2);assert.equal(calls[1].payload.items.length,40);assert.doesNotMatch(result.translation,/和/u);assert.deepEqual(result.warnings,[]);
 calls=gemini(t,[answer(' tư liệu'.repeat(80))]);
 const partial=await translateAndVerify(env,Array.from({length:40},(_,i)=>line(i+1,'资料'.repeat(80))).join('\n\n'),story);
 const sent=calls.at(-1).payload.items;assert.ok(sent.length<40&&sent.length>0,`${sent.length} places sent`);
 assert.ok(sent.reduce((sum,item)=>sum+item.source.length+item.draft.length,0)<=24000);
 assert.equal(partial.warnings.length,40-sent.length);assert.equal(calls.filter(call=>call.payload.items).length,1);
});

test('Chinese inside a formula reaches the model; other formulas stay shielded, and a price is no formula',async t=>{
 const calls=gemini(t,[payload=>translated(payload.source.replace('当','Khi').replace('时，面积','thì diện tích').replace('\\text{底}','\\text{đáy}').replace('\\text{高}','\\text{cao}'))]);
 const result=await translate(env,'当 \\(x>0\\) 时，面积 \\(S=\\text{底}\\times\\text{高}\\)',{...story,genre:'Toán học · STEM'});
 assert.equal(calls[0].payload.source,'当 @@MATH_0001@@ 时，面积 \\(S=\\text{底}\\times\\text{高}\\)');
 assert.equal(result.translation,'Khi \\(x>0\\) thì diện tích \\(S=\\text{đáy}\\times\\text{cao}\\)');
 assert.deepEqual(exposeWords(protectMathExpressions('速度 \\(v=\\frac{路程}{时间}\\) 与 \\(t>0\\)')).formulas.map(f=>f.formula),['\\(t>0\\)']);
 // Pandoc's rule for a single $: no space just inside either dollar, no digit right after the closing one.
 assert.deepEqual(protectMathExpressions('票价为 $5 和 $8 两种，学生半价。').formulas,[]);
 assert.deepEqual(protectMathExpressions('价格$5，折后$3。').formulas,[]);
 assert.deepEqual(protectMathExpressions('设 $x^2$ 与 $a_n$ 。').formulas.map(f=>f.formula),['$x^2$','$a_n$']);
});

test('A term Gemini proposes is learned only with a Vietnamese reading, never as Chinese alone',async t=>{
 gemini(t,[{translation:'Ngụy Phỉ Đức (魏斐德) và Hồng Nghiệp.',contextUpdate:'',glossaryUpdates:{'魏斐德':'Ngụy Phỉ Đức (魏斐德)','洪业':'洪业','史景迁':'史景迁 (Sử Cảnh Khiên)','清朝':'nhà Thanh'}}]);
 const result=await translate(env,'魏斐德与洪业。',story);
 assert.deepEqual(Object.keys(result.glossary).filter(key=>['魏斐德','洪业','史景迁','清朝'].includes(key)).sort(),['清朝','魏斐德']);
});

// The one correction is weighed with the Chinese it replaces at its Vietnamese length (3.5 letters a character): a
// sentence or a whole paragraph Gemini left in Chinese, short or long, is translated by it.
test('A sentence or a paragraph left in Chinese, short or long, is translated by the one correction',async t=>{
 const long='古代的城市大多沿河而建，河流提供了水源和交通。商人通过水路运送粮食和布匹，城市因此繁荣起来。随着人口的增长，城市的规模不断扩大。';
 const longVi='Các thành thị thời cổ phần lớn được xây dọc theo sông; sông ngòi cung cấp nguồn nước và đường giao thông. Thương nhân chở lương thực và vải vóc bằng đường thủy, nhờ đó thành thị trở nên phồn thịnh. Cùng với sự gia tăng dân số, quy mô thành thị không ngừng mở rộng.';
 const [heading,first,second]=SOURCE.split('\n\n'),[headingVi,firstVi,secondVi]=CLEAN.split('\n\n');
 for(const [source,draft,clean] of [[SOURCE,[headingVi,firstVi,second].join('\n\n'),CLEAN],[[heading,long,first].join('\n\n'),[headingVi,long,firstVi].join('\n\n'),[headingVi,longVi,firstVi].join('\n\n')]]){
  const calls=gemini(t,[translated(draft),repaired(item=>item.draft===second?secondVi:item.draft===long?longVi:item.draft)]);
  const result=await translateAndVerify(env,source,story);
  assert.equal(calls.length,2);assert.equal(result.translation,clean);assert.deepEqual(result.warnings,[]);
 }
});

// A correction for a line named missing must add that line: a copy of a line the draft or its neighbours hold, word for
// word or reworded, is refused, and so are lines that leave the named line missing; a heading opening a page goes in
// after the page's marker, which stays.
test('A correction that adds a copy or a line of its own is refused; a heading opening a page goes in after its page marker',async t=>{
 const dropped=CLEAN.split('\n\n').slice(1).join('\n\n');
 for(const answer of [item=>`${item.draft}\n${item.draft}`,item=>`Các thành thị thời cổ phần lớn được xây dọc sông, sông ngòi cung cấp nguồn nước và giao thông.\n${item.draft}`]){
  const calls=gemini(t,[translated(dropped),repaired(answer)]);
  const result=await translateAndVerify(env,SOURCE,story);
  assert.equal(calls.length,2);assert.equal(result.translation,dropped);assert.deepEqual(result.warnings,['Đoạn 1: bản dịch có thể thiếu dòng “第一章 河流与城市”']);
 }
 // An item put back without its number leaves item 2 missing: the lines it added are taken out again.
 const items=['练习','(1) 计算长方形的面积。','(2) 求正方形的周长。','(3) 画出三角形的高。'].join('\n\n'),without=['Luyện tập','(1) Tính diện tích hình chữ nhật.','(3) Vẽ đường cao của tam giác.'].join('\n\n');
 const asked=gemini(t,[translated(without),repaired(item=>item.draft.replace('(3)','Tìm chu vi hình vuông.\n(3)'))]);
 const kept=await translateAndVerify(env,items,story);
 assert.equal(asked.length,2);assert.equal(kept.translation,without);assert.deepEqual(kept.warnings.map(warning=>warning.replace(/^Đoạn \d+: /u,'')),['bản dịch có thể thiếu dòng “(2) 求正方形的周长。”']);
 const source='[Trang PDF 4]\n古代的城市大多沿河而建，河流提供了水源和交通。\n\n[Trang PDF 5]\n第二节 商业\n商人通过水路运送粮食和布匹，城市因此繁荣起来。';
 const draft='[Trang PDF 4]\nCác thành thị thời cổ phần lớn được xây dọc theo sông; sông ngòi cung cấp nguồn nước và đường giao thông.\n\n[Trang PDF 5]\nThương nhân chở lương thực và vải vóc bằng đường thủy, nhờ đó thành thị trở nên phồn thịnh.';
 const calls=gemini(t,[translated(draft),repaired(item=>`Mục 2. Thương nghiệp\n${item.draft}`)]);
 const result=await translateAndVerify(env,source,story);
 assert.deepEqual(calls[1].payload.items.map(item=>[item.source,item.draft]),[['第二节 商业\n商人通过水路运送粮食和布匹，城市因此繁荣起来。','Thương nhân chở lương thực và vải vóc bằng đường thủy, nhờ đó thành thị trở nên phồn thịnh.']]);
 assert.equal(result.translation,draft.replace('[Trang PDF 5]\n','[Trang PDF 5]\nMục 2. Thương nghiệp\n\n'));assert.deepEqual(result.warnings,[]);
});

// Each translated line is checked against its own source lines: a word quoted in one paragraph is no licence for it bare
// in another, and speech in quotes is a sentence to translate. A quoted example kept in its marks, a name's gloss in the
// other script, the words of a pinyin line and a character the translation names stay.
test('Chinese is checked against the line\'s own source: quoted words and speech left bare are found; examples, glosses and taught words stay',()=>{
 const source=['人们常说“发展”是硬道理，“城市”是文明的标志。','城市的发展需要河流。','老师说：“好。”'].join('\n\n');
 const found=textProblems(source,['Người ta thường nói “phát triển” là đạo lý cứng, “thành thị” là dấu hiệu của văn minh.','Sự 发展 của 城市 cần sông ngòi.','Thầy giáo nói: “好.”'].join('\n\n'));
 assert.deepEqual(found.places.map(place=>[place.at[0],place.chinese]),[[1,['发展','城市']],[2,['好']]]);
 for(const [source,translation] of [['“的”字是助词。','Chữ “的” là trợ từ.'],['張三與李四。','Trương Tam (张三) và Lý Tứ (李四).'],['生词\n\n山 shān 山峰\n\n水 shuǐ 河水','Từ mới\n\n山 shān: núi; 山峰: đỉnh núi\n\n水 shuǐ: nước; 河水: nước sông'],['拼音：mā 妈','Phiên âm: mā 妈 (mẹ)'],['江的意思是河流。','Chữ 江 có nghĩa là sông.']])
  assert.deepEqual(textProblems(source,translation).places,[],translation);
});

// What the text teaches as language is not translated away by the correction: one that takes out a quoted example, a word
// of a pinyin line or a character the translation names, told to translate the Chinese left beside it, is refused.
test('A correction that takes out Chinese the text teaches as language is refused; one that translates only what was left is taken',async t=>{
 const source='“的”字是助词，表示所属关系。',draft='Chữ “的” là trợ từ, biểu thị quan hệ 所属.';
 for(const [answer,kept] of [[()=>'Chữ “de” là trợ từ, biểu thị quan hệ sở thuộc.',true],[()=>'Chữ “的” là trợ từ, biểu thị quan hệ sở thuộc.',false]]){
  const calls=gemini(t,[translated(draft),repaired(answer)]);
  const result=await translateAndVerify(env,source,story);
  assert.equal(calls.length,2);assert.equal(result.translation,kept?draft:answer());
  assert.deepEqual(result.warnings,kept?['Đoạn 1: còn chữ Hán chưa dịch: 所属']:[]);
 }
});

// Two numerals in a row are a phrase, not an item (一、二年级: grades one and two); a list translated "Bài 1." keeps its
// numbers. Neither costs a correction.
test('Numbers in prose are no items, and a list numbered "Bài 1." keeps its items: no correction is asked',async t=>{
 for(const [source,translation] of [[['一、二年级的学生在操场上跑步，老师在旁边看着他们。','三、四十岁的人也来参加了。'],['Học sinh lớp một và lớp hai chạy bộ trên sân, thầy giáo đứng bên cạnh nhìn các em.','Những người ba bốn mươi tuổi cũng đến tham gia.']],[['练习','1. 计算面积。','2. 求周长。'],['Luyện tập','Bài 1. Tính diện tích.','Bài 2: Tìm chu vi.']]]){
  assert.deepEqual(textProblems(source.join('\n\n'),translation.join('\n\n')).places,[]);
  const calls=gemini(t,[translated(translation.join('\n\n'))]);
  const result=await translateAndVerify(env,source.join('\n\n'),story);
  assert.equal(calls.length,1);assert.deepEqual(result.warnings,[]);
 }
});

// A document keeps its paragraphs, so one Gemini dropped has no translation line and is named, as is a caption without a
// number that a sentence beside it lost its line to. Headings set on one line, short sentences or verse joined with
// commas lose nothing; a verse line dropped is still found.
test('A dropped paragraph or caption is found; headings on one line and sentences joined with commas are not',()=>{
 const document=[['第一章 河流与城市','Chương 1. Sông ngòi và thành thị'],['古代的城市大多沿河而建。','Các thành thị thời cổ phần lớn được xây dọc theo sông.'],
  ['河流为城市提供了水源，也提供了便利的交通，人们可以乘船往来于各个城市之间。','Sông ngòi cung cấp nguồn nước cho thành thị, lại cung cấp giao thông thuận tiện; người ta có thể đi thuyền qua lại giữa các thành thị.'],
  ['商人通过水路运送粮食、布匹和各种手工业产品，城市因此一天天繁荣起来。','Thương nhân chở lương thực, vải vóc và đủ loại sản phẩm thủ công bằng đường thủy, nhờ đó thành thị ngày một phồn thịnh.'],['人口随之增长。','Dân số theo đó tăng lên.'],
  ['随着人口的增长，城市的规模不断扩大，街道越来越多，房屋越来越密，城墙也一再向外推移，形成了今天所见的格局。','Cùng với sự gia tăng dân số, quy mô thành thị không ngừng mở rộng, đường phố ngày càng nhiều, nhà cửa ngày càng dày, tường thành cũng nhiều lần được dời ra ngoài, tạo nên diện mạo ngày nay.'],
  ['手工业和商业日益发达，出现了许多专门的市场。','Thủ công nghiệp và thương nghiệp ngày càng phát triển, xuất hiện nhiều chợ chuyên biệt.'],['这就是城市的起源。','Đó chính là nguồn gốc của thành thị.'],
  ['到了近代，铁路和公路逐渐取代了水路，一些沿河城市失去了往日的地位，另一些城市则因铁路而兴起。','Đến thời cận đại, đường sắt và đường bộ dần thay thế đường thủy; một số thành thị ven sông mất đi vị thế ngày trước, còn một số thành thị khác lại nhờ đường sắt mà hưng khởi.'],
  ['今天，河流仍然影响着城市的布局。','Ngày nay, sông ngòi vẫn ảnh hưởng đến bố cục của thành thị.']];
 const source=document.map(([chinese])=>chinese).join('\n\n');
 assert.deepEqual(textProblems(source,document.map(([,vietnamese])=>vietnamese).join('\n\n')).places,[]);
 const dropped=textProblems(source,document.filter((_,i)=>i!==6).map(([,vietnamese])=>vietnamese).join('\n\n'));
 assert.deepEqual(dropped.places.map(place=>place.lines.map(i=>dropped.S[i])),[[document[6][0]]]);
 const caption=textProblems('如下图所示。\n\n图 城市分布\n\n城市多在河边。','Như hình dưới đây.\n\nThành thị phần lớn ở ven sông.');
 assert.deepEqual(caption.places.map(place=>place.lines.map(i=>caption.S[i])),[['图 城市分布']]);
 for(const [source,translation] of [[['第一节','概述','本节介绍基本概念。'],['Mục 1. Khái quát','Mục này giới thiệu các khái niệm cơ bản.']],[['春天来了。','花开了。','草绿了。','小鸟在唱歌。'],['Mùa xuân đến rồi, hoa nở, cỏ xanh.','Chim nhỏ đang hót.']],[['甲：你好！','乙：你好，你去哪儿？','甲：我去学校。','乙：我也去学校。'],['A: Chào bạn! B: Chào bạn, bạn đi đâu thế?','A: Tôi đến trường. B: Tôi cũng đến trường.']]])
  assert.deepEqual(textProblems(source.join('\n\n'),translation.join('\n\n')).places,[],translation[0]);
 const verse=textProblems(['床前明月光，','疑是地上霜。','举头望明月，','低头思故乡。'].join('\n\n'),['Đầu giường ánh trăng rọi,','Ngỡ mặt đất phủ sương.','Cúi đầu nhớ cố hương.'].join('\n\n'));
 assert.deepEqual(verse.places.flatMap(place=>place.lines),[2]);
});

// The prompts are part of the translation cache key (PROMPT_VERSION): a changed prompt needs a new version, so a cached
// answer of the old one is never replayed. Change the hash below together with PROMPT_VERSION.
test('The prompts keep every line, give uncertain names a Hán-Việt reading, and a changed prompt changes PROMPT_VERSION',()=>{
 for(const rule of [/Hán-Việt reading with the Chinese in parentheses/u,/never leave Chinese without a Vietnamese reading/u,/Translate every line in order, headings, running heads, captions, labels, list items, notes and citations included/u,/each heading, item and caption on its own line/u,/Translate Chinese words inside LaTeX/u])assert.match(TRANSLATION_INSTRUCTION,rule);
 assert.doesNotMatch(TRANSLATION_INSTRUCTION,/Keep uncertain names|in Chinese, optionally|Omit only technical PDF page labels/u);
 for(const rule of [/Transcribe every line, titles, running heads and feet, captions, notes and imprint included/u,/with \[đầu trang\] or \[chân trang\]/u,/never a heading of the page itself/u,/Omit only a lone page number and a watermark across the text/u])assert.match(OCR_INSTRUCTION,rule);
 assert.doesNotMatch(OCR_INSTRUCTION,/repeated headers\/footers|publisher boilerplate|copyright notices/u);
 for(const rule of [/chinese \(Chinese the draft keeps\), missingLines \(source lines the draft lacks\) and missingNumbers/u,/Hán-Việt reading with the Chinese in parentheses/u,/keep as written, with its reading, Chinese the text discusses as language/u,/add nothing else/u])assert.match(TEXT_REPAIR_INSTRUCTION,rule);
 const hash=createHash('sha256').update([OCR_INSTRUCTION,TRANSLATION_INSTRUCTION,TEXT_REPAIR_INSTRUCTION].join('\n')).digest('hex').slice(0,16);
 assert.deepEqual({PROMPT_VERSION,hash},{PROMPT_VERSION:'academic-zh-vi-v12-language-kept',hash:'b9f4f4f627448917'},'a prompt changed: give PROMPT_VERSION a new value and copy the new hash here');
});
