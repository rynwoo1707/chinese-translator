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
