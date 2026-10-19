// What a translator gets for one part: blocks.json (every block with its hint, boxes and image files, no image data)
// and texts.template.json (the file to fill in as texts.json).
export const tokenNumber=token=>Number(String(token).match(/\d+/u)?.[0]);
export const pageImage=number=>`pages/p${number}.png`;
export const boxesImage=number=>`pages/p${number}-boxes.png`;
export const sheetImage=id=>`sheets/${id}.png`;
export const cropImage=id=>`crops/${id}.png`;
export const inlineImage=(id,token)=>`inlines/${id}-${tokenNumber(token)}.png`;

export function buildListing(document,{slug,chunk,file}){
 const pages=document.pages;
 return {
  version:1,sample:slug,chunk,pages:pages.map(p=>p.number),
  source:{file,sha256:document.sourceSha256||null,totalPages:document.totalPages??null},
  extraction:{extractionVersion:document.extractionVersion??null,warnings:document.warnings||[]},
  pageImages:pages.map(p=>({page:p.number,layer:p.ocr?'ocr':'text',width:p.width,height:p.height,blocks:p.blocks.length,image:pageImage(p.number),boxes:boxesImage(p.number)})),
  sheets:pages.flatMap(p=>(p.ocrSheets||[]).map(s=>({id:s.id,page:p.number,image:sheetImage(s.id),strips:s.strips.map(strip=>({label:strip.label,blockId:strip.blockId}))}))),
  blocks:pages.flatMap(p=>p.blocks.map((b,order)=>({
   id:b.id,page:p.number,order,layer:p.ocr?'ocr':'text',kind:b.kind||null,box:b.box,fontSize:b.fontSize,bold:Boolean(b.bold),
   ...(b.ocrSheet?{sheet:b.ocrSheet,label:b.ocrLabel}:{}),...(p.ocr?{crop:cropImage(b.id)}:{}),
   // hintText: the hint with each formula token replaced by the extractor's reading of it, when there are tokens.
   hint:b.source,...(typeof b.text==='string'&&b.text!==b.source?{hintText:b.text}:{}),
   tokens:(b.inlines||[]).map(i=>({token:i.token,...(i.label?{label:i.label}:{}),ocrText:i.text??'',box:i.box,image:inlineImage(b.id,i.token),trailingPunctuation:i.trail===true}))
  })))
 };
}
// Scanned-page blocks start with the machine hint as their source, to be corrected from the image; text-layer blocks
// take their Chinese from the PDF itself and only need a translation.
export function buildTemplate(document,{slug,chunk}){
 return {version:1,sample:slug,chunk,translator:'',glossary:{},notes:[],blocks:document.pages.flatMap(p=>p.blocks.map(b=>p.ocr?{id:b.id,layer:'ocr',source:b.source,translation:''}:{id:b.id,layer:'text',translation:''}))};
}
