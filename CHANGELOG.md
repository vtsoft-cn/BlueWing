# 青鸟 BlueBird 更新日志 (CHANGELOG)

## [未发布]

### 🎨 界面与交互
- 图标体系重构:`src/images/`(现成 png / ico 母本,涵盖运行时全部图片)成为唯一图片源,构建链与运行时均直接引用源文件,移除构建期分发/缩放/多尺寸 ICO 组装逻辑;界面 Logo 由渲染层直引;全部图标高清重制,底板铺满画布无留白。

### 🛡 数据与稳定性
- 安装器数据保全:升级重装自动暂存并还原安装目录下的便携 `data/`(自定义 NSIS 脚本 `build/installer.nsh`),仅正式卸载时随安装目录一并删除,修复重装清空用户数据的问题。

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
