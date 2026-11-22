// Feature definitions shared by serving (this package) and training (recommendation-ai/batch).
// The order is part of the contract (DESIGN.md §2); weights are matched by name.
import { clamp01 } from './math';

export const FEATURE_ORDER = [
  'cf_score',
  'content_sim',
  'follows_artist',
  'survey_match',
  'genre_overlap',
  'popularity',
  'recency',
  'skip_rate',
] as const;
export type FeatureName = (typeof FEATURE_ORDER)[number];
export type Features = Record<FeatureName, number>;

const DAY_MS = 86_400_000;
export const RECENCY_DAYS = 30;
export const TOP_GENRES = 3;

/** CF score normalised by the maximum over the user's candidates. */
export function cfFeature(score: number, maxScore: number): number {
  return maxScore > 0 && score > 0 ? clamp01(score / maxScore) : 0;
}

/** Cosine mapped from [-1, 1] to [0, 1]; 0 when the candidate or user has no embedding. */
export function contentFeature(cos: number | null): number {
  return cos === null || !Number.isFinite(cos) ? 0 : clamp01((cos + 1) / 2);
}

export function popularityFeature(playCount: number, maxPlayCount: number): number {
  if (!(maxPlayCount > 0) || !(playCount > 0)) return 0;
  return clamp01(Math.log1p(playCount) / Math.log1p(maxPlayCount));
}

export function recencyFeature(publishedAt: Date | null, now: Date): number {
  if (!publishedAt) return 0;
  const days = Math.max(0, (now.getTime() - publishedAt.getTime()) / DAY_MS);
  return clamp01(Math.exp(-days / RECENCY_DAYS));
}

/** Laplace-smoothed skip rate over all users: (skips + 1) / (starts + 2). */
export function skipRateFeature(skips: number, starts: number): number {
  const s = Math.max(0, skips);
  const n = Math.max(s, starts);
  return clamp01((s + 1) / (n + 2));
}

/** |genres(j) ∩ topGenres(u)| / |genres(j)|. */
export function genreOverlapFeature(trackGenres: readonly string[], topGenres: ReadonlySet<string>): number {
  const unique = new Set(trackGenres);
  if (unique.size === 0 || topGenres.size === 0) return 0;
  let hits = 0;
  for (const genre of unique) if (topGenres.has(genre)) hits++;
  return hits / unique.size;
}

/** Top-k genres by accumulated (positive) weight; ties broken by genre id for determinism. */
export function topGenres(weighted: ReadonlyMap<string, number>, k = TOP_GENRES): Set<string> {
  return new Set(
    [...weighted.entries()]
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, k)
      .map(([genre]) => genre),
  );
}

export type FeatureInput = {
  cfScore: number;
  maxCfScore: number;
  contentCosine: number | null;
  followsArtist: boolean;
  surveyMatch: boolean;
  trackGenres: readonly string[];
  topGenres: ReadonlySet<string>;
  playCount: number;
  maxPlayCount: number;
  publishedAt: Date | null;
  skips: number;
  starts: number;
  now: Date;
};

export function buildFeatures(input: FeatureInput): Features {
  return {
    cf_score: cfFeature(input.cfScore, input.maxCfScore),
    content_sim: contentFeature(input.contentCosine),
    follows_artist: input.followsArtist ? 1 : 0,
    survey_match: input.surveyMatch ? 1 : 0,
    genre_overlap: genreOverlapFeature(input.trackGenres, input.topGenres),
    popularity: popularityFeature(input.playCount, input.maxPlayCount),
    recency: recencyFeature(input.publishedAt, input.now),
    skip_rate: skipRateFeature(input.skips, input.starts),
  };
}

export function featureVector(features: Features): number[] {
  return FEATURE_ORDER.map((name) => features[name]);
}
