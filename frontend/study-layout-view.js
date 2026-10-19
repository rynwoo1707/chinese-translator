import {renderMathText,mathStyles} from './math-text.js';
export function escapeHtml(value){return String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export function partTitle(part,index){return `${part.pages?.length?`Trang ${part.pages.join(', ')} · `:''}Phần ${String(index+1).padStart(2,'0')}`;}
const FIGURE_REFERENCE=/(?:图|圖|hình|fig(?:ure)?\.?)\s*(\d+(?:\s*[.．·]\s*\d+)*(?:\s*[-–—－]\s*\d+)?)/giu;
const figureNumber=value=>[...String(value||'').matchAll(FIGURE_REFERENCE)][0]?.[1].replace(/[．·]/gu,'.').replace(/\s/gu,'').replace(/[–—－]/gu,'-');
const referencesFigure=(text,caption)=>{
 const number=figureNumber(caption);if(!number)return false;
 return [...String(text).matchAll(FIGURE_REFERENCE)].some(match=>figureNumber(match[0])===number);
};

// A figure belongs to one translation part, even when a long page is split.
export function figuresForPart(parts,index,images){
 const part=parts[index],figures=[];
 for(const page of part?.pages||[])for(const figure of images.get(page)?.figures||[]){
  const candidates=parts.map((item,i)=>({item,i})).filter(({item})=>item.pages?.includes(page));
  const owner=candidates.find(({item})=>referencesFigure(item.text,figure.caption))||candidates[0];
  if(owner?.i===index)figures.push({...figure,page});
 }
 return figures;
}

export function translationBlocks(text){
 const lines=String(text||'').replace(/\r\n?/gu,'\n').trim().split('\n'),blocks=[];
 const hasParagraphs=/\n\s*\n/u.test(String(text));let paragraph=[],math=[];
 const flush=()=>{if(paragraph.length){blocks.push({kind:'paragraph',text:paragraph.join(' ')});paragraph=[];}};
 for(const raw of lines){
  const line=raw.trim();
  if(math.length){math.push(raw);if(/\\\]|\$\$/u.test(line)){blocks.push({kind:'formula',text:math.join('\n')});math=[];}continue;}
  if(/^(?:\\\[|\$\$)/u.test(line)){flush();if(/^(?:\\\[[\s\S]*\\\]|\$\$[\s\S]*\$\$)$/u.test(line))blocks.push({kind:'formula',text:line});else math=[raw];continue;}
  if(!line){flush();continue;}
  const markdown=line.match(/^#{1,6}\s+(.+)$/u),numbered=/^\d+(?:[.．]\d+){1,4}\s+\p{L}/u.test(line)&&line.length<180;
  if(markdown||numbered){flush();blocks.push({kind:'heading',text:markdown?markdown[1]:line});continue;}
  if(/^[-*•]\s+|^\d+[.)]\s+/u.test(line)){flush();blocks.push({kind:'list-item',text:line});continue;}
  paragraph.push(line);if(!hasParagraphs)flush();
 }
 flush();if(math.length)blocks.push({kind:'formula',text:math.join('\n')});return blocks;
}

function figureHtml(figure){
 const number=figureNumber(figure.caption),caption=number?`Hình ${number}`:figure.caption||'Hình từ trang gốc',source=String(figure.url||'');
 if(!/^(?:blob:|data:image\/(?:png|jpeg|webp);base64,)/u.test(source))return '';
 return `<figure class="translated-figure"><img src="${escapeHtml(source)}" alt="${escapeHtml(caption)}" loading="lazy"><figcaption>${escapeHtml(caption)}${figure.page?` · Trang ${figure.page}`:''}<span>Giữ nguyên từ bản gốc</span></figcaption></figure>`;
}

export function translationContentHtml(text,figures=[]){
 const remaining=new Set(figures),content=[];
 for(const block of translationBlocks(text)){
  const tag=block.kind==='heading'?'h3':block.kind==='formula'?'pre':'p';
  content.push(`<${tag} class="translated-${block.kind}">${renderMathText(block.text)}</${tag}>`);
  const linked=[...remaining].filter(figure=>referencesFigure(block.text,figure.caption));
  if(linked.length){content.push(`<div class="translation-figures">${linked.map(figureHtml).join('')}</div>`);linked.forEach(figure=>remaining.delete(figure));}
 }
 if(remaining.size)content.push(`<div class="translation-figures unlinked-figures"><p class="figure-group-label">Hình trong trang</p>${[...remaining].map(figureHtml).join('')}</div>`);
 return content.join('');
}

// Shared with standalone HTML export so diagrams and reading order survive download.
export const readingStyles=`.translation-document{max-width:780px;margin:auto;min-width:0;color:#293128;font:16px/1.9 'Noto Serif','Times New Roman','DejaVu Serif',serif;overflow-wrap:anywhere}.translation-document h3{margin:1.8em 0 .75em;font-size:1.2em;line-height:1.5;color:#35472f}.translation-document h3:first-child,.translation-document p:first-child{margin-top:0}.translation-document p{margin:0 0 1em}.translated-formula{max-width:100%;overflow-x:auto;white-space:pre-wrap;font:inherit;padding:12px 16px;background:#f4f5ee;border-radius:8px}.translated-list-item{padding-left:1em}.translation-figures{display:flex;flex-wrap:wrap;justify-content:center;align-items:start;gap:20px;margin:24px 0 30px;padding:20px 14px;border:1px solid #e2e5d9;border-radius:10px;background:#fff}.translated-figure{margin:0;min-width:0;flex:0 1 270px;text-align:center;break-inside:avoid}.translated-figure img{display:block;max-width:100%;width:auto;max-height:330px;height:auto;margin:auto;object-fit:contain}.translated-figure figcaption{margin-top:10px;font:600 12px/1.6 'Segoe UI',sans-serif;color:#536b43}.translated-figure figcaption span{display:block;font-size:10px;font-weight:400;color:#7c8475}.figure-group-label{flex-basis:100%;font:600 12px 'Segoe UI',sans-serif;color:#68765e}.translation-document .figure-group-label{margin:0}.translation-document:empty{display:none}${mathStyles}`;
// onRegion(block,region) runs when a region with Chinese text is tapped (the study page looks it up in the dictionary);
// a formula-only region of a maths page just shows its text, since there is nothing to look up.
export function originalPageView(number,image,entry,{onRegion}={}){
 const figure=document.createElement('figure'),frame=document.createElement('div'),img=document.createElement('img'),caption=document.createElement('figcaption');
 figure.className='aligned-original';frame.className='page-canvas';img.src=image.url;img.alt=`Trang gốc ${number}, giữ nguyên hình và công thức`;img.loading='lazy';frame.append(img);
 const engine=entry?.engine==='paddle'?'PaddleOCR':entry?.engine==='tesseract'?'Tesseract':entry?.engine==='gemini'?'Gemini OCR':'Lớp chữ PDF';
 caption.textContent=`Trang ${number} · ${engine}${entry?.confidence!==undefined?` · tin cậy OCR ${entry.confidence}%`:''}`;
 const description=document.createElement('p');description.className='region-description';description.textContent=entry?.layout?.blocks?.length?'Chạm vào vùng chữ để xem nguyên tác và tra chữ Hán.':'Giữ trang gốc để đối chiếu; chưa có tọa độ vùng chữ.';
 for(const block of entry?.layout?.blocks||[]){
  const region=document.createElement('button'),box=block.box;region.type='button';region.className='ocr-region';region.title=block.text;region.setAttribute('aria-label',block.text);region.style.cssText=`left:${box.x*100}%;top:${box.y*100}%;width:${box.width*100}%;height:${box.height*100}%;`;
  const han=/\p{Script=Han}/u.test(block.text||''),show=()=>{description.lang='zh';description.textContent=block.text;};region.addEventListener('pointerenter',show);region.addEventListener('focus',show);region.addEventListener('click',()=>{show();if(han)onRegion?.(block,region);});frame.append(region);
 }
 figure.append(frame,caption,description);return figure;
}

export async function buildStudyHtml({title,parts,translations,images,blobDataUrl,combined}){
 const originals=new Map(),embedded=new Map(),usedPages=new Set(parts.flatMap((part,index)=>translations[index]?part.pages||[]:[]));
 for(const number of usedPages){
  const item=images.get(number);if(!item)continue;
  originals.set(number,`<figure><img src="${escapeHtml(await blobDataUrl(item.blob))}" alt="Trang gốc ${number}"><figcaption>Trang gốc ${number} · hình và công thức được giữ nguyên</figcaption></figure>`);
  const figures=[];for(const figure of item.figures||[])figures.push({...figure,url:await blobDataUrl(figure.blob)});embedded.set(number,{figures});
 }
 const sections=parts.map((part,index)=>{
  if(!translations[index])return '';
  const source=(part.pages||[]).map(number=>originals.get(number)||'').join('');
  return `<section class="part"><h2>${escapeHtml(partTitle(part,index))}</h2><article class="translation-document">${translationContentHtml(translations[index],figuresForPart(parts,index,embedded))}</article>${source?`<details class="originals"><summary>Đối chiếu trang gốc · hình và công thức</summary>${source}</details>`:''}</section>`;
 }).join('');
 return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{max-width:1000px;margin:auto;padding:32px 20px;background:#f6f1e5;color:#243128;font:17px/1.85 'Noto Serif','Times New Roman','DejaVu Serif',serif}h1{font-size:30px}h2{margin:0 0 24px;font:600 15px Arial,sans-serif;color:#637157}.part{margin:24px 0;padding:30px;background:#fffdf7;border:1px solid #d9dccf;border-radius:14px}.originals{margin-top:28px;border-top:1px solid #d9dccf;padding-top:15px}.originals summary{cursor:pointer;font:600 13px Arial,sans-serif}.originals figure{margin:20px auto;max-width:780px}.originals img{display:block;width:100%;height:auto}.originals figcaption{font:13px Arial,sans-serif;color:#617057}${readingStyles}@media(max-width:700px){body{padding:16px 10px}.part{padding:20px 14px}}@media print{body{background:#fff}.part{border:0;padding:15px 0}.originals{display:none}img{break-inside:avoid}}</style></head><body><h1>${escapeHtml(title)}</h1>${sections||`<article class="translation-document">${translationContentHtml(combined)}</article>`}</body></html>`;
}
