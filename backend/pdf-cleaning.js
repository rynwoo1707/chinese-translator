import {normalizeVietnameseText} from './vietnamese-text.js';

// Two kinds of text pass here, and neither may lose a sentence, an answer or a year:
// - cleanExtractedPdfText: the Chinese source an admin extracted from a PDF (text layer or OCR), before translation. It
//   drops the pipeline's page markers, page furniture (lines repeated at the edges of most pages, explicit page labels,
//   page numbers that run in step with the pages) and the imprint lines of the book's front matter.
// - cleanReaderText: a translation the admin pipeline assembles, downloads or publishes. Only the pipeline's own page
//   markers and explicit page labels go.
// Nothing is removed when a part is read (readerText): a student's own translation is shown as it was saved.

// What the pipeline writes between pages: [Trang PDF 3] or [Trang PDF 3–4] (older text: [Trang 3], [Page 3]).
const PAGE_MARKER=/^\[(?:Trang\s+PDF|Trang|Page)\s*\d+(?:\s*[–—-]\s*\d+)?\]$/iu;
const SECTION_MARKER=/^\[Trang\s+PDF\s*(\d+)(?:\s*[–—-]\s*(\d+))?\]$/iu;
// A line that only labels a page: "- 12 -", "Trang 5/6", "Page 12", "第 12 页". A bare number ("12", "1958", "3/4") is
// never one by itself: it is an answer, a year or a fraction as often as a page number.
const PAGE_LABEL=/^(?:[-–—]\s*\d{1,4}\s*[-–—]|(?:trang|page)\s*\d{1,4}(?:\s*[/／]\s*\d{1,4})?|第\s*\d{1,4}\s*[页頁](?:\s*[,，]?\s*共\s*\d{1,4}\s*[页頁])?)$/iu;
const BARE_NUMBER=/^\d{1,4}$/u;
const CJK=/[㐀-鿿豈-﫿]/u;
const END_PUNCT=/[。！？!?；;：:…」』”’）】]$/u;
// Imprint and catalogue lines. Each needs a field label at the very start of the line, an ISBN, or the figures of a
// price, size or edition: a sentence that names a publisher, printing or copyright never matches. A STRONG line marks
// an imprint page by itself; any other kind needs a second one on the same page.
const STRONG_IMPRINT=[
 /^ISBN(?:[-‐\s]?1[03])?\s*[:：]?\s*(?:97[89][-‐\s]?)?\d[\d‐\s-]{6,}[\dXx]/iu,
 /^(?:图书在版编目|圖書在版編目)\s*[（(]?\s*CIP/u,
 /^(?:中国|中國)版本(?:图书馆|圖書館)\s*CIP/u
];
const WEAK_IMPRINT=[
 /^(?:责任编辑|責任編輯|责任校对|責任校對|责任印制|責任印製|封面设计|封面設計|装帧设计|裝幀設計|版式设计|版式設計|出版发行|出版發行|出版者|出版人|出版社|发行者|發行者|印刷者|印刷|印装|印裝|制版|製版|经销|經銷|开本|開本|印张|印張|字数|字數|印数|印數|版次|印次|书号|書號|定价|定價|社址|网址|網址|邮编|郵編)\s*[:：]/u,
 /^(?:(?:开本|開本|字数|字數|印数|印數|印张|印張)\s*\d|(?:定价|定價)\s*[\d¥￥]|(?:版次|印次)\s*\d{4})/u,
 /^(?:版权所有|版權所有)[\s，,、]*(?:(?:侵权|侵權|翻印|盗版|盜版)必究)?$/u,
 /^(?:©|Copyright\s*©?|\(c\))\s*\d{4}/iu,
 /^Printed in\s+\p{L}+/iu
];
// Only on an imprint page: the catalogue classification (Ⅰ.①… Ⅳ.①I247.5) and the CIP record (书名/作者著.—出版地：出版社，年).
const CATALOGUE=[
 /^(?:[ⅠⅡⅢⅣⅤIVX]+\s*[.．、]\s*)?[①②③④⑤⑥⑦⑧⑨⑩].*[A-Z]\d{1,4}(?:[.．]\d+)*$/u,
 /^.+[/／].*[著编編译譯].*[—–-]{1,2}.+[:：].+[,，]\s*\d{4}/u
];
// The pages (of the uploaded file) where a book keeps its title verso and imprint; a text without page markers counts
// its first lines only.
const FRONT_PAGES=10,FRONT_LINES=80;
// Lines that open or close a page, where running heads and page numbers sit.
const EDGE=2;
const strong=line=>STRONG_IMPRINT.some(pattern=>pattern.test(line)),weak=line=>WEAK_IMPRINT.some(pattern=>pattern.test(line));
function imprintPage(lines){let strongLines=0,weakLines=0;for(const line of lines){if(strong(line))strongLines++;else if(weak(line))weakLines++;}return strongLines>0||weakLines>=2;}
const imprintLine=line=>strong(line)||weak(line)||CATALOGUE.some(pattern=>pattern.test(line));

const normalize=line=>line.replace(/[  -​　]/g,' ').replace(/[ \t]+/g,' ').trim();
function sectionsOf(text){
 return String(text||'').split(/(?=^\[Trang PDF[^\]]*\]$)/gmu).filter(Boolean).map((section,index)=>{
  const lines=section.split(/\r?\n/).map(normalize).filter(Boolean),marker=lines[0]?.match(SECTION_MARKER);
  const start=marker?Number(marker[1]):null,end=marker?Number(marker[2]||marker[1]):null;
  return {index,start,end,lines:lines.filter(line=>!PAGE_MARKER.test(line))};
 });
}
const atEdge=(index,length)=>index<EDGE||index>=length-EDGE;
// Lines repeated at the top or bottom of most pages (at least three): running heads, a school's watermark text. They are
// removed only where they repeat, at a page's edge; the same words inside a page stay.
function repeatedEdges(sections){
 const counts=new Map();
 for(const {lines} of sections){if(lines.length<3)continue;for(const line of new Set([...lines.slice(0,EDGE),...lines.slice(-EDGE)])){const key=line.toLocaleLowerCase();counts.set(key,(counts.get(key)||0)+1);}}
 return new Set([...counts].filter(([,count])=>sections.length>2&&count>=Math.max(3,Math.ceil(sections.length*.45))).map(([line])=>line));
}
// A number alone on the first or last line of a page is its page number when the same offset from the page's own number
// holds on at least two pages (printed page 7 on PDF page 12, page 8 on page 13…). A lone answer such as "12" keeps its place.
function pageNumberEdges(sections){
 const candidates=[];
 for(const section of sections){
  if(section.start===null||!section.lines.length)continue;
  const first=section.lines[0],last=section.lines.at(-1);
  if(BARE_NUMBER.test(first))candidates.push({section,position:0,offset:Number(first)-section.start});
  if(section.lines.length>1&&BARE_NUMBER.test(last))candidates.push({section,position:section.lines.length-1,offset:Number(last)-section.end});
 }
 const counts=new Map();for(const {offset} of candidates)counts.set(offset,(counts.get(offset)||0)+1);
 const drop=new Map();
 for(const item of candidates)if(counts.get(item.offset)>=2){if(!drop.has(item.section))drop.set(item.section,new Set());drop.get(item.section).add(item.position);}
 return drop;
}
export function cleanExtractedPdfText(text){
 const sections=sectionsOf(text),repeated=repeatedEdges(sections);
 for(const section of sections){const {lines}=section;section.lines=lines.filter((line,index)=>!PAGE_LABEL.test(line)&&!(atEdge(index,lines.length)&&repeated.has(line.toLocaleLowerCase())));}
 const numbers=pageNumberEdges(sections);
 const pages=sections.map(section=>{
  const dropped=numbers.get(section);let lines=dropped?section.lines.filter((_,index)=>!dropped.has(index)):section.lines;
  const front=section.start!==null?section.start<=FRONT_PAGES:section.index===0;
  if(front){const head=lines.slice(0,FRONT_LINES);if(imprintPage(head))lines=[...head.filter(line=>!imprintLine(line)),...lines.slice(FRONT_LINES)];}
  // A Chinese line that runs on without closing punctuation is a visual wrap of the same paragraph.
  const out=[];let current='';
  for(const line of lines){if(!current){current=line;continue;}if(CJK.test(current)&&CJK.test(line)&&!END_PUNCT.test(current))current+=line;else{out.push(current);current=line;}}
  if(current)out.push(current);return out.join('\n');
 });
 return normalizeVietnameseText(pages.filter(Boolean).join('\n\n').replace(/\n{3,}/g,'\n\n').trim());
}

// A translation the admin pipeline assembles, downloads or publishes: its page markers and page labels go, every other
// line stays.
export function cleanReaderText(text){
 const clean=[];
 for(const raw of String(text||'').replace(/\r\n?/g,'\n').split('\n')){
  const line=normalize(raw);if(PAGE_MARKER.test(line)||PAGE_LABEL.test(line))continue;
  if(!line){if(clean.length&&clean.at(-1)!=='')clean.push('');continue;}
  clean.push(line);
 }
 return normalizeVietnameseText(clean.join('\n').trim().replace(/\n{3,}/g,'\n\n'));
}
// What a reader is shown of a stored part, a student's own translation included: the text as saved, with only
// Vietnamese tone marks that older translations stored detached put back in place. No line is ever removed.
export const readerText=text=>normalizeVietnameseText(String(text??''));
