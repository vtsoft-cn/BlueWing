# 第三方开源组件声明 (THIRD PARTY NOTICES)

青翼连接 BlueWing Connect 客户端在开发过程中引用或集成了以下优秀的开源项目，特此致谢并保留各自的版权与许可声明：

1. **Sing-box**
   - 官方主页: https://github.com/SagerNet/sing-box
   - 许可证: GNU General Public License v3.0 (GPL-3.0)
   - 用途: 底层通用代理核心与网络转发引擎
   - 随包版本: `1.14.3-bluewing.1`，基于固定上游 `v1.14.3` 的 BlueWing 维护构建。
   - 修改: 固定依赖的 gVisor 本地产生 IPv4 分片及重组校验和修复，WireGuard Windows 报文缓冲修复。
   - 完整维护源码和许可证: `bin/routing-core-sources.zip`；来源、工具链和校验值: `bin/routing-core-manifest.json`。
   - 构建说明: 归档内 `native/routing/BLUEWING-FORK.md`；构建入口 `scripts/build-routing-core.cjs` 随归档提供。

2. **Wintun**
   - 官方主页: https://www.wintun.net
   - 许可证: MIT / GPL-2.0
   - 用途: 高性能 Windows TUN 虚拟网卡驱动

3. **OpenVPN（命令行引擎）**
   - 官方主页: https://openvpn.net/community
   - 版本: 2.7.8（官方 Windows MSI `OpenVPN-2.7.8-I002-amd64.msi` 经管理映像提取，
     SHA-256 `33104dd02c48cba172612882b1af6276422b1b4340d4c9c84dd2afb4b356fe9f`）
   - 许可证: GNU General Public License v2（GPLv2，含 OpenSSL 例外条款；
     完整文本随附于 `bin/vpn/openvpn/license.txt`）
   - 源码获取: https://github.com/OpenVPN/openvpn （tag v2.7.8）—— 本应用仅原样分发
     官方未修改二进制（openvpn.exe 及其依赖 DLL），未做任何修改或再链接；GPLv2
     的源码要约以上述官方公开仓库满足
   - 用途: VPN 接入功能中的 OpenVPN 协议客户端引擎（独立子进程运行，与主程序为
     "聚合"关系，不构成同一作品）

4. **OpenConnect（命令行引擎）及随包运行库**
   - 官方主页: https://www.infradead.org/openconnect
   - 版本: v9.21.git.25.70d1e79（官方维护者 COPR `dwmw2/openconnect` 的
     mingw64-openconnect-installer 构建原样提取，含 GnuTLS/Nettle 等随包运行库
     与 wintun.dll）
   - 许可证: GNU Lesser General Public License 2.1（LGPL-2.1；
     完整文本随附于 `bin/vpn/openconnect/LICENSE.openconnect.txt`；
     随包运行库：GnuTLS LGPL-2.1+、Nettle LGPL-3+、libxml2 MIT、zlib zlib、
     wintun MIT/GPL-2.0 双许可）
   - 源码获取: https://gitlab.com/openconnect/openconnect （master）—— 本应用仅
     原样分发官方未修改二进制，独立子进程运行（聚合关系）
   - 用途: VPN 接入功能中的 Cisco AnyConnect / FortiClient SSL VPN /
     Palo Alto GlobalProtect 等协议客户端引擎

5. **Electron**
   - 官方主页: https://www.electronjs.org
   - 许可证: MIT License
   - 用途: 跨平台桌面原生窗口与系统进程生命周期管理

6. **React**
   - 官方主页: https://react.dev
   - 许可证: MIT License
   - 用途: 现代化组件驱动式用户界面库

7. **TailwindCSS**
   - 官方主页: https://tailwindcss.com
   - 许可证: MIT License
   - 用途: 响应式实用优先样式系统

8. **Lucide Icons**
   - 官方主页: https://lucide.dev
   - 许可证: ISC License
   - 用途: 现代扁平化矢量图标集

9. **Vite**
   - 官方主页: https://vitejs.dev
   - 许可证: MIT License
   - 用途: 极速现代前端构建打包工具

8. **zju-connect（BlueWing 维护分支）**
   - 上游主页: https://github.com/Mythologyli/zju-connect
   - 基线: v1.3.1，提交 `5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da`
   - 许可证: GNU Affero General Public License v3.0 (AGPL-3.0)
   - 用途: EasyConnect 与 aTrust 用户态协议核心；没有集成 EZ4Connect 的界面源码。
   - 保留上游版权与许可；修改说明见 `native/vpn/BLUEWING-FORK.md`，完整维护源码见 `native/vpn/`。
   - 构建附带 `bin/VPN-CORE-LICENSE-AGPL-3.0.txt`、`bin/vpn-core-sources.zip` 和含来源与校验值的 `bin/vpn-core-manifest.json`。
   - 以上材料不代表已完成集成产品的整体许可证决策；公开发布前须完成该决策。

9. **govpn SoftEther 报文实现（BlueWing 适配）**
   - 官方主页: https://github.com/bclswl0827/govpn
   - 基线: v0.2.4，提交 `78c78a37330f361c8f4922b0e7e126a3fc495742`
   - 许可证: MIT，Copyright (c) 2026 ttyAMA0
   - 用途: SoftEther 原生协议报文、密码挑战、ARP 和 DHCP；复用 BlueWing 现有私有网络栈，不安装 TAP 网卡。
   - 许可全文与修改说明: `native/vpn/client/softether/LICENSE-MIT`、`UPSTREAM.md`，随维护源码一并打包。

10. **wireguard-go（BlueWing 本机认证链路维护副本）**
    - 上游: https://git.zx2c4.com/wireguard-go/ ，固定提交 `ecfc5a8d5446`。
    - 许可证: MIT，原版权和许可保留在 `native/vpn/third_party/wireguard/LICENSE`。
    - 修改: Windows 内存报文缓冲上限使用桌面默认值；说明见该目录 `BLUEWING-PATCH.md`。
    - 完整源码随 `bin/vpn-core-sources.zip` 分发；分流核心另有独立维护源码归档，见第 1 项。
