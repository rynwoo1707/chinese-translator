# Số đo bố cục PDF dịch

Ngày đo: 2026-10-19. Mã dựng PDF `0bf0cefc9d8de3c5` (`services/pdf-layout/engine.mjs`, `frontend/pdf-box-layout.js`, `frontend/math-text.js`), `extract.py` hiện tại. Không gọi Gemini, không gọi API trả phí, **0 token**. Lệnh ở mục “Chạy lại” cho ra đúng các số dưới đây; hai lần chạy cho kết quả giống hệt.

Tài liệu này thay các câu chưa đo như “giữ nguyên 90–95% bố cục” và “tiết kiệm hơn 80% thời gian”. Bố cục không có một con số chung: mỗi chỉ số dưới đây đo một việc, có định nghĩa và có giới hạn.

## Tóm tắt

**Trang thật** (Toán THPT bản A, trang 3–5, ảnh scan, 27 đoạn, bản dịch thật):

- 0/27 đoạn tràn khung. 27/27 đoạn giữ ≥85% cỡ chữ **do bộ tách trang ước**.
- So với **cỡ chữ in đo trên ảnh**: 8/14 đoạn văn giữ ≥85%. 3 đoạn chắc chắn nhỏ hơn 85% (p4-b4, p4-b8, p4-b10: 79–81%), 4 đoạn nằm trong sai số đo. Lý do: trang 4 là ảnh 94 dpi, bộ tách ước chữ thân bài 10,5pt trong khi chữ in đo được khoảng 13pt; báo cáo dựng (`render/report.json`) vẫn ghi không đoạn nào bị co.
- Ngoài các khung chữ, 100% điểm ảnh giữ nguyên (hình, khung, đường kẻ, chữ không dịch), chỉ lệch nhiễu nén, lớn nhất 9/255 mức xám. 9/9 vùng hình và công thức giữ nguyên. 17/17 ảnh công thức có trong PDF dịch.
- 98,9% ký tự tiếng Việt nằm trong khung đoạn gốc. 5 đoạn được nới khung sang chỗ giấy trắng: tiêu đề một dòng nới ngang tối đa 127,9pt, đoạn nhiều dòng nới xuống tối đa 18,9pt.
- Khổ trang lệch tối đa 0,26pt (594,96 × 841,92 so với 595,22 × 842).
- Lớp chữ của PDF dịch có 0 chữ Hán. Trên ảnh trang vẫn còn chữ Trung: tiêu đề chương ở trang 3 và chân trang ở trang 4, 5. Đếm bằng mắt được 36 chữ Hán, khoảng 2,5% số chữ Hán của 3 trang; OCR ước 43. Ngoài ra còn 1 chữ “时” nằm trong ảnh công thức p5-b4. Tính theo diện tích, 95,3% diện tích dòng chữ Trung đã được thay; riêng trang 3 chỉ 83,5% vì tiêu đề chương chữ to.

**Fixture 6 thể loại** (7 trang tổng hợp có đáp án chuẩn, bản dịch giả):

- Bản dịch dài cỡ bản thật (1 chữ Việt/chữ Hán; bản dịch thật ở trên là 0,9): 110/131 đoạn (84%) giữ ≥85% cỡ chữ gốc thật, 0 đoạn tràn, 99,5% diện tích chữ Trung được thay, còn 1/3.462 chữ Hán văn bản, 5/5 hình giữ nguyên, 100% mực ngoài khung giữ nguyên.
- Bản dịch dài hơn hẳn (1,3 chữ Việt/chữ Hán, cố ý nặng): 89/131 đoạn (68%) giữ ≥85% cỡ chữ gốc, vẫn 0 đoạn tràn.
- Đoạn co dưới 85% chủ yếu là ô bảng (9/21) và dòng đầu trang (5/13). Thân bài chỉ 2/35 (ở tỷ lệ 1,0).

## Chạy lại

```
node backend/benchmark-layout-metrics.mjs --md
node backend/benchmark-layout-metrics.mjs --only fixtures --ratio 1 --validate-ocr --out tmp/layout-metrics/validate-ocr
```

- Lệnh đầu đo cả hai bộ dữ liệu, khoảng 4 phút trên máy của chủ dự án. Lệnh sau kiểm chứng phép ước bằng OCR trên fixture, khoảng 2,5 phút.
- Cần `npm run setup` (Python, PyMuPDF trong `.runtime`, Edge/Chromium) và `npm run prepare:pdf-ocr` (dữ liệu Tesseract `chi_sim`).
- Hai bộ dữ liệu chỉ có trên máy của chủ dự án, git bỏ qua: `tmp/pdf-layout/genre-fixtures/` và `samples/toan-a1/work/c01/`. Thiếu bộ nào thì lệnh bỏ qua bộ đó và báo.
- Kết quả từng đoạn: `tmp/layout-metrics/metrics.json`. PDF fixture đã dựng: `tmp/layout-metrics/<fixture>-r<tỷ lệ>.pdf`.
- Tùy chọn: `--only fixtures|sample`, `--fixtures physics,novel`, `--ratio 1,1.3`, `--sample samples/<mã>/work/<phần>` (đo phần khác do `npm run samples` tạo), `--no-ocr` (nhanh hơn, bỏ các số có dấu *), `--keep-work` (giữ ảnh trung gian), `--out <thư mục>`.

## Dữ liệu đo

**(a) Fixture** (`tmp/pdf-layout/genre-fixtures`, xem README trong đó): 6 bộ trang “scan” tổng hợp viết riêng cho bộ thử, mỗi thể loại một kiểu khó: Vật lý (2 trang), Hóa học, Tiểu thuyết, Thơ, Lịch sử, Bài tập; tổng 7 trang. Có đáp án chuẩn cho từng chữ: hộp mực, đoạn, vai trò (tiêu đề, thân bài, ô bảng…), hình. Script tách trang bằng `extract.py` hiện tại (dùng bộ nhớ đệm của harness khi mã không đổi), dịch bằng bản dịch giả cố định của harness, rồi dựng bằng engine hiện tại. Bản dịch giả có độ dài thật nhưng không có nghĩa: 1,0 hoặc 1,3 chữ Việt cho mỗi chữ Hán, giữ mọi mã công thức. Bản dịch thật ở mẫu (b) là 0,9 chữ Việt/chữ Hán.

**(b) Mẫu thật** (`samples/toan-a1/work/c01`): trang 3–5 của *普通高中教科书·数学(A版)选择性必修 第一册*, ảnh scan (150, 94 và 131 dpi). Gồm 27 đoạn, 17 ảnh công thức, 1.379 chữ Hán trong các đoạn. Chữ Trung đã được đọc lại theo ảnh và dịch bởi Claude, không dùng Gemini (`import-report.json`). Script đo đúng tệp PDF đã lưu (`render/c01.vi.pdf`). Script cũng dựng lại bằng mã hiện tại: lần này ra đúng các cỡ chữ và khung như bản đã lưu.

## Định nghĩa

So sánh điểm ảnh dùng ảnh xám 0–255 ở 1,6 điểm ảnh/pt, đúng độ phân giải của ảnh nền trang mà bộ tách ghi ra, nên ảnh gốc và ảnh nền trong PDF dịch khớp từng điểm. “Giữ nguyên” nghĩa là độ sáng lệch ≤16. Ngoài các khung chữ, độ lệch đo được chỉ là nhiễu nén JPEG: 99,9% điểm lệch ≤5, lớn nhất 9. “Mực” là điểm tối hơn màu giấy ít nhất 60; màu giấy là bách phân vị 75 của trang.

1. **Cỡ chữ ≥85%**: tỷ lệ r = cỡ chữ dựng (báo cáo của engine) / cỡ chữ gốc, đếm khi r ≥ 0,85. Có hai mẫu số:
   - *cỡ ước*: `fontSize` bộ tách ghi trong manifest. Engine dựng từ cỡ này;
   - *cỡ in*: fixture dùng đáp án chuẩn, là bách phân vị 10 bề rộng chữ Hán của đoạn chuẩn chiếm nhiều chữ nhất trong khung. Trang thật dùng bước lặp chữ Hán trên ảnh scan: chữ Hán đứng trên lưới 1 em, nên chu kỳ mạnh nhất của mực theo chiều ngang, gộp các dòng của đoạn, là cỡ em. Chỉ đo đoạn có ≥20 chữ Hán và ≥2 dòng.
   - Trên fixture, cách đo bước chữ lệch so với đáp án trung vị 1,4%, p90 4,3%, lớn nhất 6,6% (44/51 đoạn văn có kết quả). Phép đo thường ra to hơn thật khoảng 1,4% do giãn chữ khi căn đều hai bên. Vì vậy trên trang thật, một đoạn chỉ được kết luận khi đủ chắc: r × (1 − 4,3%) ≥ 0,85 là chắc chắn ≥85%; r × (1 + 4,3%) < 0,85 là chắc chắn dưới; còn lại là chưa phân định.
2. **Tràn**: đoạn engine báo không vừa khung. Khi có đoạn tràn, xuất PDF thật sẽ dừng.
3. **Nới khung**: đoạn engine phải mở rộng khung sang chỗ giấy trắng bên phải hoặc bên dưới thì mới vừa.
4. **Chữ Việt trong khung gốc**: tỷ lệ ký tự trong lớp chữ của PDF dịch (bỏ khoảng trắng) có tâm nằm trong khung một đoạn gốc, dung sai 1pt. Phần còn lại nằm ở chỗ khung được nới.
5. **Diện tích chữ Trung được thay**: fixture dùng tổng diện tích hộp mực của mọi chữ trong đáp án (bỏ pinyin và chữ vẽ trong hình) có tâm nằm trong khung đoạn và ngoài ảnh công thức, chia cho tổng diện tích. Trang thật (*) ước bằng OCR: 1 − diện tích các dòng chữ Trung OCR còn đọc được trên phần không đổi của trang dịch / diện tích các dòng đó trên trang gốc.
6. **Chữ Hán còn thấy**: fixture đếm chữ Hán văn bản trong đáp án có ≥80% điểm mực không đổi trên trang dịch, hoặc nằm trong ảnh công thức. Trang thật (*) dùng Tesseract `chi_sim` ở 288 dpi đọc “phần không đổi” của trang dịch: điểm không đổi và cách mọi chỗ thay đổi ≥4pt, phần đã đổi tô bằng màu giấy. Kết quả so với cùng phép OCR trên trang gốc. Chỉ đếm dòng có ≥2 chữ Hán và chữ Hán chiếm ≥50% ký tự, vì Tesseract đọc nét hình và công thức thành chữ Hán lẻ. Chữ Hán đi theo ảnh công thức sang chỗ mới không đếm được bằng cách này.
7. **Chữ Hán trong lớp chữ**: ký tự Hán trong lớp chữ có thể chép của PDF dịch. Trang scan gốc không có lớp chữ.
8. **Mực ngoài khung giữ nguyên**: vùng ngoài khung chữ là phần trang chung của hai bản, trừ khung đoạn gốc, hộp ký tự lớp chữ PDF dịch và ảnh công thức (mỗi hộp nới 2pt). Số đo là tỷ lệ điểm mực của trang gốc trong vùng đó còn giữ nguyên trên trang dịch. Script cũng tính tỷ lệ cho mọi điểm ảnh, kể cả giấy.
9. **Hình giữ nguyên**: hình có ≥98% điểm mực không đổi. Fixture dùng hình trong đáp án. Trang thật dùng các vùng bộ tách giữ nguyên ảnh (`protectedRegions`: hình, dòng công thức riêng, tiêu đề chương trang 3), vì chưa có đáp án hình. **Ảnh công thức**: số ảnh công thức trong manifest so với số ảnh nhỏ trong PDF dịch.
10. **Lệch khổ trang**: chênh rộng/cao giữa trang PDF dịch và trang gốc (pt).

## Kết quả

### Mẫu thật c01

| Trang | Đoạn | ≥85% cỡ ước | ≥85% cỡ in | Tràn | Nới khung | Chữ Việt trong khung gốc | Diện tích chữ Trung được thay* | Chữ Hán còn thấy* | Mực ngoài khung giữ nguyên | Vùng hình giữ nguyên | Lệch khổ rộng/cao (pt) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 2 | 2/2 | 2/2 | 0 | 0 | 100% | 83,5% | 11/364 | 100% | 2/2 | −0,26 / −0,08 |
| 4 | 12 | 12/12 | 2/6 | 0 | 4 | 97,4% | 99,4% | 11/567 | 100% | 2/2 | −0,26 / −0,08 |
| 5 | 13 | 13/13 | 4/6 | 0 | 1 | 100% | 96,7% | 21/474 | 100% | 5/5 | −0,26 / −0,08 |
| **Tổng** | 27 | 27/27 | 8/14 | 0 | 5 | 98,9% | 95,3% | 43/1.405 | 100% | 9/9 | ≤0,26 |

\* ước lượng bằng OCR. Kiểm bằng mắt: phần chữ Trung còn lại là “第一章 空间向量与立体几何” ở trang 3 (12 chữ) và cùng dòng đó ở chân trang 4, 5 (12 + 12 chữ), tổng 36 chữ. OCR đếm 43: ở trang 5 nó đọc nét công thức và hình giữ nguyên ảnh thành 9 chữ Hán giả, và ở trang 3, 4 bỏ sót chữ “第” đứng riêng. Bộ tách không báo cảnh báo cho tiêu đề và chân trang này (ghi chú của người duyệt trong `import-report.json`).

Cỡ chữ các đoạn văn (≥20 chữ Hán):

| Đoạn | Chữ Hán | Cỡ ước (pt) | Cỡ in đo (pt) | Cỡ dựng (pt) | Dựng/ước | Dựng/in | Kết luận |
|---|---:|---:|---:|---:|---:|---:|---|
| p3-b1 | 210 | 13,3 | 12,64 | 13,3 | 1,00 | 1,05 | ≥85% |
| p3-b2 | 143 | 12,6 | 12,70 | 12,6 | 1,00 | 0,99 | ≥85% |
| p4-b2 | 146 | 12,6 | 12,41 | 12,6 | 1,00 | 1,02 | ≥85% |
| p4-b4 | 86 | 10,5 | 12,94 | 10,5 | 1,00 | 0,81 | dưới 85% |
| p4-b6 | 120 | 11,2 | 12,34 | 10,886 | 0,97 | 0,88 | chưa phân định |
| p4-b8 | 73 | 10,5 | 13,28 | 10,5 | 1,00 | 0,79 | dưới 85% |
| p4-b10 | 67 | 10,5 | 13,06 | 10,5 | 1,00 | 0,80 | dưới 85% |
| p4-b11 | 32 | 9,8 | 11,57 | 9,8 | 1,00 | 0,847 | chưa phân định |
| p5-b1 | 174 | 11,9 | 11,82 | 11,9 | 1,00 | 1,01 | ≥85% |
| p5-b2 | 119 | 11,375 | 11,87 | 11,375 | 1,00 | 0,96 | ≥85% |
| p5-b5 | 24 | 9,1 | 10,66 | 9,0 | 0,99 | 0,844 | chưa phân định |
| p5-b8 | 25 | 11,55 | 11,78 | 11,375 | 0,98 | 0,97 | ≥85% |
| p5-b9 | 32 | 9,45 | 10,48 | 9,45 | 1,00 | 0,90 | ≥85% |
| p5-b12 | 63 | 10,5 | 12,43 | 10,5 | 1,00 | 0,845 | chưa phân định |

Theo số ký tự, 72,2% chữ Việt của 14 đoạn này nằm trong đoạn đạt ≥85% cỡ in. Hai đoạn ngắn p5-b4 và p5-b10 (dòng công thức có chữ) không đủ chữ Hán để đo bước chữ. Người duyệt ghi rằng cỡ ước của chúng (9 và 9,45pt) nhỏ hơn cỡ in khoảng 11pt, nên chữ Việt ở đó nhỏ hơn ảnh công thức bên cạnh.

Phân bố tỷ lệ dựng/in (14 đoạn văn): ≥1: 3, 0,95–1: 3, 0,85–0,95: 2, 0,70–0,85: 6, dưới 0,70: 0. Theo dựng/ước (27 đoạn): ≥1: 22, 0,95–1: 5.

### Fixture

| Trang | Đoạn | ≥85% cỡ in (1,0 / 1,3) | ≥85% cỡ ước (1,0 / 1,3) | Tràn | Nới khung (1,0 / 1,3) | Chữ Việt trong khung gốc (1,0 / 1,3) | Diện tích chữ Trung được thay | Chữ Hán còn thấy | Hình giữ nguyên | Lệch khổ rộng/cao (pt) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Vật lý 1 | 15 | 14 / 12 | 14 / 12 | 0 | 7 / 8 | 97,2% / 94,9% | 99,9% | 0/617 | 1/1 | 0 / −0,21 |
| Vật lý 2 | 14 | 13 / 11 | 13 / 11 | 0 | 6 / 8 | 97,6% / 96,8% | 99,9% | 0/504 | 1/1 | 0 / −0,21 |
| Hóa học | 32 | 24 / 22 | 24 / 22 | 0 | 10 / 17 | 96,4% / 95,3% | 99,7% | 0/667 | 1/1 | +0,42 / −0,33 |
| Tiểu thuyết | 10 | 8 / 2 | 10 / 8 | 0 | 4 / 3 | 96,6% / 97,0% | 99,8% | 0/286 | – | −0,33 / −0,21 |
| Thơ | 19 | 16 / 13 | 17 / 15 | 0 | 13 / 15 | 92,7% / 87,3% | 99,9% | 0/442 | – | +0,42 / −0,33 |
| Lịch sử | 19 | 16 / 15 | 16 / 14 | 0 | 7 / 7 | 97,4% / 97,0% | 98,6% | 1/597 | 1/1 | +0,42 / −0,33 |
| Bài tập | 22 | 19 / 14 | 19 / 15 | 0 | 9 / 12 | 91,9% / 90,2% | 98,1% | 0/349 | 1/1 | +0,42 / −0,33 |
| **Tổng** | 131 | 110 / 89 | 113 / 97 | 0 | 56 / 70 | 95,9% / 94,3% | 99,5% | 1/3.462 | 5/5 | ≤0,42 |

- Mực ngoài khung giữ nguyên 100% ở mọi trang và cả hai tỷ lệ. 41/41 ảnh công thức có trong PDF dịch. 0 chữ Hán trong lớp chữ.
- Khung được nới: tiêu đề một dòng nới ngang tới hết cột (tối đa 435,2pt); nới xuống tối đa 11,6pt (tỷ lệ 1,0) và 18,8pt (1,3).
- Chữ Hán còn thấy duy nhất là chữ “年” trong ô bảng “1949年” (Lịch sử): bộ tách không lấy ô này thành đoạn. Tính cả chữ vẽ trong hình Lịch sử (城楼, 长安街, 广场, 人民英雄纪念碑) và điều kiện phản ứng trong hai dòng công thức Hóa giữ nguyên ảnh (点燃; 高温、高压、催化剂), người đọc còn thấy 24 chữ Hán đúng chỗ in.
- Theo số ký tự: 95,0% (tỷ lệ 1,0) và 81,0% (tỷ lệ 1,3) chữ Việt nằm trong đoạn đạt ≥85% cỡ in.
- Đoạn dưới 85% cỡ in theo loại (1,0 / 1,3): ô bảng 9/21 và 11/21; dòng đầu trang 5/13 và 8/13; thân bài 2/35 và 9/35; bài tập 2/25 và 6/25; chú thích hình 1/6 và 2/6; tên bài thơ 1/2 và 2/2; băng tiêu đề 1/2 và 1/2; khung ghi chú 0/3 và 1/3; câu thơ 0/4 và 1/4; tên tác giả 0/1 và 1/1. Tiêu đề mục: 0/16 ở cả hai tỷ lệ.
- Tiểu thuyết ở tỷ lệ 1,3 chỉ 2/10 đoạn đạt so với cỡ in, nhưng 8/10 so với cỡ ước: bộ tách ước chữ thân bài 9,8pt, cỡ in thật là 10,5pt.

| Tỷ lệ dựng/in (dựng/ước) | ≥1 | 0,95–1 | 0,85–0,95 | 0,70–0,85 | 0,60–0,70 | dưới 0,60 |
|---|---:|---:|---:|---:|---:|---:|
| Fixture, 1,0 chữ Việt/chữ Hán | 35 (47) | 28 (34) | 47 (32) | 12 (8) | 9 (9) | 0 (1) |
| Fixture, 1,3 chữ Việt/chữ Hán | 23 (22) | 13 (19) | 53 (56) | 25 (16) | 16 (16) | 1 (2) |

### Độ tin cậy của các phép ước

- **Cỡ in đo từ bước chữ**: trên fixture, đo được 44/51 đoạn văn. Sai số trung vị 1,4%, p90 4,3%, lớn nhất 6,6%. Trên cùng các đoạn ấy, cỡ ước của bộ tách có sai số trung vị 0,1%, p90 6,7%: với ảnh tổng hợp sạch 150 dpi, bộ tách ước cỡ thân bài rất sát. Trên trang thật 94 dpi của mẫu (b), cỡ ước của ba đoạn thân bài p4-b4, p4-b8, p4-b10 thấp khoảng 20%.
- **OCR phần chữ còn lại**: trên fixture, OCR đếm 3.352 chữ Hán trên trang gốc (đáp án 3.485), 22 chữ còn thấy sau khi dịch (đáp án 24). Diện tích chữ được thay theo OCR là 99,8% (đáp án 99,5%). Trên mẫu (b), OCR đếm 43 so với 36 đếm bằng mắt (xem ghi chú dưới bảng mẫu thật).

## Các con số này không cho thấy

- **Chất lượng bản dịch và độ đúng của chữ Trung đọc lại.** Fixture dùng bản dịch giả. Mẫu thật do Claude đọc ảnh và dịch, không qua Gemini, nên đường đi thật (Gemini đọc ảnh rồi dịch) chưa được đo; nếu bản dịch Gemini dài hơn, chữ sẽ co nhiều hơn.
- **Cảm giác to nhỏ khi đọc.** Cùng cỡ em, chữ Latin có chiều cao chữ thường khoảng nửa chữ Hán, nên chữ Việt ≥85% cỡ chữ gốc vẫn trông nhỏ hơn chữ Trung.
- **Cỡ ước sai trên trang thật nói chung.** Chỉ 3 trang thật được đo; mức ước thấp 20% ở trang 94 dpi có thể khác ở sách và độ phân giải khác. Đoạn ngắn (tiêu đề, chú thích, dòng công thức) không đo được cỡ in.
- **Hình bị xóa nằm trong khung chữ.** Trang thật chưa có đáp án hình; vùng “hình giữ nguyên” là vùng bộ tách tự chọn. Biểu tượng cạnh chữ “探究” ở trang 5 bị khung đoạn che mất (ghi chú của người duyệt) mà không chỉ số nào bắt được.
- **Chữ Hán đi theo ảnh công thức** (như “时” trong p5-b4): trên trang thật không đếm tự động.
- **Thứ tự đọc, xuống dòng, tách đoạn sai, công thức nhận nhầm.** Harness fixture có các chỉ số riêng cho việc này (`tmp/pdf-layout/genre-fixtures/README.md`).
- **PDF có lớp chữ (không phải scan).** Cả hai bộ đo đều là ảnh scan; đường tách chữ của PDF gốc có lớp chữ khác (xóa chữ bằng redaction).
- **Phông chữ máy chủ.** Mọi số đo dựng trên Windows với Times New Roman. Máy chủ Linux dùng DejaVu Serif rộng hơn, nên chữ có thể co thêm hoặc tràn; chưa đo.
- **Bố cục ngoài bộ thử**: hai cột, chữ dọc, trang nghiêng hay cong, ảnh chụp, nền màu.
- **Mẫu nhỏ**: 7 trang tổng hợp và 3 trang thật, chưa có khoảng tin cậy thống kê.
- **Thời gian và chi phí token**: không đo vì không gọi Gemini; xem mục cuối.
- **Đọc trên điện thoại**: không đo.

## Câu nên dùng trong báo cáo

- Thay “giữ nguyên 90–95% bố cục” bằng: “Trên 3 trang scan thật của sách Toán, toàn bộ phần không phải chữ (hình, khung, đường kẻ) giữ nguyên, chỉ lệch nhiễu nén ảnh; 98,9% chữ Việt nằm đúng khung đoạn gốc, không đoạn nào tràn. Tiêu đề chương và chân trang (36 chữ Hán) chưa được dịch. 8/14 đoạn văn giữ ≥85% cỡ chữ in; 3 đoạn nhỏ hơn rõ, khoảng 80%.” Với bộ thử nhiều thể loại: “Trên 7 trang mẫu của 6 thể loại có đáp án chuẩn, với bản dịch thử dài 1 chữ Việt cho mỗi chữ Hán, 99,5% diện tích chữ Trung được thay, 0 đoạn tràn, 84% đoạn giữ ≥85% cỡ chữ gốc (thân bài 33/35).”
- Bỏ “tiết kiệm hơn 80% thời gian” cho tới khi chạy quy trình dưới đây. Có thể nói: “10 trang trong một lượt cần 7 thao tác trên Hoa Trí; số phút tiết kiệm chưa đo.”

## Thời gian tiết kiệm: chưa đo

### Quy trình đo

1. Chọn 10 trang scan liên tiếp của một sách (ví dụ Toán bản A, trang 3–12). Hai người làm, mỗi người làm cả hai cách theo thứ tự ngược nhau (người A làm thủ công trước, người B dùng Hoa Trí trước) để trừ hiệu ứng quen bài. Quay màn hình để đếm thao tác.
2. Thống nhất trước tiêu chí “xong” cho cả hai cách: mọi đoạn chữ Trung có bản Việt; hình và công thức có mặt ở đúng trang; người làm đọc lại một lượt và sửa lỗi nghĩa rõ ràng; có một tệp PDF hoặc DOCX đọc được trên điện thoại.
3. **Cách thủ công**: dùng một chatbot (ghi rõ tên, gói, model) với cùng một câu lệnh cố định. Với mỗi trang: xuất ảnh trang, đính kèm, dán câu lệnh, gửi, chờ, chép kết quả, dán vào Word, chèn lại hình và công thức, chỉnh định dạng.
4. **Cách Hoa Trí**: làm theo các thao tác ở bảng dưới; ghi số token và số lượt gọi từ ô “token Gemini trong tab này”.
5. Ghi cho mỗi người, mỗi cách: tổng thời gian từ lúc mở tệp đến khi có tệp kết quả; thời gian thao tác tay và thời gian chờ máy; số thao tác (đếm từ video); token và chi phí; số lỗi còn lại khi người thứ ba chấm (thiếu đoạn, sai công thức, hình sai chỗ).
6. Tiết kiệm = 1 − thời gian Hoa Trí / thời gian thủ công. Báo số phút từng cách của từng người, không làm tròn lên, không gộp thành một con số nếu hai người chênh nhiều.

### Thao tác đếm được trên giao diện hiện tại

Đếm theo `frontend/study.html` và `frontend/study.js` bản đã commit, chế độ “Giữ bố cục PDF” (mặc định bật), đã đăng nhập:

| # | Thao tác | Ghi chú |
|---:|---|---|
| 1 | Mở Xưởng dịch học tập | |
| 2 | Nhập “Tên nội dung” | bắt buộc |
| 3 | Chọn tệp PDF | tối đa 25 MB |
| 4 | Sửa ô “Trang PDF cần dịch” thành 10 trang cần dịch | ô tự điền 1–3; tối đa 20 trang mỗi lượt |
| 5 | Dán khóa Gemini | một lần cho mỗi tab; app tự kiểm tra model |
| 6 | Bấm “Bắt đầu dịch” | app tự tách trang, đọc lại ảnh, dịch theo lượt, lưu lịch sử, xuất PDF |
| 7 | Bấm “Xuất PDF tiếng Việt” để tải về | |

Tổng cộng 7 thao tác bắt buộc cho 10 trang, không đổi theo số trang trong giới hạn 20 trang. Chọn “Lĩnh vực”, thêm thuật ngữ, đổi bìa hay chọn sách là tùy chọn. Kiểm thử tự động `npm run test:pdf-layout` (`backend/benchmark-pdf-layout.mjs`) chạy chuỗi tương tự trên PDF 2 trang, không cần sửa phạm vi, Gemini được giả lập: mở trang, chọn tệp, nhập tên, chọn lĩnh vực, dán khóa, bấm dịch, tải PDF. Chế độ “Dịch cả quyển” đang làm nên chưa đếm.

Cách thủ công ở bước 3 cần ít nhất 6 thao tác mỗi trang (xuất ảnh, đính kèm, dán câu lệnh, gửi, chép, dán), tức ít nhất 60 thao tác cho 10 trang, cộng thao tác chèn hình, công thức và chỉnh định dạng. Đây là số đếm theo quy trình mô tả, chưa phải số đo.

### Lượt gọi Gemini (đếm từ mã, không gọi)

Theo cách app chia lượt (`ocrImageBatches`, `blockBatches`), mẫu c01 (3 trang scan, 27 đoạn) cần 1 lượt đọc ảnh (5 ảnh gộp, 2.400 KB) và 1 lượt dịch (2.139 ký tự nguồn): tổng 2 lượt gọi. Mỗi fixture (1–2 trang) cũng cần 1 + 1 lượt. Số token thật chưa đo; bước 4 của quy trình sẽ ghi lại.
