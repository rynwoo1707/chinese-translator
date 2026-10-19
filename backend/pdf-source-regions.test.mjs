import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceRegions} from '../frontend/pdf-dual-viewer.js';
import {pageMarkup} from '../frontend/pdf-box-layout.js';

test('source regions: PDF-point boxes for Han blocks only, labelled, tokens stripped',()=>{assert.deepEqual(sourceRegions({blocks:[{id:'p1-b1',source:'设平面@@PDF_INLINE_1@@与β',text:'',box:[50,60,300,90]},{id:'p1-b2',source:'x+y=2',text:'x+y=2',box:[50,100,200,120]}]}),[{id:'p1-b1',label:'Đoạn 1: 设平面 与β',style:'left:50pt;top:60pt;width:250pt;height:30pt'}]);});

test('source regions: labels keep the block number, cut long text at 40 characters and skip blocks without a box',()=>{
 const long='第一章'.padEnd(45,'向量')+'𠀀';
 const regions=sourceRegions({blocks:[{id:'p2-b1',source:'Figure 1',text:'Figure 1',box:[0,0,10,10]},{id:'p2-b2',source:'甲',text:'第一节\n  空间向量',box:[10.5,20,110.5,44.25]},{id:'p2-b3',source:long,text:'',box:[0,50,300,90]},{id:'p2-b4',source:'没有坐标',text:'没有坐标'},{id:'p2-b5',source:'坐标不全',box:[1,2,3]}]});
 assert.deepEqual(regions.map(r=>r.id),['p2-b2','p2-b3']);
 assert.equal(regions[0].label,'Đoạn 2: 第一节 空间向量','the displayed text wins over the source; line breaks become spaces');
 assert.equal(regions[0].style,'left:10.5pt;top:20pt;width:100pt;height:24.25pt');
 assert.equal(regions[1].label,`Đoạn 3: ${[...long].slice(0,40).join('')}…`);
 assert.deepEqual(sourceRegions(undefined),[]);assert.deepEqual(sourceRegions({}),[]);
});

test('the exported page markup has no source regions, so the PDF exporter is unchanged',()=>{
 const page={number:1,width:300,height:200,original:'data:image/png;base64,AA==',background:'data:image/png;base64,AA==',blocks:[{id:'p1-b1',source:'我们在银行工作',text:'我们在银行工作',box:[20,20,220,50],fontSize:14,color:'#202020',inlines:[]},{id:'p1-b2',source:'直线与平面',text:'直线与平面',box:[20,60,220,90],fontSize:14,color:'#202020',inlines:[]}]};
 for(const translations of [new Map(),new Map([['p1-b1','Chúng tôi làm việc ở ngân hàng']])]){
  const html=pageMarkup(page,translations);
  assert.equal(html.includes('data-block-id="p1-b1"'),translations.size>0);
  assert.doesNotMatch(html,/pdf-source-region|data-source-block|pdf-original-page/u);
 }
});
