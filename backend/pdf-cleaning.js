import {normalizeVietnameseText} from './vietnamese-text.js';
import {joinLines,pageFurniture,PAGE_LABEL} from '../frontend/document-layout.js';

// Two kinds of text pass here, and neither may lose a sentence, an answer, a year or a heading:
// - cleanExtractedPdfText: the Chinese source an admin extracted from a PDF (text layer or OCR), before translation. It
//   drops the pipeline's page markers, page furniture (pageFurniture: explicit page labels, page numbers that run in
//   step with the pages, a running head or foot where it repeats at the same edge, kept where it first appears) and
//   the imprint lines of the book's front matter, and joins wrapped lines without gluing headings, captions, rows or
//   the paragraphs the OCR kept apart (joinLines), as the browser cleans a PDF's text layer (frontend/pdf-client.js).
// - cleanReaderText: a translation the admin pipeline assembles, downloads or publishes. Only the pipeline's own page
//   markers and explicit page labels go.
// Nothing is removed when a part is read (readerText): a student's own translation is shown as it was saved.

// What the pipeline writes between pages: [Trang PDF 3] or [Trang PDF 3–4] (older text: [Trang 3], [Page 3]).
const PAGE_MARKER=/^\[(?:Trang\s+PDF|Trang|Page)\s*\d+(?:\s*[–—-]\s*\d+)?\]$/iu;
const SECTION_MARKER=/^\[Trang\s+PDF\s*(\d+)(?:\s*[–—-]\s*(\d+))?\]$/iu;
// A line that only labels a page (PAGE_LABEL, document-layout.js): "- 12 -", "Trang 5/6", "Page 12", "第 12 页". A bare
// number ("12", "1958", "3/4") is never one by itself, nor is "12 页" in a page's body: an answer, a year or a fraction.
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
// Lines that open or close a page (a section), where running heads and page numbers sit.
const EDGE=2;
const strong=line=>STRONG_IMPRINT.some(pattern=>pattern.test(line)),weak=line=>WEAK_IMPRINT.some(pattern=>pattern.test(line));
function imprintPage(lines){let strongLines=0,weakLines=0;for(const line of lines){if(strong(line))strongLines++;else if(weak(line))weakLines++;}return strongLines>0||weakLines>=2;}
const imprintLine=line=>strong(line)||weak(line)||CATALOGUE.some(pattern=>pattern.test(line));

const normalize=line=>line.replace(/[  -​　]/g,' ').replace(/[ \t]+/g,' ').trim();
// An OCR reading may mark a line it takes for a running head or foot: "[đầu trang] …", "[chân trang] …".
const EDGE_MARK=/^\[(đầu|chân)\s+trang\]\s*/iu;
// Where no cross-page cleaning reads them (a single image, a student's page read on its own) the marks go and the lines
// stay, to be translated like any other.
export const withoutEdgeMarks=text=>String(text??'').replace(/^([ \t]*)\[(?:đầu|chân)\s+trang\][ \t]*/gimu,'$1');
// A section's lines; gap marks a line after a blank one (a paragraph end the OCR kept: never joined across), mark the
// edge an OCR reading said the line stands at.
function sectionsOf(text){
 return String(text||'').split(/(?=^\[Trang PDF[^\]]*\]$)/gmu).filter(Boolean).map((section,index)=>{
  const raw=section.split(/\r?\n/).map(normalize),marker=raw.find(Boolean)?.match(SECTION_MARKER),lines=[];
  const start=marker?Number(marker[1]):null,end=marker?Number(marker[2]||marker[1]):null;let gap=false;
  for(const line of raw){
   if(!line){gap=lines.length>0;continue;}if(PAGE_MARKER.test(line))continue;
   const mark=line.match(EDGE_MARK),text=mark?line.slice(mark[0].length):line;
   if(text)lines.push({text,gap,...(mark?{mark:mark[1].toLocaleLowerCase()==='đầu'?'top':'bottom'}:{})});gap=false;
  }
  return {index,start,end,lines};
 });
}
// cleaned: text cleaned already from the lines' places on each page (the browser's text layer, cleanPdfPages): true for
// the whole text, or the pages a mixed job took from the text layer (a Set of the pages its sections start on). Such
// text keeps its lines as they are: only page labels and imprint lines go.
export function cleanExtractedPdfText(text,{cleaned=false}={}){
 const sections=sectionsOf(text),done=section=>cleaned===true||Boolean(cleaned?.has?.(section.start));
 // The edges where running heads, feet and page numbers stand: the lines an OCR reading marked, and the first and last
 // two lines of each section, a guess (guess: a heading or an exercise that opens the page stands there as often), so
 // a line found there goes only as pageFurniture's stricter rule for such edges says.
 for(const section of sections)section.lines.forEach((line,index,lines)=>{line.edge=done(section)?'':line.mark||(index<EDGE?'top':index>=lines.length-EDGE?'bottom':'');line.guess=Boolean(line.edge&&!line.mark);});
 const furniture=pageFurniture(sections.map(section=>({number:section.start,last:section.end,lines:section.lines})));
 const pages=sections.map((section,index)=>{
  let lines=section.lines.flatMap((line,i)=>furniture[index].drop.has(i)?[]:[{...line,keep:furniture[index].furniture.has(i)}]);
  const front=section.start!==null?section.start<=FRONT_PAGES:section.index===0;
  if(front){const head=lines.slice(0,FRONT_LINES);if(imprintPage(head.map(line=>line.text)))lines=[...head.filter(line=>!imprintLine(line.text)),...lines.slice(FRONT_LINES)];}
  // A Chinese line that runs on without closing punctuation is a visual wrap of the same paragraph; headings, captions,
  // short rows and verse lines keep their own lines (joinLines).
  return (done(section)?lines:joinLines(lines)).map(line=>line.text).join('\n');
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
