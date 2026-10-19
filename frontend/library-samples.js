// "Ví dụ mẫu": public books the operator publishes to show what Hoa Trí does. Their translation is made by AI and no
// teacher has reviewed it, so the card and the reader say so. /api/library and /api/read mark them with `sample`; a
// server without that field (or an older book) simply shows no badge. The original page itself is one tap away in the
// reader ("Đọc song ngữ", "Mở PDF gốc"), once the book's assembly confirms the server keeps it.
export const SAMPLE_LABEL='Ví dụ mẫu';
export function isSample(item){const flag=item?.sample;return flag===true||flag===1||flag==='1'||String(item?.source_url||'').startsWith('sample:');}
export const sampleBadge=story=>isSample(story)?`<span class="sample-badge">${SAMPLE_LABEL}</span>`:'';
export function sampleCardNote(story){
 if(!isSample(story))return '';const pages=Number(story.translated_pages)||0;
 return `${pages?`<p class="sample-card-pages">${pages} trang dịch mẫu · giữ bố cục gốc</p>`:''}<p class="sample-card-note">Bản dịch do AI thực hiện để minh họa, chưa qua giáo viên duyệt.</p>`;
}
export const sampleIntro=library=>(library||[]).some(isSample)?'<p class="sample-intro">Mới dùng Hoa Trí? Mở một sách có nhãn “Ví dụ mẫu” để xem bản dịch tiếng Việt giữ nguyên bố cục trang gốc.</p>':'';
export function sampleReaderNotice(story,chapter){
 if(!isSample(story)&&!isSample(chapter))return '';
 const what=chapter?.mime==='application/pdf'?'giữ bố cục trang':'dịch tài liệu';
 return `<aside class="sample-notice" role="note"><strong>${SAMPLE_LABEL}.</strong> Bản dịch do AI thực hiện để minh họa cách Hoa Trí ${what}; chưa được giáo viên duyệt. Hãy đối chiếu với bản gốc khi dùng để học.</aside>`;
}
