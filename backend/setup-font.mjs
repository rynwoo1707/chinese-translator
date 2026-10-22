// Step 5 of npm run setup: the font the PDF service will set Vietnamese in, looked for in the order the service itself
// uses (services/pdf-layout/engine.mjs fontPath: Times New Roman on Windows; elsewhere Liberation Serif 2, Liberation
// Serif 1, then DejaVu Serif, its LINUX_FONTS). PDF_FONT_PATH wins in both; another font found here is written to
// .dev.vars, since the service would not find it alone. setup.mjs imports this after checking node_modules.
import {LINUX_FONTS} from '../services/pdf-layout/engine.mjs';

export const WINDOWS_FONT='C:/Windows/Fonts/times.ttf';
// Where other systems keep a usable face: macOS's Times New Roman, then Liberation and DejaVu as Fedora and Arch name them.
export const OTHER_FONTS=Object.freeze(['/System/Library/Fonts/Supplemental/Times New Roman.ttf','/Library/Fonts/Times New Roman.ttf','/usr/share/fonts/liberation-serif/LiberationSerif-Regular.ttf','/usr/share/fonts/liberation/LiberationSerif-Regular.ttf','/usr/share/fonts/TTF/LiberationSerif-Regular.ttf','/usr/share/fonts/dejavu-serif-fonts/DejaVuSerif.ttf','/usr/share/fonts/TTF/DejaVuSerif.ttf','/usr/share/fonts/dejavu/DejaVuSerif.ttf']);
export const fontCandidates=(platform=process.platform)=>({auto:platform==='win32'?[WINDOWS_FONT]:[...LINUX_FONTS],other:[...OTHER_FONTS]});

const LIBERATION='Liberation Serif (Debian/Ubuntu: sudo apt install fonts-liberation2; Fedora: liberation-serif-fonts; Arch: ttf-liberation)';
// What setup says about the font it found ({from,value} as setup's choose() gives it, or null), or null when all is well.
export function fontWarning(choice){
 if(!choice)return `Không tìm thấy phông Times New Roman, Liberation Serif hay DejaVu Serif: dịch vụ PDF sẽ báo lỗi khi xuất. Cài phông ${LIBERATION}, hoặc ghi PDF_FONT_PATH=<tệp .ttf có đủ chữ Việt> vào .dev.vars, rồi chạy lại "npm run setup".`;
 // Every fit was tuned with Times New Roman; DejaVu Serif sets the same text about 26% wider.
 if(/DejaVuSerif[^/\\]*$/iu.test(choice.value))return `Dịch vụ PDF sẽ xuất bằng DejaVu Serif, rộng hơn Times New Roman khoảng 26% nên chữ Việt hay bị thu nhỏ hơn bản đã thử. Cài phông ${LIBERATION}${['env','file'].includes(choice.from)?', bỏ PDF_FONT_PATH khỏi .dev.vars (hoặc khỏi biến môi trường)':''} rồi chạy lại "npm run setup".`;
 return null;
}
