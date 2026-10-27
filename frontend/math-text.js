// Vector arrows and over-marks are drawn, rather than delegated to a font's combining glyphs, and so are the 2-D
// pieces of TeX: an environment (cases, pmatrix, aligned…) is an inline grid with SVG fences stretched to its rows,
// and limits, \overset and labelled arrows are stacks, so the text stays plain selectable letters and no math font is
// needed. Only explicit notation is rendered: delimited TeX, whitelisted bare commands with braced arguments (old
// saved OCR text holds bare \frac{1}{2}) and bare environments, combining arrows (AB + U+20D7), braced, numeric or
// one-letter scripts after a one-letter base (x^2, a_{n}, S_n) and element formulas (H_2O). Plain AB/OA, unreadable □
// and snake_case words stay text. The scaffolding of an environment (\begin, &, \\) never reaches the page; TeX this
// renderer does not know keeps its formula, or only its cell, verbatim. Every character of the source reaches the
// HTML escaped.
const escape=value=>String(value).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Safari and iOS before 16.4 cannot parse a lookbehind ((?<!…)): one in a regular expression literal stops this module,
// and every page that imports it, from loading, and one built at load time throws there. No literal here uses one.
// Delimited math: \(…\), \[…\], $$…$$ and $…$, each ending at the first closer after its opener. $…$ follows Pandoc: no
// space just inside the dollars and no digit right after the closing one, so prices in an economics or history text
// ("$5 và $10") stay text. The last character before the closing $ is matched as a token that is not a space (\\\S or
// [^$\\\s]), which is exactly what a lookbehind (?<!\s) before it would require.
const DOLLAR=/\$(?=[^\s$])(?:\\.|[^$\n\\])*?(?:\\\S|[^$\\\s])\$(?!\d)/uy,CLOSERS=Object.freeze({'(':'\\)','[':'\\]','$':'$$'});
// The end of the $…$ formula opening at index, or -1 (study-layout-view.js reads a line's formulas as formulas() does).
export function dollarEnd(text,index){DOLLAR.lastIndex=index;return DOLLAR.exec(text)?DOLLAR.lastIndex:-1;}
// The formulas of a text, found in one pass: a closer missing after one opener is missing after every later one, so
// no opener is scanned past again (a pattern would rescan the rest of the text from each unclosed "\(").
// skip: environments written without delimiters, in order. An opener inside one that began after the last formula
// (\text{khi $n=1$} in a cases cell) belongs to it, so the environment is drawn whole rather than split round it.
function* formulas(text,skip=[]){
 const opener=/\\[([]|\$\$?/gu,missing=new Set();let next=0,last=0;
 for(;;){
  const open=opener.exec(text);if(!open)return;
  const at=open.index,kind=open[0].at(-1)==='$'?open[0].length>1?'$':'':open[0][1];let end=-1;
  while(next<skip.length&&(skip[next].end<=at||skip[next].at<last))next++;
  if(next<skip.length&&skip[next].at<at){opener.lastIndex=skip[next].end;continue;}
  // TeX reads backslashes in pairs, so after an odd run the opener's first character is escaped: "\\(" and "\\[" are a
  // row break before a bracket ("\\[2pt]" is row spacing) and "\$" is a dollar sign (Pandoc too), never an opener, and a
  // line of \$5 prices is not scanned again from each of them. Each run is counted once.
  let k=at;while(k>0&&text[k-1]==='\\')k--;if((at-k)%2){opener.lastIndex=at+1;continue;}
  if(kind&&!missing.has(kind)){const close=text.indexOf(CLOSERS[kind],at+2);if(close<0)missing.add(kind);else end=close+2;}
  if(end<0&&text[at]==='$')end=dollarEnd(text,at);
  if(end<0){opener.lastIndex=at+1;continue;}
  const match=[text.slice(at,end)];match.index=at;yield match;opener.lastIndex=last=end;
 }
}
// A run of backslashes is matched whole, with or without a vector command after it, so it is scanned once.
const vectorStarts=/(\\+)(?:(?:vec|overrightarrow)\b)?|[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]+\u20d7/gu;
const ELEMENTS=new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
const SUB=String.raw`_(?:\d+|\{\d+\})`,ELEMENT=String.raw`[A-Z][a-z]?`,UNIT=String.raw`(?:${ELEMENT}(?:${SUB})?|\((?:${ELEMENT}(?:${SUB})?)+\)(?:${SUB})?)`;
// Outside delimiters: a command, a combining arrow, an element formula with a numeric subscript (checked
// against the periodic table, so MAX_2 or snake_case stay text), a one-letter/number base with a script, or an escaped
// character (\%, \{, \,). A one-letter subscript must end its word (S_n, a_n^2; never a_b_c, x_ij or T_T); ^\circ is a
// degree sign. Each alternative: its capture group, the characters that may not come right before it, its pattern. A
// command is read from the start of its backslashes only, so a long run of them is scanned once.
const DEGREE=String.raw`\^(?:\\circ(?![A-Za-z])|[∘°])`;
const SCRIPTED=String.raw`(?=_(?:\{|\d|[a-z](?![\p{L}\p{N}_]))|\^(?:\{|[+\-−]?\d)|${DEGREE})`,RAISED=String.raw`(?=\^(?:\{|[+\-−]?\d)|${DEGREE})`,AFTER_WORD=String.raw`[\p{L}\p{N}_@\\'′]`;
const BARE=[[1,String.raw`\\`,String.raw`\\+[A-Za-z]+`],[2,'',String.raw`[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]+\u20d7`],[3,String.raw`[\p{L}\p{N}_@\\]`,String.raw`${UNIT}+(?:\^(?:\{\d*[+\-−]\}|\d*[+\-−]))?(?![\p{L}\p{N}_])`],[4,AFTER_WORD,String.raw`[\p{Script=Latin}\p{Script=Greek}]${SCRIPTED}`],[4,String.raw`[\p{L}\p{N}_@.,\\]`,String.raw`\d+${RAISED}`],[4,'',String.raw`[)\]]${RAISED}`],[5,String.raw`\\`,String.raw`\\[,;:!% #$&_{}]`],[6,'',String.raw`\^(?:\\circ(?![A-Za-z])|[∘°]|\{\s*(?:\\circ|[∘°])\s*\})`]];
// One expression with a lookbehind per alternative, built on first use. Where the browser refuses it (Safari before
// 16.4), the same matches are found by trying the alternatives in order at each place, after checking the character
// before it by hand.
let bareStarts=null,bareScan=null;
// The character (code point) that ends at index, as a lookbehind sees it.
function before(text,index){const low=text.charCodeAt(index-1),high=text.charCodeAt(index-2);return low>=0xdc00&&low<=0xdfff&&high>=0xd800&&high<=0xdbff?text.slice(index-2,index):text[index-1];}
function* scanBare(text){
 // The search finds the next place where an alternative matches with its lookbehind: one that refuses some characters
 // before it consumes the character before it instead (one outside that class), so it is tried only where it may start
 // and a long run of backslashes or digits is read once, not again from each of its characters.
 bareScan??={near:new RegExp(BARE.map(([,not,pattern])=>`${not?`(?!${not})`:''}[\\s\\S](?:${pattern})`).join('|'),'gu'),parts:BARE.map(([group,not,pattern])=>({group,not:not?new RegExp(`^${not}$`,'u'):null,pattern:new RegExp(pattern,'uy')}))};
 for(let at=0;at<text.length;){
  // The text's first place has no character before it and is tried as it is.
  let index=at,found=null;
  if(at){bareScan.near.lastIndex=at-before(text,at).length;const near=bareScan.near.exec(text);if(!near)return;index=near.index+(text.codePointAt(near.index)>0xffff?2:1);}
  for(const {group,not,pattern} of bareScan.parts){
   if(not&&index>0&&not.test(before(text,index)))continue;
   pattern.lastIndex=index;const match=pattern.exec(text);if(match){found=[match[0]];found[group]=match[0];found.index=index;break;}
  }
  if(found){yield found;at=index+found[0].length;}else at=index+(text.codePointAt(index)>0xffff?2:1);
 }
}
function bareMatches(text){
 if(bareStarts===null){try{bareStarts=new RegExp([1,2,3,4,5,6].map(group=>`(${BARE.filter(([part])=>part===group).map(([,not,pattern])=>not?`(?<!${not})${pattern}`:pattern).join('|')})`).join('|'),'gu');}catch{bareStarts=false;}}
 return bareStarts?text.matchAll(bareStarts):scanBare(text);
}
const symbols=Object.freeze({
 alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',varepsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',vartheta:'ϑ',iota:'ι',kappa:'κ',varkappa:'ϰ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',omicron:'ο',pi:'π',varpi:'ϖ',rho:'ρ',varrho:'ϱ',sigma:'σ',varsigma:'ς',tau:'τ',upsilon:'υ',phi:'φ',varphi:'φ',chi:'χ',psi:'ψ',omega:'ω',digamma:'ϝ',
 Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Upsilon:'Υ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
 cdot:'·',times:'×',div:'÷',pm:'±',mp:'∓',ast:'∗',star:'⋆',circ:'∘',bullet:'•',oplus:'⊕',ominus:'⊖',otimes:'⊗',oslash:'⊘',odot:'⊙',setminus:'∖',smallsetminus:'∖',uplus:'⊎',sqcup:'⊔',sqcap:'⊓',amalg:'⨿',wr:'≀',dagger:'†',ddagger:'‡',diamond:'⋄',bigcirc:'◯',dotplus:'∔',ltimes:'⋉',rtimes:'⋊',boxplus:'⊞',boxminus:'⊟',boxtimes:'⊠',centerdot:'·',cdotp:'·',ldotp:'.',intercal:'⊺',Cap:'⋒',Cup:'⋓',
 le:'≤',leq:'≤',leqslant:'⩽',leqq:'≦',ge:'≥',geq:'≥',geqslant:'⩾',geqq:'≧',ne:'≠',neq:'≠',approx:'≈',approxeq:'≊',sim:'∼',simeq:'≃',cong:'≅',equiv:'≡',propto:'∝',varpropto:'∝',ll:'≪',gg:'≫',parallel:'∥',perp:'⊥',mid:'∣',
 lneq:'⪇',gneq:'⪈',lneqq:'≨',gneqq:'≩',nless:'≮',ngtr:'≯',nleq:'≰',ngeq:'≱',nleqslant:'⩽̸',ngeqslant:'⩾̸',lesssim:'≲',gtrsim:'≳',lessgtr:'≶',gtrless:'≷',prec:'≺',succ:'≻',preceq:'⪯',succeq:'⪰',nsim:'≁',ncong:'≇',napprox:'≉',nequiv:'≢',asymp:'≍',doteq:'≐',triangleq:'≜',coloneqq:'≔',backsim:'∽',thicksim:'∼',thickapprox:'≈',bowtie:'⋈',models:'⊨',vdash:'⊢',dashv:'⊣',nmid:'∤',nparallel:'∦',smile:'⌣',frown:'⌢',between:'≬',lhd:'⊲',rhd:'⊳',unlhd:'⊴',unrhd:'⊵',triangleleft:'◁',triangleright:'▷',trianglelefteq:'⊴',trianglerighteq:'⊵',
 in:'∈',notin:'∉',ni:'∋',owns:'∋',notni:'∌',subset:'⊂',subseteq:'⊆',subsetneq:'⊊',varsubsetneq:'⊊',subseteqq:'⫅',subsetneqq:'⫋',nsubset:'⊄',nsubseteq:'⊈',supset:'⊃',supseteq:'⊇',supsetneq:'⊋',varsupsetneq:'⊋',supseteqq:'⫆',supsetneqq:'⫌',nsupset:'⊅',nsupseteq:'⊉',sqsubset:'⊏',sqsupset:'⊐',sqsubseteq:'⊑',sqsupseteq:'⊒',cap:'∩',cup:'∪',emptyset:'∅',varnothing:'∅',complement:'∁',forall:'∀',exists:'∃',nexists:'∄',neg:'¬',lnot:'¬',land:'∧',wedge:'∧',lor:'∨',vee:'∨',top:'⊤',bot:'⊥',
 to:'→',rightarrow:'→',leftarrow:'←',gets:'←',leftrightarrow:'↔',Rightarrow:'⇒',Leftarrow:'⇐',Leftrightarrow:'⇔',iff:'⟺',implies:'⟹',impliedby:'⟸',longrightarrow:'⟶',longleftarrow:'⟵',longleftrightarrow:'⟷',Longrightarrow:'⟹',Longleftarrow:'⟸',Longleftrightarrow:'⟺',mapsto:'↦',longmapsto:'⟼',hookrightarrow:'↪',hookleftarrow:'↩',uparrow:'↑',downarrow:'↓',updownarrow:'↕',Uparrow:'⇑',Downarrow:'⇓',Updownarrow:'⇕',nearrow:'↗',searrow:'↘',swarrow:'↙',nwarrow:'↖',rightharpoonup:'⇀',rightharpoondown:'⇁',leftharpoonup:'↼',leftharpoondown:'↽',rightleftharpoons:'⇌',leftrightharpoons:'⇋',leadsto:'⇝',rightsquigarrow:'⇝',twoheadrightarrow:'↠',rightrightarrows:'⇉',leftleftarrows:'⇇',rightleftarrows:'⇄',leftrightarrows:'⇆',circlearrowleft:'↺',circlearrowright:'↻',curvearrowleft:'↶',curvearrowright:'↷',nrightarrow:'↛',nleftarrow:'↚',nleftrightarrow:'↮',nRightarrow:'⇏',nLeftarrow:'⇍',nLeftrightarrow:'⇎',therefore:'∴',because:'∵',
 infty:'∞',partial:'∂',nabla:'∇',angle:'∠',measuredangle:'∡',sphericalangle:'∢',triangle:'△',vartriangle:'△',triangledown:'▽',blacktriangle:'▲',square:'□',Box:'□',blacksquare:'■',lozenge:'◊',bigstar:'★',checkmark:'✓',degree:'°',textdegree:'°',celsius:'℃',ohm:'Ω',micro:'µ',perthousand:'‰',prime:'′',backprime:'‵',ldots:'…',dots:'…',dotsc:'…',dotso:'…',cdots:'⋯',dotsb:'⋯',dotsm:'⋯',dotsi:'⋯',vdots:'⋮',ddots:'⋱',iddots:'⋰',hbar:'ℏ',hslash:'ℏ',ell:'ℓ',aleph:'ℵ',beth:'ℶ',gimel:'ℷ',daleth:'ℸ',Re:'ℜ',Im:'ℑ',wp:'℘',mho:'℧',eth:'ð',imath:'ı',jmath:'ȷ',surd:'√',flat:'♭',natural:'♮',sharp:'♯',clubsuit:'♣',diamondsuit:'♢',heartsuit:'♡',spadesuit:'♠',copyright:'©',pounds:'£',
 sum:'∑',prod:'∏',coprod:'∐',bigcup:'⋃',bigcap:'⋂',bigoplus:'⨁',bigotimes:'⨂',bigodot:'⨀',biguplus:'⨄',bigsqcup:'⨆',bigvee:'⋁',bigwedge:'⋀',int:'∫',iint:'∬',iiint:'∭',oint:'∮',oiint:'∯',
 langle:'⟨',rangle:'⟩',lfloor:'⌊',rfloor:'⌋',lceil:'⌈',rceil:'⌉',lvert:'|',rvert:'|',lVert:'‖',rVert:'‖',vert:'|',Vert:'‖',lbrace:'{',rbrace:'}',lbrack:'[',rbrack:']',colon:':',backslash:'\\',
 quad:'\u2003',qquad:'\u2003\u2003',enspace:'\u2002',enskip:'\u2002',thinspace:'\u2009',medspace:'\u205f',thickspace:'\u2004',space:' ',nobreakspace:'\u00a0',negthinspace:'',negmedspace:'',negthickspace:''
});
// Non-letter commands: TeX spacing and escaped special characters.
const escapes=Object.freeze({',':'\u2009',':':'\u205f','>':'\u205f',';':'\u2004','!':'',' ':' ','{':'{','}':'}','%':'%','$':'$','&':'&','#':'#','_':'_','|':'‖'});
const functions=new Set('sin cos tan cot sec csc arcsin arccos arctan arccot sinh cosh tanh coth log ln lg exp lim liminf limsup max min sup inf det dim ker gcd lcm deg arg sgn Pr hom tg ctg cotg arctg arcctg'.split(' '));
// Operators whose scripts are limits under and over them in display style (or after \limits; \nolimits keeps them at
// the side); inline they stay at the side. Integrals keep theirs at the side in display style too, as TeX and printed
// textbooks set them; after \limits they stack with room above the sign, whose hook rises above its line.
const LIMITS=new Set('lim liminf limsup max min sup inf det gcd Pr'.split(' ')),FUNCTION_NAMES=Object.freeze({liminf:'lim inf',limsup:'lim sup'});
const OPERATORS=new Set('sum prod coprod bigcup bigcap bigoplus bigotimes bigodot biguplus bigsqcup bigvee bigwedge int iint iiint oint oiint'.split(' ')),INTEGRALS=new Set('int iint iiint oint oiint'.split(' '));
const fonts=Object.freeze({mathrm:'mathrm',mathup:'mathrm',operatorname:'mathrm',mathbf:'mathbf',boldsymbol:'mathbf',bm:'mathbf',mathit:'mathit',mathsf:'mathsf',mathtt:'mathtt'});
const texts=Object.freeze({text:'',textrm:'',textnormal:'',textup:'',textmd:'',mbox:'',hbox:'',textit:' math-mathit',emph:' math-mathit',textbf:' math-mathbf',textsf:' math-mathsf',texttt:' math-mathtt'});
// The parts of a \text body: $…$ (math), an escaped character or a command, a brace, words, a lone $.
const TEXT_PARTS=/\$(?:\\[\s\S]|[^$\\])+\$|\\[\s\S]?|[{}]|[^$\\{}]+|\$/gu;
// Double-struck, script and fraktur letters are the Letterlike Symbols where Unicode has them (ℝ, ℕ, ℤ, ℒ…), else the
// Mathematical Alphanumeric letter of that style; never italic letters, so copied text keeps meaning.
const LETTERS=Object.freeze({mathbb:[0x1D538,0x1D552,0x1D7D8,{C:'ℂ',H:'ℍ',N:'ℕ',P:'ℙ',Q:'ℚ',R:'ℝ',Z:'ℤ'}],mathcal:[0x1D49C,0x1D4B6,0,{B:'ℬ',E:'ℰ',F:'ℱ',H:'ℋ',I:'ℐ',L:'ℒ',M:'ℳ',R:'ℛ',e:'ℯ',g:'ℊ',o:'ℴ'}],mathfrak:[0x1D504,0x1D51E,0,{C:'ℭ',H:'ℌ',I:'ℑ',R:'ℜ',Z:'ℨ'}]});
const LETTER_STYLES=Object.freeze({mathbb:'mathbb',Bbb:'mathbb',mathcal:'mathcal',mathscr:'mathcal',mathfrak:'mathfrak'});
function lettered(style,value){const [upper,lower,digit,holes]=LETTERS[style];return [...value].map(c=>holes[c]??(c>='A'&&c<='Z'?String.fromCodePoint(upper+c.charCodeAt(0)-65):c>='a'&&c<='z'?String.fromCodePoint(lower+c.charCodeAt(0)-97):digit&&c>='0'&&c<='9'?String.fromCodePoint(digit+c.charCodeAt(0)-48):c)).join('');}
// A body that is more than letters (\mathbb{R^n}, \mathbb{Z_+}): its letters take the style, while command names and
// the scripts (a character, a command or a group after _ or ^) stay as written, so ℝ^n is read as math.
function styled(style,body){
 const skip=at=>{if(body[at]==='\\'){let j=at+1;while(/[A-Za-z]/u.test(body[j]??''))j++;return j>at+1?j:Math.min(body.length,at+2);}return body[at]==='{'?group(body,at)?.end??at+1:at+(body.codePointAt(at)>0xffff?2:1);};
 let out='',i=0;
 while(i<body.length){
  const c=body[i];let j=i;
  if(c==='\\')j=skip(i);
  else if(c==='_'||c==='^'){j=i+1;while(body[j]===' ')j++;if(j<body.length)j=skip(j);}
  if(j>i){out+=body.slice(i,j);i=j;}else{out+=/[A-Za-z0-9]/u.test(c)?lettered(style,c):c;i++;}
 }
 return out;
}
// Inside math TeX ignores the space after a command. Letters and prefix symbols bind to what follows ("∠AOB",
// "ΔABC"); operators, relations and closing brackets keep the space written after them ("a · b", "⟨a, b⟩ = c").
const binding=new Set('angle measuredangle sphericalangle triangle langle lfloor lceil forall exists nexists neg lnot partial nabla complement sum prod coprod int iint iiint oint oiint bigcup bigcap bigoplus bigotimes bigodot biguplus bigsqcup bigvee bigwedge hbar hslash ell aleph beth gimel daleth wp Re Im'.split(' '));
const ignored=new Set('displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr bigm Bigm biggm Biggm notag nonumber allowbreak nobreak relax hline hdashline strut mathstrut rm bf it sf tt cal'.split(' '));
const accents=Object.freeze({hat:'\u0302',widehat:'\u0302',check:'\u030c',widecheck:'\u030c',tilde:'\u0303',widetilde:'\u0303',dot:'\u0307',ddot:'\u0308',dddot:'\u20db',breve:'\u0306',acute:'\u0301',grave:'\u0300',mathring:'\u030a'});
const marks=Object.freeze({'\u0302':'M4 15L50 3L96 15','\u030c':'M4 3L50 15L96 3','\u0303':'M3 12C20 2 34 2 50 8S80 14 97 4','\u0307':'M50 8h.01','\u0308':'M38 8h.01M62 8h.01','\u20db':'M30 8h.01M50 8h.01M70 8h.01','\u0306':'M4 3C20 16 80 16 96 3','\u0301':'M42 14L58 2','\u0300':'M42 2L58 14','\u030a':'M50 3a5 5 0 1 0 .01 0'});
const names=Object.freeze({'\u0302':'mũ','\u030c':'móc','\u0303':'ngã','\u0307':'chấm','\u0308':'hai chấm','\u20db':'ba chấm','\u0306':'trăng','\u0301':'sắc','\u0300':'huyền','\u030a':'vòng'});
// Arrows drawn over a body: aria-label, label, path in a 100×16 box stretched to the body's width.
const OVER_ARROWS=Object.freeze({vec:['Vectơ','vectơ','M2 8H96M83 2L96 8L83 14'],overrightarrow:['Vectơ','vectơ','M2 8H96M83 2L96 8L83 14'],overleftarrow:['Vectơ','vectơ','M98 8H4M17 2L4 8L17 14'],overleftrightarrow:['Đường thẳng','đường thẳng','M4 8H96M17 2L4 8L17 14M83 2L96 8L83 14']});
// A \not before these is one negated sign; before anything else the slash is overlaid (U+0338).
const NEGATED=Object.freeze({'=':'≠','<':'≮','>':'≯','∈':'∉','≡':'≢','⊂':'⊄','⊃':'⊅','⊆':'⊈','⊇':'⊉','∼':'≁','≈':'≉','≅':'≇','≃':'≄','∥':'∦','∣':'∤','|':'∤','≤':'≰','≥':'≱','∋':'∌','∃':'∄','→':'↛','←':'↚','↔':'↮','⇒':'⇏','⇐':'⇍','⇔':'⇎','⊢':'⊬','⊨':'⊭','≺':'⊀','≻':'⊁','⊑':'⋢','⊒':'⋣','⊲':'⋪','⊳':'⋫','⊴':'⋬','⊵':'⋭'});
// Arrows that stretch under and over their labels: sign, left head, shaft, right head (heads 8×12, shaft 10×12 stretched).
const XARROWS=Object.freeze({
 xrightarrow:['→','','M0 6H10','M0 6H7.4M3 2.4L7.4 6L3 9.6'],xleftarrow:['←','M8 6H.6M5 2.4L.6 6L5 9.6','M0 6H10',''],xleftrightarrow:['↔','M8 6H.6M5 2.4L.6 6L5 9.6','M0 6H10','M0 6H7.4M3 2.4L7.4 6L3 9.6'],
 xRightarrow:['⇒','','M0 4.3H10M0 7.7H10','M0 4.3H5.6M0 7.7H5.6M3.2 1.2L7.6 6L3.2 10.8'],xLeftarrow:['⇐','M8 4.3H2.4M8 7.7H2.4M4.8 1.2L.4 6L4.8 10.8','M0 4.3H10M0 7.7H10',''],xLeftrightarrow:['⇔','M8 4.3H2.4M8 7.7H2.4M4.8 1.2L.4 6L4.8 10.8','M0 4.3H10M0 7.7H10','M0 4.3H5.6M0 7.7H5.6M3.2 1.2L7.6 6L3.2 10.8'],
 xlongequal:['=','','M0 4.3H10M0 7.7H10',''],xrightleftharpoons:['⇌','M8 4.3H0M8 7.7H.6M4.6 10.7L.6 7.7','M0 4.3H10M0 7.7H10','M0 4.3H7.4M3.4 1.3L7.4 4.3M0 7.7H8'],xleftrightharpoons:['⇋','M8 7.7H0M8 4.3H.6M4.6 1.3L.6 4.3','M0 4.3H10M0 7.7H10','M0 7.7H7.4M3.4 10.7L7.4 7.7M0 4.3H8'],xmapsto:['↦','M.6 3V9M.6 6H8','M0 6H10','M0 6H7.4M3 2.4L7.4 6L3 9.6']
});
// Whitelisted environments: column alignment (l, c, r, or rl for aligned pairs), fences, cells set in display style
// where TeX sets them so, and an argument (array's columns, alignedat's pair count). The rest are drawn row by row.
const ENVIRONMENTS=Object.freeze({cases:{align:'l',left:'{'},dcases:{align:'l',left:'{',display:true},rcases:{align:'l',right:'}'},aligned:{align:'rl',display:true},align:{align:'rl',display:true},'align*':{align:'rl',display:true},alignedat:{align:'rl',display:true,count:true},split:{align:'rl',display:true},gathered:{align:'c',display:true},gather:{align:'c',display:true},'gather*':{align:'c',display:true},equation:{align:'c',display:true},'equation*':{align:'c',display:true},array:{align:'c',columns:true},subarray:{align:'c',columns:true},matrix:{align:'c'},pmatrix:{align:'c',left:'(',right:')'},bmatrix:{align:'c',left:'[',right:']'},Bmatrix:{align:'c',left:'{',right:'}'},vmatrix:{align:'c',left:'|',right:'|'},Vmatrix:{align:'c',left:'‖',right:'‖'},smallmatrix:{align:'c'}});
export const MATH_ENVIRONMENTS=Object.freeze(Object.keys(ENVIRONMENTS));
// \left and \right delimiters, and the fence each one draws.
// A named one must end its word (\vert, not \vertical); \{ \} \| are one character and may be followed by letters.
const DELIMITER=String.raw`(\\(?:(?:[lr]?[vV]ert|[lr]angle|[lr]floor|[lr]ceil|[lr]brace|[lr]brack|backslash)(?![A-Za-z])|[{}|])|[()[\]|/.<>])`;
const OPENING=new RegExp(`^${DELIMITER}`,'u'),CLOSING=new RegExp(String.raw`^\\+right\s*${DELIMITER}`,'u'),LEFT_BEFORE=new RegExp(String.raw`\\+left\s*${DELIMITER}\s*$`,'u'),RIGHT_AFTER=new RegExp(String.raw`^\s*\\+right\s*${DELIMITER}`,'u');
const FENCES=Object.freeze({'(':'(',')':')','[':'[',']':']','|':'|','/':'/','.':'','<':'⟨','>':'⟩','\\{':'{','\\}':'}','\\|':'‖','\\vert':'|','\\lvert':'|','\\rvert':'|','\\Vert':'‖','\\lVert':'‖','\\rVert':'‖','\\langle':'⟨','\\rangle':'⟩','\\lfloor':'⌊','\\rfloor':'⌋','\\lceil':'⌈','\\rceil':'⌉','\\lbrace':'{','\\rbrace':'}','\\lbrack':'[','\\rbrack':']','\\backslash':'\\'});
const SPACE=/\s/u,LIMITS_AFTER=/^\s*\\+(no)?limits(?![A-Za-z])/u;
// The commands handled by name below, besides those of the tables.
const HANDLED='vec overrightarrow overleftarrow overleftrightarrow frac dfrac tfrac cfrac binom dbinom tbinom sqrt overline bar underline overparen wideparen overarc left right begin end overset underset stackrel substack underbrace overbrace boxed fbox tag pmod bmod pod mod not ce pu label color textcolor colorbox hspace vspace phantom hphantom vphantom'.split(' ');
// While unsupportedMath runs: what math is printed as written. A command or environment this renderer does not know is
// named (report); a formula or a cell that fails for want of a brace, a script or an argument is shown by its first
// characters (printedAsWritten), unless a name given while it was read explains it (named counts the names).
let unknown=null,named=0;
const report=name=>{if(unknown){unknown.add(name);named++;}};
function printedAsWritten(source,before){if(unknown&&named===before){const shown=[...source.slice(0,100).replace(/\s+/gu,' ').trim()];unknown.add(shown.length>24?`${shown.slice(0,24).join('')}…`:shown.join(''));}}
// Set when a reading goes deeper than the renderer draws (24 levels, which only hostile text reaches). From then on
// every reading of that piece (one formula, or the plain text between two) fails at once, so a nest of commands that
// failed is not read again from each of its levels (bare text tries each command of a failed one on its own); the
// next piece is read afresh, so one such nest never costs the rest of the text its formulas.
let deep=false;
const tooDeep=()=>{deep=true;return null;};
// The matching close of every brace, environment and \left of a text, found in one pass and kept for the rest of the
// rendering (TeX pairs them by nesting; an unmatched opener has none), so no opener is ever scanned for again and a
// long run of unclosed ones stays linear. A run of backslashes is read once and, as TeX reads it, in pairs: after an
// odd run the last backslash starts a command or escapes the next character (\{ is no brace), after an even run (row
// breaks) a brace still groups. \\begin and \\left count as the commands (OCR sometimes doubles every backslash), while
// \\\begin is a row break before \begin.
const STRUCTURE=/(\\+)(?:(begin|end)[ \t\r\n]*\{([A-Za-z]{1,24}\*?)\}|(left|right)(?![A-Za-z])|[A-Za-z]+|([\s\S]))?|[{}]/gu;
const structures=new Map(),drawn=new Map();
function structure(text){
 let found=structures.get(text);if(found)return found;
 if(structures.size>20000)structures.clear();
 const braces=new Map(),envs=[],open=[],begun=[],named=new Map(),fences=new Map(),closers=new Set(),lefts=[];
 for(const m of text.matchAll(STRUCTURE)){
  const run=m[1]?.length??0,odd=run%2===1,brace=!run?m[0]:!odd&&(m[5]==='{'||m[5]==='}')?m[5]:'',at=m.index+(brace?run:0);
  if(brace==='{')open.push(at);
  else if(brace==='}'){if(open.length)braces.set(open.pop(),at);while(lefts.length&&lefts.at(-1).depth>open.length)lefts.pop();}
  else if(m[2]){
   // \begin or \end itself: the last backslash of an odd run, the last two of an even (doubled) one.
   const start=at+run-(odd?1:2),end=at+m[0].length;
   if(m[2]==='begin'){const env={at:start,name:m[3],doubled:!odd,body:end,close:-1,end:-1,live:true};envs.push(env);begun.push(env);if(!named.has(env.name))named.set(env.name,[]);named.get(env.name).push(env);}
   else{
    // The nearest open environment of that name closes; any opened inside it and still open never will.
    const list=named.get(m[3]);while(list?.length&&!list.at(-1).live)list.pop();const env=list?.pop();
    if(env){while(begun.length){const top=begun.pop();top.live=false;if(top===env)break;}env.close=start;env.end=end;}
   }
  }
  else if(m[4]==='left')lefts.push({at,depth:open.length});
  else if(m[4]==='right'){const left=lefts.at(-1);if(left&&left.depth===open.length){lefts.pop();fences.set(left.at,at);closers.add(at);}}
 }
 // loose: the \right of each pair whose \left was printed as its delimiter alone (bare text), filled while rendering.
 found={braces,envs,starts:new Map(envs.map(env=>[env.at,env])),fences,closers,loose:new Set()};structures.set(text,found);return found;
}
function group(text,index){
 if(text[index]!=='{')return null;
 const close=structure(text).braces.get(index);return close===undefined?null:{body:text.slice(index+1,close),end:close+1};
}
// An optional argument [..] right at index (after spaces), braces inside it skipped whole; at most 200 characters.
function optional(text,index){
 let i=index;while(text[i]===' ')i++;if(text[i]!=='[')return null;
 for(let j=i+1;j<text.length&&j<i+200;j++){if(text[j]==='{'){const close=structure(text).braces.get(j);if(close===undefined)return null;j=close;}else if(text[j]===']')return {body:text.slice(i+1,j),end:j+1};}
 return null;
}
function vector(html,label,[aria,,path]=OVER_ARROWS.vec){
 return `<span class="math-vector" role="img" aria-label="${aria} ${escape(label)}"><svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg><span aria-hidden="true">${html}</span></span>`;
}
// One letter takes the font's combining mark; a longer body (\widehat{AOB}) gets a stretched drawn mark.
function accent(body,mark){
 if([...body.label].length===1&&body.html===escape(body.label))return {html:`${body.html}${mark}`,label:`${body.label} ${names[mark]}`};
 const dots=mark==='\u0307'||mark==='\u0308'||mark==='\u20db';
 return {html:`<span class="math-over" role="img" aria-label="${escape(body.label)} ${names[mark]}"><svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none"><path d="${marks[mark]}" fill="none" stroke="currentColor" stroke-width="${dots?3:1}" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg><span aria-hidden="true">${body.html}</span></span>`,label:`${body.label} ${names[mark]}`,h:(body.h||1)+.2};
}
// A fence drawn as one stroke stretched to its content; the path is laid out for the content's height in lines, so
// the curls of a brace keep their size however many rows it spans. The pen keeps its width (non-scaling stroke). The
// drawing is placed over a box stretched to the rows, so the fence never makes them taller than they are.
const FENCE_WIDTHS=Object.freeze({'{':.45,'}':.45,'(':.36,')':.36,'[':.3,']':.3,'|':.22,'‖':.34,'⟨':.36,'⟩':.36,'⌊':.3,'⌋':.3,'⌈':.3,'⌉':.3,'/':.4,'\\':.4}),MIRRORED=Object.freeze({'}':'{',')':'(',']':'[','⟩':'⟨','⌋':'⌊','⌉':'⌈'});
function fencePath(c,H){
 const m=H/2,k=Math.min(m,13);
 return c==='{'?`M9 1C6 1 5 2 5 5V${m-4}C5 ${m-1.5} 3.5 ${m} 1 ${m}C3.5 ${m} 5 ${m+1.5} 5 ${m+4}V${H-5}C5 ${H-2} 6 ${H-1} 9 ${H-1}`:c==='('?`M8.5 1C4.2 ${k*.35} 2.2 ${k*.7} 2.2 ${k}V${H-k}C2.2 ${H-k*.7} 4.2 ${H-k*.35} 8.5 ${H-1}`:c==='['?`M8 1H3V${H-1}H8`:c==='⌊'?`M3 1V${H-1}H8`:c==='⌈'?`M8 1H3V${H-1}`:c==='⟨'?`M8 1L2 ${m}L8 ${H-1}`:c==='|'?`M5 1V${H-1}`:c==='‖'?`M3 1V${H-1}M7 1V${H-1}`:c==='/'?`M9 1L1 ${H-1}`:`M1 1L9 ${H-1}`;
}
// A drawn fence or arrow keeps its character as text, for copying (from the page and from the exported PDF), searching
// and screen readers: transparent, zero-width and in the flow beside the drawing, on its inner side, so nothing moves.
// Chromium's PDF drops text set at opacity 0 or clipped away, and prints the text of a positioned element (the fence's
// drawing box) after the rest of its block.
const copy=c=>`<span class="math-copy">${escape(c)}</span>`;
function fence(c,lines,right=false){
 if(!c)return '';
 if(!Object.hasOwn(FENCE_WIDTHS,c))return `<span class="math-fence-text">${escape(c)}</span>`;
 const H=Math.max(24,Math.round(lines*22)),shape=MIRRORED[c]??c;
 const drawing=`<span class="math-fence" aria-hidden="true" style="width:${FENCE_WIDTHS[c]}em"><svg viewBox="0 0 10 ${H}" preserveAspectRatio="none"><path d="${fencePath(shape,H)}"${shape===c?'':' transform="matrix(-1 0 0 1 10 0)"'} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></span>`;
 return right?copy(c)+drawing:drawing+copy(c);
}
// A horizontal brace under (or over) a body, its width guessed from the body's length so its curls keep their size.
function hbrace(under,label){
 const W=Math.max(30,Math.min(600,[...label].length*7)),m=W/2;
 return `<span class="math-brace"><svg viewBox="0 0 ${W} 10" preserveAspectRatio="none" aria-hidden="true"><path d="M1 1C1 4.5 2.5 5.5 6 5.5H${m-5}C${m-2} 5.5 ${m} 6.5 ${m} 9C${m} 6.5 ${m+2} 5.5 ${m+5} 5.5H${W-6}C${W-2.5} 5.5 ${W-1} 4.5 ${W-1} 1"${under?'':' transform="matrix(1 0 0 -1 0 10)"'} fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg></span>`;
}
// The shaft is drawn in two halves with the arrow's sign as text (copy) between them, at the arrow's middle.
function arrowLine([sign,left,shaft,right]){
 const svg=(name,box,d,stretch)=>`<svg class="${name}" viewBox="${box}"${stretch?' preserveAspectRatio="none"':''} aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`,half=svg('math-arrow-shaft','0 0 10 12',shaft,true);
 return `<span class="math-arrow">${left?svg('math-arrow-head','0 0 8 12',left):''}${half}${copy(sign)}${half}${right?svg('math-arrow-head','0 0 8 12',right):''}</span>`;
}
// A stack keeps its base on the text's baseline: what goes above is a block over a column that starts with the base,
// and an inline-block takes the baseline of its last line, the column's, which is the base's.
function stack(base,over,under,kind=''){
 return `<span class="math-stack${kind?` math-${kind}`:''}">${over?`<span class="math-above">${over}</span>`:''}<span class="math-stack-main"><span class="math-stack-base">${base}</span>${under?`<span class="math-below">${under}</span>`:''}</span></span>`;
}
// An argument is a braced group; inside delimiters TeX also allows one token (\frac12, \vec b).
function argument(text,index,depth,strict){
 let i=index;while(text[i]===' ')i++;
 const braced=group(text,i);if(braced){const body=mathBody(braced.body,depth+1);return body&&{...body,end:braced.end};}
 return strict?null:atom(text,i,depth+1);
}
function command(text,index,depth,strict=false,display=false){
 if(deep||depth>24)return tooDeep();
 const special=/^\\([,:;!> {}%$&#_|])/u.exec(text.slice(index,index+2));if(special)return {html:escape(escapes[special[1]]),label:escapes[special[1]],end:index+2,silent:!escapes[special[1]]};
 const found=/^\\+([A-Za-z]+)\s*/u.exec(text.slice(index));if(!found)return null;
 // Arguments may follow after spaces; a symbol keeps the space after it ("\alpha là" is not "αlà").
 const name=found[1],next=index+found[0].length,named=index+found[0].trimEnd().length;
 if(Object.hasOwn(OVER_ARROWS,name)){
  const inner=group(text,next),body=inner?mathBody(inner.body,depth+1):atom(text,next,depth+1);
  if(!body||!body.label.trim())return null;
  return {html:vector(body.html,body.label,OVER_ARROWS[name]),label:`${OVER_ARROWS[name][1]} ${body.label}`,end:inner?inner.end:body.end,h:(body.h||1)+.25};
 }
 if(name==='frac'||name==='dfrac'||name==='tfrac'||name==='cfrac'||name==='binom'||name==='dbinom'||name==='tbinom'){
  const top=argument(text,next,depth,strict),bottom=top&&argument(text,top.end,depth,strict),binom=name.endsWith('binom');
  if(!bottom||!top.label.trim()||!bottom.label.trim())return null;
  const label=binom?`tổ hợp ${top.label} trên ${bottom.label}`:`${top.label} phần ${bottom.label}`;
  const html=`<span class="math-frac${binom?' math-binom':''}" role="img" aria-label="${escape(label)}"><span class="math-num" aria-hidden="true">${top.html}</span><span class="math-den" aria-hidden="true">${bottom.html}</span></span>`;
  return {html:binom?`(${html})`:html,label,end:bottom.end,h:((top.h||1)+(bottom.h||1))*.82+.15,box:true};
 }
 if(name==='sqrt'){
  const index_=optional(text,next),root=index_&&mathBody(index_.body,depth+1);if(index_&&(!root||!root.label.trim()))return null;
  const body=argument(text,index_?index_.end:next,depth,strict);if(!body||!body.label.trim())return null;
  const label=root?`căn bậc ${root.label} của ${body.label}`:`căn ${body.label}`;
  return {html:`<span class="math-sqrt" role="img" aria-label="${escape(label)}">${root?`<span class="math-index" aria-hidden="true">${root.html}</span>`:''}<span aria-hidden="true">√</span><span class="math-radicand" aria-hidden="true">${body.html}</span></span>`,label,end:body.end,h:(body.h||1)+.15,box:true};
 }
 if(name==='overline'||name==='bar'||name==='underline'){
  const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;
  return {html:`<span class="math-${name==='underline'?'underline':'overline'}">${body.html}</span>`,label:body.label,end:body.end,h:body.h};
 }
 if(Object.hasOwn(accents,name)){const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;return {...accent(body,accents[name]),end:body.end};}
 // An arc over a body (\overparen{AB}: the arc AB of a circle) is always drawn.
 if(name==='overparen'||name==='wideparen'||name==='overarc'){
  const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;
  return {html:`<span class="math-over" role="img" aria-label="cung ${escape(body.label)}"><svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none"><path d="M3 14C25 3 75 3 97 14" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg><span aria-hidden="true">${body.html}</span></span>`,label:`cung ${body.label}`,end:body.end,h:(body.h||1)+.2};
 }
 if(Object.hasOwn(LETTER_STYLES,name)){
  const style=LETTER_STYLES[name],inner=group(text,next);
  if(inner&&/^[A-Za-z0-9\s]*$/u.test(inner.body)&&inner.body.trim()){const shown=lettered(style,inner.body.replace(/\s+/gu,''));return {html:escape(shown),label:shown,end:inner.end};}
  if(!inner){if(strict||!/[A-Za-z0-9]/u.test(text[next]??''))return null;const shown=lettered(style,text[next]);return {html:escape(shown),label:shown,end:next+1};}
  const body=mathBody(styled(style,inner.body),depth+1);return body&&{...body,end:inner.end};
 }
 if(Object.hasOwn(fonts,name)){
  // \operatorname*{arg\,max} takes limits as \max does.
  const starred=name==='operatorname'&&text[next]==='*',inner=group(text,starred?next+1:next),body=inner&&mathBody(inner.body,depth+1);if(!body)return null;
  return {html:`<span class="math-${fonts[name]}">${body.html}</span>`,label:body.label,end:inner.end,h:body.h,...(starred?{op:'limits'}:{})};
 }
 // \text bodies are words, not math: spaces are kept and nothing inside is read but $…$ (math again, so
 // \text{nếu $x\ge 0$} reads its \ge) and escaped characters (\%, \$, \&…). Words holding a brace or a command cannot be
 // set: the formula is printed as written and \text is reported, so a translation holding it is warned about.
 if(Object.hasOwn(texts,name)){
  const inner=group(text,next);if(!inner)return null;
  let html='',label='';
  for(const [part] of inner.body.matchAll(TEXT_PARTS)){
   if(part.length>2&&part[0]==='$'&&part.at(-1)==='$'){const math=mathBody(part.slice(1,-1),depth+1);if(!math)return null;html+=math.html;label+=math.label;continue;}
   const word=part[0]==='\\'?escapes[part[1]]:part;
   if(word===undefined||part==='{'||part==='}'){report(`\\${name}`);return null;}
   html+=escape(word);label+=word;
  }
  return {html:`<span class="math-text${texts[name]}">${html}</span>`,label,end:inner.end};
 }
 if(name==='left'||name==='right'){
  const delimiter=OPENING.exec(text.slice(next,next+16));if(!delimiter)return null;
  const shape=FENCES[delimiter[1]],after=next+delimiter[1].length,{fences,closers,starts,loose}=structure(text);
  if(name==='left'){
   // \left( … \right) with a 2-D body stretches its fences round it; \left\{ round a lone environment draws one fence.
   const close=fences.get(index),shut=close===undefined?null:CLOSING.exec(text.slice(close,close+24));
   if(shut){
    // Whether the body is one environment is read off this text's own table (one table per \left would make a nest
    // of them quadratic).
    const inner=text.slice(after,close),lead=after+inner.length-inner.trimStart().length,env=starts.get(lead);
    const only=!!env&&env.end===close-(inner.length-inner.trimEnd().length)&&Object.hasOwn(ENVIRONMENTS,env.name);
    const body=only?environment(text,lead,depth+1,display):mathBody(inner,depth+1,display);
    if(body)return {...fenced(body,shape,FENCES[shut[1]],only),end:close+shut[0].length};
    // A body that cannot be drawn fails its \left…\right inside math: printing the delimiter alone and reading the
    // body again at this depth would read it again at every level of a nest of them (exponential time). In bare text
    // (a command on its own: strict, depth 0) the pair keeps its delimiters and the words between are read as text.
    if(!strict||depth)return null;
    loose.add(close);
   }
  }
  // The \right of a pair whose \left could not be drawn stays as written with it.
  else if(closers.has(index)&&!loose.has(index))return null;
  // A \left without its \right, or a \right without its \left, is its delimiter alone, as TeX would print it.
  return {html:escape(shape),label:shape,end:after};
 }
 // \\\begin (a row break glued to it) or \\begin (doubled): the environment starts where structure() put it.
 if(name==='begin'){let run=1;while(text[index+run]==='\\')run++;return environment(text,index+run-(run%2?1:2),depth,display);}
 if(name==='end'){report(`\\end{${/^\{([^{}]{0,32})\}/u.exec(text.slice(next,next+40))?.[1]??''}}`);return null;}
 if(name==='overset'||name==='underset'||name==='stackrel'){
  const mark=argument(text,next,depth,strict),base=mark&&argument(text,mark.end,depth,strict);if(!base||!base.label.trim())return null;
  const over=name!=='underset';
  return {html:stack(base.html,over?mark.html:'',over?'':mark.html),label:`${base.label} ${mark.label}`,end:base.end,h:(base.h||1)+.7*(mark.h||1),box:true};
 }
 if(Object.hasOwn(XARROWS,name)){
  const below=optional(text,next),from=below?below.end:next,above=group(text,from+/^ */u.exec(text.slice(from,from+64))[0].length);if(!above)return null;
  const top=mathBody(above.body,depth+1),bottom=below&&mathBody(below.body,depth+1);if(!top||below&&!bottom)return null;
  return {html:stack(arrowLine(XARROWS[name]),top.html,bottom?.html??'','xarrow'),label:`${XARROWS[name][0]} ${top.label}${bottom?` ${bottom.label}`:''}`,end:above.end,h:1+(top.html?.7:0)+(bottom?.html?.7:0),box:true};
 }
 if(name==='substack'){
  const inner=group(text,next);if(!inner)return null;
  const lines=table(inner.body).map(row=>trimmed(row.join(' '))).filter(Boolean).map(line=>mathBody(line,depth+1));if(!lines.length||lines.some(line=>!line))return null;
  return {html:`<span class="math-substack">${lines.map(line=>`<span>${line.html}</span>`).join('')}</span>`,label:lines.map(line=>line.label).join(', '),end:inner.end,h:lines.length*.8,box:true};
 }
 // \underbrace{…}_{n}: the brace is an operator whose limit is the label.
 if(name==='underbrace'||name==='overbrace'){
  const body=argument(text,next,depth,strict);if(!body||!body.label.trim())return null;
  const under=name==='underbrace',brace=hbrace(under,body.label);
  return {html:`<span class="math-stack">${under?'':brace}<span class="math-stack-main"><span class="math-stack-base">${body.html}</span>${under?brace:''}</span></span>`,label:body.label,end:body.end,h:(body.h||1)+.5,box:true,op:'limits',limits:true};
 }
 if(name==='boxed'||name==='fbox'){const body=argument(text,next,depth,strict);if(!body)return null;return {html:`<span class="math-boxed">${body.html}</span>`,label:body.label,end:body.end,h:(body.h||1)+.25,box:true};}
 if(name==='tag'){
  const starred=text[next]==='*',inner=group(text,starred?next+1:next),body=inner&&mathBody(inner.body,depth+1);if(!body)return null;
  return {html:`<span class="math-tag">${starred?body.html:`(${body.html})`}</span>`,label:starred?` ${body.label}`:` (${body.label})`,end:inner.end};
 }
 if(name==='bmod')return {html:' <span class="math-mathrm">mod</span> ',label:' mod ',end:next};
 if(name==='pmod'||name==='pod'||name==='mod'){
  const body=argument(text,next,depth,strict);if(!body)return null;
  const word=name==='pod'?'':'<span class="math-mathrm">mod</span> ',spoken=name==='pod'?'':'mod ';
  return {html:name==='mod'?`\u2002${word}${body.html}`:`\u2002(${word}${body.html})`,label:name==='mod'?` ${spoken}${body.label}`:` (${spoken}${body.label})`,end:body.end};
 }
 if(name==='not'){
  const target=atom(text,next,depth+1);if(!target||!target.label)return null;const sign=NEGATED[target.label];
  return {html:sign?escape(sign):`${target.html}\u0338`,label:sign??`không ${target.label}`,end:target.end};
 }
 if(name==='ce'||name==='pu'){const inner=group(text,next),body=inner&&(name==='ce'?chemical:units)(inner.body,depth+1);return body?{...body,end:inner.end}:null;}
 // Bookkeeping that prints nothing; \textcolor and \colorbox print their body.
 if(name==='label'||name==='color'||name==='hspace'||name==='vspace'){const inner=group(text,text[next]==='*'?next+1:next);return inner&&{html:name==='hspace'?' ':'',label:'',end:inner.end,silent:true};}
 if(name==='textcolor'||name==='colorbox'){const color=group(text,next),body=color&&argument(text,color.end,depth,strict);return body?{...body,end:body.end}:null;}
 if(name==='phantom'||name==='hphantom'||name==='vphantom'){const body=argument(text,next,depth,strict);return body&&{html:name==='vphantom'?'':`<span class="math-phantom" aria-hidden="true">${body.html}</span>`,label:'',end:body.end,silent:true};}
 if(ignored.has(name))return {html:'',label:'',end:next,silent:true,...(name==='displaystyle'?{style:true}:/style$/u.test(name)?{style:false}:{})};
 if(functions.has(name)){
  const limits=LIMITS_AFTER.exec(text.slice(named,named+16));
  return {html:`<span class="math-mathrm">${FUNCTION_NAMES[name]??name}</span>`,label:` ${name} `,end:limits?named+limits[0].length:named,...(LIMITS.has(name)?{op:'limits'}:{}),...(limits?{limits:!limits[1]}:{})};
 }
 if(OPERATORS.has(name)){
  const limits=LIMITS_AFTER.exec(text.slice(named,named+16)),sign=symbols[name];
  return {html:display?`<span class="math-bigop">${sign}</span>`:sign,label:sign,end:limits?named+limits[0].length:strict?named:next,op:INTEGRALS.has(name)?'integral':'limits',h:display?1.4:1,...(limits?{limits:!limits[1]}:{})};
 }
 if(Object.hasOwn(symbols,name))return {html:escape(symbols[name]),label:symbols[name],end:strict||!(binding.has(name)||/\p{Script=Greek}/u.test(symbols[name]))?named:next,silent:!symbols[name]};
 report(`\\${name}`);return null;
}
// \left…\right round a body: a lone environment without fences of its own takes them as its own (one brace for a
// system); a 2-D body gets fences stretched to it; anything else is printed with the plain delimiters.
function fenced(body,left,right,only=false){
 const h=body.h||1;
 if(only&&body.env&&!body.env.own)return {...body,html:`<span class="math-env math-env-${body.env.kind}">${fence(left,h)}${body.env.grid}${fence(right,h,true)}</span>`,label:`${left}${body.label}${right}`};
 if(h>1.3)return {html:`<span class="math-fenced">${fence(left,h)}<span class="math-fenced-body">${body.html}</span>${fence(right,h,true)}</span>`,label:`${left}${body.label}${right}`,h:h+.1,box:true};
 return {html:escape(left)+body.html+escape(right),label:left+body.label+right,h};
}
// The rows (top-level \\, its optional [length] skipped) and cells (top-level &) of an environment's body; braces and
// inner environments are skipped whole, and an escaped \& or a command is never a separator. In a formula's own rows
// (implicit: no environment round them) \\name of a command this renderer knows is that command with its backslash
// doubled (JSON or OCR escaping), as command() reads it, not a row break before plain letters.
function table(body,implicit=false){
 const {braces,starts}=structure(body),rows=[[]];let start=0,i=0;
 while(i<body.length){
  const c=body[i];
  if(c==='{'){const close=braces.get(i);i=close===undefined?i+1:close+1;continue;}
  if(c==='&'){rows.at(-1).push(body.slice(start,i));start=++i;continue;}
  if(c!=='\\'){i++;continue;}
  const env=starts.get(i);if(env&&env.close>=0){i=env.end;continue;}
  if(body[i+1]!=='\\'){i+=2;continue;}
  if(implicit){const name=/^[A-Za-z]+/u.exec(body.slice(i+2,i+42));if(name&&KNOWN.has(name[0])){i+=2+name[0].length;continue;}}
  rows.at(-1).push(body.slice(start,i));rows.push([]);i+=2;
  i+=/^\*?(?:\s*\[\s*[+\-]?(?:\d+\.?\d*|\.\d+)\s*(?:pt|em|ex|mm|cm|in|bp|pc|mu|dd|sp)\s*\])?/u.exec(body.slice(i,i+40))[0].length;start=i;
 }
 rows.at(-1).push(body.slice(start));return rows;
}
// The rules that lead a row (\hline, \hdashline, \cline{2-3}), each read as [all, kind, first column, last column].
const RULES=/^(?:\s*\\(?:hline|hdashline|cline\s*\{[^{}]*\}))+/u,RULE=/\\(hline|hdashline|cline)\s*(?:\{\s*(\d{1,3})\s*-\s*(\d{1,3})\s*\})?/gu;
// One cell: drawn, or, holding TeX that cannot be drawn, its source as written (its own environments still drawn).
function cellNode(source,depth,display){
 const before=named,node=mathBody(source,depth,display);if(node)return node;
 printedAsWritten(source,before);
 return {html:verbatim(source,depth,display),label:source,h:1};
}
// An array's column spec: alignments (p{…} and X columns are left-aligned) and the rules between columns, by place
// (before column j; after the last at the column count): | a rule, || two, : a dashed one.
function columnSpec(spec){
 const aligns=[],rules=new Map(),full=spec.replace(/\*\{(\d{1,2})\}\{([^{}]*)\}/gu,(all,count,part)=>part.repeat(Math.min(20,Number(count))));
 for(let i=0;i<full.length;i++){
  const c=full[i];
  if(c==='|'||c===':'){rules.set(aligns.length,(rules.get(aligns.length)??'')+c);continue;}
  if(c==='l'||c==='c'||c==='r')aligns.push(c);else if(c==='p'||c==='m'||c==='b'||c==='X')aligns.push('l');else if(c!=='@'&&c!=='!'&&c!=='>'&&c!=='<')continue;
  // The group after p, m, b (a width) or @, !, >, < (inserted material) is never a column.
  if(full[i+1]==='{'){const close=structure(full).braces.get(i+1);if(close!==undefined)i=close;}
 }
 return {aligns,rules};
}
function environment(text,index,depth,display){
 const env=structure(text).starts.get(index);
 if(!env||env.close<0){report(`\\begin{${env?.name??/^\\+begin\s*\{([^{}]{0,32})\}/u.exec(text.slice(index,index+48))?.[1]??''}}`);return null;}
 // The same environment is drawn once per rendering, even when a cell or formula around it is shown as written; one
 // drawn while its piece is too deep is not kept, as the next piece may draw it whole.
 const source=text.slice(env.at,env.end),key=`${display?1:0}${depth>23?'!':''}${source}`;
 let node=drawn.get(key);
 if(node===undefined){node=drawEnvironment(env.name,text.slice(env.body,env.close),env.doubled,depth,display);if(!deep)drawn.set(key,node);}
 return node&&{...node,end:env.end};
}
function drawEnvironment(name,raw,doubled,depth,display){
 if(deep||depth>23)return tooDeep();
 const spec=ENVIRONMENTS[name];if(!spec)report(`\\begin{${name}}`);
 // Written with every backslash doubled (\\begin{cases} … \\\\ …): halved first.
 let body=doubled?raw.replace(/\\{2,}/gu,run=>'\\'.repeat(Math.ceil(run.length/2))):raw,columns=null;
 // Arguments right after \begin{name}: a [t]/[b] position, array's column spec, alignedat's pair count; for an
 // environment not drawn as a grid, a leading group that looks like a column spec ({|c|c|}) is one too.
 const position=spec&&/^\s*\[[tbc]\]/u.exec(body);if(position)body=body.slice(position[0].length);
 const lead=/^\s*/u.exec(body)[0].length,argument_=group(body,lead);
 if(argument_&&(spec?.columns||spec?.count||!spec&&/^[lcrpmbX|@!*:.\s\d{}]*$/u.test(argument_.body)&&/[lcrX]/u.test(argument_.body))){if(spec?.columns||!spec)columns=columnSpec(argument_.body);body=body.slice(argument_.end);}
 // The rules leading a row stand above it; those after the last \\ close the table (lines: one list per row, and one
 // for below the last).
 const rows=[],lines=[];let above=[];
 for(const row of table(body)){
  const lead=RULES.exec(row[0]),cells=row.map((cell,j)=>trimmed(j||!lead?cell:cell.slice(lead[0].length)));
  if(lead)for(const rule of lead[0].matchAll(RULE))above.push(rule);
  if(cells.some(Boolean)){rows.push(cells);lines.push(above);above=[];}
 }
 if(!rows.length)rows.push(['']),lines.push([]);
 lines.push(above);
 return drawGrid(name,rows,depth,display,spec?columns:null,lines);
}
// Rows of cells as a grid with the environment's fences; an environment this renderer does not know (or a huge one)
// is drawn row by row, its cells separated by a space. In a ruled table each rule is an item of a track of its own,
// a column rule through every row and an \hline across every column, so the lines meet and never break between rows
// or stop at a short cell; every cell then keeps half a column gap on each side, as TeX's \arraycolsep.
function drawGrid(name,rows,depth,display,columns=null,lines=null){
 const spec=ENVIRONMENTS[name],cells=rows.map(row=>row.map(source=>cellNode(source,depth+1,!!spec?.display)));
 let width=1,count=0,h=.1;for(const row of cells){width=Math.max(width,row.length);count+=row.length;h+=row.reduce((most,cell)=>Math.max(most,cell.h||1),1)*1.25;}
 const label=cells.map(row=>row.map(cell=>cell.label.trim()).filter(Boolean).join(', ')).join('; ');
 if(!spec||width>100||count>4000)return {html:`<span class="math-env math-env-unknown">${cells.map(row=>`<span class="math-row">${row.map(cell=>cell.html).filter(Boolean).join(' ')}</span>`).join('')}</span>`,label,h,box:true};
 const rules=columns?.rules??new Map(),ruled=rules.size>0||!!lines?.some(line=>line.length);
 const align=j=>spec.align==='rl'?(j%2?'l':'r'):columns?.aligns[j]??spec.align,gap=j=>ruled?' math-pad':!j?'':spec.align==='rl'?(j%2?'':' math-gap2'):' math-gap';
 let grid='',tracks=width;
 if(!ruled)for(const row of cells)for(let j=0;j<width;j++)grid+=`<span class="math-cell-${align(j)}${gap(j)}">${row[j]?.html??''}</span>`;
 else{
  // at: the grid column of each column of cells; r: the next grid row.
  const at=[],vertical=[];let c=1,r=1,drawnRules='';
  for(let j=0;j<=width;j++){if(rules.has(j))vertical.push([c++,rules.get(j)]);if(j<width)at[j]=c++;}
  for(let i=0;i<=cells.length;i++){
   const line=lines?.[i]??[],full=line.filter(rule=>rule[1]!=='cline');
   if(line.length){
    if(full.length)drawnRules+=`<span class="math-hrule${full.length>1?' math-rule2':''}${full.some(rule=>rule[1]==='hdashline')?' math-dash':''}" style="grid-area:${r}/1/${r+1}/${c}"></span>`;
    for(const [,rule,first,last] of line)if(rule==='cline'&&Number(first)>=1&&Number(first)<=Number(last)&&Number(last)<=width)drawnRules+=`<span class="math-hrule" style="grid-area:${r}/${at[first-1]}/${r+1}/${at[last-1]+1}"></span>`;
    r++;h+=.3;
   }
   if(i<cells.length){for(let j=0;j<width;j++)grid+=`<span class="math-cell-${align(j)}${gap(j)}" style="grid-area:${r}/${at[j]}">${cells[i][j]?.html??''}</span>`;r++;}
  }
  for(const [track,marks] of vertical)drawnRules+=`<span class="math-vrule${marks.length>1?' math-rule2':''}${marks.includes(':')?' math-dash':''}" style="grid-area:1/${track}/${r}/${track+1}"></span>`;
  grid+=drawnRules;tracks=c-1;
 }
 const kind=name.replace('*',''),html=`<span class="math-grid" style="grid-template-columns:repeat(${tracks},auto)">${grid}</span>`;
 return {html:`<span class="math-env math-env-${kind}">${fence(spec.left,h)}${html}${fence(spec.right,h,true)}</span>`,label,h,box:true,env:{kind,grid:html,own:!!(spec.left||spec.right)}};
}
// Where text ends without its trailing spaces (from start), but for a space after an odd run of backslashes (\ , TeX's
// control space): it is part of the formula, and dropping it would leave a lone backslash, printed as written. The run
// is read once.
function spaceEnd(text,start){
 let end=text.length;while(end>start&&SPACE.test(text[end-1]))end--;
 let run=end;while(run>start&&text[run-1]==='\\')run--;return (end-run)%2&&end<text.length?end+1:end;
}
// A cell, a row or a \substack line without the spaces round it.
function trimmed(text){const start=text.length-text.trimStart().length;return text.slice(start,spaceEnd(text,start));}
// The body of a delimited formula without the line breaks just inside its delimiters (\[ alone on its line, the system
// on the next), which TeX ignores: kept, they would be blank lines in a display formula, whose white-space is pre-wrap.
// Spaces with no line break stay as written.
function unbroken(body){
 let start=0;while(start<body.length&&SPACE.test(body[start]))start++;const end=spaceEnd(body,start);
 return body.slice(body.lastIndexOf('\n',start-1)>=0?start:0,body.indexOf('\n',end)>=0?end:body.length);
}
// A delimited formula: a body, or rows and columns when it holds a top-level & or \\ outside any environment (TeX
// would refuse it; it is set as aligned rows rather than printed with its scaffolding).
function formula(body,display){
 deep=false;const rows=table(body,true);if(rows.length===1&&rows[0].length===1)return mathBody(body,0,display);
 const kept=rows.map(row=>row.map(trimmed)).filter(row=>row.some(Boolean));
 return drawGrid(rows.some(row=>row.length>1)?'aligned':'gathered',kept.length?kept:[['']],0,display);
}
// The whitelisted (or not) environments of a text that stand on their own, each with the \left…\right round it.
function* environmentUnits(text,depth,display){
 const {envs,fences}=structure(text);let after=0;
 for(const env of envs){
  if(env.at<after||env.close<0)continue;
  const node=environment(text,env.at,depth,display);if(!node)continue;
  const left=LEFT_BEFORE.exec(text.slice(Math.max(after,env.at-32),env.at)),right=RIGHT_AFTER.exec(text.slice(env.end,env.end+32));
  if(left&&right){const start=env.at-left[0].length,close=env.end+right[0].length-right[0].trimStart().length;if(fences.get(start)===close){yield {start,end:env.end+right[0].length,html:fenced(node,FENCES[left[1]],FENCES[right[1]],true).html};after=env.end+right[0].length;continue;}}
  yield {start:env.at,end:env.end,html:node.html};after=env.end;
 }
}
// Source shown as written (a formula, or a cell, holding TeX this renderer does not know), except that its
// environments are still drawn: their \begin, & and \\ never reach the page.
function verbatim(text,depth=0,display=false){
 let html='',start=0;
 for(const unit of environmentUnits(text,depth,display)){html+=escape(text.slice(start,unit.start))+unit.html;start=unit.end;}
 return html+escape(text.slice(start));
}
function atom(text,index,depth=0,display=false){
 if(deep||depth>24)return tooDeep();if(index>=text.length)return null;
 const bracket=group(text,index);if(bracket){const body=mathBody(bracket.body,depth+1,display);return body&&{...body,end:bracket.end};}
 if(text[index]==='\\')return command(text,index,depth,false,display);
 const character=String.fromCodePoint(text.codePointAt(index));if(/[{}_^$]/u.test(character))return null;
 // Inside math a hyphen is a minus sign, an apostrophe a prime and ~ a non-breaking space, as TeX prints them.
 const shown={'-':'−',"'":'′','~':'\u00a0'}[character]??character;
 return {html:escape(shown),label:shown,end:index+character.length};
}
// ^\circ, ^{\circ}, ^∘ and ^° are a degree sign: the end of the superscript, else 0.
function degreeEnd(text,index){const m=/^(?:\\circ(?![A-Za-z])|[∘°]|\{\s*(?:\\circ|[∘°])\s*\})/u.exec(text.slice(index,index+16));return m?index+m[0].length:0;}
function scripts(text,index,depth=0){
 let html='',label='',end=index;const parts=[];
 while(text[end]==='_'||text[end]==='^'){
  const type=text[end++]==='_'?'sub':'sup',degree=type==='sup'&&degreeEnd(text,end);
  if(degree){parts.push({type,degree:true});html+='°';label+=' độ';end=degree;continue;}
  const value=atom(text,end,depth+1);if(!value)return null;
  parts.push({type,node:value});html+=`<${type}>${value.html}</${type}>`;label+=` ${type==='sub'?'chỉ số dưới':'chỉ số trên'} ${value.label}`;end=value.end;
 }
 return {html,label,end,parts};
}
// Scripts after a base: a big operator's limits stacked under and over it in display style (or after \limits), a
// subscript and a superscript stacked at the side as TeX sets them, one script (or a longer chain) as written.
function withScripts(base,suffix,display){
 const parts=suffix.parts,h=base.h||1;if(!parts.length)return {...base,end:suffix.end};
 const sub=parts.find(part=>part.type==='sub'),sup=parts.find(part=>part.type==='sup'),pair=parts.length===2&&!!sub&&!!sup&&!parts.some(part=>part.degree);
 if(base.op&&(parts.length===1&&!parts[0].degree||pair)&&(base.limits??(display&&base.op==='limits')))return {html:stack(base.html,sup?.node.html??'',sub?.node.html??'',base.op==='integral'?'int':''),label:base.label+suffix.label,end:suffix.end,h:h+.75*((sup?1:0)+(sub?1:0))+(base.op==='integral'?.3:0),box:true};
 if(pair)return {html:`${base.html}<span class="math-subsup"><sub>${sub.node.html}</sub><sup>${sup.node.html}</sup></span>`,label:base.label+suffix.label,end:suffix.end,h:Math.max(h,1.4),box:base.box};
 return {html:base.html+suffix.html,label:base.label+suffix.label,end:suffix.end,h:h+.15,box:base.box};
}
// The class of letters a combining arrow may sit on; the end of such a run is found once, so a long run is linear.
const VECTOR_LETTER=/[\p{Script=Latin}\p{Script=Greek}\p{N}\u{1D400}-\u{1D7FF}'′]/u;
function letterRun(text,index){let i=index;while(i<text.length){const c=String.fromCodePoint(text.codePointAt(i));if(!VECTOR_LETTER.test(c))break;i+=c.length;}return i;}
function mathBody(text,depth=0,display=false){
 if(deep||depth>24)return tooDeep();
 let html='',label='',h=1,box=false,index=0,run=0;
 while(index<text.length){
  let value=null;
  // A script with nothing before it ({}^{14}_{6}C, ^{14}C) has an empty base.
  if(text[index]==='_'||text[index]==='^')value={html:'',label:'',end:index};
  else if(index>=run){
   // A combining arrow carries explicit semantics even inside a math delimiter.
   run=letterRun(text,index);
   if(run>index&&text[run]==='\u20d7'){const name=text.slice(index,run);value={html:vector(escape(name),name),label:`vectơ ${name}`,end:run+1,h:1.25};}
  }
  value??=atom(text,index,depth,display);
  if(!value)return null;
  if(value.style!==undefined)display=value.style;
  const suffix=scripts(text,value.end,depth);if(!suffix)return null;
  const node=withScripts(value,suffix,display);
  html+=node.html;label+=node.label;h=Math.max(h,node.h||1);box||=!!node.box;index=suffix.end;
 }
 return {html,label,h,box};
}
// \ce{…} (mhchem), the part textbooks use: coefficients (2H2O, 1/2O2), counts after an element or a bracket (H2SO4,
// Fe(OH)3, (C6H10O5)n), charges (SO4^2-, NH4+, Fe^{3+}), isotopes (^{14}_{6}C), hydrates (CuSO4.5H2O), states
// ((aq), (s)), arrows (->, <-, <->, <=>, with [above][below] labels), ^ for a gas and v for a precipitate, and TeX
// inside ($\Delta$, \text{…}, \alpha). Anything else is kept as written.
const CHEM_ARROWS=[['<=>>','⇌','xrightleftharpoons'],['<<=>','⇌','xrightleftharpoons'],['<-->','⟷','xleftrightarrow'],['<=>','⇌','xrightleftharpoons'],['<->','↔','xleftrightarrow'],['->','→','xrightarrow'],['<-','←','xleftarrow']];
function chemical(body,depth){
 if(deep||depth>24)return tooDeep();
 let html='',label='',h=1,i=0;
 while(i<body.length){
  const c=String.fromCodePoint(body.codePointAt(i));
  if(SPACE.test(c)){while(i<body.length&&SPACE.test(body[i]))i++;html+=' ';label+=' ';continue;}
  const arrow=CHEM_ARROWS.find(([sign])=>body.startsWith(sign,i));
  if(arrow){
   i+=arrow[0].length;
   const over=body[i]==='['?optional(body,i):null,under=over&&body[over.end]==='['?optional(body,over.end):null;
   if(over){
    const strip=value=>value.trim().replace(/^\{([\s\S]*)\}$/u,'$1'),above=chemical(strip(over.body),depth+1),below=under&&chemical(strip(under.body),depth+1);if(!above||under&&!below)return null;
    html+=stack(arrowLine(XARROWS[arrow[2]]),above.html,below?.html??'','xarrow');label+=`${arrow[1]} ${above.label}${below?` ${below.label}`:''}`;h=Math.max(h,1.7+(below?.7:0));i=(under||over).end;
   }else{html+=arrow[1];label+=arrow[1];}
   continue;
  }
  if((c==='^'||c==='v')&&(!i||SPACE.test(body[i-1]))&&(i+1>=body.length||SPACE.test(body[i+1]))){html+=c==='^'?'↑':'↓';label+=c==='^'?'↑':'↓';i++;continue;}
  if(c==='$'){const close=body.indexOf('$',i+1),math=close>i&&mathBody(body.slice(i+1,close),depth+1);if(!math)return null;html+=math.html;label+=math.label;h=Math.max(h,math.h||1);i=close+1;continue;}
  if(c==='\\'){const value=command(body,i,depth+1);if(!value)return null;html+=value.html;label+=value.label;h=Math.max(h,value.h||1);i=value.end;continue;}
  if(/[A-Za-z0-9([^_]/u.test(c)){const part=chemFormula(body,i,depth);if(part){html+=part.html;label+=part.label;i=part.end;continue;}}
  html+=escape(c);label+=c;i+=c.length;
 }
 return {html:`<span class="math-chem">${html}</span>`,label,h,box:true};
}
function chemFormula(body,start,depth){
 let i=start,html='',label='',count=false,formula=false,sub='',sup='';
 const flush=()=>{html+=sub&&sup?`<span class="math-subsup"><sub>${sub}</sub><sup>${sup}</sup></span>`:sub?`<sub>${sub}</sub>`:sup?`<sup>${sup}</sup>`:'';sub='';sup='';};
 // A coefficient: digits (2, 1/2, 0.5) or one lowercase letter (nH2O) before the formula.
 const lead=/^(?:\d+(?:[./]\d+)?|[a-z])(?=[A-Z([])/u.exec(body.slice(i,i+12));if(lead){html+=escape(lead[0]);label+=lead[0];i+=lead[0].length;}
 while(i<body.length){
  const c=body[i];
  if(c>='A'&&c<='Z'){flush();const m=/^[A-Z][a-z]*/u.exec(body.slice(i,i+12))[0];html+=m;label+=m;i+=m.length;count=formula=true;continue;}
  if(c>='a'&&c<='z'){
   // (CH2)n: a letter after a closing bracket is its count.
   if(count&&/[)\]]/u.test(body[i-1])&&!/[a-z]/u.test(body[i+1]??'')){sub+=c;label+=c;i++;continue;}
   flush();const m=/^[a-z]+/u.exec(body.slice(i,i+24))[0];html+=m;label+=m;i+=m.length;count=false;formula=true;continue;
  }
  if(c>='0'&&c<='9'){const m=/^\d+/u.exec(body.slice(i,i+24))[0];if(count)sub+=m;else{flush();html+=m;}label+=m;i+=m.length;formula=true;continue;}
  if(c==='('||c==='['){flush();const state=c==='('&&/^\((?:aq|s|l|g|sln|conc|dil)\)/u.exec(body.slice(i,i+7));const shown=state?state[0]:c;html+=shown;label+=shown;i+=shown.length;count=false;formula=!!state;continue;}
  if(c===')'||c===']'){flush();html+=c;label+=c;i++;count=formula=true;continue;}
  if(c==='^'||c==='_'){
   // t^\circ, t^{\circ}: the degree sign of a temperature (heating over an arrow), not a charge; t^o is t with a raised o.
   const degree=c==='^'&&degreeEnd(body,i+1);if(degree){flush();html+='°';label+='°';i=degree;continue;}
   const braced=group(body,i+1),plain=braced?null:(c==='^'?/^(?:\d*[+\-−]|\d+|[a-z])/u:/^(?:\d+|[a-z])/u).exec(body.slice(i+1,i+12));
   let value;
   if(braced){const charge=/^\s*(\d*[+\-−]|\d+)\s*$/u.exec(braced.body);value=charge?escape(charge[1].replace('-','−')):mathBody(braced.body,depth+1)?.html;if(value==null)return null;i=braced.end;}
   else if(plain){value=escape(plain[0].replace('-','−'));i+=1+plain[0].length;}
   else break;
   if(c==='^'){if(sup)flush();sup=value;}else{if(sub)flush();sub=value;}label+=c==='^'?`^${value}`:`_${value}`;count=false;continue;
  }
  // A sign right after a formula, before its end, is its charge (OH-, NH4+, Na+ + Cl-).
  if((c==='+'||c==='-'||c==='−')&&formula&&(i+1>=body.length||/[\s)\]},;^]/u.test(body[i+1]))){sup+=c==='+'?'+':'−';label+=c;i++;continue;}
  // CuSO4.5H2O, CuSO4*5H2O: a hydrate's dot.
  if((c==='.'||c==='*'||c==='·')&&/[0-9A-Z(]/u.test(body[i+1]??'')){flush();html+='·';label+='·';i++;count=formula=false;continue;}
  break;
 }
 flush();
 return i>start?{html,label,end:i}:null;
}
// \pu{…}: a number (1.2, 3,5, 1.2e3) and units with their powers (kJ mol-1, m/s2); . or * between units is ·.
function units(body,depth){
 let html='',label='',i=0;
 while(i<body.length){
  const c=String.fromCodePoint(body.codePointAt(i));
  if(SPACE.test(c)){while(i<body.length&&SPACE.test(body[i]))i++;html+=' ';label+=' ';continue;}
  if(c==='\\'){const value=command(body,i,depth+1);if(!value)return null;html+=value.html;label+=value.label;i=value.end;continue;}
  if(c==='^'){const degree=degreeEnd(body,i+1);if(degree){html+='°';label+='°';i=degree;continue;}}
  const number=!i||!/[A-Za-zµΩ]/u.test(body[i-1])?/^[+\-−]?\d+(?:[.,]\d+)?(?:[eE]([+\-−]?\d+))?/u.exec(body.slice(i,i+40)):null;
  if(number){const [all,power]=number,mantissa=all.slice(0,power===undefined?all.length:all.search(/[eE]/u)).replace('-','−');html+=escape(mantissa)+(power===undefined?'':`×10<sup>${escape(power.replace('-','−'))}</sup>`);label+=all;i+=all.length;continue;}
  const unit=/^[A-Za-zµΩÅ%℃°]+/u.exec(body.slice(i,i+24));
  if(unit){
   html+=escape(unit[0]);label+=unit[0];i+=unit[0].length;
   const power=/^(?:\^?\{\s*([+\-−]?\d+)\s*\}|\^?([+\-−]?\d+))/u.exec(body.slice(i,i+12));if(power){const value=(power[1]??power[2]).replace('-','−');html+=`<sup>${escape(value)}</sup>`;label+=`^${value}`;i+=power[0].length;}
   continue;
  }
  if((c==='.'||c==='*')&&/[A-Za-zµΩ]/u.test(body[i+1]??'')){html+='·';label+='·';i++;continue;}
  html+=escape(c);label+=c;i+=c.length;
 }
 return {html:`<span class="math-unit">${html}</span>`,label,h:1,box:true};
}
// The bare (path-unaware) element formula of plain text: H_2O, SO_4^{2-}.
function elements(formula){
 let html='';
 for(const part of formula.matchAll(/([A-Z][a-z]?)|_\{?(\d+)\}?|\^\{?(\d*[+\-−])\}?|([()])/gu)){
  if(part[1]){if(!ELEMENTS.has(part[1]))return null;html+=part[1];}else if(part[2])html+=`<sub>${part[2]}</sub>`;else if(part[3])html+=`<sup>${escape(part[3].replace('-','−'))}</sup>`;else html+=part[4];
 }
 return `<span class="math-inline math-chem">${html}</span>`;
}
function vectorTokens(text){
 const tokens=[];let end=0;
 for(const match of text.matchAll(vectorStarts)){
  if(match.index<end||match[1]?.length===match[0].length)continue;
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
function scripted(text,index,base){const suffix=plainScripts(text,index+base.length,0,base);return suffix&&{end:suffix.end,html:`<span class="math-inline">${escape(base)}${suffix.html}</span>`};}
// Plain-text scripts take a whole number (x^10, 10^-3), a braced group, a degree sign (90^\circ) or one lowercase letter
// that ends the word, as a subscript or after another script (S_n, C_n^k); anything else is left as written. A letter
// under itself (u_u, o_o, x_x) and O_o are emoticons, as T_T and ^_^ are, not subscripts; a capital over its own small
// letter otherwise is one (F_f, the friction force of physics textbooks; N_n).
const DIGITS=/\d+/uy,SIGNED=/[+\-−]?\d+/uy,LETTER=/[a-z](?![\p{L}\p{N}_])/uy;
function plainScripts(text,index,depth=0,base=''){
 const parts=[];let html='',label='',end=index;
 while(text[end]==='_'||text[end]==='^'){
  const type=text[end]==='_'?'sub':'sup',braced=group(text,end+1),degree=type==='sup'&&degreeEnd(text,end+1);let value=null;
  if(degree){parts.push({type,degree:true});html+='°';label+=' độ';end=degree;continue;}
  if(braced){const body=mathBody(braced.body,depth+1);if(!body)break;value={...body,end:braced.end};}
  else{
   const pattern=type==='sup'?SIGNED:DIGITS;pattern.lastIndex=end+1;const number=pattern.exec(text);
   if(number){const shown=number[0].replace('-','−');value={html:escape(shown),label:shown,end:end+1+number[0].length};}
   else if(type==='sub'||parts.length){LETTER.lastIndex=end+1;const letter=LETTER.exec(text);if(letter&&(parts.length||letter[0]!==base&&!(base==='O'&&letter[0]==='o')))value={html:letter[0],label:letter[0],end:end+2};}
  }
  if(!value)break;
  parts.push({type,node:value});html+=`<${type}>${value.html}</${type}>`;label+=` ${type==='sub'?'chỉ số dưới':'chỉ số trên'} ${value.label}`;end=value.end;
 }
 return parts.length?withScripts({html:'',label:'',end:index},{html,label,end,parts},false):null;
}
// Command names this renderer knows. A backslash chain holding any other name ("Files\App\log", "D:\data\in") is a
// Windows path, never TeX: none of its \log, \in, \to, \max is rendered.
const KNOWN=new Set([...Object.keys(symbols),...functions,...Object.keys(fonts),...Object.keys(texts),...Object.keys(accents),...ignored,...Object.keys(OVER_ARROWS),...Object.keys(XARROWS),...Object.keys(LETTER_STYLES),...HANDLED]);
// The whitespace-delimited word around index: notation inside a URL, an e-mail address or a path is kept as written
// (https://example.com/a_1/b^2, C:\Users\Lan\max\deg, /home/an/x_1). Found once per word, so a long text with many
// formulas stays linear.
const linked=word=>/:\/\/|^www\.|^[^@\s]+@[^@\s]+\.[A-Za-z]/iu.test(word);
const pathLike=word=>/^[A-Za-z]:\\|^\\\\[A-Za-z]/u.test(word)||[...word.matchAll(/\\+([A-Za-z]+)?/gu)].some(m=>m[1]&&!KNOWN.has(m[1]));
const FILE_PATH=/^(?:~|\.{1,2})?\/[^\s/]|[^\s/]\/[^\s/]*\//u;
function wordAround(text,index){
 let start=index,end=index;while(start>0&&!SPACE.test(text[start-1]))start--;while(end<text.length&&!SPACE.test(text[end]))end++;
 const word=text.slice(start,end),memo={};
 return {end,text:word,get linked(){return memo.linked??=linked(word);},get path(){return memo.path??=pathLike(word);},get files(){return memo.files??=this.path||FILE_PATH.test(word);}};
}
// bare: OCR and PDF text, where a model may drop the \( \) round a command or an environment and scripts are written
// x^2, a_1, S_n. The general reader's text is translated with its math already delimited: there only explicit vectors
// and element formulas are rendered outside delimiters, so code (2^3 as XOR), identifiers and LaTeX tutorials stay as
// written.
function plainTokens(text,bare=true){
 const tokens=[];let end=0,word=null;
 for(const match of bareMatches(text)){
  if(match.index<end)continue;let token=null;
  if(!word||match.index>=word.end)word=wordAround(text,match.index);
  if(word.linked)continue;
  if(match[1]){
   if(word.path||!bare&&!/^\\+(?:vec|overrightarrow)$/u.test(match[1]))continue;
   // A command that prints nothing (\displaystyle, \limits, \!) is dropped from OCR text, never shown as written.
   const value=command(text,match.index,0,true),suffix=value&&scripts(text,value.end);
   if(suffix){const node=withScripts(value,suffix,false);if(node.html||bare&&value.silent)token={end:suffix.end,html:suffix.parts.length||value.box?`<span class="math-inline">${node.html}</span>`:node.html};}
  }
  else if(match[2]){const label=match[2].slice(0,-1),suffix=scripts(text,match.index+match[2].length);if(suffix)token={end:suffix.end,html:suffix.html?`<span class="math-inline">${vector(escape(label),label)}${suffix.html}</span>`:vector(escape(label),label)};}
  else if(match[3]){const html=match[3].includes('_')&&!(!bare&&/[=/\\&]/u.test(word.text))&&elements(match[3]);if(html)token={end:match.index+match[3].length,html};else if(bare&&!word.files){const base=scriptBaseAt(text,match.index);if(base)token=scripted(text,match.index,base[0]);}}
  else if(match[4]){if(bare&&!word.files)token=scripted(text,match.index,match[4]);}
  else if(match[5]){if(bare&&!word.files)token={end:match.index+2,html:escape(escapes[match[5][1]])};}
  else if(match[6]&&bare&&!word.files)token={end:match.index+match[6].length,html:'°'};
  if(token){tokens.push({start:match.index,...token});end=token.end;}
 }
 return tokens;
}
// The whitelisted environments of a text written without delimiters and closed, in order (nested ones too).
const closedEnvironments=text=>text.includes('begin')?structure(text).envs.filter(env=>env.close>=0&&Object.hasOwn(ENVIRONMENTS,env.name)):[];
function plainPieces(text,bare){
 const pieces=[];let start=0;deep=false;
 const plain=part=>{let at=0;for(const token of plainTokens(part,bare)){if(token.start>at)pieces.push({raw:part.slice(at,token.start)});pieces.push({html:token.html,joins:true});at=token.end;}if(at<part.length)pieces.push({raw:part.slice(at)});};
 // OCR text may hold an environment without delimiters; it is drawn whole, its \left…\right with it.
 if(bare&&text.includes('begin'))for(const unit of environmentUnits(text,0,false)){plain(text.slice(start,unit.start));pieces.push({html:unit.html,joins:true});start=unit.end;}
 plain(text.slice(start));return pieces;
}
export function renderMathText(value,{bare=true}={}){
 const text=String(value??''),pieces=[];let start=0;
 try{
  // OCR text may hold a whitelisted environment without delimiters, drawn whole by plainPieces; the $…$ of its cells
  // are its own.
  const bareEnvironments=bare?closedEnvironments(text):[];
  for(const match of formulas(text,bareEnvironments)){
   pieces.push(...plainPieces(text.slice(start,match.index),bare));
   const source=match[0],double=source.startsWith('$$'),latex=source.startsWith('\\'),size=latex||double?2:1,display=double||source.startsWith('\\['),before=named,body=formula(unbroken(source.slice(size,-size)),display);
   // TeX this renderer does not know keeps its formula verbatim (its environments still drawn); it is never guessed
   // or silently discarded, and unsupportedMath lists it.
   if(!body)printedAsWritten(source,before);
   pieces.push(body?{html:`<span class="math-${display?'display':'inline'}">${body.html}</span>`,joins:latex}:structure(source).envs.some(env=>env.close>=0)?{html:verbatim(source,0,display)}:{raw:source});start=match.index+source.length;
  }
  pieces.push(...plainPieces(text.slice(start),bare));
 }finally{structures.clear();drawn.clear();deep=false;}
 // A lone hyphen between two TeX formulas ("\(\vec{AA'}\)-\(\vec{CB}\)" from OCR) is a minus sign; next to a word
 // ("\(x\)-axis") or between $…$ pieces it stays as written.
 return pieces.map((piece,i)=>piece.raw==null?piece.html:escape(/^[ \t]*-[ \t]*$/u.test(piece.raw)&&pieces[i-1]?.joins&&pieces[i+1]?.joins?piece.raw.replace('-','−'):piece.raw)).join('');
}
// What of a text's math this renderer prints as written, each once: the commands and environments it cannot draw
// (\foo, \begin{tabular}), and the first characters of each other formula or cell it cannot draw (\(\frac{1}{2\), a
// cell holding \(x\)). A translation holding any deserves a warning before it is exported.
export function unsupportedMath(value,options){const found=new Set();unknown=found;try{renderMathText(value,options);}finally{unknown=null;}return [...found];}
// The delimited formulas of a text as renderMathText finds them, each [start,end): an opener inside a closed bare
// environment belongs to it, and one before an environment holds it with the formula's own rows and columns
// (backend/pdf-block-ocr.js undrawableTex checks the bare text between them).
export function formulaSpans(value){const text=String(value??'');try{return [...formulas(text,closedEnvironments(text))].map(match=>[match.index,match.index+match[0].length]);}finally{structures.clear();}}
export function normalizeVectorMath(value){
 // \\vec (doubled by JSON or OCR) is \vec; each run of backslashes is read once.
 const text=String(value??'').replace(/(\\+)((?:vec|overrightarrow)\b)?/gu,(run,slashes,name)=>name&&slashes.length>1?`\\${name}`:run);
 // A vector over a formula token (\vec{@@PDF_INLINE_1@@}) is not wrapped, as mapBareLatex leaves such commands: as
 // delimited math it would be shielded from translation with the token inside it.
 const normalizePlain=plain=>{let result='',start=0;deep=false;for(const token of vectorTokens(plain)){if(token.notation.includes('@@'))continue;result+=plain.slice(start,token.start)+`\\(${token.notation}\\)`;start=token.end;}return result+plain.slice(start);};
 try{
  // A whitelisted environment written without delimiters is math already, as renderMathText reads it: it is copied as
  // it is (a cell holding \(\vec{a}\) could not be drawn), and the $…$ of its cells are its own.
  const kept=closedEnvironments(text);let result='',start=0,next=0;
  const plain=end=>{for(;next<kept.length&&kept[next].at<end;next++){const env=kept[next];if(env.at<start)continue;result+=normalizePlain(text.slice(start,env.at))+text.slice(env.at,env.end);start=env.end;}result+=normalizePlain(text.slice(start,end));};
  for(const match of formulas(text,kept)){plain(match.index);result+=match[0];start=match.index+match[0].length;}
  plain(text.length);return result;
 }finally{structures.clear();drawn.clear();deep=false;}
}
// The vector's top margin keeps its arrow off the descenders of the line above (line-height 1.08 is tighter than
// the font's content area). A fraction is centred on the text's middle, which puts its bar near the minus height.
// text-indent is inherited: a paragraph's first-line indent must not shift the inside of an inline formula.
// An environment is a row of fences and a grid centred on the text's middle (TeX's math axis); a stack is an
// inline-block whose last line, and so its baseline, is the column holding its base. A subscript with a superscript is
// a two-row grid, whose baseline is its first row's (the superscript's): raised, it puts both where TeX does, and the
// subscript stays first for copied text. Nothing 2-D wraps (nowrap, and overflow-wrap:normal against the PDF text
// box's anywhere, which would squeeze a wide matrix into its box by breaking every cell): the PDF fitting measures each
// as one piece and shrinks the font instead (pdf-box-layout.js). So nothing here scrolls either: the reading views
// scroll a wide formula in their own styles (study-layout-view.js readingStyles, style.css). The copied character of a
// drawn fence or arrow sits on the content's middle, half size and with no line height, so its glyph stays inside the
// piece and never reaches past a box's last line.
export const mathStyles=`.math-vector,.math-over{display:inline-block;position:relative;padding-top:.27em;line-height:1.05;white-space:nowrap;overflow-wrap:normal;margin:.1em .025em 0;text-indent:0}.math-vector{font-style:italic}.math-vector svg,.math-over svg{position:absolute;top:0;left:0;width:100%;height:.25em;overflow:visible}.math-over svg{top:.03em;height:.2em}.math-vector>span,.math-over>span{display:inline-block;line-height:1.05;vertical-align:baseline}.math-inline,.math-display{font-family:inherit}.math-inline sub,.math-inline sup,.math-display sub,.math-display sup,.math-vector sub,.math-vector sup{font-size:.72em;line-height:0}.math-display{display:block;text-align:center;white-space:pre-wrap;text-indent:0}.math-frac{display:inline-block;vertical-align:middle;text-align:center;font-size:.82em;line-height:1.1;margin:0 .08em;white-space:nowrap;overflow-wrap:normal;text-indent:0}.math-frac>span{display:block;padding:0 .12em}.math-frac>.math-den{border-top:.07em solid currentColor}.math-binom>.math-den{border-top:0}.math-sqrt{white-space:nowrap;overflow-wrap:normal}.math-radicand{border-top:.06em solid currentColor;padding:0 .05em;margin-left:-.03em}.math-index{font-size:.6em;vertical-align:.75em;margin-right:-.45em}.math-overline{text-decoration:overline;text-decoration-thickness:.06em;text-decoration-skip-ink:none}.math-underline{text-decoration:underline;text-decoration-thickness:.06em}.math-mathrm,.math-text{font-style:normal}.math-mathbf{font-weight:700;font-style:normal}.math-mathit{font-style:italic}.math-env{display:inline-flex;align-items:stretch;vertical-align:middle;white-space:nowrap;overflow-wrap:normal;text-indent:0;line-height:1.2;margin:.05em .1em}.math-grid{display:grid;align-items:baseline;row-gap:.15em;padding:.08em .12em}.math-cell-l{text-align:left}.math-cell-c{text-align:center}.math-cell-r{text-align:right}.math-gap{padding-left:1em}.math-gap2{padding-left:2em}.math-pad{padding:0 .5em}.math-vrule{align-self:stretch;border:0 solid currentColor;border-left-width:.06em}.math-hrule{align-self:center;border:0 solid currentColor;border-top-width:.06em}.math-vrule.math-rule2{width:.24em;border-right-width:.06em}.math-hrule.math-rule2{height:.24em;border-bottom-width:.06em}.math-dash{border-style:dashed}.math-copy{flex:none;display:flex;justify-content:center;align-self:center;width:0;font-size:.5em;line-height:0;color:transparent}.math-fence{position:relative;display:block;flex:none}.math-fence>svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}.math-fence-text{align-self:center}.math-env-smallmatrix,.math-env-subarray{font-size:.75em}.math-env-unknown{flex-direction:column;align-items:flex-start}.math-row{display:block}.math-fenced{display:inline-flex;align-items:stretch;vertical-align:middle;white-space:nowrap;overflow-wrap:normal;text-indent:0}.math-fenced-body{align-self:center}.math-stack{display:inline-block;vertical-align:baseline;text-align:center;white-space:nowrap;overflow-wrap:normal;text-indent:0;line-height:1.15}.math-above,.math-below{display:block;font-size:.7em;line-height:1.1}.math-stack-main{display:inline-flex;flex-direction:column;align-items:center;min-width:100%}.math-bigop{font-size:1.35em;line-height:1}.math-int>.math-above{margin-bottom:.35em}.math-int .math-below{margin-top:.2em}.math-subsup{display:inline-grid;justify-items:start;vertical-align:.55em;font-size:.72em;line-height:.9;white-space:nowrap;overflow-wrap:normal;text-indent:0}.math-subsup>sup{grid-row:1}.math-subsup>sub{grid-row:2}.math-arrow{display:flex;align-self:stretch;min-width:1.6em;height:.6em}.math-arrow>svg{display:block;height:100%;overflow:visible}.math-arrow-head{flex:none;width:.4em}.math-arrow-shaft{flex:1 1 0;width:0;min-width:.3em}.math-xarrow{padding:0 .12em}.math-xarrow>.math-stack-main>.math-stack-base{align-self:stretch}.math-xarrow .math-above,.math-xarrow .math-below{padding:0 .4em}.math-brace{position:relative;display:block;align-self:stretch;height:.5em}.math-brace>svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}.math-substack{display:inline-flex;flex-direction:column;align-items:center;line-height:1.1;white-space:nowrap;overflow-wrap:normal}.math-boxed{display:inline-block;border:.06em solid currentColor;padding:.1em .25em;line-height:1.15;white-space:nowrap;overflow-wrap:normal;text-indent:0}.math-tag{margin-left:1em}.math-display>.math-tag{float:right}.math-phantom{visibility:hidden}.math-mathsf{font-family:Arial,'Liberation Sans','DejaVu Sans',sans-serif;font-style:normal}.math-mathtt{font-family:'Courier New','Liberation Mono','DejaVu Sans Mono',monospace;font-style:normal}.math-env sub,.math-env sup,.math-stack sub,.math-stack sup,.math-fenced sub,.math-fenced sup,.math-chem sub,.math-chem sup{font-size:.72em;line-height:0}.math-subsup>sub,.math-subsup>sup{font-size:1em;line-height:inherit;vertical-align:baseline}`;
