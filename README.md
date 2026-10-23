# 青翼连接 BlueWing Connect (Windows PC 客户端)

<p align="center">
  <img src="src/images/png/app-light.png" width="128" height="128" alt="BlueWing Connect Logo">
  <br>
  <b>基于 Sing-box 官方原生核心打造的现代化 Windows 通用网络代理工具链与网络调试客户端</b>
  <br>
  <b>A Modern Universal Proxy Toolchain & Network Debugging Client for Windows PC</b>
</p>

<p align="center">
  <a href="https://gitee.com/vtsoft_cn/blue-bird"><img src="https://img.shields.io/badge/Gitee-vtsoft__cn%2Fblue--bird-C71D23.svg?logo=gitee&style=flat-square" alt="Gitee"></a>
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/Platform-Windows%20x64-brightgreen.svg?style=flat-square" alt="Platform"></a>
</p>

---

## 📖 项目介绍 / Introduction

**青翼连接 BlueWing Connect** 是专门面向 PC 桌面环境深度打造的原生通用网络代理与网络调试工具,针对桌面大屏操作与 Windows 平台特性进行了全新原生架构设计。

软件基于官方原生 **Sing-box 1.14.3 稳定版**核心构建(全量构建标签,内置 NaiveProxy 支持),原生集成微软签名 **Wintun 0.14.1** 网卡驱动,全面支持 VLESS(含 Reality 伪装)、VMess、Trojan、Shadowsocks、Hysteria 1 / 2、TUIC、WireGuard、NaiveProxy、SOCKS5、HTTP 等全协议栈,提供毫秒级 TCP 握手测速、零断流节点热重载、Windows 进程应用级分流、防污染 FakeIP DNS 解析、WebDAV 云端多端同步与系统托盘快捷控制。

---

## 🚀 核心特性 / Features

* **现代桌面原生 UI**：无边框设计(页头拖动窗口,内容区滚动后依然可靠;侧栏空白区域亦可拖动)、页头状态栏与内嵌窗口控制,系统浅色 / 深色主题无缝切换,页面切换与卡片交互动效;
* **官方原生代理核心**：基于官方 Sing-box 1.14.3 稳定版原生二进制,集成 gVisor 高性能网络协议栈与 Clash API 监控;
* **零断流节点热切换**：集成 Clash API 动态热重载选择器，节点切换瞬间完成，零断流不断网；
* **全协议栈与最新传输**：
  * 支持 **VLESS** (支持 `xtls-rprx-vision` 流控、Reality 伪装、gRPC / WebSocket 传输);
  * 支持 **VMess**, **Trojan**, **Shadowsocks**;
  * 支持 **Hysteria 1 / 2** (含 Salamander 混淆)；
  * 支持 **TUIC v5** (原生 QUIC 拥塞控制)；
  * 支持 **WireGuard**(sing-box endpoint 架构)、**NaiveProxy**(真实 Chrome TLS 指纹,内置 libcronet)、**SOCKS5**、**HTTP**;
* **双模式代理接管**：
  * **Windows 系统代理**：真实操纵注册表与 WinINet API，智能绕过局域网地址，所有权跟踪与异常启动自动修复；
  * **TUN 虚拟网卡**：基于 Wintun 0.14.1 驱动，全局透明接管所有软件网络流量，支持 DNS 劫持防护；
* **Windows 应用分流**：支持扫描本机运行中的应用进程，精准针对可执行程序 (.exe) 指定走代理、直连或阻止连接；
* **隔离物理级网络测速中心**：
  * 核心内置独立 `speedtest-in` 回环入站与 `speedtest-selector` 出站组，测速与正常上网流量互不干扰；
  * 原生 TCP Ping 三次握手精确时延检测（支持 10 并发极速测试）；
  * HTTP URL 响应延迟与下行带宽吞吐测速，支持卡片与表格双重视图及数值外显；
* **安全防污染 DNS**：
  * 支持标准真实 IP 模式与 **FakeIP** (`198.18.0.0/15`) 极速首包响应模式；
  * 支持自定义 DNS 服务器与 4096 条 DNS 内存高速缓存加速；
* **跨端无损备份与数据安全**：
  * 本地凭据采用 Windows DPAPI 硬件级加密存储 (`enc:dpapi:`)；
  * 数据库采用 Schema v2 原子写入，支持断电 0 字节自愈保护与损坏自动隔离；
  * 深度打通 Android 手机端（AndroidParcel / Kryo 序列化无损互转），支持选择性分类备份与原子回滚保护；
  * 内置 WebDAV 云备份与双向快照恢复；
* **端到端纯净日志**：ANSI 控制符清洗，毫秒级时间戳，系统/核心/网络分类标签，平稳刷盘保护；
* **系统托盘与便捷交互**：系统托盘常驻，支持动态连接状态显示与一键切换节点。

---

## 📥 发行版下载 / Download

请前往 Gitee 仓库获取经过编译的 Windows 正式版本：

👉 **[前往 Gitee 仓库](https://gitee.com/vtsoft_cn/blue-bird)**

| 安装包类型 | 文件名 | 适用场景 |
| :--- | :--- | :--- |
| **Windows 安装版** | `BlueWingConnect-Setup.exe` | 推荐普通用户使用，自动创建开始菜单与桌面快捷方式，支持卸载 |
| **便携绿色版** | `release/win-unpacked/` 目录 | 解压即用，数据保存在 exe 同级 data/ 目录,适合移动硬盘随身携带 |

> 💡 **数据说明**：用户数据（配置、订阅、日志等）跟随安装位置——安装到用户可写目录时保存在安装目录下的 `data/`；安装到 `C:\Program Files` 等受保护位置时保存在 `%APPDATA%\BlueWingConnect`,并在下次换装到可写位置时自动整体迁回、不留副本。升级重装自动保留数据（即使应用正在运行中直接覆盖升级同样安全——安装器会先让运行实例还原系统代理后退出,再保全数据）；仅通过控制面板正式卸载时才会连同数据一并清理（此时也会还原/清除应用开启的系统代理）。

---

## 🛠 本地开发与构建 / Development & Build

### 依赖环境
* Node.js >= 20.0
* npm >= 10.0

### 编译步骤
```bash
# 1. 克隆代码仓库
git clone https://gitee.com/vtsoft_cn/blue-bird.git
cd blue-bird

# 2. 安装前端与桌面依赖
npm install

# 3. 运行本地开发环境
#    (npm run dev 启动 Vite 渲染层开发服务器;调试完整桌面端需先 npm run build,
#     再以 VITE_DEV_SERVER_URL=http://localhost:5173 electron dist/main/index.js 启动主进程)
npm run dev

# 4. 运行全量单元与集成测试套件 (40 项测试)
npm test

# 5. 构建前端与主进程(图标直接使用 src/images,无构建期处理)
npm run build

# 6. 打包生成 Windows 安装程序与免安装目录
npm run dist
```
构建产物将保存在 `release/` 目录中：
- `release/win-unpacked/BlueWing Connect.exe`
- `release/BlueWingConnect-Setup.exe`

## Windows EasyConnect 共存诊断

保留 Windows 版 EasyConnect 时，先区分连接后的路由、DNS 变化与客户端网络过滤。
项目提供只读采集脚本，在断网期间也会继续将结果保存在本机：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-easyconnect.ps1 -DurationSeconds 180
```

使用平时登录桌面的 Windows 账户运行。开始采集后连接 EasyConnect，故障出现后保持
10～15 秒，再断开 EasyConnect。结果保存在 `work/easyconnect-diagnostics/`，已从 Git 排除。
脚本不修改路由、DNS、系统代理、驱动、服务或防火墙。

采集包含路由、网卡、DNS、系统代理、相关进程及 TCP 连通性，并对比普通连接与指定物理网卡
出口的连接。物理网卡测试成功而普通连接失败，可以进一步验证指定代理出口的修复；两者都失败
时，需要结合路由、DNS 与过滤证据继续判断，不能仅凭超时认定专线模式，也不能把新增 `DIRECT`
规则视为已解除限制。

可用 `-IntranetHost 内网域名或IP -IntranetPort 443` 同时探测一个公司资源；
`-DurationSeconds 0` 只采集一次当前状态。

需要继续定位 Windows 过滤规则时，可以运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\inspect-easyconnect-filters.ps1 -WatchSeconds 600
```

此脚本需要有权导出 WFP 状态的 Windows 账户。开始时保持 EasyConnect 断开，提示等待后
连接并保持故障约 30 秒，再断开。脚本自动保存连接前、连接中与断开后的过滤规则、规则差异
及公网／物理网关 TCP 探测结果；除了按 GUID 对比，也按规则内容对比，避免 Windows
防火墙重建规则导致大量无关差异。`-WatchSeconds 0` 仅保存当前状态。
它不会增加、删除或修改任何过滤规则。采集文件包含网络及应用路径信息，分享前请检查。

