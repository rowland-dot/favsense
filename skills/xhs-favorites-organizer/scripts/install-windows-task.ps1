[CmdletBinding()]
param(
    [Parameter()][string]$Workspace = (Get-Location).Path,
    [Parameter()][string]$Config = (Join-Path (Get-Location).Path 'config\xhs-favorites.json'),
    [Parameter()][string]$At,
    [Parameter()][string]$TaskName = 'FavSense-Daily'
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$configPath = [System.IO.Path]::GetFullPath($Config)
$configObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
if (-not $At) { $At = [string]$configObject.schedule_local }
if ($At -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') { throw 'At or config.schedule_local must use HH:mm local machine time.' }
$runner = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-daily.ps1'))
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Workspace `"$workspacePath`" -Config `"$configPath`" -Mode daily"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $workspacePath
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Sync enabled Xiaohongshu favorites into the local FavSense knowledge base.' -Force | Out-Null
Write-Output "Scheduled task '$TaskName' installed for $At (only while this user is logged on)."
