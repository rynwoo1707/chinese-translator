const CJK=/[\u3400-\u9fff\uf900-\ufaff]/gu;

export function normalizeLocalOcrText(value,{preserveNumbers=false}={}){
 return String(value||'')
  .replace(/[\u00a0\u2000-\u200b\u3000]/gu,' ')
  .split(/\r?\n/u)
  .map(line=>line.replace(/[ \t]+/gu,' ').trim())
  .filter(line=>!line||preserveNumbers||!/^(?:[-–—]\s*)?(?:(?:trang|page)\s*)?\d+(?:\s*[\/／]\s*\d+)?(?:\s*(?:页|頁))?(?:\s*[-–—])?$/iu.test(line))
  .join('\n')
  .replace(/\n{3,}/gu,'\n\n')
  .trim();
}

export function assessLocalOcr({text='',confidence=0}={},options={}){
 const normalized=normalizeLocalOcrText(text,options);
 const compact=normalized.replace(/\s/gu,'');
 const cjk=(compact.match(CJK)||[]).length;
 const score=Number.isFinite(Number(confidence))?Number(confidence):0;
 const usable=compact.length>=45&&cjk>=10;
 const needsGemini=!usable||score<58;
 return {text:normalized,confidence:Math.max(0,Math.min(100,Math.round(score))),characters:compact.length,cjk,usable,needsGemini};
}

export function shouldUseGeminiOcr(mode,assessment){
 if(mode==='gemini')return true;
 if(mode==='local')return false;
 return Boolean(assessment?.needsGemini);
}

// A page the PDF already gives a text layer (its own OCR, a stamp at the edge, or the text around Han in pictures) and a
// reading of its pixels (the device's, or Gemini's in Kỹ nhất). The reading replaces the layer when it holds clearly
// more Han (3% and two more), or when the layer holds under half of it (a poor OCR); otherwise the layer, often a
// careful OCR, stays and gains what it lacks (missingParts). replace false: the layer is the PDF's own text and always
// stays. source: 'reading', 'layer' or 'both'; added: the Han the reading brought.
const hanOf=text=>(String(text||'').match(CJK)||[]).join('');
const hanPairs=text=>{const han=[...hanOf(text)],pairs=[];for(let i=0;i+1<han.length;i++)pairs.push(han[i]+han[i+1]);return pairs;};
const HAN_CHAR=new RegExp(CJK.source,'u');
export function preferredReading(layer,reading,{replace=true}={}){
 const kept=hanOf(layer).length,read=hanOf(reading).length;
 if(replace&&read>kept*1.03+2)return {text:String(reading||''),source:'reading',added:read-kept};
 const layerLines=String(layer||'').split('\n').filter(line=>line.trim()),{after,added}=missingParts(layerLines,String(reading||'').split('\n').map(line=>line.trim()).filter(Boolean));
 if(!added)return {text:String(layer||''),source:'layer',added:0};
 if(replace&&added>read/2)return {text:String(reading||''),source:'reading',added};
 const set=k=>after.get(k)||[];
 return {text:[...set(-1),...layerLines.flatMap((line,k)=>[line,...set(k)])].join('\n'),source:'both',added};
}
// The stretches of a reading its layer lacks, by the layer line each follows (-1: before the first). The two are aligned
// Han by Han in reading order (their longest common sequence; a lone matching character between unmatched ones counts as
// none), so a title, an author or a table row the layer left out is found even where its words come back further down
// the page. A stretch left unmatched (a whole line, even a table's one-character cell, or three Han within a line)
// follows the layer line that holds the Han read before it, unless the layer holds it elsewhere (a block its OCR put in
// another place: 40% of its pairs of Han, or its one character, among the layer's own unmatched ones). A page too long
// to align (over nine million pairs of characters: some 3,000 Han on each side) falls back to sentences and rows with
// under 40% of their pairs found anywhere in the layer.
function missingParts(layerLines,readingLines){
 const L=[],R=[],after=new Map(),put=(anchor,text)=>{if(!after.has(anchor))after.set(anchor,[]);after.get(anchor).push(text);};let added=0;
 layerLines.forEach((line,k)=>{for(const char of line)if(HAN_CHAR.test(char))L.push({char,line:k});});
 readingLines.forEach((line,k)=>{let at=0;for(const char of line){if(HAN_CHAR.test(char))R.push({char,line:k,at,end:at+char.length});at+=char.length;}});
 const n=L.length,m=R.length,width=m+1;
 if(n*m>9e6){
  const sets=layerLines.map(line=>new Set(hanPairs(line))),all=new Set(sets.flatMap(set=>[...set]));let anchor=-1;
  for(const line of readingLines)for(const part of line.match(/[^。！？；!?;]+[。！？；!?;]*/gu)||[]){
   const pairs=hanPairs(part);if(!pairs.length)continue;
   if(pairs.filter(pair=>all.has(pair)).length>=.4*pairs.length){let most=0;sets.forEach((set,k)=>{const shared=pairs.filter(pair=>set.has(pair)).length;if(shared>most){most=shared;anchor=k;}});continue;}
   put(anchor,part.trim());added+=pairs.length+1;
  }
  return {after,added};
 }
 const dp=new Uint16Array((n+1)*width);
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i*width+j]=L[i].char===R[j].char?dp[(i+1)*width+j+1]+1:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 for(let i=0,j=0;i<n&&j<m;){if(L[i].char===R[j].char){L[i].with=j;R[j].with=i;i++;j++;}else if(dp[(i+1)*width+j]>=dp[i*width+j+1])i++;else j++;}
 const lone=R.map((item,j)=>item.with!==undefined&&R[j-1]?.with!==item.with-1&&R[j+1]?.with!==item.with+1);
 lone.forEach((yes,j)=>{if(yes){L[R[j].with].with=undefined;R[j].with=undefined;}});
 const moved=new Set(L.filter(item=>item.with===undefined).map(item=>item.char));for(let i=0;i+1<n;i++)if(L[i].with===undefined&&L[i+1].with===undefined)moved.add(L[i].char+L[i+1].char);
 let anchor=-1;
 for(let j=0;j<m;){
  if(R[j].with!==undefined){anchor=L[R[j].with].line;j++;continue;}
  const start=j,line=R[j].line;while(j<m&&R[j].with===undefined&&R[j].line===line)j++;
  const run=R.slice(start,j),text=readingLines[line],before=R[start-1]?.line===line?R[start-1].end:0,next=R[j]?.line===line?R[j].at:text.length;
  const whole=before===0&&next===text.length,pairs=run.slice(1).map((item,k)=>run[k].char+item.char);
  if(run.length<(whole?1:3)||(pairs.length?pairs.filter(pair=>moved.has(pair)).length>=.4*pairs.length:moved.has(run[0].char)))continue;
  put(anchor,text.slice(before,next).replace(/^[\s，。、；：,.;:！？!?]+/u,'').trim());added+=run.length;
 }
 return {after,added};
}
// The text of a page read from its pixels although its PDF gave a text layer (frontend/pdf-client.js analyzePdf, and the
// server for a page Gemini read): item.reclassified says why. 'hidden', a searchable scan's own OCR, and 'stamp', a stamp
// or running head over a scan, give way to a reading that holds clearly more Han and gain the parts of it they lack
// (preferredReading); 'pictured', a page of text whose Han in pictures or outlines its layer lacks, keeps its layer and
// gains those parts. note: what the reader should check ('' when nothing).
export function scanReading(item,reading,number){
 if(!item?.reclassified)return {text:String(reading||''),note:''};
 const choice=preferredReading(item.text,reading,{replace:item.reclassified!=='pictured'});
 if(item.reclassified==='pictured')return {text:choice.text,note:choice.added?'':`Trang ${number}: chữ nằm trong hình ảnh hoặc nét vẽ chưa nhận dạng được nên có thể chưa dịch; hãy đối chiếu với PDF gốc.`};
 const unread=`Trang ${number}: chưa nhận dạng được ảnh trang nên giữ lớp chữ có sẵn của PDF; hãy đối chiếu với PDF gốc.`;
 if(item.reclassified==='stamp')return {text:choice.text,note:choice.source==='reading'?'':unread};
 if(choice.source==='reading')return {text:choice.text,note:`Trang ${number}: lớp chữ nhận dạng sẵn trong PDF thiếu nhiều chữ so với ảnh trang nên đã dùng bản nhận dạng lại từ ảnh.`};
 if(choice.source==='both')return {text:choice.text,note:`Trang ${number}: lớp chữ nhận dạng sẵn trong PDF thiếu khoảng ${choice.added} chữ so với ảnh trang; đã thêm các dòng đó từ bản nhận dạng lại.`};
 return {text:choice.text,note:hanOf(reading).length*2<hanOf(item.text).length?unread:''};
}
