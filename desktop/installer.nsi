Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
!include "MUI2.nsh"
!define APP "Vigilfall"
!define VER "1.0.0"
Name "${APP}"
OutFile "dist/Vigilfall-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Vigilfall"
InstallDirRegKey HKCU "Software\Vigilfall" "InstallDir"
RequestExecutionLevel user
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Vigilfall"
VIAddVersionKey "FileDescription" "Vigilfall Setup"
VIAddVersionKey "CompanyName" "polemarxos"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "ProductVersion" "${VER}"
VIAddVersionKey "LegalCopyright" "polemarxos"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Vigilfall.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Greek"
Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd
Section "Install"
  ; close a running copy so its files can be replaced
  nsExec::Exec 'taskkill /F /IM Vigilfall.exe'
  Sleep 500
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*.*"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall Vigilfall.exe"
  CreateShortcut "$DESKTOP\Vigilfall.lnk" "$INSTDIR\Vigilfall.exe" "" "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\Vigilfall.lnk" "$INSTDIR\Vigilfall.exe" "" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "Software\Vigilfall" "InstallDir" "$INSTDIR"
  !define UK "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vigilfall"
  WriteRegStr HKCU "${UK}" "DisplayName" "Vigilfall"
  WriteRegStr HKCU "${UK}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UK}" "Publisher" "polemarxos"
  WriteRegStr HKCU "${UK}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UK}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UK}" "UninstallString" '"$INSTDIR\Uninstall Vigilfall.exe"'
  WriteRegDWORD HKCU "${UK}" "NoModify" 1
  WriteRegDWORD HKCU "${UK}" "NoRepair" 1
SectionEnd
Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM Vigilfall.exe'
  Sleep 500
  Delete "$DESKTOP\Vigilfall.lnk"
  Delete "$SMPROGRAMS\Vigilfall.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vigilfall"
  DeleteRegKey HKCU "Software\Vigilfall"
SectionEnd
