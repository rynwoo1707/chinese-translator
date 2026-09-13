import {build} from 'esbuild';
import {mkdir,cp} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['backend/worker.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',conditions:['browser'],external:['node:*']});
await cp('frontend','dist/client',{recursive:true});
