import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVietnameseText} from './vietnamese-text.js';

test('repairs detached Vietnamese tone marks seen in model output',()=>{
 const broken='Cùng giố`ng như vectơ, ta quy định rằ`ng độ dài bằ`ng 1. Điểm đâ`u và điểm cuố`i. Một sô´ khái niệm.';
 assert.equal(normalizeVietnameseText(broken),'Cùng giống như vectơ, ta quy định rằng độ dài bằng 1. Điểm đầu và điểm cuối. Một số khái niệm.');
});

test('repairs duplicated combining tones and always returns NFC',()=>{
 const broken='giố\u0300ng, đô\u0301i, bă\u0300ng, ne\u0302\u0301u';
 const repaired=normalizeVietnameseText(broken);
 assert.equal(repaired,'giống, đối, bằng, nếu');
 assert.equal(repaired,repaired.normalize('NFC'));
});

test('does not rewrite punctuation, apostrophes, backticks after consonants or LaTeX',()=>{
 const source="Có đúng không? Ký hiệu a' và `vector`; \\(a = b\\).";
 assert.equal(normalizeVietnameseText(source),source);
});
