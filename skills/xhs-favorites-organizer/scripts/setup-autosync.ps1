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

function Test-PathIsReparsePoint {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null -ne $item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Resolve-SopBrowserChannel {
    param([Parameter(Mandatory)][string]$RuntimePath)

    $runtimeFullPath = [System.IO.Path]::GetFullPath($RuntimePath).TrimEnd('\', '/')
    $secretsPath = Join-Path $runtimeFullPath '.secrets'
    $profilePath = Join-Path $secretsPath 'browser-profiles\cdp-chrome'
    $portFilePath = Join-Path $secretsPath 'cdp-port.txt'
    $scriptsPath = Join-Path $runtimeFullPath 'scripts'
    $launcherPath = Join-Path $scriptsPath '启动扫描浏览器.bat'
    foreach ($candidate in @($runtimeFullPath, $secretsPath, (Join-Path $secretsPath 'browser-profiles'), $profilePath, $scriptsPath)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
            throw "The shared SOP browser runtime is incomplete: $candidate"
        }
        if (Test-PathIsReparsePoint -Path $candidate) {
            throw "Refusing redirected SOP browser path (reparse point or junction): $candidate"
        }
    }
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "The shared SOP browser runtime is incomplete: $launcherPath"
    }
    if (Test-PathIsReparsePoint -Path $launcherPath) {
        throw "Refusing redirected SOP browser file (reparse point or junction): $launcherPath"
    }
    $portItem = Get-Item -LiteralPath $portFilePath -Force -ErrorAction SilentlyContinue
    if ($portItem -and ($portItem.PSIsContainer -or (Test-PathIsReparsePoint -Path $portFilePath))) {
        throw 'The SOP CDP port registry is redirected or invalid.'
    }

    return [pscustomobject]@{
        RuntimePath = $runtimeFullPath
        ProfilePath = [System.IO.Path]::GetFullPath($profilePath).TrimEnd('\', '/')
        PortFilePath = [System.IO.Path]::GetFullPath($portFilePath).TrimEnd('\', '/')
        LauncherPath = [System.IO.Path]::GetFullPath($launcherPath).TrimEnd('\', '/')
    }
}

function Get-SopCdpPort {
    param([Parameter(Mandatory)][string]$PortFilePath)
    if (-not (Test-Path -LiteralPath $PortFilePath -PathType Leaf) -or (Test-PathIsReparsePoint -Path $PortFilePath)) {
        throw 'The SOP CDP port registry is unavailable.'
    }
    $lines = @([System.IO.File]::ReadAllLines($PortFilePath, [System.Text.Encoding]::ASCII))
    $port = 0
    if ($lines.Count -ne 1 -or
        -not [int]::TryParse($lines[0].Trim(), [ref]$port) -or
        $port -lt 1024 -or $port -gt 65535) {
        throw 'The SOP CDP port registry is invalid.'
    }
    return $port
}

function Test-SopCdpEndpoint {
    param([Parameter(Mandatory)][object]$Channel)
    try {
        $port = Get-SopCdpPort -PortFilePath $Channel.PortFilePath
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 1
        $webSocket = [uri]([string]$version.webSocketDebuggerUrl)
        return (
            $webSocket.Scheme -eq 'ws' -and
            $webSocket.Host -in @('127.0.0.1', 'localhost') -and
            $webSocket.Port -eq $port -and
            $webSocket.AbsolutePath -match '^/devtools/browser/[A-Za-z0-9._-]{1,160}$' -and
            [string]::IsNullOrEmpty($webSocket.Query) -and
            [string]::IsNullOrEmpty($webSocket.Fragment) -and
            [string]::IsNullOrEmpty($webSocket.UserInfo)
        )
    } catch {
        return $false
    }
}

function Ensure-SopBrowserChannel {
    param(
        [Parameter(Mandatory)][object]$Channel,
        [ValidateRange(1, 100)][int]$Attempts = 40,
        [ValidateRange(1, 10000)][int]$PollMilliseconds = 250
    )
    if (Test-SopCdpEndpoint -Channel $Channel) { return $Channel }

    Start-Process -FilePath $Channel.LauncherPath -WorkingDirectory (Split-Path -Parent $Channel.LauncherPath) -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
        if (Test-SopCdpEndpoint -Channel $Channel) { return $Channel }
        if ($attempt + 1 -lt $Attempts) { Start-Sleep -Milliseconds $PollMilliseconds }
    }
    throw 'The SOP scanner browser CDP channel did not become ready within the bounded startup window.'
}

function Open-SopBrowserTab {
    param(
        [Parameter(Mandatory)][object]$Channel,
        [Parameter(Mandatory)][string]$Url
    )
    if (-not (Test-SopCdpEndpoint -Channel $Channel)) {
        throw 'The SOP scanner browser CDP channel is unavailable.'
    }
    $target = [uri]$Url
    if ($target.Scheme -notin @('http', 'https') -or $target.UserInfo) {
        throw 'The requested SOP browser tab URL is invalid.'
    }
    $port = Get-SopCdpPort -PortFilePath $Channel.PortFilePath
    $encoded = [uri]::EscapeDataString($target.AbsoluteUri)
    $tab = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/new?$encoded" -Method Put -TimeoutSec 3
    $tabId = [string]$tab.id
    if ($tab.type -ne 'page' -or $tabId -notmatch '^[A-Za-z0-9._-]{1,160}$') {
        throw 'The SOP browser did not return a valid page target.'
    }
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/activate/$tabId" -Method Get -TimeoutSec 3 | Out-Null
    return $tab
}

function Test-SopTampermonkeyInstallation {
    param(
        [Parameter(Mandatory)][string]$ProfilePath,
        [Parameter(Mandatory)][string]$ExtensionId
    )
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container) -or (Test-PathIsReparsePoint -Path $ProfilePath)) { return $false }
    foreach ($profileDirectory in @(Get-ChildItem -LiteralPath $ProfilePath -Directory -Force -ErrorAction SilentlyContinue)) {
        if (Test-PathIsReparsePoint -Path $profileDirectory.FullName) { continue }
        $extensionRoot = Join-Path $profileDirectory.FullName "Extensions\$ExtensionId"
        if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container) -or (Test-PathIsReparsePoint -Path $extensionRoot)) { continue }
        foreach ($versionDirectory in @(Get-ChildItem -LiteralPath $extensionRoot -Directory -Force -ErrorAction SilentlyContinue)) {
            if (Test-PathIsReparsePoint -Path $versionDirectory.FullName) { continue }
            $manifestPath = Join-Path $versionDirectory.FullName 'manifest.json'
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or (Test-PathIsReparsePoint -Path $manifestPath)) { continue }
            try {
                $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
            } catch {
                continue
            }
            if ($manifest -is [System.Management.Automation.PSCustomObject] -and
                $manifest.manifest_version -in @(2, 3) -and
                -not [string]::IsNullOrWhiteSpace([string]$manifest.name)) {
                return $true
            }
        }
    }
    return $false
}

function Assert-SetupDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Create
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -and $Create) {
        [System.IO.Directory]::CreateDirectory($fullPath) | Out-Null
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $item -or -not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Refusing missing, redirected, or invalid setup directory: $fullPath"
    }
    return $fullPath
}

function Enter-FavSenseSetupLock {
    param([Parameter(Mandatory)][string]$StateDirectory)
    $directory = Assert-SetupDirectory -Path $StateDirectory -Create
    $lockPath = Join-Path $directory '.setup-autosync.lock'
    $lockItem = Get-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    if ($lockItem -and ($lockItem.PSIsContainer -or
        (($lockItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0))) {
        throw 'The FavSense setup lock is redirected or invalid.'
    }
    try {
        return [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw 'Another FavSense setup is already running; no local files were changed.'
    }
}

function Invoke-FavSenseSetupUnderLock {
    param(
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter(Mandatory)][scriptblock]$SetupAction,
        [Parameter()][scriptblock]$LockAction = {
            param([string]$Path)
            Enter-FavSenseSetupLock -StateDirectory $Path
        }
    )
    $setupLock = & $LockAction $StateDirectory
    if ($null -eq $setupLock) {
        throw 'The FavSense setup lock could not be acquired.'
    }
    try {
        & $SetupAction
    } finally {
        $setupLock.Dispose()
    }
}

function Get-SetupFileSnapshot {
    param([Parameter(Mandatory)][string]$Path)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return [pscustomobject]@{ Path = $fullPath; Exists = $false; Bytes = $null }
    }
    if ($item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Refusing redirected or invalid setup file: $fullPath"
    }
    return [pscustomobject]@{
        Path = $fullPath
        Exists = $true
        Bytes = [System.IO.File]::ReadAllBytes($fullPath)
    }
}

function Set-SetupFileBytesAtomically {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parentPath = Split-Path -Parent $fullPath
    Assert-SetupDirectory -Path $parentPath -Create | Out-Null
    $existing = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if ($existing -and ($existing.PSIsContainer -or
        (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0))) {
        throw "Refusing redirected or invalid setup file: $fullPath"
    }
    $temporaryPath = Join-Path $parentPath ((Split-Path -Leaf $fullPath) + '.setup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
        } else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}

function Restore-SetupFileSnapshot {
    param([Parameter(Mandatory)][object]$Snapshot)
    if ($Snapshot.Exists) {
        Set-SetupFileBytesAtomically -Path ([string]$Snapshot.Path) -Bytes ([byte[]]$Snapshot.Bytes)
        return
    }
    $item = Get-Item -LiteralPath ([string]$Snapshot.Path) -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Refusing to remove redirected or invalid setup rollback target: $($Snapshot.Path)"
    }
    [System.IO.File]::Delete([string]$Snapshot.Path)
}

function Get-ManagedSetupTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter()][string[]]$ManagedPaths = @()
    )
    $item = Get-Item -LiteralPath $StateDirectory -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return @() }
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'The private setup state directory is redirected or invalid.'
    }
    $temporaryPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($managedPath in $ManagedPaths) {
        $fullPath = [System.IO.Path]::GetFullPath($managedPath)
        $parentPath = Split-Path -Parent $fullPath
        $parent = Get-Item -LiteralPath $parentPath -Force -ErrorAction SilentlyContinue
        if ($null -eq $parent) { continue }
        if (-not $parent.PSIsContainer -or
            (($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'A managed FavSense setup directory is redirected or invalid.'
        }
        $leafPattern = '^' + [regex]::Escape((Split-Path -Leaf $fullPath)) + '\.setup-[a-f0-9]{32}\.tmp$'
        foreach ($candidate in @(Get-ChildItem -LiteralPath $parentPath -File -Force -ErrorAction Stop)) {
            if ($candidate.Name -notmatch $leafPattern) { continue }
            if (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A managed FavSense setup temporary file is redirected or invalid.'
            }
            $null = $temporaryPaths.Add($candidate.FullName)
        }
    }
    return @($temporaryPaths)
}

function Get-BridgeUserscriptTemporaryFiles {
    param([Parameter(Mandatory)][string]$StateDirectory)
    $item = Get-Item -LiteralPath $StateDirectory -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return @() }
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'The private setup state directory is redirected or invalid.'
    }
    $temporaryPaths = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(Get-ChildItem -LiteralPath $StateDirectory -File -Force -ErrorAction Stop)) {
        if ($candidate.Name -notmatch '^xhs-favorites\.user\.js\.\d+(?:\.\d+)?\.tmp$') { continue }
        if (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A FavSense userscript temporary file is redirected or invalid.'
        }
        $temporaryPaths.Add($candidate.FullName)
    }
    return @($temporaryPaths)
}

function Get-SetupTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter()][string[]]$ManagedPaths = @()
    )
    return @(
        @(Get-ManagedSetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $ManagedPaths)
        @(Get-BridgeUserscriptTemporaryFiles -StateDirectory $StateDirectory)
    )
}

function Remove-OrphanedSetupTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter()][string[]]$ManagedPaths = @()
    )
    foreach ($path in @(Get-ManagedSetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $ManagedPaths)) {
        [System.IO.File]::Delete([System.IO.Path]::GetFullPath($path))
    }
}

function Remove-OrphanedBridgeUserscriptTemporaryFiles {
    param([Parameter(Mandatory)][string]$StateDirectory)
    foreach ($path in @(Get-BridgeUserscriptTemporaryFiles -StateDirectory $StateDirectory)) {
        [System.IO.File]::Delete([System.IO.Path]::GetFullPath($path))
    }
}

function Remove-NewSetupTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter()][string[]]$ManagedPaths = @(),
        [Parameter()][string[]]$InitialPaths = @()
    )
    $initial = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $InitialPaths) { $null = $initial.Add([System.IO.Path]::GetFullPath($path)) }
    foreach ($path in @(Get-SetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $ManagedPaths)) {
        $fullPath = [System.IO.Path]::GetFullPath($path)
        if (-not $initial.Contains($fullPath)) {
            [System.IO.File]::Delete($fullPath)
        }
    }
}

function Get-FavSenseSetupBridgeProcesses {
    param(
        [Parameter(Mandatory)][string]$WorkspacePath,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][int]$Port
    )
    $workspaceFullPath = [System.IO.Path]::GetFullPath($WorkspacePath)
    $bridgeFullPath = [System.IO.Path]::GetFullPath($BridgePath)
    return @(
        Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
            $executable = [string]$_.ExecutablePath
            $commandLine = [string]$_.CommandLine
            -not [string]::IsNullOrWhiteSpace($executable) -and
            [System.IO.Path]::GetFileName($executable) -eq 'python.exe' -and
            $commandLine -match [regex]::Escape($bridgeFullPath) -and
            $commandLine -match [regex]::Escape($workspaceFullPath) -and
            $commandLine -match "--port\s+$Port(?:\s|$)"
        }
    )
}

function Get-FavSenseSetupServiceState {
    param(
        [Parameter(Mandatory)][string]$WorkspacePath,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][int]$Port
    )
    $processes = @(Get-FavSenseSetupBridgeProcesses -WorkspacePath $WorkspacePath -BridgePath $BridgePath -Port $Port)
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        if ($processes.Count -ne 0) {
            throw "A FavSense bridge process exists without the expected listener on port $Port. Stop it before setup."
        }
        return [pscustomobject]@{ WasRunning = $false; ProcessIds = [int[]]@() }
    }
    if ($listeners.Count -ne 1) {
        throw "Expected at most one listener on 127.0.0.1:$Port but found $($listeners.Count)."
    }
    $listenerProcessId = [int]$listeners[0].OwningProcess
    $matching = @($processes | Where-Object { [int]$_.ProcessId -eq $listenerProcessId })
    if ($matching.Count -ne 1 -or $processes.Count -ne 1) {
        throw "Port $Port is occupied by a different or ambiguous local service."
    }
    return [pscustomobject]@{ WasRunning = $true; ProcessIds = [int[]]@($listenerProcessId) }
}

function Stop-NewFavSenseSetupBridgeProcesses {
    param(
        [Parameter(Mandatory)][string]$WorkspacePath,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][int]$Port,
        [Parameter()][int[]]$InitialProcessIds = @()
    )
    $initial = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in $InitialProcessIds) { $null = $initial.Add($processId) }
    foreach ($process in @(Get-FavSenseSetupBridgeProcesses -WorkspacePath $WorkspacePath -BridgePath $BridgePath -Port $Port)) {
        $processId = [int]$process.ProcessId
        if (-not $initial.Contains($processId)) {
            Stop-Process -Id $processId -Force -ErrorAction Stop
        }
    }
}

function Invoke-SetupCredentialTransaction {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$ManagedFileContents,
        [Parameter(Mandatory)][string[]]$SnapshotPaths,
        [Parameter(Mandatory)][string]$StateDirectory,
        [Parameter(Mandatory)][bool]$WasRunning,
        [Parameter()][int[]]$InitialBridgeProcessIds = @(),
        [Parameter(Mandatory)][scriptblock]$StopAction,
        [Parameter(Mandatory)][scriptblock]$StartAction,
        [Parameter(Mandatory)][scriptblock]$CleanupProcessAction,
        [Parameter(Mandatory)][scriptblock]$RestartAction
    )
    $snapshots = @($SnapshotPaths | ForEach-Object { Get-SetupFileSnapshot -Path $_ })
    $initialTemporaryFiles = @(Get-ManagedSetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $SnapshotPaths)
    $oldServiceStopped = $false
    try {
        & $StopAction | Out-Null
        $oldServiceStopped = $true
        Remove-OrphanedBridgeUserscriptTemporaryFiles -StateDirectory $StateDirectory
        foreach ($entry in $ManagedFileContents.GetEnumerator()) {
            Set-SetupFileBytesAtomically -Path ([string]$entry.Key) -Bytes ([byte[]]$entry.Value)
        }
        & $StartAction | Out-Null
    } catch {
        $originalError = $_
        $recoveryFailures = [System.Collections.Generic.List[string]]::new()
        try {
            & $StopAction | Out-Null
            $oldServiceStopped = $true
        } catch {
            $recoveryFailures.Add('stop')
        }
        try {
            if ($oldServiceStopped) {
                & $CleanupProcessAction -InitialProcessIds ([int[]]@()) | Out-Null
            } else {
                & $CleanupProcessAction -InitialProcessIds ([int[]]$InitialBridgeProcessIds) | Out-Null
            }
        } catch { $recoveryFailures.Add("process cleanup: $($_.Exception.Message)") }
        foreach ($snapshot in $snapshots) {
            try { Restore-SetupFileSnapshot -Snapshot $snapshot } catch { $recoveryFailures.Add('file restore') }
        }
        try {
            Remove-NewSetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $SnapshotPaths -InitialPaths $initialTemporaryFiles
        } catch {
            $recoveryFailures.Add("temporary cleanup: $($_.Exception.Message)")
        }
        if ($WasRunning) {
            try { & $RestartAction | Out-Null } catch { $recoveryFailures.Add('service restart') }
            foreach ($snapshot in $snapshots) {
                try { Restore-SetupFileSnapshot -Snapshot $snapshot } catch { $recoveryFailures.Add('post-restart file restore') }
            }
            try {
                Remove-NewSetupTemporaryFiles -StateDirectory $StateDirectory -ManagedPaths $SnapshotPaths -InitialPaths $initialTemporaryFiles
            } catch {
                $recoveryFailures.Add("post-restart temporary cleanup: $($_.Exception.Message)")
            }
        }
        if ($recoveryFailures.Count -ne 0) {
            throw "FavSense setup failed and the previous local installation could not be fully restored ($($recoveryFailures -join ', ')). Stop the local service and run setup again."
        }
        throw $originalError
    }
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
$sopRuntimePath = if ([string]::IsNullOrWhiteSpace($SopRuntime)) {
    Join-Path (Split-Path -Parent $workspacePath) 'SOP - 小红书\运行系统'
} else {
    [System.IO.Path]::GetFullPath($SopRuntime)
}
$stateDirectory = Join-Path $workspacePath '.xhs-favorites'
$tokenPath = Join-Path $stateDirectory 'bridge-token'
$installCapabilityPath = Join-Path $stateDirectory 'userscript-install-capability'
$installStatePath = Join-Path $stateDirectory 'userscript-install.json'
$userscriptPath = Join-Path $stateDirectory 'xhs-favorites.user.js'
$localRuntimeDirectory = Join-Path $workspacePath 'site\.local'
$localRuntimePath = Join-Path $localRuntimeDirectory 'bridge.json'
$bridgePath = Join-Path $PSScriptRoot 'bridge-server.py'
$tampermonkeyId = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'
$tampermonkeyStoreUrl = "https://chromewebstore.google.com/detail/tampermonkey/$tampermonkeyId"
$xhsLoginUrl = 'https://www.xiaohongshu.com/explore'
Assert-SetupDirectory -Path $workspacePath | Out-Null
Assert-SetupDirectory -Path $stateDirectory -Create | Out-Null
Invoke-FavSenseSetupUnderLock -StateDirectory $stateDirectory -SetupAction {
    Remove-OrphanedSetupTemporaryFiles `
        -StateDirectory $stateDirectory `
        -ManagedPaths @($tokenPath, $installCapabilityPath, $installStatePath, $localRuntimePath, $userscriptPath)

    $channel = Resolve-SopBrowserChannel -RuntimePath $sopRuntimePath
    Ensure-SopBrowserChannel -Channel $channel | Out-Null
    $tampermonkeyInstalled = Test-SopTampermonkeyInstallation -ProfilePath $channel.ProfilePath -ExtensionId $tampermonkeyId

    if (-not $tampermonkeyInstalled) {
        Open-SopBrowserTab -Channel $channel -Url $tampermonkeyStoreUrl | Out-Null
        Open-SopBrowserTab -Channel $channel -Url $xhsLoginUrl | Out-Null
        Write-Output 'Opened Tampermonkey and Xiaohongshu in the existing SOP scanner browser. Complete installation and login there, then run setup again.'
        Write-Output 'No private installer capability or bridge token was issued.'
        return
    }

    Assert-SetupDirectory -Path (Join-Path $workspacePath 'site') | Out-Null
    Assert-SetupDirectory -Path $localRuntimeDirectory -Create | Out-Null

    $legacyTask = Get-ScheduledTask -TaskName 'FavSense-Daily' -ErrorAction SilentlyContinue
    if ($legacyTask) {
        Unregister-ScheduledTask -TaskName 'FavSense-Daily' -Confirm:$false
        Write-Output "Removed legacy daily task 'FavSense-Daily'."
    }

    $configItem = Get-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $configItem -or $configItem.PSIsContainer -or
        (($configItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Configuration was not found or is redirected: $configPath"
    }
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop | Out-Null
    & (Join-Path $PSScriptRoot 'setup-xhs-downloader.ps1') -Workspace $workspacePath
    $serviceState = Get-FavSenseSetupServiceState -WorkspacePath $workspacePath -BridgePath $bridgePath -Port $Port

    $tokenBytes = [byte[]]::new(32)
    $tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $tokenGenerator.GetBytes($tokenBytes) } finally { $tokenGenerator.Dispose() }
    $token = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()

    $installBytes = [byte[]]::new(32)
    $installGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $installGenerator.GetBytes($installBytes) } finally { $installGenerator.Dispose() }
    $installCapability = ([BitConverter]::ToString($installBytes) -replace '-', '').ToLowerInvariant()
    $installIssuedAt = [DateTimeOffset]::Now
    $installExpiresAt = $installIssuedAt.AddMinutes(10)
    $installSha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $installDigestBytes = $installSha256.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($installCapability))
        $installDigest = ([BitConverter]::ToString($installDigestBytes) -replace '-', '').ToLowerInvariant()
    } finally { $installSha256.Dispose() }
    $installState = [ordered]@{
        version = 1
        digest = $installDigest
        issued_at = $installIssuedAt.ToString('o')
        expires_at = $installExpiresAt.ToString('o')
    } | ConvertTo-Json -Compress
    $localRuntime = [ordered]@{ baseUrl = "http://127.0.0.1:$Port" } | ConvertTo-Json -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $managedFileContents = [ordered]@{}
    $managedFileContents[$tokenPath] = $utf8NoBom.GetBytes($token)
    $managedFileContents[$installCapabilityPath] = $utf8NoBom.GetBytes($installCapability)
    $managedFileContents[$installStatePath] = $utf8NoBom.GetBytes($installState)
    $managedFileContents[$localRuntimePath] = $utf8NoBom.GetBytes($localRuntime)
    $installSourceUrl = "http://127.0.0.1:$Port/install/$installCapability/xhs-favorites.user.js"
    $stopAction = {
        & (Join-Path $PSScriptRoot 'stop-autosync.ps1') -Workspace $workspacePath -Port $Port
    }
    $startAction = {
        & (Join-Path $PSScriptRoot 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath -Port $Port -SopRuntime $channel.RuntimePath
        Open-SopBrowserTab -Channel $channel -Url $installSourceUrl | Out-Null
        Open-SopBrowserTab -Channel $channel -Url $xhsLoginUrl | Out-Null
    }
    $cleanupProcessAction = {
        param([int[]]$InitialProcessIds)
        Stop-NewFavSenseSetupBridgeProcesses `
            -WorkspacePath $workspacePath `
            -BridgePath $bridgePath `
            -Port $Port `
            -InitialProcessIds $InitialProcessIds
    }
    $restartAction = {
        & (Join-Path $PSScriptRoot 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath -Port $Port -SopRuntime $channel.RuntimePath
    }
    Invoke-SetupCredentialTransaction `
        -ManagedFileContents $managedFileContents `
        -SnapshotPaths @($tokenPath, $installCapabilityPath, $installStatePath, $localRuntimePath, $userscriptPath) `
        -StateDirectory $stateDirectory `
        -WasRunning ([bool]$serviceState.WasRunning) `
        -InitialBridgeProcessIds ([int[]]$serviceState.ProcessIds) `
        -StopAction $stopAction `
        -StartAction $startAction `
        -CleanupProcessAction $cleanupProcessAction `
        -RestartAction $restartAction
    Write-Output 'FavSense local service is ready. No daily or Windows startup task was installed.'
    Write-Output 'Opened the private Tampermonkey installer in the existing SOP scanner browser. The source expires in 10 minutes and is disabled after first use.'
    Write-Output 'Keep the SOP scanner browser signed in, then use the local workbench to start each sync.'
}
