import {build} from 'esbuild';
import {mkdir,cp} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'dist/server'),{recursive:true});
await build({absWorkingDir:root,entryPoints:[join(root,'backend/worker.js')],outfile:join(root,'dist/server/index.js'),bundle:true,format:'esm',platform:'browser',conditions:['browser'],external:['node:*']});
await cp(join(root,'frontend'),join(root,'dist/client'),{recursive:true});
