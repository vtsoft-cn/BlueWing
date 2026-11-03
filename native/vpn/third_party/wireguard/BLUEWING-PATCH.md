# WireGuard packet-link buffer patch

Source: golang.zx2c4.com/wireguard v0.0.0-20260522210424-ecfc5a8d5446
(commit ecfc5a8d5446). Original MIT license and source are retained.

Only device/queueconstants_windows.go is changed: MaxSegmentSize uses the
same 65535-byte bound as the upstream desktop default. BlueWing uses an
in-memory TUN and loopback UDP, so decrypted IPv4 datagrams can exceed the
Windows Wintun-specific 2016-byte buffer. Truncating an encrypted datagram
would otherwise lose the packet and stop the receive routine on Windows.
Queue limits and the on-demand buffer pool remain unchanged. The native
packet-link test sends a 4096-byte authenticated frame in both directions.
