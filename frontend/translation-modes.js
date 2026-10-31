// "Cách dịch": one profile per mode, shared by the study workspace (browser), the Worker routes and the admin pipeline.
// A profile says how hard Gemini is asked to work: thinking level per step, batch sizes, how scanned pages are cut into
// OCR sheets, and which readings are read again. economy/balanced/quality keep the names stored since migration 0011;
// premium is the school's default (admin) and a student's choice. estimate multiplies the economy token estimate.
// label is the mode's name everywhere; brief is the one line under the field (what it does, about how many times Tiết
// kiệm's tokens: estimate, written as the line says it); hint is the full description ("So sánh các Cách dịch").
// Every mode spends one more try on a block only when it needs one: a translation that keeps Chinese or drops a line is
// asked for again (backend/pdf-block-translation.js), and a reading again (reread) takes the blocks Gemini could not read
// (kept: true, or those codes of backend/pdf-block-ocr.js OCR_KEPT_CODES) and the doubtful readings (doubt: true, or those
// codes of OCR_DOUBT_CODES), at most maxPerPage a page.
export const MODES=['economy','balanced','quality','premium'];
export const DEFAULT_MODE='economy';
export const ADMIN_DEFAULT_MODE='premium';
const PROFILES={
 economy:{label:'Tiết kiệm',brief:'Ít token nhất; hợp với khóa miễn phí.',hint:'Đọc và dịch theo lượt lớn, không suy luận thêm; chỉ thử lại một lần những đoạn còn sót chữ Trung, thiếu dòng hoặc đọc chưa đủ. Hợp với khóa Gemini miễn phí.',
  translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:false,reread:{kept:['empty','unread','refused','truncated','malformed'],doubt:['han'],thinking:'low',maxPerPage:2},
  layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:6,blocks:48},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1},
 balanced:{label:'Cân bằng',brief:'Đọc lại chỗ máy đọc sót · khoảng 1,1× token.',hint:'Như Tiết kiệm, thêm một lượt đọc lại mọi đoạn máy chưa đọc được và dịch lại đoạn thiếu số hoặc ngắn bất thường.',
  translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:true,reread:{kept:true,doubt:['han'],thinking:'low',maxPerPage:2},
  layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:6,blocks:48},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1.1},
 quality:{label:'Kỹ hơn',brief:'Suy luận ngắn, đọc lại chỗ đáng ngờ · khoảng 1,5× token.',hint:'Bật suy luận ngắn, chia lượt nhỏ hơn, đọc lại đoạn đáng ngờ và dịch lại đoạn còn sót chữ Trung.',
  translateThinking:'low',ocrThinking:'low',retryThinking:'low',allowRepair:true,strict:true,reread:{kept:true,doubt:true,thinking:'low',maxPerPage:3},
  layoutBatch:{chars:3000,blocks:24},ocrBatch:{images:4,blocks:24},sheets:'standard',textOcr:'hybrid',textChunk:8000,estimate:1.5},
 premium:{label:'Kỹ nhất',brief:'Soát kỹ từng đoạn, Gemini đọc lại mọi trang scan · khoảng 2,5× token; khóa miễn phí hết lượt nhanh hơn.',hint:'Chụp chữ nhỏ và công thức ở độ phân giải cao, suy luận kỹ hơn, đọc lại đoạn đáng ngờ và soát bản dịch từng đoạn. Tốn nhiều token nhất; khóa miễn phí hết lượt trong ngày nhanh hơn.',
  translateThinking:'medium',ocrThinking:'low',retryThinking:'medium',allowRepair:true,strict:true,reread:{kept:true,doubt:true,thinking:'medium',maxPerPage:4},
  layoutBatch:{chars:2000,blocks:16},ocrBatch:{images:3,blocks:16},sheets:'fine',textOcr:'gemini',textChunk:6000,estimate:2.5},
};
export const isMode=value=>MODES.includes(value);
// Whether a reading again (a profile's reread.kept or reread.doubt) takes a block marked with that code.
export const rereads=(rule,code)=>Boolean(code)&&(rule===true||Array.isArray(rule)&&rule.includes(code));
// The Chinese a block translation keeps that it may not, in every mode: what the server asks for once more and the browser
// names and asks for again. Allowed, from the text's structure alone (any subject):
// - characters the source shows as examples: quoted (“的”字, 「人」: at most four inside the marks, no sentence: speech
//   such as “好。” is translated; a title in 《》 is translated), one named as a character (山字有三画), or a line listing
//   single characters (给下列汉字注音：山 水 火; 山、水、火) kept as that list, in its order;
// - Chinese the text teaches as language: the words (at most four characters) of a source line that reads Chinese aloud
//   (a run beside a pinyin syllable with its tone mark: 山 shān, mā 妈), and a character the translation names as one
//   (Chữ 江 có nghĩa là sông), as text mode allows them (backend/ai.js chineseLeft);
// - a glossary rendering that keeps Chinese (allowed: its values), only as the rendering writes it;
// - a short parenthesis of the source's own words after a Vietnamese word, a number or a bracket, as an uncertain name or
//   title is given, its pinyin after a comma at most: Trương Tam (张三), Trương Tam (张三, Zhāng Sān), Bài 3 (练习三),
//   Luận ngữ (《论语》); a name may be glossed in the other script (张三 for 張三: at most eight characters, sharing half
//   of them with as long a run of the source). A parenthesis the source has itself is no such gloss: “Đáp án (略)” keeps
//   略 untranslated;
// - the mirror, a word the source sets out as an item glossed in Vietnamese right after it, as a word list gives it:
//   山 (sơn – núi). An item: a run of at most four characters the source glosses in Latin right after it (山 shān,
//   学校（xuéxiào）), or one of a line made only of such runs (生词：学校、老师). A heading or a name written first,
//   河流与城市 (Sông ngòi và thành thị), is no item: the reading comes first (Trương Tam (张三)).
// Blank answer slots, 山（ ）, are spaces. No lookbehind: Safari before 16.4 cannot parse one (old-browsers.test.mjs).
const QUOTED=/[“"「『‘']([^“”"「」『』‘’'《》〈〉\n]{1,12})[”"」』’']/gu,PAREN=/[（(]([^()（）\n]{1,40})[)）]/gu,GLOSS=/^[\p{Script=Han}\s·・‧•《》〈〉“”‘’「」『』"'、，,]+(?:[,，;；]\s*[\p{Script=Latin}\p{M}\s'’·-]+)?$/u;
const NAMED=/(?:^|[^\p{Script=Han}])(\p{Script=Han})字/gu,BLANK=/[（(][\s_＿　.…]*[)）]/gu,ITEM=String.raw`\p{Script=Han}{1,4}(?:\s*[（(]?\s*\p{Script=Latin}[\p{Script=Latin}\p{M}\s'’·-]*[)）]?)?`;
const LATIN_AFTER=/(^|[^\p{Script=Han}])(\p{Script=Han}{1,4})(?=\s*[（(]?\s*\p{Script=Latin})/gu,ITEM_LINE=new RegExp(`^\\s*${ITEM}(?:\\s*[、，,;；/]\\s*${ITEM})+\\s*[。.;；]?\\s*$`,'u');
const CHAR_LINE=/^\s*\p{Script=Han}(?:[\s、，,;；]+\p{Script=Han})+\s*[。.;；]?\s*$/u,CHARS=/(^|[^\p{Script=Han}])(\p{Script=Han}(?:[\s、，,;；]+\p{Script=Han})+)(?!\p{Script=Han})/gu;
const GLOSSED=/(^|[^\p{Script=Han}])(\p{Script=Han}{1,4})(\s*[（(][^()（）\n]{0,40}\p{Script=Latin}[^()（）\n]{0,40}[)）])/gu;
const PINYIN=/\p{Script=Han}\s?[a-zü]*[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ][a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]*|[a-zü]*[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ][a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]*\s?\p{Script=Han}/iu;
const NAMED_HERE=/((?:^|[^\p{L}])(?:chữ|ký tự|kí tự)\s*[“"「『‘']?)(\p{Script=Han}{1,2})(?!\p{Script=Han})/giu;
const hanOf=text=>(String(text).match(/\p{Script=Han}/gu)||[]).join('');
// The source's items (runs a word list glosses) and its lines of single characters (their Han, in order).
function sourceItems(from){
 const items=new Set([...from.matchAll(LATIN_AFTER)].map(([,,run])=>run)),chars=[];
 for(const line of from.split('\n')){const parts=line.split(/[：:]/u),tail=parts[parts.length-1],single=CHAR_LINE.test(tail);if(single)chars.push(hanOf(tail));if(single||ITEM_LINE.test(tail))for(const run of tail.match(/\p{Script=Han}+/gu)||[])items.add(run);}
 return {items,chars};
}
export function hanLeft(source,translation,allowed=[]){
 const from=String(source??'').replace(BLANK,' '),kept=new Set(),own=new Set([...from.matchAll(PAREN)].map(([,inside])=>hanOf(inside)).filter(Boolean)),{items,chars}=sourceItems(from);
 for(const [,inside] of from.matchAll(QUOTED)){const han=inside.match(/\p{Script=Han}/gu)||[];if(han.length<=4&&!/[。！？!?…]/u.test(inside))for(const c of han)kept.add(c);}
 for(const [,c] of from.matchAll(NAMED))kept.add(c);
 const mine=run=>[...run].every(c=>from.includes(c));let text=String(translation??'').replace(BLANK,' ');
 // A rendering is no licence for its characters elsewhere: a learned 'Tư Mã Thiên (司马迁)' never lets 司马迁 stand bare.
 for(const value of allowed)if(typeof value==='string'&&/\p{Script=Han}/u.test(value)&&value.trim())text=text.split(value.trim()).join(' ');
 const taught=new Set(from.split('\n').filter(line=>PINYIN.test(line)).flatMap(line=>(line.match(/\p{Script=Han}+/gu)||[]).filter(run=>run.length<=4)));
 text=text.replace(/\p{Script=Han}+/gu,run=>taught.has(run)?' ':run).replace(NAMED_HERE,(whole,lead,han)=>from.includes(han)?`${lead} `:whole);
 const runs=from.match(/\p{Script=Han}+/gu)||[],akin=han=>runs.some(run=>{for(let k=0;k+han.length<=run.length;k++){const part=run.slice(k,k+han.length);if(2*[...han].filter(c=>part.includes(c)).length>=han.length)return true;}return false;});
 text=text.replace(PAREN,(whole,inside,at,all)=>{const han=hanOf(inside);return han&&han.length<=16&&GLOSS.test(inside)&&/[\p{Script=Latin}\p{M}\p{N})\]）】][”’"»]?\s*$/u.test(all.slice(Math.max(0,at-3),at))&&!own.has(han)&&(mine(han)||han.length<=8&&akin(han))?' ':whole;});
 text=text.replace(GLOSSED,(whole,lead,run,gloss)=>items.has(run)?`${lead} ${gloss}`:whole).replace(CHARS,(whole,lead,list)=>{const han=hanOf(list);return chars.some(line=>line.includes(han))?`${lead} `:whole;});
 // The runs of Chinese left, each once, as the student finds them in the text.
 return [...new Set((text.match(/\p{Script=Han}+/gu)||[]).filter(run=>[...run].some(c=>!kept.has(c))))];
}
// A term Gemini proposes is learned only as a Vietnamese rendering, the Chinese in parentheses after a reading at most
// (Tư Mã Thiên (司马迁)): one that keeps Chinese bare, puts it first (史景迁 (Sử Cảnh Khiên)) or repeats its term would be
// sent with every later part or batch and keep that Chinese through the book. One rule for text mode (backend/ai.js),
// kept layouts and whole books. Chinese outside the parentheses never: what a lesson may keep in a translation (chữ 山)
// is no rendering of 山 for every later page.
export const learnedTerm=(term,rendering)=>typeof term==='string'&&typeof rendering==='string'&&Boolean(rendering.trim())&&rendering.trim()!==term.trim()&&!/^[\s《〈“「『"'(（]*\p{Script=Han}/u.test(rendering)&&!/\p{Script=Han}/u.test(rendering.replace(PAREN,' '))&&!hanLeft(term,rendering).length;
// The school's own mode, from ADMIN_TRANSLATION_MODE (anything else: ADMIN_DEFAULT_MODE): the admin jobs' default, and
// what Xưởng dịch preselects in a browser signed in to /admin.
export function adminModeOf(value){const mode=String(value??'').trim();return isMode(mode)?mode:ADMIN_DEFAULT_MODE;}
// An unknown or missing mode is economy, the cheapest, never a more expensive one.
export function modeProfile(value){const id=isMode(value)?value:DEFAULT_MODE;return {id,...PROFILES[id]};}
export const modeLabel=value=>modeProfile(value).label;
// About how many tokens reading and translating blocks costs, said before anything is sent (the new blocks of a refreshed
// layout): an OCR sheet about 1,400 (its image about 1,090 on Gemini 3, its share of the reading the rest), a character of
// source about 1.5 sent and received, each request's instructions about 800 (measured on the owner's saved parts:
// 2,030 characters in 3 requests cost about 5,300). Tiết kiệm's, scaled by the mode's estimate.
export function blockTokens({sheets=0,characters=0,requests=0}={},mode){return Math.round(((Number(sheets)||0)*1400+(Number(characters)||0)*1.5+(Number(requests)||0)*800)*modeProfile(mode).estimate);}

// The extractor a kept layout was read with (services/pdf-layout/extract.py EXTRACTION_VERSION, written as the manifest's
// extractionVersion and each page's): a part an older one read may keep headings, captions or lines as printed Chinese
// that this one makes blocks of. Xưởng dịch offers "Cập nhật bố cục" for it and Thư viện riêng marks it "Bố cục cũ"
// (backend/translation-modes.test.mjs keeps the two numbers equal).
export const LAYOUT_VERSION=4;
// A manifest's stamp is its oldest page's (a page's own, else the document's; 0 when none says).
export function layoutStamp(document){
 const pages=Array.isArray(document?.pages)?document.pages:[],stamp=page=>Number(page?.extractionVersion??document?.extractionVersion)||0;
 return pages.length?Math.min(...pages.map(stamp)):stamp(null);
}
// The Han a page keeps as printed outside every block (extract.py page.untranslated: Han-sized cells by cause, or their
// total): a page without blocks is blank only when it keeps none.
export function untranslatedHan(page){
 const value=page?.untranslated,count=item=>typeof item==='number'&&Number.isFinite(item)&&item>0?item:0;
 return value&&typeof value==='object'?Object.values(value).reduce((sum,item)=>sum+count(item),0):count(value);
}
