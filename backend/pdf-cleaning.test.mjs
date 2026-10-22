import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanExtractedPdfText,cleanReaderText,readerText} from './pdf-cleaning.js';
import {cleanPdfPages,usefulPageText} from '../frontend/pdf-client.js';
import worker from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';

const pages=['網站掃描\n第一段沒有\n結束。\n- 1 -','網站掃描\n第二段。\nTrang 2/3','網站掃描\n第三段。\n3'];
test('Client PDF cleaning removes repeated furniture and repairs Chinese visual wraps',()=>{const text=cleanPdfPages(pages);assert.doesNotMatch(text,/網站掃描|Trang 2\/3|- 1 -/);assert.match(text,/第一段沒有結束。/);assert.match(text,/\[Trang PDF 3\]/);});
test('Server OCR cleaning removes repeated headers, page numbers and internal page markers',()=>{const text=pages.map((page,index)=>`[Trang PDF ${index+1}]\n${page}`).join('\n\n');const clean=cleanExtractedPdfText(text);assert.doesNotMatch(clean,/網站掃描|Trang 2\/3|- 1 -|\[Trang/);assert.match(clean,/第一段沒有結束。/);});
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

test('Imprint lines go only from an imprint page of the front matter',()=>{
 const imprint='[Trang PDF 2]\n普通高中教科书 数学\n图书在版编目（CIP）数据\n数学/人民教育出版社课程教材研究所编著.—北京：人民教育出版社，2019.6\nISBN 978-7-107-33522-6\nⅠ.①数… Ⅱ.①人… Ⅲ.①数学课—高中—教材 Ⅳ.①G634.603\n责任编辑：王小明\n出版发行：人民教育出版社\n定价：12.50元\n版权所有 侵权必究';
 const preface='[Trang PDF 3]\n前言\n本书由人民教育出版社出版，印刷精美。\n版权所有的概念在书中第三章讨论。';
 const appendix='[Trang PDF 150]\n参考书目\nISBN 978-7-107-33522-6 是本书的书号。\n责任编辑：王小明 对本书有贡献。\n出版社：人民教育出版社';
 const clean=cleanExtractedPdfText([imprint,preface,appendix].join('\n\n'));
 assert.doesNotMatch(clean,/图书在版编目|G634|定价|侵权必究|出版发行：|编著\.—北京/u);
 assert.match(clean,/普通高中教科书 数学/u);assert.match(clean,/本书由人民教育出版社出版，印刷精美。/u);assert.match(clean,/版权所有的概念在书中第三章讨论。/u);
 // Page 150 is not front matter: the bibliography keeps every line (a heading without punctuation is joined to the
 // next Chinese line, as a visual wrap is).
 assert.match(clean,/参考书目ISBN 978-7-107-33522-6 是本书的书号。\n责任编辑：王小明 对本书有贡献。\n出版社：人民教育出版社$/u);
 // A front page without an imprint keeps a lone label-like line.
 assert.match(cleanExtractedPdfText('[Trang PDF 1]\n出版社：作者自印\n这是一本小册子。'),/出版社：作者自印/u);
});

test('A running head goes from the edge of each page but stays where it is a heading inside a page',()=>{
 const text=['[Trang PDF 5]\n第一章 函数\n正文一。\n正文二。','[Trang PDF 6]\n第一章 函数\n正文三。\n正文四。','[Trang PDF 7]\n第一章 函数\n正文五。\n第一章 函数\n小结：正文六。\n正文七。','[Trang PDF 8]\n第一章 函数\n正文八。\n正文九。'].join('\n\n');
 const clean=cleanExtractedPdfText(text);
 assert.equal((clean.match(/第一章 函数/gu)||[]).length,1,'the heading inside page 7 stays');assert.match(clean,/正文五。\n第一章 函数小结：正文六。\n正文七。/u);
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
