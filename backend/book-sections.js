const MARKER=/^\[Phần (AZW3|EPUB) (\d+)(?::[^\]\n]*)?\][ \t]*\n?/u;
const ANY_MARKER=/^\[Phần (?:AZW3|EPUB) \d+(?::[^\]\n]*)?\][ \t]*$/gmu;

function plainChunk(text,limit){
 if(text.length<=limit)return text;
 let end=text.lastIndexOf('\n',limit-1)+1;
 if(end<limit/2)end=limit;
 const code=text.charCodeAt(end-1);if(code>=0xD800&&code<=0xDBFF)end--;
 return text.slice(0,end);
}

// Keeps an ebook section marker outside the AI prompt so the model cannot omit it.
export function nextBookTranslationPart(source,offset=0,limit=3000){
 const rest=source.slice(offset),match=rest.match(MARKER);let marker='',prefixLength=0;
 if(match){marker=match[0].trim();prefixLength=match[0].length;}
 const body=rest.slice(prefixLength),next=body.search(ANY_MARKER);
 const available=next>=0?body.slice(0,next):body;
 const text=plainChunk(available,limit);
 return {text,marker,consumed:prefixLength+text.length};
}

function inferredTitle(content,number){
 const first=content.split('\n').map(line=>line.trim()).find(Boolean)||'';
 return /^(?:Chương|Phần|Quyển|Hồi|Lời|Mục lục|Phụ lục)\b/iu.test(first)&&first.length<=200?first:`Chương ${number}`;
}

export function splitBookTranslation(text){
 const matches=[...String(text||'').matchAll(ANY_MARKER)];if(!matches.length)return [];
 const sections=[];const preface=text.slice(0,matches[0].index).trim();
 if(preface)sections.push({title:inferredTitle(preface,1),content:preface});
 for(const [index,match] of matches.entries()){
  const start=match.index+match[0].length,end=matches[index+1]?.index??text.length;
  const content=text.slice(start,end).trim();if(content)sections.push({title:inferredTitle(content,sections.length+1),content});
 }
 return sections.map((section,index)=>({...section,number:index+1}));
}
