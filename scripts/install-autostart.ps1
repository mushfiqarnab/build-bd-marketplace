<#
  scripts/install-autostart.ps1 - run the beta automatically when you log in to Windows.

    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1            # install
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove    # uninstall

  Registers a per-user Scheduled Task ("BuildBD Beta") that runs
  scripts\beta-up.ps1 at logon. No administrator rights needed, nothing
  installed system-wide, and -Remove deletes it again.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'BuildBD Beta'
$Root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[ OK ] Removed scheduled task '$TaskName'."
  } else {
    Write-Host "Nothing to remove - '$TaskName' is not installed."
  }
  exit 0
}

$script = Join-Path $Root 'scripts\beta-up.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory $Root
# Small delay so the network is up before ngrok connects.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT45S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Starts the Build-BD beta (API server + ngrok tunnel) at logon.' -Force | Out-Null
Write-Host "[ OK ] Installed '$TaskName': the beta will start about 45 seconds after you log in."
Write-Host "   Remove any time with: powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove"
