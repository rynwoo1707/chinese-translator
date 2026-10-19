// Where the sample tool may read and write: only inside samples/<slug>/, a folder git ignores (the owner's PDFs and the
// translations of them never reach the repository, the Docker context or the public frontend/ folder).
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute,sep} from 'node:path';

export const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const SAMPLES=resolve(ROOT,'samples');
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/u;
export function validSlug(value){
 if(typeof value!=='string'||!SLUG.test(value))throw new Error(`Mã ví dụ mẫu "${String(value??'').slice(0,40)}" không hợp lệ: chỉ dùng chữ thường a-z, số và dấu gạch ngang, 2–64 ký tự, không bắt đầu hay kết thúc bằng gạch ngang.`);
 return value;
}
export const sampleDir=slug=>resolve(SAMPLES,validSlug(slug));
export const workDir=slug=>resolve(sampleDir(slug),'work');
export const chunkDir=(slug,chunk)=>resolve(workDir(slug),validChunk(chunk));
export function validChunk(value){if(!/^c\d{2,3}$/u.test(String(value)))throw new Error(`Mã phần "${String(value).slice(0,20)}" không hợp lệ (dạng c01).`);return value;}
export function insideSamples(path){const rel=relative(SAMPLES,resolve(path));return Boolean(rel)&&!rel.startsWith('..')&&!isAbsolute(rel);}
export function assertInsideSamples(path){if(!insideSamples(path))throw new Error(`Công cụ ví dụ mẫu chỉ ghi vào thư mục samples/ (từ chối ${path}).`);return path;}
// A file name inside the sample folder: no folders, no way out of it.
export function sampleFile(slug,name){
 if(typeof name!=='string'||!name||name!==name.trim()||/[\\/:*?"<>|\0]/u.test(name)||name==='.'||name==='..')throw new Error(`Tên tệp "${String(name).slice(0,60)}" phải là một tệp nằm ngay trong samples/${slug}/.`);
 return resolve(sampleDir(slug),name);
}
const toGit=path=>relative(ROOT,path).split(sep).join('/');
// Each path must be ignored by git. `git check-ignore -v -n -z` gives source, line, pattern and path per input path (an
// empty pattern when none matches); a "!" pattern re-includes the path. Without git (a ZIP copy), the samples/ line of
// .gitignore has to be there.
export function assertIgnored(paths){
 const list=[paths].flat().map(path=>toGit(resolve(path)));
 const run=spawnSync('git',['check-ignore','-v','-n','-z','--stdin'],{cwd:ROOT,input:list.join('\0')+'\0',encoding:'utf8',windowsHide:true});
 let notIgnored;
 if(run.error||![0,1].includes(run.status)){
  const text=existsSync(resolve(ROOT,'.gitignore'))?readFileSync(resolve(ROOT,'.gitignore'),'utf8'):'';
  notIgnored=/^\/?samples\/?\s*$/mu.test(text)?[]:list;
 }else{
  const fields=run.stdout.split('\0'),decided=new Map();
  for(let i=0;i+3<fields.length;i+=4)decided.set(fields[i+3],Boolean(fields[i+2])&&!fields[i+2].startsWith('!'));
  notIgnored=list.filter(path=>decided.get(path)!==true);
 }
 if(notIgnored.length)throw new Error(`Git chưa bỏ qua ${notIgnored.join(', ')}: công cụ chỉ làm việc với tệp không thể bị đưa lên git. Hãy giữ dòng "samples/" trong .gitignore.`);
}
