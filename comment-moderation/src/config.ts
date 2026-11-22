export interface ModerationConfig {
  enabled: boolean;
  autoApprove: boolean;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  maxOutputTokens: number;
  pendingMaxAgeSeconds: number;
  maxCommentChars: number;
  callsPerMinute: number;
  dailyCallLimit: number;
  logContent: boolean;
  model: string;
  keyPresent: boolean;
  errors: string[];
  auditRetentionDays: number;
}
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ModerationConfig {
  const errors: string[] = [];
  const bool = (name: string, fallback: boolean) => {
    const v = env[name];
    if (v === undefined) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    errors.push(name);
    return false;
  };
  const num = (name: string, fallback: number, min: number, max: number) => {
    const v = env[name];
    if (v === undefined) return fallback;
    if (
      !/^\d+$/.test(v) ||
      !Number.isSafeInteger(Number(v)) ||
      Number(v) < min ||
      Number(v) > max
    ) {
      errors.push(name);
      return fallback;
    }
    return Number(v);
  };
  const requested = bool('MODERATION_AI_ENABLED', true);
  const model = env.GEMINI_MODEL === undefined ? 'gemini-2.5-flash-lite' : env.GEMINI_MODEL.trim();
  if (!model || !/^gemini-[a-zA-Z0-9.\-]+$/.test(model)) errors.push('GEMINI_MODEL');
  if ((env.MODERATION_AI_PROVIDER ?? 'gemini') !== 'gemini') errors.push('MODERATION_AI_PROVIDER');
  const config: ModerationConfig = {
    enabled: false,
    autoApprove: bool('MODERATION_AI_AUTO_APPROVE', true),
    timeoutMs: num('MODERATION_AI_TIMEOUT_MS', 15000, 100, 15000),
    maxRetries: num('MODERATION_AI_MAX_RETRIES', 2, 0, 2),
    concurrency: num('MODERATION_AI_CONCURRENCY', 1, 1, 1),
    maxOutputTokens: num('MODERATION_AI_MAX_OUTPUT_TOKENS', 1024, 256, 1024),
    pendingMaxAgeSeconds: num('MODERATION_AI_PENDING_MAX_AGE_SECONDS', 120, 15, 120),
    maxCommentChars: num('MODERATION_AI_MAX_COMMENT_CHARS', 2000, 1, 2000),
    callsPerMinute: num('MODERATION_AI_MAX_CALLS_PER_MINUTE', 2, 1, 2),
    dailyCallLimit: num('MODERATION_AI_DAILY_CALL_LIMIT', 200, 1, 200),
    logContent: bool('MODERATION_AI_LOG_CONTENT', false),
    model,
    keyPresent: !!env.GEMINI_API_KEY?.trim(),
    errors,
    auditRetentionDays: num('MODERATION_AI_AUDIT_RETENTION_DAYS', 30, 1, 365),
  };
  if (config.logContent) errors.push('MODERATION_AI_LOG_CONTENT');
  config.enabled = requested && config.keyPresent && errors.length === 0;
  return config;
}
