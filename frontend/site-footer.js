// The footer of every public page, one short line: the legal pages, contact, the source code (the PDF layout service
// runs PyMuPDF under the AGPL, so every page links the source of the deployed code) and the licences. The dictionary's
// CC BY-SA attribution is given where its data shows (the Tra chữ Hán panel, hanzi-lookup.js) and in full, with the
// changes made, in the terms page's §12 that "Giấy phép" opens: a link to the required information, as CC BY-SA 4.0
// §3(a) allows. Imported as a module it fills each <footer data-site-footer>; app.js puts footerHtml() in its own layout.
// SOURCE_URL is where the code this site runs is published: the branch (or tag) that is deployed, not the repository's
// default branch. Change this one line when another branch or tag is deployed; the footer, the terms page (its links
// marked data-source-link, see below) and the service's own link follow it.
export const SOURCE_URL='https://github.com/rynwoo1707/chinese-translator/tree/handoff/2026-10-16';
export const SERVICE_SOURCE_URL=`${SOURCE_URL}/services/pdf-layout`;

export function footerHtml(){
 return `<div class="site-footer-inner"><p class="site-footer-brand"><strong>Hoa Trí</strong> © 2026 <span class="site-footer-dot">·</span> <span class="site-footer-tagline">Học liệu Trung – Việt có thể kiểm chứng.</span></p>`
  +`<nav class="site-footer-links" aria-label="Thông tin về Hoa Trí"><a href="/dieu-khoan">Điều khoản sử dụng</a><a href="/quyen-rieng-tu">Quyền riêng tư</a><a href="/quyen-rieng-tu#lien-he">Liên hệ</a><a href="${SOURCE_URL}" target="_blank" rel="noopener">Mã nguồn</a><a href="/dieu-khoan#giay-phep">Giấy phép</a></nav></div>`;
}

// A static page's own links to the source (data-source-link="repo" or "service") take the address from SOURCE_URL; the
// address written in the page is only what a browser without JavaScript sees (legal-pages.test.mjs keeps it equal).
if(typeof document!=='undefined'){
 for(const footer of document.querySelectorAll('footer[data-site-footer]'))footer.innerHTML=footerHtml();
 for(const link of document.querySelectorAll('a[data-source-link]'))link.href=link.dataset.sourceLink==='service'?SERVICE_SOURCE_URL:SOURCE_URL;
}
