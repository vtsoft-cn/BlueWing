> 2026-11-03 安全修订：以下为早期设计记录。当前 `full` 只提供脱敏扩展诊断，不记录提交密码、验证码或 HTTP 正文；旧日志不会因升级自动消失。

# aTrust 登录诊断与上游问题核对

核对日期：2026-10-26。本文件不包含真实密码、验证码、Cookie 或设备会话。

## 实机结论

已在独立子进程中验证用户配置的网关：主密码认证成功、环境上报成功，随后 `authCheck` 返回 `75500503`，原文说明客户端未安装或当前属于 web-only 模式，不能添加可信终端。用户确认同一账号通过官方客户端的“示例企业认证”可正常登录。

因此当前失败点是终端识别/可信终端要求。不能用更换密码、随机切换登录域、修改分流规则解决，也不能把它统一显示为密码错误。没有完成该网关的原生登录兼容验证。

当前上游 `reportEnv` 上报 `endpoint.device.type = browser`，并使用 Linux 平台字段。单纯修改 User-Agent 或平台标识不能证明已完成终端登记，也不是本次实现的修复方法。

## 上游 issue 与代码证据

| 链接 | 核对结果 | 对 BlueWing 的作用 |
| --- | --- | --- |
| [#96](https://github.com/Mythologyli/zju-connect/issues/96) | 同样的 `75500503`；仍 Open；未给出公开修复 | 直接对应本机故障，不能宣称升级即解决 |
| [#120](https://github.com/Mythologyli/zju-connect/issues/120) | 同样卡在可信设备检查；已 Closed；评论建议试 nightly、提供网页登录抓包；关闭事件未关联修复提交 | 已关闭不等于本机网关兼容；当前源码和实测仍失败 |
| [#111](https://github.com/Mythologyli/zju-connect/issues/111)、[提交 d0b67ba](https://github.com/Mythologyli/zju-connect/commit/d0b67ba94c84f8008b6ec62b8c6bbdc654525316) | 增加 queryDevice/trustDevice/untrustDevice，要求已有成功登录的 client-data-file | 属于登录后的授信管理；不是首次登录前 `authCheck` 失败的直接补丁；当前 fork 已有这些 API |
| [#135](https://github.com/Mythologyli/zju-connect/issues/135) | Open，模拟客户端登录而非网页登录仍未勾选 | 支持当前实现存在客户端登录兼容缺口的判断 |
| [PR #157](https://github.com/Mythologyli/zju-connect/pull/157) | 尚未合并，指出调用者 context 被 session context 覆盖 | BlueWing 的 HTTP bridge 存在同类问题；独立修复，同时保留调用方超时和 VPN 会话取消；并非可信终端修复 |
| [PR #164](https://github.com/Mythologyli/zju-connect/pull/164) | 尚未合并，只补 auth-info 的 authId/subType 元数据 | 有助于后续精确显示认证信息，不会自动实现可信终端登录 |
| [#154](https://github.com/Mythologyli/zju-connect/issues/154)、[PR #159](https://github.com/Mythologyli/zju-connect/pull/159)、[PR #162](https://github.com/Mythologyli/zju-connect/pull/162) | 会话闲置失效、续期和真实应用流量保活方案仍在审查 | 是登录后的稳定性问题；不应在此次登录故障中混入未经验证的整组补丁 |

状态来自 GitHub 页面及公开 API；后续上游状态可能变化。未向维护者、群聊或其他外部人员发送任何用户信息。

## 本次改动

1. 对 `75500503` 使用独立错误码 `ATRUST_TRUSTED_ENDPOINT_REQUIRED`；展示阶段、服务端错误码和完整原始错误，支持复制。
2. 认证入口按网关返回名称显示在登录面板，缓存每个接入自己的入口列表。不会遍历入口尝试密码，也不会擅自把无效入口改成列表第一项。底层登录域和认证协议放入可展开的参数区。修改网关/协议使缓存失效。
3. 可以浏览其他接入配置，显式“切换并连接”才断开原 VPN；公网代理节点不随 VPN 接入切换。
4. 每个接入可选择诊断级别：
   - `off`：基础连接信息、原始错误。默认值。
   - `detail`：HTTP 请求路径、方法、状态和耗时；不记录请求查询参数、头和正文。
   - `full`：提交时的明文密码、验证码，加上原始 HTTP 请求/响应 URL、头、正文。不脱敏，仅保存在本机；不会捕获键盘输入过程或 SSH/业务 TCP 负载。
5. 日志在当前数据目录 `logs/vpn/<profile-id>.log`，JSON Lines 格式，约 10 MB 轮换，最多保留当前文件和 `.log.1`。HTTP 正文只捕获调用方实际读取的数据，每侧最多 256 KiB，超出时标记 truncated；不主动吞读响应。
6. 界面常驻提示完整诊断含明文凭据，提供打开、清空入口。验证码过期、旧代次、重复提交被拒绝时不会记成有效输入。普通应用日志、渲染层快照、凭据仓库仍不含明文密码。
7. 备份不会带出诊断文件；导出/导入配置都把诊断模式设为 off，避免在另一台机器自动启用凭据记录。关闭模式不会删除已有日志，清空会删除当前及轮换文件。

## 后续兼容路径

[官方 PC CSSDK 文档](https://bbs.sangfor.com.cn/atrustdeveloper/pcsdk/)说明第三方程序可通过 SDK 与已安装 aTrust 客户端后台进程通信，共享其认证和隧道能力。该方案仍在当前电脑运行，不需要虚拟机，但需要官方客户端组件，不能描述为已实现的无依赖原生模式。

建议将接入实现和 VPN 协议分开：`protocol=atrust` 下提供当前用户态实现和后续 `official-sdk` 适配器，界面名称为“原生接入”和“官方客户端兼容接入”。遇到可信终端要求时提供明确解释及兼容入口，不自动降级，不跳过网关检查。

本机已只读确认安装目录含 `aTrustAgent/aTrustSDK.dll`，PE Machine 为 `0x14c`（32 位），包含 `atrust_initial`、`atrust_sync_query_status`、`atrust_sync_login_by_pwd`、`atrust_sync_login_by_totp`、`atrust_sync_logout` 等导出名。与[官方 Windows 动态集成文档](https://bbs.sangfor.com.cn/atrustdeveloper/pcsdk/docs/3.Windows集成指南/3.2集成方式.html)的 DLL 名称和调用方式相符。但只检查了文件和符号，没有加载执行、初始化或发起官方客户端登录。64 位主程序不可直接载入该 32 位 DLL；后续应使用匹配位数且受控的辅助进程及明确的生命周期，而不是在 Electron 进程内硬加载。

正式开发前需获取官方 SDK 包、确认许可和版本匹配，验证状态查询、用户操作认证、取消/退出生命周期、动态端口和数据通道能力，以及官方客户端是否影响系统默认路由。官方隧道接通不等于 BlueWing 三种分流模式都已成立；必须分别验证公司资源、国内本机出口、国外代理出口、断线保护和退出恢复。不要读取/冒用官方会话 Cookie 或伪造设备授信。

## 验收

- 单元：完整模式准确记录提交值（保留空白/换行）；其他模式不记录输入；轮换/清空/路径校验；备份和导入不启用 full；旧代次与过期验证码不落入有效输入日志。
- 原生：请求/响应正文和 Cookie 原文保留，HTTP 调用语义不变；正文限长；调用方超时与原会话取消都生效；75500503 不归类成密码错误。
- Electron：认证名称选择与重开持久化、不同接入隔离、连接时只读、其他接入可浏览、显式切换；高级诊断选择、明显凭据提示、原始错误详情/复制、打开与清空；保持原有验证码隐藏/继续提交交互。
- 集成：现有 EasyConnect / SoftEther 及三种分流模式回归；不要为了诊断修改 Windows 默认路由。
- 实机：本次仅确认示例企业网关失败阶段。后续只有实际通过可信终端检查、资源获取、业务访问和断线恢复，才可把此网关标为支持。
