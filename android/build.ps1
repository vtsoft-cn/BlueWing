$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = Split-Path -Parent $PSScriptRoot
$routing = Join-Path $root 'native/routing'
$vpn = Join-Path $root 'native/vpn'
$libraries = Join-Path $PSScriptRoot 'app/libs'
$buildRoot = Join-Path $PSScriptRoot '.gradle/bluewing-native'
New-Item -ItemType Directory -Force $libraries, $buildRoot | Out-Null
$buildRoot = (Resolve-Path -LiteralPath $buildRoot).Path
$staging = Join-Path $buildRoot ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

try {
    # Bind in a separate module checkout so Go Mobile tooling stays out of the
    # desktop core's module graph and corresponding-source manifests.
    Get-ChildItem -LiteralPath $routing -Force |
        Where-Object { $_.Name -ne '.cache' -and $_.Extension -ne '.exe' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse }
    $stagedVpn = Join-Path $staging 'bluewing-vpn'
    New-Item -ItemType Directory -Path $stagedVpn | Out-Null
    Get-ChildItem -LiteralPath $vpn -Force |
        Where-Object { $_.Name -ne '.cache' -and $_.Extension -ne '.exe' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stagedVpn -Recurse }
    $mobileSources = Join-Path $PSScriptRoot 'native'
    Copy-Item -LiteralPath (Join-Path $mobileSources 'mobile') -Destination $stagedVpn -Recurse
    Copy-Item -LiteralPath (Join-Path $mobileSources 'androidbridge') -Destination $staging -Recurse
    Get-ChildItem -LiteralPath (Join-Path $mobileSources 'libbox') -File |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $staging 'experimental/libbox') }
    Push-Location $staging
    try {
        go mod edit '-replace=github.com/mythologyli/zju-connect=./bluewing-vpn' `
            '-replace=inet.af/netaddr=github.com/inetaf/netaddr@v0.0.0-20230525184311-b8eac61e914a' `
            '-replace=golang.zx2c4.com/wireguard=./bluewing-vpn/third_party/wireguard'
        go get 'golang.org/x/mobile/bind@v0.0.0-20261011034528-197770444867' 'github.com/mythologyli/zju-connect@v0.0.0'
        gomobile bind '-target=android/arm64,android/amd64' -androidapi 26 `
            '-tags=with_gvisor,with_utls,badlinkname,tfogo_checklinkname0' `
            '-ldflags=-s -w -checklinkname=0 -extldflags=-Wl,-z,max-page-size=16384' `
            -o (Join-Path $libraries 'bluewing-mobile.aar') ./androidbridge github.com/mythologyli/zju-connect/mobile
    } finally {
        Pop-Location
    }
    gradle -p $PSScriptRoot :app:assembleDebug
} finally {
    $resolved = (Resolve-Path -LiteralPath $staging).Path
    if ((Split-Path -Parent $resolved) -eq $buildRoot) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
