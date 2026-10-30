import test from 'node:test';
import assert from 'node:assert/strict';
import {assessLocalOcr,normalizeLocalOcrText,shouldUseGeminiOcr,preferredReading,scanReading} from '../frontend/ocr-policy.js';

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

test('A PDF\'s own OCR layer stays unless a reading holds clearly more Han; the lines it lacks are set in where they stand',()=>{
 const layer=[...'一二三四五六'].map(n=>`第${n}段正文写在这里，内容完整无缺。`).join('\n');
 assert.deepEqual(preferredReading(layer,layer),{text:layer,source:'layer',added:0});
 assert.deepEqual(preferredReading(layer,`${layer}\n物质 名称`),{text:`${layer}\n物质 名称`,source:'both',added:4},'four Han more on ninety: the layer stays and gains the row');
 assert.equal(preferredReading('只有一行。','只有一行。\n还有很多行正文，图层里没有这些内容。').source,'reading');
 assert.deepEqual(preferredReading('',''),{text:'',source:'layer',added:0});
 // A layer as long as the reading that shares under half of it is a poor OCR: the reading replaces it, unless the layer
 // is the PDF's own text (replace false), which stays and gains what it lacks.
 const poor=[...'一二三四五六'].map(()=>'春夏秋冬东南西北上下左右前后。').join('\n');
 assert.equal(preferredReading(poor,layer).source,'reading');
 assert.deepEqual(preferredReading(poor,layer,{replace:false}),{text:`${layer}\n${poor}`,source:'both',added:90});
});

test('A title the layer left out is found by reading order even when its words come back further down the page',()=>{
 // The layer lacks the poem's title and author; the title's words return in the commentary, and the reading set the
 // author on the line of the first verse.
 const layer='第三单元\n古诗二首\n床前灯火照长街，夜半钟声到客船。\n《河边的城》写的是作者在河边的城里思念故乡的心情。\n诗的前两句写景，后两句抒情。';
 const reading='第三单元\n古诗二首\n河边的城\n〔宋〕林远山床前灯火照长街，夜半钟声到客船。\n《河边的城》写的是作者在河边的城里思念故乡的心情。\n诗的前两句写景，后两句抒情。';
 assert.deepEqual(preferredReading(layer,reading,{replace:false}),{text:'第三单元\n古诗二首\n河边的城\n〔宋〕林远山\n床前灯火照长街，夜半钟声到客船。\n《河边的城》写的是作者在河边的城里思念故乡的心情。\n诗的前两句写景，后两句抒情。',source:'both',added:8});
 // A block the reading puts elsewhere is no missing text, and a misread character or two adds nothing.
 const moved='古诗二首\n诗的前两句写景，后两句抒情。\n第三单元\n床前灯火照长街，夜半钟声到客船。\n《河边的城》写的是作者在河边的城里思念故乡的心情。';
 assert.deepEqual(preferredReading(layer,moved,{replace:false}),{text:layer,source:'layer',added:0});
 assert.deepEqual(preferredReading(layer,layer.replace('灯火','灯大').replace('故乡','故多'),{replace:false}),{text:layer,source:'layer',added:0});
 // A table's one-character cells the layer lacks are set in; one the layer holds in another place is not.
 const record='实验记录如下表所示，每组测量三次。\n测量结束后整理数据。';
 assert.deepEqual(preferredReading(record,'实验记录如下表所示，每组测量三次。\n组\n元\n测量结束后整理数据。',{replace:false}),{text:'实验记录如下表所示，每组测量三次。\n组\n元\n测量结束后整理数据。',source:'both',added:2});
 assert.deepEqual(preferredReading(`甲\n${record}`,`${record}\n甲`,{replace:false}),{text:`甲\n${record}`,source:'layer',added:0});
});

test('A page read from its pixels keeps what its text layer gives: a scan\'s OCR or stamp gives way, a page of text keeps its own',()=>{
 const body=[...'一二三四五六'].map(n=>`第${n}段正文写在这里，内容完整无缺。`),layer=body.join('\n');
 // Han in a picture on a page of text: the reading's title and table row are set in, the layer's own lines stay as
 // they are (the reading misread one), even when the reading holds clearly more Han.
 const title='第四章 水的循环与人类活动和城市发展的关系';
 const reading=`${title}\n${body[0].replace('正文','正交')}\n${body.slice(1).join('\n')}\n地区 年降水量 主要水源`;
 assert.deepEqual(scanReading({text:layer,reclassified:'pictured'},reading,2),{text:`${title}\n${layer}\n地区 年降水量 主要水源`,note:''});
 assert.deepEqual(scanReading({text:layer,reclassified:'pictured'},layer,2),{text:layer,note:'Trang 2: chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên có thể chưa dịch; hãy đối chiếu với PDF gốc.'});
 // A stamp over a scan gives way to a reading of the page, and stays, with a note, when the page could not be read.
 const stamp='本文档由资料分享网站整理发布，仅供学习交流使用。';
 assert.deepEqual(scanReading({text:stamp,reclassified:'stamp'},layer,3),{text:layer,note:''});
 assert.deepEqual(scanReading({text:stamp,reclassified:'stamp'},'',3),{text:stamp,note:'Trang 3: chưa nhận dạng được ảnh trang nên giữ lớp chữ có sẵn của PDF; hãy đối chiếu với PDF gốc.'});
 // A scan's own OCR layer that shares little of the reading is replaced, with a note.
 assert.match(scanReading({text:[...'一二三四五六'].map(()=>'春夏秋冬东南西北上下左右前后。').join('\n'),reclassified:'hidden'},layer,4).note,/^Trang 4: lớp chữ nhận dạng sẵn trong PDF thiếu nhiều chữ/u);
 assert.deepEqual(scanReading({text:'',kind:'scan'},'甲乙丙',1),{text:'甲乙丙',note:''},'an ordinary scan keeps its reading');
});
