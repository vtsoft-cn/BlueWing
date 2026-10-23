# 给 GLM 的开发交接与分阶段实施计划

日期：2026-10-23。目标仓库：BlueWing；基线提交 `88226cb`。先读[详细设计](corporate-vpn-integration-design.md)，再读[测试与验收](corporate-vpn-test-plan.md)。本文定义开发步骤，不代表已经实施。

## 1. 可以直接交给 GLM 的首条指令

```text
请在当前 BlueWing 仓库中开发内置企业 VPN 功能，同时支持 EasyConnect 与 aTrust。
先完整阅读 docs/design/corporate-vpn-integration-design.md、
docs/design/corporate-vpn-test-plan.md 和本文件。

目标：BlueWing 自己负责两协议的登录、MFA、核心进程、资源和公司DNS；
sing-box统一分流，公司目标走企业隧道，国内域名/国内IP直连，其余继续原公网代理。
单个软件交付，不依赖外部EZ4Connect、虚拟机、Docker或官方客户端过滤规则修改。
正式完成要包括TUN下无需逐应用代理设置的curl、SSH和浏览器。

按P0到P6逐阶段实施。先检查真实代码和固定版本核心，不臆造上游API。
先完成P0兼容性实验和接口约定，再写登录页面。
认证、进程、DNS、资源、路由、备份和打包都要交付，不能只加一个SOCKS节点或协议下拉框。

公司连接/断开不能切换公网activeNodeId，也不能每次重启sing-box。
公司目标和公司DNS失败时不得回落公网/物理DIRECT。
绝不把密码、OTP、会话、设备签名密钥写入argv、普通日志或普通备份。
EasyConnect与aTrust都要有各自的能力矩阵、模拟测试和真实验收结果。
没有实机aTrust网关时标明BLOCKED，继续完成能做的开发与模拟测试，不伪造PASS。

保留已有改动，不重构无关页面，不升级框架，不碰我的真实网络配置来跑默认CI。
真实账号/MFA由我在本机输入，测试夹具只用示例值。
新增测试必须加入实际测试入口，Windows和安装包验收必须记录版本、PID、出口与规则revision。

每阶段报告：改了什么、验证命令、结果、剩余限制、下一阶段。
如果核心能力与文档假设冲突，提交证据与ADR；不要悄悄降级需求。
先开始P0；后续按验证结果继续。远端推送、发布安装包由我另行指示。
```

若 GLM 不能直接读仓库文件，把三份文档作为附件一起给它，不要只贴上面几行概述。

## 2. 先明确的交付边界

| 项目 | 首版必须 | 不可冒充完成的替代品 |
|---|---|---|
| 两协议 | EasyConnect与aTrust有真实认证适配器 | 同一登录函数只改protocol字符串 |
| 核心 | 自己打包和管理，结构化认证/状态协议 | 让用户先启动EZ4Connect再连11080 |
| aTrust | 认证发现、登录域、密码、短信/挑战、会话 | 把所有网关写死为Radius/密码登录 |
| 分流 | 固定企业优先层、国内直连保留、公网选择保持 | 告诉用户关国内规则或手工改JSON |
| DNS | 公司Hosts/公司DNS在两核心间一致、失败不出公网 | 只加Windows hosts或只加BlueWing Hosts |
| 全应用 | M2完成sing-box TUN与防回环 | 用显式 -x curl成功冒充无参数curl成功 |
| 状态 | 认证、端点、隧道、策略、资源各有证据 | 只看进程存在/监听端口就显示已连接 |
| 交付 | 安装包、构建来源、测试报告、回滚 | 只在开发机npm dev下运行 |

首版默认同一时刻一个公司会话在线；可以保存两协议多个配置并切换。多公司同时在线是独立迭代，不在首版里顺便承诺。

## 3. P0：代码审计与技术验证

### 3.1 阅读与记录

- 检查当前提交/脏文件、项目或上级AGENTS要求，记录Node/npm/Go/Windows版本。
- 阅读现有ConfigGenerator、SingBoxManager、ProxySelectionService、SystemProxy、TakeoverLinkage、Database、backup、preload及App状态订阅。
- 记录现有80项测试基线，以及开发依赖/二进制是否真正完整。
- 拉取并固定zju-connect v1.3.1对应的commit SHA；核对Go版本、Windows构建、两协议认证与资源接口。
- 核对AGPL/GPL与当前产品分发方案，形成许可证材料清单；此项约束发布，不要求停止所有原型研究。

### 3.2 必须先回答的问题

1. 如何把上游认证输入改成可取消的回调，密码不进入命令行？
2. 如何拿到两协议资源、DNS和aTrust认证方式，而不是从人类日志猜？
3. 如何为公司出口实现严格隧道拨号，移除未匹配/DNS失败的DIRECT后备？
4. 固定sing-box 1.14.3在Windows上能否可靠观察本地rule-set更新，并保持公网连接不断？
5. 路由/DNS两个集合的更新先后如何做到失败时不泄漏？
6. 企业核心崩溃后能否复用原本机端口/内部认证，不改公网selector？
7. aTrust ClientData能否以内存输入/输出接入保险库，避免明文session文件？
8. TUN下物理网卡绑定和aTrust多线路底层网关排除怎样验证？

### 3.3 P0产物与退出条件

产物：`docs/adr/xxxx-corporate-vpn-core.md`、核心能力矩阵、固定版本manifest草案、本地watch实验记录、错误与挑战协议草案、许可证分发决策记录。

退出条件：测试计划5.1/5.2的可自动实验有证据；关键不可行项有ADR，不以假的热重载API搪塞。没有可行的长连接隔离方案时，明确阻塞R07并提出可评估方案。

## 4. P1：模型、协议与核心适配

### 4.1 TypeScript侧

1. 新增corporateVpn类型与主进程IPC DTO，配置、机密、状态严格分开。
2. 实现配置校验、网关规范化、端口租约和副本保存。
3. 实现VpnCoreProcess：参数化spawn、隐藏子进程控制台、增量UTF-8帧、大小限制、超时和取消。
4. 核心通道只公开类型化命令；渲染层不能传任意命令参数或指定任意文件路径。
5. 写fake core和协议测试，覆盖拆帧/粘包/旧事件/异常退出。

### 4.2 Go侧

1. 在固定fork新增`--control=stdio-json`模式，保留原CLI入口以便对照。
2. 在Go认证层引入AuthProvider，不把stdin同时交给普通fmt.Scan和JSON控制器。
3. 实现EasyConnect与aTrust两套provider适配，统一命令/事件，保留协议特有能力。
4. 导出规范化资源与DNS、aTrust认证方式和受保护会话事件。
5. 维护一个核心进程、多个本地端点、一个活动企业会话；离线端点明确拒绝。
6. 实现tunnel-only拨号；公司失败无DIRECT后备。增加默认TLS验证与CA/pin配置入口。
7. 主进程EOF、取消和shutdown有界收尾；停止会话与退出服务进程是不同操作。

退出条件：U01/U02/U03/U11/U12、B01～B03、B12和fake握手测试通过；真实认证能力尚未完成时不能连同UI宣称可用。

## 5. P2：认证编排与保险库

1. 实现CorporateVpnManager状态机、用户意图、generation、重连与取消。
2. 完成EasyConnect密码、手工OTP、图片挑战流程；明确OTP与TOTP种子分别是什么。
3. 完成aTrust discoverAuth、选择loginDomain/authType、密码、短信、结构化/图片挑战。
4. 浏览器/CAS作为独立能力接入；没有验证的SSO类型不自动猜测实现。
5. 完成DPAPI保险库与内存连接模式，禁止新VPN机密沿用Base64持久化降级。
6. aTrust设备会话以opaque数据在Go与主进程间流转；没有“记住”时不持久化。
7. 接入认证UI，但此时“已连接”仍需后续端点/策略就绪条件，不能提前置绿。

UI支持的字段来自发现/能力结果，不能展示所有高级字段后要求用户自行拼CLI。短信发送和重新信任设备都保持用户明确动作。

退出条件：U08/U11、B04～B10通过；B11按可用环境记录。测试账号错误不触发无限重试，取消不留下登录任务。

## 6. P3：公司路由、DNS与公网长连接隔离

1. 在ConfigGenerator新增受管企业运行上下文参数，保留旧调用兼容及旧测试。
2. 在公网启动时注册已保存配置的固定内部出站和route/DNS本地rule-set；企业出口不进入公网selector与测速。
3. 发布活动公司集合与所有已知公司目标保护集合；inactive/撤销资源失败关闭。
4. 把企业匹配放在国内、私网与应用代理规则之前；保留显式阻止语义。
5. 通过固定本机DNS-over-TCP服务处理公司查询；将公司Hosts同步到企业核心，不写Windows hosts。
6. rule-set publisher实现候选校验、watch更新、失败回退和appliedRevision证据。
7. 正常公司连接/断开/认证/资源刷新不调用SingBoxManager.start/restart。
8. 首次新建profile或变更端口需要顶层重配时，SaveResult返回`requiresCoreRebuild`与原因；在设置应用流程安排一次明确重连，不伪装热更新。
9. 内置诊断通过目标所属profile/出口测试，不使用主机默认DNS和默认代理得到误导结果。

退出条件：U04～U07、I01～I12及F03/F04/F06通过；公网长连接测试明确断言PID、selector和连接ID不变。

## 7. P4：Windows代理与TUN全应用

1. 修复SystemProxy的WinINet连接级设置/查询，保存实际flags/PAC/bypass，回读校验和恢复所有权。
2. 修复压平here-string与过短Add-Type超时；不要依赖先前人工修正过的本机缓存。
3. 公司模式检查广泛私网bypass、`<local>`及自定义绕过冲突；其他LAN通过sing-box DIRECT保留。
4. 继续使用TakeoverLinkage，不新增第二套系统代理写入者。
5. 企业核心禁用自身TUN/添加路由功能，底层网关绑定真实物理出口并排除TUN捕获。
6. 清理继承代理环境变量；验证aTrust新线路在拨号前已进入排除策略。
7. 按现有用户提权流程启用sing-box TUN，保留取消语义、管理员/非管理员一致数据位置。
8. 完成普通curl和原生SSH，不给它们额外指定代理；同时验证Edge、国内、本地LAN和公网。

退出条件：W01～W09、F01/F02/F05/F07通过。缺少普通curl/SSH的TUN实测只能标M1完成，不能标整个集成完成。

## 8. P5：产品UI、迁移、备份和打包

1. Sidebar/App新增“公司VPN”，首页同时显示公网与企业状态，两个连接按钮语义独立。
2. 新增资源、DNS来源、规则revision及诊断页；错误提示按层级，不给所有失败套一个“连接失败”。
3. 备份升级与旧版本兼容：明确企业分类，修复当前Windows备份丢DNS的解析链路。
4. 多文件导入事务有journal；导入成功广播不等于已应用；返回保存/应用状态。
5. 迁移现有外部SOCKS配置时只读取用户主动选择的非机密字段，不扫描EZ4Connect明文密码。
6. 打包Go核心、manifest、hash、许可证和对应源码信息；对更新与回滚进行实际验证。
7. 常规退出/安装器`--bb-shutdown`/崩溃/睡眠恢复均接入统一停止与所有权恢复。
8. 检查中文、长配置名和最小窗口宽度；认证弹窗不会被后台日志推送挤掉或反复弹出。

退出条件：U09/U10、W10、F08、R04通过。使用真正安装包验证，不依赖源码运行或外部11080服务。

## 9. P6：实机回归与最终交付

按测试计划分别完成EasyConnect、aTrust的系统代理与TUN验收。敏感地址和账号由本机验收表填入；没有环境的认证方式标BLOCKED并限制发布能力说明。

最终交付清单：

- [ ] 两协议实现及固定核心源码/构建；没有只针对某一个网关写死。
- [ ] 所有新增测试已加入实际执行入口；原基线保持通过。
- [ ] 机器可读报告、真实Windows证据、能力矩阵与失败项。
- [ ] 真实GPT/Codex并行使用记录，而不只测一个公网HTTP状态。
- [ ] 安装包、升级/回滚说明、非机密配置样例、日志脱敏验证。
- [ ] 许可证和来源材料齐全，发布方式已确定。
- [ ] 用户仅打开BlueWing即可认证和分流；不再依赖EZ4Connect/修复脚本。
- [ ] 已说明已知边界：未知私有DNS、地址冲突、未验证SSO、ICMP和第三方DoH。

## 10. 建议的代码改动检查表

| 区域 | 具体检查 |
|---|---|
| ConfigGenerator | 固定企业优先层、保护集合、独立DNS集合、内部出口从公网selector排除 |
| SingBoxManager | 企业状态变化不触发start；全量重配仍有校验、互斥与可见结果 |
| ProxySelectionService | 公网selector/activeNodeId不被企业核心事件改变 |
| main/index + 新VpnIpc | 白名单、sender校验、并发意图、应用结果、退出清理 |
| Database + VpnProfileRepository | 同一dataDir，主库兼容，sidecar原子保存和跨文件恢复 |
| CredentialVault + LogManager | 严格加密、状态锁定、进入日志前脱敏、liveConfig脱敏 |
| SystemProxy | option75连接级同步、PAC/自动检测快照、实际浏览器验证 |
| backup链路 | 编解码/预览/事务/广播/应用全链路与分类测试 |
| Renderer | 两协议字段、验证码/短信交互、来源/状态明确、订阅解除 |
| packaging | 核心固定版本和自包含、SHA、签名/许可证、安装后实测 |

## 11. 开发与验证命令

以下已有命令可先执行：

```powershell
npm ci
npm test
npm run build
git diff --check
```

新增测试命令在实现中明确注册，例如`test:vpn`、`test:vpn:integration`、`test:vpn:windows`；**它们当前并不存在，不能在报告里假称已运行**。Windows实机命令必须显式选择，不归入默认npm test。

Go命令以最终fork布局为准：固定工具链、`go test`对应包、Windows x64构建；支持race的CI环境再执行race测试。不要在不知道Go构建标签和平台限制时假写“跨平台全过”。

Electron依赖安装不保证其运行时下载成功。优先让纯Node测试通过隔离fixture/mock脱离GUI运行时下载，真正Electron和安装包测试另跑；缺少二进制要明确报告，不能把代码编译通过当安装包可运行。

## 12. 阶段报告模板

```text
阶段：P?
当前commit / 固定核心commit / 二进制hash：
完成内容及文件：
新增/修改接口：
验证命令及PASS/FAIL/BLOCKED数量：
EasyConnect实机能力：
aTrust实机能力：
公网长连接与公司流量隔离证据：
数据/凭据/备份/回滚影响：
未完成与原因：
下一阶段：
```

失败项要带可复现步骤和层级；不写“应该没问题”。没有执行的步骤一律NOT_RUN，等待真实网关/认证时用BLOCKED，继续完成不依赖它的工作。
