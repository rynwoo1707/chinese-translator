# Ví dụ mẫu cho trang chủ (`npm run samples`)

Công cụ làm bản dịch mẫu giữ bố cục trang **mà không gọi Gemini**:

1. App tách trang trên máy này, miễn phí.
2. Người dịch (Claude hoặc người) đọc ảnh trang, viết chữ Trung đúng và bản dịch tiếng Việt vào `texts.json`.
3. App kiểm tra bằng đúng các bước kiểm tra của Hoa Trí, dựng PDF tiếng Việt, rồi đăng qua API quản trị có sẵn.

## Cần có

- `npm run setup` đã chạy xong: Python + PyMuPDF trong `.runtime`, trình duyệt Edge/Chromium, phông chữ.
- Dữ liệu OCR cho trang scan: `npm run prepare:pdf-ocr`.
- Không cần chạy dịch vụ PDF và không cần khóa Gemini.

## An toàn

- Công cụ chỉ đọc và ghi trong `samples/`, thư mục git bỏ qua. Nếu git không bỏ qua tệp, công cụ từ chối làm việc.
- Mọi yêu cầu mạng bị chặn, trừ địa chỉ đăng (`--target`). Các biến `GEMINI_*` bị xóa khỏi môi trường của lệnh.
- Mã quản trị:
  - Máy chủ trên máy này (`local`, `127.0.0.1`, `localhost`): lấy `ADMIN_TOKEN` trong `.dev.vars`.
  - Máy chủ khác: bắt buộc HTTPS; lấy mã từ biến `HOATRI_ADMIN_TOKEN` hoặc nhập ẩn khi được hỏi. Không bao giờ dùng `.dev.vars`.
  - Mã không bị in ra hay ghi vào tệp nào.
- Chỉ đăng khi `rights.confirmed` trong `sample.json` là `true`: chủ sách xác nhận được phép công bố các trang gốc và bản dịch.
- Ví dụ mẫu không tạo bản dịch (job) nào, nên Xưởng dịch không bao giờ giới thiệu nó như bản dịch đã công bố của cùng tệp: dòng "Học liệu của Hoa Trí đã công bố bản dịch của đúng tệp này" chỉ hiện với bản dịch do xưởng dịch admin công bố.

## Các bước

```
npm run samples -- init tai-lieu-mau --pdf "D:\Tai-lieu\tai-lieu-mau.pdf" --title "Tài liệu mẫu"
```
Lệnh này chép PDF thành `samples/tai-lieu-mau/source.pdf` và tạo `sample.json`. Tên tệp gốc dài hay có chữ Trung đều được. Mở `sample.json` để điền:

| Trường | Ý nghĩa |
|---|---|
| `title` | Tên sách trên trang chủ, tối đa 200 ký tự. Trang chủ tự gắn nhãn “Ví dụ mẫu”; chỉ máy chủ cũ (chưa có ví dụ mẫu) mới cần chữ này trong tên. |
| `author` | Tác giả hoặc nhà xuất bản, hiện trên thẻ sách. |
| `genre` | Một trong 10 lĩnh vực của thư viện, ví dụ `"Toán học · STEM"`. |
| `domain` | Môn của sách, như trong Xưởng dịch: `general`, `math`, `history`, `physics`, `chemistry`, `biology` hoặc `informatics`. Mỗi môn thêm bảng thuật ngữ SGK của môn đó vào `RULES.md`. |
| `ranges` | Các trang cần dịch, ví dụ `["5-9", "12"]`. Mỗi mục là một phần (chương), tối đa 20 trang mỗi phần. Nên chọn 3–5 trang. |
| `cover` | `"auto"` (tự nhận bìa ở trang 1–2), số trang bìa, hoặc `"none"`. |
| `translateCover` | `false`: bìa giữ ảnh gốc và được bỏ khỏi `ranges`. |
| `publishSource` | `"excerpt"` (mặc định): người đọc nhận bản gốc gồm bìa và các trang đã dịch. `"full"`: cả tệp gốc (tối đa 100 MB), chỉ khi được phép công bố cả quyển. |
| `glossary` | Thuật ngữ Trung → Việt bắt buộc dùng, ví dụ `{"细胞": "tế bào"}`. |
| `rights` | Mặc định nên ghi `{"localOnly": true, "note": "…"}`: sách chỉ được đăng lên máy chủ trên máy này, không bao giờ lên trang công khai. Chỉ khi chủ sách cho phép công bố các trang gốc và bản dịch mới đổi thành `{"confirmed": true, "note": "ai cho phép, phạm vi"}`. Sách còn bản quyền luôn giữ `localOnly`. |

Sau đó chạy:

```
npm run samples -- extract tai-lieu-mau
```
Lệnh này tạo `samples/tai-lieu-mau/work/`:
- `RULES.md`: quy tắc đọc ảnh và dịch, chép nguyên văn quy tắc Hoa Trí gửi Gemini;
- mỗi phần một thư mục `c01/`, `c02/`…: `blocks.json` (danh sách đoạn), `texts.template.json`, ảnh trang `pages/`, ảnh đoạn trang scan `crops/` và `sheets/`, ảnh công thức `inlines/`.

PDF lớn hơn 25 MB vẫn dùng được: công cụ cắt riêng các trang đã chọn trước khi tách.

Người dịch đọc `work/RULES.md`, chép `texts.template.json` thành `texts.json` trong cùng thư mục rồi điền. Sau đó lặp lại cho đến khi không còn lỗi:

```
npm run samples -- check tai-lieu-mau c01      # mọi lỗi và cảnh báo trong một lượt
npm run samples -- render tai-lieu-mau c01     # check rồi dựng render/c01.vi.pdf và ảnh render/p<trang>.compare.png
npm run samples -- status tai-lieu-mau         # phần nào đã sẵn sàng đăng
```
Nếu chữ Việt không vừa khung, `render` báo lỗi "Trang N: chữ Việt không vừa box (p4-b1, …), kể cả ở cỡ chữ nhỏ nhất…", nêu một lần mọi đoạn không vừa của mọi trang trong phần (từ 22/10/2026; trước đó nó dừng ở trang đầu tiên có đoạn tràn). Hãy dịch gọn hơn (không bỏ ý). `--preview-overflow` cho xem bản lỗi nhưng bản đó không đăng được.

## Đăng, thay, gỡ

```
npm run samples -- publish tai-lieu-mau --draft              # bản nháp: chỉ quản trị viên xem được
npm run samples -- publish tai-lieu-mau --replace            # công khai, thay bản đã đăng (giữ nguyên mã sách)
npm run samples -- unpublish tai-lieu-mau                    # ẩn sách, giữ nguyên mã; publish --replace để hiện lại
npm run samples -- remove tai-lieu-mau --yes                 # xóa sách khỏi máy chủ, giữ nguyên thư mục làm việc
```
- `--target` mặc định là `local` (`http://127.0.0.1:8787`, máy chủ mở bằng `start.cmd`).
- Đăng vào thư viện thật trên máy này sẽ ghi vào `.wrangler/state`. Hãy sao lưu thư mục đó trước.
- Lên máy chủ thật, chỉ với sách có `"rights": {"confirmed": true}` và không có `"localOnly": true` (`localOnly` chặn mọi máy chủ ngoài máy này):
  ```
  $env:HOATRI_ADMIN_TOKEN="…"
  npm run samples -- publish tai-lieu-mau --target https://ten-mien
  ```
  (PowerShell; bỏ trống biến này thì lệnh sẽ hỏi mã.)
- Còn cảnh báo thì lệnh dừng lại hỏi. Thêm `--yes` để đăng luôn.
- Kết quả được ghi vào `samples/<mã>/published.json` (mã sách, các phần, PDF gốc, thời gian; không có mã quản trị).

Trên máy chủ có ví dụ mẫu (bản Hoa Trí này, đã áp migration 0015), `publish`:
1. tạo sách nháp gắn với mã ví dụ mẫu (`sample:<mã>`); với `--replace` thì ẩn sách đã có và xóa các phần cũ, giữ nguyên mã sách và đường dẫn;
2. tải PDF gốc lên: mặc định là trích đoạn `work/excerpt.pdf` gồm bìa và các trang đã dịch (cắt bằng PyMuPDF, lần sau dùng lại nếu không đổi). Mỗi trang của trích đoạn mang số trang của nó trong sách (nhãn trang PDF), và máy chủ ghi lại các số trang đó (`X-Book-Pages`), nên “Đọc song ngữ” hiện “Trang 7” cho trang 7 của sách chứ không phải “Trang 2” (vị trí trong trích đoạn), và tệp “Tải cả quyển” cũng đánh số theo sách;
3. tải ảnh bìa (kèm số trang của nó trong PDF gốc) và từng phần, kèm vị trí và các trang gốc mà phần đó dịch. Với `--replace`, nếu bản mới không có ảnh bìa (`"cover": "none"` hoặc thiếu `work/cover.jpg`) thì ảnh bìa cũ bị xóa; máy chủ cũ chưa xóa được ảnh bìa thì lệnh dừng trước khi thay đổi gì;
4. ghi bảng thuật ngữ, xóa PDF gốc cũ không còn phần nào dùng, rồi mới công khai (trừ khi có `--draft`).

Nhờ PDF gốc và số trang, người đọc có “Tải cả quyển” (ghép như bản gốc: bìa và trang chưa dịch giữ nguyên) và “Đọc song ngữ”. Đăng xong, công cụ tự kiểm tra như người đọc chưa đăng nhập: sách có trong `/api/library` với nhãn ví dụ mẫu, các phần đúng thứ tự, PDF tải về trùng từng byte với bản đã dựng, mỗi phần đúng trang gốc và đúng số trang sách, PDF gốc tải được, ảnh bìa đúng ảnh đã tạo (hoặc không còn ảnh bìa nào). Bản nháp thì không ai xem được. Nếu kiểm tra hỏng: sách mới bị gỡ; sách đang thay ở lại dạng nháp để sửa rồi chạy lại.

Ví dụ mẫu đã đăng trước khi có số trang sách thì cần `publish <mã> --replace` một lần: trích đoạn được cắt lại (có nhãn trang) và tải lên kèm số trang sách.

Máy chủ cũ (chưa có ví dụ mẫu) vẫn đăng được như trước: sách thường, không có PDF gốc; `--replace` tạo sách mới rồi xóa sách cũ nên mã sách đổi; tên sách nên có chữ “Ví dụ mẫu”. Khi máy chủ đã cập nhật, `publish --replace` đổi sách cũ đó thành sách ví dụ mẫu. Máy chủ mới mà chưa áp migration 0015 thì lệnh dừng trước khi tải gì lên và nhắc chạy `npm run db:local` hoặc `npx wrangler d1 migrations apply DB --remote`.

## Ghi chú

- Trang không có đoạn chữ Trung vẫn nằm trong phần, giữ nguyên ảnh gốc.
- Chữ Hán nằm ngoài mọi đoạn sẽ giữ nguyên trong bản xuất. `check` có cảnh báo khi gặp trường hợp này.
- Thuật ngữ được tính theo từ dài nhất khớp tại mỗi chỗ: `RULES.md` và cảnh báo thuật ngữ của `check` không bắt dùng “khối lượng” (质量) bên trong 质量数 (số khối) khi môn của sách đã có từ ghép đó.
- PDF dựng trên Windows dùng phông Times New Roman. Từ 22/10/2026, bản xuất của học sinh trên máy chủ Linux dùng Liberation Serif, có cùng độ rộng chữ với Times New Roman, nên chữ trong hai bản dàn gần như giống nhau (chưa so trên tài liệu thật). Trước đó máy chủ dùng DejaVu Serif, rộng hơn khoảng 26%.
- Chạy lại `extract --force` thì thư mục `work` cũ được giữ lại thành `work.old-…`. `texts.json` của các phần có cùng trang được chép sang. Từ 22/10/2026, bộ tách gộp các dòng của trang có lớp chữ thành đoạn văn và đánh số đoạn theo thứ tự đọc (trang hai cột: hết cột này mới sang cột kia), nên tách lại một phần cũ có thể ra mã đoạn khác, hoặc cùng mã mà khác nội dung. `check` báo được mã thiếu ("Thiếu đoạn …") hay lạ ("Mã đoạn lạ …"), còn đoạn cùng mã mà khác nội dung thì không: với phần có trang lớp chữ hoặc trang hai cột, đối chiếu lại `texts.json` vừa chép sang với `blocks.json` mới. Trang scan một cột giữ nguyên các đoạn như trước.
- Lượt sửa thứ hai của bộ tách (cũng 22/10/2026) đổi thêm `source` của trang có lớp chữ: công thức, số hay chữ Latin mà MuPDF tách khỏi dòng chữ Hán được gộp vào đoạn của dòng đó thành mã `@@PDF_INLINE_n@@` mới; bộ thủ Khang Hy và chữ Hán "tương thích" được đổi về chữ Hán thường; ô của bảng kẻ sát chữ không còn nhận `____` giả. Sau `extract --force`, bản dịch đã chép sang mà thiếu mã công thức mới bị `check` báo lỗi: thêm mã đó vào đúng chỗ trong `translation` (ảnh của nó nằm trong `inlines/`).
- Lượt sửa thứ ba của bộ tách (23/10/2026) đổi tiếp `source` và cách chia đoạn của trang có lớp chữ (chi tiết: `docs/pdf-layout-pipeline.md`): chữ Hy Lạp và ký hiệu phông Symbol (α, ∠, °) và chữ Hán mở rộng A vào đúng dòng; chú thích, ghi nguồn ảnh, phụ đề cỡ nhỏ thành đoạn riêng cần dịch (trước đây bị xóa khỏi nền); ảnh công thức, nét vẽ (mũi tên, dấu bằng vẽ hai nét) và đoạn chữ không đọc được nằm trong dòng thành mã `@@PDF_INLINE_n@@` mới, và mã của ảnh hay nét vẽ có thể có `text` rỗng (xem ảnh trong `inlines/`); chữ nhỏ trên hay dưới công thức (giới hạn, điều kiện phản ứng) vào chung ảnh của công thức; dòng bị cắt rời (tiêu đề dãn chữ, ảnh chen giữa) được nối lại; hàng của bảng kẻ sát chữ và cột ô một chữ được tách đúng; trích dẫn bị xuống dòng ("1]。") hay số trong phông chữ Hán giữ là chữ, và dấu câu toàn chiều rộng ở hai đầu công thức nằm ngoài ảnh. `extractionVersion` vẫn là 3, nên chỉ `extract --force` mới cho các thay đổi này; sau đó đối chiếu lại `texts.json` vừa chép sang với `blocks.json` mới như trên. Trang scan giữ cách chia đoạn; thứ tự đọc có thể đổi ở trang hai cột có phần nằm dưới một cột, và trang có lớp chữ mà trước đây bị đưa sang OCR (có watermark mờ, có ảnh chữ Latin) nay được đọc bằng lớp chữ, nên mọi đoạn của trang đó đổi.
- Lượt sửa thứ tư của bộ tách (cũng 23/10/2026) đổi tiếp cách chia đoạn và thứ tự đọc (chi tiết: `docs/pdf-layout-pipeline.md`): pinyin có âm cuốn lưỡi (nǎr), ngoặc kép, nhãn người nói hay chữ số nằm trên chữ Hán nay là ký hiệu phụ (xóa khỏi nền, không vào `source`), nên không còn nằm dưới bản dịch hay tách đoạn chữ Hán bên dưới thành nhiều đoạn; nhãn một chữ của hình (甲 乙 丙) và tiêu đề cột của bảng là các đoạn riêng thay vì một đoạn nối; cột ô một chữ của bảng ba đường kẻ được tách thành từng ô (không còn giữ ảnh gốc), còn nhãn dọc cạnh thân bài lại giữ ảnh gốc; đoạn văn viết trên giấy kẻ dòng hay giấy ô là một đoạn; phần tiếp theo của một cột dài hơn (sau tiêu đề hay hình) được đánh số tiếp cột đó, kể cả ở trang scan. `extractionVersion` vẫn là 3, nên chỉ `extract --force` mới cho các thay đổi này; mã đoạn được đánh theo thứ tự đọc, nên trang hai cột có một cột dài hơn (cả trang scan) có thể ra mã đoạn khác: đối chiếu lại `texts.json` vừa chép sang với `blocks.json` mới như trên.
