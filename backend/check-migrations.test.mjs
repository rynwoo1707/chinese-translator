import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {appliedMigrations,localDatabase,migrationMessage,migrationState,objectId} from './check-migrations.mjs';
import {parseJsonc} from './deploy.mjs';

// Local D1 states made here in temporary folders with short paths (workerd cannot open a path past 260 characters on
// Windows); the developer's own .wrangler is never opened.
const REPO=fileURLToPath(new URL('../',import.meta.url));
const MIGRATIONS=readdirSync(join(REPO,'database/migrations')).filter(name=>name.endsWith('.sql')).sort();
const OLD=MIGRATIONS.filter(name=>name<'0025'),NEW=MIGRATIONS.filter(name=>name>='0025');
const TABLE='CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
function folder(t){const dir=mkdtempSync(join(tmpdir(),'hoa-tri-mig-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
// The file wrangler dev would open under <persist>, with these names recorded as applied (null: a database never migrated).
function state(persist,names){
 const {file}=localDatabase(REPO,{persistTo:persist});mkdirSync(dirname(file),{recursive:true});
 const db=new DatabaseSync(file);
 try{db.exec('PRAGMA journal_mode=WAL');if(names){db.exec(TABLE);for(const name of names)db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);}else db.exec('CREATE TABLE other(id INTEGER)');}
 finally{db.close();}
 return file;
}
const listing=dir=>readdirSync(dir).sort().map(name=>{const stat=statSync(join(dir,name));return `${name} ${stat.size} ${stat.mtimeMs}`;});
const copies=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('hoa-tri-d1-')).length;
const check=(persist,...args)=>spawnSync(process.execPath,['--no-warnings',join(REPO,'backend/check-migrations.mjs'),'--persist-to',persist,...args],{cwd:REPO,encoding:'utf8',timeout:60000});

test('The local database is the file wrangler makes: a D1 written through Miniflare, as `wrangler d1 migrations apply --local` does, is read without a change',{timeout:90000},async t=>{
 const persist=folder(t),db=parseJsonc(readFileSync(join(REPO,'wrangler.jsonc'),'utf8')).d1_databases.find(entry=>entry.binding==='DB'),id=db.preview_database_id??db.database_id;
 // Miniflare as wrangler's own copy resolves it, set up as wrangler's local D1 commands set it up (wrangler-dist executeLocally).
 const wrangler=createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
 const {Miniflare,convertV4MiniflareOptions=options=>options}=await import(pathToFileURL(wrangler.resolve('miniflare')).href);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'',resourcePersistencePath:join(persist,'v3'),d1Databases:{DATABASE:id}}));
 try{const d1=await mf.getD1Database('DATABASE');await d1.prepare(TABLE).run();for(const name of OLD)await d1.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name).run();}
 finally{await mf.dispose();}
 const dir=join(persist,'v3','d1','miniflare-D1DatabaseObject'),before=listing(dir);
 assert.ok(before.some(entry=>entry.startsWith(`${objectId(id)}.sqlite `)),before.join(' | '));
 // workerd leaves its writes in the -wal: they are read through a copy, removed at once.
 const made=copies(),found=await migrationState(REPO,{persistTo:persist});
 assert.deepEqual(found,{status:'pending',pending:NEW,file:join(dir,`${objectId(id)}.sqlite`)});assert.ok(NEW.includes('0026_study_engine.sql'));
 assert.deepEqual(listing(dir),before,'nothing beside the database is written, made or touched');assert.equal(copies(),made,'the copy is gone');
});

test('A database whose writes are all in its file is opened immutable: no -wal or -shm appears beside it',async t=>{
 const file=state(folder(t),OLD),dir=dirname(file),before=listing(dir);
 assert.deepEqual(before.map(entry=>entry.split(' ')[0]),[basename(file)]);
 assert.deepEqual(await appliedMigrations(file),OLD);assert.deepEqual(listing(dir),before);
});

test('Writes another process still holds in the -wal are seen; the folder is left as it was',async t=>{
 const file=state(folder(t),OLD.slice(0,1)),dir=dirname(file),open=new DatabaseSync(file);
 try{
  open.exec('PRAGMA wal_autocheckpoint=0');open.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(OLD[1]);
  assert.ok(statSync(`${file}-wal`).size>0);const before=listing(dir),made=copies();
  assert.deepEqual(await appliedMigrations(file),OLD.slice(0,2));assert.deepEqual(listing(dir),before);assert.equal(copies(),made);
 }finally{open.close();}
});

test('A state at 0024 lists the later migrations and npm run dev stops; the newest state starts; no database yet starts with a hint',{timeout:90000},async t=>{
 const old=folder(t);state(old,OLD);
 const stopped=check(old);
 assert.equal(stopped.status,1,stopped.stderr);assert.equal(stopped.stdout,'');
 assert.match(stopped.stderr,/LỖI: cơ sở dữ liệu cục bộ \(\.wrangler\) chưa có \d+ migration mà code này cần: 0025_admin_accounts\.sql, 0026_study_engine\.sql/u);
 assert.match(stopped.stderr,/"npm run dev" không tự áp migration nên chưa khởi động\. Chạy "npm run db:local" rồi chạy lại "npm run dev", hoặc bấm đúp start\.cmd/u);
 // npm start (backend/start-local.mjs without the launcher) may run the same check under its own name.
 const named=check(old,'--command','npm start');assert.equal(named.status,1);assert.match(named.stderr,/"npm start" không tự áp migration nên chưa khởi động\. Chạy "npm run db:local" rồi chạy lại "npm start"/u);
 const current=folder(t);state(current,MIGRATIONS);
 const started=check(current);assert.equal(started.status,0,started.stderr);assert.equal(started.stdout+started.stderr,'');
 // A fresh clone: setup creates the database, so nothing stops wrangler dev.
 const fresh=check(join(folder(t),'none'));assert.equal(fresh.status,0);assert.match(fresh.stderr,/Chưa có cơ sở dữ liệu cục bộ \(\.wrangler\): chạy "npm run setup" \(hoặc bấm đúp start\.cmd\)/u);
 // A file it cannot read never keeps the app from starting.
 const broken=folder(t),{file}=localDatabase(REPO,{persistTo:broken});mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'không phải SQLite '.repeat(400));
 const unread=check(broken);assert.equal(unread.status,0);assert.match(unread.stderr,/^Không kiểm tra được migration của cơ sở dữ liệu cục bộ \(.+\); vẫn khởi động\./u);
});

test('A database never migrated has every migration pending; the messages name what applies them',async t=>{
 const persist=folder(t);state(persist,null);
 assert.deepEqual(await migrationState(REPO,{persistTo:persist}),{status:'pending',pending:MIGRATIONS,file:localDatabase(REPO,{persistTo:persist}).file});
 assert.equal(migrationMessage({status:'ok',pending:[]}),'');
 assert.match(migrationMessage({status:'pending',pending:['0025_a.sql','0026_b.sql']}),/^LỖI: cơ sở dữ liệu cục bộ \(\.wrangler\) chưa có 2 migration mà code này cần: 0025_a\.sql, 0026_b\.sql\.\n/u);
 assert.match(migrationMessage({status:'pending',pending:['0025_a.sql']},'npm start'),/\n"npm start" không tự áp migration nên chưa khởi động\. Chạy "npm run db:local" rồi chạy lại "npm start"/u);
 assert.match(migrationMessage({status:'missing',pending:MIGRATIONS}),/npm run setup.*start\.cmd/u);
});

test('npm run dev checks the migrations before anything else',()=>{
 const {scripts}=JSON.parse(readFileSync(join(REPO,'package.json'),'utf8'));
 assert.match(scripts.predev,/^node --no-warnings backend\/check-migrations\.mjs && /u);assert.equal(scripts.dev,'wrangler dev');
});
