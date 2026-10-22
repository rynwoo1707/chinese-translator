// The footer of every public page: the legal pages, the source code, and the notices the licences ask for (the
// dictionary data is CC BY-SA; the PDF layout service runs PyMuPDF under the AGPL, so its users get a link to the source).
// Imported as a module it fills each <footer data-site-footer>; app.js puts footerHtml() in its own layout.
// SOURCE_URL is where the code this site runs is published: the branch (or tag) that is deployed, not the repository's
// default branch. Change this one line when another branch or tag is deployed; the footer, the terms page (its links
// marked data-source-link, see below) and the service's own link follow it.
export const SOURCE_URL='https://github.com/rynwoo1707/chinese-translator/tree/handoff/2026-10-16';
export const SERVICE_SOURCE_URL=`${SOURCE_URL}/services/pdf-layout`;
const BY_SA='https://creativecommons.org/licenses/by-sa/4.0/deed.vi';

export function footerHtml(){
 return `<div class="site-footer-inner"><p class="site-footer-brand"><strong>Hoa Trí</strong> © 2026 · Học liệu Trung – Việt có thể kiểm chứng.</p>`
  +`<nav class="site-footer-links" aria-label="Thông tin về Hoa Trí"><a href="/dieu-khoan">Điều khoản sử dụng</a><a href="/quyen-rieng-tu">Quyền riêng tư</a><a href="${SOURCE_URL}" target="_blank" rel="noopener">Mã nguồn</a><a href="/quyen-rieng-tu#lien-he">Liên hệ</a></nav>`
  +`<p class="site-footer-notice">Tra chữ Hán dùng dữ liệu phái sinh từ CC-CEDICT (MDBG) và CVDICT (Phong Phan) theo giấy phép <a href="${BY_SA}" target="_blank" rel="noopener">CC BY-SA 4.0</a>, âm Hán Việt từ hanviet-pinyin-wordlist (MIT) và Unihan © Unicode, Inc.; dữ liệu đã được chuyển đổi và gộp. Dịch vụ giữ bố cục PDF dùng PyMuPDF theo giấy phép GNU AGPL-3.0; <a href="${SERVICE_SOURCE_URL}" target="_blank" rel="noopener">mã nguồn của dịch vụ</a> nằm trong thư mục services/pdf-layout. <a href="/dieu-khoan#giay-phep">Giấy phép phần mềm khác</a>.</p></div>`;
}

// A static page's own links to the source (data-source-link="repo" or "service") take the address from SOURCE_URL; the
// address written in the page is only what a browser without JavaScript sees (legal-pages.test.mjs keeps it equal).
if(typeof document!=='undefined'){
 for(const footer of document.querySelectorAll('footer[data-site-footer]'))footer.innerHTML=footerHtml();
 for(const link of document.querySelectorAll('a[data-source-link]'))link.href=link.dataset.sourceLink==='service'?SERVICE_SOURCE_URL:SOURCE_URL;
}
