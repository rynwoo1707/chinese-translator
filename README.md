# Hoa Trí

[![CI](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml)

Web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini (mỗi người dịch dán khóa Gemini của mình), chạy trên Cloudflare Workers (D1 + R2). Một dịch vụ PDF riêng (Python/PyMuPDF + Chromium) tách trang và dựng PDF tiếng Việt theo bố cục trang gốc.

- **Xưởng dịch học tập** (`/study`): dịch PDF theo phạm vi (tối đa 20 trang mỗi lượt, tệp tới 25 MB) hoặc **"Dịch cả quyển"** (tệp tới 100 MB, tự chia lượt, dừng rồi dịch tiếp được, kể cả trên máy khác); cũng nhận TXT, DOCX, EPUB, AZW3 và ảnh chụp trang (JPG, PNG, WebP; ghép thành một PDF ngay trên máy).
- **Thư viện riêng**: "Tải cả quyển" ghép bản dịch vào đúng chỗ trong sách gốc; **"Đọc song ngữ"** đặt trang gốc cạnh trang dịch; trang đọc nhớ chỗ đang đọc khi tải lại.
- **Tra chữ Hán**: pinyin, âm Hán Việt và nghĩa bằng từ điển offline, không dùng Gemini.
- 7 lĩnh vực; Toán, Vật lý, Hóa học, Sinh học, Tin học có sẵn thuật ngữ sách giáo khoa.
- Tài khoản phải đồng ý điều khoản; mật khẩu dễ đoán bị từ chối và nhập sai nhiều lần thì bị khóa tạm; người dùng tự đổi mật khẩu, đăng xuất khỏi mọi thiết bị, xóa lịch sử hoặc cả tài khoản; quản trị viên khóa hoặc xóa tài khoản và tạo link đặt lại mật khẩu.
- Trình duyệt: Chrome, Edge, Firefox bản mới hoặc Safari/iOS 15.4 trở lên; đọc và dịch PDF cần iOS/Safari 16.4 trở lên.

**Số đo bố cục:** trên 3 trang scan thật của sách Toán, toàn bộ phần không phải chữ (hình, khung, đường kẻ) giữ nguyên, chỉ lệch nhiễu nén ảnh; 98,9% chữ Việt nằm đúng khung đoạn gốc, không đoạn nào tràn. Tiêu đề chương và chân trang (36 chữ Hán) chưa được dịch. 8/14 đoạn văn giữ ≥85% cỡ chữ in; 3 đoạn nhỏ hơn rõ, khoảng 80%. PDF có lớp chữ mới được đo trên trang tổng hợp, chưa đo trên sách thật. Thời gian tiết kiệm được chưa đo. Cách đo và giới hạn: [docs/layout-metrics.md](docs/layout-metrics.md).

## Chạy trên máy Windows

1. Clone vào thư mục có đường dẫn ngắn (Windows giới hạn độ dài đường dẫn):
   ```powershell
   git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git C:\src\chinese-translator
   ```
2. Mở thư mục `C:\src\chinese-translator` và bấm đúp **`start.cmd`**.
   - Lần đầu: nếu máy chưa có Node.js hoặc Python, nó hỏi rồi tự cài (bằng winget). Sau đó nó cài thư viện, chạy `npm run setup` (vài phút, cần Internet, tải thêm khoảng 18 MB dữ liệu từ điển; mô hình OCR PaddleOCR có sẵn trong repo) và tự mở trình duyệt.
   - Các lần sau: bấm đúp `start.cmd` là chạy, kèm cập nhật code mới nhất và áp migration mới vào cơ sở dữ liệu local.
   - Dòng **CẢNH BÁO** là phần không bắt buộc chưa dùng được (ví dụ OCR trong trình duyệt dùng Tesseract thay cho PaddleOCR, hay chế độ "Giữ bố cục PDF" khi dịch vụ PDF dừng): app vẫn chạy. Dòng **LỖI** ghi rõ thiếu gì và cách sửa ([ONBOARDING](ONBOARDING.md) mục 6.3). Hoa Trí đang mở ở một cửa sổ khác thì `start.cmd` báo rồi dừng: dùng cửa sổ đó.
3. Trong trình duyệt: "Tạo tài khoản" (đánh dấu ô đồng ý điều khoản) → "Xưởng dịch học tập" → nhập "Tên nội dung", dán khóa Gemini API của bạn (tạo ở https://aistudio.google.com/apikey), chọn PDF → "Bắt đầu dịch →".

Giữ cửa sổ `start.cmd` mở trong lúc dùng; đóng cửa sổ hoặc bấm Ctrl+C để tắt.

Chạy bằng lệnh (cả macOS/Linux): `npm ci`, `npm run setup`, rồi `npm start`. Sau mỗi lần `git pull`, chạy lại `npm run setup` trước `npm start`: `npm start` và `npm run dev` không áp migration.

## Deploy

- Dịch vụ PDF (Docker + Caddy) và Worker (`npm run deploy:check`, `npm run deploy`): [deploy/pdf-layout/README.md](deploy/pdf-layout/README.md). Chưa deploy thật lần nào.
- Trước khi công khai: điền 4 loại chỗ trống `[[CHƯA ĐIỀN: …]]` trong `frontend/dieu-khoan.html`, `frontend/quyen-rieng-tu.html` và `frontend/.well-known/security.txt` (ONBOARDING mục 5.1; deploy từ chối khi còn chỗ trống, trừ bản thử kín với `--allow-placeholders`), và chạy `npm run prepare:dict` trên máy deploy: thiếu dữ liệu "Tra chữ Hán" thì deploy dừng (trừ khi thêm `--allow-no-dictionary`).
- Gắn tên miền riêng cho Worker trước khi chia sẻ link đầu tiên: thẻ xem trước và `sitemap.xml` lấy đúng địa chỉ mà link dùng, nên link `*.workers.dev` sẽ hiện tên đó (ONBOARDING mục 5.3).
- Khi cập nhật, deploy Worker trước hoặc cùng lúc với dịch vụ PDF, không bao giờ để dịch vụ PDF mới chạy với Worker cũ (ONBOARDING mục 5.2). `https://<tên miền>/api/health?deep=1` báo `"status":"mismatch"` khi hai bên chạy hai commit khác bộ kiểm tra bố cục.
- Trước khi công khai: xóa sách PDF scan còn trong lịch sử repo (ONBOARDING mục 5.1), push commit sắp deploy lên nhánh mà link "Mã nguồn" trỏ tới (`SOURCE_URL` trong `frontend/site-footer.js`; deploy dừng khi commit chưa có trên nhánh đó), bảo vệ máy chủ PDF, đặt giám sát và sao lưu D1, R2 (runbook mục A.1, A.8, B.5). Lỗi gặp trong trình duyệt của người dùng được gửi về nhật ký của Worker (ONBOARDING mục 5.9).
- Trang có Content-Security-Policy trong `frontend/_headers`; cách nới cho một tính năng mới: ONBOARDING mục 9.

Hướng dẫn đầy đủ (cài đặt, cách dùng, deploy, xử lý sự cố, giới hạn đã biết): [ONBOARDING.md](ONBOARDING.md). Làm "Ví dụ mẫu" cho thư viện công khai: [tools/samples/README.md](tools/samples/README.md).

Repo này công khai: không commit `.dev.vars` (khóa và mã bí mật), không commit thư mục `samples/` (PDF sách).
