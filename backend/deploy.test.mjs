import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {appliedMigrationNames,collisionMessage,collisions,configProblems,confirmed,main,parseDeployOutput,parseJsonOutput,parseJsonc,parseSecretsText,pendingMigrations,placeholderFiles,PLACEHOLDER,postDeployChecks,secretProblems,validateSecretsFile,VENDOR_FILES} from './deploy.mjs';

// Every Cloudflare, git and npm call goes through a fake runner and a fake fetch: these tests never reach the network.
const UUID='0f6c1d6e-6a52-4c3b-9b1e-2f3a4b5c6d7e',SHA='abc123def456',PREVIOUS='11111111-2222-4333-8444-555555555555',NEW='99999999-8888-4777-8666-555555555555';
const BOOKMARK='00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const ADMIN='adm1n-S3cret-'+'k7'.repeat(20),PDF_TOKEN='pdf-T0ken-'+'q4'.repeat(12),PDF_URL='https://pdf.hoatri.example.org';
const VALUES=[ADMIN,PDF_TOKEN,'AIza-fake-not-a-key-0000'];
// Built at run time so the repository never contains a string shaped like a real Google API key (CI greps for one).
const FAKE_KEY='AIza'+'x'.repeat(35);
const temp=[];test.after(()=>{for(const dir of temp)rmSync(dir,{recursive:true,force:true});});
const tempDir=prefix=>{const dir=mkdtempSync(join(tmpdir(),prefix));temp.push(dir);return dir;};
const write=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);return file;};
const config=(changes={})=>({name:'muc-viet-cms',main:'backend/worker.js',vars:{GEMINI_MODEL:'gemini-3.6-flash',REGISTRATION_MODE:'open'},observability:{enabled:true,redact_query_string:true},d1_databases:[{binding:'DB',database_name:'muc-viet',database_id:UUID,preview_database_id:'local-db',migrations_dir:'database/migrations'}],r2_buckets:[{binding:'FILES',bucket_name:'muc-viet-files'}],...changes});

function project({cfg=config(),migrations=['0001_initial.sql','0002_more.sql'],pages={'index.html':'<!doctype html><title>Hoa Trí</title>'}}={}){
 const root=tempDir('hoa-tri-deploy-root-');
 write(join(root,'wrangler.jsonc'),`// test project\n${JSON.stringify(cfg,null,2)}`);
 for(const name of migrations)write(join(root,'database/migrations',name),'SELECT 1;');
 for(const [name,text] of Object.entries(pages))write(join(root,'frontend',name),text);
 for(const file of ['node_modules/wrangler/bin/wrangler.js',...VENDOR_FILES])write(join(root,file),'');
 return root;
}
function secretsFile(text=`# production\nADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=${PDF_URL}\nexport PDF_LAYOUT_SERVICE_TOKEN="${PDF_TOKEN}"\n`,name='hoa-tri.secrets.env'){
 return write(join(tempDir('hoa-tri-secrets-'),name),text);
}
function fakeCloudflare(overrides={}){
 const calls=[],responses={
  'git status':{stdout:''},'git rev-parse --short=12':{stdout:`${SHA}\n`},'git rev-parse --abbrev-ref':{stdout:'main\n'},
  'wrangler whoami':{stdout:JSON.stringify({loggedIn:true,authType:'OAuth Token',email:'owner@example.org',accounts:[{id:'acc-1',name:'Hoa Tri'}]})},
  'wrangler r2 bucket info':{stdout:'{"name":"muc-viet-files"}'},
  'wrangler secret list':{stdout:JSON.stringify(['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN'].map(name=>({name,type:'secret_text'})))},
  'wrangler deployments status':{stdout:JSON.stringify({id:'d',versions:[{version_id:PREVIOUS,percentage:100}]})},
  'node backend/vendor.mjs':{},'node --test':{stdout:'# pass 291'},
  'wrangler deploy --dry-run':{stdout:'Total Upload: 3135.26 KiB / gzip: 663.56 KiB\n--dry-run: exiting now.'},
  'wrangler d1 execute':{stdout:JSON.stringify([{results:[{name:'0001_initial.sql'}],success:true,meta:{}}],null,2)},
  'wrangler d1 time-travel info':{stdout:JSON.stringify({bookmark:BOOKMARK})},
  'wrangler d1 migrations apply':{stdout:'✅ 0002_more.sql'},
  'wrangler deploy --strict':{stdout:`Uploaded muc-viet-cms (3.10 sec)\nDeployed muc-viet-cms triggers (0.42 sec)\n  https://muc-viet-cms.owner.workers.dev\nCurrent Version ID: ${NEW}\n`},
  ...overrides
 };
 const key=(command,args)=>basename(command)==='git'?`git ${args.join(' ')}`:String(args[0]).endsWith('wrangler.js')?`wrangler ${args.slice(1).join(' ')}`:`node ${args.join(' ')}`;
 const run=async(command,args,options={})=>{
  const name=key(command,args),match=Object.keys(responses).filter(prefix=>name.startsWith(prefix)).sort((a,b)=>b.length-a.length)[0];
  calls.push({name,args,options});const response=match?responses[match]:{};
  return {code:0,stdout:'',stderr:'',...(typeof response==='function'?response(name,options):response)};
 };
 return {run,calls,names:()=>calls.map(call=>call.name)};
}
function fakeSite({version=SHA,routes={}}={}){
 const requests=[];
 const fetch=async(url,init={})=>{
  const {pathname}=new URL(url),headers=new Headers(init.headers),method=init.method||'GET';requests.push({pathname,method,headers});
  if(routes[pathname])return routes[pathname]({method,headers});
  if(pathname==='/api/health')return Response.json({ok:true,service:'hoa-tri',version,database:'ok',pdfLayout:'configured'});
  if(pathname==='/')return new Response('<!doctype html>',{headers:{'content-type':'text/html; charset=utf-8','content-security-policy-report-only':"default-src 'self'"}});
  if(pathname==='/sitemap.xml')return new Response(`<urlset><url><loc>${new URL(url).origin}/</loc></url></urlset>`,{headers:{'content-type':'application/xml; charset=utf-8'}});
  if(pathname.endsWith('.js')||pathname.endsWith('.mjs'))return new Response(null,{headers:{'content-type':'text/javascript; charset=utf-8'}});
  if(pathname.endsWith('.tar'))return new Response(null,{headers:{'content-type':'application/x-tar'}});
  if(pathname==='/api/library')return Response.json([]);
  if(pathname==='/api/me')return Response.json({authenticated:false,googleConfigured:false,registration:{mode:'open',domains:[]},termsVersion:'2026-10'});
  if(pathname==='/api/status')return Response.json(headers.get('authorization')===`Bearer ${ADMIN}`?{authenticated:true,model:'gemini-3.6-flash'}:{authenticated:false});
  return Response.json({error:'Không tìm thấy chức năng.'},{status:404});
 };
 return {fetch,requests};
}
async function deploy(root,argv,{cloud=fakeCloudflare(),site=fakeSite(),interactive=false,answer='',env={}}={}){
 const lines=[];let asked=null;
 const code=await main({argv,root,env,run:cloud.run,fetch:site.fetch,interactive,sleep:async()=>{},ask:async question=>{asked=question;return answer;},log:line=>lines.push(String(line)),logError:line=>lines.push(String(line))});
 return {code,text:lines.join('\n'),cloud,site,asked};
}
const noSecretIn=text=>{for(const value of VALUES)assert.ok(!text.includes(value),'a secret value was printed');};

test('JSONC: comments and trailing commas are removed, never inside strings',()=>{
 assert.deepEqual(parseJsonc('\uFEFF{\n // note\n "a": "https://x//y", /* block */ "b": [1, 2,],\n "c": "/* kept */",\n}'),{a:'https://x//y',b:[1,2],c:'/* kept */'});
 assert.deepEqual(parseJsonc('{"q":"say \\"hi\\" // still text","r":{"s":[],},}'),{q:'say "hi" // still text',r:{s:[]}});
 assert.throws(()=>parseJsonc('{"a":1 /* open'),SyntaxError);
 assert.deepEqual(parseJsonc(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).d1_databases[0].preview_database_id,'local-db');
});

test('Config: refuses a local database id, secret-like vars and a secrets block; warns on preview_database_id',()=>{
 const repo=configProblems(parseJsonc(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')));
 if(repo.errors.length)assert.match(repo.errors.join('\n'),/database_id vẫn là "local-db": chạy npx(\.cmd)? wrangler d1 create muc-viet --binding DB --location apac --update-config/u);
 assert.deepEqual(repo.warnings,[]);
 assert.deepEqual(configProblems(config()),{errors:[],warnings:[]});
 const db={binding:'DB',database_name:'muc-viet',database_id:UUID,migrations_dir:'database/migrations'};
 assert.match(configProblems(config({d1_databases:[db]})).warnings.join(),/preview_database_id/u);
 const risky=configProblems(config({secrets:{required:['ADMIN_TOKEN']},vars:{ADMIN_TOKEN:'x',SMTP_PASSWORD:'x',GOOGLE_CLIENT_ID:'x',SOME_KEY:FAKE_KEY,GEMINI_MODEL:'gemini-3.6-flash'},r2_buckets:[]}));
 for(const word of ['"secrets"','ADMIN_TOKEN là bí mật','SMTP_PASSWORD là bí mật','GOOGLE_CLIENT_ID là bí mật','var SOME_KEY','"FILES"'])assert.ok(risky.errors.some(error=>error.includes(word)),word);
 assert.equal(risky.errors.length,6);
 assert.match(configProblems(config({observability:{enabled:true}})).warnings.join(),/redact_query_string/u);
 // The worker treats these as closed: say so before a launch that nobody can sign up for.
 assert.match(configProblems(config({vars:{REGISTRATION_MODE:'opne'}})).warnings.join(),/REGISTRATION_MODE "opne" không hợp lệ.*closed/u);
 assert.match(configProblems(config({vars:{REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:' '}})).warnings.join(),/ALLOWED_EMAIL_DOMAINS trống/u);
 for(const vars of [{REGISTRATION_MODE:' Closed '},{REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn'},{}])assert.deepEqual(configProblems(config({vars})).warnings,[],JSON.stringify(vars));
});

test('Secrets: ADMIN_TOKEN is required, the PDF and Google pairs come together, vars and secrets never share a name',()=>{
 const none=secretProblems([]);
 assert.match(none.errors.join(),/Thiếu secret: ADMIN_TOKEN\. Chạy npx(\.cmd)? wrangler secret put ADMIN_TOKEN hoặc dùng --secrets-file <tệp ngoài repo>/u);assert.match(none.warnings.join(),/Giữ bố cục PDF/u);
 assert.match(secretProblems(['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL']).errors.join(),/Thiếu secret: PDF_LAYOUT_SERVICE_TOKEN \(đã có PDF_LAYOUT_SERVICE_URL/u);
 assert.match(secretProblems(['ADMIN_TOKEN','GOOGLE_CLIENT_ID','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN']).errors.join(),/GOOGLE_CLIENT_SECRET/u);
 assert.deepEqual(secretProblems(['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN']),{errors:[],warnings:[]});
 assert.deepEqual(collisions(['GEMINI_MODEL','REGISTRATION_MODE'],['ADMIN_TOKEN','GEMINI_MODEL','GEMINI_MODEL']),['GEMINI_MODEL']);
 assert.match(collisionMessage('GEMINI_MODEL'),/^GEMINI_MODEL vừa là var vừa là secret: chạy npx(\.cmd)? wrangler secret delete GEMINI_MODEL$/u);
});

test('Migrations: pending ones keep file order, unknown applied ones are reported',()=>{
 assert.deepEqual(pendingMigrations(['0001_a.sql','0002_b.sql','0003_c.sql'],['0001_a.sql','0000_old.sql']),{pending:['0002_b.sql','0003_c.sql'],unknown:['0000_old.sql']});
 assert.deepEqual(appliedMigrationNames({code:0,stdout:'▲ [WARNING] note\n'+JSON.stringify([{results:[{name:'0001_a.sql'},{name:'0002_b.sql'}],success:true}])}),['0001_a.sql','0002_b.sql']);
 assert.deepEqual(appliedMigrationNames({code:1,stdout:JSON.stringify({error:{text:'no such table: d1_migrations: SQLITE_ERROR'}})}),[]);
 assert.throws(()=>appliedMigrationNames({code:1,stdout:'',stderr:'✘ [ERROR] Couldn\'t find a D1 DB with the name or binding \'DB\''}),/Không đọc được danh sách migration.*Couldn't find a D1 DB/u);
});

test('Secrets file: outside the repo, never .dev.vars, strong tokens, public https PDF root; values never in messages',()=>{
 const root=tempDir('hoa-tri-repo-'),varNames=['GEMINI_MODEL'];
 const good=validateSecretsFile(secretsFile(),{root,varNames});
 assert.deepEqual(good,{names:['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN'],errors:[]});
 assert.deepEqual(validateSecretsFile(secretsFile(JSON.stringify({ADMIN_TOKEN:ADMIN,GEMINI_API_KEY:'AIza-fake-not-a-key-0000'}),'s.json'),{root}).errors,[]);
 assert.match(validateSecretsFile(write(join(root,'secrets','prod.env'),`ADMIN_TOKEN=${ADMIN}\n`),{root}).errors.join(),/ngoài thư mục dự án/u);
 // A name that merely starts with two dots is still inside the project folder.
 assert.match(validateSecretsFile(write(join(root,'..prod.env'),`ADMIN_TOKEN=${ADMIN}\n`),{root}).errors.join(),/ngoài thư mục dự án/u);
 const sibling=join(dirname(root),`${basename(root)}-secrets`);temp.push(sibling);
 assert.deepEqual(validateSecretsFile(write(join(sibling,'prod.env'),`ADMIN_TOKEN=${ADMIN}\n`),{root}).errors,[],'a sibling folder whose name starts like the project is outside');
 assert.deepEqual(validateSecretsFile(secretsFile(`ADMIN_TOKEN=${ADMIN}\n`,'.dev.vars.production'),{root}).errors,['Không dùng .dev.vars làm tệp secret: tệp này chứa địa chỉ 127.0.0.1 và khóa cá nhân.']);
 const cases=[
  [`ADMIN_TOKEN=short`,/ADMIN_TOKEN cần một chuỗi ngẫu nhiên mới/u],
  [`ADMIN_TOKEN=replace-with-a-long-random-secret-${'x'.repeat(20)}`,/ADMIN_TOKEN cần/u],
  [`ADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=http://pdf.hoatri.example.org`,/PDF_LAYOUT_SERVICE_URL phải là gốc https/u],
  [`ADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=https://127.0.0.1:8091`,/PDF_LAYOUT_SERVICE_URL/u],
  [`ADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=https://pdf-layout`,/PDF_LAYOUT_SERVICE_URL/u],
  [`ADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=https://pdf.hoatri.example.org/api`,/không thêm đường dẫn/u],
  [`ADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_TOKEN=${PDF_TOKEN.slice(0,10)}`,/PDF_LAYOUT_SERVICE_TOKEN cần tối thiểu 24/u],
  [`ADMIN_TOKEN=${ADMIN}\nADMIN_TOKEN=${ADMIN}`,/ADMIN_TOKEN xuất hiện hai lần/u],
  [`ADMIN_TOKEN=${ADMIN}\nGEMINI_API_KEY=`,/GEMINI_API_KEY để trống/u],
  [`ADMIN_TOKEN=${ADMIN}#tail`,/dấu #/u],
  [`ADMIN_TOKEN=${ADMIN}\nthis is not a pair`,/Dòng 2 /u],
  [`ADMIN_TOKEN=${ADMIN}\nGEMINI_MODEL=gemini-3.6-flash`,/GEMINI_MODEL đã là var/u],
  ['["ADMIN_TOKEN"]',/object/u]
 ];
 for(const [text,pattern] of cases){const result=validateSecretsFile(secretsFile(text),{root,varNames});assert.match(result.errors.join('\n'),pattern,text);noSecretIn(result.errors.join('\n'));}
 assert.deepEqual(parseSecretsText(`A='single # kept'\nB="double"\nC=plain # comment`).entries,[['A','single # kept'],['B','double'],['C','plain']]);
 assert.match(validateSecretsFile(join(tempDir('hoa-tri-none-'),'missing.env'),{root}).errors.join(),/Không đọc được tệp secret/u);
});

test('Public pages with unfilled placeholders are found (HTML and JS only)',()=>{
 const root=project({pages:{'index.html':'ok','dieu-khoan.html':`Bên vận hành: ${PLACEHOLDER}: tên]]`,'site-footer.js':`'${PLACEHOLDER}: email]]'`,'note.css':PLACEHOLDER}});
 assert.deepEqual(placeholderFiles(root),['frontend/dieu-khoan.html','frontend/site-footer.js']);
});

test('Wrangler output: JSON among warnings, deploy URL and version, the CÓ confirmation',()=>{
 assert.deepEqual(parseJsonOutput('▲ [WARNING] "x" is "unclosed\n{"a":[1,{"b":"]"}]}\ntrailing text'),{a:[1,{b:']'}]});
 assert.equal(parseJsonOutput('no json here'),null);
 assert.deepEqual(parseDeployOutput(`Deployed muc-viet-cms triggers (0.4 sec)\n  https://muc-viet-cms.owner.workers.dev\nCurrent Version ID: ${NEW}`),{url:'https://muc-viet-cms.owner.workers.dev',versionId:NEW});
 assert.deepEqual(parseDeployOutput('Deployed hoa-tri triggers (1 sec)\n  hoatri.example.org (custom domain)\n'),{url:'https://hoatri.example.org',versionId:null});
 assert.deepEqual(parseDeployOutput('Deployed hoa-tri triggers (1 sec)\n  hoatri.example.org (custom domain - zone name: example.org)\n'),{url:'https://hoatri.example.org',versionId:null});
 assert.deepEqual(parseDeployOutput('No targets deployed for hoa-tri'),{url:null,versionId:null});
 for(const yes of ['CÓ','có','co',' Co '])assert.equal(confirmed(yes),true,yes);
 for(const no of ['c','không','','yes'])assert.equal(confirmed(no),false,no);
});

test('Post-deploy checks: health version, CSP, vendor types, library, admin token only on /api/status',async()=>{
 const base='https://hoatri.example.vn',site=fakeSite();
 const good=await postDeployChecks(base,{fetch:site.fetch,sha:SHA,adminToken:ADMIN,sleep:async()=>{}});
 assert.deepEqual(good.filter(r=>r.level!=='ok'),[]);assert.equal(good.length,10);
 assert.match(good.find(r=>r.text.startsWith('/sitemap.xml')).text,/https:\/\/hoatri\.example\.vn/u);assert.match(good.find(r=>r.text.includes('404')).text,/frontend\/404\.html/u);
 assert.ok(site.requests.some(r=>r.method==='HEAD'&&!['/','/sitemap.xml'].includes(r.pathname)&&!r.pathname.startsWith('/vendor/')&&!r.pathname.startsWith('/api/')),'a made-up path is asked for');
 // On a workers.dev name the site works, but every shared link shows that name: attach a domain before sharing.
 const workersDev=await postDeployChecks('https://muc-viet-cms.owner.workers.dev',{fetch:fakeSite().fetch,sha:SHA,sleep:async()=>{}});
 assert.deepEqual(workersDev.filter(r=>r.level==='warn').map(r=>r.text.split(':')[0]),['Trang đang chạy ở muc-viet-cms.owner.workers.dev']);
 assert.match(workersDev.find(r=>r.level==='warn').text,/Gắn tên miền riêng trước khi chia sẻ link đầu tiên/u);
 // The single-page fallback of older deploys (200 for any path) and a missing sitemap are reported.
 const spa=await postDeployChecks(base,{fetch:fakeSite({routes:{'/khong-co-trang-nay-hoa-tri':()=>new Response(null,{headers:{'content-type':'text/html'}}),'/sitemap.xml':()=>new Response('<!doctype html>',{status:404,headers:{'content-type':'text/html'}})}}).fetch,sha:SHA,sleep:async()=>{}});
 assert.deepEqual(spa.filter(r=>r.level==='warn').map(r=>r.text.split(' trả ')[0]),['/sitemap.xml','Đường dẫn không tồn tại']);
 assert.deepEqual(site.requests.filter(r=>r.headers.has('authorization')).map(r=>r.pathname),['/api/status']);
 assert.ok(site.requests.filter(r=>r.pathname.startsWith('/vendor/')).every(r=>r.method==='HEAD'));
 let waits=0;
 const stale=await postDeployChecks(base,{fetch:fakeSite({version:'old'}).fetch,sha:SHA,sleep:async()=>{waits++;},attempts:3});
 assert.equal(waits,2);assert.match(stale.find(r=>r.level==='warn').text,/chưa phải abc123def456/u);
 const html=()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}});
 const broken=await postDeployChecks(base,{fetch:fakeSite({routes:{'/api/health':()=>Response.json({error:'x'},{status:404}),'/vendor/pdf.mjs':html,'/api/library':html,'/':()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}})}}).fetch,adminToken:'wrong-token',sleep:async()=>{}});
 const text=level=>broken.filter(r=>r.level===level).map(r=>r.text).join('\n');
 assert.match(text('warn'),/chưa có \/api\/health/u);assert.match(text('warn'),/Content-Security-Policy/u);
 assert.match(text('error'),/\/vendor\/pdf\.mjs trả 200 \(text\/html\)/u);assert.match(text('error'),/\/api\/library/u);assert.match(text('error'),/HOATRI_ADMIN_TOKEN/u);
 const down=await postDeployChecks(base,{fetch:fakeSite({routes:{'/api/health':()=>Response.json({ok:false,database:'error'},{status:503})}}).fetch,sleep:async()=>{}});
 assert.match(down.find(r=>r.level==='error').text,/503/u);
});

test('Post-deploy checks: a too-short ADMIN_TOKEN is named even without a token, the SPA fallback never passes for a file',async()=>{
 const base='https://hoc.truong.edu.vn',sleep=async()=>{};
 const short=()=>Response.json({authenticated:false,adminTokenTooShort:true});
 for(const adminToken of ['',ADMIN]){
  const results=await postDeployChecks(base,{fetch:fakeSite({routes:{'/api/status':short}}).fetch,adminToken,sleep});
  const errors=results.filter(r=>r.level==='error').map(r=>r.text);
  assert.deepEqual(errors,[`ADMIN_TOKEN của production ngắn hơn 32 ký tự nên trang quản trị đang khóa: đặt lại bằng ${process.platform==='win32'?'npx.cmd':'npx'} wrangler secret put ADMIN_TOKEN (nên dùng 64 ký tự hex).`],adminToken?'with a token':'without a token');
 }
 const octet=()=>new Response(null,{headers:{'content-type':'application/octet-stream'}}),html=()=>new Response('<!doctype html>',{headers:{'content-type':'text/html; charset=utf-8'}});
 const tar=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/paddle/models/det.tar':octet}}).fetch,sleep});
 assert.deepEqual(tar.filter(r=>r.level!=='ok'),[],'any non-HTML type is a real file');
 const fallback=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/paddle/models/det.tar':html,'/vendor/pdf-lib.esm.min.js':octet}}).fetch,sleep});
 assert.deepEqual(fallback.filter(r=>r.level==='error').map(r=>r.text.split(' trả ')[0]),['/vendor/pdf-lib.esm.min.js','/vendor/paddle/models/det.tar']);
 assert.match(tar.find(r=>r.text.startsWith('/api/me')).text,/đăng ký: ai cũng tạo được tài khoản/u);
 const domain=await postDeployChecks(base,{fetch:fakeSite({routes:{'/api/me':()=>Response.json({authenticated:false,registration:{mode:'domain',domains:['truong.edu.vn','hs.truong.edu.vn']}})}}).fetch,sleep});
 assert.match(domain.find(r=>r.text.startsWith('/api/me')).text,/chỉ email thuộc truong\.edu\.vn, hs\.truong\.edu\.vn/u);
 // The lookup data is checked only when it was built on this machine.
 const manifest=()=>Response.json({format:1,id:'0123456789ab',base:'/vendor/dict/v/0123456789ab/'});
 assert.match((await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/dict/manifest.json':manifest}}).fetch,dictionary:true,sleep})).find(r=>r.text.startsWith('/vendor/dict')).text,/0123456789ab/u);
 const missing=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/dict/manifest.json':html}}).fetch,dictionary:true,sleep});
 assert.match(missing.find(r=>r.level==='error').text,/manifest\.json trả 200 \(text\/html; charset=utf-8\).*npm run prepare:dict/u);
 const skipped=fakeSite();await postDeployChecks(base,{fetch:skipped.fetch,sleep});
 assert.ok(!skipped.requests.some(r=>r.pathname.startsWith('/vendor/dict/')));
});

test('Deploy refuses a local database id before any Cloudflare call',async()=>{
 const run=await deploy(project({cfg:config({d1_databases:[{binding:'DB',database_name:'muc-viet',database_id:'local-db',preview_database_id:'local-db',migrations_dir:'database/migrations'}]})}),[]);
 assert.equal(run.code,1);assert.match(run.text,/wrangler d1 create muc-viet --binding DB --location apac --update-config/u);assert.match(run.text,/chưa thay đổi gì trên Cloudflare/u);
 assert.ok(run.cloud.names().every(name=>name.startsWith('git ')));
});

test('Deploy refuses uncommitted changes and unfilled public pages unless told otherwise',async()=>{
 const dirty=fakeCloudflare({'git status':{stdout:' M backend/worker.js\n?? notes.txt\n'}});
 const refused=await deploy(project(),['--check','--skip-tests'],{cloud:dirty});
 assert.equal(refused.code,1);assert.match(refused.text,/Có 2 tệp thay đổi chưa commit/u);assert.ok(!refused.cloud.names().some(name=>name.startsWith('wrangler')));
 const allowed=await deploy(project(),['--check','--skip-tests','--allow-dirty'],{cloud:fakeCloudflare({'git status':{stdout:' M a\n'},'wrangler d1 execute':{stdout:JSON.stringify([{results:[{name:'0001_initial.sql'},{name:'0002_more.sql'}]}])}})});
 assert.equal(allowed.code,0,allowed.text);assert.match(allowed.text,/commit abc123def456-dirty/u);
 const pages=project({pages:{'quyen-rieng-tu.html':`${PLACEHOLDER}: email liên hệ]]`}});
 assert.match((await deploy(pages,['--check','--skip-tests'])).text,/frontend\/quyen-rieng-tu\.html/u);
 assert.doesNotMatch((await deploy(pages,['--check','--skip-tests','--allow-placeholders'])).text,/quyen-rieng-tu/u);
});

test('Deploy needs a Cloudflare login, one chosen account, the R2 bucket and the required secrets',async()=>{
 const cases=[
  [{'wrangler whoami':{code:1,stdout:'{"loggedIn":false}'}},/wrangler login/u],
  [{'wrangler whoami':{stdout:JSON.stringify({loggedIn:true,accounts:[{id:'a',name:'A'},{id:'b',name:'B'}]})}},/CLOUDFLARE_ACCOUNT_ID=<id>/u],
  [{'wrangler r2 bucket info':{code:1,stderr:'✘ [ERROR] The specified bucket does not exist.'}},/r2 bucket create muc-viet-files --location apac/u],
  [{'wrangler secret list':{stdout:'[{"name":"PDF_LAYOUT_SERVICE_URL"},{"name":"PDF_LAYOUT_SERVICE_TOKEN"}]'}},/Thiếu secret: ADMIN_TOKEN/u],
  [{'wrangler secret list':{stdout:'[{"name":"ADMIN_TOKEN"},{"name":"GEMINI_MODEL"}]'}},/GEMINI_MODEL vừa là var vừa là secret: chạy npx(\.cmd)? wrangler secret delete GEMINI_MODEL/u],
  [{'wrangler secret list':{code:1,stderr:'✘ [ERROR] Worker "muc-viet-cms" not found.\nIf this is a new Worker, run `wrangler deploy` first to create it.'}},/Lần deploy đầu cần --secrets-file/u],
  [{'wrangler secret list':{code:1,stderr:'✘ [ERROR] A request to the Cloudflare API failed.\n  This Worker does not exist on your account. [code: 10007]'}},/Lần deploy đầu cần --secrets-file/u],
  // Any other failure is not taken for a first deploy (that would allow creating a second Worker).
  [{'wrangler secret list':{code:1,stderr:'✘ [ERROR] A request to the Cloudflare API failed.\n  Route not found or account not found [code: 7003]'}},/Không đọc được secret của Worker: .*7003/u]
 ];
 for(const [overrides,pattern] of cases){
  const run=await deploy(project(),['--yes'],{cloud:fakeCloudflare(overrides)});
  assert.equal(run.code,1);assert.match(run.text,pattern);
  assert.ok(!run.cloud.names().some(name=>/^wrangler (deploy --strict|d1 migrations apply)/u.test(name)),pattern.source);
 }
 const chosen=await deploy(project(),['--check','--skip-tests'],{env:{CLOUDFLARE_ACCOUNT_ID:'b'},cloud:fakeCloudflare({'wrangler whoami':{stdout:JSON.stringify({loggedIn:true,accounts:[{id:'a',name:'A'},{id:'b',name:'B'}]})}})});
 assert.match(chosen.text,/account "B"/u);
});

test('Pending migrations are listed by --check and need CÓ (or --yes) before they are applied',async()=>{
 const check=await deploy(project(),['--check']);
 assert.equal(check.code,0,check.text);assert.match(check.text,/Migration chờ áp dụng \(1\): 0002_more\.sql/u);
 assert.ok(!check.cloud.names().some(name=>/^wrangler (deploy --strict|d1 migrations apply|d1 time-travel)/u.test(name)));
 const batch=await deploy(project(),[]);
 assert.equal(batch.code,1);assert.match(batch.text,/Không có terminal để xác nhận migration/u);assert.ok(!batch.cloud.names().some(name=>/^wrangler (deploy --strict|d1 migrations apply)/u.test(name)));
 const cancelled=await deploy(project(),[],{interactive:true,answer:'không'});
 assert.equal(cancelled.code,1);assert.match(cancelled.asked,/Áp dụng 1 migration lên D1 production\? Gõ CÓ để tiếp tục:/u);assert.ok(!cancelled.cloud.names().some(name=>name.startsWith('wrangler d1 migrations apply')));
 const accepted=await deploy(project(),[],{interactive:true,answer:'có'});
 assert.equal(accepted.code,0,accepted.text);assert.ok(accepted.cloud.names().some(name=>name==='wrangler d1 migrations apply DB --remote'));
 const stale=await deploy(project(),['--yes'],{cloud:fakeCloudflare({'wrangler d1 execute':{stdout:JSON.stringify([{results:[{name:'0001_initial.sql'},{name:'0099_newer.sql'}]}])}})});
 assert.equal(stale.code,1);assert.match(stale.text,/0099_newer\.sql.*git pull/u);
});

test('A full deploy: tests with paid APIs blocked, migrations, tagged deploy, live checks and rollback commands',async()=>{
 const file=secretsFile(),root=project(),run=await deploy(root,['--yes','--secrets-file',file],{env:{HOATRI_ADMIN_TOKEN:ADMIN,npm_execpath:'/opt/npm/bin/npm-cli.js'}});
 assert.equal(run.code,0,run.text);
 const names=run.cloud.names().filter(name=>!name.startsWith('git '));
 assert.deepEqual(names.map(name=>name.split(' --')[0].replace(/ (DB|muc-viet-files)$/u,'')),['wrangler whoami','wrangler r2 bucket info','wrangler secret list','wrangler deployments status','node backend/vendor.mjs','node /opt/npm/bin/npm-cli.js test','wrangler deploy','wrangler d1 execute','wrangler d1 time-travel info','wrangler d1 migrations apply','wrangler deploy']);
 const tests=run.cloud.calls.find(call=>call.name.endsWith('npm-cli.js test'));
 assert.match(tests.options.env.NODE_OPTIONS,/^--import=file:\/\/.*backend\/test-support\/no-paid-api\.mjs$/u);
 const deployed=run.cloud.calls.at(-1).args.slice(1);
 assert.deepEqual(deployed.slice(0,6),['deploy','--strict','--tag',SHA,'--message',`main@${SHA}`]);assert.equal(deployed[6],'--secrets-file');assert.equal(basename(deployed[7]),basename(file));
 assert.ok(run.site.requests.some(r=>r.pathname==='/api/health'));assert.match(run.text,/OK {2}\/api\/status: mã quản trị đúng/u);
 assert.match(run.text,new RegExp(`wrangler rollback ${PREVIOUS}`,'u'));assert.match(run.text,new RegExp(`time-travel restore DB --bookmark=${BOOKMARK}`,'u'));
 noSecretIn(run.text);
 const failed=await deploy(project(),['--yes','--skip-tests'],{cloud:fakeCloudflare({'wrangler d1 migrations apply':{code:1,stderr:'✘ [ERROR] Migration 0002_more.sql failed'}})});
 assert.equal(failed.code,1);assert.ok(!failed.cloud.names().some(name=>name.startsWith('wrangler deploy --strict')));assert.match(failed.text,/time-travel restore DB --bookmark=/u);
 const unhealthy=await deploy(project(),['--yes','--skip-tests'],{site:fakeSite({routes:{'/api/me':()=>new Response('oops',{status:500})}})});
 assert.equal(unhealthy.code,1);assert.match(unhealthy.text,/1 kiểm tra sau deploy chưa đạt/u);
});

test('The optional lookup dictionary: a warning before deploy when it was never built, a live check when it was',async()=>{
 const unbuilt=project();write(join(unbuilt,'backend/prepare-dictionary.mjs'),'');
 const warned=await deploy(unbuilt,['--check','--skip-tests']);
 assert.equal(warned.code,0,warned.text);assert.match(warned.text,/CẢNH BÁO: Chưa có dữ liệu từ điển.*npm run prepare:dict/u);
 assert.doesNotMatch((await deploy(project(),['--check','--skip-tests'])).text,/từ điển/u,'no warning in a checkout without the dictionary feature');
 const built=project();write(join(built,'backend/prepare-dictionary.mjs'),'');write(join(built,'frontend/vendor/dict/manifest.json'),'{"format":1}');
 const html=()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}});
 const run=await deploy(built,['--yes','--skip-tests'],{site:fakeSite({routes:{'/vendor/dict/manifest.json':html}})});
 assert.equal(run.code,1);assert.doesNotMatch(run.text,/CẢNH BÁO: Chưa có dữ liệu từ điển/u);assert.match(run.text,/LỖI: \/vendor\/dict\/manifest\.json trả 200/u);
});
