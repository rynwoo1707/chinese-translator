#!/usr/bin/env node
// npm run samples -- <lệnh> <mã> …: public sample translations for the Hoa Trí homepage, made without Gemini. See
// tools/samples/README.md. Everything it reads and writes stays in the git-ignored samples/ folder.
import {parseArgs} from 'node:util';
import {readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {installNetworkGuard} from './lib/guard.mjs';
import {SAMPLES,validSlug} from './lib/paths.mjs';
import {readJson} from './lib/util.mjs';
import {resolveTarget} from './lib/admin-client.mjs';

const HELP=`Ví dụ mẫu Hoa Trí (không gọi Gemini). Cách dùng: npm run samples -- <lệnh> <mã> [tùy chọn]
  init <mã> --pdf <tệp> [--title <tên>] [--force]  tạo samples/<mã>/ với source.pdf và sample.json
  extract <mã> [--force]                         tách trang, ảnh, khung đoạn và RULES.md vào samples/<mã>/work/
  check <mã> [phần]                              kiểm tra work/<phần>/texts.json bằng các bước kiểm tra của app
  render <mã> [phần] [--preview-overflow]        check rồi dựng PDF tiếng Việt và ảnh so sánh
  status <mã>                                    tình trạng từng phần và nơi đã đăng
  publish <mã> [--target local|<url>] [--draft] [--replace] [--yes]
                                                 đăng kèm PDF gốc (mặc định trích đoạn) và trang gốc của từng phần
  unpublish <mã> [--target …]                    ẩn sách, giữ nguyên mã và đường dẫn
  remove <mã> [--target …] [--yes]               xóa sách khỏi máy chủ
  list                                           các ví dụ mẫu trong samples/
--target mặc định là local (http://127.0.0.1:8787, mã quản trị trong .dev.vars). Máy chủ khác cần HTTPS và
HOATRI_ADMIN_TOKEN (hoặc nhập khi được hỏi).`;

const options={pdf:{type:'string'},title:{type:'string'},force:{type:'boolean'},target:{type:'string'},draft:{type:'boolean'},replace:{type:'boolean'},yes:{type:'boolean'},'preview-overflow':{type:'boolean'},help:{type:'boolean',short:'h'}};
const say=(...lines)=>console.log(lines.join('\n'));
const item=entry=>`${entry.id?`${entry.id}: `:''}${entry.message}`;

async function hiddenPrompt(question){
 if(!process.stdin.isTTY)throw new Error('Không hỏi được mã quản trị ở đây: đặt biến môi trường HOATRI_ADMIN_TOKEN.');
 process.stdout.write(question);
 return new Promise((done,fail)=>{
  const stdin=process.stdin;let value='';stdin.setRawMode(true);stdin.resume();stdin.setEncoding('utf8');
  const finish=error=>{stdin.setRawMode(false);stdin.pause();stdin.off('data',read);process.stdout.write('\n');error?fail(error):done(value);};
  const read=chunk=>{for(const ch of chunk){if(ch==='\r'||ch==='\n')return finish();if(ch==='\u0003')return finish(new Error('Đã hủy.'));if(ch==='\u007f'||ch==='\b')value=value.slice(0,-1);else value+=ch;}};
  stdin.on('data',read);
 });
}
async function confirm(question){
 if(!process.stdin.isTTY)return false;
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{return /^(y|yes|c|có|co)$/iu.test((await rl.question(`${question} (y/N) `)).trim());}finally{rl.close();}
}

function printReport(chunk,report){
 say(`${chunk.id} · ${chunk.title}: ${report.errors.length} lỗi, ${report.warnings.length} cảnh báo${report.stats?` · ${report.stats.translated}/${report.stats.blocks} đoạn đã dịch${report.stats.ocrBlocks?`, ${report.stats.corrected}/${report.stats.ocrBlocks} đoạn scan đã sửa chữ Trung`:''}`:''}`);
 for(const entry of report.errors)say(`  LỖI ${item(entry)}`);
 for(const entry of report.warnings)say(`  cảnh báo ${item(entry)}`);
 for(const line of report.info||[])say(`  · ${line}`);
}
async function listSamples(){
 if(!existsSync(SAMPLES))return say('Chưa có thư mục samples/.');
 const names=(await readdir(SAMPLES,{withFileTypes:true})).filter(d=>d.isDirectory()&&existsSync(resolve(SAMPLES,d.name,'sample.json'))).map(d=>d.name);
 if(!names.length)return say('Chưa có ví dụ mẫu nào (npm run samples -- init <mã> --pdf <tệp>).');
 for(const name of names){
  const config=await readJson(resolve(SAMPLES,name,'sample.json')).catch(()=>null),state=await readJson(resolve(SAMPLES,name,'work','state.json')).catch(()=>null),published=await readJson(resolve(SAMPLES,name,'published.json')).catch(()=>null);
  const targets=Object.entries(published?.targets||{}).map(([origin,entry])=>`${origin} (${entry.visibility==='private'?'nháp':'công khai'})`);
  say(`${name}: ${config?.title||'(chưa có tên)'} · ${state?.chunks?.length?`${state.chunks.length} phần`:'chưa tách trang'}${targets.length?` · đã đăng: ${targets.join(', ')}`:''}`);
 }
}

async function main(){
 const {values,positionals}=parseArgs({args:process.argv.slice(2),options,allowPositionals:true,strict:true});
 const [command,slug,chunk]=positionals;
 if(!command||values.help||command==='help')return say(HELP);
 if(command==='list'){installNetworkGuard();return listSamples();}
 if(!slug)throw new Error(`Thiếu mã ví dụ mẫu. ${HELP.split('\n')[0]}`);
 validSlug(slug);
 const network=['publish','unpublish','remove'].includes(command),target=values.target||'local';
 // Only the publish target is reachable from this process; Gemini and every other host are not.
 installNetworkGuard({allow:network?[resolveTarget(target).origin]:[]});
 if(command==='init'){const {initSample}=await import('./lib/extract.mjs');await initSample(slug,{pdf:values.pdf,title:values.title||'',force:values.force});return;}
 if(command==='extract'){const {extractSample}=await import('./lib/extract.mjs');await extractSample(slug,{force:values.force});return;}
 if(command==='check'){
  const {checkSample}=await import('./lib/render.mjs'),reports=await checkSample(slug,chunk);
  for(const {chunk:part,report} of reports)printReport(part,report);
  if(reports.some(r=>!r.report.ok))process.exitCode=1;else say('Không còn lỗi. Bước tiếp: npm run samples -- render '+slug+(chunk?` ${chunk}`:''));
  return;
 }
 if(command==='render'){
  const {renderSample}=await import('./lib/render.mjs'),results=await renderSample(slug,chunk,{previewOverflow:values['preview-overflow']});
  for(const result of results){
   if(result.error){say(`${result.chunk.id} · ${result.chunk.title}: LỖI ${result.error}`);process.exitCode=1;continue;}
   if(!result.rendered){printReport(result.chunk,result.report);process.exitCode=1;continue;}
   const r=result.rendered;
   say(`${result.chunk.id} · ${result.chunk.title}: đã dựng ${r.pdf.file} (${(r.pdf.bytes/1024).toFixed(0)} KB)${r.overflow.length?` · ${r.overflow.length} đoạn KHÔNG VỪA KHUNG: ${r.overflow.join(', ')}`:''}${r.shrunk.length?` · ${r.shrunk.length} đoạn thu nhỏ chữ nhiều`:''}${result.report.warnings.length?` · ${result.report.warnings.length} cảnh báo (xem check)`:''}`);
   say(`  so sánh: samples/${slug}/work/${result.chunk.id}/render/p<trang>.compare.png`);
   if(r.preview){say('  Bản xem thử (--preview-overflow) không đăng được; rút gọn bản dịch rồi render lại.');if(r.overflow.length)process.exitCode=1;}
  }
  return;
 }
 if(command==='status'){
  const {loadSample,readState,chunkStatus,codeVersions,publishedPath}=await import('./lib/state.mjs'),{config}=await loadSample(slug),state=await readState(slug),code=await codeVersions();
  say(`${config.title||slug} · ${config.genre} · nguồn ${state.source.file} (${state.source.totalPages} trang) · bìa ${state.cover?.page||'không có'}`);
  for(const part of state.chunks){
   const s=await chunkStatus(slug,part,{code});
   say(`  ${part.id} · ${part.title} · ${part.blocks} đoạn: ${s.problems.length?s.problems.join('; '):`sẵn sàng đăng${s.warnings?` (${s.warnings} cảnh báo)`:''}`}${s.notes.length?` · ${s.notes.join('; ')}`:''}`);
  }
  const published=await readJson(publishedPath(slug));
  for(const [origin,entry] of Object.entries(published?.targets||{}))say(`  đã đăng trên ${origin}: ${entry.visibility==='private'?'bản nháp':'công khai'}, mã ${entry.storyId}, ${entry.chapters.length} phần (${entry.publishedAt})`);
  return;
 }
 const common={target,prompt:hiddenPrompt,confirm};
 if(command==='publish'){
  const {publishSample}=await import('./lib/publish.mjs'),result=await publishSample(slug,{...common,draft:values.draft,replace:values.replace,yes:values.yes});
  say(`Đã đăng ${result.chapters.length} phần lên ${result.origin} (${result.visibility==='private'?'bản nháp, chỉ quản trị viên xem được':'công khai'}), mã sách ${result.storyId}${result.kept?' (giữ nguyên mã cũ)':''}.`,`Mở: ${result.reader}`,...(result.source?[`PDF gốc: ${result.source.mode==='full'?'cả tệp':'trích đoạn'}, ${result.source.pages} trang; "Tải cả quyển" và "Đọc song ngữ" dùng tệp này.`]:[]),...(result.replaced?[`Đã xóa bản cũ ${result.replaced}.`]:[]),...result.notes);
  return;
 }
 if(command==='unpublish'){
  const {unpublishSample}=await import('./lib/publish.mjs'),result=await unpublishSample(slug,common);
  return say(result.changed?`Đã chuyển sách ${result.storyId} trên ${result.origin} thành bản nháp.`:`Sách ${result.storyId} trên ${result.origin} đã là bản nháp.`);
 }
 if(command==='remove'){
  const {removeSample}=await import('./lib/publish.mjs'),result=await removeSample(slug,{...common,yes:values.yes});
  return say(result.alreadyGone?`Sách ${result.storyId} không còn trên ${result.origin}; đã xóa ghi chép trong published.json.`:`Đã xóa sách ${result.storyId} khỏi ${result.origin}. Thư mục samples/${slug}/ vẫn giữ nguyên.`);
 }
 throw new Error(`Lệnh lạ "${command}".\n${HELP}`);
}

main().catch(error=>{console.error(`LỖI: ${error.message}`);process.exitCode=1;});
