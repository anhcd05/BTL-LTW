[CmdletBinding()]
param([ValidateSet('before-build','before-cutover')][string]$Label='before-cutover')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../infosound/scripts/local-runtime.ps1')
$ctx=Get-InfoSoundLocalRuntime
$workspace=Split-Path $ctx.SourceRoot -Parent
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
$snapshot=Join-Path $workspace ('.runtime-private/comment-moderation-rollout/'+$stamp+'-'+$Label)
New-Item -ItemType Directory -Path $snapshot -Force | Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $snapshot /inheritance:r /grant:r ($identity+':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict backup directory.'}
$dump='/tmp/comment-moderation-'+$stamp+'.dump'
$roles='/tmp/comment-moderation-'+$stamp+'-roles.sql'
Invoke-InfoSoundLocalDocker -Context $ctx -Arguments @('exec','infosound-local-postgres-1','sh','-c',('umask 077; exec pg_dump -U postgres -d infosound -Fc -f '+$dump))
Invoke-InfoSoundLocalDocker -Context $ctx -Arguments @('exec','infosound-local-postgres-1','sh','-c',('umask 077; exec pg_dumpall -U postgres --roles-only --file='+$roles))
Invoke-InfoSoundLocalDocker -Context $ctx -Arguments @('cp',('infosound-local-postgres-1:'+$dump),(Join-Path $snapshot 'database.dump'))
Invoke-InfoSoundLocalDocker -Context $ctx -Arguments @('cp',('infosound-local-postgres-1:'+$roles),(Join-Path $snapshot 'roles.sql'))
$archive=& $ctx.Docker --context desktop-linux exec infosound-local-postgres-1 pg_restore --list $dump
if($LASTEXITCODE -ne 0 -or !$archive){throw 'Backup archive verification failed.'}
$archive | Set-Content -LiteralPath (Join-Path $snapshot 'archive-list.txt') -Encoding utf8
$images=@{}
foreach($service in @('api','background-worker','web','audio-worker','gateway','postgres','redis','storage')){
  $image=& $ctx.Docker --context desktop-linux inspect ('infosound-local-'+$service+'-1') --format '{{.Image}}'
  if($LASTEXITCODE -ne 0){throw 'Could not capture current image.'};$images[$service]=[string]$image
}
$images | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $snapshot 'images.json') -Encoding utf8
$summary=@'
SELECT json_build_object('users',(SELECT count(*) FROM users),'tracks',(SELECT count(*) FROM tracks),'assets',(SELECT count(*) FROM track_assets),'comments',(SELECT count(*) FROM track_comments),'replies',(SELECT count(*) FROM track_comments WHERE parent_id IS NOT NULL),'migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),'users_hash',(SELECT md5(coalesce(string_agg(to_jsonb(u)::text,'|' ORDER BY u.id),'')) FROM users u),'tracks_hash',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),'')) FROM tracks t),'assets_hash',(SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'|' ORDER BY a.id),'')) FROM track_assets a));
'@
$manifest=$summary | & $ctx.Docker --context desktop-linux exec -i infosound-local-postgres-1 psql -U postgres -d infosound -At -v ON_ERROR_STOP=1
if($LASTEXITCODE -ne 0){throw 'Could not record backup manifest.'}
$manifest | Set-Content -LiteralPath (Join-Path $snapshot 'counts.json') -Encoding utf8
$volumes=& $ctx.Docker --context desktop-linux volume ls --filter label=com.docker.compose.project=infosound-local --format '{{.Name}}'
if($LASTEXITCODE -ne 0 -or @($volumes).Count -ne 4){throw 'Expected exactly four existing application volumes.'}
$volumes | Sort-Object | Set-Content -LiteralPath (Join-Path $snapshot 'volumes.txt') -Encoding utf8
$checks=@{}
foreach($name in @('database.dump','roles.sql','archive-list.txt','images.json','counts.json','volumes.txt')){
  $file=Join-Path $snapshot $name;if((Get-Item -LiteralPath $file).Length -eq 0){throw 'Empty backup artifact.'};$checks[$name]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $snapshot 'checksums.json') -Encoding utf8
[pscustomobject]@{status='PASS';label=$Label;archive_verified=$true;snapshot=$snapshot} | ConvertTo-Json -Compress
