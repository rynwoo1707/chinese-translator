import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOcrMath} from './pdf-block-ocr.js';
import {pageMarkup,ocrImageBatches} from '../frontend/pdf-box-layout.js';
import {renderMathText,normalizeVectorMath} from '../frontend/math-text.js';
import {translationContentHtml,buildStudyHtml} from '../frontend/study-layout-view.js';
test('bare vector commands from real OCR become protected inline math without double wrapping',()=>{
 assert.equal(normalizeOcrMath('向量\\\\vec{AB}和\\overrightarrow{OA}'),String.raw`向量\(\vec{AB}\)和\(\overrightarrow{OA}\)`);
 assert.equal(normalizeOcrMath(String.raw`\(\vec{AB}\)`),String.raw`\(\vec{AB}\)`);
});
test('Vietnamese PDF uses vector arrows rather than displaying raw LaTeX or executing markup',()=>{
 const page={width:300,height:500,original:'data:image/png;base64,AA==',background:'data:image/png;base64,AA==',blocks:[{id:'p1-b1',box:[10,10,200,80],fontSize:12,inlines:[]}]};
 const html=pageMarkup(page,new Map([['p1-b1',String.raw`Vectơ \(\vec{AB}\) và \overrightarrow{OA} <script>alert(1)</script>`]]));
 assert.equal((html.match(/class="math-vector"/gu)||[]).length,2);assert.doesNotMatch(html,/\\vec|\\overrightarrow|<script>/u);assert.match(html,/&lt;script&gt;/u);assert.match(html,/>AB<\/span>/u);
});
test('saved textbook combining arrows render over their full vector labels in all reading paths',async()=>{
 const text='Vectơ AB⃗ có độ dài |AB⃗|. Các vectơ OA⃗, OB⃗, OC⃗; a⃗. AB và OA là điểm; [□] chưa đọc được.';
 const html=renderMathText(text),rich=translationContentHtml(text),exported=await buildStudyHtml({title:'Vectơ',parts:[],translations:[],images:new Map(),combined:text});
 for(const result of [html,rich,exported]){assert.equal((result.match(/class="math-vector"/gu)||[]).length,6);assert.doesNotMatch(result,/⃗/u);assert.match(result,/aria-label="Vectơ AB"/u);assert.match(result,/AB và OA là điểm; \[□\]/u);}
 const page={width:300,height:500,original:'data:image/png;base64,AA==',background:'data:image/png;base64,AA==',blocks:[{id:'p1-b1',box:[10,10,290,180],fontSize:12,inlines:[]}]};
 assert.equal((pageMarkup(page,new Map([['p1-b1',text]])).match(/class="math-vector"/gu)||[]).length,6);
});
test('vector commands and mathematical scripts are preserved inside a complete formula',()=>{
 const source=String.raw`\(\vec{a}_{1} + \overrightarrow{A_1B}^{2} = \vec b \cdot \vec{c}\)`;
 assert.equal(normalizeVectorMath(source),source,'do not nest inline delimiters around vectors within existing math');
 const html=renderMathText(source);assert.equal((html.match(/class="math-vector"/gu)||[]).length,4);assert.match(html,/<sub>1<\/sub>/u);assert.match(html,/<sup>2<\/sup>/u);assert.match(html,/·/u);assert.doesNotMatch(html,/\\vec|\\overrightarrow|_\{|\^\{/u);
 assert.equal(normalizeVectorMath('Vectơ AB⃗ và '+String.raw`\vec{a}_1`),String.raw`Vectơ \(\vec{AB}\) và \(\vec{a}_1\)`);
 const bare=renderMathText(String.raw`\overrightarrow{OA}_1`);assert.match(bare,/<sub>1<\/sub>/u);assert.match(bare,/class="math-inline"/u);
});
test('unsupported complex math, uncertain symbols and plain point names are never inferred as vectors',()=>{
 assert.equal(renderMathText('AB OA OB OC □ [□]'), 'AB OA OB OC □ [□]');
 // Fractions are supported now (old OCR wrote them); a command the renderer does not know keeps the whole formula verbatim.
 for(const unknown of [String.raw`\(\mathcal{AB}\)`,String.raw`\(\vec{a}\bmod 3\)`,String.raw`\(\begin{cases}x\end{cases}\)`])assert.equal(renderMathText(unknown),unknown);
 assert.equal(renderMathText(String.raw`\vec{AB`),String.raw`\vec{AB`);
 const hostile=String.raw`\(\vec{<img src=x onerror=alert(1)>}\)`;assert.doesNotMatch(renderMathText(hostile),/<img|onerror="/u);assert.match(renderMathText(hostile),/&lt;img/u);
 const deep='\\vec{'+('{'.repeat(100))+'a'+('}'.repeat(100))+'}';assert.doesNotThrow(()=>renderMathText(deep));assert.equal(renderMathText(deep),deep);
});
test('image OCR batches include protected formula crops in byte and six-block limits',()=>{
 const blocks=Array.from({length:8},(_,i)=>({id:String(i),image:'A'.repeat(10),inlines:[{image:'B'.repeat(10)}]}));
 assert.deepEqual(ocrImageBatches(blocks,60).map(b=>b.length),[3,3,2]);assert.deepEqual(ocrImageBatches(blocks,1000).map(b=>b.length),[6,2]);assert.throws(()=>ocrImageBatches(blocks,19),/quá lớn/u);
 const labeled=blocks.map(block=>({...block,inlines:[{...block.inlines[0],label:'@1'}]}));
 assert.deepEqual(ocrImageBatches(labeled,60).map(b=>b.length),[6,2]);assert.doesNotThrow(()=>ocrImageBatches(labeled,19));
});
const plain=html=>html.replace(/<svg[\s\S]*?<\/svg>/gu,'').replace(/<[^>]+>/gu,'');
test('fractions, roots, over-marks and TeX symbols render inside delimiters and as bare well-formed commands',()=>{
 // Saved OCR of an exercise row: bare \frac between two formula tokens, and a delimited vector minus a bare fraction.
 const row=renderMathText(String.raw`(2) @@PDF_INLINE_2@@ \frac{1}{2} (@@PDF_INLINE_3@@`);
 assert.match(row,/class="math-frac"[^>]*aria-label="1 phần 2"/u);assert.doesNotMatch(row,/\\frac/u);assert.match(row,/@@PDF_INLINE_2@@ .*\(@@PDF_INLINE_3@@$/u);
 const mixed=renderMathText(String.raw`(3) \(\overrightarrow{AF}\)-\frac{1}{2} x`);assert.match(mixed,/class="math-vector"/u);assert.match(mixed,/<\/span>−<span class="math-inline"><span class="math-frac"/u,'a hyphen between two formulas is a minus sign');
 for(const [source,pattern] of [
  [String.raw`\(\dfrac{a+b}{2}\) \(\tfrac12\)`,/math-num[^>]*>a\+b<[\s\S]*math-num[^>]*>1</u],
  [String.raw`\(\sqrt{2}\) và \(\sqrt[3]{8}=2\)`,/aria-label="căn 2"[\s\S]*aria-label="căn bậc 3 của 8"/u],
  [String.raw`\(\overline{AB}_1\)`,/<span class="math-overline">AB<\/span><sub>1<\/sub>/u],
  [String.raw`\(\widehat{AOB}\)`,/class="math-over"[^>]*aria-label="AOB mũ"/u],
  [String.raw`\(\langle a, b\rangle = \angle AOB\)`,/⟨a, b⟩ = ∠AOB/u],
  [String.raw`\(a \cdot b \times c \pm d \leq e \geq f \neq g \approx h\)`,/a · b × c ± d ≤ e ≥ f ≠ g ≈ h/u],
  [String.raw`\(\Delta x = x_{2} - x_1\)`,/Δx = x<sub>2<\/sub> − x<sub>1<\/sub>/u],
  [String.raw`\(\mathrm{d}x\) \(\text{khi } x>0\)`,/math-mathrm">d<\/span>x[\s\S]*math-text">khi <\/span> x&gt;0/u],
  [String.raw`\(\sin\alpha+\cos^2 x\)`,/math-mathrm">sin<\/span>α\+<span class="math-mathrm">cos<\/span><sup>2<\/sup> x/u],
  [String.raw`$x^{2}+y^2$ và $$a_n$$`,/math-inline">x<sup>2<\/sup>\+y<sup>2<\/sup>[\s\S]*math-display">a<sub>n<\/sub>/u],
  [String.raw`\(AA'\)`,/AA′/u]
 ]){const html=renderMathText(source);assert.match(html,pattern,source);assert.doesNotMatch(plain(html),/\\[a-z]/u,source);}
 // Bare commands outside delimiters render only when well formed; a symbol keeps the space after it.
 assert.equal(plain(renderMathText(String.raw`góc \alpha là \Delta ABC, \sqrt{3}`)),'góc α là Δ ABC, √3');
 assert.equal(renderMathText(String.raw`\frac{1}{2`),String.raw`\frac{1}{2`);assert.equal(renderMathText(String.raw`C:\Users\bar\x \sqrt2`),String.raw`C:\Users\bar\x \sqrt2`);
});
test('plain-text scripts and chemistry formulas render without touching identifiers, emoticons or prices',()=>{
 assert.equal(plain(renderMathText('x^2 + a^{10}, x_1, 10^-3, (a+b)^2')),'x2 + a10, x1, 10−3, (a+b)2');
 assert.match(renderMathText('x^2'),/x<sup>2<\/sup>/u);assert.match(renderMathText('(a+b)^2'),/\)<sup>2<\/sup>/u);
 for(const [formula,html] of [['H_2O','H<sub>2</sub>O'],['CO_2','CO<sub>2</sub>'],['H_2SO_4','H<sub>2</sub>SO<sub>4</sub>'],['Ca(OH)_2','Ca(OH)<sub>2</sub>'],['SO_4^{2-}','SO<sub>4</sub><sup>2−</sup>']])assert.match(renderMathText(`Phản ứng tạo ${formula}.`),new RegExp(`math-chem">${html.replace(/[()]/gu,'\\$&')}</span>\\.`,'u'),formula);
 // Not element formulas or one-letter bases: left exactly as written.
 for(const text of ['MAX_2 snake_case_name var_1 T_T ^_^ Hello_2','giá $5 và $10, $5-$10','ABCD-A\'B\'C\'D\' năm 1949-1953','@@PDF_INLINE_1@@ và @@PDF_INLINE_12@@'])assert.equal(renderMathText(text),text.replace(/'/gu,'&#39;'));
 assert.match(renderMathText('A_1 và B_2'),/A<sub>1<\/sub>[\s\S]*B<sub>2<\/sub>/u);
 // A hyphen next to a word or between $…$ pieces stays a hyphen.
 assert.match(renderMathText(String.raw`\(x\)-axis`),/<\/span>-axis$/u);assert.match(renderMathText('$a$-$b$'),/<\/span>-<span/u);
});
test('hostile or malformed TeX never produces markup, attributes or unbounded recursion',()=>{
 for(const source of [String.raw`\(\frac{<img src=x onerror=alert(1)>}{2}\)`,String.raw`\(\text{<script>alert(1)</script>}\)`,String.raw`\text{"><b>x</b>}`,String.raw`\(\sqrt["><svg onload=alert(1)>]{2}\)`,String.raw`\frac{" onmouseover="x}{1}`,String.raw`\(\widehat{a"b}\)`,'$<img src=x>$']){
  const html=renderMathText(source);assert.doesNotMatch(html,/<(?:img|script|b|svg onload)[\s>]|on\w+="/u,source);
  for(const attribute of html.match(/aria-label="[^"]*"/gu)||[])assert.doesNotMatch(attribute.slice(12,-1),/[<>"]/u,source);
 }
 const deep=String.raw`\(`+'\\frac{'.repeat(60)+'1'+'}{2}'.repeat(60)+String.raw`\)`;assert.doesNotThrow(()=>renderMathText(deep));assert.equal(renderMathText(deep),deep.replace(/[<>]/gu,''));
 const bareDeep='\\sqrt{'.repeat(80)+'x'+'}'.repeat(80);assert.doesNotThrow(()=>renderMathText(bareDeep));
});
