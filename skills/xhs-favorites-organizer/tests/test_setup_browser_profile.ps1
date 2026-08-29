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
    'Test-PathIsReparsePoint',
    'Resolve-SopBrowserChannel',
    'Get-SopCdpPort',
    'Test-SopCdpEndpoint',
    'Ensure-SopBrowserChannel',
    'Open-SopBrowserTab',
    'Test-SopTampermonkeyInstallation'
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if (-not $functionAst) {
        throw "Missing production function: $functionName"
    }
    Invoke-Expression $functionAst.Extent.Text
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-sop-channel-test-" + [Guid]::NewGuid().ToString('N'))
$runtime = Join-Path $fixtureRoot 'SOP - 小红书\运行系统'
$secrets = Join-Path $runtime '.secrets'
$profiles = Join-Path $secrets 'browser-profiles'
$profile = Join-Path $profiles 'cdp-chrome'
$portFile = Join-Path $secrets 'cdp-port.txt'
$scripts = Join-Path $runtime 'scripts'
$launcher = Join-Path $scripts '启动扫描浏览器.bat'
$redirectTarget = Join-Path $fixtureRoot 'redirect-target'
$redirectScripts = Join-Path $fixtureRoot 'redirect-scripts'
$tampermonkeyId = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'

try {
    [System.IO.Directory]::CreateDirectory($profiles) | Out-Null
    [System.IO.Directory]::CreateDirectory($scripts) | Out-Null
    [System.IO.Directory]::CreateDirectory($redirectTarget) | Out-Null
    [System.IO.Directory]::CreateDirectory($redirectScripts) | Out-Null
    [System.IO.File]::WriteAllText($portFile, "9224`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($launcher, "@exit /b 0`r`n", [System.Text.Encoding]::ASCII)

    New-Item -ItemType Junction -Path $profile -Target $redirectTarget | Out-Null
    $refused = $false
    try {
        Resolve-SopBrowserChannel -RuntimePath $runtime | Out-Null
    } catch {
        $refused = $_.Exception.Message -match 'reparse|junction|redirect'
    }
    if (-not $refused) {
        throw 'A redirected SOP cdp-chrome profile was not refused with a clear fail-closed error.'
    }
    if (-not (Test-Path -LiteralPath $profile -PathType Container)) {
        throw 'The rejected SOP profile junction was unexpectedly deleted.'
    }

    [System.IO.Directory]::Delete($profile)
    [System.IO.Directory]::CreateDirectory($profile) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $redirectScripts '启动扫描浏览器.bat'), "@exit /b 0`r`n", [System.Text.Encoding]::ASCII)
    Remove-Item -LiteralPath $launcher -Force
    [System.IO.Directory]::Delete($scripts)
    New-Item -ItemType Junction -Path $scripts -Target $redirectScripts | Out-Null
    $scriptsRefused = $false
    try {
        Resolve-SopBrowserChannel -RuntimePath $runtime | Out-Null
    } catch {
        $scriptsRefused = $_.Exception.Message -match 'reparse|junction|redirect'
    }
    if (-not $scriptsRefused) {
        throw 'A redirected SOP scripts directory was not refused before launcher execution.'
    }
    [System.IO.Directory]::Delete($scripts)
    [System.IO.Directory]::CreateDirectory($scripts) | Out-Null
    [System.IO.File]::WriteAllText($launcher, "@exit /b 0`r`n", [System.Text.Encoding]::ASCII)

    $channel = Resolve-SopBrowserChannel -RuntimePath $runtime
    if ($channel.RuntimePath -ne [System.IO.Path]::GetFullPath($runtime).TrimEnd('\', '/')) {
        throw 'The canonical SOP runtime path was not returned.'
    }
    if ($channel.ProfilePath -ne [System.IO.Path]::GetFullPath($profile).TrimEnd('\', '/')) {
        throw 'The exact SOP cdp-chrome profile was not selected.'
    }
    if ($channel.PortFilePath -ne [System.IO.Path]::GetFullPath($portFile).TrimEnd('\', '/')) {
        throw 'The exact SOP cdp-port.txt registry was not selected.'
    }
    if ($channel.LauncherPath -ne [System.IO.Path]::GetFullPath($launcher).TrimEnd('\', '/')) {
        throw 'The exact SOP scanner launcher was not selected.'
    }

    $extensionRoot = Join-Path $profile "Default\Extensions\$tampermonkeyId"
    [System.IO.Directory]::CreateDirectory($extensionRoot) | Out-Null
    if (Test-SopTampermonkeyInstallation -ProfilePath $profile -ExtensionId $tampermonkeyId) {
        throw 'An empty extension ID directory was accepted as Tampermonkey.'
    }
    $invalidVersion = Join-Path $extensionRoot '1.0.0_0'
    [System.IO.Directory]::CreateDirectory($invalidVersion) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $invalidVersion 'manifest.json'), '{not-json', [System.Text.UTF8Encoding]::new($false))
    if (Test-SopTampermonkeyInstallation -ProfilePath $profile -ExtensionId $tampermonkeyId) {
        throw 'An invalid extension manifest was accepted as Tampermonkey.'
    }
    Remove-Item -LiteralPath $invalidVersion -Recurse -Force

    $externalVersion = Join-Path $redirectTarget '2.0.0_0'
    [System.IO.Directory]::CreateDirectory($externalVersion) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $externalVersion 'manifest.json'), '{"manifest_version":3,"name":"Tampermonkey"}', [System.Text.UTF8Encoding]::new($false))
    New-Item -ItemType Junction -Path (Join-Path $extensionRoot '2.0.0_0') -Target $externalVersion | Out-Null
    if (Test-SopTampermonkeyInstallation -ProfilePath $profile -ExtensionId $tampermonkeyId) {
        throw 'A redirected extension version was accepted as Tampermonkey.'
    }
    [System.IO.Directory]::Delete((Join-Path $extensionRoot '2.0.0_0'))

    $validVersion = Join-Path $extensionRoot '3.0.0_0'
    [System.IO.Directory]::CreateDirectory($validVersion) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $validVersion 'manifest.json'), '{"manifest_version":3,"name":"Tampermonkey"}', [System.Text.UTF8Encoding]::new($false))
    if (-not (Test-SopTampermonkeyInstallation -ProfilePath $profile -ExtensionId $tampermonkeyId)) {
        throw 'A normal SOP profile extension version with a valid manifest was not accepted.'
    }

    if ((Get-SopCdpPort -PortFilePath $portFile) -ne 9224) {
        throw 'The dynamic SOP CDP port was not read exactly from cdp-port.txt.'
    }
    [System.IO.File]::WriteAllText($portFile, "9224`n9222`n", [System.Text.Encoding]::ASCII)
    $badPortRefused = $false
    try { Get-SopCdpPort -PortFilePath $portFile | Out-Null } catch { $badPortRefused = $true }
    if (-not $badPortRefused) { throw 'A multi-line SOP port registry was accepted.' }
    [System.IO.File]::WriteAllText($portFile, "9224`n", [System.Text.Encoding]::ASCII)

    $script:endpointReady = $true
    $script:launchCount = 0
    $script:restCalls = [System.Collections.Generic.List[object]]::new()
    function Invoke-RestMethod {
        param(
            [string]$Uri,
            [string]$Method = 'Get',
            [int]$TimeoutSec
        )
        $script:restCalls.Add([pscustomobject]@{ Uri = $Uri; Method = $Method; TimeoutSec = $TimeoutSec })
        if ($Uri -eq 'http://127.0.0.1:9224/json/version') {
            if (-not $script:endpointReady) { throw 'endpoint unavailable' }
            return [pscustomobject]@{ webSocketDebuggerUrl = 'ws://127.0.0.1:9224/devtools/browser/sop-fixture' }
        }
        if ($Uri -like 'http://127.0.0.1:9224/json/new?*') {
            return [pscustomobject]@{ id = 'fixture-tab'; type = 'page'; url = 'about:blank' }
        }
        if ($Uri -eq 'http://127.0.0.1:9224/json/activate/fixture-tab') {
            return [pscustomobject]@{ ok = $true }
        }
        throw "Unexpected CDP request: $Method $Uri"
    }
    function Start-Process {
        param(
            [string]$FilePath,
            [string[]]$ArgumentList,
            [string]$WorkingDirectory,
            [string]$WindowStyle,
            [switch]$PassThru
        )
        if ($FilePath -ne $launcher) { throw "Unexpected launcher: $FilePath" }
        $script:launchCount += 1
        [System.IO.File]::WriteAllText($portFile, "9224`n", [System.Text.Encoding]::ASCII)
        $script:endpointReady = $true
        return [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
    }
    function Start-Sleep { param([int]$Milliseconds) }

    if (-not (Test-SopCdpEndpoint -Channel $channel)) {
        throw 'A matching live SOP CDP endpoint was not accepted.'
    }
    Ensure-SopBrowserChannel -Channel $channel -Attempts 2 -PollMilliseconds 1 | Out-Null
    if ($script:launchCount -ne 0) {
        throw 'The SOP launcher ran even though the registered endpoint was already live.'
    }

    $script:endpointReady = $false
    Ensure-SopBrowserChannel -Channel $channel -Attempts 2 -PollMilliseconds 1 | Out-Null
    if ($script:launchCount -ne 1) {
        throw "A dead SOP channel must invoke its launcher exactly once; observed $script:launchCount."
    }

    Remove-Item -LiteralPath $portFile -Force
    $script:endpointReady = $false
    $script:launchCount = 0
    Ensure-SopBrowserChannel -Channel $channel -Attempts 2 -PollMilliseconds 1 | Out-Null
    if ($script:launchCount -ne 1 -or -not (Test-Path -LiteralPath $portFile -PathType Leaf)) {
        throw 'A missing SOP port registry did not invoke the launcher exactly once and recover from its new registered port.'
    }

    $script:restCalls.Clear()
    $tab = Open-SopBrowserTab -Channel $channel -Url 'https://www.xiaohongshu.com/explore?source=favsense'
    if ($tab.id -ne 'fixture-tab') { throw 'The created SOP browser tab identity was not returned.' }
    $newCall = @($script:restCalls | Where-Object { $_.Uri -like '*/json/new?*' })
    $activateCall = @($script:restCalls | Where-Object { $_.Uri -like '*/json/activate/*' })
    if ($newCall.Count -ne 1 -or $newCall[0].Method -ne 'Put') {
        throw 'A browser tab was not opened exactly once with the CDP /json/new PUT endpoint.'
    }
    if ($newCall[0].Uri -notmatch '^http://127\.0\.0\.1:9224/json/new\?') {
        throw 'The browser tab did not use the dynamic port from SOP cdp-port.txt.'
    }
    if ($newCall[0].Uri -match '127\.0\.0\.1:9222') {
        throw 'The browser tab fell back to hard-coded port 9222.'
    }
    if ($activateCall.Count -ne 1 -or $activateCall[0].Method -ne 'Get') {
        throw 'The newly created SOP browser tab was not activated exactly once.'
    }

    $script:endpointReady = $false
    $script:launchCount = 0
    function Start-Process {
        param(
            [string]$FilePath,
            [string[]]$ArgumentList,
            [string]$WorkingDirectory,
            [string]$WindowStyle,
            [switch]$PassThru
        )
        $script:launchCount += 1
        return [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
    }
    $timeoutRefused = $false
    try {
        Ensure-SopBrowserChannel -Channel $channel -Attempts 3 -PollMilliseconds 1 | Out-Null
    } catch {
        $timeoutRefused = $_.Exception.Message -match 'SOP|CDP|scanner|扫描'
    }
    if (-not $timeoutRefused) { throw 'A dead SOP browser channel did not fail closed after bounded polling.' }
    if ($script:launchCount -ne 1) { throw 'A failed SOP browser launch was retried more than once.' }

    Write-Output 'Shared SOP runtime validation, dynamic CDP port, single launcher call, tab creation, and Tampermonkey detection were accepted.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
