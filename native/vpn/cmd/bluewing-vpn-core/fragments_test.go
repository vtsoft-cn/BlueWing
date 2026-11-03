package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"strconv"
	"testing"
)

func fragmentFixture(id uint16, payload []byte, offset int, more bool) []byte {
	b := make([]byte, 20+len(payload))
	b[0] = 0x45
	b[8] = 64
	b[9] = 17
	binary.BigEndian.PutUint16(b[2:4], uint16(len(b)))
	binary.BigEndian.PutUint16(b[4:6], id)
	flags := uint16(offset / 8)
	if more {
		flags |= 0x2000
	}
	binary.BigEndian.PutUint16(b[6:8], flags)
	copy(b[12:16], net.IPv4(100, 127, 255, 1).To4())
	copy(b[16:20], net.IPv4(10, 88, 0, 53).To4())
	copy(b[20:], payload)
	binary.BigEndian.PutUint16(b[10:12], probeChecksum(b[:20]))
	return b
}
func udpFragmentFixture(port uint16) ([]byte, []byte, []byte) {
	payload := make([]byte, 2008)
	for i := 8; i < len(payload); i++ {
		payload[i] = byte(i)
	}
	binary.BigEndian.PutUint16(payload[0:2], 45000)
	binary.BigEndian.PutUint16(payload[2:4], port)
	binary.BigEndian.PutUint16(payload[4:6], uint16(len(payload)))
	return fragmentFixture(71, payload[:1248], 0, true), fragmentFixture(71, payload[1248:], 1248, false), payload
}
func TestFragmentedUDPReassemblesBeforePortAuthorization(t *testing.T) {
	for _, port := range []uint16{53, 54} {
		t.Run(strconv.Itoa(int(port)), func(t *testing.T) {
			first, last, payload := udpFragmentFixture(port)
			s := &session{p: profile{Targets: []target{{CIDRs: []string{"10.88.0.0/16"}, Network: "udp", Ports: []string{"53"}}}}}
			if s.preparePacket(last) != nil {
				t.Fatal("out-of-order continuation escaped authorization")
			}
			result := s.preparePacket(first)
			if port == 54 {
				if result != nil {
					t.Fatal("denied UDP port bypassed fragment authorization")
				}
				return
			}
			if result == nil || !bytes.Equal(result[20:], payload) || probeChecksum(result[:20]) != 0 {
				t.Fatal("authorized large UDP datagram did not reassemble")
			}
			if binary.BigEndian.Uint16(result[6:8]) != 0 || int(binary.BigEndian.Uint16(result[2:4])) != len(result) {
				t.Fatal("reassembled IPv4 header invalid")
			}
		})
	}
}
