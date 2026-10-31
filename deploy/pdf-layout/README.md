# Triển khai Hoa Trí: dịch vụ PDF và Worker

Tài liệu này gồm hai phần:

- **A.** Dịch vụ PDF giữ bố cục chạy trên máy chủ riêng, bằng Docker và Caddy (HTTPS tự động): bảo vệ máy chủ (A.1), cài đặt, cập nhật và vá image hằng tháng (A.5), giới hạn (A.6), sự cố (A.7), giám sát cả hai phía (A.8). Các tệp nằm trong thư mục này.
- **B.** Deploy Worker lên Cloudflare bằng `npm run deploy`. Lệnh này kiểm tra mọi thứ trước, rồi mới thay đổi production. Sao lưu và khôi phục D1, R2 ở mục B.5.

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
  - Dịch vụ chạy tối đa 2 việc cùng lúc (`PDF_LAYOUT_JOBS`), mỗi việc dùng gần trọn một CPU; mỗi lần xuất PDF mở một Chromium.
- **Tên miền** cho dịch vụ, ví dụ `pdf.example.com`. Tạo bản ghi A (và AAAA nếu máy chủ có IPv6) trỏ về IP máy chủ.
  - Nếu DNS ở Cloudflare: chọn **DNS only** (mây xám). Proxy cam hoặc Cloudflare Tunnel cắt mọi yêu cầu sau 100 s (lỗi 524), trong khi một lượt có thể cần 240–280 s.
- **Bảo vệ máy chủ** trước khi cài: đăng nhập SSH chỉ bằng khóa, tường lửa chỉ mở 22, 80 và 443/TCP, tự cập nhật bản vá hệ điều hành, thêm swap (các lệnh ngay dưới đây).
- **Một token mới**, dùng chung cho dịch vụ và Worker: `openssl rand -hex 32`. Cất trong trình quản lý mật khẩu, khác bản local.
- **Giấy phép:** PyMuPDF dùng AGPL-3.0. Chạy nó thành dịch vụ mạng có thể kéo theo nghĩa vụ AGPL (ONBOARDING mục 8). Chủ dự án quyết định trước khi mở dịch vụ.

#### Bảo vệ máy chủ (làm một lần, trước A.2)

Chạy bằng một tài khoản có `sudo`, không phải `root`. Trước khi tắt đăng nhập bằng mật khẩu, mở **một cửa sổ terminal khác** và thử đăng nhập bằng khóa SSH; nếu không vào được thì đừng đóng phiên đang mở.

```bash
# 1. SSH chỉ nhận khóa; root không đăng nhập bằng mật khẩu.
#    sshd dùng giá trị đọc được ĐẦU TIÊN, và các tệp trong sshd_config.d/ được đọc trước sshd_config (image cloud
#    thường có 50-cloud-init.conf đặt "PasswordAuthentication yes"), nên đặt quy tắc trong một tệp tên bắt đầu bằng 00-.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' | sudo tee /etc/ssh/sshd_config.d/00-hoa-tri.conf
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '   # phải là no, no và without-password (hay prohibit-password)
# 2. Tường lửa: chỉ SSH, 80 (cấp chứng chỉ, chuyển sang HTTPS) và 443
sudo apt-get update && sudo apt-get install -y ufw unattended-upgrades
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status verbose
# 3. Bản vá bảo mật của hệ điều hành tự cài mỗi ngày
sudo dpkg-reconfigure -plow unattended-upgrades
# 4. 2 GB swap: một lượt scan nặng làm chậm máy thay vì bị hệ thống dừng ngay khi thiếu RAM
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

- Docker mở cổng bằng iptables của riêng nó, **không qua ufw**. Vì vậy `docker-compose.yml` chỉ mở 80/443 của Caddy; đừng thêm `ports:` cho `pdf-layout`.
- Bản vá hệ điều hành không cập nhật Chromium, Python hay MuPDF **bên trong image**: các thứ đó chỉ mới khi build lại image (mục A.5, "Bản vá hằng tháng").
- Tùy chọn: chỉ cho dải IP của Cloudflare (https://www.cloudflare.com/ips/) vào cổng 443, vì chỉ Worker gọi dịch vụ. Token đã chặn người lạ. Nếu làm, làm bằng tường lửa của nhà cung cấp VPS (hoặc chuỗi `DOCKER-USER` của iptables), **không** bằng ufw (Docker bỏ qua ufw như trên); giữ cổng 80 mở cho Caddy gia hạn chứng chỉ; dịch vụ theo dõi uptime khi đó không gọi thẳng được `https://pdf.example.com/health` nữa (mục A.8). Kiểm tra lại ngay bằng `https://<Worker>/api/health?deep=1`.

### A.2 Cài lần đầu

```bash
git clone -b handoff/2026-10-16 https://github.com/rynwoo1707/chinese-translator.git hoa-tri   # nhánh mà link "Mã nguồn" (SOURCE_URL) trỏ tới
cd hoa-tri/deploy/pdf-layout
cp env.example .env && chmod 600 .env
nano .env                      # điền PDF_DOMAIN, ACME_EMAIL, PDF_LAYOUT_SERVICE_TOKEN
docker compose up -d --build   # lần đầu build image mất vài phút
docker compose ps              # pdf-layout: healthy; caddy: Up
docker compose logs -f caddy   # chờ dòng "certificate obtained successfully", rồi Ctrl+C
```

- Clone đúng nhánh (hoặc tag) đang deploy cho Worker: nhánh `main` trên GitHub hiện còn là bản đầu tiên, chưa có `deploy/pdf-layout`. Worker và dịch vụ phải cùng commit (mục A.5).
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

Kết quả đúng kết thúc bằng `Dịch vụ PDF đạt kiểm thử (không gọi Gemini).` Dòng `/health` của smoke ghi thêm bản mã nguồn, số việc cùng lúc và phông (phải là `LiberationSerif-Regular.ttf` trong image). Dòng "CẢNH BÁO: dịch vụ dùng bộ kiểm tra bố cục …, mã nguồn trên máy này là …" nghĩa là dịch vụ và bản mã nguồn chạy smoke khác commit (mục A.5).

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

Sau khi deploy, `https://<Worker>/api/health` phải có `"pdfLayout":"configured"`, và `https://<Worker>/api/health?deep=1` phải có `"pdfService":{"status":"ok",…}`: Worker gọi được dịch vụ bằng token của nó. `npm run deploy` tự kiểm tra cả hai (phần B).

### A.5 Cập nhật

```bash
cd hoa-tri && git pull
cd deploy/pdf-layout && docker compose up -d --build && docker image prune -f
```

- Build lại khi một trong các tệp sau thay đổi: `services/pdf-layout/`, `package.json`, `package-lock.json`, `frontend/pdf-box-layout.js`, `frontend/math-text.js`.
- Lúc container khởi động lại, các lượt đang chạy sẽ lỗi. Lượt dịch cả quyển tự chờ rồi thử lại; ở chế độ chọn trang, trang tự thử lại 3 lần (mỗi lần chờ khoảng 30 giây) rồi mới để người dùng bấm dịch lại. Từ lượt sửa thứ ba (23/10/2026), các lượt dịch vụ không làm được như vậy được trả lại hạn mức ngày của học sinh.
- **Thứ tự cập nhật:** deploy Worker (phần B) trước hoặc cùng lúc với dịch vụ PDF. Hai bên dùng chung bộ kiểm tra tài liệu (`frontend/pdf-box-layout.js`); dịch vụ mới chạy với Worker cũ có thể khiến mọi trang scan báo "Ảnh trang PDF không hợp lệ.".
- **Kiểm tra hai bên khớp nhau:** `/health` của dịch vụ báo `version.layout` (mã băm của bộ kiểm tra tài liệu) và `version.service` (mã băm mã nguồn của image). `npm run deploy` cho Worker biết mã bố cục của nó, nên `https://<Worker>/api/health?deep=1` báo `"layoutMatch":true` khi khớp, và `"status":"mismatch"` (mã 503) khi lệch. Kiểm tra sau deploy của `npm run deploy` cũng cảnh báo khi image chạy bản mã nguồn khác commit vừa deploy. Một image cũ mà cùng bộ kiểm tra bố cục vẫn báo `"layoutMatch":true`: lượt sửa thứ ba (23/10/2026) là trường hợp đó (đổi `extract.py`, `engine.mjs`, `server.mjs`, `healthcheck.mjs`, `Dockerfile` mà không đổi bộ kiểm tra), nên chỉ có cảnh báo "Dịch vụ PDF đang chạy bản …" nhắc build lại; các bản sửa của bộ tách trang, việc kiểm phông và việc làm mới bố cục chỉ có sau khi build lại. Lượt sửa thứ tư (cũng 23/10/2026) cũng vậy: đổi `extract.py`, `engine.mjs`, `server.mjs` mà không đổi bộ kiểm tra; chưa build lại thì bộ tách trang vẫn như lượt thứ ba và câu báo bản dịch dài hơn khung vẫn là câu cũ ("Trang 24: bản dịch của Đoạn 3…" thay cho "Bản dịch của Trang 24 · đoạn 3…").
- **Bản 27/10/2026** đổi bộ kiểm tra bố cục (`frontend/math-text.js`, `frontend/pdf-box-layout.js`) cùng `extract.py` và `server.mjs`: build lại image ngay sau khi Worker của cùng commit đã deploy. Tới lúc đó `npm run deploy` kết thúc bằng LỖI "Dịch vụ PDF kiểm tra tài liệu bằng mã bố cục X, còn Worker vừa deploy dùng Y…" (dự kiến: không cần quay Worker lại, chỉ cần build lại image), `/api/health?deep=1` trả 503 `mismatch` (tạm tắt báo động của dịch vụ theo dõi), học sinh bấm "Xuất PDF tiếng Việt" nhận câu "Dịch vụ PDF chưa được cập nhật cùng phiên bản với trang web…" (Worker trả 503 `pdf_service_outdated`, không lưu PDF, không tính lượt xuất trong ngày, Workers Logs ghi `pdf_service_outdated`) thay vì một PDF dựng bằng bộ vẽ công thức cũ (in nguyên `\begin{cases}`…), lượt "Dịch cả quyển" đang chạy tạm dừng ở bước xuất PDF với cùng câu đó (bấm "Dịch tiếp" sau khi build lại image; không tốn token lại), và cách dịch "Kỹ nhất" chưa có tờ OCR mịn hơn: Worker mới gửi header `X-PDF-Quality: fine`, image cũ bỏ qua nó. Không có biến mới cho dịch vụ PDF.
- **Bản 30/10/2026** đổi `frontend/pdf-box-layout.js` và `extract.py` (`EXTRACTION_VERSION` 4: tách trang scan đủ tiêu đề, chân trang, khung và bảng; nhận danh sách đoạn đã đọc khi "Cập nhật bố cục"): build lại image ngay sau khi Worker của cùng commit đã deploy, như bản 27/10/2026. Tới lúc đó việc xuất PDF bị từ chối với `pdf_service_outdated`, và "Cập nhật bố cục" cũng vậy: Worker mới thấy bản tách lại còn mang dấu bộ tách cũ (dưới 4) thì không lưu gì, trả lại lượt tách của ngày và báo "Dịch vụ PDF vẫn dùng bộ tách trang cũ…" (503 `pdf_service_outdated`), nên không phần nào bị tách lại kém hơn hay trả token cho cả phần. Không bao giờ build image trước Worker. Không có biến mới cho dịch vụ PDF.

**Bản vá hằng tháng** (Chromium, MuPDF, Python và các gói Debian trong image). Lệnh build thường dùng lại lớp `apt-get` cũ trong cache, nên bản vá chỉ vào image khi build với `--pull --no-cache`:

```bash
cd hoa-tri && git pull
cd deploy/pdf-layout
docker tag hoa-tri-pdf-layout:local hoa-tri-pdf-layout:previous   # giữ bản đang chạy để quay lại
docker compose build --pull --no-cache pdf-layout && docker compose up -d
docker compose ps                                                  # pdf-layout: healthy
docker compose exec pdf-layout node services/pdf-layout/smoke.mjs http://127.0.0.1:8091 /tmp/smoke
docker image prune -f                                              # xóa image không còn tên (giữ :previous)
```

- Mỗi tháng cũng xem ghi chú phát hành của PyMuPDF (https://github.com/pymupdf/PyMuPDF/releases): dịch vụ đọc PDF do người lạ gửi lên. Có bản vá bảo mật thì nâng `services/pdf-layout/requirements.txt`, đợi CI xanh, rồi build lại như trên.

**Quay lại bản trước** khi bản mới lỗi (smoke không đạt, `docker compose ps` báo unhealthy, học sinh báo lỗi xuất PDF):

```bash
cd hoa-tri/deploy/pdf-layout
docker tag hoa-tri-pdf-layout:previous hoa-tri-pdf-layout:local
docker compose up -d --no-build pdf-layout
```

- Không còn tag `:previous`: quay mã nguồn về commit trước (`git log --oneline -5`, rồi `git checkout <commit>`), chạy `docker compose up -d --build`, sau đó `git checkout -` để về nhánh cũ.
- Nếu đã deploy Worker mới cùng lúc và hai bên lệch bộ kiểm tra bố cục, quay cả Worker (`npx wrangler rollback`, phần B.2).
- **Cập nhật Caddy:** đổi tag `caddy:2.11.7-alpine` trong `docker-compose.yml` (đọc ghi chú phát hành của Caddy trước), rồi chạy `docker compose up -d caddy`.
- **Cập nhật Node trong image:** image dùng đúng bản `node:22.23.3-bookworm-slim`, nên build lại vài tháng sau vẫn ra đúng môi trường CI đã thử. Muốn lên bản mới, sửa dòng `FROM` trong `services/pdf-layout/Dockerfile`, đợi CI xanh, rồi build lại.

**Đổi token:**

1. Sửa `.env`, rồi chạy `docker compose up -d` (container `pdf-layout` được tạo lại).
2. Ngay sau đó chạy `npx wrangler secret put PDF_LAYOUT_SERVICE_TOKEN` với cùng giá trị.

Giữa hai bước, dịch vụ từ chối Worker (401): học sinh thấy "Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên." (Worker trả 503 `pdf_unavailable`, `Retry-After: 30`, không tính vào hạn mức ngày), Workers Logs có dòng `{"event":"pdf_service_refused","operation":…,"status":401}`, và `/api/health?deep=1` báo `"unauthorized"`. Trước lượt sửa thứ ba, học sinh thấy thẳng chữ "Unauthorized" (400, không có mã).

### A.6 Giới hạn và cách cấu hình

| Mục | Giá trị |
|---|---|
| Thời gian | Caddy chờ phản hồi tối đa 300 s; Worker chờ 280 s; tách trang (Python) dừng ở 240 s; một lần xuất PDF (Chromium và ghép trang) dừng ở 250 s. Trước mức 240 s, `extract.py` tự thôi bắt đầu trang mới khi sắp quá khoảng 170 s (`PDF_EXTRACT_SECONDS`) và trả các trang đã xong kèm "Lượt này xử lý X/Y trang đã chọn…". Muốn đổi thì đặt `PDF_EXTRACT_SECONDS` trong `.env` (một số dương, nhỏ hơn 240): compose chuyển nó vào container, mặc định 170. Từ lượt sửa thứ ba, `0`, số âm hay chữ không phải số đều dùng 170 (trước đó `0` làm mọi lượt chỉ trả trang đầu, chữ làm mọi lượt lỗi). Làm mới bố cục của một bản dịch cũ (header `X-PDF-All-Pages: 1`, cần đủ mọi trang) được dùng 225 s thay cho 170 s; không xong thì Worker trả 413 kèm lời khuyên dịch lại thành lượt nhỏ hơn |
| Kích thước | Caddy nhận thân yêu cầu tới 48 MB. Dịch vụ tự giới hạn PDF 25 MiB và JSON 40 MiB: quá giới hạn thì nó vẫn đọc hết thân yêu cầu rồi trả 413 với `"code":"too_large"` và câu "Dữ liệu gửi tới dịch vụ PDF lớn hơn 25 MB (hoặc 40 MB)…" (Worker báo `pdf_too_large`), chỉ cắt kết nối khi người gửi vượt thêm 64 MiB. JSON hỏng hay header `X-PDF-Pages` hỏng nhận 400 bằng tiếng Việt |
| Đồng thời | `PDF_LAYOUT_JOBS` việc mỗi container (mặc định 2). Worker chia các chỗ đó cho cả trang web: tối đa `PDF_LAYOUT_SLOTS` lượt cùng lúc (var của Worker, khai báo `"2"` trong khối `"vars"` của `wrangler.jsonc`, đặt bằng `PDF_LAYOUT_JOBS`; muốn đổi thì sửa giá trị đó, ví dụ `"3"`, rồi deploy lại), mỗi tài khoản tối đa một lượt. Khi đầy, Worker trả 503 `pdf_service_busy` kèm `Retry-After: 20` mà không gọi dịch vụ; trang tự chờ rồi thử lại (chọn trang: 15 lần; dịch cả quyển: tối đa khoảng nửa giờ). Từ lượt sửa thứ ba, Worker giữ lượt của tài khoản và đếm các chỗ trước khi đọc tệp tải lên, nên câu trả lời bận đến ngay mà không phải nhận tới 25 MB, và trình duyệt hỏi `GET /api/my/study/pdf-layout/capacity` (một lần đọc D1, không giữ chỗ) trước khi tải lên lại. Từ lượt sửa thứ tư, chỗ chỉ được lấy khi đã nhận đủ tệp: một tệp đang tải lên (dù chậm hay cố ý nhỏ giọt) không giữ chỗ nào của dịch vụ, và nếu chỗ cuối bị lấy trong lúc đó thì Worker trả 503 `pdf_service_busy` ngay sau khi tải xong. Lượt sửa thứ ba lấy cả chỗ trước khi đọc, nên hai tài khoản gửi mỗi 10 giây một byte giữ được cả 2 chỗ bao lâu tùy ý |
| Tải lên | Từ lượt sửa thứ tư, thân yêu cầu của tách trang, làm mới bố cục và xuất PDF phải tới Worker trong max(2 phút, `Content-Length` ÷ 16 KB/s); không khai `Content-Length` thì giới hạn của thao tác ÷ 16 KB/s (tách trang 26 MB: khoảng 28 phút; làm mới bố cục, xuất PDF 8 MB: khoảng 8,5 phút). Quá hạn thì Worker hủy phần đang tải lên và trả 408 `upload_timeout` ("Kết nối mạng quá chậm…"), không tính hạn mức ngày. Đây là việc của Worker, không cấu hình được ở dịch vụ; giới hạn thân yêu cầu 48 MB và thời gian chờ 300 s của Caddy không đổi |
| Việc nặng | Tách trang quá thời gian, hết bộ nhớ, kết quả quá lớn hoặc tiến trình chết: Worker trả 413 (`pdf_timeout`, `pdf_memory`, `pdf_too_large`, `pdf_crash`) và lượt dịch cả quyển tự thử lại với nửa số trang; ở chế độ chọn trang, học sinh được khuyên chọn ít trang hơn (3–5 trang) |
| Người gọi rời đi | Khi Worker ngắt kết nối (học sinh đóng tab, Worker hết 280 s), dịch vụ dừng việc ngay (dừng Python, đóng Chromium) và nhường chỗ. Chỗ của Worker (lưu trong D1) tự hết hạn sau tối đa 1 phút |
| Tài nguyên | Mặc định 2 CPU và 3g RAM. Đổi bằng `PDF_LAYOUT_CPUS` và `PDF_LAYOUT_MEMORY` trong `.env`; máy 1 CPU phải đặt `PDF_LAYOUT_CPUS=1` (và `PDF_LAYOUT_JOBS=1`, `PDF_LAYOUT_SLOTS=1`) |
| Bảo mật | Container chạy bằng user `node`, bỏ mọi capability, `no-new-privileges`. Chromium vẫn cần `--no-sandbox` trong container. Chỉ Caddy mở cổng ra ngoài |
| Sức khỏe | `healthcheck.mjs` gọi `/health` kèm token mỗi 15 giây; `docker compose ps` hiện `healthy`. Docker không tự khởi động lại container chỉ vì unhealthy, nên sau 4 lần lỗi liên tiếp (`PDF_HEALTH_RESTART_AFTER`, 0 là tắt) chính bước kiểm tra dừng dịch vụ và `restart: unless-stopped` khởi động lại |
| Nhật ký | `docker compose logs --tail 200 pdf-layout` hoặc `caddy`. Mỗi dịch vụ giữ tối đa 3 tệp 10 MB. Caddy ghi `Authorization` thành `REDACTED` |
| OCR | Cùng dữ liệu `chi_sim` và `eng` (@tesseract.js-data 4.0.0_best_int) với `npm test` và bản Windows |
| Phông chữ | Liberation Serif (gói `fonts-liberation2`): cùng độ rộng chữ với Times New Roman mà mọi phép đo độ vừa ô trên Windows đã dùng, đủ mọi chữ Việt. DejaVu Serif chỉ bù các ký hiệu Liberation thiếu. Image không build được nếu thiếu Liberation Serif; `/health` báo phông đang dùng. Từ lượt sửa thứ ba, dịch vụ chỉ nêu phông khi tệp có thật: không có tệp nào thì build in "PDF font: none" rồi dừng, `/health` báo `"font":null`, `/font` và mọi lần xuất trả 500 `code:"font"` (Worker: 503 `pdf_unavailable`, "Dịch vụ PDF đang thiếu phông chữ…"). Muốn phông khác thì đặt `PDF_FONT_PATH` cho container |

Đã có reverse proxy khác (ví dụ nginx)? Chỉ chạy dịch vụ: `docker compose up -d pdf-layout`. Thêm `docker-compose.override.yml` mở `127.0.0.1:8091:8091` cho dịch vụ đó, và giữ đúng các giới hạn ở trên: timeout ≥ 300 s, thân yêu cầu ≥ 45 MB, không giữ kết nối keep-alive tới dịch vụ.

### A.7 Sự cố thường gặp

| Hiện tượng | Nguyên nhân | Cách sửa |
|---|---|---|
| Caddy báo `challenge failed`, `NXDOMAIN` hoặc không lấy được chứng chỉ | DNS chưa trỏ đúng; bản ghi đang bật proxy cam; cổng 80/443 bị chặn | Sửa DNS (DNS only), mở cổng, rồi `docker compose restart caddy` |
| Worker báo "…không phản hồi đúng (mã 524)" | Bản ghi DNS đang qua proxy Cloudflare | Chuyển sang DNS only |
| Worker báo "…(mã 502)" | Container `pdf-layout` không chạy hoặc đang khởi động lại | `docker compose ps`, rồi `docker compose logs pdf-layout` |
| Học sinh gặp "Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên." trong khi `docker compose ps` vẫn `healthy`; Workers Logs có `"event":"pdf_service_refused"` với `"status":401` (bản trước lượt sửa thứ ba: học sinh thấy "Unauthorized") | Token ở `.env` khác secret của Worker | Đặt giống hệt ở cả hai nơi (mục A.5) |
| Như dòng trên nhưng `"status":404` (bản trước: "Not found") | `PDF_LAYOUT_SERVICE_URL` có thêm đường dẫn, hoặc trỏ sai host | Chỉ dùng gốc `https://pdf.example.com` |
| `pdf-layout` khởi động lại liên tục, nhật ký có "Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự." | Token quá ngắn | Sinh lại bằng `openssl rand -hex 32` |
| `range of CPUs is from 0.01 to 1.00` | Máy chủ chỉ có 1 CPU | Đặt `PDF_LAYOUT_CPUS=1` trong `.env` |
| `pdf-layout` unhealthy, nhật ký có `Killed` hoặc `SIGKILL` | Thiếu RAM | Tăng `PDF_LAYOUT_MEMORY`, hoặc chọn ít trang hơn mỗi lượt |
| `docker compose up` báo `dependency failed to start` và Caddy không chạy | `pdf-layout` chưa healthy | `docker compose logs pdf-layout`: thường là token quá ngắn hoặc thiếu RAM (hai dòng trên) |
| Học sinh hay gặp "Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc" | Các chỗ của dịch vụ thường xuyên đầy | Máy mạnh hơn: tăng CPU/RAM, rồi tăng cùng lúc `PDF_LAYOUT_JOBS` (`.env`) và `PDF_LAYOUT_SLOTS` (`wrangler.jsonc`) |
| Học sinh gặp "Kết nối mạng quá chậm nên máy chủ chưa nhận hết dữ liệu gửi lên và đã dừng lượt xử lý PDF này…" (Worker: 408 `upload_timeout`; từ lượt sửa thứ tư) | Tệp tải lên chưa tới Worker trong max(2 phút, dung lượng ÷ 16 KB/s) (mục A.6, dòng "Tải lên"); dịch vụ PDF chưa nhận gì | Không phải lỗi của máy chủ PDF: học sinh đổi sang mạng ổn định hơn rồi thử lại. Không có gì để cấu hình |
| `/api/health?deep=1` báo `"status":"mismatch"` | Worker và dịch vụ chạy hai commit có bộ kiểm tra bố cục khác nhau | Cập nhật dịch vụ cho cùng commit với Worker (mục A.5) |
| Học sinh gặp "Dịch vụ PDF chưa được cập nhật cùng phiên bản với trang web…" khi xuất PDF, hay lượt "Dịch cả quyển" tạm dừng ở bước xuất PDF với câu đó (Worker: 503 `pdf_service_outdated`, Workers Logs: `{"event":"pdf_service_outdated",…}`) | Image dịch vụ dựng PDF bằng mã bố cục khác `PDF_LAYOUT_VERSION` của Worker, hay là image cũ hơn bản 27/10/2026 (không trả `layoutVersion`); PDF đó không được lưu | Cập nhật dịch vụ cho cùng commit với Worker (mục A.5) |
| `/api/health?deep=1` báo `"unauthorized"`, `"unreachable"` hoặc `"timeout"` | Token khác nhau; máy chủ, DNS hoặc Caddy không chạy | Đặt lại token (mục A.5); `docker compose ps`, `docker compose logs caddy` |
| `pdf-layout` khởi động lại sau khoảng mỗi phút | Bước kiểm tra sức khỏe lỗi liên tiếp nên tự khởi động lại | `docker compose logs pdf-layout`; tạm đặt `PDF_HEALTH_RESTART_AFTER=0` trong `.env` để tìm lỗi |
| `docker compose build` dừng ngay sau dòng `PDF font: …` (mã 1); từ lượt sửa thứ ba cũng sau `PDF font: none` | Phông xuất PDF tìm được không phải `LiberationSerif-Regular.ttf`, hoặc không có tệp phông nào: gói `fonts-liberation2` không cài được hoặc đổi chỗ để tệp | Đọc lỗi của bước `apt-get` phía trên; nếu Debian đổi đường dẫn tệp, sửa `LINUX_FONTS` trong `services/pdf-layout/engine.mjs` rồi build lại |
| Học sinh gặp "Dịch vụ PDF đang thiếu phông chữ để dựng bản PDF tiếng Việt, nên chưa xuất được PDF…" (Worker: 503 `pdf_unavailable`); `/health` báo `"font":null`; `npm run deploy` cảnh báo "Dịch vụ PDF không báo phông chữ xuất PDF…" | Container không có tệp phông: `PDF_FONT_PATH` đặt cho container trỏ tới tệp không có, hoặc image được dựng khác `Dockerfile` này | Bỏ hay sửa `PDF_FONT_PATH`, build lại image (mục A.5). Nhật ký `docker compose logs pdf-layout` có dòng `[pdf-layout] /font …` nêu các tệp đã tìm |
| `/api/health?deep=1` báo `"status":"error"` kèm `"code"` | Dịch vụ trả mã HTTP đó cho `/health` (ví dụ Caddy trả 502 khi container chưa chạy) | `docker compose ps`, `docker compose logs pdf-layout caddy` |
| Học sinh hay gặp "Xuất PDF tiếng Việt vượt thời gian cho phép của dịch vụ…" hoặc "Tách PDF vượt thời gian cho phép…" | Máy chủ quá tải (2 việc trên máy yếu, swap đầy) hoặc PDF quá nặng | `docker stats` và `free -h` lúc có việc; tăng CPU/RAM, hoặc giảm `PDF_LAYOUT_JOBS` và `PDF_LAYOUT_SLOTS` |
| Học sinh gặp "Dịch vụ PDF chưa mở được trình duyệt để dựng bản PDF tiếng Việt…" khi xuất PDF (Worker: 503 `pdf_unavailable`) | Chromium trong container không khởi động được | `docker compose logs pdf-layout`: dòng `[pdf-layout] /render …` ghi lỗi gốc trong ngoặc (thiếu tệp trình duyệt, `CHROMIUM_EXECUTABLE_PATH` sai, "Failed to launch the browser process"). Build lại image (mục A.5); kiểm tra RAM và `shm_size` |
| Học sinh gặp "Trình duyệt của dịch vụ PDF dừng giữa chừng khi dựng trang N…" (Worker: `pdf_crash`) | Chromium chết giữa lần xuất, thường do thiếu RAM hoặc bộ nhớ chia sẻ | `docker stats`; tăng `PDF_LAYOUT_MEMORY`, giữ `shm_size: 1gb` của compose |
| "Dịch vụ PDF nhận được dữ liệu hỏng hoặc bị cắt giữa chừng…" (400) hoặc "Dữ liệu gửi tới dịch vụ PDF lớn hơn 25 MB…" (413) | Thân yêu cầu bị cắt trên đường (proxy, mạng), không phải JSON object, hoặc quá giới hạn của dịch vụ | Proxy khác Caddy: nhận thân yêu cầu ≥ 45 MB, không cắt yêu cầu dài; với 413 thì chọn ít trang hơn mỗi lượt |

### A.8 Giám sát

Không có gì tự báo khi dịch vụ PDF ngừng, nên đặt một dịch vụ theo dõi uptime miễn phí (ví dụ UptimeRobot hoặc Better Stack), kiểm tra mỗi 5 phút:

- `https://<Worker>/api/health?deep=1`: báo động khi mã khác 200. Mã 503 nghĩa là D1 lỗi (`"database":"error"`), D1 còn thiếu migration mà code này cần (`"migrations":{"status":"pending","pending":[…]}`, từ bản 30/10/2026; áp bằng `npm run deploy` hoặc `npx wrangler d1 migrations apply DB --remote`) hoặc Worker không dùng được dịch vụ PDF (`"pdfService":{"status":…}`). Câu trả lời không chứa token, URL hay nội dung lỗi; mỗi isolate của Worker (một bản đang chạy trên một máy của Cloudflare) hỏi dịch vụ tối đa một lần mỗi 30 giây, dù có bao nhiêu lần kiểm tra. Kiểm tra bằng `HEAD` cũng được: chỉ trả mã 200 hoặc 503.
- `https://pdf.example.com/health`: mong đợi mã 401 (dịch vụ đòi token). Kiểm tra này đi thẳng tới Caddy, nên vẫn báo khi Worker hoạt động bình thường mà máy chủ PDF không vào được. Bật thêm cảnh báo hết hạn chứng chỉ TLS nếu dịch vụ theo dõi có.
- `/api/health?deep=1` vẫn `ok` (mã 200) khi dịch vụ không có tệp phông, chỉ `"font":null`, trong khi mọi lần xuất PDF lỗi; nếu dịch vụ theo dõi kiểm được nội dung, cho nó tìm chữ `LiberationSerif` trong câu trả lời.
- Trên Cloudflare: bật Notifications cho Worker để biết khi tỉ lệ lỗi tăng; xem lỗi trực tiếp bằng `npx wrangler tail`. Dòng `"event":"pdf_service_refused"` (từ lượt sửa thứ ba; kèm `operation` và `status`) nghĩa là dịch vụ từ chối Worker: token hai phía khác nhau (401) hay URL sai (404), mục A.7. Dòng `"event":"pdf_service_outdated"` (từ bản 27/10/2026; kèm `expected` và `drawn`) nghĩa là image dựng PDF bằng mã bố cục khác Worker và bản PDF đó không được lưu: build lại image cho cùng commit (mục A.5). Lỗi mà các trang gặp trong trình duyệt của người dùng là những dòng `"event":"client_error"` trong Workers Logs (nội dung lỗi đã lọc, tệp và dòng, đường dẫn trang, họ trình duyệt; ONBOARDING mục 5.9). Chưa có gì tự báo động theo số dòng này: xem lại mỗi tuần, và ngay sau mỗi lần deploy.
- Trên máy chủ: `docker compose ps` phải hiện `healthy`; `docker compose logs --since 1h pdf-layout | grep "stopped: the caller left"` cho biết bao nhiêu lượt bị bỏ dở.

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
- Gắn tên miền riêng **trước** lần chia sẻ link đầu tiên: thẻ xem trước khi dán link vào Zalo/Facebook và địa chỉ canonical lấy theo tên miền mà người dùng mở, nên link `*.workers.dev` sẽ hiện tên đó. Nên khai báo trong `wrangler.jsonc` (`"routes": [{"pattern": "<tên miền>", "custom_domain": true}]`) rồi deploy; thêm trên dashboard (Workers → Settings → Domains & Routes) thì chép luôn dòng đó vào `wrangler.jsonc` (xem B.2, "Chỉ đổi cấu hình Worker trong `wrangler.jsonc`"). Sau khi tên miền chạy ổn, đặt `"workers_dev": false` để không còn bản trùng (xem ONBOARDING mục 5.3).
- Chạy `npm run prepare:dict` một lần trên máy deploy (lần sau `npm run setup` tự cập nhật). Dữ liệu "Tra chữ Hán" nằm trong `frontend/vendor/dict` và không commit. Thiếu dữ liệu này thì script dừng ngay bước 1; `--allow-no-dictionary` để vẫn deploy không có từ điển.
- Điền mọi chỗ `[[CHƯA ĐIỀN: …]]` của `frontend/dieu-khoan.html`, `frontend/quyen-rieng-tu.html` và `frontend/.well-known/security.txt` (ONBOARDING mục 5.1), rồi commit. `security.txt` cần `Contact:` là `mailto:`, `https://` hoặc `tel:` (cùng email liên hệ của hai trang pháp lý) và đúng một `Expires:` dạng RFC 3339, cách hôm nay dưới một năm.
- Push commit sắp deploy lên nhánh mà link "Mã nguồn" trỏ tới (`SOURCE_URL` trong `frontend/site-footer.js`, hiện `…/tree/handoff/2026-10-16`). Script so với nhánh remote đã biết trên máy, không tự fetch: push từ máy khác thì chạy `git fetch` trước.

**Tệp secret** dạng `TÊN=giá trị`, đặt **ngoài** thư mục dự án, ví dụ `C:\Users\<bạn>\hoa-tri-secrets\production.env`:

```
ADMIN_TOKEN=<64 hex mới, khác bản local>
PDF_LAYOUT_SERVICE_URL=https://pdf.example.com
PDF_LAYOUT_SERVICE_TOKEN=<giống hệt .env của dịch vụ PDF>
# Tùy chọn: GEMINI_API_KEY (chỉ cho xưởng dịch admin), GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET (đặt đủ cả hai)
```

- `ADMIN_TOKEN` (từ bản 27/10/2026) không phải mã đăng nhập: quản trị viên đăng nhập `/admin` bằng tên đăng nhập và mật khẩu riêng. Mã này chỉ được gõ ở `/admin` để tạo tài khoản quản trị đầu tiên và để đặt lại mật khẩu quản trị khi quên; nó vẫn là khóa mã hóa khóa Gemini lưu ở "Cài đặt", khóa của bảng đếm nhập sai mật khẩu, và mã `Authorization: Bearer` của công cụ dòng lệnh (`npm run samples`, `HOATRI_ADMIN_TOKEN` dưới đây). Chỉ người giữ máy chủ cần nó (ONBOARDING mục 3.3). Khi lên bản này từ bản cũ hơn, mọi quản trị viên từng gõ chung mã này: sau khi họ đã có tài khoản riêng, đặt mã mới bằng `npx wrangler secret put ADMIN_TOKEN` rồi nhập lại khóa Gemini ở "Cài đặt" nếu khóa lưu ở đó (ONBOARDING mục 5.7).
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
   - `wrangler.jsonc` hợp lệ: UUID thật, không có khối `secrets`, không có var mang tên bí mật, không có `PDF_LAYOUT_VERSION` trong `"vars"`. Script cũng cảnh báo khi `REGISTRATION_MODE` sai chính tả hoặc là `domain` mà `ALLOWED_EMAIL_DOMAINS` trống, vì khi đó không ai tạo được tài khoản. Từ bản 27/10/2026 script còn cảnh báo khi `ADMIN_TRANSLATION_MODE` không phải `economy`, `balanced`, `quality`, `premium` hay trống (máy chủ khi đó dùng `premium`), và khi `GEMINI_THINKING` không phải `minimal`, `low`, `medium`, `high`, `default` hay trống (máy chủ khi đó bỏ qua nó, mỗi việc dịch của quản trị viên suy luận theo Cách dịch của việc đó).
   - Các trang công khai (`frontend/*.html`, `frontend/*.js`) và `frontend/.well-known/*` không còn chỗ `[[CHƯA ĐIỀN`. `--allow-placeholders` biến lỗi này thành cảnh báo chỉ khi `REGISTRATION_MODE` là `closed` hoặc `domain` (bản thử kín); với `open` script vẫn dừng.
   - `frontend/.well-known/security.txt`: `Contact:` và `Expires:` hợp lệ (lỗi); cảnh báo khi `Expires` đã qua, còn dưới 30 ngày, xa hơn một năm, hoặc khi thiếu tệp.
   - Commit hiện tại đã có trên nhánh của `SOURCE_URL`, ở một git remote trỏ tới đúng repo GitHub đó (https hoặc ssh). Đạt thì in "Mã nguồn công khai của bản này: https://github.com/…/tree/<mã commit> (nhánh …)."; không đạt thì dừng, trừ khi có `--allow-unpushed`. Lý do: dịch vụ PDF chạy PyMuPDF theo giấy phép GNU AGPL, nên link "Mã nguồn" phải mở đúng bản đang chạy.
   - Có dữ liệu từ điển (`frontend/vendor/dict/manifest.json` và thư mục phiên bản nó ghi), trừ khi có `--allow-no-dictionary`.
   - Tệp secret hợp lệ.
2. **Cloudflare, chỉ đọc:** đã đăng nhập (máy có nhiều account thì đặt `CLOUDFLARE_ACCOUNT_ID`), có bucket R2, đủ secret (`ADMIN_TOKEN` bắt buộc; cặp PDF và cặp Google phải đi cùng nhau), và phiên bản đang chạy để quay lại nếu cần.
3. **Build:**
   - Kiểm mô hình PaddleOCR có sẵn trong repo (`backend/paddle-models/`). Thiếu hoặc hỏng thì dừng: "Mô hình PaddleOCR chưa dùng được: … Lấy lại bằng: git checkout -- backend/paddle-models rồi chạy lại."
   - Chép `frontend/vendor` bằng `backend/vendor.mjs --require-paddle`: production bắt buộc có PaddleOCR, nên lỗi ở đây là dừng (trên máy dev thì chỉ là cảnh báo).
   - `npm test` (chặn mọi lệnh gọi Gemini, Google, Cloudflare), rồi `wrangler deploy --dry-run`.
4. **Migration D1:** liệt kê các migration chờ, in lệnh khôi phục Time Travel, rồi hỏi `Gõ CÓ để tiếp tục:`. Nếu D1 có migration lạ (code cũ hơn production), script dừng. Bản 27/10/2026 có 2 migration mới: `0025` (tài khoản và phiên quản trị, cột `mode`, `thinking_tokens` của `jobs`) và `0026` (cột `engine` của lịch sử dịch); đều chỉ thêm bảng, chỉ mục và cột.
5. **Deploy:** `wrangler deploy --strict`, gắn tag là mã commit, kèm var `PDF_LAYOUT_VERSION` (mã băm bộ kiểm tra bố cục của commit này, để `/api/health?deep=1` so với dịch vụ PDF).
6. **Kiểm tra bản mới:**
   - `/api/health` báo đúng commit.
   - `/api/health?deep=1`: Worker gọi được dịch vụ PDF và hai bên dùng cùng bộ kiểm tra bố cục (lệch là lỗi). Script cảnh báo khi image của dịch vụ chạy bản mã nguồn khác commit này, không xuất PDF bằng Liberation Serif, hoặc (từ lượt sửa thứ ba) không báo phông nào: image thiếu tệp phông, nên mọi lần xuất sẽ lỗi, hoặc là bản cũ.
   - Các tệp `/vendor/` là tệp thật, không phải trang chủ trả thay.
   - `/api/library` và `/api/me` trả lời; `/api/me` cho biết chế độ đăng ký đang bật.
   - Trang chủ có Content-Security-Policy.
   - `http://<tên máy>/` chuyển sang `https://` cùng tên máy bằng 301 hoặc 308. Mã tạm thời (302, 303, 307) hay không kết nối được là cảnh báo; trả trang qua `http://` hay chuyển sang nơi khác là lỗi.
   - `/api/status` báo nếu `ADMIN_TOKEN` của production ngắn hơn 32 ký tự (lỗi). Khi đó không tạo hay đặt lại được tài khoản quản trị ở `/admin` và công cụ dòng lệnh không vào được (tài khoản đã có vẫn đăng nhập); đặt lại bằng `npx wrangler secret put ADMIN_TOKEN`, rồi nhập lại khóa Gemini đã lưu ở "Cài đặt". Từ bản 27/10/2026 script còn cảnh báo "Chưa có tài khoản quản trị: mở /admin và tạo tài khoản bằng ADMIN_TOKEN." khi D1 chưa có tài khoản quản trị nào: làm việc đó ngay sau deploy (ONBOARDING mục 3.3).
   - Dữ liệu từ điển: `/vendor/dict/manifest.json` và tệp chỉ mục đầu tiên của thư mục phiên bản nó ghi. Thiếu là lỗi; deploy với `--allow-no-dictionary` thì chỉ là cảnh báo.
   - Cuối cùng in danh sách kiểm tra bằng tay và lệnh quay lại.

Tùy chọn:

- `--yes`: không hỏi trước khi áp migration (bắt buộc khi không có terminal).
- `--skip-tests`, `--allow-dirty`, `--allow-stale`: bỏ qua từng kiểm tra tương ứng.
- `--allow-placeholders`: cho deploy khi trang công khai còn chỗ trống, chỉ khi `REGISTRATION_MODE` là `closed` hoặc `domain` (bản thử kín, ONBOARDING mục 5.11).
- `--allow-unpushed`: cho deploy commit chưa có trên nhánh của link "Mã nguồn"; chỉ dành cho bản thử kín.
- `--allow-no-dictionary`: deploy khi máy chưa có dữ liệu "Tra chữ Hán"; kiểm tra sau deploy khi đó chỉ cảnh báo.
- `--url https://…`: địa chỉ dùng để kiểm tra sau deploy, ví dụ khi có tên miền riêng.

Muốn kiểm tra cả `/api/status` bằng `ADMIN_TOKEN` (gửi dạng `Bearer`, như công cụ dòng lệnh; không dùng tài khoản quản trị), đặt biến môi trường trước khi chạy và xóa ngay sau đó:

```powershell
$env:HOATRI_ADMIN_TOKEN = "<ADMIN_TOKEN của production>"
npm.cmd run deploy
Remove-Item Env:HOATRI_ADMIN_TOKEN
```

**Chỉ đổi cấu hình Worker trong `wrangler.jsonc`** (var, route, tên miền), không sửa trên dashboard. Theo mã nguồn wrangler 4.131.1 (chưa gặp thật): nếu lần thay đổi gần nhất của Worker làm trên dashboard và khác cấu hình trong repo, `wrangler deploy --strict` chạy không có terminal dừng với "Aborting the upload operation because of conflicts", mà lúc đó migration đã áp (script báo "Migration đã áp dụng; bản code cũ vẫn đang chạy."). Gặp thì chép thay đổi trên dashboard vào `wrangler.jsonc` rồi chạy lại. Deploy tay (không qua script) thì thêm `--var PDF_LAYOUT_VERSION:<mã>` (in bằng `node -e "import('./services/pdf-layout/version.mjs').then(m=>console.log(m.layoutVersion()))"`), không thì `/api/health?deep=1` không so được bộ kiểm tra bố cục (`"layoutMatch":null`).

**Quay lại** (script in sẵn các lệnh này kèm mã cụ thể):

- Code: `npx wrangler rollback <version-id>`. Lệnh này không hoàn tác migration hay secret. Nếu bản quay về dùng bộ kiểm tra bố cục khác dịch vụ PDF đang chạy (`/api/health?deep=1` báo `mismatch`), quay cả image dịch vụ (mục A.5). Quay về bản trước 27/10/2026 thì `/admin` lại đăng nhập bằng `ADMIN_TOKEN` như cũ; bảng tài khoản quản trị vẫn nằm trong D1 và được dùng lại khi deploy lại bản mới. Mục lịch sử dịch bằng Kỹ nhất khi đó hiện là Kỹ hơn. Deploy lại bản mới thì mục được lưu lại trong lúc chạy bản cũ giữ cách dịch đã chọn ở bản cũ, trừ mục Kỹ nhất được lưu lại là Kỹ hơn: mục đó hiện lại là Kỹ nhất (chưa chạy thử).
- Dữ liệu D1: `npx wrangler d1 time-travel restore DB --bookmark=<bookmark>`. Mọi thay đổi dữ liệu sau thời điểm đó bị xóa.
- R2 không có bản lưu nào ngoài bản sao lưu tự đặt (mục B.5): đối tượng đã xóa là mất hẳn.

### B.3 Kiểm thử tự động trên GitHub

`.github/workflows/ci.yml` chạy cho mỗi lần push lên `main` hoặc `handoff/**` và mỗi pull request. Nó không dùng secret nào của repo, không gọi Gemini và không chạm vào Cloudflare.

- **test** (Ubuntu 24.04, Node 24, Python 3.12):
  - chặn commit nhầm `.dev.vars`, `.env`, khóa Google, khóa riêng tư, `samples/`, `.wrangler/`;
  - `npm ci`, `prepare:vendor -- --require-paddle` (mô hình PaddleOCR lấy từ `backend/paddle-models/`, không tải mạng; thiếu PaddleOCR thì job đỏ), PyMuPDF và dữ liệu OCR;
  - `npm test` với `backend/test-support/no-paid-api.mjs` nạp trước;
    - Test máy PDF dùng Chromium của máy chạy CI và phông Liberation Serif như image: job cài `fonts-liberation2` cùng `fonts-dejavu-core` (không có `fonts-liberation2` thì dùng `fonts-liberation`), rồi đỏ nếu `fontPath()` của `services/pdf-layout/engine.mjs` không ra `LiberationSerif-Regular.ttf`, hoặc (từ lượt sửa thứ ba) tệp đó không có (`test -f`; `fontPath()` khi đó là `null` và bước in "PDF font: none"). Trước đó bước này qua được cả khi không có tệp phông nào.
    - Các test giao diện chỉ dành cho Edge (`book-ui`, `study-ui-*`, `reader-phone-ui`, `old-browsers`…, danh sách ở ONBOARDING mục 7) được bỏ qua.
    - Job đỏ nếu một test cần Python bị bỏ qua (kể cả `pdf-extract-text-layer` và `pdf-extract-shapes` của lượt sửa thứ ba), vì khi đó bước cài Python đã hỏng.
  - `wrangler deploy --dry-run`.
- **pdf-image:**
  - kiểm `docker-compose.yml` và `Caddyfile`;
  - build `services/pdf-layout/Dockerfile`;
  - chạy container với cùng giới hạn như compose, rồi kiểm tra:
    - nó tự báo healthy, và `/health` báo `"font":"LiberationSerif-Regular.ttf"` (từ lượt sửa thứ ba, `/health` chỉ báo tên này khi tệp có thật, nên kiểm tra này mới có ý nghĩa);
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
  - dịch vụ dùng phông DejaVu Serif như image Linux trước bản 22/10/2026 (nay image dùng Liberation Serif);
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

**Lượt sửa dịch vụ PDF (22/10/2026), trên máy Windows, không Docker, không gọi Gemini:**

- `smoke.mjs` đạt với `server.mjs` và `engine.mjs` mới, cả khi xuất bằng Liberation Serif 2.1.5 lấy từ gói Debian `fonts-liberation2` (`PDF_FONT_PATH`). PDF xuất ra chỉ nhúng LiberationSerif; đủ 146 chữ Việt (hoa, thường, mọi dấu, đ/Đ) đều vẽ bằng phông này, không mượn phông khác. Độ rộng chữ đo bằng PyMuPDF trùng Times New Roman (tỉ lệ 1,0000; DejaVu Serif rộng hơn khoảng 26%).
- `node services/pdf-layout/server.mjs` thật, với Node đóng vai Python: trả 503 kèm `Retry-After` khi đầy; dừng Python ngay khi người gọi ngắt kết nối (bản cũ để Python chạy tiếp tới hết).
- Edge thật: một lần xuất bị dừng giữa chừng đóng trình duyệt ngay; quá hạn thì báo hết thời gian.
- Bộ nhớ của Worker, đo bằng Node 24 (V8, không phải workerd) với một bản kê giả 14,3 MiB của 12 trang scan, bộ nhớ còn giữ ở mỗi lần chờ I/O: tách trang 89,6 → 39,9 MiB; đọc ảnh OCR 87,5 → 35,4 MiB; tải bản kê 86,3 → 5,6 MiB; xuất PDF 86,2 → 43,9 MiB. Khi các lượt OCR đến cách nhau, 32 lượt OCR chạy cùng lúc vẫn nằm trong 128 MiB vùng nhớ V8 (bản cũ: 6).

**Lượt sửa thứ hai (22/10/2026), trên máy Windows, không Docker, không gọi Gemini** (do các lượt sửa ghi lại; người viết runbook này không chạy lại):

- `server.mjs` thật ở `127.0.0.1` với `extract.py` mới, rồi `smoke.mjs`: đạt cả sáu bước (`/health`, `/font`, `/extract` 2 trang, 7 block, 1 công thức; `/render`; `verify.py` lệch điểm ảnh trung bình 0,000; OCR trang scan 56 chữ Hán trong 4 block). Với `extract.py` ngay trước bản sửa, smoke không đạt: công thức `|a| = 1` bị MuPDF tách khỏi dòng `向量的长度` và không thuộc block nào; nay hai phần là một block.
- Test HTTP của dịch vụ (`backend/pdf-layout-service.test.mjs`): JSON hỏng, `X-PDF-Pages` hỏng (400), thân yêu cầu 26 MiB và 41 MiB (413 sau khi đọc hết), trình duyệt không khởi động được (500 `browser`, không để lại thư mục hồ sơ tạm của Puppeteer). Một luồng 200 MiB bị cắt kết nối sau khoảng 89 MiB, sau đó `/health` vẫn 200. `backend/pdf-engine-browser.test.mjs` xuất thật bằng Edge một tài liệu ba trang có block tràn ở trang đầu và trang cuối, và nhận đúng danh sách "Đoạn k" của cả hai trang trong một câu trả lời.
- `docker compose config` cho `PDF_EXTRACT_SECONDS` là `"170"`. `security.txt` được phục vụ như tệp tĩnh: suy ra từ mã nguồn wrangler 4.131.1 (thư mục bắt đầu bằng dấu chấm vẫn được tải lên, kiểu `text/plain; charset=utf-8`), chưa chạy `wrangler dev`.
- `node backend/deploy.mjs --check --skip-tests` trên repo này dừng ở bước 1 đúng như mong đợi: `database_id` còn `local-db`, chỗ trống trong `security.txt` và hai trang pháp lý, tệp chưa commit, commit chưa có trên `origin/handoff/2026-10-16`. Không gọi Cloudflare.

**Lượt sửa thứ ba (23/10/2026), trên máy Windows, không Docker, không gọi Gemini** (do các lượt sửa ghi lại; người cập nhật runbook này không chạy lại):

- `server.mjs` thật ở `127.0.0.1` với `extract.py` mới, rồi `smoke.mjs`: đạt cả sáu bước, hai lần.
- `server.mjs` và `healthcheck.mjs` gọi qua một thư mục junction: dịch vụ trả `/health`, còn `healthcheck.mjs` thoát 1 khi không có dịch vụ. Với mã trước đó, `server.mjs` thoát 0 ngay mà không mở cổng và `healthcheck.mjs` thoát 0. `npm run deploy` gọi qua junction cũng chạy (trước đó không in gì).
- Lệnh `node -e` của bước kiểm phông trong `Dockerfile`, chạy tay: thoát 1 khi không có tệp hay khi tệp là DejaVu Serif, thoát 0 khi có Liberation Serif. Lệnh của `Dockerfile` cũ thoát 0 cả khi đường dẫn Liberation không có tệp.
- Test HTTP của dịch vụ (`backend/pdf-layout-service.test.mjs`, engine thật, không mở trình duyệt): thiếu tệp phông thì `/health` báo `"font":null`, `/font` và `/render` trả 500 `code:"font"`; header `X-PDF-All-Pages: 1` cho lượt đó `PDF_EXTRACT_SECONDS=225`. Với `extract.py` thật (bản của `864cbf3`, vì bản mới khi đó đang được sửa) và `PDF_EXTRACT_SECONDS=0.000001`, lượt thường trả 1 trang, lượt có header trả đủ 4 trang.
- Test của Worker (`backend/pdf-layout.test.mjs`): trả lời bận (429, 503) mà không đọc byte nào của thân yêu cầu; `GET /capacity`; dịch vụ trả 401, 403, 404 thành 503 `pdf_unavailable` và hạn mức ngày được trả lại; lần xuất trùng một lần lưu khác trả 409 và không ghi gì.
- Không chạy trong lượt này: các test xuất PDF bằng Edge của `pdf-layout-service` và `pdf-engine-browser` (máy còn dưới 1,2 GB đĩa trống lúc đó), `docker build`, CI trên GitHub.

**Lượt sửa thứ tư (23/10/2026), trên máy Windows, không Docker, không gọi Gemini** (do các lượt sửa ghi lại; người cập nhật runbook này không chạy lại):

- `server.mjs` thật ở `127.0.0.1` với `extract.py` mới, rồi `smoke.mjs`: đạt cả sáu bước. Lần chạy này dùng cây code khi các lượt sửa khác còn đang sửa `server.mjs`, `engine.mjs` và `backend/pdf-layout.js`.
- Tải lên nhỏ giọt (mỗi 10 giây một byte), với `worker.fetch` thật trên D1 SQLite và với workerd qua Miniflare (Worker đóng gói như `backend/build.mjs`, kết nối thô): trong lúc hai tài khoản gửi dở, chỉ lượt `pdf:<tài khoản>` của họ bị giữ, `GET /capacity` của học sinh khác báo còn đủ chỗ và lượt tách trang của học sinh đó tới được dịch vụ; khoảng 120 s sau, cả hai kết nối đang gửi dở nhận "HTTP/1.1 408" kèm câu tiếng Việt và không còn lượt nào bị giữ; tệp tải xong sau khi cả hai chỗ đã có người nhận 503 `pdf_service_busy`. Với đồng hồ thật, `/render` khai 120 byte nhận 408 ở 120 s, `/extract` khai 2,5 MB nhận 408 ở 153 s (đúng quy tắc 16 KB/s). Với mã của lượt thứ ba, cùng cảnh đó giữ cả 2 chỗ và học sinh khác nhận 503.
- Các bước tái hiện của lượt kiểm chứng đầu vẫn đạt: Worker nối với dịch vụ thật trên máy (Python thật) tách trang trả 201 với một tệp multipart thật, đọc qua luồng mới; dịch vụ trả 401 thành 503 `pdf_unavailable`; làm mới bố cục quá nặng thành 413 kèm lời khuyên; `server.mjs` gọi qua một thư mục junction vẫn trả `/health` 200.
- Test của Worker (`backend/pdf-layout.test.mjs`, route lịch sử thật trên SQLite với mọi migration, R2 giả có etag): một tab lưu lại đúng bản dịch trong lúc xuất thì lần xuất vẫn được giữ (200) và gắn vào phần ở lần lưu mới; lưu bản dịch khác thì 409 và lượt xuất trong ngày được trả lại.
- Test xuất PDF bằng Edge thật (`backend/pdf-engine-browser.test.mjs`): câu báo tràn khung của tài liệu ba trang đúng nguyên văn mới ("Trang N · đoạn k").

**Đợt 27/10/2026, trên máy Windows, không Docker, không gọi Gemini** (do các lượt sửa ghi lại; người cập nhật runbook này không chạy lại):

- Test của dịch vụ (`backend/pdf-extract-quality.test.mjs`): header `X-PDF-Quality: fine` tới `extract.py` thành `quality: fine`; giá trị khác hay không có header là `standard`. Phần Python của tệp đó chạy các trang scan tổng hợp của `services/pdf-layout/test_scan_quality.py` (chỉ số chữ cái, kể cả chỉ số có dấu chấm ở cuối hàng, hệ `cases` và hệ dưới ngoặc nhọn mà OCR đọc ra chữ Hán, chữ Hán và dấu phẩy sát công thức, chữ Hán ít nét trên dòng OCR đọc sai, ô công thức đứng riêng, tiêu đề trên nền màu, dòng ngắn, cảnh báo dpi, bản quét nhiều lớp hay thô dưới 30 dpi, tờ mịn).
- Test của Worker (`backend/pdf-layout.test.mjs`): lượt tách trang theo phạm vi và lượt của "Dịch cả quyển" gửi `X-PDF-Quality: fine` chỉ với Kỹ nhất; manifest giữ `sheetQuality`; lần làm mới bố cục theo cách dịch được nêu, không nêu thì theo `sheetQuality` đã lưu. Bản PDF mà dịch vụ dựng bằng mã bố cục khác `PDF_LAYOUT_VERSION` (image cũ không trả `layoutVersion`, mã khác, khác chữ hoa thường) không được lưu: 503 `pdf_service_outdated`, chương không trỏ tới PDF nào, lượt xuất trong ngày được trả lại, Workers Logs có dòng `pdf_service_outdated`; mã khớp thì lưu như cũ; không có `PDF_LAYOUT_VERSION` thì không so. Test của dịch vụ (`backend/pdf-layout-service.test.mjs`): `/render` trả kèm `layoutVersion`.
- Chữ máy đọc của ảnh công thức có dấu `$` (`backend/pdf-block-ocr.test.mjs`, `backend/study-history-sqlite.test.mjs`, `backend/study-ui-layout.test.mjs` trên Edge): `$'`, `$$`, `$&` được ghép vào chữ của đoạn, chữ lưu vào Thư viện và bản dịch của Xưởng dịch đúng nguyên văn.
- Mã công thức mà trang in nguyên văn (`backend/pdf-block-ocr.test.mjs`, `backend/pdf-block-translation.test.mjs`): công thức có dấu mở đóng chứa ma trận hay `cases` cùng hàng và cột của chính nó không bị tính; `\(`, `\[` mở mà không đóng, `\)`, `\]` không có dấu mở thì bị tính (bản đọc đáng ngờ `tex`, cảnh báo của bản dịch); `$$` của shell không bị tính. "Dịch cả quyển" (`backend/whole-book.test.mjs`): 503 `pdf_service_outdated` tạm dừng ngay với câu của máy chủ, không thử lại như mất kết nối.
- Test của script deploy (`backend/deploy.test.mjs`, Cloudflare giả lập): cảnh báo khi chưa có tài khoản quản trị, câu báo `ADMIN_TOKEN` quá ngắn mới, cảnh báo `ADMIN_TRANSLATION_MODE` sai, cảnh báo `GEMINI_THINKING` sai.
- Việc dịch của quản trị viên (`backend/thinking-budget.test.mjs`, D1 giả trên `node:sqlite`, Gemini giả): token của bước Gemini đọc ảnh và của lượt gọi lỗi (bị cắt, không có chữ, bị chặn, trùng văn bản có bản quyền) vào cột token và checkpoint, vào dòng tiến độ khi việc đã đọc trang hay dịch phần; việc bị lỗi ngay từ bước đầu vẫn lưu được bản biên tập tay (`PATCH /api/jobs/:id` trả 200), việc đã có phần làm xong thì không (400); `GEMINI_THINKING` sai (ví dụ `Medium`) bị bỏ qua, mỗi bước dùng mức của Cách dịch.
- Lịch sử dịch sau khi quay lại bản trước (`backend/study-history-sqlite.test.mjs`): mục mà bản cũ lưu lại chỉ bằng cột `mode` hiện đúng cách dịch chọn ở bản cũ, trừ Kỹ nhất được lưu lại là Kỹ hơn.
- Đăng nhập quản trị (`backend/admin-auth.test.mjs`, D1 giả trên `node:sqlite`; `backend/admin-login-ui.test.mjs`, Edge với API giả lập): tạo tài khoản đầu tiên, đăng nhập, khóa tạm, hết phiên theo đồng hồ giả, đăng xuất, đổi và đặt lại mật khẩu, thêm và xóa quản trị viên, cookie không có header thì không có quyền gì, `Bearer` vẫn dùng được.

**CI trên GitHub (23/10/2026, commit 6c80e60, [lần chạy 39894021295](https://github.com/rynwoo1707/chinese-translator/actions/runs/39894021295)):** cả hai job đạt.

- Job `test` (2,1 phút): `prepare:vendor -- --require-paddle`; cài phông rồi kiểm `fontPath()` ra Liberation Serif có tệp thật (`test -f`); `npm test` trên Linux với API trả phí bị chặn, không test Python nào bị bỏ qua; đóng gói Worker (`wrangler deploy --dry-run`).
- Job `pdf-image` (3,3 phút): build image có `fonts-liberation2` và bước kiểm phông lúc build; container chạy với giới hạn của `docker-compose.yml`, báo healthy theo `HEALTHCHECK`, không chạy bằng root, đòi token, `/health` báo `"font":"LiberationSerif-Regular.ttf"`; `smoke.mjs` trong container đạt; compose + Caddy qua HTTPS cho `localhost` (chuyển HTTP sang HTTPS, chặn đường dẫn lạ, thân yêu cầu 39 MiB).

Chưa kiểm chứng:

- Việc tự khởi động lại container sau 4 lần kiểm tra sức khỏe lỗi liên tiếp chưa chạy thử (CI chỉ thấy container healthy).
- Bộ nhớ trên workerd thật: chạy thử trên Cloudflare với `wrangler tail` (vài lượt tách trang 12–20 trang scan cùng lúc), xem có lỗi vượt bộ nhớ không.
- Sức chứa của VPS thật: số trang tách được mỗi phút và RAM cao nhất khi 2 việc chạy cùng lúc (`docker stats`), trước khi tăng `PDF_LAYOUT_JOBS` và `PDF_LAYOUT_SLOTS`.
- Các test giao diện chỉ dành cho Edge chưa chạy trên Linux: CI bỏ qua chúng; chúng chỉ chạy trên máy Windows có Edge.
- Cấp chứng chỉ thật và chạy trên máy chủ thật.
- Deploy thật lên Cloudflare: D1, R2, secret, giới hạn của Workers Paid. Các kiểm tra mới của script (commit đã push, từ điển, `security.txt`, `http://` chuyển sang `https://`) mới chạy với Cloudflare và git giả lập trong `backend/deploy.test.mjs`.
- Của lượt sửa thứ ba: lần ghi `state.json` có điều kiện của bước xuất PDF (R2 `onlyIf.etagMatches`) mới chạy với R2 giả trong test, chưa với R2 thật hay miniflare; việc Worker trả 429/503 mà không đọc thân yêu cầu chưa thử trên Cloudflare thật (trình duyệt dùng HTTP/1.1 có thể thấy kết nối bị cắt thay vì câu trả lời; lượt kiểm chứng thứ hai thấy dưới `wrangler dev` thật, Edge nhận đủ 429/503 với tệp 8 KB–16 MB, chỉ Miniflare chạy trần mới cắt kết nối); `GET /capacity` chưa chạy trên D1 thật.
- Của lượt sửa thứ tư: thời hạn tải lên (408 `upload_timeout`) chưa thử qua trình duyệt hay trên Cloudflare (ở máy local dùng HTTP/1.1, Chromium có thể tự gửi lại một lần yêu cầu nhận 408 trên một kết nối keep-alive dùng lại); việc Worker nhận ra lần từ chối của bộ kiểm tra chỗ lịch sử dựa vào chữ "CHECK constraint failed" trong lỗi của D1, mới kiểm bằng `node:sqlite`; image chưa được build với các bản sửa của `extract.py`, `engine.mjs`, `server.mjs`.
- Của đợt 27/10/2026: image chưa được build với `extract.py`, `server.mjs`, `frontend/math-text.js` và `frontend/pdf-box-layout.js` mới, nên `smoke.mjs` và CI chưa chạy với chúng; công thức nhiều dòng mới chỉ được dựng bằng Edge trên Windows, chưa bằng Chromium và các phông của image; `X-PDF-Quality` chưa đi qua Caddy thật; đăng nhập quản trị (cookie `cat_hien_admin`, SameSite=Strict, Secure qua HTTPS) và các lệnh D1 mới chưa chạy trên Cloudflare thật; các mức suy luận mới và tờ OCR mịn chưa thử với Gemini thật.
- Các lệnh sao lưu và khôi phục ở mục B.5.

### B.5 Sao lưu và khôi phục dữ liệu (D1, R2)

> **(chưa chạy thử)** Các lệnh dưới đây theo tài liệu của Cloudflare (D1 import/export, Time Travel) và của rclone cho R2, chưa chạy trên tài khoản thật. Hãy chạy thử trọn một lần, cả bước khôi phục, trước khi có người dùng.

Cloudflare tự giữ gì: D1 có Time Travel (khôi phục tại chỗ về một thời điểm trong 30 ngày với Workers Paid, 7 ngày với gói Free); R2 không có bản sao nào. Mọi thứ nằm trong một tài khoản Cloudflare: một lỗi xóa, một thao tác nhầm, hay tài khoản bị khóa hoặc bị chiếm là mất bản gốc và bản dịch của học sinh.

**Chuẩn bị một lần**

- Bật xác thực hai lớp cho tài khoản Cloudflare và GitHub.
- Máy chạy sao lưu: máy dùng để deploy (đã `npx wrangler login`, có repo) hoặc máy chủ PDF (cài thêm Node 22.13+ và chạy `npm ci` trong bản clone). Chạy theo lịch không người trông thì dùng một API token riêng (biến `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`) chỉ có quyền D1 của account, thử bằng một lần xuất bằng tay trước khi đặt lịch; đừng dùng token deploy. **Không** dùng GitHub Actions: repo công khai, và người ngoài có thể tải artifact của nó.
- Nơi cất ngoài Cloudflare: ổ cứng ngoài, NAS hoặc dịch vụ lưu trữ khác (Backblaze B2, S3…), đủ chỗ cho dung lượng R2 đang dùng (xem dashboard R2) cộng các bản D1.
- R2 API token chỉ đọc: dashboard → R2 → Manage R2 API Tokens → Create API token, quyền "Object Read only", chỉ bucket `muc-viet-files`. Cất Access Key ID, Secret Access Key và Account ID trong trình quản lý mật khẩu.
- `rclone` bản 1.59 trở lên (bản cũ hơn có thể báo `401 Unauthorized` với R2). Chạy `rclone config` để tạo hai remote: `r2` (đọc R2) như dưới đây, và `sao-luu` kiểu `crypt` trỏ vào nơi cất, để bản sao được mã hóa. Cất mật khẩu của `sao-luu` riêng: mất nó là không mở được bản sao.

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = https://<Account ID>.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
```

**Mỗi đêm** (khoảng 3:00; khi còn ít người dùng thì mỗi tuần), trong thư mục dự án (PowerShell; Linux thì đổi `npx.cmd` thành `npx`, `$ngay` lấy bằng `ngay=$(date +%F)`):

```powershell
$ngay = Get-Date -Format yyyy-MM-dd
npx.cmd wrangler d1 export DB --remote --output "muc-viet-$ngay.sql"                    # D1 bị khóa trong lúc xuất: chạy lúc vắng người
rclone move "muc-viet-$ngay.sql" sao-luu:d1/                                             # mã hóa rồi xóa bản không mã hóa trên máy
rclone sync r2:muc-viet-files sao-luu:r2/hien-tai --backup-dir "sao-luu:r2/da-xoa/$ngay"   # tệp đã xóa hay bị thay trên R2 chuyển sang da-xoa/<ngày>
rclone delete sao-luu:d1 --min-age 30d                                                   # giữ bản D1 30 ngày
```

- Xóa các thư mục `sao-luu:r2/da-xoa/<ngày>` cũ hơn thời hạn giữ bằng `rclone purge sao-luu:r2/da-xoa/<ngày>` (đừng dùng `--min-age` ở đây: tệp giữ ngày tải lên gốc, không phải ngày bị xóa).
- Đặt lịch bằng Task Scheduler (Windows) hoặc `cron` (Linux), ghi nhật ký ra tệp và xem lại mỗi tuần.
- Bản sao chứa email, mã băm mật khẩu và tài liệu riêng của học sinh, kể cả dữ liệu của tài khoản đã xóa, tới khi bản sao hết hạn. Chọn thời hạn giữ (ví dụ 30 ngày, bằng Time Travel), ghi vào trang quyền riêng tư (hiện trang chưa nói về sao lưu), và xóa đúng hạn.

**Khôi phục**

1. Lỗi xảy ra trong 30 ngày, D1 còn nguyên trên Cloudflare: dùng Time Travel. Lệnh ghi đè tại chỗ và in một bookmark để hoàn tác.
   ```powershell
   npx.cmd wrangler d1 time-travel info DB --timestamp=2026-11-02T08:00:00+07:00   # bookmark của thời điểm trước sự cố
   npx.cmd wrangler d1 time-travel restore DB --bookmark=<bookmark>
   ```
   Time Travel không đưa lại tệp R2 đã xóa sau thời điểm đó: chép lại từ `sao-luu:r2/da-xoa/<ngày>` (bước 3).
2. Mất D1, hoặc sự cố cũ hơn 30 ngày: nhập bản xuất vào một D1 mới, kiểm tra, rồi trỏ Worker sang đó.
   ```powershell
   rclone copy sao-luu:d1/muc-viet-<ngày>.sql .
   npx.cmd wrangler d1 create muc-viet-khoi-phuc --location apac                # wrangler hỏi có thêm vào cấu hình không thì trả lời không
   npx.cmd wrangler d1 execute muc-viet-khoi-phuc --remote --file muc-viet-<ngày>.sql
   npx.cmd wrangler d1 execute muc-viet-khoi-phuc --remote --command "SELECT (SELECT COUNT(*) FROM d1_migrations) AS migrations, (SELECT COUNT(*) FROM reader_users) AS users, (SELECT COUNT(*) FROM study_sessions) AS sessions"
   ```
   - `migrations` phải bằng số tệp trong `database/migrations/` của commit đang chạy. Bảng `d1_migrations` thiếu hay thiếu dòng thì đừng chạy `npm run deploy` lên D1 này (script sẽ áp lại từ đầu và lỗi vì bảng đã có): tìm hiểu trước.
   - Nhập báo lỗi khóa ngoại: thêm dòng `PRAGMA defer_foreign_keys = true;` ở đầu tệp rồi nhập vào một D1 mới khác. Báo "cannot start a transaction within a transaction": bỏ các dòng `BEGIN TRANSACTION` và `COMMIT` trong tệp.
   - Trỏ Worker sang D1 mới: sửa `database_name` và `database_id` của binding `DB` trong `wrangler.jsonc` (UUID in ra ở lệnh `d1 create`), commit, `npm run deploy`.
3. R2: tạo tạm một token "Object Read & Write" cho `muc-viet-files` và một remote `r2-ghi` dùng nó, rồi `rclone copy sao-luu:r2/hien-tai r2-ghi:muc-viet-files` (thêm từ `sao-luu:r2/da-xoa/<ngày>` nếu cần); xong thì xóa token đó.
4. Khôi phục D1 và R2 từ **cùng một đêm**: hàng D1 trỏ tới tệp R2 (bản gốc, manifest, PDF đã dịch), nên lệch thời điểm thì tải cả quyển, "Song ngữ" hay lịch sử sẽ báo thiếu tệp.

**Diễn tập mỗi quý:** làm bước 2 vào một D1 thử (`muc-viet-thu`), so số dòng với production, rồi xóa nó (`npx.cmd wrangler d1 delete muc-viet-thu`); chép về máy một tệp PDF bất kỳ trong `sao-luu:r2/hien-tai/study/` và mở thử.
