[CmdletBinding()]
param()
# Regenerates infosound/pnpm-lock.yaml INSIDE a Linux container (never with host pnpm), from an LF snapshot of the
# current working tree, then copies back only the lockfile. Requires registry access from Docker.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'demo-runtime.ps1')
$paths = Get-RecoDemoPaths
$docker = Get-RecoDemoDocker
foreach ($manifest in @('recommendation-ai\package.json','recommendation-ai\batch\package.json')) {
    if (!(Test-Path -LiteralPath (Join-Path $paths.RepoRoot $manifest))) { throw "$manifest is missing; the lockfile would be incomplete." }
}
$source = New-RecoDemoBuildSource
$stage = Split-Path $source -Parent
$nodeImage = ((Get-Content -LiteralPath (Join-Path $paths.SourceRoot 'images.env') | Where-Object { $_ -like 'NODE_IMAGE=*' }) -replace '^NODE_IMAGE=','').Trim()
& $docker --context desktop-linux run --rm --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --memory 2g `
    --mount ('type=bind,source=' + $stage + ',target=/repo') --workdir /repo/infosound --env HOME=/tmp --env npm_config_cache=/tmp/npm `
    --entrypoint sh $nodeImage -c 'set -eu; npm install --silent --prefix /tmp/pnpm pnpm@10.34.9; /tmp/pnpm/node_modules/.bin/pnpm install --lockfile-only --config.store-dir=/tmp/store'
if ($LASTEXITCODE -ne 0) { throw 'pnpm --lockfile-only failed inside the Linux container.' }
Copy-Item -LiteralPath (Join-Path $source 'pnpm-lock.yaml') -Destination (Join-Path $paths.SourceRoot 'pnpm-lock.yaml') -Force
Write-Output 'infosound/pnpm-lock.yaml regenerated in Linux from the LF working-tree snapshot.'
