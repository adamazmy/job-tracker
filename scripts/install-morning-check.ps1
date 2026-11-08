# Creates (or updates) the Windows scheduled task that checks Outlook every
# morning. Runs as you, only while you are signed in, so no password is stored.
# If the PC is off or asleep at that time, it runs as soon as it can.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-morning-check.ps1 [-Time 07:30]
#   ... -Remove    to delete the task
param(
    [string]$Time = '07:30',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$taskName = 'Job Tracker morning check'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed '$taskName'."
    exit 0
}

$scan = Join-Path $PSScriptRoot 'scan.ps1'
$root = Split-Path -Parent $PSScriptRoot
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scan`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Read-only Outlook check for the local Job Tracker. Log: logs\scan.log' -Force | Out-Null
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Scheduled '$taskName' daily at $Time. Next run: $($info.NextRunTime)"
