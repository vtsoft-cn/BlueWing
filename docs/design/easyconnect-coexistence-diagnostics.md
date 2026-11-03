# Windows EasyConnect 共存诊断

保留官方 EasyConnect 客户端时，先区分连接后的路由、DNS 变化与客户端网络过滤。以下脚本只采集，不修改路由、DNS、系统代理、驱动、服务或防火墙。

## 路由、DNS 与连通性

在项目根目录，用平时登录桌面的 Windows 账户运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-easyconnect.ps1 -DurationSeconds 180
```

开始采集后连接 EasyConnect，故障出现后保持 10～15 秒，再断开。断网期间采集仍会继续，结果保存在已被 Git 忽略的 `work/easyconnect-diagnostics/`。

采集包括路由、网卡、DNS、系统代理、相关进程及 TCP 连通性，并对比普通连接与指定物理网卡出口的连接。物理出口测试成功而普通连接失败，可以进一步验证出口选择问题；两者都失败时，需要结合路由、DNS 和过滤证据继续判断。

可以用 `-IntranetHost 内网域名或IP -IntranetPort 443` 同时探测一个公司资源。`-DurationSeconds 0` 只采集一次当前状态。

## Windows 网络过滤

需要继续定位过滤规则时，使用有权导出 WFP 状态的 Windows 账户运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\inspect-easyconnect-filters.ps1 -WatchSeconds 600
```

开始时保持 EasyConnect 断开，提示等待后连接并保持故障约 30 秒，再断开。脚本保存连接前、连接中与断开后的过滤规则、规则差异及公网 / 物理网关 TCP 探测结果。除了 GUID，也按规则内容比较，减少防火墙重建规则产生的无关差异。`-WatchSeconds 0` 仅保存当前状态。

超时本身不足以证明某种网关模式，新增直连规则也不能证明客户端过滤限制已解除。请结合实际业务和采集结果判断。采集文件含网络、地址和应用路径信息，分享前应检查并脱敏。
