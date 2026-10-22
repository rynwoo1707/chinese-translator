// pdf.js as the pages load it (/vendor/pdf.mjs and its worker), written by backend/vendor.mjs. The default build calls
// built-ins only the newest browsers have (URL.parse, Promise.try, Uint8Array fromBase64/toHex, Map getOrInsertComputed,
// iterator helpers) and fails on phones a year or two old; the legacy build carries polyfills for them. It still calls
// Promise.withResolvers (Safari/iOS 17.4, Chrome 119), so one line before each file adds it: iPhones left on iOS
// 16.4–17.3 then open PDFs too. Older Safari cannot parse pdf.js at all (class static blocks); bilingual-reader.js tells
// those readers to update. Paths are relative to the project root.
export const PDFJS_FILES=Object.freeze([['node_modules/pdfjs-dist/legacy/build/pdf.mjs','frontend/vendor/pdf.mjs'],['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs','frontend/vendor/pdf.worker.mjs']]);
export const PDFJS_PREFIX="if(typeof Promise.withResolvers!=='function')Object.defineProperty(Promise,'withResolvers',{configurable:true,writable:true,value:function withResolvers(){let resolve,reject;const promise=new this((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}});\n";
export const vendoredPdfjs=source=>PDFJS_PREFIX+String(source);
