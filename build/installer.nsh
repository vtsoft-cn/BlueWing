; 青翼连接 (BlueWing Connect) 安装器定制:便携数据(data/)保全策略
;
; 背景:升级重装时,electron-builder 会先静默执行旧版卸载器,其内部
; RMDir /r $INSTDIR 会连 portable data/ 一起清掉(/KEEP_APP_DATA 仅
; 保护 %APPDATA%,不保护安装目录内的数据)。因此:
;   - 升级重装:安装器初始化时先结束运行中的 青翼连接/sing-box 进程
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

; ---------------------------------------------------------------
; 位图保比例显示:MUI2 默认 _STRETCH=FitControl 把位图无比例拉伸填满控件,
; 而控件像素宽高比随 DPI/系统字体度量变化(150% DPI 中文系统实测 ≈1.4:1),
; 欢迎页竖幅里的圆形徽标因此被横向拉扁(实测 aspect 1.0→1.48)。
; AspectFitHeight 按控件高度保比例缩放并把控件收窄到位图宽度(白底无缝),
; 在任意 DPI 下徽标恒为正圆。本文件被前插到模板最前,早于 MUI2 一切消费点,
; 安装趟(欢迎/完成页竖幅+内页头图)与卸载趟(同款页面)一并覆盖。
; electron-builder 只经命令行下发 MUI_*_BITMAP(同名再 define 会冲突),
; 这三个 *_STRETCH 它不下发,此处定义安全。
; ---------------------------------------------------------------
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"

; 放开 NSIS 默认的盘符根目录安装禁用(默认直接灰掉安装按钮且无任何提示,用户
; 只见"无法安装");改由目录页 LEAVE 钩子 bbRejectRootDir 弹明确提示并留页;
; 即便钩子被绕过,instFilesPre 也会自动追加应用名子目录,不存在真装到根目录的路径。
AllowRootDirInstall true

; ---------------------------------------------------------------
; 安装器品牌化:MUI 欢迎页(标题/文案注入 + MUI_PAGE_WELCOME);头图与欢迎页
; 竖幅走 electron-builder 资源约定(build/installerHeader.bmp 与
; build/installerSidebar.bmp)——它据此自动下发 MUI_HEADERIMAGE_* 与
; MUI_WELCOMEFINISHPAGE_BITMAP 命令行 define(自行 !define 同名会冲突,
; 此前用 MUI 1.x 旧名 MUI_WELCOMEPAGE_BITMAP 则被静默忽略,欢迎页一直是
; NSIS 默认图);头图对称边距在欢迎页 SHOW(bbAlignHeaderImage)运行时调整。
; 本文件被前插到模板之前,宏体在 assistedInstaller.nsh 对应 !ifmacrodef
; 处展开(晚于 common.nsh,可用 ${VERSION} 等 define)。
; ---------------------------------------------------------------

; 自定义欢迎页(模板无默认欢迎页,经 customWelcomePage 钩子注入);
; 欢迎页 SHOW 时顺带把内页右上角头图右缘对齐到标题左缘(左右边距对称)——
; 安装器为固定 perMachine(无安装模式页)。
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 BlueWing Connect"
  !define MUI_WELCOMEPAGE_TEXT "青翼连接 · Windows PC 代理工具链$\r$\n$\r$\n此向导将引导你完成 BlueWing Connect 的安装。$\r$\n$\r$\n建议在继续之前关闭所有其他应用程序。$\r$\n$\r$\n版本 ${VERSION}"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW bbAlignHeaderImage
  !insertmacro MUI_PAGE_WELCOME
  ; 目录页顶部提示(由下一个 MUI 页即目录页消费):NSIS 目录页对盘符根目录
  ; 直接禁用安装按钮且无说明,此提示告知用户原因与应用名子目录规则
  !define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。不支持盘符根目录(如 C:\),选择任意文件夹后安装程序会自动创建 BlueWing Connect 子目录。"
!macroend

; 头图位置由 NSIS UI 资源固定,默认紧贴右缘;此处运行时右缘对称:
; 头图(控件 1046)右边距 = 标题(控件 1037)左边距。欢迎页显示时执行一次,
; 位置全程沿用;隐藏控件(欢迎页隐藏页头)的矩形仍有效,计算不受影响。
Function bbAlignHeaderImage
  GetDlgItem $0 $HWNDPARENT 1046
  GetDlgItem $1 $HWNDPARENT 1037
  ${If} $0 != 0
  ${AndIf} $1 != 0
    System::Alloc 16
    Pop $2
    ${If} $2 != 0
      System::Call 'user32::GetWindowRect(i r1, i r2)'
      System::Call 'user32::MapWindowPoints(i 0, i $HWNDPARENT, i r2, i 2)'
      System::Call '*$2(i .r3)'
      System::Call 'user32::GetClientRect(i $HWNDPARENT, i r2)'
      System::Call '*$2(i, i, i .r4)'
      System::Call 'user32::GetWindowRect(i r0, i r2)'
      System::Call '*$2(i .r5, i, i .r6)'
      IntOp $7 $6 - $5
      IntOp $8 $4 - $3
      IntOp $8 $8 - $7
      System::Call 'user32::SetWindowPos(i r0, i 0, i r8, i 0, i 0, i 0, i 0x15)'
      System::Free $2
    ${EndIf}
  ${EndIf}
FunctionEnd

; 拒绝盘符根目录(如 C:\)作为安装位置:electron-builder 的进程前缀匹配/路径
; 拼接在根目录下行为异常(实测安装段 0% 静默卡死);提示用户选择子文件夹后留页。
; 注意 MUI 目录页 LEAVE 回调执行时 $INSTDIR 尚未同步为输入框内容,须直接读
; 目录输入框(内层对话框 #32770 的 1019 控件)文本判断。
Function bbRejectRootDir
  StrCpy $2 $INSTDIR
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${If} $1 != 0
    GetDlgItem $0 $1 1019
    ${If} $0 != 0
      System::Call 'user32::GetWindowText(i r0, t .r2, i 260)'
    ${EndIf}
  ${EndIf}
  StrCpy $0 $2 3
  ${If} $0 == $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "不能直接安装到盘符根目录(如 C:\)。$\r$\n请选择或新建一个子文件夹,例如 C:\BlueWing Connect。" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd


Var /GLOBAL bbDataOldDir   ; 检测到的旧安装目录
Var /GLOBAL bbDataStash    ; data/ 暂存位置(旧安装目录同级)

; 结束运行中的 青翼连接 与 sing-box。优先让运行实例优雅退出(还原系统代理、
; 停止核心后自行退出,见主进程 second-instance 对 --bb-shutdown 的处理):
; 信号经一次性计划任务以登录用户身份直接拉起
; "<旧目录>BlueWing Connect.exe --bb-shutdown"——避免提权安装器直接启动时
; 子进程继承管理员完整性、与普通用户实例的单实例握手失败。轮询等待最多 6 秒;
; 超时未退才回退温和/强制 taskkill,并在强杀后清理特征值残留系统代理兜底。
; 必须先探测确有运行实例,否则信号任务会凭空把应用启动起来。
Function bbCloseRunningApp
  ${If} $bbDataOldDir != ""
  ${AndIf} ${FileExists} "$bbDataOldDir\BlueWing Connect.exe"
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq BlueWing Connect.exe" /FO csv | "$SYSDIR\find.exe" "BlueWing Connect.exe"`
    Pop $R0
    ${If} $R0 == 0
      ; 提权安装器(本进程 high integrity)直接启动信号进程会以管理员完整性运行,
      ; 与普通用户运行实例的单实例握手失败,信号送不到、实例被强杀、系统代理残留
      ; (实测)。改为一次性计划任务以登录用户(中等完整性)身份直接拉起
      ; "<旧目录>BlueWing Connect.exe --bb-shutdown":该路径不创建任何窗口
      ; (show:false 且单实例握手前即退出),无需任何脚本载体——曾用 $PLUGINSDIR
      ; 的 VBS 经 wscript 无窗拉起,但"wscript+临时目录脚本"组合会被杀软/攻击面
      ; 防护拦截(实测报"加载脚本失败: 拒绝访问"),任务即用即删。
      nsExec::Exec `"$SYSDIR\cmd.exe" /c schtasks /create /tn "BlueWingUpgradeShutdown" /tr "\"$bbDataOldDir\BlueWing Connect.exe\" --bb-shutdown" /sc once /st 23:59 /f`
      Pop $R9
      nsExec::Exec `"$SYSDIR\cmd.exe" /c schtasks /run /tn "BlueWingUpgradeShutdown"`
      Pop $R9
      StrCpy $R1 0
      bbGracefulWait:
      Sleep 500
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq BlueWing Connect.exe" /FO csv | "$SYSDIR\find.exe" "BlueWing Connect.exe"`
      Pop $R0
      ${If} $R0 != 0
        nsExec::Exec `"$SYSDIR\cmd.exe" /c schtasks /delete /tn "BlueWingUpgradeShutdown" /f`
        Return
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 < 12
        Goto bbGracefulWait
      ${EndIf}
    ${EndIf}
  ${EndIf}
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "BlueWing Connect.exe"`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "sing-box.exe"`
  Sleep 300
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "BlueWing Connect.exe"`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "sing-box.exe"`
  Sleep 300
  ; 强杀兜底:实例可能带着系统代理退出。仅当代理服务器精确等于本应用特征值
  ; (127.0.0.1:2080)时禁用并清空,不触碰用户自有代理;WinINet 广播刷新使
  ; 所有进程立即生效。应用下次启动的残留自愈机制保持不变。
  ClearErrors
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyServer
  ${IfNot} ${Errors}
  ${AndIf} $R0 == "127.0.0.1:2080"
    ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyEnable
    ${If} $R1 == 1
      WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyEnable 0
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyServer
      System::Call 'wininet::InternetSetOption(p0, i39, p0, i0)i'
      System::Call 'wininet::InternetSetOption(p0, i95, p0, i0)i'
    ${EndIf}
  ${EndIf}
FunctionEnd

; 杀进程后带重试地暂存改名;反复失败则区分原因:
;   - 非管理员 + 旧目录在受保护位置(如 Program Files 的 per-machine 安装):
;     改名因无写权限必然失败,提示后以管理员身份重新运行安装器(提权实例的
;     .onInit 会再次走到这里并以管理员完成暂存),避免死循环与误导性提示;
;   - 已是管理员仍失败:按"目录被占用"提示重试/取消,取消即中止安装
;     (中止时旧目录原封不动,无任何数据风险;静默安装下默认取消)。
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
  UserInfo::GetAccountType
  Pop $R8
  ${If} $R8 != "Admin"
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_TOPMOST "检测到旧版是「为所有人安装」(位于公共目录),需要管理员权限才能保全用户数据并继续升级。$\r$\n选择「确定」将弹出 UAC 并以管理员身份重新运行安装程序(已进行的操作不会丢失数据)。" /SD IDCANCEL IDOK bbElevateRelaunch
    Abort
    bbElevateRelaunch:
    ExecShell "runas" "$EXEPATH"
    Quit
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP|MB_TOPMOST "无法保全旧版用户数据:data 目录仍被占用(青翼连接 可能尚未完全退出)。$\r$\n请完全退出 青翼连接(托盘图标右键 -> 退出 青翼连接)后选择「重试」。$\r$\n选择「取消」将中止安装,不会改动任何现有数据。" /SD IDCANCEL IDRETRY bbStashRetryAll
  Abort
FunctionEnd

; 候选旧目录有效性校验:目录存在且确有旧安装痕迹(data/ 或主程序或卸载器),
; 否则清空视为无旧安装。无效返回 ""。
Function bbValidateOldDir
  ${If} $bbDataOldDir != ""
  ${AndIf} ${FileExists} "$bbDataOldDir"
    ${If} ${FileExists} "$bbDataOldDir\data"
    ${OrIf} ${FileExists} "$bbDataOldDir\BlueWing Connect.exe"
    ${OrIf} ${FileExists} "$bbDataOldDir\Uninstall BlueWing Connect.exe"
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $bbDataOldDir ""
FunctionEnd

!macro customInit
  ; 注意:宏体在 .onInit 早期展开,只能用 NSIS 核心指令与插件调用(不能依赖
  ; installUtil 的辅助宏,彼时尚未引入)。
  ;
  ; 旧安装目录按候选定位,各级均经 bbValidateOldDir 校验:
  ;   1. 注册表 InstallLocation(INSTALL_REGISTRY_KEY 即 Software\{GUID},
  ;      initMultiUser 每次安装都会写入;实测可能残留过期或损坏的路径)
  ;   2. 本次安装目录 $INSTDIR(initMultiUser 已解析;同目录升级时即旧目录)
  ;   3. 默认安装目录 %LOCALAPPDATA%\Programs\BlueWing Connect(兜底)
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
    StrCpy $bbDataOldDir "$LOCALAPPDATA\Programs\BlueWing Connect"
    Call bbValidateOldDir
  ${EndIf}

  ${If} $bbDataOldDir != ""
    ; 注册表 InstallLocation 若被第三方写成带尾部反斜杠,会让 schtasks /tr 的
    ; \" 转义歧义(路径以 \ 结尾时 \\" 被当作字面反斜杠+引号结束)。统一修剪,
    ; NSIS 路径拼接本来就按无尾反斜杠约定。
    StrCpy $R8 ""
    StrCpy $R8 "$bbDataOldDir" 1 -1
    ${If} $R8 == "\"
      StrCpy $bbDataOldDir "$bbDataOldDir" -1
    ${EndIf}
  ${EndIf}

  ${If} $bbDataOldDir != ""
    ; 只要有旧安装就无条件先关闭运行实例(优雅信号还原系统代理,兜底强杀+
    ; 特征值代理清理):不可只在数据暂存分支做——per-machine 装在 Program Files
    ; 时数据在 %APPDATA%、旧目录无 data/,旧版不调用会导致运行实例被模板自带的
    ; "应用正在运行"对话框强杀,已开启的系统代理残留断网(实测)
    Call bbCloseRunningApp
    StrCpy $bbDataStash "$bbDataOldDir\..\BlueWingDataUpgrade"
    ${If} ${FileExists} "$bbDataOldDir\data"
      ${If} ${FileExists} "$bbDataStash"
        ; 上次异常中断遗留的过期暂存:以现存 data/ 为准,清掉暂存
        RMDir /r "$bbDataStash"
      ${EndIf}
      Call bbStashData
    ${ElseIf} ${FileExists} "$bbDataStash"
      ; 上次在向导中取消安装:数据已在暂存里,直接沿用,本次装完一并还原
      ; (运行实例已在上方统一关闭)
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
      ${If} ${FileExists} "$INSTDIR\bb-data-tmp\BlueWingDataUpgrade"
        Rename "$INSTDIR\bb-data-tmp\BlueWingDataUpgrade" "$INSTDIR\data"
        RMDir "$INSTDIR\bb-data-tmp"
      ${ElseIf} ${FileExists} "$INSTDIR\bb-data-tmp\bluewing.json"
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

!ifdef BUILD_UNINSTALLER
; 正式卸载清理用户数据:数据目录回退位置 %APPDATA%\BlueWingConnect 从不随安装目录
; 删除(electron-builder 自身的 deleteAppData 清理按产品名/包名匹配,与本应用目录
; 名 BlueWingConnect 不一致,须自行清理);升级流程触发的旧卸载器带 --updated 标志,
; 此时严禁删除(数据正被升级保全流程使用),仅真正手动卸载才清理,并顺带清除
; 同级遗留的 BlueWingDataUpgrade 数据暂存。
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; 清理当前用户的 %APPDATA% 数据;per-machine 卸载处于 all 上下文,
    ; 切 current 后必须恢复,否则后续注册表/快捷方式清理会误指向 HKCU
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    ; 系统代理残留清理:提权卸载器强杀运行实例时(完整性差异致优雅信号不可达),
    ; 实例带着已开启的系统代理退出,卸载后网络即断。仅当代理服务器精确等于本应用
    ; 特征值(127.0.0.1:2080)时禁用并清空,不触碰用户自有代理;WinINet 广播刷新。
    ClearErrors
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyServer
    ${IfNot} ${Errors}
    ${AndIf} $R0 == "127.0.0.1:2080"
      ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyEnable
      ${If} $R1 == 1
        WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyEnable 0
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" ProxyServer
        System::Call 'wininet::InternetSetOption(p0, i39, p0, i0)i'
        System::Call 'wininet::InternetSetOption(p0, i95, p0, i0)i'
      ${EndIf}
    ${EndIf}
    RMDir /r "$APPDATA\BlueWingConnect"
    RMDir /r "$INSTDIR\..\BlueWingDataUpgrade"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
!endif ; !ifdef BUILD_UNINSTALLER
