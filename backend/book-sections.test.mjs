import test from 'node:test';
import assert from 'node:assert/strict';
import {nextBookTranslationPart,splitBookTranslation} from './book-sections.js';

test('ebook translation parts stop at chapter boundaries and preserve markers outside AI text',()=>{
 const source='[Phần AZW3 1: 第一章]\n第一章\nNội dung một.\n\n[Phần AZW3 2: 第二章]\n第二章\nNội dung hai.';
 const first=nextBookTranslationPart(source,0,3000);
 assert.equal(first.marker,'[Phần AZW3 1: 第一章]');
 assert.equal(first.text.trim(),'第一章\nNội dung một.');
 const second=nextBookTranslationPart(source,first.consumed,3000);
 assert.equal(second.marker,'[Phần AZW3 2: 第二章]');
 assert.equal(second.text.trim(),'第二章\nNội dung hai.');
});

test('translated ebook sections become ordered reader chapters with inferred titles',()=>{
 const result=splitBookTranslation('[Phần EPUB 1: 第一章]\nChương 1: Khởi đầu\n\nNội dung A\n\n[Phần EPUB 2: 第二章]\nChương 2: Hội ngộ\n\nNội dung B');
 assert.deepEqual(result.map(x=>x.title),['Chương 1: Khởi đầu','Chương 2: Hội ngộ']);
 assert.deepEqual(result.map(x=>x.number),[1,2]);
 assert.match(result[1].content,/Nội dung B/);
});
