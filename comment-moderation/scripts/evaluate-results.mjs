import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { summarizeEvaluation } from './evaluation.mjs';

const args = process.argv.slice(2);
const pick = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (!pick('--results')) {
  process.stderr.write('Usage: node scripts/evaluate-results.mjs --results <observations.json> [--split development|test|smoke]\nOffline only; never calls Gemini.\n');
  process.exitCode = 2;
} else {
  try {
    const split = pick('--split') ?? 'test';
    if (!['development', 'test', 'smoke'].includes(split)) throw new Error('INVALID_SPLIT');
    const paths=args.flatMap((arg,index)=>arg==='--results'?[args[index+1]]:[]);
    const inputs=await Promise.all(paths.map(async path=>JSON.parse(await readFile(path,'utf8'))));
    const observations=inputs.flatMap(input=>Array.isArray(input)?input:input.observations);
    const metadata=inputs.filter(input=>input.metadata).map(input=>input.metadata);
    if(metadata.length&&metadata.some(item=>['model','POLICY_VERSION','PROMPT_VERSION','SCHEMA_VERSION','autoApprove'].some(key=>item[key]!==metadata[0][key])))throw Error('INCOMPATIBLE_REPORTS');
    const policyVersion=metadata[0]?.POLICY_VERSION??'moderation.v2';
    if(!['moderation.v1','moderation.v2'].includes(policyVersion))throw Error('UNSUPPORTED_POLICY_VERSION');
    const fixtureVersion=policyVersion==='moderation.v1'?'vi.v1':'vi.v2';
    const dataset=JSON.parse(await readFile(fileURLToPath(new URL('../tests/fixtures/'+fixtureVersion+'.json',import.meta.url)),'utf8'));
    const fixtures=dataset.fixtures.filter(item=>split==='smoke'?item.smoke:item.split===split);
    process.stdout.write(JSON.stringify(summarizeEvaluation(fixtures, observations, { ...metadata[0], datasetVersion: dataset.version, split, batches:inputs.length }), null, 2) + '\n');
  } catch {
    process.stderr.write('Evaluation input is invalid or unreadable; no content or provider response was logged.\n');
    process.exitCode = 1;
  }
}
