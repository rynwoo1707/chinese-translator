import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanExtractedPdfText,cleanReaderText,readerText,withoutEdgeMarks} from './pdf-cleaning.js';
import {cleanPdfPages,usefulPageText} from '../frontend/pdf-client.js';
import worker,{pdfNotes} from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';

const wrapped='第一段的正文很長，一直寫到這一行的末尾還沒有';
const pages=[`網站掃描\n${wrapped}\n結束。\n- 1 -`,'網站掃描\n第二段。\nTrang 2/3','網站掃描\n第三段。\n3'];
// A line repeated at the same edge of three pages is page furniture: translated once where it first appears (on its own
// line), dropped where it repeats; page labels and a number in step with the pages go. A line running the page's full
// width joins the next (a wrap); a short one (a heading, a verse line) keeps its own line.
test('Client PDF cleaning keeps a repeated header once, drops its repeats and the page labels, and joins a full-width Chinese line to the next',()=>{
 assert.equal(cleanPdfPages(pages),`[Trang PDF 1]\n網站掃描\n${wrapped}結束。\n\n[Trang PDF 2]\n第二段。\n\n[Trang PDF 3]\n第三段。`);
 assert.equal(cleanPdfPages(['第一段沒有\n結束。']),'[Trang PDF 1]\n第一段沒有\n結束。','five characters are no wrap');
});
test('Server OCR cleaning keeps a repeated header once and drops its repeats, page numbers and internal page markers',()=>{
 const text=pages.map((page,index)=>`[Trang PDF ${index+1}]\n${page}`).join('\n\n');
 assert.equal(cleanExtractedPdfText(text),`網站掃描\n${wrapped}結束。\n\n第二段。\n\n第三段。`);
});
test('Reader cleaning repairs detached Vietnamese tone marks in older saved translations',()=>{
 assert.equal(cleanReaderText('Vectơ giố`ng nhau và có độ dài bằ`ng 1.'),'Vectơ giống nhau và có độ dài bằng 1.');
 assert.equal(readerText('Vectơ giố`ng nhau và có độ dài bằ`ng 1.'),'Vectơ giống nhau và có độ dài bằng 1.');
});
test('Only substantial Chinese text layers bypass PDF OCR',()=>{
 assert.equal(usefulPageText('第一章。'),false);
 assert.equal(usefulPageText('第一章 這是一段可以直接提取的中文正文，包含足夠文字來確認頁面具有可用的文字層。研究者應當對照原文，核查專有名詞、年代、引文和註釋。'),true);
 assert.equal(usefulPageText(''),false);
});

// Translations from several subjects with the lines the old cleaner deleted: a keyword of an imprint inside a sentence
// (and every line before it), a line that is only a number, a fraction, a catalogue-like answer.
const civics='Bài 5. Quyền sở hữu trí tuệ\nTác giả có quyền nhân thân đối với tác phẩm.\nBản quyền là quyền của tác giả đối với tác phẩm do mình sáng tạo.\nNhà xuất bản phải xin phép tác giả trước khi in.';
const history='Chương 3. Trung Quốc thời cận đại\nNăm 1840 nổ ra Chiến tranh Nha phiến.\nNhà xuất bản Thương vụ ấn thư quán được thành lập ở Thượng Hải năm 1897.\nIn tại xưởng in của nhà truyền giáo, sách được bán khắp cả nước.';
const math='Đáp số bài 3:\n12\n1958\n3/4\n② Hình lập phương có cạnh bằng R12';
const chinese='版权所有的观念在宋代已经出现。\n商务印书馆是近代中国最早的出版社之一，印刷技术由此传入。\n印刷术是中国古代四大发明之一。';

test('A student\'s or reader\'s text is never cut when it is read',()=>{
 for(const text of [civics,history,math,chinese,`[Trang PDF 3]\n${civics}\n\nTrang 5/6`])assert.equal(readerText(text),text);
});

test('Pipeline translations lose only page markers and page labels, never prose, answers or years',()=>{
 for(const text of [civics,history,math,chinese])assert.equal(cleanReaderText(text),text);
 const published=cleanReaderText(`[Trang PDF 1–1]\nDư Hoa\nISBN 978-7-5302-1559-3\n\n[Trang PDF 4–4]\nMột buổi sáng, Phúc Quý trở về làng.\n- 12 -\nTrang 5/6\n12\n1958`);
 assert.equal(published,'Dư Hoa\nISBN 978-7-5302-1559-3\n\nMột buổi sáng, Phúc Quý trở về làng.\n12\n1958');
});

test('Chinese source cleaning keeps body lines that name printing, publishers or copyright, and lone numbers',()=>{
 const text=[
  `[Trang PDF 21]\n第三章 近代文化\n${chinese}\n答案：\n12\n1958\n3/4`,
  `[Trang PDF 22]\n出版社在清末大量出现。\n1897年，商务印书馆在上海创立。\n12`
 ].join('\n\n');
 const clean=cleanExtractedPdfText(text);
 for(const line of chinese.split('\n'))assert.match(clean,new RegExp(line.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'));
 assert.match(clean,/\n12\n1958\n3\/4/u);assert.match(clean,/出版社在清末大量出现。/u);assert.match(clean,/商务印书馆在上海创立。\n12$/u,'one page ending in 12 is an answer, not a page number');
});

test('Source cleaning removes page numbers only when they run in step with the pages',()=>{
 const clean=cleanExtractedPdfText(['[Trang PDF 12]\n第一节 函数\n函数是数学的基本概念。\n7','[Trang PDF 13]\n8\n例1 求函数的定义域。','[Trang PDF 14]\n练习\n1. 求下列函数的值。\n9'].join('\n\n'));
 assert.doesNotMatch(clean,/^(?:7|8|9)$/mu);assert.match(clean,/函数是数学的基本概念。/u);assert.match(clean,/1\. 求下列函数的值。/u);
});

// "12页" alone is an answer in a page's body and a page label only where a page's edge is known (a marked foot) or where
// its number runs in step with the pages; "第 3 页" and "- 4 -" label a page wherever they stand.
test('An answer reading like a page label stays in a page\'s body; "N 页" goes only at a marked edge or in step, a full label anywhere',()=>{
 assert.equal(cleanExtractedPdfText('[Trang PDF 1]\n小明读一本书。\n还剩多少页没有读？\n答：\n12页\n第二题：计算。'),'小明读一本书。\n还剩多少页没有读？\n答：\n12页\n第二题：计算。');
 assert.equal(cleanExtractedPdfText('[Trang PDF 3–4]\n第一段正文。\n第 3 页\n第二段正文。\n- 4 -'),'第一段正文。\n第二段正文。');
 const feet=[[5,12],[6,15],[7,20]].map(([n,answer])=>`[Trang PDF ${n}]\n正文第${n}页。\n${answer}页\n[chân trang] ${n+2} 页`).join('\n\n');
 assert.equal(cleanExtractedPdfText(feet),'正文第5页。\n12页\n\n正文第6页。\n15页\n\n正文第7页。\n20页');
 assert.doesNotMatch(cleanExtractedPdfText([5,6,7].map(n=>`[Trang PDF ${n}]\n正文第${n}页的内容。\n${n+10}页`).join('\n\n')),/^1\d页$/mu,'"N 页" in step with the pages is a folio');
});

test('Imprint lines go only from an imprint page of the front matter',()=>{
 const imprint='[Trang PDF 2]\n普通高中教科书 数学\n图书在版编目（CIP）数据\n数学/人民教育出版社课程教材研究所编著.—北京：人民教育出版社，2019.6\nISBN 978-7-107-33522-6\nⅠ.①数… Ⅱ.①人… Ⅲ.①数学课—高中—教材 Ⅳ.①G634.603\n责任编辑：王小明\n出版发行：人民教育出版社\n定价：12.50元\n版权所有 侵权必究';
 const preface='[Trang PDF 3]\n前言\n本书由人民教育出版社出版，印刷精美。\n版权所有的概念在书中第三章讨论。';
 const appendix='[Trang PDF 150]\n参考书目\nISBN 978-7-107-33522-6 是本书的书号。\n责任编辑：王小明 对本书有贡献。\n出版社：人民教育出版社';
 const clean=cleanExtractedPdfText([imprint,preface,appendix].join('\n\n'));
 assert.doesNotMatch(clean,/图书在版编目|G634|定价|侵权必究|出版发行：|编著\.—北京/u);
 assert.match(clean,/普通高中教科书 数学/u);assert.match(clean,/本书由人民教育出版社出版，印刷精美。/u);assert.match(clean,/版权所有的概念在书中第三章讨论。/u);
 // Page 150 is not front matter: the bibliography keeps every line, its heading on a line of its own.
 assert.match(clean,/参考书目\nISBN 978-7-107-33522-6 是本书的书号。\n责任编辑：王小明 对本书有贡献。\n出版社：人民教育出版社$/u);
 // A front page without an imprint keeps a lone label-like line.
 assert.match(cleanExtractedPdfText('[Trang PDF 1]\n出版社：作者自印\n这是一本小册子。'),/出版社：作者自印/u);
});

// OCR text has no line positions: its first and last lines are page edges only as a guess, which a heading or an exercise
// opening the page fills as often as a running head. A line the reading marked as a running head goes where it repeats.
test('Without positions a heading opening each page stays on every page; marked as a running head it stays once, and a heading inside a page stays',()=>{
 const body=n=>`函数描述了两个变量之间的对应关系，这是第${n}段正文。`;
 const text=[`[Trang PDF 5]\n第一章 函数\n${body(1)}\n${body(2)}`,`[Trang PDF 6]\n第一章 函数\n${body(3)}\n${body(4)}`,`[Trang PDF 7]\n第一章 函数\n${body(5)}\n第一章 函数\n小结：${body(6)}\n${body(7)}`,`[Trang PDF 8]\n第一章 函数\n${body(8)}\n${body(9)}`].join('\n\n');
 assert.equal(cleanExtractedPdfText(text),text.replace(/\[Trang PDF \d\]\n/gu,''),'unmarked, the heading-like line opening each page is translated on each');
 const marked=text.replace(/\]\n第一章 函数/gu,']\n[đầu trang] 第一章 函数');
 assert.equal(cleanExtractedPdfText(marked),`第一章 函数\n${body(1)}\n${body(2)}\n\n${body(3)}\n${body(4)}\n\n${body(5)}\n第一章 函数\n小结：${body(6)}\n${body(7)}\n\n${body(8)}\n${body(9)}`,'the running head on page 5 and the heading inside page 7 stay, each on its own line');
});

test('A heading that opens a few pages of an OCR text stays on each; a running head marked on every page stays once, unmarked only when it opens nearly every page',()=>{
 const page=(n,head='',foot='')=>`[Trang PDF ${n}]\n${head}这是第${n}页正文的第一句话，内容各不相同。\n这是一段正文，讲述了相关的概念和例子${n}。\n第${n}页结束的一句话。${foot}`;
 const sections=Array.from({length:60},(_,i)=>page(i+1,[10,12,14].includes(i+1)?'思考\n':''));
 assert.equal((cleanExtractedPdfText(sections.join('\n\n')).match(/^思考$/gmu)||[]).length,3,'思考 opens pages 10, 12 and 14');
 const marked=Array.from({length:60},(_,i)=>page(i+1,'[đầu trang] 普通高中教科书 地理\n'));
 assert.equal((cleanExtractedPdfText(marked.join('\n\n')).match(/普通高中教科书 地理/gu)||[]).length,1);
 // Unmarked (a device reading marks nothing), a line opening nearly every page is a running head; one opening every other
 // page may be a heading as well as a head, and is translated where it stands.
 const unmarked=Array.from({length:60},(_,i)=>page(i+1,'普通高中教科书 地理\n'));
 assert.equal((cleanExtractedPdfText(unmarked.join('\n\n')).match(/普通高中教科书 地理/gu)||[]).length,1);
 const alternate=Array.from({length:60},(_,i)=>page(i+1,i%2?'':'普通高中教科书 地理\n'));
 assert.equal((cleanExtractedPdfText(alternate.join('\n\n')).match(/普通高中教科书 地理/gu)||[]).length,30);
 // A short job read on the device: an exercise heading opening pages 1, 3 and 5 of 6, an answer closing 2, 4 and 6, and
 // headings, items and answers opening or closing every page stay on each.
 const short=Array.from({length:6},(_,i)=>page(i+1,i%2?'':'练习\n',i%2?'\n答案：略':'')).join('\n\n');
 assert.deepEqual([/^练习$/gmu,/^答案：略$/gmu].map(pattern=>(cleanExtractedPdfText(short).match(pattern)||[]).length),[3,3]);
 const every=Array.from({length:6},(_,i)=>page(i+1,'一、选择题\n','\n答：')).join('\n\n');
 assert.deepEqual([/^一、选择题$/gmu,/^答：$/gmu].map(pattern=>(cleanExtractedPdfText(every).match(pattern)||[]).length),[6,6]);
});

// The text the browser cleaned from each line's place on its page (a Xưởng dịch upload's parsed_text) is not cleaned a
// second time by the line-count rules: a heading that opens several pages stays, nothing is joined again.
test('A text layer the browser cleaned keeps its lines; only page labels and imprint lines go',()=>{
 const text=['[Trang PDF 5]\n练习\n1. 求下列函数的值。','[Trang PDF 6]\n练习\n2. 求函数的定义域','[Trang PDF 7]\n练习\n3. 画出函数的图像。\n第 7 页'].join('\n\n');
 assert.equal(cleanExtractedPdfText(text,{cleaned:true}),'练习\n1. 求下列函数的值。\n\n练习\n2. 求函数的定义域\n\n练习\n3. 画出函数的图像。');
 assert.equal((cleanExtractedPdfText(text).match(/^练习$/gmu)||[]).length,1,'without the place of each line, a line opening three pages in a row is a running head');
 // A mixed job: the pages taken from the text layer (5 and 7) keep their lines; the page read from its picture (6) is
 // cleaned by the line-count rules, its wrapped line joined.
 const mixed=['[Trang PDF 5–5]\n练习\n1. 求下列函数的值。','[Trang PDF 6–6]\n练习\n2. 求函数的定义域，并\n画出它的图像。','[Trang PDF 7–7]\n练习\n3. 画出函数的图像。'].join('\n\n');
 assert.equal(cleanExtractedPdfText(mixed,{cleaned:new Set([5,7])}),'练习\n1. 求下列函数的值。\n\n练习\n2. 求函数的定义域，并画出它的图像。\n\n练习\n3. 画出函数的图像。');
});

test('Lines an OCR reading marks as a running head or foot are page edges wherever they stand, their marks removed',()=>{
 const text=[1,2,3].map(n=>`[Trang PDF ${n}]\n正文第${n}页。\n[đầu trang] 地理选修一\n继续正文${n}。\n[chân trang] 资料分享网`).join('\n\n');
 assert.equal(cleanExtractedPdfText(text),'正文第1页。\n地理选修一\n继续正文1。\n资料分享网\n\n正文第2页。\n继续正文2。\n\n正文第3页。\n继续正文3。');
 // Read on its own (one image, a student's page), a page loses only the marks: its running head is translated with it.
 assert.equal(withoutEdgeMarks('[đầu trang] 地理选修一\n正文第一段。\n  [Chân trang]  资料分享网\n他说[đầu trang]不是标记。'),'地理选修一\n正文第一段。\n  资料分享网\n他说[đầu trang]不是标记。');
});

// OCR text keeps its paragraphs: a blank line ends one, and no heading, caption, row or verse line is glued on.
test('OCR paragraph ends and headings survive the source cleaning',()=>{
 const ocr='[Trang PDF 3–4]\n第三章 山地与交通\n\n3.1 山地对交通的影响\n\n山地限制了道路的修建，修路成本较高，道路往往\n沿河谷延伸。\n\n思考\n\n山区的公路为什么多呈“之”字形\n\n春风吹过河岸\n柳枝轻轻摇动';
 assert.equal(cleanExtractedPdfText(ocr),'第三章 山地与交通\n3.1 山地对交通的影响\n山地限制了道路的修建，修路成本较高，道路往往沿河谷延伸。\n思考\n山区的公路为什么多呈“之”字形\n春风吹过河岸\n柳枝轻轻摇动');
});

test('A student\'s saved translation reads back exactly as it was saved',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),reader=await signedIn(sqlite);
 const translation=`${civics}\n\n${history}\n\n${math}`,source='公民\n\n历史\n\n数学',parts=['公民','历史','数学'];
 const call=(path,options={})=>worker.fetch(new Request('https://hoatri.example'+path,{...options,headers:{Cookie:reader.cookie,'Content-Type':'application/json',Origin:'https://hoatri.example',...options.headers}}),env,{});
 const saved=await call('/api/my/study/history',{method:'POST',body:JSON.stringify({title:'Ba môn',filename:'ba-mon.txt',domain:'general',mode:'economy',state:{source,parts,translationParts:[civics,history,math],done:3}})});
 assert.equal(saved.status,201);const {libraryStoryId}=await saved.json();
 const read=await call(`/api/read/${libraryStoryId}`);assert.equal(read.status,200);
 const [chapter]=await read.json();assert.equal(chapter.content,translation);
});

test('An admin\'s PDF upload keeps the text the browser cleaned and its analysis notes as the job\'s first warnings',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),admin={...env,ADMIN_TOKEN:'a'.repeat(64)};
 sqlite.prepare("INSERT INTO stories(id,title,genre) VALUES('s1','Sách','Giáo dục')").run();
 const form=new FormData();form.set('story_id','s1');form.set('file',new File([new Uint8Array([37,80,68,70,45])],'sach.pdf'));form.set('pdf_pages','3');
 form.set('parsed_text','[Trang PDF 1]\n练习\n1. 求下列函数的值。\n\n[Trang PDF 2]\n练习\n2. 求函数的定义域\n\n[Trang PDF 3]\n练习\n3. 画出函数的图像。');
 form.set('notes',JSON.stringify(['Trang 2: khoảng 9 chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh.',42,' ']));
 const response=await worker.fetch(new Request('https://hoatri.example/api/jobs',{method:'POST',headers:{Authorization:`Bearer ${'a'.repeat(64)}`},body:form}),admin,{});
 assert.equal(response.status,201);
 const job=sqlite.prepare('SELECT source,warnings FROM jobs').get();
 assert.equal(job.source,'练习\n1. 求下列函数的值。\n\n练习\n2. 求函数的定义域\n\n练习\n3. 画出函数的图像。','each page keeps its heading');
 assert.deepEqual(JSON.parse(job.warnings),['Trang 2: khoảng 9 chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên được nhận dạng từ ảnh.']);
 assert.deepEqual(pdfNotes('không phải JSON'),[]);assert.deepEqual(pdfNotes(JSON.stringify({a:1})),[]);
 assert.equal(pdfNotes(JSON.stringify(Array(250).fill('x'.repeat(400)))).length,200);assert.equal(pdfNotes(JSON.stringify(['x'.repeat(1200)]))[0].length,1000);
});
