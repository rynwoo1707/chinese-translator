# Triển khai Hoa Trí: dịch vụ PDF và Worker

Tài liệu này gồm hai phần:

- **A.** Dịch vụ PDF giữ bố cục chạy trên máy chủ riêng, bằng Docker và Caddy (HTTPS tự động). Các tệp nằm trong thư mục này.
- **B.** Deploy Worker lên Cloudflare bằng `npm run deploy`. Lệnh này kiểm tra mọi thứ trước, rồi mới thay đổi production.

```
Trình duyệt ──HTTPS──> Worker (Cloudflare: D1, R2, frontend/)
                          │  HTTPS + Authorization: Bearer <PDF_LAYOUT_SERVICE_TOKEN>, chờ tối đa 280 s
                          ▼
              Caddy :443 (chứng chỉ tự động) ──> container pdf-layout :8091 (không mở ra ngoài)
```

Trình duyệt không bao giờ gọi thẳng dịch vụ PDF và không thấy token. Không lệnh nào ở đây gọi Gemini.

## A. Dịch vụ PDF (Docker + Caddy)

### A.1 Cần chuẩn bị

- **Máy chủ Linux** (Ubuntu 24.04 hoặc Debian 12) có Docker Engine và plugin compose (`docker compose version` chạy được).
  - Cấu hình khởi điểm (ước tính, chưa đo trên Linux): 2 vCPU, 4 GB RAM.
  - Mỗi tiến trình chạy tối đa 2 việc cùng lúc; mỗi lần xuất PDF mở một Chromium.
- **Tên miền** cho dịch vụ, ví dụ `pdf.example.com`. Tạo bản ghi A (và AAAA nếu máy chủ có IPv6) trỏ về IP máy chủ.
  - Nếu DNS ở Cloudflare: chọn **DNS only** (mây xám). Proxy cam hoặc Cloudflare Tunnel cắt mọi yêu cầu sau 100 s (lỗi 524), trong khi một lượt có thể cần 240–280 s.
- **Tường lửa** chỉ mở 22, 80 và 443/TCP. Cổng 80 cần cho việc cấp chứng chỉ và chuyển hướng sang HTTPS.
- **Một token mới**, dùng chung cho dịch vụ và Worker: `openssl rand -hex 32`. Cất trong trình quản lý mật khẩu, khác bản local.
- **Giấy phép:** PyMuPDF dùng AGPL-3.0. Chạy nó thành dịch vụ mạng có thể kéo theo nghĩa vụ AGPL (ONBOARDING mục 8). Chủ dự án quyết định trước khi mở dịch vụ.

### A.2 Cài lần đầu

```bash
git clone https://github.com/rynwoo1707/chinese-translator.git hoa-tri   # thêm -b <nhánh> nếu không deploy từ main
cd hoa-tri/deploy/pdf-layout
cp env.example .env && chmod 600 .env
nano .env                      # điền PDF_DOMAIN, ACME_EMAIL, PDF_LAYOUT_SERVICE_TOKEN
docker compose up -d --build   # lần đầu build image mất vài phút
docker compose ps              # pdf-layout: healthy; caddy: Up
docker compose logs -f caddy   # chờ dòng "certificate obtained successfully", rồi Ctrl+C
```

- Thiếu một giá trị trong `.env` thì `docker compose` dừng ngay và báo bằng tiếng Việt tên biến cần đặt.
- `.env` đã nằm trong `.gitignore`. Không commit tệp này, không gửi qua chat hay email.
- Caddy chỉ khởi động sau khi `pdf-layout` báo healthy. Image tự kiểm tra `/health` (kèm token) mỗi 15 giây, nên lần đầu mất khoảng 15 giây.

### A.3 Kiểm tra dịch vụ

```bash
curl -s https://pdf.example.com/health        # {"error":"Unauthorized"}: dịch vụ đòi token
docker compose exec pdf-layout node services/pdf-layout/smoke.mjs http://127.0.0.1:8091 /tmp/smoke
```

Bước smoke chạy bên trong container, bằng token có sẵn trong môi trường của container, và không gọi Gemini. Nó kiểm tra:

- `/health` trả 401 khi thiếu token và 200 khi có token; `/font` trả lời.
- Một PDF mẫu 2 trang được tạo bằng `fixture.py`, rồi tách trang và xuất lại bằng bản dịch thử.
- `verify.py` kiểm kích thước trang, chữ Việt và hình vẽ vector giữ nguyên.
- OCR đọc được chữ Hán trên một trang scan.

Kết quả đúng kết thúc bằng `Dịch vụ PDF đạt kiểm thử (không gọi Gemini).`

Thử qua đúng đường HTTPS và Caddy, từ máy Windows đã chạy `npm run setup`. Script dùng Python mà setup ghi vào `.dev.vars` (dòng `PDF_PYTHON`, nếu có), không thì dùng `python`; nó không đọc dòng nào khác của `.dev.vars`.

```powershell
$env:PDF_LAYOUT_SERVICE_TOKEN = "<token>"
node services/pdf-layout/smoke.mjs https://pdf.example.com
Remove-Item Env:PDF_LAYOUT_SERVICE_TOKEN
```

Token đọc từ biến môi trường, không đặt trên dòng lệnh, để không lưu vào lịch sử shell. Kết quả nằm trong `tmp/pdf-smoke/` (đã ignore).

### A.4 Nối với Worker

Đặt hai secret cho Worker. Cách đặt nằm ở phần B (`--secrets-file`, hoặc `npx wrangler secret put <tên>`).

- `PDF_LAYOUT_SERVICE_URL=https://pdf.example.com`: chỉ phần gốc, không thêm đường dẫn.
- `PDF_LAYOUT_SERVICE_TOKEN`: giống hệt giá trị trong `.env`.

Sau khi deploy, `https://<Worker>/api/health` phải có `"pdfLayout":"configured"`.

### A.5 Cập nhật

```bash
cd hoa-tri && git pull
cd deploy/pdf-layout && docker compose up -d --build && docker image prune -f
```

- Build lại khi một trong các tệp sau thay đổi: `services/pdf-layout/`, `package.json`, `package-lock.json`, `frontend/pdf-box-layout.js`, `frontend/math-text.js`.
- Lúc container khởi động lại, các lượt đang chạy sẽ lỗi; người dùng chỉ cần bấm dịch lại.
- **Thứ tự cập nhật:** deploy Worker (phần B) trước hoặc cùng lúc với dịch vụ PDF. Hai bên dùng chung bộ kiểm tra tài liệu (`frontend/pdf-box-layout.js`); dịch vụ mới chạy với Worker cũ có thể khiến mọi trang scan báo "Ảnh trang PDF không hợp lệ.".
- **Cập nhật Caddy:** đổi tag `caddy:2.11.7-alpine` trong `docker-compose.yml` (đọc ghi chú phát hành của Caddy trước), rồi chạy `docker compose up -d caddy`.
- **Cập nhật Node trong image:** image dùng đúng bản `node:22.23.3-bookworm-slim`, nên build lại vài tháng sau vẫn ra đúng môi trường CI đã thử. Muốn lên bản mới, sửa dòng `FROM` trong `services/pdf-layout/Dockerfile`, đợi CI xanh, rồi build lại.

**Đổi token:**

1. Sửa `.env`, rồi chạy `docker compose up -d` (container `pdf-layout` được tạo lại).
2. Ngay sau đó chạy `npx wrangler secret put PDF_LAYOUT_SERVICE_TOKEN` với cùng giá trị.

Giữa hai bước, các thao tác PDF báo "Unauthorized".

### A.6 Giới hạn và cách cấu hình

| Mục | Giá trị |
|---|---|
| Thời gian | Caddy chờ phản hồi tối đa 300 s; Worker chờ 280 s; Python dừng ở 240 s |
| Kích thước | Caddy nhận thân yêu cầu tới 48 MB. Dịch vụ tự giới hạn PDF 25 MiB và JSON 40 MiB, kèm thông báo rõ ràng |
| Đồng thời | 2 việc mỗi container; việc thứ ba nhận "Dịch vụ PDF đang bận. Hãy thử lại sau." |
| Tài nguyên | Mặc định 2 CPU và 3g RAM. Đổi bằng `PDF_LAYOUT_CPUS` và `PDF_LAYOUT_MEMORY` trong `.env`; máy 1 CPU phải đặt `PDF_LAYOUT_CPUS=1` |
| Bảo mật | Container chạy bằng user `node`, bỏ mọi capability, `no-new-privileges`. Chromium vẫn cần `--no-sandbox` trong container. Chỉ Caddy mở cổng ra ngoài |
| Sức khỏe | `HEALTHCHECK` của image gọi `/health` kèm token mỗi 15 giây; `docker compose ps` hiện `healthy` |
| Nhật ký | `docker compose logs --tail 200 pdf-layout` hoặc `caddy`. Mỗi dịch vụ giữ tối đa 3 tệp 10 MB. Caddy ghi `Authorization` thành `REDACTED` |
| OCR | Cùng dữ liệu `chi_sim` và `eng` (@tesseract.js-data 4.0.0_best_int) với `npm test` và bản Windows |
| Phông chữ | Trong Docker là DejaVu Serif; trên Windows là Times New Roman, nên độ vừa ô có thể khác (chưa so trên tài liệu thật) |

Đã có reverse proxy khác (ví dụ nginx)? Chỉ chạy dịch vụ: `docker compose up -d pdf-layout`. Thêm `docker-compose.override.yml` mở `127.0.0.1:8091:8091` cho dịch vụ đó, và giữ đúng các giới hạn ở trên: timeout ≥ 300 s, thân yêu cầu ≥ 45 MB, không giữ kết nối keep-alive tới dịch vụ.

### A.7 Sự cố thường gặp

| Hiện tượng | Nguyên nhân | Cách sửa |
|---|---|---|
| Caddy báo `challenge failed`, `NXDOMAIN` hoặc không lấy được chứng chỉ | DNS chưa trỏ đúng; bản ghi đang bật proxy cam; cổng 80/443 bị chặn | Sửa DNS (DNS only), mở cổng, rồi `docker compose restart caddy` |
| Worker báo "…không phản hồi đúng (mã 524)" | Bản ghi DNS đang qua proxy Cloudflare | Chuyển sang DNS only |
| Worker báo "…(mã 502)" | Container `pdf-layout` không chạy hoặc đang khởi động lại | `docker compose ps`, rồi `docker compose logs pdf-layout` |
| "Unauthorized" | Token ở `.env` khác secret của Worker | Đặt giống hệt ở cả hai nơi (mục A.5) |
| "Not found" | `PDF_LAYOUT_SERVICE_URL` có thêm đường dẫn | Chỉ dùng gốc `https://pdf.example.com` |
| `pdf-layout` khởi động lại liên tục, nhật ký có "Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự." | Token quá ngắn | Sinh lại bằng `openssl rand -hex 32` |
| `range of CPUs is from 0.01 to 1.00` | Máy chủ chỉ có 1 CPU | Đặt `PDF_LAYOUT_CPUS=1` trong `.env` |
| `pdf-layout` unhealthy, nhật ký có `Killed` hoặc `SIGKILL` | Thiếu RAM | Tăng `PDF_LAYOUT_MEMORY`, hoặc chọn ít trang hơn mỗi lượt |
| `docker compose up` báo `dependency failed to start` và Caddy không chạy | `pdf-layout` chưa healthy | `docker compose logs pdf-layout`: thường là token quá ngắn hoặc thiếu RAM (hai dòng trên) |

## B. Deploy Worker bằng `npm run deploy`

### B.1 Chuẩn bị một lần

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create muc-viet --binding DB --location apac --update-config
npx.cmd wrangler r2 bucket create muc-viet-files --location apac
```

- `d1 create` ghi UUID thật vào `database_id` trong `wrangler.jsonc` và giữ `"preview_database_id": "local-db"`, nên dev local vẫn mở D1 cũ. UUID này không bí mật: commit thay đổi đó.
- **Không** đổi `bucket_name`: dữ liệu R2 local gắn với tên bucket.
- Muốn Worker tên khác `muc-viet-cms` (ví dụ `hoa-tri`)? Đổi `"name"` trước lần deploy đầu. Đổi về sau là đổi URL, callback Google và phải đặt lại secret.
- Nên dùng gói Workers Paid. Gói Free chỉ cho 10 ms CPU, không đủ cho đăng nhập (PBKDF2) và PDF lớn.
- Gắn tên miền riêng (Workers → Settings → Domains & Routes) **trước** lần chia sẻ link đầu tiên: thẻ xem trước khi dán link vào Zalo/Facebook và địa chỉ canonical lấy theo tên miền mà người dùng mở, nên link `*.workers.dev` sẽ hiện tên đó. Sau khi tên miền chạy ổn, đặt `"workers_dev": false` để không còn bản trùng (xem ONBOARDING).
- Muốn có nút "Tra chữ Hán" trên production thì chạy `npm run prepare:dict` một lần trước khi deploy. Dữ liệu nằm trong `frontend/vendor/dict` và không commit. Thiếu dữ liệu này, script chỉ cảnh báo chứ không dừng.

**Tệp secret** dạng `TÊN=giá trị`, đặt **ngoài** thư mục dự án, ví dụ `C:\Users\<bạn>\hoa-tri-secrets\production.env`:

```
ADMIN_TOKEN=<64 hex mới, khác bản local>
PDF_LAYOUT_SERVICE_URL=https://pdf.example.com
PDF_LAYOUT_SERVICE_TOKEN=<giống hệt .env của dịch vụ PDF>
# Tùy chọn: GEMINI_API_KEY (chỉ cho xưởng dịch admin), GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET (đặt đủ cả hai)
```

- Script từ chối các trường hợp sau:
  - tệp nằm trong repo, hoặc tên tệp bắt đầu bằng `.dev.vars`;
  - `ADMIN_TOKEN` dưới 32 ký tự, `PDF_LAYOUT_SERVICE_TOKEN` dưới 24 ký tự;
  - URL dịch vụ PDF không phải gốc `https://` công khai;
  - dấu `#` dính vào giá trị mà không có ngoặc kép (wrangler sẽ cắt mất phần sau dấu `#`).
- Tên model (`GEMINI_MODEL`…) và `REGISTRATION_MODE` **không** phải secret. Chúng nằm trong khối `"vars"` của `wrangler.jsonc`: sửa ở đó rồi deploy lại.
- Một tên vừa là var vừa là secret thì script dừng. Xóa secret đó bằng `npx wrangler secret delete <tên>`.

### B.2 Kiểm tra rồi deploy

```powershell
npm.cmd run deploy:check                                                  # chỉ kiểm tra, không thay đổi gì trên Cloudflare
npm.cmd run deploy -- --secrets-file C:\Users\<bạn>\hoa-tri-secrets\production.env   # lần đầu
npm.cmd run deploy                                                        # các lần sau (secret đã có trên Cloudflare)
```

Script chạy theo thứ tự sau và dừng ở bước đầu tiên không đạt:

1. **Trên máy:**
   - Node ≥ 22.13 và git không có thay đổi chưa commit.
   - `wrangler.jsonc` hợp lệ: UUID thật, không có khối `secrets`, không có var mang tên bí mật. Script cũng cảnh báo khi `REGISTRATION_MODE` sai chính tả hoặc là `domain` mà `ALLOWED_EMAIL_DOMAINS` trống, vì khi đó không ai tạo được tài khoản.
   - Các trang công khai không còn chỗ `[[CHƯA ĐIỀN`.
   - Tệp secret hợp lệ.
2. **Cloudflare, chỉ đọc:** đã đăng nhập (máy có nhiều account thì đặt `CLOUDFLARE_ACCOUNT_ID`), có bucket R2, đủ secret (`ADMIN_TOKEN` bắt buộc; cặp PDF và cặp Google phải đi cùng nhau), và phiên bản đang chạy để quay lại nếu cần.
3. **Build:** `frontend/vendor` (cần mô hình PaddleOCR từ `npm run prepare:ocr`), `npm test` (chặn mọi lệnh gọi Gemini, Google, Cloudflare), rồi `wrangler deploy --dry-run`.
4. **Migration D1:** liệt kê các migration chờ, in lệnh khôi phục Time Travel, rồi hỏi `Gõ CÓ để tiếp tục:`. Nếu D1 có migration lạ (code cũ hơn production), script dừng.
5. **Deploy:** `wrangler deploy --strict`, gắn tag là mã commit.
6. **Kiểm tra bản mới:**
   - `/api/health` báo đúng commit.
   - Các tệp `/vendor/` là tệp thật, không phải trang chủ trả thay.
   - `/api/library` và `/api/me` trả lời; `/api/me` cho biết chế độ đăng ký đang bật.
   - Trang chủ có Content-Security-Policy.
   - `/api/status` báo nếu `ADMIN_TOKEN` của production ngắn hơn 32 ký tự. Khi đó trang quản trị bị khóa; đặt lại bằng `npx wrangler secret put ADMIN_TOKEN`.
   - Có dữ liệu từ điển trên máy thì kiểm tra thêm `/vendor/dict/manifest.json`.
   - Cuối cùng in danh sách kiểm tra bằng tay và lệnh quay lại.

Tùy chọn:

- `--yes`: không hỏi trước khi áp migration (bắt buộc khi không có terminal).
- `--skip-tests`, `--allow-dirty`, `--allow-placeholders`, `--allow-stale`: bỏ qua từng kiểm tra tương ứng.
- `--url https://…`: địa chỉ dùng để kiểm tra sau deploy, ví dụ khi có tên miền riêng.

Muốn kiểm tra cả `/api/status` bằng mã quản trị, đặt biến môi trường trước khi chạy và xóa ngay sau đó:

```powershell
$env:HOATRI_ADMIN_TOKEN = "<ADMIN_TOKEN của production>"
npm.cmd run deploy
Remove-Item Env:HOATRI_ADMIN_TOKEN
```

**Quay lại** (script in sẵn các lệnh này kèm mã cụ thể):

- Code: `npx wrangler rollback <version-id>`. Lệnh này không hoàn tác migration hay secret.
- Dữ liệu D1: `npx wrangler d1 time-travel restore DB --bookmark=<bookmark>`. Mọi thay đổi dữ liệu sau thời điểm đó bị xóa.
- R2 không có bản lưu: đối tượng đã xóa là mất hẳn.

### B.3 Kiểm thử tự động trên GitHub

`.github/workflows/ci.yml` chạy cho mỗi lần push lên `main` hoặc `handoff/**` và mỗi pull request. Nó không dùng secret nào của repo, không gọi Gemini và không chạm vào Cloudflare.

- **test** (Ubuntu 24.04, Node 24, Python 3.12):
  - chặn commit nhầm `.dev.vars`, `.env`, khóa Google, khóa riêng tư, `samples/`, `.wrangler/`;
  - `npm ci`, mô hình PaddleOCR (có cache), `prepare:vendor`, PyMuPDF và dữ liệu OCR;
  - `npm test` với `backend/test-support/no-paid-api.mjs` nạp trước;
    - Test máy PDF dùng Chromium của máy chạy CI.
    - Hai test bố cục chỉ dành cho Edge (`book-ui.test.mjs`) được bỏ qua.
    - Job đỏ nếu một test cần Python bị bỏ qua, vì khi đó bước cài Python đã hỏng.
  - `wrangler deploy --dry-run`.
- **pdf-image:**
  - kiểm `docker-compose.yml` và `Caddyfile`;
  - build `services/pdf-layout/Dockerfile`;
  - chạy container với cùng giới hạn như compose, rồi kiểm tra:
    - nó tự báo healthy;
    - nó không chạy bằng root;
    - nó đòi token;
    - `smoke.mjs` chạy bên trong container đạt.
  - chạy cả `docker-compose.yml` với Caddy (chứng chỉ nội bộ cho `localhost`), rồi kiểm tra:
    - HTTPS hoạt động và HTTP chuyển sang HTTPS;
    - các đường dẫn được chuyển tiếp, đường dẫn khác bị chặn;
    - một thân yêu cầu 39 MiB đến được dịch vụ.
  - đính kèm ảnh các trang đã xuất (artifact `pdf-smoke`, giữ 7 ngày) để so phông chữ trên Linux.

Chạy test trên máy với cùng bộ chặn: `node --import ./backend/test-support/no-paid-api.mjs --test backend/*.test.mjs`

### B.4 Đã và chưa kiểm chứng

Các lần chạy dưới đây không gọi Gemini và không chạm vào Cloudflare.

**Trên máy Windows bàn giao** (Docker daemon tắt):

- `smoke.mjs` đạt trong ba trường hợp:
  - gọi thẳng dịch vụ;
  - dịch vụ dùng phông DejaVu Serif như trong image Linux;
  - đi qua Caddy 2.11.7 với `Caddyfile` này. Bản thử chỉ đổi upstream, chạy HTTP và chỉ nghe trên 127.0.0.1.
- Qua Caddy, các kết quả đúng như bước kiểm tra trong CI:
  - 401 khi thiếu token, 200 khi có token, 404 cho đường dẫn khác;
  - thân JSON 39 MiB đến được dịch vụ;
  - nhật ký ghi `Authorization` thành `REDACTED`.
- `caddy validate`, `docker compose config` và lệnh `HEALTHCHECK` của image đều chạy được. Lệnh `HEALTHCHECK` trả 0 khi token đúng, 1 khi token sai hoặc không có dịch vụ.
- `wrangler dev` dùng đúng các thiết lập của `wrangler.jsonc`, trong thư mục thử riêng:
  - nạp đủ binding;
  - lần đăng nhập thứ 11 trong một phút trả 429;
  - `/api/health` báo phiên bản;
  - một lượt tách PDF thật đi Worker → Caddy → dịch vụ, trả 201 và lưu được bản gốc.
- `wrangler deploy --dry-run` đạt, không có cảnh báo.
- Toàn bộ luồng `npm run deploy` chạy với Cloudflare giả lập trong `backend/deploy.test.mjs`.

**Trên Ubuntu 24.04 (WSL) với Node 24 và Python 3.12**, giống máy chạy CI:

- `npm ci`, `prepare:vendor` và PyMuPDF cài được.
- `npm test`: 385/389 đạt, 0 lỗi. Các test cần Python đều chạy và đạt. Bốn test bị bỏ qua:
  - hai test chỉ dành cho Edge;
  - một test cần PDF mẫu thật;
  - test máy PDF, vì máy này không có Chromium. Trên GitHub, test này dùng Chromium của máy chạy CI.
- `wrangler deploy --dry-run` đạt.
- Bước `npm ci --omit=dev --ignore-scripts` của Dockerfile chạy được. Dữ liệu OCR của image trùng từng byte với dữ liệu mà `npm test` dùng.

Chưa kiểm chứng:

- Build image: job `pdf-image` trên GitHub là lần build đầu tiên. Lần đó cũng là lần đầu chạy các phần sau:
  - `HEALTHCHECK` và user `node` trong container;
  - compose + Caddy qua HTTPS.
- Test máy PDF và hai test Edge chưa chạy trên Linux. Test máy PDF đã đạt trên Windows với phông DejaVu Serif.
- Cấp chứng chỉ thật và chạy trên máy chủ thật.
- Deploy thật lên Cloudflare: D1, R2, secret, giới hạn của Workers Paid.
