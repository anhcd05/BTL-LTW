import { z } from 'zod';
export const POLICY_VERSION = 'moderation.v2',
  PROMPT_VERSION = 'moderation.vi.v2',
  SCHEMA_VERSION = '2';
export const labels = Object.freeze([
  'harassment',
  'hate',
  'threat',
  'sexual',
  'spam',
  'scam',
  'privacy',
  'profanity',
] as const);
export const reasonCodes = Object.freeze([
  'NO_VIOLATION',
  'ARTISTIC_CRITICISM',
  'PROFANITY_CONTEXTUAL',
  'PROFANITY_PROHIBITED',
  'TARGETED_HARASSMENT',
  'HATE_TARGETING_GROUP',
  'VIOLENT_THREAT',
  'SEXUAL_CONTENT',
  'PROMOTIONAL_SPAM',
  'SCAM_SOLICITATION',
  'PRIVATE_DATA_EXPOSURE',
  'AMBIGUOUS_CONTEXT',
] as const);
/** Pure, immutable domain invariants. File I/O belongs to the provider adapter. */
const holdLabels: readonly (typeof labels)[number][] = labels;
export const prohibitedTerms = Object.freeze([
  'ngu',
  'vl',
  'vcl',
  'vkl',
  'đcm',
  'dcm',
  'đkm',
  'dkm',
  'đm',
  'địt',
  'đụ',
  'lồn',
  'cặc',
  'cứt',
  'đéo',
  'đếch',
  'đĩ',
  'điếm',
  'vãi',
  'mẹ kiếp',
  'chó đẻ',
  'khốn nạn',
  'đần độn',
  'dit me',
  'du ma',
  'du me',
  'vai lon',
  'vai ca lon',
] as const);
export const policy = Object.freeze({
  version: POLICY_VERSION,
  labels,
  holdLabels,
  reasonCodes,
  prohibitedTerms,
  strictRuleVersion: 'explicit-language.v1',
});
export const resultSchema = z
  .object({
    labels: z.array(z.enum(labels)).max(8),
    severity: z.enum(['none', 'low', 'medium', 'high']),
    recommendation: z.enum(['allow', 'review']),
    reason_codes: z.array(z.enum(reasonCodes)).min(1).max(12),
    reason_vi: z.string().min(1).max(300),
    evidence_quotes: z.array(z.string().min(1).max(120)).max(3),
    uncertain: z.boolean(),
  })
  .strict();
export type ModerationResult = z.infer<typeof resultSchema>;
export type ModerationInput = {
  comment: string;
  parent?: string;
  title?: string;
  signals: { repeated: boolean };
};
export interface ModerationProvider {
  classify(input: ModerationInput): Promise<ModerationResult>;
}
export class ModerationFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ModerationFailure';
  }
}
export function validateResult(raw: unknown, comment: string): ModerationResult {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new ModerationFailure('INVALID_OUTPUT');
  const r = parsed.data;
  if (
    new Set(r.labels).size !== r.labels.length ||
    new Set(r.reason_codes).size !== r.reason_codes.length ||
    r.evidence_quotes.some((q) => !comment.includes(q))
  )
    throw new ModerationFailure('INVALID_OUTPUT');
  const held = r.labels.some((l) => policy.holdLabels.includes(l));
  if (
    (r.recommendation === 'allow' &&
      (r.uncertain || held || ['medium', 'high'].includes(r.severity))) ||
    (r.severity === 'none' && held) ||
    (r.reason_codes.includes('NO_VIOLATION') && (held || r.severity === 'high')) ||
    (r.uncertain && !r.reason_codes.includes('AMBIGUOUS_CONTEXT'))
  )
    throw new ModerationFailure('INVALID_OUTPUT');
  const matches: Record<string, string> = {
    TARGETED_HARASSMENT: 'harassment',
    HATE_TARGETING_GROUP: 'hate',
    VIOLENT_THREAT: 'threat',
    SEXUAL_CONTENT: 'sexual',
    PROMOTIONAL_SPAM: 'spam',
    SCAM_SOLICITATION: 'scam',
    PRIVATE_DATA_EXPOSURE: 'privacy',
    PROFANITY_CONTEXTUAL: 'profanity',
    PROFANITY_PROHIBITED: 'profanity',
  };
  if (
    !r.reason_vi.trim() ||
    r.reason_codes.some(
      (c) => matches[c] && !r.labels.includes(matches[c] as (typeof labels)[number]),
    ) ||
    r.labels.some((l) => !r.reason_codes.some((c) => matches[c] === l))
  )
    throw new ModerationFailure('INVALID_OUTPUT');
  if (r.recommendation === 'allow' && checkStrictViolation(comment))
    throw new ModerationFailure('INVALID_OUTPUT');
  return r;
}
export function evaluatePolicy(
  r: ModerationResult,
  options: { autoApprove: boolean; repeated: boolean },
): 'VISIBLE' | 'HELD' | 'HIDDEN' {
  // HIDDEN is a confirmed policy rejection, never an AI transport/config error.
  if (
    !r.uncertain &&
    !options.repeated &&
    r.recommendation === 'review' &&
    r.labels.length > 0 &&
    r.evidence_quotes.length > 0
  )
    return 'HIDDEN';
  return options.autoApprove &&
    !options.repeated &&
    r.recommendation === 'allow' &&
    !r.uncertain &&
    !r.labels.some((l) => policy.holdLabels.includes(l)) &&
    ['none', 'low'].includes(r.severity)
    ? 'VISIBLE'
    : 'HELD';
}
export type StrictViolation = {
  ruleId: 'PROHIBITED_VIETNAMESE_LANGUAGE';
  term: string;
  evidenceQuote: string;
  reasonCode: 'PROFANITY_PROHIBITED';
  policyVersion: typeof POLICY_VERSION;
};
const abbreviationTerms = new Set<string>(['vl', 'vcl', 'vkl', 'đcm', 'dcm', 'đkm', 'dkm', 'đm']);
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedTerms = prohibitedTerms.map((term) =>
  abbreviationTerms.has(term)
    ? Array.from(term).map(escapePattern).join('[.\\-\\s]*')
    : escapePattern(term).replace(/ /g, '\\s+'),
);
const strictPattern = new RegExp(
  '(?:^|[^\\p{L}\\p{N}\\p{M}_])(' + escapedTerms.join('|') + ')(?=$|[^\\p{L}\\p{N}\\p{M}_])',
  'u',
);
/** Explicit owner-requested language rule, not a simulated model result. Accent
 * preservation and Unicode boundaries avoid matching nguồn/ngủ/nguyên. Keep an
 * offset map so evidence is quoted from the original, including decomposed text.
 */
export function checkStrictViolation(comment: string): StrictViolation | null {
  let normalized = '';
  const starts: number[] = [],
    ends: number[] = [];
  for (const item of new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(comment)) {
    const segment = item.segment.normalize('NFC').toLocaleLowerCase('vi');
    normalized += segment;
    for (let i = 0; i < segment.length; i++) {
      starts.push(item.index);
      ends.push(item.index + item.segment.length);
    }
  }
  const found = strictPattern.exec(normalized);
  if (!found) return null;
  const text = found[1],
    offset = found.index + found[0].length - text.length;
  return {
    ruleId: 'PROHIBITED_VIETNAMESE_LANGUAGE',
    term: text.replace(/\s+/gu, ' '),
    evidenceQuote: comment.slice(starts[offset], ends[offset + text.length - 1]),
    reasonCode: 'PROFANITY_PROHIBITED',
    policyVersion: POLICY_VERSION,
  };
}
// Privacy preflight only: never classifies abuse or claims an AI decision.
export function containsPrivateData(text: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?84|0)[\s.\-]*(?:\d[\s.\-]*){9,11}\b|\b\d{12,19}\b|(?:AIza[\w-]{25,}|sk-[\w-]{20,})|(?:địa chỉ|dia chi|căn cước|can cuoc|số tài khoản|so tai khoan|mật khẩu|mat khau)/iu.test(
    text,
  );
}
