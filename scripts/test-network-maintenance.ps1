$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\build\network-maintenance.ps1" -LibraryOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$dir = Join-Path $env:TEMP ('BlueWing-maintenance-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $dir
try {
    $file = Join-Path $dir 'proxy_ownership.json'
    $helper = Join-Path $dir 'fake-helper.exe'
    Set-Content -LiteralPath $file -Value '{"managedServer":"127.0.0.1:9081"}'
    Set-Content -LiteralPath $helper -Value 'test fixture; never executed'
    $script:events = [Collections.Generic.List[string]]::new()
    $script:inventory = @(
        [pscustomobject]@{ ProcessId = 100; ExecutablePath = "$dir\BlueWing Connect.exe"; CreationDate = 1 },
        [pscustomobject]@{ ProcessId = 101; ExecutablePath = "$dir\resources\bin\sing-box.exe"; CreationDate = 1 },
        [pscustomobject]@{ ProcessId = 200; ExecutablePath = "$dir-other\resources\bin\sing-box.exe"; CreationDate = 1 },
        [pscustomobject]@{ ProcessId = 201; ExecutablePath = 'C:\OtherApp\sing-box.exe'; CreationDate = 1 },
        [pscustomobject]@{ ProcessId = 202; ExecutablePath = $null; CreationDate = 1 }
    )
    $stop = { param($ProcessId) $script:events.Add("stop:$ProcessId"); $script:inventory = @($script:inventory | Where-Object { $_.ProcessId -ne $ProcessId }) }
    $release = { param($Executable, $File) Assert (Test-Path -LiteralPath $File) 'Ownership deleted before release'; $script:events.Add('release') }
    Invoke-BlueWingMaintenance $dir $helper @($file) -Inventory { $script:inventory } -Graceful { $script:events.Add('graceful') } -Stop $stop -Release $release
    Assert (($script:events -join ',') -eq 'graceful,stop:100,stop:101,release') "Incorrect maintenance order: $script:events"
    Assert (($script:inventory.ProcessId -join ',') -eq '200,201,202') 'Other software was stopped'
    $script:attempts = 0
    $failed = $false
    try {
        Invoke-BlueWingMaintenance $dir $helper @($file) -Inventory { @() } -Release { $script:attempts++; throw 'simulated restore failure' }
    } catch { $failed = $true }
    Assert ($failed -and $script:attempts -eq 3 -and (Test-Path -LiteralPath $file)) 'Failure did not retain recoverable ownership'
    $script:attempts = 0
    Invoke-BlueWingMaintenance $dir $helper @($file) -Inventory { @() } -Release { $script:attempts++; if ($script:attempts -eq 1) { throw 'transient failure' } }
    Assert ($script:attempts -eq 2) 'Transient release was not retried'
    Write-Output 'PASS: exact paths, unrelated processes, shutdown order, failure retention and retry'
} finally {
    $absolute = [IO.Path]::GetFullPath($dir)
    if (-not $absolute.StartsWith([IO.Path]::GetFullPath($env:TEMP) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup' }
    Remove-Item -LiteralPath $absolute -Recurse -Force
}
