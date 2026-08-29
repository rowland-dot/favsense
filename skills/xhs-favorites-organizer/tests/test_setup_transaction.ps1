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
    throw "setup-autosync.ps1 did not parse: $($parseErrors[0].Message)"
}

foreach ($functionName in @(
    'Assert-SetupDirectory',
    'Enter-FavSenseSetupLock',
    'Invoke-FavSenseSetupUnderLock',
    'Get-SetupFileSnapshot',
    'Restore-SetupFileSnapshot',
    'Set-SetupFileBytesAtomically',
    'Get-ManagedSetupTemporaryFiles',
    'Get-BridgeUserscriptTemporaryFiles',
    'Get-SetupTemporaryFiles',
    'Remove-OrphanedSetupTemporaryFiles',
    'Remove-OrphanedBridgeUserscriptTemporaryFiles',
    'Remove-NewSetupTemporaryFiles',
    'Get-FavSenseSetupServiceState',
    'Invoke-SetupCredentialTransaction'
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if (-not $functionAst) {
        throw "Missing production transaction function: $functionName"
    }
    Invoke-Expression $functionAst.Extent.Text
}

$transactionFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-SetupCredentialTransaction'
}, $true).Extent.Text
$transactionStopIndex = $transactionFunction.IndexOf('& $StopAction', [System.StringComparison]::Ordinal)
$bridgeTemporaryCleanupIndex = $transactionFunction.IndexOf(
    'Remove-OrphanedBridgeUserscriptTemporaryFiles',
    [System.StringComparison]::Ordinal
)
if ($transactionStopIndex -lt 0 -or
    $bridgeTemporaryCleanupIndex -lt 0 -or
    $transactionStopIndex -ge $bridgeTemporaryCleanupIndex) {
    throw 'Bridge userscript temporaries are not cleaned strictly after the old bridge stop succeeds.'
}

$setupInvocationIndex = $source.LastIndexOf('Invoke-FavSenseSetupUnderLock -StateDirectory', [System.StringComparison]::Ordinal)
if ($setupInvocationIndex -lt 0) {
    throw 'The production setup path is not guarded by the setup lock wrapper.'
}
foreach ($sideEffectMarker in @(
    '$channel = Resolve-SopBrowserChannel',
    'Ensure-SopBrowserChannel -Channel $channel',
    '$tampermonkeyInstalled = Test-SopTampermonkeyInstallation',
    'Open-SopBrowserTab -Channel $channel',
    "Get-ScheduledTask -TaskName 'FavSense-Daily'",
    "Join-Path `$PSScriptRoot 'setup-xhs-downloader.ps1'",
    '$tokenBytes ='
)) {
    $sideEffectIndex = $source.LastIndexOf($sideEffectMarker, [System.StringComparison]::Ordinal)
    if ($sideEffectIndex -lt 0 -or $setupInvocationIndex -ge $sideEffectIndex) {
        throw "Setup can reach '$sideEffectMarker' before acquiring its exclusive lock."
    }
}

$script:lockContentionSideEffects = 0
$lockContentionRefused = $false
try {
    Invoke-FavSenseSetupUnderLock `
        -StateDirectory 'C:\fixture-state' `
        -LockAction { param([string]$Path) throw 'simulated setup lock contention' } `
        -SetupAction { $script:lockContentionSideEffects += 1 }
} catch {
    $lockContentionRefused = $_.Exception.Message -eq 'simulated setup lock contention'
}
if (-not $lockContentionRefused -or $script:lockContentionSideEffects -ne 0) {
    throw 'Lock contention did not stop the production setup action before its first side effect.'
}

$favsensePath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ScriptPath) '..\..\..\favsense.ps1'))
$favsenseSource = Get-Content -LiteralPath $favsensePath -Raw -Encoding UTF8
$favsenseTokens = $null
$favsenseParseErrors = $null
$favsenseAst = [System.Management.Automation.Language.Parser]::ParseInput(
    $favsenseSource,
    [ref]$favsenseTokens,
    [ref]$favsenseParseErrors
)
if (@($favsenseParseErrors).Count -gt 0) {
    throw "favsense.ps1 did not parse: $($favsenseParseErrors[0].Message)"
}
$stopInvocations = @($favsenseAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
        $node.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $node.Extent.Text -match "stop-autosync\.ps1"
}, $true))
if ($stopInvocations.Count -ne 2) {
    throw "Expected the preview cleanup and stop command to invoke stop-autosync.ps1 exactly twice; found $($stopInvocations.Count)."
}
foreach ($stopInvocation in $stopInvocations) {
    if ($stopInvocation.Extent.Text -notmatch '-Workspace\s+\$workspacePath(?:\s|$)') {
        throw 'A FavSense stop path still derives its workspace from the caller current directory.'
    }
}
if ($favsenseSource -notmatch '\$workspacePath\s*=\s*\$PSScriptRoot') {
    throw 'The FavSense entrypoint no longer anchors its workspace to its own directory.'
}

$servicePreflightIndex = $source.IndexOf('$serviceState = Get-FavSenseSetupServiceState', [System.StringComparison]::Ordinal)
$credentialGenerationIndex = $source.IndexOf('$tokenBytes =', [System.StringComparison]::Ordinal)
if ($servicePreflightIndex -lt 0 -or $credentialGenerationIndex -lt 0 -or $servicePreflightIndex -ge $credentialGenerationIndex) {
    throw 'Configuration, runtime, and port preflight must finish before any new credential is generated.'
}

$script:fixtureBridgeProcesses = @()
$script:fixtureBridgeListeners = @()
function Get-FavSenseSetupBridgeProcesses {
    param([string]$WorkspacePath, [string]$BridgePath, [int]$Port)
    return @($script:fixtureBridgeProcesses)
}
function Get-NetTCPConnection {
    param([string]$LocalAddress, [int]$LocalPort, [string]$State, [object]$ErrorAction)
    return @($script:fixtureBridgeListeners)
}

$stoppedState = Get-FavSenseSetupServiceState -WorkspacePath 'C:\fixture' -BridgePath 'C:\fixture\bridge-server.py' -Port 47631
if ($stoppedState.WasRunning -or @($stoppedState.ProcessIds).Count -ne 0) {
    throw 'An unused setup port was not classified as a stopped prior service.'
}
$script:fixtureBridgeListeners = @([pscustomobject]@{ OwningProcess = 303 })
$unrelatedPortRefused = $false
try {
    Get-FavSenseSetupServiceState -WorkspacePath 'C:\fixture' -BridgePath 'C:\fixture\bridge-server.py' -Port 47631 | Out-Null
} catch {
    $unrelatedPortRefused = $_.Exception.Message -match 'different|ambiguous|occupied'
}
if (-not $unrelatedPortRefused) {
    throw 'Setup did not refuse an unrelated listener before credential generation.'
}
$script:fixtureBridgeProcesses = @([pscustomobject]@{ ProcessId = 303 })
$runningState = Get-FavSenseSetupServiceState -WorkspacePath 'C:\fixture' -BridgePath 'C:\fixture\bridge-server.py' -Port 47631
if (-not $runningState.WasRunning -or @($runningState.ProcessIds).Count -ne 1 -or $runningState.ProcessIds[0] -ne 303) {
    throw 'The exact pre-existing FavSense bridge state was not captured for rollback.'
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-setup-transaction-test-" + [Guid]::NewGuid().ToString('N'))
$stateDirectory = Join-Path $fixtureRoot '.xhs-favorites'
$localRuntimeDirectory = Join-Path $fixtureRoot 'site\.local'
$tokenPath = Join-Path $stateDirectory 'bridge-token'
$capabilityPath = Join-Path $stateDirectory 'userscript-install-capability'
$installStatePath = Join-Path $stateDirectory 'userscript-install.json'
$userscriptPath = Join-Path $stateDirectory 'xhs-favorites.user.js'
$localRuntimePath = Join-Path $localRuntimeDirectory 'bridge.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Assert-ExactFileBytes {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Expected
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Expected restored file was not found: $Path"
    }
    $actualEncoded = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path))
    $expectedEncoded = [Convert]::ToBase64String($Expected)
    if ($actualEncoded -cne $expectedEncoded) {
        throw "Restored file bytes changed: $Path"
    }
}

try {
    [System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
    [System.IO.Directory]::CreateDirectory($localRuntimeDirectory) | Out-Null

    $entrypointFixture = Join-Path $fixtureRoot 'entrypoint-fixture'
    $entrypointScripts = Join-Path $entrypointFixture 'skills\xhs-favorites-organizer\scripts'
    $externalCurrentDirectory = Join-Path $fixtureRoot 'external-current-directory'
    [System.IO.Directory]::CreateDirectory($entrypointScripts) | Out-Null
    [System.IO.Directory]::CreateDirectory($externalCurrentDirectory) | Out-Null
    $fixtureFavSense = Join-Path $entrypointFixture 'favsense.ps1'
    $fixtureStop = Join-Path $entrypointScripts 'stop-autosync.ps1'
    $fixtureSource = $favsenseSource.Replace('http://127.0.0.1:8766/', 'http://127.0.0.1:1/')
    [System.IO.File]::WriteAllText($fixtureFavSense, $fixtureSource, [System.Text.UTF8Encoding]::new($true))
    [System.IO.File]::WriteAllText(
        $fixtureStop,
        "param([string]`$Workspace, [int]`$Port = 47631)`r`nWrite-Output ('STOP-WORKSPACE=' + [System.IO.Path]::GetFullPath(`$Workspace))`r`n",
        [System.Text.UTF8Encoding]::new($true)
    )
    $powershellExecutable = (Get-Process -Id $PID).Path
    Push-Location $externalCurrentDirectory
    try {
        $entrypointOutput = @(& $powershellExecutable -NoProfile -ExecutionPolicy Bypass -File $fixtureFavSense stop)
        $entrypointExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($entrypointExitCode -ne 0 -or
        $entrypointOutput -notcontains ('STOP-WORKSPACE=' + [System.IO.Path]::GetFullPath($entrypointFixture))) {
        throw 'Running FavSense stop outside the workspace did not pass the entrypoint workspace to stop-autosync.'
    }

    $oldToken = $utf8.GetBytes(('1' * 64))
    $oldCapability = $utf8.GetBytes(('2' * 64))
    $oldInstallState = $utf8.GetBytes('{"version":1,"digest":"old","used":true}')
    $oldUserscript = $utf8.GetBytes("// old userscript`r`n")
    [System.IO.File]::WriteAllBytes($tokenPath, $oldToken)
    [System.IO.File]::WriteAllBytes($capabilityPath, $oldCapability)
    [System.IO.File]::WriteAllBytes($installStatePath, $oldInstallState)
    [System.IO.File]::WriteAllBytes($userscriptPath, $oldUserscript)

    $preexistingTemporary = Join-Path $stateDirectory 'xhs-favorites.user.js.preexisting.tmp'
    $preexistingTemporaryBytes = $utf8.GetBytes('keep-existing-temporary-evidence')
    [System.IO.File]::WriteAllBytes($preexistingTemporary, $preexistingTemporaryBytes)
    $reusedBridgeTemporary = Join-Path $stateDirectory 'xhs-favorites.user.js.4321.8765.tmp'
    [System.IO.File]::WriteAllText($reusedBridgeTemporary, '// old bridge temporary before stop', $utf8)

    $managedContents = [ordered]@{}
    $managedContents[$tokenPath] = $utf8.GetBytes(('a' * 64))
    $managedContents[$capabilityPath] = $utf8.GetBytes(('b' * 64))
    $managedContents[$installStatePath] = $utf8.GetBytes('{"version":1,"digest":"new"}')
    $managedContents[$localRuntimePath] = $utf8.GetBytes('{"baseUrl":"http://127.0.0.1:47631"}')
    $snapshotPaths = @($tokenPath, $capabilityPath, $installStatePath, $localRuntimePath, $userscriptPath)

    $script:transactionStopCount = 0
    $script:transactionCleanupCount = 0
    $script:transactionRestartCount = 0
    $script:transactionStateDirectory = $stateDirectory
    $script:transactionUserscriptPath = $userscriptPath
    $script:transactionTokenPath = $tokenPath
    $script:transactionCapabilityPath = $capabilityPath
    $script:transactionInstallStatePath = $installStatePath
    $script:transactionLocalRuntimePath = $localRuntimePath

    $stopAction = { $script:transactionStopCount += 1 }
    $cleanupAction = {
        param([int[]]$InitialProcessIds)
        if (@($InitialProcessIds).Count -ne 0) {
            throw 'A completed old-service stop preserved a stale process identity during cleanup.'
        }
        $script:transactionCleanupCount += 1
    }
    $startAction = {
        [System.IO.File]::WriteAllText($script:transactionTokenPath, 'partially-replaced-token', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($script:transactionCapabilityPath, 'partially-replaced-capability', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($script:transactionInstallStatePath, '{"partial":true}', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($script:transactionLocalRuntimePath, '{"partial":true}', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($script:transactionUserscriptPath, '// generated before failed health check', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText(
            (Join-Path $script:transactionStateDirectory 'xhs-favorites.user.js.4321.tmp'),
            '// abandoned startup temporary',
            [System.Text.UTF8Encoding]::new($false)
        )
        [System.IO.File]::WriteAllText(
            (Join-Path $script:transactionStateDirectory 'xhs-favorites.user.js.4321.8765.tmp'),
            '// abandoned threaded startup temporary',
            [System.Text.UTF8Encoding]::new($false)
        )
        foreach ($managedPath in @(
            $script:transactionTokenPath,
            $script:transactionCapabilityPath,
            $script:transactionInstallStatePath,
            $script:transactionLocalRuntimePath
        )) {
            [System.IO.File]::WriteAllText(
                ($managedPath + '.setup-' + ('a' * 32) + '.tmp'),
                'crash-residue-containing-new-private-state',
                [System.Text.UTF8Encoding]::new($false)
            )
        }
        throw 'simulated bridge health failure'
    }
    $restartAction = {
        $script:transactionRestartCount += 1
        [System.IO.File]::WriteAllText($script:transactionUserscriptPath, '// restart regenerated userscript', [System.Text.UTF8Encoding]::new($false))
    }

    $failedAsExpected = $false
    $observedFailure = ''
    try {
        Invoke-SetupCredentialTransaction `
            -ManagedFileContents $managedContents `
            -SnapshotPaths $snapshotPaths `
            -StateDirectory $stateDirectory `
            -WasRunning $true `
            -InitialBridgeProcessIds @(101) `
            -StopAction $stopAction `
            -StartAction $startAction `
            -CleanupProcessAction $cleanupAction `
            -RestartAction $restartAction
    } catch {
        $observedFailure = $_.Exception.Message
        $failedAsExpected = $_.Exception.Message -eq 'simulated bridge health failure'
    }
    if (-not $failedAsExpected) {
        throw "A failed bridge health check did not preserve its original safe error: $observedFailure"
    }

    Assert-ExactFileBytes -Path $tokenPath -Expected $oldToken
    Assert-ExactFileBytes -Path $capabilityPath -Expected $oldCapability
    Assert-ExactFileBytes -Path $installStatePath -Expected $oldInstallState
    Assert-ExactFileBytes -Path $userscriptPath -Expected $oldUserscript
    if (Test-Path -LiteralPath $localRuntimePath) {
        throw 'Rollback left a bridge.json file that did not exist before setup.'
    }
    Assert-ExactFileBytes -Path $preexistingTemporary -Expected $preexistingTemporaryBytes
    $newTemporaries = @(
        Get-SetupTemporaryFiles `
            -StateDirectory $stateDirectory `
            -ManagedPaths @($tokenPath, $capabilityPath, $installStatePath, $localRuntimePath, $userscriptPath)
    )
    if ($newTemporaries.Count -ne 0) {
        throw 'Rollback left a userscript startup temporary file behind.'
    }
    if (Test-Path -LiteralPath $reusedBridgeTemporary) {
        throw 'Rollback preserved a new userscript temporary merely because it reused a pre-stop PID and thread path.'
    }
    if ($script:transactionStopCount -ne 2) {
        throw "The bridge was not stopped before mutation and during recovery; observed $($script:transactionStopCount) stop calls."
    }
    if ($script:transactionCleanupCount -ne 1) {
        throw 'New bridge processes were not cleaned up exactly once.'
    }
    if ($script:transactionRestartCount -ne 1) {
        throw 'The previously running bridge was not restarted exactly once.'
    }

    $script:tabFailureRestartCount = 0
    $tabFailureStart = {
        [System.IO.File]::WriteAllText($script:transactionUserscriptPath, '// healthy bridge before installer-tab failure', [System.Text.UTF8Encoding]::new($false))
        throw 'simulated installer tab failure'
    }
    $tabFailureRestart = {
        $script:tabFailureRestartCount += 1
        [System.IO.File]::WriteAllText($script:transactionUserscriptPath, '// restart regenerated after tab failure', [System.Text.UTF8Encoding]::new($false))
    }
    $tabFailedAsExpected = $false
    try {
        Invoke-SetupCredentialTransaction `
            -ManagedFileContents $managedContents `
            -SnapshotPaths $snapshotPaths `
            -StateDirectory $stateDirectory `
            -WasRunning $true `
            -InitialBridgeProcessIds @(202) `
            -StopAction {} `
            -StartAction $tabFailureStart `
            -CleanupProcessAction {} `
            -RestartAction $tabFailureRestart
    } catch {
        $tabFailedAsExpected = $_.Exception.Message -eq 'simulated installer tab failure'
    }
    if (-not $tabFailedAsExpected -or $script:tabFailureRestartCount -ne 1) {
        throw 'An installer-tab failure did not roll back and restore the previously running service.'
    }
    Assert-ExactFileBytes -Path $tokenPath -Expected $oldToken
    Assert-ExactFileBytes -Path $capabilityPath -Expected $oldCapability
    Assert-ExactFileBytes -Path $installStatePath -Expected $oldInstallState
    Assert-ExactFileBytes -Path $userscriptPath -Expected $oldUserscript
    if (Test-Path -LiteralPath $localRuntimePath) {
        throw 'Installer-tab rollback left a bridge.json file that did not exist before setup.'
    }

    $emptyRoot = Join-Path $fixtureRoot 'no-prior-installation'
    $emptyState = Join-Path $emptyRoot '.xhs-favorites'
    $emptyToken = Join-Path $emptyState 'bridge-token'
    $emptyCapability = Join-Path $emptyState 'userscript-install-capability'
    $emptyInstallState = Join-Path $emptyState 'userscript-install.json'
    $emptyUserscript = Join-Path $emptyState 'xhs-favorites.user.js'
    $emptyBridge = Join-Path $emptyRoot 'site\.local\bridge.json'
    [System.IO.Directory]::CreateDirectory($emptyState) | Out-Null
    $emptyContents = [ordered]@{}
    $emptyContents[$emptyToken] = $utf8.GetBytes(('e' * 64))
    $emptyContents[$emptyCapability] = $utf8.GetBytes(('f' * 64))
    $emptyContents[$emptyInstallState] = $utf8.GetBytes('{"version":1,"digest":"new-install"}')
    $emptyContents[$emptyBridge] = $utf8.GetBytes('{"baseUrl":"http://127.0.0.1:47631"}')
    $script:emptyUserscriptPath = $emptyUserscript
    $script:emptyRestartCount = 0
    $emptyFailure = {
        [System.IO.File]::WriteAllText($script:emptyUserscriptPath, '// generated before first-install failure', [System.Text.UTF8Encoding]::new($false))
        throw 'simulated first-install health failure'
    }
    $emptyRestart = { $script:emptyRestartCount += 1 }
    $emptyFailedAsExpected = $false
    try {
        Invoke-SetupCredentialTransaction `
            -ManagedFileContents $emptyContents `
            -SnapshotPaths @($emptyToken, $emptyCapability, $emptyInstallState, $emptyBridge, $emptyUserscript) `
            -StateDirectory $emptyState `
            -WasRunning $false `
            -InitialBridgeProcessIds @() `
            -StopAction {} `
            -StartAction $emptyFailure `
            -CleanupProcessAction {} `
            -RestartAction $emptyRestart
    } catch {
        $emptyFailedAsExpected = $_.Exception.Message -eq 'simulated first-install health failure'
    }
    if (-not $emptyFailedAsExpected) {
        throw 'A failed first installation did not return its original health error.'
    }
    foreach ($path in @($emptyToken, $emptyCapability, $emptyInstallState, $emptyBridge, $emptyUserscript)) {
        if (Test-Path -LiteralPath $path) {
            throw "A failed first installation left newly issued private state behind: $path"
        }
    }
    if ($script:emptyRestartCount -ne 0) {
        throw 'A failed first installation attempted to resurrect a service that was not previously running.'
    }

    $successRoot = Join-Path $fixtureRoot 'success'
    $successState = Join-Path $successRoot '.xhs-favorites'
    $successToken = Join-Path $successState 'bridge-token'
    $successCapability = Join-Path $successState 'userscript-install-capability'
    $successInstallState = Join-Path $successState 'userscript-install.json'
    $successUserscript = Join-Path $successState 'xhs-favorites.user.js'
    $successBridge = Join-Path $successRoot 'site\.local\bridge.json'
    [System.IO.Directory]::CreateDirectory($successState) | Out-Null
    $successContents = [ordered]@{}
    $successContents[$successToken] = $utf8.GetBytes(('c' * 64))
    $successContents[$successCapability] = $utf8.GetBytes(('d' * 64))
    $successContents[$successInstallState] = $utf8.GetBytes('{"version":1,"digest":"success"}')
    $successContents[$successBridge] = $utf8.GetBytes('{"baseUrl":"http://127.0.0.1:47631"}')
    $script:successStartCount = 0
    $script:successRestartCount = 0
    $script:successUserscriptPath = $successUserscript
    $successStart = {
        $script:successStartCount += 1
        [System.IO.File]::WriteAllText($script:successUserscriptPath, '// healthy generated userscript', [System.Text.UTF8Encoding]::new($false))
    }
    $successRestart = { $script:successRestartCount += 1 }
    Invoke-SetupCredentialTransaction `
        -ManagedFileContents $successContents `
        -SnapshotPaths @($successToken, $successCapability, $successInstallState, $successBridge, $successUserscript) `
        -StateDirectory $successState `
        -WasRunning $false `
        -InitialBridgeProcessIds @() `
        -StopAction {} `
        -StartAction $successStart `
        -CleanupProcessAction {} `
        -RestartAction $successRestart
    if ($script:successStartCount -ne 1 -or $script:successRestartCount -ne 0) {
        throw 'A successful setup did not commit exactly once without a rollback restart.'
    }
    foreach ($path in @($successToken, $successCapability, $successInstallState, $successBridge, $successUserscript)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Successful setup did not retain its committed file: $path"
        }
    }

    $lockState = Join-Path $fixtureRoot 'setup-lock-state'
    $firstSetupLock = Enter-FavSenseSetupLock -StateDirectory $lockState
    try {
        $secondSetupRefused = $false
        try { Enter-FavSenseSetupLock -StateDirectory $lockState | Out-Null } catch {
            $secondSetupRefused = $_.Exception.Message -match 'already running'
        }
        if (-not $secondSetupRefused) {
            throw 'A concurrent credential setup was not rejected by the real file lock.'
        }
    } finally {
        $firstSetupLock.Dispose()
    }

    Invoke-FavSenseSetupUnderLock -StateDirectory $lockState -SetupAction { return }
    $lockAfterEarlyReturn = Enter-FavSenseSetupLock -StateDirectory $lockState
    $lockAfterEarlyReturn.Dispose()

    $orphanRoot = Join-Path $fixtureRoot 'orphan-setup-temporaries'
    $orphanState = Join-Path $orphanRoot '.xhs-favorites'
    $orphanLocal = Join-Path $orphanRoot 'site\.local'
    [System.IO.Directory]::CreateDirectory($orphanState) | Out-Null
    [System.IO.Directory]::CreateDirectory($orphanLocal) | Out-Null
    $orphanManaged = @(
        (Join-Path $orphanState 'bridge-token'),
        (Join-Path $orphanState 'userscript-install-capability'),
        (Join-Path $orphanState 'userscript-install.json'),
        (Join-Path $orphanLocal 'bridge.json')
    )
    foreach ($path in $orphanManaged) {
        [System.IO.File]::WriteAllText(
            ($path + '.setup-' + ('b' * 32) + '.tmp'),
            'orphaned-private-state',
            $utf8
        )
    }
    $orphanUserscriptTemporary = Join-Path $orphanState 'xhs-favorites.user.js.9876.tmp'
    $orphanThreadedUserscriptTemporary = Join-Path $orphanState 'xhs-favorites.user.js.9876.123456.tmp'
    $similarUnownedFile = Join-Path $orphanState 'bridge-token.setup-not-a-guid.tmp'
    $similarUserscriptFile = Join-Path $orphanState 'xhs-favorites.user.js.9876.123456.extra.tmp'
    [System.IO.File]::WriteAllText($orphanUserscriptTemporary, 'orphan userscript', $utf8)
    [System.IO.File]::WriteAllText($orphanThreadedUserscriptTemporary, 'orphan threaded userscript', $utf8)
    [System.IO.File]::WriteAllText($similarUnownedFile, 'preserve unrelated', $utf8)
    [System.IO.File]::WriteAllText($similarUserscriptFile, 'preserve similar userscript', $utf8)
    $activeWriter = [System.IO.File]::Open(
        $orphanThreadedUserscriptTemporary,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        Remove-OrphanedSetupTemporaryFiles -StateDirectory $orphanState -ManagedPaths $orphanManaged
        if (@(Get-ManagedSetupTemporaryFiles -StateDirectory $orphanState -ManagedPaths $orphanManaged).Count -ne 0) {
            throw 'Owned setup crash temporaries were not reclaimed under the setup lock.'
        }
        foreach ($bridgeTemporary in @($orphanUserscriptTemporary, $orphanThreadedUserscriptTemporary)) {
            if (-not (Test-Path -LiteralPath $bridgeTemporary -PathType Leaf)) {
                throw 'Pre-stop setup cleanup removed a Bridge userscript temporary owned by a possible live writer.'
            }
        }
    } finally {
        $activeWriter.Dispose()
    }
    Remove-OrphanedBridgeUserscriptTemporaryFiles -StateDirectory $orphanState
    if (@(Get-SetupTemporaryFiles -StateDirectory $orphanState -ManagedPaths $orphanManaged).Count -ne 0) {
        throw 'Bridge userscript temporaries were not reclaimed after the writer stopped.'
    }
    if ((Get-Content -LiteralPath $similarUnownedFile -Raw) -ne 'preserve unrelated') {
        throw 'Setup cleanup removed a file outside its exact owned naming contract.'
    }
    if ((Get-Content -LiteralPath $similarUserscriptFile -Raw) -ne 'preserve similar userscript') {
        throw 'Setup cleanup removed a similarly named userscript file outside its exact owned naming contract.'
    }

    Write-Output 'Credential setup lock, crash-temp cleanup, exact rollback, service restoration, and success commit were accepted.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
