import { type Features, type ModelRow, type RankerModel, parseModel, scoreFeatures } from '@infosound/recommendation-ai/features';
import { FEATURE_ORDER, type FeatureContext, buildContext, features, toArray } from './features';
import { type LrModel, type LrOptions, trainLogistic } from './lr';
import { auc, logLoss } from './metrics';
import { type Rng, createRng, shuffle } from './rng';
import { DAY_MS, type PairStat, type Snapshot, isLabelPositive, isObservedNegative, pairIndex, pairKey, pairTime, withoutPairs } from './snapshot';

export const NEGATIVES_PER_POSITIVE = 4;
/** The LR's internal diagnostic holdout: the last 7 days of the snapshot it is trained on. */
export const HOLDOUT_DAYS = 7;

export type HoldoutSplit = {
  /** Snapshot without every pair whose latest stored interaction is at/after the cutoff. */
  train: Snapshot;
  cutoff: number;
  positives: Map<string, string[]>;
  observedNegatives: Map<string, string[]>;
  removed: Map<string, Set<string>>;
};

/**
 * ONE global cutoff on AGGREGATE data (what `train` sees in the DB: likes.created_at,
 * track_listens.last_listened_at, track_engagement.last_event_at, playlists.updated_at). Pairs whose
 * latest interaction is >= cutoff are held out and removed (with their play counts / skips) from the
 * training snapshot. The aggregate tables keep no first-event time, so this is the closest
 * DB-computable split; the evaluator uses the exact event-level split instead (world.ts).
 */
export function holdoutSplit(s: Snapshot, cutoff: number): HoldoutSplit {
  const removedKeys = new Set<string>();
  const positives = new Map<string, string[]>();
  const observedNegatives = new Map<string, string[]>();
  const removed = new Map<string, Set<string>>();
  for (const [user, m] of pairIndex(s)) {
    for (const [trackId, p] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (pairTime(p) < cutoff) continue;
      removedKeys.add(pairKey(user, trackId));
      if (!removed.has(user)) removed.set(user, new Set());
      removed.get(user)!.add(trackId);
      const bucket = isLabelPositive(p) ? positives : isObservedNegative(p) ? observedNegatives : null;
      if (bucket) bucket.set(user, [...(bucket.get(user) ?? []), trackId]);
    }
  }
  return { train: withoutPairs(s, removedKeys), cutoff, positives, observedNegatives, removed };
}

export type Example = { user: string; trackId: string; x: number[]; y: number; kind: 'positive' | 'observed-negative' | 'random-negative' };

/** Unseen public tracks for random negatives (no stored pair, not own, not in `alsoExclude`). */
function unseenPool(ctx: FeatureContext, user: string, alsoExclude: ReadonlySet<string> = new Set()): number[] {
  const m = ctx.pairs.get(user);
  const out: number[] = [];
  ctx.tracks.forEach((t, i) => {
    if (t.authorId === user || m?.has(t.id) || alsoExclude.has(t.id)) return;
    out.push(i);
  });
  return out;
}

/**
 * Training examples on a context: positives, observed negatives (skipped / impressed-not-clicked
 * without positive), then random unseen public tracks up to 4 negatives per positive. Features are
 * computed leave-pair-out, so a label never sees its own pair.
 */
export function trainingExamples(ctx: FeatureContext, users: readonly string[], rng: Rng): Example[] {
  const out: Example[] = [];
  for (const user of users) {
    const m = ctx.pairs.get(user);
    if (!m) continue;
    const pos: string[] = [];
    const neg: string[] = [];
    for (const [trackId, p] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!ctx.trackIdx.has(trackId)) continue;
      if (isLabelPositive(p)) pos.push(trackId);
      else if (isObservedNegative(p)) neg.push(trackId);
    }
    if (!pos.length) continue;
    const want = NEGATIVES_PER_POSITIVE * pos.length;
    const observed = shuffle(rng, neg).slice(0, want);
    const random = shuffle(rng, unseenPool(ctx, user)).slice(0, Math.max(0, want - observed.length));
    for (const t of pos) out.push(example(ctx, user, t, 1, 'positive', true));
    for (const t of observed) out.push(example(ctx, user, t, 0, 'observed-negative', true));
    for (const i of random) out.push(example(ctx, user, ctx.tracks[i].id, 0, 'random-negative', true));
  }
  return out;
}

/** Holdout examples on the pre-cutoff context: held-out positives + held-out observed negatives + random unseen (4:1). */
export function holdoutExamples(ctx: FeatureContext, split: HoldoutSplit, rng: Rng): Example[] {
  const out: Example[] = [];
  for (const [user, positives] of [...split.positives.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const pos = positives.filter((t) => ctx.trackIdx.has(t));
    const want = NEGATIVES_PER_POSITIVE * pos.length;
    const observed = shuffle(rng, (split.observedNegatives.get(user) ?? []).filter((t) => ctx.trackIdx.has(t))).slice(0, want);
    const random = shuffle(rng, unseenPool(ctx, user, split.removed.get(user))).slice(0, Math.max(0, want - observed.length));
    for (const t of pos) out.push(example(ctx, user, t, 1, 'positive', false));
    for (const t of observed) out.push(example(ctx, user, t, 0, 'observed-negative', false));
    for (const i of random) out.push(example(ctx, user, ctx.tracks[i].id, 0, 'random-negative', false));
  }
  return out;
}

function example(ctx: FeatureContext, user: string, trackId: string, y: number, kind: Example['kind'], lpo: boolean): Example {
  const j = ctx.trackIdx.get(trackId)!;
  return { user, trackId, y, kind, x: toArray(features(ctx, user, j, { leavePairOut: lpo })) };
}

type Fit = { auc: number; logloss: number; n: number; positives: number };
export type TrainedModel = LrModel & {
  featureNames: string[];
  /** Exactly the recommendation_models row shape serving reads (validated with the shared parseModel). */
  row: ModelRow;
  /** parseModel(row): the object serving scores with (scoreFeatures). */
  ranker: RankerModel;
  /** Weights on the standardised scale (w_raw · σ): comparable magnitudes. */
  standardisedWeights: number[];
  metrics: {
    /** Fit of the diagnostic model (trained before the holdout cutoff) on its own training examples. */
    train: Fit;
    /** Same diagnostic model on the last-7-days holdout (global cutoff, aggregate approximation). */
    holdout: Fit;
    holdoutCutoff: string;
    /** The stored model is refit on ALL examples of the snapshot (leave-pair-out). */
    refit: Fit;
    options: Required<LrOptions> & { negativesPerPositive: number; holdoutDays: number; seed: number };
    standardisation: { mean: number[]; std: number[]; folded: true };
    droppedFeatures: string[];
  };
};

const DEFAULT_LR: Required<LrOptions> = { l2: 1e-3, learningRate: 0.5, epochs: 3000, tolerance: 1e-9 };

function asFeatures(x: readonly number[]): Features {
  return Object.fromEntries(FEATURE_ORDER.map((name, k) => [name, x[k]])) as Features;
}

/** Drop features by zeroing their column (its weight then stays 0: no variance, only L2 pull). */
function mask(x: number[], dropped: ReadonlySet<number>): number[] {
  return dropped.size ? x.map((v, k) => (dropped.has(k) ? 0 : v)) : x;
}

function fit(rows: Example[], dropped: ReadonlySet<number>, lrOptions: Required<LrOptions>, version: string) {
  if (!rows.some((e) => e.y === 1) || !rows.some((e) => e.y === 0))
    throw new Error('Not enough training data: need both positive and negative examples');
  const lr = trainLogistic(rows.map((e) => mask(e.x, dropped)), rows.map((e) => e.y), lrOptions);
  const row: ModelRow = { version, featureNames: [...FEATURE_ORDER], weights: lr.weights, bias: lr.bias };
  const ranker = parseModel(row);
  if (!ranker) throw new Error('Trained weights are not a valid serving model (parseModel rejected them)');
  return { lr, row, ranker };
}

function score(ranker: RankerModel, rows: Example[], dropped: ReadonlySet<number>): Fit {
  const p = rows.map((e) => scoreFeatures(ranker, asFeatures(mask(e.x, dropped))));
  const labels = rows.map((e) => e.y);
  return { auc: auc(p, labels), logloss: logLoss(p, labels), n: rows.length, positives: labels.filter((v) => v === 1).length };
}

/**
 * Trains the ranker on a snapshot. Diagnostics: a model fit before a global holdout cutoff
 * (snapshot.now − 7 days) is scored on the held-out week. The returned/stored model is then refit on
 * every labelled pair of the snapshot (leave-pair-out features), which is what serving uses.
 */
export function trainFromSnapshot(
  snapshot: Snapshot,
  opts: { seed: number; version?: string; lr?: LrOptions; drop?: readonly string[] } = { seed: 1 },
): { model: TrainedModel; ctx: FeatureContext } {
  const lrOptions = { ...DEFAULT_LR, ...(opts.lr ?? {}) };
  const version = opts.version ?? 'lr-unsaved';
  const rng = createRng(opts.seed).fork('dataset');
  const dropped = new Set((opts.drop ?? []).map((name) => FEATURE_ORDER.indexOf(name as never)).filter((k) => k >= 0));

  const split = holdoutSplit(snapshot, snapshot.now.getTime() - HOLDOUT_DAYS * DAY_MS);
  const preCtx = buildContext(split.train);
  const preRows = trainingExamples(preCtx, snapshot.users, rng.fork('train'));
  const diagnostic = fit(preRows, dropped, lrOptions, version);
  const holdoutRows = holdoutExamples(preCtx, split, rng.fork('holdout'));

  const ctx = buildContext(snapshot);
  const allRows = trainingExamples(ctx, snapshot.users, rng.fork('refit'));
  const final = fit(allRows, dropped, lrOptions, version);
  const model: TrainedModel = {
    ...final.lr,
    featureNames: [...FEATURE_ORDER],
    row: final.row,
    ranker: final.ranker,
    standardisedWeights: final.lr.weights.map((w, k) => w * final.lr.std[k]),
    metrics: {
      train: score(diagnostic.ranker, preRows, dropped),
      holdout: holdoutRows.length ? score(diagnostic.ranker, holdoutRows, dropped) : { auc: NaN, logloss: NaN, n: 0, positives: 0 },
      holdoutCutoff: new Date(split.cutoff).toISOString(),
      refit: score(final.ranker, allRows, dropped),
      options: { ...lrOptions, negativesPerPositive: NEGATIVES_PER_POSITIVE, holdoutDays: HOLDOUT_DAYS, seed: opts.seed },
      standardisation: { mean: final.lr.mean, std: final.lr.std, folded: true },
      droppedFeatures: [...(opts.drop ?? [])],
    },
  };
  return { model, ctx };
}

export type { PairStat };
