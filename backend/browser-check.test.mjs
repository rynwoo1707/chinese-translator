import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {clientErrorReport} from './client-error.js';

// frontend/browser-check.js reports the errors a page meets to POST /api/client-error (backend/client-error.js): first
// run here with a fake window (what is sent, what never is), then in Edge on the real home page under the site's CSP.
const SOURCE=readFileSync(new URL('../frontend/browser-check.js',import.meta.url),'utf8');
const ORIGIN='https://hoatri.test',EDGE='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const TOKEN='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
// A page of the site with browser-check.js run in it: fire(type, event) dispatches to its window listeners; sent holds
// what sendBeacon was given. options: protocol, agent, beacon (false: no navigator.sendBeacon), app (a #app element).
function page({protocol='https:',agent=EDGE,beacon=true,app=null,before=''}={}){
 const listeners={},docListeners={},sent=[],created=[];
 const element=()=>{const item={attributes:{},children:[],setAttribute(name,value){this.attributes[name]=String(value);},appendChild(child){this.children.push(child);return child;}};created.push(item);return item;};
 const document={readyState:'interactive',documentElement:{getAttribute:()=>null},body:{firstChild:null,insertBefore(child){created.push(child);}},getElementById:id=>id==='app'?app:null,createElement:element,addEventListener(type,fn){(docListeners[type]||=[]).push(fn);}};
 const navigator={userAgent:agent,...(beacon?{sendBeacon(url,body){sent.push({url,body:JSON.parse(body)});return true;}}:{})};
 const location={protocol,host:protocol==='file:'?'':'hoatri.test',pathname:'/',search:'?read=b1',hash:`#dat-lai-mat-khau?token=${TOKEN}`,reload(){}};
 const window={addEventListener(type,fn){(listeners[type]||=[]).push(fn);},HTMLDialogElement:Object.assign(function(){},{prototype:{showModal(){}}})};
 const context=vm.createContext({window,document,navigator,location,setTimeout,JSON,console});
 if(before)vm.runInContext(before,context);
 vm.runInContext(SOURCE,context);
 return {sent,created,fire:(type,event)=>{for(const fn of listeners[type]||[])fn(event);},ready:async()=>{for(const fn of docListeners.DOMContentLoaded||[])fn();await new Promise(done=>setTimeout(done,5));}};
}
const error=(message,filename,lineno=1,colno=1)=>({message,filename,lineno,colno,error:null});

test('An error in one of the site\'s scripts is reported once: scrubbed text, file:line:col, path only, browser family',()=>{
 const tab=page();
 tab.fire('error',error(`Uncaught TypeError: không đọc được lan.nguyen@example.edu.vn tại ${ORIGIN}/#dat-lai-mat-khau?token=${TOKEN} (khóa AIza${'x'.repeat(35)})`,`${ORIGIN}/app.js?v=3#x`,812,44));
 assert.deepEqual(tab.sent,[{url:'/api/client-error',body:{message:`Uncaught TypeError: không đọc được [email] tại ${ORIGIN}/ (khóa […])`,page:'/',browser:'edge 141',source:'/app.js:812:44'}}]);
 assert.doesNotMatch(JSON.stringify(tab.sent),/token|read=b1|lan\.nguyen|AIza/u,'no query, hash, e-mail or key leaves the page');
 // The same error again (a handler that fails on every scroll) is not sent again.
 tab.fire('error',error(`Uncaught TypeError: không đọc được lan.nguyen@example.edu.vn tại ${ORIGIN}/#dat-lai-mat-khau?token=${TOKEN} (khóa AIza${'x'.repeat(35)})`,`${ORIGIN}/app.js?v=3#x`,812,44));
 assert.equal(tab.sent.length,1);
 // The server takes what the page sends as it is (clientErrorReport is what it logs).
 assert.deepEqual(clientErrorReport(tab.sent[0].body,ORIGIN),{message:tab.sent[0].body.message,source:'/app.js:812:44',page:'/',browser:'edge 141'});
});

test('Not sent: another site\'s script or an extension, "Script error.", a ResizeObserver note; a long text is cut at 300',()=>{
 const tab=page();
 tab.fire('error',error('Uncaught Error: từ tiện ích','chrome-extension://abcdef/content.js',3,9));
 tab.fire('error',error('Uncaught Error: từ trang khác','https://cdn.other.example/x.js',3,9));
 tab.fire('error',error('Script error.','',0,0));
 tab.fire('error',error('ResizeObserver loop completed with undelivered notifications.','',0,0));
 tab.fire('error',{type:'error'});
 assert.deepEqual(tab.sent,[]);
 tab.fire('error',error(`Lỗi ${'ữ'.repeat(400)}`,`${ORIGIN}/study.js`,5,1));
 assert.equal(tab.sent.length,1);assert.equal(tab.sent[0].body.message.length,300);assert.equal(tab.sent[0].body.source,'/study.js:5:1');
 // Without a file (an error the browser raised for no script) the report has no source.
 tab.fire('error',error('Uncaught RangeError: quá giới hạn','',0,0));
 assert.deepEqual(tab.sent[1].body,{message:'Uncaught RangeError: quá giới hạn',page:'/',browser:'edge 141'});
 // A script of the site whose line the browser does not give: sent, without a place.
 tab.fire('error',error('Uncaught SyntaxError: Unexpected token',`${ORIGIN}/math-text.js?v=2`,0,0));
 assert.deepEqual(tab.sent[2].body,{message:'Uncaught SyntaxError: Unexpected token',page:'/',browser:'edge 141'});
});

test('A rejected promise nobody handled is reported with the first frame of the site\'s own scripts',()=>{
 const tab=page(),fail=Object.assign(new TypeError('Failed to fetch'),{stack:`TypeError: Failed to fetch\n    at api (${ORIGIN}/app.js:41:17)\n    at async refresh (${ORIGIN}/app.js:120:3)`});
 tab.fire('unhandledrejection',{reason:fail});
 tab.fire('unhandledrejection',{reason:'hết thời gian'});
 tab.fire('unhandledrejection',{reason:Object.assign(new Error('từ tiện ích'),{stack:'Error: từ tiện ích\n    at chrome-extension://abcdef/x.js:1:1'})});
 assert.deepEqual(tab.sent.map(item=>item.body),[
  {message:'Promise bị từ chối: TypeError: Failed to fetch',page:'/',browser:'edge 141',source:'/app.js:41:17'},
  {message:'Promise bị từ chối: hết thời gian',page:'/',browser:'edge 141'}
 ]);
});

test('At most 5 reports a page load; none from a file:// page or without sendBeacon',()=>{
 const tab=page();
 for(let i=0;i<9;i++)tab.fire('error',error(`Uncaught Error: lỗi số ${i}`,`${ORIGIN}/app.js`,i+1,1));
 assert.deepEqual(tab.sent.map(item=>item.body.message),[0,1,2,3,4].map(i=>`Uncaught Error: lỗi số ${i}`));
 const file=page({protocol:'file:'});file.fire('error',error('Uncaught Error: x','file:///C:/hoa-tri/app.js',1,1));assert.deepEqual(file.sent,[]);
 const old=page({beacon:false});assert.doesNotThrow(()=>old.fire('error',error('Uncaught Error: x',`${ORIGIN}/app.js`,1,1)));assert.deepEqual(old.sent,[]);
});

test('The browser is named by family and major version only',()=>{
 const agents={
  'zalo':'Mozilla/5.0 (Linux; Android 13; SM-A135F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Zalo android/12100500 ZaloTheme/light ZaloLanguage/vn',
  'facebook':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.94]',
  'samsung 25':'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  'opera 112':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
  'coccoc 133':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/133.0.180 Chrome/127.0.6533.180 Safari/537.36',
  'edge 141':EDGE,
  'firefox 131':'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'chrome 129':'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  'chrome 130':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  'safari 15':'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
  'other':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
 };
 for(const [expected,agent] of Object.entries(agents)){
  const tab=page({agent});tab.fire('error',error('Uncaught Error: x',`${ORIGIN}/app.js`,1,1));
  assert.equal(tab.sent[0]?.body.browser,expected,agent);assert.equal(clientErrorReport(tab.sent[0].body,ORIGIN).browser,expected,'the server keeps it');
 }
});

test('A page left blank is reported too: the notice for a browser too old, or for a page whose scripts did not all run',async()=>{
 const old=page({before:'delete Object.hasOwn;'});await old.ready();
 assert.deepEqual(old.sent.map(item=>item.body),[{message:'Trình duyệt quá cũ, đã hiện thông báo cập nhật (thiếu Object.hasOwn)',page:'/',browser:'edge 141'}]);
 const app={firstChild:null,children:[],appendChild(child){this.children.push(child);}},blank=page({app});await blank.ready();
 assert.equal(app.children[0]?.id,'browser-notice','the notice is shown');
 assert.deepEqual(blank.sent.map(item=>item.body.message),['Trang chưa khởi động xong: mã của trang chưa chạy tới cuối (tải lỗi hoặc dừng giữa chừng), đã hiện thông báo tải lại']);
});

// In Edge: the real index.html, browser-check.js and app.js under the CSP of frontend/_headers; a script of the site that
// fails is added to the page, and the report must reach /api/client-error (connect-src allows it).
const frontend=new URL('../frontend/',import.meta.url),EDGE_ORIGIN='http://hoatri.test';
const CSP=/^\s+Content-Security-Policy: (.+)$/mu.exec(readFileSync(new URL('_headers',frontend),'utf8'))[1];
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
let browser=null;
try{browser=await createRequire(import.meta.url)('playwright-core').chromium.launch({channel:'msedge',headless:true});}catch{}
const skip=browser?false:'Microsoft Edge is not available here';
test.after(()=>browser?.close());
const BOOM=`setTimeout(function(){throw new Error('Hỏng ở '+location.href+' của lan@example.test');},0);Promise.reject(new RangeError('Từ chối lúc khởi động'));`;
test('In Edge under the site\'s CSP, an error of a site script reaches /api/client-error without the address\'s hash',{skip,timeout:60000},async()=>{
 const context=await browser.newContext({viewport:{width:1280,height:800},locale:'vi-VN',reducedMotion:'reduce'}),page=await context.newPage(),reports=[],errors=[];
 page.on('pageerror',item=>errors.push(String(item)));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{(globalThis.__csp||=[]).push(`${event.violatedDirective} ${event.blockedURI}`);}));
 try{
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==EDGE_ORIGIN)return route.abort();
   if(url.pathname==='/api/client-error'){reports.push({method:request.method(),type:request.headers()['content-type'],body:JSON.parse(request.postData())});return route.fulfill({status:204});}
   if(url.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(url.pathname==='/api/me'?{authenticated:false,googleConfigured:false,registration:{mode:'open',domains:[]}}:[])});
   if(url.pathname==='/boom.js')return route.fulfill({status:200,headers:{'Content-Type':'text/javascript','Content-Security-Policy':CSP},body:BOOM});
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1),path=new URL(file,frontend);
   if(!file.includes('..')&&existsSync(path))return route.fulfill({status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':TYPES[file.match(/\.[a-z0-9]+$/u)?.[0]]||'application/octet-stream','Content-Security-Policy':CSP},body:readFileSync(path)});
   return route.fulfill({status:404,contentType:'text/plain',body:'Không tìm thấy.'});
  });
  await page.goto(`${EDGE_ORIGIN}/?nguon=lop11#thu-vien`);
  await page.waitForFunction(()=>document.documentElement.dataset.app==='ready');
  await page.addScriptTag({url:'/boom.js'});
  for(let i=0;i<100&&reports.length<2;i++)await page.waitForTimeout(50);
  const version=(await browser.version()).split('.')[0];
  const byMessage=Object.fromEntries(reports.map(item=>[item.body.message,item]));
  const thrown=byMessage[`Uncaught Error: Hỏng ở ${EDGE_ORIGIN}/ của [email]`],rejected=byMessage['Promise bị từ chối: RangeError: Từ chối lúc khởi động'];
  assert.ok(thrown&&rejected,JSON.stringify(reports));
  assert.equal(thrown.method,'POST');assert.match(thrown.type,/^text\/plain/u,'a simple request: no preflight');
  assert.deepEqual({...thrown.body,source:thrown.body.source?.replace(/:\d+$/u,'')},{message:`Uncaught Error: Hỏng ở ${EDGE_ORIGIN}/ của [email]`,page:'/',browser:`edge ${version}`,source:'/boom.js:1'});
  assert.match(thrown.body.source,/^\/boom\.js:1:\d+$/u);assert.match(rejected.body.source,/^\/boom\.js:1:\d+$/u,'the first frame of the rejection');assert.equal(rejected.body.page,'/');
  assert.equal(reports.length,2,'nothing else was reported');
  assert.deepEqual(await page.evaluate(()=>globalThis.__csp||[]),[]);assert.equal(errors.length,2,'the two failures of boom.js themselves');
 }finally{await context.close();}
});
