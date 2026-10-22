import {unzipSync} from 'fflate';
import {parseDocument} from 'htmlparser2';
import {countTags,documentTooLarge,HTML_ELEMENTS} from './document-limits.js';
const localName=node=>(node.name||'').split(':').pop().toLowerCase();
function elements(node,name){const found=[];for(const child of node.children||[]){if(localName(child)===name)found.push(child);found.push(...elements(child,name));}return found;}
function text(node){if(node.type==='text')return node.data;return (node.children||[]).map(text).join('');}
function resolvePath(base,href){
 if(typeof href!=='string'||!href||/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(href))throw new Error('EPUB có đường dẫn nội dung không hợp lệ.');
 const parts=base.split('/').slice(0,-1);
 for(const part of decodeURIComponent(href.split('#')[0].split('?')[0]).split('/')){if(part==='..'){if(!parts.length)throw new Error('Đường dẫn EPUB vượt ra ngoài gói sách.');parts.pop();}else if(part&&part!=='.')parts.push(part);}
 return parts.join('/');
}
const blocks=new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','blockquote','tr','pre','hr']);
function chapterText(node){
 if(node.type==='text')return node.data.replace(/[\t\r\n ]+/g,' ');
 const name=localName(node);if(['script','style','head','noscript','rt','rp'].includes(name))return '';
 if(name==='br')return '\n';
 const content=(node.children||[]).map(chapterText).join('');return blocks.has(name)?'\n'+content+'\n':name==='td'?content+'\t':content;
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
 const container=parseDocument(read('META-INF/container.xml'),{xmlMode:true});
 const root=elements(container,'rootfile').find(x=>x.attribs?.['media-type']==='application/oebps-package+xml')||elements(container,'rootfile')[0];
 const opfPath=resolvePath('',root?.attribs?.['full-path']);
 const opf=parseDocument(read(opfPath),{xmlMode:true});
 const manifest=elements(opf,'manifest')[0],spine=elements(opf,'spine')[0];if(!manifest||!spine)throw new Error('EPUB thiếu mục lục nội dung hoặc thứ tự chương.');
 const items=new Map(elements(manifest,'item').map(item=>[item.attribs.id,item.attribs]));
 const encrypted=files['META-INF/encryption.xml']?elements(parseDocument(read('META-INF/encryption.xml'),{xmlMode:true}),'cipherreference').map(e=>resolvePath('',e.attribs.URI||e.attribs.uri)):[];
 const chapters=[],parts=[],warnings=[];let readable=0;
 for(const ref of elements(spine,'itemref')){
  const item=items.get(ref.attribs.idref);if(!item)throw new Error('EPUB thiếu chương được liệt kê trong thứ tự đọc.');
  const path=resolvePath(opfPath,item.href);if(encrypted.includes(path))throw new Error('Nội dung EPUB được mã hóa/khóa DRM. Hãy dùng bản EPUB không khóa.');
  if(!['application/xhtml+xml','text/html'].includes(item['media-type']))throw new Error('EPUB có chương dạng ảnh/SVG chưa hỗ trợ dịch. Hãy chuyển phần này sang PDF để OCR.');
  // A chapter is parsed into a tree: one of a few megabytes that is nothing but tags would not fit in a Worker.
  const html=read(path);if(countTags(html,HTML_ELEMENTS)>HTML_ELEMENTS)throw documentTooLarge(`Phần ${chapters.length+1} của EPUB có quá nhiều thẻ định dạng để máy chủ đọc an toàn. Hãy chia sách hoặc chuyển sang TXT/PDF rồi thử lại.`);
  const dom=parseDocument(html,{decodeEntities:true});const body=elements(dom,'body')[0]||dom;
  let content=chapterText(body).replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(content)readable++;
  else{content='[Phần không có văn bản; cần đối chiếu ảnh trong EPUB gốc.]';warnings.push(`Phần ${chapters.length+1} (${path}) không có văn bản để dịch.`);}
  if(elements(body,'img').length||elements(body,'svg').length)warnings.push(`Phần ${chapters.length+1}: hình ảnh không được OCR; hãy đối chiếu EPUB gốc nếu có chữ trong ảnh.`);
  const index=chapters.length+1,title=content.split('\n').find(line=>line.trim())?.trim().slice(0,100)||`Phần ${index}`;parts.push({index,title,content});chapters.push(`[Phần EPUB ${index}: ${title}]\n${content}`);
 }
 if(!readable)throw new Error('EPUB không có chương văn bản để dịch. EPUB chỉ gồm ảnh cần chuyển sang PDF để OCR.');
 return {source:chapters.join('\n\n'),parts,warnings,chapterCount:chapters.length,title:text(elements(opf,'title')[0]||{}).trim()};
}
