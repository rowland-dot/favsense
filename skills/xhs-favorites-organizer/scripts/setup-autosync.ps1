[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),

    [Parameter()]
    [int]$Port = 47631
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$stateDirectory = Join-Path $workspacePath '.xhs-favorites'
$tokenPath = Join-Path $stateDirectory 'bridge-token'
$userscriptPath = Join-Path $stateDirectory 'xhs-favorites.user.js'
$templatePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\xhs-favorites.user.js.template'

[System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    $token = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    [System.IO.File]::WriteAllText($tokenPath, $token, [System.Text.UTF8Encoding]::new($false))
}

$configPath = [System.IO.Path]::GetFullPath($Config)
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$boardMap = [ordered]@{}
foreach ($board in @($configObject.boards | Where-Object { $_.enabled -eq $true })) {
    $boardMap[[string]$board.id] = [ordered]@{
        name = [string]$board.name
        count = [int]$board.advertised_count
    }
}
if ($boardMap.Count -eq 0) { throw 'Configuration does not contain enabled boards.' }
$token = [System.IO.File]::ReadAllText($tokenPath).Trim()
$template = [System.IO.File]::ReadAllText($templatePath)
$userscript = $template.Replace('__PORT__', [string]$Port).Replace('__TOKEN__', $token).Replace('__BOARDS__', ($boardMap | ConvertTo-Json -Compress))
[System.IO.File]::WriteAllText($userscriptPath, $userscript, [System.Text.UTF8Encoding]::new($false))

$localRuntimeDirectory = Join-Path $workspacePath 'site\.local'
$localRuntimePath = Join-Path $localRuntimeDirectory 'bridge.json'
[System.IO.Directory]::CreateDirectory($localRuntimeDirectory) | Out-Null
$localRuntime = [ordered]@{
    baseUrl = "http://127.0.0.1:$Port"
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($localRuntimePath, $localRuntime, [System.Text.UTF8Encoding]::new($false))

& (Join-Path $PSScriptRoot 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath -Port $Port
& (Join-Path $PSScriptRoot 'install-windows-task.ps1') -Workspace $workspacePath -Config $configPath

Write-Output "FavSense local service and daily task are ready."
Write-Output "One browser step remains: open http://127.0.0.1:$Port/xhs-favorites.user.js in regular Chrome and confirm installation in Tampermonkey."
Write-Output "Automatic sync starts after the userscript is installed."
