import {getPdfManifest} from './pdf-pipeline.js';

export async function savePreparedPdfPage(jobId,form,env){
 const page=Number(form.get('page')),total=Number(form.get('total'));
 if(!Number.isInteger(page)||!Number.isInteger(total)||page<1||page>total||total>1000)throw new Error('Thứ tự trang PDF không hợp lệ.');
 const text=form.get('text'),image=form.get('image');let key,mime,kind,data;
 if(typeof text==='string'){
  if(image||!text.trim()||new TextEncoder().encode(text).length>1024*1024)throw new Error('Lớp chữ của trang PDF không hợp lệ.');
  kind='text';mime='text/plain; charset=utf-8';key=`split/${jobId}/page-${String(page).padStart(5,'0')}.txt`;data=text;
 }else{
  if(!image||typeof image==='string'||!image.size||image.size>3*1024*1024)throw new Error('Ảnh trang phải nhỏ hơn 3 MB.');
  const bytes=new Uint8Array(await image.arrayBuffer());
  const webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!webp&&!jpeg)throw new Error('Trang PDF phải là WebP hoặc JPEG hợp lệ.');
  kind='scan';mime=webp?'image/webp':'image/jpeg';key=`split/${jobId}/page-${String(page).padStart(5,'0')}.${webp?'webp':'jpg'}`;data=bytes;
 }
 let manifest=await getPdfManifest(jobId,env);
 if(manifest&&manifest.kind!=='scan-images'&&manifest.kind!=='mixed-pages')throw new Error('PDF đã được chuẩn bị theo phương thức khác.');
 manifest??={version:3,kind:'mixed-pages',totalPages:total,pagesPerPart:1,parts:[],complete:false};
 if(manifest.totalPages!==total)throw new Error('Tổng số trang PDF đã thay đổi.');
 await env.FILES.put(key,data,{httpMetadata:{contentType:mime}});
 manifest.parts=manifest.parts.filter(part=>part.startPage!==page);
 manifest.parts.push({index:page-1,startPage:page,endPage:page,key,mime,kind});
 manifest.parts.sort((a,b)=>a.startPage-b.startPage);
 manifest.complete=manifest.parts.length===total&&manifest.parts.every((part,index)=>part.startPage===index+1);
 await env.FILES.put(`split/${jobId}/manifest.json`,JSON.stringify(manifest));
 return {ok:true,page,total,complete:manifest.complete};
}
