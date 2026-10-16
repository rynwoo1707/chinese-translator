import test from 'node:test';
import assert from 'node:assert/strict';
import {runStudyTranslation} from '../frontend/study-flow.js';

test('Start translation waits for file analysis, prepares uploaded content, then translates',async()=>{
 const order=[];let releaseSelection;
 const selectionTask=new Promise(resolve=>{releaseSelection=()=>{order.push('analyzed');resolve();};});
 const running=runStudyTranslation({selectionTask,requireKey:()=>order.push('key'),needsPreparation:()=>true,hasSource:()=>false,hasFile:()=>true,prepare:async()=>{order.push('ocr');return true;},translate:async()=>order.push('translate')});
 await Promise.resolve();assert.deepEqual(order,[]);
 releaseSelection();assert.equal(await running,true);
 assert.deepEqual(order,['analyzed','key','ocr','translate']);
});

test('Translation does not start when extraction or OCR produced no text',async()=>{
 let translated=false;
 const result=await runStudyTranslation({selectionTask:Promise.resolve(),requireKey:()=>{},needsPreparation:()=>true,hasSource:()=>false,hasFile:()=>true,prepare:async()=>false,translate:async()=>{translated=true;}});
 assert.equal(result,false);assert.equal(translated,false);
});
