; electron-builder `nsis.include`: ViBread's additions to the Windows installer and uninstaller.
;
; ViBread ships about 16,000 files (its own Node.js and the server's packages). On an upgrade, electron-builder's
; uninstaller moves the old files away one by one and, if a single one is busy (an antivirus or search-index scan, a
; leftover process), puts everything back and fails; the new installer then stops with "Failed to uninstall old
; application files. Please try running the installer again." These macros make an upgrade install over the old files.

; Uninstaller (this version and later): remove the files in place, for upgrades too. Whatever can't be removed now is
; replaced by the new version's files.
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend

; Installer: the old version's uninstaller (0.1.104 and earlier use the one-by-one move above) couldn't remove its
; files. Install over it instead of stopping: every file of the new version is copied over the old one.
!macro customUnInstallCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return
  ${if} $R0 != 0
    DetailPrint `The old version's uninstaller stopped (code $R0); installing over it.`
  ${endIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend
