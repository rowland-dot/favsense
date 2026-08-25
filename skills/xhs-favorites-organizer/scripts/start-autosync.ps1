[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),

    [Parameter()]
    [int]$Port = 47631,

    [Parameter()]
    [string]$SopRuntime = ''
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
$xhsDirectory = Join-Path $workspacePath '.xhs-tools\XHS-Downloader'
$pythonPath = Join-Path $xhsDirectory '.venv\Scripts\python.exe'
$bridgePath = Join-Path $PSScriptRoot 'bridge-server.py'
$stateDirectory = Join-Path $workspacePath '.xhs-favorites'
$tokenPath = Join-Path $stateDirectory 'bridge-token'
$healthUrl = "http://127.0.0.1:$Port/health"
$userscriptTemplatePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\xhs-favorites.user.js.template'
$stopScriptPath = Join-Path $PSScriptRoot 'stop-autosync.ps1'
$sopRuntimePath = if ([string]::IsNullOrWhiteSpace($SopRuntime)) {
    Join-Path (Split-Path -Parent $workspacePath) 'SOP - 小红书'
} else {
    [System.IO.Path]::GetFullPath($SopRuntime)
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Assert-FavSensePlainPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('Directory', 'File')][string]$Kind,
        [Parameter(Mandatory)][string]$Label
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $isDirectory = $null -ne $item -and $item.PSIsContainer
    $isExpectedKind = if ($Kind -eq 'Directory') { $isDirectory } else { $null -ne $item -and -not $isDirectory }
    if ($null -eq $item -or -not $isExpectedKind -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label is unavailable or redirected: $Path"
    }
    return $item
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Runtime fingerprint input was not found: $Path"
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $digest = $algorithm.ComputeHash($bytes)
        return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-SopBrowserChannelId {
    param([Parameter(Mandatory)][string]$RuntimePath)
    $normalizedPath = [System.IO.Path]::GetFullPath($RuntimePath).TrimEnd('\', '/').ToLowerInvariant()
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedPath))
        return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Resolve-SopRuntimeChannel {
    param([Parameter(Mandatory)][string]$RuntimePath)
    $runtimeFullPath = [System.IO.Path]::GetFullPath($RuntimePath).TrimEnd('\', '/')
    $secretsPath = Join-Path $runtimeFullPath '.secrets'
    $profilePath = Join-Path $secretsPath 'browser-profiles\cdp-chrome'
    $portFilePath = Join-Path $secretsPath 'cdp-port.txt'
    $scriptsPath = Join-Path $runtimeFullPath 'scripts'
    $launcherPath = Join-Path $scriptsPath '启动扫描浏览器.bat'
    foreach ($candidate in @($runtimeFullPath, $secretsPath, (Join-Path $secretsPath 'browser-profiles'), $profilePath, $scriptsPath)) {
        $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
        if ($null -eq $item -or -not $item.PSIsContainer -or
            (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "The shared SOP browser runtime is unavailable: $candidate"
        }
    }
    $launcherItem = Get-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $launcherItem -or $launcherItem.PSIsContainer -or
        (($launcherItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'The SOP scanner browser launcher is unavailable.'
    }
    $portItem = Get-Item -LiteralPath $portFilePath -Force -ErrorAction SilentlyContinue
    if ($portItem -and ($portItem.PSIsContainer -or
        (($portItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0))) {
        throw 'The SOP CDP port registry is redirected or invalid.'
    }
    return [pscustomobject]@{
        RuntimePath = $runtimeFullPath
        PortFilePath = $portFilePath
        LauncherPath = $launcherPath
    }
}

function Get-SopRuntimeCdpPort {
    param([Parameter(Mandatory)][string]$PortFilePath)
    if (-not (Test-Path -LiteralPath $PortFilePath -PathType Leaf)) { throw 'The SOP CDP port registry is unavailable.' }
    $lines = @([System.IO.File]::ReadAllLines($PortFilePath, [System.Text.Encoding]::ASCII))
    $portValue = 0
    if ($lines.Count -ne 1 -or -not [int]::TryParse($lines[0].Trim(), [ref]$portValue) -or
        $portValue -lt 1024 -or $portValue -gt 65535) {
        throw 'The SOP CDP port registry is invalid.'
    }
    return $portValue
}

function Test-SopRuntimeCdpEndpoint {
    param([Parameter(Mandatory)][object]$Channel)
    try {
        $cdpPort = Get-SopRuntimeCdpPort -PortFilePath $Channel.PortFilePath
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 1
        $webSocket = [uri]([string]$version.webSocketDebuggerUrl)
        return $webSocket.Scheme -eq 'ws' -and
            $webSocket.Host -in @('127.0.0.1', 'localhost') -and
            $webSocket.Port -eq $cdpPort -and
            $webSocket.AbsolutePath -match '^/devtools/browser/[A-Za-z0-9._-]{1,160}$' -and
            [string]::IsNullOrEmpty($webSocket.Query) -and
            [string]::IsNullOrEmpty($webSocket.Fragment) -and
            [string]::IsNullOrEmpty($webSocket.UserInfo)
    } catch {
        return $false
    }
}

function Ensure-SopRuntimeCdpEndpoint {
    param(
        [Parameter(Mandatory)][object]$Channel,
        [ValidateRange(1, 100)][int]$Attempts = 40,
        [ValidateRange(1, 10000)][int]$PollMilliseconds = 250
    )
    if (Test-SopRuntimeCdpEndpoint -Channel $Channel) { return }
    Start-Process -FilePath $Channel.LauncherPath -WorkingDirectory (Split-Path -Parent $Channel.LauncherPath) -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
        if (Test-SopRuntimeCdpEndpoint -Channel $Channel) { return }
        if ($attempt + 1 -lt $Attempts) { Start-Sleep -Milliseconds $PollMilliseconds }
    }
    throw 'The SOP scanner browser CDP channel did not become ready within the bounded startup window.'
}

function Get-FavSenseRuntimeId {
    param(
        [Parameter(Mandatory)][string]$WorkspacePath,
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][object]$ConfigObject,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][string]$UserscriptTemplatePath
    )
    $components = [ordered]@{
        config = $ConfigPath
        bridge = $BridgePath
        userscript = $UserscriptTemplatePath
    }
    if ($ConfigObject.diandian -and $ConfigObject.diandian.enabled -eq $true) {
        $configuredSkillPath = [string]$ConfigObject.diandian.skill_path
        if ([string]::IsNullOrWhiteSpace($configuredSkillPath)) {
            throw 'diandian.skill_path is required when diandian is enabled.'
        }
        $skillPath = if ([System.IO.Path]::IsPathRooted($configuredSkillPath)) {
            [System.IO.Path]::GetFullPath($configuredSkillPath)
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $WorkspacePath $configuredSkillPath))
        }
        $components['diandian-release'] = Join-Path $skillPath 'release.json'
        $components['diandian-contract'] = Join-Path $skillPath 'runtime\browser-contract.json'
        $components['diandian-saver'] = Join-Path $skillPath 'scripts\save_diandian_summary.py'
        $releaseObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $components['diandian-release'] | ConvertFrom-Json
        if ($releaseObject.cdp_transport) {
            if ([string]$releaseObject.cdp_transport -ne 'scripts/cdp_transport.py') {
                throw 'DianDian CDP transport metadata is invalid.'
            }
            $components['diandian-cdp-transport'] = Join-Path $skillPath 'scripts\cdp_transport.py'
        }
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('favsense-runtime-v1')
    foreach ($entry in $components.GetEnumerator()) {
        $lines.Add("$($entry.Key):$(Get-FileSha256Hex -Path ([string]$entry.Value))")
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payload = [System.Text.Encoding]::ASCII.GetBytes(($lines -join "`n"))
        $digest = $algorithm.ComputeHash($payload)
        return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

foreach ($runtimeDirectory in @(
    $workspacePath,
    (Join-Path $workspacePath '.xhs-tools'),
    $xhsDirectory,
    (Join-Path $xhsDirectory '.venv'),
    (Join-Path $xhsDirectory '.venv\Scripts'),
    $stateDirectory
)) {
    Assert-FavSensePlainPath -Path $runtimeDirectory -Kind Directory -Label 'FavSense private runtime directory' | Out-Null
}
foreach ($runtimeFile in @($pythonPath, $tokenPath, $configPath, $bridgePath, $userscriptTemplatePath, $stopScriptPath)) {
    Assert-FavSensePlainPath -Path $runtimeFile -Kind File -Label 'FavSense runtime file' | Out-Null
}

$sopChannel = Resolve-SopRuntimeChannel -RuntimePath $sopRuntimePath
Ensure-SopRuntimeCdpEndpoint -Channel $sopChannel
$sopRuntimePath = $sopChannel.RuntimePath

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "XHS-Downloader virtual environment was not found: $pythonPath"
}
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw 'The local bridge is not configured. Run setup-autosync.ps1 once.'
}
$token = [System.IO.File]::ReadAllText($tokenPath)
if ($token -cnotmatch '^[a-f0-9]{64}$') {
    throw 'The local bridge token is invalid. Run setup-autosync.ps1 again.'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $hash = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token))
    $expectedConfigId = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
} finally {
    $sha256.Dispose()
}
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$expectedBoardIds = @($configObject.boards | Where-Object { $_.enabled -eq $true -and $_.available -ne $false } | ForEach-Object { [string]$_.id })
$expectedProtocolVersion = 11
$expectedBrowserChannelId = Get-SopBrowserChannelId -RuntimePath $sopRuntimePath
$expectedRuntimeId = Get-FavSenseRuntimeId `
    -WorkspacePath $workspacePath `
    -ConfigPath $configPath `
    -ConfigObject $configObject `
    -BridgePath $bridgePath `
    -UserscriptTemplatePath $userscriptTemplatePath
$healthHeaders = @{ 'X-XHS-Bridge-Token' = $token }

function Get-BridgeHealth {
    try {
        return Invoke-RestMethod -Uri $healthUrl -Headers $healthHeaders -TimeoutSec 2
    } catch {
        return $null
    }
}

function Test-ExpectedBridgeHealth {
    param([Parameter(Mandatory)][object]$Response)
    return (
        $Response.ok -and
        $Response.protocol_version -eq $expectedProtocolVersion -and
        $Response.config_id -eq $expectedConfigId -and
        $Response.runtime_id -eq $expectedRuntimeId -and
        $Response.browser_channel_id -eq $expectedBrowserChannelId -and
        (@($Response.board_ids) -join ',') -eq ($expectedBoardIds -join ',')
    )
}

function Get-ExpectedBridgeHealth {
    $response = Get-BridgeHealth
    if ($null -eq $response) {
        return $null
    }
    if (
        -not (Test-ExpectedBridgeHealth -Response $response)
    ) {
        throw "Port $Port is occupied by a different or stale local service."
    }
    return $response
}

function Wait-ExpectedBridgeHealth {
    param(
        [Parameter(Mandatory)]
        [object]$Process,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$MaxAttempts = 80,

        [Parameter()]
        [ValidateRange(1, 10000)]
        [int]$PollIntervalMilliseconds = 250,

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSeconds = 20,

        [Parameter()]
        [scriptblock]$HealthProbe = { Get-ExpectedBridgeHealth },

        [Parameter()]
        [scriptblock]$SleepAction = { param([int]$Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
            & $SleepAction $PollIntervalMilliseconds
            if ($Process.HasExited) {
                throw "The local bridge exited during startup with code $($Process.ExitCode)."
            }
            $health = & $HealthProbe
            if ($health) {
                return $health
            }
            if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                break
            }
        }
    } finally {
        $stopwatch.Stop()
    }
    return $null
}

function Stop-FailedBridgeProcess {
    param(
        [Parameter(Mandatory)][object]$Process,
        [Parameter()][scriptblock]$StopAction = {
            param([object]$StartedProcess)
            $StartedProcess.Kill()
        },
        [Parameter()][scriptblock]$WaitAction = {
            param([object]$StartedProcess)
            $null = $StartedProcess.WaitForExit(5000)
            $StartedProcess.Refresh()
        }
    )
    if ($Process.HasExited) { return }
    try {
        & $StopAction $Process
    } catch {
        $stopError = $_
        try { $Process.Refresh() } catch { }
        if (-not $Process.HasExited) { throw $stopError }
    }
    if ($Process.HasExited) { return }
    & $WaitAction $Process
    if (-not $Process.HasExited) {
        throw 'The failed local bridge process could not be stopped safely.'
    }
}

$health = Get-BridgeHealth
if ($health -and (Test-ExpectedBridgeHealth -Response $health)) {
    Write-Output "Bridge already running: $healthUrl"
    return
}
if ($health) {
    & $stopScriptPath -Workspace $workspacePath -Port $Port
}

$arguments = @(
    '-B', '-X', 'utf8', $bridgePath,
    '--workspace', $workspacePath,
    '--skill-dir', (Split-Path -Parent $PSScriptRoot),
    '--config', $configPath,
    '--sop-runtime', $sopRuntimePath,
    '--port', [string]$Port
)
$nativeArguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
$process = Start-Process -FilePath $pythonPath -ArgumentList $nativeArguments -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru
try {
    $health = Wait-ExpectedBridgeHealth -Process $process
    if ($health) {
        Write-Output "Bridge started: $healthUrl"
        return
    }
    throw 'The local bridge did not become ready within 20 seconds.'
} catch {
    $startupError = $_
    try {
        Stop-FailedBridgeProcess -Process $process
    } catch {
        throw "The local bridge failed to start and its new process could not be stopped: $($_.Exception.Message)"
    }
    throw $startupError
}
