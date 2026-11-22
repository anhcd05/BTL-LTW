import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { lossAndGradient, predict, sigmoid, standardisation, trainLogistic } from '../src/lr';
import { auc } from '../src/metrics';

test('analytic gradient matches finite differences', () => {
  const Z = [
    [0.5, -1.2],
    [1.5, 0.3],
    [-0.7, 0.8],
    [0.1, -0.1],
  ];
  const y = [1, 0, 1, 0];
  const w = [0.3, -0.4];
  const b = 0.1;
  const l2 = 0.05;
  const { gw, gb } = lossAndGradient(Z, y, w, b, l2);
  const h = 1e-6;
  for (let k = 0; k < w.length; k += 1) {
    const plus = w.slice();
    const minus = w.slice();
    plus[k] += h;
    minus[k] -= h;
    const num = (lossAndGradient(Z, y, plus, b, l2).loss - lossAndGradient(Z, y, minus, b, l2).loss) / (2 * h);
    assert.ok(Math.abs(num - gw[k]) < 1e-6, `dw${k}: ${num} vs ${gw[k]}`);
  }
  const numB = (lossAndGradient(Z, y, w, b + h, l2).loss - lossAndGradient(Z, y, w, b - h, l2).loss) / (2 * h);
  assert.ok(Math.abs(numB - gb) < 1e-6);
});

test('separable toy set: perfect ranking, correct sign, folded weights act on raw features', () => {
  // label = 1 iff x0 > 5 (x1 is noise on a different scale)
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const x0 = i < 20 ? 1 + (i % 5) * 0.5 : 7 + (i % 5) * 0.5;
    X.push([x0, 100 + ((i * 37) % 11)]);
    y.push(i < 20 ? 0 : 1);
  }
  const m = trainLogistic(X, y, { l2: 1e-4, epochs: 4000 });
  const p = X.map((x) => predict(m, x));
  assert.equal(auc(p, y), 1);
  assert.ok(p.every((v, i) => (y[i] === 1 ? v > 0.5 : v < 0.5)));
  assert.ok(m.weights[0] > 0);
  // Folding check: σ(b_raw + w_raw·x) == σ(b_std + w_std·z) with z = (x-μ)/σ
  const { mean, std } = standardisation(X);
  const wStd = m.weights.map((w, k) => w * std[k]);
  const bStd = m.bias + wStd.reduce((acc, w, k) => acc + (w * mean[k]) / std[k], 0);
  const x = X[3];
  const z = x.map((v, k) => (v - mean[k]) / std[k]);
  assert.ok(Math.abs(predict(m, x) - sigmoid(bStd + wStd[0] * z[0] + wStd[1] * z[1])) < 1e-12);
});

test('constant (dropped) column keeps a zero weight', () => {
  const X = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ];
  const m = trainLogistic(X, [0, 0, 1, 1]);
  assert.equal(m.weights[0], 0);
});
