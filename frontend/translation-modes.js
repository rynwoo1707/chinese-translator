// "Cách dịch": one profile per mode, shared by the study workspace (browser), the Worker routes and the admin pipeline.
// A profile says how hard Gemini is asked to work: thinking level per step, batch sizes, how scanned pages are cut into
// OCR sheets, and which readings are read again. economy/balanced/quality keep the names stored since migration 0011;
// premium is the school's default (admin) and a student's choice. estimate multiplies the economy token estimate.
export const MODES=['economy','balanced','quality','premium'];
export const DEFAULT_MODE='economy';
export const ADMIN_DEFAULT_MODE='premium';
const PROFILES={
 economy:{label:'Tiết kiệm (ít token nhất)',hint:'Đọc và dịch theo lượt lớn, không suy luận thêm. Hợp với khóa Gemini miễn phí.',
  translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:false,reread:null,
  layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:6,blocks:48},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1},
 balanced:{label:'Cân bằng',hint:'Như Tiết kiệm, thêm một lượt đọc lại những đoạn máy chưa đọc được và dịch lại đoạn còn sót chữ Trung.',
  translateThinking:'minimal',ocrThinking:'minimal',retryThinking:'low',allowRepair:true,strict:true,reread:{kept:true,doubt:false,thinking:'low',maxPerPage:2},
  layoutBatch:{chars:5000,blocks:48},ocrBatch:{images:6,blocks:48},sheets:'standard',textOcr:'hybrid',textChunk:10000,estimate:1.1},
 quality:{label:'Kỹ hơn (tốn token hơn)',hint:'Bật suy luận ngắn, chia lượt nhỏ hơn, đọc lại đoạn đáng ngờ và dịch lại đoạn còn sót chữ Trung.',
  translateThinking:'low',ocrThinking:'low',retryThinking:'low',allowRepair:true,strict:true,reread:{kept:true,doubt:true,thinking:'low',maxPerPage:3},
  layoutBatch:{chars:3000,blocks:24},ocrBatch:{images:4,blocks:24},sheets:'standard',textOcr:'hybrid',textChunk:8000,estimate:1.5},
 premium:{label:'Kỹ nhất (tốn nhiều token nhất)',hint:'Chụp chữ nhỏ và công thức ở độ phân giải cao, suy luận kỹ hơn, đọc lại đoạn đáng ngờ và soát bản dịch từng đoạn. Tốn nhiều token nhất; khóa miễn phí hết lượt trong ngày nhanh hơn.',
  translateThinking:'medium',ocrThinking:'low',retryThinking:'medium',allowRepair:true,strict:true,reread:{kept:true,doubt:true,thinking:'medium',maxPerPage:4},
  layoutBatch:{chars:2000,blocks:16},ocrBatch:{images:3,blocks:16},sheets:'fine',textOcr:'gemini',textChunk:6000,estimate:2.5},
};
export const isMode=value=>MODES.includes(value);
// The school's own mode, from ADMIN_TRANSLATION_MODE (anything else: ADMIN_DEFAULT_MODE): the admin jobs' default, and
// what Xưởng dịch preselects in a browser signed in to /admin.
export function adminModeOf(value){const mode=String(value??'').trim();return isMode(mode)?mode:ADMIN_DEFAULT_MODE;}
// An unknown or missing mode is economy, the cheapest, never a more expensive one.
export function modeProfile(value){const id=isMode(value)?value:DEFAULT_MODE;return {id,...PROFILES[id]};}
export const modeLabel=value=>modeProfile(value).label;
