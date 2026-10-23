param(
    [ValidateRange(0, 600)][int]$DurationSeconds = 120,
    [ValidateRange(2, 30)][int]$IntervalSeconds = 5,
    [string]$OutputDirectory = '',
    [string]$IntranetHost = '',
    [ValidateRange(1, 65535)][int]$IntranetPort = 443
)

# Read-only: no route, DNS, proxy, driver, service or firewall changes.
# Run as the desktop user so HKCU describes the user's actual system proxy.
$ErrorActionPreference = 'Continue'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) (
        'work\easyconnect-diagnostics\' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    )
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Save-Json($Name, $Value) {
    [IO.File]::WriteAllText(
        (Join-Path $OutputDirectory $Name),
        (ConvertTo-Json -InputObject $Value -Depth 8), $utf8
    )
}

function Read-Section($Label, [scriptblock]$Action, $Failures) {
    try { & $Action } catch {
        $Failures.Add(($Label + ': ' + $_.Exception.Message)) | Out-Null
    }
}

function Test-Tcp($Label, $Target, [int]$Port, $Uplink = $null) {
    $client = New-Object Net.Sockets.TcpClient
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $pending = $null
    $result = [ordered]@{ Label = $Label; Host = $Target; Port = $Port; Connected = $false }
    try {
        if ($Uplink) {
            $result.BoundInterface = $Uplink.InterfaceAlias
            $result.BoundAddress = $Uplink.LocalAddress
            $client.Client.Bind((New-Object Net.IPEndPoint(
                [Net.IPAddress]::Parse($Uplink.LocalAddress), 0
            )))
            # IP_UNICAST_IF takes the IPv4 interface index in network byte order.
            $client.Client.SetSocketOption(
                [Net.Sockets.SocketOptionLevel]::IP,
                [Net.Sockets.SocketOptionName]31,
                [int][Net.IPAddress]::HostToNetworkOrder([int]$Uplink.InterfaceIndex)
            )
        }
        $pending = $client.BeginConnect($Target, $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(1200)) {
            $result.Error = 'Timeout'
        } else {
            $client.EndConnect($pending)
            $result.Connected = $true
            $result.RemoteAddress = $client.Client.RemoteEndPoint.Address.ToString()
        }
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $result.Error = $failure.Message
    } finally {
        $client.Close()
        if ($pending) { $pending.AsyncWaitHandle.Close() }
        $timer.Stop()
        $result.ElapsedMs = $timer.ElapsedMilliseconds
    }
    [pscustomobject]$result
}

$initialFailures = New-Object 'Collections.Generic.List[string]'
$physicalUplinks = @(Read-Section 'Physical uplinks' {
    Get-NetAdapter -Physical -ErrorAction Stop |
        Where-Object Status -eq 'Up' |
        ForEach-Object {
            $configuration = Get-NetIPConfiguration -InterfaceIndex $_.ifIndex -ErrorAction Stop
            $localAddress = @($configuration.IPv4Address.IPAddress | Select-Object -First 1)
            foreach ($gateway in $configuration.IPv4DefaultGateway.NextHop) {
                if ($gateway -and $gateway -ne '0.0.0.0' -and $localAddress.Count) {
                    [pscustomobject]@{
                        InterfaceIndex = $_.ifIndex
                        InterfaceAlias = $_.Name
                        LocalAddress = $localAddress[0]
                        Gateway = $gateway
                    }
                }
            }
        }
} $initialFailures)
$physicalGateways = @($physicalUplinks.Gateway | Select-Object -Unique)

$drivers = @(Read-Section 'Drivers' {
    Get-CimInstance Win32_SystemDriver -ErrorAction Stop |
        Where-Object { $_.Name -match 'Sangfor|SdpVnic' -or $_.DisplayName -match 'Sangfor|EasyConnect' } |
        Select-Object Name, DisplayName, State
} $initialFailures)

Save-Json 'metadata.json' ([ordered]@{
    StartedAt = (Get-Date).ToString('o')
    Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    PhysicalGateways = $physicalGateways
    PhysicalUplinks = $physicalUplinks
    DurationSeconds = $DurationSeconds
    Drivers = $drivers
    Errors = @($initialFailures.ToArray())
})

Write-Output ('Read-only capture started: ' + $OutputDirectory)
Write-Output 'Connect Windows EasyConnect, keep the failure for 10-15 seconds, then disconnect it.'
Write-Output 'No network settings will be changed. Ctrl+C stops capture.'

$clock = [Diagnostics.Stopwatch]::StartNew()
$number = 0
$baselineRoutes = $null
$baselineDns = $null
$baselineProxy = $null
$events = New-Object 'Collections.Generic.List[object]'
do {
    $failures = New-Object 'Collections.Generic.List[string]'
    $adapters = @(Read-Section 'Adapters' {
        Get-NetAdapter -ErrorAction Stop |
            Select-Object Name, InterfaceDescription, Status, ifIndex, InterfaceMetric
    } $failures)
    $addresses = @(Read-Section 'Addresses' {
        Get-NetIPAddress -ErrorAction Stop |
            Select-Object InterfaceIndex, InterfaceAlias, AddressFamily, IPAddress, PrefixLength
    } $failures)
    $routes = @(Read-Section 'Routes' {
        Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop |
            Sort-Object AddressFamily, DestinationPrefix, InterfaceIndex, NextHop, RouteMetric |
            Select-Object AddressFamily, DestinationPrefix, InterfaceIndex, InterfaceAlias, NextHop, RouteMetric, State
    } $failures)
    $dns = @(Read-Section 'DNS servers' {
        Get-DnsClientServerAddress -ErrorAction Stop |
            Sort-Object InterfaceIndex, AddressFamily |
            Select-Object InterfaceIndex, InterfaceAlias, AddressFamily, ServerAddresses
    } $failures)
    $proxy = Read-Section 'System proxy' {
        Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop |
            Select-Object ProxyEnable, ProxyServer, ProxyOverride
    } $failures
    $nrpt = @(Read-Section 'DNS policies' {
        Get-DnsClientNrptPolicy -Effective -ErrorAction Stop |
            Select-Object Namespace, NameServers, DirectAccessEnabled
    } $failures)
    $processes = @(Read-Section 'VPN processes' {
        Get-Process -ErrorAction Stop |
            Where-Object { $_.ProcessName -match 'EasyConnect|ECAgent|SangforCSClient|SangforServiceClient|sing-box|BlueWing' } |
            Select-Object ProcessName, Id
    } $failures)

    $probes = @(
        foreach ($gateway in $physicalGateways) { Test-Tcp 'LAN gateway HTTP' $gateway 80 }
        Test-Tcp 'Public DNS TCP' '223.5.5.5' 53
        Test-Tcp 'Public web with system DNS' 'www.baidu.com' 80
        foreach ($uplink in $physicalUplinks) {
            Test-Tcp 'LAN gateway via physical NIC' $uplink.Gateway 80 $uplink
            Test-Tcp 'Public DNS via physical NIC' '223.5.5.5' 53 $uplink
        }
        if ($IntranetHost) { Test-Tcp 'Corporate resource' $IntranetHost $IntranetPort }
    )

    $routeSignature = ConvertTo-Json -InputObject $routes -Depth 4 -Compress
    $dnsSignature = ConvertTo-Json -InputObject $dns -Depth 4 -Compress
    $proxySignature = ConvertTo-Json -InputObject $proxy -Depth 4 -Compress
    if ($number -eq 0) {
        $baselineRoutes = $routeSignature
        $baselineDns = $dnsSignature
        $baselineProxy = $proxySignature
    }
    $event = [ordered]@{
        Snapshot = $number
        CapturedAt = (Get-Date).ToString('o')
        RoutesDifferFromBaseline = ($routeSignature -ne $baselineRoutes)
        DnsDifferFromBaseline = ($dnsSignature -ne $baselineDns)
        ProxyDiffersFromBaseline = ($proxySignature -ne $baselineProxy)
        Probes = $probes
        Errors = @($failures.ToArray())
    }
    $events.Add([pscustomobject]$event) | Out-Null
    Save-Json ('snapshot-{0:D3}.json' -f $number) ([ordered]@{
        Observation = $event
        Adapters = $adapters
        Addresses = $addresses
        Routes = $routes
        DnsServers = $dns
        SystemProxy = $proxy
        DnsPolicies = $nrpt
        Processes = $processes
    })
    Save-Json 'summary.json' @($events.ToArray())
    Write-Output ('Snapshot {0}: routesChanged={1}, dnsChanged={2}, proxyChanged={3}' -f
        $number, $event.RoutesDifferFromBaseline, $event.DnsDifferFromBaseline, $event.ProxyDiffersFromBaseline)
    $number++
    if ($clock.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
    Start-Sleep -Seconds $IntervalSeconds
} while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds)

Write-Output ('Capture finished: ' + (Join-Path $OutputDirectory 'summary.json'))
