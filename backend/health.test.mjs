import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const secrets={ADMIN_TOKEN:'a1'.repeat(32),PDF_LAYOUT_SERVICE_URL:'https://pdf.private-host.example',PDF_LAYOUT_SERVICE_TOKEN:'pdf-service-token-never-shown',GEMINI_API_KEY:'gemini-key-never-shown-000000',GOOGLE_CLIENT_SECRET:'google-secret-never-shown'};
const database=first=>({prepare(sql){return {bind(){return this;},async first(){return first(sql);}};}});
const health=(env,init)=>worker.fetch(new Request('https://hoa-tri.example/api/health',init),env,{});

test('Health reports the database, the deployed version and the PDF service state, never a secret',async()=>{
 const meta={id:'5b1c9a2e-0000-4000-8000-000000000001',tag:'6ebfabc',timestamp:'2026-10-17T01:02:03Z'},response=await health({...secrets,DB:database(sql=>sql.startsWith('SELECT 1')?{ok:1}:null),CF_VERSION_METADATA:meta});
 assert.equal(response.status,200);const body=await response.json();
 assert.deepEqual({...body,time:'t'},{ok:true,service:'hoa-tri',version:'6ebfabc',deployedAt:'2026-10-17T01:02:03Z',database:'ok',pdfLayout:'configured',time:'t'});
 assert.ok(!Number.isNaN(Date.parse(body.time)));
 const text=JSON.stringify(body);for(const value of Object.values(secrets))assert.ok(!text.includes(value),'health must not show configuration values');
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 // Without version metadata (wrangler dev) the version says so instead of guessing.
 const local=await (await health({DB:database(()=>({ok:1}))})).json();assert.equal(local.version,'dev');assert.equal(local.deployedAt,null);assert.equal(local.pdfLayout,'off');
 const versionOnly=await (await health({DB:database(()=>({ok:1})),CF_VERSION_METADATA:{id:meta.id}})).json();assert.equal(versionOnly.version,meta.id);
});

test('Health answers 503 when the database fails, logs it for the operator, and HEAD carries no body',async t=>{
 const logs=[];t.mock.method(console,'error',line=>logs.push(line));
 const failing={...secrets,DB:{prepare(){return {bind(){return this;},async first(){throw new Error('D1_ERROR: network connection lost');}};}}};
 const response=await health(failing);assert.equal(response.status,503);
 const body=await response.json();assert.equal(body.ok,false);assert.equal(body.database,'error');assert.doesNotMatch(JSON.stringify(body),/D1_ERROR|network/);
 assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).event,'health_db_error');
 const head=await health(failing,{method:'HEAD'});assert.equal(head.status,503);assert.equal(await head.text(),'');
 const up=await health({DB:database(()=>({ok:1}))},{method:'HEAD'});assert.equal(up.status,200);assert.equal(await up.text(),'');
 assert.equal((await health({})).status,503,'a missing database binding is unhealthy, not a crash');
});

test('Health needs no login or Origin and only answers GET and HEAD',async()=>{
 const env={DB:database(()=>({ok:1}))};
 assert.equal((await health(env,{headers:{Origin:'https://elsewhere.example'}})).status,200);
 const post=await health(env,{method:'POST',headers:{Origin:'https://hoa-tri.example'},body:'{}'});assert.equal(post.status,405);assert.equal(post.headers.get('Allow'),'GET, HEAD');
});
