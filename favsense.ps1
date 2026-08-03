[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'preview', 'stop', 'test', 'verify')]
    [string]$Command = 'preview'
)

$ErrorActionPreference = 'Stop'
$workspacePath = $PSScriptRoot
$configPath = Join-Path $workspacePath 'config\xhs-favorites.json'
$exampleConfigPath = Join-Path $workspacePath 'config\xhs-favorites.example.json'
$skillScripts = Join-Path $workspacePath 'skills\xhs-favorites-organizer\scripts'
$siteScript = Join-Path $workspacePath 'scripts\serve-site.mjs'
$sitePidPath = Join-Path $workspacePath '.xhs-favorites\site-preview.json'

function Stop-ManagedSitePreview {
    if (-not (Test-Path -LiteralPath $sitePidPath -PathType Leaf)) { return }
    try {
        $record = Get-Content -Raw -Encoding UTF8 -LiteralPath $sitePidPath | ConvertFrom-Json
        $managedPid = [int]$record.pid
        $expectedStartedAt = [long]$record.started_at_ticks
        $process = Get-Process -Id $managedPid -ErrorAction Stop
        if ($process.ProcessName -ne 'node' -or $process.StartTime.ToUniversalTime().Ticks -ne $expectedStartedAt) {
            return
        }
        Stop-Process -Id $managedPid -Force -ErrorAction Stop
        $process.WaitForExit(5000) | Out-Null
    } catch {
        # A missing or reused PID is stale state, not a reason to block startup.
    } finally {
        Remove-Item -LiteralPath $sitePidPath -Force -ErrorAction SilentlyContinue
    }
}

function Stop-LegacySitePreview {
    if (Test-Path -LiteralPath $sitePidPath -PathType Leaf) { return }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8766/' -TimeoutSec 2
        if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'FavSense') { return }
        $listener = netstat.exe -ano -p tcp |
            Select-String -Pattern '^\s*TCP\s+127\.0\.0\.1:8766\s+\S+\s+LISTENING\s+(\d+)\s*$' |
            Select-Object -First 1
        if (-not $listener -or -not $listener.Matches[0].Groups[1].Success) { return }
        $legacyPid = [int]$listener.Matches[0].Groups[1].Value
        $process = Get-Process -Id $legacyPid -ErrorAction Stop
        if ($process.ProcessName -ne 'node') { return }
        Stop-Process -Id $legacyPid -Force -ErrorAction Stop
        $process.WaitForExit(5000) | Out-Null
    } catch {
        # Only a verified FavSense page served by Node is eligible for legacy cleanup.
    }
}

function Start-SitePreview {
    $stateDirectory = Split-Path -Parent $sitePidPath
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $nodePath = (Get-Command 'node.exe' -ErrorAction Stop).Source
    $escapedScript = '"' + ($siteScript -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = $escapedScript
    $startInfo.WorkingDirectory = $workspacePath
    $startInfo.UseShellExecute = $false
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Could not start the FavSense local site.' }
    $record = [ordered]@{
        pid = $process.Id
        started_at_ticks = $process.StartTime.ToUniversalTime().Ticks
    }
    try {
        [System.IO.File]::WriteAllText(
            $sitePidPath,
            ($record | ConvertTo-Json -Compress),
            (New-Object System.Text.UTF8Encoding($false))
        )
        return $process
    } catch {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

switch ($Command) {
    'setup' {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            Copy-Item -LiteralPath $exampleConfigPath -Destination $configPath
            Write-Output '已创建私有配置 config\xhs-favorites.json。请填写个人主页和收藏夹 ID，然后再次运行 .\favsense.ps1 setup。'
            exit 0
        }
        & (Join-Path $skillScripts 'setup-autosync.ps1') -Workspace $workspacePath -Config $configPath
    }
    'preview' {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw '请先运行 .\favsense.ps1 setup。' }
        $previewMutex = New-Object System.Threading.Mutex($false, 'Local\FavSensePreview')
        $ownsPreview = $false
        try {
            $ownsPreview = $previewMutex.WaitOne(0)
            if (-not $ownsPreview) {
                Write-Output 'FavSense local workspace is already running.'
                return
            }
            Stop-ManagedSitePreview
            Stop-LegacySitePreview
            & (Join-Path $skillScripts 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath
            $siteProcess = $null
            try {
                $siteProcess = Start-SitePreview
                $siteProcess.WaitForExit()
                if ($siteProcess.ExitCode -ne 0) {
                    throw "FavSense local site exited with code $($siteProcess.ExitCode)."
                }
            } finally {
                if ($siteProcess -and -not $siteProcess.HasExited) {
                    Stop-Process -Id $siteProcess.Id -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath $sitePidPath -Force -ErrorAction SilentlyContinue
                & (Join-Path $skillScripts 'stop-autosync.ps1')
            }
        } finally {
            if ($ownsPreview) {
                $previewMutex.ReleaseMutex()
            }
            $previewMutex.Dispose()
        }
    }
    'stop' {
        Stop-ManagedSitePreview
        Stop-LegacySitePreview
        & (Join-Path $skillScripts 'stop-autosync.ps1')
    }
    'test' { & npm.cmd test }
    'verify' { & npm.cmd run release:check }
}
