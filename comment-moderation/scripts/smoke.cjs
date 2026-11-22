const {loadConfig,createGeminiProvider,evaluatePolicy,POLICY_VERSION,PROMPT_VERSION,SCHEMA_VERSION}=require('../dist/analyzer.js');
const {selectFixtures}=require('./selection.cjs');
const config=loadConfig(),live=process.argv.includes('--live');
const diag={provider:'gemini',model:config.model,key_present:config.keyPresent,configured:config.enabled,invalid_variables:config.errors,connection:'unverified',budget:'unverified'};
async function main(){
  let selection;
  try{selection=selectFixtures(require('../tests/fixtures/vi.v2.json'),process.argv.slice(2));}
  catch{console.log(JSON.stringify({status:'FAIL',...diag,reason:'INVALID_SELECTION',inference:'SKIPPED'}));process.exitCode=1;return;}
  const plan={mode:selection.mode,split:selection.split,planned:selection.fixtures.length,corpusSize:selection.corpusSize,notSelected:{status:'SKIPPED',count:selection.notSelected}};
  if(!live){console.log(JSON.stringify({status:config.errors.length?'BLOCKED':'PASS',...diag,...plan,inference:'SKIPPED'}));return;}
  if(!config.enabled){console.log(JSON.stringify({status:'BLOCKED',...diag,...plan,reason:'CONFIG_MISSING',inference:'SKIPPED'}));process.exitCode=2;return;}
  const {db}=require('@infosound/database');
  try{
    const {PostgresBudget}=require('../dist/server.js'),budget=new PostgresBudget(db,config),provider=createGeminiProvider(config),observations=[];
    let providerCalls=0;
    for(const fixture of selection.fixtures){let reserved=false,success=false;const start=Date.now();
      try{
        await budget.reserve();reserved=true;providerCalls++;
        const result=await provider.classify({comment:fixture.comment,signals:{repeated:fixture.signals?.repeated===true}});success=true;
        observations.push({id:fixture.id,result,status:evaluatePolicy(result,{autoApprove:config.autoApprove,repeated:fixture.signals?.repeated===true}),latencyMs:Date.now()-start});
      }catch(e){observations.push({id:fixture.id,errorCode:typeof e.code==='string'?e.code:'BUDGET_UNAVAILABLE',latencyMs:Date.now()-start,...(typeof e.retryAfterSeconds==='number'?{retryAfterSeconds:e.retryAfterSeconds}:{})});}
      finally{if(reserved)await budget.release(success);}
      // No sleeps or automatic scheduling: select the next small batch explicitly
      // after its Retry-After/minute window, sharing the same persisted budget.
      if(!success)break;
    }
    const {summarizeEvaluation}=await import('./evaluation.mjs');
    const inferenceOk=observations.length===selection.fixtures.length&&observations.every(o=>!o.errorCode);
    const mismatches=observations.filter(o=>!o.errorCode&&((o.status==='VISIBLE'?'allow':'review')!==selection.fixtures.find(f=>f.id===o.id).expectedAction)).map(o=>o.id);
    const metadata={model:config.model,sdk:'@google/genai@2.32.0',api:'generateContent v1beta',POLICY_VERSION,PROMPT_VERSION,SCHEMA_VERSION,time:new Date().toISOString(),mode:selection.mode,split:selection.split,autoApprove:config.autoApprove};
    if(selection.output)await require('node:fs/promises').writeFile(selection.output,JSON.stringify({metadata,observations},null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:mismatches.length?'FAIL':inferenceOk?'PASS':'BLOCKED',...diag,...plan,
      inference:inferenceOk?'PASS':'BLOCKED',quality:mismatches.length?'FAIL':inferenceOk?'PASS':'BLOCKED',qualityMismatchIds:mismatches,
      connection:observations.some(o=>o.result)?'verified':'unverified',budget:await budget.diagnostics(),metadata,attempted:observations.length,providerCalls,
      errors:observations.filter(o=>o.errorCode).map(o=>({id:o.id,code:o.errorCode,...(o.retryAfterSeconds===undefined?{}:{retryAfterSeconds:o.retryAfterSeconds})})),
      report:summarizeEvaluation(selection.fixtures,observations),qualityScope:'Selected synthetic examples only; schema/inference success does not establish general Vietnamese moderation accuracy.'}));
    if(!inferenceOk||mismatches.length)process.exitCode=2;
  }finally{await db.$disconnect();}
}
main().catch(()=>{console.log(JSON.stringify({status:'BLOCKED',...diag,reason:'RUNTIME_OR_BUDGET_UNAVAILABLE'}));process.exitCode=2;});
