param(
    [ValidateRange(0, 1800)][int]$WatchSeconds = 600,
    [string]$OutputDirectory = ''
)

# Read-only inspection. WFP state exports do not change filtering rules.
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) (
        'work\easyconnect-diagnostics\filters-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    )
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)

function Save-Json($Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $OutputDirectory $Name),
        (ConvertTo-Json -InputObject $Value -Depth 8), $utf8)
}

function Get-VpnAdapter {
    Get-NetAdapter -ErrorAction Stop |
        Where-Object InterfaceDescription -eq 'Sangfor SSL VPN CS Support System VNIC' |
        Select-Object -First 1
}

function Test-FilterProbe($Target, [int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    $result = [ordered]@{ Host = $Target; Port = $Port; Connected = $false }
    try {
        $task = $client.ConnectAsync($Target, $Port)
        if ($task.Wait(1200)) { $result.Connected = $true } else { $result.Error = 'Timeout' }
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $result.Error = $failure.Message
    } finally { $client.Close() }
    [pscustomobject]$result
}

function Save-FilterState($Label) {
    $stateFile = Join-Path $OutputDirectory ($Label + '.xml')
    $commandOutput = & netsh.exe wfp show state ('file=' + $stateFile) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw ('WFP export failed: ' + $commandOutput.Trim()) }

    # Some Windows versions append another XML document after </wfpstate>.
    $xmlText = [IO.File]::ReadAllText($stateFile)
    $rootEnd = $xmlText.IndexOf('</wfpstate>')
    if ($rootEnd -lt 0) { throw 'WFP export has no complete wfpstate root.' }
    $xmlText = $xmlText.Substring(0, $rootEnd + '</wfpstate>'.Length)
    $xmlText = [regex]::Replace($xmlText, '[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]', '')
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    $document.LoadXml($xmlText)

    $filters = @($document.SelectNodes('//*[filterKey and filterId]') | ForEach-Object {
        [pscustomobject]@{
            Key = [string]$_.filterKey
            Id = [string]$_.filterId
            Name = [string]$_.displayData.name
            Description = [string]$_.displayData.description
            Provider = [string]$_.providerKey
            Layer = [string]$_.layerKey
            Sublayer = [string]$_.subLayerKey
            Action = [string]$_.action.type
            Callout = if ($_.action.calloutKey) { [string]$_.action.calloutKey } else { [string]$_.action.filterType }
            Flags = if ($_.flags) { $_.flags.InnerText } else { '' }
            Weight = if ($_.weight) { $_.weight.InnerXml } else { '' }
            Conditions = if ($_.filterCondition) { $_.filterCondition.InnerXml } else { '' }
        }
    })
    Save-Json ($Label + '-filters.json') $filters

    $adapter = Get-VpnAdapter
    $sessions = @($document.SelectNodes('/wfpstate/sessions/item') | ForEach-Object {
        [pscustomobject]@{
            Name = [string]$_.displayData.name
            ProcessId = [string]$_.processId
            KernelMode = [string]$_.kernelMode
        }
    })
    Save-Json ($Label + '-summary.json') ([ordered]@{
        CapturedAt = (Get-Date).ToString('o')
        Adapter = $adapter | Select-Object Name, Status, ifIndex
        FilterCount = $filters.Count
        BlockFilters = @($filters | Where-Object Action -eq 'FWP_ACTION_BLOCK')
        VendorFilters = @($filters | Where-Object {
            $_.Name -match 'ClawNet|Corplink|NFSDK|Sangfor|Forti|EasyConnect'
        })
        Sessions = $sessions
    })
    $gateway = Get-NetIPConfiguration -ErrorAction Stop |
        Where-Object { $_.NetAdapter.HardwareInterface -and $_.IPv4DefaultGateway } |
        ForEach-Object { $_.IPv4DefaultGateway.NextHop } | Select-Object -First 1
    $targets = @('223.5.5.5')
    $probes = @(Test-FilterProbe '223.5.5.5' 53)
    if ($gateway) {
        $targets += $gateway
        $probes += Test-FilterProbe $gateway 80
    }
    Save-Json ($Label + '-probes.json') $probes
    foreach ($target in $targets) {
        $eventsFile = Join-Path $OutputDirectory ($Label + '-netevents-' + $target + '.xml')
        $eventsResult = & netsh.exe wfp show netevents ('file=' + $eventsFile) 'protocol=6' ('remoteaddr=' + $target) 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            [IO.File]::WriteAllText(($eventsFile + '.error.txt'), $eventsResult, $utf8)
        }
    }
    Write-Host ('Saved ' + $Label + ': ' + $filters.Count + ' filters')
    return ,$filters
}

function Save-Difference($Baseline, $Current, $Label) {
    $oldByKey = @{}
    $newByKey = @{}
    foreach ($filter in $Baseline) { $oldByKey[$filter.Key] = $filter }
    foreach ($filter in $Current) { $newByKey[$filter.Key] = $filter }
    Save-Json ($Label + '-difference.json') ([ordered]@{
        Added = @($Current | Where-Object { -not $oldByKey.ContainsKey($_.Key) })
        Removed = @($Baseline | Where-Object { -not $newByKey.ContainsKey($_.Key) })
        Changed = @($Current | Where-Object {
            $oldByKey.ContainsKey($_.Key) -and
            (ConvertTo-Json $oldByKey[$_.Key] -Depth 4 -Compress) -ne
            (ConvertTo-Json $_ -Depth 4 -Compress)
        })
    })
    # Windows Firewall may regenerate thousands of GUIDs after a network change.
    # Also compare rule contents so these replacements do not hide new blocks.
    $oldCounts = @{}
    $newCounts = @{}
    $oldExamples = @{}
    $newExamples = @{}
    foreach ($set in @(@{Rows=$Baseline;Counts=$oldCounts;Examples=$oldExamples},
                      @{Rows=$Current;Counts=$newCounts;Examples=$newExamples})) {
        foreach ($filter in $set.Rows) {
            $signature = ConvertTo-Json -InputObject ($filter | Select-Object Name,Description,Provider,Layer,Sublayer,Action,Callout,Flags,Weight,Conditions) -Depth 4 -Compress
            if (-not $set.Counts.ContainsKey($signature)) { $set.Counts[$signature] = 0 }
            $set.Counts[$signature]++
            $set.Examples[$signature] = $filter
        }
    }
    $semanticAdded = @()
    $semanticRemoved = @()
    foreach ($signature in $newCounts.Keys) {
        $difference = $newCounts[$signature] - $oldCounts[$signature]
        if ($difference -gt 0) { $semanticAdded += [pscustomobject]@{Count=$difference;Rule=$newExamples[$signature]} }
    }
    foreach ($signature in $oldCounts.Keys) {
        $difference = $oldCounts[$signature] - $newCounts[$signature]
        if ($difference -gt 0) { $semanticRemoved += [pscustomobject]@{Count=$difference;Rule=$oldExamples[$signature]} }
    }
    Save-Json ($Label + '-semantic-difference.json') ([ordered]@{Added=$semanticAdded;Removed=$semanticRemoved})
}

Save-Json 'metadata.json' ([ordered]@{
    StartedAt = (Get-Date).ToString('o')
    ProcessId = $PID
    Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    WatchSeconds = $WatchSeconds
})
$baseline = Save-FilterState 'before'
if ($WatchSeconds -eq 0) { exit 0 }
if ((Get-VpnAdapter).Status -eq 'Up') {
    Write-Output 'EasyConnect is already connected. Disconnect it before starting a new comparison.'
    exit 1
}

Write-Output ('Waiting for Windows EasyConnect: ' + $OutputDirectory)
$timer = [Diagnostics.Stopwatch]::StartNew()
$capturedConnection = $false
while ($timer.Elapsed.TotalSeconds -lt $WatchSeconds) {
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'stop.request')) { break }
    $adapter = Get-VpnAdapter
    if (-not $capturedConnection -and $adapter.Status -eq 'Up') {
        Start-Sleep -Seconds 4
        if ((Get-VpnAdapter).Status -ne 'Up') { continue }
        $connected = Save-FilterState 'connected'
        Save-Difference $baseline $connected 'connected'
        $capturedConnection = $true
        Start-Sleep -Seconds 5
        if ((Get-VpnAdapter).Status -eq 'Up') {
            $steady = Save-FilterState 'connected-steady'
            Save-Difference $baseline $steady 'connected-steady'
        }
    } elseif ($capturedConnection -and $adapter.Status -ne 'Up') {
        Start-Sleep -Seconds 3
        $after = Save-FilterState 'after'
        Save-Difference $baseline $after 'after'
        break
    }
    Start-Sleep -Seconds 2
}
Write-Output ('Inspection finished. CapturedConnection=' + $capturedConnection)
