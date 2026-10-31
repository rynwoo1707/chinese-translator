// "Ví dụ mẫu": public books the operator publishes to show what Hoa Trí does. Their translation is made by AI and no
// teacher has reviewed it, so the card and the reader say so. /api/library and /api/read mark them with `sample`; a
// server without that field (or an older book) simply shows no badge. The original page itself is one tap away in the
// reader ("Song ngữ", "Tải về" → "PDF gốc ↗"), once the book's assembly confirms the server keeps it.
export const SAMPLE_LABEL='Ví dụ mẫu';
export function isSample(item){const flag=item?.sample;return flag===true||flag===1||flag==='1'||String(item?.source_url||'').startsWith('sample:');}
export const sampleBadge=story=>isSample(story)?`<span class="sample-badge">${SAMPLE_LABEL}</span>`:'';
export function sampleCardNote(story){
 return isSample(story)?'<p class="sample-card-note">AI dịch · chưa qua giáo viên duyệt</p>':'';
}
export function sampleReaderNotice(story,chapter){
 if(!isSample(story)&&!isSample(chapter))return '';
 return `<aside class="note sample-notice" role="note"><strong>${SAMPLE_LABEL}.</strong> AI dịch, chưa qua giáo viên duyệt; hãy đối chiếu bản gốc.</aside>`;
}
