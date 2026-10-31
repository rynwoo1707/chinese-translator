// Zalo, Facebook, Messenger, Instagram, TikTok and other apps open links in a browser of their own. Google refuses to sign
// in there (403 disallowed_useragent) and many of them drop downloaded files, so before those two the pages offer to open
// the same address in Chrome or Safari. A guess from the user agent, so it never blocks: the student may still go on.
const APPS=[[/\bZalo/iu,'Zalo'],[/FBAN\/Messenger|MessengerForiOS|FB_IAB\/(?:MESSENGER|Orca)|\bMessengerLite\b/iu,'Messenger'],[/FBAN|FBAV|FB_IAB|FBIOS|FB4A/u,'Facebook'],[/\bInstagram\b/iu,'Instagram'],[/musical_ly|\bTikTok\b|BytedanceWebview|\btrill_\d/iu,'TikTok'],[/\bLine\/\d/u,'LINE'],[/MicroMessenger/iu,'WeChat'],[/KAKAOTALK/iu,'KakaoTalk'],[/Snapchat/iu,'Snapchat'],[/\bTwitter(?:Android)?\b/u,'X (Twitter)']];
const standalone=()=>globalThis.navigator?.standalone===true||Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches);
// {name, ios, android} for a browser inside another app (name is '' when the app is not one of those known), else null.
// Any other Android app's web view says "; wv)"; on iPhone and iPad every real browser (Safari, Chrome, Edge, Firefox)
// names Safari/, and a web view inside an app does not; Hoa Trí added to the home screen does not either, and is no app.
export function inAppBrowser(agent=globalThis.navigator?.userAgent||'',{home=standalone()}={}){
 const ua=String(agent),ios=/\b(?:iPhone|iPad|iPod)\b/u.test(ua),android=/\bAndroid\b/u.test(ua);
 for(const [pattern,name] of APPS)if(pattern.test(ua))return {name,ios,android};
 if(android&&/;\s*wv\)/u.test(ua))return {name:'',ios,android};
 if(ios&&/AppleWebKit/u.test(ua)&&!/\bSafari\//u.test(ua)&&!home)return {name:'',ios,android};
 return null;
}
// What to tell the student: where they are, the browser to open, and how (the menu every such app has). name and menu
// make the one sentence both dialogs say ("Zalo không cho đăng nhập Google. Bấm ⋮ → “Mở bằng trình duyệt”…": app.js;
// "Zalo thường không lưu được tệp tải về. …": study.js).
export function openInBrowserHelp(app){
 const browser=app?.ios?'Safari':'Chrome';
 return {browser,name:app?.name||'Ứng dụng này',menu:app?.ios?'Bấm ⋯ → “Mở trong Safari”':'Bấm ⋮ → “Mở bằng trình duyệt”'};
}
