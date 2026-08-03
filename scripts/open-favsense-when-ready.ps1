[CmdletBinding()]
param(
    [Parameter()]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'SilentlyContinue'
$url = 'http://127.0.0.1:8766/'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $url -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
            Start-Process $url
            exit 0
        }
    } catch {
        # The local web server is still starting.
    }
    Start-Sleep -Milliseconds 400
}

exit 1
