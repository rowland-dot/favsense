[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),
    [Parameter()][int]$MaxItems = 20,
    [Parameter()][switch]$PrepareVisualEvidence
)

$ErrorActionPreference = 'Stop'
if ($MaxItems -lt 1 -or $MaxItems -gt 100) { throw 'MaxItems must be between 1 and 100.' }

$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$analysis = $configObject.video_analysis
if (-not $analysis -or $analysis.enabled -ne $true) {
    Write-Output 'Offline video analysis is disabled in config.'
    return
}

$python = Join-Path $workspacePath '.xhs-tools\transcription\.venv\Scripts\python.exe'
$modelDirectory = Join-Path $workspacePath '.xhs-tools\transcription\models'
$ffmpegDirectory = Get-ChildItem -LiteralPath (Join-Path $workspacePath '.xhs-tools\ffmpeg') `
    -Directory -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
$ffmpeg = Join-Path $ffmpegDirectory.FullName 'bin\ffmpeg.exe'
$ffprobe = Join-Path $ffmpegDirectory.FullName 'bin\ffprobe.exe'
foreach ($required in @($python, $ffmpeg, $ffprobe)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required offline analysis runtime is missing: $required"
    }
}

$mediaDirectory = Join-Path $workspacePath '.xhs-favorites\media'
$analysisDirectory = Join-Path $workspacePath '.xhs-favorites\video-analysis'
$catalog = Join-Path $workspacePath '.xhs-favorites\catalog.json'
$curation = Join-Path $workspacePath ([string]$configObject.curation_file)
$model = if ($analysis.model) { [string]$analysis.model } else { 'small' }
$language = if ($analysis.language) { [string]$analysis.language } else { 'zh' }
$device = if ($analysis.device) { [string]$analysis.device } else { 'cpu' }
$computeType = if ($analysis.compute_type) { [string]$analysis.compute_type } else { 'int8' }
$maxItemSeconds = if ($analysis.max_item_seconds) { [double]$analysis.max_item_seconds } else { 600 }
$maxBatchSeconds = if ($analysis.max_batch_seconds) { [double]$analysis.max_batch_seconds } else { 900 }
$visualWindowSeconds = if ($analysis.visual_window_seconds) { [double]$analysis.visual_window_seconds } else { 30 }
$maxVisualFrames = if ($analysis.max_visual_frames) { [int]$analysis.max_visual_frames } else { 60 }
$maxVisualBytes = if ($analysis.max_visual_bytes) { [int]$analysis.max_visual_bytes } else { 20971520 }
$maxVisualWallSeconds = if ($analysis.max_visual_wall_seconds) { [double]$analysis.max_visual_wall_seconds } else { 120 }
$statusFile = Join-Path $workspacePath '.xhs-favorites\video-analysis-status.json'

& $python (Join-Path $PSScriptRoot 'transcribe-pending-videos.py') `
    --media-dir $mediaDirectory `
    --curation $curation `
    --catalog $catalog `
    --config $configPath `
    --analysis-dir $analysisDirectory `
    --ffmpeg $ffmpeg `
    --ffprobe $ffprobe `
    --model $model `
    --model-dir $modelDirectory `
    --language $language `
    --device $device `
    --compute-type $computeType `
    --max-items $MaxItems `
    --max-item-seconds $maxItemSeconds `
    --max-batch-seconds $maxBatchSeconds `
    --status-file $statusFile
if ($LASTEXITCODE -ne 0) { throw 'Audio-first transcription failed.' }

if ($PrepareVisualEvidence) {
    & $python (Join-Path $PSScriptRoot 'extract-pending-frames.py') `
        --media-dir $mediaDirectory `
        --curation $curation `
        --catalog $catalog `
        --config $configPath `
        --analysis-dir $analysisDirectory `
        --ffmpeg $ffmpeg `
        --ffprobe $ffprobe `
        --max-items 1 `
        --window-seconds $visualWindowSeconds `
        --max-total-frames $maxVisualFrames `
        --max-total-bytes $maxVisualBytes `
        --max-wall-seconds $maxVisualWallSeconds
    if ($LASTEXITCODE -ne 0) { throw 'On-demand sparse visual extraction failed.' }
}
