# BlueWing protocol core

This directory contains a maintained source fork of [zju-connect v1.3.1](https://github.com/Mythologyli/zju-connect/tree/v1.3.1), upstream commit `5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da`. Upstream copyright and AGPL-3.0 license are retained in LICENSE. README.md is upstream documentation; the upstream CLI/service executables are not this product's entry point.

BlueWing adds `cmd/bluewing-vpn-core`, `internal/bluewing`, and `internal/winproxy`; patches the two authentication providers for cancellable structured challenges and explicit certificate trust; adds bounded stack lifecycle and contextual TCP dialing; and prevents upstream signal hooks from accumulating in the control host. The control host never installs a TUN, changes system DNS, or writes plaintext sessions. Only an explicitly invoked Windows system proxy helper mode changes WinINet options.

Build with Go 1.25.6: from the BlueWing root run `npm run build:vpn-core` (`GO_BINARY` can name an absolute Go executable). Run `npm run test:vpn-core`. The source zip and manifest accompany the executable in `bin/` and are included by existing Electron packaging. Module versions/checksums are fixed in go.mod/go.sum. No EZ4Connect source code is included.

Control transport: newline-delimited JSON v1 on inherited stdin/stdout; hello must precede commands. Supported commands: configure, discoverAuth, connect, respond, setProbe, disconnect, shutdown. Passwords/session data travel only in the inherited pipe, not argv. stdout contains machine events; raw upstream logs and stderr are never forwarded into application logs. stdin EOF closes owned resources.

Optional diagnostic events capture HTTP authentication metadata, or original headers/bodies in explicit full mode. The host's per-profile full diagnostics can intentionally record submitted plaintext passwords/verification codes and session cookies in separate local rotated files; it is disabled by default and reset on profile export/import. Raw upstream debug output remains disabled so application payload dumps cannot corrupt NDJSON. A trusted-endpoint rejection (75500503) retains its original server message and is not treated as a wrong password. This does not implement official aTrust endpoint attestation or solve gateways requiring the official client. See BlueWing's docs/design/atrust-diagnostics-and-upstream-review.md for gateway findings and upstream issue verification.

SoftEther is implemented in `client/softether`, adapting MIT-licensed govpn wire
helpers (pinned source and license in that directory) to the existing private
gVisor stack. It uses bound TLS TCP, DHCP/ARP and lease renewal without an OS
TAP/service/default route. The shared control protocol and per-profile routing
keep company-only routing isolated from public direct/proxy outlets. See
`docs/design/softether-access-implementation.md` in the BlueWing root for scope,
real-gateway acceptance evidence and testing instructions.

TCP company traffic is tunnel-only. Company DNS uses the provider DNS through the userspace stack; no public/system fallback. Local SOCKS requires per-launch random credentials. IPv4 TCP office workloads are implemented; external SOCKS UDP/ICMP and IPv6 tunnel traffic are not advertised as supported. CAS/OAuth/certificate login are not enabled in the product UI. aTrust requires its own real gateway acceptance, independent of EasyConnect.

The AGPL source/license materials do not resolve BlueWing's overall distribution licensing decision. The application's release process must resolve the design's pending license decision before publishing a combined installer.
