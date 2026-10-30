// `npm run dev` runs this first (predev): wrangler dev applies no migration, and a local D1 behind the code answers every
// history list and save with schema_outdated, so the app refuses to start while database/migrations holds a file the
// local d1_migrations table lacks. It never migrates: it names npm run db:local, or start.cmd (whose setup applies them).
// Read only, from the file wrangler opens: .wrangler/state next to wrangler.jsonc (or --persist-to), v3/d1, the object
// workerd names after preview_database_id. That file is opened immutable (no lock, no -wal or -shm made beside it); while
// its -wal holds writes not yet copied in, a copy of both is read instead. A machine with no local database yet (a fresh
// clone: setup creates it), or one this check cannot read, starts as before.
import {copyFileSync,existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {parseJsonc,pendingMigrations} from './deploy.mjs';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
// The id workerd derives from a Durable Object name (idFromName) under miniflare's key for D1; it names the file.
export function objectId(name,uniqueKey='miniflare-D1DatabaseObject'){
 const key=createHash('sha256').update(uniqueKey).digest(),head=createHmac('sha256',key).update(name).digest().subarray(0,16);
 return Buffer.concat([head,createHmac('sha256',key).update(head).digest().subarray(0,16)]).toString('hex');
}
// The DB binding's local database as wrangler dev and `wrangler d1 migrations apply --local` open it, or null.
export function localDatabase(root=ROOT,{persistTo=null}={}){
 const db=(parseJsonc(readFileSync(join(root,'wrangler.jsonc'),'utf8')).d1_databases||[]).find(entry=>entry?.binding==='DB');if(!db)return null;
 const state=persistTo?resolve(persistTo):join(root,'.wrangler','state'),id=String(db.preview_database_id??db.database_id??db.binding);
 return {file:join(state,'v3','d1','miniflare-D1DatabaseObject',`${objectId(id)}.sqlite`),migrations:join(root,db.migrations_dir||'migrations'),table:db.migrations_table||'d1_migrations'};
}
// The names wrangler recorded, in order ([] for a database it never migrated).
export async function appliedMigrations(file,table='d1_migrations'){
 const {DatabaseSync}=await import('node:sqlite');
 const read=(location,options)=>{
  const db=new DatabaseSync(location,options);
  try{return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare(`SELECT name FROM "${table.replaceAll('"','""')}" ORDER BY id`).all().map(row=>String(row.name)):[];}
  finally{db.close();}
 };
 const wal=`${file}-wal`;
 if(!existsSync(wal)||!statSync(wal).size){const url=pathToFileURL(file);url.searchParams.set('immutable','1');try{return read(url,{readOnly:true});}catch{}}
 // Writes still in the -wal, or a Node that opens no file: URL: a copy in a temporary folder, removed at once.
 const dir=mkdtempSync(join(tmpdir(),'hoa-tri-d1-')),copy=join(dir,'d1.sqlite');
 try{copyFileSync(file,copy);if(existsSync(wal))copyFileSync(wal,`${copy}-wal`);return read(copy,{});}
 finally{rmSync(dir,{recursive:true,force:true});}
}
// {status:'ok'|'pending'|'missing', pending, file}: missing = no local database yet.
export async function migrationState(root=ROOT,options={}){
 const local=localDatabase(root,options);if(!local)return {status:'missing',pending:[],file:null};
 const files=readdirSync(local.migrations).filter(name=>name.endsWith('.sql')&&!name.startsWith('.')).sort();
 if(!existsSync(local.file))return {status:'missing',pending:files,file:local.file};
 const {pending}=pendingMigrations(files,await appliedMigrations(local.file,local.table));
 return {status:pending.length?'pending':'ok',pending,file:local.file};
}
// command: what the student ran, which starts nothing until the migrations are applied.
export function migrationMessage(state,command='npm run dev'){
 if(state?.status==='pending')return `LỖI: cơ sở dữ liệu cục bộ (.wrangler) chưa có ${state.pending.length} migration mà code này cần: ${state.pending.join(', ')}.\n"${command}" không tự áp migration nên chưa khởi động. Chạy "npm run db:local" rồi chạy lại "${command}", hoặc bấm đúp start.cmd (tự áp migration rồi khởi động Hoa Trí cùng dịch vụ PDF).`;
 if(state?.status==='missing')return 'Chưa có cơ sở dữ liệu cục bộ (.wrangler): chạy "npm run setup" (hoặc bấm đúp start.cmd) để tạo; thiếu nó, mọi thao tác cần tài khoản đều báo lỗi.';
 return '';
}
// --persist-to: wrangler's own option; --command: the command the message names (npm run dev unless said).
export async function main(argv=process.argv.slice(2)){
 const {values}=parseArgs({args:argv,options:{'persist-to':{type:'string'},command:{type:'string'}},strict:false});
 let state;
 try{state=await migrationState(ROOT,{persistTo:values['persist-to']||null});}
 catch(error){console.warn(`Không kiểm tra được migration của cơ sở dữ liệu cục bộ (${String(error?.message||error).split(/\r?\n/u)[0]}); vẫn khởi động.`);return 0;}
 const message=migrationMessage(state,values.command||undefined);
 if(state.status==='pending'){console.error(`\n${message}\n`);return 1;}
 if(message)console.warn(message);
 return 0;
}

// Started as a program (also through a symlinked folder: argv[1] keeps the path it was given, Node runs the real one).
const realPath=path=>{const real=realpathSync(path);return process.platform==='win32'?real.toLowerCase():real;};
const started=()=>{try{return Boolean(process.argv[1])&&realPath(process.argv[1])===realPath(fileURLToPath(import.meta.url));}catch{return false;}};
if(started())process.exitCode=await main();
