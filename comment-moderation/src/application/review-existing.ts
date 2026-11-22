import type { PrismaClient } from '@infosound/database';
import { checkStrictViolation } from '../domain';
import { ModerationService, ModerationAccessError } from './service';
import { loadConfig } from '../config';

/** Owner-run cleanup. Dry-run default; never uploads historical text. */
export async function applyStrictPolicyToExisting(
  db: PrismaClient,
  options: { apply?: boolean; pageSize?: number; maxComments?: number; afterId?: string } = {},
) {
  const pageSize = options.pageSize ?? 100,
    maxComments = options.maxComments ?? 10000;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 500 ||
    !Number.isInteger(maxComments) ||
    maxComments < 1 ||
    maxComments > 100000
  )
    throw new Error('INVALID_REVIEW_BOUND');
  const service = new ModerationService(db, loadConfig({ MODERATION_AI_ENABLED: 'false' }));
  let cursor = options.afterId ?? '00000000-0000-0000-0000-000000000000',
    scanned = 0,
    matched = 0,
    applied = 0,
    conflicts = 0,
    skipped = 0,
    complete = false;
  const matchedIds: string[] = [];
  while (scanned < maxComments) {
    const take = Math.min(pageSize, maxComments - scanned);
    const rows = await db.$queryRaw<
      { id: string; body: string; content_version: number; moderation_revision: number }[]
    >`SELECT c.id,c.body,c.content_version,c.moderation_revision FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE c.id>${cursor}::uuid AND c.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY c.id LIMIT ${take}`;
    if (!rows.length) {
      complete = true;
      break;
    }
    for (const row of rows) {
      cursor = row.id;
      scanned++;
      if (!checkStrictViolation(row.body)) continue;
      matched++;
      matchedIds.push(row.id);
      if (options.apply)
        try {
          const result = await service.enforceStrictPolicy(row.id, {
            expected_content_version: row.content_version,
            expected_moderation_revision: row.moderation_revision,
          });
          if (result.changed) applied++;
          else skipped++;
        } catch (error) {
          if (error instanceof ModerationAccessError && [404, 409].includes(error.status)) {
            conflicts++;
            continue;
          }
          throw error;
        }
    }
    if (rows.length < take) {
      complete = true;
      break;
    }
  }
  if (!complete && scanned === maxComments) {
    const remaining = await db.$queryRaw<
      { id: string }[]
    >`SELECT c.id FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE c.id>${cursor}::uuid AND c.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY c.id LIMIT 1`;
    complete = remaining.length === 0;
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    scanned,
    matched,
    applied,
    skipped,
    conflicts,
    complete,
    lastId: cursor,
    matchedIds,
  };
}
