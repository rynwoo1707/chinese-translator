import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Self-hosted fonts (frontend/fonts): every face names a file that exists and whose name carries the start of its
// SHA-256, which is what makes "immutable" caching safe; the pages link fonts.css and preload the 400 latin face.
const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root),'utf8');
const css=read('frontend/fonts/fonts.css'),faces=[...css.matchAll(/@font-face\{([^}]+)\}/gu)].map(match=>match[1]);

test('Every @font-face file exists, is woff2 and is named by its content hash',()=>{
 assert.ok(faces.length>=10);
 const used=new Set();
 for(const face of faces){
  const file=/src:url\(([^)]+)\) format\('woff2'\)/u.exec(face)?.[1];assert.ok(file,face);used.add(file);
  const data=readFileSync(new URL(`frontend/fonts/${file}`,root));assert.equal(data.subarray(0,4).toString(),'wOF2',file);
  assert.equal(/\.([0-9a-f]{10})\.woff2$/u.exec(file)?.[1],createHash('sha256').update(data).digest('hex').slice(0,10),`${file}: the name must change with the content`);
  assert.match(face,/font-display:swap/u,file);
 }
 assert.deepEqual(readdirSync(new URL('frontend/fonts/',root)).filter(name=>name.endsWith('.woff2')).sort(),[...used].sort(),'no unused font file');
 assert.ok(existsSync(new URL('frontend/fonts/OFL.txt',root)),'the licence travels with the fonts');
 for(const family of ["'Be Vietnam Pro'","'Noto Serif'"])assert.ok(faces.some(face=>face.includes(`font-family:${family}`)),family);
});

test('The pages link fonts.css and preload the Be Vietnam Pro 400 latin face that fonts.css declares',()=>{
 const preload=/src:url\((be-vietnam-pro-400-latin\.[0-9a-f]{10}\.woff2)\)/u.exec(css)?.[1];assert.ok(preload);
 for(const page of ['index.html','dieu-khoan.html','quyen-rieng-tu.html','404.html']){
  const html=read(`frontend/${page}`);
  assert.ok(html.includes(`<link rel="preload" href="/fonts/${preload}" as="font" type="font/woff2" crossorigin>`),`${page}: preload`);
  assert.ok(html.includes('<link rel="stylesheet" href="/fonts/fonts.css">'),`${page}: fonts.css`);
  assert.ok(html.indexOf('/fonts/fonts.css')<html.indexOf('/style.css'),`${page}: fonts before the page styles`);
  assert.doesNotMatch(html,/fonts\.(googleapis|gstatic)\.com/u,page);
 }
});
