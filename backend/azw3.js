import {initKf8File} from '@lingo-reader/mobi-parser';
import {countTags,documentTooLarge,HTML_ELEMENTS,markupText} from './document-limits.js';

const NON_READER_SECTION=/(?:^(?:目录|目次|书名页|書名頁)$|^(?:图书在版编目|圖書在版編目|CIP\b|版权(?:页|信息)?|版權(?:頁|資訊)?))/iu;
// The library keeps a book's whole decompressed text in memory and copies it again for every text record it adds, so the
// text a book declares is checked before any of it is decompressed. A stored text record of at most 64 KB decompresses
// to a bounded size with PalmDOC; HUFF/CDIC (KindleGen's optional "huffdic" compression) expands through a dictionary
// without any bound and is refused. A chapter's markup is read as a stream, like an EPUB chapter (document-limits.js).
const MAX_TEXT=16*1024*1024,MAX_CHAPTER=8*1024*1024,MAX_RECORD=64*1024,HUFF_CDIC=17480;
const TOO_LARGE='Sách AZW3 quá lớn để máy chủ đọc an toàn. Hãy dùng Calibre chuyển sách sang EPUB hoặc chia sách thành các tệp nhỏ hơn, rồi thử lại.';
// The text of a chapter's HTML, the whole document read (a KF8 chapter is a fragment of the book's one HTML flow).
export function azw3HtmlToText(html){return markupText(String(html||''),{tooComplex:()=>documentTooLarge(TOO_LARGE)}).text.replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
function guardText(book,fileSize){
 const mobi=book.mobiFile,header=mobi?.palmdocHeader;
 if(header?.compression===HUFF_CDIC)throw documentTooLarge('Sách AZW3 này dùng kiểu nén HUFF/CDIC mà máy chủ chưa đọc an toàn được. Hãy dùng Calibre chuyển sách sang EPUB rồi tải lên.');
 if(Number(book.fullRawLength)>MAX_TEXT)throw documentTooLarge(TOO_LARGE);
 if(Array.isArray(mobi?.recordsOffset)&&Number.isInteger(header?.numTextRecords))for(let i=1;i<=header.numTextRecords;i++){const [start=0,end=fileSize]=mobi.recordsOffset[(mobi.start||0)+i]??[];if(end-start>MAX_RECORD)throw documentTooLarge(TOO_LARGE);}
 if(typeof mobi?.loadTextBuffer==='function'){
  const load=mobi.loadTextBuffer.bind(mobi);let produced=0;
  mobi.loadTextBuffer=index=>{const data=load(index);produced+=data.length;if(produced>MAX_TEXT+MAX_RECORD)throw documentTooLarge(TOO_LARGE);return data;};
 }
}
// init: the KF8 reader (a test passes its own).
export async function extractAzw3(data,{init=initKf8File}={}){
 const bytes=new Uint8Array(data);if(bytes.length<80||new TextDecoder('windows-1252').decode(bytes.slice(60,68))!=='BOOKMOBI')throw new Error('Tệp không phải AZW3/MOBI hợp lệ.');
 let book;try{book=await init(bytes);}catch(error){const message=String(error?.message||error);if(/encrypt|drm/i.test(message))throw new Error('AZW3 đang khóa DRM. Hệ thống chỉ đọc sách không DRM mà bạn có quyền sử dụng.');throw new Error(`Không đọc được cấu trúc AZW3/KF8: ${message}`);}
 try{
  guardText(book,bytes.length);
  const spine=book.getSpine();if(!spine.length)throw new Error('AZW3 không có thứ tự chương.');const chapters=[],parts=[],warnings=[];let readable=0,totalChars=0;
  // Translation only needs text. Calling loadChapter() also turns embedded resources
  // into Blob URLs, but Cloudflare Workers do not implement URL.createObjectURL().
  for(let index=0;index<spine.length;index++){
   if(Number(spine[index].length)>MAX_CHAPTER)throw documentTooLarge(TOO_LARGE);
   const raw=typeof book.loadText==='function'?book.loadText(spine[index]):spine[index].text;
   if(String(raw||'').length>MAX_CHAPTER||countTags(String(raw||''),HTML_ELEMENTS)>HTML_ELEMENTS)throw documentTooLarge(TOO_LARGE);
   const content=azw3HtmlToText(raw);if(content){totalChars+=content.length;const first=content.split('\n').find(line=>line.trim())?.slice(0,100),title=first||`Phần ${index+1}`;if(NON_READER_SECTION.test(title)){warnings.push(`Đã bỏ qua mục phi nội dung: ${title}.`);}else{readable++;parts.push({index:index+1,title,content});chapters.push(`[Phần AZW3 ${index+1}: ${title}]\n${content}`);}}else warnings.push(`Phần ${index+1} không có văn bản và đã được bỏ qua.`);if(totalChars>25*1024*1024)throw new Error('Nội dung AZW3 sau giải nén vượt quá 25 MB.');
  }
  if(!readable)throw new Error('AZW3 không có nội dung văn bản có thể dịch.');const metadata=book.getMetadata();return {source:chapters.join('\n\n'),parts,warnings,chapterCount:parts.length,title:metadata.title||'',author:(metadata.author||[]).join(', ')};
 }finally{book.destroy?.();}
}
