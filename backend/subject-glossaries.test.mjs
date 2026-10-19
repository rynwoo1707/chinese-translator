import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import worker from './worker.js';
import {hashToken} from './reader-auth.js';
import {translatePdfBlocks} from './pdf-block-translation.js';
import {TEXTBOOK_GLOSSARY,MATH_GLOSSARY,relevantGlossary} from './ai.js';
import {SUBJECTS,SUBJECT_IDS,SUBJECT_LABELS,PHYSICS_GLOSSARY,CHEMISTRY_GLOSSARY,BIOLOGY_GLOSSARY,INFORMATICS_GLOSSARY,subjectOf,subjectForGenre,builtInGlossary,ownTerms,isSubject,termsInText,ownTermWarnings} from './subject-glossaries.js';

const generation=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:10,totalTokenCount:20}});
const aiEnv={GEMINI_API_KEY:'student-key-for-subject-tests-1234567890',GEMINI_MODEL:'gemini-3.6-flash',GEMINI_THINKING:'minimal'};
const NEW_SUBJECTS={physics:'Vật lý',chemistry:'Hóa học',biology:'Sinh học',informatics:'Tin học'};

test('every subject of the workspace has an id, its label and built-in terms; the four sciences carry 60-130 terms each',()=>{
 assert.deepEqual(SUBJECT_IDS,['general','math','history','physics','chemistry','biology','informatics']);
 assert.deepEqual(SUBJECT_LABELS,{general:'Chuyên khảo · Nghiên cứu',math:'Toán học · STEM',history:'Lịch sử Trung Hoa',...NEW_SUBJECTS});
 assert.equal(subjectOf('math').glossary,MATH_GLOSSARY,'math reuses the glossary of ai.js');
 for(const id of ['general','history'])assert.deepEqual(subjectOf(id).glossary,{});
 for(const [id,label] of Object.entries(NEW_SUBJECTS)){
  const subject=subjectOf(id),entries=Object.entries(subject.glossary);
  assert.equal(subject.label,label);assert.ok(subject.terms>=60&&subject.terms<=130,`${id}: ${subject.terms} terms`);
  for(const [zh,vi] of entries){
   // A key matches anywhere in the text, so it is a whole term: two characters or more (酶 and 栈 mean nothing else).
   assert.ok([...zh].length>=2||['酶','栈'].includes(zh),`${id}: ${zh}`);assert.match(zh,/\p{Script=Han}/u);assert.ok(zh.length<=100);
   assert.equal(vi,vi.normalize('NFC'));assert.doesNotMatch(vi,/\p{Script=Han}|[̀-ͯ]/u);assert.ok(vi.length>0&&vi.length<=100,`${id}: ${zh}`);
   assert.equal(Object.hasOwn(TEXTBOOK_GLOSSARY,zh),false,`${zh} would override the textbook label`);
  }
 }
 assert.ok(!isSubject('astronomy')&&!isSubject('__proto__')&&!isSubject(undefined)&&isSubject('biology'));
 assert.equal(subjectOf('astronomy').id,'general');assert.equal(subjectForGenre('Hóa học').id,'chemistry');assert.equal(subjectForGenre('Toán học · STEM').id,'math');assert.equal(subjectForGenre('Giáo dục').id,'general');
});

test('the standard Vietnamese school terms, in simplified and traditional (Taiwan) writing',()=>{
 const expected={
  physics:{'加速度':'gia tốc','電場強度':'cường độ điện trường','电场强度':'cường độ điện trường','位移':'độ dịch chuyển','速率':'tốc độ','速度':'vận tốc','势能':'thế năng','位能':'thế năng','电动势':'suất điện động','磁感应强度':'cảm ứng từ','简谐运动':'dao động điều hòa','衍射':'nhiễu xạ','繞射':'nhiễu xạ','楞次定律':'định luật Lenz','冷次定律':'định luật Lenz','半衰期':'chu kì bán rã'},
  chemistry:{'化学键':'liên kết hóa học','化學鍵':'liên kết hóa học','氧化还原反应':'phản ứng oxi hóa – khử','氧化還原反應':'phản ứng oxi hóa – khử','电解质':'chất điện li','物质的量':'lượng chất','摩尔质量':'khối lượng mol','莫耳質量':'khối lượng mol','焓变':'biến thiên enthalpy','氢键':'liên kết hydrogen','电负性':'độ âm điện','電負度':'độ âm điện','乙醇':'ethanol','羧酸':'carboxylic acid'},
  biology:{'细胞膜':'màng tế bào','細胞膜':'màng tế bào','光合作用':'quang hợp','线粒体':'ti thể','粒線體':'ti thể','有丝分裂':'nguyên phân','减数分裂':'giảm phân','等位基因':'allele','對偶基因':'allele','基因':'gene','转录':'phiên mã','轉譯':'dịch mã','自然选择':'chọn lọc tự nhiên','天擇':'chọn lọc tự nhiên','酶':'enzyme','酵素':'enzyme'},
  informatics:{'算法':'thuật toán','演算法':'thuật toán','数据结构':'cấu trúc dữ liệu','資料結構':'cấu trúc dữ liệu','递归':'đệ quy','遞迴':'đệ quy','字符串':'xâu kí tự','数组':'mảng','陣列':'mảng','栈':'ngăn xếp','队列':'hàng đợi','二叉树':'cây nhị phân','变量':'biến','變數':'biến'}
 };
 for(const [id,terms] of Object.entries(expected))for(const [zh,vi] of Object.entries(terms))assert.equal(subjectOf(id).glossary[zh],vi,`${id}: ${zh}`);
 assert.deepEqual(builtInGlossary('physics'),{...TEXTBOOK_GLOSSARY,...PHYSICS_GLOSSARY});assert.deepEqual(builtInGlossary('nope'),{...TEXTBOOK_GLOSSARY});
 // Only the student's own terms remain: a built-in term sent back unchanged is not one, a changed one is.
 assert.deepEqual(ownTerms({'加速度':'gia tốc','速度':'tốc độ','练习':'bài tập','网格':'lưới'},'physics'),{'速度':'tốc độ','网格':'lưới'});
});

test('physics: 质量 and 密度 keep their compounds (số khối, độ hụt khối, mật độ…), and a short key is never found inside a compound',()=>{
 for(const [zh,vi] of [['质量数','số khối'],['質量數','số khối'],['质量亏损','độ hụt khối'],['質量虧損','độ hụt khối'],['结合能','năng lượng liên kết'],['比结合能','năng lượng liên kết riêng'],['比結合能','năng lượng liên kết riêng'],['电荷密度','mật độ điện tích'],['電荷密度','mật độ điện tích'],['能量密度','mật độ năng lượng'],['电流密度','mật độ dòng điện'],['数密度','mật độ'],['质量','khối lượng'],['密度','khối lượng riêng']])assert.equal(PHYSICS_GLOSSARY[zh],vi,zh);
 const physics=builtInGlossary('physics');
 // A Vật lí 12 nuclear-physics block: the compounds, not 质量 = khối lượng (which would give "số khối lượng").
 const nuclear=termsInText(physics,'原子核的质量数A等于核子数，原子核的质量亏损越大，比结合能越大。');
 for(const key of ['质量数','质量亏损','比结合能'])assert.ok(Object.hasOwn(nuclear,key),key);
 for(const key of ['质量','结合能'])assert.equal(nuclear[key],undefined,`${key} stands only inside a longer term here`);
 const density=termsInText(physics,'导体中自由电子数密度为n，电荷密度为ρ。');
 assert.deepEqual([density['数密度'],density['电荷密度'],density['密度']],['mật độ','mật độ điện tích',undefined]);assert.equal(density['电荷'],undefined,'电荷 only inside 电荷密度');
 // The same key elsewhere in the text on its own still counts, and the glossary order is kept.
 assert.deepEqual(Object.keys(termsInText(physics,'物体的质量为m，原子核的质量数为A。')).sort(),['质量','质量数'].sort());
 assert.deepEqual(Object.keys(termsInText({'甲乙':'x','乙':'y','丙':'z'},'甲乙丙乙')),['甲乙','乙','丙']);
 // Overlapping terms that do not contain each other both count (nothing can tell which one the text means).
 assert.deepEqual(Object.keys(termsInText({'电势能':'thế năng điện','势能':'thế năng','电势':'điện thế'},'电势能')),['电势能']);
 assert.deepEqual(Object.keys(termsInText({'AB':'1','BC':'2'},'ABC')),['AB','BC']);
 for(const empty of [null,undefined,{}])assert.deepEqual(termsInText(empty,'质量'),{});assert.deepEqual(termsInText(physics,''),{});
});

test('every subject: a term counts only where no longer built-in term holds it, so a compound always wins over its parts',()=>{
 let checked=0;
 for(const subject of SUBJECTS){
  const builtIn=builtInGlossary(subject.id),keys=Object.keys(builtIn);
  for(const long of keys)for(const short of keys){
   if(short===long||!long.includes(short))continue;checked++;
   const found=termsInText(builtIn,`……${long}……`);
   assert.ok(Object.hasOwn(found,long),`${subject.id}: ${long}`);assert.equal(found[short],undefined,`${subject.id}: ${short} inside ${long}`);
  }
 }
 assert.ok(checked>=60,`${checked} compound pairs checked`);
 // A student's own term inside a built-in compound of any subject is not asked for there; on its own it still is.
 const own={'质量':'khối lượng','速度':'tốc độ'};
 assert.deepEqual(ownTermWarnings('原子核的质量数为4，加速度为a。','Số khối của hạt nhân là 4, gia tốc là a.',own),[]);
 assert.deepEqual(ownTermWarnings('物体的质量为2 kg。','Vật nặng 2 kg.',own),['Thuật ngữ chưa theo bảng tên: 质量 → khối lượng']);
 assert.deepEqual(ownTermWarnings('物体的质量为2 kg。','Khối lượng của vật là 2 kg.',own),[]);
});

test('PDF block mode sends the subject\'s terms found in the blocks, never an unknown subject, and warns only on the student\'s own terms',async t=>{
 const calls=[];let answer=()=>'';
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body),sent=JSON.parse(body.contents[0].parts[0].text);calls.push(sent);return generation({blocks:sent.blocks.map(b=>({id:b.id,translation:answer(b)})),contextUpdate:'',glossaryUpdates:{}});});
 const blocks=[{id:'p1-b1',source:'物体的加速度与合力成正比，与质量成反比。'},{id:'p1-b2',source:'電場強度是描述電場的物理量。'}];
 answer=b=>b.id==='p1-b1'?'Gia tốc của vật tỉ lệ thuận với lực tổng hợp và tỉ lệ nghịch với khối lượng.':'Cường độ điện trường là đại lượng vật lí mô tả điện trường.';
 const result=await translatePdfBlocks(aiEnv,{blocks,domain:'physics',glossary:{'物理量':'đại lượng vật lý'}});
 const {glossary,domain}=calls[0];
 assert.equal(domain,'physics');
 assert.deepEqual(Object.keys(glossary).sort(),['物理量','電場強度','加速度','速度','合力','质量','電場'].sort());
 for(const [zh,vi] of [['加速度','gia tốc'],['速度','vận tốc'],['合力','hợp lực'],['质量','khối lượng'],['電場強度','cường độ điện trường'],['電場','điện trường'],['物理量','đại lượng vật lý']])assert.equal(glossary[zh],vi,zh);
 assert.equal(Object.keys(glossary)[0],'物理量','the student\'s own term comes first');
 assert.equal(glossary['电场强度'],undefined,'a term not in the text costs nothing');
 // "lực tổng hợp" instead of hợp lực is a built-in term rendered otherwise: no warning; "vật lí" misses the student's term.
 assert.deepEqual(result.warnings,['Block p1-b2: thuật ngữ chưa theo bảng tên: 物理量 → đại lượng vật lý']);
 for(const domain of ['astronomy',{x:1},'x'.repeat(5000)]){
  await translatePdfBlocks(aiEnv,{blocks,domain});const sent=calls.at(-1);
  assert.equal(sent.domain,'general');assert.equal(sent.glossary['加速度'],undefined);
 }
 await translatePdfBlocks(aiEnv,{blocks:[{id:'p2-b1',source:'空间向量的数量积'}],domain:'math'});
 assert.equal(calls.at(-1).glossary['数量积'],'tích vô hướng','math keeps its glossary');
});

const ORIGIN='https://school.test',STUDENT='student-session-for-subject-tests';
async function studyCall(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const dir=new URL('../database/migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('student-1','sub-1','hs@example.test','Học sinh');
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(STUDENT),'student-1',Date.now()+3600000);
 const env={DB:{prepare:sql=>{const statement=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:statement.run(...args).changes}};}};}}};
 return async body=>{const response=await worker.fetch(new Request(`${ORIGIN}/api/my/study/translate`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:`cat_hien_session=${STUDENT}`},body:JSON.stringify({apiKey:aiEnv.GEMINI_API_KEY,mode:'economy',...body})}),env,{});return {status:response.status,body:await response.json()};};
}

test('text mode sends the subject and its terms like the math ones: fixed, found in the text, warned only for the student\'s own terms',async t=>{
 const translate=await studyCall(t),payloads=[];let translation='';
 t.mock.method(globalThis,'fetch',async(url,options)=>{payloads.push(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text));return generation({translation,contextUpdate:'',glossaryUpdates:{'化学键':'mối liên kết'}});});
 const source='化学键分为离子键和共价键。氧化还原反应中，氧化剂得到电子。这种作用力很强。';
 translation='Liên kết giữa các nguyên tử gồm liên kết ion và liên kết cộng hóa trị. Trong phản ứng oxi hóa khử, chất oxi hóa nhận electron. Lực này rất mạnh.';
 const reply=await translate({source,domain:'chemistry',glossary:{'作用力':'lực tương tác'}});
 assert.equal(reply.status,200,JSON.stringify(reply.body));
 const [payload]=payloads;assert.equal(payload.genre,'Hóa học');
 for(const [zh,vi] of [['化学键','liên kết hóa học'],['离子键','liên kết ion'],['共价键','liên kết cộng hóa trị'],['氧化还原反应','phản ứng oxi hóa – khử'],['氧化剂','chất oxi hóa'],['电子','electron'],['作用力','lực tương tác']])assert.equal(payload.glossary[zh],vi,zh);
 assert.equal(payload.glossary['化学平衡'],undefined,'a term not in the text costs nothing');
 // The model's "mối liên kết" cannot replace a built-in term; the reply carries the subject's terms like the math ones.
 assert.equal(reply.body.glossary['化学键'],'liên kết hóa học');
 assert.deepEqual(reply.body.warnings.filter(w=>/bảng tên/u.test(w)),['Thuật ngữ chưa theo bảng tên: 作用力 → lực tương tác']);
 // Sent back, the built-in terms (some 250 here) never take the 500 places of the student's own and learned terms.
 const own=Object.fromEntries(Array.from({length:499},(_,i)=>[`术语${i}`,`thuật ngữ ${i}`]));
 assert.ok(Object.keys(reply.body.glossary).length>250);
 const second=await translate({source:`${source}术语498。`,domain:'chemistry',glossary:{...reply.body.glossary,...own}});
 assert.equal(second.status,200);assert.equal(payloads.at(-1).glossary['术语498'],'thuật ngữ 498');assert.equal(payloads.at(-1).glossary['化学键'],'liên kết hóa học');assert.equal(payloads.at(-1).glossary['作用力'],'lực tương tác');
 // An unknown subject is general text; math still gets its terms from ai.js by genre, as before.
 await translate({source,domain:'astronomy'});assert.equal(payloads.at(-1).genre,'Chuyên khảo · Nghiên cứu');assert.equal(payloads.at(-1).glossary['化学键'],undefined);
 translation='Tích vô hướng của hai vectơ.';
 await translate({source:'两个向量的数量积',domain:'math'});assert.equal(payloads.at(-1).genre,'Toán học · STEM');assert.equal(payloads.at(-1).glossary['数量积'],'tích vô hướng');
});

test('cost: a subject adds only the few terms its text uses (measured on one paragraph each, no model call)',t=>{
 const paragraphs={
  physics:'物体做匀变速直线运动时，加速度保持不变。根据牛顿第二定律，合力等于质量与加速度的乘积。',
  chemistry:'在氧化还原反应中，氧化剂得到电子，还原剂失去电子。化学键的断裂和形成伴随着能量变化。',
  biology:'光合作用在叶绿体中进行，细胞呼吸主要在线粒体中进行。有丝分裂使细胞数目增加。',
  informatics:'算法是解决问题的步骤。用数组存储数据，再用二分查找在有序数组中查找元素。'
 };
 const report={};
 for(const [id,text] of Object.entries(paragraphs)){
  const builtIn=builtInGlossary(id),sent=relevantGlossary(builtIn,text,{builtIn},100),size=JSON.stringify(sent).length;
  report[id]={terms:Object.keys(sent).length,characters:size};
  assert.ok(report[id].terms>=4&&report[id].terms<=15,`${id}: ${JSON.stringify(sent)}`);assert.ok(size<600,`${id}: ${size}`);
 }
 t.diagnostic(`glossary added per paragraph: ${Object.entries(report).map(([id,r])=>`${id} ${r.terms} terms, ${r.characters} characters`).join('; ')}`);
});
