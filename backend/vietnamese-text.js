// Gemini occasionally returns a second, detached tone mark after an already
// accented Vietnamese vowel (for example `giố\`ng` or `sô´`). Rebuild only
// those explicit tone sequences and leave ordinary punctuation and formulas
// alone. NFC also fixes valid decomposed Vietnamese from any model/provider.
const VOWELS='aăâeêioôơuưyAĂÂEÊIOÔƠUƯYàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ';
const TONES=new Map([
 ['`','\u0300'],['ˋ','\u0300'],['´','\u0301'],['ˊ','\u0301'],
 ['\u0300','\u0300'],['\u0301','\u0301'],['\u0303','\u0303'],['\u0309','\u0309'],['\u0323','\u0323']
]);
const TONE=/[\u0300\u0301\u0303\u0309\u0323]/gu;
const MALFORMED_TONE=new RegExp(`([${VOWELS}])([\u0060\u00b4\u02ca\u02cb\u0300\u0301\u0303\u0309\u0323])`,'gu');

function withTone(vowel,marker){
 const tone=TONES.get(marker);if(!tone)return vowel+marker;
 const decomposed=vowel.normalize('NFD');
 // A precomposed tone is usually already the intended Vietnamese spelling;
 // a second mark is model noise (giố`ng -> giống), so discard the duplicate.
 if(TONE.test(decomposed)){TONE.lastIndex=0;return vowel;}
 TONE.lastIndex=0;const base=decomposed.replace(TONE,'');
 return (base+tone).normalize('NFC');
}

export function normalizeVietnameseText(value){
 let text=String(value??'').normalize('NFC'),previous;
 // More than one detached mark is rare, but looping makes the repair stable
 // for strings containing more than one detached mark.
 do{previous=text;text=text.replace(MALFORMED_TONE,(_,vowel,marker)=>withTone(vowel,marker));}while(text!==previous);
 return text.normalize('NFC');
}
