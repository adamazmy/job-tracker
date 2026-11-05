# Starts the Job Tracker server (if it is not already running) and opens it
# in the default browser. Used by the desktop shortcut and start-job-tracker.cmd.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { 4870 }
$url = "http://localhost:$port/"

function Test-Tracker {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
        return ($r.app -eq 'job-tracker')
    } catch { return $false }
}

if (-not (Test-Tracker)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('Node.js was not found. Install it from https://nodejs.org and try again.', 'Job Tracker') | Out-Null
        exit 1
    }
    $logDir = Join-Path $root 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log')
    for ($i = 0; $i -lt 40 -and -not (Test-Tracker); $i++) { Start-Sleep -Milliseconds 250 }
}

Start-Process $url
