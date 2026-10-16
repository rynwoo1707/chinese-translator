import test from 'node:test';
import assert from 'node:assert/strict';
import {detectDocumentFigures,extractPageFigures} from '../frontend/document-figures.js';

const block=(text,x,y,width,height=.02)=>({text,box:{x,y,width,height}});
function page(width=600,height=800){
 const image={width,height,data:new Uint8ClampedArray(width*height*4).fill(255)};
 const dot=(x,y)=>{const i=(Math.round(y)*width+Math.round(x))*4;image.data[i]=image.data[i+1]=image.data[i+2]=30;};
 const line=(x1,y1,x2,y2)=>{const n=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));for(let i=0;i<=n;i++)dot(x1+(x2-x1)*i/n,y1+(y2-y1)*i/n);};
 return {image,line,dot};
}
function cube(draw,x=420,y=400){for(const [a,b,c,d] of [[0,20,60,20],[60,20,80,0],[80,0,20,0],[20,0,0,20],[0,20,0,100],[0,100,60,100],[60,100,80,80],[80,80,80,0],[60,20,60,100],[20,0,20,80],[20,80,80,80],[20,80,0,100]])draw(x+a,y+b,x+c,y+d);}

test('finds a captioned cube beside text and includes original point-label extents',()=>{
 const {image,line}=page();cube(line);
 const layout={blocks:[block('空间向量及其线性运算',.1,.45,.54),block('这一段很长的正文应该留在正文中',.1,.52,.54),block('A',.68,.49,.02),block('B',.83,.62,.02),block('图 1.1-2',.72,.65,.1)]};
 const found=detectDocumentFigures(image,layout);
 assert.equal(found.length,1);assert.equal(found[0].caption,'图 1.1-2');
 const box=found[0].box;assert.ok(box.x<=.68);assert.ok(box.x+box.width>=.85);assert.ok(box.y<=.49);assert.ok(box.y+box.height>=.67);assert.ok(box.x>.64);
});
test('sparse diagonal vector survives without replacing it with a drawing',()=>{
 const {image,line}=page();line(410,440,505,395);line(505,395,492,397);line(505,395,497,407);
 const found=detectDocumentFigures(image,{blocks:[block('这是向量旁边的一段正文',.1,.5,.52),block('A',.67,.55,.025),block('B',.84,.48,.025),block('图1.1-1',.72,.59,.11)]});
 assert.equal(found.length,1);assert.ok(found[0].box.height>.12);assert.ok(found[0].box.width>.19);
});
test('does not invent crops for blank pages, captions alone, or body references',()=>{
 const {image,line}=page();const caption=block('图1.1-2',.72,.65,.1);
 assert.deepEqual(detectDocumentFigures(image,{blocks:[caption]}),[]);
 cube(line);assert.deepEqual(detectDocumentFigures(image,{blocks:[block('如图1.1-2，在空间中',.72,.65,.22)]}),[]);
 assert.deepEqual(detectDocumentFigures(image,{blocks:[]}),[]);
 assert.deepEqual(detectDocumentFigures({width:20,height:20,data:[]},{blocks:[caption]}),[]);
});
test('masked OCR body text cannot become a figure and distant rules are rejected',()=>{
 const {image,line}=page();cube(line,200,250);
 assert.deepEqual(detectDocumentFigures(image,{blocks:[block('一大段说明文字不是图形',.3,.3,.22,.15),block('图1.1-2',.38,.48,.12)]}),[]);
 const other=page();other.line(200,100,400,100);
 assert.deepEqual(detectDocumentFigures(other.image,{blocks:[block('图1.1-2',.44,.3,.12)]}),[]);
});
test('captions at the same height stay paired to their own separate figures',()=>{
 const {image,line}=page();cube(line,120,350);cube(line,370,350);
 const found=detectDocumentFigures(image,{blocks:[block('图1.4-20',.22,.59,.12),block('图1.4-21',.64,.59,.12)]});
 assert.equal(found.length,2);assert.ok(found[0].box.x+found[0].box.width<found[1].box.x);
});
test('extractor gracefully skips absent browser bitmap support',async()=>{
 assert.deepEqual(await extractPageFigures(new Blob(['source']),null),[]);
});
