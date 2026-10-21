# Hoa Trí

[![CI](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml)

Web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini (mỗi người dịch dán khóa Gemini của mình), chạy trên Cloudflare Workers (D1 + R2). Một dịch vụ PDF riêng (Python/PyMuPDF + Chromium) tách trang và dựng PDF tiếng Việt theo bố cục trang gốc.

- **Xưởng dịch học tập** (`/study`): dịch PDF theo phạm vi (tối đa 20 trang mỗi lượt, tệp tới 25 MB) hoặc **"Dịch cả quyển"** (tệp tới 100 MB, tự chia lượt, dừng rồi dịch tiếp được, kể cả trên máy khác); cũng nhận TXT, DOCX, EPUB, AZW3.
- **Thư viện riêng**: "Tải cả quyển" ghép bản dịch vào đúng chỗ trong sách gốc; **"Đọc song ngữ"** đặt trang gốc cạnh trang dịch.
- **Tra chữ Hán**: pinyin, âm Hán Việt và nghĩa bằng từ điển offline, không dùng Gemini.
- 7 lĩnh vực; Toán, Vật lý, Hóa học, Sinh học, Tin học có sẵn thuật ngữ sách giáo khoa.
- Tài khoản phải đồng ý điều khoản; người dùng tự xóa lịch sử hoặc cả tài khoản; quản trị viên khóa hoặc xóa tài khoản.

**Số đo bố cục:** trên 3 trang scan thật của sách Toán, toàn bộ phần không phải chữ (hình, khung, đường kẻ) giữ nguyên, chỉ lệch nhiễu nén ảnh; 98,9% chữ Việt nằm đúng khung đoạn gốc, không đoạn nào tràn. Tiêu đề chương và chân trang (36 chữ Hán) chưa được dịch. 8/14 đoạn văn giữ ≥85% cỡ chữ in; 3 đoạn nhỏ hơn rõ, khoảng 80%. Thời gian tiết kiệm được chưa đo. Cách đo và giới hạn: [docs/layout-metrics.md](docs/layout-metrics.md).

## Chạy trên máy Windows

1. Clone vào thư mục có đường dẫn ngắn (Windows giới hạn độ dài đường dẫn):
   ```powershell
   git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git C:\src\chinese-translator
   ```
2. Mở thư mục `C:\src\chinese-translator` và bấm đúp **`start.cmd`**.
   - Lần đầu: nếu máy chưa có Node.js hoặc Python, nó hỏi rồi tự cài (bằng winget). Sau đó nó cài thư viện, chạy `npm run setup` (vài phút, cần Internet, tải thêm khoảng 18 MB dữ liệu từ điển) và tự mở trình duyệt.
   - Các lần sau: bấm đúp `start.cmd` là chạy, kèm cập nhật code mới nhất và áp migration mới vào cơ sở dữ liệu local.
3. Trong trình duyệt: "Tạo tài khoản" (đánh dấu ô đồng ý điều khoản) → "Xưởng dịch học tập" → nhập "Tên nội dung", dán khóa Gemini API của bạn (tạo ở https://aistudio.google.com/apikey), chọn PDF → "Bắt đầu dịch →".

Giữ cửa sổ `start.cmd` mở trong lúc dùng; đóng cửa sổ hoặc bấm Ctrl+C để tắt.

Chạy bằng lệnh (cả macOS/Linux): `npm ci`, `npm run setup`, rồi `npm start`. Sau mỗi lần `git pull`, chạy lại `npm run setup` trước `npm start`: `npm start` và `npm run dev` không áp migration.

## Deploy

- Dịch vụ PDF (Docker + Caddy) và Worker (`npm run deploy:check`, `npm run deploy`): [deploy/pdf-layout/README.md](deploy/pdf-layout/README.md). Chưa deploy thật lần nào.
- Trước khi công khai: điền 4 loại chỗ trống `[[CHƯA ĐIỀN: …]]` trong `frontend/dieu-khoan.html` và `frontend/quyen-rieng-tu.html` (ONBOARDING mục 5.1; deploy từ chối khi còn chỗ trống), và chạy `npm run prepare:dict` nếu muốn "Tra chữ Hán" hoạt động trên site.
- Gắn tên miền riêng cho Worker trước khi chia sẻ link đầu tiên: thẻ xem trước và `sitemap.xml` lấy đúng địa chỉ mà link dùng, nên link `*.workers.dev` sẽ hiện tên đó (ONBOARDING mục 5.3).
- Khi cập nhật, deploy Worker trước hoặc cùng lúc với dịch vụ PDF, không bao giờ để dịch vụ PDF mới chạy với Worker cũ (ONBOARDING mục 5.2).
- Trang có Content-Security-Policy trong `frontend/_headers`; cách nới cho một tính năng mới: ONBOARDING mục 9.

Hướng dẫn đầy đủ (cài đặt, cách dùng, deploy, xử lý sự cố, giới hạn đã biết): [ONBOARDING.md](ONBOARDING.md). Làm "Ví dụ mẫu" cho thư viện công khai: [tools/samples/README.md](tools/samples/README.md).

Repo này công khai: không commit `.dev.vars` (khóa và mã bí mật), không commit thư mục `samples/` (PDF sách).
