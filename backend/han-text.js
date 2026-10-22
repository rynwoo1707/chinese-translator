// Text copied out of some PDFs writes Chinese with look-alike code points: Kangxi radicals (U+2F00–2FD5, e.g. the radical
// form of 人), CJK radicals supplement forms (U+2E80–2EF3) and compatibility ideographs (U+F900–FAFF). They print like
// the ordinary characters but match no glossary term, dictionary entry or Han count. unifyHan turns each one whose
// compatibility form (NFKC) is a single unified ideograph into that ideograph and changes nothing else; extract.py does
// the same for the text it takes from PDFs. A radical with no such form (most of the supplement) stays as it is.
const LOOK_ALIKE=/[\u{2E80}-\u{2EF3}\u{2F00}-\u{2FD5}\u{F900}-\u{FAFF}]/gu,UNIFIED=/^\p{Unified_Ideograph}$/u;
export function unifyHan(value){
 return String(value??'').replace(LOOK_ALIKE,character=>{const form=character.normalize('NFKC');return form!==character&&UNIFIED.test(form)?form:character;});
}
// A glossary with its Chinese keys unified (a later key wins where two become one); values are left as they are.
export const unifyGlossaryKeys=glossary=>Object.fromEntries(Object.entries(glossary||{}).map(([key,value])=>[unifyHan(key),value]));
