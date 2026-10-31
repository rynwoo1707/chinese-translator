// setup.mjs runs in a throw-away copy of the project whose slow or networked steps are stand-ins: the PaddleOCR check,
// frontend/vendor, the OCR data, wrangler's migrations and the dictionary are fakes that succeed, PyMuPDF is a one-line
// package (pip may not reach any index: PIP_NO_INDEX), and the export font is not looked for. wrangler.jsonc,
// .dev.vars.example and deploy.mjs's parser are the real ones. No network, port or Gemini is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {parseJsonc} from './deploy.mjs';

const repo=new URL('../',import.meta.url),read=file=>readFileSync(new URL(file,repo),'utf8');
const SHIPPED=parseJsonc(read('wrangler.jsonc')).vars.GEMINI_MODEL,OK="process.exitCode=0;";
const folders=[];
test.after(()=>{for(const dir of folders)rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
function write(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}

// The project as setup.mjs sees it, with .dev.vars as given (null: none, so setup copies .dev.vars.example).
function project(devVars){
 const root=mkdtempSync(join(tmpdir(),'hoa-tri-setup-'));folders.push(root);
 const files={
  'backend/setup.mjs':read('backend/setup.mjs'),'backend/deploy.mjs':read('backend/deploy.mjs'),'services/pdf-layout/version.mjs':read('services/pdf-layout/version.mjs'),
  'frontend/translation-modes.js':read('frontend/translation-modes.js'),'wrangler.jsonc':read('wrangler.jsonc'),'.dev.vars.example':read('.dev.vars.example'),
  'backend/paddle-assets.mjs':"export const RESTORE_HINT='',TESSERACT_FALLBACK='';export function checkPaddleModels(){return {ok:true};}",
  'backend/setup-font.mjs':'export const fontCandidates=()=>({auto:[],other:[]}),fontWarning=()=>null;',
  'backend/vendor.mjs':OK,'backend/prepare-dictionary.mjs':OK,'services/pdf-layout/prepare-ocr.mjs':OK,'node_modules/wrangler/bin/wrangler.js':OK,
  'frontend/vendor/paddle/worker.js':'','frontend/vendor/tessdata/chi_sim.traineddata.gz':'','frontend/vendor/tessdata/eng.traineddata.gz':'',
  'services/pdf-layout/requirements.txt':'PyMuPDF==1.26.7\n','.runtime/pdf-python/pymupdf-1.26.7.dist-info/METADATA':'Name: PyMuPDF\n','.runtime/pdf-python/pymupdf/__init__.py':"VersionBind = '1.26.7'\n"
 };
 if(devVars!==null)files['.dev.vars']=devVars;
 for(const [file,text] of Object.entries(files))write(join(root,file),text);
 return root;
}
function setup(root){
 const env={...process.env,PIP_NO_INDEX:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'};
 for(const key of Object.keys(env))if(/^(?:NODE_TEST_CONTEXT|PDF_PYTHON|CHROMIUM_EXECUTABLE_PATH|PDF_FONT_PATH)$/iu.test(key))delete env[key];
 const result=spawnSync(process.execPath,[join(root,'backend','setup.mjs')],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:120000});
 const text=`${result.stdout}${result.stderr}`;
 // Every step ran and the closing lines were printed: the warnings come right before them.
 assert.match(text,/\[8\/8\] /u,text);assert.match(text,/Cài đặt xong\.|sửa LỖI ở trên/u,text);
 return text;
}
const warning=local=>`\nCẢNH BÁO: .dev.vars đặt GEMINI_MODEL=${local}, khác model mặc định ${SHIPPED} trong wrangler.jsonc, nên trên máy này mọi "Cách dịch" chưa có model riêng đều dùng ${local}. Không cố ý thì sửa dòng đó thành GEMINI_MODEL=${SHIPPED} rồi chạy lại.`;
const ANY_WARNING=/CẢNH BÁO: \.dev\.vars đặt GEMINI_MODEL/u;

test('setup warns when .dev.vars holds a GEMINI_MODEL other than the wrangler.jsonc default, and leaves the line as it is',()=>{
 assert.match(SHIPPED,/^gemini-/u,'wrangler.jsonc names a default model');
 const old='gemini-2.5-flash'===SHIPPED?'gemini-2.5-flash-lite':'gemini-2.5-flash',root=project(`GEMINI_API_KEY=\nGEMINI_MODEL=${old}\nGEMINI_IMAGE_MODEL=gemini-3.1-flash-image\n`);
 const text=setup(root);
 assert.ok(text.includes(warning(old)),text);
 assert.equal(text.split('GEMINI_MODEL=').length-1,2,`one warning:\n${text}`);
 // Setup adds what is missing and never rewrites a line the person has.
 const after=readFileSync(join(root,'.dev.vars'),'utf8');
 assert.match(after,new RegExp(`^GEMINI_MODEL=${old.replace(/[.]/gu,'\\.')}$`,'mu'));
 assert.match(after,/^PDF_LAYOUT_SERVICE_TOKEN=[0-9a-f]{64}$/mu,'setup still filled what was missing');
});

test('setup says nothing about GEMINI_MODEL when .dev.vars has the default (quoted or not), leaves it empty, or is made from .dev.vars.example',()=>{
 for(const devVars of [`GEMINI_MODEL=${SHIPPED}\n`,`GEMINI_MODEL="${SHIPPED}"\n`,'GEMINI_MODEL=\n',`GEMINI_MODEL=gemini-2.5-flash\nGEMINI_MODEL=${SHIPPED}\n`,null]){
  const root=project(devVars),text=setup(root);
  assert.doesNotMatch(text,ANY_WARNING,`${devVars}\n${text}`);
  if(devVars===null)assert.ok(text.includes('Đã tạo .dev.vars từ .dev.vars.example.'),text);
 }
});
