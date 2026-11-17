# Invokes a button (by accessible name) in the main window of a process via UI Automation.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Name)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$h = (Get-Process -Id $ProcessId).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { 'no-window'; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$cond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
for ($i = 0; $i -lt 20; $i++) {
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el) {
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    'invoked'; exit 0
  }
  Start-Sleep -Milliseconds 500
}
'not-found'; exit 2
