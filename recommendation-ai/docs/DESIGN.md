# InfoSound Reco — Hybrid 3-tier music recommendation (anhcd)

Individual feature "Gợi ý nhạc bằng AI" of InfoSound (group 5, INT1434).
This file is the **shared contract** for every contributor. Change it only by agreement with the integrator.

## 0. Hard constraints
- **No LLM / Gemini / external AI service.** "AI" = local sentence embedding (multilingual-e5-small, ONNX,
  frozen) + learned logistic-regression ranker + collaborative filtering.
- Keep it simple: plain 3-tier hybrid. The SIDD idea (author's paper) is only a minor note: truncate text before
  embedding + one keyword-stuffed demo track. Do not build a "guard" subsystem.
- Do not break teammates' features (comment moderation, chatbot, describe-search) or the shared contracts in
  `infosound/AGENTS.md` (root audio player, queue, navigation, i18n, roles, listen counting).
- **Single unified deployment (since 22/11/2026, user decision):** everything runs in `infosound-local`
  (https://localhost:3443). The separate `infosound-demo` stack, its volumes and the `:reco` images were removed.
  Synthetic demo data (200 tracks, 40 artists, 60 listeners, emails `@demo.infosound.local`) was seeded into the main
  DB with `seed --i-know-this-is-demo`; a pre-seed `pg_dump` exists, and `seed --reset-only --i-know-this-is-demo`
  removes only seeder-created rows. This is an explicit, documented exception to the AGENTS.md "no seeded data" rule;
  teammates' features (charts, search, chatbot, moderation) also see these tracks. See `reports/REAL_STACK_RUN-20261122.md`.
- Recommendation endpoints stay `private, no-store`, user-scoped; public response has **no scores, no taste IDs**;
  the reason exposes only a seed track **title**. Scores only appear in the explain endpoint (flag-gated, own user).
- Visitors keep the existing stateless `POST /recommendations/preview` (rule-based). No visitor tracking.
- Any failure, missing model, missing embeddings, or a user with < 3 interactions → existing rule-based
  `userRecommendationSelection()` in `infosound/apps/api/src/recommendations.ts` (fallback, unchanged).

## 1. Model
```
Tier 1 · CANDIDATES (union, ≤150)
  CF       item-item co-occurrence over positive sets (likes ∪ track_listens ∪ engagement.completes>0 ∪ playlist_tracks),
           score(j)=Σ_{i∈seeds(u)} cooc(i,j)/sqrt(n_i·n_j); keep best seed i for the reason.
           seeds(u) = the user's 50 most recent public positives (bounded cost).
  CONTENT  cosine(taste(u), emb(j)); taste = Σ w·emb(i) with w: like 3, complete 2, listen 1·log1p(plays), skip −1,
           time half-life 30 days. Cold start: mean emb of tracks matching survey genres/artists (music_preferences).
  FOLLOW   public tracks of followed artists (newest + most played).
  TRENDING distinct listeners with track_listens.last_listened_at within 7 days (approximation; playCount is lifetime).
Tier 2 · RANKING  P(positive) = σ(b + w·x), x in FEATURE_ORDER (§2). Weights from active row of recommendation_models.
Tier 3 · RE-RANK  exclude liked, own tracks, listened in last 14 days, recently skipped (§2) → sort by score → ≤1 per artist → 5 slots;
           slot 5 = EXPLORE when ≥4 non-explore candidates exist (low-exposure/new track from the explore pool).
           Content-guided pick (item cold start, "Release Radar"-style): among eligible pool tracks (artist not yet
           chosen, not excluded) take the highest content_sim (RankedCandidate.exploreScore, set by the engine for
           explore-only candidates with an embedding); ties → seeded random hash(userId, UTC date); if no eligible
           track has an embedding → seeded-random pick over all eligible (previous behaviour). Shared via ./features.
           Explain also lists recently skipped tracks that the candidate SQL excluded, as DROPPED / SKIPPED.
           Reason per item: CF→LISTENED(seedTitle) · CONTENT→SIMILAR(seedTitle of most similar liked track, optional)
           · FOLLOW→FOLLOW · TRENDING→TRENDING · EXPLORE→EXPLORE. Pick the source with the highest contribution.
```

## 2. Features (fixed order, all in [0,1] except noted)
`FEATURE_ORDER = ['cf_score','content_sim','follows_artist','survey_match','genre_overlap','popularity','recency','skip_rate']`
- cf_score: CF score normalised by max over the user's candidates.
- content_sim: cosine mapped (c+1)/2; 0 if no embedding. Embeddings are used only when
  `track_embeddings.source_version = tracks.source_version`. The passage text is title + description + lyrics
  (**no genre names**, so content_sim does not duplicate genre_overlap); serving never reads the text itself.
- follows_artist: 0/1. survey_match: 0/1 genre or artist in music_preferences.
- genre_overlap: |genres(j) ∩ top genres of u| / |genres(j)|.
- popularity: log1p(play_count)/log1p(max play_count).
- recency: exp(−days_since_published/30).
- skip_rate: (skips+1)/(starts+2) where skips/starts are **distinct users** (per user `LEAST(count,1)`, so one account
  contributes at most 1 to each and cannot poison a track); computed **only from training-period data** during training.
- Exclusion sets used by re-rank and by the CF / content / explore candidate SQL (serving only, not features):
  liked = **all** of the user's likes (separate unbounded query, not the 500-row profile); recent = listened in 14 days;
  **skipped** = this user's `track_engagement.skips > completes` with `last_event_at` within 14 days
  (dropReason `SKIPPED`; `RerankOptions.skipped?: ReadonlySet<string>`, exported from `./features`).
- Explore pool: public tracks unseen by the user, ordered by **distinct users** shown the track in the 30 days before
  today 00:00 UTC (impressions from the current UTC day are ignored, so the daily pick is stable), then newest.
Label (training): positive = like OR completes ≥ 1 OR qualified_plays ≥ 2; negative = skipped without positive,
impressions not clicked, + random unseen public tracks (4 negatives per positive). Features for a (u,j) pair are
computed leave-pair-out (exclude the pair itself). Evaluation split (offline): ONE global cutoff T_c = now − 10 d;
everything models see is before T_c; test = (user, track) pairs whose FIRST play is ≥ T_c and positive (discovery);
validation = same construction one week earlier (ablations/permutation control only). The DB `train` command uses
a 7-day global holdout for diagnostics, then refits on all pairs.

## 3. Database (migration `infosound/packages/database/prisma/migrations/202611210001_recommendation_ai`, additive)
- `track_engagement(user_id uuid FK users ON DELETE CASCADE, track_id uuid FK tracks ON DELETE CASCADE,
   source_version int, starts int0, skips int0, completes int0, last_event_at timestamptz, last_token_id uuid NULL,
   last_started_at_ms bigint NOT NULL DEFAULT 0, PK(user_id,track_id))` — aggregated counters (NOT an event log),
   upsert only, accounts only. Replay guard: a `start` is accepted only if the token's `startedAtMs` >
   `last_started_at_ms`; `skip|complete` only for the token currently in `last_token_id` (then replaced by a
   derived marker, so a second terminal event is a no-op).
- `recommendation_impressions(id uuid PK default gen_random_uuid(), request_id uuid, user_id uuid FK CASCADE,
   track_id uuid FK CASCADE, surface varchar(32), position int, reason varchar(16), model_version varchar(64),
   shown_at timestamptz default now(), clicked_at timestamptz NULL)`; unique(request_id, track_id); index(user_id, shown_at desc).
   `model_version` = the model that served the request (from the signed impression token, §4), not the currently
   active one. A click that arrives first inserts the row (surface `CLICK`); the later impression fills surface/position.
   Retention: rows older than 30 days may be deleted by the batch job.
- `track_embeddings(track_id uuid PK FK CASCADE, source_version int, content_hash char(64), model varchar(128),
   dims int, vector real[], updated_at timestamptz default now())`.
- `recommendation_models(id uuid PK, version varchar(64) UNIQUE, feature_names text[], weights double precision[],
   bias double precision, metrics jsonb, active boolean default false, created_at timestamptz default now())`;
   partial unique index on (active) where active.
- Prisma models added to `packages/database/prisma/schema.prisma` (names: TrackEngagement, RecommendationImpression,
  TrackEmbedding, RecommendationModel). Grants appended to `packages/database/grants.sql`:
  api role: SELECT on track_embeddings, recommendation_models; SELECT, INSERT, UPDATE on track_engagement,
  recommendation_impressions. Batch jobs (embed/train/seed/eval) run with the owner URL.

## 4. HTTP API (NestJS, in `infosound/apps/api`, all under /api/v1, `private, no-store`)
- Throttle: `GET /recommendations`, `/recommendations/shelves` and `/recommendations/explain` share
  `throttle('reco:'+userId, 30)` per minute (429 `RATE_LIMITED`). GETs never write.
- `GET /recommendations` (auth) — unchanged shape `{items, reason, source}` plus:
  `source` may be `'HYBRID'`; top-level `requestId: string|null`, `modelVersion: string|null`,
  `impressionToken: string|null` (opaque, server-signed: HMAC-SHA256 with the JWT secret over
  {userId, requestId, modelVersion, served trackIds + reasons, expiry 24 h}; null on fallback);
  each item may carry `recommendation?: { reason: 'LISTENED'|'SIMILAR'|'FOLLOW'|'TRENDING'|'EXPLORE', seedTitle?: string }`.
- `GET /recommendations/shelves` (auth) → `{ requestId, modelVersion, impressionToken, shelves: [{ kind:'FOR_YOU', items }, { kind:'LISTENED', seedTitle, items }, { kind:'FOLLOW', items }, { kind:'TRENDING', items }] }`
  in exactly this order (the web renders shelves in API order). FOR_YOU is computed first (full re-rank with the
  EXPLORE slot); LISTENED ("Vì bạn đã nghe X", best CF seed among the remaining candidates), FOLLOW and TRENDING are
  then filled only from candidates not already placed on an earlier shelf, so **no trackId appears on two shelves**.
  Empty shelves are omitted; ≤10 items each; one requestId/impressionToken covers all served tracks of all shelves
  (each once, with its shelf's reason). Fallback = one FOR_YOU shelf with requestId/modelVersion/impressionToken null.
  Pure assembly: `src/shelves.ts` (`assembleShelves`, unit-tested in `tests/unit/shelves.test.cjs`).
- `GET /recommendations/explain` (auth; 404 unless env `RECO_EXPLAIN_ENABLED=true`) → `{ requestId, modelVersion,
  featureNames, weights, bias, fallback: boolean, candidates: [{ trackId, title, artistName, sources: string[],
  features: Record<string,number>, score, decision: 'SELECTED'|'DROPPED', dropReason?: 'LIKED'|'RECENT'|'OWN'|'SKIPPED'|'ARTIST_CAP'|'BELOW_CUTOFF', position? }], fallbackReason? }` — own user only.
- `POST /recommendations/impressions` (auth, header `X-InfoSound-CSRF: 1`)
  `{ requestId, impressionToken, surface, items: [{ trackId, position, reason }] }` → 204; idempotent.
  The token must be valid for this user + requestId (else 400 `IMPRESSION_TOKEN_INVALID`); only trackIds in the token
  are stored, with the server's reason and served model version (client `reason` is ignored).
- `POST /recommendations/clicks` (auth, header `X-InfoSound-CSRF: 1`) `{ requestId, trackId, impressionToken }` → 204;
  upsert (works before the impression arrives); trackIds not in the token are ignored.
- `POST /tracks/:id/engagement` (auth; visitors → 204 no-op) `{ token, event: 'start'|'skip'|'complete' }` → `{ recorded: boolean }`.
  `token` = the existing listen JWT from `GET /tracks/:id/playback` (`listens.ts`). One start and one terminal event
  (skip|complete) per token id; server validates elapsed time from `startedAtMs` (skip ⇒ elapsed < min(30, D/2);
  complete ⇒ elapsed ≥ 0.6·D). Same CSRF/origin checks and throttling style as `POST /tracks/:id/listens`.
  `start` verifies the token with normal expiry (15 min). `skip|complete` verify it with `ignoreExpiration` but require
  `now − startedAtMs ≤ max(15 min, 2·D)`, so long tracks can still complete. See §3 for the replay guard.

## 5. Code layout & ownership
| Area | Path | Owner |
|---|---|---|
| Core logic package `@infosound/recommendation-ai` (candidates SQL, features, LR scorer, re-rank, reasons, explain) | `recommendation-ai/src/**`, `recommendation-ai/tests/**`, `recommendation-ai/package.json`, `tsconfig.json` | Backend |
| Migration, Prisma models, grants | `infosound/packages/database/**` (additive only) | Backend |
| API controller wiring | `infosound/apps/api/src/recommendations.controller.ts`, new `reco-engagement.controller.ts`, `app.module.ts`, `apps/api/package.json` dep | Backend |
| Embedder / seeder / trainer / evaluator (batch, Node scripts) | `recommendation-ai/batch/**` (own package `@infosound/recommendation-batch`) | Data |
| Frontend UI + player engagement hook + i18n | `infosound/apps/web/**` | Frontend |
| Workspace/Docker/compose/lockfile | `infosound/pnpm-workspace.yaml`, `infra/Dockerfile.server`, `compose*.yaml`, `pnpm-lock.yaml` (`compose.reco-demo.yaml` and `recommendation-ai/demo/**` belong to the retired demo stack) | Infra |

Module exports (`@infosound/recommendation-ai/server`):
```ts
export const FEATURE_ORDER: readonly string[];
export type RecoReason = 'LISTENED'|'SIMILAR'|'FOLLOW'|'TRENDING'|'EXPLORE';
export type RecoItem = { trackId: string; reason: RecoReason; seedTitle?: string; score: number; sources: string[] };
export type RecoResult = { requestId: string; modelVersion: string; items: RecoItem[]; explain: ExplainCandidate[] };
export function hybridRecommendations(db: PrismaClient, userId: string, opts?: { limit?: number; now?: Date }): Promise<RecoResult | null>; // null ⇒ caller falls back
export function recommendationShelves(db, userId, opts?): Promise<Shelves | null>;
// pure helpers (unit-tested): cosine, sigmoid, scoreFeatures, rerank, pickReason, seededRandom
```
The API hydrates track views with the existing `viewTrack/trackInclude/publicTrackWhere` (re-check visibility).

## 6. Batch jobs (run in the `infosound-local` tools container, owner DB URL, `RECO_DEMO=1`, never at API startup)
`seed` (synthetic catalog+behaviour, fixed seed) → `embed` (e5-small, `passage: ` prefix, title+description+lyrics (no genre names), truncate 256 tokens, skip unchanged content_hash)
→ `train` (LR, temporal split, writes recommendation_models row + activates) → `evaluate` (baselines: Random, Popularity,
current SQL rules, CF-only, Content-only, Hybrid, Oracle; P@5, NDCG@5, coverage@5, Gini of exposure, ILD; 5 seeds μ±σ; writes `recommendation-ai/reports/`).

## 7. Honesty
Results are on synthetic data and prove only that the pipeline works and each tier contributes under the simulation
assumptions. CTR is simulated. Never claim real-user effectiveness.
