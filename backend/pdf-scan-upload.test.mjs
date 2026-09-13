import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

test('Optimized scan pages are validated and checkpointed in reading order',async()=>{
 const objects=new Map(),job={id:'job',mime:'application/pdf'};
 const env={ADMIN_TOKEN:'admin',DB:{prepare(){return {bind(){return this;},async first(){return job;}};}},FILES:{async get(key){const value=objects.get(key);return value?{json:async()=>JSON.parse(value)}:null;},async put(key,value){objects.set(key,value);}}};
 const jpeg=new Uint8Array([255,216,255,1,2,3]);
 async function page(number){const form=new FormData();form.set('page',String(number));form.set('total','2');form.set('image',new File([jpeg],`${number}.jpg`,{type:'image/jpeg'}));return worker.fetch(new Request('https://test/api/jobs/job/pdf-page',{method:'POST',headers:{Authorization:'Bearer admin'},body:form}),env,{});}
 assert.equal((await page(2)).status,200);let manifest=JSON.parse(objects.get('split/job/manifest.json'));assert.equal(manifest.complete,false);
 assert.equal((await page(1)).status,200);manifest=JSON.parse(objects.get('split/job/manifest.json'));assert.equal(manifest.complete,true);assert.deepEqual(manifest.parts.map(part=>part.startPage),[1,2]);assert.equal(manifest.parts[0].mime,'image/jpeg');
});
