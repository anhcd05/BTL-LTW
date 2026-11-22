// Disposable test fixture runtime. Never use against a live database.
const fs=require('node:fs');
const {randomBytes,randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const urlFile='/tmp/moderation-test-url';
const url=fs.readFileSync(urlFile,'utf8').trim();
if(new URL(url).pathname!=='/moderation_test')throw new Error('ISOLATED_DATABASE_REQUIRED');
const secret=()=>randomBytes(32).toString('hex');
const env={...process.env,DATABASE_URL_FILE:urlFile,APP_ORIGIN:'https://localhost:3453',LOCAL_APP_ORIGIN:'https://localhost:3453',LAN_APP_ORIGIN:'',JWT_SECRET:secret(),REDIS_PASSWORD:secret(),REDIS_HOST:'127.0.0.1',OTP_SECRET:secret(),MAIL_ENCRYPTION_KEY:secret(),EMAIL_ENABLED:'false',MODERATION_AI_ENABLED:'false',S3_INTERNAL_ENDPOINT:'http://127.0.0.1:1',S3_PUBLIC_ENDPOINT:'https://localhost:3453/media'};
for(const role of ['UPLOAD','READ','API']){env['S3_'+role+'_ACCESS_KEY']=secret();env['S3_'+role+'_SECRET_KEY']=secret();}
Object.assign(process.env,env);
fs.cpSync('/source/infosound/apps/api/src','/repo/infosound/apps/api/src',{recursive:true});
fs.cpSync('/source/comment-moderation/src','/repo/comment-moderation/src',{recursive:true});
if(!process.argv.includes('--skip-build')){const build=spawnSync('pnpm',['--filter','@infosound/api...','build'],{cwd:'/repo/infosound',env,stdio:'inherit'});if(build.status!==0)process.exit(build.status??1);}
(async()=>{
  const fixtureFile='/tmp/cm-browser-fixtures-v2.json';
  if(process.argv.includes('--reuse-fixtures')&&fs.existsSync(fixtureFile)){process.stdout.write('ISOLATED_API_FIXTURES_READY\n');require('/repo/infosound/apps/api/dist/main.js');return;}
  const {PrismaClient}=require('/repo/infosound/packages/database/dist/index.js');
  const argon2=require('/repo/infosound/apps/api/node_modules/argon2');
  const db=new PrismaClient({datasources:{db:{url}},log:[]});
  const authorId=randomUUID();
  const fixture={user:{id:randomUUID(),email:'synthetic-user-'+randomUUID()+'@example.invalid',password:secret()},moderator:{id:randomUUID(),email:'synthetic-mod-'+randomUUID()+'@example.invalid',password:secret()},author:{id:authorId,email:'synthetic-author-'+randomUUID()+'@example.invalid',password:secret()},otherAuthor:{id:randomUUID(),email:'synthetic-other-author-'+randomUUID()+'@example.invalid',password:secret()},authorId,trackId:randomUUID(),assetId:randomUUID(),origin:env.APP_ORIGIN,legacyComments:{}};
  for(const kind of ['user','moderator','author','otherAuthor']){const u=fixture[kind];await db.user.create({data:{id:u.id,email:u.email,passwordHash:await argon2.hash(u.password),role:kind==='author'||kind==='otherAuthor'?'AUTHOR':'USER',displayName:'Synthetic '+kind}});}
  for(const permission of ['moderation.read','moderation.review','moderation.retry'])await db.$executeRaw`INSERT INTO comment_moderation_permissions(user_id,permission) VALUES(${fixture.moderator.id}::uuid,${permission})`;
  await db.$transaction(async tx=>{
    await tx.track.create({data:{id:fixture.trackId,authorId:fixture.authorId,title:'Synthetic moderation website test',duration:120}});
    await tx.trackAsset.create({data:{id:fixture.assetId,trackId:fixture.trackId,sourceVersion:1,pipelineVersion:1,kind:'PLAYBACK',bucket:'audio-playback',key:'synthetic-browser-only',size:1n,contentType:'audio/flac',verified:true}});
    await tx.track.update({where:{id:fixture.trackId},data:{processingState:'READY',publicationState:'PUBLISHED',playbackAssetId:fixture.assetId}});
    // Explicit historical visible fixtures exercise deletion UI. These are not
    // fabricated successful AI assessments, and no provider is called here.
    const legacy=async(key,userId,body,parentId=null)=>{const id=randomUUID();await tx.trackComment.create({data:{id,trackId:fixture.trackId,userId,sourceVersion:1,body,parentId,atSeconds:0,moderationStatus:'VISIBLE',decisionSource:'LEGACY'}});fixture.legacyComments[key]={id,body};return id;};
    const userRoot=await legacy('userRoot',fixture.user.id,'Bình luận cũ tổng hợp của USER để thử xóa cả trả lời.');
    await legacy('userChildByAuthor',fixture.author.id,'Trả lời cũ tổng hợp của chủ bài nhạc.',userRoot);
    await legacy('userChildByOther',fixture.otherAuthor.id,'Trả lời cũ tổng hợp của một người khác.',userRoot);
    const foreignRoot=await legacy('foreignRoot',fixture.otherAuthor.id,'Bình luận cũ tổng hợp của khách dưới bài nhạc AUTHOR.');
    await legacy('foreignChildByUser',fixture.user.id,'Trả lời cũ tổng hợp cần đi theo bình luận cha.',foreignRoot);
    await legacy('foreignChildByAuthor',fixture.author.id,'Trả lời cũ tổng hợp để xác minh xóa dây chuyền.',foreignRoot);
  });
  fs.writeFileSync(fixtureFile,JSON.stringify(fixture),{mode:0o600});
  await db.$disconnect();process.stdout.write('ISOLATED_API_FIXTURES_READY\n');
  require('/repo/infosound/apps/api/dist/main.js');
})().catch(error=>{process.stderr.write(JSON.stringify({event:'ISOLATED_API_SETUP_FAILED',name:error?.name,code:error?.code,frames:typeof error?.stack==='string'?error.stack.split('\n').slice(1,6):[]})+'\n');process.exitCode=1;});
