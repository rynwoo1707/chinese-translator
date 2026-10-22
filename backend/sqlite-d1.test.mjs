import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {sqliteEnvironment,signedIn,MemoryFiles} from './test-support/sqlite-d1.mjs';

// The in-memory R2 that route tests run on answers as R2 does where the Worker relies on it, so a route test meets what
// production meets: a stored original's page count read back with head(), byte ranges of a PDF, a hash R2 refuses, a
// write that lost to another one.
const origin='https://hoatri.example';
const pdf=size=>{const bytes=new Uint8Array(size);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));for(let i=9;i<size;i++)bytes[i]=i%251;return bytes;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('A stored original keeps its page count and name, is served in byte ranges, and a body that does not match its hash is refused',async t=>{
 const {sqlite,env}=sqliteEnvironment(t),reader=await signedIn(sqlite),file=pdf(3000),hash=sha(file);
 const call=(method,headers={},body)=>worker.fetch(new Request(`${origin}/api/my/study/sources/${hash}`,{method,headers:{Cookie:reader.cookie,Origin:origin,...headers},body}),env,{});
 const stored=await call('PUT',{'X-PDF-Pages':'12','X-Source-Filename':encodeURIComponent('Sách gốc.pdf'),'Content-Length':String(file.length),'Content-Type':'application/pdf'},file);
 assert.equal(stored.status,201);assert.deepEqual(await stored.json(),{sha256:hash,pages:12,filename:'Sách gốc.pdf',stored:true});
 // head() gives the metadata back: a second upload is not needed, and the page count is known.
 const head=await call('HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('X-PDF-Pages'),'12');
 const again=await call('PUT',{'X-PDF-Pages':'12','Content-Length':String(file.length)},file);assert.deepEqual(await again.json(),{sha256:hash,pages:12,filename:'Sách gốc.pdf',stored:false});
 // Ranges as pdf.js asks for them: bytes a-b, the last n bytes, from a to the end; past the end, 416.
 for(const [range,start,end] of [['bytes=100-199',100,199],['bytes=-50',2950,2999],['bytes=2990-',2990,2999],['bytes=2990-5000',2990,2999]]){
  const part=await call('GET',{Range:range});assert.equal(part.status,206,range);assert.equal(part.headers.get('Content-Range'),`bytes ${start}-${end}/3000`,range);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()),file.subarray(start,end+1),range);
 }
 assert.equal((await call('GET',{Range:'bytes=3000-'})).status,416);
 const whole=await call('GET');assert.equal(whole.status,200);assert.equal((await whole.arrayBuffer()).byteLength,3000);
 // R2 checks the body against the hash in the address.
 const other=pdf(2000),forged=await worker.fetch(new Request(`${origin}/api/my/study/sources/${sha(file.subarray(0,10))}`,{method:'PUT',headers:{Cookie:reader.cookie,Origin:origin,'X-PDF-Pages':'3','Content-Length':String(other.length)},body:other}),env,{});
 assert.equal(forged.status,400);assert.equal((await forged.json()).code,'checksum_mismatch');
});

test('The in-memory R2 answers head, ranged get, list and conditional put as R2 does',async()=>{
 const files=new MemoryFiles(),written=await files.put('a/one',new TextEncoder().encode('0123456789'),{httpMetadata:{contentType:'text/plain'},customMetadata:{pages:'3'}});
 assert.equal(written.etag,createHash('md5').update('0123456789').digest('hex'));assert.equal(written.httpEtag,`"${written.etag}"`);
 const head=await files.head('a/one');assert.deepEqual([head.size,head.customMetadata,head.httpMetadata],[10,{pages:'3'},{contentType:'text/plain'}]);
 const headers=new Headers();head.writeHttpMetadata(headers);assert.equal(headers.get('Content-Type'),'text/plain');
 for(const [range,text,offset] of [[{offset:2,length:3},'234',2],[{offset:7},'789',7],[{suffix:4},'6789',6],[{offset:8,length:10},'89',8]]){
  const part=await files.get('a/one',{range});assert.equal(await part.text(),text);assert.equal(part.size,10,'size is the whole object');assert.deepEqual(part.range,{offset,length:text.length});
 }
 await assert.rejects(()=>files.get('a/one',{range:{offset:10}}));
 await files.put('a/two','x',{customMetadata:{pages:'1'}});
 assert.deepEqual((await files.list({prefix:'a/'})).objects.map(object=>[object.key,object.customMetadata]),[['a/one',undefined],['a/two',undefined]],'no metadata unless asked');
 assert.deepEqual((await files.list({prefix:'a/',include:['customMetadata']})).objects.map(object=>object.customMetadata),[{pages:'3'},{pages:'1'}]);
 const first=await files.list({prefix:'a/',limit:1});assert.equal(first.truncated,true);assert.deepEqual((await files.list({prefix:'a/',limit:1,cursor:first.cursor})).objects.map(object=>object.key),['a/two']);
 // A write over the version that was read: refused (null) once another write landed in between.
 assert.notEqual(await files.put('a/one','new',{onlyIf:{etagMatches:written.etag}}),null);
 assert.equal(await files.put('a/one','stale',{onlyIf:{etagMatches:written.etag}}),null);assert.equal(await (await files.get('a/one')).text(),'new');
 await assert.rejects(()=>files.put('a/three','abc',{sha256:'0'.repeat(64)}),/checksum/u);assert.equal(await files.head('a/three'),null);
});
