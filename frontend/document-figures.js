// Local, conservative figure extraction. A caption alone is not evidence of an
// image: a crop also needs substantial connected ink outside OCR body text.
// Uncaptioned/uncertain diagrams remain available in the complete source page.
const CAPTION=/^(?:图|圖|fig(?:ure)?\.?|hình)\s*\d+(?:\s*[.．·\-–—－]\s*\d+)*(?:\s*[（(][a-z\d一二三四五六七八九]+[）)])?\s*$/iu;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const overlaps=(a,b)=>a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y;
const union=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)});
function pixelBox(box,width,height){
 if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0)return null;
 const x=clamp(Math.floor(box.x*width),0,width),y=clamp(Math.floor(box.y*height),0,height),right=clamp(Math.ceil((box.x+box.width)*width),0,width),bottom=clamp(Math.ceil((box.y+box.height)*height),0,height);
 return right>x&&bottom>y?{x,y,right,bottom}:null;
}
const expand=(box,x,y,width,height)=>({x:clamp(box.x-x,0,width),y:clamp(box.y-y,0,height),right:clamp(box.right+x,0,width),bottom:clamp(box.bottom+y,0,height)});

function connectedInk(ink,width,height){
 const found=[],queue=new Int32Array(width*height);
 for(let start=0;start<ink.length;start++){
  if(!ink[start])continue;
  let head=0,tail=1,count=0,minX=width,minY=height,maxX=0,maxY=0;queue[0]=start;ink[start]=0;
  while(head<tail){
   const index=queue[head++],x=index%width,y=Math.floor(index/width);count++;
   minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
   // A one-pixel bridge tolerates antialiasing and small scan gaps without
   // merging normal words into a diagram-size connected component.
   for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
    const next=ny*width+nx;if(ink[next]){ink[next]=0;queue[tail++]=next;}
   }
  }
  if(count>=3)found.push({x:minX,y:minY,right:maxX+1,bottom:maxY+1,count});
 }
 return found;
}

/** Return normalized source-image regions; never synthesizes diagram pixels. */
export function detectDocumentFigures(image,layout){
 const sourceWidth=Number(image?.width),sourceHeight=Number(image?.height),data=image?.data;
 if(!Number.isInteger(sourceWidth)||!Number.isInteger(sourceHeight)||sourceWidth<1||sourceHeight<1||!data||data.length<sourceWidth*sourceHeight*4)return [];
 // Analysis is bounded on high resolution scans. Cropping still uses the full
 // resolution original bitmap below, not these analysis pixels.
 const scale=Math.min(1,1100/sourceWidth,1600/sourceHeight),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));
 const blocks=(layout?.blocks||[]).map(block=>({...block,text:String(block.text||'').trim(),rect:pixelBox(block.box,width,height)})).filter(block=>block.rect);
 const captions=blocks.filter(block=>CAPTION.test(block.text));
 if(!captions.length)return [];
 const ink=new Uint8Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const sx=Math.min(sourceWidth-1,Math.floor(x*sourceWidth/width)),sy=Math.min(sourceHeight-1,Math.floor(y*sourceHeight/height)),i=(sy*sourceWidth+sx)*4;
  // Dark coloured lines count, while pale paper tint and transparent pixels do
  // not. A light label is retained in the original crop even if not segmented.
  if(data[i+3]>100&&.299*data[i]+.587*data[i+1]+.114*data[i+2]<185)ink[y*width+x]=1;
 }
 const bodies=blocks.filter(block=>!CAPTION.test(block.text)&&(block.text.replace(/\s/gu,'').length>7||block.rect.right-block.rect.x>width*.18));
 // Point names (A, B, O, etc.) remain part of the image. Captions are removed
 // only from detection, then included untouched in the final source crop.
 for(const block of [...bodies,...captions]){
  const rect=expand(block.rect,2,2,width,height);
  for(let y=rect.y;y<rect.bottom;y++)ink.fill(0,y*width+rect.x,y*width+rect.right);
 }
 const components=connectedInk(ink,width,height),figures=[];
 for(const caption of captions){
  const cap=caption.rect,cx=(cap.x+cap.right)/2;
  let region={x:Math.floor(width*.035),right:Math.ceil(width*.965),y:Math.max(0,cap.y-height*.27),bottom:cap.y};
  // A body line directly above the caption bounds its illustration vertically.
  for(const block of bodies){const r=block.rect;if(r.x<cap.right&&r.right>cap.x&&r.bottom<=cap.y-height*.012)region.y=Math.max(region.y,r.bottom+2);}
  // Captions on the same row belong to separate illustrations.
  for(const other of captions){
   if(other===caption)continue;
   const r=other.rect,otherCx=(r.x+r.right)/2;
   if(Math.abs(r.y-cap.y)<height*.026){if(otherCx<cx)region.x=Math.max(region.x,(otherCx+cx)/2);else region.right=Math.min(region.right,(otherCx+cx)/2);}
   else if(r.bottom<cap.y&&Math.abs(otherCx-cx)<width*.12)region.y=Math.max(region.y,r.bottom+2);
  }
  // Text wrapping beside a figure provides its horizontal boundary. Only
  // lines in the lower part are used, so a paragraph above cannot trim it.
  const lowerBand={...region,y:Math.max(region.y,cap.y-height*.12)};
  for(const block of bodies){const r=block.rect;if(!overlaps(r,lowerBand))continue;if(r.right<cx)region.x=Math.max(region.x,r.right+2);else if(r.x>cx)region.right=Math.min(region.right,r.x-2);}
  const contained=components.filter(c=>c.x>=region.x&&c.right<=region.right&&c.y>=region.y&&c.bottom<=region.bottom+2);
  const seeds=contained.filter(c=>{
   const w=c.right-c.x,h=c.bottom-c.y;
   return c.count>=Math.max(20,width*.035)&&(w>=width*.05||h>=height*.035)&&w>=width*.012&&h>=height*.008&&c.count/(w*h)<.65;
  });
  if(!seeds.length)continue;
  // Require diagram ink close to the caption, preventing a remote equation or
  // ornamental rule from being paired across an empty region.
  if(!seeds.some(c=>cap.y-c.bottom<height*.07&&c.x<cap.right+width*.12&&c.right>cap.x-width*.12))continue;
  let figure=seeds.reduce((box,c)=>union(box,c),seeds[0]);
  for(let pass=0;pass<3;pass++){
   const nearby=expand(figure,width*.018,height*.012,width,height);
   for(const c of contained)if(overlaps(c,nearby))figure=union(figure,c);
  }
  // Include all short OCR labels around the ink, including coloured or faint
  // point labels below the detection threshold. Do not include body paragraphs.
  const labelArea=expand(figure,width*.018,height*.012,width,height);
  for(const block of blocks)if(!bodies.includes(block)&&!captions.includes(block)&&overlaps(block.rect,labelArea)&&block.rect.x>=region.x&&block.rect.right<=region.right&&block.rect.y>=region.y&&block.rect.bottom<=cap.y)figure=union(figure,block.rect);
  figure=union(figure,cap);
  const padded=expand(figure,Math.max(4,width*.006),Math.max(4,height*.004),width,height);
  // Do not return a crop that clips a neighbouring paragraph into the figure.
  if(bodies.some(block=>overlaps(block.rect,padded)))continue;
  const box={x:padded.x/width,y:padded.y/height,width:(padded.right-padded.x)/width,height:(padded.bottom-padded.y)/height};
  if(box.width>.9||box.height>.32)continue;
  figures.push({box,caption:caption.text});
 }
 return figures.sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
}

/** Crop original pixels to PNG; callers own any object URLs they create. */
export async function extractPageFigures(blob,layout){
 if(!blob||!layout?.blocks?.length||typeof createImageBitmap!=='function')return [];
 const bitmap=await createImageBitmap(blob);
 try{
  const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(bitmap.width,bitmap.height):Object.assign(document.createElement('canvas'),{width:bitmap.width,height:bitmap.height});
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return [];
  context.drawImage(bitmap,0,0);
  const regions=detectDocumentFigures(context.getImageData(0,0,bitmap.width,bitmap.height),layout),result=[];
  for(const region of regions){
   const x=Math.max(0,Math.floor(region.box.x*bitmap.width)),y=Math.max(0,Math.floor(region.box.y*bitmap.height)),right=Math.min(bitmap.width,Math.ceil((region.box.x+region.box.width)*bitmap.width)),bottom=Math.min(bitmap.height,Math.ceil((region.box.y+region.box.height)*bitmap.height));
   const crop=typeof OffscreenCanvas==='function'?new OffscreenCanvas(right-x,bottom-y):Object.assign(document.createElement('canvas'),{width:right-x,height:bottom-y});
   crop.getContext('2d').drawImage(bitmap,x,y,right-x,bottom-y,0,0,right-x,bottom-y);
   const cropped=typeof crop.convertToBlob==='function'?await crop.convertToBlob({type:'image/png'}):await new Promise(resolve=>crop.toBlob(resolve,'image/png'));
   if(cropped)result.push({box:{x:x/bitmap.width,y:y/bitmap.height,width:(right-x)/bitmap.width,height:(bottom-y)/bitmap.height},blob:cropped,caption:region.caption});
  }
  return result;
 }finally{bitmap.close();}
}
