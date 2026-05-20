; Kill any running Punch instance before install so NSIS can overwrite the exe.
; Without this, the installer shows a "cannot close Punch — Retry / Cancel"
; loop when the user runs the installer manually while Punch is in the tray.
; ExecWait (not nsExec::Exec) is used here because nsExec::Exec pushes its
; return code onto the NSIS stack without popping it, which corrupts the stack
; inside customInit and causes the installer to abort silently.
!macro customInit
  ExecWait 'taskkill /F /IM "Punch.exe" /T' $R0
  Sleep 500
!macroend
