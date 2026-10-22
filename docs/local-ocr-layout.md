# OCR cục bộ và đối chiếu PDF

Đã tích hợp PP-OCRv5 mobile qua PaddleOCR.js 0.4.2 vào Xưởng dịch học tập (và bước chuẩn bị PDF scan của xưởng dịch `/admin`). Nhận dạng chạy trong Web Worker của trình duyệt bằng ONNX Runtime WASM, một luồng. Hai mô hình nằm sẵn trong repo (`backend/paddle-models/`, xem README ở đó) và được kiểm SHA-256 khi chuẩn bị dự án; trình duyệt tải chúng từ chính máy chủ Hoa Trí và chỉ giữ vào bộ đệm khi tệp đúng là mô hình (tệp tar), không giữ một trang lỗi thay cho mô hình. Không gửi ảnh hay khóa API tới máy chủ Paddle.

## Quy trình

Từ bản 22/10/2026, ảnh chụp trang (JPG, PNG, WebP, chọn một hoặc nhiều ảnh) được ghép thành một PDF ngay trong trình duyệt bằng pdf-lib (mỗi ảnh một trang, cạnh dài tối đa 2.400 điểm ảnh) rồi đi đúng các bước dưới đây, hoặc đường giữ bố cục nếu ô đó được tích. Từ lượt sửa thứ ba (23/10/2026), PDF này được tạo với `PDFDocument.create({updateMetadata:false})`, không ghi ngày tạo hay ngày sửa, nên chọn lại đúng các ảnh đó trên cùng trình duyệt cho ra đúng các byte cũ, tức cùng SHA-256: Xưởng dịch nhận ra lượt "Dịch cả quyển" đang dở và các phần đã có trong sách, không dịch lại. Trình duyệt hay thiết bị khác có thể nén ảnh (canvas JPEG) khác đi, khi đó tệp vẫn khác.

1. PDF.js lấy lớp chữ trước. Trang có lớp chữ đủ dùng không OCR.
2. Trang scan được render tối đa khoảng 1600 px, giữ bản màu cho hình học và dùng bản xám nén cho OCR.
3. PaddleOCR trả chữ, độ tin cậy và tọa độ từng dòng. Mỗi tab hỏi máy chủ một lần bản cài có PaddleOCR không (yêu cầu `HEAD /vendor/paddle/worker.js`, chờ tối đa 15 giây; mất kết nối, quá 15 giây hoặc máy chủ báo lỗi thì trang sau hỏi lại). Từ lượt sửa thứ hai của 22/10/2026, giới hạn 15 giây có cả trên trình duyệt chưa có `AbortSignal.timeout` (iOS/Safari 15.4–15.x): `timeoutSignal` trong `frontend/local-ocr.js` dùng `AbortController` và bộ hẹn giờ thay thế; trước đó yêu cầu này có thể chờ mãi. Bản cài không có PaddleOCR (404) thì dùng ngay Tesseract cục bộ, không mở worker. PaddleOCR có mà không chạy được (thiếu mô hình, lỗi tải, lỗi khởi tạo) thì tab đó chuyển sang Tesseract cho tới khi tải lại trang. Mỗi tài liệu đọc bằng Tesseract hiện một lần "Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR." kèm lý do, ví dụ "Bản cài Hoa Trí này chưa có PaddleOCR.", và dòng trạng thái ghi "Nhận dạng chữ bằng Tesseract trên thiết bị, thay cho PaddleOCR…".
4. Chỉ trang có quá ít chữ hoặc độ tin cậy thấp mới gọi Gemini OCR bằng khóa trong phiên của người học. Khóa vẫn bắt buộc trước khi bắt đầu dịch; không dùng khóa hệ thống thay thế.
5. Ghép các dòng OCR cùng đoạn theo tọa độ, giữ ranh giới tiêu đề và đoạn văn. Mỗi phần dịch thuộc đúng một trang PDF, tối đa 5000 ký tự; chỉ trang dài mới tách thành nhiều phần.
6. Tìm hình có chú thích đánh số bằng tọa độ OCR và nét ảnh liên thông. Cắt trực tiếp từ ảnh màu đã giữ thành PNG, gồm nhãn điểm và chú thích; không vẽ lại hình. Chữ nằm hoàn toàn trong hình đã cắt không trộn vào đoạn văn dịch của Paddle/Tesseract.
7. Hiện bản dịch với tiêu đề, đoạn văn và hình gần đoạn nhắc đến số hình; hình chưa khớp tham chiếu nằm cuối phần tương ứng. Nút **Đối chiếu trang gốc** mở ảnh nguyên trang. HTML tải xuống ("Tải HTML có hình") nhúng cả hình cắt và trang gốc, mở được ngoại tuyến. Trong trình duyệt của Zalo, Messenger, Facebook…, trước khi tải ".txt" hay HTML, trang hiện hộp "Mở bằng Safari/Chrome để tải tệp về máy" (vẫn tải được bằng "Vẫn tải ở đây"); địa chỉ tạm của tệp tải về giữ 60 giây hoặc tới khi rời trang.

Chọn tối đa 20 trang mỗi lần. Đổi phạm vi sẽ loại trang ngoài phạm vi khỏi bản dịch tiếp theo. Nếu sửa nguyên tác thủ công, hệ thống bỏ liên kết vị trí thay vì ghép nhầm trang.

## Chuẩn bị và chạy

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run dev -- --port 8789
```

Hai mô hình nằm sẵn trong `backend/paddle-models/`, không tải từ mạng (trước bản 22/10/2026, lệnh `npm run prepare:ocr` tải chúng từ máy chủ Baidu; lệnh đó đã bị bỏ). `setup` (bước 1–2) và `prepare:vendor` (tự chạy trước `npm run dev` và `npm run build`) kiểm kích thước, chữ ký tar và SHA-256 theo `manifest.json`, chép mô hình sang `frontend/vendor/paddle/models/`, đóng gói worker và chép WASM của ONNX Runtime. Các tệp trong `frontend/vendor/` không đưa vào Git. Mỗi tài nguyên dưới 25 MB để phù hợp tài nguyên tĩnh của Cloudflare Workers.

Thiếu hoặc hỏng mô hình không chặn cài đặt hay khởi động: `setup`/`prepare:vendor` báo CẢNH BÁO, xóa các tệp PaddleOCR cũ trong `frontend/vendor/paddle/`, và OCR trong trình duyệt dùng Tesseract. Lấy lại bằng `git checkout -- backend/paddle-models`. CI và `npm run deploy` chạy `prepare:vendor -- --require-paddle`, nên ở đó thiếu PaddleOCR là lỗi.

Lần tải đầu của PaddleOCR là khoảng 46 MB tệp: worker 10,6 MB, ONNX Runtime WASM 14,2 MB, hai mô hình 21,5 MB. Trang báo "khoảng 29 MB", khớp với worker và WASM khi được nén gzip (3,4 MB và 3,7 MB, đo trên máy) cộng hai mô hình; máy chủ không nén thì tải đủ khoảng 46 MB. Bản cài không có PaddleOCR thì Tesseract tải khoảng 9 MB (lõi WASM 3,9 MB, dữ liệu chữ Trung và Anh 4,7 MB). Trên Edge/Chrome đang bật tiết kiệm dữ liệu hoặc mạng chậm, trang hỏi trước lần tải đầu ("Tải bộ nhận dạng chữ về máy (khoảng 29 MB)?", hoặc 9 MB với Tesseract), trừ khi trình duyệt đã giữ bản tải trước. OCR cục bộ tiết kiệm token nhưng vẫn dùng CPU/RAM của thiết bị. Trình duyệt hiện đại có Web Worker, OffscreenCanvas và WASM SIMD phù hợp hơn. Bộ đệm không chứa tài liệu hay khóa; ảnh tài liệu chỉ nằm trong bộ nhớ tab và file HTML khi người học tải xuống.

## Kiểm thử lại

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:ocr -- "C:\duong-dan\sach-toan.pdf" "9,39,59,80,110"
```

Kiểm thử OCR dùng Edge cài sẵn, không gọi Gemini. API dịch được mô phỏng riêng để kiểm tra giao diện upload, khóa bắt buộc, đổi phạm vi, bố cục điện thoại và xuất HTML. Kết quả OCR, ảnh giao diện và HTML ở `tmp/ocr-benchmark/`; không nhầm bản dịch mô phỏng với kết quả dịch thật.

Trong `npm test`: `backend/paddle-assets.test.mjs` kiểm mô hình trong repo (từng byte theo `manifest.json`, giấy phép, README) và việc cài hay dọn PaddleOCR; `backend/local-ocr-fallback.test.mjs` (không cần trình duyệt) kiểm đường chuyển sang Tesseract và giới hạn 15 giây của lần hỏi PaddleOCR, kể cả khi trình duyệt thiếu `AbortSignal.timeout`; hai test Edge trong `backend/study-ui-states.test.mjs` chạy cả luồng của trang khi bản cài không có PaddleOCR và khi worker PaddleOCR không mở được.

## Giới hạn hiện tại

PDF.js là bản legacy của `pdfjs-dist` (từ 22/10/2026, `backend/pdfjs-vendor.mjs` thêm một dòng `Promise.withResolvers` ở đầu tệp), chạy trên iOS/Safari 16.4 trở lên; trình duyệt cũ hơn được báo "Trình duyệt này chưa đọc được PDF…" thay vì lỗi tiếng Anh. Độ tin cậy OCR là điểm nội bộ của mỗi mô hình, không phải độ chính xác so với bản chuẩn. Chưa đo CER hoặc độ đúng công thức trên toàn bộ sách. OCR chữ có thể nhận sai phân số, chỉ số và ký hiệu; ảnh gốc luôn được giữ để đối chiếu. Thứ tự hai cột chỉ có quy tắc hình học đơn giản.

Bộ tách hình hiện dùng quy tắc cục bộ, yêu cầu chú thích đánh số và nét hình đủ rõ. Hình thiếu chú thích, nhãn OCR sai hoặc bố cục không chắc chắn có thể chưa tách được; chúng vẫn nằm nguyên trong ảnh trang gốc để đối chiếu. Không coi mọi vùng trắng hoặc phương trình là hình. Đây chưa phải mô hình bố cục PP-StructureV3 hay nhận dạng công thức PP-FormulaNet; chưa xuất PDF thay chữ trong đúng khung.

Việc hỏi bản cài có PaddleOCR dùng yêu cầu `HEAD`. Theo mã nguồn, máy chủ tệp tĩnh của wrangler nhận `HEAD`, nhưng chưa thử trên `wrangler dev` đang chạy hay trên Cloudflare thật; máy chủ nào trả lỗi cho `HEAD` thì mọi trang dùng Tesseract (an toàn, nhưng bỏ phí PaddleOCR). Lỗi của thư viện PaddleOCR lúc khởi tạo hay lúc đọc trang vẫn kèm chi tiết tiếng Anh trong ngoặc. Trang coi Tesseract là đã có trong trình duyệt (không hỏi, không báo tải) khi dữ liệu chữ Trung và Anh đã nằm trong IndexedDB; lõi WASM 3,9 MB thì dựa vào bộ đệm HTTP thông thường, nên có thể vẫn được tải lại.

Tài liệu API chính thức: [PaddleOCR.js](https://www.paddleocr.ai/main/en/version3.x/inference_deployment/cross_platform/browser.html).
