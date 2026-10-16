# Kiểm thử PDF Toán Trung - Việt

Ngày kiểm thử: 2026-09-25

## Tệp kiểm thử

- Sách: `普通高中教科书·数学(A版)选择性必修 第一册`
- Dung lượng: 56,02 MB
- Số trang PDF: 148
- Kết cấu: 148/148 trang là ảnh scan, không có lớp chữ
- Tệp hợp lệ: có `%PDF-1.7`, `startxref` và `%%EOF`; không mã hóa

Mục lục của tệp này gồm ba chương:

1. Vectơ không gian và hình học không gian
2. Phương trình đường thẳng và đường tròn
3. Phương trình đường conic

Tệp này không chứa chương Dãy số. Muốn đánh giá thuật ngữ `数列`, `等差数列`, `等比数列` cần dùng một tập dữ liệu khác.

## Bài thử trang 80

Trang 80 được chọn vì có nội dung `两条平行直线间的距离`, bài toán khoảng cách giữa hai đường thẳng song song, tọa độ điểm và nhiều công thức.

| Chỉ số | Kết quả |
| --- | ---: |
| Ảnh sau khi giảm còn 1200 px, chuyển xám và nén WebP | 95.354 byte |
| Token OCR | 2.283 |
| Token dịch | 2.056 |
| Tổng token | 4.339 |
| Công thức nhận dạng trong OCR | 43 |
| Công thức giữ nguyên trong bản dịch | 43/43 (100%) |
| Chữ Hán còn sót trong bản dịch | 0 |

Model dùng trong bài thử: `gemini-3.6-flash`, chế độ suy luận tối thiểu.

## Kết luận kỹ thuật

- Không tải tệp PDF gốc lên máy chủ. Trình duyệt chỉ gửi các trang người học chọn sau khi đã tối ưu ảnh.
- Mỗi lượt thử bị giới hạn tối đa 20 trang để tránh OCR nhầm toàn bộ sách và tiêu tốn token.
- OCR biểu diễn công thức bằng LaTeX. Trước khi dịch, công thức được thay bằng mã giữ chỗ và chỉ được phục hồi khi mọi mã xuất hiện đúng một lần.
- BLEU-4 và tỷ lệ công thức khớp được tính cục bộ khi giáo viên cung cấp ground truth; bước đánh giá không gọi Gemini.
- Kết quả 100% ở đây đo độ bảo toàn công thức giữa đầu ra OCR và bản dịch. Độ đúng của OCR so với ảnh gốc vẫn cần ground truth hoặc người dạy đối chiếu.
