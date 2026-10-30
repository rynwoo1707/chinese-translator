import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {UserError,errorResponse} from './http.js';

const origin='https://hoa-tri.example',COOKIE='cat_hien_session=cookie-value-never-logged; cat_hien_admin=admin-cookie-never-logged',BODY_MARKER='nội dung riêng của học sinh';
const failingDatabase=error=>({prepare(){throw error;}});
const capture=t=>{const lines=[];t.mock.method(console,'error',line=>lines.push(line));return lines;};

test('An internal error answers 500 with a reference code and logs one line without headers or body',async t=>{
 const lines=capture(t),form=new FormData();form.set('title',BODY_MARKER);form.set('source_url','https://example.test/');
 const request=new Request(origin+'/api/requests',{method:'POST',headers:{Cookie:COOKIE,'X-Hoa-Tri-Admin':'1',Authorization:'Bearer admin-token-never-logged','cf-ray':'8f00aa11bb22cc33-HKG'},body:form});
 const response=await worker.fetch(request,{DB:failingDatabase(new TypeError("Cannot read properties of undefined (reading 'first')"))},{});
 assert.equal(response.status,500);const body=await response.json();
 assert.equal(body.code,'internal');assert.equal(body.ray,'8f00aa11bb22cc33-HKG');assert.match(body.error,/Máy chủ gặp lỗi ngoài dự kiến.*8f00aa11bb22cc33-HKG/u);assert.doesNotMatch(body.error,/properties|undefined/u);
 assert.equal(lines.length,1);const logged=JSON.parse(lines[0]);
 assert.deepEqual(Object.keys(logged).sort(),['event','message','method','name','ray','route']);assert.deepEqual([logged.event,logged.method,logged.route,logged.name,logged.ray],['api_error','POST','/api/requests','TypeError','8f00aa11bb22cc33-HKG']);
 for(const secret of ['cookie-value-never-logged','admin-cookie-never-logged','admin-token-never-logged',BODY_MARKER])assert.ok(!lines[0].includes(secret),secret);
});

test('A database that fails while an admin cookie is checked signs nobody in, and its log line names no cookie',async t=>{
 const lines=capture(t),response=await worker.fetch(new Request(origin+'/api/jobs',{headers:{Cookie:COOKIE,'X-Hoa-Tri-Admin':'1'}}),{ADMIN_TOKEN:'e'.repeat(64),DB:failingDatabase(new Error('D1_ERROR: storage unavailable'))},{});
 assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.',code:'admin_signed_out'});
 assert.equal(lines.length,1);const logged=JSON.parse(lines[0]);
 assert.deepEqual(logged,{event:'admin_session_error',name:'Error',message:'D1_ERROR: storage unavailable'});
 for(const secret of ['cookie-value-never-logged','admin-cookie-never-logged'])assert.ok(!lines[0].includes(secret),secret);
});

test('Database errors never reach the browser; a missing migration is named as such',async t=>{
 const lines=capture(t);
 for(const message of ['D1_ERROR: UNIQUE constraint failed: reader_credentials.email_normalized: SQLITE_CONSTRAINT','FOREIGN KEY constraint failed']){
  const response=await worker.fetch(new Request(origin+'/api/library'),{DB:failingDatabase(new Error(message))},{});
  assert.equal(response.status,500);const body=await response.json();assert.equal(body.code,'internal');assert.doesNotMatch(body.error,/UNIQUE|SQLITE|reader_credentials|FOREIGN/u);
 }
 const schema=new Error('D1_ERROR: no such column: u.disabled_at: SQLITE_ERROR');
 const production=await (await worker.fetch(new Request(origin+'/api/library'),{DB:failingDatabase(schema)},{})).json();
 assert.equal(production.code,'schema_outdated');assert.match(production.error,/chưa được cập nhật/u);assert.doesNotMatch(production.error,/disabled_at|npm/u);
 const local=await (await worker.fetch(new Request('http://127.0.0.1:8787/api/library'),{DB:failingDatabase(schema)},{})).json();
 assert.match(local.error,/npm run db:local/u);assert.equal(lines.length,4);
 // A write naming a column the database lacks (D1's text, and SQLite's own without the D1_ERROR prefix) is the same case.
 for(const text of ['D1_ERROR: table study_sessions has no column named engine: SQLITE_ERROR','table study_sessions has no column named engine']){
  const response=await worker.fetch(new Request(origin+'/api/library'),{DB:failingDatabase(new Error(text))},{}),body=await response.json();
  assert.equal(response.status,500,text);assert.equal(body.code,'schema_outdated',text);assert.match(body.error,/^Cơ sở dữ liệu chưa được cập nhật lên phiên bản mới\. Hãy báo quản trị viên, kèm mã /u);assert.doesNotMatch(body.error,/study_sessions|engine|npm|start\.cmd/u);
 }
 // On the machine running the app it is the local database, and the answer says what updates it.
 const write=await (await worker.fetch(new Request('http://127.0.0.1:8787/api/library'),{DB:failingDatabase(new Error('D1_ERROR: table study_sessions has no column named engine: SQLITE_ERROR'))},{})).json();
 assert.match(write.error,/^Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start\.cmd \(hoặc npm run db:local rồi khởi động lại\)\. Mã [\w-]+\.$/u);assert.ok(write.error.includes(write.ray));
 assert.equal(lines.length,7);
});

test('A database at migration 0024 answers a save and the history list with schema_outdated, never internal',async t=>{
 // node:sqlite's "experimental" warning is printed once it loads, before the log is captured.
 const {sqliteEnvironment,signedIn}=await import('./test-support/sqlite-d1.mjs');await new Promise(resolve=>setImmediate(resolve));
 const lines=capture(t),{sqlite,env}=sqliteEnvironment(t,{before:'0025'}),{cookie}=await signedIn(sqlite);
 assert.ok(!sqlite.prepare('PRAGMA table_info(study_sessions)').all().some(column=>column.name==='engine'));
 const id='3f2b8a10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',save={id,title:'Thử lưu',filename:'',domain:'math',mode:'economy',state:{source:'第一章 测试',parts:['第一章 测试'],translationParts:[],done:0}};
 for(const base of ['http://127.0.0.1:8787','https://hoa-tri.example']){
  const call=(method,body)=>worker.fetch(new Request(base+'/api/my/study/history',{method,headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{});
  for(const [label,response] of [['save',await call('POST',save)],['list',await call('GET')]]){
   const body=await response.json();assert.equal(response.status,500,label);assert.equal(body.code,'schema_outdated',`${label}: ${body.error}`);
   if(base.startsWith('http://127'))assert.match(body.error,/^Cơ sở dữ liệu cục bộ chưa cập nhật: hãy tắt Hoa Trí rồi chạy start\.cmd/u,label);
   else assert.doesNotMatch(body.error,/start\.cmd|npm|engine/u,label);
  }
 }
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM study_sessions').get().n,0);assert.equal(env.FILES.keys('study/').length,0,'nothing kept for a save that failed');
 assert.ok(lines.length>=4&&lines.every(line=>JSON.parse(line).event==='api_error'));
});

test('User errors keep their message and status; malformed JSON gets one clear message',async t=>{
 const lines=capture(t);
 assert.deepEqual(await errorResponse(new UserError('Hãy chọn tệp khác.',409,'busy')).json(),{error:'Hãy chọn tệp khác.',code:'busy'});assert.equal(errorResponse(new UserError('x',409)).status,409);
 const plain=errorResponse(new Error('Tên tài liệu phải có từ 1 đến 200 ký tự.'));assert.equal(plain.status,400);assert.equal((await plain.json()).error,'Tên tài liệu phải có từ 1 đến 200 ký tự.');
 const admin='e'.repeat(64),env={ADMIN_TOKEN:admin,DB:{prepare(){return {bind(){return this;},async first(){return {id:'story'};},async run(){return {};}};}}};
 const broken=await worker.fetch(new Request(origin+'/api/stories/story',{method:'PATCH',headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:'{"title":'}),env,{});
 assert.equal(broken.status,400);assert.deepEqual(await broken.json(),{error:'Dữ liệu gửi lên không hợp lệ. Hãy tải lại trang rồi thử lại.',code:'invalid_body'});
 const invalid=await worker.fetch(new Request(origin+'/api/stories/story',{method:'PATCH',headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:JSON.stringify({genre:'không có'})}),env,{});
 assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'Lĩnh vực không hợp lệ.');
 assert.equal(lines.length,0,'messages meant for the user are not logged as failures');
 // Without a cf-ray header (wrangler dev) a short reference is made up so the log line and the message still match.
 const made=await errorResponse(new RangeError('x'),{request:new Request(origin+'/api/x'),path:'/api/x'}).json();assert.match(made.ray,/^[a-f\d]{8}$/u);assert.ok(lines.at(-1).includes(made.ray));
});
