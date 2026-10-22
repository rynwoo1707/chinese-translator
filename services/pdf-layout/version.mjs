// What a PDF service build is, for GET /health, the Worker's deep health check and npm run deploy:
//  layout   the document checks the service and the Worker share (frontend/pdf-box-layout.js and the math-text.js it
//           imports). A Worker and a service with different layout hashes can refuse each other's documents, e.g.
//           "Ảnh trang PDF không hợp lệ." on every scanned page; npm run deploy gives the Worker its own as the var
//           PDF_LAYOUT_VERSION;
//  service  that plus the service's own files in the image: differs whenever the image needs rebuilding (README A.5).
// Hashes are of the text with LF line ends, so a Windows checkout and the Linux image agree.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LAYOUT_FILES=Object.freeze(['frontend/pdf-box-layout.js','frontend/math-text.js']);
export const SERVICE_FILES=Object.freeze([...LAYOUT_FILES,...['server.mjs','engine.mjs','ascii-json.mjs','version.mjs','healthcheck.mjs','tessdata.mjs','prepare-ocr.mjs','extract.py','requirements.txt','Dockerfile'].map(file=>`services/pdf-layout/${file}`)]);
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
// 16 hex characters of SHA-256 over each file's name and text; throws when a file is missing.
export function filesHash(files,root=ROOT){
 const hash=createHash('sha256');
 for(const file of files)hash.update(`${file}\n${readFileSync(join(root,file),'utf8').replace(/\r\n/gu,'\n')}\n`);
 return hash.digest('hex').slice(0,16);
}
// {layout,service}, or null when this checkout lacks the files (a test project, a partial copy).
export function buildVersion(root=ROOT){
 try{return {layout:filesHash(LAYOUT_FILES,root),service:filesHash(SERVICE_FILES,root)};}catch{return null;}
}
// Only the layout hash, for a checkout without the service (npm run deploy on a test project): null when missing.
export function layoutVersion(root=ROOT){try{return filesHash(LAYOUT_FILES,root);}catch{return null;}}
