# Hoa Trí: hướng dẫn bàn giao

> Cập nhật 19/10/2026, nhánh `handoff/2026-10-16`. Dành cho người có kỹ thuật nhận chạy app trên máy để dịch sách và deploy lên Cloudflare (không phải người viết code ban đầu). Mọi lệnh chạy ở **thư mục gốc repo**. Chỗ ghi **(chưa kiểm chứng)** là chưa được chạy thử thật.

**Chạy nhanh trên Windows** (chỉ cần Git; chi tiết ở mục 3):

```powershell
git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git C:\src\chinese-translator
```

Rồi mở thư mục `C:\src\chinese-translator` và **bấm đúp `start.cmd`**. Lần đầu nó hỏi rồi tự cài Node.js và Python nếu máy chưa có (bằng winget), cài thư viện, chạy `npm run setup` (gồm áp migration vào D1 local và tải khoảng 29 MB dữ liệu từ điển), bật dịch vụ PDF và web trong cùng cửa sổ, rồi mở trình duyệt ở `http://127.0.0.1:8787/#account`. Các lần sau, bấm đúp `start.cmd` là chạy, kèm cập nhật code mới nhất (`git pull`) và `setup` (chỉ làm bước còn thiếu, kể cả migration mới). Trong trình duyệt: "Tạo tài khoản" (đánh dấu ô "Tôi đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư") → "Xưởng dịch học tập" → nhập "Tên nội dung" (bắt buộc) → dán khóa Gemini API của bạn (tạo miễn phí ở https://aistudio.google.com/apikey) → chọn PDF, chọn 1–3 trang → "Bắt đầu dịch →". Giữ cửa sổ `start.cmd` mở trong lúc dùng; đóng cửa sổ hoặc bấm Ctrl+C để tắt.

**Những điều không được quên khi deploy** (chi tiết ở mục 5 và `deploy/pdf-layout/README.md`)

1. Deploy bằng `npm run deploy` (lần đầu thêm `-- --secrets-file <tệp nằm ngoài repo>`). Script áp **migration D1 lên remote** (hỏi `CÓ` trước), chép `frontend/vendor/`, chạy `npm test`, deploy rồi tự kiểm tra bản mới. Deploy tay thì phải tự chạy `npx wrangler d1 migrations apply DB --remote` và `npm run build` trước `npx wrangler deploy`: thiếu migration thì đăng nhập, lịch sử và sách báo lỗi `schema_outdated`; thiếu build thì site không có `/vendor/` (OCR, pdf.js, "Tải cả quyển" hỏng).
2. Điền 4 loại chỗ trống `[[CHƯA ĐIỀN: …]]` trong hai trang pháp lý (mục 5.1). Deploy từ chối khi còn chỗ trống.
3. `ADMIN_TOKEN` của production là chuỗi ngẫu nhiên mới, **tối thiểu 32 ký tự** (nên 64 hex), khác bản local. Ngắn hơn thì trang `/admin` bị khóa.
4. Dịch vụ PDF trên production phải có **HTTPS công khai** (chứng chỉ hợp lệ, cổng 443) và không đi qua proxy của Cloudflare (bản ghi DNS bật đám mây màu cam, trạng thái "Proxied"; dưới đây gọi tắt là "proxy cam") hay Cloudflare Tunnel (bị cắt ở 100 s). `deploy/pdf-layout/` có sẵn Docker + Caddy cho việc này.
5. Không commit, không gửi `.dev.vars` và thư mục `samples/` (PDF sách). Repo GitHub đang **công khai**.
6. `wrangler.jsonc` đang để `"database_id": "local-db"`: tạo D1 thật trước lần deploy đầu (mục 5.3). Chọn tên Worker cũng trước lần đầu: đổi về sau là đổi URL, callback Google và phải đặt lại secret.

## 1. Dự án là gì

Hoa Trí là web app dịch sách và tài liệu tiếng Trung sang tiếng Việt bằng Gemini, chạy trên Cloudflare Workers (`backend/worker.js`, giao diện tĩnh `frontend/`, cơ sở dữ liệu D1, kho tệp R2). Người học đăng nhập, mở "Xưởng dịch học tập" (`/study.html`), dán khóa Gemini của mình và chọn PDF; app tách trang thành từng block (có OCR cho trang scan), dịch, rồi xuất PDF tiếng Việt theo bố cục trang gốc và lưu theo sách trong "Thư viện riêng". Việc tách trang và dựng PDF do một dịch vụ riêng đảm nhận (`services/pdf-layout`: Node + Python/PyMuPDF + Tesseract tích hợp + Chromium), vì Worker không chạy được Python hay Chromium. Khu quản trị `/admin` dùng khóa Gemini máy chủ để dịch, đối chiếu và xuất bản sách lên thư viện công khai.

Bố cục được đo thật, không ước: xem `docs/layout-metrics.md` (tóm tắt ở mục 8). Khi viết báo cáo, dùng các câu trong mục "Câu nên dùng trong báo cáo" của tài liệu đó, không dùng "giữ nguyên 90–95% bố cục" hay "tiết kiệm 80% thời gian" (chưa đo).

Đợt 10/2026 thêm: "Dịch cả quyển" (mục 4.2), "Đọc song ngữ" (4.3), tra chữ Hán (4.4), 4 môn khoa học có thuật ngữ sẵn (4.1), xóa lịch sử, xóa tài khoản, chế độ đăng ký và giới hạn tốc độ (4.5), "Ví dụ mẫu" cho thư viện công khai (4.6), trang điều khoản và quyền riêng tư (5.1), script deploy có kiểm tra (5.3) và CI (5.8).

| Tên | Là gì |
|---|---|
| `rynwoo1707/chinese-translator` | repo GitHub (công khai) |
| `muc-viet-cms` | tên Worker trong `wrangler.jsonc`; URL `https://muc-viet-cms.<subdomain>.workers.dev` |
| `muc-viet` (binding `DB`) | cơ sở dữ liệu D1; 17 migration `0001`–`0017` trong `database/migrations/`. Mới trong đợt này: `0014` (hạn mức ngày, khóa tài khoản, phiên bản điều khoản), `0015` (trang gốc của phần sách công khai), `0016` ("Dịch cả quyển"), `0017` (môn học của mục lịch sử) |
| `muc-viet-files` (binding `FILES`) | bucket R2 |
| `services/pdf-layout/` | dịch vụ PDF, cổng mặc định 8091 |
| `deploy/pdf-layout/` | Docker compose + Caddy cho dịch vụ PDF, và runbook deploy (`README.md`) |
| `tools/samples/` | công cụ làm "Ví dụ mẫu" không gọi Gemini (`npm run samples`) |
| `.github/workflows/ci.yml` | CI trên GitHub (mục 5.8) |

## 2. Chuẩn bị

| Phần mềm | Phiên bản | Ghi chú |
|---|---|---|
| Git | bản hiện hành | |
| Node.js (dùng npm đi kèm) | **22.13 trở lên** (22 LTS) hoặc 24.x | Wrangler 4.131.1 từ chối Node dưới 22; pdfjs-dist cần 22.13; 11 tệp test dùng `node:sqlite` sẽ FAIL trên Node cũ hơn. Máy gốc: Node 24.14.0, npm 11.9.0 |
| Python | CPython **3.10 trở lên**, 64-bit | chỉ dịch vụ PDF dùng. Máy gốc chạy 3.14.3 |
| PyMuPDF | 1.26.7 | `npm run setup` cài vào `.runtime/pdf-python`, không cài toàn cục |
| Trình duyệt họ Chromium | Microsoft Edge (Windows) hoặc Chromium/Chrome | dịch vụ PDF dùng để xuất PDF; test giao diện cần Edge |
| Font cho PDF xuất | Windows: `C:/Windows/Fonts/times.ttf` (có sẵn). Linux: DejaVu Serif (`fonts-dejavu-core`). macOS: phải chỉ đường dẫn | biến `PDF_FONT_PATH` |
| Tesseract | **không cần cài** | dùng Tesseract có sẵn trong MuPDF; dữ liệu `chi_sim`/`eng` do `npm run setup` tạo |
| Docker | tùy chọn | chạy dịch vụ PDF dạng container; image **chưa được build thử trên máy**, job `pdf-image` của CI là lần build đầu |

- Mọi gói npm (wrangler, esbuild, puppeteer-core, pdfjs-dist, tesseract.js, PaddleOCR…) đã ghim trong `package-lock.json` và cài bằng `npm ci`; không cần cài gì toàn cục. Luôn gọi `npx wrangler`: wrangler cài toàn cục bản cũ có thể không nhận `compatibility_date` 2026-09-01.
- Cần Internet khi cài: `npm ci`, `pip`, `npm run prepare:ocr` (khoảng 21,5 MB mô hình PaddleOCR từ `paddle-model-ecology.bj.bcebos.com`) và `npm run prepare:dict` (khoảng 29 MB từ `salsa.debian.org`, `raw.githubusercontent.com`, `www.unicode.org`).
- Tài khoản: mỗi người dịch một **khóa Gemini API riêng** (Google AI Studio). Deploy cần tài khoản Cloudflare có Workers, D1, R2, gần như bắt buộc gói **Workers Paid** (gói Free chỉ cho 10 ms CPU, không đủ cho đăng nhập PBKDF2 và PDF lớn), và một máy chủ Linux có tên miền cho dịch vụ PDF. Tùy chọn: OAuth client của Google Cloud (đăng nhập Google), khóa Gemini máy chủ (xưởng dịch `/admin`).

## 3. Chạy trên máy

### 3.1 Windows 11 (PowerShell)

Dùng `npm.cmd`/`npx.cmd` để khỏi gặp lỗi "running scripts is disabled". Nếu PowerShell cho chạy script thì gõ `npm`/`npx` cũng được.

**Cách nhanh nhất:** clone vào thư mục ngắn rồi bấm đúp `start.cmd` (hoặc gõ `.\start.cmd` trong PowerShell). Lệnh này làm thay bạn các bước 1–4 dưới đây:
- Thiếu Node.js thì hỏi rồi cài bằng `winget install OpenJS.NodeJS.LTS` (Windows có thể hỏi quyền quản trị).
- Thiếu Python thì `setup` hỏi rồi cài Python 3.13 cho riêng người dùng bằng winget, không cần quyền quản trị.
- Chạy `git pull --ff-only` (không được thì vẫn chạy bản hiện có), rồi `npm ci` khi `package-lock.json` đổi, rồi `npm run setup` (áp migration mới, tạo hoặc cập nhật từ điển).
- Bật dịch vụ PDF và web trong cùng cửa sổ (dòng log có tiền tố `[PDF]` / `[WEB]`), rồi mở trình duyệt khi cả hai đã sẵn sàng.

Máy không có winget: cài Node.js LTS (https://nodejs.org) và Python 3 (python.org, tích "Add python.exe to PATH") bằng tay rồi bấm đúp `start.cmd`. Đã cài đặt xong thì cũng có thể chạy `npm.cmd start` để bật cả hai dịch vụ trong một cửa sổ, thay cho bước 3–4. `npm start` **chỉ bật**: không `git pull`, không `setup`, không áp migration.

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
| 6 | tạo `.dev.vars` từ `.dev.vars.example`, sinh `ADMIN_TOKEN` và `PDF_LAYOUT_SERVICE_TOKEN` ngẫu nhiên 64 hex (không in ra) | `.dev.vars` |
| 7 | áp các migration còn thiếu trong 17 migration vào D1 local (= `npm run db:local`) | `.wrangler/state` |
| 8 | từ điển Pinyin & Hán Việt cho "Tra chữ Hán" (= `npm run prepare:dict`): tải 6 tệp nguồn khoảng 29 MB có kiểm SHA-256, dựng khoảng 5 s (tốn khoảng 0,9 GB RAM), không dùng Gemini | `.runtime/dict-sources/`, `frontend/vendor/dict/` (1.282 tệp, khoảng 24 MB) |

- Cần Internet (`npm ci`, `pip`, mô hình từ `paddle-model-ecology.bj.bcebos.com`, nguồn từ điển). Nếu chỉ riêng bcebos.com bị chặn: chép 3 tệp `det.tar`, `rec.tar`, `manifest.json` từ máy khác vào `frontend/vendor/paddle/models/` rồi chạy lại `setup` (bước 1 sẽ bỏ qua). Thiếu mô hình thì bước 2 và 4 cũng bị bỏ qua.
- Bước 8 lỗi chỉ là **CẢNH BÁO**: nút "Tra chữ Hán" báo chưa có dữ liệu, phần dịch vẫn chạy; có mạng thì chạy `npm.cmd run prepare:dict`. Dữ liệu đã có thì nó in "Từ điển đã có, bỏ qua."; khi `backend/dictionary-build.js` hoặc `frontend/hanzi-dict.js` đổi, nó dựng lại từ bản đã tải (không tải lại).
- Máy không ra được các trang nguồn từ điển: chép 6 tệp `cedict_ts.u8`, `CVDICT.u8`, `hanviet.csv`, `hanviet-LICENSE.txt`, `Unihan.zip`, `CJKRadicals.txt` vào một thư mục rồi chạy `npm.cmd run prepare:dict -- --from <thư mục>`; hoặc chép nguyên thư mục `.runtime/dict-sources` của máy khác vào đúng chỗ đó trong dự án rồi chạy `npm.cmd run prepare:dict`. Tệp khác phiên bản đã kiểm bị từ chối. Muốn lên phiên bản nguồn mới: `node backend/prepare-dictionary.mjs --print-hashes [url…]` in kích thước và SHA-256, rồi sửa `SOURCES` trong `backend/prepare-dictionary.mjs`.
- Nguồn và giấy phép từ điển: CC-CEDICT (MDBG, CC BY-SA 4.0), CVDICT (Phong Phan, CC BY-SA 4.0; nghĩa tiếng Việt phần lớn dịch máy), hanviet-pinyin-wordlist (MIT), Unihan và CJKRadicals 18.0.0 (Unicode License v3). Dữ liệu gộp phát hành theo CC BY-SA 4.0: `LICENSE.txt` nằm cùng dữ liệu và được deploy theo, còn dòng ghi nguồn ở chân bảng tra (`frontend/hanzi-lookup.js`) và ở chân trang (`frontend/site-footer.js`) **phải giữ nguyên**.
- Báo **LỖI** không tìm thấy Python: cài Python 3 từ python.org (tích "Add python.exe to PATH"), mở cửa sổ PowerShell mới rồi chạy lại `npm.cmd run setup`. Khi thiếu Python, `dev:pdf-layout` vẫn khởi động (kèm CẢNH BÁO "không chạy được PyMuPDF…") và `/study.html` vẫn báo "Dịch theo từng block…", nhưng "Bắt đầu dịch →" với PDF giữ bố cục sẽ báo "Không tìm thấy Python để chạy dịch vụ PDF (python)…". Muốn dịch tạm khi chưa có Python: bỏ tích "Giữ bố cục PDF và xuất bản tiếng Việt" (PDF xử lý trong trình duyệt, chỉ ra văn bản/HTML).
- **CẢNH BÁO** không tìm thấy trình duyệt hoặc phông: dịch vụ PDF chạy được nhưng không xuất được PDF. Cài Microsoft Edge (Windows có sẵn) rồi chạy lại `setup`.
- `.dev.vars` không được commit. Mã vào trang `/admin` là giá trị dòng `ADMIN_TOKEN`. `GEMINI_API_KEY` để trống được: chỉ xưởng dịch `/admin` cần, người học dán khóa riêng trên trang. Mỗi dòng dạng `KEY=value` (không `export`, không chú thích cuối dòng); khóa lặp lại thì dòng **cuối** thắng. Ý nghĩa từng biến: mục 5.4.
- **Sau mỗi lần cập nhật code** (`git pull`), chạy lại `npm.cmd run setup` (ít nhất `npm.cmd run db:local`) trước `npm run dev`/`npm start`: hai lệnh này không áp migration. Thiếu migration `0014`–`0017` thì đăng nhập, lịch sử và "Dịch cả quyển" báo "Cơ sở dữ liệu chưa được cập nhật lên phiên bản mới…" (mã `schema_outdated`). `start.cmd` tự làm việc này.

**Bước 3 (cửa sổ PowerShell thứ nhất): dịch vụ PDF**

```powershell
npm.cmd run dev:pdf-layout
```

In "PDF layout service ready (PyMuPDF + Puppeteer)." rồi nghe ở cổng trong `PDF_LAYOUT_SERVICE_URL` (mặc định `127.0.0.1:8091`). Dòng `Restarting 'services/pdf-layout/local.mjs'` ngay lúc khởi động là bình thường. Để cửa sổ này chạy. Dịch vụ tự khởi động lại khi tệp .mjs/.js thay đổi; `extract.py` được chạy mới cho mỗi yêu cầu. Nếu `.dev.vars` chưa có token (ví dụ bạn tự tạo tệp), lệnh này tự ghi thêm `PDF_LAYOUT_SERVICE_TOKEN`; khi đó phải khởi động lại `npm run dev`.

**Bước 4 (cửa sổ PowerShell thứ hai): web (Worker)**

```powershell
npm.cmd run dev                   # prepare:vendor + wrangler dev (đọc .dev.vars); không áp migration
npm.cmd run dev -- --port 8789    # nếu muốn ghim cổng
```

Mặc định là `http://127.0.0.1:8787`; nếu cổng bận, Wrangler tự lấy cổng kế tiếp và in URL ra, hãy dùng URL đó. Sửa `.dev.vars` thì phải khởi động lại lệnh này.

**Bước 5: địa chỉ**

| URL | Trang |
|---|---|
| `http://127.0.0.1:8787/` | thư viện công khai |
| `http://127.0.0.1:8787/#account` | đăng ký, đăng nhập, "Thư viện riêng", xóa tài khoản |
| `http://127.0.0.1:8787/study.html` | "Xưởng dịch học tập" (cần đăng nhập) |
| `http://127.0.0.1:8787/admin` | khu quản trị |
| `http://127.0.0.1:8787/dieu-khoan`, `/quyen-rieng-tu` | điều khoản sử dụng, chính sách quyền riêng tư |
| `http://127.0.0.1:8787/api/health` | kiểm tra sức khỏe: D1 và cấu hình dịch vụ PDF, không cần đăng nhập |

**Bước 6: kiểm tra nhanh, không tốn token**

Nếu đã đổi cổng dịch vụ PDF (`PDF_LAYOUT_SERVICE_URL`) hoặc cổng web, thay `8091`/`8787` dưới đây bằng cổng của bạn.

```powershell
curl.exe -s http://127.0.0.1:8091/health     # mong đợi {"error":"Unauthorized"}
$t = (Select-String -Path .dev.vars -Pattern '^PDF_LAYOUT_SERVICE_TOKEN=.' | Select-Object -Last 1).Line -replace '^PDF_LAYOUT_SERVICE_TOKEN=', ''
curl.exe -s -H "Authorization: Bearer $t" http://127.0.0.1:8091/health   # {"ok":true,"engine":"pymupdf-puppeteer","busy":false}
curl.exe -s http://127.0.0.1:8787/api/health  # "ok":true, "database":"ok", "pdfLayout":"configured"
node backend/check-gemini-runtime.mjs        # chỉ gọi /api/status bằng ADMIN_TOKEN; cổng khác thì thêm http://127.0.0.1:8789
```

Đăng nhập rồi mở `/study.html`: dòng trạng thái PDF phải là "Dịch theo từng block; giữ hình gốc, công thức và vị trí." Nếu không, xem mục 6. Dòng này chỉ xác nhận Worker có cấu hình và đọc được phông qua dịch vụ; Python/PyMuPDF chỉ chạy khi tách trang, Chromium khi xuất PDF.

### 3.2 macOS / Linux (chưa chạy thử)

- Các bước giống Windows, dùng `npm`/`npx` (bỏ `.cmd`). URL thường là `http://localhost:8787`.
- `npm run setup` tìm `python3` khi không có `python`, tìm Chrome/Edge/Chromium (kể cả trong `/Applications`) và phông (Times New Roman trên macOS; DejaVu Serif hoặc Liberation Serif trên Linux), rồi ghi đường dẫn Python vào `PDF_PYTHON`, và `CHROMIUM_EXECUTABLE_PATH`, `PDF_FONT_PATH` khi máy cần, vào `.dev.vars`. `npm run dev:pdf-layout` đọc ba biến này từ `.dev.vars`; biến cùng tên đặt trong shell được ưu tiên.
- Linux: cài trước `python3-pip` (nếu `setup` báo thiếu pip), `chromium` và `fonts-dejavu-core`. Cài PyMuPDF kiểu `--target` như `setup` làm không bị chặn bởi PEP 668.
- Kiểm tra token: `t=$(grep '^PDF_LAYOUT_SERVICE_TOKEN=.' .dev.vars | tail -n 1 | cut -d= -f2- | tr -d '\r'); curl -s -H "Authorization: Bearer $t" http://127.0.0.1:8091/health`
- Thay cho `dev:pdf-layout`, có thể chạy dịch vụ bằng Docker (image chưa build thử trên máy):

```bash
docker build -f services/pdf-layout/Dockerfile -t hoa-tri-pdf .
docker run --rm -p 127.0.0.1:8091:8091 -e PDF_LAYOUT_SERVICE_TOKEN="<giá trị PDF_LAYOUT_SERVICE_TOKEN trong .dev.vars>" hoa-tri-pdf
```

Dùng đúng token đang có trong `.dev.vars` (và `PDF_LAYOUT_SERVICE_URL=http://127.0.0.1:8091`). Đừng chạy thêm `dev:pdf-layout` (trùng cổng).

### 3.3 Đăng nhập khi chạy local

- **Người học:** `/#account` → "Tạo tài khoản" (Tên hiển thị, Email, Mật khẩu 8–128 ký tự, đánh dấu ô "Tôi đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư") hoặc "Đăng nhập". Máy mới chưa có tài khoản nào; tài khoản nằm trong D1 local ở `.wrangler/`. Ai được tạo tài khoản do `REGISTRATION_MODE` quyết định (mặc định `open` trong `wrangler.jsonc`; mục 4.5). Muốn thử chế độ khác ở local, thêm dòng đó vào `.dev.vars` rồi khởi động lại `npm run dev`.
- **Quản trị:** `/admin` → nhập giá trị `ADMIN_TOKEN` vào "Mã quản trị". Mã chỉ được giữ trong bộ nhớ tab, tải lại trang phải nhập lại. Không có tài khoản admin riêng. Mã ngắn hơn 32 ký tự chỉ dùng được khi mở bằng `127.0.0.1`/`localhost`; trên production trang quản trị khóa và báo "ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự…".
- **Khóa Gemini máy chủ (tùy chọn, chỉ cho xưởng dịch admin):** `/admin` → "Cài đặt" → "Khóa API mới" → "Lưu và sử dụng"; "Dùng lại khóa máy chủ" để xóa. Bản lưu nằm trong R2, nên local và production phải nhập riêng.
- **Google (tùy chọn):** tạo OAuth client loại *Web application* trong Google Cloud Console, thêm redirect URI **khớp từng ký tự** với origin đang mở, ví dụ `http://127.0.0.1:8787/api/auth/google/callback` (`localhost` khác `127.0.0.1`, cổng cũng phải khớp). Đặt cả `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` trong `.dev.vars`, rồi khởi động lại `npm run dev`. Thiếu một trong hai thì nút hiện "Đăng nhập Google sẽ xuất hiện khi được cấu hình." Nút Google chỉ bấm được sau khi đánh dấu ô đồng ý điều khoản.

## 4. Dùng app để dịch

### 4.1 Dịch theo phạm vi

Trong `/study.html` (phải đăng nhập):

1. **"Tên nội dung"** (bắt buộc): dùng cho lịch sử, "Thư viện riêng" và tên tệp tải về. "Lưu tên" đổi tên mà không gọi Gemini.
2. **"Chọn tài liệu từ thiết bị"** → chọn PDF. Ô "Giữ bố cục PDF và xuất bản tiếng Việt" chỉ được tích khi dịch vụ PDF sẵn sàng. Bật: hiện "Cách dịch PDF" với "Dịch theo phạm vi" (mặc định, tệp tối đa 25 MB, tải cả tệp lên) và "Dịch cả quyển" (mục 4.2; tệp 25–100 MB chỉ dùng được cách này). Tắt: tới 250 MB, xử lý trong trình duyệt, chỉ ra văn bản/HTML.
3. **"Trang PDF cần dịch"**: mặc định `1-3`, cú pháp `12-14, 37`, tối đa **20 trang mỗi lượt** (không tính bìa). Scan nặng có thể bị cắt bớt; thông báo "Lượt này xử lý 12/20 trang đã chọn… Hãy dịch tiếp trang 13-20 ở lượt sau." là bình thường.
4. **Bìa** được nhận tự động (trang 1, hoặc trang 2 nếu trang 1 trắng). Mặc định bìa không được dịch mà giữ ảnh gốc làm ảnh bìa sách. Nút: "Đổi"/"Chọn trang bìa", "Không dùng bìa", "Dịch chữ trên bìa".
5. **"Thêm vào sách"**: "Sách mới" hoặc một sách đã có. App gợi ý "Dịch tiếp trang X–Y"; nếu phạm vi trùng đúng một phần cũ, app đề nghị "Thay phần “…” bằng bản dịch này thay vì thêm trang trùng".
6. **Mục 02**: dán "Khóa Gemini API riêng" (chỉ giữ trong tab, tải lại trang là mất). Chọn "Lĩnh vực tài liệu" (Chuyên khảo · Nghiên cứu / Toán học · STEM / Lịch sử Trung Hoa / Vật lý / Hóa học / Sinh học / Tin học) và "Chế độ dịch" (Tiết kiệm token / Cân bằng / Đối chiếu kỹ). Tùy chọn: "Kiểm tra model của khóa", "Thuật ngữ cần thống nhất". Bấm **"Bắt đầu dịch →"**.
7. Dịch xong mọi block, app tự "Xuất PDF tiếng Việt" và gắn PDF vào phần tương ứng của sách trong "Thư viện riêng"; trình xem hai khung hiện bản gốc và bản dịch. Muốn dừng: "Dừng sau lượt hiện tại"; mở lại từ "Lịch sử dịch của tôi" để dịch tiếp.
8. Sửa chữ: "Chỉnh bản dịch từng đoạn" → lưu → "Xuất PDF tiếng Việt" (không gọi Gemini).

**Lĩnh vực có thuật ngữ sẵn:** Vật lý (119 thuật ngữ), Hóa học (114), Sinh học (106), Tin học (99) theo sách giáo khoa GDPT 2018, mỗi thuật ngữ kèm dạng phồn thể và cách viết Đài Loan; Toán dùng bảng thuật ngữ toán có sẵn. Máy chủ tự thêm, và chỉ gửi những thuật ngữ có trong đoạn đang dịch (đo trên một đoạn mẫu mỗi môn: 5–6 thuật ngữ, khoảng 30–50 token, không thêm lượt gọi). Thuật ngữ người học tự nhập luôn được ưu tiên. Chuyên khảo và Lịch sử chưa có bảng riêng. Sách mới lấy tên môn làm thể loại, và khung chú thích thuật ngữ khi đọc cũng hiện thuật ngữ sẵn của môn đó.

### 4.2 Dịch cả quyển

Dùng khi muốn dịch cả sách (hoặc một phần lớn) mà không chọn từng 20 trang. Cần dịch vụ PDF và ô "Giữ bố cục PDF…" đang bật.

1. Chọn PDF (tới 100 MB) → "Cách dịch PDF" → **"Dịch cả quyển"**. Nhập "Tên nội dung" (thành tên sách) và dán khóa Gemini.
2. Bảng "Dịch cả quyển" cho biết số trang, dung lượng, trang bìa; ô **"Trang cần dịch"** (để trống là cả quyển, ví dụ `5-120, 130-200`; trang khác thành "Bỏ qua"); ước tính token ghi rõ "chỉ là ước tính" (900–2.100 token mỗi trang có lớp chữ, 3.000–8.000 mỗi trang scan; khi đã có trang dịch xong thì tính thêm theo mức trung bình của chính quyển đó); lưới trạng thái từng trang (Chưa dịch, Đang dịch, Đã dịch, Trang trống, Bìa, Bỏ qua, Lỗi); "Đã dịch X/Y trang" và tổng token quyển đã dùng.
3. Bấm **"Dịch cả quyển"**. App tải bản gốc lên tài khoản **một lần** (hỏi máy chủ trước, có thanh tiến độ; tối đa 100 MiB), tạo một lượt dịch trên máy chủ, rồi lặp:
   - trình duyệt cắt các trang chưa dịch liền nhau thành một lượt tối đa 20 trang (cắt nhỏ hơn nếu lượt nặng quá 16 MB);
   - mỗi lượt đi đúng đường của "Dịch theo phạm vi": tách trang, đọc ảnh, dịch, lưu thành một phần của cùng một sách trong "Thư viện riêng", xuất PDF tiếng Việt; rồi ghi tiến độ, token và thuật ngữ mới vào lượt dịch.
   - Bìa không gửi đi; trang không có chữ Trung thành "Trang trống", không gọi Gemini. Trang dịch vụ PDF không xử lý được thành "Lỗi" và được thử lại ở lần chạy sau ("Thử lại các trang lỗi").
4. **Thuật ngữ của quyển:** "Thuật ngữ cần thống nhất" cộng các thuật ngữ học được ở mỗi lượt, gửi kèm mọi lượt sau (máy chủ chỉ lấy tối đa 100 thuật ngữ có trong đoạn). Một thuật ngữ đã có cách dịch thì lượt sau không đổi được, trừ khi người học tự sửa. Bảng ngừng học thêm khi đủ 2.000 thuật ngữ hoặc 256 KB.
5. **Dừng và dịch tiếp:** "Dừng sau trang hiện tại" dừng ngay sau trang đang dịch. Tiến độ, token và thuật ngữ nằm trên máy chủ, nên tải lại trang, hôm sau, hay máy khác đều tiếp tục được: "Lịch sử dịch của tôi" → "Sách của tôi" → "Tiếp tục" (lấy bản gốc đã lưu, không cần chọn lại tệp) → dán khóa. Chọn lại đúng tệp đó trong Xưởng dịch cũng tiếp tục lượt cũ; trang đã dịch không tốn token lại.
6. **Tự xử lý lỗi:** Gemini giới hạn mỗi phút (`quota_minute`) thì đếm ngược rồi tự chạy tiếp. Hết hạn mức ngày (`quota_day`) thì tạm dừng và báo giờ đặt lại (khoảng 15:00 giờ Việt Nam, 14:00 khi Mỹ dùng giờ mùa hè): dán khóa khác rồi "Tiếp tục dịch cả quyển", hoặc chờ. Khóa bị từ chối (`gemini_key`) thì tạm dừng và hỏi khóa khác. Giới hạn tốc độ của Hoa Trí thì chờ; chạm hạn mức ngày của Hoa Trí thì tạm dừng. Mất mạng hoặc lỗi 502/503/504 thì thử lại sau 5, 10, 20, 40, 60, 60 giây rồi tạm dừng. Câu trả lời Gemini không qua kiểm tra được thử lại một lần.
7. **Để tab mở** trong lúc dịch: việc dịch chạy trong trình duyệt bằng khóa trong tab. Điện thoại được giữ sáng màn hình; chuyển sang ứng dụng khác thì việc dịch chờ và tự chạy tiếp khi quay lại. Hai tab của cùng trình duyệt không chạy cùng một quyển; hai thiết bị thì chưa bị chặn (mục 8).
8. Trong "Sách của tôi", lượt dịch cả quyển hiện "Dịch cả quyển · Đã dịch X/Y trang · trạng thái · token", các nút "Tiếp tục", "Sắp xếp phần", "Đọc sách", "Xóa tiến độ" và danh sách "Các phần đã lưu". "Xóa tiến độ" chỉ xóa bảng tiến độ: các phần đã dịch vẫn ở Lịch sử và Thư viện riêng.

Mỗi lượt tính một lần vào hạn mức tách PDF mỗi ngày (`DAILY_PDF_EXTRACTS_PER_USER`, mặc định 100): sách 600 trang cần ít nhất 30 lượt. Cần migration `0016` và `0017`.

### 4.3 Sách, "Tải cả quyển" và "Đọc song ngữ"

- "Gộp vào sách…" (trên thẻ lịch sử đã xong) chuyển phần đó sang sách khác; "Sắp xếp phần" đổi thứ tự và tên sách. Sách một phần bị gộp đi sẽ bị xóa; bìa của nó chuyển sang nếu sách đích chưa có bìa.
- "Tải cả quyển (PDF)": `/#account` → mở sách → mở một phần PDF. Trình duyệt ghép mọi trang gốc, thay trang đã dịch vào đúng chỗ, giữ bìa và trang chưa dịch. Phần cũ có thể hỏi "Chọn PDF gốc…": tệp chỉ dùng trên máy, không tải lên. "Chỉ ghép các phần đã dịch" cho bản gọn. Sách công khai có PDF gốc (ví dụ "Ví dụ mẫu") cũng ghép như vậy; thiếu bản gốc thì app ghép các phần kèm ghi chú thay vì hỏi tệp.
- **"Đọc song ngữ"** ("Xem trang gốc cùng bản dịch") hiện trong trang đọc với phần PDF mà sách biết phần đó dịch trang nào của bản gốc **và** máy chủ còn giữ bản gốc: các phần dịch ở chế độ giữ bố cục (theo phạm vi hoặc cả quyển) trong Thư viện riêng, và các phần sách công khai đăng kèm trang gốc (công cụ mẫu, mục 4.6). Phần văn bản hay phần cũ không có số trang thì nút này ẩn. Bật lên mới tải bản gốc (tải dần theo trang đang xem); hai trang dùng chung số trang và mức phóng; điện thoại xếp chồng hai trang; phím ←/→, Page Up/Down, +/−/0, Home/End; "Mở PDF gốc ↗" mở bản gốc ở trang đầu của phần.

### 4.4 Tra chữ Hán (Pinyin & Hán Việt)

Từ điển offline trong `/vendor/dict/` (bước 8 của `setup`): không dùng khóa Gemini, không gọi `/api`, không tốn token.

- **Trang đọc:** nút **字** ("Tra chữ Hán: pinyin, âm Hán Việt và nghĩa") trên thanh công cụ mở ô tìm (có sẵn chữ Hán đang bôi đen); chạm vào chữ Hán trong phần văn bản, trong khung chú thích thuật ngữ, và trên trang gốc khi "Đọc song ngữ" (chỉ khi PDF gốc có lớp chữ thật, không phải ảnh scan).
- **Xưởng dịch:** nút "Tra chữ Hán" cạnh "Văn bản cần dịch" (bôi đen chữ Hán trong ô, không bôi đen thì tra quanh con trỏ); chạm vào vùng chữ ở trang gốc ("Đối chiếu trang gốc") hoặc vào đoạn chữ Hán trên PDF gốc trong khung hai trang; chạm vào chữ nguồn trong ô sửa đoạn.
- Bảng tra hiện từ, pinyin, âm Hán Việt, nghĩa tiếng Việt (CVDICT, có nhãn "dịch máy") và nghĩa tiếng Anh (CC-CEDICT), từng chữ, "Từ trước"/"Từ sau", "Nghe" (cần giọng đọc tiếng Trung cài trên máy), "Sao chép" (cần https hoặc localhost). Ô "Tra khi chạm vào chữ" ở chân bảng bật/tắt việc tra khi chạm (mặc định bật, nhớ trong trình duyệt).
- Thiếu dữ liệu thì bảng báo "Máy chủ này chưa có dữ liệu từ điển…": chạy `npm run prepare:dict` (production: chạy rồi deploy lại).

### 4.5 Tài khoản, xóa dữ liệu, giới hạn

- **Chế độ đăng ký** (`REGISTRATION_MODE`, var trong `wrangler.jsonc`): `open` (mặc định, ai cũng tạo được tài khoản), `closed` (không tạo tài khoản mới, kể cả bằng Google; tài khoản đã có vẫn đăng nhập), `domain` (chỉ email thuộc `ALLOWED_EMAIL_DOMAINS`, cách nhau bằng dấu phẩy, tính cả tên miền con). Giá trị sai chính tả, hoặc `domain` mà danh sách trống, bị coi là `closed`. Đăng ký và nút Google đều cần đánh dấu ô đồng ý điều khoản; tài khoản ghi lại phiên bản điều khoản (`TERMS_VERSION`) và thời điểm đồng ý.
- **Xóa một bản dịch:** "Lịch sử dịch của tôi" → "Xóa" trên mục đó (không bấm được khi đang dịch). Mục bị xóa khỏi lịch sử và khỏi sách; sách trống thì bị xóa cùng bìa; PDF, ảnh và bản gốc chỉ mục đó dùng bị xóa vĩnh viễn (tệp mục khác, bìa hay lượt dịch cả quyển còn dùng thì giữ). Nếu mục là một phần của "Dịch cả quyển", các trang của nó trở lại "Chưa dịch" để dịch lại được.
- **Xóa tài khoản:** `/#account` → "Xóa tài khoản…" → nhập "Mật khẩu hiện tại" (tài khoản Google không cần) và chữ `XÓA` → "Xóa vĩnh viễn". Xóa lịch sử, sách riêng, bản gốc và bản dịch, yêu cầu dịch kèm tệp, phiên đăng nhập, mật khẩu và các lượt dịch cả quyển; sách đã công bố trong thư viện chung vẫn giữ nhưng không còn gắn tên. Đang có việc admin chạy trên sách riêng của người đó thì báo "Một tài liệu của bạn đang được xử lý…" (thử lại sau). Tệp R2 xóa là mất hẳn; D1 Time Travel vẫn khôi phục được hàng đã xóa trong thời hạn lưu của Cloudflare.
- **Quản trị viên:** `/admin` → "Học sinh & thư viện riêng": "Khóa tài khoản" (đăng xuất mọi phiên, đăng nhập báo "Tài khoản này đang bị tạm khóa…"), "Mở khóa", "Xóa tài khoản" (như trên). Mỗi tài khoản hiện phiên bản điều khoản đã đồng ý.
- **Giới hạn mỗi phút** (binding trong `wrangler.jsonc`, Cloudflare đếm theo từng vị trí, chỉ để chặn dồn dập): `AUTH_LIMITER` 10/phút cho đăng nhập theo email, đăng ký theo IP, xóa tài khoản; `HEAVY_LIMITER` 12/phút mỗi tài khoản cho tải tệp, tách trang, dựng PDF, gửi yêu cầu dịch; `API_LIMITER` 120/phút cho các thao tác khác và đăng nhập theo IP. Vượt thì báo "Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại."
- **Hạn mức mỗi ngày** (đếm trong bảng D1 `rate_limits`, đặt lại lúc 0:00 giờ Việt Nam; đặt biến bằng `0` để tắt): `DAILY_REGISTRATIONS_PER_IP` 30 tài khoản mỗi IP, `DAILY_REQUESTS_PER_USER` 20 yêu cầu dịch, `DAILY_PDF_EXTRACTS_PER_USER` 100 lần tách PDF (kể cả mỗi lượt của "Dịch cả quyển"), `DAILY_SOURCE_UPLOADS_PER_USER` 30 lần tải bản gốc. Cả lớp tạo tài khoản cùng lúc trong một mạng trường (chung IP) sẽ chạm cả 10/phút lẫn 30/ngày: cho đăng ký rải ra hoặc tăng `DAILY_REGISTRATIONS_PER_IP`. Thiếu binding hoặc D1 lỗi thì giới hạn tự bỏ qua, không chặn người dùng.

### 4.6 Ví dụ mẫu cho thư viện công khai

`npm run samples -- <lệnh> <mã>` làm bản dịch mẫu giữ bố cục **không gọi Gemini**: app tách trang trên máy, người dịch (người hoặc Claude) viết chữ Trung đọc lại và bản dịch vào `texts.json`, công cụ kiểm tra bằng đúng các bước kiểm tra của Hoa Trí, dựng PDF, rồi đăng qua API quản trị kèm PDF gốc (mặc định chỉ trích bìa và các trang đã dịch) và số trang gốc của từng phần, nên người đọc có "Tải cả quyển" và "Đọc song ngữ". Trang chủ gắn nhãn "Ví dụ mẫu" và xếp các sách này lên đầu. Hướng dẫn đầy đủ: `tools/samples/README.md`.

- Mọi tệp làm việc nằm trong `samples/` (git bỏ qua; không bao giờ commit). Đăng mặc định lên máy này (`http://127.0.0.1:8787`, mã trong `.dev.vars`); sao lưu `.wrangler/state` trước khi đăng vào thư viện local thật. Máy chủ khác bắt buộc HTTPS và mã qua biến `HOATRI_ADMIN_TOKEN`.
- Chỉ đăng khi `rights.confirmed` là `true`. **Sách còn bản quyền** (ví dụ sách giáo khoa thương mại) phải đặt `"rights": {"localOnly": true}`: công cụ chỉ cho đăng lên máy chủ trên máy này. Không bao giờ đăng chúng lên site công khai.
- Máy chủ đích cần migration `0015`; thiếu thì công cụ dừng trước khi tải gì lên.

**Mẹo tiết kiệm token**

- Nếu trang báo "Thư viện đã có bản dịch được giáo viên duyệt…" (cùng tệp, so bằng SHA-256), bấm "Mở bản đã duyệt" thay vì dịch.
- Thử 1–3 trang trước; để mặc định bỏ qua bìa. Với "Dịch cả quyển", xem ước tính rồi dùng ô "Trang cần dịch" để chỉ dịch phần cần.
- Dùng "Tiết kiệm token" cho bản nháp. Ở chế độ giữ bố cục PDF, cả ba "Chế độ dịch" đều gọi Gemini với thinking 'minimal'; chế độ chỉ đổi model khi `GEMINI_PDF_BLOCK_MODEL` để trống và có đặt `GEMINI_ECONOMY_MODEL`/`GEMINI_BALANCED_MODEL`/`GEMINI_QUALITY_MODEL` (mặc định cả ba dùng `GEMINI_MODEL`). "Đối chiếu kỹ" dùng thinking 'low' (hai chế độ kia 'minimal') chỉ khi dịch văn bản (dán chữ, TXT/DOCX/EPUB/AZW3 hoặc PDF xử lý trong trình duyệt), nên dự kiến tốn hơn (chưa đo).
- **Đừng dịch lại chỉ để sửa dàn trang.** Mở mục trong "Lịch sử dịch của tôi", bấm "Xuất PDF tiếng Việt": app dựng lại từ dữ liệu đã lưu, không tốn token. Bản xuất cũ sẽ hiện "PDF đã xuất dùng cách dàn trang cũ…". Cách này sửa phân số ½, dấu câu lặp, chữ bị cắt hoặc co quá nhỏ; nó **không** sửa lỗi nằm trong bản tách trang cũ (mất chữ hay công thức, đoạn chữ Hán chưa dịch). Lỗi loại đó phải dịch lại (tốn token): chọn cùng PDF và cùng trang, tích "Thay phần …".
- Có thể dừng rồi tiếp tục mà không mất phần đã dịch. Theo dõi bộ đếm "token Gemini trong tab này" (và tổng token của quyển khi dịch cả quyển).
- Khi tắt giữ bố cục, OCR chạy trong trình duyệt (PaddleOCR/Tesseract); chỉ trang có độ tin cậy thấp mới gửi lên Gemini.
- Gemini thỉnh thoảng lặp chữ vô hạn. Đầu ra OCR đã bị giới hạn độ dài, nhưng lượt lỗi vẫn tốn token và phải chạy lại.

**Dữ liệu nằm ở đâu:** D1: `study_sessions` (lịch sử), `stories` (sách), `chapters` (các phần), `book_jobs` (tiến độ "Dịch cả quyển"), `reader_users` (tài khoản), `rate_limits` (đếm hạn mức ngày). R2 `muc-viet-files`: `study/<userId>/…` (trạng thái, manifest, PDF đã dịch; `study/<userId>/sources/<sha256>.pdf` là bản gốc cả tệp dùng cho "Dịch cả quyển", "Tải cả quyển" và "Đọc song ngữ"), `library/<storyId>/sources/…` (bản gốc của sách công khai), `covers/…`, `private/config/gemini-api-key.json`. Khi chạy local, tất cả nằm trong `.wrangler/state/v3`; xóa thư mục này là mất dữ liệu local.

**Quản trị (khóa máy chủ):** `/admin` → "Xưởng dịch" (tải lên, chạy) → "Đối chiếu bản dịch" → xuất bản lên thư viện công khai.

## 5. Deploy lên Cloudflare

> **(chưa kiểm chứng)** Chưa ai deploy thật lần nào (`database_id` vẫn là `local-db`). `npm run deploy` chỉ mới chạy với Cloudflare giả lập (`backend/deploy.test.mjs`); cờ và định dạng đầu ra của wrangler đã được đối chiếu với wrangler 4.131.1. **Runbook từng bước: `deploy/pdf-layout/README.md`** (phần A: dịch vụ PDF bằng Docker + Caddy; phần B: Worker bằng `npm run deploy`). Mục này tóm tắt và nêu những việc runbook không nói.

```
Trình duyệt ──HTTPS──> Worker muc-viet-cms  (D1 muc-viet, R2 muc-viet-files, tệp tĩnh frontend/)
                           │  HTTPS + Authorization: Bearer <PDF_LAYOUT_SERVICE_TOKEN>, chờ tối đa 280 s
                           ▼
                 Caddy :443 (chứng chỉ tự động) ──> container pdf-layout :8091 (không mở ra ngoài)
```

Trình duyệt không bao giờ gọi thẳng dịch vụ PDF và không thấy token. Windows dùng `npm.cmd`/`npx.cmd`, macOS/Linux dùng `npm`/`npx`.

### 5.1 Trước lần deploy đầu

- [ ] Clone sạch từ GitHub, không chép thư mục từ máy cũ; `npm ci`, `npm run setup` (ít nhất `npm run prepare:ocr`) và `npm test` chạy được trên máy dùng để deploy.
- [ ] Tài khoản Cloudflare đã **bật R2** trong dashboard (chưa bật thì không tạo được bucket), có D1, dùng Workers Paid.
- [ ] Chủ dự án đã quyết định: tên Worker (đổi `"name"` trong `wrangler.jsonc` trước lần đầu), `REGISTRATION_MODE`, giấy phép AGPL của PyMuPDF khi mở dịch vụ ra mạng, quyền công bố sách mẫu, và điều kiện 18 tuổi của Gemini API (mục 8).
- [ ] **Trang pháp lý:** điền 4 loại chỗ trống (10 chỗ) trong `frontend/dieu-khoan.html` và `frontend/quyen-rieng-tu.html`: `[[CHƯA ĐIỀN: tên người hoặc tổ chức vận hành]]`, `[[CHƯA ĐIỀN: email liên hệ]]`, `[[CHƯA ĐIỀN: ngày hiệu lực]]`, `[[CHƯA ĐIỀN: nhà cung cấp và quốc gia đặt máy chủ dịch vụ PDF]]`. Test `backend/legal-pages.test.mjs` đạt cả trước và sau khi điền. Script deploy đòi cây git sạch, nên commit trước khi deploy.
- [ ] Trang quyền riêng tư ghi D1 và R2 đặt ở châu Á – Thái Bình Dương (theo `--location apac` ở mục 5.3); tạo ở nơi khác thì sửa câu đó.
- [ ] `TERMS_VERSION = '2026-10'` (`backend/reader-auth.js`) phải khớp dòng "Phiên bản 2026-10" của hai trang (test kiểm tra). Sửa nội dung trang đáng kể thì tăng cả ba chỗ cùng lúc. Thêm khóa `localStorage` mới ở giao diện thì phải liệt kê nó trong `quyen-rieng-tu.html` (test kiểm tra).
- [ ] Chạy `npm run prepare:dict` nếu muốn "Tra chữ Hán" hoạt động trên production: `frontend/vendor/dict` không commit, nên deploy lấy bản trên máy deploy; thiếu thì script chỉ cảnh báo.
- [ ] 2 chuỗi ngẫu nhiên **mới**, khác bản local: `ADMIN_TOKEN` (tối thiểu 32 ký tự) và `PDF_LAYOUT_SERVICE_TOKEN` (tối thiểu 24 ký tự); nên dùng 64 hex: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` (chạy 2 lần) hoặc `openssl rand -hex 32`. Cất trong trình quản lý mật khẩu, không ghi vào repo.
- [ ] Máy chủ Linux có Docker cho dịch vụ PDF: tên miền trỏ thẳng về máy (DNS only, mây xám), mở cổng 80 và 443.

### 5.2 Dịch vụ PDF (deploy trước Worker)

Làm theo phần A của `deploy/pdf-layout/README.md`. Tóm tắt:

```bash
git clone https://github.com/rynwoo1707/chinese-translator.git hoa-tri   # thêm -b <nhánh> nếu không deploy từ main
cd hoa-tri/deploy/pdf-layout
cp env.example .env && chmod 600 .env    # điền PDF_DOMAIN, ACME_EMAIL, PDF_LAYOUT_SERVICE_TOKEN
docker compose up -d --build             # lần đầu build image mất vài phút
docker compose ps                        # pdf-layout: healthy; caddy: Up
curl -s https://pdf.example.com/health   # {"error":"Unauthorized"}: dịch vụ đòi token
docker compose exec pdf-layout node services/pdf-layout/smoke.mjs http://127.0.0.1:8091 /tmp/smoke   # không gọi Gemini
```

Image dựa trên `node:22.23.3-bookworm-slim`, chạy bằng user `node` (Chromium vẫn cần `--no-sandbox` trong container), có sẵn `HEALTHCHECK`, dùng cùng dữ liệu OCR với bản Windows. Caddy tự lấy chứng chỉ, chỉ chuyển tiếp 4 đường dẫn của dịch vụ, nhận thân yêu cầu tới 48 MB, chờ phản hồi 300 s.

Quy tắc bắt buộc (đã có sẵn trong compose + Caddy; tự dựng proxy khác thì phải tự giữ):

- URL phải là `https://` (ngoại lệ duy nhất: host `127.0.0.1`, `localhost`, `pdf-layout`). Sai quy tắc thì mọi thao tác PDF báo "Dịch vụ PDF cần HTTPS."
- Worker không gọi được `localhost` hay IP mạng LAN; chứng chỉ tự ký bị từ chối.
- Dịch vụ chỉ nhận đúng `/health`, `/font`, `/extract`, `/render`. `PDF_LAYOUT_SERVICE_URL` là **gốc** dịch vụ (ví dụ `https://pdf.example.com`); proxy không được thêm tiền tố đường dẫn.
- Không dùng hostname proxy cam hay Cloudflare Tunnel: Cloudflare cắt ở 100 s (lỗi 524), trong khi một lượt có thể cần 240–280 s. Proxy khác (nginx…): timeout ≥ 300 s, thân yêu cầu ≥ 45 MB, không giữ keep-alive tới dịch vụ.

| Giới hạn | Giá trị |
|---|---|
| Việc đồng thời | 2 mỗi container; việc thứ ba nhận 503 "Dịch vụ PDF đang bận…". Trên nền tảng tự co giãn, đặt concurrency 2 mỗi instance |
| Dữ liệu vào | PDF thô 25 MiB, JSON 40 MiB |
| Phản hồi `/extract` | tới khoảng 32 MiB base64, nên proxy/nền tảng phải cho khoảng 45 MB cả hai chiều (ví dụ Cloud Run giới hạn yêu cầu HTTP/1 ở 32 MiB) |
| Thời gian | Caddy chờ 300 s; Worker chờ 280 s; Python dừng ở 240 s (đầu ra ≤ 100 MiB) |
| Tài nguyên | compose mặc định 2 CPU, 3g RAM (`PDF_LAYOUT_CPUS`, `PDF_LAYOUT_MEMORY` trong `.env`); ước tính khởi điểm 2 vCPU, 4 GB RAM (chưa đo trên Linux). Trên máy dev Windows: 2–3 trang scan mất 14,8–21,4 s; chọn 20 trang mất 58–60 s và xử lý được 10–12 trang |
| Health check | `/health` cũng cần Bearer token; image tự kiểm mỗi 15 s. Nền tảng không gửi được header thì dùng probe TCP |

### 5.3 Worker: `npm run deploy`

Làm theo phần B của `deploy/pdf-layout/README.md`. Tóm tắt:

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create muc-viet --binding DB --location apac --update-config
npx.cmd wrangler r2 bucket create muc-viet-files --location apac
npm.cmd run deploy:check                                                             # chỉ kiểm tra, không thay đổi gì trên Cloudflare
npm.cmd run deploy -- --secrets-file C:\Users\<bạn>\hoa-tri-secrets\production.env   # lần đầu
npm.cmd run deploy                                                                   # các lần sau
```

- `d1 create` ghi UUID thật vào `database_id` và giữ `"preview_database_id": "local-db"`, nên dev local vẫn mở D1 cũ. UUID không bí mật: commit thay đổi đó. `r2 bucket create` có hỏi thêm vào cấu hình thì từ chối (binding `FILES` đã có). **Không** đổi `bucket_name` (dữ liệu R2 local gắn với tên bucket).
- Tệp secret dạng `TÊN=giá trị`, nằm **ngoài** thư mục dự án, không đặt tên `.dev.vars…`: `ADMIN_TOKEN`, `PDF_LAYOUT_SERVICE_URL`, `PDF_LAYOUT_SERVICE_TOKEN`; tùy chọn `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. **Không bao giờ** dùng `.dev.vars` local làm tệp secret: nó chứa URL 127.0.0.1 và khóa cá nhân.
- Tên model và `REGISTRATION_MODE` nay là **var** trong `wrangler.jsonc`: không còn bước `wrangler secret put GEMINI_MODEL`. Worker nào đã có secret trùng tên một var (thường là `GEMINI_MODEL` từ hướng dẫn cũ) thì xóa secret đó, ví dụ `npx.cmd wrangler secret delete GEMINI_MODEL`: script dừng khi một tên vừa là var vừa là secret.
- Script lần lượt: kiểm tra trên máy (Node ≥ 22.13, cây git sạch, `wrangler.jsonc`, không còn `[[CHƯA ĐIỀN`, tệp secret) → đọc Cloudflare (đăng nhập, bucket, secret, phiên bản đang chạy) → chép `frontend/vendor`, `npm test` có chặn Gemini/Google/Cloudflare, `wrangler deploy --dry-run` → liệt kê migration chờ, in điểm khôi phục Time Travel, hỏi `Gõ CÓ để tiếp tục:` rồi áp → `wrangler deploy --strict` gắn tag là mã commit → kiểm tra `/api/health`, `/vendor/`, `/api/library`, `/api/me`, `/api/status` (báo nếu `ADMIN_TOKEN` ngắn hơn 32 ký tự) và `/vendor/dict/manifest.json`, rồi in danh sách kiểm tra tay và lệnh quay lại.
- Tùy chọn: `--yes` (không hỏi trước khi áp migration), `--skip-tests`, `--allow-dirty`, `--allow-placeholders`, `--allow-stale`, `--url https://…` (địa chỉ để kiểm tra, ví dụ tên miền riêng). Đặt biến `HOATRI_ADMIN_TOKEN` để script kiểm tra cả `/api/status` bằng mã quản trị.
- Quay lại: `npx wrangler rollback <version-id>` (không hoàn tác migration và secret); dữ liệu D1: `npx wrangler d1 time-travel restore DB --bookmark=<bookmark>`; R2 không có bản lưu.
- Deploy tay (không dùng script): `npx.cmd wrangler d1 migrations apply DB --remote`, `npm.cmd run build` (BẮT BUỘC: điền `frontend/vendor/`), `npx.cmd wrangler deploy`. `wrangler deploy` lấy thẳng `backend/worker.js` và `frontend/` (không dùng `dist/`) và không chạy npm script nào.
- Lần đầu có thể phải đăng ký subdomain `workers.dev` trong dashboard. Kích thước đo bằng `--dry-run` ngày 19/10/2026: bundle 3.238 KiB (690 KiB gzip); khoảng 1.550 tệp tĩnh khi đã có từ điển (từ điển chiếm 1.282 tệp), tệp lớn nhất 16,7 MB (giới hạn 25 MiB mỗi tệp).

### 5.4 Biến môi trường và secret

Var không bí mật nằm trong khối `"vars"` của `wrangler.jsonc`, dùng chung cho production và `wrangler dev`; một dòng trong `.dev.vars` ghi đè trên máy local. Secret: local đặt trong `.dev.vars`, production đặt bằng `--secrets-file` hoặc `npx wrangler secret put <tên>`. Không thêm khối `"secrets"` vào `wrangler.jsonc` (khi có khối đó, `wrangler dev` chỉ nạp các tên được liệt kê).

| Biến | Loại | Ý nghĩa |
|---|---|---|
| `ADMIN_TOKEN` | Secret, **bắt buộc** | mã vào `/admin`, đồng thời là khóa mã hóa khóa Gemini lưu ở "Cài đặt" (đổi token thì phải nhập lại khóa đó). Ngoài `127.0.0.1`/`localhost`, mã dưới 32 ký tự bị từ chối và `/api/status` báo `adminTokenTooShort` |
| `PDF_LAYOUT_SERVICE_URL` | Secret, **cần** cho giữ bố cục | gốc dịch vụ PDF, `https://` |
| `PDF_LAYOUT_SERVICE_TOKEN` | Secret, **cần** cho giữ bố cục | Bearer gửi tới dịch vụ, ≥ 24 ký tự, giống hệt phía dịch vụ. Thiếu URL hoặc token thì chế độ giữ bố cục coi như chưa cấu hình |
| `GEMINI_API_KEY` | Secret, tùy chọn | khóa máy chủ, **chỉ** cho xưởng dịch admin và danh sách model của admin; có thể lưu ở "Cài đặt" thay cho biến này. Người học không dùng |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Secret, tùy chọn | đăng nhập Google chỉ bật khi có đủ cả hai |
| `GEMINI_MODEL` | Var (`gemini-3.6-flash`) | model chính. Để trống thì code dùng mặc định họ 2.5 (admin: `gemini-2.5-flash`), có thể 404 với project Google mới |
| `GEMINI_PDF_BLOCK_MODEL` | Var (trống) | model dịch block PDF; để trống nếu gặp 404 |
| `GEMINI_QUALITY_MODEL` | Var (trống) | model của "Đối chiếu kỹ" và model sửa/thử lại (cả admin lẫn học tập) |
| `GEMINI_ECONOMY_MODEL`, `GEMINI_BALANCED_MODEL` | Var (trống) | đổi model cho "Tiết kiệm token" / "Cân bằng" |
| `GEMINI_THINKING` | Var (trống) | chỉ cho admin: `minimal`, `low`, `default`; để trống thì dịch dùng 'minimal', OCR dùng 'low' |
| `REGISTRATION_MODE`, `ALLOWED_EMAIL_DOMAINS` | Var (`open`, trống) | chế độ đăng ký (mục 4.5) |
| `DAILY_REGISTRATIONS_PER_IP`, `DAILY_REQUESTS_PER_USER`, `DAILY_PDF_EXTRACTS_PER_USER`, `DAILY_SOURCE_UPLOADS_PER_USER` | Var tùy chọn (chưa có trong `wrangler.jsonc`; mặc định 30, 20, 100, 30) | hạn mức mỗi ngày (mục 4.5); số nguyên, `0` là tắt. Muốn đổi thì thêm vào `"vars"` |

Không đặt `GEMINI_MODEL_RECOVERY`, `GEMINI_PREFERRED_MODEL` (code tự gắn cho từng yêu cầu). Ba binding giới hạn tốc độ (`AUTH_LIMITER`, `HEAVY_LIMITER`, `API_LIMITER`) nằm trong khối `"ratelimits"`; `namespace_id` của chúng (71001–71003) phải không trùng với Worker khác trong cùng account.

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

### 5.5 Đăng nhập Google (tùy chọn)

1. Google Cloud Console: cấu hình màn hình đồng ý loại External, thêm test user hoặc publish.
2. Tạo OAuth client ID loại *Web application*. Authorized redirect URI: `https://<host Worker>/api/auth/google/callback`; thêm `http://127.0.0.1:8787/api/auth/google/callback` nếu dev local cần. Sau này gắn tên miền riêng thì đăng ký thêm callback của tên miền đó.
3. Đưa `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` vào tệp secret (hoặc `npx.cmd wrangler secret put …` từng cái).

### 5.6 Checklist sau deploy

Script đã tự kiểm phần lớn; kiểm thêm bằng tay:

```powershell
$W = "https://muc-viet-cms.<subdomain>.workers.dev"
curl.exe -s "$W/api/health"       # "ok":true, "version":<mã commit>, "database":"ok", "pdfLayout":"configured"
curl.exe -s "$W/api/me"           # "authenticated":false, "registration":{"mode":"open",...}, "termsVersion":"2026-10"
curl.exe -s "$W/api/library"      # []  (bảng D1 hoạt động)
curl.exe -s "$W/api/status"       # "authenticated":false, không có "adminTokenTooShort"
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/pdf.mjs"                 # 200 text/javascript; charset=utf-8
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/paddle/models/det.tar"   # 200 application/x-tar
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" "$W/vendor/dict/manifest.json"      # 200 application/json (khi đã chạy prepare:dict)
npx.cmd wrangler d1 migrations list DB --remote                            # không còn chờ
```

Thấy `text/html` nghĩa là tệp không có: site trả `index.html` với mã 200 cho mọi đường dẫn lạ. Khi đó chạy `npm run build` (hoặc `npm run prepare:dict` với từ điển) rồi deploy lại. macOS/Linux: dùng `curl` thay `curl.exe`, `/dev/null` thay `NUL`, bỏ `` `n ``.

- [ ] Để `npx.cmd wrangler tail` chạy trong một cửa sổ riêng suốt lúc kiểm tra.
- [ ] Mở một dòng log trong Workers Logs: nếu thấy header của yêu cầu (cookie…), đặt `observability.logs.invocation_logs` thành `false` trong `wrangler.jsonc` rồi deploy lại.
- [ ] Dịch vụ PDF: `/health` trả 401 khi không có token, `{"ok":true,…}` khi có (mục 5.2).
- [ ] `/dieu-khoan`, `/quyen-rieng-tu`: không còn chữ "CHƯA ĐIỀN"; chân trang có liên kết pháp lý và dòng ghi nguồn từ điển.
- [ ] `/#account`: tạo một tài khoản thử (đánh dấu ô đồng ý), đăng xuất rồi đăng nhập lại; cuối buổi thử "Xóa tài khoản…" với tài khoản đó.
- [ ] `/study.html`: lịch sử tải được; dòng PDF là "Dịch theo từng block; giữ hình gốc, công thức và vị trí."; "Tra chữ Hán" mở được bảng tra.
- [ ] `/admin`: đăng nhập, mở "Cài đặt"; lưu khóa Gemini máy chủ nếu cần (R2 production không có bản của local).
- [ ] (Tốn token) dịch thử 1–2 trang bằng khóa thử, chờ "PDF tiếng Việt đã được lưu vào Thư viện riêng…", rồi thử "Tải cả quyển (PDF)" và "Đọc song ngữ".

### 5.7 Khi cập nhật code về sau

Thứ tự: `git pull` → `npm ci` → `npm run setup` (cập nhật `frontend/vendor` và từ điển trên máy deploy) → `npm run deploy` (liệt kê migration mới, hỏi `CÓ`, áp rồi mới deploy). Nếu `services/pdf-layout/`, `package*.json`, `frontend/pdf-box-layout.js` hoặc `frontend/math-text.js` thay đổi, build lại image trên máy chủ dịch vụ PDF: `git pull`, rồi `docker compose up -d --build` trong `deploy/pdf-layout` (mục A.5 của runbook).

### 5.8 CI

`.github/workflows/ci.yml` chạy cho mỗi lần push lên `main` hoặc `handoff/**` và mỗi pull request; không dùng secret nào của repo, không gọi Gemini, không chạm Cloudflare. Huy hiệu CI nằm đầu `README.md`. Chi tiết ở mục B.3 của runbook.

- **test** (Ubuntu 24.04, Node 24, Python 3.12): báo đỏ khi commit nhầm `.dev.vars`, `.env`, khóa Google, khóa riêng tư, `samples/`, `.wrangler/`; cài mọi thứ như `setup` (trừ từ điển); `npm test` với bộ chặn API trả phí; job đỏ nếu một test cần Python bị bỏ qua; các test giao diện chỉ chạy với Edge bị bỏ qua (CI xóa Edge); `wrangler deploy --dry-run`.
- **pdf-image**: build image, chạy container (healthy, không chạy bằng root, đòi token, `smoke.mjs` đạt), chạy cả compose + Caddy qua HTTPS cho `localhost` (chuyển HTTP sang HTTPS, chặn đường dẫn lạ, thân yêu cầu 39 MiB tới được dịch vụ); đính kèm ảnh trang đã xuất (artifact `pdf-smoke`, 7 ngày).
- Lần chạy CI đầu tiên trên GitHub cũng là lần đầu image được build (chưa kiểm chứng).

## 6. Xử lý sự cố

### 6.1 Mã lỗi chung

Lỗi từ `/api/…` là JSON `{"error": "<thông báo tiếng Việt>", "code": "<mã>"}` (một số lỗi cũ không có `code`); giao diện hiện nguyên thông báo.

| Mã | Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|---|
| `schema_outdated` (500) | "Cơ sở dữ liệu chưa được cập nhật lên phiên bản mới (chạy npm run db:local rồi khởi động lại). Hãy báo quản trị viên, kèm mã …" (phần trong ngoặc chỉ hiện ở local). Bản trước 10/2026 hiện "D1_ERROR: no such table/column …" | D1 thiếu migration, thường là `0014`–`0017` sau khi cập nhật code mà chỉ chạy `npm run dev`/`npm start` | Local: tắt app, `npm run db:local` (hoặc `npm run setup`, hay bấm đúp `start.cmd`), bật lại. Production: `npm run deploy` (hoặc `npx wrangler d1 migrations apply DB --remote`). Kiểm bằng `npx wrangler d1 migrations list DB --local`/`--remote` |
| `internal` (500) | "Máy chủ gặp lỗi ngoài dự kiến… gửi mã <ray> cho quản trị viên." | Lỗi trong code; chi tiết chỉ ghi vào log | Tìm mã ray trong cửa sổ `npm run dev` (dòng `[WEB]` khi dùng `start.cmd`) hoặc `npx wrangler tail`/Workers Logs: một dòng JSON `"event":"api_error"` |
| `rate_limited` (429) | "Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại." / "Bạn đã dùng hết N lượt … hôm nay. Hạn mức được đặt lại lúc 0:00 (giờ Việt Nam)." | Giới hạn mỗi phút hoặc hạn mức ngày (mục 4.5) | Đợi; muốn nới hạn mức ngày thì đặt biến `DAILY_…` (mục 5.4) |
| `quota_minute` (429) | "Gemini đang giới hạn số lượt gọi mỗi phút của khóa này. Hãy đợi … rồi tiếp tục; nội dung đã được lưu." | Hạn mức mỗi phút của khóa Gemini | Đợi rồi dịch tiếp; "Dịch cả quyển" tự đếm ngược và chạy tiếp |
| `quota_day`, `quota` (429) | "Gemini đã hết hạn mức yêu cầu trong ngày của dự án. Hãy chờ đến HH:MM (giờ Việt Nam)…" / "Gemini tạm hết hạn mức của khóa này…" | Hết hạn mức ngày của dự án Google (đặt lại lúc nửa đêm giờ Thái Bình Dương: 15:00, hoặc 14:00 khi Mỹ dùng giờ mùa hè) | Dán khóa của dự án khác, bật Billing trong Google AI Studio, hoặc chờ; tiến độ đã lưu |
| `gemini_key` (400/403) | "Gemini từ chối yêu cầu (N): khóa Gemini API không hợp lệ hoặc đã hết hạn…" / "…đang bị chặn, bị tạm ngưng hoặc chưa được phép dùng Gemini API…" / "…chưa dùng được Gemini API ở khu vực hiện tại hoặc cần bật Billing…" | Khóa sai, hết hạn, bị chặn hoặc bị lộ; dự án chưa bật Gemini API hoặc khu vực không được hỗ trợ | Kiểm tra khóa và dự án trong AI Studio, dán khóa khác. App không tự thử lại |
| `too_large` (413) | "Dữ liệu gửi lên quá lớn: tối đa N MB cho thao tác này." | Thân yêu cầu vượt giới hạn của thao tác (ví dụ: bản gốc "Dịch cả quyển" 100 MiB, tách trang 26 MB, lưu lịch sử 32 MB, phần lớn thao tác khác 8 MB) | PDF 25–100 MB: dùng "Dịch cả quyển"; lớn hơn thì tách tệp. Tệp sát 100 MB có thể bị Cloudflare chặn trước, khi đó báo "Chưa tải được bản gốc lên (mã 413)…" |
| `source_missing` (404) | "Tài khoản chưa lưu tệp gốc này. Hãy tải tệp lên trước khi dịch cả quyển." / "Tài khoản không còn bản PDF gốc của quyển này. Hãy chọn lại đúng tệp PDF gốc để dịch tiếp." | Bản gốc chưa tải lên xong hoặc đã bị xóa | Chọn lại đúng tệp PDF gốc trong Xưởng dịch rồi "Dịch cả quyển": app tải bản gốc lên rồi tiếp tục lượt cũ |
| `no_text` (422) | "Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn." | Các trang được chọn không có chữ Trung (trang trắng, chỉ có hình) | "Dịch cả quyển" tự đánh dấu các trang đó là "Trang trống" và đi tiếp, không tốn token. "Dịch theo phạm vi": chọn trang khác |
| `job_exists` (409) | "Tệp này đang có một lượt dịch cả quyển chưa xong…" | Tệp đã có lượt dịch cả quyển dở (tab hay máy khác bắt đầu) | App tự tiếp tục lượt đó; muốn làm lại từ đầu thì "Xóa tiến độ" |
| `origin` (403) | "Nguồn yêu cầu không hợp lệ." | Origin khác URL của Worker (mở `localhost` nhưng gọi `127.0.0.1`, hoặc trang của site khác) | Chỉ dùng một host |
| `terms_required` (400) | "Hãy đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản." | Chưa đánh dấu ô đồng ý (cả khi bấm Google) | Đánh dấu ô |
| `registration_closed` (403) | "Hoa Trí hiện chưa mở đăng ký tài khoản mới…" / "Chỉ email thuộc … được tạo tài khoản." | `REGISTRATION_MODE` là `closed`/`domain`, hoặc giá trị sai chính tả (bị coi là `closed`) | Sửa `REGISTRATION_MODE`/`ALLOWED_EMAIL_DOMAINS` (mục 5.4); tài khoản đã có vẫn đăng nhập được |
| `account_disabled` (403) | "Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên." | Quản trị viên đã khóa | `/admin` → "Học sinh & thư viện riêng" → "Mở khóa" |

Với đăng nhập Google, ba lỗi `terms_required`, `registration_closed`, `account_disabled` hiện thành một trang JSON thô (chưa có trang báo lỗi riêng).

### 6.2 Dịch vụ PDF

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Chưa cấu hình dịch vụ PDF giữ bố cục." hoặc dòng trạng thái "Dịch vụ PDF giữ bố cục chưa được cấu hình." | Worker thiếu `PDF_LAYOUT_SERVICE_URL` và/hoặc `PDF_LAYOUT_SERVICE_TOKEN`. Ở local thường do `npm run dev` chạy trước khi `dev:pdf-layout` ghi token | Chạy `npm run dev:pdf-layout`, rồi khởi động lại `npm run dev`. Production: đặt cả hai secret |
| "Dịch vụ PDF giữ bố cục chưa sẵn sàng." | Worker gọi `/api/my/study/pdf-layout/config` hoặc `/font` lỗi: mở trang khi chưa đăng nhập, dịch vụ tắt, sai URL/cổng, token ở Worker khác token dịch vụ, vi phạm quy tắc HTTPS, thiếu tệp font | Đăng nhập ở `/#account` rồi tải lại `/study.html`; bật dịch vụ, kiểm `/health` có token; token phải giống hệt (sửa `.dev.vars` thì khởi động lại `npm run dev`); macOS đặt `PDF_FONT_PATH`; Linux cài `fonts-dejavu-core` |
| "Không kết nối được dịch vụ PDF giữ bố cục. Hãy kiểm tra dịch vụ (npm run dev:pdf-layout) rồi thử lại." (local) / "Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút…" (production) | Lỗi mạng/TLS: dịch vụ không chạy, đang tự khởi động lại, sai cổng, chứng chỉ không hợp lệ | Bật dịch vụ; cổng trong `.dev.vars` phải khớp; production: `docker compose ps`, chứng chỉ hợp lệ ở cổng 443 |
| "Dịch vụ PDF cần HTTPS." | URL `http://` với host khác `127.0.0.1`, `localhost`, `pdf-layout` | Dùng `https://` |
| "Unauthorized" | Token ở Worker và ở dịch vụ khác nhau | Đặt giống hệt; khởi động lại `wrangler dev` hoặc cập nhật secret |
| "Not found" | URL có thêm đường dẫn, hoặc trỏ sai host | Trỏ về gốc dịch vụ |
| "Dịch vụ PDF tạm thời không phản hồi đúng (mã N). Hãy thử lại sau." | Proxy trả nội dung không phải JSON: 502/504, 413 (body quá lớn), 524 (Cloudflare cắt sau 100 s) | Timeout proxy ≥ 300 s, body ≥ 45 MB, bỏ proxy cam; chọn ít trang hơn. Runbook mục A.7 có thêm các trường hợp của Caddy |
| "Dịch vụ PDF trả dữ liệu không hợp lệ." | Phản hồi 2xx không phải JSON, ví dụ trang đăng nhập của proxy | Sửa cấu hình proxy |
| "Máy chủ trả về phản hồi không đọc được (mã N)…" | Chính Worker trả HTML: `wrangler dev` đang nạp lại sau khi sửa code; trên production là crash hoặc vượt giới hạn tài nguyên (lỗi 1102) | Thử lại; production xem `npx wrangler tail`; nếu lặp lại với PDF lớn: Workers Paid và ít trang hơn |
| "Dịch vụ PDF đang bận. Hãy thử lại sau." | Đã có 2 việc đang chạy | Chờ, hoặc chạy thêm instance |
| "PDF giữ bố cục tối đa 25 MB." / "PDF giữ bố cục tối đa 100 MB (tệp trên 25 MB được dịch bằng chế độ Dịch cả quyển)." / "Dữ liệu PDF vượt giới hạn." | Tệp quá lớn cho cách dịch đã chọn | 25–100 MB: "Dịch cả quyển". Lớn hơn: tách PDF (một sách nhận nhiều tệp gốc), hoặc tắt giữ bố cục (tới 250 MB, xử lý trong trình duyệt) |
| "Mỗi lượt thử tối đa 20 trang để kiểm soát token…" / "Phạm vi trang phải nằm trong PDF, tối đa 20 trang mỗi lần." / "Mỗi lần tối đa 20 trang PDF." | Chọn quá 20 trang | Chia nhỏ phạm vi, hoặc dùng "Dịch cả quyển" |
| "Lượt này xử lý 12/20 trang đã chọn…" | Không phải lỗi: đã chạm ngân sách ảnh/payload của một lượt | Dịch phần còn lại ở lượt sau |
| "Trang N là bìa nên được giữ nguyên ảnh gốc…" | Phạm vi chỉ có trang bìa | Thêm trang nội dung, hoặc tích "Dịch chữ trên bìa" |
| "Tách PDF vượt thời gian cho phép…" / "Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt." | Quá 240 s (Python) hoặc 280 s (Worker) | Ít trang hơn, hoặc thêm CPU |
| "Kết quả tách PDF vượt giới hạn dung lượng của dịch vụ…" | Kết quả quá lớn | Ít trang hơn |
| "Dịch vụ PDF dừng đột ngột… (mã 0xC0000005…/tín hiệu SIGKILL, có thể do hết bộ nhớ)…" / "Không đủ bộ nhớ để xử lý các trang đã chọn…" | Hết RAM hoặc crash trong thư viện native | Ít trang hơn; tăng RAM (`PDF_LAYOUT_MEMORY`) |
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
| `[PDF] Cổng của dịch vụ PDF đang bận…` rồi `[PDF] đã dừng (mã 1)` (cửa sổ `start.cmd`/`npm start`) | Hoa Trí đang chạy ở một cửa sổ khác, hoặc còn một `npm run dev:pdf-layout` cũ | Đóng cửa sổ kia (hoặc bấm Ctrl+C ở đó), rồi bấm đúp `start.cmd` lại |
| "PDF có mật khẩu; hãy mở khóa trước khi dịch." · "Trang N quá lớn để render an toàn…" · "Tệp không phải PDF." · "Hãy dịch và lưu đủ các block trước khi xuất PDF." | Đúng như nội dung thông báo | Làm theo thông báo |

### 6.3 Build, Worker, D1, deploy

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Thiếu mô hình PaddleOCR. Chạy npm run prepare:ocr một lần trước khi build/dev." | Chưa tải mô hình | `npm run setup` hoặc `npm run prepare:ocr` (cần vào được bcebos.com), hoặc chép `det.tar`, `rec.tar`, `manifest.json` từ máy cũ |
| "Model …: HTTP N" / "…checksum khác phiên bản đã kiểm thử…" (lúc `prepare:ocr`) | Không tải được, hoặc tệp tải về khác bản đã kiểm | Kiểm tra mạng; dùng bản sao từ máy cũ |
| "Nguồn …: checksum khác phiên bản đã kiểm thử; không thay dữ liệu hiện tại…" / "Không tải được … Kiểm tra mạng, hoặc tải các tệp nguồn ở máy khác…" (lúc `prepare:dict`, bước 8) | Không tải được, hoặc nguồn từ điển đã đổi | Kiểm tra mạng; dùng `--from <thư mục>` (mục 3.1); nguồn đổi thật thì cập nhật `SOURCES` bằng `--print-hashes` |
| "Không ghi được …frontend\vendor\dict (EPERM): đóng Hoa Trí (start.cmd) rồi chạy lại." | Hoa Trí đang chạy và khóa thư mục | Tắt `start.cmd`/`npm run dev`, chạy lại `npm run prepare:dict` |
| Wrangler chạy ở cổng khác 8787 | Cổng bận, Wrangler tự lấy cổng kế tiếp | Dùng URL in ra; với Google OAuth thì giải phóng cổng hoặc `npm run dev -- --port <cổng>` |
| "Wrangler requires at least Node.js v22.0.0…" | Node cũ | Cài Node 22.13+ hoặc 24 |
| "Cần Node.js 22.13 trở lên (đang dùng v…)." (lúc `npm run setup`, `npm start`, `npm run deploy`) | Node 22.0–22.12 hoặc cũ hơn | Cài Node 22.13+ hoặc 24, mở cửa sổ mới, chạy lại |
| "Chưa cài thư viện. Chạy "npm ci" trước, rồi chạy lại "npm run setup"." / "Chưa cài đặt xong. Chạy "npm ci" rồi "npm run setup"…" (`npm start`) | Chưa chạy `npm ci`/`setup` | `npm ci` rồi `npm run setup` |
| `[ERROR] internal error; reference = …` (bước 7 của `setup`, `npm run db:local`, hoặc API cần D1 trả 400) · LỖI "Đường dẫn thư mục dự án quá dài cho Windows…" | Đường dẫn thư mục dự án quá dài (Windows giới hạn 260 ký tự), hoặc dự án nằm trên ổ `subst`/ổ mạng | Chuyển hoặc clone lại vào đường dẫn ngắn, ví dụ `C:\src\chinese-translator`, rồi chạy lại `npm run setup` |
| "running scripts is disabled on this system" | Execution policy của PowerShell | Dùng `npm.cmd` / `npx.cmd` |
| Lỗi deploy nhắc tới `database_id` vẫn là "local-db" | Chưa tạo D1 thật | Làm mục 5.3 |
| "Please enable R2 through the Cloudflare Dashboard" / "Account chưa bật R2…" | Chưa bật R2 | Bật R2 trong dashboard |
| "Trang công khai còn chỗ "[[CHƯA ĐIỀN…" chưa điền: …" | Chưa điền trang pháp lý | Mục 5.1 (`--allow-placeholders` chỉ để thử) |
| "GEMINI_MODEL vừa là var vừa là secret: chạy npx wrangler secret delete GEMINI_MODEL" | Secret cũ từ hướng dẫn trước | Chạy đúng lệnh đó |
| "ADMIN_TOKEN cần một chuỗi ngẫu nhiên mới, tối thiểu 32 ký tự…" / "Tệp secret phải nằm ngoài thư mục dự án…" / "Có N tệp thay đổi chưa commit…" | Tệp secret hoặc cây git chưa đạt | Làm theo thông báo |
| "Lần deploy đầu cần --secrets-file <tệp…>" | Worker chưa có trên Cloudflare | Thêm `-- --secrets-file <tệp>` (mục 5.3) |

### 6.4 Quản trị, tài khoản, Gemini

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Mã quản trị không đúng." / "Hãy mở Cài đặt và nhập mã quản trị để tiếp tục." | `ADMIN_TOKEN` sai hoặc chưa đặt | Đặt `ADMIN_TOKEN` (local: `.dev.vars` rồi khởi động lại; production: `secret put`) |
| "ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự nên trang quản trị đang khóa…" | Mã production dưới 32 ký tự | `npx wrangler secret put ADMIN_TOKEN` với chuỗi 64 hex; sau đó nhập lại khóa Gemini ở "Cài đặt" (khóa đó được mã hóa bằng `ADMIN_TOKEN`) |
| "Chưa cấu hình khóa Gemini API. Hãy mở Cài đặt để nhập khóa." / "Chưa cấu hình GEMINI_API_KEY trên máy chủ…" | Xưởng dịch admin chưa có khóa máy chủ | Đặt `GEMINI_API_KEY`, hoặc lưu khóa trong "Cài đặt" |
| "Không giải mã được khóa API đã lưu. Hãy nhập lại khóa trong Cài đặt." | `ADMIN_TOKEN` đã đổi sau khi lưu khóa | Nhập lại khóa |
| "Chưa có khóa Gemini…" / "Khóa Gemini API không hợp lệ. Hãy sao chép lại toàn bộ khóa." | Chưa dán khóa, hoặc độ dài khóa ngoài khoảng 20–500 ký tự | Dán đủ khóa; nhớ rằng tải lại trang là mất khóa |
| "Gemini từ chối yêu cầu (400): dữ liệu gửi đi không hợp lệ hoặc quá lớn…" | Yêu cầu quá lớn hoặc sai dạng (không phải lỗi khóa) | Chia nhỏ phần dịch. Lỗi khóa và lỗi khu vực báo thành `gemini_key` (mục 6.1); chưa kiểm chứng: lỗi khu vực ("User location is not supported") có thể chỉ gặp trên production do vị trí data-center của Worker |
| "Model Gemini “X” không khả dụng với khóa này…" | Model không mở cho project của khóa (họ 2.5 có thể 404) | `GEMINI_MODEL=gemini-3.6-flash`, để trống `GEMINI_PDF_BLOCK_MODEL`; người học dùng "Kiểm tra model của khóa" |
| "Kết quả đọc ảnh có mã đoạn lạ …" · "Kết quả đọc ảnh trả trùng đoạn …" · "Gemini không đọc được chữ ở N/M đoạn…" (bản trước 16/10/2026 chỉ báo "Kết quả đọc ảnh sai ID hoặc nội dung.") | Câu trả lời đọc ảnh của Gemini lệch với các đoạn đã gửi; lượt đó không được lưu (vẫn tốn token của lượt) | Bấm "Bắt đầu dịch →" lại: app chỉ đọc lại các đoạn chưa đọc xong. Nếu lặp lại ở cùng trang, ghi lại đúng câu báo (có mã đoạn) và trang đó để báo lỗi |
| "Hãy đăng nhập để dùng không gian dịch học tập." / "Phiên đăng nhập đã hết hạn…" | Chưa đăng nhập hoặc hết phiên | Đăng nhập ở `/#account` |
| "Email hoặc mật khẩu không đúng." / "Email này đã có tài khoản." / "Mật khẩu cần từ 8 đến 128 ký tự." | Tài khoản chỉ có trong D1 của môi trường đã tạo nó (local khác production) | Tạo tài khoản trên môi trường đang dùng |
| "Hãy nhập đúng chữ XÓA để xác nhận." / "Mật khẩu không đúng." / "Một tài liệu của bạn đang được xử lý. Hãy thử lại sau vài phút." (xóa tài khoản) | Gõ sai chữ xác nhận hay mật khẩu; việc admin đang chạy trên sách riêng | Gõ `XÓA` (hoặc `XOÁ`); thử lại sau vài phút |
| "Đăng nhập Google chưa được cấu hình trên máy chủ." | Thiếu một trong hai `GOOGLE_*` | Đặt cả hai |
| "Error 400: redirect_uri_mismatch" (trang của Google) | Callback chưa được đăng ký đúng | Đăng ký đúng `<origin>/api/auth/google/callback` |
| "Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn." | Bắt đầu ở `localhost` nhưng quay về `127.0.0.1` (hoặc ngược lại), hoặc quá 10 phút | Dùng một host, làm lại |
| "Google không thể xác nhận đăng nhập." | Sai client secret hoặc redirect URI | Kiểm tra lại cả hai |
| "Tài khoản Google cần có email đã xác minh." | Email Google chưa xác minh | Xác minh email trong tài khoản Google |

### 6.5 Dịch cả quyển, tải cả quyển, đọc song ngữ, tra chữ Hán

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "Quyển này đang được dịch ở một tab khác của trình duyệt…" | Tab khác đang chạy cùng quyển | Dùng tab đó, hoặc đóng nó rồi thử lại |
| "Tệp đang chọn không phải bản gốc của quyển đang dịch dở…" / "Bản gốc có N trang, khác M trang của lượt dịch này." | Chọn nhầm tệp | Chọn đúng tệp, hoặc bấm "Tiếp tục" ở quyển đó trong "Lịch sử dịch của tôi" |
| "Không mở được PDF để chia lượt dịch (…). Nếu PDF có mật khẩu, hãy mở khóa trước." | pdf-lib không đọc được tệp | Mở khóa PDF, hoặc lưu lại thành PDF mới |
| "Trang N nặng X MB, vượt giới hạn một lượt của dịch vụ PDF; trang này giữ nguyên bản gốc." | Một trang lớn hơn 16 MB | Trang đó thành "Lỗi" và giữ bản gốc; nén ảnh của PDF nếu cần dịch trang đó |
| "Không tải được công cụ ghép PDF. Hãy kiểm tra mạng rồi thử lại." | Thiếu `/vendor/pdf-lib.esm.min.js` hoặc `/vendor/pdf.mjs` (deploy mà không build) | `npm run deploy` (hoặc `npm run build` rồi `npx wrangler deploy`) |
| "Không ghép được cả quyển trên thiết bị này (có thể do thiếu bộ nhớ)…" | Thiết bị thiếu bộ nhớ | "Chỉ ghép các phần đã dịch", hoặc dùng máy tính |
| "Cần PDF gốc để ghép đủ bìa và các trang chưa dịch." | Phần cũ chưa có bản gốc trong tài khoản | "Chọn PDF gốc…". Nếu báo "“file” không khớp tệp gốc nào còn thiếu của sách." thì đã chọn nhầm tệp |
| Không thấy nút "Đọc song ngữ" | Phần văn bản, phần cũ không ghi số trang gốc, hoặc máy chủ không giữ bản gốc | Dịch lại phần đó ở chế độ giữ bố cục; sách công khai phải đăng kèm trang gốc (mục 4.6) |
| "Đọc song ngữ" báo lỗi tải bản gốc và nút "Thử lại" | Mạng chập chờn, hoặc bản gốc đã bị xóa | Bấm "Thử lại"; trang tiếng Việt vẫn đọc được |
| "Máy chủ này chưa có dữ liệu từ điển. Quản trị viên chạy “npm run prepare:dict”…" | Chưa dựng từ điển (bước 8 lỗi, hoặc deploy từ máy chưa chạy `prepare:dict`) | `npm run prepare:dict`; production: deploy lại sau đó |
| "Không tải được dữ liệu từ điển. Kiểm tra kết nối rồi bấm Thử lại." | Mạng | Bấm "Thử lại" |

## 7. Kiểm thử

```powershell
npm.cmd test    # = node --test backend/*.test.mjs
node --import ./backend/test-support/no-paid-api.mjs --test backend/*.test.mjs   # như CI: test nào lỡ gọi Gemini, Google hay Cloudflare thật sẽ đỏ ngay
```

- Ngày 19/10/2026 trên máy gốc: 472 test, 472 đạt. Không test nào gọi Gemini thật (đều giả lập). Test Python tạo `services/pdf-layout/__pycache__/`; test công cụ mẫu tạo rồi xóa `samples/zz-test-*` (đều đã ignore).
- Trên clone mới đã chạy `setup` (Windows, có Edge), test "Real scans…" luôn skip vì cần mẫu thật trong `tmp/pdf-layout/`. Các skip khác chỉ xuất hiện khi thiếu điều kiện trong bảng:

| Test | Cần | Nếu thiếu |
|---|---|---|
| 5 tệp chạy Python: `pdf-extract-inline`, `pdf-extract-objects`, `pdf-extract-robustness`, `pdf-extract-segmentation`, `pdf-ocr-sheets` | lệnh `python` (hoặc `PDF_PYTHON`) chạy được, `.runtime/pdf-python`, tessdata `chi_sim` + `eng` | skip: "needs Python with .runtime/pdf-python and chi_sim/eng tessdata (npm run prepare:pdf-ocr)" |
| `sample-tool` (test đầu-cuối của công cụ mẫu) | như trên, cộng Edge/Chromium | skip: "needs Python with .runtime/pdf-python, tessdata and Edge/Chromium (npm run setup)" |
| `book-ui` (2), `hanzi-ui` (3), `whole-book-ui` (3), `bilingual-ui` (3) | Microsoft Edge; `whole-book-ui` và `bilingual-ui` cần thêm `frontend/vendor` | skip: "Microsoft Edge is not available to playwright-core here" (hoặc câu nhắc `frontend/vendor`). CI xóa Edge nên các test này luôn skip trên CI |
| `cover-detect` (phần rasterise) | `@napi-rs/canvas` (`npm ci` tự cài) | skip: "pdf.js cannot rasterise here (@napi-rs/canvas is missing)" |
| `cover-detect` "Real scans…" | mẫu thật trong `tmp/pdf-layout/` (không có trong repo) | luôn skip trên clone mới: "real samples are not on this machine" |
| 11 tệp dùng D1 giả bằng `node:sqlite`: `study-history-sqlite`, `study-books`, `library-match`, `book-jobs`, `library-books`, `account-deletion`, `history-delete`, `rate-limit`, `registration-mode`, `sample-tool`, `subject-glossaries` | Node ≥ 22.13 | **không skip mà FAIL** |

- macOS/Linux: `export PDF_PYTHON=python3` trước `npm test`, nếu không 5 test Python bị skip.
- Chạy riêng một test Python (PowerShell):

```powershell
$env:PYTHONPATH="$PWD\.runtime\pdf-python"; $env:TESSDATA_PREFIX="$PWD\.runtime\tessdata"; $env:PYTHONUTF8="1"; python services/pdf-layout/test_segmentation.py
```

Các script khác (không nằm trong `npm test`):

| Lệnh | Cần | Gemini |
|---|---|---|
| `npm run deploy:check` | `npx wrangler login`, D1 thật trong `wrangler.jsonc` | không gọi; chỉ đọc Cloudflare, chạy `npm test` và `--dry-run` |
| `npm run samples -- <lệnh> <mã>` | `npm run setup`; xem `tools/samples/README.md` | không gọi (chặn mọi mạng trừ máy chủ đích) |
| `npm run test:layout-metrics -- --md` | dữ liệu chỉ có trên máy gốc (`tmp/pdf-layout/genre-fixtures/`, `samples/toan-a1/work/c01/`); khoảng 4 phút | không gọi; số đo trong `docs/layout-metrics.md` |
| `node services/pdf-layout/smoke.mjs <origin> [thư mục]` | dịch vụ PDF đang chạy; token trong biến môi trường `PDF_LAYOUT_SERVICE_TOKEN` | không gọi |
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
- **Chưa kiểm chứng trên Cloudflare thật:** giới hạn CPU/bộ nhớ của Workers (Worker băm tệp tải lên tới 25 MB, parse/stringify JSON `/extract` tới khoảng 33 MB và giải mã base64 PDF; gói Free chỉ 10 ms CPU; mọi gói 128 MB mỗi isolate; scan nặng 20 trang có thể gây lỗi 1102, cân nhắc `"limits": {"cpu_ms": …}`), giới hạn tốc độ (đếm theo từng vị trí Cloudflare), Workers Logs, kiểm checksum của R2 và việc stream bản gốc 100 MiB (trên `wrangler dev`: đỉnh 35 MB heap). `wrangler dev` không áp đúng giới hạn của production.
- **Dịch vụ PDF** không có hàng đợi, tối đa 2 việc cùng lúc, mỗi lần xuất mở một Chromium headless (`--no-sandbox` trong container); `/health` cũng cần token. Qua Caddy, PDF thô trên 25 MiB gửi thẳng tới dịch vụ đôi khi nhận 502 thay vì 422 (Worker đã chặn tệp trên 25 MB trước, nên người dùng không gặp).
- **Docker image chưa được build trên máy** (Docker daemon tắt): job `pdf-image` của CI là lần build đầu, cũng là lần đầu chạy `HEALTHCHECK`, user `node` và compose + Caddy qua HTTPS. Dữ liệu OCR trong image nay giống bản Windows (@tesseract.js-data 4.0.0_best_int), nhưng phông khác (DejaVu Serif so với Times New Roman), nên độ vừa ô trên Linux có thể khác (chưa đo). Font trên Linux/Docker và trình duyệt Safari chưa thử.
- **Trang tĩnh chưa có Content-Security-Policy** (chỉ phản hồi API có): bước kiểm tra sau deploy sẽ báo CẢNH BÁO.
- **PyMuPDF** có giấy phép kép AGPL-3.0 hoặc thương mại (Artifex). Chạy nó thành dịch vụ mạng có thể kéo theo nghĩa vụ AGPL; chủ dự án cần xem xét. Chân trang đã có liên kết mã nguồn.
- **Model Gemini:** `GEMINI_MODEL` mặc định `gemini-3.6-flash` trong `wrangler.jsonc`; để trống thì code dùng mặc định họ 2.5, có thể 404 với project mới, và xưởng dịch admin không tự đổi model. `GEMINI_QUALITY_MODEL` dùng cho hai việc (sửa lỗi của admin và chế độ "Đối chiếu kỹ").
- **Một `ADMIN_TOKEN` chung**: không có tài khoản admin riêng, không có nhật ký. Đổi token thì khóa Gemini đã lưu ở "Cài đặt" không giải mã được nữa.
- **Tệp lớn:** "Dịch theo phạm vi" nhận tối đa 25 MB; "Dịch cả quyển" tới 100 MiB; lớn hơn phải tách tệp, mỗi tệp tách đánh số trang lại từ 1 và người học tự sắp xếp các phần. Gói Free/Pro của Cloudflare cắt thân yêu cầu ở 100 MB ngay ở edge, nên tệp sát 100 MiB có thể bị từ chối trước khi tới Worker (chưa kiểm chứng).
- **Chưa có việc dọn định kỳ:** bản gốc đã tải lên mà không còn lượt dịch hay phần nào dùng (ví dụ tải lên xong rồi bỏ) nằm trong R2 tới khi xóa tài khoản, tới 100 MiB mỗi tệp. Tệp của yêu cầu dịch và việc của admin chưa được kiểm "magic bytes".
- **Lịch sử cũ** (trước migration `0014`) không ghi `pdf_asset_id`: xóa một mục như vậy có thể xóa luôn bản gốc dùng chung, khi đó "Tải cả quyển" hỏi lại tệp gốc (bản dịch không mất).
- **Đăng nhập:** email không tồn tại trả lời nhanh hơn mật khẩu sai (không chạy PBKDF2). Lỗi đăng nhập Google hiện trang JSON thô. Đổi `TERMS_VERSION` chỉ ghi phiên bản mới cho tài khoản tạo sau đó và tài khoản Google khi đăng nhập lại; tài khoản mật khẩu cũ chưa bị hỏi đồng ý lại.
- **Dữ liệu local không lên production** (tài khoản, lịch sử, sách, tệp R2 trong `.wrangler/state`). Không có script chuyển; muốn chuyển phải tự xuất D1 (`npx wrangler d1 export DB --local --output local.sql`, rồi nhập bằng `npx wrangler d1 execute DB --remote --file local.sql`; chưa thử, có thể trùng bảng với migration đã áp) và chép tệp R2 bằng tay.
- Mô hình PaddleOCR tải từ Baidu BOS, nguồn từ điển từ Debian salsa, GitHub và unicode.org. Checksum chặn tệp bị thay, nhưng nếu URL mất thì `prepare:ocr`/`prepare:dict` hỏng; nên giữ một bản `det.tar`/`rec.tar` và thư mục `.runtime/dict-sources` ở ngoài git.

**Pháp lý và quyết định của chủ dự án**

- **Tuổi dùng Gemini API:** điều khoản bổ sung của Gemini API (bản sửa 28/4/2026) yêu cầu người dùng từ 18 tuổi, và cấm dùng trong dịch vụ hướng tới hoặc có khả năng được người dưới 18 tuổi dùng. Hoa Trí nhắm học sinh THPT tự dán khóa. Trang pháp lý ghi đúng điều kiện 18+, nhưng mô hình sản phẩm mâu thuẫn với điều khoản đó: cần chủ dự án và tư vấn pháp lý (ví dụ khóa do giáo viên hoặc nhà trường giữ).
- **Trang điều khoản và quyền riêng tư** là bản mẫu cẩn thận, chưa được luật sư xem. Luật Bảo vệ dữ liệu cá nhân (hiệu lực từ 1/1/2026) có thể đòi thêm (thông báo xử lý, đánh giá tác động, hồ sơ chuyển dữ liệu ra nước ngoài). Trang đã nói dữ liệu được chuyển ra nước ngoài (Google, Cloudflare, Hoa Kỳ).
- **Từ điển:** hiện nghĩa tiếng Việt của CVDICT (phần lớn dịch máy, có nhãn "dịch máy", luôn kèm nghĩa tiếng Anh); hanviet-pinyin-wordlist có giấy phép MIT nhưng được biên soạn có tham khảo từ điển có bản quyền; tra khi chạm bật mặc định.
- **Sách mẫu:** `samples/` trên máy gốc có sách giáo khoa thương mại; chỉ dùng chúng với `"rights": {"localOnly": true}` và không đăng lên site công khai.
- **Thuật ngữ khoa học** (khoảng 440 thuật ngữ, nhất là dạng Đài Loan) nên được giáo viên rà. Hóa học dùng tên theo GDPT 2018 (acid, base, ethanol), không dùng axit, bazơ; chính tả "i" theo SGK (chu kì, kí tự, điện li) nhưng giữ "định lý" như bảng thuật ngữ có sẵn.
- Sách "Ví dụ mẫu" luôn đứng đầu thư viện; trang chủ vẫn mang giọng sử học ("Đọc sử liệu, hiểu Trung Hoa") dù sách thuộc mọi môn.

**Dịch cả quyển**

- Chạy trong tab trình duyệt: đóng tab là dừng (tiến độ đã lưu). Hai tab của cùng trình duyệt không chạy cùng một quyển, nhưng hai thiết bị thì có thể (máy chủ chưa giữ khóa lượt dịch): khi đó cùng trang bị tách và trả token hai lần.
- Chưa thử trên điện thoại thật (chỉ Edge giả lập màn hình 390 px): bộ nhớ khi băm và cắt sách 100 MB (pdf-lib giữ cả tệp trong bộ nhớ), giữ sáng màn hình, tab nền. Mở dev server qua HTTP bằng IP mạng LAN thì trình duyệt không có `crypto.subtle`, app băm SHA-256 bằng JS khoảng 16 MB/s trên PC, chậm hơn trên điện thoại.
- Tiến độ ghi theo lượt (tối đa 20 trang): dừng giữa lượt thì lưới trang và "Đã dịch X/Y" chậm hơn thực tế (trang đã lưu không bị trả token lại). Trang trống chỉ biết sau khi tách trang, nên ước tính cho sách scan nhiều trang trắng cao hơn thực tế.
- Số trang của bản gốc do trình duyệt báo (`X-PDF-Pages`), máy chủ không tự đếm tệp 100 MiB. Giờ đặt lại hạn mức ngày được tính (nửa đêm giờ Thái Bình Dương) khi Google không gửi, nên ngày đổi giờ mùa hè có thể lệch 1 giờ. Bảng thuật ngữ của quyển giữ cách dịch đầu tiên của mỗi thuật ngữ và ngừng học thêm khi đủ 2.000 thuật ngữ hoặc 256 KB.
- Chưa đo token và thời gian thật của cả quyển.

**Đọc song ngữ và tra chữ Hán**

- Chạm để tra trên trang gốc chỉ được khi PDF gốc có lớp chữ thật; với bản scan dùng nút 字 và ô tìm. "Đọc song ngữ" nhớ bật/tắt trong phiên (không lưu): mở sách khác sẽ ở chế độ đó và tải bản gốc của sách ấy.
- Chỉ thử trên Edge (Chromium); iOS Safari và Android chưa thử. Trên điện thoại, bảng tra có thể che vùng vừa chạm.
- Tách từ theo kinh nghiệm (không có dữ liệu tần suất); hơn 6.000 mục CC-CEDICT chưa có nghĩa tiếng Việt; âm Hán Việt phủ 99,20% âm tiết, phần còn lại hiện "—".
- Tệp thiếu trong `/vendor/dict/v/<id>/` được trả bằng `index.html` kèm header cache 1 năm (do cách site trả trang cho đường dẫn lạ); trình tải tự kiểm lại, nhưng sửa tận gốc phải loại `/vendor/*` khỏi chế độ đó.

**Chất lượng dịch và dàn trang** (số đo đầy đủ: `docs/layout-metrics.md`)

- Trên 3 trang scan thật của sách Toán, toàn bộ phần không phải chữ (hình, khung, đường kẻ) giữ nguyên, chỉ lệch nhiễu nén ảnh; 98,9% chữ Việt nằm đúng khung đoạn gốc, không đoạn nào tràn. Tiêu đề chương và chân trang (36 chữ Hán) chưa được dịch. 8/14 đoạn văn giữ ≥85% cỡ chữ in; 3 đoạn nhỏ hơn rõ, khoảng 80%. Trên 7 trang mẫu của 6 thể loại có đáp án chuẩn, với bản dịch thử dài 1 chữ Việt cho mỗi chữ Hán, 99,5% diện tích chữ Trung được thay, 0 đoạn tràn, 84% đoạn giữ ≥85% cỡ chữ gốc (thân bài 33/35).
- Scan độ phân giải thấp: bộ tách ước cỡ chữ thấp (trang 94 dpi: ước 10,5pt, chữ in khoảng 13pt), nên chữ Việt nhỏ hơn khoảng 20% mà báo cáo dựng không báo co chữ. Ô bảng và dòng đầu trang co chữ nhiều nhất.
- Chữ Trung nằm ngoài mọi block (tiêu đề chương giữ làm vùng ảnh, chân trang, ô bảng "1949年") giữ nguyên mà không có cảnh báo; chữ Hán trong ảnh công thức (ví dụ "时") cũng giữ nguyên; khung chữ có thể che mất biểu tượng nhỏ cạnh tiêu đề.
- Chưa đo: chất lượng bản dịch qua Gemini thật (mẫu thật do Claude dịch), PDF có lớp chữ, phông máy chủ (DejaVu Serif), bố cục hai cột, chữ dọc, trang nghiêng, nền màu, đọc trên điện thoại, thời gian tiết kiệm và chi phí token.
- Xuất lại chỉ sửa phần dàn trang. Lỗi trong bản tách trang cũ (ví dụ mất "OE/OA = O", mất tử số, đoạn chữ Hán chưa dịch như 由向量共面…/所以/证明：/数量积, "= =x(...)", mũi tên và dấu chấm thừa) chỉ hết khi dịch lại các trang đó (tốn token). Trên trang thử, xuất lại còn để một khoảng trống lớn phía trên bài tập 4.
- Nhãn xám mờ "证明：" vẫn giữ tiếng Trung, kể cả với bộ tách mới.
- Công thức do Gemini gõ lại có thể sai (không nhận √, a²+b² bị đọc thành chữ Hán, E_k=½mv² bị cắt); công thức Cl₂ nằm ngoài mọi block.
- Phân đoạn: còn 6 block lẫn vai trò và 14 block gộp nhiều đoạn; trang bài tập và thơ in nghiêng kém hơn bản cũ ở cả hai chỉ số này.
- Trang có giãn dòng rộng (khoảng 1,7 lần cỡ chữ trở lên) có thể bị tách mỗi dòng thành một block: câu bị cắt giữa từ khi dịch và dòng đầu của đoạn bị in chữ rất nhỏ. Gặp khi kiểm thử bàn giao với trang tổng hợp chữ 14 pt, giãn dòng 24 pt; giãn 21 pt trở xuống thì gộp đúng đoạn.
- Chữ dọc: cả trang thành một khối, thứ tự đọc chỉ đúng 5%; chưa thử với Gemini thật.
- Chữ trong hình vẽ vẫn là tiếng Trung; nhãn chú thích được dịch làm thay đổi 1,2% điểm ảnh của hình; tiêu đề màu in ra gần như đen.
- Đoạn mà Gemini đọc ra trống (thường là hình hoặc ký hiệu bị nhận nhầm là đoạn văn) giữ chữ OCR máy (Tesseract, có thể sai) hoặc `[□]`, kèm cảnh báo "Gemini không đọc được chữ ở đoạn …" dưới nút dịch; hãy kiểm tra và sửa đoạn đó bằng "Chỉnh bản dịch từng đoạn".
- Renderer: hằng số trục công thức (0,38 em) được chỉnh trên sách giáo khoa tiếng Trung; `prepareLayout` chưa có unit test; LaTeX trần trong bản dịch sẽ bị vẽ thành công thức khi xuất.

**Hiệu năng và token**

- Tờ OCR ghép mới chỉ được kiểm bằng Gemini thật trên 1 trang. Trong 2 lần gọi giống hệt nhau, có 1 lần Gemini lặp "&&&" tới giới hạn và tốn 6.242 token. Đầu ra OCR nay đã bị giới hạn, nhưng lượt lỗi vẫn tốn token và phải chạy lại. Token của bước dịch chưa được đo lại.
- Bộ đếm "token Gemini trong tab này" và tổng token của mỗi quyển nay cộng cả token của lượt gọi lỗi mà máy chủ báo về (JSON hỏng rồi thử lại, dừng vì MAX_TOKENS/SAFETY, phần đã dịch trước khi lỗi). Riêng ở chế độ giữ bố cục, câu trả lời Gemini bị chính Hoa Trí từ chối khi kiểm tra (đọc ảnh trả mã đoạn lạ, bản dịch block thiếu ký hiệu…) vẫn chưa được cộng. Số chính xác xem trong Google AI Studio.
- Tách trang chậm hơn bản cũ 12–54% (trang thử: 14,8 s so với 9,6 s). Chọn 20 trang vẫn chỉ xử lý khoảng 12 trang mỗi lượt (bản cũ 13).
- Bộ nhớ khi ghép cả quyển dày trên điện thoại chưa đo.
- Giới hạn của phép đo: trang thử tổng hợp sạch hơn scan thật, trang thật không có đáp án chuẩn, cỡ chữ được đo bằng chữ Việt giả.

## 9. Bảo mật

- **`.dev.vars`** đã có trong `.gitignore`: không commit, không gửi qua chat hay email. Mỗi người tự tạo từ `.dev.vars.example`. Bản `.dev.vars` trên máy cũ chứa khóa Gemini cá nhân của chủ dự án; không bàn giao tệp đó.
- **Repo GitHub công khai**: mọi thứ push lên ai cũng đọc được. Không commit `.dev.vars`, `.env`, `.wrangler/`, `.runtime/`, `tmp/`, `output/`, `samples/`, PDF sách hay ảnh chụp trang. CI báo đỏ khi một commit có tệp bí mật, khóa Google, khóa riêng tư hay thư mục dữ liệu local.
- **Khóa Gemini của người học**: mỗi người dùng khóa riêng tạo ở Google AI Studio. Khóa chỉ nằm trong bộ nhớ tab (không lưu vào localStorage, kể cả khi "Dịch cả quyển"), được gửi kèm từng yêu cầu tới Worker; Worker dùng nó gọi Gemini và không lưu lại. Thông báo lỗi của Google không được hiện nguyên văn vì có thể chứa khóa.
- **Khóa Gemini máy chủ** (`GEMINI_API_KEY`) chỉ dùng cho xưởng dịch admin. Nếu lưu qua "Cài đặt", khóa được mã hóa AES-GCM (khóa mã hóa là SHA-256 của `ADMIN_TOKEN`), cất ở R2 `private/config/gemini-api-key.json` và không bao giờ được gửi lại trình duyệt.
- **`ADMIN_TOKEN`**: chuỗi ngẫu nhiên dài (64 hex), local và production khác nhau. Ngoài `127.0.0.1`/`localhost`, mã dưới 32 ký tự bị từ chối. Ai có token là admin, và không có nhật ký. Trình duyệt chỉ giữ token trong tab. Đổi token thì nhập lại khóa Gemini ở "Cài đặt".
- **`PDF_LAYOUT_SERVICE_TOKEN`**: tối thiểu 24 ký tự (nên 64 hex), giống nhau ở Worker và dịch vụ, trình duyệt không thấy. Container chạy bằng user `node`, bỏ mọi capability, nhưng Chromium vẫn chạy `--no-sandbox` nên token càng phải giữ kín; khi đổi thì đổi cả hai phía cùng lúc (runbook mục A.5). Caddy ghi header `Authorization` thành `REDACTED`.
- **`.wrangler/`** là D1/R2 local: tài khoản, lịch sử, sách đã tải lên, khóa dashboard đã mã hóa. Thư mục này nằm trong `.gitignore`; không chép cho người khác; xóa là mất dữ liệu local.
- **Mật khẩu người dùng** được băm bằng PBKDF2-SHA256 100.000 vòng (tài khoản tạo trước 16/10/2026: 210.000 vòng). Cookie phiên `cat_hien_session` là HttpOnly, SameSite=Lax, sống 30 ngày, có cờ Secure khi chạy https; máy chủ chỉ giữ SHA-256 của nó.
- **Phản hồi API**: mọi phản hồi `/api/…` có header bảo mật (nosniff, X-Frame-Options, Referrer-Policy, CSP cho JSON); yêu cầu thay đổi dữ liệu từ site khác bị từ chối (`origin`); kích thước thân yêu cầu bị giới hạn trước khi đọc. Lỗi nội bộ chỉ trả mã `ray`; log là một dòng JSON không có header, nội dung hay biến môi trường, và Workers Logs bỏ query string của URL.
- **Xóa dữ liệu**: xóa tài khoản xóa hàng D1 và tệp R2 riêng của người đó; D1 Time Travel vẫn khôi phục được hàng đã xóa trong thời hạn lưu (tối đa 30 ngày với Workers Paid). IP dùng để đếm hạn mức đăng ký nằm trong bảng `rate_limits` khoảng một ngày.
- Kết quả quét trước bàn giao (các commit đã push: 70a3135, cb25216 và các commit của nhánh này): không có giá trị nào của `.dev.vars`, không có tệp PDF sách hay dữ liệu dịch; `git grep -E "AIza[0-9A-Za-z_-]{35}" <commit>` không ra kết quả. Ngoài tài liệu này, chuỗi "AIza" chỉ có trong khóa giả của các test và trong mẫu dò khóa (`backend/deploy.mjs`, `.github/workflows/ci.yml`).

---

Tài liệu khác trong repo: `deploy/pdf-layout/README.md` (runbook deploy), `tools/samples/README.md` (ví dụ mẫu), `docs/layout-metrics.md` (số đo bố cục), `docs/pdf-layout-pipeline.md`, `docs/local-ocr-layout.md`.
