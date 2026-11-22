import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { auc, coverage, exposureGini, gini, intraListDiversity, logLoss, meanStd, ndcgAtK, precisionAtK, recallAtK } from '../src/metrics';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('P@5, Recall@5, NDCG@5 on a hand-computed list', () => {
  const rec = ['a', 'b', 'c', 'd', 'e'];
  const rel = new Set(['a', 'c', 'x']);
  close(precisionAtK(rec, rel, 5), 2 / 5);
  close(recallAtK(rec, rel, 5), 2 / 3);
  // DCG = 1/log2(2) + 1/log2(4) = 1.5 ; IDCG = 1 + 1/log2(3) + 1/log2(4)
  close(ndcgAtK(rec, rel, 5), 1.5 / (1 + 1 / Math.log2(3) + 0.5));
  close(ndcgAtK(['a', 'c', 'x'], rel, 5), 1);
  close(ndcgAtK(['q'], rel, 5), 0);
});

test('Gini: equal = 0, all-in-one of n=4 = 0.75', () => {
  close(gini([1, 1, 1, 1]), 0);
  close(gini([0, 0, 0, 1]), 0.75);
  close(gini([1, 3]), 0.25); // (2*(1*1+2*3))/(2*4) - 3/2 = 14/8 - 1.5
});

test('coverage and exposure Gini over the catalogue', () => {
  const lists = [['a', 'b'], ['a', 'c']];
  close(coverage(lists, 4, 5), 3 / 4);
  // counts a=2,b=1,c=1,d=0 → sorted [0,1,1,2], total 4: 2*(0+2+3+8)/(4*4) - 5/4 = 26/16 - 1.25 = 0.375
  close(exposureGini(lists, ['a', 'b', 'c', 'd'], 5), 0.375);
});

test('ILD: orthogonal = 1, identical = 0', () => {
  const emb: Record<string, number[]> = { a: [1, 0], b: [0, 1], c: [1, 0] };
  close(intraListDiversity(['a', 'b'], (id) => emb[id]), 1);
  close(intraListDiversity(['a', 'c'], (id) => emb[id]), 0);
  close(intraListDiversity(['a', 'b', 'c'], (id) => emb[id]), 2 / 3);
});

test('AUC rank statistic with ties, logloss, mean ± sample std', () => {
  close(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  close(auc([0.5, 0.5], [0, 1]), 0.5);
  close(auc([0.9, 0.1], [1, 0]), 1);
  close(logLoss([0.5, 0.5], [1, 0]), Math.log(2));
  const ms = meanStd([1, 2, 3]);
  close(ms.mean, 2);
  close(ms.std, 1);
});
