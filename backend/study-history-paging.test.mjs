import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';
import {asciiJsonBytes} from '../services/pdf-layout/ascii-json.mjs';

const origin='https://hoa-tri.example',historyPath='/api/my/study/history';
const call=(env,reader,path,{method='GET',body}={})=>worker.fetch(new Request(origin+path,{method,headers:{Cookie:reader.cookie,Origin:origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{});
const sessionId=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
// Three items share each second, so the cursor has to tell them apart by id.
const stamp=n=>new Date(Date.UTC(2026,9,1)+Math.floor(n/3)*1000).toISOString().replace('T',' ').slice(0,19);
function seed(sqlite,userId,from,count){
 const insert=sqlite.prepare('INSERT INTO study_sessions(id,user_id,title,state_key,updated_at) VALUES(?,?,?,?,?)');
 for(let n=from;n<from+count;n++)insert.run(sessionId(n),userId,`Bản dịch ${n}`,`study/${userId}/${sessionId(n)}/state.json`,stamp(n));
}

test('The history list pages newest first by a cursor: every item once, in order, without another account\'s; old clients get the first page as before',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),lan=await signedIn(sqlite),minh=await signedIn(sqlite,{id:'student-2',email:'minh@example.test',name:'Minh'});
 seed(sqlite,lan.id,0,250);seed(sqlite,minh.id,1000,7);
 const expected=sqlite.prepare('SELECT id FROM study_sessions WHERE user_id=? ORDER BY updated_at DESC,id DESC').all(lan.id).map(row=>row.id);
 const pages=[];let next=null;
 do{
  const response=await call(env,lan,historyPath+(next?`?before=${encodeURIComponent(next)}`:''));assert.equal(response.status,200);
  const rows=await response.json();pages.push(rows.map(row=>row.id));next=response.headers.get('X-Next-Before');
  assert.ok(rows.every(row=>Object.hasOwn(row,'revision')&&Object.hasOwn(row,'updated_at')),'the same rows as before');
 }while(next&&pages.length<10);
 assert.deepEqual(pages.map(page=>page.length),[100,100,50]);assert.deepEqual(pages.flat(),expected);
 // Without ?before the answer is the first page, as old clients read it.
 assert.deepEqual((await (await call(env,lan,historyPath)).json()).map(row=>row.id),pages[0]);
 // An item saved meanwhile goes to the top; a page asked for afterwards neither repeats nor skips an item.
 const first=await call(env,lan,historyPath),cursor=first.headers.get('X-Next-Before');
 sqlite.prepare('UPDATE study_sessions SET updated_at=? WHERE id=?').run('2027-01-01 00:00:00',expected[150]);
 const second=(await (await call(env,lan,`${historyPath}?before=${encodeURIComponent(cursor)}`)).json()).map(row=>row.id);
 assert.deepEqual(second,expected.slice(100,200).filter(id=>id!==expected[150]).concat(expected[200]));
 // Minh sees only his own items, on one page and without a cursor.
 const his=await call(env,minh,historyPath);assert.equal(his.headers.get('X-Next-Before'),null);assert.equal((await his.json()).length,7);
 for(const bad of ['khong-hop-le!','','x'.repeat(500),btoa('{"a":1}'),btoa('[1,2]')]){
  const response=await call(env,lan,`${historyPath}?before=${encodeURIComponent(bad)}`);assert.equal(response.status,400,bad);assert.equal((await response.json()).code,'history_invalid');
 }
});

test('A kept-layout save reads the stored manifest as a stream and never parses it whole, nor the saved state',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),lan=await signedIn(sqlite),assetId='22222222-2222-4222-8222-222222222222';
 const image='data:image/png;base64,'+'iVBORw0KGgo'.repeat(20000);
 const blocks=number=>[{id:`p${number}-b1`,source:'向量 @@PDF_INLINE_1@@ 的模。',text:'向量 a 的模。',image,box:[0,0,10,10],fontSize:10,inlines:[{token:'@@PDF_INLINE_1@@',text:'a',image,box:[1,1,2,2],width:1,height:1}]},{id:`p${number}-b2`,source:'第二段。',text:'第二段。',image,box:[0,20,10,30],fontSize:10}];
 const manifest={version:1,extractionVersion:2,totalPages:40,sourceSha256:'b'.repeat(64),pages:[12,13].map(number=>({number,width:600,height:800,ocr:true,background:image,original:image,blocks:blocks(number)}))};
 await env.FILES.put(`study/${lan.id}/pdf-layout/${assetId}/manifest.json`,asciiJsonBytes(manifest));
 // Stored objects of this test answer only as a stream: a whole parse of the manifest or of a saved state fails.
 const get=env.FILES.get.bind(env.FILES),parsed=[];
 env.FILES.get=async key=>{const object=await get(key);if(object&&/(?:manifest|state)\.json$/u.test(key))for(const name of ['json','text','arrayBuffer'])object[name]=async()=>{parsed.push(key);throw new Error(`${key} was parsed whole`);};return object;};
 const parts=manifest.pages.flatMap(page=>page.blocks.map(block=>block.source)),translations=['Độ dài của vectơ @@PDF_INLINE_1@@.','Đoạn thứ hai.','Độ dài của vectơ @@PDF_INLINE_1@@.',''];
 const body=done=>({title:'Toán 12',filename:'toan.pdf',domain:'math',state:{source:parts.join('\n\n'),parts,translationParts:translations.slice(0,done),done,pdfLayout:{assetId}}});
 const created=await call(env,lan,historyPath,{method:'POST',body:body(3)});assert.equal(created.status,201,await created.clone().text());
 const {id,revision}=await created.json();
 const saved=await call(env,lan,`${historyPath}/${id}`,{method:'PUT',body:{...body(4),revision,state:{...body(4).state,translationParts:[...translations.slice(0,3),'Đoạn thứ hai.']}}});
 assert.equal(saved.status,200,await saved.clone().text());assert.deepEqual(parsed,[]);
 const row=sqlite.prepare('SELECT status,page_start,page_end,source_total_pages,source_sha256,source_pages,translation_preview FROM study_sessions WHERE id=?').get(id);
 assert.deepEqual({...row},{status:'complete',page_start:12,page_end:13,source_total_pages:40,source_sha256:'b'.repeat(64),source_pages:'[12,13]',translation_preview:'Độ dài của vectơ a.\n\nĐoạn thứ hai.\n\nĐộ dài của vectơ a.\n\nĐoạn thứ hai.'});
 // A save whose parts do not match the manifest is still refused.
 const wrong=await call(env,lan,`${historyPath}/${id}`,{method:'PUT',body:{...body(1),state:{...body(1).state,parts:['khác',...parts.slice(1)],source:['khác',...parts.slice(1)].join('\n\n')}}});
 assert.equal(wrong.status,400);assert.match((await wrong.json()).error,/không khớp PDF gốc/u);
});
