# 第三方开源组件声明 (THIRD PARTY NOTICES)

青翼连接 BlueWing Connect 客户端在开发过程中引用或集成了以下优秀的开源项目，特此致谢并保留各自的版权与许可声明：

1. **Sing-box**
   - 官方主页: https://github.com/SagerNet/sing-box
   - 许可证: GNU General Public License v3.0 (GPL-3.0)
   - 用途: 底层通用代理核心与网络转发引擎

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
