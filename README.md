# Hoa Trí

Web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini, chạy trên Cloudflare Workers (D1 + R2). Một dịch vụ PDF riêng (Python/PyMuPDF + Chromium) tách trang và xuất bản dịch giữ nguyên bố cục gốc.

## Chạy trên máy Windows

1. Clone vào thư mục có đường dẫn ngắn (Windows giới hạn độ dài đường dẫn):
   ```powershell
   git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git C:\src\chinese-translator
   ```
2. Mở thư mục `C:\src\chinese-translator` và bấm đúp **`start.cmd`**.
   - Lần đầu: nếu máy chưa có Node.js hoặc Python, nó hỏi rồi tự cài (bằng winget). Sau đó nó cài thư viện, chuẩn bị mọi thứ (vài phút, cần Internet) và tự mở trình duyệt.
   - Các lần sau: bấm đúp `start.cmd` là chạy, kèm cập nhật code mới nhất.
3. Trong trình duyệt: "Tạo tài khoản" → "Xưởng dịch học tập" → nhập "Tên nội dung", dán khóa Gemini API của bạn (tạo ở https://aistudio.google.com/apikey), chọn PDF → "Bắt đầu dịch →".

Giữ cửa sổ `start.cmd` mở trong lúc dùng; đóng cửa sổ hoặc bấm Ctrl+C để tắt.

Chạy bằng lệnh (cả macOS/Linux): `npm ci`, `npm run setup`, rồi `npm start`.

Hướng dẫn đầy đủ (deploy lên Cloudflare, xử lý sự cố, giới hạn đã biết): [ONBOARDING.md](ONBOARDING.md).

Repo này công khai: không commit `.dev.vars` (khóa và mã bí mật).
