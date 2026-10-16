import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

// Layout rules of the cover row (study page) and the whole-book panel (reader), checked in a real browser engine with
// the real stylesheets and markup: the panel is drawn by app.js's own template. Skipped when Microsoft Edge is missing.
// LF-normalised so the source slicing below also works on a checkout with CRLF line endings.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8').replace(/\r\n/gu,'\n'),styles=(...paths)=>paths.map(path=>read(path).replace(/^@import[^;]*;/gmu,'')).join('\n');
let browser=null;try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available to playwright-core here';
test.after(()=>browser?.close());
async function open(html,css){
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent(`<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${html}</body></html>`);return page;
}

test('"Dịch chữ trên bìa" stays hidden whenever the cover row hides it',{skip},async()=>{
 const body=read('frontend/study.html').match(/<body[^>]*>([\s\S]*)<\/body>/u)[1].replace(/<script[\s\S]*?<\/script>/gu,''),page=await open(body,styles('frontend/study.css','frontend/header.css'));
 const display=hidden=>page.evaluate(hidden=>{for(const id of ['pdf-range-options','cover-choice'])document.getElementById(id).hidden=false;const option=document.getElementById('cover-translate-option');option.hidden=hidden;return getComputedStyle(option).display;},hidden);
 assert.equal(await display(true),'none');assert.equal(await display(false),'flex');
 await page.context().close();
});

test('A long original file name stays inside a 390 px screen in the whole-book panel',{skip},async()=>{
 const app=read('frontend/app.js'),start=app.indexOf('function bookDownloadPanel(){'),template=app.slice(start,app.indexOf('\n}\n',start)+2);
 const name='Toan_hoc_lop_11_chuyen_de_vecto_khong_gian_ban_scan_chat_luong_cao_2024_final_v2.pdf',page=await open('<main><article class="reader paper" id="reader"></article></main>',styles('frontend/style.css','frontend/header.css'));
 const measure=await page.evaluate(({template,name})=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon=()=>'<svg viewBox="0 0 24 24" aria-hidden="true"></svg>';
  const state={readerStory:{study:true},chapters:[{},{}],bookDownload:{message:'Cần PDF gốc để ghép đủ bìa và các trang chưa dịch.',pick:{sources:[{key:'a',filename:name,totalPages:10}],errors:[`Tệp này không phải bản gốc “${name}” của các phần đã dịch (mã tệp khác).`]},notes:[`Phần “${name}” là bản dịch dạng chữ, không có trang PDF.`]}};
  document.getElementById('reader').innerHTML=new Function('state','esc','icon','localSources',`${template};return bookDownloadPanel();`)(state,esc,icon,new Map());
  return {scroll:document.documentElement.scrollWidth,inner:innerWidth,panel:document.querySelector('.book-download').getBoundingClientRect().right};
 },{template,name});
 assert.ok(measure.scroll<=measure.inner&&measure.panel<=measure.inner,JSON.stringify(measure));
 await page.context().close();
});
