import { GoogleGenAI, type Fetch } from '@google/genai';
import { type ModerationConfig } from '../../config';
import {
  type ModerationProvider,
  type ModerationInput,
  ModerationFailure,
  validateResult,
  labels,
  reasonCodes,
  containsPrivateData,
} from '../../domain';
import { loadProviderInstructions } from './policy-assets';
export { validatePolicyAsset } from './policy-assets';
export const responseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'labels',
    'severity',
    'recommendation',
    'reason_codes',
    'reason_vi',
    'evidence_quotes',
    'uncertain',
  ],
  properties: {
    labels: { type: 'array', items: { type: 'string', enum: [...labels] }, maxItems: 8 },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    recommendation: { type: 'string', enum: ['allow', 'review'] },
    reason_codes: {
      type: 'array',
      items: { type: 'string', enum: [...reasonCodes] },
      minItems: 1,
      maxItems: 12,
    },
    reason_vi: { type: 'string', maxLength: 300 },
    evidence_quotes: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 3 },
    uncertain: { type: 'boolean' },
  },
};
export interface GeminiClient {
  models: { generateContent: (params: any) => Promise<any> };
}
export class GeminiModerationProvider implements ModerationProvider {
  constructor(
    private readonly config: ModerationConfig,
    private readonly client: GeminiClient,
  ) {}
  async classify(input: ModerationInput) {
    if (!this.config.enabled || !this.config.keyPresent || this.config.errors.length)
      throw new ModerationFailure('CONFIG_MISSING');
    if (Array.from(input.comment).length > this.config.maxCommentChars)
      throw new ModerationFailure('INVALID_INPUT');
    const data = {
      comment: input.comment,
      parent: input.parent ? Array.from(input.parent).slice(0, 500).join('') : undefined,
      title: input.title ? Array.from(input.title).slice(0, 200).join('') : undefined,
      signals: { repeated: input.signals.repeated === true },
    };
    if (containsPrivateData([data.comment, data.parent ?? '', data.title ?? ''].join('\n')))
      throw new ModerationFailure('PRIVATE_DATA_LOCAL_ONLY');
    try {
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(data) }] }],
        config: {
          systemInstruction: loadProviderInstructions(),
          responseMimeType: 'application/json',
          responseJsonSchema,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(this.config.model === 'gemini-3.5-flash-lite'
            ? {}
            : { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 }),
          httpOptions: { timeout: this.config.timeoutMs, retryOptions: { attempts: 1 } },
          abortSignal: AbortSignal.timeout(this.config.timeoutMs),
        },
      });
      if (!response || typeof response !== 'object') throw new ModerationFailure('INVALID_OUTPUT');
      if (response.promptFeedback?.blockReason) throw new ModerationFailure('PROVIDER_REFUSAL');
      const candidates = response.candidates;
      if (!Array.isArray(candidates) || candidates.length !== 1)
        throw new ModerationFailure('PROVIDER_REFUSAL');
      if (!candidates[0] || typeof candidates[0] !== 'object')
        throw new ModerationFailure('INVALID_OUTPUT');
      const ratings = candidates[0].safetyRatings;
      if (
        ratings !== undefined &&
        (!Array.isArray(ratings) || ratings.some((r: any) => !r || typeof r !== 'object'))
      )
        throw new ModerationFailure('INVALID_OUTPUT');
      if (ratings?.some((r: any) => r.blocked === true))
        throw new ModerationFailure('PROVIDER_REFUSAL');
      if (candidates[0].finishReason !== 'STOP')
        throw new ModerationFailure(
          ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(
            candidates[0].finishReason,
          )
            ? 'PROVIDER_REFUSAL'
            : 'INVALID_OUTPUT',
        );
      const parts = candidates[0].content?.parts;
      if (
        !Array.isArray(parts) ||
        parts.some(
          (p: any) =>
            !p ||
            typeof p !== 'object' ||
            typeof p.text !== 'string' ||
            p.thought ||
            p.functionCall,
        )
      )
        throw new ModerationFailure('INVALID_OUTPUT');
      const text = parts.map((p: any) => p.text).join('');
      if (!text || text.length > 16000) throw new ModerationFailure('INVALID_OUTPUT');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ModerationFailure('INVALID_OUTPUT');
      }
      return validateResult(raw, input.comment);
    } catch (error) {
      if (error instanceof ModerationFailure) throw error;
      const e = error as {
        status?: number;
        name?: string;
        response?: { headers?: { get?: (name: string) => string | null } };
      };
      const retry = e.response?.headers?.get?.('retry-after');
      const retrySeconds =
        retry && /^\d+$/.test(retry) ? Math.min(Number(retry), 86400) : undefined;
      if (e.status === 401 || e.status === 403) throw new ModerationFailure('AUTH_FAILED');
      if (e.status === 404 || e.status === 400) throw new ModerationFailure('MODEL_UNAVAILABLE');
      if (e.status === 429) throw new ModerationFailure('RATE_LIMITED', true, retrySeconds);
      if (
        e.name === 'AbortError' ||
        e.name === 'TimeoutError' ||
        e.status === 408 ||
        e.status === 504
      )
        throw new ModerationFailure('PROVIDER_TIMEOUT', true);
      throw new ModerationFailure('NETWORK_ERROR', true);
    }
  }
}
function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 86400);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(86400, Math.max(0, Math.ceil((date - Date.now()) / 1000)))
    : undefined;
}
/** SDK ApiError exposes status, but drops HTTP headers. Capture Retry-After at
 * its documented custom-fetch boundary, without logging or reading error bodies. */
export function moderationFetch(fetchImpl: Fetch): Fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok) return response;
    const retry = retryAfterSeconds(response.headers.get('retry-after'));
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403)
      throw new ModerationFailure('AUTH_FAILED');
    if (response.status === 400 || response.status === 404)
      throw new ModerationFailure('MODEL_UNAVAILABLE');
    if (response.status === 429) throw new ModerationFailure('RATE_LIMITED', true, retry);
    if (response.status === 408 || response.status === 504)
      throw new ModerationFailure('PROVIDER_TIMEOUT', true, retry);
    throw new ModerationFailure('NETWORK_ERROR', true, retry);
  };
}
export function createGeminiProvider(
  config: ModerationConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetch = globalThis.fetch,
): ModerationProvider {
  if (!config.enabled)
    return {
      classify: async () => {
        throw new ModerationFailure('CONFIG_MISSING');
      },
    };
  return new GeminiModerationProvider(
    config,
    new GoogleGenAI({
      vertexai: false,
      apiKey: env.GEMINI_API_KEY,
      httpOptions: {
        apiVersion: 'v1beta',
        timeout: config.timeoutMs,
        retryOptions: { attempts: 1 },
        fetch: moderationFetch(fetchImpl),
      },
    }),
  );
}
