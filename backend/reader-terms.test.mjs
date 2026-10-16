import test from 'node:test';
import assert from 'node:assert/strict';
import {termMatcher,splitTerms} from '../frontend/reader-terms.js';
import {readerTerms} from './reader-glossary.js';
import worker from './worker.js';

const terms=[{vi:'vectơ',zh:['向量']},{vi:'vectơ pháp tuyến',zh:['法向量']},{vi:'hình lập phương',zh:['正方体']},{vi:'Hình lập phương',zh:['立方体']}];
const marked=(text,seen)=>splitTerms(text,termMatcher(terms),seen).filter(p=>p.term).map(p=>p.text);

test('the longest term wins, matching is case-insensitive and respects Vietnamese word boundaries',()=>{
 assert.deepEqual(marked('Vectơ pháp tuyến của mặt phẳng'),['Vectơ pháp tuyến']);
 assert.deepEqual(marked('Các vectơ đồng phẳng'),['vectơ']);
 assert.deepEqual(marked('vectơn không phải thuật ngữ'),[],'no match inside a longer word');
 const matcher=termMatcher(terms),cube=splitTerms('Hình lập phương',matcher).find(p=>p.term);
 assert.deepEqual(cube.term.zh,['正方体','立方体'],'equal Vietnamese renderings merge their Chinese originals');
});

test('each term is marked once per paragraph, while the rest of the text is preserved exactly',()=>{
 const seen=new Set(),text='vectơ a và vectơ b',pieces=splitTerms(text,termMatcher(terms),seen);
 assert.equal(pieces.map(p=>p.text).join(''),text);assert.equal(pieces.filter(p=>p.term).length,1);
 assert.deepEqual(marked('một vectơ khác',seen),[],'already shown in this paragraph');
 assert.equal(termMatcher([]),null);
});

test('reader terms come from the book glossary plus Math vocabulary, without generic labels or tiny words',()=>{
 const list=readerTerms({genre:'Toán học · STEM',glossary:JSON.stringify({'王老师':'thầy Vương','例题':'ví dụ','角':'góc'})});
 const vi=list.map(t=>t.vi);
 assert.ok(vi.includes('thầy Vương'));assert.ok(vi.includes('vectơ pháp tuyến'));
 assert.ok(!vi.includes('ví dụ'),'textbook section labels are not marked');assert.ok(!vi.includes('góc'),'very short words are not marked');
 assert.deepEqual(readerTerms({genre:'Lịch sử Trung Hoa',glossary:'not json'}),[]);
});

test('the glossary endpoint follows the same read permission as the book',async()=>{
 const stories={pub:{id:'pub',visibility:'public',owner_user_id:null,genre:'Toán học · STEM',glossary:'{}'},priv:{id:'priv',visibility:'private',owner_user_id:'owner',genre:'Toán học · STEM',glossary:'{}'}};
 const DB={prepare(sql){return {bind(id){return {first:async()=>sql.includes('FROM stories')?stories[id]||null:null};}};}};
 const call=id=>worker.fetch(new Request(`https://school.test/api/glossary/${id}`),{DB,FILES:{}},{});
 const open=await call('pub');assert.equal(open.status,200);assert.ok((await open.json()).terms.some(t=>t.vi==='vectơ pháp tuyến'));
 assert.equal((await call('priv')).status,404,'a private book glossary is hidden from other readers');
});
