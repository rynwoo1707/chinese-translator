# Kiểm tra Hoa Trí ngày 14/10/2026

## Thay đổi

- Nhập **Tên nội dung** trước khi dịch. Tên được giữ khi tải tệp, lưu tiến độ, mở lịch sử và tải TXT/HTML/PDF.
- Mở một bản cũ, sửa tên rồi bấm **Lưu tên** để cập nhật lịch sử và Thư viện riêng. Đổi tên không gọi Gemini hoặc sửa nội dung/PDF.
- Lịch sử hiển thị tên, tệp nguồn, số phần đã dịch và giờ cập nhật. Thời gian SQLite được đọc là UTC trước khi hiển thị theo múi giờ của trình duyệt.
- Dấu vectơ U+20D7 và ký hiệu LaTeX được vẽ bằng SVG trong phần đọc, bản dịch HTML và PDF. AB/OA không có dấu vectơ vẫn giữ nguyên là văn bản.
- Loại Georgia khỏi font dự phòng cho nội dung tiếng Việt. Kiểm tra trình duyệt xác nhận chuỗi NFC đúng vẫn bị tách dấu với Georgia; Times New Roman hiển thị đúng toàn bộ chuỗi.
- Khóa thao tác từ đầu bước chuẩn bị để tránh chạy hai lượt dịch khi bấm nhanh. Mở lịch sử, chỉnh tên và sửa block cũng được khóa trong lúc xử lý.
- Bản PDF xuất dùng tên nội dung và lưu phiên bản dàn trang. Bản xuất cũ được xem trước bằng engine mới và có thể xuất lại mà không dịch lại.
- Lớp thông tin bìa sách cho phép bấm bìa và nút mở tài liệu khi xuất hiện bằng hover hoặc bàn phím.

## Xác minh

- `npm.cmd test`: **178/178** đạt.
- `node backend/build.mjs`: đạt.
- Lịch sử trên trình duyệt: tên bắt buộc, giữ tên khi tải tệp, tự lưu, mở lại, đổi tên, tệp tải xuống có tên, thời gian UTC, bấm nhanh chỉ chạy một luồng, lỗi chuẩn bị giải phóng khóa.
- PDF thực tế: PyMuPDF + Puppeteer, kích thước trang, hình gốc, công thức, tràn box, tải xuống, chỉnh block và xuất lại, mở lịch sử riêng và màn hình điện thoại.
- OCR scan trang 4-5: đổi phạm vi, giữ hình, thiếu khóa được báo rõ, Paddle lỗi chuyển sang Tesseract, HTML có ảnh nguồn.
- Vectơ: đúng mẫu AB⃗, |AB⃗|, OA⃗, OB⃗, OC⃗ đã có trong dữ liệu cũ; mũi tên nằm trên chữ ở web, HTML và PDF, giữ chỉ số và không thay ô [□] bằng ký hiệu đoán.
- Quyền truy cập: các API quản trị, lịch sử và tài sản PDF vẫn có kiểm tra phiên/nguồn yêu cầu/chủ sở hữu.

Benchmark dịch/OCR dùng Gemini giả lập, không tiêu tốn token. Bản PDF trang 4-5 trong lịch sử cục bộ đã được xuất lại từ 15 block dịch có sẵn. PDF và trạng thái trước khi sửa được sao lưu trong `tmp/pdfs/`; không thay đổi tên hoặc nội dung bản dịch của người học.

## Sử dụng

Chọn tài liệu hoặc dán nguyên tác, nhập tên dễ tìm (ví dụ **Vectơ trong không gian - bài 1**), chọn cấu hình và bấm **Bắt đầu dịch**. Với bản đã lưu, mở lịch sử và dùng **Lưu tên** để đổi tên. Với PDF cũ chưa cập nhật, bấm **Xuất PDF tiếng Việt**; bước này chỉ dàn trang lại và không cần dịch lại.
