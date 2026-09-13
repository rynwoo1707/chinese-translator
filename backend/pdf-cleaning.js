const PAGE_MARKER=/^\[(?:Trang\s+PDF|Trang|Page)\s*\d+(?:\s*[–—-]\s*\d+)?\]$/iu;
const PAGE_NUMBER=/^(?:[-–—]\s*)?(?:(?:trang|page)\s*)?\d+(?:\s*[\/／]\s*\d+)?(?:\s*(?:页|頁))?(?:\s*[-–—])?$/iu;
const CJK=/[\u3400-\u9fff\uf900-\ufaff]/u;
const END_PUNCT=/[。！？!?；;：:…」』”’）】]$/u;
const READER_PAGE_MARKER=PAGE_MARKER;
const BIBLIOGRAPHIC=/(?:^ISBN(?:-1[03])?\b|^CIP\b|图书在版编目|圖書在版編目|国家图书馆|國家圖書館|责任编辑|責任編輯|出版发行|出版發行|出版社|印刷(?:厂|廠)?|版次\b|开本\b|開本\b|字数\b|字數\b|定价\b|定價\b|版权所有|版權所有|^Dữ liệu (?:biên mục|biên soạn)|^Thư viện .*CIP|Nhà xuất bản\b|Tập đoàn Xuất bản\b|Xuất bản phẩm\b|Bản quyền\b|^In tại\b|^Giá bìa\b)/iu;
const CLASSIFICATION=/^(?:[IVX]+\.\s*)?(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*){1,3}.+(?:I\d{2,4}(?:\.\d+)?|[A-Z]\d{2,4}(?:\.\d+)?)$/u;

const normalize=line=>line.replace(/[\u00a0\u2000-\u200b\u3000]/g,' ').replace(/[ \t]+/g,' ').trim();
export function cleanExtractedPdfText(text){
 const sections=String(text||'').split(/(?=^\[Trang PDF[^\]]*\]$)/gmu).filter(Boolean),pages=sections.map(section=>section.split(/\r?\n/).map(normalize).filter(Boolean)),counts=new Map();
 for(const lines of pages){const content=lines.filter(line=>!PAGE_MARKER.test(line));if(content.length<3)continue;for(const line of new Set([...content.slice(0,2),...content.slice(-2)])){const key=line.toLocaleLowerCase();counts.set(key,(counts.get(key)||0)+1);}}
 const repeated=new Set([...counts].filter(([,count])=>pages.length>2&&count>=Math.max(2,Math.ceil(pages.length*.45))).map(([line])=>line));
 const joined=pages.map(lines=>{const clean=lines.filter(line=>!PAGE_MARKER.test(line)&&!PAGE_NUMBER.test(line)&&!BIBLIOGRAPHIC.test(line)&&!CLASSIFICATION.test(line)&&!repeated.has(line.toLocaleLowerCase())),out=[];let current='';for(const line of clean){if(!current){current=line;continue;}if(CJK.test(current)&&CJK.test(line)&&!END_PUNCT.test(current))current+=line;else{out.push(current);current=line;}}if(current)out.push(current);return out.join('\n');}).filter(Boolean).join('\n\n').replace(/\n{3,}/g,'\n\n').trim();
 return cleanReaderText(joined);
}

// Applied again when publishing/reading so older translations are cleaned without another AI call.
export function cleanReaderText(text){
 const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),firstMetadata=lines.findIndex(raw=>BIBLIOGRAPHIC.test(normalize(raw))),dropLeadingThrough=firstMetadata>=0&&firstMetadata<=15?firstMetadata:-1,clean=[];
 for(let index=0;index<lines.length;index++){const line=normalize(lines[index]);if(index<=dropLeadingThrough||READER_PAGE_MARKER.test(line)||PAGE_NUMBER.test(line)||BIBLIOGRAPHIC.test(line)||CLASSIFICATION.test(line))continue;if(!line){if(clean.at(-1)!=='')clean.push('');continue;}clean.push(line);}
 return clean.join('\n').replace(/^\s+|\s+$/g,'').replace(/\n{3,}/g,'\n\n');
}
