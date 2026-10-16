import test from 'node:test';
import assert from 'node:assert/strict';
import {translationBlocks,translationContentHtml,figuresForPart,buildStudyHtml} from '../frontend/study-layout-view.js';

test('translation separates numbered headings, paragraphs, lists and multiline formulas',()=>{
 const blocks=translationBlocks('1.1 Vectơ trong không gian\n\nĐoạn đầu\nxuống dòng mềm.\n\n1.1.1 Các phép toán\n\n- Giữ hướng\n\\[\n\\vec{AB} = \\vec{b}\n\\]');
 assert.deepEqual(blocks.map(block=>block.kind),['heading','paragraph','heading','list-item','formula']);
 assert.equal(blocks[1].text,'Đoạn đầu xuống dòng mềm.');
 assert.equal(blocks[4].text,'\\[\n\\vec{AB} = \\vec{b}\n\\]');
 assert.deepEqual(translationBlocks('Đoạn một.\nĐoạn hai.').map(block=>block.text),['Đoạn một.','Đoạn hai.']);
});

test('source geometry appears after its exact reference, once, with unmatched images retained',()=>{
 const figures=[{caption:'图1.1-1',url:'blob:vector',page:4},{caption:'图1.1-2',url:'blob:cube',page:4},{caption:'图1.1-3',url:'blob:other',page:4}];
 const html=translationContentHtml('1.1 Vectơ\n\nHình 1.1-10 không phải hình đầu.\n\nXem Hình 1.1-1.\n\nHình 1.1-2 là hình lập phương.\n\nNhắc lại Hình 1.1-1.',figures);
 assert.equal((html.match(/src="blob:vector"/gu)||[]).length,1);
 assert.ok(html.indexOf('src="blob:vector"')>html.indexOf('Xem Hình 1.1-1.'));
 assert.ok(html.indexOf('src="blob:vector"')<html.indexOf('Hình 1.1-2 là'));
 assert.match(html,/unlinked-figures/);assert.match(html,/src="blob:other"/);
 const spaced=translationContentHtml('Xem Hình 1.1-2.',[{caption:'图 1．1 － 2',url:'blob:cube'}]);
 assert.doesNotMatch(spaced,/unlinked-figures/);assert.match(spaced,/>Hình 1.1-2</);
});

test('untrusted translation and caption markup cannot create executable HTML',()=>{
 const html=translationContentHtml('# <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',[{caption:'<img onerror=bad>',url:'blob:local" onerror="bad'},{caption:'Unsafe',url:'javascript:alert(1)'}]);
 assert.doesNotMatch(html,/<script>|<img src=x|src="javascript:|" onerror="/u);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/&quot; onerror=&quot;/);
});

test('split pages assign each figure once to the source part referencing it',()=>{
 const parts=[{text:'图1.1-1 的说明',pages:[4]},{text:'图1.1-2 的说明',pages:[4]},{text:'第五页',pages:[5]},{text:'手动编辑',pages:[]}];
 const images=new Map([[4,{figures:[{caption:'图1.1-1'},{caption:'图1.1-2'},{caption:'图1.1-3'}]}],[5,{figures:[{caption:'图1.2-1'}]}]]);
 assert.deepEqual(figuresForPart(parts,0,images).map(figure=>figure.caption),['图1.1-1','图1.1-3']);
 assert.deepEqual(figuresForPart(parts,1,images).map(figure=>figure.caption),['图1.1-2']);
 assert.deepEqual(figuresForPart(parts,2,images).map(figure=>figure.caption),['图1.2-1']);
 assert.deepEqual(figuresForPart(parts,3,images),[]);
});

test('standalone export embeds cropped figures and source pages without blob dependencies',async()=>{
 const html=await buildStudyHtml({title:'Sách Toán',parts:[{text:'图1.1-1',pages:[4]},{text:'Chưa dịch',pages:[5]}],translations:['1.1 Vectơ\n\nXem Hình 1.1-1.'],images:new Map([[4,{blob:new Blob(['page']),figures:[{blob:new Blob(['crop']),url:'blob:session',caption:'图1.1-1'}]}],[5,{blob:new Blob(['unfinished'])}]]),blobDataUrl:async blob=>'data:image/png;base64,'+Buffer.from(await blob.text()).toString('base64'),combined:''});
 assert.match(html,/<article class="translation-document"><h3/);assert.match(html,/class="translated-figure"/);
 assert.match(html,/data:image\/png;base64,Y3JvcA==/);assert.match(html,/data:image\/png;base64,cGFnZQ==/);
 assert.doesNotMatch(html,/blob:session|Trang gốc 5|dW5maW5pc2hlZA==/);
 assert.match(html,/<details class="originals"><summary>Đối chiếu trang gốc/);
});
