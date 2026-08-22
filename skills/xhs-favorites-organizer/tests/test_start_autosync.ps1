[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $ScriptPath -Raw -Encoding UTF8
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $source,
    [ref]$tokens,
    [ref]$parseErrors
)
if (@($parseErrors).Count -gt 0) {
    throw "start-autosync.ps1 has PowerShell parse errors: $($parseErrors[0].Message)"
}

$requiredFunctions = @(
    'Assert-FavSensePlainPath',
    'Get-FileSha256Hex',
    'Get-FavSenseRuntimeId',
    'Get-SopBrowserChannelId',
    'Resolve-SopRuntimeChannel',
    'Get-SopRuntimeCdpPort',
    'Test-SopRuntimeCdpEndpoint',
    'Ensure-SopRuntimeCdpEndpoint',
    'Test-ExpectedBridgeHealth',
    'Wait-ExpectedBridgeHealth',
    'Stop-FailedBridgeProcess'
)
foreach ($functionName in $requiredFunctions) {
    $functionDefinition = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if (-not $functionDefinition) {
        throw "$functionName was not found."
    }
    Invoke-Expression $functionDefinition.Extent.Text
}

$runtimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-runtime-test-" + [Guid]::NewGuid().ToString('N'))
try {
    $plainDirectory = Join-Path $runtimeRoot 'plain-directory'
    [System.IO.Directory]::CreateDirectory($plainDirectory) | Out-Null
    $plainFile = Join-Path $plainDirectory 'plain-file.txt'
    [System.IO.File]::WriteAllText($plainFile, 'plain')
    Assert-FavSensePlainPath -Path $plainDirectory -Kind Directory -Label 'test directory' | Out-Null
    Assert-FavSensePlainPath -Path $plainFile -Kind File -Label 'test file' | Out-Null
    $redirectTarget = Join-Path $runtimeRoot 'redirect-target'
    $redirectPath = Join-Path $runtimeRoot 'redirected-private-runtime'
    [System.IO.Directory]::CreateDirectory($redirectTarget) | Out-Null
    New-Item -ItemType Junction -Path $redirectPath -Target $redirectTarget | Out-Null
    $redirectRefused = $false
    try {
        Assert-FavSensePlainPath -Path $redirectPath -Kind Directory -Label 'test directory' | Out-Null
    } catch {
        $redirectRefused = $_.Exception.Message -match 'redirected'
    }
    if (-not $redirectRefused) {
        throw 'start-autosync accepted a redirected private runtime path.'
    }

    $skillRoot = Join-Path $runtimeRoot 'skill'
    [System.IO.Directory]::CreateDirectory((Join-Path $skillRoot 'runtime')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $skillRoot 'scripts')) | Out-Null
    $configPath = Join-Path $runtimeRoot 'config.json'
    $bridgePath = Join-Path $runtimeRoot 'bridge.py'
    $userscriptPath = Join-Path $runtimeRoot 'userscript.js'
    $releasePath = Join-Path $skillRoot 'release.json'
    $contractPath = Join-Path $skillRoot 'runtime\browser-contract.json'
    $saverPath = Join-Path $skillRoot 'scripts\save_diandian_summary.py'
    [System.IO.File]::WriteAllText($bridgePath, 'bridge-v1')
    [System.IO.File]::WriteAllText($userscriptPath, 'userscript-v1')
    [System.IO.File]::WriteAllText($releasePath, '{"schema_version":1,"package":"xhs-diandian-summarize-note","version":"1.1.0","release_directory":"xhs-diandian-summarize-note-v1.1.0","skill_directory":"xhs-diandian-summarize-note","runtime_contract":"runtime/browser-contract.json","saver":"scripts/save_diandian_summary.py","saver_api":1,"files":[]}')
    [System.IO.File]::WriteAllText($contractPath, '{"selector":"textarea"}')
    [System.IO.File]::WriteAllText($saverPath, 'def save_record(): pass')
    $configObject = [pscustomobject]@{
        diandian = [pscustomobject]@{ enabled = $true; skill_path = $skillRoot }
    }
    [System.IO.File]::WriteAllText($configPath, ($configObject | ConvertTo-Json -Depth 4))
    $firstRuntimeId = Get-FavSenseRuntimeId `
        -WorkspacePath $runtimeRoot `
        -ConfigPath $configPath `
        -ConfigObject $configObject `
        -BridgePath $bridgePath `
        -UserscriptTemplatePath $userscriptPath
    $sopRuntime = Join-Path $runtimeRoot 'SOP - 小红书\运行系统'
    $sopSecrets = Join-Path $sopRuntime '.secrets'
    $sopProfiles = Join-Path $sopSecrets 'browser-profiles'
    $sopProfile = Join-Path $sopProfiles 'cdp-chrome'
    $sopScripts = Join-Path $sopRuntime 'scripts'
    $sopLauncher = Join-Path $sopScripts '启动扫描浏览器.bat'
    [System.IO.Directory]::CreateDirectory($sopProfile) | Out-Null
    [System.IO.Directory]::CreateDirectory($sopScripts) | Out-Null
    Set-Content -LiteralPath $sopLauncher -Value '@exit /b 0' -Encoding ASCII
    $redirectScripts = Join-Path $runtimeRoot 'redirect-scripts'
    [System.IO.Directory]::CreateDirectory($redirectScripts) | Out-Null
    Set-Content -LiteralPath (Join-Path $redirectScripts '启动扫描浏览器.bat') -Value '@exit /b 0' -Encoding ASCII
    [System.IO.Directory]::Delete($sopScripts, $true)
    New-Item -ItemType Junction -Path $sopScripts -Target $redirectScripts | Out-Null
    $scriptsRefused = $false
    try { Resolve-SopRuntimeChannel -RuntimePath $sopRuntime | Out-Null } catch {
        $scriptsRefused = $_.Exception.Message -match 'unavailable|redirect|reparse|junction'
    }
    if (-not $scriptsRefused) {
        throw 'start-autosync accepted a redirected SOP scripts directory.'
    }
    [System.IO.Directory]::Delete($sopScripts)
    [System.IO.Directory]::CreateDirectory($sopScripts) | Out-Null
    $sopLauncher = Join-Path $sopScripts '启动扫描浏览器.bat'
    Set-Content -LiteralPath $sopLauncher -Value '@exit /b 0' -Encoding ASCII
    $sopPortFile = Join-Path $sopSecrets 'cdp-port.txt'
    Set-Content -LiteralPath $sopPortFile -Value '9224' -Encoding ASCII
    $runtimeChannel = Resolve-SopRuntimeChannel -RuntimePath $sopRuntime

    $script:endpointReady = $true
    $script:channelLaunchCount = 0
    function Invoke-RestMethod {
        param([string]$Uri, [int]$TimeoutSec)
        if ($Uri -ne 'http://127.0.0.1:9224/json/version' -or -not $script:endpointReady) {
            throw 'endpoint unavailable'
        }
        return [pscustomobject]@{
            webSocketDebuggerUrl = 'ws://127.0.0.1:9224/devtools/browser/start-fixture'
        }
    }
    function Start-Process {
        param(
            [string]$FilePath,
            [string[]]$ArgumentList,
            [string]$WorkingDirectory,
            [string]$WindowStyle,
            [switch]$PassThru
        )
        if ($FilePath -ne $sopLauncher) { throw "Unexpected launcher: $FilePath" }
        $script:channelLaunchCount += 1
        $script:endpointReady = $true
        return [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
    }
    function Start-Sleep { param([int]$Milliseconds) }

    if ((Get-SopRuntimeCdpPort -PortFilePath $sopPortFile) -ne 9224 -or
        -not (Test-SopRuntimeCdpEndpoint -Channel $runtimeChannel)) {
        throw 'start-autosync did not accept the exact registered live SOP endpoint.'
    }
    Ensure-SopRuntimeCdpEndpoint -Channel $runtimeChannel -Attempts 2 -PollMilliseconds 1
    if ($script:channelLaunchCount -ne 0) {
        throw 'start-autosync launched the SOP browser despite a live registered endpoint.'
    }
    $script:endpointReady = $false
    Ensure-SopRuntimeCdpEndpoint -Channel $runtimeChannel -Attempts 2 -PollMilliseconds 1
    if ($script:channelLaunchCount -ne 1) {
        throw 'start-autosync did not invoke the SOP launcher exactly once for a dead endpoint.'
    }
    Set-Content -LiteralPath $sopPortFile -Value "9224`n9222" -Encoding ASCII
    $invalidPortRefused = $false
    try { Get-SopRuntimeCdpPort -PortFilePath $sopPortFile | Out-Null } catch { $invalidPortRefused = $true }
    if (-not $invalidPortRefused) {
        throw 'start-autosync accepted a multi-line/fallback SOP port registry.'
    }
    Set-Content -LiteralPath $sopPortFile -Value '9224' -Encoding ASCII
    Remove-Item -Path Function:\Start-Sleep -Force
    $canonicalSopRuntime = [System.IO.Path]::GetFullPath($sopRuntime).TrimEnd('\', '/').ToLowerInvariant()
    $channelAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $expectedChannelId = ([BitConverter]::ToString(
            $channelAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonicalSopRuntime))
        ) -replace '-', '').ToLowerInvariant()
    } finally {
        $channelAlgorithm.Dispose()
    }
    $actualChannelId = Get-SopBrowserChannelId -RuntimePath $sopRuntime
    if ($actualChannelId -ne $expectedChannelId) {
        throw 'The shared SOP browser channel identity did not hash the normalized canonical runtime path.'
    }
    $workspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptPath)))
    $pythonPath = Join-Path $workspaceRoot '.xhs-tools\XHS-Downloader\.venv\Scripts\python.exe'
    $bridgeModulePath = Join-Path $workspaceRoot 'skills\xhs-favorites-organizer\scripts\bridge-server.py'
    if (Test-Path -LiteralPath $pythonPath -PathType Leaf) {
        $pythonCode = @'
import importlib.util
from pathlib import Path
import sys

module_path, config_path, bridge_path, userscript_path, skill_path = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('favsense_runtime_check', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.runtime_config_fingerprint(config_path, bridge_path, userscript_path, skill_path))
'@
        $pythonRuntimeId = (& $pythonPath -B -X utf8 -c $pythonCode `
            $bridgeModulePath $configPath $bridgePath $userscriptPath $skillRoot).Trim()
        if ($pythonRuntimeId -ne $firstRuntimeId) {
            throw 'PowerShell and Python runtime fingerprints do not match.'
        }
    }
    [System.IO.File]::WriteAllText($contractPath, '{"selector":".updated-input"}')
    $secondRuntimeId = Get-FavSenseRuntimeId `
        -WorkspacePath $runtimeRoot `
        -ConfigPath $configPath `
        -ConfigObject $configObject `
        -BridgePath $bridgePath `
        -UserscriptTemplatePath $userscriptPath
    if ($firstRuntimeId -eq $secondRuntimeId) {
        throw 'Changing the external Skill contract did not change the runtime fingerprint.'
    }
    $transportPath = Join-Path $skillRoot 'scripts\cdp_transport.py'
    [System.IO.File]::WriteAllText($transportPath, 'def ask(): return "transport-v1"')
    [System.IO.File]::WriteAllText($releasePath, '{"schema_version":1,"package":"xhs-diandian-summarize-note","version":"1.2.0","release_directory":"xhs-diandian-summarize-note-v1.2.0","skill_directory":"xhs-diandian-summarize-note","runtime_contract":"runtime/browser-contract.json","saver":"scripts/save_diandian_summary.py","saver_api":1,"files":["scripts/cdp_transport.py"],"cdp_transport":"scripts/cdp_transport.py"}')
    $transportRuntimeId = Get-FavSenseRuntimeId `
        -WorkspacePath $runtimeRoot `
        -ConfigPath $configPath `
        -ConfigObject $configObject `
        -BridgePath $bridgePath `
        -UserscriptTemplatePath $userscriptPath
    [System.IO.File]::WriteAllText($transportPath, 'def ask(): return "transport-v2"')
    $updatedTransportRuntimeId = Get-FavSenseRuntimeId `
        -WorkspacePath $runtimeRoot `
        -ConfigPath $configPath `
        -ConfigObject $configObject `
        -BridgePath $bridgePath `
        -UserscriptTemplatePath $userscriptPath
    if ($transportRuntimeId -eq $updatedTransportRuntimeId) {
        throw 'Changing the external Skill CDP transport did not change the runtime fingerprint.'
    }
    $script:expectedProtocolVersion = 11
    $script:expectedConfigId = 'config-id'
    $script:expectedRuntimeId = $secondRuntimeId
    $script:expectedBrowserChannelId = $actualChannelId
    $script:expectedBoardIds = @('board-a')
    $staleHealth = [pscustomobject]@{
        ok = $true
        protocol_version = 10
        config_id = 'config-id'
        runtime_id = $firstRuntimeId
        browser_channel_id = '0' * 64
        board_ids = @('board-a')
    }
    if (Test-ExpectedBridgeHealth -Response $staleHealth) {
        throw 'A bridge with the previous Skill contract was accepted as current.'
    }
    $wrongChannelHealth = [pscustomobject]@{
        ok = $true
        protocol_version = 11
        config_id = 'config-id'
        runtime_id = $secondRuntimeId
        browser_channel_id = 'f' * 64
        board_ids = @('board-a')
    }
    if (Test-ExpectedBridgeHealth -Response $wrongChannelHealth) {
        throw 'A bridge attached to a different SOP browser channel was accepted as current.'
    }
    $currentHealth = [pscustomobject]@{
        ok = $true
        protocol_version = 11
        config_id = 'config-id'
        runtime_id = $secondRuntimeId
        browser_channel_id = $actualChannelId
        board_ids = @('board-a')
    }
    if (-not (Test-ExpectedBridgeHealth -Response $currentHealth)) {
        throw 'The bridge attached to the exact shared SOP browser channel was rejected.'
    }

    if ($source -notmatch "--sop-runtime") {
        throw 'The bridge process is not passed the explicit SOP runtime path.'
    }
    if ($source -notmatch '\$token\s+-cnotmatch\s+''\^\[a-f0-9\]\{64\}\$''') {
        throw 'The bridge token is not rejected unless it is exactly 64 lowercase hexadecimal characters.'
    }
    if ($source -notmatch '(?s)catch\s*\{.*Stop-FailedBridgeProcess\s+-Process\s+\$process.*throw\s+\$startupError') {
        throw 'The production startup path does not stop and reap its own failed bridge process before rethrowing.'
    }
    if ($source -match '\.xhs-favorites[\\/]browser-profile|DevToolsActivePort|chrome\.exe|--user-data-dir') {
        throw 'Bridge startup still owns or falls back to a separate Chrome profile.'
    }
} finally {
    if (Test-Path -LiteralPath $runtimeRoot) {
        Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
    }
}

$script:probeCount = 0
$fakeProcess = [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()
$health = Wait-ExpectedBridgeHealth `
    -Process $fakeProcess `
    -PollIntervalMilliseconds 250 `
    -HealthProbe {
        $script:probeCount += 1
        if ($script:probeCount -eq 25) {
            return [pscustomobject]@{ ok = $true; marker = 'healthy-after-6.25-seconds' }
        }
        return $null
    }
$elapsed.Stop()

if ($script:probeCount -ne 25) {
    throw "Expected readiness on probe 25, got probe $script:probeCount."
}
if ($elapsed.Elapsed.TotalSeconds -le 5 -or $elapsed.Elapsed.TotalSeconds -ge 15) {
    throw "Expected readiness between 5 and 15 seconds, got $($elapsed.Elapsed.TotalSeconds) seconds."
}
if (-not $health.ok -or $health.marker -ne 'healthy-after-6.25-seconds') {
    throw 'The delayed healthy response was not returned.'
}

$script:failedStartStopProcesses = @()
$script:failedStartWaitCount = 0
$failedStartProcess = [pscustomobject]@{ HasExited = $false; ExitCode = 0; Id = 4242 }
Stop-FailedBridgeProcess `
    -Process $failedStartProcess `
    -StopAction {
        param([object]$StartedProcess)
        $script:failedStartStopProcesses += $StartedProcess
    } `
    -WaitAction {
        param([object]$StartedProcess)
        $script:failedStartWaitCount += 1
        $StartedProcess.HasExited = $true
    }
if ($script:failedStartStopProcesses.Count -ne 1 -or
    -not [object]::ReferenceEquals($script:failedStartStopProcesses[0], $failedStartProcess) -or
    $script:failedStartWaitCount -ne 1) {
    throw 'A bridge that stayed alive after startup failure was not stopped and reaped exactly once.'
}

$exitedDuringStop = [pscustomobject]@{ HasExited = $false; ExitCode = 0; Id = 4243 }
Stop-FailedBridgeProcess `
    -Process $exitedDuringStop `
    -StopAction {
        param([object]$StartedProcess)
        $StartedProcess.HasExited = $true
        throw 'process exited before Kill reached its handle'
    } `
    -WaitAction { throw 'an already-exited process must not be waited twice' }
if (-not $exitedDuringStop.HasExited) {
    throw 'A process exit racing with failed-start cleanup was not treated as already stopped.'
}

Write-Output 'Shared SOP identity, delayed readiness, and failed-start process cleanup were accepted.'
