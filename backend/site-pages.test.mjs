import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import worker from './worker.js';
import {sitePage,headChanges,sitemapXml,robotsText,sharedBook,PAGES,SHARE_IMAGE} from './site-pages.js';
import {parseJsonc} from './deploy.mjs';

const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root),'utf8');
// A stand-in for workerd's HTMLRewriter, enough for what site-pages.js asks: tag and tag[attr="v"] / tag[attr^="v"]
// selectors; remove, setInnerContent (text) and append (HTML). Handlers run in the order they were registered, and
// appended HTML is never matched again, as with the real one (wrangler dev runs the real one: see the report).
class FakeRewriter{
 constructor(){this.handlers=[];}
 on(selector,handler){this.handlers.push([selector,handler]);return this;}
 transform(response){
  const handlers=this.handlers,escape=text=>text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
  const body=response.text().then(html=>{
   for(const [selector,{element}] of handlers){
    const [,name,attr,op,value]=/^(\w+)(?:\[([\w:-]+)(\^?=)"([^"]*)"\])?$/u.exec(selector),paired=['head','title','script'].includes(name);
    html=html.replace(new RegExp(paired?`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`:`<${name}\\b([^>]*)>`,'gu'),(whole,attrs,inner='')=>{
     const actual=attr&&new RegExp(`\\s${attr}="([^"]*)"`,'u').exec(attrs)?.[1];
     if(attr&&(actual==null||(op==='='?actual!==value:!actual.startsWith(value))))return whole;
     let out=whole;
     element({remove(){out='';},setInnerContent(text){out=`<${name}${attrs}>${escape(text)}</${name}>`;},append(content){out=`<${name}${attrs}>${inner}${content}</${name}>`;}});
     return out;
    });
   }
   return html;
  });
  return new Response(new ReadableStream({async start(controller){controller.enqueue(new TextEncoder().encode(await body));controller.close();}}),response);
 }
}
globalThis.HTMLRewriter??=FakeRewriter;

const FILES={'/':'frontend/index.html','/study':'frontend/study.html','/dieu-khoan':'frontend/dieu-khoan.html','/quyen-rieng-tu':'frontend/quyen-rieng-tu.html','/robots.txt':'frontend/robots.txt'};
// env.ASSETS as Workers static assets answers: the file with an ETag, 304 for a matching If-None-Match, 404.html else.
function assets(){
 const seen=[];
 return {seen,async fetch(request){
  const url=new URL(request.url),file=FILES[url.pathname];seen.push({path:url.pathname,search:url.search,ifNoneMatch:request.headers.get('If-None-Match')});
  const type=url.pathname.endsWith('.txt')?'text/plain; charset=utf-8':'text/html; charset=utf-8';
  if(!file)return new Response(request.method==='HEAD'?null:read('frontend/404.html'),{status:404,headers:{'Content-Type':'text/html; charset=utf-8'}});
  if(request.headers.get('If-None-Match')==='"v1"')return new Response(null,{status:304,headers:{ETag:'"v1"'}});
  return new Response(request.method==='HEAD'?null:read(file),{headers:{'Content-Type':type,ETag:'"v1"','Content-Security-Policy':"default-src 'self'"}});
 }};
}
const books={'b00k-public-1':{id:'b00k-public-1',title:'Sử ký "Tư Mã" <Thiên> & các truyện',visibility:'public',source_url:null},'b00k-sample-1':{id:'b00k-sample-1',title:'Sách mẫu còn bản quyền',visibility:'public',source_url:'sample:toan'},'b00k-private-1':{id:'b00k-private-1',title:'Sách riêng của học sinh',visibility:'private',source_url:null}};
const database=(fail=false)=>({prepare(){return {bind(id){return {async first(){if(fail)throw new Error('D1_ERROR: down');return books[id]||null;}};}};}});
const page=async(path,{origin='https://hoatri.example.vn',env={},init={}}={})=>{const response=await worker.fetch(new Request(origin+path,init),{ASSETS:assets(),DB:database(),...env},{});return {response,html:init.method==='HEAD'?'':await response.text()};};
const tag=(html,pattern)=>[...html.matchAll(pattern)].map(match=>match[1]);

test('Every page gets canonical, og:url and the share image from the origin it was requested on',async()=>{
 for(const origin of ['https://hoatri.example.vn','https://muc-viet-cms.owner.workers.dev','http://127.0.0.1:8787']){
  for(const path of PAGES){
   const {response,html}=await page(path,{origin});
   assert.equal(response.status,200,path);assert.equal(response.headers.get('X-Robots-Tag'),null,path);
   assert.deepEqual(tag(html,/<link rel="canonical" href="([^"]+)">/gu),[origin+path],path);
   assert.deepEqual(tag(html,/<meta property="og:url" content="([^"]+)">/gu),[origin+path],path);
   assert.deepEqual(tag(html,/<meta property="og:image" content="([^"]+)">/gu),[origin+SHARE_IMAGE.path],path);
   assert.match(html,/<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/u,path);
   assert.ok(html.indexOf('rel="canonical"')<html.indexOf('</head>'),'tags go into <head>');
   assert.equal(response.headers.get('Content-Security-Policy'),"default-src 'self'",'the asset headers (frontend/_headers) are kept');
   // HTTPS on a real host: the browser is told to use HTTPS only; plain http on this machine is not.
   assert.equal(response.headers.get('Strict-Transport-Security'),origin.startsWith('https:')?'max-age=15552000':null,`${origin}${path}`);
  }
 }
 // The WebSite data is on the home page only, with the absolute URL and the language.
 const {html}=await page('/');
 const data=tag(html,/<script type="application\/ld\+json">([^<]*)<\/script>/gu).map(JSON.parse);
 assert.deepEqual(data,[{'@context':'https://schema.org','@type':'WebSite',name:'Hoa Trí',url:'https://hoatri.example.vn/',inLanguage:'vi'}]);
 assert.doesNotMatch((await page('/study')).html,/application\/ld\+json/u);
});

test('No page hard-codes an origin: the static files carry no canonical, og:url, og:image or JSON-LD',()=>{
 for(const file of ['frontend/index.html','frontend/dieu-khoan.html','frontend/quyen-rieng-tu.html','frontend/404.html','frontend/study.html']){
  const html=read(file);
  assert.doesNotMatch(html,/rel="canonical"|property="og:url"|property="og:image|application\/ld\+json/u,`${file}: the Worker writes these from the request's origin`);
  assert.doesNotMatch(html,/content="https?:\/\/(?!schema\.org)/u,`${file}: no absolute URL in a meta tag`);
 }
});

test('/?read=<id> of a public library book names it in the preview; any ?read= page is not indexed',async()=>{
 const {response,html}=await page('/?read=b00k-public-1&phan=2',{init:{headers:{'If-None-Match':'"v1"'}}});
 assert.equal(response.status,200,'a stale cached copy is never reused: the preview depends on the book');
 assert.equal(response.headers.get('X-Robots-Tag'),'noindex');assert.equal(response.headers.get('Cache-Control'),'no-cache');assert.equal(response.headers.get('ETag'),null);
 const title='Sử ký &#34;Tư Mã&#34; &#60;Thiên&#62; &#38; các truyện — Hoa Trí';
 assert.deepEqual(tag(html,/<meta property="og:title" content="([^"]+)">/gu),[title]);
 assert.deepEqual(tag(html,/<meta name="twitter:title" content="([^"]+)">/gu),[title]);
 assert.deepEqual(tag(html,/<title>([^<]*)<\/title>/gu),['Sử ký "Tư Mã" &lt;Thiên&gt; &amp; các truyện — Hoa Trí']);
 assert.deepEqual(tag(html,/<meta property="og:url" content="([^"]+)">/gu),['https://hoatri.example.vn/?read=b00k-public-1']);
 assert.deepEqual(tag(html,/<meta property="og:image" content="([^"]+)">/gu),['https://hoatri.example.vn/og-hoa-tri.png'],'the generic image, never a cover or a page');
 assert.match(html,/<meta name="robots" content="noindex">/u);assert.doesNotMatch(html,/rel="canonical"|ld\+json/u);
 assert.doesNotMatch(html,/<Thiên>/u,'the title is escaped');
 // A sample (copyrighted, local-only), a private book, an unknown or malformed id, a failing database: the generic page.
 const generic=/<meta property="og:title" content="Hoa Trí — Dịch tiếng Trung sang tiếng Việt, giữ bố cục trang">/u;
 for(const [path,env] of [['/?read=b00k-sample-1',{}],['/?read=b00k-private-1',{}],['/?read=b00k-missing-1',{}],['/?read=%3Cscript%3E',{}],['/?read=',{}],['/?read=b00k-public-1',{DB:database(true)}],['/?read=b00k-public-1',{DB:undefined}]]){
  const result=await page(path,{env});
  assert.equal(result.response.status,200,path);assert.equal(result.response.headers.get('X-Robots-Tag'),'noindex',path);
  assert.match(result.html,generic,path);assert.doesNotMatch(result.html,/Sách mẫu|Sách riêng|Sử ký/u,path);
  assert.deepEqual(tag(result.html,/<meta property="og:url" content="([^"]+)">/gu),['https://hoatri.example.vn/'],path);
 }
 // Other query strings keep the home page indexable, canonical to "/".
 const tracked=await page('/?utm_source=zalo');assert.equal(tracked.response.headers.get('X-Robots-Tag'),null);assert.deepEqual(tag(tracked.html,/<link rel="canonical" href="([^"]+)">/gu),['https://hoatri.example.vn/']);
 assert.equal(await sharedBook({DB:database()},'b00k-public-1').then(book=>book.title),books['b00k-public-1'].title);
});

test('/admin and /admin/… are the app page, never indexed and without preview tags',async()=>{
 for(const path of ['/admin','/admin/','/admin/settings']){
  const env={ASSETS:assets()},response=await worker.fetch(new Request('https://hoatri.example.vn'+path),{...env,DB:database()},{}),html=await response.text();
  assert.equal(response.status,200,path);assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow',path);
  assert.match(html,/<script type="module" src="\/app\.js"><\/script>/u,`${path}: index.html (app.js reads location.pathname)`);
  assert.deepEqual(env.ASSETS.seen.map(item=>item.path),['/'],path);
  assert.match(html,/<meta name="robots" content="noindex, nofollow">/u);assert.doesNotMatch(html,/rel="canonical"|og:url|og:image|ld\+json/u,path);
 }
 assert.equal((await page('/administrator')).response.status,404,'only /admin and below');
});

test('Unknown paths are the 404 page; conditional and HEAD requests pass through',async()=>{
 for(const path of ['/khong-co-trang-nay','/favicon.png','/manifest.json','/study/extra']){const {response,html}=await page(path);assert.equal(response.status,404,path);assert.match(html,/Không tìm thấy trang này/u,path);}
 const cached=await page('/',{init:{headers:{'If-None-Match':'"v1"'}}});assert.equal(cached.response.status,304);
 const head=await page('/study',{init:{method:'HEAD'}});assert.equal(head.response.status,200);assert.equal(await head.response.text(),'');
});

test('sitemap.xml lists the public pages on the request origin; robots.txt points to it',async()=>{
 const {response,html}=await page('/sitemap.xml',{origin:'https://hoatri.example.vn'});
 assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/^application\/xml/u);
 assert.deepEqual(tag(html,/<loc>([^<]+)<\/loc>/gu),PAGES.map(path=>`https://hoatri.example.vn${path}`));
 assert.equal(sitemapXml('https://a.example'),sitemapXml('https://a.example'),'stable');assert.match(html,/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/u);
 const robots=await page('/robots.txt',{origin:'https://hoatri.example.vn'});
 assert.equal(robots.response.status,200);assert.match(robots.html,/^Sitemap: https:\/\/hoatri\.example\.vn\/sitemap\.xml$/mu);assert.match(robots.html,/^Disallow: \/api\/$/mu);
 assert.equal(robotsText('Sitemap: https://x.example/s.xml\n','https://y.example'),'Sitemap: https://x.example/s.xml\n','an absolute line stays');
});

test('wrangler.jsonc sends exactly these paths to the Worker and answers the rest with 404.html',()=>{
 const {assets:config}=parseJsonc(read('wrangler.jsonc'));
 assert.equal(config.not_found_handling,'404-page');assert.ok(existsSync(new URL('frontend/404.html',root)));
 assert.deepEqual(config.run_worker_first,['/api/*',...PAGES,'/admin','/admin/*','/robots.txt','/sitemap.xml']);
 for(const path of PAGES.slice(1))assert.ok(existsSync(new URL(`frontend${path}.html`,root)),path);
 assert.ok(existsSync(new URL(`frontend${SHARE_IMAGE.path}`,root)));
 // The page head changes never touch the static <title> of a normal page.
 assert.equal(headChanges({origin:'https://a.example',path:'/'}).title,null);
});
