import {unzipSync} from 'fflate';
import {Parser} from 'htmlparser2';
import {countTags,documentTooLarge,HTML_ELEMENTS,MAX_ATTRIBUTES,MAX_DEPTH,markupText} from './document-limits.js';
const localName=name=>(name||'').split(':').pop().toLowerCase();
function resolvePath(base,href){
 if(typeof href!=='string'||!href||/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(href))throw new Error('EPUB có đường dẫn nội dung không hợp lệ.');
 const parts=base.split('/').slice(0,-1);
 for(const part of decodeURIComponent(href.split('#')[0].split('?')[0]).split('/')){if(part==='..'){if(!parts.length)throw new Error('Đường dẫn EPUB vượt ra ngoài gói sách.');parts.pop();}else if(part&&part!=='.')parts.push(part);}
 return parts.join('/');
}
// The extracted text a book may reach, and the parts its reading order may list: its unzipped files are capped at 25 MB,
// but the reading order can name one chapter many times, and each time adds the chapter's text (or a note that it has
// none) again. Long web novels have a few thousand chapters.
const MAX_TEXT=25*1024*1024,MAX_PARTS=20000;
const TOO_MUCH_TEXT='Nội dung chữ của EPUB vượt quá 25 MB, mức tối đa máy chủ đọc được. Hãy chia sách thành các tệp nhỏ hơn rồi thử lại.';
const TOO_MANY_PARTS='EPUB có hơn 20.000 phần trong thứ tự đọc, nhiều hơn mức máy chủ đọc được. Hãy chia sách thành các tệp nhỏ hơn rồi thử lại.';
const PACKAGE_TOO_LARGE='Tệp mô tả của EPUB (danh mục và thứ tự chương) có quá nhiều thẻ để máy chủ đọc an toàn. Hãy dùng Calibre chuyển lại sách sang EPUB, hoặc chuyển sang TXT/PDF, rồi thử lại.';
// A package file (container.xml, the OPF, encryption.xml) read as XML events into handler {open(name,attribs,depth),
// close(depth),text(value)}, names without prefix in lower case; no tree is built (see document-limits.js).
function readPackage(xml,handler){
 if(countTags(xml,HTML_ELEMENTS)>HTML_ELEMENTS)throw documentTooLarge(PACKAGE_TOO_LARGE);
 let depth=0,attributes=0;
 new Parser({
  onopentagname(){attributes=0;},
  onattribute(){if(++attributes>MAX_ATTRIBUTES)throw documentTooLarge(PACKAGE_TOO_LARGE);},
  onopentag(name,attribs){if(++depth>MAX_DEPTH.html)throw documentTooLarge(PACKAGE_TOO_LARGE);handler.open?.(localName(name),attribs,depth);},
  onclosetag(){handler.close?.(depth--);},
  ontext(value){handler.text?.(value);}
 },{xmlMode:true}).end(xml);
}
export function extractEpub(data){
 let expanded=0;
 let files;try{files=unzipSync(new Uint8Array(data),{filter(entry){
  // Read metadata and text only, never unpack images, audio or fonts.
  const wanted=/\.(?:xml|opf|xhtml|html|htm)$/i.test(entry.name)||entry.name==='mimetype';
  if(wanted){expanded+=entry.originalSize;if(expanded>25*1024*1024||entry.originalSize>8*1024*1024)throw new Error('EPUB có nội dung giải nén quá lớn (tối đa 25 MB, mỗi chương 8 MB).');}return wanted;
 }});}catch(e){throw new Error(e.message?.startsWith('EPUB')?e.message:'Không đọc được EPUB. Tệp phải là EPUB hợp lệ, không khóa DRM.');}
 const read=path=>{
  // Manifest entries may use XHTML without a filename extension.
  if(!files[path]){const extra=unzipSync(new Uint8Array(data),{filter(entry){if(entry.name!==path)return false;expanded+=entry.originalSize;if(expanded>25*1024*1024||entry.originalSize>8*1024*1024)throw new Error('EPUB có nội dung giải nén quá lớn.');return true;}});if(extra[path])files[path]=extra[path];}
  if(!files[path])throw new Error(`EPUB thiếu tệp: ${path}`);
  const bytes=files[path],encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';return new TextDecoder(encoding,{fatal:true}).decode(bytes);
 };
 if(read('mimetype').trim()!=='application/epub+zip')throw new Error('Tệp không phải EPUB hợp lệ.');
 // The package: the first rootfile of the OPF type (else the first rootfile); in the OPF the items of the first
 // manifest, the item references of the first spine and the text of the first title.
 const rootfiles={first:null,package:null};
 readPackage(read('META-INF/container.xml'),{open(name,attribs){if(name!=='rootfile')return;const value={path:attribs['full-path']};rootfiles.first??=value;if(attribs['media-type']==='application/oebps-package+xml')rootfiles.package??=value;}});
 const opfPath=resolvePath('',(rootfiles.package||rootfiles.first)?.path);
 const items=new Map(),spine=[],within={manifest:0,spine:0,title:0};let title=null,found={manifest:false,spine:false};
 readPackage(read(opfPath),{
  open(name,attribs,depth){
   if(name==='manifest'&&!found.manifest){found.manifest=true;within.manifest=depth;}else if(within.manifest&&name==='item')items.set(attribs.id,{href:attribs.href,type:attribs['media-type']});
   if(name==='spine'&&!found.spine){found.spine=true;within.spine=depth;}else if(within.spine&&name==='itemref')spine.push(attribs.idref);
   if(name==='title'&&title===null){title='';within.title=depth;}
  },
  close(depth){for(const key of Object.keys(within))if(within[key]===depth)within[key]=0;},
  text(value){if(within.title)title+=value;}
 });
 if(!found.manifest||!found.spine)throw new Error('EPUB thiếu mục lục nội dung hoặc thứ tự chương.');
 if(spine.length>MAX_PARTS)throw documentTooLarge(TOO_MANY_PARTS);
 const encrypted=new Set();
 if(files['META-INF/encryption.xml'])readPackage(read('META-INF/encryption.xml'),{open(name,attribs){if(name==='cipherreference')encrypted.add(resolvePath('',attribs.URI||attribs.uri));}});
 const chapters=[],parts=[],warnings=[],texts=new Map();let readable=0,total=0;
 for(const idref of spine){
  const item=items.get(idref);if(!item)throw new Error('EPUB thiếu chương được liệt kê trong thứ tự đọc.');
  const path=resolvePath(opfPath,item.href);if(encrypted.has(path))throw new Error('Nội dung EPUB được mã hóa/khóa DRM. Hãy dùng bản EPUB không khóa.');
  if(!['application/xhtml+xml','text/html'].includes(item.type))throw new Error('EPUB có chương dạng ảnh/SVG chưa hỗ trợ dịch. Hãy chuyển phần này sang PDF để OCR.');
  // A chapter is read once, however often the reading order names it.
  let chapter=texts.get(path);
  if(!chapter){
   const tooMany=()=>documentTooLarge(`Phần ${chapters.length+1} của EPUB có quá nhiều thẻ định dạng để máy chủ đọc an toàn. Hãy chia sách hoặc chuyển sang TXT/PDF rồi thử lại.`);
   const html=read(path);if(countTags(html,HTML_ELEMENTS)>HTML_ELEMENTS)throw tooMany();
   const {text,images}=markupText(html,{body:true,tooComplex:tooMany});
   chapter={content:text.replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim(),images};texts.set(path,chapter);
  }
  let content=chapter.content;
  if(content)readable++;
  else{content='[Phần không có văn bản; cần đối chiếu ảnh trong EPUB gốc.]';warnings.push(`Phần ${chapters.length+1} (${path}) không có văn bản để dịch.`);}
  if(chapter.images)warnings.push(`Phần ${chapters.length+1}: hình ảnh không được OCR; hãy đối chiếu EPUB gốc nếu có chữ trong ảnh.`);
  const index=chapters.length+1,chapterTitle=content.split('\n').find(line=>line.trim())?.trim().slice(0,100)||`Phần ${index}`;
  total+=content.length;if(total>MAX_TEXT)throw documentTooLarge(TOO_MUCH_TEXT);
  parts.push({index,title:chapterTitle,content});chapters.push(`[Phần EPUB ${index}: ${chapterTitle}]\n${content}`);
 }
 if(!readable)throw new Error('EPUB không có chương văn bản để dịch. EPUB chỉ gồm ảnh cần chuyển sang PDF để OCR.');
 return {source:chapters.join('\n\n'),parts,warnings,chapterCount:chapters.length,title:(title??'').trim()};
}
