import { sigmoid } from '@infosound/recommendation-ai/features';

/**
 * Logistic regression, full-batch gradient descent with L2 (bias not penalised).
 * Training runs on standardised features; the returned weights are folded back into the raw
 * feature space so serving computes σ(b + w·x) on the raw DESIGN §2 features directly.
 */
export type LrOptions = { l2?: number; learningRate?: number; epochs?: number; tolerance?: number };
export type LrModel = {
  weights: number[];
  bias: number;
  /** Standardisation used during training (already folded into weights/bias). */
  mean: number[];
  std: number[];
  epochs: number;
  finalLoss: number;
};

export { sigmoid };

export function standardisation(X: number[][]): { mean: number[]; std: number[] } {
  const d = X[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const row of X) for (let k = 0; k < d; k += 1) mean[k] += row[k] / X.length;
  for (const row of X) for (let k = 0; k < d; k += 1) std[k] += (row[k] - mean[k]) ** 2 / X.length;
  for (let k = 0; k < d; k += 1) std[k] = Math.sqrt(std[k]) > 1e-9 ? Math.sqrt(std[k]) : 1;
  return { mean, std };
}

/** Mean regularised log-loss and its gradient on (already standardised) Z. */
export function lossAndGradient(
  Z: number[][],
  y: number[],
  w: number[],
  b: number,
  l2: number,
): { loss: number; gw: number[]; gb: number } {
  const n = Z.length;
  const d = w.length;
  const gw = new Array<number>(d).fill(0);
  let gb = 0;
  let loss = 0;
  for (let i = 0; i < n; i += 1) {
    let z = b;
    for (let k = 0; k < d; k += 1) z += w[k] * Z[i][k];
    const p = sigmoid(z);
    // log(1+e^z) - y z, computed stably
    loss += (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - y[i] * z;
    const r = p - y[i];
    gb += r;
    for (let k = 0; k < d; k += 1) gw[k] += r * Z[i][k];
  }
  let penalty = 0;
  for (let k = 0; k < d; k += 1) {
    gw[k] = gw[k] / n + l2 * w[k];
    penalty += w[k] * w[k];
  }
  return { loss: loss / n + 0.5 * l2 * penalty, gw, gb: gb / n };
}

export function trainLogistic(X: number[][], y: number[], opts: LrOptions = {}): LrModel {
  if (!X.length || X.length !== y.length) throw new Error('trainLogistic: empty or mismatched data');
  const l2 = opts.l2 ?? 1e-3;
  const lr = opts.learningRate ?? 0.5;
  const maxEpochs = opts.epochs ?? 3000;
  const tol = opts.tolerance ?? 1e-9;
  const { mean, std } = standardisation(X);
  const Z = X.map((row) => row.map((x, k) => (x - mean[k]) / std[k]));
  const d = mean.length;
  let w = new Array<number>(d).fill(0);
  const prior = y.reduce((a, b) => a + b, 0) / y.length;
  let b = prior > 0 && prior < 1 ? Math.log(prior / (1 - prior)) : 0;
  let last = Infinity;
  let epoch = 0;
  for (; epoch < maxEpochs; epoch += 1) {
    const { loss, gw, gb } = lossAndGradient(Z, y, w, b, l2);
    w = w.map((wk, k) => wk - lr * gw[k]);
    b -= lr * gb;
    if (Math.abs(last - loss) < tol) {
      last = loss;
      break;
    }
    last = loss;
  }
  // Fold standardisation: w_raw = w/σ, b_raw = b − Σ w·μ/σ.
  const weights = w.map((wk, k) => wk / std[k]);
  const bias = b - w.reduce((acc, wk, k) => acc + (wk * mean[k]) / std[k], 0);
  return { weights, bias, mean, std, epochs: epoch, finalLoss: last };
}

export function predict(model: { weights: readonly number[]; bias: number }, x: readonly number[]): number {
  let z = model.bias;
  for (let k = 0; k < model.weights.length; k += 1) z += model.weights[k] * x[k];
  return sigmoid(z);
}
