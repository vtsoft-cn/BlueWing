# 青翼连接 BlueWing Connect 更新日志 (CHANGELOG)

## [未发布]

### 🛡 数据与稳定性
- 修复安装到不可写目录(如 `C:\Program Files`)时核心启动即崩溃的问题:sing-box `cache_file` 未指定路径,默认在工作目录(安装目录)创建 `cache.db`,普通权限写入被拒导致 `FATAL: initialize cache-file: Access is denied`,表现为无法连接代理;现显式指向应用数据目录(`BLUEWING_DATA_DIR/cache.db`),并附回归单测。

### 🏷 品牌更名
- 系统称号由「青鸟 BlueBird」更名为「青翼连接 BlueWing Connect」:窗口标题、托盘提示与菜单、侧边栏/关于页、各类弹窗与日志文案全部更新;打包产物同步更名——`productName` 改为 BlueWing Connect(安装目录与 exe 随之更名),快捷方式名「青翼连接」,安装包 `BlueWingConnect-Setup.exe`,测速 User-Agent 与 TUN 虚拟网卡名(`BlueWingTun`)一并更新。
- BlueBird 旧标识彻底清除(不做旧数据迁移):`appId` 更名为 `com.bluewing.connect`;数据文件 `bluebird.json` → `bluewing.json`、回退目录 `%APPDATA%\BlueBird` → `%APPDATA%\BlueWingConnect`、环境变量 `BLUEWING_DATA_DIR`、日志文件 `bluewing.log`;备份体系全面换名——扩展名 `.bluebirdbackup` → `.bluewingbackup`,内部备份 `BlueWing_latest.bluewingbackup`、导入前快照 `BlueWing_pre_import_*`、格式识别键 `bluewing_windows` / `bluewing_android`、下载文件名前缀 `BlueWingConnect_`;WebDAV 默认远端目录与快照文件名同步换名;localStorage 键(`bluewing:theme`、节点排序、测速视图)、代理/DNS 所有权状态字段(`managedByBlueWing`、`bluewingManaged`)统一更名;安装器与异路径实例检测只认新进程名/新暂存名,移除 ownbox.json 历史迁移。旧版 BlueBird 的数据与安装不会被识别或延续,需自行卸载清理。

### ✨ 新功能
- DNS 页新增「自定义域名解析(应用内 Hosts)」:指定域名直接解析到指定 IP,由核心 DNS 以 `predefined` 规则直接返回(sing-box 1.14 无 `dns.hosts` 字段,经实测采用 RFC 1035 记录形式),**完全不修改系统 hosts 文件**;域名精确匹配(与系统 hosts 语义一致),支持 IPv4 / IPv6(同域名可各一条,合并为单条规则多个应答),映射规则置于全部 DNS 规则(含 FakeIP)之前保证优先生效;启用行实时红框校验与保存前整表校验,禁用与非法记录不进入核心配置;记录随 DNS 配置入库并纳入备份。
- 新增主进程/渲染层共享的 IP 与域名字面量校验模块(`src/utils/ip.ts`,IPv6 完整支持 `::` 压缩形式),hosts 映射校验共用。

### 🎨 界面与交互
- 托盘图标简化:移除 `menu-{dark,light}-{on,off}.png` 主题变体四枚,改为仅随连接状态切换——连接 `on.png` / 断开 `off.png`(不随界面主题),`trayIconPath` 与托盘刷新逻辑同步精简。
- 侧边栏左上角品牌区改为仅显示英文:「BlueWing Connect」+ 副题「PC Proxy Toolchain」。
- 修复内容区滚动后顶部无法拖动窗口的问题:两重成因——①拖动面(页头/侧栏)叠加的 `backdrop-blur` 强制合成层、滚动触发层重建后 `-webkit-app-region: drag` 命中失效,已移除无效毛玻璃并为页头/侧栏品牌区新增显式 `.drag-region` 声明;②Chromium/Electron 已知缺陷(electron#40610/#52063):容器滚动后拖动区域矩形缓存整体失效——现于滚动停止后把 `app-region` 短暂切至 no-drag 并跨帧还原,强制重算拖动区域(全局 scroll 捕获,覆盖页面内嵌滚动区)。
- 图标体系重构:`src/images/`(现成 png / ico 母本,涵盖运行时全部图片)成为唯一图片源,构建链与运行时均直接引用源文件,移除构建期分发/缩放/多尺寸 ICO 组装逻辑;界面 Logo 由渲染层直引;全部图标高清重制,底板铺满画布无留白。
- 托盘图标统一为 `menu-*` 圆形徽章变体:修复浅色主题误用 `app-*` 方形图标导致深浅主题托盘样式不一致的问题,移除冗余 `tray-*.png` 中转文件。
- `.ico` 全部精简为单帧 256×256(移除内嵌 16/32/48 小尺寸帧),小尺寸场景由 Windows 系统缩放提供。
- 图标资产命名统一:界面 Logo 更名为 `app-{dark,light}.png`(去掉失去语义的 `-off` 后缀),exe/安装器图标更名为 `ico.ico`;全量图标从设计源重新导出(单帧 256×256);`ico/` 目录最终只保留运行时引用的 `ico.ico`,清理无引用的 `menu-*.ico` 与 `app-*.ico` 母本及临时调试脚本目录 `temp/`。
- 任务栏窗口图标固定为 exe 内嵌图标(与桌面快捷方式一致),不再随主题与代理状态切换,连接状态反馈统一由托盘图标承担。

### 🔧 依赖与构建
- Electron 34.5.8 → 44.8.0,electron-builder 25.1.8 → 26.15.3:安装包体积随新版 Electron 增大(约 139MB → 167MB);新工具链二进制首次构建需联网下载,GitHub 直连不可达时可用 npmmirror 镜像(`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`)。

### 🛡 数据与稳定性
- 安装器数据保全:升级重装自动暂存并还原安装目录下的便携 `data/`(自定义 NSIS 脚本 `build/installer.nsh`),仅正式卸载时随安装目录一并删除,修复重装清空用户数据的问题。
- 覆盖安装数据保全加固:安装器先通过二次实例信号(`--bb-shutdown`)让运行中的 BlueBird 还原系统代理、停止核心后自行退出(修复应用未退出时升级丢数据与强杀残留系统代理断网的问题,超时才强杀兜底),再做数据暂存;暂存反复失败时中止安装而非放弃保全;应用启动时自动收回安装向导取消遗留的数据暂存。

## [1.0.0] - 2026-10-15 (首个正式版本)

### 🚀 核心与协议
- 基于官方 **sing-box 1.14.3 稳定版**核心(全量构建标签,含 `with_naive_outbound`),集成 gVisor 协议栈与 Clash API;
- **全协议栈**:VLESS(Reality 伪装、gRPC / WebSocket)、VMess、Trojan、Shadowsocks、Hysteria 1 / 2、TUIC v5、WireGuard(endpoint 架构)、**NaiveProxy**(真实 Chrome TLS 指纹,`libcronet.dll` 随安装包分发)、SOCKS5、HTTP;
- 全部 12 种协议的生成配置经 1.14.3 `sing-box check` 实测校验通过;
- 零断流节点热切换:Clash API 动态热重载,核心运行期间切换节点瞬间完成。

### 🎨 界面与交互
- 无边框窗口:任意空白区域拖动,页头内嵌连接状态与最小化/关闭控制,固定窗口尺寸范围(980×680 ~ 1600×1040);
- 图标体系为 dark/light 双主题(多尺寸 ICO 16~256):界面 Logo 随主题切换,任务栏与托盘图标随代理状态切换(开=light,关=dark);`src/icon/` 为唯一图标源,构建链经 `scripts/sync-icons.mjs` 强制重新分发;
- 页面切换入场动画与内容卡片统一悬停动效。

### 🛡 数据与稳定性
- 数据目录统一治理:备份/快照/日志/核心/代理状态全部由 `Database.getDataDir()` 统一解析,测试进程完全隔离(临时目录 + 退出清理);
- 本地凭据 Windows DPAPI 加密存储,数据库 Schema v2 原子写入与断电自愈;
- 跨端备份:Android 手机端备份无损互转、分类选择性备份与原子回滚保护,内置 WebDAV 云同步;
- 便携数据构建保全(`scripts/preserve-data.js`),重打包不丢用户数据。
