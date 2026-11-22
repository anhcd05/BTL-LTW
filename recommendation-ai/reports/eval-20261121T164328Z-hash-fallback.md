# InfoSound Reco — offline evaluation (2026-11-21T16:43:28.946Z) [hash-fallback]

> **Honesty statement.** Results are on synthetic data and prove only that the pipeline works and each tier contributes under the simulation assumptions. CTR is simulated. Never claim real-user effectiveness.

- Embeddings: **hash-bow FALLBACK requested with --embedder hash — content/ILD numbers are NOT e5 numbers**
- Seeds: 42, 43, 44, 45, 46, 47, 48, 49, 50, 51 (n = 10; μ ± σ over seeds, σ = sample sd)
- Cutoffs: validation from 2026-11-04T00:00:00.000Z, test from 2026-11-11T00:00:00.000Z to 2026-11-21T00:00:00.000Z
- Test users with ≥ 1 discovery: 34.7 ± 4.6 of 60 listeners (discoveries 56.5 ± 6.3; rules fallback for 0.0 ± 0.0 users); validation users 31.3 ± 4.4
- Protocol: Each seed regenerates the synthetic world in memory (same generator as `seed`); no database is touched. ONE global cutoff: everything the models see (plays, likes, play_count, skip stats, CF co-occurrence, trending, taste, follows, playlists, survey, catalogue) is strictly before T_c = now − 10 d. Test = discovery: (user, track) pairs whose FIRST play is at/after T_c, positive within [T_c, now) (like OR completes >= 1 OR qualified plays >= 2), on tracks already published at T_c. Users with no such pair are excluded. Validation = the same construction one week earlier (train < T_c − 7 d, truth in [T_c − 7 d, T_c)); ablations and the permutation control run ONLY on validation; the test is used once, for the main table. All methods rank only tracks the user has no pre-cutoff pair with (not own). The hybrid applies the shared re-rank (<= 1 per artist, slot-5 EXPLORE, SKIPPED rule) and falls back to the rules for users with < 3 interactions, like serving. The LR is trained with the same code as `train` (labels with leave-pair-out features; diagnostic AUC on the snapshot's own last 7 days; stored model refit on all pairs). Recall@5 now differs from P@5 because the number of discoveries per user varies (it was identical under the old fixed 5-per-user split). SimCTR = mean simulated click probability sigmoid((U − 0.55)/0.08) of recommended items under the latent utility U at T_c.

## Test: methods (k = 5)

| Method | P@5 | Recall@5 | NDCG@5 | Coverage@5 | Gini(exposure) | ILD | SimCTR | StuffedExposure |
|---|---|---|---|---|---|---|---|---|
| Random | 0.009 ± 0.010 | 0.031 ± 0.039 | 0.018 ± 0.023 | 0.626 ± 0.047 | 0.523 ± 0.028 | 0.828 ± 0.006 | 0.076 ± 0.012 | 1.7 ± 1.2 |
| Popularity | 0.008 ± 0.005 | 0.020 ± 0.015 | 0.016 ± 0.013 | 0.067 ± 0.008 | 0.959 ± 0.003 | 0.807 ± 0.027 | 0.073 ± 0.008 | 0.0 ± 0.0 |
| Rules (current SQL) | 0.083 ± 0.022 | 0.280 ± 0.057 | 0.201 ± 0.038 | 0.522 ± 0.070 | 0.639 ± 0.059 | 0.807 ± 0.006 | 0.387 ± 0.039 | 1.4 ± 2.0 |
| CF-only | 0.095 ± 0.023 | 0.310 ± 0.072 | 0.211 ± 0.047 | 0.564 ± 0.031 | 0.582 ± 0.020 | 0.803 ± 0.011 | 0.454 ± 0.033 | 0.7 ± 1.3 |
| Content-only | 0.032 ± 0.013 | 0.105 ± 0.050 | 0.075 ± 0.036 | 0.395 ± 0.020 | 0.767 ± 0.021 | 0.703 ± 0.015 | 0.159 ± 0.013 | 0.2 ± 0.4 |
| Hybrid (LR + re-rank) | 0.095 ± 0.023 | 0.319 ± 0.055 | 0.248 ± 0.048 | 0.572 ± 0.049 | 0.586 ± 0.030 | 0.820 ± 0.008 | 0.409 ± 0.032 | 1.2 ± 1.5 |
| Hybrid (random explore) | 0.095 ± 0.021 | 0.319 ± 0.054 | 0.248 ± 0.046 | 0.567 ± 0.047 | 0.592 ± 0.030 | 0.826 ± 0.009 | 0.406 ± 0.032 | 1.2 ± 1.5 |
| Hybrid w/o explore | 0.104 ± 0.022 | 0.344 ± 0.057 | 0.259 ± 0.048 | 0.580 ± 0.050 | 0.573 ± 0.036 | 0.819 ± 0.010 | 0.465 ± 0.035 | 1.7 ± 1.7 |
| Oracle (latent) | 0.240 ± 0.029 | 0.775 ± 0.081 | 0.651 ± 0.065 | 0.564 ± 0.055 | 0.595 ± 0.039 | 0.813 ± 0.009 | 0.756 ± 0.024 | 2.1 ± 1.4 |

## Test: paired per-seed differences (mean, sd, 95% t-interval)

| Comparison | ΔP@5 | ΔNDCG@5 |
|---|---|---|
| Hybrid (LR + re-rank) − CF-only | -0.000 (sd 0.029; 95% CI -0.021 … 0.020) | +0.037 (sd 0.050; 95% CI 0.001 … 0.073) |
| Hybrid (LR + re-rank) − Rules (current SQL) | +0.011 (sd 0.030; 95% CI -0.010 … 0.033) | +0.047 (sd 0.063; 95% CI 0.002 … 0.092) |
| Hybrid (LR + re-rank) − Hybrid w/o explore | -0.009 (sd 0.007; 95% CI -0.014 … -0.004) | -0.011 (sd 0.009; 95% CI -0.018 … -0.005) |
| Hybrid (LR + re-rank) − Hybrid (random explore) | +0.000 (sd 0.003; 95% CI -0.002 … 0.002) | +0.000 (sd 0.006; 95% CI -0.004 … 0.004) |

## Learned ranker (test-split model)

- Diagnostic AUC: fit 0.909 ± 0.015, last-7-days holdout 0.926 ± 0.015; holdout logloss 0.268 ± 0.021

| Feature | raw weight | standardised weight (w·σ, comparable) |
|---|---|---|
| cf_score | 4.177 ± 0.346 | 1.328 ± 0.111 |
| content_sim | 3.390 ± 1.271 | 0.149 ± 0.055 |
| follows_artist | 2.082 ± 0.311 | 0.671 ± 0.121 |
| survey_match | 0.698 ± 0.155 | 0.238 ± 0.060 |
| genre_overlap | 1.804 ± 0.213 | 0.749 ± 0.088 |
| popularity | 0.630 ± 0.416 | 0.141 ± 0.094 |
| recency | -0.746 ± 0.367 | -0.173 ± 0.087 |
| skip_rate | 0.631 ± 0.631 | 0.112 ± 0.116 |

## Validation only: ablations (drop one feature, retrain, re-rank without explore)

| Dropped | P@5 | ΔP@5 vs full model | NDCG@5 | holdout AUC |
|---|---|---|---|---|
| -cf_score | 0.097 ± 0.024 | -0.018 (sd 0.015; 95% CI -0.029 … -0.007) | 0.257 ± 0.068 | 0.908 ± 0.016 |
| -content_sim | 0.115 ± 0.032 | +0.000 (sd 0.004; 95% CI -0.003 … 0.003) | 0.285 ± 0.083 | 0.924 ± 0.015 |
| -follows_artist | 0.102 ± 0.027 | -0.014 (sd 0.012; 95% CI -0.022 … -0.005) | 0.230 ± 0.069 | 0.894 ± 0.021 |
| -survey_match | 0.114 ± 0.028 | -0.001 (sd 0.004; 95% CI -0.004 … 0.002) | 0.286 ± 0.077 | 0.915 ± 0.016 |
| -genre_overlap | 0.108 ± 0.029 | -0.008 (sd 0.014; 95% CI -0.017 … 0.002) | 0.273 ± 0.083 | 0.877 ± 0.020 |
| -popularity | 0.111 ± 0.027 | -0.004 (sd 0.005; 95% CI -0.008 … -0.000) | 0.282 ± 0.083 | 0.921 ± 0.016 |
| -recency | 0.116 ± 0.029 | +0.001 (sd 0.011; 95% CI -0.007 … 0.008) | 0.298 ± 0.082 | 0.927 ± 0.014 |
| -skip_rate | 0.116 ± 0.028 | +0.001 (sd 0.004; 95% CI -0.002 … 0.004) | 0.292 ± 0.069 | 0.921 ± 0.016 |

## Validation only: permutation control (embeddings shuffled across tracks)

| | P@5 real embeddings | P@5 shuffled | drop |
|---|---|---|---|
| Content-only | 0.026 ± 0.019 | 0.010 ± 0.006 | +0.017 (sd 0.017; 95% CI 0.005 … 0.029) |
| Hybrid w/o explore | 0.115 ± 0.029 | 0.116 ± 0.031 | -0.001 (sd 0.004; 95% CI -0.003 … 0.002) |

## Item cold start (15 % of tracks released after T_c; truth = discoveries of those new tracks)

- New tracks per seed 30.0 ± 0.0; users with ≥ 1 new-track discovery 36.3 ± 5.0; discoveries 62.3 ± 8.6. Lists are ranked over the whole catalogue (old + new); the EXPLORE slot is unchanged (its pool is newest-first, so it often holds a new track — that is the product rule, not a tweak).

| Method | P@5 | NDCG@5 | Coverage@5 |
|---|---|---|---|
| Random | 0.012 ± 0.008 | 0.021 ± 0.017 | 0.590 ± 0.051 |
| Popularity | 0.000 ± 0.000 | 0.000 ± 0.000 | 0.065 ± 0.007 |
| Rules (current SQL) | 0.104 ± 0.025 | 0.211 ± 0.062 | 0.483 ± 0.051 |
| CF-only | 0.000 ± 0.000 | 0.000 ± 0.000 | 0.499 ± 0.048 |
| Content-only | 0.042 ± 0.015 | 0.085 ± 0.037 | 0.364 ± 0.035 |
| Hybrid (LR + re-rank) | 0.011 ± 0.011 | 0.015 ± 0.016 | 0.522 ± 0.046 |
| Hybrid (random explore) | 0.012 ± 0.010 | 0.016 ± 0.015 | 0.523 ± 0.049 |
| Hybrid w/o explore | 0.016 ± 0.016 | 0.022 ± 0.022 | 0.501 ± 0.043 |

| Paired comparison | ΔP@5 | ΔNDCG@5 |
|---|---|---|
| Content-only − CF-only | +0.042 (sd 0.015; 95% CI 0.031 … 0.053) | +0.085 (sd 0.037; 95% CI 0.058 … 0.111) |
| Hybrid (LR + re-rank) − CF-only | +0.011 (sd 0.011; 95% CI 0.004 … 0.019) | +0.015 (sd 0.016; 95% CI 0.004 … 0.026) |
| Hybrid (LR + re-rank) − Rules (current SQL) | -0.093 (sd 0.025; 95% CI -0.110 … -0.075) | -0.196 (sd 0.064; 95% CI -0.242 … -0.150) |
| Hybrid (LR + re-rank) − Popularity | +0.011 (sd 0.011; 95% CI 0.004 … 0.019) | +0.015 (sd 0.016; 95% CI 0.004 … 0.026) |
| Content-only − Random | +0.030 (sd 0.015; 95% CI 0.019 … 0.041) | +0.063 (sd 0.033; 95% CI 0.040 … 0.087) |
| Hybrid (LR + re-rank) − Hybrid (random explore) | -0.001 (sd 0.002; 95% CI -0.003 … 0.001) | -0.001 (sd 0.002; 95% CI -0.002 … 0.000) |

| Permutation control (cold-start split) | P@5 real | P@5 shuffled | drop |
|---|---|---|---|
| Content-only | 0.042 ± 0.015 | 0.008 ± 0.006 | +0.034 (sd 0.013; 95% CI 0.025 … 0.043) |
| Hybrid | 0.011 ± 0.011 | 0.009 ± 0.008 | +0.002 (sd 0.005; 95% CI -0.001 … 0.006) |

### Design iteration: content-guided EXPLORE (decided AFTER looking at the cold-start TEST results)

- The previous round showed new tracks are buried by the LR. The EXPLORE slot was therefore changed to pick, among the explore-only candidates (unseen, never listened, least-exposed, newest; ≤ 20), the one with the highest exploreScore = content_sim (seeded ties; random when nothing has an embedding). This decision was made after seeing test numbers, so the test rows above are no longer an untouched estimate for it. "Hybrid (random explore)" is the previous design, kept for the comparison.
- Shared rerank honours exploreScore in this build: **yes**.
- Check on the VALIDATION split (same cold-start construction one week earlier; 31.9 ± 4.6 users with new-track discoveries):

| Method (validation, new tracks) | P@5 | NDCG@5 |
|---|---|---|
| Rules (current SQL) | 0.122 ± 0.022 | 0.272 ± 0.062 |
| Hybrid (LR + re-rank) | 0.009 ± 0.015 | 0.014 ± 0.021 |
| Hybrid (random explore) | 0.009 ± 0.015 | 0.013 ± 0.021 |

| Paired comparison (validation, new tracks) | ΔP@5 | ΔNDCG@5 |
|---|---|---|
| Hybrid (LR + re-rank) − Hybrid (random explore) | -0.000 (sd 0.003; 95% CI -0.002 … 0.002) | +0.000 (sd 0.005; 95% CI -0.003 … 0.004) |
| Hybrid (LR + re-rank) − Rules (current SQL) | -0.113 (sd 0.023; 95% CI -0.129 … -0.097) | -0.259 (sd 0.068; 95% CI -0.307 … -0.210) |

## User cold start (history truncated to 2–3 tracks + a noisy survey)

- 10.0 ± 0.0 users per seed, 2.45 ± 0.14 interactions kept on average, 15.1 ± 2.1 discoveries; 5.5 ± 1.4 of them are below the threshold. **The production API falls back to the rules for users with < 3 interactions** (engine.ts MIN_INTERACTIONS = 3), so "Hybrid (production)" equals Rules for those users; "Hybrid forced" ignores the threshold (taste from the few interactions, else the survey cold start).

| Method | P@5 | NDCG@5 |
|---|---|---|
| Rules (survey-based fallback) | 0.020 ± 0.019 | 0.046 ± 0.053 |
| Hybrid (production, rules if < 3) | 0.020 ± 0.021 | 0.043 ± 0.052 |
| Hybrid forced (survey taste) | 0.020 ± 0.021 | 0.046 ± 0.051 |

- Hybrid forced − Rules: ΔP@5 +0.000 (sd 0.025; 95% CI -0.018 … 0.018); ΔNDCG@5 +0.000 (sd 0.068; 95% CI -0.049 … 0.049)

## What this shows

- The pipeline runs end to end on aggregate tables shaped like the real ones, with no leakage across a global time cutoff.
- Whether, under the simulator's assumptions, the hybrid ranks future discoveries better than single signals and the current SQL rules: see the computed verdicts below (a CI that includes 0 means no detectable difference at this sample size).
- Whether content similarity carries information beyond genre in this world: the permutation control (shuffled embeddings) on validation.

Verdicts computed from this run (P@5):

- Hybrid (LR + re-rank) − CF-only: no detectable difference, the 95% CI includes 0 (-0.021 … 0.020).
- Hybrid (LR + re-rank) − Rules (current SQL): no detectable difference, the 95% CI includes 0 (-0.010 … 0.033).
- Hybrid (LR + re-rank) − Hybrid w/o explore: negative, the 95% CI excludes 0 (-0.014 … -0.004).
- Hybrid (LR + re-rank) − Hybrid (random explore): no detectable difference, the 95% CI includes 0 (-0.002 … 0.002).
- Permutation control, Content-only (real − shuffled): positive, the 95% CI excludes 0 (0.005 … 0.029).
- Permutation control, Hybrid (real − shuffled): no detectable difference, the 95% CI includes 0 (-0.003 … 0.002).
- Item cold start, Content-only − CF-only: positive, the 95% CI excludes 0 (0.031 … 0.053).
- Item cold start, Hybrid − CF-only: positive, the 95% CI excludes 0 (0.004 … 0.019).
- Item cold start, permutation (Content-only real − shuffled): positive, the 95% CI excludes 0 (0.025 … 0.043).
- Warm start, Hybrid (content explore) − Hybrid (random explore): no detectable difference, the 95% CI includes 0 (-0.002 … 0.002).
- Item cold start, Hybrid (content explore) − Hybrid (random explore): no detectable difference, the 95% CI includes 0 (-0.003 … 0.001).
- Item cold start, Hybrid (content explore) − Rules: negative, the 95% CI excludes 0 (-0.110 … -0.075).
- Item cold start VALIDATION, Hybrid (content explore) − Hybrid (random explore): no detectable difference, the 95% CI includes 0 (-0.002 … 0.002).
- Item cold start VALIDATION, Hybrid (content explore) − Rules: negative, the 95% CI excludes 0 (-0.129 … -0.097).
- User cold start, Hybrid forced − Rules: no detectable difference, the 95% CI includes 0 (-0.018 … 0.018).

**Interpretation (generated from the numbers above).** In warm start, content adds no measurable signal beyond CF and genre (dropping content_sim: ΔP@5 0.000, CI -0.003 … 0.003; shuffling embeddings changes hybrid P@5 by -0.001, CI -0.003 … 0.002). Its value appears in item cold start: on discoveries of tracks released after the cutoff, Content-only P@5 0.042 vs CF-only 0.000 (Δ 0.042, CI 0.031 … 0.053); permutation drop 0.034, CI 0.025 … 0.043; Hybrid 0.011, Rules 0.104, Popularity 0.000. On new tracks the hybrid is WORSE than the current rules (Δ -0.093, CI -0.110 … -0.075): the rules order genre matches newest-first, which surfaces new releases, while the LR trained on warm data (standardised weights recency -0.17, popularity 0.14, cf_score 1.33) pushes items without plays or co-occurrence down; only the EXPLORE slot and FOLLOW/CONTENT candidates reach them. Content-guided EXPLORE vs random EXPLORE on new tracks: test Δ -0.001 (CI -0.003 … 0.001), validation Δ -0.000 (CI -0.002 … 0.002); this design change was made after the cold-start test analysis. For cold-start users (2–3 interactions + survey), forcing the hybrid instead of the production rules fallback gives Δ P@5 0.000 (CI -0.018 … 0.018), i.e. no detectable difference: keeping the rules fallback below 3 interactions costs nothing measurable here.

## What this does NOT show

- Anything about real users: behaviour is generated from a utility = genre 40 % + artist loyalty 25 % + latent mood 20 % + noise 15 %, so the signals the recommender uses were designed to be predictive.
- Feature importances are NOT discoveries: the LR weights recover the generator's assumptions (follows ≈ latent favourite artists, genre overlap ≈ genre preference, content ≈ mood words written from the latent mood).
- The oracle is a reference, not a ceiling: it ranks by the latent utility, but discoveries are stochastic (softmax choice, random skips, off-taste plays), so a model can match or exceed it on some seeds and it is not an achievable bound.
- CTR is simulated, and a handful of synthetic seeds of 60 users give wide intervals; small differences are not meaningful.

## Dataset sanity (seed 42)

- 200 tracks, 40 artists, 60 listeners, 7313 play events; 509 likes, 982 listen rows, 1721 engagement rows, 188 follows (22% random, 19% of favourites unfollowed), 29 playlists, 32 (noisy) survey answers
- Off-taste plays 14.4% (of which skipped 81.1%); overall skip share 19.4%
- Tracks per artist: min 2, median 4, max 13; Gini of plays per artist 0.454
- Play events per user: min 29, p25 66, median 119, p75 170, p90 194, max 316; Gini 0.292
- Data Gini (play_count over tracks, full window): 0.595 — compare with Gini(exposure) per method
- Keyword-stuffed demo tracks: "Đừng quên giấc mơ" [acoustic] plays=29; "Tiếng đàn và phố" [acoustic] plays=9 — see StuffedExposure

| Genre | tracks | plays |
|---|---|---|
| Pop | 14 | 343 |
| V-pop | 30 | 671 |
| Ballad | 16 | 608 |
| Bolero | 24 | 758 |
| R&B | 19 | 366 |
| Hip-Hop | 17 | 649 |
| Rap | 9 | 533 |
| Rock | 11 | 792 |
| Indie | 14 | 511 |
| EDM | 12 | 490 |
| Lo-fi | 14 | 789 |
| Acoustic | 31 | 397 |
| Jazz | 22 | 203 |
| Folk | 18 | 411 |
| K-pop | 8 | 455 |

_Results are on synthetic data and prove only that the pipeline works and each tier contributes under the simulation assumptions. CTR is simulated. Never claim real-user effectiveness._
