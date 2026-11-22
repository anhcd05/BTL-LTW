# Kịch bản quay demo InfoSound (bản ngắn)

Trước khi quay: bật panel Giải thích gợi ý (lệnh ở cuối file), chuẩn bị một email thật để nhận OTP.

## Mở đầu
“Em là Chử Đức Anh, nhóm 5. Đây là InfoSound, web nghe nhạc lossless của nhóm em. Em làm trình phát, hàng đợi, lời bài hát, thư viện và phần riêng là gợi ý nhạc bằng AI.”

## 1. Chưa đăng nhập
1. Mở trang chủ, cuộn qua các mục. “Chưa đăng nhập vẫn xem và nghe nhạc được.”
2. Bấm phát một bài, chuyển sang trang khác. “Chuyển trang nhạc vẫn phát tiếp.”
3. Thêm 2 bài vào hàng đợi, kéo đổi thứ tự, bật trộn, lặp. “Đây là hàng đợi phát.”
4. Mở lời bài hát, bấm một dòng. “Lời chạy theo nhạc, bấm vào dòng nào thì tua tới đó.”
5. Tìm một bài bằng vài chữ trong lời. “Tìm được theo tên và lời bài hát.”
6. Bấm tim một bài. “Muốn thích hay bình luận thì phải đăng nhập.”

## 2. Người nghe đã đăng nhập
1. Đăng ký bằng email, mở Gmail lấy mã OTP, nhập vào, đăng nhập. “Nhóm em đã cài được SMTP để gửi mã OTP về email khi đăng ký.”
2. Chọn thể loại yêu thích trong khảo sát. “Người mới chọn sở thích để hệ thống gợi ý ban đầu.”
3. Thích vài bài, theo dõi một nghệ sĩ, tạo playlist, đổi thứ tự bài. Mở Thư viện, Lịch sử. “Đây là thư viện, playlist và lịch sử nghe.”
4. Đăng nhập tài khoản đã có lịch sử, xem Giai điệu đề xuất trên trang chủ. “Mỗi bài gợi ý có lý do, ví dụ ‘Vì bạn đã nghe X’.”
5. Mở trang Gợi ý, đặt cạnh tài khoản `rap@demo.infosound.local`. “Hai người gu khác nhau thì được gợi ý khác nhau.”
6. Mở panel Giải thích gợi ý. “Mô hình có 3 bước: lấy bài ứng viên, chấm điểm, rồi lọc và chọn 5 bài. Bảng này cho thấy vì sao từng bài được chọn hay bị loại.”
7. Phát một bài gợi ý, bỏ qua sau vài giây, làm mới trang. “Bài vừa bỏ qua sẽ không bị gợi ý lại.”

## 3. Tác giả
1. Đăng nhập tài khoản tác giả, mở Author Studio. “Tác giả tải nhạc lên, chờ xử lý xong rồi phát hành.”
2. Mở phần nhập lời của một bài. “Lời nhập ở đây là lời hiện trên trình phát.”

## Kết
“Đó là các chức năng chính của InfoSound. Em cảm ơn thầy.”

---

Bật panel Giải thích (quay xong thì chạy lại lệnh, bỏ phần `-f ..\recommendation-ai\demo\reco-explain.override.yaml` để tắt):
```powershell
cd E:\School\Ky-7-ptit\LTW\BTL\int1434\infosound
$env:LOCAL_NGINX_CONFIG = "E:/School/Ky-7-ptit/LTW/BTL/int1434/.runtime-private/local-runtime/generated/nginx.conf"
docker --context desktop-linux compose --project-directory . --project-name infosound-local --env-file images.env --env-file ..\.runtime-private\local-runtime\runtime.env -f compose.yaml -f compose.lab.yaml -f compose.local.yaml -f compose.local-waf.yaml -f ..\recommendation-ai\demo\reco-explain.override.yaml up -d --no-deps --no-build api
```
