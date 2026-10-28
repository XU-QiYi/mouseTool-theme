Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!define MUI_CUSTOMFUNCTION_GUIINIT UiGuiInit

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
Caption "Mouse Theme 安装向导"
BrandingText " "
OutFile "${OUTFILE}"
!if "${INSTALLERICON}" != ""
  Icon "${INSTALLERICON}"
  UninstallIcon "${INSTALLERICON}"
!endif

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; ===== 安装器界面：按 docs/安装器原型/setup-ui-prototype.html 整窗自绘 =====
!include nsDialogs.nsh
!include LogicLib.nsh

; ---------------- 自绘 UI 常量 ----------------
!define UI_STYLE_LABEL     0x50000080   ; WS_CHILD|WS_VISIBLE|SS_NOPREFIX
!define UI_STYLE_LABEL_MID 0x50000280   ; + SS_CENTERIMAGE
!define UI_STYLE_LABEL_MID_NOTIFY 0x50000380 ; + SS_NOTIFY（卡片文字也要能点）
!define UI_STYLE_LABEL_RIGHT 0x50000282 ; + SS_CENTERIMAGE|SS_RIGHT
!define UI_STYLE_BMP       0x5000004E   ; SS_BITMAP|SS_REALSIZECONTROL
!define UI_STYLE_BMP_NOTIFY 0x5000014E ; + SS_NOTIFY

; ---------------- 自绘 UI 变量 ----------------
Var Dlg
Var UiParent
Var UiStep
Var UiDpi
Var UiScalePct
Var UiHi
Var UiDX
Var UiDY
Var UiDW
Var UiDH
Var UiX
Var UiY
Var UiWpx
Var UiHpx
Var UiCtl
Var UiId
Var UiStyle
Var UiFont
Var UiFace
Var UiFontPx
Var UiFontWeight
Var UiFontHwnd
Var UiText
Var UiBmp
Var UiAssetName
Var UiAssetHwnd
Var UiReady
Var UiPct
Var UiStage
Var UiStatus
Var UiTarget
Var UiRow
Var UiRowState
Var UiStepNum
Var UiRowY
Var InstDlg
Var InstFillX
Var InstFillY
Var InstFillH
Var UiBtnKind
Var UiBtnBmp
Var UiPrimaryX
Var DeskShortcutChecked
Var AutoStartChecked
Var OptionsDirCtl
Var OptionsDeskCtl
Var OptionsAutoCtl
Var ReinstRadio1
Var ReinstRadio2
Var DotDesk
Var DotAuto
Var DotRun
Var DotRadio1
Var DotRadio2
Var RingDesk
Var RingAuto
Var RingRadio1
Var RingRadio2
Var RingRun
Var BadgeCtl
Var UiBadgeFrame
Var UiSpinFrame
Var UiDirInit
Var ReinstChoice
Var FinishRunCtl
Var InstalledVersion
Var AppStartMenuFolder

Var FntH2
Var FntTitle
Var FntBody
Var FntBodyB
Var FntBody13
Var FntBody13B
Var FntSmall

Var BmpSidebar
Var BmpLogo
Var BmpTile1
Var BmpTile2
Var BmpTile3
Var BmpPill
Var BmpDotA1
Var BmpDotA2
Var BmpDotA3
Var BmpDotA4
Var BmpDotT1
Var BmpDotT2
Var BmpDotT3
Var BmpDotT4
Var BmpDotDone
Var BmpCard
Var BmpCardTall
Var BmpTip
Var BmpInput
Var BmpTrack
Var BmpBadge1
Var BmpBadge2
Var BmpBadge3
Var BmpBadge4
Var BmpLogTodo
Var BmpSpin1
Var BmpSpin2
Var BmpSpin3
Var BmpSpin4
Var BmpSpin5
Var BmpSpin6
Var BmpSpin7
Var BmpSpin8
Var BmpLogDone
Var BmpCheckOff
Var BmpCheckOn
Var BmpRadioOff
Var BmpRadioOn
Var BmpRingCheck
Var BmpRingRadio
Var BmpBtnNext
Var BmpBtnInstall
Var BmpBtnFinish
Var BmpBtnBack
Var BmpBtnBrowse
Var BmpBtnInstalling
Var BmpFill

; ---------------- 宏：设计坐标缩放 + 控件创建 ----------------
!macro UI_RECT X Y W H
  StrCpy $UiDX ${X}
  StrCpy $UiDY ${Y}
  StrCpy $UiDW ${W}
  StrCpy $UiDH ${H}
  Call UiScaleBox
!macroend

!macro UI_LABEL ID TEXT FONT FG BG STYLE
  StrCpy $UiId ${ID}
  StrCpy $UiText "${TEXT}"
  StrCpy $UiFont ${FONT}
  StrCpy $UiStyle ${STYLE}
  Call UiMakeLabel
  SetCtlColors $UiCtl ${FG} ${BG}
!macroend

!macro UI_BITMAP ID BMP STYLE
  StrCpy $UiId ${ID}
  StrCpy $UiBmp ${BMP}
  StrCpy $UiStyle ${STYLE}
  Call UiMakeBitmap
!macroend

!macro UI_CLICKLABEL TEXT FONT FG BG STYLE
  StrCpy $UiText "${TEXT}"
  StrCpy $UiFont ${FONT}
  StrCpy $UiStyle ${STYLE}
  nsDialogs::CreateControl "STATIC" "$UiStyle" 0 $UiX $UiY $UiWpx $UiHpx "$UiText"
  Pop $UiCtl
  SendMessage $UiCtl ${WM_SETFONT} $UiFont 1
  SetCtlColors $UiCtl ${FG} ${BG}
!macroend

!macro UI_CLICKBITMAP BMP
  StrCpy $UiBmp ${BMP}
  nsDialogs::CreateControl "STATIC" "${UI_STYLE_BMP_NOTIFY}" 0 $UiX $UiY $UiWpx $UiHpx ""
  Pop $UiCtl
  SendMessage $UiCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
!macroend

; ---------------- 基础绘制函数 ----------------
Function UiScaleBox
  IntOp $UiX $UiDX * $UiDpi
  IntOp $UiX $UiX / 96
  IntOp $UiY $UiDY * $UiDpi
  IntOp $UiY $UiY / 96
  IntOp $UiWpx $UiDW * $UiDpi
  IntOp $UiWpx $UiWpx / 96
  IntOp $UiHpx $UiDH * $UiDpi
  IntOp $UiHpx $UiHpx / 96
FunctionEnd

Function UiMakeLabel
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w '', i $UiStyle, i $UiX, i $UiY, i $UiWpx, i $UiHpx, p $UiParent, i $UiId, i 0, i 0) p .r0"
  StrCpy $UiCtl $0
  ${If} $UiText != ""
    SendMessage $UiCtl ${WM_SETTEXT} 0 "STR:$UiText"
  ${EndIf}
  SendMessage $UiCtl ${WM_SETFONT} $UiFont 1
FunctionEnd

Function UiMakeBitmap
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w '', i $UiStyle, i $UiX, i $UiY, i $UiWpx, i $UiHpx, p $UiParent, i $UiId, i 0, i 0) p .r0"
  StrCpy $UiCtl $0
  ${If} $UiBmp != 0
    SendMessage $UiCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
  ${EndIf}
FunctionEnd

Function UiFitDlg
  Exch $0
  System::Call '*(i 0, i 0, i 0, i 0) p .r5'
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r5)"
  System::Call '*$5(i .r1, i .r2, i .r3, i .r4)'
  System::Call "user32::MoveWindow(p r0, i 0, i 0, i r3, i r4, i 1)"
  System::Free $5
  Pop $0
FunctionEnd

Function UiFitPlaceholder
  GetDlgItem $0 $HWNDPARENT 1018
  ${If} $0 != 0
    Push $0
    Call UiFitDlg
  ${EndIf}
FunctionEnd

Function UiHideStock
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

; ---------------- 侧栏与页眉页脚 ----------------
Function UiStepRow
  ; $UiStepNum / $UiRowY
  ${If} $UiStepNum == $UiStep
    !insertmacro UI_RECT 20 $UiRowY 160 34
    !insertmacro UI_BITMAP 0 $BmpPill ${UI_STYLE_BMP}
  ${EndIf}

  IntOp $0 $UiRowY + 7
  !insertmacro UI_RECT 28 $0 20 20
  ${If} $UiStepNum < $UiStep
    StrCpy $0 $BmpDotDone
  ${ElseIf} $UiStepNum == $UiStep
    ${If} $UiStepNum == 1
      StrCpy $0 $BmpDotA1
    ${ElseIf} $UiStepNum == 2
      StrCpy $0 $BmpDotA2
    ${ElseIf} $UiStepNum == 3
      StrCpy $0 $BmpDotA3
    ${Else}
      StrCpy $0 $BmpDotA4
    ${EndIf}
  ${Else}
    ${If} $UiStepNum == 1
      StrCpy $0 $BmpDotT1
    ${ElseIf} $UiStepNum == 2
      StrCpy $0 $BmpDotT2
    ${ElseIf} $UiStepNum == 3
      StrCpy $0 $BmpDotT3
    ${Else}
      StrCpy $0 $BmpDotT4
    ${EndIf}
  ${EndIf}
  !insertmacro UI_BITMAP 0 $0 ${UI_STYLE_BMP}

  ${If} $UiStepNum == 1
    StrCpy $UiText "欢迎"
  ${ElseIf} $UiStepNum == 2
    StrCpy $UiText "安装选项"
  ${ElseIf} $UiStepNum == 3
    StrCpy $UiText "正在安装"
  ${Else}
    StrCpy $UiText "完成"
  ${EndIf}
  IntOp $0 $UiRowY + 7
  !insertmacro UI_RECT 58 $0 114 20
  ${If} $UiStepNum == $UiStep
    !insertmacro UI_LABEL 0 "$UiText" $FntBody13 0xffffff 0x32343a ${UI_STYLE_LABEL_MID}
  ${ElseIf} $UiStepNum < $UiStep
    !insertmacro UI_LABEL 0 "$UiText" $FntBody13 0xc9cddb 0x1f2128 ${UI_STYLE_LABEL_MID}
  ${Else}
    !insertmacro UI_LABEL 0 "$UiText" $FntBody13 0x8d93a3 0x1f2128 ${UI_STYLE_LABEL_MID}
  ${EndIf}
FunctionEnd

Function UiDrawChrome
  ; 侧栏背景
  !insertmacro UI_RECT 0 0 200 448
  !insertmacro UI_BITMAP 0 $BmpSidebar ${UI_STYLE_BMP}
  ; 图标 + 标题 + 版本
  !insertmacro UI_RECT 20 28 44 44
  !insertmacro UI_BITMAP 0 $BmpLogo ${UI_STYLE_BMP}
  !insertmacro UI_RECT 20 86 160 27
  !insertmacro UI_LABEL 0 "Mouse Theme" $FntTitle 0xe8eaf0 0x1f2128 ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 20 115 160 18
  !insertmacro UI_LABEL 0 "版本 ${VERSION}" $FntSmall 0x9aa0ae 0x1f2128 ${UI_STYLE_LABEL_MID}

  ; 四个步骤
  StrCpy $UiStepNum 1
  StrCpy $UiRowY 169
  Call UiStepRow
  StrCpy $UiStepNum 2
  StrCpy $UiRowY 207
  Call UiStepRow
  StrCpy $UiStepNum 3
  StrCpy $UiRowY 245
  Call UiStepRow
  StrCpy $UiStepNum 4
  StrCpy $UiRowY 283
  Call UiStepRow

  ; 页脚底板与分隔线
  !insertmacro UI_RECT 200 384 480 64
  !insertmacro UI_LABEL 0 "" $FntSmall 0 0xfafafa ${UI_STYLE_LABEL}
  !insertmacro UI_RECT 200 384 480 1
  !insertmacro UI_LABEL 0 "" $FntSmall 0 0xebebeb ${UI_STYLE_LABEL}
FunctionEnd

; ---------------- 页面初始化 ----------------
Function UiBeginPage
  Call UiHideStock
  Call UiFitPlaceholder
  nsDialogs::Create 1018
  Pop $Dlg
  ${If} $Dlg == error
    Abort
  ${EndIf}
  Push $Dlg
  Call UiFitDlg
  StrCpy $UiParent $Dlg
  StrCpy $DotDesk 0
  StrCpy $DotAuto 0
  StrCpy $DotRun 0
  StrCpy $DotRadio1 0
  StrCpy $DotRadio2 0
  StrCpy $RingDesk 0
  StrCpy $RingAuto 0
  StrCpy $RingRadio1 0
  StrCpy $RingRadio2 0
  StrCpy $RingRun 0
  StrCpy $BadgeCtl 0
  StrCpy $UiBadgeFrame 0
  StrCpy $UiSpinFrame 0
  StrCpy $UiDirInit 0
  StrCpy $OptionsDirCtl 0
  SetCtlColors $Dlg 0 0xffffff
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Mouse Theme 安装向导"
  !insertmacro UI_RECT 0 0 680 448
  !insertmacro UI_LABEL 0 "" $FntSmall 0 0xffffff ${UI_STYLE_LABEL}
  Call UiDrawChrome
FunctionEnd

; ---------------- 页脚按钮 ----------------
Function UiMakeFooterButton
  ; $UiBtnKind: 0=右侧主按钮, 1=返回按钮；$UiBtnBmp / $UiText
  ${If} $UiBtnKind == 0
    StrCpy $0 96
  ${Else}
    StrCpy $0 80
  ${EndIf}
  IntOp $1 $0 * $UiScalePct
  IntOp $1 $1 / 100
  IntOp $2 36 * $UiScalePct
  IntOp $2 $2 / 100
  IntOp $3 644 * $UiDpi
  IntOp $3 $3 / 96
  ${If} $UiBtnKind == 0
    IntOp $UiPrimaryX $3 - $1
    StrCpy $UiX $UiPrimaryX
  ${Else}
    IntOp $4 8 * $UiDpi
    IntOp $4 $4 / 96
    IntOp $4 $UiPrimaryX - $4
    IntOp $UiX $4 - $1
  ${EndIf}
  IntOp $UiY 398 * $UiDpi
  IntOp $UiY $UiY / 96
  StrCpy $UiWpx $1
  StrCpy $UiHpx $2
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_PUSHBUTTON}|${BS_BITMAP}|${BS_FLAT}" 0 $UiX $UiY $UiWpx $UiHpx "$UiText"
  Pop $UiCtl
  System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
  SendMessage $UiCtl ${BM_SETIMAGE} ${IMAGE_BITMAP} $UiBtnBmp
FunctionEnd

Function UiMakeBrowseButton
  !insertmacro UI_RECT 574 139 70 36
  IntOp $0 70 * $UiScalePct
  IntOp $0 $0 / 100
  StrCpy $UiWpx $0
  IntOp $0 36 * $UiScalePct
  IntOp $0 $0 / 100
  StrCpy $UiHpx $0
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_PUSHBUTTON}|${BS_BITMAP}|${BS_FLAT}" 0 $UiX $UiY $UiWpx $UiHpx "浏览…"
  Pop $UiCtl
  System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
  SendMessage $UiCtl ${BM_SETIMAGE} ${IMAGE_BITMAP} $BmpBtnBrowse
FunctionEnd

; ---------------- 安装进度页更新时间 ----------------
; ---------------- 自绘勾选/单选：状态同步与点击 ----------------
Function UiSyncDesk
  ${If} $DotDesk == 0
    Return
  ${EndIf}
  SendMessage $OptionsDeskCtl ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $UiBmp $BmpCheckOn
  ${Else}
    StrCpy $UiBmp $BmpCheckOff
  ${EndIf}
  SendMessage $DotDesk ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
FunctionEnd

Function UiSyncAuto
  ${If} $DotAuto == 0
    Return
  ${EndIf}
  SendMessage $OptionsAutoCtl ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $UiBmp $BmpCheckOn
  ${Else}
    StrCpy $UiBmp $BmpCheckOff
  ${EndIf}
  SendMessage $DotAuto ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
FunctionEnd

Function UiSyncRun
  ${If} $DotRun == 0
    Return
  ${EndIf}
  SendMessage $FinishRunCtl ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $UiBmp $BmpCheckOn
  ${Else}
    StrCpy $UiBmp $BmpCheckOff
  ${EndIf}
  SendMessage $DotRun ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
FunctionEnd

Function UiSyncReinst
  ${If} $DotRadio1 == 0
    Return
  ${EndIf}
  SendMessage $ReinstRadio1 ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $UiBmp $BmpRadioOn
  ${Else}
    StrCpy $UiBmp $BmpRadioOff
  ${EndIf}
  SendMessage $DotRadio1 ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
  ${If} $DotRadio2 == 0
    Return
  ${EndIf}
  SendMessage $ReinstRadio2 ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $UiBmp $BmpRadioOn
  ${Else}
    StrCpy $UiBmp $BmpRadioOff
  ${EndIf}
  SendMessage $DotRadio2 ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
FunctionEnd

Function OnDeskCtrl
  Pop $0
  Call UiSyncDesk
FunctionEnd
Function OnAutoCtrl
  Pop $0
  Call UiSyncAuto
FunctionEnd
Function OnRunCtrl
  Pop $0
  Call UiSyncRun
FunctionEnd
Function OnReinstCtrl
  Pop $0
  Call UiSyncReinst
FunctionEnd

Function UiFocusTimer
  System::Call "user32::GetFocus() p .r0"
  ${If} $RingDesk != 0
    ${If} $0 == $OptionsDeskCtl
      ShowWindow $RingDesk ${SW_SHOW}
    ${Else}
      ShowWindow $RingDesk ${SW_HIDE}
    ${EndIf}
  ${EndIf}
  ${If} $RingAuto != 0
    ${If} $0 == $OptionsAutoCtl
      ShowWindow $RingAuto ${SW_SHOW}
    ${Else}
      ShowWindow $RingAuto ${SW_HIDE}
    ${EndIf}
  ${EndIf}
  ${If} $RingRadio1 != 0
    ${If} $0 == $ReinstRadio1
      ShowWindow $RingRadio1 ${SW_SHOW}
    ${Else}
      ShowWindow $RingRadio1 ${SW_HIDE}
    ${EndIf}
  ${EndIf}
  ${If} $RingRadio2 != 0
    ${If} $0 == $ReinstRadio2
      ShowWindow $RingRadio2 ${SW_SHOW}
    ${Else}
      ShowWindow $RingRadio2 ${SW_HIDE}
    ${EndIf}
  ${EndIf}
  ${If} $RingRun != 0
    ${If} $0 == $FinishRunCtl
      ShowWindow $RingRun ${SW_SHOW}
    ${Else}
      ShowWindow $RingRun ${SW_HIDE}
    ${EndIf}
  ${EndIf}

  ; Edit 的初值在页面创建阶段不绘制，等页面可见后首帧补写一次
  ${If} $OptionsDirCtl != 0
    ${If} $UiDirInit == 0
      SendMessage $OptionsDirCtl ${WM_SETTEXT} 0 "STR:$INSTDIR"
      SendMessage $OptionsDirCtl 0x00B1 0 0
      StrCpy $UiDirInit 1
    ${EndIf}
  ${EndIf}
FunctionEnd

Function UiBadgeTick
  IntOp $UiBadgeFrame $UiBadgeFrame + 1
  ${If} $UiBadgeFrame > 4
    ${NSD_KillTimer} UiBadgeTick
    Return
  ${EndIf}
  ${If} $UiBadgeFrame = 2
    StrCpy $UiBmp $BmpBadge2
  ${ElseIf} $UiBadgeFrame = 3
    StrCpy $UiBmp $BmpBadge3
  ${Else}
    StrCpy $UiBmp $BmpBadge4
  ${EndIf}
  SendMessage $BadgeCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
  ${If} $UiBadgeFrame >= 4
    ${NSD_KillTimer} UiBadgeTick
  ${EndIf}
FunctionEnd

Function UiSetLogRow
  ${If} $UiReady != 1
    Return
  ${EndIf}
  IntOp $0 3010 + $UiRow
  GetDlgItem $1 $InstDlg $0
  ${If} $UiRowState == 2
    SetCtlColors $1 0x252525 0xffffff
    StrCpy $UiBmp $BmpLogDone
  ${ElseIf} $UiRowState == 1
    SetCtlColors $1 0x252525 0xffffff
    IntOp $UiSpinFrame $UiSpinFrame + 1
    IntOp $3 $UiSpinFrame & 7
    ${If} $3 = 0
      StrCpy $UiBmp $BmpSpin1
    ${ElseIf} $3 = 1
      StrCpy $UiBmp $BmpSpin2
    ${ElseIf} $3 = 2
      StrCpy $UiBmp $BmpSpin3
    ${ElseIf} $3 = 3
      StrCpy $UiBmp $BmpSpin4
    ${ElseIf} $3 = 4
      StrCpy $UiBmp $BmpSpin5
    ${ElseIf} $3 = 5
      StrCpy $UiBmp $BmpSpin6
    ${ElseIf} $3 = 6
      StrCpy $UiBmp $BmpSpin7
    ${Else}
      StrCpy $UiBmp $BmpSpin8
    ${EndIf}
  ${Else}
    SetCtlColors $1 0x737373 0xffffff
    StrCpy $UiBmp $BmpLogTodo
  ${EndIf}
  IntOp $0 3020 + $UiRow
  GetDlgItem $2 $InstDlg $0
  SendMessage $2 ${STM_SETIMAGE} ${IMAGE_BITMAP} $UiBmp
FunctionEnd

Function UiSetStage
  ${If} $UiReady != 1
    Return
  ${EndIf}
  IntOp $0 $UiPct * 406
  IntOp $0 $0 * $UiScalePct
  IntOp $0 $0 / 10000
  GetDlgItem $1 $InstDlg 3004
  ${If} $0 <= 0
    ShowWindow $1 ${SW_HIDE}
  ${Else}
    ShowWindow $1 ${SW_SHOW}
    System::Call "user32::MoveWindow(p r1, i $InstFillX, i $InstFillY, i r0, i $InstFillH, i 1)"
  ${EndIf}
  GetDlgItem $1 $InstDlg 3005
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$UiPct%"
  GetDlgItem $1 $InstDlg 3006
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$UiStatus"

  ${If} $UiStage <= 0
    StrCpy $UiRow 0
    StrCpy $UiRowState 1
    Call UiSetLogRow
    StrCpy $UiRow 1
    StrCpy $UiRowState 0
    Call UiSetLogRow
    StrCpy $UiRow 2
    StrCpy $UiRowState 0
    Call UiSetLogRow
  ${ElseIf} $UiStage == 1
    StrCpy $UiRow 0
    StrCpy $UiRowState 2
    Call UiSetLogRow
    StrCpy $UiRow 1
    StrCpy $UiRowState 1
    Call UiSetLogRow
    StrCpy $UiRow 2
    StrCpy $UiRowState 0
    Call UiSetLogRow
  ${ElseIf} $UiStage == 2
    StrCpy $UiRow 0
    StrCpy $UiRowState 2
    Call UiSetLogRow
    StrCpy $UiRow 1
    StrCpy $UiRowState 2
    Call UiSetLogRow
    StrCpy $UiRow 2
    StrCpy $UiRowState 1
    Call UiSetLogRow
  ${Else}
    StrCpy $UiRow 0
    StrCpy $UiRowState 2
    Call UiSetLogRow
    StrCpy $UiRow 1
    StrCpy $UiRowState 2
    Call UiSetLogRow
    StrCpy $UiRow 2
    StrCpy $UiRowState 2
    Call UiSetLogRow
  ${EndIf}
  System::Call "user32::UpdateWindow(p $InstDlg)"
FunctionEnd

Function UiAnimateTo
  ${If} $UiReady != 1
    Return
  ${EndIf}
  ${If} $UiPct >= $UiTarget
    StrCpy $UiPct $UiTarget
    Call UiSetStage
    Return
  ${EndIf}
  uianim_loop:
    IntOp $UiPct $UiPct + 4
    ${If} $UiPct > $UiTarget
      StrCpy $UiPct $UiTarget
    ${EndIf}
    Call UiSetStage
    Sleep 12
    ${If} $UiPct < $UiTarget
      Goto uianim_loop
    ${EndIf}
FunctionEnd

Function UiOptionsInitTick
  ${NSD_KillTimer} UiOptionsInitTick
  SendMessage $OptionsDirCtl ${WM_SETTEXT} 0 "STR:$INSTDIR"
FunctionEnd

Function UiPageFocusTick
  ${NSD_KillTimer} UiPageFocusTick
  System::Call "user32::SetFocus(p $Dlg)"
FunctionEnd

; ---------------- 资源与窗口初始化 ----------------
Function UiLoadBase
  StrCpy $0 "$PLUGINSDIR\ui\$UiAssetName.bmp"
  ${If} $UiHi = 1
    StrCpy $0 "$PLUGINSDIR\ui\$UiAssetName@2x.bmp"
  ${EndIf}
  System::Call "user32::LoadImage(p 0, t '$0', i 0, i 0, i 0, i 0x10) p .s"
  Pop $UiAssetHwnd
FunctionEnd

Function UiLoadPct
  StrCpy $0 "$PLUGINSDIR\ui\$UiAssetName@$UiScalePct.bmp"
  System::Call "user32::LoadImage(p 0, t '$0', i 0, i 0, i 0, i 0x10) p .s"
  Pop $UiAssetHwnd
FunctionEnd

Function UiFitWindow
  System::Call "user32::GetDpiForWindow(p $HWNDPARENT) i .r0"
  ${If} $0 = 0
    StrCpy $0 96
  ${EndIf}
  StrCpy $UiDpi $0
  ${If} $UiDpi <= 108
    StrCpy $UiScalePct 100
  ${ElseIf} $UiDpi <= 132
    StrCpy $UiScalePct 125
  ${ElseIf} $UiDpi <= 156
    StrCpy $UiScalePct 150
  ${ElseIf} $UiDpi <= 180
    StrCpy $UiScalePct 175
  ${Else}
    StrCpy $UiScalePct 200
  ${EndIf}
  ${If} $UiScalePct >= 125
    StrCpy $UiHi 1
  ${Else}
    StrCpy $UiHi 0
  ${EndIf}

  ; 固定窗口尺寸：去掉最大化与可调边框
  System::Call "user32::GetWindowLong(p $HWNDPARENT, i -16) i .r2"
  IntOp $2 $2 & 0xFFFEFFFF
  IntOp $2 $2 & 0xFFFBFFFF
  System::Call "user32::SetWindowLong(p $HWNDPARENT, i -16, i r2)"

  IntOp $0 680 * $UiDpi
  IntOp $0 $0 / 96
  StrCpy $UiWpx $0
  IntOp $0 448 * $UiDpi
  IntOp $0 $0 / 96
  StrCpy $UiHpx $0

  StrCpy $0 $UiWpx
  StrCpy $1 $UiHpx
  System::Call '*(i 0, i 0, i r0, i r1) p .r5'
  System::Call "user32::GetWindowLong(p $HWNDPARENT, i -16) i .r2"
  System::Call "user32::GetWindowLong(p $HWNDPARENT, i -20) i .r3"
  System::Call "user32::AdjustWindowRectExForDpi(p r5, i r2, i 0, i r3, i $UiDpi)"
  System::Call '*$5(i .r0, i .r1, i .r2, i .r3)'
  IntOp $UiWpx $2 - $0
  IntOp $UiHpx $3 - $1
  System::Free $5

  System::Call '*(i 0, i 0, i 0, i 0) p .r5'
  System::Call "user32::SystemParametersInfo(i 0x30, i 0, p r5, i 0)"
  System::Call '*$5(i .r2, i .r3, i .r4, i .r6)'
  IntOp $4 $4 - $2
  IntOp $6 $6 - $3
  IntOp $4 $4 - $UiWpx
  IntOp $6 $6 - $UiHpx
  IntOp $4 $4 / 2
  IntOp $6 $6 / 2
  IntOp $2 $2 + $4
  IntOp $3 $3 + $6
  System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i r2, i r3, i $UiWpx, i $UiHpx, i 4)"
  System::Free $5
FunctionEnd

Function UiMakeFont
  IntOp $0 $UiFontPx * $UiDpi
  IntOp $0 $0 / 96
  IntOp $0 $0 * -1
  System::Call "gdi32::CreateFontW(i r0, i 0, i 0, i 0, i $UiFontWeight, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w '$UiFace') p .r1"
  StrCpy $UiFontHwnd $1
FunctionEnd

Function UiInitEnv
  Call UiFitWindow
  StrCpy $UiFace "Segoe UI"
  StrCpy $UiFontPx 22
  StrCpy $UiFontWeight 600
  Call UiMakeFont
  StrCpy $FntH2 $UiFontHwnd
  StrCpy $UiFontPx 18
  Call UiMakeFont
  StrCpy $FntTitle $UiFontHwnd
  StrCpy $UiFontPx 14
  StrCpy $UiFontWeight 400
  Call UiMakeFont
  StrCpy $FntBody $UiFontHwnd
  StrCpy $UiFontWeight 600
  Call UiMakeFont
  StrCpy $FntBodyB $UiFontHwnd
  StrCpy $UiFontPx 13
  StrCpy $UiFontWeight 400
  Call UiMakeFont
  StrCpy $FntBody13 $UiFontHwnd
  StrCpy $UiFontWeight 600
  Call UiMakeFont
  StrCpy $FntBody13B $UiFontHwnd
  StrCpy $UiFontPx 12
  StrCpy $UiFontWeight 400
  Call UiMakeFont
  StrCpy $FntSmall $UiFontHwnd

  StrCpy $UiAssetName 'sidebar'
  Call UiLoadBase
  StrCpy $BmpSidebar $UiAssetHwnd
  StrCpy $UiAssetName 'logo'
  Call UiLoadBase
  StrCpy $BmpLogo $UiAssetHwnd
  StrCpy $UiAssetName 'tile1'
  Call UiLoadBase
  StrCpy $BmpTile1 $UiAssetHwnd
  StrCpy $UiAssetName 'tile2'
  Call UiLoadBase
  StrCpy $BmpTile2 $UiAssetHwnd
  StrCpy $UiAssetName 'tile3'
  Call UiLoadBase
  StrCpy $BmpTile3 $UiAssetHwnd
  StrCpy $UiAssetName 'pill'
  Call UiLoadBase
  StrCpy $BmpPill $UiAssetHwnd
  StrCpy $UiAssetName 'dot-active-1'
  Call UiLoadBase
  StrCpy $BmpDotA1 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-active-2'
  Call UiLoadBase
  StrCpy $BmpDotA2 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-active-3'
  Call UiLoadBase
  StrCpy $BmpDotA3 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-active-4'
  Call UiLoadBase
  StrCpy $BmpDotA4 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-todo-1'
  Call UiLoadBase
  StrCpy $BmpDotT1 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-todo-2'
  Call UiLoadBase
  StrCpy $BmpDotT2 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-todo-3'
  Call UiLoadBase
  StrCpy $BmpDotT3 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-todo-4'
  Call UiLoadBase
  StrCpy $BmpDotT4 $UiAssetHwnd
  StrCpy $UiAssetName 'dot-done'
  Call UiLoadBase
  StrCpy $BmpDotDone $UiAssetHwnd
  StrCpy $UiAssetName 'card'
  Call UiLoadBase
  StrCpy $BmpCard $UiAssetHwnd
  StrCpy $UiAssetName 'card-tall'
  Call UiLoadBase
  StrCpy $BmpCardTall $UiAssetHwnd
  StrCpy $UiAssetName 'tip'
  Call UiLoadBase
  StrCpy $BmpTip $UiAssetHwnd
  StrCpy $UiAssetName 'input'
  Call UiLoadBase
  StrCpy $BmpInput $UiAssetHwnd
  StrCpy $UiAssetName 'track'
  Call UiLoadBase
  StrCpy $BmpTrack $UiAssetHwnd
  StrCpy $UiAssetName 'badge-1'
  Call UiLoadBase
  StrCpy $BmpBadge1 $UiAssetHwnd
  StrCpy $UiAssetName 'badge-2'
  Call UiLoadBase
  StrCpy $BmpBadge2 $UiAssetHwnd
  StrCpy $UiAssetName 'badge-3'
  Call UiLoadBase
  StrCpy $BmpBadge3 $UiAssetHwnd
  StrCpy $UiAssetName 'badge-4'
  Call UiLoadBase
  StrCpy $BmpBadge4 $UiAssetHwnd
  StrCpy $UiAssetName 'log-todo'
  Call UiLoadBase
  StrCpy $BmpLogTodo $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-1'
  Call UiLoadBase
  StrCpy $BmpSpin1 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-2'
  Call UiLoadBase
  StrCpy $BmpSpin2 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-3'
  Call UiLoadBase
  StrCpy $BmpSpin3 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-4'
  Call UiLoadBase
  StrCpy $BmpSpin4 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-5'
  Call UiLoadBase
  StrCpy $BmpSpin5 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-6'
  Call UiLoadBase
  StrCpy $BmpSpin6 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-7'
  Call UiLoadBase
  StrCpy $BmpSpin7 $UiAssetHwnd
  StrCpy $UiAssetName 'log-spin-8'
  Call UiLoadBase
  StrCpy $BmpSpin8 $UiAssetHwnd
  StrCpy $UiAssetName 'log-done'
  Call UiLoadBase
  StrCpy $BmpLogDone $UiAssetHwnd
  StrCpy $UiAssetName 'check-off'
  Call UiLoadBase
  StrCpy $BmpCheckOff $UiAssetHwnd
  StrCpy $UiAssetName 'check-on'
  Call UiLoadBase
  StrCpy $BmpCheckOn $UiAssetHwnd
  StrCpy $UiAssetName 'radio-off'
  Call UiLoadBase
  StrCpy $BmpRadioOff $UiAssetHwnd
  StrCpy $UiAssetName 'radio-on'
  Call UiLoadBase
  StrCpy $BmpRadioOn $UiAssetHwnd
  StrCpy $UiAssetName 'focus-ring-check'
  Call UiLoadBase
  StrCpy $BmpRingCheck $UiAssetHwnd
  StrCpy $UiAssetName 'focus-ring-radio'
  Call UiLoadBase
  StrCpy $BmpRingRadio $UiAssetHwnd
  StrCpy $UiAssetName 'btn-next'
  Call UiLoadPct
  StrCpy $BmpBtnNext $UiAssetHwnd
  StrCpy $UiAssetName 'btn-install'
  Call UiLoadPct
  StrCpy $BmpBtnInstall $UiAssetHwnd
  StrCpy $UiAssetName 'btn-finish'
  Call UiLoadPct
  StrCpy $BmpBtnFinish $UiAssetHwnd
  StrCpy $UiAssetName 'btn-back'
  Call UiLoadPct
  StrCpy $BmpBtnBack $UiAssetHwnd
  StrCpy $UiAssetName 'btn-browse'
  Call UiLoadPct
  StrCpy $BmpBtnBrowse $UiAssetHwnd
  StrCpy $UiAssetName 'btn-installing'
  Call UiLoadPct
  StrCpy $BmpBtnInstalling $UiAssetHwnd
  StrCpy $UiAssetName 'fill'
  Call UiLoadPct
  StrCpy $BmpFill $UiAssetHwnd
FunctionEnd

; ---------------- 页面声明 ----------------
Page custom WelcomePageCreate WelcomeLeave

; 已安装维护页（PageReinstall 内部按是否已有安装决定是否 Abort）
Page custom PageReinstall PageLeaveReinstall

Page custom OptionsPageCreate OptionsPageLeave

!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

Page instfiles InstFilesShow

Page custom FinishPageCreate FinishLeave

; ---------------- 欢迎页 ----------------
Function WelcomePageCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  Call WelcomeShow
FunctionEnd

Function WelcomeShow
  StrCpy $UiStep 1
  Call UiBeginPage

  !insertmacro UI_RECT 236 32 408 33
  !insertmacro UI_LABEL 0 "欢迎使用 Mouse Theme" $FntH2 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 236 71 408 21
  !insertmacro UI_LABEL 0 "几步即可完成安装，约需 30 秒。" $FntBody 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  ; 功能列表
  !insertmacro UI_RECT 236 114 32 32
  !insertmacro UI_BITMAP 0 $BmpTile1 ${UI_STYLE_BMP}
  !insertmacro UI_RECT 280 114 364 21
  !insertmacro UI_LABEL 0 "一键切换鼠标主题" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 280 135 364 19
  !insertmacro UI_LABEL 0 "预览、应用、随时还原" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 167 32 32
  !insertmacro UI_BITMAP 0 $BmpTile2 ${UI_STYLE_BMP}
  !insertmacro UI_RECT 280 167 364 21
  !insertmacro UI_LABEL 0 "可靠还原" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 280 188 364 19
  !insertmacro UI_LABEL 0 "改动前自动备份系统光标方案" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 219 32 32
  !insertmacro UI_BITMAP 0 $BmpTile3 ${UI_STYLE_BMP}
  !insertmacro UI_RECT 280 219 364 21
  !insertmacro UI_LABEL 0 "仅当前用户" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 280 240 364 19
  !insertmacro UI_LABEL 0 "无需管理员权限，不改动系统文件" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  ; 页脚主按钮
  StrCpy $UiBtnKind 0
  StrCpy $UiText "下一步"
  StrCpy $UiBtnBmp $BmpBtnNext
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiNext
  ${NSD_CreateTimer} UiPageFocusTick 30

  nsDialogs::Show
FunctionEnd

Function WelcomeLeave
FunctionEnd

; ---------------- 已安装维护页 ----------------
Function PageReinstall
  ; --- 原有 WiX 迁移检测 ---
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; 无已安装项则跳过本页
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  compare_version:
  StrCpy $InstalledVersion ""
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  StrCpy $InstalledVersion $R0
  nsis_tauri_utils::SemverCompare "${VERSION}" $InstalledVersion
  Pop $R0

  ; 默认选项：同版本偏重装；升级/降级默认先卸载
  ${If} $ReinstChoice == ""
    ${If} $R0 = 0
      StrCpy $ReinstChoice 1
    ${ElseIf} $R0 = 1
      StrCpy $ReinstChoice 2
    ${ElseIf} $R0 = -1
      StrCpy $ReinstChoice 2
    ${Else}
      Abort
    ${EndIf}
  ${EndIf}

  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
    Abort
  ${EndIf}

  StrCpy $UiStep 2
  Call UiBeginPage

  !insertmacro UI_RECT 236 32 408 33
  !insertmacro UI_LABEL 0 "已安装" $FntH2 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  ${If} $InstalledVersion != ""
    StrCpy $UiText "检测到版本 $InstalledVersion，请选择要继续的方式。"
  ${Else}
    StrCpy $UiText "检测到已安装版本，请选择要继续的方式。"
  ${EndIf}
  !insertmacro UI_RECT 236 71 408 21
  !insertmacro UI_LABEL 0 "$UiText" $FntBody 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  ; 选项一：重新安装
  !insertmacro UI_RECT 236 114 408 72
  !insertmacro UI_CLICKBITMAP $BmpCardTall
  ${NSD_OnClick} $UiCtl ReinstPick1
  !insertmacro UI_RECT 248 128 20 20
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}|${WS_GROUP}" 0 $UiX $UiY $UiWpx $UiHpx "重新安装"
  Pop $ReinstRadio1
  SendMessage $ReinstRadio1 ${WM_SETFONT} $FntBody13 1
  ${NSD_OnClick} $ReinstRadio1 OnReinstCtrl
  !insertmacro UI_RECT 242 122 32 32
  !insertmacro UI_BITMAP 0 $BmpRingRadio ${UI_STYLE_BMP}
  StrCpy $RingRadio1 $UiCtl
  ShowWindow $RingRadio1 ${SW_HIDE}
  !insertmacro UI_RECT 248 128 20 20
  !insertmacro UI_CLICKBITMAP $BmpRadioOff
  StrCpy $DotRadio1 $UiCtl
  ${NSD_OnClick} $UiCtl ReinstPick1
  !insertmacro UI_RECT 274 127 346 21
  !insertmacro UI_CLICKLABEL "重新安装" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ReinstPick1
  !insertmacro UI_RECT 274 148 346 18
  !insertmacro UI_CLICKLABEL "保留现有数据，重新写入程序文件。" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ReinstPick1

  ; 选项二：卸载后重新安装
  !insertmacro UI_RECT 236 194 408 72
  !insertmacro UI_CLICKBITMAP $BmpCardTall
  ${NSD_OnClick} $UiCtl ReinstPick2
  !insertmacro UI_RECT 248 208 20 20
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}" 0 $UiX $UiY $UiWpx $UiHpx "卸载后重新安装"
  Pop $ReinstRadio2
  SendMessage $ReinstRadio2 ${WM_SETFONT} $FntBody13 1
  ${NSD_OnClick} $ReinstRadio2 OnReinstCtrl
  !insertmacro UI_RECT 242 202 32 32
  !insertmacro UI_BITMAP 0 $BmpRingRadio ${UI_STYLE_BMP}
  StrCpy $RingRadio2 $UiCtl
  ShowWindow $RingRadio2 ${SW_HIDE}
  !insertmacro UI_RECT 248 208 20 20
  !insertmacro UI_CLICKBITMAP $BmpRadioOff
  StrCpy $DotRadio2 $UiCtl
  ${NSD_OnClick} $UiCtl ReinstPick2
  !insertmacro UI_RECT 274 207 346 21
  !insertmacro UI_CLICKLABEL "卸载后重新安装" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ReinstPick2
  !insertmacro UI_RECT 274 228 346 18
  !insertmacro UI_CLICKLABEL "先移除当前版本，再安装所选版本。" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ReinstPick2

  ${If} $ReinstChoice = 2
    SendMessage $ReinstRadio2 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    SendMessage $ReinstRadio1 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  Call UiSyncReinst

  ; 页脚：上一步 + 下一步
  StrCpy $UiBtnKind 0
  StrCpy $UiText "下一步"
  StrCpy $UiBtnBmp $BmpBtnNext
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiNext
  StrCpy $UiBtnKind 1
  StrCpy $UiText "上一步"
  StrCpy $UiBtnBmp $BmpBtnBack
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiBack

  ${NSD_SetFocus} $ReinstRadio1
  ${NSD_CreateTimer} UiFocusTimer 90
  nsDialogs::Show
FunctionEnd

Function ReinstPick1
  Pop $0
  SendMessage $ReinstRadio2 ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SendMessage $ReinstRadio1 ${BM_SETCHECK} ${BST_CHECKED} 0
  Call UiSyncReinst
FunctionEnd

Function ReinstPick2
  Pop $0
  SendMessage $ReinstRadio1 ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SendMessage $ReinstRadio2 ${BM_SETCHECK} ${BST_CHECKED} 0
  Call UiSyncReinst
FunctionEnd

Function PageLeaveReinstall
  ${NSD_KillTimer} UiFocusTimer
  ${If} $PassiveMode <> 1
    SendMessage $ReinstRadio1 ${BM_GETCHECK} 0 0 $R1
    ${If} $R1 = ${BST_CHECKED}
      StrCpy $ReinstChoice 1
    ${Else}
      StrCpy $ReinstChoice 2
    ${EndIf}
  ${EndIf}

  ; 从 WiX 迁移时总是先卸载
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; 更新模式不卸载
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ${If} $ReinstChoice = 2
    Goto reinst_uninstall
  ${EndIf}
  Goto reinst_done

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|}
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|}
      StrCpy $R1 "$R1 _?=$4"
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ${If} $0 = 1
        Abort
      ${EndIf}

      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; ---------------- 安装选项页 ----------------
Function OptionsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  Call OptionsPageShow
FunctionEnd

Function OptionsPageShow
  StrCpy $UiStep 2
  Call UiBeginPage

  !insertmacro UI_RECT 236 32 408 33
  !insertmacro UI_LABEL 0 "安装选项" $FntH2 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 236 71 408 21
  !insertmacro UI_LABEL 0 "使用推荐设置即可，也可自行调整。" $FntBody 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 114 408 20
  !insertmacro UI_LABEL 0 "安装位置" $FntBody13 0x252525 0xffffff ${UI_STYLE_LABEL_MID}

  ; 输入框底图 + 无边框 Edit
  !insertmacro UI_RECT 236 139 330 36
  !insertmacro UI_BITMAP 0 $BmpInput ${UI_STYLE_BMP}
  !insertmacro UI_RECT 238 141 326 32
  nsDialogs::CreateControl "EDIT" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${ES_AUTOHSCROLL}" 0 $UiX $UiY $UiWpx $UiHpx "$INSTDIR"
  Pop $OptionsDirCtl
  SendMessage $OptionsDirCtl ${WM_SETFONT} $FntBody 1
  SetCtlColors $OptionsDirCtl 0x252525 0xffffff
  IntOp $0 8 * $UiDpi
  IntOp $0 $0 / 96
  IntOp $1 $0 << 16
  IntOp $1 $1 | $0
  SendMessage $OptionsDirCtl 0x00D3 0x0003 $1
  System::Call "user32::SetWindowPos(p $OptionsDirCtl, p 0, i 0, i 0, i 0, i 0, i 0x13)"

  !insertmacro UI_RECT 236 181 408 18
  !insertmacro UI_LABEL 0 "需要约 48 MB 可用空间" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  ; 桌面快捷方式卡片
  !insertmacro UI_RECT 236 216 408 61
  !insertmacro UI_CLICKBITMAP $BmpCard
  ${NSD_OnClick} $UiCtl ToggleDesk
  !insertmacro UI_RECT 248 227 20 20
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_AUTOCHECKBOX}" 0 $UiX $UiY $UiWpx $UiHpx "创建桌面快捷方式"
  Pop $OptionsDeskCtl
  SendMessage $OptionsDeskCtl ${WM_SETFONT} $FntBody13 1
  ${NSD_OnClick} $OptionsDeskCtl OnDeskCtrl
  !insertmacro UI_RECT 242 221 32 32
  !insertmacro UI_BITMAP 0 $BmpRingCheck ${UI_STYLE_BMP}
  StrCpy $RingDesk $UiCtl
  ShowWindow $RingDesk ${SW_HIDE}
  !insertmacro UI_RECT 248 227 20 20
  !insertmacro UI_CLICKBITMAP $BmpCheckOff
  StrCpy $DotDesk $UiCtl
  ${NSD_OnClick} $UiCtl ToggleDesk
  !insertmacro UI_RECT 274 226 346 21
  !insertmacro UI_CLICKLABEL "创建桌面快捷方式" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleDesk
  !insertmacro UI_RECT 274 247 346 18
  !insertmacro UI_CLICKLABEL "在桌面放置启动图标" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleDesk

  ; 开机自启卡片
  !insertmacro UI_RECT 236 284 408 61
  !insertmacro UI_CLICKBITMAP $BmpCard
  ${NSD_OnClick} $UiCtl ToggleAuto
  !insertmacro UI_RECT 248 295 20 20
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_AUTOCHECKBOX}" 0 $UiX $UiY $UiWpx $UiHpx "开机自动启动"
  Pop $OptionsAutoCtl
  SendMessage $OptionsAutoCtl ${WM_SETFONT} $FntBody13 1
  ${NSD_OnClick} $OptionsAutoCtl OnAutoCtrl
  !insertmacro UI_RECT 242 289 32 32
  !insertmacro UI_BITMAP 0 $BmpRingCheck ${UI_STYLE_BMP}
  StrCpy $RingAuto $UiCtl
  ShowWindow $RingAuto ${SW_HIDE}
  !insertmacro UI_RECT 248 295 20 20
  !insertmacro UI_CLICKBITMAP $BmpCheckOff
  StrCpy $DotAuto $UiCtl
  ${NSD_OnClick} $UiCtl ToggleAuto
  !insertmacro UI_RECT 274 294 346 21
  !insertmacro UI_CLICKLABEL "开机自动启动" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleAuto
  !insertmacro UI_RECT 274 315 346 18
  !insertmacro UI_CLICKLABEL "登录后在后台守护所选光标" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleAuto

  ${If} $DeskShortcutChecked = 1
    SendMessage $OptionsDeskCtl ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  ${If} $AutoStartChecked = 1
    SendMessage $OptionsAutoCtl ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  Call UiSyncDesk
  Call UiSyncAuto

  ; 浏览按钮
  Call UiMakeBrowseButton
  ${NSD_OnClick} $UiCtl BrowseDir

  ; 页脚：上一步 + 安装
  StrCpy $UiBtnKind 0
  StrCpy $UiText "安装"
  StrCpy $UiBtnBmp $BmpBtnInstall
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiNext
  StrCpy $UiBtnKind 1
  StrCpy $UiText "上一步"
  StrCpy $UiBtnBmp $BmpBtnBack
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiBack

  ${NSD_SetFocus} $OptionsDirCtl
  ${NSD_CreateTimer} UiOptionsInitTick 40
  ${NSD_CreateTimer} UiFocusTimer 90
  nsDialogs::Show
FunctionEnd

Function BrowseDir
  Pop $0
  ${NSD_GetText} $OptionsDirCtl $R0
  nsDialogs::SelectFolderDialog "选择安装位置" "$R0"
  Pop $R0
  ${If} $R0 != error
    SendMessage $OptionsDirCtl ${WM_SETTEXT} 0 "STR:$R0"
  ${EndIf}
FunctionEnd

Function ToggleDesk
  Pop $0
  SendMessage $OptionsDeskCtl ${BM_CLICK} 0 0
  Call UiSyncDesk
FunctionEnd

Function ToggleAuto
  Pop $0
  SendMessage $OptionsAutoCtl ${BM_CLICK} 0 0
  Call UiSyncAuto
FunctionEnd

Function OptionsPageLeave
  ${NSD_KillTimer} UiFocusTimer
  ${NSD_GetText} $OptionsDirCtl $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
  SendMessage $OptionsDeskCtl ${BM_GETCHECK} 0 0 $R0
  StrCpy $DeskShortcutChecked $R0
  SendMessage $OptionsAutoCtl ${BM_GETCHECK} 0 0 $R0
  StrCpy $AutoStartChecked $R0
FunctionEnd

; ---------------- 安装进度页 ----------------
Function UiFindInstPage
  System::Call "user32::GetWindow(p $HWNDPARENT, i 5) p .r0"
  uifind_loop:
    ${If} $0 == 0
      StrCpy $InstDlg 0
      Return
    ${EndIf}
    GetDlgItem $1 $0 1004
    ${If} $1 != 0
      StrCpy $InstDlg $0
      Return
    ${EndIf}
    System::Call "user32::GetWindow(p r0, i 2) p .r1"
    StrCpy $0 $1
    Goto uifind_loop
FunctionEnd

Function UiBuildInstallPage
  ${If} ${Silent}
    Return
  ${EndIf}
  Call UiFindInstPage
  ${If} $InstDlg == 0
    Return
  ${EndIf}
  Push $InstDlg
  Call UiFitDlg
  SetCtlColors $InstDlg 0 0xffffff
  GetDlgItem $0 $InstDlg 1004
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $InstDlg 1006
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $InstDlg 1016
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $InstDlg 1027
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $InstDlg 1031
  ShowWindow $0 ${SW_HIDE}

  StrCpy $UiParent $InstDlg
  StrCpy $UiStep 3
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Mouse Theme 安装向导"

  !insertmacro UI_RECT 0 0 680 448
  !insertmacro UI_LABEL 0 "" $FntSmall 0 0xffffff ${UI_STYLE_LABEL}
  Call UiDrawChrome
  ; InstFiles 页不认 SetCtlColors 的首次绘制，控件建完后整树重绘一次才生效
  System::Call "user32::RedrawWindow(p $InstDlg, p 0, p 0, i 0x0185)"

  !insertmacro UI_RECT 236 32 408 33
  !insertmacro UI_LABEL 0 "正在安装" $FntH2 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 236 71 408 21
  !insertmacro UI_LABEL 0 "请稍候，无需任何操作。" $FntBody 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 114 408 8
  !insertmacro UI_BITMAP 3003 $BmpTrack ${UI_STYLE_BMP}
  !insertmacro UI_RECT 237 115 406 6
  !insertmacro UI_BITMAP 3004 $BmpFill ${UI_STYLE_BMP}
  StrCpy $InstFillX $UiX
  StrCpy $InstFillY $UiY
  StrCpy $InstFillH $UiHpx
  GetDlgItem $0 $InstDlg 3004
  ShowWindow $0 ${SW_HIDE}

  !insertmacro UI_RECT 236 134 300 20
  !insertmacro UI_LABEL 3006 "准备中…" $FntBody13 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 544 134 100 20
  !insertmacro UI_LABEL 3005 "0%" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_RIGHT}

  !insertmacro UI_RECT 236 174 14 14
  !insertmacro UI_BITMAP 3020 $BmpLogTodo ${UI_STYLE_BMP}
  !insertmacro UI_RECT 258 171 386 20
  !insertmacro UI_LABEL 3010 "复制程序文件" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 202 14 14
  !insertmacro UI_BITMAP 3021 $BmpLogTodo ${UI_STYLE_BMP}
  !insertmacro UI_RECT 258 199 386 20
  !insertmacro UI_LABEL 3011 "写入用户设置" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 230 14 14
  !insertmacro UI_BITMAP 3022 $BmpLogTodo ${UI_STYLE_BMP}
  !insertmacro UI_RECT 258 227 386 20
  !insertmacro UI_LABEL 3012 "创建快捷方式" $FntBody13 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  !insertmacro UI_RECT 236 384 400 64
  !insertmacro UI_LABEL 0 "安装过程中请勿关闭窗口" $FntBody13 0x737373 0xfafafa ${UI_STYLE_LABEL_MID}

  ; 原型进度页的禁用“安装中…”按钮（纯视觉，不可点）
  IntOp $0 96 * $UiScalePct
  IntOp $0 $0 / 100
  IntOp $1 36 * $UiScalePct
  IntOp $1 $1 / 100
  IntOp $2 644 * $UiDpi
  IntOp $2 $2 / 96
  IntOp $2 $2 - $0
  IntOp $3 398 * $UiDpi
  IntOp $3 $3 / 96
  StrCpy $UiX $2
  StrCpy $UiY $3
  StrCpy $UiWpx $0
  StrCpy $UiHpx $1
  !insertmacro UI_BITMAP 0 $BmpBtnInstalling ${UI_STYLE_BMP}

  StrCpy $UiSpinFrame 0
  StrCpy $UiReady 1
  StrCpy $UiPct 0
  StrCpy $UiStage 0
  StrCpy $UiStatus "准备中…"
  Call UiSetStage
FunctionEnd

Function InstFilesShow
  Call UiHideStock
  LockWindow on
FunctionEnd

; ---------------- 完成页 ----------------
Function FinishPageCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  Call FinishShow
FunctionEnd

Function FinishShow
  StrCpy $UiStep 4
  Call UiBeginPage

  !insertmacro UI_RECT 236 32 56 56
  !insertmacro UI_BITMAP 0 $BmpBadge1 ${UI_STYLE_BMP}
  StrCpy $BadgeCtl $UiCtl
  StrCpy $UiBadgeFrame 1

  !insertmacro UI_RECT 236 104 408 33
  !insertmacro UI_LABEL 0 "安装完成" $FntH2 0x252525 0xffffff ${UI_STYLE_LABEL_MID}
  !insertmacro UI_RECT 236 143 408 21
  !insertmacro UI_LABEL 0 "Mouse Theme 已准备就绪。" $FntBody 0x737373 0xffffff ${UI_STYLE_LABEL_MID}

  ; 立即启动卡片
  !insertmacro UI_RECT 236 186 408 61
  !insertmacro UI_CLICKBITMAP $BmpCard
  ${NSD_OnClick} $UiCtl ToggleRun
  !insertmacro UI_RECT 248 197 20 20
  nsDialogs::CreateControl "BUTTON" "${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_AUTOCHECKBOX}" 0 $UiX $UiY $UiWpx $UiHpx "立即启动 Mouse Theme"
  Pop $FinishRunCtl
  SendMessage $FinishRunCtl ${WM_SETFONT} $FntBody13 1
  SendMessage $FinishRunCtl ${BM_SETCHECK} ${BST_CHECKED} 0
  ${NSD_OnClick} $FinishRunCtl OnRunCtrl
  !insertmacro UI_RECT 242 191 32 32
  !insertmacro UI_BITMAP 0 $BmpRingCheck ${UI_STYLE_BMP}
  StrCpy $RingRun $UiCtl
  ShowWindow $RingRun ${SW_HIDE}
  !insertmacro UI_RECT 248 197 20 20
  !insertmacro UI_CLICKBITMAP $BmpCheckOff
  StrCpy $DotRun $UiCtl
  ${NSD_OnClick} $UiCtl ToggleRun
  !insertmacro UI_RECT 274 196 346 21
  !insertmacro UI_CLICKLABEL "立即启动 Mouse Theme" $FntBodyB 0x252525 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleRun
  !insertmacro UI_RECT 274 217 346 18
  !insertmacro UI_CLICKLABEL "点击“完成”后打开应用" $FntSmall 0x737373 0xffffff ${UI_STYLE_LABEL_MID_NOTIFY}
  ${NSD_OnClick} $UiCtl ToggleRun
  Call UiSyncRun

  ; 提示
  !insertmacro UI_RECT 236 275 408 46
  !insertmacro UI_BITMAP 0 $BmpTip ${UI_STYLE_BMP}
  !insertmacro UI_RECT 250 275 380 46
  !insertmacro UI_LABEL 0 "提示：应用内可随时还原为系统默认光标。" $FntBody13 0x737373 0xf5f5f5 ${UI_STYLE_LABEL_MID}

  ; 页脚：完成
  StrCpy $UiBtnKind 0
  StrCpy $UiText "完成"
  StrCpy $UiBtnBmp $BmpBtnFinish
  Call UiMakeFooterButton
  ${NSD_OnClick} $UiCtl UiNext
  ${NSD_CreateTimer} UiPageFocusTick 30
  ${NSD_CreateTimer} UiFocusTimer 90
  ${NSD_CreateTimer} UiBadgeTick 70

  nsDialogs::Show
FunctionEnd

Function ToggleRun
  Pop $0
  SendMessage $FinishRunCtl ${BM_CLICK} 0 0
  Call UiSyncRun
FunctionEnd

Function FinishLeave
  ${NSD_KillTimer} UiFocusTimer
  ${NSD_KillTimer} UiBadgeTick
  SendMessage $FinishRunCtl ${BM_GETCHECK} 0 0 $0
  ${If} $0 = ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd

; ---------------- 页脚导航 ----------------
Function UiNext
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $0 != 0
    System::Call "user32::PostMessage(p r0, i 0x00F5, i 0, i 0)"
  ${Else}
    System::Call "user32::PostMessage(p $HWNDPARENT, i 0x0111, i 1, i 0)"
  ${EndIf}
FunctionEnd

Function UiBack
  Pop $0
  GetDlgItem $0 $HWNDPARENT 3
  ${If} $0 != 0
    SendMessage $0 ${BM_CLICK} 0 0
  ${Else}
    SendMessage $HWNDPARENT ${WM_COMMAND} 3 0
  ${EndIf}
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ; 安装选项页默认值（静默/被动安装跳过该页时生效）
  StrCpy $DeskShortcutChecked 1
  StrCpy $AutoStartChecked 0

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Function UiGuiInit
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\ui"
  SetOutPath "$PLUGINSDIR\ui"
  File /r "..\..\..\..\installer\ui\*.*"
  Call UiInitEnv
FunctionEnd

Section UiBuild
  ${IfNot} ${Silent}
    Call UiBuildInstallPage
    LockWindow off
  ${EndIf}
SectionEnd

Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ${If} $UiReady = 1
    StrCpy $UiStage 0
    StrCpy $UiStatus "检查系统组件…"
    StrCpy $UiTarget 6
    Call UiAnimateTo
  ${EndIf}
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ${If} $UiReady = 1
    StrCpy $UiStage 0
    StrCpy $UiStatus "复制程序文件…"
    StrCpy $UiTarget 12
    Call UiAnimateTo
  ${EndIf}

  ; Copy main executable
  DetailPrint "复制程序文件…"
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ${If} $UiReady = 1
    StrCpy $UiStage 1
    StrCpy $UiStatus "写入用户设置…"
    StrCpy $UiTarget 45
    Call UiAnimateTo
  ${EndIf}

  ; Create uninstaller
  DetailPrint "写入用户设置…"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ${If} $UiReady = 1
    StrCpy $UiStage 2
    StrCpy $UiStatus "创建快捷方式…"
    StrCpy $UiTarget 75
    Call UiAnimateTo
  ${EndIf}

  ; Create start menu shortcut
  DetailPrint "创建快捷方式…"
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because the options page will be skipped; interactive installs use its checkbox
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $DeskShortcutChecked = 1
    ${IfNot} $NoShortcutMode = 1
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
  ${EndIf}

  ; 开机自启（与「设置 → 通用」同一真相：HKCU\...\Run\CursorStudio，值带引号防路径含空格被截断）
  ${If} $AutoStartChecked = 1
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CursorStudio" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ${If} $UiReady = 1
    StrCpy $UiStage 3
    StrCpy $UiStatus "安装完成"
    StrCpy $UiTarget 100
    Call UiAnimateTo
    Sleep 350
  ${EndIf}
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CursorStudio"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
