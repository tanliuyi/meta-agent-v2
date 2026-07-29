!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef BUILD_UNINSTALLER

Var RuntimeComponents
Var RuntimeShellCheckbox

!macro customInit
  StrCpy $RuntimeComponents ""
  ${GetParameters} $0
  ${GetOptions} $0 "/RUNTIMES=" $1
  ${IfNot} ${Errors}
    StrCpy $RuntimeComponents $1
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom RuntimePageCreate RuntimePageLeave

Function RuntimePageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $installMode == "all"
    StrCpy $RuntimeComponents ""
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "选择 Meta Agent 使用的 Git Bash。已有兼容环境时可以取消选择，之后仍可在应用内安装。"
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 14u "下载 Git Bash / PortableGit 2.53.0.3（约 56 MB）"
  Pop $RuntimeShellCheckbox
  ${NSD_Check} $RuntimeShellCheckbox
  StrCpy $0 ""
  IfFileExists "$PROGRAMFILES64\Git\bin\bash.exe" shell_found
  IfFileExists "$PROGRAMFILES32\Git\bin\bash.exe" shell_found
  IfFileExists "$LOCALAPPDATA\Programs\Git\bin\bash.exe" shell_found shell_detection_done

  shell_found:
  ${NSD_Uncheck} $RuntimeShellCheckbox

  shell_detection_done:
  ${NSD_CreateLabel} 0 60u 100% 30u "Git Bash 安装在当前用户目录，不修改系统 PATH，也不注册为系统 Git。下载文件会进行 SHA-256 校验。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function RuntimePageLeave
  StrCpy $RuntimeComponents ""
  ${NSD_GetState} $RuntimeShellCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RuntimeComponents "shell"
  ${EndIf}
FunctionEnd
!macroend

!macro customInstall
  ${If} $installMode == "all"
    StrCpy $RuntimeComponents ""
    DetailPrint "所有用户安装跳过用户级运行环境；每位用户可在首次启动时安装。"
  ${EndIf}
  ${If} $RuntimeComponents != ""
    runtime_setup_retry:
    DetailPrint "正在准备 Meta Agent 运行环境: $RuntimeComponents"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --runtime-setup=$RuntimeComponents' $0
    ${If} $0 != 0
      MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "运行环境下载或安装失败。可以重试，或跳过并稍后在 Meta Agent 中安装。日志位于 $APPDATA\Meta Agent\runtime-setup.log。" /SD IDIGNORE IDRETRY runtime_setup_retry IDIGNORE runtime_setup_ignore
      runtime_setup_ignore:
    ${EndIf}
  ${EndIf}
!macroend

!endif
