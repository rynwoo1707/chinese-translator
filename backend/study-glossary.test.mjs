import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStudyGlossary} from '../frontend/study-glossary.js';

test('Study terminology accepts Chinese-Vietnamese pairs without a model call',()=>{
 assert.deepEqual(parseStudyGlossary('史料 = sử liệu\n明朝 = triều Minh\n'),{史料:'sử liệu',明朝:'triều Minh'});
});

test('Study terminology rejects malformed, duplicated and prototype keys',()=>{
 for(const value of ['史料', '史料 = ', '史料 = sử liệu\n史料 = tư liệu', '__proto__ = sai'])assert.throws(()=>parseStudyGlossary(value));
 assert.throws(()=>parseStudyGlossary(Array.from({length:31},(_,index)=>`词${index} = từ ${index}`).join('\n')));
});
