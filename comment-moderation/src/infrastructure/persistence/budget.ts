import { Prisma, type PrismaClient } from '@infosound/database';
import { randomUUID } from 'node:crypto';
import type { ModerationConfig } from '../../config';

export class BudgetFailure extends Error {
  readonly code = 'INTERNAL_BUDGET_EXCEEDED';
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super('INTERNAL_BUDGET_EXCEEDED');
  }
}
type BudgetRow = {
  minute_count: number;
  day_count: number;
  minute_at: Date;
  day_at: Date;
  failures: number;
  circuit_until: Date | null;
  active_until: Date | null;
  active_token: string | null;
};
/** One conservative shared scope per model, even across keys/projects. UTC reset.
 * Reserving counts an uncertain external call even if the process subsequently dies.
 */
export class PostgresBudget {
  readonly scope: string;
  private token: string | null = null;
  constructor(
    private readonly db: PrismaClient,
    private readonly config: ModerationConfig,
  ) {
    this.scope = 'gemini:' + config.model;
  }
  async reserve(): Promise<void> {
    const token = randomUUID();
    const state = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO comment_moderation_budget(scope) VALUES(${this.scope}) ON CONFLICT DO NOTHING`;
      await tx.$queryRaw`SELECT scope FROM comment_moderation_budget WHERE scope=${this.scope} FOR UPDATE`;
      await tx.$executeRaw`UPDATE comment_moderation_budget SET
        minute_count=CASE WHEN minute_at<date_trunc('minute',now()) THEN 0 ELSE minute_count END,
        minute_at=date_trunc('minute',now()),
        day_count=CASE WHEN day_at<(now() AT TIME ZONE 'UTC')::date THEN 0 ELSE day_count END,
        day_at=(now() AT TIME ZONE 'UTC')::date WHERE scope=${this.scope}`;
      const [row] = await tx.$queryRaw<
        BudgetRow[]
      >`SELECT * FROM comment_moderation_budget WHERE scope=${this.scope}`;
      if (row.day_count >= this.config.dailyCallLimit) return { ok: false, retryable: false };
      if (row.circuit_until && row.circuit_until > new Date())
        return { ok: false, retryable: false };
      if (row.active_until && row.active_until > new Date())
        return {
          ok: false,
          retryable: true,
          seconds: Math.max(1, Math.ceil((row.active_until.getTime() - Date.now()) / 1000)),
        };
      if (row.minute_count >= this.config.callsPerMinute)
        return {
          ok: false,
          retryable: true,
          seconds: Math.max(1, 60 - new Date().getUTCSeconds()),
        };
      await tx.$executeRaw`UPDATE comment_moderation_budget SET minute_count=minute_count+1,day_count=day_count+1,
        active_until=now()+(${this.config.timeoutMs + 5000}*interval '1 millisecond'),active_token=${token}::uuid WHERE scope=${this.scope}`;
      return { ok: true, retryable: false };
    });
    if (!state.ok) throw new BudgetFailure(state.retryable, state.seconds);
    this.token = token;
  }
  async release(success: boolean): Promise<void> {
    const token = this.token;
    this.token = null;
    if (!token) return;
    await this.db
      .$executeRaw`UPDATE comment_moderation_budget SET active_until=NULL,active_token=NULL,
      failures=CASE WHEN ${success} THEN 0 ELSE failures+1 END,
      circuit_until=CASE WHEN ${success} THEN NULL WHEN failures+1>=3 THEN now()+interval '5 minutes' ELSE circuit_until END
      WHERE scope=${this.scope} AND active_token=${token}::uuid`;
  }
  async diagnostics() {
    const [row] = await this.db.$queryRaw<
      BudgetRow[]
    >`SELECT * FROM comment_moderation_budget WHERE scope=${this.scope}`;
    const today = new Date().toISOString().slice(0, 10);
    const callsToday =
      row && new Date(row.day_at).toISOString().slice(0, 10) === today ? row.day_count : 0;
    return {
      callsToday,
      callsThisMinute:
        row && row.minute_at.getTime() >= Math.floor(Date.now() / 60000) * 60000
          ? row.minute_count
          : 0,
      remainingToday: Math.max(0, this.config.dailyCallLimit - callsToday),
      circuitOpen: !!row?.circuit_until && row.circuit_until > new Date(),
    };
  }
}
