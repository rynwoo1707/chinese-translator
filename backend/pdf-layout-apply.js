// How readings of scanned-page blocks are stored in a layout manifest. The ocr-blocks route (pdf-layout.js) and the
// sample tool (tools/samples) share it, so a reading written by hand lands exactly where a Gemini reading would.
// readings is recognizePdfBlocks' result: {blocks:[{id,text}],warnings:[string]}, texts already checked. A block whose
// reading failed comes back with its machine OCR text and ocrKept:<code>; the code is stored on the block (it is handled
// all the same, so it is never sent again) and removed when a later call reads that block. A reading used though it looks
// doubtful comes with ocrDoubt:<code>, stored the same way. A failed reading never replaces one Gemini gave earlier, and
// no reading replaces a better one (kept < doubtful < clean): a doubtful reading leaves a clean one as it was.
// The machine text a first Gemini reading replaces is kept as ocrHint: a later re-read is sent and checked against it.
// reread: the call read its blocks again (translation-modes.js reread); chosen: the IDs the browser chose to read again
// (every block of the call when missing). Their ocrRereads grows; the others of their sheets only came along, since a
// sheet is read whole. A re-read that failed leaves a block already handled as it was, and a good one replaces the text
// and its marks.
// keepPixels: the text stored holds nothing to translate though the strip shows Chinese: only unreadable marks ([□]),
// or no Han character where the strip shows two or more Han-sized cells (hanCells, on newer manifests). Such a block is
// not sent for translation; the page keeps its original pixels there (no mask, no [□] printed) and the student is told
// (frontend/study.js). A later reading with text clears it. A reading of formulas alone is no such block: its crops are
// the strip's own pixels.
const rank=value=>typeof value.ocrKept==='string'?0:typeof value.ocrDoubt==='string'?1:2;
export function unreadable(text,hanCells){
 const value=String(text??''),plain=value.replace(/@@PDF_INLINE_\d+@@/gu,' '),formulas=plain!==value&&!/[\p{L}\p{N}□]/u.test(plain);
 return /□/u.test(plain)&&!/[\p{L}\p{N}]/u.test(plain.replace(/\[□\]|□/gu,''))||!formulas&&Number.isInteger(hanCells)&&hanCells>=2&&!/\p{Script=Han}/u.test(plain);
}
export function applyOcrReadings(document,{blocks=[],warnings=[]}={},{reread=false,chosen=null}={}){
 const all=document.pages.filter(p=>p.ocr).flatMap(p=>p.blocks),byId=new Map(all.map(b=>[b.id,b])),counted=chosen?new Set(chosen):null;
 // Every ID is checked before any block changes, so a bad reading never leaves a half-updated manifest.
 if(blocks.some(value=>!byId.has(value?.id)))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
 for(const value of blocks){
  const block=byId.get(value.id),failed=typeof value.ocrKept==='string',read=block.ocrCorrected===true&&typeof block.ocrKept!=='string';
  if(reread&&(!counted||counted.has(value.id)))block.ocrRereads=(Number.isInteger(block.ocrRereads)&&block.ocrRereads>0?block.ocrRereads:0)+1;
  if(failed&&(read||reread&&block.ocrCorrected===true)||read&&rank(value)<rank(block))continue;
  if(!failed&&!read&&typeof block.ocrHint!=='string')block.ocrHint=block.source;
  // A formula's machine text goes in through a function, so a $ it holds ($' or $$ read off an S) is never a pattern.
  block.source=value.text;let text=value.text;for(const inline of block.inlines||[])text=text.replace(inline.token,()=>inline.text);block.text=text;block.ocrCorrected=true;
  if(failed)block.ocrKept=value.ocrKept;else delete block.ocrKept;
  if(!failed&&typeof value.ocrDoubt==='string')block.ocrDoubt=value.ocrDoubt;else delete block.ocrDoubt;
  if(unreadable(value.text,block.hanCells))block.keepPixels=true;else delete block.keepPixels;
  if(/^\d+(?:\.\d+){1,4}\s*[㐀-鿿]/u.test(text)&&text.length<100){block.kind='heading';block.bold=true;}
 }
 document.ocrCorrectedVersion=all.every(b=>b.ocrCorrected)?1:0;document.ocrWarnings=[...(document.ocrWarnings||[]),...warnings];
 return document;
}
