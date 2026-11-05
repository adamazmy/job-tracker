# Stops the Job Tracker server started by launch.ps1.
$port = if ($env:PORT) { $env:PORT } else { 4870 }
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) { Write-Host 'Job Tracker is not running.'; exit 0 }
foreach ($c in $conn) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id; Write-Host "Stopped Job Tracker (PID $($p.Id))." }
}
