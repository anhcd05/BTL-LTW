// Reason selection: the candidate source with the highest score contribution explains the item.
import type { FeatureName, Features } from './feature-set';
import type { RankerModel } from './scoring';

export type CandidateSource = 'CF' | 'CONTENT' | 'FOLLOW' | 'TRENDING' | 'EXPLORE';
export type RecoReason = 'LISTENED' | 'SIMILAR' | 'FOLLOW' | 'TRENDING' | 'EXPLORE';

/** Priority order, also used to break contribution ties. */
export const SOURCE_PRIORITY: readonly CandidateSource[] = ['CF', 'CONTENT', 'FOLLOW', 'TRENDING'];

export const SOURCE_FEATURE: Record<Exclude<CandidateSource, 'EXPLORE'>, FeatureName> = {
  CF: 'cf_score',
  CONTENT: 'content_sim',
  FOLLOW: 'follows_artist',
  TRENDING: 'popularity',
};

export const SOURCE_REASON: Record<CandidateSource, RecoReason> = {
  CF: 'LISTENED',
  CONTENT: 'SIMILAR',
  FOLLOW: 'FOLLOW',
  TRENDING: 'TRENDING',
  EXPLORE: 'EXPLORE',
};

export type SourceContributions = Partial<Record<CandidateSource, number>>;

/** w_f · x_f of the feature that represents each source the candidate actually came from. */
export function sourceContributions(
  sources: readonly CandidateSource[],
  features: Features,
  model: RankerModel,
): SourceContributions {
  const out: SourceContributions = {};
  for (const source of sources) {
    if (source === 'EXPLORE') continue;
    const feature = SOURCE_FEATURE[source];
    out[source] = model.weights[feature] * features[feature];
  }
  return out;
}

export type ReasonInput = {
  sources: readonly CandidateSource[];
  contributions: SourceContributions;
  explore?: boolean;
  cfSeedTitle?: string | null;
  similarSeedTitle?: string | null;
};

export function pickReason(input: ReasonInput): { reason: RecoReason; seedTitle?: string } {
  if (input.explore) return { reason: 'EXPLORE' };
  let best: CandidateSource | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const source of SOURCE_PRIORITY) {
    if (!input.sources.includes(source)) continue;
    const value = input.contributions[source] ?? 0;
    if (value > bestValue) {
      best = source;
      bestValue = value;
    }
  }
  if (!best) return { reason: input.sources.includes('EXPLORE') ? 'EXPLORE' : 'TRENDING' };
  const reason = SOURCE_REASON[best];
  const seedTitle =
    best === 'CF' ? input.cfSeedTitle : best === 'CONTENT' ? input.similarSeedTitle : null;
  return seedTitle ? { reason, seedTitle } : { reason };
}
