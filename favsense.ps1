[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'sync', 'preview', 'test', 'verify')]
    [string]$Command = 'preview'
)

$ErrorActionPreference = 'Stop'
$workspacePath = $PSScriptRoot
$configPath = Join-Path $workspacePath 'config\xhs-favorites.json'
$exampleConfigPath = Join-Path $workspacePath 'config\xhs-favorites.example.json'
$skillScripts = Join-Path $workspacePath 'skills\xhs-favorites-organizer\scripts'

switch ($Command) {
    'setup' {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            Copy-Item -LiteralPath $exampleConfigPath -Destination $configPath
            Write-Output '已创建私有配置 config\xhs-favorites.json。请填写个人主页和收藏夹 ID，然后再次运行 .\favsense.ps1 setup。'
            exit 0
        }
        & (Join-Path $skillScripts 'setup-autosync.ps1') -Workspace $workspacePath -Config $configPath
    }
    'sync' {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw '请先运行 .\favsense.ps1 setup。' }
        & (Join-Path $skillScripts 'run-daily.ps1') -Workspace $workspacePath -Config $configPath -Mode daily
    }
    'preview' { & node (Join-Path $workspacePath 'scripts\serve-site.mjs') }
    'test' { & npm.cmd test }
    'verify' { & npm.cmd run release:check }
}
