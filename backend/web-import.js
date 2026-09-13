import {parseDocument} from 'htmlparser2';
import {PREVIEW_LIMIT} from './text-storage.js';

const SOURCE_HOSTS=new Set(['truyenxin.top','www.truyenxin.top']);
const COVER_HOSTS=new Set(['truyenxin.top','www.truyenxin.top','blogger.googleusercontent.com','blogspot.com']);
const MAX_SERIES=30;
const MAX_CHAPTERS=150;
const GENRES=new Set(['Tu tiên','Tiên hiệp','Kiếm hiệp','Ngôn tình','Lịch sử · Cổ văn','Hiện đại','Khác']);

function clean(value,max=300){return String(value||'').replace(/\s+/g,' ').trim().slice(0,max);}
function sourceLabel(value){
 let url;try{url=new URL(value);}catch{throw new Error('Đường dẫn nguồn không hợp lệ.');}
 if(url.protocol!=='https:'||!SOURCE_HOSTS.has(url.hostname.toLowerCase()))throw new Error('Hiện chỉ hỗ trợ đường dẫn HTTPS từ TruyenXin.top.');
 const match=decodeURIComponent(url.pathname).match(/^\/search\/label\/([^/]+)\/?$/i);
 if(!match)throw new Error('Hãy dùng đường dẫn danh mục hoặc danh sách chương trên TruyenXin.top.');
 return clean(match[1],80);
}
function feedUrl(label,summary=false,max=MAX_CHAPTERS){return `https://www.truyenxin.top/feeds/posts/${summary?'summary':'default'}/-/${encodeURIComponent(label)}?alt=json&max-results=${max}&orderby=published`;}
async function fetchJson(url){
 const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Cat-Hien-Importer/1.0'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Trang nguồn trả lỗi ${response.status}.`);
 return response.json();
}
function entryLink(entry){return entry?.link?.find(link=>link.rel==='alternate')?.href||'';}
function entryDate(entry){return Date.parse(entry?.published?.$t||entry?.updated?.$t||'')||0;}
function chapterNumber(title,fallback){const match=String(title||'').match(/(?:chương|chuong|phần|phan|tập|tap|kỳ|ky)\s*(\d+)/i);return match?Number(match[1]):fallback;}
function cleanSeriesTitle(title){
 return clean(title,200).replace(/\s*(?:[-–—|:]\s*)?(?:chương|chuong|phần|phan|tập|tap|kỳ|ky)\s*\d+[\s\S]*$/i,'').trim()||clean(title,200);
}
function imageFromEntry(entry){
 const media=entry?.media$thumbnail?.url;if(media)return media.replace(/\/s\d+(?:-c)?\//,'/s1200/');
 const html=entry?.content?.$t||entry?.summary?.$t||'';const match=html.match(/<img[^>]+src=["']([^"']+)/i);return match?.[1]?.replace(/&amp;/g,'&')||'';
}
function htmlToText(html){
 const root=parseDocument(String(html||''),{decodeEntities:true});const blocks=new Set(['p','div','br','li','h1','h2','h3','h4','blockquote']);
 function walk(node){
  if(node.type==='script'||node.type==='style'||['script','style','noscript','iframe','svg','button'].includes(node.name))return '';
  if(node.type==='text')return node.data;
  const body=(node.children||[]).map(walk).join('');return blocks.has(node.name)?`\n${body}\n`:body;
 }
 return (root.children||[]).map(walk).join('').replace(/\u00a0/g,' ').replace(/[ \t]{2,}/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function parseEntries(json,label){
 return (json?.feed?.entry||[]).map((entry,index)=>({
  title:clean(entry?.title?.$t||`Chương ${index+1}`,200),
  content:htmlToText(entry?.content?.$t||entry?.summary?.$t||''),
  source_url:entryLink(entry),published:entryDate(entry),cover_url:imageFromEntry(entry),
  order:chapterNumber(entry?.title?.$t,index+1)
 })).filter(chapter=>chapter.content&&chapter.source_url).sort((a,b)=>a.order-b.order||a.published-b.published);
}
async function loadSeries(label){
 if(!/^ax\d+$/i.test(label))throw new Error('Mã bộ truyện TruyenXin không hợp lệ.');
 const json=await fetchJson(feedUrl(label));const chapters=parseEntries(json,label);
 if(!chapters.length)throw new Error(`Không tìm thấy chương có nội dung trong ${label.toUpperCase()}.`);
 return {label:label.toLowerCase(),title:cleanSeriesTitle(chapters[0].title),cover_url:chapters[0].cover_url,chapters};
}
async function catalog(){
 const labels=Array.from({length:MAX_SERIES},(_,i)=>`ax${i+1}`);
 const results=await Promise.allSettled(labels.map(async label=>{
  const json=await fetchJson(feedUrl(label,true,1)),entry=json?.feed?.entry?.[0];if(!entry)return null;
  const total=Number(json.feed?.openSearch$totalResults?.$t)||1;
  return {label,title:cleanSeriesTitle(entry.title?.$t||label.toUpperCase()),chapters:total,url:`https://www.truyenxin.top/search/label/${label}`,cover_url:imageFromEntry(entry)};
 }));
 return results.flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]);
}
export async function previewWebSource(sourceUrl){
 const label=sourceLabel(sourceUrl);
 if(/^ax\d+$/i.test(label)){const series=await loadSeries(label);return {type:'series',series:{...series,chapters:series.chapters.map(({content,...chapter})=>({...chapter,characters:content.length}))}};}
 const normalized=label.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase();
 if(!normalized.includes('truyen tu tien'))throw new Error('Danh mục này chưa được hỗ trợ. Hiện có thể nhập Truyện Tu Tiên và các mã AX.');
 return {type:'catalog',series:await catalog()};
}
async function saveCover(env,url,storyId){
 if(!url)return null;let parsed;try{parsed=new URL(url);}catch{return null;}
 const host=parsed.hostname.toLowerCase();if(![...COVER_HOSTS].some(allowed=>host===allowed||host.endsWith(`.${allowed}`)))return null;
 const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)return null;
 const bytes=await response.arrayBuffer(),type=(response.headers.get('content-type')||'').split(';')[0];if(bytes.byteLength>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(type))return null;
 const key=`covers/${storyId}/${crypto.randomUUID()}`;await env.FILES.put(key,bytes,{httpMetadata:{contentType:type}});return key;
}
export async function importWebSeries(env,{source_url,label,title,author,genre,confirmed}){
 if(confirmed!==true)throw new Error('Bạn cần xác nhận quyền sử dụng nội dung trước khi nhập.');
 sourceLabel(source_url);label=clean(label,20).toLowerCase();const series=await loadSeries(label);
 const canonical=`https://www.truyenxin.top/search/label/${label}`;
 if(await env.DB.prepare('SELECT id FROM stories WHERE source_url=?').bind(canonical).first())throw new Error('Bộ truyện này đã được nhập vào Cát Hiên.');
 const storyId=crypto.randomUUID(),coverKey=await saveCover(env,series.cover_url,storyId);
 const storyTitle=clean(title||series.title,200),storyAuthor=clean(author||'Chưa cập nhật',120),storyGenre=clean(genre||'Tu tiên',80);
 if(!GENRES.has(storyGenre))throw new Error('Thể loại không hợp lệ.');
 const stored=[];
 try{
  for(const chapter of series.chapters){
   const id=crypto.randomUUID(),textKey=chapter.content.length>PREVIEW_LIMIT?`reader/${id}.txt`:null;
   if(textKey)await env.FILES.put(textKey,chapter.content,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
   stored.push({id,textKey,chapter});
  }
  await env.DB.prepare('INSERT INTO stories(id,title,author,genre,cover_key,source_url) VALUES(?,?,?,?,?,?)').bind(storyId,storyTitle,storyAuthor,storyGenre,coverKey,canonical).run();
  for(let i=0;i<stored.length;i+=40){await env.DB.batch(stored.slice(i,i+40).map(({id,textKey,chapter},offset)=>env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,source_url,position,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,storyId,chapter.title,textKey?chapter.content.slice(0,PREVIEW_LIMIT):chapter.content,textKey,'text/plain',chapter.source_url,i+offset+1,new Date(chapter.published||Date.now()+i+offset).toISOString())));}
  return {id:storyId,title:storyTitle,chapters:stored.length};
 }catch(error){if(coverKey)await env.FILES.delete(coverKey);for(const item of stored)if(item.textKey)await env.FILES.delete(item.textKey);await env.DB.prepare('DELETE FROM stories WHERE id=?').bind(storyId).run().catch(()=>{});throw error;}
}

export const webImportInternals={sourceLabel,cleanSeriesTitle,htmlToText,parseEntries};
