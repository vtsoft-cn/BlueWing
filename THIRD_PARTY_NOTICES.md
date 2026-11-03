# 第三方组件、来源与分发状态

项目原创代码采用 AGPL-3.0-only。下列第三方组件保留原有许可与版权，不能统一改成项目许可。第三方名称不表示官方背书。

`LICENSES/inventory.json` 由 `npm run licenses:inventory` 生成，列出生产 npm 依赖、两个 Go 模块的完整构建依赖图、收集到的许可文件，以及随包 EXE/DLL/规则的 SHA-256。构建图含测试和构建依赖；清单和哈希本身不能代替对应源码、完整版权或二进制分发授权。

## 维护源码与核心

| 组件 | 固定来源 | 许可与材料 |
| --- | --- | --- |
| sing-box 维护核心 | [SagerNet/sing-box v1.14.3](https://github.com/SagerNet/sing-box/tree/v1.14.3)，修订 `1.14.3-bluewing.2` | GPL-3.0-or-later，保留上游名称约束与版权。`native/routing/`、`BLUEWING-FORK.md`、依赖锁定及本地修改均随源码提供。`bin/routing-core-sources.zip` 与 manifest 记录精确源码和构建校验。 |
| zju-connect 维护核心 | [Mythologyli/zju-connect v1.3.1](https://github.com/Mythologyli/zju-connect/tree/v1.3.1)，提交 `5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da` | AGPL-3.0，原许可在 `native/vpn/LICENSE`。维护说明在 `native/vpn/BLUEWING-FORK.md`；构建生成源码归档、许可及 manifest。不包含 EZ4Connect 界面代码。 |
| govpn SoftEther 报文实现 | [govpn v0.2.4](https://github.com/bclswl0827/govpn/tree/v0.2.4)，提交 `78c78a37330f361c8f4922b0e7e126a3fc495742` | MIT，Copyright (c) 2026 ttyAMA0。来源、修改和许可在 `native/vpn/client/softether/`。 |
| wireguard-go 维护副本 | [上游仓库](https://git.zx2c4.com/wireguard-go/)，固定提交 `ecfc5a8d5446` | MIT，原许可及修改说明保留在 `native/vpn/third_party/wireguard/` 和 `native/routing/third_party/wireguard-go/`，随源码归档提供。 |
| Go 运行库和其他 Go 模块 | `go.mod`、`go.sum`、`replace` 和构建 manifest | Go 工具链固定 1.26.10；许可采集见 `LICENSES/go/`、`LICENSES/runtime/`。清单未找到许可或缺少对应源码的模块须继续核对，不能推定同意重新许可。 |

## 随包第三方二进制：公开发行仍需补齐材料

这些运行文件在私有开发仓库中保留，相关 VPN 代码没有删除。默认公开源码快照不包含 `bin/`，也不包含其中的源码 ZIP；公开二进制发行检查会阻止在材料未齐全时误发布。

- **Wintun 预编译 DLL**：[官方预编译许可](https://git.zx2c4.com/wintun/tree/prebuilt-binaries-license.txt) 已原文保存为 `LICENSES/upstream/Wintun-prebuilt.txt`。预编译文件适用专用许可，不能笼统写成 MIT/GPL 双许可。须确认每份 DLL 确为许可覆盖的官方文件、遵守随使用该 API 的软件一并分发等条件，并保留原声明。
- **OpenVPN 2.7.8**：现有记录称提取自 `OpenVPN-2.7.8-I002-amd64.msi`，安装包 SHA-256 为 `33104dd02c48cba172612882b1af6276422b1b4340d4c9c84dd2afb4b356fe9f`。OpenVPN 为 GPL-2.0，另有 OpenSSL、Apache2、LZO 链接例外，原文在 `bin/vpn/openvpn/license.txt` 及 `LICENSES/upstream/OpenVPN-COPYING.txt`。上游 [v2.7.8](https://github.com/OpenVPN/openvpn/tree/v2.7.8) 仅作为定位来源；仓库首页或标签链接不自动满足 GPL 的对应源码分发义务。公开发行前需补齐该 Windows 构建、补丁、脚本、链接库的精确版本、完整许可与对应源码材料。
- **OpenConnect 与随包 DLL**：现有记录为 `v9.21.git.25.70d1e79`，来自维护者 COPR `dwmw2/openconnect` 的 mingw64 安装包。OpenConnect 为 LGPL-2.1，全文保存在 `bin/vpn/openconnect/LICENSE.openconnect.txt` 和 `LICENSES/upstream/`。GnuTLS、Nettle、GMP、libxml2、zlib 等 DLL 各有许可；不能凭名称猜定版本和完整许可，也不能使用 master 链接替代精确源包。当前缺少完整提取证据、版本和源码包，应按待核对处理。[OpenConnect 上游](https://gitlab.com/openconnect/openconnect)。
- **libcronet.dll**：现有文件与固定 Go 模块 `github.com/sagernet/cronet-go/lib/windows_amd64@v0.0.0-20260912104006-c10c03c318db` 中的 DLL 哈希相同（`3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928`），模块标记 Cronet `150.0.7871.63`。此事实缩小来源范围，不代表已补全 Chromium、NaiveProxy 及其依赖的版权、对应源码和构建材料。包装模块许可另保留在 `LICENSES/go/`。[构建仓库](https://github.com/SagerNet/cronet-go)。
- **内置规则 `.srs`**：现有四个快照需要补齐精确源数据、上游提交及转换命令。MetaCubeX/meta-rules-dat 的 [上游许可](https://github.com/MetaCubeX/meta-rules-dat/blob/master/LICENSE) 为 GPL-3.0，但这不能证明当前每个文件都来自同一快照或授权覆盖所有源数据。现阶段保留哈希并标记待核对，不伪造来源。

## 桌面与界面

| 组件 | 许可 | 提供方式 |
| --- | --- | --- |
| Electron | MIT；Chromium、Node.js 等另有许可 | 发行目录须保留 Electron 的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 等原文件。 |
| React、React DOM、scheduler | MIT | 生产依赖许可原文见 `LICENSES/npm/`。 |
| Lucide React 图标 | ISC | 原文见 `LICENSES/npm/`。BlueWing 自有图标权属由维护者另行确认。 |
| Vite、Tailwind CSS、PostCSS 等构建工具 | 各自包声明的许可 | 锁定在 `package-lock.json`，通常不作为应用运行依赖；不得删除源码中各自版权声明。 |

`npm run release:check` 校验可自动核验的文件和哈希；`npm run release:check -- --public` 还要求所有公开二进制发行材料与人工核对记录齐全。该工具不会自行授予第三方权利或生成法律结论。
