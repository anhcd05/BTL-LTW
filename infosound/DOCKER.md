# Chạy InfoSound bằng Docker

Yêu cầu: Windows, Docker Desktop đang chạy với Linux containers, cùng bộ runtime và secrets riêng tại `.runtime-private/local-runtime/`. Mở PowerShell tại thư mục `infosound/`.

```powershell
.\scripts\start-local.ps1
```
Khởi động các dịch vụ InfoSound. Mở web tại <https://localhost:3443>.

```powershell
.\scripts\status-local.ps1
```
Xem trạng thái các container, kể cả container đã dừng.

```powershell
.\scripts\doctor-local.ps1
```
Kiểm tra Docker Desktop, cấu hình runtime và trạng thái dịch vụ.

```powershell
.\scripts\stop-local.ps1
```
Dừng các container; dữ liệu, volumes và secrets được giữ lại.

```powershell
.\scripts\start-local.ps1 -Build
```
Build lại các image ứng dụng rồi khởi động hệ thống.
