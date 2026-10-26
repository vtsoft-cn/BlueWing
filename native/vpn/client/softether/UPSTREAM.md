# SoftEther adapter

Wire encoding, password challenge, Ethernet and DHCP helpers are adapted from
[govpn v0.2.4](https://github.com/bclswl0827/govpn/tree/78c78a37330f361c8f4922b0e7e126a3fc495742/protocols/softether)
(commit `78c78a37330f361c8f4922b0e7e126a3fc495742`), copyright 2026 ttyAMA0,
under the MIT license preserved in LICENSE-MIT. The protocol implementation is
vendored as source to reuse BlueWing's existing pinned gVisor/Go toolchain.

BlueWing owns the client lifecycle, physical interface binding, certificate
validation, packet adapter, bounded queues, ARP resolution, DHCP lease handling,
resource extraction and failure propagation. No OS TAP driver, service, routing
table or system DNS changes are made by this adapter.

The native handshake advertises protocol compatibility with SoftEther 4.38 build
9760. BlueWing keeps its own product name; unsupported higher minimum versions
fail explicitly rather than automatically claiming arbitrary server versions.

Supported: native SoftEther over encrypted TCP/TLS, password challenge or explicit
RADIUS/plain password authentication inside TLS, IPv4 DHCP, ARP and IPv4 traffic.
Unsupported: certificate/anonymous/SSO authentication in the BlueWing UI, UDP
acceleration, parallel transport connections, bridging and full Ethernet access.
