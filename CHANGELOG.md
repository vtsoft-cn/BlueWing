# 青翼连接 BlueWing Connect 更新日志 (CHANGELOG)

## [未发布]

### 🔍 可诊断性与配置健壮性
- 修复"节点 ping 通但不可用"被掩盖:HTTP 延迟探测失败时旧逻辑回退 TCP ping 并把 TCP 时延当代理时延展示,代理通道真实故障(如 REALITY 握手失败)被完全遮蔽——本次故障即节点域名被 Cloudflare CDN 接管、REALITY 无法穿透,但界面全部显示正常。现 testLatency 返回结构化结果(时延/探测路径/失败原因),仅"核心未运行"才回退 TCP 并明确标注"TCP 兜底(不代表代理可用)";失败原因按 REALITY/TLS/超时/域名解析/拒连归类,REALITY 类直接提示"节点域名可能被 CDN(如 Cloudflare)接管,可将节点地址改为服务器 IP 试探"。单节点测速弹窗新增红色警示横幅,测速中心卡片/表格以"HTTP 握手失败"徽标+悬停原因呈现。
- 修复本地规则文件缺失时的远程规则集回退配置无法启动:回退生成的远程 rule-set 同时携带 `http_client` 与 sing-box 1.14 已废弃的 `download_detour`,核心启动即 `FATAL: http_client is conflict with deprecated download_detour field`(且 `sing-box check` 校验不出,仅运行时暴露,实测复现);现移除 `download_detour`(default http_client 本就直连下载,行为不变),附回归单测强制走回退路径断言无冲突字段。

### 🛡 数据与稳定性
- 修复「以管理员重启后应用像没启动、且界面回到旧配置」——数据目录随提权状态脑裂:数据目录解析用"安装目录是否可写"判定便携模式,而管理员令牌恰好让 Program Files 变得可写,提权实例遂切到安装目录 data/ 里安装器暂存的**旧数据**(%APPDATA% 的真实新数据被晾在一边,实测:提权后界面 TUN/节点全回到旧状态,且用户误报"程序没启动"——UAC 等待约一分钟后应用其实已带着旧数据起来)。现便携模式改为显式粘滞:选择便携目录时写入 `.portable-mode` 标记,此后提权与否都稳定便携;无标记时提权运行一律沿用 %APPDATA%(不由临时可写性改变数据归属),仅标记机制引入前的老便携用户在提权且 %APPDATA% 为空时按搁浅恢复接续、绝不空窗;换装前向迁移照旧仅非提权时发生并落标记。提权判定抽为 system/Elevation.ts(数据目录解析在启动最早期,不得牵扯核心依赖)。附 5 项提权语义回归单测(暂存残留回退/标记粘滞/老便携搁浅接续/便携选择落标记/迁移落标记)。
- 非管理员下开启 TUN 改为应用内自定义弹窗引导提权(不使用系统原生对话框),不再静默跳"三步舞":此前普通权限运行时开 TUN,会依次发生"联动关系统代理→核心重载(断开)→TUN 因权限被剥除→兜底又把系统代理打开"——用户看到的就是"代理断了重连,系统代理又自己开了",开关形同失灵(日志实证:TUN 已开启,系统代理已联动关闭→…→TUN 因权限不足未生效,已自动开启系统代理兜底)。现三条入口统一:设置页/Dashboard 开 TUN 前预检权限,非管理员直接弹应用内确认框(与全局 ConfirmDialog 同一套自定义样式);"以管理员身份重启"经新增 `tun:enableElevated` 落库(含互斥联动)并走提权重启;托盘勾选则唤醒主窗口触发同一弹窗;主进程侧保留兜底拦截(绕过预检的保存会被还原并发 `tun:elevation-required` 事件唤起弹窗)。取消则完全不开启 TUN、现状不变。剥除兜底仅保留给非交互路径(开机自连、提权被拒后的重启等),那些场景下保住连接仍是对的。
- 修复「以管理员身份重启」后应用退出却不再启动(三重根因,层层剥开):①守候 PowerShell 被本应用连带杀死——Electron 在 Windows 上以 kill-on-close 作业对象管理子进程,应用一退出,任何直接 spawn 的子进程立即被终止(实测:子进程心跳在父进程退出瞬间戛然而止,守候脚本只来得及写下"relaunch begin"再无下文;纯 node 环境验证存活曾掩盖此差异);②spawn 曾用 detached:true,DETACHED_PROCESS 让 PowerShell 这类控制台程序拿不到控制台与标准句柄启动即死(矩阵实测四种组合全灭,改 windowsHide 非 detached);③守候等待仅 15s 且单实例锁失败即静默退出。现守候脚本经一次性计划任务承载(Register-ScheduledTask cmdlet + EncodedCommand 注册,绕开 schtasks /tr 引号与长度限制;任务进程由任务计划程序服务拉起,完全独立于应用作业对象),注册触发完成(应用尚存活)后才退出;守候等待上限 60s 且每步留痕 `logs/elevate-relaunch.log`(UAC 被拒记录原因并回落普通权限重启);单实例锁失败改每秒重试最多 10s。启动早期另增 boot.log 黑匣子面包屑(数据目录解析/锁获取与重试/--bb-shutdown/异路径实例检查/窗口创建,每行带 pid+admin 态)——注:管理员账户且 UAC 策略 ConsentPromptBehaviorAdmin=0 的机器为静默提升,重启无任何弹窗属正常而非故障。
- TUN 与系统代理改为互斥联动(用户预期"二选一",完整单选语义):切换任一侧联动拨另一侧——开 TUN 自动关系统代理(TUN 已全量接管,系统代理冗余);连接中关 TUN 自动开系统代理(避免两种接管方式同时为空);**TUN 开着时开系统代理自动关 TUN**(反向联动,否则两侧各自开一次就回到双开);关系统代理不反向拉起 TUN(关代理是"停止接管"的手势,静默开 TUN 出乎意料且无管理员权限时只会被剥除)。空闲时关 TUN 不联动开代理(否则会触发"开代理自动连接"把用户吓一跳,由首页"已连接但未接管"横幅兜底)。联动只在用户切换开关的那次操作发生,核心重载路径仍绝不触碰开关;设置页与托盘两条路径行为一致,联动后回推 `settings:changed` 同步界面。
- 兑现「TUN 权限不足时安全回退系统代理」的承诺:此前非管理员运行时核心剥除 TUN 入站并宣称"已安全回退为系统代理模式",但若系统代理开关恰好是关的(互斥联动后常态如此),这句日志是空话——流量实际无任何出口。现启动后检测到 TUN 被剥除且代理为关时自动开启系统代理(注册表+设置+广播),托盘连接路径同样覆盖;附互斥联动纯函数 5 项回归单测。
- 修复「连接中关闭系统代理被自动重新打开」:"连接意图保护"(自动补开系统代理)无法区分"用户显式发起连接"与"设置/规则变更触发的核心重载"——连接中关闭系统代理后,任何分流规则/DNS/设置变更引发的核心重载都会把代理强制重开并写回数据库,且不通知渲染层,造成注册表实际"开"、界面显示"关"的状态错位;纯系统代理开关变化还会被误当作核心重载条件,关闭瞬间核心无谓重启一次、所有连接瞬断。现补开判定抽为纯函数 `SystemProxy.shouldAutoEnableSystemProxy(userInitiated, settings)`,仅点连接/重启连接/开机自连/托盘"立即连接"等用户显式动作才允许补开,重载路径绝不触碰用户的代理开关;核心重载条件移除纯代理开关项(它只改注册表,与核心配置无关);主进程侧改动设置后统一广播 `settings:changed`(补开路径/托盘连接/备份导入),消灭 UI 错位;首页新增「已连接但系统代理与 TUN 均未开启:流量不经节点」琥珀色提示,避免空转连接被误认为已走代理。附 4 项回归单测。
- 修复「界面已切换节点、核心仍走旧节点」导致的全网络极慢:节点热切换失败时(如订阅刚导入、新节点尚未在运行中的核心里)会走"安全重载核心"兜底,但 sing-box 的 `cache_file` 会跨重启恢复上次持久化的选择器状态,静默覆盖配置中的 selector default——重启后核心继续用旧节点,而界面显示的是新节点,旧节点不可用时表现为"换了节点依然极慢/不可用"且无任何报错(线上实证:切至 AnyTLS 节点后核心仍走 vtsoft.cn:443 死节点,单连接 1~15 秒、批量超时)。现核心就绪后自动按应用记录的活跃节点校正选择器(Clash API GET 比对、不一致才 PUT,带 10×300ms 重试等待 API 就绪,不阻塞启动);附回归单测(模拟缓存残留选择被校正、已一致时不重复下发)。
- 修复「开启代理后全部断网」:CDN(IP 直连)节点缺失传输 Host 时,sing-box 以裸 IP 作 WebSocket 升级的 HTTP Host,被 Cloudflare 一律以 403 (Direct IP access not allowed) 拒绝——实测同 IP 同端口 Host 为域名即 101 握手成功、Host 为 IP 精确复现 403,且测速仅计时不校验状态码,403 响应(约 600ms)被记为正常延迟,节点"看着活的实则全断"。现 ws / httpupgrade(xhttp) / http 传输的 Host 统一在生成期回退 SNI(`transportHost || sni`),订阅未携带 host 参数或旧版导入的无 transportHost 节点无需重新订阅即恢复可用(已用生产配置打补丁实测:同节点补 Host 前 100% 403、补后 gstatic 204 / Google 首页正常拉取,0 错误);附回归单测。
- 修复代理节点不可用时国内网站也全断:应用分流的进程规则(如 msedge.exe → 代理)此前先于 geosite-cn / geoip-cn 国内直连规则生成,按首条命中即分流,浏览器访问国内站也被强制送去代理,节点一挂连百度/Bing 中国都打不开(线上日志实证 cn.bing.com、assets.msn.cn 全走 vless 出站 403)。现规则顺序调整为:DNS 劫持/广告拦截/局域网直连 → 进程"阻止"(必须最先,不被任何直连规则绕过) → 自定义域名规则 → 国内直连兜底 → 进程代理/直连——应用分流只接管未命中域名规则的流量;附回归单测,核心日志实测 baidu.com 走 direct、example.com 经代理,应用分流页文案同步说明优先级。顺带防御:取不到有效进程名的应用规则此前会生成无匹配条件的规则(等价于匹配全部流量),现直接丢弃。
- 修复安装到不可写目录(如 `C:\Program Files`)时核心启动即崩溃的问题:sing-box `cache_file` 未指定路径,默认在工作目录(安装目录)创建 `cache.db`,普通权限写入被拒导致 `FATAL: initialize cache-file: Access is denied`,表现为无法连接代理;现显式指向应用数据目录(`BLUEWING_DATA_DIR/cache.db`),并附回归单测。
- 数据目录改为"跟随安装位置"并自动迁移:从 Program Files(数据在 %APPDATA%)换装到其它位置时,启动即把 %APPDATA% 整目录(含配置与 Chromium 用户资料)迁入安装目录 data/ 并删除 %APPDATA% 原目录,数据与程序同在、不留副本(此前为粘滞沿用 %APPDATA%,会残留旧目录);迁移失败则安全回退沿用 %APPDATA%,绝不丢数据。
- 修复反向换位(可写目录重装到 Program Files)的数据搁浅:安装器把旧数据还原到新安装目录 data/,但普通权限不可写、应用回退 %APPDATA% 时读不到——表现为配置"丢失";现启动时检测该场景(回退目录无数据库而安装目录 data/ 有)自动把用户数据(数据库/回退/核心配置/规则缓存/日志)迁移到 %APPDATA% 接续使用;解析与迁移逻辑抽为 system/DataDirResolver.ts 并附 6 项回归测试。
- 修复连接后反复"自动中断-重连":内置分流规则集(.srs)此前并不随包分发(`bin/rules` 为空),核心启动时全部经远程 CDN(jsdelivr)下载,CDN 被重置即 FATAL 退出、应用重试再失败循环(直连下载也不可救,CDN 直连同样被掐);现将 geosite-cn / geoip-cn / geosite-category-ads-all / geoip-private 四个基础规则集内置安装包(`bin/rules/` 随 extraResources 落地 `resources/bin/rules`,共约 0.5MB,已入库存档),核心启动零网络依赖;远程规则集另增加 `download_detour: direct`(自定义 geo 规则仍需下载时直连),并配合既有 `experimental.cache_file` 缓存。
- 安装器盘符根目录防护与提示:选根目录(如 C:\)时 NSIS 原生禁用"安装"按钮且无任何说明(用户此前报的"无法安装/无法点击"即此),现目录页顶部新增明确提示"不支持盘符根目录,选择任意文件夹后会自动创建 BlueWing Connect 子目录";同时保留目录页 LEAVE 钩子弹窗拒绝作为兜底(经 dist-wrapper 模板补丁注入,函数在 build/installer.nsh),即使按钮可用也绝不安装到根目录(安装段自动追加应用名子目录)。
- 系统代理清理健壮性:①所有权文件(proxy_ownership.json)解析容错剥离 UTF-8 BOM——外部工具/编辑器写入的带 BOM JSON 会导致 JSON.parse 失败、所有权被误判为 null,代理清理与还原全部静默跳过(本次自动化验证中实测暴露);②disable() 关闭系统代理时顺带清除死回环地址——仅当注册表 ProxyServer 精确等于本应用受管服务器时删除,不触碰用户自有代理,杜绝禁用后注册表残留 127.0.0.1:<port> 死值。
- 修复已安装后再次打开安装包时窗口闪现且安装界面不出现:①安装器信号实例(--bb-shutdown)在无运行实例时会作为首实例启动完整应用造成主窗一闪而过——现在首实例检测到 --bb-shutdown 参数立即退出,绝不显示窗口;②信号脚本从 cmd(可见控制台闪现)改为 VBS(wscript 无窗口),彻底消除安装过程中的任何可见闪窗。两场景实测:应用运行中/未运行,均零闪窗、向导正常出现。
- 修复应用运行且代理开启时重装,应用退出但系统代理残留断网:两重成因——①关闭运行实例的逻辑只在"数据暂存"分支被调用,per-machine 装在 Program Files 时数据在 %APPDATA%、旧目录无 data/,该分支不执行,运行实例被 electron-builder 模板自带的"应用正在运行"对话框强杀(实测日志无任何优雅退出记录);现只要检测到旧安装即无条件先关闭运行实例;②提权安装器(perMachine,UAC 后高完整性)直接启动 `--bb-shutdown` 信号进程会继承管理员完整性,与普通用户实例的单实例握手失败——信号改经一次性计划任务以登录用户(中等完整性)身份发起(命令写入 $PLUGINSDIR 脚本避免多层引号转义),另加强杀兜底:taskkill 后检测到特征值代理(127.0.0.1:2080)残留时禁用清空并 WinINet 广播刷新,不触碰用户自有代理。端到端实测(应用运行+无暂存场景):安装器启动即触发优雅退出,"还原系统代理→停止核心→恢复原始配置"完整落日志。
- 手动卸载清理用户数据与系统代理:数据目录回退位置 `%APPDATA%\BlueWingConnect` 此前从不随卸载删除(electron-builder 自带的 deleteAppData 清理按产品名/包名匹配目录,与本应用实际目录名不一致,开了也删不到),且曾因 `!ifdef BUILD_UNINSTALLER` 块被误嵌在 `!ifndef` 内成为死代码(已修正嵌套并经标记文件实证);现正式手动卸载时经 `customUnInstall` 钩子一并删除 `%APPDATA%` 数据与同级遗留的 `BlueWingDataUpgrade` 暂存,并清理应用开启后残留的系统代理(仅特征值 127.0.0.1:2080 精确匹配时禁用清空,WinINet 广播刷新,不触碰用户自有代理)——修复"开着代理卸载,卸载完成后系统代理仍开启断网";升级流程触发的旧卸载器带 `--updated` 标志,此时严禁删除(数据正被保全流程使用)。
- 安装器改为固定「为所有人安装」(`perMachine: true`):移除安装模式选择页,双击启动时一次性 UAC 提权(manifest `requireAdministrator`),向导自始至终只出现一次(欢迎 → 选择安装位置 → 安装 → 完成),消除原"选所有用户 → 下一步"时向导关闭重开(UAC 内外实例切换)的割裂体验;头图对称边距逻辑相应改挂欢迎页 SHOW;启动即为管理员,数据保全的"以管理员身份重新运行"弹窗在此模式下不再出现(保留兜底)。
- 安装器"为所有人安装"路径三处修复:①升级死锁——旧版为 per-machine 安装(位于 Program Files)时,非管理员运行的安装器对 data/ 暂存改名必然因无写权限失败,原提示"目录仍被占用"并陷入重试死循环;现检测非管理员时明确提示并以管理员身份重新运行安装器(提权实例自动完成暂存),已实测新弹窗与文案生效。②下一步按钮异常图标——electron-builder 模板在选择"为所有人安装"且非管理员时向下一步按钮发 `BCM_SETSHIELD` 显示 UAC 盾牌,但 NSIS 安装器无 comctl32 v6 清单,按钮按旧样式渲染出多余且与文字重叠的图标;构建期模板补丁改为不显示盾牌。③提权后点"上一步"安装器直接退出——UAC 内层实例以 Abort 跳过安装模式页,从目录页回退会再次触发跳过并被一路跳过到无页可退;补丁在跳过时同时禁用上一步按钮。②③经 `scripts/dist-wrapper.js` 以精确锚点在每次构建时幂等打补丁(锚点失配即构建失败,防止 electron-builder 升级后静默失效)。

### 🏷 品牌更名
- 系统称号统一为「青翼连接 BlueWing Connect」:窗口标题、托盘提示与菜单、侧边栏/关于页、各类弹窗与日志文案全部更新;打包产物同步更名——`productName` 改为 BlueWing Connect(安装目录与 exe 随之更名),快捷方式名 `BlueWing Connect`(英文名,安装后不再显示中文快捷方式名),安装包 `BlueWingConnect-Setup.exe`,测速 User-Agent 与 TUN 虚拟网卡名(`BlueWingTun`)一并更新。
- 旧标识彻底清除(不做旧数据迁移):`appId` 更名为 `com.bluewing.connect`;数据文件、回退目录、环境变量 `BLUEWING_DATA_DIR`、日志文件全部换用 bluewing 系命名;备份体系全面换名——扩展名 `.bluewingbackup`、内部备份/快照命名、格式识别键 `bluewing_windows` / `bluewing_android`、下载文件名前缀 `BlueWingConnect_`;WebDAV 默认远端目录与快照文件名同步换名;localStorage 键(`bluewing:theme`、节点排序、测速视图)、代理/DNS 所有权状态字段(`managedByBlueWing`、`bluewingManaged`)统一换新;安装器与异路径实例检测只认新进程名/新暂存名,移除 ownbox.json 历史迁移。旧版数据与安装不会被识别或延续,需自行卸载清理。

### ✨ 新功能
- 安装器品牌化 UI:新增 MUI 欢迎页(左侧白底居中应用 Logo 竖幅,右侧标题、说明与版本号),模式/目录/安装/完成页右上角为方形应用 Logo 头图(白底画布右对齐,保持原比例不拉伸),并经运行时 `SetWindowPos` 调整为与标题左缘对称的右边距(视觉左右均衡),卸载器同款位图;素材采用 electron-builder 资源约定名(`build/installerHeader.bmp` / `build/installerSidebar.bmp`,Logo 取自 `src/images/png/app-light.png`)由其自动下发 MUI 位图 define——注意不可自行 `!define MUI_WELCOMEFINISHPAGE_BITMAP`(与命令行 define 冲突)或使用 MUI 1.x 旧名 `MUI_WELCOMEPAGE_BITMAP`(会被静默忽略,欢迎页停留在 NSIS 默认图);欢迎页文案经 `customWelcomePage` 钩子注入。经运行时解包字节比对验证:欢迎页竖幅与头图均为自有素材,截图确认方形头图与对称边距渲染正确。
- DNS 页新增「自定义域名解析(应用内 Hosts)」:指定域名直接解析到指定 IP,由核心 DNS 以 `predefined` 规则直接返回(sing-box 1.14 无 `dns.hosts` 字段,经实测采用 RFC 1035 记录形式),**完全不修改系统 hosts 文件**;域名精确匹配(与系统 hosts 语义一致),支持 IPv4 / IPv6(同域名可各一条,合并为单条规则多个应答),映射规则置于全部 DNS 规则(含 FakeIP)之前保证优先生效;启用行实时红框校验与保存前整表校验,禁用与非法记录不进入核心配置;记录随 DNS 配置入库并纳入备份。
- 新增主进程/渲染层共享的 IP 与域名字面量校验模块(`src/utils/ip.ts`,IPv6 完整支持 `::` 压缩形式),hosts 映射校验共用。

### 🎨 界面与交互
- 统一卡片悬停效果覆盖两处缺口:①关于页首卡为 `rounded-3xl`,不在原 `rounded-xl/2xl + border` 悬停选择器覆盖范围,悬停无"边框提亮 + 阴影加深"效果——补齐 `rounded-3xl` 档位;②设置页主卡片容器是 `<form>` 元素,被选择器的 `div` 类型限定排除——改为 `:is(div, form)`。经运行时审计:11 个页签 + 设置页全部 4 个子分类的卡片型元素全部命中悬停。
- 托盘图标简化:移除 `menu-{dark,light}-{on,off}.png` 主题变体四枚,改为仅随连接状态切换——连接 `on.png` / 断开 `off.png`(不随界面主题),`trayIconPath` 与托盘刷新逻辑同步精简。
- 侧边栏左上角品牌区改为仅显示英文:「BlueWing Connect」+ 副题「PC Proxy Toolchain」。
- 根治内容区滚动后页头无法拖动窗口的问题(DNS 页滚动后失效、日志页打开即失效):真因是 Chromium/Electron 缺陷(electron#40610 等)——任一滚动容器处于非零偏移时,`-webkit-app-region` 区域缓存与实际位置错位且滚动不再触发重发,表现为页头(滚动容器正上方)命中失效而侧栏正常;经最小复现环境 + 原生输入实测,静态/固定定位/合成层/显隐切换/重插 DOM/zoom/scrollTop 摆动等一切渲染层强制重算手段均无效(仅 scrollTop 归零自然恢复),前版「滚动停止后切换 app-region 跨帧还原」的补救实为无效代码,已移除。现页头改为 `no-drag` + pointer 捕获,经 IPC 通知主进程跟随光标移动窗口(`window:drag-begin/end`,10ms 轮询,失焦/关窗停止 + 渲染层异常 30 秒硬上限兜底),完全绕开该缺陷且免疫后续版本回归;侧栏品牌区等空白区域仍走 app-region(不在滚动容器正上方,实测不受影响)。本应用为固定尺寸窗口,无最大化/磁贴吸附,原生标题栏拖动无额外能力损失。
- 图标体系重构:`src/images/`(现成 png / ico 母本,涵盖运行时全部图片)成为唯一图片源,构建链与运行时均直接引用源文件,移除构建期分发/缩放/多尺寸 ICO 组装逻辑;界面 Logo 由渲染层直引;全部图标高清重制,底板铺满画布无留白。
- 托盘图标统一为 `menu-*` 圆形徽章变体:修复浅色主题误用 `app-*` 方形图标导致深浅主题托盘样式不一致的问题,移除冗余 `tray-*.png` 中转文件。
- `.ico` 全部精简为单帧 256×256(移除内嵌 16/32/48 小尺寸帧),小尺寸场景由 Windows 系统缩放提供。
- 图标资产命名统一:界面 Logo 更名为 `app-{dark,light}.png`(去掉失去语义的 `-off` 后缀),exe/安装器图标更名为 `ico.ico`;全量图标从设计源重新导出(单帧 256×256);`ico/` 目录最终只保留运行时引用的 `ico.ico`,清理无引用的 `menu-*.ico` 与 `app-*.ico` 母本及临时调试脚本目录 `temp/`。
- 任务栏窗口图标固定为 exe 内嵌图标(与桌面快捷方式一致),不再随主题与代理状态切换,连接状态反馈统一由托盘图标承担。

### 🔧 依赖与构建
- 根治 Windows 打包 EPERM 失败:electron-builder 解压 Electron 发行包后零等待 rename 暂存目录,Defender 实时扫描刚写入的 electron.exe(约 170MB)短暂持有目录句柄,单次 rename 确定性失败(实测连续 5 次全败)——新增 `scripts/dist-wrapper.js` 包装 CLI,对 `fs.rename` / `fs/promises.rename` 叠加 EPERM/EBUSY/ENOTEMPTY 退避重试(最长约 40 次),`dist` / `dist:dir` 均改经包装器执行,实测约 2.4 秒内通过;app-builder-lib 持锁 rename 所涉 proper-lockfile 锁文件为暂存目录兄弟项,不阻塞改名,原锁行为保留不动。
- 移除声明但从未引用的死依赖(`sql.js`、`clsx`、`tailwind-merge` 及 `@types/sql.js`),依赖清单恢复与实际使用一致。
- 安装包瘦身:bin/(sing-box.exe、wintun/libcronet.dll、规则集)此前经 files 列表被打进 app.asar 又经 extraResources 分发实体文件,asar 内副本纯属死重(核心进程也无法读取 asar 路径)——files 移除 bin/**/* 后 app.asar 由 125MB 降至 33MB,安装包 164MB → 140MB;核心与规则定位本就以 resources/bin 为第一优先,实测打包应用启动正常、resources/bin 完整。
- Electron 34.5.8 → 44.8.0,electron-builder 25.1.8 → 26.15.3:安装包体积随新版 Electron 增大(约 139MB → 167MB);新工具链二进制首次构建需联网下载,GitHub 直连不可达时可用 npmmirror 镜像(`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`)。

### 🛡 数据与稳定性
- 安装器数据保全:升级重装自动暂存并还原安装目录下的便携 `data/`(自定义 NSIS 脚本 `build/installer.nsh`),仅正式卸载时随安装目录一并删除,修复重装清空用户数据的问题。
- 覆盖安装数据保全加固:安装器先通过二次实例信号(`--bb-shutdown`)让运行中的应用实例还原系统代理、停止核心后自行退出(修复应用未退出时升级丢数据与强杀残留系统代理断网的问题,超时才强杀兜底),再做数据暂存;暂存反复失败时中止安装而非放弃保全;应用启动时自动收回安装向导取消遗留的数据暂存。

## [1.0.0] - 2026-10-15 (首个正式版本)

### 🚀 核心与协议
- 基于官方 **sing-box 1.14.3 稳定版**核心(全量构建标签,含 `with_naive_outbound`),集成 gVisor 协议栈与 Clash API;
- **全协议栈**:VLESS(Reality 伪装、gRPC / WebSocket)、VMess、Trojan、Shadowsocks、Hysteria 1 / 2、TUIC v5、WireGuard(endpoint 架构)、**NaiveProxy**(真实 Chrome TLS 指纹,`libcronet.dll` 随安装包分发)、SOCKS5、HTTP;
- 全部 12 种协议的生成配置经 1.14.3 `sing-box check` 实测校验通过;
- 零断流节点热切换:Clash API 动态热重载,核心运行期间切换节点瞬间完成。

### 🎨 界面与交互
- 无边框窗口:任意空白区域拖动,页头内嵌连接状态与最小化/关闭控制,固定窗口尺寸范围(980×680 ~ 1600×1040);
- 图标体系为 dark/light 双主题(多尺寸 ICO 16~256):界面 Logo 随主题切换,任务栏与托盘图标随代理状态切换(开=light,关=dark);`src/icon/` 为唯一图标源,构建链经 `scripts/sync-icons.mjs` 强制重新分发;
- 页面切换入场动画与内容卡片统一悬停动效。

### 🛡 数据与稳定性
- 数据目录统一治理:备份/快照/日志/核心/代理状态全部由 `Database.getDataDir()` 统一解析,测试进程完全隔离(临时目录 + 退出清理);
- 本地凭据 Windows DPAPI 加密存储,数据库 Schema v2 原子写入与断电自愈;
- 跨端备份:Android 手机端备份无损互转、分类选择性备份与原子回滚保护,内置 WebDAV 云同步;
- 便携数据构建保全(`scripts/preserve-data.js`),重打包不丢用户数据。
