import test from 'node:test';
import assert from 'node:assert/strict';
import {assessLocalOcr,normalizeLocalOcrText,shouldUseGeminiOcr} from '../frontend/ocr-policy.js';

test('local OCR cleaning removes standalone page numbers without deleting formulas',()=>{
 const text=normalizeLocalOcrText('  第 一 章  空间向量  \n - 12 - \n x² + y² = 1 \n\n\n 定义与例题 ');
 assert.equal(text,'第 一 章 空间向量\nx² + y² = 1\n\n定义与例题');
});

test('local OCR cleaning preserves inferred paragraph boundaries',()=>{
 assert.equal(normalizeLocalOcrText('第一段。\n\n第二段。\n\n\n3'),'第一段。\n\n第二段。');
});

test('hybrid OCR only falls back when local recognition is weak',()=>{
 const good=assessLocalOcr({text:'空间向量与立体几何中，平面方程和直线方程用于研究位置关系。通过坐标运算可以计算两平面的夹角与点到平面的距离。',confidence:82});
 const weak=assessLocalOcr({text:'x 1 ?',confidence:31});
 assert.equal(shouldUseGeminiOcr('hybrid',good),false);
 assert.equal(shouldUseGeminiOcr('hybrid',weak),true);
 assert.equal(shouldUseGeminiOcr('local',weak),false);
 assert.equal(shouldUseGeminiOcr('gemini',good),true);
});
