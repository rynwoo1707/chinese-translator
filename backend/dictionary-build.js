// Builds the Chinese lookup data served from frontend/vendor/dict/ (layout in frontend/hanzi-dict.js) from CC-CEDICT,
// CVDICT, hanviet-pinyin-wordlist and Unihan. Pure: source texts in, file contents out; prepare-dictionary.mjs downloads,
// verifies and writes them. Deterministic, so the same sources and builder always give byte-identical files.
import {createHash} from 'node:crypto';
import {DICT_FORMAT,INDEX_BUCKETS,ENTRY_BUCKETS,MAX_WORD,FLAG_VI_ONLY,FLAG_VARIANT,FLAG_SURNAME,indexBucket,entryBucket,indexFile,entryFile,syllables,markSyllable,isHan} from '../frontend/hanzi-dict.js';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const byText=(a,b)=>a<b?-1:a>b?1:0;
const codePointsOf=text=>[...text];
const unique=list=>[...new Set(list)];

const CEDICT_LINE=/^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/$/u;
// CC-CEDICT and CVDICT share the CEDICT line format: "傳統 传统 [chuan2 tong3] /gloss/gloss/".
export function parseCedict(text,{name='CC-CEDICT'}={}){
 const header=[],meta={},entries=[];let lines=0,skipped=0,body=false;
 for(const raw of String(text).replace(/^\uFEFF/u,'').split('\n')){
  const line=raw.replace(/\r$/u,'');if(!line.trim())continue;
  if(line.startsWith('#')){if(!body)header.push(line);const field=/^#!\s*(\w+)=(.*)$/u.exec(line);if(field&&!body)meta[field[1]]=field[2].trim();continue;}
  body=true;lines++;
  const match=CEDICT_LINE.exec(line),glosses=match?match[4].split('/').map(gloss=>gloss.trim().normalize('NFC')).filter(Boolean):[];
  if(!match||!glosses.length||codePointsOf(match[1]).length!==codePointsOf(match[2]).length){skipped++;continue;}
  entries.push({trad:match[1],simp:match[2],pinyin:match[3].trim().replace(/\s+/gu,' '),glosses});
 }
 if(meta.format!=='ts')throw new Error(`${name}: cần tệp định dạng "ts" (truyền thống + giản thể), tệp ghi "${meta.format||'không rõ'}".`);
 if(String(meta.charset||'').toUpperCase()!=='UTF-8')throw new Error(`${name}: cần mã hóa UTF-8, tệp ghi "${meta.charset||'không rõ'}".`);
 if(!lines||skipped>lines*0.001)throw new Error(`${name}: ${skipped}/${lines} dòng sai định dạng CEDICT.`);
 return {header:header.join('\n'),meta,entries,skipped};
}

function csvFields(line){
 const fields=[];let field='',quoted=false;
 for(let i=0;i<line.length;i++){
  const char=line[i];
  if(quoted){if(char==='"'){if(line[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=char;}
  else if(char==='"')quoted=true;else if(char===','){fields.push(field);field='';}else field+=char;
 }
 fields.push(field);return fields;
}
// hanviet.csv rows: 行,"['hành', 'hạnh']",xing2 (traditional character, Python list, numbered pinyin or * for any).
// → Map(character → Map(lower-case pinyin or '*' → readings)).
export function parseHanviet(csv){
 const map=new Map();
 for(const raw of String(csv).replace(/^\uFEFF/u,'').split('\n')){
  const line=raw.replace(/\r$/u,'');if(!line.trim())continue;
  const [char='',list='',pinyin='']=csvFields(line),key=pinyin.trim().toLowerCase();
  if(char==='char'&&key==='pinyin')continue;
  const readings=unique([...list.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(match=>(match[1]??match[2]).trim().normalize('NFC')).filter(Boolean));
  if(!readings.length||!key||codePointsOf(char).length!==1)continue;
  if(!map.has(char))map.set(char,new Map());
  const byPinyin=map.get(char);byPinyin.set(key,unique([...(byPinyin.get(key)||[]),...readings]));
 }
 return map;
}

// UAX #38 value syntax, checked after NFD so tone-marked and plain letters both validate. Revision 41 changed the
// delimiter of several fields, so values are split on any whitespace.
const MANDARIN=/^[a-z\u0300\u0301\u0302\u0304\u0308\u030C]+$/u,RS_UNICODE=/^[1-9]\d{0,2}'{0,3}\.-?\d{1,2}$/u,CODE_POINT=/^U\+([0-9A-F]{4,6})$/u;
const UNIHAN_FIELDS=new Set(['kMandarin','kDefinition','kVietnamese','kHanyuPinlu','kSimplifiedVariant','kTraditionalVariant','kTotalStrokes','kRSUnicode']);
const fromCode=hex=>{const point=parseInt(hex,16);return point<=0x10FFFF?String.fromCodePoint(point):'';};
// files: {readings, variants, irg} = Unihan_Readings.txt, Unihan_Variants.txt, Unihan_IRGSources.txt.
export function parseUnihan(files){
 const chars=new Map();
 const row=char=>{let item=chars.get(char);if(!item){item={mandarin:[],definition:'',vietnamese:[],pinlu:null,simp:[],trad:[],strokes:0,rs:''};chars.set(char,item);}return item;};
 for(const text of [files?.readings,files?.variants,files?.irg])for(const raw of String(text||'').split('\n')){
  if(!raw.startsWith('U+'))continue;
  const [code,field,value='']=raw.replace(/\r$/u,'').split('\t');if(!UNIHAN_FIELDS.has(field))continue;
  const char=CODE_POINT.test(code)?fromCode(code.slice(2)):'';if(!char)continue;
  const item=row(char),values=value.trim().split(/\s+/u).filter(Boolean);
  if(field==='kDefinition')item.definition=value.trim().normalize('NFC');
  else if(field==='kMandarin')item.mandarin=values.filter(v=>MANDARIN.test(v.normalize('NFD'))).map(v=>v.normalize('NFC'));
  else if(field==='kVietnamese')item.vietnamese=unique(values.filter(v=>/^[\p{L}\p{M}]+$/u.test(v)).map(v=>v.normalize('NFC')));
  else if(field==='kHanyuPinlu')for(const v of values){const match=/^([^()]+)\((\d+)\)$/u.exec(v);if(match&&MANDARIN.test(match[1].normalize('NFD')))(item.pinlu??=new Map()).set(match[1].normalize('NFC'),Number(match[2]));}
  else if(field==='kSimplifiedVariant'||field==='kTraditionalVariant'){const list=unique(values.map(v=>CODE_POINT.exec(v)?.[1]).filter(Boolean).map(fromCode).filter(Boolean));if(field==='kSimplifiedVariant')item.simp=list;else item.trad=list;}
  else if(field==='kTotalStrokes'){const strokes=Number(values[0]);if(Number.isInteger(strokes)&&strokes>0)item.strokes=strokes;}
  else if(field==='kRSUnicode')item.rs=values.find(v=>RS_UNICODE.test(v))||'';
 }
 return chars;
}
// CJKRadicals.txt: "167'; 2ED0; 9485" → Map("167'" → {radical:'⻐', ideograph:'钅'}).
export function parseRadicals(text){
 const map=new Map();
 for(const raw of String(text||'').split('\n')){
  const [key='',radical='',ideograph='']=raw.replace(/#.*/u,'').split(';').map(part=>part.trim());
  if(!/^[1-9]\d{0,2}'{0,3}$/u.test(key)||!/^[0-9A-F]{4,6}$/u.test(ideograph))continue;
  map.set(key,{radical:/^[0-9A-F]{4,6}$/u.test(radical)?fromCode(radical):'',ideograph:fromCode(ideograph)});
 }
 return map;
}

// CVDICT is CC-CEDICT (2024) with Vietnamese glosses. Matching order: exact (traditional, simplified, pinyin); then
// case-insensitive pinyin, one-to-one among unused entries; then one unused entry of the same headword; then one
// unused entry of the same simplified form and pinyin (traditional form corrected since). Case matters first, so the
// surname 乐 [Le4] never takes the Vietnamese of 乐 [le4] "vui". CVDICT words whose two forms are both absent from
// CC-CEDICT are kept as Vietnamese-only entries; other leftovers are ambiguous and dropped.
export function mergeVietnamese(cedict,cvdict){
 const vi=new Array(cedict.length).fill(null),used=new Uint8Array(cvdict.length),stats={exact:0,caseless:0,headword:0,simplified:0,viOnly:0,dropped:0};
 const exact=new Map();
 cvdict.forEach((entry,j)=>{const key=`${entry.trad}\t${entry.simp}\t${entry.pinyin}`;if(!exact.has(key))exact.set(key,[]);exact.get(key).push(j);});
 cedict.forEach((entry,i)=>{const j=exact.get(`${entry.trad}\t${entry.simp}\t${entry.pinyin}`)?.shift();if(j!==undefined){vi[i]=cvdict[j].glosses;used[j]=1;stats.exact++;}});
 function pairUnique(keyOf,stat){
  const left=new Map(),right=new Map(),add=(map,key,index)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(index);};
  cedict.forEach((entry,i)=>{if(vi[i]===null)add(left,keyOf(entry),i);});
  cvdict.forEach((entry,j)=>{if(!used[j])add(right,keyOf(entry),j);});
  for(const [key,[i,...more]] of left){const match=right.get(key);if(more.length||match?.length!==1)continue;vi[i]=cvdict[match[0]].glosses;used[match[0]]=1;stats[stat]++;}
 }
 pairUnique(entry=>`${entry.trad}\t${entry.simp}\t${entry.pinyin.toLowerCase()}`,'caseless');
 pairUnique(entry=>`${entry.trad}\t${entry.simp}`,'headword');
 pairUnique(entry=>`${entry.simp}\t${entry.pinyin.toLowerCase()}`,'simplified');
 const forms=new Set(cedict.flatMap(entry=>[entry.trad,entry.simp])),viOnly=[];
 cvdict.forEach((entry,j)=>{if(used[j])return;if(forms.has(entry.trad)||forms.has(entry.simp)){stats.dropped++;return;}viOnly.push({trad:entry.trad,simp:entry.simp,pinyin:entry.pinyin,glosses:[],vi:entry.glosses});stats.viOnly++;});
 return {vi,viOnly,stats};
}

// Hán Việt reading(s) of one traditional character for one numbered syllable: exact pinyin, then '*' (any reading),
// then for a neutral tone (zuo5) the reading its toned forms agree on; else null. No guess across tones or syllables:
// measured on CC-CEDICT, those guesses were often wrong (台 tai1 is thai, not đài; 佛 fu2 is phất, not phật), and an
// unknown syllable shows as "—" rather than a wrong reading.
export function hanVietOf(hanviet,char,syllable){
 const map=hanviet.get(char);if(!map)return null;
 const key=String(syllable||'').toLowerCase();
 if(map.has(key))return map.get(key);
 if(map.has('*'))return map.get('*');
 if(!key.endsWith('5'))return null;
 const base=key.slice(0,-1),same=[...map].filter(([k])=>k.replace(/[1-4]$/u,'')===base);
 return same.length&&new Set(same.map(([,list])=>list[0])).size===1?same[0][1]:null;
}
// One token per character, space-separated: the first reading of each syllable ("ngân hàng"), every reading for a
// single character ("hành/hạnh"), "_" when unknown or not a Han character, "" when the syllables do not line up.
export function entryHanViet({trad,simp,pinyin},hanviet,isHanChar){
 const tradChars=codePointsOf(trad),simpChars=codePointsOf(simp),parts=syllables(pinyin),single=tradChars.length===1;
 if(tradChars.length!==parts.length)return '';
 return tradChars.map((char,k)=>{
  if(!isHanChar(char)&&!isHanChar(simpChars[k]))return '_';
  const readings=hanVietOf(hanviet,char,parts[k])||hanVietOf(hanviet,simpChars[k],parts[k]);
  return readings?(single?readings.join('/'):readings[0]):'_';
 }).join(' ');
}

const LEADING_NOTES=String.raw`^(?:\([^)]*\)\s*)*`;
const SURNAME_EN=new RegExp(`${LEADING_NOTES}surname\\b`,'iu'),SURNAME_VI=new RegExp(`${LEADING_NOTES}họ (?:\\[|\\p{Lu})`,'u');
// Pointers name another word ("see 送行[song4 xing2]", "used in 道行"); "see you later", "see-saw" and "used in
// questions" are real senses.
const VARIANT_EN=new RegExp(`${LEADING_NOTES}(?:(?:(?:old|archaic|ancient|obsolete|Japanese|Korean|erhua|non-standard|nonstandard|unofficial|dialectal|literary)\\s+)*(?:variant|form) of\\b|used in\\s+(?:\\p{Script=Han}|(?:the\\s+)?(?:(?:place|old|personal|given)\\s+)?names?\\b|(?:the\\s+)?(?:phonetic\\s+)?(?:transliteration|transcription)\\b)|see\\s+(?:also\\s+)?\\p{Script=Han}|also written\\b|same as\\b)`,'iu');
// \b is ASCII-only even with the u flag, so the Vietnamese pattern spells out its spaces.
const VARIANT_VI=new RegExp(`${LEADING_NOTES}(?:(?:biến thể|dị thể|dạng)(?:\\s+\\S+)*?\\s+của\\s|dùng trong\\s+(?:\\p{Script=Han}|tên|phiên âm)|xem\\s+(?:thêm\\s+)?\\p{Script=Han})`,'u');
// Minor senses go last: an entry whose every gloss is a surname, or only points at other words.
export function senseFlags(glossList,vietnamese=false){
 const senses=glossList.filter(gloss=>!/^(?:CL|LT):/u.test(gloss));if(!senses.length)return 0;
 const surname=vietnamese?SURNAME_VI:SURNAME_EN,variant=vietnamese?VARIANT_VI:VARIANT_EN;
 if(!senses.every(gloss=>surname.test(gloss)||variant.test(gloss)))return 0;
 return senses.some(gloss=>surname.test(gloss))?FLAG_SURNAME:FLAG_VARIANT;
}
const senseRank=flags=>flags&FLAG_SURNAME?2:flags&FLAG_VARIANT?1:0;
// Order of the entries of one headword: normal senses, then pointers, then surnames; a single character's readings by
// kHanyuPinlu frequency (else its kMandarin reading first); lower-case before proper-noun readings; then source order.
export function orderSenses(list,unihanRow=null){
 const single=list.length&&codePointsOf(list[0].simp).length===1;
 const score=entry=>{
  if(!single||!unihanRow)return 0;
  const syllable=markSyllable(syllables(entry.pinyin)[0])?.toLowerCase();if(!syllable)return 0;
  const count=unihanRow.pinlu?.get(syllable);
  return count!==undefined?count+2:unihanRow.mandarin[0]===syllable?1:0;
 };
 return list.map((entry,order)=>({entry,order,rank:senseRank(entry.flags),score:score(entry),proper:/^\p{Lu}/u.test(entry.pinyin)?1:0})).sort((a,b)=>a.rank-b.rank||b.score-a.score||a.proper-b.proper||a.order-b.order).map(({entry})=>entry);
}

// Traditional radical names where the character's usual reading is not the radical's name (長 is "bộ trường", not
// "trưởng"), or where the word list has no reading.
const RADICAL_NAMES={4:'phiệt',16:'kỷ',34:'truy',52:'yêu',78:'đãi',90:'tường',168:'trường',171:'đãi'};
// Hán Việt name of a Kangxi radical: the reading of its character for the kMandarin reading (行 xíng → hành), else via
// its traditional form (气 → 氣 khí). Simplified radicals (167' 钅) take the name of their base radical (167 金 → kim).
function radicalNames(radicals,hanviet,unihan){
 const reading=char=>{
  const map=hanviet.get(char);if(!map)return '';
  const mandarin=unihan.get(char)?.mandarin[0]||'',numbered=[...map.keys()].find(k=>k!=='*'&&markSyllable(k)?.toLowerCase()===mandarin);
  return (numbered?map.get(numbered):map.get('*')||[...map.values()][0])?.[0]||'';
 };
 const names={};
 for(const [key,{ideograph}] of [...radicals].sort(([a],[b])=>parseInt(a)-parseInt(b)||a.length-b.length)){
  const number=key.replace(/'+$/u,''),base=radicals.get(number)?.ideograph||ideograph;
  const name=RADICAL_NAMES[number]||reading(base)||(unihan.get(base)?.trad||[]).map(reading).find(Boolean)||'';
  names[key]=name?[ideograph,name]:[ideograph];
 }
 return names;
}

// The rebuild key: changes when the format, the builder code or any source file changes. The URL id changes only
// when the built files change (it hashes them), so browsers may cache every file under v/<id>/ forever.
export const dictionaryKey=({builder,sources})=>sha256(JSON.stringify({format:DICT_FORMAT,indexBuckets:INDEX_BUCKETS,entryBuckets:ENTRY_BUCKETS,builder,sources:sources.map(source=>source.sha256)})).slice(0,16);

// texts: {cedict, cvdict, hanviet, hanvietLicense, unihanReadings, unihanVariants, unihanIrg, radicals}
// sources: [{key, name, version?, license, url, bytes, sha256}] as pinned in prepare-dictionary.mjs.
export function buildDictionary({texts,sources=[],builder='dev'}){
 const cedict=parseCedict(texts.cedict,{name:'CC-CEDICT'}),cvdict=parseCedict(texts.cvdict,{name:'CVDICT'});
 const hanviet=parseHanviet(texts.hanviet),unihan=parseUnihan({readings:texts.unihanReadings,variants:texts.unihanVariants,irg:texts.unihanIrg}),radicals=parseRadicals(texts.radicals);
 const merged=mergeVietnamese(cedict.entries,cvdict.entries),isHanChar=isHan;
 const all=[...cedict.entries.map((entry,i)=>({trad:entry.trad,simp:entry.simp,pinyin:entry.pinyin,en:entry.glosses,vi:merged.vi[i]||[]})),...merged.viOnly.map(entry=>({trad:entry.trad,simp:entry.simp,pinyin:entry.pinyin,en:[],vi:entry.vi,viOnly:true}))];
 let unknownChars=0,hanChars=0,misaligned=0;
 for(const entry of all){
  entry.hanViet=entryHanViet(entry,hanviet,isHanChar);
  const tradChars=codePointsOf(entry.trad);
  if(!entry.hanViet)misaligned++;else for(const [k,token] of entry.hanViet.split(' ').entries())if(isHanChar(tradChars[k])){hanChars++;if(token==='_')unknownChars++;}
  entry.flags=(entry.viOnly?FLAG_VI_ONLY:0)|(entry.en.length?senseFlags(entry.en):senseFlags(entry.vi,true));
 }
 const bySimp=new Map();for(const entry of all){if(!bySimp.has(entry.simp))bySimp.set(entry.simp,[]);bySimp.get(entry.simp).push(entry);}
 for(const [simp,list] of bySimp)bySimp.set(simp,orderSenses(list,codePointsOf(simp).length===1?unihan.get(simp):null));
 const shards=Array.from({length:ENTRY_BUCKETS},()=>({c:new Map(),w:new Map(),t:new Map()}));
 const rankOfTarget=(trad,simp)=>Math.min(...bySimp.get(simp).filter(entry=>entry.trad===trad).map(entry=>senseRank(entry.flags)));
 const targets=new Map();
 for(const [simp,list] of bySimp){
  shards[entryBucket(simp)].w.set(simp,list.map(entry=>{const item=[entry.trad===simp?'':entry.trad,entry.pinyin,entry.hanViet,entry.en.join('/'),entry.vi.join('/')];if(entry.flags)item.push(entry.flags);return item;}));
  for(const entry of list)if(entry.trad!==simp){if(!targets.has(entry.trad))targets.set(entry.trad,new Set());targets.get(entry.trad).add(simp);}
 }
 // A traditional headword with several simplified forms lists the one with major senses first (乾 → 干 dry, 乾 heaven).
 for(const [trad,set] of targets)shards[entryBucket(trad)].t.set(trad,[...set].sort((a,b)=>rankOfTarget(trad,a)-rankOfTarget(trad,b)||byText(a,b)).join('|'));
 // Per-character rows, lean for characters that have their own entries (the entries carry pinyin and Hán Việt).
 const singles=new Map();for(const entry of all)if(codePointsOf(entry.simp).length===1)for(const form of unique([entry.simp,entry.trad])){if(!singles.has(form))singles.set(form,[]);singles.get(form).push(entry);}
 const headwordChars=new Set();for(const entry of all)for(const char of codePointsOf(entry.simp+entry.trad))if(isHanChar(char))headwordChars.add(char);
 let charCount=0;
 for(const char of [...new Set([...unihan.keys(),...hanviet.keys(),...headwordChars])].sort(byText)){
  const row=unihan.get(char),own=singles.get(char)||[],ownMap=hanviet.get(char)||(row?.trad||[]).map(variant=>hanviet.get(variant)).find(Boolean);
  if(!own.length&&!ownMap&&!row?.mandarin.length&&!row?.definition&&!row?.vietnamese.length&&!headwordChars.has(char))continue;
  let map=0;
  if(!own.length&&ownMap)map=Object.fromEntries([...ownMap].sort(([a],[b])=>byText(a,b)));
  else if(row?.vietnamese.length&&(!own.length||own.every(entry=>!entry.hanViet||entry.hanViet==='_')))map={u:row.vietnamese};
  const record=[own.length?'':(row?.mandarin||[]).join(' '),map,own.length?'':row?.definition||'',(row?.simp||[]).filter(v=>v!==char).join(''),(row?.trad||[]).filter(v=>v!==char).join(''),row?.strokes||0,row?.rs||''];
  while(record.length&&!record.at(-1))record.pop();
  if(!record.length)continue;
  shards[entryBucket(char)].c.set(char,record);charCount++;
 }
 // Headword index and the script hints used to tell simplified from traditional text.
 const index=Array.from({length:INDEX_BUCKETS},()=>new Map()),inSimp=new Set(),inTrad=new Set();let longest=0;
 for(const entry of all){
  for(const char of codePointsOf(entry.simp))if(isHanChar(char))inSimp.add(char);
  for(const char of codePointsOf(entry.trad))if(isHanChar(char))inTrad.add(char);
  for(const word of unique([entry.simp,entry.trad])){
   const chars=codePointsOf(word),first=chars[0],bucket=index[indexBucket(first)];longest=Math.max(longest,chars.length);
   if(!bucket.has(first))bucket.set(first,new Set());bucket.get(first).add(chars.slice(1).join(''));
  }
 }
 const files=new Map();
 index.forEach((bucket,b)=>{
  const words={};for(const first of [...bucket.keys()].sort(byText))words[first]=[...bucket.get(first)].sort(byText).join('|');
  const inBucket=set=>[...set].filter(char=>indexBucket(char)===b).sort(byText).join('');
  files.set(indexFile(b),JSON.stringify({h:words,t:inBucket([...inTrad].filter(char=>!inSimp.has(char))),s:inBucket([...inSimp].filter(char=>!inTrad.has(char)))}));
 });
 shards.forEach((shard,b)=>{
  const object=map=>Object.fromEntries([...map].sort(([a],[b])=>byText(a,b)));
  files.set(entryFile(b),JSON.stringify({c:object(shard.c),w:object(shard.w),t:object(shard.t)}));
 });
 const counts={entries:all.length,headwords:[...index].reduce((sum,bucket)=>sum+[...bucket.values()].reduce((s,set)=>s+set.size,0),0),chars:charCount,vietnamese:all.filter(entry=>entry.vi.length).length,vietnameseOnly:merged.viOnly.length,hanVietChars:hanChars,hanVietUnknown:unknownChars,misaligned};
 files.set('LICENSE.txt',licenseText({cedict,cvdict,sources,hanvietLicense:texts.hanvietLicense}));
 const hash=createHash('sha256');for(const path of [...files.keys()].sort(byText))hash.update(`${path}\0`).update(files.get(path)).update('\0');
 const id=hash.digest('hex').slice(0,12);
 const manifest={format:DICT_FORMAT,id,key:dictionaryKey({builder,sources}),base:`/vendor/dict/v/${id}/`,indexBuckets:INDEX_BUCKETS,entryBuckets:ENTRY_BUCKETS,maxWord:MAX_WORD,longest,counts,radicals:radicalNames(radicals,hanviet,unihan),sources:sources.map(({name,version,license,url,sha256:hash})=>({name,version,license,url,sha256:hash})),license:'LICENSE.txt'};
 return {id,manifest,files,stats:{...counts,match:merged.stats,skipped:{cedict:cedict.skipped,cvdict:cvdict.skipped}}};
}

// Unicode License v3, verbatim (https://www.unicode.org/license.txt, 1,995 bytes, sha256 e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96).
// Embedded because the hosted copy changes its copyright year every release.
export const UNICODE_LICENSE=`UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
`;
const sourceLine=source=>source?`${source.name}${source.version?` ${source.version}`:''}\n  ${source.url}\n  ${source.bytes} byte, sha256 ${source.sha256}`:'';
// LICENSE.txt deployed next to the shards. CC BY-SA 4.0 §3: credit, licence URI, a note of the changes; §3(b) and §4:
// this adapted database is released under the same licence with no added restrictions. MIT and Unicode License v3 ask
// for their notices to travel with copies.
export function licenseText({cedict,cvdict,sources,hanvietLicense,unicodeLicense=UNICODE_LICENSE}){
 const source=key=>sources.find(item=>item.key===key);
 return `Hoa Trí — dữ liệu tra cứu chữ Hán / Chinese character lookup data

Các tệp JSON trong thư mục này là cơ sở dữ liệu phái sinh (Adapted Material) của CC-CEDICT và CVDICT, phát hành theo CC BY-SA 4.0 https://creativecommons.org/licenses/by-sa/4.0/ ; không có bảo đảm.
The JSON files in this folder are Adapted Material of CC-CEDICT and CVDICT, released under CC BY-SA 4.0 https://creativecommons.org/licenses/by-sa/4.0/ ; no warranties.
Bạn được tự do sao chép, phân phối lại và chỉnh sửa theo đúng giấy phép đó. / You may copy, redistribute and adapt them under that licence.

Thay đổi: chuyển định dạng sang JSON chia theo chữ đầu; ghép nghĩa tiếng Việt CVDICT vào mục CC-CEDICT cùng chữ và pinyin; thêm âm Hán Việt theo pinyin và thông tin chữ Unihan; sắp xếp lại thứ tự âm đọc.
Changes: converted to JSON sharded by first character; merged the CVDICT Vietnamese glosses into the CC-CEDICT entries with the same characters and pinyin; added Hán Việt readings by pinyin and Unihan character data; reordered readings.

Nghĩa tiếng Việt của CVDICT phần lớn được dịch tự động từ CC-CEDICT và mới rà soát một phần. / CVDICT's Vietnamese glosses are mostly machine-translated from CC-CEDICT and only partly reviewed.

1. CC-CEDICT — MDBG and the CC-CEDICT contributors; CEDICT © 1997, 1998 Paul Andrew Denisowski. CC BY-SA 4.0.
${sourceLine(source('cedict'))}
${cedict.header}

2. CVDICT — Phong Phan (https://github.com/ph0ngp/CVDICT), based on CC-CEDICT. CC BY-SA 4.0.
${sourceLine(source('cvdict'))}
${cvdict.header}

3. hanviet-pinyin-wordlist — Phong Phan (https://github.com/ph0ngp/hanviet-pinyin-wordlist): Hán Việt readings by pinyin. MIT License.
${sourceLine(source('hanviet'))}

${String(hanvietLicense||'').trim()}

4. Unicode Han Database (Unihan) and CJKRadicals.txt — Unicode, Inc.: Mandarin readings, kVietnamese, definitions, variants, strokes and radicals. Unicode License v3.
${sourceLine(source('unihan'))}
${sourceLine(source('radicals'))}

${String(unicodeLicense||'').trim()}
`;
}
