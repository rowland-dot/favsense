[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),

    [Parameter()]
    [int]$MaxItems = 200,

    [Parameter()]
    [switch]$Baseline,

    [Parameter()]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8

if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw "Date must use YYYY-MM-DD format: $Date"
}
if ($MaxItems -lt 1 -or $MaxItems -gt 1000) {
    throw 'MaxItems must be between 1 and 1000.'
}

$clipboard = Get-Clipboard -Raw
if (-not $clipboard) {
    throw 'The clipboard is empty. Use XHS-Downloader to copy note links first.'
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$xhsDirectory = Join-Path $workspacePath '.xhs-tools\XHS-Downloader'
$pythonPath = Join-Path $xhsDirectory '.venv\Scripts\python.exe'
$fetcherPath = Join-Path $PSScriptRoot 'fetch-xhs-details.py'
$organizerPath = Join-Path $PSScriptRoot 'organize.mjs'

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "XHS-Downloader virtual environment was not found: $pythonPath"
}

$node = Get-Command -Name 'node' -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js was not found on PATH.'
}

$catalogPath = Join-Path $workspacePath '.xhs-favorites\catalog.json'
$reportPath = Join-Path $workspacePath "xhs-favorites\$Date.md"
$temporaryBase = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-links-" + [guid]::NewGuid().ToString('N'))
$jsonPath = "$temporaryBase.json"

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

try {
    $fetchArguments = @(
        '-X', 'utf8',
        $fetcherPath,
        '--xhs-dir', $xhsDirectory,
        '--max-items', [string]$MaxItems
    )
    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $pythonPath
    $processInfo.Arguments = ($fetchArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $processInfo.WorkingDirectory = $xhsDirectory
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.StandardOutputEncoding = $utf8
    $processInfo.StandardErrorEncoding = $utf8
    $processInfo.EnvironmentVariables['PYTHONUTF8'] = '1'

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    if (-not $process.Start()) {
        throw 'Failed to start the XHS-Downloader detail fetcher.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($clipboard)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $fetchExitCode = $process.ExitCode
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [System.IO.File]::WriteAllText($jsonPath, $stdout, $utf8)

    if ($fetchExitCode -ne 0) {
        $details = $stderr.Trim()
        if (-not $details) { $details = 'No diagnostic output was returned.' }
        $details = $details -replace '(?i)(xsec_token=)[^&\s]+', '$1[REDACTED]'
        if ($details.Length -gt 1500) {
            $details = $details.Substring(0, 1500) + '...'
        }
        throw "XHS-Downloader detail fetch failed. $details"
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
    if ($DryRun) {
        $organizerArguments += '--dry-run'
    }

    & $node.Source @organizerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "organize.mjs failed with exit code $LASTEXITCODE"
    }

    if (-not $DryRun) {
        Write-Output "Catalog: $catalogPath"
        Write-Output "Report:  $reportPath"
    }
} finally {
    Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue
}
