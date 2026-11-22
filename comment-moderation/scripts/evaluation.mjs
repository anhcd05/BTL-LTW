/** Offline metrics. Errors are counted as review by fail-closed policy, not omitted. */
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const percentile = (values, fraction) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;

export function summarizeEvaluation(fixtures, observations, metadata = {}) {
  const selectedIds = new Set(fixtures.map(item => item.id));
  if (selectedIds.size !== fixtures.length) throw new Error('DUPLICATE_FIXTURE_ID');
  const byId = new Map();
  for (const row of observations) {
    if (!selectedIds.has(row.id) || byId.has(row.id)) throw new Error('INVALID_OBSERVATION_ID');
    if (!(typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs) && row.latencyMs >= 0)) throw new Error('INVALID_LATENCY');
    if (!row.errorCode && !['VISIBLE', 'HELD','HIDDEN'].includes(row.status)) throw new Error('INVALID_OUTCOME');
    byId.set(row.id, row);
  }
  const matrix = { expected_allow: { actual_allow: 0, actual_review: 0 }, expected_review: { actual_allow: 0, actual_review: 0 } };
  const semanticMatrix = structuredClone(matrix);
  const labels = {};
  const errorCodes = {};
  const latencies = [];
  let successful = 0, errors = 0, skipped = 0, errorReview = 0;
  for (const fixture of fixtures) {
    const row = byId.get(fixture.id);
    if (!row) { skipped++; continue; }
    const expected = `expected_${fixture.expectedAction}`;
    if (!matrix[expected]) throw new Error('INVALID_EXPECTED_ACTION');
    const actual = row.errorCode || row.status !== 'VISIBLE' ? 'actual_review' : 'actual_allow';
    matrix[expected][actual]++;
    latencies.push(row.latencyMs);
    if (row.errorCode) {
      errors++;
      errorReview++;
      errorCodes[row.errorCode] = (errorCodes[row.errorCode] ?? 0) + 1;
      continue;
    }
    successful++;
    semanticMatrix[expected][actual]++;
    for (const label of new Set([...(fixture.expectedLabels ?? []), ...(row.result?.labels ?? [])])) {
      const item = labels[label] ??= { true_positive: 0, false_positive: 0, false_negative: 0 };
      const wanted = fixture.expectedLabels.includes(label), predicted = row.result?.labels?.includes(label) ?? false;
      if (wanted && predicted) item.true_positive++;
      else if (predicted) item.false_positive++;
      else if (wanted) item.false_negative++;
    }
  }
  latencies.sort((a, b) => a - b);
  function scores(value) {
    const tp = value.expected_review.actual_review, fp = value.expected_allow.actual_review;
    const fn = value.expected_review.actual_allow, tn = value.expected_allow.actual_allow;
    return {
      review_precision: ratio(tp, tp + fp), review_recall: ratio(tp, tp + fn), review_f1: ratio(2 * tp, 2 * tp + fp + fn),
      false_hold_rate: ratio(fp, tn + fp), false_allow_rate: ratio(fn, tp + fn),
      denominators: { predicted_review: tp + fp, expected_review: tp + fn, expected_allow: tn + fp },
    };
  }
  const attempted = successful + errors;
  return {
    metadata, totalSelected: fixtures.length, attempted, successful, errors, skipped,
    coverage: ratio(successful, fixtures.length), attemptedCoverage: ratio(attempted, fixtures.length),
    errorRate: ratio(errors, attempted), refusalRate: ratio(errorCodes.PROVIDER_REFUSAL ?? 0, attempted), errorCodes,
    operational: { confusionMatrix: matrix, ...scores(matrix), technicalErrorsRoutedToReview: errorReview },
    successfulClassificationsOnly: { confusionMatrix: semanticMatrix, ...scores(semanticMatrix), denominator: successful },
    labels, latency: { samples: latencies.length, p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95) },
    interpretation: 'Operational scores count every attempted technical failure as review; unattempted fixtures remain skipped. Semantic scores use only validated successful classifications. Null means no denominator, not perfect performance.',
  };
}

/** Caller owns the real provider and its shared atomic budget. No retries or sleeps here. */
export async function evaluateFixtures(fixtures, classify, { metadata = {}, stopOnError = true } = {}) {
  const observations = [];
  for (const fixture of fixtures) {
    const started = performance.now();
    try {
      const outcome = await classify({ comment: fixture.comment, signals: fixture.signals ?? { repeated: false } });
      observations.push({ id: fixture.id, result: outcome.result, status: outcome.status, latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      observations.push({ id: fixture.id, errorCode: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'INTERNAL_ERROR', latencyMs: Math.round(performance.now() - started) });
      if (stopOnError) break;
    }
  }
  return { observations, summary: summarizeEvaluation(fixtures, observations, metadata) };
}
