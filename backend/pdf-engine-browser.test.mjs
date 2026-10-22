import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {browserArgs,chromiumPath,renderDocument} from '../services/pdf-layout/engine.mjs';

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

// The real renderer with whatever browser the service would use (Edge here, CI's Chromium): no Python is needed, since
// a refused export never reaches the merge.
const anyBrowser=(()=>{try{return existsSync(chromiumPath());}catch{return false;}})();
test('An export with translations longer than their boxes is refused, naming every such box of every page as Xưởng dịch numbers them',{skip:anyBrowser?false:'needs Edge, Chrome or Chromium',timeout:120000},async t=>{
 const saved=process.env.PDF_PYTHON;process.env.PDF_PYTHON='hoa-tri-no-python-in-this-test';t.after(()=>{if(saved===undefined)delete process.env.PDF_PYTHON;else process.env.PDF_PYTHON=saved;});
 const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
 // Small pages, so no growth into free room can make room for the long translations.
 const page=(number,ids)=>({number,width:120,height:120,background:PNG,original:PNG,blocks:ids.map((id,i)=>({id,source:'空间向量。',box:[10,10+i*35,110,35+i*35],fontSize:12}))});
 const document={version:1,pages:[page(4,['p4-b0','p4-b1','p4-b2']),page(5,['p5-b0']),page(6,['p6-b0'])]};
 const long='Một câu dịch rất dài vượt khỏi khung chữ. '.repeat(120),short='Vectơ.';
 const translations=[['p4-b0',short],['p4-b1',long],['p4-b2',long],['p5-b0',short],['p6-b0',long]].map(([id,translation])=>({id,translation}));
 const profiles=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('puppeteer_dev_chrome_profile-')),before=new Set(profiles());
 const refused=await renderDocument(document,translations).catch(error=>error);
 assert.equal(refused.code,'overflow',refused.stack);
 assert.deepEqual(refused.blocks,[{page:4,id:'p4-b1',label:'Đoạn 2'},{page:4,id:'p4-b2',label:'Đoạn 3'},{page:6,id:'p6-b0',label:'Đoạn 1'}],'page 6 is measured after page 4 was refused');
 assert.match(refused.message,/^Trang 4: chữ Việt không vừa box \(p4-b1, p4-b2\); Trang 6: chữ Việt không vừa box \(p6-b0\)/u);
 const end=Date.now()+15000;while(profiles().some(name=>!before.has(name))&&Date.now()<end)await new Promise(done=>setTimeout(done,100));
 assert.deepEqual(profiles().filter(name=>!before.has(name)),[],'the browser was closed');
});
