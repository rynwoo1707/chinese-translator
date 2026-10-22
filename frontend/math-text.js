// Vector arrows and over-marks are drawn, rather than delegated to a font's combining glyphs.
// Only explicit notation is rendered: delimited TeX, whitelisted bare commands with braced arguments (old saved
// OCR text holds bare \frac{1}{2}), combining arrows (AB + U+20D7), braced or numeric scripts after a one-letter base
// (x^2, a_{n}) and element formulas (H_2O). Plain AB/OA, unreadable □ and snake_case words stay text;
// unsupported or malformed TeX stays verbatim. Every character of the source reaches the HTML escaped.
const escape=value=>String(value).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Safari and iOS before 16.4 cannot parse a lookbehind ((?<!…)): one in a regular expression literal stops this module,
// and every page that imports it, from loading, and one built at load time throws there. No literal here uses one.
// $…$ follows Pandoc: no space just inside the dollars and no digit right after the closing one, so prices in an
// economics or history text ("$5 và $10") stay text. The last character before the closing $ is matched as a token that
// is not a space (\\\S or [^$\\\s]), which is exactly what a lookbehind (?<!\s) before it would require.
const expressions=/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$(?=[^\s$])(?:\\.|[^$\n\\])*?(?:\\\S|[^$\\\s])\$(?!\d)/gu;
const vectorStarts=/\\+(?:vec|overrightarrow)\b|[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]+\u20d7/gu;
const ELEMENTS=new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
const SUB=String.raw`_(?:\d+|\{\d+\})`,ELEMENT=String.raw`[A-Z][a-z]?`,UNIT=String.raw`(?:${ELEMENT}(?:${SUB})?|\((?:${ELEMENT}(?:${SUB})?)+\)(?:${SUB})?)`;
// Outside delimiters: a command, a combining arrow, an element formula with a numeric subscript (checked
// against the periodic table, so MAX_2 or snake_case stay text), or a one-letter/number base with a script.
// Each alternative: its capture group, the characters that may not come right before it, its pattern.
const SCRIPTED=String.raw`(?=_(?:\{|\d)|\^(?:\{|[+\-−]?\d))`,RAISED=String.raw`(?=\^(?:\{|[+\-−]?\d))`,AFTER_WORD=String.raw`[\p{L}\p{N}_@\\'′]`;
const BARE=[[1,'',String.raw`\\+[A-Za-z]+`],[2,'',String.raw`[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]+\u20d7`],[3,String.raw`[\p{L}\p{N}_@\\]`,String.raw`${UNIT}+(?:\^(?:\{\d*[+\-−]\}|\d*[+\-−]))?(?![\p{L}\p{N}_])`],[4,AFTER_WORD,String.raw`[\p{Script=Latin}\p{Script=Greek}]${SCRIPTED}`],[4,String.raw`[\p{L}\p{N}_@.,\\]`,String.raw`\d+${RAISED}`],[4,'',String.raw`[)\]]${RAISED}`]];
// One expression with a lookbehind per alternative, built on first use. Where the browser refuses it (Safari before
// 16.4), the same matches are found by trying the alternatives in order at each place, after checking the character
// before it by hand.
let bareStarts=null,bareScan=null;
// The character (code point) that ends at index, as a lookbehind sees it.
function before(text,index){const low=text.charCodeAt(index-1),high=text.charCodeAt(index-2);return low>=0xdc00&&low<=0xdfff&&high>=0xd800&&high<=0xdbff?text.slice(index-2,index):text[index-1];}
function* scanBare(text){
 bareScan??={any:new RegExp(BARE.map(([,,pattern])=>`(?:${pattern})`).join('|'),'gu'),parts:BARE.map(([group,not,pattern])=>({group,not:not?new RegExp(`^${not}$`,'u'):null,pattern:new RegExp(pattern,'uy')}))};
 // A place where no alternative matches even without its lookbehind cannot match with it: the search jumps past it.
 for(let at=0;at<text.length;){
  bareScan.any.lastIndex=at;const near=bareScan.any.exec(text);if(!near)return;
  const index=near.index;let found=null;
  for(const {group,not,pattern} of bareScan.parts){
   if(not&&index>0&&not.test(before(text,index)))continue;
   pattern.lastIndex=index;const match=pattern.exec(text);if(match){found=[match[0]];found[group]=match[0];found.index=index;break;}
  }
  if(found){yield found;at=index+found[0].length;}else at=index+(text.codePointAt(index)>0xffff?2:1);
 }
}
function bareMatches(text){
 if(bareStarts===null){try{bareStarts=new RegExp([1,2,3,4].map(group=>`(${BARE.filter(([part])=>part===group).map(([,not,pattern])=>not?`(?<!${not})${pattern}`:pattern).join('|')})`).join('|'),'gu');}catch{bareStarts=false;}}
 return bareStarts?text.matchAll(bareStarts):scanBare(text);
}
const symbols=Object.freeze({
 alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',varepsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',vartheta:'ϑ',iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',omicron:'ο',pi:'π',varpi:'ϖ',rho:'ρ',varrho:'ϱ',sigma:'σ',varsigma:'ς',tau:'τ',upsilon:'υ',phi:'φ',varphi:'φ',chi:'χ',psi:'ψ',omega:'ω',
 Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Upsilon:'Υ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
 cdot:'·',times:'×',div:'÷',pm:'±',mp:'∓',ast:'∗',star:'⋆',circ:'∘',bullet:'•',oplus:'⊕',otimes:'⊗',odot:'⊙',setminus:'∖',
 le:'≤',leq:'≤',leqslant:'⩽',ge:'≥',geq:'≥',geqslant:'⩾',ne:'≠',neq:'≠',approx:'≈',sim:'∼',simeq:'≃',cong:'≅',equiv:'≡',propto:'∝',ll:'≪',gg:'≫',parallel:'∥',perp:'⊥',mid:'∣',
 in:'∈',notin:'∉',ni:'∋',subset:'⊂',subseteq:'⊆',subsetneq:'⊊',supset:'⊃',supseteq:'⊇',cap:'∩',cup:'∪',emptyset:'∅',varnothing:'∅',forall:'∀',exists:'∃',neg:'¬',lnot:'¬',land:'∧',wedge:'∧',lor:'∨',vee:'∨',
 to:'→',rightarrow:'→',leftarrow:'←',gets:'←',leftrightarrow:'↔',Rightarrow:'⇒',Leftarrow:'⇐',Leftrightarrow:'⇔',iff:'⟺',implies:'⟹',longrightarrow:'⟶',longleftarrow:'⟵',mapsto:'↦',uparrow:'↑',downarrow:'↓',rightleftharpoons:'⇌',therefore:'∴',because:'∵',
 infty:'∞',partial:'∂',nabla:'∇',angle:'∠',measuredangle:'∡',triangle:'△',square:'□',degree:'°',prime:'′',ldots:'…',dots:'…',cdots:'⋯',vdots:'⋮',ddots:'⋱',hbar:'ℏ',ell:'ℓ',aleph:'ℵ',sum:'∑',prod:'∏',int:'∫',iint:'∬',oint:'∮',
 langle:'⟨',rangle:'⟩',lfloor:'⌊',rfloor:'⌋',lceil:'⌈',rceil:'⌉',lvert:'|',rvert:'|',lVert:'‖',rVert:'‖',vert:'|',Vert:'‖',backslash:'\\',quad:'\u2003',qquad:'\u2003\u2003'
});
// Non-letter commands: TeX spacing and escaped special characters.
const escapes=Object.freeze({',':'\u2009',':':'\u205f','>':'\u205f',';':'\u2004','!':'',' ':' ','{':'{','}':'}','%':'%','$':'$','&':'&','#':'#','_':'_','|':'‖'});
const functions=new Set('sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp lim max min sup inf det dim ker gcd deg arg'.split(' '));
const fonts=Object.freeze({mathrm:'mathrm',operatorname:'mathrm',mathbf:'mathbf',boldsymbol:'mathbf',mathit:'mathit'});
const texts=Object.freeze({text:'',textrm:'',textnormal:'',mbox:'',textit:' math-mathit',textbf:' math-mathbf'});
// Inside math TeX ignores the space after a command. Letters and prefix symbols bind to what follows ("∠AOB",
// "ΔABC"); operators, relations and closing brackets keep the space written after them ("a · b", "⟨a, b⟩ = c").
const binding=new Set('angle measuredangle triangle langle lfloor lceil forall exists neg lnot partial nabla sum prod int iint oint hbar ell aleph'.split(' '));
const ignored=new Set('displaystyle textstyle limits nolimits big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr'.split(' '));
const accents=Object.freeze({hat:'\u0302',widehat:'\u0302',tilde:'\u0303',widetilde:'\u0303',dot:'\u0307',ddot:'\u0308'});
const marks=Object.freeze({'\u0302':'M4 15L50 3L96 15','\u0303':'M3 12C20 2 34 2 50 8S80 14 97 4','\u0307':'M50 8h.01','\u0308':'M38 8h.01M62 8h.01'});
const names=Object.freeze({'\u0302':'mũ','\u0303':'ngã','\u0307':'chấm','\u0308':'hai chấm'});
function group(text,index){
 if(text[index]!=='{')return null;
 let depth=1;for(let i=index+1;i<text.length;i++){if(text[i]==='{')depth++;else if(text[i]==='}'&&!--depth)return {body:text.slice(index+1,i),end:i+1};}return null;
}
function vector(html,label){
 return `<span class="math-vector" role="img" aria-label="Vectơ ${escape(label)}"><svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none"><path d="M2 8H96M83 2L96 8L83 14" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg><span aria-hidden="true">${html}</span></span>`;
}
// One letter takes the font's combining mark; a longer body (\widehat{AOB}) gets a stretched drawn mark.
function accent(body,mark){
 if([...body.label].length===1&&body.html===escape(body.label))return {html:`${body.html}${mark}`,label:`${body.label} ${names[mark]}`};
 const dots=mark==='\u0307'||mark==='\u0308';
 return {html:`<span class="math-over" role="img" aria-label="${escape(body.label)} ${names[mark]}"><svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none"><path d="${marks[mark]}" fill="none" stroke="currentColor" stroke-width="${dots?3:1}" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg><span aria-hidden="true">${body.html}</span></span>`,label:`${body.label} ${names[mark]}`};
}
// An argument is a braced group; inside delimiters TeX also allows one token (\frac12, \vec b).
function argument(text,index,depth,strict){
 let i=index;while(text[i]===' ')i++;
 const braced=group(text,i);if(braced){const body=mathBody(braced.body,depth+1);return body&&{...body,end:braced.end};}
 return strict?null:atom(text,i,depth+1);
}
function command(text,index,depth,strict=false){
 if(depth>24)return null;
 const special=text.slice(index).match(/^\\([,:;!> {}%$&#_|])/u);if(special)return {html:escape(escapes[special[1]]),label:escapes[special[1]],end:index+2};
 const found=text.slice(index).match(/^\\+([A-Za-z]+)\s*/u);if(!found)return null;
 // Arguments may follow after spaces; a symbol keeps the space after it ("\alpha là" is not "αlà").
 const name=found[1],next=index+found[0].length,named=index+found[0].trimEnd().length;
 if(name==='vec'||name==='overrightarrow'){
  const inner=group(text,next),body=inner?mathBody(inner.body,depth+1):atom(text,next,depth+1);
  if(!body||!body.label.trim())return null;
  return {html:vector(body.html,body.label),label:`vectơ ${body.label}`,end:inner?inner.end:body.end};
 }
 if(name==='frac'||name==='dfrac'||name==='tfrac'||name==='cfrac'||name==='binom'){
  const top=argument(text,next,depth,strict),bottom=top&&argument(text,top.end,depth,strict);
  if(!bottom||!top.label.trim()||!bottom.label.trim())return null;
  const label=name==='binom'?`tổ hợp ${top.label} trên ${bottom.label}`:`${top.label} phần ${bottom.label}`;
  const html=`<span class="math-frac${name==='binom'?' math-binom':''}" role="img" aria-label="${escape(label)}"><span class="math-num" aria-hidden="true">${top.html}</span><span class="math-den" aria-hidden="true">${bottom.html}</span></span>`;
  return {html:name==='binom'?`(${html})`:html,label,end:bottom.end};
 }
 if(name==='sqrt'){
  let at=next,index_=null;
  if(text[at]==='['){const close=text.indexOf(']',at);if(close<0)return null;index_=mathBody(text.slice(at+1,close),depth+1);if(!index_||!index_.label.trim())return null;at=close+1;}
  const body=argument(text,at,depth,strict);if(!body||!body.label.trim())return null;
  return {html:`<span class="math-sqrt" role="img" aria-label="${escape(index_?`căn bậc ${index_.label} của ${body.label}`:`căn ${body.label}`)}">${index_?`<span class="math-index" aria-hidden="true">${index_.html}</span>`:''}<span aria-hidden="true">√</span><span class="math-radicand" aria-hidden="true">${body.html}</span></span>`,label:index_?`căn bậc ${index_.label} của ${body.label}`:`căn ${body.label}`,end:body.end};
 }
 if(name==='overline'||name==='bar'||name==='underline'){
  const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;
  return {html:`<span class="math-${name==='underline'?'underline':'overline'}">${body.html}</span>`,label:body.label,end:body.end};
 }
 if(Object.hasOwn(accents,name)){const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;return {...accent(body,accents[name]),end:body.end};}
 if(Object.hasOwn(fonts,name)){
  const inner=group(text,next),body=inner&&mathBody(inner.body,depth+1);if(!body)return null;
  return {html:`<span class="math-${fonts[name]}">${body.html}</span>`,label:body.label,end:inner.end};
 }
 // \text bodies are words, not math: spaces are kept and nothing inside is parsed.
 if(Object.hasOwn(texts,name)){const inner=group(text,next);if(!inner||/[{}\\]/u.test(inner.body))return null;return {html:`<span class="math-text${texts[name]}">${escape(inner.body)}</span>`,label:inner.body,end:inner.end};}
 if(name==='left'||name==='right'){
  const rest=text.slice(next);if(rest[0]==='.')return {html:'',label:'',end:next+1};
  return /^[()[\]|/]|^\\(?:[lr]?[vV]ert|[lr]angle|[lr]floor|[lr]ceil|[{}|])(?![A-Za-z])/u.test(rest)?{html:'',label:'',end:next}:null;
 }
 if(ignored.has(name))return {html:'',label:'',end:next};
 if(functions.has(name))return {html:`<span class="math-mathrm">${name}</span>`,label:` ${name} `,end:named};
 if(Object.hasOwn(symbols,name))return {html:escape(symbols[name]),label:symbols[name],end:strict||!(binding.has(name)||/\p{Script=Greek}/u.test(symbols[name]))?named:next};
 return null;
}
function atom(text,index,depth=0){
 if(depth>24)return null;
 const bracket=group(text,index);if(bracket){const body=mathBody(bracket.body,depth+1);return body&&{...body,end:bracket.end};}
 if(text[index]==='\\')return command(text,index,depth);
 const character=String.fromCodePoint(text.codePointAt(index)||0);if(!character||/[{}_^$]/u.test(character))return null;
 // Inside math a hyphen is a minus sign, an apostrophe a prime and ~ a non-breaking space, as TeX prints them.
 const shown={'-':'−',"'":'′','~':'\u00a0'}[character]??character;
 return {html:escape(shown),label:shown,end:index+character.length};
}
function scripts(text,index,depth=0){
 let html='',label='',end=index;
 while(text[end]==='_'||text[end]==='^'){
  const type=text[end++]==='_'?'sub':'sup',value=atom(text,end,depth+1);if(!value)return null;
  html+=`<${type}>${value.html}</${type}>`;label+=` ${type==='sub'?'chỉ số dưới':'chỉ số trên'} ${value.label}`;end=value.end;
 }
 return {html,label,end};
}
// Plain-text scripts take a whole number (x^10, 10^-3) or a braced group; anything else is left as written.
function plainScripts(text,index,depth=0){
 let html='',label='',end=index;
 while(text[end]==='_'||text[end]==='^'){
  const type=text[end]==='_'?'sub':'sup',braced=group(text,end+1);let value;
  if(braced){const body=mathBody(braced.body,depth+1);if(!body)break;value={...body,end:braced.end};}
  else{const number=text.slice(end+1).match(type==='sup'?/^[+\-−]?\d+/u:/^\d+/u);if(!number)break;const shown=number[0].replace('-','−');value={html:escape(shown),label:shown,end:end+1+number[0].length};}
  html+=`<${type}>${value.html}</${type}>`;label+=` ${type==='sub'?'chỉ số dưới':'chỉ số trên'} ${value.label}`;end=value.end;
 }
 return html?{html,label,end}:null;
}
function mathBody(text,depth=0){
 if(depth>24)return null;
 let html='',label='',index=0;
 while(index<text.length){
  // A combining arrow carries explicit semantics even inside a math delimiter.
  const unicode=text.slice(index).match(/^[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]+\u20d7/u);
  const value=unicode?{html:vector(escape(unicode[0].slice(0,-1)),unicode[0].slice(0,-1)),label:`vectơ ${unicode[0].slice(0,-1)}`,end:index+unicode[0].length}:atom(text,index,depth);
  if(!value)return null;
  const suffix=scripts(text,value.end,depth);if(!suffix)return null;
  html+=value.html+suffix.html;label+=value.label+suffix.label;index=suffix.end;
 }
 return {html,label};
}
function chemistry(formula){
 let html='';
 for(const part of formula.matchAll(/([A-Z][a-z]?)|_\{?(\d+)\}?|\^\{?(\d*[+\-−])\}?|([()])/gu)){
  if(part[1]){if(!ELEMENTS.has(part[1]))return null;html+=part[1];}else if(part[2])html+=`<sub>${part[2]}</sub>`;else if(part[3])html+=`<sup>${escape(part[3].replace('-','−'))}</sup>`;else html+=part[4];
 }
 return `<span class="math-inline math-chem">${html}</span>`;
}
function vectorTokens(text){
 const tokens=[];let end=0;
 for(const match of text.matchAll(vectorStarts)){
  if(match.index<end)continue;
  const unicode=match[0].endsWith('\u20d7'),label=unicode?match[0].slice(0,-1):null;
  const value=unicode?{html:vector(escape(label),label),label,end:match.index+match[0].length}:atom(text,match.index);
  if(!value)continue;
  const suffix=scripts(text,value.end);if(!suffix)continue;
  end=suffix.end;tokens.push({start:match.index,end,html:suffix.html?`<span class="math-inline">${value.html}${suffix.html}</span>`:value.html,notation:unicode?`\\vec{${label}}${text.slice(value.end,end)}`:text.slice(match.index,end)});
 }
 return tokens;
}
// "A_1" is not an element formula but still a one-letter base with a subscript (not right after a letter, digit, _, @,
// \, ' or ′).
const scriptBase=new RegExp(`[\\p{Script=Latin}\\p{Script=Greek}]${SCRIPTED}`,'uy'),afterWord=new RegExp(`^${AFTER_WORD}$`,'u');
function scriptBaseAt(text,index){if(index>0&&afterWord.test(before(text,index)))return null;scriptBase.lastIndex=index;return scriptBase.exec(text);}
function scripted(text,index,base){const suffix=plainScripts(text,index+base.length);return suffix&&{end:suffix.end,html:`<span class="math-inline">${escape(base)}${suffix.html}</span>`};}
// Command names this renderer knows. A backslash chain holding any other name ("Files\App\log", "D:\data\in") is a
// Windows path, never TeX: none of its \log, \in, \to, \max is rendered.
const KNOWN=new Set([...Object.keys(symbols),...functions,...Object.keys(fonts),...Object.keys(texts),...Object.keys(accents),...ignored,'vec','overrightarrow','frac','dfrac','tfrac','cfrac','binom','sqrt','overline','bar','underline','left','right']);
// The whitespace-delimited word around index: notation inside a URL, an e-mail address or a path is kept as written
// (https://example.com/a_1/b^2, C:\Users\Lan\max\deg).
function wordAt(text,index){const start=text.slice(0,index).search(/\S*$/u),rest=text.slice(index).search(/\s/u);return text.slice(start,rest<0?text.length:index+rest);}
const linked=word=>/:\/\/|^www\.|^[^@\s]+@[^@\s]+\.[A-Za-z]/iu.test(word);
const pathLike=word=>/^[A-Za-z]:\\|^\\\\[A-Za-z]/u.test(word)||[...word.matchAll(/\\+([A-Za-z]+)/gu)].some(m=>!KNOWN.has(m[1]));
// bare: OCR and PDF text, where a model may drop the \( \) round a command and scripts are written x^2, a_1. The
// general reader's text is translated with its math already delimited: there only explicit vectors and element
// formulas are rendered outside delimiters, so code (2^3 as XOR), identifiers and LaTeX tutorials stay as written.
function plainTokens(text,bare=true){
 const tokens=[];let end=0;
 for(const match of bareMatches(text)){
  if(match.index<end)continue;let token=null;const word=wordAt(text,match.index);
  if(linked(word))continue;
  if(match[1]){if(pathLike(word)||!bare&&!/^\\+(?:vec|overrightarrow)$/u.test(match[1]))continue;const value=command(text,match.index,0,true);const suffix=value&&scripts(text,value.end);if(suffix&&value.html)token={end:suffix.end,html:suffix.html||/^\\+(?:frac|dfrac|tfrac|cfrac|binom|sqrt)/u.test(match[0])?`<span class="math-inline">${value.html}${suffix.html}</span>`:value.html};}
  else if(match[2]){const label=match[2].slice(0,-1),suffix=scripts(text,match.index+match[2].length);if(suffix)token={end:suffix.end,html:suffix.html?`<span class="math-inline">${vector(escape(label),label)}${suffix.html}</span>`:vector(escape(label),label)};}
  else if(match[3]){const html=match[3].includes('_')&&!(!bare&&/[=/\\&]/u.test(word))&&chemistry(match[3]);if(html)token={end:match.index+match[3].length,html};else if(bare){const base=scriptBaseAt(text,match.index);if(base)token=scripted(text,match.index,base[0]);}}
  else if(bare)token=scripted(text,match.index,match[4]);
  if(token){tokens.push({start:match.index,...token});end=token.end;}
 }
 return tokens;
}
function plainPieces(text,bare){
 const pieces=[];let start=0;
 for(const token of plainTokens(text,bare)){if(token.start>start)pieces.push({raw:text.slice(start,token.start)});pieces.push({html:token.html,joins:true});start=token.end;}
 if(start<text.length)pieces.push({raw:text.slice(start)});return pieces;
}
export function renderMathText(value,{bare=true}={}){
 const text=String(value??''),pieces=[];let start=0;
 for(const match of text.matchAll(expressions)){
  pieces.push(...plainPieces(text.slice(start,match.index),bare));
  const source=match[0],double=source.startsWith('$$'),latex=source.startsWith('\\'),size=latex||double?2:1,body=mathBody(source.slice(size,-size));
  // Unsupported TeX stays verbatim; it is never guessed or silently discarded.
  pieces.push(body?{html:`<span class="math-${double||source.startsWith('\\[')?'display':'inline'}">${body.html}</span>`,joins:latex}:{raw:source});start=match.index+source.length;
 }
 pieces.push(...plainPieces(text.slice(start),bare));
 // A lone hyphen between two TeX formulas ("\(\vec{AA'}\)-\(\vec{CB}\)" from OCR) is a minus sign; next to a word
 // ("\(x\)-axis") or between $…$ pieces it stays as written.
 return pieces.map((piece,i)=>piece.raw==null?piece.html:escape(/^[ \t]*-[ \t]*$/u.test(piece.raw)&&pieces[i-1]?.joins&&pieces[i+1]?.joins?piece.raw.replace('-','−'):piece.raw)).join('');
}
export function normalizeVectorMath(value){
 const text=String(value??'').replace(/\\{2,}(?=(?:vec|overrightarrow)\b)/gu,'\\');
 // A vector over a formula token (\vec{@@PDF_INLINE_1@@}) is not wrapped, as mapBareLatex leaves such commands: as
 // delimited math it would be shielded from translation with the token inside it.
 const normalizePlain=plain=>{let result='',start=0;for(const token of vectorTokens(plain)){if(token.notation.includes('@@'))continue;result+=plain.slice(start,token.start)+`\\(${token.notation}\\)`;start=token.end;}return result+plain.slice(start);};
 let result='',start=0;for(const match of text.matchAll(expressions)){result+=normalizePlain(text.slice(start,match.index))+match[0];start=match.index+match[0].length;}return result+normalizePlain(text.slice(start));
}
// The vector's top margin keeps its arrow off the descenders of the line above (line-height 1.08 is tighter than
// the font's content area). A fraction is centred on the text's middle, which puts its bar near the minus height.
// text-indent is inherited: a paragraph's first-line indent must not shift the inside of an inline formula.
export const mathStyles=`.math-vector,.math-over{display:inline-block;position:relative;padding-top:.27em;line-height:1.05;white-space:nowrap;margin:.1em .025em 0;text-indent:0}.math-vector{font-style:italic}.math-vector svg,.math-over svg{position:absolute;top:0;left:0;width:100%;height:.25em;overflow:visible}.math-over svg{top:.03em;height:.2em}.math-vector>span,.math-over>span{display:inline-block;line-height:1.05;vertical-align:baseline}.math-inline,.math-display{font-family:inherit}.math-inline sub,.math-inline sup,.math-display sub,.math-display sup,.math-vector sub,.math-vector sup{font-size:.72em;line-height:0}.math-display{display:block;text-align:center;white-space:pre-wrap;text-indent:0}.math-frac{display:inline-block;vertical-align:middle;text-align:center;font-size:.82em;line-height:1.1;margin:0 .08em;white-space:nowrap;text-indent:0}.math-frac>span{display:block;padding:0 .12em}.math-frac>.math-den{border-top:.07em solid currentColor}.math-binom>.math-den{border-top:0}.math-sqrt{white-space:nowrap}.math-radicand{border-top:.06em solid currentColor;padding:0 .05em;margin-left:-.03em}.math-index{font-size:.6em;vertical-align:.75em;margin-right:-.45em}.math-overline{text-decoration:overline;text-decoration-thickness:.06em;text-decoration-skip-ink:none}.math-underline{text-decoration:underline;text-decoration-thickness:.06em}.math-mathrm,.math-text{font-style:normal}.math-mathbf{font-weight:700;font-style:normal}.math-mathit{font-style:italic}`;
