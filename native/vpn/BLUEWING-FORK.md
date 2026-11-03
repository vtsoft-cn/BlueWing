# BlueWing protocol core

This directory contains a maintained source fork of [zju-connect v1.3.1](https://github.com/Mythologyli/zju-connect/tree/v1.3.1), upstream commit `5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da`. Upstream copyright and AGPL-3.0 license are retained in LICENSE. README.md is upstream documentation; the upstream CLI/service executables are not this product's entry point.

BlueWing adds `cmd/bluewing-vpn-core`, `internal/bluewing`, and `internal/winproxy`; patches the two authentication providers for cancellable structured challenges and explicit certificate trust; adds bounded stack lifecycle and contextual TCP dialing; and prevents upstream signal hooks from accumulating in the control host. The control host never installs a TUN, changes system DNS, or writes plaintext sessions. Only an explicitly invoked Windows system proxy helper mode changes WinINet options.

Build with Go 1.26.10: from the BlueWing root run `npm run build:vpn-core` (`GO_BINARY` can name an absolute Go executable). Run `npm run test:vpn-core`. The source zip and manifest accompany the executable in `bin/` and are included by existing Electron packaging. Module versions/checksums are fixed in go.mod/go.sum. No EZ4Connect source code is included.

Control transport: newline-delimited JSON v1 on inherited stdin/stdout; hello must precede commands. Supported commands: configure, discoverAuth, connect, respond, setProbe, disconnect, shutdown. Passwords/session data travel only in the inherited pipe, not argv. stdout contains machine events; raw upstream logs and stderr are never forwarded into application logs. stdin EOF closes owned resources.

Optional diagnostic events capture HTTP authentication metadata, or original headers/bodies in explicit full mode. The host's per-profile full diagnostics can intentionally record submitted plaintext passwords/verification codes and session cookies in separate local rotated files; it is disabled by default and reset on profile export/import. Raw upstream debug output remains disabled so application payload dumps cannot corrupt NDJSON. A trusted-endpoint rejection (75500503) retains its original server message and is not treated as a wrong password. This does not implement official aTrust endpoint attestation or solve gateways requiring the official client. See BlueWing's docs/design/atrust-diagnostics-and-upstream-review.md for gateway findings and upstream issue verification.

Optional smart private routing reuses the physical underlay first and attempts
the active VPN only for an actual RFC1918 TCP target that was not reachable
locally. It never scans subnets or sends application bytes to both outlets.
Hints are session-owned, exact IP:port, bounded and revalidated after expiry;
known company resource restrictions stay authoritative. Local LAN sockets are
owned by their endpoint so a VPN logout does not tear them down. The host stores
per-gateway observations separately from explicit company ownership rules.

SoftEther smart mode uses the same automatic outlet for all IPv4 TCP services
selected for direct access, including public company services absent from DHCP
routes. A failed bound local dial is retried through the VPN. Successful local
sockets are retained, and public proxy selections stay in the managed layer.
This does not probe special/FakeIP addresses or broaden providers with
server-issued resource policies. Public hints remain in the current session;
no public address is persisted as ownership of a company subnet.

SoftEther now also exposes an authenticated WireGuard packet link bound only to
loopback. It is an in-memory interface, not a second VPN login or Windows TAP.
The private gVisor stack forwards IPv4 with connection tracking and masquerade,
including UDP, ICMP, fragments and reverse NAT. Active unknown-private UDP/ICMP
rules exist before the first request; no learned IP/port is required. The TCP
readiness probe waits for both managed resources and packet activation rules.
Provider setup has a 10s dial budget; the host dispatcher allows 11s per provider
within its existing total budget rather than truncating a cold first dial at 3.5s.

The WinINet helper also installs per-user, windowless network recovery at login
and watches its owning app process. It also checks every five seconds while
Electron is alive, so a routing child crash cannot leave a dead system proxy.
The host immediately requests the same recovery on routing-core exit. On owner
exit, a matching owner PID also releases a proxy served by an orphaned child;
a newer instance's record and live listener are preserved. Restoration is scoped
per connection, retains original PAC settings, and releases new RAS entries
absent from the original snapshot. Failed restores retain ownership for retry.
No recovery runs on another user's proxy or an unowned/non-loopback proxy.

Proxy port transitions persist both old and new loopback addresses until all
WinINet connections confirm the new value. Recovery checks the actual address
of each LAN/RAS connection; a live new port cannot hide an abandoned old port.

Company DNS forwards all record types, including SRV/TXT, and retries truncated
UDP answers over TCP to the same company resolver. No system/public fallback is
introduced. IPv4 fragments are reassembled with per-tunnel, per-direction
memory/time/overlap limits before port authorization and before provider reply
NAT. This is necessary because gVisor prerouting NAT precedes local reassembly.

ICMP uses a separate authenticated peer with an unspecified sing-box port
address. A concrete address makes sing-tun's gVisor ICMP forwarder answer echo
locally instead of forwarding. UDP retains its own concrete source address and
return path. Both peers reuse one provider login and one gVisor stack, and do
not create system adapters. The maintained MIT WireGuard source in
third_party/wireguard increases the Windows in-memory message buffer; see its
BLUEWING-PATCH.md. First real ICMP and UDP replies have been observed through
sing-box and this provider; a 2048-byte echo also passes the native provider
chain. The separately maintained routing core now fixes Windows buffering,
locally generated IPv4 fragment IDs/flags and reassembled header checksums.
The isolated actual-sing-box/provider packet chain passes 8192-byte ICMP and
3072-byte UDP in both directions, including eight interleaved UDP datagrams.
See native/routing/BLUEWING-FORK.md and the root audit fix record.

SoftEther is implemented in `client/softether`, adapting MIT-licensed govpn wire
helpers (pinned source and license in that directory) to the existing private
gVisor stack. It uses bound TLS TCP, DHCP/ARP and lease renewal without an OS
TAP/service/default route. The shared control protocol and per-profile routing
keep company-only routing isolated from public direct/proxy outlets. See
`docs/design/softether-access-implementation.md` in the BlueWing root for scope,
real-gateway acceptance evidence and testing instructions.

Company traffic is tunnel-only. Company DNS uses the provider DNS through the userspace stack; no public/system fallback. Local SOCKS requires per-launch random credentials. SoftEther IPv4 TCP/UDP/ICMP uses the existing TUN and authenticated packet link; external SOCKS UDP for the other providers and IPv6 provider tunnels remain unsupported. CAS/OAuth/certificate login are not enabled in the product UI. aTrust requires its own real gateway acceptance, independent of EasyConnect.

The AGPL source/license materials do not resolve BlueWing's overall distribution licensing decision. The application's release process must resolve the design's pending license decision before publishing a combined installer.

2026-11-03 security update: Go 1.26.10 is pinned by the build scripts. Module
locks include patched x/net and x/crypto versions; the routing core also updates
gRPC, DHCP, Chi, go-jose and supporting modules. Exact versions are in go.mod/go.sum.
Both produced binaries must pass govulncheck; no upstream identity or endorsement
is implied. Runtime diagnostics no longer include submitted secrets or HTTP bodies.
