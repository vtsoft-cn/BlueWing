# BlueWing Android

首页用于连接公网代理。粘贴现有的 VLESS TLS 或 Reality 分享链接，授权 Android VPN 后启动代理。首版支持 TCP、TLS WebSocket 和 TCP Reality，可使用 Vision。公网模式通过 sing-box 转发 IPv4 和 IPv6，应用的常规 DNS 查询通过节点访问 DNS-over-HTTPS，节点地址使用底层网络解析。节点由使用者准备，链接仅保留在当前运行中。

企业 VPN 从独立入口进入，通过 Go 桥接层复用 SoftEther 登录和数据包传输。填写的私网 IPv4 网段进入隧道，普通公网保持使用 Android 的现有网络。公网代理与企业 VPN 目前是两种连接模式，切换前先断开当前连接。

填写公司 DNS 后缀后，系统通过 VPN DNS 入口解析域名。命中后缀的查询使用网关下发的私网 IPv4 DNS，其他查询使用连接时取得的当前网络 DNS。公司查询失败会返回错误。留空时保留系统原有 DNS。公司域名解析出的业务地址仍需落在填写的公司网段内。

网关需要账号密码及 Virtual HUB。证书使用系统信任库，使用企业 CA 时可以在界面填写 PEM。连接参数只在本次运行中使用。

## 本地构建

准备 PowerShell 7、JDK 21、Gradle 8.11.1、Android SDK Platform 35、Android NDK 27.2.12479018，以及 Go 1.26.10。设置 `JAVA_HOME`、`ANDROID_HOME` 和 `ANDROID_NDK_HOME`，并确保 Gradle 和 Go 工具可在 PATH 中找到。

在 Windows PowerShell 从仓库根目录运行：

```powershell
$mobileVersion = 'v0.0.0-20261011034528-197770444867'
go install "golang.org/x/mobile/cmd/gomobile@$mobileVersion" "golang.org/x/mobile/cmd/gobind@$mobileVersion"
./android/build.ps1
```

成功时生成 `android/app/build/outputs/apk/debug/app-debug.apk`。ARM64 用于主流 Android 真机，x86_64 用于相应模拟器。

Android 专用 Go 代码位于 `android/native/`。构建脚本将它与两个现有核心合并到临时目录中编译，桌面构建仍直接使用 `native/` 下的核心源码。

## 验收

可以在开启 USB 调试的设备上运行 `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` 安装测试包。公网模式用可用的 VLESS 节点验证浏览器、DNS、关闭后网络恢复，以及 Wi-Fi／蜂窝切换。

在授权测试网关检查证书拒绝、登录成功、公司 IPv4 业务、普通网页、主动断开、网关断开和 Wi-Fi／蜂窝切换。用系统 DNS 验证公司域名走企业解析器，并核对企业解析器断开后同一查询未发到公网。Android 私人 DNS、应用自带的 DoH 和网络切换后解析器变化需要单独验收，当前版本按连接时的网络配置工作。公开发布还需要独立的签名和发行流程。
