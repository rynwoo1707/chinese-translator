// Marks glossary terms in the rendered reading text so a student can tap a Vietnamese term to see the Chinese
// original. Works on DOM text nodes after rendering, so no markup is ever built from book text.
const SKIP='button,a,svg,code,pre,sup,.footnote-ref,[class^="math-"],[class*=" math-"],.term';
const LETTER=/[\p{L}\p{N}]/u;
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');

// terms: [{vi, zh:[...]}]. Longest first so "vectơ pháp tuyến" wins over "vectơ".
export function termMatcher(terms){
 const byKey=new Map();
 for(const term of terms||[]){
  const vi=String(term?.vi||'').normalize('NFC').trim();if(vi.length<2||!Array.isArray(term.zh)||!term.zh.length)continue;
  const key=vi.toLocaleLowerCase('vi');const entry=byKey.get(key)||{vi,zh:[]};
  for(const zh of term.zh)if(typeof zh==='string'&&zh&&!entry.zh.includes(zh))entry.zh.push(zh);
  byKey.set(key,entry);
 }
 if(!byKey.size)return null;
 const pattern=[...byKey.keys()].sort((a,b)=>b.length-a.length).map(escapeRegex).join('|');
 return {byKey,regex:new RegExp(pattern,'giu')};
}

// Splits a string into plain-text and term pieces, honouring Vietnamese word boundaries. Terms already in
// `seen` stay plain text, so each term is marked once per paragraph instead of on every repetition.
export function splitTerms(text,matcher,seen=new Set()){
 const pieces=[];let last=0;
 for(const match of String(text).matchAll(matcher.regex)){
  const start=match.index,end=start+match[0].length,key=match[0].toLocaleLowerCase('vi');
  if(LETTER.test(text[start-1]||'')||LETTER.test(text[end]||''))continue;
  const entry=matcher.byKey.get(key);if(!entry||seen.has(key))continue;seen.add(key);
  if(start>last)pieces.push({text:text.slice(last,start)});
  pieces.push({text:match[0],term:entry});last=end;
 }
 if(last<text.length)pieces.push({text:text.slice(last)});
 return pieces;
}

export function highlightTerms(root,matcher){
 if(!root||!matcher)return 0;
 const doc=root.ownerDocument,walker=doc.createTreeWalker(root,4),nodes=[];let count=0;
 for(let node=walker.nextNode();node;node=walker.nextNode())if(node.nodeValue.trim()&&!node.parentElement?.closest(SKIP))nodes.push(node);
 const seenByBlock=new Map();
 for(const node of nodes){
  const block=node.parentElement.closest('p,li,h1,h2,h3,h4,blockquote,td')||root;
  if(!seenByBlock.has(block))seenByBlock.set(block,new Set());
  const pieces=splitTerms(node.nodeValue,matcher,seenByBlock.get(block));if(!pieces.some(piece=>piece.term))continue;
  const fragment=doc.createDocumentFragment();
  for(const piece of pieces){
   if(!piece.term){fragment.append(piece.text);continue;}
   const button=doc.createElement('button');button.type='button';button.className='term';button.textContent=piece.text;
   button.dataset.vi=piece.term.vi;button.dataset.zh=piece.term.zh.join(' / ');button.setAttribute('aria-expanded','false');
   fragment.append(button);count++;
  }
  node.replaceWith(fragment);
 }
 return count;
}

// One shared popover; tap/Enter toggles, Escape or tapping elsewhere closes it.
export function bindTermPopover(root){
 if(!root)return;
 const doc=root.ownerDocument;let popover=doc.querySelector('#term-popover');
 if(!popover){
  popover=doc.createElement('div');popover.id='term-popover';popover.className='term-popover';popover.setAttribute('role','tooltip');popover.hidden=true;
  const zh=doc.createElement('strong'),vi=doc.createElement('span');
  zh.lang='zh-Hans';zh.className='term-popover-zh';vi.className='term-popover-vi';
  popover.append(zh,vi);doc.body.append(popover);
  doc.addEventListener('click',event=>{if(!event.target.closest?.('.term,#term-popover'))closeTerm(doc);});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape')closeTerm(doc,true);});
  doc.defaultView?.addEventListener('resize',()=>closeTerm(doc));
  // Scrolled under the sticky header or off the screen, the term's popover would float over other controls. A header
  // that scrolled away with the page (a phone while reading) leaves the top of the screen as the edge.
  doc.addEventListener('scroll',()=>{const open=doc.querySelector('.term[aria-expanded="true"]');if(!open)return;const box=open.getBoundingClientRect(),top=Math.max(0,doc.querySelector('.site-masthead')?.getBoundingClientRect().bottom||0);if(box.bottom<top||box.top>doc.documentElement.clientHeight)closeTerm(doc);},{passive:true});
  // The keyboard moved on (a tap on plain text moves no focus: the outside click closes it then).
  doc.addEventListener('focusout',event=>{if(event.target.matches?.('.term[aria-expanded="true"]')&&event.relatedTarget&&!event.relatedTarget.closest?.('#term-popover'))closeTerm(doc);});
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest?.('.term');if(!button)return;
  if(button.getAttribute('aria-expanded')==='true'){closeTerm(doc);return;}
  closeTerm(doc);
  popover.querySelector('.term-popover-zh').textContent=button.dataset.zh;popover.querySelector('.term-popover-vi').textContent=button.dataset.vi;
  popover.hidden=false;button.setAttribute('aria-expanded','true');button.setAttribute('aria-describedby','term-popover');
  const box=button.getBoundingClientRect(),view=doc.documentElement,width=popover.offsetWidth,height=popover.offsetHeight;
  const left=Math.max(12,Math.min(box.left+box.width/2-width/2,view.clientWidth-width-12)),below=box.bottom+10+height<view.clientHeight;
  popover.style.left=`${left+scrollX}px`;popover.style.top=`${(below?box.bottom+10:box.top-height-10)+scrollY}px`;popover.dataset.side=below?'below':'above';
 });
}
export function hideTermPopover(doc=globalThis.document){if(doc)closeTerm(doc);}
function closeTerm(doc,restoreFocus=false){
 const popover=doc.querySelector('#term-popover'),open=doc.querySelector('.term[aria-expanded="true"]');
 if(popover)popover.hidden=true;
 if(open){open.setAttribute('aria-expanded','false');open.removeAttribute('aria-describedby');if(restoreFocus)open.focus();}
}
