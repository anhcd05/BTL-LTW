// Runs only in the disposable Linux development container prepared for this task.
// Secrets are read from private files and never printed or passed in argv.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
if(!fs.existsSync('/tmp/moderation-test-password'))throw new Error('ISOLATED_TEST_SECRET_REQUIRED');
const url='postgresql://moderation_test_owner:'+encodeURIComponent(fs.readFileSync('/tmp/moderation-test-password','utf8').trim())+'@infosound-moderation-pg2:5432/moderation_test';
fs.writeFileSync('/tmp/moderation-test-url',url,{mode:0o600});
process.env.DATABASE_URL_FILE='/tmp/moderation-test-url';
process.env.DATABASE_URL=url;
process.env.MODERATION_TEST_DATABASE_URL_FILE='/tmp/moderation-test-url';
const root='/repo/infosound';
const run=(args)=>{const r=spawnSync('pnpm',args,{cwd:root,env:process.env,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);};
(async()=>{
  for(const name of ['src','tests','scripts','policies','prompts'])if(fs.existsSync('/source/comment-moderation/'+name))fs.cpSync('/source/comment-moderation/'+name,'/repo/comment-moderation/'+name,{recursive:true});
  fs.cpSync('/source/infosound/packages/database/prisma','/repo/infosound/packages/database/prisma',{recursive:true});
  fs.copyFileSync('/source/infosound/packages/database/grants.sql','/repo/infosound/packages/database/grants.sql');
  run(['--filter','@infosound/database','generate']);run(['--filter','@infosound/database','build']);
  if(process.argv.includes('--setup')){
    // Exercise the real additive migration on a previously public row, using
    // Prisma's migration mechanism, not only a freshly created final schema.
    // A directory inherited from an image cannot reliably be renamed across
    // overlay layers (EXDEV). Build a separate old-schema migration view instead.
    const staged='/tmp/cm-prisma-before-moderation-'+process.pid;
    const prismaRoot=path.join(root,'packages/database/prisma');
    const moderationMigrations=new Set(['202611050001_comment_moderation','202611050002_comment_moderation_notifications','202611050003_comment_moderation_parent_guard']);
    fs.cpSync(prismaRoot,staged,{recursive:true,filter:file=>!path.relative(prismaRoot,file).split(path.sep).some(part=>moderationMigrations.has(part))});
    run(['--filter','@infosound/database','exec','prisma','migrate','deploy','--schema',path.join(staged,'schema.prisma')]);
    const {PrismaClient}=require('/repo/infosound/packages/database/dist/index.js');
    const db=new PrismaClient({datasources:{db:{url}},log:[]});
    const {randomUUID}=require('node:crypto');
    const ids={author:randomUUID(),track:randomUUID(),asset:randomUUID(),comment:randomUUID()};
    await db.$transaction(async tx=>{
      await tx.user.create({data:{id:ids.author,role:'AUTHOR',displayName:'Synthetic legacy migration'}});
      await tx.track.create({data:{id:ids.track,authorId:ids.author,title:'Synthetic legacy migration',duration:120}});
      await tx.trackAsset.create({data:{id:ids.asset,trackId:ids.track,sourceVersion:1,pipelineVersion:1,kind:'PLAYBACK',bucket:'audio-playback',key:'synthetic-legacy-only',size:1n,contentType:'audio/flac',verified:true}});
      await tx.track.update({where:{id:ids.track},data:{processingState:'READY',publicationState:'PUBLISHED',playbackAssetId:ids.asset}});
      await tx.$executeRaw`INSERT INTO track_comments(id,track_id,user_id,source_version,body,at_seconds) VALUES(${ids.comment}::uuid,${ids.track}::uuid,${ids.author}::uuid,1,'Synthetic legacy comment',0)`;
    });
    await db.$disconnect();fs.writeFileSync('/tmp/cm-legacy-ids.json',JSON.stringify(ids));
  }
  run(['--filter','@infosound/database','migrate']);
  run(['--filter','@infosound/comment-moderation','build']);
  run(['--filter','@infosound/comment-moderation','test:integration']);
})().catch(error=>{process.stderr.write(JSON.stringify({event:'ISOLATED_TEST_SETUP_FAILED',code:typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'INTERNAL_ERROR'})+'\n');process.exitCode=1;});
