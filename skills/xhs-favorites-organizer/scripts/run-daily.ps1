[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),
    [Parameter()][ValidateSet('daily', 'history')][string]$Mode = 'daily',
    [Parameter()][string]$NoteId = '',
    [Parameter()][int]$Port = 47631,
    [Parameter()][string]$SopRuntime = ''
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
$sopRuntimePath = if ([string]::IsNullOrWhiteSpace($SopRuntime)) {
    Join-Path (Split-Path -Parent $workspacePath) 'SOP - 小红书'
} else {
    [System.IO.Path]::GetFullPath($SopRuntime)
}
& (Join-Path $PSScriptRoot 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath -Port $Port -SopRuntime $sopRuntimePath

$tokenPath = Join-Path $workspacePath '.xhs-favorites\bridge-token'
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw 'The local bridge is not configured. Run setup-autosync.ps1 once.'
}
$tokenItem = Get-Item -LiteralPath $tokenPath -Force
if (($tokenItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The local bridge token is redirected. Run setup-autosync.ps1 again.'
}
$token = [System.IO.File]::ReadAllText($tokenPath)
if ($token -cnotmatch '^[a-f0-9]{64}$') {
    throw 'The local bridge token is invalid. Run setup-autosync.ps1 again.'
}
$headers = @{
    'X-XHS-Bridge-Token' = $token
    'Origin' = 'http://127.0.0.1:8766'
}
if ($NoteId -and $NoteId -notmatch '^[a-f0-9]{24}$') {
    throw 'NoteId must use a supported note identifier.'
}
$bridgeMode = if ($Mode -eq 'history') { 'history' } else { 'incremental' }
$body = if ($NoteId) {
    @{ note_id = $NoteId } | ConvertTo-Json -Compress
} else {
    @{ mode = $bridgeMode } | ConvertTo-Json -Compress
}
$status = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/sync/start" `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json' `
    -Body $body `
    -TimeoutSec 15
$requestLabel = if ($NoteId) { 'single-note validation' } else { "$bridgeMode sync" }
Write-Output "FavSense requested a user-triggered $requestLabel in the shared SOP scanner browser. Monitor progress in the local workbench."
