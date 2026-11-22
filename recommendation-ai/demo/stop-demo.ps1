[CmdletBinding()]
param(
    # Also delete the demo containers and the four infosound-demo_* named volumes (synthetic data only).
    [switch]$RemoveVolumes
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'demo-runtime.ps1')
$context = Get-RecoDemoContext
# Only ever addresses --project-name infosound-demo; the real infosound-local stack is never stopped here.
if ($RemoveVolumes) {
    Invoke-RecoDemoCompose -Context $context -Arguments @('--profile','tools','down','--volumes','--remove-orphans','--timeout','60')
    Write-Output 'InfoSound demo removed (containers, networks, infosound-demo_* volumes). Images :reco and secrets kept.'
} else {
    Invoke-RecoDemoCompose -Context $context -Arguments @('stop','--timeout','60')
    Write-Output 'InfoSound demo stopped. Demo volumes kept; real stack untouched.'
}
