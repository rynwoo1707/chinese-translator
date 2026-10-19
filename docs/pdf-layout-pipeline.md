# PDF giữ bố cục trong Hoa Trí

Luồng mới: PDF → PyMuPDF → JSON block theo ID → Gemini Flash → HTML/CSS đo font bằng Puppeteer → PDF tiếng Việt. Giao diện hiển thị hai bản cùng trang, cùng mức zoom, cuộn đồng bộ. Bản dịch và PDF được lưu riêng theo tài khoản học sinh trong R2; bản hoàn tất gắn vào chương trong Thư viện riêng.

Với trang scan, PyMuPDF/Tesseract được dùng để tìm vùng chữ và hình; Gemini đọc lại ảnh gốc của từng đoạn trước khi dịch để sửa các thuật ngữ màu xanh và chữ mờ. Vị trí box không do Gemini tạo lại. Đoạn đã dịch mới được ghép vào bản xem trước; các đoạn đang chờ giữ ảnh gốc. Bố cục scan cũ trong lịch sử được xử lý thành một asset mới khi bấm Bắt đầu dịch.

## Chạy dịch vụ

Cloudflare Worker không chạy Python hoặc Chromium trực tiếp. `services/pdf-layout/server.mjs` là dịch vụ riêng, không ghi tài liệu/khóa Gemini xuống đĩa. Worker xác thực tài khoản rồi gọi dịch vụ với token máy chủ. Gemini được gọi từ Worker bằng khóa của học sinh; dịch vụ PDF chỉ nhận PDF hoặc nội dung đã dịch.

Windows (PowerShell):

```powershell
python -m pip install --target .runtime/pdf-python -r services/pdf-layout/requirements.txt
npm.cmd run prepare:pdf-ocr
npm.cmd run dev:pdf-layout
```

Lệnh `dev:pdf-layout` tự tạo token kết nối ngẫu nhiên và cấu hình localhost trong `.dev.vars` nếu chưa có, giữ các cấu hình hiện tại. Token không được in ra màn hình và `.dev.vars` nằm trong `.gitignore`. Mở terminal khác và chạy `npm.cmd run dev` (hoặc khởi động lại Wrangler đang chạy). Nếu cấu hình dịch vụ thủ công/triển khai từ xa, dùng `server.mjs` và đặt:

```dotenv
PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:8091
PDF_LAYOUT_SERVICE_TOKEN=the-same-secret-as-the-service
GEMINI_MODEL=gemini-3.6-flash
# Optional: set only when PDF blocks should use a different model.
GEMINI_PDF_BLOCK_MODEL=
```

Trên web chọn PDF, bật “Giữ bố cục PDF”, chọn tối đa 20 trang và bấm Bắt đầu dịch. Bản PDF tự xuất sau khi dịch đủ các block. Có thể dừng giữa các batch, mở lại lịch sử rồi tiếp tục. “Chỉnh bản dịch từng đoạn” cho phép sửa một block, lưu và xuất lại mà không gọi Gemini. Bản PDF cũ được vô hiệu hóa khi nội dung thay đổi. Muốn dùng engine văn bản cũ, bỏ chọn chế độ giữ bố cục.

PDF kế thừa `GEMINI_MODEL` theo cấu hình dịch hiện có. `GEMINI_PDF_BLOCK_MODEL` chỉ dùng để ghi đè có chủ đích; launcher không tự đặt model khác. Nếu gặp 404 với `gemini-2.5-flash` trong khi cấu hình chung đã dùng model khác, xóa hoặc để trống dòng `GEMINI_PDF_BLOCK_MODEL`, rồi khởi động lại Wrangler. Model 2.5 hiện bị Google giới hạn cho dự án từng dùng trước đó; xem [danh sách model](https://ai.google.dev/gemini-api/docs/models).

“Kiểm tra model của khóa” lấy danh sách model từ Google bằng khóa trong tab, cho phép chọn Flash khả dụng và hiển thị model thực sự dùng. Lỗi 404 được thử lại với model Flash cùng nhóm, không tự chuyển từ Flash-Lite lên Flash hoặc Pro. Endpoint tài khoản `/api/my/study/config` và trạng thái quản trị cho biết model PDF thực tế, giúp nhận ra server còn giữ cấu hình cũ trong bộ nhớ.

Nếu Chromium không nằm ở vị trí Edge mặc định, đặt `CHROMIUM_EXECUTABLE_PATH`. Font PDF nhúng từ `PDF_FONT_PATH`, mặc định Times New Roman trên Windows và DejaVu Serif trên Linux. Dịch vụ có hai lượt xử lý đồng thời, tối đa 25 MB PDF đầu vào và 20 trang mỗi lượt. Triển khai thực tế cần đặt sau HTTPS và giới hạn truy cập bằng token.

Docker (build từ thư mục gốc của repo):

```sh
docker build -f services/pdf-layout/Dockerfile -t hoa-tri-pdf .
docker run --rm -p 127.0.0.1:8091:8091 -e PDF_LAYOUT_SERVICE_TOKEN="your-long-secret" hoa-tri-pdf
```

**Thứ tự cập nhật.** Worker và dịch vụ PDF dùng chung bộ kiểm tra tài liệu (`frontend/pdf-box-layout.js`). Khi cập nhật, triển khai Worker trước hoặc cùng lúc với dịch vụ PDF; không chạy dịch vụ mới với Worker cũ hay ngược lại. Ví dụ: dịch vụ mới lưu ảnh trang scan dạng JPEG, còn bộ kiểm tra cũ chỉ nhận PNG nên mọi trang scan báo "Ảnh trang PDF không hợp lệ.". Khi đã có tài liệu JPEG trong R2, bản rollback của cả hai phía vẫn phải giữ bộ kiểm tra nhận `png|jpeg`. Trên máy cá nhân, `npm start`/`start.cmd` chạy cả hai cùng phiên bản; `npm run dev:pdf-layout` tự khởi động lại khi code thay đổi. Nếu cổng 8091 vẫn bị một tiến trình cũ chiếm, hãy dừng tiến trình đó trước khi chạy lại.

## Hình, công thức và scan

PyMuPDF đọc `get_text('dict')` để lấy block, span, font, màu, box. Trang được chuẩn hóa rotation; mọi box dùng point và gốc tọa độ trên trái. Ảnh nhúng và vector vẫn nằm trên nền. Chỉ chữ trong block tiếng Trung được xóa để chèn chữ Việt. Các span toán/Latin riêng trong block được chụp từ bản gốc và thay bằng token bất biến, ghép lại dưới dạng ảnh inline. Công thức độc lập và nhãn điểm không có chữ Hán được giữ trên nền.

PDF scan cần OCR trước khi có box. Dịch vụ dùng PyMuPDF/Tesseract `chi_sim+eng`, không tải Marker/model nặng. Docker đã có ngôn ngữ OCR; trên Windows `prepare:pdf-ocr` giải nén dữ liệu có sẵn trong dự án vào `.runtime/tessdata`. Có thể đặt `TESSDATA_PREFIX` để dùng dữ liệu OCR khác. Trang scan có header/footer chữ thật được nhận diện theo vùng ảnh và chữ trong thân trang. OCR không bảo đảm đúng mọi công thức, nên giao diện báo trang dùng OCR và luôn giữ bản gốc để đối chiếu. Ở scan, những span tiếng Trung được che bằng nền trắng; trang màu/phức tạp cần kiểm tra lại bằng hai bản.

Đây là bản dàn trang giữ vị trí, không phải bản tái dựng vector hoàn toàn: lớp nền hình được raster hóa ở 1.6x, ký hiệu inline ở 2.5x; chữ Việt trong PDF là chữ thật, có thể tìm/chép. Font giảm tự động trong đúng box gốc (tối thiểu 5.5pt hoặc cỡ gốc nếu nhỏ hơn). Khi vẫn tràn box, xuất PDF dừng và báo ID block, không cắt mất chữ. Các trang có kích thước khác nhau được in từng trang và ghép lại bằng PyMuPDF.

Các nhóm công thức độc lập được giữ bằng ảnh nguyên bản; chữ ngắn nằm trong ảnh công thức (như điều kiện và tên quy tắc) vẫn theo bản gốc. Ký hiệu vectơ do OCR trả bằng `\vec`/`\overrightarrow` được bảo vệ khi dịch và dựng mũi tên trong HTML, tránh in mã LaTeX thô lên PDF. Font Việt nhúng hỗ trợ in đậm tổng hợp cho tiêu đề.

## Kiểm tra

`npm.cmd test` kiểm tra xác thực, ID block, công thức bất biến và thư viện. `npm.cmd run test:pdf-layout` dùng PDF mẫu có chữ Trung, công thức inline, vector và ảnh để chạy PyMuPDF + Puppeteer thật, kiểm tra kích thước trang, tràn chữ và lưu/mở lại giao diện. Gemini được giả lập trong benchmark để không tốn token và không dùng khóa thật.

Tài liệu chính thức: [PyMuPDF Page API](https://pymupdf.readthedocs.io/en/latest/page.html), [Puppeteer PDF](https://pptr.dev/api/puppeteer.page.pdf), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output).
