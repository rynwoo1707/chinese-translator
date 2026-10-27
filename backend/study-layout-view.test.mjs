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

// What a reader sees of the reading view: its text, without the drawings (SVG) and the characters kept for copying.
const visible=html=>html.replace(/<svg[\s\S]*?<\/svg>/gu,'').replace(/<span class="math-copy">[^<]*<\/span>/gu,'').replace(/<[^>]+>/gu,'').replace(/&amp;/gu,'&').replace(/&lt;/gu,'<').replace(/&gt;/gu,'>');
test('a formula over several lines stays whole in the block it starts in, list items, headings and paragraphs alike, within a bound',()=>{
 const blocks=text=>translationBlocks(text).map(block=>[block.kind,block.text]);
 // A numbered exercise whose system, bare or delimited, runs onto the next line is one list item.
 assert.deepEqual(blocks('1. Giải hệ \\begin{cases} x+y=5 \\\\\nx-y=1 \\end{cases}\n2. Bài tiếp.'),[['list-item','1. Giải hệ \\begin{cases} x+y=5 \\\\\nx-y=1 \\end{cases}'],['list-item','2. Bài tiếp.']]);
 assert.deepEqual(blocks('- Giải hệ \\(\\begin{cases} x+y=5 \\\\\n  x-y=1 \\end{cases}\\)\n- Bài tiếp.'),[['list-item','- Giải hệ \\(\\begin{cases} x+y=5 \\\\\nx-y=1 \\end{cases}\\)'],['list-item','- Bài tiếp.']]);
 assert.deepEqual(blocks('## Hệ \\(\\begin{cases} a \\\\\nb \\end{cases}\\)\nĐoạn.'),[['heading','Hệ \\(\\begin{cases} a \\\\\nb \\end{cases}\\)'],['paragraph','Đoạn.']]);
 // A shielded formula restored with its own line breaks after the model joined it to the sentence (解方程组\n@@MATH_0001@@):
 // the delimiters stay with their system, with or without blank lines round the paragraph, and nothing is printed raw.
 const formula='\\[\n\\begin{cases}\nx+y=5 \\\\\nx-y=1\n\\end{cases}\n\\]';
 for(const text of [`Giải hệ phương trình ${formula} ta được x=3.`,`Bài 1.\n\nGiải hệ phương trình ${formula} ta được x=3.\n\nBài 2.`,'Bài 1.\n\nHệ \\(\n\\begin{cases} x+y=5 \\\\ x-y=1 \\end{cases}\n\\) có nghiệm x=3.\n\nBài 2.','Ta có $$\nx+y=5\n$$ nên x=3.']){
  const found=translationBlocks(text).filter(block=>block.text.includes('x+y=5'));
  assert.equal(found.length,1,text);assert.equal(found[0].kind,'paragraph',text);assert.match(found[0].text,/x=3\.$/u,text);
  const shown=visible(translationContentHtml(text));assert.doesNotMatch(shown,/\\[[\]()]|\\begin|\\end|\$\$|\\\\/u,shown);assert.match(shown,/x\+y=5/u,shown);assert.match(shown,/x=3\./u,shown);
 }
 // A display formula alone on its lines is still a formula block, centred.
 assert.deepEqual(blocks(`Ta có\n${formula}\nnên x=3.`),[['paragraph','Ta có'],['formula',formula],['paragraph','nên x=3.']]);
 // \\( is a row break before a bracket and \$$ an escaped dollar: neither opens a formula, so no line is taken.
 assert.deepEqual(blocks('Hệ \\begin{cases} a \\\\(b) \\end{cases} và \\\\(c\nGiá \\$$5\nHết.').map(([kind])=>kind),['paragraph','paragraph','paragraph']);
 // A stray \( (an OCR or translation slip) never takes the next lines: a later formula of its kind is still drawn.
 assert.deepEqual(blocks('Lỗi \\( ở đây\nCòn \\(x^2\\) đúng.'),[['paragraph','Lỗi \\( ở đây'],['paragraph','Còn \\(x^2\\) đúng.']]);
 assert.match(translationContentHtml('Lỗi \\( ở đây\nCòn \\(x^2\\) đúng.'),/x<sup>2<\/sup>/u);
 // A \[ or $$ never closed within the bound leaves its line alone, as an environment does (it used to swallow the rest
 // of the part into one formula block).
 assert.deepEqual(blocks('\\[ x+1\nĐoạn sau.\n- Ý một'),[['paragraph','\\[ x+1'],['paragraph','Đoạn sau.'],['list-item','- Ý một']]);
 assert.equal(blocks(`Mở \\(\n${'dòng\n'.repeat(60)}\\) đóng`).length,62,'a closer 60 lines on is not looked for');
 // Linear in practice: every line opening something never closed is read with at most 50 lines after it.
 for(const make of [n=>'\\begin{cases} a\n'.repeat(n),n=>'\\(x\n'.repeat(n),n=>'$$ a\n'.repeat(n),n=>`\\(${'\\\\'.repeat(n)}`]){
  const text=make(20000),started=performance.now();translationBlocks(text);assert.ok(performance.now()-started<3000,`${text.slice(0,12)}: ${Math.round(performance.now()-started)} ms`);
 }
});

test('a $$, \\( or \\[ in running text never takes the lines after it, and no formula left open by its delimiter alone crosses a blank line',()=>{
 const blocks=text=>translationBlocks(text).map(block=>[block.kind,block.text]);
 // The shell's $$, a $$ slip before a display formula, $…$ formulas side by side, a regex's \( or \[: each line keeps its
 // own block, with or without blank lines between them. Only a delimiter that starts or ends its line, holds an
 // environment or comes before a row break ending its line opens a formula over several lines.
 const slip='Ví dụ 1. Tính tổng $$S = 1 + 2.\n\n## Lời giải\n\n- Bước 1: nhóm các số hạng.\n- Bước 2: áp dụng công thức\n$$\nS_n = \\frac{n(n+1)}{2}\n$$\n\nVí dụ 2. Hết.';
 for(const [text,expected] of [
  ['Biến đặc biệt $$ chứa PID của shell hiện tại.\n\nVí dụ:\n\n- Chạy echo $$ để in PID.\n- Ý khác.',[['paragraph','Biến đặc biệt $$ chứa PID của shell hiện tại.'],['paragraph','Ví dụ:'],['list-item','- Chạy echo $$ để in PID.'],['list-item','- Ý khác.']]],
  [slip,[['paragraph','Ví dụ 1. Tính tổng $$S = 1 + 2.'],['heading','Lời giải'],['list-item','- Bước 1: nhóm các số hạng.'],['list-item','- Bước 2: áp dụng công thức'],['formula','$$\nS_n = \\frac{n(n+1)}{2}\n$$'],['paragraph','Ví dụ 2. Hết.']]],
  ['Cho $a$$b$ là hai số.\n\n## Bài 2\n\n- Ý một\n- Ý hai\n\nTính $x$$y$.',[['paragraph','Cho $a$$b$ là hai số.'],['heading','Bài 2'],['list-item','- Ý một'],['list-item','- Ý hai'],['paragraph','Tính $x$$y$.']]],
  ['Trong biểu thức chính quy, \\( khớp dấu ngoặc mở.\n\n## Ghi chú\n\nCòn \\) khớp dấu ngoặc đóng.',[['paragraph','Trong biểu thức chính quy, \\( khớp dấu ngoặc mở.'],['heading','Ghi chú'],['paragraph','Còn \\) khớp dấu ngoặc đóng.']]],
  ['Biến $$ chứa PID.\nDòng hai.\n## Mục mới\nChạy echo $$ để xem.',[['paragraph','Biến $$ chứa PID.'],['paragraph','Dòng hai.'],['heading','Mục mới'],['paragraph','Chạy echo $$ để xem.']]],
  ['Ký hiệu \\[ mở một đoạn.\n- Ý một\nCòn \\] đóng nó.',[['paragraph','Ký hiệu \\[ mở một đoạn.'],['list-item','- Ý một'],['paragraph','Còn \\] đóng nó.']]],
  // A $…$ is read whole, as the renderer reads it: the $$ inside $x$$y$ opens nothing, so the one ending the line closes $$z.
  ['Tính $x$$y$ và $$z$$\nDòng hai.\nDòng ba $$ hết.',[['paragraph','Tính $x$$y$ và $$z$$'],['paragraph','Dòng hai.'],['paragraph','Dòng ba $$ hết.']]],
  // And a closer is the first one after its opener, even after a backslash (\$$, \\]), as the renderer finds it.
  ['$$ a \\$$ b\nDòng hai.\nDòng ba $$.',[['paragraph','$$ a \\$$ b'],['paragraph','Dòng hai.'],['paragraph','Dòng ba $$.']]]
 ])assert.deepEqual(blocks(text),expected,text);
 // The slip stays as written in its paragraph; the display formula after it is drawn, and nothing else is raw.
 const html=translationContentHtml(slip),shown=visible(html);
 assert.equal((shown.match(/\$\$/gu)||[]).length,1,shown);assert.doesNotMatch(shown,/##|\\frac|−/u,shown);assert.match(html,/<pre class="translated-formula"><span class="math-display">/u);
 // TeX allows no paragraph break in math: a blank line ends a formula only its delimiter keeps open...
 assert.deepEqual(blocks('Ta có \\[\n\nĐoạn mới.\n\\] hết.'),[['paragraph','Ta có \\['],['paragraph','Đoạn mới. \\] hết.']]);
 // ...while the rows of an environment still run across one, and a delimiter holding an environment, wherever it opens,
 // keeps the line of its closer.
 assert.deepEqual(blocks('Hệ \\begin{cases} a \\\\\n\nb \\end{cases} xong.'),[['paragraph','Hệ \\begin{cases} a \\\\\n\nb \\end{cases} xong.']]);
 assert.deepEqual(blocks('Hệ \\( x=\\begin{cases} a \\\\\nb \\end{cases}\n\\) có nghiệm.\nHết.'),[['paragraph','Hệ \\( x=\\begin{cases} a \\\\\nb \\end{cases}\n\\) có nghiệm.'],['paragraph','Hết.']]);
 // So does one whose line ends with a row break (\\): the formula's rows go on below, environment or not.
 for(const text of ['Giải hệ \\[ x+y=5 \\\\\nx-y=1 \\] ta được x=3.','Ta có $$ a=1 \\\\ \nb=2 $$ nên đúng.'])assert.deepEqual(blocks(text),[['paragraph',text.replace(/ \n/u,'\n')]],text);
 // One never closed keeps the lines of the environment it holds, which is drawn, and leaves the lines after it alone.
 const unclosed='\\[\\begin{cases} a \\\\\nb \\end{cases}\nĐoạn sau.';
 assert.deepEqual(blocks(unclosed),[['paragraph','\\[\\begin{cases} a \\\\\nb \\end{cases}'],['paragraph','Đoạn sau.']]);assert.match(translationContentHtml(unclosed),/math-env-cases/u);
 // Linear in practice: prose with $$, $…$ and \( between words, openers before blank lines, long runs inside one $…$,
 // row breaks and backslashes after an opener between words.
 for(const make of [n=>'Biến $$ chứa $a$$b$ và \\( x\n'.repeat(n),n=>'Ta có \\[\n\n'.repeat(n),n=>`$a ${'\\'.repeat(n)}$ ${'$a$'.repeat(n)}`,n=>'$a '.repeat(n),n=>`Biến $$ x ${'\\\\a '.repeat(n)}${'\\'.repeat(2*n+1)}`]){
  const text=make(20000),started=performance.now();translationBlocks(text);translationContentHtml(text);assert.ok(performance.now()-started<3000,`${text.slice(0,12)}: ${Math.round(performance.now()-started)} ms`);
 }
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
