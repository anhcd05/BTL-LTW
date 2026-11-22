[CmdletBinding()]
param(
    # Presentation day: use https://localhost:3443 / :9443. Requires that YOU stopped the real stack first.
    [switch]$StandardPorts,
    # Reuse existing infosound/*:reco images instead of rebuilding them.
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'demo-runtime.ps1')

$mode = if ($StandardPorts) { 'standard' } else { 'alternate' }
$paths = Initialize-RecoDemoRuntime -PortMode $mode
$context = Get-RecoDemoContext
Assert-RecoDemoPortsUsable -Context $context
$localBefore = Get-RecoDemoLocalImageIds -Docker $context.Docker

if (!$NoBuild) {
    # Tags come from compose.reco-demo.yaml (infosound/*:reco); the real :local images are not rebuilt.
    # Build from an LF snapshot of the working tree (CRLF checkout breaks Linux-side checks); runtime bind mounts
    # (migrations, grants, scripts, reports) still come from the real working tree.
    $buildContext = $context.PSObject.Copy()
    $buildContext.SourceRoot = New-RecoDemoBuildSource
    # One service at a time: parallel builds have exhausted Docker Desktop memory on this machine.
    foreach ($service in $script:RecoDemoBuildServices) {
        try { Invoke-RecoDemoCompose -Context $buildContext -Arguments @('--profile','tools','build',$service) }
        catch {
            # Docker Desktop's containerd snapshotter intermittently fails to unpack a freshly exported image
            # ("failed to prepare extraction snapshot ... parent snapshot ... not found"); layers are cached, retry once.
            Write-Warning "Build of $service failed once; retrying."
            Invoke-RecoDemoCompose -Context $buildContext -Arguments @('--profile','tools','build',$service)
        }
    }
}

# Fresh demo credentials, generated once by the stock init-secrets.py inside a Linux container.
# init-secrets.py only accepts its historical local target, so it runs against an in-container tmpfs that matches
# that target; new files are then copied into the demo secrets directory. Existing files are never overwritten,
# the CA/server certificate copied above is retained, and nothing is printed.
if (!(Test-Path -LiteralPath (Join-Path $paths.SecretsRoot 'database_url_owner'))) {
    $secretsMount = 'type=bind,source=' + $paths.SecretsRoot + ',target=/out'
    $script = 'set -eu; for f in ca.crt server.crt server.key; do cp /out/$f /local-secrets/$f; done; ' +
              'python3 /repo/infosound/scripts/init-secrets.py; ' +
              'for f in /local-secrets/*; do n=${f##*/}; [ -e /out/$n ] || cat "$f" > /out/$n; done'
    Invoke-InfoSoundLocalDocker -Context $context -Arguments @('run','--rm','--pull','never','--network','none','--read-only',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--memory','256m',
        '--tmpfs','/local-secrets:size=4m,mode=0700,uid=1000,gid=1000','--mount',$secretsMount,
        '--env','SECRETS_DIR=/local-secrets','--env','LOCAL_DEPLOYMENT_MODE=true','--env','COMPOSE_PROJECT_NAME=infosound-local',
        '--env','APP_HOST=127.0.0.1','--env','APP_ORIGIN=https://localhost:3443','--env','S3_PUBLIC_ENDPOINT=https://localhost:9443',
        '--env','LOCAL_APP_ORIGIN=https://localhost:3443','--entrypoint','sh','infosound/tools:reco','-c',$script)
}
# Point every demo DB URL at the demo-only Postgres alias (see compose.reco-demo.yaml). Values are not printed.
foreach ($role in @('owner','api','audio','background')) {
    $file = Join-Path $paths.SecretsRoot ('database_url_' + $role)
    $url = [IO.File]::ReadAllText($file)
    if ($url.Contains('@postgres:5432/')) { Write-RecoDemoTextFile -Path $file -Text $url.Replace('@postgres:5432/','@infosound-demo-postgres:5432/') }
}
foreach ($name in @('oauth.json','smtp.json')) {
    # OAuth and SMTP stay disabled in the demo.
    Write-RecoDemoTextFile -Path (Join-Path $paths.SecretsRoot $name) -Text "{}`n"
}
Protect-InfoSoundLocalSecrets -Context $context

# Nginx config for the demo origins/ports (same renderer as the real stack, demo output path).
$generated = $paths.GeneratedRoot
$render = @('run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--user','1000:1000','--memory','256m','--mount',('type=bind,source=' + $paths.SourceRoot + ',target=/workspace,readonly'),
    '--mount',('type=bind,source=' + $generated + ',target=/output'),'--workdir','/workspace','--env','NGINX_OUTPUT=/output/nginx.conf')
foreach ($name in @('APP_HOST','APP_ORIGIN','MEDIA_ORIGIN','APP_HTTP_PORT','APP_HTTPS_PORT','MEDIA_HTTPS_PORT','LOCAL_APP_ORIGIN','LAN_APP_ORIGIN')) {
    $render += @('--env', ($name + '=' + [string]$context.Values[$name]))
}
$render += @('--entrypoint','python3','infosound/tools:reco','scripts/render-config.py')
Invoke-InfoSoundLocalDocker -Context $context -Arguments $render

# Fresh-install order (scripts/up.sh): volume ownership -> data services -> migrations -> buckets -> app.
# init-data.mjs and storage-bootstrap.ts gate on an explicit project name; the demo passes the stock
# non-production name to those two one-shot tools only. Their targets are this project's own volumes/storage.
Invoke-RecoDemoCompose -Context $context -Arguments @('--profile','tools','run','--rm','--no-deps','--interactive=false','-T','-e','COMPOSE_PROJECT_NAME=infosound-test','init-data')
Invoke-RecoDemoCompose -Context $context -Arguments @('up','-d','--no-build','--wait','--wait-timeout','180','postgres','redis','storage')
Invoke-RecoDemoCompose -Context $context -Arguments @('--profile','tools','run','--rm','--no-deps','--interactive=false','-T','tools','pnpm','--filter','@infosound/database','migrate')
Invoke-RecoDemoCompose -Context $context -Arguments @('--profile','tools','run','--rm','--no-deps','--interactive=false','-T','-e','COMPOSE_PROJECT_NAME=infosound-test','tools','node','--experimental-strip-types','scripts/storage-bootstrap.ts')
Invoke-RecoDemoCompose -Context $context -Arguments @('up','-d','--no-build','--remove-orphans','--wait','--wait-timeout','240')
Invoke-RecoDemoCompose -Context $context -Arguments @('exec','--interactive=false','-T','gateway','nginx','-t')
Invoke-RecoDemoCompose -Context $context -Arguments @('ps')

$localAfter = Get-RecoDemoLocalImageIds -Docker $context.Docker
if ($localAfter -cne $localBefore) { Write-Warning 'infosound/*:local image IDs changed during the demo start. Investigate before using the real stack.' }
else { Write-Output 'Real infosound/*:local image IDs unchanged.' }
Write-Output ("InfoSound demo ({0} ports): {1}  media {2}. Next: recommendation-ai\demo\seed-demo.ps1" -f $mode, $context.Values['APP_ORIGIN'], $context.Values['MEDIA_ORIGIN'])
