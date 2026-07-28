[CmdletBinding()]
param(
    [Parameter()]
    [string]$Workspace = (Get-Location).Path,

    [Parameter()]
    [int]$Port = 47631
)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$expectedBridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge-server.py'))
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

if ($listeners.Count -eq 0) {
    Write-Output "No bridge is listening on 127.0.0.1:$Port"
    return
}
if ($listeners.Count -ne 1) {
    throw "Expected one listener on 127.0.0.1:$Port but found $($listeners.Count)."
}

$processId = $listeners[0].OwningProcess
$process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId"
if (-not $process) {
    throw "The process listening on 127.0.0.1:$Port could not be inspected."
}
$actualExecutable = if ($process.ExecutablePath) { [System.IO.Path]::GetFullPath($process.ExecutablePath) } else { '' }
$commandLine = [string]$process.CommandLine
if (
    [System.IO.Path]::GetFileName($actualExecutable) -ne 'python.exe' -or
    $commandLine -notmatch [regex]::Escape($expectedBridge) -or
    $commandLine -notmatch [regex]::Escape($workspacePath) -or
    $commandLine -notmatch "--port\s+$Port(?:\s|$)"
) {
    throw "Refusing to stop process $processId because it is not the expected XHS favorites bridge."
}

Stop-Process -Id $processId -Force
Write-Output "Stopped XHS favorites bridge process $processId."
