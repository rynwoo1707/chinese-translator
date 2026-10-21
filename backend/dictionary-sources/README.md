# Nguồn từ điển kèm trong repo

Kho gốc của hai nguồn dưới đây trên GitHub (`github.com/ph0ngp`) đã bị gỡ (phát hiện 21/10/2026). Vì vậy
`npm run prepare:dict` đọc chúng từ thư mục này thay vì tải về. Mỗi tệp giống từng byte bản đã kiểm thử: script vẫn kiểm
kích thước và SHA-256 như với các nguồn tải từ mạng (`SOURCES` trong `backend/prepare-dictionary.mjs`).

| Tệp | Nguồn | Phiên bản | Giấy phép | SHA-256 |
|---|---|---|---|---|
| `CVDICT.u8` | CVDICT, Phong Phan, dựa trên CC-CEDICT | 1.0.1 (commit `c379d90`) | CC BY-SA 4.0 (ghi ở đầu tệp) | `4dde4b20…0948` |
| `hanviet.csv` | hanviet-pinyin-wordlist, Phong Phan | commit `b9923df` | MIT (`hanviet-LICENSE.txt`) | `dd90d59d…6d14d66` |
| `hanviet-LICENSE.txt` | giấy phép MIT của hanviet-pinyin-wordlist | commit `b9923df` | MIT | `4c88b09e…819d25` |

- Giữ nguyên các tệp này, không sửa, không đổi tên, không đổi ký tự xuống dòng. `.gitattributes` đánh dấu thư mục là
  `-text` để git không chạm vào nội dung.
- Phân phối lại được theo đúng giấy phép: CVDICT theo CC BY-SA 4.0 (ghi công tác giả, giữ cùng giấy phép); hanviet
  theo MIT (kèm thông báo bản quyền). Chân trang của Hoa Trí và `LICENSE.txt` của dữ liệu đã dựng ghi nguồn và giấy phép.
- Muốn dùng bản mới hơn: đặt tệp mới vào đây, cập nhật `bytes`/`sha256`/`version` trong `SOURCES`, chạy
  `npm run prepare:dict -- --force`.
