import {initKf8File} from '@lingo-reader/mobi-parser';
import {parseDocument} from 'htmlparser2';

const blocks=new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','blockquote','tr','pre','hr']);
const localName=node=>(node.name||'').split(':').pop().toLowerCase();
function htmlText(node){if(node.type==='text')return node.data.replace(/[\t\r\n ]+/g,' ');const name=localName(node);if(['script','style','head','noscript','rt','rp'].includes(name))return '';if(name==='br')return '\n';const content=(node.children||[]).map(htmlText).join('');return blocks.has(name)?'\n'+content+'\n':name==='td'?content+'\t':content;}
export function azw3HtmlToText(html){return htmlText(parseDocument(String(html||''),{decodeEntities:true})).replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
export async function extractAzw3(data){
 const bytes=new Uint8Array(data);if(bytes.length<80||new TextDecoder('windows-1252').decode(bytes.slice(60,68))!=='BOOKMOBI')throw new Error('Tệp không phải AZW3/MOBI hợp lệ.');
 let book;try{book=await initKf8File(bytes);}catch(error){const message=String(error?.message||error);if(/encrypt|drm/i.test(message))throw new Error('AZW3 đang khóa DRM. Hệ thống chỉ đọc sách không DRM mà bạn có quyền sử dụng.');throw new Error(`Không đọc được cấu trúc AZW3/KF8: ${message}`);}
 try{
  const spine=book.getSpine();if(!spine.length)throw new Error('AZW3 không có thứ tự chương.');const chapters=[],warnings=[];let readable=0,totalChars=0;
  for(let index=0;index<spine.length;index++){const loaded=book.loadChapter(spine[index].id),content=azw3HtmlToText(loaded?.html);if(content){readable++;totalChars+=content.length;const first=content.split('\n').find(line=>line.trim())?.slice(0,100);chapters.push(`[Phần AZW3 ${index+1}${first?`: ${first}`:''}]\n${content}`);}else warnings.push(`Phần ${index+1} không có văn bản và đã được bỏ qua.`);if(totalChars>25*1024*1024)throw new Error('Nội dung AZW3 sau giải nén vượt quá 25 MB.');}
  if(!readable)throw new Error('AZW3 không có nội dung văn bản có thể dịch.');const metadata=book.getMetadata();return {source:chapters.join('\n\n'),warnings,chapterCount:spine.length,title:metadata.title||'',author:(metadata.author||[]).join(', ')};
 }finally{book.destroy();}
}
