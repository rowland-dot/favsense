[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [string]$UserId,

    [Parameter()]
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),

    [Parameter()]
    [switch]$Baseline
)

$ErrorActionPreference = 'Stop'
$script:OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $script:OutputEncoding

if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw "Date must use YYYY-MM-DD format: $Date"
}
if ($UserId -and $UserId -notmatch '^[A-Za-z0-9_-]{1,128}$') {
    throw 'UserId contains unsupported characters.'
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$localRedbookPath = Join-Path $workspacePath '.xhs-tools\node_modules\.bin\redbook.cmd'
$redbookCommand = if (Test-Path -LiteralPath $localRedbookPath) {
    $localRedbookPath
} else {
    $command = Get-Command -Name 'redbook.cmd' -ErrorAction SilentlyContinue
    if (-not $command) {
        $command = Get-Command -Name 'redbook' -ErrorAction SilentlyContinue
    }
    $command.Source
}
if (-not $redbookCommand) {
    throw 'redbook was not found on PATH. Read references/redbook-adapter.md before installing it.'
}

$node = Get-Command -Name 'node' -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js was not found on PATH. Node.js 22 or newer is required.'
}
$nodeVersionText = (& $node.Source --version).Trim().TrimStart('v')
try {
    $nodeVersion = [version]$nodeVersionText
} catch {
    throw "Could not parse Node.js version: $nodeVersionText"
}
if ($nodeVersion.Major -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersionText."
}

$catalogPath = Join-Path $workspacePath '.xhs-favorites\catalog.json'
$reportPath = Join-Path $workspacePath "xhs-favorites\$Date.md"
$organizerPath = Join-Path $PSScriptRoot 'organize.mjs'
$temporaryBase = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-favorites-" + [guid]::NewGuid().ToString('N'))
$jsonPath = "$temporaryBase.json"
$errorPath = "$temporaryBase.stderr.log"

try {
    $redbookArguments = @('favorites')
    if ($UserId) {
        $redbookArguments += $UserId
    }
    $redbookArguments += '--json'

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.StandardOutputEncoding = $script:OutputEncoding
    $processInfo.StandardErrorEncoding = $script:OutputEncoding

    if ([System.IO.Path]::GetExtension($redbookCommand) -in @('.cmd', '.bat')) {
        $processInfo.FileName = $env:ComSpec
        $processInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($redbookCommand)
        $commandName = [System.IO.Path]::GetFileName($redbookCommand)
        $processInfo.Arguments = "/d /s /c `"`"$commandName`" $($redbookArguments -join ' ')`""
    } else {
        $processInfo.FileName = $redbookCommand
        $processInfo.Arguments = $redbookArguments -join ' '
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    if (-not $process.Start()) {
        throw 'Failed to start redbook.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $redbookExitCode = $process.ExitCode
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [System.IO.File]::WriteAllText($jsonPath, $stdout, $script:OutputEncoding)
    [System.IO.File]::WriteAllText($errorPath, $stderr, $script:OutputEncoding)

    if ($redbookExitCode -ne 0) {
        $details = if (Test-Path -LiteralPath $errorPath) {
            (Get-Content -LiteralPath $errorPath -Raw).Trim()
        } else {
            'No diagnostic output was returned.'
        }
        $details = $details -replace '(?i)(a1|web_session)=([^;\s]+)', '$1=[REDACTED]'
        if ($details.Length -gt 1000) {
            $details = $details.Substring(0, 1000) + '...'
        }
        throw "redbook favorites failed with exit code $redbookExitCode. $details"
    }

    $organizerArguments = @(
        $organizerPath,
        '--input', $jsonPath,
        '--catalog', $catalogPath,
        '--output', $reportPath,
        '--date', $Date
    )
    if ($Baseline) {
        $organizerArguments += '--baseline'
    }

    & $node.Source @organizerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "organize.mjs failed with exit code $LASTEXITCODE"
    }

    Write-Output "Catalog: $catalogPath"
    Write-Output "Report:  $reportPath"
} finally {
    Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
}
