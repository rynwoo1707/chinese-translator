// Guarded production deploy: `npm run deploy`, and `npm run deploy:check` for the same checks without any change.
//  1. On this machine: Node, wrangler.jsonc, unfilled placeholders in public pages, clean git tree, the secrets file.
//  2. Cloudflare, read only: login, R2 bucket, secret names, the version that is live now.
//  3. frontend/vendor with PaddleOCR (models from backend/paddle-models), npm test (paid APIs blocked), wrangler deploy --dry-run.
//  4. Pending D1 migrations: listed with a Time Travel bookmark, applied only after typing "CÓ" (or --yes).
//  5. wrangler deploy --strict, tagged with the commit (/api/health reports the tag).
//  6. Checks against the live URL, the manual checklist and the rollback commands.
// It never calls Gemini and never prints a secret value. Wrangler runs as `node node_modules/wrangler/bin/wrangler.js`,
// which works on Windows without a shell.
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {checkPaddleModels,RESTORE_HINT} from './paddle-assets.mjs';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
const NPX=process.platform==='win32'?'npx.cmd':'npx';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Worker settings that must stay secrets: the repo is public, and the PDF service URL names the server.
export const SECRET_NAMES=['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN','GEMINI_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'];
const SECRET_LIKE=/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS?)$/iu;
const KEY_LIKE=/AIza[0-9A-Za-z_-]{35}|^[0-9a-f]{32,}$/iu;
const LOCAL_HOST=/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\]|[^.]+|.+\.(local|internal|lan))$/iu;
export const PLACEHOLDER='[[CHƯA ĐIỀN';
export const VENDOR_FILES=['frontend/vendor/pdf.mjs','frontend/vendor/pdf.worker.mjs','frontend/vendor/pdf-lib.esm.min.js','frontend/vendor/tesseract.esm.min.js','frontend/vendor/paddle/worker.js','frontend/vendor/paddle/models/det.tar','frontend/vendor/paddle/models/rec.tar'];
// The worker treats an unknown mode, or "domain" without domains, as closed (backend/reader-auth.js).
const REGISTRATION_MODES=['open','closed','domain'];
// wrangler secret list on a Worker that was never deployed (wrangler's own message, or the API error code).
const WORKER_MISSING=/Worker "[^"\r\n]+"[^\r\n]* not found\.|\[code: 10007\]/u;
const TOKEN_TOO_SHORT=`ADMIN_TOKEN của production ngắn hơn 32 ký tự nên trang quản trị đang khóa: đặt lại bằng ${NPX} wrangler secret put ADMIN_TOKEN (nên dùng 64 ký tự hex).`;
const USAGE=`Cách dùng:
  npm run deploy:check                         kiểm tra mọi thứ, không thay đổi gì trên Cloudflare
  npm run deploy                               kiểm tra, áp migration D1 (hỏi trước), deploy, kiểm tra bản mới
  npm run deploy -- --secrets-file <tệp>       kèm secret từ tệp TÊN=giá trị nằm ngoài repo (bắt buộc ở lần đầu)
Tùy chọn: --yes (không hỏi trước khi áp migration), --skip-tests, --allow-dirty, --allow-placeholders,
  --allow-stale (D1 có migration lạ), --url <https://…> (địa chỉ để kiểm tra sau deploy, ví dụ tên miền riêng).
Kiểm tra /api/status sau deploy: đặt biến môi trường HOATRI_ADMIN_TOKEN (giá trị ADMIN_TOKEN của production).`;

// JSONC as wrangler reads it: // and /* */ comments and trailing commas, never inside strings.
export function parseJsonc(text){
 const source=String(text).replace(/^﻿/u,'');let plain='',json='';
 const string=(from,at)=>{let i=at+1;for(;i<from.length&&from[i]!=='"';i++)if(from[i]==='\\')i++;return i;};
 for(let i=0;i<source.length;i++){
  const char=source[i];
  if(char==='"'){const end=string(source,i);plain+=source.slice(i,end+1);i=end;continue;}
  if(char==='/'&&source[i+1]==='/'){while(i+1<source.length&&source[i+1]!=='\n')i++;continue;}
  if(char==='/'&&source[i+1]==='*'){const end=source.indexOf('*/',i+2);if(end<0)throw new SyntaxError('Chú thích /* chưa đóng.');plain+=' ';i=end+1;continue;}
  plain+=char;
 }
 for(let i=0;i<plain.length;i++){
  const char=plain[i];
  if(char==='"'){const end=string(plain,i);json+=plain.slice(i,end+1);i=end;continue;}
  if(char===','){let next=i+1;while(/\s/u.test(plain[next]||''))next++;if(plain[next]==='}'||plain[next]===']')continue;}
  json+=char;
 }
 return JSON.parse(json);
}

export function configProblems(cfg){
 const errors=[],warnings=[],db=(cfg?.d1_databases||[]).find(d=>d?.binding==='DB');
 if(!db)errors.push('wrangler.jsonc thiếu D1 binding "DB".');
 else{
  if(!UUID.test(String(db.database_id||'')))errors.push(`database_id vẫn là "${db.database_id}": chạy ${NPX} wrangler d1 create ${db.database_name||'muc-viet'} --binding DB --location apac --update-config`);
  if(db.preview_database_id!=='local-db')warnings.push('preview_database_id không phải "local-db": wrangler dev sẽ mở một D1 local khác, rỗng. Đặt lại "preview_database_id": "local-db" trong wrangler.jsonc.');
 }
 if(!(cfg?.r2_buckets||[]).some(b=>b?.binding==='FILES'))errors.push('wrangler.jsonc thiếu R2 binding "FILES".');
 if(cfg?.secrets)errors.push('wrangler.jsonc có khối "secrets": khi đó wrangler dev chỉ nạp các tên được liệt kê từ .dev.vars. Hãy bỏ khối này.');
 for(const [name,value] of Object.entries(cfg?.vars||{})){
  if(SECRET_NAMES.includes(name)||SECRET_LIKE.test(name))errors.push(`${name} là bí mật, không đặt trong "vars" của wrangler.jsonc (repo công khai): dùng ${NPX} wrangler secret put ${name}`);
  else if(typeof value==='string'&&KEY_LIKE.test(value.trim()))errors.push(`Giá trị của var ${name} trông như một khóa bí mật: chuyển nó sang wrangler secret.`);
 }
 if(cfg?.observability?.enabled&&cfg.observability.redact_query_string!==true)warnings.push('observability.redact_query_string chưa bật: nhật ký Workers sẽ ghi cả ?code= của đăng nhập Google.');
 const mode=String(cfg?.vars?.REGISTRATION_MODE??'open').trim().toLowerCase(),domains=String(cfg?.vars?.ALLOWED_EMAIL_DOMAINS||'').trim();
 if(!REGISTRATION_MODES.includes(mode))warnings.push(`REGISTRATION_MODE "${cfg.vars.REGISTRATION_MODE}" không hợp lệ (open, closed hoặc domain): máy chủ sẽ coi là closed, không ai tạo được tài khoản mới.`);
 else if(mode==='domain'&&!domains)warnings.push('REGISTRATION_MODE là "domain" nhưng ALLOWED_EMAIL_DOMAINS trống: không ai tạo được tài khoản mới.');
 return {errors,warnings};
}

export function secretProblems(names){
 const have=new Set(names),errors=[],warnings=[];
 const missing=(name,why='')=>`Thiếu secret: ${name}${why}. Chạy ${NPX} wrangler secret put ${name} hoặc dùng --secrets-file <tệp ngoài repo>`;
 if(!have.has('ADMIN_TOKEN'))errors.push(missing('ADMIN_TOKEN'));
 for(const pair of [['PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN'],['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET']]){
  const present=pair.filter(name=>have.has(name));
  if(present.length===1)errors.push(missing(pair.find(name=>!have.has(name)),` (đã có ${present[0]}; cần đủ cả hai)`));
 }
 if(!have.has('PDF_LAYOUT_SERVICE_URL')&&!have.has('PDF_LAYOUT_SERVICE_TOKEN'))warnings.push('Chưa có PDF_LAYOUT_SERVICE_URL và PDF_LAYOUT_SERVICE_TOKEN: chế độ "Giữ bố cục PDF" sẽ báo chưa cấu hình (xem deploy/pdf-layout/README.md).');
 return {errors,warnings};
}

export const collisions=(varNames,secretNames)=>{const vars=new Set(varNames);return [...new Set(secretNames)].filter(name=>vars.has(name)).sort();};
export const collisionMessage=name=>`${name} vừa là var vừa là secret: chạy ${NPX} wrangler secret delete ${name}`;

export function pendingMigrations(files,applied){
 const done=new Set(applied),known=new Set(files);
 return {pending:files.filter(name=>!done.has(name)),unknown:applied.filter(name=>!known.has(name))};
}

// The two formats `wrangler deploy --secrets-file` accepts: a JSON object, or dotenv lines. dotenv ends an unquoted
// value at the first #, so a # glued to a value would silently cut it. Errors name the key or line, never a value.
export function parseSecretsText(text){
 const source=String(text).replace(/^﻿/u,''),entries=[],errors=[];
 if(/^\s*[[{]/u.test(source)){
  let data=null;try{data=JSON.parse(source);}catch{}
  if(!data||typeof data!=='object'||Array.isArray(data))return {entries,errors:['Tệp secret dạng JSON phải là một object {"TÊN": "giá trị"}.']};
  for(const [name,value] of Object.entries(data))typeof value==='string'?entries.push([name,value]):errors.push(`${name}: giá trị phải là chuỗi.`);
  return {entries,errors};
 }
 source.split(/\r?\n/u).forEach((line,index)=>{
  if(!line.trim()||/^\s*#/u.test(line))return;
  const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
  if(!match)return errors.push(`Dòng ${index+1} của tệp secret không có dạng TÊN=giá trị.`);
  const raw=match[2].trim(),quoted=/^(['"`])(.*)\1$/u.exec(raw);
  if(!quoted&&/\S#/u.test(raw))errors.push(`${match[1]}: giá trị có dấu # mà không nằm trong ngoặc kép, wrangler sẽ cắt mất phần sau dấu #.`);
  entries.push([match[1],quoted?quoted[2]:raw.split('#')[0].trim()]);
 });
 return {entries,errors};
}

export function validateSecretsFile(file,{root=ROOT,varNames=[]}={}){
 const full=resolve(String(file||'')),inside=relative(resolve(root),full);
 if(/^\.dev\.vars/iu.test(basename(full)))return {names:[],errors:['Không dùng .dev.vars làm tệp secret: tệp này chứa địa chỉ 127.0.0.1 và khóa cá nhân.']};
 // relative() gives "..<sep>…" outside the root and an absolute path on another drive; "..secrets.env" is inside.
 if(inside!=='..'&&!inside.startsWith(`..${sep}`)&&!isAbsolute(inside))return {names:[],errors:[`Tệp secret phải nằm ngoài thư mục dự án (${full}): repo công khai, tệp nằm trong đó dễ bị commit nhầm.`]};
 let text;try{text=readFileSync(full,'utf8');}catch(error){return {names:[],errors:[`Không đọc được tệp secret ${full} (${error.code||error.message}).`]};}
 const {entries,errors}=parseSecretsText(text),values=new Map();
 for(const [name,value] of entries){if(values.has(name))errors.push(`${name} xuất hiện hai lần trong tệp secret.`);values.set(name,value);}
 for(const [name,value] of values){
  if(!value)errors.push(`${name} để trống trong tệp secret.`);
  if(varNames.includes(name))errors.push(`${name} đã là var trong wrangler.jsonc: xóa dòng này khỏi tệp secret.`);
 }
 const admin=values.get('ADMIN_TOKEN'),pdfToken=values.get('PDF_LAYOUT_SERVICE_TOKEN'),pdfUrl=values.get('PDF_LAYOUT_SERVICE_URL');
 if(admin&&(admin.length<32||/replace-with/iu.test(admin)))errors.push('ADMIN_TOKEN cần một chuỗi ngẫu nhiên mới, tối thiểu 32 ký tự (nên dùng 64 hex), khác bản local.');
 if(pdfToken&&pdfToken.length<24)errors.push('PDF_LAYOUT_SERVICE_TOKEN cần tối thiểu 24 ký tự và giống hệt token của dịch vụ PDF.');
 if(pdfUrl){
  let url=null;try{url=new URL(pdfUrl);}catch{}
  if(!url||url.protocol!=='https:'||LOCAL_HOST.test(url.hostname)||url.pathname!=='/'||url.search||url.hash)errors.push('PDF_LAYOUT_SERVICE_URL phải là gốc https:// công khai của dịch vụ PDF, ví dụ https://pdf.example.com (không thêm đường dẫn); Worker không gọi được 127.0.0.1, localhost hay IP mạng LAN.');
 }
 return {names:[...values.keys()],errors};
}

export function placeholderFiles(root=ROOT){
 const dir=join(root,'frontend');let names=[];try{names=readdirSync(dir).filter(name=>/\.(html|js)$/u.test(name));}catch{}
 return names.filter(name=>readFileSync(join(dir,name),'utf8').includes(PLACEHOLDER)).map(name=>`frontend/${name}`).sort();
}

// The first JSON object or array in a command's output (wrangler may print warnings around it).
export function parseJsonOutput(text){
 const source=String(text||'');
 for(let start=source.search(/[[{]/u);start>=0;){
  let depth=0,end=-1;
  for(let i=start;i<source.length&&end<0;i++){
   const char=source[i];
   if(char==='"'){for(i++;i<source.length&&source[i]!=='"';i++)if(source[i]==='\\')i++;}
   else if(char==='{'||char==='[')depth++;
   else if((char==='}'||char===']')&&--depth===0)end=i;
  }
  if(end>=0)try{return JSON.parse(source.slice(start,end+1));}catch{}
  const next=source.slice(start+1).search(/[[{]/u);start=next<0?-1:start+1+next;
 }
 return null;
}

export const output=result=>`${result?.stdout||''}\n${result?.stderr||''}`;
export const lastLines=(text,count=1)=>String(text||'').split(/\r?\n/u).map(line=>line.trim()).filter(Boolean).slice(-count).join(' | ').slice(0,600);

// Names recorded by `wrangler d1 migrations apply`; a database that never had a migration has no table yet.
export function appliedMigrationNames(result){
 if(/no such table/iu.test(output(result)))return [];
 const data=parseJsonOutput(result?.stdout);
 if(result?.code!==0||!Array.isArray(data))throw new Error(`Không đọc được danh sách migration của D1 production: ${lastLines(output(result),3)||'wrangler không trả kết quả'}`);
 return data.flatMap(entry=>entry?.results||[]).map(row=>row?.name).filter(name=>typeof name==='string');
}

export function parseDeployOutput(text){
 let url=null;
 for(const line of String(text||'').split(/\r?\n/u)){
  const workers=/^\s+(https:\/\/[a-z0-9.-]+\.workers\.dev)\/?\s*$/iu.exec(line),custom=/^\s+([a-z0-9.-]+\.[a-z]{2,})\s+\(custom domain(?: - [^)]*)?\)\s*$/iu.exec(line);
  url??=workers?workers[1]:custom?`https://${custom[1]}`:null;
 }
 return {url,versionId:/Current Version ID:\s*([0-9a-f-]{36})/iu.exec(String(text||''))?.[1]||null};
}

export const confirmed=answer=>String(answer||'').normalize('NFD').replace(/\p{M}/gu,'').trim().toUpperCase()==='CO';

export async function postDeployChecks(base,{fetch=globalThis.fetch,sha=null,adminToken='',dictionary=false,sleep=ms=>new Promise(done=>setTimeout(done,ms)),attempts=6,timeoutMs=15000}={}){
 const results=[],ok=text=>results.push({level:'ok',text}),warn=text=>results.push({level:'warn',text}),bad=text=>results.push({level:'error',text});
 const get=async(path,{method='GET',headers={}}={})=>{
  try{
   const response=await fetch(new URL(path,base),{method,headers,signal:AbortSignal.timeout(timeoutMs)}),text=method==='HEAD'?'':await response.text();
   let json;try{json=JSON.parse(text);}catch{}
   return {status:response.status,type:response.headers.get('content-type')||'',headers:response.headers,json,text};
  }catch(error){return {status:0,type:'',headers:new Headers(),json:undefined,text:'',error:error?.cause?.code||error?.name||String(error)};}
 };
 // A new version takes a few seconds to reach every location.
 let health;
 for(let attempt=1;;attempt++){
  health=await get('/api/health');
  if((health.status===200&&health.json?.ok&&(!sha||health.json.version===sha))||[404,503].includes(health.status)||attempt>=attempts)break;
  await sleep(5000);
 }
 if(health.status===200&&health.json?.ok){
  if(sha&&health.json.version!==sha)warn(`/api/health báo phiên bản "${health.json.version}", chưa phải ${sha}: chờ vài phút rồi mở lại ${new URL('/api/health',base)}.`);
  else ok(`/api/health: D1 trả lời, phiên bản ${health.json.version}.`);
  if(health.json.pdfLayout&&health.json.pdfLayout!=='configured')warn('/api/health: Worker chưa có cấu hình dịch vụ PDF giữ bố cục.');
 }else if(health.status===503)bad('/api/health trả 503: Worker không truy vấn được D1 (kiểm tra database_id và migration).');
 else if(health.status===404)warn('Bản này chưa có /api/health: bỏ qua kiểm tra phiên bản.');
 else bad(`/api/health không trả lời đúng (${health.status||health.error}).`);
 const home=await get('/');
 if(home.status!==200||!/text\/html/iu.test(home.type))bad(`Trang chủ trả ${home.status||home.error} (${home.type||'không có Content-Type'}).`);
 else if(home.headers.get('content-security-policy')||home.headers.get('content-security-policy-report-only'))ok('Trang chủ có Content-Security-Policy.');
 else warn('Trang chủ chưa có header Content-Security-Policy (frontend/_headers).');
 // Link previews and the sitemap take the address the request came to: a workers.dev name shows on every shared card.
 const host=new URL(base).hostname,origin=new URL(base).origin;
 if(/\.workers\.dev$/iu.test(host))warn(`Trang đang chạy ở ${host}: link chia sẻ sẽ hiện tên này trên thẻ xem trước và trong sitemap. Gắn tên miền riêng trước khi chia sẻ link đầu tiên (ONBOARDING mục 5.3), rồi kiểm tra lại bằng --url https://<tên miền>.`);
 const sitemap=await get('/sitemap.xml');
 if(sitemap.status===200&&sitemap.text?.includes(`<loc>${origin}/</loc>`))ok(`/sitemap.xml liệt kê các trang trên ${origin}.`);
 else warn(`/sitemap.xml trả ${sitemap.status||sitemap.error} hoặc không dùng địa chỉ ${origin}: kiểm tra "run_worker_first" trong wrangler.jsonc.`);
 const missing=await get('/khong-co-trang-nay-hoa-tri',{method:'HEAD'});
 if(missing.status===404)ok('Đường dẫn không tồn tại trả 404 (frontend/404.html).');
 else warn(`Đường dẫn không tồn tại trả ${missing.status||missing.error} thay vì 404: kiểm tra "not_found_handling": "404-page" trong wrangler.jsonc.`);
 // A missing file comes back as frontend/404.html (text/html, status 404); an older deploy answered index.html with
 // status 200. Either way it is never text/html here. Module scripts also need a JavaScript type, or the browser refuses them.
 for(const [path,type] of [['/vendor/pdf.mjs',/javascript/iu],['/vendor/pdf-lib.esm.min.js',/javascript/iu],['/vendor/paddle/models/det.tar',null]]){
  const asset=await get(path,{method:'HEAD'});
  if(asset.status===200&&(type?type.test(asset.type):!/text\/html/iu.test(asset.type)))ok(`${path}: ${asset.type||'?'}.`);
  else bad(`${path} trả ${asset.status||asset.error} (${asset.type||'?'}): thiếu thư viện giao diện; chạy npm run prepare:vendor rồi deploy lại.`);
 }
 if(dictionary){
  const manifest=await get('/vendor/dict/manifest.json');
  if(manifest.status===200&&manifest.json?.format===1)ok(`/vendor/dict/manifest.json: dữ liệu từ điển ${manifest.json.id||'?'}.`);
  else bad(`/vendor/dict/manifest.json trả ${manifest.status||manifest.error} (${manifest.type||'?'}): dữ liệu từ điển chưa lên Worker; chạy npm run prepare:dict rồi deploy lại.`);
 }
 const library=await get('/api/library');
 if(library.status===200&&Array.isArray(library.json))ok(`/api/library: ${library.json.length} mục công khai.`);
 else bad(`/api/library trả ${library.status||library.error}: kiểm tra D1 và migration.`);
 const me=await get('/api/me'),registration=me.json?.registration;
 const mode={open:'ai cũng tạo được tài khoản',closed:'đang đóng',domain:`chỉ email thuộc ${(registration?.domains||[]).join(', ')}`}[registration?.mode];
 if(me.status===200&&typeof me.json?.authenticated==='boolean')ok(`/api/me trả lời${mode?`; đăng ký: ${mode}`:''}.`);
 else bad(`/api/me trả ${me.status||me.error}.`);
 // Without a token /api/status still says whether ADMIN_TOKEN is too short to unlock /admin outside localhost.
 const open=await get('/api/status'),tooShort=Boolean(open.json?.adminTokenTooShort);
 if(open.status!==200||typeof open.json?.authenticated!=='boolean')bad(`/api/status trả ${open.status||open.error}.`);
 else if(tooShort)bad(TOKEN_TOO_SHORT);
 if(adminToken&&!tooShort){
  const status=await get('/api/status',{headers:{Authorization:`Bearer ${adminToken}`}});
  if(status.status===200&&status.json?.authenticated===true)ok(`/api/status: mã quản trị đúng, model ${status.json.model||'?'}.`);
  else if(status.json?.adminTokenTooShort)bad(TOKEN_TOO_SHORT);
  else bad('/api/status không nhận HOATRI_ADMIN_TOKEN: secret ADMIN_TOKEN trên Worker khác giá trị này.');
 }
 return results;
}

export function runCommand(command,args,{cwd=ROOT,env=process.env,tee=false}={}){
 return new Promise(done=>{
  let stdout='',stderr='',child;
  try{child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){return done({code:-1,stdout,stderr:String(error?.message||error)});}
  child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(tee)process.stdout.write(chunk);});
  child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;if(tee)process.stderr.write(chunk);});
  child.on('error',error=>done({code:-1,stdout,stderr:`${stderr}${error.message}`}));
  child.on('close',code=>done({code:code??-1,stdout,stderr}));
 });
}

export function askLine(question){
 const prompt=createInterface({input:process.stdin,output:process.stdout});
 return new Promise(done=>prompt.question(question,answer=>{prompt.close();done(answer);}));
}

async function gitState(run,root){
 const git=args=>run('git',args,{cwd:root});
 const [status,sha,branch]=await Promise.all([git(['status','--porcelain']),git(['rev-parse','--short=12','HEAD']),git(['rev-parse','--abbrev-ref','HEAD'])]);
 if(sha.code!==0)return {sha:null,branch:null,dirty:0};
 return {sha:sha.stdout.trim(),branch:branch.code===0?branch.stdout.trim():null,dirty:status.code===0?status.stdout.split(/\r?\n/u).filter(Boolean).length:0};
}

function parseOptions(argv){
 const {values}=parseArgs({args:argv,strict:true,allowPositionals:false,options:{check:{type:'boolean'},yes:{type:'boolean'},'skip-tests':{type:'boolean'},'allow-dirty':{type:'boolean'},'allow-placeholders':{type:'boolean'},'allow-stale':{type:'boolean'},'secrets-file':{type:'string'},url:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.url&&!/^https:\/\/[^/]+\/?$/u.test(values.url))throw new Error('--url phải là gốc https://… của Worker.');
 return {check:!!values.check,yes:!!values.yes,skipTests:!!values['skip-tests'],allowDirty:!!values['allow-dirty'],allowPlaceholders:!!values['allow-placeholders'],allowStale:!!values['allow-stale'],secretsFile:values['secrets-file']||null,url:values.url?.replace(/\/$/u,'')||null,help:!!values.help};
}

function afterDeployText(base,{previous,bookmark}){
 return [
  '\nKiểm tra bằng tay (không tốn token Gemini):',
  `  - ${base||'<URL Worker>'}/#account: tạo một tài khoản thử, đăng xuất rồi đăng nhập lại.`,
  `  - ${base||'<URL Worker>'}/study: dòng dịch vụ PDF ghi "Dịch từng đoạn ngay tại chỗ; giữ hình gốc, công thức và vị trí chữ."`,
  `  - ${base||'<URL Worker>'}/admin: đăng nhập bằng ADMIN_TOKEN, mở "Cài đặt".`,
  `  - Xem lỗi trực tiếp: ${NPX} wrangler tail`,
  'Nếu cần quay lại:',
  previous?`  - Code: ${NPX} wrangler rollback ${previous} --message "rollback"   (không hoàn tác migration và secret)`:'  - Code: chưa có bản trước (lần deploy đầu); deploy lại một commit cũ nếu cần.',
  ...(bookmark?[`  - D1: ${NPX} wrangler d1 time-travel restore DB --bookmark=${bookmark}   (xóa mọi thay đổi dữ liệu sau thời điểm đó)`]:[])
 ].join('\n');
}

export async function main({argv=process.argv.slice(2),env=process.env,root=ROOT,run=runCommand,fetch=globalThis.fetch,ask=askLine,interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY),sleep,log=console.log,logError=console.error}={}){
 let opts;
 try{opts=parseOptions(argv);}catch(error){logError(`LỖI: ${error.message}`);log(USAGE);return 2;}
 if(opts.help){log(USAGE);return 0;}
 const caution=text=>logError(`CẢNH BÁO: ${text}`);
 const stop=(texts,after=opts.check?'Kiểm tra chưa đạt.':'Đã dừng: chưa thay đổi gì trên Cloudflare.')=>{for(const text of [texts].flat().filter(Boolean))logError(`LỖI: ${text}`);logError(`\n${after}`);return 1;};
 const node=process.execPath,wranglerJs=join(root,'node_modules/wrangler/bin/wrangler.js');
 const wrangler=(args,options={})=>run(node,[wranglerJs,...args],{cwd:root,env,...options});
 const total=opts.check?4:6;let number=0;const step=text=>log(`\n[${++number}/${total}] ${text}`);

 step('Kiểm tra trên máy');
 const errors=[],[major,minor]=process.versions.node.split('.').map(Number);
 if(major<22||(major===22&&minor<13))errors.push(`Cần Node.js 22.13 trở lên (đang dùng ${process.version}).`);
 if(!existsSync(wranglerJs))errors.push('Chưa cài thư viện: chạy npm ci trước.');
 let cfg;try{cfg=parseJsonc(readFileSync(join(root,'wrangler.jsonc'),'utf8'));}catch(error){return stop(`Không đọc được wrangler.jsonc: ${error.message}`);}
 const config=configProblems(cfg),varNames=Object.keys(cfg.vars||{});
 errors.push(...config.errors);config.warnings.forEach(caution);
 const placeholders=placeholderFiles(root);
 if(placeholders.length&&!opts.allowPlaceholders)errors.push(`Trang công khai còn chỗ "${PLACEHOLDER}…" chưa điền: ${placeholders.join(', ')}. Điền thông tin thật trước khi công bố (--allow-placeholders nếu chỉ thử).`);
 const git=await gitState(run,root);
 if(!git.sha&&!opts.allowDirty)errors.push('Không đọc được commit hiện tại (cần git và một bản clone): --allow-dirty để bỏ qua.');
 if(git.dirty&&!opts.allowDirty)errors.push(`Có ${git.dirty} tệp thay đổi chưa commit: commit hoặc stash trước, để bản deploy đúng với commit được gắn tag (--allow-dirty để bỏ qua).`);
 let fileSecrets=[];
 if(opts.secretsFile){const checked=validateSecretsFile(opts.secretsFile,{root,varNames});errors.push(...checked.errors);fileSecrets=checked.names;}
 if(errors.length)return stop(errors);
 const tag=`${git.sha||'local'}${git.dirty?'-dirty':''}`,branch=git.branch||'local';
 log(`Worker "${cfg.name}", commit ${tag} (${branch}).`);

 step('Cloudflare (chỉ đọc): đăng nhập, R2, secret, phiên bản đang chạy');
 const who=await wrangler(['whoami','--json']),me=parseJsonOutput(who.stdout);
 if(who.code!==0||!me?.loggedIn)return stop(`Chưa đăng nhập Cloudflare: chạy ${NPX} wrangler login (hoặc đặt CLOUDFLARE_API_TOKEN).`);
 const accounts=Array.isArray(me.accounts)?me.accounts:[],accountId=cfg.account_id||env.CLOUDFLARE_ACCOUNT_ID;
 if(accountId&&accounts.length&&!accounts.some(account=>account.id===accountId))return stop(`Account ${accountId} (account_id hoặc CLOUDFLARE_ACCOUNT_ID) không thuộc lần đăng nhập này.`);
 if(!accountId&&accounts.length>1)return stop(`Lần đăng nhập này có ${accounts.length} account Cloudflare (${accounts.map(account=>`${account.name}: ${account.id}`).join('; ')}): đặt CLOUDFLARE_ACCOUNT_ID=<id> rồi chạy lại.`);
 const account=accounts.find(item=>item.id===accountId)||accounts[0];
 log(`Đăng nhập: ${me.email||me.authType||'API token'}${account?.name?`, account "${account.name}"`:''}.`);
 const bucketName=cfg.r2_buckets.find(bucket=>bucket.binding==='FILES').bucket_name,bucket=await wrangler(['r2','bucket','info',bucketName,'--json']);
 if(bucket.code!==0)return stop(/enable R2/iu.test(output(bucket))?'Account chưa bật R2: bật R2 trong dashboard Cloudflare rồi chạy lại.':`Không đọc được bucket R2 "${bucketName}" (${lastLines(output(bucket))}). Nếu chưa tạo: ${NPX} wrangler r2 bucket create ${bucketName} --location apac`);
 const listed=await wrangler(['secret','list','--format','json']);let remoteSecrets=[],firstDeploy=false;
 if(listed.code===0){const data=parseJsonOutput(listed.stdout);if(!Array.isArray(data))return stop('Không đọc được danh sách secret của Worker.');remoteSecrets=data.map(item=>item?.name).filter(Boolean);}
 else if(WORKER_MISSING.test(output(listed)))firstDeploy=true;
 else return stop(`Không đọc được secret của Worker: ${lastLines(output(listed))}`);
 if(firstDeploy){
  caution(`Worker "${cfg.name}" chưa có trên Cloudflare: đây là lần deploy đầu, URL sẽ là https://${cfg.name}.<subdomain>.workers.dev. Muốn tên khác (ví dụ "hoa-tri") thì đổi "name" trong wrangler.jsonc ngay bây giờ: đổi sau là đổi URL và phải đặt lại secret.`);
  if(!opts.secretsFile)return stop('Lần deploy đầu cần --secrets-file <tệp TÊN=giá trị nằm ngoài repo> có ít nhất ADMIN_TOKEN, để Worker không lúc nào chạy mà thiếu mã quản trị.');
 }
 const secrets=[...new Set([...remoteSecrets,...fileSecrets])].sort(),clash=collisions(varNames,remoteSecrets),needed=secretProblems(secrets);
 needed.warnings.forEach(caution);
 if(clash.length||needed.errors.length)return stop([...clash.map(collisionMessage),...needed.errors]);
 log(`Secret: ${secrets.join(', ')}${fileSecrets.length?` (${fileSecrets.length} tên từ --secrets-file)`:''}.`);
 let previous=null;
 if(!firstDeploy){
  const live=parseJsonOutput((await wrangler(['deployments','status','--json'])).stdout);
  previous=[...(Array.isArray(live?.versions)?live.versions:[])].sort((a,b)=>(b?.percentage||0)-(a?.percentage||0))[0]?.version_id||null;
  if(previous)log(`Phiên bản đang chạy: ${previous}.`);
 }

 step(opts.skipTests?'Thư viện giao diện và bản build thử (bỏ qua npm test)':'Thư viện giao diện, npm test, bản build thử');
 // Production ships PaddleOCR: the models in the repo must be intact, and vendor.mjs fails instead of only warning.
 const paddle=checkPaddleModels(root);
 if(!paddle.ok)return stop(`Mô hình PaddleOCR chưa dùng được: ${paddle.problem} ${RESTORE_HINT} rồi chạy lại.`);
 const vendor=await run(node,['backend/vendor.mjs','--require-paddle'],{cwd:root,env});
 if(vendor.code!==0)return stop(`Không chép được thư viện vào frontend/vendor: ${lastLines(output(vendor),2)}`);
 const missingVendor=VENDOR_FILES.filter(file=>!existsSync(join(root,file)));
 if(missingVendor.length)return stop(`Thiếu tệp sau khi chạy backend/vendor.mjs: ${missingVendor.join(', ')}`);
 log('frontend/vendor đã đủ.');
 // The lookup dictionary is optional and git-ignored: without it only the "Tra chữ Hán" button says there is no data.
 const dictionary=existsSync(join(root,'frontend/vendor/dict/manifest.json'));
 if(!dictionary&&existsSync(join(root,'backend/prepare-dictionary.mjs')))caution('Chưa có dữ liệu từ điển (frontend/vendor/dict): trên production, nút "Tra chữ Hán" sẽ báo chưa có dữ liệu. Chạy npm run prepare:dict trước khi deploy.');
 if(!opts.skipTests){
  const npmCli=env.npm_execpath&&/\.c?js$/u.test(env.npm_execpath)?env.npm_execpath:null;
  const guard=`--import=${pathToFileURL(join(root,'backend/test-support/no-paid-api.mjs')).href}`;
  const tests=await run(node,npmCli?[npmCli,'test']:['--test','backend/*.test.mjs'],{cwd:root,env:{...env,NODE_OPTIONS:[env.NODE_OPTIONS,guard].filter(Boolean).join(' ')},tee:true});
  if(tests.code!==0)return stop('npm test có test lỗi (xem ở trên): sửa trước khi deploy.');
 }
 const outdir=mkdtempSync(join(tmpdir(),'hoa-tri-deploy-'));let dry;
 try{dry=await wrangler(['deploy','--dry-run','--outdir',outdir]);}finally{rmSync(outdir,{recursive:true,force:true});}
 if(dry.code!==0)return stop(`wrangler deploy --dry-run lỗi: ${lastLines(output(dry),6)}`);
 const size=/Total Upload:\s*([^\r\n]+)/u.exec(output(dry))?.[1]?.trim();
 log(`Bản build thử đạt${size?` (${size})`:''}.`);

 step('Migration D1 production');
 const db=cfg.d1_databases.find(item=>item.binding==='DB'),files=readdirSync(join(root,db.migrations_dir||'migrations')).filter(name=>name.endsWith('.sql')).sort();
 let applied;
 try{applied=appliedMigrationNames(await wrangler(['d1','execute','DB','--remote','--json','--yes','--command',`SELECT name FROM ${db.migrations_table||'d1_migrations'} ORDER BY id`]));}catch(error){return stop(error.message);}
 const {pending,unknown}=pendingMigrations(files,applied);let bookmark=null;
 if(unknown.length&&!opts.allowStale)return stop(`D1 production đã có migration không có trong bản code này: ${unknown.join(', ')}. Có thể đây là code cũ: git pull rồi chạy lại (--allow-stale để bỏ qua).`);
 if(!pending.length)log(`D1 production đã có đủ ${files.length} migration.`);
 else{
  log(`Migration chờ áp dụng (${pending.length}): ${pending.join(', ')}`);
  if(opts.check)log('Chế độ kiểm tra: chưa áp dụng.');
  else{
   bookmark=parseJsonOutput((await wrangler(['d1','time-travel','info','DB','--json'])).stdout)?.bookmark||null;
   if(bookmark)log(`Điểm khôi phục D1 trước migration: ${NPX} wrangler d1 time-travel restore DB --bookmark=${bookmark}`);
   else caution(`Không lấy được bookmark Time Travel; vẫn khôi phục được theo thời điểm: ${NPX} wrangler d1 time-travel restore DB --timestamp=<thời điểm RFC3339>.`);
   if(!opts.yes){
    if(!interactive)return stop('Không có terminal để xác nhận migration: chạy lại trong terminal, hoặc thêm --yes nếu chắc chắn.');
    if(!confirmed(await ask(`Áp dụng ${pending.length} migration lên D1 production? Gõ CÓ để tiếp tục: `))){logError('Đã hủy: chưa áp dụng migration, chưa deploy.');return 1;}
   }
   const migrated=await wrangler(['d1','migrations','apply','DB','--remote'],{tee:true});
   if(migrated.code!==0)return stop(['Migration lỗi (xem ở trên): chưa deploy code mới.',bookmark&&`Nếu dữ liệu đã đổi một phần: ${NPX} wrangler d1 time-travel restore DB --bookmark=${bookmark}`],'Đã dừng sau bước migration.');
  }
 }
 if(opts.check){log(`\nKiểm tra đạt: npm run deploy${firstDeploy?' -- --secrets-file <tệp>':''} sẽ ${pending.length?`áp dụng ${pending.length} migration rồi `:''}deploy commit ${tag}.`);return 0;}

 step('Deploy Worker');
 const deployArgs=['deploy','--strict','--tag',tag,'--message',`${branch}@${tag}`.slice(0,100),...(opts.secretsFile?['--secrets-file',resolve(opts.secretsFile)]:[])];
 const deployed=await wrangler(deployArgs,{tee:true});
 if(deployed.code!==0)return stop([`wrangler deploy lỗi (xem ở trên).${firstDeploy?' Lần đầu: nếu wrangler đòi đăng ký subdomain workers.dev, đăng ký trong dashboard Cloudflare (Workers & Pages) rồi chạy lại.':''}`],pending.length?'Migration đã áp dụng; bản code cũ vẫn đang chạy.':'Đã dừng: bản code cũ vẫn đang chạy.');
 const {url,versionId}=parseDeployOutput(output(deployed)),base=opts.url||url;
 if(versionId)log(`Phiên bản mới: ${versionId}.`);

 step('Kiểm tra bản vừa deploy');
 let failed=0;
 if(!base)caution('Không đọc được URL của Worker từ wrangler: lần sau thêm --url <https://…> để kiểm tra tự động.');
 else for(const result of await postDeployChecks(base,{fetch,sha:tag,adminToken:env.HOATRI_ADMIN_TOKEN||'',dictionary,...(sleep?{sleep}:{})})){
  if(result.level==='error'){failed++;logError(`LỖI: ${result.text}`);}
  else if(result.level==='warn')caution(result.text);
  else log(`OK  ${result.text}`);
 }
 log(afterDeployText(base,{previous,bookmark}));
 if(failed)logError(`\n${failed} kiểm tra sau deploy chưa đạt: xem LỖI ở trên, quay lại bản trước nếu cần.`);
 return failed?1:0;
}

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(process.argv[1]&&samePath(fileURLToPath(import.meta.url),resolve(process.argv[1])))process.exitCode=await main();
