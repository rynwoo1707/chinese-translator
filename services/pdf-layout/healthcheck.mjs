// HEALTHCHECK of the image and of docker-compose.yml: GET /health on this container with its own token, exit 0 or 1.
//   node services/pdf-layout/healthcheck.mjs /health PDF_LAYOUT_SERVICE_TOKEN   (path, name of the token variable)
// Docker only marks a container unhealthy; it never restarts one whose process still runs (a hung service). After
// PDF_HEALTH_RESTART_AFTER failed checks in a row (default 4: about a minute at the 15 s interval; 0 turns it off) the
// check stops the service, and the restart policy (unless-stopped) starts the container again. This needs an init
// process as PID 1 (compose init: true, docker run --init), which passes the signal on to the service.
import {readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FAILURES_FILE=join(tmpdir(),'hoa-tri-pdf-health-failures');
const restartAfter=value=>{const text=String(value??'').trim();return /^\d{1,3}$/u.test(text)?Number(text):4;};
// Returns the exit code; restart() runs once the failures in a row reach the limit (and the count starts again).
export async function healthCheck({url,token,limit=restartAfter(process.env.PDF_HEALTH_RESTART_AFTER),file=FAILURES_FILE,fetch=globalThis.fetch,restart=()=>process.kill(1,'SIGTERM'),timeoutMs=8000}={}){
 try{
  const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(timeoutMs)});
  if(response.ok){rmSync(file,{force:true});return 0;}
 }catch{}
 let failures=1;try{failures+=Number(readFileSync(file,'utf8'))||0;}catch{}
 if(limit>0&&failures>=limit){rmSync(file,{force:true});try{restart();}catch{}}
 else try{writeFileSync(file,String(failures));}catch{}
 return 1;
}

// Started as a program, also through a symlinked or junction folder: compared as real paths (see server.mjs).
const realPath=path=>{const real=realpathSync(path);return process.platform==='win32'?real.toLowerCase():real;};
const started=()=>{try{return Boolean(process.argv[1])&&realPath(process.argv[1])===realPath(fileURLToPath(import.meta.url));}catch{return false;}};
if(started()){
 const [path='/health',tokenName='PDF_LAYOUT_SERVICE_TOKEN']=process.argv.slice(2);
 process.exitCode=await healthCheck({url:`http://127.0.0.1:${Number(process.env.PORT)||8091}${path}`,token:process.env[tokenName]||''});
}
