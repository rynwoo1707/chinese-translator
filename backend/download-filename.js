// RFC 5987 filename keeps Vietnamese titles while providing an ASCII fallback.
export function fileDisposition(name,{fallback='hoa-tri.pdf',attachment=false}={}){
 const filename=String(name||fallback).toWellFormed().normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu,'-').trim()||fallback;
 const encoded=encodeURIComponent(filename).replace(/[!'()*]/gu,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
 return `${attachment?'attachment':'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
