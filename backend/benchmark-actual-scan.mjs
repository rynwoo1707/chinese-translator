// Verify the reported textbook pages with real Gemini OCR + translation, then real Puppeteer export.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {recognizePdfBlocks,normalizeOcrMath} from './pdf-block-ocr.js';
import {translatePdfBlocks} from './pdf-block-translation.js';
import {blockBatches,ocrImageBatches,validateLayoutDocument} from '../frontend/pdf-box-layout.js';
import {renderDocument} from '../services/pdf-layout/engine.mjs';
const raw=await readFile('.dev.vars','utf8'),setting=name=>[...raw.matchAll(new RegExp(`^${name}=([^\\r\\n]*)`,'gm'))].at(-1)?.[1].trim().replace(/^(['"])(.*)\1$/u,'$2')||'';
const env={GEMINI_API_KEY:setting('GEMINI_API_KEY'),GEMINI_MODEL:setting('GEMINI_MODEL'),GEMINI_THINKING:'minimal',GEMINI_MODEL_RECOVERY:true,GEMINI_PREFERRED_MODEL:setting('GEMINI_MODEL')};if(!env.GEMINI_API_KEY)throw new Error('Thiếu khóa môi trường để kiểm tra hai trang mẫu.');
const root=resolve('tmp/pdf-layout/actual-scan'),originalPath=resolve(root,'manifest.json'),checkpointPath=resolve(root,'corrected-manifest.json'),checkpoint=await stat(checkpointPath).catch(()=>null),original=await stat(originalPath),input=checkpoint&&checkpoint.mtimeMs>=original.mtimeMs?checkpointPath:originalPath,document=validateLayoutDocument(JSON.parse(await readFile(input,'utf8'))),blocks=document.pages.filter(p=>p.ocr).flatMap(p=>p.blocks);let tokens=0;
// Manifests with OCR sheets are read a whole sheet at a time, older ones one paragraph image per block.
const sheets=document.pages.filter(p=>p.ocr).flatMap(p=>p.ocrSheets||[]);let read=0;
for(const ids of ocrImageBatches(blocks.filter(b=>!b.ocrCorrected),undefined,sheets)){
 const group=ids.map(id=>blocks.find(b=>b.id===id)),output=await recognizePdfBlocks(env,group,sheets.filter(s=>s.strips.some(strip=>ids.includes(strip.blockId))));tokens+=output.usage?.total||0;read+=group.length;
 for(const value of output.blocks){const block=blocks.find(b=>b.id===value.id);block.source=value.text;let text=value.text;for(const inline of block.inlines||[])text=text.replace(inline.token,()=>inline.text);block.text=text;block.ocrCorrected=true;}
 await writeFile(resolve(root,'corrected-manifest.json'),JSON.stringify(document));console.log(`OCR image verification ${read}/${blocks.length} blocks (${output.model}).`);
 // Stopped part-way (quota, overload): the blocks decided before it are in the checkpoint, so a re-run reads only the rest.
 if(output.stop)throw output.stop;
}
document.ocrCorrectedVersion=1;for(const block of blocks){block.source=normalizeOcrMath(block.source);if(/^\d+(?:\.\d+){1,4}\s*[\u3400-\u9fff]/u.test(block.source)&&block.source.length<100){block.kind='heading';block.bold=true;}}await writeFile(checkpointPath,JSON.stringify(document));const all=document.pages.flatMap(p=>p.blocks),translations=process.argv.includes('--repair-geometry')?JSON.parse(await readFile(resolve(root,'translations.json'),'utf8')):[];let context='',glossary={};
for(const batch of blockBatches(process.argv.includes('--repair-geometry')?all.filter(b=>['p4-b1','p4-b3','p4-b5','p5-b7'].includes(b.id)):all)){
 const output=await translatePdfBlocks(env,{domain:'math',blocks:batch.map(({id,source})=>({id,source})),context,glossary});context=output.context;glossary=output.glossary;for(const b of output.blocks){const i=translations.findIndex(t=>t.id===b.id);if(i<0)translations.push(b);else translations[i]=b;}tokens+=output.usage?.total||0;console.log(`Real translation ${translations.length}/${all.length} blocks (${output.model}).`);
}
await writeFile(resolve(root,'translations.json'),JSON.stringify(translations,null,2));const rendered=await renderDocument(document,translations);await mkdir('output/pdf',{recursive:true});await writeFile('output/pdf/hoa-tri-trang-4-5-kiem-tra.pdf',Buffer.from(rendered.pdfBase64,'base64'));await writeFile(resolve(root,'render-report.json'),JSON.stringify({model:env.GEMINI_MODEL,totalTokens:tokens,pages:rendered.report},null,2));console.log(`Actual scan verification exported ${rendered.report.length} pages, ${tokens} Gemini tokens.`);
