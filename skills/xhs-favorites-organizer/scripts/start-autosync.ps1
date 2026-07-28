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
$xhsDirectory = Join-Path $workspacePath '.xhs-tools\XHS-Downloader'
$pythonPath = Join-Path $xhsDirectory '.venv\Scripts\python.exe'
$bridgePath = Join-Path $PSScriptRoot 'bridge-server.py'
$stateDirectory = Join-Path $workspacePath '.xhs-favorites'
$tokenPath = Join-Path $stateDirectory 'bridge-token'
$healthUrl = "http://127.0.0.1:$Port/health"

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "XHS-Downloader virtual environment was not found: $pythonPath"
}
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw 'The local bridge is not configured. Run setup-autosync.ps1 once.'
}
$token = [System.IO.File]::ReadAllText($tokenPath).Trim()
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $hash = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token))
    $expectedConfigId = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
} finally {
    $sha256.Dispose()
}
$configPath = [System.IO.Path]::GetFullPath($Config)
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Configuration was not found: $configPath"
}
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$expectedBoardIds = @($configObject.boards | Where-Object { $_.enabled -eq $true } | ForEach-Object { [string]$_.id })
if ($expectedBoardIds.Count -eq 0) { throw 'Configuration does not contain enabled boards.' }
$expectedProtocolVersion = 4
$healthHeaders = @{ 'X-XHS-Bridge-Token' = $token }

function Get-ExpectedBridgeHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Headers $healthHeaders -TimeoutSec 2
    } catch {
        return $null
    }
    if (
        -not $response.ok -or
        $response.protocol_version -ne $expectedProtocolVersion -or
        $response.config_id -ne $expectedConfigId -or
        (@($response.board_ids) -join ',') -ne ($expectedBoardIds -join ',')
    ) {
        throw "Port $Port is occupied by a different or stale local service."
    }
    return $response
}

$health = Get-ExpectedBridgeHealth
if ($health) {
    Write-Output "Bridge already running: $healthUrl"
    return
}

$arguments = @(
    '-X', 'utf8', $bridgePath,
    '--workspace', $workspacePath,
    '--skill-dir', (Split-Path -Parent $PSScriptRoot),
    '--config', $configPath,
    '--port', [string]$Port
)
$nativeArguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
$process = Start-Process -FilePath $pythonPath -ArgumentList $nativeArguments -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
        throw "The local bridge exited during startup with code $($process.ExitCode)."
    }
    $health = Get-ExpectedBridgeHealth
    if ($health) {
        Write-Output "Bridge started: $healthUrl"
        return
    }
}
throw 'The local bridge did not become ready within 5 seconds.'
