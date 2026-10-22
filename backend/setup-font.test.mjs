import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fontCandidates,fontWarning,OTHER_FONTS,WINDOWS_FONT} from './setup-font.mjs';
import {LINUX_FONTS} from '../services/pdf-layout/engine.mjs';

// npm run setup (step 5) reports and writes the font the PDF service will really use: the service's own order.
test('Setup looks for the export font in the PDF service\'s order: Liberation Serif 2, then 1, then DejaVu Serif on Linux',()=>{
 assert.deepEqual(fontCandidates('linux').auto,['/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf','/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf']);
 assert.deepEqual(fontCandidates('linux').auto,[...LINUX_FONTS],'the same list engine.mjs fontPath() walks');
 assert.deepEqual(fontCandidates('win32').auto,[WINDOWS_FONT]);
 // Elsewhere the service walks the same Linux list, so setup writes PDF_FONT_PATH from the other places, Liberation first.
 assert.deepEqual(fontCandidates('darwin').auto,[...LINUX_FONTS]);
 const other=fontCandidates('linux').other;assert.deepEqual(other,[...OTHER_FONTS]);
 assert.ok(other.findIndex(path=>/Liberation/u.test(path))<other.findIndex(path=>/DejaVu/u.test(path)),'Liberation before DejaVu');
 // setup.mjs takes its font lists from here, after it checked that node_modules exists.
 const setup=readFileSync(new URL('./setup.mjs',import.meta.url),'utf8');
 assert.match(setup,/await import\('\.\/setup-font\.mjs'\)/u);assert.match(setup,/choose\('PDF_FONT_PATH',FONTS\.auto,FONTS\.other\)/u);
 assert.doesNotMatch(setup,/fonts-dejavu-core|DejaVuSerif\.ttf/u,'no DejaVu default of its own');
 assert.ok(setup.indexOf("await import('./setup-font.mjs')")>setup.indexOf("existsSync('node_modules/wrangler')"),'imported only after the node_modules check');
});

test('Setup recommends fonts-liberation2 when no font is found or exports would use DejaVu Serif',()=>{
 for(const from of ['auto','other'])assert.equal(fontWarning({from,value:'/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf'}),null,from);
 assert.equal(fontWarning({from:'auto',value:WINDOWS_FONT}),null);
 const missing=fontWarning(null);
 assert.match(missing,/^Không tìm thấy phông Times New Roman, Liberation Serif hay DejaVu Serif: dịch vụ PDF sẽ báo lỗi khi xuất\. /u);assert.match(missing,/sudo apt install fonts-liberation2/u);assert.doesNotMatch(missing,/fonts-dejavu-core/u);
 const wider=fontWarning({from:'auto',value:'/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'});
 assert.match(wider,/^Dịch vụ PDF sẽ xuất bằng DejaVu Serif, rộng hơn Times New Roman khoảng 26% .*sudo apt install fonts-liberation2/u);assert.doesNotMatch(wider,/PDF_FONT_PATH/u);
 // A path the student set keeps winning until it is removed.
 for(const from of ['file','env'])assert.match(fontWarning({from,value:'/usr/share/fonts/TTF/DejaVuSerif.ttf'}),/bỏ PDF_FONT_PATH khỏi \.dev\.vars/u,from);
});
