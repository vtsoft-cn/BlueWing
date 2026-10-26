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

3. **Electron**
   - 官方主页: https://www.electronjs.org
   - 许可证: MIT License
   - 用途: 跨平台桌面原生窗口与系统进程生命周期管理

4. **React**
   - 官方主页: https://react.dev
   - 许可证: MIT License
   - 用途: 现代化组件驱动式用户界面库

5. **TailwindCSS**
   - 官方主页: https://tailwindcss.com
   - 许可证: MIT License
   - 用途: 响应式实用优先样式系统

6. **Lucide Icons**
   - 官方主页: https://lucide.dev
   - 许可证: ISC License
   - 用途: 现代扁平化矢量图标集

7. **Vite**
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
