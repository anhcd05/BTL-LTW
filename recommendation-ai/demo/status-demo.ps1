[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'demo-runtime.ps1')
$context = Get-RecoDemoContext
Invoke-RecoDemoCompose -Context $context -Arguments @('ps','--all')
$running = Invoke-RecoDemoComposeOutput -Context $context -Arguments @('ps','--status','running','--services')
if ($running -contains 'postgres') {
    $sql = "select count(*) filter (where finished_at is not null and rolled_back_at is null) || ' applied, latest ' || coalesce(max(migration_name),'-') from _prisma_migrations"
    Write-Output ('Migrations: ' + (Invoke-RecoDemoComposeOutput -Context $context -Arguments @('exec','-T','postgres','psql','-U','postgres','-d','infosound','-Atc',$sql)))
}
if ($running -contains 'storage') {
    $js = "const {S3Client,ListBucketsCommand}=require('/repo/infosound/packages/storage/node_modules/@aws-sdk/client-s3');" +
          "const fs=require('fs');const r=f=>fs.readFileSync(process.env[f],'utf8').trim();" +
          "new S3Client({endpoint:process.env.S3_INTERNAL_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:r('S3_BOOTSTRAP_ACCESS_KEY_FILE'),secretAccessKey:r('S3_BOOTSTRAP_SECRET_KEY_FILE')}})" +
          ".send(new ListBucketsCommand({})).then(o=>console.log('Buckets: '+o.Buckets.map(b=>b.Name).sort().join(', ')))"
    Invoke-RecoDemoCompose -Context $context -Arguments @('--profile','tools','run','--rm','--no-deps','--interactive=false','-T','tools','node','-e',$js)
}
# TLS check with the project CA trusted (no verification bypass).
$ca = Join-Path $context.SecretsRoot 'ca.crt'
foreach ($url in @(($context.Values['APP_ORIGIN'] + '/gateway-health'), ($context.Values['APP_ORIGIN'] + '/health/ready'), ($context.Values['APP_ORIGIN'] + '/'))) {
    # Chain + hostname are verified against the project CA; only the Schannel online revocation lookup (impossible for
    # a private CA without CRL/OCSP) is skipped.
    $code = & "$env:SystemRoot\System32\curl.exe" -sS -o NUL -w '%{http_code}' --ssl-no-revoke --cacert $ca $url
    Write-Output ("{0} -> HTTP {1} (curl exit {2})" -f $url, $code, $LASTEXITCODE)
}
