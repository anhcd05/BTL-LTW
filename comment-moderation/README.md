# AI hỗ trợ kiểm duyệt bình luận InfoSound

Module TypeScript tích hợp vào `../infosound` hiện có: composer/trạng thái người gửi, hàng chờ moderator, Prisma/PostgreSQL và background worker. Không tạo website hoặc hệ đăng nhập riêng. [Điểm tích hợp/từng file ngoài module](docs/INTEGRATION.md), [policy](docs/POLICY.md), [kiểm thử](docs/TEST_REPORT.md), [tiến độ](docs/PROGRESS.md).

Đã cập nhật website/database localhost thật ngày05/11/2026, migration16–18; menu/quyền/cascade và từ cấm đã chạy. Gemini runtime có key nhưng request thật hiện **MODEL_UNAVAILABLE** với Flash Lite; chưa có inference thành công và không tự chuyển model. Bình luận chưa có đánh giá hợp lệ vẫn riêng tư. [Kết quả thực tế, lệnh và giới hạn](docs/LOCAL_ROLLOUT.md).

Theo yêu cầu tiếp theo, đã bỏ disclosure Gemini và panel “Bình luận của bạn” trên bản localhost. Thông báo trích nội dung hiện tại của chính người nhận trong dấu ngoặc kép; observer cập nhật nền và nút xóa vẫn hoạt động. Thay đổi này không cần migration hay phát lại cảnh báo. [Rollout giao diện/lệnh/demo](docs/UI_SIMPLIFICATION_ROLLOUT.md).

PENDING chỉ thành VISIBLE sau đánh giá AI hợp lệ và policy cho phép; còn lại giữ riêng HELD hoặc HIDDEN. Moderator xem xét/ẩn với lý do/version/revision; theo yêu cầu mới, APPROVE cần kết quả AI hợp lệ cho đúng phiên bản, không thể bỏ qua việc thiếu key/lỗi đánh giá. Sửa phải duyệt lại; DELETED và quyết định thủ công chặn job cũ. AI không khóa tài khoản.

Policy v2 chặn bắt buộc “ngu”, “bài chán vl”, “đcm”, “vcl” và các từ tục trong [POLICY](docs/POLICY.md). Đây là quy tắc nội bộ, không phải kết quả Gemini. Chê nhạc lịch sự không mặc nhiên vi phạm. USER có menu “…” để xóa bình luận của mình; AUTHOR xóa mọi bình luận dưới bài của mình. Xóa cha xóa cả reply, bao gồm reply chờ AI. [Quyền/cascade](docs/AUTHOR_CASCADE.md), [UI](docs/OWNER_DELETE_V2.md).

Gộp [.env.example](.env.example) vào **`../.runtime-private/local-runtime/runtime.env` tính từ infosound/**, không ghi đè env hiện có. Không đặt secret trong module/source/frontend/build args. Một bộ MODERATION_AI_* và key/model ngoại lệ theo đặc tả: GEMINI_API_KEY, GEMINI_MODEL. Mặc định gemini-2.5-flash-lite; SDK chính thức @google/genai2.32.0, generateContent v1beta. 2/phút,200/ngày UTC,tối đa3 lần/lượt là ngân sách nội bộ, không phải quota Google.

Compose inject cấu hình vào API/background-worker; chỉ worker gọi AI. Thay env cần recreate đúng service sau schema/image tương thích. Export terminal khác/file .env module không tự cấp key cho container. ENABLED=false giữ mới/sửa trong hàng chờ riêng, không cho APPROVE khi chưa có đánh giá AI hợp lệ. AUTO_APPROVE=false vẫn phân tích nhưng cần người duyệt. Sai cấu hình fail closed; không log nội dung thô.

Nếu key đã nằm trong `.env` của module, chạy từ workspace root `./comment-moderation/scripts/configure-local-key.ps1`. Script chỉ lấy `GEMINI_API_KEY`, giữ nguyên các dòng runtime khác, không sao chép model/provider/ngân sách từ `.env`, lưu bản cấu hình trước thay đổi trong thư mục private và chỉ báo key_present. Môi trường localhost đặt `GEMINI_MODEL=gemini-3.5-flash-lite` trong runtime private. File `.env` của module bị loại khỏi Git/build context. Chạy smoke trong worker sau recreate để xác minh inference.

Quyền moderation.read/review/retry lưu tại comment_moderation_permissions. Owner chỉ cấp cho **ID tài khoản hiện có được chủ dự án chọn** bằng parameterized SQL/công cụ nội bộ. Không có admin/mật khẩu mặc định; AUTHOR không tự có quyền. Settings hiện `/admin/moderation` khi có read.

Từ `infosound/`, Windows + Docker Desktop:

```powershell
. .\scripts\local-runtime.ps1
$ctx = Get-InfoSoundLocalRuntime
# Cài dependency, generate Prisma và build server/module trong Linux:
Invoke-InfoSoundLocalCompose -Context $ctx -Arguments @('--profile','tools','build','tools')
Invoke-InfoSoundLocalCompose -Context $ctx -Arguments @('--profile','tools','run','--rm','--no-deps','tools','pnpm','--filter','@infosound/comment-moderation','test')
Invoke-InfoSoundLocalCompose -Context $ctx -Arguments @('build','api','background-worker','web')
```

Migration additive202611050001_comment_moderation phải chạy trước API/worker mới, sau backup private đã kiểm chứng. Không reset/seed; startup không tự migrate:

Cần thêm `202611050002_comment_moderation_notifications` và `202611050003_comment_moderation_parent_guard` **trước API mới**, kể cả khi tắt AI. Cùng lệnh migrate áp dụng cả ba migration16–18. HIDE thủ công, rule v2 xác nhận hoặc kết quả AI hợp lệ/có evidence tạo thông báo “Bình luận của bạn đã vi phạm tiêu chuẩn cộng đồng”; PENDING/HELD/lỗi AI không kết tội. [Thông báo](docs/NOTIFICATIONS.md).

```powershell
Invoke-InfoSoundLocalCompose -Context $ctx -Arguments @('--profile','tools','run','--rm','--no-deps','tools','pnpm','--filter','@infosound/database','migrate')
.\scripts\start-local.ps1 -SkipStorageCors
```

Chẩn đoán không gọi mạng và smoke **trong worker đã cập nhật**:

```powershell
docker exec infosound-local-background-worker-1 node node_modules/@infosound/comment-moderation/scripts/smoke.cjs
docker exec infosound-local-background-worker-1 node node_modules/@infosound/comment-moderation/scripts/smoke.cjs --live
```

Smoke dùng chính provider/validator/policy và PG budget chung. Một câu trước; --suite chọn13 câu development, dừng khi lỗi/hết lượt, không tăng hạn mức/sleep vô hạn. --fixture chọn các ID để chạy batch chủ động; --evaluate --split development hoặc test đánh giá rõ ràng. --out chỉ ghi artifact tổng hợp tại đường dẫn private do người chạy chỉ định; không commit report có dữ liệu. [Fixtures/metrics](docs/FIXTURES.md). Test thường dùng mock trong test, không gọi Internet.

Integration cần DB **cô lập**, migration/grants và MODERATION_TEST_DATABASE_URL_FILE tới URL private có database moderation_test; chạy `pnpm --filter @infosound/comment-moderation test:integration` trong tools runtime. Không dùng DB ứng dụng. Thiếu cấu hình là SKIPPED/BLOCKED.

Runner tái lập tự chuẩn bị database/container cô lập với credential ngẫu nhiên, migrate15 → fixture legacy → migrate16–18/grants và chạy integration (từ workspace root):

```powershell
.\comment-moderation\scripts\test-isolated.ps1 -ToolsImage infosound/moderation-tools:candidate
```

Runner giữ resource/artifact private để chẩn đoán; không xóa database/volume hoặc dùng dữ liệu tài khoản thật.

Demo: USER/AUTHOR đăng nhập, mở bài public, gửi bình luận tổng hợp và nhận phản hồi gửi/vi phạm. Trang không có disclosure hoặc panel riêng. Bình luận đủ điều kiện AI mới công khai; observer nền làm mới public list khi trạng thái đổi. Menu “…” giữ quyền xóa/xóa replies; thông báo vi phạm trích đúng nội dung riêng của người nhận. Moderator có quyền dùng Settings → hàng chờ. API sửa/review vẫn được giữ nhưng panel thao tác riêng đã bỏ theo yêu cầu. Không lấy dữ liệu tài khoản thật làm fixture.

Rollback an toàn: giữ code mới và tắt AI để manual. Nếu dùng image cũ, dừng worker mới và chặn route bình luận tới khi có filter tương thích: **API cũ không biết moderation nên có thể lộ bình luận mới**. Giữ schema/jobs/audit; không xóa database/volume.
