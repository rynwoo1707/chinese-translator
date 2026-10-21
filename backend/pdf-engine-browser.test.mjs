import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {browserArgs} from '../services/pdf-layout/engine.mjs';

test('the PDF renderer tells Edge not to relaunch itself, and adds --no-sandbox only when asked',t=>{
 const saved=process.env.PDF_CHROMIUM_NO_SANDBOX;t.after(()=>{if(saved===undefined)delete process.env.PDF_CHROMIUM_NO_SANDBOX;else process.env.PDF_CHROMIUM_NO_SANDBOX=saved;});
 delete process.env.PDF_CHROMIUM_NO_SANDBOX;
 assert.deepEqual(browserArgs(),['--edge-skip-compat-layer-relaunch']);
 process.env.PDF_CHROMIUM_NO_SANDBOX='1';
 assert.deepEqual(browserArgs(),['--edge-skip-compat-layer-relaunch','--no-sandbox']);
});

// Edge 155 on Windows exits its first process with code 0 after starting the real browser; without the switch Puppeteer
// fails every launch and leaves that browser running. Only where Edge is installed (the owner's and recipients' machines).
const edge=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
test('Puppeteer starts and closes Edge with the renderer arguments',{skip:edge?false:'needs Microsoft Edge on Windows',timeout:60000},async()=>{
 const puppeteer=createRequire(import.meta.url)('puppeteer-core');
 const browser=await puppeteer.launch({executablePath:edge,headless:true,args:browserArgs()});
 try{
  const page=await browser.newPage();await page.setContent('<p>Chữ Việt có dấu</p>');
  assert.ok((await page.pdf({format:'A4'})).length>1000);
 }finally{await browser.close();}
});
