import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';

const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root),'utf8'),bytes=path=>readFileSync(new URL(path,root));
const OWNED=['frontend/index.html','frontend/dieu-khoan.html','frontend/quyen-rieng-tu.html','frontend/404.html'];
const meta=(html,key,name)=>new RegExp(`<meta ${key}="${name.replace(/\./gu,'\\.')}" content="([^"]*)">`,'u').exec(html)?.[1];
const png=path=>{const data=bytes(path);assert.equal(data.subarray(1,4).toString(),'PNG',path);return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};};

test('Each page has its own title and description, the preview tags and the theme colour',()=>{
 const titles=new Set();
 for(const file of OWNED){
  const html=read(file),title=/<title>([^<]+)<\/title>/u.exec(html)?.[1];
  assert.ok(title&&!titles.has(title),`${file}: a title of its own`);titles.add(title);assert.match(title,/Hoa Trí/u,file);
  assert.equal(meta(html,'name','theme-color'),'#faf9f3',file);
  if(file.endsWith('404.html')){assert.equal(meta(html,'name','robots'),'noindex',file);continue;}
  const description=meta(html,'name','description');assert.ok(description?.length>=60&&description.length<=170,`${file}: description of ${description?.length} characters`);
  assert.equal(meta(html,'property','og:title'),title,file);assert.equal(meta(html,'property','og:description'),description,file);
  for(const [key,name,value] of [['property','og:type','website'],['property','og:site_name','Hoa Trí'],['property','og:locale','vi_VN'],['name','twitter:card','summary_large_image']])assert.equal(meta(html,key,name),value,`${file}: ${name}`);
 }
 // The home page states the product: layout-keeping translation, the workspace, bilingual reading, character lookup.
 const index=read('frontend/index.html');
 assert.match(index,/<title>Hoa Trí — Dịch tiếng Trung sang tiếng Việt, giữ bố cục trang<\/title>/u);
 const description=meta(index,'name','description');for(const words of ['Xưởng dịch','bố cục trang','song ngữ','tra chữ Hán','học sinh và giáo viên'])assert.ok(description.includes(words),words);
});

test('Installable: manifest, icons rendered from favicon.svg, favicon.ico and the links in every head',()=>{
 const manifest=JSON.parse(read('frontend/manifest.webmanifest'));
 assert.equal(manifest.name,'Hoa Trí');assert.equal(manifest.short_name,'Hoa Trí');assert.equal(manifest.lang,'vi');assert.equal(manifest.start_url,'/');assert.equal(manifest.display,'standalone');
 assert.equal(manifest.background_color,'#faf9f3');assert.equal(manifest.theme_color,'#faf9f3');
 const icons=Object.fromEntries(manifest.icons.map(icon=>[`${icon.sizes} ${icon.purpose}`,icon.src]));
 assert.deepEqual(Object.keys(icons).sort(),['192x192 any','512x512 any','512x512 maskable']);
 for(const [key,src] of Object.entries(icons)){const size=Number(key.split('x')[0]);assert.deepEqual(png(`frontend${src}`),{width:size,height:size},src);}
 assert.deepEqual(png('frontend/icons/apple-touch-icon.png'),{width:180,height:180});
 // favicon.ico: an icon directory whose images are PNG.
 const ico=bytes('frontend/favicon.ico');assert.equal(ico.readUInt16LE(2),1);assert.ok(ico.readUInt16LE(4)>=1);
 for(let i=0;i<ico.readUInt16LE(4);i++){const offset=ico.readUInt32LE(6+16*i+12);assert.equal(ico.subarray(offset+1,offset+4).toString(),'PNG');}
 for(const file of OWNED){
  const html=read(file);
  for(const link of ['<link rel="manifest" href="/manifest.webmanifest">','<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">','<link rel="icon" href="/favicon.svg" type="image/svg+xml">','<link rel="icon" href="/favicon.ico" sizes="32x32">'])assert.ok(html.includes(link),`${file}: ${link}`);
 }
});

test('The share image is 1200 x 630 and its own work',()=>{
 assert.deepEqual(png('frontend/og-hoa-tri.png'),{width:1200,height:630});
 assert.ok(bytes('frontend/og-hoa-tri.png').length<400*1024,'small enough for chat apps');
});

test('404 page: the shared header and footer, a heading, ways back, no inline script',()=>{
 const html=read('frontend/404.html');
 assert.match(html,/^<!doctype html>\s*<html lang="vi">/u);assert.match(html,/<h1>Không tìm thấy trang này<\/h1>/u);
 assert.match(html,/<a class="primary-link" href="\/">Về Học liệu<\/a>/u);assert.match(html,/<a href="\/study">Mở Xưởng dịch<\/a>/u);
 assert.match(html,/<a class="header-request" href="\/#yeu-cau">/u);assert.match(html,/<a class="header-login" href="\/#account">Đăng nhập<\/a>/u);
 assert.match(html,/<footer class="site-footer" data-site-footer>[\s\S]*?<\/footer>/u);
 assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/u);assert.doesNotMatch(html,/\son[a-z]+=/u);
 // Served for any missing path, however deep: every URL in it is absolute.
 for(const [,url] of html.matchAll(/(?:href|src)="([^"#]+)"/gu))assert.match(url,/^(\/|https:\/\/)/u,url);
});

test('frontend/_headers: one CSP for the pages, the PaddleOCR worker its own, immutable fonts, revalidated fonts.css',()=>{
 const text=read('frontend/_headers').replace(/\r\n/gu,'\n'),rules={};let current=null;
 for(const line of text.split('\n')){
  if(!line.trim()||line.startsWith('#'))continue;
  if(!/^\s/u.test(line)){current=line.trim();rules[current]=[];continue;}
  rules[current].push(line.trim());
 }
 const policy=(rule)=>rules[rule].filter(line=>line.startsWith('Content-Security-Policy:')).map(line=>line.slice(24).trim());
 const [page]=policy('/*'),directives=Object.fromEntries(page.split(';').map(part=>part.trim().split(/\s+/u)).map(([name,...values])=>[name,values]));
 assert.deepEqual(directives['script-src'],["'self'","'wasm-unsafe-eval'"],'no inline or eval scripts in the pages');
 for(const [name,value] of [['default-src',"'self'"],['object-src',"'none'"],['base-uri',"'none'"],['form-action',"'self'"],['frame-ancestors',"'none'"]])assert.deepEqual(directives[name],[value],name);
 assert.deepEqual(directives['img-src'],["'self'",'data:','blob:','https://*.googleusercontent.com']);
 // Google's font hosts are allowed exactly while a stylesheet still imports them.
 const google=/fonts\.googleapis\.com/u.test(read('frontend/style.css')+read('frontend/study.css'));
 assert.equal(directives['style-src'].includes('https://fonts.googleapis.com'),google);assert.equal(directives['font-src'].includes('https://fonts.gstatic.com'),google);
 for(const header of ['X-Frame-Options: DENY','X-Content-Type-Options: nosniff','Referrer-Policy: no-referrer','Cross-Origin-Opener-Policy: same-origin'])assert.ok(rules['/*'].includes(header),header);
 assert.deepEqual(rules['/vendor/paddle/*'],['! Content-Security-Policy',"Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"]);
 assert.ok(Object.keys(rules).indexOf('/vendor/paddle/*')>Object.keys(rules).indexOf('/*'),'the worker policy replaces the page policy, so it comes after it');
 assert.deepEqual(rules['/fonts/*.woff2'],['Cache-Control: public, max-age=31536000, immutable']);
 assert.ok(!Object.keys(rules).some(rule=>rule==='/fonts/*'||rule.startsWith('/fonts/fonts')),'fonts.css keeps its URL, so it must be revalidated');
});

test('Static pages link /study, never /study.html, and reach the shared header script',()=>{
 for(const file of OWNED){const html=read(file);assert.doesNotMatch(html,/href="\/study\.html/u,file);if(!file.endsWith('index.html'))assert.match(html,/src="\/site-header\.js"/u,file);}
 assert.ok(existsSync(new URL('frontend/site-header.js',root)));
 const script=read('frontend/site-header.js');
 assert.doesNotMatch(script,/innerHTML/u,'names and picture URLs are set as text and attributes');assert.match(script,/referrerPolicy='no-referrer'/u);assert.match(script,/\^https:/u);
});

// Without these the browser finds each module only after the one importing it has arrived: on a 3G phone the page
// painted but became usable about a second later than it could (verification 2026-10, n=3: /study 4.9 s -> 3.2 s).
test('Each app page preloads exactly the static import graph of its script',()=>{
 const imports=file=>[...read(`frontend/${file}`).matchAll(/(?:^|[;\n}])\s*import\s*(?:[^'"()]*?\sfrom\s*)?['"]\.\/([^'"]+)['"]/gu)].map(match=>match[1]);
 const graph=entry=>{const seen=new Set();(function walk(file){for(const next of imports(file))if(!seen.has(next)){seen.add(next);walk(next);}})(entry);return [...seen].sort();};
 for(const [page,entry] of [['frontend/index.html','app.js'],['frontend/study.html','study.js']]){
  const preloaded=[...read(page).matchAll(/<link rel="modulepreload" href="\/([^"]+)">/gu)].map(match=>match[1]).sort();
  assert.deepEqual(preloaded,graph(entry),page);
  for(const file of preloaded)assert.ok(existsSync(new URL(`frontend/${file}`,root)),file);
 }
});
