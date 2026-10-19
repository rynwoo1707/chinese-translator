// sample.json ranges -> the parts (chunks) the tool extracts, translates and publishes, one chapter each.
import {parseStudyPageRange} from '../../../frontend/study-pages.js';

// One extraction call takes at most 20 pages (extract.py selected_pages), so a longer range becomes several parts.
export const MAX_CHUNK_PAGES=20;
const runs=pages=>{const sorted=[...pages].sort((a,b)=>a-b),out=[];for(let i=0;i<sorted.length;i++){const start=sorted[i];while(sorted[i+1]===sorted[i]+1)i++;out.push([start,sorted[i]]);}return out;};
// Titles and messages: "5–9, 12". extract.py reads "5-9,12".
export const pageLabel=pages=>runs(pages).map(([a,b])=>a===b?String(a):`${a}–${b}`).join(', ');
export const pageArgument=pages=>runs(pages).map(([a,b])=>a===b?String(a):`${a}-${b}`).join(',');
export const chunkId=index=>`c${String(index+1).padStart(2,'0')}`;
export const chapterTitle=pages=>`Trang ${pageLabel(pages)}`;

// The cover stays the original artwork unless translateCover is set, as in the study workspace (excludeCover); a page
// may belong to one range only.
export function planChunks(ranges,total,{cover=0,translateCover=false,max=MAX_CHUNK_PAGES}={}){
 if(!Array.isArray(ranges)||!ranges.length)throw new Error('Chưa có phạm vi trang nào để dịch ("ranges" trong sample.json).');
 const owner=new Map(),chunks=[];let coverExcluded=false;
 for(const [index,range] of ranges.entries()){
  if(!String(range).trim())throw new Error('Có một phạm vi trang trống trong "ranges".');
  const pages=[...parseStudyPageRange(String(range).replace(/–/gu,'-'),total,Infinity)].sort((a,b)=>a-b),kept=pages.filter(page=>translateCover||page!==cover);
  if(kept.length<pages.length)coverExcluded=true;
  if(!kept.length)throw new Error(`Phạm vi "${range}" chỉ có trang bìa ${cover}: bìa giữ nguyên ảnh gốc. Thêm trang nội dung, hoặc đặt "translateCover": true.`);
  for(const page of kept){if(owner.has(page))throw new Error(`Trang ${page} nằm trong cả phạm vi "${ranges[owner.get(page)]}" và "${range}".`);owner.set(page,index);}
  for(let i=0;i<kept.length;i+=max)chunks.push({range:index,pages:kept.slice(i,i+max)});
 }
 return {chunks,coverExcluded};
}
