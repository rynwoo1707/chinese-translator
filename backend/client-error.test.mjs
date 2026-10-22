import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {clientErrorReport,CLIENT_ERROR_LIMITS} from './client-error.js';

const origin='https://hoa-tri.example';
// Reports need no account: the database must never be reached.
const untouchable={prepare(){throw new Error('The database must not be reached');}};
function limiter(blocked=[]){const keys=[];return {keys,async limit({key}){keys.push(key);return {success:!blocked.some(prefix=>key.startsWith(prefix))};}};}
const report=(body,{headers={},env={}}={})=>worker.fetch(new Request(origin+'/api/client-error',{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8',Origin:origin,...headers},body:typeof body==='string'?body:JSON.stringify(body)}),{DB:untouchable,...env},{});
function logged(t){const lines=[];t.mock.method(console,'error',line=>lines.push(line));return lines;}
const valid={message:'TypeError: Cannot read properties of undefined (reading "map")',source:'/study.js:812:17',page:'/study',browser:'safari 15'};

test('A browser error report is answered 204 and logged as one line, without cookie, account or address',async t=>{
 const lines=logged(t),API_LIMITER=limiter();
 const response=await report(valid,{headers:{Cookie:'cat_hien_session=secret-session-token',Authorization:'Bearer admin-token-value','CF-Connecting-IP':'203.0.113.9','User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X)'},env:{API_LIMITER}});
 assert.equal(response.status,204);assert.equal(await response.text(),'');
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 assert.equal(lines.length,1);assert.deepEqual(JSON.parse(lines[0]),{event:'client_error',...valid});
 assert.doesNotMatch(lines[0],/secret-session-token|admin-token|203\.0\.113|iPhone|Mozilla/u);
 assert.deepEqual(API_LIMITER.keys,['client-error:203.0.113.9'],'counted per network on the existing limiter');
 // No session is needed, and none is read.
 assert.equal((await report(valid)).status,204);assert.equal(lines.length,2);
});

test('What could name someone is taken out: query, hash, e-mail and long tokens; the message is cut at 300 characters',async t=>{
 const lines=logged(t),key='AIza'+'x'.repeat(35);
 await report({message:`Lỗi tải ${origin}/#dat-lai-mat-khau?token=${'Ab9_'.repeat(11)} cho lan.nguyen@truong.edu.vn,\nkhóa ${key} phiên 5b1c9a2e-1111-4222-8333-444455556666 tại https://cdn.example/a.js?v=1&u=lan`,source:`${origin}/study.js?v=3#x:12:34`,page:'/study?token=abc#dat-lai-mat-khau?token=xyz',browser:'Chrome 120'});
 const entry=JSON.parse(lines[0]);
 assert.equal(entry.message,`Lỗi tải ${origin}/ cho [email], khóa […] phiên […] tại https://cdn.example/a.js`);
 assert.deepEqual([entry.source,entry.page,entry.browser],['/study.js:12:34','/study','chrome 120']);
 await report({...valid,message:'x '.repeat(400),browser:'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36'});
 const long=JSON.parse(lines[1]);assert.equal(long.message.length,CLIENT_ERROR_LIMITS.message-1);assert.equal(long.browser,'other');
});

test('Anything that is not a small report of this site is dropped with the same 204: no log, no oracle',async t=>{
 const lines=logged(t),API_LIMITER=limiter();
 const dropped=[
  'không phải JSON','[1,2]','null','"lỗi"',
  {...valid,message:''},{...valid,message:'   '},{...valid,message:42},{source:valid.source,page:'/study'},
  {...valid,page:''},{...valid,page:'study'},{...valid,page:'https://evil.example/study'},{...valid,page:`/${'a'.repeat(250)}`},
  // A script of an extension or of another site, and what browsers report for one.
  {...valid,source:'chrome-extension://abcdef/content.js:1:2'},{...valid,source:'https://evil.example/x.js:1:1'},{...valid,source:'/study.js'},{...valid,source:7},
  {message:'Script error.',page:'/'},
  {...valid,notes:'x'.repeat(CLIENT_ERROR_LIMITS.bytes)}
 ];
 for(const body of dropped){const response=await report(body,{env:{API_LIMITER}});assert.equal(response.status,204,JSON.stringify(body).slice(0,80));assert.equal(await response.text(),'');}
 // Another site's page, and a body over 2 KB whether its length is declared or not.
 assert.equal((await report(valid,{headers:{Origin:'https://evil.example'},env:{API_LIMITER}})).status,204);
 let pulled=0;const stream=new ReadableStream({pull(controller){pulled++;controller.enqueue(new TextEncoder().encode(' '.repeat(1024)));if(pulled>50)controller.close();}});
 const chunked=await worker.fetch(new Request(origin+'/api/client-error',{method:'POST',headers:{Origin:origin},body:stream,duplex:'half'}),{DB:untouchable,API_LIMITER},{});
 assert.equal(chunked.status,204);assert.ok(pulled<=4,`read ${pulled} KB of an endless body`);
 const declared=await worker.fetch(new Request(origin+'/api/client-error',{method:'POST',headers:{Origin:origin,'Content-Length':String(5*1024*1024)},body:new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024));}}),duplex:'half'}),{DB:untouchable,API_LIMITER},{});
 assert.equal(declared.status,204);
 assert.deepEqual(lines,[]);assert.deepEqual(API_LIMITER.keys,[],'a dropped report is not counted');
 // A network past its limit is dropped the same way; an IPv6 network is counted by its /64.
 const busy=limiter(['client-error:2001:db8:1:2::/64']);
 assert.equal((await report(valid,{headers:{'CF-Connecting-IP':'2001:db8:1:2::77'},env:{API_LIMITER:busy}})).status,204);
 assert.deepEqual(busy.keys,['client-error:2001:db8:1:2::/64']);assert.deepEqual(lines,[]);
 assert.equal((await report(valid,{headers:{'CF-Connecting-IP':'198.51.100.4'},env:{API_LIMITER:busy}})).status,204);assert.equal(lines.length,1);
});

test('A report names a script of this site by path and line, and a page by its path',()=>{
 const read=(fields)=>clientErrorReport({message:'Lỗi',page:'/',...fields},origin);
 assert.deepEqual(read({source:`${origin}/vendor/pdf.mjs:3`}),{message:'Lỗi',source:'/vendor/pdf.mjs:3',page:'/',browser:'other'});
 assert.equal(read({source:'http://localhost:8787/study.js:1:2'}),null,'another origin, also a local one');
 assert.equal(clientErrorReport({message:'Lỗi',page:'/',source:'http://localhost:8787/study.js:1:2'},'http://localhost:8787').source,'/study.js:1:2');
 assert.deepEqual([read({browser:'edge'}).browser,read({browser:'Safari'}).browser,read({browser:'netscape 4'}).browser,read({browser:'safari 1000'}).browser],['edge','safari','other','other']);
});
