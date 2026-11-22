// Owner-operated, bounded local policy sweep. No AI request or raw text log.
const {db}=require('@infosound/database');
const {applyStrictPolicyToExisting,POLICY_VERSION}=require('../dist/server.js');
const args=process.argv.slice(2),apply=args.includes('--apply');
const maxArg=args.find(value=>value.startsWith('--max='));
const maxComments=maxArg?Number(maxArg.slice(6)):10000;
if(args.some(value=>value!=='--apply'&&!value.startsWith('--max='))||!Number.isInteger(maxComments)||maxComments<1||maxComments>100000){process.stderr.write('INVALID_REVIEW_ARGUMENTS\n');process.exitCode=1;}
else (async()=>{
  try{const result=await applyStrictPolicyToExisting(db,{apply,pageSize:100,maxComments});const {matchedIds,...summary}=result;console.log(JSON.stringify({...summary,policy_version:POLICY_VERSION,external_ai_calls:0}));if(!result.complete||result.conflicts)process.exitCode=2;}
  catch{process.stderr.write('STRICT_POLICY_REVIEW_FAILED\n');process.exitCode=1;}
  finally{await db.$disconnect();}
})();
