// work/RULES.md: the brief for whoever writes texts.json (a Claude agent or a person). The OCR and translation rules are
// embedded word for word from the app, so a sample is read and translated by the same rules as a student's PDF.
import {OCR_RULES,SHEET_OCR_RULES} from '../../../backend/pdf-block-ocr.js';
import {BLOCK_TRANSLATION_RULES} from '../../../backend/pdf-block-translation.js';
import {relevantGlossary} from '../../../backend/ai.js';
import {builtInGlossary,subjectOf,termsInText} from '../../../backend/subject-glossaries.js';

// The glossary translatePdfBlocks would send for this text: the book's own terms first, then the subject's built-in ones.
// A term counts only where it is not part of a longer one (termsInText): the translator is never told to write the
// short term's Vietnamese inside a compound (质量 = khối lượng inside 质量数 = số khối).
export function rulesGlossary(sample,text,limit=300){
 const manual=sample.glossary||{},builtIn=builtInGlossary(sample.domain);
 return {manual,terms:relevantGlossary(termsInText({...builtIn,...manual},text),text,{priority:manual,builtIn},limit)};
}
const fence=text=>'```text\n'+text+'\n```';
const cell=value=>String(value).replace(/\|/gu,'\\|');

export function rulesMarkdown(sample,chunks,{text=''}={}){
 const {manual,terms}=rulesGlossary(sample,text),run=command=>`npm run samples -- ${command} ${sample.slug}`;
 const rows=Object.entries(terms).map(([zh,vi])=>`| ${cell(zh)} | ${cell(vi)} | ${Object.hasOwn(manual,zh)?'sách':'có sẵn'} |`);
 return `# Quy tắc dịch ví dụ mẫu “${sample.title||sample.slug}”

Tệp do \`${run('extract')}\` tạo; lần tách sau sẽ ghi đè. Bản dịch là ví dụ công khai trên trang chủ Hoa Trí, được ghi rõ là do AI thực hiện.

## Các phần
${chunks.map(c=>`- \`${c.id}\` · ${c.title} · ${c.blocks} đoạn${c.ocrBlocks?` (${c.ocrBlocks} đoạn trang scan)`:''}`).join('\n')}

## Việc cần làm cho mỗi phần \`work/<phần>/\`
1. Đọc \`blocks.json\`. Mỗi trang có \`pages/pN.png\` (trang gốc) và \`pages/pN-boxes.png\` (khung đỏ: mã đoạn; khung cam: công thức với nhãn @N).
2. Trang scan (\`"layer": "ocr"\`): \`hint\` là chữ OCR máy, thường sai. Đọc ảnh gộp \`sheets/\` (mỗi dải có nhãn #N là một đoạn, xem \`strips\`) hoặc \`crops/<mã đoạn>.png\`, rồi ghi chữ Trung đúng vào \`source\` theo **Quy tắc đọc ảnh**. Để \`null\` chỉ khi \`hint\` đã đúng từng chữ.
3. Dịch mọi đoạn sang tiếng Việt vào \`translation\` theo **Quy tắc dịch**. Trang có lớp chữ (\`"layer": "text"\`) lấy chữ Trung từ \`hint\`; không ghi \`source\`.
4. Chép \`texts.template.json\` thành \`texts.json\` trong cùng thư mục rồi điền. Chỉ ghi \`texts.json\` của phần mình; không sửa tệp khác.
5. Chạy \`${run('check')} <phần>\` đến khi 0 lỗi, đọc kỹ cảnh báo.
6. Chạy \`${run('render')} <phần>\`. Nếu chữ Việt không vừa khung: dịch gọn hơn (không bỏ ý) rồi chạy lại; \`--preview-overflow\` cho xem bản lỗi mà không đăng được.
7. So \`render/pN.compare.png\` (trái: gốc, phải: bản dịch) với trang gốc: thiếu chữ, sai vị trí công thức, chữ Hán còn sót.

## texts.json
\`\`\`json
{
 "version": 1, "sample": "${sample.slug}", "chunk": "c01",
 "translator": "tên mô hình hoặc người dịch",
 "glossary": {"向量": "vectơ"},
 "notes": ["ghi chú cho người duyệt, nếu có"],
 "blocks": [
  {"id": "p7-b1", "source": "chữ Trung đã đối chiếu ảnh (chỉ trang scan)", "translation": "bản dịch tiếng Việt"},
  {"id": "p8-b1", "translation": "bản dịch tiếng Việt"}
 ]
}
\`\`\`
- Mỗi \`id\` của \`blocks.json\` đúng một lần, cùng thứ tự; không thêm, gộp hay tách đoạn.
- \`@@PDF_INLINE_N@@\` là ảnh công thức gốc: giữ mỗi mã đúng một lần ở cả \`source\` và \`translation\`, đúng vị trí. Nhãn @N trong ảnh chính là chỗ của \`@@PDF_INLINE_N@@\`; không viết “@N”. \`tokens[].trailingPunctuation\` = ảnh công thức đã có dấu câu đi kèm.
- Công thức LaTeX \`\\( … \\)\` của nguồn chép nguyên văn sang bản dịch; chỉ dịch chữ Trung nằm trong công thức.
- Giữ mọi năm (4 chữ số) và chú thích dạng [n]; viết tiếng Việt Unicode NFC.
- \`glossary\`: thuật ngữ Trung → Việt đã dùng nhất quán (lưu cùng sách). Không thêm thông tin, không bình luận.

## Quy tắc đọc ảnh (nguyên văn quy tắc Hoa Trí gửi Gemini)
Thay cho “Return JSON {blocks:[{id,text}],warnings}”: ghi \`source\` vào texts.json, ghi điều chưa chắc vào \`notes\` (tiếng Việt).
${fence(OCR_RULES)}
Với ảnh gộp \`sheets/\`:
${fence(SHEET_OCR_RULES)}

## Quy tắc dịch (nguyên văn quy tắc Hoa Trí gửi Gemini)
Thay cho “Return one block per input ID…”: ghi \`translation\` vào texts.json; \`glossaryUpdates\` là \`glossary\`; bỏ qua \`contextUpdate\`. Mã @@MATH_NNNN@@ chỉ có trong bản gửi Gemini; ở đây công thức hiện nguyên văn.
${fence(BLOCK_TRANSLATION_RULES)}

## Thuật ngữ (môn: ${subjectOf(sample.domain).label})
${rows.length?`Dùng đúng các thuật ngữ sau (bảng của sách đứng trước):\n\n| Trung | Việt | Nguồn |\n|---|---|---|\n${rows.join('\n')}`:'Chưa có thuật ngữ nào khớp chữ của các phần này.'}
`;
}
