[CmdletBinding()]
param([string]$ModuleEnvFile=(Join-Path $PSScriptRoot '../.env'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../infosound/scripts/local-runtime.ps1')
$ctx=Get-InfoSoundLocalRuntime
$selected=@{}
foreach($line in [IO.File]::ReadLines([IO.Path]::GetFullPath($ModuleEnvFile))){
  if($line -match '^\s*(?:export\s+)?(GEMINI_API_KEY)\s*=(.*)$'){
    $name=$Matches[1];$value=$Matches[2].Trim()
    if($selected.ContainsKey($name)){throw 'Duplicate selected configuration variable.'}
    if($value.Length -ge 2 -and (($value[0] -eq [char]34 -and $value[$value.Length-1] -eq [char]34) -or ($value[0] -eq [char]39 -and $value[$value.Length-1] -eq [char]39))){$value=$value.Substring(1,$value.Length-2)}
    $selected[$name]=$value
  }
}
if(!$selected.ContainsKey('GEMINI_API_KEY') -or [string]::IsNullOrWhiteSpace($selected['GEMINI_API_KEY'])){throw 'GEMINI_API_KEY is missing in the selected module environment file.'}
if($selected['GEMINI_API_KEY'] -match '\s'){throw 'Selected key contains whitespace; save one plain key value.'}
if($ctx.Values.ContainsKey('GEMINI_MODEL') -and $ctx.Values['GEMINI_MODEL'] -cne 'gemini-2.5-flash-lite'){throw 'Runtime model differs from the authorized default; no configuration was changed.'}
$updated=New-Object 'Collections.Generic.List[string]'
$replaced=$false
foreach($line in [IO.File]::ReadLines($ctx.RuntimeFile)){
  if($line -match '^\s*GEMINI_API_KEY\s*='){$updated.Add('GEMINI_API_KEY='+$selected['GEMINI_API_KEY']);$replaced=$true}else{$updated.Add($line)}
}
if(!$replaced){$updated.Add('GEMINI_API_KEY='+$selected['GEMINI_API_KEY'])}
$suffix=[guid]::NewGuid().ToString('N')
$temp=Join-Path $ctx.RuntimeRoot ('runtime-key-'+$suffix+'.tmp')
$backup=Join-Path $ctx.RuntimeRoot ('runtime-before-moderation-key-'+$suffix+'.env')
New-Item -ItemType File -Path $temp | Out-Null
Set-Acl -LiteralPath $temp -AclObject (Get-Acl -LiteralPath $ctx.RuntimeFile)
[IO.File]::WriteAllLines($temp,$updated,(New-Object Text.UTF8Encoding($false)))
[IO.File]::Replace($temp,$ctx.RuntimeFile,$backup)
$selected.Clear();$updated.Clear()
[pscustomobject]@{status='PASS';key_present=$true;runtime_file=$ctx.RuntimeFile;model_changed=$false;budgets_changed=$false;worker_recreate_required=$true} | ConvertTo-Json -Compress
