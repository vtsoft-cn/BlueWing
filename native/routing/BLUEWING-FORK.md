# BlueWing routing core

Pinned source: github.com/sagernet/sing-box v1.14.3 (module sum
h1:cBg8TP5SPWoMAlWqTqbSNdHGKPUciZisjQbLtqFlMZA=). Original licensing is
retained. Build from the BlueWing root with `node scripts/build-routing-core.cjs`.
Go 1.26.10 and the original Windows feature tags are pinned by that script.

The local Apache-2.0 gVisor dependency fixes locally generated IPv4 fragments:
DF is cleared and a nonzero sequential identification is allocated once per
datagram before fragmentation. Forwarded DF packets keep the original PMTU
error behavior. No incoming fragment authorization/checksum/overlap validation
is weakened in the corporate core.
Reassembled IPv4 headers also have their checksum recomputed after total length
and flags change, so raw ICMP forwarded to the next stack remains valid.

The local MIT WireGuard dependency increases the Windows in-memory message
buffer to the upstream desktop bound (65535), allowing raw ICMP datagrams.
The corporate core assembles ICMP return fragments before the sing-tun return
path, which dispatches replies by the ICMP header/identifier.

`routing-core-sources.zip` and `routing-core-manifest.json` accompany the binary.
The maintained sources of both changed dependencies and their original license
files are included. This is a BlueWing maintenance build, not an unmodified
official executable. See THIRD_PARTY_NOTICES.md in the root distribution.

The source archive includes `scripts/build-routing-core.cjs` and preserves the
`native/routing/` layout. Extract it into an empty directory, install Node and
Go 1.26.10 or set ROUTING_GO_BINARY to a Go launcher, then run the script from
that root. It downloads/selects pinned Go 1.26.10 and dependencies, executes the
regression test and builds the binary with the manifest's original feature tags.

2026-11-03 security update: Go 1.26.10 is pinned by the build scripts. Module
locks include patched x/net and x/crypto versions; the routing core also updates
gRPC, DHCP, Chi, go-jose and supporting modules. Exact versions are in go.mod/go.sum.
Both produced binaries must pass govulncheck; no upstream identity or endorsement
is implied. Runtime diagnostics no longer include submitted secrets or HTTP bodies.
