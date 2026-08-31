!define OPENGROVE_FIREWALL_REGISTRY_KEY "Software\OpenGrove\Installer"
!define OPENGROVE_FIREWALL_PROGRAM_VALUE "LoopbackFirewallProgram"
!define OPENGROVE_FIREWALL_RULE_VALUE "LoopbackFirewallRule"
!define OPENGROVE_FIREWALL_RULE_PREFIX "OpenGrove loopback TCP - "
!define OPENGROVE_FIREWALL_MARKER "opengrove-windows-firewall.ok"
!define OPENGROVE_INSTALLER_GATE_LOG "opengrove-installer-gate.log"

; electron-builder includes this file before its addLangs macro defines the
; symbolic language IDs. customHeader runs immediately after addLangs, so the
; localized strings must be declared here rather than at include time.
!define OPENGROVE_STOPPING_PROCESSES_EN "Stopping OpenGrove and its background processes..."
!define OPENGROVE_CLOSE_FAILED_EN "OpenGrove background processes could not be stopped automatically. Installation was safely cancelled. Please report this error to OpenGrove Support."
!define OPENGROVE_FIREWALL_INSTALL_FAILED_EN "OpenGrove needs administrator permission to allow local-only communication. The firewall rule was not created, so installation cannot continue."
!define OPENGROVE_FIREWALL_UNINSTALL_FAILED_EN "The OpenGrove local communication firewall rule could not be removed. Complete the administrator authorization and try uninstalling again."

!macro opengrove_english_lang_strings _LANGUAGE_ID
  LangString opengroveStoppingProcesses ${_LANGUAGE_ID} "${OPENGROVE_STOPPING_PROCESSES_EN}"
  LangString opengroveCloseFailed ${_LANGUAGE_ID} "${OPENGROVE_CLOSE_FAILED_EN}"
  LangString opengroveFirewallInstallFailed ${_LANGUAGE_ID} "${OPENGROVE_FIREWALL_INSTALL_FAILED_EN}"
  LangString opengroveFirewallUninstallFailed ${_LANGUAGE_ID} "${OPENGROVE_FIREWALL_UNINSTALL_FAILED_EN}"
!macroend

!macro customHeader
  ; Keep electron-builder's complete bundled installer language set. Custom
  ; OpenGrove messages use English for every locale without a translation.
  !insertmacro opengrove_english_lang_strings 1033
  !insertmacro opengrove_english_lang_strings 1031
  !insertmacro opengrove_english_lang_strings 1036
  !insertmacro opengrove_english_lang_strings 3082
  !insertmacro opengrove_english_lang_strings 1028
  !insertmacro opengrove_english_lang_strings 1041
  !insertmacro opengrove_english_lang_strings 1042
  !insertmacro opengrove_english_lang_strings 1040
  !insertmacro opengrove_english_lang_strings 1043
  !insertmacro opengrove_english_lang_strings 1030
  !insertmacro opengrove_english_lang_strings 1053
  !insertmacro opengrove_english_lang_strings 1044
  !insertmacro opengrove_english_lang_strings 1035
  !insertmacro opengrove_english_lang_strings 1049
  !insertmacro opengrove_english_lang_strings 2070
  !insertmacro opengrove_english_lang_strings 1046
  !insertmacro opengrove_english_lang_strings 1045
  !insertmacro opengrove_english_lang_strings 1058
  !insertmacro opengrove_english_lang_strings 1029
  !insertmacro opengrove_english_lang_strings 1051
  !insertmacro opengrove_english_lang_strings 1038
  !insertmacro opengrove_english_lang_strings 1025
  !insertmacro opengrove_english_lang_strings 1055
  !insertmacro opengrove_english_lang_strings 1054
  !insertmacro opengrove_english_lang_strings 1066

  LangString opengroveStoppingProcesses 2052 "正在停止 OpenGrove 及其后台进程..."
  LangString opengroveCloseFailed 2052 "OpenGrove 后台进程未能自动停止。安装已安全取消，请将此错误反馈给 OpenGrove 支持。"
  LangString opengroveFirewallInstallFailed 2052 "OpenGrove 需要管理员授权来允许仅限本机的通信。未创建防火墙规则，安装无法继续。"
  LangString opengroveFirewallUninstallFailed 2052 "无法删除 OpenGrove 的本机通信防火墙规则。请完成管理员授权后重试卸载。"
!macroend

!macro opengrove_gate_log _MESSAGE
  ReadEnvStr $R6 "OPENGROVE_DESKTOP_RELEASE_GATE"
  ${If} $R6 == "1"
    ReadEnvStr $R6 "OPENGROVE_DESKTOP_RELEASE_GATE_LOG"
    ${If} $R6 == ""
      StrCpy $R6 "$TEMP\${OPENGROVE_INSTALLER_GATE_LOG}"
    ${EndIf}
    FileOpen $R5 "$R6" a
    FileWrite $R5 "${_MESSAGE}$\r$\n"
    FileClose $R5
  ${EndIf}
!macroend

; Public legacy clients launch assisted NSIS candidates with --updated but
; without /S. The Host has already obtained explicit user confirmation, and
; leaving the assisted install-mode page visible after the Host exits stalls
; both real updates and unattended verification. Normalize only the standard
; updater path to silent mode; ordinary manually launched installs stay
; interactive and keep their directory/install-mode choices.
!macro customInit
  ${If} ${isUpdated}
    SetSilent silent
  ${EndIf}
!macroend

; electron-builder's generic close-app fallback can confuse sibling process
; names and delegates a headless Bridge to the user when termination crosses
; an elevation boundary. OpenGrove owns several processes with the exact same
; executable name, so close and verify the complete current-user tree here.
!macro opengrove_find_running_process _RESULT
  nsExec::Exec `"$CmdPath" /D /S /C ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\"""`
  Pop ${_RESULT}
!macroend

!macro customCheckAppRunning
  ReadEnvStr $R8 "USERNAME"
  ReadEnvStr $R7 "USERDOMAIN"
  ${If} $R7 != ""
    StrCpy $R8 "$R7\$R8"
  ${EndIf}
  !insertmacro opengrove_gate_log "check:start user=$R8"
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $R9 $0

  !insertmacro opengrove_find_running_process $R0
  !insertmacro opengrove_gate_log "check:initial result=$R0"
  ${If} $R0 != 0
    Goto opengrove_close_done
  ${EndIf}

  DetailPrint "$(opengroveStoppingProcesses)"

  ; First give the desktop app enough time to run its before-quit handler,
  ; flush local state, and stop the owned Bridge.
  ; Do not use taskkill /T here. electron-updater starts this installer as a
  ; child of OpenGrove.exe, so tree termination would kill the installer that
  ; is performing the cleanup. Every owned Electron/Bridge process has the
  ; exact OpenGrove.exe image name and is closed independently by /IM.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R9"`
  Pop $R0
  Sleep 3500
  !insertmacro opengrove_find_running_process $R0
  !insertmacro opengrove_gate_log "check:graceful result=$R0"
  ${If} $R0 != 0
    Goto opengrove_close_done
  ${EndIf}

  ; A headless or stuck Bridge has no window to close. Terminate every matching
  ; process at the current integrity level, then verify instead of assuming.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R9"`
  Pop $R0
  Sleep 750
  !insertmacro opengrove_find_running_process $R0
  !insertmacro opengrove_gate_log "check:forced result=$R0"
  ${If} $R0 != 0
    Goto opengrove_close_done
  ${EndIf}

  ; If the old process is elevated, request the authority needed for the same
  ; exact cleanup. Silent updater installs cannot answer UAC or message boxes,
  ; so they must fail closed instead of waiting forever on a hidden desktop.
  ${If} ${Silent}
    !insertmacro opengrove_gate_log "check:silent-fail"
    Goto opengrove_close_failed
  ${EndIf}
  !insertmacro opengrove_gate_log "check:elevating"
  ClearErrors
  ExecShellWait "runas" "$SYSDIR\taskkill.exe" `/F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R9" /FI "USERNAME eq $R8"` SW_HIDE $R0
  IfErrors opengrove_close_failed
  Sleep 750
  !insertmacro opengrove_find_running_process $R0
  ${If} $R0 == 0
    Goto opengrove_close_failed
  ${EndIf}

  Goto opengrove_close_done

  opengrove_close_failed:
    !insertmacro opengrove_gate_log "check:failed"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "$(opengroveCloseFailed)"
    ${EndIf}
    Abort

  opengrove_close_done:
    !insertmacro opengrove_gate_log "check:done"
!macroend

!macro customInstall
  StrCpy $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrCpy $R1 "${OPENGROVE_FIREWALL_RULE_PREFIX}$INSTDIR"
  ReadRegStr $R2 SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_PROGRAM_VALUE}"
  ReadRegStr $R3 SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_RULE_VALUE}"
  !insertmacro opengrove_gate_log "install:start target=$R0 previous=$R2"

  ${If} $R2 != $R0
    Delete "$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}"
    System::Call 'shell32::IsUserAnAdmin() i .r4'
    ${If} $4 == 1
      ; Hosted release runners and enterprise deployment tools can already be
      ; elevated. Starting another `runas` process in a headless session waits
      ; forever for a UAC desktop that does not exist, so use the current token.
      nsExec::Exec `"$SYSDIR\cmd.exe" /D /S /C ""$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R3" program="$R2" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R1" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OpenGrove (allow inbound loopback)" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall add rule name="$R1" description="OpenGrove local bridge only" dir=in action=allow program="$R0" enable=yes profile=any protocol=TCP localip=127.0.0.1 remoteip=127.0.0.1 edge=no >NUL 2>&1 && echo ok>"$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}""`
      Pop $4
    ${Else}
      ; Interactive installs still request exactly the authority they need.
      ; An unattended install must be launched elevated instead of opening a
      ; hidden UAC prompt and hanging its deployment indefinitely.
      ${If} ${Silent}
        Goto opengrove_firewall_install_failed
      ${EndIf}
      ClearErrors
      ExecShellWait "runas" "$SYSDIR\cmd.exe" `/D /S /C ""$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R3" program="$R2" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R1" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OpenGrove (allow inbound loopback)" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall add rule name="$R1" description="OpenGrove local bridge only" dir=in action=allow program="$R0" enable=yes profile=any protocol=TCP localip=127.0.0.1 remoteip=127.0.0.1 edge=no >NUL 2>&1 && echo ok>"$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}""` SW_HIDE
      IfErrors opengrove_firewall_install_failed
    ${EndIf}
    IfFileExists "$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}" opengrove_firewall_install_done opengrove_firewall_install_failed

    opengrove_firewall_install_failed:
      !insertmacro opengrove_gate_log "install:firewall-failed"
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP|MB_OK "$(opengroveFirewallInstallFailed)"
      ${EndIf}
      Abort

    opengrove_firewall_install_done:
      !insertmacro opengrove_gate_log "install:firewall-done"
      WriteRegStr SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_PROGRAM_VALUE}" "$R0"
      WriteRegStr SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_RULE_VALUE}" "$R1"
  ${EndIf}
  !insertmacro opengrove_gate_log "install:done"
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_PROGRAM_VALUE}"
    ReadRegStr $R1 SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_RULE_VALUE}"
    ${If} $R0 == ""
      StrCpy $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
    ${If} $R1 == ""
      StrCpy $R1 "${OPENGROVE_FIREWALL_RULE_PREFIX}$INSTDIR"
    ${EndIf}

    Delete "$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}"
    System::Call 'shell32::IsUserAnAdmin() i .r4'
    ${If} $4 == 1
      nsExec::Exec `"$SYSDIR\cmd.exe" /D /S /C ""$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R1" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OpenGrove (allow inbound loopback)" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall show rule name="$R1" >NUL 2>&1 || echo ok>"$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}""`
      Pop $4
    ${Else}
      ${If} ${Silent}
        Goto opengrove_firewall_uninstall_failed
      ${EndIf}
      ClearErrors
      ExecShellWait "runas" "$SYSDIR\cmd.exe" `/D /S /C ""$SYSDIR\netsh.exe" advfirewall firewall delete rule name="$R1" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OpenGrove (allow inbound loopback)" program="$R0" >NUL 2>&1 & "$SYSDIR\netsh.exe" advfirewall firewall show rule name="$R1" >NUL 2>&1 || echo ok>"$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}""` SW_HIDE
      IfErrors opengrove_firewall_uninstall_failed
    ${EndIf}
    IfFileExists "$PLUGINSDIR\${OPENGROVE_FIREWALL_MARKER}" opengrove_firewall_uninstall_done opengrove_firewall_uninstall_failed

    opengrove_firewall_uninstall_failed:
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP|MB_OK "$(opengroveFirewallUninstallFailed)"
      ${EndIf}
      Abort

    opengrove_firewall_uninstall_done:
      DeleteRegValue SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_PROGRAM_VALUE}"
      DeleteRegValue SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}" "${OPENGROVE_FIREWALL_RULE_VALUE}"
      DeleteRegKey /ifempty SHELL_CONTEXT "${OPENGROVE_FIREWALL_REGISTRY_KEY}"
  ${EndIf}
!macroend
