; Kill any running Punch instance before install so NSIS can overwrite the exe.
; Without this, the installer shows a "cannot close Punch — Retry / Cancel"
; loop when the user runs the installer manually while Punch is in the tray.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Punch.exe" /T'
  Sleep 500
!macroend
