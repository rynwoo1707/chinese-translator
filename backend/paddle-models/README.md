# Mô hình PaddleOCR kèm trong repo

OCR trong trình duyệt (khi trang PDF là ảnh quét) dùng PaddleOCR qua thư viện `@paddleocr/paddleocr-js` 0.4.2, chạy
bằng ONNX Runtime Web ngay trên máy người dùng. Hai tệp dưới đây là mô hình PP-OCRv5 bản mobile ở dạng ONNX, do dự án
PaddleOCR của PaddlePaddle phát hành: `det.tar` tìm vùng có chữ, `rec.tar` đọc chữ trong từng vùng.

Trước đây `npm run setup` tải hai tệp này từ `paddle-model-ecology.bj.bcebos.com` (Baidu BOS). Một số mạng không vào
được địa chỉ đó, và khi không tải được thì bước cài đặt dừng lại, máy mới không khởi động được app. Vì vậy chúng nằm
sẵn ở đây: `backend/vendor.mjs` kiểm kích thước, chữ ký tar và SHA-256 theo `manifest.json` rồi chép sang
`frontend/vendor/paddle/models/` (đường dẫn trình duyệt tải về, không đổi). Không cần mạng, không dùng Git LFS.

| Tệp | Mô hình | Byte | SHA-256 | Nguồn gốc |
|---|---|---|---|---|
| `det.tar` | PP-OCRv5_mobile_det (phát hiện vùng chữ) | 4.843.520 | `781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30` | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar` |
| `rec.tar` | PP-OCRv5_mobile_rec (nhận dạng chữ) | 16.701.440 | `f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c` | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar` |

- Mỗi tệp giống từng byte bản tải từ địa chỉ trên (tar không nén). Bên trong, thư mục `.cache/huggingface/download/`
  ghi commit snapshot Hugging Face mà PaddlePaddle đã dùng khi đóng gói: `det.tar` là
  `df0bd9dee2bc627e80a2a1798ccab35a332e22d6`, `rec.tar` là `ec1bd72732b2b5f52df0a66321403eebb520ba74`.
- Giấy phép: Apache License 2.0. `README.md` bên trong mỗi tar khai báo `license: apache-2.0`; toàn văn giấy phép nằm
  trong `LICENSE` cạnh tệp này. Phân phối lại được, kèm giấy phép đó.
- Giữ nguyên các tệp này, không sửa, không đổi tên. `.gitattributes` đánh dấu `*.tar` là `binary` để git không chạm vào
  nội dung. `npm test` (`backend/paddle-assets.test.mjs`) kiểm lại kích thước, chữ ký tar và SHA-256, nên tệp bị cắt,
  bị thay hoặc chỉ còn là con trỏ Git LFS đều bị phát hiện.
- Thiếu hoặc hỏng tệp ở đây không chặn cài đặt: `npm run setup` báo CẢNH BÁO, app vẫn chạy và OCR trong trình duyệt
  dùng Tesseract (chậm hơn, đọc chữ Trung kém hơn). Lấy lại bằng `git checkout -- backend/paddle-models`. CI và
  `npm run deploy` thì bắt buộc có PaddleOCR (`backend/vendor.mjs --require-paddle`).

Muốn dùng mô hình mới hơn:

1. Thay `det.tar`/`rec.tar` bằng tar không nén, mỗi tệp dưới 25 MiB (giới hạn tài nguyên tĩnh của Cloudflare Workers).
2. Sửa `bytes`, `sha256` (và `url`, `sdk` nếu đổi) trong `manifest.json` và trong bảng trên.
3. Đổi tên bộ nhớ đệm `'hoa-tri-paddle-v5-0.4.2'` trong cả `frontend/paddle-worker.js` và `frontend/local-ocr.js`
   (dùng cùng một tên mới): trình duyệt lưu mô hình theo URL, mà URL không đổi, nên giữ tên cũ thì máy đã từng dùng app
   vẫn chạy mô hình cũ.
4. Chạy `npm run prepare:vendor -- --require-paddle`, `npm test`, rồi thử OCR một trang quét trong trình duyệt.
