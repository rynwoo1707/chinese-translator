# Hoa Trí: hướng dẫn bàn giao

> Cập nhật 16/10/2026, nhánh `handoff/2026-10-16`. Dành cho người có kỹ thuật nhận chạy app trên máy để dịch sách và deploy lên Cloudflare (không phải người viết code ban đầu). Mọi lệnh chạy ở **thư mục gốc repo**. Chỗ ghi **(chưa kiểm chứng)** là chưa được chạy thử thật.

**Chạy nhanh trên Windows** (cần Git, Node.js 22.13+ và Python 3.10+; chi tiết ở mục 2–3):

```powershell
git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git
cd chinese-translator
npm.cmd ci
npm.cmd run setup             # 1 lần: mô hình OCR, thư viện, PyMuPDF, dữ liệu OCR, .dev.vars, D1 local
npm.cmd run dev:pdf-layout    # cửa sổ PowerShell 1: dịch vụ PDF giữ bố cục (để chạy)
npm.cmd run dev               # cửa sổ PowerShell 2: web, mặc định http://127.0.0.1:8787
```

Rồi mở `http://127.0.0.1:8787/#account` → "Tạo tài khoản" → mở `http://127.0.0.1:8787/study.html` → nhập "Tên nội dung" (bắt buộc) → dán khóa Gemini API của bạn (tạo miễn phí ở https://aistudio.google.com/apikey) → chọn PDF, chọn 1–3 trang → "Bắt đầu dịch →". Trên Windows, clone vào thư mục có đường dẫn ngắn (ví dụ `C:\src`), xem mục 3.1.

**5 điều không được quên khi deploy**

1. Production phải chạy **migration D1 lên remote**: `npx wrangler d1 migrations apply DB --remote`. Thiếu bước này thì lịch sử dịch, sách và bìa đều lỗi.
2. Chạy `npm run build` **trước** `npx wrangler deploy`. Không build thì site thiếu `/vendor/` (OCR, pdf.js, "Tải cả quyển" hỏng).
3. Dịch vụ PDF trên production phải có **HTTPS công khai** (chứng chỉ hợp lệ, cổng 443) và không nên đi qua proxy của Cloudflare (bản ghi DNS bật đám mây màu cam, trạng thái "Proxied"; dưới đây gọi tắt là "proxy cam") hay Cloudflare Tunnel (bị cắt ở 100 s).
4. Không commit, không gửi `.dev.vars`. Repo GitHub đang **công khai**.
5. `wrangler.jsonc` đang để `"database_id": "local-db"` (chỉ dùng cho local): tạo D1 thật và thay ID trước khi deploy (mục 5.2).

## 1. Dự án là gì

Hoa Trí là web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini, chạy trên Cloudflare Workers (`backend/worker.js`, giao diện tĩnh `frontend/`, cơ sở dữ liệu D1, kho tệp R2). Người học đăng nhập, mở "Xưởng dịch học tập" (`/study.html`), dán khóa Gemini của mình và chọn PDF; app tách trang thành từng block (có OCR cho trang scan), dịch, rồi xuất PDF tiếng Việt giữ bố cục gốc và lưu theo sách trong "Thư viện riêng". Việc tách trang và dựng PDF do một dịch vụ riêng đảm nhận (`services/pdf-layout`: Node + Python/PyMuPDF + Tesseract tích hợp + Chromium), vì Worker không chạy được Python hay Chromium. Khu quản trị `/admin` dùng khóa Gemini máy chủ để dịch, đối chiếu và xuất bản sách lên thư viện công khai.

| Tên | Là gì |
|---|---|
| `rynwoo1707/chinese-translator` | repo GitHub (công khai) |
| `muc-viet-cms` | tên Worker trong `wrangler.jsonc`; URL `https://muc-viet-cms.<subdomain>.workers.dev` |
| `muc-viet` (binding `DB`) | cơ sở dữ liệu D1; 13 migration trong `database/migrations/` |
| `muc-viet-files` (binding `FILES`) | bucket R2 |
| `services/pdf-layout/` | dịch vụ PDF, cổng mặc định 8091 |

## 2. Chuẩn bị

| Phần mềm | Phiên bản | Ghi chú |
|---|---|---|
| Git | bản hiện hành | |
| Node.js (dùng npm đi kèm) | **22.13 trở lên** (22 LTS) hoặc 24.x | Wrangler 4.131.1 từ chối Node dưới 22; pdfjs-dist cần 22.13; 3 tệp test dùng `node:sqlite` sẽ FAIL trên Node cũ hơn. Máy gốc: Node 24.14.0, npm 11.9.0 |
| Python | CPython **3.10 trở lên**, 64-bit | chỉ dịch vụ PDF dùng. Máy gốc chạy 3.14.3 |
| PyMuPDF | 1.26.7 | `npm run setup` cài vào `.runtime/pdf-python`, không cài toàn cục |
| Trình duyệt họ Chromium | Microsoft Edge (Windows) hoặc Chromium/Chrome | dịch vụ PDF dùng để xuất PDF; test giao diện cần Edge |
| Font cho PDF xuất | Windows: `C:/Windows/Fonts/times.ttf` (có sẵn). Linux: DejaVu Serif (`fonts-dejavu-core`). macOS: phải chỉ đường dẫn | biến `PDF_FONT_PATH` |
| Tesseract | **không cần cài** | dùng Tesseract có sẵn trong MuPDF; dữ liệu `chi_sim`/`eng` do `npm run setup` tạo |
| Docker | tùy chọn | chạy dịch vụ PDF dạng container; image **chưa được build thử** |

- Mọi gói npm (wrangler, esbuild, puppeteer-core, pdfjs-dist, tesseract.js, PaddleOCR…) đã ghim trong `package-lock.json` và cài bằng `npm ci`; không cần cài gì toàn cục. Luôn gọi `npx wrangler`: wrangler cài toàn cục bản cũ có thể không nhận `compatibility_date` 2026-09-01.
- Cần Internet khi cài: `npm ci`, `pip`, và `npm run prepare:ocr` (tải khoảng 21,5 MB mô hình PaddleOCR từ `paddle-model-ecology.bj.bcebos.com`).
- Tài khoản: mỗi người dịch một **khóa Gemini API riêng** (Google AI Studio). Deploy cần tài khoản Cloudflare có Workers, D1, R2 (nên dùng Workers Paid) và một máy chủ có tên miền + HTTPS cho dịch vụ PDF. Tùy chọn: OAuth client của Google Cloud (đăng nhập Google), khóa Gemini máy chủ (xưởng dịch `/admin`).

## 3. Chạy trên máy

### 3.1 Windows 11 (PowerShell)

Dùng `npm.cmd`/`npx.cmd` để khỏi gặp lỗi "running scripts is disabled". Nếu PowerShell cho chạy script thì gõ `npm`/`npx` cũng được.

**Bước 1: lấy code và cài gói**

```powershell
git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git
cd chinese-translator
npm.cmd ci                    # cài đúng phiên bản trong lockfile, không tải trình duyệt
```

- Clone vào thư mục có đường dẫn ngắn (ví dụ `C:\src\chinese-translator`), không dùng ổ `subst` hay ổ mạng: Windows giới hạn đường dẫn ở 260 ký tự, còn D1 local tạo tệp sâu thêm tới 136 ký tự trong `.wrangler`. Nếu đường dẫn thư mục dự án dài hơn 123 ký tự, `setup` báo **LỖI** và bỏ qua bước 7.
- `npm ci` có thể in "N vulnerabilities (… high)": đó là cảnh báo của `npm audit`. Đừng chạy `npm audit fix` hay `npm audit fix --force`, vì lệnh đó sửa `package-lock.json` và đổi các phiên bản mà hướng dẫn này đã kiểm.

**Bước 2: cài đặt một lần**

```powershell
npm.cmd run setup
```

`setup` chạy lại bao nhiêu lần cũng được: bước nào đã xong thì bỏ qua. Trong `.dev.vars` nó chỉ thêm giá trị còn thiếu: giữ nguyên khóa Gemini, `ADMIN_TOKEN` (trừ khi còn là giá trị mẫu), `PDF_LAYOUT_SERVICE_TOKEN` (nếu đủ 24 ký tự) và các đường dẫn `PDF_PYTHON`, `CHROMIUM_EXECUTABLE_PATH`, `PDF_FONT_PATH` còn dùng được. Một bước lỗi không chặn các bước sau không phụ thuộc vào nó; cuối cùng `setup` in các dòng **LỖI**/**CẢNH BÁO**, và nếu còn LỖI thì kết thúc với mã 1 (npm in thêm `npm error code 1`). Nó làm lần lượt:

| # | Việc | Kết quả (đều nằm trong `.gitignore`) |
|---|---|---|
| 1 | tải mô hình PaddleOCR, khoảng 21 MB, có kiểm checksum (= `npm run prepare:ocr`) | `frontend/vendor/paddle/models/` |
| 2 | chép pdf.js, pdf-lib, tesseract, onnx, tessdata `.gz` (= `npm run prepare:vendor`) | `frontend/vendor/` |
| 3 | tìm Python 3.10+ (`python`, `python3`, `py -3`; bỏ qua lối tắt Microsoft Store), cài PyMuPDF 1.26.7 và ghi đường dẫn đầy đủ của Python đó vào `PDF_PYTHON` | `.runtime/pdf-python`, `.dev.vars` |
| 4 | dữ liệu OCR `chi_sim` + `eng` cho dịch vụ PDF (= `npm run prepare:pdf-ocr`) | `.runtime/tessdata` |
| 5 | tìm Edge/Chrome/Chromium và phông Times New Roman/DejaVu Serif để xuất PDF | ghi đường dẫn vào `.dev.vars` nếu máy cần |
| 6 | tạo `.dev.vars` từ `.dev.vars.example`, sinh `ADMIN_TOKEN` và `PDF_LAYOUT_SERVICE_TOKEN` ngẫu nhiên (không in ra) | `.dev.vars` |
| 7 | áp 13 migration vào D1 local (= `npm run db:local`) | `.wrangler/state` |

- Cần Internet (`npm ci`, `pip`, mô hình từ `paddle-model-ecology.bj.bcebos.com`). Nếu chỉ riêng bcebos.com bị chặn: chép 3 tệp `det.tar`, `rec.tar`, `manifest.json` từ máy khác vào `frontend/vendor/paddle/models/` rồi chạy lại `setup` (bước 1 sẽ bỏ qua). Thiếu mô hình thì bước 2 và 4 cũng bị bỏ qua.
- Báo **LỖI** không tìm thấy Python: cài Python 3 từ python.org (tích "Add python.exe to PATH"), mở cửa sổ PowerShell mới rồi chạy lại `npm.cmd run setup`. Khi thiếu Python, `dev:pdf-layout` vẫn khởi động (kèm CẢNH BÁO "không chạy được PyMuPDF…") và `/study.html` vẫn báo "Dịch theo từng block…", nhưng "Bắt đầu dịch →" với PDF giữ bố cục sẽ báo "Không tìm thấy Python để chạy dịch vụ PDF (python)…". Muốn dịch tạm khi chưa có Python: bỏ tích "Giữ bố cục PDF và xuất bản tiếng Việt" (PDF xử lý trong trình duyệt, chỉ ra văn bản/HTML).
- **CẢNH BÁO** không tìm thấy trình duyệt hoặc phông: dịch vụ PDF chạy được nhưng không xuất được PDF. Cài Microsoft Edge (Windows có sẵn) rồi chạy lại `setup`.
- `.dev.vars` không được commit. Mã vào trang `/admin` là giá trị dòng `ADMIN_TOKEN`. `GEMINI_API_KEY` để trống được: chỉ xưởng dịch `/admin` cần, người học dán khóa riêng trên trang. Mỗi dòng dạng `KEY=value` (không `export`, không chú thích cuối dòng); khóa lặp lại thì dòng **cuối** thắng. Ý nghĩa từng biến: mục 5.6.

**Bước 3 (cửa sổ PowerShell thứ nhất): dịch vụ PDF**

```powershell
npm.cmd run dev:pdf-layout
```

In "PDF layout service ready (PyMuPDF + Puppeteer)." rồi nghe ở cổng trong `PDF_LAYOUT_SERVICE_URL` (mặc định `127.0.0.1:8091`). Dòng `Restarting 'services/pdf-layout/local.mjs'` ngay lúc khởi động là bình thường. Để cửa sổ này chạy. Dịch vụ tự khởi động lại khi tệp .mjs/.js thay đổi; `extract.py` được chạy mới cho mỗi yêu cầu. Nếu `.dev.vars` chưa có token (ví dụ bạn tự tạo tệp), lệnh này tự ghi thêm `PDF_LAYOUT_SERVICE_TOKEN`; khi đó phải khởi động lại `npm run dev`.

**Bước 4 (cửa sổ PowerShell thứ hai): web (Worker)**

```powershell
npm.cmd run dev                   # prepare:vendor + wrangler dev (đọc .dev.vars)
npm.cmd run dev -- --port 8789    # nếu muốn ghim cổng
```

Mặc định là `http://127.0.0.1:8787`; nếu cổng bận, Wrangler tự lấy cổng kế tiếp và in URL ra, hãy dùng URL đó. Sửa `.dev.vars` thì phải khởi động lại lệnh này.

**Bước 5: địa chỉ**

| URL | Trang |
|---|---|
| `http://127.0.0.1:8787/` | thư viện công khai |
| `http://127.0.0.1:8787/#account` | đăng ký, đăng nhập, "Thư viện riêng" |
| `http://127.0.0.1:8787/study.html` | "Xưởng dịch học tập" (cần đăng nhập) |
| `http://127.0.0.1:8787/admin` | khu quản trị |

**Bước 6: kiểm tra nhanh, không tốn token**

Nếu đã đổi cổng dịch vụ PDF (`PDF_LAYOUT_SERVICE_URL`) hoặc cổng web, thay `8091`/`8787` dưới đây bằng cổng của bạn.

```powershell
curl.exe -s http://127.0.0.1:8091/health     # mong đợi {"error":"Unauthorized"}
$t = (Select-String -Path .dev.vars -Pattern '^PDF_LAYOUT_SERVICE_TOKEN=.' | Select-Object -Last 1).Line -replace '^PDF_LAYOUT_SERVICE_TOKEN=', ''
curl.exe -s -H "Authorization: Bearer $t" http://127.0.0.1:8091/health   # {"ok":true,"engine":"pymupdf-puppeteer","busy":false}
node backend/check-gemini-runtime.mjs        # chỉ gọi /api/status bằng ADMIN_TOKEN; cổng khác thì thêm http://127.0.0.1:8789
```

Đăng nhập rồi mở `/study.html`: dòng trạng thái PDF phải là "Dịch theo từng block; giữ hình gốc, công thức và vị trí." Nếu không, xem mục 6. Dòng này chỉ xác nhận Worker có cấu hình và đọc được phông qua dịch vụ; Python/PyMuPDF chỉ chạy khi tách trang, Chromium khi xuất PDF.

### 3.2 macOS / Linux (chưa chạy thử)

- Các bước giống Windows, dùng `npm`/`npx` (bỏ `.cmd`). URL thường là `http://localhost:8787`.
- `npm run setup` tìm `python3` khi không có `python`, tìm Chrome/Edge/Chromium (kể cả trong `/Applications`) và phông (Times New Roman trên macOS; DejaVu Serif hoặc Liberation Serif trên Linux), rồi ghi đường dẫn Python vào `PDF_PYTHON`, và `CHROMIUM_EXECUTABLE_PATH`, `PDF_FONT_PATH` khi máy cần, vào `.dev.vars`. `npm run dev:pdf-layout` đọc ba biến này từ `.dev.vars`; biến cùng tên đặt trong shell được ưu tiên.
- Linux: cài trước `python3-pip` (nếu `setup` báo thiếu pip), `chromium` và `fonts-dejavu-core`. Cài PyMuPDF kiểu `--target` như `setup` làm không bị chặn bởi PEP 668.
- Kiểm tra token: `t=$(grep '^PDF_LAYOUT_SERVICE_TOKEN=.' .dev.vars | tail -n 1 | cut -d= -f2- | tr -d '\r'); curl -s -H "Authorization: Bearer $t" http://127.0.0.1:8091/health`
- Thay cho `dev:pdf-layout`, có thể chạy dịch vụ bằng Docker (image chưa build thử):

```bash
docker build -f services/pdf-layout/Dockerfile -t hoa-tri-pdf .
docker run --rm -p 127.0.0.1:8091:8091 -e PDF_LAYOUT_SERVICE_TOKEN="<giá trị PDF_LAYOUT_SERVICE_TOKEN trong .dev.vars>" hoa-tri-pdf
```

Dùng đúng token đang có trong `.dev.vars` (và `PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:8091`). Đừng chạy thêm `dev:pdf-layout` (trùng cổng).

### 3.3 Đăng nhập khi chạy local

- **Người học:** `/#account` → "Tạo tài khoản" (Tên hiển thị, Email, Mật khẩu 8–128 ký tự) hoặc "Đăng nhập". Máy mới chưa có tài khoản nào; tài khoản nằm trong D1 local ở `.wrangler/`.
- **Quản trị:** `/admin` → nhập giá trị `ADMIN_TOKEN` vào "Mã quản trị". Mã chỉ được giữ trong bộ nhớ tab, tải lại trang phải nhập lại. Không có tài khoản admin riêng.
- **Khóa Gemini máy chủ (tùy chọn, chỉ cho xưởng dịch admin):** `/admin` → "Cài đặt" → "Khóa API mới" → "Lưu và sử dụng"; "Dùng lại khóa máy chủ" để xóa. Bản lưu nằm trong R2, nên local và production phải nhập riêng.
- **Google (tùy chọn):** tạo OAuth client loại *Web application* trong Google Cloud Console, thêm redirect URI **khớp từng ký tự** với origin đang mở, ví dụ `http://127.0.0.1:8787/api/auth/google/callback` (`localhost` khác `127.0.0.1`, cổng cũng phải khớp). Đặt cả `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` trong `.dev.vars`, rồi khởi động lại `npm run dev`. Thiếu một trong hai thì nút hiện "Đăng nhập Google sẽ xuất hiện khi được cấu hình."

## 4. Dùng app để dịch

Trong `/study.html` (phải đăng nhập):

1. **"Tên nội dung"** (bắt buộc): dùng cho lịch sử, "Thư viện riêng" và tên tệp tải về. "Lưu tên" đổi tên mà không gọi Gemini.
2. **"Chọn tài liệu từ thiết bị"** → chọn PDF. Ô "Giữ bố cục PDF và xuất bản tiếng Việt" chỉ được tích khi dịch vụ PDF sẵn sàng. Bật: tệp tối đa 25 MB, tải cả tệp lên. Tắt: tới 250 MB, xử lý trong trình duyệt, chỉ ra văn bản/HTML.
3. **"Trang PDF cần dịch"**: mặc định `1-3`, cú pháp `12-14, 37`, tối đa **20 trang mỗi lượt** (không tính bìa). Scan nặng có thể bị cắt bớt; thông báo "Lượt này xử lý 12/20 trang đã chọn… Hãy dịch tiếp trang 13-20 ở lượt sau." là bình thường.
4. **Bìa** được nhận tự động (trang 1, hoặc trang 2 nếu trang 1 trắng). Mặc định bìa không được dịch mà giữ ảnh gốc làm ảnh bìa sách. Nút: "Đổi"/"Chọn trang bìa", "Không dùng bìa", "Dịch chữ trên bìa".
5. **"Thêm vào sách"**: "Sách mới" hoặc một sách đã có. App gợi ý "Dịch tiếp trang X–Y"; nếu phạm vi trùng đúng một phần cũ, app đề nghị "Thay phần “…” bằng bản dịch này thay vì thêm trang trùng".
6. **Mục 02**: dán "Khóa Gemini API riêng" (chỉ giữ trong tab, tải lại trang là mất). Chọn "Lĩnh vực tài liệu" (Chuyên khảo · Nghiên cứu / Toán học · STEM / Lịch sử Trung Hoa) và "Chế độ dịch" (Tiết kiệm token / Cân bằng / Đối chiếu kỹ). Tùy chọn: "Kiểm tra model của khóa", "Thuật ngữ cần thống nhất". Bấm **"Bắt đầu dịch →"**.
7. Dịch xong mọi block, app tự "Xuất PDF tiếng Việt" và gắn PDF vào phần tương ứng của sách trong "Thư viện riêng"; trình xem hai khung hiện bản gốc và bản dịch. Muốn dừng: "Dừng sau lượt hiện tại"; mở lại từ "Lịch sử dịch của tôi" để dịch tiếp.
8. Sửa chữ: "Chỉnh bản dịch từng đoạn" → lưu → "Xuất PDF tiếng Việt" (không gọi Gemini).

**Sách và tải cả quyển**

- "Gộp vào sách…" (trên thẻ lịch sử đã xong) chuyển phần đó sang sách khác; "Sắp xếp phần" đổi thứ tự. Sách một phần bị gộp đi sẽ bị xóa; bìa của nó chuyển sang nếu sách đích chưa có bìa.
- "Tải cả quyển (PDF)": `/#account` → mở sách → mở một phần PDF. Trình duyệt ghép mọi trang gốc, thay trang đã dịch vào đúng chỗ, giữ bìa và trang chưa dịch. Phần cũ có thể hỏi "Chọn PDF gốc…": tệp chỉ dùng trên máy, không tải lên. "Chỉ ghép các phần đã dịch" cho bản gọn.

**Mẹo tiết kiệm token**

- Nếu trang báo "Thư viện đã có bản dịch được giáo viên duyệt…" (cùng tệp, so bằng SHA-256), bấm "Mở bản đã duyệt" thay vì dịch.
- Thử 1–3 trang trước; để mặc định bỏ qua bìa.
- Dùng "Tiết kiệm token" cho bản nháp. Ở chế độ giữ bố cục PDF, cả ba "Chế độ dịch" đều gọi Gemini với thinking 'minimal'; chế độ chỉ đổi model khi `GEMINI_PDF_BLOCK_MODEL` để trống và có đặt `GEMINI_ECONOMY_MODEL`/`GEMINI_BALANCED_MODEL`/`GEMINI_QUALITY_MODEL` (với `.dev.vars` mặc định, cả ba dùng `GEMINI_MODEL`). "Đối chiếu kỹ" dùng thinking 'low' (hai chế độ kia 'minimal') chỉ khi dịch văn bản (dán chữ, TXT/DOCX/EPUB/AZW3 hoặc PDF xử lý trong trình duyệt), nên dự kiến tốn hơn (chưa đo).
- **Đừng dịch lại chỉ để sửa dàn trang.** Mở mục trong "Lịch sử dịch của tôi", bấm "Xuất PDF tiếng Việt": app dựng lại từ dữ liệu đã lưu, không tốn token. Bản xuất cũ sẽ hiện "PDF đã xuất dùng cách dàn trang cũ…". Cách này sửa phân số ½, dấu câu lặp, chữ bị cắt hoặc co quá nhỏ; nó **không** sửa lỗi nằm trong bản tách trang cũ (mất chữ hay công thức, đoạn chữ Hán chưa dịch). Lỗi loại đó phải dịch lại (tốn token): chọn cùng PDF và cùng trang, tích "Thay phần …".
- Có thể dừng rồi tiếp tục mà không mất phần đã dịch. Theo dõi bộ đếm "token Gemini trong tab này".
- Khi tắt giữ bố cục, OCR chạy trong trình duyệt (PaddleOCR/Tesseract); chỉ trang có độ tin cậy thấp mới gửi lên Gemini.
- Gemini thỉnh thoảng lặp chữ vô hạn. Đầu ra OCR đã bị giới hạn độ dài, nhưng lượt lỗi vẫn tốn token và phải chạy lại.

**Dữ liệu nằm ở đâu:** D1 (`study_sessions` là lịch sử, `stories` là sách, `chapters` là các phần); R2 `muc-viet-files` (`study/<userId>/…` chứa trạng thái, manifest, PDF gốc và PDF đã dịch; `covers/…`; `private/config/gemini-api-key.json`). Khi chạy local, tất cả nằm trong `.wrangler/state/v3`; xóa thư mục này là mất dữ liệu local.

**Quản trị (khóa máy chủ):** `/admin` → "Xưởng dịch" (tải lên, chạy) → "Đối chiếu bản dịch" → xuất bản lên thư viện công khai.

## 5. Deploy lên Cloudflare

> **(chưa kiểm chứng)** Chưa ai deploy thật lần nào (`database_id` vẫn là `local-db`). Lệnh và cờ dưới đây đã được đối chiếu với `npx wrangler <lệnh> --help` (wrangler 4.131.1), và `npx wrangler deploy --dry-run` chạy được; phần chạy trên Cloudflare thật (D1, R2, secret, workers.dev) và dịch vụ PDF sau HTTPS chưa được thử.

```
Trình duyệt ──HTTPS──> Worker muc-viet-cms  (D1 muc-viet, R2 muc-viet-files, tệp tĩnh frontend/)
                           │  HTTPS + Authorization: Bearer <PDF_LAYOUT_SERVICE_TOKEN>, chờ tối đa 280 s
                           ▼
                 Dịch vụ PDF (Docker trên máy chủ riêng, sau reverse proxy TLS cổng 443)
```

Trình duyệt không bao giờ gọi thẳng dịch vụ PDF và không thấy token. Windows dùng `npx.cmd`, macOS/Linux dùng `npx`.

### 5.1 Checklist trước deploy

- [ ] Clone sạch từ GitHub, không chép thư mục từ máy cũ.
- [ ] `npm ci`, `npm run prepare:ocr` và `npm test` chạy được trên máy dùng để deploy.
- [ ] Tài khoản Cloudflare đã **bật R2** trong dashboard (chưa bật thì không tạo được bucket) và có D1; nên dùng Workers Paid.
- [ ] Đã sinh 2 chuỗi ngẫu nhiên **mới**, khác bản local: `ADMIN_TOKEN` và `PDF_LAYOUT_SERVICE_TOKEN` (tối thiểu 24 ký tự, nên 64 hex). Sinh mỗi chuỗi bằng `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` (chạy 2 lần), cất trong trình quản lý mật khẩu, không ghi vào repo.
- [ ] Có máy chủ cho dịch vụ PDF: tên miền công khai, chứng chỉ hợp lệ, cổng 443, timeout proxy ≥ 300 s, giới hạn body ≥ 45 MB, không bật proxy cam hay Tunnel của Cloudflare.
- [ ] Chủ dự án đã quyết định về giấy phép AGPL của PyMuPDF khi mở dịch vụ ra mạng (mục 8).

### 5.2 Tạo D1 và R2

```powershell
npx.cmd wrangler login
npx.cmd wrangler whoami
npx.cmd wrangler d1 create muc-viet --binding DB --update-config    # có thể thêm --location apac
npx.cmd wrangler r2 bucket create muc-viet-files
```

- `d1 create` sửa `wrangler.jsonc`: `"database_id": "local-db"` thành UUID thật, giữ nguyên binding `DB` và `migrations_dir`. Nếu không dùng cờ thì trả lời: thêm vào config = y, binding = `DB`, "connect to the remote resource" = N; hoặc tự dán `database_id` vào `wrangler.jsonc`. ID này không bí mật, nên commit.
- Tác dụng phụ: dev local chuyển sang một DB local mới, rỗng. Chạy lại `npm run db:local`, hoặc thêm `"preview_database_id": "local-db"` vào khối D1 để giữ dữ liệu local cũ.
- `r2 bucket create`: nếu được hỏi có thêm cấu hình không thì từ chối (binding `FILES` đã có sẵn).

### 5.3 Migration D1 lên remote (bắt buộc)

```powershell
npx.cmd wrangler d1 migrations apply DB --remote    # trả lời y
npx.cmd wrangler d1 migrations list DB --remote     # không còn migration nào chờ
```

Remote chưa có migration nào; repo có 13 tệp `0001`–`0013`. Thiếu `0011`–`0013` thì lịch sử dịch, sách và bìa báo lỗi `no such table` / `no such column`. Migration `0013` đến nay mới chỉ được áp vào D1 local của máy cũ.

### 5.4 Dịch vụ PDF (deploy trước Worker)

Trên máy chủ có Docker, build từ thư mục gốc của một **clone sạch**. `.dockerignore` loại `.dev.vars`, `.wrangler`, `node_modules`, `tmp`, `.runtime` khỏi build context; image chỉ chép `package.json`, `package-lock.json`, `services/pdf-layout/` và hai tệp `frontend/pdf-box-layout.js`, `frontend/math-text.js` (đừng thêm `frontend/` vào `.dockerignore`).

```bash
docker build -f services/pdf-layout/Dockerfile -t hoa-tri-pdf .
docker run -d --name hoa-tri-pdf --restart unless-stopped -p 127.0.0.1:8091:8091 \
  -e PDF_LAYOUT_SERVICE_TOKEN="<64-hex>" hoa-tri-pdf
```

Image dựa trên `node:22-bookworm-slim`, cài thêm python3, chromium, fonts-dejavu-core, fonts-noto-cjk, tesseract-ocr (chi-sim, eng), và đặt sẵn `PDF_PYTHON`, `CHROMIUM_EXECUTABLE_PATH`, `PDF_LAYOUT_HOST=0.0.0.0`, `PDF_CHROMIUM_NO_SANDBOX=1`, `TESSDATA_PREFIX`. Có thể thêm `-e PORT`, `-e PDF_FONT_PATH`. **Image chưa được build thử.**

Đặt dịch vụ sau reverse proxy có TLS (nginx hoặc Caddy). Mẫu nginx (chưa kiểm chứng; phần chứng chỉ tùy máy chủ):

```nginx
server {
    listen 443 ssl;
    server_name pdf.example.com;
    # ssl_certificate / ssl_certificate_key: chứng chỉ hợp lệ, ví dụ Let's Encrypt
    client_max_body_size 45m;
    location / {
        proxy_pass http://127.0.0.1:8091;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Nếu dùng Caddy, tự kiểm tra timeout ≥ 300 s và giới hạn body ≥ 45 MB.

Quy tắc bắt buộc:

- URL phải là `https://` (ngoại lệ duy nhất: host `127.0.0.1`, `localhost`, `pdf-layout`). Sai quy tắc thì mọi thao tác PDF báo "Dịch vụ PDF cần HTTPS."
- Worker không gọi được `localhost` hay IP mạng LAN; chứng chỉ tự ký bị từ chối.
- Dịch vụ chỉ nhận đúng `/health`, `/font`, `/extract`, `/render`. `PDF_LAYOUT_SERVICE_URL` là **gốc** dịch vụ (ví dụ `https://pdf.example.com`); proxy không được thêm tiền tố đường dẫn.
- Không dùng hostname proxy cam hay Cloudflare Tunnel, trừ khi chỉ dịch ít trang mỗi lượt: Cloudflare cắt ở 100 s (lỗi 524), trong khi một lượt có thể cần 240–280 s.

| Giới hạn | Giá trị |
|---|---|
| Việc đồng thời | 2 mỗi tiến trình; việc thứ ba nhận 503 "Dịch vụ PDF đang bận…". Trên nền tảng tự co giãn, đặt concurrency 2 mỗi instance |
| Dữ liệu vào | PDF thô 25 MiB, JSON 40 MiB |
| Phản hồi `/extract` | tới khoảng 32 MiB base64, nên proxy/nền tảng phải cho khoảng 45 MB cả hai chiều. Kiểm tra giới hạn nền tảng (ví dụ Cloud Run giới hạn yêu cầu HTTP/1 ở 32 MiB) |
| Thời gian | server 300 s; Python 240 s (đầu ra ≤ 100 MiB); Worker chờ 280 s |
| Tài nguyên | ước tính khởi điểm 2 vCPU, 4 GB RAM (chưa đo). Trên máy dev Windows: 2–3 trang scan mất 14,8–21,4 s; chọn 20 trang mất 58–60 s và xử lý được 10–12 trang |
| Health check | `/health` cũng cần Bearer token; nếu nền tảng không gửi được header thì dùng probe TCP |

Kiểm tra từ bên ngoài:

```bash
curl -s https://pdf.example.com/health                                     # {"error":"Unauthorized"}
curl -s -H "Authorization: Bearer <token>" https://pdf.example.com/health  # {"ok":true,"engine":"pymupdf-puppeteer","busy":false}
```

### 5.5 Build và deploy Worker

```powershell
npm.cmd ci
npm.cmd run prepare:ocr     # nếu chưa có mô hình
npm.cmd run build           # BẮT BUỘC: prebuild điền frontend/vendor/
npx.cmd wrangler deploy
```

- `wrangler deploy` lấy thẳng `backend/worker.js` và thư mục `frontend/` (không dùng `dist/`), và **không** chạy npm script nào. Bỏ bước build thì thiếu `/vendor/`: OCR, pdf.js và "Tải cả quyển" hỏng.
- Lần đầu có thể được hỏi đăng ký subdomain `workers.dev`. URL: `https://muc-viet-cms.<subdomain>.workers.dev`.
- Kích thước đo được: bundle 3,05 MB (0,65 MB gzip), 245 tệp tĩnh, tệp lớn nhất 16,7 MB (giới hạn 25 MiB mỗi tệp).

### 5.6 Secrets và biến môi trường

```powershell
npx.cmd wrangler secret put ADMIN_TOKEN
npx.cmd wrangler secret put PDF_LAYOUT_SERVICE_URL      # https://pdf.example.com
npx.cmd wrangler secret put PDF_LAYOUT_SERVICE_TOKEN    # giống hệt token của dịch vụ
npx.cmd wrangler secret put GEMINI_MODEL                # gemini-3.6-flash
npx.cmd wrangler secret list                            # chỉ hiện tên
```

Mỗi lần `secret put` deploy một phiên bản mới. Cách khác: `npx.cmd wrangler secret bulk <tệp KEY=VALUE nằm ngoài repo>`. **Không bao giờ** đẩy `.dev.vars` local lên: tệp đó chứa URL 127.0.0.1 và khóa cá nhân.

Biến của Worker (local đặt trong `.dev.vars`; production đặt bằng secret):

| Biến | Cần? | Ý nghĩa |
|---|---|---|
| `ADMIN_TOKEN` | **Có** | mã vào `/admin`, đồng thời là khóa mã hóa khóa Gemini lưu ở "Cài đặt" (đổi token thì phải nhập lại khóa đó). Không đặt thì không ai vào được admin |
| `PDF_LAYOUT_SERVICE_URL` | **Có** (giữ bố cục) | gốc dịch vụ PDF, `https://` |
| `PDF_LAYOUT_SERVICE_TOKEN` | **Có** (giữ bố cục) | Bearer gửi tới dịch vụ, ≥ 24 ký tự, giống hệt phía dịch vụ. Thiếu URL hoặc token thì chế độ giữ bố cục coi như chưa cấu hình |
| `GEMINI_MODEL` | Nên đặt | model chính. Không đặt thì code dùng mặc định họ 2.5 (admin: `gemini-2.5-flash`), có thể 404 với project Google mới |
| `GEMINI_API_KEY` | Không | khóa máy chủ, **chỉ** cho xưởng dịch admin và danh sách model của admin; có thể lưu ở "Cài đặt" thay cho biến này. Người học không dùng |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Không | đăng nhập Google chỉ bật khi có đủ cả hai |
| `GEMINI_PDF_BLOCK_MODEL` | Không | model dịch block PDF; để trống nếu gặp 404 |
| `GEMINI_QUALITY_MODEL` | Không | model của "Đối chiếu kỹ" và model sửa/thử lại (cả admin lẫn học tập) |
| `GEMINI_ECONOMY_MODEL`, `GEMINI_BALANCED_MODEL` | Không | đổi model cho "Tiết kiệm token" / "Cân bằng" |
| `GEMINI_THINKING` | Không | chỉ cho admin: `minimal`, `low`, `default`; để trống thì dịch dùng 'minimal', OCR dùng 'low' |

Không đặt `GEMINI_MODEL_RECOVERY`, `GEMINI_PREFERRED_MODEL` (code tự gắn cho từng yêu cầu). Biến không bí mật (tên model) có thể đặt bằng `secret put` hoặc thêm khối `"vars"` vào `wrangler.jsonc` (hiện chưa có).

Biến của dịch vụ PDF (đặt trong shell, container hoặc nền tảng). Khi chạy local bằng `npm run dev:pdf-layout`, token và cổng lấy từ `PDF_LAYOUT_SERVICE_TOKEN`/`PDF_LAYOUT_SERVICE_URL` trong `.dev.vars`, và `PDF_PYTHON`, `CHROMIUM_EXECUTABLE_PATH`, `PDF_FONT_PATH` cũng được đọc từ đó nếu shell không đặt:

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PDF_LAYOUT_SERVICE_TOKEN` | (bắt buộc) | dưới 24 ký tự thì dịch vụ không khởi động |
| `PORT` | `8091` | |
| `PDF_LAYOUT_HOST` | `127.0.0.1` | Docker: `0.0.0.0` |
| `PDF_PYTHON` | `python` | Docker: `/opt/pdf-venv/bin/python`; `npm run setup` ghi đường dẫn đầy đủ của Python đã cài PyMuPDF vào `.dev.vars` |
| `TESSDATA_PREFIX` | `.runtime/tessdata` nếu có | Docker: `/opt/tessdata` |
| `CHROMIUM_EXECUTABLE_PATH` | tự dò Edge, `/usr/bin/chromium`, `/usr/bin/chromium-browser` | Docker: `/usr/bin/chromium`; macOS bắt buộc |
| `PDF_FONT_PATH` | Windows: `times.ttf`; nơi khác: DejaVu Serif | macOS bắt buộc |
| `PDF_CHROMIUM_NO_SANDBOX` | (trống) | `1` thêm `--no-sandbox`; Docker đặt 1 |

### 5.7 Đăng nhập Google (tùy chọn)

1. Google Cloud Console: cấu hình màn hình đồng ý loại External, thêm test user hoặc publish.
2. Tạo OAuth client ID loại *Web application*. Authorized redirect URI: `https://<host Worker>/api/auth/google/callback`; thêm `http://127.0.0.1:8787/api/auth/google/callback` nếu dev local cần. Sau này gắn tên miền riêng thì đăng ký thêm callback của tên miền đó.
3. `npx.cmd wrangler secret put GOOGLE_CLIENT_ID` và `npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET`.

### 5.8 Checklist sau deploy

```powershell
$W = "https://muc-viet-cms.<subdomain>.workers.dev"
curl.exe -s "$W/api/me"           # {"authenticated":false,"googleConfigured":...}
curl.exe -s "$W/api/library"      # []  (bảng D1 hoạt động)
curl.exe -s -H "Authorization: Bearer <ADMIN_TOKEN>" "$W/api/status"   # "authenticated":true, model, pdfModel, aiConfigured
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/pdf.mjs"                 # 200 text/javascript; charset=utf-8
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/pdf-lib.esm.min.js"      # 200 text/javascript; charset=utf-8
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/paddle/models/det.tar"   # 200 application/x-tar
npx.cmd wrangler d1 migrations list DB --remote                            # không còn chờ
```

Thấy `text/html` nghĩa là tệp không có: site trả `index.html` với mã 200 cho mọi đường dẫn lạ. Khi đó chạy `npm run build` rồi `npx wrangler deploy` lại.

macOS/Linux: dùng `curl` thay `curl.exe`, `/dev/null` thay `NUL`, bỏ `` `n ``.

- [ ] Để `npx.cmd wrangler tail` chạy trong một cửa sổ riêng suốt lúc kiểm tra.
- [ ] Dịch vụ PDF: `/health` trả 401 khi không có token, `{"ok":true,…}` khi có (mục 5.4).
- [ ] `/#account`: tạo một tài khoản thử, đăng xuất rồi đăng nhập lại.
- [ ] `/study.html`: lịch sử tải được; dòng PDF là "Dịch theo từng block; giữ hình gốc, công thức và vị trí."
- [ ] `/admin`: đăng nhập, mở "Cài đặt"; lưu khóa Gemini máy chủ nếu cần (R2 production không có bản của local).
- [ ] (Tốn token) dịch thử 1–2 trang bằng khóa thử, chờ "PDF tiếng Việt đã được lưu vào Thư viện riêng…", rồi thử "Tải cả quyển (PDF)".

### 5.9 Khi cập nhật code về sau

Thứ tự đề xuất: `git pull` → `npm ci` → `npx wrangler d1 migrations list DB --remote` (có migration mới thì `apply --remote` trước) → `npm run build` → `npx wrangler deploy`. Nếu `services/pdf-layout/`, `package*.json`, `frontend/pdf-box-layout.js` hoặc `frontend/math-text.js` thay đổi, hãy build lại image và chạy lại container dịch vụ PDF (Dockerfile chép các tệp này vào image).

## 6. Xử lý sự cố

### 6.1 Dịch vụ PDF

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Chưa cấu hình dịch vụ PDF giữ bố cục." hoặc dòng trạng thái "Dịch vụ PDF giữ bố cục chưa được cấu hình." | Worker thiếu `PDF_LAYOUT_SERVICE_URL` và/hoặc `PDF_LAYOUT_SERVICE_TOKEN`. Ở local thường do `npm run dev` chạy trước khi `dev:pdf-layout` ghi token | Chạy `npm run dev:pdf-layout`, rồi khởi động lại `npm run dev`. Production: `secret put` cả hai |
| "Dịch vụ PDF giữ bố cục chưa sẵn sàng." | Worker gọi `/api/my/study/pdf-layout/config` hoặc `/font` lỗi: mở trang khi chưa đăng nhập, dịch vụ tắt, sai URL/cổng, token ở Worker khác token dịch vụ, vi phạm quy tắc HTTPS, thiếu tệp font | Đăng nhập ở `/#account` rồi tải lại `/study.html`; bật dịch vụ, kiểm `/health` có token; token phải giống hệt (sửa `.dev.vars` thì khởi động lại `npm run dev`); macOS đặt `PDF_FONT_PATH`; Linux cài `fonts-dejavu-core` |
| "Không kết nối được dịch vụ PDF giữ bố cục. Hãy kiểm tra dịch vụ (npm run dev:pdf-layout) rồi thử lại." | Lỗi mạng/TLS: dịch vụ không chạy, đang tự khởi động lại, sai cổng, chứng chỉ không hợp lệ | Bật dịch vụ; cổng trong `.dev.vars` phải khớp; production dùng chứng chỉ hợp lệ ở cổng 443 |
| "Dịch vụ PDF cần HTTPS." | URL `http://` với host khác `127.0.0.1`, `localhost`, `pdf-layout` | Dùng `https://` |
| "Unauthorized" | Token ở Worker và ở dịch vụ khác nhau | Đặt giống hệt; khởi động lại `wrangler dev` hoặc cập nhật secret |
| "Not found" | URL có thêm đường dẫn, hoặc trỏ sai host | Trỏ về gốc dịch vụ |
| "Dịch vụ PDF tạm thời không phản hồi đúng (mã N). Hãy thử lại sau." | Proxy trả nội dung không phải JSON: 502/504, 413 (body quá lớn), 524 (Cloudflare cắt sau 100 s) | Timeout proxy ≥ 300 s, body ≥ 45 MB, bỏ proxy cam; chọn ít trang hơn |
| "Dịch vụ PDF trả dữ liệu không hợp lệ." | Phản hồi 2xx không phải JSON, ví dụ trang đăng nhập của proxy | Sửa cấu hình proxy |
| "Máy chủ trả về phản hồi không đọc được (mã N)…" | Chính Worker trả HTML: `wrangler dev` đang nạp lại sau khi sửa code; trên production là crash hoặc vượt giới hạn tài nguyên (lỗi 1102) | Thử lại; production xem `npx wrangler tail`; nếu lặp lại với PDF lớn: Workers Paid và ít trang hơn |
| "Dịch vụ PDF đang bận. Hãy thử lại sau." | Đã có 2 việc đang chạy | Chờ, hoặc chạy thêm instance |
| "Dữ liệu PDF vượt giới hạn." / "PDF giữ bố cục tối đa 25 MB." | Tệp lớn hơn 25 MB | Tách PDF (một sách nhận nhiều tệp gốc), hoặc tắt giữ bố cục (tới 250 MB, xử lý trong trình duyệt) |
| "Mỗi lượt thử tối đa 20 trang để kiểm soát token…" / "Phạm vi trang phải nằm trong PDF, tối đa 20 trang mỗi lần." / "Mỗi lần tối đa 20 trang PDF." | Chọn quá 20 trang | Chia nhỏ phạm vi |
| "Lượt này xử lý 12/20 trang đã chọn…" | Không phải lỗi: đã chạm ngân sách ảnh/payload của một lượt | Dịch phần còn lại ở lượt sau |
| "Trang N là bìa nên được giữ nguyên ảnh gốc…" | Phạm vi chỉ có trang bìa | Thêm trang nội dung, hoặc tích "Dịch chữ trên bìa" |
| "Tách PDF vượt thời gian cho phép…" / "Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt." | Quá 240 s (Python) hoặc 280 s (Worker) | Ít trang hơn, hoặc thêm CPU |
| "Kết quả tách PDF vượt giới hạn dung lượng của dịch vụ…" | Kết quả quá lớn | Ít trang hơn |
| "Dịch vụ PDF dừng đột ngột… (mã 0xC0000005…/tín hiệu SIGKILL, có thể do hết bộ nhớ)…" / "Không đủ bộ nhớ để xử lý các trang đã chọn…" | Hết RAM hoặc crash trong thư viện native | Ít trang hơn; tăng RAM |
| "Không tìm thấy Python để chạy dịch vụ PDF (python). Hãy cài Python hoặc đặt PDF_PYTHON." | Không có lệnh `python` (hay gặp trên macOS/Linux) | Cài Python rồi chạy `npm run setup` (tự ghi `PDF_PYTHON` vào `.dev.vars`), rồi khởi động lại `dev:pdf-layout` |
| "Dịch vụ PDF gặp lỗi: ModuleNotFoundError: No module named 'pymupdf'" | Thiếu `.runtime/pdf-python`, hoặc đã cài bằng một Python khác kiến trúc | `npm run setup`, rồi khởi động lại `dev:pdf-layout` |
| "Máy chạy dịch vụ PDF chưa có Python thật: lệnh "python" đang mở lối tắt Microsoft Store…" (bản cũ hiện chữ lỗi như "Dịch vụ PDF gặp lỗi: Python t�m th…" hoặc "Python was not found…") | Máy chưa cài Python thật, hoặc cửa sổ chạy dịch vụ mở từ trước khi cài Python, nên lệnh `python` rơi vào lối tắt Microsoft Store (mã thoát 9009) | Cài Python 3 từ python.org, tích "Add python.exe to PATH". Đóng hết cửa sổ terminal cũ, mở cửa sổ mới, chạy `npm.cmd run setup` (bước 3 phải in "PyMuPDF 1.26.7 OK"; `setup` ghi đường dẫn Python vào `PDF_PYTHON` trong `.dev.vars`), rồi khởi động lại `npm.cmd run dev:pdf-layout` |
| "Không chạy được PyMuPDF (mã thoát N)." / "PyMuPDF trả dữ liệu không hợp lệ." | Lỗi bên trong `extract.py` | Đọc các dòng `[pdf-layout] …` trong cửa sổ dịch vụ |
| "Trang N là scan nhưng không chạy được OCR Tesseract (…)…" | Thiếu tessdata, hoặc `TESSDATA_PREFIX` trỏ sai | `npm run setup` (hoặc `npm run prepare:pdf-ocr`) |
| `ENOENT … frontend/vendor/tessdata/chi_sim.traineddata.gz` | Chưa chép thư viện vào `frontend/vendor/` | `npm run setup` |
| "Thiếu Chromium. Đặt CHROMIUM_EXECUTABLE_PATH hoặc dùng Docker." (chỉ hiện lúc xuất PDF) | Không tìm thấy Edge/Chrome/Chromium | Cài trình duyệt rồi chạy `npm run setup`, hoặc ghi `CHROMIUM_EXECUTABLE_PATH=<đường dẫn>` vào `.dev.vars`; khởi động lại `dev:pdf-layout` |
| "Trang N: chữ Việt không vừa box (ids)…" | Bản dịch dài hơn ô gốc | Rút gọn đoạn đó bằng "Chỉnh bản dịch từng đoạn", rồi xuất lại (không tốn token) |
| "Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự." | Token thiếu hoặc ngắn khi chạy `server.mjs`/Docker | Dùng ≥ 24 ký tự |
| "Đã cấu hình dịch vụ PDF bên ngoài. Chạy server.mjs với cấu hình của môi trường đó." | `PDF_LAYOUT_SERVICE_URL` trong `.dev.vars` không phải localhost | Dev local phải dùng `http://127.0.0.1:<cổng>` |
| `Error: listen EADDRINUSE … 127.0.0.1:8091` (cửa sổ vẫn mở với "Waiting for file changes before restarting..." nhưng dịch vụ không chạy) | Cổng đang bị chiếm (một instance khác hoặc container Docker) | Bấm Ctrl+C. Chạy `netstat -ano \| findstr :8091`, xem đó là chương trình gì bằng `Get-Process -Id <pid>`; chỉ `taskkill /PID <pid> /F` khi đó là dịch vụ cũ của bạn, nếu không thì đổi cổng trong `PDF_LAYOUT_SERVICE_URL` (ví dụ `http://127.0.0.1:8092`) rồi khởi động lại cả hai |
| "PDF có mật khẩu; hãy mở khóa trước khi dịch." · "Trang N quá lớn để render an toàn…" · "Tệp không phải PDF." · "Hãy dịch và lưu đủ các block trước khi xuất PDF." | Đúng như nội dung thông báo | Làm theo thông báo |

### 6.2 Build, Worker, D1

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Thiếu mô hình PaddleOCR. Chạy npm run prepare:ocr một lần trước khi build/dev." | Chưa tải mô hình | `npm run setup` hoặc `npm run prepare:ocr` (cần vào được bcebos.com), hoặc chép `det.tar`, `rec.tar`, `manifest.json` từ máy cũ |
| "Model …: HTTP N" / "…checksum khác phiên bản đã kiểm thử…" (lúc `prepare:ocr`) | Không tải được, hoặc tệp tải về khác bản đã kiểm | Kiểm tra mạng; dùng bản sao từ máy cũ |
| Wrangler chạy ở cổng khác 8787 | Cổng bận, Wrangler tự lấy cổng kế tiếp | Dùng URL in ra; với Google OAuth thì giải phóng cổng hoặc `npm run dev -- --port <cổng>` |
| "Wrangler requires at least Node.js v22.0.0…" | Node cũ | Cài Node 22.13+ hoặc 24 |
| "Cần Node.js 22.13 trở lên (đang dùng v…)." (lúc `npm run setup`) | Node 22.0–22.12 hoặc cũ hơn | Cài Node 22.13+ hoặc 24, mở cửa sổ mới, chạy lại |
| "Chưa cài thư viện. Chạy "npm ci" trước, rồi chạy lại "npm run setup"." | Chưa chạy `npm ci` | `npm ci` rồi `npm run setup` |
| `[ERROR] internal error; reference = …` (bước 7 của `setup`, `npm run db:local`, hoặc API cần D1 trả 400) · LỖI "Đường dẫn thư mục dự án quá dài cho Windows…" | Đường dẫn thư mục dự án quá dài (Windows giới hạn 260 ký tự), hoặc dự án nằm trên ổ `subst`/ổ mạng | Chuyển hoặc clone lại vào đường dẫn ngắn, ví dụ `C:\src\chinese-translator`, rồi chạy lại `npm run setup` |
| "running scripts is disabled on this system" | Execution policy của PowerShell | Dùng `npm.cmd` / `npx.cmd` |
| "Không tải được lịch sử: D1_ERROR: no such table: study_sessions…" / "no such column: library_chapter_id" (hoặc `page_start`, `source_sha256`, `cover_page`) | Thiếu migration | Local: `npm run db:local`. Remote: `npx wrangler d1 migrations apply DB --remote`. Kiểm bằng `migrations list`. Nếu lỗi xuất hiện ngay sau khi đổi `database_id` thì dev local đã sang DB mới: chạy lại `db:local` |
| Lỗi deploy/migration nhắc tới D1 id "local-db" | Chưa tạo D1 thật | Làm mục 5.2 |
| "Please enable R2 through the Cloudflare Dashboard" | Chưa bật R2 | Bật R2 trong dashboard |

### 6.3 Quản trị, tài khoản, Gemini

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Mã quản trị không đúng." / "Hãy mở Cài đặt và nhập mã quản trị để tiếp tục." | `ADMIN_TOKEN` sai hoặc chưa đặt | Đặt `ADMIN_TOKEN` (local: `.dev.vars` rồi khởi động lại; production: `secret put`) |
| "Chưa cấu hình khóa Gemini API. Hãy mở Cài đặt để nhập khóa." / "Chưa cấu hình GEMINI_API_KEY trên máy chủ…" | Xưởng dịch admin chưa có khóa máy chủ | Đặt `GEMINI_API_KEY`, hoặc lưu khóa trong "Cài đặt" |
| "Không giải mã được khóa API đã lưu. Hãy nhập lại khóa trong Cài đặt." | `ADMIN_TOKEN` đã đổi sau khi lưu khóa | Nhập lại khóa |
| "Chưa có khóa Gemini…" / "Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa." | Chưa dán khóa, hoặc độ dài khóa ngoài khoảng 20–500 ký tự | Dán đủ khóa; nhớ rằng tải lại trang là mất khóa |
| "Gemini từ chối yêu cầu (400/401/403)…" | Khóa sai hoặc bị giới hạn, API chưa bật. Chưa kiểm chứng: lỗi 400 chỉ gặp trên production có thể là "User location is not supported" do vị trí data-center của Worker | Kiểm tra khóa trong AI Studio |
| "Model Gemini “X” không khả dụng với khóa này…" | Model không mở cho project của khóa (họ 2.5 có thể 404) | `GEMINI_MODEL=gemini-3.6-flash`, để trống `GEMINI_PDF_BLOCK_MODEL`, khởi động lại; người học dùng "Kiểm tra model của khóa" |
| "Gemini đã hết hạn mức yêu cầu trong ngày…" | Hết quota trong ngày | Bật billing hoặc chờ |
| "Hãy đăng nhập để dùng không gian dịch học tập." / "Phiên đăng nhập đã hết hạn…" | Chưa đăng nhập hoặc hết phiên | Đăng nhập ở `/#account` |
| "Nguồn yêu cầu không hợp lệ." | Header Origin khác URL của Worker | Chỉ dùng một host (không trộn `localhost` với `127.0.0.1`) |
| "Email hoặc mật khẩu không đúng." / "Email này đã có tài khoản." / "Mật khẩu cần từ 8 đến 128 ký tự." | Tài khoản chỉ có trong D1 của môi trường đã tạo nó (local khác production) | Tạo tài khoản trên môi trường đang dùng |
| "Đăng nhập Google chưa được cấu hình trên máy chủ." | Thiếu một trong hai `GOOGLE_*` | Đặt cả hai |
| "Error 400: redirect_uri_mismatch" (trang của Google) | Callback chưa được đăng ký đúng | Đăng ký đúng `<origin>/api/auth/google/callback` |
| "Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn." | Bắt đầu ở `localhost` nhưng quay về `127.0.0.1` (hoặc ngược lại), hoặc quá 10 phút | Dùng một host, làm lại |
| "Google không thể xác nhận đăng nhập." | Sai client secret hoặc redirect URI | Kiểm tra lại cả hai |
| "Tài khoản Google cần có email đã xác minh." | Email Google chưa xác minh | Xác minh email trong tài khoản Google |

### 6.4 Tải cả quyển

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Không tải được công cụ ghép PDF. Hãy kiểm tra mạng rồi thử lại." | Thiếu `/vendor/pdf-lib.esm.min.js` hoặc `/vendor/pdf.mjs` (deploy mà không build) | `npm run build` rồi `npx wrangler deploy` |
| "Không ghép được cả quyển trên thiết bị này (có thể do thiếu bộ nhớ)…" | Thiết bị thiếu bộ nhớ | "Chỉ ghép các phần đã dịch", hoặc dùng máy tính |
| "Cần PDF gốc để ghép đủ bìa và các trang chưa dịch." | Phần cũ chưa có bản gốc trong tài khoản | "Chọn PDF gốc…". Nếu báo "“file” không khớp tệp gốc nào còn thiếu của sách." thì đã chọn nhầm tệp |

## 7. Kiểm thử

```powershell
npm.cmd test    # = node --test backend/*.test.mjs
```

- Trên máy gốc: 289 test, 289 đạt, khoảng 21–25 s (Node 24.14.0). Không test nào gọi Gemini thật (đều giả lập); test Python tạo `services/pdf-layout/__pycache__/` (đã ignore).
- Trên clone mới đã chạy `setup` (Windows, có Edge): 289 test, 288 đạt, 1 skip ("Real scans… real samples are not on this machine"); như vậy là bình thường. Các skip khác chỉ xuất hiện khi thiếu điều kiện trong bảng:

| Test | Cần | Nếu thiếu |
|---|---|---|
| 5 tệp chạy Python: `pdf-extract-inline`, `pdf-extract-objects`, `pdf-extract-robustness`, `pdf-extract-segmentation`, `pdf-ocr-sheets` | lệnh `python` (hoặc `PDF_PYTHON`) chạy được, `.runtime/pdf-python`, tessdata `chi_sim` + `eng` | skip: "needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)" |
| `book-ui.test.mjs` (2 test) | Microsoft Edge | skip: "Microsoft Edge is not available to playwright-core here" |
| `cover-detect` (phần rasterise) | `@napi-rs/canvas` (`npm ci` tự cài) | skip: "pdf.js cannot rasterise here (@napi-rs/canvas is missing)" |
| `cover-detect` "Real scans…" | mẫu thật trong `tmp/pdf-layout/` (không có trong repo) | luôn skip trên clone mới: "real samples are not on this machine" |
| `study-history-sqlite`, `study-books`, `library-match` | Node ≥ 22.13 (`node:sqlite`) | **không skip mà FAIL** |

- macOS/Linux: `export PDF_PYTHON=python3` trước `npm test`, nếu không 5 test Python bị skip.
- Chạy riêng một test Python (PowerShell):

```powershell
$env:PYTHONPATH="$PWD\.runtime\pdf-python"; $env:TESSDATA_PREFIX="$PWD\.runtime\tessdata"; $env:PYTHONUTF8="1"; python services/pdf-layout/test_segmentation.py
```

Các script khác (không nằm trong `npm test`):

| Lệnh | Cần | Gemini |
|---|---|---|
| `npm run test:pdf-layout` | Python + `.runtime`, Edge; ghi vào `tmp/pdf-layout/` | giả lập, không tốn token. **Hiện hỏng:** treo ở bước mở "Lịch sử dịch" vì giao diện đã đổi; đừng dùng để kiểm tra |
| `node backend/check-pdf-layout-service.mjs` | dịch vụ đang chạy; chạy `test:pdf-layout` trước (cần `tmp/pdf-layout/source.pdf`) | không gọi |
| `node backend/check-gemini-runtime.mjs [origin]` | `npm run dev` đang chạy, `ADMIN_TOKEN` trong `.dev.vars` | không cờ: chỉ `/api/status`. `--models`: lấy danh sách model (không sinh nội dung). **`--translate`: tốn token** |
| `npm run test:ocr -- "<pdf>" "9,39,59,80,110"` | Edge, một PDF thật | chưa rõ |
| `npm run test:study-history` | Edge | chưa rõ |
| `node backend/benchmark-actual-scan.mjs` | dữ liệu `tmp/pdf-layout/actual-scan/` (không có trong repo) | **gọi Gemini thật bằng khóa trong `.dev.vars`**; đừng chạy tùy tiện |
| `npm run build` | mô hình PaddleOCR | không gọi; kiểm bundle Worker, ghi `dist/` |

## 8. Giới hạn đã biết

**Vận hành và hạ tầng**

- **Mật khẩu:** tài khoản mới được băm PBKDF2-SHA256 100.000 vòng, mức tối đa Workers cho phép khi deploy (`wrangler dev` cho phép nhiều hơn nên ở local không lộ lỗi). Tài khoản tạo trước 16/10/2026 (210.000 vòng) vẫn đăng nhập được ở local; nếu chuyển chúng lên production thì phải tạo lại. Giới hạn 100.000 trên production chưa được kiểm chứng bằng deploy thật.
- **Giới hạn của Workers chưa đo.** Worker băm tệp tải lên tới 25 MB, parse/stringify JSON `/extract` tới khoảng 33 MB và giải mã base64 PDF. Gói Free chỉ có 10 ms CPU; mọi gói giới hạn 128 MB bộ nhớ mỗi isolate. Scan nặng 20 trang có thể gây lỗi 1102. Dùng Workers Paid; nếu gặp lỗi CPU, cân nhắc `"limits": {"cpu_ms": …}` trong `wrangler.jsonc`. `wrangler dev` không áp đúng giới hạn của production.
- **Dịch vụ PDF** không có TLS riêng, không có hàng đợi, tối đa 2 việc cùng lúc, mỗi lần xuất mở một Chromium headless; trong Docker chạy bằng root với `--no-sandbox`; `/health` cũng cần token.
- **Docker image chưa được build hay kiểm** (Docker daemon tắt lúc kiểm tra). Dữ liệu OCR (Debian `tesseract-ocr-chi-sim/eng`) và font (DejaVu Serif) khác bản Windows (`@tesseract.js-data` 4.0.0_best_int, Times New Roman). Mọi số đo đều làm trên Windows, nên kết quả OCR và việc vừa ô trên Linux có thể khác. Font trên Linux/Docker và trình duyệt Safari chưa thử.
- Chưa có script deploy hay CI.
- **PyMuPDF** có giấy phép kép AGPL-3.0 hoặc thương mại (Artifex). Chạy nó thành dịch vụ mạng có thể kéo theo nghĩa vụ AGPL; chủ dự án cần xem xét.
- **Model Gemini:** thiếu `GEMINI_MODEL` thì code dùng mặc định họ 2.5, có thể 404 với project mới, và xưởng dịch admin không tự đổi model. `GEMINI_QUALITY_MODEL` dùng cho hai việc (sửa lỗi của admin và chế độ "Đối chiếu kỹ").
- **Một `ADMIN_TOKEN` chung**: không có tài khoản admin riêng, không có nhật ký. Đổi token thì khóa Gemini đã lưu ở "Cài đặt" không giải mã được nữa.
- **Tệp lớn:** chế độ giữ bố cục nhận tối đa 25 MB; sách lớn phải tách tệp. Mỗi tệp tách đánh số trang lại từ 1 và người học tự sắp xếp các phần.
- **Dữ liệu local không lên production** (tài khoản, lịch sử, sách, tệp R2 trong `.wrangler/state`). Không có script chuyển; muốn chuyển phải tự xuất D1 (`npx wrangler d1 export DB --local --output local.sql`, rồi nhập bằng `npx wrangler d1 execute DB --remote --file local.sql`; chưa thử, có thể trùng bảng với migration đã áp) và chép tệp R2 bằng tay.
- Mô hình PaddleOCR tải từ Baidu BOS. Checksum chặn tệp bị thay, nhưng nếu URL mất thì `prepare:ocr` hỏng; nên giữ một bản `det.tar`/`rec.tar` ở ngoài git.

**Chất lượng dịch và dàn trang**

- Xuất lại chỉ sửa phần dàn trang. Lỗi trong bản tách trang cũ (ví dụ mất "OE/OA = O", mất tử số, đoạn chữ Hán chưa dịch như 由向量共面…/所以/证明：/数量积, "= =x(...)", mũi tên và dấu chấm thừa) chỉ hết khi dịch lại các trang đó (tốn token). Trên trang thử, xuất lại còn để một khoảng trống lớn phía trên bài tập 4.
- Nhãn xám mờ "证明：" vẫn giữ tiếng Trung, kể cả với bộ tách mới.
- Công thức do Gemini gõ lại có thể sai (không nhận √, a²+b² bị đọc thành chữ Hán, E_k=½mv² bị cắt); công thức Cl₂ nằm ngoài mọi block.
- Phân đoạn: còn 6 block lẫn vai trò và 14 block gộp nhiều đoạn; trang bài tập và thơ in nghiêng kém hơn bản cũ ở cả hai chỉ số này.
- Trang có giãn dòng rộng (khoảng 1,7 lần cỡ chữ trở lên) có thể bị tách mỗi dòng thành một block: câu bị cắt giữa từ khi dịch và dòng đầu của đoạn bị in chữ rất nhỏ. Gặp khi kiểm thử bàn giao với trang tổng hợp chữ 14 pt, giãn dòng 24 pt; giãn 21 pt trở xuống thì gộp đúng đoạn.
- Chữ "年" trong "1949年" ở tiêu đề bảng chưa được dịch.
- Chữ dọc: cả trang thành một khối, thứ tự đọc chỉ đúng 5%; chưa thử với Gemini thật.
- Chữ trong hình vẽ vẫn là tiếng Trung; nhãn chú thích được dịch làm thay đổi 1,2% điểm ảnh của hình; icon cạnh tiêu đề bị xóa theo; tiêu đề màu in ra gần như đen.
- Renderer: hằng số trục công thức (0,38 em) được chỉnh trên sách giáo khoa tiếng Trung; `prepareLayout` chưa có unit test; LaTeX trần trong bản dịch sẽ bị vẽ thành công thức khi xuất.

**Hiệu năng và token**

- Tờ OCR ghép mới chỉ được kiểm bằng Gemini thật trên 1 trang. Trong 2 lần gọi giống hệt nhau, có 1 lần Gemini lặp "&&&" tới giới hạn và tốn 6.242 token. Đầu ra OCR nay đã bị giới hạn, nhưng lượt lỗi vẫn tốn token và phải chạy lại. Token của bước dịch chưa được đo lại.
- Bộ đếm "token Gemini trong tab này" chỉ cộng lượt gọi thành công. Lượt Gemini trả JSON hỏng rồi được thử lại, hay dừng vì MAX_TOKENS/SAFETY, vẫn tốn token nhưng không được cộng; một lượt lặp vô hạn có thể tốn tới khoảng 33.000 token. Số chính xác xem trong Google AI Studio.
- Tách trang chậm hơn bản cũ 12–54% (trang thử: 14,8 s so với 9,6 s). Chọn 20 trang vẫn chỉ xử lý khoảng 12 trang mỗi lượt (bản cũ 13).
- Bộ nhớ khi ghép cả quyển dày trên điện thoại chưa đo.
- Giới hạn của phép đo: trang thử tổng hợp sạch hơn scan thật, trang thật không có đáp án chuẩn, cỡ chữ được đo bằng chữ Việt giả.

## 9. Bảo mật

- **`.dev.vars`** đã có trong `.gitignore`: không commit, không gửi qua chat hay email. Mỗi người tự tạo từ `.dev.vars.example`. Bản `.dev.vars` trên máy cũ chứa khóa Gemini cá nhân của chủ dự án; không bàn giao tệp đó.
- **Repo GitHub công khai**: mọi thứ push lên ai cũng đọc được. Không commit `.dev.vars`, `.wrangler/`, `.runtime/`, `tmp/`, `output/`, PDF sách hay ảnh chụp trang.
- **Khóa Gemini của người học**: mỗi người dùng khóa riêng tạo ở Google AI Studio. Khóa chỉ nằm trong bộ nhớ tab (không lưu vào localStorage), được gửi kèm từng yêu cầu tới Worker; Worker dùng nó gọi Gemini và không lưu lại.
- **Khóa Gemini máy chủ** (`GEMINI_API_KEY`) chỉ dùng cho xưởng dịch admin. Nếu lưu qua "Cài đặt", khóa được mã hóa AES-GCM (khóa mã hóa là SHA-256 của `ADMIN_TOKEN`), cất ở R2 `private/config/gemini-api-key.json` và không bao giờ được gửi lại trình duyệt.
- **`ADMIN_TOKEN`**: chuỗi ngẫu nhiên dài (64 hex), local và production khác nhau, production đặt bằng `wrangler secret put`. Ai có token là admin, và không có nhật ký. Trình duyệt chỉ giữ token trong tab. Đổi token thì nhập lại khóa Gemini ở "Cài đặt".
- **`PDF_LAYOUT_SERVICE_TOKEN`**: tối thiểu 24 ký tự (nên 64 hex), giống nhau ở Worker và dịch vụ, trình duyệt không thấy. Container chạy bằng root với `--no-sandbox` nên càng phải giữ kín; khi đổi thì đổi cả hai phía cùng lúc.
- **`.wrangler/`** là D1/R2 local: tài khoản, lịch sử, sách đã tải lên, khóa dashboard đã mã hóa. Thư mục này nằm trong `.gitignore`; không chép cho người khác; xóa là mất dữ liệu local.
- **Mật khẩu người dùng** được băm bằng PBKDF2-SHA256 100.000 vòng (tài khoản tạo trước 16/10/2026: 210.000 vòng). Cookie phiên `cat_hien_session` là HttpOnly, SameSite=Lax, sống 30 ngày, có cờ Secure khi chạy https.
- Kết quả quét trước bàn giao (các commit đã push: 70a3135, cb25216 và các commit của nhánh này): không có giá trị nào của `.dev.vars`, không có tệp PDF sách hay dữ liệu dịch; `git grep -E "AIza[0-9A-Za-z_-]{35}" <commit>` không ra kết quả. Chuỗi "AIza" chỉ có trong tài liệu này và khóa giả ở `backend/runtime-config.test.mjs`.

---

Tài liệu khác trong repo: `docs/pdf-layout-pipeline.md`, `docs/local-ocr-layout.md`.
