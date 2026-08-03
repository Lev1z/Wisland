!macro NSIS_HOOK_PREINSTALL
  ; 删除同路径的旧桌面快捷方式，避免 Windows 沿用旧图标缓存。
  SetShellVarContext current
  Delete "$DESKTOP\Wisland.lnk"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 通知 Explorer 重新读取 EXE/快捷方式图标。
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
