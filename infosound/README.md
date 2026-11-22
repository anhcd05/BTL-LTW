# InfoSound

InfoSound chạy hoàn toàn trên **máy hiện tại bằng Docker Desktop Linux containers**. Frontend/API, hai worker, PostgreSQL, Redis, SeaweedFS và gateway đều chạy local; vận hành hằng ngày không cần máy chủ từ xa, SSH hoặc tunnel.

Đã tích hợp **SafeLine WAF** bảo vệ web/API và media. Xem [tổng hợp triển khai và chỉnh giao diện](docs/SESSION_SUMMARY_2026-11-05.md).

**Chuyển đổi ngày03/11/2026 đã xác minh:** đủ8 dịch vụ healthy; giữ4 tài khoản/6 bài READY,4 avatar/6 cover và dữ liệu playlist/social. Snapshot14 artifact khớp SHA-256; 22 bảng/roles cùng22 asset refs được đối chiếu. Google đã enabled tại localhost, bước consent/đăng nhập thật cần người dùng thực hiện. Máy nguồn có thể tắt. Xem [PROGRESS](PROGRESS.md).

| Mục | Địa chỉ |
|---|---|
| Website / API | **https://localhost:3443** / `/api/v1` |
| Media ký số | **https://localhost:9443** |
| HTTP chuyển sang HTTPS | http://localhost:18080 |
| Quản trị SafeLine WAF | https://localhost:10443 |

Các cổng chỉ bind `127.0.0.1`. Dùng đúng hostname `localhost` cho Google OAuth/cookie. SafeLine9.4.3 chạy local trong project riêng `infosound-waf`, nhận HTTPS web/media trước gateway, không cần VM/domain/hosts; Google/Gmail SMTP vẫn cần Internet. Xem [WAF_LOCAL.md](docs/WAF_LOCAL.md) về quản trị, log nhạy cảm và hoàn tác.

## Khởi động và dừng

Mở Docker Desktop ở chế độ Linux containers. Từ source root `infosound/`, chạy PowerShell:

```powershell
.\scripts\start-local.ps1
.\scripts\status-local.ps1
.\scripts\doctor-local.ps1
```

Sau thay đổi source, build rồi khởi động bằng `.\scripts\start-local.ps1 -Build`. Để dừng và giữ dữ liệu, chạy `.\scripts\stop-local.ps1`. Các script có thể nhận `-RuntimeEnvFile` cho đường dẫn cấu hình private đã được chuẩn bị.

Runtime dùng `compose.yaml`, `compose.lab.yaml`, `compose.local.yaml`, project **`infosound-local`**. Cấu hình private ở **`../.runtime-private/local-runtime/`** tính từ source root: `runtime.env`, `secrets/`, `generated/`. Bốn Docker named volumes local lưu DB, storage/filer metadata, Redis và audio working files. Không đưa secrets/CA key/backup vào Git hoặc build context. Không cài Node/PostgreSQL/Redis native lên Windows để chạy ứng dụng.

Khi có marker private `local-runtime/waf-enabled.json`, helper thêm `compose.local-waf.yaml`: gateway dùng backend loopback13443/29443, SafeLine giữ các URL3443/9443. Lệnh start/stop/status/doctor quản lý cả hai project; private WAF assets và mật khẩu `admin` ở `../.runtime-private/safeline-local/`. Không xuất credential hoặc attack log ra tài liệu; attack log chưa được xác minh masking.

Snapshot chuyển đổi nằm tại `../.runtime-private/localhost-migration/snapshot-<UTC>/`. Phải đối chiếu checksum, DB/assets/versions và kiểm local trước khi xác nhận cutover; giữ nguồn freeze sau snapshot cuối để tránh hai bộ writers độc lập. Trạng thái restore và kết quả thực tế ở [PROGRESS.md](PROGRESS.md); các PASS trước chuyển đổi chỉ là lịch sử.

Trình duyệt cần trust public CA của dự án để HTTPS/Secure cookies hoạt động. Xem [LOCAL_ACCESS.md](docs/LOCAL_ACCESS.md); không bỏ TLS verification để ghi PASS.

## Đăng nhập và tính năng

Giữ đăng ký email + username duy nhất + mật khẩu, OTP xác minh rồi đăng nhập email/mật khẩu. OTP chỉ xác minh đăng ký, không tự cấp session. Google OAuth bổ sung bên cạnh phương thức cũ, callback chính xác:

```text
https://localhost:3443/api/v1/auth/oauth/google/callback
```

Credentials Google/SMTP được chuyển và nạp từ private runtime; không có trong source/log. Provider enabled không chứng minh consent/token exchange thật đã thành công. Xem [OAuth](docs/OAUTH_LOCAL.md), [OTP](docs/EMAIL_OTP.md), [SMTP](docs/SMTP.md).

**Cập nhật sau cutover03/11/2026:** người dùng đã đăng nhập Google thành công; backend xác nhận Google identity/session thật, refresh201 và `/me`200. Tài khoản tạo trước bằng email/mật khẩu không tự liên kết Google theo email trùng; giữ đăng nhập bằng phương thức hiện có. Kết quả và diagnostics ở [PROGRESS](PROGRESS.md).

- VISITOR nghe nhạc công khai và được tính lượt nghe mà không cần tài khoản. Bình luận, thích, theo dõi và thư viện cá nhân vẫn cần đăng nhập; chỉ AUTHOR thấy công cụ quản lý. [Quyền nghe của khách](docs/VISITOR_PLAYBACK.md), [vai trò](docs/FRONTEND_ROLES.md).
- Player có trộn/lặp và hàng đợi phiên chỉnh sửa được: bấm từng bài tạo queue1, menu … thêm bài, kéo hoặc nút lên/xuống đổi thứ tự, xóa từng mục. Phát playlist là thao tác danh sách riêng; chuyển trang/locale/theme giữ cùng audio. [Playback](docs/PLAYBACK.md).
- Nút bàn phím góc phải mở bảng21 phím tắt đã dịch: phát/tua/âm lượng/hàng đợi/lyrics và điều hướng. Có thể tắt các phím chữ/số; nhập liệu/modal giữ hành vi riêng, nhạc không khởi động lại khi điều hướng. [Phím tắt](docs/SHORTCUTS.md).
- Nút micro mở lời toàn trang, sáng dòng hiện tại, cuộn theo audio và bấm dòng để tua. AUTHOR có thể đính kèm `.lrc` tùy chọn ngay lúc tải bài mới hoặc nhập/sửa ở trang bài trong Studio; bài chưa có dữ liệu hiện trạng thái trống. [Lời bài hát](docs/LYRICS.md).
- Mỗi bài tối đa tám thể loại độc lập theo ID; Studio chọn nhiều/tìm kiếm, hiển thị tag riêng và API lọc membership. [Thể loại](docs/GENRES.md).
- 109 lựa chọn ngôn ngữ bản địa/tìm prefix, 107 catalog máy offline,756thông điệp, RTL; giữ nội dung người dùng và timestamp UTC, English dùng New York/DST. [I18N](docs/I18N.md), [ngôn ngữ](docs/LANGUAGES.md).
- Chín palette tối dịu; đổi màu giữ form/player. [Themes](docs/THEMES.md).
- Avatar USER/AUTHOR, cover/audio của AUTHOR; signed media URLs, private buckets, sealed source versions, transactional outbox và fenced tasks. [Ảnh](docs/IMAGE_UPLOAD.md), [workers](docs/WORKERS.md).
- Like/follow/chuông, library và playlist giữ cùng dữ liệu hiện hành. Library dùng thẻ nghệ sĩ đang theo dõi giống thẻ thịnh hành, tối đa5 mỗi hàng và giữ toàn bộ danh sách API trả về. [Thẻ nghệ sĩ](docs/TRENDING_ARTISTS.md).
- Thông báo phát hành có ảnh bìa bài hát, tên/nghệ sĩ/thời gian và thao tác đánh dấu đọc; ảnh và trạng thái dùng dữ liệu thật. [Thông báo](docs/NOTIFICATIONS.md).

Không tạo tài khoản/bài hát mặc định; tài khoản, nhạc, ảnh và quan hệ thật không phải fixture có thể xóa. Source strict TypeScript/pnpm monorepo gồm Next.js/React/Tailwind, NestJS, Prisma/PostgreSQL, BullMQ/Redis và SeaweedFS. Giữ tám dịch vụ và exact pins/lock.

## Tài liệu

[Mô phỏng kiến trúc bằng Breakscale](tools/breakscale/README.md): mở `http://127.0.0.1:5173/infosound` sau khi chạy `.\tools\breakscale\start.ps1`. Có mô hình web/API/media, audio và kiểm duyệt cùng chín kịch bản tải. Đây là mô phỏng với giả định hiệu năng, không phải dashboard lưu lượng thật.

[Bản đồ mã nguồn](docs/CODE_MAP.md) chỉ vị trí từng chức năng; [biên bản tổ chức lại mã](docs/REFACTOR_VERIFICATION.md) ghi phạm vi và kết quả kiểm chứng ngày12/11/2026.

[Kiến trúc](docs/ARCHITECTURE.md), [dữ liệu](docs/DATA_MODEL.md), [API](docs/API.md), [bảo mật](docs/SECURITY.md), [vận hành](docs/OPERATIONS.md), [SafeLine local](docs/WAF_LOCAL.md), [backup/restore](docs/BACKUP_RESTORE.md), [giới hạn](docs/KNOWN_LIMITATIONS.md), [đặc tả](docs/BUILD_SPEC.md). Tài liệu trước chuyển localhost chỉ là [lịch sử](docs/archive/VM_HISTORY.md), không là điều kiện vận hành. WAF local hiện tại là yêu cầu riêng ngày04/11/2026; không tự triển khai cloud hoặc kết nối lại nguồn theo lệnh lịch sử.

Tìm kiếm hỗ trợ đoạn lời không dấu/một phần/gần đúng trong LRC đã lưu; kết quả có nhãn “Khớp lời bài hát”. Ví dụ `Thắc gì nữa mà mắc` có thể tìm Có Chắc Yêu Là Đây khi bài đã có lyrics đúng sourceVersion. [SEARCH.md](docs/SEARCH.md) mô tả thuật toán và quyền; nghiệm thu thật xem PROGRESS.

Khám phá có Bảng xếp hạng ở khu vực nhạc đầu tiên và Mới phát hành, mỗi phần tối đa 5 bài; Xem tất cả mở danh sách 20 bài/trang. Lượt nghe bắt đầu ghi khi triển khai; không dựng lại lịch sử. [DISCOVERY.md](docs/DISCOVERY.md).

Khám phá có Giai điệu đề xuất (tối đa5 bài) ngay sau Bảng xếp hạng: ưu tiên thể loại/nghệ sĩ trong hộp thoại khảo sát nổi tùy chọn, bố cục dọc và có thể đóng, tiếp theo sở thích từ bài đã tim, rồi bài nghe nhiều nhất khi chưa có dữ liệu. Visitor lưu lựa chọn trên trình duyệt; tài khoản lưu riêng, có thể bỏ qua/chỉnh sửa. [RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md), [MUSIC_PREFERENCES.md](docs/MUSIC_PREFERENCES.md).

Mục **Lịch sử** hiển thị bài đã nghe theo lần nghe gần nhất, mỗi bài một lần và 20 bài/trang, cùng giao diện Bài đã thích. Lưu sau 30 giây hoặc nửa bài ngắn, dùng tài khoản hiện tại. [HISTORY.md](docs/HISTORY.md).

Khám phá có **Nghệ sĩ thịnh hành**, tối đa5 thẻ ảnh lớn theo lượt nghe, kèm số người theo dõi, nút theo dõi và bài được nghe nhiều nhất của từng nghệ sĩ. [TRENDING_ARTISTS.md](docs/TRENDING_ARTISTS.md).

Trang bài hát có waveform thật trắng/đổi màu theo tiến độ, click để tua, bình luận theo mốc nhạc với tim/trả lời; sidebar nghệ sĩ/thống kê, top3 fan, bài cùng nghệ sĩ và tag. Dùng chung root player, giữ tải xuống/playlist/likes theo quyền. [TRACK_DETAIL.md](docs/TRACK_DETAIL.md).

Giao diện tinh chỉnh04/11/2026 dùng bề mặt/chữ/khoảng cách mềm và gọn hơn. Author Studio gom thao tác phụ vào mục mở rộng, giữ nguyên chức năng và các bản nháp; xóa bài qua nút nguy hiểm có xác nhận rõ. Phạm vi frontend, nguồn tham khảo và hướng phát triển ở [UI_REFINEMENT.md](docs/UI_REFINEMENT.md); nghiệm thu/triển khai xem PROGRESS.
