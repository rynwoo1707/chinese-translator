import test from 'node:test';
import assert from 'node:assert/strict';
import {fileDisposition} from './download-filename.js';
import worker from './worker.js';

test('download headers preserve a Vietnamese title through RFC 5987',()=>{
 const name='Vectơ trong không gian – bài 1.vi.pdf',header=fileDisposition(name);
 assert.match(header,/^inline; filename="hoa-tri\.pdf"; filename\*=UTF-8''/u);
 assert.equal(decodeURIComponent(header.split("UTF-8''")[1]),name);
 assert.match(fileDisposition(name,{attachment:true}),/^attachment;/u);
});
test('download filenames cannot inject headers or path separators',()=>{
 const header=fileDisposition('bài "1"/..\\x\r\nInjected: true.pdf');
 assert.doesNotMatch(header,/[\r\n]/u);
 const name=decodeURIComponent(header.split("UTF-8''")[1]);
 assert.doesNotMatch(name,/["/\\:]/u);
 assert.doesNotThrow(()=>fileDisposition('\ud800.vi.pdf'));
});
test('library PDF downloads use the current renamed chapter title',async()=>{
 let title='Vectơ - bài 1';
 const env={DB:{prepare(sql){return {bind(){return this;},async first(){return sql.includes('FROM chapters')?{title,story_id:'public-story',file_key:'owned.pdf'}:{id:'public-story',visibility:'public'};}};}},FILES:{async get(){return {body:new TextEncoder().encode('%PDF-1.7')};}}};
 const download=async()=>{const response=await worker.fetch(new Request('https://example.test/api/chapter-file/chapter-1'),env,{});assert.equal(response.status,200);return decodeURIComponent(response.headers.get('Content-Disposition').split("UTF-8''")[1]);};
 assert.equal(await download(),title+'.vi.pdf');
 title='Vectơ trong không gian - ôn tập';assert.equal(await download(),title+'.vi.pdf');
});
