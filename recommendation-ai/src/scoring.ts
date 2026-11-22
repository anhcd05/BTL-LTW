// Tier 2: logistic-regression ranker. Weights come from the active recommendation_models row.
import { FEATURE_ORDER, type FeatureName, type Features } from './feature-set';
import { sigmoid } from './math';

export type RankerModel = {
  version: string;
  bias: number;
  /** Weight per feature, aligned with FEATURE_ORDER. */
  weights: Record<FeatureName, number>;
};

export type ModelRow = {
  version: string;
  featureNames: readonly string[];
  weights: readonly number[];
  bias: number;
};

/**
 * Validates a stored model row. Weights are matched by feature name so a reordered row still works;
 * a row missing any serving feature, with duplicates or non-finite values is rejected (caller falls back).
 */
export function parseModel(row: ModelRow | null | undefined): RankerModel | null {
  if (!row || typeof row.version !== 'string' || row.version.length === 0) return null;
  if (!Array.isArray(row.featureNames) || !Array.isArray(row.weights)) return null;
  if (row.featureNames.length !== row.weights.length || !Number.isFinite(row.bias)) return null;
  const byName = new Map<string, number>();
  for (let i = 0; i < row.featureNames.length; i++) {
    const name = row.featureNames[i]!;
    const weight = Number(row.weights[i]);
    if (byName.has(name) || !Number.isFinite(weight)) return null;
    byName.set(name, weight);
  }
  const weights = {} as Record<FeatureName, number>;
  for (const name of FEATURE_ORDER) {
    const weight = byName.get(name);
    if (weight === undefined) return null;
    weights[name] = weight;
  }
  return { version: row.version, bias: row.bias, weights };
}

export function linearScore(model: RankerModel, features: Features): number {
  let z = model.bias;
  for (const name of FEATURE_ORDER) z += model.weights[name] * (features[name] ?? 0);
  return z;
}

/** P(positive | user, track) = σ(b + w·x). */
export function scoreFeatures(model: RankerModel, features: Features): number {
  return sigmoid(linearScore(model, features));
}

export function modelWeightsInOrder(model: RankerModel): number[] {
  return FEATURE_ORDER.map((name) => model.weights[name]);
}
