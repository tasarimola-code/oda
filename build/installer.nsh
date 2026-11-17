; ODA custom NSIS steps (included by electron-builder).
; User data lives in %APPDATA%\ODA and is never touched by install/update.

!macro customInstall
  ; ODA only makes outgoing connections to ODA servers. Remove the inbound rule older versions added.
  ${if} $installMode == "all"
    nsExec::Exec 'netsh advfirewall firewall delete rule name="ODA"'
    Pop $0
  ${endif}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'netsh advfirewall firewall delete rule name="ODA"'
    Pop $0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ODA"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ODA"

    SetShellVarContext current
    ${if} ${FileExists} "$APPDATA\ODA\*.*"
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "ODA kaldırılıyor.$\r$\n$\r$\nKullanıcı verileri de silinsin mi?$\r$\n$\r$\nBu klasör şunları içerir: katıldığın sunucuların cihaz anahtarları, ayarlar ve günlükler. Mesajların sunucuda kalır.$\r$\n$APPDATA\ODA$\r$\n$\r$\nEvet: veriler kalıcı olarak silinir (geri alınamaz); sunucuya tekrar girmek için yeni davet gerekir.$\r$\nHayır: veriler korunur; ODA yeniden kurulduğunda kaldığın yerden devam eder." /SD IDNO IDYES`
        RMDir /r "$APPDATA\ODA"
      ${endif}
    ${endif}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
