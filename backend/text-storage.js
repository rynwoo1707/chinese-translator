// D1 holds a preview; full text lives in object storage when it grows large.
export const PREVIEW_LIMIT=20000;
export async function storeJobText(env,jobId,source,translation){
 const sourceKey=source.length>PREVIEW_LIMIT?`texts/${jobId}/source.txt`:null;
 const translationKey=translation.length>PREVIEW_LIMIT?`texts/${jobId}/translation.txt`:null;
 if(sourceKey)await env.FILES.put(sourceKey,source,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
 if(translationKey)await env.FILES.put(translationKey,translation,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
 return {source:sourceKey?source.slice(0,PREVIEW_LIMIT):source,translation:translationKey?translation.slice(0,PREVIEW_LIMIT):translation,sourceKey,translationKey};
}
export async function fullText(env,key,fallback){
 if(!key)return fallback;
 const file=await env.FILES.get(key);if(!file)throw new Error('Không tìm thấy nội dung đầy đủ của tài liệu.');return file.text();
}
export function decodeText(bytes){
 const b=new Uint8Array(bytes);const encoding=b[0]===255&&b[1]===254?'utf-16le':b[0]===254&&b[1]===255?'utf-16be':'utf-8';
 try{return new TextDecoder(encoding,{fatal:true}).decode(b);}catch{throw new Error('Không đọc được mã hóa TXT. Hãy lưu tệp dưới dạng UTF-8 hoặc UTF-16 có BOM.');}
}
