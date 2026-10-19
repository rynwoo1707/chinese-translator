import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {parseCedict,parseHanviet,parseUnihan,parseRadicals,mergeVietnamese,hanVietOf,entryHanViet,senseFlags,orderSenses,buildDictionary,dictionaryKey,licenseText,UNICODE_LICENSE} from './dictionary-build.js';
import {verifySource,expectedKey,isUpToDate,writeDictionary,unihanTexts,getSource,SOURCES} from './prepare-dictionary.mjs';
import {entryBucket,entryFile,indexBucket,indexFile,FLAG_VI_ONLY,FLAG_VARIANT,FLAG_SURNAME,INDEX_BUCKETS,ENTRY_BUCKETS} from '../frontend/hanzi-dict.js';

const header=(name,extra='')=>`# ${name}\n# Referenced works:\n# CEDICT - Copyright (C) 1997, 1998 Paul Andrew Denisowski\n#! format=ts\n#! charset=UTF-8\n${extra}`;
const CEDICT=`${header('CC-CEDICT','#! date=2026-09-06\n')}銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/
銀 银 [yin2] /silver/
行 行 [xing2] /to walk/to go/
行 行 [hang2] /row/line/
中 中 [zhong1] /within/
中 中 [zhong4] /to hit (a target)/
樂 乐 [Le4] /surname Le/
樂 乐 [le4] /happy/cheerful/
樂 乐 [yue4] /music/
樂 乐 [lao4] /used in 樂亭|乐亭[Lao4 ting2]/
長度 长度 [chang2 du4] /length/
長江 长江 [Chang2 Jiang1] /Yangtze River/
工作 工作 [gong1 zuo4] /to work/job/
乾 干 [gan1] /dry/
幹 干 [gan4] /to do/
干 干 [gan1] /to concern/
乾 乾 [qian2] /heaven/
乾 乾 [Qian2] /surname Qian/
𠀀 𠀀 [he1] /(test) astral character/
卡拉OK 卡拉OK [ka3 la1 O K] /karaoke (loanword)/
`;
const CVDICT=`${header('CVDICT')}銀行 银行 [yin2 hang2] /ngân hàng/LT:家[jia1],個|个[ge4]/
樂 乐 [le4] /vui/vui vẻ/
樂 乐 [yue4] /âm nhạc/
中 中 [zhong4] /trúng (đích)/
長江 长江 [chang2 jiang1] /sông Trường Giang/
工作 工作 [gong1 zuo5] /làm việc/
新詞 新词 [xin1 ci2] /từ mới/
乾 干 [gan1] /khô/
`;
const HANVIET=`char,hanviet,pinyin
銀,['ngân'],*
行,"['hành', 'hạnh']",xing2
行,"['hàng', 'hạng']",hang2
中,['trung'],zhong1
中,['trúng'],zhong4
樂,['lạc'],le4
樂,['nhạc'],yue4
長,['trường'],chang2
長,['trưởng'],zhang3
度,['độ'],du4
江,['giang'],jiang1
工,['công'],*
作,['tác'],zuo4
乾,"['càn', 'kiền']",qian2
乾,['can'],gan1
幹,['cán'],gan4
干,['can'],gan1
新,['tân'],*
詞,['từ'],*
金,['kim'],jin1
台,['đài'],tai2
佛,['phật'],fo2
乀,[],pie3
`;
const READINGS=`# Unihan_Readings.txt
U+884C\tkMandarin\txíng
U+884C\tkHanyuPinlu\txíng(2943) háng(218)
U+4E50\tkHanyuPinlu\tlè(283) yuè(54)
U+91D1\tkMandarin\tjīn
U+20000\tkMandarin\thē
U+20000\tkDefinition\tthe sound made by breathing in; oh!
U+3400\tkMandarin\tqiū
U+3400\tkDefinition\t(same as 丘) hillock or mound
U+3400\tkVietnamese\tkhâu
U+4E2D\tkMandarin\tzhōng bad-value!
`;
const VARIANTS='U+94F6\tkTraditionalVariant\tU+9280\nU+9280\tkSimplifiedVariant\tU+94F6\nU+9485\tkTraditionalVariant\tU+91D1\n';
const IRG='U+94F6\tkRSUnicode\t167\'.6\nU+94F6\tkTotalStrokes\t11\nU+884C\tkRSUnicode\t144.0\nU+884C\tkTotalStrokes\t6 6\nU+9485\tkRSUnicode\t167\'.0\nU+9485\tkTotalStrokes\t5\n';
const RADICALS='# CJKRadicals\n144; 2F8F; 884C\n167; 2FA6; 91D1\n167\'; 2ED0; 9485\n168; 2FA7; 9577\n';
const texts=()=>({cedict:CEDICT,cvdict:CVDICT,hanviet:HANVIET,hanvietLicense:'MIT License\n\nCopyright (c) 2024 Phong Phan\n',radicals:RADICALS,unihanReadings:READINGS,unihanVariants:VARIANTS,unihanIrg:IRG});
const sources=()=>[{key:'cedict',name:'CC-CEDICT',url:'https://example.test/cedict',bytes:1,sha256:'a'.repeat(64)},{key:'cvdict',name:'CVDICT',url:'https://example.test/cvdict',bytes:1,sha256:'b'.repeat(64)}];
const build=(overrides={})=>buildDictionary({texts:{...texts(),...overrides.texts},sources:overrides.sources||sources(),builder:overrides.builder||'test'});
const shardOf=(result,word)=>JSON.parse(result.files.get(entryFile(entryBucket(word))));
const indexOf=(result,char)=>JSON.parse(result.files.get(indexFile(indexBucket(char))));

test('CEDICT parsing keeps headers and metadata and refuses other formats or broken files',()=>{
 const parsed=parseCedict(CEDICT);
 assert.equal(parsed.entries.length,20);assert.equal(parsed.meta.date,'2026-09-06');assert.match(parsed.header,/Paul Andrew Denisowski/);
 assert.deepEqual(parsed.entries[0],{trad:'銀行',simp:'银行',pinyin:'yin2 hang2',glosses:['bank','CL:家[jia1],個|个[ge4]']});
 assert.throws(()=>parseCedict(CEDICT.replace('format=ts','format=simp')),/định dạng "ts"/);
 assert.throws(()=>parseCedict(CEDICT.replace('charset=UTF-8','charset=GB2312')),/UTF-8/);
 assert.throws(()=>parseCedict(`${CEDICT}broken line\n`.repeat(1)),/sai định dạng/,'more than 0.1% bad lines');
});

test('Hán Việt word list, Unihan and radicals parse with their real syntax',()=>{
 const hanviet=parseHanviet(HANVIET);
 assert.deepEqual(hanviet.get('行').get('xing2'),['hành','hạnh']);assert.deepEqual(hanviet.get('銀').get('*'),['ngân']);
 assert.equal(hanviet.has('乀'),false,'empty reading lists are dropped');
 const unihan=parseUnihan({readings:READINGS,variants:VARIANTS,irg:IRG});
 assert.deepEqual(unihan.get('行').mandarin,['xíng']);assert.equal(unihan.get('行').pinlu.get('háng'),218);assert.equal(unihan.get('行').strokes,6);
 assert.deepEqual(unihan.get('中').mandarin,['zhōng'],'values that break the UAX #38 syntax are dropped');
 assert.deepEqual(unihan.get('银').trad,['銀']);assert.equal(unihan.get('银').rs,"167'.6");
 assert.equal(unihan.get('𠀀').definition,'the sound made by breathing in; oh!');assert.deepEqual(unihan.get('㐀').vietnamese,['khâu']);
 assert.deepEqual(parseRadicals(RADICALS).get("167'"),{radical:'⻐',ideograph:'钅'});
});

test('CVDICT matching: exact first, then case-insensitive one-to-one, same headword, Vietnamese-only words',()=>{
 const cedict=parseCedict(CEDICT).entries,cvdict=parseCedict(CVDICT).entries,{vi,viOnly,stats}=mergeVietnamese(cedict,cvdict);
 const viOf=(trad,pinyin)=>vi[cedict.findIndex(entry=>entry.trad===trad&&entry.pinyin===pinyin)];
 assert.deepEqual(viOf('樂','le4'),['vui','vui vẻ']);
 assert.equal(viOf('樂','Le4'),null,'the surname 乐 [Le4] never takes the Vietnamese of 乐 [le4]');
 assert.deepEqual(viOf('長江','Chang2 Jiang1'),['sông Trường Giang'],'case-insensitive pinyin, one-to-one');
 assert.deepEqual(viOf('工作','gong1 zuo4'),['làm việc'],'the only unused entry of the same headword');
 assert.deepEqual(viOf('乾','gan1'),['khô']);assert.equal(viOf('乾','qian2'),null);
 assert.deepEqual(viOnly.map(entry=>entry.simp),['新词']);
 assert.deepEqual(stats,{exact:5,caseless:1,headword:1,simplified:0,viOnly:1,dropped:0});
});

test('Hán Việt by pinyin: context-sensitive readings, wildcards and unknown characters',()=>{
 const hanviet=parseHanviet(HANVIET),han=()=>true;
 assert.deepEqual(hanVietOf(hanviet,'中','zhong4'),['trúng']);assert.deepEqual(hanVietOf(hanviet,'行','xing2'),['hành','hạnh']);
 assert.deepEqual(hanVietOf(hanviet,'銀','yin2'),['ngân'],'* covers every reading');
 assert.deepEqual(hanVietOf(hanviet,'中','Zhong1'),['trung'],'proper-noun pinyin is matched in lower case');
 assert.deepEqual(hanVietOf(hanviet,'作','zuo5'),['tác'],'a neutral tone takes the agreeing toned reading');
 assert.equal(hanVietOf(hanviet,'台','tai1'),null,'no guess across tones: 台 tai1 is thai, not đài');
 assert.equal(hanVietOf(hanviet,'佛','fu2'),null,'no guess across syllables: 佛 fu2 is phất, not phật');
 assert.equal(hanVietOf(hanviet,'丂','kao3'),null);
 assert.equal(entryHanViet({trad:'長度',simp:'长度',pinyin:'chang2 du4'},hanviet,han),'trường độ');
 assert.equal(entryHanViet({trad:'銀行',simp:'银行',pinyin:'yin2 hang2'},hanviet,han),'ngân hàng');
 assert.equal(entryHanViet({trad:'行',simp:'行',pinyin:'xing2'},hanviet,han),'hành/hạnh','a single character keeps every reading');
 assert.equal(entryHanViet({trad:'丂丂',simp:'丂丂',pinyin:'kao3 kao3'},hanviet,han),'_ _');
 assert.equal(entryHanViet({trad:'卡拉OK',simp:'卡拉OK',pinyin:'ka3 la1 O K'},hanviet,char=>/\p{Script=Han}/u.test(char)),'_ _ _ _');
 assert.equal(entryHanViet({trad:'長度',simp:'长度',pinyin:'chang2'},hanviet,han),'','syllables that do not line up give no reading');
});

test('sense flags and order: normal senses, then pointers, then surnames; single characters by frequency',()=>{
 assert.equal(senseFlags(['surname Le']),FLAG_SURNAME);assert.equal(senseFlags(['old variant of 乾[qian2]']),FLAG_VARIANT);
 assert.equal(senseFlags(['used in 樂亭|乐亭[Lao4 ting2]']),FLAG_VARIANT);assert.equal(senseFlags(['(bound form) China; Chinese','surname Zhong']),0);
 assert.equal(senseFlags(['see 送行[song4 xing2]']),FLAG_VARIANT);assert.equal(senseFlags(['used in place names']),FLAG_VARIANT);
 for(const sense of ['see you next time','see-saw','(sentence-final particle) used in questions to link back to prior discourse'])assert.equal(senseFlags([sense]),0,`${sense} is a real sense`);
 assert.equal(senseFlags(['họ [Li3]'],true),FLAG_SURNAME);assert.equal(senseFlags(['họ hàng xa'],true),0);assert.equal(senseFlags(['biến thể cổ của 五[wu3]'],true),FLAG_VARIANT);
 const unihan=parseUnihan({readings:READINGS});
 const list=[{simp:'行',pinyin:'hang2',flags:0},{simp:'行',pinyin:'xing2',flags:0},{simp:'行',pinyin:'Xing2',flags:FLAG_SURNAME}];
 assert.deepEqual(orderSenses(list,unihan.get('行')).map(entry=>entry.pinyin),['xing2','hang2','Xing2']);
});

test('the build writes pointer shards, both scripts in the index, script hints and Unihan rows',()=>{
 const result=build();
 assert.equal(result.files.size,INDEX_BUCKETS+ENTRY_BUCKETS+1);
 const bank=shardOf(result,'银行');
 assert.deepEqual(bank.w['银行'],[['銀行','yin2 hang2','ngân hàng','bank/CL:家[jia1],個|个[ge4]','ngân hàng/LT:家[jia1],個|个[ge4]']]);
 assert.equal(shardOf(result,'銀行').t['銀行'],'银行','traditional headwords point at their simplified headword in their own bucket');
 assert.equal(shardOf(result,'乾').t['乾'],'干','乾 → 干 (dry) besides its own entries');
 const happy=shardOf(result,'乐').w['乐'];
 assert.deepEqual(happy.map(item=>item[1]),['le4','yue4','lao4','Le4'],'by frequency, pointer senses, then the surname');
 assert.equal(happy[3][5],FLAG_SURNAME);assert.equal(happy[2][5],FLAG_VARIANT);assert.equal(happy[0][2],'lạc');
 assert.deepEqual(shardOf(result,'新词').w['新词'],[['新詞','xin1 ci2','tân từ','','từ mới',FLAG_VI_ONLY]]);
 const index=indexOf(result,'银');assert.ok(index.h['银'].split('|').includes('行'));assert.ok(index.h['银'].split('|').includes(''));
 assert.ok(indexOf(result,'銀').h['銀'].split('|').includes('行'),'the index holds both scripts');
 assert.ok(indexOf(result,'銀').t.includes('銀'));assert.ok(indexOf(result,'银').s.includes('银'));
 assert.ok(!indexOf(result,'干').t.includes('干')&&!indexOf(result,'干').s.includes('干'),'characters written the same in both scripts give no hint');
 assert.deepEqual(shardOf(result,'钅').c['钅'],['',{jin1:['kim']},'','','金',5,"167'.0"],'a simplified form inherits Hán Việt from its traditional variant');
 assert.deepEqual(shardOf(result,'行').c['行'],['',0,'','','',6,'144.0'],'characters with entries keep only strokes and radical');
 assert.deepEqual(shardOf(result,'㐀').c['㐀'],['qiū',{u:['khâu']},'(same as 丘) hillock or mound'],'Unihan kVietnamese only as a marked fallback');
 assert.deepEqual(result.manifest.radicals["167'"],['钅','kim']);assert.deepEqual(result.manifest.radicals['168'],['長','trường'],'traditional radical name, not 長 zhǎng "trưởng"');
 assert.equal(result.manifest.longest,4);assert.equal(result.manifest.counts.vietnameseOnly,1);
});

test('builds are deterministic; the id follows the content and the key follows sources and builder',()=>{
 const a=build(),b=build();
 assert.equal(a.id,b.id);assert.deepEqual([...a.files.entries()],[...b.files.entries()]);assert.match(a.id,/^[a-f\d]{12}$/u);
 assert.equal(a.manifest.base,`/vendor/dict/v/${a.id}/`);
 const changed=build({texts:{cvdict:CVDICT.replace('âm nhạc','nhạc')}});assert.notEqual(changed.id,a.id);
 const otherSha=build({sources:[{...sources()[0],sha256:'c'.repeat(64)},sources()[1]]});
 assert.notEqual(otherSha.manifest.key,a.manifest.key);assert.notEqual(otherSha.id,a.id,'the licence lists the checksums');
 assert.notEqual(build({builder:'next'}).manifest.key,a.manifest.key);
 assert.equal(dictionaryKey({builder:'test',sources:sources()}),a.manifest.key);
});

test('LICENSE.txt carries the CC BY-SA notice, credits, changes, the MIT and Unicode licences',()=>{
 const text=build().files.get('LICENSE.txt');
 for(const needle of ['CC BY-SA 4.0','https://creativecommons.org/licenses/by-sa/4.0/','Paul Andrew Denisowski','Phong Phan','Thay đổi:','MIT License','Copyright (c) 2024 Phong Phan','UNICODE LICENSE V3','dịch tự động','https://example.test/cedict','a'.repeat(64)])assert.ok(text.includes(needle),needle);
 assert.equal(createHash('sha256').update(UNICODE_LICENSE).digest('hex'),'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96','the embedded Unicode License v3 is verbatim');
 assert.ok(licenseText({cedict:{header:''},cvdict:{header:''},sources:[],hanvietLicense:''}).includes('UNICODE LICENSE V3'));
});

test('prepare-dictionary: checksums, rebuild key, offline sources and Unihan extraction',async()=>{
 const source={name:'Test',file:'t.txt',bytes:3,sha256:createHash('sha256').update('abc').digest('hex')};
 assert.deepEqual(verifySource(source,new TextEncoder().encode('abc')),new TextEncoder().encode('abc'));
 for(const bad of ['abcd','abd'])assert.throws(()=>verifySource(source,new TextEncoder().encode(bad)),/Nguồn Test: checksum khác phiên bản đã kiểm thử; không thay dữ liệu hiện tại/);
 assert.equal(await expectedKey(),await expectedKey());
 assert.notEqual(await expectedKey([{...SOURCES[0],sha256:'0'.repeat(64)},...SOURCES.slice(1)]),await expectedKey());
 assert.ok(SOURCES.every(item=>/^https:\/\//u.test(item.url)&&/^[a-f\d]{64}$/u.test(item.sha256)&&item.bytes>0&&/\/(?:[a-f\d]{40}|18\.0\.0)\//u.test(item.url)),'every source is pinned by commit or release');
 const folder=await mkdtemp(join(tmpdir(),'hoatri-dict-'));
 try{
  await writeFile(join(folder,'t.txt'),'abc');
  assert.deepEqual(await getSource(source,{from:folder,cache:folder}),new TextEncoder().encode('abc'));
  await assert.rejects(getSource({...source,file:'missing.txt'},{from:folder,cache:folder}),/Thiếu missing.txt/,'offline: never downloads');
  await mkdir(join(folder,source.sha256),{recursive:true});await writeFile(join(folder,source.sha256,'cached.txt'),'abc');
  assert.deepEqual(await getSource({...source,file:'cached.txt'},{from:join(folder,'empty'),cache:folder}),new TextEncoder().encode('abc'),'a file missing from --from comes from the verified cache');
  await assert.rejects(getSource({...source,file:'t.txt',sha256:'0'.repeat(64)},{from:folder,cache:folder}),/checksum khác/,'a wrong file in the offline folder is refused');
  const zip=zipSync({'Unihan_Readings.txt':strToU8(READINGS),'Unihan_Variants.txt':strToU8(VARIANTS),'Unihan_IRGSources.txt':strToU8(IRG),'Unihan_OtherMappings.txt':strToU8('x')});
  const unzipped=unihanTexts(zip);assert.equal(unzipped.readings,READINGS);assert.deepEqual(Object.keys(unzipped).sort(),['irg','readings','variants']);
  assert.throws(()=>unihanTexts(zipSync({'Unihan_Readings.txt':strToU8(READINGS)})),/thiếu Unihan_Variants.txt/);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('prepare-dictionary writes a version folder, then the manifest, and knows when it is up to date',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'hoatri-dict-')),first=build(),second=build({texts:{cvdict:CVDICT.replace('âm nhạc','nhạc')}});
 try{
  assert.equal(await isUpToDate(folder,first.manifest.key),false);
  await mkdir(join(folder,'v','stale-old'),{recursive:true});
  assert.equal((await writeDictionary(first,folder)).written,first.files.size);
  assert.equal(await isUpToDate(folder,first.manifest.key),true);assert.equal(await isUpToDate(folder,'other-key'),false);
  assert.deepEqual(await readdir(join(folder,'v')),[first.id],'older version folders are removed');
  assert.equal(JSON.parse(await readFile(join(folder,'manifest.json'),'utf8')).id,first.id);
  assert.equal((await writeDictionary(first,folder)).written,0,'identical files are not rewritten');
  await rm(join(folder,'v',first.id,entryFile(0)));await writeFile(join(folder,'v',first.id,`${entryFile(1)}.tmp`),'{');
  assert.equal(await isUpToDate(folder,first.manifest.key),false,'a missing shard means rebuild');
  assert.equal((await writeDictionary(first,folder)).written,1);
  assert.ok(!(await readdir(join(folder,'v',first.id,'e'))).some(name=>name.endsWith('.tmp')),'leftover files are not deployed');
  await writeDictionary(second,folder);
  assert.deepEqual(await readdir(join(folder,'v')),[second.id]);
  assert.equal(await readFile(join(folder,'v',second.id,'LICENSE.txt'),'utf8'),second.files.get('LICENSE.txt'));
 }finally{await rm(folder,{recursive:true,force:true});}
});
