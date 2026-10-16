import test from 'node:test';
import assert from 'node:assert/strict';
import {bleuScore,evaluateStudyTranslation} from '../frontend/study-evaluation.js';

test('Local study evaluation reports BLEU and exact formula retention without a model',()=>{
 const reference='Elip có phương trình \\(x^2/a^2+y^2/b^2=1\\).',exact=evaluateStudyTranslation(reference,reference);
 assert.equal(exact.bleu,100);assert.equal(exact.formulaRetention,100);assert.equal(exact.formulasMatched,1);
 const altered=evaluateStudyTranslation('Elip có phương trình \\(x/a+y/b=1\\).',reference);
 assert.ok(altered.bleu<100);assert.equal(altered.formulaRetention,0);
 assert.equal(bleuScore('',reference),0);
});
