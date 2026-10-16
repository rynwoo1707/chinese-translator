const MATH_EXPRESSION=/\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$\n])+\$/gu;

export function evaluationTokens(value){
 return String(value||'').normalize('NFKC').toLocaleLowerCase('vi-VN').match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)||[];
}
function ngrams(tokens,size){const counts=new Map();for(let index=0;index<=tokens.length-size;index++){const key=tokens.slice(index,index+size).join('\u0001');counts.set(key,(counts.get(key)||0)+1);}return counts;}
export function bleuScore(candidate,reference,maxOrder=4){
 const output=evaluationTokens(candidate),truth=evaluationTokens(reference);if(!output.length||!truth.length)return 0;
 const orders=Math.min(maxOrder,output.length,truth.length),precisions=[];
 for(let size=1;size<=orders;size++){const found=ngrams(output,size),expected=ngrams(truth,size);let total=0,matched=0;for(const [key,count] of found){total+=count;matched+=Math.min(count,expected.get(key)||0);}precisions.push((matched+1)/(total+1));}
 const brevity=output.length>truth.length?1:Math.exp(1-truth.length/output.length),geometric=Math.exp(precisions.reduce((sum,value)=>sum+Math.log(value),0)/precisions.length);
 return Number((brevity*geometric*100).toFixed(2));
}
export function mathExpressions(value){return [...String(value||'').matchAll(MATH_EXPRESSION)].map(match=>match[0]);}
export function evaluateStudyTranslation(candidate,reference){
 const output=evaluationTokens(candidate),truth=evaluationTokens(reference),candidateMath=mathExpressions(candidate),referenceMath=mathExpressions(reference),remaining=new Map();
 for(const formula of candidateMath)remaining.set(formula,(remaining.get(formula)||0)+1);
 let formulasMatched=0;for(const formula of referenceMath){const count=remaining.get(formula)||0;if(count){formulasMatched++;remaining.set(formula,count-1);}}
 return {bleu:bleuScore(candidate,reference),formulaRetention:referenceMath.length?Number((formulasMatched/referenceMath.length*100).toFixed(2)):100,formulasMatched,formulasTotal:referenceMath.length,candidateTokens:output.length,referenceTokens:truth.length};
}
