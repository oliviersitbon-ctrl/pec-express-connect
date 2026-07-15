; Mon devis dentaire Connecté NSIS Installer - v1.0.31 (fix service lock + logs precis)
;
; Mode oneClick + perMachine. Tous les logs ecrits dans C:\ProgramData\PecExpress\installer.log

!macro LogToFile MSG
  FileOpen $9 "C:\ProgramData\PecExpress\installer.log" a
  FileSeek $9 0 END
  FileWrite $9 "${MSG}$\r$\n"
  FileClose $9
!macroend

; customInit: AVANT install (mise a jour). Stoppe service+app pour liberer les fichiers.
!macro customInit
  CreateDirectory "C:\ProgramData\PecExpress"
  !insertmacro LogToFile "=== customInit START (install/update) ==="

  nsExec::ExecToStack 'sc stop PecExpressService'
  Pop $0 ; exit code
  Pop $1 ; output
  !insertmacro LogToFile "sc stop -> code=$0 out=$1"
  Sleep 2000

  nsExec::ExecToStack 'sc delete PecExpressService'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc delete -> code=$0 out=$1"
  Sleep 1000

  nsExec::ExecToStack 'taskkill /f /t /im "PecExpressService.exe"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "taskkill service.exe -> code=$0 out=$1"

  nsExec::ExecToStack 'taskkill /f /t /im "Mon devis dentaire Connecté.exe"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "taskkill app.exe -> code=$0 out=$1"
  Sleep 1500

  !insertmacro LogToFile "=== customInit END ==="
!macroend

; customUnInit: AVANT uninstall (suppression / mise a jour). Pareil.
!macro customUnInit
  CreateDirectory "C:\ProgramData\PecExpress"
  !insertmacro LogToFile "=== customUnInit START (uninstall before file removal) ==="

  nsExec::ExecToStack 'sc stop PecExpressService'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc stop -> code=$0 out=$1"
  Sleep 2000

  nsExec::ExecToStack 'sc delete PecExpressService'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc delete -> code=$0 out=$1"
  Sleep 1000

  nsExec::ExecToStack 'taskkill /f /t /im "PecExpressService.exe"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "taskkill service.exe -> code=$0 out=$1"

  nsExec::ExecToStack 'taskkill /f /t /im "Mon devis dentaire Connecté.exe"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "taskkill app.exe -> code=$0 out=$1"
  Sleep 1500

  !insertmacro LogToFile "=== customUnInit END ==="
!macroend

!macro customInstall
  !insertmacro LogToFile "=== customInstall START ==="
  DetailPrint "=== Configuration Mon devis dentaire Connecté ==="

  ; Safety net
  nsExec::Exec 'taskkill /f /t /im "Mon devis dentaire Connecté.exe" 2>nul'
  nsExec::Exec 'sc stop PecExpressService 2>nul'
  nsExec::Exec 'sc delete PecExpressService 2>nul'
  Sleep 500

  CreateDirectory "C:\ProgramData\PecExpress"

  DetailPrint "Installation du service PecExpressService..."
  nsExec::ExecToStack 'sc create PecExpressService binPath= "\"$INSTDIR\resources\native\PecExpressService.exe\"" start= auto DisplayName= "Mon devis dentaire Connecté Service"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc create -> code=$0 out=$1"

  nsExec::ExecToStack 'sc description PecExpressService "Service event-driven Mon devis dentaire Connecté: injecte la DLL PecExpress dans Logos via WMI ProcessStartTrace"'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc description -> code=$0 out=$1"

  nsExec::ExecToStack 'sc failure PecExpressService reset= 86400 actions= restart/5000/restart/5000/restart/5000'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc failure -> code=$0 out=$1"

  nsExec::ExecToStack 'sc start PecExpressService'
  Pop $0
  Pop $1
  !insertmacro LogToFile "sc start -> code=$0 out=$1"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PecExpress" '"$INSTDIR\Mon devis dentaire Connecté.exe" --hidden'
  !insertmacro LogToFile "HKLM Run key written"

  !insertmacro LogToFile "=== customInstall END (OK) ==="
  DetailPrint "=== Installation terminee ==="
!macroend

!macro customUnInstall
  !insertmacro LogToFile "=== customUnInstall START (after file removal) ==="
  DetailPrint "Suppression auto-start..."
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PecExpress"

  DetailPrint "Nettoyage..."
  RMDir /r "$APPDATA\pec-express-connect"
  RMDir /r "$LOCALAPPDATA\PecExpress"
  RMDir /r "C:\ProgramData\PecExpress"
  !insertmacro LogToFile "=== customUnInstall END ==="
!macroend
