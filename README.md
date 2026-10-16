# Hoa Trí

Web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini, chạy trên Cloudflare Workers (D1 + R2). Một dịch vụ PDF riêng (Python/PyMuPDF + Chromium) tách trang và xuất bản dịch giữ nguyên bố cục gốc.

## Chạy trên máy (Windows, PowerShell)

Cần Git, Node.js 22.13+ và Python 3.10+. Clone vào thư mục có đường dẫn ngắn (ví dụ `C:\src`), vì Windows giới hạn độ dài đường dẫn.

```powershell
git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git
cd chinese-translator
npm.cmd ci
npm.cmd run setup             # cài đặt một lần
npm.cmd run dev:pdf-layout    # cửa sổ 1: dịch vụ PDF
npm.cmd run dev               # cửa sổ 2: web, http://127.0.0.1:8787
```

Tạo tài khoản ở `/#account`, mở `/study.html`, nhập "Tên nội dung", dán khóa Gemini API của bạn (tạo ở https://aistudio.google.com/apikey) và chọn PDF để dịch.

Hướng dẫn đầy đủ (macOS/Linux, deploy lên Cloudflare, xử lý sự cố, giới hạn đã biết): [ONBOARDING.md](ONBOARDING.md).

Repo này công khai: không commit `.dev.vars` (khóa và mã bí mật).
