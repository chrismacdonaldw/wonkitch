!macro NSIS_HOOK_POSTINSTALL
  ; When Streamlink is bumped, remove only explicitly retired version directories here.
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\streamlink"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
!macroend
