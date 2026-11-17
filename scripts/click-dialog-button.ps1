# Clicks a button (by caption) in any dialog window owned by the given process, using BM_CLICK.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Caption)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OdaDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static bool Click(uint pid, string caption) {
    bool done = false;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || done) return true;
      EnumChildWindows(h, (c, l2) => {
        var cls = new StringBuilder(64); GetClassName(c, cls, 64);
        var txt = new StringBuilder(256); GetWindowText(c, txt, 256);
        if (cls.ToString() == "Button" && txt.ToString().Replace("&", "") == caption) {
          SendMessage(c, 0x00F5, IntPtr.Zero, IntPtr.Zero);
          done = true; return false;
        }
        return true;
      }, IntPtr.Zero);
      return !done;
    }, IntPtr.Zero);
    return done;
  }
}
"@
[OdaDlg]::Click([uint32]$ProcessId, $Caption)
