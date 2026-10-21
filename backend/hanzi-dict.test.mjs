import test from 'node:test';
import assert from 'node:assert/strict';
import {markPinyin,markSyllable,glosses,rewriteReferences,segment,pickWord,coveringWords,neighborWord,lookupWindow,codePoints,isHan,hasHan,indexHas,indexBucket,entryBucket,indexFile,entryFile,entriesFor,cardModel,createDictionary,DictionaryError,FLAG_VARIANT,FLAG_SURNAME,FLAG_VI_ONLY} from '../frontend/hanzi-dict.js';
import {buildDictionary} from './dictionary-build.js';

const words=new Set(['研究','研究生','生命','起源','中国','中国人','国人','人民','南京','南京市','市长','长江','大桥','我们','银行','工作','空间','中点','点','卡拉OK','发展中国家','国家']);
const has=word=>words.has(word);
const pick=(text,char,options)=>{const {chars}=codePoints(text),i=chars.indexOf(char),{start,end,alternatives}=pickWord(chars,i,has,options);return {word:chars.slice(start,end).join(''),alternatives:alternatives.map(([s,e])=>chars.slice(s,e).join(''))};};

test('numbered pinyin gets tone marks, apostrophes, erhua and syllabic n/m right',()=>{
 for(const [numbered,marked] of [['Zhong1 guo2','Zhōngguó'],['lu:4','lǜ'],['nu:3 er2',"nǚ'ér"],['Xi1 an1',"Xī'ān"],['na3 r5','nǎr'],['yi1 bu4 zuo4 , er4 bu4 xiu1','yībùzuò, èrbùxiū'],['san1 C','sān C'],['ng2','ńg'],['m2','ḿ'],['n4','ǹ'],['m4','m̀'],['hm5','hm'],['Ka3 er3 · Ma3 ke4 si1',"Kǎ'ěr · Mǎkèsī"],['le5','le'],['lu:e4','lüè'],['gui4','guì'],['liu2','liú'],['lou2','lóu'],['xx5','?'],['Bei3 jing1 Da4 xue2','Běijīng Dàxué'],['A quan1 r5','A quānr']])
  assert.equal(markPinyin(numbered),marked,numbered);
 assert.equal(markPinyin('ng2'),'ńg','precomposed ń, never a stray combining mark');
 assert.equal(markPinyin('m2'),'ḿ');
 assert.equal(markSyllable('n1'),'n̄','no precomposed n̄: base letter plus combining macron');
 assert.equal(markSyllable('abc'),null);assert.equal(markSyllable('u:x:4'),null);
 assert.equal(markPinyin('foo bar2'),'foo bár','tokens that are not syllables stay as written');
});

test('glosses split senses, pull out CL:/LT: classifiers and rewrite cross-references',()=>{
 assert.deepEqual(glosses('bank/CL:家[jia1],個|个[ge4]'),{senses:['bank'],classifiers:['家 (jiā)','个 (gè)']});
 assert.deepEqual(glosses('ngân hàng/LT:家[jia1],個|个[ge4]',{traditional:true}).classifiers,['家 (jiā)','個 (gè)']);
 assert.equal(rewriteReferences('variant of 個|个[ge4]'),'variant of 个 (gè)');
 assert.equal(rewriteReferences('used in 自個兒|自个儿[zi4 ge3 r5]',true),'used in 自個兒 (zìgěr)');
 assert.equal(rewriteReferences('họ [Le4]'),'họ Lè');
 assert.equal(rewriteReferences('behavior; conduct (Taiwan pr. [xing4])'),'behavior; conduct (Taiwan pr. xìng)');
 assert.deepEqual(glosses(''),{senses:[],classifiers:[]});
});

test('word picking: windowed DP with fewest words, fewest single characters, longer first word',()=>{
 assert.deepEqual(pick('研究生命起源','生'),{word:'生命',alternatives:['研究生','生']});
 assert.equal(pick('中国人民','国').word,'中国');
 assert.equal(pick('南京市长江大桥','长').word,'长江');
 assert.ok(pick('南京市长江大桥','长').alternatives.includes('市长'));
 assert.equal(pick('我们在银行工作','行').word,'银行');
 assert.equal(pick('空间中点的位移','点').word,'中点');
 assert.equal(pick('卡拉OK','拉').word,'卡拉OK','Latin letters may belong to a dictionary word');
 assert.equal(pick('他是发展中国家','国').word,'发展中国家');
 assert.equal(pick('中国。人民','国').word,'中国','punctuation ends the window');
 assert.equal(pick('中国，人民','民').word,'人民');
});

test('a tap queries at most 9 first characters and a word cut by the window edge is extended',()=>{
 const asked=new Set(),{chars}=codePoints('一二三四五六七八九十');
 pickWord(chars,4,word=>{asked.add([...word][0]);return false;});
 assert.ok(asked.size<=9,`asked ${[...asked].join('')}`);
 assert.deepEqual(lookupWindow(chars,4),{from:0,to:9});
 const long=new Set(['发展中','发展中国家']),{chars:text}=codePoints('一二三四发展中国家');
 const {start,end,alternatives}=pickWord(text,4,word=>long.has(word),{radius:2});
 assert.equal(text.slice(start,end).join(''),'发展中国家','the window ends after 发展中, the longest dictionary word wins');
 const only=pickWord(text,4,word=>word==='发展中国家',{radius:2});
 assert.deepEqual([only.start,only.end],[4,5]);assert.deepEqual(only.alternatives,[[4,9]],'a longer word beyond the window is offered');
});

test('astral characters keep correct code point and UTF-16 offsets',()=>{
 const {chars,offsets}=codePoints('a𠀀中国');
 assert.deepEqual(chars,['a','𠀀','中','国']);assert.deepEqual(offsets,[0,1,3,4]);
 assert.ok(isHan('𠀀'));assert.ok(!isHan('a'));assert.ok(hasHan('vectơ 向量'));assert.ok(!hasHan('vectơ'));
 const {start,end}=pickWord(chars,2,has);assert.equal(chars.slice(start,end).join(''),'中国');
});

test('neighbour words move across the text and stop at its edges',()=>{
 const {chars}=codePoints('我们在银行工作。');
 assert.deepEqual(neighborWord(chars,3,5,1,has),{start:5,end:7});
 assert.deepEqual(neighborWord(chars,3,5,-1,has),{start:2,end:3});
 assert.deepEqual(neighborWord(chars,0,2,-1,has),null);
 assert.deepEqual(neighborWord(chars,5,7,1,has),null,'only punctuation after 工作');
 assert.deepEqual(coveringWords(chars,4,has).map(([s,e])=>chars.slice(s,e).join('')),['银行','行']);
});

test('bucket and file names follow the first code point',()=>{
 assert.equal(indexFile(indexBucket('一')),'i/00.json');assert.equal(entryFile(entryBucket('一')),'e/200.json');
 assert.equal(indexFile(indexBucket('银')),'i/f6.json');assert.equal(entryFile(entryBucket('银行')),'e/0f6.json');
 assert.ok(indexHas(new Map([['银',new Set(['','行'])]]),'银行'));assert.ok(!indexHas(new Map(),'银行'));
});

test('entriesFor resolves traditional headwords through one or several pointers',async()=>{
 const shards={[entryBucket('银')]:{w:{'银行':[['銀行','yin2 hang2','ngân hàng','bank','ngân hàng']]}},[entryBucket('干')]:{w:{'干':[['乾','gan1','can','dry',''],['幹','gan4','cán','to do','']]}},[entryBucket('乾')]:{w:{'乾':[['','qian2','càn','heaven','']]},t:{'乾':'干|乾'}},[entryBucket('銀')]:{t:{'銀行':'银行'}}};
 const get=word=>Promise.resolve(shards[entryBucket(word)]);
 const bank=await entriesFor('銀行',shards[entryBucket('銀')],get);
 assert.deepEqual(bank.map(entry=>[entry.simp,entry.trad,entry.pinyin]),[['银行','銀行','yin2 hang2']]);
 const dry=await entriesFor('乾',shards[entryBucket('乾')],get);
 assert.deepEqual(dry.map(entry=>entry.pinyin),['qian2','gan1'],'own entries, then the simplified 干 entry written 乾');
});

test('card model: Vietnamese before English, minor senses last, aligned per-character rows, Unihan facts',()=>{
 const {chars}=codePoints('我们在银行工作');
 const card=cardModel({chars,start:3,end:5,tapped:4,radicals:{'144':['行','hành']},record:['',0,'','','',6,'144.0'],alternatives:[[4,5]],entries:[
  {simp:'银行',trad:'銀行',pinyin:'yin2 hang2',hanViet:'ngân hàng',en:'bank/CL:家[jia1],個|个[ge4]',vi:'ngân hàng',flags:0}]});
 assert.equal(card.word,'银行');assert.equal(card.lang,'zh-Hans');assert.deepEqual(card.otherForm,{label:'Phồn thể',text:'銀行'});
 assert.deepEqual([card.start,card.end,card.index],[3,5,4]);
 const [reading]=card.readings;
 assert.equal(reading.pinyin,'yínháng');assert.equal(reading.hanViet,'ngân hàng');assert.deepEqual(reading.vi,['ngân hàng']);assert.deepEqual(reading.en,['bank']);assert.deepEqual(reading.classifiers,['家 (jiā)','个 (gè)']);
 assert.deepEqual(card.perChar,[{char:'银',index:3,pinyin:'yín',hanViet:'ngân'},{char:'行',index:4,pinyin:'háng',hanViet:'hàng'}]);
 assert.deepEqual(card.tapped.radical,{key:'144',char:'行',name:'hành'});assert.equal(card.tapped.strokes,6);
 assert.deepEqual(card.alternatives,[{start:4,end:5,text:'行'}]);
 const single=cardModel({chars:['乐'],start:0,end:1,entries:[
  {simp:'乐',trad:'樂',pinyin:'Le4',hanViet:'lạc',en:'surname Le',vi:'',flags:FLAG_SURNAME},
  {simp:'乐',trad:'樂',pinyin:'lao4',hanViet:'_',en:'used in place names',vi:'',flags:FLAG_VARIANT},
  {simp:'乐',trad:'樂',pinyin:'le4',hanViet:'lạc/nhạc',en:'happy',vi:'vui',flags:0}]});
 assert.deepEqual(single.readings.map(r=>r.numbered),['le4','lao4','Le4']);
 assert.equal(single.readings[0].hanViet,'lạc, nhạc','a single character lists every reading');
 assert.equal(single.readings[1].hanViet,'','unknown Hán Việt is left out');assert.ok(single.readings[2].minor);
 const word=cardModel({chars:[...'长江X光'],start:0,end:2,entries:[{simp:'长江',trad:'長江',pinyin:'Chang2 Jiang1',hanViet:'_ giang',en:'Yangtze',vi:'',flags:FLAG_VI_ONLY}]});
 assert.equal(word.readings[0].hanViet,'— giang');assert.equal(word.perChar[0].hanViet,'');assert.ok(word.readings[0].viOnly);
 const latin=cardModel({chars:[...'卡拉OK'],start:0,end:4,entries:[{simp:'卡拉OK',trad:'卡拉OK',pinyin:'ka3 la1 O K',hanViet:'ca lạp _ _',en:'karaoke',vi:''}]});
 assert.equal(latin.readings[0].hanViet,'ca lạp O K');assert.deepEqual(latin.perChar.map(row=>row.char),['卡','拉'],'no per-character rows for Latin letters');
 const rare=cardModel({chars:['𠀀'],start:0,end:1,entries:[],record:['hē',{u:['ha']},'the sound made by breathing in','','',2,'1.1'],radicals:{'1':['一','nhất']}});
 assert.equal(rare.found,false);assert.equal(rare.tapped.mandarin,'hē');assert.equal(rare.tapped.hanViet,'ha');assert.equal(rare.tapped.hanVietSource,'unihan');assert.equal(rare.tapped.definition,'the sound made by breathing in');
});

test('traditional context: entries written in the traditional form come first, with the simplified form shown',()=>{
 const card=cardModel({chars:['只'],start:0,end:1,script:'zh-Hant',entries:[
  {simp:'只',trad:'隻',pinyin:'zhi1',hanViet:'chích',en:'classifier for birds',vi:'',flags:0},
  {simp:'只',trad:'只',pinyin:'zhi3',hanViet:'chỉ',en:'only',vi:'chỉ',flags:0}]});
 assert.equal(card.lang,'zh-Hant');assert.deepEqual(card.readings.map(r=>r.numbered),['zhi3','zhi1']);
 assert.equal(card.readings[1].form,'');assert.equal(card.otherForm,null);
 const hans=cardModel({chars:['只'],start:0,end:1,script:'zh-Hans',entries:[{simp:'只',trad:'隻',pinyin:'zhi1',hanViet:'chích',en:'classifier',vi:''}]});
 assert.deepEqual(hans.otherForm,{label:'Phồn thể',text:'隻'});
});

// A fetch over the files of a fixture build: what the browser sees from /vendor/dict/.
function serve(built,{manifestType='application/json',fail=()=>false}={}){
 const log=[];
 const fetch=async path=>{
  log.push(path);if(fail(path))throw new TypeError('Failed to fetch');
  const body=path==='/vendor/dict/manifest.json'?JSON.stringify(built.manifest):built.files.get(path.replace(built.manifest.base,''));
  if(body===undefined)return {ok:true,status:200,headers:new Headers({'content-type':'text/html; charset=utf-8'}),json:async()=>{throw new SyntaxError('Unexpected token <');}};
  return {ok:true,status:200,headers:new Headers({'content-type':path.endsWith('manifest.json')?manifestType:'application/json'}),json:async()=>JSON.parse(body)};
 };
 return {fetch,log};
}
const header=name=>`# ${name}\n#! format=ts\n#! charset=UTF-8\n`;
const fixture={
 cedict:`${header('CC-CEDICT')}銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/\n銀 银 [yin2] /silver/\n行 行 [xing2] /to walk/\n行 行 [hang2] /row/\n我們 我们 [wo3 men5] /we/\n在 在 [zai4] /at/\n工作 工作 [gong1 zuo4] /to work/\n中 中 [zhong1] /middle/\n`,
 cvdict:`${header('CVDICT')}銀行 银行 [yin2 hang2] /ngân hàng/LT:家[jia1],個|个[ge4]/\n`,
 hanviet:"char,hanviet,pinyin\n銀,['ngân'],*\n行,\"['hành', 'hạnh']\",xing2\n行,\"['hàng', 'hạng']\",hang2\n工,['công'],*\n作,['tác'],zuo4\n",
 hanvietLicense:'MIT',radicals:'144; 2F8F; 884C\n',
 unihanReadings:'U+884C\tkMandarin\txíng\n',unihanVariants:'',unihanIrg:'U+884C\tkRSUnicode\t144.0\nU+884C\tkTotalStrokes\t6\n'
};
const built=buildDictionary({builder:'test',sources:[],texts:fixture});

test('the loader looks up a tapped word end to end from the built files',async()=>{
 const {fetch,log}=serve(built),dictionary=createDictionary({fetch}),{chars}=codePoints('我们在银行工作');
 const card=await dictionary.lookup(chars,4);
 assert.equal(card.word,'银行');assert.equal(card.readings[0].pinyin,'yínháng');assert.equal(card.readings[0].hanViet,'ngân hàng');
 assert.deepEqual(card.readings[0].vi,['ngân hàng']);assert.deepEqual(card.readings[0].en,['bank']);assert.deepEqual(card.readings[0].classifiers,['家 (jiā)','个 (gè)']);
 assert.equal(card.tapped.radical.name,'hành');
 assert.ok(log.every(path=>path.startsWith('/vendor/dict/')),'no /api request');
 assert.ok(log.length<=12,`cold tap used ${log.length} requests`);
 const requests=log.length;await dictionary.lookup(chars,3);assert.equal(log.length,requests,'shards are cached in memory');
 assert.deepEqual(await dictionary.neighbor(chars,3,5,1),{start:5,end:7});
 const trad=await dictionary.lookup(codePoints('我們在銀行工作').chars,3);
 assert.equal(trad.word,'銀行');assert.equal(trad.lang,'zh-Hant');assert.deepEqual(trad.otherForm,{label:'Giản thể',text:'银行'});
 assert.equal(await dictionary.licenseUrl(),`${built.manifest.base}LICENSE.txt`);
});

test('the loader rejects the HTML fallback and wrong manifests as "missing", and retries after a network error',async()=>{
 await assert.rejects(createDictionary({fetch:serve(built,{manifestType:'text/html'}).fetch}).manifest(),error=>error instanceof DictionaryError&&error.code==='missing');
 const wrong=async()=>({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>({...built.manifest,base:'https://evil.example/'})});
 await assert.rejects(createDictionary({fetch:wrong}).manifest(),error=>error.code==='missing');
 await assert.rejects(createDictionary({fetch:async()=>({ok:false,status:404,headers:new Headers()})}).manifest(),error=>error.code==='missing');
 await assert.rejects(createDictionary({fetch:async()=>({ok:false,status:503,headers:new Headers()})}).manifest(),error=>error.code==='network');
 // A browser that cached the SPA page under a shard URL gets the real file on the revalidated retry.
 const {fetch:real}=serve(built),stale=entryFile(entryBucket('银')),asked=[];
 const cached=async(path,init={})=>{asked.push(`${path.replace(built.manifest.base,'')} ${init.cache||''}`.trim());if(path.endsWith(stale)&&!init.cache)return {ok:true,status:200,headers:new Headers({'content-type':'text/html'}),json:async()=>{throw new SyntaxError('<');}};return real(path);};
 assert.equal((await createDictionary({fetch:cached}).lookup(['银','行'],0)).word,'银行');
 assert.ok(asked.includes(`${stale} no-cache`),'one revalidated retry');
 let offline=true;const {fetch}=serve(built,{fail:path=>offline&&path.includes('/e/')}),dictionary=createDictionary({fetch});
 await assert.rejects(dictionary.lookup(['银','行'],1),error=>error.code==='network');
 offline=false;assert.equal((await dictionary.lookup(['银','行'],1)).word,'银行','the failed file is fetched again');
});

test('a tab that outlives a deploy reloads the manifest once and switches to the new build',async()=>{
 const next=buildDictionary({builder:'test',sources:[],texts:{...fixture,cvdict:fixture.cvdict.replace('/ngân hàng/','/ngân hàng (mới)/')}});
 assert.notEqual(next.id,built.id);
 let live=built;const log=[];
 const fetch=async(path,init={})=>{
  log.push(`${path} ${init.cache||''}`.trim());
  const body=path==='/vendor/dict/manifest.json'?JSON.stringify(live.manifest):path.startsWith(live.manifest.base)?live.files.get(path.slice(live.manifest.base.length)):undefined;
  // Old files are gone after a deploy; an older deployment's SPA fallback answers them with index.html and status 200
  // (the current 404 page is HTML too, with status 404).
  if(body===undefined)return {ok:true,status:200,headers:new Headers({'content-type':'text/html'}),json:async()=>{throw new SyntaxError('Unexpected token <');}};
  return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>JSON.parse(body)};
 };
 const dictionary=createDictionary({fetch});
 await dictionary.lookup(['在'],0);live=next;
 const card=await dictionary.lookup(codePoints('我们在银行工作').chars,4);
 assert.equal(card.word,'银行');assert.deepEqual(card.readings[0].vi,['ngân hàng (mới)']);
 assert.equal(log.filter(line=>line==='/vendor/dict/manifest.json no-cache').length,1,'one revalidated manifest request');
 const partial={...built,files:new Map([...built.files].filter(([path])=>path!==entryFile(entryBucket('銀'))))};
 await assert.rejects(createDictionary({fetch:serve(partial).fetch}).lookup(['銀'],0),error=>error.code==='missing','a file missing from the current build stays "missing"');
});

test('card text: punctuation inside idioms, lower-case per-character pinyin in names',()=>{
 const idiom=cardModel({chars:[...'一不做，二不休'],start:0,end:7,entries:[{simp:'一不做，二不休',trad:'一不做，二不休',pinyin:'yi1 bu4 zuo4 , er4 bu4 xiu1',hanViet:'nhất bất tố _ nhị bất hưu',en:'in for a penny, in for a pound',vi:''}]});
 assert.equal(idiom.readings[0].hanViet,'nhất bất tố, nhị bất hưu');assert.equal(idiom.readings[0].pinyin,'yībùzuò, èrbùxiū');
 assert.deepEqual(idiom.perChar.map(row=>row.char).join(''),'一不做二不休','no row for the comma');
 const river=cardModel({chars:[...'长江'],start:0,end:2,entries:[{simp:'长江',trad:'長江',pinyin:'Chang2 Jiang1',hanViet:'trường giang',en:'Yangtze River',vi:''}]});
 assert.equal(river.readings[0].pinyin,'Cháng Jiāng');assert.deepEqual(river.perChar.map(row=>row.pinyin),['cháng','jiāng']);
});

test('the lookup panel module loads without a DOM and exposes its documented API',async()=>{
 assert.equal(globalThis.document,undefined);
 const ui=await import('../frontend/hanzi-lookup.js');
 for(const name of ['attachHanziLookup','openHanziPanel','lookupTextarea','closeHanziPanel','setHanziTheme','hanziTapEnabled','setHanziTapEnabled','hasHan'])assert.equal(typeof ui[name],'function',name);
 assert.match(ui.hanziStyles,/#hanzi-panel|\.hanzi-panel/);assert.ok(ui.hasHan('vectơ 向量'));
 assert.doesNotThrow(()=>{ui.openHanziPanel({text:'银行'});ui.closeHanziPanel();ui.setHanziTheme('night');},'calls without a document are no-ops');
 assert.equal(ui.hanziTapEnabled(),true,'tap lookup is on by default');
});

test('entry shards are kept in a bounded LRU; index files stay',async()=>{
 const {fetch,log}=serve(built),dictionary=createDictionary({fetch,cacheSize:1});
 await dictionary.lookup(['银'],0);await dictionary.lookup(['中'],0);const before=log.length;
 await dictionary.lookup(['银'],0);
 assert.deepEqual(log.slice(before).map(path=>path.replace(built.manifest.base,'')),[entryFile(entryBucket('银'))],'only the evicted entry shard is fetched again');
});
