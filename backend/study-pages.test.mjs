import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStudyPageRange} from '../frontend/study-pages.js';

test('Study PDF page ranges are ordered, deduplicated and token bounded',()=>{
 assert.deepEqual([...parseStudyPageRange('3, 1-2, 2',148)],[3,1,2]);
 assert.deepEqual([...parseStudyPageRange('',3)],[1,2,3]);
 assert.throws(()=>parseStudyPageRange('0-2',148),/1-148/);
 assert.throws(()=>parseStudyPageRange('20-10',148),/1-148/);
 assert.throws(()=>parseStudyPageRange('1-21',148),/tối đa 20 trang/);
});
