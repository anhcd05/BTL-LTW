[CmdletBinding()]
param(
    # Batch pipeline (DESIGN.md section 6). Run a subset with e.g. -Steps embed,train
    [ValidateSet('seed','embed','train','evaluate')][string[]]$Steps = @('seed','embed','train','evaluate'),
    # Batch CLI inside the demo tools image (package @infosound/recommendation-batch).
    [string]$Cli = '/repo/recommendation-ai/batch/dist/cli.js',
    # Extra arguments appended to every step (e.g. --seed 42).
    [string[]]$ExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'demo-runtime.ps1')
$context = Get-RecoDemoContext
$running = Invoke-RecoDemoComposeOutput -Context $context -Arguments @('ps','--status','running','--services')
if (-not ($running -contains 'postgres')) { throw 'The demo stack is not running. Run recommendation-ai\demo\start-demo.ps1 first.' }
foreach ($step in $Steps) {
    Write-Output "== reco batch: $step (infosound-demo tools, RECO_DEMO=1)"
    # Owner DB URL + S3 keys come from compose.reco-demo.yaml; reports land in recommendation-ai/reports/.
    Invoke-RecoDemoCompose -Context $context -Arguments (@('--profile','tools','run','--rm','--no-deps','--interactive=false','-T',
        '-e','RECO_DEMO=1','tools','node',$Cli,$step) + $ExtraArgs)
}
Write-Output 'Demo batch pipeline finished. Reports: recommendation-ai\reports\'
