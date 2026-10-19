// Preloaded before the tests (CI: NODE_OPTIONS=--import=<this file>; locally:
// node --import ./backend/test-support/no-paid-api.mjs --test backend/*.test.mjs). A test that forgets to replace
// globalThis.fetch with a fake fails at once instead of spending Gemini tokens, logging in to Google or reaching
// Cloudflare. Tests that install their own fake fetch are unaffected; local servers (127.0.0.1) still work.
const GUARD=Symbol.for('hoa-tri.no-paid-api');
const BLOCKED=[/(^|\.)googleapis\.com$/u,/(^|\.)accounts\.google\.com$/u,/(^|\.)api\.cloudflare\.com$/u];

export function blockedHost(input){
 let url;try{url=new URL(typeof input==='string'||input instanceof URL?String(input):input?.url);}catch{return null;}
 return BLOCKED.some(pattern=>pattern.test(url.hostname))?url.hostname:null;
}

const realFetch=globalThis.fetch;
if(typeof realFetch==='function'&&!realFetch[GUARD]){
 const guarded=function fetch(input,init){
  const host=blockedHost(input);
  if(host)return Promise.reject(new Error(`no-paid-api: a test tried to call ${host}. Replace globalThis.fetch with a fake in that test.`));
  return realFetch(input,init);
 };
 guarded[GUARD]=true;
 globalThis.fetch=guarded;
}
