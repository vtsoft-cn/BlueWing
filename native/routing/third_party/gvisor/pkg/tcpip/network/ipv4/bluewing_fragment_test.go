// Copyright 2026 BlueWing contributors.
// SPDX-License-Identifier: Apache-2.0
package ipv4

import (
	"github.com/sagernet/gvisor/pkg/tcpip/checksum"
	"github.com/sagernet/gvisor/pkg/tcpip/header"
	"testing"
)

func TestBlueWingLocalFragmentIdentityAndChecksum(t *testing.T) {
	seen := make(map[uint16]bool)
	for i := 0; i < 128; i++ {
		h := header.IPv4(make([]byte, header.IPv4MinimumSize))
		h.Encode(&header.IPv4Fields{TotalLength: 3072, TTL: 64, Protocol: 17, Flags: header.IPv4FlagDontFragment})
		prepareLocalFragments(h)
		if h.Flags()&header.IPv4FlagDontFragment != 0 || h.FragmentOffset() != 0 {
			t.Fatal("invalid local fragmentation flags")
		}
		if h.ID() == 0 || seen[h.ID()] {
			t.Fatal("concurrent datagrams share an IPv4 identification")
		}
		seen[h.ID()] = true
		if checksum.Checksum(h, 0) != 0xffff {
			t.Fatal("header checksum not repaired")
		}
	}
}
