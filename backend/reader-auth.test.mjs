import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {authRoute,cookieValue,hashToken} from './reader-auth.js';

test('Google login start uses OIDC scopes and protected state cookies',async()=>{
 const request=new Request('https://cat-hien.example/api/auth/google/start?accept_terms=1&return_to=%2F%23account');
 const response=await authRoute(request,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'},new URL(request.url),'/api/auth/google/start');
 assert.equal(response.status,302);const location=new URL(response.headers.get('Location'));
 assert.equal(location.origin,'https://accounts.google.com');assert.equal(location.searchParams.get('scope'),'openid email profile');
 assert.equal(location.searchParams.get('redirect_uri'),'https://cat-hien.example/api/auth/google/callback');
 const setCookie=response.headers.get('Set-Cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);assert.match(setCookie,/Secure/);
});

test('Cookie parsing and session hashing are deterministic without exposing the raw token',async()=>{
 const request=new Request('https://test/api/me',{headers:{Cookie:'other=1; cat_hien_session=my-secret-session'}});
 assert.equal(cookieValue(request,'cat_hien_session'),'my-secret-session');const hash=await hashToken('my-secret-session');assert.equal(hash.length,64);assert.ok(!hash.includes('my-secret-session'));assert.equal(hash,await hashToken('my-secret-session'));
});

test('Local registration hashes the password and creates an HttpOnly session',async()=>{
 const runs=[],statements=[];
 const env={DB:{prepare(sql){const statement={sql,args:[],bind(...args){this.args=args;return this;},async first(){return null;},async run(){runs.push(this);return {};}};statements.push(statement);return statement;},async batch(items){for(const item of items)runs.push(item);return items.map(()=>({meta:{changes:1}}));}}};
 const request=new Request('https://cat-hien.example/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://cat-hien.example'},body:JSON.stringify({name:'Độc giả',email:'Reader@Example.com',password:'mat-khau-rieng',acceptTerms:true})});
 const response=await authRoute(request,env,new URL(request.url),'/api/auth/register');assert.equal(response.status,201);assert.match(response.headers.get('Set-Cookie'),/cat_hien_session=/);assert.match(response.headers.get('Set-Cookie'),/HttpOnly/);
 const credential=runs.find(item=>item.sql.startsWith('INSERT INTO reader_credentials'));assert.ok(credential);assert.equal(credential.args[1],'reader@example.com');assert.notEqual(credential.args[2],'mat-khau-rieng');assert.ok(credential.args[2].length>20);assert.ok(runs.some(item=>item.sql.startsWith('INSERT INTO reader_sessions')));
});

test('Password hashes stay within the deployed PBKDF2 limit and older 210,000-iteration hashes still log in',async()=>{
 const credentials=new Map(),sessions=[];
 const env={DB:{prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return sql.startsWith('SELECT')?credentials.get(this.args[0])||null:null;},async run(){if(sql.startsWith('INSERT INTO reader_sessions'))sessions.push(this.args);return {};}};},async batch(items){for(const item of items)if(item.sql.startsWith('INSERT INTO reader_credentials'))credentials.set(item.args[1],{user_id:item.args[0],password_hash:item.args[2],password_salt:item.args[3]});return items.map(()=>({meta:{changes:1}}));}}};
 const call=(path,body)=>{const request=new Request('https://cat-hien.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return authRoute(request,env,new URL(request.url),path);};
 assert.equal((await call('/api/auth/register',{name:'Lan',email:'lan@example.test',password:'mat-khau-moi',acceptTerms:true})).status,201);
 assert.match(credentials.get('lan@example.test').password_hash,/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{43}=$/);
 assert.equal((await call('/api/auth/login',{email:'lan@example.test',password:'mat-khau-moi'})).status,200);
 assert.equal((await call('/api/auth/login',{email:'lan@example.test',password:'mat-khau-sai'})).status,401);
 const salt=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',new TextEncoder().encode('mat-khau-cu'),'PBKDF2',false,['deriveBits']);
 const legacy=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:210000},key,256)),base64=bytes=>btoa(String.fromCharCode(...bytes));
 credentials.set('cu@example.test',{user_id:'old-user',password_hash:base64(legacy),password_salt:base64(salt)});
 assert.equal((await call('/api/auth/login',{email:'cu@example.test',password:'mat-khau-cu'})).status,200);
 assert.equal((await call('/api/auth/login',{email:'cu@example.test',password:'mat-khau-moi'})).status,401);
 assert.equal(sessions.length,3);
});

test('Local registration rejects short passwords and cross-origin requests',async()=>{
 const env={DB:{prepare(){throw new Error('Database must not be touched');}}};
 const crossOrigin=new Request('https://cat-hien.example/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal((await authRoute(crossOrigin,env,new URL(crossOrigin.url),'/api/auth/register')).status,403);
 const shortPassword=new Request('https://cat-hien.example/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Reader',email:'reader@example.com',password:'short'})});await assert.rejects(()=>authRoute(shortPassword,env,new URL(shortPassword.url),'/api/auth/register'),/8 đến 128/);
});

test('Authenticated reader can upload a private request and source link stays optional',async()=>{
 const objects=new Map(),writes=[];
 const env={DB:{prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){if(sql.includes('reader_sessions'))return {id:'reader-1',email:'reader@example.com',name:'Reader',picture:''};return null;},async run(){writes.push({sql,args:this.args});return {};}};}},FILES:{async put(key,value){objects.set(key,value);},async delete(key){objects.delete(key);}}};
 const form=new FormData();form.set('title','Hồng Nghiệp');form.set('visibility','private');form.set('file',new File(['nội dung'],'source.txt',{type:'text/plain'}));
 const response=await worker.fetch(new Request('https://test/api/requests',{method:'POST',headers:{Cookie:'cat_hien_session=session-token'},body:form}),env,{});
 assert.equal(response.status,201);assert.equal(objects.size,1);const insert=writes.find(x=>x.sql.startsWith('INSERT INTO requests'));assert.ok(insert);assert.equal(insert.args[4],'reader-1');assert.equal(insert.args[5],'private');assert.equal(insert.args[2],'');
});
