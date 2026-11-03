# BlueWing 全链路复查

后续修复及验证见 [修复记录](network-audit-fixes-2026-10-31.md)。本报告下文保留修复前的审查证据。

日期：2026-10-31。基线为当前工作区及 `release-network-robustness`，不是仅审查 Git HEAD。HEAD 为 `9bfa2da`，此前的修复尚有未提交改动。原生发行核心 SHA-256 为 `f1522877168699d13a9248c5cb3eb6d35b5ebcdbe540b326d22bad1fe2512650`。

本轮新增本报告和 `temp/` 内的隔离审查用例，没有修改产品逻辑、发行二进制、安装包或当前 Windows 网络设置。所有凭据用例均使用虚构账号和测试密码。没有登录真实公司 VPN，没有实际杀用户进程、执行升级卸载或重启电脑。

## 结论

发现 **8 类有可执行反例的问题、2 处安装器静态缺陷**；此外，上次已披露的大 ICMP 限制仍存在。最应优先处理的是大 UDP 完整链路、停止操作的取消语义、凭据身份和代理恢复的外部修改保护。

此前的原生进程隔离、用户态栈、明确公司资源优先及局部故障保护方向合理。主要设计问题在于跨模块边界没有采用相同的身份、取消和状态标准：资源身份已更新，凭据仍用另一套键；公司会话有代次，普通核心和传统引擎没有相同约束；应用运行时有代理所有权恢复，安装器仍有独立的硬编码清理；原生分片单测通过，但上游核心实际产生的报文没有被纳入回归。

## 1. [P1] 大 UDP 仍在完整链路丢失，上一轮分片修复不完整

位置：[重组校验](C:/project/BlueWing/native/vpn/internal/ipv4frag/reassembly.go:74)、[报文注入](C:/project/BlueWing/native/vpn/cmd/bluewing-vpn-core/proxy.go:56)、[UDP 包端点](C:/project/BlueWing/src/main/vpn/CorporateConfig.ts:59)。

新隔离实验运行随包真实 `sing-box.exe`、两条认证包链路、实际原生 gVisor NAT 和模拟公司链路。没有系统 TUN、系统路由修改或外网服务器。48 字节 ICMP、64 字节 UDP 均成功，并检查请求确实进入原生核心，排除了本地合成回复。

1500 字节 UDP（前端输入整包或分片均如此）和 3072 字节 UDP 失败。记录到 sing-box 公司包端点实际发来：

```text
1500-byte UDP: length=1276, ID=0, flags=0x6000; length=244, ID=0, flags=0x409d
3072-byte UDP: flags=0x6000 / 0x609d / 0x413a, ID=0
IPv4 header checksums are valid.
```

这些片同时含 DF 与 MF/片偏移。当前重组器拒绝它们，因此没有进入公司链路。仅在诊断 overlay 中去掉 DF 拒绝条件后，相同的 1500 和 3072 字节 UDP 均完整往返；其他产品源文件保持原样。这确认了失败的直接原因，不等于已修复产品。

不能直接把诊断改动上线。所有这些 UDP 片的 IP ID 都是 0；重组键又只有源地址、目的地址、ID、协议。并发同源同目的 UDP 报文仍有重组冲突风险，需要一起解决产生方的分片标志、标识和跨层契约。外部公司回包的严格校验也不应被一并放宽。

上次正式用例验证的是原生重组、NAT 和较大内存帧，未覆盖这条实际 sing-box UDP 输出路径。较大 DNS、认证协议或其他 UDP 业务可能受影响。这里实测的是具体隔离路径，不声称所有 UDP 请求均失败。

## 2. [P1] 普通核心在手动停止后仍会被旧启动重试重新拉起

位置：[启动重试](C:/project/BlueWing/src/main/index.ts:695)，特别是第 711～713 行；[停止入口](C:/project/BlueWing/src/main/index.ts:466)。

首次启动失败后，`handleCoreStart` 等两秒再启动。普通首页/托盘启动只传 `userInitiated`，没有传 `shouldContinue`。用户在两秒内点击停止，停止入口不会使该次启动意图失效；延迟结束后仍执行第二次 `core.start(config)`。

用例通过 TypeScript AST 提取并执行当前源文件里的真实 `handleCoreStart` / `handleCoreStop` 函数，控制重试延迟，不复制业务实现。停止完成时状态为 stopped；释放旧延迟后，启动次数变为 2，状态重新成为 running。

上一轮“断开全部取消队列”只修复了公司接入管理器，没有覆盖这个普通核心入口。应给启动、重试、排队重载和停止统一分配可取消的意图代次。

## 3. [P1] 传统 RAS 引擎的迟到回调能恢复已断开的状态

位置：[引擎回调](C:/project/BlueWing/src/main/system/vpn/VpnEngineManager.ts:217)、[断开实现](C:/project/BlueWing/src/main/system/vpn/VpnEngineManager.ts:271)、[RAS 网络查询](C:/project/BlueWing/src/main/system/vpn/RasVpnEngine.ts:186)。

RAS 已拨号、正在等待适配器网络信息时，用户断开。`disconnectInternal` 没有使 `profileId` 失效或增加连接代次；网络查询返回后，RAS 未再次检查 stopped，继续触发 `onConnected`。管理器只比对配置 ID，接受旧回调。

隔离用例使用真实 `RasVpnEngine` 和 `VpnEngineManager`，仅把 PowerShell、rasdial 和网卡查询替换为无系统副作用的测试端。断开先得到 disconnected；放行网络查询后变回 connected。相同 ID 的下一次连接也缺少区分新旧回调的代次。

原生公司接入的状态隔离和 React 快照修复仍通过，但传统引擎没有获得同样的保证。

## 4. [P1] 资源身份已隔离，保存的密码/会话身份仍可能串用

位置：[凭据键](C:/project/BlueWing/src/main/vpn/CorporateVpnSession.ts:221)、[密码读取](C:/project/BlueWing/src/main/vpn/CorporateVpnSession.ts:328)、[管理器的密码标记](C:/project/BlueWing/src/main/vpn/CorporateVpnManager.ts:92)。

三条独立反例：

- 同一配置、网关和账号从 `tenant-a.example.com` 改为 `tenant-b.example.com` TLS 服务名后，资源身份已经改变，但凭据键未包含服务名，旧密码仍被标记为已保存，并放入新连接命令。
- 用户名 `svc:ops`、登录域 `VPN` 与用户名 `svc`、登录域 `ops:VPN` 的键相同，因为字段未经编码就用冒号拼接。配置校验接受这些值；修改后资源身份不同，旧密码仍被读取。
- 主机 `2001:db8::1`、端口 443、用户名 `543:joe`，与另一主机 `2001:db8::1:443`、端口 543、用户名 `joe` 也产生同一个凭据键。两种 IPv6 主机均通过配置校验，属于不同服务器；隔离用例观察到旧密码仍进入新服务器的模拟连接命令。这里的 IPv6 地址为文档专用示例，未实际连接。

控制用例确认未改变身份时保存密码正常。两个反例只观察测试密码是否进入模拟控制命令，没有向真实服务器发送凭据。会话缓存使用同一种键构造，也需要纳入修复。

应统一使用无歧义的完整身份编码，并明确旧凭据迁移策略。不能只修复界面的“已保存”标记。

## 5. [P1] 恢复代理会覆盖用户后来设置的 PAC

位置：[恢复计划](C:/project/BlueWing/native/vpn/internal/winproxy/restore.go:32)、[守护的可恢复性判定](C:/project/BlueWing/native/vpn/internal/winproxy/recovery.go:111)。

Windows 可以在手动代理关闭后继续保存旧 `ProxyServer` 字符串。用户关闭手动代理、改为新公司的 PAC，此时连接可能为 `Flags=5`、`Server=127.0.0.1:2081`、`PAC=新地址`。

当前逻辑只根据 Server 字符串判断所有权，没有检查手动代理是否仍启用。隔离调用实际 `restoreConnections`，得到将该连接恢复为 Flags=1、PAC 为空的计划，覆盖了后来生效的新 PAC。

此前“外部把服务器地址改掉则保留”的测试通过，但不足以覆盖这种更常见的开关/PAC 修改。所有权应结合当前有效标志与配置事实判断。

## 6. [P1，静态确认] 升级器会按进程名结束其他软件的 sing-box

位置：[升级关闭流程](C:/project/BlueWing/build/installer.nsh:155)、[全局 taskkill](C:/project/BlueWing/build/installer.nsh:188)，第 191 行还有强制结束。

已有旧安装、BlueWing 主程序已经退出时，流程会跳过优雅退出等待，直接进入 `taskkill /im sing-box.exe` / `taskkill /f /im sing-box.exe`。没有按二进制完整路径、当前安装目录或已知 PID 限定。

因此“先退出 BlueWing 再升级”也可能结束其他代理软件的同名核心。主程序的孤儿核心清理已经按路径限定，安装器仍没有采用同一规则。

本项依据实际 NSIS 控制流及本机 `taskkill /?` 对 `/IM` 的定义确认。没有实际运行杀进程命令。

## 7. [P2] 主进程退出后的最后恢复失败不会重试

位置：[独立守护循环](C:/project/BlueWing/native/vpn/internal/winproxy/recovery.go:211)。

主进程存活时，守护每五秒重试；一旦 wait 返回父进程已经退出，守护执行一次恢复后便返回，即使恢复错误是临时的。

隔离用例让第一次恢复返回临时 WinINet 错误、第二次本可成功。实际只调用一次，守护直接返回错误。所有权文件虽然保留，但当前已没有继续重试的进程，恢复要等下一次登录或应用启动。这仍可能留下退出后断网窗口。

建议父进程退出后继续执行有上限的恢复重试，重新检查所有权和监听，不能靠删除记录表示恢复成功。

## 8. [P2，静态确认] 卸载仍绕过所有权恢复并丢弃恢复资料

位置：[卸载宏](C:/project/BlueWing/build/installer.nsh:363)。

卸载流程删除登录恢复入口，仅对根注册表的 `127.0.0.1:2080` 做直接关闭，然后删除 `%APPDATA%/BlueWingConnect`。它没有调用新增的所有权/原始快照恢复，也没有逐连接处理 RAS。

若已有残留代理、主程序和守护尚未成功恢复便卸载，实际端口为 2081 或其他端口时会漏清理；即使是 2080，也无法按原快照恢复用户 PAC。删除数据后，后续恢复资料丢失。

本项确认的是卸载兜底本身的缺口，不声称每次正常退出后卸载都会断网；未在用户电脑执行卸载。

## 9. [P2] 传统 WireGuard 档案在核心停止时也显示“已连接”

位置：[直接设置连接态](C:/project/BlueWing/src/main/system/vpn/VpnEngineManager.ts:175)、[页面状态映射](C:/project/BlueWing/src/renderer/pages/VpnAccess.tsx:188)。

WireGuard 分支检查必填项后直接设 connected，没有等待 sing-box 应用配置、创建端点或握手。隔离调用给出 `coreRunning=false`，返回的状态仍为 connected；页面用同一个状态显示“已连接”并计数。

至少应区分“已启用配置”“等待核心”“端点已就绪”“实际连接可用”，不能将保存配置等同于连接成功。本项是传统 WireGuard 档案，不是原生 SoftEther 的修复回退。

## 10. [P2] DNS 租约缓存没有硬上限

位置：[租约插入和清理](C:/project/BlueWing/native/vpn/cmd/bluewing-vpn-core/proxy.go:499)。

超过 8192 条后仅删除过期项。如果正响应尚未过期，缓存仍继续增长。隔离测试向同一插入路径提供 8320 个不同 IP 的有效正响应，保留 8320 条。

这是有界性反例，不代表实测发生了内存耗尽。长时间运行或高频动态 DNS 下需要实际容量上限、淘汰/更新规则，并维持授权关联语义。

## 已修复问题的复查结果

| 之前的修复 | 复查结论 |
| --- | --- |
| 关闭控制管道后仍完成本地断开和故障处理 | 原有边界回归通过 |
| 公司管理器取消尚未执行的排队登录 | 原有边界回归通过；普通核心重试和传统 RAS 仍有第 2、3 项遗漏 |
| 资源/目标缓存绑定完整身份、协议切换撤销旧包端点 | 原有边界回归通过；凭据仍存在第 4 项问题 |
| 多公司 DNS 允许/保护优先级、TCP/UDP 一致性 | 24 项集成测试通过 |
| SRV/TXT 转发、截断后向同一公司 DNS 进行 TCP 重试 | 原生回归通过；缓存容量另见第 10 项 |
| 代理端口移交保留新旧地址、失败不丢所有权 | 原有边界回归通过；PAC、最终恢复和安装器另有第 5～8 项问题 |
| 派生资源缓存损坏隔离及 BOM 读取 | 原有应用回归通过 |
| React 快照、页面切换、计数和原生公司状态隔离 | 真实 preload/React 冒烟通过；传统引擎另见第 3、9 项 |
| 原生分片权限、内存/时限、NAT 及较大内存帧 | 原生回归通过；完整 sing-box UDP 链路仍有第 1 项不兼容 |
| 真实 ICMP 转发 | 新隔离链路的小 ICMP 通过，检查了原生入口计数；没有本地合成回包冒充成功 |
| 大 ICMP | 2048 字节完整 sing-box gVisor 前端路径仍失败，和上次披露一致；不重复计为新发现 |

## 验证和复现

现有回归：应用 **199 项通过**、集成 **24 项通过**、原生测试通过、真实 preload/React 状态冒烟通过。它们与新增反例并不矛盾：缺少的就是上面这些边界。

新增隔离材料：

- [TypeScript 用例](C:/project/BlueWing/temp/vpn-third-audit.test.ts)：同身份控制通过；凭据身份三种反例、普通核心停止重试、RAS 迟到回调、WireGuard 假连接共 6 个失败。
- [WinINet 用例](C:/project/BlueWing/temp/third_winproxy_audit_test.go)：外部 PAC 和父进程退出后的恢复重试。
- [DNS 容量用例](C:/project/BlueWing/temp/third_dns_cache_audit_test.go)：正响应插入路径的容量。
- [真实 sing-box 包桥用例](C:/project/BlueWing/temp/third_packet_chain_audit_test.go)：小 ICMP/UDP 控制、1500/3072 字节 UDP 和已知大 ICMP。
- [原始 overlay](C:/project/BlueWing/temp/third-go-overlay.json)、[诊断 DF overlay](C:/project/BlueWing/temp/third-go-df-overlay.json)。后者仅为因果实验，不是可发布修复。

```powershell
npx tsx --test temp/vpn-third-audit.test.ts
node temp/write-third-go-overlay.cjs
node scripts/test-vpn-core.cjs -overlay=C:\project\BlueWing\temp\third-go-overlay.json -run=TestThirdAudit -count=1 -v
node scripts/test-vpn-core.cjs -overlay=C:\project\BlueWing\temp\third-go-overlay.json -run=TestThirdPacketChain -count=1 -v
node temp/write-third-df-overlay.cjs
node scripts/test-vpn-core.cjs -overlay=C:\project\BlueWing\temp\third-go-df-overlay.json -run=TestThirdPacketChain -count=1 -v
```

诊断时核对了发行 sing-box 1.14.3 所用的 [WireGuard 输入大小判断](https://github.com/SagerNet/wireguard-go/blob/6731c7387c81/device/send.go#L464)、[Windows 缓冲常量](https://github.com/SagerNet/wireguard-go/blob/6731c7387c81/device/queueconstants_windows.go) 及 [sing-tun ICMP 转发](https://github.com/SagerNet/sing-tun/blob/bca4bf029237/stack_gvisor_icmp.go)。这些上游依据用于解释已知大 ICMP 限制；大 UDP 的 DF/MF 结论来自本轮运行所携带二进制的实测记录。

未验证范围：真实重启/断电、安装升级/卸载对真实注册表的执行、长期高并发、多物理网卡漫游、真实 AD/大 UDP 业务及其他 VPN 提供商真实网关。因此本报告不宣称软件其他部分已经被证明无问题。
