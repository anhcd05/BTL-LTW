import type { PrismaClient } from '@infosound/database';
import { trainFromSnapshot } from './dataset';
import { e5ModelId } from './embedder';
import { FEATURE_ORDER } from './features';
import { loadSnapshot } from './db';

export function modelVersion(now: Date): string {
  return `lr-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

/** Trains the DESIGN §2 ranker on the demo DB and activates it in recommendation_models. */
export async function trainAndActivate(
  db: PrismaClient,
  opts: { seed: number; now: Date; activate: boolean; log: (line: string) => void },
): Promise<void> {
  const embeddingModel = e5ModelId();
  const snapshot = await loadSnapshot(db, opts.now, embeddingModel);
  opts.log(
    `train: ${snapshot.tracks.length} public tracks, ${snapshot.users.length} users, ${snapshot.embeddings.size} embeddings (${embeddingModel})`,
  );
  if (!snapshot.embeddings.size) opts.log('train: WARNING no embeddings for the pinned model — content_sim will be 0; run `embed` first');
  const version = modelVersion(opts.now);
  const { model } = trainFromSnapshot(snapshot, { seed: opts.seed, version });
  const m = model.metrics;
  opts.log(
    `train: AUC pre-holdout fit ${m.train.auc.toFixed(3)} / last-7-days holdout ${m.holdout.auc.toFixed(3)}; logloss train ${m.train.logloss.toFixed(3)} / last-7-days holdout ${m.holdout.logloss.toFixed(3)} ` +
      `(n=${m.train.n}/${m.holdout.n}, epochs ${model.epochs})`,
  );
  const metrics = { ...m, standardisedWeights: model.standardisedWeights, embeddingModel, finalLoss: model.finalLoss, epochs: model.epochs, trainedAt: opts.now.toISOString() };
  await db.$transaction(async (tx) => {
    if (opts.activate) await tx.$executeRaw`UPDATE recommendation_models SET active=false WHERE active`;
    await tx.$executeRaw`
      INSERT INTO recommendation_models (id, version, feature_names, weights, bias, metrics, active, created_at)
      VALUES (gen_random_uuid(), ${model.row.version}, ${[...model.row.featureNames]}::text[],
        ${[...model.row.weights]}::double precision[], ${model.row.bias}, ${JSON.stringify(metrics)}::jsonb, ${opts.activate}, now())`;
  });
  // Row = { version, featureNames: FEATURE_ORDER, weights (raw-feature space), bias }, already accepted by parseModel.
  opts.log(`train: inserted recommendation_models version=${version}${opts.activate ? ' (active)' : ''}`);
  opts.log('  feature          raw weight   standardised');
  FEATURE_ORDER.forEach((name, k) =>
    opts.log(`  ${name.padEnd(15)} ${model.weights[k].toFixed(4).padStart(10)}   ${model.standardisedWeights[k].toFixed(4).padStart(10)}`),
  );
  opts.log(`  ${'bias'.padEnd(15)} ${model.bias.toFixed(4)}`);
}
