[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),
    [Parameter()][ValidateSet('daily', 'history')][string]$Mode = 'daily',
    [Parameter()][int]$Port = 47631
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
& (Join-Path $PSScriptRoot 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath -Port $Port

$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$firstBoard = @($configObject.boards | Where-Object { $_.enabled -eq $true })[0]
if (-not $firstBoard) { throw 'Configuration does not contain enabled boards.' }
$batch = [DateTimeOffset]::Now.ToString('yyyyMMddHHmmss')
$url = "https://www.xiaohongshu.com/board/$($firstBoard.id)?source=web_user_page&xhs_kb_sync=1&xhs_kb_batch=$batch&xhs_kb_mode=$Mode"

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found.' }
Start-Process -FilePath $chrome -ArgumentList @($url)
Write-Output "Started portable XHS sync batch $batch in $Mode mode."
