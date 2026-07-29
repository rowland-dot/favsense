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
        & (Join-Path $skillScripts 'start-autosync.ps1') -Workspace $workspacePath -Config $configPath
        try {
            & node (Join-Path $workspacePath 'scripts\serve-site.mjs')
        } finally {
            & (Join-Path $skillScripts 'stop-autosync.ps1')
        }
    }
    'stop' { & (Join-Path $skillScripts 'stop-autosync.ps1') }
    'test' { & npm.cmd test }
    'verify' { & npm.cmd run release:check }
}
