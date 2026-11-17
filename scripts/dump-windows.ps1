# Writes the visible text of all top-level windows owned by a process (UTF-8 file, avoids console codepage issues).
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$OutFile)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::RootElement
$lines = @()
foreach ($w in $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
  if ($w.Current.ProcessId -ne $ProcessId) { continue }
  $lines += "WINDOW: $($w.Current.Name)"
  foreach ($d in $w.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
    if ($d.Current.Name) { $lines += "  $($d.Current.Name)" }
  }
}
[IO.File]::WriteAllLines($OutFile, $lines, (New-Object Text.UTF8Encoding $false))
