; BlueBird 安装器定制:便携数据(data/)保全策略
;
; 背景:升级重装时,electron-builder 会先静默执行旧版卸载器,其内部
; RMDir /r $INSTDIR 会连 portable data/ 一起清掉(/KEEP_APP_DATA 仅
; 保护 %APPDATA%,不保护安装目录内的数据)。因此:
;   - 升级重装:安装器初始化时先结束运行中的 BlueBird/sing-box 进程
;     (释放 data/ 内被占用的句柄——模板要到安装段才关应用,而暂存
;     改名在 .onInit 就必须完成),把旧目录 data/ 暂存到同级位置,
;     新文件装完后还原到 $INSTDIR\data(跨盘重装走复制中转)
;   - 杀进程后改名仍失败:弹窗提示并中止安装,绝不落入"放弃保全→
;     旧卸载器删数据"的默认路径(.onUserAbort 被 MUI 占用,向导取消
;     无法挂钩;取消遗留的暂存由应用启动时收回,或下次安装自动沿用)
;   - 正式卸载:不做任何保全,data/ 随安装目录一并删除(模板默认行为)
;
; 本脚本只属于安装器主编译趟;卸载器独立编译趟(BUILD_UNINSTALLER)不需要
; 这些逻辑(卸载即随模板默认行为删除 data/),跳过以避免未引用变量等告警。
; LogicLib 需自行引入(注入位置早于 common.nsh;带守卫,重复包含安全)。
!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"

Var /GLOBAL bbDataOldDir   ; 检测到的旧安装目录
Var /GLOBAL bbDataStash    ; data/ 暂存位置(旧安装目录同级)

; 结束运行中的 BlueBird 与 sing-box。优先通过二次实例信号让运行实例优雅退出:
; 拉起 "<旧目录>BlueBird.exe --bb-shutdown"——该进程拿不到单实例锁随即退出,
; 但信号已送达运行中的实例,后者还原系统代理、停止核心后自行退出(见主进程
; second-instance 处理)。轮询等待最多 6 秒;旧版本实例不识别信号或超时未退,
; 才回退温和/强制 taskkill(强杀会留下已开启的系统代理,由应用下次启动自愈)。
; 必须先探测确有运行实例,否则信号进程会凭空把应用启动起来。
Function bbCloseRunningApp
  ${If} $bbDataOldDir != ""
  ${AndIf} ${FileExists} "$bbDataOldDir\BlueBird.exe"
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq BlueBird.exe" /FO csv | "$SYSDIR\find.exe" "BlueBird.exe"`
    Pop $R0
    ${If} $R0 == 0
      nsExec::Exec `"$bbDataOldDir\BlueBird.exe" --bb-shutdown`
      StrCpy $R1 0
      bbGracefulWait:
      Sleep 500
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq BlueBird.exe" /FO csv | "$SYSDIR\find.exe" "BlueBird.exe"`
      Pop $R0
      ${If} $R0 != 0
        Return
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 < 12
        Goto bbGracefulWait
      ${EndIf}
    ${EndIf}
  ${EndIf}
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "BlueBird.exe"`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "sing-box.exe"`
  Sleep 300
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "BlueBird.exe"`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "sing-box.exe"`
FunctionEnd

; 杀进程后带重试地暂存改名;反复失败则请用户退出应用后重试,取消即中止
; 安装(中止时旧目录原封不动,无任何数据风险;静默安装下默认取消)。
Function bbStashData
  bbStashRetryAll:
  Call bbCloseRunningApp
  StrCpy $R0 0
  bbStashRetry:
  ClearErrors
  Rename "$bbDataOldDir\data" "$bbDataStash"
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  IntOp $R0 $R0 + 1
  ${If} $R0 < 5
    Sleep 500
    Goto bbStashRetry
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP|MB_TOPMOST "无法保全旧版用户数据:data 目录仍被占用(BlueBird 可能尚未完全退出)。$\r$\n请完全退出 BlueBird(托盘图标右键 -> 退出 BlueBird)后选择「重试」。$\r$\n选择「取消」将中止安装,不会改动任何现有数据。" /SD IDCANCEL IDRETRY bbStashRetryAll
  Abort
FunctionEnd

; 候选旧目录有效性校验:目录存在且确有旧安装痕迹(data/ 或主程序或卸载器),
; 否则清空视为无旧安装。无效返回 ""。
Function bbValidateOldDir
  ${If} $bbDataOldDir != ""
  ${AndIf} ${FileExists} "$bbDataOldDir"
    ${If} ${FileExists} "$bbDataOldDir\data"
    ${OrIf} ${FileExists} "$bbDataOldDir\BlueBird.exe"
    ${OrIf} ${FileExists} "$bbDataOldDir\Uninstall BlueBird.exe"
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $bbDataOldDir ""
FunctionEnd

!macro customInit
  ; 注意:宏体在 .onInit 早期展开,只能用 NSIS 核心指令与插件调用(不能依赖
  ; installUtil 的辅助宏,彼时尚未引入)。
  ;
  ; 旧安装目录按三级候选定位,各级均经 bbValidateOldDir 校验:
  ;   1. 注册表 InstallLocation(INSTALL_REGISTRY_KEY 即 Software\{GUID},
  ;      initMultiUser 每次安装都会写入;实测可能残留过期或损坏的路径)
  ;   2. 本次安装目录 $INSTDIR(initMultiUser 已解析;同目录升级时即旧目录)
  ;   3. 默认安装目录 %LOCALAPPDATA%\Programs\BlueBird(兜底)
  StrCpy $bbDataStash ""
  StrCpy $bbDataOldDir ""
  ReadRegStr $bbDataOldDir SHCTX "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $bbDataOldDir == ""
    ReadRegStr $bbDataOldDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  Call bbValidateOldDir
  ${If} $bbDataOldDir == ""
    StrCpy $bbDataOldDir "$INSTDIR"
    Call bbValidateOldDir
  ${EndIf}
  ${If} $bbDataOldDir == ""
    StrCpy $bbDataOldDir "$LOCALAPPDATA\Programs\BlueBird"
    Call bbValidateOldDir
  ${EndIf}

  ${If} $bbDataOldDir != ""
    StrCpy $bbDataStash "$bbDataOldDir\..\BlueBirdDataUpgrade"
    ${If} ${FileExists} "$bbDataOldDir\data"
      ${If} ${FileExists} "$bbDataStash"
        ; 上次异常中断遗留的过期暂存:以现存 data/ 为准,清掉暂存
        RMDir /r "$bbDataStash"
      ${EndIf}
      Call bbStashData
    ${ElseIf} ${FileExists} "$bbDataStash"
      ; 上次在向导中取消安装:数据已在暂存里,直接沿用,本次装完一并还原;
      ; 旧进程同样要结束,否则旧卸载器删目录会因 exe 被占用而残留混乱
      Call bbCloseRunningApp
    ${Else}
      StrCpy $bbDataStash ""
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall

  ${If} $bbDataStash != ""
  ${AndIf} ${FileExists} "$bbDataStash"
    ${If} ${FileExists} "$INSTDIR\data"
      RMDir /r "$INSTDIR\data"
    ${EndIf}
    ClearErrors
    Rename "$bbDataStash" "$INSTDIR\data"
    ${If} ${Errors}
      ; 新旧安装目录不在同一盘:同卷复制中转
      ClearErrors
      CreateDirectory "$INSTDIR\bb-data-tmp"
      CopyFiles /SILENT "$bbDataStash" "$INSTDIR\bb-data-tmp"
      ${If} ${FileExists} "$INSTDIR\bb-data-tmp\BlueBirdDataUpgrade"
        Rename "$INSTDIR\bb-data-tmp\BlueBirdDataUpgrade" "$INSTDIR\data"
        RMDir "$INSTDIR\bb-data-tmp"
      ${ElseIf} ${FileExists} "$INSTDIR\bb-data-tmp\bluebird.json"
        Rename "$INSTDIR\bb-data-tmp" "$INSTDIR\data"
      ${Else}
        RMDir /r "$INSTDIR\bb-data-tmp"
      ${EndIf}
      RMDir /r "$bbDataStash"
    ${EndIf}
    StrCpy $bbDataStash ""
  ${EndIf}
!macroend

Function .onInstFailed
  ${If} $bbDataStash != ""
  ${AndIf} ${FileExists} "$bbDataStash"
    ClearErrors
    Rename "$bbDataStash" "$bbDataOldDir\data"
    ${IfNot} ${Errors}
      StrCpy $bbDataStash ""
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif ; !ifndef BUILD_UNINSTALLER
