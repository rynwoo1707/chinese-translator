# PDF giữ bố cục trong Hoa Trí

Luồng mới: PDF → PyMuPDF → JSON block theo ID → Gemini Flash → HTML/CSS đo font bằng Puppeteer → PDF tiếng Việt. Giao diện hiển thị hai bản cùng trang, cùng mức zoom, cuộn đồng bộ. Bản dịch và PDF được lưu riêng theo tài khoản học sinh trong R2; bản hoàn tất gắn vào chương trong Thư viện riêng.

Với trang scan, PyMuPDF/Tesseract được dùng để tìm vùng chữ và hình; Gemini đọc lại ảnh gốc của từng đoạn trước khi dịch để sửa các thuật ngữ màu xanh và chữ mờ. Vị trí box không do Gemini tạo lại. Từ lượt sửa thứ hai của 22/10/2026, một đoạn mà câu đọc của Gemini không dùng được (dải ảnh trống, thiếu hay trùng câu trả lời, mất mã công thức, lẫn chữ giữa các đoạn; hoặc cả lượt bị từ chối, bị cắt, hỏng) giữ chữ OCR máy và được đánh dấu `ocrKept` (`empty`, `unread`, `formula`, `mixed`, `refused`, `truncated`, `malformed`; `backend/pdf-block-ocr.js`), các đoạn khác giữ bản đọc của Gemini, kèm cảnh báo "Trang N · đoạn k: <lý do>. Đoạn này giữ chữ OCR máy, có thể sai; hãy đối chiếu với trang gốc." Đoạn như vậy được lưu như đã đọc xong nên không bị gửi lại; lỗi khóa, hạn mức, Gemini quá tải, khu vực hay model thì vẫn dừng cả lượt và không lưu gì. Dấu `ocrKept` được lưu trên block trong manifest (`backend/pdf-layout-apply.js`), trả kèm trong câu trả lời gọn của `/ocr-blocks`, và bị xóa khi một lượt đọc sau đọc được đoạn đó. Đoạn đã dịch mới được ghép vào bản xem trước; các đoạn đang chờ giữ ảnh gốc. Bố cục scan cũ trong lịch sử được xử lý thành một asset mới khi bấm Bắt đầu dịch.

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

Trên web chọn PDF, bật “Giữ bố cục PDF và xuất PDF tiếng Việt”, chọn tối đa 20 trang và bấm Bắt đầu dịch. Bản PDF tự xuất sau khi dịch đủ các block. Có thể dừng giữa các batch, mở lại lịch sử rồi tiếp tục. “Chỉnh bản dịch từng đoạn” cho phép sửa một block, lưu (“Lưu đoạn đã sửa”) và xuất lại mà không gọi Gemini. Khi lần xuất bị từ chối vì bản dịch dài hơn khung (422 `pdf_overflow` kèm `blocks:[{page,id}]`), khung hai trang viền đỏ các block đó, ô chọn đoạn ghi “Dài hơn khung chữ” và ô sửa mở sẵn block đầu tiên; “Dịch cả quyển” ghi một chú thích ngắn cho lượt đó rồi dịch tiếp. Bản PDF cũ được vô hiệu hóa khi nội dung thay đổi. Muốn dùng engine văn bản cũ, bỏ chọn chế độ giữ bố cục.

PDF kế thừa `GEMINI_MODEL` theo cấu hình dịch hiện có. `GEMINI_PDF_BLOCK_MODEL` chỉ dùng để ghi đè có chủ đích; launcher không tự đặt model khác. Nếu gặp 404 với `gemini-2.5-flash` trong khi cấu hình chung đã dùng model khác, xóa hoặc để trống dòng `GEMINI_PDF_BLOCK_MODEL`, rồi khởi động lại Wrangler. Model 2.5 hiện bị Google giới hạn cho dự án từng dùng trước đó; xem [danh sách model](https://ai.google.dev/gemini-api/docs/models).

“Kiểm tra phiên bản dùng được với khóa” (trong “Nâng cao”) lấy danh sách model từ Google bằng khóa trong tab, cho phép chọn Flash khả dụng và hiển thị model thực sự dùng. Lỗi 404 được thử lại với model Flash cùng nhóm, không tự chuyển từ Flash-Lite lên Flash hoặc Pro. Endpoint tài khoản `/api/my/study/config` và trạng thái quản trị cho biết model PDF thực tế, giúp nhận ra server còn giữ cấu hình cũ trong bộ nhớ.

Nếu Chromium không nằm ở vị trí Edge mặc định, đặt `CHROMIUM_EXECUTABLE_PATH`. Font PDF nhúng từ `PDF_FONT_PATH`; không đặt thì Windows dùng Times New Roman, Linux dùng Liberation Serif 2 (gói `fonts-liberation2`), rồi Liberation Serif 1, rồi DejaVu Serif. Liberation Serif có cùng độ rộng chữ với Times New Roman mà mọi phép đo độ vừa khung đã dùng; DejaVu Serif rộng hơn khoảng 26% nên chữ co nhiều hơn. `/health` của dịch vụ báo tên tệp phông đang dùng. Dịch vụ chạy `PDF_LAYOUT_JOBS` việc cùng lúc (mặc định 2) và Worker chia các chỗ đó cho cả trang web (`PDF_LAYOUT_SLOTS`, mặc định 2): hết chỗ thì trình duyệt nhận 503 `pdf_service_busy` và tự chờ. Tối đa 25 MB PDF đầu vào và 20 trang mỗi lượt; mỗi lượt tách trang tự dừng ở khoảng 170 s (`PDF_EXTRACT_SECONDS`) và trả các trang đã xong. Người gọi rời đi (đóng thẻ, Worker hết 280 s) thì dịch vụ dừng việc ngay. Triển khai thực tế cần đặt sau HTTPS và giới hạn truy cập bằng token: `deploy/pdf-layout/README.md`.

Lỗi mà dịch vụ trả (`services/pdf-layout/server.mjs` `failureAnswer`), và mã Worker đưa cho trình duyệt (`backend/pdf-layout.js` `serviceFailure`):

| Dịch vụ | Khi nào | Worker |
|---|---|---|
| 503 `busy` | mọi việc của dịch vụ đang chạy | 503 `pdf_service_busy`, `Retry-After: 20` |
| 422 `overflow`, `blocks:[{page,id}]` | bản dịch dài hơn khung ở cỡ chữ nhỏ nhất; dịch vụ đo hết mọi trang trước khi trả, câu báo nêu “Trang N” và “Đoạn k” (k là thứ tự block trong trang, như khung hai trang đánh số), tối đa 5 đoạn rồi “và N đoạn khác” | 422 `pdf_overflow`, câu báo tới 600 ký tự, `blocks` đã lọc |
| 422 `timeout`, `memory`, `too_large`, `crash` | việc quá thời gian, hết bộ nhớ (kể cả `MemoryError` trong `extract.py`), kết quả quá lớn, tiến trình hay Chromium chết giữa chừng | 413 `pdf_timeout`, `pdf_memory`, `pdf_too_large`, `pdf_crash` |
| 422 không mã | lỗi của chính tệp, ví dụ “Trang 3: …” | 400 |
| 500 `browser` | Chromium không khởi động được (lỗi gốc chỉ ghi vào nhật ký của dịch vụ) | 503 `pdf_unavailable`, `Retry-After: 30` |
| 400 không mã | JSON hỏng hay không phải object, header `X-PDF-Pages` hỏng | 400 |
| 413 `too_large` | thân yêu cầu quá 25 MiB (PDF) hay 40 MiB (JSON); dịch vụ đọc hết thân yêu cầu rồi mới trả lời, chỉ cắt kết nối khi người gửi vượt thêm 64 MiB | 413 `pdf_too_large` |

Câu báo dạng mã block (“Trang N: chữ Việt không vừa box (p4-b1, …), kể cả ở cỡ chữ nhỏ nhất…”) vẫn có trong nhật ký của dịch vụ và trong `npm run samples -- render`.

Docker (build từ thư mục gốc của repo):

```sh
docker build -f services/pdf-layout/Dockerfile -t hoa-tri-pdf .
docker run --rm -p 127.0.0.1:8091:8091 -e PDF_LAYOUT_SERVICE_TOKEN="your-long-secret" hoa-tri-pdf
```

**Thứ tự cập nhật.** Worker và dịch vụ PDF dùng chung bộ kiểm tra tài liệu (`frontend/pdf-box-layout.js`). Khi cập nhật, triển khai Worker trước hoặc cùng lúc với dịch vụ PDF; không chạy dịch vụ mới với Worker cũ hay ngược lại. Ví dụ: dịch vụ mới lưu ảnh trang scan dạng JPEG, còn bộ kiểm tra cũ chỉ nhận PNG nên mọi trang scan báo "Ảnh trang PDF không hợp lệ.". Khi đã có tài liệu JPEG trong R2, bản rollback của cả hai phía vẫn phải giữ bộ kiểm tra nhận `png|jpeg`. Từ bản 22/10/2026, việc lệch được phát hiện: `/health` của dịch vụ trả `version.layout` (mã băm của `frontend/pdf-box-layout.js` và `frontend/math-text.js`, viết bởi `services/pdf-layout/version.mjs`) và `version.service`; `npm run deploy` đặt var `PDF_LAYOUT_VERSION` cho Worker, nên `GET /api/health?deep=1` báo `"status":"mismatch"` (mã 503) khi hai bên lệch, và `smoke.mjs` cảnh báo khi dịch vụ khác bản mã nguồn trên máy chạy nó. Trên máy cá nhân, `npm start`/`start.cmd` chạy cả hai cùng phiên bản; `npm run dev:pdf-layout` tự khởi động lại khi code thay đổi. Nếu cổng 8091 vẫn bị một tiến trình cũ chiếm, hãy dừng tiến trình đó trước khi chạy lại.

## Hình, công thức và scan

PyMuPDF đọc `get_text('dict')` để lấy dòng, span, font, màu, box. Từ bản 22/10/2026, các dòng không còn theo block của MuPDF mà được gộp lại thành đoạn văn: dòng bị cắt trên cùng một đường chân chữ được nối lại; pinyin trên chữ Hán và dấu chấm nhấn dưới chữ bị bỏ khỏi nguồn dịch; dòng sau vào cùng đoạn khi cùng cỡ, phông, độ đậm, màu, khoảng cách dòng đều, dòng trên chạy tới mép cột, dòng sau ở lề hoặc dưới dòng đầu thụt vào, và không có dấu đầu dòng, đường kẻ, hình hay mục ngắn kiểu ô bảng chen giữa. Block có `indent` (khoảng thụt đầu dòng) như block scan. Thứ tự block theo hàng, theo cột khi có rãnh giữa các cột (dùng chung bộ dò rãnh của trang scan), và chữ dọc từ phải sang trái. Chỉ chữ người đọc nhìn thấy mới được dùng: lớp chữ ẩn của bản scan có OCR, chữ in dưới một ảnh phủ trang, chữ đã chuyển thành nét vẽ và lớp chữ không có bảng mã Unicode đưa trang sang OCR (hoặc giữ ảnh gốc) kèm cảnh báo; chữ xoay và chữ dọc trong cột hẹp giữ ảnh gốc. Trang được chuẩn hóa rotation; mọi box dùng point và gốc tọa độ trên trái. Ảnh nhúng và vector vẫn nằm trên nền. Chỉ chữ trong block tiếng Trung được xóa để chèn chữ Việt. Các span toán/Latin riêng trong block được chụp từ bản gốc và thay bằng token bất biến, ghép lại dưới dạng ảnh inline. Công thức độc lập và nhãn điểm không có chữ Hán được giữ trên nền.

Từ lượt sửa thứ hai của 22/10/2026 (`extract.py`, `extractionVersion` vẫn là 3):

- **Công thức tách khỏi dòng chữ Hán** (`inline_pieces`): MuPDF hay để một công thức, số hay chữ Latin cách dòng chữ Hán hơn khoảng 0,7 em thành một dòng riêng. Mẩu không có chữ Hán (không chỉ là dấu câu), cùng đường chân chữ với một dòng chữ Hán (lệch tối đa 0,3 em), cách nó tối đa 2 em và cỡ chữ không chênh quá 1,6 lần, nay được gộp vào dòng đó thành token inline như mọi span công thức (`source` ví dụ `向量的长度 @@PDF_INLINE_1@@`, một dấu cách ở chỗ có khoảng trống thật), box của block nới ra bao lấy nó, và nó được xóa khỏi nền cùng block. Các mẩu nối tiếp nhau được (Hán–công thức–Hán, công thức cạnh công thức, dấu câu đứng riêng ở giữa). Không gộp khi mẩu đứng trong một cột các mẩu (một mẩu không có chữ Hán khác cách 0,6–4 em phía trên hay dưới, thẳng lề trái, phải hay giữa trong 0,25 em: bảng không kẻ, lưới, tử và mẫu của phân số xếp chồng), khi có nét vẽ nằm giữa hai bên, khi rãnh cột chia hai bên, khi mẩu là nhãn của một hình (có nét vẽ trong vòng 0,5 em không phải mũi tên, gạch hay khung của chính nó), khi mẩu bên phải mở đầu một mục (dấu đầu dòng, hay lựa chọn A–H theo sau bởi `.`, `．`, `、`), hay khi cách quá 2 em. Trước đây các mẩu đó không thuộc block nào và giữ nguyên tiếng Trung trên nền.
- **Bộ thủ Khang Hy và chữ “tương thích”**: chữ trong U+2E80–2EF3, U+2F00–2FD5 và U+F900–FAFF mà dạng NFKC là đúng một chữ Hán thường (2 chữ bộ thủ bổ sung, 214 bộ thủ Khang Hy, 460 chữ tương thích) được đổi về chữ đó trong `source`, `text` và việc đếm chữ Hán, sau bước kiểm tra lớp chữ không đọc được. Kết quả có thể là chữ ở mặt phẳng phụ (Extension B, viết thành cặp `\uD8xx\uDCxx` trong JSON chỉ ASCII); `HAN` đếm cả U+20000–U+323AF. Máy chủ dùng cùng quy tắc trước khi dịch (`backend/han-text.js`). Không chuẩn hóa gì khác (dấu câu và chữ Latin toàn chiều rộng giữ nguyên).
- **Chỗ điền và viền bảng**: một nét kẻ dưới chân chữ chỉ là chỗ điền `____` khi nó đứng riêng; nét chạm đầu vào một nét dọc (viền ô, khung) hay nối thẳng hàng với nét kẻ khác thì giữ là nét vẽ. Trước đây ô của bảng kẻ sát chữ nhận `____`, box lấn sang ô bên và viền ô bị xóa khỏi nền.
- **Hết bộ nhớ**: câu trả lời lỗi của `extract.py` là `{"error": …, "code": "memory"}` khi lỗi là `MemoryError` (câu báo không đổi).

PDF scan cần OCR trước khi có box. Dịch vụ dùng PyMuPDF/Tesseract `chi_sim+eng`, không tải Marker/model nặng. Docker đã có ngôn ngữ OCR; trên Windows `prepare:pdf-ocr` giải nén dữ liệu có sẵn trong dự án vào `.runtime/tessdata`. Có thể đặt `TESSDATA_PREFIX` để dùng dữ liệu OCR khác. Trang scan có header/footer chữ thật được nhận diện theo vùng ảnh và chữ trong thân trang. OCR không bảo đảm đúng mọi công thức, nên giao diện báo trang dùng OCR và luôn giữ bản gốc để đối chiếu. Ở scan, những span tiếng Trung được che bằng nền trắng; trang màu/phức tạp cần kiểm tra lại bằng hai bản.

Đây là bản dàn trang giữ vị trí, không phải bản tái dựng vector hoàn toàn: lớp nền hình được raster hóa ở 1.6x, ký hiệu inline ở 2.5x; chữ Việt trong PDF là chữ thật, có thể tìm/chép. Font giảm tự động trong đúng box gốc (tối thiểu 5.5pt hoặc cỡ gốc nếu nhỏ hơn). Khi vẫn tràn box, xuất PDF dừng, không cắt mất chữ: dịch vụ vẫn đo các trang còn lại (không in) để một câu trả lời nêu mọi block tràn của tài liệu (bảng lỗi ở trên). Các trang có kích thước khác nhau được in từng trang và ghép lại bằng PyMuPDF.

Các nhóm công thức độc lập được giữ bằng ảnh nguyên bản; chữ ngắn nằm trong ảnh công thức (như điều kiện và tên quy tắc) vẫn theo bản gốc. Ký hiệu vectơ do OCR trả bằng `\vec`/`\overrightarrow` được bảo vệ khi dịch và dựng mũi tên trong HTML, tránh in mã LaTeX thô lên PDF. Font Việt nhúng hỗ trợ in đậm tổng hợp cho tiêu đề.

## Kiểm tra

`npm.cmd test` kiểm tra xác thực, ID block, công thức bất biến và thư viện; các test Python của bộ tách (`services/pdf-layout/test_*.py`, gồm `test_text_layer.py` cho lớp chữ, đoạn văn, thứ tự đọc, chữ dọc và ngân sách thời gian) chạy qua các tệp `backend/pdf-extract-*.test.mjs` (lớp `InlinePieces` và `UnifiedIdeographs` của `test_text_layer.py` kiểm hai quy tắc mới ở trên), và `backend/pdf-layout-service.test.mjs` kiểm dịch vụ (báo bận, dừng việc khi người gọi rời đi, phông, kiểm tra sức khỏe, dữ liệu hỏng hay quá lớn, trình duyệt không khởi động được, câu báo bản dịch dài hơn khung); `backend/pdf-engine-browser.test.mjs` xuất thật bằng Edge/Chrome một tài liệu có block tràn ở nhiều trang. `npm.cmd run test:pdf-layout` dùng PDF mẫu có chữ Trung, công thức inline, vector và ảnh để chạy PyMuPDF + Puppeteer thật, kiểm tra kích thước trang, tràn chữ và lưu/mở lại giao diện; hiện lệnh này treo ở bước mở "Lịch sử dịch" vì giao diện đã đổi (ONBOARDING mục 7). Gemini được giả lập trong benchmark để không tốn token và không dùng khóa thật. Số đo bố cục: `docs/layout-metrics.md`.

Tài liệu chính thức: [PyMuPDF Page API](https://pymupdf.readthedocs.io/en/latest/page.html), [Puppeteer PDF](https://pptr.dev/api/puppeteer.page.pdf), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output).
