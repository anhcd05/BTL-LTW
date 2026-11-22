/** Ranking / classification metrics. All pure; unit-tested on hand-computed examples. */

export function precisionAtK(recommended: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const top = recommended.slice(0, k);
  return top.filter((id) => relevant.has(id)).length / k;
}

export function recallAtK(recommended: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (!relevant.size) return 0;
  return recommended.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}

/** Binary-relevance NDCG@k with log2(rank+1) discount. */
export function ndcgAtK(recommended: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  let dcg = 0;
  recommended.slice(0, k).forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

/** Share of the catalogue appearing in at least one user's top-k. */
export function coverage(lists: readonly (readonly string[])[], catalogueSize: number, k: number): number {
  const seen = new Set<string>();
  for (const list of lists) for (const id of list.slice(0, k)) seen.add(id);
  return catalogueSize ? seen.size / catalogueSize : 0;
}

/** Gini coefficient of a non-negative distribution (0 = equal, → 1 = concentrated). */
export function gini(values: readonly number[]): number {
  const n = values.length;
  if (!n) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let weighted = 0;
  sorted.forEach((x, i) => {
    weighted += (i + 1) * x;
  });
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/** Gini of exposure across the whole catalogue (items never recommended count as 0). */
export function exposureGini(lists: readonly (readonly string[])[], catalogue: readonly string[], k: number): number {
  const counts = new Map(catalogue.map((id) => [id, 0]));
  for (const list of lists) for (const id of list.slice(0, k)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return gini([...counts.values()]);
}

/** Intra-list diversity: mean pairwise (1 − cosine) of the list's embeddings; pairs without embeddings skipped. */
export function intraListDiversity(list: readonly string[], emb: (id: string) => ArrayLike<number> | undefined): number {
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < list.length; a += 1)
    for (let b = a + 1; b < list.length; b += 1) {
      const x = emb(list[a]);
      const y = emb(list[b]);
      if (!x || !y) continue;
      let d = 0;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < x.length; i += 1) {
        d += x[i] * y[i];
        nx += x[i] * x[i];
        ny += y[i] * y[i];
      }
      sum += 1 - (nx && ny ? d / Math.sqrt(nx * ny) : 0);
      pairs += 1;
    }
  return pairs ? sum / pairs : 0;
}

/** ROC AUC via the rank statistic (ties get half credit). */
export function auc(scores: readonly number[], labels: readonly number[]): number {
  const idx = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let pos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].s === idx[i].s) j += 1;
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) if (idx[k].y === 1) {
      rankSum += avgRank;
      pos += 1;
    }
    i = j + 1;
  }
  const neg = idx.length - pos;
  if (!pos || !neg) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function logLoss(probabilities: readonly number[], labels: readonly number[]): number {
  if (!probabilities.length) return NaN;
  let s = 0;
  probabilities.forEach((p, i) => {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
    s += labels[i] === 1 ? -Math.log(q) : -Math.log(1 - q);
  });
  return s / probabilities.length;
}

export function meanStd(values: readonly number[]): { mean: number; std: number } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { mean: NaN, std: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, std: Math.sqrt(variance) };
}
