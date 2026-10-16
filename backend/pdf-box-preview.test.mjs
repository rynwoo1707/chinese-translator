import test from 'node:test';
import assert from 'node:assert/strict';
import {pageMarkup,pageHtml,boxStyles,fitTextBoxes,validateBlockTranslations} from '../frontend/pdf-box-layout.js';

const original='data:image/png;base64,T1JJR0lOQUw=',redacted='data:image/png;base64,UkVEQUNURUQ=',formula='data:image/png;base64,Rk9STVVMQQ==';
const page={number:4,width:600,height:800,original,background:redacted,blocks:[
 {id:'p4-b1',source:'未经翻译的中文段落',box:[50,100,350,160],fontSize:14},
 {id:'p4-b2',source:'向量公式 @@PDF_INLINE_0@@',box:[50,200,350,230],fontSize:12,inlines:[{token:'@@PDF_INLINE_0@@',image:formula,width:24,height:12,text:'a = b'}]}
]};

test('An untranslated page keeps its original pixels without recreating or fitting Chinese source text',()=>{
 const html=pageMarkup(page,new Map([['p4-b1','   '],['unknown','Không thuộc trang này']]));
 assert.ok(html.includes(`src="${original}"`));assert.ok(!html.includes(redacted));
 assert.match(html,/data-translated-blocks="0"/);assert.doesNotMatch(html,/class="pdf-text-box"|class="pdf-text-mask"|未经翻译/);
});

test('A partial preview masks only completed blocks and leaves pending source and figures in the original image',()=>{
 const html=pageMarkup(page,new Map([['p4-b1','Đoạn tiếng Việt <đã dịch>']]));
 assert.match(html,/data-translated-blocks="1"/);assert.equal((html.match(/class="pdf-text-mask"/gu)||[]).length,1);
 assert.equal((html.match(/class="pdf-text-box"/gu)||[]).length,1);
 assert.match(html,/data-block-id="p4-b1"[^>]*left:50pt;top:100pt;width:300pt;height:60pt/);
 assert.match(html,/Đoạn tiếng Việt &lt;đã dịch&gt;/);assert.doesNotMatch(html,/data-block-id="p4-b2"|向量公式/);
});

test('Formula tokens become protected source images only for a translated block',()=>{
 const translations=new Map([['p4-b2','Công thức vectơ @@PDF_INLINE_0@@']]),html=pageMarkup(page,translations);
 assert.match(html,/Công thức vectơ <img class="pdf-inline"/);assert.ok(html.includes(`src="${formula}"`));assert.doesNotMatch(html,/@@PDF_INLINE_0@@/);
 assert.throws(()=>validateBlockTranslations(page.blocks,[{id:'p4-b2',translation:'Công thức mất ký hiệu'}],{complete:false}),/không bảo toàn công thức/);
 assert.throws(()=>validateBlockTranslations(page.blocks,[{id:'p4-b1',translation:'Đã dịch'}]),/Chưa dịch đủ/);
});

test('Font fitting ignores pending boxes from older previews and reports only translated overflow',()=>{
 // A box whose content is always taller than the box, at any font size: it can only overflow.
 const pending={dataset:{pending:'true',blockId:'p4-b1',baseFont:'14'},style:{}};
 const translated={dataset:{pending:'false',blockId:'p4-b2',baseFont:'12'},style:{left:'50pt',top:'200pt',width:'300pt',height:'7pt',fontSize:'12pt'},offsetHeight:0,clientWidth:400,scrollWidth:400,textContent:'x',querySelectorAll:()=>[],
  getBoundingClientRect(){const top=parseFloat(this.style.top)*4/3,height=parseFloat(this.style.height)*4/3;return {left:0,right:400,top,bottom:top+height,width:400,height};}};
 const root={ownerDocument:{createRange:()=>({selectNodeContents(){},getClientRects:()=>[{left:0,right:100,top:0,bottom:1000,width:100,height:1000}]})},querySelectorAll:()=>[pending,translated]};
 const result=fitTextBoxes(root);
 assert.deepEqual(pending.style,{});assert.equal(pending.dataset.overflow,undefined);
 assert.equal(result.length,1);assert.deepEqual({id:result[0].id,fontSize:result[0].fontSize,overflow:result[0].overflow},{id:'p4-b2',fontSize:5.5,overflow:true});assert.equal(translated.dataset.overflow,'true');
});

test('PDF page styling is scoped in the viewer and resets margins only for standalone export',()=>{
 assert.doesNotMatch(boxStyles,/(?:^|\})\*\{|html,body/);
 assert.match(boxStyles,/\.pdf-paper,\.pdf-paper \*/);
 assert.match(pageHtml(page,new Map()),/html,body\{margin:0;padding:0\}/);
});
