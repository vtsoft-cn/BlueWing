; BlueBird 安装器定制:便携数据(data/)保全策略
;
; 背景:升级重装时,electron-builder 会先静默执行旧版卸载器,其内部
; RMDir /r $INSTDIR 会连 portable data/ 一起清掉(/KEEP_APP_DATA 仅
; 保护 %APPDATA%,不保护安装目录内的数据)。因此:
;   - 升级重装:安装器初始化时先把旧目录 data/ 暂存到同级位置,
;     新文件装完后还原到 $INSTDIR\data(跨盘重装走复制中转)
;   - 正式卸载:不做任何保全,data/ 随安装目录一并删除(模板默认行为)
;   - 安装失败/安装段中止:立即把暂存还原回旧目录(.onUserAbort 被 MUI 占用,
;     向导取消无法挂钩,改为下次安装时自动沿用现成暂存完成还原)

; 本脚本只属于安装器主编译趟;卸载器独立编译趟(BUILD_UNINSTALLER)不需要
; 这些逻辑(卸载即随模板默认行为删除 data/),跳过以避免未引用变量等告警。
; LogicLib 需自行引入(注入位置早于 common.nsh;带守卫,重复包含安全)。
!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"

Var /GLOBAL bbDataOldDir   ; 检测到的旧安装目录
Var /GLOBAL bbDataStash    ; data/ 暂存位置(旧安装目录同级)

!macro customInit
  ; 注意:宏体在 .onInit 早期展开,只能用 NSIS 核心指令(不能依赖 installUtil
  ; 的辅助宏,彼时尚未引入);InstallLocation 由每次安装写入,足够定位旧目录
  StrCpy $bbDataStash ""
  StrCpy $bbDataOldDir ""
  ReadRegStr $bbDataOldDir SHCTX "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $bbDataOldDir == ""
    ReadRegStr $bbDataOldDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $bbDataOldDir != ""
    StrCpy $bbDataStash "$bbDataOldDir\..\BlueBirdDataUpgrade"
    ${If} ${FileExists} "$bbDataOldDir\data"
      ${If} ${FileExists} "$bbDataStash"
        ; 上次异常中断遗留的过期暂存:以现存 data/ 为准,清掉暂存
        RMDir /r "$bbDataStash"
      ${EndIf}
      ClearErrors
      Rename "$bbDataOldDir\data" "$bbDataStash"
      ${If} ${Errors}
        ; 目录被占用/权限不足等:放弃保全,行为退回与官方默认一致
        StrCpy $bbDataStash ""
      ${EndIf}
    ${ElseIf} ${FileExists} "$bbDataStash"
      ; 上次在向导中取消安装(.onUserAbort 由 MUI 占用无法挂钩):
      ; data 已在上次的暂存里,直接沿用,本次装完一并还原
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
