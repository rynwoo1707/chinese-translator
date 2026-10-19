// check and render: texts.json -> import-report.json and manifest.corrected.json (importer.mjs), then the Vietnamese
// PDF of the part by the PDF service's own renderer (engine.renderDocument) with PNG previews next to it.
import {readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {validateLayoutDocument} from '../../../frontend/pdf-box-layout.js';
import {writeJson,writeRawJson,writeSampleFile,removeSamplePath,sha256,isPdf} from './util.mjs';
import {importTexts} from './importer.mjs';
import {prepareEngineEnv,pdfTool} from './machine.mjs';
import {loadSample,readState,chunkFiles,pickChunks,codeVersions,RENDER_VERSION} from './state.mjs';
import {assertInsideSamples} from './paths.mjs';

export async function checkChunk(slug,chunk,config){
 const files=chunkFiles(slug,chunk.id),manifestBytes=await readFile(files.manifest),document=validateLayoutDocument(JSON.parse(manifestBytes.toString('utf8')));
 let textsBytes=null,texts,parseError=null;
 if(existsSync(files.texts)){textsBytes=await readFile(files.texts);try{texts=JSON.parse(textsBytes.toString('utf8').replace(/^﻿/u,''));}catch(error){parseError=`texts.json không phải JSON hợp lệ: ${error.message}`;}}
 const result=textsBytes&&!parseError?importTexts(document,texts,{slug,chunk:chunk.id,glossary:config.glossary,domain:config.domain}):{errors:[{id:null,message:parseError||'Chưa có texts.json: chép texts.template.json thành texts.json rồi điền bản dịch.'}],warnings:[],info:[],notes:[],translations:[],stats:null,glossary:config.glossary,translator:''};
 const report={version:1,sample:slug,chunk:chunk.id,ok:!result.errors.length,inputs:{manifestSha256:sha256(manifestBytes),textsSha256:textsBytes?sha256(textsBytes):null},errors:result.errors,warnings:result.warnings,info:result.info,notes:result.notes,translator:result.translator,glossary:result.glossary,stats:result.stats,translations:result.translations,checkedAt:new Date().toISOString()};
 await writeJson(files.report,report);
 // A corrected manifest only exists for a check without errors, so render can never pick up an older one.
 if(report.ok)await writeRawJson(files.corrected,result.document);else await removeSamplePath(files.corrected);
 return report;
}
export async function checkSample(slug,chunkName){
 const {config}=await loadSample(slug),state=await readState(slug),reports=[];
 for(const chunk of pickChunks(state,chunkName))reports.push({chunk,report:await checkChunk(slug,chunk,config)});
 return reports;
}

export async function renderChunk(slug,chunk,{config,previewOverflow=false,log=console.log}){
 const report=await checkChunk(slug,chunk,config),files=chunkFiles(slug,chunk.id);
 if(!report.ok)return {report,rendered:null};
 prepareEngineEnv();
 const {renderDocument}=await import('../../../services/pdf-layout/engine.mjs');
 const document=JSON.parse(await readFile(files.corrected,'utf8')),title=`${config.title||slug} · ${chunk.title}`;
 log(`Đang dựng PDF tiếng Việt ${chunk.id} · ${chunk.title}…`);
 const result=await renderDocument(document,report.translations,{title,allowOverflow:previewOverflow}),pdf=Buffer.from(result.pdfBase64,'base64');
 if(!isPdf(pdf))throw new Error('Engine không trả PDF hợp lệ.');
 const out=previewOverflow?files.preview:files.pdf;await writeSampleFile(out,pdf);
 await mkdir(assertInsideSamples(files.render),{recursive:true});
 await pdfTool(['previews'],{input:JSON.stringify({original:files.selected,rendered:out,numbers:document.pages.map(p=>p.number),outDir:files.render,scale:1.5})});
 const blocks=result.report.flatMap(page=>page.blocks.map(b=>({page:page.page,...b}))),code=await codeVersions();
 // A render belongs to the manifest and texts.json its check read: checking the same files again keeps it current.
 const rendered={version:1,sample:slug,chunk:chunk.id,preview:previewOverflow,renderVersion:RENDER_VERSION,code:{renderer:code.renderer},inputs:report.inputs,title,pdf:{file:basename(out),sha256:sha256(pdf),bytes:pdf.length},overflow:blocks.filter(b=>b.overflow).map(b=>b.id),shrunk:blocks.filter(b=>b.shrunk).map(b=>b.id),pages:result.report,renderedAt:new Date().toISOString()};
 await writeJson(previewOverflow?files.previewReport:files.renderReport,rendered);
 return {report,rendered};
}
export async function renderSample(slug,chunkName,{previewOverflow=false,log=console.log}={}){
 const {config}=await loadSample(slug),state=await readState(slug),results=[];
 for(const chunk of pickChunks(state,chunkName)){
  try{results.push({chunk,...await renderChunk(slug,chunk,{config,previewOverflow,log})});}
  catch(error){results.push({chunk,error:error.message});}
 }
 return results;
}
