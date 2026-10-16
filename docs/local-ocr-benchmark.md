# Kiểm thử PaddleOCR trên sách Toán

Ngày tổng hợp: 2026-10-05. Sách `普通高中教科书·数学(A版)选择性必修 第一册`, 148 trang scan, khoảng 56 MB. Chọn các trang PDF 9, 39, 59, 80, 110; ảnh OCR xám tối đa 1600 px. Chạy bằng Edge headless trên máy hiện tại, không gọi Gemini.

| Trang | Paddle: ký tự / vùng chữ | Thời gian Paddle | Tesseract: ký tự / vùng chữ | Thời gian Tesseract |
| --- | ---: | ---: | ---: | ---: |
| 9 | 756 / 66 | 12,5 giây | 762 / 34 | 4,4 giây |
| 39 | 737 / 65 | 13,2 giây | 699 / 31 | 3,4 giây |
| 59 | 653 / 47 | 10,2 giây | 631 / 36 | 3,1 giây |
| 80 | 734 / 47 | 11,7 giây | 718 / 34 | 4,0 giây |
| 110 | 686 / 62 | 13,2 giây | 669 / 33 | 4,0 giây |

Thời gian là phần nhận dạng, không gồm tải mô hình và khởi tạo. Ký tự không tính khoảng trắng. Paddle chạy thật trên cả 5 trang, không dùng Tesseract thay thế trong lượt đo Paddle. Cả hai phương án nhận dạng đều dùng **0 token Gemini**.

Paddle lấy được nhiều vùng chữ hơn trong mẫu này nhưng chậm hơn. Số ký tự/vùng không chứng minh mô hình chính xác hơn; chưa có ground truth để đo CER và độ đúng ký hiệu toán. Không công bố phần trăm chính xác dựa trên điểm tin cậy nội bộ của hai mô hình.

Luồng dịch thật chưa được chấm trong phép đo này. API dịch trong kiểm thử giao diện được mô phỏng để không tiêu token. Các bước kiểm tra gồm khóa bắt buộc, chọn file -> OCR -> hiển thị phần, giữ ảnh cạnh bản dịch, đổi phạm vi không lẫn trang cũ, màn hình 390 px, xuất HTML và Tesseract dự phòng khi worker Paddle không tải được.

Các kiểm thử đơn vị kiểm tra tọa độ, số trong thân trang, công thức, thứ tự hai cột, gộp phần và thoát HTML. Xem [cách chạy lại](local-ocr-layout.md).
