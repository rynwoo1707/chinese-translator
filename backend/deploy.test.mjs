import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {appliedMigrationNames,collisionMessage,collisions,configProblems,confirmed,dictionaryProblem,main,parseDeployOutput,parseJsonOutput,parseJsonc,parseSecretsText,pendingMigrations,placeholderFiles,PLACEHOLDER,postDeployChecks,secretProblems,securityTxtProblems,sourceUrl,validateSecretsFile,VENDOR_FILES} from './deploy.mjs';

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

// A project published at its "Mã nguồn" link (branch main of rynwoo1707/chinese-translator), with the lookup dictionary
// built and a filled-in security.txt that expires in 200 days.
const REPO='https://github.com/rynwoo1707/chinese-translator',DICT_ID='0123456789ab';
const footer=(url=`${REPO}/tree/main`)=>`export const SOURCE_URL='${url}';\nexport const SERVICE_SOURCE_URL=\`\${SOURCE_URL}/services/pdf-layout\`;\n`;
const securityTxt=({contact='mailto:lienhe@hoatri.example.org',expires=new Date(Date.now()+200*86400000).toISOString()}={})=>`# Hoa Trí\nContact: ${contact}\nExpires: ${expires}\nPreferred-Languages: vi, en\n`;
function project({cfg=config(),migrations=['0001_initial.sql','0002_more.sql'],pages={},dictionary=true}={}){
 const root=tempDir('hoa-tri-deploy-root-');
 write(join(root,'wrangler.jsonc'),`// test project\n${JSON.stringify(cfg,null,2)}`);
 for(const name of migrations)write(join(root,'database/migrations',name),'SELECT 1;');
 for(const [name,text] of Object.entries({'index.html':'<!doctype html><title>Hoa Trí</title>','site-footer.js':footer(),'.well-known/security.txt':securityTxt(),...pages}))if(text!==null)write(join(root,'frontend',name),text);
 for(const file of ['node_modules/wrangler/bin/wrangler.js',...VENDOR_FILES])write(join(root,file),'');
 if(dictionary){write(join(root,'frontend/vendor/dict/manifest.json'),JSON.stringify({format:1,id:DICT_ID,base:`/vendor/dict/v/${DICT_ID}/`}));write(join(root,`frontend/vendor/dict/v/${DICT_ID}/i/00.json`),'{}');}
 paddleModels(root);
 return root;
}
// A miniature backend/paddle-models (two 1 KiB tars and their manifest): deploy checks it with the real checkPaddleModels.
function paddleModels(root){
 const models=['det.tar','rec.tar'].map((file,index)=>{const bytes=Buffer.alloc(1024,index+1);bytes.write('ustar',257,'latin1');write(join(root,'backend/paddle-models',file),bytes);return {name:file,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
 write(join(root,'backend/paddle-models/manifest.json'),`${JSON.stringify({sdk:'@paddleocr/paddleocr-js@0.4.2',models},null,2)}\n`);
}
function secretsFile(text=`# production\nADMIN_TOKEN=${ADMIN}\nPDF_LAYOUT_SERVICE_URL=${PDF_URL}\nexport PDF_LAYOUT_SERVICE_TOKEN="${PDF_TOKEN}"\n`,name='hoa-tri.secrets.env'){
 return write(join(tempDir('hoa-tri-secrets-'),name),text);
}
function fakeCloudflare(overrides={}){
 const calls=[],responses={
  'git status':{stdout:''},'git rev-parse --short=12':{stdout:`${SHA}\n`},'git rev-parse --abbrev-ref':{stdout:'main\n'},
  'git remote -v':{stdout:`origin\t${REPO}.git (fetch)\norigin\t${REPO}.git (push)\n`},'git branch -r --contains HEAD':{stdout:'refs/remotes/origin/main\n'},
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
// The Worker as deployed: plain http:// answers 301 to https:// (backend/http.js), routes['http:'] replaces that.
function fakeSite({version=SHA,routes={}}={}){
 const requests=[];
 const fetch=async(url,init={})=>{
  const {pathname,protocol,host}=new URL(url),headers=new Headers(init.headers),method=init.method||'GET';requests.push({pathname,protocol,method,headers,redirect:init.redirect});
  if(protocol==='http:')return routes['http:']?routes['http:']({method,headers,redirect:init.redirect}):new Response(null,{status:301,headers:{location:`https://${host}${pathname}`}});
  if(routes[pathname])return routes[pathname]({method,headers});
  if(pathname==='/vendor/dict/manifest.json')return Response.json({format:1,id:DICT_ID,base:`/vendor/dict/v/${DICT_ID}/`});
  if(pathname.startsWith(`/vendor/dict/v/${DICT_ID}/`))return new Response(null,{headers:{'content-type':'application/json'}});
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
 // The layout hash is the deploy's own (--var): never a var of the file.
 assert.deepEqual(configProblems(config({vars:{GEMINI_MODEL:'gemini-3.6-flash',PDF_LAYOUT_VERSION:'1234abcd1234abcd'}})).errors,['PDF_LAYOUT_VERSION không đặt trong "vars" của wrangler.jsonc: npm run deploy tự truyền mã bố cục của bản code đang deploy. Hãy xóa dòng này.']);
 assert.deepEqual(configProblems(config({vars:{GEMINI_MODEL:'gemini-3.6-flash',PDF_LAYOUT_SLOTS:'2',DAILY_REGISTRATIONS_PER_IP:'150'}})),{errors:[],warnings:[]});
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

test('Public pages with unfilled placeholders are found (HTML and JS only), and so is security.txt',()=>{
 const root=project({pages:{'index.html':'ok','dieu-khoan.html':`Bên vận hành: ${PLACEHOLDER}: tên]]`,'site-footer.js':`'${PLACEHOLDER}: email]]'`,'note.css':PLACEHOLDER}});
 assert.deepEqual(placeholderFiles(root),['frontend/dieu-khoan.html','frontend/site-footer.js']);
 const security=project({pages:{'.well-known/security.txt':securityTxt({contact:`mailto:${PLACEHOLDER}: email liên hệ]]`})}});
 assert.deepEqual(placeholderFiles(security),['frontend/.well-known/security.txt']);
});

test('security.txt: a Contact address, and an Expires date in the future, under a year ahead (RFC 9116)',()=>{
 const now=new Date('2026-10-22T00:00:00Z'),check=text=>securityTxtProblems(text,now);
 assert.deepEqual(check(securityTxt({expires:'2027-10-21T00:00:00.000Z'})),{errors:[],warnings:[]});
 assert.deepEqual(check(securityTxt({contact:`mailto:${PLACEHOLDER}: email liên hệ]]`,expires:'2027-10-21T00:00:00.000Z'})).errors,[],'the blank is the placeholder check\'s');
 for(const contact of ['https://hoatri.example.org/lien-he','tel:+84 912 345 678'])assert.deepEqual(check(securityTxt({contact,expires:'2027-01-01T00:00:00Z'})).errors,[],contact);
 assert.match(check(securityTxt({contact:'lienhe@hoatri.example.org',expires:'2027-01-01T00:00:00Z'})).errors.join(),/phải là một địa chỉ mailto:, https:\/\/ hoặc tel:/u);
 assert.match(check('Expires: 2027-01-01T00:00:00Z\n').errors.join(),/thiếu dòng "Contact:"/u);
 for(const expires of ['','2027-01-01','next year'])assert.match(check(securityTxt({expires})).errors.join(),/cần đúng một dòng "Expires:" theo RFC 3339.*ví dụ Expires: 2027-09-17T00:00:00\.000Z\./u,expires);
 assert.match(check(`${securityTxt({expires:'2027-01-01T00:00:00Z'})}Expires: 2027-02-01T00:00:00Z\n`).errors.join(),/đúng một dòng "Expires:"/u);
 assert.match(check(securityTxt({expires:'2026-10-01T00:00:00Z'})).warnings.join(),/đã hết hạn từ 2026-10-01T00:00:00Z/u);
 assert.match(check(securityTxt({expires:'2026-11-05T00:00:00+07:00'})).warnings.join(),/hết hạn sau 14 ngày/u);
 assert.match(check(securityTxt({expires:'2028-01-01T00:00:00Z'})).warnings.join(),/xa hơn một năm/u);
 // The file in this repository: the contact blank keeps it from production until it is filled.
 const repo=readFileSync(new URL('../frontend/.well-known/security.txt',import.meta.url),'utf8'),today=new Date();
 assert.match(repo,/^Contact: mailto:/mu);assert.match(repo,/^Preferred-Languages: vi, en$/mu);
 assert.deepEqual(securityTxtProblems(repo,today).errors,[]);
 const expires=Date.parse(/^Expires: (.+)$/mu.exec(repo)[1]);assert.ok(expires>today.getTime()&&expires-today.getTime()<=366*86400000,'Expires within a year');
 assert.equal(repo.includes(PLACEHOLDER),placeholderFiles().includes('frontend/.well-known/security.txt'));
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
 assert.deepEqual(good.filter(r=>r.level!=='ok'),[]);assert.equal(good.length,12);
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
 assert.ok(site.requests.filter(r=>r.pathname.startsWith('/vendor/')&&r.pathname!=='/vendor/dict/manifest.json').every(r=>r.method==='HEAD'));
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
 // The lookup data is always checked: its manifest and the first index file of the folder it names.
 const looked=fakeSite();assert.match((await postDeployChecks(base,{fetch:looked.fetch,sleep})).find(r=>r.text.startsWith('/vendor/dict')).text,/0123456789ab, có tệp \/vendor\/dict\/v\/0123456789ab\/i\/00\.json/u);
 assert.deepEqual(looked.requests.filter(r=>r.pathname.startsWith('/vendor/dict/')).map(r=>`${r.method} ${r.pathname}`),['GET /vendor/dict/manifest.json','HEAD /vendor/dict/v/0123456789ab/i/00.json']);
 const missing=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/dict/manifest.json':html}}).fetch,sleep});
 assert.match(missing.find(r=>r.level==='error').text,/manifest\.json trả 200 \(text\/html; charset=utf-8\).*npm run prepare:dict/u);
 const partial=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/dict/v/0123456789ab/i/00.json':html}}).fetch,sleep});
 assert.match(partial.find(r=>r.level==='error').text,/^\/vendor\/dict\/v\/0123456789ab\/i\/00\.json trả 200 \(text\/html; charset=utf-8\): dữ liệu từ điển lên Worker chưa đủ/u);
 // Deployed without it on purpose (--allow-no-dictionary): still looked at, reported as a warning.
 const without=await postDeployChecks(base,{fetch:fakeSite({routes:{'/vendor/dict/manifest.json':html}}).fetch,dictionary:false,sleep});
 assert.deepEqual(without.filter(r=>r.level==='error'),[]);assert.match(without.find(r=>r.level==='warn').text,/chưa lên Worker \(đã deploy với --allow-no-dictionary\)/u);
});

test('Post-deploy checks: plain http:// must be sent on to https:// with a permanent redirect',async()=>{
 const base='https://hoatri.example.vn',sleep=async()=>{};
 const checks=async route=>{const site=fakeSite({routes:{'http:':route}}),results=await postDeployChecks(base,{fetch:site.fetch,sha:SHA,sleep});return {results,site,http:results.find(r=>r.text.includes('http://hoatri.example.vn/'))};};
 const moved=(status,location='https://hoatri.example.vn/')=>()=>new Response(null,{status,headers:{location}});
 const good=await checks(moved(301));
 assert.deepEqual(good.http,{level:'ok',text:'http://hoatri.example.vn/ chuyển sang https:// (301).'});
 const probe=good.site.requests.find(r=>r.protocol==='http:');assert.deepEqual([probe.pathname,probe.method,probe.redirect],['/','GET','manual'],'the redirect itself is read, not followed');
 assert.equal((await checks(moved(308))).http.level,'ok');
 assert.equal((await checks(moved(302))).http.level,'warn');
 for(const [route,pattern] of [
  [()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}}),/^http:\/\/hoatri\.example\.vn\/ trả 200 thay vì chuyển hướng 301 sang https:\/\/hoatri\.example\.vn\/: ai gõ http:\/\/ có thể đăng nhập qua kết nối không mã hóa\. .*insecureRequest.*Always Use HTTPS/u],
  [moved(301,'http://hoatri.example.vn/'),/trả 301 \(chuyển tới http:\/\/hoatri\.example\.vn\/\) thay vì/u],
  [moved(301,'https://other.example.org/'),/trả 301 \(chuyển tới https:\/\/other\.example\.org\/\)/u],
  [()=>Response.json({error:'Hoa Trí chỉ nhận thao tác này qua kết nối an toàn.',code:'https_required'},{status:403}),/trả 403/u]
 ]){const {http}=await checks(route);assert.equal(http.level,'error',pattern.source);assert.match(http.text,pattern);}
 const unreachable=await checks(()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}});});
 assert.equal(unreachable.http.level,'warn');assert.match(unreachable.http.text,/Không kiểm tra được http:\/\/hoatri\.example\.vn\/ \(ECONNREFUSED\)/u);
});

test('Post-deploy checks ask the PDF service through the new Worker: reachable, same layout checks, current image and font',async()=>{
 const base='https://hoatri.example.vn',sleep=async()=>{},site=fakeSite(),LAYOUT='1111111111111111',SERVICE='2222222222222222';
 const live={status:'ok',ms:42,busy:false,active:0,jobs:2,version:{layout:LAYOUT,service:SERVICE},expectedLayout:LAYOUT,layoutMatch:true,font:'LiberationSerif-Regular.ttf'};
 const asked=[],through=pdfService=>async(url,init)=>{if(!String(url).includes('deep=1'))return site.fetch(url,init);asked.push(String(url));return Response.json({ok:['ok','off'].includes(pdfService.status),service:'hoa-tri',version:SHA,database:'ok',pdfLayout:'configured',pdfService},{status:['ok','off'].includes(pdfService.status)?200:503});};
 const checks=(pdfService,options={})=>postDeployChecks(base,{fetch:through(pdfService),sha:SHA,layout:LAYOUT,service:SERVICE,sleep,...options});
 const good=await checks(live);
 assert.deepEqual(good.filter(r=>r.level!=='ok'),[]);assert.equal(asked.length,1);assert.equal(new URL(asked[0]).pathname,'/api/health');
 assert.equal(good.find(r=>r.text.startsWith('Dịch vụ PDF')).text,'Dịch vụ PDF trả lời qua Worker (42 ms, 2 việc cùng lúc, phông LiberationSerif-Regular.ttf); bộ kiểm tra bố cục khớp với Worker.');
 // An image built from older code, or with the old font: deployed, but the service should be rebuilt.
 const old=await checks({...live,version:{layout:LAYOUT,service:'3333333333333333'},font:'DejaVuSerif.ttf'});
 assert.deepEqual(old.filter(r=>r.level==='error'),[]);
 assert.deepEqual(old.filter(r=>r.level==='warn').map(r=>r.text),['Dịch vụ PDF đang chạy bản 3333333333333333, mã nguồn này là bản 2222222222222222: cập nhật dịch vụ PDF trên máy chủ (deploy/pdf-layout/README.md mục A.5).','Dịch vụ PDF xuất bằng phông DejaVuSerif.ttf, không phải Liberation Serif như image chuẩn: chữ Việt có thể nhỏ hơn bản đã thử. Build lại image (deploy/pdf-layout/README.md mục A.5).']);
 // Different layout checks on the two sides can refuse every scanned page: that is a failed deploy check.
 const mismatch=await checks({...live,status:'mismatch',version:{layout:'4444444444444444',service:SERVICE},layoutMatch:false});
 assert.match(mismatch.find(r=>r.level==='error').text,/mã bố cục 4444444444444444, còn Worker vừa deploy dùng 1111111111111111.*README\.md mục A\.5/u);
 for(const [status,pattern] of [['unauthorized',/từ chối token của Worker/u],['unreachable',/không kết nối được dịch vụ PDF/u],['timeout',/không trả lời Worker trong 5 giây/u],['error',/trả lời lỗi/u]]){
  const failed=await checks({status});assert.match(failed.filter(r=>r.level==='error').map(r=>r.text).join('\n'),pattern,status);
 }
 // A Worker without a PDF service configured is not asked; one older than the deep check is skipped silently.
 const off=fakeSite({routes:{'/api/health':()=>Response.json({ok:true,service:'hoa-tri',version:SHA,database:'ok',pdfLayout:'off'})}});
 await postDeployChecks(base,{fetch:off.fetch,sha:SHA,sleep});assert.equal(off.requests.filter(r=>r.pathname==='/api/health').length,1);
 assert.deepEqual((await postDeployChecks(base,{fetch:site.fetch,sha:SHA,sleep})).filter(r=>r.level!=='ok'),[]);
});

test('Deploy gives the Worker the hash of the shared PDF layout checks, so its health check can compare it with the service',async()=>{
 const pages={'index.html':'<!doctype html><title>Hoa Trí</title>','pdf-box-layout.js':'export const layout=1;\n','math-text.js':'export const math=2;\n'},root=project({pages});
 const hash=createHash('sha256');for(const file of ['frontend/pdf-box-layout.js','frontend/math-text.js'])hash.update(`${file}\n${readFileSync(join(root,file),'utf8')}\n`);
 const expected=hash.digest('hex').slice(0,16),run=await deploy(root,['--yes','--skip-tests']);
 assert.equal(run.code,0,run.text);const deployed=run.cloud.calls.at(-1).args.slice(1);
 assert.deepEqual(deployed.slice(0,6),['deploy','--strict','--tag',SHA,'--message',`main@${SHA}`]);assert.deepEqual(deployed.slice(-2),['--var',`PDF_LAYOUT_VERSION:${expected}`]);
 // Without those files (a partial copy) the Worker deploys without the var; its deep check then cannot compare.
 const bare=await deploy(project(),['--yes','--skip-tests']);assert.equal(bare.code,0,bare.text);assert.ok(!bare.cloud.calls.at(-1).args.includes('--var'));
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
 const blank=await deploy(pages,['--check','--skip-tests']);
 assert.equal(blank.code,1);assert.match(blank.text,/LỖI: Trang công khai còn chỗ "\[\[CHƯA ĐIỀN…" chưa điền: frontend\/quyen-rieng-tu\.html\. Điền thông tin thật/u);
 // --allow-placeholders is for a closed trial only: registration must not be open to everyone.
 const open=await deploy(pages,['--check','--skip-tests','--allow-placeholders']);
 assert.equal(open.code,1);assert.match(open.text,/LỖI: .*--allow-placeholders chỉ dành cho bản thử kín, nhưng wrangler\.jsonc đang mở đăng ký cho mọi người \(REGISTRATION_MODE "open"\)/u);
 assert.ok(!open.cloud.names().some(name=>name.startsWith('wrangler')));
 for(const vars of [{REGISTRATION_MODE:'closed'},{REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn'}]){
  const trial=await deploy(project({cfg:config({vars:{GEMINI_MODEL:'gemini-3.6-flash',...vars}}),pages:{'quyen-rieng-tu.html':`${PLACEHOLDER}: email liên hệ]]`,'.well-known/security.txt':securityTxt({contact:`mailto:${PLACEHOLDER}: email liên hệ]]`})}}),['--check','--skip-tests','--allow-placeholders']);
  assert.equal(trial.code,0,trial.text);assert.match(trial.text,new RegExp(`CẢNH BÁO: Trang công khai còn chỗ .*frontend/\\.well-known/security\\.txt, frontend/quyen-rieng-tu\\.html\\. Đây chỉ là bản thử kín \\(REGISTRATION_MODE "${vars.REGISTRATION_MODE}"\\)`,'u'));
 }
 // security.txt is checked like a page, and its own lines are checked too.
 const unfilled=await deploy(project({pages:{'.well-known/security.txt':securityTxt({contact:`mailto:${PLACEHOLDER}: email liên hệ]]`})}}),['--check','--skip-tests']);
 assert.equal(unfilled.code,1);assert.match(unfilled.text,/chưa điền: frontend\/\.well-known\/security\.txt\./u);
 const broken=await deploy(project({pages:{'.well-known/security.txt':'Contact: lienhe@hoatri.example.org\n'}}),['--check','--skip-tests']);
 assert.equal(broken.code,1);assert.match(broken.text,/LỖI: frontend\/\.well-known\/security\.txt: "Contact: lienhe@hoatri\.example\.org" phải là/u);assert.match(broken.text,/LỖI: frontend\/\.well-known\/security\.txt cần đúng một dòng "Expires:"/u);
 const none=await deploy(project({pages:{'.well-known/security.txt':null}}),['--check','--skip-tests']);
 assert.equal(none.code,0,none.text);assert.match(none.text,/CẢNH BÁO: Chưa có frontend\/\.well-known\/security\.txt \(RFC 9116\)/u);
});

test('Deploy refuses a commit that is not on the GitHub branch the “Mã nguồn” link opens, unless told it is a closed trial',async()=>{
 // This repository's link names its branch.
 assert.deepEqual(sourceUrl(),{url:'https://github.com/rynwoo1707/chinese-translator/tree/handoff/2026-10-16',owner:'rynwoo1707',repo:'chinese-translator',ref:'handoff/2026-10-16'});
 const published=await deploy(project(),['--check','--skip-tests']);
 assert.equal(published.code,0,published.text);assert.match(published.text,/Mã nguồn công khai của bản này: https:\/\/github\.com\/rynwoo1707\/chinese-translator\/tree\/abc123def456 \(nhánh main\)\./u);
 const branch=published.cloud.calls.find(call=>call.name.startsWith('git branch'));assert.deepEqual(branch.args,['branch','-r','--contains','HEAD','--format=%(refname)']);
 const notPushed=fakeCloudflare({'git branch -r --contains HEAD':{stdout:''}});
 const refused=await deploy(project(),['--yes','--skip-tests'],{cloud:notPushed});
 assert.equal(refused.code,1);assert.ok(!refused.cloud.names().some(name=>name.startsWith('wrangler')),'stopped before Cloudflare');
 assert.match(refused.text,/LỖI: Commit abc123def456 chưa có trên nhánh main của github\.com\/rynwoo1707\/chinese-translator, nơi liên kết “Mã nguồn” ở chân trang trỏ tới \(SOURCE_URL trong frontend\/site-footer\.js\)\. Dịch vụ PDF chạy PyMuPDF theo giấy phép GNU AGPL.*git push lên nhánh main.*\(--allow-unpushed nếu chỉ thử kín\.\)/u);
 const trial=await deploy(project(),['--check','--skip-tests','--allow-unpushed'],{cloud:fakeCloudflare({'git branch -r --contains HEAD':{stdout:''}})});
 assert.equal(trial.code,0,trial.text);assert.match(trial.text,/CẢNH BÁO: Commit abc123def456 chưa có trên nhánh main .* Bỏ qua vì có --allow-unpushed/u);
 const cases=[
  // On another branch only, or on the right branch of a fork.
  [{},{'git branch -r --contains HEAD':{stdout:'refs/remotes/origin/feature\n'}},/chưa có trên nhánh main/u],
  [{},{'git remote -v':{stdout:'origin\thttps://github.com/someone/fork.git (fetch)\n'}},/Không có git remote nào trỏ tới github\.com\/rynwoo1707\/chinese-translator/u],
  // A link that is no GitHub tree.
  [{'site-footer.js':footer('https://example.org/code')},{},/Không đọc được SOURCE_URL dạng https:\/\/github\.com\/<chủ>\/<repo>\/tree\/<nhánh> trong frontend\/site-footer\.js \(đang là https:\/\/example\.org\/code\)/u],
  [{'site-footer.js':null},{},/Không đọc được SOURCE_URL/u]
 ];
 for(const [pages,overrides,pattern] of cases){const run=await deploy(project({pages}),['--check','--skip-tests'],{cloud:fakeCloudflare(overrides)});assert.equal(run.code,1,pattern.source);assert.match(run.text,pattern);}
 // A link to a tag or a commit: HEAD's own tag or commit, published on a branch of that repository (ssh remotes too).
 const ssh={'git remote -v':{stdout:'upstream\tgit@github.com:RynWoo1707/Chinese-Translator.git (fetch)\n'},'git branch -r --contains HEAD':{stdout:'refs/remotes/upstream/release\n'}};
 const tagged=await deploy(project({pages:{'site-footer.js':footer(`${REPO}/tree/v1.2`)}}),['--check','--skip-tests'],{cloud:fakeCloudflare({...ssh,'git tag --points-at HEAD':{stdout:'v1.2\n'}})});
 assert.equal(tagged.code,0,tagged.text);
 const commit=await deploy(project({pages:{'site-footer.js':footer(`${REPO}/tree/${SHA}0000000000000000000000000000`)}}),['--check','--skip-tests'],{cloud:fakeCloudflare(ssh)});
 assert.equal(commit.code,0,commit.text);
 const otherTag=await deploy(project({pages:{'site-footer.js':footer(`${REPO}/tree/v1.1`)}}),['--check','--skip-tests'],{cloud:fakeCloudflare({...ssh,'git tag --points-at HEAD':{stdout:'v1.2\n'}})});
 assert.equal(otherTag.code,1);assert.match(otherTag.text,/chưa có trên nhánh v1\.1/u);
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
 assert.ok(names.includes('node backend/vendor.mjs --require-paddle'),'production fails instead of shipping without PaddleOCR');
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

// Locally PaddleOCR is optional; production must ship it, so damaged models in the repo stop the deploy.
test('Deploy ships PaddleOCR: damaged models in the repo stop it before vendor, which runs with --require-paddle',async()=>{
 const good=await deploy(project(),['--check','--skip-tests']);
 assert.equal(good.code,0,good.text);assert.ok(good.cloud.names().includes('node backend/vendor.mjs --require-paddle'),good.cloud.names().join('\n'));
 const cases=[
  [root=>writeFileSync(join(root,'backend/paddle-models/rec.tar'),Buffer.alloc(100)),/rec\.tar có 100 byte thay vì 1024: tệp bị cắt hoặc bị thay/u],
  [root=>writeFileSync(join(root,'backend/paddle-models/det.tar'),'version https://git-lfs.github.com/spec/v1\noid sha256:781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30\nsize 4843520\n'),/det\.tar chỉ là con trỏ Git LFS/u],
  [root=>rmSync(join(root,'backend/paddle-models'),{recursive:true}),/Thiếu backend\/paddle-models\/manifest\.json/u]
 ];
 for(const [damage,pattern] of cases){
  const root=project();damage(root);
  const run=await deploy(root,['--check','--skip-tests']);
  assert.equal(run.code,1,run.text);assert.match(run.text,pattern);
  assert.match(run.text,/LỖI: Mô hình PaddleOCR chưa dùng được: .* Lấy lại bằng: git checkout -- backend\/paddle-models rồi chạy lại\./u);
  assert.ok(!run.cloud.names().some(name=>/^(node backend\/vendor\.mjs|wrangler deploy )/u.test(name)),pattern.source);
 }
});

test('The lookup dictionary: deploy stops without it unless --allow-no-dictionary, and the live site is always checked for it',async()=>{
 const unbuilt=project({dictionary:false});
 assert.match(dictionaryProblem(unbuilt),/^Chưa có dữ liệu từ điển \(frontend\/vendor\/dict\/manifest\.json\)/u);assert.equal(dictionaryProblem(project()),null);
 const refused=await deploy(unbuilt,['--yes','--skip-tests']);
 assert.equal(refused.code,1);assert.match(refused.text,/LỖI: Chưa có dữ liệu từ điển \(frontend\/vendor\/dict\/manifest\.json\): trên production, nút “Tra chữ Hán” sẽ báo chưa có dữ liệu\. Chạy npm run prepare:dict rồi chạy lại \(--allow-no-dictionary để deploy không có từ điển\)\./u);
 assert.ok(!refused.cloud.names().some(name=>name.startsWith('wrangler')),'stopped before Cloudflare');
 // A manifest whose folder was not built (a copy cut short) is no dictionary either.
 const partial=project();rmSync(join(partial,'frontend/vendor/dict/v'),{recursive:true});
 assert.match((await deploy(partial,['--check','--skip-tests'])).text,/LỖI: Dữ liệu từ điển trong frontend\/vendor\/dict\/v\/0123456789ab chưa đủ/u);
 // Allowed: deployed with a warning, and the live check still runs, as a warning.
 const html=()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}});
 const allowed=await deploy(unbuilt,['--yes','--skip-tests','--allow-no-dictionary'],{site:fakeSite({routes:{'/vendor/dict/manifest.json':html}})});
 assert.equal(allowed.code,0,allowed.text);assert.match(allowed.text,/CẢNH BÁO: Chưa có dữ liệu từ điển .*Deploy tiếp vì có --allow-no-dictionary\./u);
 assert.match(allowed.text,/CẢNH BÁO: \/vendor\/dict\/manifest\.json trả 200 \(text\/html\): dữ liệu từ điển chưa lên Worker \(đã deploy với --allow-no-dictionary\)/u);
 // Built here but missing on the live site: a failed deploy check.
 const run=await deploy(project(),['--yes','--skip-tests'],{site:fakeSite({routes:{'/vendor/dict/manifest.json':html}})});
 assert.equal(run.code,1);assert.match(run.text,/LỖI: \/vendor\/dict\/manifest\.json trả 200 \(text\/html\): dữ liệu từ điển chưa lên Worker; chạy npm run prepare:dict rồi deploy lại\./u);
 const good=await deploy(project(),['--yes','--skip-tests']);
 assert.equal(good.code,0,good.text);assert.match(good.text,/OK {2}\/vendor\/dict\/manifest\.json: dữ liệu từ điển 0123456789ab/u);assert.match(good.text,/OK {2}http:\/\/muc-viet-cms\.owner\.workers\.dev\/ chuyển sang https:\/\/ \(301\)\./u);
});
