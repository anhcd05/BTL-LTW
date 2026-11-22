# Gợi ý nhạc AI trên bản chính (infosound-local) – 22/11/2026

Ghi chép số liệu trước khi dọn stack demo `infosound-demo` và các image/cache thừa.

## Môi trường

- Chỉ một bản: `infosound-local` tại https://localhost:3443, đi qua SafeLine WAF; media ở https://localhost:9443.
- Image `infosound/*:local` được build lại từ bản chụp LF của thư mục làm việc (git tree `560d4fbe760b`), gồm cả `recommendation-ai`.
- Migration `202611210001_recommendation_ai` đã áp lên DB thật (tổng cộng 20 migration).
- Bản sao lưu DB trước migration và seed: `E:\School\Ky-7-ptit\LTW\BTL\infosound-restore-20261120\pre-reco-20261122T000700.dump`.
- `RECO_EXPLAIN_ENABLED` không bật trên API thật.

## Dữ liệu demo đã seed vào DB chính (theo quyết định của người dùng)

Lệnh: `seed --i-know-this-is-demo`, deterministic với seed mặc định 42.

| Hạng mục | Số lượng |
|---|---|
| Nghệ sĩ demo | 40 |
| Bài demo | 200 (FLAC sine 45 s, tổng 59.5 MB trên SeaweedFS) |
| Người nghe demo | 60, gồm 3 persona đăng nhập được |
| Sự kiện nghe mô phỏng | 7313 |
| Lượt thích | 509 |
| Bản ghi listens | 982 |
| Bản ghi engagement | 1721 |
| Lượt theo dõi | 188 |
| Playlist | 29 |
| Câu trả lời khảo sát | 32 |

Sau khi seed, DB có 110 user (100 user demo `@demo.infosound.local`), 218 bài (214 bài public), 514 lượt thích và 991 listens.

Tài khoản demo (chỉ để thử): `chill@`, `vpop@` và `rap@demo.infosound.local`, mật khẩu `RecoDemo#2026`.

Gỡ dữ liệu demo: chạy `node /repo/recommendation-ai/batch/dist/cli.js seed --reset-only --i-know-this-is-demo` với `RECO_DEMO=1` trong container tools.

## Embedding

- Model: `Xenova/multilingual-e5-small@761b726dd34f:q8`, 384 chiều.
- Đã tính cho 214/214 bài public, gồm cả bài thật lẫn bài demo.

## Train (`lr-20261121T171200Z`, đang active)

- Dữ liệu: 214 bài public, 64 user có tương tác, 214 embedding.
- Mẫu: n = 2505 trước holdout, 1900 trong holdout 7 ngày gần nhất. Hội tụ sau 505 epoch.
- AUC: 0.923 khi fit trên dữ liệu trước holdout, 0.940 trên holdout 7 ngày gần nhất.
- Logloss: 0.281 trên tập train, 0.239 trên holdout.

| Feature | Trọng số gốc | Trọng số chuẩn hóa |
|---|---:|---:|
| cf_score | 4.3225 | 1.4100 |
| content_sim | -6.4704 | -0.1060 |
| follows_artist | 2.4599 | 0.8432 |
| survey_match | 0.6890 | 0.2372 |
| genre_overlap | 1.4514 | 0.5928 |
| popularity | 0.6690 | 0.1729 |
| recency | -0.9284 | -0.2540 |
| skip_rate | 0.5568 | 0.0968 |
| bias | 1.3866 | |

## Kiểm tra trên 3443

`GET /api/v1/recommendations/shelves` trả về `modelVersion = lr-20261121T171200Z`, có `impressionToken`, và các kệ LISTENED / FOLLOW / TRENDING / FOR_YOU cá nhân hóa theo từng persona:

- chill: nhiều bài Acoustic, lý do "LISTENED" dựa trên bài "Theo trái tim về Hội An".
- rap: nhiều bài Hip-Hop / R&B, lý do "LISTENED" dựa trên bài "Mùa đông ở sân ga".

Báo cáo đánh giá offline (`evaluate`, chạy trong bộ nhớ, không dùng DB) nằm ở các file `eval-20261121T*.md` / `.json` trong cùng thư mục này.

## Restore ngày 21/11 (ghi lại)

- Snapshot 20/11 (giải mã bằng age) khớp toàn bộ 36 bảng theo manifest: 10 user, 18 bài (14 public), 19 migration.
- SafeLine được dựng lại, đã kiểm tra chặn `/__waf_verify__` và SQL injection (403).

## Bổ sung 22/11: kệ không trùng, ảnh bìa/avatar, tài khoản demo của người dùng

- **Kệ gợi ý** (`src/shelves.ts`, DESIGN §4): thứ tự FOR_YOU → LISTENED ("Vì bạn đã nghe X") → FOLLOW → TRENDING.
  FOR_YOU (có slot EXPLORE) được tính trước; các kệ sau chỉ lấy từ ứng viên chưa xuất hiện ở kệ trước, nên không có
  trackId nào nằm ở hai kệ. Kệ rỗng bị bỏ. Một impressionToken ký trên toàn bộ bài được phục vụ. Web hiển thị đúng
  thứ tự API (không cần sửa web). Unit test mới: `tests/unit/shelves.test.cjs` (57/57 test core pass, 45/45 test batch pass).
- **`art`** (lệnh batch mới): sinh ảnh tại chỗ, không tải gì từ mạng. Ảnh bìa có 4 motif (đĩa than, hoàng hôn, Bauhaus,
  băng cassette hoạt hình) theo màu thể loại. Avatar nghệ sĩ là chữ viết tắt trên đĩa màu, avatar người nghe là khuôn
  mặt hoạt hình. Mã hoá WebP bằng ffmpeg/libwebp, lưu đúng như API: bucket `artwork`, key `cover/<trackId>/<uuid>.webp`
  và `avatar/<userId>/<uuid>.webp`, có checksum sha256 và size, `track_assets` ARTWORK `verified=true`, các cột
  `users.avatar_*` và `avatar_revision + 1`. Kết quả: 200 ảnh bìa và 100 avatar (3.0 MB). Chạy lại thì không sinh thêm
  (0/200, 0/100). `seed --reset-only` xoá các ảnh này cùng dữ liệu demo.
- **`demo-user`** (lệnh batch mới): gắn hồ sơ gu Ballad / V-pop / Acoustic (+ một ít Lo-fi) vào tài khoản USER
  `anhcd` mà người dùng tự đăng ký. Email chỉ truyền qua dòng lệnh, không ghi vào repo. Lệnh không sửa dòng user,
  mật khẩu, vai trò hay phiên đăng nhập. Dữ liệu gắn vào: 4 lượt theo dõi, 25 listens trong 30 ngày, 29 dòng
  engagement (có skip), 10 lượt thích, 1 playlist riêng tư và câu trả lời khảo sát; còn 61 bài cùng gu chưa nghe.
  Tất cả chỉ trỏ tới bài và nghệ sĩ demo. `play_count` được cộng như `seed`. Chạy lại thì không thay đổi gì.
  `demo-user --reset` hoặc `seed --reset-only` gỡ dữ liệu này nhưng **không xoá tài khoản**. Không tạo tài khoản
  `anhcd@demo.infosound.local`.
- Build: `infosound/api:local` và `infosound/tools:local` được build lại từ bản chụp LF; web không đổi nên không build
  lại. Chỉ tạo lại container api. Các lệnh `art` và `demo-user` chạy trong container tools với `RECO_DEMO=1`,
  `RECO_S3_IDENTITY=BOOTSTRAP` và `--i-know-this-is-demo`. Không chạy lại `seed`, `embed` hay `train`. Đã chạy
  `docker builder prune -af`.
- Kiểm tra trên 3443/9443 (TLS xác minh bằng CA dự án, IPv4): đăng nhập trả 201. `GET /recommendations` trả
  `HYBRID` (`lr-20261121T171200Z`, `private, no-store`). `/recommendations/shelves` có thứ tự
  `[FOR_YOU, LISTENED, FOLLOW, TRENDING]`, gồm 34 bài, 0 bài trùng. Cả 34 bài đều có coverUrl và avatarUrl; tải ảnh
  bìa và avatar qua 9443 đều trả 200 `image/webp`. Cả 8 service healthy.
