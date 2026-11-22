# @infosound/recommendation-batch (DEMO ONLY)

Batch jobs for the hybrid recommender (DESIGN.md §1, §2, §6, §7): synthetic `seed`, e5 `embed`,
LR `train`, offline `evaluate`. They run in the demo tools container (compose project `infosound-demo`)
with the **owner** DB URL, and never at API startup.

## Safety guard

Every command refuses to run unless `RECO_DEMO=1`. `seed`, `embed`, `train`, `art` and `demo-user` also require the DB URL
(`DATABASE_URL_FILE`, else `DATABASE_URL`) to be a `postgres://` URL whose **database name or host contains
`demo`**, or the explicit flag `--i-know-this-is-demo`. After connecting, `current_database()` must equal the
URL's database and pass the same check. The guard runs before `@infosound/database` is loaded.
`evaluate` never opens a DB connection (it regenerates the world in memory).

## Commands

```
node dist/cli.js seed      [--seed 42] [--now ISO] [--reset | --reset-only] [--skip-audio]
node dist/cli.js embed     [--force]
node dist/cli.js train     [--seed 42] [--now ISO] [--no-activate]
node dist/cli.js evaluate  [--seeds 42,43,44,45,46] [--now ISO] [--embedder auto|e5|hash] [--out DIR]
node dist/cli.js art       [--force] [--covers-only | --avatars-only]
node dist/cli.js demo-user --user-email EMAIL [--now ISO] [--reset]
```

Since 22/11/2026 these run in the `infosound-local` tools container (single deployment, see DESIGN.md §0) with
`RECO_DEMO=1` and `--i-know-this-is-demo`.

Order: `seed` → `embed` → `train` (→ the API uses the active `recommendation_models` row) → `evaluate`.

| Variable | Used by | Meaning |
|---|---|---|
| `RECO_DEMO=1` | all | mandatory |
| `DATABASE_URL_FILE` / `DATABASE_URL` | seed, embed, train | owner URL of the demo DB |
| `S3_INTERNAL_ENDPOINT`, `S3_WORKER_ACCESS_KEY_FILE`, `S3_WORKER_SECRET_KEY_FILE` | seed | playback upload (identity overridable with `RECO_S3_IDENTITY`, default `WORKER`, which has `Write:audio-playback/*`) |
| `FFMPEG_PATH` | seed | ffmpeg binary (default `ffmpeg`) |
| `RECO_AUDIO_MAX_MB` | seed | budget for all demo FLAC files (default 200) |
| `RECO_MODEL_DIR` | embed, evaluate | local weights; remote download disabled when set |
| `RECO_MODEL_DTYPE` | embed, evaluate | default `q8` (`onnx/model_quantized.onnx`); `fp32` → `onnx/model.onnx` |
| `RECO_THREADS` | embed, evaluate | ONNX intra-op threads (default 1) |
| `RECO_S3_IDENTITY` | seed, art, reset | S3 identity override. Defaults: `WORKER` for audio-playback, `API` for artwork (`Write:artwork/*`). The local tools container only mounts the bootstrap keys, so it runs with `RECO_S3_IDENTITY=BOOTSTRAP` |

`RECO_MODEL_DIR` layout (transformers.js resolves `${RECO_MODEL_DIR}/${modelId}/…`):

```
$RECO_MODEL_DIR/Xenova/multilingual-e5-small/config.json
                                            /tokenizer.json
                                            /tokenizer_config.json
                                            /special_tokens_map.json
                                            /onnx/model_quantized.onnx
```

Model: `Xenova/multilingual-e5-small`, revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, mean pooling +
L2 normalisation, 384 dims, batch 16, tokenizer truncation at 256 tokens. Text (same in `embed` and `evaluate`):
`passage: ${title}. ${description}. ${first 4 lyric lines joined " / "}`. Genre names are deliberately NOT in the
text: genre is already a structured feature, and embedding it would make content_sim a second genre signal.
`track_embeddings.model` = `Xenova/multilingual-e5-small@761b726dd34f:q8`;
`content_hash` = sha256(`${model}\n${text}`); unchanged rows are skipped (`--force` re-embeds).

## Demo accounts (synthetic, demo-only)

| Persona | Email | Password |
|---|---|---|
| Chill / Lo-fi | `chill@demo.infosound.local` | `RecoDemo#2026` |
| V-pop / Ballad / Bolero | `vpop@demo.infosound.local` | `RecoDemo#2026` |
| Rap / Hip-hop / R&B | `rap@demo.infosound.local` | `RecoDemo#2026` |

This password exists only in the isolated demo DB; never reuse it. Other demo users/artists have no password.

## What `seed` writes

Deterministic for a given `--seed` and `--now` (default: current UTC minute, so "last 7/14 days" make sense).

- 40 AUTHOR artists (`artistNN@demo.infosound.local`), 200 tracks over 15 existing selectable genres
  (pop, v-pop, ballad, bolero, r-and-b, hip-hop, rap, rock, indie, edm, lo-fi, acoustic, jazz, folk, k-pop),
  60 listeners from 6 personas (`listenerNN@…` plus the 3 named accounts).
- Latent variables the recommender cannot read: 4-d mood vectors (track mood = 0.7·genre centroid + artist style
  + N(0, 0.5), so only partly genre-determined; user mood = persona + N(0, 0.35), drifting by N(0, 0.3) over the
  window), track quality, per-user mixing weights (Dirichlet around genre 40 % / artist loyalty 25 % / mood 20 % /
  noise 15 %), 3 favourite artists, and a linear genre-taste drift over the 60 days. Users are Dirichlet perturbations of their persona; "Party" and
  "Eclectic" are multi-genre personas.
- Base popularity: Zipf s = 1.1 over shuffled ranks (independent of genre). 10–20 % off-taste plays
  (popularity-driven). Skips from taste (sigmoid of utility) and a 7 % random cause.
- Plays over 60 days → `track_listens` (qualified_plays, last_listened_at = last_counted_at),
  `track_engagement` (starts/skips/completes), likes, `tracks.play_count` = Σ qualified plays.
- `artist_follows`: from LATENT favourites only (each followed with p = 0.75, so some stay unfollowed) plus one
  random artist for 75 % of users (~25 % of follows are noise); never derived from likes; timestamped.
- Playlists contain only tracks the user played before the playlist's creation time.
- `music_preferences` (~half the users, all showcase users) are noisy: sometimes a single genre, each genre answer
  wrong with p = 0.25, the optional artist a real favourite only 60 % of the time.
  No comments (moderation pipeline makes them non-trivial).
- Vietnamese titles/descriptions/lyrics from shared template pools (≥ 10 per genre, overlapping). The latent mood
  leaks densely into the vocabulary (mood words chosen ∝ mood², a mood sentence in every description, a mood word
  on ~60 % of lyric lines); a genre flavour phrase appears in only ~30 % of descriptions; staggered `published_at` (~12 % in the last 14 days); 2 low-popularity acoustic/folk/jazz tracks
  with keyword-stuffed descriptions (SIDD minor demo; behaviour unchanged).
- Audio: a 45 s 16-bit mono 22.05 kHz FLAC sine (180–880 Hz, one pitch per track; long enough to demo a skip
  < 22.5 s and a complete ≥ 27 s by hand) rendered with ffmpeg. All tones are rendered first and the seed refuses if
  the total exceeds `RECO_AUDIO_MAX_MB` (default 200; the size is logged). Then uploaded to
  `audio-playback` at `${trackId}/v1/p1/${runToken}.flac` (worker layout), verified with HeadObject, then a
  verified PLAYBACK `track_assets` row (checksum sha256, size, version id), a SUCCEEDED `track_waveforms` row
  and READY/PUBLISHED tracks with `playback_asset_id` — the same shape the audio worker commits.
- All DB rows in one transaction (deferred FK + `ready_has_playback` trigger checked at commit).

Idempotency: refuses if any `@demo.infosound.local` user exists. `--reset` deletes only seeder rows (users with
that email domain, tracks they author and dependent rows; playlist_tracks/likes pointing at those tracks) and
best-effort deletes their audio objects, then re-seeds. `--reset-only` just deletes.

`--skip-audio`: for environments without ffmpeg/S3. Tracks are still READY/PUBLISHED (the DB trigger requires a
playback asset) but the PLAYBACK asset row has `verified=false` and no object, so `GET /tracks/:id/playback`
returns `ASSET_UNAVAILABLE`. Recommendations, embeddings and training still work.

## `art` (cover art + avatars for seeder rows)

Procedural images generated locally (no downloads): pure-JS pixels (`src/art-render.ts`, deterministic per id:
gradient background + one of four motifs — vinyl, sunset/hills, Bauhaus shapes, cartoon cassette — coloured by the
track's genres; artists get initials on a coloured disc, listeners a simple cartoon face), encoded by the local
ffmpeg/libwebp (quality 82, like the API's sharp settings; 640² covers, 512² avatars; no metadata; framing checked
with a port of the API's `validateNormalizedImage`).

Stored exactly like the API's processed uploads (`tracks.controller.ts` completeArtwork, `avatar.controller.ts`):
bucket `artwork`, keys `cover/<trackId>/<uuid>.webp` / `avatar/<userId>/<uuid>.webp` (uuid derived from the id, so
re-runs overwrite instead of leaking objects), `image/webp`, `Cache-Control: private, max-age=300`, HeadObject size
check; then a verified `ARTWORK` `track_assets` row (track's source version, pipeline 1, sha256 checksum, size,
version id) + `tracks.artwork_asset_id`, and `users.avatar_key/_version_id/_checksum/_size` with
`avatar_revision + 1`. A replaced different key gets an `OBJECT_DELETE` outbox event like the API. The web shows them
through the normal signed media URLs.

Only seeder rows are touched (users `@demo.infosound.local` and the tracks they author). Idempotent: rows that already
have artwork/avatar are skipped unless `--force`. `seed --reset[-only]` deletes the ARTWORK assets with the tracks and
removes the cover and avatar objects (best effort).

## `demo-user` (taste profile on an existing account)

Attaches a coherent Ballad / V-pop / Acoustic (+ a little Lo-fi) history to an **existing, normally registered USER
account** so `/recommendations` returns `HYBRID` and `/recommendations/shelves` shows FOR_YOU, LISTENED and FOLLOW.
The email is passed only on the command line (never stored in the repo); the user row itself (password, role,
sessions, avatar) is never modified. Only public demo tracks/artists are referenced:

- follows 3–4 demo artists (best Ballad, V-pop, Acoustic artist + one more core/Lo-fi artist);
- ~25 `track_listens` over the last 30 days (`qualified_plays` 1–4, `last_listened_at = last_counted_at`), about half
  of each followed artist's taste tracks, other core tracks and 3 Lo-fi tracks; ≥ 40 % of the same-taste tracks stay
  unheard so there is something to recommend;
- `track_engagement`: completes for every listen, a skip on every 6th, plus 4 skipped off-taste tracks (no listen row);
- 10 likes (most played), one private playlist (marker description `Playlist demo (dữ liệu tổng hợp, reco
  demo-user)`), `music_preferences` = core genres + the first followed artist (only if the user has no survey yet).

`tracks.play_count` follows `seed`: it is increased by the qualified plays of newly inserted listen rows only.
Idempotent: every write is insert-if-absent, so a re-run changes nothing and never overwrites the user's own activity.
`demo-user --reset --user-email EMAIL` removes the account's likes / listens (play_count decremented) / engagement /
playlist entries on demo tracks, follows of demo artists, the marker playlist and the survey answer if unchanged.
`seed --reset-only` also removes this data (marker playlist + unchanged survey explicitly; the other rows point at
demo tracks/artists and are deleted with them) but **never deletes or modifies the real account itself**.

## `train`

Loads public tracks (READY + PUBLISHED + not deleted + active author) and all interactions, embeddings for the
pinned model id, and impressions of the last 30 days. Labels: positive = like OR completes ≥ 1 OR
qualified_plays ≥ 2; negatives = observed (skipped / impressed-not-clicked without positive) then random unseen
public tracks up to 4:1; features leave-pair-out. Diagnostics use ONE global cutoff (now − 7 days) on the aggregate
tables: pairs whose latest interaction is after it are held out and removed (with their plays/skips) from the
pre-cutoff data; a model fit before the cutoff is scored on them (AUC/logloss). The aggregate tables keep no
first-event time, so this is the closest DB-computable split; `evaluate` uses the exact event-level split. The
stored model is then refit on all labelled pairs. LR: full-batch GD, L2 1e-3, lr 0.5, ≤ 3000 epochs,
standardisation folded into the stored raw-space weights (standardised weights w·σ are logged and kept in metrics).
Inserts `recommendation_models` (`version = lr-<UTC>`) and activates it (deactivating the previous one in the same
transaction).

**Deviation from DESIGN §2 (agreed with the integrator):** the per-user "last 5 positives = test" split was
replaced by a global temporal cutoff, because per-user deletion of favourites leaked information and did not measure
discovery.

## `evaluate`

Per seed (default 10 seeds, 42–51) the synthetic world is regenerated in memory (no DB) and embedded.
- ONE global cutoff T_c = now − 10 d. The models see only what existed strictly before T_c: plays, likes,
  play_count, skip statistics, CF co-occurrence, trending, taste, follows, playlists, survey, catalogue.
- **Test = discovery**: (user, track) pairs whose FIRST play is ≥ T_c and that are positive in [T_c, now), on tracks
  already published at T_c. Users without such a pair are excluded; the report gives the number remaining.
- **Validation** = the same construction one week earlier ([T_c − 7 d, T_c), trained on data before T_c − 7 d).
  Ablations (drop one feature, retrain) and the **permutation control** (embeddings shuffled across tracks) run only
  on validation; the test is touched once, for the main table.
- Methods: Random, Popularity, current SQL rules (reimplementation of `userRecommendationSelection`), CF-only,
  Content-only, Hybrid (LR + shared re-rank incl. SKIPPED, also without explore; users with < 3 interactions fall
  back to the rules like serving), Oracle (latent utility; a reference, not a ceiling).
- Metrics @5: P, Recall (differs from P now that the number of discoveries per user varies), NDCG, coverage, Gini of
  exposure, ILD, simulated CTR, stuffed-track exposure; μ ± σ over seeds; paired per-seed differences (Hybrid − CF-only,
  Hybrid − Rules, Hybrid − Hybrid w/o explore) with mean, sd and a 95 % t-interval; raw and standardised LR weights;
  a "what this shows / does not show" section with verdicts computed from the CIs.
- **Item cold start**: the same seed regenerated with 15 % of the tracks released in [T_c, T_c + 3 d) (only the release
  date changes; copy, mood and latent variables are identical to the warm world). The catalogue at recommendation time
  contains them with no plays/co-occurrence; truth = discoveries of those new tracks; Random, Popularity, Rules,
  CF-only, Content-only, Hybrid (± explore) with paired CIs and a permutation control. The EXPLORE slot is the normal
  product rule (its pool is newest-first, so it often holds a new track).
- **User cold start**: 10 test users per seed get their pre-cutoff history truncated to their first 2–3 tracks (no
  follows/playlists, a noisy survey added if missing). Rules (the survey-based fallback the product uses) vs
  "Hybrid (production)" — which IS the rules for < 3 interactions, because the API falls back below
  `MIN_INTERACTIONS = 3` — vs "Hybrid forced" (no threshold; survey cold-start taste), with a paired CI.
- **Content-guided EXPLORE** (design iteration made AFTER the round-2 cold-start test analysis): the evaluator passes
  `exploreScore = content_sim` for explore-only candidates exactly like serving (only when a content cosine exists;
  otherwise the shared `pickExplore` falls back to seeded random). The explore pool uses the serving definition
  (unseen, never listened, fewest distinct users shown in the 30 days before the UTC day, newest, ≤ 20, then minus
  tracks found by other sources). `Hybrid (random explore)` (the previous design) stays as a row in the warm and
  cold-start tables, the item cold-start table is repeated on the VALIDATION split (same construction one week
  earlier) for both variants, and the report probes at runtime whether the installed shared rerank honours
  `exploreScore`.
- The "shows / does not show" section ends with an interpretation sentence generated from the actual CIs (warm-start
  content contribution, item cold-start content vs CF).
- Writes `recommendation-ai/reports/eval-<UTC>[-label].json|.md`. `--embedder auto` uses e5 when loadable and
  otherwise falls back to a hashed bag-of-words embedder; such reports are automatically labelled `hash-fallback`.

## Feature semantics (shared with serving)

There is ONE implementation: `src/features.ts` only computes raw inputs from the in-memory snapshot
(offline CF co-occurrence counts with the serving SQL formula, leave-pair-out statistics, survey cold-start
track selection) and calls `@infosound/recommendation-ai/features` for everything else: `buildFeatures`
(incl. `cfFeature` normalisation by the max raw CF over the user's serving-eligible tracks), `tasteVector`,
`meanVector`, `interactionWeight`, `isPositive`, `topGenres`, `cosine`. Scoring uses the shared `parseModel` +
`scoreFeatures`, and the evaluator's re-rank is the shared `rerank` (seeded with `dailySeed`). The LR trainer
itself (gradient descent) stays here; `train` writes a `recommendation_models` row
`{version, feature_names = FEATURE_ORDER, weights (raw-feature space), bias}` that `parseModel` has already
accepted. That entry point never loads `@infosound/database`, so `evaluate` stays DB-free. Build order:
`@infosound/recommendation-ai` must be built (dist/features.js) before this package.

## Committed reports

- `eval-20261121T161232Z.{json,md}`: the integrator's e5 run in the demo stack (round 1 protocol, before the
  cold-start sections existed). It must be regenerated with e5 to get the cold-start tables.
- `eval-<UTC>-hash-fallback.{json,md}`: host sanity run with the **hash bag-of-words fallback embedder**
  (global cutoff, 10 seeds, warm + item/user cold start). Its content_sim / Content-only / ILD / permutation numbers
  are not e5 numbers; regenerate with e5 (`recommendation-ai/demo/seed-demo.ps1 -Steps evaluate`, or
  `node dist/cli.js evaluate --embedder e5` in the tools container) before quoting results.

## Tests

`pnpm --filter @infosound/recommendation-batch test` (pure parts: RNG, Zipf, Dirichlet/persona sampling, world
invariants, LR gradient + toy separable set, metrics on hand-computed examples, guard, features/LPO, split,
re-rank, global cutoff / discovery split, holdout split, follow/playlist leakage checks, model row accepted by the
shared parseModel).
