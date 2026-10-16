export function parseStudyPageRange(value,total,maxPages=20){
 if(!Number.isInteger(total)||total<1)throw new Error('Tổng số trang PDF không hợp lệ.');
 const pages=new Set(),input=String(value||'').trim();
 if(!input){for(let page=1;page<=total;page++)pages.add(page);}
 else for(const raw of input.split(',')){
  const part=raw.trim(),match=part.match(/^(\d+)(?:\s*-\s*(\d+))?$/u);
  if(!match)throw new Error(`Phạm vi trang không hợp lệ: ${part}`);
  const start=Number(match[1]),end=Number(match[2]||match[1]);
  if(start<1||end>total||start>end)throw new Error(`Trang phải nằm trong khoảng 1-${total}.`);
  for(let page=start;page<=end;page++)pages.add(page);
 }
 if(!pages.size)throw new Error('Hãy chọn ít nhất một trang.');
 if(pages.size>maxPages)throw new Error(`Mỗi lượt thử tối đa ${maxPages} trang để kiểm soát token. Hãy chia thành nhiều phạm vi nhỏ.`);
 return pages;
}
