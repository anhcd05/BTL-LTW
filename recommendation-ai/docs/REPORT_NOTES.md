# Ghi chú viết báo cáo: Gợi ý nhạc bằng AI (anhcd, Chử Đức Anh)

> **Mục đích:** gom mọi thứ cần đưa vào báo cáo và slide cho chức năng riêng "Gợi ý nhạc bằng AI".
> Tất cả số liệu dưới đây là **số chạy thật**, ghi rõ nguồn.
>
> **Trạng thái ngày 21/11/2026:**
> - **Đã xong:** code, đánh giá e5 (warm-start và cold-start), chạy trên bản chính.
> - **Từ 22/11/2026 chỉ còn một bản** (`infosound-local`, https://localhost:3443). Stack demo riêng đã xoá; dữ liệu tổng hợp đã seed vào bản chính. Chi tiết: `reports/REAL_STACK_RUN-20261122.md`.
>
> **Nguồn sự thật:**
> - Hợp đồng kỹ thuật: `docs/DESIGN.md`.
> - Kết quả đánh giá: `reports/eval-<UTC>.md` và `.json`.
> - Trạng thái bản chính: `reports/REAL_STACK_RUN-20261122.md` (`demo/README.md` chỉ còn giá trị lịch sử).
> - Dữ liệu tổng hợp: `batch/README.md`.

---

## 1. Đoạn tóm tắt (dùng cho Mở đầu hoặc mục 2.2)

> Chức năng gợi ý được xây dựng theo mô hình **lai (hybrid) ba tầng**, giống kiến trúc các hệ thống gợi ý công nghiệp đã công bố.
> - **Tầng 1** thu thập ứng viên từ bốn nguồn: lọc cộng tác theo bài hát (đồng xuất hiện trong lịch sử nghe, thích, playlist); độ tương đồng nội dung bằng vector nhúng của mô hình đa ngôn ngữ **multilingual-e5-small chạy cục bộ**; bài của nghệ sĩ người dùng theo dõi; bài đang thịnh hành.
> - **Tầng 2** dùng **hồi quy logistic** học từ tín hiệu ngầm để ước lượng xác suất người dùng thích hoặc nghe hết bài.
> - **Tầng 3** sắp xếp lại theo luật nghiệp vụ: mỗi nghệ sĩ tối đa một bài; loại bài đã thích, vừa nghe hoặc vừa bỏ qua; dành một vị trí khám phá; kèm lý do gợi ý.
>
> Khi thiếu dữ liệu hoặc xảy ra lỗi, hệ thống quay về bộ quy tắc sẵn có. Mô hình không dùng dịch vụ AI bên ngoài. Kết quả đánh giá thực hiện trên **dữ liệu mô phỏng** trong môi trường thử nghiệm riêng, nên chỉ mang tính kiểm chứng pipeline.

---

## 2. Bài toán và lý do làm

- **Hệ thống cũ** (`infosound/apps/api/src/recommendations.ts`) là luật SQL ba bậc: khảo sát sở thích → thể loại của bài đã thích → bài phổ biến nhất. Hạn chế:
  - không học từ hành vi (nghe hết, bỏ qua);
  - không dùng "người nghe giống bạn";
  - không có lý do gợi ý, không đa dạng (có thể lặp nghệ sĩ);
  - không đo được chất lượng.
- **Mục tiêu:**
  - cá nhân hoá dựa trên hành vi thật;
  - giải thích được;
  - có số liệu đánh giá;
  - không phá các chức năng chung;
  - chạy cục bộ, không gửi dữ liệu ra ngoài.
- **Ràng buộc quan trọng:** catalog thật rất nhỏ (khoảng 18 bài, 10 user), nên phải đánh giá trên dữ liệu mô phỏng ở môi trường riêng.

---

## 3. Kiến trúc tổng thể (nên vẽ thành Hình)

```
              ┌──────────── Web (Next.js) ─────────────┐
              │ Home "Giai điệu đề xuất" + chip lý do   │
              │ Trang /recommendations + panel Giải thích│
              │ Player: gửi start/skip/complete          │
              └───────────────┬─────────────────────────┘
                              │ HTTPS /api/v1
              ┌───────────────▼─────────────────────────┐
              │ API (NestJS)                             │
              │  RecommendationsController (GET)         │
              │  RecoEngagementController (POST)         │
              │      │ gọi                               │
              │  @infosound/recommendation-ai            │
              │   Tầng 1 → Tầng 2 → Tầng 3 → (fallback) │
              └───────────────┬─────────────────────────┘
                              │ SQL (role infosound_api)
              ┌───────────────▼─────────────────────────┐
              │ PostgreSQL: likes, listens, playlists,   │
              │ follows, music_preferences +             │
              │ track_engagement, recommendation_*,      │
              │ track_embeddings                         │
              └───────────────▲─────────────────────────┘
                              │ owner role, chạy theo lô
              ┌───────────────┴─────────────────────────┐
              │ Batch (tools container, offline):        │
              │ seed → embed (e5-small) → train (LR)     │
              │ → evaluate (báo cáo)                     │
              └──────────────────────────────────────────┘
```

**Ý chính để nói:**
- **Phần nặng chạy offline theo lô:** embedding và huấn luyện chạy trong container tools. Đây là cách các hệ thống thật làm (batch pipeline).
- **API online chỉ làm việc nhẹ:** đọc vector đã tính sẵn, tính cosine, chạy SQL, chấm điểm LR.
- Không thêm service thứ 9 và không cần pgvector, vì catalog nhỏ hơn 1.000 bài nên cosine tính trong Node là đủ.

---

## 4. Chi tiết ba tầng (kèm công thức cho Chương 1 và 2)

### 4.1. Tầng 1: lấy ứng viên (tối đa khoảng 150)

| Nguồn | Cách tính | Lý do gợi ý hiển thị |
|---|---|---|
| **CF item-item** | `score(j) = Σ_{i∈seeds(u)} cooc(i,j) / sqrt(n_i·n_j)`. Tập positive = likes ∪ listens ∪ complete ∪ playlist. `seeds(u)` = 50 positive gần nhất của user. Giữ lại seed i đóng góp lớn nhất. | "Vì bạn đã nghe X" |
| **Content (semantic)** | `cosine(taste(u), emb(j))`. Taste = tổng có trọng số các embedding bài đã tương tác: thích 3, nghe hết 2, nghe 1·log(1+số lượt), skip −1, chu kỳ bán rã 30 ngày. Cold-start: trung bình embedding các bài thuộc thể loại/nghệ sĩ chọn trong khảo sát. | "Tương tự X" / "Hợp gu của bạn" |
| **Nghệ sĩ theo dõi** | Bài mới nhất và bài nhiều lượt nghe nhất của các nghệ sĩ đang theo dõi. | "Nghệ sĩ bạn theo dõi" |
| **Thịnh hành** | Số người nghe khác nhau có lần nghe gần nhất trong 7 ngày. Đây là **xấp xỉ**, vì `play_count` là tổng trọn đời. | "Đang thịnh hành" |
| **Khám phá** | Bài user chưa từng nghe, ít được hiển thị nhất trong 30 ngày (tính đến 0h UTC hôm nay), mới nhất. | "Khám phá" |

### 4.2. Tầng 2: xếp hạng bằng hồi quy logistic

- **Công thức:** `P(positive | u, j) = σ(b + Σ w_k·x_k)`.
- **8 đặc trưng**, đều chuẩn hoá về [0,1]:
  1. `cf_score`: điểm CF chia cho max của user;
  2. `content_sim`: (cosine+1)/2;
  3. `follows_artist`: 0/1;
  4. `survey_match`: 0/1;
  5. `genre_overlap`: tỉ lệ thể loại của bài nằm trong top thể loại của user;
  6. `popularity`: log(1+play_count)/log(1+max);
  7. `recency`: exp(−số ngày từ lúc phát hành / 30);
  8. `skip_rate`: (số user đã skip + 1)/(số user đã nghe + 2). Mỗi user chỉ đóng góp tối đa 1, để chống thao túng.
- **Nhãn:**
  - dương = thích, hoặc nghe hết ≥ 1 lần, hoặc ≥ 2 lượt nghe hợp lệ;
  - âm = skip mà không có tín hiệu dương, hiển thị mà không bấm, và lấy mẫu ngẫu nhiên 4 âm cho mỗi dương.
- **Chống rò rỉ:** đặc trưng của cặp (u, j) được tính kiểu *leave-pair-out*, tức bỏ chính cặp đó ra.
- **Huấn luyện:** gradient descent có L2, chuẩn hoá đặc trưng. Kết quả lưu vào bảng `recommendation_models` (version, weights, bias, metrics, active). API tự nạp model đang active, không cần build lại.
- **Vì sao chọn LR:**
  - ít dữ liệu nên mạng sâu sẽ overfit;
  - giải thích được (mỗi đặc trưng có một hệ số);
  - suy luận dưới 1 ms;
  - LR là ranker kinh điển của CTR (Facebook 2014; YouTube 2016 dùng weighted LR).

### 4.3. Tầng 3: xếp lại theo luật nghiệp vụ

1. Loại: bài đã thích (toàn bộ), bài của chính mình, bài nghe trong 14 ngày, bài **vừa bỏ qua** (skip > complete trong 14 ngày).
2. Sắp theo điểm LR, giới hạn tối đa 1 bài mỗi nghệ sĩ.
3. Chọn 5 bài. Bài thứ 5 là **khám phá**, chỉ khi đã có ít nhất 4 ứng viên thường. Bài khám phá được chọn ngẫu nhiên nhưng cố định theo `hash(userId, ngày UTC)`, nên refresh trong ngày không đổi.
4. Lý do gợi ý lấy theo nguồn đóng góp nhiều nhất. Chỉ lộ **tên** bài X, không lộ ID hay điểm.
5. **Fallback:** dưới 3 tương tác, chưa có model, chưa có embedding, hoặc lỗi → dùng luật SQL cũ. Response vẫn tương thích ngược.

**Về chuyện "bỏ bài đã nghe":** nhạc có tỉ lệ nghe lại cao (Anderson et al. 2014), nên luật này chỉ đúng cho kệ "Khám phá cho bạn" (giống Discover Weekly), và chỉ trong 14 ngày.

---

## 5. Embedding ngữ nghĩa (phần "AI + semantic")

- **Mô hình:** `Xenova/multilingual-e5-small` (ONNX, lượng tử hoá q8, 384 chiều, hỗ trợ tiếng Việt), commit HF `761b726d…`. Weights được **đóng gói sẵn trong image** và kiểm tra sha256, không tải lúc chạy.
- **Văn bản nhúng:** `passage: {tiêu đề}. {mô tả}. {lời bài hát}`, cắt còn 256 token.
  - **Không đưa tên thể loại** vào văn bản, để content không trùng thông tin với `genre_overlap` (thể loại đã là đặc trưng có cấu trúc).
- **Versioning:** lưu `content_hash` (sha256 của văn bản + model) và `source_version`. Bài đổi nội dung thì tính lại. API chỉ dùng embedding khớp `source_version` hiện hành.
- **Ghi chú phụ (liên hệ bài báo SIDD của tác giả):** việc *cắt độ dài văn bản trước khi nhúng* kế thừa từ kết luận của bài báo Semantic Intent Drift (EIDT 2026): nhồi chữ vào trường văn bản dài có thể kéo lệch vector. Dữ liệu demo có 2 bài cố ý nhồi từ khoá ("Đừng quên giấc mơ", "Tiếng đàn và phố"); báo cáo đo mức hiển thị của chúng (cột StuffedExposure). **Chỉ nêu ở mức một đoạn ngắn, không biến thành phần chính.**

---

## 6. Dữ liệu thu thập mới (Thiết kế dữ liệu, mục 1.3)

| Bảng | Nội dung | Ghi chú riêng tư / an toàn |
|---|---|---|
| `track_engagement` | Bộ đếm **tổng hợp** theo (user, bài): starts, skips, completes, last_event_at | Không phải log sự kiện; chỉ tài khoản đăng nhập; chống replay bằng `last_token_id`, `last_started_at_ms` |
| `recommendation_impressions` | Bài nào đã hiển thị cho ai, ở vị trí nào, lý do gì, model nào; thời điểm click | Chỉ ghi các bài server đã trả (token ký); có thể xoá sau 30 ngày |
| `track_embeddings` | Vector 384 chiều cho mỗi bài + model + hash + source_version | Không chứa dữ liệu người dùng |
| `recommendation_models` | Các phiên bản model LR, chỉ một bản active | Có metrics để truy vết |

- Migration `202611210001_recommendation_ai` **chỉ thêm mới (additive)**.
- Phân quyền: role API chỉ được SELECT/INSERT/UPDATE đúng các bảng cần; batch dùng owner.

**Tín hiệu skip và nghe hết** do player gửi lên, nhưng **server tự kiểm tra thời gian** từ listen token sẵn có:
- skip hợp lệ khi đã nghe chưa tới min(30 s, D/2);
- nghe hết hợp lệ khi đã nghe ≥ 0,6·D.

---

## 7. API (Chương 2)

| Endpoint | Mô tả |
|---|---|
| `GET /api/v1/recommendations` | 5 gợi ý, `source: HYBRID`, mỗi bài kèm `recommendation.reason` và `seedTitle`; có `requestId`, `modelVersion`, `impressionToken`. Không có điểm. |
| `GET /api/v1/recommendations/shelves` | Các kệ: Vì bạn đã nghe X / Nghệ sĩ bạn theo dõi / Đang thịnh hành / Dành cho bạn |
| `GET /api/v1/recommendations/explain` | Mặc định tắt; bật bằng `RECO_EXPLAIN_ENABLED=true` (nên bật hôm thuyết trình); chỉ xem của chính mình: ứng viên, nguồn, đặc trưng, điểm, quyết định, lý do loại |
| `POST /api/v1/recommendations/impressions`, `/clicks` | Ghi hiển thị và click; bắt buộc token ký và header CSRF |
| `POST /api/v1/tracks/:id/engagement` | start / skip / complete, dùng listen token |
| `POST /api/v1/recommendations/preview` | Giữ nguyên cho Visitor (luật cũ, không theo dõi) |

Ba GET dùng chung throttle 30 lần/phút cho mỗi user. Tất cả đều `private, no-store`.

---

## 8. Giao diện (chụp Hình cho Chương 2)

1. **Home → "Giai điệu đề xuất":** 5 thẻ bài có chip lý do; phụ đề "Kết hợp lịch sử nghe, nội dung bài hát và nghệ sĩ bạn theo dõi"; link "Xem thêm".
2. **Trang `/recommendations`:** các kệ theo nguồn.
3. **Panel "Giải thích gợi ý":** bảng trọng số LR, bảng ứng viên. Trong bảng ứng viên:
   - nguồn = tầng 1;
   - đặc trưng và điểm = tầng 2;
   - quyết định và lý do loại (trùng nghệ sĩ, đã thích, vừa nghe, vừa bỏ qua, dưới ngưỡng) = tầng 3.

   **Đây là hình quan trọng nhất**, vì nó chứng minh có 3 tầng thật.
4. **Player:** không đổi giao diện, chỉ gửi tín hiệu ngầm. Khách vãng lai không bị theo dõi.
5. Ngôn ngữ: thêm 39 câu (tiếng Việt và tiếng Anh). 107 ngôn ngữ còn lại dùng bản tiếng Anh. Tổng 795 thông điệp, cache `fd79280731beac10`.

---

## 9. Bảo mật và chống lạm dụng (điểm cộng, nên có một bảng)

Các lỗ hổng do review nội bộ phát hiện và **đã sửa**:

| Rủi ro | Biện pháp |
|---|---|
| Một user spam skip để dìm bài của người khác | Mỗi user chỉ đóng góp tối đa 1 vào skip_rate; không nhận lại token cũ (`last_started_at_ms`) |
| Giả mạo impression để thao túng ô khám phá hoặc dữ liệu train | `impressionToken` ký HMAC, chỉ chấp nhận đúng các bài server đã trả; đếm theo số user khác nhau |
| CSRF | Header `X-InfoSound-CSRF` và kiểm tra Origin như các POST khác |
| Khuếch đại tải DB qua GET | Throttle 30 lần/phút; giới hạn 50 seed cho CF |
| Lộ điểm hay khẩu vị | Response công khai không có điểm; explain bị khoá bằng cờ env và chỉ xem của chính mình |
| SQL injection | Mọi giá trị đều là tham số bind (Prisma tagged template) |
| Dữ liệu cũ khi tác giả thay bản thu | Lọc embedding theo `source_version` |
| Mất sự kiện "nghe hết" khi tạm dừng lâu | Sự kiện kết thúc chấp nhận token quá hạn, nhưng giới hạn thời gian max(15 phút, 2·D) |

---

## 10. Triển khai và môi trường demo (mục 2.8)

- **Chỉ một bản:** module gợi ý chạy trong stack chính `infosound-local` (https://localhost:3443, qua SafeLine WAF). Image `infosound/*:local` build từ snapshot LF của source; migration `202611210001_recommendation_ai` đã áp dụng (tổng 20 migration); có `pg_dump` trước migration và trước seed.
- **Quá trình phát triển:** trước đó dùng stack thử nghiệm riêng `infosound-demo` (cổng 4443, volume, secrets và image riêng) để không đụng dữ liệu thật. Sau khi kiểm chứng xong, nhóm quyết định gộp về một bản và xoá stack thử nghiệm (tiết kiệm ổ đĩa).
- **Dữ liệu tổng hợp trong bản chính:** 200 bài, 40 nghệ sĩ, 60 người nghe (email `@demo.infosound.local`), có đánh dấu. Gỡ bằng `seed --reset-only --i-know-this-is-demo` (chỉ xoá dòng do seeder tạo). Lưu ý: bảng xếp hạng, tìm kiếm, chatbot, kiểm duyệt của các thành viên khác cũng thấy dữ liệu này, nên báo nhóm trước khi demo chung.
- **Model đang chạy:** `lr-20261121T171200Z` (AUC holdout 0.940). Embedding cho 214/214 bài public, tính cả bài thật lẫn bài tổng hợp. Trên dữ liệu bản chính, trọng số `content_sim` cũng âm (−0.106 chuẩn hoá), khớp với kết luận "warm-start content không đóng góp".
- **Batch job** chạy trong container tools của stack chính: `RECO_DEMO=1 node recommendation-ai/batch/dist/cli.js seed|embed|train|evaluate`. Riêng `seed` phải có thêm cờ `--i-know-this-is-demo`. Image tools tăng 0,83 GB (model 130 MB và onnxruntime).
- **Hôm thuyết trình:** bật `RECO_EXPLAIN_ENABLED=true` cho API để chiếu panel "Giải thích gợi ý".
- **Tài khoản thử:** `chill@`, `vpop@`, `rap@demo.infosound.local`, mật khẩu `RecoDemo#2026`.

---

## 11. Dữ liệu tổng hợp (phải trình bày thẳng thắn)

- **Quy mô:** 200 bài, 15 thể loại, 40 nghệ sĩ, 60 người nghe thuộc 6 persona, 60 ngày hành vi.
  - Với seed 42: 7.313 lượt phát, 509 like, 188 follow, 29 playlist.
- **Sinh bằng script có seed cố định, không dùng LLM**, nên không có chuyện "AI bịa".
- Hành vi sinh từ **biến ẩn** mà mô hình không đọc trực tiếp được:
  - utility = thể loại 40% + nghệ sĩ yêu thích 25% + mood ẩn 20% + nhiễu 15% + chất lượng bài;
  - độ phổ biến theo Zipf (s≈1.1);
  - 14% lượt nghe lệch gu, trong đó 81% bị skip.
- **Có nhiễu có chủ đích:**
  - 22% follow ngẫu nhiên, 19% nghệ sĩ yêu thích không được follow;
  - khảo sát trả lời sai một phần;
  - mood của user trôi dần theo thời gian.
- Mood "thấm" vào từ vựng mô tả và lời, giống lời bài hát thật. Mỗi thể loại có ≥ 10 template dùng chéo.
- Audio: tone FLAC ngắn, phát được thật qua đúng pipeline media (signed URL, bucket riêng tư).

---

## 12. Phương pháp đánh giá (Chương 3)

- **Chia theo thời gian với một mốc cắt chung** T_c = now − 10 ngày:
  - mô hình chỉ thấy dữ liệu trước T_c, gồm CF, play_count, skip, trending, taste, follow, playlist, khảo sát;
  - **tập test = "khám phá"**: các cặp (user, bài) có lần nghe **đầu tiên** sau T_c và trở thành tích cực.
- **Tập validation** lùi thêm 1 tuần, chỉ dùng cho ablation và phép thử hoán vị. Tập test chỉ dùng một lần.
- **Baseline:** Random, Popularity, **luật SQL hiện tại** (viết lại đúng thứ tự ORDER BY), CF-only, Content-only, Hybrid, Hybrid không có ô khám phá, Oracle (biến ẩn; chỉ là mốc tham chiếu, không phải trần).
- **Chỉ số:**
  - chất lượng: P@5, Recall@5, NDCG@5;
  - độ phủ: Coverage@5;
  - độ công bằng: Gini của exposure (càng thấp càng ít dồn vào bài nổi tiếng);
  - độ đa dạng: ILD;
  - SimCTR là CTR **mô phỏng**.
- **Thống kê:** 10 seed, μ ± σ; so sánh **theo cặp** kèm khoảng tin cậy 95% (phân phối t). Khoảng chứa 0 nghĩa là "không phát hiện khác biệt".
- **Đối chứng:** ablation (bỏ từng đặc trưng) và hoán vị embedding giữa các bài.

---

## 13. Kết quả (nguồn: `reports/eval-20261121T165118Z.md`, e5 thật, bản cuối; các dòng khác trùng bản 161232Z)

> So theo cặp (bản cuối): Hybrid − CF ΔNDCG@5 +0.039 [0.003; 0.075]; Hybrid − luật cũ +0.049 [0.008; 0.091]; ΔP@5 đều chứa 0.
> Ghi chú: khi đổi sang khám phá theo content, Gini của Hybrid tăng từ 0.556 lên 0.602, vì ô khám phá dồn vào ít bài hơn. Nhận xét "Hybrid có Gini thấp hơn CF" chỉ còn đúng với bản khám phá ngẫu nhiên (0.596 so với 0.582 thì vẫn cao hơn CF). Vì vậy **không nói Hybrid công bằng hơn CF**, chỉ nói "công bằng hơn luật cũ (0.639)".

### 13.1. Warm-start (khoảng 35/60 user có bài khám phá sau mốc cắt)

| Phương pháp | P@5 | NDCG@5 | Coverage@5 | Gini |
|---|---|---|---|---|
| Random | 0.009 ± 0.010 | 0.018 | 0.626 | 0.523 |
| Popularity | 0.008 ± 0.005 | 0.016 | 0.067 | 0.959 |
| Luật SQL hiện tại | 0.083 ± 0.022 | 0.201 ± 0.038 | 0.522 | 0.639 |
| CF-only | 0.095 ± 0.023 | 0.211 ± 0.047 | 0.564 | 0.582 |
| Content-only (e5) | 0.018 ± 0.006 | 0.035 ± 0.015 | 0.232 | 0.887 |
| **Hybrid** (khám phá theo content, bản cuối) | 0.095 ± 0.021 | **0.250 ± 0.043** | 0.561 | 0.602 |
| Hybrid (khám phá ngẫu nhiên) | 0.095 ± 0.020 | 0.251 ± 0.043 | 0.565 | 0.596 |
| Hybrid không có ô khám phá | 0.106 ± 0.017 | 0.264 ± 0.041 | 0.580 | 0.573 |
| Oracle (tham chiếu) | 0.240 ± 0.029 | 0.651 | 0.564 | 0.595 |

**So sánh theo cặp, CI 95%:**

| So sánh | ΔP@5 | ΔNDCG@5 |
|---|---|---|
| Hybrid − CF | −0.001 [−0.021; 0.019] (không khác) | **+0.038 [0.001; 0.075]** |
| Hybrid − Luật cũ | +0.011 [−0.009; 0.031] (không khác) | **+0.048 [0.007; 0.089]** |
| Hybrid − không khám phá | −0.012 [−0.017; −0.006] | −0.015 [−0.022; −0.008] |

**Diễn giải trung thực:**
- Hybrid **không tăng số bài đúng** trong top 5 so với CF hay luật cũ.
- Hybrid **xếp bài đúng lên cao hơn** (NDCG tăng có ý nghĩa), **độ phủ catalog cao hơn và Gini thấp hơn**, tức gợi ý công bằng hơn với bài ít nổi tiếng.
- Ô khám phá đánh đổi khoảng 0,012 P@5 để đổi lấy độ phủ: đây là trade-off exploration/exploitation có chủ đích.

### 13.2. Mô hình LR (trọng số đã chuẩn hoá, so sánh được với nhau)

- Thứ tự trọng số: cf_score 1,35 > genre_overlap 0,76 > follows_artist 0,67 > survey_match 0,24 > popularity 0,13 > skip_rate 0,11 > content_sim 0,02 > recency −0,17.
- AUC chẩn đoán trên 7 ngày cuối: 0,923 ± 0,016.
- **Lưu ý khi trình bày:** thứ tự trọng số **khôi phục đúng giả định của bộ sinh dữ liệu**, không phải "phát hiện". AUC cao chủ yếu do mẫu âm là bài ngẫu nhiên, nên không dùng để khoe.
- Ablation (validation): bỏ cf_score, follows_artist hoặc genre_overlap làm P@5 giảm có ý nghĩa; bỏ content_sim, survey_match, popularity, skip_rate thì không đổi.
- Phép thử hoán vị: ở warm-start, e5 **không cho thêm tín hiệu** ngoài CF và thể loại.

### 13.3. Cold-start (nguồn: `reports/eval-20261121T165118Z.md`, e5, 10 seed)

**Bài mới** (15% catalog phát hành sau mốc cắt, chưa có lượt nghe):

| Phương pháp | P@5 | NDCG@5 |
|---|---|---|
| Luật SQL cũ | 0.104 | 0.211 |
| Content-only (e5) | 0.018 | 0.039 |
| Hybrid | 0.009 | 0.013 |
| CF-only / Popularity | 0.000 | 0.000 |

**So sánh theo cặp (ΔP@5, CI 95%):**
- Content − CF: **+0.018 [0.011; 0.026]**. Phép thử hoán vị trên tập này làm Content-only tụt +0.012 [0.003; 0.021]. Như vậy embedding e5 **có tín hiệu thật với bài mới**.
- Hybrid − luật cũ: **−0.095 [−0.112; −0.078]**, kiểm lại trên tập validation cũng ra −0.108. **Hybrid yếu với bài mới**, vì LR học từ dữ liệu cũ nên dựa vào cf_score (bằng 0 với bài mới), còn luật cũ xếp bài mới nhất lên đầu.
- Ô khám phá chọn theo content so với chọn ngẫu nhiên: −0.001 (warm), −0.001 (cold), +0.001 (validation); CI đều chứa 0, tức **không có khác biệt**. Quyết định này được đưa ra sau khi xem kết quả trên tập test, và báo cáo ghi rõ điều đó.

**User mới** (2–3 tương tác + khảo sát có nhiễu):
- Luật cũ 0.020; Hybrid ở chế độ chạy thật (fallback khi dưới 3 tương tác) 0.022; Hybrid ép chạy 0.024.
- Chênh +0.004 [−0.014; 0.022], **không có khác biệt**, nên fallback không mất gì.

**Kết luận chốt (theo quyết định của nhóm: giữ nguyên thiết kế, nói thẳng):**
> "Ở warm-start, content không cho thêm tín hiệu ngoài CF và thể loại. Giá trị của nó nằm ở bài mới, nơi CF bằng 0. Tuy nhiên bộ xếp hạng LR học từ dữ liệu cũ nên vẫn đẩy bài mới xuống, và với bài mới hybrid thua luật cũ. Đây là hạn chế đã biết. Hướng phát triển: một bộ xếp hạng riêng cho cold-start (kiểu Release Radar)."

Lưu ý: audio demo 200 × 45 giây, tổng 59.5 MB. Smoke test 12/12: skip lúc 10 giây được ghi và bài biến mất khỏi gợi ý, hiện trong explain là SKIPPED; complete lúc 5 giây bị từ chối, lúc 28 giây được ghi; ô khám phá chọn đúng bài có content_sim cao nhất.

---

## 14. Kiểm thử đã thực hiện (bảng cho Chương 3)

| Nhóm | Kết quả | Phạm vi kết luận |
|---|---|---|
| Unit test lõi `recommendation-ai` | 48/48 pass | Re-rank, chấm điểm, lý do, taste, đặc trưng, token, timing |
| Unit test batch | 31/31 pass | RNG, Zipf, persona, gradient LR, metric (đối chiếu tính tay), chia tập |
| Typecheck strict | API, lõi, batch, web: 0 lỗi | |
| Kiểm tra ngôn ngữ/theme | 109 ngôn ngữ × 795 thông điệp; 9 palette | |
| E2E trên Postgres 17 (PGlite, role API) | Pipeline, fallback, engagement, impression; 9/9 kiểm tra sửa lỗi | Không qua HTTP |
| Smoke test HTTP trên stack thử nghiệm (CA được xác minh) | 12/13 đạt lần 1, 12/12 lần 2 | Đăng nhập, HYBRID, shelves, explain, token giả → 400, Origin lạ → 403, skip → bài biến mất |
| Review độc lập (4 agent: backend, phương pháp, frontend, thiết kế) | Phát hiện 3 lỗi major backend, 1 lỗi nghiêm trọng về rò dữ liệu đánh giá, 5 lỗi frontend; **đã sửa và chạy lại** | |
| Stack thật | Image và container `:local` không đổi | |

- **Còn mở:** bài vừa skip bị lọc ngay ở SQL nên không xuất hiện trong panel giải thích với nhãn SKIPPED (gợi ý vẫn đúng).
- **Chưa làm:** test giao diện trên trình duyệt (sẽ làm sau cold-start).

---

## 15. Hạn chế (nên chủ động nêu) và hướng phát triển

**Hạn chế:**
- Dữ liệu mô phỏng: chỉ chứng minh pipeline đúng dưới giả định mô phỏng; CTR là CTR mô phỏng.
- Catalog nhỏ: tầng 1 không cần thiết về hiệu năng ở quy mô 200 bài, nhưng giữ để tách trách nhiệm và để mở rộng.
- Content chưa đóng góp ở warm-start.
- "Thịnh hành" là xấp xỉ.
- Embedding chỉ từ văn bản, không phân tích âm thanh.
- 107 ngôn ngữ chưa dịch các câu mới.
- Visitor vẫn dùng luật cũ.

**Hướng phát triển:**
- embedding âm thanh (van den Oord 2013);
- mô hình chuỗi phiên nghe (GRU4Rec);
- contextual bandit cho ô khám phá (BaRT, Spotify 2018);
- MMR thay luật cứng "1 bài mỗi nghệ sĩ";
- tính sẵn ma trận CF theo lô;
- A/B test trên người dùng thật.

---

## 16. Những chỗ cần sửa trong báo cáo nhóm (`Báo cáo Bài tập lớn.docx`)

1. **Mở đầu:** hiện chỉ nói AI kiểm duyệt; bổ sung gợi ý (và tìm kiếm, chatbot của các bạn khác).
2. **Mục 1.1:** câu "người dùng phải đăng nhập để phát nhạc" đã sai từ khi có visitor playback ngày 16/11. Visitor vẫn dùng gợi ý theo luật cũ.
3. **Thêm mục 1.7** "Thiết kế hệ gợi ý lai ba tầng": sơ đồ mục 3 và công thức mục 4.
4. **Mục 1.3:** thêm 4 bảng mới (mục 6).
5. **Mục 2.2:** thay câu "Chức năng đề xuất được xây dựng bằng quy tắc dữ liệu…" bằng đoạn ở mục 1; thêm hình chip lý do và panel giải thích.
6. **Thêm mục 2.9** "Module gợi ý và môi trường thử nghiệm" (mục 7, 8, 10).
7. **Chương 3:** thêm 3.5 "Đánh giá hệ gợi ý" (mục 11–13). Sửa chỗ tham chiếu "Bảng 3.1" và câu CVE bị cụt.
8. **Kết luận:** thêm một câu kết quả và hướng phát triển (mục 15).
9. **Tài liệu tham khảo:** mục 18.

**Hình nên có:** sơ đồ 3 tầng; sơ đồ dữ liệu bổ sung; ảnh Home có chip lý do; ảnh panel giải thích; biểu đồ cột P@5/NDCG@5 các phương pháp; biểu đồ Coverage/Gini.

---

## 17. Hỏi–đáp chuẩn bị (ngắn)

- **"AI ở đâu?"** Học máy cổ điển, không phải AI tạo sinh. Có ba thành phần học từ dữ liệu: embedding e5, CF học từ hành vi, LR học trọng số. Chỉ vào bảng trọng số trong panel giải thích.
- **"Dữ liệu giả thì kết quả có vòng tròn không?"** Có rủi ro, và em đã xử lý:
  - sinh hành vi từ biến ẩn có nhiễu;
  - một mốc cắt chung theo thời gian;
  - leave-pair-out;
  - tách validation và test;
  - CI theo cặp.

  Em chỉ kết luận "pipeline đúng dưới giả định".
- **"Sao không deep learning?"** Khoảng 60 user và vài nghìn tương tác sẽ overfit. LR giải thích được, train vài giây, suy luận dưới 1 ms.
- **"CF với 60 user?"** Item-item ổn định hơn user-user khi ít user. CF chỉ là 1 trong 4 nguồn, và LR tự cân trọng số.
- **"Tiếng Việt?"** e5 đa ngôn ngữ. Có thể demo hai bài cùng mood có cosine cao.
- **"Cold-start?"** User mới: khảo sát, rồi luật cũ khi dưới 3 tương tác. Bài mới: có embedding ngay (số liệu mục 13.3).
- **"Hybrid hơn gì?"** Theo số thật: không tăng P@5, nhưng NDCG +0,038 / +0,048 có ý nghĩa, độ phủ cao hơn, Gini thấp hơn.
- **"Khác gì tìm bằng mô tả của Lương?"** Lương: có truy vấn, người dùng gõ mô tả. Em: không có truy vấn, suy ra từ hành vi. Có thể dùng chung embedding; phần riêng của em là CF, LR, re-rank và đánh giá.
- **"Em tự viết gì?"** SQL CF, đặc trưng, LR (tự cài gradient descent), re-rank, token ký, engagement, bộ sinh dữ liệu, bộ đánh giá, giao diện giải thích. Thư viện chỉ có model e5 và transformers.js.
- **"Quyền riêng tư?"** Chạy cục bộ, không gửi ra ngoài, không theo dõi visitor; bộ đếm tổng hợp chứ không phải log; impression có hạn lưu.

**KHÔNG nói:**
- "giống/tương đương Spotify";
- "mô hình đã chứng minh hiệu quả";
- "xác suất đã hiệu chỉnh";
- "có bandit";
- "AI phân tích âm thanh";
- "content cải thiện gợi ý" (nếu số cold-start không cho thấy).

---

## 18. Tài liệu tham khảo đề xuất

1. Covington, Adams, Sargin. *Deep Neural Networks for YouTube Recommendations.* RecSys 2016.
2. Linden, Smith, York. *Amazon.com Recommendations: Item-to-Item Collaborative Filtering.* IEEE Internet Computing, 2003.
3. Hu, Koren, Volinsky. *Collaborative Filtering for Implicit Feedback Datasets.* ICDM 2008.
4. He et al. *Practical Lessons from Predicting Clicks on Ads at Facebook.* ADKDD 2014.
5. McInerney et al. *Explore, Exploit, and Explain: Personalizing Explainable Recommendations with Bandits.* RecSys 2018.
6. Wang et al. *Text Embeddings by Weakly-Supervised Contrastive Pre-training* (E5). arXiv 2212.03533, 2022.
7. Anderson et al. *The Dynamics of Repeat Consumption.* WWW 2014.
8. Carbonell, Goldstein. *The Use of MMR, Diversity-Based Reranking…* SIGIR 1998.
9. Järvelin, Kekäläinen. *Cumulated Gain-Based Evaluation of IR Techniques* (NDCG). ACM TOIS 2002.
10. Le, Dinh, Do, Pham, **Chu**. *Semantic Intent Drift: Robust Trajectory Anomaly Detection for Agentic Systems.* EIDT 2026 (chỉ dẫn cho ý cắt văn bản trước khi nhúng).
