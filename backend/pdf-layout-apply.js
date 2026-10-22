// How readings of scanned-page blocks are stored in a layout manifest. The ocr-blocks route (pdf-layout.js) and the
// sample tool (tools/samples) share it, so a reading written by hand lands exactly where a Gemini reading would.
// readings is recognizePdfBlocks' result: {blocks:[{id,text}],warnings:[string]}, texts already checked. A block whose
// reading failed comes back with its machine OCR text and ocrKept:<code>; the code is stored on the block (it is handled
// all the same, so it is never sent again) and removed when a later call reads that block.
export function applyOcrReadings(document,{blocks=[],warnings=[]}={}){
 const all=document.pages.filter(p=>p.ocr).flatMap(p=>p.blocks),byId=new Map(all.map(b=>[b.id,b]));
 // Every ID is checked before any block changes, so a bad reading never leaves a half-updated manifest.
 if(blocks.some(value=>!byId.has(value?.id)))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
 for(const value of blocks){const block=byId.get(value.id);block.source=value.text;let text=value.text;for(const inline of block.inlines||[])text=text.replace(inline.token,inline.text);block.text=text;block.ocrCorrected=true;if(typeof value.ocrKept==='string')block.ocrKept=value.ocrKept;else delete block.ocrKept;if(/^\d+(?:\.\d+){1,4}\s*[㐀-鿿]/u.test(text)&&text.length<100){block.kind='heading';block.bold=true;}}
 document.ocrCorrectedVersion=all.every(b=>b.ocrCorrected)?1:0;document.ocrWarnings=[...(document.ocrWarnings||[]),...warnings];
 return document;
}
