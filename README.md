# Hoa Trí

[![CI](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/rynwoo1707/chinese-translator/actions/workflows/ci.yml)

Web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini (mỗi người dịch dán khóa Gemini của mình), chạy trên Cloudflare Workers (D1 + R2). Một dịch vụ PDF riêng (Python/PyMuPDF + Chromium) tách trang và dựng PDF tiếng Việt theo bố cục trang gốc.

- **Xưởng dịch học tập** (`/study`): dịch một số trang của PDF (tối đa 20 trang mỗi lượt, tệp tới 25 MB) hoặc **"Dịch cả quyển"** (tệp tới 100 MB, tự chia lượt, dừng rồi dịch tiếp được, kể cả trên máy khác); cũng nhận TXT, DOCX, EPUB, AZW3 và ảnh chụp trang (JPG, PNG, WebP; ghép thành một PDF ngay trên máy).
- **Bốn "Cách dịch"**: Tiết kiệm (mặc định), Cân bằng, Kỹ hơn, Kỹ nhất, khác nhau ở mức suy luận của Gemini, cỡ mỗi lượt gọi, độ mịn của ảnh OCR trang scan, việc đọc lại đoạn OCR đáng ngờ và dịch lại đoạn chưa đạt; dùng được cả khi giữ bố cục PDF và khi dịch cả quyển. Đo bằng Gemini thật trên 3 trang scan: Tiết kiệm 3 lần gọi, 19.022 token; phần đọc ảnh của Kỹ nhất 1,6 lần của Tiết kiệm; phần còn lại vẫn là ước tính ([ONBOARDING](ONBOARDING.md) mục 4.6, 8).
- **Công thức**: môi trường LaTeX nhiều dòng (hệ phương trình `cases`, ma trận, `aligned`, bảng `array` có đường kẻ…) và nhiều lệnh khác được vẽ thành công thức trong bản xem và PDF tiếng Việt; chữ vẫn chép ra được, kể cả dấu ngoặc và mũi tên vẽ, và công thức rộng hơn màn hình điện thoại cuộn ngang trong khung riêng.
- **Thư viện riêng**: "Tải về" → "Cả quyển (PDF)" ghép bản dịch vào đúng chỗ trong sách gốc; **"Song ngữ"** đặt trang gốc cạnh trang dịch; trang đọc nhớ chỗ đang đọc khi tải lại.
- **Tra chữ Hán**: pinyin, âm Hán Việt và nghĩa bằng từ điển offline, không dùng Gemini.
- 7 lĩnh vực; Toán, Vật lý, Hóa học, Sinh học, Tin học có sẵn thuật ngữ sách giáo khoa.
- Tài khoản phải đồng ý điều khoản; mật khẩu dễ đoán bị từ chối và nhập sai nhiều lần thì bị khóa tạm; người dùng tự đổi mật khẩu, đăng xuất khỏi mọi thiết bị, xóa lịch sử hoặc cả tài khoản; quản trị viên khóa hoặc xóa tài khoản và tạo liên kết đặt lại mật khẩu (dùng xong liên kết thì khóa do nhập sai của tài khoản cũng được gỡ).
- **Quản trị** (`/admin`): mỗi quản trị viên đăng nhập bằng tài khoản riêng (tên đăng nhập và mật khẩu), thêm hay xóa quản trị viên trong "Cài đặt". `ADMIN_TOKEN` chỉ được gõ một lần để tạo tài khoản quản trị đầu tiên (và khi đặt lại mật khẩu quản trị bị quên); nó vẫn là khóa mã hóa của máy chủ và mã `Bearer` của các công cụ dòng lệnh. Việc dịch của quản trị viên mặc định dùng cách Kỹ nhất.
- Trình duyệt: Chrome, Edge, Firefox bản mới hoặc Safari/iOS 15.4 trở lên; đọc và dịch PDF cần iOS/Safari 16.4 trở lên.

**Số đo bố cục:** trên 3 trang scan thật của sách Toán, toàn bộ phần không phải chữ (hình, khung, đường kẻ) giữ nguyên, chỉ lệch nhiễu nén ảnh; 98,9% chữ Việt nằm đúng khung đoạn gốc, không đoạn nào tràn. Tiêu đề chương và chân trang (36 chữ Hán) chưa được dịch. 8/14 đoạn văn giữ ≥85% cỡ chữ in; 3 đoạn nhỏ hơn rõ, khoảng 80%. PDF có lớp chữ mới được đo trên trang tổng hợp, chưa đo trên sách thật. Thời gian tiết kiệm được chưa đo. Cách đo và giới hạn: [docs/layout-metrics.md](docs/layout-metrics.md).

## Chạy trên máy Windows

1. Clone vào thư mục có đường dẫn ngắn (Windows giới hạn độ dài đường dẫn):
   ```powershell
   git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git C:\src\chinese-translator
   ```
2. Mở thư mục `C:\src\chinese-translator` và bấm đúp **`start.cmd`**.
   - Lần đầu: nếu máy chưa có Node.js hoặc Python, nó hỏi rồi tự cài (bằng winget). Sau đó nó cài thư viện, chạy `npm run setup` (vài phút, cần Internet, tải thêm khoảng 18 MB dữ liệu từ điển; mô hình OCR PaddleOCR có sẵn trong repo) và tự mở trình duyệt.
   - Các lần sau: bấm đúp `start.cmd` là chạy, kèm cập nhật code mới nhất và áp migration mới vào cơ sở dữ liệu local. Cửa sổ ghi "Không cập nhật được code mới…" thì app vẫn chạy bản cũ: xem [ONBOARDING](ONBOARDING.md) mục 6.3.
   - Thư mục có từ trước mà chưa có `start.cmd`, clone nhánh `main` (thiếu `-b handoff/2026-10-16`) hoặc bản tải ZIP: làm theo [ONBOARDING](ONBOARDING.md) mục 3.1, đoạn "Thư mục đã clone hoặc tải về từ trước"; dữ liệu cũ được giữ.
   - Dòng **CẢNH BÁO** là phần không bắt buộc chưa dùng được (ví dụ OCR trong trình duyệt dùng Tesseract thay cho PaddleOCR, hay chế độ "Giữ bố cục PDF" khi dịch vụ PDF dừng): app vẫn chạy. Dòng **LỖI** ghi rõ thiếu gì và cách sửa ([ONBOARDING](ONBOARDING.md) mục 6.3). Hoa Trí đang mở ở một cửa sổ khác thì `start.cmd` báo rồi dừng: dùng cửa sổ đó, hoặc muốn cập nhật thì tắt cửa sổ đó (Ctrl+C) rồi bấm đúp `start.cmd` lại.
3. Trong trình duyệt: "Tạo tài khoản" (đánh dấu ô đồng ý điều khoản) → "Xưởng dịch" → nhập "Tên nội dung", dán khóa Gemini API của bạn vào ô "Khóa Gemini" (tạo ở https://aistudio.google.com/apikey), "Chọn tệp" (PDF) → "Bắt đầu dịch". Trang quản trị `http://127.0.0.1:8787/admin`: lần đầu tạo tài khoản quản trị bằng giá trị dòng `ADMIN_TOKEN` trong `.dev.vars`, các lần sau đăng nhập bằng tên đăng nhập và mật khẩu đó.

Giữ cửa sổ `start.cmd` mở trong lúc dùng; đóng cửa sổ hoặc bấm Ctrl+C để tắt.

Chạy bằng lệnh (cả macOS/Linux): `npm ci`, `npm run setup`, rồi `npm start`. Sau mỗi lần `git pull`, chạy lại `npm run setup` trước `npm start`: `npm start` và `npm run dev` không áp migration.

## Deploy

- Dịch vụ PDF (Docker + Caddy) và Worker (`npm run deploy:check`, `npm run deploy`): [deploy/pdf-layout/README.md](deploy/pdf-layout/README.md). Chưa deploy thật lần nào.
- Trước khi công khai: điền 4 loại chỗ trống `[[CHƯA ĐIỀN: …]]` trong `frontend/dieu-khoan.html`, `frontend/quyen-rieng-tu.html` và `frontend/.well-known/security.txt` (ONBOARDING mục 5.1; deploy từ chối khi còn chỗ trống, trừ bản thử kín với `--allow-placeholders`), và chạy `npm run prepare:dict` trên máy deploy: thiếu dữ liệu "Tra chữ Hán" thì deploy dừng (trừ khi thêm `--allow-no-dictionary`).
- Gắn tên miền riêng cho Worker trước khi chia sẻ link đầu tiên: thẻ xem trước và `sitemap.xml` lấy đúng địa chỉ mà link dùng, nên link `*.workers.dev` sẽ hiện tên đó (ONBOARDING mục 5.3).
- Khi cập nhật, deploy Worker trước hoặc cùng lúc với dịch vụ PDF, không bao giờ để dịch vụ PDF mới chạy với Worker cũ (ONBOARDING mục 5.2). `https://<tên miền>/api/health?deep=1` báo `"status":"mismatch"` khi hai bên chạy hai commit khác bộ kiểm tra bố cục, và từ bản 27/10/2026 "Xuất PDF tiếng Việt" khi đó bị từ chối (503 `pdf_service_outdated`, "Dịch vụ PDF chưa được cập nhật cùng phiên bản với trang web…"; không lưu PDF, không tính lượt xuất trong ngày). Image cũ mà cùng bộ kiểm tra (như khi lên bản 23/10/2026) chỉ bị `npm run deploy` cảnh báo, nên vẫn build lại image mỗi khi `services/pdf-layout/` đổi (ONBOARDING mục 5.7). Bản 27/10/2026 đổi bộ kiểm tra bố cục (`frontend/math-text.js`, `frontend/pdf-box-layout.js`) cùng `extract.py` và `server.mjs`: build lại image ngay sau khi deploy Worker; tới lúc đó `/api/health?deep=1` báo `mismatch` và "Xuất PDF tiếng Việt" bị từ chối như trên.
- Lên bản 27/10/2026: `npm run deploy` áp 2 migration mới (`0025`, `0026`); ngay sau deploy, mở `/admin` và tạo tài khoản quản trị đầu tiên bằng `ADMIN_TOKEN` (script deploy cảnh báo tới khi có), rồi thêm tài khoản cho từng quản trị viên. Ai từng để trình duyệt lưu `ADMIN_TOKEN` thì xóa mục đã lưu đó (ONBOARDING mục 3.3). Khi mọi quản trị viên đã có tài khoản riêng, đổi `ADMIN_TOKEN` (`npx wrangler secret put ADMIN_TOKEN`), vì mã cũ ai cũng từng gõ mà vẫn có toàn quyền; đổi xong thì nhập lại khóa Gemini ở "Cài đặt" nếu khóa lưu ở đó (ONBOARDING mục 5.7).
- Trước khi công khai: xóa sách PDF scan còn trong lịch sử repo (ONBOARDING mục 5.1), push commit sắp deploy lên nhánh mà link "Mã nguồn" trỏ tới (`SOURCE_URL` trong `frontend/site-footer.js`; deploy dừng khi commit chưa có trên nhánh đó), bảo vệ máy chủ PDF, đặt giám sát và sao lưu D1, R2 (runbook mục A.1, A.8, B.5). Lỗi gặp trong trình duyệt của người dùng được gửi về nhật ký của Worker (ONBOARDING mục 5.9).
- Trang có Content-Security-Policy trong `frontend/_headers`; cách nới cho một tính năng mới: ONBOARDING mục 9.

Hướng dẫn đầy đủ (cài đặt, cách dùng, deploy, xử lý sự cố, giới hạn đã biết): [ONBOARDING.md](ONBOARDING.md). Làm "Ví dụ mẫu" cho thư viện công khai: [tools/samples/README.md](tools/samples/README.md).

Repo này công khai: không commit `.dev.vars` (khóa và mã bí mật), không commit thư mục `samples/` (PDF sách).
