// An in-memory D1 (node:sqlite with every migration and foreign keys on) and R2 for tests that run whole routes.
// Only what the Worker uses is implemented: prepare/bind/first/all/run/batch, and get/put/head/delete/list.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {hashToken} from '../reader-auth.js';

class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){
  // A statement with RETURNING answers rows; run() must still report them like D1 does.
  if(/\bRETURNING\b/iu.test(this.statement.sourceSQL)){const rows=this.statement.all(...this.args);return {success:true,results:rows,meta:{changes:rows.length}};}
  const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes,last_row_id:result.lastInsertRowid}};
 }
 async run(){return this.execute();}
}
export class D1Database{
 constructor(database){this.database=database;}
 prepare(sql){return new D1Statement(this.database,sql);}
 async batch(statements){
  this.database.exec('BEGIN');
  try{const results=statements.map(statement=>statement.execute());this.database.exec('COMMIT');return results;}
  catch(error){this.database.exec('ROLLBACK');throw error;}
 }
}
const bytesOf=value=>typeof value==='string'?new TextEncoder().encode(value):value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(0);
export class MemoryFiles{
 constructor(){this.values=new Map();this.now=Date.now();}
 async put(key,value,options={}){
  const bytes=value instanceof ReadableStream?new Uint8Array(await new Response(value).arrayBuffer()):value instanceof Blob?new Uint8Array(await value.arrayBuffer()):bytesOf(value);
  this.values.set(key,{bytes:bytes.slice(),options,uploaded:new Date(this.now)});return {key,size:bytes.length};
 }
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 object(key,item){
  const text=()=>new TextDecoder().decode(item.bytes);
  return {key,size:item.bytes.length,uploaded:item.uploaded,httpMetadata:item.options?.httpMetadata||{},customMetadata:item.options?.customMetadata||{},body:new Response(item.bytes).body,
   json:async()=>JSON.parse(text()),text:async()=>text(),arrayBuffer:async()=>item.bytes.slice().buffer};
 }
 async get(key){const item=this.values.get(key);return item?this.object(key,item):null;}
 async head(key){const item=this.values.get(key);return item?{key,size:item.bytes.length,uploaded:item.uploaded}:null;}
 async list({prefix='',cursor,limit=1000}={}){
  const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)).sort(),start=Number(cursor||0),page=keys.slice(start,start+limit);
  return {objects:page.map(key=>({key,size:this.values.get(key).bytes.length,uploaded:this.values.get(key).uploaded})),truncated:start+limit<keys.length,cursor:String(start+limit)};
 }
 keys(prefix=''){return [...this.values.keys()].filter(key=>key.startsWith(prefix)).sort();}
}
const migrations=()=>readdirSync(fileURLToPath(new URL('../../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
// before: apply only the migrations named before it (e.g. '0023'), to test code against an older database.
export function sqliteEnvironment(t,{before=null,vars={}}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of migrations().filter(name=>!before||name<before))sqlite.exec(readFileSync(new URL('../../database/migrations/'+name,import.meta.url),'utf8'));
 assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 return {sqlite,env:{DB:new D1Database(sqlite),FILES:new MemoryFiles(),...vars}};
}
// A signed-in reader: the account row and a session whose cookie the returned headers carry.
export async function signedIn(sqlite,{id='student-1',email='lan@example.test',name='Lan',token=`token-${id}`}={}){
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(id,`google-${id}`,email,name);
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(token),id,Date.now()+3600000);
 return {id,name,email,cookie:`cat_hien_session=${token}`};
}
