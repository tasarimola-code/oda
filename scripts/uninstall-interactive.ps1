# Runs the ODA uninstaller interactively: clicks through the wizard pages and answers the
# "delete user data?" question. Usage: uninstall-interactive.ps1 -Answer Evet|Hayır
param([ValidateSet('Evet', 'Hayır')][string]$Answer = 'Hayır')
$inst = "$env:LOCALAPPDATA\Programs\ODA"
$click = Join-Path $PSScriptRoot 'click-dialog-button.ps1'
$before = @(Get-Process | Where-Object { $_.ProcessName -like 'Un_*' } | ForEach-Object { $_.Id })
Start-Process -FilePath "$inst\Uninstall ODA.exe" -ArgumentList '/currentuser'
# The stub copies itself to %TEMP% as Un_*.exe and exits; the wizard runs in that process.
$un = $null
for ($i = 0; $i -lt 40 -and -not $un; $i++) {
  Start-Sleep -Milliseconds 500
  $un = Get-Process | Where-Object { $_.ProcessName -like 'Un_*' -and $before -notcontains $_.Id -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}
if (-not $un) { 'uninstaller window not found'; exit 1 }
$answered = $false
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not $un.HasExited) {
  if (-not $answered -and (& $click -ProcessId $un.Id -Caption $Answer) -eq 'True') { $answered = $true; "ANSWERED: $Answer" }
  foreach ($caption in @('İleri >', 'Kaldır', 'Kapat', 'Bitir')) { [void](& $click -ProcessId $un.Id -Caption $caption) }
  Start-Sleep -Milliseconds 500
}
# Deleting user data happens while the wizard finishes; wait until every uninstaller process is gone.
for ($i = 0; $i -lt 120 -and (Get-Process | Where-Object { $_.ProcessName -like 'Un_*' }); $i++) { Start-Sleep -Milliseconds 500 }
"answered=$answered programRemoved=$(-not (Test-Path "$inst\ODA.exe")) userDataExists=$(Test-Path "$env:APPDATA\ODA")"
