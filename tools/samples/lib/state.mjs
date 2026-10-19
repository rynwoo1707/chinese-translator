// The files of one sample and what is current: a check belongs to the manifest and texts.json it read, a render to
// the check it rendered, so publish can refuse anything older than the files on disk.
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import * as pdfLayout from '../../../backend/pdf-layout.js';
import {ROOT,sampleDir,workDir,chunkDir,assertIgnored} from './paths.mjs';
import {readJson,sha256,fileSha256} from './util.mjs';
import {validateSample} from './config.mjs';

// pdf-layout.js names the renderer version its exports carry; 3 until it exports the constant itself.
export const RENDER_VERSION=pdfLayout.RENDER_VERSION??3;
const hashFiles=async files=>sha256(Buffer.concat(await Promise.all(files.map(file=>readFile(resolve(ROOT,file)).catch(()=>Buffer.alloc(0)))))).slice(0,16);
export async function codeVersions(){
 return {extractor:await hashFiles(['services/pdf-layout/extract.py']),renderer:await hashFiles(['services/pdf-layout/engine.mjs','frontend/pdf-box-layout.js','frontend/math-text.js']),renderVersion:RENDER_VERSION};
}
export async function loadSample(slug,{need=[]}={}){
 const dir=sampleDir(slug),file=resolve(dir,'sample.json');
 assertIgnored([file,resolve(dir,'work','state.json'),resolve(dir,'work','c01','texts.json'),resolve(dir,'published.json')]);
 const value=await readJson(file,{what:`samples/${slug}/sample.json`});
 if(!value)throw new Error(`Chưa có samples/${slug}/sample.json: chạy "npm run samples -- init ${slug} --pdf <tệp PDF>" trước.`);
 return {dir,config:validateSample(value,{slug,need})};
}
export const statePath=slug=>resolve(workDir(slug),'state.json');
export const publishedPath=slug=>resolve(sampleDir(slug),'published.json');
export async function readState(slug){
 const state=await readJson(statePath(slug),{what:'work/state.json'});
 if(!state?.chunks?.length)throw new Error(`Ví dụ mẫu "${slug}" chưa được tách trang: chạy "npm run samples -- extract ${slug}".`);
 return state;
}
export function chunkFiles(slug,chunk){
 const dir=chunkDir(slug,chunk),render=resolve(dir,'render');
 return {dir,manifest:resolve(dir,'manifest.json'),selected:resolve(dir,'selected.pdf'),blocks:resolve(dir,'blocks.json'),template:resolve(dir,'texts.template.json'),texts:resolve(dir,'texts.json'),report:resolve(dir,'import-report.json'),corrected:resolve(dir,'manifest.corrected.json'),render,pdf:resolve(render,`${chunk}.vi.pdf`),renderReport:resolve(render,'report.json'),preview:resolve(render,`${chunk}.vi-preview.pdf`),previewReport:resolve(render,'preview-report.json')};
}
export const pickChunks=(state,chunk)=>{if(!chunk)return state.chunks;const found=state.chunks.find(c=>c.id===chunk);if(!found)throw new Error(`Không có phần "${chunk}" (các phần: ${state.chunks.map(c=>c.id).join(', ')}).`);return [found];};
// What publish needs from one part, and why it is not ready yet.
export async function chunkStatus(slug,chunk,{code}={}){
 const files=chunkFiles(slug,chunk.id),problems=[],notes=[];
 const report=await readJson(files.report,{what:`${chunk.id}/import-report.json`}),render=await readJson(files.renderReport,{what:`${chunk.id}/render/report.json`});
 const texts=existsSync(files.texts),manifestSha256=await fileSha256(files.manifest),textsSha256=await fileSha256(files.texts);
 const current=inputs=>Boolean(inputs&&inputs.manifestSha256===manifestSha256&&inputs.textsSha256===textsSha256);
 const checked=current(report?.inputs);
 if(!texts)problems.push('chưa có texts.json');
 else if(!report||!checked)problems.push('texts.json chưa được check (hoặc đã đổi sau lần check)');
 else if(!report.ok)problems.push(`check còn ${report.errors.length} lỗi`);
 const rendered=Boolean(checked&&report?.ok&&render&&!render.preview&&current(render.inputs));
 if(checked&&report?.ok&&!rendered)problems.push('chưa render bản mới nhất');
 if(rendered&&render.renderVersion!==RENDER_VERSION)problems.push(`bản render dùng phiên bản dựng ${render.renderVersion}, hiện là ${RENDER_VERSION}: render lại`);
 let pdfOk=false;if(rendered){const pdfSha256=await fileSha256(files.pdf);pdfOk=pdfSha256===render.pdf?.sha256;if(!pdfOk)problems.push('tệp PDF tiếng Việt đã đổi hoặc mất sau lần render: render lại');}
 if(rendered&&code&&render.code?.renderer!==code.renderer)notes.push('mã dựng PDF đã đổi sau lần render; nên render lại để có bố cục mới nhất');
 return {id:chunk.id,title:chunk.title,pages:chunk.pages,files,texts,report,render,checked,rendered:rendered&&pdfOk,warnings:checked&&report?.ok?report.warnings.length:null,errors:checked&&report?report.errors.length:null,problems,notes};
}
