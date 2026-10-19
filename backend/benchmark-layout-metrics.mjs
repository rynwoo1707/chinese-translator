// Honest layout metrics without Gemini or any paid API: how much of each page the layout-keeping PDF pipeline keeps.
// (a) the multi-genre synthetic scans with ground truth in tmp/pdf-layout/genre-fixtures: extracted by the current
//     extract.py through the harness cache, translated by its deterministic fake Vietnamese, rendered here by the
//     current engine; (b) one part made by `npm run samples` (default samples/toan-a1/work/c01): its saved Vietnamese
//     PDF, checked against a fresh render of the same manifest and translations. Both folders are local-only.
// usage: node backend/benchmark-layout-metrics.mjs [--only fixtures|sample] [--fixtures physics,novel] [--ratio 1,1.3]
//        [--sample samples/<slug>/work/<part>] [--no-ocr] [--validate-ocr] [--md] [--keep-work] [--out tmp/layout-metrics]
// Each metric is defined in docs/layout-metrics.md; everything measured lands in <out>/metrics.json.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,relative,delimiter} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ocrImageBatches,blockBatches,OCR_LIMITS} from '../frontend/pdf-box-layout.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),argv=process.argv.slice(2);
const flag=name=>argv.includes(name),option=(name,fallback)=>{const i=argv.indexOf(name);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:fallback;};
const ONLY=option('--only',''),RATIOS=option('--ratio','1,1.3').split(',').map(Number).filter(n=>n>0),PICK=option('--fixtures','').split(',').filter(Boolean);
const OUT=resolve(ROOT,option('--out','tmp/layout-metrics')),SAMPLE=resolve(ROOT,option('--sample','samples/toan-a1/work/c01'));
// OCR only estimates what a real page has no ground truth for; on the fixtures it runs to check those estimates.
const OCR_SAMPLE=!flag('--no-ocr'),OCR_FIXTURES=OCR_SAMPLE&&flag('--validate-ocr');
const FIXTURES=join(ROOT,'tmp/pdf-layout/genre-fixtures'),TESSDATA=process.env.TESSDATA_PREFIX||(existsSync(join(ROOT,'.runtime/tessdata'))?join(ROOT,'.runtime/tessdata'):null);
// S: the scale of every page background the extractor writes (image_url in extract.py), so the rendered background
// and the original page meet pixel for pixel. T: largest grey-level change still counted as "unchanged"; outside the
// text boxes the measured change is JPEG noise: 99.9% within 5 levels, none above 9. INK: darker than paper by this much.
const S=1.6,T=16,INK=60,PITCH_SCALE=3,OCR_SCALE=4,ERODE_PT=4,FLOOR=.85;
const HAN=/\p{Script=Han}/gu,hanCount=text=>(String(text||'').match(HAN)||[]).length;
const t0=Date.now(),log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(0).padStart(4)}s]`,...a);

// ---- PyMuPDF helper (inline: rasters, text layer, Tesseract OCR of a grey image) ----
const PY=String.raw`
import json, re, sys
import pymupdf as fitz
HAN = re.compile('[\u3005\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
def raster(t):
    doc, out = fitz.open(t['pdf']), []
    for i in t['pages']:
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(t['scale'], t['scale']), colorspace=fitz.csGRAY, alpha=False)
        name = '%s-%d.gray' % (t['prefix'], i)
        with open(name, 'wb') as f:
            f.write(pix.samples)
        out.append({'file': name, 'width': pix.width, 'height': pix.height})
    return out
def text(t):
    out = []
    for page in fitz.open(t['pdf']):
        chars = [[c['c'], [round(v, 2) for v in c['bbox']]] for b in page.get_text('rawdict')['blocks'] for l in b.get('lines', []) for s in l['spans'] for c in s['chars'] if c['c'].strip()]
        out.append({'width': page.rect.width, 'height': page.rect.height, 'chars': chars, 'images': [[round(v, 2) for v in i['bbox']] for i in page.get_image_info()]})
    return out
def ocr(t):
    w, h, s = t['width'], t['height'], t['scale']
    with open(t['file'], 'rb') as f:
        pix = fitz.Pixmap(fitz.csGRAY, w, h, f.read(), 0)
    pix.set_dpi(round(72 * s), round(72 * s))
    # pdfocr reads nothing from a grey pixmap
    page = fitz.open('pdf', fitz.Pixmap(fitz.csRGB, pix).pdfocr_tobytes(language=t['language'], tessdata=t['tessdata']))[0]
    k, lines = page.rect.width / (w / s), []
    for b in page.get_text('rawdict')['blocks']:
        for l in b.get('lines', []):
            value = ''.join(c['c'] for sp in l['spans'] for c in sp['chars']).strip()
            if value:
                lines.append({'text': value, 'box': [round(v / k, 2) for v in l['bbox']], 'han': len(HAN.findall(value))})
    return lines
ops = {'raster': raster, 'text': text, 'ocr': ocr}
print(json.dumps([ops[t['op']](t) for t in json.load(sys.stdin)], ensure_ascii=False))
`;
function python(tasks){
 return new Promise((done,fail)=>{
  const child=spawn(process.env.PDF_PYTHON||'python',['-c',PY],{windowsHide:true,env:{...process.env,PYTHONPATH:[join(ROOT,'.runtime/pdf-python'),process.env.PYTHONPATH].filter(Boolean).join(delimiter),PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']});
  const out=[];let err='';
  child.stdout.on('data',c=>out.push(c));child.stderr.on('data',c=>{err=(err+c).slice(-6000);});
  child.on('error',error=>fail(new Error(`Không chạy được Python (${error.message}). Chạy "npm run setup" hoặc đặt PDF_PYTHON.`)));
  child.on('close',code=>{if(code)return fail(new Error(`PyMuPDF lỗi (mã ${code}): ${err.split(/\r?\n/u).filter(l=>l&&!/^(Warning|Estimating)/u.test(l)).slice(-2).join(' | ')}`));try{done(JSON.parse(Buffer.concat(out).toString('utf8')));}catch(error){fail(error);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(tasks));
 });
}
async function pool(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i);}}));return out;}
// Tesseract inside MuPDF already uses several cores: more than two OCR processes at once only slow each other down.
let ocrRunning=0;const ocrQueue=[];
async function ocrSlot(fn){if(ocrRunning>=2)await new Promise(go=>ocrQueue.push(go));else ocrRunning++;try{return await fn();}finally{const next=ocrQueue.shift();if(next)next();else ocrRunning--;}}
const ocr=(file,width,height)=>ocrSlot(async()=>(await python([{op:'ocr',file,width,height,scale:OCR_SCALE,language:'chi_sim',tessdata:TESSDATA}]))[0]);

// ---- geometry and pixels (boxes in PDF points from the top-left, rasters 8-bit grey) ----
const inside=(b,p,pad=0)=>p[0]>=b[0]-pad&&p[0]<=b[2]+pad&&p[1]>=b[1]-pad&&p[1]<=b[3]+pad;
const centre=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2],area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const quantile=(list,q)=>{if(!list.length)return null;const s=[...list].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*(s.length-1)+.5))];};
const r3=n=>n==null||!Number.isFinite(n)?null:Math.round(n*1000)/1000,share=(a,b)=>b?a/b:null;
// The output page can be a fraction of a point smaller or larger than the original (Chromium's page box). Both rasters
// share the pt grid from the top-left corner; pixel comparisons stay inside the area both pages have.
function onGrid(img,W,H){if(img.width===W&&img.height===H)return img.data;const out=new Uint8Array(W*H).fill(255);for(let y=0;y<Math.min(H,img.height);y++)out.set(img.data.subarray(y*img.width,y*img.width+Math.min(W,img.width)),y*W);return out;}
function paint(mask,W,H,box,scale,pad=0){const x0=Math.max(0,Math.floor((box[0]-pad)*scale)),y0=Math.max(0,Math.floor((box[1]-pad)*scale)),x1=Math.min(W,Math.ceil((box[2]+pad)*scale)),y1=Math.min(H,Math.ceil((box[3]+pad)*scale));for(let y=y0;y<y1;y++)if(x1>x0)mask.fill(1,y*W+x0,y*W+x1);}
const paperOf=data=>{const tones=new Uint32Array(256);let n=0;for(let i=0;i<data.length;i+=7){tones[data[i]]++;n++;}for(let v=0,seen=0;v<256;v++){seen+=tones[v];if(seen>=n*.75)return v;}return 255;};
function boxPixels(A,B,W,H,box,scale,ink){let inkN=0,inkSame=0,all=0,same=0;const x0=Math.max(0,Math.floor(box[0]*scale)),y0=Math.max(0,Math.floor(box[1]*scale)),x1=Math.min(W,Math.ceil(box[2]*scale)),y1=Math.min(H,Math.ceil(box[3]*scale));for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const p=y*W+x,ok=Math.abs(A[p]-B[p])<=T;all++;if(ok)same++;if(A[p]<ink){inkN++;if(ok)inkSame++;}}return {inkN,inkSame,all,same};}
// Unchanged and at least r pixels away from any change: OCR then sees what the reader still sees as printed, not the
// specks where a Vietnamese stroke happens to land on an erased Han stroke.
function unchangedFar(A,B,W,H,r){
 const sum=new Uint32Array((W+1)*(H+1));
 for(let y=0;y<H;y++){let row=0;for(let x=0;x<W;x++){row+=Math.abs(A[y*W+x]-B[y*W+x])>T?1:0;sum[(y+1)*(W+1)+x+1]=sum[y*(W+1)+x+1]+row;}}
 const out=new Uint8Array(W*H);
 for(let y=0;y<H;y++){const a=Math.max(0,y-r),b=Math.min(H,y+r+1);for(let x=0;x<W;x++){const c=Math.max(0,x-r),d=Math.min(W,x+r+1);out[y*W+x]=sum[b*(W+1)+d]-sum[a*(W+1)+d]-sum[b*(W+1)+c]+sum[a*(W+1)+c]?0:1;}}
 return out;
}
// Printed em size of a paragraph from the scan alone: Han glyphs sit on a 1 em grid along a line, so the strongest
// horizontal period of the ink (autocorrelation pooled over the block's lines) is the em, plus any justification.
function pitchEm(img,W,H,box,scale){
 const x0=Math.max(0,Math.floor(box[0]*scale)),y0=Math.max(0,Math.floor(box[1]*scale)),x1=Math.min(W,Math.ceil(box[2]*scale)),y1=Math.min(H,Math.ceil(box[3]*scale)),w=x1-x0,h=y1-y0;if(w<8||h<8)return null;
 const sample=[];for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2)sample.push(img[y*W+x]);sample.sort((a,b)=>a-b);const limit=sample[Math.floor(sample.length*.9)]-70;
 const ink=new Uint8Array(w*h),rows=new Float64Array(h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=img[(y0+y)*W+x0+x]<limit?1:0;ink[y*w+x]=v;rows[y]+=v;}
 let lines=[],start=-1;for(let y=0;y<=h;y++){const on=y<h&&rows[y]>Math.max(2,w*.004);if(on&&start<0)start=y;if(!on&&start>=0){if(y-start>=3)lines.push([start,y]);start=-1;}}
 if(!lines.length)return null;
 // the upper quartile of line heights: pinyin or footnote rows inside a block are the short ones
 const lh=quantile(lines.map(([a,b])=>b-a),.75);lines=lines.filter(([a,b])=>b-a>=lh*.6&&b-a<=lh*1.6);
 const lo=Math.max(2,Math.floor(lh*.8)),hi=Math.ceil(lh*1.5),acc=new Float64Array(hi+2);let weight=0;
 for(const [a,b] of lines){
  const col=new Float64Array(w);for(let x=0;x<w;x++){let s=0;for(let y=a;y<b;y++)s+=ink[y*w+x];col[x]=s;}
  let first=0,last=w-1;while(first<w&&!col[first])first++;while(last>first&&!col[last])last--;const n=last-first+1;if(n<2*hi)continue;
  let mean=0;for(let x=first;x<=last;x++)mean+=col[x];mean/=n;
  const ac=k=>{let s=0;for(let x=first;x+k<=last;x++)s+=(col[x]-mean)*(col[x+k]-mean);return s/(n-k);},r0=ac(0);if(!(r0>0))continue;
  for(let k=lo-1;k<=hi+1;k++)acc[k]+=n*ac(k)/r0;weight+=n;
 }
 if(!weight||weight<5*lo)return null;
 let best=-Infinity,bk=-1;for(let k=lo;k<=hi;k++){const v=acc[k]/weight;if(v>best&&acc[k]>=acc[k-1]&&acc[k]>=acc[k+1]){best=v;bk=k;}}
 if(bk<0||best<.1)return null;
 const d=(acc[bk-1]-acc[bk+1])/(2*(acc[bk-1]-2*acc[bk]+acc[bk+1]));
 return {em:(bk+(Number.isFinite(d)?Math.max(-.5,Math.min(.5,d)):0))/scale,lines:lines.length};
}
// Ground truth of an extracted block: the GT paragraph holding most of its Han glyphs. Justification only widens a
// glyph's advance, so a low percentile of the advances is the set size.
function truthOf(block,truthPage){
 const own=truthPage.chars.filter(c=>c.cls==='han'&&!c.rt&&inside(block.box,centre(c.ink||c.box)));if(!own.length)return null;
 const votes=new Map();for(const c of own)votes.set(c.block,(votes.get(c.block)||0)+1);const gt=[...votes].sort((a,b)=>b[1]-a[1])[0][0];
 const widths=truthPage.chars.filter(c=>c.block===gt&&c.cls==='han'&&!c.rt).map(c=>c.box[2]-c.box[0]);
 return {em:widths.length>3?quantile(widths,.1):Math.min(...widths),role:truthPage.blocks[gt]?.role||null};
}
const BUCKETS=[['>=1',1,Infinity],['.95-1',.95,1],['.85-.95',.85,.95],['.70-.85',.7,.85],['.60-.70',.6,.7],['<.60',0,.6]];
const bucketsOf=list=>Object.fromEntries(BUCKETS.map(([name,lo,hi])=>[name,list.filter(r=>r>=lo-1e-3&&(hi===Infinity||r<hi-1e-3)).length]));
const kept=r=>r!=null&&r>=FLOOR-1e-3;

// ---- one rendered document: original PDF + manifest + translations + render report + output PDF ----
async function measureDocument({label,kind,document,translations,report,originalPdf,outputPdf,truth,work,ocrPages}){
 await mkdir(work,{recursive:true});const indexes=document.pages.map((_,i)=>i),tag=createHash('sha1').update(label).digest('hex').slice(0,8);
 const [orig,out,origPitch,layer]=await python([
  {op:'raster',pdf:originalPdf,pages:indexes,scale:S,prefix:join(work,`o-${tag}`)},{op:'raster',pdf:outputPdf,pages:indexes,scale:S,prefix:join(work,`t-${tag}`)},
  {op:'raster',pdf:originalPdf,pages:indexes,scale:PITCH_SCALE,prefix:join(work,`p-${tag}`)},{op:'text',pdf:outputPdf}]);
 const fits=new Map(report.flatMap(p=>p.blocks).map(b=>[b.id,b])),translated=new Map(translations.map(t=>[t.id,t.translation]));
 const pages=[];
 for(const [i,page] of document.pages.entries()){
  const W=orig[i].width,H=orig[i].height,A=await readFile(orig[i].file),B=onGrid({data:await readFile(out[i].file),width:out[i].width,height:out[i].height},W,H),Wc=Math.min(W,out[i].width),Hc=Math.min(H,out[i].height);
  const P={data:await readFile(origPitch[i].file),width:origPitch[i].width,height:origPitch[i].height},text=layer[i],tp=truth?.pages[page.number-1]||null;
  const paper=paperOf(A),ink=paper-INK,inlines=page.blocks.flatMap(b=>(b.inlines||[]).map(x=>x.box));
  // font size: against the extractor's estimate (what the renderer starts from) and against the printed size
  const fonts=page.blocks.map(b=>{
   const fit=fits.get(b.id);if(!fit)return null;
   const gt=tp?truthOf(b,tp):null,pitch=pitchEm(P.data,P.width,P.height,b.box,PITCH_SCALE),han=hanCount(b.source),paragraph=han>=20&&pitch&&pitch.lines>=2;
   const printed=tp?gt?.em:paragraph?pitch.em:null,chars=String(translated.get(b.id)||'').replace(/@@PDF_INLINE_\d+@@/gu,'').length;
   return {id:b.id,kind:b.kind||null,role:gt?.role||null,han,chars,rendered:fit.fontSize,estimate:b.fontSize,printed:printed?r3(printed):null,printedFrom:printed?tp?'truth':'pitch':null,pitch:paragraph?r3(pitch.em):null,truthEm:gt?r3(gt.em):null,
    rEstimate:r3(fit.fontSize/b.fontSize),rPrinted:printed?r3(fit.fontSize/printed):null,overflow:!!fit.overflow,shrunk:!!fit.shrunk,grown:fit.grown||null};
  }).filter(Boolean);
  // where the Vietnamese went: text-layer glyphs and formula crops of the output page
  const background=im=>area(im)>=.9*page.width*page.height,crops=text.images.filter(im=>!background(im));
  const zone=new Uint8Array(W*H);for(const b of page.blocks)paint(zone,W,H,b.box,S,2);for(const [,box] of text.chars)paint(zone,W,H,box,S,2);for(const box of crops)paint(zone,W,H,box,S,2);
  let outside=0,outsideSame=0,outsideInk=0,outsideInkSame=0;
  for(let y=0;y<Hc;y++)for(let x=0;x<Wc;x++){const p=y*W+x;if(zone[p])continue;outside++;const ok=Math.abs(A[p]-B[p])<=T;if(ok)outsideSame++;if(A[p]<ink){outsideInk++;if(ok)outsideInkSame++;}}
  // figures: ground-truth artwork, or for a real page the regions the extractor kept as pixels
  const figureBoxes=tp?tp.figures.map(f=>({box:f.ink||f.box,source:'truth',labelsHan:hanCount(f.labels)})):(page.protectedRegions||[]).map(box=>({box,source:'protected'}));
  const figures=figureBoxes.map(f=>{const px=boxPixels(A,B,W,H,f.box,S,ink);return {...f,box:f.box.map(r3),inkPixels:px.inkN,inkSame:r3(share(px.inkSame,px.inkN)),preserved:px.inkN?px.inkSame/px.inkN>=.98:px.same/px.all>=.98};});
  const chars=text.chars.filter(([c])=>!/\s/u.test(c)),inBoxes=chars.filter(([,box])=>page.blocks.some(b=>inside(b.box,centre(box),1))).length;
  const record={page:page.number,width:page.width,height:page.height,outWidth:r3(text.width),outHeight:r3(text.height),blocks:page.blocks.length,fonts,
   overflow:fonts.filter(f=>f.overflow).length,grown:fonts.filter(f=>f.grown).length,textChars:chars.length,textInBoxes:inBoxes,
   outsidePixels:outside,outsideSame,outsideInk,outsideInkSame,figures,inlineCrops:inlines.length,outputCrops:crops.length,
   hanSource:page.blocks.reduce((n,b)=>n+hanCount(b.source),0),hanOutText:chars.filter(([c])=>hanCount(c)).length};
  if(tp){
   // ground truth: every glyph (not pinyin, not inside figure art) by its ink box
   const figs=tp.figures.map(f=>f.ink||f.box),glyphs=tp.chars.filter(c=>!c.rt&&!figs.some(f=>inside(f,centre(c.ink||c.box))));
   let textArea=0,covered=0,han=0,hanCovered=0,hanLeft=0,hanInCrop=0;
   for(const c of glyphs){
    const box=c.ink||c.box,mid=centre(box),replaced=page.blocks.some(b=>inside(b.box,mid))&&!inlines.some(b=>inside(b,mid));
    textArea+=area(box);if(replaced)covered+=area(box);
    if(c.cls!=='han')continue;han++;if(replaced)hanCovered++;
    if(inlines.some(b=>inside(b,mid))){hanLeft++;hanInCrop++;continue;}
    const px=boxPixels(A,B,W,H,box,S,ink);if(px.inkN&&px.inkSame/px.inkN>=.8)hanLeft++;
   }
   // Han the reader still sees at its printed place, prose plus kept formulas and figure labels: the yardstick for the
   // OCR estimate used on real pages
   let hanAll=han,hanLeftAll=hanLeft-hanInCrop;
   for(const f of tp.formulas){const n=typeof f.han==='number'?f.han:hanCount(f.han);if(!n)continue;hanAll+=n;const px=boxPixels(A,B,W,H,f.ink||f.box,S,ink);if(px.inkN&&px.inkSame/px.inkN>=.8)hanLeftAll+=n;}
   for(const f of figures){if(!f.labelsHan)continue;hanAll+=f.labelsHan;if(f.preserved)hanLeftAll+=f.labelsHan;}
   record.truth={textArea:r3(textArea),textAreaCovered:r3(covered),covered:r3(share(covered,textArea)),han,hanCovered,hanLeft,hanInCrop,hanAll,hanLeftAll};
  }
  pages.push({record,ocrInput:{A,B,W,H,paper,origIndex:i}});
 }
 if(ocrPages)await Promise.all(pages.map(async({record,ocrInput})=>{record.ocr=await ocrPage(originalPdf,ocrInput,work,tag);}));
 return {label,kind,pages:pages.map(p=>p.record),gemini:geminiCalls(document)};
}

// OCR of the original page and of what is unchanged on the translated one: same engine, same resolution, same rule
// for what counts as a Chinese line, so the ratio holds even where Tesseract misreads a glyph.
const originalOcr=new Map();
async function ocrPage(pdf,{A,B,W,H,paper,origIndex},work,tag){
 const key=`${pdf}#${origIndex}`;
 if(!originalOcr.has(key))originalOcr.set(key,(async()=>{const [[r]]=await python([{op:'raster',pdf,pages:[origIndex],scale:OCR_SCALE,prefix:join(work,`ocr-${createHash('sha1').update(key).digest('hex').slice(0,8)}`)}]);return {raster:r,lines:await ocr(r.file,r.width,r.height)};})());
 // what changed becomes plain paper of the page's own tone: white patches on grey paper read as Han to Tesseract
 const {raster,lines}=await originalOcr.get(key),keep=unchangedFar(A,B,W,H,Math.round(ERODE_PT*S)),O=await readFile(raster.file),R=Buffer.alloc(raster.width*raster.height,paper);
 for(let y=0;y<raster.height;y++){const sy=Math.min(H-1,Math.floor(y*S/OCR_SCALE));for(let x=0;x<raster.width;x++)if(keep[sy*W+Math.min(W-1,Math.floor(x*S/OCR_SCALE))])R[y*raster.width+x]=O[y*raster.width+x];}
 const file=join(work,`res-${tag}-${origIndex}.gray`);await writeFile(file,R);
 const left=await ocr(file,raster.width,raster.height);
 // Tesseract turns figure strokes and formula art into lone Han characters or Han-sprinkled garbage ("一0O4十4=0O5"):
 // only lines that read as Chinese count.
 const chinese=l=>{const visible=[...l.text].filter(c=>!/[\s\p{P}\p{S}]/u.test(c)).length;return l.han>=2&&l.han>=visible*.5;};
 const han=list=>list.filter(chinese).reduce((s,l)=>s+l.han,0),areaOf=list=>r3(list.filter(chinese).reduce((s,l)=>s+area(l.box),0));
 const textArea=areaOf(lines),textAreaLeft=areaOf(left);
 return {hanOriginal:han(lines),hanLeft:han(left),textArea,textAreaLeft,covered:textArea?r3(1-textAreaLeft/textArea):null,leftLines:left.filter(chinese).map(l=>l.text.slice(0,40)),noiseLines:left.filter(l=>l.han&&!chinese(l)).length};
}

// Gemini requests the study page would make for this manifest, with the app's own batching (no request is made):
// image reading of scanned pages, then block translation.
function geminiCalls(document){
 const pages=document.pages.filter(p=>p.ocr),blocks=pages.flatMap(p=>p.blocks),sheets=pages.flatMap(p=>p.ocrSheets||[]);
 const bytes=url=>Math.round(String(url||'').length*3/4),all=document.pages.flatMap(p=>p.blocks);
 let ocrBatches=[];try{ocrBatches=ocrImageBatches(blocks,OCR_LIMITS.bytes,sheets);}catch{}
 return {ocrRequests:ocrBatches.length,ocrImageKB:Math.round((sheets.reduce((n,s)=>n+bytes(s.image),0)+blocks.filter(b=>!b.ocrSheet).reduce((n,b)=>n+bytes(b.image),0))/1024),translateRequests:blockBatches(all).length,sourceCharacters:all.reduce((n,b)=>n+b.source.length,0)};
}

// ---- summaries ----
function summarize(pages){
 const fonts=pages.flatMap(p=>p.fonts),printed=fonts.filter(f=>f.rPrinted!=null),sum=k=>pages.reduce((n,p)=>n+(p[k]||0),0),figures=pages.flatMap(p=>p.figures);
 const weighted=(list,key)=>share(list.filter(f=>kept(f[key])).reduce((n,f)=>n+f.chars,0),list.reduce((n,f)=>n+f.chars,0));
 const roles={};for(const f of printed){const role=f.role||f.kind||'?';roles[role]??={blocks:0,atLeast85:0};roles[role].blocks++;if(kept(f.rPrinted))roles[role].atLeast85++;}
 const out={pages:pages.length,blocks:fonts.length,
  font:{atLeast85Estimate:fonts.filter(f=>kept(f.rEstimate)).length,atLeast85Printed:printed.filter(f=>kept(f.rPrinted)).length,printedKnown:printed.length,
   charsAtLeast85Estimate:r3(weighted(fonts,'rEstimate')),charsAtLeast85Printed:r3(weighted(printed,'rPrinted')),
   medianEstimate:r3(quantile(fonts.map(f=>f.rEstimate),.5)),minEstimate:r3(Math.min(...fonts.map(f=>f.rEstimate))),medianPrinted:r3(quantile(printed.map(f=>f.rPrinted),.5)),minPrinted:printed.length?r3(Math.min(...printed.map(f=>f.rPrinted))):null,
   bucketsEstimate:bucketsOf(fonts.map(f=>f.rEstimate)),bucketsPrinted:bucketsOf(printed.map(f=>f.rPrinted)),byRole:roles,shrunk:fonts.filter(f=>f.shrunk).length},
  overflow:sum('overflow'),grown:sum('grown'),growth:{maxWidth:r3(Math.max(0,...fonts.map(f=>f.grown?.[0]||0))),maxHeight:r3(Math.max(0,...fonts.map(f=>f.grown?.[1]||0)))},
  textInBoxes:r3(share(sum('textInBoxes'),sum('textChars'))),pageSizeMaxDelta:r3(Math.max(...pages.map(p=>Math.max(Math.abs(p.outWidth-p.width),Math.abs(p.outHeight-p.height))))),
  outsideSame:share(sum('outsideSame'),sum('outsidePixels')),outsideInkSame:share(sum('outsideInkSame'),sum('outsideInk')),
  figures:figures.length,figuresPreserved:figures.filter(f=>f.preserved).length,figureInkSameMin:figures.length?r3(Math.min(...figures.map(f=>f.inkSame??1))):null,
  inlineCrops:sum('inlineCrops'),outputCrops:sum('outputCrops'),hanSource:sum('hanSource'),hanOutText:sum('hanOutText')};
 if(pages.every(p=>p.truth)){const t=k=>pages.reduce((n,p)=>n+p.truth[k],0);out.truth={covered:r3(share(t('textAreaCovered'),t('textArea'))),han:t('han'),hanCovered:t('hanCovered'),hanLeft:t('hanLeft'),hanInCrop:t('hanInCrop'),hanAll:t('hanAll'),hanLeftAll:t('hanLeftAll')};}
 if(pages.every(p=>p.ocr)){const o=k=>pages.reduce((n,p)=>n+p.ocr[k],0);out.ocr={hanOriginal:o('hanOriginal'),hanLeft:o('hanLeft'),covered:o('textArea')?r3(1-o('textAreaLeft')/o('textArea')):null};}
 return out;
}
// The size estimator against ground truth on the paragraphs it would be used for (>=20 Han, >=2 lines): how far to
// trust it on a real scan. Each fixture block counts once, whatever the number of translation ratios.
function pitchValidation(docs){
 const seen=new Map();for(const d of docs)for(const p of d.pages)for(const f of p.fonts)if(f.truthEm&&f.han>=20)seen.set(`${d.name}#${f.id}`,f);
 const all=[...seen.values()],found=all.filter(f=>f.pitch),err=found.map(f=>Math.abs(f.pitch/f.truthEm-1)),errExtractor=all.map(f=>Math.abs(f.estimate/f.truthEm-1));
 return {paragraphs:all.length,estimated:found.length,medianError:r3(quantile(err,.5)),p90Error:r3(quantile(err,.9)),maxError:r3(Math.max(0,...err)),within5:err.filter(e=>e<=.05).length,medianBias:r3(quantile(found.map(f=>f.pitch/f.truthEm-1),.5)),extractorMedianError:r3(quantile(errExtractor,.5)),extractorP90Error:r3(quantile(errExtractor,.9)),extractorWithin10:errExtractor.filter(e=>e<=.1).length};
}

const pct=(v,d=1)=>v==null?'–':`${(v*100).toFixed(d)}%`,frac=(a,b)=>b?`${a}/${b}`:'–';
const coverOf=x=>x.truth?pct(x.truth.covered):x.ocr?`${pct(x.ocr.covered)}*`:'–';
const leftOf=x=>x.truth?`${x.truth.hanLeft}/${x.truth.han}`:x.ocr?`${x.ocr.hanLeft}/${x.ocr.hanOriginal}*`:'–';
const HEAD=['page'.padEnd(18),'blk','>=85%e'.padStart(7),'>=85%p'.padStart(7),'ovf'.padStart(4),'grw'.padStart(4),'inBox'.padStart(7),'cover'.padStart(8),'Han left'.padStart(11),'HanT'.padStart(4),'out=%'.padStart(8),'ink=%'.padStart(8),'figs'.padStart(5),'dW/dH pt'.padStart(12)].join(' ');
function pageLine(name,p){
 const f=p.fonts,printed=f.filter(x=>x.rPrinted!=null);
 return [name.padEnd(18),String(f.length).padStart(3),frac(f.filter(x=>kept(x.rEstimate)).length,f.length).padStart(7),frac(printed.filter(x=>kept(x.rPrinted)).length,printed.length).padStart(7),String(p.overflow).padStart(4),String(p.grown).padStart(4),pct(share(p.textInBoxes,p.textChars)).padStart(7),coverOf(p).padStart(8),leftOf(p).padStart(11),String(p.hanOutText).padStart(4),pct(share(p.outsideSame,p.outsidePixels),2).padStart(8),pct(share(p.outsideInkSame,p.outsideInk),2).padStart(8),frac(p.figures.filter(x=>x.preserved).length,p.figures.length).padStart(5),`${(p.outWidth-p.width).toFixed(2)}/${(p.outHeight-p.height).toFixed(2)}`.padStart(12)].join(' ');
}
function totalLine(s){
 return ['TỔNG'.padEnd(18),String(s.blocks).padStart(3),frac(s.font.atLeast85Estimate,s.blocks).padStart(7),frac(s.font.atLeast85Printed,s.font.printedKnown).padStart(7),String(s.overflow).padStart(4),String(s.grown).padStart(4),pct(s.textInBoxes).padStart(7),coverOf(s).padStart(8),leftOf(s).padStart(11),String(s.hanOutText).padStart(4),pct(s.outsideSame,2).padStart(8),pct(s.outsideInkSame,2).padStart(8),frac(s.figuresPreserved,s.figures).padStart(5),`max ${s.pageSizeMaxDelta}`.padStart(12)].join(' ');
}
function markdown(groups){
 const rows=groups.map(g=>{const s=g.summary;return `| ${g.title} | ${s.pages} | ${s.blocks} | ${frac(s.font.atLeast85Estimate,s.blocks)} | ${frac(s.font.atLeast85Printed,s.font.printedKnown)} | ${s.font.medianPrinted??'–'} / ${s.font.minPrinted??'–'} | ${s.overflow} | ${s.grown} | ${pct(s.textInBoxes)} | ${coverOf(s)} | ${leftOf(s)} | ${s.hanOutText} | ${pct(s.outsideInkSame,2)} | ${frac(s.figuresPreserved,s.figures)} | ${s.pageSizeMaxDelta} |`;});
 const spread=groups.map(g=>`| ${g.title} | ${BUCKETS.map(([n])=>`${g.summary.font.bucketsPrinted[n]} / ${g.summary.font.bucketsEstimate[n]}`).join(' | ')} |`);
 return ['| Bộ đo | Trang | Đoạn | ≥85% so cỡ ước lượng | ≥85% so cỡ in | Trung vị / thấp nhất (so cỡ in) | Tràn | Nới khung | Chữ Việt trong khung gốc | Diện tích chữ Trung được thay | Chữ Hán còn thấy | Chữ Hán trong lớp chữ | Mực ngoài khung giữ nguyên | Hình giữ nguyên | Lệch khổ trang (pt) |','|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',...rows,'',
  `| Tỷ lệ cỡ chữ dựng (so cỡ in / so cỡ ước lượng) | ${BUCKETS.map(([n])=>n).join(' | ')} |`,`|---|${BUCKETS.map(()=>'---').join('|')}|`,...spread].join('\n');
}

// ---- inputs ----
const rendererHash=async()=>createHash('sha256').update(Buffer.concat(await Promise.all(['services/pdf-layout/engine.mjs','frontend/pdf-box-layout.js','frontend/math-text.js'].map(f=>readFile(join(ROOT,f)).catch(()=>Buffer.alloc(0)))))).digest('hex').slice(0,16);
async function engineEnv(){try{const {prepareEngineEnv}=await import(pathToFileURL(join(ROOT,'tools/samples/lib/machine.mjs')).href);prepareEngineEnv();}catch{}}
async function runFixtures(){
 if(!existsSync(join(FIXTURES,'lib/run.mjs')))return log(`Bỏ qua (a): không có ${relative(ROOT,FIXTURES)} (bộ fixture chỉ có trên máy của chủ dự án).`),[];
 await engineEnv();
 const lib=name=>import(pathToFileURL(join(FIXTURES,'lib',name)).href);
 const [{VARIANTS,FIXTURES:LIST},{extract,render},{fakeTranslations}]=await Promise.all([lib('config.mjs'),lib('run.mjs'),lib('fake-vi.mjs')]);
 const chosen=LIST.filter(f=>!PICK.length||PICK.includes(f.name)),docs=[];
 await pool(chosen.flatMap(f=>RATIOS.map(ratio=>({f,ratio}))),3,async({f,ratio})=>{
  const pdf=join(FIXTURES,'fixtures',f.name,'scan.pdf'),truth=JSON.parse(await readFile(join(FIXTURES,'fixtures',f.name,'truth.json'),'utf8'));
  const {document,cached}=await extract(VARIANTS.current,pdf,`1-${f.pages.length}`),translations=fakeTranslations(document,{ratio});
  const result=await render(VARIANTS.current,document,translations);if(!result.pdf)throw new Error(`${f.name}: dựng PDF lỗi: ${result.error}`);
  const outputPdf=join(OUT,`${f.name}-r${ratio}.pdf`);await writeFile(outputPdf,result.pdf);
  const measured=await measureDocument({label:`${f.name} r${ratio}`,kind:'fixture',document,translations,report:result.report,originalPdf:pdf,outputPdf,truth,work:join(OUT,'work'),ocrPages:OCR_FIXTURES});
  Object.assign(measured,{name:f.name,ratio,exportOk:result.ok,extractCached:cached});docs.push(measured);
  log(`  ${f.name} (${f.pages.length} trang), ${ratio} chữ Việt/chữ Hán: xong${result.ok?'':`; xuất thật sẽ LỖI: ${String(result.error).slice(0,100)}`}`);
 });
 return docs.sort((a,b)=>a.ratio-b.ratio||chosen.findIndex(f=>f.name===a.name)-chosen.findIndex(f=>f.name===b.name));
}
async function runSample(){
 const need=['manifest.corrected.json','import-report.json','selected.pdf','render/report.json'].map(f=>join(SAMPLE,f)),missing=need.filter(f=>!existsSync(f));
 if(missing.length)return log(`Bỏ qua (b): thiếu ${missing.map(f=>relative(ROOT,f)).join(', ')} (chạy "npm run samples -- render <mã> <phần>" trước).`),[];
 const [document,imported,saved]=await Promise.all([need[0],need[1],need[3]].map(async f=>JSON.parse(await readFile(f,'utf8'))));
 const name=relative(ROOT,SAMPLE).replaceAll('\\','/'),savedPdf=join(SAMPLE,'render',saved.pdf?.file||`${SAMPLE.split(/[\\/]/u).at(-1)}.vi.pdf`);
 if(!existsSync(savedPdf))return log(`Bỏ qua (b): không có ${relative(ROOT,savedPdf)}.`),[];
 const digest=async file=>existsSync(file)?createHash('sha256').update(await readFile(file)).digest('hex'):null;
 const stale=saved.inputs?.textsSha256!==await digest(join(SAMPLE,'texts.json'))||saved.inputs?.manifestSha256!==await digest(join(SAMPLE,'manifest.json'));
 const measure=(label,report,outputPdf)=>measureDocument({label,kind:'sample',document,translations:imported.translations,report,originalPdf:need[2],outputPdf,work:join(OUT,'work'),ocrPages:OCR_SAMPLE});
 // The same manifest and translations through the engine as it is now: is the saved PDF what the current code gives?
 await engineEnv();const {renderDocument}=await import(pathToFileURL(join(ROOT,'services/pdf-layout/engine.mjs')).href);
 const result=await renderDocument(document,imported.translations,{allowOverflow:true}),code=await rendererHash();
 const fitKey=pages=>JSON.stringify(pages.map(p=>p.blocks.map(b=>[b.id,b.fontSize,b.overflow,b.grown]))),same=fitKey(result.report)===fitKey(saved.pages);
 const docs=[Object.assign(await measure(`${name} saved`,saved.pages,savedPdf),{name,variant:'saved',renderer:saved.code?.renderer||null,currentRenderer:code,stale,sameFitAsCurrent:same})];
 log(`  ${name}: đã đo PDF đã lưu; dựng lại bằng mã hiện tại (${code}) cho ${same?'đúng các cỡ chữ và khung đó':'KẾT QUẢ KHÁC, đo thêm bản dựng lại'}`);
 if(!same){const outputPdf=join(OUT,'sample-rerender.pdf');await writeFile(outputPdf,Buffer.from(result.pdfBase64,'base64'));docs.push(Object.assign(await measure(`${name} rerender`,result.report,outputPdf),{name,variant:'rerender',renderer:code}));}
 return docs;
}

// ---- main ----
await rm(join(OUT,'work'),{recursive:true,force:true});await mkdir(join(OUT,'work'),{recursive:true});
log(`Đo bố cục, không gọi Gemini. Kết quả: ${relative(ROOT,OUT)||OUT}`);
const fixtures=ONLY==='sample'?[]:await runFixtures(),samples=ONLY==='fixtures'?[]:await runSample();
if(!fixtures.length&&!samples.length){console.error('Không có gì để đo: thiếu cả bộ fixture lẫn phần ví dụ mẫu.');process.exit(2);}
const groups=[];
for(const ratio of RATIOS){const docs=fixtures.filter(d=>d.ratio===ratio);if(docs.length)groups.push({title:`Fixture ${docs.length} thể loại, dịch giả ${ratio} chữ Việt/chữ Hán`,docs,summary:summarize(docs.flatMap(d=>d.pages))});}
for(const d of samples)groups.push({title:`${d.name.split('/').slice(1,-2).join('/')||d.name} ${d.name.split('/').at(-1)} (${d.variant==='saved'?'PDF đã lưu':'dựng lại'})`,docs:[d],summary:summarize(d.pages)});
console.log(`\n${HEAD}`);
for(const g of groups){console.log(`--- ${g.title}`);for(const d of g.docs)for(const p of d.pages)console.log(pageLine(`${d.name.split('/').at(-1)} p${p.page}`,p));console.log(totalLine(g.summary));}
console.log('\n>=85%e / >=85%p: đoạn có cỡ chữ dựng ≥85% cỡ bộ tách ước / cỡ in (fixture: ground truth; trang thật: bước chữ Hán, chỉ đoạn ≥20 chữ Hán). * = ước lượng bằng OCR.');
for(const g of groups.filter(g=>g.docs[0].kind==='fixture')){const low=Object.entries(g.summary.font.byRole).filter(([,v])=>v.atLeast85<v.blocks).map(([k,v])=>`${k} ${v.blocks-v.atLeast85}/${v.blocks}`);console.log(`${g.title}: dưới 85% cỡ in theo loại đoạn: ${low.join(', ')||'không có'}.`);}
const validation=fixtures.length?pitchValidation(fixtures):null;
if(validation)console.log(`Cỡ in ước từ bước chữ, so ground truth (${validation.estimated}/${validation.paragraphs} đoạn văn): sai số trung vị ${pct(validation.medianError)}, p90 ${pct(validation.p90Error)}, lớn nhất ${pct(validation.maxError)}. Cỡ bộ tách ước trên cùng các đoạn: trung vị ${pct(validation.extractorMedianError)}, p90 ${pct(validation.extractorP90Error)}.`);
for(const g of groups){const s=g.summary;if(s.truth&&s.ocr)console.log(`${g.title}, OCR so với ground truth: chữ Hán trên trang gốc ${s.ocr.hanOriginal} (GT ${s.truth.hanAll}), còn thấy sau khi dịch ${s.ocr.hanLeft} (GT ${s.truth.hanLeftAll}), diện tích chữ được thay ${pct(s.ocr.covered)} (GT ${pct(s.truth.covered)}).`);}
// A paragraph's verdict on a real page is only as sure as the size estimator: its p90 error on the fixtures, measured
// in this run when they are present, else the value measured when this file was written.
const band=validation?.p90Error??.045;
for(const d of samples){
 if(d.variant==='saved')console.log(`${d.name}: Gemini sẽ cần ${d.gemini.ocrRequests} lượt đọc ảnh (${d.gemini.ocrImageKB} KB ảnh) và ${d.gemini.translateRequests} lượt dịch (${d.gemini.sourceCharacters} ký tự nguồn) theo cách chia lượt của app. PDF đã lưu dựng bằng mã ${d.renderer||'?'}${d.stale?'; texts.json hoặc manifest.json đã đổi sau lần dựng':''}.`);
 const paragraphs=d.pages.flatMap(p=>p.fonts).filter(f=>f.rPrinted!=null);
 if(paragraphs.length){
  d.printedVerdict={band,clearlyKept:paragraphs.filter(f=>f.rPrinted*(1-band)>=FLOOR).map(f=>f.id),clearlyBelow:paragraphs.filter(f=>f.rPrinted*(1+band)<FLOOR).map(f=>f.id)};
  console.log(`  cỡ dựng / cỡ in ước, đoạn ≥20 chữ Hán: ${paragraphs.map(f=>`${f.id} ${f.rendered}/${f.printed}=${f.rPrinted}`).join(', ')}`);
  console.log(`  với sai số ±${pct(band)} của phép ước: chắc chắn ≥85%: ${d.printedVerdict.clearlyKept.length}, chắc chắn <85%: ${d.printedVerdict.clearlyBelow.length} (${d.printedVerdict.clearlyBelow.join(', ')||'không'}), chưa phân định: ${paragraphs.length-d.printedVerdict.clearlyKept.length-d.printedVerdict.clearlyBelow.length}`);
 }
 for(const p of d.pages)if(p.ocr)console.log(`  p${p.page} OCR còn đọc được: ${p.ocr.leftLines.join(' / ')||'không'}${p.ocr.noiseLines?` (bỏ ${p.ocr.noiseLines} dòng nhiễu)`:''}`);
}
if(flag('--md'))console.log(`\n${markdown(groups)}`);
await writeFile(join(OUT,'metrics.json'),JSON.stringify({generatedAt:new Date().toISOString(),seconds:Math.round((Date.now()-t0)/1000),options:{ratios:RATIOS,ocrSample:OCR_SAMPLE,ocrFixtures:OCR_FIXTURES,scale:S,tolerance:T,ink:INK,floor:FLOOR,erodePt:ERODE_PT,ocrScale:OCR_SCALE,sample:relative(ROOT,SAMPLE)},renderer:await rendererHash(),pitchValidation:validation,groups:groups.map(g=>({title:g.title,summary:g.summary})),documents:[...fixtures,...samples]},null,1));
if(!flag('--keep-work'))await rm(join(OUT,'work'),{recursive:true,force:true});
log(`Xong. Chi tiết từng đoạn: ${relative(ROOT,join(OUT,'metrics.json'))}`);
