[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),
    [Parameter()][int]$MaxItems = 20,
    [Parameter()][string[]]$NoteId = @(),
    [Parameter()][switch]$PrepareVisualEvidence
)

$ErrorActionPreference = 'Stop'
if ($MaxItems -lt 1 -or $MaxItems -gt 100) { throw 'MaxItems must be between 1 and 100.' }

function Assert-PlainLeafPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "$Label is unavailable or redirected."
    }
    $parent = $item.Directory
    while ($parent) {
        if ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "$Label is unavailable or redirected."
        }
        $parent = $parent.Parent
    }
    return $item.FullName
}

function Assert-PlainDirectoryPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "$Label is unavailable or redirected."
    }
    $parent = $item.Parent
    while ($parent) {
        if ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "$Label is unavailable or redirected."
        }
        $parent = $parent.Parent
    }
    return $item.FullName
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$workspacePath = Assert-PlainDirectoryPath $workspacePath 'Workspace'
$configPath = [System.IO.Path]::GetFullPath($Config)
$configPath = Assert-PlainLeafPath $configPath 'Config'
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$analysis = $configObject.video_analysis
$ocr = $configObject.image_ocr
$analysisEnabled = $analysis -and $analysis.enabled -eq $true
$ocrEnabled = $ocr -and $ocr.enabled -eq $true
$requestedNoteIds = @($NoteId | Select-Object -Unique)
foreach ($requestedNoteId in $requestedNoteIds) {
    if ($requestedNoteId -notmatch '^[a-f0-9]{24}$') {
        throw 'NoteId must use a supported note identifier.'
    }
}
$stateDirectory = Assert-PlainDirectoryPath (
    Join-Path $workspacePath '.xhs-favorites'
) 'Private state directory'
$mediaDirectory = Assert-PlainDirectoryPath (
    Join-Path $stateDirectory 'media'
) 'Media directory'
$analysisDirectory = Join-Path $stateDirectory 'video-analysis'
if (-not (Test-Path -LiteralPath $analysisDirectory)) {
    New-Item -ItemType Directory -Path $analysisDirectory -ErrorAction Stop | Out-Null
}
$analysisDirectory = Assert-PlainDirectoryPath $analysisDirectory 'Analysis directory'
$catalog = Join-Path $workspacePath '.xhs-favorites\catalog.json'
$catalog = Assert-PlainLeafPath $catalog 'Catalog'
$catalogObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $catalog | ConvertFrom-Json
$catalogNoteIds = @($catalogObject.notes.PSObject.Properties.Name)
foreach ($requestedNoteId in $requestedNoteIds) {
    if ($requestedNoteId -notin $catalogNoteIds) {
        throw 'NoteId is outside the catalog scope.'
    }
}
if (-not $analysisEnabled -and -not $ocrEnabled) {
    Write-Output 'Offline evidence analysis is disabled in config.'
    return
}
$curation = Join-Path $workspacePath ([string]$configObject.curation_file)
$curation = Assert-PlainLeafPath $curation 'Curation'
$statusFile = Join-Path $workspacePath '.xhs-favorites\video-analysis-status.json'

$transcriptionPython = Join-Path $workspacePath '.xhs-tools\transcription\.venv\Scripts\python.exe'
$python = $transcriptionPython
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { $pythonCommand = Get-Command python -ErrorAction SilentlyContinue }
    $python = if ($pythonCommand) { $pythonCommand.Source } else { $null }
}

if ($analysisEnabled) {
    $modelDirectory = Join-Path $workspacePath '.xhs-tools\transcription\models'
    $modelDirectory = Assert-PlainDirectoryPath $modelDirectory 'Transcription models'
    $ffmpegDirectory = Get-ChildItem -LiteralPath (Join-Path $workspacePath '.xhs-tools\ffmpeg') `
        -Directory -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
    $ffmpeg = Join-Path $ffmpegDirectory.FullName 'bin\ffmpeg.exe'
    $ffprobe = Join-Path $ffmpegDirectory.FullName 'bin\ffprobe.exe'
    foreach ($required in @($transcriptionPython, $ffmpeg, $ffprobe)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required offline analysis runtime is missing: $required"
        }
    }
    $transcriptionPython = Assert-PlainLeafPath $transcriptionPython 'Transcription Python'
    $ffmpeg = Assert-PlainLeafPath $ffmpeg 'FFmpeg'
    $ffprobe = Assert-PlainLeafPath $ffprobe 'FFprobe'
    $transcriber = Assert-PlainLeafPath (
        Join-Path $PSScriptRoot 'transcribe-pending-videos.py'
    ) 'Transcription runner'
    $model = if ($analysis.model) { [string]$analysis.model } else { 'small' }
    $language = if ($analysis.language) { [string]$analysis.language } else { 'zh' }
    $device = if ($analysis.device) { [string]$analysis.device } else { 'cpu' }
    $computeType = if ($analysis.compute_type) { [string]$analysis.compute_type } else { 'int8' }
    $maxItemSeconds = if ($analysis.max_item_seconds) { [double]$analysis.max_item_seconds } else { 600 }
    $maxBatchSeconds = if ($analysis.max_batch_seconds) { [double]$analysis.max_batch_seconds } else { 900 }
    $transcriptionArguments = @(
        $transcriber,
        '--media-dir', $mediaDirectory,
        '--curation', $curation,
        '--catalog', $catalog,
        '--config', $configPath,
        '--analysis-dir', $analysisDirectory,
        '--ffmpeg', $ffmpeg,
        '--ffprobe', $ffprobe,
        '--model', $model,
        '--model-dir', $modelDirectory,
        '--language', $language,
        '--device', $device,
        '--compute-type', $computeType,
        '--max-items', $MaxItems,
        '--max-item-seconds', $maxItemSeconds,
        '--max-batch-seconds', $maxBatchSeconds,
        '--status-file', $statusFile
    )
    foreach ($requestedNoteId in $requestedNoteIds) {
        $transcriptionArguments += @('--note-id', $requestedNoteId)
    }
    & $transcriptionPython @transcriptionArguments
    if ($LASTEXITCODE -ne 0) { throw 'Audio-first transcription failed.' }
}

$manualStatePath = Join-Path $workspacePath '.xhs-favorites\manual-sync.json'
if ($ocrEnabled -and ($requestedNoteIds.Count -or (Test-Path -LiteralPath $manualStatePath -PathType Leaf))) {
    $manualState = if (Test-Path -LiteralPath $manualStatePath -PathType Leaf) {
        $manualStatePath = Assert-PlainLeafPath $manualStatePath 'Manual safety state'
        Get-Content -Raw -Encoding UTF8 -LiteralPath $manualStatePath | ConvertFrom-Json
    } else {
        $null
    }
    if (-not $manualState -or $manualState.state -notin @('safety-stopped', 'safety_stopped')) {
        if (-not $python) { throw 'A local Python runtime is required for image OCR.' }
        $python = Assert-PlainLeafPath $python 'Local Python'
        $ocrEngine = [System.IO.Path]::GetFullPath((Join-Path $workspacePath ([string]$ocr.engine)))
        $workspacePrefix = $workspacePath.TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $ocrEngine.StartsWith(
            $workspacePrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'OCR engine must stay inside the workspace.'
        }
        if (Test-Path -LiteralPath $ocrEngine -PathType Leaf) {
            $ocrEngine = Assert-PlainLeafPath $ocrEngine 'OCR engine'
            $ocrRunner = Assert-PlainLeafPath (
                Join-Path $PSScriptRoot 'extract-pending-image-text.py'
            ) 'OCR runner'
            $ocrArguments = @(
                $ocrRunner,
                '--media-dir', $mediaDirectory,
                '--analysis-dir', $analysisDirectory,
                '--engine', $ocrEngine,
                '--catalog', $catalog,
                '--report', (Join-Path $workspacePath '.xhs-favorites\image-ocr-status.json')
            )
            $ocrNoteIds = if ($requestedNoteIds.Count) {
                $requestedNoteIds
            } else {
                @($manualState.frozen_scope.note_ids)
            }
            foreach ($requestedNoteId in $ocrNoteIds) {
                if ([string]$requestedNoteId -match '^[a-f0-9]{24}$') {
                    $ocrArguments += @('--note-id', $requestedNoteId)
                }
            }
            & $python @ocrArguments
            if ($LASTEXITCODE -ne 0) { throw 'Local image OCR failed.' }
        }
    }
}

if ($PrepareVisualEvidence) {
    if (-not $analysisEnabled) { throw 'Visual evidence requires video analysis to be enabled.' }
    $visualWindowSeconds = if ($analysis.visual_window_seconds) { [double]$analysis.visual_window_seconds } else { 30 }
    $maxVisualFrames = if ($analysis.max_visual_frames) { [int]$analysis.max_visual_frames } else { 60 }
    $maxVisualBytes = if ($analysis.max_visual_bytes) { [int]$analysis.max_visual_bytes } else { 20971520 }
    $maxVisualWallSeconds = if ($analysis.max_visual_wall_seconds) { [double]$analysis.max_visual_wall_seconds } else { 120 }
    $python = Assert-PlainLeafPath $python 'Local Python'
    $visualRunner = Assert-PlainLeafPath (
        Join-Path $PSScriptRoot 'extract-pending-frames.py'
    ) 'Visual evidence runner'
    $visualArguments = @(
        $visualRunner,
        '--media-dir', $mediaDirectory,
        '--curation', $curation,
        '--catalog', $catalog,
        '--config', $configPath,
        '--analysis-dir', $analysisDirectory,
        '--ffmpeg', $ffmpeg,
        '--ffprobe', $ffprobe,
        '--max-items', 1,
        '--window-seconds', $visualWindowSeconds,
        '--max-total-frames', $maxVisualFrames,
        '--max-total-bytes', $maxVisualBytes,
        '--max-wall-seconds', $maxVisualWallSeconds
    )
    foreach ($requestedNoteId in $requestedNoteIds) {
        $visualArguments += @('--note-id', $requestedNoteId)
    }
    & $python @visualArguments
    if ($LASTEXITCODE -ne 0) { throw 'On-demand sparse visual extraction failed.' }
}
