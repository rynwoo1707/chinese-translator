// Guarded production deploy: `npm run deploy`, and `npm run deploy:check` for the same checks without any change.
//  1. On this machine: Node, wrangler.jsonc, unfilled placeholders in public pages and security.txt, clean git tree
//     whose commit is published where the "Mã nguồn" link points, the lookup dictionary, the secrets file.
//  2. Cloudflare, read only: login, R2 bucket, secret names, the version that is live now.
//  3. frontend/vendor with PaddleOCR (models from backend/paddle-models), npm test (paid APIs blocked), wrangler deploy --dry-run.
//  4. Pending D1 migrations: listed with a Time Travel bookmark, applied only after typing "CÓ" (or --yes).
//  5. wrangler deploy --strict, tagged with the commit (/api/health reports the tag).
//  6. Checks against the live URL, the manual checklist and the rollback commands.
// It never calls Gemini and never prints a secret value. Wrangler runs as `node node_modules/wrangler/bin/wrangler.js`,
// which works on Windows without a shell.
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {checkPaddleModels,RESTORE_HINT} from './paddle-assets.mjs';
import {buildVersion,layoutVersion} from '../services/pdf-layout/version.mjs';
import {MODES,isMode,ADMIN_DEFAULT_MODE} from '../frontend/translation-modes.js';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
const NPX=process.platform==='win32'?'npx.cmd':'npx';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Worker settings that must stay secrets: the repo is public, and the PDF service URL names the server. ADMIN_TOKEN is
// typed on /admin only once, to create the first admin account (and again to reset a forgotten admin password); it is
// also the key of the Gemini key saved in Settings and of the wrong-password counts, and the command-line tools' Bearer
// credential. People sign in to /admin with their own username and password.
export const SECRET_NAMES=['ADMIN_TOKEN','PDF_LAYOUT_SERVICE_URL','PDF_LAYOUT_SERVICE_TOKEN','GEMINI_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'];
const SECRET_LIKE=/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS?)$/iu;
const KEY_LIKE=/AIza[0-9A-Za-z_-]{35}|^[0-9a-f]{32,}$/iu;
const LOCAL_HOST=/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\]|[^.]+|.+\.(local|internal|lan))$/iu;
export const PLACEHOLDER='[[CHƯA ĐIỀN';
export const VENDOR_FILES=['frontend/vendor/pdf.mjs','frontend/vendor/pdf.worker.mjs','frontend/vendor/pdf-lib.esm.min.js','frontend/vendor/tesseract.esm.min.js','frontend/vendor/paddle/worker.js','frontend/vendor/paddle/models/det.tar','frontend/vendor/paddle/models/rec.tar'];
// The worker treats an unknown mode, or "domain" without domains, as closed (backend/reader-auth.js).
const REGISTRATION_MODES=['open','closed','domain'];
// The values of GEMINI_THINKING the worker honours (backend/worker.js); it ignores any other one.
const THINKING_LEVELS=['minimal','low','medium','high','default'];
// wrangler secret list on a Worker that was never deployed (wrangler's own message, or the API error code).
const WORKER_MISSING=/Worker "[^"\r\n]+"[^\r\n]* not found\.|\[code: 10007\]/u;
const TOKEN_TOO_SHORT=`ADMIN_TOKEN của production ngắn hơn 32 ký tự nên máy chủ không nhận nó: không tạo hay đặt lại được tài khoản quản trị ở /admin, công cụ dòng lệnh cũng không vào được. Đặt lại bằng ${NPX} wrangler secret put ADMIN_TOKEN (nên dùng 64 ký tự hex); đổi ADMIN_TOKEN thì phải nhập lại khóa Gemini đã lưu trong Cài đặt.`;
const SETUP_REQUIRED='Chưa có tài khoản quản trị: mở /admin và tạo tài khoản bằng ADMIN_TOKEN.';
const USAGE=`Cách dùng:
  npm run deploy:check                         kiểm tra mọi thứ, không thay đổi gì trên Cloudflare
  npm run deploy                               kiểm tra, áp migration D1 (hỏi trước), deploy, kiểm tra bản mới
  npm run deploy -- --secrets-file <tệp>       kèm secret từ tệp TÊN=giá trị nằm ngoài repo (bắt buộc ở lần đầu)
Tùy chọn: --yes (không hỏi trước khi áp migration), --skip-tests, --allow-dirty,
  --allow-placeholders (bản thử kín còn chỗ [[CHƯA ĐIỀN…]]; cần REGISTRATION_MODE "closed" hoặc "domain"),
  --allow-unpushed (commit chưa có trên nhánh GitHub mà liên kết "Mã nguồn" trỏ tới; chỉ để thử kín),
  --allow-no-dictionary (deploy không có dữ liệu "Tra chữ Hán"), --allow-stale (D1 có migration lạ),
  --url <https://…> (địa chỉ để kiểm tra sau deploy, ví dụ tên miền riêng).
Kiểm tra /api/status bằng ADMIN_TOKEN sau deploy: đặt biến môi trường HOATRI_ADMIN_TOKEN (giá trị ADMIN_TOKEN của production).`;

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
 // The hash of the layout checks a deploy runs with (--var): a copy in vars would go stale and, under wrangler dev,
 // make the deep health check report a mismatch with the PDF service.
 if(Object.hasOwn(cfg?.vars||{},'PDF_LAYOUT_VERSION'))errors.push('PDF_LAYOUT_VERSION không đặt trong "vars" của wrangler.jsonc: npm run deploy tự truyền mã bố cục của bản code đang deploy. Hãy xóa dòng này.');
 if(cfg?.observability?.enabled&&cfg.observability.redact_query_string!==true)warnings.push('observability.redact_query_string chưa bật: nhật ký Workers sẽ ghi cả ?code= của đăng nhập Google.');
 const mode=String(cfg?.vars?.REGISTRATION_MODE??'open').trim().toLowerCase(),domains=String(cfg?.vars?.ALLOWED_EMAIL_DOMAINS||'').trim();
 if(!REGISTRATION_MODES.includes(mode))warnings.push(`REGISTRATION_MODE "${cfg.vars.REGISTRATION_MODE}" không hợp lệ (open, closed hoặc domain): máy chủ sẽ coi là closed, không ai tạo được tài khoản mới.`);
 else if(mode==='domain'&&!domains)warnings.push('REGISTRATION_MODE là "domain" nhưng ALLOWED_EMAIL_DOMAINS trống: không ai tạo được tài khoản mới.');
 // The admin jobs' default "Cách dịch" (backend/worker.js adminMode): empty means the built-in default, and any other value
 // that is no mode is ignored the same way.
 const translationMode=String(cfg?.vars?.ADMIN_TRANSLATION_MODE??'').trim();
 if(translationMode&&!isMode(translationMode))warnings.push(`ADMIN_TRANSLATION_MODE "${cfg.vars.ADMIN_TRANSLATION_MODE}" không hợp lệ (${MODES.join(', ')} hoặc để trống): máy chủ sẽ dùng ${ADMIN_DEFAULT_MODE} cho bản dịch của quản trị viên.`);
 // GEMINI_THINKING sets the thinking of every step of the admin jobs; a value that is no level is ignored, and each job
 // then thinks as its "Cách dịch" says.
 const thinking=String(cfg?.vars?.GEMINI_THINKING??'').trim();
 if(thinking&&!THINKING_LEVELS.includes(thinking))warnings.push(`GEMINI_THINKING "${cfg.vars.GEMINI_THINKING}" không hợp lệ (${THINKING_LEVELS.join(', ')} hoặc để trống): máy chủ sẽ bỏ qua giá trị này, mỗi bản dịch của quản trị viên suy luận theo Cách dịch của nó.`);
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

// Public pages (frontend/*.html, *.js) and the files of frontend/.well-known (security.txt) that still hold a blank.
export function placeholderFiles(root=ROOT){
 const files=[];
 for(const [folder,pattern] of [['frontend',/\.(html|js)$/u],['frontend/.well-known',/./u]]){
  let names=[];try{names=readdirSync(join(root,folder),{withFileTypes:true}).filter(entry=>entry.isFile()&&pattern.test(entry.name)).map(entry=>entry.name);}catch{}
  files.push(...names.filter(name=>readFileSync(join(root,folder,name),'utf8').includes(PLACEHOLDER)).map(name=>`${folder}/${name}`));
 }
 return files.sort();
}
const registrationMode=cfg=>String(cfg?.vars?.REGISTRATION_MODE??'open').trim().toLowerCase();

// frontend/.well-known/security.txt (RFC 9116): a Contact URI (the blank is left to the placeholder check) and one
// Expires date, which researchers treat as stale once it passed; it should stay under a year ahead.
export const SECURITY_TXT='frontend/.well-known/security.txt';
export function securityTxtProblems(text,now=new Date()){
 const errors=[],warnings=[],values=name=>[...String(text).matchAll(new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`,'gimu'))].map(match=>match[1]);
 const contacts=values('Contact'),expires=values('Expires');
 if(!contacts.length)errors.push(`${SECURITY_TXT} thiếu dòng "Contact:" (RFC 9116).`);
 for(const contact of contacts)if(!contact.includes(PLACEHOLDER)&&!/^(?:mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+|tel:\+?[\d -]+)$/iu.test(contact))errors.push(`${SECURITY_TXT}: "Contact: ${contact}" phải là một địa chỉ mailto:, https:// hoặc tel:.`);
 const at=expires.length===1&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(expires[0])?Date.parse(expires[0]):NaN;
 if(!Number.isFinite(at))errors.push(`${SECURITY_TXT} cần đúng một dòng "Expires:" theo RFC 3339, chưa quá một năm kể từ hôm nay, ví dụ Expires: ${new Date(now.getTime()+330*86400000).toISOString().slice(0,10)}T00:00:00.000Z.`);
 else{
  const days=(at-now.getTime())/86400000,renew=`sửa dòng Expires thành một ngày trong vòng một năm tới rồi deploy lại`;
  if(days<=0)warnings.push(`${SECURITY_TXT} đã hết hạn từ ${expires[0]}: người báo lỗi bảo mật sẽ coi tệp là cũ; ${renew}.`);
  else if(days<30)warnings.push(`${SECURITY_TXT} hết hạn sau ${Math.ceil(days)} ngày (${expires[0]}): ${renew}.`);
  else if(days>366)warnings.push(`${SECURITY_TXT}: Expires ${expires[0]} xa hơn một năm; RFC 9116 khuyên dưới một năm.`);
 }
 return {errors,warnings};
}

// The "Mã nguồn" link of every page (frontend/site-footer.js SOURCE_URL, https://github.com/<owner>/<repo>/tree/<ref>)
// must open the code that runs: the PDF service runs PyMuPDF under the GNU AGPL, which asks for that.
export function sourceUrl(root=ROOT){
 let text='';try{text=readFileSync(join(root,'frontend/site-footer.js'),'utf8');}catch{return null;}
 const url=/export const SOURCE_URL\s*=\s*(['"`])([^'"`]+)\1/u.exec(text)?.[2];if(!url)return null;
 const match=/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/tree\/([^?#]+?)\/?$/u.exec(url);
 return match?{url,owner:match[1],repo:match[2],ref:decodeURIComponent(match[3])}:{url};
}
const sameRepository=(address,{owner,repo})=>{const match=/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(address);return Boolean(match)&&match[1].toLowerCase()===owner.toLowerCase()&&match[2].toLowerCase()===repo.toLowerCase();};
// null when HEAD is published there: on that branch of a remote for the repository (as of the last fetch or push), or,
// for a tag or commit link, HEAD's own tag or commit on a branch of it. Otherwise what is wrong, in Vietnamese.
export async function unpublishedSource(run,root,source,sha){
 if(!source?.ref)return `Không đọc được SOURCE_URL dạng https://github.com/<chủ>/<repo>/tree/<nhánh> trong frontend/site-footer.js${source?.url?` (đang là ${source.url})`:''}.`;
 if(!sha)return 'Không đọc được commit hiện tại, nên không kiểm tra được mã nguồn công khai.';
 const git=args=>run('git',args,{cwd:root}),lines=result=>String(result?.stdout||'').split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
 const [remotes,branches]=await Promise.all([git(['remote','-v']),git(['branch','-r','--contains','HEAD','--format=%(refname)'])]);
 const names=[...new Set(lines(remotes).map(line=>line.split(/\s+/u)).filter(([name,address])=>name&&address&&sameRepository(address,source)).map(([name])=>name))];
 const where=`github.com/${source.owner}/${source.repo}`;
 if(!names.length)return `Không có git remote nào trỏ tới ${where}, nơi liên kết “Mã nguồn” ở chân trang trỏ tới (SOURCE_URL trong frontend/site-footer.js): thêm remote đó, push commit ${sha} rồi chạy lại.`;
 const published=lines(branches).flatMap(ref=>names.filter(name=>ref.startsWith(`refs/remotes/${name}/`)).map(name=>ref.slice(`refs/remotes/${name}/`.length)));
 if(published.includes(source.ref))return null;
 const ref=source.ref.toLowerCase();
 if(published.length&&(/^[\da-f]{7,40}$/u.test(ref)&&(ref.startsWith(sha)||sha.startsWith(ref))||lines(await git(['tag','--points-at','HEAD'])).includes(source.ref)))return null;
 return `Commit ${sha} chưa có trên nhánh ${source.ref} của ${where}, nơi liên kết “Mã nguồn” ở chân trang trỏ tới (SOURCE_URL trong frontend/site-footer.js). Dịch vụ PDF chạy PyMuPDF theo giấy phép GNU AGPL, nên mã nguồn công khai phải đúng bản đang chạy: git push lên nhánh ${source.ref} (đã push từ máy khác thì chạy git fetch trước) rồi chạy lại, hoặc đổi SOURCE_URL sang nhánh đã có commit này.`;
}

// The lookup data of "Tra chữ Hán" (npm run prepare:dict, git-ignored): its manifest and the version folder it names.
export const DICTIONARY_MANIFEST='frontend/vendor/dict/manifest.json';
export function dictionaryProblem(root=ROOT){
 let manifest=null;try{manifest=JSON.parse(readFileSync(join(root,DICTIONARY_MANIFEST),'utf8'));}catch{}
 if(manifest?.format!==1||!/^[\da-f]{12}$/u.test(manifest.id||''))return `Chưa có dữ liệu từ điển (${DICTIONARY_MANIFEST}): trên production, nút “Tra chữ Hán” sẽ báo chưa có dữ liệu.`;
 if(!existsSync(join(root,'frontend/vendor/dict/v',manifest.id,'i','00.json')))return `Dữ liệu từ điển trong frontend/vendor/dict/v/${manifest.id} chưa đủ: nút “Tra chữ Hán” sẽ lỗi khi tra.`;
 return null;
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

// What /api/health?deep=1 says about the PDF service (backend/health.js), when it is not usable.
const PDF_SERVICE_PROBLEMS={
 unauthorized:'Dịch vụ PDF từ chối token của Worker: secret PDF_LAYOUT_SERVICE_TOKEN khác giá trị trong .env của dịch vụ (deploy/pdf-layout/README.md mục A.5, "Đổi token").',
 timeout:'Dịch vụ PDF không trả lời Worker trong 5 giây: xem docker compose ps và docker compose logs pdf-layout trên máy chủ PDF.',
 unreachable:'Worker không kết nối được dịch vụ PDF: kiểm tra máy chủ PDF, bản ghi DNS (DNS only) và secret PDF_LAYOUT_SERVICE_URL.',
 error:'Dịch vụ PDF trả lời lỗi: xem docker compose logs pdf-layout trên máy chủ PDF, và PDF_LAYOUT_SERVICE_URL phải là gốc https://….'
};
// layout/service: the hashes of this checkout (services/pdf-layout/version.mjs), compared with what the live service runs.
// dictionary: false when deployed without the lookup data on purpose (--allow-no-dictionary): it is still checked, and
// its absence is then only a warning.
export async function postDeployChecks(base,{fetch=globalThis.fetch,sha=null,adminToken='',dictionary=true,layout=null,service=null,sleep=ms=>new Promise(done=>setTimeout(done,ms)),attempts=6,timeoutMs=15000}={}){
 const results=[],ok=text=>results.push({level:'ok',text}),warn=text=>results.push({level:'warn',text}),bad=text=>results.push({level:'error',text});
 const get=async(path,{method='GET',headers={},redirect='follow'}={})=>{
  try{
   const response=await fetch(new URL(path,base),{method,headers,redirect,signal:AbortSignal.timeout(timeoutMs)}),text=method==='HEAD'?'':await response.text();
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
  // The Worker itself calls the PDF service: the address, the token and the shared layout checks are verified at once.
  else if(health.json.pdfLayout==='configured'){
   // A Worker older than the deep check answers without pdfService: nothing to compare then.
   const pdf=(await get('/api/health?deep=1')).json?.pdfService;
   if(pdf?.status==='ok'){
    ok(`Dịch vụ PDF trả lời qua Worker (${pdf.ms} ms, ${pdf.jobs||'?'} việc cùng lúc, phông ${pdf.font||'?'})${pdf.layoutMatch?'; bộ kiểm tra bố cục khớp với Worker':''}.`);
    if(layout&&pdf.expectedLayout&&pdf.expectedLayout!==layout)warn(`Worker đang chạy báo mã bố cục ${pdf.expectedLayout}, mã nguồn này là ${layout}: chờ vài phút rồi mở lại ${new URL('/api/health?deep=1',base)}.`);
    if(service&&pdf.version?.service&&pdf.version.service!==service)warn(`Dịch vụ PDF đang chạy bản ${pdf.version.service}, mã nguồn này là bản ${service}: cập nhật dịch vụ PDF trên máy chủ (deploy/pdf-layout/README.md mục A.5).`);
    if(pdf.font&&!/^LiberationSerif/u.test(pdf.font))warn(`Dịch vụ PDF xuất bằng phông ${pdf.font}, không phải Liberation Serif như image chuẩn: chữ Việt có thể nhỏ hơn bản đã thử. Build lại image (deploy/pdf-layout/README.md mục A.5).`);
    // A service names its font only when the file is there; an image older than /health's font field names none either.
    else if(!pdf.font)warn('Dịch vụ PDF không báo phông chữ xuất PDF: image thiếu tệp phông (mọi lần xuất PDF tiếng Việt sẽ lỗi) hoặc là bản cũ. Build lại image (deploy/pdf-layout/README.md mục A.5).');
   }
   else if(pdf?.status==='mismatch')bad(`Dịch vụ PDF kiểm tra tài liệu bằng mã bố cục ${pdf.version?.layout||'?'}, còn Worker vừa deploy dùng ${pdf.expectedLayout||'?'}: trang scan có thể bị từ chối ("Ảnh trang PDF không hợp lệ."). Cập nhật dịch vụ PDF ngay (deploy/pdf-layout/README.md mục A.5).`);
   else if(pdf)bad(PDF_SERVICE_PROBLEMS[pdf.status]||`Dịch vụ PDF chưa dùng được (${pdf.status}).`);
  }
 }else if(health.status===503)bad('/api/health trả 503: Worker không truy vấn được D1 (kiểm tra database_id và migration).');
 else if(health.status===404)warn('Bản này chưa có /api/health: bỏ qua kiểm tra phiên bản.');
 else bad(`/api/health không trả lời đúng (${health.status||health.error}).`);
 const home=await get('/');
 if(home.status!==200||!/text\/html/iu.test(home.type))bad(`Trang chủ trả ${home.status||home.error} (${home.type||'không có Content-Type'}).`);
 else if(home.headers.get('content-security-policy')||home.headers.get('content-security-policy-report-only'))ok('Trang chủ có Content-Security-Policy.');
 else warn('Trang chủ chưa có header Content-Security-Policy (frontend/_headers).');
 // Link previews and the sitemap take the address the request came to: a workers.dev name shows on every shared card.
 const host=new URL(base).hostname,origin=new URL(base).origin;
 // A visitor who types http:// is sent to https:// before anything is filled in: by the Worker (backend/http.js
 // insecureRequest) or the zone's "Always Use HTTPS". A temporary redirect works, but browsers do not remember it.
 const plain=new URL('/',base);plain.protocol='http:';
 const insecure=await get(plain.href,{redirect:'manual'}),location=insecure.headers.get('location')||'';
 let target=null;try{target=new URL(location,plain);}catch{}
 const secure=target?.protocol==='https:'&&target.hostname===plain.hostname;
 if(secure&&[301,308].includes(insecure.status))ok(`http://${host}/ chuyển sang https:// (${insecure.status}).`);
 else if(secure&&[302,303,307].includes(insecure.status))warn(`http://${host}/ chuyển sang https:// bằng mã tạm thời ${insecure.status} thay vì 301: kiểm tra “Always Use HTTPS” của tên miền (ONBOARDING mục 5.3).`);
 else if(!insecure.status)warn(`Không kiểm tra được http://${host}/ (${insecure.error}): mở thử địa chỉ đó, trang phải chuyển sang https://.`);
 else bad(`http://${host}/ trả ${insecure.status}${location?` (chuyển tới ${location})`:''} thay vì chuyển hướng 301 sang https://${host}/: ai gõ http:// có thể đăng nhập qua kết nối không mã hóa. Kiểm tra backend/http.js (insecureRequest) và bật “Always Use HTTPS” cho tên miền (ONBOARDING mục 5.3).`);
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
 // The lookup data of "Tra chữ Hán": its manifest and the first index file of the version folder it names.
 const manifest=await get('/vendor/dict/manifest.json'),folder=manifest.json?.base,lookup=dictionary?bad:warn;
 if(manifest.status!==200||manifest.json?.format!==1||!/^\/vendor\/dict\/v\/[\da-f]{12}\/$/u.test(String(folder||'')))lookup(`/vendor/dict/manifest.json trả ${manifest.status||manifest.error} (${manifest.type||'?'}): dữ liệu từ điển chưa lên Worker${dictionary?'; chạy npm run prepare:dict rồi deploy lại':' (đã deploy với --allow-no-dictionary)'}.`);
 else{
  const index=await get(`${folder}i/00.json`,{method:'HEAD'});
  if(index.status===200&&!/text\/html/iu.test(index.type))ok(`/vendor/dict/manifest.json: dữ liệu từ điển ${manifest.json.id}, có tệp ${folder}i/00.json.`);
  else lookup(`${folder}i/00.json trả ${index.status||index.error} (${index.type||'?'}): dữ liệu từ điển lên Worker chưa đủ; chạy npm run prepare:dict rồi deploy lại.`);
 }
 const library=await get('/api/library');
 if(library.status===200&&Array.isArray(library.json))ok(`/api/library: ${library.json.length} mục công khai.`);
 else bad(`/api/library trả ${library.status||library.error}: kiểm tra D1 và migration.`);
 const me=await get('/api/me'),registration=me.json?.registration;
 const mode={open:'ai cũng tạo được tài khoản',closed:'đang đóng',domain:`chỉ email thuộc ${(registration?.domains||[]).join(', ')}`}[registration?.mode];
 if(me.status===200&&typeof me.json?.authenticated==='boolean')ok(`/api/me trả lời${mode?`; đăng ký: ${mode}`:''}.`);
 else bad(`/api/me trả ${me.status||me.error}.`);
 // Without a token /api/status still says whether ADMIN_TOKEN is too short to be used outside localhost, and whether
 // /admin is waiting for its first account (made there with ADMIN_TOKEN).
 const open=await get('/api/status'),tooShort=Boolean(open.json?.adminTokenTooShort);
 if(open.status!==200||typeof open.json?.authenticated!=='boolean')bad(`/api/status trả ${open.status||open.error}.`);
 else if(tooShort)bad(TOKEN_TOO_SHORT);
 if(open.json?.adminSetupRequired===true)warn(SETUP_REQUIRED);
 if(adminToken&&!tooShort){
  const status=await get('/api/status',{headers:{Authorization:`Bearer ${adminToken}`}});
  if(status.status===200&&status.json?.authenticated===true)ok(`/api/status: ADMIN_TOKEN đúng, model ${status.json.model||'?'}${status.json.translationMode?`, Cách dịch mặc định của quản trị viên: ${status.json.translationMode}`:''}.`);
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
 const {values}=parseArgs({args:argv,strict:true,allowPositionals:false,options:{check:{type:'boolean'},yes:{type:'boolean'},'skip-tests':{type:'boolean'},'allow-dirty':{type:'boolean'},'allow-placeholders':{type:'boolean'},'allow-unpushed':{type:'boolean'},'allow-no-dictionary':{type:'boolean'},'allow-stale':{type:'boolean'},'secrets-file':{type:'string'},url:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.url&&!/^https:\/\/[^/]+\/?$/u.test(values.url))throw new Error('--url phải là gốc https://… của Worker.');
 return {check:!!values.check,yes:!!values.yes,skipTests:!!values['skip-tests'],allowDirty:!!values['allow-dirty'],allowPlaceholders:!!values['allow-placeholders'],allowUnpushed:!!values['allow-unpushed'],allowNoDictionary:!!values['allow-no-dictionary'],allowStale:!!values['allow-stale'],secretsFile:values['secrets-file']||null,url:values.url?.replace(/\/$/u,'')||null,help:!!values.help};
}

function afterDeployText(base,{previous,bookmark}){
 return [
  '\nKiểm tra bằng tay (không tốn token Gemini):',
  `  - ${base||'<URL Worker>'}/#account: tạo một tài khoản thử, đăng xuất rồi đăng nhập lại.`,
  `  - ${base||'<URL Worker>'}/study: dòng dịch vụ PDF ghi "Dịch từng đoạn ngay tại chỗ; giữ hình gốc, công thức và vị trí chữ."`,
  `  - ${base||'<URL Worker>'}/admin: đăng nhập bằng tên đăng nhập và mật khẩu quản trị (lần đầu: tạo tài khoản bằng ADMIN_TOKEN), mở "Cài đặt".`,
  `  - Xem lỗi trực tiếp: ${NPX} wrangler tail`,
  `  - Giám sát (một lần): trỏ dịch vụ theo dõi uptime vào ${base||'<URL Worker>'}/api/health?deep=1 (trả 503 khi D1 hoặc dịch vụ PDF lỗi); xem deploy/pdf-layout/README.md mục A.8.`,
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
 // Blanks only on a closed trial (registration closed, or open to one test school's domain): the public never signs up
 // under terms that name no operator or contact.
 const placeholders=placeholderFiles(root),mode=registrationMode(cfg);
 if(placeholders.length){
  const blanks=`Trang công khai còn chỗ "${PLACEHOLDER}…" chưa điền: ${placeholders.join(', ')}.`;
  if(!opts.allowPlaceholders)errors.push(`${blanks} Điền thông tin thật trước khi công bố (--allow-placeholders chỉ dành cho bản thử kín, khi REGISTRATION_MODE là "closed" hoặc "domain").`);
  else if(mode==='open')errors.push(`${blanks} --allow-placeholders chỉ dành cho bản thử kín, nhưng wrangler.jsonc đang mở đăng ký cho mọi người (REGISTRATION_MODE "open"): đặt "closed" (hoặc "domain" cho một trường thử) rồi chạy lại, hoặc điền hết các chỗ trống.`);
  else caution(`${blanks} Đây chỉ là bản thử kín (REGISTRATION_MODE "${mode}"): điền hết trước khi mở đăng ký và chia sẻ link.`);
 }
 if(existsSync(join(root,SECURITY_TXT))){const security=securityTxtProblems(readFileSync(join(root,SECURITY_TXT),'utf8'));errors.push(...security.errors);security.warnings.forEach(caution);}
 else caution(`Chưa có ${SECURITY_TXT} (RFC 9116): người phát hiện lỗi bảo mật không biết báo ở đâu.`);
 const git=await gitState(run,root);
 if(!git.sha&&!opts.allowDirty)errors.push('Không đọc được commit hiện tại (cần git và một bản clone): --allow-dirty để bỏ qua.');
 if(git.dirty&&!opts.allowDirty)errors.push(`Có ${git.dirty} tệp thay đổi chưa commit: commit hoặc stash trước, để bản deploy đúng với commit được gắn tag (--allow-dirty để bỏ qua).`);
 const source=sourceUrl(root),unpublished=await unpublishedSource(run,root,source,git.sha);
 if(!unpublished)log(`Mã nguồn công khai của bản này: https://github.com/${source.owner}/${source.repo}/tree/${git.sha} (nhánh ${source.ref}).`);
 else if(opts.allowUnpushed)caution(`${unpublished} Bỏ qua vì có --allow-unpushed: chỉ dùng cho bản thử kín.`);
 else errors.push(`${unpublished} (--allow-unpushed nếu chỉ thử kín.)`);
 // The lookup data is git-ignored and built by npm run prepare:dict: a fresh clone has none.
 const missingDictionary=dictionaryProblem(root);
 if(missingDictionary&&!opts.allowNoDictionary)errors.push(`${missingDictionary} Chạy npm run prepare:dict rồi chạy lại (--allow-no-dictionary để deploy không có từ điển).`);
 else if(missingDictionary)caution(`${missingDictionary} Deploy tiếp vì có --allow-no-dictionary.`);
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
  if(!opts.secretsFile)return stop('Lần deploy đầu cần --secrets-file <tệp TÊN=giá trị nằm ngoài repo> có ít nhất ADMIN_TOKEN, để Worker không lúc nào chạy mà thiếu ADMIN_TOKEN (mã tạo tài khoản quản trị đầu tiên và khóa mã hóa của máy chủ).');
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
 // The Worker's /api/health?deep=1 compares this hash of the shared layout checks with the PDF service's own.
 const layout=layoutVersion(root),service=buildVersion(root)?.service||null;
 const deployArgs=['deploy','--strict','--tag',tag,'--message',`${branch}@${tag}`.slice(0,100),...(opts.secretsFile?['--secrets-file',resolve(opts.secretsFile)]:[]),...(layout?['--var',`PDF_LAYOUT_VERSION:${layout}`]:[])];
 const deployed=await wrangler(deployArgs,{tee:true});
 if(deployed.code!==0)return stop([`wrangler deploy lỗi (xem ở trên).${firstDeploy?' Lần đầu: nếu wrangler đòi đăng ký subdomain workers.dev, đăng ký trong dashboard Cloudflare (Workers & Pages) rồi chạy lại.':''}`],pending.length?'Migration đã áp dụng; bản code cũ vẫn đang chạy.':'Đã dừng: bản code cũ vẫn đang chạy.');
 const {url,versionId}=parseDeployOutput(output(deployed)),base=opts.url||url;
 if(versionId)log(`Phiên bản mới: ${versionId}.`);

 step('Kiểm tra bản vừa deploy');
 let failed=0;
 if(!base)caution('Không đọc được URL của Worker từ wrangler: lần sau thêm --url <https://…> để kiểm tra tự động.');
 else for(const result of await postDeployChecks(base,{fetch,sha:tag,adminToken:env.HOATRI_ADMIN_TOKEN||'',dictionary:!missingDictionary,layout,service,...(sleep?{sleep}:{})})){
  if(result.level==='error'){failed++;logError(`LỖI: ${result.text}`);}
  else if(result.level==='warn')caution(result.text);
  else log(`OK  ${result.text}`);
 }
 log(afterDeployText(base,{previous,bookmark}));
 if(failed)logError(`\n${failed} kiểm tra sau deploy chưa đạt: xem LỖI ở trên, quay lại bản trước nếu cần.`);
 return failed?1:0;
}

// Started as a program, also through a symlinked or junction folder: Node runs a module from its real path, while argv[1]
// keeps the path it was given, so both are compared as real paths.
const realPath=path=>{const real=realpathSync(path);return process.platform==='win32'?real.toLowerCase():real;};
const started=()=>{try{return Boolean(process.argv[1])&&realPath(process.argv[1])===realPath(fileURLToPath(import.meta.url));}catch{return false;}};
if(started())process.exitCode=await main();
