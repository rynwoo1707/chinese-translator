import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanExtractedPdfText,cleanReaderText} from './pdf-cleaning.js';
import {cleanPdfPages} from '../frontend/pdf-client.js';

const pages=['網站掃描\n第一段沒有\n結束。\n- 1 -','網站掃描\n第二段。\nTrang 2/3','網站掃描\n第三段。\n3'];
test('Client PDF cleaning removes repeated furniture and repairs Chinese visual wraps',()=>{const text=cleanPdfPages(pages);assert.doesNotMatch(text,/網站掃描|Trang 2\/3|- 1 -/);assert.match(text,/第一段沒有結束。/);assert.match(text,/\[Trang PDF 3\]/);});
test('Server OCR cleaning removes repeated headers, page numbers and internal page markers',()=>{const text=pages.map((page,index)=>`[Trang PDF ${index+1}]\n${page}`).join('\n\n');const clean=cleanExtractedPdfText(text);assert.doesNotMatch(clean,/網站掃描|Trang 2\/3|- 1 -|\[Trang/);assert.match(clean,/第一段沒有結束。/);});
test('Reader cleaning removes old PDF markers and bibliographic noise without deleting prose',()=>{const text=`[Trang PDF 1–1]\nDư Hoa\nISBN 978-7-5302-1559-3\nDữ liệu Biên mục trên xuất bản phẩm (CIP): Phải sống\n\n[Trang PDF 4–4]\nMột buổi sáng, Phúc Quý trở về làng.\n\nTrang 5/6`;
 const clean=cleanReaderText(text);assert.doesNotMatch(clean,/Trang PDF|ISBN|CIP|Trang 5\/6|Dư Hoa/);assert.match(clean,/Phúc Quý trở về làng/);
});
