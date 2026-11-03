param(
    [string]$InstallDir,
    [string]$RecoveryHelper,
    [string]$UserDataDir,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'

# Select exact executable paths, never image names or a directory prefix.
function Get-BlueWingProcesses([string]$Directory, [object[]]$Inventory) {
    if (-not $Directory -or -not [IO.Path]::IsPathRooted($Directory)) { throw 'Invalid installation directory' }
    $base = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    if ($base -eq [IO.Path]::GetPathRoot($base).TrimEnd('\')) { throw 'Installation directory cannot be a drive root' }
    $paths = @(
        'BlueWing Connect.exe', 'resources\bin\sing-box.exe',
        'resources\bin\bluewing-vpn-core.exe',
        'resources\bin\vpn\openvpn\openvpn.exe',
        'resources\bin\vpn\openconnect\openconnect.exe'
    ) | ForEach-Object { [IO.Path]::Combine($base, $_) }
    @($Inventory | Where-Object { $_.ExecutablePath -and $paths -contains $_.ExecutablePath })
}

function Invoke-BlueWingMaintenance {
    param(
        [string]$Directory, [string]$Helper, [string[]]$OwnershipFiles,
        [scriptblock]$Inventory = { @(Get-CimInstance Win32_Process) },
        [scriptblock]$Graceful = {
            param($Executable)
            $task = 'BlueWingShutdown-' + [Guid]::NewGuid().ToString('N')
            try {
                $action = New-ScheduledTaskAction -Execute $Executable -Argument '--bb-shutdown'
                $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
                $null = Register-ScheduledTask -TaskName $task -Action $action -Principal $principal
                Start-ScheduledTask -TaskName $task
                Start-Sleep -Seconds 6
            } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
        },
        [scriptblock]$Stop = { param($ProcessId) Stop-Process -Id $ProcessId -Force -ErrorAction Stop },
        [scriptblock]$Release = {
            param($Executable, $File)
            $start = New-Object Diagnostics.ProcessStartInfo
            $start.FileName = $Executable
            $start.Arguments = '--release-network "' + $File + '"'
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $process = [Diagnostics.Process]::Start($start)
            try {
                if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Network recovery timed out' }
                if ($process.ExitCode -ne 0) { throw 'Network recovery failed; ownership data retained' }
            } finally { $process.Dispose() }
        }
    )
    $owned = @(Get-BlueWingProcesses $Directory (& $Inventory))
    $app = @($owned | Where-Object { [IO.Path]::GetFileName($_.ExecutablePath) -eq 'BlueWing Connect.exe' })
    if ($app.Count) {
        try { & $Graceful $app[0].ExecutablePath } catch { Write-Verbose 'Graceful shutdown unavailable; using scoped shutdown' }
    }
    # Recheck identity immediately before stopping: do not act on a reused PID.
    foreach ($process in @(Get-BlueWingProcesses $Directory (& $Inventory))) {
        $current = @(& $Inventory | Where-Object { $_.ProcessId -eq $process.ProcessId -and $_.ExecutablePath -eq $process.ExecutablePath -and $_.CreationDate -eq $process.CreationDate })
        if ($current.Count) {
            try { & $Stop $process.ProcessId } catch {
                if (@(Get-BlueWingProcesses $Directory (& $Inventory) | Where-Object { $_.ProcessId -eq $process.ProcessId }).Count) { throw }
            }
        }
    }
    for ($wait = 0; $wait -lt 20; $wait++) {
        if (-not @(Get-BlueWingProcesses $Directory (& $Inventory)).Count) { break }
        Start-Sleep -Milliseconds 100
    }
    if (@(Get-BlueWingProcesses $Directory (& $Inventory)).Count) { throw 'BlueWing processes are still running; data retained' }
    # Ownership files survive every failed release. Callers may delete data only
    # after this function succeeds, including custom ports and all RAS entries.
    foreach ($file in @($OwnershipFiles | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw 'Network recovery helper is missing' }
            $released = $false
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                try { & $Release $Helper $file; $released = $true; break }
                catch { if ($attempt -eq 2) { throw }; Start-Sleep -Milliseconds 250 }
            }
            if (-not $released) { throw 'Network recovery did not complete' }
        }
    }
}

if (-not $LibraryOnly) {
    try {
        if (-not $UserDataDir) { throw 'User data directory is required' }
        Invoke-BlueWingMaintenance -Directory $InstallDir -Helper $RecoveryHelper -OwnershipFiles @(
            [IO.Path]::Combine($InstallDir, 'data\proxy_ownership.json'),
            [IO.Path]::Combine($UserDataDir, 'proxy_ownership.json')
        )
        exit 0
    } catch { Write-Error $_ -ErrorAction Continue; exit 1 }
}
