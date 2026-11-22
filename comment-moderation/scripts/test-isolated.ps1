param([string]$ToolsImage='infosound/tools:local',[string]$PostgresImage='infosound/postgres:local')
$ErrorActionPreference='Stop'
if ((docker context show) -ne 'desktop-linux') { throw 'Docker Desktop Linux context required.' }
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runId=(Get-Date -Format 'yyyyMMddHHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
$network='infosound-moderation-test-'+$runId
$postgres='infosound-moderation-pg-'+$runId
$dev='infosound-moderation-dev-'+$runId
$private=Join-Path $workspace ('.runtime-private/comment-moderation-tests/'+$runId)
New-Item -ItemType Directory -Path $private -Force | Out-Null
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $private /inheritance:r /grant:r ($identity+':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect private test directory.' }
docker network create $network | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated test network.' }
$boot=Join-Path $workspace 'comment-moderation/scripts/test-postgres-init.sh'
docker run --detach --name $postgres --network $network --network-alias infosound-moderation-pg2 --env POSTGRES_USER=moderation_test_owner --env POSTGRES_DB=moderation_test --mount "type=bind,source=$boot,target=/boot.sh,readonly" --entrypoint sh $PostgresImage /boot.sh | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated PostgreSQL.' }
docker run --detach --name $dev --network $network --user root --mount "type=bind,source=$workspace/infosound,target=/source/infosound,readonly" --mount "type=bind,source=$workspace/comment-moderation,target=/source/comment-moderation,readonly" --entrypoint sleep $ToolsImage infinity | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated tools container.' }
$ready=$false
for($attempt=0;$attempt -lt 30;$attempt++) { docker exec $postgres pg_isready -h 127.0.0.1 -U moderation_test_owner -d moderation_test *> $null; if($LASTEXITCODE -eq 0){$ready=$true;break}; Start-Sleep -Seconds 1 }
if(!$ready){throw 'Isolated PostgreSQL not ready; resources retained for diagnosis.'}
docker exec $postgres psql -U moderation_test_owner -d moderation_test -c 'CREATE ROLE infosound_api NOLOGIN; CREATE ROLE infosound_audio NOLOGIN; CREATE ROLE infosound_background NOLOGIN;'
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare isolated runtime roles.' }
$secretPath=Join-Path $private 'postgres-password'
docker cp ($postgres+':/tmp/moderation-test-password') $secretPath
docker cp $secretPath ($dev+':/tmp/moderation-test-password')
if ($LASTEXITCODE -ne 0) { throw 'Could not transfer private isolated credential.' }
docker exec $dev node /source/comment-moderation/scripts/prepare-isolated-workspace.cjs
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare isolated source copy.' }
docker exec --workdir /repo/infosound $dev pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Isolated dependency install failed.' }
docker exec $dev node /source/comment-moderation/scripts/test-runtime.cjs --setup
$result=$LASTEXITCODE
@{dev=$dev;postgres=$postgres;network=$network;exitCode=$result} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $private 'resources.json')
Write-Output ('Test resources retained: '+$dev+', '+$postgres+', '+$network)
Write-Output ('Private resource manifest: '+(Join-Path $private 'resources.json'))
if($result -ne 0){throw 'Isolated integration tests failed. No live database was touched.'}
