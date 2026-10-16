// Tesseract traineddata files are a table of components: int32 count, int64 offsets (-1 = absent), then data.
// Component 0 is a plain-text config. The chi_sim config asks for a "chi_sim_vert" sub-language that is not
// installed and sets legacy-engine parameters that MuPDF's LSTM-only Tesseract does not know. Neither can change
// recognition here (the sub-language never loads, the data has no legacy models), but each OCR call prints
// ~11 warning lines that buried the real extraction error. Only those config lines are removed; every model
// component is copied byte for byte.
export const NOISY_CONFIG_KEYS=new Set(['tessedit_load_sublangs','language_model_ngram_on','segsearch_max_char_wh_ratio','language_model_ngram_space_delimited_language','language_model_use_sigmoidal_certainty','language_model_ngram_nonmatch_score','classify_integer_matcher_multiplier','assume_fixed_pitch_char_segment','allow_blob_division']);

function components(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getInt32(0,true);
 if(count<1||count>64||4+count*8>bytes.length)throw new Error('Tệp traineddata không hợp lệ.');
 const offsets=Array.from({length:count},(_,i)=>Number(view.getBigInt64(4+i*8,true)));
 if(offsets.some(offset=>offset!==-1&&(offset<4+count*8||offset>bytes.length)))throw new Error('Tệp traineddata có bảng thành phần không hợp lệ.');
 return {view,count,offsets};
}
function configRange(bytes,offsets){
 const start=offsets[0];if(start===-1)return null;
 const end=Math.min(bytes.length,...offsets.filter(offset=>offset>start));
 return {start,end};
}
const configKey=line=>new TextDecoder().decode(line).trim().split(/\s+/u)[0];

export function noisyConfigLines(bytes){
 const {offsets}=components(bytes),range=configRange(bytes,offsets);if(!range)return [];
 const lines=[];let from=range.start;
 for(let i=range.start;i<=range.end;i++)if(i===range.end||bytes[i]===10){const key=configKey(bytes.subarray(from,i));if(NOISY_CONFIG_KEYS.has(key))lines.push(key);from=i+1;}
 return lines;
}

export function cleanTraineddata(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input),{count,offsets}=components(bytes),range=configRange(bytes,offsets);
 if(!range)return bytes;
 const kept=[];let from=range.start;
 for(let i=range.start;i<=range.end;i++)if(i===range.end||bytes[i]===10){const end=i===range.end?i:i+1;if(!NOISY_CONFIG_KEYS.has(configKey(bytes.subarray(from,i))))kept.push(bytes.subarray(from,end));from=i+1;}
 const config=new Uint8Array(kept.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of kept){config.set(part,at);at+=part.length;}
 const delta=config.length-(range.end-range.start);if(!delta)return bytes;
 const output=new Uint8Array(bytes.length+delta);
 output.set(bytes.subarray(0,range.start),0);output.set(config,range.start);output.set(bytes.subarray(range.end),range.start+config.length);
 const view=new DataView(output.buffer);
 for(let i=0;i<count;i++)if(offsets[i]!==-1&&offsets[i]>=range.end)view.setBigInt64(4+i*8,BigInt(offsets[i]+delta),true);
 return output;
}
