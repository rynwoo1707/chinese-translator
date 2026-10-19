import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {studyHistoryRoute} from './study-history.js';
import {pdfLayoutRoute} from './pdf-layout.js';
import {sourceKey} from './study-books.js';

const reader={id:'student-delete',name:'Lan'},other={id:'student-other',name:'Minh'},origin='https://example.test',historyBase='/api/my/study/history';
const png='data:image/png;base64,AA==',SHA='c'.repeat(64);
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
class MemoryFiles{
 constructor(){this.values=new Map();}
 async put(key,value,options){this.values.set(key,{value,options});}
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 async list({prefix='',cursor=''}={}){const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)&&key>cursor).sort(),page=keys.slice(0,3);return {objects:page.map(key=>({key})),truncated:keys.length>3,cursor:page.at(-1)};}
 async head(key){return this.values.has(key)?{customMetadata:{}}:null;}
 async get(key){const item=this.values.get(key);if(!item)return null;const text=()=>typeof item.value==='string'?item.value:new TextDecoder().decode(item.value);return {body:item.value,json:async()=>JSON.parse(text()),text:async()=>text()};}
}
function environment(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 for(const user of [reader,other])sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(user.id,`sub-${user.id}`,`${user.id}@example.test`,user.name);
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,env:{DB,FILES:new MemoryFiles(),PDF_LAYOUT_SERVICE_URL:'https://pdf.example.test',PDF_LAYOUT_SERVICE_TOKEN:'service-secret'}};
}
let assetCounter=0;
async function pdfRange(env,pages,{owner=reader,sha256=SHA}={}){
 const assetId=`44444444-4444-4444-8444-${String(++assetCounter).padStart(12,'0')}`;
 const manifest={version:1,totalPages:20,sourceSha256:sha256,pages:pages.map(number=>({number,width:600,height:800,original:png,background:png,blocks:[{id:`p${number}-b0`,source:`第${number}页。`,box:[20,20,200,80],fontSize:12}]}))};
 await env.FILES.put(`study/${owner.id}/pdf-layout/${assetId}/manifest.json`,JSON.stringify(manifest));await env.FILES.put(`study/${owner.id}/pdf-layout/${assetId}/original.pdf`,'%PDF-1.7');
 const parts=manifest.pages.map(page=>page.blocks[0].source);
 return {assetId,folder:`study/${owner.id}/pdf-layout/${assetId}/`,body:(extra={},state={})=>({title:'Toán 1',filename:'toan.pdf',domain:'math',...extra,state:{source:parts.join('\n\n'),parts,translationParts:parts.map((_,i)=>`Trang ${pages[i]}.`),done:parts.length,...state,pdfLayout:{assetId}}})};
}
const json=(path,body,method)=>new Request(origin+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
async function save(env,body,owner=reader){const response=await studyHistoryRoute(json(historyBase,body,'POST'),env,historyBase,owner);return {...await response.json(),http:response.status};}
async function remove(env,id,owner=reader){const path=`${historyBase}/${id}`,response=await studyHistoryRoute(json(path,undefined,'DELETE'),env,path,owner);return {...await response.json(),http:response.status};}
const keys=(env,prefix)=>[...env.FILES.values.keys()].filter(key=>key.startsWith(prefix)).sort();
const count=(sqlite,sql,...args)=>sqlite.prepare(`SELECT COUNT(*) AS count FROM ${sql}`).get(...args).count;

test('Deleting one range of a book removes its part and its files, and keeps the book, the other range and their shared original',async t=>{
 const {sqlite,env}=environment(t),one=await pdfRange(env,[1,2]),two=await pdfRange(env,[3,4]);
 const first=await save(env,one.body()),second=await save(env,two.body({bookId:first.libraryStoryId})),bookId=first.libraryStoryId;
 assert.equal(sqlite.prepare('SELECT pdf_asset_id FROM study_sessions WHERE id=?').get(first.id).pdf_asset_id,one.assetId,'saves record the PDF asset');
 t.mock.method(globalThis,'fetch',async()=>Response.json({pdfBase64:btoa('%PDF-1.7\nVietnamese'),report:[]}));
 const renderPath='/api/my/study/pdf-layout/render';assert.equal((await pdfLayoutRoute(json(renderPath,{assetId:one.assetId,historyId:first.id},'POST'),env,renderPath,reader)).status,200);
 await env.FILES.put(sourceKey(reader.id,SHA),'%PDF-1.7 whole');await env.FILES.put(`covers/${bookId}/cover-1`,'jpeg');sqlite.prepare('UPDATE stories SET cover_key=? WHERE id=?').run(`covers/${bookId}/cover-1`,bookId);
 assert.equal(keys(env,one.folder).length,3);
 const removed=await remove(env,first.id);assert.deepEqual(removed,{ok:true,removedBookId:null,http:200});
 assert.equal(count(sqlite,'study_sessions WHERE id=?',first.id),0);assert.equal(count(sqlite,'chapters WHERE id=?',first.libraryChapterId),0);
 assert.deepEqual(sqlite.prepare('SELECT id FROM chapters WHERE story_id=?').all(bookId).map(row=>row.id),[second.libraryChapterId]);
 assert.deepEqual(keys(env,`study/${reader.id}/${first.id}/`),[]);assert.deepEqual(keys(env,one.folder),[]);
 assert.equal(keys(env,two.folder).length,2);assert.ok(env.FILES.values.has(`study/${reader.id}/${second.id}/state.json`));
 assert.ok(env.FILES.values.has(sourceKey(reader.id,SHA)),'the other range still comes from this original');assert.ok(env.FILES.values.has(`covers/${bookId}/cover-1`));
 // Deleting the last range empties the book: the book, its cover and the original go too.
 const last=await remove(env,second.id);assert.deepEqual(last,{ok:true,removedBookId:bookId,http:200});
 assert.equal(count(sqlite,'stories WHERE id=?',bookId),0);assert.deepEqual(keys(env,`covers/${bookId}/`),[]);assert.deepEqual(keys(env,`study/${reader.id}/`),[]);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Files another item still names stay: a shared PDF asset, and the original a book cover comes from',async t=>{
 const {sqlite,env}=environment(t),one=await pdfRange(env,[1]),two=await pdfRange(env,[2]);
 const first=await save(env,one.body()),second=await save(env,two.body());
 sqlite.prepare('UPDATE study_sessions SET pdf_asset_id=? WHERE id=?').run(one.assetId,second.id);
 await env.FILES.put(sourceKey(reader.id,SHA),'%PDF-1.7 whole');
 sqlite.prepare('UPDATE stories SET cover_source_sha256=?,cover_page=1 WHERE id=?').run(SHA,second.libraryStoryId);
 assert.equal((await remove(env,first.id)).removedBookId,first.libraryStoryId);
 assert.equal(keys(env,one.folder).length,2,'the asset is still named by another item');assert.ok(env.FILES.values.has(sourceKey(reader.id,SHA)),'a book cover still comes from this original');
 assert.equal(count(sqlite,'stories WHERE id=?',second.libraryStoryId),1);
});

test('Older items are found through their saved state, drafts leave books alone, and only the owner can delete',async t=>{
 const {sqlite,env}=environment(t),done=await pdfRange(env,[5]),draft=await pdfRange(env,[6]),foreign=await pdfRange(env,[1],{owner:other});
 const finished=await save(env,done.body()),bookId=finished.libraryStoryId;
 const unfinished=await save(env,draft.body({bookId},{done:0,translationParts:[]}));assert.equal(unfinished.http,201);
 const theirs=await save(env,foreign.body(),other);
 // Saved before migration 0014: no asset id in the row, the saved state names it.
 sqlite.prepare('UPDATE study_sessions SET pdf_asset_id=NULL').run();
 assert.equal((await remove(env,finished.id,other)).http,404);assert.equal((await remove(env,theirs.id)).http,404);
 assert.equal(count(sqlite,'study_sessions'),3);assert.equal(keys(env,foreign.folder).length,2);
 assert.deepEqual(await remove(env,unfinished.id),{ok:true,removedBookId:null,http:200});
 assert.deepEqual(keys(env,draft.folder),[]);assert.equal(count(sqlite,'chapters WHERE story_id=?',bookId),1,'a draft owns no part of the book');
 assert.deepEqual(await remove(env,finished.id),{ok:true,removedBookId:bookId,http:200});assert.deepEqual(keys(env,done.folder),[]);
 assert.equal((await remove(env,finished.id)).http,404);
 const missingId=await studyHistoryRoute(json(historyBase,undefined,'DELETE'),env,historyBase,reader);assert.equal(missingId.status,400);
 assert.equal(count(sqlite,"study_sessions WHERE user_id='student-other'"),1);assert.equal(keys(env,`study/${other.id}/`).length,4);
});
