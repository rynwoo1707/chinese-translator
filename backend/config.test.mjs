import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configProblems,parseJsonc,SECRET_NAMES} from './deploy.mjs';

// Deployment configuration as committed: wrangler.jsonc against the installed wrangler's own schema and the project's
// rules, the example env files, the CI workflow, the PDF service deployment files and the paid-API guard of the tests.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const config=parseJsonc(read('wrangler.jsonc'));
const require=createRequire(import.meta.url);

// The subset of JSON Schema that node_modules/wrangler/config-schema.json uses.
function schemaErrors(schema,value,definitions,path='wrangler.jsonc',errors=[]){
 if(schema===true||schema===undefined)return errors;
 if(schema===false){errors.push(`${path}: not allowed`);return errors;}
 if(schema.$ref)return schemaErrors(definitions[schema.$ref.replace('#/definitions/','')],value,definitions,path,errors);
 for(const part of schema.allOf||[])schemaErrors(part,value,definitions,path,errors);
 if(schema.anyOf&&!schema.anyOf.some(option=>!schemaErrors(option,value,definitions,path,[]).length))errors.push(`${path}: matches none of the allowed shapes`);
 if('const' in schema&&JSON.stringify(schema.const)!==JSON.stringify(value))errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
 if(schema.enum&&!schema.enum.some(option=>JSON.stringify(option)===JSON.stringify(value)))errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
 const kind=Array.isArray(value)?'array':value===null?'null':typeof value;
 if(schema.type&&![schema.type].flat().some(type=>type===kind||(type==='integer'&&Number.isInteger(value))||(type==='number'&&kind==='number')))errors.push(`${path}: expected ${schema.type}, got ${kind}`);
 if(kind==='object'){
  for(const name of schema.required||[])if(!(name in value))errors.push(`${path}.${name}: required`);
  for(const [name,item] of Object.entries(value)){
   if(schema.properties&&name in schema.properties)schemaErrors(schema.properties[name],item,definitions,`${path}.${name}`,errors);
   else if(schema.additionalProperties===false)errors.push(`${path}.${name}: unknown key`);
   else if(typeof schema.additionalProperties==='object')schemaErrors(schema.additionalProperties,item,definitions,`${path}.${name}`,errors);
  }
 }
 if(kind==='array'&&schema.items)value.forEach((item,index)=>schemaErrors(schema.items,item,definitions,`${path}[${index}]`,errors));
 return errors;
}

test('wrangler.jsonc is valid for the installed wrangler and reads the same with deploy.mjs',()=>{
 const schema=JSON.parse(read('node_modules/wrangler/config-schema.json'));
 assert.deepEqual(schemaErrors(schema,config,schema.definitions),[]);
 assert.deepEqual(schemaErrors(schema,{...config,observability:{enabled:true,redact_query:true}},schema.definitions),['wrangler.jsonc.observability.redact_query: unknown key'],'the validator itself catches a typo');
 const {rawConfig}=require('wrangler').experimental_readRawConfig({config:fileURLToPath(new URL('../wrangler.jsonc',import.meta.url))});
 assert.deepEqual(config,rawConfig);
});

test('wrangler.jsonc keeps local data, secrets and logs safe',()=>{
 const {errors,warnings}=configProblems(config);
 // The only acceptable error is the database that `wrangler d1 create` has not replaced yet.
 assert.ok(errors.every(error=>error.startsWith('database_id vẫn là "local-db"')),errors.join('\n'));
 assert.deepEqual(warnings,[]);
 assert.equal(config.secrets,undefined,'a "secrets" block makes wrangler dev ignore the other .dev.vars lines');
 const db=config.d1_databases.find(d=>d.binding==='DB');
 assert.ok(db.database_id==='local-db'||/^[0-9a-f-]{36}$/u.test(db.database_id));
 assert.equal(db.preview_database_id,'local-db','wrangler dev keys the local database by this id');
 assert.equal(config.r2_buckets.find(b=>b.binding==='FILES').bucket_name,'muc-viet-files','wrangler dev keys local R2 files by bucket name');
 for(const [name,value] of Object.entries(config.vars||{})){assert.equal(typeof value,'string',name);assert.ok(!SECRET_NAMES.includes(name),name);}
 assert.equal(config.observability.enabled,true);assert.equal(config.observability.redact_query_string,true,'the Google login callback carries ?code=');
 assert.ok(config.compatibility_flags.includes('nodejs_compat'));
 assert.ok(config.assets.run_worker_first.includes('/api/*'));
 assert.ok(existsSync(new URL(`../${config.main}`,import.meta.url))&&existsSync(new URL(`../${config.assets.directory}`,import.meta.url)));
 assert.equal(config.version_metadata.binding,'CF_VERSION_METADATA');
 const limiters=config.ratelimits||[];
 assert.deepEqual(limiters.map(l=>l.name).sort(),['API_LIMITER','AUTH_LIMITER','HEAVY_LIMITER']);
 assert.equal(new Set(limiters.map(l=>l.namespace_id)).size,limiters.length,'namespace_id must be unique in the account');
 for(const limiter of limiters){assert.match(limiter.namespace_id,/^[1-9]\d*$/u);assert.ok(Number.isInteger(limiter.simple.limit)&&limiter.simple.limit>0);assert.ok([10,60].includes(limiter.simple.period));}
});

test('Migrations have unique numbers, so wrangler applies them in one clear order',()=>{
 const files=readdirSync(new URL(`../${config.d1_databases.find(d=>d.binding==='DB').migrations_dir}/`,import.meta.url)).filter(name=>name.endsWith('.sql'));
 const numbers=files.map(name=>/^(\d{4})_[a-z0-9_]+\.sql$/u.exec(name)?.[1]);
 assert.ok(numbers.every(Boolean),`migration names must look like 0001_name.sql: ${files.join(', ')}`);
 assert.equal(new Set(numbers).size,numbers.length,`two migrations share a number: ${files.join(', ')}`);
});

test('Example env files carry no secret and stay readable by setup.mjs and docker compose',()=>{
 const keyLike=/AIza[0-9A-Za-z_-]{35}|[0-9a-f]{32,}/iu;
 for(const [path,secretNames] of [['.dev.vars.example',SECRET_NAMES],['deploy/pdf-layout/env.example',['PDF_LAYOUT_SERVICE_TOKEN']]]){
  const lines=read(path).split(/\r?\n/u).filter(line=>line.trim()&&!line.trimStart().startsWith('#'));
  for(const line of lines){
   assert.match(line,/^[A-Z][A-Z0-9_]*=[^#]*$/u,`${path}: plain KEY=value only (${line.split('=')[0]})`);
   const [name,value]=[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)];
   assert.ok(!keyLike.test(value),`${path}: ${name} looks like a real secret`);
   if(secretNames.includes(name))assert.ok(value===''||/^replace-with-|^http:\/\/127\.0\.0\.1:/u.test(value),`${path}: ${name} must stay empty or a placeholder`);
  }
 }
});

test('CI uses no secrets, pins every action to a commit and runs the tests with paid APIs blocked',()=>{
 const workflow=read('.github/workflows/ci.yml');
 assert.doesNotMatch(workflow,/\$\{\{\s*secrets\./u);assert.doesNotMatch(workflow,/pull_request_target/u);
 assert.match(workflow,/^permissions:\s*\n\s+contents: read\s*$/mu);
 const uses=[...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gmu)].map(match=>match[1]);
 assert.ok(uses.length>=6);for(const action of uses)assert.match(action,/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u,action);
 assert.match(workflow,/NODE_OPTIONS: --import=\$\{\{ github\.workspace \}\}\/backend\/test-support\/no-paid-api\.mjs/u);
 assert.match(workflow,/wrangler deploy --dry-run/u);assert.match(workflow,/services\/pdf-layout\/smoke\.mjs/u);
 const composeImage=/^ {4}image: (hoa-tri-pdf-layout:\S+)$/mu.exec(read('deploy/pdf-layout/docker-compose.yml'))?.[1];
 assert.ok(composeImage&&workflow.includes(`tags: ${composeImage}`),'CI tags its build as docker-compose.yml names the image, so compose runs that build');
 // CI fails when a Python-backed test skips, recognising them by this phrase in the skip reason.
 assert.match(workflow,/grep -n 'needs Python'/u);
 for(const file of readdirSync(new URL('./',import.meta.url)).filter(name=>name.endsWith('.test.mjs')&&name!=='config.test.mjs')){
  const text=read(`backend/${file}`);
  if(text.includes('.runtime/pdf-python')&&/\bskip\b/u.test(text))assert.match(text,/needs Python/u,`${file}: its skip reason must say "needs Python" for the CI gate`);
 }
});

test('CI tests and checks the PDF service with its production font, Liberation Serif',()=>{
 const workflow=read('.github/workflows/ci.yml').replace(/\r\n/gu,'\n');
 const testJob=/^ {2}test:\n([\s\S]*?)^ {2}pdf-image:/mu.exec(workflow)?.[1]||'',imageJob=workflow.slice(workflow.indexOf('\n  pdf-image:'));
 assert.match(testJob,/apt-get install[^\n]*\bfonts-liberation2\b/u,'the engine tests render with the image\'s font');
 assert.match(testJob,/fontPath\(\)[\s\S]*?case "\$font" in \*\/LiberationSerif-Regular\.ttf\)/u,'and fail when the engine would pick another one');
 assert.match(testJob,/case "\$font" in [^\n]*\n\s*test -f "\$font" \|\| \{[^\n]*exit 1; \}/u,'or when the file is not there');
 assert.doesNotMatch(testJob,/DejaVu Serif is the PDF font/u);
 assert.match(imageJob,/grep -qF '"font":"LiberationSerif-Regular\.ttf"'/u,'the built image reports Liberation Serif on /health');
});

test('Settings the Worker and the PDF service share are declared where they are read, at the defaults the code uses',async()=>{
 const {slotCount}=await import('./pdf-slots.js'),{REGISTRATIONS_PER_NETWORK}=await import('./reader-auth.js'),{jobLimit}=await import('../services/pdf-layout/server.mjs');
 const vars=config.vars||{},compose=read('deploy/pdf-layout/docker-compose.yml'),env=read('deploy/pdf-layout/env.example').replace(/\r\n/gu,'\n');
 // Visible in wrangler.jsonc, at the values the code falls back to; the layout hash is never kept there.
 assert.equal(vars.PDF_LAYOUT_SLOTS,'2');assert.equal(slotCount(vars),slotCount({}));
 assert.equal(vars.DAILY_REGISTRATIONS_PER_IP,String(REGISTRATIONS_PER_NETWORK));
 assert.ok(!Object.hasOwn(vars,'PDF_LAYOUT_VERSION'),'npm run deploy passes PDF_LAYOUT_VERSION itself');
 // One service job per Worker slot.
 assert.equal(Number(/PDF_LAYOUT_JOBS: \$\{PDF_LAYOUT_JOBS:-(\d+)\}/u.exec(compose)?.[1]),slotCount(vars));assert.equal(jobLimit(undefined),slotCount(vars));
 // The extraction time budget reaches the container, at extract.py's default and below the engine's hard stop.
 const budget=Number(/^ +PDF_EXTRACT_SECONDS: \$\{PDF_EXTRACT_SECONDS:-(\d+)\}$/mu.exec(compose)?.[1]);
 const fallback=Number(/os\.getenv\("PDF_EXTRACT_SECONDS"\)(?: or |,\s*)(\d+)/u.exec(read('services/pdf-layout/extract.py'))?.[1]),stop=Number(/TIMEOUT_MS=(\d+)/u.exec(read('services/pdf-layout/engine.mjs'))?.[1])/1000;
 assert.equal(budget,fallback);assert.ok(budget>0&&budget<stop,`${budget} s, stopped at ${stop} s`);assert.match(env,/^# PDF_EXTRACT_SECONDS=170$/mu);
 // PDF_LAYOUT_SLOTS belongs to the Worker (wrangler.jsonc), not to the service's .env.
 assert.match(env,/PDF_LAYOUT_SLOTS, biến của Worker chứ không phải của tệp này: sửa nó trong khối "vars" của\n# wrangler\.jsonc ở repo rồi chạy npm run deploy\./u);
 assert.doesNotMatch(env,/^#? ?PDF_LAYOUT_SLOTS=/mu);
});

test('PDF service deployment: HTTPS proxy with long timeouts and a large body limit, no published service port',()=>{
 const caddy=read('deploy/pdf-layout/Caddyfile'),compose=read('deploy/pdf-layout/docker-compose.yml');
 assert.ok(Number(/response_header_timeout\s+(\d+)s/u.exec(caddy)?.[1])>=300,'one job can take up to 280 s');
 assert.ok(Number(/max_size\s+(\d+)MB/u.exec(caddy)?.[1])>=45,'the /extract and /render bodies reach about 40 MiB');
 assert.match(caddy,/keepalive off/u);
 const service=/^ {2}pdf-layout:\n([\s\S]*?)^ {2}caddy:/mu.exec(compose.replace(/\r\n/gu,'\n'))?.[1]||'';
 assert.match(service,/dockerfile: services\/pdf-layout\/Dockerfile/u);
 assert.doesNotMatch(service,/^\s+ports:/mu,'only Caddy may publish ports');
 for(const option of ['init: true','shm_size: 1gb','- ALL','no-new-privileges:true','condition: service_healthy'])assert.ok(compose.includes(option),option);
 assert.match(compose,/image: caddy:\d+\.\d+\.\d+-alpine/u,'pin the Caddy release');
 assert.match(compose,/PDF_LAYOUT_SERVICE_TOKEN: \$\{PDF_LAYOUT_SERVICE_TOKEN:\?/u);
});

test('Caddy forwards every route of the PDF service, including each operation the Worker calls',()=>{
 const caddy=read('deploy/pdf-layout/Caddyfile'),server=read('services/pdf-layout/server.mjs'),worker=read('backend/pdf-layout.js');
 const proxied=(/@service path ([^\r\n]+)/u.exec(caddy)?.[1]||'').trim().split(/\s+/u).sort();
 const served=[...server.matchAll(/req\.url==='(\/[\w-]+)'/gu)].map(match=>match[1]);
 for(const [,list] of server.matchAll(/\[([^\]]+)\]\.includes\(req\.url\)/gu))served.push(...[...list.matchAll(/'(\/[\w-]+)'/gu)].map(match=>match[1]));
 const called=[...new Set([...worker.matchAll(/service\(env,'([\w-]+)'/gu)].map(match=>`/${match[1]}`))];
 assert.deepEqual([...new Set(served)].sort(),proxied,'Caddy answers 404 for any service route it does not list');
 assert.ok(called.length>=3&&called.every(path=>proxied.includes(path)),`the Worker calls ${called.join(', ')}`);
});

test('PDF service image: exact Node release, non-root, a health check, the tested OCR data and every file it imports',()=>{
 const docker=read('services/pdf-layout/Dockerfile'),lines=docker.split(/\r?\n/u).filter(line=>line.trim()&&!line.trimStart().startsWith('#'));
 assert.match(docker,/^FROM node:\d+\.\d+\.\d+-bookworm-slim(@sha256:[0-9a-f]{64})?$/mu,'an exact Node release, not a moving tag');
 const user=lines.findIndex(line=>/^USER node$/u.test(line.trim())),cmd=lines.findIndex(line=>line.startsWith('CMD '));
 assert.ok(user>0&&user<cmd,'the service runs as the node user');
 assert.match(docker,/^HEALTHCHECK .*\/health.*PDF_LAYOUT_SERVICE_TOKEN/mu);
 assert.ok(!lines.some(line=>/tesseract-ocr/u.test(line)),'MuPDF brings its own Tesseract; Debian models differ from the tested ones');
 assert.match(docker,/npm ci --omit=dev --ignore-scripts/u);
 // The OCR language data npm test and npm run setup use is what backend/vendor.mjs copies.
 const vendored=[...read('backend/vendor.mjs').matchAll(/@tesseract\.js-data\/(\w+)\/([\w.]+)\//gu)].map(match=>({lang:match[1],version:match[2]}));
 assert.deepEqual(vendored.map(item=>item.lang).sort(),(/for lang in ([\w ]+); do/u.exec(docker)?.[1]||'').trim().split(/\s+/u).sort());
 for(const {version} of vendored)assert.ok(docker.includes(`@tesseract.js-data/$lang/${version}/`),version);
 // server.mjs loads files outside its folder; each must be copied, or the image fails on its first request.
 const copied=lines.filter(line=>line.startsWith('COPY ')).map(line=>line.trim().split(/\s+/u)[1].replace(/\/$/u,''));
 const seen=new Set(),queue=['services/pdf-layout/server.mjs'];
 while(queue.length){
  const file=queue.shift();if(seen.has(file))continue;seen.add(file);
  for(const [,spec] of read(file).matchAll(/(?:\bfrom|\bimport\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu))queue.push(posix.normalize(posix.join(posix.dirname(file),spec)));
 }
 const outside=[...seen].filter(file=>!file.startsWith('services/pdf-layout/'));
 assert.ok(outside.includes('frontend/pdf-box-layout.js'),[...seen].join(', '));
 for(const file of outside)assert.ok(copied.some(source=>file===source||file.startsWith(`${source}/`)),`${file} is imported by the service but not copied into the image`);
});

test('The smoke test translates with stand-in Vietnamese that keeps every formula token',async()=>{
 const {standInTranslation,hanCount}=await import('../services/pdf-layout/smoke.mjs');
 assert.equal(standInTranslation({source:'向量的长度 @@PDF_INLINE_1@@。（见图）',inlines:[{token:'@@PDF_INLINE_1@@'}]}),'Vectơ @@PDF_INLINE_1@@. (Vectơ)');
 assert.equal(standInTranslation({source:'',inlines:[{token:'@@PDF_INLINE_2@@'}]}),'Vectơ @@PDF_INLINE_2@@');
 assert.equal(hanCount('第二节 平行 a//b'),5);
});

test('frontend/_headers: when a Content-Security-Policy exists it forbids inline scripts, plugins and framing',()=>{
 const csp=read('frontend/_headers').split(/\r?\n/u).map(line=>/^\s*Content-Security-Policy(?:-Report-Only)?:\s*(.+)$/iu.exec(line)?.[1]).filter(Boolean);
 for(const policy of csp){
  const directive=name=>policy.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name} `))||'';
  assert.doesNotMatch(directive('script-src'),/'unsafe-inline'/u);
  assert.match(directive('object-src'),/'none'/u);
  assert.match(directive('frame-ancestors'),/'none'|'self'/u);
 }
});

test('The paid-API guard of the tests blocks Google and Cloudflare APIs but not local servers',async()=>{
 const {blockedHost}=await import('./test-support/no-paid-api.mjs');
 assert.equal(blockedHost('https://generativelanguage.googleapis.com/v1beta/models'),'generativelanguage.googleapis.com');
 assert.equal(blockedHost(new URL('https://oauth2.googleapis.com/token')),'oauth2.googleapis.com');
 assert.equal(blockedHost(new Request('https://accounts.google.com/o/oauth2/v2/auth')),'accounts.google.com');
 assert.equal(blockedHost('https://api.cloudflare.com/client/v4/accounts'),'api.cloudflare.com');
 for(const allowed of ['http://127.0.0.1:8091/health','https://fakegoogleapis.com/','not a url'])assert.equal(blockedHost(allowed),null,allowed);
 await assert.rejects(fetch('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',{method:'POST'}),/no-paid-api: a test tried to call generativelanguage\.googleapis\.com/u);
 const server=createServer((request,response)=>response.end('ok'));await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(),'ok');}finally{server.close();}
});
