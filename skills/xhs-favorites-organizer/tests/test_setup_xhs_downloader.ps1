[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $ScriptPath -Raw -Encoding UTF8
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -gt 0) {
    throw "setup-xhs-downloader.ps1 did not parse: $($parseErrors[0].Message)"
}

foreach ($functionName in @(
    'Test-XhsPathIsReparsePoint',
    'Test-XhsRuntimeHealthy',
    'Assert-XhsCheckout',
    'Move-XhsDirectory',
    'Write-XhsInstallTransaction',
    'Read-XhsInstallTransaction',
    'Install-XhsDownloaderRuntime'
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if (-not $functionAst) { throw "Missing production function: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

$healthFunctionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-XhsRuntimeHealthy'
}, $true)
$healthSource = $healthFunctionAst.Extent.Text
if ($healthSource -notmatch 'sys\.version_info\[:2\].*\(3,\s*12\)') {
    throw 'The production runtime health probe no longer enforces Python 3.12.'
}
if ($healthSource -match '\bassert\b' -or $healthSource -notmatch 'sys\.exit\(1\)') {
    throw 'The production runtime health probe must enforce Python 3.12 even when assertions are optimized away.'
}
if ($healthSource -notmatch 'from source import XHS') {
    throw 'The production runtime health probe no longer imports the required XHS entry point.'
}

$healthProbeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-xhs-health-test-" + [Guid]::NewGuid().ToString('N'))
$previousBytecodeProbe = [Environment]::GetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', 'Process')
$previousOptimizeProbe = [Environment]::GetEnvironmentVariable('PYTHONOPTIMIZE', 'Process')
try {
    [System.IO.Directory]::CreateDirectory($healthProbeRoot) | Out-Null
    $healthyCommand = Join-Path $healthProbeRoot 'healthy.cmd'
    $brokenCommand = Join-Path $healthProbeRoot 'broken.cmd'
    [System.IO.File]::WriteAllText($healthyCommand, "@exit /b 0`r`n", [System.Text.ASCIIEncoding]::new())
    [System.IO.File]::WriteAllText($brokenCommand, "@exit /b 1`r`n", [System.Text.ASCIIEncoding]::new())
    [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', 'fixture-before', 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONOPTIMIZE', '2', 'Process')
    if (-not (Test-XhsRuntimeHealthy -RepositoryPath $healthProbeRoot -PythonPath $healthyCommand)) {
        throw 'The production runtime health probe rejected a successful local interpreter command.'
    }
    if (Test-XhsRuntimeHealthy -RepositoryPath $healthProbeRoot -PythonPath $brokenCommand) {
        throw 'The production runtime health probe accepted a failing local interpreter command.'
    }
    if ([Environment]::GetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', 'Process') -ne 'fixture-before') {
        throw 'The production runtime health probe did not restore its process environment.'
    }
} finally {
    [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', $previousBytecodeProbe, 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONOPTIMIZE', $previousOptimizeProbe, 'Process')
    if (Test-Path -LiteralPath $healthProbeRoot) {
        Remove-Item -LiteralPath $healthProbeRoot -Recurse -Force
    }
}

$pin = 'd805ebdd3db53f68137bc2b7a6ed118ce572d09b'
$origin = 'https://github.com/JoeanAmier/XHS-Downloader.git'
$script:XhsPinnedCommit = $pin
$script:XhsOrigin = $origin
$script:head = $pin
$script:toolCalls = [System.Collections.Generic.List[string]]::new()
$script:uvFailure = $false
$script:runtimeHealthy = $true
$script:failPromotionMove = $false

function Test-XhsRuntimeHealthy {
    param([string]$RepositoryPath, [string]$PythonPath)
    if ((Split-Path -Leaf $RepositoryPath) -eq '.XHS-Downloader.setup') { return $true }
    return $script:runtimeHealthy
}

function Move-XhsDirectory {
    param([string]$Source, [string]$Destination)
    if ($script:failPromotionMove -and (Split-Path -Leaf $Source) -eq '.XHS-Downloader.setup') {
        throw 'injected promotion move failure'
    }
    [System.IO.Directory]::Move($Source, $Destination)
}

function Invoke-XhsGit {
    param([string]$CommandPath, [string[]]$Arguments)
    $script:toolCalls.Add("git " + ($Arguments -join ' '))
    if ($Arguments[0] -eq 'init') {
        $repository = $Arguments[-1]
        [System.IO.Directory]::CreateDirectory((Join-Path $repository '.git')) | Out-Null
        return ''
    }
    $repository = $Arguments[1]
    $operation = $Arguments[2]
    if ($operation -eq 'rev-parse') { return $script:head }
    if ($operation -eq 'status') { return '' }
    if ($operation -eq 'remote' -and $Arguments[3] -eq 'get-url') { return $origin }
    return ''
}

function Invoke-XhsUv {
    param([string]$CommandPath, [string[]]$Arguments)
    $script:toolCalls.Add("uv " + ($Arguments -join ' '))
    if ($script:uvFailure) { throw 'fake uv failure' }
    $projectIndex = [Array]::IndexOf($Arguments, '--project')
    $repository = $Arguments[$projectIndex + 1]
    $pythonPath = Join-Path $repository '.venv\Scripts\python.exe'
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $pythonPath)) | Out-Null
    [System.IO.File]::WriteAllText($pythonPath, 'fixture', [System.Text.UTF8Encoding]::new($false))
    return ''
}

function Write-TestInstallJournal {
    param(
        [Parameter(Mandatory)][string]$ToolsPath,
        [Parameter(Mandatory)][string]$Phase
    )
    $record = @{
        version = 1
        transaction_id = [Guid]::NewGuid().ToString('N')
        phase = $Phase
        target = [System.IO.Path]::GetFullPath((Join-Path $ToolsPath 'XHS-Downloader'))
        stage = [System.IO.Path]::GetFullPath((Join-Path $ToolsPath '.XHS-Downloader.setup'))
        backup = [System.IO.Path]::GetFullPath((Join-Path $ToolsPath '.XHS-Downloader.backup'))
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $ToolsPath '.xhs-downloader-transaction.json'),
        (($record | ConvertTo-Json -Compress) + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-xhs-runtime-test-" + [Guid]::NewGuid().ToString('N'))
try {
    $workspace = Join-Path $fixtureRoot 'workspace'
    [System.IO.Directory]::CreateDirectory($workspace) | Out-Null
    $installed = Install-XhsDownloaderRuntime -WorkspacePath $workspace -GitCommand 'fake-git' -UvCommand 'fake-uv'
    $pythonPath = Join-Path $installed '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
        throw 'The pinned runtime was not promoted after the fake locked install completed.'
    }
    $calls = $script:toolCalls -join "`n"
    if ($calls -notmatch [regex]::Escape("fetch --depth 1 origin $pin")) {
        throw 'The exact reviewed commit was not fetched.'
    }
    if ($calls -notmatch 'uv sync .*--locked .*--no-dev .*--python 3\.12') {
        throw 'The runtime was not installed from the lock file with Python 3.12.'
    }

    $wrongWorkspace = Join-Path $fixtureRoot 'wrong-pin'
    $wrongTarget = Join-Path $wrongWorkspace '.xhs-tools\XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $wrongTarget '.git')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $wrongTarget 'keep.txt'), 'keep', [System.Text.UTF8Encoding]::new($false))
    $script:head = '0000000000000000000000000000000000000000'
    $beforeUvCalls = @($script:toolCalls | Where-Object { $_ -like 'uv *' }).Count
    $wrongPinRefused = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $wrongWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $wrongPinRefused = $_.Exception.Message -match 'revision|commit|supported'
    }
    if (-not $wrongPinRefused) { throw 'An existing checkout at the wrong commit was accepted.' }
    if (-not (Test-Path -LiteralPath (Join-Path $wrongTarget 'keep.txt') -PathType Leaf)) {
        throw 'The rejected existing checkout was mutated.'
    }
    if (@($script:toolCalls | Where-Object { $_ -like 'uv *' }).Count -ne $beforeUvCalls) {
        throw 'Dependency installation ran after the existing checkout failed pin verification.'
    }

    $failedWorkspace = Join-Path $fixtureRoot 'failed-install'
    [System.IO.Directory]::CreateDirectory($failedWorkspace) | Out-Null
    $script:head = $pin
    $script:uvFailure = $true
    $installFailure = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $failedWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $installFailure = $_.Exception.Message -match 'fake uv failure'
    }
    if (-not $installFailure) { throw 'A failed dependency install was reported as success.' }
    if (Test-Path -LiteralPath (Join-Path $failedWorkspace '.xhs-tools\XHS-Downloader')) {
        throw 'A failed staging checkout was promoted into the live runtime path.'
    }
    foreach ($debrisName in @('.XHS-Downloader.setup', '.XHS-Downloader.backup', '.xhs-downloader-transaction.json')) {
        if (Test-Path -LiteralPath (Join-Path $failedWorkspace ".xhs-tools\$debrisName")) {
            throw 'A failed installer left private transaction debris behind.'
        }
    }

    $repairWorkspace = Join-Path $fixtureRoot 'failed-repair'
    $repairTarget = Join-Path $repairWorkspace '.xhs-tools\XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $repairTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $repairTarget '.venv\Scripts')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $repairTarget '.venv\Scripts\python.exe'), 'broken fixture', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $repairTarget 'existing-runtime.txt'), 'preserve', [System.Text.UTF8Encoding]::new($false))
    $script:runtimeHealthy = $false
    $repairFailed = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $repairWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $repairFailed = $_.Exception.Message -match 'fake uv failure'
    }
    if (-not $repairFailed) { throw 'A failed repair was reported as success.' }
    if ((Get-Content -LiteralPath (Join-Path $repairTarget 'existing-runtime.txt') -Raw) -ne 'preserve') {
        throw 'A failed repair mutated the existing pinned checkout.'
    }
    foreach ($debrisName in @('.XHS-Downloader.setup', '.XHS-Downloader.backup', '.xhs-downloader-transaction.json')) {
        if (Test-Path -LiteralPath (Join-Path $repairWorkspace ".xhs-tools\$debrisName")) {
            throw 'A failed repair left staging, backup, or journal debris behind.'
        }
    }

    $successfulRepairWorkspace = Join-Path $fixtureRoot 'successful-repair'
    $successfulRepairTarget = Join-Path $successfulRepairWorkspace '.xhs-tools\XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $successfulRepairTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $successfulRepairTarget '.venv\Scripts')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $successfulRepairTarget '.venv\Scripts\python.exe'), 'broken fixture', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $successfulRepairTarget 'old-marker.txt'), 'old runtime', [System.Text.UTF8Encoding]::new($false))
    $script:uvFailure = $false
    $script:runtimeHealthy = $false
    $successfulRepairResult = Install-XhsDownloaderRuntime -WorkspacePath $successfulRepairWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv'
    if ($successfulRepairResult -ne $successfulRepairTarget -or
        (Test-Path -LiteralPath (Join-Path $successfulRepairTarget 'old-marker.txt'))) {
        throw 'A successful repair did not atomically replace the unhealthy runtime.'
    }
    foreach ($debrisName in @('.XHS-Downloader.setup', '.XHS-Downloader.backup', '.xhs-downloader-transaction.json')) {
        if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $successfulRepairTarget) $debrisName)) {
            throw 'A successful repair left transaction debris behind.'
        }
    }

    $rollbackWorkspace = Join-Path $fixtureRoot 'promotion-rollback'
    $rollbackTarget = Join-Path $rollbackWorkspace '.xhs-tools\XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $rollbackTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $rollbackTarget '.venv\Scripts')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $rollbackTarget '.venv\Scripts\python.exe'), 'broken fixture', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $rollbackTarget 'old-marker.txt'), 'preserve exactly', [System.Text.UTF8Encoding]::new($false))
    $script:failPromotionMove = $true
    $promotionFailed = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $rollbackWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $promotionFailed = $_.Exception.Message -match 'injected promotion move failure'
    }
    $script:failPromotionMove = $false
    if (-not $promotionFailed) { throw 'An injected promotion failure was reported as success.' }
    if ((Get-Content -LiteralPath (Join-Path $rollbackTarget 'old-marker.txt') -Raw) -ne 'preserve exactly') {
        throw 'A failed promotion did not restore the previous runtime exactly.'
    }
    foreach ($debrisName in @('.XHS-Downloader.setup', '.XHS-Downloader.backup', '.xhs-downloader-transaction.json')) {
        if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $rollbackTarget) $debrisName)) {
            throw 'A failed promotion left transaction debris behind.'
        }
    }

    $healthyWorkspace = Join-Path $fixtureRoot 'healthy-existing'
    $healthyTarget = Join-Path $healthyWorkspace '.xhs-tools\XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $healthyTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $healthyTarget '.venv\Scripts')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $healthyTarget '.venv\Scripts\python.exe'), 'healthy fixture', [System.Text.UTF8Encoding]::new($false))
    $script:runtimeHealthy = $true
    $script:uvFailure = $false
    $beforeHealthyUvCalls = @($script:toolCalls | Where-Object { $_ -like 'uv *' }).Count
    $healthyResult = Install-XhsDownloaderRuntime -WorkspacePath $healthyWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv'
    if ($healthyResult -ne $healthyTarget) { throw 'A healthy existing runtime was not reused.' }
    if (@($script:toolCalls | Where-Object { $_ -like 'uv *' }).Count -ne $beforeHealthyUvCalls) {
        throw 'A healthy existing runtime unnecessarily reinstalled dependencies.'
    }

    $lockWorkspace = Join-Path $fixtureRoot 'installer-lock'
    $lockTools = Join-Path $lockWorkspace '.xhs-tools'
    [System.IO.Directory]::CreateDirectory($lockTools) | Out-Null
    $lockPath = Join-Path $lockTools '.xhs-downloader-install.lock'
    $heldLock = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $beforeLockCalls = $script:toolCalls.Count
    try {
        $lockRefused = $false
        try {
            Install-XhsDownloaderRuntime -WorkspacePath $lockWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
        } catch {
            $lockRefused = $_.Exception.Message -match 'already running'
        }
        if (-not $lockRefused) { throw 'A concurrent installer was not rejected by the real file lock.' }
    } finally {
        $heldLock.Dispose()
    }
    if ($script:toolCalls.Count -ne $beforeLockCalls) {
        throw 'The rejected concurrent installer invoked Git or uv.'
    }
    foreach ($debrisName in @('XHS-Downloader', '.XHS-Downloader.setup', '.XHS-Downloader.backup', '.xhs-downloader-transaction.json')) {
        if (Test-Path -LiteralPath (Join-Path $lockTools $debrisName)) {
            throw 'The rejected concurrent installer mutated runtime transaction paths.'
        }
    }

    $unownedWorkspace = Join-Path $fixtureRoot 'unowned-reserved'
    $unownedTools = Join-Path $unownedWorkspace '.xhs-tools'
    $unownedStage = Join-Path $unownedTools '.XHS-Downloader.setup'
    $unownedBackup = Join-Path $unownedTools '.XHS-Downloader.backup'
    [System.IO.Directory]::CreateDirectory($unownedStage) | Out-Null
    [System.IO.Directory]::CreateDirectory($unownedBackup) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $unownedStage 'keep.txt'), 'stage keep', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $unownedBackup 'keep.txt'), 'backup keep', [System.Text.UTF8Encoding]::new($false))
    $unownedRefused = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $unownedWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $unownedRefused = $_.Exception.Message -match 'ownership journal'
    }
    if (-not $unownedRefused -or
        (Get-Content -LiteralPath (Join-Path $unownedStage 'keep.txt') -Raw) -ne 'stage keep' -or
        (Get-Content -LiteralPath (Join-Path $unownedBackup 'keep.txt') -Raw) -ne 'backup keep') {
        throw 'Unowned reserved installer directories were not preserved fail-closed.'
    }

    $restoreWorkspace = Join-Path $fixtureRoot 'crash-restore'
    $restoreTools = Join-Path $restoreWorkspace '.xhs-tools'
    $restoreStage = Join-Path $restoreTools '.XHS-Downloader.setup'
    $restoreBackup = Join-Path $restoreTools '.XHS-Downloader.backup'
    [System.IO.Directory]::CreateDirectory((Join-Path $restoreBackup '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory($restoreStage) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $restoreBackup 'old-marker.txt'), 'restored old runtime', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $restoreStage 'partial.txt'), 'discard partial', [System.Text.UTF8Encoding]::new($false))
    Write-TestInstallJournal -ToolsPath $restoreTools -Phase 'old-moved'
    $script:runtimeHealthy = $false
    $script:uvFailure = $true
    $restoreInstallFailed = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $restoreWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $restoreInstallFailed = $_.Exception.Message -match 'fake uv failure'
    }
    $restoredTarget = Join-Path $restoreTools 'XHS-Downloader'
    if (-not $restoreInstallFailed -or
        (Get-Content -LiteralPath (Join-Path $restoredTarget 'old-marker.txt') -Raw) -ne 'restored old runtime' -or
        (Test-Path -LiteralPath $restoreStage) -or
        (Test-Path -LiteralPath $restoreBackup) -or
        (Test-Path -LiteralPath (Join-Path $restoreTools '.xhs-downloader-transaction.json'))) {
        throw 'A crash between backup and promotion did not restore the owned runtime cleanly.'
    }

    $committedWorkspace = Join-Path $fixtureRoot 'crash-committed'
    $committedTools = Join-Path $committedWorkspace '.xhs-tools'
    $committedTarget = Join-Path $committedTools 'XHS-Downloader'
    $committedBackup = Join-Path $committedTools '.XHS-Downloader.backup'
    [System.IO.Directory]::CreateDirectory((Join-Path $committedTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $committedTarget '.venv\Scripts')) | Out-Null
    [System.IO.Directory]::CreateDirectory($committedBackup) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $committedTarget '.venv\Scripts\python.exe'), 'healthy', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $committedTarget 'live-marker.txt'), 'new runtime', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $committedBackup 'old-marker.txt'), 'old runtime', [System.Text.UTF8Encoding]::new($false))
    Write-TestInstallJournal -ToolsPath $committedTools -Phase 'committed'
    $script:runtimeHealthy = $true
    $script:uvFailure = $false
    Install-XhsDownloaderRuntime -WorkspacePath $committedWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    if ((Get-Content -LiteralPath (Join-Path $committedTarget 'live-marker.txt') -Raw) -ne 'new runtime' -or
        (Test-Path -LiteralPath $committedBackup) -or
        (Test-Path -LiteralPath (Join-Path $committedTools '.xhs-downloader-transaction.json'))) {
        throw 'A committed crash state did not retain the promoted runtime and clean its owned backup.'
    }

    $ambiguousWorkspace = Join-Path $fixtureRoot 'crash-ambiguous'
    $ambiguousTools = Join-Path $ambiguousWorkspace '.xhs-tools'
    foreach ($name in @('XHS-Downloader', '.XHS-Downloader.setup', '.XHS-Downloader.backup')) {
        $candidate = Join-Path $ambiguousTools $name
        [System.IO.Directory]::CreateDirectory($candidate) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $candidate 'keep.txt'), $name, [System.Text.UTF8Encoding]::new($false))
    }
    Write-TestInstallJournal -ToolsPath $ambiguousTools -Phase 'old-moved'
    $ambiguousRefused = $false
    try {
        Install-XhsDownloaderRuntime -WorkspacePath $ambiguousWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    } catch {
        $ambiguousRefused = $_.Exception.Message -match 'ambiguous'
    }
    if (-not $ambiguousRefused) { throw 'An ambiguous crash state was not rejected.' }
    foreach ($name in @('XHS-Downloader', '.XHS-Downloader.setup', '.XHS-Downloader.backup')) {
        if ((Get-Content -LiteralPath (Join-Path $ambiguousTools "$name\keep.txt") -Raw) -ne $name) {
            throw 'An ambiguous crash state was mutated.'
        }
    }

    $orphanTempWorkspace = Join-Path $fixtureRoot 'orphan-journal-temp'
    $orphanTempTools = Join-Path $orphanTempWorkspace '.xhs-tools'
    $orphanTempTarget = Join-Path $orphanTempTools 'XHS-Downloader'
    [System.IO.Directory]::CreateDirectory((Join-Path $orphanTempTarget '.git')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $orphanTempTarget '.venv\Scripts')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $orphanTempTarget '.venv\Scripts\python.exe'), 'healthy', [System.Text.UTF8Encoding]::new($false))
    $orphanWrite = Join-Path $orphanTempTools ('.xhs-downloader-transaction.json.' + ('a' * 32) + '.tmp')
    $orphanReplace = Join-Path $orphanTempTools ('.xhs-downloader-transaction.json.replace-' + ('b' * 32) + '.bak')
    [System.IO.File]::WriteAllText($orphanWrite, 'partial', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($orphanReplace, 'old journal', [System.Text.UTF8Encoding]::new($false))
    $script:runtimeHealthy = $true
    Install-XhsDownloaderRuntime -WorkspacePath $orphanTempWorkspace -GitCommand 'fake-git' -UvCommand 'fake-uv' | Out-Null
    if ((Test-Path -LiteralPath $orphanWrite) -or (Test-Path -LiteralPath $orphanReplace)) {
        throw 'Owned atomic journal temporary files were not reclaimed under the installer lock.'
    }

    Write-Output 'Pinned XHS-Downloader checkout, real installer lock, ownership journal crash recovery, and transactional install/repair cleanup were accepted.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
