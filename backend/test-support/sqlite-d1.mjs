// An in-memory D1 (node:sqlite with every migration and foreign keys on) and R2 for tests that run whole routes.
// Only what the Worker uses is implemented: prepare/bind/first/all/run/batch, and get/put/head/delete/list.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
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
const hex=value=>typeof value==='string'?value.toLowerCase():Buffer.from(bytesOf(value)).toString('hex');
// R2 as the Worker relies on it. put: httpMetadata and customMetadata kept, onlyIf.etagMatches (null when another write
// landed), sha256 checked (R2 refuses a body whose hash differs). head and get answer the object's metadata, etag and
// full size; get takes a range ({offset,length}, {offset} or {suffix}; R2 refuses one starting past the end) and says
// which bytes it returned. list takes prefix, cursor, limit and include: metadata only when include names it.
export class MemoryFiles{
 constructor(){this.values=new Map();this.now=Date.now();}
 async put(key,value,options={}){
  const bytes=value instanceof ReadableStream?new Uint8Array(await new Response(value).arrayBuffer()):value instanceof Blob?new Uint8Array(await value.arrayBuffer()):bytesOf(value);
  const condition=options.onlyIf?.etagMatches;if(condition!==undefined&&this.values.get(key)?.etag!==String(condition).replace(/^"|"$/gu,''))return null;
  if(options.sha256!==undefined&&hex(options.sha256)!==createHash('sha256').update(bytes).digest('hex'))throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
  const item={bytes:bytes.slice(),httpMetadata:{...options.httpMetadata},customMetadata:{...options.customMetadata},uploaded:new Date(this.now),etag:createHash('md5').update(bytes).digest('hex'),version:randomUUID()};
  this.values.set(key,item);return this.meta(key,item);
 }
 async delete(keys){for(const key of [keys].flat())this.values.delete(key);}
 meta(key,item,include=['httpMetadata','customMetadata']){
  return {key,size:item.bytes.length,etag:item.etag,httpEtag:`"${item.etag}"`,version:item.version,uploaded:item.uploaded,checksums:{},storageClass:'Standard',
   httpMetadata:include.includes('httpMetadata')?{...item.httpMetadata}:undefined,customMetadata:include.includes('customMetadata')?{...item.customMetadata}:undefined,
   writeHttpMetadata(headers){for(const [name,field] of [['Content-Type','contentType'],['Content-Language','contentLanguage'],['Content-Disposition','contentDisposition'],['Content-Encoding','contentEncoding'],['Cache-Control','cacheControl']])if(item.httpMetadata[field])headers.set(name,item.httpMetadata[field]);}};
 }
 async get(key,options={}){
  const item=this.values.get(key);if(!item)return null;
  let bytes=item.bytes,range;
  if(options?.range){
   const {offset:start=0,length,suffix}=options.range,size=bytes.length,offset=suffix!==undefined?Math.max(0,size-suffix):start;
   if(suffix!==undefined?suffix<=0:offset>=size&&size>0)throw new Error('get: The requested range is not satisfiable.');
   bytes=bytes.subarray(offset,length!==undefined?Math.min(size,offset+length):size);range={offset,length:bytes.length};
  }
  const copy=bytes.slice(),text=()=>new TextDecoder().decode(copy);
  return {...this.meta(key,item),...(range?{range}:{}),body:new Response(copy).body,json:async()=>JSON.parse(text()),text:async()=>text(),arrayBuffer:async()=>copy.slice().buffer,blob:async()=>new Blob([copy])};
 }
 async head(key){const item=this.values.get(key);return item?this.meta(key,item):null;}
 async list({prefix='',cursor,limit=1000,include=[]}={}){
  const keys=[...this.values.keys()].filter(key=>key.startsWith(prefix)).sort(),start=Number(cursor||0),page=keys.slice(start,start+limit),truncated=start+limit<keys.length;
  return {objects:page.map(key=>this.meta(key,this.values.get(key),include)),truncated,...(truncated?{cursor:String(start+limit)}:{}),delimitedPrefixes:[]};
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
