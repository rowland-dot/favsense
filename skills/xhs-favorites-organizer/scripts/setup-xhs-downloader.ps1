[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [string]$GitCommand = 'git',

    [Parameter()]
    [string]$UvCommand = 'uv'
)

$ErrorActionPreference = 'Stop'
$script:XhsPinnedCommit = 'd805ebdd3db53f68137bc2b7a6ed118ce572d09b'
$script:XhsOrigin = 'https://github.com/JoeanAmier/XHS-Downloader.git'

function Test-XhsPathIsReparsePoint {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null -ne $item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Invoke-XhsGit {
    param(
        [Parameter(Mandatory)][string]$CommandPath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $output = @(& $CommandPath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'Git could not prepare or verify the pinned XHS-Downloader runtime.'
    }
    return ($output -join "`n").Trim()
}

function Invoke-XhsUv {
    param(
        [Parameter(Mandatory)][string]$CommandPath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $command = Get-Command -Name $CommandPath -ErrorAction SilentlyContinue
    if (-not $command) {
        throw 'uv was not found. Install uv, then run FavSense setup again.'
    }
    $executable = [string]$command.Source
    if ([string]::IsNullOrWhiteSpace($executable)) { $executable = [string]$command.Path }
    if ([string]::IsNullOrWhiteSpace($executable)) { $executable = [string]$command.Name }
    $output = @(& $executable @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'uv could not install the pinned XHS-Downloader lock file.'
    }
    return ($output -join "`n").Trim()
}

function Test-XhsRuntimeHealthy {
    param(
        [Parameter(Mandatory)][string]$RepositoryPath,
        [Parameter(Mandatory)][string]$PythonPath
    )
    $previousBytecode = [Environment]::GetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', 'Process')
    $previousLocation = Get-Location
    try {
        [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', '1', 'Process')
        Set-Location -LiteralPath $RepositoryPath
        & $PythonPath -X utf8 -c 'import sys; sys.exit(1) if sys.version_info[:2] != (3, 12) else None; from source import XHS' 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        Set-Location -LiteralPath $previousLocation
        [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', $previousBytecode, 'Process')
    }
}

function Assert-XhsCheckout {
    param(
        [Parameter(Mandatory)][string]$RepositoryPath,
        [Parameter(Mandatory)][string]$GitCommand
    )
    if (-not (Test-Path -LiteralPath $RepositoryPath -PathType Container) -or
        (Test-XhsPathIsReparsePoint -Path $RepositoryPath)) {
        throw 'The XHS-Downloader checkout is missing or redirected.'
    }
    $gitDirectory = Join-Path $RepositoryPath '.git'
    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container) -or
        (Test-XhsPathIsReparsePoint -Path $gitDirectory)) {
        throw 'The XHS-Downloader Git metadata is missing or redirected.'
    }
    $head = (Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $RepositoryPath, 'rev-parse', 'HEAD')).Trim()
    if ($head -ne $script:XhsPinnedCommit) {
        throw "The XHS-Downloader checkout is not at the supported revision $($script:XhsPinnedCommit)."
    }
    $origin = (Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $RepositoryPath, 'remote', 'get-url', 'origin')).Trim()
    if ($origin -ne $script:XhsOrigin) {
        throw 'The XHS-Downloader checkout does not use the reviewed upstream repository.'
    }
    $dirty = (Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $RepositoryPath, 'status', '--porcelain')).Trim()
    if ($dirty) {
        throw 'The XHS-Downloader checkout has modified or untracked files; refusing to overwrite it.'
    }
}

function Move-XhsDirectory {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    [System.IO.Directory]::Move($Source, $Destination)
}

function Write-XhsInstallTransaction {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Record
    )
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $replacementBackup = $Path + '.replace-' + [Guid]::NewGuid().ToString('N') + '.bak'
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            (($Record | ConvertTo-Json -Compress) + "`n"),
            [System.Text.UTF8Encoding]::new($false)
        )
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [System.IO.File]::Replace($temporary, $Path, $replacementBackup, $true)
        } else {
            [System.IO.File]::Move($temporary, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $replacementBackup) { Remove-Item -LiteralPath $replacementBackup -Force }
    }
}

function Read-XhsInstallTransaction {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Test-XhsPathIsReparsePoint -Path $Path)) {
        throw 'The XHS-Downloader transaction journal is missing or redirected.'
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw 'The XHS-Downloader transaction journal is invalid; no files were changed.'
    }
}

function Install-XhsDownloaderRuntime {
    param(
        [Parameter(Mandatory)][string]$WorkspacePath,
        [Parameter(Mandatory)][string]$GitCommand,
        [Parameter(Mandatory)][string]$UvCommand
    )
    $workspaceFullPath = [System.IO.Path]::GetFullPath($WorkspacePath).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $workspaceFullPath -PathType Container) -or
        (Test-XhsPathIsReparsePoint -Path $workspaceFullPath)) {
        throw 'The FavSense workspace is missing or redirected.'
    }
    $toolsPath = Join-Path $workspaceFullPath '.xhs-tools'
    if (Test-Path -LiteralPath $toolsPath) {
        if (-not (Test-Path -LiteralPath $toolsPath -PathType Container) -or
            (Test-XhsPathIsReparsePoint -Path $toolsPath)) {
            throw 'The private tools directory is redirected or invalid.'
        }
    } else {
        [System.IO.Directory]::CreateDirectory($toolsPath) | Out-Null
    }

    $lockPath = Join-Path $toolsPath '.xhs-downloader-install.lock'
    if ((Test-Path -LiteralPath $lockPath) -and (Test-XhsPathIsReparsePoint -Path $lockPath)) {
        throw 'The XHS-Downloader installer lock is redirected.'
    }
    try {
        $installLock = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw 'Another XHS-Downloader setup is already running.'
    }

    try {
    $targetPath = Join-Path $toolsPath 'XHS-Downloader'
    $targetVenvPath = Join-Path $targetPath '.venv'
    $targetScriptsPath = Join-Path $targetVenvPath 'Scripts'
    $targetPythonPath = Join-Path $targetScriptsPath 'python.exe'
    $installPath = Join-Path $toolsPath '.XHS-Downloader.setup'
    $backupPath = Join-Path $toolsPath '.XHS-Downloader.backup'
    $transactionPath = Join-Path $toolsPath '.xhs-downloader-transaction.json'

    # A hard stop can leave only the journal's atomic-write temporary file.
    # The exclusive installer lock makes it safe to reclaim files that match
    # this installer's exact, non-recursive naming contract.
    $transactionTemporaryPattern = '^(?:\.xhs-downloader-transaction\.json\.[a-f0-9]{32}\.tmp|\.xhs-downloader-transaction\.json\.replace-[a-f0-9]{32}\.bak)$'
    foreach ($temporaryJournal in @(Get-ChildItem -LiteralPath $toolsPath -Force -File -ErrorAction Stop)) {
        if ($temporaryJournal.Name -notmatch $transactionTemporaryPattern) { continue }
        if (($temporaryJournal.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'An XHS-Downloader transaction temporary file is redirected; no files were changed.'
        }
        Remove-Item -LiteralPath $temporaryJournal.FullName -Force
    }

    foreach ($privateDirectory in @($installPath, $backupPath)) {
        if ((Test-Path -LiteralPath $privateDirectory) -and
            (-not (Test-Path -LiteralPath $privateDirectory -PathType Container) -or
             (Test-XhsPathIsReparsePoint -Path $privateDirectory))) {
            throw 'An interrupted XHS-Downloader transaction is redirected or invalid.'
        }
    }
    $hasInterruptedStage = Test-Path -LiteralPath $installPath -PathType Container
    $hasInterruptedBackup = Test-Path -LiteralPath $backupPath -PathType Container
    $hasLiveTarget = Test-Path -LiteralPath $targetPath
    $hasTransaction = Test-Path -LiteralPath $transactionPath
    if (($hasInterruptedStage -or $hasInterruptedBackup) -and -not $hasTransaction) {
        throw 'Reserved XHS-Downloader transaction directories exist without an ownership journal; no files were changed.'
    }
    if ($hasTransaction) {
        $transaction = Read-XhsInstallTransaction -Path $transactionPath
        if ($transaction.version -ne 1 -or
            [string]::IsNullOrWhiteSpace([string]$transaction.transaction_id) -or
            @('building', 'prepared', 'old-moved', 'committed') -notcontains [string]$transaction.phase -or
            [System.IO.Path]::GetFullPath([string]$transaction.target) -ne [System.IO.Path]::GetFullPath($targetPath) -or
            [System.IO.Path]::GetFullPath([string]$transaction.stage) -ne [System.IO.Path]::GetFullPath($installPath) -or
            [System.IO.Path]::GetFullPath([string]$transaction.backup) -ne [System.IO.Path]::GetFullPath($backupPath)) {
            throw 'The XHS-Downloader transaction journal does not match this installation; no files were changed.'
        }
    }
    if ($hasInterruptedBackup -and $hasTransaction) {
        if ($hasLiveTarget) {
            if ($hasInterruptedStage) {
                throw 'An interrupted XHS-Downloader transaction is ambiguous; no files were changed.'
            }
            Assert-XhsCheckout -RepositoryPath $targetPath -GitCommand $GitCommand
            foreach ($runtimeDirectory in @($targetVenvPath, $targetScriptsPath)) {
                if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container) -or
                    (Test-XhsPathIsReparsePoint -Path $runtimeDirectory)) {
                    throw 'The promoted XHS-Downloader runtime is incomplete; its backup was preserved.'
                }
            }
            if (-not (Test-Path -LiteralPath $targetPythonPath -PathType Leaf) -or
                (Test-XhsPathIsReparsePoint -Path $targetPythonPath) -or
                -not (Test-XhsRuntimeHealthy -RepositoryPath $targetPath -PythonPath $targetPythonPath)) {
                throw 'The promoted XHS-Downloader runtime is unhealthy; its backup was preserved.'
            }
            Remove-Item -LiteralPath $backupPath -Recurse -Force
            Remove-Item -LiteralPath $transactionPath -Force
        } else {
            Assert-XhsCheckout -RepositoryPath $backupPath -GitCommand $GitCommand
            Move-XhsDirectory -Source $backupPath -Destination $targetPath
            if ($hasInterruptedStage) { Remove-Item -LiteralPath $installPath -Recurse -Force }
            Remove-Item -LiteralPath $transactionPath -Force
        }
    } elseif ($hasInterruptedStage -and $hasTransaction) {
        Remove-Item -LiteralPath $installPath -Recurse -Force
        Remove-Item -LiteralPath $transactionPath -Force
    } elseif ($hasTransaction) {
        Remove-Item -LiteralPath $transactionPath -Force
    }

    $existingPythonPresent = $false
    $existingRuntimeHealthy = $false
    if (Test-Path -LiteralPath $targetPath) {
        Assert-XhsCheckout -RepositoryPath $targetPath -GitCommand $GitCommand
        $existingPythonPresent = Test-Path -LiteralPath $targetPythonPath -PathType Leaf
        if ($existingPythonPresent) {
            foreach ($runtimeDirectory in @($targetVenvPath, $targetScriptsPath)) {
                if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container) -or
                    (Test-XhsPathIsReparsePoint -Path $runtimeDirectory)) {
                    throw 'The existing XHS-Downloader virtual environment is redirected or incomplete.'
                }
            }
            if (Test-XhsPathIsReparsePoint -Path $targetPythonPath) {
                throw 'The XHS-Downloader Python runtime is redirected.'
            }
            $existingRuntimeHealthy = Test-XhsRuntimeHealthy -RepositoryPath $targetPath -PythonPath $targetPythonPath
            if ($existingRuntimeHealthy) {
                return $targetPath
            }
        }
    }

    $replaceExisting = Test-Path -LiteralPath $targetPath
    $installTransaction = @{
        version = 1
        transaction_id = [Guid]::NewGuid().ToString('N')
        phase = 'building'
        target = [System.IO.Path]::GetFullPath($targetPath)
        stage = [System.IO.Path]::GetFullPath($installPath)
        backup = [System.IO.Path]::GetFullPath($backupPath)
    }
    Write-XhsInstallTransaction -Path $transactionPath -Record $installTransaction
    $createdStaging = $true
    $previousCache = [Environment]::GetEnvironmentVariable('UV_CACHE_DIR', 'Process')
    $previousPythonInstall = [Environment]::GetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', 'Process')
    try {
        $null = Invoke-XhsGit -CommandPath $GitCommand -Arguments @('init', '--quiet', $installPath)
        $null = Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $installPath, 'remote', 'add', 'origin', $script:XhsOrigin)
        $null = Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $installPath, 'fetch', '--depth', '1', 'origin', $script:XhsPinnedCommit)
        $null = Invoke-XhsGit -CommandPath $GitCommand -Arguments @('-C', $installPath, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
        Assert-XhsCheckout -RepositoryPath $installPath -GitCommand $GitCommand

        $cachePath = Join-Path $toolsPath 'uv-cache'
        $pythonInstallPath = Join-Path $toolsPath 'uv-python'
        foreach ($privateRuntimePath in @($cachePath, $pythonInstallPath)) {
            if (Test-Path -LiteralPath $privateRuntimePath) {
                if (-not (Test-Path -LiteralPath $privateRuntimePath -PathType Container) -or
                    (Test-XhsPathIsReparsePoint -Path $privateRuntimePath)) {
                    throw 'A private uv runtime directory is redirected or invalid.'
                }
            } else {
                [System.IO.Directory]::CreateDirectory($privateRuntimePath) | Out-Null
            }
        }
        [Environment]::SetEnvironmentVariable('UV_CACHE_DIR', $cachePath, 'Process')
        [Environment]::SetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', $pythonInstallPath, 'Process')
        $null = Invoke-XhsUv -CommandPath $UvCommand -Arguments @(
            'sync', '--project', $installPath, '--locked', '--no-dev', '--python', '3.12'
        )
        $stagingVenvPath = Join-Path $installPath '.venv'
        $stagingScriptsPath = Join-Path $stagingVenvPath 'Scripts'
        $installedPython = Join-Path $stagingScriptsPath 'python.exe'
        foreach ($runtimeDirectory in @($stagingVenvPath, $stagingScriptsPath)) {
            if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container) -or
                (Test-XhsPathIsReparsePoint -Path $runtimeDirectory)) {
                throw 'The pinned XHS-Downloader virtual environment is redirected or incomplete.'
            }
        }
        if (-not (Test-Path -LiteralPath $installedPython -PathType Leaf) -or
            (Test-XhsPathIsReparsePoint -Path $installedPython)) {
            throw 'The pinned XHS-Downloader Python runtime was not created safely.'
        }
        if (-not (Test-XhsRuntimeHealthy -RepositoryPath $installPath -PythonPath $installedPython)) {
            throw 'The pinned XHS-Downloader Python runtime failed its local import health check.'
        }
        Assert-XhsCheckout -RepositoryPath $installPath -GitCommand $GitCommand

        $installTransaction.phase = 'prepared'
        Write-XhsInstallTransaction -Path $transactionPath -Record $installTransaction

        $targetStillExists = Test-Path -LiteralPath $targetPath
        if ($targetStillExists -ne $replaceExisting) {
            throw 'The XHS-Downloader runtime path changed during setup; refusing to overwrite it.'
        }
        if ($replaceExisting) {
            Assert-XhsCheckout -RepositoryPath $targetPath -GitCommand $GitCommand
            $pythonStillPresent = Test-Path -LiteralPath $targetPythonPath -PathType Leaf
            if ($pythonStillPresent -ne $existingPythonPresent) {
                throw 'The existing XHS-Downloader runtime changed during setup; refusing to overwrite it.'
            }
            if ($pythonStillPresent) {
                foreach ($runtimeDirectory in @($targetVenvPath, $targetScriptsPath)) {
                    if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container) -or
                        (Test-XhsPathIsReparsePoint -Path $runtimeDirectory)) {
                        throw 'The existing XHS-Downloader runtime changed during setup; refusing to overwrite it.'
                    }
                }
                if ((Test-XhsPathIsReparsePoint -Path $targetPythonPath) -or
                    ((Test-XhsRuntimeHealthy -RepositoryPath $targetPath -PythonPath $targetPythonPath) -ne $existingRuntimeHealthy)) {
                    throw 'The existing XHS-Downloader runtime changed during setup; refusing to overwrite it.'
                }
            }
        }
        $movedExisting = $false
        if ($replaceExisting) {
            Move-XhsDirectory -Source $targetPath -Destination $backupPath
            $movedExisting = $true
            $installTransaction.phase = 'old-moved'
            Write-XhsInstallTransaction -Path $transactionPath -Record $installTransaction
        }
        try {
            Move-XhsDirectory -Source $installPath -Destination $targetPath
            $installTransaction.phase = 'committed'
            Write-XhsInstallTransaction -Path $transactionPath -Record $installTransaction
        } catch {
            if ($movedExisting -and -not (Test-Path -LiteralPath $targetPath) -and (Test-Path -LiteralPath $backupPath)) {
                Move-XhsDirectory -Source $backupPath -Destination $targetPath
                $movedExisting = $false
            }
            throw
        }
        if ($movedExisting -and (Test-Path -LiteralPath $backupPath)) {
            try {
                Remove-Item -LiteralPath $backupPath -Recurse -Force
            } catch {
                Write-Warning 'The pinned runtime is ready, but a private installer backup is still in use and could not be removed.'
            }
        }
        if (-not (Test-Path -LiteralPath $backupPath) -and (Test-Path -LiteralPath $transactionPath)) {
            Remove-Item -LiteralPath $transactionPath -Force
        }
        return $targetPath
    } finally {
        [Environment]::SetEnvironmentVariable('UV_CACHE_DIR', $previousCache, 'Process')
        [Environment]::SetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', $previousPythonInstall, 'Process')
        if ($createdStaging -and (Test-Path -LiteralPath $installPath)) {
            Remove-Item -LiteralPath $installPath -Recurse -Force
        }
        if (-not (Test-Path -LiteralPath $backupPath) -and
            (Test-Path -LiteralPath $targetPath) -eq $replaceExisting -and
            (Test-Path -LiteralPath $transactionPath)) {
            Remove-Item -LiteralPath $transactionPath -Force
        }
    }
    } finally {
        $installLock.Dispose()
    }
}

$git = Get-Command -Name $GitCommand -ErrorAction SilentlyContinue
if (-not $git) { throw 'Git was not found. Install Git, then run FavSense setup again.' }
$gitPath = [string]$git.Source
if ([string]::IsNullOrWhiteSpace($gitPath)) { $gitPath = [string]$git.Path }
if ([string]::IsNullOrWhiteSpace($gitPath)) { $gitPath = [string]$git.Name }
Install-XhsDownloaderRuntime -WorkspacePath $Workspace -GitCommand $gitPath -UvCommand $UvCommand | Out-Null
Write-Output 'Pinned XHS-Downloader runtime is ready.'
