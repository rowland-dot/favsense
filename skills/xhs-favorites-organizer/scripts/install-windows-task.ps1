[CmdletBinding()]
param(
    [Parameter()][string]$TaskName = 'FavSense-Daily'
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed legacy task '$TaskName'. FavSense organization is now triggered from the local settings page."
} else {
    Write-Output "No legacy FavSense daily task is installed. Organization is triggered from the local settings page."
}
