[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Model = 'small'
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$uv = Get-Command -Name 'uv' -ErrorAction SilentlyContinue
if (-not $uv) { throw 'uv was not found. Install uv before enabling offline transcription.' }

$basePython = Join-Path $workspacePath '.xhs-tools\XHS-Downloader\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $basePython -PathType Leaf)) {
    throw 'The XHS-Downloader Python runtime is missing. Run setup-autosync.ps1 first.'
}

$runtimeDirectory = Join-Path $workspacePath '.xhs-tools\transcription'
$venvDirectory = Join-Path $runtimeDirectory '.venv'
$python = Join-Path $venvDirectory 'Scripts\python.exe'
$modelDirectory = Join-Path $runtimeDirectory 'models'
$env:UV_CACHE_DIR = Join-Path $workspacePath '.xhs-tools\uv-cache'
[System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory($env:UV_CACHE_DIR) | Out-Null

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    & $uv.Source venv --python $basePython $venvDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the transcription virtual environment.' }
}

& $uv.Source pip install --python $python 'faster-whisper==1.2.1'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned faster-whisper runtime.' }

& $python (Join-Path $PSScriptRoot 'preload-transcription-model.py') `
    --model $Model --model-dir $modelDirectory
if ($LASTEXITCODE -ne 0) { throw 'Could not download the offline transcription model.' }

Write-Output "FavSense offline transcription is ready with model '$Model'."
