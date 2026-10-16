export function parseStudyGlossary(input){
 const entries=new Map();
 for(const [index,line] of String(input||'').split(/\r?\n/u).entries()){
  if(!line.trim())continue;
  const separator=line.indexOf('=');
  if(separator<1)throw new Error(`Thuật ngữ dòng ${index+1}: dùng dạng chữ Trung = cách dịch Việt.`);
  const source=line.slice(0,separator).trim(),target=line.slice(separator+1).trim();
  if(!source||!target||source.length>100||target.length>100||['__proto__','constructor','prototype'].includes(source))throw new Error(`Thuật ngữ dòng ${index+1} không hợp lệ hoặc quá 100 ký tự.`);
  if(entries.has(source))throw new Error(`Thuật ngữ “${source}” bị lặp.`);
  entries.set(source,target);
  if(entries.size>30)throw new Error('Tối đa 30 thuật ngữ tự chọn trong một phiên dịch.');
 }
 return Object.fromEntries(entries);
}
