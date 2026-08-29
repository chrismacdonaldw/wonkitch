!macro NSIS_HOOK_POSTINSTALL
  ; When Streamlink is bumped, remove only explicitly retired version directories here.
  ; Let the old WebView profile shut down before an updater-triggered relaunch.
  ${If} $UpdateMode = 1
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ClearErrors
      ExecShell "" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -NonInteractive -WindowStyle Hidden -Command $\"Start-Sleep -Seconds 3; Start-Process -FilePath '$INSTDIR\${MAINBINARYNAME}.exe'$\"" SW_HIDE
      ${IfNot} ${Errors}
        StrCpy $CMDLINE ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\streamlink"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
!macroend
