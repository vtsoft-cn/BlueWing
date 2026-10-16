# 青鸟 BlueBird (Windows PC 客户端)

<p align="center">
  <img src="src/images/png/app-light-off.png" width="128" height="128" alt="BlueBird Logo">
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

**青鸟 BlueBird** 是专门面向 PC 桌面环境深度打造的原生通用网络代理与网络调试工具,针对桌面大屏操作与 Windows 平台特性进行了全新原生架构设计。

软件基于官方原生 **Sing-box 1.14.3 稳定版**核心构建(全量构建标签,内置 NaiveProxy 支持),原生集成微软签名 **Wintun 0.14.1** 网卡驱动,全面支持 VLESS(含 Reality 伪装)、VMess、Trojan、Shadowsocks、Hysteria 1 / 2、TUIC、WireGuard、NaiveProxy、SOCKS5、HTTP 等全协议栈,提供毫秒级 TCP 握手测速、零断流节点热重载、Windows 进程应用级分流、防污染 FakeIP DNS 解析、WebDAV 云端多端同步与系统托盘快捷控制。

---

## 🚀 核心特性 / Features

* **现代桌面原生 UI**：无边框设计(任意空白区域可拖动窗口)、页头状态栏与内嵌窗口控制,系统浅色 / 深色主题无缝切换,页面切换与卡片交互动效;
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
| **Windows 安装版** | `BlueBird-Setup.exe` | 推荐普通用户使用，自动创建开始菜单与桌面快捷方式，支持卸载 |
| **便携绿色版** | `release/win-unpacked/` 目录 | 解压即用，数据保存在 exe 同级 data/ 目录,适合移动硬盘随身携带 |

> 💡 **数据说明**：安装版升级重装时会自动保留安装目录下的 `data/` 用户数据（配置、订阅、日志等），仅通过卸载程序正式卸载时才会随安装目录一并删除；便携版数据始终在 exe 同级 `data/` 目录，覆盖升级文件不受影响。

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
npm run dev

# 4. 运行全量单元与集成测试套件 (35 项测试)
npm test

# 5. 构建前端与主进程(自动从 src/images 分发图标)
npm run build

# 6. 打包生成 Windows 安装程序与免安装目录
npm run dist
```
构建产物将保存在 `release/` 目录中：
- `release/win-unpacked/BlueBird.exe`
- `release/BlueBird-Setup.exe`

