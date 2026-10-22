import test from 'node:test';
import assert from 'node:assert/strict';
import {readJsonShape} from './json-shape.js';
import {asciiJsonBytes} from '../services/pdf-layout/ascii-json.mjs';

// What JSON.parse then a projection by hand gives: the reference readJsonShape must match on every split of the bytes.
const objectShape=shape=>Boolean(shape)&&typeof shape==='object'&&!Array.isArray(shape);
function project(value,shape){
 if(shape===true)return value;
 if(Array.isArray(shape))return Array.isArray(value)?value.map(item=>project(item,shape[0])):value;
 if(objectShape(shape)&&value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.keys(shape).filter(key=>Object.hasOwn(value,key)).map(key=>[key,project(value[key],shape[key])]));
 return value;
}
const streamOf=(bytes,sizes)=>{let at=0,turn=0;return new ReadableStream({pull(controller){if(at>=bytes.length)return controller.close();const size=sizes[turn++%sizes.length];controller.enqueue(bytes.slice(at,at+size));at+=size;}});};
// A seeded generator, so a failure can be replayed.
function random(seed){return ()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};}
const TEXT=['','a','"quoted" \\ back\\slash','đường thẳng','向量 @@PDF_INLINE_1@@ 的模','\u0000\u001f\u2028 controls','emoji 😀 and 𠀀','{[,:]}',' spaced  out '];
function value(next,depth=0){
 const kind=Math.floor(next()*(depth>3?5:8));
 if(kind===0)return TEXT[Math.floor(next()*TEXT.length)];
 if(kind===1)return Math.round((next()-.5)*1e6)/(next()<.5?1:1000);
 if(kind===2)return next()<.5;
 if(kind===3)return null;
 if(kind===4)return 'data:image/png;base64,'+'A'.repeat(Math.floor(next()*600));
 if(kind<7){const object={};for(let i=Math.floor(next()*5);i>0;i--)object[['id','source','number','pages','blocks','inlines','token','text','image','other'][Math.floor(next()*10)]]=value(next,depth+1);return object;}
 return Array.from({length:Math.floor(next()*4)},()=>value(next,depth+1));
}
const SHAPE={number:true,id:true,pages:[{number:true,blocks:[{id:true,source:true,inlines:[{token:true,text:true}]}]}],source:true,text:{token:true}};

test('A shape keeps exactly what JSON.parse and a projection keep, however the bytes are split, in any spelling of the JSON',async()=>{
 const next=random(20261022);
 for(let round=0;round<80;round++){
  const document={pages:[value(next),value(next)],...value(next)&&{number:7},blocks:value(next),id:value(next),text:value(next)};
  const expected=project(JSON.parse(JSON.stringify(document)),SHAPE);
  for(const bytes of [new TextEncoder().encode(JSON.stringify(document)),new TextEncoder().encode(JSON.stringify(document,null,round%3+1)),asciiJsonBytes(document)]){
   for(const sizes of [[bytes.length],[1],[2,3,5,7],[4096],[Math.max(1,Math.floor(next()*64))]])assert.deepEqual(await readJsonShape(streamOf(bytes,sizes),SHAPE),expected,`round ${round}, chunks ${sizes}`);
  }
 }
});

test('A layout manifest is read without its images: block ids, sources, formula tokens and page numbers only',async()=>{
 const image='data:image/png;base64,'+'iVBORw0KGgo'.repeat(30000),page=number=>({number,width:600,height:800,ocr:true,background:image,original:image,ocrSheets:[{id:`p${number}-s1`,image,strips:[{blockId:`p${number}-b1`,label:'#1',box:[0,0,1,1]}]}],
  blocks:[{id:`p${number}-b1`,source:'向量 @@PDF_INLINE_1@@ 的模。',text:'向量 a 的模。',image,inlines:[{token:'@@PDF_INLINE_1@@',text:'a',image,box:[1,2,3,4]}]},{id:`p${number}-b2`,source:'“引号” \\ 和 \\u4e00',image}]});
 const manifest={version:1,extractionVersion:2,totalPages:120,sourceSha256:'a'.repeat(64),pages:[page(12),page(13)],warnings:['x']},bytes=asciiJsonBytes(manifest);
 const shape={totalPages:true,sourceSha256:true,pages:[{number:true,blocks:[{id:true,source:true,inlines:[{token:true,text:true}]}]}]};
 const read=await readJsonShape(streamOf(bytes,[65536]),shape);
 assert.deepEqual(read,project(manifest,shape));assert.ok(bytes.length>3_000_000,`${bytes.length} bytes`);
 assert.ok(JSON.stringify(read).length<1000,'no image is kept');
});

test('A cut or broken document is refused, not half read',async()=>{
 const shape={pages:[{number:true}]};
 for(const text of ['','{"pages":[{"number":1}','{"pages":[{"number":1}]}x','{"pages" [1]}','{"pages":[{"number":1},]}x','{"pages":[{"number":"1}]}','["a"',' {"pages":[]} {}'])await assert.rejects(()=>readJsonShape(text,shape),/Bố cục PDF đã lưu bị hỏng/u,JSON.stringify(text));
 assert.deepEqual(await readJsonShape(' {"pages":[{"number":1,"x":{"y":[1,2,{"z":"}]"}]}}]} ',shape),{pages:[{number:1}]});
 assert.equal(await readJsonShape('42',true),42);assert.deepEqual(await readJsonShape('{"pages":"none"}',shape),{pages:'none'},'a value of another kind is kept for the caller to refuse');
});
