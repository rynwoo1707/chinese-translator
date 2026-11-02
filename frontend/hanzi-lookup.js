// Tap-to-look-up for Chinese text: pinyin, Hán Việt and meanings from the offline dictionary under /vendor/dict/
// (hanzi-dict.js, built by `npm run prepare:dict`; no API key, no /api call). It only reads page text: a textarea keeps
// its value and selection. Nothing touches the document until a function below is called (Node tests import this).
//
// API:
//  attachHanziLookup(root,{selector,onOpen})  a plain tap on a Han character inside root (or inside root's `selector`
//    elements) looks up the word under it. For read-only text; controls, links, math and editable fields keep their own
//    behaviour. Idempotent per element: call it again after re-rendering root. onOpen runs when a tap opens the panel.
//  openHanziPanel({text,index,title,note,search,returnFocus,theme})  the panel over a given string, such as a PDF
//    block's Chinese source, as a strip of tappable characters (@@PDF_INLINE_n@@ tokens show as "…"). index: UTF-16
//    offset of the character to look up first (-1: none, but search:true looks up the first Han character). search
//    adds a box to type or paste into. returnFocus gets the focus back when the panel closes.
//  lookupTextarea(textarea,{title,note})  the selected text, or the caret's line, of a textarea; never changes it.
//  closeHanziPanel({ifDetached,restoreFocus})  ifDetached: only when its page text was re-rendered away.
//  setHanziTheme('light'|'night'), hanziTapEnabled(), setHanziTapEnabled(on), hasHan(text), hanziStyles (CSS text).
import {createDictionary,codePoints,isHan,hasHan,neighborWindow,DictionaryError} from './hanzi-dict.js';
export {hasHan};

const PREFERENCE='hoatri.hanziTap',STRIP_LIMIT=600,TEXTAREA_RADIUS=200,CONTEXT_LIMIT=2000,READINGS_SHOWN=6,CHIPS_SHOWN=8;
// Taps on controls, links and rendered math keep their own behaviour.
const INTERACTIVE='#hanzi-panel,button,a,input,textarea,select,summary,label,svg,code,[contenteditable]:not([contenteditable="false"]),.term,.footnote-ref,[class^="math-"],[class*=" math-"]';
// Text that is not reading text; each such element counts as one object character, so words never join across it.
const NOT_TEXT='script,style,svg,math,code,sup,rt,rp,textarea,input,select,.footnote-ref,[class^="math-"],[class*=" math-"]';
const BLOCKS='p,li,h1,h2,h3,h4,h5,h6,td,th,figcaption,blockquote,dd,dt,pre,[data-hanzi-context]';
// Inside a context, block-level children end a line, so the last word of one paragraph never joins the next.
const BREAKS=`${BLOCKS},address,article,aside,div,dl,figure,footer,header,hr,ol,section,table,tr,ul`;
const MESSAGES={
 hint:'Chạm vào một chữ để xem pinyin, âm Hán Việt và nghĩa.',
 loading:'Đang tải dữ liệu từ điển…',
 network:'Không tải được dữ liệu từ điển. Kiểm tra kết nối rồi bấm Thử lại.',
 missing:'Máy chủ này chưa có dữ liệu từ điển. Quản trị viên chạy “npm run prepare:dict” (hoặc “npm run setup”) rồi tải lại trang.',
 noHan:'Không có chữ Hán quanh vị trí này.'
};
const MACHINE='Nghĩa tiếng Việt từ CVDICT: phần lớn được dịch tự động từ CC-CEDICT, mới rà soát một phần, có thể còn sai. Đối chiếu nghĩa tiếng Anh khi cần.';
// CC BY-SA 4.0 attribution: stays visible in the panel footer, with the deployed LICENSE.txt linked.
const ATTRIBUTION='Dữ liệu: CC-CEDICT (MDBG) và CVDICT (Phong Phan) theo CC BY-SA 4.0 · Âm Hán Việt: hanviet-pinyin-wordlist (Phong Phan, MIT) · Unihan © Unicode, Inc. (Unicode License v3). Đã chuyển đổi và gộp nguồn.';

// Every rule is scoped under .hanzi-panel and outweighs the pages' bare element rules (study.css lifts every button on
// hover; style.css restyles h2, label and input), so the panel looks the same on every page.
export const hanziStyles=`.hanzi-panel{--hz-bg:#fffdf7;--hz-text:#283127;--hz-muted:#5d6656;--hz-line:#ddd8c6;--hz-accent:#a44636;--hz-soft:#f3f0e4;--hz-button:#fff;--hz-focus:#536b43;--hz-zh:'Noto Serif SC','Noto Sans SC','Source Han Serif SC','Songti SC','SimSun','Microsoft YaHei',serif;position:fixed;z-index:1050;right:16px;bottom:16px;box-sizing:border-box;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;margin:0;padding:0;background:var(--hz-bg);color:var(--hz-text);border:1px solid var(--hz-line);border-radius:14px;box-shadow:0 16px 40px rgba(39,53,35,.22);font:14px/1.55 'Be Vietnam Pro',system-ui,sans-serif;text-align:left;letter-spacing:normal}
.hanzi-panel[data-theme=night]{--hz-bg:#222b28;--hz-text:#e1e6dd;--hz-muted:#aeb8aa;--hz-line:#3d4844;--hz-accent:#eaa995;--hz-soft:#2c3632;--hz-button:#303a36;--hz-focus:#c3d3b1;box-shadow:0 16px 40px rgba(0,0,0,.45)}
.hanzi-panel[hidden],.hanzi-panel [hidden]{display:none!important}.hanzi-panel *{box-sizing:border-box}
.hanzi-panel button{font:inherit;font-weight:500;color:inherit;background:var(--hz-button);border:1px solid var(--hz-line);border-radius:9px;min-height:36px;padding:5px 10px;margin:0;cursor:pointer;line-height:1.4}
.hanzi-panel button:hover:not(:disabled){transform:none;box-shadow:none;border-color:var(--hz-muted);background:var(--hz-soft)}.hanzi-panel button:disabled{opacity:.45;cursor:default;border-color:var(--hz-line);background:var(--hz-button)}
.hanzi-panel button:focus-visible,.hanzi-panel input:focus-visible,.hanzi-panel a:focus-visible,.hanzi-panel summary:focus-visible{outline:3px solid var(--hz-focus);outline-offset:2px}
.hz-head{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 16px;border-bottom:1px solid var(--hz-line);background:none}
.hz-head h2{flex:1;min-width:0;margin:0;font-size:14px;font-weight:600;line-height:1.4;overflow-wrap:anywhere;font-family:inherit;letter-spacing:normal}
.hanzi-panel .hz-close{width:36px;padding:0;font-size:20px;line-height:1;border-color:transparent;background:transparent}
.hz-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 16px}
.hz-note{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--hz-soft);color:var(--hz-muted);font-size:12.5px}
.hz-search{display:grid;gap:4px;margin-bottom:10px}.hz-search label{font-size:12px;color:var(--hz-muted)}
.hz-search input{width:100%;min-height:40px;margin:0;padding:6px 10px;border:1px solid var(--hz-line);border-radius:9px;background:var(--hz-button);color:inherit;font:18px/1.4 var(--hz-zh)}
@media(pointer:coarse){.hanzi-panel .hz-close{width:44px;min-height:44px}.hz-search input{min-height:44px}}
.hz-strip-label{margin:0 0 4px;font-size:12px;color:var(--hz-muted)}
.hz-strip{margin:0 0 10px;padding:2px 0 6px;max-height:8.4em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid var(--hz-line);font:21px/1.95 var(--hz-zh)}
.hanzi-panel .hz-strip .hz-c{min-height:0;min-width:0;padding:0 2px;border:0;border-radius:5px;background:none;font:inherit;font-weight:400;line-height:inherit;vertical-align:baseline}
.hanzi-panel .hz-strip .hz-c:hover{background:var(--hz-soft)}.hanzi-panel .hz-strip .hz-c.is-word{background:rgba(164,70,54,.16);color:var(--hz-accent)}.hanzi-panel .hz-strip .hz-c[aria-current=true]{box-shadow:inset 0 -2px var(--hz-accent)}
.hz-strip-note{margin:-6px 0 10px;font-size:12px;color:var(--hz-muted)}
.hz-message{margin:2px 0;color:var(--hz-muted)}.hz-card>.hz-retry{margin-top:8px}.hz-card:focus,.hz-reading:focus{outline:none}
.hz-word-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;margin-bottom:6px}
.hz-word{font:600 30px/1.3 var(--hz-zh);color:var(--hz-accent)}.hz-form,.hz-form-line{font-size:13px;color:var(--hz-muted)}.hz-form-line{margin:0 0 2px}
.hz-readings{list-style:none;margin:0;padding:0}.hz-reading{margin:0;padding:8px 0;border-top:1px dashed var(--hz-line)}.hz-reading:first-child{border-top:0;padding-top:0}.hz-minor{opacity:.82}
.hz-pron{margin:0 0 4px;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 14px}.hz-pinyin{font-size:18px;font-weight:600}.hz-hv b{font-weight:600}
.hz-label{margin:2px 0;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--hz-muted)}
.hz-badge{display:inline-block;padding:0 7px;border:1px solid var(--hz-line);border-radius:999px;background:var(--hz-soft);font-size:12px;line-height:1.6;color:var(--hz-muted);cursor:help}
.hz-senses{margin:0;padding-left:18px}.hz-senses li{margin:1px 0;overflow-wrap:anywhere}
.hz-en{margin-top:4px}.hz-en .hz-senses{font-size:13px;color:var(--hz-muted)}.hz-cl{margin:4px 0 0;font-size:13px}
.hz-section{margin-top:12px}.hz-section h3{margin:0 0 6px;font-size:12px;font-weight:600;line-height:1.4;color:var(--hz-muted);font-family:inherit;letter-spacing:normal}
.hz-row{display:flex;flex-wrap:wrap;gap:6px}.hz-row button{display:inline-flex;align-items:baseline;gap:6px}.hz-zh{font-family:var(--hz-zh);font-size:17px}
.hz-meta{margin:12px 0 0;font-size:13px;color:var(--hz-muted)}.hz-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
.hz-foot{padding:4px 16px 10px;border-top:1px solid var(--hz-line);background:none;font-size:12px;line-height:1.5;color:var(--hz-muted);text-align:left;letter-spacing:normal}
.hz-toggle{display:flex;align-items:center;gap:8px;min-height:36px;margin:0;font-size:12.5px;color:var(--hz-text);cursor:pointer}.hz-toggle input{flex:none;width:18px;height:18px;margin:0;padding:0;accent-color:var(--hz-accent)}
.hz-attribution{margin:0}.hz-attribution a{color:inherit;text-decoration:underline}
.hanzi-panel :lang(zh-Hant){font-family:'Noto Serif TC','Noto Sans TC','Source Han Serif TC','PMingLiU','Microsoft JhengHei',serif}
@media (max-width:700px),(pointer:coarse){.hanzi-panel{left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));width:auto;max-width:none;max-height:62vh;border-radius:16px}}
@media (pointer:coarse){[data-hanzi-root]{cursor:pointer;-webkit-tap-highlight-color:transparent}.hanzi-panel .hz-strip .hz-c{display:inline-block;min-width:32px;min-height:38px;text-align:center}}
::highlight(hanzi-lookup){background-color:rgba(214,150,60,.38)}
@media (prefers-reduced-motion:no-preference){.hanzi-panel:not([hidden]){animation:hanzi-in .16s ease-out}}@keyframes hanzi-in{from{opacity:0;transform:translateY(6px)}}`;

let dictionary=null,panel=null,view=null,theme='light',sequence=0;
const attached=new WeakSet(),listening=new WeakSet();
const dict=()=>dictionary??=createDictionary();
const isLowSurrogate=code=>code>=0xDC00&&code<=0xDFFF;
const HAN_AT=/\p{Script=Han}/u;

export function hanziTapEnabled(){try{return globalThis.localStorage?.getItem(PREFERENCE)!=='off';}catch{return true;}}
export function setHanziTapEnabled(on){
 try{globalThis.localStorage?.setItem(PREFERENCE,on?'on':'off');}catch{}
 const box=panel?.querySelector('.hz-toggle input');if(box)box.checked=Boolean(on);
}
export function setHanziTheme(value){theme=value==='night'?'night':'light';if(panel)panel.dataset.theme=theme;}

function h(doc,tag,attributes={},children=[]){
 const node=doc.createElement(tag);
 for(const [name,value] of Object.entries(attributes)){
  if(value===undefined||value===null||value===false)continue;
  if(name==='text')node.textContent=value;else if(name==='class')node.className=value;else node.setAttribute(name,value===true?'':String(value));
 }
 for(const child of [].concat(children))if(child!==null&&child!==undefined&&child!==false&&child!=='')node.append(child);
 return node;
}
function ensureStyles(doc){
 if(doc.querySelector('style[data-hanzi-styles]'))return;
 const style=doc.createElement('style');style.dataset.hanziStyles='';style.textContent=hanziStyles;doc.head.append(style);
}
function ensurePanel(doc){
 if(panel?.isConnected)return panel;
 ensureStyles(doc);
 const toggle=h(doc,'input',{type:'checkbox'}),search=h(doc,'input',{id:'hz-search-input',type:'search',placeholder:'Ví dụ: 空间向量',lang:'zh',autocomplete:'off',spellcheck:'false'});
 panel=h(doc,'section',{id:'hanzi-panel',class:'hanzi-panel',role:'dialog','aria-modal':'false','aria-labelledby':'hanzi-panel-title',hidden:true,'data-theme':theme},[
  h(doc,'div',{class:'hz-head'},[h(doc,'h2',{id:'hanzi-panel-title',text:'Tra chữ Hán'}),h(doc,'button',{type:'button',class:'hz-close','aria-label':'Đóng tra cứu',title:'Đóng tra cứu',text:'×'})]),
  h(doc,'div',{class:'hz-body'},[
   h(doc,'p',{class:'hz-note',hidden:true}),
   h(doc,'div',{class:'hz-search',hidden:true},[h(doc,'label',{for:'hz-search-input',text:'Nhập hoặc dán chữ Hán'}),search]),
   h(doc,'div',{class:'hz-strip-wrap',hidden:true},[h(doc,'p',{id:'hz-strip-label',class:'hz-strip-label',text:'Các chữ trong đoạn — dùng phím mũi tên để chọn, Enter để tra'}),h(doc,'div',{class:'hz-strip',role:'group','aria-labelledby':'hz-strip-label',lang:'zh'}),h(doc,'p',{class:'hz-strip-note',hidden:true})]),
   h(doc,'div',{class:'hz-card','aria-live':'polite','aria-atomic':'true'})
  ]),
  h(doc,'div',{class:'hz-foot'},[h(doc,'label',{class:'hz-toggle'},[toggle,'Tra khi chạm vào chữ']),h(doc,'p',{class:'hz-attribution'},[ATTRIBUTION,' ',h(doc,'a',{class:'hz-license',target:'_blank',rel:'noopener',hidden:true,text:'Giấy phép dữ liệu'})])])
 ]);
 toggle.checked=hanziTapEnabled();
 toggle.addEventListener('change',()=>setHanziTapEnabled(toggle.checked));
 panel.querySelector('.hz-close').addEventListener('click',()=>closeHanziPanel({restoreFocus:true}));
 let typing=0;
 search.addEventListener('input',()=>{clearTimeout(typing);typing=setTimeout(()=>{if(view?.mode==='strip')setStrip(search.value,search.value.search(HAN_AT));},250);});
 const strip=panel.querySelector('.hz-strip');
 strip.addEventListener('click',event=>{const button=event.target.closest?.('.hz-c');if(button&&view?.mode==='strip')show(Number(button.dataset.i));});
 strip.addEventListener('keydown',event=>{
  const buttons=[...strip.querySelectorAll('.hz-c')],at=buttons.indexOf(event.target);if(at<0)return;
  const next={ArrowRight:at+1,ArrowDown:at+1,ArrowLeft:at-1,ArrowUp:at-1,Home:0,End:buttons.length-1}[event.key];
  if(next===undefined||!buttons[next])return;
  event.preventDefault();rove(buttons,buttons[next]);buttons[next].focus();
 });
 panel.querySelector('.hz-card').addEventListener('click',onCardClick);
 if(!listening.has(doc)){
  listening.add(doc);
  // The focus goes back to the opener only from inside the panel; Escape pressed elsewhere leaves it where it is.
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&panel&&!panel.hidden&&!event.defaultPrevented){const active=doc.activeElement;closeHanziPanel({restoreFocus:!active||active===doc.body||panel.contains(active)});}});
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged',()=>{if(view?.card&&panel&&!panel.hidden)renderCard(view.card);});
 }
 doc.body.append(panel);
 return panel;
}
const rove=(buttons,active)=>{for(const button of buttons)button.tabIndex=button===active?0:-1;};

function present(doc,{title='Tra chữ Hán',note='',search=false,strip=false}){
 const element=ensurePanel(doc);
 element.dataset.theme=theme;element.querySelector('#hanzi-panel-title').textContent=title||'Tra chữ Hán';
 const noteBox=element.querySelector('.hz-note');noteBox.textContent=note||'';noteBox.hidden=!note;
 element.querySelector('.hz-search').hidden=!search;element.querySelector('.hz-strip-wrap').hidden=!strip;
 element.querySelector('.hz-card').replaceChildren();
 element.hidden=false;
 return element;
}
function message(kind,{retry=null,word=''}={}){
 if(!panel)return;
 const doc=panel.ownerDocument,box=panel.querySelector('.hz-card'),active=doc.activeElement,inside=box.contains(active),action=active?.dataset?.action;
 // The control that started a slow lookup gets the focus back when the card arrives (renderCard).
 if(inside&&view&&action&&action!=='retry')view.refocus=action;
 box.replaceChildren(h(doc,'p',{class:`hz-message hz-${kind}`,text:MESSAGES[kind]||word}));
 if(view)view.retry=retry;
 const button=retry&&h(doc,'button',{type:'button',class:'hz-retry','data-action':'retry',text:'Thử lại'});
 if(button)box.append(button);
 if(inside){if(button)button.focus({preventScroll:true});else{box.tabIndex=-1;box.focus({preventScroll:true});}}
}

// Looks up chars[index] of the current view (or the given [start,end) word) and renders the card.
async function show(index,range=null){
 const current=view,token=++sequence;if(!current||!panel)return;
 if(current.mode==='inline'&&!fresh(current)){current.stale=true;}
 const slow=setTimeout(()=>{if(token===sequence&&!current.card)message('loading');},150);
 try{
  const card=await dict().lookup(current.chars,index,range);
  if(token!==sequence||view!==current)return;
  Object.assign(current,{start:card.start,end:card.end,index:card.index,card});
  renderCard(card);mark();
  dict().licenseUrl().then(url=>{const link=panel?.querySelector('.hz-license');if(link){link.href=url;link.hidden=false;}},()=>{});
 }catch(error){
  if(token!==sequence||view!==current)return;
  current.card=null;message(error instanceof DictionaryError&&error.code==='missing'?'missing':'network',{retry:()=>show(index,range)});
 }finally{clearTimeout(slow);}
}
async function move(dir){
 const current=view;if(!current?.card)return;
 if(current.mode==='inline'&&!fresh(current)){current.stale=true;renderCard(current.card);return;}
 try{
  const next=await dict().neighbor(current.chars,current.start,current.end,dir);
  if(next&&view===current){await show(next.start,next);reveal();}
 }catch{if(view===current)message('network',{retry:()=>move(dir)});}
}

function senses(doc,list,lang){return h(doc,'ul',{class:'hz-senses',lang},list.map(sense=>h(doc,'li',{text:sense})));}
function chineseVoice(lang){
 const voices=globalThis.speechSynthesis?.getVoices?.()||[];
 return (lang!=='zh-Hant'&&voices.find(voice=>/^zh[-_](CN|Hans)/iu.test(voice.lang)))||voices.find(voice=>/^zh\b/iu.test(voice.lang))||null;
}
function renderCard(card){
 const doc=panel.ownerDocument,box=panel.querySelector('.hz-card'),traditional=card.lang==='zh-Hant',other=traditional?'zh-Hans':'zh-Hant',nodes=[];
 nodes.push(h(doc,'div',{class:'hz-word-row'},[h(doc,'span',{class:'hz-word',lang:card.lang,text:card.word}),card.otherForm&&h(doc,'span',{class:'hz-form'},[`${card.otherForm.label}: `,h(doc,'span',{lang:other,text:card.otherForm.text})])]));
 if(!card.found)nodes.push(h(doc,'p',{class:'hz-message',text:`Chưa có “${card.word}” trong từ điển.`}));
 if(card.readings.length){
  const list=h(doc,'ol',{class:'hz-readings'});
  card.readings.forEach((reading,k)=>{
   const item=h(doc,'li',{class:reading.minor?'hz-reading hz-minor':'hz-reading',hidden:k>=READINGS_SHOWN});
   item.append(h(doc,'p',{class:'hz-pron'},[h(doc,'span',{class:'hz-pinyin',title:reading.numbered,text:reading.pinyin}),reading.hanViet&&h(doc,'span',{class:'hz-hv'},['Hán Việt: ',h(doc,'b',{text:reading.hanViet}),reading.hanVietSource==='unihan'?' (Unihan)':''])]));
   if(reading.form&&reading.form!==card.otherForm?.text)item.append(h(doc,'p',{class:'hz-form-line'},[`${traditional?'Giản thể':'Phồn thể'}: `,h(doc,'span',{lang:other,text:reading.form})]));
   if(reading.vi.length)item.append(h(doc,'div',{class:'hz-vi'},[h(doc,'p',{class:'hz-label'},['Nghĩa tiếng Việt',h(doc,'span',{class:'hz-badge',title:MACHINE,text:'dịch máy'})]),senses(doc,reading.vi,'vi')]));
   // The English source stays visible next to the machine-translated Vietnamese, so a reader can always check it.
   if(reading.en.length)item.append(h(doc,'div',{class:'hz-en'},[h(doc,'p',{class:'hz-label',text:'Nghĩa tiếng Anh (CC-CEDICT)'}),senses(doc,reading.en,'en')]));
   if(reading.classifiers.length)item.append(h(doc,'p',{class:'hz-cl'},['Lượng từ: ',h(doc,'span',{lang:card.lang,text:reading.classifiers.join(', ')})]));
   list.append(item);
  });
  nodes.push(list);
  if(card.readings.length>READINGS_SHOWN)nodes.push(h(doc,'button',{type:'button','data-action':'more',text:`Xem thêm ${card.readings.length-READINGS_SHOWN} cách đọc`}));
 }
 if(card.perChar.length)nodes.push(h(doc,'section',{class:'hz-section'},[h(doc,'h3',{text:'Từng chữ'}),h(doc,'div',{class:'hz-row'},card.perChar.map(row=>h(doc,'button',{type:'button','data-action':'char','data-i':row.index,'aria-label':`Tra chữ ${row.char}`},[h(doc,'span',{class:'hz-zh',lang:card.lang,text:row.char}),[row.pinyin,row.hanViet||'—'].filter(Boolean).join(' · ')])))]));
 const tapped=card.tapped;
 if(tapped){
  const facts=[tapped.radical&&`bộ ${tapped.radical.name?`${tapped.radical.name} `:''}${tapped.radical.char}`,tapped.strokes&&`${tapped.strokes} nét`,tapped.traditional&&`phồn thể ${tapped.traditional}`,tapped.simplified&&`giản thể ${tapped.simplified}`].filter(Boolean);
  if(!card.found&&tapped.mandarin)facts.push(`pinyin ${tapped.mandarin}`);
  if(!card.found&&tapped.hanViet)facts.push(`Hán Việt ${tapped.hanViet}${tapped.hanVietSource==='unihan'?' (Unihan)':''}`);
  if(facts.length)nodes.push(h(doc,'p',{class:'hz-meta'},[h(doc,'span',{class:'hz-zh',lang:card.lang,text:tapped.char}),`: ${facts.join(' · ')}`]));
  if(tapped.definition)nodes.push(h(doc,'p',{class:'hz-meta'},['Nghĩa chữ (Unihan, tiếng Anh): ',h(doc,'span',{lang:'en',text:tapped.definition})]));
 }
 const chips=card.alternatives.slice(0,CHIPS_SHOWN);
 if(chips.length)nodes.push(h(doc,'section',{class:'hz-section'},[h(doc,'h3',{text:'Từ khác có chữ này'}),h(doc,'div',{class:'hz-row'},chips.map(chip=>h(doc,'button',{type:'button',class:'hz-zh','data-action':'alt','data-start':chip.start,'data-end':chip.end,lang:card.lang,text:chip.text})))]));
 const stale=view?.stale,edge=dir=>!view||stale||!neighborWindow(view.chars,card.start,card.end,dir);
 nodes.push(h(doc,'div',{class:'hz-actions'},[
  h(doc,'button',{type:'button','data-action':'prev',disabled:edge(-1),text:'‹ Từ trước'}),
  h(doc,'button',{type:'button','data-action':'next',disabled:edge(1),text:'Từ sau ›'}),
  chineseVoice(card.lang)&&h(doc,'button',{type:'button','data-action':'speak',text:'Nghe'}),
  globalThis.navigator?.clipboard?.writeText&&globalThis.isSecureContext!==false&&h(doc,'button',{type:'button','data-action':'copy',text:'Sao chép'})
 ]));
 // Keyboard users keep their place: the control they used is rebuilt, so the focus moves to its new copy.
 const active=doc.activeElement,used=box.contains(active)?view?.refocus||active.dataset?.action||'':'';
 if(view)view.refocus='';
 box.replaceChildren(...nodes);
 if(used){const again=box.querySelector(`[data-action="${used}"]:not(:disabled)`);if(again)again.focus({preventScroll:true});else{box.tabIndex=-1;box.focus({preventScroll:true});}}
 // A new word starts at the top of its card (the strip, when shown, stays above it).
 const body=panel.querySelector('.hz-body');body.scrollTop=view?.mode==='strip'?Math.min(body.scrollTop,box.offsetTop-body.offsetTop):0;
}
function onCardClick(event){
 const button=event.target.closest?.('button[data-action]');if(!button||!view)return;
 const action=button.dataset.action;
 if(action==='retry')view.retry?.();
 else if(action==='more'){const shown=[...panel.querySelectorAll('.hz-reading[hidden]')];for(const item of shown)item.hidden=false;button.remove();if(shown[0]){shown[0].tabIndex=-1;shown[0].focus({preventScroll:true});}}
 else if(action==='char'){const i=Number(button.dataset.i);show(i,{start:i,end:i+1}).then(reveal);}
 else if(action==='alt')show(view.index,{start:Number(button.dataset.start),end:Number(button.dataset.end)}).then(reveal);
 else if(action==='prev'||action==='next')move(action==='next'?1:-1);
 else if(action==='speak')speak();
 else if(action==='copy')copy(button);
}
function speak(){
 const card=view?.card,synth=globalThis.speechSynthesis,voice=chineseVoice(card?.lang);if(!card||!synth||!voice)return;
 synth.cancel();const utterance=new SpeechSynthesisUtterance(card.word);utterance.voice=voice;utterance.lang=voice.lang||'zh-CN';utterance.rate=.8;synth.speak(utterance);
}
async function copy(button){
 const card=view?.card,first=card?.readings[0];if(!card)return;
 const line=[card.word,first?.pinyin&&`[${first.pinyin}]`,first?.hanViet,first&&(first.vi.slice(0,2).join('; ')||first.en.slice(0,2).join('; '))].filter(Boolean).join(' ');
 try{await globalThis.navigator.clipboard.writeText(line);button.textContent='Đã chép';}catch{button.textContent='Không chép được';}
 setTimeout(()=>{if(button.isConnected)button.textContent='Sao chép';},1600);
}

// Page text as one string per block, mapped back to its text nodes. Skipped elements become U+FFFC; <br> and block
// elements a line break.
function textMap(container){
 const pieces=[];let text='';
 const walk=node=>{
  for(let child=node.firstChild;child;child=child.nextSibling){
   if(child.nodeType===3){pieces.push({node:child,start:text.length});text+=child.nodeValue;}
   else if(child.nodeType===1){if(child.matches(NOT_TEXT))text+='\uFFFC';else if(child.tagName==='BR')text+='\n';else if(child.matches(BREAKS)){text+='\n';walk(child);text+='\n';}else walk(child);}
  }
 };
 walk(container);return {text,pieces};
}
function locate(pieces,position,end){
 for(const piece of pieces){const length=piece.node.nodeValue.length;if(position>=piece.start&&(position<piece.start+length||end&&position===piece.start+length))return {node:piece.node,offset:position-piece.start};}
 return null;
}
const fresh=current=>current.container.isConnected&&textMap(current.container).text===current.text;
function domRange(current,start,end){
 if(!current.container.isConnected)return null;
 const map=textMap(current.container);if(map.text!==current.text)return null;
 const last=current.chars.length-1,from=current.base+current.offsets[start],to=current.base+(end<=last?current.offsets[end]:current.offsets[last]+current.chars[last].length);
 const a=locate(map.pieces,from,false),b=locate(map.pieces,to,true);if(!a||!b)return null;
 const range=current.doc.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);return range;
}
// Highlights the looked-up word on the page (CSS Custom Highlight API, when available) or in the panel strip.
function mark(){
 const registry=globalThis.CSS?.highlights;
 if(view?.mode==='inline'){
  registry?.delete('hanzi-lookup');
  const range=!view.stale&&typeof globalThis.Highlight==='function'&&domRange(view,view.start,view.end);
  if(range)registry?.set('hanzi-lookup',new globalThis.Highlight(range));
  return;
 }
 const buttons=[...panel.querySelectorAll('.hz-c')];
 for(const button of buttons){const i=Number(button.dataset.i);button.classList.toggle('is-word',i>=view.start&&i<view.end);if(i===view.index)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}
 const active=buttons.find(button=>Number(button.dataset.i)===view.index);if(active)rove(buttons,active);
}
// A bottom sheet may cover the tapped line on a phone: scroll the page so the word stays visible above it.
function reveal(){
 if(view?.mode!=='inline'||!panel)return;
 const range=domRange(view,view.start,view.end);if(!range)return;
 const word=range.getBoundingClientRect(),sheet=panel.getBoundingClientRect(),win=view.doc.defaultView;
 const covered=word.bottom>sheet.top-8&&word.top<sheet.bottom&&word.right>sheet.left&&word.left<sheet.right;
 if(covered)win.scrollBy({top:word.bottom-sheet.top+24,behavior:'auto'});
 else if(word.bottom<0||word.top>win.innerHeight)range.startContainer.parentElement?.scrollIntoView({block:'center'});
}

// The character under the pointer: the caret may sit on either side of the glyph, so the character whose box holds
// the point wins. Returns {node, offset (UTF-16), char} or null.
function caretAt(doc,x,y){
 let node=null,offset=0;
 if(doc.caretPositionFromPoint){const position=doc.caretPositionFromPoint(x,y);node=position?.offsetNode;offset=position?.offset??0;}
 else if(doc.caretRangeFromPoint){const range=doc.caretRangeFromPoint(x,y);node=range?.startContainer;offset=range?.startOffset??0;}
 if(!node||node.nodeType!==3)return null;
 const text=node.nodeValue;
 for(let at of [offset,offset-1]){
  if(at<0||at>=text.length)continue;
  if(isLowSurrogate(text.charCodeAt(at))&&at>0)at--;
  const char=String.fromCodePoint(text.codePointAt(at)),range=doc.createRange();range.setStart(node,at);range.setEnd(node,at+char.length);
  if([...range.getClientRects()].some(box=>x>=box.left-1&&x<=box.right+1&&y>=box.top-1&&y<=box.bottom+1))return {node,offset:at,char};
 }
 return null;
}

// Inline lookup on read-only page text: a plain tap or click (primary button, no modifier, moved < 6 px, held < 500 ms,
// no text selected) on a Han character inside root, or inside root's `selector` elements. Drag, long-press and
// double-click selection keep working. Idempotent per element; onOpen runs each time a tap opens the panel.
export function attachHanziLookup(root,{selector='',onOpen}={}){
 if(!root||attached.has(root))return;
 attached.add(root);
 const doc=root.ownerDocument;ensureStyles(doc);root.setAttribute('data-hanzi-root','');
 let down=null;
 root.addEventListener('pointerdown',event=>{down=event.isPrimary&&event.button===0?{x:event.clientX,y:event.clientY,time:event.timeStamp}:null;});
 root.addEventListener('click',event=>{
  const start=down;down=null;
  if(!start||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.detail>1||!hanziTapEnabled())return;
  if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>=6||event.timeStamp-start.time>=500)return;
  const selection=doc.getSelection?.();if(selection&&!selection.isCollapsed)return;
  const target=event.target?.nodeType===1?event.target:event.target?.parentElement;
  if(!target||!root.contains(target))return;
  const blocked=target.closest(INTERACTIVE);if(blocked&&(root.contains(blocked)||blocked.id==='hanzi-panel'))return;
  const scope=selector?target.closest(selector):root;if(!scope||!root.contains(scope))return;
  const hit=caretAt(doc,event.clientX,event.clientY);
  if(!hit||!isHan(hit.char)||!scope.contains(hit.node)||hit.node.parentElement?.closest(NOT_TEXT))return;
  openInline(scope,hit,onOpen);
 });
}
function openInline(scope,hit,onOpen){
 const doc=scope.ownerDocument,block=hit.node.parentElement?.closest(BLOCKS),container=block&&scope.contains(block)?block:scope;
 const map=textMap(container),piece=map.pieces.find(item=>item.node===hit.node);if(!piece)return;
 const position=piece.start+hit.offset;
 let from=Math.max(0,position-2*CONTEXT_LIMIT),to=Math.min(map.text.length,position+2*CONTEXT_LIMIT);
 if(from>0&&isLowSurrogate(map.text.charCodeAt(from)))from++;
 if(to<map.text.length&&isLowSurrogate(map.text.charCodeAt(to)))to++;
 const {chars,offsets}=codePoints(map.text.slice(from,to)),index=offsets.indexOf(position-from);if(index<0)return;
 const first=Math.max(0,index-CONTEXT_LIMIT),last=Math.min(chars.length,index+CONTEXT_LIMIT+1);
 view={mode:'inline',doc,container,text:map.text,base:from+offsets[first],chars:chars.slice(first,last),offsets:offsets.slice(first,last).map(offset=>offset-offsets[first]),index:index-first,start:index-first,end:index-first+1,returnFocus:null,card:null};
 present(doc,{});
 onOpen?.();
 show(view.index).then(reveal);
}

// Lookup panel over a given text, shown as a strip of tappable characters: a PDF block's Chinese source, a selection,
// or (search: true) text the reader types or pastes. index is the UTF-16 offset of the character to look up first
// (-1: none). returnFocus gets the focus back on Escape / close.
export function openHanziPanel({text='',index=-1,title='Tra chữ Hán',note='',search=false,returnFocus=null,theme:requested}={}){
 const doc=globalThis.document;if(!doc?.body)return;
 if(requested)setHanziTheme(requested);
 sequence++;globalThis.CSS?.highlights?.delete('hanzi-lookup');
 view={mode:'strip',doc,chars:[],start:-1,end:-1,index:-1,returnFocus:returnFocus||null,returnId:returnFocus?.id||'',card:null};
 const element=present(doc,{title,note,search,strip:true}),input=element.querySelector('#hz-search-input');
 const clean=String(text||'').replace(/@@PDF_INLINE_\d+@@/gu,'…');
 input.value=search?clean:'';
 setStrip(clean,index<0&&search?clean.search(HAN_AT):index);
 if(search)input.focus({preventScroll:true});
 else if(returnFocus)(element.querySelector('.hz-c[tabindex="0"]')||element.querySelector('.hz-close')).focus({preventScroll:true});
}
function setStrip(text,index){
 const doc=panel.ownerDocument,strip=panel.querySelector('.hz-strip'),note=panel.querySelector('.hz-strip-note');
 const {chars,offsets}=codePoints(text);
 let at=index>=0?offsets.findIndex((offset,k)=>offset<=index&&index<offset+chars[k].length):-1,from=0;
 // A long text keeps STRIP_LIMIT characters around the chosen one.
 if(chars.length>STRIP_LIMIT)from=Math.max(0,Math.min((at>=0?at:0)-STRIP_LIMIT/2,chars.length-STRIP_LIMIT));
 view.chars=chars.slice(from,from+STRIP_LIMIT);view.card=null;view.start=view.end=view.index=-1;
 if(at>=0)at-=from;
 if(at>=0&&!isHan(view.chars[at])){const after=view.chars.findIndex((char,k)=>k>at&&isHan(char));at=after>=0?after:view.chars.findLastIndex((char,k)=>k<at&&isHan(char));}
 note.hidden=chars.length<=STRIP_LIMIT;note.textContent=note.hidden?'':`Đoạn dài: chỉ hiện ${STRIP_LIMIT} chữ quanh vị trí chọn.`;
 const nodes=[];let run='';
 view.chars.forEach((char,k)=>{if(!isHan(char)){run+=char;return;}if(run){nodes.push(run);run='';}nodes.push(h(doc,'button',{type:'button',class:'hz-c','data-i':k,tabindex:'-1',text:char}));});
 if(run)nodes.push(run);
 strip.replaceChildren(...nodes);
 const buttons=[...strip.querySelectorAll('.hz-c')];if(buttons.length)rove(buttons,buttons.find(button=>Number(button.dataset.i)===at)||buttons[0]);
 if(!buttons.length){message(text.trim()?'noHan':'hint');return;}
 if(at>=0)show(at);else message('hint');
}

// "Tra chữ Hán" for a textarea: the selected text when it has Han characters, else up to 200 characters of the caret's
// paragraph on each side, starting at the first Han character at or after the caret. Never writes the value and fires
// no input event; closing the panel restores focus and the selection.
export function lookupTextarea(textarea,options={}){
 if(!textarea)return;
 const value=String(textarea.value||''),a=textarea.selectionStart??0,b=textarea.selectionEnd??a,low=Math.min(a,b),high=Math.max(a,b);
 const picked=value.slice(low,high);let text,index;
 if(high>low&&hasHan(picked)){text=codePoints(picked).chars.slice(0,STRIP_LIMIT).join('');index=text.search(HAN_AT);}
 else{
  const lineStart=value.lastIndexOf('\n',Math.max(0,low-1))+1,lineEnd=value.indexOf('\n',low)<0?value.length:value.indexOf('\n',low);
  let from=Math.max(lineStart,low-TEXTAREA_RADIUS),to=Math.min(lineEnd,low+TEXTAREA_RADIUS);
  if(from>0&&isLowSurrogate(value.charCodeAt(from)))from++;
  if(to<value.length&&isLowSurrogate(value.charCodeAt(to)))to++;
  text=value.slice(from,to);const after=text.slice(low-from).search(HAN_AT);
  index=after>=0?low-from+after:[...text.slice(0,low-from).matchAll(/\p{Script=Han}/gu)].at(-1)?.index??-1;
 }
 openHanziPanel({title:'Tra chữ Hán',...options,text,index,returnFocus:textarea});
 if(view)Object.assign(view,{textarea,selection:[a,b],value});
}

// Closes the panel. ifDetached: only when it shows a word from page text that is no longer in the document (call it
// after re-rendering a page). restoreFocus: give the focus back to the opener (and a textarea its selection).
export function closeHanziPanel({ifDetached=false,restoreFocus=false}={}){
 if(!panel||panel.hidden)return;
 if(ifDetached&&!(view?.mode==='inline'&&!view.container.isConnected))return;
 sequence++;panel.hidden=true;globalThis.CSS?.highlights?.delete('hanzi-lookup');
 const closing=view;view=null;
 if(!restoreFocus||!closing)return;
 const target=closing.returnFocus?.isConnected?closing.returnFocus:closing.returnId?closing.doc.getElementById(closing.returnId):null;
 target?.focus?.({preventScroll:true});
 if(closing.textarea&&target===closing.textarea&&closing.textarea.value===closing.value)closing.textarea.setSelectionRange(...closing.selection);
}
