# Runs the automatic Outlook check (scripts/run-scan.js) and appends its output
# to logs/scan.log. Started each morning by the "Job Tracker morning check"
# scheduled task (see scripts/install-morning-check.ps1).
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'scan.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Add-Content -Path $logFile -Encoding utf8 -Value "[$((Get-Date).ToString('s'))] FAILED: Node.js was not found."
    exit 1
}

Set-Location $root
$output = & $node (Join-Path $root 'scripts\run-scan.js') @args 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
Add-Content -Path $logFile -Encoding utf8 -Value $output

# Keep the log small: last 2000 lines.
$lines = Get-Content -Path $logFile -Encoding utf8
if ($lines.Count -gt 2000) { $lines | Select-Object -Last 2000 | Set-Content -Path $logFile -Encoding utf8 }
exit $code
