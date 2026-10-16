import {MATH_GLOSSARY,TEXTBOOK_GLOSSARY} from './ai.js';

// Terms a reader can tap to see the Chinese original: the book's own glossary (teacher-set and learned while
// translating) plus Math vocabulary for Math books. Generic section labels (ví dụ, lưu ý, chương…) and very short
// words are skipped because marking them everywhere is noise, not help.
export function readerTerms(story,limit=400){
 let own={};try{own=JSON.parse(story?.glossary||'{}');}catch{}
 if(!own||typeof own!=='object'||Array.isArray(own))own={};
 const source={...(String(story?.genre||'').includes('Toán học')?MATH_GLOSSARY:{}),...own},byVi=new Map();
 for(const [zh,vi] of Object.entries(source)){
  if(typeof vi!=='string'||TEXTBOOK_GLOSSARY[zh]===vi||zh.length>40||!/\p{Script=Han}/u.test(zh))continue;
  const value=vi.normalize('NFC').trim();if(value.length<5||value.length>60)continue;
  const key=value.toLocaleLowerCase('vi'),entry=byVi.get(key)||{vi:value,zh:[]};if(!entry.zh.includes(zh))entry.zh.push(zh);byVi.set(key,entry);
 }
 return [...byVi.values()].slice(0,limit);
}
