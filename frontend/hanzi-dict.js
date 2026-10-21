// Chinese character lookup core, shared by the browser panel (hanzi-lookup.js) and the offline build
// (backend/dictionary-build.js): data layout, pinyin display, word picking, the card model and the shard loader.
// No DOM access, so Node tests and the build import it directly.
export const DICT_FORMAT=1,INDEX_BUCKETS=256,ENTRY_BUCKETS=1024,MAX_WORD=8,WINDOW=4,LONGEST=19;
export const MANIFEST_URL='/vendor/dict/manifest.json';
const BASE=/^\/vendor\/dict\/v\/[a-f\d]{12}\/$/u;
// Entry flags: Vietnamese only (CVDICT word missing from CC-CEDICT), and the two minor-sense ranks shown last.
export const FLAG_VI_ONLY=1,FLAG_VARIANT=2,FLAG_SURNAME=4;
export const indexBucket=text=>text.codePointAt(0)%INDEX_BUCKETS;
export const entryBucket=text=>text.codePointAt(0)%ENTRY_BUCKETS;
export const indexFile=bucket=>`i/${bucket.toString(16).padStart(2,'0')}.json`;
export const entryFile=bucket=>`e/${bucket.toString(16).padStart(3,'0')}.json`;
const HAN=/\p{Script=Han}/u,ONE_HAN=/^\p{Script=Han}$/u;
// Characters a dictionary word may contain: CC-CEDICT also has 卡拉OK, X光, 3C, 卡尔·马克思 and 一不做，二不休.
const WORD_CHAR=/^(?:\p{Script=Han}|[A-Za-z0-9·，])$/u;
export const isHan=char=>ONE_HAN.test(char||'');
export const hasHan=text=>HAN.test(String(text??''));
export const isWordChar=char=>WORD_CHAR.test(char||'');
const firstOf=text=>String.fromCodePoint(text.codePointAt(0));

// Code points with their UTF-16 offsets, so astral characters (U+20000 𠀀) keep correct positions in DOM text and
// textareas.
export function codePoints(text){
 const chars=[],offsets=[];let offset=0;
 for(const char of String(text??'')){chars.push(char);offsets.push(offset);offset+=char.length;}
 return {chars,offsets};
}

const TONE_MARKS=['\u0304','\u0301','\u030C','\u0300'];
// One numbered CC-CEDICT syllable with its tone mark: "lu:e4" → "lüè", "ng2" → "ńg", "r5" → "r", "xx5" → "?".
// Marks are combined then NFC-normalised, so syllabic n/m get ń ň ǹ ḿ (precomposed) and n̄ m̄ m̌ m̀ (no precomposed form).
export function markSyllable(token){
 const match=/^([A-Za-z:]+)([1-5])$/u.exec(String(token||''));if(!match)return null;
 const letters=match[1].replace(/u:/gu,'ü').replace(/U:/gu,'Ü'),tone=Number(match[2]);
 if(letters.includes(':'))return null;
 if(/^xx$/iu.test(letters))return '?';
 if(tone===5)return letters;
 const lower=letters.toLowerCase();let at=lower.search(/[ae]/u);
 if(at<0)at=lower.indexOf('ou');
 if(at<0)for(let k=lower.length-1;k>=0;k--)if('iouü'.includes(lower[k])){at=k;break;}
 if(at<0)at=lower.search(/[nm]/u);
 if(at<0)return letters;
 return (letters.slice(0,at+1)+TONE_MARKS[tone-1]+letters.slice(at+1)).normalize('NFC');
}
export const syllables=numbered=>String(numbered??'').trim().split(/\s+/u).filter(Boolean);
// A whole CC-CEDICT reading as one word: "Xi1 an1" → "Xī'ān", "na3 r5" → "nǎr", "yi1 bu4 zuo4 , er4 bu4 xiu1" →
// "yībùzuò, èrbùxiū", "Bei3 jing1 Da4 xue2" → "Běijīng Dàxué". Tokens that are not syllables are kept as written.
export function markPinyin(numbered){
 let out='',previous='';
 for(const token of syllables(numbered)){
  const syllable=markSyllable(token);
  if(syllable!==null){
   if(/^r5$/iu.test(token)&&previous==='syllable'){out+='r';continue;}
   const initial=syllable.normalize('NFD')[0];
   if(previous==='syllable')out+=/[aoe]/iu.test(initial)?"'":/\p{Lu}/u.test(initial)?' ':'';
   else if(previous)out+=' ';
   out+=syllable;previous='syllable';continue;
  }
  if(token===','||token==='，'){out+=',';previous='punct';continue;}
  if(token==='·'){out+=out?' · ':'· ';previous='';continue;}
  out+=(previous?' ':'')+token;previous='word';
 }
 return out;
}

// "個|个[ge4]" → "个 (gè)" (or "個 (gè)" in traditional text); a bare "[Le4]" → "Lè".
const REFERENCE=/([^\s[\]()（）,，;；:"“”/]*)\[([A-Za-z0-9:·,' ]+)\]/gu;
export function rewriteReferences(text,traditional=false){
 return String(text??'').replace(REFERENCE,(match,word,pinyin)=>{
  const [trad,simp=trad]=word.split('|'),chosen=traditional?trad:simp,marked=markPinyin(pinyin);
  return chosen?`${chosen} (${marked})`:marked;
 });
}
// CEDICT gloss field ("a/b/CL:家[jia1],個|个[ge4]") → senses plus classifiers (CVDICT writes "LT:").
export function glosses(text,{traditional=false}={}){
 const senses=[],classifiers=[];
 for(const raw of String(text??'').split('/')){
  const gloss=raw.trim();if(!gloss)continue;
  const classifier=/^(?:CL|LT):\s*(.*)$/u.exec(gloss);
  if(!classifier){senses.push(rewriteReferences(gloss,traditional));continue;}
  for(const item of classifier[1].split(/,(?![^[]*\])/u))if(item.trim())classifiers.push(rewriteReferences(item.trim(),traditional));
 }
 return {senses,classifiers};
}

// index: Map(first character → Set of suffixes), "" meaning the character alone is a headword.
export function indexHas(index,word){
 if(!word)return false;const first=firstOf(word);
 return Boolean(index.get(first)?.has(word.slice(first.length)));
}
// Fewest words, then fewest one-character words, then the longer first word. Single characters always count as
// words, so unknown text still segments. Returns [[start,end],…] over chars[from..to).
export function segment(chars,from,to,has,{maxLength=MAX_WORD}={}){
 const size=to-from,best=new Array(size+1).fill(null);best[0]={words:0,singles:0,first:0,cuts:[]};
 for(let i=0;i<size;i++){
  const current=best[i];if(!current)continue;
  for(let length=Math.min(maxLength,size-i);length>=1;length--){
   if(length>1&&!has(chars.slice(from+i,from+i+length).join('')))continue;
   const next={words:current.words+1,singles:current.singles+(length===1),first:i===0?length:current.first,cuts:[...current.cuts,[from+i,from+i+length]]},old=best[i+length];
   if(!old||next.words<old.words||next.words===old.words&&(next.singles<old.singles||next.singles===old.singles&&next.first>old.first))best[i+length]=next;
  }
 }
 return best[size]?.cuts||[];
}
// The characters whose index files a tap at chars[i] needs: up to `radius` word characters on each side.
export function lookupWindow(chars,i,{radius=WINDOW}={}){
 let from=i,to=i+1;
 while(from>0&&i-from<radius&&isWordChar(chars[from-1]))from--;
 while(to<chars.length&&to-i<=radius&&isWordChar(chars[to]))to++;
 return {from,to};
}
function runEnd(chars,start,longest){let end=start+1;while(end<chars.length&&end-start<longest&&isWordChar(chars[end]))end++;return end;}
// Longest dictionary word chars[start..e) with e > minEnd, or minEnd when there is none.
function extend(chars,start,minEnd,has,longest){
 for(let end=runEnd(chars,start,longest);end>minEnd;end--)if(has(chars.slice(start,end).join('')))return end;
 return minEnd;
}
// Every dictionary word of two or more characters that covers chars[i] and starts inside the window (whose index files
// are loaded), plus the single character; longest first.
export function coveringWords(chars,i,has,{radius=WINDOW,longest=LONGEST}={}){
 const {from}=lookupWindow(chars,i,{radius}),found=[];
 for(let start=from;start<=i;start++){
  const limit=runEnd(chars,start,longest);
  for(let end=i+1;end<=limit;end++)if(end-start>=2&&has(chars.slice(start,end).join('')))found.push([start,end]);
 }
 found.push([i,i+1]);
 return found.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0])||a[0]-b[0]);
}
// The word a tap on chars[i] means: DP segmentation of the ±radius window; a word cut by the right edge of the window is
// extended to the longest dictionary word. alternatives are the other covering words (see coveringWords).
export function pickWord(chars,i,has,{radius=WINDOW,maxLength=MAX_WORD,longest=LONGEST}={}){
 if(!isWordChar(chars[i]))return {start:i,end:i+1,alternatives:[]};
 const {from,to}=lookupWindow(chars,i,{radius});
 let [start,end]=segment(chars,from,to,has,{maxLength}).find(([s,e])=>s<=i&&i<e)||[i,i+1];
 if(end===to&&isWordChar(chars[to]))end=extend(chars,start,end,has,longest);
 const alternatives=coveringWords(chars,i,has,{radius,longest}).filter(([s,e])=>s!==start||e!==end);
 return {start,end,alternatives};
}
// The span whose index files "Từ trước" / "Từ sau" needs: the next (dir 1) or previous (dir -1) Han character after
// the current word, plus 2×radius word characters beyond it. null at the edge of the text.
export function neighborWindow(chars,start,end,dir,{radius=WINDOW}={}){
 if(dir>0){
  let anchor=end;while(anchor<chars.length&&!isHan(chars[anchor]))anchor++;if(anchor>=chars.length)return null;
  let to=anchor+1;while(to<chars.length&&to-anchor<=2*radius&&isWordChar(chars[to]))to++;
  return {anchor,from:anchor,to};
 }
 let anchor=start-1;while(anchor>=0&&!isHan(chars[anchor]))anchor--;if(anchor<0)return null;
 let from=anchor;while(from>0&&anchor-from<2*radius&&isWordChar(chars[from-1]))from--;
 return {anchor,from,to:anchor+1};
}
export function neighborWord(chars,start,end,dir,has,{radius=WINDOW,maxLength=MAX_WORD,longest=LONGEST}={}){
 const span=neighborWindow(chars,start,end,dir,{radius});if(!span)return null;
 const cuts=segment(chars,span.from,span.to,has,{maxLength});
 if(dir<0){const [s,e]=cuts.at(-1);return {start:s,end:e};}
 let [s,e]=cuts[0];if(e===span.to&&isWordChar(chars[span.to]))e=extend(chars,s,e,has,longest);
 return {start:s,end:e};
}

// Entry tuple [traditional or "", numbered pinyin, Hán Việt, English, Vietnamese, flags?] stored under its
// simplified headword; t maps a traditional headword to its simplified headwords ("银行" or "干|乾").
export const expandEntry=(simp,item)=>({simp,trad:item[0]||simp,pinyin:item[1]||'',hanViet:item[2]||'',en:item[3]||'',vi:item[4]||'',flags:item[5]||0});
export async function entriesFor(word,shard,getShard){
 const found=(shard?.w?.[word]||[]).map(item=>expandEntry(word,item));
 const targets=String(shard?.t?.[word]||'').split('|').filter(Boolean);
 const shards=await Promise.all(targets.map(simp=>entryBucket(simp)===entryBucket(word)?shard:getShard(simp)));
 targets.forEach((simp,k)=>{for(const item of shards[k]?.w?.[simp]||[])if(item[0]===word)found.push(expandEntry(simp,item));});
 return found;
}

const rank=entry=>entry.flags&FLAG_SURNAME?2:entry.flags&FLAG_VARIANT?1:0;
// Stored tokens line up with the word's characters: "_" is unknown ("—"), or a non-Han character shown as itself
// (卡拉OK → "ca lạp O K", 一不做，二不休 → "nhất bất tố, nhị bất hưu").
function hanVietText(value,wordChars){
 const tokens=String(value||'').split(' ').filter(Boolean);
 if(tokens.length!==wordChars.length||tokens.every(token=>token==='_'))return '';
 if(tokens.length===1)return tokens[0].split('/').join(', ');
 return tokens.map((token,k)=>token!=='_'?token.split('/')[0]:isHan(wordChars[k])?'—':wordChars[k]==='，'?',':wordChars[k]).join(' ').replace(/ ,/gu,',');
}
const mapReadings=map=>[...new Set(Object.entries(map||{}).filter(([key])=>key!=='u').flatMap(([,list])=>list))];
// Plain view model of one lookup. entries come from entriesFor; record is the tapped character's Unihan row
// [kMandarin, Hán Việt map|0, kDefinition, simplified variants, traditional variants, strokes, kRSUnicode];
// script is 'zh-Hans' / 'zh-Hant' from the surrounding text, or null when the text does not tell.
export function cardModel({chars,start,end,tapped=start,entries=[],record,radicals={},script=null,alternatives=[]}){
 const wordChars=chars.slice(start,end),word=wordChars.join(''),single=wordChars.length===1;
 const lang=script||(entries.some(e=>e.simp===word)||!entries.some(e=>e.trad===word)?'zh-Hans':'zh-Hant'),traditional=lang==='zh-Hant';
 const written=entry=>traditional?entry.trad===word:entry.simp===word;
 const ordered=entries.map((entry,order)=>({entry,order})).sort((a,b)=>written(b.entry)-written(a.entry)||rank(a.entry)-rank(b.entry)||a.order-b.order).map(({entry})=>entry);
 const unihan=record?.[1]?.u?.length?record[1].u.join(', '):'';
 const readings=ordered.map(entry=>{
  const en=glosses(entry.en,{traditional}),vi=glosses(entry.vi,{traditional}),form=traditional?entry.simp:entry.trad;
  let hanViet=hanVietText(entry.hanViet,wordChars),hanVietSource=hanViet?'list':'';
  if(!hanViet&&single&&unihan){hanViet=unihan;hanVietSource='unihan';}
  return {pinyin:markPinyin(entry.pinyin),numbered:entry.pinyin,hanViet,hanVietSource,vi:vi.senses,en:en.senses,classifiers:en.classifiers.length?en.classifiers:vi.classifiers,viOnly:Boolean(entry.flags&FLAG_VI_ONLY),minor:rank(entry)>0,form:form!==word?form:'',trad:entry.trad,simp:entry.simp};
 });
 const first=readings[0],otherForm=first?.form?{label:traditional?'Giản thể':'Phồn thể',text:first.form}:null;
 const parts=first?syllables(first.numbered):[],tokens=String(ordered[0]?.hanViet||'').split(' ');
 const aligned=parts.length===wordChars.length&&tokens.length===wordChars.length;
 // One character's own reading is lower case even inside a name (长江 Cháng Jiāng → 长 cháng).
 const perChar=single?[]:wordChars.map((char,k)=>({char,index:start+k,pinyin:aligned?(markSyllable(parts[k])??'').toLowerCase():'',hanViet:aligned&&tokens[k]!=='_'?tokens[k].split('/')[0]:''})).filter(row=>isHan(row.char));
 const [mandarin='',map=0,definition='',simplified='',traditionalForms='',strokes=0,rs='']=record||[];
 const rsMatch=/^(\d+'*)\.(-?\d+)$/u.exec(rs),radical=rsMatch&&radicals[rsMatch[1]];
 const tappedChar=chars[tapped]||'';
 return {
  word,start,end,index:tapped,lang,found:readings.length>0,otherForm,readings,perChar,
  tapped:record?{char:tappedChar,radical:radical?{key:rsMatch[1],char:radical[0],name:radical[1]||''}:null,strokes:Number(strokes)||0,traditional:traditionalForms.replace(tappedChar,''),simplified:simplified.replace(tappedChar,''),definition,mandarin,hanViet:map?.u?.length?map.u.join(', '):mapReadings(map).join(', '),hanVietSource:map?.u?.length?'unihan':'list'}:null,
  alternatives:alternatives.map(([s,e])=>({start:s,end:e,text:chars.slice(s,e).join('')}))
 };
}

export class DictionaryError extends Error{constructor(code,message){super(message||code);this.name='DictionaryError';this.code=code;}}
// Loader over the static files. Errors are DictionaryError with code 'missing' (not built or not deployed: a missing
// file is answered with an HTML page — the 404 page, or index.html on older deployments — so only JSON responses
// count) or 'network' (worth a retry).
export function createDictionary({fetch:fetcher=(...args)=>globalThis.fetch(...args),url=MANIFEST_URL,cacheSize=160}={}){
 let manifestPromise=null;
 const pending=new Map(),indexes=new Map(),entries=new Map(),hints={trad:new Set(),simp:new Set()};
 // A "missing" answer is asked once more with revalidation: a missing file gets an HTML page (the 404 page, or
 // index.html on older deployments), and under v/<id>/ it carries the year-long immutable header, so a browser would
 // otherwise keep that wrong answer.
 async function getJson(path,reload=false){
  let response;
  try{response=await fetcher(path,reload?{credentials:'same-origin',cache:'no-cache'}:{credentials:'same-origin'});}catch(error){throw new DictionaryError('network',error?.message);}
  const transient=response.status>=500||response.status===408||response.status===429;
  if(!transient&&(!response.ok||!/\bjson\b/iu.test(response.headers?.get?.('content-type')||''))){if(!reload)return getJson(path,true);throw new DictionaryError('missing',response.ok?'not JSON':`HTTP ${response.status}`);}
  if(!response.ok)throw new DictionaryError('network',`HTTP ${response.status}`);
  try{return await response.json();}catch(error){throw new DictionaryError('network',error?.message);}
 }
 function manifest(reload=false){
  manifestPromise??=getJson(url,reload).then(data=>{
   if(data?.format!==DICT_FORMAT||!/^[a-f\d]{12}$/u.test(data.id||'')||data.base!==`/vendor/dict/v/${data.id}/`||!BASE.test(data.base)||data.indexBuckets!==INDEX_BUCKETS||data.entryBuckets!==ENTRY_BUCKETS)throw new DictionaryError('missing','unsupported manifest');
   return data;
  }).catch(error=>{manifestPromise=null;throw error;});
  return manifestPromise;
 }
 // One request per file at a time; a failed request is forgotten so "Thử lại" fetches it again.
 function once(path){
  if(!pending.has(path))pending.set(path,getJson(path).finally(()=>pending.delete(path)));
  return pending.get(path);
 }
 // Only characters that can start a headword need their index file (not "，" or "·" inside idioms and names).
 async function indexFor(text){
  const {base}=await manifest(),buckets=[...new Set([...text].filter(char=>isHan(char)||/^[A-Za-z0-9]$/u.test(char)).map(indexBucket))].filter(bucket=>!indexes.has(bucket));
  await Promise.all(buckets.map(async bucket=>{
   const data=await once(base+indexFile(bucket));if(indexes.has(bucket))return;
   const words=new Map();for(const [first,suffixes] of Object.entries(data?.h||{}))words.set(first,suffixes);
   indexes.set(bucket,{words,sets:new Map()});
   for(const char of data?.t||'')hints.trad.add(char);for(const char of data?.s||'')hints.simp.add(char);
  }));
 }
 function has(word){
  if(!word)return false;const first=firstOf(word),bucket=indexes.get(indexBucket(first));if(!bucket)return false;
  let set=bucket.sets.get(first);
  if(!set){const suffixes=bucket.words.get(first);if(suffixes===undefined)return false;set=new Set(suffixes.split('|'));bucket.sets.set(first,set);}
  return set.has(word.slice(first.length));
 }
 async function shardFor(word){
  const bucket=entryBucket(word);
  if(entries.has(bucket)){const data=entries.get(bucket);entries.delete(bucket);entries.set(bucket,data);return data;}
  const {base}=await manifest(),data=await once(base+entryFile(bucket));
  entries.set(bucket,data);while(entries.size>cacheSize)entries.delete(entries.keys().next().value);
  return data;
 }
 function scriptOf(chars){
  let trad=0,simp=0;for(const char of chars){if(hints.trad.has(char))trad++;else if(hints.simp.has(char))simp++;}
  return trad>simp?'zh-Hant':simp>trad?'zh-Hans':null;
 }
 async function card(chars,start,end,tapped,alternatives,from,to){
  const {radicals}=await manifest(),word=chars.slice(start,end).join('');
  const [shard,own]=await Promise.all([shardFor(word),shardFor(chars[tapped])]);
  const list=await entriesFor(word,shard,shardFor);
  return cardModel({chars,start,end,tapped,entries:list,record:own?.c?.[chars[tapped]],radicals,script:scriptOf(chars.slice(Math.min(from,start),Math.max(to,end))),alternatives});
 }
 // A deploy replaces v/<id>/, so a tab opened before it gets "missing" for its old files: reload the manifest once and,
 // when it names a new build, retry with that build's files.
 async function current(task){
  try{return await task();}catch(error){
   const old=error?.code==='missing'&&await manifestPromise?.catch(()=>null);if(!old)throw error;
   manifestPromise=null;const next=await manifest(true);if(next.id===old.id)throw error;
   indexes.clear();entries.clear();hints.trad.clear();hints.simp.clear();
   return task();
  }
 }
 // The word around chars[index] (picked by pickWord), or the given [start,end) word for chips and per-character rows.
 const lookup=(chars,index,range=null)=>current(async()=>{
  const {longest=LONGEST}=await manifest(),{from,to}=lookupWindow(chars,index);
  await Promise.all([indexFor(chars.slice(from,to).join('')),shardFor(chars[index])]);
  if(range){const alternatives=coveringWords(chars,index,has,{longest}).filter(([s,e])=>s!==range.start||e!==range.end);return card(chars,range.start,range.end,index,alternatives,from,to);}
  const picked=pickWord(chars,index,has,{longest});
  return card(chars,picked.start,picked.end,index,picked.alternatives,from,to);
 });
 // Next (dir 1) or previous (dir -1) word, as {start,end}, or null at the edge of the text.
 const neighbor=(chars,start,end,dir)=>current(async()=>{
  const {longest=LONGEST}=await manifest(),span=neighborWindow(chars,start,end,dir);if(!span)return null;
  await indexFor(chars.slice(span.from,span.to).join(''));
  return neighborWord(chars,start,end,dir,has,{longest});
 });
 return {manifest:()=>manifest(),lookup,neighbor,has,licenseUrl:async()=>{const data=await manifest();return data.base+(data.license||'LICENSE.txt');}};
}
