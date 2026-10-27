import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {renderMathText,unsupportedMath,normalizeVectorMath,MATH_ENVIRONMENTS,mathStyles} from '../frontend/math-text.js';
import {translationBlocks,translationContentHtml} from '../frontend/study-layout-view.js';
import {pageMarkup} from '../frontend/pdf-box-layout.js';

// 2-D TeX in math-text.js: environments (cases, matrices, aligned…) drawn as an inline grid with SVG fences, stacks
// (limits, \overset, labelled arrows), \ce, and the bare-text rules OCR text needs (S_n, \{a_n\}, 50\%). The scaffolding
// of an environment never reaches the page, the text stays plain letters, and TeX the renderer does not know is kept as
// written in its smallest unit. None of this is specific to one subject or one book.
const R=String.raw,root=new URL('../',import.meta.url);
// What a reader copies: the HTML's text, the characters kept for drawn fences and arrows included. What a reader sees:
// the same without them (they are transparent) and without the drawings (SVG).
const copied=html=>html.replace(/<svg[\s\S]*?<\/svg>/gu,'').replace(/<[^>]+>/gu,'').replace(/&amp;/gu,'&').replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/&quot;/gu,'"').replace(/&#39;/gu,"'");
const seen=html=>copied(html.replace(/<span class="math-copy">[^<]*<\/span>/gu,''));
const count=(html,pattern)=>(html.match(pattern)||[]).length;
const SCAFFOLDING=/\\begin|\\end|\\\\|&|\\left|\\right/u;
// Mathematical italic letters (𝑎, 𝑛, 𝜶…) would break copying and searching; double-struck or script letters are meant.
const ITALIC=/[\u{1D434}-\u{1D49B}\u{1D608}-\u{1D66F}\u{1D6E2}-\u{1D755}\u{1D790}-\u{1D7C9}]/u;

test('every whitelisted environment is drawn as a grid in its class, inside any delimiter or bare, and its scaffolding never reaches the page',()=>{
 assert.deepEqual([...MATH_ENVIRONMENTS].sort(),['Bmatrix','Vmatrix','align','align*','aligned','alignedat','array','bmatrix','cases','dcases','equation','equation*','gather','gather*','gathered','matrix','pmatrix','rcases','smallmatrix','split','subarray','vmatrix'].sort());
 for(const name of MATH_ENVIRONMENTS){
  const argument=name==='array'||name==='subarray'?'{cc}':name==='alignedat'?'{1}':'',tex=`\\begin{${name}}${argument} a_1 & b \\\\[2pt] c & \\frac{1}{2} \\end{${name}}`;
  for(const text of [R`\(${tex}\)`,R`\[${tex}\]`,`$${tex}$`,`$$${tex}$$`,`Cho ${tex} xong`]){
   const html=renderMathText(text);
   assert.match(html,new RegExp(`<span class="math-env math-env-${name.replace('*','')}">`,'u'),text);
   assert.equal(count(html,/class="math-cell-[lcr]/gu),4,text);
   assert.match(seen(html),/a1bc12/u,text);assert.doesNotMatch(seen(html),SCAFFOLDING,text);assert.doesNotMatch(html,ITALIC,text);
   assert.deepEqual(unsupportedMath(text),[],text);
  }
 }
 // The fences of each family: none, one brace on the left (cases) or right (rcases), a pair round a matrix.
 for(const [name,fences] of [['matrix',0],['cases',1],['rcases',1],['pmatrix',2],['bmatrix',2],['Bmatrix',2],['vmatrix',2],['Vmatrix',2],['aligned',0]])assert.equal(count(renderMathText(`\\(\\begin{${name}}a&b\\end{${name}}\\)`),/class="math-fence"/gu),fences,name);
});

test('the screenshot\'s system is drawn with one brace, its rows and cells, and the subscripts OCR wrote in either form',()=>{
 const html=renderMathText(R`a_n = \begin{cases} S_1, & n = 1, \\ S_n - S_{n-1}, & n \geq 2. \end{cases}`);
 assert.equal(seen(html),'an = S1,n = 1,Sn − Sn−1,n ≥ 2.');
 assert.match(html,/^<span class="math-inline">a<sub>n<\/sub><\/span> = <span class="math-env math-env-cases"><span class="math-fence"[^>]*><svg[^>]*><path d="M9 1C/u);
 assert.equal(count(html,/class="math-fence"/gu),1);assert.equal(count(html,/math-gap/gu),2,'the conditions are a second column');
 // Gemini may write Unicode subscripts: kept as written, while S_n still becomes one.
 assert.equal(seen(renderMathText(R`aₙ = \begin{cases} S₁, & n = 1, \\ S_n - Sₙ₋₁, & n ≥ 2. \end{cases}`)),'aₙ = S₁,n = 1,Sn − Sₙ₋₁,n ≥ 2.');
 // The line above it on the page, with the sum's subscripts.
 assert.equal(seen(renderMathText(R`Rõ ràng \(S_1=a_1\), còn \(S_{n-1}=a_1+a_2+\cdots+a_{n-1}\ (n\geq 2)\),`)),'Rõ ràng S1=a1, còn Sn−1=a1+a2+⋯+an−1 (n≥ 2),');
});

test('a fence round a lone environment is its only fence, and \\left…\\right fences stretch round 2-D content only',()=>{
 for(const text of [R`\left\{\begin{array}{l} x+y=3 \\ x-y=1 \end{array}\right.`,R`\[\left\{\begin{array}{l} x+y=3 \\ x-y=1 \end{array}\right.\]`,R`\(\left\{ \begin{aligned} x&=1 \\ y&=2 \end{aligned} \right.\)`]){
  const html=renderMathText(text);
  assert.equal(count(html,/class="math-fence"/gu),1,text);assert.match(html,/<span class="math-env math-env-(?:array|aligned)"><span class="math-fence"[^>]*><svg[^>]*><path d="M9 1C/u,text);
  assert.doesNotMatch(seen(html),SCAFFOLDING,text);assert.doesNotMatch(seen(html),/[{}.]/u,text);
 }
 // A matrix keeps its own parentheses inside the \left[ … \right] written round it.
 assert.equal(count(renderMathText(R`\(\left[\begin{pmatrix}1\\2\end{pmatrix}\right]\)`),/class="math-fence"/gu),4);
 assert.match(renderMathText(R`\(\left(\frac{1}{2}\right)^{n}\)`),/<span class="math-fenced"><span class="math-fence"[\s\S]*class="math-frac"[\s\S]*<\/svg><\/span><\/span><sup>n<\/sup><\/span>$/u);
 assert.equal(renderMathText(R`\(\left\{ x \mid x>0 \right\}\)`),'<span class="math-inline">{ x ∣ x&gt;0 }</span>','one-line content keeps plain delimiters');
 assert.equal(seen(renderMathText(R`\(\left. \frac{dy}{dx} \right|_{x=0}\)`)),' dydx x=0');
 // A taller system gets a taller path box, so the curls of its brace keep their size.
 const box=html=>Number(/viewBox="0 0 10 (\d+)"/u.exec(html)[1]);
 const two=renderMathText(R`\begin{cases}a\\b\end{cases}`),four=renderMathText(R`\begin{cases}a\\b\\c\\d\end{cases}`);
 assert.ok(box(four)>1.8*box(two),`${box(two)} ${box(four)}`);for(const html of [two,four])assert.match(html,/d="M9 1C6 1 5 2 5 5V/u);
});

test('rows and cells: depth-counted \\end, optional row spacing, \\& and braces are not separators, rules and arguments are read',()=>{
 const nested=renderMathText(R`\(\begin{cases}\begin{cases}1&2\\3&4\end{cases} & x \\ y & z\end{cases}\)`);
 assert.equal(count(nested,/class="math-env math-env-cases"/gu),2);assert.equal(count(nested,/class="math-cell-/gu),8);assert.equal(seen(nested),'1234xyz');
 assert.equal(seen(renderMathText(R`\(\begin{cases} a \\[2pt] b \\* c \\[-1.5ex] d \\ \end{cases}\)`)),'abcd');
 assert.equal(count(renderMathText(R`\(\begin{cases} a \\[2pt] b \\ \end{cases}\)`),/class="math-cell-/gu),2,'a trailing \\\\ makes no empty row');
 assert.equal(seen(renderMathText(R`\(\begin{matrix} R\&D & {a&b} \end{matrix}\)`)),'R&Da&b');
 assert.match(renderMathText(R`\[f(x)=\begin{cases} x, & \text{khi } x \ge 0, \\ -x, & \text{trường hợp còn lại.} \end{cases}\]`),/<span class="math-cell-l math-gap"><span class="math-text">khi <\/span> x ≥ 0,<\/span>[\s\S]*<span class="math-text">trường hợp còn lại\.<\/span>/u,'Vietnamese words in a cell');
 assert.equal(seen(renderMathText(R`\(\begin{matrix} \sum_{\substack{i<m\\j<n}} & 1 \end{matrix}\)`)),'∑i<mj<n1');
 // The column rule is one item through both rows, the \hline one item across every column (the ruled-table test below).
 const ruled=renderMathText(R`\(\left[\begin{array}{cc|c} 1 & 2 & 3 \\ \hline 4 & 5 & 6 \end{array}\right]\)`);
 assert.equal(count(ruled,/class="math-vrule"/gu),1);assert.match(ruled,/<span class="math-vrule" style="grid-area:1\/3\/4\/4"><\/span>/u);assert.match(ruled,/<span class="math-hrule" style="grid-area:2\/1\/3\/5"><\/span>/u);
 assert.equal(count(ruled,/class="math-cell-c/gu),6);assert.equal(seen(ruled),'123456');assert.doesNotMatch(seen(ruled),/hline|cc\|c/u);
 assert.equal(count(renderMathText(R`\(\begin{array}{rl} a & b \end{array}\)`),/class="math-cell-r"|class="math-cell-l math-gap"/gu),2);
 const pairs=renderMathText(R`\(\begin{alignedat}{2} x&=1 & y&=2 \end{alignedat}\)`);assert.equal(seen(pairs),'x=1y=2');assert.equal(count(pairs,/math-gap2/gu),1);
 // TeX would refuse a top-level & or \\ in a formula; it is set as rows rather than printed.
 assert.equal(seen(renderMathText(R`\(a & b \\ c & d\)`)),'abcd');assert.match(renderMathText(R`\[x \\ y\]`),/math-env-gathered/u);
 // OCR sometimes doubles every backslash.
 assert.equal(seen(renderMathText(R`\\begin{cases} a & 1 \\\\ b & 2 \\end{cases}`)),'a1b2');
 // Backslashes go in pairs, as TeX reads them: \\\begin is a row break and then an environment (not a doubled
 // \begin whose rows would be halved away), and a doubled body keeps its own row breaks.
 for(const text of [R`\(\begin{cases} x=1 \\\begin{array}{l} y=2 \\ z=3 \end{array} \end{cases}\)`,R`\\begin{cases} x=1 \\\\\\begin{array}{l} y=2 \\\\ z=3 \\end{array} \\end{cases}`]){
  const html=renderMathText(text);
  assert.match(html,/math-env-cases"><span class="math-fence"[\s\S]*?<span class="math-cell-l">x=1<\/span><span class="math-cell-l"><span class="math-env math-env-array"><span class="math-grid"[^>]*><span class="math-cell-l">y=2<\/span><span class="math-cell-l">z=3<\/span>/u,text);
  assert.equal(count(html,/class="math-cell-/gu),4,text);
 }
 assert.equal(count(renderMathText(R`Hệ \\\begin{cases} a \\ b \end{cases}`),/class="math-cell-/gu),2);
});

test('ruled tables: each column rule runs through every row and each \\hline crosses every column, so the lines meet',()=>{
 // A probability distribution, as every probability chapter prints it: 4 rules and 3 columns across (7 tracks), 3 rules
 // and 2 rows down (5 tracks). Each rule is one item spanning its whole track, never a border cut at each cell.
 const table=renderMathText(R`\[\begin{array}{|c|c|c|}\hline X & 0 & 1 \\ \hline P & \frac{1}{2} & \frac{1}{2} \\ \hline \end{array}\]`);
 assert.match(table,/<span class="math-grid" style="grid-template-columns:repeat\(7,auto\)">/u);
 assert.deepEqual([...table.matchAll(/class="math-vrule" style="grid-area:([^"]+)"/gu)].map(m=>m[1]),['1/1/6/2','1/3/6/4','1/5/6/6','1/7/6/8']);
 assert.deepEqual([...table.matchAll(/class="math-hrule" style="grid-area:([^"]+)"/gu)].map(m=>m[1]),['1/1/2/8','3/1/4/8','5/1/6/8']);
 // The cells sit between the rules, in reading order, each with half a column gap on both sides (TeX's \arraycolsep).
 assert.deepEqual([...table.matchAll(/class="math-cell-c math-pad" style="grid-area:(\d+\/\d+)"/gu)].map(m=>m[1]),['2/2','2/4','2/6','4/2','4/4','4/6']);
 assert.equal(seen(table),'X01P1212');assert.doesNotMatch(table,/math-rule"|math-rule-end/u);assert.deepEqual(unsupportedMath(table),[]);
 // \cline{2-3} crosses its columns only, || is a double rule, : a dashed one, \hline\hline a double line.
 const kinds=renderMathText(R`\(\begin{array}{c||c:c}\hline a & b & c \\ \cline{2-3} d & e & g \\ \hline\hline \end{array}\)`);
 assert.match(kinds,/<span class="math-hrule" style="grid-area:3\/3\/4\/6"><\/span>/u);assert.match(kinds,/<span class="math-hrule math-rule2" style="grid-area:5\/1\/6\/6"><\/span>/u);
 assert.match(kinds,/<span class="math-vrule math-rule2" style="grid-area:1\/2\/6\/3"><\/span><span class="math-vrule math-dash" style="grid-area:1\/4\/6\/5"><\/span>/u);
 // {c|ccc} with a rule under its head row, and an \hline in a matrix (amsmath matrices are arrays).
 const head=renderMathText(R`\(\begin{array}{c|ccc} x & 1 & 2 & 3 \\ \hline y & 2 & 4 & 6 \end{array}\)`);
 assert.match(head,/<span class="math-hrule" style="grid-area:2\/1\/3\/6"><\/span><span class="math-vrule" style="grid-area:1\/2\/4\/3"><\/span>/u);
 assert.match(renderMathText(R`\(\begin{matrix} a & b \\ \hline c & d \end{matrix}\)`),/<span class="math-hrule" style="grid-area:2\/1\/3\/3"><\/span>/u);
 // A table with no rule keeps its plain grid, and a \cline outside the table draws nothing.
 assert.match(renderMathText(R`\(\begin{array}{cc} a & b \end{array}\)`),/<span class="math-cell-c">a<\/span><span class="math-cell-c math-gap">b<\/span>/u);
 assert.doesNotMatch(renderMathText(R`\(\begin{array}{cc}\cline{2-5} a & b \end{array}\)`),/math-hrule/u);
 // A rule changes its border style only: the sides it does not draw keep no width (a dashed rule is no thick bar).
 assert.match(mathStyles,/\.math-vrule\{align-self:stretch;border:0 solid currentColor;border-left-width:\.06em\}/u);assert.match(mathStyles,/\.math-hrule\{align-self:center;border:0 solid currentColor;border-top-width:\.06em\}/u);
});

test('a drawn fence or labelled arrow keeps its character in the copied text and for screen readers, with nothing visible or moved',()=>{
 // \left…\right round 2-D content, the fences of matrices, determinants and systems, and labelled reaction arrows.
 for(const [text,copy,visible] of [
  [R`\(a_n=\left(\frac{1}{2}\right)^{n-1}\) và \(\left|\frac{a}{b}\right|\) và \(\left[\frac{\pi}{2},\pi\right]\)`,'an=(12)n−1 và |ab| và [π2,π]','an=12n−1 và ab và π2,π'],
  [R`\(A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\), \(\begin{vmatrix}a&b\\c&d\end{vmatrix}\), \(\begin{cases}x=1\\y=2\end{cases}\), \(\left\{\begin{array}{l}x\\y\end{array}\right.\)`,'A=(1234), |abcd|, {x=1y=2, {xy','A=1234, abcd, x=1y=2, xy'],
  [R`\(A\xrightarrow{đun nóng}B\) \(\ce{2H2 + O2 ->[t^\circ] 2H2O}\) \(X\xleftarrow{h\nu}Y\) \(\xrightleftharpoons[b]{a}\)`,'Ađun nóng→B 2H2 + O2 t°→ 2H2O Xhν←Y a⇌b','Ađun nóngB 2H2 + O2 t° 2H2O XhνY ab']
 ]){const html=renderMathText(text);assert.equal(copied(html),copy,text);assert.equal(seen(html),visible,text);}
 // Each kept character is in the flow beside its drawing: never inside the positioned fence box (Chromium's PDF prints a
 // positioned element's text after the rest of its block) nor under aria-hidden.
 const html=renderMathText(R`\(\left(\frac{1}{2}\right)\begin{bmatrix}1\\2\end{bmatrix}\xrightarrow{a}\)`),open=[];let copies=0;
 for(const [tag,close,name,attributes] of html.matchAll(/<(\/?)([a-z]+)([^>]*?)\/?>/gu)){
  if(close){open.pop();continue;}
  if(/class="math-copy"/u.test(attributes)){copies++;assert.ok(open.every(parent=>!/aria-hidden|class="math-fence"/u.test(parent)),tag);assert.match(open.at(-1),/class="math-(?:fenced|env math-env-bmatrix|arrow)"/u,tag);}
  if(!tag.endsWith('/>'))open.push(attributes);
 }
 assert.equal(copies,5);assert.equal(count(html,/<span class="math-fence" aria-hidden="true"/gu),4,'the drawings stay hidden from screen readers');
 // Transparent text with no width, on the content's middle: kept in the PDF's text layer (opacity 0 and clipped text are
 // dropped there) and never moving the drawing.
 const style=/\.math-copy\{([^}]*)\}/u.exec(mathStyles)[1];
 for(const rule of ['color:transparent','width:0','flex:none','line-height:0','align-self:center'])assert.ok(style.includes(rule),rule);
 assert.doesNotMatch(style,/opacity|position|overflow|clip|display:none|visibility/u);
});

test('unsupportedMath also lists each formula or cell printed as written for want of a brace, a script or an argument, by its first characters',()=>{
 for(const [text,listed] of [
  [R`\(\frac{1}{2\)`,[R`\(\frac{1}{2\)`]],[R`\(x^\)`,[R`\(x^\)`]],[R`\(\frac{1}{}\)`,[R`\(\frac{1}{}\)`]],[R`\(\vec{}\)`,[R`\(\vec{}\)`]],[R`\(x^{2}}\)`,[R`\(x^{2}}\)`]],['$a_$',['$a_$']],
  // A cell printed as written is listed by its own source; the system round it is drawn.
  [R`\[\begin{cases} \frac{1}{ & 1 \\ y & 2 \end{cases}\]`,[R`\frac{1}{`]],[R`\[\begin{cases} \(x\)=1 \\ y=2 \end{cases}\]`,[R`\(x\)=1`]],[R`Hệ \begin{cases} x^ & 1 \end{cases}`,['x^']],
  // A cell and the formula round it, both printed as written, are both listed.
  [R`\(\begin{cases}\frac{1}{ & 2\end{cases} + \frac{3}{\)`,[R`\frac{1}{`,R`\(\begin{cases}\frac{1}{…`]],
  // Past 24 characters the source is cut, its spaces and line breaks shown as one space.
  ['\\(\\frac{a+b+c+d}{\n  e+f+g+h+i+j\\)',['\\(\\frac{a+b+c+d}{ e+f+g+…']],
  // A failure an unknown command explains is listed by that name alone, each name once.
  [R`\(\foo\) và \(\foo\) và \(\frac{1}{\)`,[R`\foo`,R`\(\frac{1}{\)`]],[R`\(\begin{cases} \foo x & 1 \end{cases}\)`,[R`\foo`]]
 ])assert.deepEqual(unsupportedMath(text),listed,text);
 // What is drawn is not listed, and bare text outside formulas and environments is text, not a formula.
 for(const text of [R`\(\frac{1}{2}\) \[\begin{cases} x^{2} & 1 \\ \frac{1}{2} & 2 \end{cases}\]`,R`\frac{1}{2`,R`Giá $5 và $10`,R`\(x^{}\)`])assert.deepEqual(unsupportedMath(text),[],text);
 // With the general reader's options too.
 assert.deepEqual(unsupportedMath(R`\(x^\)`,{bare:false}),[R`\(x^\)`]);
});

test('normalizeVectorMath leaves a closed bare environment as it is, as the renderer reads it, so its cells are still drawn',()=>{
 for(const [text,normalized] of [
  [R`已知 \begin{cases} \vec{a}=@@PDF_INLINE_1@@ \\ \vec{b}=(1,2) \end{cases}`,R`已知 \begin{cases} \vec{a}=@@PDF_INLINE_1@@ \\ \vec{b}=(1,2) \end{cases}`],
  ['已知 \\begin{cases} AB⃗=@@PDF_INLINE_1@@ \\\\ x=1 \\end{cases}','已知 \\begin{cases} AB⃗=@@PDF_INLINE_1@@ \\\\ x=1 \\end{cases}'],
  // Vectors outside it are still wrapped, with its \left\{ … \right. untouched, and a doubled \\vec is still \vec.
  [R`\vec{u} và \left\{\begin{array}{l} \vec{a}\perp\vec{b} \\ \overrightarrow{AB}=\vec{c} \end{array}\right. và \vec{v}`,R`\(\vec{u}\) và \left\{\begin{array}{l} \vec{a}\perp\vec{b} \\ \overrightarrow{AB}=\vec{c} \end{array}\right. và \(\vec{v}\)`],
  [R`\\vec{x} \begin{cases} \\vec{a} & \text{khi $\vec{b}\ne 0$} \end{cases} $\vec{c}$`,R`\(\vec{x}\) \begin{cases} \vec{a} & \text{khi $\vec{b}\ne 0$} \end{cases} $\vec{c}$`],
  // One never closed, or one the renderer does not know, is text: its vectors are wrapped as before.
  [R`\begin{cases} \vec{a} và \vec{b}`,R`\begin{cases} \(\vec{a}\) và \(\vec{b}\)`],[R`\begin{tabular}{c} \vec{a} \end{tabular}`,R`\begin{tabular}{c} \(\vec{a}\) \end{tabular}`]
 ])assert.equal(normalizeVectorMath(text),normalized,text);
 const system=normalizeVectorMath(R`Cho \begin{cases} \vec{a}=(1,2) \\ AB⃗=\vec{c} \end{cases}`);
 assert.deepEqual(unsupportedMath(system),[]);assert.equal(count(renderMathText(system),/class="math-vector"/gu),3);assert.doesNotMatch(seen(renderMathText(system)),/\\\(|\\vec/u);
});

test('the line breaks just inside a formula\'s delimiters are dropped, as TeX drops them; other spaces stay as written',()=>{
 // \[ on a line of its own, the system on the next (as the OCR prompt asks and models write it): no blank line above the
 // system in a display formula, whose white-space is pre-wrap.
 const display=renderMathText('\\[\n\\begin{cases}\nS_1, & n=1, \\\\\nS_n-S_{n-1}, & n\\geq 2.\n\\end{cases}\n\\]');
 assert.match(display,/^<span class="math-display"><span class="math-env math-env-cases">/u);assert.match(display,/<\/span><\/span><\/span>$/u);assert.doesNotMatch(display,/\n/u);
 assert.equal(renderMathText('\\(\n x+1 \n\\)'),'<span class="math-inline">x+1</span>');assert.equal(renderMathText('$$\r\n\tx\r\n$$'),'<span class="math-display">x</span>');assert.equal(renderMathText('\\[ \n \\]'),'<span class="math-display"></span>');
 assert.equal(renderMathText('\\( x+1 \\)'),'<span class="math-inline"> x+1 </span>','spaces with no line break stay');
 assert.deepEqual(unsupportedMath('\\[\n\\begin{cases}\na \\\\\nb\n\\end{cases}\n\\]'),[]);
 // A space its backslash escapes (\ , TeX's control space) is part of the formula, before the line break too: dropped,
 // it would leave a lone backslash, and the formula would be printed as written.
 for(const [text,html] of [['\\[\nx = 1,\\ \n\\]','<span class="math-display">x = 1, </span>'],['\\(a\\ \n\\)','<span class="math-inline">a </span>'],['\\(\\ \r\n\\)','<span class="math-inline"> </span>']])assert.equal(renderMathText(text),html,text);
 for(const text of ['\\[\nx = 1,\\ \n\\]','\\[ a \\quad \\text{và}\\ \n\\]','\\(a\\\\\\ \n\\)','\\[\\begin{cases} a \\\\ b \\end{cases}\\ \n\\]'])assert.deepEqual(unsupportedMath(text),[],text);
 // So is one ending a cell, a row or a line of \substack (x=1,\ & …), which printed a lone backslash there.
 for(const text of ['\\(\\begin{cases} x=1,\\ & a \\\\ y & b \\end{cases}\\)','\\[ a=1,\\ \\\\ b \\]','\\(a\\\\\\ \\)','\\(\\sum\\limits_{\\substack{i<n,\\ \\\\ j>0}} x\\)']){
  const html=renderMathText(text);assert.doesNotMatch(seen(html),/\\/u,`${text}: ${seen(html)}`);assert.deepEqual(unsupportedMath(text),[],text);
 }
});

test('a command written with its backslash doubled (JSON or OCR escaping) is that command, while a row break stays one',()=>{
 assert.equal(seen(renderMathText(R`Ta có \(x \\geq 2\) và \(\\frac{1}{2}\), \(a\\cdot b\), \(\\alpha+\\beta\).`)),'Ta có x ≥ 2 và 12, a· b, α+β.');
 assert.equal(seen(renderMathText(R`\(\\sqrt{2}\)`,{bare:false})),'√2');
 assert.deepEqual(unsupportedMath(R`\(x \\geq 2\) \(\\frac{1}{2}\)`),[]);
 // normalizeVectorMath reads each run of backslashes once (linear): a doubled \vec is \vec, any other run stays.
 assert.equal(normalizeVectorMath(R`\\vec{a} và \\\overrightarrow{AB} và \\\\ x \\vecx và \vec{b}`),R`\(\vec{a}\) và \(\overrightarrow{AB}\) và \\\\ x \\vecx và \(\vec{b}\)`);
 // \\ before plain letters, a space or another backslash is a row break: these are still rows (\\\cos: a break, then \cos).
 for(const [text,cells] of [[R`\(a \\ b\)`,['a','b']],[R`\(x=1 \\ y=2\)`,['x=1','y=2']],[R`\(a\\b\)`,['a','b']],[R`\(a & b \\ c & d\)`,['a','b','c','d']],[R`\(x \\sin y \\\cos z\)`,['x sin y','cos z']]]){
  const html=renderMathText(text);assert.match(html,/math-env-(?:gathered|aligned)/u,text);
  assert.deepEqual([...html.matchAll(/<span class="math-cell-[lcr][^"]*">([\s\S]*?)<\/span>(?=<span class="math-cell|<\/span><\/span>)/gu)].map(m=>seen(m[1])),cells,text);
 }
});

test('a row break before a bracket (\\\\( or \\\\[2pt]) or an escaped \\$ never opens a formula, so a bare system keeps its rows whole',()=>{
 const system=R`Giải hệ \begin{cases} x+y=5 \\(x-1)(y-1)=2 \end{cases} ta được \(x=3\).`,spaced=R`\begin{aligned} a &= 1 \\[4pt] b &= 2 \end{aligned} và \[c=3\]`;
 assert.equal(seen(renderMathText(system)),'Giải hệ x+y=5(x−1)(y−1)=2 ta được x=3.');assert.equal(count(renderMathText(system),/class="math-cell-/gu),2);
 assert.equal(seen(renderMathText(spaced)),'a= 1b= 2 và c=3');assert.match(renderMathText(spaced),/math-env-aligned[\s\S]*<span class="math-display">c=3<\/span>$/u);
 for(const text of [system,spaced])assert.deepEqual(unsupportedMath(text),[],text);
 // After an odd run the last backslash opens: \\ and then \(…\).
 assert.match(renderMathText(R`a \\\(x^2\)`),/^a \\\\<span class="math-inline">x<sup>2<\/sup><\/span>$/u);
 // \$ is a dollar sign, as TeX and Pandoc read it: prices stay text and never open a formula, while $y$ still is one.
 const prices=R`Giá \$5 và \$10, còn \$x$ là chữ và $y$ là công thức.`;
 assert.equal(seen(renderMathText(prices)),'Giá $5 và $10, còn $x$ là chữ và y là công thức.');assert.equal(count(renderMathText(prices),/math-inline/gu),1);
 assert.equal(renderMathText(R`\$x$ và \\$y$`,{bare:false}),R`\$x$ và \\<span class="math-inline">y</span>`);
});

test('a bare system whose conditions hold $…$ (\\text{khi $n=1$}) is drawn whole in every view, and formulas around it still are formulas',()=>{
 for(const text of [
  R`a_n = \begin{cases} S_1, & \text{khi $n = 1$}, \\ S_n - S_{n-1}, & \text{khi $n \geq 2$}. \end{cases}`,
  R`Cho $x$ và f(x)=\begin{cases} x^2 & \text{nếu $x\ge 0$} \\ -x & \text{nếu $x<0$} \end{cases} với $y=1$.`,
  R`\left\{\begin{array}{l} x>0 \\ y=\text{giá trị của $x$} \end{array}\right.`
 ]){
  const html=renderMathText(text);
  assert.equal(count(html,/class="math-env math-env-/gu),1,text);assert.doesNotMatch(seen(html),SCAFFOLDING,text);assert.doesNotMatch(seen(html),/\$/u,text);
  assert.deepEqual(unsupportedMath(text),[],text);assert.doesNotMatch(seen(translationContentHtml(text)),SCAFFOLDING,text);
 }
 assert.equal(seen(renderMathText(R`a_n = \begin{cases} S_1, & \text{khi $n = 1$}, \\ S_n - S_{n-1}, & \text{khi $n \geq 2$}. \end{cases}`)),'an = S1,khi n = 1,Sn − Sn−1,khi n ≥ 2.');
 assert.equal(count(renderMathText(R`Cho $x$ và f(x)=\begin{cases} x^2 & \text{nếu $x\ge 0$} \\ -x & \text{nếu $x<0$} \end{cases} với $y=1$.`),/class="math-inline"/gu),2);
 // A formula that opens before an environment and closes inside it has already broken it: the rest is read as before.
 assert.match(renderMathText(R`$a \begin{cases} b$ & c $d$ \end{cases}`),/<span class="math-inline">d<\/span>/u);
 // The general reader (bare:false) never draws bare environments, so their $…$ are still formulas there.
 assert.equal(count(renderMathText(R`\begin{cases} 1 & \text{khi $n=1$} \end{cases}`,{bare:false}),/class="math-inline"/gu),1);
});

test('an unknown environment is drawn row by row, and an unknown command keeps only its own cell or formula as written',()=>{
 const table=renderMathText(R`Bảng \begin{tabular}{|c|c|} a & b \\ c & d \end{tabular}.`);
 assert.match(table,/<span class="math-env math-env-unknown"><span class="math-row">a b<\/span><span class="math-row">c d<\/span><\/span>\.$/u);
 assert.doesNotMatch(seen(table),/tabular|\|c\||&|\\\\/u);assert.deepEqual(unsupportedMath(R`\begin{tabular}{|c|c|} a & b \end{tabular}`),[R`\begin{tabular}`]);
 const cell=renderMathText(R`\(\begin{cases} \foo x, & x>0 \\ -x, & x\le 0 \end{cases}\)`);
 assert.equal(seen(cell),R`\foo x,x>0−x,x≤ 0`);assert.equal(count(cell,/class="math-cell-/gu),4);assert.deepEqual(unsupportedMath(R`\(\begin{cases} \foo x & 1 \end{cases}\)`),[R`\foo`]);
 // The formula round an environment is shown as written, the environment still drawn.
 const outer=renderMathText(R`\(\foo{X} = \begin{pmatrix}1&0\\0&1\end{pmatrix}\)`);
 assert.equal(seen(outer),R`\(\foo{X} = 1001\)`);assert.match(outer,/math-env-pmatrix/u);
 assert.deepEqual(unsupportedMath(R`\(\foo + \bar{x}\) và \[\begin{xyz}a\end{xyz}\] \(\begin{cases}a\)`),[R`\foo`,R`\begin{xyz}`,R`\begin{cases}`]);
 assert.deepEqual(unsupportedMath(R`\(\frac{1}{2}\) \begin{cases}a&b\end{cases} C:\Users\foo\x \foo`),[],'paths and bare unknown words are not math');
 assert.deepEqual(unsupportedMath(R`\(\foo\)`,{bare:false}),[R`\foo`]);
 // \left…\right round TeX that cannot be drawn: inside math its formula is shown as written; in bare text the pair keeps
 // its delimiters and only the unknown command stays as written.
 assert.equal(renderMathText(R`\(\left( \foo x \right)\)`),R`\(\left( \foo x \right)\)`);
 assert.equal(renderMathText(R`Xét \left( \foo x \right) nhé`),R`Xét ( \foo x ) nhé`);assert.deepEqual(unsupportedMath(R`Xét \left( \foo x \right) nhé`),[R`\foo`]);
 // \text holding a brace or a command cannot be set: its formula is shown as written and \text is reported.
 assert.equal(renderMathText(R`\(\text{a{b}c}\)`),R`\(\text{a{b}c}\)`);assert.deepEqual(unsupportedMath(R`\(x+\textbf{a\foo b}\)`),[R`\textbf`]);
});

test('the commands added for textbooks of every subject render, and none of them is printed as TeX',()=>{
 for(const [text,expected] of [
  [R`\(\overset{t^\circ}{\longrightarrow}\)`,'t°⟶'],[R`\(\underset{x\to 0}{\lim}\)`,'limx→ 0'],[R`\(a\stackrel{\text{def}}{=}b\)`,'adef=b'],
  [R`\(\xrightarrow[\Delta]{MnO_2}\)`,'MnO2Δ'],[R`\(\xleftarrow{a}\)`,'a'],[R`\(\xlongequal{\text{点燃}}\)`,'点燃'],[R`\(\xrightleftharpoons[b]{a}\)`,'ab'],
  [R`\(\sum_{\substack{0<i<m \\ 0<j<n}}\)`,'∑0<i<m0<j<n'],[R`\(\underbrace{1+1}_{n}\)`,'1+1n'],[R`\(\overbrace{a+b}^{2}\)`,'2a+b'],[R`\(\overparen{AB}\wideparen{CD}\)`,'ABCD'],
  [R`\(\mathbb{R}\mathbb{N}\mathbb{Z}\mathbb{Q}\mathbb{C}\Bbb{1}\)`,'ℝℕℤℚℂ𝟙'],[R`\(\mathcal{L}\mathscr{F}\mathfrak{g}\)`,'ℒℱ𝔤'],[R`\(\boldsymbol{a}\bm{b}\mathsf{T}\mathtt{x}\)`,'abTx'],
  [R`\(\boxed{x=2}\)`,'x=2'],[R`\(E=mc^2\tag{1}\)`,'E=mc2(1)'],[R`\(a\equiv b\pmod{m}\)`,'a≡ b (mod m)'],[R`\(a\bmod b\)`,'a mod b'],
  [R`\(a\not= b, \not\in, \not\perp\)`,'a≠ b, ∉, ⊥̸'],[R`\(\lim\limits_{n\to\infty}\)`,'limn→∞'],[R`\(\displaystyle\sum_{i=1}^n i\)`,'n∑i=1 i'],[R`\[\textstyle\sum_{i=1}^n i\]`,'∑i=1n i'],
  [R`\(a\,b\;c\:d\!e\quad f\qquad g\ h\)`,'a\u2009b\u2004c\u205fde\u2003 f\u2003\u2003 g h'],[R`\(\%\#\$\&\_\{\}\)`,'%#$&_{}'],
  [R`\(\nRightarrow \subsetneqq \nsubseteq \supsetneqq \complement\)`,'⇏ ⫋ ⊈ ⫌ ∁'],[R`\(x\in\mathbb{R}, \text{khi $y<1$}\)`,'x∈ℝ, khi y<1'],
  [R`\(\text{nếu $x\ge 0$}, \text{giá 50\% và \$5}\)`,'nếu x≥ 0, giá 50% và $5'],[R`\(\mathbb{R^2}\mathbb{Z_+}\mathbb{R^n}\mathbb{R^\alpha}\)`,'ℝ2ℤ+ℝnℝα'],[R`\(\left\{x\mid x>0\right\}\)`,'{x∣ x>0}']
 ]){const html=renderMathText(text);assert.equal(seen(html),expected,text);assert.doesNotMatch(seen(html),/\\[A-Za-z]/u,text);assert.deepEqual(unsupportedMath(text),[],text);}
 // A letter style keeps its letters' scripts as scripts, and a condition in \text reads its own math.
 assert.match(renderMathText(R`\(\mathbb{R^2}\)`),/ℝ<sup>2<\/sup>/u);assert.match(renderMathText(R`\(\mathbb{Z_+}\)`),/ℤ<sub>\+<\/sub>/u);
 assert.equal(seen(renderMathText(R`\(f(x)=\begin{cases} x^2 & \text{nếu $x\ge 0$} \\ -x & \text{nếu $x<0$} \end{cases}\)`)),'f(x)=x2nếu x≥ 0−xnếu x<0');
 // C7: stacks and labelled arrows are math-stack pieces the PDF fitting measures whole.
 for(const text of [R`\(\overset{a}{b}\)`,R`\(\xrightarrow{a}\)`,R`\[\sum_{i=1}^n i\]`,R`\(\underbrace{a}_{n}\)`])assert.match(renderMathText(text),/class="math-stack/u,text);
 // The shaft is drawn in two halves round the arrow's sign, kept as text (copied below).
 assert.equal(count(renderMathText(R`\(\xrightarrow[\Delta]{MnO_2}\)`),/<svg class="math-arrow-(?:head|shaft)"/gu),3);
});

test('\\ce and \\pu: formulas, charges, states, hydrates, isotopes and labelled arrows as chemistry textbooks write them',()=>{
 for(const [text,expected] of [
  [R`\(\ce{2H2 + O2 -> 2H2O}\)`,'2H2 + O2 → 2H2O'],[R`\(\ce{Fe^{3+} + 3OH- -> Fe(OH)3 v}\)`,'Fe3+ + 3OH− → Fe(OH)3 ↓'],[R`\(\ce{NH4+ + OH- <=> NH3 ^ + H2O}\)`,'NH4+ + OH− ⇌ NH3 ↑ + H2O'],
  [R`\(\ce{NaCl(aq) <- Na+ + Cl-}\)`,'NaCl(aq) ← Na+ + Cl−'],[R`\(\ce{CuSO4.5H2O}\)`,'CuSO4·5H2O'],[R`\(\ce{A <-> B}\)`,'A ↔ B'],
  [R`\(\ce{N2 + 3H2 <=>[\text{高温}][\text{催化剂}] 2NH3}\)`,'N2 + 3H2 高温催化剂 2NH3'],[R`\ce{2KClO3 ->[MnO2][\Delta] 2KCl + 3O2 ^}`,'2KClO3 MnO2Δ 2KCl + 3O2 ↑'],
  [R`\(\pu{1.2 kJ.mol-1}\)`,'1.2 kJ·mol−1'],[R`\(\pu{9.8 m/s2}\)`,'9.8 m/s2'],
  // Heating over the arrow, as Vietnamese and Chinese textbooks write it: t° (t^\circ, t^{\circ}) or t with a raised o.
  [R`\(\ce{Fe2O3 + 3CO ->[t^\circ] 2Fe + 3CO2}\)`,'Fe2O3 + 3CO t° 2Fe + 3CO2'],[R`\(\ce{CaCO3 ->[t^{\circ}] CaO + CO2 ^}\)`,'CaCO3 t° CaO + CO2 ↑'],[R`\(\ce{CH4 + 2O2 ->[t^o] CO2 + 2H2O}\)`,'CH4 + 2O2 to CO2 + 2H2O'],
  [R`\(\ce{2H2 + O2 ->[t^\circ] 2H2O}\)`,'2H2 + O2 t° 2H2O'],[R`\ce{2H2 + O2 ->[t^\circ] 2H2O}`,'2H2 + O2 t° 2H2O'],[R`\(\ce{2H2O ->[$t^\circ$] 2H2 + O2}\)`,'2H2O t° 2H2 + O2'],[R`\(A\xrightarrow{t^\circ}B\xrightarrow[t^{\circ}]{}C\)`,'At°Bt°C']
 ]){const html=renderMathText(text);assert.equal(seen(html),expected,text);assert.deepEqual(unsupportedMath(text),[],text);}
 assert.match(renderMathText(R`\(\ce{CH4 ->[t^o] C}\)`),/<span class="math-above"><span class="math-chem">t<sup>o<\/sup><\/span><\/span>/u);
 assert.match(renderMathText(R`\(\ce{2H2O}\)`),/2H<sub>2<\/sub>O/u);assert.match(renderMathText(R`\(\ce{Fe(OH)3}\)`),/Fe\(OH\)<sub>3<\/sub>/u);
 assert.match(renderMathText(R`\(\ce{SO4^2-}\)`),/SO<span class="math-subsup"><sub>4<\/sub><sup>2−<\/sup><\/span>/u);assert.match(renderMathText(R`\(\ce{NH4+}\)`),/NH<span class="math-subsup"><sub>4<\/sub><sup>\+<\/sup><\/span>/u);
 assert.match(renderMathText(R`\(\ce{^{14}_{6}C}\)`),/<span class="math-subsup"><sub>6<\/sub><sup>14<\/sup><\/span>C/u,'an isotope\'s numbers stand before it');
 assert.match(renderMathText(R`\(\ce{(C6H10O5)n}\)`),/\)<sub>n<\/sub>/u);assert.doesNotMatch(renderMathText(R`\(\ce{NaCl(aq)}\)`),/<sub>/u,'a state is not a count');
 assert.match(renderMathText(R`\(\ce{A ->[\text{点燃}] B}\)`),/A <span class="math-stack math-xarrow"><span class="math-above"><span class="math-chem"><span class="math-text">点燃<\/span><\/span><\/span><span class="math-stack-main"><span class="math-stack-base"><span class="math-arrow">/u);
 assert.match(renderMathText(R`\(\pu{9.8 m/s2}\)`),/s<sup>2<\/sup>/u);
});

test('degree signs, relations and big operators: limits stacked in display style or after \\limits, at the side inline',()=>{
 assert.equal(seen(renderMathText(R`\(90^\circ\) \(90^{\circ}\) \(\angle A=30\degree\) 90^\circ 25\,^{\circ}C \(f\circ g\) 45^∘`)),'90° 90° ∠A=30° 90° 25 °C f∘ g 45°');
 const stacked=html=>/class="math-stack[ "]/u.test(html),side=html=>/class="math-subsup"/u.test(html);
 for(const name of ['sum','prod','bigcup','bigcap','lim','max','min','sup','inf']){
  const tex=`\\${name}_{i=1}^{n} a_i`,display=renderMathText(`\\[${tex}\\]`),inline=renderMathText(`\\(${tex}\\)`);
  assert.ok(stacked(display)&&!side(display),`${name} display`);assert.ok(side(inline)&&!stacked(inline),`${name} inline`);
  assert.ok(stacked(renderMathText(`\\(\\${name}\\limits_{i=1}^{n} a_i\\)`)),`${name}\\limits`);assert.ok(!stacked(renderMathText(`\\[\\${name}\\nolimits_{i=1}^{n} a_i\\]`)),`${name}\\nolimits`);
 }
 // Integrals, multiple and contour ones alike, keep theirs at the side of the large sign in display style, as TeX and
 // printed textbooks set them; \limits stacks them in a stack of their own kind, which keeps the upper limit off the
 // sign's hook.
 assert.match(renderMathText(R`\[\int_0^1 f\,dx\]`),/<span class="math-bigop">∫<\/span><span class="math-subsup"><sub>0<\/sub><sup>1<\/sup><\/span>/u);
 for(const name of ['int','iint','iiint','oint','oiint']){
  const display=renderMathText(`\\[\\${name}_{D}^{E} f\\]`),limits=renderMathText(`\\[\\${name}\\limits_{D}^{E} f\\]`);
  assert.ok(side(display)&&!stacked(display)&&/math-bigop/u.test(display),`${name} display`);assert.ok(side(renderMathText(`\\(\\${name}_{D}^{E} f\\)`)),`${name} inline`);
  assert.match(limits,/<span class="math-stack math-int"><span class="math-above">E<\/span><span class="math-stack-main"><span class="math-stack-base"><span class="math-bigop">/u,`${name}\\limits`);
 }
 assert.match(mathStyles,/\.math-int>\.math-above\{margin-bottom:[.\d]+em\}/u);
 assert.ok(side(renderMathText(R`\[\int\nolimits_0^1 f\,dx\]`))&&!stacked(renderMathText(R`\[\int\nolimits_0^1 f\,dx\]`)));
 assert.match(renderMathText(R`\[\sum_{i=1}^n i\]`),/<span class="math-stack"><span class="math-above">n<\/span><span class="math-stack-main"><span class="math-stack-base"><span class="math-bigop">∑<\/span><\/span><span class="math-below">i=1<\/span>/u);
 // A subscript and a superscript on one base stand one over the other, the subscript first for copied text.
 assert.match(renderMathText(R`\(x_1^2\)`),/x<span class="math-subsup"><sub>1<\/sub><sup>2<\/sup><\/span>/u);assert.match(renderMathText(R`\({}^{14}_{6}\mathrm{C}\)`),/<span class="math-subsup"><sub>6<\/sub><sup>14<\/sup><\/span><span class="math-mathrm">C/u);
});

test('bare text: a one-letter base takes a one-letter subscript, while identifiers, emoticons, prices, paths and links stay as written',()=>{
 for(const [text,html] of [['S_n','S<sub>n</sub>'],['a_n','a<sub>n</sub>'],['x_i','x<sub>i</sub>'],['C_n^k','C<span class="math-subsup"><sub>n</sub><sup>k</sup></span>'],['a_n^2','a<span class="math-subsup"><sub>n</sub><sup>2</sup></span>'],['α_k','α<sub>k</sub>'],['F_f','F<sub>f</sub>'],['N_n','N<sub>n</sub>'],['O_a','O<sub>a</sub>']])
  for(const around of [t=>t,t=>`(${t})`,t=>`Tổng ${t}, còn`,t=>`${t}=1`])assert.equal(renderMathText(around(text)),around(`<span class="math-inline">${html}</span>`),around(text));
 // Emoticons (T_T, ^_^, -_-, and a letter under itself: u_u, o_o, x_x, O_o) belong to comics, novels and chat logs.
 const kept='MAX_2 snake_case_name var_1 T_T ^_^ -_- =_= u_u o_o x_x O_o o_O n_n v_v Hello_2 a_b_c x_ij x_nA S_N giá $5 và $10, $5-$10 /home/u_n/x_1 ~/a_b C:\\data\\a_n https://x.com/a_n www.x.vn/a_n an@x.com_2';
 assert.equal(renderMathText(kept),kept.replace(/&/gu,'&amp;'));
 for(const text of ['Mình buồn quá u_u, ngạc nhiên o_o, mệt x_x, chán -_- (o_o)','u_u.','x_x!'])assert.equal(renderMathText(text),text,text);
 assert.match(renderMathText('Phản ứng tạo S_1 và H_2O.'),/math-chem">S<sub>1<\/sub><\/span> và <span class="math-inline math-chem">H<sub>2<\/sub>O/u,'S_1 is still sulfur');
 // Escapes and spacing written without delimiters by OCR; a path keeps its own backslashes.
 assert.equal(seen(renderMathText(R`50\%, \{a_n\}, a\,b, \$5, R\&D`)),'50%, {an}, a\u2009b, $5, R&D');assert.equal(renderMathText(R`C:\temp\%x\% \\server\_y`),R`C:\temp\%x\% \\server\_y`);
 assert.equal(seen(renderMathText(R`\displaystyle\frac{1}{2} \left( x \right) \limits`)),'12 ( x ) ');
});

test('\\begin, \\end and the new names are known commands: a word holding them is TeX, not a Windows path',()=>{
 assert.equal(seen(renderMathText(R`x\in\mathbb{R}, \begin{cases}x\geq2&1\\x<2&0\end{cases}`)),'x∈ℝ, x≥21x<20');
 assert.equal(seen(renderMathText(R`\overset{a}{=}\xrightarrow{t}\boxed{1}\pmod{3}`)),'a=t1 (mod 3)');
 for(const path of [R`D:\data\in\begin.txt`,R`C:\Users\Lan\cases\end`,R`\\server\left\right`,R`Program Files\App\begin\log`])assert.equal(renderMathText(path),path);
});

test('the general reader (bare:false) still draws only delimited math: bare environments, escapes and letter subscripts stay as written',()=>{
 for(const text of [R`\begin{cases}x&1\\y&2\end{cases}`,R`50\% \{a\} S_n a_n C_n^k 90^\circ`,R`\left(\frac{1}{2}\right)`])assert.equal(renderMathText(text,{bare:false}),text.replace(/&/gu,'&amp;'),text);
 assert.match(renderMathText(R`\(\begin{cases}x&1\\y&2\end{cases}\)`,{bare:false}),/math-env-cases/u);
});

test('reading mode: a line opening a bare environment is a formula kept whole until its \\end, and a paragraph never splits one',()=>{
 const text=R`Do đó ta có
a_n = \begin{cases} S_1, & n = 1, \\
S_n - S_{n-1}, & n \geq 2. \end{cases}
\begin{cases} x+y=3, \\
x-y=1. \end{cases}
\left\{\begin{array}{l} x=1 \\ y=2 \end{array}\right.
\begin{tabular}{c} a \end{tabular}
Đoạn cuối.`;
 assert.deepEqual(translationBlocks(text),[
  {kind:'paragraph',text:'Do đó ta có'},{kind:'paragraph',text:'a_n = \\begin{cases} S_1, & n = 1, \\\\\nS_n - S_{n-1}, & n \\geq 2. \\end{cases}'},
  {kind:'formula',text:'\\begin{cases} x+y=3, \\\\\nx-y=1. \\end{cases}'},{kind:'formula',text:'\\left\\{\\begin{array}{l} x=1 \\\\ y=2 \\end{array}\\right.'},
  {kind:'paragraph',text:'\\begin{tabular}{c} a \\end{tabular}'},{kind:'paragraph',text:'Đoạn cuối.'}
 ]);
 const html=translationContentHtml(text);
 assert.equal(count(html,/<pre class="translated-formula"><span class="math-display"><span class="math-env/gu),2);assert.equal(count(html,/math-env-cases/gu),2);
 assert.doesNotMatch(seen(html),/\\begin|\\end|&|\\\\/u);
 // Paragraphs separated by blank lines: the environment's lines still join one paragraph.
 assert.equal(translationBlocks('Ta có \\begin{cases} a \\\\\nb \\end{cases} nên\nđúng.\n\nHết.')[0].text,'Ta có \\begin{cases} a \\\\\nb \\end{cases} nên đúng.');
 // One never closed (an OCR slip) leaves its line alone: the lines after it keep their own blocks.
 assert.deepEqual(translationBlocks('\\begin{pmatrix} 1 \\\\\n2\n# Mục\nTa có \\begin{cases} a\nb.').map(block=>[block.kind,block.text]),[['formula','\\begin{pmatrix} 1 \\\\'],['paragraph','2'],['heading','Mục'],['paragraph','Ta có \\begin{cases} a'],['paragraph','b.']]);
 const long=`\\begin{cases} x\n${'x\\\\\n'.repeat(20000)}`,started=performance.now();assert.equal(translationBlocks(long).length,20001);assert.ok(performance.now()-started<2000,'an unclosed environment is looked for a bounded number of lines');
});

test('formula crops inside cells stay images in their cells, and nothing of a token or private-use character leaks',()=>{
 const png='data:image/png;base64,QUJD',token=n=>`@@PDF_INLINE_${n}@@`,inline=(n,y)=>({token:token(n),image:png,text:`f${n}`,box:[100,y,150,y+15],width:50,height:15});
 const block={id:'p1-b1',source:'原文',fontSize:10,box:[50,100,550,200],inlines:[inline(1,120),inline(2,150)]};
 const html=pageMarkup({number:1,width:600,height:800,original:png,background:png,extractionVersion:3,blocks:[block]},new Map([[block.id,`Hệ \\begin{cases} ${token(1)}, & n=1 \\\\ \\frac{${token(2)}}{2} & n\\ge 2 \\end{cases} xong`]]));
 const box=html.slice(html.indexOf('<div class="pdf-text-box"'));
 assert.equal(count(box,/<img class="pdf-inline"/gu),2);assert.doesNotMatch(box,/@@PDF_INLINE|[\uE000-\uF8FF]/u);
 assert.match(box,/<span class="math-cell-l"><span class="pdf-nobr"><img class="pdf-inline"[^>]*alt="f1"[^>]*>,<\/span><\/span>/u);
 assert.match(box,/aria-label="f2 phần 2"/u,'a crop in a fraction is named by its alt text');
 for(const tag of box.match(/<[^>]*>/gu))assert.doesNotMatch(tag.slice(1),/</u);
});

test('hostile environments, names and column specs never produce markup, attributes or runaway recursion',()=>{
 for(const text of [R`\begin{cases}<img src=x onerror=alert(1)> & "><b>x</b> \\ \text{<script>} & ' \end{cases}`,R`\(\begin{pmatrix}\frac{"><svg onload=1>}{2}&a\end{pmatrix}\)`,R`\begin{"><x>}a\end{"><x>}`,R`\(\begin{array}{"><b onclick=1>}a\end{array}\)`,R`\(\xrightarrow[<i>]{"x}\overset{<b>}{'}\)`,R`\(\ce{<b>2H2O ->[<i>] "}\)`,R`\(\left<\frac{<a>}{b}\right>\)`]){
  const html=renderMathText(text);
  for(const tag of html.match(/<[^>]*>/gu)||[])assert.doesNotMatch(tag.replace(/"[^"]*"/gu,'""'),/^<\/?(?:img|script|b|i|a|x)[\s>]|\son\w+=|<.*</u,`${text}: ${tag}`);
  for(const attribute of html.match(/(?:aria-label|style|class|d|viewBox)="[^"]*"/gu)||[])assert.doesNotMatch(attribute.slice(attribute.indexOf('"')+1,-1),/[<>"]/u,text);
 }
 const deep='\\begin{cases}'.repeat(60)+'x'+'\\end{cases}'.repeat(60);assert.doesNotThrow(()=>renderMathText(deep));assert.doesNotThrow(()=>renderMathText(`\\(${deep}\\)`));
 const wide='\\begin{matrix}'+'a&'.repeat(5000)+'\\end{matrix}';assert.match(renderMathText(wide),/math-env-unknown/u,'a huge grid is drawn row by row');
 // A nest deeper than the renderer draws (24 levels) is shown as written, and only its own piece is: the formulas after
 // it, delimited or bare, are still drawn.
 const nest=n=>`${'\\frac{'.repeat(n)}1${'}{2}'.repeat(n)}`,after=R` rồi \(x^2\) và \frac{1}{3} và \(\begin{cases}a\\b\end{cases}\)`;
 for(const text of [`\\(${nest(30)}\\)${after}`,`${nest(30)}${after}`,`\\(${'{'.repeat(30)}x${'}'.repeat(30)}\\)${after}`]){
  const html=renderMathText(text);
  assert.ok(seen(html).startsWith(text.slice(0,16)),text);assert.match(seen(html),/ rồi x2 và 13 và ab$/u,text);assert.match(html,/math-env-cases/u,text);
 }
 assert.match(seen(renderMathText(`\\(${nest(20)}\\)`)),/^12+$/u,'20 levels are drawn');
});

test('linear time on hostile input: unclosed openers, nests, long rows of cells, backslashes and scripts render at once',()=>{
 // 48,000 characters of unclosed \frac{ took 26 s before the brace table; H_2O 8,000 times took 3 s. A balanced nest of
 // 8,000 \left( took 8 s and 1.2 GB (a table of each body), 8,000 bare \frac{ 15 s and 2.4 GB (each failed command read
 // again from each level), 40,000 backslashes 6 s (a run rescanned from each pair); 30 \left( round \foo never ended
 // (each failed body read again at every level: exponential); 32,000 characters of \$ took 1.6 s (each escaped dollar
 // tried as a $ opener, scanning to the end of the line).
 for(const [name,make,n=10000] of [['unclosed \\frac{',n=>'\\frac{'.repeat(n)],['unclosed \\begin',n=>'\\begin{cases} x '.repeat(n)],['unclosed \\(',n=>'\\(x '.repeat(n)],['unclosed \\left(',n=>`\\(${'\\left('.repeat(n)}x\\)`],['cells',n=>`\\begin{cases}${'a & b \\\\ '.repeat(n)}\\end{cases}`],['scripts',n=>'S_n x_1^2 H_2O '.repeat(n)],['words',n=>'x_1'.repeat(n)],['\\ce',n=>`\\ce{${'H2O + '.repeat(n)}}`],['escapes',n=>'\\{a_n\\} 5\\% '.repeat(n)],
  ['nested \\left( in math',n=>`\\(${'\\left('.repeat(n)}x${'\\right)'.repeat(n)}\\)`,4000],['nested \\left( in bare text',n=>`${'\\left('.repeat(n)}x${'\\right)'.repeat(n)}`,4000],['nested \\left(\\frac',n=>`\\(${'\\left(\\frac{1}{2}'.repeat(n)}x${'\\right)'.repeat(n)}\\)`,4000],
  ['nested \\left( round \\foo',n=>`\\(${'\\left('.repeat(n)}\\foo${'\\right)'.repeat(n)}\\)`,4000],['nested \\frac{ in bare text',n=>`${'\\frac{'.repeat(n)}x${'}{2}'.repeat(n)}`,4000],['nested environments',n=>`${'\\left\\{\\begin{cases}'.repeat(n)}x${'\\end{cases}\\right.'.repeat(n)}`,4000],
  ['backslashes',n=>'\\'.repeat(4*n)],['row breaks',n=>`\\(${'\\\\'.repeat(2*n)}\\)`],['backslashes before \\begin',n=>`${'\\'.repeat(4*n)}begin{cases}`],['doubled commands',n=>`\\(${'\\\\geq '.repeat(n)}\\)`],['row breaks before brackets',n=>`\\begin{cases}${'a \\\\(b) '.repeat(n)}\\end{cases} \\(x\\)`],
  ['too-deep nests, formula after formula',n=>`\\(${'\\frac{'.repeat(30)}1${'}{2}'.repeat(30)}\\) \\frac{1}{2} `.repeat(n/30)],['too-deep bare nests between formulas',n=>`${'\\frac{'.repeat(30)}1${'}{2}'.repeat(30)} \\(x\\) `.repeat(n/30)],
  ['escaped dollars',n=>'\\$'.repeat(2*n)],['a line of prices',n=>'\\$5 và '.repeat(n)],
  // Ruled tables, formulas and cells printed as written (each listed by unsupportedMath), line breaks inside delimiters,
  // and drawn fences and arrows with their kept characters.
  ['ruled rows',n=>`\\begin{array}{|c|c|}${'\\hline a & b \\\\ '.repeat(n/6)}\\hline\\end{array}`],['a row led by rules',n=>`\\(\\begin{array}{c}${'\\hline\\cline{1-1}'.repeat(n)} a \\end{array}\\)`],['rules round every row',n=>`\\(\\begin{array}{${'|c'.repeat(90)}|}${`\\hline\\hline\\cline{1-90}\\cline{2-89} ${'a & '.repeat(89)}a \\\\ `.repeat(n/250)}\\end{array}\\)`],
  ['cells printed as written',n=>`\\begin{cases}${'\\frac{1}{ & x^ \\\\ '.repeat(n/6)}\\end{cases}`],['formulas printed as written',n=>'\\(x^\\) \\(\\frac{1}{\\) '.repeat(n)],
  ['line breaks inside delimiters',n=>`\\[${'\n '.repeat(n)}x${' \n'.repeat(n)}\\] \\(${' '.repeat(n)}y${' '.repeat(n)}\\)`],['backslashes before a closing line break',n=>`\\[x${'\\'.repeat(2*n)} \n\\] \\(x${'\\'.repeat(2*n+1)} \n\\)`],['fences and arrows',n=>`\\(${'\\left(\\frac{1}{2}\\right)\\xrightarrow{a}\\begin{pmatrix}1\\\\2\\end{pmatrix}'.repeat(n/10)}\\)`]]){
  const text=make(n),started=performance.now();renderMathText(text);renderMathText(text,{bare:false});unsupportedMath(text);normalizeVectorMath(text);translationContentHtml(text);
  assert.ok(performance.now()-started<3000,`${name}: ${Math.round(performance.now()-started)} ms for ${text.length} characters`);
 }
});

test('the new constructs render the same where a lookbehind is refused (Safari/iOS before 16.4), and as fast',()=>{
 const texts=[R`a_n = \begin{cases} S_1, & n = 1, \\ S_n - S_{n-1}, & n \geq 2. \end{cases}`,'S_n a_n x_i C_n^k a_n^2 snake_case T_T ^_^ x_ij u_u -_-',R`50\%, \{a_n\}, a\,b, \$5, 90^\circ 25\,^{\circ}C`,R`\left\{\begin{array}{l} x \\ y \end{array}\right. x\in\mathbb{R}`,R`\(\ce{2H2 + O2 ->[\Delta] 2H2O}\) \[\sum_{i=1}^n i\]`,R`C:\data\a_n /home/u_n https://x.com/a_n`,
  // The scanner's own edges: a match at the very start, after a character outside the BMP, after a run of backslashes.
  R`\alpha+x_1 😀x_1 𝑥_1 a😀_1 10^{-3} 2^\circ (a+b)^2 [a]^2 H_2O AB⃗ \\\% \\\alpha \\x_1 1.5^2 a,2^3`,'x_1',R`\,a`,'H_2O.',
  // Ruled tables, drawn fences and arrows with their kept characters, formulas printed as written, line breaks inside.
  R`\[\begin{array}{|c||c:c|}\hline X & \frac{1}{2} & b_n \\ \cline{2-3} P & \left(\frac{1}{2}\right) & A\xrightarrow{t^\circ}B \\ \hline\hline\end{array}\] \(x^\) S_n`,'\\[\n\\begin{cases} \\vec{a} & 1 \\\\ \\frac{1}{ & 2 \\end{cases}\n\\]'];
 // Long runs a scanner without lookbehinds once read again from each character (seconds at 32,000).
 const hostile={backslashes:'\\'.repeat(40000),digits:'1'.repeat(40000),'escaped dollars':'\\$'.repeat(20000),'letters and digits':'a1'.repeat(20000)};
 const child=spawnSync(process.execPath,['--import','./backend/test-support/no-lookbehind.mjs','--input-type=module','-e',`
  const {renderMathText,unsupportedMath}=await import('./frontend/math-text.js');
  const {texts,hostile}=JSON.parse(await new Response(process.stdin).text());
  const times=Object.entries(hostile).map(([name,text])=>{const started=performance.now();renderMathText(text);unsupportedMath(text);return [name,Math.round(performance.now()-started)];});
  process.stdout.write(JSON.stringify({rendered:texts.map(text=>[renderMathText(text),renderMathText(text,{bare:false}),unsupportedMath(text)]),times}));`],{cwd:fileURLToPath(root),input:JSON.stringify({texts,hostile}),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 const {rendered,times}=JSON.parse(child.stdout);
 assert.deepEqual(rendered,texts.map(text=>[renderMathText(text),renderMathText(text,{bare:false}),unsupportedMath(text)]));
 for(const [name,ms] of times)assert.ok(ms<1500,`${name}: ${ms} ms without lookbehinds`);
});

test('C7: environments and stacks are the classes the PDF fitting measures whole, and none of them wraps',()=>{
 for(const rule of ['.math-env{display:inline-flex','.math-stack{display:inline-block','.math-subsup{display:inline-grid'])assert.ok(mathStyles.includes(rule),rule);
 // The PDF text box allows overflow-wrap:anywhere, which would squeeze a wide matrix into its box by breaking every cell.
 for(const name of ['math-env','math-stack','math-fenced','math-subsup','math-boxed','math-substack','math-frac'])assert.match(mathStyles,new RegExp(`\\.${name}\\{[^}]*white-space:nowrap;overflow-wrap:normal`,'u'),name);
 assert.doesNotMatch(mathStyles,/font-family:[^;}]*math\b/u,'no math font is needed');
});
