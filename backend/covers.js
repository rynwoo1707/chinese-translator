// Book cover images, shared by the admin library and by students' own study books: the bytes decide the type, never
// the file name or the declared content type, so nothing but a real JPEG, PNG or WebP image is stored and served.
export function coverImageType(bytes){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),text=(from,to)=>new TextDecoder().decode(b.slice(from,to));
 if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if([137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v))return 'image/png';
 if(text(0,4)==='RIFF'&&text(8,12)==='WEBP')return 'image/webp';
 return null;
}
export async function saveCover(file,storyId,env){
 if(!file||typeof file==='string'||!file.size||file.size>5*1024*1024)throw new Error('Ảnh bìa phải từ 1 byte đến 5 MB.');
 const data=await file.arrayBuffer(),mime=coverImageType(data);if(!mime)throw new Error('Ảnh bìa phải là JPG, PNG hoặc WebP hợp lệ.');
 const key=`covers/${storyId}/${crypto.randomUUID()}`;await env.FILES.put(key,data,{httpMetadata:{contentType:mime}});return key;
}
