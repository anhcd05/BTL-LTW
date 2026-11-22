#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkOfflineGuard, OVERRIDE_FLAG } from './guard';

const USAGE = `InfoSound reco batch (DEMO ONLY)
usage: node dist/cli.js <command> [options]

  seed      [--seed N] [--now ISO] [--reset | --reset-only] [--skip-audio]
  embed     [--force]
  train     [--seed N] [--now ISO] [--no-activate]
  evaluate  [--seeds 42,...,51 (default 10 seeds)] [--now ISO] [--embedder auto|e5|hash] [--out DIR] [--label NAME]
  art       [--force] [--covers-only | --avatars-only]
  demo-user --user-email EMAIL [--now ISO] [--reset]

Every command requires RECO_DEMO=1. seed/embed/train/art/demo-user also require the DB URL's database name or host
to contain "demo" (or ${OVERRIDE_FLAG}). evaluate never opens a DB connection.`;

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function intOption(argv: string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function nowOption(argv: string[]): Date {
  const raw = option(argv, '--now');
  if (raw === undefined) {
    const d = new Date();
    d.setUTCSeconds(0, 0);
    return d;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error('--now must be an ISO date');
  return d;
}

const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    log(USAGE);
    return;
  }
  if (command === 'evaluate') {
    const g = checkOfflineGuard(process.env);
    if (!g.ok) throw new Error(`Refusing to run: ${g.reason}`);
    const { runEvaluation } = await import('./evaluate');
    const seeds = (option(argv, '--seeds') ?? '42,43,44,45,46,47,48,49,50,51').split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isSafeInteger(n)) throw new Error('--seeds must be a comma-separated list of integers');
      return n;
    });
    const embedder = (option(argv, '--embedder') ?? 'auto') as 'auto' | 'e5' | 'hash';
    if (!['auto', 'e5', 'hash'].includes(embedder)) throw new Error('--embedder must be auto, e5 or hash');
    const outDir = resolve(option(argv, '--out') ?? resolve(__dirname, '..', '..', 'reports'));
    // Fixed default "now" keeps reports reproducible across runs.
    const now = argv.includes('--now') ? nowOption(argv) : new Date('2026-11-21T00:00:00Z');
    await runEvaluation({ seeds, now, embedder, outDir, log, label: option(argv, '--label') });
    return;
  }
  if (!['seed', 'embed', 'train', 'art', 'demo-user'].includes(command)) throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  const { connectDemoDb } = await import('./db');
  const db = await connectDemoDb(argv);
  try {
    if (command === 'seed') {
      const { seed } = await import('./seed');
      await seed(db, {
        seed: intOption(argv, '--seed', 42),
        now: nowOption(argv),
        reset: argv.includes('--reset'),
        resetOnly: argv.includes('--reset-only'),
        skipAudio: argv.includes('--skip-audio'),
        log,
      });
    } else if (command === 'art') {
      const { generateArt } = await import('./art');
      await generateArt(db, {
        force: argv.includes('--force'),
        covers: !argv.includes('--avatars-only'),
        avatars: !argv.includes('--covers-only'),
        log,
      });
    } else if (command === 'demo-user') {
      const email = option(argv, '--user-email');
      if (!email) throw new Error('demo-user needs --user-email EMAIL (an existing, normally registered account)');
      const { demoUser } = await import('./demo-user');
      await demoUser(db, { email: email.trim().toLowerCase(), now: nowOption(argv), reset: argv.includes('--reset'), log });
    } else if (command === 'embed') {
      const { embedTracks } = await import('./embed');
      await embedTracks(db, { force: argv.includes('--force'), log });
    } else {
      const { trainAndActivate } = await import('./train');
      await trainAndActivate(db, { seed: intOption(argv, '--seed', 42), now: nowOption(argv), activate: !argv.includes('--no-activate'), log });
    }
  } finally {
    await db.$disconnect();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[reco] ${(error as Error).message}\n`);
  process.exitCode = 1;
});
