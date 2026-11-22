import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { policy, ModerationFailure, POLICY_VERSION, PROMPT_VERSION } from '../../domain';

const policySchema = z
  .object({
    version: z.literal(POLICY_VERSION),
    labels: z.array(z.string()).length(8),
    holdLabels: z.array(z.string()).length(8),
    reasonCodes: z.array(z.string()).length(12),
    prohibitedTerms: z.array(z.string()).length(policy.prohibitedTerms.length),
    strictRuleVersion: z.literal('explicit-language.v1'),
  })
  .strict();
/** An asset may not silently weaken policy while retaining the same version. */
export function validatePolicyAsset(raw: unknown): typeof policy {
  const result = policySchema.safeParse(raw);
  if (!result.success || JSON.stringify(result.data) !== JSON.stringify(policy))
    throw new ModerationFailure('CONFIG_MISSING');
  return policy;
}
export function loadProviderInstructions(): string {
  try {
    const loaded = validatePolicyAsset(
      JSON.parse(
        readFileSync(join(__dirname, '../../../policies/' + POLICY_VERSION + '.json'), 'utf8'),
      ),
    );
    const prompt = readFileSync(
      join(__dirname, '../../../prompts/' + PROMPT_VERSION + '.md'),
      'utf8',
    );
    if (
      !prompt.startsWith('# ' + PROMPT_VERSION + '\n') &&
      !prompt.startsWith('# ' + PROMPT_VERSION + '\r\n')
    )
      throw new ModerationFailure('CONFIG_MISSING');
    return prompt + '\nChính sách phiên bản cố định:\n' + JSON.stringify(loaded);
  } catch {
    throw new ModerationFailure('CONFIG_MISSING');
  }
}
