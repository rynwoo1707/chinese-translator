// A notice instead of a blank page when the page's modules cannot run: a browser older than Hoa Trí supports (iOS and
// Safari before 15.4 lack Array.prototype.at, Object.hasOwn, findLastIndex and <dialog>, which the pages use), or a
// script that did not arrive. A classic script, written for old engines (the CSP allows no inline script); a page loads
// it with defer before its module. The module marks the page started with <html data-app="ready">; on a page with
// <div id="app"> (index.html) a missing mark after the document's scripts ran (DOMContentLoaded) means nothing was drawn.
(function(){
 var doc=document,root=doc.documentElement;
 // Errors the page meets are reported to the server (POST /api/client-error, backend/client-error.js), so the operator
 // learns that a page stopped working on some browser: the error's text, cut at MESSAGE_MAX characters, without e-mail
 // addresses, long codes or what follows ? or # in an address; the file, line and column when it is one of the site's
 // own scripts (an error of another site's script or of an extension is not sent); the page's path, never its query
 // or hash (a reset link's token lives in the hash); the browser's family and major version. At most MAX_REPORTS
 // different reports a page load, and nothing from a file:// page or a browser without navigator.sendBeacon.
 var MAX_REPORTS=5,MESSAGE_MAX=300,PATH_MAX=200,reported=0,seen={};
 var origin=location.protocol+'//'+location.host;
 function scrub(text){
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ')
   .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s?#'"<>()]*)[?#][^\s'"<>()]*/gi,'$1')
   .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,'[email]')
   .replace(/[A-Za-z\d_-]{32,}/g,'[…]')
   .replace(/\s+/g,' ').replace(/^ | $/g,'');
 }
 // "<path>:<line>[:<column>]" of a script of this site ('' without a file or a line), null for another site's script.
 function place(file,line,column){
  if(!file)return '';
  file=String(file);if(file.indexOf(origin+'/')!==0)return null;
  var path=file.slice(origin.length).replace(/[?#][\s\S]*$/,'');
  return line>0&&path.length<=PATH_MAX?path+':'+line+(column>0?':'+column:''):'';
 }
 // The first frame of a stack that is a script of this site; null when the stack names only other sites' scripts.
 function stackPlace(stack){
  stack=String(stack||'');var at=stack.indexOf(origin+'/');
  if(at<0)return /\w:\/\//.test(stack)?null:'';
  var match=/^(\/[^\s:?#()]*)(?:[?#][^\s:()]*)?:(\d+)(?::(\d+))?/.exec(stack.slice(at+origin.length));
  return match?place(origin+match[1],Number(match[2]),Number(match[3])):'';
 }
 function browser(){
  var agent=navigator.userAgent||'',tests=[['zalo',/Zalo/i],['facebook',/FBAN|FBAV|FB_IAB|FBIOS/],['samsung',/SamsungBrowser\/(\d+)/],['opera',/OPR\/(\d+)|Opera\/(\d+)/],['coccoc',/coc_coc_browser\/(\d+)/i],['edge',/Edg(?:e|A|iOS)?\/(\d+)/],['firefox',/(?:Firefox|FxiOS)\/(\d+)/],['chrome',/(?:Chrome|CriOS)\/(\d+)/],['safari',/Version\/(\d+)[\s\S]*Safari\//]];
  for(var i=0;i<tests.length;i++){
   var match=tests[i][1].exec(agent);
   if(match){var major=match[1]||match[2]||'';return tests[i][0]+(/^\d{1,3}$/.test(major)?' '+major:'');}
  }
  return 'other';
 }
 function report(message,source){
  if(reported>=MAX_REPORTS||source===null||!/^https?:$/.test(location.protocol)||typeof navigator.sendBeacon!=='function')return;
  // "Script error." stands for another site's script; a ResizeObserver loop note is harmless and comes from the browser.
  var text=scrub(message).slice(0,MESSAGE_MAX).replace(/ $/,'');if(!text||!source&&/^Script error\.?$/i.test(text)||/ResizeObserver loop/.test(text))return;
  var key=text+'|'+source;if(seen[key])return;seen[key]=true;reported++;
  var body={message:text,page:location.pathname.slice(0,PATH_MAX),browser:browser()};if(source)body.source=source;
  try{navigator.sendBeacon('/api/client-error',JSON.stringify(body));}catch(error){}
 }
 window.addEventListener('error',function(event){
  if(!event||typeof event.message!=='string'&&!event.error)return;
  var error=event.error,message=event.message||error&&String(error)||'';
  report(message,place(event.filename,Number(event.lineno),Number(event.colno)));
 });
 window.addEventListener('unhandledrejection',function(event){
  var reason=event&&event.reason,message=reason&&typeof reason==='object'&&typeof reason.message==='string'?(reason.name||'Error')+': '+reason.message:String(reason);
  report('Promise bị từ chối: '+message,stackPlace(reason&&reason.stack));
 });
 function missing(){
  var lacks=[];
  try{
   if(typeof Array.prototype.at!=='function')lacks.push('Array.prototype.at');
   if(typeof Array.prototype.findLastIndex!=='function')lacks.push('Array.prototype.findLastIndex');
   if(typeof Object.hasOwn!=='function')lacks.push('Object.hasOwn');
   if(typeof window.HTMLDialogElement!=='function'||typeof window.HTMLDialogElement.prototype.showModal!=='function')lacks.push('HTMLDialogElement.showModal');
  }catch(error){lacks.push('?');}
  return lacks;
 }
 function show(old){
  if(doc.getElementById('browser-notice'))return;
  var box=doc.createElement('section'),title=doc.createElement('h1'),text=doc.createElement('p'),app=doc.getElementById('app');
  box.id='browser-notice';box.className='browser-notice';box.setAttribute('role','alert');
  title.textContent=old?'Trình duyệt này quá cũ để mở Hoa Trí':'Chưa tải xong trang Hoa Trí';
  text.textContent=old?'Hãy cập nhật iPhone hoặc iPad lên iOS 15.4 trở lên (Cài đặt → Cài đặt chung → Cập nhật phần mềm), hoặc mở trang bằng bản mới của Chrome, Edge, Firefox hay Safari. Đọc và dịch PDF cần iOS 16.4 trở lên.':'Một phần của trang chưa tải được, thường do mạng chập chờn. Hãy kiểm tra kết nối rồi tải lại trang.';
  box.appendChild(title);box.appendChild(text);
  if(!old){var again=doc.createElement('button');again.type='button';again.textContent='Tải lại trang';again.onclick=function(){location.reload();};box.appendChild(again);}
  if(app&&!app.firstChild)app.appendChild(box);else doc.body.insertBefore(box,doc.body.firstChild);
 }
 function check(){
  var lacks=missing(),old=lacks.length>0;
  if(old){show(true);report('Trình duyệt quá cũ, đã hiện thông báo cập nhật (thiếu '+lacks.join(', ')+')','');}
  else if(doc.getElementById('app')&&root.getAttribute('data-app')!=='ready'){show(false);report('Trang chưa khởi động xong: mã của trang chưa chạy tới cuối (tải lỗi hoặc dừng giữa chừng), đã hiện thông báo tải lại','');}
 }
 // A deferred script runs before the page's modules (and the document is already "interactive" then): the check waits
 // for DOMContentLoaded, which comes after every deferred and module script ran.
 var started=false;
 function once(){if(started)return;started=true;setTimeout(check,0);}
 doc.addEventListener('DOMContentLoaded',once);window.addEventListener('load',once);
 if(doc.readyState==='complete')once();
})();
