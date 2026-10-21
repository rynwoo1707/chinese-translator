// The HTML pages, robots.txt and sitemap.xml. The Worker serves them (run_worker_first in wrangler.jsonc) so that every
// absolute URL (canonical, og:url, og:image, the sitemap) names the origin the request came to: no domain is written
// anywhere, and a custom domain describes itself as soon as it is attached. Everything else is a file from frontend/.
import {isSampleBook} from './library-books.js';
import {isLoopback} from './http.js';

export const PAGES=['/','/study','/dieu-khoan','/quyen-rieng-tu'];
export const SHARE_IMAGE={path:'/og-hoa-tri.png',width:1200,height:630,alt:'Hoa Trí: trang nguyên tác tiếng Trung đặt cạnh bản dịch tiếng Việt cùng bố cục'};
const STORY_ID=/^[\w-]{8,64}$/u;
export const isAdminPath=path=>path==='/admin'||path.startsWith('/admin/');
const escapeHtml=text=>String(text).replace(/[&<>"']/gu,char=>`&#${char.charCodeAt(0)};`);

export const sitemapXml=origin=>`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map(path=>` <url><loc>${escapeHtml(origin+path)}</loc></url>`).join('\n')}\n</urlset>\n`;
// robots.txt keeps "Sitemap: /sitemap.xml" in the file; crawlers need the absolute URL.
export const robotsText=(text,origin)=>String(text).replace(/^Sitemap:[ \t]*(\/\S*)[ \t]*$/gmu,(line,path)=>`Sitemap: ${origin}${path}`);

// A book /?read=<id> opens whose title may name the link preview: public and not a sample (samples stay local).
export async function sharedBook(env,id){
 if(!STORY_ID.test(String(id||''))||!env?.DB)return null;
 try{
  const story=await env.DB.prepare('SELECT id,title,visibility,source_url FROM stories WHERE id=?').bind(id).first(),title=String(story?.title||'').replace(/\s+/gu,' ').trim().slice(0,200);
  return story&&story.visibility==='public'&&!isSampleBook(story)&&title?{id:story.id,title}:null;
 }catch{return null;}
}

// What the Worker puts into a page's <head>, and which static tags it replaces. kind: 'page', 'read' (/?read=…, not
// indexed: its preview names the book when sharedBook found one) or 'admin' (not indexed, no preview tags).
export function headChanges({origin,path,kind='page',book=null}){
 const remove=['link[rel="canonical"]','meta[property="og:url"]','meta[property^="og:image"]','meta[name="robots"]','script[type="application/ld+json"]'];
 if(kind==='admin')return {remove,title:null,append:'<meta name="robots" content="noindex, nofollow">'};
 const url=book?`${origin}/?read=${encodeURIComponent(book.id)}`:origin+path,tags=[];
 if(kind==='page')tags.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
 tags.push(`<meta property="og:url" content="${escapeHtml(url)}">`,`<meta property="og:image" content="${escapeHtml(origin+SHARE_IMAGE.path)}">`,`<meta property="og:image:width" content="${SHARE_IMAGE.width}">`,`<meta property="og:image:height" content="${SHARE_IMAGE.height}">`,`<meta property="og:image:alt" content="${escapeHtml(SHARE_IMAGE.alt)}">`);
 let title=null;
 if(book){title=`${book.title} — Hoa Trí`;remove.push('meta[property="og:title"]','meta[name="twitter:title"]');tags.push(`<meta property="og:title" content="${escapeHtml(title)}">`,`<meta name="twitter:title" content="${escapeHtml(title)}">`);}
 if(kind==='read')tags.push('<meta name="robots" content="noindex">');
 // Inside <script> only "<" could end the element early; JSON keeps its meaning with \u003c.
 if(kind==='page'&&path==='/')tags.push(`<script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'WebSite',name:'Hoa Trí',url:`${origin}/`,inLanguage:'vi'}).replace(/</gu,'\\u003c')}</script>`);
 return {remove,title,append:tags.join('')};
}

function rewrite(response,{remove,title,append}){
 const rewriter=new HTMLRewriter();
 for(const selector of remove)rewriter.on(selector,{element(element){element.remove();}});
 if(title)rewriter.on('title',{element(element){element.setInnerContent(title);}});
 rewriter.on('head',{element(element){element.append(append,{html:true});}});
 return rewriter.transform(response);
}
// A page served over HTTPS on a real host tells the browser to use HTTPS only (half a year; *.workers.dev is preloaded
// anyway). The http:// side of a custom domain is redirected by Cloudflare's "Always Use HTTPS" (ONBOARDING 5.3).
export const transportSecurity=url=>url.protocol==='https:'&&!isLoopback(url.hostname)?{'Strict-Transport-Security':'max-age=15552000'}:{};
function withHeaders(response,headers){const copy=new Response(response.body,response);for(const [name,value] of Object.entries(headers))value===null?copy.headers.delete(name):copy.headers.set(name,value);return copy;}

export async function sitePage(request,env,url){
 const path=url.pathname,method=request.method;
 if(path==='/sitemap.xml')return new Response(method==='HEAD'?null:sitemapXml(url.origin),{headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'}});
 if(path==='/robots.txt'){
  const file=await env.ASSETS.fetch(request);if(file.status!==200||method!=='GET')return file;
  const headers=new Headers(file.headers);headers.delete('Content-Length');headers.delete('ETag');
  return new Response(robotsText(await file.text(),url.origin),{status:200,headers});
 }
 const admin=isAdminPath(path),read=path==='/'&&url.searchParams.has('read');
 if(!admin&&!PAGES.includes(path))return env.ASSETS.fetch(request);
 // /?read=… always gets a fresh body: its preview depends on the book, not only on index.html.
 const headers=new Headers(request.headers);if(read){headers.delete('If-None-Match');headers.delete('If-Modified-Since');}
 const [book,response]=await Promise.all([read&&method==='GET'?sharedBook(env,url.searchParams.get('read')):null,env.ASSETS.fetch(new Request(admin?new URL('/',url):url,{method,headers}))]);
 const robots=admin?{'X-Robots-Tag':'noindex, nofollow'}:read?{'X-Robots-Tag':'noindex',ETag:null,'Cache-Control':'no-cache'}:{};
 if(method!=='GET'||response.status!==200||!/^text\/html/iu.test(response.headers.get('Content-Type')||''))return withHeaders(response,robots);
 return withHeaders(rewrite(response,headChanges({origin:url.origin,path,kind:admin?'admin':read?'read':'page',book})),{...robots,...transportSecurity(url),'Content-Length':null});
}
