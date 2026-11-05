# Creates a "Job Tracker" shortcut on the desktop that starts the app and
# opens it in the browser. Safe to run again; it overwrites the shortcut.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Job Tracker.lnk'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $ps
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\launch.ps1`""
$s.WorkingDirectory = $root
$s.WindowStyle = 7  # minimised
$s.IconLocation = "$env:SystemRoot\System32\imageres.dll,109"
$s.Description = 'Start Job Tracker and open it in the browser'
$s.Save()
Write-Host "Shortcut created: $lnk"
