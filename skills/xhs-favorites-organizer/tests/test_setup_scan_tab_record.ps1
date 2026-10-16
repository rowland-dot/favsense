[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

# Issue 137: every Xiaohongshu page setup opens in the scan browser has its tab id written to a private record,
# so the next sync round can close it. The two places setup opens such a page (the Tampermonkey-missing
# branch and the start action) are taken out of the real script and run against stand-ins for the browser.

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
    'Assert-SetupDirectory',
    'Set-SetupFileBytesAtomically',
    'Get-SopCdpPort',
    'Test-SopCdpEndpoint',
    'Open-SopBrowserTab',
    'Add-SetupScanTabRecord'
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

$missingBranch = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
        $node.Clauses[0].Item1.Extent.Text -eq '-not $tampermonkeyInstalled'
}, $true)
if (-not $missingBranch) { throw 'The Tampermonkey-missing branch of setup was not found.' }
$missingBody = $missingBranch.Clauses[0].Item2.Extent.Text
$missingBlock = [scriptblock]::Create($missingBody.Substring(1, $missingBody.Length - 2))

$startAssignment = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left.Extent.Text -eq '$startAction'
}, $true)
if (-not $startAssignment) { throw 'The start action of setup was not found.' }
$startExpression = $startAssignment.Right.Find({
    param($node)
    $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst]
}, $true)
$startText = $startExpression.ScriptBlock.EndBlock.Extent.Text

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("favsense-setup-tab-record-test-" + [Guid]::NewGuid().ToString('N'))
$stateDirectory = Join-Path $fixtureRoot '.xhs-favorites'
$fixtureScripts = Join-Path $fixtureRoot 'scripts'
$portFile = Join-Path $fixtureRoot 'cdp-port.txt'
$recordPath = Join-Path $stateDirectory 'setup-pages.json'
$xhsLoginUrl = 'https://www.xiaohongshu.com/explore'
$tampermonkeyStoreUrl = 'https://chromewebstore.google.com/detail/tampermonkey/fixture'
$installSourceUrl = 'http://127.0.0.1:47631/install/fixture-capability/xhs-favorites.user.js'
$workspacePath = $fixtureRoot
$configPath = Join-Path $fixtureRoot 'xhs-favorites.json'
$Port = 47631

try {
    [System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
    [System.IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
    [System.IO.File]::WriteAllText($portFile, "9224`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText(
        (Join-Path $fixtureScripts 'start-autosync.ps1'),
        "param([string]`$Workspace, [string]`$Config, [int]`$Port, [string]`$SopRuntime)`r`nWrite-Output 'stand-in bridge started'`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $channel = [pscustomobject]@{ PortFilePath = $portFile; RuntimePath = (Join-Path $fixtureRoot 'sop') }
    $startBlock = [scriptblock]::Create(
        $startText.Replace('$PSScriptRoot', "'" + $fixtureScripts.Replace("'", "''") + "'")
    )

    $script:tabCounter = 0
    $script:opened = [System.Collections.Generic.List[string]]::new()
    function Invoke-RestMethod {
        param(
            [string]$Uri,
            [string]$Method = 'Get',
            [int]$TimeoutSec
        )
        if ($Uri -eq 'http://127.0.0.1:9224/json/version') {
            return [pscustomobject]@{ webSocketDebuggerUrl = 'ws://127.0.0.1:9224/devtools/browser/sop-fixture' }
        }
        if ($Uri -like 'http://127.0.0.1:9224/json/new?*') {
            $script:tabCounter += 1
            $script:opened.Add([uri]::UnescapeDataString($Uri.Substring($Uri.IndexOf('?') + 1)))
            return [pscustomobject]@{ id = "fixture-setup-tab-$($script:tabCounter)"; type = 'page'; url = 'about:blank' }
        }
        if ($Uri -like 'http://127.0.0.1:9224/json/activate/*') {
            return [pscustomobject]@{ ok = $true }
        }
        throw "Unexpected CDP request: $Method $Uri"
    }

    function Assert-RecordIds {
        param([Parameter(Mandatory)][string[]]$Expected)
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.version -ne 1) { throw 'The setup page record does not carry version 1.' }
        $actual = @($record.tab_ids) -join ','
        if ($actual -ne ($Expected -join ',')) {
            throw "The setup page record holds '$actual' but should hold '$($Expected -join ',')'."
        }
    }

    # Path one: Tampermonkey is not installed, so setup opens its store page and the Xiaohongshu page and stops.
    $null = & $missingBlock
    if ($script:opened.Count -ne 2 -or $script:opened[0] -ne $tampermonkeyStoreUrl -or $script:opened[1] -ne $xhsLoginUrl) {
        throw "The missing-Tampermonkey path opened '$($script:opened -join ' | ')' instead of the store page and the unchanged Xiaohongshu address."
    }
    Assert-RecordIds -Expected @('fixture-setup-tab-2')

    # A later setup run adds to the record and keeps the earlier id.
    $null = & $missingBlock
    Assert-RecordIds -Expected @('fixture-setup-tab-2', 'fixture-setup-tab-4')

    # Path two: the start action opens the installer page and then the Xiaohongshu page.
    $null = & $startBlock
    if ($script:opened.Count -ne 6 -or $script:opened[4] -ne $installSourceUrl -or $script:opened[5] -ne $xhsLoginUrl) {
        throw "The start action opened '$($script:opened[4..5] -join ' | ')' instead of the installer page and the unchanged Xiaohongshu address."
    }
    Assert-RecordIds -Expected @('fixture-setup-tab-2', 'fixture-setup-tab-4', 'fixture-setup-tab-6')

    # The record holds tab ids and nothing else, and setup leaves no other file in the state folder.
    $recordText = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8
    $recordKeys = (($recordText | ConvertFrom-Json).PSObject.Properties.Name | Sort-Object) -join ','
    if ($recordKeys -ne 'tab_ids,version') { throw "The setup page record carries '$recordKeys' instead of only its version and tab ids." }
    if ($recordText -imatch 'xsec_token|https?:|[0-9a-f]{24}') {
        throw 'The setup page record holds an address, an access code or a note or folder id.'
    }
    $stateFiles = @(Get-ChildItem -LiteralPath $stateDirectory -Force | ForEach-Object { $_.Name })
    if (($stateFiles -join ',') -ne 'setup-pages.json') {
        throw "Setup left '$($stateFiles -join ',')' in the state folder instead of only the record."
    }

    # A record that cannot be read does not stop the new id from being written.
    [System.IO.File]::WriteAllText($recordPath, 'not json', [System.Text.UTF8Encoding]::new($false))
    Add-SetupScanTabRecord -StateDirectory $stateDirectory -Tab ([pscustomobject]@{ id = 'fixture-setup-tab-7' })
    Assert-RecordIds -Expected @('fixture-setup-tab-7')

    # A record that cannot be written only warns: the tab is open, and failing here would roll back a good install.
    $notADirectory = Join-Path $fixtureRoot 'not-a-directory'
    [System.IO.File]::WriteAllText($notADirectory, 'x', [System.Text.UTF8Encoding]::new($false))
    $failedWrite = @(Add-SetupScanTabRecord -StateDirectory $notADirectory -Tab ([pscustomobject]@{ id = 'fixture-setup-tab-8' }) 3>&1)
    $warnings = @($failedWrite | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
    if ($warnings.Count -ne 1) { throw "A record that could not be written produced $($warnings.Count) warnings instead of one." }

    Write-Output 'Setup tab record on both paths, earlier ids kept, tab ids only, and a failed write that only warns were accepted.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
